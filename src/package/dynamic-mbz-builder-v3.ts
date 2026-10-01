/**
 * dynamic-mbz-builder-v3.ts — Cursia V2.1 R12: `.mbz` de Moodle para
 * Manifests rulesVersion 3 (audit §E, §F, §K, §Q; brief R12).
 *
 * Consume, nunca genera: todos los contenidos (JSON/markdown del LLM, PDF/PNG
 * de Gamma, MP3 de TTS, video de Videogen/YouTube, GIFT) entran ya resueltos
 * por parámetro. Las piezas vienen de los bloques anteriores:
 *   R1 tema · R2 Visual Components · R6 evaluación → XML · R7 H5P content-only ·
 *   R8 video interactivo · R9 tarjeta de presentación · R10 audio · R11a facts,
 *   shell y ensamblador de capítulo.
 *
 * Reglas:
 *  - PURO y DETERMINÍSTICO: sin I/O, sin reloj (el `ts` se inyecta), sin azar.
 *    Mismos insumos → mismos bytes (entradas del zip con fecha fija, orden fijo,
 *    ids por asignador monotónico, stamps derivados).
 *  - FALLA FUERTE: un contenido faltante, un número que no sale de facts, un
 *    label que no pasa CLEAN_SAFE, un H5P no calificable en Moodle, una
 *    categoría ponderada vacía o un token `$@…$` mal tipado abortan el paquete.
 *  - Todo número visible sale de `buildCourseFacts` con datos MEDIDOS
 *    (páginas del PDF, duración de los MP3, preguntas del GIFT, palabras del Libro).
 *  - Estructura por UUID: cada módulo del curso lleva `idnumber` = `cv3:…`
 *    derivado del item_key del Manifest (trazable tras restaurar).
 *  - v1/v2 no cambian: este archivo es independiente de `dynamic-mbz-builder.ts`.
 */
import * as JSZip from 'jszip';
import {
  MoodleVersionInfo,
  esc,
  forumXml,
  gradesXml,
  inforefXml,
  labelXmlWithCtx,
  moduleXml,
  parseGIFT,
  resolveMoodleVersion,
  safeActivityName,
  sectionXml,
  sha1Buf,
  xmlEsc,
} from './mbz-common';
import {
  ResolvedAssessment,
  applyXmlFields,
  assertCategoriesPopulated,
  assessmentItemCountsForPackage,
  completionCriteriaFor,
  courseCompletionXml,
  gradeItemXml,
  gradebookXml,
  gradedModuleXml,
  h5pactivityXml,
  resolveAssessment,
} from './assessment';
import type { AssessmentCategoryKey, CompletionCandidate } from './assessment/resolve-assessment';
import {
  CURSIA_H5P_PROFILE_V1,
  H5P_PACKAGE_MIMETYPE,
  assertH5pGradableInMoodle,
  buildBlanks,
  buildContentOnlyH5p,
  buildDragText,
  buildQuestionSet,
  buildVideoActivity,
  h5pProfileVersion,
  h5pTitle,
  validateBlanksInput,
  validateDragTextInput,
  validateQuestionSetInput,
  videoInlineIntroHtml,
  videoPackageFilename,
} from './h5p';
import { assembleAudiobook, mp3DurationSeconds } from './audio';
import { pdfPageCount, presentationCardHtml } from './presentation';
import type { GenerationManifestV1 } from '../modules/generation-manifests/generation-manifest-builder';
import type { BlueprintSnapshotV2 } from '../modules/course-blueprints/blueprint-snapshot';
import type { AssessableType, AssessmentProfile } from '../modules/course-profiles/course-profiles';
import {
  PresentationProfileInput,
  ResolvedTheme,
  THEME_ENGINE_VERSION,
  moduleColor,
  resolveTheme,
  themeSha256,
  validateTheme,
} from '../modules/theme-engine';
import { ChapterExperience, VC_RENDER_STYLE_VERSION, VC_RUNTIME_VERSION, VC_SCHEMA_VERSION } from '../modules/visual-components';
import {
  CTA_BADGES,
  CourseFacts,
  CourseIntroV3,
  ModuleIntroV3,
  SHELL_AUDIOBOOK_FILE,
  SHELL_AUDIO_WELCOME_FILE,
  ShellLabel,
  assembleAllChapters,
  assertValidCourseIntroV3,
  assertValidModuleIntroV3,
  audioWelcomeLabel,
  audiobookLabel,
  buildCourseFacts,
  certificateTeacherLabel,
  closingLabel,
  competenciesLabel,
  examExplanationsBankPage,
  examExplanationsGiftPage,
  examInfoLabel,
  examsTeacherLabel,
  experienceMovementWords,
  finalExamInfoLabel,
  finalExamNextLabel,
  libroCardLabel,
  methodologyLabel,
  moduleIntroLabel,
  moduleNextLabel,
  pendingVideoNoticeChapterIds,
  routeLabel,
  routeStartLabel,
  sectionLayoutFromFacts,
  validateH5pActivityPayload,
  welcomeLabel,
  welcomeStartLabel,
} from '../modules/course-shell';
import type { H5pActivityType } from '../modules/course-shell';
import { PackagingPlanV3, buildPackagingPlanV3, packagingPlanV3Sha256 } from '../modules/dynamic-packaging/packaging-plan-v3';
import { compileLibroHtmlV3, libroWordCount } from './v3/libro-v3';
import { downscaleCoverPng } from './v3/png-downscale';
import { ActivityFrameTone, activityPackageFilename, h5pActivityInlineIntroHtml, introThemeFrom, scormIntroHtml } from './v3/activity-intro';
import { moduleTone } from '../modules/visual-components/edu';
import { groundColor } from '../modules/visual-components/render';
import { IdAllocator, buildQuizV3, parseScormManifestIds, scormActivityXmlV3 } from './v3/moodle-activities-v3';
import { expectedExamPlan, planSlotCount, validateExamBank } from '../modules/course-shell/exam-bank';
import type { ExamBankV1 } from '../modules/course-shell/exam-bank';
import { COURSE_BADGE_BACKUP_ID, COURSE_BADGE_DEFAULT_ISSUER, courseBadgeImages, courseBadgeName, courseBadgeXml } from './v3/course-badge';

/**
 * Id del curso DENTRO del backup (`<course id>`, `original_course_id`) y su contexto
 * (`original_course_contextid`). La restauración los remapea al curso nuevo: el token
 * $@BADGESVIEWBYID*1@$ (decode rule 'course') y el criterio `course_1` de la insignia.
 * EV6 T3: el contexto del curso NO puede ser 1 = `original_system_contextid`: la restauración
 * mapea el contexto viejo 1 al de SISTEMA y los archivos del curso (la imagen de la insignia,
 * `badges/badgeimage`) terminaban en el contexto de sistema (probado en el Moodle local).
 */
export const MBZ_V3_COURSE_BACKUP_ID = 1;
export const MBZ_V3_COURSE_BACKUP_CONTEXTID = 2;
export const MBZ_V3_SYSTEM_BACKUP_CONTEXTID = 1;

/**
 * Versión del builder v3. Entra en la clave de reuse v3 (y SOLO en la v3:
 * `DYNAMIC_MBZ_BUILDER_VERSION` de v1/v2 no cambia, así sus paquetes y claves
 * siguen idénticos).
 *
 * REGLA (review G6 M9): TODO cambio que altere el `.mbz` para los mismos
 * insumos — plantillas del shell/capítulo (R11a), tarjeta (R9), intros de
 * actividad, Libro v3, XML — exige subir esta versión; si no, el reuse sirve
 * paquetes viejos. Hoy `hours` no se cablea desde el worker (no hay dato de
 * setup en el backend); el día que se cablee debe entrar en la clave de reuse.
 * 3.0.1 (fix round 1 G6): Libro sin links inseguros (M2).
 * 3.0.2 (F1/I3): categorías vacías fuera del gradebook, pesos normalizados y
 * curso sin nota (completion por vista del Libro Guía).
 * 3.0.3 (aceptación staging): tarjetas con borde completo en vez de franja lateral
 * (shell, tarjeta, intros, Libro) y sin reintento dentro del intento en IV/QuestionSet (HD-V21-22).
 * 3.0.4 (R14): bibliografía verificada del Libro (verified-bibliography.ts) y normalización de
 * comparaciones con la columna del rótulo (render.ts, #28) — un paquete anterior no se reutiliza.
 * 3.1.0 (EV6): una sección por capítulo / evaluación / examen final / cierre (cierre DESPUÉS del
 * examen final), `coursedisplay` = 1 (una sección por página) y botones de navegación entre
 * secciones («Comenzar el curso →», «Continuar con el capítulo N →», …).
 * 3.2.0 (EV6 T3): certificado nativo = insignia de curso (badges.xml + imagen f1/f2/f3,
 * setting `badges` = 1), la evaluación final SIEMPRE es criterio de completion y el cierre
 * trae el panel «Tu certificado» con el enlace $@BADGESVIEWBYID*1@$; fix 0b: label oculto
 * (visible=0) para docentes en el cierre con el paso «Habilitar acceso» de la insignia.
 * 3.3.0 (EV6 P2-B1): política de revisión del quiz (solo nota hasta el cierre) y
 * `completionattemptsexhausted`.
 * 3.4.0 (EV6 P2-B3): exámenes con banco `dynamic_exam_bank_json` → categorías por capítulo|módulo ×
 * tipo y slots aleatorios (`question_set_reference`), retroalimentación por opción + general;
 * emparejamiento del banco = definición como subpregunta y término como opción (fix 1). Los
 * paquetes con exámenes GIFT quedan byte a byte iguales a 3.3.0 (el bump invalida solo el reuse).
 * 3.5.0 (P3, sistema visual educativo 2.0): labels con rótulo/forma/color por rol pedagógico, apertura
 * «Capítulo N de T · ~X min» (minutos en facts desde las palabras medidas del experience), riel
 * «Dónde estás» del módulo y la actividad H5P/SCORM enmarcada con el tono del módulo.
 * 3.6.0 (EV6 P2-B4): página «Respuestas explicadas» (mod_page) después de cada evaluación, visible
 * solo al aprobar o agotar los intentos (availability e=1 | e=3, show:false, downloadcontent 0);
 * la info del examen la anuncia; nota para docentes (acceso condicional, intentos adicionales) en el
 * label oculto del certificado o en `cv3:shell:exams_teacher` al inicio de la primera evaluación.
 */
export const DYNAMIC_MBZ_BUILDER_VERSION_V3 = '3.6.0';

/**
 * EV6 P2-B4 (P2-design §1.3, ruling 1): con intentos limitados la página se desbloquea si el quiz está
 * completo (e=1, que también acepta COMPLETE_PASS) O completo-y-reprobado (e=3 = intentos agotados,
 * gracias a completionattemptsexhausted=1). `show:false`: oculta hasta entonces.
 * Fix 1 (C1): con intentos ILIMITADOS (attempts 0) B1 emite completionattemptsexhausted=0 y Moodle marca
 * COMPLETE_FAIL tras UN intento reprobado → e=3 abriría el banco y el estudiante reintentaría con las
 * respuestas. Ahí la condición es SOLO aprobar (e=1).
 */
export function examExplanationsAvailability(quizMid: number, attempts: number): string {
  if (!Number.isInteger(quizMid) || quizMid < 1) throw new Error(`MBZ_V3_INVARIANT: moduleid de quiz inválido (${quizMid})`);
  if (!Number.isInteger(attempts) || attempts < 0) throw new Error(`MBZ_V3_INVARIANT: intentos inválidos (${attempts})`);
  if (attempts === 0) return `{"op":"|","show":false,"c":[{"type":"completion","cm":${quizMid},"e":1}]}`;
  return `{"op":"|","show":false,"c":[{"type":"completion","cm":${quizMid},"e":1},{"type":"completion","cm":${quizMid},"e":3}]}`;
}
/** Versión del renderer de Visual Components que entra en la clave de reuse. */
export const VC_RENDERER_VERSION = `vc${VC_SCHEMA_VERSION}-rt${VC_RUNTIME_VERSION}-theme${THEME_ENGINE_VERSION}-style${VC_RENDER_STYLE_VERSION}`;

/** Fecha fija de toda entrada del zip (UTC). */
export const MBZ_V3_ZIP_FIXED_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

// ─── Entradas ──────────────────────────────────────────────────────────────

export type ActivityContentV3 =
  | { variant: 'h5p'; payload: unknown }
  | { variant: 'scorm'; html: string; manifestXml: string };

export interface DynamicPackageContentsV3 {
  courseIntro: unknown;
  moduleIntros: Map<string, unknown>;
  contentMd: Map<string, string>;
  experiences: Map<string, unknown>;
  /** chapterId → bytes del PDF y de la portada (reales, o sintéticos si el run es mock). */
  presentations: Map<string, { pdf: Buffer; cover: Buffer; mock?: boolean }>;
  /** chapterId → video publicado (YouTube) con su duración MEDIDA. */
  videos: Map<string, { youtubeId: string; durationSec: number }>;
  videoInteractions: Map<string, unknown>;
  activities: Map<string, ActivityContentV3>;
  examGift: Map<string, string>;
  finalExamGift?: string | null;
  /**
   * EV6 P2: exámenes cuyo artifact es el banco `dynamic_exam_bank_json` (moduleId → banco).
   * P2-B3: se empaquetan como quiz de slots aleatorios por hoja (capítulo|módulo × tipo); un
   * módulo trae GIFT o banco, nunca ambos. El builder re-valida cada banco (plan congelado +
   * evidencia contra `contentMd`) y falla fuerte con EXAM_BANK_INVALID.
   */
  examBanks?: Map<string, ExamBankV1>;
  finalExamBank?: ExamBankV1 | null;
  audioWelcome: Buffer;
  audiobookChapters: Map<string, Buffer>;
}

export interface BuildDynamicMbzV3Input {
  manifest: GenerationManifestV1;
  blueprint: BlueprintSnapshotV2;
  manifestId?: number | null;
  /** Perfil de evaluación VIGENTE (course_profiles o default). */
  assessmentProfile: AssessmentProfile;
  /** Perfil de presentación resuelto (course_profiles, fallback legacy o default v3). */
  presentation: PresentationProfileInput;
  contents: DynamicPackageContentsV3;
  /** Reloj inyectado (segundos UNIX): el builder nunca lee el reloj. */
  ts: number;
  moodleVersion?: string;
  /** Horas del setup (se muestran etiquetadas como definidas por la institución). */
  hours?: number | null;
  /** Nivel de render de los labels (default ENHANCED sobre la base CLEAN_SAFE). */
  level?: 'enhanced' | 'clean_safe';
  /**
   * EV6 T5: capítulos cuyo video todavía es de vista previa. Su video (y sus interacciones) se
   * omiten del paquete; nunca se presenta un video simulado como real.
   */
  pendingVideoChapterIds?: readonly string[] | null;
}

export interface MbzV3H5pPackage {
  itemKey: string;
  filename: string;
  mainLibrary: string;
  sha1: string;
  bytes: number;
}

export interface MbzV3Expectations {
  facts: CourseFacts;
  resolved: ResolvedAssessment;
  h5pProfileVersion: number;
}

export interface BuildDynamicMbzV3Result {
  mbz: Buffer;
  expectations: MbzV3Expectations;
  summary: {
    builderVersion: string;
    moodleVersion: string;
    planSha256: string;
    themeSha256: string;
    themeFamily: string;
    themeMode: string;
    h5pProfileVersion: number;
    vcRendererVersion: string;
    h5pPackages: MbzV3H5pPackage[];
    mockPresentationChapters: string[];
    /** EV6 T5: videos omitidos por estar pendientes (vista previa) y si el capítulo lleva el aviso. */
    pendingVideos: Array<{ itemKey: string; chapterId: string; chapterNumber: number; title: string; notice: boolean }>;
    warnings: string[];
    counts: CourseFacts['counts'];
    /** F1 (I3): resultado de la normalización de pesos (ver `assessmentPackageSummary`). */
    assessment: AssessmentPackageSummary;
  };
}

/** F1 (I3): lo que el resumen del paquete registra de la evaluación resuelta. */
export interface AssessmentPackageSummary {
  weightsNormalized: boolean;
  originalWeights: Partial<Record<AssessmentCategoryKey, number>>;
  weights: Partial<Record<AssessmentCategoryKey, number>>;
  emptyCategories: AssessmentCategoryKey[];
  withoutGrades: boolean;
}

/** F1 (I3): resumen de una evaluación resuelta CON `itemCounts` (falla si no lo fue). */
export function assessmentPackageSummary(resolved: ResolvedAssessment): AssessmentPackageSummary {
  if (typeof resolved.weightsNormalized !== 'boolean' || typeof resolved.withoutGrades !== 'boolean' || !resolved.originalWeights || !resolved.emptyCategories) {
    throw new Error('ASSESSMENT_INVALID_FACTS: la evaluación del paquete v3 debe resolverse con itemCounts');
  }
  const weights: Partial<Record<AssessmentCategoryKey, number>> = {};
  for (const c of resolved.categories) weights[c.key] = c.weight;
  return {
    weightsNormalized: resolved.weightsNormalized,
    originalWeights: { ...resolved.originalWeights },
    weights,
    emptyCategories: [...resolved.emptyCategories],
    withoutGrades: resolved.withoutGrades,
  };
}

/**
 * F1 (I3): avisos del paquete derivados de la evaluación resuelta:
 * `course_without_grades` y `assessment_weights_normalized:<orig>-><final>`.
 */
export function assessmentPackageWarnings(resolved: ResolvedAssessment): string[] {
  const s = assessmentPackageSummary(resolved);
  if (s.withoutGrades) return ['course_without_grades'];
  if (!s.weightsNormalized) return [];
  const fmt = (w: Partial<Record<AssessmentCategoryKey, number>>) =>
    (Object.keys(w) as AssessmentCategoryKey[]).map((k) => `${k}=${w[k]}`).join(',');
  return [`assessment_weights_normalized:${fmt(s.originalWeights)}->${fmt(s.weights)}`];
}

export class PackagingV3ContentMissingError extends Error {
  constructor(public readonly missing: string[]) {
    super(`PACKAGING_V3_CONTENT_MISSING: faltan ${missing.length} contenido(s): ${missing.join(', ')}`);
    this.name = 'PackagingV3ContentMissingError';
  }
}

// ─── ids fijos ─────────────────────────────────────────────────────────────

const CAT_ID: Record<AssessmentCategoryKey, number> = { practice: 2, moduleExams: 3, finalExam: 4 };
const NULL = '$@NULL@$';
const EMPTY_SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

const BOIL = {
  roles: '<?xml version="1.0" encoding="UTF-8"?>\n<roles>\n  <role_overrides>\n  </role_overrides>\n  <role_assignments>\n  </role_assignments>\n</roles>',
  calendar: '<?xml version="1.0" encoding="UTF-8"?>\n<events>\n</events>',
  gradeHistory: '<?xml version="1.0" encoding="UTF-8"?>\n<grade_history>\n  <grade_grades>\n  </grade_grades>\n</grade_history>',
  competencies: '<?xml version="1.0" encoding="UTF-8"?>\n<course_module_competencies>\n  <competencies>\n  </competencies>\n</course_module_competencies>',
  filters: '<?xml version="1.0" encoding="UTF-8"?>\n<filters>\n  <filter_actives>\n  </filter_actives>\n  <filter_configs>\n  </filter_configs>\n</filters>',
  completion: '<?xml version="1.0" encoding="UTF-8"?>\n<completions>\n  <completionviews>\n  </completionviews>\n</completions>',
  comments: '<?xml version="1.0" encoding="UTF-8"?>\n<comments>\n</comments>',
  xapistate: '<?xml version="1.0" encoding="UTF-8"?>\n<xapistate>\n</xapistate>',
  contentbank: '<?xml version="1.0" encoding="UTF-8"?>\n<contents>\n</contents>',
};

interface FileEntry {
  id: number;
  hash: string;
  ctx: number;
  component: string;
  filearea: string;
  filename: string;
  size: number;
  mime: string | null;
  /** itemid del archivo (0 salvo la imagen de la insignia: id de la insignia en el backup). */
  itemid?: number;
}

interface ActivityRef {
  mid: number;
  aid: number;
  ctx: number;
  secnum: number;
  modname: string;
  title: string;
  dir: string;
  idnumber: string;
}

/** Escritor del zip: fecha fija, sin carpetas implícitas, blobs deduplicados por sha1. */
class MbzWriter {
  readonly zip = new JSZip();
  readonly files: FileEntry[] = [];
  readonly activities: ActivityRef[] = [];
  readonly sectionSeq = new Map<number, number[]>();
  readonly modnameByMid = new Map<number, string>();
  private readonly blobs = new Set<string>();
  private fileId = 1;
  private mid = 1000;
  private aid = 1;
  private ctx = 100;
  private gradeItemId = 100;
  private gradeSort = 10;
  readonly idnumbers = new Set<string>();

  constructor(readonly ts: number, readonly MV: MoodleVersionInfo) {}

  put(name: string, data: string | Buffer | Uint8Array): void {
    this.zip.file(name, data, { date: MBZ_V3_ZIP_FIXED_DATE, createFolders: false });
  }

  blob(data: Buffer | string): { hash: string; size: number } {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const hash = sha1Buf(buf);
    if (!this.blobs.has(hash)) {
      this.put(`files/${hash.slice(0, 2)}/${hash}`, buf);
      this.blobs.add(hash);
    }
    return { hash, size: buf.length };
  }

  addFile(ctx: number, component: string, filearea: string, filename: string, data: Buffer | string, mime: string, itemid = 0): number {
    const { hash, size } = this.blob(data);
    const id = this.fileId++;
    this.files.push({ id, hash, ctx, component, filearea, filename, size, mime, ...(itemid ? { itemid } : {}) });
    return id;
  }

  addDirEntry(ctx: number, component: string, filearea: string): number {
    const id = this.fileId++;
    this.files.push({ id, hash: EMPTY_SHA1, ctx, component, filearea, filename: '.', size: 0, mime: null });
    return id;
  }

  newActivity(modname: string, secnum: number, title: string, idnumber: string): ActivityRef {
    if (!/^cv3:[A-Za-z0-9:_.#-]{1,96}$/.test(idnumber) || idnumber.length > 100) throw new Error(`MBZ_V3_IDNUMBER_INVALID: ${idnumber}`);
    if (this.idnumbers.has(idnumber)) throw new Error(`MBZ_V3_IDNUMBER_DUPLICATE: ${idnumber}`);
    this.idnumbers.add(idnumber);
    const ref: ActivityRef = {
      mid: this.mid++, aid: this.aid++, ctx: this.ctx++, secnum, modname, title, idnumber,
      dir: '',
    };
    ref.dir = `activities/${modname}_${ref.mid}`;
    this.activities.push(ref);
    this.modnameByMid.set(ref.mid, modname);
    if (!this.sectionSeq.has(secnum)) this.sectionSeq.set(secnum, []);
    (this.sectionSeq.get(secnum) as number[]).push(ref.mid);
    return ref;
  }

  nextGradeItem(): { id: number; sortorder: number } {
    return { id: this.gradeItemId++, sortorder: this.gradeSort++ };
  }

  boilerplate(dir: string): void {
    this.put(`${dir}/roles.xml`, BOIL.roles);
    this.put(`${dir}/calendar.xml`, BOIL.calendar);
    this.put(`${dir}/grade_history.xml`, BOIL.gradeHistory);
    this.put(`${dir}/competencies.xml`, BOIL.competencies);
    this.put(`${dir}/filters.xml`, BOIL.filters);
    this.put(`${dir}/completion.xml`, BOIL.completion);
    this.put(`${dir}/comments.xml`, BOIL.comments);
    this.put(`${dir}/xapistate.xml`, BOIL.xapistate);
  }
}

function inforef(fileIds: number[], gradeItemIds: number[] = [], qcats: number[] = []): string {
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<inforef>\n';
  if (fileIds.length) x += `  <fileref>\n${fileIds.map((id) => `    <file><id>${id}</id></file>`).join('\n')}\n  </fileref>\n`;
  if (gradeItemIds.length) x += `  <grade_itemref>\n${gradeItemIds.map((id) => `    <grade_item><id>${id}</id></grade_item>`).join('\n')}\n  </grade_itemref>\n`;
  if (qcats.length) x += `  <question_categoryref>\n${qcats.map((id) => `    <question_category><id>${id}</id></question_category>`).join('\n')}\n  </question_categoryref>\n`;
  return x + '</inforef>';
}

function withIdnumber(xml: string, idnumber: string): string {
  return applyXmlFields(xml, { idnumber: xmlEsc(idnumber) });
}

/** Tokens `$@XVIEWBYID*mid@$` → modname del destino. */
const TOKEN_MODNAME: Record<string, string> = {
  SCORM: 'scorm', QUIZ: 'quiz', RESOURCE: 'resource', PAGE: 'page', URL: 'url', H5PACTIVITY: 'h5pactivity', LABEL: 'label', FORUM: 'forum',
};

/** Falla fuerte ante cualquier token `$@…$` que no apunte a un módulo del paquete del tipo correcto. */
export function assertTokensV3(html: string, modnameByMid: Map<number, string>, where: string, sectionNums?: Set<number>, courseBackupId?: number): void {
  const bad: string[] = [];
  if (/cursia-cta:\/\//.test(html)) bad.push('marcador cursia-cta sin resolver');
  for (const m of html.matchAll(/\$@([A-Z0-9_]+)(?:\*(\d+))?@\$/g)) {
    const kind = m[1];
    const idStr = m[2];
    // Edu EV3: enlace a una sección del paquete (botón «Continuar con el módulo…»).
    if (kind === 'COURSESECTIONBYID') {
      if (!idStr || !sectionNums || !sectionNums.has(Number(idStr))) bad.push(m[0]);
      continue;
    }
    // EV6 (T3): página de insignias (certificado) del curso del backup.
    if (kind === 'BADGESVIEWBYID') {
      if (!idStr || courseBackupId === undefined || Number(idStr) !== courseBackupId) bad.push(m[0]);
      continue;
    }
    const want = /^(.+)VIEWBYID$/.exec(kind)?.[1];
    const modname = want ? TOKEN_MODNAME[want] : undefined;
    if (!modname || !idStr || modnameByMid.get(Number(idStr)) !== modname) bad.push(m[0]);
  }
  if (bad.length) throw new Error(`MBZ_V3_TOKEN_INVALID: ${where}: ${bad.join(', ')}`);
}

// ─── Builder ───────────────────────────────────────────────────────────────

function collectMissing(plan: PackagingPlanV3, c: DynamicPackageContentsV3): string[] {
  const missing: string[] = [];
  if (!c.courseIntro) missing.push(plan.keys.courseIntro);
  if (!Buffer.isBuffer(c.audioWelcome) || c.audioWelcome.length === 0) missing.push(plan.keys.audioWelcome);
  if (plan.keys.finalExam && !c.finalExamBank && (typeof c.finalExamGift !== 'string' || !c.finalExamGift.trim())) missing.push(plan.keys.finalExam);
  for (const m of plan.modules) {
    if (!c.moduleIntros.has(m.moduleId)) missing.push(m.keys.moduleIntro);
    if (m.keys.exam && !c.examBanks?.has(m.moduleId) && !(c.examGift.get(m.moduleId) ?? '').trim()) missing.push(m.keys.exam);
    for (const ch of m.chapters) {
      const id = ch.chapterId;
      if (!(c.contentMd.get(id) ?? '').trim()) missing.push(ch.keys.content);
      if (!c.experiences.has(id)) missing.push(ch.keys.experience);
      const p = c.presentations.get(id);
      if (!p || !Buffer.isBuffer(p.pdf) || !Buffer.isBuffer(p.cover)) missing.push(ch.keys.presentation);
      if (!Buffer.isBuffer(c.audiobookChapters.get(id))) missing.push(ch.keys.audiobookChapter);
      if (ch.keys.video && !c.videos.has(id)) missing.push(ch.keys.video);
      if (ch.keys.videoInteractions && !c.videoInteractions.has(id)) missing.push(ch.keys.videoInteractions);
      if (ch.keys.activity) {
        const a = c.activities.get(id);
        if (!a) missing.push(ch.keys.activity);
        else if (a.variant !== ch.activityVariant) missing.push(`${ch.keys.activity}:variant=${a.variant}≠${ch.activityVariant}`);
      }
    }
  }
  return missing;
}

/**
 * Construye el `.h5p` de la actividad de un capítulo (R7) con la nota del perfil vigente.
 * EV5-C: `expectedType` = facts.activityType (resolveActivityType del Manifest:
 * h5pType congelado o, legacy, el hash del UUID).
 */
async function buildActivityH5p(
  payload: unknown,
  chapterId: string,
  itemKey: string,
  passingGrade: number,
  expectedType: H5pActivityType | null,
): Promise<{ h5p: Buffer; mainLibrary: string }> {
  if (!expectedType) throw new Error(`MBZ_V3_INVARIANT: facts sin tipo h5p para ${itemKey}`);
  const check = validateH5pActivityPayload(payload, { chapterId, itemKey, expectedType });
  if (!check.ok) {
    throw new Error(`H5P_ACTIVITY_PAYLOAD_INVALID: ${itemKey}: ${check.errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join('; ')}`);
  }
  const p = payload as { type: string; data: Record<string, unknown> };
  const input: Record<string, unknown> = { ...p.data, itemKey };
  if (typeof input.title === 'string') input.title = h5pTitle(input.title);
  let built;
  if (p.type === 'questionset') {
    // R11a ruling 3: la nota interna del QuestionSet es la del perfil VIGENTE, nunca la del LLM/executor.
    input.passPercentage = passingGrade;
    validateQuestionSetInput(input);
    built = buildQuestionSet(input);
  } else if (p.type === 'dragtext') {
    delete input.passPercentage;
    validateDragTextInput(input);
    built = buildDragText(input);
  } else if (p.type === 'blanks') {
    delete input.passPercentage;
    validateBlanksInput(input);
    built = buildBlanks(input);
  } else {
    throw new Error(`H5P_NOT_GRADABLE_IN_MOODLE: tipo ${p.type} no es una actividad calificable (R-011)`);
  }
  // Review G4 I4 / R-011: una actividad CALIFICABLE solo usa librerías que Moodle califica.
  assertH5pGradableInMoodle(built.mainLibrary);
  const h5p = await buildContentOnlyH5p({ mainLibrary: built.mainLibrary, content: built.content, title: built.title, language: 'es' });
  return { h5p, mainLibrary: built.mainLibrary };
}

async function scormZip(launch: string, html: string, manifestXml: string): Promise<Buffer> {
  const z = new JSZip();
  const entries: Array<[string, string]> = [['imsmanifest.xml', manifestXml], [launch, html]];
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [n, d] of entries) z.file(n, d, { date: MBZ_V3_ZIP_FIXED_DATE, createFolders: false });
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

/** EV6 P2: fuente de un examen v3 — GIFT de siempre o banco JSON (`dynamic_exam_bank_json`). */
export type ExamSource = { kind: 'gift'; gift: string } | { kind: 'bank'; bank: ExamBankV1 };

/** Histórico (P2-B2): el builder ya empaqueta bancos desde 3.4.0 (P2-B3); se conserva el código exportado. */
export const EXAM_BANK_UNSUPPORTED = 'EXAM_BANK_UNSUPPORTED';
export const EXAM_BANK_INVALID_BUILDER = 'EXAM_BANK_INVALID';

/**
 * EV6 P2-B3: fuente de cada examen (GIFT | banco). Un módulo con GIFT y banco a la vez es un
 * error del caller (falla fuerte). Cada banco se re-valida contra su plan CONGELADO + pertenencia
 * y la evidencia en el Markdown del capítulo (`contentMd`) → EXAM_BANK_INVALID.
 */
function resolveExamSources(plan: PackagingPlanV3, c: DynamicPackageContentsV3): { modules: Map<string, ExamSource>; final: ExamSource | null } {
  const modules = new Map<string, ExamSource>();
  const check = (key: string, scope: 'module' | 'final', bank: ExamBankV1, chapters: Array<{ id: string; moduleId: string }>): void => {
    const r = validateExamBank(bank, { scope, chapters, chapterMd: c.contentMd, planSource: 'frozen' });
    if (!r.ok) {
      const codes = [...new Set(r.errors.map((e) => e.code))].sort();
      throw new Error(`${EXAM_BANK_INVALID_BUILDER}: ${key} [${codes.join(', ')}] ${r.errors.slice(0, 5).map((e) => `${e.path} ${e.code}: ${e.message}`).join(' | ')}`);
    }
    // Fix 1 (M4): el plan CONGELADO debe cubrir cada capítulo (módulo, en el final) que el plan ACTUAL
    // cubre; un reuse viejo que omita uno dejaría ese capítulo sin evaluar → falla fuerte.
    const owner = (l: ExamBankV1['plan'][number]): string => ('chapterId' in l ? l.chapterId : l.moduleId);
    const frozen = new Set(bank.plan.map(owner));
    const uncovered = [...new Set(expectedExamPlan(scope, chapters).map(owner))].filter((o) => !frozen.has(o));
    if (uncovered.length) {
      throw new Error(`${EXAM_BANK_INVALID_BUILDER}: ${key} [EXAM_BANK_PLAN] el plan congelado del banco no cubre ${scope === 'module' ? 'los capítulos' : 'los módulos'} ${uncovered.join(', ')}`);
    }
  };
  const examModules = new Set(plan.modules.filter((m) => m.keys.exam).map((m) => m.moduleId));
  for (const id of c.examBanks?.keys() ?? []) {
    if (!examModules.has(id)) throw new Error(`MBZ_V3_INVARIANT: banco de examen para un módulo sin examen (${id})`);
  }
  for (const m of plan.modules) {
    if (!m.keys.exam) continue;
    const bank = c.examBanks?.get(m.moduleId);
    const gift = c.examGift.get(m.moduleId);
    if (bank && (gift ?? '').trim()) throw new Error(`MBZ_V3_INVARIANT: ${m.keys.exam} trae GIFT y banco a la vez`);
    if (bank) {
      check(m.keys.exam, 'module', bank, m.chapters.map((ch) => ({ id: ch.chapterId, moduleId: m.moduleId })));
      modules.set(m.moduleId, { kind: 'bank', bank });
    } else {
      modules.set(m.moduleId, { kind: 'gift', gift: gift as string });
    }
  }
  let final: ExamSource | null = null;
  if (plan.keys.finalExam) {
    if (c.finalExamBank && (c.finalExamGift ?? '').trim()) throw new Error(`MBZ_V3_INVARIANT: ${plan.keys.finalExam} trae GIFT y banco a la vez`);
    if (c.finalExamBank) {
      check(plan.keys.finalExam, 'final', c.finalExamBank, plan.modules.flatMap((m) => m.chapters.map((ch) => ({ id: ch.chapterId, moduleId: m.moduleId }))));
      final = { kind: 'bank', bank: c.finalExamBank };
    } else {
      final = { kind: 'gift', gift: c.finalExamGift as string };
    }
  } else if (c.finalExamBank) {
    throw new Error('MBZ_V3_INVARIANT: banco de examen final en un curso sin examen final');
  }
  return { modules, final };
}

export async function buildDynamicMbzV3(input: BuildDynamicMbzV3Input): Promise<BuildDynamicMbzV3Result> {
  if (!Number.isInteger(input?.ts) || input.ts <= 0) throw new Error('MBZ_V3_INVALID: ts (reloj inyectado) debe ser un entero > 0');
  const { manifest, blueprint, contents: c, ts } = input;
  const pendingIds = [...new Set(input.pendingVideoChapterIds ?? [])];
  const plan = buildPackagingPlanV3(manifest, blueprint, { manifestId: input.manifestId ?? null, omitVideoChapterIds: pendingIds });
  const omittedVideoKeys = plan.omittedVideos.map((v) => v.videoKey);
  const missing = collectMissing(plan, c);
  if (missing.length) throw new PackagingV3ContentMissingError(missing);
  const examSources = resolveExamSources(plan, c);
  const MV = resolveMoodleVersion(input.moodleVersion);
  const level = input.level === 'clean_safe' ? undefined : ('enhanced' as const);
  const opts = level ? { level } : undefined;
  const warnings: string[] = [];
  // EV6 T5: aviso visible en el resumen del paquete por cada video pendiente omitido.
  for (const v of plan.omittedVideos) warnings.push(`pending_video_omitted:${v.videoKey}`);

  // ── Tema (R1) y evaluación (R6) ──────────────────────────────────────────
  const theme: ResolvedTheme = resolveTheme(input.presentation);
  const themeErrors = validateTheme(theme, { moduleCount: plan.modules.length });
  if (themeErrors.length) throw new Error(`THEME_INVALID: ${themeErrors.map((e) => e.code).join(', ')}`);
  // F1 (I3): los pesos se normalizan contra los ítems calificables del Manifest.
  const resolved = resolveAssessment(input.assessmentProfile, {
    hasFinalExam: plan.features.finalExam,
    activityEngine: plan.features.activityEngine,
    itemCounts: assessmentItemCountsForPackage(manifest, omittedVideoKeys),
  });

  // ── Contenidos LLM validados ─────────────────────────────────────────────
  const courseIntro: CourseIntroV3 = assertValidCourseIntroV3(c.courseIntro);
  const moduleIntros = new Map<string, ModuleIntroV3>();
  for (const m of plan.modules) {
    moduleIntros.set(m.moduleId, assertValidModuleIntroV3(c.moduleIntros.get(m.moduleId), { chapterIds: m.chapters.map((x) => x.chapterId) }));
  }

  // ── Datos MEDIDOS ────────────────────────────────────────────────────────
  const allChapters = plan.modules.flatMap((m) => m.chapters);
  const slideCountByChapter: Record<string, number> = {};
  for (const ch of allChapters) slideCountByChapter[ch.chapterId] = pdfPageCount((c.presentations.get(ch.chapterId) as { pdf: Buffer }).pdf);
  const audioWelcomeSeconds = mp3DurationSeconds(c.audioWelcome);
  const audiobook = assembleAudiobook(
    allChapters.map((ch) => ({ chapterId: ch.chapterId, chapterNumber: ch.chapterNumber, mp3: c.audiobookChapters.get(ch.chapterId) })),
  );
  // EV6 P2-B3: con banco, las «preguntas del examen» que ve el estudiante son los SLOTS (no el banco).
  const examQuestionCountByModule: Record<string, number> = {};
  const examBankSizeByModule: Record<string, number> = {};
  for (const m of plan.modules) {
    if (!m.keys.exam) continue;
    const src = examSources.modules.get(m.moduleId) as ExamSource;
    if (src.kind === 'bank') {
      examQuestionCountByModule[m.moduleId] = planSlotCount(src.bank.plan);
      examBankSizeByModule[m.moduleId] = src.bank.questions.length;
      continue;
    }
    const n = parseGIFT(src.gift).length;
    if (n < 1) throw new Error(`QUIZ_V3_EMPTY: el GIFT de ${m.keys.exam} no produjo preguntas`);
    examQuestionCountByModule[m.moduleId] = n;
  }
  let finalExamQuestionCount: number | undefined;
  let finalExamBankSize: number | undefined;
  if (plan.keys.finalExam) {
    const src = examSources.final as ExamSource;
    if (src.kind === 'bank') {
      finalExamQuestionCount = planSlotCount(src.bank.plan);
      finalExamBankSize = src.bank.questions.length;
    } else {
      finalExamQuestionCount = parseGIFT(src.gift).length;
      if (finalExamQuestionCount < 1) throw new Error(`QUIZ_V3_EMPTY: el GIFT de ${plan.keys.finalExam} no produjo preguntas`);
    }
  }
  const libroHtml = compileLibroHtmlV3({
    courseTitle: plan.course.title,
    theme,
    courseIntro,
    modules: plan.modules.map((m) => ({
      number: m.moduleNumber,
      title: m.title,
      intro: moduleIntros.get(m.moduleId) as ModuleIntroV3,
      chapters: m.chapters.map((ch) => ({ number: ch.chapterNumber, title: ch.title, md: c.contentMd.get(ch.chapterId) as string })),
    })),
  });

  // EV6 T5 (ruling 3): capítulos pendientes cuyos textos publicados mencionan su video → aviso.
  const noticeChapterIds = pendingVideoNoticeChapterIds({
    chapters: plan.modules.flatMap((m) => m.chapters.map((ch) => ({ id: ch.chapterId, moduleId: m.moduleId }))),
    pendingChapterIds: plan.omittedVideos.map((v) => v.chapterId),
    courseIntro,
    moduleIntros,
    experiences: c.experiences,
  });
  const facts = buildCourseFacts({
    manifest,
    blueprint,
    assessment: input.assessmentProfile,
    hours: input.hours ?? null,
    pendingVideos: plan.omittedVideos.length ? { chapterIds: plan.omittedVideos.map((v) => v.chapterId), noticeChapterIds } : null,
    artifacts: {
      audioWelcomeSeconds,
      audiobookParts: audiobook.parts.map((p) => ({ chapterId: p.chapterId, seconds: p.durationSeconds })),
      slideCountByChapter,
      examQuestionCountByModule,
      ...(finalExamQuestionCount !== undefined ? { finalExamQuestionCount } : {}),
      ...(Object.keys(examBankSizeByModule).length ? { examBankSizeByModule } : {}),
      ...(finalExamBankSize !== undefined ? { finalExamBankSize } : {}),
      libroWordCount: libroWordCount(libroHtml),
      // P3: palabras MEDIDAS del experience → minutos estimados del capítulo (facts).
      experienceWordsByChapter: Object.fromEntries(allChapters.map((ch) => [ch.chapterId, experienceMovementWords(c.experiences.get(ch.chapterId))])),
      // P3 (fix M2): duración medida de los videos reales (los pendientes no están en c.videos).
      videoSecondsByChapter: Object.fromEntries(
        allChapters
          .map((ch) => [ch.chapterId, (c.videos.get(ch.chapterId) as { durationSec?: number } | undefined)?.durationSec] as const)
          .filter(([, s]) => typeof s === 'number' && Number.isFinite(s) && s > 0),
      ),
      libroHasBibliography: libroHtml.includes('id="bibliografia"'),
    },
  });
  // R6: una categoría con peso > 0 y sin ítems calificables deja el curso sin poder llegar a 100 → falla fuerte.
  assertCategoriesPopulated(resolved, {
    practice: facts.counts.activities + facts.counts.videos,
    moduleExams: facts.counts.exams,
    finalExam: facts.finalExam.enabled ? 1 : 0,
  });

  // EV6: el shell (facts) y el plan (Manifest) derivan las MISMAS secciones; si difieren, los
  // botones «Continuar…» apuntarían a otra sección → falla fuerte.
  const factsLayout = sectionLayoutFromFacts(facts);
  const shape = (xs: PackagingPlanV3['sections']) => JSON.stringify(xs.map((x) => [x.sectionNum, x.kind, x.moduleId ?? null, x.chapterId ?? null]));
  if (shape(factsLayout.sections) !== shape(plan.sections)) {
    throw new Error('MBZ_V3_INVARIANT: las secciones del plan no coinciden con las derivadas de facts');
  }
  const firstChapterSection = plan.modules[0]?.firstSectionNum;
  if (!Number.isInteger(firstChapterSection)) throw new Error('MBZ_V3_INVARIANT: el curso no tiene capítulos');

  // ── Capítulos (R11a) ─────────────────────────────────────────────────────
  const experiences: Record<string, ChapterExperience> = {};
  for (const ch of allChapters) experiences[ch.chapterId] = c.experiences.get(ch.chapterId) as ChapterExperience;
  const assembled = assembleAllChapters(facts, experiences, theme, opts);

  // ── Zip ──────────────────────────────────────────────────────────────────
  const W = new MbzWriter(ts, MV);
  const ids = new IdAllocator({
    qcat: 1000, qbe: 1000, qversion: 1000, question: 1000, qinstance: 1000, qref: 1000, qsetref: 1000, answer: 1000,
    match: 1000, qoptions: 1000, qsection: 1000, sco: 50000, scodata: 60000,
  });
  const graded: Array<CompletionCandidate & { name: string }> = [];
  const labelsHtml: Array<{ where: string; html: string }> = [];
  const h5pPackages: MbzV3H5pPackage[] = [];
  const mockPresentationChapters: string[] = [];
  const introTheme = introThemeFrom(theme);
  // P3: marco de la actividad con el tono del módulo del capítulo (mismo que la tarjeta «Práctica calificada»).
  const frameFor = (chapterNumber: number): ActivityFrameTone => {
    const cf = facts.chapters.find((x) => x.number === chapterNumber);
    if (!cf) throw new Error(`MBZ_V3_INVARIANT: capítulo ${chapterNumber} sin facts para el marco de la actividad`);
    const mt = moduleTone(theme, moduleColor(theme, cf.moduleNumber - 1), groundColor(theme));
    return { ink: mt.ink, soft: mt.soft, edge: mt.edge, chapterNumber };
  };

  // Edu EV3 — botones de navegación: el shell deja marcadores cursia-cta://…; las secciones se
  // resuelven al instante y «siguiente actividad / evaluación» cuando el builder crea esa actividad
  // en la misma sección (se reescribe el label.xml). assertTokensV3 falla ante uno sin resolver.
  const pendingCtas: Array<{ a: ActivityRef; name: string; html: string; secnum: number; logIdx: number }> = [];
  const resolveCta = (marker: 'next-activity' | 'next-exam', secnum: number, token: string): void => {
    for (let i = pendingCtas.length - 1; i >= 0; i--) {
      const p = pendingCtas[i];
      if (p.secnum !== secnum || !p.html.includes(`cursia-cta://${marker}`)) continue;
      p.html = p.html.split(`cursia-cta://${marker}`).join(token);
      W.put(`${p.a.dir}/label.xml`, labelXmlWithCtx(p.a.aid, p.a.mid, p.a.ctx, p.name, p.html, ts));
      labelsHtml[p.logIdx].html = p.html;
      if (!p.html.includes('cursia-cta://')) pendingCtas.splice(i, 1);
      return;
    }
  };
  const addLabel = (secnum: number, idnumber: string, label: ShellLabel, files: Array<{ name: string; data: Buffer | string; mime: string }> = []): ActivityRef => {
    const a = W.newActivity('label', secnum, label.name, idnumber);
    const fileIds = files.map((f) => W.addFile(a.ctx, 'mod_label', 'intro', f.name, f.data, f.mime));
    label = {
      ...label,
      html: label.html
        .replace(/cursia-cta:\/\/section\/(\d+)/g, (_m, n: string) => `$@COURSESECTIONBYID*${n}@$`)
        .split(CTA_BADGES)
        .join(`$@BADGESVIEWBYID*${MBZ_V3_COURSE_BACKUP_ID}@$`),
    };
    if (label.html.includes('cursia-cta://')) pendingCtas.push({ a, name: label.name, html: label.html, secnum, logIdx: labelsHtml.length });
    W.put(`${a.dir}/label.xml`, labelXmlWithCtx(a.aid, a.mid, a.ctx, label.name, label.html, ts));
    W.put(`${a.dir}/module.xml`, withIdnumber(moduleXml(a.mid, 'label', secnum, ts, MV.bv), idnumber));
    W.put(`${a.dir}/inforef.xml`, inforef(fileIds));
    W.put(`${a.dir}/grades.xml`, gradesXml(a.aid));
    W.boilerplate(a.dir);
    labelsHtml.push({ where: idnumber, html: label.html });
    return a;
  };

  const gradedCommon = (a: ActivityRef, kind: AssessableType, name: string, fileIds: number[], qcats: number[] = []): void => {
    const k = resolved.kinds[kind];
    const gi = W.nextGradeItem();
    W.put(`${a.dir}/module.xml`, withIdnumber(gradedModuleXml({ mid: a.mid, modname: a.modname as 'quiz' | 'scorm' | 'h5pactivity', secnum: a.secnum, ts, bv: MV.bv, passGradeRequired: true }), a.idnumber));
    W.put(`${a.dir}/grades.xml`, gradeItemXml({
      gradeItemId: gi.id, itemName: name, itemModule: a.modname as 'quiz' | 'scorm' | 'h5pactivity', aid: a.aid, ts,
      grademax: 100, gradepass: k.passingGrade, categoryId: CAT_ID[k.category], sortorder: gi.sortorder,
    }));
    W.put(`${a.dir}/inforef.xml`, inforef(fileIds, [gi.id], qcats));
    W.boilerplate(a.dir);
    graded.push({ moduleId: a.mid, modname: a.modname as 'quiz' | 'scorm' | 'h5pactivity', kind, name });
  };

  const addH5pActivity = (secnum: number, idnumber: string, name: string, kind: AssessableType, itemKey: string, filename: string, h5p: Buffer, mainLibrary: string, intro: (mid: number) => string): void => {
    const a = W.newActivity('h5pactivity', secnum, name, idnumber);
    // El mismo .h5p (un blob) en `package` (view.php) y en `intro` (embed inline) — R8 videoActivityFileEntries.
    const fPkg = W.addFile(a.ctx, 'mod_h5pactivity', 'package', filename, h5p, H5P_PACKAGE_MIMETYPE);
    const fIntro = W.addFile(a.ctx, 'mod_h5pactivity', 'intro', filename, h5p, H5P_PACKAGE_MIMETYPE);
    const introHtml = intro(a.mid);
    W.put(`${a.dir}/h5pactivity.xml`, h5pactivityXml({
      aid: a.aid, mid: a.mid, ctx: a.ctx, name, intro: introHtml, grade: 100,
      grademethod: resolved.kinds[kind].gradeMethod, enabletracking: 1, reviewmode: 1,
      displayoptions: { frame: false, download: false, embed: false, copyright: false }, ts,
    }));
    gradedCommon(a, kind, name, [fPkg, fIntro]);
    labelsHtml.push({ where: `${idnumber}#intro`, html: introHtml });
    if (kind === 'activity') resolveCta('next-activity', secnum, `$@H5PACTIVITYVIEWBYID*${a.mid}@$`);
    h5pPackages.push({ itemKey, filename, mainLibrary, sha1: sha1Buf(h5p), bytes: h5p.length });
  };

  const questionCategories: string[] = [];
  const addQuiz = (
    secnum: number,
    idnumber: string,
    name: string,
    kind: 'exam' | 'finalExam',
    src: ExamSource,
    stampSeed: string,
    bankGroups: Array<{ ownerId: string; name: string }>,
  ): ActivityRef => {
    const a = W.newActivity('quiz', secnum, name, idnumber);
    const k = resolved.kinds[kind];
    const q = buildQuizV3({
      aid: a.aid, mid: a.mid, ctx: a.ctx, name, introHtml: `<p>${esc(name)}</p>`,
      ...(src.kind === 'bank' ? { bank: { doc: src.bank, groups: bankGroups } } : { gift: src.gift }),
      attempts: k.attempts, grademethod: k.gradeMethod, ts, stampSeed, ids,
    });
    // Fix 1 (M5): los slots del quiz y las «preguntas» que anuncia el shell (facts) salen de la misma
    // fuente; si difieren, el texto del curso mentiría → falla fuerte.
    const announced = kind === 'finalExam' ? facts.finalExam.questionCount : facts.modules.find((x) => `cv3:exam:${x.id}` === idnumber)?.examQuestionCount;
    if (q.questionCount !== announced) {
      throw new Error(`MBZ_V3_INVARIANT: ${idnumber} tiene ${q.questionCount} slots pero facts anuncia ${announced} preguntas`);
    }
    W.put(`${a.dir}/quiz.xml`, q.quizXml);
    questionCategories.push(q.questionCategoriesXml);
    gradedCommon(a, kind, name, [], q.categoryIds);
    resolveCta('next-exam', secnum, `$@QUIZVIEWBYID*${a.mid}@$`);
    return a;
  };

  // EV6 P2-B4: «Respuestas explicadas» justo después del quiz (misma sección), gated por su completion.
  const addExplanationsPage = (
    quiz: ActivityRef,
    idnumber: string,
    scope: { kind: 'module'; moduleNumber: number; title: string } | { kind: 'final' },
    src: ExamSource,
    bankGroups: Array<{ ownerId: string; name: string }>,
    attempts: number,
  ): ActivityRef => {
    const page = src.kind === 'bank'
      ? examExplanationsBankPage({ scope, bank: src.bank, groups: bankGroups }, theme)
      : examExplanationsGiftPage({ scope, questions: parseGIFT(src.gift) }, theme);
    const a = W.newActivity('page', quiz.secnum, page.name, idnumber);
    W.put(`${a.dir}/page.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${a.aid}" moduleid="${a.mid}" modulename="page" contextid="${a.ctx}">
  <page id="${a.aid}">
    <name>${xmlEsc(page.name)}</name>
    <intro></intro>
    <introformat>1</introformat>
    <content>${xmlEsc(page.html)}</content>
    <contentformat>1</contentformat>
    <legacyfiles>0</legacyfiles>
    <legacyfileslast>${NULL}</legacyfileslast>
    <display>0</display>
    <displayoptions>a:2:{s:10:"printintro";i:0;s:17:"printlastmodified";i:0;}</displayoptions>
    <revision>1</revision>
    <timemodified>${ts}</timemodified>
  </page>
</activity>`);
    W.put(`${a.dir}/module.xml`, applyXmlFields(withIdnumber(moduleXml(a.mid, 'page', quiz.secnum, ts, MV.bv), idnumber), {
      completion: '0',
      availability: examExplanationsAvailability(quiz.mid, attempts),
      downloadcontent: '0',
    }));
    W.put(`${a.dir}/inforef.xml`, inforef([]));
    W.put(`${a.dir}/grades.xml`, gradesXml(a.aid));
    W.boilerplate(a.dir);
    return a;
  };
  // EV6 P2-B4 (ruling 3): con certificado la nota para docentes va en su label oculto del cierre; sin
  // él, un label oculto propio al INICIO de la primera sección con una evaluación.
  const willHaveCertificate = !!plan.keys.finalExam;
  let examsTeacherPlaced = false;
  const addExamsTeacherLabel = (secnum: number): void => {
    if (willHaveCertificate || examsTeacherPlaced) return;
    if ((W.sectionSeq.get(secnum) ?? []).length) throw new Error('MBZ_V3_INVARIANT: la nota para docentes de las evaluaciones debe ser lo primero de su sección');
    const t = addLabel(secnum, 'cv3:shell:exams_teacher', examsTeacherLabel(facts, theme, opts));
    W.put(`${t.dir}/module.xml`, applyXmlFields(withIdnumber(moduleXml(t.mid, 'label', secnum, ts, MV.bv), t.idnumber), { visible: '0', visibleold: '0' }));
    examsTeacherPlaced = true;
  };

  // ── Sección 0 — shell ────────────────────────────────────────────────────
  {
    const name = '📢 Avisos del Curso';
    const a = W.newActivity('forum', 0, name, 'cv3:shell:forum');
    W.put(`${a.dir}/forum.xml`, forumXml(a.aid, a.mid, a.ctx, name, ts));
    W.put(`${a.dir}/module.xml`, withIdnumber(moduleXml(a.mid, 'forum', 0, ts, MV.bv), a.idnumber));
    W.put(`${a.dir}/inforef.xml`, inforefXml());
    W.put(`${a.dir}/grades.xml`, gradesXml(a.aid));
    W.put(`${a.dir}/posts.xml`, '<?xml version="1.0" encoding="UTF-8"?><posts></posts>');
    W.put(`${a.dir}/subscribers.xml`, '<?xml version="1.0" encoding="UTF-8"?><subscribers></subscribers>');
    W.put(`${a.dir}/discussions.xml`, '<?xml version="1.0" encoding="UTF-8"?><discussions></discussions>');
    W.boilerplate(a.dir);
  }
  addLabel(0, 'cv3:shell:welcome', welcomeLabel(facts, courseIntro, theme, opts));
  addLabel(0, 'cv3:shell:audio_welcome', audioWelcomeLabel(facts, theme, opts), [
    { name: SHELL_AUDIO_WELCOME_FILE, data: c.audioWelcome, mime: 'audio/mp3' },
  ]);
  addLabel(0, 'cv3:shell:competencies', competenciesLabel(facts, courseIntro, theme, opts));
  addLabel(0, 'cv3:shell:methodology', methodologyLabel(facts, courseIntro, theme, opts));
  addLabel(0, 'cv3:shell:start', welcomeStartLabel(firstChapterSection as number, facts, theme, opts));

  // ── Sección 1 — ruta, Libro Guía, audiolibro ─────────────────────────────
  addLabel(1, 'cv3:shell:route', routeLabel(facts, theme, opts));
  let libroMid: number;
  {
    const name = '📘 Libro Guía';
    const a = W.newActivity('resource', 1, name, 'cv3:shell:libro');
    libroMid = a.mid;
    const fid = W.addFile(a.ctx, 'mod_resource', 'content', 'libro_guia_completo.html', libroHtml, 'text/html');
    W.put(`${a.dir}/resource.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${a.aid}" moduleid="${a.mid}" modulename="resource" contextid="${a.ctx}">
  <resource id="${a.aid}">
    <name>${xmlEsc(name)}</name>
    <intro></intro>
    <introformat>1</introformat>
    <tobemigrated>0</tobemigrated>
    <legacyfiles>0</legacyfiles>
    <legacyfileslast>${NULL}</legacyfileslast>
    <display>5</display>
    <displayoptions>a:1:{s:10:"printintro";s:1:"0";}</displayoptions>
    <filterfiles>0</filterfiles>
    <revision>1</revision>
    <timemodified>${ts}</timemodified>
  </resource>
</activity>`);
    // F1 (I3): en un curso sin nota el Libro Guía es el criterio de completion (por vista).
    const libroModule = withIdnumber(moduleXml(a.mid, 'resource', 1, ts, MV.bv), a.idnumber);
    W.put(`${a.dir}/module.xml`, resolved.withoutGrades ? applyXmlFields(libroModule, { completion: '2', completionview: '1' }) : libroModule);
    W.put(`${a.dir}/inforef.xml`, inforef([fid]));
    W.put(`${a.dir}/grades.xml`, gradesXml(a.aid));
    W.boilerplate(a.dir);
  }
  addLabel(1, 'cv3:shell:libro_card', libroCardLabel(libroMid, facts, theme, opts));
  addLabel(1, 'cv3:shell:audiobook', audiobookLabel(facts, theme, opts), [
    { name: SHELL_AUDIOBOOK_FILE, data: audiobook.buffer, mime: 'audio/mp3' },
  ]);
  addLabel(1, 'cv3:shell:route_start', routeStartLabel(firstChapterSection as number, facts, theme, opts));

  // ── EV6: una sección por capítulo (+ una por evaluación de módulo) ──────
  const chapterSlots = new Map(assembled.map((x) => [x.chapterNumber, x.slots]));
  for (const m of plan.modules) {
    const mf = facts.modules.find((x) => x.id === m.moduleId);
    if (!mf) throw new Error(`MBZ_V3_INVARIANT: módulo ${m.moduleId} ausente en facts`);
    addLabel(m.firstSectionNum, `cv3:module_intro:${m.moduleId}`, moduleIntroLabel(mf, moduleIntros.get(m.moduleId) as ModuleIntroV3, facts, theme, opts));
    for (const ch of m.chapters) {
      const sec = ch.sectionNum;
      const slots = chapterSlots.get(ch.chapterNumber);
      if (!slots) throw new Error(`MBZ_V3_INVARIANT: capítulo ${ch.chapterNumber} sin slots`);
      const cf = facts.chapters.find((x) => x.id === ch.chapterId);
      if (!cf) throw new Error(`MBZ_V3_INVARIANT: capítulo ${ch.chapterId} ausente en facts`);
      const idp = `cv3:ch:${ch.chapterId}`;
      for (const slot of slots) {
        if (slot.kind === 'label') {
          addLabel(sec, `${idp}:${slot.role}`, { name: slot.name, html: slot.html });
          continue;
        }
        if (slot.kind === 'presentation') {
          const pres = c.presentations.get(ch.chapterId) as { pdf: Buffer; cover: Buffer; mock?: boolean };
          if (pres.mock) mockPresentationChapters.push(ch.chapterId);
          const cover = downscaleCoverPng(pres.cover);
          if (!cover.downscaled && cover.reason !== 'already_small') {
            warnings.push(`cover_not_downscaled:${ch.keys.presentation}:${cover.reason}`);
          }
          const pdfName = `capitulo-${ch.chapterNumber}-presentacion.pdf`;
          const pngName = `capitulo-${ch.chapterNumber}-portada.png`;
          const html = presentationCardHtml({
            chapterNumber: ch.chapterNumber,
            chapterTitle: ch.title,
            coverUrl: `@@PLUGINFILE@@/${pngName}`,
            pdfUrl: `@@PLUGINFILE@@/${pdfName}`,
            slideCount: cf.slideCount,
            theme,
            moduleColor: moduleColor(theme, m.moduleNumber - 1),
            ...(level ? { level } : {}),
          });
          addLabel(sec, `${idp}:presentation`, { name: `Capítulo ${ch.chapterNumber} · Presentación`, html }, [
            { name: pngName, data: cover.png, mime: 'image/png' },
            { name: pdfName, data: pres.pdf, mime: 'application/pdf' },
          ]);
          continue;
        }
        if (slot.kind === 'video_h5p') {
          const video = c.videos.get(ch.chapterId) as { youtubeId: string; durationSec: number };
          const key = ch.keys.video as string;
          const built = await buildVideoActivity({
            itemKey: key,
            // El título del capítulo puede superar el máximo de H5P (200): se normaliza, no se rechaza el paquete.
            title: h5pTitle(ch.title),
            youtubeId: video.youtubeId,
            durationSec: video.durationSec,
            interactionsDoc: c.videoInteractions.get(ch.chapterId),
          });
          assertH5pGradableInMoodle('H5P.InteractiveVideo');
          const filename = videoPackageFilename(key);
          const name = safeActivityName(`Video interactivo · Capítulo ${ch.chapterNumber}: ${ch.title}`);
          addH5pActivity(sec, `${idp}:video`, name, 'video', key, filename, built.h5p, 'H5P.InteractiveVideo', (mid) =>
            videoInlineIntroHtml({ packageFilename: filename, title: ch.title, activityMid: mid, youtubeId: video.youtubeId, theme: introTheme }),
          );
          continue;
        }
        // slot.kind === 'activity'
        const act = c.activities.get(ch.chapterId) as ActivityContentV3;
        const key = ch.keys.activity as string;
        const name = safeActivityName(`Actividad práctica · Capítulo ${ch.chapterNumber}: ${ch.title}`);
        if (act.variant === 'h5p') {
          const built = await buildActivityH5p(act.payload, ch.chapterId, key, resolved.kinds.activity.passingGrade, cf.activityType);
          const filename = activityPackageFilename(key);
          addH5pActivity(sec, `${idp}:activity`, name, 'activity', key, filename, built.h5p, built.mainLibrary, (mid) =>
            h5pActivityInlineIntroHtml({ packageFilename: filename, title: ch.title, activityMid: mid, theme: introTheme, frame: frameFor(ch.chapterNumber) }),
          );
        } else {
          const a = W.newActivity('scorm', sec, name, `${idp}:activity`);
          const mids = parseScormManifestIds(act.manifestXml);
          const zipName = `actividad-capitulo-${ch.chapterNumber}.zip`;
          const zipData = await scormZip(mids.launch, act.html, act.manifestXml);
          const fileIds = [
            W.addFile(a.ctx, 'mod_scorm', 'content', 'imsmanifest.xml', act.manifestXml, 'application/xml'),
            W.addFile(a.ctx, 'mod_scorm', 'content', mids.launch, act.html, 'text/html'),
            W.addDirEntry(a.ctx, 'mod_scorm', 'content'),
            W.addFile(a.ctx, 'mod_scorm', 'package', zipName, zipData, 'application/zip'),
            W.addDirEntry(a.ctx, 'mod_scorm', 'package'),
          ];
          const introHtml = scormIntroHtml(introTheme, frameFor(ch.chapterNumber));
          const k = resolved.kinds.activity;
          W.put(`${a.dir}/scorm.xml`, scormActivityXmlV3({
            aid: a.aid, mid: a.mid, ctx: a.ctx, name, introHtml, zipName, zipHash: sha1Buf(zipData), ids: mids,
            scoOrg: ids.take('sco'), scoItem: ids.take('sco'), scoD1: ids.take('scodata'), scoD2: ids.take('scodata'),
            whatgrade: k.gradeMethod, maxattempt: k.attempts, ts,
          }));
          gradedCommon(a, 'activity', name, fileIds);
          labelsHtml.push({ where: `${idp}:activity#intro`, html: introHtml });
          resolveCta('next-activity', sec, `$@SCORMVIEWBYID*${a.mid}@$`);
        }
      }
    }
    // Sección «Módulo m · Evaluación» (solo si el módulo tiene examen). EV6 fix 1 (I1): SIN examen
    // no hay label module_next — el botón del cierre de su último capítulo ya es el siguiente paso
    // (antes quedaban dos botones iguales seguidos).
    if (!m.keys.exam) continue;
    const nextSec = m.examSectionNum as number;
    if (!Number.isInteger(nextSec)) throw new Error(`MBZ_V3_INVARIANT: módulo ${m.moduleId} con examen sin sección`);
    addExamsTeacherLabel(nextSec);
    addLabel(nextSec, `cv3:exam_info:${m.moduleId}`, examInfoLabel(mf, facts, theme, opts));
    const examSrc = examSources.modules.get(m.moduleId) as ExamSource;
    const examGroups = m.chapters.map((ch) => ({ ownerId: ch.chapterId, name: `Capítulo ${ch.chapterNumber}: ${ch.title}` }));
    const quiz = addQuiz(
      nextSec,
      `cv3:exam:${m.moduleId}`,
      safeActivityName(`Evaluación del módulo ${m.moduleNumber}: ${m.title}`),
      'exam',
      examSrc,
      m.keys.exam,
      examGroups,
    );
    addExplanationsPage(quiz, `cv3:exam_explanations:${m.moduleId}`, { kind: 'module', moduleNumber: m.moduleNumber, title: m.title }, examSrc, examGroups, resolved.kinds.exam.attempts);
    // Edu EV3 / EV6: tras la evaluación → botón al primer capítulo del módulo siguiente, o a la
    // evaluación final / cierre.
    const nextPlan = plan.modules[plan.modules.indexOf(m) + 1];
    const nextFacts = nextPlan ? facts.modules.find((x) => x.id === nextPlan.moduleId) : undefined;
    if (nextPlan && !nextFacts) throw new Error(`MBZ_V3_INVARIANT: módulo ${nextPlan.moduleId} ausente en facts`);
    addLabel(
      nextSec,
      `cv3:module_next:${m.moduleId}`,
      moduleNextLabel(
        mf,
        nextPlan && nextFacts
          ? { kind: 'module', module: nextFacts, sectionNum: nextPlan.firstSectionNum }
          : { kind: 'closing', sectionNum: plan.finalExamSectionNum ?? plan.closingSectionNum },
        facts,
        theme,
        opts,
      ),
    );
  }

  // ── EV6: «Evaluación final» (si hay) y, al final, «Cierre del curso» ────
  const closing = plan.closingSectionNum;
  if (plan.keys.finalExam) {
    const fsec = plan.finalExamSectionNum;
    if (fsec === null || !(fsec < closing)) throw new Error('MBZ_V3_INVARIANT: la evaluación final debe ir antes del cierre');
    addExamsTeacherLabel(fsec);
    addLabel(fsec, 'cv3:final_exam_info', finalExamInfoLabel(facts, theme, opts));
    const finalSrc = examSources.final as ExamSource;
    const finalGroups = plan.modules.map((m) => ({ ownerId: m.moduleId, name: `Módulo ${m.moduleNumber}: ${m.title}` }));
    const quiz = addQuiz(fsec, 'cv3:final_exam', 'Evaluación final', 'finalExam', finalSrc, plan.keys.finalExam, finalGroups);
    addExplanationsPage(quiz, 'cv3:final_exam_explanations', { kind: 'final' }, finalSrc, finalGroups, resolved.kinds.finalExam.attempts);
    addLabel(fsec, 'cv3:final_exam_next', finalExamNextLabel(closing, facts, theme, opts));
  }
  // EV6 (T3): criterios de completion del curso (la insignia-certificado se otorga al completarlo).
  const finalExamMid = W.activities.find((a) => a.idnumber === 'cv3:final_exam')?.mid ?? null;
  const completionCriteria: Array<{ moduleId: number; modname: 'quiz' | 'scorm' | 'h5pactivity' | 'resource' }> = resolved.withoutGrades
    ? [{ moduleId: libroMid, modname: 'resource' as const }]
    : completionCriteriaFor(graded.map((g) => ({ moduleId: g.moduleId, modname: g.modname, kind: g.kind })), resolved.courseCompletion);
  if (finalExamMid !== null && !completionCriteria.some((x) => x.moduleId === finalExamMid)) {
    throw new Error('MBZ_V3_INVARIANT: la evaluación final no es criterio de completion del curso');
  }
  // Fix round 1 (review I1): requisitos de la insignia = criterios REALES del paquete, por tipo.
  const kindByMid = new Map(graded.map((g) => [g.moduleId, g.kind]));
  const critKinds = new Set(completionCriteria.map((x) => kindByMid.get(x.moduleId)));
  const certificateReq = {
    activities: critKinds.has('activity'),
    videos: critKinds.has('video'),
    moduleExams: critKinds.has('exam'),
    finalExam: critKinds.has('finalExam'),
    courseGrade: resolved.courseCompletion.requireCourseGradePass,
  };
  // Fix round 1b (decisión M5, flujo del usuario «Curso completo → Evaluación final aprobada →
  // Cierre → Certificado»): insignia, panel y label para docentes SOLO si hay evaluación final.
  const hasCertificate = finalExamMid !== null && certificateReq.finalExam;
  const certificate = hasCertificate ? certificateReq : undefined;
  if (hasCertificate !== willHaveCertificate) throw new Error('MBZ_V3_INVARIANT: certificado ≠ evaluación final (nota para docentes de las evaluaciones mal ubicada)');
  if (!hasCertificate && (facts.counts.exams > 0) !== examsTeacherPlaced) throw new Error('MBZ_V3_INVARIANT: nota para docentes de las evaluaciones ausente o sobrante');
  if (!hasCertificate) warnings.push('certificate_omitted:no_final_exam');
  addLabel(closing, 'cv3:shell:closing', closingLabel(facts, courseIntro, theme, opts, certificate));
  // Fix 0b: Moodle restaura la insignia DESACTIVADA → label oculto (visible=0) para el docente con
  // el paso único «Habilitar acceso» y el botón a las insignias del curso. El estudiante no lo ve.
  if (hasCertificate) {
    const badgeName = courseBadgeName(safeActivityName(plan.course.title, 254));
    const t = addLabel(closing, 'cv3:shell:certificate_teacher', certificateTeacherLabel(badgeName, facts, theme, opts));
    W.put(`${t.dir}/module.xml`, applyXmlFields(withIdnumber(moduleXml(t.mid, 'label', closing, ts, MV.bv), t.idnumber), { visible: '0', visibleold: '0' }));
  }

  // ── Tokens (fail loud) ───────────────────────────────────────────────────
  const sectionNums = new Set(plan.sections.map((s) => s.sectionNum));
  for (const l of labelsHtml) assertTokensV3(l.html, W.modnameByMid, l.where, sectionNums, MBZ_V3_COURSE_BACKUP_ID);
  if (pendingCtas.length) throw new Error(`MBZ_V3_INVARIANT: botones de navegación sin destino: ${pendingCtas.map((p) => p.name).join(', ')}`);

  // ── Secciones ────────────────────────────────────────────────────────────
  for (const s of plan.sections) {
    const name = safeActivityName(s.title, 255);
    W.put(`sections/section_${s.sectionNum}/section.xml`, sectionXml({ num: s.sectionNum, name, summary: '' }, (W.sectionSeq.get(s.sectionNum) ?? []).join(','), ts));
    W.put(`sections/section_${s.sectionNum}/inforef.xml`, inforefXml());
    W.put(`sections/section_${s.sectionNum}/roles.xml`, BOIL.roles);
    W.put(`sections/section_${s.sectionNum}/filters.xml`, BOIL.filters);
    W.put(`sections/section_${s.sectionNum}/contentbank.xml`, BOIL.contentbank);
  }

  // ── Curso ────────────────────────────────────────────────────────────────
  const courseTitle = safeActivityName(plan.course.title, 254);
  W.put('course/course.xml', `<?xml version="1.0" encoding="UTF-8"?>
<course id="${MBZ_V3_COURSE_BACKUP_ID}" contextid="${MBZ_V3_COURSE_BACKUP_CONTEXTID}">
  <shortname>${esc(courseTitle)}</shortname><fullname>${esc(courseTitle)}</fullname>
  <idnumber></idnumber><summary></summary><summaryformat>1</summaryformat>
  <format>topics</format><showgrades>1</showgrades><newsitems>5</newsitems>
  <startdate>${ts}</startdate><enddate>0</enddate><marker>0</marker>
  <maxbytes>0</maxbytes><legacyfiles>0</legacyfiles><showreports>0</showreports>
  <visible>1</visible><groupmode>0</groupmode><groupmodeforce>0</groupmodeforce>
  <defaultgroupingid>0</defaultgroupingid><lang>es</lang><theme></theme>
  <timecreated>${ts}</timecreated><timemodified>${ts}</timemodified>
  <requested>0</requested><showactivitydates>1</showactivitydates>
  <showcompletionconditions>1</showcompletionconditions>
  <pdfexportfont>${NULL}</pdfexportfont>
  <enablecompletion>1</enablecompletion><completionnotify>0</completionnotify>
  <tags></tags><customfields></customfields>
  <courseformatoptions>
    <courseformatoption><format>topics</format><sectionid>0</sectionid><name>coursedisplay</name><value>1</value></courseformatoption>
    <courseformatoption><format>topics</format><sectionid>0</sectionid><name>hiddensections</name><value>1</value></courseformatoption>
  </courseformatoptions>
</course>`);
  W.put('course/inforef.xml', inforefXml());
  W.put('course/enrolments.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<enrolments>\n  <enrols>\n  </enrols>\n</enrolments>');
  W.put('course/roles.xml', BOIL.roles);
  W.put('course/completiondefaults.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_completion_defaults>\n</course_completion_defaults>');
  W.put('course/calendar.xml', BOIL.calendar);
  W.put('course/competencies.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_competencies>\n  <competencies>\n  </competencies>\n  <user_competencies>\n  </user_competencies>\n</course_competencies>');
  W.put('course/contentbank.xml', BOIL.contentbank);
  W.put('course/filters.xml', BOIL.filters);

  // ── Gradebook + completion del curso (R6) ────────────────────────────────
  W.put('gradebook.xml', gradebookXml({
    ts,
    courseGradepass: resolved.courseGradepass,
    aggregation: 'weighted_mean',
    courseCategoryId: 1,
    courseItemId: 1,
    categories: resolved.categories.map((cat) => ({ id: CAT_ID[cat.key], fullname: cat.fullname, weight: cat.weight, gradeItemId: CAT_ID[cat.key] })),
    ...(resolved.withoutGrades ? { withoutGrades: true } : {}),
  }));
  if (resolved.withoutGrades && graded.length > 0) {
    throw new Error(`ASSESSMENT_INVALID_FACTS: curso sin nota con ${graded.length} ítem(s) calificable(s) en el paquete`);
  }
  W.put('completion.xml', courseCompletionXml({
    criteria: completionCriteria,
    aggregation: 'all',
    courseId: MBZ_V3_COURSE_BACKUP_ID,
    requireCourseGradePass: resolved.courseCompletion.requireCourseGradePass,
    courseGradepass: resolved.courseCompletion.courseGradepass,
  }));

  // ── Archivos raíz ────────────────────────────────────────────────────────
  W.put('roles.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<roles_definition>\n</roles_definition>');
  W.put('scales.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<scales_definition>\n</scales_definition>');
  W.put('outcomes.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<outcomes_definition>\n</outcomes_definition>');
  // EV6 (T3): certificado = insignia de curso (criterio: completion del curso) + su imagen.
  if (hasCertificate) {
    W.put('badges.xml', courseBadgeXml({
      courseTitle: courseTitle,
      courseBackupId: MBZ_V3_COURSE_BACKUP_ID,
      requirements: certificateReq,
      ts,
      issuerName: COURSE_BADGE_DEFAULT_ISSUER,
    }));
    for (const img of courseBadgeImages(theme)) {
      W.addFile(MBZ_V3_COURSE_BACKUP_CONTEXTID, 'badges', 'badgeimage', img.filename, img.png, 'image/png', COURSE_BADGE_BACKUP_ID);
    }
  } else {
    W.put('badges.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<badges>\n</badges>');
  }
  W.put('users.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<users>\n</users>');
  W.put('grade_history.xml', BOIL.gradeHistory);
  W.put('groups.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<groups>\n  <groupcustomfields>\n  </groupcustomfields>\n  <groupings>\n    <groupingcustomfields>\n    </groupingcustomfields>\n  </groupings>\n</groups>');
  W.put('questions.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<question_categories>\n${questionCategories.join('')}</question_categories>`);

  let filesXml = '<?xml version="1.0" encoding="UTF-8"?>\n<files>\n';
  for (const f of W.files) {
    filesXml +=
      `  <file id="${f.id}">\n    <contenthash>${f.hash}</contenthash>\n    <contextid>${f.ctx}</contextid>\n` +
      `    <component>${f.component}</component>\n    <filearea>${f.filearea}</filearea>\n    <itemid>${f.itemid ?? 0}</itemid>\n` +
      `    <filepath>/</filepath>\n    <filename>${xmlEsc(f.filename)}</filename>\n    <userid>${NULL}</userid>\n` +
      `    <filesize>${f.size}</filesize>\n    <mimetype>${f.mime ?? NULL}</mimetype>\n    <status>0</status>\n` +
      `    <timecreated>${ts}</timecreated>\n    <timemodified>${ts}</timemodified>\n` +
      `    <source>${NULL}</source>\n    <author>${NULL}</author>\n    <license>${NULL}</license>\n` +
      `    <sortorder>0</sortorder>\n    <repositorytype>${NULL}</repositorytype>\n    <repositoryid>${NULL}</repositoryid>\n    <reference>${NULL}</reference>\n  </file>\n`;
  }
  W.put('files.xml', `${filesXml}</files>`);

  // ── moodle_backup.xml ────────────────────────────────────────────────────
  const setting = (lvl: string, extra: string, n: string, v: string | number) =>
    `    <setting>\n      <level>${lvl}</level>\n${extra}      <name>${n}</name>\n      <value>${v}</value>\n    </setting>\n`;
  let sett = '';
  const rootSettings: Record<string, string> = {
    filename: `cursia-v3-${plan.course.id}.mbz`, imscc11: '0', users: '0', anonymize: '0', role_assignments: '0',
    activities: '1', blocks: '0', files: '1', filters: '1', comments: '0', badges: hasCertificate ? '1' : '0',
    calendarevents: '1', userscompletion: '0', logs: '0', grade_histories: '0',
    questionbank: '1', groups: '0', competencies: '0', customfield: '0',
    contentbankcontent: '0', xapistate: '0', legacyfiles: '1',
  };
  for (const [k, v] of Object.entries(rootSettings)) sett += setting('root', '', k, v);
  for (const s of plan.sections) {
    sett += setting('section', `      <section>section_${s.sectionNum}</section>\n`, `section_${s.sectionNum}_included`, 1);
    sett += setting('section', `      <section>section_${s.sectionNum}</section>\n`, `section_${s.sectionNum}_userinfo`, 0);
  }
  for (const a of W.activities) {
    const pre = `${a.modname}_${a.mid}`;
    sett += setting('activity', `      <activity>${pre}</activity>\n`, `${pre}_included`, 1);
    sett += setting('activity', `      <activity>${pre}</activity>\n`, `${pre}_userinfo`, 0);
  }
  const acts = W.activities
    .map((a) => `      <activity>\n        <moduleid>${a.mid}</moduleid>\n        <sectionid>${a.secnum}</sectionid>\n        <modulename>${a.modname}</modulename>\n        <title>${esc(a.title)}</title>\n        <directory>${a.dir}</directory>\n        <insubsection></insubsection>\n      </activity>\n`)
    .join('');
  const secs = plan.sections
    .map((s) => `      <section>\n        <sectionid>${s.sectionNum}</sectionid>\n        <title>${esc(safeActivityName(s.title, 255))}</title>\n        <directory>sections/section_${s.sectionNum}</directory>\n        <parentcmid></parentcmid>\n        <modname></modname>\n      </section>\n`)
    .join('');
  W.put('moodle_backup.xml', `<?xml version="1.0" encoding="UTF-8"?>
<moodle_backup>
<information>
  <name>cursia-v3-${plan.course.id}.mbz</name>
  <moodle_version>${MV.mv}</moodle_version>
  <moodle_release>${MV.mr}</moodle_release>
  <backup_version>${MV.bv}</backup_version>
  <backup_release>${MV.br}</backup_release>
  <backup_date>${ts}</backup_date>
  <mnet_remoteusers>0</mnet_remoteusers>
  <include_files>1</include_files>
  <include_file_references_to_external_content>0</include_file_references_to_external_content>
  <original_wwwroot>https://cursia.nomaddi.com</original_wwwroot>
  <original_site_identifier_hash>7723815fd5e7880d12bcade15abbbfc8</original_site_identifier_hash>
  <original_course_id>${MBZ_V3_COURSE_BACKUP_ID}</original_course_id>
  <original_course_fullname>${esc(courseTitle)}</original_course_fullname>
  <original_course_shortname>${esc(courseTitle)}</original_course_shortname>
  <original_course_format>topics</original_course_format>
  <original_course_startdate>${ts}</original_course_startdate>
  <original_course_enddate>0</original_course_enddate>
  <original_course_contextid>${MBZ_V3_COURSE_BACKUP_CONTEXTID}</original_course_contextid>
  <original_system_contextid>${MBZ_V3_SYSTEM_BACKUP_CONTEXTID}</original_system_contextid>
  <details>
    <detail backup_id="cursiav3${plan.course.id}${ts}">
      <type>course</type><format>moodle2</format><interactive>1</interactive>
      <mode>70</mode><execution>2</execution><executiontime>0</executiontime>
    </detail>
  </details>
  <contents>
    <activities>\n${acts}    </activities>
    <sections>\n${secs}    </sections>
    <course>
      <courseid>${MBZ_V3_COURSE_BACKUP_ID}</courseid>
      <title>${esc(courseTitle)}</title>
      <directory>course</directory>
    </course>
  </contents>
  <settings>\n${sett}  </settings>
</information>
</moodle_backup>`);

  const mbz = (await W.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })) as Buffer;
  return {
    mbz,
    expectations: { facts, resolved, h5pProfileVersion },
    summary: {
      builderVersion: DYNAMIC_MBZ_BUILDER_VERSION_V3,
      moodleVersion: MV.br,
      planSha256: packagingPlanV3Sha256(plan),
      themeSha256: themeSha256(theme),
      themeFamily: theme.familyId,
      themeMode: theme.mode,
      h5pProfileVersion,
      vcRendererVersion: VC_RENDERER_VERSION,
      h5pPackages,
      mockPresentationChapters,
      pendingVideos: plan.omittedVideos.map((v) => ({
        itemKey: v.videoKey, chapterId: v.chapterId, chapterNumber: v.chapterNumber, title: v.title, notice: noticeChapterIds.includes(v.chapterId),
      })),
      warnings,
      counts: facts.counts,
      assessment: assessmentPackageSummary(resolved),
    },
  };
}

/** Librerías del perfil (para el validador): "Machine major.minor". */
export function h5pProfileLibraryKeys(): Set<string> {
  return new Set(CURSIA_H5P_PROFILE_V1.libraries.map((l) => `${l.machineName} ${l.majorVersion}.${l.minorVersion}`));
}
