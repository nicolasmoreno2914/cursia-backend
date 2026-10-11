import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { holdIdleIfDynamicDisabled } from './dynamic-worker-gate';
import { DrainSignal, awaitDrain, drainTimeoutMs, installDrainHandlers, runClaimLoop } from './worker-drain';
import { ClaimedItem, DEFAULT_LEASE_SECONDS, SchedulerService } from '../modules/dynamic-generation/scheduler.service';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import { FinopsLedgerService } from '../modules/finops/finops-ledger.service';
import { FinopsBudgetService } from '../modules/finops/finops-budget.service';
import { LLM_WORKER_ENABLED_ENV, LLM_WORKER_PRESENCE_BEAT_MS, llmWorkerEnabled, llmWorkerTypes } from '../modules/dynamic-generation/llm-worker-routing';
import { WorkerLedger } from './finops-worker-hooks';
import { createExecutorRuntime } from './llm-executor/executor-runtime';
import { LLM_PENDING_REVIEW, LLM_WORKER_CALL_TAG_PREFIX, ServerLlmDeps, createServerApi, itemWindowStart } from './llm-executor/server-llm';
import type { CallRole } from '../modules/finops/finops-ledger.service';

// ─────────────────────────────────────────────────────────────────────────────
// Loop 4 — worker de IA del backend para las partes LARGAS (Libro Guía, Actividades de Aplicación, SCORM, examen
// final). Corre el mismo código de generación del navegador (vendor/dynamic-executor) y llama a Anthropic directo
// con streaming: sin el 524 de Cloudflare y sin depender de que la pestaña siga abierta.
//
// Recuperación automática (humano solo en la excepción):
//  - errores temporales / formato → los resuelve el propio ejecutor (reintentos y reparaciones dirigidas) dentro del
//    presupuesto de recuperación de la parte (Loop 1–3);
//  - worker caído / lease vencido / drenaje → otra instancia retoma la parte desde sus puntos de guardado (los pasos
//    ya respondidos no se vuelven a pagar);
//  - resultado desconocido → UN reintento automático; un segundo → solo ESA parte queda en revisión
//    (llm_pending_review, sin regenerar) y el resto del curso sigue;
//  - run pausado (usuario / disyuntor / tope) → la parte se devuelve sin consumir intento.
// ─────────────────────────────────────────────────────────────────────────────

export interface LlmWorkerDeps {
  scheduler: Pick<SchedulerService, 'heartbeatItem' | 'completeItem' | 'failItemDetailed' | 'recordItemExternal'>;
  dataSource: DataSource;
  artifacts: Pick<ArtifactsService, 'uploadBufferArtifact' | 'putStorageObject' | 'downloadStorageObject'>;
  finops: WorkerLedger;
  budget: ServerLlmDeps['budget'];
  logger: { log(m: string): void; warn(m: string): void; error(m: string): void };
  executorId: string;
  leaseSeconds: number;
  heartbeatMs: number;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  idleMs: number;
  totalMs: number;
  fetchImpl?: typeof fetch;
  /** Deploy: con drenaje pedido, la parte vuelve a la cola antes de su próxima llamada (review I3/M3). */
  drain?: { isDraining: boolean };
}

const ROLES: readonly CallRole[] = ['main', 'validation_retry', 'continuation', 'context_summary_retry', 'fallback_template', 'provider_retry'];

function roleOf(extraHeaders: any): { callRole: CallRole; attempt: number } {
  const r = extraHeaders && typeof extraHeaders['x-cursia-call-role'] === 'string' ? extraHeaders['x-cursia-call-role'] : 'main';
  const a = parseInt(extraHeaders && extraHeaders['x-cursia-attempt'], 10);
  return { callRole: (ROLES as readonly string[]).includes(r) ? (r as CallRole) : 'main', attempt: Number.isInteger(a) && a >= 1 && a <= 100 ? a : 1 };
}

async function ownerOfRun(ds: DataSource, runId: string): Promise<string> {
  const [r] = await ds.query(`select owner_id from public.production_jobs where id = $1`, [runId]);
  if (!r || !r.owner_id) throw new Error(`llm-worker: run ${runId} sin owner`);
  return String(r.owner_id);
}

export async function processLlmItem(deps: LlmWorkerDeps, item: ClaimedItem): Promise<'completed' | 'failed' | 'handed_back' | 'abandoned'> {
  const ownerId = await ownerOfRun(deps.dataSource, item.runId);
  const courseId = String((item as any).artifactCourseId ?? '');
  let abandoned = false;
  let lastBeatOk = Date.now();
  const hb = setInterval(() => {
    deps.scheduler.heartbeatItem(item.itemRunId, deps.executorId, deps.leaseSeconds)
      .then((ok) => { if (ok) lastBeatOk = Date.now(); else abandoned = true; })
      .catch(() => { /* red: si no hay latido OK por buena parte de la lease, la parte se da por perdida (shouldStop) */ });
  }, deps.heartbeatMs);
  // Review I3: sin latido confirmado por el 80 % de la lease, otro worker puede re-reclamar la parte → no se gasta más.
  const leaseLost = () => abandoned || Date.now() - lastBeatOk > deps.leaseSeconds * 800;
  const fail = async (msg: string, retryable: boolean, opts?: { grantAttempt?: boolean; retryAfterSeconds?: number; examBankDraftArtifactId?: string | null }) => {
    clearInterval(hb);
    deps.logger.warn(`Item ${item.itemKey}: falla ${retryable ? 'reintentable' : 'definitiva'}: ${String(msg).slice(0, 400)}`);
    await deps.scheduler.failItemDetailed(item.itemRunId, deps.executorId, msg, retryable, undefined, opts);
  };
  try {
    const api = createServerApi({
      dataSource: deps.dataSource, finops: deps.finops, budget: deps.budget, logger: deps.logger,
      apiKey: deps.apiKey, baseUrl: deps.baseUrl, defaultModel: deps.defaultModel, idleMs: deps.idleMs, totalMs: deps.totalMs, fetchImpl: deps.fetchImpl,
      shouldStop: () => (leaseLost() ? 'lease_lost' : deps.drain && deps.drain.isDraining ? 'worker_draining' : null),
      checkpoints: {
        put: async (path, json) => { await deps.artifacts.putStorageObject({ storagePath: path, buffer: Buffer.from(json, 'utf8'), mimeType: 'application/json', upsert: true }); },
        get: async (path) => (await deps.artifacts.downloadStorageObject('cursia-artifacts', path)).toString('utf8'),
      },
      recordCheckpoint: async (itemRunId, entries) => {
        const rows = await deps.dataSource.query(
          `update public.generation_item_runs
              set output_summary = jsonb_set(coalesce(output_summary, '{}'::jsonb), '{llmCheckpoints}',
                                             coalesce(output_summary->'llmCheckpoints', '{}'::jsonb) || $3::jsonb), updated_at = now()
            where id = $1 and worker_id = $2 and status = 'running' returning id`,
          [itemRunId, deps.executorId, JSON.stringify(entries)],
        );
        const list = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows;
        return Array.isArray(list) && list.length > 0;
      },
    }, {
      itemRunId: item.itemRunId, runId: item.runId, itemKey: item.itemKey, attempt: Number(item.attempt) || 1, generation: Number((item as any).generation) || 1,
      ownerId, artifactCourseId: courseId, manifestId: (item as any).manifestId,
    }, roleOf);
    const runtime = createExecutorRuntime({
      api, ownerId, logger: deps.logger,
      artifactText: async (artifactId) => {
        // Solo artifacts del MISMO curso y del MISMO dueño del item.
        const [a] = await deps.dataSource.query(
          `select storage_bucket, storage_path, course_id::text as course_id from public.artifacts where id = $1 and owner_id = $2`,
          [artifactId, ownerId],
        );
        if (!a || String(a.course_id) !== courseId) return null;
        return (await deps.artifacts.downloadStorageObject(a.storage_bucket || 'cursia-artifacts', a.storage_path)).toString('utf8');
      },
    });

    let result;
    try {
      result = await runtime.run(item);
    } catch (e: any) {
      if (abandoned || (e && e.handBack === 'lease_lost')) { clearInterval(hb); return 'abandoned'; }
      const msg = (e && (e.msg || e.message)) || String(e);
      if (e && e.handBack === 'worker_draining') {
        // Deploy: la parte vuelve a la cola (sin consumir intento) y otro worker sigue desde sus puntos de guardado.
        await fail(msg, true, { grantAttempt: true, retryAfterSeconds: 1 });
        return 'handed_back';
      }
      if (e && e.pendingReview) {
        // Límite de resultados desconocidos (2.º de la misma llamada o tope de la parte): SOLO esta parte queda en revisión, sin regenerar; se conserva todo para conciliar.
        const win = await itemWindowStart(deps.dataSource, item.itemRunId);
        const pend = await deps.dataSource.query(
          `select idempotency_key, created_at from public.generation_cost_events
            where idempotency_key like $1 and (metadata->>'reservation') = 'true' and (metadata->>'callTag') like $2 and created_at >= $3
              and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = generation_cost_events.id)
            order by created_at`,
          [`reservation:llm:${item.itemRunId}:%`, `${LLM_WORKER_CALL_TAG_PREFIX}-%`, win.since.toISOString()],
        );
        await deps.scheduler.recordItemExternal(item.itemRunId, deps.executorId, {
          llmPendingReview: { at: new Date().toISOString(), reason: 'unknown_limit', detail: msg.slice(0, 300), pendingReservations: pend.map((p: any) => p.idempotency_key) },
        });
        await fail(msg.startsWith(LLM_PENDING_REVIEW) ? msg : `${LLM_PENDING_REVIEW}: ${msg}`, false);
        return 'failed';
      }
      const m = runtime.mapError(e);
      if (m.runPaused) {
        await fail(msg.startsWith('run_paused') ? msg : 'run_paused: ' + msg, true, { grantAttempt: true, retryAfterSeconds: 5 });
        return 'handed_back';
      }
      await fail(m.msg, m.retryable);
      return 'failed';
    }
    if (abandoned) { clearInterval(hb); return 'abandoned'; }

    if (!result || !result.ok) {
      // Falla de la parte (validación / reglas): sus puntos de guardado se descartan (un reintento debe generar de nuevo,
      // nunca repetir la misma respuesta inválida).
      await deps.scheduler.recordItemExternal(item.itemRunId, deps.executorId, { llmCheckpoints: {} }).catch(() => false);
      const opts: Record<string, unknown> = {};
      if (result && result.draft && result.retryable !== false && runtime.examBankDraftSupported(item)) {
        try { opts.examBankDraftArtifactId = await uploadArtifact(deps, item, ownerId, courseId, result.draft); } catch { /* sin borrador */ }
      } else if (result && result.draftClear && runtime.examBankDraftSupported(item)) {
        opts.examBankDraftArtifactId = null;
      }
      await fail((result && result.error) || 'unexpected_error: el ejecutor no devolvió un resultado', !result || result.retryable !== false, Object.keys(opts).length ? (opts as any) : undefined);
      return 'failed';
    }

    // Antes de subir: ¿sigue siendo nuestra la parte? (un worker «zombi» nunca sube ni completa)
    if (!(await deps.scheduler.heartbeatItem(item.itemRunId, deps.executorId, deps.leaseSeconds))) { clearInterval(hb); return 'abandoned'; }
    const artifactIds: string[] = [];
    for (const a of result.artifacts || []) {
      try {
        artifactIds.push(await uploadArtifact(deps, item, ownerId, courseId, a));
      } catch (err) {
        await fail('no se pudo subir el artifact ' + a.type + ': ' + (err instanceof Error ? err.message : String(err)), true);
        return 'failed';
      }
    }
    // Review I5: los puntos de guardado ya no hacen falta; se descartan ANTES de completar para que, si el servidor
    // rechaza el resultado (prevalidación), el reintento genere de nuevo y no repita las mismas respuestas inválidas.
    await deps.scheduler.recordItemExternal(item.itemRunId, deps.executorId, { llmCheckpoints: {} }).catch(() => false);
    clearInterval(hb);
    const summary = { contextHash: (item as any).context?.contextHash, ...(result.summary || {}), generatedBy: 'llm-worker' };
    const ok = await deps.scheduler.completeItem(item.itemRunId, deps.executorId, { artifactIds, summary });
    if (!ok) {
      await fail('complete rechazado', true);
      return 'failed';
    }
    return 'completed';
  } finally {
    clearInterval(hb);
  }
}

async function uploadArtifact(deps: LlmWorkerDeps, item: ClaimedItem, ownerId: string, courseId: string, a: { type: string; content: string; filename: string; mimeType: string }): Promise<string> {
  const ext = (/\.([a-zA-Z0-9]+)$/.exec(a.filename || '') || [])[1] || 'bin';
  const storagePath = `${ownerId}/dynamic/${courseId}/${(item as any).manifestId}/${a.type}/${(item as any).idempotencyKey}/a${item.attempt}-w.${ext}`;
  const art = await deps.artifacts.uploadBufferArtifact({
    ownerId, courseId, type: a.type, filename: a.filename, storagePath, buffer: Buffer.from(a.content, 'utf8'), mimeType: a.mimeType,
    upsert: true,
    metadata: {
      manifestId: (item as any).manifestId, itemKey: item.itemKey, itemRunId: item.itemRunId, idempotencyKey: (item as any).idempotencyKey,
      contextHash: (item as any).context?.contextHash, runId: item.runId, generatedBy: 'llm-worker',
    },
  });
  return String(art.id);
}

function readPositiveInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

async function bootstrap() {
  const logger = new Logger('DynamicLlmWorker');
  if (holdIdleIfDynamicDisabled(logger, 'dynamic-llm-worker')) return;
  if (!llmWorkerEnabled()) {
    logger.warn(`dynamic-llm-worker en espera: ${LLM_WORKER_ENABLED_ENV} no es true (las partes largas las sigue generando el navegador)`);
    await new Promise<void>(() => { /* idle hasta el próximo deploy */ });
    return;
  }
  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    logger.error('dynamic-llm-worker: falta ANTHROPIC_API_KEY — no se reclama nada (fail closed)');
    await new Promise<void>(() => { /* idle */ });
    return;
  }
  let types: ReturnType<typeof llmWorkerTypes>;
  try {
    types = llmWorkerTypes();
  } catch (err) {
    logger.error(`dynamic-llm-worker: ${err instanceof Error ? err.message : String(err)} — no se reclama nada (fail closed)`);
    await new Promise<void>(() => { /* idle */ });
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  const scheduler = app.get(SchedulerService);
  const deps: LlmWorkerDeps = {
    scheduler,
    dataSource: app.get(DataSource),
    artifacts: app.get(ArtifactsService),
    finops: app.get(FinopsLedgerService),
    budget: app.get(FinopsBudgetService),
    logger,
    executorId: process.env.DYNAMIC_LLM_WORKER_ID || `dynamic-llm-worker-${process.pid}`,
    // Una parte larga hace llamadas de ~2 min: lease amplia + latido frecuente.
    leaseSeconds: readPositiveInt('DYNAMIC_LLM_WORKER_LEASE_SECONDS', Math.max(DEFAULT_LEASE_SECONDS, 300)),
    heartbeatMs: readPositiveInt('DYNAMIC_LLM_WORKER_HEARTBEAT_MS', 30_000),
    apiKey,
    baseUrl: String(process.env.ANTHROPIC_API_BASE_URL || 'https://api.anthropic.com'),
    defaultModel: String(process.env.DYNAMIC_LLM_WORKER_MODEL || 'claude-sonnet-4-6'),
    idleMs: readPositiveInt('DYNAMIC_LLM_WORKER_IDLE_MS', 120_000),
    totalMs: readPositiveInt('DYNAMIC_LLM_WORKER_CALL_TIMEOUT_MS', 15 * 60_000),
  };
  const drain = new DrainSignal();
  deps.drain = drain;
  // Latido de presencia (review I7): el API solo le quita al navegador los tipos que cubre un worker VIVO.
  const ds = deps.dataSource;
  const beat = async () => {
    try {
      await ds.query(
        `insert into public.llm_worker_presence (worker_id, item_types, last_seen, draining) values ($1, $2::text[], now(), $3)
         on conflict (worker_id) do update set item_types = excluded.item_types, last_seen = now(), draining = excluded.draining`,
        [deps.executorId, types, drain.isDraining],
      );
    } catch (err) {
      logger.warn(`dynamic-llm-worker: no se pudo registrar el latido de presencia (${err instanceof Error ? err.message : String(err)}); el navegador seguirá reclamando las partes largas`);
    }
  };
  await beat();
  const beatTimer = setInterval(() => { void beat(); }, LLM_WORKER_PRESENCE_BEAT_MS);
  void drain.stopped.then(() => beat());
  const active = new Set<Promise<void>>();
  installDrainHandlers({ name: 'dynamic-llm-worker', logger, drain, active, close: () => app.close() });
  logger.log(`dynamic-llm-worker iniciado (executorId=${deps.executorId}, tipos=${types.join(',')}, concurrencia=${readPositiveInt('DYNAMIC_LLM_WORKER_CONCURRENCY', 2)})`);
  await runClaimLoop<ClaimedItem>({
    name: 'dynamic-llm-worker',
    logger,
    concurrency: readPositiveInt('DYNAMIC_LLM_WORKER_CONCURRENCY', 2),
    pollMs: readPositiveInt('DYNAMIC_LLM_WORKER_POLL_MS', 5000),
    drain,
    active,
    claim: () => scheduler.claimNextItem({ executorId: deps.executorId, types: [...types], leaseSeconds: deps.leaseSeconds }),
    process: async (item) => {
      try {
        const outcome = await processLlmItem(deps, item);
        logger.log(`Item ${item.itemKey}: ${outcome}`);
      } catch (err) {
        logger.error(`Item ${item.itemKey}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    describe: (item) => `item ${item.itemKey}`,
  });
  await awaitDrain(active, drainTimeoutMs());
  clearInterval(beatTimer);
  await ds.query(`delete from public.llm_worker_presence where worker_id = $1`, [deps.executorId]).catch(() => undefined);
}

if (require.main === module) {
  bootstrap().catch((err) => {
    new Logger('DynamicLlmWorker').error(`Fatal bootstrap error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}
