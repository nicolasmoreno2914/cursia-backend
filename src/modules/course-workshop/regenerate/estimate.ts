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
import { gammaBoundUsd, llmBoundUsd, ttsBoundUsd, videogenBoundUsd } from './ports';
import { RegenProvider, RegenTarget, SCORM_V2_ROOMS } from './types';
import type { ChapterSource } from './sources';

export interface ProviderLine { provider: RegenProvider; calls: number; expectedUsd: string; boundUsd: string; what: string }

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
const times = (usd: string, n: number) => (Number(usd) * n).toFixed(6);

function run(items: EstimateItem[], pricing: DryRunPricing, llmModel: string) {
  const um = usageModelPriorsV1();
  for (const op of Object.values(um.operations)) if (op.provider === 'anthropic') op.product = llmModel;
  return estimateCost({ items, catalog: pricing.catalog, usageModel: um, retryPolicy: pricing.retryPolicy, pricingAsOf: pricing.asOf ?? null });
}

/** Caracteres aproximados de un prompt de sala del motor SCORM v2 (contexto del curso + plantilla + reglas). */
const SCORM_ROOM_PROMPT_CHARS = 4500;
const SCORM_ROOM_MAX_TOKENS = 4000;

export function estimateRegen(t: RegenTarget, ctx: { pricing: DryRunPricing; llmModel: string; ttsModel: string; sources: ChapterSource[]; welcomeChars?: number | null }): RegenPlannedCall {
  const P = ctx.pricing;
  const items: EstimateItem[] = [];
  const lines: ProviderLine[] = [];
  const add = (provider: RegenProvider, calls: number, bound: string, what: string) => lines.push({ provider, calls, expectedUsd: '0', boundUsd: bound, what });
  const srcOf = (n: number) => ctx.sources.find((s) => s.number === n);
  switch (t.op) {
    case 'regenerate_scorm':
      if (t.engine === 'scorm_v2') {
        items.push({ itemKey: `scorm:${t.chapterNumber}`, itemType: 'scorm', action: 'REGENERATE' });
        add('anthropic', SCORM_V2_ROOMS, times(llmBoundUsd(P, ctx.llmModel, SCORM_ROOM_PROMPT_CHARS, SCORM_ROOM_MAX_TOKENS), SCORM_V2_ROOMS), `${SCORM_V2_ROOMS} salas del juego (1 llamada por sala; un reintento de formato por sala entra en el margen)`);
      } else {
        const md = srcOf(t.chapterNumber)?.md ?? '';
        items.push({ itemKey: `activity:${t.chapterNumber}`, itemType: 'activity', action: 'REGENERATE' });
        add('anthropic', 1, llmBoundUsd(P, ctx.llmModel, md.length + 8000, 5000), `práctica H5P (${t.h5pType}) con el texto del capítulo`);
      }
      break;
    case 'regenerate_video': {
      const md = srcOf(t.chapterNumber)?.md ?? '';
      items.push({ itemKey: `video:${t.chapterNumber}`, itemType: 'video', action: 'REGENERATE' }, { itemKey: `video_interactions:${t.chapterNumber}`, itemType: 'video_interactions', action: 'REGENERATE' });
      add('videogen', 1, videogenBoundUsd(P), 'render del video (Videogen escribe el guion por escenas)');
      add('youtube', 1, '0', 'publicación no listada en YouTube (cuota de la cuenta, USD 0)');
      add('anthropic', 1, llmBoundUsd(P, ctx.llmModel, md.length + 6000, 4000), 'preguntas interactivas desde el guion nuevo');
      break;
    }
    case 'regenerate_gamma':
      items.push({ itemKey: `presentation:${t.chapterNumber}`, itemType: 'presentation', action: 'REGENERATE' });
      add('gamma', 1, gammaBoundUsd(P), 'presentación de Gamma (10 diapositivas, es-419, export PDF)');
      break;
    case 'regenerate_audio':
      if (t.audio === 'welcome') {
        const chars = Math.max(1, ctx.welcomeChars ?? 1200);
        items.push({ itemKey: 'audio_welcome', itemType: 'audio_welcome', action: 'REGENERATE', usageScale: Math.min(10, Math.max(0.2, chars / 1200)) });
        const chunks = Math.max(1, Math.ceil(chars / AUDIOBOOK_TTS_SEGMENT_CHARS_DEFAULT));
        add('openai', chunks, ttsBoundUsd(P, ctx.ttsModel, chars), 'voz del texto de bienvenida');
      } else {
        let llmBound = '0';
        let ttsBound = '0';
        let llmCalls = 0;
        let ttsCalls = 0;
        for (const n of t.chapters) {
          const s = srcOf(n);
          const words = s?.words ?? 0;
          items.push({ itemKey: `audiobook:${n}`, itemType: 'audiobook_chapter', action: 'REGENERATE', usageScale: Math.min(10, Math.max(0.2, words / 2200)) });
          if (!s) continue;
          let sections: Array<{ text: string; words: number }> = [];
          try { sections = planAudiobookSections(s.md).sections; } catch { sections = [{ text: s.md, words }]; }
          for (const sec of sections) {
            llmCalls++;
            llmBound = sum(llmBound, llmBoundUsd(P, ctx.llmModel, sec.text.length + 3000, Math.min(3000, Math.max(800, Math.ceil(sec.words * 0.9 * 2) + 200))));
          }
          // La narración ≈ 90 % de las palabras de la fuente (r19): el texto que se convierte en voz.
          const narration = Math.ceil(s.md.length * 0.9);
          ttsCalls += splitForTts('x'.repeat(Math.max(1, narration)), AUDIOBOOK_TTS_SEGMENT_CHARS_DEFAULT).length || 1;
          ttsBound = sum(ttsBound, ttsBoundUsd(P, ctx.ttsModel, narration));
        }
        add('anthropic', llmCalls, llmBound, `guion de ${t.chapters.length} capítulo(s) por bloques (validación de palabras)`);
        add('openai', ttsCalls, ttsBound, 'voz de todo el audiolibro (64 kbps mono)');
      }
      break;
  }
  const est = run(items, P, ctx.llmModel);
  for (const l of lines) l.expectedUsd = est.totals.byProvider[l.provider]?.expected ?? '0';
  const totalBound = sum(...lines.map((l) => l.boundUsd));
  const firstBound = lines.map((l) => (l.calls ? (Number(l.boundUsd) / l.calls).toFixed(6) : '0')).find((b) => Number(b) > 0) ?? '0';
  return {
    model: ctx.llmModel, kind: 'regenerate', promptChars: 0, maxTokens: 0, size: { promptChars: 0 },
    expectedUsd: est.totals.expected, boundUsd: firstBound,
    regen: {
      op: t.op, totalBoundUsd: totalBound, providers: lines, calls: lines.reduce((s, l) => s + l.calls, 0),
      min: est.totals.min, max: est.totals.max,
      basis: `estimator ${est.estimatorVersion} · ${est.usageModelVersion} · ${(P as any).source ?? 'pricing'}: items del generador; cotas del catálogo con el tamaño real`,
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
