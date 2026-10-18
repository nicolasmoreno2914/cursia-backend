/**
 * T3 (r57) · Composición por necesidad (CLP v0, Fase 5): ¿qué capítulos de contenido llevan VIDEO generado?
 *
 * Con el plan de aprendizaje activo y `learningPlan.composition.videos = 'by_need'`, el video de cada capítulo deja de
 * ser un toggle uniforme y sale de la NECESIDAD de demostración o modelado de su tipo de aprendizaje (learning-type.ts),
 * de las restricciones explícitas (mínimo / máximo de videos del curso, capítulos fijados por el docente, requisitos
 * del documento) y de las horas. Función pura y determinista: la misma entrada da SIEMPRE la misma decisión, y cada
 * decisión lleva su regla (`ruleId`) y un motivo en español para el docente. Se materializa en el flag de video de
 * siempre (`video_enabled`): el Manifest, el shell, las huellas y FinOps no cambian de forma (el estimado sale del
 * Manifest, así que cuenta exactamente los videos decididos).
 *
 * Precedencia (de mayor a menor): capítulo fijado por el docente (`vid.pinned`) > requisito obligatorio del documento
 * (`vid.document`) > mínimo / máximo de videos del curso (`vid.min_videos` / `vid.max_videos`) > prioridad audiovisual
 * de «Ajustar» (`vid.optional.more` / `vid.optional.less`) > necesidad del tipo de aprendizaje (`vid.need.*`) >
 * presupuesto de horas para los opcionales (`vid.optional.hours_budget` / `vid.optional.no_budget`).
 *
 * Presupuesto de horas (sin preferencia audiovisual explícita): los capítulos cuyo tipo NO exige video (decisión/caso,
 * normativo/ético, conceptual, en ese orden de prioridad) lo reciben solo mientras el curso tenga menos de
 * floor(targetHours / hoursPerBudgetVideo) videos en total. Es una constante de producto (1 video cada 5 h de carga
 * declarada), NO calibrada con datos de uso: está versionada y a la vista para poder cambiarla.
 */
import type { LearningType } from '../pedagogy/vocabulary';

export const VIDEO_COMPOSITION_VERSION = 1 as const;

export type VideoNeed = 'demonstration' | 'modelling' | 'optional';

export interface VideoNeedRule {
  need: VideoNeed;
  ruleId: string;
  /** Orden entre los opcionales (0 = primero en recibir video por presupuesto). Los que lo exigen: -1. */
  priority: number;
  text: string;
}

/** Tabla de datos (v1): tipo de aprendizaje → necesidad audiovisual. Cambiarla = subir VIDEO_COMPOSITION_VERSION. */
export const VIDEO_NEED_BY_LEARNING_TYPE: Readonly<Record<LearningType, VideoNeedRule>> = Object.freeze({
  procedimental: Object.freeze({ need: 'demonstration', ruleId: 'vid.need.demonstration', priority: -1, text: 'Procedimiento: se aprende viendo la demostración paso a paso.' }),
  protocolo: Object.freeze({ need: 'demonstration', ruleId: 'vid.need.protocol', priority: -1, text: 'Protocolo: la secuencia y los puntos críticos se modelan en video.' }),
  comunicacion: Object.freeze({ need: 'modelling', ruleId: 'vid.need.modelling', priority: -1, text: 'Comunicación: la conducta esperada se modela con un ejemplo hablado.' }),
  decision_caso: Object.freeze({ need: 'optional', ruleId: 'vid.optional.case', priority: 0, text: 'Decisión / caso: el video ayuda a presentar el caso, pero no es imprescindible.' }),
  normativo_etico: Object.freeze({ need: 'optional', ruleId: 'vid.optional.normative', priority: 1, text: 'Normativo / ético: se trabaja sobre todo con lectura y casos; el video es opcional.' }),
  conceptual: Object.freeze({ need: 'optional', ruleId: 'vid.optional.conceptual', priority: 2, text: 'Conceptual: el texto, la presentación y la actividad bastan; el video es opcional.' }),
});

export const VIDEO_COMPOSITION_RULES = Object.freeze({
  version: VIDEO_COMPOSITION_VERSION,
  /** Presupuesto de los opcionales: 1 video cada N horas de carga declarada (constante de producto, sin calibrar). */
  hoursPerBudgetVideo: 5,
});

export interface VideoCompositionChapter {
  chapterId: string;
  /** Orden global del capítulo de contenido en el curso (0…n-1): desempata y fija qué opcional va primero. */
  order: number;
  learningType: LearningType;
  /** Video fijado por el docente (undefined = lo decide Cursia). */
  pinned?: boolean;
}

export interface VideoCompositionInput {
  chapters: VideoCompositionChapter[];
  targetHours: number;
  /** Prioridad audiovisual de «Ajustar» (null = sin preferencia explícita). */
  audiovisual: 'less' | 'recommended' | 'more' | null;
  /** Requisito obligatorio del documento: video en todos (true) o en ninguno (false). */
  documentVideo: boolean | null;
  minVideos?: number;
  maxVideos?: number;
}

export interface VideoDecision {
  chapterId: string;
  enabled: boolean;
  need: VideoNeed;
  learningType: LearningType;
  ruleId: string;
  reason: string;
}

export interface VideoCompositionResult {
  version: typeof VIDEO_COMPOSITION_VERSION;
  decisions: VideoDecision[];
  /** Tope de videos del presupuesto de horas (solo informa cómo se decidieron los opcionales). */
  hoursBudgetVideos: number;
  counts: { contentChapters: number; videos: number; byNeed: number; optional: number; pinned: number };
  /** Restricciones explícitas que no se pudieron cumplir (lo fijado o el documento mandan): texto para el docente. */
  unmet: string[];
}

export class VideoCompositionError extends Error {
  readonly code = 'VIDEO_COMPOSITION_INVALID';
  constructor(message: string) {
    super(`VIDEO_COMPOSITION_INVALID: ${message}`);
    this.name = 'VideoCompositionError';
  }
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 500;

/** Decide el video de cada capítulo de contenido. Pura y determinista. */
export function decideVideosByNeed(input: VideoCompositionInput): VideoCompositionResult {
  if (!input || !Array.isArray(input.chapters)) throw new VideoCompositionError('se necesita la lista de capítulos de contenido');
  if (!(typeof input.targetHours === 'number' && input.targetHours > 0)) throw new VideoCompositionError(`targetHours inválido (${JSON.stringify(input.targetHours)})`);
  if (input.minVideos !== undefined && !isCount(input.minVideos)) throw new VideoCompositionError(`minVideos inválido (${JSON.stringify(input.minVideos)})`);
  if (input.maxVideos !== undefined && !isCount(input.maxVideos)) throw new VideoCompositionError(`maxVideos inválido (${JSON.stringify(input.maxVideos)})`);
  if (input.minVideos !== undefined && input.maxVideos !== undefined && input.minVideos > input.maxVideos) {
    throw new VideoCompositionError(`minVideos (${input.minVideos}) mayor que maxVideos (${input.maxVideos})`);
  }
  const chapters = [...input.chapters].sort((a, b) => a.order - b.order);
  const ids = new Set<string>();
  for (const c of chapters) {
    if (ids.has(c.chapterId)) throw new VideoCompositionError(`capítulo repetido ${c.chapterId}`);
    ids.add(c.chapterId);
    if (!VIDEO_NEED_BY_LEARNING_TYPE[c.learningType]) throw new VideoCompositionError(`tipo de aprendizaje desconocido ${JSON.stringify(c.learningType)}`);
  }
  const budget = Math.floor(input.targetHours / VIDEO_COMPOSITION_RULES.hoursPerBudgetVideo);
  const out = new Map<string, VideoDecision>();
  const set = (c: VideoCompositionChapter, enabled: boolean, ruleId: string, reason: string) => {
    const r = VIDEO_NEED_BY_LEARNING_TYPE[c.learningType];
    out.set(c.chapterId, { chapterId: c.chapterId, enabled, need: r.need, learningType: c.learningType, ruleId, reason });
  };
  const free: VideoCompositionChapter[] = [];
  for (const c of chapters) {
    const r = VIDEO_NEED_BY_LEARNING_TYPE[c.learningType];
    if (c.pinned !== undefined) set(c, c.pinned, 'vid.pinned', c.pinned ? 'El docente fijó el video de este capítulo.' : 'El docente fijó este capítulo sin video.');
    else if (input.documentVideo !== null) set(c, input.documentVideo, 'vid.document', input.documentVideo ? 'El documento exige video en cada capítulo de contenido.' : 'El documento pide un curso sin videos.');
    else {
      free.push(c);
      if (r.need !== 'optional') set(c, true, r.ruleId, r.text);
      else set(c, false, r.ruleId, r.text);
    }
  }
  const total = () => [...out.values()].filter((d) => d.enabled).length;
  // Opcionales en orden: prioridad del tipo, después posición en el curso.
  const optional = free.filter((c) => VIDEO_NEED_BY_LEARNING_TYPE[c.learningType].need === 'optional')
    .sort((a, b) => VIDEO_NEED_BY_LEARNING_TYPE[a.learningType].priority - VIDEO_NEED_BY_LEARNING_TYPE[b.learningType].priority || a.order - b.order);
  if (input.audiovisual === 'more') {
    for (const c of optional) set(c, true, 'vid.optional.more', `${VIDEO_NEED_BY_LEARNING_TYPE[c.learningType].text} Con la prioridad audiovisual «Más», lleva video.`);
  } else if (input.audiovisual === 'less') {
    for (const c of optional) set(c, false, 'vid.optional.less', `${VIDEO_NEED_BY_LEARNING_TYPE[c.learningType].text} Con la prioridad audiovisual «Menos», solo llevan video los capítulos que lo necesitan.`);
  } else {
    for (const c of optional) {
      if (total() < budget) set(c, true, 'vid.optional.hours_budget', `${VIDEO_NEED_BY_LEARNING_TYPE[c.learningType].text} Las horas del curso alcanzan para un video más (hasta ${budget} videos en ${String(input.targetHours).replace('.', ',')} h).`);
      else set(c, false, 'vid.optional.no_budget', `${VIDEO_NEED_BY_LEARNING_TYPE[c.learningType].text} El presupuesto de videos de las horas del curso (${budget}) ya lo usan capítulos que lo necesitan más.`);
    }
  }
  const unmet: string[] = [];
  if (input.minVideos !== undefined && total() < input.minVideos) {
    // Primero los opcionales (en su orden), después cualquier capítulo libre sin video.
    const order = [...optional, ...free.filter((c) => !optional.includes(c))];
    for (const c of order) {
      if (total() >= input.minVideos) break;
      if (out.get(c.chapterId)!.enabled) continue;
      set(c, true, 'vid.min_videos', `El curso pide al menos ${input.minVideos} videos: este capítulo completa el mínimo.`);
    }
    if (total() < input.minVideos) unmet.push(`El curso pide al menos ${input.minVideos} videos y solo ${total()} capítulos pueden llevarlo (lo fijado por el docente o el documento manda).`);
  }
  if (input.maxVideos !== undefined && total() > input.maxVideos) {
    // Se quitan primero los opcionales (los últimos en recibirlo), después los que lo necesitan (desde el final del curso).
    const needOrder = free.filter((c) => VIDEO_NEED_BY_LEARNING_TYPE[c.learningType].need !== 'optional').sort((a, b) => b.order - a.order);
    for (const c of [...[...optional].reverse(), ...needOrder]) {
      if (total() <= input.maxVideos) break;
      if (!out.get(c.chapterId)!.enabled) continue;
      set(c, false, 'vid.max_videos', `El curso admite como máximo ${input.maxVideos} videos: este capítulo queda sin video (primero se quitan los opcionales y después los últimos del curso).`);
    }
    if (total() > input.maxVideos) unmet.push(`El curso admite como máximo ${input.maxVideos} videos y ${total()} están fijados por el docente o exigidos por el documento.`);
  }
  const decisions = chapters.map((c) => out.get(c.chapterId)!);
  return {
    version: VIDEO_COMPOSITION_VERSION,
    decisions,
    hoursBudgetVideos: budget,
    counts: {
      contentChapters: decisions.length,
      videos: decisions.filter((d) => d.enabled).length,
      byNeed: decisions.filter((d) => d.enabled && d.need !== 'optional').length,
      optional: decisions.filter((d) => d.enabled && d.need === 'optional').length,
      pinned: decisions.filter((d) => d.ruleId === 'vid.pinned').length,
    },
    unmet,
  };
}
