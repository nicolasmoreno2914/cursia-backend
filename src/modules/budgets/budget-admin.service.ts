import { BadRequestException, ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditLogService } from '../access/audit-log.service';
import { addDec, cmpDec } from '../finops/decimal';
import { BudgetReadService, BudgetVersionView, UserBudgetSummary } from './budget-read.service';
import { BudgetReservationService } from './budget-reservation.service';
import {
  BudgetActor, BudgetAuditWriter, Runner, UUID_RE, assertOnlyKeys, assertUuid, currentMonth,
  monthDate, parseAmount, parseMonth, parseReason,
} from './budget-common';

export type UserBudgetDetail = UserBudgetSummary & { userId: string; versions: BudgetVersionView[] };

/**
 * r75 (Agente C) — escrituras del SuperAdmin sobre presupuestos (02 §D). Append-only (versión nueva), bajo el lock del
 * usuario (mismo que la reserva: un cambio nunca se intercala con un arranque) y auditadas en la MISMA tx.
 * Ningún usuario normal llega acá: el controller exige SupabaseJwtGuard + SuperAdminGuard, y el servicio vuelve a
 * exigir `actor.superAdmin` (defensa en profundidad contra un cableado futuro equivocado).
 */
@Injectable()
export class BudgetAdminService {
  private readonly audit: BudgetAuditWriter;

  constructor(
    private readonly dataSource: DataSource,
    private readonly read: BudgetReadService,
    private readonly reservations: BudgetReservationService,
    audit: AuditLogService,
  ) {
    this.audit = new BudgetAuditWriter(audit);
  }

  async detail(userId: string, month: string = currentMonth(), q: Runner = this.dataSource): Promise<UserBudgetDetail> {
    const id = assertUuid(userId, 'userId');
    return { ...(await this.read.summary(id, month, q)), userId: id, versions: await this.read.versions(id, q) };
  }

  /** PUT /admin/users/:userId/budget — versión nueva `recurring` desde `effectiveMonth` (≥ mes actual). */
  async setRecurring(actor: BudgetActor, userId: string, body: unknown): Promise<UserBudgetDetail> {
    assertSuperAdmin(actor);
    const id = assertUuid(userId, 'userId');
    const b = assertOnlyKeys(body, ['monthlyAmountUsd', 'effectiveMonth', 'reason']);
    const amount = parseAmount(b.monthlyAmountUsd, 'monthlyAmountUsd', { allowZero: true });
    const month = parseMonth(b.effectiveMonth, false);
    assertNotPastMonth(month);
    const reason = parseReason(b.reason) as string;
    return this.dataSource.transaction(async (m) => {
      await this.reservations.lockUser(m, id);
      const before = await this.read.limitOf(id, month, m);
      const [v] = await m.query(
        `select coalesce(max(version), 0) + 1 as v from public.user_budgets
          where user_id = $1::uuid and institution_id is null and kind = 'recurring' and effective_month = $2::date`,
        [id, monthDate(month)],
      );
      const [row] = await m.query(
        `insert into public.user_budgets (user_id, kind, effective_month, amount_usd, version, reason, created_by)
         values ($1::uuid, 'recurring', $2::date, $3, $4, $5, $6::uuid) returning id`,
        [id, monthDate(month), amount, Number(v.v), reason, actor.id],
      );
      await this.audit.record(m, {
        actorId: actor.id, actorEmail: actor.email, actorIsSuperadmin: true, action: 'budget.set', targetType: 'user_budget', targetId: id,
        institutionId: null, before: { effectiveMonth: month, limitUsd: before.limit },
        after: { effectiveMonth: month, budgetId: row.id, monthlyAmountUsd: amount, version: Number(v.v), reason },
      });
      return this.detail(id, currentMonth(), m);
    });
  }

  /** POST /admin/users/:userId/budget-adjustments — ajuste (±) SOLO de ese mes; el límite del mes no queda negativo. */
  async adjust(actor: BudgetActor, userId: string, body: unknown): Promise<UserBudgetDetail> {
    assertSuperAdmin(actor);
    const id = assertUuid(userId, 'userId');
    const b = assertOnlyKeys(body, ['month', 'amountUsd', 'reason']);
    const month = parseMonth(b.month, false);
    assertNotPastMonth(month);
    const amount = parseAmount(b.amountUsd, 'amountUsd', { allowNegative: true });
    const reason = parseReason(b.reason) as string;
    return this.dataSource.transaction(async (m) => {
      await this.reservations.lockUser(m, id);
      const before = await this.read.limitOf(id, month, m);
      if (cmpDec(addDec(before.limit, amount), 0) < 0) {
        throw new BadRequestException({ code: 'invalid_amount', message: `el ajuste dejaría el presupuesto del mes en negativo (límite USD ${before.limit})` });
      }
      const adjustmentId = await this.reservations.insertAdjustment(m, { userId: id, month, amount, reason, createdBy: actor.id, sourceRequestId: null });
      await this.audit.record(m, {
        actorId: actor.id, actorEmail: actor.email, actorIsSuperadmin: true, action: 'budget.adjust', targetType: 'user_budget', targetId: id,
        institutionId: null, before: { month, limitUsd: before.limit }, after: { month, adjustmentId, amountUsd: amount, limitUsd: addDec(before.limit, amount), reason },
      });
      return this.detail(id, month, m);
    });
  }

  /** GET /admin/budgets — usuarios con presupuesto, reservas, solicitudes o fila en la allow-list (si tiene user_id). */
  async list(query: { month?: unknown; q?: unknown; page?: unknown }): Promise<{ items: Array<UserBudgetSummary & { userId: string; email: string | null }>; total: number }> {
    const month = parseMonth(query.month);
    const page = query.page === undefined || query.page === '' ? 1 : Number(query.page);
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw new BadRequestException({ code: 'invalid_input', message: 'page: entero ≥ 1' });
    const text = typeof query.q === 'string' ? query.q.trim().toLowerCase().slice(0, 200) : '';
    const pageSize = 50;
    const ids = await this.candidateUserIds();
    const emails = await emailsOf(this.dataSource, ids);
    const filtered = ids.filter((id) => !text || id.includes(text) || (emails.get(id) ?? '').toLowerCase().includes(text)).sort((a, b) =>
      (emails.get(a) ?? a).localeCompare(emails.get(b) ?? b));
    const slice = filtered.slice((page - 1) * pageSize, page * pageSize);
    const items = [];
    for (const id of slice) items.push({ ...(await this.read.summary(id, month)), userId: id, email: emails.get(id) ?? null });
    return { items, total: filtered.length };
  }

  private async candidateUserIds(): Promise<string[]> {
    const rows = await this.dataSource.query(
      `select user_id::text as id from public.user_budgets
       union select user_id::text from public.budget_reservations
       union select user_id::text from public.budget_requests`,
    );
    const set = new Set<string>(rows.map((r: any) => String(r.id).toLowerCase()));
    try {
      const au = await this.dataSource.query(`select user_id::text as id from public.authorized_users where user_id is not null`);
      for (const r of au) set.add(String(r.id).toLowerCase());
    } catch { /* allow-list sin user_id (antes de la migración de A) */ }
    return [...set].filter((id) => UUID_RE.test(id));
  }
}

function assertSuperAdmin(actor: BudgetActor): void {
  if (!actor || !actor.superAdmin || !UUID_RE.test(String(actor.id))) {
    // Nunca debería pasar (el controller ya exige SuperAdminGuard): un usuario no modifica presupuestos.
    throw new ForbiddenException({ code: 'permission_denied', permission: 'budgets.manage', message: 'Solo el SuperAdmin modifica presupuestos.' });
  }
}

/** Un presupuesto no se cambia hacia atrás (los meses cerrados quedan como se gastaron). */
function assertNotPastMonth(month: string): void {
  if (month < currentMonth()) throw new BadRequestException({ code: 'month_invalid', message: 'no se puede modificar el presupuesto de un mes pasado' });
}

/**
 * Emails de usuarios (best effort, nunca falla): auth.users (si el rol del backend lo puede leer) → allow-list con
 * user_id → courses.owner_email.
 */
export async function emailsOf(q: Runner, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const valid = [...new Set(ids.filter((i) => UUID_RE.test(i)).map((i) => i.toLowerCase()))];
  if (!valid.length) return out;
  const tryQuery = async (sql: string) => {
    try {
      for (const r of await q.query(sql, [valid])) if (r.email && !out.has(String(r.id))) out.set(String(r.id), String(r.email));
    } catch { /* tabla/columna ausente o sin permisos */ }
  };
  await tryQuery(`select id::text as id, email from auth.users where id::text = any($1::text[])`);
  if (out.size < valid.length) await tryQuery(`select user_id::text as id, email from public.authorized_users where user_id::text = any($1::text[])`);
  if (out.size < valid.length) await tryQuery(`select distinct on (owner_id) owner_id::text as id, owner_email as email from public.courses where owner_id::text = any($1::text[]) and owner_email is not null`);
  return out;
}
