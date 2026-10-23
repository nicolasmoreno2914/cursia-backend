// ─────────────────────────────────────────────────────────────────────────────
// r62 (E2E M) — «resultado pagado perdido». Ids de operaciones pagadas cuyo RESULTADO quedó guardado en el item del
// audiolibro (mismo criterio que persistedAudiobookOps del worker, real-providers.ts): un cargo liquidado de un intento
// no reconocido cuyo id externo NO está acá perdió su resultado. Puro (sin importar el worker: evita el ciclo
// RunsService ↔ real-providers).
// ─────────────────────────────────────────────────────────────────────────────

/** Marca del item reabierto por un resultado pagado perdido: el cargo NUEVO del reenvío lleva possible_duplicate. */
export const LOST_RESULT_RESEND_KEY = 'lostResultResend';

export function persistedPaidOpIds(os: Record<string, any> | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const s of Object.values((os?.audiobookSections ?? {}) as Record<string, any>)) for (const m of s?.messageIds ?? []) if (m) ids.add(String(m));
  for (const g of Object.values((os?.audioSegments ?? {}) as Record<string, any>)) if (g?.requestId) ids.add(String(g.requestId));
  for (const list of Object.values((os?.audiobookExtensions ?? {}) as Record<string, any[]>)) for (const e of list ?? []) for (const m of e?.messageIds ?? []) if (m) ids.add(String(m));
  for (const d of Array.isArray(os?.audiobookDiscardedOps) ? os!.audiobookDiscardedOps : []) if (typeof d === 'string' && d) ids.add(d);
  // r67: partes pagadas de un split guardadas y originales fuera de ritmo en cuarentena: su resultado SÍ quedó guardado.
  for (const m of Object.values((os?.audioSplitParts ?? {}) as Record<string, Record<string, any>>)) for (const x of Object.values(m ?? {})) if (x?.requestId) ids.add(String(x.requestId));
  for (const list of Object.values((os?.audioQuarantine ?? {}) as Record<string, any[]>)) for (const q of Array.isArray(list) ? list : []) for (const r of q?.requestIds ?? []) if (r) ids.add(String(r));
  for (const g of Object.values((os?.audioSegments ?? {}) as Record<string, any>)) for (const r of Array.isArray(g?.requestIds) ? g.requestIds : []) if (r) ids.add(String(r));
  return ids;
}

/**
 * ¿El intento `attempt` del item es el reenvío por un resultado pagado perdido? Desde la reapertura (afterAttempt) hasta
 * que un intento REGISTRA su primer cargo marcado (consumedAttempt): así se marca el intento que de verdad reenvía aunque
 * N+1 no haya llegado al proveedor, y nunca los posteriores.
 */
export function isLostResultResendAttempt(os: Record<string, any> | null | undefined, attempt: number): boolean {
  const m = os?.[LOST_RESULT_RESEND_KEY];
  if (!m || typeof m !== 'object') return false;
  const after = Number(m.afterAttempt);
  if (!Number.isFinite(after) || attempt <= after) return false;
  const consumed = Number(m.consumedAttempt);
  return !Number.isFinite(consumed) || consumed === attempt;
}

/** Contador en proceso de los cargos del guion LLM ya marcados por (parte, intento) (solo `lostLlm` de ellos). */
const llmMarked = new Map<string, number>();

/**
 * Cargo de un reenvío por resultado perdido: queda registrado con la marca (nunca oculto). Solo lo que se perdió:
 * TTS → los trozos/segmentos de `lostChunks` (si la marca los lista); guion LLM → los primeros `lostLlm` cargos.
 */
export function markLostResultResendCharge<T extends { provider?: string; metadata?: Record<string, unknown> | null; itemRunId?: string }>(charge: T, os: Record<string, any> | null | undefined, attempt: number): T {
  if (!isLostResultResendAttempt(os, attempt)) return charge;
  const m = os![LOST_RESULT_RESEND_KEY] as Record<string, any>;
  if (charge.provider === 'anthropic') {
    const cap = Number(m.lostLlm ?? 0);
    const key = `${String(charge.itemRunId ?? '')}:${attempt}`;
    const used = llmMarked.get(key) ?? 0;
    if (!(cap > used)) return charge;
    llmMarked.set(key, used + 1);
    if (llmMarked.size > 2000) llmMarked.clear();
  } else if (Array.isArray(m.lostChunks)) {
    const chunk = Number((charge.metadata ?? {} as any).chunk);
    if (!m.lostChunks.map(Number).includes(chunk)) return charge;
  }
  return { ...charge, metadata: { ...(charge.metadata || {}), possibleDuplicate: true, lostResultResend: true, possibleDuplicateCause: 'lost_result' } };
}

/** Parche que consume la marca (el primer cargo marcado del intento la fija a ese intento). null = nada que escribir. */
export function lostResultConsumeMark(os: Record<string, any> | null | undefined, attempt: number, charge: { metadata?: Record<string, unknown> | null } | null): Record<string, any> | null {
  const m = os?.[LOST_RESULT_RESEND_KEY];
  if (!m || typeof m !== 'object' || !charge || !(charge.metadata as any)?.lostResultResend) return null;
  if (Number(m.consumedAttempt) === attempt) return null;
  return { [LOST_RESULT_RESEND_KEY]: { ...m, consumedAttempt: attempt, consumedAt: new Date().toISOString() } };
}
