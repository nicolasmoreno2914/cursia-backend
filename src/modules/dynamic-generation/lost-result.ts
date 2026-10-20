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
  return ids;
}

/**
 * ¿El intento `attempt` del item es un reenvío por un resultado pagado perdido? (el worker marca sus cargos nuevos como
 * posible duplicado: el cobro nuevo queda registrado, no oculto).
 */
export function isLostResultResendAttempt(os: Record<string, any> | null | undefined, attempt: number): boolean {
  const m = os?.[LOST_RESULT_RESEND_KEY];
  if (!m || typeof m !== 'object') return false;
  const after = Number(m.afterAttempt);
  // Solo el intento del reenvío (el siguiente a la reapertura): los posteriores ya no repiten el resultado perdido.
  return Number.isFinite(after) && attempt === after + 1;
}

/** Cargo de un reenvío por resultado perdido: queda registrado con la marca (nunca oculto). */
export function markLostResultResendCharge<T extends { metadata?: Record<string, unknown> | null }>(charge: T, os: Record<string, any> | null | undefined, attempt: number): T {
  if (!isLostResultResendAttempt(os, attempt)) return charge;
  return { ...charge, metadata: { ...(charge.metadata || {}), possibleDuplicate: true, lostResultResend: true, possibleDuplicateCause: 'lost_result' } };
}
