/**
 * V2.1 RF-a — budget gates (audit §W.7, HD-V21-19). Puro.
 *
 * Ningún monto comercial está hardcodeado: todos los límites vienen de la
 * política versionada (`cost_budget_policies.limits`); null/ausente = sin límite.
 *
 * Regla por límite L contra el estimado:
 *   max <= L                → AUTO_WITHIN_POLICY
 *   expected <= L < max     → ADMIN_APPROVAL
 *   expected > L            → on_exceed (BLOCK | ADMIN_APPROVAL)
 * Alcance de cada límite:
 *   maxCostPerRun        estimado del run
 *   maxCostPerItemType   estimado del run por item type
 *   maxCostPerCourse     gastado del curso + estimado del run
 *   maxCostPerProvider   gastado del curso en ese proveedor + estimado del run en ese proveedor
 * Gasto real con requireHumanApprovalForRealSpend (default true) ⇒ como mínimo
 * ADMIN_APPROVAL aunque todo esté dentro de los límites. Mock ⇒ siempre AUTO.
 */
import { FinopsError } from './errors';
import { addDec, cmpDec, subDec, normalizeDecimal, DecimalLike } from './decimal';
import type { MinExpMax } from './estimator';

export type BudgetDecision = 'AUTO_WITHIN_POLICY' | 'ADMIN_APPROVAL' | 'BLOCK';

export interface BudgetLimits {
  maxCostPerRun?: DecimalLike | null;
  maxCostPerCourse?: DecimalLike | null;
  maxCostPerProvider?: Record<string, DecimalLike | null> | null;
  maxCostPerItemType?: Record<string, DecimalLike | null> | null;
}

export interface BudgetPolicy {
  id?: string | null;
  version?: number | null;
  limits: BudgetLimits;
  /** Default true (HD-V21-19: en staging/desarrollo todo gasto real requiere aprobación humana). */
  requireHumanApprovalForRealSpend?: boolean | null;
  onExceed?: 'BLOCK' | 'ADMIN_APPROVAL' | null;
}

export interface BudgetEstimate {
  totals: MinExpMax & {
    byProvider?: Record<string, MinExpMax>;
    byItemType?: Record<string, MinExpMax>;
  };
}

export interface SpentSoFar {
  course?: DecimalLike | null;
  byProvider?: Record<string, DecimalLike | null> | null;
}

export interface EvaluateBudgetInput {
  estimate: BudgetEstimate;
  policy: BudgetPolicy | null;
  spentSoFar?: SpentSoFar | null;
  /** false = run mock/fake: siempre permitido. */
  realSpend: boolean;
}

export interface EvaluateBudgetResult {
  decision: BudgetDecision;
  reasons: string[];
}

const RANK: Record<BudgetDecision, number> = { AUTO_WITHIN_POLICY: 0, ADMIN_APPROVAL: 1, BLOCK: 2 };

function worst(a: BudgetDecision, b: BudgetDecision): BudgetDecision {
  return RANK[b] > RANK[a] ? b : a;
}

function limitOf(v: DecimalLike | null | undefined, what: string): string | null {
  if (v === null || v === undefined) return null;
  const n = normalizeDecimal(v, what);
  if (cmpDec(n, 0) < 0) throw new FinopsError('INVALID_POLICY', `${what} negativo (${String(v)})`);
  return n;
}

function checkLimit(
  label: string,
  limit: string | null,
  base: DecimalLike,
  est: MinExpMax,
  onExceed: BudgetDecision,
  reasons: string[],
): BudgetDecision {
  if (limit === null) return 'AUTO_WITHIN_POLICY';
  const expected = addDec(base, est.expected);
  const max = addDec(base, est.max);
  if (cmpDec(max, limit) <= 0) return 'AUTO_WITHIN_POLICY';
  if (cmpDec(expected, limit) <= 0) {
    reasons.push(`${label}:max_over_limit(max=${max},limit=${limit})`);
    return 'ADMIN_APPROVAL';
  }
  reasons.push(`${label}:expected_over_limit(expected=${expected},limit=${limit})`);
  return onExceed;
}

const ZERO_EST: MinExpMax = { min: '0', expected: '0', max: '0' };

export function evaluateBudget(input: EvaluateBudgetInput): EvaluateBudgetResult {
  if (!input || !input.estimate || !input.estimate.totals) throw new FinopsError('INVALID_INPUT', 'evaluateBudget necesita estimate.totals');
  if (typeof input.realSpend !== 'boolean') throw new FinopsError('INVALID_INPUT', 'realSpend debe ser boolean explícito');
  if (!input.realSpend) return { decision: 'AUTO_WITHIN_POLICY', reasons: ['mock_run_always_allowed'] };

  const reasons: string[] = [];
  const policy = input.policy;
  if (!policy) {
    return { decision: 'ADMIN_APPROVAL', reasons: ['no_budget_policy'] };
  }
  const onExceedRaw = policy.onExceed ?? 'BLOCK';
  if (onExceedRaw !== 'BLOCK' && onExceedRaw !== 'ADMIN_APPROVAL') {
    throw new FinopsError('INVALID_POLICY', `on_exceed inválido: ${String(onExceedRaw)}`);
  }
  const onExceed: BudgetDecision = onExceedRaw;
  const limits = policy.limits || {};
  const est = input.estimate.totals;
  const spent = input.spentSoFar || {};
  const spentCourse = spent.course ?? 0;
  let decision: BudgetDecision = 'AUTO_WITHIN_POLICY';

  decision = worst(decision, checkLimit('maxCostPerRun', limitOf(limits.maxCostPerRun, 'maxCostPerRun'), 0, est, onExceed, reasons));
  decision = worst(
    decision,
    checkLimit('maxCostPerCourse', limitOf(limits.maxCostPerCourse, 'maxCostPerCourse'), spentCourse, est, onExceed, reasons),
  );
  for (const provider of Object.keys(limits.maxCostPerProvider || {}).sort()) {
    const lim = limitOf((limits.maxCostPerProvider as Record<string, DecimalLike | null>)[provider], `maxCostPerProvider.${provider}`);
    const pe = (est.byProvider && est.byProvider[provider]) || ZERO_EST;
    const base = (spent.byProvider && spent.byProvider[provider]) ?? 0;
    decision = worst(decision, checkLimit(`maxCostPerProvider.${provider}`, lim, base, pe, onExceed, reasons));
  }
  for (const itemType of Object.keys(limits.maxCostPerItemType || {}).sort()) {
    const lim = limitOf((limits.maxCostPerItemType as Record<string, DecimalLike | null>)[itemType], `maxCostPerItemType.${itemType}`);
    const te = (est.byItemType && est.byItemType[itemType]) || ZERO_EST;
    decision = worst(decision, checkLimit(`maxCostPerItemType.${itemType}`, lim, 0, te, onExceed, reasons));
  }

  const requireHuman = policy.requireHumanApprovalForRealSpend !== false;
  if (requireHuman && decision === 'AUTO_WITHIN_POLICY') {
    decision = 'ADMIN_APPROVAL';
    reasons.push('real_spend_requires_human_approval');
  }
  if (decision === 'AUTO_WITHIN_POLICY') reasons.push('within_policy');
  return { decision, reasons };
}

export interface RuntimeGuardInput {
  /** Presupuesto autorizado (fila de cost_budget_authorizations). null = sin autorización ⇒ bloquea. */
  authorizedBudget: DecimalLike | null;
  /** Suma del ledger del run (CHARGE + ADJUSTMENT + REFUND). */
  actualSoFar: DecimalLike;
  /** Reservas de llamadas en vuelo (aún sin CHARGE). */
  reservedInFlight: DecimalLike;
  /** Costo estimado (max) de la próxima llamada pagada. */
  next: DecimalLike;
}

export interface RuntimeGuardResult {
  allow: boolean;
  decision: 'ALLOW' | 'BLOCK';
  committed: string;
  remaining: string | null;
  reason: string;
}

/** Antes de cada llamada pagada: committed = actual + reservas + next <= authorized. */
export function runtimeGuard(input: RuntimeGuardInput): RuntimeGuardResult {
  if (!input) throw new FinopsError('INVALID_INPUT', 'runtimeGuard sin input');
  const next = normalizeDecimal(input.next, 'next');
  const reserved = normalizeDecimal(input.reservedInFlight, 'reservedInFlight');
  if (cmpDec(next, 0) < 0 || cmpDec(reserved, 0) < 0) throw new FinopsError('INVALID_INPUT', 'next/reservedInFlight negativos');
  const committed = addDec(input.actualSoFar, reserved, next);
  if (input.authorizedBudget === null || input.authorizedBudget === undefined) {
    return { allow: false, decision: 'BLOCK', committed, remaining: null, reason: 'no_authorization' };
  }
  const authorized = normalizeDecimal(input.authorizedBudget, 'authorizedBudget');
  const remaining = subDec(authorized, committed);
  if (cmpDec(committed, authorized) <= 0) {
    return { allow: true, decision: 'ALLOW', committed, remaining, reason: 'within_authorized_budget' };
  }
  return { allow: false, decision: 'BLOCK', committed, remaining, reason: 'budget_exceeded' };
}
