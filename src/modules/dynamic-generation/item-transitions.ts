import type { QueryRunner } from 'typeorm';
import { returningRows } from '../../common/db/returning-rows';
import { latestGenerationPredicate } from './item-generations';

/**
 * Transiciones de estado de items/run compartidas por RunsService (lecturas:
 * barrido + recálculo, R12) y SchedulerService (claim/complete/fail/sweep).
 * Funciones puras sobre un QueryRunner DENTRO de la transacción del caller.
 *
 * Orden de locks (evita deadlocks con cancelRun/retryItem/reopen de Task 2,
 * que bloquean primero la fila del run y después los items): TODO caller de
 * estas funciones debe tener ya bloqueada la fila del run en
 * production_jobs (FOR UPDATE) antes de tocar items.
 */

/** worker_status "activo" del run — el mismo set que el predicado de uq_dynamic_generation_active_run. */
export const ACTIVE_RUN_WORKER_STATUSES = ['queued', 'running', 'retrying'];
const CANCELLED_LIKE = new Set(['cancelled', 'cancelling']);

/** Backoff de un fallo recuperable: 30s·2^(attempt-1), tope 10 min. */
export const RETRY_BASE_SECONDS = 30;
export const RETRY_MAX_SECONDS = 600;

export function isCancelledLike(job: { status?: string | null; worker_status?: string | null }): boolean {
  return CANCELLED_LIKE.has(String(job.worker_status ?? '').trim()) || CANCELLED_LIKE.has(String(job.status ?? '').trim());
}

export function isActiveRun(job: { status?: string | null; worker_status?: string | null }): boolean {
  return ACTIVE_RUN_WORKER_STATUSES.includes(String(job.worker_status ?? '')) && !isCancelledLike(job);
}

export interface FailedTransition {
  id: string;
  status: 'retrying' | 'failed';
  blocked: string[];
}

/**
 * Fallo de un item `running` (failItem o lease vencido):
 * - retryable y attempt_count < max_attempts → `retrying`, next_retry_at =
 *   now() + backoff(attempt_count); el intento ya se contó al reclamar;
 * - si no → `failed` (permanente) + dependientes transitivos → `blocked`.
 * Lease y worker se limpian (un ejecutor viejo queda rechazado por R14). La
 * idempotency_key no se toca (condición 3: el re-claim reutiliza la MISMA
 * identidad externa). Devuelve null si el item ya no estaba `running`.
 */
export async function applyItemFailure(
  qr: QueryRunner,
  itemRunId: string,
  error: string,
  retryable: boolean,
  /**
   * DN-1: espera explícita antes del próximo intento (p.ej. cuota diaria de
   * YouTube). Ausente → backoff estándar. Solo cambia `next_retry_at`.
   */
  retryAfterSeconds?: number | null,
): Promise<FailedTransition | null> {
  const retryAfter =
    typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.floor(retryAfterSeconds)
      : null;
  const [row] = returningRows(
    await qr.query(
      `update public.generation_item_runs
          set status = case when $3::boolean and attempt_count < max_attempts then 'retrying' else 'failed' end,
              next_retry_at = case when $3::boolean and attempt_count < max_attempts
                then now() + make_interval(secs => coalesce($6::int, least($5::int, $4::int * power(2, greatest(attempt_count, 1) - 1))))
                else null end,
              finished_at = case when $3::boolean and attempt_count < max_attempts then null else now() end,
              worker_id = null,
              lease_until = null,
              error = $2,
              updated_at = now()
        where id = $1 and status = 'running'
        returning id, status, job_id, manifest_id, generation, item_key`,
      [itemRunId, error, retryable, RETRY_BASE_SECONDS, RETRY_MAX_SECONDS, retryAfter],
    ),
  );
  if (!row) return null;
  const blocked = row.status === 'failed' ? await blockDependents(qr, row.job_id, row.item_key) : [];
  return { id: row.id, status: row.status, blocked };
}

/**
 * Dependientes transitivos (depends_on literal del Manifest, mismo run) de
 * `itemKey` en pending/retrying → `blocked` (condición 6: nunca reclamables
 * mientras la dependencia siga failed; retryItem de Task 2 los desbloquea).
 * F78-BE2: se recorre la generación VIGENTE (la más alta) de cada item_key
 * del run — un item de generation 1 pendiente que depende de una
 * regeneración (generation 2) fallida también queda bloqueado. Sin
 * regeneraciones es idéntico a filtrar generation = 1. Devuelve los ids.
 */
export async function blockDependents(qr: QueryRunner, jobId: string, itemKey: string): Promise<string[]> {
  const rows = returningRows(
    await qr.query(
      `with recursive dep(key) as (
         select $2::text
         union
         select g.item_key
           from public.generation_item_runs g
           join dep on dep.key = any(g.depends_on)
          where g.job_id = $1 and ${latestGenerationPredicate('g')}
       )
       update public.generation_item_runs g
          set status = 'blocked', next_retry_at = null, lease_until = null, worker_id = null, updated_at = now()
        where g.job_id = $1 and ${latestGenerationPredicate('g')}
          and g.item_key in (select key from dep) and g.item_key <> $2
          and g.status in ('pending', 'retrying')
        returning g.id`,
      [jobId, itemKey],
    ),
  );
  return rows.map((r: any) => r.id);
}

/**
 * Barrido de leases vencidos de UN run (fila del run ya bloqueada por el
 * caller): `running` con lease_until < now() → mismo camino que
 * failItem(retryable) con error 'lease_expired'. SKIP LOCKED: un item que
 * otro está tocando en este instante (p.ej. un heartbeat) se deja para el
 * próximo barrido. Devuelve cuántos items transicionó.
 */
export async function sweepRunExpiredLeases(qr: QueryRunner, jobId: string): Promise<number> {
  const expired: Array<{ id: string }> = await qr.query(
    `select id from public.generation_item_runs
      where job_id = $1 and status = 'running' and lease_until < now()
      order by id
      for update skip locked`,
    [jobId],
  );
  let n = 0;
  for (const it of expired) {
    if (await applyItemFailure(qr, it.id, 'lease_expired', true)) n++;
  }
  return n;
}

/**
 * R12 — recalcula el estado del run a partir de sus items (fila del run ya
 * bloqueada por el caller). Solo actúa sobre runs activos no cancelados
 * (terminal → activo lo hacen únicamente retryItem/reopen de Task 2):
 * - algún item pending|running|retrying → sigue activo (queued hasta el
 *   primer claim, que lo pasa a running; running se mantiene);
 * - todos completed → completed;
 * - si no (quedan failed/blocked/cancelled, p.ej. un run reabierto con solo
 *   items failed) → failed.
 * lease_until/worker_id del run nunca se tocan (quedan NULL).
 */
export async function recomputeRunStatus(qr: QueryRunner, jobId: string): Promise<string | null> {
  const [job] = await qr.query(`select status, worker_status from public.production_jobs where id = $1`, [jobId]);
  if (!job || !isActiveRun(job)) return job?.worker_status ?? null;

  const rows: Array<{ status: string; n: number }> = await qr.query(
    // F78-BE2: solo la generación vigente de cada item (una regeneración en
    // vuelo mantiene el run activo; las filas históricas no cuentan).
    `select g.status, count(*)::int as n from public.generation_item_runs g
      where g.job_id = $1 and ${latestGenerationPredicate('g')} group by g.status`,
    [jobId],
  );
  const c: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    c[r.status] = r.n;
    total += r.n;
  }
  const active = (c.pending ?? 0) + (c.running ?? 0) + (c.retrying ?? 0);
  if (active > 0) {
    if ((c.running ?? 0) > 0 && job.worker_status !== 'running') {
      await markRunRunning(qr, jobId);
      return 'running';
    }
    return job.worker_status;
  }

  if (total > 0 && (c.completed ?? 0) === total) {
    await qr.query(
      `update public.production_jobs
          set status = 'completed', worker_status = 'completed', progress = 100,
              finished_at = now(), error_message = null, next_retry_at = null, updated_at = now()
        where id = $1`,
      [jobId],
    );
    return 'completed';
  }

  const summary =
    `Generación dinámica terminada con items sin completar: ${c.failed ?? 0} failed, ` +
    `${c.blocked ?? 0} blocked, ${c.cancelled ?? 0} cancelled, ${c.completed ?? 0}/${total} completed`;
  await qr.query(
    `update public.production_jobs
        set status = 'failed', worker_status = 'failed', finished_at = now(), error_message = $2,
            next_retry_at = null, updated_at = now()
      where id = $1`,
    [jobId, summary],
  );
  return 'failed';
}

/** R12: primer claim exitoso (o cualquier item running) → run running. Nunca toca lease/worker del run. */
export async function markRunRunning(qr: QueryRunner, jobId: string): Promise<void> {
  await qr.query(
    `update public.production_jobs
        set status = 'running', worker_status = 'running', started_at = coalesce(started_at, now()), updated_at = now()
      where id = $1 and worker_status in ('queued', 'retrying')`,
    [jobId],
  );
}
