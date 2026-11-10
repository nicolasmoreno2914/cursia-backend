/**
 * r107 B10 · Fase 3 — PUERTOS de los proveedores pagos y la COMPUERTA de cada llamada.
 *
 * La producción de una actividad nunca habla con un proveedor directamente: lo hace por estos puertos (el servicio cablea
 * los clientes reales existentes — `AnthropicClient`, `OpenAiTtsClient`, `GammaClient`, `VideogenService`, YouTube —; las
 * pruebas, simulados) y CADA llamada pasa antes por la compuerta (`PaidCallGate`, B5): gastado + cota de esta llamada ≤
 * tope aprobado, kill switch del proveedor, y la llamada queda registrada `sent` ANTES de enviarla. Después se clasifica
 * con el criterio de B5 (`charged` / `not_charged` / `not_sent` / `ambiguous` / `charge_unrecorded`): un resultado que no
 * se sabe si se cobró NUNCA se reenvía solo (la reserva del tope queda pendiente para conciliar).
 *
 * Puro (sin red): solo interfaces, clasificación y precios con el catálogo de FinOps.
 */
import type { RecordChargeInput } from '../../finops/finops-ledger.service';
import { priceUsage } from '../../finops/pricing';
import { LLM_RESERVATION_RELEASABLE_STATUSES, llmCallUpperBoundUsage } from '../../finops/llm-usage-ingest';
import type { DryRunPricing } from '../../pedagogy/dry-run';
import type { CoverRasterizer } from '../../../workers/provider-real/pdf-cover';
import type { GammaGenerationStatus } from '../../../workers/provider-real/provider-clients';
import type { VideogenBatchJob, VideogenVideoPayload } from '../../../video-engine/videogen.service';
import { RegenError, RegenProvider } from './types';

// ─── Puertos ────────────────────────────────────────────────────────────────

export interface LlmUsage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
export interface LlmPort {
  messages(req: { model: string; system: string; user: string; maxTokens: number }): Promise<{ text: string; messageId: string; model: string; usage: LlmUsage; stopReason: string | null }>;
}
export interface TtsPort {
  speech(req: { model: string; voice: string; input: string }): Promise<{ audio: Buffer; requestId: string | null }>;
}
export interface GammaPort {
  createGeneration(body: Record<string, unknown>): Promise<string>;
  getGeneration(id: string): Promise<GammaGenerationStatus>;
  download(url: string): Promise<Buffer>;
}
export interface VideogenPort {
  /** Envía UN render (el payload del Video Engine). Devuelve el id del job. */
  create(payload: VideogenVideoPayload): Promise<{ jobId: string }>;
  status(jobId: string): Promise<VideogenBatchJob>;
  /** Costo informado por Videogen (null si no lo informa). */
  cost(jobId: string): Promise<number | null>;
  download(url: string): Promise<Buffer>;
}
export interface YoutubePort {
  /** null = listo para subir; si no, el motivo (sin conexión / reautorizar): se verifica ANTES de pagar el render. */
  ready(): Promise<string | null>;
  upload(a: { videoUrl: string; title: string }): Promise<{ videoId: string }>;
}
export interface MediaTools {
  rasterizer: CoverRasterizer;
  /** ffmpeg para el transcode a 64 kbps mono: se verifica ANTES de pagar el TTS (sin él, no se llama). */
  transcoderAvailable(): Promise<boolean>;
  transcode(mp3: Buffer, kbps: number): Promise<Buffer>;
}

export interface RegenProviders {
  llm: LlmPort;
  tts: TtsPort;
  gamma: GammaPort;
  videogen: VideogenPort;
  youtube: YoutubePort;
  media: MediaTools;
  /** true = simulados (pruebas): los cargos se registran `mock`, nunca como gasto real. */
  simulated: boolean;
  /** Modelos / voz / tema fijados por Cursia (el docente no elige). */
  config: { llmModel: string; ttsModel: string; ttsVoice: string; gammaThemeId: string | null; missing: string[] };
  /** Tiempos de espera de los proveedores asíncronos (Gamma / Videogen). */
  poll: { intervalMs: number; timeoutMs: number };
}

// ─── Compuerta ──────────────────────────────────────────────────────────────

export interface PaidCallSpec {
  provider: RegenProvider;
  /** Qué se paga (p. ej. `llm:scorm_room`, `tts:chunk`, `gamma:generate`, `videogen:render`, `youtube:upload`). */
  kind: string;
  /** Cota USD de ESTA llamada (lo máximo que puede costar): la guarda del tope la usa antes de llamar. */
  boundUsd: string;
  attempt: number;
}

export type CallOutcomeStatus = 'not_charged' | 'not_sent' | 'ambiguous';

export interface PaidCallTicket {
  readonly id: string;
  /** El proveedor aceptó el pedido (id externo): sigue `sent` hasta medir; si después algo falla, queda ambiguo. */
  accepted(externalId: string): Promise<void>;
  /** Resultado medido: costo + cargo del ledger (null = nada que registrar, p. ej. YouTube USD 0). */
  charged(m: { costUsd: string; charge: RecordChargeInput | null; externalId?: string | null }): Promise<void>;
  /** Falla: registra el estado y devuelve el error a lanzar (ambiguo → no se reenvía; la reserva queda pendiente). */
  failed(err: unknown, outcome: CallOutcomeStatus): Promise<RegenError>;
}

export interface PaidCallGate {
  /** Guarda del tope + kill switch + registro `sent`. Lanza RegenError (`cap_reached` / `not_sent`) sin llamar. */
  begin(spec: PaidCallSpec): Promise<PaidCallTicket>;
  /** Contexto del cargo (dueño que paga, curso, aprobación) para armar los RecordChargeInput. */
  readonly charge: ChargeContext;
}

export interface ChargeContext {
  payer: string;
  courseId: number | null;
  approvalId: string;
  sessionId: string;
  simulated: boolean;
}

/** Corre UNA llamada pagada por la compuerta. `measure` arma el costo y el cargo del resultado. */
export async function paidCall<T>(gate: PaidCallGate, spec: PaidCallSpec, send: () => Promise<T>, classify: (err: unknown) => CallOutcomeStatus, measure: (r: T, callId: string) => { costUsd: string; charge: RecordChargeInput | null; externalId?: string | null }): Promise<T> {
  const t = await gate.begin(spec);
  let r: T;
  try {
    r = await send();
  } catch (err) {
    throw await t.failed(err, classify(err));
  }
  let m: { costUsd: string; charge: RecordChargeInput | null; externalId?: string | null };
  try {
    m = measure(r, t.id);
  } catch (err) {
    // Respondió pero no se pudo medir: pudo cobrarse → ambiguo (nunca un 0 inventado).
    throw await t.failed(err, 'ambiguous');
  }
  await t.charged(m);
  return r;
}

// ─── Clasificación por proveedor (criterio de B5 + reglas existentes de cada proveedor) ───────────────────────────

const statusOf = (err: unknown): number | null => {
  const st = (err as { status?: unknown })?.status;
  if (typeof st === 'number') return st;
  // VideogenService lanza Error con «(HTTP nnn)» en el mensaje.
  const m = /\(HTTP (\d{3})\)/.exec(err instanceof Error ? err.message : String(err ?? ''));
  return m ? Number(m[1]) : null;
};
const notSent = (err: unknown): boolean => (err as { notSent?: unknown })?.notSent === true;

/** Anthropic: los estados documentados sin cobro del proxy (B5); lo demás después de enviar = ambiguo. */
export function classifyAnthropic(err: unknown): CallOutcomeStatus {
  if (notSent(err)) return 'not_sent';
  const s = statusOf(err);
  return s !== null && (LLM_RESERVATION_RELEASABLE_STATUSES as readonly number[]).includes(s) ? 'not_charged' : 'ambiguous';
}
/** OpenAI TTS: rechazo de admisión (429/503/529) o 4xx definitivo (no 408/409) = sin cobro; el resto, ambiguo. */
export function classifyTts(err: unknown): CallOutcomeStatus {
  if (notSent(err)) return 'not_sent';
  const s = statusOf(err);
  if (s === null) return 'ambiguous';
  if ([429, 503, 529].includes(s)) return 'not_charged';
  return s >= 400 && s < 500 && s !== 408 && s !== 409 ? 'not_charged' : 'ambiguous';
}
/** Gamma / Videogen / YouTube: solo un 4xx con respuesta (no 408/409) es un rechazo previo a la aceptación. */
export function classifySubmission(err: unknown): CallOutcomeStatus {
  if (notSent(err)) return 'not_sent';
  const s = statusOf(err);
  return s !== null && s >= 400 && s < 500 && s !== 408 && s !== 409 ? 'not_charged' : 'ambiguous';
}

// ─── Cotas y precios (catálogo de FinOps; nada inventado) ─────────────────────────────────────────────────────────

const PRICE = (pricing: DryRunPricing, provider: string, service: string, product: string, usage: Record<string, number | string>): string =>
  priceUsage(usage as any, pricing.catalog, { provider, service, product, asOf: pricing.asOf ?? null } as any).amount;

/** Margen de la reserva de proveedores no-LLM (FinOps atómico: ×1,25 del estimado). */
export const REGEN_PROVIDER_MARGIN = 1.25;
/** Velocidad de habla que usa FinOps para estimar un TTS (caracteres por segundo). */
export const TTS_CHARS_PER_SECOND = 15;
/** Créditos de una generación de Gamma (p90 del usage model `gamma.generate`). */
export const GAMMA_CREDITS_P90 = 100;

export function llmBoundUsd(pricing: DryRunPricing, model: string, promptChars: number, maxTokens: number): string {
  const u = llmCallUpperBoundUsage(promptChars, maxTokens);
  return PRICE(pricing, 'anthropic', 'messages', model, { cache_write_tokens: u.cache_write_tokens, output_tokens: u.output_tokens });
}
export function llmMeasuredUsd(pricing: DryRunPricing, model: string, u: LlmUsage): string {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return PRICE(pricing, 'anthropic', 'messages', model, { input_tokens: n(u.input_tokens), output_tokens: n(u.output_tokens), cache_write_tokens: n(u.cache_creation_input_tokens), cache_read_tokens: n(u.cache_read_input_tokens) });
}
/** Cota de un trozo de TTS: los segundos estimados × 2 × margen (la voz puede ir más lenta). */
export function ttsBoundUsd(pricing: DryRunPricing, model: string, chars: number): string {
  const secs = Math.max(1, Math.ceil((chars / TTS_CHARS_PER_SECOND) * 2 * REGEN_PROVIDER_MARGIN));
  return PRICE(pricing, 'openai', 'audio.speech', model, { audio_seconds: secs });
}
export function ttsMeasuredUsd(pricing: DryRunPricing, model: string, seconds: number): string {
  return PRICE(pricing, 'openai', 'audio.speech', model, { audio_seconds: (Math.round(seconds * 1000) / 1000).toFixed(3) });
}
export function gammaBoundUsd(pricing: DryRunPricing): string {
  return PRICE(pricing, 'gamma', 'generations', 'gamma-generate', { gamma_credit: Math.ceil(GAMMA_CREDITS_P90 * REGEN_PROVIDER_MARGIN) });
}
export function gammaMeasuredUsd(pricing: DryRunPricing, credits: number): string {
  return PRICE(pricing, 'gamma', 'generations', 'gamma-generate', { gamma_credit: credits });
}
export function videogenBoundUsd(pricing: DryRunPricing): string {
  const one = Number(PRICE(pricing, 'videogen', 'render', 'video', { video_render: 1 }));
  return (Math.ceil(one * REGEN_PROVIDER_MARGIN * 100) / 100).toFixed(6);
}
export function videogenCatalogUsd(pricing: DryRunPricing): string {
  return PRICE(pricing, 'videogen', 'render', 'video', { video_render: 1 });
}

// ─── Cargos del ledger (llamadas DIRECTAS del Taller, sin run: atribución al curso si el que paga es su dueño) ──────

const RECORDED_BY = 'course-workshop';
function base(c: ChargeContext, callId: string, extra: Record<string, unknown>): Pick<RecordChargeInput, 'ownerIdFromAuth' | 'attributionCourseId' | 'unattributedReason' | 'callRole' | 'attempt' | 'billingAccount' | 'mode' | 'recordedBy' | 'pricingFallback' | 'metadata'> {
  return {
    ownerIdFromAuth: c.payer, attributionCourseId: c.courseId, unattributedReason: 'course_workshop', callRole: 'main', attempt: 1,
    billingAccount: c.simulated ? 'mock' : 'cursia', mode: c.simulated ? 'mock' : 'real', recordedBy: RECORDED_BY, pricingFallback: 'pending_zero',
    metadata: { kind: 'course_workshop', purpose: 'regenerate', approvalId: c.approvalId, callId, sessionId: c.sessionId, serverSide: true, ...(c.simulated ? { simulated: true } : {}), ...extra },
  };
}

export function llmChargeInput(c: ChargeContext, callId: string, r: { model: string; messageId: string; usage: LlmUsage }, what: string): RecordChargeInput {
  const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
  return {
    ...base(c, callId, { what }),
    provider: 'anthropic', service: 'messages', modelOrProduct: r.model, operation: 'llm.workshop_regenerate',
    usage: { input_tokens: n(r.usage.input_tokens), output_tokens: n(r.usage.output_tokens), cache_write_tokens: n(r.usage.cache_creation_input_tokens), cache_read_tokens: n(r.usage.cache_read_input_tokens) },
    usageUnit: 'output_tokens', externalOperationId: r.messageId, idempotency: { kind: 'anthropic', parts: { messageId: r.messageId } },
    ...(c.simulated ? { costSource: 'MOCK' } : {}),
  } as RecordChargeInput;
}
export function ttsChargeInputOf(c: ChargeContext, callId: string, r: { model: string; requestId: string | null; seconds: number | null; characters: number }): RecordChargeInput {
  const measured = typeof r.seconds === 'number' && Number.isFinite(r.seconds) && r.seconds > 0;
  const reqId = r.requestId && !/\s/.test(r.requestId) ? r.requestId : null;
  return {
    ...base(c, callId, { characters: r.characters, costBasis: 'measured_audio_seconds x pricing_catalog', ...(measured ? {} : { pendingReason: 'tts_audio_not_measurable' }) }),
    provider: 'openai', service: 'audio.speech', modelOrProduct: r.model, operation: 'tts.workshop_regenerate',
    usage: measured ? { audio_seconds: (Math.round((r.seconds as number) * 1000) / 1000).toFixed(3) } : {},
    usageUnit: 'audio_seconds', externalOperationId: reqId,
    idempotencyKey: reqId ? `openai:req:${reqId}` : `openai:workshop-tts:${callId}`,
    costSource: c.simulated ? 'MOCK' : 'CALCULATED_FROM_USAGE', measurementStatus: measured ? 'final' : 'pending', unmeasuredUsage: !measured,
  } as RecordChargeInput;
}
export function gammaChargeInputOf(c: ChargeContext, callId: string, r: { generationId: string; credits: number | null; failed?: boolean }): RecordChargeInput {
  const measured = typeof r.credits === 'number' && Number.isFinite(r.credits) && r.credits >= 0;
  return {
    ...base(c, callId, { costBasis: 'gamma.credits.deducted x pricing_catalog', ...(measured ? {} : { pendingReason: 'gamma_credits_not_reported' }) }),
    provider: 'gamma', service: 'generations', modelOrProduct: 'gamma-generate', operation: 'gamma.workshop_regenerate',
    usage: measured ? { gamma_credit: r.credits as number } : {}, usageUnit: 'gamma_credit', externalOperationId: r.generationId,
    idempotency: { kind: 'gamma', parts: { generationId: r.generationId } },
    costSource: c.simulated ? 'MOCK' : 'CALCULATED_FROM_USAGE', measurementStatus: measured ? 'final' : 'pending',
    outcome: r.failed ? (measured && (r.credits as number) > 0 ? 'failed_charged' : 'failed_uncharged') : 'succeeded',
  } as RecordChargeInput;
}
export function videogenChargeInputOf(c: ChargeContext, callId: string, r: { jobId: string; cost: number | null }): RecordChargeInput {
  const measured = typeof r.cost === 'number' && Number.isFinite(r.cost) && r.cost >= 0;
  return {
    ...base(c, callId, { costBasis: measured ? 'videogen.getVideoCost.estimated_total_cost' : 'pricing_catalog_provisional', ...(measured ? {} : { pendingReason: 'cost_lookup_failed' }) }),
    provider: 'videogen', service: 'render', modelOrProduct: 'video', operation: 'videogen.workshop_regenerate',
    usage: { video_render: 1 }, usageUnit: 'video_render', externalOperationId: r.jobId, idempotency: { kind: 'videogen', parts: { jobId: r.jobId } },
    costSource: c.simulated ? 'MOCK' : 'CALCULATED_FROM_USAGE', measurementStatus: measured ? 'final' : 'pending',
    ...(measured && !c.simulated ? { providerCalculatedAmount: String(r.cost) } : {}),
  } as RecordChargeInput;
}
