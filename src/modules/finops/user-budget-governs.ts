/**
 * r95 (decisión del owner, 2026-11-03) — EL PRESUPUESTO DEL USUARIO MANDA.
 *
 * Incidente: el curso de un usuario con presupuesto mensual asignado de USD 300 pidió la aprobación de un administrador
 * porque su estimado superaba el tope global OCULTO `maxCostPerRun` (150). El owner: «el presupuesto que le asigné es el
 * que debe gobernar».
 *
 * Regla (pura: sin DB, sin reloj):
 *  - Aplica solo si quien paga la generación tiene un presupuesto ASIGNADO (r75, `assigned`, modo shadow o enforce) y la
 *    generación usa proveedores pagados reales (el camino de «Autorizar y generar»).
 *  - Para ese usuario, los topes globales por generación (`maxCostPerRun`), por curso (`maxCostPerCourse`) y mensual por
 *    cuenta (`ownerMonthlyCap`) se reemplazan por su DISPONIBLE del mes: el monto autorizado nunca supera lo disponible.
 *  - `monthlyCap` (techo de TODA la plataforma), los topes por proveedor / tipo de parte, `on_exceed` y el pedido explícito
 *    de admin (`requireHumanApprovalForRealSpend`) NO cambian: siguen siendo el techo duro de la plataforma.
 *  - Si con esa sustitución la decisión es la autorización del usuario y el monto autorizado (hoy: el del plan de la
 *    política; con el «tope de seguridad» de PR #225, ese tope, que sale del mismo plan) cabe en su disponible → la decide
 *    el usuario («Autorizar y generar»), aunque supere los topes globales. Si no cabe → todo queda como antes (admin, o
 *    `user_budget_insufficient` con «Solicitar autorización»).
 *  - Usuarios SIN presupuesto asignado: nada cambia (los topes globales siguen aplicando).
 *
 * La sustitución se hace sobre una COPIA de la política (misma id/versión: la huella del estimado no cambia por esto):
 *   maxCostPerRun   := disponible
 *   maxCostPerCourse := gasto del curso + disponible
 *   ownerMonthlyCap := comprometido del mes de la cuenta + disponible
 * así el remanente de cada uno es exactamente el disponible y `planNormalApproval` / `policySpendCaps` / `decideRunBudget`
 * corren sin cambios.
 */
import { addDec, cmpDec, normalizeDecimal, DecimalLike } from './decimal';
import type { BudgetPolicy, SpentSoFar } from './budget';
import type { EstimateResult } from './estimator';
import { decideRunBudget, RunBudgetDecision } from './run-budget';
import { planNormalApproval, NormalApprovalPlan } from './normal-approval';

/** Motivo que marca una decisión gobernada por el presupuesto del usuario (lo relee la tx que crea el run). */
export const USER_BUDGET_GOVERNS_REASON = 'user_budget_governs';
/** Marca en la copia de la política (no se persiste nunca). */
export const USER_BUDGET_GOVERNED_LIMIT_KEY = 'userBudgetGoverned';

export interface UserBudgetStanding {
  mode: 'off' | 'shadow' | 'enforce';
  assigned: boolean;
  /** Disponible del mes (string decimal). */
  available: string;
}

export type UserBudgetGovernance =
  | { applies: false; why: 'no_assigned_budget' | 'budgets_off' | 'no_budget_policy' | 'no_paid_provider' | 'already_user_authorization' | 'still_requires_admin' | 'outside_platform_ceiling' | 'over_available' }
  | {
      applies: true;
      why: 'user_budget_governs';
      /** Copia de la política con los topes por generación/curso/cuenta = el disponible del usuario. */
      policy: BudgetPolicy & { id?: string | null };
      decision: RunBudgetDecision;
      /** Plan con el mes de toda la plataforma (monthlyCap real). */
      plan: NormalApprovalPlan;
      /** Plan firmable (sin el mes de los demás), igual que normalPlan. */
      signedPlan: NormalApprovalPlan;
      available: string;
    };

export function isUserBudgetGoverned(reasons: readonly string[] | null | undefined): boolean {
  return Array.isArray(reasons) && reasons.includes(USER_BUDGET_GOVERNS_REASON);
}

export function userBudgetGovernedPolicy<P extends BudgetPolicy>(policy: P, input: { available: DecimalLike; courseSpent: DecimalLike; ownerMonthSpent: DecimalLike | null }): P {
  const available = normalizeDecimal(input.available, 'available');
  const limits = { ...((policy.limits || {}) as Record<string, unknown>) };
  limits.maxCostPerRun = available;
  limits.maxCostPerCourse = addDec(normalizeDecimal(input.courseSpent, 'courseSpent'), available);
  limits.ownerMonthlyCap = addDec(normalizeDecimal(input.ownerMonthSpent ?? 0, 'ownerMonthSpent'), available);
  limits[USER_BUDGET_GOVERNED_LIMIT_KEY] = true;
  return { ...policy, limits: limits as P['limits'] };
}

export function governRunBudget(input: {
  estimate: Pick<EstimateResult, 'totals'>;
  policy: (BudgetPolicy & { id?: string | null }) | null;
  spentSoFar: SpentSoFar;
  /** Comprometido del mes de toda la plataforma (monthCommitted.total). */
  monthSpent: DecimalLike;
  /** Comprometido del mes de la cuenta dueña del curso (null si no se consultó: la política no tiene ownerMonthlyCap). */
  ownerMonthSpent: DecimalLike | null;
  paidRealProviders: readonly string[];
  userBudget: UserBudgetStanding | null;
}): UserBudgetGovernance {
  const ub = input.userBudget;
  if (!ub || ub.mode === 'off') return { applies: false, why: 'budgets_off' };
  if (!ub.assigned) return { applies: false, why: 'no_assigned_budget' };
  if (!input.policy) return { applies: false, why: 'no_budget_policy' };
  if (!input.paidRealProviders || input.paidRealProviders.length === 0) return { applies: false, why: 'no_paid_provider' };
  const spent = input.spentSoFar || {};
  const courseSpent = normalizeDecimal(spent.course ?? 0, 'courseSpent');

  // ¿Ya era la autorización del usuario, dentro de la política? Entonces no se toca (ni el monto).
  const base = decideRunBudget({ estimate: input.estimate, policy: input.policy, spentSoFar: spent, paidRealProviders: input.paidRealProviders });
  if (base.decision === 'AUTO_WITHIN_POLICY' && base.userAuthorizationRequired) {
    const basePlan = planNormalApproval({ estimate: input.estimate, policy: input.policy, courseSpent, monthSpent: input.monthSpent, providerSpent: spent.byProvider as Record<string, DecimalLike> | null,
      ownerMonthSpent: input.ownerMonthSpent });
    if (basePlan.withinPolicy) return { applies: false, why: 'already_user_authorization' };
  }

  const available = normalizeDecimal(ub.available, 'available');
  const policy = userBudgetGovernedPolicy(input.policy, { available, courseSpent, ownerMonthSpent: input.ownerMonthSpent ?? 0 });
  const d = decideRunBudget({ estimate: input.estimate, policy, spentSoFar: spent, paidRealProviders: input.paidRealProviders });
  if (!(d.decision === 'AUTO_WITHIN_POLICY' && d.userAuthorizationRequired)) return { applies: false, why: 'still_requires_admin' };
  const ownerMonth = input.ownerMonthSpent ?? '0';
  const plan = planNormalApproval({ estimate: input.estimate, policy, courseSpent, monthSpent: input.monthSpent, providerSpent: spent.byProvider as Record<string, DecimalLike> | null, ownerMonthSpent: ownerMonth });
  const signedPlan = planNormalApproval({ estimate: input.estimate, policy, courseSpent, monthSpent: '0', providerSpent: spent.byProvider as Record<string, DecimalLike> | null, ownerMonthSpent: ownerMonth });
  // El techo de la plataforma (monthlyCap) y los topes por proveedor/tipo siguen mandando.
  if (!plan.withinPolicy || !signedPlan.withinPolicy || plan.amount === null || signedPlan.amount === null) return { applies: false, why: 'outside_platform_ceiling' };
  // Nunca se autoriza más de lo que el usuario tiene disponible (defensa: los topes sustituidos ya lo garantizan).
  if (cmpDec(signedPlan.amount, available) > 0 || cmpDec(plan.amount, available) > 0) return { applies: false, why: 'over_available' };
  const decision: RunBudgetDecision = { ...d, reasons: [...d.reasons, USER_BUDGET_GOVERNS_REASON] };
  return { applies: true, why: 'user_budget_governs', policy, decision, plan, signedPlan, available };
}
