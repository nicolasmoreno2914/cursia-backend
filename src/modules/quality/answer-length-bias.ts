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
