/**
 * V2.1 RF-a — costo incremental y costo evitado de un plan de invalidación
 * (audit §W.5, HD-V21-18). Puro.
 *
 * Evitado = **historical actual first**: suma de los CHARGE + ADJUSTMENT del
 * item run de origen (incluye sus retries pagados). Si ese item run no tiene
 * historia en el ledger (datos previos al ledger), se usa la estimación
 * vigente (`wouldCost.expected` de las líneas del estimador) con
 * basis='current_estimate'. REFUND no descuenta (regla del brief: CHARGE + ADJUSTMENT).
 */
import { FinopsError } from './errors';
import { addDec, normalizeDecimal } from './decimal';
import { AVOIDING_ACTIONS, ESTIMATE_ACTIONS, INCREMENTAL_ACTIONS, EstimateAction, EstimateLine, MinExpMax } from './estimator';

export interface PlanActionInput {
  itemKey: string;
  action: EstimateAction | string;
  /** Item run de origen (nombre del plan de invalidación: fromItemRunId). */
  fromItemRunId?: string | null;
  sourceItemRunId?: string | null;
}

export interface HistoricalCostEvent {
  id: string;
  event_kind: 'CHARGE' | 'ADJUSTMENT' | 'REFUND' | string;
  amount: string | number;
}

export type HistoricalByItemRun = Record<string, readonly HistoricalCostEvent[] | undefined>;

export type AvoidedBasis = 'historical_actual' | 'current_estimate';

export interface IncrementalActionResult {
  itemKey: string;
  action: EstimateAction;
  incremental: MinExpMax;
  avoided: string;
  basis: AvoidedBasis | null;
  sourceItemRunId: string | null;
  sourceChargeEventIds: string[];
}

export interface IncrementalPlanResult {
  actions: IncrementalActionResult[];
  totals: { incremental: MinExpMax; avoided: string; avoidedByBasis: Record<AvoidedBasis, string> };
}

const ZERO = normalizeDecimal(0);

export function incrementalCostForPlan(
  planActions: readonly PlanActionInput[],
  estimateLines: readonly EstimateLine[],
  historicalByItemRun: HistoricalByItemRun,
): IncrementalPlanResult {
  if (!Array.isArray(planActions)) throw new FinopsError('INVALID_INPUT', 'planActions debe ser un array');
  const linesByKey = new Map<string, EstimateLine[]>();
  for (const l of estimateLines || []) {
    const arr = linesByKey.get(l.itemKey) || [];
    arr.push(l);
    linesByKey.set(l.itemKey, arr);
  }
  const hist = historicalByItemRun || {};
  const out: IncrementalActionResult[] = [];
  let incTotal: MinExpMax = { min: ZERO, expected: ZERO, max: ZERO };
  let avoidedTotal = ZERO;
  const byBasis: Record<AvoidedBasis, string> = { historical_actual: ZERO, current_estimate: ZERO };

  for (const pa of planActions) {
    const action = pa.action as EstimateAction;
    if (!(ESTIMATE_ACTIONS as readonly string[]).includes(action)) {
      throw new FinopsError('UNKNOWN_ACTION', `acción desconocida ${String(pa.action)} en ${pa.itemKey}`);
    }
    const lines = linesByKey.get(pa.itemKey) || [];
    const sourceItemRunId = pa.sourceItemRunId ?? pa.fromItemRunId ?? null;
    let incremental: MinExpMax = { min: ZERO, expected: ZERO, max: ZERO };
    let avoided = ZERO;
    let basis: AvoidedBasis | null = null;
    let sourceChargeEventIds: string[] = [];

    if (INCREMENTAL_ACTIONS.includes(action)) {
      if (lines.length === 0) throw new FinopsError('INVALID_INPUT', `sin líneas de estimación para ${pa.itemKey} (${action})`);
      incremental = {
        min: addDec(ZERO, ...lines.map((l) => l.wouldCost.min)),
        expected: addDec(ZERO, ...lines.map((l) => l.wouldCost.expected)),
        max: addDec(ZERO, ...lines.map((l) => l.wouldCost.max)),
      };
    } else if (AVOIDING_ACTIONS.includes(action)) {
      const events = (sourceItemRunId && hist[sourceItemRunId]) || [];
      const counted = events.filter((e) => e.event_kind === 'CHARGE' || e.event_kind === 'ADJUSTMENT');
      if (counted.length > 0) {
        basis = 'historical_actual';
        avoided = addDec(ZERO, ...counted.map((e) => e.amount));
        sourceChargeEventIds = counted.map((e) => String(e.id)).sort();
      } else {
        if (lines.length === 0) throw new FinopsError('INVALID_INPUT', `sin historia ni estimación para el evitado de ${pa.itemKey}`);
        basis = 'current_estimate';
        avoided = addDec(ZERO, ...lines.map((l) => l.wouldCost.expected));
      }
      byBasis[basis] = addDec(byBasis[basis], avoided);
    }
    // SOFT_DISABLE: sale del destino — 0 incremental, 0 evitado.

    incTotal = {
      min: addDec(incTotal.min, incremental.min),
      expected: addDec(incTotal.expected, incremental.expected),
      max: addDec(incTotal.max, incremental.max),
    };
    avoidedTotal = addDec(avoidedTotal, avoided);
    out.push({ itemKey: pa.itemKey, action, incremental, avoided, basis, sourceItemRunId, sourceChargeEventIds });
  }
  return { actions: out, totals: { incremental: incTotal, avoided: avoidedTotal, avoidedByBasis: byBasis } };
}
