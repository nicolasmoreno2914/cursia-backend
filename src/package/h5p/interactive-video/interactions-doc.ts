// Cursia V2.1 / R8 — ítem `video_interactions:<ch>` (salida del LLM, texto plano).
//
// Forma (schemaVersion 1):
//   { schemaVersion: 1, videoItemKey, durationSec,
//     checkpoints: [{ index, kind: 'multichoice'|'truefalse', question,
//                     answers?: [{ text, correct }], correct?: boolean,
//                     feedbackCorrect?, feedbackIncorrect? }] }
//
// - La cantidad y los `index` deben coincidir EXACTAMENTE con
//   planInteractionCheckpoints(durationSec): el LLM no decide cuántas ni cuándo.
// - MultiChoice: 3–4 respuestas, exactamente 1 correcta, sin `correct` suelto.
// - TrueFalse: `correct` booleano, sin `answers`.
// - Sin HTML ni entidades; solo límites de longitud (no se aplican los lints
//   RESOURCE_MENTION ni QUANTITY_CLAIM: el texto habla del propio video).
import {
  ChoiceQuestionInput,
  Issues,
  checkArray,
  checkItemKey,
  checkKeys,
  checkPlainText,
  isPlainObject,
} from '../types/common';
import { VideoCheckpoint, planInteractionCheckpoints, videoPlanDurationSec } from './plan';

export const VIDEO_INTERACTIONS_SCHEMA_VERSION = 1;

export const VIDEO_INTERACTIONS_LIMITS = Object.freeze({
  questionMax: 250,
  answerMax: 120,
  feedbackMax: 250,
  minAnswers: 3,
  maxAnswers: 4,
});

export interface VideoInteractionAnswer {
  text: string;
  correct: boolean;
}

export interface VideoInteractionCheckpoint {
  index: number;
  kind: 'multichoice' | 'truefalse';
  question: string;
  answers?: VideoInteractionAnswer[];
  correct?: boolean;
  feedbackCorrect?: string;
  feedbackIncorrect?: string;
}

export interface VideoInteractionsDoc {
  schemaVersion: 1;
  videoItemKey: string;
  durationSec: number;
  checkpoints: VideoInteractionCheckpoint[];
}

export interface VideoInteractionsExpectations {
  /** Si se da, `doc.videoItemKey` debe ser exactamente este. */
  videoItemKey?: string;
  /** Duración real (artifact de Videogen). Si se da, `doc.durationSec` debe coincidir (en segundos enteros). */
  durationSec?: number;
}

/**
 * Valida el documento y devuelve el plan contra el que se validó.
 * Lanza H5pInputError("H5P_INPUT_INVALID(VideoInteractions): …") con TODOS los errores.
 */
export function validateVideoInteractionsDoc(doc: unknown, expect: VideoInteractionsExpectations = {}): VideoCheckpoint[] {
  const L = VIDEO_INTERACTIONS_LIMITS;
  const issues = new Issues();
  if (!isPlainObject(doc)) {
    issues.add('$', 'debe ser un objeto');
    issues.throwIfAny('VideoInteractions');
  }
  const d = doc as Record<string, unknown>;
  checkKeys(issues, '$', d, ['schemaVersion', 'videoItemKey', 'durationSec', 'checkpoints']);
  if (d.schemaVersion !== VIDEO_INTERACTIONS_SCHEMA_VERSION) {
    issues.add('schemaVersion', `debe ser ${VIDEO_INTERACTIONS_SCHEMA_VERSION}`);
  }
  const keyIssues = new Issues();
  if (!checkItemKey(keyIssues, d.videoItemKey)) {
    keyIssues.list.forEach((m) => issues.add('videoItemKey', m.replace(/^itemKey: /, '')));
  } else if (expect.videoItemKey !== undefined && d.videoItemKey !== expect.videoItemKey) {
    issues.add('videoItemKey', `debe ser "${expect.videoItemKey}" (recibido "${String(d.videoItemKey)}")`);
  }

  let plan: VideoCheckpoint[] | null = null;
  let planDur: number | null = null;
  try {
    planDur = videoPlanDurationSec(d.durationSec as number);
    if (expect.durationSec !== undefined && planDur !== videoPlanDurationSec(expect.durationSec)) {
      issues.add('durationSec', `debe coincidir con la duración real ${videoPlanDurationSec(expect.durationSec)} s (recibido ${planDur})`);
    }
    plan = planInteractionCheckpoints(planDur);
  } catch (err) {
    issues.add('durationSec', (err as Error).message);
  }

  if (plan && checkArray(issues, 'checkpoints', d.checkpoints, plan.length, plan.length)) {
    (d.checkpoints as unknown[]).forEach((c, i) => {
      const p = `checkpoints[${i}]`;
      if (!isPlainObject(c)) {
        issues.add(p, 'debe ser un objeto');
        return;
      }
      if (c.index !== plan![i].index) issues.add(`${p}.index`, `debe ser ${plan![i].index} (recibido ${String(c.index)})`);
      if (c.feedbackCorrect !== undefined) checkPlainText(issues, `${p}.feedbackCorrect`, c.feedbackCorrect, { max: L.feedbackMax });
      if (c.feedbackIncorrect !== undefined) checkPlainText(issues, `${p}.feedbackIncorrect`, c.feedbackIncorrect, { max: L.feedbackMax });
      checkPlainText(issues, `${p}.question`, c.question, { max: L.questionMax });
      if (c.kind === 'multichoice') {
        checkKeys(issues, p, c, ['index', 'kind', 'question', 'answers', 'feedbackCorrect', 'feedbackIncorrect']);
        if (checkArray(issues, `${p}.answers`, c.answers, L.minAnswers, L.maxAnswers)) {
          let correct = 0;
          const seen = new Set<string>();
          (c.answers as unknown[]).forEach((a, j) => {
            const ap = `${p}.answers[${j}]`;
            if (!isPlainObject(a)) {
              issues.add(ap, 'debe ser un objeto');
              return;
            }
            checkKeys(issues, ap, a, ['text', 'correct']);
            if (checkPlainText(issues, `${ap}.text`, a.text, { max: L.answerMax })) {
              const norm = (a.text as string).trim().toLowerCase().replace(/\s+/g, ' ');
              if (seen.has(norm)) issues.add(`${ap}.text`, 'respuesta duplicada');
              seen.add(norm);
            }
            if (typeof a.correct !== 'boolean') issues.add(`${ap}.correct`, 'debe ser booleano');
            else if (a.correct) correct++;
          });
          if (correct !== 1) issues.add(`${p}.answers`, `debe haber exactamente 1 correcta (hay ${correct})`);
        }
      } else if (c.kind === 'truefalse') {
        checkKeys(issues, p, c, ['index', 'kind', 'question', 'correct', 'feedbackCorrect', 'feedbackIncorrect']);
        if (typeof c.correct !== 'boolean') issues.add(`${p}.correct`, 'debe ser booleano');
      } else {
        issues.add(`${p}.kind`, 'debe ser "multichoice" o "truefalse"');
      }
    });
  }
  issues.throwIfAny('VideoInteractions');
  return plan as VideoCheckpoint[];
}

/** Convierte un checkpoint validado a la entrada de R7 (`buildInteractiveVideo`). */
export function checkpointToChoiceInput(c: VideoInteractionCheckpoint): ChoiceQuestionInput {
  if (c.kind === 'multichoice') {
    return {
      kind: 'multichoice',
      question: c.question,
      answers: c.answers!.map((a) => {
        const fb = a.correct ? c.feedbackCorrect : c.feedbackIncorrect;
        return fb !== undefined ? { text: a.text, correct: a.correct, feedback: fb } : { text: a.text, correct: a.correct };
      }),
    };
  }
  const tf: ChoiceQuestionInput = { kind: 'truefalse', question: c.question, correct: c.correct! };
  if (c.feedbackCorrect !== undefined) tf.feedbackCorrect = c.feedbackCorrect;
  if (c.feedbackIncorrect !== undefined) tf.feedbackWrong = c.feedbackIncorrect;
  return tf;
}
