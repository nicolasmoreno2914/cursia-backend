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

// ── r61 Q-04 — checkpoints anclados a las escenas reales del video (Videogen) ──
//
// El plan equidistante supone que el video recorre el capítulo de forma pareja; Videogen escribe su
// propio guion por escenas (narración + duración real del audio de cada una) y el render concatena las
// escenas en orden, cada una exactamente `duration_seconds` (renderer.service.ts de video-engine-ia:
// `-t duration` por escena + concat). Con esa línea de tiempo cada pregunta se ancla al FINAL de una
// escena: aparece justo cuando el video terminó de explicar lo que pregunta.
//
//   - Cantidad n: la MISMA del plan equidistante (clamp(round(d/100), 3, 8)) → los validadores del
//     documento (cantidad + index) y el puntaje no cambian.
//   - Candidatos: ⌈fin de escena⌉ dentro de [30, d − 15].
//   - Selección: n candidatos crecientes, ≥ 20 s entre sí, que minimizan Σ|candidato − atSec equidistante|
//     (programación dinámica; empates → el candidato más temprano). Puro y determinístico.
//   - Segmento del checkpoint i: [atSec del checkpoint anterior (0 para el primero), atSec].
//   - Sin escenas, con escenas inconsistentes con la duración medida o sin candidatos suficientes →
//     plan equidistante de siempre, con `timelineSource: 'even_spacing'` y el motivo (nunca en silencio).
export const VIDEO_SCENE_RULES = Object.freeze({
  /** Tope de escenas guardadas por video (Videogen: ~12–22 escenas de 30–45 s). */
  maxScenes: 100,
  /** Narración guardada por escena (recortada): alcanza para que el LLM sepa qué explica la escena. */
  narrationMax: 360,
  /** Tolerancia del anclaje: atSec ∈ [fin de escena − ε, inicio de la siguiente + ε]. */
  anchorEpsilonSec: 1,
  /** |Σ escenas − duración medida| ≤ max(3 s, 3 %) — si no, la línea de tiempo no es la del MP4. */
  durationToleranceSec: 3,
  durationToleranceRatio: 0.03,
});

export interface VideoScene {
  /** scene_order de Videogen. */
  order: number;
  /** Inicio/fin en el video (s, 3 decimales), acumulando la duración real del audio de cada escena. */
  startSec: number;
  endSec: number;
  /** Narración de la escena (espacios colapsados, ≤ narrationMax). */
  narration: string;
}

export type VideoTimelineSource = 'videogen_scenes' | 'even_spacing';

export interface VideoCheckpointPlan {
  checkpoints: VideoCheckpoint[];
  timelineSource: VideoTimelineSource;
  /** Solo con even_spacing: por qué no se usaron las escenas. */
  timelineReason?: string;
  /** Solo con videogen_scenes: las escenas re-escaladas a la duración medida (las que usa el plan y el prompt). */
  scenes?: VideoScene[];
}

/**
 * Review M-1: el MP4 real deriva respecto de Σ escenas (cada clip `-t` se redondea a frames y el AAC agrega
 * relleno). Se re-escalan los tiempos por d/Σ (d = duración medida en segundos enteros) para que el fin de cada escena
 * caiga donde termina en el video publicado. 3 decimales, misma aritmética en el espejo del navegador.
 */
export function scaleVideoScenes(durationSec: number, scenes: VideoScene[]): VideoScene[] {
  const total = scenes[scenes.length - 1].endSec;
  const f = durationSec / total;
  const at = (x: number) => Math.round(x * f * 1000) / 1000;
  return scenes.map((s) => ({ order: s.order, startSec: at(s.startSec), endSec: at(s.endSec), narration: s.narration }));
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Narración normalizada: espacios colapsados y recortada a narrationMax (en un límite de palabra si se puede). */
export function trimSceneNarration(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  const max = VIDEO_SCENE_RULES.narrationMax;
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…';
}

/**
 * Escenas del status de Videogen (`scenes: [{scene_order, narration, duration_seconds}]`) → línea de
 * tiempo acotada. Las duraciones se acumulan en milisegundos enteros (sin deriva de coma flotante).
 */
export function videoScenesFromVideogen(raw: unknown): { ok: true; scenes: VideoScene[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: 'no_scene_data' };
  if (raw.length > VIDEO_SCENE_RULES.maxScenes) return { ok: false, reason: `too_many_scenes(${raw.length})` };
  const rows: Array<{ order: number; ms: number; narration: string }> = [];
  for (const s of raw) {
    if (!isObj(s)) return { ok: false, reason: 'invalid_scene' };
    const order = Number(s.scene_order);
    const dur = Number(s.duration_seconds);
    if (!Number.isInteger(order)) return { ok: false, reason: 'invalid_scene_order' };
    if (s.duration_seconds === null || s.duration_seconds === undefined || !Number.isFinite(dur) || dur <= 0) {
      return { ok: false, reason: `scene_duration_missing(${order})` };
    }
    rows.push({ order, ms: Math.round(dur * 1000), narration: trimSceneNarration(s.narration) });
  }
  rows.sort((a, b) => a.order - b.order);
  for (let i = 1; i < rows.length; i++) if (rows[i].order === rows[i - 1].order) return { ok: false, reason: `duplicate_scene_order(${rows[i].order})` };
  let acc = 0;
  const scenes = rows.map((r) => {
    const startSec = acc / 1000;
    acc += r.ms;
    return { order: r.order, startSec, endSec: acc / 1000, narration: r.narration };
  });
  return { ok: true, scenes };
}

/** Verifica una línea de tiempo guardada contra la duración medida. null = utilizable; si no, el motivo. */
export function videoScenesProblem(durationSec: number, scenes: unknown): string | null {
  if (!Array.isArray(scenes) || scenes.length === 0) return 'no_scene_data';
  if (scenes.length > VIDEO_SCENE_RULES.maxScenes) return `too_many_scenes(${scenes.length})`;
  let prevEnd = 0;
  let prevOrder = -Infinity;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (!isObj(s)) return 'invalid_scene';
    const { order, startSec, endSec, narration } = s as Record<string, unknown>;
    if (!Number.isInteger(order) || (order as number) <= prevOrder) return 'invalid_scene_order';
    if (typeof startSec !== 'number' || typeof endSec !== 'number' || !Number.isFinite(startSec) || !Number.isFinite(endSec)) return 'invalid_scene_times';
    if (Math.abs(startSec - prevEnd) > 0.001 || endSec <= startSec) return 'invalid_scene_times';
    if (typeof narration !== 'string' || narration.length > VIDEO_SCENE_RULES.narrationMax) return 'invalid_scene_narration';
    prevEnd = endSec;
    prevOrder = order as number;
  }
  const tol = Math.max(VIDEO_SCENE_RULES.durationToleranceSec, durationSec * VIDEO_SCENE_RULES.durationToleranceRatio);
  if (Math.abs(prevEnd - durationSec) > tol) return `timeline_duration_mismatch(${prevEnd.toFixed(1)}s≠${durationSec}s)`;
  return null;
}

/**
 * Invariante del anclaje: cada atSec cae en [fin de una escena − ε, inicio de la siguiente + ε], dentro de
 * [30, d − 15], creciente y ≥ 20 s entre sí. Lanza VIDEO_PLAN_INVARIANT.
 */
export function assertSceneAnchoredCheckpoints(durationSec: number, checkpoints: VideoCheckpoint[], scenes: VideoScene[]): void {
  const R = VIDEO_CHECKPOINT_RULES;
  const eps = VIDEO_SCENE_RULES.anchorEpsilonSec;
  const d = videoPlanDurationSec(durationSec);
  checkpoints.forEach((c, i) => {
    if (c.atSec < R.noInteractionFirstSec || c.atSec > d - R.noInteractionLastSec) {
      throw new VideoPlanError('VIDEO_PLAN_INVARIANT', `checkpoint ${c.index} en ${c.atSec} fuera de [${R.noInteractionFirstSec}, ${d - R.noInteractionLastSec}]`);
    }
    const k = scenes.findIndex((s, j) => {
      const nextStart = j + 1 < scenes.length ? scenes[j + 1].startSec : s.endSec;
      return c.atSec >= s.endSec - eps && c.atSec <= nextStart + eps;
    });
    if (k < 0) throw new VideoPlanError('VIDEO_PLAN_INVARIANT', `checkpoint ${c.index} en ${c.atSec} no está anclado al final de una escena`);
    if (c.atSec < c.segment[0] || c.atSec > c.segment[1]) throw new VideoPlanError('VIDEO_PLAN_INVARIANT', `checkpoint ${c.index} en ${c.atSec} fuera de su segmento`);
    if (i > 0 && c.atSec - checkpoints[i - 1].atSec < R.minGapSec) {
      throw new VideoPlanError('VIDEO_PLAN_INVARIANT', `checkpoints ${i} y ${i + 1} a menos de ${R.minGapSec} s`);
    }
  });
}

/**
 * Escenas que cubre un checkpoint: las que TERMINAN (⌈fin⌉, el mismo redondeo del anclaje) dentro de su
 * segmento (inicio, atSec]. Partición exacta: cada escena terminada antes de la última pausa pertenece a una
 * sola pregunta, también las de < 1 s (review M-2).
 */
export function scenesForCheckpoint(checkpoint: VideoCheckpoint, scenes: VideoScene[]): VideoScene[] {
  return scenes.filter((s) => {
    const e = Math.ceil(s.endSec - 1e-6);
    return e > checkpoint.segment[0] && e <= checkpoint.atSec;
  });
}

/**
 * Plan de checkpoints con la línea de tiempo del video si existe (Q-04). Misma cantidad que el plan
 * equidistante; lanza los mismos errores que planInteractionCheckpoints (duración inválida / corta).
 */
export function planVideoCheckpoints(durationSec: number, scenes?: unknown): VideoCheckpointPlan {
  const even = planInteractionCheckpoints(durationSec);
  if (scenes === undefined || scenes === null) return { checkpoints: even, timelineSource: 'even_spacing', timelineReason: 'no_scene_data' };
  const R = VIDEO_CHECKPOINT_RULES;
  const d = videoPlanDurationSec(durationSec);
  const problem = videoScenesProblem(d, scenes);
  if (problem) return { checkpoints: even, timelineSource: 'even_spacing', timelineReason: problem };
  // Se escala a d = floor(duración): el plan es función de los segundos enteros (claim, validación y .h5p coinciden).
  const sc = scaleVideoScenes(d, scenes as VideoScene[]);
  const lo = R.noInteractionFirstSec;
  const hi = d - R.noInteractionLastSec;
  const cand: number[] = [];
  for (const s of sc) {
    const b = Math.ceil(s.endSec - 1e-6);
    if (b >= lo && b <= hi && (cand.length === 0 || b > cand[cand.length - 1])) cand.push(b);
  }
  const n = even.length;
  const m = cand.length;
  const INF = Number.POSITIVE_INFINITY;
  // cost[i][j]: mejor costo con el checkpoint i en el candidato j; par[i][j]: candidato del checkpoint i−1.
  const cost: number[][] = [];
  const par: number[][] = [];
  for (let i = 0; i < n; i++) {
    cost.push(new Array(m).fill(INF));
    par.push(new Array(m).fill(-1));
    for (let j = 0; j < m; j++) {
      const own = Math.abs(cand[j] - even[i].atSec);
      if (i === 0) {
        cost[i][j] = own;
        continue;
      }
      let best = INF;
      let bp = -1;
      for (let p = 0; p < j; p++) {
        if (cand[j] - cand[p] < R.minGapSec) break;
        if (cost[i - 1][p] < best) {
          best = cost[i - 1][p];
          bp = p;
        }
      }
      if (bp >= 0) {
        cost[i][j] = best + own;
        par[i][j] = bp;
      }
    }
  }
  let end = -1;
  let endCost = INF;
  for (let j = 0; j < m; j++) if (cost[n - 1][j] < endCost) { endCost = cost[n - 1][j]; end = j; }
  if (end < 0) return { checkpoints: even, timelineSource: 'even_spacing', timelineReason: `insufficient_scene_boundaries(${m}<${n})` };
  const picks: number[] = new Array(n);
  for (let i = n - 1, j = end; i >= 0; i--) {
    picks[i] = cand[j];
    j = par[i][j];
  }
  const out: VideoCheckpoint[] = picks.map((atSec, i) => ({ index: i + 1, atSec, segment: [i === 0 ? 0 : picks[i - 1], atSec] as [number, number] }));
  assertSceneAnchoredCheckpoints(d, out, sc);
  return { checkpoints: out, timelineSource: 'videogen_scenes', scenes: sc };
}
