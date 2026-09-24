import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { ClaimedItem, DEFAULT_LEASE_SECONDS, SchedulerService } from '../modules/dynamic-generation/scheduler.service';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import {
  VideogenService,
  VideogenBatchJob,
  isJobCompleted,
  isJobFailed,
} from '../video-engine/videogen.service';

// ─────────────────────────────────────────────────────────────────────────────
// Fase 5A Task 4 — dynamic-item-worker: ejecuta items type='video' de un run
// de generación dinámica vía Videogen (spec §3.3, §3.9, §7 condiciones 3, 7;
// rulings R3/R15/R17). No importa ni modifica src/workers/video-worker.ts —
// solo reutiliza VideogenService/ArtifactsService (Videogen sigue sin lookup
// por client_reference_id: la idempotencia (R3) la resuelve este worker
// persistiendo el id devuelto en output_summary.external ANTES de asumir que
// el submit se hizo, vía SchedulerService.recordItemExternal).
//
// Contrato del artifact de dependencia (type 'dynamic_content_md'): los
// Tasks 5/6 (prompt builders + executor de `content`) todavía no existen en
// este punto del plan (T4 se implementa antes) — este worker fija el
// contrato mínimo que ese futuro artifact debe cumplir: JSON
// `{ markdown: string }` con el markdown crudo del capítulo. Documentado acá
// y en el reporte de la tarea para que Task 5/6 lo respete.
// ─────────────────────────────────────────────────────────────────────────────

// Mismo límite real de Videogen que usa el video-worker legacy (no exportado
// de ahí — copiado a propósito, ver video_gen_ai/backend/.../create-video.dto.ts).
const CONTENT_TXT_MAX_CHARS = 80000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveNumber(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function readPositiveInt(envKey: string, fallback: number): number {
  return Math.floor(readPositiveNumber(envKey, fallback));
}

/**
 * Convierte markdown a texto plano razonable para narración — copiado a
 * propósito de src/workers/video-worker.ts::bookMarkdownToNarrationText (no
 * exportado de ahí; ídem legacy sin tocar).
 */
export function bookMarkdownToNarrationText(md: string): string {
  return md
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface DynamicItemWorkerDeps {
  scheduler: SchedulerService;
  dataSource: DataSource;
  artifacts: ArtifactsService;
  videogen: VideogenService;
  logger: Logger;
  executorId: string;
  leaseSeconds: number;
  heartbeatMs: number;
  /** Minutos (puede ser fraccionario para tests) sin transición de Videogen antes de fail(retryable, 'video_timeout'). */
  videoTimeoutMin: number;
  /** Intervalo de poll a Videogen/mock, en ms. */
  videoPollMs: number;
  /** 'success' | 'fail' | 'timeout' — solo aplica en modo mock. */
  mockScenario: string;
  /** Cuántos polls de mock hacen falta antes de resolver (success/fail). */
  mockResolvePolls: number;
}

interface RunHead {
  ownerId: string;
  videoMode: 'mock' | 'real';
}

async function loadRunHead(dataSource: DataSource, runId: string): Promise<RunHead> {
  const [row] = await dataSource.query(
    `select owner_id, input_payload->>'videoMode' as video_mode from public.production_jobs where id = $1`,
    [runId],
  );
  if (!row) throw new Error(`run ${runId} no encontrado (integridad rota)`);
  const videoMode = row.video_mode === 'real' ? 'real' : 'mock';
  return { ownerId: row.owner_id, videoMode };
}

async function loadOutputSummary(dataSource: DataSource, itemRunId: string): Promise<Record<string, any>> {
  const [row] = await dataSource.query(`select output_summary from public.generation_item_runs where id = $1`, [itemRunId]);
  return row?.output_summary ?? {};
}

async function downloadContentMarkdown(
  artifacts: ArtifactsService,
  ownerId: string,
  artifactId: string,
): Promise<string> {
  const urlRes = await artifacts.getDownloadUrl(artifactId, ownerId, 3600);
  if (!urlRes.url) throw new Error(`sin URL de descarga para el artifact ${artifactId}`);
  const res = await fetch(urlRes.url);
  if (!res.ok) throw new Error(`descarga del artifact ${artifactId} falló (HTTP ${res.status})`);
  const json = (await res.json()) as Record<string, any>;
  const markdown = typeof json?.markdown === 'string' ? json.markdown : null;
  if (markdown === null) throw new Error(`artifact ${artifactId} (dynamic_content_md) sin campo "markdown"`);
  return markdown;
}

function buildContentTxt(item: ClaimedItem, markdown: string): string {
  const chapterTitle = item.blueprint.chapter?.title ?? `Capítulo ${item.chapterNumber ?? '?'}`;
  const header = `Capítulo ${item.chapterNumber ?? '?'}: ${chapterTitle}\nCurso: ${item.blueprint.course.title}\n\n`;
  const plain = bookMarkdownToNarrationText(markdown);
  return (header + plain).slice(0, CONTENT_TXT_MAX_CHARS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Videogen — determinístico por idempotencyKey, estado persistido en
// output_summary (nunca en memoria del proceso): así un segundo worker que
// re-reclama el item tras un lease vencido ve EXACTAMENTE el mismo job y
// continúa el mismo conteo de polls, en vez de re-enviar un segundo video.
// ─────────────────────────────────────────────────────────────────────────────

function mockJobId(idempotencyKey: string): string {
  return `mock_${idempotencyKey}`;
}

function mockBatchId(idempotencyKey: string): string {
  return `mock_batch_${idempotencyKey}`;
}

async function mockPollVideoStatus(
  deps: DynamicItemWorkerDeps,
  item: ClaimedItem,
  jobId: string,
): Promise<VideogenBatchJob> {
  const summary = await loadOutputSummary(deps.dataSource, item.itemRunId);
  const pollCount = Number(summary.mockPollCount ?? 0) + 1;
  const recorded = await deps.scheduler.recordItemExternal(item.itemRunId, deps.executorId, { mockPollCount: pollCount });
  if (!recorded) {
    // Lease perdida entre la lectura y el registro — el llamador lo trata como stop.
    throw new LeaseLostError();
  }

  const base: VideogenBatchJob = {
    job_id: jobId,
    chapter_number: item.chapterNumber ?? 0,
    status: 'processing',
    client_reference_id: item.idempotencyKey,
    download_url: null,
    error: null,
    progress: Math.min(30 + pollCount * 20, 90),
  };

  if (deps.mockScenario === 'timeout') {
    return base; // nunca resuelve: el timeout por tiempo real del worker lo corta.
  }
  if (pollCount < deps.mockResolvePolls) {
    return base;
  }
  if (deps.mockScenario === 'fail') {
    return { ...base, status: 'failed', progress: null, error: 'Mock: render falló' };
  }
  return {
    ...base,
    status: 'completed',
    progress: 100,
    download_url: `https://mock-cdn.cursia.local/dynamic/${jobId}.mp4`,
  };
}

/** Señal interna: la lease del item se perdió a mitad de una operación — el llamador debe abortar sin fail/complete. */
class LeaseLostError extends Error {
  constructor() {
    super('lease_lost');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// processItem — ciclo de vida completo de UN item 'video' reclamado.
// ─────────────────────────────────────────────────────────────────────────────

export async function processItem(deps: DynamicItemWorkerDeps, item: ClaimedItem): Promise<void> {
  const { scheduler, logger } = deps;
  let leaseLost = false;
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      if (leaseLost) return;
      const ok = await scheduler.heartbeatItem(item.itemRunId, deps.executorId, deps.leaseSeconds);
      if (!ok) {
        leaseLost = true;
        logger.warn(`Item ${item.itemKey} (run ${item.runId}): heartbeat rechazado — lease perdida, abortando`);
      }
    })();
  }, deps.heartbeatMs);

  try {
    const runHead = await loadRunHead(deps.dataSource, item.runId);

    // ── Paso 1: texto del capítulo desde el artifact de la dependencia 'content' ──
    const contentDep = item.dependencyArtifacts.find((a) => a.type === 'dynamic_content_md');
    if (!contentDep) {
      await scheduler.failItem(item.itemRunId, deps.executorId, 'missing_content_artifact', false);
      return;
    }
    let markdown: string;
    try {
      markdown = await downloadContentMarkdown(deps.artifacts, runHead.ownerId, contentDep.artifactId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Item ${item.itemKey}: no se pudo descargar el content artifact — ${msg}`);
      await scheduler.failItem(item.itemRunId, deps.executorId, `content_download_failed: ${msg}`, true);
      return;
    }
    if (leaseLost) return;

    // ── Paso 2: idempotencia (R3) — someter UNA sola vez, o reutilizar el job existente ──
    let jobId: string;
    let mode: 'mock' | 'real';
    const existingExternal = item.outputSummary?.external as Record<string, any> | undefined;
    if (existingExternal?.videogenJobId) {
      jobId = existingExternal.videogenJobId;
      mode = existingExternal.mode === 'real' ? 'real' : 'mock';
    } else if (item.outputSummary?.externalSubmitStartedAt) {
      // Crash entre el submit y el registro del id — decisión manual (R3).
      await scheduler.failItem(item.itemRunId, deps.executorId, 'ambiguous_video_submission', false);
      return;
    } else {
      mode = runHead.videoMode;
      // Toda precondición que pueda fallar SIN llamar a Videogen debe
      // resolverse ANTES de marcar externalSubmitStartedAt (fix round 1,
      // task-4-review.md hallazgo Important): el marcador solo se escribe
      // inmediatamente antes de un intento real de submit. Si no, un fallo
      // 'videogen_not_configured' deja el item envenenado — un retryItem
      // manual posterior (tras configurar la key) vería
      // externalSubmitStartedAt sin external y caería en
      // 'ambiguous_video_submission' para siempre, sin ninguna forma de
      // recuperarlo salvo un UPDATE manual (retryItem nunca limpia
      // marcadores, a propósito — ver R3/R15).
      if (mode === 'real' && !(process.env.VIDEOGEN_API_KEY ?? '').trim()) {
        await scheduler.failItem(item.itemRunId, deps.executorId, 'videogen_not_configured', false);
        return;
      }

      const contentTxt = buildContentTxt(item, markdown);
      const chapterTitle = item.blueprint.chapter?.title ?? `Capítulo ${item.chapterNumber ?? '?'}`;

      const marked = await scheduler.recordItemExternal(item.itemRunId, deps.executorId, {
        externalSubmitStartedAt: new Date().toISOString(),
      });
      if (!marked) {
        logger.error(`Item ${item.itemKey}: lease perdida antes de someter el video a Videogen — se detiene sin someter`);
        return;
      }

      let batchId: string;
      if (mode === 'mock') {
        batchId = mockBatchId(item.idempotencyKey);
        jobId = mockJobId(item.idempotencyKey);
      } else {
        const result = await deps.videogen.batchCreate([
          {
            title: chapterTitle,
            content_txt: contentTxt,
            chapter_number: item.chapterNumber ?? 0,
            client_reference_id: item.idempotencyKey,
          },
        ]);
        if (!result.batch_id || result.jobs.length !== 1 || !result.jobs[0]?.job_id) {
          throw new Error(`Videogen batchCreate devolvió una forma inesperada: ${JSON.stringify(result)}`);
        }
        batchId = result.batch_id;
        jobId = result.jobs[0].job_id;
      }

      const recorded = await scheduler.recordItemExternal(item.itemRunId, deps.executorId, {
        external: { videogenBatchId: batchId, videogenJobId: jobId, mode },
      });
      if (!recorded) {
        // R3: la lease se perdió justo después de someter — el video YA EXISTE
        // en Videogen bajo esta idempotencyKey, pero este ejecutor perdió la
        // propiedad del item. El próximo reclamante verá
        // externalSubmitStartedAt sin external.videogenJobId →
        // 'ambiguous_video_submission' (ventana documentada, decisión manual;
        // TODO Fase 5B/8: reconciliar automáticamente por client_reference_id
        // si Videogen alguna vez expone un lookup).
        logger.error(
          `Item ${item.itemKey}: video sometido a Videogen (job ${jobId}) pero la lease se perdió al registrarlo — ` +
            'quedará como ambiguous_video_submission para el próximo reclamante',
        );
        return;
      }
    }
    if (leaseLost) return;

    // ── Paso 3: poll hasta completar/fallar/timeout ──────────────────────────
    const timeoutMs = deps.videoTimeoutMin * 60_000;
    const startedAt = Date.now();
    while (true) {
      if (leaseLost) return;
      if (Date.now() - startedAt > timeoutMs) {
        await scheduler.failItem(item.itemRunId, deps.executorId, 'video_timeout', true);
        return;
      }

      let status: VideogenBatchJob;
      try {
        status = mode === 'mock' ? await mockPollVideoStatus(deps, item, jobId) : await deps.videogen.getVideoStatus(jobId);
      } catch (err) {
        if (err instanceof LeaseLostError) return;
        throw err;
      }

      if (isJobCompleted(status.status)) {
        let cost: number | null = null;
        if (mode === 'real') {
          try {
            cost = (await deps.videogen.getVideoCost(jobId)).estimated_total_cost;
          } catch (err) {
            logger.warn(`Item ${item.itemKey}: no se pudo obtener el costo real de Videogen — ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        await completeVideoItem(deps, item, runHead, jobId, status, mode, cost);
        return;
      }
      if (isJobFailed(status.status)) {
        await scheduler.failItem(
          item.itemRunId,
          deps.executorId,
          `videogen_failed: ${status.error ?? 'unknown'}`,
          false,
        );
        return;
      }

      await sleep(deps.videoPollMs);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!leaseLost) {
      deps.logger.error(`Item ${item.itemKey} (run ${item.runId}): error inesperado — ${msg}`);
      await scheduler.failItem(item.itemRunId, deps.executorId, `unexpected_error: ${msg}`, true);
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function completeVideoItem(
  deps: DynamicItemWorkerDeps,
  item: ClaimedItem,
  runHead: RunHead,
  jobId: string,
  status: VideogenBatchJob,
  mode: 'mock' | 'real',
  cost: number | null,
): Promise<void> {
  const payload = {
    videogenJobId: jobId,
    downloadUrl: status.download_url ?? null,
    status: status.status,
    mode,
    costUsd: cost,
    chapterId: item.chapterId,
    itemKey: item.itemKey,
    idempotencyKey: item.idempotencyKey,
  };
  const storagePath = `dynamic/${item.frontendCourseId ?? item.courseId}/${item.manifestId}/video/${item.chapterId}.json`;
  const artifact = await deps.artifacts.uploadJsonArtifact({
    ownerId: runHead.ownerId,
    courseId: item.artifactCourseId,
    jobId: item.runId,
    type: 'dynamic_video',
    filename: `${item.chapterId}.json`,
    storagePath,
    payload,
    mimeType: 'application/json',
    metadata: { manifestId: item.manifestId, itemKey: item.itemKey, chapterId: item.chapterId },
  });

  const ok = await deps.scheduler.completeItem(item.itemRunId, deps.executorId, {
    artifactIds: [artifact.id],
    summary: { videogenJobId: jobId, mode, downloadUrl: status.download_url ?? null, costUsd: cost },
  });
  if (!ok) {
    deps.logger.warn(
      `Item ${item.itemKey}: el video se generó y el artifact ${artifact.id} se subió, pero completeItem devolvió ` +
        'false (lease perdida) — el artifact queda huérfano hasta un reintento manual',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runOnce / bootstrap
// ─────────────────────────────────────────────────────────────────────────────

export async function runOnce(deps: DynamicItemWorkerDeps): Promise<'claimed' | 'idle'> {
  const item = await deps.scheduler.claimNextItem({
    executorId: deps.executorId,
    types: ['video'],
    leaseSeconds: deps.leaseSeconds,
  });
  if (!item) return 'idle';
  await processItem(deps, item);
  return 'claimed';
}

async function bootstrap() {
  const logger = new Logger('DynamicItemWorker');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });

  const deps: DynamicItemWorkerDeps = {
    scheduler: app.get(SchedulerService),
    dataSource: app.get(DataSource),
    artifacts: app.get(ArtifactsService),
    videogen: app.get(VideogenService),
    logger,
    executorId: process.env.DYNAMIC_ITEM_WORKER_ID || `dynamic-item-worker-${process.pid}`,
    leaseSeconds: readPositiveInt('DYNAMIC_ITEM_WORKER_LEASE_SECONDS', DEFAULT_LEASE_SECONDS),
    heartbeatMs: readPositiveInt('DYNAMIC_ITEM_WORKER_HEARTBEAT_MS', 30000),
    videoTimeoutMin: readPositiveNumber('DYNAMIC_ITEM_WORKER_VIDEO_TIMEOUT_MIN', 45),
    videoPollMs: readPositiveInt('DYNAMIC_ITEM_WORKER_VIDEO_POLL_MS', 15000),
    mockScenario: (process.env.DYNAMIC_ITEM_WORKER_MOCK_SCENARIO ?? 'success').trim(),
    mockResolvePolls: readPositiveInt('DYNAMIC_ITEM_WORKER_MOCK_RESOLVE_POLLS', 2),
  };
  const pollMs = readPositiveInt('DYNAMIC_ITEM_WORKER_POLL_MS', 5000);
  const concurrency = readPositiveInt('DYNAMIC_ITEM_WORKER_CONCURRENCY', 1);

  let shuttingDown = false;
  const activeItems = new Set<Promise<void>>();
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Recibido ${signal}; esperando ${activeItems.size} item(s) activo(s)`);
    await Promise.allSettled(Array.from(activeItems));
    await app.close();
    logger.log('dynamic-item-worker detenido');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.log(
    `dynamic-item-worker iniciado (executorId=${deps.executorId}, pollMs=${pollMs}, ` +
      `leaseSeconds=${deps.leaseSeconds}, concurrency=${concurrency}, videoTimeoutMin=${deps.videoTimeoutMin})`,
  );

  while (!shuttingDown) {
    while (!shuttingDown && activeItems.size < concurrency) {
      const item = await deps.scheduler.claimNextItem({ executorId: deps.executorId, types: ['video'], leaseSeconds: deps.leaseSeconds });
      if (!item) break;
      logger.log(`Item reclamado: ${item.itemKey} (run ${item.runId})`);
      const promise = processItem(deps, item)
        .catch((err) => logger.error(`Error no manejado en item ${item.itemKey}: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { activeItems.delete(promise); });
      activeItems.add(promise);
    }
    await sleep(activeItems.size >= concurrency ? 500 : pollMs);
  }
}

if (require.main === module) {
  bootstrap().catch((err) => {
    const logger = new Logger('DynamicItemWorker');
    logger.error(`Fatal bootstrap error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}
