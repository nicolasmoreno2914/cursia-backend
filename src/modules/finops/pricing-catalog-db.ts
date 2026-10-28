// r79 (F2 · una sola cifra de costo) · lectura del catálogo de precios de la base (`pricing_catalog`) y precio del
// crédito de Gamma configurable por SuperAdmin.
//
// Fuente ÚNICA: la «Estimación de producción» (FinopsBudgetService.catalog → evaluateStart) y la estimación en seco de
// «Cursia recomienda» / «Ajustar al presupuesto» leen las MISMAS filas con esta función. `pricing_catalog` es inmutable:
// un precio nuevo es una fila nueva (effective_from más reciente gana, ver pricing.selectPriceRow); nunca se edita una fila.
import type { PricingCatalogRow } from './pricing';
import { selectPriceRow } from './pricing';

type Runner = { query: (sql: string, params?: any[]) => Promise<any> };

export async function readPricingCatalog(runner: Runner): Promise<PricingCatalogRow[]> {
  const res = await runner.query(
    `select id, provider, service, product_or_model, meter, unit_size::text as unit_size, unit_price::text as unit_price,
            currency, pricing_version, effective_from, effective_to, source, source_ref, verified
       from public.pricing_catalog`,
  );
  return Array.isArray(res) ? res : (res && res.rows) || [];
}

/** El producto de Gamma que valúa el estimador (operations.ts: gamma.generate). */
export const GAMMA_PRICE_TARGET = Object.freeze({ provider: 'gamma', service: 'generations', product: 'gamma-generate', meter: 'gamma_credit' });
export const GAMMA_PRICING_VERSION_PREFIX = 'gamma-superadmin-';

/** Lo que el SuperAdmin escribe: plan, lo que paga y los créditos que trae; y si lo verificó con la factura. */
export interface GammaPriceInput {
  plan: string;
  pricePaidUsd: number;
  creditsIncluded: number;
  verified: boolean;
  note?: string | null;
}

export interface GammaPriceView {
  plan: string | null;
  pricePaidUsd: number | null;
  creditsIncluded: number | null;
  /** USD por crédito (la fila vigente). */
  unitPriceUsd: string;
  verified: boolean;
  source: string | null;
  pricingVersion: string;
  effectiveFrom: string;
  setBy: string | null;
  note: string | null;
  /** «estimación provisional (precio de Gamma sin verificar)» mientras no esté verificado. */
  provisional: boolean;
}

export class GammaPriceError extends Error {
  constructor(message: string) {
    super(`GAMMA_PRICE_INVALID: ${message}`);
    this.name = 'GammaPriceError';
  }
}

/** Valida y normaliza lo que manda el SuperAdmin (lanza GammaPriceError). */
export function parseGammaPriceInput(body: unknown): GammaPriceInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GammaPriceError('se espera un objeto { plan, pricePaidUsd, creditsIncluded, verified }');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['plan', 'pricePaidUsd', 'creditsIncluded', 'verified', 'note'].includes(k)) throw new GammaPriceError(`campo no permitido: ${k}`);
  const plan = typeof b.plan === 'string' ? b.plan.replace(/\s+/g, ' ').trim() : '';
  if (plan.length < 2 || plan.length > 80) throw new GammaPriceError('plan: escribe el nombre del plan de Gamma (2 a 80 caracteres)');
  const price = Number(b.pricePaidUsd);
  if (typeof b.pricePaidUsd !== 'number' || !Number.isFinite(price) || price <= 0 || price > 100000) throw new GammaPriceError('pricePaidUsd: monto pagado en USD (> 0 y ≤ 100000)');
  const credits = Number(b.creditsIncluded);
  if (typeof b.creditsIncluded !== 'number' || !Number.isInteger(credits) || credits < 1 || credits > 100000000) throw new GammaPriceError('creditsIncluded: créditos incluidos (entero ≥ 1)');
  if (typeof b.verified !== 'boolean') throw new GammaPriceError('verified: true o false');
  let note: string | null = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== 'string' || b.note.length > 300) throw new GammaPriceError('note: texto de hasta 300 caracteres');
    note = b.note.replace(/\s+/g, ' ').trim() || null;
  }
  return { plan, pricePaidUsd: Math.round(price * 100) / 100, creditsIncluded: credits, verified: b.verified, note };
}

/** USD por crédito con 10 decimales (la escala de la columna unit_price). */
export function gammaUnitPrice(i: Pick<GammaPriceInput, 'pricePaidUsd' | 'creditsIncluded'>): string {
  const v = i.pricePaidUsd / i.creditsIncluded;
  return v.toFixed(10);
}

/** La fila NUEVA del catálogo (append-only) para este precio. `at` = effective_from (único por instante). */
export function gammaPriceRow(i: GammaPriceInput, at: Date, actor: string): Omit<PricingCatalogRow, 'id'> & { created_by: string } {
  return {
    provider: GAMMA_PRICE_TARGET.provider,
    service: GAMMA_PRICE_TARGET.service,
    product_or_model: GAMMA_PRICE_TARGET.product,
    meter: GAMMA_PRICE_TARGET.meter,
    unit_size: '1',
    unit_price: gammaUnitPrice(i),
    currency: 'USD',
    pricing_version: `${GAMMA_PRICING_VERSION_PREFIX}${at.toISOString()}`,
    effective_from: at.toISOString(),
    effective_to: null,
    // 'contract' = lo informó el owner desde su plan; verified = lo comprobó con la factura.
    source: 'contract',
    source_ref: JSON.stringify({ plan: i.plan, pricePaidUsd: i.pricePaidUsd, creditsIncluded: i.creditsIncluded, ...(i.note ? { note: i.note } : {}) }),
    verified: i.verified,
    created_by: `superadmin:${actor}`.slice(0, 200),
  };
}

/** Fila vigente de Gamma (la misma que usaría el estimador ahora) en la forma que ve el SuperAdmin. null si no hay. */
export function currentGammaPrice(catalog: readonly PricingCatalogRow[], asOf: Date = new Date()): GammaPriceView | null {
  let row: PricingCatalogRow & { created_by?: string };
  try {
    row = selectPriceRow(catalog, { provider: GAMMA_PRICE_TARGET.provider, service: GAMMA_PRICE_TARGET.service, product: GAMMA_PRICE_TARGET.product, asOf }, GAMMA_PRICE_TARGET.meter) as any;
  } catch {
    return null;
  }
  let ref: Record<string, unknown> = {};
  try { ref = row.source_ref && String(row.source_ref).startsWith('{') ? JSON.parse(String(row.source_ref)) : {}; } catch { ref = {}; }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    plan: typeof ref.plan === 'string' ? ref.plan : null,
    pricePaidUsd: num(ref.pricePaidUsd),
    creditsIncluded: num(ref.creditsIncluded),
    unitPriceUsd: String(row.unit_price),
    verified: row.verified === true,
    source: row.source ?? null,
    pricingVersion: String(row.pricing_version),
    effectiveFrom: new Date(row.effective_from as any).toISOString(),
    setBy: typeof (row as any).created_by === 'string' ? (row as any).created_by : null,
    note: typeof ref.note === 'string' ? ref.note : (row.source === 'placeholder' && row.source_ref ? String(row.source_ref) : null),
    provisional: row.verified !== true,
  };
}
