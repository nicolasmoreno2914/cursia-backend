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
}

export const DRAG_TEXT_LIMITS = Object.freeze({ minBlanks: 2, maxBlanks: 20, maxTextLength: 3000 });

export function validateDragTextInput(input: unknown): asserts input is DragTextInput {
  const issues = new Issues();
  if (!isPlainObject(input)) {
    issues.add('$', 'debe ser un objeto');
    issues.throwIfAny('DragText');
    return;
  }
  checkKeys(issues, '$', input, ['itemKey', 'title', 'taskDescription', 'text']);
  checkItemKey(issues, input.itemKey);
  titleRule(issues, input.title);
  checkPlainText(issues, 'taskDescription', input.taskDescription, { max: 400 });
  if (checkPlainText(issues, 'text', input.text, { max: DRAG_TEXT_LIMITS.maxTextLength, multiline: true })) {
    const { blanks } = parseBlankMarkup(issues, 'text', input.text as string, 'dragtext');
    if (blanks.length < DRAG_TEXT_LIMITS.minBlanks) issues.add('text', `se requieren al menos ${DRAG_TEXT_LIMITS.minBlanks} huecos (hay ${blanks.length})`);
    if (blanks.length > DRAG_TEXT_LIMITS.maxBlanks) issues.add('text', `máximo ${DRAG_TEXT_LIMITS.maxBlanks} huecos`);
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
    overallFeedback: [{ from: 0, to: 100 }],
    behaviour: { enableRetry: true, enableSolutionsButton: true, enableCheckButton: true, instantFeedback: false },
  });
  return { mainLibrary: 'H5P.DragText', title: input.title.trim(), content, subContentIds: [], maxScore: blanks };
}
