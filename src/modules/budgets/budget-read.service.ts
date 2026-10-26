import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { addDec, cmpDec, normalizeDecimal, subDec } from '../finops/decimal';
import { Runner, UUID_RE, budgetsMode, currentMonth, dec, iso, monthDate, monthRange, monthOfDate } from './budget-common';

/**
 * r75 (Agente C) — lecturas del presupuesto mensual por usuario (01 §5.1). Mes = calendario UTC (D-17).
 *
 *   limit(U,M)     = última versión `recurring` con effective_month ≤ M (o 0) + Σ `month_adjustment` de M.
 *   spent(U,M)     = SOLO el ledger (generation_cost_events, billing_account='cursia'; BYOK y mock fuera), fecha efectiva
 *                    `coalesce(p.created_at, e.created_at)` en M (la de CostReadService), sumando:
 *                      (a) eventos con run_id de runs que PAGA U (reserva 'start' de U; sin reserva, el dueño del run);
 *                      (b) eventos sin run_id con owner_id = U (proxy sin parte, llamadas directas, TTS).
 *                    El ledger neto ya anula reserva + liquidación → (a)+(b) no doble-cuenta.
 *   held(U)        = Σ por RUN VIVO que paga U de max(última autorización AUTO/ADMIN − gastado del run, 0) (la fórmula de
 *                    ownerMonthCommitted llaveada por quien paga). Se cuenta por run (no por fila de reserva: un run con
 *                    reserva 'start' + 'extension' cuenta una vez). Un run terminal deja de contar aunque su reserva no
 *                    se haya liberado todavía (robusto ante liberaciones perdidas). Solo en el mes actual.
 *   available(U,M) = limit − spent − held (puede ser negativo: un sobregiro ya gastado se imputa al iniciador).
 */

/** Estados de run que ya no retienen presupuesto (misma lista que monthCommitted). */
export const RUN_LIVE_SQL = (alias: string) =>
  `coalesce(${alias}.worker_status, '') not in ('completed', 'preview', 'failed', 'cancelled', 'cancelling')
   and coalesce(${alias}.status, '') not in ('cancelled', 'cancelling')`;

/**
 * Runs (uuid) que paga el usuario $1 (texto, UUID validado): su reserva 'start', o runs suyos sin reserva 'start' de
 * otro. `owner_id` se compara como texto (deriva varchar/uuid entre entornos, D-2); los ids de run son uuid en todos los
 * entornos (production_jobs.id, generation_cost_events.run_id, cost_budget_authorizations.run_id) → índices usables.
 */
export const RUNS_PAID_BY_SQL = `
  select j.id as run_id from public.production_jobs j
   where j.owner_id::text = $1
     and not exists (select 1 from public.budget_reservations br
                      where br.run_id = j.id and br.kind = 'start' and br.user_id <> $1::uuid)
  union
  select br.run_id from public.budget_reservations br where br.kind = 'start' and br.user_id = $1::uuid`;

export interface UserBudgetSummary {
  month: string;
  limitUsd: string;
  spentUsd: string;
  heldUsd: string;
  availableUsd: string;
  pendingRequests: number;
  /** Aditivos (no rompen el contrato): modo del flag y si el usuario tiene algún presupuesto asignado en el mes. */
  mode: 'off' | 'shadow' | 'enforce';
  assigned: boolean;
}

export interface ReservationView {
  id: string;
  userId: string;
  institutionId: string | null;
  courseId: number;
  runId: string;
  kind: 'start' | 'extension' | 'upgrade' | 'reopen';
  amountUsd: string;
  liveHeldUsd: string;
  status: 'active' | 'released' | 'settled';
  periodMonth: string;
  createdAt: string;
}

export interface BudgetVersionView {
  id: string;
  kind: 'recurring' | 'month_adjustment';
  effectiveMonth: string;
  amountUsd: string;
  version: number;
  reason: string;
  createdBy: string;
  createdAt: string;
  sourceRequestId: string | null;
}

@Injectable()
export class BudgetReadService {
  constructor(private readonly dataSource: DataSource) {}

  /** limit(U,M) + si hay algún presupuesto asignado (recurring > 0 o algún ajuste del mes). */
  async limitOf(userId: string, month: string, q: Runner = this.dataSource): Promise<{ limit: string; assigned: boolean }> {
    if (!UUID_RE.test(userId)) return { limit: normalizeDecimal(0), assigned: false };
    const [r] = await q.query(
      `select (select amount_usd::text from public.user_budgets
                where user_id = $1::uuid and institution_id is null and kind = 'recurring' and effective_month <= $2::date
                order by effective_month desc, version desc, created_at desc limit 1) as recurring,
              (select coalesce(sum(amount_usd), 0)::text from public.user_budgets
                where user_id = $1::uuid and institution_id is null and kind = 'month_adjustment' and effective_month = $2::date) as adj,
              (select count(*)::int from public.user_budgets
                where user_id = $1::uuid and institution_id is null and kind = 'month_adjustment' and effective_month = $2::date) as nadj`,
      [userId, monthDate(month)],
    );
    const recurring = r?.recurring ?? null;
    const limit = addDec(recurring ?? 0, r?.adj ?? 0);
    const assigned = (recurring !== null && cmpDec(recurring, 0) > 0) || Number(r?.nadj ?? 0) > 0;
    return { limit, assigned };
  }

  /** spent(U,M), solo desde el ledger. */
  async spentOf(userId: string, month: string, q: Runner = this.dataSource): Promise<string> {
    const { from, to } = monthRange(month);
    const [r] = await q.query(
      `with runs_u as (${RUNS_PAID_BY_SQL})
       select coalesce(sum(e.amount), 0)::text as t
         from public.generation_cost_events e
         left join public.generation_cost_events p on p.id = e.corrects_event_id
        where e.billing_account = 'cursia'
          and coalesce(p.created_at, e.created_at) >= $2::timestamptz and coalesce(p.created_at, e.created_at) < $3::timestamptz
          and ((e.run_id is not null and e.run_id in (select run_id from runs_u))
               or (e.run_id is null and e.owner_id = $1))`,
      [userId, from.toISOString(), to.toISOString()],
    );
    return dec(r?.t);
  }

  /** held(U) de runs vivos (opcionalmente sin un run: el que se está arrancando / ampliando). */
  async heldOf(userId: string, q: Runner = this.dataSource, excludeRunId: string | null = null): Promise<string> {
    const [r] = await q.query(
      `with runs_u as (${RUNS_PAID_BY_SQL})
       select coalesce(sum(greatest(a.authorized_budget - coalesce(sp.spent, 0), 0)), 0)::text as t
         from runs_u r
         join public.production_jobs j on j.id = r.run_id
         join lateral (select authorized_budget from public.cost_budget_authorizations ca
                        where ca.run_id = r.run_id and ca.decision in ('ADMIN_APPROVED', 'AUTO_WITHIN_POLICY')
                        order by ca.created_at desc, ca.id desc limit 1) a on true
         left join lateral (select sum(amount) as spent from public.generation_cost_events ge
                             where ge.run_id = r.run_id and ge.billing_account = 'cursia') sp on true
        where ${RUN_LIVE_SQL('j')}
          and r.run_id is distinct from $2::uuid`,
      [userId, excludeRunId],
    );
    return dec(r?.t);
  }

  /** Lo retenido por UN run (max(autorización vigente − gastado, 0)), sin mirar si está vivo. */
  async runHeld(runId: string, q: Runner = this.dataSource): Promise<{ authorized: string | null; spent: string; held: string }> {
    if (!UUID_RE.test(String(runId))) return { authorized: null, spent: normalizeDecimal(0), held: normalizeDecimal(0) };
    const [r] = await q.query(
      `select (select authorized_budget::text from public.cost_budget_authorizations ca
                where ca.run_id = $1::uuid and ca.decision in ('ADMIN_APPROVED', 'AUTO_WITHIN_POLICY')
                order by ca.created_at desc, ca.id desc limit 1) as authorized,
              (select coalesce(sum(amount), 0)::text from public.generation_cost_events ge
                where ge.run_id = $1::uuid and ge.billing_account = 'cursia') as spent`,
      [runId],
    );
    const authorized = r?.authorized ?? null;
    const spent = dec(r?.spent);
    const diff = authorized === null ? normalizeDecimal(0) : subDec(authorized, spent);
    return { authorized, spent, held: cmpDec(diff, 0) > 0 ? diff : normalizeDecimal(0) };
  }

  /** available(U, mes actual) [sin un run]. */
  async availableNow(userId: string, q: Runner = this.dataSource, excludeRunId: string | null = null): Promise<{
    month: string; limit: string; spent: string; held: string; available: string; assigned: boolean;
  }> {
    const month = currentMonth();
    const { limit, assigned } = await this.limitOf(userId, month, q);
    const spent = await this.spentOf(userId, month, q);
    const held = await this.heldOf(userId, q, excludeRunId);
    return { month, limit, spent, held, available: subDec(subDec(limit, spent), held), assigned };
  }

  async pendingRequests(userId: string, q: Runner = this.dataSource): Promise<number> {
    const [r] = await q.query(
      `select count(*)::int as n from public.budget_requests where user_id = $1::uuid and status = 'pending' and expires_at > now()`,
      [userId],
    );
    return Number(r?.n ?? 0);
  }

  /** UserBudgetSummary del mes (02 §A). held solo en el mes actual (un mes pasado/futuro no tiene runs vivos que cargar). */
  async summary(userId: string, month: string = currentMonth(), q: Runner = this.dataSource): Promise<UserBudgetSummary> {
    if (!UUID_RE.test(userId)) throw new Error('userId inválido');
    const { limit, assigned } = await this.limitOf(userId, month, q);
    const spent = await this.spentOf(userId, month, q);
    const held = month === currentMonth() ? await this.heldOf(userId, q) : normalizeDecimal(0);
    return {
      month, limitUsd: limit, spentUsd: spent, heldUsd: held, availableUsd: subDec(subDec(limit, spent), held),
      pendingRequests: await this.pendingRequests(userId, q), mode: budgetsMode(), assigned,
    };
  }

  /**
   * Para `GET /me/context` (A, por token opcional): resumen del mes actual, o null si el flag está en off o las tablas
   * todavía no existen (nunca rompe el contexto).
   */
  async summaryForMeContext(userId: string): Promise<UserBudgetSummary | null> {
    if (budgetsMode() === 'off' || !UUID_RE.test(userId)) return null;
    try {
      return await this.summary(userId);
    } catch {
      return null;
    }
  }

  /**
   * Contrato de A (access.tokens.ts, R75_BUDGET_READ_SERVICE): resumen del mes para `/me/context` y `GET /admin/users`.
   * null con el flag en off o sin las tablas (A muestra `budget: null`).
   */
  async getSummary(userId: string, month?: string): Promise<UserBudgetSummary | null> {
    if (budgetsMode() === 'off' || !UUID_RE.test(String(userId))) return null;
    try {
      return await this.summary(String(userId).toLowerCase(), month ?? currentMonth());
    } catch {
      return null;
    }
  }

  async getSummaries(userIds: string[], month?: string): Promise<Record<string, UserBudgetSummary>> {
    const out: Record<string, UserBudgetSummary> = {};
    for (const id of [...new Set((userIds || []).slice(0, 200))]) {
      const s = await this.getSummary(id, month);
      if (s) out[id] = s;
    }
    return out;
  }

  async reservations(filter: { userId?: string; status?: string; month?: string; runId?: string; limit?: number }, q: Runner = this.dataSource): Promise<ReservationView[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.userId) { params.push(filter.userId); where.push(`br.user_id = $${params.length}::uuid`); }
    if (filter.status) { params.push(filter.status); where.push(`br.status = $${params.length}`); }
    if (filter.month) { params.push(monthDate(filter.month)); where.push(`br.period_month = $${params.length}::date`); }
    if (filter.runId) { params.push(filter.runId); where.push(`br.run_id = $${params.length}::uuid`); }
    params.push(Math.max(1, Math.min(500, filter.limit ?? 200)));
    const rows = await q.query(
      `select br.*, br.amount_usd::text as amount_usd_t,
              (case when j.id is not null and ${RUN_LIVE_SQL('j')} and br.kind = 'start' then
                 greatest(coalesce(a.authorized_budget, 0) - coalesce(sp.spent, 0), 0) else 0 end)::text as live_held
         from public.budget_reservations br
         left join public.production_jobs j on j.id = br.run_id
         left join lateral (select authorized_budget from public.cost_budget_authorizations ca
                             where ca.run_id = br.run_id and ca.decision in ('ADMIN_APPROVED', 'AUTO_WITHIN_POLICY')
                             order by ca.created_at desc, ca.id desc limit 1) a on true
         left join lateral (select sum(amount) as spent from public.generation_cost_events ge
                             where ge.run_id = br.run_id and ge.billing_account = 'cursia') sp on true
        ${where.length ? `where ${where.join(' and ')}` : ''}
        order by br.created_at desc, br.id desc
        limit $${params.length}`,
      params,
    );
    return rows.map(reservationView);
  }

  async versions(userId: string, q: Runner = this.dataSource): Promise<BudgetVersionView[]> {
    const rows = await q.query(
      `select id, kind, effective_month, amount_usd::text as amount_usd, version, reason, created_by, created_at, source_request_id
         from public.user_budgets where user_id = $1::uuid and institution_id is null
        order by effective_month desc, kind, version desc, created_at desc limit 200`,
      [userId],
    );
    return rows.map((r: any) => ({
      id: r.id, kind: r.kind, effectiveMonth: monthOfDate(dateOnly(r.effective_month)), amountUsd: dec(r.amount_usd), version: Number(r.version),
      reason: r.reason, createdBy: String(r.created_by), createdAt: iso(r.created_at) as string, sourceRequestId: r.source_request_id ?? null,
    }));
  }
}

/** `date` de pg → 'YYYY-MM-DD' estable (node-postgres lo entrega como Date local o como string). */
export function dateOnly(v: unknown): string {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}T00:00:00Z`;
  }
  return `${String(v).slice(0, 10)}T00:00:00Z`;
}

export function reservationView(r: any): ReservationView {
  return {
    id: r.id, userId: String(r.user_id), institutionId: r.institution_id ?? null, courseId: Number(r.course_id), runId: String(r.run_id),
    kind: r.kind, amountUsd: dec(r.amount_usd_t ?? r.amount_usd), liveHeldUsd: dec(r.live_held ?? 0), status: r.status,
    periodMonth: monthOfDate(dateOnly(r.period_month)), createdAt: iso(r.created_at) as string,
  };
}
