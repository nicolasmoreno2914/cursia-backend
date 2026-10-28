// r79 (F2 · una sola cifra de costo): los precios con los que TODA estimación en seco (tarjeta «Cursia recomienda»,
// «Ajustar al presupuesto», impacto de cambios, costo de una regeneración) valúa el Manifest: el catálogo `pricing_catalog`
// de la base y la política de reintentos del servidor (`readEstimateRetryPolicy`), los MISMOS que usa la «Estimación de
// producción» (finops-budget.service → evaluateStart). Sin catálogo legible: el seed, rotulado (pricingSource).
import { Logger } from '@nestjs/common';
import { readPricingCatalog } from './pricing-catalog-db';
import { readEstimateRetryPolicy } from './finops-budget.service';
import { DryRunPricing, seedPricing } from '../pedagogy/dry-run';

const logger = new Logger('DryRunPricing');
type Runner = { query: (sql: string, params?: any[]) => Promise<any> };

export async function loadDryRunPricing(runner: Runner): Promise<DryRunPricing> {
  let catalog: any[] = [];
  try {
    catalog = await readPricingCatalog(runner);
  } catch (err) {
    // Sin catálogo legible la tarjeta no se cae: se estima con el seed y la respuesta lo dice (pricingSource).
    logger.warn(`pricing_catalog ilegible (${(err as Error)?.message ?? err}); estimación en seco con el seed`);
    catalog = [];
  }
  if (!Array.isArray(catalog) || !catalog.length || !catalog.every((r) => r && typeof r.provider === 'string')) return seedPricing();
  return { catalog, retryPolicy: readEstimateRetryPolicy(), asOf: new Date(), source: 'pricing_catalog' };
}
