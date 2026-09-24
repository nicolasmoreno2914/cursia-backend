import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { returningRows } from '../../common/db/returning-rows';
import { GenerationManifestsService, ManifestDto } from '../generation-manifests/generation-manifests.service';
import type { ManifestItemType } from '../generation-manifests/generation-manifest-builder';
import { CourseContextDto } from './dto/course-context.dto';
import { canonicalContextHash, itemIdempotencyKey, plainContext } from './run-hash';

export type ItemRunStatus = 'pending' | 'running' | 'retrying' | 'completed' | 'failed' | 'blocked' | 'cancelled';

const ITEM_STATUSES: ItemRunStatus[] = ['pending', 'running', 'retrying', 'completed', 'failed', 'blocked', 'cancelled'];
const ITEM_TYPES: ManifestItemType[] = ['content', 'scorm', 'video', 'exam'];
/** Estados de item que un cancel (o la reconciliación de un cancel legacy) pasa a `cancelled`. */
const NON_TERMINAL_ITEM_STATUSES = ['pending', 'running', 'retrying', 'blocked'];
/** worker_status "activo" del run — el mismo set que el predicado de uq_dynamic_generation_active_run. */
const ACTIVE_RUN_WORKER_STATUSES = ['queued', 'running', 'retrying'];
const CANCELLED_LIKE = new Set(['cancelled', 'cancelling']);
const ACTIVE_RUN_INDEX = 'uq_dynamic_generation_active_run';
/** 5A solo siembra generation 1 (Fase 8 creará generation 2… para regenerar). */
const GENERATION = 1;

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

function isCancelledLike(job: { status?: string | null; worker_status?: string | null }): boolean {
  return CANCELLED_LIKE.has(String(job.worker_status ?? '').trim()) || CANCELLED_LIKE.has(String(job.status ?? '').trim());
}

/**
 * Runs de generación dinámica (Fase 5A, Task 2): crear/sembrar, leer
 * progreso, cancelar, reintentar un item. Sin claim/complete (Task 3).
 *
 * Modelo (spec §3.2–§3.5, §7):
 * - 1 run = 1 fila de `production_jobs` con execution_mode
 *   'dynamic_generation'. `input_payload = {manifestId, blueprintNumber,
 *   contextHash}` (manifestId SIEMPRE, como número — el índice único parcial
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
  constructor(
    private readonly dataSource: DataSource,
    private readonly manifests: GenerationManifestsService,
  ) {}

  /**
   * Get-or-create del run de un Manifest.
   *
   * - Si hay un run activo → se devuelve (`created:false`) y su contexto NO
   *   cambia nunca (condición §7.2). Si el contexto enviado tiene otro hash →
   *   409 explícito para que la UI se lo diga al usuario.
   * - Concurrencia: la garantiza el índice único parcial; el perdedor de una
   *   carrera recibe 23505, re-selecciona el run activo y lo devuelve.
   * - Si ya existen items generation 1 para el Manifest (un run anterior
   *   terminó: completed/failed/cancelled) → 409. En 5A no se "re-adjuntan"
   *   esos items a un run nuevo ni se crea generation 2: re-ejecutar un
   *   Manifest completo es regeneración (Fase 8, generation 2). Reintentar
   *   items `failed` va por `retryItem` sobre el run existente, que reabre el
   *   run si había terminado en failed. Un run cancelado no se reabre.
   */
  async startRun(
    courseId: number,
    ownerId: string,
    blueprintNumber: number,
    courseContext: CourseContextDto,
  ): Promise<{ created: boolean; run: RunDto }> {
    const manifest = await this.manifests.get(courseId, ownerId, blueprintNumber);
    const context = plainContext(courseContext) as Record<string, any>;
    const contextHash = canonicalContextHash(context);

    const active = await this.findActiveRunRow(manifest.id);
    if (active) return this.existingRunOrConflict(active, manifest, contextHash);

    await this.assertNoPreviousItems(manifest);

    const [course] = await this.dataSource.query(
      `select metadata->>'courseId' as frontend_course_id from public.courses where id = $1`,
      [courseId],
    );
    const frontendCourseId: string | null = course?.frontend_course_id ?? null;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    let jobId: string;
    try {
      jobId = await this.insertRun(qr, manifest, ownerId, courseId, frontendCourseId, blueprintNumber, context, contextHash);
      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      if (pgCode(err) === '23505' && pgConstraint(err) === ACTIVE_RUN_INDEX) {
        // Carrera: otro POST creó el run activo primero (y ya commiteó — el
        // índice único espera al otro insert antes de fallar).
        const winner = await this.findActiveRunRow(manifest.id);
        if (winner) return this.existingRunOrConflict(winner, manifest, contextHash);
        throw new ConflictException(
          `Otra ejecución del Manifest #${manifest.id} se creó y terminó mientras se procesaba esta; reintentá la consulta`,
        );
      }
      throw err;
    } finally {
      await qr.release();
    }

    return { created: true, run: await this.buildRunDto(await this.loadJobById(jobId), manifest) };
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

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const [locked] = await qr.query(
        `select id, status, worker_status from public.production_jobs where id = $1 for update`,
        [job.id],
      );
      if (locked.worker_status === 'completed') {
        throw new ConflictException(`La ejecución ${job.id} ya está completada; no se puede cancelar`);
      }
      await this.markRunCancelled(qr, job.id, ownerId, 'user_cancelled');
      await this.cancelOpenItems(qr, job.id);
      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
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
  ): Promise<ItemRunDto> {
    const manifest = await this.manifests.get(courseId, ownerId, blueprintNumber);
    let job = await this.loadRunRow(courseId, manifest, runId);
    job = await this.reconcileCancellation(job);
    if (isCancelledLike(job)) {
      throw new ConflictException(`La ejecución ${job.id} está cancelada; no se pueden reintentar items`);
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    let targetId: string;
    try {
      const [locked] = await qr.query(
        `select id, status, worker_status from public.production_jobs where id = $1 for update`,
        [job.id],
      );
      if (isCancelledLike(locked)) {
        throw new ConflictException(`La ejecución ${job.id} está cancelada; no se pueden reintentar items`);
      }

      const items: Array<{ id: string; item_key: string; status: ItemRunStatus; depends_on: string[] }> =
        await qr.query(
          `select id, item_key, status, depends_on from public.generation_item_runs
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
      targetId = target.id;

      const updated = returningRows(
        await qr.query(
          `update public.generation_item_runs
              set status = 'pending',
                  max_attempts = attempt_count + 3,
                  output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object(
                    'previousErrors',
                    coalesce(output_summary->'previousErrors', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                      'error', error,
                      'attemptCount', attempt_count,
                      'maxAttempts', max_attempts,
                      'retriedAt', now()
                    ))
                  ),
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
          if (pgCode(err) === '23505' && pgConstraint(err) === ACTIVE_RUN_INDEX) {
            throw new ConflictException(
              `Ya hay otra ejecución activa para el Manifest #${manifest.id}; no se puede reabrir ${job.id}`,
            );
          }
          throw err;
        }
      }
      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }

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
  ): Promise<string> {
    const inputPayload = { manifestId: manifest.id, blueprintNumber, contextHash };
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
    if (!Array.isArray(inserted) || inserted.length !== items.length) {
      throw new ConflictException(
        `El Manifest #${manifest.id} ya tiene items sembrados de otra ejecución ` +
          `(${Array.isArray(inserted) ? inserted.length : 0}/${items.length} nuevos); usar reintentar items`,
      );
    }
    return job.id;
  }

  private async assertNoPreviousItems(manifest: ManifestDto): Promise<void> {
    const [{ n }] = await this.dataSource.query(
      `select count(*)::int as n from public.generation_item_runs where manifest_id = $1 and generation = $2`,
      [manifest.id, GENERATION],
    );
    if (n > 0) {
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
  ): Promise<{ created: boolean; run: RunDto }> {
    const ctx = await this.loadContextRow(job.id);
    if (ctx.context_hash !== contextHash) {
      throw new ConflictException(
        `Ya hay una ejecución activa (${job.id}) para este Manifest con OTRO contexto de curso ` +
          `(guardado ${ctx.context_hash.slice(0, 12)}…, enviado ${contextHash.slice(0, 12)}…). ` +
          'El contexto de una ejecución iniciada no cambia: reanudala con el mismo contexto o cancelala primero.',
      );
    }
    return { created: false, run: await this.buildRunDto(job, manifest) };
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
  private async reconcileCancellation(job: any): Promise<any> {
    if (!isCancelledLike(job)) return job;
    if (job.status === 'cancelled' && job.worker_status === 'cancelled') {
      const [{ n }] = await this.dataSource.query(
        `select count(*)::int as n from public.generation_item_runs where job_id = $1 and status = any($2::text[])`,
        [job.id, NON_TERMINAL_ITEM_STATUSES],
      );
      if (n === 0) return job;
    }
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await this.markRunCancelled(qr, job.id, null, 'reconciled_from_job_status');
      await this.cancelOpenItems(qr, job.id);
      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
    return this.loadJobById(job.id);
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
