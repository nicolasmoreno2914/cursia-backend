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
import { ChapterExperience, VC_RUNTIME_VERSION, VC_SCHEMA_VERSION } from '../modules/visual-components';
import {
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
  closingLabel,
  competenciesLabel,
  examInfoLabel,
  finalExamInfoLabel,
  libroCardLabel,
  methodologyLabel,
  moduleIntroLabel,
  routeLabel,
  validateH5pActivityPayload,
  welcomeLabel,
} from '../modules/course-shell';
import { PackagingPlanV3, buildPackagingPlanV3, packagingPlanV3Sha256 } from '../modules/dynamic-packaging/packaging-plan-v3';
import { compileLibroHtmlV3, libroWordCount } from './v3/libro-v3';
import { downscaleCoverPng } from './v3/png-downscale';
import { activityPackageFilename, h5pActivityInlineIntroHtml, introThemeFrom, scormIntroHtml } from './v3/activity-intro';
import { IdAllocator, buildQuizV3, parseScormManifestIds, scormActivityXmlV3 } from './v3/moodle-activities-v3';

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
 */
export const DYNAMIC_MBZ_BUILDER_VERSION_V3 = '3.0.1';
/** Versión del renderer de Visual Components que entra en la clave de reuse. */
export const VC_RENDERER_VERSION = `vc${VC_SCHEMA_VERSION}-rt${VC_RUNTIME_VERSION}-theme${THEME_ENGINE_VERSION}`;

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
    warnings: string[];
    counts: CourseFacts['counts'];
  };
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

  addFile(ctx: number, component: string, filearea: string, filename: string, data: Buffer | string, mime: string): number {
    const { hash, size } = this.blob(data);
    const id = this.fileId++;
    this.files.push({ id, hash, ctx, component, filearea, filename, size, mime });
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
export function assertTokensV3(html: string, modnameByMid: Map<number, string>, where: string): void {
  const bad: string[] = [];
  for (const m of html.matchAll(/\$@([A-Z0-9_]+)(?:\*(\d+))?@\$/g)) {
    const kind = m[1];
    const idStr = m[2];
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
  if (plan.keys.finalExam && (typeof c.finalExamGift !== 'string' || !c.finalExamGift.trim())) missing.push(plan.keys.finalExam);
  for (const m of plan.modules) {
    if (!c.moduleIntros.has(m.moduleId)) missing.push(m.keys.moduleIntro);
    if (m.keys.exam && !(c.examGift.get(m.moduleId) ?? '').trim()) missing.push(m.keys.exam);
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

/** Construye el `.h5p` de la actividad de un capítulo (R7) con la nota del perfil vigente. */
async function buildActivityH5p(
  payload: unknown,
  chapterId: string,
  itemKey: string,
  passingGrade: number,
): Promise<{ h5p: Buffer; mainLibrary: string }> {
  const check = validateH5pActivityPayload(payload, { chapterId, itemKey });
  if (!check.ok) {
    throw new Error(`H5P_ACTIVITY_PAYLOAD_INVALID: ${itemKey}: ${check.errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join('; ')}`);
  }
  const p = payload as { type: string; data: Record<string, unknown> };
  const input: Record<string, unknown> = { ...p.data, itemKey };
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

export async function buildDynamicMbzV3(input: BuildDynamicMbzV3Input): Promise<BuildDynamicMbzV3Result> {
  if (!Number.isInteger(input?.ts) || input.ts <= 0) throw new Error('MBZ_V3_INVALID: ts (reloj inyectado) debe ser un entero > 0');
  const { manifest, blueprint, contents: c, ts } = input;
  const plan = buildPackagingPlanV3(manifest, blueprint, { manifestId: input.manifestId ?? null });
  const missing = collectMissing(plan, c);
  if (missing.length) throw new PackagingV3ContentMissingError(missing);
  const MV = resolveMoodleVersion(input.moodleVersion);
  const level = input.level === 'clean_safe' ? undefined : ('enhanced' as const);
  const opts = level ? { level } : undefined;
  const warnings: string[] = [];

  // ── Tema (R1) y evaluación (R6) ──────────────────────────────────────────
  const theme: ResolvedTheme = resolveTheme(input.presentation);
  const themeErrors = validateTheme(theme, { moduleCount: plan.modules.length });
  if (themeErrors.length) throw new Error(`THEME_INVALID: ${themeErrors.map((e) => e.code).join(', ')}`);
  const resolved = resolveAssessment(input.assessmentProfile, {
    hasFinalExam: plan.features.finalExam,
    activityEngine: plan.features.activityEngine,
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
  const examQuestionCountByModule: Record<string, number> = {};
  for (const m of plan.modules) {
    if (!m.keys.exam) continue;
    const n = parseGIFT(c.examGift.get(m.moduleId) as string).length;
    if (n < 1) throw new Error(`QUIZ_V3_EMPTY: el GIFT de ${m.keys.exam} no produjo preguntas`);
    examQuestionCountByModule[m.moduleId] = n;
  }
  let finalExamQuestionCount: number | undefined;
  if (plan.keys.finalExam) {
    finalExamQuestionCount = parseGIFT(c.finalExamGift as string).length;
    if (finalExamQuestionCount < 1) throw new Error(`QUIZ_V3_EMPTY: el GIFT de ${plan.keys.finalExam} no produjo preguntas`);
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

  const facts = buildCourseFacts({
    manifest,
    blueprint,
    assessment: input.assessmentProfile,
    hours: input.hours ?? null,
    artifacts: {
      audioWelcomeSeconds,
      audiobookParts: audiobook.parts.map((p) => ({ chapterId: p.chapterId, seconds: p.durationSeconds })),
      slideCountByChapter,
      examQuestionCountByModule,
      ...(finalExamQuestionCount !== undefined ? { finalExamQuestionCount } : {}),
      libroWordCount: libroWordCount(libroHtml),
    },
  });
  // R6: una categoría con peso > 0 y sin ítems calificables deja el curso sin poder llegar a 100 → falla fuerte.
  assertCategoriesPopulated(resolved, {
    practice: facts.counts.activities + facts.counts.videos,
    moduleExams: facts.counts.exams,
    finalExam: facts.finalExam.enabled ? 1 : 0,
  });

  // ── Capítulos (R11a) ─────────────────────────────────────────────────────
  const experiences: Record<string, ChapterExperience> = {};
  for (const ch of allChapters) experiences[ch.chapterId] = c.experiences.get(ch.chapterId) as ChapterExperience;
  const assembled = assembleAllChapters(facts, experiences, theme, opts);

  // ── Zip ──────────────────────────────────────────────────────────────────
  const W = new MbzWriter(ts, MV);
  const ids = new IdAllocator({
    qcat: 1000, qbe: 1000, qversion: 1000, question: 1000, qinstance: 1000, qref: 1000, answer: 1000,
    match: 1000, qoptions: 1000, qsection: 1000, sco: 50000, scodata: 60000,
  });
  const graded: Array<CompletionCandidate & { name: string }> = [];
  const labelsHtml: Array<{ where: string; html: string }> = [];
  const h5pPackages: MbzV3H5pPackage[] = [];
  const mockPresentationChapters: string[] = [];
  const introTheme = introThemeFrom(theme);

  const addLabel = (secnum: number, idnumber: string, label: ShellLabel, files: Array<{ name: string; data: Buffer | string; mime: string }> = []): ActivityRef => {
    const a = W.newActivity('label', secnum, label.name, idnumber);
    const fileIds = files.map((f) => W.addFile(a.ctx, 'mod_label', 'intro', f.name, f.data, f.mime));
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
    h5pPackages.push({ itemKey, filename, mainLibrary, sha1: sha1Buf(h5p), bytes: h5p.length });
  };

  const questionCategories: string[] = [];
  const addQuiz = (secnum: number, idnumber: string, name: string, kind: 'exam' | 'finalExam', gift: string, stampSeed: string): void => {
    const a = W.newActivity('quiz', secnum, name, idnumber);
    const k = resolved.kinds[kind];
    const q = buildQuizV3({
      aid: a.aid, mid: a.mid, ctx: a.ctx, name, introHtml: `<p>${esc(name)}</p>`, gift,
      attempts: k.attempts, grademethod: k.gradeMethod, ts, stampSeed, ids,
    });
    W.put(`${a.dir}/quiz.xml`, q.quizXml);
    questionCategories.push(q.questionCategoriesXml);
    gradedCommon(a, kind, name, [], q.categoryIds);
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
    W.put(`${a.dir}/module.xml`, withIdnumber(moduleXml(a.mid, 'resource', 1, ts, MV.bv), a.idnumber));
    W.put(`${a.dir}/inforef.xml`, inforef([fid]));
    W.put(`${a.dir}/grades.xml`, gradesXml(a.aid));
    W.boilerplate(a.dir);
  }
  addLabel(1, 'cv3:shell:libro_card', libroCardLabel(libroMid, facts, theme, opts));
  addLabel(1, 'cv3:shell:audiobook', audiobookLabel(facts, theme, opts), [
    { name: SHELL_AUDIOBOOK_FILE, data: audiobook.buffer, mime: 'audio/mp3' },
  ]);

  // ── Una sección por módulo ───────────────────────────────────────────────
  const chapterSlots = new Map(assembled.map((x) => [x.chapterNumber, x.slots]));
  for (const m of plan.modules) {
    const mf = facts.modules.find((x) => x.id === m.moduleId);
    if (!mf) throw new Error(`MBZ_V3_INVARIANT: módulo ${m.moduleId} ausente en facts`);
    const sec = m.sectionNum;
    addLabel(sec, `cv3:module_intro:${m.moduleId}`, moduleIntroLabel(mf, moduleIntros.get(m.moduleId) as ModuleIntroV3, facts, theme, opts));
    for (const ch of m.chapters) {
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
            title: ch.title,
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
          const built = await buildActivityH5p(act.payload, ch.chapterId, key, resolved.kinds.activity.passingGrade);
          const filename = activityPackageFilename(key);
          addH5pActivity(sec, `${idp}:activity`, name, 'activity', key, filename, built.h5p, built.mainLibrary, (mid) =>
            h5pActivityInlineIntroHtml({ packageFilename: filename, title: ch.title, activityMid: mid, theme: introTheme }),
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
          const introHtml = scormIntroHtml(introTheme);
          const k = resolved.kinds.activity;
          W.put(`${a.dir}/scorm.xml`, scormActivityXmlV3({
            aid: a.aid, mid: a.mid, ctx: a.ctx, name, introHtml, zipName, zipHash: sha1Buf(zipData), ids: mids,
            scoOrg: ids.take('sco'), scoItem: ids.take('sco'), scoD1: ids.take('scodata'), scoD2: ids.take('scodata'),
            whatgrade: k.gradeMethod, maxattempt: k.attempts, ts,
          }));
          gradedCommon(a, 'activity', name, fileIds);
          labelsHtml.push({ where: `${idp}:activity#intro`, html: introHtml });
        }
      }
    }
    if (m.keys.exam) {
      addLabel(sec, `cv3:exam_info:${m.moduleId}`, examInfoLabel(mf, facts, theme, opts));
      addQuiz(sec, `cv3:exam:${m.moduleId}`, safeActivityName(`Evaluación del módulo ${m.moduleNumber}: ${m.title}`), 'exam', c.examGift.get(m.moduleId) as string, m.keys.exam);
    }
  }

  // ── Sección de cierre ────────────────────────────────────────────────────
  const closing = plan.closingSectionNum;
  addLabel(closing, 'cv3:shell:closing', closingLabel(facts, courseIntro, theme, opts));
  if (plan.keys.finalExam) {
    addLabel(closing, 'cv3:final_exam_info', finalExamInfoLabel(facts, theme, opts));
    addQuiz(closing, 'cv3:final_exam', 'Evaluación final', 'finalExam', c.finalExamGift as string, plan.keys.finalExam);
  }

  // ── Tokens (fail loud) ───────────────────────────────────────────────────
  for (const l of labelsHtml) assertTokensV3(l.html, W.modnameByMid, l.where);

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
<course id="1" contextid="1">
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
    <courseformatoption><format>topics</format><sectionid>0</sectionid><name>coursedisplay</name><value>0</value></courseformatoption>
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
  }));
  W.put('completion.xml', courseCompletionXml({
    criteria: completionCriteriaFor(graded.map((g) => ({ moduleId: g.moduleId, modname: g.modname, kind: g.kind })), resolved.courseCompletion),
    aggregation: 'all',
    requireCourseGradePass: resolved.courseCompletion.requireCourseGradePass,
    courseGradepass: resolved.courseCompletion.courseGradepass,
  }));

  // ── Archivos raíz ────────────────────────────────────────────────────────
  W.put('roles.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<roles_definition>\n</roles_definition>');
  W.put('scales.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<scales_definition>\n</scales_definition>');
  W.put('outcomes.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<outcomes_definition>\n</outcomes_definition>');
  W.put('badges.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<badges>\n</badges>');
  W.put('users.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<users>\n</users>');
  W.put('grade_history.xml', BOIL.gradeHistory);
  W.put('groups.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<groups>\n  <groupcustomfields>\n  </groupcustomfields>\n  <groupings>\n    <groupingcustomfields>\n    </groupingcustomfields>\n  </groupings>\n</groups>');
  W.put('questions.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<question_categories>\n${questionCategories.join('')}</question_categories>`);

  let filesXml = '<?xml version="1.0" encoding="UTF-8"?>\n<files>\n';
  for (const f of W.files) {
    filesXml +=
      `  <file id="${f.id}">\n    <contenthash>${f.hash}</contenthash>\n    <contextid>${f.ctx}</contextid>\n` +
      `    <component>${f.component}</component>\n    <filearea>${f.filearea}</filearea>\n    <itemid>0</itemid>\n` +
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
    activities: '1', blocks: '0', files: '1', filters: '1', comments: '0', badges: '0',
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
  <original_course_id>1</original_course_id>
  <original_course_fullname>${esc(courseTitle)}</original_course_fullname>
  <original_course_shortname>${esc(courseTitle)}</original_course_shortname>
  <original_course_format>topics</original_course_format>
  <original_course_startdate>${ts}</original_course_startdate>
  <original_course_enddate>0</original_course_enddate>
  <original_course_contextid>1</original_course_contextid>
  <original_system_contextid>1</original_system_contextid>
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
      <courseid>1</courseid>
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
      warnings,
      counts: facts.counts,
    },
  };
}

/** Librerías del perfil (para el validador): "Machine major.minor". */
export function h5pProfileLibraryKeys(): Set<string> {
  return new Set(CURSIA_H5P_PROFILE_V1.libraries.map((l) => `${l.machineName} ${l.majorVersion}.${l.minorVersion}`));
}
