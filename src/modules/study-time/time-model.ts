// Motor de carga horaria — Loop 1: modelo de tiempo DETERMINISTA (fuente única de verdad).
//
// Cuánto tarda un estudiante típico en estudiar cada recurso del curso. Lo decide Cursia con reglas fijas
// y versionadas; la IA nunca decide minutos. Los mismos números sirven antes de generar (valores
// PLANIFICADOS, calibrados con cursos reales de staging) y al empaquetar (valores MEDIDOS: palabras,
// diapositivas, duración del video, preguntas de cada examen).
//
// Calibración (Fase 0, cursos #542, #583 y #616 de staging): página del capítulo ~2.200 palabras,
// Libro Guía ~2.900 palabras por capítulo, 10 diapositivas, video ~600 s, 7–9 preguntas por actividad,
// 8–10 tarjetas de repaso, bienvenida + ruta + cierre ~950 palabras, audio de bienvenida ~1 min.
// Estudiante típico: lectura de estudio a 150 palabras/min; 1,2 min por pregunta situacional.
//
// El audiolibro NO suma: es otra forma de recorrer el Libro Guía (escucharlo o leerlo, no ambos).
import { examSlotSplit, finalExamSlotSplit } from '../course-shell/exam-bank';
import { APPLICATION_ACTIVITY_TIERS } from './application-tiers';
import { GUIDED_PRACTICE_TIERS } from './guided-practice-tiers';
import { reflectionPauseCount, videoInteractionCount } from '../../package/h5p/interactive-video/plan';
import { DEFAULT_TIME_MODEL_CONFIG, HourCategory, TimeModelConfig, TimeModelRateKey } from './time-model-config';

export const STUDY_TIME_RULES_VERSION = 1 as const;

export const STUDY_TIME_RULES = Object.freeze({
  rulesVersion: STUDY_TIME_RULES_VERSION,
  // r58 (I3): las tasas viven en la configuración del modelo de tiempo (time-model-config.ts); estas claves son las del
  // DEFAULT (mismos valores de siempre) para quien las lee directo.
  ...DEFAULT_TIME_MODEL_CONFIG.rates,
  /** Niveles de la Actividad de aplicación (Fase 2): los fija Cursia, nunca la IA. */
  applicationActivityTiers: APPLICATION_ACTIVITY_TIERS,
  /** Loop 9 B · Niveles de la práctica guiada del capítulo (formativa, sin nota): los fija Cursia, nunca la IA. */
  guidedPracticeTiers: GUIDED_PRACTICE_TIERS,
  /** Valores planificados (antes de generar), calibrados con cursos reales. */
  planned: Object.freeze({
    chapterPageWords: 2200,
    /** Capítulo de práctica: página de práctica guiada (resumen mínimo + consignas), sin Libro propio. */
    practicePageWords: 900,
    libroChapterWords: 2900,
    slides: 10,
    videoSeconds: 600,
    activityItems: 8,
    reviewCards: 9,
    courseFrameWords: 950,
    moduleIntroWords: 450,
    welcomeAudioSeconds: 60,
  }),
  /** El tiempo del capítulo se muestra redondeado a 5 min (mínimo 5). */
  chapterDisplayRoundTo: 5,
  chapterDisplayMin: 5,
});

export type StudyTimeResourceKind =
  | 'course_frame'
  | 'welcome_audio'
  | 'forum'
  | 'module_intro'
  | 'chapter_page'
  | 'practice_page'
  | 'libro'
  | 'presentation'
  | 'video'
  | 'video_interactions'
  | 'activity'
  | 'review'
  | 'application_activity'
  | 'guided_practice'
  | 'module_exam'
  | 'final_exam';

/** Componente del tiempo (para explicar de dónde salen las horas). */
export type StudyTimeComponent = 'course' | 'content' | 'practice' | 'review' | 'application' | 'assessment';

const COMPONENT_OF: Readonly<Record<StudyTimeResourceKind, StudyTimeComponent>> = Object.freeze({
  course_frame: 'course',
  welcome_audio: 'course',
  forum: 'course',
  module_intro: 'course',
  chapter_page: 'content',
  practice_page: 'practice',
  libro: 'content',
  presentation: 'content',
  video: 'content',
  video_interactions: 'practice',
  activity: 'practice',
  review: 'review',
  application_activity: 'application',
  // Loop 9 B: formativa (no es una Actividad de Aplicación) → «Práctica y repaso».
  guided_practice: 'practice',
  module_exam: 'assessment',
  final_exam: 'assessment',
});

export interface StudyTimeResource {
  resource: StudyTimeResourceKind;
  component: StudyTimeComponent;
  /** Minutos exactos (2 decimales). */
  minutes: number;
  /** Cómo se calculó (texto para el docente). */
  basis: string;
  /** true = dato medido del curso generado; false = valor planificado. */
  measured: boolean;
}

/** Un capítulo: qué recursos tiene y, si ya existen, sus medidas. */
export interface StudyTimeChapterInput {
  chapterId: string;
  /** 'practice' = capítulo de práctica (página de práctica guiada); ausente = 'content'. */
  kind?: 'content' | 'practice';
  /** Palabras que el estudiante lee en la página del capítulo (medidas). Ausente = planificado. */
  pageWords?: number;
  libro: boolean;
  libroWords?: number;
  presentation: boolean;
  slides?: number;
  video: boolean;
  videoSeconds?: number;
  /** Video interactivo avanzado (H5P v2): suma las pausas de reflexión del plan. */
  ivAdvanced?: boolean;
  activity: boolean;
  activityItems?: number;
  review: boolean;
  reviewCards?: number;
  /** Fase 2: minutos de la Actividad de aplicación; debe ser uno de los niveles. */
  applicationMinutes?: number;
  /** Loop 9 B: minutos de la práctica guiada (solo capítulos de contenido); debe ser uno de los niveles. */
  guidedPracticeMinutes?: number;
}

export interface StudyTimeModuleInput {
  moduleId: string;
  /** El módulo tiene página de apertura (module_intro). */
  intro: boolean;
  introWords?: number;
  exam: boolean;
  /** Preguntas que ve el estudiante (medidas). Ausente = plan de slots del banco. */
  examQuestions?: number;
  chapters: StudyTimeChapterInput[];
}

export interface StudyTimeCourseInput {
  /** Bienvenida, ruta de aprendizaje y cierre del curso. */
  frame: boolean;
  frameWords?: number;
  welcomeAudio: boolean;
  welcomeAudioSeconds?: number;
  forum: boolean;
  finalExam: boolean;
  finalExamQuestions?: number;
  modules: StudyTimeModuleInput[];
}

export interface StudyTimeChapterEstimate {
  chapterId: string;
  /** Minutos exactos del capítulo (2 decimales). */
  chapterEstimatedMinutes: number;
  /** Lo que se muestra: redondeado a 5 (mínimo 5). */
  displayMinutes: number;
  resources: StudyTimeResource[];
}

export interface StudyTimeModuleEstimate {
  moduleId: string;
  /** Minutos exactos del módulo: apertura + capítulos + examen (2 decimales). */
  moduleEstimatedMinutes: number;
  resources: StudyTimeResource[];
  chapters: StudyTimeChapterEstimate[];
}

export interface StudyTimeEstimate {
  rulesVersion: typeof STUDY_TIME_RULES_VERSION;
  /** Minutos exactos del curso (2 decimales). */
  courseEstimatedMinutes: number;
  /** Horas con 1 decimal. */
  courseEstimatedHours: number;
  /** Recursos de nivel curso (bienvenida, foro, examen final). */
  resources: StudyTimeResource[];
  modules: StudyTimeModuleEstimate[];
  /** Minutos por componente (para explicar de dónde salen las horas). */
  byComponent: Record<StudyTimeComponent, number>;
  /**
   * true si al menos un recurso NO es una medida del curso generado: valor planificado o minutos declarados (nivel de
   * la Actividad de Aplicación, de la práctica guiada, constante del foro). r58 (I3): antes excluía los declarados y un
   * curso hecho sobre todo de niveles podía informar `false` (falsa medición). El desglose exacto está en el registro de
   * horas (`hours-ledger.ts`: base measured / estimated_with_evidence / declared).
   */
  usesPlannedValues: boolean;
  /** r58 (I3): SOLO con una configuración propia del modelo de tiempo (sin ella, la clave no existe: salida de siempre). */
  configId?: string;
}

export class StudyTimeError extends Error {
  readonly code = 'STUDY_TIME_INPUT_INVALID';
  constructor(message: string) {
    super(`STUDY_TIME_INPUT_INVALID: ${message}`);
    this.name = 'StudyTimeError';
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => String(r2(n)).replace('.', ',');

/** r58 (I3): base de una línea del registro de horas. */
export type HourBasis = 'measured' | 'estimated_with_evidence' | 'declared';

/** r58 (I3): de dónde sale la cantidad de una línea. */
export interface HourEvidence {
  /** Cantidad contada (palabras, diapositivas, segundos, preguntas, tarjetas) o el nivel/constante declarado. */
  quantity: number;
  unit: 'palabras' | 'diapositivas' | 'segundos' | 'interacciones' | 'preguntas' | 'tarjetas' | 'minutos_nivel' | 'minutos_constante';
  /** Tasa aplicada (null = la cantidad ya es tiempo). */
  rate: number | null;
  rateUnit: string | null;
  /** measured = contada en el artifact; planned = valor planificado calibrado; design = nivel del diseño; constant = constante del modelo. */
  source: 'measured' | 'planned' | 'design' | 'constant';
  /** Solo valores planificados: de dónde sale la calibración. */
  calibration?: string;
  /** Solo niveles: minutos acreditados si la configuración los cambia (ausente = el nivel mismo). */
  creditedMinutes?: number;
}

/** r58 (I3): una línea del registro de horas (una por recurso del curso). */
export interface HourLine {
  /** `${recurso}:${capítulo | módulo | 'course'}` (estable; no es la key del Manifest). */
  activityKey: string;
  resource: StudyTimeResourceKind;
  moduleId: string | null;
  chapterId: string | null;
  category: HourCategory;
  minutes: number;
  basis: HourBasis;
  evidence: HourEvidence;
  /** Regla del modelo que produjo los minutos (`st.<regla>@<rulesVersion>`). */
  ruleId: string;
  /** Configuración que puso la tasa de esta línea (el id propio solo si esa regla se cambió). */
  configId: string;
}

/** r58 (I3): categoría del registro de cada recurso (fija; el mapeo a componentes del documento es configurable). */
export const HOUR_CATEGORY_OF: Readonly<Record<StudyTimeResourceKind, HourCategory>> = Object.freeze({
  // Orientación del curso (bienvenida, ruta, cierre, audio de bienvenida, aperturas de módulo) y foro: «foro y otros».
  course_frame: 'foro_otros',
  welcome_audio: 'foro_otros',
  forum: 'foro_otros',
  module_intro: 'foro_otros',
  chapter_page: 'estudio_contenido',
  presentation: 'estudio_contenido',
  libro: 'lectura',
  video: 'video',
  // Las preguntas y pausas viven DENTRO del video interactivo.
  video_interactions: 'video',
  practice_page: 'practica_guiada',
  guided_practice: 'practica_guiada',
  activity: 'practica_autonoma',
  review: 'practica_autonoma',
  application_activity: 'entregable',
  module_exam: 'evaluacion',
  final_exam: 'evaluacion',
});

const CALIBRATION = 'valor planificado calibrado con cursos de staging #542, #583 y #616 (Fase 0)';

interface LineMeta {
  quantity: number;
  unit: HourEvidence['unit'];
  rate: number | null;
  rateUnit: string | null;
  measured: boolean;
  /** Clave de la tasa (para el configId) o el nivel (tiers). */
  rateKey?: TimeModelRateKey;
  tier?: { kind: 'application' | 'guided'; value: number };
  rule: string;
}

interface Ctx {
  cfg: TimeModelConfig;
  lines: HourLine[] | null;
  moduleId: string | null;
  chapterId: string | null;
}

function measure(v: number | undefined, planned: number, what: string, opts: { integer?: boolean; allowZero?: boolean } = {}): { value: number; measured: boolean } {
  // Solo `undefined` es «no medido»: un null (u otro valor) es una medida rota y falla fuerte.
  if (v === undefined) return { value: planned, measured: false };
  const okNum = typeof v === 'number' && Number.isFinite(v) && (opts.allowZero ? v >= 0 : v > 0) && (!opts.integer || Number.isInteger(v));
  if (!okNum) throw new StudyTimeError(`${what} inválido (${JSON.stringify(v)})`);
  return { value: v, measured: true };
}

function res(ctx: Ctx, resource: StudyTimeResourceKind, minutes: number, basis: string, meta: LineMeta): StudyTimeResource {
  const r: StudyTimeResource = { resource, component: COMPONENT_OF[resource], minutes: r2(minutes), basis, measured: meta.measured };
  if (ctx.lines) {
    const cfg = ctx.cfg;
    const overriddenRule = meta.tier
      ? (meta.tier.kind === 'application' ? cfg.overridden.applicationTiers : cfg.overridden.guidedPracticeTiers).includes(meta.tier.value)
      : meta.rateKey !== undefined && cfg.overridden.rates.includes(meta.rateKey);
    const declared = !!meta.tier || resource === 'forum';
    const credited = meta.tier && r.minutes !== meta.tier.value ? { creditedMinutes: r.minutes } : {};
    ctx.lines.push({
      activityKey: `${resource}:${ctx.chapterId ?? ctx.moduleId ?? 'course'}`,
      resource,
      moduleId: ctx.moduleId,
      chapterId: ctx.chapterId,
      category: HOUR_CATEGORY_OF[resource],
      minutes: r.minutes,
      basis: declared ? 'declared' : meta.measured ? 'measured' : 'estimated_with_evidence',
      evidence: {
        quantity: meta.quantity,
        unit: meta.unit,
        rate: meta.rate,
        rateUnit: meta.rateUnit,
        source: meta.tier ? 'design' : resource === 'forum' ? 'constant' : meta.measured ? 'measured' : 'planned',
        ...(!declared && !meta.measured ? { calibration: CALIBRATION } : {}),
        ...credited,
      },
      ruleId: `st.${meta.rule}@${STUDY_TIME_RULES_VERSION}`,
      configId: overriddenRule ? cfg.id : DEFAULT_TIME_MODEL_CONFIG.id,
    });
  }
  return r;
}

function readingResource(ctx: Ctx, kind: StudyTimeResourceKind, words: { value: number; measured: boolean }): StudyTimeResource {
  const wpm = ctx.cfg.rates.readingWordsPerMinute;
  return res(ctx, kind, words.value / wpm, `${words.value} palabras / ${wpm} por min`, {
    quantity: words.value, unit: 'palabras', rate: wpm, rateUnit: 'palabras/min', measured: words.measured, rateKey: 'readingWordsPerMinute', rule: `read.${kind}`,
  });
}

function chapterDetailed(ch: StudyTimeChapterInput, ctx: Ctx): StudyTimeChapterEstimate {
  const R = STUDY_TIME_RULES;
  const K = ctx.cfg.rates;
  const P = R.planned;
  if (!ch || typeof ch.chapterId !== 'string' || !ch.chapterId) throw new StudyTimeError('capítulo sin chapterId');
  const c: Ctx = { ...ctx, chapterId: ch.chapterId };
  const where = `capítulo ${ch.chapterId}`;
  const out: StudyTimeResource[] = [];
  if (ch.kind !== undefined && ch.kind !== 'content' && ch.kind !== 'practice') throw new StudyTimeError(`kind del ${where} inválido (${JSON.stringify(ch.kind)})`);
  const practice = ch.kind === 'practice';
  out.push(readingResource(c, practice ? 'practice_page' : 'chapter_page', measure(ch.pageWords, practice ? P.practicePageWords : P.chapterPageWords, `pageWords del ${where}`, { integer: true })));
  if (ch.libro) out.push(readingResource(c, 'libro', measure(ch.libroWords, P.libroChapterWords, `libroWords del ${where}`, { integer: true })));
  if (ch.presentation) {
    const s = measure(ch.slides, P.slides, `slides del ${where}`, { integer: true });
    out.push(res(c, 'presentation', s.value * K.minutesPerSlide, `${s.value} diapositivas × ${fmt(K.minutesPerSlide)} min`, {
      quantity: s.value, unit: 'diapositivas', rate: K.minutesPerSlide, rateUnit: 'min/diapositiva', measured: s.measured, rateKey: 'minutesPerSlide', rule: 'slides',
    }));
  }
  if (ch.video) {
    const v = measure(ch.videoSeconds, P.videoSeconds, `videoSeconds del ${where}`);
    out.push(res(c, 'video', v.value / 60, `${Math.round(v.value)} s de video`, {
      quantity: v.value, unit: 'segundos', rate: null, rateUnit: null, measured: v.measured, rule: 'video.duration',
    }));
    // Mismo plan que el empaque: clamp(round(d/100), 3, 8) preguntas + pausas de reflexión (H5P v2).
    let q: number;
    let p: number;
    try {
      q = videoInteractionCount(v.value);
      p = ch.ivAdvanced ? reflectionPauseCount(v.value) : 0;
    } catch (e) {
      throw new StudyTimeError(`videoSeconds del ${where}: ${(e as Error).message}`);
    }
    out.push(res(c, 'video_interactions', (q + p) * K.minutesPerVideoInteraction, `${q} preguntas + ${p} pausas × ${fmt(K.minutesPerVideoInteraction)} min`, {
      quantity: q + p, unit: 'interacciones', rate: K.minutesPerVideoInteraction, rateUnit: 'min/interacción', measured: v.measured, rateKey: 'minutesPerVideoInteraction', rule: 'video.interactions',
    }));
  }
  if (ch.activity) {
    const a = measure(ch.activityItems, P.activityItems, `activityItems del ${where}`, { integer: true });
    out.push(res(c, 'activity', a.value * K.minutesPerActivityItem, `${a.value} preguntas × ${fmt(K.minutesPerActivityItem)} min`, {
      quantity: a.value, unit: 'preguntas', rate: K.minutesPerActivityItem, rateUnit: 'min/pregunta', measured: a.measured, rateKey: 'minutesPerActivityItem', rule: 'activity.items',
    }));
  }
  if (ch.review) {
    const cc = measure(ch.reviewCards, P.reviewCards, `reviewCards del ${where}`, { integer: true });
    out.push(res(c, 'review', cc.value * K.minutesPerReviewCard, `${cc.value} tarjetas × ${fmt(K.minutesPerReviewCard)} min`, {
      quantity: cc.value, unit: 'tarjetas', rate: K.minutesPerReviewCard, rateUnit: 'min/tarjeta', measured: cc.measured, rateKey: 'minutesPerReviewCard', rule: 'review.cards',
    }));
  }
  if (ch.applicationMinutes !== undefined) {
    if (!(R.applicationActivityTiers as readonly number[]).includes(ch.applicationMinutes)) {
      throw new StudyTimeError(`applicationMinutes del ${where} debe ser uno de ${R.applicationActivityTiers.join('/')} (fue ${JSON.stringify(ch.applicationMinutes)})`);
    }
    const credited = ctx.cfg.applicationTierMinutes[ch.applicationMinutes];
    out.push(res(c, 'application_activity', credited, credited === ch.applicationMinutes ? `nivel de ${ch.applicationMinutes} min fijado por Cursia` : `nivel de ${ch.applicationMinutes} min (acreditados ${fmt(credited)} min por la configuración ${ctx.cfg.id})`, {
      quantity: ch.applicationMinutes, unit: 'minutos_nivel', rate: null, rateUnit: null, measured: false, tier: { kind: 'application', value: ch.applicationMinutes }, rule: 'tier.application',
    }));
  }
  if (ch.guidedPracticeMinutes !== undefined) {
    if (!(R.guidedPracticeTiers as readonly number[]).includes(ch.guidedPracticeMinutes)) {
      throw new StudyTimeError(`guidedPracticeMinutes del ${where} debe ser uno de ${R.guidedPracticeTiers.join('/')} (fue ${JSON.stringify(ch.guidedPracticeMinutes)})`);
    }
    if (practice) throw new StudyTimeError(`el ${where} es de práctica: los ejercicios guiados son solo de los capítulos de contenido`);
    const credited = ctx.cfg.guidedPracticeTierMinutes[ch.guidedPracticeMinutes];
    out.push(res(c, 'guided_practice', credited, credited === ch.guidedPracticeMinutes ? `ejercicios guiados de ${ch.guidedPracticeMinutes} min fijados por Cursia` : `ejercicios guiados de ${ch.guidedPracticeMinutes} min (acreditados ${fmt(credited)} min por la configuración ${ctx.cfg.id})`, {
      quantity: ch.guidedPracticeMinutes, unit: 'minutos_nivel', rate: null, rateUnit: null, measured: false, tier: { kind: 'guided', value: ch.guidedPracticeMinutes }, rule: 'tier.guided_practice',
    }));
  }
  const chapterEstimatedMinutes = r2(out.reduce((a, x) => a + x.minutes, 0));
  return { chapterId: ch.chapterId, chapterEstimatedMinutes, displayMinutes: displayChapterMinutes(chapterEstimatedMinutes), resources: out };
}

/** Minutos de un capítulo, recurso por recurso. Determinista. `config` ausente = el default (valores de siempre). */
export function estimateChapterStudyTime(ch: StudyTimeChapterInput, config: TimeModelConfig = DEFAULT_TIME_MODEL_CONFIG): StudyTimeChapterEstimate {
  return chapterDetailed(ch, { cfg: config, lines: null, moduleId: null, chapterId: null });
}

/** Redondeo para mostrar el tiempo de un capítulo (a 5 min, mínimo 5). */
export function displayChapterMinutes(minutes: number): number {
  const R = STUDY_TIME_RULES;
  return Math.max(R.chapterDisplayMin, Math.round(minutes / R.chapterDisplayRoundTo) * R.chapterDisplayRoundTo);
}

function courseDetailed(input: StudyTimeCourseInput, cfg: TimeModelConfig, lines: HourLine[] | null): StudyTimeEstimate {
  const R = STUDY_TIME_RULES;
  const K = cfg.rates;
  const P = R.planned;
  if (!input || !Array.isArray(input.modules) || input.modules.length === 0) throw new StudyTimeError('el curso necesita al menos un módulo');
  const cc: Ctx = { cfg, lines, moduleId: null, chapterId: null };
  const course: StudyTimeResource[] = [];
  if (input.frame) course.push(readingResource(cc, 'course_frame', measure(input.frameWords, P.courseFrameWords, 'frameWords', { integer: true })));
  if (input.welcomeAudio) {
    const a = measure(input.welcomeAudioSeconds, P.welcomeAudioSeconds, 'welcomeAudioSeconds');
    course.push(res(cc, 'welcome_audio', a.value / 60, `${Math.round(a.value)} s de audio`, { quantity: a.value, unit: 'segundos', rate: null, rateUnit: null, measured: a.measured, rule: 'audio.welcome' }));
  }
  if (input.forum) {
    course.push(res(cc, 'forum', K.forumMinutes, `${fmt(K.forumMinutes)} min de participación`, {
      quantity: K.forumMinutes, unit: 'minutos_constante', rate: null, rateUnit: null, measured: false, rateKey: 'forumMinutes', rule: 'forum.constant',
    }));
  }

  const seenChapters = new Set<string>();
  const modules: StudyTimeModuleEstimate[] = input.modules.map((m) => {
    if (!m || typeof m.moduleId !== 'string' || !m.moduleId) throw new StudyTimeError('módulo sin moduleId');
    if (!Array.isArray(m.chapters) || m.chapters.length === 0) throw new StudyTimeError(`el módulo ${m.moduleId} no tiene capítulos`);
    const mc: Ctx = { ...cc, moduleId: m.moduleId };
    const mr: StudyTimeResource[] = [];
    if (m.intro) mr.push(readingResource(mc, 'module_intro', measure(m.introWords, P.moduleIntroWords, `introWords del módulo ${m.moduleId}`, { integer: true })));
    const chapters = m.chapters.map((c) => {
      if (seenChapters.has(c?.chapterId)) throw new StudyTimeError(`capítulo repetido ${c.chapterId}`);
      seenChapters.add(c?.chapterId);
      return chapterDetailed(c, mc);
    });
    if (m.exam) {
      // Las preguntas salen del texto de los capítulos de CONTENIDO (el de práctica no tiene texto propio).
      const contentCount = m.chapters.filter((c) => c.kind !== 'practice').length;
      if (contentCount === 0) throw new StudyTimeError(`el módulo ${m.moduleId} tiene examen pero ningún capítulo de contenido`);
      const q = measure(m.examQuestions, examSlotSplit(contentCount).total, `examQuestions del módulo ${m.moduleId}`, { integer: true });
      mr.push(res(mc, 'module_exam', q.value * K.minutesPerExamQuestion, `${q.value} preguntas × ${fmt(K.minutesPerExamQuestion)} min`, {
        quantity: q.value, unit: 'preguntas', rate: K.minutesPerExamQuestion, rateUnit: 'min/pregunta', measured: q.measured, rateKey: 'minutesPerExamQuestion', rule: 'exam.questions',
      }));
    }
    const moduleEstimatedMinutes = r2(mr.reduce((a, x) => a + x.minutes, 0) + chapters.reduce((a, c) => a + c.chapterEstimatedMinutes, 0));
    return { moduleId: m.moduleId, moduleEstimatedMinutes, resources: mr, chapters };
  });
  if (input.finalExam) {
    const contentTotal = input.modules.reduce((n, m) => n + m.chapters.filter((c) => c.kind !== 'practice').length, 0);
    const q = measure(input.finalExamQuestions, finalExamSlotSplit(contentTotal).total, 'finalExamQuestions', { integer: true });
    course.push(res(cc, 'final_exam', q.value * K.minutesPerExamQuestion, `${q.value} preguntas × ${fmt(K.minutesPerExamQuestion)} min`, {
      quantity: q.value, unit: 'preguntas', rate: K.minutesPerExamQuestion, rateUnit: 'min/pregunta', measured: q.measured, rateKey: 'minutesPerExamQuestion', rule: 'exam.final_questions',
    }));
  }

  const all: StudyTimeResource[] = [...course, ...modules.flatMap((m) => [...m.resources, ...m.chapters.flatMap((c) => c.resources)])];
  const byComponent: Record<StudyTimeComponent, number> = { course: 0, content: 0, practice: 0, review: 0, application: 0, assessment: 0 };
  for (const x of all) byComponent[x.component] += x.minutes;
  for (const k of Object.keys(byComponent) as StudyTimeComponent[]) byComponent[k] = r2(byComponent[k]);
  const courseEstimatedMinutes = r2(all.reduce((a, x) => a + x.minutes, 0));
  return {
    rulesVersion: STUDY_TIME_RULES_VERSION,
    courseEstimatedMinutes,
    courseEstimatedHours: Math.round((courseEstimatedMinutes / 60) * 10) / 10,
    resources: course,
    modules,
    byComponent,
    // r58 (I3) fix: un nivel declarado (AA, práctica guiada) o la constante del foro NO es una medida.
    usesPlannedValues: all.some((x) => !x.measured),
    ...(cfg.id !== DEFAULT_TIME_MODEL_CONFIG.id ? { configId: cfg.id } : {}),
  };
}

/** Tiempo de estudio de todo el curso: recursos de curso + módulos + capítulos. Determinista. `config` ausente = default. */
export function estimateCourseStudyTime(input: StudyTimeCourseInput, config: TimeModelConfig = DEFAULT_TIME_MODEL_CONFIG): StudyTimeEstimate {
  return courseDetailed(input, config, null);
}

/**
 * r58 (I3): la misma estimación + el registro de horas (una línea por recurso, en el orden de `estimate`: curso, y por
 * módulo apertura → capítulos → examen; el examen final al final del curso). Las líneas suman exactamente
 * `estimate.courseEstimatedMinutes` (mismos minutos redondeados a 2 decimales).
 */
export function estimateCourseStudyTimeDetailed(input: StudyTimeCourseInput, config: TimeModelConfig = DEFAULT_TIME_MODEL_CONFIG): { estimate: StudyTimeEstimate; lines: HourLine[] } {
  const lines: HourLine[] = [];
  const estimate = courseDetailed(input, config, lines);
  return { estimate, lines };
}
