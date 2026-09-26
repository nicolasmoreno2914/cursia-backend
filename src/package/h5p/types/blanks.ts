// Cursia V2.1 / R7-core — H5P.Blanks (completar frases, §J.2).
// Cada pregunta es una frase en texto plano con huecos `*respuesta/alternativa*`.
import { applyH5pL10n } from '../l10n';
import {
  H5pBuiltContent,
  Issues,
  checkArray,
  checkItemKey,
  checkKeys,
  checkPlainText,
  htmlP,
  isPlainObject,
  titleRule,
} from './common';
import { parseBlankMarkup } from './markup';

export interface BlanksInput {
  itemKey: string;
  title: string;
  /** Instrucción de la tarea (texto plano). */
  text: string;
  /** Frases con huecos `*respuesta/alternativa*` (cada una con ≥ 1 hueco; ≥ 2 en total). */
  questions: string[];
}

export const BLANKS_LIMITS = Object.freeze({ minQuestions: 1, maxQuestions: 20, minTotalBlanks: 2, maxTotalBlanks: 30 });

export function validateBlanksInput(input: unknown): asserts input is BlanksInput {
  const issues = new Issues();
  if (!isPlainObject(input)) {
    issues.add('$', 'debe ser un objeto');
    issues.throwIfAny('Blanks');
    return;
  }
  checkKeys(issues, '$', input, ['itemKey', 'title', 'text', 'questions']);
  checkItemKey(issues, input.itemKey);
  titleRule(issues, input.title);
  checkPlainText(issues, 'text', input.text, { max: 400 });
  const L = BLANKS_LIMITS;
  if (checkArray(issues, 'questions', input.questions, L.minQuestions, L.maxQuestions)) {
    let total = 0;
    (input.questions as unknown[]).forEach((q, i) => {
      const p = `questions[${i}]`;
      if (!checkPlainText(issues, p, q, { max: 500 })) return;
      const { blanks } = parseBlankMarkup(issues, p, q as string, 'blanks');
      if (blanks.length < 1) issues.add(p, 'cada frase necesita al menos 1 hueco');
      total += blanks.length;
    });
    if (total < L.minTotalBlanks) issues.add('questions', `se requieren al menos ${L.minTotalBlanks} huecos en total (hay ${total})`);
    if (total > L.maxTotalBlanks) issues.add('questions', `máximo ${L.maxTotalBlanks} huecos en total`);
  }
  issues.throwIfAny('Blanks');
}

export function buildBlanks(input: BlanksInput): H5pBuiltContent {
  validateBlanksInput(input);
  const total = input.questions.reduce((n, q) => n + parseBlankMarkup(new Issues(), 'q', q, 'blanks').blanks.length, 0);
  const content = applyH5pL10n('H5P.Blanks', {
    media: { disableImageZooming: false },
    text: htmlP(input.text),
    questions: input.questions.map((q) => htmlP(q)),
    overallFeedback: [{ from: 0, to: 100 }],
    behaviour: {
      enableRetry: true,
      enableSolutionsButton: true,
      enableCheckButton: true,
      autoCheck: false,
      caseSensitive: false,
      showSolutionsRequiresInput: true,
      separateLines: false,
      confirmCheckDialog: false,
      confirmRetryDialog: false,
      acceptSpellingErrors: false,
    },
  });
  return { mainLibrary: 'H5P.Blanks', title: input.title.trim(), content, subContentIds: [], maxScore: total };
}
