/**
 * Loop Cost Efficiency + Reliability (2026-10-11, tras el piloto #1209) — guard de gasto por run y por parte.
 *
 * En #1209 un mismo item se reintentó hasta 13 veces sumando tres capas (reintentos de la llamada en el
 * navegador × intentos del item × rondas del auto-heal) y ninguna capa miraba el DINERO: el run gastó 34 USD
 * en Anthropic contra ~15 esperados. Este guard decide, antes de CADA llamada pagada (proxy LLM del navegador
 * y workers del servidor), con lo que el ledger ya sabe:
 *
 *  1. Tope duro del run: gastado (ledger, reservas pendientes incluidas) + esta llamada ≤ autorizado.
 *  2. Presupuesto de recuperación por parte: costo esperado (estimados del run) + margen → límite duro
 *     = max(ITEM_HARD_FACTOR × esperado, máximo estimado, ITEM_HARD_FLOOR_USD, esperado + 3 × cota de una llamada).
 *     Cuenta lo gastado en la GENERACIÓN vigente de la parte desde su último reinicio de presupuesto (todas las capas
 *     de reintento: llamada, intentos, auto-heal), así las capas ya no se multiplican: al alcanzar el límite se
 *     detiene SOLO esa parte (exceso máximo: una llamada por ejecutor concurrente). Un reintento manual o una
 *     regeneración le dan un presupuesto nuevo (la parte siempre se puede recuperar). La primera llamada pasa.
 *  3. Disyuntor (circuit breaker) del run: el gasto se compara con el costo ESPERADO del progreso real (partes
 *     terminadas, en curso o con gasto). Solo dispara ante una anomalía significativa y sistémica:
 *       gastado + esta llamada > BREAKER_RATIO × esperado(progreso) + max(BREAKER_MIN_SLACK_USD, BREAKER_SLACK_SHARE × esperado(run))
 *     → el run se pausa (pausa segura, reanudable). Unos centavos de más nunca lo disparan.
 *
 * Puro: sin I/O. FinopsBudgetService junta los números y aplica la decisión.
 */

export const ITEM_HARD_FACTOR = 2.5;
export const ITEM_HARD_FLOOR_USD = 0.25;
export const BREAKER_RATIO = 1.5;
export const BREAKER_MIN_SLACK_USD = 3;
export const BREAKER_SLACK_SHARE = 0.1;

export type RunSpendDecision =
  | { allow: true; reason: 'ok'; itemHardLimit: number | null; breakerThreshold: number | null }
  | { allow: false; reason: 'run_budget_cap' | 'item_recovery_budget_exhausted' | 'circuit_breaker'; detail: string; itemHardLimit: number | null; breakerThreshold: number | null };

export interface RunSpendInput {
  /** Autorización vigente del run (USD). null = sin tope conocido (no se aplica el punto 1). */
  authorizedBudget: number | null;
  /** Gastado por el run (ledger: cargos + ajustes + reservas pendientes). */
  runSpent: number;
  /** Costo (cota) de la llamada que se va a hacer. */
  nextCost: number;
  /** Gastado por ESTA parte (todas las capas / intentos / generaciones). null = la llamada no está atribuida a una parte. */
  itemSpent: number | null;
  /** Costo esperado y máximo estimado de la parte (estimado del run). null = sin estimado para la parte. */
  itemExpected: number | null;
  itemEstimatedMax: number | null;
  /** Costo esperado del run completo y del progreso real (terminadas + en curso). null = sin estimado. */
  runExpected: number | null;
  progressExpected: number | null;
  /** Mayor cargo/reserva individual de la parte en su ventana (re-review N1: la holgura se mide con la llamada MÁS grande). */
  itemLargestCall?: number;
  /** Sobreconsumo ya aceptado por el usuario al reanudar tras una pausa del disyuntor (se suma al umbral). */
  breakerAcknowledgedUsd?: number;
}

/** Llamadas fallidas (cota de cada una) que el presupuesto de una parte absorbe SIEMPRE además de su costo esperado. */
export const ITEM_FAILED_CALLS_ALLOWANCE = 3;

/**
 * Límite duro de una parte. `nextCallBound` (cota de la llamada siguiente) asegura que errores transitorios normales
 * (cada uno puede dejar una reserva pendiente a max_tokens) no la agoten: siempre caben esperado + 3 llamadas fallidas.
 */
export function itemHardLimit(expected: number | null, estimatedMax: number | null, nextCallBound = 0): number | null {
  if (expected === null || !(expected >= 0)) return null;
  return Math.max(
    ITEM_HARD_FACTOR * expected,
    estimatedMax !== null && estimatedMax > 0 ? estimatedMax : 0,
    ITEM_HARD_FLOOR_USD,
    expected + ITEM_FAILED_CALLS_ALLOWANCE * Math.max(0, nextCallBound),
  );
}

export function breakerThreshold(runExpected: number | null, progressExpected: number | null): number | null {
  if (runExpected === null || progressExpected === null || !(runExpected > 0)) return null;
  return BREAKER_RATIO * progressExpected + Math.max(BREAKER_MIN_SLACK_USD, BREAKER_SLACK_SHARE * runExpected);
}

const usd = (n: number) => `USD ${n.toFixed(2)}`;

export function decideRunSpend(i: RunSpendInput): RunSpendDecision {
  const hard = itemHardLimit(i.itemExpected, i.itemEstimatedMax, Math.max(i.nextCost, i.itemLargestCall ?? 0));
  const base = breakerThreshold(i.runExpected, i.progressExpected);
  const breaker = base === null ? null : base + Math.max(0, i.breakerAcknowledgedUsd ?? 0);
  const after = i.runSpent + i.nextCost;
  if (i.authorizedBudget !== null && after > i.authorizedBudget + 1e-9) {
    return {
      allow: false, reason: 'run_budget_cap', itemHardLimit: hard, breakerThreshold: breaker,
      detail: `el run llegaría a ${usd(after)} con esta llamada y el presupuesto autorizado es ${usd(i.authorizedBudget)}`,
    };
  }
  // La cota de la llamada siguiente es muy conservadora (max_tokens completo): se compara lo YA gastado (cargos
  // + reservas pendientes) contra el límite. Mientras no se alcanzó, la parte puede seguir recuperándose; el
  // exceso posible queda acotado a UNA llamada.
  if (hard !== null && i.itemSpent !== null && i.itemSpent >= hard - 1e-9) {
    return {
      allow: false, reason: 'item_recovery_budget_exhausted', itemHardLimit: hard, breakerThreshold: breaker,
      detail: `esta parte ya gastó ${usd(i.itemSpent)} (esperado ${usd(i.itemExpected ?? 0)}, presupuesto de recuperación hasta ${usd(hard)})`,
    };
  }
  if (breaker !== null && after > breaker + 1e-9) {
    return {
      allow: false, reason: 'circuit_breaker', itemHardLimit: hard, breakerThreshold: breaker,
      detail: `consumo anómalo: el run llevaría ${usd(after)} cuando lo esperado para su avance es ${usd(i.progressExpected ?? 0)} (umbral ${usd(breaker)})`,
    };
  }
  return { allow: true, reason: 'ok', itemHardLimit: hard, breakerThreshold: breaker };
}

/** Código estable del fallo de una parte que agotó su presupuesto de recuperación (clase D, solo esa parte). */
export const ITEM_RECOVERY_BUDGET_EXHAUSTED = 'item_recovery_budget_exhausted';

export function itemRecoveryBudgetMessage(detail: string): string {
  return `${ITEM_RECOVERY_BUDGET_EXHAUSTED}: ${detail}. Se detiene solo esta parte (presupuesto de recuperación agotado); el resto del curso sigue.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// r62 (regla de ambigüedad acotada, punto 3) — ¿cabe UN reenvío de una llamada pagada con resultado ambiguo?
//
// Sin idempotencia ni consulta de estado (OpenAI TTS, Anthropic) el reenvío puede cobrar dos veces. Se acepta UNA
// vez por parte solo si el PEOR caso entra en los límites que el usuario ya autorizó:
//   - la reserva perdida ya está contada como gasto (liquidada como `charged` + `possible_duplicate`): itemSpent y
//     runSpent la incluyen;
//   - la reserva NUEVA (nextCost) se suma encima: itemSpent + nextCost ≤ presupuesto de recuperación de la parte y
//     runSpent + nextCost ≤ saldo autorizado del run.
// Puro. Reemplaza el tope fijo de USD 0,10 de #583.
// ─────────────────────────────────────────────────────────────────────────────

export type AmbiguousResendBudgetReason = 'item_recovery_budget' | 'run_budget' | 'no_authorization' | 'no_item_estimate';

export interface AmbiguousResendBudgetInput {
  /** Gastado por la parte en su ventana (incluye la reserva perdida). */
  itemSpent: number;
  /** Cota de la reserva del reenvío. */
  nextCost: number;
  /** Presupuesto de recuperación de la parte (itemHardLimit). null = sin estimado de la parte. */
  itemHardLimit: number | null;
  /** Gastado por el run (incluye la reserva perdida). */
  runSpent: number;
  /** Saldo autorizado del run. null = sin autorización vigente. */
  authorizedBudget: number | null;
}

export interface AmbiguousResendBudget {
  fits: boolean;
  reason: AmbiguousResendBudgetReason | null;
  itemSpent: number;
  nextCost: number;
  itemHardLimit: number | null;
  runSpent: number;
  authorizedBudget: number | null;
  /** Peor caso de la parte y del run si se reenvía. */
  worstItem: number;
  worstRun: number;
}

export function ambiguousResendBudget(i: AmbiguousResendBudgetInput): AmbiguousResendBudget {
  const nextCost = Math.max(0, Number(i.nextCost) || 0);
  const worstItem = Math.max(0, Number(i.itemSpent) || 0) + nextCost;
  const worstRun = Math.max(0, Number(i.runSpent) || 0) + nextCost;
  const base = { itemSpent: i.itemSpent, nextCost, itemHardLimit: i.itemHardLimit, runSpent: i.runSpent, authorizedBudget: i.authorizedBudget, worstItem, worstRun };
  // Falla cerrado: sin autorización o sin presupuesto de la parte no hay techo contra el cual acotar el duplicado.
  if (i.authorizedBudget === null || !Number.isFinite(i.authorizedBudget)) return { ...base, fits: false, reason: 'no_authorization' };
  if (i.itemHardLimit === null || !Number.isFinite(i.itemHardLimit)) return { ...base, fits: false, reason: 'no_item_estimate' };
  if (worstItem > i.itemHardLimit + 1e-9) return { ...base, fits: false, reason: 'item_recovery_budget' };
  if (worstRun > i.authorizedBudget + 1e-9) return { ...base, fits: false, reason: 'run_budget' };
  return { ...base, fits: true, reason: null };
}
