/**
 * r107 B10 · Fase 3 — COSTO por proveedor ANTES de gastar (D8): el estimado sale del ESTIMATOR de FinOps con los items
 * del generador (`scorm` / `activity`, `video` + `video_interactions`, `presentation`, `audio_welcome`,
 * `audiobook_chapter`) y los precios del catálogo; la COTA (lo máximo que puede costar cada llamada principal) sale del
 * catálogo con el tamaño real de lo que se va a mandar. Nada inventado: un precio que falta hace fallar el estimado
 * (fail-closed, como B5).
 *
 * Puro.
 */
import { EstimateItem, estimateCost } from '../../finops/estimator';
import { usageModelPriorsV1 } from '../../finops/usage-model';
import { addDec } from '../../finops/decimal';
import { safetyCapOf, parseSafetyCapFactor, readSafetyCapFactor } from '../../finops/safety-cap';
import type { DryRunPricing } from '../../pedagogy/dry-run';
import { planAudiobookSections, splitForTts } from '../../../workers/provider-real/audio-scripts';
import { AUDIOBOOK_TTS_SEGMENT_CHARS_DEFAULT } from '../../../workers/provider-real/tts-resilience';
import { LLM_RESERVATION_CHARS_PER_TOKEN } from '../../finops/llm-usage-ingest';
import { priceUsage } from '../../finops/pricing';
import { gammaBound, llmBoundUsd, ttsBoundUsd, videogenBound } from './ports';
import type { LlmCallSize } from './llm-sizes';
import { GAMMA_NUM_CARDS } from '../../../workers/provider-real/real-providers';
import { RegenError, RegenProvider, RegenTarget, SCORM_V2_ROOMS } from './types';
import type { ChapterSource } from './sources';

export interface ProviderLine { provider: RegenProvider; calls: number; expectedUsd: string; boundUsd: string; what: string; note?: string | null }

/** Llamada planeada de una regeneración (forma compatible con la aprobación de B5: `expectedUsd` + `boundUsd`). */
export interface RegenPlannedCall {
  model: string;
  kind: 'regenerate';
  promptChars: 0;
  maxTokens: 0;
  size: { promptChars: 0 };
  expectedUsd: string;
  /** Cota de la PRIMERA llamada principal (la aprobación exige que el tope la cubra). */
  boundUsd: string;
  regen: {
    op: RegenTarget['op'];
    /** Suma de las cotas de TODAS las llamadas principales (lo máximo sin reintentos). */
    totalBoundUsd: string;
    providers: ProviderLine[];
    calls: number;
    min: string;
    max: string;
    basis: string;
  };
}

const sum = (...xs: string[]) => addDec('0', ...xs);
/** Tarjetas que el cuerpo existente de Gamma pide (gammaGenerationBody → GAMMA_NUM_CARDS). */
export const GAMMA_CARDS = GAMMA_NUM_CARDS;

function run(items: EstimateItem[], pricing: DryRunPricing, llmModel: string) {
  const um = usageModelPriorsV1();
  for (const op of Object.values(um.operations)) if (op.provider === 'anthropic') op.product = llmModel;
  return estimateCost({ items, catalog: pricing.catalog, usageModel: um, retryPolicy: pricing.retryPolicy, pricingAsOf: pricing.asOf ?? null });
}

/** Fracción del max_tokens que se espera de salida en una llamada que responde completa (el resto es margen). */
export const LLM_EXPECTED_OUTPUT_FRACTION = 0.6;
/** Tasa esperada del reintento dirigido si FinOps no trae la suya. */
export const LLM_DEFAULT_RETRY_RATE = 0.25;

/**
 * P2-1: estimado y cota de las llamadas de IA con el MISMO pedido y el MISMO max_tokens que la llamada real.
 *   cota     = Σ (principal + reintento dirigido) a tope: entrada como escritura de caché, salida = max_tokens;
 *   estimado = Σ principal (entrada a precio de entrada, salida = 60 % del max_tokens) + tasa de reintento × reintento.
 * Por construcción cota ≥ estimado.
 */
export function llmLine(pricing: DryRunPricing, model: string, sizes: LlmCallSize[]): { calls: number; expectedUsd: string; boundUsd: string } {
  const rate = typeof (pricing.retryPolicy as any)?.retryRate === 'number' ? Math.min(1, Math.max(0, (pricing.retryPolicy as any).retryRate)) : LLM_DEFAULT_RETRY_RATE;
  const expectedOf = (chars: number, maxTokens: number) => priceUsage({ input_tokens: Math.max(1, Math.ceil(chars / LLM_RESERVATION_CHARS_PER_TOKEN)), output_tokens: Math.max(1, Math.ceil(maxTokens * LLM_EXPECTED_OUTPUT_FRACTION)) } as any, pricing.catalog, { provider: 'anthropic', service: 'messages', product: model, asOf: pricing.asOf ?? null } as any).amount;
  let calls = 0;
  let bound = '0';
  let expected = 0;
  for (const z of sizes) {
    calls++;
    bound = sum(bound, llmBoundUsd(pricing, model, z.promptChars, z.maxTokens));
    expected += Number(expectedOf(z.promptChars, z.maxTokens));
    if (z.retryPromptChars !== null && z.retryMaxTokens !== null) {
      calls++;
      bound = sum(bound, llmBoundUsd(pricing, model, z.retryPromptChars, z.retryMaxTokens));
      expected += rate * Number(expectedOf(z.retryPromptChars, z.retryMaxTokens));
    }
  }
  return { calls, expectedUsd: expected.toFixed(6), boundUsd: bound };
}

export function estimateRegen(t: RegenTarget, ctx: { pricing: DryRunPricing; llmModel: string; ttsModel: string; sources: ChapterSource[]; welcomeChars?: number | null; llmSizes: LlmCallSize[] }): RegenPlannedCall {
  const P = ctx.pricing;
  const items: EstimateItem[] = [];
  const lines: ProviderLine[] = [];
  const add = (provider: RegenProvider, calls: number, bound: string, what: string, note: string | null = null) => lines.push({ provider, calls, expectedUsd: '0', boundUsd: bound, what, note });
  const llm = llmLine(P, ctx.llmModel, ctx.llmSizes);
  const llmExpected = new Map<ProviderLine, string>();
  const addLlm = (what: string) => { add('anthropic', llm.calls, llm.boundUsd, what); llmExpected.set(lines[lines.length - 1], llm.expectedUsd); };
  const srcOf = (n: number) => ctx.sources.find((s) => s.number === n);
  switch (t.op) {
    case 'regenerate_scorm':
      if (t.engine === 'scorm_v2') {
        items.push({ itemKey: `scorm:${t.chapterNumber}`, itemType: 'scorm', action: 'REGENERATE' });
        addLlm(`${SCORM_V2_ROOMS} salas del juego (1 llamada por sala + su reintento dirigido; la plantilla de reemplazo solo corre si el tope la cubre)`);
      } else {
        items.push({ itemKey: `activity:${t.chapterNumber}`, itemType: 'activity', action: 'REGENERATE' });
        addLlm(`práctica H5P (${t.h5pType}) con el texto del capítulo (+ su reintento dirigido)`);
      }
      break;
    case 'regenerate_video': {
      const words = srcOf(t.chapterNumber)?.words ?? 0;
      items.push({ itemKey: `video:${t.chapterNumber}`, itemType: 'video', action: 'REGENERATE' });
      const vb = videogenBound(P, words);
      add('videogen', 1, vb.boundUsd, 'render del video (Videogen escribe el guion por escenas)', vb.note);
      add('youtube', 1, '0', 'publicación no listada en YouTube (cuota de la cuenta, USD 0)');
      addLlm('preguntas interactivas desde el guion nuevo (+ su reintento dirigido)');
      break;
    }
    case 'regenerate_gamma':
      items.push({ itemKey: `presentation:${t.chapterNumber}`, itemType: 'presentation', action: 'REGENERATE' });
    {
      const gb = gammaBound(P, GAMMA_CARDS);
      add('gamma', 1, gb.boundUsd, `presentación de Gamma (${GAMMA_CARDS} diapositivas, es-419, export PDF)`, gb.note);
    }
      break;
    case 'regenerate_audio':
      if (t.audio === 'welcome') {
        const chars = Math.max(1, ctx.welcomeChars ?? 1200);
        items.push({ itemKey: 'audio_welcome', itemType: 'audio_welcome', action: 'REGENERATE', usageScale: Math.min(10, Math.max(0.2, chars / 1200)) });
        const chunks = Math.max(1, Math.ceil(chars / AUDIOBOOK_TTS_SEGMENT_CHARS_DEFAULT));
        add('openai', chunks, ttsBoundUsd(P, ctx.ttsModel, chars), 'voz del texto de bienvenida');
      } else {
        let ttsBound = '0';
        let ttsCalls = 0;
        for (const n of t.chapters) {
          const s = srcOf(n);
          const words = s?.words ?? 0;
          items.push({ itemKey: `audiobook:${n}`, itemType: 'audiobook_chapter', action: 'REGENERATE', usageScale: Math.min(10, Math.max(0.2, words / 2200)) });
          if (!s) continue;
          // La narración ≈ 90 % de las palabras de la fuente (r19): el texto que se convierte en voz.
          const narration = Math.ceil(s.md.length * 0.9);
          ttsCalls += splitForTts('x'.repeat(Math.max(1, narration)), AUDIOBOOK_TTS_SEGMENT_CHARS_DEFAULT).length || 1;
          ttsBound = sum(ttsBound, ttsBoundUsd(P, ctx.ttsModel, narration));
        }
        addLlm(`guion de ${t.chapters.length} capítulo(s) por bloques (validación de palabras; una continuación o condensación por bloque)`);
        add('openai', ttsCalls, ttsBound, 'voz de todo el audiolibro (64 kbps mono)');
      }
      break;
  }
  // Las líneas que NO son de IA salen del estimator de FinOps (sin sus llamadas de IA: esas se miden con el pedido real).
  const est = run(items, P, ctx.llmModel);
  for (const l of lines) l.expectedUsd = llmExpected.get(l) ?? (est.totals.byProvider[l.provider]?.expected ?? '0');
  // P2-1 · invariante: en cada línea (y por lo tanto en el ítem) cota ≥ estimado. Si no, el estimado no es confiable.
  const bad = lines.filter((l) => Number(l.boundUsd) + 1e-9 < Number(l.expectedUsd));
  if (bad.length) throw new RegenError('internal', `Estimado incoherente: ${bad.map((l) => `${l.provider} cota ${l.boundUsd} < estimado ${l.expectedUsd}`).join('; ')}.`);
  const totalBound = sum(...lines.map((l) => l.boundUsd));
  const totalExpected = sum(...lines.map((l) => l.expectedUsd));
  const firstBound = lines.map((l) => (l.calls ? (Number(l.boundUsd) / l.calls).toFixed(6) : '0')).find((b) => Number(b) > 0) ?? '0';
  return {
    model: ctx.llmModel, kind: 'regenerate', promptChars: 0, maxTokens: 0, size: { promptChars: 0 },
    expectedUsd: totalExpected, boundUsd: firstBound,
    regen: {
      op: t.op, totalBoundUsd: totalBound, providers: lines, calls: lines.reduce((s, l) => s + l.calls, 0),
      min: (Math.min(Number(est.totals.min), Number(totalExpected))).toFixed(6), max: totalBound,
      basis: `estimator ${est.estimatorVersion} · ${est.usageModelVersion} · ${(P as any).source ?? 'pricing'}: items del generador; IA medida con el pedido y el max_tokens reales (reintento dirigido incluido); cotas del catálogo con lo que se pide`,
    },
  };
}

/** Tope propuesto de una regeneración = max(esperado × factor de seguridad, Σ cotas de las llamadas principales). */
export function regenProposedCap(calls: RegenPlannedCall[], capFactor?: number): string {
  const expected = Number(sum('0', ...calls.map((c) => c.expectedUsd)));
  const bound = Number(sum('0', ...calls.map((c) => c.regen.totalBoundUsd)));
  const safety = Number(safetyCapOf(String(expected), parseSafetyCapFactor(capFactor ?? readSafetyCapFactor())));
  return (Math.ceil(Math.max(safety, bound) * 100 - 1e-9) / 100).toFixed(2);
}
