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
import { VC_MOVEMENT_IDS, VcMovementId } from '../visual-components/schema';
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
import { H5pActivityTypeV2, resolveActivityType } from './activity-type';
import { displayStructureTitle } from '../course-structure/structure-titles';
import { courseCountNumbers } from './intro-schemas';

export const COURSE_FACTS_VERSION = 1;
export const HOURS_SOURCE_LABEL = 'definida por la institución';

export interface CourseFactsArtifactsInput {
  /** Duración MEDIDA del MP3 de bienvenida (mp3DurationSeconds). */
  audioWelcomeSeconds: number;
  /** Una parte por capítulo del Manifest (cualquier orden; se ordena por el Manifest). */
  audiobookParts: Array<{ chapterId: string; seconds: number }>;
  /** Diapositivas medidas (pdfPageCount) por chapterId; obligatorio para TODOS los capítulos. */
  slideCountByChapter: Record<string, number>;
  /**
   * Preguntas que ve el estudiante por moduleId; exactamente los módulos con examen. GIFT: preguntas
   * parseadas; banco (EV6 P2-B3): SLOTS del plan (no el tamaño del banco).
   */
  examQuestionCountByModule: Record<string, number>;
  /** Preguntas del examen final (GIFT parseado | slots del banco); obligatorio si course.finalExam. */
  finalExamQuestionCount?: number;
  /** EV6 P2-B3: preguntas del BANCO por moduleId (solo módulos cuyo examen es banco). */
  examBankSizeByModule?: Record<string, number>;
  /** EV6 P2-B3: preguntas del banco del examen final (solo si es banco). */
  finalExamBankSize?: number;
  /** Palabras del Libro Guía compilado. */
  libroWordCount: number;
  /** R14: el Libro publica una sección de bibliografía (verificada). Omitido = sí (compatibilidad). */
  libroHasBibliography?: boolean;
  /**
   * P3: palabras MEDIDAS del experience por chapterId y por movimiento (experienceMovementWords); si se
   * informa, para TODOS los capítulos. Los minutos cuentan SOLO los movimientos que el capítulo muestra.
   */
  experienceWordsByChapter?: Record<string, Partial<Record<VcMovementId, number>>>;
  /** P3 (fix M2): duración MEDIDA del video real por chapterId (segundos); sin ella, el estimado fijo. */
  videoSecondsByChapter?: Record<string, number>;
}

export interface BuildCourseFactsInput {
  manifest: GenerationManifestV1;
  blueprint: AnyBlueprintSnapshot;
  assessment: AssessmentProfile;
  artifacts: CourseFactsArtifactsInput;
  /** Dato del setup (horas); se muestra etiquetado como definido por la institución. */
  hours?: number | null;
  /**
   * EV6 T5: videos pendientes (vista previa) que el paquete omite. `chapterIds` = capítulos con
   * video en el Manifest cuyo video no es real todavía (quedan `videoEnabled:false`,
   * `videoPending:true`); `noticeChapterIds` ⊆ chapterIds = los que llevan el aviso neutral
   * «El video interactivo de este capítulo estará disponible…» (sus textos mencionan el video).
   */
  pendingVideos?: { chapterIds: readonly string[]; noticeChapterIds?: readonly string[] } | null;
  /**
   * EV6 H5P v2: capítulos con «Repaso» (Dialog Cards, sin nota). Solo con el ajuste del Blueprint
   * `course.reviewCards` encendido; el builder los elige (experiencia con ≥ 4 tarjetas).
   */
  reviewCardsChapterIds?: readonly string[] | null;
}

export interface ChapterFacts {
  id: string;
  number: number;
  moduleId: string;
  moduleNumber: number;
  /** Posición 1-based dentro de su módulo. */
  indexInModule: number;
  title: string;
  /** Video REAL presente en el paquete. */
  videoEnabled: boolean;
  /** EV6 T5: el Manifest tiene video pero todavía es de vista previa (omitido del paquete). */
  videoPending?: boolean;
  /** EV6 T5: el capítulo pendiente lleva el aviso neutral de video próximo (ver pending-video.ts). */
  videoPendingNotice?: boolean;
  activityEnabled: boolean;
  /** null si la actividad está OFF. */
  activityVariant: 'h5p' | 'scorm' | null;
  /** EV6 H5P v2: el capítulo lleva «Repaso» (Dialog Cards, sin nota, completion por vista). Solo si true. */
  reviewCards?: true;
  /**
   * Solo variant h5p: resolveActivityType(item activity del Manifest) — `h5pType`
   * congelado (EV5-C) o, en Manifests legacy, activityTypeForChapter(chapterId).
   * El validador del .mbz lee este dato (nunca recalcula el hash).
   */
  activityType: H5pActivityTypeV2 | null;
  slideCount: number;
  /**
   * P3: minutos estimados del capítulo (estimateChapterMinutes) desde las palabras MEDIDAS del
   * experience + diapositivas + video real + actividad. Ausente si el empaque no informó las palabras.
   */
  estimatedMinutes?: number;
}

export interface ModuleFacts {
  id: string;
  number: number;
  title: string;
  chapterNumbers: number[];
  examEnabled: boolean;
  /** null si el módulo no tiene examen. */
  examQuestionCount: number | null;
  /** EV6 P2-B3: solo si el examen del módulo es un banco — preguntas del banco (≥ slots). */
  examBankSize?: number;
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
    /** EV6 H5P v2: capítulos con «Repaso» (add-on sin nota). Solo si > 0. */
    reviewCards?: number;
  };
  chapters: ChapterFacts[];
  modules: ModuleFacts[];
  /** `bankSize` solo si el examen final es un banco (EV6 P2-B3). */
  finalExam: { enabled: boolean; questionCount: number | null; bankSize?: number };
  assessment: {
    assessmentProfileVersion: number;
    kinds: Record<AssessableType, AssessmentFactsKind>;
  };
  audio: {
    welcomeSeconds: number;
    audiobookSeconds: number;
    audiobookParts: Array<{ chapterId: string; chapterNumber: number; seconds: number; offsetSeconds: number }>;
  };
  libro: { wordCount: number; hasBibliography: boolean };
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

  const pendingIds = new Set<string>(input.pendingVideos?.chapterIds ?? []);
  const noticeIds = new Set<string>(input.pendingVideos?.noticeChapterIds ?? []);
  for (const id of noticeIds) if (!pendingIds.has(id)) fail(`aviso de video pendiente en un capítulo sin video pendiente (${id})`);
  const itemKeys = new Set(manifest.items.map((i) => i.key));
  const itemByKey = new Map(manifest.items.map((i) => [i.key, i]));
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
      const videoPending = pendingIds.has(mc.chapterId);
      if (videoPending && !mc.videoEnabled) fail(`video pendiente en el capítulo ${mc.chapterNumber}, que no tiene video en el Manifest`);
      chapters.push({
        id: mc.chapterId,
        number: mc.chapterNumber,
        moduleId: mm.moduleId,
        moduleNumber: mm.moduleNumber,
        indexInModule: idx + 1,
        title: displayStructureTitle(sc.title),
        videoEnabled: mc.videoEnabled && !videoPending,
        ...(videoPending ? { videoPending: true, videoPendingNotice: noticeIds.has(mc.chapterId) } : {}),
        activityEnabled,
        activityVariant: variant,
        activityType: variant === 'h5p' ? resolveActivityType(itemByKey.get(`activity:${mc.chapterId}`), { activityTypeRules: manifest.features?.activityTypeRules }) : null,
        slideCount: posInt(artifacts.slideCountByChapter?.[mc.chapterId], `slideCount del capítulo ${mc.chapterNumber}`),
      });
      if (artifacts.experienceWordsByChapter) {
        const ch = chapters[chapters.length - 1];
        const per = artifacts.experienceWordsByChapter[mc.chapterId];
        if (!per || typeof per !== 'object') fail(`palabras del experience del capítulo ${mc.chapterNumber} ausentes`);
        // Solo lo que el capítulo MUESTRA (mismas reglas que chapterSlotSequence): la guía previa al video
        // solo con video real; el repaso solo sin actividad.
        const shown: VcMovementId[] = ['opening', 'deepening', 'synthesis', 'closing'];
        if (ch.videoEnabled) shown.push('video_primer');
        if (!ch.activityEnabled) shown.push('self_check');
        let words = 0;
        for (const m of shown) {
          const n = (per as Record<string, unknown>)[m] ?? 0;
          if (!Number.isInteger(n) || (n as number) < 0) fail(`palabras del movimiento ${m} del capítulo ${mc.chapterNumber} inválidas (${JSON.stringify(n)})`);
          words += n as number;
        }
        if (words < 1) fail(`el experience del capítulo ${mc.chapterNumber} no tiene palabras medidas`);
        const vs = artifacts.videoSecondsByChapter?.[mc.chapterId];
        if (vs !== undefined && (!Number.isFinite(vs) || vs <= 0)) fail(`duración del video del capítulo ${mc.chapterNumber} inválida (${JSON.stringify(vs)})`);
        ch.estimatedMinutes = estimateChapterMinutes({ words, slideCount: ch.slideCount, videoEnabled: ch.videoEnabled, activityEnabled: ch.activityEnabled, videoSeconds: ch.videoEnabled ? vs : undefined });
      }
    });
    const q = artifacts.examQuestionCountByModule?.[mm.moduleId];
    if (mm.examEnabled) posInt(q, `preguntas del examen del módulo ${mm.moduleNumber}`);
    else if (q !== undefined) fail(`el módulo ${mm.moduleNumber} no tiene examen pero se informaron ${JSON.stringify(q)} preguntas`);
    const bankSize = artifacts.examBankSizeByModule?.[mm.moduleId];
    if (bankSize !== undefined) {
      if (!mm.examEnabled) fail(`el módulo ${mm.moduleNumber} no tiene examen pero se informó un banco`);
      if (posInt(bankSize, `banco del examen del módulo ${mm.moduleNumber}`) < (q as number)) fail(`el banco del examen del módulo ${mm.moduleNumber} es menor que sus slots`);
    }
    modules.push({
      id: mm.moduleId,
      number: mm.moduleNumber,
      title: displayStructureTitle(sm.title),
      chapterNumbers: mm.chapters.map((c) => c.chapterNumber),
      examEnabled: mm.examEnabled,
      examQuestionCount: mm.examEnabled ? (q as number) : null,
      ...(bankSize !== undefined ? { examBankSize: bankSize } : {}),
    });
  }
  for (const id of pendingIds) if (!knownChapterIds.has(id)) fail(`video pendiente de un capítulo que no está en el Manifest (${id})`);
  // EV6 H5P v2: «Repaso» solo con el ajuste del Blueprint y en capítulos del Manifest.
  const reviewIds = new Set<string>(input.reviewCardsChapterIds ?? []);
  if (reviewIds.size && bp.course.reviewCards !== true) fail('«Repaso» (Dialog Cards) sin el ajuste course.reviewCards del Blueprint');
  // H2 fix round 1 (I-2, M-4): solo con H5P v2 (marcador 2 del Manifest) y motor h5p.
  if (reviewIds.size && (features.activityTypeRules !== 2 || features.activityEngine !== 'h5p')) {
    fail('«Repaso» (Dialog Cards) solo con H5P v2 (activityTypeRules=2) y motor h5p');
  }
  for (const id of reviewIds) if (!knownChapterIds.has(id)) fail(`«Repaso» de un capítulo que no está en el Manifest (${id})`);
  for (const ch of chapters) if (reviewIds.has(ch.id)) ch.reviewCards = true;
  for (const id of Object.keys(artifacts.slideCountByChapter ?? {})) {
    if (!knownChapterIds.has(id)) fail(`slideCount de un capítulo que no está en el Manifest (${id})`);
  }
  for (const id of Object.keys(artifacts.experienceWordsByChapter ?? {})) {
    if (!knownChapterIds.has(id)) fail(`palabras del experience de un capítulo que no está en el Manifest (${id})`);
  }
  for (const id of Object.keys(artifacts.videoSecondsByChapter ?? {})) {
    if (!knownChapterIds.has(id)) fail(`duración de video de un capítulo que no está en el Manifest (${id})`);
  }
  const moduleIds = new Set(manifest.modules.map((m) => m.moduleId));
  for (const id of Object.keys(artifacts.examQuestionCountByModule ?? {})) {
    if (!moduleIds.has(id)) fail(`preguntas de examen de un módulo que no está en el Manifest (${id})`);
  }
  for (const id of Object.keys(artifacts.examBankSizeByModule ?? {})) {
    if (!moduleIds.has(id)) fail(`banco de examen de un módulo que no está en el Manifest (${id})`);
  }

  let finalQ: number | null = null;
  if (features.finalExam) finalQ = posInt(artifacts.finalExamQuestionCount, 'preguntas del examen final');
  else if (artifacts.finalExamQuestionCount !== undefined && artifacts.finalExamQuestionCount !== null) {
    fail('el curso no tiene examen final pero se informaron preguntas');
  }
  let finalBank: number | undefined;
  if (artifacts.finalExamBankSize !== undefined) {
    if (!features.finalExam) fail('el curso no tiene examen final pero se informó un banco');
    finalBank = posInt(artifacts.finalExamBankSize, 'banco del examen final');
    if (finalBank < (finalQ as number)) fail('el banco del examen final es menor que sus slots');
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
      ...(reviewIds.size ? { reviewCards: reviewIds.size } : {}),
    },
    chapters,
    modules,
    finalExam: { enabled: features.finalExam, questionCount: finalQ, ...(finalBank !== undefined ? { bankSize: finalBank } : {}) },
    assessment: { assessmentProfileVersion: assessment.assessmentProfileVersion, kinds },
    audio: { welcomeSeconds, audiobookSeconds: offset, audiobookParts },
    libro: { wordCount: libroWordCount, hasBibliography: artifacts.libroHasBibliography !== false },
    hours,
  };
  // Sanidad contra los totales del Manifest (dos fuentes, un número).
  const t = manifest.totals;
  // EV6 T5: los videos pendientes están en el Manifest pero no en el paquete.
  if (t.moduleCount !== facts.counts.modules || t.chapterCount !== facts.counts.chapters || t.videoCount !== facts.counts.videos + pendingIds.size ||
    t.examCount !== facts.counts.exams || (t.activityCount ?? 0) !== facts.counts.activities) {
    fail('los conteos derivados no coinciden con manifest.totals');
  }
  return deepFreeze(facts);
}

// ─── P3: tiempo estimado del capítulo ───────────────────────────────────────

/** Ritmo de lectura (palabras/min) y tiempos fijos del estimado (constantes del producto, no del LLM). */
export const CHAPTER_MINUTES_RULES = Object.freeze({ wordsPerMinute: 180, minutesPerSlide: 0.5, videoMinutes: 6, activityMinutes: 8, roundTo: 5, min: 5 });

/**
 * Minutos estimados de un capítulo, redondeados a 5 (mínimo 5). Determinista. El video usa su duración
 * MEDIDA (`videoSeconds`) cuando el empaque la informa; si no, el estimado fijo.
 */
export function estimateChapterMinutes(x: { words: number; slideCount: number; videoEnabled: boolean; activityEnabled: boolean; videoSeconds?: number }): number {
  const R = CHAPTER_MINUTES_RULES;
  const video = !x.videoEnabled ? 0 : x.videoSeconds !== undefined ? x.videoSeconds / 60 : R.videoMinutes;
  const raw = x.words / R.wordsPerMinute + x.slideCount * R.minutesPerSlide + video + (x.activityEnabled ? R.activityMinutes : 0);
  return Math.max(R.min, Math.round(raw / R.roundTo) * R.roundTo);
}

const NON_TEXT_KEYS = new Set(['type', 'variant', 'kind', 'vcSchemaVersion', 'chapterId']);

/** Palabras por movimiento de un experience (lo que el estudiante lee en cada label). */
export function experienceMovementWords(exp: unknown): Partial<Record<VcMovementId, number>> {
  const out: Partial<Record<VcMovementId, number>> = {};
  const mv = exp && typeof exp === 'object' ? (exp as { movements?: Record<string, unknown> }).movements : undefined;
  for (const m of VC_MOVEMENT_IDS) out[m] = mv ? experienceWordCount(mv[m]) : 0;
  return out;
}

/** Palabras de todo el texto (lo que el estudiante lee), sin claves estructurales. */
export function experienceWordCount(exp: unknown): number {
  let n = 0;
  const walk = (v: unknown, key?: string) => {
    if (typeof v === 'string') {
      if (!key || !NON_TEXT_KEYS.has(key)) n += v.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(exp);
  return n;
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
    add(m.examBankSize);
  }
  for (const ch of facts.chapters) {
    add(ch.number);
    add(ch.indexInModule);
    add(ch.slideCount);
    add(ch.estimatedMinutes);
  }
  add(facts.finalExam.questionCount);
  add(facts.finalExam.bankSize);
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
 * Números del texto que NO están permitidos (vacío = pasa). Los títulos del Blueprint (curso, módulos,
 * capítulos) se quitan antes: son nombres que puso la institución ("ISO 9001"), no cifras que afirme el shell.
 *
 * V542 fix round 2 (N1): el texto de PLANTILLA es estricto como siempre — toda cifra (duraciones, preguntas,
 * intentos, nota mínima, numeración, marcas de tiempo) debe estar en factsNumberSet. La regla angosta de
 * «cifras de contenido permitidas» aplica SOLO a la prosa que escribió el LLM (`prose`: textos de las intros
 * que el label muestra): sus cifras de contenido («Ley 1480 de 2011», «15 días hábiles») se admiten; las que
 * cuentan el curso (`courseCountNumbers`, la misma clase que rechaza el lint de la intro) deben estar en facts.
 * Sin `prose`, todo el label es estricto.
 */
export function lintShellNumbers(text: string, facts: CourseFacts, prose: readonly string[] = []): number[] {
  const allowed = factsNumberSet(facts);
  const contentNumbers = new Set<number>();
  const bad: number[] = [];
  for (const p of prose) {
    const counted = new Set(courseCountNumbers(p));
    for (const n of counted) if (!allowed.has(n)) bad.push(n);
    for (const n of numbersInText(stripStructureTitles(p, facts))) if (!counted.has(n)) contentNumbers.add(n);
  }
  for (const n of numbersInText(stripStructureTitles(text, facts))) {
    if (!allowed.has(n) && !contentNumbers.has(n)) bad.push(n);
  }
  return [...new Set(bad)];
}

/** V542 fix round 2 (N1): textos de prosa LLM de una intro que el shell muestra (todo salvo la bibliografía). */
export function introProseTexts(intro: unknown): string[] {
  const i = (intro && typeof intro === 'object' ? intro : {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ['welcome', 'methodology_note', 'closing', 'presentation']) if (typeof i[k] === 'string') out.push(i[k] as string);
  for (const k of ['competencies', 'outcomes']) if (Array.isArray(i[k])) for (const x of i[k] as unknown[]) if (typeof x === 'string') out.push(x);
  if (Array.isArray(i.journey)) for (const j of i.journey as any[]) if (j && typeof j.line === 'string') out.push(j.line);
  return out;
}

/**
 * Quita del texto los títulos del Blueprint (curso, módulos, capítulos), del más largo al más
 * corto. EV6: también antes de los lints de recursos del validador, porque los botones de
 * navegación nombran el capítulo/módulo siguiente («Continuar con el módulo 3: Producción de
 * video →») y un título no es una promesa de recurso.
 */
export function stripStructureTitles(text: string, facts: CourseFacts): string {
  const titles = [facts.course.title, ...facts.modules.map((m) => m.title), ...facts.chapters.map((c) => c.title)]
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  let t = String(text ?? '');
  for (const title of titles) t = t.split(title).join(' ');
  return t;
}
