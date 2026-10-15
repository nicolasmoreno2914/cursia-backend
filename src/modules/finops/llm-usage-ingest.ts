/**
 * V2.1 RF-a — validación pura del body de `POST /finops/ingest/llm-usage`
 * y su traducción a RecordChargeInput (HD-V21-17: medición LLM server-side).
 *
 * El proxy (RF-b) postea: sujeto del JWT que él verificó, itemRunId
 * declarado (se verifica contra el sujeto en el ledger), callRole, attempt,
 * model, messageId (msg_…), requestId, usage de Anthropic y billingAccount.
 * Nunca se aceptan montos del caller: el monto se calcula del usage.
 */
import { FinopsError } from './errors';
export { llmUpperBoundVariants } from './pricing';
import { CALL_ROLES, CallRole, RecordChargeInput } from './finops-ledger.service';

export interface LlmUsageIngestBody {
  subject: string;
  itemRunId?: string | null;
  callRole: CallRole;
  attempt: number;
  model: string;
  messageId: string;
  requestId?: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  billingAccount: 'cursia' | 'user_key';
  mode?: 'real' | 'mock';
  /**
   * #583 fix round 1 (I1): streaming a través del proxy.
   * - 'conservative': el navegador se fue a mitad del stream; el proxy registra YA un cargo conservador
   *   (output = max_tokens del pedido) marcado metadata.conservative — nunca se registra de menos.
   * - 'correction': el proxy terminó de leer el stream y trae el usage EXACTO de ese mismo messageId:
   *   ajusta el cargo conservador (ADJUSTMENT por la diferencia); si el conservador no llegó, es el cargo.
   * Ausente = cargo normal (de siempre).
   */
  measurement?: 'conservative' | 'correction';
  /**
   * Piloto #1209 (2026-10-11): id de la llamada que el proxy RESERVÓ antes de llamar a Anthropic
   * (POST /finops/ingest/llm-reservation). Con callId, este usage LIQUIDA esa reserva (cargo exacto por
   * messageId + reserva a 0, atómico). Sin reserva previa (proxy viejo / reserva fallida) es el cargo de siempre.
   */
  callId?: string | null;
}

const ALLOWED_KEYS = new Set(['subject', 'itemRunId', 'callRole', 'attempt', 'model', 'messageId', 'requestId', 'usage', 'billingAccount', 'mode', 'measurement', 'callId']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Caracteres por token para la cota de la reserva (la misma que usan los workers: conservadora). */
export const LLM_RESERVATION_CHARS_PER_TOKEN = 3;

/**
 * Cota SUPERIOR de una llamada LLM antes de hacerla (guard + reserva; FinOps atómico 2026-10-14): toda la entrada al
 * precio de ESCRITURA de caché (el medidor de entrada más caro: el prefijo con cache_control se cobra a 1,25×) y la
 * salida al tope `max_tokens`. El cargo real (entrada sin caché + caché escrita/leída + salida ≤ max_tokens) nunca la
 * supera → la suma de reservas acota el gasto real y el tope del run se puede garantizar al reservar.
 */
export function llmCallUpperBoundUsage(promptChars: number, maxTokens: number): { cache_write_tokens: number; output_tokens: number } {
  return {
    cache_write_tokens: Math.max(1, Math.ceil(Math.max(0, Number(promptChars) || 0) / LLM_RESERVATION_CHARS_PER_TOKEN)),
    output_tokens: Math.max(1, Math.floor(Number(maxTokens) || 1)),
  };
}

function bad(msg: string): never {
  throw new FinopsError('INVALID_INPUT', msg);
}

function tokenCount(v: unknown, what: string, required: boolean): number | null {
  if (v === null || v === undefined) {
    if (required) bad(`usage.${what} es obligatorio`);
    return null;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) bad(`usage.${what} debe ser entero >= 0`);
  return v as number;
}

export function parseLlmUsageIngest(body: unknown): LlmUsageIngestBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('body debe ser un objeto JSON');
  const b = body as Record<string, any>;
  for (const k of Object.keys(b)) if (!ALLOWED_KEYS.has(k)) bad(`campo no permitido: ${k}`);
  const str = (k: string, required: boolean): string | null => {
    const v = b[k];
    if (v === null || v === undefined || v === '') {
      if (required) bad(`${k} es obligatorio`);
      return null;
    }
    if (typeof v !== 'string' || v.length > 256 || /\s/.test(v)) bad(`${k} inválido`);
    return v;
  };
  const subject = str('subject', true) as string;
  const itemRunId = str('itemRunId', false);
  const model = str('model', true) as string;
  const messageId = str('messageId', true) as string;
  const requestId = str('requestId', false);
  const callRole = b.callRole as CallRole;
  if (!CALL_ROLES.includes(callRole)) bad(`callRole inválido: ${String(b.callRole)}`);
  if (typeof b.attempt !== 'number' || !Number.isInteger(b.attempt) || b.attempt < 1) bad('attempt debe ser entero >= 1');
  if (b.billingAccount !== 'cursia' && b.billingAccount !== 'user_key') bad('billingAccount debe ser cursia | user_key');
  const mode = b.mode ?? 'real';
  if (mode !== 'real' && mode !== 'mock') bad('mode debe ser real | mock');
  const u = b.usage;
  if (!u || typeof u !== 'object' || Array.isArray(u)) bad('usage es obligatorio');
  const usage = {
    input_tokens: tokenCount(u.input_tokens, 'input_tokens', true) as number,
    output_tokens: tokenCount(u.output_tokens, 'output_tokens', true) as number,
    cache_creation_input_tokens: tokenCount(u.cache_creation_input_tokens, 'cache_creation_input_tokens', false),
    cache_read_input_tokens: tokenCount(u.cache_read_input_tokens, 'cache_read_input_tokens', false),
  };
  const measurement = b.measurement ?? undefined;
  if (measurement !== undefined && measurement !== 'conservative' && measurement !== 'correction') bad('measurement debe ser conservative | correction');
  const callId = b.callId === undefined || b.callId === null ? null : String(b.callId);
  if (callId !== null && !UUID_RE.test(callId)) bad('callId debe ser un UUID');
  // Review (minor 5): callId (liquida una reserva) y measurement (camino conservador/corrección) son excluyentes.
  if (callId !== null && measurement !== undefined) bad('callId y measurement no se combinan');
  return { subject, itemRunId, callRole, attempt: b.attempt, model, messageId, requestId, usage, billingAccount: b.billingAccount, mode,
    ...(measurement ? { measurement } : {}), ...(callId ? { callId } : {}) };
}

// ─── Reserva ANTES de la llamada (proxy LLM del navegador) ────────────────────
// Mismo protocolo que los workers (finops-worker-hooks reservePaidCall/settlePaidCall): reserva durable
// (CHARGE `pending`, metadata.reservation) → llamada → liquidación atómica. Si la respuesta se pierde (524,
// Worker terminado, el navegador se fue), la reserva QUEDA: cuenta en el presupuesto y aparece en las reservas
// pendientes del panel de admin para conciliarla explícitamente (nunca se libera sola).

export interface LlmReservationIngestBody {
  subject: string;
  itemRunId?: string | null;
  callRole: CallRole;
  attempt: number;
  model: string;
  callId: string;
  /** Caracteres del pedido (system + mensajes): cota de los tokens de entrada. */
  promptChars: number;
  /** max_tokens del pedido: cota de la salida. */
  maxTokens: number;
  billingAccount: 'cursia' | 'user_key';
  mode?: 'real' | 'mock';
}

const RESERVATION_KEYS = new Set(['subject', 'itemRunId', 'callRole', 'attempt', 'model', 'callId', 'promptChars', 'maxTokens', 'billingAccount', 'mode']);

export function llmProxyReservationKey(callId: string): string {
  return `reservation:llm-proxy:${callId}`;
}

export function parseLlmReservationIngest(body: unknown): LlmReservationIngestBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('body debe ser un objeto JSON');
  const b = body as Record<string, any>;
  for (const k of Object.keys(b)) if (!RESERVATION_KEYS.has(k)) bad(`campo no permitido: ${k}`);
  const str = (k: string, required: boolean): string | null => {
    const v = b[k];
    if (v === null || v === undefined || v === '') {
      if (required) bad(`${k} es obligatorio`);
      return null;
    }
    if (typeof v !== 'string' || v.length > 256 || /\s/.test(v)) bad(`${k} inválido`);
    return v;
  };
  const subject = str('subject', true) as string;
  const itemRunId = str('itemRunId', false);
  const model = str('model', true) as string;
  const callId = str('callId', true) as string;
  if (!UUID_RE.test(callId)) bad('callId debe ser un UUID');
  const callRole = b.callRole as CallRole;
  if (!CALL_ROLES.includes(callRole)) bad(`callRole inválido: ${String(b.callRole)}`);
  if (typeof b.attempt !== 'number' || !Number.isInteger(b.attempt) || b.attempt < 1) bad('attempt debe ser entero >= 1');
  if (typeof b.promptChars !== 'number' || !Number.isInteger(b.promptChars) || b.promptChars < 0) bad('promptChars debe ser entero >= 0');
  if (typeof b.maxTokens !== 'number' || !Number.isInteger(b.maxTokens) || b.maxTokens < 1) bad('maxTokens debe ser entero >= 1');
  if (b.billingAccount !== 'cursia' && b.billingAccount !== 'user_key') bad('billingAccount debe ser cursia | user_key');
  const mode = b.mode ?? 'real';
  if (mode !== 'real' && mode !== 'mock') bad('mode debe ser real | mock');
  return { subject, itemRunId, callRole, attempt: b.attempt, model, callId, promptChars: b.promptChars, maxTokens: b.maxTokens, billingAccount: b.billingAccount, mode };
}

// Liberación de la reserva: SOLO cuando Anthropic rechazó el pedido de forma definitiva y documentadamente
// sin cobro (no autenticado / sin permiso / no encontrado / demasiado grande / rate limit / sobrecargado),
// antes de procesarlo. Cualquier otro error (400 incluido: el piloto #1209 mostró 400 con costo en la
// consola; 5xx; cortes) es INCIERTO → la reserva queda pendiente para conciliar.
// Loop de costos (review C2): 500 = api_error de Anthropic (error interno, no se factura) → también se libera; si no,
// cada error temporal del proveedor dejaba una reserva a max_tokens que consumía el presupuesto de la parte.
export const LLM_RESERVATION_RELEASABLE_STATUSES = [401, 403, 404, 413, 429, 500, 529] as const;

export interface LlmReservationReleaseBody {
  callId: string;
  providerStatus: number;
  requestId?: string | null;
}

export function parseLlmReservationRelease(body: unknown): LlmReservationReleaseBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('body debe ser un objeto JSON');
  const b = body as Record<string, any>;
  for (const k of Object.keys(b)) if (!['callId', 'providerStatus', 'requestId'].includes(k)) bad(`campo no permitido: ${k}`);
  if (typeof b.callId !== 'string' || !UUID_RE.test(b.callId)) bad('callId debe ser un UUID');
  if (!(LLM_RESERVATION_RELEASABLE_STATUSES as readonly number[]).includes(b.providerStatus)) {
    bad(`providerStatus ${String(b.providerStatus)} no libera la reserva (resultado incierto: queda pendiente)`);
  }
  let requestId: string | null = null;
  if (b.requestId !== undefined && b.requestId !== null && b.requestId !== '') {
    if (typeof b.requestId !== 'string' || b.requestId.length > 256 || /\s/.test(b.requestId)) bad('requestId inválido');
    requestId = b.requestId;
  }
  return { callId: b.callId, providerStatus: b.providerStatus, requestId };
}

/** Reserva validada → CHARGE `pending` (cota conservadora: entrada = caracteres/3, salida = max_tokens). */
export function llmReservationToChargeInput(body: LlmReservationIngestBody): RecordChargeInput {
  const mock = body.mode === 'mock';
  return {
    itemRunId: body.itemRunId ?? null,
    ownerIdFromAuth: body.subject,
    provider: 'anthropic',
    service: 'messages',
    modelOrProduct: body.model,
    usage: llmCallUpperBoundUsage(body.promptChars, body.maxTokens),
    usageUnit: 'output_tokens',
    externalOperationId: null,
    idempotencyKey: llmProxyReservationKey(body.callId),
    callRole: body.callRole,
    attempt: body.attempt,
    billingAccount: mock ? 'mock' : body.billingAccount,
    mode: mock ? 'mock' : 'real',
    costSource: 'CALCULATED_FROM_USAGE',
    measurementStatus: 'pending',
    pricingFallback: 'pending_zero',
    recordedBy: 'llm-proxy',
    metadata: { reservation: true, llmUpperBound: true, estimatedPending: true, reservedBeforeCall: true, callTag: 'proxy', callId: body.callId, proxy: true,
      promptChars: body.promptChars, maxTokens: body.maxTokens, billingAccountRequested: body.billingAccount },
  };
}

/** Body validado → input del ledger (medidores con los nombres del catálogo). */
export function llmIngestToChargeInput(body: LlmUsageIngestBody): RecordChargeInput {
  const mock = body.mode === 'mock';
  return {
    itemRunId: body.itemRunId ?? null,
    ownerIdFromAuth: body.subject,
    provider: 'anthropic',
    service: 'messages',
    modelOrProduct: body.model,
    usage: {
      input_tokens: body.usage.input_tokens,
      output_tokens: body.usage.output_tokens,
      cache_write_tokens: body.usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens: body.usage.cache_read_input_tokens ?? 0,
    },
    usageUnit: 'output_tokens',
    externalOperationId: body.messageId,
    idempotency: { kind: 'anthropic', parts: { messageId: body.messageId } },
    callRole: body.callRole,
    attempt: body.attempt,
    billingAccount: mock ? 'mock' : body.billingAccount,
    mode: mock ? 'mock' : 'real',
    recordedBy: 'llm-proxy',
    // RF-b fix C1/I2: un cargo LLM real nunca se pierde por un precio faltante.
    pricingFallback: 'pending_zero',
    metadata: {
      requestId: body.requestId ?? null,
      billingAccountRequested: body.billingAccount,
      ...(body.measurement === 'conservative' ? { conservative: true, conservativeReason: 'stream_client_gone' } : {}),
      ...(body.measurement === 'correction' ? { measuredFromStream: true } : {}),
    },
  };
}
