import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditLogService } from '../access/audit-log.service';
import { addDec } from '../finops/decimal';
import { FinopsLedgerService } from '../finops/finops-ledger.service';
import { BudgetAccessService } from './budget-access.service';
import { BudgetReadService } from './budget-read.service';
import { BudgetReservationService } from './budget-reservation.service';
import { emailsOf } from './budget-admin.service';
import {
  BudgetActor, BudgetAuditWriter, Runner, UUID_RE, assertOnlyKeys, assertUuid, budgetRequestNotPending,
  currentMonth, dec, iso, parseAmount, parseReason, pgCode,
} from './budget-common';

export type BudgetRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
export const BUDGET_REQUEST_STATUSES: readonly BudgetRequestStatus[] = ['pending', 'approved', 'rejected', 'cancelled', 'expired'];

export interface BudgetRequestView {
  id: string; userId: string; email: string | null; institutionId: string | null; courseId: number | null; courseTitle: string | null;
  runId: string | null; estimateId: string | null; amountUsd: string; reason: string; status: BudgetRequestStatus;
  decidedBy: string | null; decidedAt: string | null; decisionNote: string | null; approvedAmountUsd: string | null;
  createdAt: string; expiresAt: string;
}

const SELECT = `select r.*, r.amount_usd::text as amount_t, r.approved_amount_usd::text as approved_t, c.title as course_title
                  from public.budget_requests r left join public.courses c on c.id = r.course_id`;

/**
 * r75 (Agente C) — «Solicitar autorización» (01 §5.6). El usuario pide; SOLO el SuperAdmin aprueba o rechaza (v1).
 * Aprobar = `month_adjustment` del mes actual por el monto aprobado (+ opcionalmente la ampliación de la autorización del
 * run), en UNA tx con el lock del usuario y la auditoría. Aprobar NO arranca la generación (D-21). Vencen a los 7 días.
 */
@Injectable()
export class BudgetRequestsService {
  private readonly audit: BudgetAuditWriter;

  constructor(
    private readonly dataSource: DataSource,
    private readonly read: BudgetReadService,
    private readonly reservations: BudgetReservationService,
    private readonly access: BudgetAccessService,
    audit: AuditLogService,
    @Optional() private readonly ledger?: FinopsLedgerService,
  ) {
    this.audit = new BudgetAuditWriter(audit);
  }

  /** Vence las pendientes viejas (idempotente; corre antes de leer o decidir). */
  async expireStale(q: Runner = this.dataSource): Promise<void> {
    await q.query(`update public.budget_requests set status = 'expired' where status = 'pending' and expires_at <= now()`);
  }

  async create(actor: BudgetActor, body: unknown): Promise<BudgetRequestView> {
    const b = assertOnlyKeys(body, ['courseId', 'runId', 'estimateId', 'amountUsd', 'reason']);
    const courseId = Number(b.courseId);
    if (!Number.isInteger(courseId) || courseId < 1) throw new BadRequestException({ code: 'invalid_input', message: 'courseId es obligatorio (entero)' });
    const runId = b.runId === undefined || b.runId === null ? null : assertUuid(b.runId, 'runId');
    const estimateId = b.estimateId === undefined || b.estimateId === null ? null : assertUuid(b.estimateId, 'estimateId');
    const amount = parseAmount(b.amountUsd, 'amountUsd');
    const reason = parseReason(b.reason) as string;
    // 02 §D: P(generations.start) sobre el curso; con runId, P(generations.retry).
    const course = await this.access.courseAccess(actor, courseId, runId ? 'generations.retry' : 'generations.start');
    if (runId) {
      const [run] = await this.dataSource.query(`select 1 from public.production_jobs where id = $1::uuid and course_id::text = $2::text`, [runId, String(courseId)]);
      if (!run) throw new NotFoundException({ code: 'run_not_found', message: 'El run no es de este curso' });
    }
    if (estimateId) {
      const [est] = await this.dataSource.query(`select 1 from public.cost_estimates where id::text = $1 and course_id = $2`, [estimateId, courseId]);
      if (!est) throw new NotFoundException({ code: 'estimate_not_found', message: 'El estimado no es de este curso' });
    }
    await this.expireStale();
    return this.dataSource.transaction(async (m) => {
      let row: any;
      try {
        await m.query('savepoint r75_req');
        [row] = await m.query(
          `insert into public.budget_requests (user_id, institution_id, course_id, run_id, estimate_id, amount_usd, reason)
           values ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7) returning id`,
          [actor.id, course.institutionId, courseId, runId, estimateId, amount, reason],
        );
        await m.query('release savepoint r75_req');
      } catch (err) {
        if (pgCode(err) === '23505') {
          await m.query('rollback to savepoint r75_req');
          throw new ConflictException({ code: 'budget_request_duplicate', message: 'Ya tienes una solicitud pendiente para este curso.' });
        }
        throw err;
      }
      await this.audit.record(m, {
        actorId: actor.id, actorEmail: actor.email, actorIsSuperadmin: actor.superAdmin, action: 'request.create', targetType: 'budget_request',
        targetId: row.id, institutionId: course.institutionId, before: null, after: { courseId, runId, estimateId, amountUsd: amount, reason },
      });
      return (await this.views(m, `where r.id = $1`, [row.id]))[0];
    });
  }

  async listMine(actor: BudgetActor, status?: unknown): Promise<BudgetRequestView[]> {
    await this.expireStale();
    const st = parseStatus(status);
    return st ? this.views(this.dataSource, `where r.user_id = $1::uuid and r.status = $2 order by r.created_at desc limit 200`, [actor.id, st])
      : this.views(this.dataSource, `where r.user_id = $1::uuid order by r.created_at desc limit 200`, [actor.id]);
  }

  async cancel(actor: BudgetActor, id: string): Promise<BudgetRequestView> {
    const rid = assertUuid(id, 'id');
    await this.expireStale();
    return this.dataSource.transaction(async (m) => {
      const [r] = await m.query(`select * from public.budget_requests where id = $1::uuid for update`, [rid]);
      // Solo el solicitante (ni el SA cancela por otro: el SA rechaza). Ajena → 404 (no revela que existe).
      if (!r || String(r.user_id).toLowerCase() !== actor.id) throw new NotFoundException({ code: 'budget_request_not_found', message: 'Solicitud no encontrada' });
      if (r.status !== 'pending') throw budgetRequestNotPending(r.status);
      await m.query(`update public.budget_requests set status = 'cancelled', decided_by = $2::uuid, decided_at = now() where id = $1::uuid`, [rid, actor.id]);
      await this.audit.record(m, {
        actorId: actor.id, actorEmail: actor.email, actorIsSuperadmin: actor.superAdmin, action: 'request.cancel', targetType: 'budget_request',
        targetId: rid, institutionId: r.institution_id ?? null, before: { status: 'pending' }, after: { status: 'cancelled' },
      });
      return (await this.views(m, `where r.id = $1`, [rid]))[0];
    });
  }

  async adminList(query: { status?: unknown; institutionId?: unknown }): Promise<BudgetRequestView[]> {
    await this.expireStale();
    const st = parseStatus(query.status === undefined ? 'pending' : query.status);
    const where: string[] = [];
    const params: unknown[] = [];
    if (st) { params.push(st); where.push(`r.status = $${params.length}`); }
    if (query.institutionId !== undefined && query.institutionId !== '') { params.push(assertUuid(query.institutionId, 'institutionId')); where.push(`r.institution_id = $${params.length}::uuid`); }
    return this.views(this.dataSource, `${where.length ? `where ${where.join(' and ')}` : ''} order by r.created_at desc limit 500`, params);
  }

  async approve(actor: BudgetActor, id: string, body: unknown): Promise<BudgetRequestView> {
    assertSuperAdminActor(actor);
    const rid = assertUuid(id, 'id');
    const b = assertOnlyKeys(body, ['approvedAmountUsd', 'note', 'extendRunAuthorization']);
    const approved = parseAmount(b.approvedAmountUsd, 'approvedAmountUsd');
    const note = parseReason(b.note, 'note', false);
    if (b.extendRunAuthorization !== undefined && typeof b.extendRunAuthorization !== 'boolean') {
      throw new BadRequestException({ code: 'invalid_input', message: 'extendRunAuthorization debe ser boolean' });
    }
    await this.expireStale();
    return this.dataSource.transaction(async (m) => {
      const [r] = await m.query(`select *, amount_usd::text as amount_t from public.budget_requests where id = $1::uuid for update`, [rid]);
      if (!r) throw new NotFoundException({ code: 'budget_request_not_found', message: 'Solicitud no encontrada' });
      if (r.status === 'expired') throw new ConflictException({ code: 'budget_request_expired', message: 'La solicitud venció (7 días).' });
      if (r.status !== 'pending') throw budgetRequestNotPending(r.status);
      const userId = String(r.user_id).toLowerCase();
      // Mismo orden de locks que el arranque: mes → usuario (→ run-cap dentro de authorize).
      await this.reservations.lockForRun(m, userId);
      const month = currentMonth();
      const before = await this.read.availableNow(userId, m);
      const adjustmentId = await this.reservations.insertAdjustment(m, {
        userId, month, amount: approved, reason: `budget_request:${rid}${note ? `: ${note}` : ''}`.slice(0, 1000), createdBy: actor.id, sourceRequestId: rid,
      });
      let runAuthorization: { id: string; authorizedBudget: string } | null = null;
      if (b.extendRunAuthorization === true) {
        if (!r.run_id) throw new BadRequestException({ code: 'invalid_input', message: 'extendRunAuthorization exige una solicitud con runId' });
        if (!this.ledger) throw new ConflictException({ code: 'finops_unavailable', message: 'FinOps no disponible' });
        const held = await this.read.runHeld(String(r.run_id), m);
        const newBudget = addDec(held.authorized ?? held.spent, approved);
        const auth = await this.ledger.authorize({
          runId: String(r.run_id), courseId: Number(r.course_id), estimateId: null, authorizedBudget: newBudget,
          decision: 'ADMIN_APPROVED', approvedBy: actor.email || actor.id, reason: `budget_request:${rid}`,
        }, m);
        await this.reservations.reserveRun(m, {
          runId: String(r.run_id), courseId: Number(r.course_id), payerUserId: (await this.reservations.payerOfRun(m, String(r.run_id))) ?? userId,
          kind: 'extension', authorizationId: auth.id, authorizedBudget: newBudget, previousAuthorizedBudget: held.authorized,
        });
        runAuthorization = { id: auth.id, authorizedBudget: newBudget };
      }
      await m.query(
        `update public.budget_requests set status = 'approved', decided_by = $2::uuid, decided_at = now(), decision_note = $3,
                approved_amount_usd = $4, resulting_budget_id = $5::uuid where id = $1::uuid`,
        [rid, actor.id, note, approved, adjustmentId],
      );
      await this.audit.record(m, {
        actorId: actor.id, actorEmail: actor.email, actorIsSuperadmin: true, action: 'budget.adjust', targetType: 'user_budget', targetId: userId,
        institutionId: r.institution_id ?? null, before: { month, limitUsd: before.limit, availableUsd: before.available },
        after: { month, adjustmentId, amountUsd: approved, source: 'budget_request', requestId: rid },
      });
      await this.audit.record(m, {
        actorId: actor.id, actorEmail: actor.email, actorIsSuperadmin: true, action: 'request.approve', targetType: 'budget_request', targetId: rid,
        institutionId: r.institution_id ?? null, before: { status: 'pending', amountUsd: dec(r.amount_t) },
        after: { status: 'approved', approvedAmountUsd: approved, adjustmentId, note, runAuthorization },
      });
      return (await this.views(m, `where r.id = $1`, [rid]))[0];
    });
  }

  async reject(actor: BudgetActor, id: string, body: unknown): Promise<BudgetRequestView> {
    assertSuperAdminActor(actor);
    const rid = assertUuid(id, 'id');
    const b = assertOnlyKeys(body, ['note']);
    const note = parseReason(b.note, 'note') as string;
    await this.expireStale();
    return this.dataSource.transaction(async (m) => {
      const [r] = await m.query(`select * from public.budget_requests where id = $1::uuid for update`, [rid]);
      if (!r) throw new NotFoundException({ code: 'budget_request_not_found', message: 'Solicitud no encontrada' });
      if (r.status === 'expired') throw new ConflictException({ code: 'budget_request_expired', message: 'La solicitud venció (7 días).' });
      if (r.status !== 'pending') throw budgetRequestNotPending(r.status);
      await m.query(`update public.budget_requests set status = 'rejected', decided_by = $2::uuid, decided_at = now(), decision_note = $3 where id = $1::uuid`, [rid, actor.id, note]);
      await this.audit.record(m, {
        actorId: actor.id, actorEmail: actor.email, actorIsSuperadmin: true, action: 'request.reject', targetType: 'budget_request', targetId: rid,
        institutionId: r.institution_id ?? null, before: { status: 'pending' }, after: { status: 'rejected', note },
      });
      return (await this.views(m, `where r.id = $1`, [rid]))[0];
    });
  }

  private async views(q: Runner, tail: string, params: unknown[]): Promise<BudgetRequestView[]> {
    const rows = await q.query(`${SELECT} ${tail}`, params);
    const emails = await emailsOf(this.dataSource, rows.map((r: any) => String(r.user_id)));
    return rows.map((r: any) => ({
      id: r.id, userId: String(r.user_id), email: emails.get(String(r.user_id)) ?? null, institutionId: r.institution_id ?? null,
      courseId: r.course_id === null ? null : Number(r.course_id), courseTitle: r.course_title ?? null, runId: r.run_id ?? null,
      estimateId: r.estimate_id ?? null, amountUsd: dec(r.amount_t), reason: r.reason, status: r.status,
      decidedBy: r.decided_by ?? null, decidedAt: iso(r.decided_at), decisionNote: r.decision_note ?? null,
      approvedAmountUsd: r.approved_t === null || r.approved_t === undefined ? null : dec(r.approved_t),
      createdAt: iso(r.created_at) as string, expiresAt: iso(r.expires_at) as string,
    }));
  }
}

function parseStatus(v: unknown): BudgetRequestStatus | null {
  if (v === undefined || v === null || v === '' || v === 'all') return null;
  if (typeof v !== 'string' || !(BUDGET_REQUEST_STATUSES as readonly string[]).includes(v)) {
    throw new BadRequestException({ code: 'invalid_input', message: `status inválido: ${BUDGET_REQUEST_STATUSES.join(' | ')}` });
  }
  return v as BudgetRequestStatus;
}

function assertSuperAdminActor(actor: BudgetActor): void {
  if (!actor || !actor.superAdmin || !UUID_RE.test(String(actor.id))) {
    throw new ForbiddenException({ code: 'permission_denied', permission: 'budgets.manage', message: 'Solo el SuperAdmin decide solicitudes.' });
  }
}
