/**
 * Flujo NORMAL de aprobación de una generación (staging/producto), separado de
 * la calibración (scripts/staging-v21-calibration.js `authorize`, que sigue
 * existiendo para calibraciones y exige títulos "[CALIBRATION V2.1]").
 *
 * Puro: sin DB, sin reloj, sin random.
 *
 * - `planNormalApproval`: ¿el estimado entra en la política vigente? Si entra,
 *   el monto a autorizar es min(max del estimado, lo que queda de cada límite
 *   total: por run, por curso y mensual). Nunca supera un límite: si el
 *   ESPERADO no entra en alguno, se bloquea nombrando el límite (subir límites
 *   es decisión humana fuera de este flujo). Límites por proveedor / tipo de
 *   item: como una sola autorización total no puede acotar un proveedor, el
 *   MÁXIMO de esa parte (más lo ya gastado en ese proveedor) debe entrar; si
 *   no, se bloquea. Mismo criterio de "gasto previo" que evaluateBudget.
 * - `estimateCategories`: desglose por familia visible en la UI.
 * - `estimateFingerprint`: huella del estimado que vio el usuario; si el
 *   Blueprint/Manifest, el contexto, los modos, los precios, la política o el
 *   gasto cambian, la huella cambia y la aprobación exige un estimado nuevo.
 */
import { createHash } from 'crypto';
import { FinopsError } from './errors';
import { addDec, cmpDec, normalizeDecimal, subDec, DecimalLike } from './decimal';
import type { BudgetPolicy } from './budget';
import type { EstimateResult, MinExpMax } from './estimator';

export const NORMAL_APPROVAL_REASON_PREFIX = 'ui_normal_approval';
/** Una aprobación del flujo normal que no se usó en este plazo ya no sirve (se pide un estimado nuevo). */
export const APPROVAL_TTL_HOURS = 24;

export interface ApprovalLimitBlock {
  /** maxCostPerRun | maxCostPerCourse | monthlyCap | maxCostPerProvider.<p> | maxCostPerItemType.<t> | no_budget_policy */
  limit: string;
  limitValue: string | null;
  /** Lo que ya se gastó contra ese límite (curso / mes). */
  spent: string;
  /** Esperado del estimado (de la parte que cuenta para ese límite). */
  expected: string;
  /** Qué no entra: el esperado, o (límites por proveedor/tipo) el máximo. */
  over?: 'expected' | 'max';
}

export interface NormalApprovalPlan {
  withinPolicy: boolean;
  /** Monto a autorizar (string decimal) si withinPolicy; null si no. */
  amount: string | null;
  /** true si el monto quedó por debajo del máximo del estimado por algún límite. */
  cappedByLimit: string | null;
  blockedBy: ApprovalLimitBlock[];
  limits: { maxCostPerRun: string | null; maxCostPerCourse: string | null; monthlyCap: string | null };
}

function lim(v: DecimalLike | null | undefined, what: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = normalizeDecimal(v, what);
  if (cmpDec(n, 0) < 0) throw new FinopsError('INVALID_POLICY', `${what} negativo (${String(v)})`);
  return n;
}

export function planNormalApproval(input: {
  estimate: Pick<EstimateResult, 'totals'>;
  policy: BudgetPolicy | null;
  courseSpent: DecimalLike;
  /** Comprometido del mes: gasto liquidado + presupuesto pendiente de runs vivos (ver monthCommitted). */
  monthSpent: DecimalLike;
  /** Gasto del curso por proveedor (spentSoFar.byProvider). */
  providerSpent?: Record<string, DecimalLike> | null;
}): NormalApprovalPlan {
  const est = input.estimate.totals;
  const noLimits = { maxCostPerRun: null, maxCostPerCourse: null, monthlyCap: null };
  if (!input.policy) {
    return {
      withinPolicy: false, amount: null, cappedByLimit: null, limits: noLimits,
      blockedBy: [{ limit: 'no_budget_policy', limitValue: null, spent: normalizeDecimal(0), expected: est.expected, over: 'expected' }],
    };
  }
  const limits = (input.policy.limits || {}) as Record<string, any>;
  const perRun = lim(limits.maxCostPerRun, 'maxCostPerRun');
  const perCourse = lim(limits.maxCostPerCourse, 'maxCostPerCourse');
  const monthly = lim(limits.monthlyCap ?? limits.monthlyCapStaging, 'monthlyCap');
  const courseSpent = normalizeDecimal(input.courseSpent, 'courseSpent');
  const monthSpent = normalizeDecimal(input.monthSpent, 'monthSpent');
  const zero = normalizeDecimal(0);

  const blockedBy: ApprovalLimitBlock[] = [];
  // Límites totales: lo que queda de cada uno acota el monto autorizado.
  const totals: Array<{ limit: string; value: string | null; spent: string }> = [
    { limit: 'maxCostPerRun', value: perRun, spent: zero },
    { limit: 'maxCostPerCourse', value: perCourse, spent: courseSpent },
    { limit: 'monthlyCap', value: monthly, spent: monthSpent },
  ];
  let amount = normalizeDecimal(est.max, 'max');
  let cappedByLimit: string | null = null;
  for (const t of totals) {
    if (t.value === null) continue;
    const remaining = subDec(t.value, t.spent);
    if (cmpDec(addDec(t.spent, est.expected), t.value) > 0) {
      blockedBy.push({ limit: t.limit, limitValue: t.value, spent: t.spent, expected: est.expected, over: 'expected' });
      continue;
    }
    if (cmpDec(remaining, amount) < 0) {
      amount = remaining;
      cappedByLimit = t.limit;
    }
  }
  const parts = (key: 'maxCostPerProvider' | 'maxCostPerItemType', by: Record<string, MinExpMax> | undefined, spentBy: Record<string, DecimalLike> | null) => {
    const m = (limits[key] || {}) as Record<string, DecimalLike | null>;
    for (const k of Object.keys(m).sort()) {
      const v = lim(m[k], `${key}.${k}`);
      if (v === null) continue;
      const base = normalizeDecimal((spentBy && spentBy[k]) ?? 0);
      const e = normalizeDecimal((by && by[k] && by[k].expected) || zero);
      const mx = normalizeDecimal((by && by[k] && by[k].max) || zero);
      if (cmpDec(addDec(base, e), v) > 0) blockedBy.push({ limit: `${key}.${k}`, limitValue: v, spent: base, expected: e, over: 'expected' });
      else if (cmpDec(addDec(base, mx), v) > 0) blockedBy.push({ limit: `${key}.${k}`, limitValue: v, spent: base, expected: e, over: 'max' });
    }
  };
  parts('maxCostPerProvider', est.byProvider, input.providerSpent ?? null);
  parts('maxCostPerItemType', est.byItemType, null);
  if (blockedBy.length === 0 && cmpDec(amount, 0) <= 0) {
    // Remanente 0 en el límite que acotó el monto (se nombra ESE límite).
    const t = totals.find((x) => x.limit === cappedByLimit) || totals[2];
    blockedBy.push({ limit: t.limit, limitValue: t.value, spent: t.spent, expected: est.expected, over: 'expected' });
  }

  const withinPolicy = blockedBy.length === 0;
  return {
    withinPolicy,
    amount: withinPolicy ? amount : null,
    cappedByLimit: withinPolicy ? cappedByLimit : null,
    blockedBy,
    limits: { maxCostPerRun: perRun, maxCostPerCourse: perCourse, monthlyCap: monthly },
  };
}

/** Familias visibles en la UI (por proveedor). */
export const ESTIMATE_CATEGORY_OF_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'content',
  gamma: 'presentations',
  videogen: 'videos',
  youtube: 'videos',
  openai: 'audio',
});
export const ESTIMATE_CATEGORIES = ['content', 'presentations', 'videos', 'audio', 'other'] as const;

export function estimateCategories(byProvider: Record<string, MinExpMax> | undefined): Record<string, MinExpMax> {
  const zero = normalizeDecimal(0);
  const out: Record<string, MinExpMax> = {};
  for (const c of ESTIMATE_CATEGORIES) out[c] = { min: zero, expected: zero, max: zero };
  for (const p of Object.keys(byProvider || {}).sort()) {
    const c = ESTIMATE_CATEGORY_OF_PROVIDER[p] || 'other';
    const v = (byProvider as Record<string, MinExpMax>)[p];
    out[c] = { min: addDec(out[c].min, v.min), expected: addDec(out[c].expected, v.expected), max: addDec(out[c].max, v.max) };
  }
  return out;
}

/**
 * V542 (G3) — desglose visible del estimado: el banco de preguntas de los exámenes (exam + final_exam,
 * la parte de IA que el estimado v1.1 subestimaba ×14–19) y la reserva por reintentos incluida en el total.
 */
export interface EstimateBreakdown {
  examBank: MinExpMax;
  retryAllowance: { expected: string; max: string };
}
export function estimateBreakdown(estimate: Pick<EstimateResult, 'totals'>): EstimateBreakdown {
  const zero = normalizeDecimal(0);
  const by = estimate.totals.byItemType || {};
  const examBank: MinExpMax = { min: zero, expected: zero, max: zero };
  for (const t of ['exam', 'final_exam']) {
    const v = by[t];
    if (!v) continue;
    examBank.min = addDec(examBank.min, v.min);
    examBank.expected = addDec(examBank.expected, v.expected);
    examBank.max = addDec(examBank.max, v.max);
  }
  const ra = (estimate.totals as { retryAllowance?: { expected: string; max: string } }).retryAllowance;
  return { examBank, retryAllowance: ra ? { expected: ra.expected, max: ra.max } : { expected: zero, max: zero } };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

export function estimateFingerprint(input: {
  courseId: number;
  manifestId: number;
  manifestSha?: string | null;
  contextHash: string;
  modes: unknown;
  estimate: Pick<EstimateResult, 'estimatorVersion' | 'usageModelVersion' | 'pricingVersions' | 'totals'>;
  policyId: string | null;
  plan: Pick<NormalApprovalPlan, 'amount' | 'withinPolicy'>;
  courseSpent: string;
}): string {
  const e = input.estimate;
  return createHash('sha256').update(canonical({
    v: 1,
    courseId: input.courseId,
    manifestId: input.manifestId,
    manifestSha: input.manifestSha ?? null,
    contextHash: input.contextHash,
    modes: input.modes ?? null,
    estimatorVersion: e.estimatorVersion,
    usageModelVersion: e.usageModelVersion,
    pricingVersions: [...(e.pricingVersions || [])].sort(),
    totals: { min: e.totals.min, expected: e.totals.expected, max: e.totals.max },
    policyId: input.policyId,
    amount: input.plan.amount,
    withinPolicy: input.plan.withinPolicy,
    courseSpent: input.courseSpent,
  })).digest('hex');
}
