// Cursia V2.1 / R7-core — H5P.QuestionSet (MultiChoice + TrueFalse).
// Actividad por defecto del capítulo ("Comprueba tu comprensión", §J.2).
import { applyH5pL10n } from '../l10n';
import {
  ChoiceQuestionInput,
  H5pBuiltContent,
  Issues,
  buildChoiceSubContent,
  checkArray,
  checkChoiceQuestion,
  checkInt,
  checkItemKey,
  checkKeys,
  escapeText,
  isPlainObject,
  shortTitle,
  titleRule,
} from './common';

export interface QuestionSetInput {
  itemKey: string;
  title: string;
  questions: ChoiceQuestionInput[];
  passPercentage: number;
}

export const QUESTION_SET_LIMITS = Object.freeze({ minQuestions: 2, maxQuestions: 20, minAnswers: 2, maxAnswers: 5 });

export function validateQuestionSetInput(input: unknown): asserts input is QuestionSetInput {
  const issues = new Issues();
  if (!isPlainObject(input)) {
    issues.add('$', 'debe ser un objeto');
    issues.throwIfAny('QuestionSet');
    return;
  }
  checkKeys(issues, '$', input, ['itemKey', 'title', 'questions', 'passPercentage']);
  checkItemKey(issues, input.itemKey);
  titleRule(issues, input.title);
  checkInt(issues, 'passPercentage', input.passPercentage, 0, 100);
  if (checkArray(issues, 'questions', input.questions, QUESTION_SET_LIMITS.minQuestions, QUESTION_SET_LIMITS.maxQuestions)) {
    (input.questions as unknown[]).forEach((q, i) =>
      checkChoiceQuestion(issues, `questions[${i}]`, q, {
        minAnswers: QUESTION_SET_LIMITS.minAnswers,
        maxAnswers: QUESTION_SET_LIMITS.maxAnswers,
        exactlyOneCorrect: false,
      }),
    );
  }
  issues.throwIfAny('QuestionSet');
}

export function buildQuestionSet(input: QuestionSetInput): H5pBuiltContent {
  validateQuestionSetInput(input);
  const n = input.questions.length;
  const questions = input.questions.map((q, i) =>
    buildChoiceSubContent(q, input.itemKey, i, `Pregunta ${i + 1} de ${n}: ${shortTitle(q.question)}`),
  );
  const content = applyH5pL10n('H5P.QuestionSet', {
    introPage: { showIntroPage: false, title: escapeText(input.title), introduction: '' },
    progressType: 'dots',
    passPercentage: input.passPercentage,
    questions,
    disableBackwardsNavigation: false,
    randomQuestions: false,
    endGame: {
      showResultPage: true,
      showSolutionButton: true,
      showRetryButton: true,
      overallFeedback: [{ from: 0, to: 100 }],
      showAnimations: false,
      skippable: false,
    },
    override: { checkButton: true },
  });
  return {
    mainLibrary: 'H5P.QuestionSet',
    title: input.title.trim(),
    content,
    subContentIds: questions.map((q) => q.subContentId),
    maxScore: n,
  };
}
