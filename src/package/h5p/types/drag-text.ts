// Cursia V2.1 / R7-core — H5P.DragText (completar u ordenar conceptos, §J.2).
import { applyH5pL10n } from '../l10n';
import {
  H5pBuiltContent,
  Issues,
  checkItemKey,
  checkKeys,
  checkPlainText,
  escapeText,
  htmlP,
  isPlainObject,
  titleRule,
} from './common';
import { parseBlankMarkup } from './markup';

export interface DragTextInput {
  itemKey: string;
  title: string;
  taskDescription: string;
  /** Texto plano con huecos `*respuesta*` (mínimo 2). */
  text: string;
  /**
   * #583 (I2): palabras de relleno (distractores) del banco de palabras — opcional (payloads anteriores no
   * lo traen). Cada una es una palabra o expresión corta que NO es la respuesta de ningún hueco: sin ellas,
   * el último hueco se resuelve por descarte.
   */
  distractors?: string[];
}

export const DRAG_TEXT_LIMITS = Object.freeze({ minBlanks: 2, maxBlanks: 20, maxTextLength: 3000, maxDistractors: 4, distractorMax: 80 });

/** Igualdad «para el estudiante» de dos palabras del banco: sin tildes, mayúsculas ni espacios extra. */
export function dragTextWordKey(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function checkDistractors(issues: Issues, v: unknown, blanks: readonly string[]): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length < 1 || v.length > DRAG_TEXT_LIMITS.maxDistractors) {
    issues.add('distractors', `debe ser una lista de 1 a ${DRAG_TEXT_LIMITS.maxDistractors} palabras`);
    return;
  }
  const answers = new Set(blanks.map(dragTextWordKey));
  const seen = new Set<string>();
  v.forEach((d, i) => {
    const p = `distractors[${i}]`;
    if (!checkPlainText(issues, p, d, { max: DRAG_TEXT_LIMITS.distractorMax })) return;
    const t = (d as string).trim();
    if (/[*:\\&<>]/.test(t)) issues.add(p, 'no puede contener * : \\ & < >');
    const k = dragTextWordKey(t);
    if (answers.has(k)) issues.add(p, `"${t}" es la respuesta de un hueco: un distractor nunca es una respuesta correcta`);
    if (seen.has(k)) issues.add(p, `"${t}" repetido`);
    seen.add(k);
  });
}

export function validateDragTextInput(input: unknown): asserts input is DragTextInput {
  const issues = new Issues();
  if (!isPlainObject(input)) {
    issues.add('$', 'debe ser un objeto');
    issues.throwIfAny('DragText');
    return;
  }
  checkKeys(issues, '$', input, ['itemKey', 'title', 'taskDescription', 'text', 'distractors']);
  checkItemKey(issues, input.itemKey);
  titleRule(issues, input.title);
  checkPlainText(issues, 'taskDescription', input.taskDescription, { max: 400 });
  if (checkPlainText(issues, 'text', input.text, { max: DRAG_TEXT_LIMITS.maxTextLength, multiline: true })) {
    const { blanks } = parseBlankMarkup(issues, 'text', input.text as string, 'dragtext');
    if (blanks.length < DRAG_TEXT_LIMITS.minBlanks) issues.add('text', `se requieren al menos ${DRAG_TEXT_LIMITS.minBlanks} huecos (hay ${blanks.length})`);
    if (blanks.length > DRAG_TEXT_LIMITS.maxBlanks) issues.add('text', `máximo ${DRAG_TEXT_LIMITS.maxBlanks} huecos`);
    checkDistractors(issues, input.distractors, blanks.map((b) => b.answer));
  } else if (input.distractors !== undefined) {
    checkDistractors(issues, input.distractors, []);
  }
  issues.throwIfAny('DragText');
}

export function buildDragText(input: DragTextInput): H5pBuiltContent {
  validateDragTextInput(input);
  const blanks = parseBlankMarkup(new Issues(), 'text', input.text, 'dragtext').blanks.length;
  const content = applyH5pL10n('H5P.DragText', {
    media: { disableImageZooming: false },
    taskDescription: htmlP(input.taskDescription),
    // textarea (texto plano): H5P parsea los *huecos*; & < > se escapan igual que su validador.
    textField: escapeText(input.text),
    // #583 (I2): H5P.DragText 1.10 «distractors» (mismo esquema de asteriscos que el texto); ausente = sin relleno.
    ...(input.distractors && input.distractors.length ? { distractors: escapeText(input.distractors.map((d) => `*${d.trim()}*`).join(' ')) } : {}),
    overallFeedback: [{ from: 0, to: 100 }],
    behaviour: { enableRetry: true, enableSolutionsButton: true, enableCheckButton: true, instantFeedback: false },
  });
  return { mainLibrary: 'H5P.DragText', title: input.title.trim(), content, subContentIds: [], maxScore: blanks };
}
