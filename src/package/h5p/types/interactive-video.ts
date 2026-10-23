// Cursia V2.1 / R7-core — H5P.InteractiveVideo con fuente YouTube (§L, HD-V21-2).
//
// - Fuente: https://www.youtube.com/watch?v=<id>, mime video/YouTube (forma probada en V1/R0).
// - Interacciones MultiChoice/TrueFalse: pausan el video, etiqueta y título en
//   español, ventana de 10 s, sin adaptividad (no hay saltos).
// - Pantalla de envío (endscreen) al final → xAPI "completed" con el puntaje.
// - preventSkipping OFF; sin Summary genérico.
// - El ALGORITMO de distribución (cuántas y cuándo) es de R8; aquí solo se
//   valida: 3–8 interacciones, dentro de [30, duración−15], estrictamente
//   crecientes y separadas ≥ 20 s.
import { h5pSubContentId } from '../ids';
import { applyH5pL10n } from '../l10n';
import { CURSIA_H5P_PROFILE_V1, h5pProfileVersionV2 } from '../profile';
import { h5pLibraryString } from '../profile-generator';
import {
  ChoiceQuestionInput,
  H5pBuiltContent,
  Issues,
  buildChoiceSubContent,
  checkArray,
  checkChoiceQuestion,
  checkItemKey,
  checkKeys,
  checkPlainText,
  escapeText,
  isPlainObject,
  shortTitle,
  titleRule,
} from './common';

/**
 * EV6 IV avanzado: remediación (adaptivity). Ante respuesta incorrecta el video
 * ofrece volver al inicio del tramo (`seekToSec`, del plan; nunca del LLM). Sin
 * este campo la interacción queda exactamente como en v1 (sin saltos).
 */
export interface InteractiveVideoRemediation {
  seekToSec: number;
  correctMessage?: string;
  wrongMessage?: string;
}

export type InteractiveVideoInteractionInput = ChoiceQuestionInput & { atSec: number; remediation?: InteractiveVideoRemediation };

/** EV6 IV avanzado: pausa de reflexión (H5P.Text, pausa el video, sin puntaje). */
export interface InteractiveVideoReflectionInput {
  atSec: number;
  prompt: string;
  hint?: string;
  /** Número de ranura del plan (1 o 2): semilla del subContentId (`#p2`). */
  index: number;
}

export interface InteractiveVideoInput {
  itemKey: string;
  title: string;
  youtubeId: string;
  durationSec: number;
  interactions: InteractiveVideoInteractionInput[];
  /** EV6 IV avanzado (opcional). Ausente ⇒ contenido byte-idéntico a v1. */
  reflections?: InteractiveVideoReflectionInput[];
}

export const INTERACTIVE_VIDEO_ADVANCED = Object.freeze({
  maxReflections: 2,
  promptMax: 200,
  hintMax: 200,
  messageMax: 250,
  seekLabel: 'Volver a ver este tramo',
  reflectionLead: 'Pausa para pensar:',
  hintLead: 'Pista:',
});

/** "H5P.Text 1.1" (ya en la clausura de CURSIA_H5P_PROFILE_V1; sin dependencias propias). */
export const IV_REFLECTION_LIBRARY = (() => {
  const ref = CURSIA_H5P_PROFILE_V1.libraries.find((l) => l.machineName === 'H5P.Text');
  if (!ref) throw new Error('H5P_PROFILE_CORRUPT: H5P.Text no está en CURSIA_H5P_PROFILE_V1');
  return Object.freeze({ machineName: ref.machineName, majorVersion: ref.majorVersion, minorVersion: ref.minorVersion });
})();

export const INTERACTIVE_VIDEO_RULES = Object.freeze({
  minInteractions: 3,
  maxInteractions: 8,
  noInteractionFirstSec: 30,
  noInteractionLastSec: 15,
  minGapSec: 20,
  windowSec: 10,
  minAnswers: 3,
  maxAnswers: 4,
  maxDurationSec: 4 * 3600,
});

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function validateInteractiveVideoInput(input: unknown): asserts input is InteractiveVideoInput {
  const R = INTERACTIVE_VIDEO_RULES;
  const issues = new Issues();
  if (!isPlainObject(input)) {
    issues.add('$', 'debe ser un objeto');
    issues.throwIfAny('InteractiveVideo');
    return;
  }
  checkKeys(issues, '$', input, ['itemKey', 'title', 'youtubeId', 'durationSec', 'interactions', ...('reflections' in input ? ['reflections'] : [])]);
  checkItemKey(issues, input.itemKey);
  titleRule(issues, input.title);
  if (typeof input.youtubeId !== 'string' || !YOUTUBE_ID_RE.test(input.youtubeId)) {
    issues.add('youtubeId', 'debe ser un id de YouTube de 11 caracteres');
  }
  const dur = input.durationSec;
  const durOk = typeof dur === 'number' && Number.isFinite(dur) && dur > 0 && dur <= R.maxDurationSec;
  if (!durOk) issues.add('durationSec', `debe ser un número > 0 y ≤ ${R.maxDurationSec}`);
  if (checkArray(issues, 'interactions', input.interactions, R.minInteractions, R.maxInteractions)) {
    let prev: number | null = null;
    (input.interactions as unknown[]).forEach((it, i) => {
      const p = `interactions[${i}]`;
      checkChoiceQuestion(issues, p, it, {
        minAnswers: R.minAnswers,
        maxAnswers: R.maxAnswers,
        exactlyOneCorrect: true,
        extraKeys: isPlainObject(it) && 'remediation' in it ? ['atSec', 'remediation'] : ['atSec'],
      });
      if (!isPlainObject(it)) return;
      const at = it.atSec;
      if ('remediation' in it) {
        const rm = it.remediation;
        const A = INTERACTIVE_VIDEO_ADVANCED;
        if (!isPlainObject(rm)) issues.add(`${p}.remediation`, 'debe ser un objeto');
        else {
          checkKeys(issues, `${p}.remediation`, rm, ['seekToSec', 'correctMessage', 'wrongMessage']);
          if (!Number.isInteger(rm.seekToSec) || (rm.seekToSec as number) < 0 || (typeof at === 'number' && (rm.seekToSec as number) > at)) {
            issues.add(`${p}.remediation.seekToSec`, 'debe ser un entero entre 0 y el segundo de la pregunta');
          }
          if (rm.correctMessage !== undefined && rm.correctMessage !== '') checkPlainText(issues, `${p}.remediation.correctMessage`, rm.correctMessage, { max: A.messageMax });
          if (rm.wrongMessage !== undefined) checkPlainText(issues, `${p}.remediation.wrongMessage`, rm.wrongMessage, { max: A.messageMax });
        }
      }
      if (typeof at !== 'number' || !Number.isFinite(at)) {
        issues.add(`${p}.atSec`, 'debe ser un número');
        return;
      }
      if (durOk && (at < R.noInteractionFirstSec || at > (dur as number) - R.noInteractionLastSec)) {
        issues.add(`${p}.atSec`, `${at} fuera de [${R.noInteractionFirstSec}, ${(dur as number) - R.noInteractionLastSec}]`);
      }
      if (prev !== null) {
        if (at <= prev) issues.add(`${p}.atSec`, `debe ser estrictamente mayor que ${prev}`);
        else if (at - prev < R.minGapSec) issues.add(`${p}.atSec`, `debe estar a ≥ ${R.minGapSec} s de la anterior (${prev})`);
      }
      prev = at;
    });
  }
  if ('reflections' in input) {
    const A = INTERACTIVE_VIDEO_ADVANCED;
    if (checkArray(issues, 'reflections', input.reflections, 0, A.maxReflections)) {
      const qs = Array.isArray(input.interactions) ? (input.interactions as unknown[]).filter(isPlainObject).map((x) => x.atSec) : [];
      (input.reflections as unknown[]).forEach((r, i) => {
        const p = `reflections[${i}]`;
        if (!isPlainObject(r)) {
          issues.add(p, 'debe ser un objeto');
          return;
        }
        checkKeys(issues, p, r, ['atSec', 'prompt', 'hint', 'index']);
        if (!Number.isInteger(r.index) || (r.index as number) < 1 || (r.index as number) > A.maxReflections) issues.add(`${p}.index`, `debe ser 1..${A.maxReflections}`);
        checkPlainText(issues, `${p}.prompt`, r.prompt, { max: A.promptMax });
        if (r.hint !== undefined) checkPlainText(issues, `${p}.hint`, r.hint, { max: A.hintMax });
        const at = r.atSec;
        if (typeof at !== 'number' || !Number.isInteger(at)) issues.add(`${p}.atSec`, 'debe ser un entero');
        else {
          if (durOk && (at < R.noInteractionFirstSec || at > (dur as number) - R.noInteractionLastSec)) {
            issues.add(`${p}.atSec`, `${at} fuera de [${R.noInteractionFirstSec}, ${(dur as number) - R.noInteractionLastSec}]`);
          }
          if (qs.some((q) => q === at)) issues.add(`${p}.atSec`, 'coincide con una pregunta');
        }
      });
    }
  }
  issues.throwIfAny('InteractiveVideo');
}

function mmss(sec: number): string {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function buildInteractiveVideo(input: InteractiveVideoInput): H5pBuiltContent {
  validateInteractiveVideoInput(input);
  const R = INTERACTIVE_VIDEO_RULES;
  const n = input.interactions.length;
  const interactions = input.interactions.map((it, i) => {
    const title = `Pregunta ${i + 1} de ${n}: ${shortTitle(it.question)}`;
    const action = buildChoiceSubContent(it, input.itemKey, i, title);
    return {
      x: 5,
      y: 5,
      width: 90,
      height: 90,
      duration: { from: it.atSec, to: it.atSec + R.windowSec },
      pause: true,
      displayType: 'poster',
      buttonOnMobile: false,
      label: `<p>Pregunta ${i + 1}</p>`,
      libraryTitle: it.kind === 'multichoice' ? 'Opción múltiple' : 'Verdadero o falso',
      action,
      adaptivity: it.remediation
        ? {
            // EV6 IV avanzado: ante error, ofrece volver al inicio del tramo (opcional: allowOptOut).
            correct: { allowOptOut: true, message: escapeText(it.remediation.correctMessage ?? ''), seekLabel: '' },
            wrong: {
              seekTo: it.remediation.seekToSec,
              allowOptOut: true,
              message: escapeText(it.remediation.wrongMessage ?? ''),
              seekLabel: INTERACTIVE_VIDEO_ADVANCED.seekLabel,
            },
            requireCompletion: false,
          }
        : {
            // Sin seekTo ⇒ sin adaptividad (nunca salta en el video).
            correct: { allowOptOut: false, message: '', seekLabel: '' },
            wrong: { allowOptOut: false, message: '', seekLabel: '' },
            requireCompletion: false,
          },
      visuals: { backgroundColor: 'rgb(255, 255, 255)', boxShadow: true },
      goto: { visualize: false },
    };
  });
  const reflections = (input.reflections || []).map((r) => {
    const text =
      `<p><strong>${escapeText(INTERACTIVE_VIDEO_ADVANCED.reflectionLead)}</strong> ${escapeText(r.prompt)}</p>` +
      (r.hint ? `<p><em>${escapeText(INTERACTIVE_VIDEO_ADVANCED.hintLead)}</em> ${escapeText(r.hint)}</p>` : '');
    return {
      x: 5,
      y: 5,
      width: 90,
      height: 90,
      duration: { from: r.atSec, to: r.atSec + R.windowSec },
      pause: true,
      displayType: 'poster',
      buttonOnMobile: false,
      label: '<p>Pausa para pensar</p>',
      libraryTitle: 'Texto',
      action: {
        library: h5pLibraryString(IV_REFLECTION_LIBRARY),
        // Índices 100+ y perfil p2: nunca chocan con los de las preguntas (p1, 0..n-1).
        subContentId: h5pSubContentId(input.itemKey, 100 + r.index, h5pProfileVersionV2),
        metadata: { contentType: 'Text', license: 'U', title: `Pausa para pensar ${r.index}` },
        params: { text },
      },
      visuals: { backgroundColor: 'rgb(255, 255, 255)', boxShadow: true },
      goto: { visualize: false },
    };
  });
  // Con pausas: todas las interacciones en orden de aparición (estable). Sin pausas: la lista de v1 tal cual.
  const allInteractions: Array<(typeof interactions)[number] | (typeof reflections)[number]> = reflections.length
    ? [...interactions, ...reflections].sort((a, b) => a.duration.from - b.duration.from)
    : interactions;
  const title = escapeText(input.title);
  const content = applyH5pL10n('H5P.InteractiveVideo', {
    interactiveVideo: {
      video: {
        files: [
          {
            path: `https://www.youtube.com/watch?v=${input.youtubeId}`,
            mime: 'video/YouTube',
            copyright: { license: 'U' },
          },
        ],
        startScreenOptions: { title, hideStartTitle: true },
        // Sin textTracks ni bookmarks: el validador H5P elimina listas vacías y campos fuera de semantics.
      },
      assets: {
        interactions: allInteractions,
        // Pantalla de envío al final: el alumno envía y H5P emite "completed" con el puntaje.
        endscreens: [{ time: input.durationSec, label: `${mmss(input.durationSec)} Pantalla de envío` }],
      },
      // Sin `task`: IV no agrega el Summary genérico de V1.
      summary: { displayAt: 3 },
    },
    override: {
      autoplay: false,
      loop: false,
      showSolutionButton: 'on',
      // HD-V21-22: el override del IV fuerza el botón de cada interacción — sin reintento dentro del intento.
      retryButton: 'off',
      showBookmarksmenuOnLoad: false,
      showRewind10: true,
      preventSkippingMode: 'none',
      deactivateSound: false,
    },
  });
  return {
    mainLibrary: 'H5P.InteractiveVideo',
    title: input.title.trim(),
    content,
    subContentIds: interactions.map((x) => x.action.subContentId),
    maxScore: n,
    ...(reflections.length ? { extraDependencies: [{ ...IV_REFLECTION_LIBRARY }] } : {}),
  };
}
