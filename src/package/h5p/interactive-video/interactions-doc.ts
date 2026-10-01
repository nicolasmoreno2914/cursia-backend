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
import { REFLECTION_PAUSE_RULES, ReflectionPlan, VideoCheckpoint, planInteractionCheckpoints, planReflectionPauses, videoPlanDurationSec } from './plan';

export const VIDEO_INTERACTIONS_SCHEMA_VERSION = 1;
/**
 * EV6 H5P v2 — IV avanzado (Manifest `features.ivAdvanced = 1`): v1 + `reflections`
 * [{ index, prompt ≤200, hint? ≤200 }] en los índices fijos de planReflectionPauses.
 * La remediación (adaptivity) no la escribe el LLM: sale del plan (inicio del segmento).
 */
export const VIDEO_INTERACTIONS_SCHEMA_VERSION_V2 = 2;
export const VIDEO_REFLECTION_LIMITS = Object.freeze({ promptMax: 200, hintMax: 200 });

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

export interface VideoReflection {
  index: number;
  prompt: string;
  hint?: string;
}

export interface VideoInteractionsDoc {
  schemaVersion: 1 | 2;
  videoItemKey: string;
  durationSec: number;
  checkpoints: VideoInteractionCheckpoint[];
  /** Solo schemaVersion 2. */
  reflections?: VideoReflection[];
}

export interface VideoInteractionsExpectations {
  /** Si se da, `doc.videoItemKey` debe ser exactamente este. */
  videoItemKey?: string;
  /** Duración real (artifact de Videogen). Si se da, `doc.durationSec` debe coincidir (en segundos enteros). */
  durationSec?: number;
  /**
   * EV6: versión exigida (1 = legacy; 2 = IV avanzado, Manifest `features.ivAdvanced = 1`).
   * Ausente ⇒ 1 (comportamiento de siempre: un documento v2 sin el marcador se rechaza).
   */
  schemaVersion?: 1 | 2;
}

export interface VideoInteractionsPlan {
  checkpoints: VideoCheckpoint[];
  /** Vacío en schemaVersion 1. */
  reflectionPlan: ReflectionPlan;
}

/**
 * Valida el documento y devuelve el plan contra el que se validó.
 * Lanza H5pInputError("H5P_INPUT_INVALID(VideoInteractions): …") con TODOS los errores.
 */
export function validateVideoInteractionsDoc(doc: unknown, expect: VideoInteractionsExpectations = {}): VideoCheckpoint[] {
  return validateVideoInteractionsDocFull(doc, expect).checkpoints;
}

/** Igual que validateVideoInteractionsDoc, más el plan de pausas de reflexión (v2). */
export function validateVideoInteractionsDocFull(doc: unknown, expect: VideoInteractionsExpectations = {}): VideoInteractionsPlan {
  const L = VIDEO_INTERACTIONS_LIMITS;
  const issues = new Issues();
  if (!isPlainObject(doc)) {
    issues.add('$', 'debe ser un objeto');
    issues.throwIfAny('VideoInteractions');
  }
  const d = doc as Record<string, unknown>;
  const wantVersion = expect.schemaVersion ?? VIDEO_INTERACTIONS_SCHEMA_VERSION;
  const v2 = wantVersion === VIDEO_INTERACTIONS_SCHEMA_VERSION_V2;
  checkKeys(issues, '$', d, ['schemaVersion', 'videoItemKey', 'durationSec', 'checkpoints', ...(v2 ? ['reflections'] : [])]);
  if (d.schemaVersion !== wantVersion) {
    issues.add('schemaVersion', `debe ser ${wantVersion}`);
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
  let reflectionPlan: ReflectionPlan = { reflections: [], droppedReflections: [] };
  if (v2 && plan && planDur !== null) {
    reflectionPlan = planReflectionPauses(planDur, plan);
    const want = reflectionPlan.reflections;
    // Fix round 1 (m-6): sin pausas planificadas (d < 180 s) `reflections` puede omitirse o venir vacío.
    if (want.length === 0 && d.reflections === undefined) {
      // nada que validar
    } else if (checkArray(issues, 'reflections', d.reflections, want.length, want.length)) {
      (d.reflections as unknown[]).forEach((r, i) => {
        const p = `reflections[${i}]`;
        if (!isPlainObject(r)) {
          issues.add(p, 'debe ser un objeto');
          return;
        }
        checkKeys(issues, p, r, ['index', 'prompt', 'hint']);
        if (r.index !== want[i].index) issues.add(`${p}.index`, `debe ser ${want[i].index} (recibido ${String(r.index)})`);
        checkPlainText(issues, `${p}.prompt`, r.prompt, { max: VIDEO_REFLECTION_LIMITS.promptMax });
        if (r.hint !== undefined) checkPlainText(issues, `${p}.hint`, r.hint, { max: VIDEO_REFLECTION_LIMITS.hintMax });
      });
    }
  }
  issues.throwIfAny('VideoInteractions');
  return { checkpoints: plan as VideoCheckpoint[], reflectionPlan };
}

/** Mensaje de remediación por defecto (pregunta sin feedbackIncorrect). */
export const VIDEO_REMEDIATION_DEFAULT_MESSAGE = 'Revisa este tramo del video antes de seguir.';

/**
 * EV6 IV avanzado: remediación de un checkpoint validado. El salto (seekTo) es el
 * INICIO del segmento del plan (o el fin de la ventana de una pausa dentro del tramo); nunca lo decide el LLM.
 */
export function checkpointRemediation(
  c: VideoInteractionCheckpoint,
  planned: VideoCheckpoint,
  reflections: ReadonlyArray<{ atSec: number }> = [],
): { seekToSec: number; correctMessage: string; wrongMessage: string } {
  // Fix round 1 (m-1): si una pausa de reflexión cae dentro del tramo, el salto va justo DESPUÉS de su
  // ventana (no se vuelve a pausar con la misma reflexión); nunca en o después de la propia pregunta.
  let seek = planned.segment[0];
  for (const r of reflections) {
    if (r.atSec >= planned.segment[0] && r.atSec < planned.atSec) {
      const after = r.atSec + REFLECTION_PAUSE_RULES.windowSec;
      if (after < planned.atSec) seek = Math.max(seek, after);
    }
  }
  return {
    seekToSec: seek,
    correctMessage: c.feedbackCorrect ?? '',
    wrongMessage: c.feedbackIncorrect ?? VIDEO_REMEDIATION_DEFAULT_MESSAGE,
  };
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
