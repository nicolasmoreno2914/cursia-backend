/**
 * r90 — «tope de seguridad» de un run (decisión del dueño 2026-11-03). Puro: sin DB, sin reloj, sin random.
 *
 * Antes el máximo visible y el que decidía la política era Σ precio(p90) × (1 + maxRetries): ≈ 5,5× el esperado
 * (curso S: esperado USD 34.66 → máximo USD 191.45), cuando los costos reales quedaron cerca del esperado (#91: 35.0
 * vs 35.8; #93: 23.4 vs 34.7). Ahora:
 *
 *   tope de seguridad = redondeo HACIA ARRIBA al centavo de (esperado × FINOPS_RUN_SAFETY_CAP_FACTOR)
 *
 * (factor default 1,5; acotado a [1,1, 3]; inválido → 1,5). El tope es lo que se muestra, lo que evalúa la política
 * (maxCostPerRun / maxCostPerCourse / mensuales / por proveedor / por tipo) y el monto autorizado del run: si la
 * generación lo alcanza, el guard de gasto pausa el run como en cualquier presupuesto autorizado (run-spend-guard +
 * finops-budget.service `guardLlmCallForRun` / reserva del ledger → `pauseRunBySystem`). El máximo p90 se conserva en
 * `totals.max` y en cada línea (diagnóstico y presupuesto de recuperación por parte), pero ya no decide nada visible.
 */
import { MONEY_SCALE, fromScaled, toScaled, DecimalLike } from './decimal';
import type { MinExpMax } from './estimator';

export const FINOPS_RUN_SAFETY_CAP_FACTOR_ENV = 'FINOPS_RUN_SAFETY_CAP_FACTOR';
export const DEFAULT_SAFETY_CAP_FACTOR = 1.5;
export const SAFETY_CAP_FACTOR_MIN = 1.1;
export const SAFETY_CAP_FACTOR_MAX = 3;

/** Factor del tope desde un valor crudo (env). Ausente, no numérico o fuera de [1,1, 3] → 1,5 (nunca lanza). */
export function parseSafetyCapFactor(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_SAFETY_CAP_FACTOR;
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return DEFAULT_SAFETY_CAP_FACTOR;
  const n = Number(s);
  if (!Number.isFinite(n) || n < SAFETY_CAP_FACTOR_MIN || n > SAFETY_CAP_FACTOR_MAX) return DEFAULT_SAFETY_CAP_FACTOR;
  return n;
}

/**
 * Review P2-4: aviso (null = nada que avisar) cuando FINOPS_RUN_SAFETY_CAP_FACTOR está definida pero es inválida o está
 * fuera de [1,1, 3] y por eso se usa 1,5. Lo registra FinopsBudgetService al arrancar.
 */
export function safetyCapFactorWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[FINOPS_RUN_SAFETY_CAP_FACTOR_ENV];
  if (raw === undefined || raw === '') return null;
  const used = parseSafetyCapFactor(raw);
  if (used !== DEFAULT_SAFETY_CAP_FACTOR || Number(String(raw).trim()) === DEFAULT_SAFETY_CAP_FACTOR) return null;
  return `${FINOPS_RUN_SAFETY_CAP_FACTOR_ENV}=${JSON.stringify(raw)} es inválido o está fuera de [${SAFETY_CAP_FACTOR_MIN}, ${SAFETY_CAP_FACTOR_MAX}] (decimal con punto, hasta 6 decimales): se usa ${DEFAULT_SAFETY_CAP_FACTOR}`;
}

export function readSafetyCapFactor(env: NodeJS.ProcessEnv = process.env): number {
  return parseSafetyCapFactor(env[FINOPS_RUN_SAFETY_CAP_FACTOR_ENV]);
}

const CENT = 10n ** BigInt(MONEY_SCALE - 2);
const SCALE = 10n ** BigInt(MONEY_SCALE);

/** redondeo hacia arriba al centavo de (monto × factor). Monto ≤ 0 → 0. */
export function safetyCapOf(expected: DecimalLike, factor: number = DEFAULT_SAFETY_CAP_FACTOR): string {
  const f = parseSafetyCapFactor(factor);
  const e = toScaled(expected, 'expected');
  if (e <= 0n) return fromScaled(0n);
  const prod = e * toScaled(String(f), 'factor'); // escala 1e20
  const unit = SCALE * CENT; // un centavo en escala 1e20
  const cents = (prod + unit - 1n) / unit;
  return fromScaled(cents * CENT);
}

type WithBreakdown = MinExpMax & {
  safetyCap?: string;
  capFactor?: number;
  byProvider?: Record<string, MinExpMax>;
  byItemType?: Record<string, MinExpMax>;
};


/** Factor efectivo de un estimado: el que trae (`totals.capFactor`) o el default. */
export function capFactorOf(estimate: { totals: { capFactor?: number } }): number {
  return parseSafetyCapFactor(estimate?.totals?.capFactor);
}

/** Tope de seguridad del estimado: `totals.safetyCap` o, en un estimado viejo sin él, esperado × factor. */
export function safetyCapOfEstimate(estimate: { totals: { expected: string; safetyCap?: string; capFactor?: number } }): string {
  const t = estimate.totals;
  return typeof t.safetyCap === 'string' && t.safetyCap ? t.safetyCap : safetyCapOf(t.expected, capFactorOf(estimate));
}

/**
 * Vista del estimado para la POLÍTICA y la autorización: el `max` de los TOTALES es el tope de seguridad.
 * evaluateBudget / planNormalApproval comparan `max` contra los límites totales (por run, por curso, mensuales) y
 * planNormalApproval autoriza `max` (acotado por los remanentes): con esta vista ambos usan el tope, sin tocar su lógica.
 * Review P2-1: los límites por PROVEEDOR / por TIPO de item siguen contra el máximo p90 × reintentos de esa parte
 * (`byProvider` / `byItemType` sin cambios): ningún guard los hace cumplir en tiempo de ejecución (una autorización total
 * no acota un solo servicio), así que solo el peor caso teórico los garantiza.
 */
export function policyEstimateView<T extends { totals: WithBreakdown }>(estimate: T): T {
  if (!estimate || !estimate.totals) return estimate;
  return { ...estimate, totals: { ...estimate.totals, max: safetyCapOfEstimate(estimate as any) } };
}
