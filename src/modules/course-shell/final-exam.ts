/**
 * R11a — validación del GIFT del examen final (`final_exam`, artifact
 * `dynamic_exam_gift`). Reusa EXACTAMENTE el parser que empaqueta los
 * exámenes de módulo (`parseGIFT` de mbz-common, "idéntico a
 * 08-downloads.js"), así el conteo de preguntas es el mismo que verá Moodle.
 *
 * Falla fuerte:
 *  - GIFT vacío o sin preguntas parseables;
 *  - un bloque con llaves `{…}` que el parser descarta (pregunta perdida en
 *    silencio: el conteo mentiría);
 *  - fuera de rango [min, max] (max = 40, el tope del split del ejecutor).
 */
import { parseGIFT } from '../../package/mbz-common';
import type { ShellValidationError } from './activity-type';

export const FINAL_EXAM_QUESTION_RANGE = Object.freeze({ min: 5, max: 40 });

export interface GiftValidationResult {
  ok: boolean;
  questionCount: number;
  errors: ShellValidationError[];
}

/**
 * Cantidad de bloques "pregunta" que el parser intenta leer: mismo recorrido
 * de líneas que parseGIFT (comentarios y $CATEGORY se saltan; las líneas de
 * continuación se juntan hasta una línea vacía o que empieza con ':'), contando
 * los que traen llaves.
 */
export function giftCandidateBlocks(gift: string): number {
  const lines = String(gift ?? '').split('\n');
  let n = 0;
  let i = 0;
  while (i < lines.length) {
    let line = lines[i].trim();
    if (!line || line.charAt(0) === '/' || line.indexOf('$CATEGORY:') === 0) {
      i++;
      continue;
    }
    const nameMatch = line.match(/^::([^:]+)::/);
    if (nameMatch) line = line.substring(nameMatch[0].length).trim();
    let full = line;
    while (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].trim().charAt(0) !== ':') {
      i++;
      full += '\n' + lines[i].trim();
    }
    if (full.indexOf('{') >= 0 && full.lastIndexOf('}') >= 0) n++;
    i++;
  }
  return n;
}

export function validateExamGift(
  gift: unknown,
  range: { min: number; max: number } = FINAL_EXAM_QUESTION_RANGE,
): GiftValidationResult {
  const errors: ShellValidationError[] = [];
  if (typeof gift !== 'string' || !gift.trim()) {
    return { ok: false, questionCount: 0, errors: [{ path: '$', code: 'GIFT_EMPTY', message: 'GIFT vacío' }] };
  }
  const questions = parseGIFT(gift);
  const blocks = giftCandidateBlocks(gift);
  if (questions.length === 0) {
    errors.push({ path: '$', code: 'GIFT_NO_QUESTIONS', message: 'el GIFT no produjo ninguna pregunta parseable' });
  }
  if (questions.length < blocks) {
    errors.push({
      path: '$',
      code: 'GIFT_UNPARSEABLE_BLOCK',
      message: `${blocks - questions.length} bloque(s) con llaves no se pudieron leer como pregunta (${questions.length}/${blocks})`,
    });
  }
  if (questions.length > 0 && (questions.length < range.min || questions.length > range.max)) {
    errors.push({
      path: '$',
      code: 'GIFT_QUESTION_COUNT',
      message: `${questions.length} preguntas, se esperaban ${range.min}–${range.max}`,
    });
  }
  questions.forEach((q, i) => {
    if (!String(q.text ?? '').trim()) errors.push({ path: `$[${i}]`, code: 'GIFT_EMPTY_QUESTION', message: 'pregunta sin enunciado' });
  });
  return { ok: errors.length === 0, questionCount: questions.length, errors };
}
