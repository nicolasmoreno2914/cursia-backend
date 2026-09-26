/**
 * V2.1 RF-a — precio de un uso medido contra el `pricing_catalog` (audit §W.2/§W.3).
 *
 * Puro: sin DB, sin reloj. Si el caller no pasa `asOf`, se usan las filas
 * vigentes "abiertas" (effective_to null) — nunca `Date.now()`.
 *
 * El snapshot devuelto COPIA los valores usados (precio, tamaño de unidad,
 * versión, moneda, vigencia, id de fila): un cambio posterior del catálogo
 * (fila nueva) nunca altera un evento ya registrado.
 */
import { FinopsError } from './errors';
import { addDec, priceLine, normalizeDecimal, toScaled, DecimalLike } from './decimal';

/** Medidores conocidos (audit §W.3). Un medidor desconocido igual se acepta si tiene precio. */
export const KNOWN_METERS = [
  'input_tokens',
  'output_tokens',
  'cache_write_tokens',
  'cache_read_tokens',
  'text_input_tokens',
  'audio_output_tokens',
  'audio_seconds',
  'characters',
  'video_render',
  'gamma_credit',
  'request',
  'quota_unit',
] as const;

/** Uso medido: medidor → cantidad (>= 0). Cantidad 0 o ausente = no se cobra ese medidor. */
export type UsageMeters = Record<string, DecimalLike | null | undefined>;

export interface PricingCatalogRow {
  id?: string | number | null;
  provider: string;
  service: string;
  product_or_model: string;
  meter: string;
  unit_size: DecimalLike;
  unit_price: DecimalLike;
  currency: string;
  pricing_version: string;
  effective_from: string | Date;
  effective_to?: string | Date | null;
  source?: string | null;
  source_ref?: string | null;
  verified?: boolean | null;
}

export interface PricingTarget {
  provider: string;
  service: string;
  product: string;
  /** Instante para elegir la fila vigente. Sin él: filas abiertas (effective_to null). */
  asOf?: string | Date | null;
}

export interface PricedLine {
  meter: string;
  qty: string;
  unit_size: string;
  unit_price: string;
  currency: string;
  pricing_version: string;
  effective_from: string;
  pricing_catalog_id: string | null;
  verified: boolean;
  source: string | null;
  amount: string;
}

export interface PricingSnapshot {
  provider: string;
  service: string;
  product: string;
  currency: string;
  pricing_catalog_ids: string[];
  pricing_versions: string[];
  lines: PricedLine[];
}

export interface PriceUsageResult {
  amount: string;
  currency: string;
  lines: PricedLine[];
  pricingSnapshot: PricingSnapshot;
}

function toMillis(v: string | Date | null | undefined, what: string): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  if (!Number.isFinite(t)) throw new FinopsError('INVALID_INPUT', `${what} no es una fecha válida: ${String(v)}`);
  return t;
}

function isoOf(v: string | Date): string {
  return new Date(toMillis(v, 'effective_from') as number).toISOString();
}

/** Elige la fila de precio de un medidor. Fail loud si no hay o si es ambigua. */
export function selectPriceRow(
  catalogRows: readonly PricingCatalogRow[],
  at: PricingTarget,
  meter: string,
): PricingCatalogRow {
  const asOf = toMillis(at.asOf ?? null, 'asOf');
  const candidates = catalogRows.filter((r) => {
    if (r.provider !== at.provider || r.service !== at.service || r.product_or_model !== at.product || r.meter !== meter) return false;
    const from = toMillis(r.effective_from, 'effective_from') as number;
    const to = toMillis(r.effective_to ?? null, 'effective_to');
    if (asOf === null) return to === null;
    return from <= asOf && (to === null || asOf < to);
  });
  if (candidates.length === 0) {
    throw new FinopsError(
      'PRICING_MISSING',
      `sin precio para ${at.provider}/${at.service}/${at.product} medidor "${meter}"` +
        (asOf === null ? ' (vigente)' : ` al ${new Date(asOf).toISOString()}`),
      { provider: at.provider, service: at.service, product: at.product, meter },
    );
  }
  let best = candidates[0];
  let bestFrom = toMillis(best.effective_from, 'effective_from') as number;
  let tie = false;
  for (const r of candidates.slice(1)) {
    const f = toMillis(r.effective_from, 'effective_from') as number;
    if (f > bestFrom) {
      best = r;
      bestFrom = f;
      tie = false;
    } else if (f === bestFrom) {
      tie = true;
    }
  }
  if (tie) {
    throw new FinopsError(
      'PRICING_AMBIGUOUS',
      `más de una fila vigente con el mismo effective_from para ${at.provider}/${at.service}/${at.product} "${meter}"`,
      { meter },
    );
  }
  return best;
}

/**
 * Precio de un uso. Solo se valoran los medidores con cantidad > 0; un medidor
 * con cantidad > 0 y sin precio lanza PRICING_MISSING (nunca se asume 0).
 * Medidores en orden alfabético (determinístico).
 */
export function priceUsage(usage: UsageMeters, catalogRows: readonly PricingCatalogRow[], at: PricingTarget): PriceUsageResult {
  if (!usage || typeof usage !== 'object') throw new FinopsError('INVALID_USAGE', 'usage debe ser un objeto medidor→cantidad');
  if (!at || !at.provider || !at.service || !at.product) {
    throw new FinopsError('INVALID_INPUT', 'priceUsage necesita {provider, service, product}');
  }
  const lines: PricedLine[] = [];
  let currency: string | null = null;
  for (const meter of Object.keys(usage).sort()) {
    const raw = usage[meter];
    if (raw === null || raw === undefined) continue;
    const qtyScaled = toScaled(raw as DecimalLike, `usage.${meter}`);
    if (qtyScaled < 0n) throw new FinopsError('INVALID_USAGE', `usage.${meter} negativo (${String(raw)})`);
    if (qtyScaled === 0n) continue;
    const row = selectPriceRow(catalogRows, at, meter);
    const cur = String(row.currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) throw new FinopsError('INVALID_INPUT', `moneda inválida en catálogo: ${row.currency}`);
    if (currency !== null && cur !== currency) {
      throw new FinopsError('CURRENCY_MISMATCH', `medidores con monedas distintas (${currency} vs ${cur})`);
    }
    currency = cur;
    const qty = normalizeDecimal(raw as DecimalLike);
    lines.push({
      meter,
      qty,
      unit_size: normalizeDecimal(row.unit_size, 'unit_size'),
      unit_price: normalizeDecimal(row.unit_price, 'unit_price'),
      currency: cur,
      pricing_version: String(row.pricing_version),
      effective_from: isoOf(row.effective_from),
      pricing_catalog_id: row.id === null || row.id === undefined ? null : String(row.id),
      verified: row.verified === true,
      source: row.source ?? null,
      amount: priceLine(qty, row.unit_price, row.unit_size),
    });
  }
  const amount = lines.length ? addDec(...lines.map((l) => l.amount)) : addDec(0);
  const finalCurrency = currency ?? 'USD';
  const pricingSnapshot: PricingSnapshot = {
    provider: at.provider,
    service: at.service,
    product: at.product,
    currency: finalCurrency,
    pricing_catalog_ids: lines.map((l) => l.pricing_catalog_id).filter((x): x is string => x !== null),
    pricing_versions: Array.from(new Set(lines.map((l) => l.pricing_version))).sort(),
    // Copia profunda: objetos nuevos con valores primitivos.
    lines: lines.map((l) => ({ ...l })),
  };
  return { amount, currency: finalCurrency, lines, pricingSnapshot };
}
