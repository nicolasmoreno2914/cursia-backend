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
