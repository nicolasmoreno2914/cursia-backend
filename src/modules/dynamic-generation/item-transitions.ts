import type { QueryRunner } from 'typeorm';
import { returningRows } from '../../common/db/returning-rows';
import { latestGenerationPredicate } from './item-generations';
import { evaluateRunCompletion, loadCompletionInputs, terminalStatusFor } from './run-completion';
import { FailureSource, classifyFailure, currentRecoveryOf, extractFailureCode } from '../reliability/failure-classifier';
import { PROVIDER_RECONCILE_AMBIGUOUS_KINDS, PROVIDER_RECONCILE_MAX_AMBIGUOUS_RESUBMITS, PROVIDER_RECONCILE_MAX_RESUBMITS, providerReconcileKindOf } from './provider-reconcile';
import { AttemptOutcome, failureAttentionOf, outcomeForFailure, recordItemFailure } from '../reliability/attempt-log';
import type { HumanReason } from '../reliability/failure-classifier';
// r67 (A3): máquina de estados de recuperación (persistida en output_summary.recovery + next_retry_at).
import { RecoveryStateView, recoveryStateOf, scheduledRetryAtOf } from '../reliability/recovery-state';
import { AMBIGUOUS_AUDIO_RESUBMIT_MAX_ROUNDS, autoHealMaxRoundsFor, autoHealPolicyFromEnv, autoRegenMaxRoundsFor } from './auto-heal';
import { SAFE_AUTO_RETRY_MAX_ROUNDS } from '../reliability/auto-heal-rules';
import { applyStopAfterInTx, holdsPackaging, packageHoldReason } from './stop-after';

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

/**
 * EV6 DoD BE-B — runs que pasaron a `completed` dentro de una transacción. El empaque automático NO se
 * encola adentro de la transacción (podría deshacerse después de encolar): `recomputeRunStatus` solo
 * anota el run acá y `RunsService.tx` lo entrega a los oyentes DESPUÉS del commit (en un rollback se
 * descarta). Clave = el QueryRunner de la transacción.
 */
const COMPLETED_IN_TX = new WeakMap<object, Set<string>>();

export function noteRunCompletedInTx(qr: object, jobId: string): void {
  let set = COMPLETED_IN_TX.get(qr);
  if (!set) {
    set = new Set<string>();
    COMPLETED_IN_TX.set(qr, set);
  }
  set.add(jobId);
}

/** Lee y olvida los runs completados anotados en esta transacción. */
export function takeCompletedRunsInTx(qr: object): string[] {
  const set = COMPLETED_IN_TX.get(qr);
  COMPLETED_IN_TX.delete(qr);
  return set ? [...set] : [];
}

/**
 * worker_status de un run ABIERTO — el mismo set que el predicado de uq_dynamic_generation_active_run
 * (supabase-migration-run-pause.sql). Incluye 'paused': un run pausado por el usuario sigue abierto (no puede
 * coexistir otro del mismo Manifest, bloquea cambios de estructura y deja terminar lo que ya estaba en vuelo).
 */
export const ACTIVE_RUN_WORKER_STATUSES = ['queued', 'running', 'retrying', 'paused'];
/**
 * worker_status de un run DESPACHABLE: solo estos reciben partes nuevas (claim del navegador y de los workers).
 * 'paused' queda afuera: la pausa la decide el servidor y ningún mecanismo automático la levanta (solo
 * resumeRun, una acción explícita del usuario).
 */
export const DISPATCHABLE_RUN_WORKER_STATUSES = ['queued', 'running', 'retrying'];
export const PAUSED_RUN_WORKER_STATUS = 'paused';
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

/** Run que puede recibir partes nuevas (abierto y NO pausado). */
export function isDispatchableRun(job: { status?: string | null; worker_status?: string | null }): boolean {
  return DISPATCHABLE_RUN_WORKER_STATUSES.includes(String(job.worker_status ?? '')) && !isCancelledLike(job);
}

export function isPausedRun(job: { status?: string | null; worker_status?: string | null }): boolean {
  return String(job.worker_status ?? '') === PAUSED_RUN_WORKER_STATUS && !isCancelledLike(job);
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
  /**
   * DN-1 (review I2): la espera NO consume un intento — se devuelve el que
   * contó el claim (attempt_count - 1) y el item pasa a `retrying` aunque esté
   * en su último intento. Uso: espera de cuota de YouTube (contador y tope
   * propios en output_summary, fuera de max_attempts).
   */
  refundAttempt = false,
  /**
   * R16 (#1/#16): el intento NO cuenta contra max_attempts, pero sin reusar su
   * número: attempt_count se conserva (sigue creciendo en cada claim) y se
   * concede uno más (max_attempts + 1). A diferencia de `refundAttempt`, el
   * próximo claim recibe un número de intento NUEVO, así una reserva pagada sin
   * liquidar del intento interrumpido sigue siendo "de un intento anterior"
   * (priorPaidOperations la detecta → reconciliación, nunca un pago ciego).
   * Uso: lease vencido (laptop dormida, pestaña cerrada, worker reiniciado) y
   * devolución ordenada de un worker que drena (SIGTERM).
   */
  grantAttempt = false,
  /**
   * REL R1/R2: código explícito del emisor (FailItemDto.errorCode) y origen del fallo. Solo se
   * REGISTRAN (clase/código/estrategia en el item + log de intentos); no cambian la transición.
   */
  meta?: { errorCode?: string | null; source?: FailureSource | null; outcome?: AttemptOutcome },
): Promise<FailedTransition | null> {
  const retryAfter =
    typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.floor(retryAfterSeconds)
      : null;
  const [row] = returningRows(
    await qr.query(
      `update public.generation_item_runs
          set status = case when $3::boolean and ($7::boolean or $8::boolean or attempt_count < max_attempts) then 'retrying' else 'failed' end,
              next_retry_at = case when $3::boolean and ($7::boolean or $8::boolean or attempt_count < max_attempts)
                then now() + make_interval(secs => coalesce($6::int, least($5::int, $4::int * power(2, greatest(attempt_count, 1) - 1))))
                else null end,
              finished_at = case when $3::boolean and ($7::boolean or $8::boolean or attempt_count < max_attempts) then null else now() end,
              attempt_count = case when $3::boolean and $7::boolean then greatest(attempt_count - 1, 0) else attempt_count end,
              max_attempts = case when $3::boolean and $8::boolean and not $7::boolean
                then greatest(max_attempts, attempt_count) + 1 else max_attempts end,
              worker_id = null,
              lease_until = null,
              error = $2,
              updated_at = now()
        where id = $1 and status = 'running'
        returning id, status, job_id, manifest_id, generation, item_key, type, output_summary`,
      [itemRunId, error, retryable, RETRY_BASE_SECONDS, RETRY_MAX_SECONDS, retryAfter, !!refundAttempt, !!grantAttempt],
    ),
  );
  if (!row) return null;
  // REL R2: misma transacción — columnas de recuperación del item + cierre del intento (no-op sin esquema).
  const verdict = classifyFailure({
    error, errorCode: meta?.errorCode ?? null, source: meta?.source ?? null, itemType: row.type, outputSummary: row.output_summary ?? {},
  });
  // C1: el desenlace sale de la transición (barrido → lease_expired explícito) o del MENSAJE de un emisor del
  // servidor (drain del worker); un mensaje del navegador siempre es `failed`. Nunca del errorCode reportado.
  const outcome: AttemptOutcome = meta?.outcome
    ?? (meta?.source === 'browser_executor' ? 'failed' : outcomeForFailure(extractFailureCode(error)));
  const maxRoundsToday = maxAutomaticRoundsToday(error, row.type, row.output_summary ?? {}, verdict.class);
  // r67 (A3): estado de recuperación explícito + próxima acción automática visible (next_retry_at también en `failed`)
  // + sin huérfanos (failed sin acción programada ni motivo → attention 'unrecoverable').
  const attentionOverride = await persistFailureRecoveryState(qr, row, error, verdict, maxRoundsToday);
  await recordItemFailure(qr, {
    itemRunId: row.id, status: row.status, error, verdict, outcome, maxRoundsToday, attentionOverride,
  });
  const blocked = row.status === 'failed' ? await blockDependents(qr, row.job_id, row.item_key) : [];
  return { id: row.id, status: row.status, blocked };
}

/** r67: entradas de historial de recuperación que se conservan por parte (output_summary.recovery.history). */
export const RECOVERY_HISTORY_MAX = 20;

/** r67: entrada de output_summary.recovery (estado + historial acotado). */
export function nextRecoveryEntry(prev: Record<string, any> | null | undefined, v: RecoveryStateView, at: Date, extra: Record<string, unknown> = {}): Record<string, any> {
  const history = Array.isArray(prev?.history) ? prev!.history.slice(-(RECOVERY_HISTORY_MAX - 1)) : [];
  history.push({ at: at.toISOString(), state: v.state, reason: v.reason, ...(v.nextRetryAt ? { nextRetryAt: v.nextRetryAt } : {}), ...extra });
  return { state: v.state, reason: v.reason, nextRetryAt: v.nextRetryAt, automatic: v.automatic, at: at.toISOString(), history };
}

async function persistFailureRecoveryState(
  qr: QueryRunner,
  row: { id: string; status: string; type: string; output_summary: Record<string, any> | null; next_retry_at?: Date | string | null },
  error: string,
  verdict: ReturnType<typeof classifyFailure>,
  maxRoundsToday: number,
): Promise<HumanReason | null> {
  const now = new Date();
  const baseAttention = failureAttentionOf(row.status, verdict, maxRoundsToday);
  const probe = {
    id: row.id, type: row.type, status: row.status, error, output_summary: row.output_summary ?? {}, finished_at: now, updated_at: now,
    failure_class: verdict.class, attention_reason: baseAttention, next_retry_at: row.next_retry_at ?? null,
  };
  const scheduled = row.status === 'failed' ? scheduledRetryAtOf(probe, now) : null;
  const attentionOverride: HumanReason | null = row.status === 'failed' && !scheduled && !baseAttention ? 'unrecoverable' : null;
  const v = recoveryStateOf({ ...probe, attention_reason: baseAttention ?? attentionOverride, next_retry_at: row.status === 'failed' ? scheduled : row.next_retry_at ?? null }, now);
  const entry = nextRecoveryEntry(row.output_summary?.recovery, v, now, { code: verdict.code, class: verdict.class });
  await qr.query(
    `update public.generation_item_runs
        set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('recovery', $2::jsonb),
            next_retry_at = case when status = 'failed' then $3::timestamptz else next_retry_at end
      where id = $1`,
    [row.id, JSON.stringify(entry), scheduled ? scheduled.toISOString() : null],
  );
  return attentionOverride;
}

/**
 * REL R2: rondas automáticas que el sistema hace HOY con este fallo una vez `failed` (auto-healer R16 o
 * reintento seguro BE-B, mismas reglas y topes que auto-heal.ts); 0 = solo humano. Informativo.
 */
export function maxAutomaticRoundsToday(error: string, type: string | null | undefined, outputSummary: Record<string, any>, failureClass?: string | null): number {
  const cur = currentRecoveryOf(error, type, outputSummary, failureClass);
  if (cur === 'safe_auto_retry') return SAFE_AUTO_RETRY_MAX_ROUNDS;
  if (cur === 'ambiguous_audio_resubmit') return AMBIGUOUS_AUDIO_RESUBMIT_MAX_ROUNDS;
  if (cur === 'provider_reconcile') {
    // r62 (N2): un caso sin evidencia (ambiguo) tiene UN solo reenvío automático; con evidencia, hasta el tope.
    const kind = providerReconcileKindOf(type, error, outputSummary);
    return kind && PROVIDER_RECONCILE_AMBIGUOUS_KINDS.includes(kind) ? PROVIDER_RECONCILE_MAX_AMBIGUOUS_RESUBMITS : PROVIDER_RECONCILE_MAX_RESUBMITS;
  }
  // r67 (A3): el tope de B depende del código (audio de un segmento: largo de la escalera A2).
  if (cur === 'auto_regenerate') return autoRegenMaxRoundsFor(type, extractFailureCode(error), autoHealPolicyFromEnv(process.env));
  return cur === 'auto_heal' ? autoHealMaxRoundsFor(type, autoHealPolicyFromEnv(process.env)) : 0;
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
 * R16 (#2/#16): cuántos leases vencidos por item se conceden GRATIS (sin
 * consumir max_attempts). Un lease vence por causas ajenas al contenido
 * (laptop dormida, pestaña cerrada, worker reiniciado en un deploy); pasado
 * este tope, un item que mata a su ejecutor una y otra vez vuelve a consumir
 * intentos (nunca un bucle infinito). Contador propio en
 * output_summary.leaseExpiryGrants.
 */
export const LEASE_EXPIRY_FREE_GRANTS = 6;
export const LEASE_EXPIRED_ERROR = 'lease_expired';

function grantsOf(outputSummary: unknown): number {
  const n = Number((outputSummary as Record<string, unknown> | null)?.leaseExpiryGrants ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Barrido de leases vencidos de UN run (fila del run ya bloqueada por el
 * caller): `running` con lease_until < now() → mismo camino que
 * failItem(retryable) con error 'lease_expired'. SKIP LOCKED: un item que
 * otro está tocando en este instante (p.ej. un heartbeat) se deja para el
 * próximo barrido. Devuelve cuántos items transicionó.
 * R16 (#16): mientras el item no agote LEASE_EXPIRY_FREE_GRANTS, el lease
 * vencido no consume un intento (grantAttempt: el número de intento sigue
 * creciendo, solo se concede uno más).
 */
export async function sweepRunExpiredLeases(qr: QueryRunner, jobId: string): Promise<number> {
  const expired: Array<{ id: string; output_summary: Record<string, unknown> | null }> = await qr.query(
    `select id, output_summary from public.generation_item_runs
      where job_id = $1 and status = 'running' and lease_until < now()
      order by id
      for update skip locked`,
    [jobId],
  );
  let n = 0;
  for (const it of expired) {
    const used = grantsOf(it.output_summary);
    const free = used < LEASE_EXPIRY_FREE_GRANTS;
    if (await applyItemFailure(qr, it.id, LEASE_EXPIRED_ERROR, true, null, false, free, { source: 'scheduler', outcome: 'lease_expired' })) {
      n++;
      if (free) {
        await qr.query(
          `update public.generation_item_runs
              set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('leaseExpiryGrants', $2::int)
            where id = $1`,
          [it.id, used + 1],
        );
      }
    }
  }
  return n;
}

/**
 * R12 — recalcula el estado del run a partir de sus items (fila del run ya
 * bloqueada por el caller). Solo actúa sobre runs activos no cancelados
 * (terminal → activo lo hacen únicamente retryItem/reopen de Task 2):
 * - algún item pending|running|retrying → sigue activo (queued hasta el
 *   primer claim, que lo pasa a running; running se mantiene);
 * - todos completed → completed SOLO si todo es real y validado (EV6 DoD, run-completion.ts);
 *   con algún componente de vista previa → preview (terminal); sin validar → failed;
 * - si no (quedan failed/blocked/cancelled, p.ej. un run reabierto con solo
 *   items failed) → failed.
 * lease_until/worker_id del run nunca se tocan (quedan NULL).
 */
export async function recomputeRunStatus(qr: QueryRunner, jobId: string): Promise<string | null> {
  let [job] = await qr.query(`select id, status, worker_status, output_summary from public.production_jobs where id = $1`, [jobId]);
  if (!job || !isActiveRun(job)) return job?.worker_status ?? null;
  // «Detener después de» (stop-after.ts): si la parte elegida ya se completó, el run se pausa ACÁ, en la misma
  // transacción (fila del run bloqueada por el caller) — ningún claim posterior le entrega partes.
  if (await applyStopAfterInTx(qr, job)) {
    [job] = await qr.query(`select id, status, worker_status, output_summary from public.production_jobs where id = $1`, [jobId]);
  }

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
  // Pausa del usuario: nada automático la levanta. Con partes por hacer (o fallidas) sigue `paused`; solo si TODO
  // quedó completo (lo que estaba en vuelo terminó) se cierra como cualquier run.
  if (isPausedRun(job) && !(total > 0 && (c.completed ?? 0) === total)) return job.worker_status;
  if (active > 0) {
    if ((c.running ?? 0) > 0 && job.worker_status !== 'running') {
      await markRunRunning(qr, jobId);
      return 'running';
    }
    return job.worker_status;
  }

  if (total > 0 && (c.completed ?? 0) === total) {
    // EV6 DoD (BE-A): «todos completed» ya no alcanza. Un componente de vista previa (video o
    // Gamma/TTS mock) → `preview` (terminal, nunca `completed`); uno completado sin su validación
    // (video sin entrega YouTube, preguntas de otro video, item v3 sin v3Validation) → `failed`
    // con la lista (recuperación de admin). Solo un run 100 % real y validado queda `completed`.
    const inputs = await loadCompletionInputs(qr, jobId);
    if (!inputs) {
      // Fix round 1 (M2): sin Manifest del run no se puede validar nada → nunca `completed` (fail closed).
      await qr.query(
        `update public.production_jobs
            set status = 'failed', worker_status = 'failed', finished_at = now(), error_message = $2,
                next_retry_at = null, updated_at = now()
          where id = $1`,
        [jobId, 'Generación dinámica sin su Manifest congelado (integridad): no se puede validar que el curso esté completo'],
      );
      return 'failed';
    }
    const verdict = terminalStatusFor(evaluateRunCompletion({ ...inputs.job, worker_status: 'completed', status: 'completed' }, inputs.rows, inputs.manifest, null, { validationCutoffs: inputs.validationCutoffs }));
    if (verdict === 'completed' || verdict === 'preview') {
      // EV6 DoD BE-B: un run que llega a `completed` DESDE ESTE CAMBIO queda marcado para el empaque
      // automático (`output_summary.autoPackage.eligibleAt`, el inicio de su ventana de intentos). Los
      // runs completados antes nunca tienen la marca → el empaque automático jamás los toca.
      // stop-after.ts (holdPackaging): con la retención vigente NO hay marca ni aviso post-commit — queda
      // `autoPackage.held` y el paquete solo se arma por una acción explícita (manual o releasePackageHold).
      const hold = holdsPackaging(job);
      await qr.query(
        `update public.production_jobs
            set status = $2::text, worker_status = $2::text, progress = 100,
                finished_at = now(), error_message = null, next_retry_at = null, updated_at = now(),
                output_summary = case
                  when $2::text = 'completed' and $3::boolean
                    then coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('autoPackage', jsonb_build_object('held', jsonb_build_object('at', now(), 'reason', $4::text)))
                  when $2::text = 'completed'
                    then coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('autoPackage', jsonb_build_object('eligibleAt', now()))
                  else output_summary end
          where id = $1`,
        [jobId, verdict, hold, packageHoldReason(job)],
      );
      // stop-after (review r2 N1): el run se cerró con la config todavía ARMADA (la parte elegida se completó con el run
      // pausado por otra causa) → queda vencida, así una reapertura posterior (regeneración) nunca dispara una pausa tardía.
      await qr.query(
        `update public.production_jobs
            set output_summary = jsonb_set(output_summary, '{stopAfter}',
                  (output_summary->'stopAfter') || jsonb_build_object('firedAt', now(), 'expiredAt', now()), true)
          where id = $1 and jsonb_typeof(output_summary->'stopAfter') = 'object' and (output_summary->'stopAfter'->>'firedAt') is null`,
        [jobId],
      );
      if (verdict === 'completed' && !hold) noteRunCompletedInTx(qr, jobId);
      return verdict;
    }
    const completion = evaluateRunCompletion({ ...inputs.job, worker_status: 'completed', status: 'completed' }, inputs.rows, inputs.manifest, null, { validationCutoffs: inputs.validationCutoffs });
    const unvalidated = completion.missingComponents.filter((k) => !completion.previewComponents.includes(k));
    await qr.query(
      `update public.production_jobs
          set status = 'failed', worker_status = 'failed', finished_at = now(), error_message = $2,
              next_retry_at = null, updated_at = now()
        where id = $1`,
      [jobId, `Generación dinámica terminada con componentes sin validar (${unvalidated.length}): ${unvalidated.slice(0, 20).join(', ')}`],
    );
    return 'failed';
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
