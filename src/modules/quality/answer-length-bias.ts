/**
 * T1 (r57) — sesgo de longitud de las preguntas de opción múltiple de los VIDEOS INTERACTIVOS, medido sobre el CURSO.
 *
 * Los bancos de examen ya tienen la regla de conjunto «la correcta es la más larga en ≤ 30 % de las MC»
 * (EXAM_BANK_LENGTH_BIAS, exam-bank.ts). Los videos solo tenían una prueba estadística por item con un acumulado del
 * run que no siempre ve las demás partes (p. ej. si las generan procesos distintos): en un curso real la correcta era
 * la más larga en 29 de 55 MC (53 %). Esta medición, determinística y sin IA, aplica el MISMO umbral al conjunto de
 * videos del paquete y lo informa como aviso de calidad (el texto ya está generado: el empaque no lo reescribe).
 */

/** Mismo umbral que la regla de conjunto del banco de examen (EXAM_BANK_LENGTH_BIAS: > 30 %). */
export const VIDEO_MC_LONGEST_MAX_SHARE = 0.3;
/** Con menos MC el porcentaje no dice nada (el azar domina). */
export const VIDEO_MC_LENGTH_BIAS_MIN_QUESTIONS = 10;

const len = (s: unknown): number => String(s ?? '').replace(/\s+/g, ' ').trim().length;

/**
 * Con 3 opciones el azar ya da ≈ 33 % de «correcta la más larga»: el 30 % del banco (4 opciones, 25 %) solo no basta.
 * Se exige ADEMÁS que el exceso sobre el azar sea significativo (aproximación normal de la suma de Bernoulli con
 * p_i = 1/m_i, cola superior, z > 1,96 ≈ α 0,025, el mismo α que la prueba por item del ejecutor).
 */
export const VIDEO_MC_LENGTH_BIAS_MIN_Z = 1.96;

export interface VideoMcLengthBias {
  mc: number;
  correctLongest: number;
  share: number;
  /** Esperado por azar (Σ 1/m) y z del exceso. */
  expected: number;
  z: number;
  biased: boolean;
}

/** Cuenta las MC (todas las del curso) cuya correcta es ESTRICTAMENTE más larga que todo distractor. */
export function videoMcLengthBias(docs: Iterable<unknown>): VideoMcLengthBias {
  let mc = 0;
  let longest = 0;
  let expected = 0;
  let variance = 0;
  for (const d of docs) {
    const cps = (d as { checkpoints?: unknown })?.checkpoints;
    if (!Array.isArray(cps)) continue;
    for (const c of cps as Array<{ kind?: unknown; answers?: Array<{ text?: unknown; correct?: unknown }> }>) {
      if (!c || c.kind !== 'multichoice' || !Array.isArray(c.answers)) continue;
      const right = c.answers.filter((a) => a && a.correct === true);
      const wrong = c.answers.filter((a) => a && a.correct === false);
      if (right.length !== 1 || wrong.length < 1) continue;
      mc++;
      const p = 1 / (wrong.length + 1);
      expected += p;
      variance += p * (1 - p);
      if (len(right[0].text) > Math.max(...wrong.map((a) => len(a.text)))) longest++;
    }
  }
  const share = mc ? longest / mc : 0;
  const z = variance > 0 ? (longest - expected) / Math.sqrt(variance) : 0;
  return {
    mc, correctLongest: longest, share, expected: Math.round(expected * 100) / 100, z: Math.round(z * 100) / 100,
    biased: mc >= VIDEO_MC_LENGTH_BIAS_MIN_QUESTIONS && share > VIDEO_MC_LONGEST_MAX_SHARE && z > VIDEO_MC_LENGTH_BIAS_MIN_Z,
  };
}

/** Aviso de calidad del paquete: `video_mc_length_bias:<correcta más larga>/<MC>`. */
export function videoMcLengthBiasWarnings(docs: Iterable<unknown>): string[] {
  const b = videoMcLengthBias(docs);
  return b.biased ? [`video_mc_length_bias:${b.correctLongest}/${b.mc}`] : [];
}

// ─── r58 (I4-1): re-chequeo del SERVIDOR al completar un item de video_interactions ──────────────────────────────

/**
 * La prueba de conjunto del curso corría solo en la memoria del ejecutor (sembrada por el claim). Un ejecutor viejo, otro
 * proceso o un resumen forjado podían saltársela. Al completar `video_interactions` el servidor la recalcula con:
 *  - las señales del ITEM calculadas por el servidor desde el documento validado (nunca las que declara el ejecutor);
 *  - las señales PERSISTIDAS de los demás items de video completados del run (output_summary.answerBias.signals, que el
 *    propio servidor reescribe al completar con las suyas).
 * Misma regla que el ejecutor y que el aviso del paquete: > 30 % correcta-la-más-larga y z > 1,96 sobre Σ 1/m, ≥ 10 MC, y
 * ESTE item empuja (sus MC con la correcta más larga > max(30 %, su azar)). Mismo camino de reparación: UN rechazo
 * reintentable con la lista de preguntas a corregir; si el reintento sigue sesgado, se acepta «blando» y queda registrado
 * (el aviso `video_mc_length_bias` del paquete y el informe de calidad siguen como red final).
 */
export const VIDEO_MC_COURSE_BIAS_CODE = 'VIDEO_MC_COURSE_LENGTH_BIAS';
export const VIDEO_MC_COURSE_BIAS_MAX_REJECTIONS = 1;

export interface VideoMcRank { m: number; r: number; longest: boolean; path: string }

/** Señales de un documento de interacciones (espejo de `dynAnswerBiasSignals('video_interactions', …)` del ejecutor). */
export function videoMcSignals(doc: unknown): { ranks: VideoMcRank[]; tf: boolean[] } {
  const out = { ranks: [] as VideoMcRank[], tf: [] as boolean[] };
  const cps = (doc as { checkpoints?: unknown })?.checkpoints;
  if (!Array.isArray(cps)) return out;
  cps.forEach((it: any, i: number) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return;
    if (it.kind === 'truefalse' && typeof it.correct === 'boolean') { out.tf.push(it.correct); return; }
    if (!Array.isArray(it.answers) || (it.kind && it.kind !== 'multichoice')) return;
    const right = it.answers.filter((a: any) => a && a.correct === true);
    const wrong = it.answers.filter((a: any) => a && a.correct === false);
    if (right.length !== 1 || !wrong.length) return;
    const c = len(right[0].text);
    const wl: number[] = wrong.map((a: any) => len(a.text));
    let r = 0;
    for (const o of wl) r += o < c ? 1 : o === c ? 0.5 : 0;
    out.ranks.push({ m: wl.length + 1, r, longest: c > Math.max(...wl), path: `checkpoints[${i}]` });
  });
  return out;
}

export interface VideoMcCourseRecheck {
  action: 'accept' | 'reject' | 'soft_accept';
  /** Señales compactas del servidor para `output_summary.answerBias.signals` (formato del acumulado). */
  signals: { k: 'video_interactions'; ranks: Array<{ m: number; r: number }>; tf: boolean[] };
  course: { mc: number; correctLongest: number; expected: number; z: number; biased: boolean };
  pushes: boolean;
  fixPaths: string[];
  message: string | null;
}

/** Decisión pura (pool = señales de los OTROS items del run; priorRejections = rechazos de este item por esta regla). */
export function videoMcCourseRecheck(
  doc: unknown,
  pool: { items: Record<string, { k: string; ranks: Array<{ m: number; r: number }> }> } | null | undefined,
  priorRejections: number,
): VideoMcCourseRecheck {
  const own = videoMcSignals(doc);
  const ranks = own.ranks.map((x) => ({ m: x.m, r: x.r }));
  let all = [...ranks];
  for (const s of Object.values(pool?.items ?? {})) if (s && s.k === 'video_interactions' && Array.isArray(s.ranks)) all = all.concat(s.ranks);
  const longest = all.filter((x) => x.r === x.m - 1).length;
  let expected = 0;
  let variance = 0;
  for (const x of all) { const p = 1 / x.m; expected += p; variance += p * (1 - p); }
  const z = variance > 0 ? (longest - expected) / Math.sqrt(variance) : 0;
  const biased = all.length >= VIDEO_MC_LENGTH_BIAS_MIN_QUESTIONS && longest > VIDEO_MC_LONGEST_MAX_SHARE * all.length && z > VIDEO_MC_LENGTH_BIAS_MIN_Z;
  const ownLongest = own.ranks.filter((x) => x.longest).length;
  const ownChance = own.ranks.reduce((a, x) => a + 1 / x.m, 0);
  const pushes = own.ranks.length > 0 && ownLongest > Math.max(VIDEO_MC_LONGEST_MAX_SHARE * own.ranks.length, ownChance);
  const fixPaths = own.ranks.filter((x) => x.longest).map((x) => x.path);
  const course = { mc: all.length, correctLongest: longest, expected: Math.round(expected * 100) / 100, z: Math.round(z * 100) / 100, biased };
  const signals = { k: 'video_interactions' as const, ranks, tf: own.tf };
  if (!biased || !pushes) return { action: 'accept', signals, course, pushes, fixPaths, message: null };
  const message = `en los videos de este curso la respuesta correcta es la más larga en ${longest} de ${all.length} preguntas (máximo 30 %): en ${fixPaths.join(', ')} haz que una opción incorrecta sea igual o más larga y detallada que la correcta.`;
  return { action: priorRejections >= VIDEO_MC_COURSE_BIAS_MAX_REJECTIONS ? 'soft_accept' : 'reject', signals, course, pushes, fixPaths, message };
}
