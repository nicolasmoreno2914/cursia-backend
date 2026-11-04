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

function capRecord(r: Record<string, MinExpMax> | undefined, factor: number): Record<string, MinExpMax> | undefined {
  if (!r) return r;
  const out: Record<string, MinExpMax> = {};
  for (const k of Object.keys(r)) out[k] = { ...r[k], max: safetyCapOf(r[k].expected, factor) };
  return out;
}

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
 * Vista del estimado para la POLÍTICA y la autorización: el `max` de los totales (y de cada proveedor / tipo de item) es
 * el tope de seguridad. evaluateBudget / planNormalApproval comparan `max` contra los límites y planNormalApproval
 * autoriza `max` (acotado por los remanentes): con esta vista ambos usan el tope, sin tocar su lógica.
 */
export function policyEstimateView<T extends { totals: WithBreakdown }>(estimate: T): T {
  // (genérico: devuelve el mismo tipo con max reemplazado; los demás campos de totals se copian tal cual)
  if (!estimate || !estimate.totals) return estimate;
  const factor = capFactorOf(estimate);
  const t = estimate.totals;
  return {
    ...estimate,
    totals: {
      ...t,
      max: safetyCapOfEstimate(estimate as any),
      ...(t.byProvider ? { byProvider: capRecord(t.byProvider, factor) } : {}),
      ...(t.byItemType ? { byItemType: capRecord(t.byItemType, factor) } : {}),
    },
  };
}
