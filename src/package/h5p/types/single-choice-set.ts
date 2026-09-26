// Cursia V2.1 / R7-core — H5P.SingleChoiceSet (práctica rápida, §J.2).
// En SingleChoiceSet la PRIMERA respuesta de cada pregunta es la correcta (la
// librería baraja al mostrar). El builder reordena a partir de `correct`.
import { applyH5pL10n } from '../l10n';
import {
  H5pBuiltContent,
  Issues,
  checkArray,
  checkInt,
  checkItemKey,
  checkKeys,
  checkPlainText,
  htmlP,
  isPlainObject,
  titleRule,
} from './common';

export interface SingleChoiceSetQuestionInput {
  question: string;
  answers: Array<{ text: string; correct: boolean }>;
}

export interface SingleChoiceSetInput {
  itemKey: string;
  title: string;
  questions: SingleChoiceSetQuestionInput[];
  passPercentage: number;
}

export const SINGLE_CHOICE_SET_LIMITS = Object.freeze({ minQuestions: 2, maxQuestions: 20, minAnswers: 2, maxAnswers: 4 });

export function validateSingleChoiceSetInput(input: unknown): asserts input is SingleChoiceSetInput {
  const issues = new Issues();
  if (!isPlainObject(input)) {
    issues.add('$', 'debe ser un objeto');
    issues.throwIfAny('SingleChoiceSet');
    return;
  }
  checkKeys(issues, '$', input, ['itemKey', 'title', 'questions', 'passPercentage']);
  checkItemKey(issues, input.itemKey);
  titleRule(issues, input.title);
  checkInt(issues, 'passPercentage', input.passPercentage, 0, 100);
  const L = SINGLE_CHOICE_SET_LIMITS;
  if (checkArray(issues, 'questions', input.questions, L.minQuestions, L.maxQuestions)) {
    (input.questions as unknown[]).forEach((q, i) => {
      const p = `questions[${i}]`;
      if (!isPlainObject(q)) {
        issues.add(p, 'debe ser un objeto');
        return;
      }
      checkKeys(issues, p, q, ['question', 'answers']);
      checkPlainText(issues, `${p}.question`, q.question, { max: 400 });
      if (checkArray(issues, `${p}.answers`, q.answers, L.minAnswers, L.maxAnswers)) {
        let correct = 0;
        const seen = new Set<string>();
        (q.answers as unknown[]).forEach((a, j) => {
          const ap = `${p}.answers[${j}]`;
          if (!isPlainObject(a)) {
            issues.add(ap, 'debe ser un objeto');
            return;
          }
          checkKeys(issues, ap, a, ['text', 'correct']);
          if (checkPlainText(issues, `${ap}.text`, a.text, { max: 200 })) {
            const norm = (a.text as string).trim().toLowerCase();
            if (seen.has(norm)) issues.add(`${ap}.text`, 'respuesta duplicada');
            seen.add(norm);
          }
          if (typeof a.correct !== 'boolean') issues.add(`${ap}.correct`, 'debe ser booleano');
          else if (a.correct) correct++;
        });
        if (correct !== 1) issues.add(`${p}.answers`, `debe haber exactamente 1 correcta (hay ${correct})`);
      }
    });
  }
  issues.throwIfAny('SingleChoiceSet');
}

export function buildSingleChoiceSet(input: SingleChoiceSetInput): H5pBuiltContent {
  validateSingleChoiceSetInput(input);
  const choices = input.questions.map((q) => {
    const correct = q.answers.filter((a) => a.correct);
    const wrong = q.answers.filter((a) => !a.correct);
    return { question: htmlP(q.question), answers: [...correct, ...wrong].map((a) => htmlP(a.text)) };
  });
  const content = applyH5pL10n('H5P.SingleChoiceSet', {
    choices,
    overallFeedback: [{ from: 0, to: 100 }],
    behaviour: {
      autoContinue: true,
      timeoutCorrect: 2000,
      timeoutWrong: 3000,
      soundEffectsEnabled: false,
      enableRetry: true,
      enableSolutionsButton: true,
      passPercentage: input.passPercentage,
    },
  });
  return {
    mainLibrary: 'H5P.SingleChoiceSet',
    title: input.title.trim(),
    content,
    subContentIds: [],
    maxScore: choices.length,
  };
}
