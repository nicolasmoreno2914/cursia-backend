import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { returningRows } from '../../common/db/returning-rows';
import { GenerationManifestsService, ManifestDto } from '../generation-manifests/generation-manifests.service';
import type { ManifestItemType } from '../generation-manifests/generation-manifest-builder';
import { CostRatesService } from '../../admin/services/cost-rates.service';
import { CourseContextDto, RUN_VIDEO_MODES, RunVideoMode } from './dto/course-context.dto';
import { REQUIRED_CONTEXT_FIELDS, canonicalContextHash, itemIdempotencyKey, normalizeCourseContext } from './run-hash';
import { VideoDeliveryStrategy, frozenVideoDeliveryOf, readVideoDeliveryConfig } from './dynamic-video-delivery';
import { assertDynamicOwnerAllowed, assertRealVideoAllowed } from '../features/dynamic-features';
import {
  ACTIVE_RUN_WORKER_STATUSES,
  isActiveRun,
  isCancelledLike,
  recomputeRunStatus,
  sweepRunExpiredLeases,
} from './item-transitions';

export type ItemRunStatus = 'pending' | 'running' | 'retrying' | 'completed' | 'failed' | 'blocked' | 'cancelled';

const ITEM_STATUSES: ItemRunStatus[] = ['pending', 'running', 'retrying', 'completed', 'failed', 'blocked', 'cancelled'];
const ITEM_TYPES: ManifestItemType[] = ['content', 'scorm', 'video', 'exam'];
/** Estados de item que un cancel (o la reconciliación de un cancel legacy) pasa a `cancelled`. */
const NON_TERMINAL_ITEM_STATUSES = ['pending', 'running', 'retrying', 'blocked'];
/** worker_status de un run terminado en fallo (reabrible por startRun con el mismo contexto, R10). */
const FAILED_LIKE = new Set(['failed', 'failed_retryable', 'failed_recoverable']);
const ACTIVE_RUN_INDEX = 'uq_dynamic_generation_active_run';
/** 5A solo siembra generation 1 (Fase 8 creará generation 2… para regenerar). */
const GENERATION = 1;
/** R17: default cuando el body no manda videoMode. */
const DEFAULT_VIDEO_MODE: RunVideoMode = 'mock';

export interface RunVideoEstimate {
  videoCount: number;
  videoChapterIds: Array<string | null>;
  estimatedVideoCostUsd: number | null;
  costSource: string | null;
  note: string;
}

export interface StatusCounts {
  total: number;
  pending: number;
  running: number;
  retrying: number;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
}

export interface RunProgress extends StatusCounts {
  /** completed / total (fracción 0..1). */
  pct: number;
  byType: Record<ManifestItemType, StatusCounts>;
}

export interface ItemRunDto {
  id: string;
  itemKey: string;
  type: ManifestItemType;
  moduleId: string;
  chapterId: string | null;
  dependsOn: string[];
  status: ItemRunStatus;
  generation: number;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  error: string | null;
  idempotencyKey: string;
  outputSummary: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface RunDto {
  id: string;
  courseId: number;
  manifestId: number;
  blueprintId: number;
  blueprintNumber: number;
  status: string;
  workerStatus: string;
  /** R17: fijado al crear el run, nunca se actualiza (ni al reabrir). */
  videoMode: RunVideoMode;
  /**
   * 5B.2.A: estrategia de entrega final del video, congelada al crear el
   * run desde DYNAMIC_VIDEO_DELIVERY; runs anteriores sin el campo →
   * 'videogen_direct'. Nunca cambia (ni al reabrir).
   */
  videoDelivery: VideoDeliveryStrategy;
  courseContextSha256: string;
  courseContext: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  progress: RunProgress;
  items: ItemRunDto[];
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function pgCode(err: any): string | undefined {
  return err?.code ?? err?.driverError?.code;
}

function pgConstraint(err: any): string | undefined {
  return err?.constraint ?? err?.driverError?.constraint;
}

function emptyCounts(): StatusCounts {
  return { total: 0, pending: 0, running: 0, retrying: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0 };
}

const isActive = isActiveRun;

function isReopenable(job: { status?: string | null; worker_status?: string | null }): boolean {
  return isCancelledLike(job) || FAILED_LIKE.has(String(job.worker_status ?? '').trim());
}

function isActiveRunConflict(err: any): boolean {
  return pgCode(err) === '23505' && pgConstraint(err) === ACTIVE_RUN_INDEX;
}

export interface StartRunResult {
  created: boolean;
  reopened: boolean;
  run: RunDto;
}

/**
 * Runs de generación dinámica (Fase 5A, Task 2): crear/sembrar, leer
 * progreso, cancelar, reintentar un item. Claim/complete/fail por item viven
 * en SchedulerService (Task 3); toda lectura del run barre leases vencidos y
 * recalcula su estado (R12) con las transiciones de item-transitions.ts.
 *
 * Modelo (spec §3.2–§3.5, §7):
 * - 1 run = 1 fila de `production_jobs` con execution_mode
 *   'dynamic_generation'. `input_payload = {manifestId, blueprintNumber,
 *   contextHash, videoMode, videoDelivery}` (manifestId SIEMPRE, como número — el índice único parcial
 *   uq_dynamic_generation_active_run solo protege filas con manifestId). El
 *   run nunca usa `lease_until`/`worker_id` (quedan NULL: el reaper legacy
 *   solo mira `lease_until IS NOT NULL`) ni `worker_status='waiting_child'`.
 * - El contexto congelado vive SOLO en `generation_run_contexts` (inmutable
 *   por trigger), con `context_hash` = forma canónica de run-hash.ts.
 * - Los items (`generation_item_runs`) se siembran del Manifest en la misma
 *   transacción que el job y el contexto.
 *
 * Ownership + `dynamic` + lectura verificada del Manifest se delegan en
 * `GenerationManifestsService.get` (404 ajeno/inexistente o sin Manifest,
 * 400 legacy). Nunca se crean Manifests acá.
 *
 * Cancelación legacy (R9): `POST /jobs/:id/cancel` no se modifica (rechaza
 * con 400 todo lo que no sea course_full_generation), pero `PATCH /jobs/:id`
 * legacy puede escribir `status='cancelled'`. Por eso toda lectura del run
 * reconcilia: si el job está cancelled/cancelling, los items no terminales
 * pasan a `cancelled` y el run se normaliza a status = worker_status =
 * 'cancelled' (lo que además libera el índice de run activo).
 */
@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly manifests: GenerationManifestsService,
    private readonly costRates: CostRatesService,
  ) {
    // M6 (review-it2): NO se valida DYNAMIC_VIDEO_DELIVERY acá. RunsService
    // vive en AppModule, que arranca la API y todos los workers legacy — un
    // typo tumbaría todo. La validación (ruidosa, sin fallback) es lazy: en
    // startRun (creación del run) y, como log de arranque, en los workers
    // dynamic (reportVideoDeliveryConfigAtStartup).
  }

  /**
   * Get-or-create (y reapertura) del run de un Manifest.
   *
   * - Run ACTIVO: se devuelve (`created:false`); su contexto NO cambia nunca
   *   (condición §7.2) — si el contexto enviado tiene otro hash → 409 con el
   *   runId.
   * - Sin activo, último run TERMINADO en cancelled/failed (R10): con el MISMO
   *   hash de contexto se REABRE (items cancelled → pending, o blocked si
   *   alguna dependencia está failed; failed/completed intactos; mismas filas
   *   e idempotency keys) → `{created:false, reopened:true}`. Con otro hash →
   *   409: cambiar el contexto es regeneración (Fase 8).
   * - Último run completed → 409 (re-ejecutar un Manifest completo es
   *   regeneración, generation 2 = Fase 8). Los items failed de un run se
   *   reintentan con `retryItem`.
   * - Sin runs → se crea (job + contexto + items en una transacción). La
   *   concurrencia la garantiza el índice único parcial: el perdedor de una
   *   carrera recibe 23505, re-selecciona el run activo y lo devuelve.
   */
  async startRun(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
    courseContext: CourseContextDto,
  ): Promise<StartRunResult> {
    // G3: flag V2 + allow-list por owner (403 antes de tocar la DB).
    assertDynamicOwnerAllowed(ownerId);
    const manifest = await this.manifests.get(courseId, ownerId, blueprintNumber);
    const context = normalizeCourseContext(courseContext);
    this.assertRequiredContext(context);
    const contextHash = canonicalContextHash(context);
    const videoMode = this.normalizeVideoMode((courseContext as any)?.videoMode);
    // 5B.2.A: la estrategia de entrega se lee (y valida, fail-fast) en cada
    // uso y se congela SOLO en runs nuevos; un run existente/reabierto
    // conserva la suya aunque la config haya cambiado.
    const videoDelivery = readVideoDeliveryConfig();
    return this.resolveOrCreateRun(courseId, ownerId, blueprintNumber, manifest, context, contextHash, videoMode, true, videoDelivery);
  }

  /**
   * Cuerpo de startRun. `mayRetry`: carrera en la que otro POST commitea su
   * run (con items) entre nuestras lecturas y assertNoPreviousItems — en vez
   * de un 409 "terminada" engañoso, se re-resuelve UNA vez contra ese run.
   */
  private async resolveOrCreateRun(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
    manifest: ManifestDto,
    context: Record<string, any>,
    contextHash: string,
    videoMode: RunVideoMode,
    mayRetry: boolean,
    videoDelivery: VideoDeliveryStrategy,
  ): Promise<StartRunResult> {
    const active = await this.findActiveRunRow(manifest.id);
    if (active) return this.existingRunOrConflict(active, manifest, contextHash, videoMode);

    const latest = await this.findLatestRunRow(manifest.id);
    if (latest) {
      // Carrera: el run pudo commitearse entre las dos lecturas → es el activo.
      if (isActive(latest)) return this.existingRunOrConflict(latest, manifest, contextHash, videoMode);
      if (!isReopenable(latest)) {
        throw new ConflictException(
          `La ejecución anterior de este Manifest ya terminó (${latest.worker_status}); re-ejecutar un Manifest ` +
            `completo es regeneración (Fase 8). runId=${latest.id}`,
        );
      }
      const ctx = await this.loadContextRow(latest.id);
      if (ctx.context_hash !== contextHash) {
        throw new ConflictException(
          `La ejecución anterior usó otro contexto; cambiar el contexto requiere regeneración (Fase 8). runId=${latest.id}`,
        );
      }
      const latestVideoMode = this.videoModeOf(latest);
      if (latestVideoMode !== videoMode) {
        throw new ConflictException(
          `La ejecución anterior usó otro modo de video (${latestVideoMode}); cambiarlo requiere regeneración ` +
            `(Fase 8). runId=${latest.id}`,
        );
      }
      // I1 (5C): reabrir un run 'real' vuelve a gastar Videogen → allow-list DYNAMIC_REAL_VIDEO_OWNERS.
      if (latestVideoMode === 'real') assertRealVideoAllowed(ownerId);
      return this.reopenRun(latest.id, manifest, contextHash);
    }

    // Respaldo: items generation 1 sin run visible no deberían existir (FK
    // cascade), pero nunca se siembra encima de items ajenos. Si aparecen es
    // casi siempre la carrera "otro POST commiteó entre nuestras lecturas":
    // si ahora hay un run visible, se re-resuelve contra él (una vez).
    if (mayRetry && (await this.hasPreviousItems(manifest)) && (await this.findLatestRunRow(manifest.id))) {
      return this.resolveOrCreateRun(courseId, ownerId, blueprintNumber, manifest, context, contextHash, videoMode, false, videoDelivery);
    }
    await this.assertNoPreviousItems(manifest);
    // I1 (5C): un run NUEVO con video real requiere DYNAMIC_REAL_VIDEO_OWNERS (fail closed). Un run
    // 'real' ya activo se devuelve arriba sin pasar por acá (reanudar no se bloquea).
    if (videoMode === 'real') assertRealVideoAllowed(ownerId);

    const [course] = await this.dataSource.query(
      `select metadata->>'courseId' as frontend_course_id from public.courses where id = $1`,
      [courseId],
    );
    const frontendCourseId: string | null = course?.frontend_course_id ?? null;

    let jobId: string;
    try {
      jobId = await this.tx((qr) =>
        this.insertRun(qr, manifest, ownerId, courseId, frontendCourseId, blueprintNumber, context, contextHash, videoMode, videoDelivery),
      );
    } catch (err) {
      if (isActiveRunConflict(err)) {
        // Carrera: otro POST creó el run activo primero (y ya commiteó — el
        // índice único espera al otro insert antes de fallar).
        const winner = await this.findActiveRunRow(manifest.id);
        if (winner) return this.existingRunOrConflict(winner, manifest, contextHash, videoMode);
        throw new ConflictException(
          `Otra ejecución del Manifest #${manifest.id} se creó y terminó mientras se procesaba esta; reintentá la consulta`,
        );
      }
      throw err;
    }

    return { created: true, reopened: false, run: await this.buildRunDto(await this.loadJobById(jobId), manifest) };
  }

  /**
   * R11: el run "actual" de un Manifest para que la UI reanude tras recargar
   * sin reenviar contexto: el activo si hay, si no el más reciente, si no
   * `null`.
   */
  async getCurrentRun(courseId: number, ownerId: string, blueprintNumber: number): Promise<RunDto | null> {
    const manifest = await this.manifests.get(courseId, ownerId, blueprintNumber);
    const job = (await this.findActiveRunRow(manifest.id)) ?? (await this.findLatestRunRow(manifest.id));
    return job ? this.buildRunDto(job, manifest) : null;
  }

  /**
   * R17: estimación de costo de video del Manifest — videoCount/ids salen
   * SIEMPRE del Manifest (totals.videoCount + items type='video', en orden);
   * el costo es best-effort desde la tarifa configurada
   * (video_engine/video_generation/per_video en cost_rates) — si no hay
   * tarifa activa, null + nota explicando por qué (nunca un número
   * inventado). El costo REAL de un video real lo informa Videogen
   * (getVideoCost) recién cuando termina — esto es solo una estimación para
   * decidir si autorizar el modo 'real' (condición 7).
   */
  async estimateRun(courseId: number, ownerId: string, blueprintNumber: number): Promise<RunVideoEstimate> {
    const manifest = await this.manifests.get(courseId, ownerId, blueprintNumber);
    const videoItems = manifest.manifest.items.filter((it) => it.type === 'video');
    if (videoItems.length !== manifest.totals.videoCount) {
      throw new InternalServerErrorException(
        `Manifest #${manifest.id}: ${videoItems.length} items type=video pero totals.videoCount=${manifest.totals.videoCount}`,
      );
    }
    const videoChapterIds = videoItems.map((it) => it.chapterId);
    const videoCount = manifest.totals.videoCount;

    const rate = await this.costRates.getActiveRate('video_engine', 'video_generation', null, 'per_video');
    if (!rate) {
      return {
        videoCount,
        videoChapterIds,
        estimatedVideoCostUsd: null,
        costSource: null,
        note: 'Sin tarifa activa configurada (cost_rates: video_engine/video_generation/per_video); ' +
          'no se puede estimar el costo. El costo real lo informa Videogen por video una vez generado.',
      };
    }
    const estimatedVideoCostUsd = videoCount * Number(rate.rateUsd);
    return {
      videoCount,
      videoChapterIds,
      estimatedVideoCostUsd,
      costSource: rate.source ?? 'configured_rate',
      note: `Estimado con la tarifa configurada (${rate.rateUsd} USD/video); es orientativo — el costo real de un ` +
        'video en modo real lo informa Videogen (getVideoCost) al completarse.',
    };
  }

  async getRun(courseId: number, ownerId: string, blueprintNumber: number, runId: string): Promise<RunDto> {
    const manifest = await this.manifests.get(courseId, ownerId, blueprintNumber);
    const job = await this.loadRunRow(courseId, manifest, runId);
    return this.buildRunDto(job, manifest);
  }

  /**
   * Cancela el run: run → cancelled; items no terminales (pending, running,
   * retrying, blocked) → cancelled (un item `running` queda descartado: su
   * complete exigirá status='running'). completed/failed se conservan.
   * Idempotente sobre un run ya cancelado; 409 si el run ya está completed.
   */
  async cancelRun(courseId: number, ownerId: string, blueprintNumber: number, runId: string): Promise<RunDto> {
    const manifest = await this.manifests.get(courseId, ownerId, blueprintNumber);
    const job = await this.loadRunRow(courseId, manifest, runId);

    await this.tx(async (qr) => {
      const [locked] = await qr.query(
        `select id, status, worker_status from public.production_jobs where id = $1 for update`,
        [job.id],
      );
      if (locked.worker_status === 'completed') {
        throw new ConflictException(`La ejecución ${job.id} ya está completada; no se puede cancelar`);
      }
      await this.markRunCancelled(qr, job.id, ownerId, 'user_cancelled');
      await this.cancelOpenItems(qr, job.id);
    });
    return this.buildRunDto(await this.loadJobById(job.id), manifest);
  }

  /**
   * Reintenta un item `failed` (solo `failed`; cualquier otro estado → 409):
   * - item → pending, `attempt_count` se conserva, `max_attempts =
   *   attempt_count + 3`, el error anterior queda en
   *   `output_summary.previousErrors` (error → NULL);
   * - sus dependientes transitivos en `blocked` cuyas dependencias ya no
   *   están failed/blocked → pending (un exam con OTRO content todavía
   *   failed sigue blocked);
   * - si el run había terminado (p.ej. failed), se reabre a 'queued'.
   * Un run cancelado no admite reintentos (409).
   */
  async retryItem(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
    runId: string,
    itemKey: string,
    resubmitVideo = false,
  ): Promise<ItemRunDto> {
    // G3 (fix wave / review I1): un retry es un entry point como cualquier
    // otro — requiere la allow-list de V2, antes de tocar manifest o run.
    assertDynamicOwnerAllowed(ownerId);
    const manifest = await this.manifests.get(courseId, ownerId, blueprintNumber);
    let job = await this.loadRunRow(courseId, manifest, runId);
    job = await this.reconcileCancellation(job);
    if (isCancelledLike(job)) {
      throw new ConflictException(`La ejecución ${job.id} está cancelada; no se pueden reintentar items`);
    }

    const targetId = await this.tx(async (qr) => {
      const [locked] = await qr.query(
        `select id, status, worker_status from public.production_jobs where id = $1 for update`,
        [job.id],
      );
      if (isCancelledLike(locked)) {
        throw new ConflictException(`La ejecución ${job.id} está cancelada; no se pueden reintentar items`);
      }

      const items: Array<{
        id: string;
        item_key: string;
        status: ItemRunStatus;
        depends_on: string[];
        type: string;
        error: string | null;
        output_summary: Record<string, any> | null;
      }> = await qr.query(
        `select id, item_key, status, depends_on, type, error, output_summary
            from public.generation_item_runs
            where job_id = $1 and generation = $2
            order by id
            for update`,
        [job.id, GENERATION],
      );
      const target = items.find((i) => i.item_key === itemKey);
      if (!target) {
        throw new NotFoundException(`El item "${itemKey}" no existe en la ejecución ${job.id}`);
      }
      if (target.status !== 'failed') {
        throw new ConflictException(
          `Solo se puede reintentar un item en estado "failed"; "${itemKey}" está en "${target.status}"`,
        );
      }

      // I1 (fix wave / review controller ruling: "un retry NO es un resume").
      // Un retry gasta Videogen de nuevo cuando: el item reintentado es de
      // tipo 'video', o pide resubmitVideo (implica tipo video), o el run
      // está TERMINADO y este retry lo va a reabrir (mismo gasto que reabrir
      // desde startRun, I1 original). Un retry de un item NO-video dentro de
      // un run 'real' ya ACTIVO no es gasto nuevo → no requiere la lista.
      if (
        this.videoModeOf(job) === 'real' &&
        (target.type === 'video' || resubmitVideo || !isActive(locked))
      ) {
        assertRealVideoAllowed(ownerId);
      }

      // I4/R23: resubmitVideo solo para items type='video' en 'failed' cuyo
      // último error sea 'videogen_failed' (job terminal, no hay video → no
      // es un segundo video) o 'ambiguous_video_submission' (requiere
      // confirmación explícita del usuario en la UI). Mueve external/
      // externalSubmitStartedAt a output_summary.previousExternals[] antes
      // del retry normal, para que el worker someta de nuevo en vez de
      // reutilizar/quedar envenenado por el marcador anterior.
      let resubmitSetSql = '';
      if (resubmitVideo) {
        if (target.type !== 'video') {
          throw new BadRequestException(`resubmitVideo solo aplica a items type="video"; "${itemKey}" es "${target.type}"`);
        }
        const err = target.error ?? '';
        const eligible = err.startsWith('videogen_failed') || err.startsWith('ambiguous_video_submission');
        if (!eligible) {
          throw new BadRequestException(
            `resubmitVideo solo aplica cuando el último error es "videogen_failed" o "ambiguous_video_submission"; "${itemKey}" falló con "${err}"`,
          );
        }
        this.logger.warn(
          `retryItem: resubmitVideo=true para item "${itemKey}" (run ${job.id}) — error previo "${err}"; ` +
            'archivando external/externalSubmitStartedAt en previousExternals y sometiendo un video nuevo',
        );
        resubmitSetSql = ` - 'external' - 'externalSubmitStartedAt'`;
      }

      const previousErrorsExpr = `coalesce(output_summary, '{}'::jsonb) || jsonb_build_object(
                    'previousErrors',
                    coalesce(output_summary->'previousErrors', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                      'error', error,
                      'attemptCount', attempt_count,
                      'maxAttempts', max_attempts,
                      'retriedAt', now()
                    ))
                  )`;
      const outputSummaryExpr = resubmitVideo
        ? `((${previousErrorsExpr}) || jsonb_build_object(
                    'previousExternals',
                    coalesce(output_summary->'previousExternals', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                      'external', output_summary->'external',
                      'externalSubmitStartedAt', output_summary->'externalSubmitStartedAt',
                      'reason', error,
                      'archivedAt', now()
                    ))
                  ))${resubmitSetSql}`
        : previousErrorsExpr;

      const updated = returningRows(
        await qr.query(
          `update public.generation_item_runs
              set status = 'pending',
                  max_attempts = attempt_count + 3,
                  output_summary = ${outputSummaryExpr},
                  error = null,
                  next_retry_at = null,
                  worker_id = null,
                  lease_until = null,
                  finished_at = null,
                  updated_at = now()
            where id = $1 and status = 'failed'
            returning id`,
          [target.id],
        ),
      );
      if (updated.length !== 1) {
        throw new InternalServerErrorException(`No se pudo reabrir el item "${itemKey}" (fila no actualizada)`);
      }

      const toUnblock = this.dependentsToUnblock(items, itemKey);
      if (toUnblock.length > 0) {
        const unblocked = returningRows(
          await qr.query(
            `update public.generation_item_runs
                set status = 'pending', finished_at = null, updated_at = now()
              where id = any($1::uuid[]) and status = 'blocked'
              returning id`,
            [toUnblock],
          ),
        );
        if (unblocked.length !== toUnblock.length) {
          throw new InternalServerErrorException(
            `Desbloqueo inconsistente de dependientes de "${itemKey}" (${unblocked.length}/${toUnblock.length})`,
          );
        }
      }

      if (!ACTIVE_RUN_WORKER_STATUSES.includes(String(locked.worker_status))) {
        // Reabre el run (queued). Si otro run del mismo Manifest estuviera
        // activo, el índice único parcial lo rechaza → 409 (y rollback de todo).
        try {
          await qr.query(
            `update public.production_jobs
                set status = 'queued', worker_status = 'queued', finished_at = null,
                    error_message = null, next_retry_at = null, updated_at = now()
              where id = $1`,
            [job.id],
          );
        } catch (err) {
          if (isActiveRunConflict(err)) {
            throw new ConflictException(
              `Ya hay otra ejecución activa para el Manifest #${manifest.id}; no se puede reabrir ${job.id}`,
            );
          }
          throw err;
        }
      }
      return target.id;
    });

    const [row] = await this.dataSource.query(`select * from public.generation_item_runs where id = $1`, [targetId]);
    return this.toItemDto(row);
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Inserta job + contexto + items (dentro de la transacción del caller).
   * Items: INSERT … ON CONFLICT (manifest_id, item_key, generation) DO
   * NOTHING, en el orden del Manifest. Si no se insertaron TODOS (alguno ya
   * existía de otro run) → 409 y rollback: nunca un run con items ajenos.
   */
  private async insertRun(
    qr: QueryRunner,
    manifest: ManifestDto,
    ownerId: string,
    courseId: number,
    frontendCourseId: string | null,
    blueprintNumber: number,
    context: Record<string, any>,
    contextHash: string,
    videoMode: RunVideoMode,
    videoDelivery: VideoDeliveryStrategy,
  ): Promise<string> {
    const inputPayload = { manifestId: manifest.id, blueprintNumber, contextHash, videoMode, videoDelivery };
    const [job] = await qr.query(
      `insert into public.production_jobs
         (owner_id, course_id, frontend_course_id, execution_mode, status, worker_status, current_step,
          progress, blueprint_version_id, input_payload, output_summary, options, result,
          lease_until, worker_id, created_at, updated_at)
       values ($1, $2, $3, 'dynamic_generation', 'queued', 'queued', 'dynamic_generation',
               0, $4, $5::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               null, null, now(), now())
       returning id`,
      [ownerId, courseId, frontendCourseId, manifest.blueprintId, JSON.stringify(inputPayload)],
    );

    await qr.query(
      `insert into public.generation_run_contexts (job_id, manifest_id, context, context_hash)
       values ($1, $2, $3::jsonb, $4)`,
      [job.id, manifest.id, JSON.stringify(context), contextHash],
    );

    const items = manifest.manifest.items;
    const params: any[] = [];
    const values = items.map((it) => {
      const b = params.length;
      params.push(
        job.id, courseId, manifest.blueprintId, manifest.id, it.key, GENERATION, it.type, it.moduleId,
        it.chapterId, it.dependsOn, itemIdempotencyKey(manifest.id, it.key, GENERATION),
      );
      return `($${b + 1}::uuid, $${b + 2}::int, $${b + 3}::int, $${b + 4}::int, $${b + 5}, $${b + 6}::int, ` +
        `$${b + 7}, $${b + 8}::uuid, $${b + 9}::uuid, $${b + 10}::text[], $${b + 11}, 'pending')`;
    });
    const inserted = await qr.query(
      `insert into public.generation_item_runs
         (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id,
          chapter_id, depends_on, idempotency_key, status)
       values ${values.join(', ')}
       on conflict (manifest_id, item_key, generation) do nothing
       returning id`,
      params,
    );
    const insertedCount = Array.isArray(inserted) ? inserted.length : 0;
    if (insertedCount === items.length && insertedCount !== manifest.totals.totalJobs) {
      // Falla fuerte ANTES del commit: nada queda escrito.
      throw new InternalServerErrorException(
        `Manifest #${manifest.id}: se sembraron ${insertedCount} items pero totals.totalJobs = ${manifest.totals.totalJobs}`,
      );
    }
    if (insertedCount !== items.length) {
      throw new ConflictException(
        `El Manifest #${manifest.id} ya tiene items sembrados de otra ejecución ` +
          `(${Array.isArray(inserted) ? inserted.length : 0}/${items.length} nuevos); usar reintentar items`,
      );
    }
    return job.id;
  }

  private async hasPreviousItems(manifest: ManifestDto): Promise<boolean> {
    const [{ n }] = await this.dataSource.query(
      `select count(*)::int as n from public.generation_item_runs where manifest_id = $1 and generation = $2`,
      [manifest.id, GENERATION],
    );
    return n > 0;
  }

  private async assertNoPreviousItems(manifest: ManifestDto): Promise<void> {
    if (await this.hasPreviousItems(manifest)) {
      throw new ConflictException(
        `Ya existe una ejecución terminada para este Manifest (#${manifest.id}); usar reintentar items ` +
          '(re-ejecutar un Manifest completo es regeneración, fuera de 5A)',
      );
    }
  }

  private async existingRunOrConflict(
    job: any,
    manifest: ManifestDto,
    contextHash: string,
    videoMode: RunVideoMode,
  ): Promise<StartRunResult> {
    const ctx = await this.loadContextRow(job.id);
    if (ctx.context_hash !== contextHash) {
      throw new ConflictException(
        'Ya hay una ejecución activa para este Manifest con otro contexto de curso ' +
          `(guardado ${ctx.context_hash.slice(0, 12)}…, enviado ${contextHash.slice(0, 12)}…). ` +
          'El contexto de una ejecución iniciada no cambia; cambiarlo requiere regeneración (Fase 8). ' +
          `runId=${job.id}`,
      );
    }
    const existingVideoMode = this.videoModeOf(job);
    if (existingVideoMode !== videoMode) {
      throw new ConflictException(
        `Ya hay una ejecución activa para este Manifest con otro modo de video (guardado ${existingVideoMode}, ` +
          `enviado ${videoMode}). El modo de video de una ejecución iniciada no cambia. runId=${job.id}`,
      );
    }
    return { created: false, reopened: false, run: await this.buildRunDto(job, manifest) };
  }

  /** R17: 'mock' si se omite o viene vacío; cualquier otro valor ya fue rechazado por el DTO (400). */
  private normalizeVideoMode(v: unknown): RunVideoMode {
    return v === 'real' ? 'real' : DEFAULT_VIDEO_MODE;
  }

  /** videoMode congelado de un run ya existente; ausente (runs previos a esta feature) → 'mock'. */
  private videoModeOf(job: any): RunVideoMode {
    const v = job?.input_payload?.videoMode;
    return (RUN_VIDEO_MODES as readonly string[]).includes(v) ? v : DEFAULT_VIDEO_MODE;
  }

  /**
   * R10: reabre un run terminado en cancelled/failed (el caller ya verificó
   * que el hash de contexto es el mismo). En una transacción con la fila del
   * job bloqueada FOR UPDATE:
   * - items `cancelled` → `pending`, o `blocked` si alguna de sus
   *   dependencias está failed (o queda blocked) — punto fijo; con lease,
   *   worker, next_retry_at y finished_at en NULL;
   * - items failed/completed/pending/blocked: intactos (failed se reintenta
   *   con retryItem); mismas filas, mismas idempotency keys;
   * - run → status = worker_status = 'queued'.
   * Si mientras tanto el run ya volvió a estar activo (otra reapertura
   * concurrente) → se devuelve como existente. Si otro run del Manifest
   * quedara activo, el índice único parcial da 23505 → se devuelve ese.
   */
  private async reopenRun(jobId: string, manifest: ManifestDto, contextHash: string): Promise<StartRunResult> {
    let outcome: { kind: 'reopened' } | { kind: 'active'; row: any };
    try {
      outcome = await this.tx(async (qr) => {
        const [locked] = await qr.query(`select * from public.production_jobs where id = $1 for update`, [jobId]);
        if (isActive(locked)) return { kind: 'active' as const, row: locked };
        if (!isReopenable(locked)) {
          throw new ConflictException(
            `La ejecución anterior de este Manifest ya terminó (${locked.worker_status}); re-ejecutar un Manifest ` +
              `completo es regeneración (Fase 8). runId=${jobId}`,
          );
        }

        const items: Array<{ id: string; item_key: string; status: ItemRunStatus; depends_on: string[] }> =
          await qr.query(
            `select id, item_key, status, depends_on from public.generation_item_runs
              where job_id = $1 and generation = $2 order by id for update`,
            [jobId, GENERATION],
          );
        const status = new Map<string, ItemRunStatus>(items.map((i) => [i.item_key, i.status]));
        const reopen = items.filter((i) => i.status === 'cancelled');
        for (const i of reopen) status.set(i.item_key, 'pending');
        let changed = true;
        while (changed) {
          changed = false;
          for (const i of reopen) {
            if (status.get(i.item_key) !== 'pending') continue;
            const bad = (i.depends_on ?? []).some((d) => !status.has(d) || ['failed', 'blocked'].includes(status.get(d)));
            if (bad) {
              status.set(i.item_key, 'blocked');
              changed = true;
            }
          }
        }
        for (const target of ['pending', 'blocked'] as const) {
          const ids = reopen.filter((i) => status.get(i.item_key) === target).map((i) => i.id);
          if (ids.length === 0) continue;
          const rows = returningRows(
            await qr.query(
              `update public.generation_item_runs
                  set status = $2, lease_until = null, worker_id = null, next_retry_at = null,
                      finished_at = null, updated_at = now()
                where id = any($1::uuid[]) and status = 'cancelled'
                returning id`,
              [ids, target],
            ),
          );
          if (rows.length !== ids.length) {
            throw new InternalServerErrorException(
              `Reapertura inconsistente de la ejecución ${jobId} (${rows.length}/${ids.length} items → ${target})`,
            );
          }
        }

        await qr.query(
          `update public.production_jobs
              set status = 'queued', worker_status = 'queued', finished_at = null, error_message = null,
                  next_retry_at = null, lease_until = null, worker_id = null,
                  output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('lastReopenedAt', now()),
                  updated_at = now()
            where id = $1`,
          [jobId],
        );
        return { kind: 'reopened' as const };
      });
    } catch (err) {
      if (isActiveRunConflict(err)) {
        const winner = await this.findActiveRunRow(manifest.id);
        if (winner) return this.existingRunOrConflict(winner, manifest, contextHash, this.videoModeOf(winner));
      }
      throw err;
    }
    if (outcome.kind === 'active') {
      return this.existingRunOrConflict(outcome.row, manifest, contextHash, this.videoModeOf(outcome.row));
    }
    return { created: false, reopened: true, run: await this.buildRunDto(await this.loadJobById(jobId), manifest) };
  }

  /** Run más reciente del Manifest (cualquier estado; reconciliado). */
  private async findLatestRunRow(manifestId: number): Promise<any | null> {
    const [row] = await this.dataSource.query(
      `select * from public.production_jobs
        where execution_mode = 'dynamic_generation' and input_payload->>'manifestId' = $1
        order by created_at desc, id desc
        limit 1`,
      [String(manifestId)],
    );
    return row ? this.reconcileCancellation(row) : null;
  }

  private assertRequiredContext(context: Record<string, any>): void {
    const missing = REQUIRED_CONTEXT_FIELDS.filter((k) => !context[k]);
    if (context.prevCourse && !context.prevCourse.nombre) missing.push('prevCourse.nombre' as any);
    if (missing.length > 0) {
      throw new BadRequestException(`Contexto de curso incompleto: ${missing.join(', ')} vacío(s) o solo espacios`);
    }
  }

  /**
   * Transacción con manejo seguro: connect/startTransaction dentro del try;
   * un fallo del rollback se registra pero NUNCA reemplaza al error original
   * (así el 23505 del índice de run activo sigue llegando al caller).
   */
  async tx<T>(fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();
      const out = await fn(qr);
      await qr.commitTransaction();
      return out;
    } catch (err) {
      if (qr.isTransactionActive) {
        try {
          await qr.rollbackTransaction();
        } catch (rollbackErr) {
          this.logger.warn(
            `rollback falló (se conserva el error original): ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          );
        }
      }
      throw err;
    } finally {
      try {
        await qr.release();
      } catch {
        /* conexión ya liberada o nunca obtenida */
      }
    }
  }

  /** Run activo del Manifest (después de reconciliar un cancel legacy). */
  private async findActiveRunRow(manifestId: number): Promise<any | null> {
    const rows = await this.dataSource.query(
      `select * from public.production_jobs
        where execution_mode = 'dynamic_generation'
          and input_payload->>'manifestId' = $1
          and worker_status = any($2::text[])
        order by created_at desc`,
      [String(manifestId), ACTIVE_RUN_WORKER_STATUSES],
    );
    for (const row of rows) {
      const r = await this.reconcileCancellation(row);
      if (!isCancelledLike(r)) return r;
    }
    return null;
  }

  private async loadRunRow(courseId: number, manifest: ManifestDto, runId: string): Promise<any> {
    const [row] = await this.dataSource.query(
      `select * from public.production_jobs
        where id = $1 and execution_mode = 'dynamic_generation'
          and course_id = $2 and input_payload->>'manifestId' = $3`,
      [runId, courseId, String(manifest.id)],
    );
    if (!row) {
      throw new NotFoundException(
        `La ejecución ${runId} no existe para el Manifest del Blueprint v${manifest.blueprintNumber} del curso #${courseId}`,
      );
    }
    return row;
  }

  private async loadJobById(jobId: string): Promise<any> {
    const [row] = await this.dataSource.query(`select * from public.production_jobs where id = $1`, [jobId]);
    if (!row) throw new InternalServerErrorException(`La ejecución ${jobId} desapareció`);
    return row;
  }

  private async loadContextRow(jobId: string): Promise<{ context: Record<string, any>; context_hash: string }> {
    const [row] = await this.dataSource.query(
      `select context, context_hash from public.generation_run_contexts where job_id = $1`,
      [jobId],
    );
    if (!row) {
      throw new InternalServerErrorException(`La ejecución ${jobId} no tiene contexto congelado (integridad rota)`);
    }
    if (canonicalContextHash(row.context) !== row.context_hash) {
      throw new InternalServerErrorException(
        `La ejecución ${jobId}: el contexto guardado no coincide con su context_hash (integridad rota)`,
      );
    }
    return row;
  }

  /**
   * R9: si el job del run quedó cancelled/cancelling por cualquier camino
   * (p.ej. PATCH /jobs/:id legacy), cancela los items no terminales y
   * normaliza el run a status = worker_status = 'cancelled'. Idempotente.
   * Devuelve la fila del job actualizada.
   */
  async reconcileCancellation(job: any): Promise<any> {
    if (!isCancelledLike(job)) return job;
    if (job.status === 'cancelled' && job.worker_status === 'cancelled') {
      const [{ n }] = await this.dataSource.query(
        `select count(*)::int as n from public.generation_item_runs where job_id = $1 and status = any($2::text[])`,
        [job.id, NON_TERMINAL_ITEM_STATUSES],
      );
      if (n === 0) return job;
    }
    await this.tx(async (qr) => {
      await this.markRunCancelled(qr, job.id, null, 'reconciled_from_job_status');
      await this.cancelOpenItems(qr, job.id);
    });
    return this.loadJobById(job.id);
  }

  /**
   * Task 3 (R12 + barrido en lectura): en un run activo, barre los leases
   * vencidos de sus items y recalcula su estado (p.ej. un run reabierto con
   * solo items failed queda `failed`). Runs terminales/cancelados: intactos.
   * Fila del run bloqueada primero (mismo orden de locks que el scheduler).
   */
  private async sweepAndRecompute(job: any): Promise<any> {
    if (!isActive(job)) return job;
    let changed = false;
    await this.tx(async (qr) => {
      const [locked] = await qr.query(`select * from public.production_jobs where id = $1 for update`, [job.id]);
      if (!locked || !isActive(locked)) return;
      const swept = await sweepRunExpiredLeases(qr, job.id);
      const status = await recomputeRunStatus(qr, job.id);
      changed = swept > 0 || status !== locked.worker_status;
    });
    return changed ? this.loadJobById(job.id) : job;
  }

  private async markRunCancelled(qr: QueryRunner, jobId: string, requestedBy: string | null, reason: string) {
    returningRows(
      await qr.query(
        `update public.production_jobs
            set status = 'cancelled',
                worker_status = 'cancelled',
                finished_at = coalesce(finished_at, now()),
                next_retry_at = null,
                output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object(
                  'cancellation', jsonb_build_object('requestedAt', now(), 'requestedBy', $2::text, 'reason', $3::text)
                ),
                updated_at = now()
          where id = $1
            and execution_mode = 'dynamic_generation'
            and (status is distinct from 'cancelled' or worker_status is distinct from 'cancelled')
          returning id`,
        [jobId, requestedBy, reason],
      ),
    );
  }

  private async cancelOpenItems(qr: QueryRunner, jobId: string): Promise<string[]> {
    const rows = returningRows(
      await qr.query(
        `update public.generation_item_runs
            set status = 'cancelled', lease_until = null, next_retry_at = null,
                finished_at = coalesce(finished_at, now()), updated_at = now()
          where job_id = $1 and status = any($2::text[])
          returning id`,
        [jobId, NON_TERMINAL_ITEM_STATUSES],
      ),
    );
    return rows.map((r: any) => r.id);
  }

  /**
   * Dependientes transitivos de `itemKey` que pasan de blocked a pending:
   * punto fijo sobre el cierre transitivo — un item se desbloquea cuando
   * TODAS sus dependencias (literales del Manifest) existen y no están en
   * failed/blocked/cancelled. Solo toca el cierre de `itemKey`.
   */
  private dependentsToUnblock(
    items: Array<{ id: string; item_key: string; status: ItemRunStatus; depends_on: string[] }>,
    itemKey: string,
  ): string[] {
    const byKey = new Map(items.map((i) => [i.item_key, i]));
    const status = new Map<string, ItemRunStatus>(items.map((i) => [i.item_key, i.status]));
    status.set(itemKey, 'pending');

    const closure = new Set<string>();
    const queue = [itemKey];
    while (queue.length) {
      const k = queue.shift();
      for (const i of items) {
        if (!closure.has(i.item_key) && (i.depends_on ?? []).includes(k)) {
          closure.add(i.item_key);
          queue.push(i.item_key);
        }
      }
    }

    const out: string[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const k of closure) {
        if (status.get(k) !== 'blocked') continue;
        const deps = byKey.get(k).depends_on ?? [];
        const ok = deps.every((d) => status.has(d) && !['failed', 'blocked', 'cancelled'].includes(status.get(d)));
        if (ok) {
          status.set(k, 'pending');
          out.push(byKey.get(k).id);
          changed = true;
        }
      }
    }
    return out;
  }

  private async buildRunDto(job: any, manifest: ManifestDto): Promise<RunDto> {
    job = await this.reconcileCancellation(job);
    job = await this.sweepAndRecompute(job);
    const ctx = await this.loadContextRow(job.id);
    const rows = await this.dataSource.query(`select * from public.generation_item_runs where job_id = $1`, [job.id]);
    const progress = await this.progress(job.id, manifest);
    if (rows.length !== progress.total) {
      throw new InternalServerErrorException(`La ejecución ${job.id}: ${rows.length} items vs ${progress.total} del Manifest`);
    }

    const order = new Map(manifest.manifest.items.map((it, i) => [it.key, i]));
    rows.sort((a: any, b: any) => (order.get(a.item_key) ?? 1e9) - (order.get(b.item_key) ?? 1e9));

    return {
      id: job.id,
      courseId: job.course_id,
      manifestId: manifest.id,
      blueprintId: manifest.blueprintId,
      blueprintNumber: manifest.blueprintNumber,
      status: job.status,
      workerStatus: job.worker_status,
      videoMode: this.videoModeOf(job),
      videoDelivery: frozenVideoDeliveryOf(job.input_payload),
      courseContextSha256: ctx.context_hash,
      courseContext: ctx.context,
      createdAt: toIso(job.created_at),
      updatedAt: toIso(job.updated_at),
      finishedAt: toIso(job.finished_at),
      progress,
      items: rows.map((r: any) => this.toItemDto(r)),
    };
  }

  /**
   * Progreso agregado con `GROUP BY status, type`. total =
   * manifest.totals.totalJobs, y se exige que coincida con la cantidad real
   * de items del run (si no → 500: integridad rota, nunca un % engañoso).
   */
  private async progress(jobId: string, manifest: ManifestDto): Promise<RunProgress> {
    const rows: Array<{ status: ItemRunStatus; type: ManifestItemType; n: number }> = await this.dataSource.query(
      `select status, type, count(*)::int as n from public.generation_item_runs
        where job_id = $1 group by status, type`,
      [jobId],
    );
    const all = emptyCounts();
    const byType = Object.fromEntries(ITEM_TYPES.map((t) => [t, emptyCounts()])) as Record<ManifestItemType, StatusCounts>;
    for (const r of rows) {
      if (!ITEM_STATUSES.includes(r.status) || !byType[r.type]) {
        throw new InternalServerErrorException(`La ejecución ${jobId}: estado/tipo de item desconocido (${r.status}/${r.type})`);
      }
      all[r.status] += r.n;
      all.total += r.n;
      byType[r.type][r.status] += r.n;
      byType[r.type].total += r.n;
    }
    const total = manifest.totals.totalJobs;
    if (all.total !== total) {
      throw new InternalServerErrorException(
        `La ejecución ${jobId}: tiene ${all.total} items pero el Manifest #${manifest.id} declara ${total}`,
      );
    }
    return { ...all, total, pct: total > 0 ? all.completed / total : 0, byType };
  }

  private toItemDto(r: any): ItemRunDto {
    return {
      id: r.id,
      itemKey: r.item_key,
      type: r.type,
      moduleId: r.module_id,
      chapterId: r.chapter_id ?? null,
      dependsOn: r.depends_on ?? [],
      status: r.status,
      generation: r.generation,
      attemptCount: r.attempt_count,
      maxAttempts: r.max_attempts,
      nextRetryAt: toIso(r.next_retry_at),
      error: r.error ?? null,
      idempotencyKey: r.idempotency_key,
      outputSummary: r.output_summary ?? {},
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
      finishedAt: toIso(r.finished_at),
    };
  }
}
