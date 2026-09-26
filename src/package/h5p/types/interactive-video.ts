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
import { applyH5pL10n } from '../l10n';
import {
  ChoiceQuestionInput,
  H5pBuiltContent,
  Issues,
  buildChoiceSubContent,
  checkArray,
  checkChoiceQuestion,
  checkItemKey,
  checkKeys,
  escapeText,
  isPlainObject,
  shortTitle,
  titleRule,
} from './common';

export type InteractiveVideoInteractionInput = ChoiceQuestionInput & { atSec: number };

export interface InteractiveVideoInput {
  itemKey: string;
  title: string;
  youtubeId: string;
  durationSec: number;
  interactions: InteractiveVideoInteractionInput[];
}

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
  checkKeys(issues, '$', input, ['itemKey', 'title', 'youtubeId', 'durationSec', 'interactions']);
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
        extraKeys: ['atSec'],
      });
      if (!isPlainObject(it)) return;
      const at = it.atSec;
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
      // Sin seekTo ⇒ sin adaptividad (nunca salta en el video).
      adaptivity: {
        correct: { allowOptOut: false, message: '', seekLabel: '' },
        wrong: { allowOptOut: false, message: '', seekLabel: '' },
        requireCompletion: false,
      },
      visuals: { backgroundColor: 'rgb(255, 255, 255)', boxShadow: true },
      goto: { visualize: false },
    };
  });
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
        interactions,
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
  };
}
