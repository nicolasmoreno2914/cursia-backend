import { ForbiddenException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditLogService } from '../access/audit-log.service';
import { SuspensionsService } from '../access/suspensions.service';
import { PlatformControlsService } from '../access/platform-controls.service';
import { FinopsError } from '../finops/errors';
import { cmpDec, DecimalLike, normalizeDecimal, subDec } from '../finops/decimal';
import { MONTH_CAP_LOCK, FinopsBudgetService } from '../finops/finops-budget.service';
import { FinopsLedgerService } from '../finops/finops-ledger.service';
import { userBudgetConflict } from '../finops/finops.controller';
import {
  CURSIA_USER_BUDGETS_ENV, parseUserBudgetsMode, ReserveRunInput, USER_BUDGET_EXHAUSTED, USER_BUDGET_INSUFFICIENT,
  USER_BUDGET_LOCK_PREFIX, UserBudgetGate, UserBudgetsMode, userBudgetsMode,
} from '../finops/user-budget-gate';
import { BudgetReadService, RUN_LIVE_SQL } from './budget-read.service';
import { BudgetAuditWriter, Runner, UUID_RE, dec, monthDate } from './budget-common';

const TABLE_CACHE_MS = 60_000;
/** Reconciliador periódico (01 §5.3): cada 10 min. `CURSIA_BUDGET_RECONCILER=off` lo apaga en un proceso. */
export const BUDGET_RECONCILER_INTERVAL_MS = 10 * 60_000;

/**
 * r75 (Agente C) — reserva transaccional del presupuesto por usuario (01 §5.2) + liberación y reconciliación (§5.3).
 *
 * Es el `UserBudgetGate` que FinOps llama dentro de SUS transacciones (bindRun, upgrade, autorización del SA, reserva
 * del proxy sin run). Algoritmo de arranque (dentro de la tx de resolveOrCreateRun → finopsBindRun → bindRun):
 *   1. pg_advisory_xact_lock(COURSE_RUNS_LOCK_NS, courseId)          (insertRun, ya existía)
 *   2. pg_advisory_xact_lock(hashtext(MONTH_CAP_LOCK))               (ahora SIEMPRE, también en AUTO)       ← lockForRun
 *   3. pg_advisory_xact_lock(hashtext('finops:user-budget:' || U))   (nuevo; orden fijo curso → mes → usuario) ← lockForRun
 *   4. bindRun escribe la autorización del run (A = authorized_budget)
 *   5. available(U) recalculado DENTRO de la tx (sin caché), excluyendo este run                            ← reserveRun
 *   6. A > available → FinopsError USER_BUDGET_INSUFFICIENT → 409 y ROLLBACK de toda la tx (ni run ni autorización)
 *   7. insert budget_reservations(kind='start', amount=A, institution = courses.institution_id, period = mes UTC)
 *   8. production_jobs.input_payload.startedBy = U; courses.generated_by/generated_at (si las columnas de A existen)
 * Prueba de concurrencia: todo arranque de U pasa por el lock 3 ⇒ los pasos 5–7 de dos arranques de U nunca se
 * intercalan; el segundo ve el run del primero como vivo (held) o su gasto (spent), así que Σ reservado ≤ disponible.
 */
@Injectable()
export class BudgetReservationService implements UserBudgetGate, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('UserBudgets');
  private readonly audit: BudgetAuditWriter;
  private tables: { at: number; memberships: boolean; generatedBy: boolean } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly read: BudgetReadService,
    audit: AuditLogService,
    @Optional() private readonly finopsBudget?: FinopsBudgetService,
    @Optional() private readonly ledger?: FinopsLedgerService,
    /** A: suspensiones de usuario y congelación de plataforma (01 §7), chequeadas en cada arranque junto al presupuesto. */
    @Optional() private readonly suspensions?: SuspensionsService,
    @Optional() private readonly platform?: PlatformControlsService,
  ) {
    this.audit = new BudgetAuditWriter(audit);
  }

  /** Un valor inválido del flag impide arrancar (nunca se apaga en silencio un control de gasto por un typo). */
  onModuleInit(): void {
    if (parseUserBudgetsMode(process.env[CURSIA_USER_BUDGETS_ENV]) === null) {
      throw new Error(`${CURSIA_USER_BUDGETS_ENV} inválido (${process.env[CURSIA_USER_BUDGETS_ENV]}): off | shadow | enforce`);
    }
    this.finopsBudget?.setUserBudgetGate(this);
    // B puede registrar su propio chequeo (allow-list + suspensión); si ya lo hizo, no se pisa.
    if (this.finopsBudget && this.suspensions && !this.finopsBudget.getSubjectSpendAccess()) this.finopsBudget.setSubjectSpendAccess(this);
    this.ledger?.setUserBudgetGate(this);
  }

  onApplicationBootstrap(): void {
    if (userBudgetsMode() === 'off' || /^(off|false|0)$/i.test(String(process.env.CURSIA_BUDGET_RECONCILER ?? ''))) return;
    this.timer = setInterval(() => {
      this.releaseTerminalRuns().catch((err) => this.logger.warn(`reconciliador de reservas: ${(err as Error).message}`));
    }, BUDGET_RECONCILER_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async assertMayStart(runner: Runner, payerUserId: string): Promise<void> {
    if (this.platform && (await this.platform.isGenerationFrozen(runner))) {
      throw new ForbiddenException({ code: 'platform_generation_frozen', message: 'Las generaciones nuevas están pausadas temporalmente. No se creó nada.' });
    }
    if (this.suspensions && UUID_RE.test(String(payerUserId))) {
      const active = await this.suspensions.getActive(String(payerUserId), runner);
      if (active.account) throw new ForbiddenException({ code: 'account_suspended', message: 'La cuenta que paga esta generación está suspendida. No se creó nada.' });
      if (active.generation) throw new ForbiddenException({ code: 'generation_suspended', message: 'Las generaciones de esta cuenta están suspendidas. No se creó nada.' });
    }
  }

  /**
   * Para la integración de runs (commit C2): reanudar / reintentar un run existente carga al iniciador (D-20); si su cuenta
   * o sus generaciones están suspendidas, o la plataforma congelada, nadie (otro miembro incluido) puede reanudarlo.
   */
  async assertPayerMaySpend(runner: Runner, runId: string): Promise<void> {
    const payer = await this.payerOfRun(runner, runId);
    if (payer) await this.assertMayStart(runner, payer);
  }

  /** SubjectSpendAccess (02 §E.5) para el proxy: cuenta suspendida → 403. Generación suspendida / congelación NO cortan
   *  las llamadas de runs en curso (D-22); esas se aplican en los arranques y reanudaciones. */
  async denialFor(subjectUserId: string): Promise<null | { code: 'account_suspended'; status: 403; message: string }> {
    if (!this.suspensions || !UUID_RE.test(String(subjectUserId))) return null;
    const active = await this.suspensions.getActive(String(subjectUserId));
    return active.account ? { code: 'account_suspended', status: 403, message: 'Tu cuenta está suspendida: no se hacen llamadas nuevas.' } : null;
  }

  async availability(runner: Runner, payerUserId: string, excludeRunId: string | null = null): Promise<{ month: string; available: string; assigned: boolean }> {
    const now = await this.read.availableNow(String(payerUserId), runner, excludeRunId);
    return { month: now.month, available: now.available, assigned: now.assigned };
  }

  mode(): UserBudgetsMode {
    return userBudgetsMode();
  }

  async lockForRun(runner: Runner, payerUserId: string): Promise<void> {
    // Sin `set local lock_timeout`: corre dentro de transacciones ajenas (runs.service) y no les cambia la espera.
    await runner.query(`select pg_advisory_xact_lock(hashtext($1))`, [MONTH_CAP_LOCK]);
    await this.lockUser(runner, payerUserId);
  }

  async lockUser(runner: Runner, userId: string): Promise<void> {
    await runner.query(`select pg_advisory_xact_lock(hashtext($1))`, [USER_BUDGET_LOCK_PREFIX + String(userId).toLowerCase()]);
  }

  async payerOfRun(runner: Runner, runId: string): Promise<string | null> {
    if (!UUID_RE.test(String(runId))) return null;
    // r78: los callers lo usan con CUALQUIER modo (reanudar, reintentar, reabrir, upgrade de video). Producción no tiene la
    // migración r75-budgets: nombrar budget_reservations sin la tabla daba 42P01 → 500 al reanudar/reintentar un run.
    // Sin la tabla no hay reservas: paga el iniciador (startedBy) o el dueño, igual que la rama coalesce de abajo.
    const reservation = (await this.reservationsTablePresent(runner))
      ? `(select br.user_id::text from public.budget_reservations br where br.run_id = j.id and br.kind = 'start'
                  order by br.created_at limit 1),`
      : '';
    const [r] = await runner.query(
      `select coalesce(
                ${reservation}
                nullif(j.input_payload->>'startedBy', ''),
                j.owner_id::text) as payer
         from public.production_jobs j where j.id = $1::uuid`,
      [runId],
    );
    return r?.payer ? String(r.payer) : null;
  }

  /** ¿Existe budget_reservations (migración r75-budgets)? Por la conexión del caller (nunca otra del pool); caché 60 s / 10 s. */
  private reservationsCache: { at: number; ok: boolean } | null = null;
  async reservationsTablePresent(runner: Runner): Promise<boolean> {
    const c = this.reservationsCache;
    if (c && Date.now() - c.at < (c.ok ? TABLE_CACHE_MS : 10_000)) return c.ok;
    const [r] = await runner.query(`select to_regclass('public.budget_reservations') is not null as ok`);
    this.reservationsCache = { at: Date.now(), ok: r?.ok === true };
    return this.reservationsCache.ok;
  }

  async reserveRun(runner: Runner, input: ReserveRunInput): Promise<{ reservationId: string | null; shadowInsufficient: boolean }> {
    const mode = this.mode();
    if (mode === 'off') return { reservationId: null, shadowInsufficient: false };
    const payer = String(input.payerUserId);
    if (input.kind === 'start') {
      // Reintento / doble llamada sobre el mismo run → la reserva existente (nunca doble reserva).
      const [existing] = await runner.query(`select id from public.budget_reservations where run_id = $1::uuid and kind = 'start'`, [input.runId]);
      if (existing) return { reservationId: existing.id, shadowInsufficient: false };
    }
    const authorized = normalizeDecimal(input.authorizedBudget, 'authorizedBudget');
    const prev = input.previousAuthorizedBudget === null || input.previousAuthorizedBudget === undefined ? null : normalizeDecimal(input.previousAuthorizedBudget);
    const { spent: runSpent } = await this.read.runHeld(input.runId, runner);
    const pos = (v: string) => (cmpDec(v, 0) > 0 ? v : normalizeDecimal(0));
    const requiredHeld = pos(subDec(authorized, runSpent)); // lo que este run va a retener con la autorización nueva
    const now = await this.read.availableNow(payer, runner, input.runId);
    let shadowInsufficient = false;
    let adjustmentId: string | null = null;
    if (cmpDec(requiredHeld, now.available) > 0) {
      if (input.extendUserBudget) {
        // SA (02 §E.4) / solicitud aprobada: ajuste del mes por la diferencia, auditado, en ESTA tx.
        const diff = subDec(requiredHeld, now.available);
        adjustmentId = await this.insertAdjustment(runner, {
          userId: payer, month: now.month, amount: diff, reason: `run_authorization:${input.runId}: ${input.extendUserBudget.reason}`.slice(0, 1000),
          createdBy: input.extendUserBudget.actorId, sourceRequestId: null,
        });
        await this.audit.record(runner, {
          actorId: input.extendUserBudget.actorId, actorEmail: input.extendUserBudget.actorEmail, actorIsSuperadmin: true,
          action: 'budget.adjust', targetType: 'user_budget', targetId: payer, institutionId: null,
          before: { month: now.month, limitUsd: now.limit, availableUsd: now.available },
          after: { month: now.month, adjustmentId, amountUsd: diff, source: 'run_authorization', runId: input.runId, authorizedBudget: authorized },
        });
      } else if (mode === 'enforce') {
        // HttpException (409) directa: corre dentro de la tx de runs.service, que propaga las HttpException tal cual
        // (la tx se revierte entera). Mismo cuerpo que finopsErrorToHttp(USER_BUDGET_INSUFFICIENT).
        throw userBudgetConflict(new FinopsError(USER_BUDGET_INSUFFICIENT,
          `tu presupuesto disponible del mes (USD ${Number(now.available).toFixed(2)}) no alcanza para esta generación (USD ${Number(requiredHeld).toFixed(2)}); no se creó nada`,
          { requiredUsd: requiredHeld, availableUsd: now.available, payerUserId: payer, notAssigned: !now.assigned, runId: input.kind === 'start' ? null : input.runId }));
      } else {
        shadowInsufficient = true;
        this.logger.warn(`[shadow] presupuesto insuficiente (no se aplica): usuario ${payer} run ${input.runId} requiere ${requiredHeld} y tiene ${now.available}`);
        await this.audit.recordBestEffort(runner, {
          actorId: payer, actorEmail: null, actorIsSuperadmin: false, action: 'budget.shadow_insufficient', targetType: 'run', targetId: input.runId,
          institutionId: null, before: null, after: { kind: input.kind, requiredUsd: requiredHeld, availableUsd: now.available },
        });
      }
    }
    const [course] = await runner.query(`select institution_id::text as institution_id from public.courses where id = $1`, [input.courseId]);
    const amount = input.kind === 'start' ? authorized : pos(subDec(authorized, prev ?? 0));
    const [row] = await runner.query(
      `insert into public.budget_reservations (user_id, institution_id, course_id, run_id, kind, amount_usd, authorization_id, period_month)
       values ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::uuid, $8::date) returning id`,
      [payer, course?.institution_id ?? null, input.courseId, input.runId, input.kind, amount, input.authorizationId, monthDate(now.month)],
    );
    if (input.kind !== 'start') {
      // El run vuelve a retener (reanudación / ampliación): sus reservas cerradas vuelven a 'active' (el reconciliador
      // las cierra de nuevo al terminar). El dinero nunca depende de este estado: held sale de la fórmula.
      await runner.query(
        `update public.budget_reservations set status = 'active', released_at = null, release_reason = null, settled_usd = null
          where run_id = $1::uuid and status <> 'active'`,
        [input.runId],
      );
    }
    if (input.kind === 'start' || input.kind === 'reopen') {
      await runner.query(
        `update public.production_jobs set input_payload = coalesce(input_payload, '{}'::jsonb) || jsonb_build_object('startedBy', $2::text)
          where id = $1::uuid and coalesce(input_payload->>'startedBy', '') = ''`,
        [input.runId, payer],
      );
      if ((await this.tableInfo(runner)).generatedBy) {
        await runner.query(`update public.courses set generated_by = $2, generated_at = now() where id = $1`, [input.courseId, payer]);
      }
    }
    return { reservationId: row.id, shadowInsufficient };
  }

  async guardUnattributedSpend(runner: Runner, input: { userId: string; amount: DecimalLike; idempotencyKey: string }): Promise<void> {
    const mode = this.mode();
    if (mode === 'off') return;
    // Reintento idempotente de la misma reserva → ya se evaluó (y se insertó) la primera vez.
    const [existing] = await runner.query(`select 1 from public.generation_cost_events where idempotency_key = $1`, [input.idempotencyKey]);
    if (existing) return;
    const userId = String(input.userId);
    await this.lockUser(runner, userId);
    const amount = normalizeDecimal(input.amount, 'amount');
    if (cmpDec(amount, 0) <= 0) return;
    const now = UUID_RE.test(userId)
      ? await this.read.availableNow(userId, runner)
      : { available: normalizeDecimal(0), assigned: false } as { available: string; assigned: boolean };
    if (cmpDec(amount, now.available) <= 0) return;
    if (mode === 'enforce') {
      throw new FinopsError(USER_BUDGET_EXHAUSTED,
        `tu presupuesto disponible del mes (USD ${Number(now.available).toFixed(4)}) no alcanza para esta llamada (USD ${Number(amount).toFixed(4)}): no se hace`,
        { requiredUsd: amount, availableUsd: now.available, payerUserId: userId, notAssigned: !now.assigned });
    }
    this.logger.warn(`[shadow] llamada sin run por encima del disponible (no se aplica): usuario ${userId} ${amount} > ${now.available}`);
  }

  async institutionForCharge(runner: Runner, input: { ownerId: string; courseId: number | null; runId: string | null }): Promise<string | null> {
    if (input.courseId !== null && input.courseId !== undefined) {
      const [c] = await runner.query(`select institution_id::text as i from public.courses where id = $1`, [input.courseId]);
      if (c?.i) return String(c.i);
    }
    if (input.runId) {
      const [r] = await runner.query(
        `select institution_id::text as i from public.budget_reservations where run_id = $1::uuid and kind = 'start' order by created_at limit 1`, [input.runId]);
      if (r?.i) return String(r.i);
    }
    if ((input.courseId === null || input.courseId === undefined) && !input.runId && (await this.tableInfo(runner)).memberships) {
      const [m] = await runner.query(
        `select min(institution_id::text) as i from public.institution_memberships
          where user_id::text = $1 and status = 'active' having count(*) = 1`, [String(input.ownerId)]);
      if (m?.i) return String(m.i);
    }
    return null;
  }

  /**
   * D-20 (para la integración de runs.service, commit C2): reabrir / reintentar un run que ya no retenía (terminal) vuelve
   * a retener max(autorizado − gastado, 0) del iniciador: tiene que entrar en su disponible. Dentro de la tx del caller.
   */
  async assertRunReopenFits(runner: Runner, runId: string): Promise<void> {
    if (this.mode() === 'off') return;
    const payer = await this.payerOfRun(runner, runId);
    if (!payer) return;
    await this.lockUser(runner, payer);
    const h = await this.read.runHeld(runId, runner);
    const now = await this.read.availableNow(payer, runner, runId);
    if (cmpDec(h.held, now.available) <= 0) return;
    if (this.mode() === 'enforce') {
      throw userBudgetConflict(new FinopsError(USER_BUDGET_INSUFFICIENT,
        `el presupuesto disponible del iniciador (USD ${Number(now.available).toFixed(2)}) no alcanza para reanudar (USD ${Number(h.held).toFixed(2)})`,
        { requiredUsd: h.held, availableUsd: now.available, payerUserId: payer, notAssigned: !now.assigned, runId }));
    }
    this.logger.warn(`[shadow] reanudación por encima del disponible (no se aplica): run ${runId} usuario ${payer}`);
  }

  /** Inserta un `month_adjustment` (versión siguiente). El caller tiene el lock del usuario y audita. */
  async insertAdjustment(runner: Runner, a: { userId: string; month: string; amount: string; reason: string; createdBy: string; sourceRequestId: string | null }): Promise<string> {
    const [v] = await runner.query(
      `select coalesce(max(version), 0) + 1 as v from public.user_budgets
        where user_id = $1::uuid and institution_id is null and kind = 'month_adjustment' and effective_month = $2::date`,
      [a.userId, monthDate(a.month)],
    );
    const [row] = await runner.query(
      `insert into public.user_budgets (user_id, kind, effective_month, amount_usd, version, reason, created_by, source_request_id)
       values ($1::uuid, 'month_adjustment', $2::date, $3, $4, $5, $6::uuid, $7::uuid) returning id`,
      [a.userId, monthDate(a.month), a.amount, Number(v.v), a.reason, a.createdBy, a.sourceRequestId],
    );
    return row.id;
  }

  /**
   * Liberación (01 §5.3): reservas 'active' de runs terminales (completed/failed/cancelled/preview) → 'settled' si el run
   * gastó algo (foto del gasto en settled_usd) o 'released' si no. Un run pausado / needs_reconnect sigue reteniendo.
   * Idempotente (varios procesos pueden barrer a la vez). `runId` = solo ese run (run-completion).
   */
  async releaseTerminalRuns(runId: string | null = null, runner: Runner = this.dataSource): Promise<{ released: number; settled: number }> {
    if (this.mode() === 'off') return { released: 0, settled: 0 };
    const rows = await runner.query(
      `with t as (
         select br.id, coalesce(sp.spent, 0) as spent, coalesce(j.worker_status, j.status, 'missing') as st
           from public.budget_reservations br
           left join public.production_jobs j on j.id = br.run_id
           left join lateral (select sum(amount) as spent from public.generation_cost_events ge
                               where ge.run_id = br.run_id and ge.billing_account = 'cursia') sp on true
          where br.status = 'active' and ($1::uuid is null or br.run_id = $1::uuid)
            and (j.id is null or not (${RUN_LIVE_SQL('j')})))
       update public.budget_reservations br
          set status = case when t.spent > 0 then 'settled' else 'released' end,
              released_at = now(), release_reason = ('run_' || t.st), settled_usd = t.spent
         from t where br.id = t.id
       returning br.status`,
      [runId],
    );
    const list: Array<{ status: string }> = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows;
    return { released: list.filter((r) => r.status === 'released').length, settled: list.filter((r) => r.status === 'settled').length };
  }

  /**
   * Reconciliación (01 §5.3) del mes: primero libera lo terminal; luego, por usuario, el gasto ACTUAL del ledger de sus
   * runs liquidados del mes vs la foto `settled_usd` de sus reservas. La diferencia es informativa (el dinero siempre es
   * el ledger): cargos tardíos tras la liquidación, conciliaciones manuales. `monthSpentUsd` = spent(U,M) completo.
   */
  async reconcile(month: string, actor: { id: string; email: string | null } | null): Promise<{
    month: string; released: number; settled: number;
    users: Array<{ userId: string; ledgerSpentUsd: string; settledReservationsUsd: string; driftUsd: string; monthSpentUsd: string }>;
  }> {
    const rel = await this.releaseTerminalRuns();
    const rows = await this.dataSource.query(
      `select br.user_id::text as user_id,
              coalesce(sum(br.settled_usd), 0)::text as settled,
              coalesce(sum((select coalesce(sum(amount), 0) from public.generation_cost_events ge
                             where ge.run_id = br.run_id and ge.billing_account = 'cursia')), 0)::text as ledger
         from public.budget_reservations br
        where br.kind = 'start' and br.status = 'settled' and br.period_month = $1::date
        group by br.user_id order by br.user_id`,
      [monthDate(month)],
    );
    const users = [];
    for (const r of rows) {
      const drift = subDec(r.ledger, r.settled);
      users.push({ userId: r.user_id, ledgerSpentUsd: dec(r.ledger), settledReservationsUsd: dec(r.settled), driftUsd: drift,
        monthSpentUsd: await this.read.spentOf(r.user_id, month) });
      if (cmpDec(drift, 0) !== 0) {
        this.logger.warn(`finops.reconcile_drift: usuario ${r.user_id} mes ${month}: ledger ${r.ledger} vs liquidado ${r.settled}`);
        if (actor) {
          await this.dataSource.transaction((m) => this.audit.recordBestEffort(m, {
            actorId: actor.id, actorEmail: actor.email, actorIsSuperadmin: true, action: 'finops.reconcile_drift', targetType: 'user_budget',
            targetId: r.user_id, institutionId: null, before: { settledReservationsUsd: dec(r.settled) }, after: { ledgerSpentUsd: dec(r.ledger), driftUsd: drift, month },
          }));
        }
      }
    }
    return { month, released: rel.released, settled: rel.settled, users };
  }

  private async tableInfo(runner: Runner): Promise<{ memberships: boolean; generatedBy: boolean }> {
    if (this.tables && Date.now() - this.tables.at < TABLE_CACHE_MS) return this.tables;
    const [r] = await runner.query(
      `select to_regclass('public.institution_memberships') is not null as m,
              exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'courses' and column_name = 'generated_by') as g`,
    );
    this.tables = { at: Date.now(), memberships: !!r?.m, generatedBy: !!r?.g };
    return this.tables;
  }
}
