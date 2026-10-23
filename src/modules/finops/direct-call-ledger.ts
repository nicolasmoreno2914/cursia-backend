import { ServiceUnavailableException } from '@nestjs/common';
import type { Logger } from '@nestjs/common';
import { spendBlockReason } from './spend-controls';
import type { FinopsLedgerService, RecordChargeInput } from './finops-ledger.service';

/**
 * FinOps P0 (2026-10-16, audit §4 #8): llamadas pagadas por Cursia FUERA del pipeline de runs que antes nunca llegaban
 * al ledger (extracción de marca y de «Datos del curso» con Claude, POST /tts/speech). Se registran DESPUÉS de la
 * respuesta con el uso medido del proveedor (mismo criterio que la lectura avanzada del documento,
 * academic-context.service): el monto sale de usage × pricing_catalog en el servidor, idempotente por el id de la
 * operación del proveedor. Atribución: al curso si se conoce y es del mismo dueño (`attributionCourseId`, verificado
 * en el ledger); si no, sin atribuir con un motivo EXPLÍCITO (nunca NULL silencioso).
 *
 * No reserva antes de llamar: no hay run (ni tope) que proteger y producción todavía no tiene el ledger — una reserva
 * obligatoria rompería estas funciones allí. Si el registro falla se loguea fuerte y la función sigue (la llamada ya
 * se hizo; no se pierde el resultado del usuario).
 */
export type DirectLedger = Pick<FinopsLedgerService, 'recordCharge'>;

/**
 * r58 (AU3 §H4.5): estas llamadas no reservan (ver arriba), así que el kill switch y la allow-list de proveedores se
 * verifican ANTES de llamar: FINOPS_KILL_SWITCH=true o un proveedor fuera de FINOPS_PROVIDER_ALLOWLIST → 503 con
 * `code` estable y CERO llamadas al proveedor. Defaults (sin las env) → sin cambio.
 */
export function assertDirectCallAllowed(provider: string, env: NodeJS.ProcessEnv = process.env): void {
  const r = spendBlockReason(provider, env);
  if (r) throw new ServiceUnavailableException({ code: r.code, message: r.message });
}

export interface DirectAnthropicCall {
  ownerId: string | null | undefined;
  model: string;
  messageId: string | null | undefined;
  usage: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } | null | undefined;
  operation: string;
  recordedBy: string;
  courseId?: number | null;
  unattributedReason: string;
  metadata?: Record<string, unknown>;
}

export function directAnthropicChargeInput(a: DirectAnthropicCall): RecordChargeInput | null {
  if (!a.ownerId || !a.messageId || !a.usage) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
  return {
    ownerIdFromAuth: a.ownerId,
    attributionCourseId: a.courseId ?? null,
    unattributedReason: a.unattributedReason,
    provider: 'anthropic',
    service: 'messages',
    modelOrProduct: a.model,
    operation: a.operation,
    usage: {
      input_tokens: n(a.usage.input_tokens),
      output_tokens: n(a.usage.output_tokens),
      cache_write_tokens: n(a.usage.cache_creation_input_tokens),
      cache_read_tokens: n(a.usage.cache_read_input_tokens),
    },
    usageUnit: 'output_tokens',
    externalOperationId: a.messageId,
    idempotency: { kind: 'anthropic', parts: { messageId: a.messageId } },
    callRole: 'main',
    attempt: 1,
    billingAccount: 'cursia',
    mode: 'real',
    recordedBy: a.recordedBy,
    pricingFallback: 'pending_zero',
    metadata: { ...(a.metadata || {}), serverSide: true },
  };
}

/** Registra una llamada directa a Anthropic. Nunca lanza (best-effort con log fuerte). → registrado. */
export async function recordDirectAnthropicCall(ledger: DirectLedger | null | undefined, logger: Pick<Logger, 'error'>, a: DirectAnthropicCall): Promise<boolean> {
  const input = directAnthropicChargeInput(a);
  if (!ledger || !input) {
    logger.error(`FINOPS_NOT_RECORDED: ${a.operation} (${a.messageId ?? 'sin id'}) — ${!ledger ? 'sin FinOps en este proceso' : 'faltan owner/id/usage'}: el gasto NO quedó en el ledger.`);
    return false;
  }
  try {
    await ledger.recordCharge(input);
    return true;
  } catch (err) {
    logger.error(`FINOPS_NOT_RECORDED: ${a.operation} (${a.messageId}): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export interface DirectTtsCall {
  ownerId: string | null | undefined;
  model: string;
  requestId: string | null | undefined;
  /** Segundos medidos del audio devuelto; null → cargo `pending` (nunca se inventa un monto). */
  audioSeconds: number | null;
  characters: number;
  courseId?: number | null;
  unattributedReason: string;
  recordedBy: string;
  /** Id local de la llamada (si OpenAI no devolvió x-request-id): clave idempotente única. */
  localCallId: string;
}

export function directTtsChargeInput(a: DirectTtsCall): RecordChargeInput | null {
  if (!a.ownerId) return null;
  const measured = typeof a.audioSeconds === 'number' && Number.isFinite(a.audioSeconds) && a.audioSeconds > 0;
  const reqId = typeof a.requestId === 'string' && a.requestId && !/\s/.test(a.requestId) ? a.requestId : null;
  return {
    ownerIdFromAuth: a.ownerId,
    attributionCourseId: a.courseId ?? null,
    unattributedReason: a.unattributedReason,
    provider: 'openai',
    service: 'audio.speech',
    modelOrProduct: a.model,
    operation: 'tts.speech',
    usage: measured ? { audio_seconds: (Math.round((a.audioSeconds as number) * 1000) / 1000).toFixed(3) } : {},
    usageUnit: 'audio_seconds',
    externalOperationId: reqId,
    idempotencyKey: reqId ? `openai:req:${reqId}` : `openai:tts-speech:${a.localCallId}`,
    callRole: 'main',
    attempt: 1,
    billingAccount: 'cursia',
    mode: 'real',
    costSource: 'CALCULATED_FROM_USAGE',
    measurementStatus: measured ? 'final' : 'pending',
    // Review r1 (m1): sin medición → «sin precio» explícito (lista de no preciados + completeness 'partial').
    unmeasuredUsage: !measured,
    pricingFallback: 'pending_zero',
    recordedBy: a.recordedBy,
    metadata: { costBasis: 'measured_audio_seconds x pricing_catalog', characters: a.characters, serverSide: true,
      ...(measured ? {} : { pendingReason: 'tts_audio_not_measurable' }) },
  };
}

export async function recordDirectTtsCall(ledger: DirectLedger | null | undefined, logger: Pick<Logger, 'error'>, a: DirectTtsCall): Promise<boolean> {
  const input = directTtsChargeInput(a);
  if (!ledger || !input) {
    logger.error(`FINOPS_NOT_RECORDED: tts.speech (${a.requestId ?? a.localCallId}) — ${!ledger ? 'sin FinOps en este proceso' : 'sin owner'}: el gasto NO quedó en el ledger.`);
    return false;
  }
  try {
    await ledger.recordCharge(input);
    return true;
  } catch (err) {
    logger.error(`FINOPS_NOT_RECORDED: tts.speech (${a.requestId ?? a.localCallId}): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
