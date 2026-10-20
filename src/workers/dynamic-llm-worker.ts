import 'reflect-metadata';
import { anthropicLlmModeForBaseUrl } from '../config/provider-base-url-guard';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { holdIdleIfDynamicDisabled } from './dynamic-worker-gate';
import { DrainSignal, awaitDrain, drainTimeoutMs, installDrainHandlers, runClaimLoop } from './worker-drain';
import { ClaimedItem, DEFAULT_LEASE_SECONDS, ItemType, SchedulerService } from '../modules/dynamic-generation/scheduler.service';
import { V3_PAYLOAD_INVALID } from '../modules/course-shell/v3-validation';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import { FinopsLedgerService } from '../modules/finops/finops-ledger.service';
import { FinopsBudgetService } from '../modules/finops/finops-budget.service';
import { LLM_WORKER_ENABLED_ENV, LLM_WORKER_PRESENCE_BEAT_MS, LLM_WORKER_SINCE_ENV, llmWorkerConcurrency, llmWorkerEnabled, llmWorkerSince, llmWorkerTypes } from '../modules/dynamic-generation/llm-worker-routing';
import { WorkerLedger } from './finops-worker-hooks';
import { createExecutorRuntime } from './llm-executor/executor-runtime';
import { LLM_MARK_SENT_SQL, LLM_PENDING_REVIEW, LLM_WORKER_CALL_TAG_PREFIX, ServerLlmDeps, createServerApi, itemWindowStart } from './llm-executor/server-llm';
import type { CallRole } from '../modules/finops/finops-ledger.service';
import { fencedScheduler, IN_FLIGHT_MARGIN_MS, PRIOR_CALL_IN_FLIGHT, PROCESS_ITEM_FENCE, priorAttemptMayBeInFlight } from './lease-takeover';

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
  scheduler: Pick<SchedulerService, 'heartbeatItem' | 'completeItem' | 'completeItemDetailed' | 'failItemDetailed' | 'recordItemExternal'>;
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
  /**
   * Review r1 (M-1): procedencia del texto (`mock` si `baseUrl` no es la API oficial de Anthropic). Sin el campo se
   * deriva de `baseUrl`. Un item `mock` se marca en la metadata de sus artifacts y en el resumen del complete.
   */
  llmMode?: 'real' | 'mock' | 'replay';
  /** Deploy: con drenaje pedido, la parte vuelve a la cola antes de su próxima llamada (review I3/M3). */
  drain?: { isDraining: boolean };
  /** Solo pruebas (r61 M8): sustituye el ejecutor vendorizado; recibe el mismo `api` que el worker real. */
  createRuntime?: typeof createExecutorRuntime;
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

/**
 * ¿Se descartan los puntos de guardado de una parte que falló? Por defecto sí (un reintento debe generar de nuevo y
 * nunca repetir la misma respuesta inválida). Excepción (2026-10-15, examen final #1353): un banco con TODAS las hojas
 * completas que solo falla una regla de conjunto deja borrador y pide conservarlos (keepCheckpoints): el reintento
 * reutiliza lo ya pagado y solo corrige el excedente. Solo con borrador reintentable: sin él no hay nada que reanudar.
 */
export function discardCheckpointsOnFailure(result: { ok?: boolean; retryable?: boolean; draft?: unknown; keepCheckpoints?: boolean } | null | undefined): boolean {
  if (!result || result.ok) return true;
  return !(result.keepCheckpoints === true && !!result.draft && result.retryable !== false);
}

/**
 * r61 (Q-21): guardado TARDÍO (el worker ya no es dueño de la parte). Solo agrega la clave si falta (nunca pisa), con
 * la parte viva (no completada ni fallida), y si el pedido salió dentro de la ventana vigente: después del último
 * reinicio del presupuesto de recuperación y del último descarte de guardados (`llmCheckpointsResetAt`).
 */
export const LATE_CHECKPOINT_SQL =
  `update public.generation_item_runs
      set output_summary = jsonb_set(coalesce(output_summary, '{}'::jsonb), '{llmCheckpoints}',
                                     coalesce(output_summary->'llmCheckpoints', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)),
          updated_at = now()
    where id = $1 and status in ('running', 'pending', 'retrying')
      -- review I2: la clave falta, o la que hay es de una ventana anterior (anterior al reinicio vigente) y ya no se usa.
      and (not (coalesce(output_summary->'llmCheckpoints', '{}'::jsonb) ? $2::text)
           or coalesce(case when output_summary->'llmCheckpoints'->$2::text->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                            then (output_summary->'llmCheckpoints'->$2::text->>'at')::timestamptz end, '-infinity'::timestamptz)
              < greatest(created_at, coalesce(nullif(output_summary->>'recoveryBudgetResetAt', '')::timestamptz, created_at),
                         coalesce(nullif(output_summary->>'llmCheckpointsResetAt', '')::timestamptz, '-infinity'::timestamptz)))
      and $4::timestamptz >= greatest(created_at, coalesce(nullif(output_summary->>'recoveryBudgetResetAt', '')::timestamptz, created_at))
      and $4::timestamptz >= coalesce(nullif(output_summary->>'llmCheckpointsResetAt', '')::timestamptz, '-infinity'::timestamptz)
    returning id`;

export async function processLlmItem(deps: LlmWorkerDeps, item: ClaimedItem): Promise<'completed' | 'failed' | 'handed_back' | 'abandoned'> {
  // r61 (Q-21): cerco por intento dentro del proceso (mismo executorId): si este proceso vuelve a reclamar la parte
  // mientras esta tarea sigue viva, esta deja de escribir en ella (latido/guardado de estado/complete/fail = no-op).
  const fenceToken = PROCESS_ITEM_FENCE.enter(item.itemRunId);
  deps = { ...deps, scheduler: fencedScheduler(deps.scheduler, item.itemRunId, fenceToken) };
  try {
    return await processLlmItemFenced(deps, item, () => PROCESS_ITEM_FENCE.isCurrent(item.itemRunId, fenceToken));
  } finally {
    PROCESS_ITEM_FENCE.leave(item.itemRunId, fenceToken);
  }
}

async function processLlmItemFenced(deps: LlmWorkerDeps, item: ClaimedItem, isCurrentTask: () => boolean): Promise<'completed' | 'failed' | 'handed_back' | 'abandoned'> {
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
  const leaseLost = () => abandoned || !isCurrentTask() || Date.now() - lastBeatOk > deps.leaseSeconds * 800;
  const fail = async (msg: string, retryable: boolean, opts?: { grantAttempt?: boolean; retryAfterSeconds?: number; examBankDraftArtifactId?: string | null; applicationDraftArtifactId?: string | null }) => {
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
      // r62 (E2E M): marca durable de envío bajo la lease (una reserva sin ella, de un intento caído, nunca salió).
      markSent: async (itemRunId, reservationKey, sentAt) => {
        const rows = await deps.dataSource.query(LLM_MARK_SENT_SQL, [itemRunId, deps.executorId, reservationKey, sentAt]);
        const list = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows;
        return Array.isArray(list) && list.length > 0;
      },
      recordLateCheckpoint: async (itemRunId, hash, entry, sentAt) => {
        const rows = await deps.dataSource.query(LATE_CHECKPOINT_SQL, [itemRunId, hash, JSON.stringify(entry), sentAt]);
        const list = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows;
        return Array.isArray(list) && list.length > 0;
      },
      // r61 (Q-21): una llamada de otro intento puede seguir en vuelo hasta su timeout total (+ margen).
      // Review I1: señal DURABLE — en todo reintento (attempt > 1) se mira el ledger, sin depender del último error
      // (una devolución por drenaje/pausa o una reapertura del auto-heal en medio lo borran). Primer intento: sin costo.
      priorInFlightWindowMs: (Number(item.attempt) || 1) > 1 || priorAttemptMayBeInFlight(item) ? deps.totalMs + IN_FLIGHT_MARGIN_MS : 0,
    }, {
      itemRunId: item.itemRunId, runId: item.runId, itemKey: item.itemKey, attempt: Number(item.attempt) || 1, generation: Number((item as any).generation) || 1,
      ownerId, artifactCourseId: courseId, manifestId: (item as any).manifestId,
    }, roleOf);
    const runtime = (deps.createRuntime ?? createExecutorRuntime)({
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
      if (e && e.handBack === PRIOR_CALL_IN_FLIGHT) {
        // r61 (Q-21): la misma llamada del intento anterior sigue en vuelo → vuelve a la cola sin consumir intento y
        // sin reenviar; al retomarla, su guardado tardío (si llegó) la responde sin costo.
        await fail(msg, true, { grantAttempt: true, retryAfterSeconds: Math.max(1, Number(e.retryAfterSeconds) || 1) });
        return 'handed_back';
      }
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
          llmPendingReview: { at: new Date().toISOString(), reason: /presupuesto autorizado/.test(msg) ? 'resend_over_budget' : 'unknown_limit', detail: msg.slice(0, 300), pendingReservations: pend.map((p: any) => p.idempotency_key) },
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
      // Borrador entre intentos (banco de examen o, O2b, actividad de aplicación ya validada): el campo depende del tipo.
      const opts: Record<string, unknown> = {};
      const draftField = runtime.draftFailField(item);
      if (result && result.draft && result.retryable !== false && draftField) {
        try { opts[draftField] = await uploadArtifact(deps, item, ownerId, courseId, result.draft); } catch { /* sin borrador */ }
      } else if (result && result.draftClear && draftField) {
        opts[draftField] = null;
      }
      // Falla de la parte (validación / reglas): sus puntos de guardado se descartan (un reintento debe generar de nuevo,
      // nunca repetir la misma respuesta inválida) — salvo un banco que solo falla una regla de conjunto (ver arriba), y
      // solo si su borrador QUEDÓ subido (rev. I3: sin borrador el reintento repetiría las mismas respuestas).
      const draftSaved = !!draftField && typeof opts[draftField] === 'string' && !!opts[draftField];
      if (!draftSaved || discardCheckpointsOnFailure(result)) {
        await deps.scheduler.recordItemExternal(item.itemRunId, deps.executorId, { llmCheckpoints: {}, llmCheckpointsResetAt: new Date().toISOString() }).catch(() => false);
      } else deps.logger.log(`Item ${item.itemKey}: regla de conjunto del banco — puntos de guardado conservados para el reintento (borrador ${opts[draftField]})`);
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
    // r62 (E2E M): ninguna reserva desconocida queda abierta con la parte completada.
    try {
      const lo = await api.settleLeftovers();
      if (lo.released || lo.settled) deps.logger.warn(`Item ${item.itemKey}: reservas desconocidas resueltas antes de completar (liberadas ${lo.released}, posible duplicado ${lo.settled})`);
    } catch (err) {
      deps.logger.warn(`Item ${item.itemKey}: no se pudieron resolver las reservas desconocidas antes de completar (${err instanceof Error ? err.message : String(err)}); siguen contadas como gasto`);
    }
    clearInterval(hb);
    const llmMode = workerLlmMode(deps);
    const summary = { contextHash: (item as any).context?.contextHash, ...(result.summary || {}), generatedBy: 'llm-worker', ...(llmMode !== 'real' ? { llmMode } : {}) };
    const done = await deps.scheduler.completeItemDetailed(item.itemRunId, deps.executorId, { artifactIds, summary });
    if (!done.ok) {
      if (done.reason === V3_PAYLOAD_INVALID) {
        // Review I5: el servidor rechazó el resultado (y ya dejó la parte para reintento): sus puntos de guardado se
        // descartan para que el reintento genere de nuevo y no repita las mismas respuestas inválidas. Cualquier otro
        // rechazo (lease, artifacts, red) los conserva: el reintento no vuelve a pagar lo ya generado.
        await deps.dataSource.query(
          `update public.generation_item_runs
              set output_summary = (output_summary - 'llmCheckpoints') || jsonb_build_object('llmCheckpointsResetAt', $2::text), updated_at = now()
            where id = $1 and status <> 'running'`,
          [item.itemRunId, new Date().toISOString()],
        ).catch(() => undefined);
      }
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
      ...(workerLlmMode(deps) !== 'real' ? { llmMode: workerLlmMode(deps) } : {}),
    },
  });
  return String(art.id);
}

/** Review r1 (M-1): `real` | `mock` | `replay` del worker (explícito en deps o derivado de la URL base de Anthropic). */
export function workerLlmMode(deps: Pick<LlmWorkerDeps, 'llmMode' | 'baseUrl'>): 'real' | 'mock' | 'replay' {
  if (deps.llmMode === 'mock' || deps.llmMode === 'replay' || deps.llmMode === 'real') return deps.llmMode;
  return anthropicLlmModeForBaseUrl(deps.baseUrl);
}

function readPositiveInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

/** Lo que el loop necesita para arrancar, o el motivo para NO arrancar (fail closed). */
export type LlmWorkerStartConfig =
  | { ok: true; apiKey: string; types: ItemType[]; since: Date }
  | { ok: false; reason: string };

export function llmWorkerStartConfig(env: Record<string, string | undefined> = process.env): LlmWorkerStartConfig {
  if (!llmWorkerEnabled(env)) return { ok: false, reason: `${LLM_WORKER_ENABLED_ENV} no es true (las partes largas las sigue generando el navegador)` };
  const since = llmWorkerSince(env);
  if (!since) return { ok: false, reason: `${LLM_WORKER_SINCE_ENV} ausente o inválido: sin instante de activación no se reclama nada (el navegador sigue como siempre)` };
  const apiKey = String(env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) return { ok: false, reason: 'falta ANTHROPIC_API_KEY — no se reclama nada (fail closed)' };
  try {
    return { ok: true, apiKey, types: llmWorkerTypes(env), since };
  } catch (err) {
    return { ok: false, reason: `${err instanceof Error ? err.message : String(err)} — no se reclama nada (fail closed)` };
  }
}

/**
 * Loop del worker de IA sobre una app de Nest ya creada. Corre como proceso propio (bootstrap de este archivo) o
 * HOSPEDADO dentro de otro worker (Loop 6: dynamic-provider-worker, sin un proceso ni una conexión más). Comparte el
 * drenaje y el set de trabajo en vuelo del proceso anfitrión. Solo reclama partes de runs creados desde la
 * activación (DYNAMIC_LLM_WORKER_SINCE).
 */
export async function runLlmWorkerLoop(p: { app: INestApplicationContext; logger: Logger; drain: DrainSignal; active: Set<Promise<void>>; cfg: Extract<LlmWorkerStartConfig, { ok: true }>; hosted?: boolean }): Promise<() => void> {
  const { app, logger, drain, active, cfg } = p;
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
    apiKey: cfg.apiKey,
    baseUrl: String(process.env.ANTHROPIC_API_BASE_URL || 'https://api.anthropic.com'),
    llmMode: anthropicLlmModeForBaseUrl(process.env.ANTHROPIC_API_BASE_URL, process.env),
    defaultModel: String(process.env.DYNAMIC_LLM_WORKER_MODEL || 'claude-sonnet-4-6'),
    idleMs: readPositiveInt('DYNAMIC_LLM_WORKER_IDLE_MS', 120_000),
    totalMs: readPositiveInt('DYNAMIC_LLM_WORKER_CALL_TIMEOUT_MS', 15 * 60_000),
    drain,
  };
  const types = cfg.types;
  // Latido de presencia (review I7): el API solo le quita al navegador los tipos que cubre un worker VIVO.
  const ds = deps.dataSource;
  const beat = async () => {
    try {
      await ds.query(
        `insert into public.llm_worker_presence (worker_id, item_types, last_seen, draining, since) values ($1, $2::text[], now(), $3, $4::timestamptz)
         on conflict (worker_id) do update set item_types = excluded.item_types, last_seen = now(), draining = excluded.draining, since = excluded.since`,
        [deps.executorId, types, drain.isDraining, cfg.since.toISOString()],
      );
    } catch (err) {
      logger.warn(`dynamic-llm-worker: no se pudo registrar el latido de presencia (${err instanceof Error ? err.message : String(err)}); el navegador seguirá reclamando las partes largas`);
    }
  };
  await beat();
  const beatTimer = setInterval(() => { void beat(); }, LLM_WORKER_PRESENCE_BEAT_MS);
  void drain.stopped.then(() => beat());
  const minRunCreatedAt = cfg.since.toISOString();
  logger.log(`dynamic-llm-worker iniciado (executorId=${deps.executorId}, tipos=${types.join(',')}, concurrencia=${llmWorkerConcurrency()}, runs desde ${minRunCreatedAt})`);
  if (deps.llmMode === 'real' && anthropicLlmModeForBaseUrl(process.env.ANTHROPIC_API_BASE_URL) !== 'real') logger.warn(`dynamic-llm-worker: ANTHROPIC_API_BASE_URL no es la API oficial pero ANTHROPIC_BASE_URL_IS_REAL_PROVIDER=true la declara proveedor REAL — lo que genere puede llegar a un paquete final`);
  if (deps.llmMode !== 'real') logger.warn(`dynamic-llm-worker: ANTHROPIC_API_BASE_URL no es la API oficial — todo lo que genere se marca llmMode=${deps.llmMode} (vista previa, nunca un paquete final)`);
  // Loop 6: el ejecutor fija el modelo de la generación dinámica (DYN_GENERATION_MODEL); DYNAMIC_LLM_WORKER_MODEL solo
  // aplica a una llamada que no traiga modelo. Si apunta a otro, se avisa (configuración sin efecto).
  if (process.env.DYNAMIC_LLM_WORKER_MODEL && process.env.DYNAMIC_LLM_WORKER_MODEL !== 'claude-sonnet-4-6') logger.warn(`DYNAMIC_LLM_WORKER_MODEL=${process.env.DYNAMIC_LLM_WORKER_MODEL} no tiene efecto: la generación dinámica usa el modelo fijo del ejecutor (claude-sonnet-4-6)`);
  try {
    await runClaimLoop<ClaimedItem>({
      name: 'dynamic-llm-worker',
      logger,
      concurrency: llmWorkerConcurrency(),
      pollMs: readPositiveInt('DYNAMIC_LLM_WORKER_POLL_MS', 5000),
      drain,
      active,
      // Fix M5 (Loop 9): solo runs v3 (el ejecutor vendorizado corre v3; v1/v2 tienen scorm, que es solo del navegador).
      claim: () => scheduler.claimNextItem({ executorId: deps.executorId, types: [...types], leaseSeconds: deps.leaseSeconds, minRunCreatedAt, onlyRulesVersion: 3 }),
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
    // Hospedado: el proceso anfitrión espera el drenado (una sola vez, sobre la unión de sus loops) y recién después
    // apaga el latido (re-review: si se apagara al empezar a drenar, con partes largas > 60 s el API devolvería al
    // navegador partes de runs nuevos durante el deploy). El registro NO se borra: su latido envejece solo (60 s).
    if (!p.hosted) {
      await awaitDrain(active, drainTimeoutMs());
      clearInterval(beatTimer);
      return () => undefined;
    }
    return () => clearInterval(beatTimer);
  } catch (err) {
    clearInterval(beatTimer);
    throw err;
  }
}

async function bootstrap() {
  const logger = new Logger('DynamicLlmWorker');
  if (holdIdleIfDynamicDisabled(logger, 'dynamic-llm-worker')) return;
  const cfg = llmWorkerStartConfig();
  if (cfg.ok === false) {
    logger.warn(`dynamic-llm-worker en espera: ${cfg.reason}`);
    await new Promise<void>(() => { /* idle hasta el próximo deploy */ });
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  const drain = new DrainSignal();
  const active = new Set<Promise<void>>();
  installDrainHandlers({ name: 'dynamic-llm-worker', logger, drain, active, close: () => app.close() });
  await runLlmWorkerLoop({ app, logger, drain, active, cfg });
}

if (require.main === module) {
  bootstrap().catch((err) => {
    new Logger('DynamicLlmWorker').error(`Fatal bootstrap error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}
