/**
 * V2.1 RF-a — estimación de costo ANTES del run (audit §W.6). Pura.
 *
 * Por item y operación:
 *   min      = precio(p10)                       (sin retries)
 *   expected = precio(p50) × (1 + retryRate)     (tasa observada/prior de retries)
 *   max      = precio(p90) × (1 + maxRetries)
 * Acciones GENERATE/REGENERATE suman incremental. REUSE / REVIEW /
 * STALE_NO_AUTO / SOFT_DISABLE valen 0 incremental; REUSE / REVIEW /
 * STALE_NO_AUTO se reportan como evitado con basis='current_estimate' (el
 * evitado "historical first" lo resuelve `incrementalCostForPlan`).
 */
import { FinopsError } from './errors';
import { addDec, mulDec, normalizeDecimal, DecimalLike } from './decimal';
import { priceUsage, PricingCatalogRow, UsageMeters } from './pricing';
import { operationsForItemType, FinopsItemType } from './operations';
import { UsageModel, assertValidUsageModel } from './usage-model';

export const ESTIMATOR_VERSION = 'finops-estimator-v1';

export const ESTIMATE_ACTIONS = ['GENERATE', 'REGENERATE', 'REUSE', 'REVIEW', 'STALE_NO_AUTO', 'SOFT_DISABLE'] as const;
export type EstimateAction = (typeof ESTIMATE_ACTIONS)[number];
export const INCREMENTAL_ACTIONS: readonly EstimateAction[] = ['GENERATE', 'REGENERATE'];
/** Acciones que conservan un artifact existente (cuentan como costo evitado). */
export const AVOIDING_ACTIONS: readonly EstimateAction[] = ['REUSE', 'REVIEW', 'STALE_NO_AUTO'];

export interface EstimateItem {
  itemKey: string;
  itemType: FinopsItemType | string;
  moduleId?: string | null;
  chapterId?: string | null;
  /** Default GENERATE (run nuevo sin plan de invalidación). */
  action?: EstimateAction | string | null;
}

export interface RetryPolicy {
  /** Máximo de reintentos pagados por operación (config del worker). Entero >= 0. */
  maxRetries: number;
  /** Tasa de retries esperada si la operación no trae la suya. Default: usageModel.defaultRetryRate ?? 0. */
  retryRate?: number;
}

export interface MinExpMax {
  min: string;
  expected: string;
  max: string;
}

export interface EstimateLine extends MinExpMax {
  itemKey: string;
  itemType: string;
  action: EstimateAction;
  moduleId: string | null;
  chapterId: string | null;
  operation: string;
  provider: string;
  service: string;
  product: string;
  /** true = GENERATE/REGENERATE (min/expected/max son incrementales). */
  incremental: boolean;
  /** Costo que tendría generar el item (independiente de la acción). */
  wouldCost: MinExpMax;
  basis: 'usage_model';
  pricingVersions: string[];
}

export interface AvoidedLine {
  itemKey: string;
  itemType: string;
  action: EstimateAction;
  expected: string;
  basis: 'current_estimate';
}

export interface EstimateResult {
  estimatorVersion: string;
  usageModelVersion: string;
  currency: string;
  pricingVersions: string[];
  lines: EstimateLine[];
  totals: MinExpMax & {
    byProvider: Record<string, MinExpMax>;
    byItemType: Record<string, MinExpMax>;
    byChapter: Record<string, MinExpMax>;
  };
  avoided: { expected: string; byItem: AvoidedLine[] };
}

export interface EstimateCostInput {
  items: readonly EstimateItem[];
  catalog: readonly PricingCatalogRow[];
  usageModel: UsageModel;
  retryPolicy: RetryPolicy;
  /** Instante de precios (opcional). Sin él: filas vigentes abiertas. */
  pricingAsOf?: string | Date | null;
}

/** Clave de agrupación para items sin capítulo (course/module scope). */
export const NO_CHAPTER_KEY = '_none';

const ZERO = normalizeDecimal(0);

function zero(): MinExpMax {
  return { min: ZERO, expected: ZERO, max: ZERO };
}

function addInto(map: Record<string, MinExpMax>, key: string, v: MinExpMax): void {
  const cur = map[key] || zero();
  map[key] = { min: addDec(cur.min, v.min), expected: addDec(cur.expected, v.expected), max: addDec(cur.max, v.max) };
}

function usageAt(meters: Record<string, { p10: DecimalLike; p50: DecimalLike; p90: DecimalLike }>, p: 'p10' | 'p50' | 'p90'): UsageMeters {
  const out: UsageMeters = {};
  for (const m of Object.keys(meters).sort()) out[m] = meters[m][p];
  return out;
}

function sortedRecord<T>(r: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(r).sort()) out[k] = r[k];
  return out;
}

export function estimateCost(input: EstimateCostInput): EstimateResult {
  if (!input || !Array.isArray(input.items)) throw new FinopsError('INVALID_INPUT', 'estimateCost necesita items[]');
  assertValidUsageModel(input.usageModel);
  const rp = input.retryPolicy;
  if (!rp || !Number.isInteger(rp.maxRetries) || rp.maxRetries < 0) {
    throw new FinopsError('INVALID_INPUT', 'retryPolicy.maxRetries debe ser entero >= 0');
  }
  const defaultRate = rp.retryRate ?? input.usageModel.defaultRetryRate ?? 0;

  const lines: EstimateLine[] = [];
  const avoided: AvoidedLine[] = [];
  const byProvider: Record<string, MinExpMax> = {};
  const byItemType: Record<string, MinExpMax> = {};
  const byChapter: Record<string, MinExpMax> = {};
  const versions = new Set<string>();
  let total = zero();
  let avoidedTotal = ZERO;
  let currency: string | null = null;
  const seenKeys = new Set<string>();

  for (const item of input.items) {
    if (!item || typeof item.itemKey !== 'string' || !item.itemKey) throw new FinopsError('INVALID_INPUT', 'item sin itemKey');
    if (seenKeys.has(item.itemKey)) throw new FinopsError('INVALID_INPUT', `itemKey duplicado: ${item.itemKey}`);
    seenKeys.add(item.itemKey);
    const action = (item.action ?? 'GENERATE') as EstimateAction;
    if (!(ESTIMATE_ACTIONS as readonly string[]).includes(action)) {
      throw new FinopsError('UNKNOWN_ACTION', `acción desconocida ${String(item.action)} en ${item.itemKey}`);
    }
    const incremental = INCREMENTAL_ACTIONS.includes(action);
    const ops = operationsForItemType(item.itemType);
    let itemWould = ZERO;
    for (const operation of ops) {
      const def = input.usageModel.operations[operation];
      if (!def) throw new FinopsError('USAGE_MODEL_MISSING', `usageModel sin la operación ${operation} (item ${item.itemKey})`);
      const rate = def.retryRate ?? defaultRate;
      if (!(rate >= 0) || rate > rp.maxRetries) {
        throw new FinopsError('INVALID_INPUT', `retryRate ${rate} de ${operation} fuera de [0, maxRetries=${rp.maxRetries}]`);
      }
      const at = { provider: def.provider, service: def.service, product: def.product, asOf: input.pricingAsOf ?? null };
      const p10 = priceUsage(usageAt(def.meters, 'p10'), input.catalog, at);
      const p50 = priceUsage(usageAt(def.meters, 'p50'), input.catalog, at);
      const p90 = priceUsage(usageAt(def.meters, 'p90'), input.catalog, at);
      for (const r of [p10, p50, p90]) {
        if (r.lines.length === 0) continue;
        if (currency !== null && r.currency !== currency) throw new FinopsError('CURRENCY_MISMATCH', `${currency} vs ${r.currency}`);
        currency = r.currency;
        r.pricingSnapshot.pricing_versions.forEach((v) => versions.add(v));
      }
      const would: MinExpMax = {
        min: p10.amount,
        expected: mulDec(p50.amount, 1 + rate),
        max: mulDec(p90.amount, 1 + rp.maxRetries),
      };
      const inc = incremental ? would : zero();
      const line: EstimateLine = {
        itemKey: item.itemKey,
        itemType: item.itemType,
        action,
        moduleId: item.moduleId ?? null,
        chapterId: item.chapterId ?? null,
        operation,
        provider: def.provider,
        service: def.service,
        product: def.product,
        incremental,
        ...inc,
        wouldCost: would,
        basis: 'usage_model',
        pricingVersions: Array.from(new Set([...p10.pricingSnapshot.pricing_versions, ...p90.pricingSnapshot.pricing_versions])).sort(),
      };
      lines.push(line);
      itemWould = addDec(itemWould, would.expected);
      total = { min: addDec(total.min, inc.min), expected: addDec(total.expected, inc.expected), max: addDec(total.max, inc.max) };
      addInto(byProvider, def.provider, inc);
      addInto(byItemType, item.itemType, inc);
      addInto(byChapter, item.chapterId ?? NO_CHAPTER_KEY, inc);
    }
    if (AVOIDING_ACTIONS.includes(action)) {
      avoided.push({ itemKey: item.itemKey, itemType: item.itemType, action, expected: itemWould, basis: 'current_estimate' });
      avoidedTotal = addDec(avoidedTotal, itemWould);
    }
  }

  return {
    estimatorVersion: ESTIMATOR_VERSION,
    usageModelVersion: input.usageModel.version,
    currency: currency ?? 'USD',
    pricingVersions: Array.from(versions).sort(),
    lines,
    totals: { ...total, byProvider: sortedRecord(byProvider), byItemType: sortedRecord(byItemType), byChapter: sortedRecord(byChapter) },
    avoided: { expected: avoidedTotal, byItem: avoided },
  };
}
