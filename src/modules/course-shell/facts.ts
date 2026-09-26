/**
 * R11a — `facts` del curso (audit §M.3): derivados, nunca almacenados como
 * verdad. Función pura (sin DB, reloj ni azar). TODO número que imprime el
 * shell sale de aquí; `factsNumberSet` es el conjunto contra el que el lint de
 * números compara el texto del shell.
 *
 * Entradas:
 *  - manifest v3 + Blueprint v2 (estructura, toggles, títulos) — se verifican
 *    entre sí (sha del Blueprint + validador v3 del Manifest);
 *  - perfil de evaluación (R3) → nota mínima / intentos / método por tipo;
 *  - metadatos MEDIDOS de artifacts: segundos de audio (MP3), diapositivas
 *    (PDF de Gamma), preguntas por examen (GIFT parseado), palabras del Libro.
 * Cualquier dato faltante o incoherente → throw FACTS_INVALID (nunca un
 * default inventado).
 */
import {
  AnyBlueprintSnapshot,
  BlueprintSnapshotV2,
  snapshotSha256V2,
} from '../course-blueprints/blueprint-snapshot';
import {
  GenerationManifestV1,
  validateGenerationManifest,
} from '../generation-manifests/generation-manifest-builder';
import {
  ASSESSABLE_TYPES,
  AssessableType,
  AssessmentProfile,
  GradeMethod,
  validateAssessmentProfile,
} from '../course-profiles/course-profiles';
import { formatDurationEs, formatDurationShortEs } from '../../package/audio';
import { H5pActivityType, activityTypeForChapter } from './activity-type';

export const COURSE_FACTS_VERSION = 1;
export const HOURS_SOURCE_LABEL = 'definida por la institución';

export interface CourseFactsArtifactsInput {
  /** Duración MEDIDA del MP3 de bienvenida (mp3DurationSeconds). */
  audioWelcomeSeconds: number;
  /** Una parte por capítulo del Manifest (cualquier orden; se ordena por el Manifest). */
  audiobookParts: Array<{ chapterId: string; seconds: number }>;
  /** Diapositivas medidas (pdfPageCount) por chapterId; obligatorio para TODOS los capítulos. */
  slideCountByChapter: Record<string, number>;
  /** Preguntas del GIFT parseado por moduleId; exactamente los módulos con examen. */
  examQuestionCountByModule: Record<string, number>;
  /** Preguntas del GIFT final parseado; obligatorio si course.finalExam. */
  finalExamQuestionCount?: number;
  /** Palabras del Libro Guía compilado. */
  libroWordCount: number;
}

export interface BuildCourseFactsInput {
  manifest: GenerationManifestV1;
  blueprint: AnyBlueprintSnapshot;
  assessment: AssessmentProfile;
  artifacts: CourseFactsArtifactsInput;
  /** Dato del setup (horas); se muestra etiquetado como definido por la institución. */
  hours?: number | null;
}

export interface ChapterFacts {
  id: string;
  number: number;
  moduleId: string;
  moduleNumber: number;
  /** Posición 1-based dentro de su módulo. */
  indexInModule: number;
  title: string;
  videoEnabled: boolean;
  activityEnabled: boolean;
  /** null si la actividad está OFF. */
  activityVariant: 'h5p' | 'scorm' | null;
  /** Solo variant h5p (activityTypeForChapter(chapterId): estable ante reordenamientos). */
  activityType: H5pActivityType | null;
  slideCount: number;
}

export interface ModuleFacts {
  id: string;
  number: number;
  title: string;
  chapterNumbers: number[];
  examEnabled: boolean;
  /** null si el módulo no tiene examen. */
  examQuestionCount: number | null;
}

export interface AssessmentFactsKind {
  passingGrade: number;
  /** 0 = ilimitados. */
  attempts: number;
  gradeMethod: GradeMethod;
}

export interface CourseFacts {
  factsVersion: number;
  course: { id: number; title: string };
  activityEngine: 'h5p' | 'scorm';
  counts: {
    modules: number;
    chapters: number;
    videos: number;
    activities: number;
    activitiesByVariant: { h5p: number; scorm: number };
    /** Exámenes de módulo. */
    exams: number;
    finalExam: boolean;
    /** Exámenes de módulo + examen final. */
    evaluations: number;
  };
  chapters: ChapterFacts[];
  modules: ModuleFacts[];
  finalExam: { enabled: boolean; questionCount: number | null };
  assessment: {
    assessmentProfileVersion: number;
    kinds: Record<AssessableType, AssessmentFactsKind>;
  };
  audio: {
    welcomeSeconds: number;
    audiobookSeconds: number;
    audiobookParts: Array<{ chapterId: string; chapterNumber: number; seconds: number; offsetSeconds: number }>;
  };
  libro: { wordCount: number };
  hours: { value: number; source: string } | null;
}

function fail(msg: string): never {
  throw new Error(`FACTS_INVALID: ${msg}`);
}

function posInt(v: unknown, what: string): number {
  if (!Number.isInteger(v) || (v as number) < 1) fail(`${what} debe ser un entero ≥ 1 (fue ${JSON.stringify(v)})`);
  return v as number;
}

function posSeconds(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(`${what} debe ser una duración medida > 0 (fue ${JSON.stringify(v)})`);
  return v;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export function buildCourseFacts(input: BuildCourseFactsInput): CourseFacts {
  const { manifest, blueprint, assessment, artifacts } = input ?? ({} as BuildCourseFactsInput);
  if (!manifest || manifest.rulesVersion !== 3) fail('el Manifest debe ser rulesVersion 3');
  if (!blueprint || blueprint.schemaVersion !== 2) fail('el Blueprint debe ser schemaVersion 2');
  const bp = blueprint as BlueprintSnapshotV2;
  if (snapshotSha256V2(bp) !== manifest.source?.blueprintSha256) fail('el Blueprint no es el del Manifest (sha distinto)');
  const mErrors = validateGenerationManifest(manifest, bp, manifest.source);
  if (mErrors.length > 0) fail(`Manifest inválido contra el Blueprint: ${mErrors.slice(0, 3).map((e) => e.code).join(', ')}`);
  const features = manifest.features;
  if (!features) fail('Manifest v3 sin features');
  if (!artifacts) fail('faltan los metadatos de artifacts');

  const aErrors = validateAssessmentProfile(assessment, { finalExam: features.finalExam });
  if (aErrors.length > 0) fail(`perfil de evaluación inválido: ${aErrors.map((e) => e.code).join(', ')}`);
  const kinds = {} as Record<AssessableType, AssessmentFactsKind>;
  for (const k of ASSESSABLE_TYPES) {
    const override = assessment.overrides[k];
    kinds[k] = {
      passingGrade: override === null || override === undefined ? assessment.passingGrade : override,
      attempts: assessment.attempts[k],
      gradeMethod: assessment.gradeMethod[k],
    };
  }

  const itemKeys = new Set(manifest.items.map((i) => i.key));
  const chapters: ChapterFacts[] = [];
  const modules: ModuleFacts[] = [];
  const knownChapterIds = new Set<string>();
  for (const mm of manifest.modules) {
    const sm = bp.modules.find((m) => m.id === mm.moduleId);
    if (!sm) fail(`módulo ${mm.moduleId} del Manifest ausente en el Blueprint`);
    mm.chapters.forEach((mc, idx) => {
      const sc = sm.chapters.find((c) => c.id === mc.chapterId);
      if (!sc) fail(`capítulo ${mc.chapterId} ausente en el Blueprint`);
      knownChapterIds.add(mc.chapterId);
      const activityEnabled = mc.activityEnabled === true;
      if (itemKeys.has(`activity:${mc.chapterId}`) !== activityEnabled) fail(`activity del capítulo ${mc.chapterNumber} incoherente con el Manifest`);
      if (itemKeys.has(`video:${mc.chapterId}`) !== mc.videoEnabled) fail(`video del capítulo ${mc.chapterNumber} incoherente con el Manifest`);
      const variant = activityEnabled ? features.activityEngine : null;
      chapters.push({
        id: mc.chapterId,
        number: mc.chapterNumber,
        moduleId: mm.moduleId,
        moduleNumber: mm.moduleNumber,
        indexInModule: idx + 1,
        title: sc.title,
        videoEnabled: mc.videoEnabled,
        activityEnabled,
        activityVariant: variant,
        activityType: variant === 'h5p' ? activityTypeForChapter(mc.chapterId) : null,
        slideCount: posInt(artifacts.slideCountByChapter?.[mc.chapterId], `slideCount del capítulo ${mc.chapterNumber}`),
      });
    });
    const q = artifacts.examQuestionCountByModule?.[mm.moduleId];
    if (mm.examEnabled) posInt(q, `preguntas del examen del módulo ${mm.moduleNumber}`);
    else if (q !== undefined) fail(`el módulo ${mm.moduleNumber} no tiene examen pero se informaron ${JSON.stringify(q)} preguntas`);
    modules.push({
      id: mm.moduleId,
      number: mm.moduleNumber,
      title: sm.title,
      chapterNumbers: mm.chapters.map((c) => c.chapterNumber),
      examEnabled: mm.examEnabled,
      examQuestionCount: mm.examEnabled ? (q as number) : null,
    });
  }
  for (const id of Object.keys(artifacts.slideCountByChapter ?? {})) {
    if (!knownChapterIds.has(id)) fail(`slideCount de un capítulo que no está en el Manifest (${id})`);
  }
  const moduleIds = new Set(manifest.modules.map((m) => m.moduleId));
  for (const id of Object.keys(artifacts.examQuestionCountByModule ?? {})) {
    if (!moduleIds.has(id)) fail(`preguntas de examen de un módulo que no está en el Manifest (${id})`);
  }

  let finalQ: number | null = null;
  if (features.finalExam) finalQ = posInt(artifacts.finalExamQuestionCount, 'preguntas del examen final');
  else if (artifacts.finalExamQuestionCount !== undefined && artifacts.finalExamQuestionCount !== null) {
    fail('el curso no tiene examen final pero se informaron preguntas');
  }

  const welcomeSeconds = posSeconds(artifacts.audioWelcomeSeconds, 'audioWelcomeSeconds');
  const parts = Array.isArray(artifacts.audiobookParts) ? artifacts.audiobookParts : fail('audiobookParts debe ser una lista');
  const byId = new Map<string, number>();
  for (const p of parts) {
    if (!p || typeof p.chapterId !== 'string') fail('audiobookParts: parte sin chapterId');
    if (byId.has(p.chapterId)) fail(`audiobookParts: capítulo repetido ${p.chapterId}`);
    if (!knownChapterIds.has(p.chapterId)) fail(`audiobookParts: capítulo desconocido ${p.chapterId}`);
    byId.set(p.chapterId, posSeconds(p.seconds, `duración del audiolibro del capítulo ${p.chapterId}`));
  }
  let offset = 0;
  const audiobookParts = chapters.map((c) => {
    const seconds = byId.get(c.id);
    if (seconds === undefined) fail(`audiolibro sin la parte del capítulo ${c.number}`);
    const part = { chapterId: c.id, chapterNumber: c.number, seconds, offsetSeconds: offset };
    offset += seconds;
    return part;
  });

  const libroWordCount = posInt(artifacts.libroWordCount, 'libroWordCount');
  let hours: CourseFacts['hours'] = null;
  if (input.hours !== undefined && input.hours !== null) {
    if (typeof input.hours !== 'number' || !Number.isFinite(input.hours) || input.hours <= 0) fail('hours debe ser un número > 0');
    hours = { value: input.hours, source: HOURS_SOURCE_LABEL };
  }

  const activitiesByVariant = {
    h5p: chapters.filter((c) => c.activityVariant === 'h5p').length,
    scorm: chapters.filter((c) => c.activityVariant === 'scorm').length,
  };
  const exams = modules.filter((m) => m.examEnabled).length;
  const facts: CourseFacts = {
    factsVersion: COURSE_FACTS_VERSION,
    course: { id: bp.course.id, title: bp.course.title },
    activityEngine: features.activityEngine,
    counts: {
      modules: modules.length,
      chapters: chapters.length,
      videos: chapters.filter((c) => c.videoEnabled).length,
      activities: activitiesByVariant.h5p + activitiesByVariant.scorm,
      activitiesByVariant,
      exams,
      finalExam: features.finalExam,
      evaluations: exams + (features.finalExam ? 1 : 0),
    },
    chapters,
    modules,
    finalExam: { enabled: features.finalExam, questionCount: finalQ },
    assessment: { assessmentProfileVersion: assessment.assessmentProfileVersion, kinds },
    audio: { welcomeSeconds, audiobookSeconds: offset, audiobookParts },
    libro: { wordCount: libroWordCount },
    hours,
  };
  // Sanidad contra los totales del Manifest (dos fuentes, un número).
  const t = manifest.totals;
  if (t.moduleCount !== facts.counts.modules || t.chapterCount !== facts.counts.chapters || t.videoCount !== facts.counts.videos ||
    t.examCount !== facts.counts.exams || (t.activityCount ?? 0) !== facts.counts.activities) {
    fail('los conteos derivados no coinciden con manifest.totals');
  }
  return deepFreeze(facts);
}

// ─── Conjunto de números permitidos (lint del shell) ────────────────────────

/** Números que aparecen en un texto (enteros y decimales con , o .). */
export function numbersInText(text: string): number[] {
  return Array.from(String(text ?? '').matchAll(/\d+(?:[.,]\d+)?/g), (m) => Number(m[0].replace(',', '.')));
}

/**
 * Todo número que el shell puede imprimir: conteos, numeración de módulos y
 * capítulos, capítulos por módulo, diapositivas, preguntas, notas mínimas,
 * intentos, horas, palabras del Libro y cada componente de las duraciones
 * formateadas (bienvenida, total y partes/offsets del audiolibro).
 */
export function factsNumberSet(facts: CourseFacts): Set<number> {
  const s = new Set<number>();
  const add = (n: number | null | undefined) => {
    if (typeof n === 'number' && Number.isFinite(n)) s.add(n);
  };
  const addDuration = (sec: number) => {
    for (const n of numbersInText(formatDurationEs(sec))) add(n);
    for (const n of numbersInText(formatDurationShortEs(sec))) add(n);
  };
  const c = facts.counts;
  [c.modules, c.chapters, c.videos, c.activities, c.activitiesByVariant.h5p, c.activitiesByVariant.scorm, c.exams, c.evaluations].forEach(add);
  for (const m of facts.modules) {
    add(m.number);
    add(m.chapterNumbers.length);
    add(m.examQuestionCount);
  }
  for (const ch of facts.chapters) {
    add(ch.number);
    add(ch.indexInModule);
    add(ch.slideCount);
  }
  add(facts.finalExam.questionCount);
  for (const k of ASSESSABLE_TYPES) {
    add(facts.assessment.kinds[k].passingGrade);
    add(facts.assessment.kinds[k].attempts);
  }
  add(100); // "N de 100": escala fija de la nota (§K.1), no un dato inventado.
  if (facts.hours) add(facts.hours.value);
  add(facts.libro.wordCount);
  addDuration(facts.audio.welcomeSeconds);
  addDuration(facts.audio.audiobookSeconds);
  for (const p of facts.audio.audiobookParts) {
    addDuration(p.seconds);
    addDuration(p.offsetSeconds);
  }
  return s;
}

/**
 * Números del texto que NO están en factsNumberSet (vacío = pasa). Los títulos
 * del Blueprint (curso, módulos, capítulos) se quitan antes: son nombres que
 * puso la institución ("ISO 9001"), no cifras que afirme el shell.
 */
export function lintShellNumbers(text: string, facts: CourseFacts): number[] {
  const allowed = factsNumberSet(facts);
  const titles = [facts.course.title, ...facts.modules.map((m) => m.title), ...facts.chapters.map((c) => c.title)]
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  let t = String(text ?? '');
  for (const title of titles) t = t.split(title).join(' ');
  return numbersInText(t).filter((n) => !allowed.has(n));
}
