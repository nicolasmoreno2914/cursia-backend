import 'reflect-metadata';
import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { MissingSchemaBackoff, holdIdleIfDynamicDisabled } from './dynamic-worker-gate';
import { isRealVideoAllowedForOwner } from '../modules/features/dynamic-features';
import { ClaimedItem, DEFAULT_LEASE_SECONDS, SchedulerService } from '../modules/dynamic-generation/scheduler.service';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import {
  VideogenService,
  VideogenBatchJob,
  isJobCompleted,
  isJobFailed,
} from '../video-engine/videogen.service';
import { YoutubeService } from '../youtube/youtube.service';
import { YoutubeTokenService } from '../youtube/youtube-token.service';
import {
  YoutubeUploadOptions,
  YoutubeUploadResult,
  YoutubeUploadService,
} from '../youtube/youtube-upload.service';
import {
  classifyYoutubeUploadError,
  lightYoutubePreflight,
  resolveYoutubeConnectionFor,
} from '../modules/dynamic-generation/dynamic-youtube';
import type { YoutubeConnection } from '../youtube/entities/youtube-connection.entity';
import {
  VideoDeliveryPhase,
  VideoDeliveryStrategy,
  canonicalYoutubeWatchUrl,
  checkYoutubeDeliveryUrl,
  VIDEO_DELIVERY_NOT_YOUTUBE,
  YOUTUBE_PREFLIGHT_FAILED,
  YOUTUBE_PREFLIGHT_MESSAGES,
  YOUTUBE_UPLOAD_PRIVACY,
  dynamicVideoDeliveryPhase,
  frozenVideoDeliveryOf,
  isVideogenDirectAllowed,
  normalizeDeliveryState,
  reportVideoDeliveryConfigAtStartup,
} from '../modules/dynamic-generation/dynamic-video-delivery';
import { FinopsLedgerService } from '../modules/finops/finops-ledger.service';
import { FinopsBudgetService } from '../modules/finops/finops-budget.service';
import {
  WorkerBudget,
  WorkerLedger,
  budgetExceededMessage,
  recordVideogenCharge,
  recordYoutubeUpload,
  settleVideogenPending,
} from './finops-worker-hooks';

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

/**
 * 5B.2.A: publicador de YouTube inyectable (DI) para la fase de entrega de
 * runs con `videoDelivery='youtube'`. En producción envuelve
 * YoutubeService.getConnection + YoutubeUploadService.uploadFromUrl (los
 * mismos servicios del legacy, sin tocarlos); en tests es SIEMPRE un mock.
 * Los runs con `videoMode='mock'` nunca lo usan (publicador mock interno).
 */
export interface DynamicYoutubePublisher {
  /** Conexión del run (producción: resolveYoutubeConnectionFor → la del owner). */
  getConnection(ownerId: string): Promise<YoutubeConnection | null>;
  /**
   * DN-1: refresh del access token (en memoria, nunca se loguea ni persiste).
   * Se usa en el preflight liviano antes de cada envío NUEVO a Videogen y
   * justo antes de cada subida. Opcional por compatibilidad con fakes viejos
   * (sin él, la subida igual refresca adentro de uploadFromUrl).
   */
  getAccessToken?(connection: YoutubeConnection): Promise<string>;
  uploadFromUrl(connection: YoutubeConnection, options: YoutubeUploadOptions): Promise<YoutubeUploadResult>;
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
  /**
   * 5B.2.A: publicador real de YouTube. Solo se usa para runs congelados con
   * videoDelivery='youtube' Y videoMode='real'; si falta en ese caso el item
   * falla (no reintentable) sin subir nada.
   */
  youtube?: DynamicYoutubePublisher | null;
  /** DN-1: intentos de subida en el MISMO reclamo ante un fallo transitorio (5xx/red al iniciar). Default 3 (paridad legacy). */
  youtubeUploadMaxTries?: number;
  /** DN-1: backoff base entre esos intentos, en ms (intento n espera base·n). Default 2000 (legacy: 2 s, 4 s). */
  youtubeUploadRetryBaseMs?: number;
  /** DN-1: espera antes del reintento automático tras cuota agotada, en segundos. Default 3600. */
  youtubeQuotaRetrySeconds?: number;
  /** DN-1 (review I2): tope TOTAL de espera por cuota (desde la primera), en segundos. Default 86400 (24 h). */
  youtubeQuotaMaxWaitSeconds?: number;
  /**
   * V2.1 RF-b: ledger de costos (Videogen CALCULATED_FROM_USAGE / MOCK,
   * YouTube ZERO_BY_DESIGN + cuota). El bootstrap SIEMPRE lo cablea; opcional
   * solo para los harnesses previos a RF-b. Un fallo del ledger se loguea
   * como error y nunca rompe la generación (el gasto ya ocurrió).
   */
  finops?: WorkerLedger | null;
  /**
   * V2.1 RF-b: runtime guard de presupuesto ANTES de cada envío pagado nuevo
   * a Videogen. El bootstrap SIEMPRE lo cablea; si falla (DB) el item falla
   * reintentable SIN enviar (fail closed).
   */
  budget?: WorkerBudget | null;
}

/** RF-b: un fallo del ledger nunca rompe la generación, pero se loguea fuerte. */
async function ledgerSafe(deps: DynamicItemWorkerDeps, label: string, fn: (l: WorkerLedger) => Promise<unknown>): Promise<void> {
  if (!deps.finops) return;
  try {
    await fn(deps.finops);
  } catch (err) {
    deps.logger.error(`finops: no se pudo registrar ${label} en el ledger — ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface RunHead {
  ownerId: string;
  videoMode: 'mock' | 'real';
  /** 5B.2.A: estrategia de entrega congelada en el run (ausente → videogen_direct). */
  videoDelivery: VideoDeliveryStrategy;
}

/**
 * Estado terminal "listo" de un video en Videogen para el flujo dynamic.
 * Fase 5A genera SIN YouTube: Videogen deja esos videos en `completed_local`
 * (render terminado, MP4 descargable), que su propio endpoint de batch cuenta
 * como completado — pero `isJobCompleted` (compartido con el flujo legacy, que
 * sube a YouTube y termina en `completed`) no lo incluye. Hallazgo de la
 * aceptación real de Task 7: el video quedaba listo y el worker seguía
 * polleando hasta el timeout. Se amplía SOLO acá para no cambiar el legacy.
 */
export function isDynamicVideoCompleted(status: string | null | undefined): boolean {
  return isJobCompleted(status ?? '') || String(status ?? '').toLowerCase() === 'completed_local';
}

/**
 * Release-fix I1: motivo (español, legible en la UI) con el que falla un item
 * de video real cuyo owner YA NO está habilitado para video real al momento
 * del submit. Prefijo estable `real_video_not_allowed:` para que la UI/ops lo
 * reconozcan. Sin UUIDs.
 */
export const REAL_VIDEO_NOT_ALLOWED_ITEM_ERROR =
  'real_video_not_allowed: El video real (Videogen, con costo) ya no está habilitado para esta cuenta, ' +
  'así que no se envió este video (sin costo). Para generarlo, pedí que habiliten el video real y reintentá ' +
  'esta parte, o regenerá el curso con video "mock".';

/**
 * Release-fix I1: re-chequeo en el MOMENTO del submit (no al boot del worker)
 * de DYNAMIC_REAL_VIDEO_OWNERS (+ flag V2 y allow-list V2), leyendo el env
 * ACTUAL del proceso. Fail closed: una lista inválida cuenta como "no".
 */
function realVideoStillAllowed(ownerId: string, logger: Logger): boolean {
  try {
    return isRealVideoAllowedForOwner(ownerId);
  } catch (err) {
    logger.error(`Configuración de video real inválida — no se somete a Videogen (fail closed): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * DN-1: motivo con el que falla un video real `videogen_direct` cuando el
 * permiso de staging (DYNAMIC_ALLOW_VIDEOGEN_DIRECT) ya no está al momento del
 * envío. Prefijo estable `video_delivery_not_youtube:`.
 */
export const VIDEOGEN_DIRECT_NOT_ALLOWED_ITEM_ERROR =
  `${VIDEO_DELIVERY_NOT_YOUTUBE}: la entrega directa de Videogen ya no está permitida para videos reales ` +
  '(la entrega final es YouTube Unlisted), así que no se envió este video (sin costo). Regenerá el curso para ' +
  'que sus videos se publiquen en YouTube.';

/** Señal: el input_payload del run tiene una estrategia de entrega desconocida (integridad rota). */
class InvalidVideoDeliveryError extends Error {}

async function loadRunHead(dataSource: DataSource, runId: string): Promise<RunHead> {
  const [row] = await dataSource.query(
    `select owner_id, input_payload->>'videoMode' as video_mode, input_payload from public.production_jobs where id = $1`,
    [runId],
  );
  if (!row) throw new Error(`run ${runId} no encontrado (integridad rota)`);
  const videoMode = row.video_mode === 'real' ? 'real' : 'mock';
  let videoDelivery: VideoDeliveryStrategy;
  try {
    videoDelivery = frozenVideoDeliveryOf(row.input_payload);
  } catch (err) {
    throw new InvalidVideoDeliveryError(err instanceof Error ? err.message : String(err));
  }
  return { ownerId: row.owner_id, videoMode, videoDelivery };
}

async function loadOutputSummary(dataSource: DataSource, itemRunId: string): Promise<Record<string, any>> {
  const [row] = await dataSource.query(`select output_summary from public.generation_item_runs where id = $1`, [itemRunId]);
  return row?.output_summary ?? {};
}

/** Exportada para el harness de C1 (cross-seam test contra el Blob real que produce dynArtifactUpload). */
export async function downloadContentMarkdown(
  artifacts: ArtifactsService,
  ownerId: string,
  artifactId: string,
): Promise<string> {
  const urlRes = await artifacts.getDownloadUrl(artifactId, ownerId, 3600);
  if (!urlRes.url) throw new Error(`sin URL de descarga para el artifact ${artifactId}`);
  const res = await fetch(urlRes.url);
  if (!res.ok) throw new Error(`descarga del artifact ${artifactId} falló (HTTP ${res.status})`);
  const text = await res.text();
  // C1: el navegador sube markdown crudo (`text/markdown`, mejor para 5B) —
  // este worker acepta AMBAS formas: JSON `{markdown: string}` (contrato
  // original de Task 4) o el texto plano tal cual. Si el body parsea como
  // JSON con un campo `markdown` string, se usa ese; si no, se usa el texto
  // completo como markdown.
  let markdown: string | null = null;
  try {
    const json = JSON.parse(text) as Record<string, any>;
    if (json && typeof json.markdown === 'string') markdown = json.markdown;
  } catch {
    // no era JSON — cae al texto plano abajo.
  }
  if (markdown === null) markdown = text;
  if (!markdown.trim()) throw new Error(`artifact ${artifactId} (dynamic_content_md) vacío`);
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
    let runHead: RunHead;
    try {
      runHead = await loadRunHead(deps.dataSource, item.runId);
    } catch (err) {
      if (err instanceof InvalidVideoDeliveryError) {
        await scheduler.failItem(item.itemRunId, deps.executorId, `invalid_video_delivery: ${err.message}`, false);
        return;
      }
      throw err;
    }

    // ── 5B.2.A: reanudación de la entrega YouTube ────────────────────────────
    // Un item de un run 'youtube' cuyo render ya terminó (delivery ≠ pending:
    // completed_local / uploading_youtube / blocked_*) no vuelve a descargar
    // el contenido ni a consultar Videogen: pasa directo a la fase de
    // publicación, que decide (idempotente) si sube, reutiliza el id ya
    // guardado o bloquea.
    if (runHead.videoDelivery === 'youtube') {
      const state = normalizeDeliveryState(item.outputSummary?.delivery);
      if (state !== 'pending') {
        const phase = dynamicVideoDeliveryPhase(item.outputSummary?.videogenStatus ?? null, state, 'youtube');
        await runYoutubeDeliveryPhase(deps, item, runHead, phase, () => leaseLost);
        return;
      }
    }

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
      // Release-fix I1 (release review): el allow-list de video real se
      // re-chequea JUSTO antes de un submit NUEVO (gasto). Quitar a un owner de
      // DYNAMIC_REAL_VIDEO_OWNERS (+ pm2 restart --update-env) corta el gasto
      // de sus runs 'real' activos: el item falla no-reintentable, sin
      // marcar externalSubmitStartedAt (un retry posterior, ya habilitado, no
      // cae en ambiguous_video_submission). Re-pollear un job ya sometido
      // (rama `existingExternal` de arriba) sigue permitido: no hay gasto nuevo.
      if (mode === 'real' && !realVideoStillAllowed(runHead.ownerId, logger)) {
        logger.warn(`Item ${item.itemKey} (run ${item.runId}): video real ya no habilitado para el owner — no se somete a Videogen`);
        await scheduler.failItem(item.itemRunId, deps.executorId, REAL_VIDEO_NOT_ALLOWED_ITEM_ERROR, false);
        return;
      }
      // DN-1: gate de entrega re-chequeado JUSTO antes de cada envío NUEVO
      // (env y conexión ACTUALES, no los del boot ni los del startRun):
      // - videogen_direct real solo con el permiso de staging;
      // - youtube real: conexión activa + scope de subida + refresh del token.
      // Fallo → item failed no-reintentable con motivo legible, sin marcar
      // externalSubmitStartedAt (un retry posterior no queda ambiguo) y 0 gasto.
      if (mode === 'real' && runHead.videoDelivery === 'videogen_direct' && !isVideogenDirectAllowed()) {
        await scheduler.failItem(item.itemRunId, deps.executorId, VIDEOGEN_DIRECT_NOT_ALLOWED_ITEM_ERROR, false);
        return;
      }
      if (mode === 'real' && runHead.videoDelivery === 'youtube') {
        if (!deps.youtube) {
          await scheduler.failItem(item.itemRunId, deps.executorId, 'youtube_publisher_not_configured', false);
          return;
        }
        const light = await lightYoutubePreflight(deps.youtube, runHead.ownerId);
        if (light.ok === false) {
          logger.warn(`Item ${item.itemKey} (run ${item.runId}): preflight de YouTube falló (${light.reason}) — no se envía a Videogen`);
          await scheduler.failItem(
            item.itemRunId,
            deps.executorId,
            `${YOUTUBE_PREFLIGHT_FAILED}:${light.reason}: ${YOUTUBE_PREFLIGHT_MESSAGES[light.reason]} ` +
              'No se envió el video a Videogen (sin costo); reintentá esta parte cuando el canal esté conectado.',
            false,
          );
          return;
        }
        if (leaseLost) return;
      }

      // V2.1 RF-b: runtime guard de presupuesto JUSTO antes de un envío NUEVO
      // (gasto). committed = actual(run) + reservas + este render <= autorizado;
      // si no → item `blocked` con budget_exceeded, sin marcar el submit y 0 gasto.
      if (mode === 'real' && deps.budget) {
        const g = await deps.budget.guardPaidSubmission({ runId: item.runId, itemRunId: item.itemRunId, itemType: 'video' });
        if (!g.allow) {
          logger.warn(`Item ${item.itemKey} (run ${item.runId}): presupuesto excedido (${g.reason}) — no se envía a Videogen`);
          await scheduler.blockItemForBudget(item.itemRunId, deps.executorId, budgetExceededMessage(g));
          return;
        }
        if (leaseLost) return;
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

      if (isDynamicVideoCompleted(status.status)) {
        let cost: number | null = null;
        let costError: string | null = null;
        if (mode === 'real') {
          try {
            cost = (await deps.videogen.getVideoCost(jobId)).estimated_total_cost;
          } catch (err) {
            costError = err instanceof Error ? err.message : String(err);
            logger.warn(`Item ${item.itemKey}: no se pudo obtener el costo real de Videogen — ${costError}`);
          }
        }
        // V2.1 RF-b: un CHARGE por job (idempotente por videogenJobId): MOCK a 0,
        // CALCULATED_FROM_USAGE con el costo de Videogen, o pendiente si falló la consulta.
        const jobIdForLedger = jobId;
        await ledgerSafe(deps, `el render ${jobIdForLedger}`, (l) =>
          recordVideogenCharge(l, {
            ownerId: runHead.ownerId, itemRunId: item.itemRunId, jobId: jobIdForLedger, mode, cost,
            costError, outputSummary: item.outputSummary,
          }));
        if (runHead.videoDelivery === 'youtube') {
          // 5B.2.A: con YouTube, completed_local es INTERMEDIO — se persiste
          // lo necesario para publicar (y reanudar sin Videogen) y se pasa a
          // la fase de publicación en vez de completar el item.
          const recorded = await scheduler.recordItemExternal(item.itemRunId, deps.executorId, {
            delivery: 'completed_local',
            videogenStatus: status.status,
            videogenDownloadUrl: status.download_url ?? null,
            costUsd: cost,
          });
          if (!recorded) {
            logger.warn(`Item ${item.itemKey}: lease perdida al registrar completed_local — se detiene sin publicar`);
            return;
          }
          const phase = dynamicVideoDeliveryPhase(status.status, 'completed_local', 'youtube');
          await runYoutubeDeliveryPhase(deps, item, runHead, phase, () => leaseLost);
          return;
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
  // I1: path inmutable por intento (R23) — nunca sobreescribe un artifact ya
  // vinculado a un item completado por otro Manifest/ejecutor.
  const storagePath =
    `${runHead.ownerId}/dynamic/${item.artifactCourseId}/${item.manifestId}/dynamic_video/` +
    `${item.idempotencyKey}/a${item.attempt}.json`;
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
    upsert: false,
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
// 5B.2.A — fase de publicación en YouTube (solo runs videoDelivery='youtube')
// ─────────────────────────────────────────────────────────────────────────────

/** Id de YouTube determinístico (11 chars base64url) para el publicador mock de runs videoMode='mock'. */
export function mockYoutubeVideoId(idempotencyKey: string): string {
  return createHash('sha256').update(`yt:${idempotencyKey}`).digest('base64url').slice(0, 11);
}

/**
 * Publicador mock para runs `videoMode='mock'`: nunca hace red (el MP4 de un
 * run mock ni siquiera existe). Esos runs tampoco son empaquetables (I4).
 */
function mockYoutubePublisher(item: ClaimedItem): DynamicYoutubePublisher {
  return {
    getConnection: async (ownerId: string) =>
      ({ userId: ownerId, status: 'active', scopes: 'youtube.upload,youtube.readonly' } as unknown as YoutubeConnection),
    getAccessToken: async () => 'mock-access-token',
    uploadFromUrl: async (_c, options) => {
      if (options.onBeforeUpload) await options.onBeforeUpload();
      const videoId = mockYoutubeVideoId(item.idempotencyKey);
      return { videoId, youtubeUrl: canonicalYoutubeWatchUrl(videoId) };
    },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Señal: la lease se perdió al escribir el marcador de subida (antes de contactar YouTube). */
class UploadMarkerLeaseLost extends Error {}

/** Error ANTES del primer contacto con YouTube: auth/cuota se respetan; el resto es un fallo de descarga (reintentable). */
function classifyPreUploadError(err: unknown): ReturnType<typeof classifyYoutubeUploadError> {
  const k = classifyYoutubeUploadError(err);
  return k === 'auth' || k === 'quota' ? k : 'download';
}

/** DN-1: mensaje de bloqueo sin tokens ni texto crudo de Google (solo el tipo de fallo). */
const YOUTUBE_AUTH_BLOCK_DETAIL =
  'YouTube rechazó la autorización del canal (conexión expirada, revocada o sin permiso de subida). ' +
  'Volvé a conectar tu canal en la sección Cuenta y reintentá la subida: el video ya está generado y no se vuelve a pagar.';
const YOUTUBE_QUOTA_BLOCK_DETAIL =
  'YouTube no permite subir más videos por ahora (cuota diaria agotada). Se reintenta solo más tarde; ' +
  'el video ya está generado y no se vuelve a pagar.';

/**
 * Ejecuta la fase de entrega YouTube según `phase` (dynamicVideoDeliveryPhase):
 * - `publish_youtube` (completed_local / uploading_youtube / upload_failed),
 *   `wait_auth`, `wait_quota`: intenta publicar (re-verifica la condición).
 * - `resolve_ambiguous`: NUNCA re-sube solo — falla pidiendo la resolución
 *   explícita (POST …/items/:itemKey/youtube-resolution).
 * - `done`: solo finaliza (artifact + complete) con el id ya guardado.
 * - `poll_videogen`: imposible acá (el render ya terminó) → error fuerte.
 * Ninguna rama vuelve a enviar nada a Videogen: el MP4 (completed_local) se preserva.
 */
async function runYoutubeDeliveryPhase(
  deps: DynamicItemWorkerDeps,
  item: ClaimedItem,
  runHead: RunHead,
  phase: VideoDeliveryPhase,
  isLeaseLost: () => boolean,
): Promise<void> {
  if (phase.next === 'poll_videogen') {
    throw new Error(`fase de entrega inconsistente: poll_videogen con el render ya terminado (item ${item.itemKey})`);
  }
  if (phase.next === 'resolve_ambiguous') {
    await failAmbiguous(deps, item, 'la subida anterior quedó sin confirmar y todavía no se resolvió');
    return;
  }
  await publishYoutubeAndComplete(deps, item, runHead, isLeaseLost);
}

/**
 * Bloqueo reanudable por auth/cuota (rechazo DEFINITIVO de YouTube o sin
 * conexión: no quedó ningún video a medio subir → se limpia el marcador).
 * - auth: item failed (espera la reconexión + retry explícito, que SOLO re-sube).
 * - quota: reintento automático con espera larga (retrying); agotados los
 *   intentos → failed, retry explícito.
 * El run nunca queda "fallado para siempre": un retry del item lo reabre.
 */
async function blockYoutubeDelivery(
  deps: DynamicItemWorkerDeps,
  item: ClaimedItem,
  state: 'blocked_auth' | 'blocked_quota',
  detail: string,
): Promise<void> {
  if (state === 'blocked_quota') {
    await blockYoutubeQuota(deps, item, detail);
    return;
  }
  const recorded = await deps.scheduler.recordItemExternal(item.itemRunId, deps.executorId, {
    delivery: state,
    youtubeUploadStartedAt: null,
    youtubeBlockedAt: new Date().toISOString(),
    youtubeBlockDetail: detail,
  });
  if (!recorded) {
    deps.logger.warn(`Item ${item.itemKey}: lease perdida al registrar ${state}`);
    return;
  }
  deps.logger.warn(`Item ${item.itemKey}: entrega YouTube ${state}`);
  await deps.scheduler.failItem(item.itemRunId, deps.executorId, `youtube_${state}: ${detail}`, false);
}

/**
 * Cuota de YouTube (review DN-1 I2): la espera tiene contador y tope PROPIOS
 * (`youtubeQuotaSince`, `youtubeQuotaWaits` en output_summary) y NO consume
 * max_attempts del item (refundAttempt). Mientras no pasen
 * `youtubeQuotaMaxWaitSeconds` (24 h) desde la primera espera → `retrying`
 * con `next_retry_at` + `youtubeQuotaRetrySeconds`. Pasado el tope →
 * `upload_failed` (failed, reintento manual `retry_upload`) y el contador se
 * reinicia para el próximo intento manual.
 */
async function blockYoutubeQuota(deps: DynamicItemWorkerDeps, item: ClaimedItem, detail: string): Promise<void> {
  const summary = await loadOutputSummary(deps.dataSource, item.itemRunId);
  const nowIso = new Date().toISOString();
  const since: string = typeof summary.youtubeQuotaSince === 'string' ? summary.youtubeQuotaSince : nowIso;
  const waitedSec = Math.max(0, (Date.now() - new Date(since).getTime()) / 1000);
  const maxWait = deps.youtubeQuotaMaxWaitSeconds ?? 86400;
  if (waitedSec >= maxWait) {
    const msg =
      'YouTube siguió sin permitir subidas durante 24 h (cuota agotada). Reintentá la publicación más tarde: ' +
      'el video ya está generado y no se vuelve a pagar.';
    const recorded = await deps.scheduler.recordItemExternal(item.itemRunId, deps.executorId, {
      delivery: 'upload_failed',
      youtubeUploadStartedAt: null,
      youtubeUploadError: msg,
      youtubeUploadFailedAt: nowIso,
      youtubeQuotaSince: null,
      youtubeQuotaWaits: 0,
    });
    if (!recorded) return;
    deps.logger.warn(`Item ${item.itemKey}: cuota de YouTube agotada más de ${Math.round(maxWait / 3600)} h → upload_failed (retry manual)`);
    await deps.scheduler.failItem(item.itemRunId, deps.executorId, `youtube_upload_failed: ${msg}`, false);
    return;
  }
  const recorded = await deps.scheduler.recordItemExternal(item.itemRunId, deps.executorId, {
    delivery: 'blocked_quota',
    youtubeUploadStartedAt: null,
    youtubeBlockedAt: nowIso,
    youtubeBlockDetail: detail,
    youtubeQuotaSince: since,
    youtubeQuotaWaits: Number(summary.youtubeQuotaWaits ?? 0) + 1,
  });
  if (!recorded) {
    deps.logger.warn(`Item ${item.itemKey}: lease perdida al registrar blocked_quota`);
    return;
  }
  deps.logger.warn(`Item ${item.itemKey}: entrega YouTube blocked_quota (espera ${Number(summary.youtubeQuotaWaits ?? 0) + 1})`);
  await deps.scheduler.failItem(item.itemRunId, deps.executorId, `youtube_blocked_quota: ${detail}`, true, undefined, {
    retryAfterSeconds: deps.youtubeQuotaRetrySeconds ?? 3600,
    refundAttempt: true,
  });
}

/** Subida fallida SIN video creado (descarga del MP4, 5xx/red al iniciar, 5xx explícito): se reintenta SOLO la subida. */
async function markUploadFailed(deps: DynamicItemWorkerDeps, item: ClaimedItem, detail: string): Promise<boolean> {
  return deps.scheduler.recordItemExternal(item.itemRunId, deps.executorId, {
    delivery: 'upload_failed',
    youtubeUploadStartedAt: null,
    youtubeUploadError: detail.slice(0, 500),
    youtubeUploadFailedAt: new Date().toISOString(),
  });
}

/** Subida ambigua: el marcador queda; nunca se re-sube sola (resolución explícita). */
async function failAmbiguous(deps: DynamicItemWorkerDeps, item: ClaimedItem, why: string): Promise<void> {
  const recorded = await deps.scheduler.recordItemExternal(item.itemRunId, deps.executorId, { delivery: 'ambiguous' });
  if (!recorded) {
    deps.logger.warn(`Item ${item.itemKey}: lease perdida al registrar la subida ambigua`);
    return;
  }
  await deps.scheduler.failItem(
    item.itemRunId,
    deps.executorId,
    `ambiguous_youtube_upload: ${why}. Puede existir ya un video en el canal: revisar el canal y resolver con ` +
      '"confirmar el video existente" (id) o "autorizar una nueva subida" — no se re-sube automáticamente ' +
      'y el video de Videogen no se vuelve a generar.',
    false,
  );
}

async function publishYoutubeAndComplete(
  deps: DynamicItemWorkerDeps,
  item: ClaimedItem,
  runHead: RunHead,
  isLeaseLost: () => boolean,
): Promise<void> {
  const { scheduler, logger } = deps;
  const summary = await loadOutputSummary(deps.dataSource, item.itemRunId);
  const external = (summary.external ?? {}) as Record<string, any>;
  const videogenJobId: string | undefined = external.videogenJobId;
  const mode: 'mock' | 'real' = external.mode === 'real' ? 'real' : 'mock';
  if (!videogenJobId) {
    await scheduler.failItem(item.itemRunId, deps.executorId, 'youtube_delivery_without_videogen_job', false);
    return;
  }

  let youtubeVideoId: string | undefined = external.youtubeVideoId;
  let youtubeUrl: string | undefined = external.youtubeUrl;

  if (!youtubeVideoId) {
    // Idempotencia (espejo de la regla de "video ambiguo" de 5A/R3): si una
    // subida anterior empezó y nunca registró el id, NO se vuelve a subir —
    // podría existir ya un video en el canal. Decisión explícita del usuario.
    if (summary.youtubeUploadStartedAt) {
      await failAmbiguous(
        deps,
        item,
        `una subida a YouTube empezó el ${summary.youtubeUploadStartedAt} y no registró el id del video ` +
          '(crash, lease perdida o error a mitad de la subida)',
      );
      return;
    }
    const downloadUrl: string | null = summary.videogenDownloadUrl ?? null;
    if (!downloadUrl) {
      await scheduler.failItem(item.itemRunId, deps.executorId, 'youtube_missing_videogen_download_url', false);
      return;
    }
    const publisher = runHead.videoMode === 'mock' ? mockYoutubePublisher(item) : deps.youtube ?? null;
    if (!publisher) {
      await scheduler.failItem(item.itemRunId, deps.executorId, 'youtube_publisher_not_configured', false);
      return;
    }

    // DN-1: credenciales re-validadas JUSTO antes de subir (conexión activa,
    // scope de subida, refresh del token). Fallo → blocked_auth sin marcar la
    // subida (nada se envió a YouTube) y SIN tocar el render.
    const light = await lightYoutubePreflight(publisher, runHead.ownerId);
    if (light.ok === false) {
      await blockYoutubeDelivery(deps, item, 'blocked_auth', `${light.reason}: ${YOUTUBE_PREFLIGHT_MESSAGES[light.reason]}`);
      return;
    }
    if (isLeaseLost()) return;

    const chapterTitle = item.blueprint.chapter?.title ?? `Capítulo ${item.chapterNumber ?? '?'}`;
    const maxTries = Math.max(1, Math.floor(deps.youtubeUploadMaxTries ?? 3));
    const baseMs = Math.max(0, deps.youtubeUploadRetryBaseMs ?? 2000);
    let result: YoutubeUploadResult | null = null;
    for (let attempt = 1; attempt <= maxTries && !result; attempt++) {
      if (isLeaseLost()) return;
      const marked = await scheduler.recordItemExternal(item.itemRunId, deps.executorId, {
        delivery: 'uploading_youtube',
        youtubeUploadAttempts: Number(summary.youtubeUploadAttempts ?? 0) + attempt,
      });
      if (!marked) {
        logger.error(`Item ${item.itemKey}: lease perdida antes de subir a YouTube — se detiene sin subir`);
        return;
      }
      // Review DN-1 M3: el marcador de subida se escribe recién cuando el MP4 ya
      // se bajó (onBeforeUpload, antes del primer contacto con YouTube). Un
      // crash o error durante la descarga NO deja una subida "ambigua".
      let contactedYoutube = false;
      try {
        result = await publisher.uploadFromUrl(light.connection, {
          downloadUrl,
          title: chapterTitle,
          description: `Capítulo ${item.chapterNumber ?? '?'} — ${item.blueprint.course.title}`,
          privacyStatus: YOUTUBE_UPLOAD_PRIVACY,
          chapterNumber: item.chapterNumber ?? undefined,
          onBeforeUpload: async () => {
            const ok = await scheduler.recordItemExternal(item.itemRunId, deps.executorId, {
              youtubeUploadStartedAt: new Date().toISOString(),
            });
            if (!ok) throw new UploadMarkerLeaseLost();
            contactedYoutube = true;
          },
        });
      } catch (err) {
        if (err instanceof UploadMarkerLeaseLost) {
          logger.error(`Item ${item.itemKey}: lease perdida antes de contactar a YouTube — se detiene sin subir`);
          return;
        }
        // Sin contacto con YouTube (descarga/validación del MP4 o error previo): nunca es ambiguo.
        const kind = contactedYoutube ? classifyYoutubeUploadError(err) : classifyPreUploadError(err);
        logger.warn(`Item ${item.itemKey}: subida a YouTube falló (${kind}, intento ${attempt}/${maxTries})`);
        if (kind === 'quota') {
          await blockYoutubeDelivery(deps, item, 'blocked_quota', YOUTUBE_QUOTA_BLOCK_DETAIL);
          return;
        }
        if (kind === 'auth') {
          await blockYoutubeDelivery(deps, item, 'blocked_auth', YOUTUBE_AUTH_BLOCK_DETAIL);
          return;
        }
        if (kind === 'ambiguous') {
          await failAmbiguous(deps, item, `la subida a YouTube falló sin confirmar el resultado (${errMsg(err).slice(0, 200)})`);
          return;
        }
        // download | transient: no se creó ningún video → marcador limpio.
        const detail =
          kind === 'download'
            ? `No se pudo descargar el MP4 generado para subirlo (${errMsg(err).slice(0, 200)})`
            : `YouTube respondió con un error temporal (${errMsg(err).slice(0, 200)})`;
        const cleared = await markUploadFailed(deps, item, detail);
        if (!cleared) return;
        if (kind === 'transient' && attempt < maxTries) {
          await sleep(baseMs * attempt);
          continue;
        }
        // Agotado en este reclamo: reintento automático con backoff del
        // scheduler (solo la subida); sin intentos → failed + retry explícito.
        await scheduler.failItem(item.itemRunId, deps.executorId, `youtube_upload_failed: ${detail}`, true);
        return;
      }
    }
    if (!result) return;

    youtubeVideoId = result.videoId;
    youtubeUrl = canonicalYoutubeWatchUrl(result.videoId);
    // Se persiste el id ANTES de cualquier otra cosa (artifact, complete): un
    // retry con youtubeVideoId presente nunca vuelve a subir. Solo `external`
    // en el patch → sobrevive aunque el run se haya cancelado (M5) y nunca
    // se sobreescribe con otro id (mergeOutputSummary / external_conflict).
    const recorded = await scheduler.recordItemExternal(item.itemRunId, deps.executorId, {
      external: { youtubeVideoId, youtubeUrl },
    });
    if (!recorded) {
      logger.error(
        `Item ${item.itemKey}: video subido a YouTube (${youtubeVideoId}) pero no se pudo registrar el id ` +
          '(lease perdida) — el próximo reclamante lo verá como ambiguous_youtube_upload',
      );
      return;
    }
    logger.log(`Item ${item.itemKey}: publicado en YouTube (unlisted) ${youtubeUrl}`);
    // V2.1 RF-b: la subida consume cuota (no dinero): ZERO_BY_DESIGN + quota_units, idempotente por videoId.
    const uploadedId = youtubeVideoId;
    await ledgerSafe(deps, `la subida a YouTube ${uploadedId}`, (l) =>
      recordYoutubeUpload(l, { ownerId: runHead.ownerId, itemRunId: item.itemRunId, videoId: uploadedId, mode: runHead.videoMode }));
  }

  const check = checkYoutubeDeliveryUrl(youtubeUrl);
  if (check.ok === false || check.videoId !== youtubeVideoId) {
    const why = check.ok === false ? check.reason : `id ${check.videoId} ≠ ${youtubeVideoId}`;
    await scheduler.failItem(item.itemRunId, deps.executorId, `youtube_invalid_url: ${why}`, false);
    return;
  }
  if (isLeaseLost()) return;

  let cost: number | null = typeof summary.costUsd === 'number' ? summary.costUsd : null;
  if (cost === null && mode === 'real' && deps.finops) {
    // V2.1 RF-b: el costo no estaba al terminar el render (cargo pendiente):
    // se vuelve a consultar y, si llega, se corrige con un ADJUSTMENT.
    try {
      const measured = (await deps.videogen.getVideoCost(videogenJobId)).estimated_total_cost;
      if (typeof measured === 'number' && Number.isFinite(measured)) {
        cost = measured;
        await ledgerSafe(deps, `el ajuste del render ${videogenJobId}`, (l) => settleVideogenPending(l, videogenJobId, measured));
      }
    } catch (err) {
      logger.warn(`Item ${item.itemKey}: el costo de Videogen sigue sin estar disponible — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const downloadUrl: string | null = summary.videogenDownloadUrl ?? null;
  const payload = {
    videogenJobId,
    downloadUrl,
    status: summary.videogenStatus ?? null,
    mode,
    costUsd: cost,
    chapterId: item.chapterId,
    itemKey: item.itemKey,
    idempotencyKey: item.idempotencyKey,
    delivery: 'youtube',
    youtubeVideoId,
    youtubeUrl,
  };
  const storagePath =
    `${runHead.ownerId}/dynamic/${item.artifactCourseId}/${item.manifestId}/dynamic_video/` +
    `${item.idempotencyKey}/a${item.attempt}.json`;
  const artifact = await deps.artifacts.uploadJsonArtifact({
    ownerId: runHead.ownerId,
    courseId: item.artifactCourseId,
    jobId: item.runId,
    type: 'dynamic_video',
    filename: `${item.chapterId}.json`,
    storagePath,
    payload,
    mimeType: 'application/json',
    metadata: { manifestId: item.manifestId, itemKey: item.itemKey, chapterId: item.chapterId, delivery: 'youtube' },
    upsert: false,
  });

  // Terminal SOLO con youtubeVideoId + URL final validada (DN-1).
  const ok = await scheduler.completeItem(item.itemRunId, deps.executorId, {
    artifactIds: [artifact.id],
    summary: {
      videogenJobId,
      mode,
      downloadUrl,
      costUsd: cost,
      delivery: 'completed',
      youtubeVideoId,
      youtubeUrl,
      youtubeUploadStartedAt: null,
    },
  });
  if (!ok) {
    logger.warn(
      `Item ${item.itemKey}: publicado en YouTube y artifact ${artifact.id} subido, pero completeItem devolvió ` +
        'false (lease perdida) — el reintento reutiliza el youtubeVideoId sin volver a subir',
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
  // G4: con DYNAMIC_COURSE_STRUCTURE apagado, inactivo sin tocar la DB.
  if (holdIdleIfDynamicDisabled(logger, 'dynamic-item-worker')) return;
  // M6 (review-it2): un DYNAMIC_VIDEO_DELIVERY inválido se loguea como error
  // claro al arrancar, pero no detiene el worker: procesa la estrategia
  // CONGELADA de cada run, y la creación de runs nuevos (startRun) sí falla
  // ruidoso con ese valor.
  const configuredDelivery = reportVideoDeliveryConfigAtStartup(logger) ?? 'INVALIDO (ver error)';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  const youtubeService = app.get(YoutubeService);
  const youtubeTokenService = app.get(YoutubeTokenService);
  const youtubeUploadService = app.get(YoutubeUploadService);

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
    // Solo se invoca para runs congelados con videoDelivery='youtube' y
    // videoMode='real' (requiere la conexión OAuth de YouTube del dueño).
    youtube: {
      getConnection: (ownerId) => resolveYoutubeConnectionFor(youtubeService, ownerId),
      getAccessToken: (connection) => youtubeTokenService.getAccessToken(connection.encryptedRefreshToken, connection.tokenIv),
      uploadFromUrl: (connection, options) => youtubeUploadService.uploadFromUrl(connection, options),
    },
    youtubeUploadMaxTries: readPositiveInt('DYNAMIC_YOUTUBE_UPLOAD_MAX_TRIES', 3),
    youtubeUploadRetryBaseMs: readPositiveInt('DYNAMIC_YOUTUBE_UPLOAD_RETRY_BASE_MS', 2000),
    youtubeQuotaRetrySeconds: readPositiveInt('DYNAMIC_YOUTUBE_QUOTA_RETRY_SECONDS', 3600),
    youtubeQuotaMaxWaitSeconds: readPositiveInt('DYNAMIC_YOUTUBE_QUOTA_MAX_WAIT_SECONDS', 86400),
    // V2.1 RF-b: ledger + runtime guard de presupuesto (siempre cableados en el proceso real).
    finops: app.get(FinopsLedgerService),
    budget: app.get(FinopsBudgetService),
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
      `leaseSeconds=${deps.leaseSeconds}, concurrency=${concurrency}, videoTimeoutMin=${deps.videoTimeoutMin}, ` +
      `videoDeliveryConfig=${configuredDelivery})`,
  );

  // M5: esquema V2 ausente (42P01) → inactivo con backoff, sin crash-loop.
  const schema = new MissingSchemaBackoff(logger, 'dynamic-item-worker');
  while (!shuttingDown) {
    let waitOverrideMs: number | null = null;
    while (!shuttingDown && activeItems.size < concurrency) {
      let item: ClaimedItem | null;
      try {
        item = await deps.scheduler.claimNextItem({ executorId: deps.executorId, types: ['video'], leaseSeconds: deps.leaseSeconds });
      } catch (err) {
        const wait = schema.onClaimError(err);
        if (wait === null) throw err; // otros errores: igual que antes
        waitOverrideMs = wait;
        break;
      }
      schema.onClaimOk();
      if (!item) break;
      logger.log(`Item reclamado: ${item.itemKey} (run ${item.runId})`);
      const promise = processItem(deps, item)
        .catch((err) => logger.error(`Error no manejado en item ${item.itemKey}: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { activeItems.delete(promise); });
      activeItems.add(promise);
    }
    await sleep(waitOverrideMs ?? (activeItems.size >= concurrency ? 500 : pollMs));
  }
}

if (require.main === module) {
  bootstrap().catch((err) => {
    const logger = new Logger('DynamicItemWorker');
    logger.error(`Fatal bootstrap error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}
