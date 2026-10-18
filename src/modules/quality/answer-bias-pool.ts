/**
 * T6 (r57) — acumulado del CURSO para la prueba de sesgo de patrón de respuesta del ejecutor (#542 / T1 §7).
 *
 * El ejecutor prueba cada item (preguntas del video, práctica H5P, caso ramificado) contra las respuestas YA aceptadas
 * de los demás items del mismo run. Ese acumulado vivía en la memoria / el almacenamiento del proceso que generaba:
 * con la generación en procesos distintos (workers del servidor, otra pestaña) cada item se probaba casi solo y el
 * patrón del curso se escapaba (correcta = la más larga en 29 de 55 MC de video).
 *
 * Ahora cada item aceptado deja sus señales en `output_summary.answerBias.signals` (`{k, ranks:[{m,r}], tf:[bool]}`)
 * y el claim de `video_interactions` / `activity` trae `claimPayload.answerBiasPool` con las de los items COMPLETADOS
 * del run (generación vigente). El ejecutor siembra su acumulado con ellas: la prueba y el reintento dirigido existentes
 * (blandos, un reintento) ven el curso entero. Puro: sin DB (el scheduler pasa las filas).
 */

/** Tipos de item cuyas señales entran al acumulado (los que corren `dynAnswerBiasTest`). */
export const ANSWER_BIAS_POOL_ITEM_TYPES = ['video_interactions', 'activity'] as const;
export const ANSWER_BIAS_POOL_VERSION = 1;
/** Topes defensivos (un curso grande tiene ≈ 60 items con ≈ 8 señales). */
export const ANSWER_BIAS_POOL_MAX_ITEMS = 300;
export const ANSWER_BIAS_POOL_MAX_SIGNALS = 60;
const KINDS = new Set(['video_interactions', 'questionset', 'branchingscenario']);

export interface AnswerBiasSignals {
  k: string;
  ranks: Array<{ m: number; r: number }>;
  tf: boolean[];
}
export interface AnswerBiasPool {
  v: number;
  items: Record<string, AnswerBiasSignals>;
}

/** Señales válidas de un `output_summary` (o null si faltan o están mal formadas: nunca se adivinan). */
export function answerBiasSignalsOf(summary: unknown): AnswerBiasSignals | null {
  const s = (summary as { answerBias?: { signals?: unknown } } | null)?.answerBias?.signals as Partial<AnswerBiasSignals> | undefined;
  if (!s || typeof s !== 'object' || typeof s.k !== 'string' || !KINDS.has(s.k) || !Array.isArray(s.ranks) || !Array.isArray(s.tf)) return null;
  if (s.ranks.length > ANSWER_BIAS_POOL_MAX_SIGNALS || s.tf.length > ANSWER_BIAS_POOL_MAX_SIGNALS) return null;
  const ranks: Array<{ m: number; r: number }> = [];
  for (const x of s.ranks) {
    const m = Number((x as { m?: unknown })?.m);
    const r = Number((x as { r?: unknown })?.r);
    // r = cuántas opciones son más cortas + ½ por empate → múltiplo de ½ en [0, m − 1].
    if (!Number.isInteger(m) || m < 2 || m > 12 || !Number.isFinite(r) || r < 0 || r > m - 1 || !Number.isInteger(r * 2)) return null;
    ranks.push({ m, r });
  }
  if (!s.tf.every((v) => typeof v === 'boolean')) return null;
  return { k: s.k, ranks, tf: [...s.tf] };
}

/**
 * Acumulado para el claim de `excludeItemKey`: señales de los items completados del run (orden estable por itemKey),
 * sin el propio item. null si no hay ninguna (el claim queda como antes).
 */
export function answerBiasPoolFrom(rows: Array<{ itemKey: string; summary: unknown }>, excludeItemKey: string): AnswerBiasPool | null {
  const items: Record<string, AnswerBiasSignals> = {};
  const sorted = [...rows].filter((r) => r && typeof r.itemKey === 'string' && r.itemKey !== excludeItemKey).sort((a, b) => (a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0));
  for (const r of sorted) {
    if (Object.keys(items).length >= ANSWER_BIAS_POOL_MAX_ITEMS) break;
    const s = answerBiasSignalsOf(r.summary);
    if (s && (s.ranks.length || s.tf.length)) items[r.itemKey] = s;
  }
  return Object.keys(items).length ? { v: ANSWER_BIAS_POOL_VERSION, items } : null;
}
