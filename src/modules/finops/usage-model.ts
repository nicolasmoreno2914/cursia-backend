/**
 * V2.1 RF-a — usage model (p10/p50/p90 de uso por operación) con priors
 * documentados en `usage-model.priors.v1.json`. Más adelante se reemplaza por
 * percentiles aprendidos del ledger (misma forma).
 */
import * as priorsJson from './usage-model.priors.v1.json';
import { FinopsError } from './errors';
import { cmpDec, DecimalLike } from './decimal';

export interface MeterPercentiles {
  p10: DecimalLike;
  p50: DecimalLike;
  p90: DecimalLike;
}

export interface UsageModelOperation {
  provider: string;
  service: string;
  product: string;
  meters: Record<string, MeterPercentiles>;
  /** Tasa observada de retries pagados (0.15 = 15%). Si falta, usa retryPolicy/defaultRetryRate. */
  retryRate?: number;
}

export interface UsageModel {
  version: string;
  defaultRetryRate?: number;
  operations: Record<string, UsageModelOperation>;
}

/** Priors v1 (copia; el JSON importado nunca se muta). */
export function usageModelPriorsV1(): UsageModel {
  const src = ((priorsJson as any).default ?? priorsJson) as UsageModel;
  return JSON.parse(JSON.stringify({ version: src.version, defaultRetryRate: src.defaultRetryRate, operations: src.operations }));
}

export function assertValidUsageModel(model: UsageModel): void {
  if (!model || typeof model !== 'object' || !model.operations || typeof model.version !== 'string' || !model.version) {
    throw new FinopsError('USAGE_MODEL_MISSING', 'usageModel inválido: necesita {version, operations}');
  }
  for (const [op, def] of Object.entries(model.operations)) {
    if (!def || !def.provider || !def.service || !def.product || !def.meters) {
      throw new FinopsError('USAGE_MODEL_MISSING', `operación ${op} sin provider/service/product/meters`);
    }
    for (const [meter, p] of Object.entries(def.meters)) {
      if (cmpDec(p.p10, 0) < 0 || cmpDec(p.p10, p.p50) > 0 || cmpDec(p.p50, p.p90) > 0) {
        throw new FinopsError('USAGE_MODEL_MISSING', `percentiles no monótonos en ${op}.${meter} (p10 <= p50 <= p90, >= 0)`);
      }
    }
    if (def.retryRate !== undefined && (typeof def.retryRate !== 'number' || !(def.retryRate >= 0))) {
      throw new FinopsError('USAGE_MODEL_MISSING', `retryRate inválido en ${op}`);
    }
  }
}
