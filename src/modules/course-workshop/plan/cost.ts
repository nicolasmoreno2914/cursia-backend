/**
 * r107 B5 · Costo de los pedidos con el ESTIMATOR de FinOps (D8: siempre visible, también para video / Gamma / audio).
 *
 * El estimator valúa items por tipo con el usage model (priors p10/p50/p90) y el catálogo de precios; el Taller no tiene
 * tipos propios en `operations.ts`, así que cada llamada del Taller se valúa como el tipo de item del generador que más
 * se le parece, ESCALADO por el tamaño real de lo que se manda (usageScale, la misma herramienta del banco de exámenes):
 *
 *   interpretar el pedido            → `activity`      (≈ 7k entrada / 1,45k salida), entrada × (tokens del prompt / 7000)
 *   contenido de un campo HTML       → `course_intro`  (≈ 3k / 1k), entrada × (prompt / 3000), salida × (campo / 1000)
 *   capítulos del Libro              → `content`       (≈ 12k / 5,6k), entrada y salida × capítulos
 *   pregunta de examen               → `module_intro`  (≈ 3k / 0,9k), entrada × (prompt / 3000)
 *   regenerar juego / video / Gamma / audio, agregar capítulo / módulo → los items del generador tal cual (scorm; video +
 *   video_interactions; presentation; audiobook_chapter × capítulos o audio_welcome; capítulo completo × N).
 *
 * Tokens del prompt ≈ caracteres / 3,5 + 1.500 del sistema. Lo GASTADO se valúa con el uso medido de la respuesta y el
 * mismo catálogo (el ledger hace lo mismo del lado de FinOps).
 *
 * Puro.
 */
import { EstimateItem, EstimateResult, MinExpMax, estimateCost } from '../../finops/estimator';
import { priceUsage } from '../../finops/pricing';
import { usageModelPriorsV1 } from '../../finops/usage-model';
import { addDec, cmpDec, normalizeDecimal } from '../../finops/decimal';
import { parseSafetyCapFactor, readSafetyCapFactor, safetyCapOf } from '../../finops/safety-cap';
import type { DryRunPricing } from '../../pedagogy/dry-run';
import { workshopModel } from './ai';
import type { WorkshopCourse } from '../course-model';
import type { WorkshopAiUsage } from './ai';
import type { RequestDetails, RequestOperation } from './types';

/** r107 B8: + `quality_review` (revisión de calidad de UN capítulo) y `question_answer` (pregunta puntual con su evidencia). */
export type AiCallKind = 'interpret' | 'content_html' | 'content_libro' | 'content_question' | 'quality_review' | 'question_answer';

export const ZERO_MEM: MinExpMax = Object.freeze({ min: normalizeDecimal(0), expected: normalizeDecimal(0), max: normalizeDecimal(0) }) as MinExpMax;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const promptTokens = (chars: number) => Math.ceil(chars / 3.5) + 1500;

/** Items del estimator para UNA llamada del Taller de ese tipo y tamaño (ver tabla arriba). */
export function aiCallItems(kind: AiCallKind, size: { promptChars: number; outputChars?: number; chapters?: number }, key = 'call'): EstimateItem[] {
  const tin = promptTokens(size.promptChars);
  switch (kind) {
    case 'interpret':
      return [{ itemKey: `${key}:interpret`, itemType: 'activity', usageScale: { input_tokens: clamp(tin / 7000, 0.1, 100), output_tokens: 1 } }];
    case 'content_html':
      return [{ itemKey: `${key}:html`, itemType: 'course_intro', usageScale: { input_tokens: clamp(tin / 3000, 0.1, 100), output_tokens: clamp((size.outputChars ?? 2000) / 3.5 / 1000, 0.2, 20) } }];
    case 'content_libro': {
      const n = Math.max(1, size.chapters ?? 1);
      return [{ itemKey: `${key}:libro`, itemType: 'content', usageScale: { input_tokens: clamp(tin / 12000, 0.1, 100), output_tokens: clamp(n, 0.2, 60) } }];
    }
    case 'content_question':
      return [{ itemKey: `${key}:question`, itemType: 'module_intro', usageScale: { input_tokens: clamp(tin / 3000, 0.1, 100), output_tokens: 1 } }];
    // r107 B8: revisar un capítulo = leer mucho y devolver una lista corta (como interpretar: `activity`, ≈ 7k / 1,45k),
    // entrada × (prompt / 7000). Responder una pregunta = poca entrada y una respuesta corta (`module_intro`, ≈ 3k / 0,9k).
    case 'quality_review':
      return [{ itemKey: `${key}:quality`, itemType: 'activity', usageScale: { input_tokens: clamp(tin / 7000, 0.1, 100), output_tokens: 1 } }];
    case 'question_answer':
      return [{ itemKey: `${key}:ask`, itemType: 'module_intro', usageScale: { input_tokens: clamp(tin / 3000, 0.1, 100), output_tokens: 1 } }];
  }
}

function run(items: EstimateItem[], pricing: DryRunPricing, model: string | null = null): EstimateResult {
  const um = usageModelPriorsV1();
  // Fix round 1 (P2-1): las llamadas del Taller se valúan con el modelo REAL que usa (WORKSHOP_AI_MODEL), no con el del
  // usage model del generador. Un modelo sin precio en el catálogo hace fallar el estimado (falla cerrado).
  if (model) for (const op of Object.values(um.operations)) if (op.provider === 'anthropic') op.product = model;
  return estimateCost({ items, catalog: pricing.catalog, usageModel: um, retryPolicy: pricing.retryPolicy, pricingAsOf: pricing.asOf ?? null });
}

/**
 * Precios + el MODELO que usa el Taller (fix round 1, P2-1). `model` ausente = `workshopModel()` (lo fija Cursia por
 * configuración del servidor, nunca el docente).
 */
export type WorkshopPricing = DryRunPricing & { model?: string | null };
export const modelOf = (pricing: WorkshopPricing): string => (pricing.model ?? null) || workshopModel();

export class ModelUnpricedError extends Error {
  readonly code = 'WORKSHOP_MODEL_UNPRICED';
  constructor(readonly model: string) {
    super(`El modelo de IA configurado para el Taller («${model}») no tiene precio en el catálogo de FinOps: no se puede estimar ni acotar el gasto, así que no se llama a la IA.`);
  }
}

/** Falla cerrado si el modelo del Taller no tiene precio de entrada y salida en el catálogo. */
export function assertModelPriced(pricing: WorkshopPricing): string {
  const model = modelOf(pricing);
  try {
    priceUsage({ input_tokens: 1, output_tokens: 1, cache_write_tokens: 1 }, pricing.catalog, { provider: 'anthropic', service: 'messages', product: model, asOf: pricing.asOf ?? null } as any);
  } catch {
    throw new ModelUnpricedError(model);
  }
  return model;
}

/** Estimado de una llamada del Taller (antes de hacerla: lo usa la compuerta de saldo, D9), con el modelo real. */
export function estimateAiCall(kind: AiCallKind, size: { promptChars: number; outputChars?: number; chapters?: number }, pricing: WorkshopPricing): EstimateResult {
  return run(aiCallItems(kind, size), pricing, assertModelPriced(pricing));
}

/** Items de un capítulo completo del generador (agregar capítulo / módulo). */
function chapterItems(prefix: string, withAudio: boolean): EstimateItem[] {
  const types = ['content', 'experience', 'presentation', 'video', 'video_interactions', 'scorm', ...(withAudio ? ['audiobook_chapter'] : [])];
  return types.map((t) => ({ itemKey: `${prefix}:${t}`, itemType: t, action: 'GENERATE' }));
}

/** Items del estimator de un pedido de fase posterior (lo que costaría aplicarlo cuando exista). */
export function laterItems(op: RequestOperation, details: RequestDetails, course: WorkshopCourse): EstimateItem[] {
  const withAudio = course.audiobook.length > 0;
  switch (op) {
    case 'regenerate_scorm': return [{ itemKey: 'scorm', itemType: 'scorm', action: 'REGENERATE' }];
    case 'regenerate_video': return [{ itemKey: 'video', itemType: 'video', action: 'REGENERATE' }, { itemKey: 'video_interactions', itemType: 'video_interactions', action: 'REGENERATE' }];
    case 'regenerate_gamma': return [{ itemKey: 'presentation', itemType: 'presentation', action: 'REGENERATE' }];
    case 'regenerate_audio':
      return details.audioTarget === 'welcome'
        ? [{ itemKey: 'audio_welcome', itemType: 'audio_welcome', action: 'REGENERATE' }]
        : Array.from({ length: Math.max(1, course.chapters.length) }, (_, i) => ({ itemKey: `audiobook:${i + 1}`, itemType: 'audiobook_chapter', action: 'REGENERATE' }));
    case 'add_chapter': return Array.from({ length: Math.max(1, details.chapters ?? 1) }, (_, i) => chapterItems(`ch${i + 1}`, withAudio)).flat();
    case 'add_module': return [...Array.from({ length: Math.max(1, details.chapters ?? 2) }, (_, i) => chapterItems(`ch${i + 1}`, withAudio)).flat(), { itemKey: 'exam', itemType: 'exam', action: 'GENERATE' }];
    default: return [];
  }
}

export function estimateLater(op: RequestOperation, details: RequestDetails, course: WorkshopCourse, pricing: DryRunPricing): EstimateResult {
  return run(laterItems(op, details, course), pricing);
}

export const memOf = (e: EstimateResult): MinExpMax => ({ min: e.totals.min, expected: e.totals.expected, max: e.totals.max });

/**
 * USD de una respuesta MEDIDA (uso real del proveedor × catálogo) con el modelo que respondió. Fix round 1 (P2-1): sin
 * precio para ese modelo → ModelUnpricedError (nunca se valúa con otro modelo más barato).
 */
export function priceMeasured(usage: WorkshopAiUsage | null, model: string, pricing: DryRunPricing): string {
  if (!usage) return normalizeDecimal(0);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const meters = { input_tokens: n(usage.input_tokens), output_tokens: n(usage.output_tokens), cache_write_tokens: n(usage.cache_creation_input_tokens), cache_read_tokens: n(usage.cache_read_input_tokens) };
  try {
    return priceUsage(meters, pricing.catalog, { provider: 'anthropic', service: 'messages', product: model, asOf: pricing.asOf ?? null } as any).amount;
  } catch {
    throw new ModelUnpricedError(model);
  }
}

export const sumUsd = (...xs: Array<string | number | null | undefined>): string => addDec(...xs.map((x) => (x === null || x === undefined ? 0 : x)) as any);

// ─── Totales del plan y tope propuesto (D9) ─────────────────────────────────

export interface PlanTotals {
  /** IA YA gastada en armar el plan (interpretar + contenido nuevo). */
  spentUsd: string;
  /** Lo que falta gastar al aplicar los ítems DISPONIBLES (Fase 2: el contenido ya está generado → 0). */
  apply: MinExpMax;
  /** Lo que costarían los pedidos de fase posterior (visible, no se aplica todavía). */
  later: MinExpMax;
  /** Total visible del plan = gastado + aplicar (esperado). */
  totalExpectedUsd: string;
  /** Tope propuesto para aprobar al aplicar = ceil_centavo(aplicar esperado × factor de seguridad de FinOps). */
  proposedCapUsd: string;
  capFactor: number;
  note: string;
}

const addMem = (a: MinExpMax, b: MinExpMax): MinExpMax => ({ min: addDec(a.min, b.min), expected: addDec(a.expected, b.expected), max: addDec(a.max, b.max) });

export function planTotals(input: { spent: Array<string | null | undefined>; available: MinExpMax[]; later: MinExpMax[]; capFactor?: number }): PlanTotals {
  const factor = parseSafetyCapFactor(input.capFactor ?? readSafetyCapFactor());
  const apply = input.available.reduce(addMem, ZERO_MEM);
  const later = input.later.reduce(addMem, ZERO_MEM);
  const spentUsd = sumUsd(...input.spent);
  const proposedCapUsd = safetyCapOf(apply.expected, factor);
  const zeroApply = cmpDec(apply.max, 0) === 0;
  return {
    spentUsd, apply, later, totalExpectedUsd: addDec(spentUsd, apply.expected), proposedCapUsd, capFactor: factor,
    note: zeroApply
      ? 'Aplicar este plan no vuelve a usar IA (el contenido nuevo ya se generó al armarlo): el tope propuesto es USD 0,00.'
      : `Tope propuesto = lo esperado al aplicar × ${String(factor).replace('.', ',')} (margen de seguridad de FinOps).`,
  };
}

/**
 * Compuerta de saldo (D9) — decisión pura: con presupuestos por usuario en `enforce`, la llamada solo se hace si el
 * disponible del mes alcanza para su TOPE DE SEGURIDAD (esperado × factor, como un run del generador). null = pasa.
 */
export function budgetShortfall(estimate: EstimateResult, availableUsd: string | null): { requiredUsd: string; availableUsd: string } | null {
  if (availableUsd === null) return null;
  const required = estimate.totals.safetyCap;
  return cmpDec(required, availableUsd) > 0 ? { requiredUsd: required, availableUsd } : null;
}
