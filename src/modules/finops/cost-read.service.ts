import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { normalizeDecimal } from './decimal';
import { FinopsError } from './errors';

/**
 * FinOps P0 (2026-10-16) — ÚNICA lectura de dinero de Cursia.
 *
 *   generation_cost_events (ledger V2, append-only) → CostReadService → API → Dashboard
 *
 * Nada que muestre dinero lee `usage_events` (tabla antigua, sin reservas ni idempotencia, forjable desde el
 * navegador) ni suma montos en JS: todo se suma en SQL sobre `numeric(20,10)` y sale como string decimal con
 * 10 decimales y su moneda. Definiciones fijas (`COST_READ_DEFINITIONS_VERSION`):
 *
 *  - Cuenta de Cursia: `billing_account = 'cursia'`. BYOK (`user_key`) va aparte en `byok`; `mock` siempre vale 0
 *    y nunca es dinero.
 *  - Pendiente abierto: CHARGE `measurement_status='pending'` sin NINGÚN evento que lo corrija
 *    (`corrects_event_id = id`). Incluye reservas previas a la llamada (cota superior) y cargos provisionales
 *    (Videogen sin costo, Gamma p90, precio faltante a 0).
 *  - reserved  = Σ amount de los pendientes abiertos (Cursia). «Reservado (aún no gastado)».
 *  - actual    = Σ amount de todo lo demás (Cursia) = neto − reservado. «Real».
 *  - committed = Σ amount de TODOS los eventos (Cursia) = actual + reserved, exacto. «Comprometido».
 *    Es el neto del ledger: el «costo del curso» que se muestra como total (ej. #1353 = 51.9236310500).
 *  - estimated = último cost_estimates scope='run' del run (totals.expected/min/max). Nunca se mezcla con el gasto.
 *  - authorized = última cost_budget_authorizations del run = el tope (BLOCKED → "0.0000000000"; sin autorización
 *    → null = sin tope, runs previos a FinOps). Misma regla que el tope atómico (insertReservationWithinRunCap).
 *  - Llamada al proveedor (providerCalls): un CHARGE con provider ≠ 'cursia' (el empaque no es una llamada), cuenta
 *    ≠ mock, que NO pertenece a una «familia de reserva reemplazada» (reserva liquidada / liberada / conciliada
 *    «no cobrada» / conciliada «cobrada» y luego superada por el uso tardío: en todos esos casos la familia neta 0
 *    y la llamada, si se cobró, es su CHARGE final). Una reserva abierta o conciliada «cobrada» ES la llamada.
 * *    ⇒ reserva + cargo final de una misma llamada cuentan UNA vez.
 *  - Reintento: llamada con `call_role <> 'main'` o `attempt > 1` (el attempt de la LLAMADA). Su monto es el neto
 *    de sus eventos (los ADJUSTMENT copian call_role/attempt del cargo que corrigen, así que netean solos).
 *  - Llamada fallida: llamada con `outcome <> 'succeeded'`.
 *  - Sin precio (unpriced, review r1 I1/m1): CHARGE que NO es reserva, `measurement_status='pending'`, monto 0, sin
 *    ningún evento que lo corrija, y con la marca server-side del ledger: `metadata.unpricedReason`
 *    ('pricing_missing' = el catálogo no tenía precio; 'usage_not_measured' = el proveedor respondió pero el uso no se
 *    pudo medir, p.ej. TTS no-mp3) o, en eventos previos a esa marca, `metadata.pricingMissing=true` (que es lo que
 *    el ledger siempre escribió cuando el precio faltaba; pricing_snapshot queda null). La reserva de esa llamada se
 *    liquida a 0 como siempre (nunca queda abierta: los lectores de «resultado desconocido» no la ven), así que el
 *    cargo sin precio es la llamada (cuenta una vez) y su gasto real NO está en ningún monto: se lista
 *    (`unpriced.events`, con su motivo) y el alcance queda `completeness: 'partial'` («Incluye N llamadas sin precio
 *    (costo real incompleto)»). `completeness: 'complete'` = sin cargos sin precio; null = sin ledger (unavailable).
 *    Nunca se infla `actual` con una cota. Se re-precia con repricePendingCharge (manual; solo 'pricing_missing').
 *  - Promedio/mín./máx. por curso (perCourse, review r1 m3): solo cursos con gasto de Cursia > 0 en el período
 *    (Σ amount con billing_account='cursia' > 0). Un curso con solo BYOK, solo mock o solo cargos a 0 (sin precio)
 *    no entra en las estadísticas (sí en `courses[]`); `perCourse.excluded` cuenta cuántos se dejaron fuera.
 *  - Sin datos vs cero: sin ningún evento en el alcance → `status: 'no_data'` y montos null; con eventos que suman 0
 *    → "0.0000000000" con `status: 'ok'`. Sin ledger en la base (producción hoy) → `status: 'unavailable'`.
 *  - Período (resumen): `[from, to)` en UTC sobre la FECHA EFECTIVA del evento = la del CHARGE que corrige
 *    (un ADJUSTMENT/REFUND hereda la fecha de su cargo). Así una reserva del 30 y su liquidación del 1 nunca
 *    quedan partidas en dos períodos (el −R caería solo y daría un neto negativo): la familia entera cae en el día
 *    de la llamada y el cargo final en el suyo. Un ajuste tardío cambia el período de su cargo (retroactivo).
 *
 * Todas las lecturas de una respuesta corren en UNA transacción READ ONLY REPEATABLE READ (foto consistente).
 */
export const COST_READ_DEFINITIONS_VERSION = 'finops-read-v1';

export type CostDataStatus = 'ok' | 'no_data' | 'unavailable';
/** 'partial' = el alcance incluye llamadas sin precio (su gasto real no está en los montos). null = sin ledger. */
export type CostCompleteness = 'complete' | 'partial';

export interface CostCounts {
  events: number;
  eventsCursia: number;
  eventsByok: number;
  eventsMock: number;
  providerCalls: number;
  retries: number;
  failedCalls: number;
  openReservations: number;
  openPending: number;
  unpriced: number;
}

/** F2 (r57): desglose por proveedor + modelo/producto del ledger (mismas definiciones que byProvider). */
export interface CostModelBreakdownRow extends CostBreakdownRow {
  provider: string | null;
  /** `model_or_product` del evento (null si el evento no lo registra). */
  model: string | null;
  /** Alias de providerCalls. */
  calls: number;
}

export interface CostBreakdownRow {
  key: string | null;
  actual: string;
  reserved: string;
  committed: string;
  providerCalls: number;
  events: number;
  /** % del comprometido del alcance (SQL, 1 decimal) — solo para gráficos; null si el total es 0. */
  sharePct: string | null;
}

export interface CostEstimateView {
  runId: string;
  estimateId: string;
  expected: string | null;
  min: string | null;
  max: string | null;
  createdAt: string;
}

export interface CostAuthorizationView {
  runId: string;
  /** Tope vigente: BLOCKED → "0.0000000000". */
  amount: string;
  decision: string;
  authorizedAt: string;
}

export interface UnpricedEventView {
  id: string;
  idempotencyKey: string;
  createdAt: string;
  provider: string;
  model: string | null;
  courseId: number | null;
  runId: string | null;
  itemKey: string | null;
  /** 'pricing_missing' | 'usage_not_measured' (eventos viejos sin la marca: 'pricing_missing'). */
  reason: string;
  billingAccount: string;
}

export interface CostSummary {
  status: CostDataStatus;
  completeness: CostCompleteness | null;
  definitions: string;
  currency: 'USD';
  actual: string | null;
  reserved: string | null;
  committed: string | null;
  estimated: CostEstimateView | { expected: string | null; runs: number } | null;
  authorized: CostAuthorizationView | { amount: string | null; runsWithCap: number; runsWithoutCap: number } | null;
  byok: { actual: string | null; reserved: string | null; committed: string | null; providerCalls: number };
  retries: { calls: number; actual: string | null; committed: string | null };
  counts: CostCounts;
  byProvider: CostBreakdownRow[];
  byModel: CostModelBreakdownRow[];
  byItemType: CostBreakdownRow[];
  byOperation: CostBreakdownRow[];
  unpriced: { count: number; events: UnpricedEventView[] };
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
  lastEventAt: string | null;
}

export interface RunCost extends CostSummary {
  runId: string | null;
  courseId: number | null;
  /** Σ por item_key; `key: null` = eventos a nivel run (empaque, etc.). Σ filas = total del run. */
  byItemKey?: CostBreakdownRow[];
}

export interface CourseCost extends CostSummary {
  scope: 'course';
  courseId: number;
  courseName: string | null;
  courseStatus: string | null;
  runs: RunCost[];
}

export interface PeriodCourseRow {
  courseId: number;
  courseName: string | null;
  courseStatus: string | null;
  frontendCourseId: string | null;
  money: CostSummary;
}

export interface PeriodSummary extends CostSummary {
  scope: 'period';
  period: { from: string; to: string; basis: 'effective_at_utc' };
  perCourse: { courses: number; excluded: number; average: string | null; min: string | null; max: string | null };
  unattributed: CostSummary & { byReason: Array<{ reason: string; committed: string; events: number }> };
  courses: PeriodCourseRow[];
  coursesTruncated: boolean;
}

type Runner = { query: (sql: string, params?: any[]) => Promise<any> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GCE = 'public.generation_cost_events';
const COURSE_ROWS_LIMIT = 500;

/**
 * CTE `ev`: eventos del alcance con sus banderas derivadas (una sola definición para todos los lectores).
 * `where` filtra sobre `e` (el evento) o `coalesce(p.created_at, e.created_at)` (fecha efectiva).
 */
export function costEventsCte(where: string): string {
  // Reserva «reemplazada»: cerrada (tiene corrección) y NO contada como cobrada (o contada y luego superada).
  const dropped = (r: string) => `(
      coalesce(${r}.metadata->>'reservation', '') = 'true' and ${r}.event_kind = 'CHARGE'
      and exists (select 1 from ${GCE} a where a.corrects_event_id = ${r}.id)
      and not (
        exists (select 1 from ${GCE} a where a.corrects_event_id = ${r}.id and coalesce(a.metadata->>'reservationReconciledAsCharged', '') = 'true')
        and not exists (select 1 from ${GCE} a where a.corrects_event_id = ${r}.id and coalesce(a.metadata->>'supersededBy', '') <> '')
      ))`;
  return `ev as (
    select e.id, e.created_at, e.event_kind, e.amount, e.billing_account, e.provider, e.item_type, e.item_key, e.operation,
           e.course_id, e.run_id, e.call_role, e.attempt, e.outcome, e.owner_id, e.metadata, e.usage, e.idempotency_key,
           e.model_or_product, e.measurement_status,
           coalesce(p.created_at, e.created_at) as effective_at,
           (e.event_kind = 'CHARGE' and coalesce(e.metadata->>'reservation', '') = 'true') as is_reservation,
           coalesce(e.event_kind = 'CHARGE' and e.measurement_status = 'pending'
             and not exists (select 1 from ${GCE} a where a.corrects_event_id = e.id), false) as is_open,
           (e.call_role <> 'main' or e.attempt > 1) as is_retry,
           coalesce(case when e.event_kind = 'CHARGE' then ${dropped('e')} else ${dropped('p')} end, false) as in_dropped_family,
           coalesce(e.event_kind = 'CHARGE' and e.provider <> 'cursia' and e.billing_account <> 'mock'
             and not ${dropped('e')}, false) as is_call,
           coalesce(e.event_kind = 'CHARGE' and coalesce(e.metadata->>'reservation', '') <> 'true'
             and e.measurement_status = 'pending' and e.amount = 0
             and (coalesce(e.metadata->>'unpricedReason', '') <> '' or coalesce(e.metadata->>'pricingMissing', '') = 'true')
             and not exists (select 1 from ${GCE} a where a.corrects_event_id = e.id), false) as is_unpriced
      from ${GCE} e
      left join ${GCE} p on p.id = e.corrects_event_id
     where ${where}
  )`;
}

const C = `billing_account = 'cursia'`;
const BYOK = `billing_account = 'user_key'`;
const tok = (k: string) => `coalesce(sum(case when (usage->>'${k}') ~ '^\\d+(\\.\\d+)?$' then (usage->>'${k}')::numeric else 0 end)
  filter (where ${C} and event_kind = 'CHARGE' and not is_reservation and provider = 'anthropic'), 0)::bigint`;

/** Agregados de una fila (todo el alcance o un grupo). */
export const COST_AGGREGATES = `
  count(*)::int as events,
  count(*) filter (where ${C})::int as events_cursia,
  count(*) filter (where ${BYOK})::int as events_byok,
  count(*) filter (where billing_account = 'mock')::int as events_mock,
  coalesce(sum(amount) filter (where ${C}), 0)::text as committed,
  coalesce(sum(amount) filter (where ${C} and is_open), 0)::text as reserved,
  coalesce(sum(amount) filter (where ${C} and not is_open), 0)::text as actual,
  coalesce(sum(amount) filter (where ${BYOK}), 0)::text as byok_committed,
  coalesce(sum(amount) filter (where ${BYOK} and is_open), 0)::text as byok_reserved,
  coalesce(sum(amount) filter (where ${BYOK} and not is_open), 0)::text as byok_actual,
  count(*) filter (where ${C} and is_call)::int as provider_calls,
  count(*) filter (where ${BYOK} and is_call)::int as byok_calls,
  count(*) filter (where ${C} and is_call and is_retry)::int as retry_calls,
  coalesce(sum(amount) filter (where ${C} and is_retry and not is_open), 0)::text as retry_actual,
  coalesce(sum(amount) filter (where ${C} and is_retry), 0)::text as retry_committed,
  count(*) filter (where ${C} and is_call and outcome <> 'succeeded')::int as failed_calls,
  count(*) filter (where ${C} and is_open and is_reservation)::int as open_reservations,
  count(*) filter (where ${C} and is_open)::int as open_pending,
  count(*) filter (where is_unpriced and billing_account <> 'mock')::int as unpriced,
  ${tok('input_tokens')} as tokens_input,
  ${tok('output_tokens')} as tokens_output,
  ${tok('cache_write_tokens')} as tokens_cache_write,
  ${tok('cache_read_tokens')} as tokens_cache_read,
  max(created_at) as last_event_at`;

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function dec(v: unknown): string {
  return normalizeDecimal(v === null || v === undefined ? '0' : String(v));
}

function isMissingLedger(err: unknown): boolean {
  const e = err as { code?: unknown; driverError?: { code?: unknown } } | null;
  const code = e && (e.code ?? e.driverError?.code);
  return code === '42P01' || code === '42703';
}

/** Fila de agregados → CostSummary (sin estimado/tope/desgloses). */
export function summaryFromAggregates(row: any): CostSummary {
  const events = Number(row?.events ?? 0);
  const has = events > 0;
  const m = (v: unknown) => (has ? dec(v) : null);
  return {
    status: has ? 'ok' : 'no_data',
    completeness: Number(row?.unpriced ?? 0) > 0 ? 'partial' : 'complete',
    definitions: COST_READ_DEFINITIONS_VERSION,
    currency: 'USD',
    actual: m(row?.actual),
    reserved: m(row?.reserved),
    committed: m(row?.committed),
    estimated: null,
    authorized: null,
    byok: { actual: m(row?.byok_actual), reserved: m(row?.byok_reserved), committed: m(row?.byok_committed), providerCalls: Number(row?.byok_calls ?? 0) },
    retries: { calls: Number(row?.retry_calls ?? 0), actual: m(row?.retry_actual), committed: m(row?.retry_committed) },
    counts: {
      events,
      eventsCursia: Number(row?.events_cursia ?? 0),
      eventsByok: Number(row?.events_byok ?? 0),
      eventsMock: Number(row?.events_mock ?? 0),
      providerCalls: Number(row?.provider_calls ?? 0),
      retries: Number(row?.retry_calls ?? 0),
      failedCalls: Number(row?.failed_calls ?? 0),
      openReservations: Number(row?.open_reservations ?? 0),
      openPending: Number(row?.open_pending ?? 0),
      unpriced: Number(row?.unpriced ?? 0),
    },
    byProvider: [],
    byModel: [],
    byItemType: [],
    byOperation: [],
    unpriced: { count: Number(row?.unpriced ?? 0), events: [] },
    tokens: {
      input: Number(row?.tokens_input ?? 0), output: Number(row?.tokens_output ?? 0),
      cacheWrite: Number(row?.tokens_cache_write ?? 0), cacheRead: Number(row?.tokens_cache_read ?? 0),
    },
    lastEventAt: has ? iso(row?.last_event_at) : null,
  };
}

/** Resumen vacío honesto: sin ledger en esta base (`unavailable`) o sin eventos (`no_data`). */
export function emptySummary(status: CostDataStatus): CostSummary {
  return { ...summaryFromAggregates({ events: 0 }), status, completeness: status === 'unavailable' ? null : 'complete' };
}

@Injectable()
export class CostReadService {
  constructor(private readonly dataSource: DataSource) {}

  /** Foto consistente: READ ONLY + REPEATABLE READ. Sin ledger migrado → null (el caller responde `unavailable`). */
  private async snapshot<T>(fn: (q: Runner) => Promise<T>): Promise<T | null> {
    try {
      return await this.dataSource.transaction('REPEATABLE READ', async (m) => {
        await m.query('set transaction read only');
        return fn(m);
      });
    } catch (err) {
      if (isMissingLedger(err)) return null;
      throw err;
    }
  }

  private async aggregate(q: Runner, where: string, params: unknown[]): Promise<CostSummary> {
    const [row] = await q.query(`with ${costEventsCte(where)} select ${COST_AGGREGATES} from ev`, params);
    return summaryFromAggregates(row);
  }

  private async breakdown(q: Runner, column: 'provider' | 'item_type' | 'operation' | 'item_key' | 'run_id', where: string, params: unknown[]): Promise<CostBreakdownRow[]> {
    const rows = await q.query(
      `with ${costEventsCte(where)},
       g as (
         select ${column}::text as key,
                coalesce(sum(amount) filter (where ${C} and not is_open), 0) as actual,
                coalesce(sum(amount) filter (where ${C} and is_open), 0) as reserved,
                coalesce(sum(amount) filter (where ${C}), 0) as committed,
                count(*) filter (where ${C} and is_call)::int as provider_calls,
                count(*)::int as events
           from ev group by ${column}),
       t as (select sum(committed) as total from g)
       select g.key, g.actual::text as actual, g.reserved::text as reserved, g.committed::text as committed, g.provider_calls, g.events,
              case when t.total is null or t.total = 0 then null else round(100 * g.committed / t.total, 1)::text end as share_pct
         from g, t
        order by g.committed desc, g.key nulls last`,
      params,
    );
    return rows.map((r: any) => ({
      key: r.key ?? null, actual: dec(r.actual), reserved: dec(r.reserved), committed: dec(r.committed),
      providerCalls: Number(r.provider_calls), events: Number(r.events), sharePct: r.share_pct ?? null,
    }));
  }

  private async modelBreakdown(q: Runner, where: string, params: unknown[]): Promise<CostModelBreakdownRow[]> {
    const rows = await q.query(
      `with ${costEventsCte(where)},
       g as (
         select provider::text as provider, model_or_product::text as model,
                coalesce(sum(amount) filter (where ${C} and not is_open), 0) as actual,
                coalesce(sum(amount) filter (where ${C} and is_open), 0) as reserved,
                coalesce(sum(amount) filter (where ${C}), 0) as committed,
                count(*) filter (where ${C} and is_call)::int as provider_calls,
                count(*)::int as events
           from ev group by provider, model_or_product),
       t as (select sum(committed) as total from g)
       select g.provider, g.model, g.actual::text as actual, g.reserved::text as reserved, g.committed::text as committed, g.provider_calls, g.events,
              case when t.total is null or t.total = 0 then null else round(100 * g.committed / t.total, 1)::text end as share_pct
         from g, t
        order by g.committed desc, g.provider nulls last, g.model nulls last`,
      params,
    );
    return rows.map((r: any) => ({
      key: `${r.provider ?? ''}/${r.model ?? ''}`, provider: r.provider ?? null, model: r.model ?? null,
      actual: dec(r.actual), reserved: dec(r.reserved), committed: dec(r.committed),
      providerCalls: Number(r.provider_calls), calls: Number(r.provider_calls), events: Number(r.events), sharePct: r.share_pct ?? null,
    }));
  }

  private async unpricedList(q: Runner, where: string, params: unknown[]): Promise<UnpricedEventView[]> {
    const rows = await q.query(
      `with ${costEventsCte(where)}
       select id, idempotency_key, created_at, provider, model_or_product, course_id, run_id, item_key, billing_account,
              coalesce(nullif(metadata->>'unpricedReason', ''), 'pricing_missing') as reason
         from ev where is_unpriced and billing_account <> 'mock' order by created_at limit 50`,
      params,
    );
    return rows.map((r: any) => ({
      id: r.id, idempotencyKey: r.idempotency_key, createdAt: iso(r.created_at) as string, provider: r.provider,
      model: r.model_or_product ?? null, courseId: r.course_id === null ? null : Number(r.course_id), runId: r.run_id ?? null, itemKey: r.item_key ?? null,
      reason: String(r.reason), billingAccount: String(r.billing_account),
    }));
  }

  private async full(q: Runner, where: string, params: unknown[]): Promise<CostSummary> {
    const base = await this.aggregate(q, where, params);
    if (base.status === 'no_data') return base;
    // Secuencial: un solo cliente de la transacción (pg no admite consultas concurrentes sobre el mismo cliente).
    const byProvider = await this.breakdown(q, 'provider', where, params);
    const byModel = await this.modelBreakdown(q, where, params);
    const byItemType = await this.breakdown(q, 'item_type', where, params);
    const byOperation = await this.breakdown(q, 'operation', where, params);
    const unpriced = base.counts.unpriced > 0 ? await this.unpricedList(q, where, params) : [];
    return { ...base, byProvider, byModel, byItemType, byOperation, unpriced: { count: base.counts.unpriced, events: unpriced } };
  }

  /** Último estimado scope='run' del run (nunca dinero gastado). */
  private async runEstimate(q: Runner, runId: string): Promise<CostEstimateView | null> {
    const [r] = await q.query(
      `select id, run_id, created_at, totals->>'expected' as expected, totals->>'min' as min, totals->>'max' as max
         from public.cost_estimates where run_id = $1 and scope = 'run' order by created_at desc, id desc limit 1`,
      [runId],
    );
    if (!r) return null;
    const d = (v: unknown) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? normalizeDecimal(v) : null);
    return { runId: r.run_id, estimateId: r.id, expected: d(r.expected), min: d(r.min), max: d(r.max), createdAt: iso(r.created_at) as string };
  }

  /** Último tope del run (BLOCKED → 0). null = sin autorización (sin tope). */
  private async runAuthorization(q: Runner, runId: string): Promise<CostAuthorizationView | null> {
    const [r] = await q.query(
      `select run_id, decision, authorized_budget::text as b, created_at from public.cost_budget_authorizations
        where run_id = $1 order by created_at desc, id desc limit 1`,
      [runId],
    );
    if (!r) return null;
    return { runId: r.run_id, amount: r.decision === 'BLOCKED' ? normalizeDecimal(0) : dec(r.b), decision: r.decision, authorizedAt: iso(r.created_at) as string };
  }

  private async runCostIn(q: Runner, runId: string, courseId: number | null): Promise<RunCost> {
    const where = `e.run_id = $1`;
    const s = await this.full(q, where, [runId]);
    const estimated = await this.runEstimate(q, runId);
    const authorized = await this.runAuthorization(q, runId);
    const byItemKey = s.status === 'ok' ? await this.breakdown(q, 'item_key', where, [runId]) : [];
    return { ...s, estimated, authorized, runId, courseId, byItemKey };
  }

  async runCost(runId: string): Promise<RunCost> {
    if (!UUID_RE.test(runId)) throw new FinopsError('INVALID_INPUT', 'runId debe ser UUID');
    const out = await this.snapshot(async (q) => {
      const [j] = await q.query(`select course_id from public.production_jobs where id = $1`, [runId]);
      return this.runCostIn(q, runId, j && j.course_id !== null && j.course_id !== undefined ? Number(j.course_id) : null);
    });
    return out ?? { ...emptySummary('unavailable'), runId, courseId: null, byItemKey: [] };
  }

  /**
   * Costo del curso (courses.id entero = generation_cost_events.course_id): TODOS sus runs + eventos a nivel curso
   * (sin run). `committed` es el total del curso; `runs[]` el desglose por run (Σ runs + `runId:null` = curso).
   * estimated / authorized del curso = los del run más reciente (production_jobs.created_at).
   */
  async courseCost(courseId: number): Promise<CourseCost> {
    if (!Number.isInteger(courseId) || courseId < 1) throw new FinopsError('INVALID_INPUT', 'courseId debe ser entero positivo');
    const out = await this.snapshot(async (q) => {
      const [course] = await q.query(`select title, status from public.courses where id = $1`, [courseId]);
      const where = `e.course_id = $1`;
      const s = await this.full(q, where, [courseId]);
      const runRows: Array<{ run_id: string | null; created_at: string | null }> = await q.query(
        `with r as (
           select distinct run_id from ${GCE} where course_id = $1
           union select distinct run_id from public.cost_estimates where course_id = $1 and run_id is not null
           union select distinct run_id from public.cost_budget_authorizations where course_id = $1 and run_id is not null)
         select r.run_id, pj.created_at from r left join public.production_jobs pj on pj.id = r.run_id
          order by pj.created_at desc nulls last, r.run_id nulls last`,
        [courseId],
      );
      const runs: RunCost[] = [];
      for (const r of runRows) {
        if (r.run_id) {
          runs.push(await this.runCostIn(q, r.run_id, courseId));
        } else {
          // Eventos del curso sin run (lectura avanzada del documento, etc.): fila propia del desglose.
          const n = await this.full(q, `e.course_id = $1 and e.run_id is null`, [courseId]);
          runs.push({ ...n, runId: null, courseId });
        }
      }
      const latest = runs.find((r) => r.runId !== null) ?? null;
      return {
        ...s,
        scope: 'course' as const,
        courseId,
        courseName: course ? course.title ?? null : null,
        courseStatus: course ? course.status ?? null : null,
        estimated: latest ? latest.estimated : null,
        authorized: latest ? latest.authorized : null,
        runs,
      };
    });
    return out ?? { ...emptySummary('unavailable'), scope: 'course', courseId, courseName: null, courseStatus: null, runs: [] };
  }

  /**
   * Resumen de un período `[from, to)` (UTC, fecha efectiva; ver cabecera). Una fila por curso con eventos en el
   * período (montos SOLO del período), el bloque «sin atribuir» (course_id null) y estadísticas por curso en SQL.
   */
  async periodSummary(from: Date, to: Date): Promise<PeriodSummary> {
    if (!(from instanceof Date) || !(to instanceof Date) || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
      throw new FinopsError('INVALID_INPUT', 'from/to deben ser fechas válidas');
    }
    if (from.getTime() > to.getTime()) throw new FinopsError('INVALID_INPUT', 'from debe ser anterior a to');
    const period = { from: from.toISOString(), to: to.toISOString(), basis: 'effective_at_utc' as const };
    const P = [period.from, period.to];
    const inRange = `coalesce(p.created_at, e.created_at) >= $1::timestamptz and coalesce(p.created_at, e.created_at) < $2::timestamptz`;
    const out = await this.snapshot(async (q) => {
      const s = await this.full(q, inRange, P);
      const [est] = await q.query(
        `with ${costEventsCte(inRange)},
         runs as (select distinct run_id from ev where run_id is not null),
         est as (select distinct on (run_id) run_id, totals->>'expected' as x from public.cost_estimates
                  where run_id in (select run_id from runs) and scope = 'run' order by run_id, created_at desc, id desc)
         select count(*)::int as n, coalesce(sum(case when x ~ '^-?\\d+(\\.\\d+)?$' then x::numeric else 0 end), 0)::text as expected from est`,
        P,
      );
      const [cap] = await q.query(
        `with ${costEventsCte(inRange)},
         runs as (select distinct run_id from ev where run_id is not null),
         a as (select distinct on (run_id) run_id, decision, authorized_budget from public.cost_budget_authorizations
                where run_id in (select run_id from runs) order by run_id, created_at desc, id desc)
         select (select count(*)::int from runs) as runs, count(a.run_id)::int as with_cap,
                coalesce(sum(case when a.decision = 'BLOCKED' then 0 else a.authorized_budget end), 0)::text as amount
           from a`,
        P,
      );
      const [per] = await q.query(
        `with ${costEventsCte(inRange)},
         c as (select course_id, coalesce(sum(amount) filter (where ${C}), 0) as committed from ev where course_id is not null group by course_id)
         select count(*) filter (where committed > 0)::int as n, count(*) filter (where not committed > 0)::int as excluded,
                round(avg(committed) filter (where committed > 0), 10)::text as avg,
                (min(committed) filter (where committed > 0))::text as min, (max(committed) filter (where committed > 0))::text as max from c`,
        P,
      );
      // Agregados por curso SOLO del período; el nombre/estado/id del frontend salen de courses (no de usage_events).
      const courseRows = await q.query(
        `with ${costEventsCte(inRange)},
         g as (select course_id, ${COST_AGGREGATES} from ev where course_id is not null group by course_id)
         select g.*, c.title, c.status, c.metadata->>'courseId' as frontend_course_id
           from g left join public.courses c on c.id = g.course_id
          order by g.last_event_at desc, g.course_id
          limit ${COURSE_ROWS_LIMIT + 1}`,
        P,
      );
      const unattributedWhere = `${inRange} and e.course_id is null`;
      const un = await this.full(q, unattributedWhere, P);
      const byReason = un.status === 'ok'
        ? (await q.query(
          `with ${costEventsCte(unattributedWhere)}
           select coalesce(nullif(metadata->>'attributionRejectReason', ''), nullif(metadata->>'unattributedReason', ''), 'not_declared') as reason,
                  coalesce(sum(amount) filter (where ${C}), 0)::text as committed, count(*)::int as events
             from ev group by 1 order by 1`,
          P,
        )).map((r: any) => ({ reason: r.reason, committed: dec(r.committed), events: Number(r.events) }))
        : [];
      const has = s.status === 'ok';
      return {
        ...s,
        scope: 'period' as const,
        period,
        estimated: has ? { expected: Number(est.n) > 0 ? dec(est.expected) : null, runs: Number(est.n) } : null,
        authorized: has ? { amount: Number(cap.with_cap) > 0 ? dec(cap.amount) : null, runsWithCap: Number(cap.with_cap), runsWithoutCap: Number(cap.runs) - Number(cap.with_cap) } : null,
        perCourse: {
          courses: Number(per.n),
          excluded: Number(per.excluded),
          average: Number(per.n) > 0 ? dec(per.avg) : null,
          min: Number(per.n) > 0 ? dec(per.min) : null,
          max: Number(per.n) > 0 ? dec(per.max) : null,
        },
        unattributed: { ...un, byReason },
        courses: courseRows.slice(0, COURSE_ROWS_LIMIT).map((r: any) => ({
          courseId: Number(r.course_id), courseName: r.title ?? null, courseStatus: r.status ?? null,
          frontendCourseId: r.frontend_course_id ?? null, money: summaryFromAggregates(r),
        })),
        coursesTruncated: courseRows.length > COURSE_ROWS_LIMIT,
      };
    });
    return out ?? {
      ...emptySummary('unavailable'), scope: 'period', period, perCourse: { courses: 0, excluded: 0, average: null, min: null, max: null },
      unattributed: { ...emptySummary('unavailable'), byReason: [] }, courses: [], coursesTruncated: false,
    };
  }
}
