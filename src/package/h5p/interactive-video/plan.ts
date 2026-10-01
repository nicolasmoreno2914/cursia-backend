// Cursia V2.1 / R8 — distribución determinística de checkpoints del video (§L).
//
// La duración viene del artifact de Videogen (dato real), NUNCA del LLM. El LLM
// solo elige qué concepto del guion de cada segmento preguntar.
//
//   n = clamp(round(duración/100), 3, 8)
//   ventana útil = [30, duración − 15]   (nada en los primeros 30 s ni los últimos 15 s)
//   n segmentos equidistantes; checkpoint = punto medio (segundos enteros), ≥ 20 s entre sí.
//
// Si el video es más corto que 30 + 15 + 3·20 = 105 s no caben 3 interacciones
// separadas 20 s: se lanza VIDEO_TOO_SHORT_FOR_INTERACTIONS (fail loud; nunca un
// video "interactivo" con cero interacciones).
import { INTERACTIVE_VIDEO_RULES } from '../types/interactive-video';

export const VIDEO_CHECKPOINT_RULES = Object.freeze({
  secondsPerInteraction: 100,
  minInteractions: INTERACTIVE_VIDEO_RULES.minInteractions, // 3
  maxInteractions: INTERACTIVE_VIDEO_RULES.maxInteractions, // 8
  noInteractionFirstSec: INTERACTIVE_VIDEO_RULES.noInteractionFirstSec, // 30
  noInteractionLastSec: INTERACTIVE_VIDEO_RULES.noInteractionLastSec, // 15
  minGapSec: INTERACTIVE_VIDEO_RULES.minGapSec, // 20
  /** 30 + 15 + 3·20 = 105 s. */
  minDurationSec:
    INTERACTIVE_VIDEO_RULES.noInteractionFirstSec +
    INTERACTIVE_VIDEO_RULES.noInteractionLastSec +
    INTERACTIVE_VIDEO_RULES.minInteractions * INTERACTIVE_VIDEO_RULES.minGapSec,
  maxDurationSec: INTERACTIVE_VIDEO_RULES.maxDurationSec,
});

export interface VideoCheckpoint {
  /** 1-based; es el `index` que debe devolver el LLM en `video_interactions`. */
  index: number;
  /** Segundo entero donde aparece (y pausa) la interacción. */
  atSec: number;
  /** Segmento del video [inicio, fin] (s enteros) cuyo guion debe cubrir la pregunta. */
  segment: [number, number];
}

export class VideoPlanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'VideoPlanError';
    this.code = code;
  }
}

/** Duración efectiva del plan: segundos enteros (floor). Falla si no es un número válido. */
export function videoPlanDurationSec(durationSec: number): number {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new VideoPlanError('VIDEO_DURATION_INVALID', `durationSec debe ser un número finito > 0 (recibido ${String(durationSec)})`);
  }
  if (durationSec > VIDEO_CHECKPOINT_RULES.maxDurationSec) {
    throw new VideoPlanError('VIDEO_DURATION_INVALID', `durationSec ${durationSec} supera el máximo ${VIDEO_CHECKPOINT_RULES.maxDurationSec}`);
  }
  return Math.floor(durationSec);
}

/** Cantidad de interacciones para una duración: clamp(round(d/100), 3, 8). */
export function videoInteractionCount(durationSec: number): number {
  const d = videoPlanDurationSec(durationSec);
  const R = VIDEO_CHECKPOINT_RULES;
  return Math.min(R.maxInteractions, Math.max(R.minInteractions, Math.round(d / R.secondsPerInteraction)));
}

/**
 * Plan determinístico de checkpoints. Puro: misma duración ⇒ mismo plan.
 * Lanza VIDEO_TOO_SHORT_FOR_INTERACTIONS si d < 105 s.
 */
export function planInteractionCheckpoints(durationSec: number): VideoCheckpoint[] {
  const R = VIDEO_CHECKPOINT_RULES;
  const d = videoPlanDurationSec(durationSec);
  if (d < R.minDurationSec) {
    throw new VideoPlanError(
      'VIDEO_TOO_SHORT_FOR_INTERACTIONS',
      `el video dura ${d} s; se necesitan ≥ ${R.minDurationSec} s (30 s iniciales + 15 s finales + ${R.minInteractions}×${R.minGapSec} s)`,
    );
  }
  const n = videoInteractionCount(d);
  const start = R.noInteractionFirstSec;
  const end = d - R.noInteractionLastSec;
  const seg = (end - start) / n;
  const out: VideoCheckpoint[] = [];
  for (let i = 0; i < n; i++) {
    const s = Math.round(start + i * seg);
    const e = i === n - 1 ? end : Math.round(start + (i + 1) * seg);
    out.push({ index: i + 1, atSec: Math.round(start + (i + 0.5) * seg), segment: [s, e] });
  }
  // Invariantes (defensivo: con d ≥ 105 siempre se cumplen, pero nunca se devuelve un plan roto).
  out.forEach((c, i) => {
    if (c.atSec < start || c.atSec > end) {
      throw new VideoPlanError('VIDEO_PLAN_INVARIANT', `checkpoint ${c.index} en ${c.atSec} fuera de [${start}, ${end}]`);
    }
    if (c.atSec < c.segment[0] || c.atSec > c.segment[1]) {
      throw new VideoPlanError('VIDEO_PLAN_INVARIANT', `checkpoint ${c.index} en ${c.atSec} fuera de su segmento`);
    }
    if (i > 0 && c.atSec - out[i - 1].atSec < R.minGapSec) {
      throw new VideoPlanError('VIDEO_PLAN_INVARIANT', `checkpoints ${i} y ${i + 1} a menos de ${R.minGapSec} s`);
    }
  });
  return out;
}

// ── EV6 H5P v2 — IV avanzado: pausas de reflexión (H5P.Text, sin puntaje) ──────
//
//   cantidad: 0 si d < 180 s, 1 si 180–299 s, 2 si ≥ 300 s
//   ranuras (1-based sobre los n checkpoints): k1 = ⌈n/3⌉, k2 = ⌈2n/3⌉; se usan las
//   primeras `cantidad`. La pausa j va en el punto medio (s enteros) entre los
//   checkpoints kj y kj+1.
//   Reglas: dentro de [30, d−15]; ≥ 10 s DESPUÉS del cierre de toda ventana de pregunta
//   [at, at+10] anterior y ≥ 10 s ANTES de la pregunta siguiente; sin chocar con otra
//   pausa (≥ 10 s). Una ranura que no cumple se DESCARTA de forma determinística y queda
//   en `droppedReflections` (nunca en silencio).
export const REFLECTION_PAUSE_RULES = Object.freeze({
  oneFromSec: 180,
  twoFromSec: 300,
  windowSec: INTERACTIVE_VIDEO_RULES.windowSec, // 10
  afterWindowSec: 10,
  beforeQuestionSec: 10,
  minGapBetweenPausesSec: 10,
});

export interface ReflectionPause {
  /** 1 o 2 (número de ranura); es el `index` que debe devolver el LLM en `reflections`. */
  index: number;
  atSec: number;
  /** Checkpoint (1-based) después del cual va la pausa. */
  afterCheckpoint: number;
}

export interface DroppedReflection extends ReflectionPause {
  reason: string;
}

export interface ReflectionPlan {
  reflections: ReflectionPause[];
  droppedReflections: DroppedReflection[];
}

export function reflectionPauseCount(durationSec: number): number {
  const d = videoPlanDurationSec(durationSec);
  return d < REFLECTION_PAUSE_RULES.oneFromSec ? 0 : d < REFLECTION_PAUSE_RULES.twoFromSec ? 1 : 2;
}

/** Plan determinístico de pausas de reflexión. Puro: misma duración + checkpoints ⇒ mismo plan. */
export function planReflectionPauses(durationSec: number, checkpoints: VideoCheckpoint[]): ReflectionPlan {
  const R = REFLECTION_PAUSE_RULES;
  const d = videoPlanDurationSec(durationSec);
  const count = reflectionPauseCount(d);
  const n = Array.isArray(checkpoints) ? checkpoints.length : 0;
  const reflections: ReflectionPause[] = [];
  const droppedReflections: DroppedReflection[] = [];
  if (count === 0) return { reflections, droppedReflections };
  if (n === 0) throw new VideoPlanError('VIDEO_PLAN_INVARIANT', 'planReflectionPauses sin checkpoints');
  const slots = [Math.ceil(n / 3), Math.ceil((2 * n) / 3)].slice(0, count);
  const lo = VIDEO_CHECKPOINT_RULES.noInteractionFirstSec;
  const hi = d - VIDEO_CHECKPOINT_RULES.noInteractionLastSec;
  slots.forEach((k, j) => {
    const index = j + 1;
    const a = checkpoints[k - 1];
    const b = checkpoints[k];
    if (!a || !b) {
      droppedReflections.push({ index, atSec: a ? a.atSec : -1, afterCheckpoint: k, reason: `no hay checkpoint ${k + 1} después del ${k}` });
      return;
    }
    const atSec = Math.round((a.atSec + b.atSec) / 2);
    const base = { index, atSec, afterCheckpoint: k };
    if (atSec < lo || atSec > hi) {
      droppedReflections.push({ ...base, reason: `fuera de [${lo}, ${hi}]` });
      return;
    }
    const clash = checkpoints.find((c) =>
      c.atSec <= atSec ? atSec < c.atSec + R.windowSec + R.afterWindowSec : c.atSec - atSec < R.beforeQuestionSec,
    );
    if (clash) {
      droppedReflections.push({
        ...base,
        reason: `choca con la pregunta ${clash.index} (${clash.atSec} s): se exige ≥ ${R.afterWindowSec} s tras su ventana y ≥ ${R.beforeQuestionSec} s antes`,
      });
      return;
    }
    const other = reflections.find((r) => Math.abs(r.atSec - atSec) < R.minGapBetweenPausesSec);
    if (other) {
      droppedReflections.push({ ...base, reason: `colisión con la pausa ${other.index} (${other.atSec} s)` });
      return;
    }
    reflections.push(base);
  });
  return { reflections, droppedReflections };
}
