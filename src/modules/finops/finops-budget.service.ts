import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinopsError } from './errors';
import { addDec, cmpDec, normalizeDecimal, DecimalLike } from './decimal';
import { PricingCatalogRow, priceUsage } from './pricing';
import { EstimateItem, EstimateResult, RetryPolicy, estimateCost } from './estimator';
import { usageModelPriorsV1 } from './usage-model';
import { BudgetPolicy, RuntimeGuardResult, SpentSoFar, runtimeGuard } from './budget';
import { FinopsLedgerService } from './finops-ledger.service';
import { BREAKER_MIN_SLACK_USD, BREAKER_SLACK_SHARE, decideRunSpend, RunSpendDecision } from './run-spend-guard';
import {
  RunBudgetDecision,
  RunManifestItem,
  RunSpendMode,
  RunSpendModes,
  WORKER_PAID_ITEM_TYPES,
  decideRunBudget,
  estimateItemsForRun,
  paidProviderOfItemType,
  paidRealProviders,
} from './run-budget';
import { APPROVAL_TTL_HOURS, NORMAL_APPROVAL_REASON_PREFIX } from './normal-approval';

/** Advisory lock global (por transacción) que serializa las aprobaciones del flujo normal frente al tope mensual. */
export const MONTH_CAP_LOCK = 'finops-normal-approval-month-cap';

type Runner = { query: (sql: string, params?: any[]) => Promise<any> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reintentos pagados máximos por operación que asume el estimador (config; default 1 = un reintento dirigido). */
export const FINOPS_ESTIMATE_MAX_RETRIES_ENV = 'FINOPS_ESTIMATE_MAX_RETRIES';

export function readEstimateRetryPolicy(env: NodeJS.ProcessEnv = process.env): RetryPolicy {
  const raw = env[FINOPS_ESTIMATE_MAX_RETRIES_ENV];
  if (raw === undefined || raw === '') return { maxRetries: 1 };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw new FinopsError('INVALID_INPUT', `${FINOPS_ESTIMATE_MAX_RETRIES_ENV} inválido (${raw}): entero 1..10`);
  }
  return { maxRetries: n };
}

export interface StartBudgetEvaluation extends RunBudgetDecision {
  estimate: EstimateResult;
  estimateItems: EstimateItem[];
  policyId: string | null;
}

/**
 * V2.1 RF-b — presupuestos sobre el ledger de RF-a: estimado del run desde el
 * Manifest, política vigente, aprobaciones administrativas (append-only),
 * vinculación aprobación→run y el runtime guard antes de cada llamada pagada.
 */
/** reason del guard cuando el run está pausado (= worker_status 'paused'): el worker devuelve la parte, no la bloquea. */
export const RUN_PAUSED_GUARD_REASON = 'run_paused';

@Injectable()
export class FinopsBudgetService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: FinopsLedgerService,
  ) {}

  async catalog(runner: Runner = this.dataSource): Promise<PricingCatalogRow[]> {
    return runner.query(
      `select id, provider, service, product_or_model, meter, unit_size::text as unit_size, unit_price::text as unit_price,
              currency, pricing_version, effective_from, effective_to, source, source_ref, verified
         from public.pricing_catalog`,
    );
  }

  /** Estimado (precios vigentes ahora) de una lista de items. */
  async estimate(items: EstimateItem[], opts: { retryPolicy?: RetryPolicy; runner?: Runner } = {}): Promise<EstimateResult> {
    return estimateCost({
      items,
      catalog: await this.catalog(opts.runner),
      usageModel: usageModelPriorsV1(),
      retryPolicy: opts.retryPolicy ?? readEstimateRetryPolicy(),
      pricingAsOf: new Date(),
    });
  }

  /** Política vigente: la versión más alta de course > owner > global. null si no hay ninguna. */
  async policyFor(courseId: number, ownerId: string, runner: Runner = this.dataSource): Promise<(BudgetPolicy & { id: string }) | null> {
    const rows = await runner.query(
      `select id, scope, version, limits, require_human_approval_for_real_spend, on_exceed
         from public.cost_budget_policies
        where (scope = 'course' and scope_id = $1) or (scope = 'owner' and scope_id = $2) or scope = 'global'
        order by case scope when 'course' then 0 when 'owner' then 1 else 2 end, version desc, created_at desc
        limit 1`,
      [String(courseId), ownerId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      version: Number(r.version),
      limits: r.limits || {},
      requireHumanApprovalForRealSpend: r.require_human_approval_for_real_spend,
      onExceed: r.on_exceed,
    };
  }

  async spentSoFar(courseId: number, runner: Runner = this.dataSource): Promise<SpentSoFar> {
    const rows = await runner.query(
      // RF-b fix M4: el gasto con la clave del usuario (user_key) no consume el presupuesto de Cursia.
      `select provider, coalesce(sum(amount),0)::text as total from public.generation_cost_events
        where course_id = $1 and billing_account <> 'user_key' group by provider order by provider`,
      [courseId],
    );
    const byProvider: Record<string, string> = {};
    let course = normalizeDecimal(0);
    for (const r of rows) {
      byProvider[r.provider] = r.total;
      course = addDec(course, r.total);
    }
    return { course, byProvider };
  }

  /** Estimado + decisión de un run nuevo (o de un run B desde un plan de invalidación). */
  async evaluateStart(a: {
    courseId: number;
    ownerId: string;
    mode: RunSpendMode | RunSpendModes;
    items: readonly RunManifestItem[];
    actions?: Readonly<Record<string, string>> | null;
  }): Promise<StartBudgetEvaluation> {
    const estimateItems = estimateItemsForRun(a.items, a.mode, a.actions ?? null);
    const [estimate, policy, spent] = await Promise.all([
      this.estimate(estimateItems),
      this.policyFor(a.courseId, a.ownerId),
      this.spentSoFar(a.courseId),
    ]);
    const decision = decideRunBudget({ estimate, policy, spentSoFar: spent, paidRealProviders: paidRealProviders(estimateItems, a.mode) });
    return { ...decision, estimate, estimateItems, policyId: policy?.id ?? null };
  }

  /** Guarda un estimado rechazado (sin run) para que un admin lo autorice por su id. */
  async recordEstimate(a: {
    scope: 'run' | 'regeneration' | 'course_preview';
    ownerId: string;
    courseId: number;
    manifestId: number | null;
    runId?: string | null;
    invalidationPlanSha?: string | null;
    estimate: EstimateResult;
  }, runner: Runner = this.dataSource): Promise<{ id: string }> {
    return this.ledger.createEstimate({
      scope: a.scope,
      ownerId: a.ownerId,
      courseId: a.courseId,
      manifestId: a.manifestId,
      runId: a.runId ?? null,
      invalidationPlanSha: a.invalidationPlanSha ?? null,
      estimate: a.estimate,
      createdBy: 'runs.service',
    }, runner);
  }

  /**
   * Comprometido del mes calendario en curso (todos los cursos) para el
   * límite mensual del flujo normal de aprobación:
   *   gasto liquidado del mes (sin la clave del usuario, igual que spentSoFar)
   * + presupuesto todavía NO gastado de runs vivos (última autorización de cada
   *   run no terminado, menos lo que ese run ya gastó; nunca negativo).
   * Así dos aprobaciones (de cursos distintos, o con un run anterior aún en
   * vuelo) no pueden repartirse dos veces el mismo remanente del mes. El caller
   * serializa las aprobaciones con MONTH_CAP_LOCK.
   */
  async monthCommitted(runner: Runner = this.dataSource): Promise<{ spent: string; outstanding: string; total: string }> {
    const [s] = await runner.query(
      `select coalesce(sum(amount),0)::text as total from public.generation_cost_events
        where billing_account <> 'user_key' and created_at >= date_trunc('month', now())`,
    );
    const [o] = await runner.query(
      `select coalesce(sum(greatest(a.authorized_budget - coalesce(sp.spent, 0), 0)),0)::text as total
         from (select distinct on (run_id) run_id, authorized_budget from public.cost_budget_authorizations
                where run_id is not null and decision in ('ADMIN_APPROVED','AUTO_WITHIN_POLICY')
                order by run_id, created_at desc, id desc) a
         join public.production_jobs j on j.id = a.run_id
         left join (select run_id, sum(amount) as spent from public.generation_cost_events
                     where run_id is not null and billing_account <> 'user_key' group by run_id) sp on sp.run_id = a.run_id
        where coalesce(j.worker_status, '') not in ('completed', 'preview', 'failed', 'cancelled', 'cancelling')
          and coalesce(j.status, '') not in ('cancelled', 'cancelling')`,
    );
    const spent = normalizeDecimal(s?.total ?? 0);
    const outstanding = normalizeDecimal(o?.total ?? 0);
    return { spent, outstanding, total: addDec(spent, outstanding) };
  }

  /**
   * Flujo normal (UI): guarda el estimado que vio el usuario y UNA aprobación
   * ADMIN_APPROVED por `amount` (ya validado contra la política por el caller),
   * sin run todavía — el run que se crea a continuación la consume (bindRun).
   * Debe correr dentro de la tx del caller, con su advisory lock por curso.
   */
  async recordNormalApproval(runner: Runner, a: {
    courseId: number;
    ownerId: string;
    manifestId: number;
    estimate: EstimateResult;
    amount: DecimalLike;
    policyId: string | null;
    approvedBy: string;
    fingerprint: string;
  }): Promise<{ estimateId: string; authorizationId: string }> {
    if (typeof a.approvedBy !== 'string' || !a.approvedBy.trim()) throw new FinopsError('INVALID_INPUT', 'approvedBy es obligatorio');
    const amount = normalizeDecimal(a.amount, 'amount');
    if (cmpDec(amount, a.estimate.totals.expected) < 0) {
      throw new FinopsError('INVALID_INPUT', `el monto aprobado (${amount}) no cubre el esperado (${a.estimate.totals.expected})`);
    }
    const est = await this.recordEstimate({
      scope: 'run', ownerId: a.ownerId, courseId: a.courseId, manifestId: a.manifestId, runId: null, estimate: a.estimate,
    }, runner);
    const auth = await this.ledger.authorize({
      runId: null, courseId: a.courseId, estimateId: est.id, authorizedBudget: amount, policyId: a.policyId,
      decision: 'ADMIN_APPROVED', approvedBy: a.approvedBy.trim(), reason: `${NORMAL_APPROVAL_REASON_PREFIX}:${a.fingerprint}`,
    }, runner);
    return { estimateId: est.id, authorizationId: auth.id };
  }

  /**
   * EV6 T5 B2 — «Generar videos reales»: dentro de la tx del upgrade (course lock + MONTH_CAP_LOCK
   * ya tomados por el caller) guarda el estimado del upgrade (scope regeneration, con run_id) y una
   * autorización ADMIN_APPROVED del run por su nuevo presupuesto TOTAL = gasto real hasta hoy +
   * monto aprobado del upgrade (el runtime guard de los workers la usa: nunca se gasta más que eso).
   */
  async recordRunUpgradeApproval(runner: Runner, a: {
    courseId: number;
    ownerId: string;
    manifestId: number;
    runId: string;
    estimate: EstimateResult;
    amount: DecimalLike;
    runActual: DecimalLike;
    policyId: string | null;
    approvedBy: string;
    fingerprint: string;
  }): Promise<{ estimateId: string; authorizationId: string; authorizedRunBudget: string }> {
    if (typeof a.approvedBy !== 'string' || !a.approvedBy.trim()) throw new FinopsError('INVALID_INPUT', 'approvedBy es obligatorio');
    if (typeof a.runId !== 'string' || !UUID_RE.test(a.runId)) throw new FinopsError('INVALID_INPUT', 'runId debe ser UUID');
    const amount = normalizeDecimal(a.amount, 'amount');
    if (cmpDec(amount, a.estimate.totals.expected) < 0) {
      throw new FinopsError('INVALID_INPUT', `el monto aprobado (${amount}) no cubre el esperado (${a.estimate.totals.expected})`);
    }
    const total = addDec(normalizeDecimal(a.runActual, 'runActual'), amount);
    const est = await this.recordEstimate({
      scope: 'regeneration', ownerId: a.ownerId, courseId: a.courseId, manifestId: a.manifestId, runId: a.runId, estimate: a.estimate,
    }, runner);
    const auth = await this.ledger.authorize({
      runId: a.runId, courseId: a.courseId, estimateId: est.id, authorizedBudget: total, policyId: a.policyId,
      decision: 'ADMIN_APPROVED', approvedBy: a.approvedBy.trim(), reason: `video_upgrade:${a.fingerprint}`,
    }, runner);
    return { estimateId: est.id, authorizationId: auth.id, authorizedRunBudget: total };
  }

  /**
   * Aprobación ADMIN_APPROVED de este curso, para un estimado del MISMO
   * Manifest, todavía no vinculada a ningún run y que cubre `minBudget`.
   * Vence a las APPROVAL_TTL_HOURS: una aprobación vieja no se reutiliza.
   */
  async findUnconsumedApproval(courseId: number, manifestId: number, minBudget: DecimalLike, runner: Runner = this.dataSource): Promise<any | null> {
    const [row] = await runner.query(
      `select a.id, a.estimate_id, a.authorized_budget::text as authorized_budget, a.approved_by, a.policy_id, a.currency
         from public.cost_budget_authorizations a
         join public.cost_estimates e on e.id = a.estimate_id
        where a.course_id = $1 and a.decision = 'ADMIN_APPROVED' and a.run_id is null and e.manifest_id = $2
          and a.authorized_budget >= $3::numeric
          and a.created_at > now() - make_interval(hours => ${APPROVAL_TTL_HOURS})
          and not exists (select 1 from public.cost_budget_authorizations b
                           where b.estimate_id = a.estimate_id and b.run_id is not null)
        order by a.created_at desc, a.id desc
        limit 1`,
      [courseId, manifestId, normalizeDecimal(minBudget, 'minBudget')],
    );
    return row ?? null;
  }

  /**
   * Dentro de la tx que crea el run: estimado del run (con run_id) + fila de
   * autorización del run. Con aprobación → ADMIN_APPROVED vinculada (misma
   * estimate_id aprobada: eso la marca como consumida); sin ella → AUTO con
   * authorized_budget = max del estimado.
   */
  async bindRun(runner: Runner, a: {
    runId: string;
    courseId: number;
    ownerId: string;
    manifestId: number;
    evaluation: StartBudgetEvaluation;
    approval: { id: string; estimate_id: string; authorized_budget: string; approved_by: string; policy_id: string | null } | null;
    invalidationPlanSha?: string | null;
  }): Promise<{ estimateId: string; authorizationId: string }> {
    const est = await this.recordEstimate({
      scope: 'run', ownerId: a.ownerId, courseId: a.courseId, manifestId: a.manifestId, runId: a.runId,
      invalidationPlanSha: a.invalidationPlanSha ?? null, estimate: a.evaluation.estimate,
    }, runner);
    const auth = a.approval
      ? await this.ledger.authorize({
          runId: a.runId, courseId: a.courseId, estimateId: a.approval.estimate_id, authorizedBudget: a.approval.authorized_budget,
          policyId: a.approval.policy_id ?? a.evaluation.policyId, decision: 'ADMIN_APPROVED', approvedBy: a.approval.approved_by,
          reason: `bound_from:${a.approval.id}`,
        }, runner)
      : await this.ledger.authorize({
          runId: a.runId, courseId: a.courseId, estimateId: est.id, authorizedBudget: a.evaluation.estimate.totals.max,
          policyId: a.evaluation.policyId, decision: 'AUTO_WITHIN_POLICY', reason: `auto_within_policy:${a.evaluation.reasons.join('|')}`,
        }, runner);
    return { estimateId: est.id, authorizationId: auth.id };
  }

  /**
   * RF-b fix M9: aprobación humana directa del presupuesto TOTAL de un run
   * (p.ej. runs reales creados antes de RF-b, sin estimado con run_id).
   */
  async adminAuthorizeRun(a: { courseId: number; runId: string; authorizedBudget: DecimalLike; approvedBy: string; reason?: string | null }): Promise<any> {
    if (typeof a.runId !== 'string' || !UUID_RE.test(a.runId)) throw new FinopsError('INVALID_INPUT', 'runId debe ser UUID');
    if (typeof a.approvedBy !== 'string' || !a.approvedBy.trim()) throw new FinopsError('INVALID_INPUT', 'approvedBy es obligatorio');
    const budget = normalizeDecimal(a.authorizedBudget, 'authorizedBudget');
    if (cmpDec(budget, 0) <= 0) throw new FinopsError('INVALID_INPUT', 'authorizedBudget debe ser > 0');
    const [run] = await this.dataSource.query(
      `select id, course_id from public.production_jobs where id = $1 and execution_mode = 'dynamic_generation'`,
      [a.runId],
    );
    if (!run) throw new FinopsError('ESTIMATE_NOT_FOUND', `no existe el run ${a.runId}`);
    if (Number(run.course_id) !== Number(a.courseId)) throw new FinopsError('INVALID_INPUT', `el run ${a.runId} no es del curso #${a.courseId}`);
    return this.ledger.authorize({
      runId: a.runId, courseId: a.courseId, estimateId: null, authorizedBudget: budget,
      decision: 'ADMIN_APPROVED', approvedBy: a.approvedBy.trim(), reason: a.reason ?? 'admin_approved_run',
    });
  }

  /** POST /finops/courses/:courseId/authorizations — aprobación humana de un estimado (append-only). */
  async adminAuthorize(a: { courseId: number; estimateId: string; authorizedBudget: DecimalLike; approvedBy: string; reason?: string | null }): Promise<any> {
    if (typeof a.estimateId !== 'string' || !UUID_RE.test(a.estimateId)) throw new FinopsError('INVALID_INPUT', 'estimateId debe ser UUID');
    if (typeof a.approvedBy !== 'string' || !a.approvedBy.trim()) throw new FinopsError('INVALID_INPUT', 'approvedBy es obligatorio');
    const budget = normalizeDecimal(a.authorizedBudget, 'authorizedBudget');
    if (cmpDec(budget, 0) <= 0) throw new FinopsError('INVALID_INPUT', 'authorizedBudget debe ser > 0');
    const [est] = await this.dataSource.query(
      `select id, course_id, run_id, manifest_id from public.cost_estimates where id = $1`,
      [a.estimateId],
    );
    if (!est) throw new FinopsError('ESTIMATE_NOT_FOUND', `no existe el estimado ${a.estimateId}`);
    if (Number(est.course_id) !== Number(a.courseId)) {
      throw new FinopsError('INVALID_INPUT', `el estimado ${a.estimateId} no es del curso #${a.courseId}`);
    }
    return this.ledger.authorize({
      runId: est.run_id ?? null,
      courseId: a.courseId,
      estimateId: a.estimateId,
      authorizedBudget: budget,
      decision: 'ADMIN_APPROVED',
      approvedBy: a.approvedBy.trim(),
      reason: a.reason ?? 'admin_approved',
    });
  }

  /** Pasamanos al ledger (costo evitado, historical actual first). */
  historicalByItemRun(itemRunIds: string[]) {
    return this.ledger.historicalByItemRun(itemRunIds);
  }

  recordAvoidance(input: Parameters<FinopsLedgerService['recordAvoidance']>[0]) {
    return this.ledger.recordAvoidance(input);
  }

  // ─── runtime guard (antes de cada llamada pagada) ─────────────────────────

  /**
   * RF-b fix I1: presupuesto para PROVEEDORES PAGADOS (Videogen/Gamma/TTS):
   * SOLO la última autorización ADMIN_APPROVED del run (una BLOCKED posterior la
   * revoca). AUTO_WITHIN_POLICY nunca cubre gasto real de proveedores (HD-V21-19).
   */
  async runPaidAuthorizedBudget(runId: string, runner: Runner = this.dataSource): Promise<string | null> {
    const [row] = await runner.query(
      `select decision, authorized_budget::text as authorized_budget from public.cost_budget_authorizations
        where run_id = $1 and decision in ('ADMIN_APPROVED', 'BLOCKED') order by created_at desc, id desc limit 1`,
      [runId],
    );
    if (!row || row.decision !== 'ADMIN_APPROVED') return null;
    return row.authorized_budget;
  }

  /** Última autorización vigente del run (AUTO/ADMIN_APPROVED); BLOCKED o ninguna → null. */
  async runAuthorizedBudget(runId: string, runner: Runner = this.dataSource): Promise<string | null> {
    const [row] = await runner.query(
      `select decision, authorized_budget::text as authorized_budget from public.cost_budget_authorizations
        where run_id = $1 order by created_at desc, id desc limit 1`,
      [runId],
    );
    if (!row || row.decision === 'BLOCKED') return null;
    return row.authorized_budget;
  }

  async runActual(runId: string, runner: Runner = this.dataSource): Promise<string> {
    const [row] = await runner.query(
      `select coalesce(sum(amount),0)::text as total from public.generation_cost_events
        where run_id = $1 and billing_account <> 'user_key'`,
      [runId],
    );
    return row.total;
  }

  /** r19 fix round 1 (I5): costo de UNA llamada concreta (uso estimado × catálogo vigente). Lanza si no se puede preciar. */
  async callCost(c: { provider: string; service: string; product: string; usage: Record<string, number> }, runner: Runner = this.dataSource): Promise<string> {
    const catalog = await this.catalog(runner);
    try {
      return priceUsage(c.usage, catalog, { provider: c.provider, service: c.service, product: c.product, asOf: new Date() }).amount;
    } catch {
      // r19 fix round 2: la llamada no tiene precio exacto en el catálogo (p. ej. un modelo/voz nuevo antes de
      // cargar su fila). NUNCA se vuelve al p90 del item entero (reintroducía el falso bloqueo de I5): se precia
      // de forma CONSERVADORA con la tarifa más cara del catálogo para cada medidor de ESTA llamada.
      return this.conservativeCallCost(c.usage, catalog);
    }
  }

  /**
   * Costo conservador de una llamada sin precio exacto: por medidor, la tarifa MÁS CARA vigente del catálogo
   * para ese medidor (cualquier proveedor/producto). Un medidor que no existe en el catálogo → CALL_UNPRICED
   * (el guard falla cerrado: el item queda bloqueado con un motivo claro, nunca se llama sin poder acotar el gasto).
   */
  conservativeCallCost(usage: Record<string, number>, catalog: PricingCatalogRow[]): string {
    const now = Date.now();
    const open = catalog.filter((r) => !r.effective_to || new Date(r.effective_to as any).getTime() > now);
    let total = normalizeDecimal(0);
    for (const meter of Object.keys(usage)) {
      let best: string | null = null;
      for (const r of open.filter((x) => x.meter === meter)) {
        try {
          const amt = priceUsage({ [meter]: usage[meter] }, [r], { provider: r.provider, service: r.service, product: r.product_or_model }).amount;
          if (best === null || cmpDec(amt, best) > 0) best = amt;
        } catch {
          /* fila no aplicable: se ignora */
        }
      }
      if (best === null) throw new FinopsError('CALL_UNPRICED', `no hay ninguna tarifa para el medidor ${meter}`);
      total = addDec(total, best);
    }
    return total;
  }

  /** Costo de UNA llamada pagada (p90, sin reintentos) de ese item type contra ese proveedor. */
  async singleCallCost(itemType: string, provider: string, runner: Runner = this.dataSource): Promise<string> {
    const est = await this.estimate([{ itemKey: `guard:${itemType}`, itemType }], { retryPolicy: { maxRetries: 0, retryRate: 0 }, runner });
    let max = normalizeDecimal(0);
    for (const l of est.lines) if (l.provider === provider) max = addDec(max, l.max);
    return max;
  }

  /** Reservas: otros items de worker pagado del run en `running` sin CHARGE de su proveedor todavía. */
  async reservedInFlight(runId: string, excludeItemRunId: string | null, runner: Runner = this.dataSource): Promise<string> {
    const rows: Array<{ id: string; type: string }> = await runner.query(
      `select g.id, g.type from public.generation_item_runs g
        where g.job_id = $1 and g.status = 'running' and g.type = any($2::text[])
          and ($3::uuid is null or g.id <> $3::uuid)
          and not exists (select 1 from public.generation_cost_events e
                           where e.item_run_id = g.id and e.event_kind = 'CHARGE' and e.provider <> 'youtube')`,
      [runId, WORKER_PAID_ITEM_TYPES, excludeItemRunId],
    );
    let total = normalizeDecimal(0);
    const cache = new Map<string, string>();
    for (const r of rows) {
      const provider = paidProviderOfItemType(r.type);
      if (!provider) continue;
      if (!cache.has(r.type)) cache.set(r.type, await this.singleCallCost(r.type, provider, runner));
      total = addDec(total, cache.get(r.type) as string);
    }
    return total;
  }

  /**
   * Antes de un envío pagado NUEVO: committed = actual(run) + reservas + next
   * <= authorized_budget del run. Sin autorización ⇒ BLOCK (fail closed).
   */
  async guardPaidSubmission(a: {
    runId: string;
    itemRunId: string;
    itemType: string;
    /**
     * V2.1 F2: proveedor de ESTA llamada cuando el item paga más de uno (audiobook_chapter:
     * el guion LLM server-side = 'anthropic', antes del TTS = 'openai'). Default: el
     * proveedor pagado del item type.
     */
    provider?: string;
    /**
     * r19 fix round 1 (I5): uso estimado de LA llamada que se va a hacer (p. ej. un segmento de TTS o un
     * bloque del guion). Con él, `next` es el costo de esa llamada con el catálogo vigente, no el p90 del
     * item ENTERO (un audiolibro hace ~15 llamadas por capítulo: reservar el capítulo en cada una bloqueaba
     * en falso un run que entra en su presupuesto). Sin él (o si no se puede preciar), el comportamiento previo.
     */
    nextCall?: { provider: string; service: string; product: string; usage: Record<string, number> } | null;
  }): Promise<RuntimeGuardResult & { authorizedBudget: string | null }> {
    const itemProvider = paidProviderOfItemType(a.itemType);
    if (!itemProvider) throw new FinopsError('INVALID_INPUT', `guardPaidSubmission: ${a.itemType} no es un item de proveedor pagado`);
    // Piloto #1209: un run PAUSADO por el usuario no envía trabajo pagado NUEVO, aunque un worker ya tuviera la
    // parte reclamada antes de la pausa (lo ya enviado sí se sigue y se persiste). El worker la devuelve a la cola.
    const [job] = await this.dataSource.query(`select worker_status from public.production_jobs where id = $1`, [a.runId]);
    if (job && job.worker_status === 'paused') {
      return { allow: false, decision: 'BLOCK', committed: '0', remaining: null, reason: RUN_PAUSED_GUARD_REASON, authorizedBudget: null };
    }
    const provider = a.provider ?? itemProvider;
    const [authorizedBudget, actualSoFar, reservedInFlight, next] = await Promise.all([
      this.runPaidAuthorizedBudget(a.runId),
      this.runActual(a.runId),
      this.reservedInFlight(a.runId, a.itemRunId),
      // Fix round 2: una llamada sin precio exacto se acota de forma conservadora (callCost); si ni eso se puede,
      // null → el guard falla cerrado con 'call_unpriced' (nunca el p90 del item entero).
      a.nextCall ? this.callCost(a.nextCall).catch(() => null) : this.singleCallCost(a.itemType, provider),
    ]);
    if (next === null) {
      return { allow: false, decision: 'BLOCK', committed: addDec(actualSoFar, reservedInFlight), remaining: null, reason: 'call_unpriced', authorizedBudget } as RuntimeGuardResult & { authorizedBudget: string | null };
    }
    const base = runtimeGuard({ authorizedBudget, actualSoFar, reservedInFlight, next });
    if (!base.allow) return { ...base, authorizedBudget };
    // Loop Cost Efficiency: presupuesto de recuperación de ESTA parte + disyuntor del run (ver run-spend-guard.ts).
    const spend = await this.guardRunSpend({ runId: a.runId, itemRunId: a.itemRunId, nextCost: Number(next), authorizedBudget: null });
    const d = spend.decision;
    if (d.allow) return { ...base, authorizedBudget };
    if (d.reason === 'circuit_breaker') {
      // El run quedó pausado por el disyuntor: el worker devuelve la parte (como cualquier pausa).
      return { allow: false, decision: 'BLOCK', committed: base.committed, remaining: base.remaining, reason: RUN_PAUSED_GUARD_REASON, authorizedBudget };
    }
    return { allow: false, decision: 'BLOCK', committed: base.committed, remaining: base.remaining, reason: ITEM_RECOVERY_BUDGET_REASON, authorizedBudget, detail: 'detail' in d ? d.detail : '' } as RuntimeGuardResult & { authorizedBudget: string | null };
  }

  // ─── Loop Cost Efficiency + Reliability (tras #1209) ─────────────────────────────────────────────

  /** Costo esperado / máximo estimado por item_key, del estimado vigente del run (cache corto por run). */
  private readonly runEstimateCache = new Map<string, { at: number; byKey: Map<string, { expected: number; max: number }>; total: number | null }>();

  async runItemEstimates(runId: string): Promise<{ byKey: Map<string, { expected: number; max: number }>; total: number | null }> {
    const hit = this.runEstimateCache.get(runId);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    // Estimado del run (el más reciente) + estimados de regeneración / upgrade de video aprobados SOBRE el mismo run
    // (review I1): ese gasto aprobado también es «esperado» (si no, un upgrade legítimo dispararía el disyuntor).
    const rows: Array<{ scope: string; lines: any; totals: any }> = await this.dataSource.query(
      `(select scope, lines, totals from public.cost_estimates where run_id = $1 and scope = 'run' order by created_at desc, id desc limit 1)
       union all
       (select scope, lines, totals from public.cost_estimates where run_id = $1 and scope = 'regeneration')`,
      [runId],
    );
    const byKey = new Map<string, { expected: number; max: number }>();
    let total = 0;
    let hasRun = false;
    for (const est of rows) {
      if (est.scope === 'run') hasRun = true;
      for (const l of (est?.lines ?? []) as Array<Record<string, any>>) {
        if (!l || typeof l.itemKey !== 'string') continue;
        const cur = byKey.get(l.itemKey) ?? { expected: 0, max: 0 };
        // Esperado CON la tasa de reintentos del estimado (expected), y su máximo.
        cur.expected += Number(l.expected ?? l.wouldCost?.expected ?? 0) || 0;
        cur.max += Number(l.max ?? l.wouldCost?.max ?? 0) || 0;
        byKey.set(l.itemKey, cur);
      }
      if (est?.totals?.expected !== undefined && est?.totals?.expected !== null) total += Number(est.totals.expected) || 0;
    }
    const v = { at: Date.now(), byKey, total: hasRun && byKey.size ? total : null };
    if (this.runEstimateCache.size > 500) this.runEstimateCache.clear();
    this.runEstimateCache.set(runId, v);
    return v;
  }

  /**
   * Decide una llamada pagada contra el tope del run, el presupuesto de recuperación de la parte y el disyuntor.
   * Si dispara el disyuntor (o el tope del run en `pauseOnCap`), PAUSA el run (pausa segura del servidor, reanudable
   * por el usuario). `authorizedBudget`: tope a aplicar (null = no aplicar el punto 1 acá).
   */
  async guardRunSpend(a: { runId: string; itemRunId: string | null; nextCost: number; authorizedBudget: number | null; pauseOnCap?: boolean; snapshot?: boolean }): Promise<{
    decision: RunSpendDecision; itemKey: string | null; paused: boolean; overspend?: number; runExpected?: number | null;
  }> {
    const est = await this.runItemEstimates(a.runId);
    let itemKey: string | null = null;
    let itemSpent: number | null = null;
    let itemLargest = 0;
    if (a.itemRunId) {
      const [it] = await this.dataSource.query(`select item_key from public.generation_item_runs where id = $1 and job_id = $2`, [a.itemRunId, a.runId]);
      if (it) {
        itemKey = it.item_key;
        // Review C1: lo gastado en la GENERACIÓN vigente de la parte desde su último reinicio de presupuesto (un
        // reintento manual o una regeneración le dan un presupuesto nuevo: la parte siempre se puede recuperar).
        // Dentro de esa ventana cuenta TODO (reintentos de la llamada, intentos del item, rondas del auto-heal).
        const [sp] = await this.dataSource.query(
          `with cur as (
             select created_at, nullif(output_summary->>'recoveryBudgetResetAt', '')::timestamptz as reset_at
               from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1)
           select coalesce(sum(e.amount),0)::text as t,
                  -- la COTA de la llamada más grande = su reserva previa (nunca el uso real: un cargo enorme no
                  -- puede agrandar su propio presupuesto)
                  coalesce(max(e.amount) filter (where e.event_kind = 'CHARGE' and (e.metadata->>'reservation') = 'true'),0)::text as largest
             from public.generation_cost_events e, cur
            where e.run_id = $1 and e.item_key = $2 and e.billing_account <> 'user_key'
              and e.created_at >= greatest(cur.created_at, coalesce(cur.reset_at, cur.created_at))`,
          [a.runId, itemKey],
        );
        itemSpent = Number(sp.t);
        itemLargest = Number(sp.largest);
      }
    }
    const [runSpentRow] = await this.dataSource.query(
      `select coalesce(sum(amount),0)::text as t from public.generation_cost_events where run_id = $1 and billing_account <> 'user_key'`,
      [a.runId],
    );
    const [ackRow] = await this.dataSource.query(
      `select coalesce((output_summary->'spendBreaker'->>'acknowledgedUsd')::numeric, 0)::text as ack from public.production_jobs where id = $1`,
      [a.runId],
    );
    let progressExpected: number | null = null;
    if (est.total !== null) {
      // Avance = partes terminadas, en curso, o en las que ya se gastó algo (una parte en reintento también es avance
      // con costo esperado): el disyuntor compara lo gastado contra lo esperado de ESAS partes → detecta anomalías
      // sistémicas (muchas partes por encima de lo esperado), no una sola parte cara (eso lo acota su presupuesto).
      const rows: Array<{ item_key: string }> = await this.dataSource.query(
        `select item_key from (
           select distinct on (item_key) item_key, status from public.generation_item_runs
            where job_id = $1 order by item_key, generation desc) s
          where s.status in ('completed', 'running')
         union
         select distinct item_key from public.generation_cost_events
          where run_id = $1 and item_key is not null and billing_account <> 'user_key'`,
        [a.runId],
      );
      progressExpected = rows.reduce((acc, r) => acc + (est.byKey.get(r.item_key)?.expected ?? 0), 0);
    }
    const ie = itemKey ? est.byKey.get(itemKey) ?? null : null;
    const decision = decideRunSpend({
      authorizedBudget: a.authorizedBudget,
      runSpent: Number(runSpentRow.t),
      nextCost: a.nextCost,
      itemSpent,
      itemExpected: ie ? ie.expected : null,
      itemEstimatedMax: ie ? ie.max : null,
      runExpected: est.total,
      progressExpected,
      breakerAcknowledgedUsd: ackRow ? Number(ackRow.ack) : 0,
      itemLargestCall: itemLargest,
    });
    let paused = false;
    if (!decision.allow && process.env.FINOPS_SPEND_GUARD_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.error(`[spend-guard] run ${a.runId} item ${itemKey}: ${decision.reason} — ${'detail' in decision ? decision.detail : ''}`);
    }
    if (a.snapshot) {
      return { decision, itemKey, paused, overspend: Math.max(0, Number(runSpentRow.t) - (decision.breakerThreshold ?? Infinity)), runExpected: est.total };
    }
    if (!decision.allow && (decision.reason === 'circuit_breaker' || (decision.reason === 'run_budget_cap' && a.pauseOnCap))) {
      // Re-review N2: el tope guarda cuánto hacía falta (gastado + esta llamada) → reanudar exige ampliar a eso.
      paused = await this.pauseRunBySystem(a.runId, decision.reason, 'detail' in decision ? decision.detail : '',
        decision.reason === 'run_budget_cap' ? Number(runSpentRow.t) + a.nextCost : null);
    }
    return { decision, itemKey, paused };
  }

  /**
   * Proxy LLM del navegador (reserva previa): decide la llamada contra la pausa, el tope del run, el presupuesto de
   * recuperación de la parte y el disyuntor. Solo aplica a llamadas atribuidas a una parte de un run del MISMO dueño
   * y pagadas por Cursia (BYOK no consume el presupuesto del run). → null = permitida; si no, el código para el proxy.
   */
  async guardLlmProxyCall(a: { subject: string; itemRunId: string | null; model: string; promptChars: number; maxTokens: number; billingAccount: string }): Promise<null | {
    code: 'run_paused' | 'item_recovery_budget_exhausted'; message: string; runId: string; paused: boolean;
  }> {
    if (!a.itemRunId || a.billingAccount !== 'cursia') return null;
    const [row] = await this.dataSource.query(
      `select g.job_id, pj.owner_id, pj.worker_status from public.generation_item_runs g
         join public.production_jobs pj on pj.id = g.job_id where g.id = $1`,
      [a.itemRunId],
    );
    if (!row || String(row.owner_id) !== String(a.subject)) return null; // sin atribución verificable: el ingest la deja sin run
    return this.guardLlmCallForRun({ runId: row.job_id, workerStatus: row.worker_status, itemRunId: a.itemRunId, model: a.model, promptChars: a.promptChars, maxTokens: a.maxTokens });
  }

  /**
   * Loop 4: misma decisión para una llamada LLM hecha por el WORKER del backend (sin proxy): pausa, tope del run,
   * presupuesto de recuperación de la parte y disyuntor. → null = permitida.
   */
  async guardServerLlmCall(a: { runId: string; itemRunId: string; model: string; promptChars: number; maxTokens: number }): Promise<null | {
    code: 'run_paused' | 'item_recovery_budget_exhausted'; message: string; runId: string; paused: boolean;
  }> {
    const [row] = await this.dataSource.query(`select worker_status from public.production_jobs where id = $1`, [a.runId]);
    if (!row) return { code: 'run_paused', message: 'El run no existe.', runId: a.runId, paused: false };
    return this.guardLlmCallForRun({ runId: a.runId, workerStatus: row.worker_status, itemRunId: a.itemRunId, model: a.model, promptChars: a.promptChars, maxTokens: a.maxTokens });
  }

  private async guardLlmCallForRun(a: { runId: string; workerStatus: string; itemRunId: string; model: string; promptChars: number; maxTokens: number }): Promise<null | {
    code: 'run_paused' | 'item_recovery_budget_exhausted'; message: string; runId: string; paused: boolean;
  }> {
    const row = { job_id: a.runId, worker_status: a.workerStatus };
    if (row.worker_status === 'paused') {
      return { code: 'run_paused', message: 'El run está pausado: no se hacen llamadas nuevas hasta reanudarlo.', runId: row.job_id, paused: true };
    }
    // Loop 4 review I3: un run cancelado/terminado nunca hace llamadas pagadas nuevas (la parte en curso se detiene).
    if (['cancelled', 'cancelling', 'failed', 'completed'].includes(String(row.worker_status ?? ''))) {
      return { code: 'run_paused', message: `El run ya no está activo (${row.worker_status}): no se hacen llamadas nuevas.`, runId: row.job_id, paused: false };
    }
    const nextCost = Number(await this.callCost({
      provider: 'anthropic', service: 'messages', product: a.model,
      usage: { input_tokens: Math.max(1, Math.ceil(a.promptChars / 3)), output_tokens: a.maxTokens },
    }));
    // Review I4: un presupuesto REVOCADO (BLOCKED) es tope 0 (falla cerrado, como en los workers); sin ninguna
    // autorización (runs previos a FinOps) no hay tope que aplicar acá.
    const [authRow] = await this.dataSource.query(
      `select decision, authorized_budget::text as b from public.cost_budget_authorizations where run_id = $1 order by created_at desc, id desc limit 1`,
      [row.job_id],
    );
    const cap = !authRow ? null : authRow.decision === 'BLOCKED' ? 0 : Number(authRow.b);
    const g = await this.guardRunSpend({ runId: row.job_id, itemRunId: a.itemRunId, nextCost, authorizedBudget: cap, pauseOnCap: true });
    const d = g.decision;
    if (d.allow) return null;
    const detail = 'detail' in d ? d.detail : '';
    if (d.reason === 'item_recovery_budget_exhausted') {
      return { code: 'item_recovery_budget_exhausted', message: detail, runId: row.job_id, paused: false };
    }
    return {
      code: 'run_paused', runId: row.job_id, paused: g.paused,
      message: (d.reason === 'circuit_breaker' ? 'Pausa automática por consumo anómalo: ' : 'Pausa automática: se alcanzó el presupuesto autorizado del run: ') + detail,
    };
  }

  /**
   * Al REANUDAR un run que pausó el disyuntor: el usuario acepta el sobreconsumo hasta ahora → se suma al umbral
   * (acumulado) para que el disyuntor no vuelva a disparar en la llamada siguiente por lo mismo, pero sí ante una
   * anomalía NUEVA. Devuelve el sobreconsumo aceptado (USD).
   */
  async acknowledgeBreakerOnResume(runId: string): Promise<number> {
    const snap = await this.guardRunSpend({ runId, itemRunId: null, nextCost: 0, authorizedBudget: null, snapshot: true });
    if (snap.decision.breakerThreshold === null) return 0;
    // Lo excedido hasta ahora + un margen NUEVO completo: el disyuntor no vuelve a disparar por lo mismo (ni en la
    // llamada siguiente), pero sí cuando el consumo vuelve a desviarse esa misma magnitud.
    const slack = Math.max(BREAKER_MIN_SLACK_USD, BREAKER_SLACK_SHARE * (snap.runExpected ?? 0));
    const over = Math.max(0, snap.overspend ?? 0) + slack;
    if (over > 0) {
      // Review M4: idempotente por pausa (doble clic / dos pestañas → se acepta UNA vez por cada pausa del disyuntor).
      await this.dataSource.query(
        `update public.production_jobs
            set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('spendBreaker', jsonb_build_object(
                  'acknowledgedUsd', coalesce((output_summary->'spendBreaker'->>'acknowledgedUsd')::numeric, 0) + $2::numeric,
                  'acknowledgedAt', now(), 'ackForPauseAt', output_summary->'pause'->>'pausedAt'))
          where id = $1 and worker_status = 'paused'
            and coalesce(output_summary->'spendBreaker'->>'ackForPauseAt', '') is distinct from coalesce(output_summary->'pause'->>'pausedAt', '')`,
        [runId, over.toFixed(6)],
      );
    }
    return over;
  }

  /** Pausa segura del run decidida por Cursia (disyuntor / tope): misma pausa del servidor que la del usuario. */
  async pauseRunBySystem(runId: string, reason: string, detail: string, requiredUsd: number | null = null): Promise<boolean> {
    const rows = await this.dataSource.query(
      `update public.production_jobs
          set status = 'paused', worker_status = 'paused', next_retry_at = null,
              output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object(
                'pause', jsonb_build_object('pausedAt', now(), 'pausedBy', $2::text, 'reason', $3::text, 'detail', $4::text,
                                            'requiredUsd', $5::numeric, 'previousWorkerStatus', worker_status)),
              updated_at = now()
        where id = $1 and execution_mode = 'dynamic_generation' and worker_status in ('queued', 'running', 'retrying')
          and coalesce(status, '') not in ('cancelled', 'cancelling')
        returning id`,
      [runId, 'system:' + reason, reason, detail.slice(0, 500), requiredUsd === null ? null : requiredUsd.toFixed(6)],
    );
    const list = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows;
    return Array.isArray(list) && list.length > 0;
  }
}

/** reason del guard cuando la PARTE agotó su presupuesto de recuperación: el worker la falla (solo esa parte). */
export const ITEM_RECOVERY_BUDGET_REASON = 'item_recovery_budget_exhausted';
