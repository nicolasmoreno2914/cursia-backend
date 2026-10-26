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
import { FrameworkSlot, defaultFrameworkRegistry, frameworkSlotLabels } from '../pedagogy/instructional-frameworks';
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
import { AssessmentCategoryKey, ResolvedApplicationDelivery, normalizeCategoryWeights, resolveApplicationDelivery } from '../../package/assessment/resolve-assessment';
import { ResolvedPracticeResource, chapterDeliveryMode } from '../course-profiles/application-delivery';
import { H5pActivityTypeV2, resolveActivityType } from './activity-type';
import { displayStructureTitle } from '../course-structure/structure-titles';
import { courseCountNumbers } from './intro-schemas';
import { estimateCourseStudyTimeDetailed, HourLine, StudyTimeEstimate } from '../study-time/time-model';
import { HoursReport, buildHoursReport } from '../study-time/hours-ledger';
import { timeModelConfigOf } from '../study-time/manifest-input';
import type { TimeModelConfig } from '../study-time/time-model-config';

export const COURSE_FACTS_VERSION = 1;
export const HOURS_SOURCE_LABEL = 'definida por la institución';

export interface CourseFactsArtifactsInput {
  /** Duración MEDIDA del MP3 de bienvenida (mp3DurationSeconds). */
  audioWelcomeSeconds: number;
  /** Una parte por capítulo del Manifest (cualquier orden; se ordena por el Manifest). */
  audiobookParts: Array<{ chapterId: string; seconds: number }>;
  /**
   * r74: entrega del audiolibro en archivos APARTE (paquete principal + partes). Cada parte lista sus segmentos (capítulos
   * consecutivos de UN módulo, en el orden del curso). Ausente = audiolibro embebido en el paquete (facts de siempre).
   */
  audiobookDelivery?: { mode: 'parts' | 'linked'; parts: Array<{ partNumber: number; segments: Array<{ chapterIds: string[] }> }> } | null;
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
  /** Horas objetivo congeladas en el Blueprint. */
  hours?: number | null;
  /**
   * Review r1 (M-5): origen de esas horas. Solo `document` (documento de la institución) muestra «(definida por la
   * institución)»; cualquier otro (perfil escrito por el usuario, propuesta de Cursia aceptada, ausente) → redacción neutra.
   */
  hoursSource?: 'document' | null;
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
  /** Motor de carga horaria: tarjetas MEDIDAS de cada «Repaso» (⊆ reviewCardsChapterIds). Ausente = planificado. */
  reviewCardCountByChapter?: Readonly<Record<string, number>> | null;
  /**
   * Loop 9 B: capítulos cuya práctica guiada llega VALIDADA al paquete. Una práctica guiada del Manifest sin documento
   * no se cuenta (ni se publica): el paquete la rechaza antes; sin la clave, ninguna se cuenta.
   */
  guidedPracticeChapterIds?: readonly string[] | null;
  /**
   * T5 (r57): archivos de trabajo RESUELTOS (bytes medidos) de los capítulos del curso. Ausente/vacío = ninguno (facts de
   * siempre). Un recurso de un capítulo que no está en el Manifest es un error (el builder los filtra antes, con aviso).
   */
  practiceResources?: readonly ResolvedPracticeResource[] | null;
}

/** T5 (r57): archivo de trabajo de un capítulo en facts (lo que el paquete publica y el validador verifica). */
export interface ChapterResourceFacts {
  id: string;
  title: string;
  instructions: string;
  /** `application`: lo enlaza la Actividad de Aplicación del capítulo; `chapter`: material del capítulo. */
  relation: 'application' | 'chapter';
  filename: string;
  mimetype: string;
  bytes: number;
  sha256: string;
  origin: 'upload' | 'csv' | 'xlsx';
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
  /** Motor de carga horaria: SOLO en capítulos de práctica (sin presentación, Libro propio, video ni audiolibro). */
  kind?: 'practice';
  /**
   * Fase 2: minutos de la Actividad de Aplicación del capítulo (item application_activity del Manifest). SOLO en
   * capítulos con actividad: página del estudiante + solucionario oculto; entran al tiempo del capítulo.
   */
  applicationMinutes?: number;
  /**
   * Loop 9 B: minutos de la práctica guiada del capítulo de contenido (item guided_practice del Manifest). SOLO en
   * capítulos cuya práctica guiada tiene su documento validado en el paquete: entran al tiempo del capítulo.
   */
  guidedPracticeMinutes?: number;
  /**
   * T4 (r57): la Actividad de Aplicación se entrega como Tarea de Moodle (mod_assign). SOLO en capítulos con AA cuyo
   * modo efectivo es `assign`; ausente = página de siempre. `graded` = ítem de nota en su categoría.
   */
  applicationDelivery?: { mode: 'assign'; graded: boolean };
  /** T5 (r57): archivos de trabajo del capítulo (orden del perfil). Solo si hay alguno. */
  resources?: ChapterResourceFacts[];
  /**
   * T2 (r57): rótulos visibles de las fases del marco instruccional por bloque del capítulo (bloque → rótulo). SOLO si
   * el Blueprint trae plan de aprendizaje con `phaseLabels` activo; ausente = shell de siempre.
   */
  phaseLabels?: Partial<Record<FrameworkSlot, string>>;
  /** Diapositivas medidas de la presentación (0 en un capítulo de práctica: no tiene presentación). */
  slideCount: number;
  /**
   * P3: minutos estimados del capítulo (modelo study-time, redondeados a 5) desde las palabras MEDIDAS del
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
    /** Fase 2: capítulos con Actividad de Aplicación (solo si hay alguna). */
    applicationActivities?: number;
    /** Loop 9 B: capítulos con práctica guiada (solo si hay alguna). */
    guidedPractices?: number;
    /** T4 (r57): Actividades de Aplicación entregadas como Tarea (solo si hay alguna) y cuántas califican. */
    applicationAssigns?: number;
    applicationAssignsGraded?: number;
    /** T5 (r57): archivos de trabajo del curso (solo si hay alguno). */
    practiceResources?: number;
  };
  chapters: ChapterFacts[];
  modules: ModuleFacts[];
  /** `bankSize` solo si el examen final es un banco (EV6 P2-B3). */
  finalExam: { enabled: boolean; questionCount: number | null; bankSize?: number };
  assessment: {
    assessmentProfileVersion: number;
    kinds: Record<AssessableType, AssessmentFactsKind>;
    /**
     * r55 (R3/R4): nota mínima del CURSO (`passingGrade` base del perfil, 0–100) — la que aprueba el curso por la
     * nota final y la que nombran el cierre, el certificado y la info de las evaluaciones. Opcional solo para
     * leer facts guardados antes de r55; `buildCourseFacts` la emite siempre.
     */
    coursePassingGrade?: number;
    /**
     * r55 review r1 (M3): peso EFECTIVO (0–100) de cada categoría con ítems calificables — los del perfil, o los
     * normalizados igual que el resolver si una categoría vacía tenía peso > 0. Los textos de aprobación nombran
     * solo categorías con peso > 0. Opcional para leer facts anteriores (todas las categorías cuentan).
     */
    categoryWeights?: Partial<Record<AssessmentCategoryKey, number>>;
    /**
     * T4 (r57): entrega efectiva de las Actividades de Aplicación — SOLO si algún capítulo la entrega como Tarea
     * (sin Tareas, facts de siempre aunque el perfil traiga la clave).
     */
    application?: Omit<ResolvedApplicationDelivery, 'chapterModes'>;
  };
  audio: {
    welcomeSeconds: number;
    audiobookSeconds: number;
    audiobookParts: Array<{ chapterId: string; chapterNumber: number; seconds: number; offsetSeconds: number }>;
    /** r74: audiolibro entregado en partes aparte del paquete principal (ausente = embebido, como siempre). */
    delivery?: AudiobookDeliveryFacts;
  };
  libro: { wordCount: number; hasBibliography: boolean };
  /** `source` = etiqueta de origen (solo horas del documento de la institución); null = redacción neutra. */
  hours: { value: number; source: string | null } | null;
  /** T6 (r57): el paquete lleva la «Guía del docente» (página oculta de la sección 0). Solo si el perfil la pide. */
  teacherGuide?: true;
  /**
   * Motor de carga horaria: tiempo de estudio estimado del curso (modelo study-time con las medidas del
   * paquete). Solo si el empaque informó las palabras del experience. No se imprime en el shell.
   */
  studyTime?: { rulesVersion: number; courseEstimatedMinutes: number; courseEstimatedHours: number; usesPlannedValues: boolean; configId?: string };
  /**
   * r58 (I3): registro de horas del paquete (mismas líneas que `studyTime`, con categoría, base, evidencia, regla y
   * configuración; objetivo / estimado / asignado / observado = null / gap). Solo junto con `studyTime`. No se imprime en
   * el shell salvo el desglose opcional de la «Guía del docente» (`hoursModel.teacherGuideBreakdown`).
   */
  hoursReport?: HoursReport;
  /** r58 (I3): la «Guía del docente» muestra el desglose del registro (solo si la configuración lo pide). */
  hoursBreakdownInTeacherGuide?: true;
}

/** r74: audiolibro entregado por partes (paquete principal = archivo 1; las partes de audio = archivos 2..totalFiles). */
export interface AudiobookDeliveryFacts {
  /** parts = partes .mbz aparte (autocontenido); linked = en línea desde Cursia (un solo .mbz, dirección duradera). */
  mode: 'parts' | 'linked';
  totalFiles: number;
  parts: Array<{
    partNumber: number;
    seconds: number;
    segments: Array<{
      moduleId: string;
      moduleNumber: number;
      chapterNumbers: number[];
      seconds: number;
      chapters: Array<{ chapterId: string; chapterNumber: number; seconds: number; offsetSeconds: number }>;
    }>;
  }>;
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

/**
 * r55 review r1 (M3): pesos efectivos de las categorías con ítems (misma regla que `resolveAssessment` con
 * `itemCounts`): si una categoría vacía tenía peso > 0 se reparte entre las pobladas; si no, los del perfil.
 * Sin categorías pobladas (curso sin nota) → nada.
 */
function effectiveCategoryWeights(
  assessment: AssessmentProfile,
  counts: Record<AssessmentCategoryKey, number>,
): { categoryWeights?: Partial<Record<AssessmentCategoryKey, number>> } {
  // T4 (r57): `applications` solo existe si el perfil la pesa (Object.keys de sus pesos); su conteo = Tareas calificadas.
  const original = assessment.categoryWeights as Partial<Record<AssessmentCategoryKey, number>>;
  const keys = (Object.keys(original) as AssessmentCategoryKey[]);
  const populated = keys.filter((k) => counts[k] > 0);
  if (!populated.length) return {};
  const normalized = keys.some((k) => counts[k] === 0 && (original[k] as number) > 0);
  const w = normalized ? normalizeCategoryWeights(original, populated) : original;
  const out: Partial<Record<AssessmentCategoryKey, number>> = {};
  for (const k of populated) out[k] = w[k] as number;
  return { categoryWeights: out };
}

/** T2 (r57): rótulos de fase del capítulo (vacío sin plan de aprendizaje o con los rótulos apagados). */
function chapterPhaseLabels(bp: BlueprintSnapshotV2, sc: { design?: { framework?: string } }): { phaseLabels?: Partial<Record<FrameworkSlot, string>> } {
  const lp = bp.course.pedagogy?.learningPlan;
  const fw = sc.design?.framework;
  if (!lp || lp.phaseLabels !== true || typeof fw !== 'string') return {};
  const labels = frameworkSlotLabels(defaultFrameworkRegistry().get(fw));
  return Object.keys(labels).length ? { phaseLabels: labels } : {};
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
  const guidedIds = new Set<string>(input.guidedPracticeChapterIds ?? []);
  // T5 (r57): archivos de trabajo resueltos, por capítulo (orden del perfil).
  const resourcesByChapter = new Map<string, ChapterResourceFacts[]>();
  const resourceIds = new Set<string>();
  for (const r of input.practiceResources ?? []) {
    if (!r || typeof r.id !== 'string' || resourceIds.has(r.id)) fail(`archivo de trabajo inválido o repetido (${JSON.stringify(r?.id)})`);
    resourceIds.add(r.id);
    if (!Number.isInteger(r.bytes) || r.bytes < 1 || !/^[0-9a-f]{64}$/.test(r.sha256)) fail(`archivo de trabajo ${r.id} sin tamaño o sha256 medidos`);
    const one: ChapterResourceFacts = { id: r.id, title: r.title, instructions: r.instructions, relation: r.relation, filename: r.filename, mimetype: r.mimetype, bytes: r.bytes, sha256: r.sha256, origin: r.origin };
    resourcesByChapter.set(r.chapterId, [...(resourcesByChapter.get(r.chapterId) ?? []), one]);
  }
  const chapterResources = (id: string): { resources?: ChapterResourceFacts[] } => {
    const list = resourcesByChapter.get(id);
    return list && list.length ? { resources: list } : {};
  };
  const chapters: ChapterFacts[] = [];
  const modules: ModuleFacts[] = [];
  const knownChapterIds = new Set<string>();
  // Palabras que muestra cada capítulo (P3) → minutos con el modelo de tiempo, después de saber qué capítulos llevan «Repaso».
  const shownWords = new Map<string, { words: number; videoSeconds?: number }>();
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
      const practice = mc.kind === 'practice';
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
        ...(practice ? { kind: 'practice' as const } : {}),
        ...(mc.applicationMinutes !== undefined ? { applicationMinutes: mc.applicationMinutes } : {}),
        ...(mc.guidedPracticeMinutes !== undefined && guidedIds.has(mc.chapterId) ? { guidedPracticeMinutes: mc.guidedPracticeMinutes } : {}),
        // T4 (r57): modo efectivo de la AA (excepción del capítulo o el del curso); `page` = la página de siempre (sin clave).
        ...(chapterDeliveryMode(assessment.applicationDelivery, mc.chapterId, mc.applicationMinutes !== undefined) === 'assign'
          ? { applicationDelivery: { mode: 'assign' as const, graded: assessment.applicationDelivery?.grading.graded === true } }
          : {}),
        ...chapterResources(mc.chapterId),
        ...chapterPhaseLabels(bp, sc),
        slideCount: practice ? 0 : posInt(artifacts.slideCountByChapter?.[mc.chapterId], `slideCount del capítulo ${mc.chapterNumber}`),
      });
      if (itemKeys.has(`application_activity:${mc.chapterId}`) !== (mc.applicationMinutes !== undefined)) fail(`Actividad de Aplicación del capítulo ${mc.chapterNumber} incoherente con el Manifest`);
      if (itemKeys.has(`guided_practice:${mc.chapterId}`) !== (mc.guidedPracticeMinutes !== undefined)) fail(`práctica guiada del capítulo ${mc.chapterNumber} incoherente con el Manifest`);
      if (guidedIds.has(mc.chapterId) && mc.guidedPracticeMinutes === undefined) fail(`práctica guiada validada en el capítulo ${mc.chapterNumber}, que no la tiene en el Manifest`);
      // Loop 9 B: una práctica guiada del Manifest sin su documento validado nunca se omite en silencio: el paquete se rechaza.
      if (mc.guidedPracticeMinutes !== undefined && !guidedIds.has(mc.chapterId)) fail(`la práctica guiada del capítulo ${mc.chapterNumber} no llegó validada al paquete (falta su documento)`);
      if (practice && artifacts.slideCountByChapter?.[mc.chapterId] !== undefined) fail(`el capítulo de práctica ${mc.chapterNumber} no tiene presentación pero se informaron diapositivas`);
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
        shownWords.set(mc.chapterId, { words, videoSeconds: ch.videoEnabled ? vs : undefined });
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
  for (const id of resourcesByChapter.keys()) if (!knownChapterIds.has(id)) fail(`archivo de trabajo de un capítulo que no está en el Manifest (${id})`);
  for (const ch of chapters) {
    if ((ch.resources ?? []).some((r) => r.relation === 'application') && ch.applicationMinutes === undefined) fail(`archivo de trabajo de la Actividad de Aplicación del capítulo ${ch.number}, que no tiene Actividad de Aplicación`);
  }
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
  // Motor de carga horaria: el audiolibro narra los capítulos de CONTENIDO (la práctica no tiene parte).
  for (const c of chapters) if (c.kind === 'practice' && byId.has(c.id)) fail(`audiobookParts: el capítulo de práctica ${c.number} no tiene audiolibro`);
  const audiobookParts = chapters.filter((c) => c.kind !== 'practice').map((c) => {
    const seconds = byId.get(c.id);
    if (seconds === undefined) fail(`audiolibro sin la parte del capítulo ${c.number}`);
    const part = { chapterId: c.id, chapterNumber: c.number, seconds, offsetSeconds: offset };
    offset += seconds;
    return part;
  });

  // r74: audiolibro por partes — cada capítulo de contenido en exactamente un segmento, en orden, sin cruzar módulos.
  let delivery: AudiobookDeliveryFacts | undefined;
  if (artifacts.audiobookDelivery) {
    const dparts = Array.isArray(artifacts.audiobookDelivery.parts) ? artifacts.audiobookDelivery.parts : fail('audiobookDelivery.parts debe ser una lista');
    if (!dparts.length) fail('audiobookDelivery sin partes');
    const order = audiobookParts.map((p) => p.chapterId);
    const partById = new Map(audiobookParts.map((p) => [p.chapterId, p]));
    let cursor = 0;
    const dmode = artifacts.audiobookDelivery.mode === 'linked' ? 'linked' : artifacts.audiobookDelivery.mode === 'parts' ? 'parts' : fail('audiobookDelivery.mode debe ser parts o linked');
    delivery = {
      mode: dmode,
      totalFiles: dmode === 'linked' ? 1 : dparts.length + 1,
      parts: dparts.map((dp, pi) => {
        if (dp?.partNumber !== pi + 2) fail(`audiobookDelivery: la parte ${pi} debe ser la número ${pi + 2} (fue ${JSON.stringify(dp?.partNumber)})`);
        const segs = Array.isArray(dp.segments) && dp.segments.length ? dp.segments : fail(`audiobookDelivery: la parte ${dp.partNumber} no tiene segmentos`);
        const segments = segs.map((sg) => {
          const ids = Array.isArray(sg?.chapterIds) && sg.chapterIds.length ? sg.chapterIds : fail(`audiobookDelivery: segmento vacío en la parte ${dp.partNumber}`);
          let off = 0;
          const chs = ids.map((id) => {
            if (order[cursor] !== id) fail(`audiobookDelivery: el capítulo ${id} no sigue el orden del curso`);
            cursor++;
            const ap = partById.get(id) as { chapterId: string; chapterNumber: number; seconds: number };
            const x = { chapterId: id, chapterNumber: ap.chapterNumber, seconds: ap.seconds, offsetSeconds: off };
            off += ap.seconds;
            return x;
          });
          const mods = new Set(chs.map((x) => chapters.find((c) => c.id === x.chapterId)?.moduleId));
          if (mods.size !== 1) fail(`audiobookDelivery: un segmento de la parte ${dp.partNumber} mezcla módulos`);
          const first = chapters.find((c) => c.id === chs[0].chapterId) as ChapterFacts;
          return { moduleId: first.moduleId, moduleNumber: first.moduleNumber, chapterNumbers: chs.map((x) => x.chapterNumber), seconds: off, chapters: chs };
        });
        return { partNumber: dp.partNumber, seconds: segments.reduce((s, x) => s + x.seconds, 0), segments };
      }),
    };
    if (cursor !== order.length) fail(`audiobookDelivery cubre ${cursor} de ${order.length} capítulos con audiolibro`);
  }

  const libroWordCount = posInt(artifacts.libroWordCount, 'libroWordCount');
  // Motor de carga horaria: el tiempo de cada capítulo y del curso sale del modelo único (study-time) con las
  // MEDIDAS del paquete; lo no medido (preguntas de la actividad, tarjetas, textos del marco) usa el planificado.
  let studyTime: CourseFacts['studyTime'];
  let hoursReport: HoursReport | undefined;
  // r58 (I3): configuración del modelo de tiempo congelada en el Blueprint (sin ella, el default de siempre).
  let timeCfg: TimeModelConfig;
  try {
    timeCfg = timeModelConfigOf(bp);
  } catch (e) {
    fail(`configuración del modelo de tiempo: ${(e as Error).message}`);
  }
  const reviewCounts = input.reviewCardCountByChapter ?? {};
  for (const [id, n] of Object.entries(reviewCounts)) {
    if (!reviewIds.has(id)) fail(`tarjetas de «Repaso» de un capítulo sin «Repaso» (${id})`);
    posInt(n, `tarjetas de «Repaso» del capítulo ${id}`);
  }
  if (artifacts.experienceWordsByChapter) {
    // Aproximación documentada: el Libro compilado (palabras medidas) se reparte por igual entre los capítulos;
    // incluye además apertura, aperturas de módulo y bibliografía (unos cientos de palabras por capítulo).
    const contentChapterCount = chapters.filter((c) => c.kind !== 'practice').length;
    const libroPerChapter = Math.max(1, Math.round(libroWordCount / Math.max(1, contentChapterCount)));
    const byModule = new Map<string, ChapterFacts[]>();
    for (const ch of chapters) byModule.set(ch.moduleId, [...(byModule.get(ch.moduleId) ?? []), ch]);
    let est: StudyTimeEstimate;
    let lines: HourLine[];
    try {
      ({ estimate: est, lines } = estimateCourseStudyTimeDetailed({
        frame: true,
        welcomeAudio: true,
        welcomeAudioSeconds: welcomeSeconds,
        forum: true,
        finalExam: features.finalExam,
        ...(finalQ !== null ? { finalExamQuestions: finalQ } : {}),
        modules: modules.map((m) => ({
          moduleId: m.id,
          intro: true,
          exam: m.examEnabled,
          ...(m.examQuestionCount !== null ? { examQuestions: m.examQuestionCount } : {}),
          chapters: (byModule.get(m.id) ?? []).map((ch) => {
            const sw = shownWords.get(ch.id) as { words: number; videoSeconds?: number };
            const practiceCh = ch.kind === 'practice';
            return {
              chapterId: ch.id,
              ...(practiceCh ? { kind: 'practice' as const } : {}),
              pageWords: sw.words,
              libro: !practiceCh,
              ...(practiceCh ? {} : { libroWords: libroPerChapter }),
              presentation: !practiceCh,
              ...(practiceCh ? {} : { slides: ch.slideCount }),
              video: ch.videoEnabled,
              ...(sw.videoSeconds !== undefined ? { videoSeconds: sw.videoSeconds } : {}),
              ivAdvanced: features.ivAdvanced === 1,
              activity: ch.activityEnabled,
              review: ch.reviewCards === true,
              ...(reviewCounts[ch.id] !== undefined ? { reviewCards: reviewCounts[ch.id] } : {}),
              // Fase 2: la Actividad de Aplicación suma sus minutos al capítulo (y al curso).
              ...(ch.applicationMinutes !== undefined ? { applicationMinutes: ch.applicationMinutes } : {}),
              // Loop 9 B: la práctica guiada (validada) suma sus minutos al capítulo («Práctica y repaso»).
              ...(ch.guidedPracticeMinutes !== undefined ? { guidedPracticeMinutes: ch.guidedPracticeMinutes } : {}),
            };
          }),
        })),
      }, timeCfg));
    } catch (e) {
      fail(`tiempo de estudio: ${(e as Error).message}`);
    }
    const byId = new Map(est.modules.flatMap((m) => m.chapters.map((c) => [c.chapterId, c.displayMinutes] as const)));
    for (const ch of chapters) ch.estimatedMinutes = byId.get(ch.id);
    studyTime = { rulesVersion: est.rulesVersion, courseEstimatedMinutes: est.courseEstimatedMinutes, courseEstimatedHours: est.courseEstimatedHours, usesPlannedValues: est.usesPlannedValues, ...(est.configId ? { configId: est.configId } : {}) };
    // r58 (I3): las horas del documento no se congelan en el Blueprint (solo el objetivo): declarado = null con motivo.
    try {
      hoursReport = buildHoursReport({ stage: 'package', estimate: est, lines, config: timeCfg, targetHours: bp.course.targetHours ?? null, declared: null, declaredReason: 'document_hours_not_frozen' });
    } catch (e) {
      fail(`registro de horas: ${(e as Error).message}`);
    }
  }
  let hours: CourseFacts['hours'] = null;
  if (input.hours !== undefined && input.hours !== null) {
    if (typeof input.hours !== 'number' || !Number.isFinite(input.hours) || input.hours <= 0) fail('hours debe ser un número > 0');
    hours = { value: input.hours, source: input.hoursSource === 'document' ? HOURS_SOURCE_LABEL : null };
  }

  const activitiesByVariant = {
    h5p: chapters.filter((c) => c.activityVariant === 'h5p').length,
    scorm: chapters.filter((c) => c.activityVariant === 'scorm').length,
  };
  const exams = modules.filter((m) => m.examEnabled).length;
  // T4 (r57): Tareas de entrega (y las calificadas, que son ítems de su categoría).
  const assignChapters = chapters.filter((c) => c.applicationDelivery?.mode === 'assign');
  const gradedAssigns = assignChapters.filter((c) => c.applicationDelivery?.graded).length;
  const deliveryCategory = assessment.applicationDelivery?.grading.graded === true ? assessment.applicationDelivery.grading.category : null;
  const appDelivery = assignChapters.length && assessment.applicationDelivery
    ? (({ chapterModes: _cm, ...rest }) => rest)(resolveApplicationDelivery(assessment.applicationDelivery))
    : null;
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
      ...(chapters.some((c) => c.applicationMinutes !== undefined) ? { applicationActivities: chapters.filter((c) => c.applicationMinutes !== undefined).length } : {}),
      ...(chapters.some((c) => c.guidedPracticeMinutes !== undefined) ? { guidedPractices: chapters.filter((c) => c.guidedPracticeMinutes !== undefined).length } : {}),
      ...(assignChapters.length ? { applicationAssigns: assignChapters.length, applicationAssignsGraded: assignChapters.filter((c) => c.applicationDelivery?.graded).length } : {}),
      ...(resourceIds.size ? { practiceResources: resourceIds.size } : {}),
    },
    chapters,
    modules,
    finalExam: { enabled: features.finalExam, questionCount: finalQ, ...(finalBank !== undefined ? { bankSize: finalBank } : {}) },
    assessment: {
      assessmentProfileVersion: assessment.assessmentProfileVersion,
      kinds,
      coursePassingGrade: assessment.passingGrade,
      ...effectiveCategoryWeights(assessment, {
        practice: chapters.filter((c) => c.videoEnabled).length + activitiesByVariant.h5p + activitiesByVariant.scorm + (deliveryCategory === 'practice' ? gradedAssigns : 0),
        moduleExams: exams,
        finalExam: features.finalExam ? 1 : 0,
        applications: deliveryCategory === 'applications' ? gradedAssigns : 0,
      }),
      ...(appDelivery ? { application: appDelivery } : {}),
    },
    audio: { welcomeSeconds, audiobookSeconds: offset, audiobookParts, ...(delivery ? { delivery } : {}) },
    libro: { wordCount: libroWordCount, hasBibliography: artifacts.libroHasBibliography !== false },
    hours,
    ...(studyTime ? { studyTime } : {}),
    ...(hoursReport ? { hoursReport } : {}),
    ...(hoursReport && timeCfg.teacherGuideBreakdown ? { hoursBreakdownInTeacherGuide: true as const } : {}),
    ...(assessment.teacherGuide?.include === true ? { teacherGuide: true as const } : {}),
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

// ─── P3: palabras del experience (el tiempo lo calcula el modelo único de study-time) ───

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
  add(facts.assessment.coursePassingGrade);
  // T4 (r57): cifras de la entrega que el shell nombra (nota máxima / de referencia, archivos, MB, días).
  const ap = facts.assessment.application;
  if (ap) {
    add(ap.maxGrade);
    add(ap.gradepass);
    add(ap.dueOffsetDays);
    add(ap.submission.maxFiles);
    add(deliveryMegabytes(ap.submission.maxBytes));
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
  // r74: partes del audiolibro (número de archivo, total de archivos, duraciones y marcas por segmento).
  const dl = facts.audio.delivery;
  if (dl) {
    add(dl.totalFiles);
    for (const p of dl.parts) {
      add(p.partNumber);
      addDuration(p.seconds);
      for (const sg of p.segments) {
        addDuration(sg.seconds);
        for (const x of sg.chapters) addDuration(x.offsetSeconds);
      }
    }
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

/**
 * V542 fix round 3 (N1): prosa LLM que muestra CADA label del shell, por idnumber — nunca un fondo común. Un label
 * de curso recibe solo su campo de la intro del curso; `cv3:module_intro:<id>` solo la prosa de SU módulo; los
 * demás labels no tienen prosa (plantilla estricta). Fuente única para el builder (expectations) y el render.
 */
export const COURSE_INTRO_PROSE_FIELD_BY_LABEL: Readonly<Record<string, 'welcome' | 'competencies' | 'methodology_note' | 'closing'>> = Object.freeze({
  'cv3:shell:welcome': 'welcome',
  'cv3:shell:competencies': 'competencies',
  'cv3:shell:methodology': 'methodology_note',
  'cv3:shell:closing': 'closing',
});
export function courseIntroProse(intro: unknown, field: 'welcome' | 'competencies' | 'methodology_note' | 'closing'): string[] {
  const v = intro && typeof intro === 'object' ? (intro as Record<string, unknown>)[field] : undefined;
  if (typeof v === 'string') return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
export function moduleIntroProse(intro: unknown): string[] {
  const i = (intro && typeof intro === 'object' ? intro : {}) as Record<string, unknown>;
  const out: string[] = [];
  if (typeof i.presentation === 'string') out.push(i.presentation);
  if (Array.isArray(i.outcomes)) for (const x of i.outcomes) if (typeof x === 'string') out.push(x);
  if (Array.isArray(i.journey)) for (const j of i.journey as any[]) if (j && typeof j.line === 'string') out.push(j.line);
  return out;
}
export function shellProseByLabel(courseIntro: unknown, moduleIntros: ReadonlyMap<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [idn, field] of Object.entries(COURSE_INTRO_PROSE_FIELD_BY_LABEL)) out[idn] = courseIntroProse(courseIntro, field);
  for (const [moduleId, intro] of moduleIntros) out[`cv3:module_intro:${moduleId}`] = moduleIntroProse(intro);
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

/** T4 (r57): MB de la entrega que muestra el shell (entero, hacia abajo; mínimo 1). */
export function deliveryMegabytes(bytes: number): number {
  return Math.max(1, Math.floor(bytes / (1024 * 1024)));
}
