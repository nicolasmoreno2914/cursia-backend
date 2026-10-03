// ─────────────────────────────────────────────────────────────────────────────
// REL R2 — vista de recuperación y costo por item para `RunDto.items[]` (diseño REL §6.2, aditivo).
//
// `recovery`: lo REGISTRADO en generation_item_runs (failure_class/failure_code/recovery_*); si la fila
// no tiene registro (esquema de R2 ausente, o un fallo anterior a la migración) y el item está
// fallado/en reintento/bloqueado, se DERIVA en la lectura con el mismo clasificador (`source: 'derived'`),
// sin escribir nada. Solo códigos, nunca el texto del error (ese ya viaja en `error`).
// `cost`: estimado (línea del estimado congelado del run, scope 'run') y real/pendiente (ledger, suma por
// item_key en todas las generaciones del run). El ledger sigue siendo la única fuente de dinero.
// ─────────────────────────────────────────────────────────────────────────────
import { CurrentRecovery, FailureClass, classifyFailure, currentRecoveryOf } from '../reliability/failure-classifier';
import { maxAutomaticRoundsToday } from './item-transitions';

export interface ItemRecoveryView {
  /** Clase del último fallo (null = sin fallo). */
  class: FailureClass | null;
  code: string | null;
  strategy: string | null;
  /** Rondas automáticas de recuperación ya hechas. */
  round: number;
  /** Rondas automáticas que el sistema hace HOY con este fallo (0 = solo humano; null = sin fallo). */
  maxRounds: number | null;
  nextRetryAt: string | null;
  cooldownUntil: string | null;
  attentionReason: string | null;
  /** Qué hace HOY el sistema con este fallo (auto-heal / reintento seguro / denegado / manual). */
  currentRecovery: CurrentRecovery | null;
  /** recorded = columnas de R2; derived = clasificado en la lectura; none = sin fallo. */
  source: 'recorded' | 'derived' | 'none';
}

export interface ItemCostView {
  /** Esperado del estimado congelado del run (null si no hay estimado de run). */
  estimated: string | null;
  actual: string;
  pending: string;
  currency: 'USD';
}

const FAILURE_STATUSES = new Set(['failed', 'retrying', 'blocked']);

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Vista de recuperación de una fila de generation_item_runs (`select *`). Pura. */
export function recoveryViewOf(r: Record<string, any>): ItemRecoveryView {
  const round = Number.isInteger(Number(r.recovery_round)) && Number(r.recovery_round) > 0 ? Number(r.recovery_round) : 0;
  const nextRetryAt = iso(r.next_retry_at);
  const cooldownUntil = iso(r.cooldown_until);
  if (r.failure_class) {
    return {
      class: r.failure_class as FailureClass,
      code: r.failure_code ?? null,
      strategy: r.recovery_strategy ?? null,
      round,
      maxRounds: typeof r.recovery_max_rounds === 'number' ? r.recovery_max_rounds : r.recovery_max_rounds == null ? null : Number(r.recovery_max_rounds),
      nextRetryAt,
      cooldownUntil,
      attentionReason: r.attention_reason ?? null,
      currentRecovery: r.error ? currentRecoveryOf(String(r.error), r.type, r.output_summary ?? {}, r.failure_class) : null,
      source: 'recorded',
    };
  }
  const error = typeof r.error === 'string' ? r.error.trim() : '';
  if (error && FAILURE_STATUSES.has(String(r.status))) {
    const src = r.type === 'video' ? 'video_worker'
      : ['presentation', 'audio_welcome', 'audiobook_chapter'].includes(r.type) ? 'provider_worker' : 'browser_executor';
    const v = classifyFailure({ error, itemType: r.type, outputSummary: r.output_summary ?? {}, source: src });
    const terminal = r.status === 'failed' || r.status === 'blocked';
    return {
      class: v.class,
      code: v.code,
      strategy: v.strategy,
      round,
      maxRounds: maxAutomaticRoundsToday(error, r.type, r.output_summary ?? {}),
      nextRetryAt,
      cooldownUntil,
      attentionReason: terminal && (v.class === 'C' || v.class === 'D') ? (v.humanReason ?? 'unrecoverable') : null,
      currentRecovery: currentRecoveryOf(error, r.type, r.output_summary ?? {}),
      source: 'derived',
    };
  }
  return {
    class: null, code: null, strategy: null, round, maxRounds: null, nextRetryAt, cooldownUntil,
    attentionReason: null, currentRecovery: null, source: 'none',
  };
}

interface Queryable {
  query(sql: string, params?: any[]): Promise<any>;
}

/**
 * Costo por item_key de un run: estimado (último estimado scope 'run' del run) + real/pendiente del
 * ledger. Fuera de transacción; si el ledger FinOps no existe (entorno sin migrar) o la lectura falla
 * devuelve null (la vista del run sale sin `cost`, nunca con ceros inventados).
 */
export async function loadItemCosts(q: Queryable, jobId: string): Promise<Map<string, ItemCostView> | null> {
  const out = new Map<string, ItemCostView>();
  let rows: any[];
  try {
    rows = await q.query(
      `with est as (
         select l->>'itemKey' as item_key, sum((l->>'expected')::numeric) as estimated
           from (select lines from public.cost_estimates
                  where run_id = $1 and scope = 'run' order by created_at desc, id desc limit 1) e,
                jsonb_array_elements(e.lines) l
          where l ? 'itemKey' and l ? 'expected'
          group by 1
       ),
       act as (
         select e.item_key,
                sum(e.amount) as actual,
                coalesce(sum(e.amount) filter (where e.measurement_status = 'pending' and e.event_kind = 'CHARGE'
                  and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)), 0) as pending
           from public.generation_cost_events e
          where e.run_id = $1 and e.item_key is not null
          group by e.item_key
       )
       select coalesce(est.item_key, act.item_key) as item_key,
              trim_scale(round(est.estimated, 6))::text as estimated,
              trim_scale(round(coalesce(act.actual, 0), 6))::text as actual,
              trim_scale(round(coalesce(act.pending, 0), 6))::text as pending
         from est full join act on act.item_key = est.item_key`,
      [jobId],
    );
  } catch {
    // Ledger/estimados no migrados (42P01/42703) o cualquier fallo de lectura: el costo es informativo y
    // nunca rompe la lectura del run (la vista sale sin `cost`).
    return null;
  }
  for (const r of rows) {
    if (!r.item_key) continue;
    out.set(String(r.item_key), { estimated: r.estimated ?? null, actual: r.actual ?? '0', pending: r.pending ?? '0', currency: 'USD' });
  }
  return out;
}
