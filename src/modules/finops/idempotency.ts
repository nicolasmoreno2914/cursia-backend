/**
 * V2.1 RF-a — claves de idempotencia del ledger (audit §W.4).
 *
 * Una operación externa cobrada = exactamente una fila CHARGE. La clave sale
 * del ID externo cuando existe; si no hay ID (TTS sin x-request-id) se usa
 * el fallback determinístico por item run / generación / chunk / intento.
 */
import { FinopsError } from './errors';

export type CostIdempotencyKind = 'anthropic' | 'videogen' | 'gamma' | 'openai_tts' | 'youtube' | 'package';

export interface CostIdempotencyParts {
  /** anthropic: message.id (msg_…) */
  messageId?: string | null;
  /** videogen: job id; package: package job id */
  jobId?: string | null;
  /** gamma: generationId */
  generationId?: string | null;
  /** openai_tts: x-request-id de la respuesta */
  requestId?: string | null;
  /** youtube: videoId */
  videoId?: string | null;
  /** openai_tts (fallback sin requestId) */
  itemRunId?: string | null;
  generation?: number | null;
  chunk?: number | null;
  attempt?: number | null;
}

function id(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new FinopsError('INVALID_IDEMPOTENCY_PART', `${what} debe ser un string no vacío`);
  const s = v.trim();
  if (!s || s !== v || /\s/.test(s)) {
    throw new FinopsError('INVALID_IDEMPOTENCY_PART', `${what} vacío o con espacios: ${JSON.stringify(v)}`);
  }
  if (s.length > 512) throw new FinopsError('INVALID_IDEMPOTENCY_PART', `${what} demasiado largo`);
  return s;
}

function int(v: unknown, what: string, min: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw new FinopsError('INVALID_IDEMPOTENCY_PART', `${what} debe ser entero >= ${min} (fue ${JSON.stringify(v)})`);
  }
  return v;
}

export function costIdempotencyKey(kind: CostIdempotencyKind, parts: CostIdempotencyParts): string {
  const p = parts || {};
  switch (kind) {
    case 'anthropic':
      return `anthropic:msg:${id(p.messageId, 'messageId')}`;
    case 'videogen':
      return `videogen:job:${id(p.jobId, 'jobId')}`;
    case 'gamma':
      return `gamma:gen:${id(p.generationId, 'generationId')}`;
    case 'openai_tts':
      if (p.requestId !== null && p.requestId !== undefined) return `openai:req:${id(p.requestId, 'requestId')}`;
      return `tts:${id(p.itemRunId, 'itemRunId')}:${int(p.generation, 'generation', 1)}:${int(p.chunk, 'chunk', 0)}:${int(p.attempt, 'attempt', 1)}`;
    case 'youtube':
      return `youtube:video:${id(p.videoId, 'videoId')}`;
    case 'package':
      return `package:${id(p.jobId, 'jobId')}`;
    default:
      throw new FinopsError('UNKNOWN_IDEMPOTENCY_KIND', `tipo de clave desconocido: ${String(kind)}`);
  }
}

/**
 * Clave de un ADJUSTMENT: `adj:<claveOriginal>:<n>:<nuevoTotal>` donde n es el
 * número ordinal del ajuste (1 = primer ajuste). Dos reintentos del mismo
 * ajuste (mismo n y mismo total) colisionan → una sola fila; una secuencia
 * A→B→A→B produce claves distintas.
 */
export function adjustmentIdempotencyKey(originalKey: string, ordinal: number, newTotal: string): string {
  return `adj:${id(originalKey, 'originalKey')}:${int(ordinal, 'ordinal', 1)}:${id(newTotal, 'newTotal')}`;
}
