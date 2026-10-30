/**
 * V2.1 RF-a — estimación de costo ANTES del run (audit §W.6). Pura.
 *
 * Por item y operación:
 *   min      = precio(p10)                       (sin retries)
 *   expected = precio(p50) × (1 + retryRate)     (tasa observada/prior de retries)
 *   max      = precio(p90) × (1 + maxRetries)
 * V542 (v2): `usageScale` por item escala el uso (p10/p50/p90) de sus operaciones — el banco de un
 * examen crece con los capítulos que cubre (ver `examBankUsageScale` en run-budget.ts) — y el
 * resultado separa la reserva por reintentos (`retryRate` por línea, `totals.retryAllowance`).
 * Acciones GENERATE/REGENERATE suman incremental. REUSE / REVIEW /
 * STALE_NO_AUTO / SOFT_DISABLE valen 0 incremental; REUSE / REVIEW /
 * STALE_NO_AUTO se reportan como evitado con basis='current_estimate' (el
 * evitado "historical first" lo resuelve `incrementalCostForPlan`).
 */
import { FinopsError } from './errors';
import { addDec, fromScaled, mulDec, normalizeDecimal, toScaled, DecimalLike } from './decimal';
import { priceUsage, PricingCatalogRow, UsageMeters } from './pricing';
import { operationsForItemType, FinopsItemType } from './operations';
import { UsageModel, assertValidUsageModel } from './usage-model';

export const ESTIMATOR_VERSION = 'finops-estimator-v2';

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
  /**
   * V542: multiplicador del uso del usage model (> 0; default 1), único o por medidor
   * (`{ input_tokens, output_tokens }`; un medidor ausente = 1). Lo fija quien arma los items cuando
   * el trabajo real escala con el curso (banco de un examen, ver run-budget.ts examBankUsageScale).
   */
  usageScale?: UsageScale | null;
}

export type UsageScale = number | Readonly<Record<string, number>>;

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
  /** V542: tasa de reintentos aplicada a expected (op.retryRate ?? retryPolicy/default). */
  retryRate: number;
  /** V542: multiplicador de uso del item (solo si se pidió uno ≠ 1). */
  usageScale?: UsageScale;
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
    /**
     * V542: parte del total por reintentos — expected: Σ precio(p50)·retryRate; max: Σ precio(p90)·maxRetries
     * (incrementales). El resto del total es el uso del usage model sin reintentos.
     */
    retryAllowance: { expected: string; max: string };
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

interface ScaledMEM { min: bigint; expected: bigint; max: bigint }
function addScaled(map: Map<string, ScaledMEM>, key: string, v: ScaledMEM): void {
  const cur = map.get(key);
  if (cur) { cur.min += v.min; cur.expected += v.expected; cur.max += v.max; } else map.set(key, { min: v.min, expected: v.expected, max: v.max });
}
function memOf(v: ScaledMEM): MinExpMax {
  return { min: fromScaled(v.min), expected: fromScaled(v.expected), max: fromScaled(v.max) };
}
function recordOf(m: Map<string, ScaledMEM>): Record<string, MinExpMax> {
  const out: Record<string, MinExpMax> = {};
  for (const [k, v] of m) out[k] = memOf(v);
  return out;
}


function scaleOf(scale: UsageScale, meter: string): number {
  return typeof scale === 'number' ? scale : scale[meter] ?? 1;
}

function usageAt(meters: Record<string, { p10: DecimalLike; p50: DecimalLike; p90: DecimalLike }>, p: 'p10' | 'p50' | 'p90', scale: UsageScale = 1): UsageMeters {
  const out: UsageMeters = {};
  // Escala ≠ 1: unidades enteras hacia arriba (tokens/créditos) — nunca subestima.
  for (const m of Object.keys(meters).sort()) {
    const k = scaleOf(scale, m);
    out[m] = k === 1 ? meters[m][p] : String(Math.ceil(Number(meters[m][p]) * k));
  }
  return out;
}

function isUnitScale(scale: UsageScale): boolean {
  return typeof scale === 'number' ? scale === 1 : Object.values(scale).every((v) => v === 1);
}

function sortedRecord<T>(r: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(r).sort()) out[k] = r[k];
  return out;
}

/**
 * r79.1 (rendimiento): `priceUsage` es pura (mismo uso + mismo catálogo + mismo instante → mismo resultado); el ajuste al
 * presupuesto la llama miles de veces con los mismos tres usos por operación. Caché por catálogo (WeakMap: muere con él) y
 * por (proveedor, servicio, producto, instante, uso). Resultado idéntico, solo más rápido (lo prueba check-r79-1).
 */
const PRICE_CACHE = new WeakMap<readonly PricingCatalogRow[], Map<string, ReturnType<typeof priceUsage>>>();
const PRICE_CACHE_MAX = 20000;
function cachedPriceUsage(usage: UsageMeters, catalog: readonly PricingCatalogRow[], at: { provider: string; service: string; product: string; asOf: string | Date | null }): ReturnType<typeof priceUsage> {
  let m = PRICE_CACHE.get(catalog);
  if (!m) { m = new Map(); PRICE_CACHE.set(catalog, m); }
  const asOf = at.asOf instanceof Date ? at.asOf.toISOString() : at.asOf === null ? '' : String(at.asOf);
  const key = `${at.provider}\u0000${at.service}\u0000${at.product}\u0000${asOf}\u0000${JSON.stringify(usage)}`;
  const hit = m.get(key);
  if (hit) return hit;
  const r = priceUsage(usage, catalog, at);
  if (m.size >= PRICE_CACHE_MAX) m.clear();
  m.set(key, r);
  return r;
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
  // r79.1 (rendimiento): los totales se acumulan en enteros escalados (la suma decimal es exacta: mismo resultado que
  // sumar los strings uno por uno) y se convierten a string una sola vez al final.
  const byProviderS = new Map<string, ScaledMEM>();
  const byItemTypeS = new Map<string, ScaledMEM>();
  const byChapterS = new Map<string, ScaledMEM>();
  const versions = new Set<string>();
  const totalS: ScaledMEM = { min: 0n, expected: 0n, max: 0n };
  let retryExpectedS = 0n;
  let retryMaxS = 0n;
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
    const scale: UsageScale = item.usageScale ?? 1;
    const factors = typeof scale === 'number' ? [scale] : scale && typeof scale === 'object' ? Object.values(scale) : [NaN];
    if (!factors.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100)) {
      throw new FinopsError('INVALID_INPUT', `usageScale inválido en ${item.itemKey}: ${JSON.stringify(item.usageScale)}`);
    }
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
      const p10 = cachedPriceUsage(usageAt(def.meters, 'p10', scale), input.catalog, at);
      const p50 = cachedPriceUsage(usageAt(def.meters, 'p50', scale), input.catalog, at);
      const p90 = cachedPriceUsage(usageAt(def.meters, 'p90', scale), input.catalog, at);
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
        retryRate: rate,
        ...(!isUnitScale(scale) ? { usageScale: scale } : {}),
        basis: 'usage_model',
        pricingVersions: Array.from(new Set([...p10.pricingSnapshot.pricing_versions, ...p90.pricingSnapshot.pricing_versions])).sort(),
      };
      lines.push(line);
      itemWould = addDec(itemWould, would.expected);
      const incS: ScaledMEM = incremental ? { min: toScaled(inc.min), expected: toScaled(inc.expected), max: toScaled(inc.max) } : { min: 0n, expected: 0n, max: 0n };
      totalS.min += incS.min; totalS.expected += incS.expected; totalS.max += incS.max;
      if (incremental) {
        retryExpectedS += toScaled(mulDec(p50.amount, rate));
        retryMaxS += toScaled(mulDec(p90.amount, rp.maxRetries));
      }
      addScaled(byProviderS, def.provider, incS);
      addScaled(byItemTypeS, item.itemType, incS);
      addScaled(byChapterS, item.chapterId ?? NO_CHAPTER_KEY, incS);
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
    totals: { ...memOf(totalS), retryAllowance: { expected: fromScaled(retryExpectedS), max: fromScaled(retryMaxS) }, byProvider: sortedRecord(recordOf(byProviderS)), byItemType: sortedRecord(recordOf(byItemTypeS)), byChapter: sortedRecord(recordOf(byChapterS)) },
    avoided: { expected: avoidedTotal, byItem: avoided },
  };
}
