/**
 * r107 B10 · Fase 3 — el GENERADOR EXISTENTE (copia vendorizada del ejecutor del navegador, la misma que corre el worker
 * de IA del backend) dentro del Taller: motor SCORM v2, práctica H5P v3 y preguntas del video interactivo, con sus
 * MISMOS prompts, validadores y reintentos dirigidos. Nada de esto se reescribe: el Taller solo le da
 *   - `api()` → la llamada a la IA por la COMPUERTA del Taller (tope aprobado, kill switch, registro `sent` antes de
 *     enviar, cargo al ledger con el `approvalId`). Toda falla sale como `fatal` para que el ejecutor NUNCA reintente
 *     solo (un reintento pagado lo decide la compuerta, no un bucle de backoff);
 *   - los «artifacts de dependencia» (markdown del capítulo, Context Package) en memoria (`srv://<id>`), sin red.
 */
import { createExecutorSandbox, ExecutorSandbox } from '../../../workers/llm-executor/executor-runtime';
import type { DryRunPricing } from '../../pedagogy/dry-run';
import { PaidCallGate, RegenProviders, classifyAnthropic, llmBoundUsd, llmChargeInput, llmMeasuredUsd, paidCall } from './ports';
import { RegenError } from './types';

export interface WorkshopExecutor {
  sandbox: ExecutorSandbox;
  /** Llamadas a la IA hechas por el generador (para el informe). */
  calls: number;
  /** Último error de la compuerta (tope / ambiguo / no enviado): corta la producción con su motivo. */
  stop: RegenError | null;
}

const asText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((b) => (b && typeof b === 'object' && typeof (b as any).text === 'string' ? (b as any).text : '')).join('');
  return v === null || v === undefined ? '' : JSON.stringify(v);
};

/**
 * Sandbox del ejecutor con la IA del Taller. `texts` = artifacts de dependencia en memoria (id → texto).
 */
export function workshopExecutor(p: { providers: RegenProviders; gate: PaidCallGate; pricing: DryRunPricing; what: string; texts: Map<string, string>; ownerId: string }): WorkshopExecutor {
  const ex: WorkshopExecutor = { sandbox: null as unknown as ExecutorSandbox, calls: 0, stop: null };
  let attempt = 0;
  const api = async (system: unknown, user: unknown, maxTok?: number, schema?: unknown, model?: string, metaOut?: Record<string, any>): Promise<string> => {
    // Una compuerta ya cortó: ninguna llamada más (el ejecutor no debe seguir gastando).
    if (ex.stop) throw { fatal: true, msg: ex.stop.message, code: ex.stop.code };
    const m = (typeof model === 'string' && model) || p.providers.config.llmModel;
    const sys = asText(system);
    const usr = asText(user);
    const maxTokens = Math.max(1, Math.min(Number(maxTok) || 4000, 16_000));
    let bound: string;
    try {
      bound = llmBoundUsd(p.pricing, m, sys.length + usr.length, maxTokens);
    } catch {
      ex.stop = new RegenError('provider_not_ready', `El modelo «${m}» no tiene precio en el catálogo de FinOps: no se llama a la IA.`);
      throw { fatal: true, msg: ex.stop.message, code: ex.stop.code };
    }
    attempt++;
    try {
      const r = await paidCall(p.gate, { provider: 'anthropic', kind: p.what, boundUsd: bound, attempt },
        () => p.providers.llm.messages({ model: m, system: sys, user: usr, maxTokens, ...(schema ? { schema } : {}) } as any),
        classifyAnthropic,
        (res, callId) => ({ costUsd: llmMeasuredUsd(p.pricing, res.model || m, res.usage), charge: llmChargeInput(p.gate.charge, callId, { model: res.model || m, messageId: res.messageId, usage: res.usage }, p.what), externalId: res.messageId }));
      ex.calls++;
      if (metaOut) { metaOut.stopReason = r.stopReason; metaOut.usage = { ...r.usage }; }
      if (r.stopReason === 'max_tokens' && metaOut) metaOut.truncated = true;
      return r.text;
    } catch (err) {
      if (err instanceof RegenError) ex.stop = err;
      else ex.stop = new RegenError('internal', `La llamada a la IA falló: ${err instanceof Error ? err.message : String(err)}`);
      // `fatal` + sin «reintentos agotados»: el ejecutor lo propaga tal cual (no lo convierte en «sala fallida»).
      throw { fatal: true, msg: ex.stop.message, code: ex.stop.code };
    }
  };
  ex.sandbox = createExecutorSandbox({
    api,
    artifactText: async (id: string) => (p.texts.has(id) ? (p.texts.get(id) as string) : null),
    ownerId: p.ownerId,
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  // Descargas de dependencias sin espera (están en memoria) y sin backoff de la IA (la compuerta decide).
  ex.sandbox.ctx.DYN_DOWNLOAD_BACKOFF_MS = [0, 0];
  ex.sandbox.ctx.DYN_LLM_BACKOFF_BASE_MS = 0;
  return ex;
}
