import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinopsError } from './errors';
import { addDec, cmpDec, normalizeDecimal, DecimalLike } from './decimal';
import type { PricingCatalogRow } from './pricing';
import { EstimateItem, EstimateResult, RetryPolicy, estimateCost } from './estimator';
import { usageModelPriorsV1 } from './usage-model';
import { BudgetPolicy, RuntimeGuardResult, SpentSoFar, runtimeGuard } from './budget';
import { FinopsLedgerService } from './finops-ledger.service';
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
   * Aprobación ADMIN_APPROVED de este curso, para un estimado del MISMO
   * Manifest, todavía no vinculada a ningún run y que cubre `minBudget`.
   */
  async findUnconsumedApproval(courseId: number, manifestId: number, minBudget: DecimalLike, runner: Runner = this.dataSource): Promise<any | null> {
    const [row] = await runner.query(
      `select a.id, a.estimate_id, a.authorized_budget::text as authorized_budget, a.approved_by, a.policy_id, a.currency
         from public.cost_budget_authorizations a
         join public.cost_estimates e on e.id = a.estimate_id
        where a.course_id = $1 and a.decision = 'ADMIN_APPROVED' and a.run_id is null and e.manifest_id = $2
          and a.authorized_budget >= $3::numeric
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
  }): Promise<RuntimeGuardResult & { authorizedBudget: string | null }> {
    const itemProvider = paidProviderOfItemType(a.itemType);
    if (!itemProvider) throw new FinopsError('INVALID_INPUT', `guardPaidSubmission: ${a.itemType} no es un item de proveedor pagado`);
    const provider = a.provider ?? itemProvider;
    const [authorizedBudget, actualSoFar, reservedInFlight, next] = await Promise.all([
      this.runPaidAuthorizedBudget(a.runId),
      this.runActual(a.runId),
      this.reservedInFlight(a.runId, a.itemRunId),
      this.singleCallCost(a.itemType, provider),
    ]);
    return { ...runtimeGuard({ authorizedBudget, actualSoFar, reservedInFlight, next }), authorizedBudget };
  }
}
