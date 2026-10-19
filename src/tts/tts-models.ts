/**
 * r60 Q-22: modelo de OpenAI TTS compartido (sin dependencias: lo importan tts.service, audio-worker y
 * real-providers sin ciclos).
 *
 * El alias `gpt-4o-mini-tts` se colgaba de forma intermitente (pruebas reales 2026-10-19: 5 de 11 llamadas
 * tardaron 2–3 min y se cobraron); el snapshot fijo, 0 de 13. Mismo precio (filas propias en pricing-seed.v1).
 */
export const TTS_SNAPSHOT_MODEL = 'gpt-4o-mini-tts-2025-03-20';
/** Alias sin fecha: es lo que manda el frontend V1 (`model: 'gpt-4o-mini-tts'`). */
export const TTS_ALIAS_MODEL = 'gpt-4o-mini-tts';

type Env = Record<string, string | undefined>;

export interface ResolvedTtsModel {
  /** Modelo que se envía de verdad a OpenAI (y el que se registra en eventos y ledger). */
  model: string;
  /** Modelo pedido (opción explícita, OPENAI_TTS_MODEL o el default), antes de normalizar. */
  requested: string;
  /** true si el alias exacto se cambió por el snapshot. */
  normalized: boolean;
}

/**
 * Modelo efectivo: el pedido explícito, si no OPENAI_TTS_MODEL, si no el snapshot. El alias EXACTO
 * `gpt-4o-mini-tts` (venga de donde venga) se cambia por el snapshot, salvo OPENAI_TTS_ALLOW_ALIAS=true.
 * Cualquier otro modelo (otro snapshot, tts-1…) se respeta tal cual.
 */
export function resolveTtsModel(requestedModel: string | null | undefined, env: Env = process.env): ResolvedTtsModel {
  const pick = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const requested = pick(requestedModel) || pick(env.OPENAI_TTS_MODEL) || TTS_SNAPSHOT_MODEL;
  if (requested === TTS_ALIAS_MODEL && env.OPENAI_TTS_ALLOW_ALIAS !== 'true') {
    return { model: TTS_SNAPSHOT_MODEL, requested, normalized: true };
  }
  return { model: requested, requested, normalized: false };
}
