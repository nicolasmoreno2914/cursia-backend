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
import { reflectionPauseCount, videoInteractionCount } from '../../package/h5p/interactive-video/plan';

export const STUDY_TIME_RULES_VERSION = 1 as const;

export const STUDY_TIME_RULES = Object.freeze({
  rulesVersion: STUDY_TIME_RULES_VERSION,
  /** Lectura de estudio (no lectura rápida) de un estudiante típico. */
  readingWordsPerMinute: 150,
  minutesPerSlide: 0.6,
  /** Cada pregunta y cada pausa de reflexión del video interactivo. */
  minutesPerVideoInteraction: 1,
  /** Cada pregunta o ítem de la actividad del capítulo (H5P o SCORM). */
  minutesPerActivityItem: 1.2,
  minutesPerReviewCard: 0.5,
  minutesPerExamQuestion: 1.2,
  /** Presentarse y participar en el foro del curso. */
  forumMinutes: 10,
  /** Niveles de la Actividad de aplicación (Fase 2): los fija Cursia, nunca la IA. */
  applicationActivityTiers: Object.freeze([30, 60, 90, 120] as const),
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
  /** true si al menos un recurso usó un valor planificado. */
  usesPlannedValues: boolean;
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

function measure(v: number | undefined, planned: number, what: string, opts: { integer?: boolean; allowZero?: boolean } = {}): { value: number; measured: boolean } {
  // Solo `undefined` es «no medido»: un null (u otro valor) es una medida rota y falla fuerte.
  if (v === undefined) return { value: planned, measured: false };
  const okNum = typeof v === 'number' && Number.isFinite(v) && (opts.allowZero ? v >= 0 : v > 0) && (!opts.integer || Number.isInteger(v));
  if (!okNum) throw new StudyTimeError(`${what} inválido (${JSON.stringify(v)})`);
  return { value: v, measured: true };
}

function res(resource: StudyTimeResourceKind, minutes: number, basis: string, measured: boolean): StudyTimeResource {
  return { resource, component: COMPONENT_OF[resource], minutes: r2(minutes), basis, measured };
}

function readingResource(kind: StudyTimeResourceKind, words: { value: number; measured: boolean }): StudyTimeResource {
  const R = STUDY_TIME_RULES;
  return res(kind, words.value / R.readingWordsPerMinute, `${words.value} palabras / ${R.readingWordsPerMinute} por min`, words.measured);
}

/** Minutos de un capítulo, recurso por recurso. Determinista. */
export function estimateChapterStudyTime(ch: StudyTimeChapterInput): StudyTimeChapterEstimate {
  const R = STUDY_TIME_RULES;
  const P = R.planned;
  if (!ch || typeof ch.chapterId !== 'string' || !ch.chapterId) throw new StudyTimeError('capítulo sin chapterId');
  const where = `capítulo ${ch.chapterId}`;
  const out: StudyTimeResource[] = [];
  if (ch.kind !== undefined && ch.kind !== 'content' && ch.kind !== 'practice') throw new StudyTimeError(`kind del ${where} inválido (${JSON.stringify(ch.kind)})`);
  const practice = ch.kind === 'practice';
  out.push(readingResource(practice ? 'practice_page' : 'chapter_page', measure(ch.pageWords, practice ? P.practicePageWords : P.chapterPageWords, `pageWords del ${where}`, { integer: true })));
  if (ch.libro) out.push(readingResource('libro', measure(ch.libroWords, P.libroChapterWords, `libroWords del ${where}`, { integer: true })));
  if (ch.presentation) {
    const s = measure(ch.slides, P.slides, `slides del ${where}`, { integer: true });
    out.push(res('presentation', s.value * R.minutesPerSlide, `${s.value} diapositivas × ${fmt(R.minutesPerSlide)} min`, s.measured));
  }
  if (ch.video) {
    const v = measure(ch.videoSeconds, P.videoSeconds, `videoSeconds del ${where}`);
    out.push(res('video', v.value / 60, `${Math.round(v.value)} s de video`, v.measured));
    // Mismo plan que el empaque: clamp(round(d/100), 3, 8) preguntas + pausas de reflexión (H5P v2).
    let q: number;
    let p: number;
    try {
      q = videoInteractionCount(v.value);
      p = ch.ivAdvanced ? reflectionPauseCount(v.value) : 0;
    } catch (e) {
      throw new StudyTimeError(`videoSeconds del ${where}: ${(e as Error).message}`);
    }
    out.push(res('video_interactions', (q + p) * R.minutesPerVideoInteraction, `${q} preguntas + ${p} pausas × ${fmt(R.minutesPerVideoInteraction)} min`, v.measured));
  }
  if (ch.activity) {
    const a = measure(ch.activityItems, P.activityItems, `activityItems del ${where}`, { integer: true });
    out.push(res('activity', a.value * R.minutesPerActivityItem, `${a.value} preguntas × ${fmt(R.minutesPerActivityItem)} min`, a.measured));
  }
  if (ch.review) {
    const c = measure(ch.reviewCards, P.reviewCards, `reviewCards del ${where}`, { integer: true });
    out.push(res('review', c.value * R.minutesPerReviewCard, `${c.value} tarjetas × ${fmt(R.minutesPerReviewCard)} min`, c.measured));
  }
  if (ch.applicationMinutes !== undefined) {
    if (!(R.applicationActivityTiers as readonly number[]).includes(ch.applicationMinutes)) {
      throw new StudyTimeError(`applicationMinutes del ${where} debe ser uno de ${R.applicationActivityTiers.join('/')} (fue ${JSON.stringify(ch.applicationMinutes)})`);
    }
    out.push(res('application_activity', ch.applicationMinutes, `nivel de ${ch.applicationMinutes} min fijado por Cursia`, false));
  }
  const chapterEstimatedMinutes = r2(out.reduce((a, x) => a + x.minutes, 0));
  return { chapterId: ch.chapterId, chapterEstimatedMinutes, displayMinutes: displayChapterMinutes(chapterEstimatedMinutes), resources: out };
}

/** Redondeo para mostrar el tiempo de un capítulo (a 5 min, mínimo 5). */
export function displayChapterMinutes(minutes: number): number {
  const R = STUDY_TIME_RULES;
  return Math.max(R.chapterDisplayMin, Math.round(minutes / R.chapterDisplayRoundTo) * R.chapterDisplayRoundTo);
}

/** Tiempo de estudio de todo el curso: recursos de curso + módulos + capítulos. Determinista. */
export function estimateCourseStudyTime(input: StudyTimeCourseInput): StudyTimeEstimate {
  const R = STUDY_TIME_RULES;
  const P = R.planned;
  if (!input || !Array.isArray(input.modules) || input.modules.length === 0) throw new StudyTimeError('el curso necesita al menos un módulo');
  const course: StudyTimeResource[] = [];
  if (input.frame) course.push(readingResource('course_frame', measure(input.frameWords, P.courseFrameWords, 'frameWords', { integer: true })));
  if (input.welcomeAudio) {
    const a = measure(input.welcomeAudioSeconds, P.welcomeAudioSeconds, 'welcomeAudioSeconds');
    course.push(res('welcome_audio', a.value / 60, `${Math.round(a.value)} s de audio`, a.measured));
  }
  if (input.forum) course.push(res('forum', R.forumMinutes, `${R.forumMinutes} min de participación`, false));

  const seenChapters = new Set<string>();
  const modules: StudyTimeModuleEstimate[] = input.modules.map((m) => {
    if (!m || typeof m.moduleId !== 'string' || !m.moduleId) throw new StudyTimeError('módulo sin moduleId');
    if (!Array.isArray(m.chapters) || m.chapters.length === 0) throw new StudyTimeError(`el módulo ${m.moduleId} no tiene capítulos`);
    const mr: StudyTimeResource[] = [];
    if (m.intro) mr.push(readingResource('module_intro', measure(m.introWords, P.moduleIntroWords, `introWords del módulo ${m.moduleId}`, { integer: true })));
    const chapters = m.chapters.map((c) => {
      if (seenChapters.has(c?.chapterId)) throw new StudyTimeError(`capítulo repetido ${c.chapterId}`);
      seenChapters.add(c?.chapterId);
      return estimateChapterStudyTime(c);
    });
    if (m.exam) {
      // Las preguntas salen del texto de los capítulos de CONTENIDO (el de práctica no tiene texto propio).
      const contentCount = m.chapters.filter((c) => c.kind !== 'practice').length;
      if (contentCount === 0) throw new StudyTimeError(`el módulo ${m.moduleId} tiene examen pero ningún capítulo de contenido`);
      const q = measure(m.examQuestions, examSlotSplit(contentCount).total, `examQuestions del módulo ${m.moduleId}`, { integer: true });
      mr.push(res('module_exam', q.value * R.minutesPerExamQuestion, `${q.value} preguntas × ${fmt(R.minutesPerExamQuestion)} min`, q.measured));
    }
    const moduleEstimatedMinutes = r2(mr.reduce((a, x) => a + x.minutes, 0) + chapters.reduce((a, c) => a + c.chapterEstimatedMinutes, 0));
    return { moduleId: m.moduleId, moduleEstimatedMinutes, resources: mr, chapters };
  });
  if (input.finalExam) {
    const contentTotal = input.modules.reduce((n, m) => n + m.chapters.filter((c) => c.kind !== 'practice').length, 0);
    const q = measure(input.finalExamQuestions, finalExamSlotSplit(contentTotal).total, 'finalExamQuestions', { integer: true });
    course.push(res('final_exam', q.value * R.minutesPerExamQuestion, `${q.value} preguntas × ${fmt(R.minutesPerExamQuestion)} min`, q.measured));
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
    usesPlannedValues: all.some((x) => !x.measured && x.resource !== 'forum' && x.resource !== 'application_activity'),
  };
}
