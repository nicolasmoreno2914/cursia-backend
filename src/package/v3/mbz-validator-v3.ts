/**
 * Cursia V2.1 — R12: validador del `.mbz` v3 (audit §Q.8), ANTES de subir.
 *
 * Lee el paquete ya armado (no el estado en memoria del builder) y lo compara
 * contra lo que DEBE decir (facts + evaluación resuelta del perfil vigente):
 *   GRADEPASS / GRADEMAX / COMPLETION     cada ítem calificable = perfil, 0–100, completion al recibir nota
 *                                          (r55: completionusegrade 1, completionpassgrade 0); H5P evaluativo con
 *                                          enabletracking 1 y grade 100
 *   CATEGORIES / COURSE_GRADEPASS          categorías, pesos y nota del curso
 *   COURSE_COMPLETION                      criterios de completion del curso
 *   GRADE_CRITERION / CRITERIA_ACTIVITY    r55 (invariantes, independientes de las banderas del perfil): curso con nota ⇒
 *   GRADE_CRITERION_CERT / PEDAGOGICAL      EXACTAMENTE un criterio tipo 6 con gradepass = gradepass del ítem del curso =
 *                                          nota mínima del perfil (> 0), NINGÚN criterio de actividad, agregación ALL;
 *                                          insignia ⇒ criterio de nota; lo pedagógico (Repaso, labels, páginas, foro,
 *                                          Libro) sin ítem de calificación, sin tracking ni criterio
 *   H5P_PARTIAL_LIBRARY_CLOSURE            r55 (R7): ningún .h5p con carpetas de librería (todos solo contenido) y,
 *                                          si alguna aparece, su clausura de dependencias debe venir completa
 *   RESOURCE_DISABLED / TRANSITION_*       ningún label menciona un recurso apagado
 *   NUMBER_NOT_FROM_FACTS                  cifras de los labels determinísticos ∈ facts
 *   CLEAN_SAFE                             lint CLEAN_SAFE (cuerpo ≥ 16 px, contraste, hex…) en todo label
 *   TOKEN_INVALID                          todo `$@…$` apunta a un módulo del paquete del tipo correcto
 *   H5P_FILES / H5P_LIBRARIES              un solo .h5p (package) por h5pactivity y el intro lo embebe (V542 I2); solo librerías del perfil
 *                                          EV6 H5P v2: un .h5p de una principal "bundled" de
 *                                          CURSIA_H5P_PROFILE_V3 (Branching Scenario, Dialog Cards y,
 *                                          UX #5, QuestionSet 1.21) lleva EXACTAMENTE sus carpetas delta,
 *                                          con library.json = versión del perfil; los demás siguen content-only (v1)
 *   AUDIO_DURATION                         las duraciones mostradas = las medidas de los MP3 del paquete
 *   FILES_INTEGRITY / STRUCTURE / LIBRO    blobs, inforef, secuencias, Libro Guía
 *   T6 (r57) FILES_INTEGRITY               además: ningún blob huérfano ni con ruta mal formada; todo archivo de files.xml
 *                                          con dueño (inforef de su actividad, o la imagen de la insignia); @@PLUGINFILE@@
 *                                          también en el contenido de las páginas (filearea content)
 *   T6 (r57) TOKEN_INVALID                 además: tokens del contenido de las páginas y enlaces muertos (href="#",
 *                                          vacío, javascript:) en todo HTML visible
 *   T6 (r57) MANIFEST_COVERAGE             cada parte de facts por capítulo (presentación con PDF+portada, video,
 *                                          actividad con su tipo de módulo) está exactamente una vez; nada de más
 *   T6 (r57) H5P_FILES                     además: content/content.json presente y JSON válido
 *   T6 (r57) TEACHER_GUIDE                 Guía del docente ⇔ facts.teacherGuide: página oculta, estudiante prohibido,
 *                                          sin nota, con el aviso y cada módulo/capítulo; nadie la enlaza
 *   LIBRO_CTA (≥ 3.13.0)                   botón «Abrir Libro Guía» a su propio recurso, pestaña nueva
 *   SECTIONS / NAVIGATION                  EV6: una sección por capítulo/evaluación, cierre al final
 *                                          (después del examen final), coursedisplay = 1 y cada
 *                                          botón «Continuar…» → la sección que corresponde
 *   CERTIFICATE                            EV6 T3: insignia de curso (badges.xml) con criterio de
 *                                          completion del curso del backup, setting badges = 1,
 *                                          imagen f1/f2/f3 PNG, examen final como criterio y el
 *                                          panel «Tu certificado» con $@BADGESVIEWBYID*curso@$
 *   QUIZ_FEEDBACK                          QUIZFB: retroalimentación global «aprobaste / todavía no» con la nota mínima del perfil
 *   QUIZ_REVIEW / QUIZ_COMPLETION          EV6 P2-B1: revisión de las respuestas propias al terminar sin nota por pregunta (V542 I1), nota total más tarde;
 *                                          r55 (R6): completionminattempts = intentos (si > 0), attemptsexhausted 0
 *   QUIZ_RANDOM / EXPLANATIONS_GATE /      EV6 P2-B5 (exam-validator-v3.ts): banco aleatorio por hoja,
 *   ANSWER_LEAK                            página «Respuestas explicadas» gated por SU quiz, ningún par
 *                                          enunciado + respuesta correcta fuera de su página
 *   TEACHER_NOTE                           EV6 P2-B5: nota para docentes de las evaluaciones exactamente
 *                                          una vez, oculta, con las dos oraciones, sii hay ≥ 1 evaluación
 * Identifica cada módulo por su `idnumber` `cv3:…` (estructura por UUID).
 * Puro salvo el unzip en memoria; nunca lanza por un hallazgo: los devuelve todos.
 */
import * as JSZip from 'jszip';
import { createHash } from 'crypto';
import {
  ASSESSMENT_CATEGORY_NAMES,
  ResolvedAssessment,
  completionCriteriaFor,
} from '../assessment';
import type { AssessmentCategoryKey } from '../assessment/resolve-assessment';
import type { AssessableType } from '../../modules/course-profiles/course-profiles';
import { extractText, lintCleanSafe, lintInternalVocabulary, lintResourceMentions, parseHtml, stripProtectedVocabularyTexts } from '../../modules/visual-components';
import type { HtmlNode } from '../../modules/visual-components';
import { APPLICATION_SOLUTION_MARKERS_RE, CERTIFICATE_TEACHER_TROUBLESHOOTING, EXAMS_TEACHER_NOTE_ATTEMPTS, EXAMS_TEACHER_NOTE_AVAILABILITY, EXAMS_TEACHER_NOTE_UNLIMITED, CourseFacts, chapterNextSteps, closingCertificateText, courseApprovalRequirements, courseApprovalTeacherNote, courseHasGrades, examOverallFeedbackBands, examsHaveUnlimitedAttempts, examsTeacherNoteFor, lintShellNumbers, sectionLayoutFromFacts, stripStructureTitles, WELCOME_LEAD_MAX_WORDS, WELCOME_PARA_MAX_WORDS } from '../../modules/course-shell';
import { safeActivityName } from '../mbz-common';
import { PRACTICE_FILE_MIMETYPES, PRACTICE_RESOURCE_LIMITS, extensionOf } from '../../modules/course-profiles/application-delivery';
import { courseBadgeDescription } from './course-badge';
import { TEACHER_GUIDE_HIDDEN_NOTICE, TEACHER_GUIDE_IDNUMBER } from '../../modules/course-shell/teacher-guide-page';
import { QUIZ_REVIEW_V3 } from './moodle-activities-v3';
import { formatDurationEs, mp3DurationSeconds } from '../audio';
import { ExamBankPlans, examChecksV3, readExamPackageV3 } from './exam-validator-v3';
import {
  CURSIA_H5P_PROFILE_V3,
  H5P_MOODLE_GRADING,
} from '../h5p';

/** r19 W: palabras visibles (sin guiones suaves). */
const wordCountText = (t: string): number => t.replace(/[\u00AD\u200B]/g, '').trim().split(/\s+/).filter(Boolean).length;

const ACTIVITY_MAIN_LIBRARY: Record<string, string> = {
  questionset: 'H5P.QuestionSet',
  dragtext: 'H5P.DragText',
  blanks: 'H5P.Blanks',
  singlechoiceset: 'H5P.SingleChoiceSet',
  // EV6 H5P v2 (solo Manifests con activityTypeRules=2 lo declaran en facts).
  branchingscenario: 'H5P.BranchingScenario',
};

/** r55 review r1 (M6): `&` que NO abre una entidad XML válida, o `<` — texto XML mal escapado. */
export const RAW_XML_AMP_OR_LT = /&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)|</;

export interface MbzV3Issue {
  code: string;
  where: string;
  message: string;
}

export interface MbzV3ValidationExpectations {
  facts: CourseFacts;
  resolved: ResolvedAssessment;
  /** EV6 P2-B5: plan por hoja de cada quiz con banco (del builder). Sin él, QUIZ_RANDOM exige solo coherencia interna. */
  examBankPlans?: ExamBankPlans;
  /**
   * V542 fix round 3 (N1): prosa LLM de cada label del shell, por idnumber (del builder). Sus cifras de CONTENIDO
   * se admiten SOLO en ese label; todo lo demás (plantilla) es estricto. Sin ella, todo el label es estricto.
   */
  shellProseByLabel?: Record<string, string[]>;
  /**
   * UX r18 fix 1 (M4): versión del builder que armó el paquete (`expectations.builderVersion`). Las reglas de UX r18
   * (orden de la sección 0, botón «Iniciar actividad» solo hacia una actividad no embebida) aplican desde 3.12.0;
   * sin versión (expectativas guardadas de paquetes anteriores) o con una menor, no se evalúan: un paquete 3.11.0
   * válido no se reporta como fallido.
   */
  builderVersion?: string;
  /** T1 (r57): exenciones de dominio del vocabulario interno (del builder). Ausente = el check no aplica (paquete viejo). */
  internalVocabularyExempt?: string[];
  /** Review r1 (I2): fragmentos escritos por una persona (títulos, archivos de práctica, perfil): nunca se juzgan. */
  internalVocabularyUserTexts?: string[];
}

/** true si `v` (x.y.z) ≥ `min`. Una versión ausente o mal formada → false. */
export function builderVersionAtLeast(v: string | undefined, min: string): boolean {
  const parse = (x: string | undefined): number[] | null => (typeof x === 'string' && /^\d+\.\d+\.\d+$/.test(x) ? x.split('.').map(Number) : null);
  const a = parse(v);
  const b = parse(min) as number[];
  if (!a) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

export interface MbzV3ValidationResult {
  ok: boolean;
  issues: MbzV3Issue[];
  stats: { activities: number; labels: number; graded: number; h5p: number; files: number };
}

interface ParsedActivity {
  mid: number;
  sectionid: number;
  modname: string;
  dir: string;
  idnumber: string;
  name: string;
  intro: string;
  ctx: number;
  module: Record<string, string>;
  grade: Record<string, string> | null;
  inforefFiles: number[];
  inforefGradeItems: number[];
  gradeItemId: number | null;
  moduleXmlId: number;
  actXmlModuleId: number;
  /** P2-B1: solo para modname 'quiz' — campos crudos de quiz.xml que no tienen otro lugar en ParsedActivity. */
  quiz: { attempts_number: string; completionattemptsexhausted: string; completionminattempts: string; feedbacks: Array<{ text: string; min: number; max: number }> } & Record<keyof typeof QUIZ_REVIEW_V3, string> | null;
  /** r55: solo h5pactivity — `grade` y `enabletracking` de h5pactivity.xml. */
  h5p: { grade: string; enabletracking: string } | null;
  /** T4 (r57): solo assign — campos de assign.xml y su plugin_config (`subtype/plugin/name` → valor). */
  assign: { grade: string; completionsubmit: string; duedate: string; alwaysshowdescription: string; teamsubmission: string; configs: Record<string, string> } | null;
}

interface ParsedFile {
  id: number;
  hash: string;
  ctx: number;
  component: string;
  filearea: string;
  filename: string;
  size: number;
  itemid: number;
  mimetype: string;
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
}

function unxml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function blocks(xml: string, name: string): string[] {
  return Array.from(xml.matchAll(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}>`, 'g')), (m) => m[0]);
}

function num(v: string | null | undefined): number {
  return v === null || v === undefined ? NaN : Number(v);
}

type ResourceKind = 'video' | 'activity' | 'exam' | 'final_exam' | 'presentation' | 'other';

/** Clasifica una coincidencia de RESOURCE_MENTION (texto normalizado, sin acentos). */
export function resourceMentionKind(match: string): ResourceKind {
  const s = match.toLowerCase();
  if (/video/.test(s)) return 'video';
  if (/final/.test(s) && /(examen|evaluacion)/.test(s)) return 'final_exam';
  if (/(examen|evaluacion|quiz)/.test(s)) return 'exam';
  if (/(presentacion|diapositiva)/.test(s)) return 'presentation';
  if (/(actividad|juego|scorm|h5p)/.test(s)) return 'activity';
  return 'other';
}

function transitionTexts(html: string, kind: 'nav' | 'rail' = 'nav'): string[] {
  const out: string[] = [];
  const walk = (n: HtmlNode) => {
    if (n.kind !== 'el') return;
    // EV4b: el recorrido «En este capítulo» (cvc-route) también es navegación determinística:
    // pasa por las mismas reglas (no promete video, práctica ni evaluación que no existan).
    const cls = (n.attrs.class || '').split(/\s+/);
    // P3: la línea de progreso de la apertura también es navegación (cifras de facts). El riel «Dónde
    // estás» (cvc-modrail) describe el MÓDULO: se devuelve aparte (kind 'rail') con sus propias reglas.
    const isRail = cls.includes('cvc-modrail');
    if (kind === 'rail' ? isRail : !isRail && (cls.includes('cvc-transition') || cls.includes('cvc-route') || cls.includes('cvc-progress'))) {
      out.push(extractText(serialize(n)));
      return;
    }
    n.children.forEach(walk);
  };
  walk(parseHtml(html));
  return out;
}

function serialize(n: HtmlNode): string {
  if (n.kind === 'text') return n.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('');
  return `<${n.tag}${attrs}>${n.children.map(serialize).join('')}</${n.tag}>`;
}

function kindOfGraded(idnumber: string): AssessableType | null {
  if (/^cv3:ch:[^:]+:video$/.test(idnumber)) return 'video';
  if (/^cv3:ch:[^:]+:activity$/.test(idnumber)) return 'activity';
  if (/^cv3:exam:/.test(idnumber)) return 'exam';
  if (idnumber === 'cv3:final_exam') return 'finalExam';
  return null;
}

const GRADED = new Set(['quiz', 'scorm', 'h5pactivity']);

/** EV6 H5P v2: add-on «Repaso» (Dialog Cards) — h5pactivity SIN nota, completion por vista. */
const REVIEW_CARDS_RE = /^cv3:ch:([^:]+):review_cards$/;
/** Fase 2: Actividad de Aplicación — página del estudiante y solucionario docente (oculto). */
const APPLICATION_RE = /^cv3:ch:([^:]+):application$/;
const APPLICATION_SOLUTION_RE = /^cv3:ch:([^:]+):application_solution$/;
/** Loop 9 B: página «Práctica guiada — <capítulo>» (visible, formativa, completion por vista). */
const GUIDED_PRACTICE_RE = /^cv3:ch:([^:]+):guided_practice$/;
/** Marcas que solo puede tener el solucionario (la página del estudiante nunca lleva respuestas). */
// Fase 2: la misma regex que rechaza la generación (validateApplicationStudentPart), para que nunca diverjan.
const SOLUTION_MARKERS_RE = APPLICATION_SOLUTION_MARKERS_RE;

export async function validateMbzV3(mbz: Buffer, exp: MbzV3ValidationExpectations): Promise<MbzV3ValidationResult> {
  const issues: MbzV3Issue[] = [];
  const add = (code: string, where: string, message: string) => issues.push({ code, where, message });
  const zip = await JSZip.loadAsync(mbz);
  const text = async (p: string): Promise<string | null> => (zip.file(p) ? zip.file(p)!.async('string') : null);
  // R16: un blob compartido (p. ej. el paquete H5P y su intro, mismo hash) se inflaba
  // una vez por cada entrada de files.xml y otra al abrir el .h5p. Se memoiza por ruta,
  // solo para blobs chicos (≤ 1 MiB descomprimido: los .h5p/zip de actividades) para no
  // retener en memoria audios y PDFs grandes. Nadie muta los buffers devueltos.
  const binCache = new Map<string, Promise<Buffer | null>>();
  const BIN_CACHE_MAX_BYTES = 1024 * 1024;
  // EV6 H5P v2: los .h5p con librerías (Branching Scenario ≈ 3.7 MB) superan el memo de 1 MiB.
  // Se retienen SOLO los blobs de paquetes H5P (filearea package de mod_h5pactivity) hasta
  // terminar la sección H5P, para inflarlos una vez; audios/PDF grandes siguen sin retenerse.
  const keepBlobs = new Set<string>();
  const bin = async (p: string): Promise<Buffer | null> => {
    const hit = binCache.get(p);
    if (hit) return hit;
    const f = zip.file(p);
    if (!f) return null;
    const pr = f.async('nodebuffer');
    binCache.set(p, pr);
    const buf = await pr;
    if (buf.length > BIN_CACHE_MAX_BYTES && !keepBlobs.has(p)) binCache.delete(p);
    return buf;
  };
  const { facts, resolved } = exp;

  const mb = await text('moodle_backup.xml');
  if (!mb) {
    add('STRUCTURE', 'moodle_backup.xml', 'falta moodle_backup.xml');
    return { ok: false, issues, stats: { activities: 0, labels: 0, graded: 0, h5p: 0, files: 0 } };
  }

  // ── files.xml ──
  const filesXml = (await text('files.xml')) ?? '';
  const rootRoles = (await text('roles.xml')) ?? '';
  const files: ParsedFile[] = blocks(filesXml, 'file').map((b) => ({
    id: num(/<file id="(\d+)"/.exec(b)?.[1]),
    hash: tag(b, 'contenthash') ?? '',
    ctx: num(tag(b, 'contextid')),
    component: tag(b, 'component') ?? '',
    filearea: tag(b, 'filearea') ?? '',
    filename: unxml(tag(b, 'filename') ?? ''),
    size: num(tag(b, 'filesize')),
    itemid: num(tag(b, 'itemid')),
    mimetype: unxml(tag(b, 'mimetype') ?? ''),
  }));
  const fileById = new Map(files.map((f) => [f.id, f]));
  for (const f of files) {
    if (f.component === 'mod_h5pactivity' && f.filearea === 'package' && f.filename !== '.') keepBlobs.add(`files/${f.hash.slice(0, 2)}/${f.hash}`);
  }
  // Un mismo blob (paquete + intro del H5P) se verifica una sola vez; los hallazgos siguen siendo por entrada.
  const blobFacts = new Map<string, { sha1: string; length: number } | null>();
  for (const f of files) {
    if (f.filename === '.') continue;
    const bp = `files/${f.hash.slice(0, 2)}/${f.hash}`;
    if (!blobFacts.has(bp)) {
      const b = await bin(bp);
      blobFacts.set(bp, b ? { sha1: createHash('sha1').update(b).digest('hex'), length: b.length } : null);
    }
    const blob = blobFacts.get(bp);
    if (!blob) add('FILES_INTEGRITY', `file ${f.id}`, `falta el blob files/${f.hash.slice(0, 2)}/${f.hash} (${f.filename})`);
    else {
      if (blob.sha1 !== f.hash) add('FILES_INTEGRITY', `file ${f.id}`, `sha1 del blob ≠ contenthash (${f.filename})`);
      if (blob.length !== f.size) add('FILES_INTEGRITY', `file ${f.id}`, `filesize ${f.size} ≠ ${blob.length} (${f.filename})`);
    }
  }

  // ── actividades ──
  const acts: ParsedActivity[] = [];
  const contentsXml = tag(mb, 'contents') ?? '';
  for (const b of blocks(tag(contentsXml, 'activities') ?? '', 'activity')) {
    const mid = num(tag(b, 'moduleid'));
    const modname = tag(b, 'modulename') ?? '';
    const dir = tag(b, 'directory') ?? '';
    const moduleXml = (await text(`${dir}/module.xml`)) ?? '';
    if (!moduleXml) {
      add('STRUCTURE', dir, 'falta module.xml');
      continue;
    }
    const actXml = (await text(`${dir}/${modname}.xml`)) ?? '';
    if (!actXml) add('STRUCTURE', dir, `falta ${modname}.xml`);
    const gradesXml = await text(`${dir}/grades.xml`);
    const gi = gradesXml ? blocks(gradesXml, 'grade_item')[0] : undefined;
    const inf = (await text(`${dir}/inforef.xml`)) ?? '';
    const fileref = tag(inf, 'fileref') ?? '';
    const module: Record<string, string> = {};
    for (const k of ['idnumber', 'completion', 'completiongradeitemnumber', 'completionpassgrade', 'completionview', 'sectionnumber', 'visible', 'visibleold', 'availability']) {
      module[k] = tag(moduleXml, k) ?? '';
    }
    let grade: Record<string, string> | null = null;
    if (gi) {
      grade = {};
      for (const k of ['categoryid', 'itemmodule', 'grademax', 'grademin', 'gradepass']) grade[k] = tag(gi, k) ?? '';
    }
    acts.push({
      mid,
      sectionid: num(tag(b, 'sectionid')),
      modname,
      dir,
      idnumber: unxml(module.idnumber),
      name: unxml(tag(actXml, 'name') ?? ''),
      intro: unxml(tag(actXml, 'intro') ?? ''),
      ctx: num(/contextid="(\d+)"/.exec(actXml)?.[1]),
      module,
      grade,
      inforefFiles: Array.from(fileref.matchAll(/<id>(\d+)<\/id>/g), (m) => Number(m[1])),
      inforefGradeItems: Array.from((tag(inf, 'grade_itemref') ?? '').matchAll(/<id>(\d+)<\/id>/g), (m) => Number(m[1])),
      gradeItemId: gi ? num(/<grade_item id="(\d+)"/.exec(gi)?.[1]) : null,
      moduleXmlId: num(/<module id="(\d+)"/.exec(moduleXml)?.[1]),
      actXmlModuleId: num(/moduleid="(\d+)"/.exec(actXml)?.[1]),
      quiz: modname === 'quiz'
        ? {
            attempts_number: tag(actXml, 'attempts_number') ?? '',
            completionattemptsexhausted: tag(actXml, 'completionattemptsexhausted') ?? '',
            completionminattempts: tag(actXml, 'completionminattempts') ?? '',
            feedbacks: [...actXml.matchAll(/<feedback id="\d+">([\s\S]*?)<\/feedback>/g)].map((m) => ({
              text: unxml(tag(m[1], 'feedbacktext') ?? ''), min: Number(tag(m[1], 'mingrade')), max: Number(tag(m[1], 'maxgrade')),
            })),
            ...(Object.fromEntries(Object.keys(QUIZ_REVIEW_V3).map((k) => [k, tag(actXml, k) ?? ''])) as Record<keyof typeof QUIZ_REVIEW_V3, string>),
          }
        : null,
      h5p: modname === 'h5pactivity' ? { grade: tag(actXml, 'grade') ?? '', enabletracking: tag(actXml, 'enabletracking') ?? '' } : null,
      assign: modname === 'assign'
        ? {
            grade: tag(actXml, 'grade') ?? '',
            completionsubmit: tag(actXml, 'completionsubmit') ?? '',
            duedate: tag(actXml, 'duedate') ?? '',
            alwaysshowdescription: tag(actXml, 'alwaysshowdescription') ?? '',
            teamsubmission: tag(actXml, 'teamsubmission') ?? '',
            configs: Object.fromEntries(blocks(actXml, 'plugin_config').map((b) => [`${tag(b, 'subtype')}/${tag(b, 'plugin')}/${tag(b, 'name')}`, unxml(tag(b, 'value') ?? '')])),
          }
        : null,
    });
  }
  const byMid = new Map(acts.map((a) => [a.mid, a]));
  // G6 M6: unicidad de ids y coherencia moduleid ↔ module.xml ↔ <activity>, grade_itemref ↔ grades.xml, tuplas de archivos.
  const dup = <T,>(xs: T[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
  for (const d of dup(acts.map((a) => a.mid))) add('STRUCTURE', 'moodle_backup.xml', `moduleid repetido ${d}`);
  for (const d of dup(acts.map((a) => a.ctx))) add('STRUCTURE', 'activities', `contextid repetido ${d}`);
  for (const d of dup(files.map((f) => f.id))) add('FILES_INTEGRITY', 'files.xml', `file id repetido ${d}`);
  for (const d of dup(files.filter((f) => f.filename !== '.').map((f) => `${f.ctx}|${f.component}|${f.filearea}|${f.filename}`))) {
    add('FILES_INTEGRITY', 'files.xml', `archivo repetido (ctx|component|filearea|filename) ${d}`);
  }
  for (const a of acts) {
    // r55 (moodle-versions.md): availability es texto XML — un `&` (p. ej. `"op":"&"`) o `<` crudo aborta la restauración.
    // r55 review r1 (M6): cualquier entidad XML válida (&amp; &lt; &gt; &quot; &apos; &#NN; &#xHH;) no es un & crudo.
    if (RAW_XML_AMP_OR_LT.test(a.module.availability ?? '')) add('STRUCTURE', a.dir, `availability con & o < sin escapar en XML: ${a.module.availability}`);
    if (a.moduleXmlId !== a.mid || a.actXmlModuleId !== a.mid) add('STRUCTURE', a.dir, `moduleid incoherente (backup ${a.mid}, module.xml ${a.moduleXmlId}, ${a.modname}.xml ${a.actXmlModuleId})`);
    const want = a.gradeItemId !== null ? [a.gradeItemId] : [];
    if (JSON.stringify(a.inforefGradeItems) !== JSON.stringify(want)) add('STRUCTURE', a.dir, `grade_itemref ${a.inforefGradeItems.join(',')} ≠ grades.xml ${want.join(',')}`);
  }
  for (const d of dup(acts.filter((a) => a.gradeItemId !== null).map((a) => a.gradeItemId))) add('STRUCTURE', 'grades', `grade_item id repetido ${d}`);
  const seenId = new Set<string>();
  for (const a of acts) {
    if (!/^cv3:/.test(a.idnumber)) add('STRUCTURE', a.dir, `idnumber sin prefijo cv3: (${a.idnumber})`);
    if (seenId.has(a.idnumber)) add('STRUCTURE', a.dir, `idnumber repetido ${a.idnumber}`);
    seenId.add(a.idnumber);
    for (const id of a.inforefFiles) {
      const f = fileById.get(id);
      if (!f) add('FILES_INTEGRITY', a.dir, `inforef apunta al file ${id}, que no está en files.xml`);
      else if (f.ctx !== a.ctx) add('FILES_INTEGRITY', a.dir, `file ${id} (${f.filename}) es de otro contexto`);
    }
  }
  // T6 (r57): integridad completa del almacén de archivos — todo blob de files/ lo declara files.xml (sin huérfanos ni
  // rutas mal formadas), y todo archivo declarado tiene dueño: el inforef de la actividad de su contexto o, fuera de
  // las actividades, solo la imagen de la insignia (badges/badgeimage, la juzga CERTIFICATE).
  const declaredHashes = new Set(files.filter((f) => f.filename !== '.').map((f) => f.hash));
  for (const n of Object.keys(zip.files)) {
    if (!n.startsWith('files/') || zip.files[n].dir) continue;
    const m = /^files\/([0-9a-f]{2})\/([0-9a-f]{40})$/.exec(n);
    if (!m || m[2].slice(0, 2) !== m[1]) add('FILES_INTEGRITY', n, 'blob con ruta mal formada (se espera files/<sha1[:2]>/<sha1>)');
    else if (!declaredHashes.has(m[2])) add('FILES_INTEGRITY', n, 'blob huérfano: ningún archivo de files.xml lo declara');
  }
  const actByCtx = new Map(acts.map((a) => [a.ctx, a]));
  for (const f of files) {
    if (f.filename === '.') continue;
    const owner = actByCtx.get(f.ctx);
    if (owner) {
      if (!owner.inforefFiles.includes(f.id)) add('FILES_INTEGRITY', owner.dir, `file ${f.id} (${f.component}/${f.filearea}/${f.filename}) sin referencia en el inforef de su actividad`);
    } else if (!(f.component === 'badges' && f.filearea === 'badgeimage')) {
      add('FILES_INTEGRITY', `file ${f.id}`, `archivo sin dueño (contexto ${f.ctx}, ${f.component}/${f.filearea}/${f.filename})`);
    }
  }

  // ── secciones ──
  const sectionIds = new Set<number>();
  const sectionList: Array<{ num: number; name: string }> = [];
  for (const b of blocks(tag(contentsXml, 'sections') ?? '', 'section')) {
    const dir = tag(b, 'directory') ?? '';
    const sx = (await text(`${dir}/section.xml`)) ?? '';
    const sid = /<section id="(\d+)"/.exec(sx)?.[1];
    if (sid !== undefined) sectionIds.add(Number(sid));
    const secnum = num(tag(sx, 'number'));
    sectionList.push({ num: secnum, name: unxml(tag(sx, 'name') ?? '') });
    const seq = (tag(sx, 'sequence') ?? '').split(',').filter(Boolean).map(Number);
    const expected = acts.filter((a) => a.sectionid === secnum).map((a) => a.mid);
    if (JSON.stringify(seq) !== JSON.stringify(expected)) add('STRUCTURE', dir, `sequence ${seq.join(',')} ≠ actividades de la sección ${expected.join(',')}`);
    for (const m of seq) if (!byMid.has(m)) add('STRUCTURE', dir, `sequence referencia el módulo ${m} inexistente`);
  }

  // ── EV6: layout de secciones (una por capítulo / evaluación; cierre al final) ──
  const layout = sectionLayoutFromFacts(facts);
  const steps = chapterNextSteps(facts, layout);
  const gotSecs = sectionList.map((x) => [x.num, x.name]);
  const wantSecs = layout.sections.map((x) => [x.sectionNum, safeActivityName(x.title, 255)]);
  if (JSON.stringify(gotSecs) !== JSON.stringify(wantSecs)) add('SECTIONS', 'sections', `secciones ${JSON.stringify(gotSecs)} ≠ ${JSON.stringify(wantSecs)}`);
  const lastSec = layout.sections[layout.sections.length - 1];
  if (lastSec.kind !== 'closing') add('SECTIONS', 'sections', 'la última sección no es el cierre del curso');
  if (layout.finalExamSection !== null && !(layout.finalExamSection < layout.closingSection)) add('SECTIONS', 'sections', 'el cierre aparece antes de la evaluación final');
  const courseXml = (await text('course/course.xml')) ?? '';
  if (!/<name>coursedisplay<\/name><value>1<\/value>/.test(courseXml)) add('SECTIONS', 'course/course.xml', 'coursedisplay ≠ 1 (una sección por página)');
  const expectedSection = (idn: string): number | undefined => {
    if (/^cv3:shell:(forum|welcome|audio_welcome|competencies|methodology|start|teacher_guide)$/.test(idn)) return 0;
    if (/^cv3:shell:(route|libro|libro_card|audiobook|route_start)$/.test(idn)) return 1;
    if (idn === 'cv3:shell:closing' || idn === 'cv3:shell:certificate_teacher') return layout.closingSection;
    if (/^cv3:final_exam(_info|_next|_explanations)?$/.test(idn)) return layout.finalExamSection ?? undefined;
    // EV6 P2-B4: nota para docentes (sin certificado) = primera sección con una evaluación.
    if (idn === 'cv3:shell:exams_teacher') {
      const secs = [...Object.values(layout.examSection), ...(layout.finalExamSection !== null ? [layout.finalExamSection] : [])].filter((x): x is number => Number.isInteger(x));
      return secs.length ? Math.min(...secs) : undefined;
    }
    let m = /^cv3:ch:([^:]+):/.exec(idn);
    if (m) return layout.chapterSection[m[1]];
    m = /^cv3:module_intro:(.+)$/.exec(idn);
    if (m) return layout.moduleFirstSection[m[1]];
    m = /^cv3:(?:exam_info|exam|exam_explanations):(.+)$/.exec(idn);
    if (m) return layout.examSection[m[1]];
    // Fix 1 (I1): module_next solo existe en la sección de evaluación (módulos con examen).
    m = /^cv3:module_next:(.+)$/.exec(idn);
    if (m) return layout.examSection[m[1]];
    return undefined;
  };
  for (const a of acts) {
    const want = expectedSection(a.idnumber);
    if (want === undefined) add('SECTIONS', a.idnumber, 'actividad sin sección esperada en el layout');
    else if (a.sectionid !== want) add('SECTIONS', a.idnumber, `en la sección ${a.sectionid}, esperada ${want}`);
  }
  // Botones «Continuar…»: exactamente UN enlace de sección por label de navegación, al destino correcto.
  const firstChapterSection = layout.moduleFirstSection[facts.modules[0]?.id];
  const ctaTarget = (idn: string): number | undefined => {
    if (idn === 'cv3:shell:start' || idn === 'cv3:shell:route_start') return firstChapterSection;
    if (idn === 'cv3:final_exam_next') return layout.closingSection;
    let m = /^cv3:ch:([^:]+):closing$/.exec(idn);
    if (m) return steps[m[1]]?.sectionNum;
    m = /^cv3:module_next:(.+)$/.exec(idn);
    if (m) {
      const i = facts.modules.findIndex((x) => x.id === m![1]);
      const nx = facts.modules[i + 1];
      return nx ? layout.moduleFirstSection[nx.id] : layout.finalExamSection ?? layout.closingSection;
    }
    return undefined;
  };
  const navIds = new Set<string>();
  const navBySectionTarget = new Map<string, string[]>();
  for (const a of acts) {
    const secLinks = Array.from(a.intro.matchAll(/\$@COURSESECTIONBYID\*(\d+)@\$/g), (x) => Number(x[1]));
    // Fix 1 (I1): dos botones de navegación de la MISMA sección al MISMO destino = botón duplicado.
    for (const t of new Set(secLinks)) {
      const k = `${a.sectionid}→${t}`;
      navBySectionTarget.set(k, [...(navBySectionTarget.get(k) ?? []), a.idnumber]);
    }
    const want = ctaTarget(a.idnumber);
    if (want === undefined) {
      if (secLinks.length) add('NAVIGATION', a.idnumber, `enlace a sección fuera de un label de navegación (${secLinks.join(',')})`);
      continue;
    }
    navIds.add(a.idnumber);
    if (JSON.stringify(secLinks) !== JSON.stringify([want])) add('NAVIGATION', a.idnumber, `botón de sección ${secLinks.join(',') || '(ninguno)'} ≠ sección ${want}`);
  }
  for (const [k, ids] of navBySectionTarget) {
    if (ids.length > 1) add('NAVIGATION', ids.join(', '), `${ids.length} botones en la sección ${k.split('→')[0]} llevan a la misma sección ${k.split('→')[1]}`);
  }
  const wantNav = ['cv3:shell:start', 'cv3:shell:route_start', ...facts.chapters.map((c) => `cv3:ch:${c.id}:closing`), ...facts.modules.filter((m) => m.examEnabled).map((m) => `cv3:module_next:${m.id}`)];
  if (facts.finalExam.enabled) wantNav.push('cv3:final_exam_next');
  for (const idn of wantNav) if (!navIds.has(idn)) add('NAVIGATION', idn, 'falta el label de navegación');

  // ── gradebook ──
  const gb = (await text('gradebook.xml')) ?? '';
  const cats = blocks(gb, 'grade_category').map((b) => ({
    id: num(/<grade_category id="(\d+)"/.exec(b)?.[1]),
    fullname: unxml(tag(b, 'fullname') ?? ''),
    aggregation: num(tag(b, 'aggregation')),
    parent: tag(b, 'parent'),
  }));
  const gbItems = blocks(gb, 'grade_item').map((b) => ({
    itemtype: tag(b, 'itemtype'),
    iteminstance: num(tag(b, 'iteminstance')),
    gradepass: num(tag(b, 'gradepass')),
    coef: num(tag(b, 'aggregationcoef')),
  }));
  const courseItem = gbItems.find((i) => i.itemtype === 'course');
  if (!courseItem || courseItem.gradepass !== resolved.courseGradepass) {
    add('COURSE_GRADEPASS', 'gradebook.xml', `gradepass del curso ${courseItem?.gradepass} ≠ ${resolved.courseGradepass}`);
  }
  const top = cats.find((c) => c.parent === '$@NULL@$');
  if (!top || top.aggregation !== 10) add('CATEGORIES', 'gradebook.xml', 'la categoría del curso no es media ponderada (10)');
  const childCats = cats.filter((c) => c.parent !== '$@NULL@$');
  const gotCats = childCats.map((c) => [c.fullname, gbItems.find((i) => i.itemtype === 'category' && i.iteminstance === c.id)?.coef]);
  const wantCats = resolved.categories.map((c) => [c.fullname, c.weight]);
  if (JSON.stringify(gotCats) !== JSON.stringify(wantCats)) add('CATEGORIES', 'gradebook.xml', `categorías/pesos ${JSON.stringify(gotCats)} ≠ ${JSON.stringify(wantCats)}`);
  const catIdByKey = new Map<AssessmentCategoryKey, number>();
  for (const c of childCats) {
    const key = (Object.keys(ASSESSMENT_CATEGORY_NAMES) as AssessmentCategoryKey[]).find((k) => ASSESSMENT_CATEGORY_NAMES[k] === c.fullname);
    if (key) catIdByKey.set(key, c.id);
  }

  // ── ítems calificables ──
  const gradedActs: Array<{ a: ParsedActivity; kind: AssessableType }> = [];
  const reviewActs: ParsedActivity[] = [];
  for (const a of acts) {
    if (REVIEW_CARDS_RE.test(a.idnumber)) {
      reviewActs.push(a);
      continue;
    }
    const kind = kindOfGraded(a.idnumber);
    if (GRADED.has(a.modname) !== (kind !== null)) {
      add('STRUCTURE', a.dir, `modname ${a.modname} incoherente con idnumber ${a.idnumber}`);
      continue;
    }
    if (!kind) continue;
    gradedActs.push({ a, kind });
    const k = resolved.kinds[kind];
    const g = a.grade;
    if (!g) {
      add('GRADEPASS', a.dir, 'sin grade_item');
      continue;
    }
    if (num(g.gradepass) !== k.passingGrade) add('GRADEPASS', a.dir, `gradepass ${g.gradepass} ≠ perfil ${k.passingGrade} (${kind})`);
    if (num(g.grademax) !== 100 || num(g.grademin) !== 0) add('GRADEMAX', a.dir, `grademax/min ${g.grademax}/${g.grademin} ≠ 100/0`);
    if (g.itemmodule !== a.modname) add('GRADEPASS', a.dir, `itemmodule ${g.itemmodule} ≠ ${a.modname}`);
    if (num(g.categoryid) !== catIdByKey.get(k.category)) add('CATEGORIES', a.dir, `categoryid ${g.categoryid} ≠ categoría ${k.category}`);
    const md = a.module;
    // r55 (R5/R6): todo ítem evaluativo se completa al RECIBIR nota (completionusegrade = completiongradeitemnumber 0),
    // sin nota aprobatoria (su gradepass es informativo: la aprobación del curso es la nota final).
    if (md.completion !== '2' || md.completiongradeitemnumber !== '0' || md.completionpassgrade !== '0' || md.completionview !== '0') {
      add('COMPLETION', a.dir, `completion ${md.completion}/${md.completiongradeitemnumber}/${md.completionpassgrade}/${md.completionview} ≠ 2/0/0/0 (recibir nota)`);
    }
    // r55 (R2): H5P evaluativo con seguimiento (xAPI → intento → nota) y escala 0–100.
    if (a.modname === 'h5pactivity' && (a.h5p?.enabletracking !== '1' || a.h5p?.grade !== '100')) {
      add('COMPLETION', a.dir, `H5P evaluativo con enabletracking ${a.h5p?.enabletracking} / grade ${a.h5p?.grade} ≠ 1/100`);
    }
    // P2-B1: el quiz nunca revela corrección/retroalimentación/respuesta tras un intento, y
    // `completionattemptsexhausted` debe seguir a `attempts_number` (si no, un intento fallido con
    // intentos restantes ya marcaría el quiz como completado-sin-aprobar). Ver P2-design.md §1.
    if (a.modname === 'quiz' && a.quiz) {
      const q = a.quiz;
      for (const key of Object.keys(QUIZ_REVIEW_V3) as (keyof typeof QUIZ_REVIEW_V3)[]) {
        if (q[key] !== String(QUIZ_REVIEW_V3[key])) {
          add('QUIZ_REVIEW', a.dir, `${key} ${q[key]} ≠ ${QUIZ_REVIEW_V3[key]}`);
        }
      }
      // QUIZFB: retroalimentación global = exactamente las bandas «aprobaste / todavía no» de la nota mínima del perfil.
      if (kind) {
        const want = examOverallFeedbackBands(resolved.kinds[kind].passingGrade, Number(q.attempts_number));
        const got = q.feedbacks.map((f) => [f.min, f.max, f.text]);
        if (JSON.stringify(got) !== JSON.stringify(want.map((b) => [b.mingrade, b.maxgrade, b.html]))) {
          add('QUIZ_FEEDBACK', a.dir, `retroalimentación global ${JSON.stringify(q.feedbacks.map((f) => [f.min, f.max]))} ≠ bandas de la nota mínima ${resolved.kinds[kind].passingGrade}`);
        }
      }
      // r55 (R6): completo SOLO tras usar todos los intentos (completionminattempts = intentos; 0 si ilimitados), sin la
      // regla «aprobar o agotar» (completionattemptsexhausted 0) ni nota aprobatoria; los intentos y el método salen del perfil.
      const att = Number(q.attempts_number);
      if (!Number.isInteger(att) || att < 0 || att !== resolved.kinds[kind].attempts) add('QUIZ_COMPLETION', a.dir, `attempts_number ${q.attempts_number} ≠ perfil ${resolved.kinds[kind].attempts}`);
      if (q.completionattemptsexhausted !== '0') add('QUIZ_COMPLETION', a.dir, `completionattemptsexhausted ${q.completionattemptsexhausted} ≠ 0`);
      if (q.completionminattempts !== String(Number.isInteger(att) && att > 0 ? att : 0)) {
        add('QUIZ_COMPLETION', a.dir, `completionminattempts ${q.completionminattempts} ≠ ${Number.isInteger(att) && att > 0 ? att : 0} (attempts_number ${q.attempts_number})`);
      }
    }
  }
  // F1 (I3): en un curso sin nota el Libro Guía se completa por vista (criterio del curso); el resto, 0.
  const viewCompletion = (a: ParsedActivity) => resolved.withoutGrades === true && a.modname === 'resource' && a.idnumber === 'cv3:shell:libro';
  // Fase 2: la página de la Actividad de Aplicación se completa por vista (seguimiento; nunca criterio del curso).
  const applicationView = (a: ParsedActivity) => a.modname === 'page' && (APPLICATION_RE.test(a.idnumber) || GUIDED_PRACTICE_RE.test(a.idnumber));
  // T4 (r57): la Tarea de la Actividad de Aplicación la juzga APPLICATION (calificada ⇔ ítem de nota; formativa ⇔ ninguno).
  const isAppAssign = (a: ParsedActivity) => a.modname === 'assign' && APPLICATION_RE.test(a.idnumber);
  for (const a of acts.filter((x) => (!GRADED.has(x.modname) || REVIEW_CARDS_RE.test(x.idnumber)) && !isAppAssign(x))) {
    // r55 (R1): lo pedagógico (labels, páginas, foro, Libro, «Repaso») nunca es ítem de calificación.
    if (a.grade || a.inforefGradeItems.length) add('PEDAGOGICAL', a.dir, `${a.idnumber} (pedagógico) con ítem de calificación`);
  }
  for (const a of acts.filter((x) => !GRADED.has(x.modname))) {
    if (a.modname === 'assign') {
      if (!isAppAssign(a)) add('APPLICATION', a.idnumber, 'Tarea (assign) que no es una Actividad de Aplicación');
      // Completion al ENVIAR: completion 2 automática, sin vista ni nota como condición; completionsubmit 1.
      else if (a.module.completion !== '2' || a.module.completionview !== '0' || a.module.completiongradeitemnumber !== '$@NULL@$' || a.assign?.completionsubmit !== '1') {
        add('APPLICATION', a.dir, `Tarea con completion ${a.module.completion}/${a.module.completionview}/${a.module.completiongradeitemnumber}/submit ${a.assign?.completionsubmit} ≠ 2/0/NULL/1 (al enviar)`);
      }
    } else if (applicationView(a)) {
      if (a.module.completion !== '2' || a.module.completionview !== '1') add('APPLICATION', a.dir, `Actividad de Aplicación con completion ${a.module.completion}/${a.module.completionview} ≠ 2/1`);
    } else if (viewCompletion(a)) {
      if (a.module.completion !== '2' || a.module.completionview !== '1') {
        add('COMPLETION', a.dir, `Libro Guía de un curso sin nota con completion ${a.module.completion}/${a.module.completionview} ≠ 2/1`);
      }
    } else if (a.module.completion !== '0') add('COMPLETION', a.dir, `módulo no calificable con completion ${a.module.completion}`);
  }
  // EV6 H5P v2: «Repaso» = h5pactivity sin nota (sin grade item, grade 0, sin tracking), completion
  // por vista, solo en capítulos que facts declara con reviewCards (nunca criterio del curso: ver abajo).
  for (const a of reviewActs) {
    const chId = (REVIEW_CARDS_RE.exec(a.idnumber) as RegExpExecArray)[1];
    if (a.modname !== 'h5pactivity') add('ADDON', a.dir, `«Repaso» debe ser h5pactivity (vino ${a.modname})`);
    if (a.grade || a.inforefGradeItems.length) add('ADDON', a.dir, '«Repaso» con ítem de calificación');
    const md = a.module;
    if (md.completion !== '2' || md.completionview !== '1' || md.completionpassgrade !== '0' || md.completiongradeitemnumber !== '$@NULL@$') {
      add('ADDON', a.dir, `«Repaso» con completion ${md.completion}/${md.completionview}/${md.completionpassgrade}/${md.completiongradeitemnumber} ≠ 2/1/0/NULL`);
    }
    const hx = (await text(`${a.dir}/h5pactivity.xml`)) ?? '';
    if (tag(hx, 'grade') !== '0' || tag(hx, 'enabletracking') !== '0') add('ADDON', a.dir, `«Repaso» con grade ${tag(hx, 'grade')} / enabletracking ${tag(hx, 'enabletracking')} ≠ 0/0`);
    if (facts.chapters.find((c) => c.id === chId)?.reviewCards !== true) add('ADDON', a.dir, `facts no declara «Repaso» en el capítulo ${chId}`);
    if (/calificab|nota de esta actividad/i.test(a.intro) || /calificab/i.test(a.name)) add('ADDON', a.dir, '«Repaso» presentado como calificable');
  }
  if (reviewActs.length !== (facts.counts.reviewCards ?? 0)) add('ADDON', 'review_cards', `${reviewActs.length} «Repaso» en el paquete ≠ facts ${facts.counts.reviewCards ?? 0}`);
  // ── T4 (r57): Tarea de la Actividad de Aplicación (mod_assign) ──
  // calificada ⇔ ítem de nota en la categoría de la entrega (grademax = nota máxima, gradepass = la de referencia), grade de
  // la tarea = nota máxima y, con rúbrica, grading.xml con la rúbrica LISTA; formativa ⇔ sin ítem de nota, grade 0 y sin
  // grading.xml. Entrega = la configuración resuelta del perfil (tipos, archivos, tamaño, formatos, fecha límite) con
  // comentarios de retroalimentación; envío = completion. El solucionario sigue oculto (regla de abajo).
  const courseStart = num(tag(courseXml, 'startdate'));
  const checkAssign = async (a: ParsedActivity, ch: CourseFacts['chapters'][number], intro: string): Promise<void> => {
    const d = resolved.application;
    const fd = facts.assessment.application;
    if (!d || !fd) {
      add('APPLICATION', a.idnumber, 'Tarea de entrega sin entrega resuelta en el perfil / facts');
      return;
    }
    const graded = ch.applicationDelivery?.graded === true;
    if (graded !== d.graded || graded !== fd.graded) add('APPLICATION', a.idnumber, `calificación de la Tarea incoherente (facts ${graded}, perfil ${d.graded})`);
    const x = a.assign;
    if (!x) return;
    const gx = (await text(`${a.dir}/grading.xml`)) ?? '';
    if (d.graded) {
      if (!a.grade) add('APPLICATION', a.idnumber, 'Tarea calificada sin ítem de nota (grades.xml)');
      else {
        if (num(a.grade.grademax) !== d.maxGrade || num(a.grade.grademin) !== 0) add('APPLICATION', a.dir, `grademax/min ${a.grade.grademax}/${a.grade.grademin} ≠ ${d.maxGrade}/0`);
        if (num(a.grade.gradepass) !== d.gradepass) add('APPLICATION', a.dir, `gradepass ${a.grade.gradepass} ≠ ${d.gradepass}`);
        if (a.grade.itemmodule !== 'assign') add('APPLICATION', a.dir, `itemmodule ${a.grade.itemmodule} ≠ assign`);
        const catId = catIdByKey.get(d.category as AssessmentCategoryKey);
        if (catId === undefined) add('CATEGORIES', a.dir, `la categoría ${d.category} de la Tarea calificada no está en el libro de calificaciones`);
        else if (num(a.grade.categoryid) !== catId) add('CATEGORIES', a.dir, `categoryid ${a.grade.categoryid} ≠ categoría ${d.category}`);
      }
      if (num(x.grade) !== d.maxGrade) add('APPLICATION', a.dir, `grade de la Tarea ${x.grade} ≠ nota máxima ${d.maxGrade}`);
      if (d.rubric) {
        // (los <level> traen su propio <definition>: la definición se lee sobre el área completa, no con blocks()).
        const area = blocks(gx, 'area')[0] ?? '';
        const def = area;
        const crit = blocks(area, 'criterion');
        const okArea = tag(area, 'areaname') === 'submissions' && tag(area, 'activemethod') === 'rubric' && tag(def, 'method') === 'rubric' && tag(def, 'status') === '20';
        if (!okArea) add('RUBRIC', a.idnumber, 'falta la rúbrica LISTA (grading.xml: área submissions, método rubric, status 20)');
        else if (!crit.length) add('RUBRIC', a.idnumber, 'la rúbrica no tiene criterios');
        else {
          let maxSum = 0;
          for (const c of crit) {
            const scores = blocks(c, 'level').map((l) => num(tag(l, 'score')));
            if (scores.length < 2 || new Set(scores).size !== scores.length || scores.some((v) => !(v >= 0))) add('RUBRIC', a.idnumber, `criterio «${unxml(tag(c, 'description') ?? '').slice(0, 40)}» con niveles inválidos`);
            maxSum += Math.max(...scores, 0);
          }
          if (!(maxSum > 0)) add('RUBRIC', a.idnumber, 'la rúbrica no suma puntos');
          if (/alwaysshowdefinition"\s*:\s*1/.test(unxml(tag(def, 'options') ?? ''))) add('RUBRIC', a.idnumber, 'la rúbrica (con la guía del solucionario) se muestra antes de calificar');
        }
      } else if (gx) add('RUBRIC', a.idnumber, 'grading.xml sin rúbrica pedida');
    } else {
      if (a.grade || a.inforefGradeItems.length) add('APPLICATION', a.idnumber, 'Tarea formativa con ítem de nota');
      if (num(x.grade) !== 0) add('APPLICATION', a.dir, `Tarea formativa con grade ${x.grade} (se espera 0)`);
      if (gx) add('RUBRIC', a.idnumber, 'Tarea formativa con calificación avanzada (grading.xml)');
    }
    const cfg = x.configs;
    const want: Record<string, string> = {
      'assignsubmission/onlinetext/enabled': d.submission.onlineText ? '1' : '0',
      'assignsubmission/file/enabled': d.submission.file ? '1' : '0',
      'assignsubmission/file/maxfilesubmissions': String(d.submission.maxFiles),
      'assignsubmission/file/maxsubmissionsizebytes': String(d.submission.maxBytes),
      'assignsubmission/file/filetypeslist': d.submission.fileTypes.join(','),
      'assignfeedback/comments/enabled': '1',
    };
    for (const [k, v] of Object.entries(want)) if (cfg[k] !== v) add('SUBMISSION', a.idnumber, `${k} = ${JSON.stringify(cfg[k])} ≠ ${JSON.stringify(v)}`);
    if (cfg['assignsubmission/onlinetext/enabled'] !== '1' && cfg['assignsubmission/file/enabled'] !== '1') add('SUBMISSION', a.idnumber, 'la Tarea no admite ningún tipo de entrega');
    const due = d.dueOffsetDays === null ? 0 : courseStart + d.dueOffsetDays * 86400;
    if (num(x.duedate) !== due) add('SUBMISSION', a.idnumber, `duedate ${x.duedate} ≠ ${due} (${d.dueOffsetDays === null ? 'sin fecha' : `inicio + ${d.dueOffsetDays} días`})`);
    if (x.alwaysshowdescription !== '1') add('SUBMISSION', a.idnumber, 'la descripción (la actividad) debe verse siempre');
    if (x.teamsubmission !== '0') add('SUBMISSION', a.idnumber, 'entrega en grupo no configurada por el perfil');
    if (!/Cómo entregar/.test(extractText(intro))) add('SUBMISSION', a.idnumber, 'la Tarea no explica cómo entregar');
  };

  // Fase 2: Actividades de Aplicación — por capítulo con applicationMinutes, EXACTAMENTE una página visible del
  // estudiante (sin respuestas, con su PDF) y un solucionario oculto (visible=0, con su PDF); en ningún otro capítulo.
  for (const ch of facts.chapters) {
    const want = ch.applicationMinutes !== undefined;
    const st = acts.filter((a) => a.idnumber === `cv3:ch:${ch.id}:application`);
    const so = acts.filter((a) => a.idnumber === `cv3:ch:${ch.id}:application_solution`);
    if (st.length !== (want ? 1 : 0) || so.length !== (want ? 1 : 0)) {
      add('APPLICATION', `cv3:ch:${ch.id}:application`, `capítulo ${ch.number}: ${st.length} página(s) del estudiante y ${so.length} solucionario(s) (facts ${want ? 'con' : 'sin'} actividad)`);
      continue;
    }
    if (!want) continue;
    // T4 (r57): con entrega como Tarea, la actividad del estudiante es un mod_assign (su descripción = la página).
    const asAssign = ch.applicationDelivery?.mode === 'assign';
    for (const [a, hidden] of [[st[0], false], [so[0], true]] as const) {
      const wantMod = !hidden && asAssign ? 'assign' : 'page';
      if (a.modname !== wantMod) add('APPLICATION', a.idnumber, wantMod === 'assign' ? `facts declara entrega como Tarea (mod_assign), es ${a.modname}` : `debe ser una página (mod_page), es ${a.modname}`);
      if (wantMod === 'page' && (a.grade || a.inforefGradeItems.length)) add('APPLICATION', a.idnumber, 'con ítem de calificación');
      if ((a.module.visible === '0') !== hidden) add('APPLICATION', a.idnumber, hidden ? 'el solucionario docente debe estar oculto (visible=0)' : 'la página del estudiante debe estar visible');
      const isAssign = a.modname === 'assign';
      const pdfs = files.filter((f) => f.ctx === a.ctx && f.component === (isAssign ? 'mod_assign' : 'mod_page') && f.filearea === (isAssign ? 'intro' : 'content') && /\.pdf$/i.test(f.filename));
      if (pdfs.length !== 1) add('APPLICATION', a.idnumber, `${pdfs.length} PDF adjunto(s) (se espera 1)`);
      const content = isAssign ? a.intro : unxml(tag((await text(`${a.dir}/page.xml`)) ?? '', 'content') ?? '');
      if (isAssign && !hidden) await checkAssign(a, ch, content);
      // T5 (r57): la actividad enlaza cada archivo de trabajo «de la Actividad de Aplicación» (a su recurso del capítulo).
      if (!hidden) {
        for (const r of (ch.resources ?? []).filter((x) => x.relation === 'application')) {
          const res = acts.find((x) => x.idnumber === `cv3:ch:${ch.id}:resource:${r.id}`);
          if (res && !content.includes(`$@RESOURCEVIEWBYID*${res.mid}@$`)) add('PRACTICE_RESOURCE', a.idnumber, `la Actividad de Aplicación no enlaza su archivo de trabajo ${r.id}`);
        }
      }
      if (pdfs.length === 1 && !content.includes(`@@PLUGINFILE@@/${pdfs[0].filename}`)) add('APPLICATION', a.idnumber, 'la página no enlaza su PDF');
      const lint = lintCleanSafe(content);
      if (!lint.ok) add('CLEAN_SAFE', a.idnumber, lint.errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join('; '));
      if (!hidden && SOLUTION_MARKERS_RE.test(extractText(content))) add('APPLICATION', a.idnumber, 'la página del estudiante muestra contenido del solucionario');
      if (hidden && !/Solucionario/.test(a.name)) add('APPLICATION', a.idnumber, 'el solucionario no se nombra como tal');
      if (hidden) {
        // LOOP 7 (A4 I1/I3): barreras del solucionario — oculto también tras restaurar (visibleold=0), estudiante con
        // mod/page:view PROHIBIDO (override en la actividad + el rol referenciado y definido) y ningún enlace a él
        // desde otro contenido del curso.
        if (a.module.visibleold !== '0') add('APPLICATION', a.idnumber, 'el solucionario debe quedar oculto tras restaurar (visibleold=0)');
        const rx = (await text(`${a.dir}/roles.xml`)) ?? '';
        const ov = /<override\b[\s\S]*?<\/override>/g;
        const prohibits = (rx.match(ov) ?? []).some((o) => tag(o, 'roleid') === '5' && tag(o, 'capability') === 'mod/page:view' && tag(o, 'permission') === '-1000');
        if (!prohibits) add('APPLICATION', a.idnumber, 'el solucionario no prohíbe mod/page:view al rol estudiante');
        const inf = (await text(`${a.dir}/inforef.xml`)) ?? '';
        if (!/<roleref>[\s\S]*<role><id>5<\/id><\/role>[\s\S]*<\/roleref>/.test(inf)) add('APPLICATION', a.idnumber, 'inforef sin el rol estudiante (el override no se restauraría)');
        if (!/<role id="5">[\s\S]*<archetype>student<\/archetype>/.test(rootRoles)) add('APPLICATION', 'roles.xml', 'roles.xml raíz no define el rol estudiante del override');
        const solPdf = files.find((f) => f.ctx === a.ctx && /\.pdf$/i.test(f.filename));
        for (const other of acts) {
          if (other === a) continue;
          const body = `${other.intro}\n${unxml(tag((await text(`${other.dir}/${other.modname}.xml`)) ?? '', 'content') ?? '')}`;
          if (body.includes(`VIEWBYID*${a.mid}@$`) || (solPdf && body.includes(solPdf.filename))) add('APPLICATION', other.idnumber, `enlaza al solucionario docente ${a.idnumber}`);
        }
      }
    }
  }
  // ── T6 (r57): «Guía del docente» — existe ⇔ facts.teacherGuide; página OCULTA (visible=0 y visibleold=0) con el
  // estudiante PROHIBIDO (mod/page:view −1000 en la actividad, rol en inforef y roles.xml), sin nota ni completion,
  // con el aviso fijo, cada módulo y capítulo de facts nombrado, y nadie la enlaza.
  {
    const guides = acts.filter((a) => a.idnumber === TEACHER_GUIDE_IDNUMBER);
    if (guides.length !== (facts.teacherGuide === true ? 1 : 0)) add('TEACHER_GUIDE', TEACHER_GUIDE_IDNUMBER, `${guides.length} Guía(s) del docente (facts ${facts.teacherGuide === true ? 'la pide' : 'no la pide'})`);
    const g = guides[0];
    if (g) {
      if (g.modname !== 'page') add('TEACHER_GUIDE', g.idnumber, `debe ser una página (mod_page), es ${g.modname}`);
      if (g.module.visible !== '0' || g.module.visibleold !== '0') add('TEACHER_GUIDE', g.idnumber, 'la Guía del docente debe estar oculta (visible=0, visibleold=0)');
      if (g.grade || g.inforefGradeItems.length || g.module.completion !== '0') add('TEACHER_GUIDE', g.idnumber, 'la Guía del docente no lleva nota ni completion');
      const rx = (await text(`${g.dir}/roles.xml`)) ?? '';
      const prohibits = (rx.match(/<override\b[\s\S]*?<\/override>/g) ?? []).some((o) => tag(o, 'roleid') === '5' && tag(o, 'capability') === 'mod/page:view' && tag(o, 'permission') === '-1000');
      if (!prohibits) add('TEACHER_GUIDE', g.idnumber, 'la Guía del docente no prohíbe mod/page:view al rol estudiante');
      const inf = (await text(`${g.dir}/inforef.xml`)) ?? '';
      if (!/<roleref>[\s\S]*<role><id>5<\/id><\/role>[\s\S]*<\/roleref>/.test(inf)) add('TEACHER_GUIDE', g.idnumber, 'inforef sin el rol estudiante (el override no se restauraría)');
      if (!/<role id="5">[\s\S]*<archetype>student<\/archetype>/.test(rootRoles)) add('TEACHER_GUIDE', 'roles.xml', 'roles.xml raíz no define el rol estudiante del override');
      const content = unxml(tag((await text(`${g.dir}/page.xml`)) ?? '', 'content') ?? '');
      const txt = extractText(content);
      if (!txt.includes(TEACHER_GUIDE_HIDDEN_NOTICE)) add('TEACHER_GUIDE', g.idnumber, 'sin el aviso de página oculta para docentes');
      for (const m of facts.modules) if (!txt.includes(`Módulo ${m.number}: ${m.title}`)) add('TEACHER_GUIDE', g.idnumber, `no nombra el módulo ${m.number}`);
      for (const ch of facts.chapters) if (!txt.includes(`Capítulo ${ch.number}: ${ch.title}`)) add('TEACHER_GUIDE', g.idnumber, `no nombra el capítulo ${ch.number}`);
      const lint = lintCleanSafe(content);
      if (!lint.ok) add('CLEAN_SAFE', g.idnumber, lint.errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join('; '));
      if (/<(style|script)\b/i.test(content)) add('TEACHER_GUIDE', g.idnumber, 'la página lleva <style>/<script>');
      for (const other of acts) {
        if (other === g) continue;
        const body = `${other.intro}\n${other.modname === 'page' ? unxml(tag((await text(`${other.dir}/page.xml`)) ?? '', 'content') ?? '') : ''}`;
        if (body.includes(`VIEWBYID*${g.mid}@$`)) add('TEACHER_GUIDE', other.idnumber, 'enlaza a la Guía del docente (es solo para docentes)');
      }
    }
  }
  // ── T5 (r57): archivos de trabajo — por recurso de facts, EXACTAMENTE un mod_resource visible del capítulo, sin nota, con
  // UN archivo (nombre, tipo permitido, tamaño y sha256 = facts) y ninguno fuera de facts. El enlace desde la AA lo verifica
  // APPLICATION (arriba).
  const RESOURCE_RE = /^cv3:ch:([^:]+):resource:([a-z0-9-]+)$/;
  const factsResources = new Map<string, NonNullable<CourseFacts["chapters"][number]["resources"]>[number]>(facts.chapters.flatMap((ch) => (ch.resources ?? []).map((r) => [`cv3:ch:${ch.id}:resource:${r.id}`, r] as [string, typeof r])));
  for (const a of acts.filter((x) => RESOURCE_RE.test(x.idnumber))) {
    const r = factsResources.get(a.idnumber);
    if (!r) {
      add('PRACTICE_RESOURCE', a.idnumber, 'archivo de trabajo que facts no declara');
      continue;
    }
    if (a.modname !== 'resource') add('PRACTICE_RESOURCE', a.idnumber, `debe ser un recurso (mod_resource), es ${a.modname}`);
    if (a.module.visible !== '1') add('PRACTICE_RESOURCE', a.idnumber, 'el archivo de trabajo debe estar visible');
    if (a.grade || a.inforefGradeItems.length) add('PRACTICE_RESOURCE', a.idnumber, 'con ítem de calificación');
    const fs2 = files.filter((f) => f.ctx === a.ctx && f.component === 'mod_resource' && f.filearea === 'content' && f.filename !== '.');
    if (fs2.length !== 1) {
      add('PRACTICE_RESOURCE', a.idnumber, `${fs2.length} archivo(s) en el recurso (se espera 1)`);
      continue;
    }
    const f = fs2[0];
    if (f.filename !== r.filename) add('PRACTICE_RESOURCE', a.idnumber, `archivo ${f.filename} ≠ facts ${r.filename}`);
    const ext = extensionOf(f.filename);
    if (!(ext in PRACTICE_FILE_MIMETYPES) || f.mimetype !== PRACTICE_FILE_MIMETYPES[ext] || f.mimetype !== r.mimetype) add('PRACTICE_RESOURCE', a.idnumber, `tipo ${f.mimetype} (${ext}) fuera de la lista permitida o ≠ facts ${r.mimetype}`);
    if (f.size !== r.bytes || f.size > PRACTICE_RESOURCE_LIMITS.fileBytesMax) add('PRACTICE_RESOURCE', a.idnumber, `tamaño ${f.size} ≠ facts ${r.bytes} o mayor que ${PRACTICE_RESOURCE_LIMITS.fileBytesMax}`);
    const blob = await bin(`files/${f.hash.slice(0, 2)}/${f.hash}`);
    if (!blob || createHash('sha256').update(blob).digest('hex') !== r.sha256) add('PRACTICE_RESOURCE', a.idnumber, 'el archivo del paquete no es el registrado (sha256)');
    if (!a.inforefFiles.includes(f.id)) add('PRACTICE_RESOURCE', a.idnumber, 'inforef del recurso no referencia su archivo');
  }
  for (const idn of factsResources.keys()) if (!acts.some((a) => a.idnumber === idn)) add('PRACTICE_RESOURCE', idn, 'archivo de trabajo de facts ausente en el paquete');

  // Loop 9 B: práctica guiada — por capítulo con guidedPracticeMinutes (facts), EXACTAMENTE una página visible, sin nota ni
  // archivos, con cada ejercicio y su respuesta modelo; en ningún otro capítulo (ni en los de práctica).
  for (const ch of facts.chapters) {
    const want = ch.guidedPracticeMinutes !== undefined;
    const gp = acts.filter((a) => a.idnumber === `cv3:ch:${ch.id}:guided_practice`);
    if (gp.length !== (want ? 1 : 0)) {
      add('GUIDED_PRACTICE', `cv3:ch:${ch.id}:guided_practice`, `capítulo ${ch.number}: ${gp.length} página(s) de práctica guiada (facts ${want ? 'con' : 'sin'} práctica guiada)`);
      continue;
    }
    if (!want) continue;
    const a = gp[0];
    if (ch.kind === 'practice') add('GUIDED_PRACTICE', a.idnumber, 'práctica guiada en un capítulo de práctica');
    if (a.modname !== 'page') add('GUIDED_PRACTICE', a.idnumber, `debe ser una página (mod_page), es ${a.modname}`);
    if (a.grade || a.inforefGradeItems.length) add('GUIDED_PRACTICE', a.idnumber, 'con ítem de calificación (es formativa)');
    if (a.module.visible === '0') add('GUIDED_PRACTICE', a.idnumber, 'la práctica guiada debe estar visible');
    if (!/^Ejercicios guiados — /.test(a.name)) add('GUIDED_PRACTICE', a.idnumber, `nombre «${a.name}» (se espera «Ejercicios guiados — <capítulo>»)`);
    const content = unxml(tag((await text(`${a.dir}/page.xml`)) ?? '', 'content') ?? '');
    const lint = lintCleanSafe(content);
    if (!lint.ok) add('CLEAN_SAFE', a.idnumber, lint.errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join('; '));
    if (/<(style|script)\b/i.test(content)) add('GUIDED_PRACTICE', a.idnumber, 'la página lleva <style>/<script>');
    if (!/Respuesta modelo \(revísala después de intentarlo\)/.test(extractText(content))) add('GUIDED_PRACTICE', a.idnumber, 'sin «Respuesta modelo (revísala después de intentarlo)»');
  }
  for (const a of acts.filter((x) => GUIDED_PRACTICE_RE.test(x.idnumber))) {
    const id = GUIDED_PRACTICE_RE.exec(a.idnumber) as RegExpExecArray;
    if (!facts.chapters.some((c) => c.id === id[1])) add('GUIDED_PRACTICE', a.idnumber, 'práctica guiada de un capítulo que no está en facts');
  }
  for (const a of acts.filter((x) => (APPLICATION_RE.test(x.idnumber) || APPLICATION_SOLUTION_RE.test(x.idnumber)))) {
    const id = (APPLICATION_RE.exec(a.idnumber) ?? APPLICATION_SOLUTION_RE.exec(a.idnumber)) as RegExpExecArray;
    if (!facts.chapters.some((c) => c.id === id[1])) add('APPLICATION', a.idnumber, 'Actividad de Aplicación de un capítulo que no está en facts');
  }
  if (resolved.withoutGrades === true && gradedActs.length > 0) add('STRUCTURE', 'graded', `curso sin nota con ${gradedActs.length} ítem(s) calificable(s)`);
  const practice = gradedActs.filter((g) => g.kind === 'activity' || g.kind === 'video').length;
  const expectedPractice = facts.counts.activities + facts.counts.videos;
  if (practice !== expectedPractice) add('STRUCTURE', 'graded', `ítems de práctica ${practice} ≠ facts ${expectedPractice}`);
  if (gradedActs.filter((g) => g.kind === 'exam').length !== facts.counts.exams) add('STRUCTURE', 'graded', 'cantidad de exámenes de módulo ≠ facts');
  if (gradedActs.filter((g) => g.kind === 'finalExam').length !== (facts.finalExam.enabled ? 1 : 0)) add('STRUCTURE', 'graded', 'examen final ≠ facts');

  // ── completion del curso ── r55 (R3/R8): invariantes que NO dependen de las banderas del perfil.
  const comp = (await text('completion.xml')) ?? '';
  const crit = blocks(comp, 'course_completion_criteria').map((b) => ({ type: num(tag(b, 'criteriatype')), mi: num(tag(b, 'moduleinstance')), mod: tag(b, 'module'), gp: tag(b, 'gradepass') }));
  const gotCrit = crit.filter((c) => c.type === 4).map((c) => c.mi);
  const gradeCrit = crit.filter((c) => c.type === 6);
  for (const c of crit.filter((x) => x.type !== 4 && x.type !== 6)) add('COURSE_COMPLETION', 'completion.xml', `criterio de tipo ${c.type} no permitido`);
  const aggr = blocks(comp, 'course_completion_aggr_methd').map((b) => ({ ct: tag(b, 'criteriatype'), method: tag(b, 'method') }));
  if (crit.length && (aggr.length !== 1 || aggr[0].ct !== '$@NULL@$' || aggr[0].method !== '1')) add('COURSE_COMPLETION', 'completion.xml', `agregación ${JSON.stringify(aggr)} ≠ una global ALL (1)`);
  // T4 (r57): una Tarea calificada también hace que el curso tenga nota.
  const gradedAssigns = acts.filter((a) => a.modname === 'assign' && !!a.grade);
  if (resolved.withoutGrades === true && gradedAssigns.length > 0) add('STRUCTURE', 'graded', `curso sin nota con ${gradedAssigns.length} Tarea(s) calificada(s)`);
  if (gradedAssigns.length !== (facts.counts.applicationAssignsGraded ?? 0)) add('STRUCTURE', 'graded', `Tareas calificadas ${gradedAssigns.length} ≠ facts ${facts.counts.applicationAssignsGraded ?? 0}`);
  if (acts.filter((a) => a.modname === 'assign').length !== (facts.counts.applicationAssigns ?? 0)) add('STRUCTURE', 'assign', `Tareas ${acts.filter((a) => a.modname === 'assign').length} ≠ facts ${facts.counts.applicationAssigns ?? 0}`);
  const graded = gradedActs.length + gradedAssigns.length > 0;
  if (graded) {
    if (resolved.withoutGrades === true) add('COURSE_COMPLETION', 'completion.xml', 'curso con ítems calificables resuelto como sin nota');
    // CRITERIA_ACTIVITY: aprobar/completar actividades nunca aprueba el curso, y una actividad bajo su mínimo no lo bloquea.
    if (gotCrit.length) add('CRITERIA_ACTIVITY', 'completion.xml', `curso con nota con ${gotCrit.length} criterio(s) de actividad (${gotCrit.join(',')}): solo la nota final aprueba el curso`);
    if (gradeCrit.length !== 1) add('GRADE_CRITERION', 'completion.xml', `curso con nota con ${gradeCrit.length} criterio(s) de nota del curso (se exige exactamente 1)`);
    else {
      const gp = num(gradeCrit[0].gp);
      if (!(gp > 0 && gp <= 100)) add('GRADE_CRITERION', 'completion.xml', `gradepass del criterio de nota ${gradeCrit[0].gp} fuera de (0, 100]`);
      if (gp !== courseItem?.gradepass) add('GRADE_CRITERION', 'completion.xml', `gradepass del criterio de nota ${gp} ≠ gradepass del ítem del curso ${courseItem?.gradepass}`);
      if (gp !== resolved.courseGradepass) add('GRADE_CRITERION', 'completion.xml', `gradepass del criterio de nota ${gp} ≠ nota mínima del perfil ${resolved.courseGradepass}`);
      if (facts.assessment.coursePassingGrade !== undefined && gp !== facts.assessment.coursePassingGrade) add('GRADE_CRITERION', 'completion.xml', `gradepass del criterio de nota ${gp} ≠ facts ${facts.assessment.coursePassingGrade}`);
    }
    if (resolved.courseCompletion.requireCourseGradePass !== true) add('GRADE_CRITERION', 'resolved', 'la evaluación resuelta de un curso con nota no exige la nota del curso');
  } else {
    // Curso sin nota: el Libro Guía por vista es el único criterio; sin criterio de nota.
    const wantCrit = resolved.withoutGrades === true ? acts.filter(viewCompletion).map((a) => a.mid) : [];
    if (resolved.withoutGrades === true && wantCrit.length !== 1) add('COURSE_COMPLETION', 'completion.xml', `curso sin nota: se esperaba el Libro Guía como criterio (hay ${wantCrit.length})`);
    if (JSON.stringify(gotCrit) !== JSON.stringify(wantCrit)) add('COURSE_COMPLETION', 'completion.xml', `criterios ${gotCrit.join(',')} ≠ ${wantCrit.join(',')}`);
    if (gradeCrit.length) add('COURSE_COMPLETION', 'completion.xml', 'curso sin nota con criterio de nota del curso');
  }

  const backupCourseId = num(tag(mb, 'original_course_id'));
  const backupCourseCtx = num(tag(mb, 'original_course_contextid'));
  // Fix 0b: el ÚNICO módulo oculto del paquete es el label para docentes del certificado (si hay insignia).
  // EV6 P2-B4: sin insignia, el único oculto posible es la nota para docentes de las evaluaciones.
  const checkHidden = (allowed: string | null): void => {
    for (const a of acts) {
      if (a.module.visible === '1') continue;
      // Fase 2: el solucionario docente de cada Actividad de Aplicación va oculto (lo verifica la regla APPLICATION).
      if (APPLICATION_SOLUTION_RE.test(a.idnumber)) continue;
      // r55 (R6): «Respuestas explicadas» de un quiz con intentos ilimitados va oculta (lo verifica EXPLANATIONS_GATE).
      if (a.modname === 'page' && /^cv3:(exam_explanations:|final_exam_explanations$)/.test(a.idnumber)) continue;
      // T6 (r57): la Guía del docente va oculta (la verifica TEACHER_GUIDE).
      if (a.modname === 'page' && a.idnumber === TEACHER_GUIDE_IDNUMBER) continue;
      if (a.idnumber !== allowed) add('CERTIFICATE', a.idnumber, `módulo oculto inesperado (visible=${a.module.visible}): solo el label para docentes del certificado (o, sin él, el de las evaluaciones) puede estarlo`);
    }
  };
  // EV6 P2-B4 (rulings 2 + 3): nota para docentes de «Respuestas explicadas» — exactamente una vez, oculta:
  // en el label del certificado si lo hay; si no, `cv3:shell:exams_teacher` primero de su sección.
  const checkExamsTeacher = (withCertificate: boolean): void => {
    const hasExams = gradedActs.some((g) => g.kind === 'exam' || g.kind === 'finalExam');
    const own = acts.find((a) => a.idnumber === 'cv3:shell:exams_teacher');
    const holders = acts.filter((a) => extractText(a.intro).includes(EXAMS_TEACHER_NOTE_AVAILABILITY));
    if (!hasExams) {
      if (own || holders.length) add('TEACHER_NOTE', 'cv3:shell:exams_teacher', 'nota para docentes de las evaluaciones en un curso sin evaluaciones');
      return;
    }
    const want = withCertificate ? 'cv3:shell:certificate_teacher' : 'cv3:shell:exams_teacher';
    if (withCertificate && own) add('TEACHER_NOTE', own.idnumber, 'con certificado la nota va en el label del certificado, no en un label propio');
    if (holders.length !== 1 || holders[0].idnumber !== want) {
      add('TEACHER_NOTE', want, `la nota para docentes de las evaluaciones debe estar exactamente una vez, en ${want} (está en ${holders.map((h) => h.idnumber).join(', ') || 'ninguno'})`);
      return;
    }
    const h = holders[0];
    const t = extractText(h.intro);
    if (h.modname !== 'label' || h.module.visible !== '0') add('TEACHER_NOTE', h.idnumber, `la nota para docentes debe ir en un label oculto (visible=0), es ${h.modname} visible=${h.module.visible}`);
    if (!t.includes(withCertificate ? examsTeacherNoteFor(facts) : EXAMS_TEACHER_NOTE_ATTEMPTS)) add('TEACHER_NOTE', h.idnumber, 'la nota para docentes no trae las dos oraciones (acceso condicional + intentos adicionales)');
    // r55 (R6): con intentos ilimitados, la nota explica que la página queda oculta hasta que el docente la muestre.
    if (examsHaveUnlimitedAttempts(facts) && !t.includes(EXAMS_TEACHER_NOTE_UNLIMITED)) add('TEACHER_NOTE', h.idnumber, 'falta la nota de las evaluaciones con intentos ilimitados (página oculta hasta que el docente la muestre)');
    // r55 (R4): la regla real de aprobación (criterio único de nota final, cron, override manual sin efecto).
    if (courseHasGrades(facts) && !t.includes(courseApprovalTeacherNote(courseApprovalRequirements(facts)))) add('TEACHER_NOTE', h.idnumber, 'la nota para docentes no explica la regla de aprobación (nota final)');
    if (!withCertificate) {
      const first = acts.find((a) => a.sectionid === h.sectionid);
      if (first !== h) add('TEACHER_NOTE', h.idnumber, 'la nota para docentes debe ser lo primero de su sección');
    }
  };
  const checkCertificate = async (): Promise<void> => {
    const W = 'badges.xml';
    const courseXml = (await text('course/course.xml')) ?? '';
    const cid = num(/<course id="(\d+)"/.exec(courseXml)?.[1]);
    if (!(backupCourseId >= 1) || cid !== backupCourseId) add('CERTIFICATE', 'course/course.xml', `id del curso ${cid} ≠ original_course_id ${backupCourseId}`);
    const cctx = num(/<course id="\d+" contextid="(\d+)"/.exec(courseXml)?.[1]);
    if (cctx !== backupCourseCtx || backupCourseCtx === num(tag(mb, 'original_system_contextid'))) {
      add('CERTIFICATE', 'moodle_backup.xml', `contexto del curso ${cctx}/${backupCourseCtx} inválido (no puede ser el de sistema: la imagen de la insignia se restauraría en el contexto de sistema)`);
    }
    // Fix round 1b (decisión M5): el certificado existe SOLO con evaluación final. Sin ella: ni
    // insignia, ni imagen, ni setting badges, ni panel, ni label para docentes.
    if (!gradedActs.some((g) => g.kind === 'finalExam')) {
      const bx0 = (await text('badges.xml')) ?? '';
      const closing0 = acts.find((a) => a.idnumber === 'cv3:shell:closing');
      const set0 = blocks(tag(mb, 'settings') ?? '', 'setting').find((b) => tag(b, 'level') === 'root' && tag(b, 'name') === 'badges');
      if (blocks(bx0, 'badge').length > 0) add('CERTIFICATE', W, 'curso sin evaluación final con insignia-certificado');
      if (set0 && tag(set0, 'value') !== '0') add('CERTIFICATE', 'moodle_backup.xml', 'curso sin evaluación final con el setting badges ≠ 0');
      if (files.some((f) => f.component === 'badges')) add('CERTIFICATE', 'files.xml', 'curso sin evaluación final con imagen de insignia');
      if (closing0 && /BADGESVIEWBYID|certificad/i.test(`${closing0.intro} ${extractText(closing0.intro)}`)) add('CERTIFICATE', 'cv3:shell:closing', 'curso sin evaluación final que promete un certificado');
      if (acts.some((a) => a.idnumber === 'cv3:shell:certificate_teacher')) add('CERTIFICATE', 'cv3:shell:certificate_teacher', 'label para docentes sin insignia en el paquete');
      checkHidden(gradedActs.some((g) => g.kind === 'exam') ? 'cv3:shell:exams_teacher' : null);
      checkExamsTeacher(false);
      return;
    }
    const settingsXml = tag(mb, 'settings') ?? '';
    const badgesSetting = blocks(settingsXml, 'setting').find((b) => tag(b, 'level') === 'root' && tag(b, 'name') === 'badges');
    if (!badgesSetting || tag(badgesSetting, 'value') !== '1') add('CERTIFICATE', 'moodle_backup.xml', 'el setting raíz badges debe ser 1 (si no, Moodle no restaura la insignia)');
    const bx = await text('badges.xml');
    const badges = bx ? blocks(bx, 'badge') : [];
    if (badges.length !== 1) {
      add('CERTIFICATE', W, `se esperaba exactamente una insignia de curso (hay ${badges.length})`);
      checkHidden('cv3:shell:certificate_teacher'); // review M3: no ocultar un segundo hallazgo
      return;
    }
    const b = badges[0];
    const bid = num(/<badge id="(\d+)"/.exec(b)?.[1]);
    const name = unxml(tag(b, 'name') ?? '');
    if (!name.startsWith('Certificado: ') || [...name].length > 255) add('CERTIFICATE', W, `nombre inválido: ${name}`);
    const fields: Record<string, string> = { type: '2', courseid: String(backupCourseId), status: '1', notification: '0', language: 'es' };
    for (const [k, v] of Object.entries(fields)) if (tag(b, k) !== v) add('CERTIFICATE', W, `<${k}> ${tag(b, k)} ≠ ${v}`);
    if (!(tag(b, 'issuername') ?? '').trim()) add('CERTIFICATE', W, 'sin emisor');
    if (!(unxml(tag(b, 'message') ?? '')).includes('%badgename%')) add('CERTIFICATE', W, 'el mensaje no usa %badgename%');
    // r55 (R4/R8): la insignia se otorga al COMPLETAR el curso, y eso exige el criterio de nota (GRADE_CRITERION_CERT);
    // descripción y panel enuncian la regla real (nota final ≥ mínimo, pesos), nunca «aprobar todas…».
    if (gradeCrit.length !== 1) add('GRADE_CRITERION_CERT', 'completion.xml', 'la insignia-certificado existe pero el curso no exige la nota final (criterio de nota)');
    if (!courseHasGrades(facts)) add('CERTIFICATE', W, 'insignia en un curso sin nota');
    else {
      const req = courseApprovalRequirements(facts);
      const wantDesc = courseBadgeDescription(safeActivityName(facts.course.title, 254), req);
      const desc = unxml(tag(b, 'description') ?? '');
      if (desc !== wantDesc) add('CERTIFICATE', W, `descripción «${desc}» ≠ regla real «${wantDesc}»`);
      const closingTxt = extractText(acts.find((a) => a.idnumber === 'cv3:shell:closing')?.intro ?? '');
      if (!closingTxt.includes(closingCertificateText(req))) add('CERTIFICATE', 'cv3:shell:closing', `el panel no enuncia la regla real: «${closingCertificateText(req)}»`);
    }
    if (/aprobar todas|apruebes todas|todas las actividades|todos los videos|todas las evaluaciones/i.test(unxml(tag(b, 'description') ?? ''))) {
      add('CERTIFICATE', W, 'la descripción de la insignia exige aprobar todas las actividades (la regla es la nota final)');
    }
    const crits = blocks(b, 'criterion').map((c) => ({
      type: num(tag(c, 'criteriatype')),
      method: num(tag(c, 'method')),
      params: blocks(c, 'parameter').map((p) => [tag(p, 'name'), tag(p, 'value')]),
    }));
    const overall = crits.filter((c) => c.type === 0);
    const course = crits.filter((c) => c.type === 4);
    if (crits.length !== 2 || overall.length !== 1 || course.length !== 1) add('CERTIFICATE', W, `criterios: se esperaba global + completion del curso (hay ${crits.map((c) => c.type).join(',')})`);
    else {
      if (overall[0].method !== 1 || course[0].method !== 1) add('CERTIFICATE', W, 'la agregación de criterios debe ser ALL (1)');
      if (JSON.stringify(course[0].params) !== JSON.stringify([[`course_${backupCourseId}`, String(backupCourseId)]])) {
        add('CERTIFICATE', W, `parámetro del criterio de curso ${JSON.stringify(course[0].params)} ≠ course_${backupCourseId}`);
      }
    }
    for (const [fn, size] of [['f1.png', 100], ['f2.png', 35], ['f3.png', 512]] as const) {
      const f = files.find((x) => x.component === 'badges' && x.filearea === 'badgeimage' && x.filename === fn);
      if (!f) {
        add('CERTIFICATE', 'files.xml', `falta la imagen de la insignia ${fn}`);
        continue;
      }
      if (f.itemid !== bid || f.ctx !== backupCourseCtx) add('CERTIFICATE', 'files.xml', `${fn}: itemid ${f.itemid}/contextid ${f.ctx} ≠ insignia ${bid}/contexto del curso ${backupCourseCtx}`);
      const blob = await bin(`files/${f.hash.slice(0, 2)}/${f.hash}`);
      const png = blob && blob.length > 24 && blob.readUInt32BE(0) === 0x89504e47 && blob.toString('latin1', 12, 16) === 'IHDR';
      if (!png || blob.readUInt32BE(16) !== size || blob.readUInt32BE(20) !== size) add('CERTIFICATE', 'files.xml', `${fn} no es una PNG de ${size}×${size}`);
    }
    const closingLbl = acts.find((a) => a.idnumber === 'cv3:shell:closing');
    const tok = `$@BADGESVIEWBYID*${backupCourseId}@$`;
    if (!closingLbl || !closingLbl.intro.includes(`href="${tok}"`) || !extractText(closingLbl.intro).includes('Tu certificado')) {
      add('CERTIFICATE', 'cv3:shell:closing', `el cierre no trae el panel «Tu certificado» con el enlace ${tok}`);
    }
    // Fix 0b: label solo para docentes (oculto) con el paso «Habilitar acceso» y el botón a las insignias.
    const teacher = acts.find((a) => a.idnumber === 'cv3:shell:certificate_teacher');
    if (!teacher) add('CERTIFICATE', 'cv3:shell:certificate_teacher', 'falta el label oculto para docentes (la insignia se restaura desactivada)');
    else {
      const t = extractText(teacher.intro);
      if (teacher.modname !== 'label' || teacher.module.visible !== '0') add('CERTIFICATE', teacher.idnumber, `debe ser un label oculto (visible=0), es ${teacher.modname} visible=${teacher.module.visible}`);
      if (!teacher.intro.includes(`href="${tok}"`) || !t.includes('Habilitar acceso') || !t.includes(`«${name}»`) || !t.includes(CERTIFICATE_TEACHER_TROUBLESHOOTING)) {
        add('CERTIFICATE', teacher.idnumber, `sin el paso «Habilitar acceso» de «${name}» o sin el enlace ${tok}`);
      }
      if (courseHasGrades(facts) && !t.includes(courseApprovalTeacherNote(courseApprovalRequirements(facts)))) add('CERTIFICATE', teacher.idnumber, 'el label para docentes no explica la regla de aprobación (nota final, cron)');
    }
    checkHidden('cv3:shell:certificate_teacher');
    checkExamsTeacher(true);
  };

  // ── labels: CLEAN_SAFE, menciones, cifras, tokens ──
  const chapterById = new Map(facts.chapters.map((c) => [c.id, c]));
  const moduleById = new Map(facts.modules.map((m) => [m.id, m]));
  // #583 (builder 3.11.0): la descripción del recurso del Libro Guía (antes un label aparte) pasa las mismas reglas.
  const labels = acts.filter((a) => a.modname === 'label' || (a.modname === 'resource' && a.idnumber === 'cv3:shell:libro' && a.intro.trim() !== ''));
  const allowedFor = (a: ParsedActivity): Record<ResourceKind, boolean> | null => {
    const chm = /^cv3:ch:([^:]+):/.exec(a.idnumber);
    if (chm) {
      const ch = chapterById.get(chm[1]);
      if (!ch) return null;
      const mod = moduleById.get(ch.moduleId);
      const last = !!mod && mod.chapterNumbers[mod.chapterNumbers.length - 1] === ch.number;
      // EV6: el último capítulo del curso (módulo sin examen) lleva el botón «Ir a la evaluación final →».
      // Fix 1 (I2): SOLO su label de cierre (el botón determinístico); el resto del capítulo, nunca.
      const toFinal = steps[ch.id]?.kind === 'final_exam' && /:closing$/.test(a.idnumber);
      // EV6 T5 (ruling 3): un capítulo con video pendiente solo puede nombrar el video si lleva el aviso.
      // Motor de carga horaria: un capítulo de práctica no tiene presentación (no puede nombrarla).
      // Fase 2: la Actividad de Aplicación también es una actividad del capítulo (puede nombrarse).
      // Loop 9 B: la práctica guiada del capítulo también es práctica del capítulo (el recorrido la nombra).
      return { video: ch.videoEnabled || ch.videoPendingNotice === true, activity: ch.activityEnabled || ch.applicationMinutes !== undefined || ch.guidedPracticeMinutes !== undefined, exam: !!mod?.examEnabled && last, final_exam: toFinal, presentation: ch.kind !== 'practice', other: false };
    }
    const mm = /^cv3:(?:module_intro|exam_info):(.+)$/.exec(a.idnumber);
    if (mm) {
      const mod = moduleById.get(mm[1]);
      if (!mod) return null;
      const chs = facts.chapters.filter((c) => c.moduleId === mod.id);
      return { video: chs.some((c) => c.videoEnabled || c.videoPendingNotice === true), activity: chs.some((c) => c.activityEnabled), exam: mod.examEnabled, final_exam: false, presentation: true, other: false };
    }
    const cc = facts.counts;
    return { video: cc.videos > 0 || facts.chapters.some((c) => c.videoPendingNotice === true), activity: cc.activities > 0, exam: cc.exams > 0 || cc.finalExam, final_exam: cc.finalExam, presentation: true, other: false };
  };
  for (const a of labels) {
    const lint = lintCleanSafe(a.intro);
    if (!lint.ok) add('CLEAN_SAFE', a.idnumber, lint.errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join('; '));
    const txt = extractText(a.intro);
    const allowed = allowedFor(a);
    const mn = /^cv3:module_next:(.+)$/.exec(a.idnumber);
    if (!allowed || (mn && !moduleById.has(mn[1]))) add('STRUCTURE', a.idnumber, 'idnumber apunta a un capítulo/módulo que no está en facts');
    else {
      // Fix 1 (m4): los títulos del Blueprint (p. ej. el módulo siguiente en un botón) no son menciones de recursos.
      for (const hit of lintResourceMentions(stripStructureTitles(`${a.name}. ${txt}`, facts))) {
        const kind = resourceMentionKind(hit.match);
        if (!allowed[kind]) add('RESOURCE_DISABLED', a.idnumber, `menciona "${hit.match}" (${kind}) y ese recurso no existe aquí`);
      }
    }
    const deterministic = /^cv3:(shell:|module_intro:|exam_info:|module_next:|final_exam_info|final_exam_next)/.test(a.idnumber) || /^cv3:ch:[^:]+:presentation$/.test(a.idnumber);
    if (deterministic) {
      const prose = exp.shellProseByLabel?.[a.idnumber] ?? [];
      const bad = lintShellNumbers(`${a.name} ${txt}`, facts, prose);
      if (bad.length) add('NUMBER_NOT_FROM_FACTS', a.idnumber, `cifras fuera de facts: ${bad.join(', ')}`);
    }
    const chm = /^cv3:ch:([^:]+):/.exec(a.idnumber);
    if (chm && allowed) {
      for (const t of transitionTexts(a.intro).map((x) => stripStructureTitles(x, facts))) {
        const bad = lintShellNumbers(t, facts);
        if (bad.length) add('NUMBER_NOT_FROM_FACTS', a.idnumber, `transición con cifras fuera de facts: ${bad.join(', ')}`);
        // EV6 T5: transiciones y recorrido son navegación → solo con un video REAL (el aviso de pendiente no cuenta).
        if (!chapterById.get(chm[1])?.videoEnabled && /\bvideos?\b/i.test(t)) add('TRANSITION_DISABLED_RESOURCE', a.idnumber, 'transición habla de video sin video');
        if (!allowed.activity && /\b(actividad|práctica|practica)\b/i.test(t)) add('TRANSITION_DISABLED_RESOURCE', a.idnumber, 'transición habla de práctica sin actividad');
        if (!allowed.exam && /evaluaci[oó]n del m[oó]dulo/i.test(t)) add('TRANSITION_DISABLED_RESOURCE', a.idnumber, 'transición promete una evaluación del módulo inexistente');
        if (!allowed.final_exam && /evaluaci[oó]n final|examen final/i.test(t)) add('TRANSITION_DISABLED_RESOURCE', a.idnumber, 'un capítulo no promete el examen final');
      }
      // P3: el riel del módulo — cifras de facts; nombra la evaluación del módulo solo si el módulo la tiene,
      // y nunca video, práctica ni evaluación final.
      const railMod = moduleById.get(chapterById.get(chm[1])?.moduleId ?? '');
      for (const t of transitionTexts(a.intro, 'rail').map((x) => stripStructureTitles(x, facts))) {
        const bad = lintShellNumbers(t, facts);
        if (bad.length) add('NUMBER_NOT_FROM_FACTS', a.idnumber, `riel del módulo con cifras fuera de facts: ${bad.join(', ')}`);
        if (!railMod?.examEnabled && /evaluaci[oó]n del m[oó]dulo/i.test(t)) add('TRANSITION_DISABLED_RESOURCE', a.idnumber, 'el riel promete una evaluación del módulo inexistente');
        if (/\bvideos?\b|\b(actividad|práctica|practica)\b|evaluaci[oó]n final|examen final/i.test(t)) add('TRANSITION_DISABLED_RESOURCE', a.idnumber, 'el riel del módulo nombra un recurso que no es un capítulo ni la evaluación del módulo');
      }
    }
  }
  // T1 (r57): vocabulario interno del generador («worked_example», «texto fuente», «[S12]»…) en NINGÚN texto visible
  // (labels, páginas del estudiante y del docente, descripciones). Solo paquetes cuyas expectativas traen las
  // exenciones del dominio (builder con la reparación determinística); las expectativas viejas no se re-juzgan.
  if (Array.isArray(exp.internalVocabularyExempt)) {
    for (const a of acts) {
      if (!['label', 'page', 'resource', 'h5pactivity', 'quiz', 'forum', 'assign'].includes(a.modname)) continue;
      const body = a.modname === 'page' ? unxml(tag((await text(`${a.dir}/page.xml`)) ?? '', 'content') ?? '') : '';
      // Review r1 (I2): solo el texto GENERADO se juzga: lo que escribió una persona se quita antes.
      const visible = `${a.name}\n${extractText(a.intro)}\n${body ? extractText(body) : ''}`;
      const hits = lintInternalVocabulary(stripProtectedVocabularyTexts(visible, exp.internalVocabularyUserTexts ?? []), exp.internalVocabularyExempt);
      if (hits.length) add('INTERNAL_VOCABULARY', a.idnumber, `texto interno del generador visible: ${[...new Set(hits.map((h) => `«${h.match}»`))].slice(0, 5).join(', ')}`);
    }
  }
  // T6 (r57): cobertura del Manifest — cada parte que facts declara por capítulo está en el paquete con su tipo de
  // módulo (nada se omite en silencio) y no hay partes de más: presentación ⇔ capítulo de contenido (con su PDF y su
  // portada), video ⇔ video real, actividad ⇔ actividad encendida (h5pactivity | scorm según la variante).
  for (const ch of facts.chapters) {
    const one = (role: string) => acts.filter((a) => a.idnumber === `cv3:ch:${ch.id}:${role}`);
    const expectPart = (role: string, want: boolean, modname: string | null) => {
      const got = one(role);
      if (got.length !== (want ? 1 : 0)) add('MANIFEST_COVERAGE', `cv3:ch:${ch.id}:${role}`, `capítulo ${ch.number}: ${got.length} módulo(s) ${role}, facts ${want ? 'lo declara' : 'no lo declara'}`);
      else if (want && modname && got[0].modname !== modname) add('MANIFEST_COVERAGE', got[0].idnumber, `capítulo ${ch.number}: ${role} es ${got[0].modname}, se esperaba ${modname}`);
      return got[0];
    };
    const pres = expectPart('presentation', ch.kind !== 'practice', 'label');
    if (pres && ch.kind !== 'practice') {
      const mine = files.filter((f) => f.ctx === pres.ctx && f.component === 'mod_label' && f.filearea === 'intro' && f.filename !== '.');
      const pdf = mine.find((f) => /\.pdf$/i.test(f.filename));
      if (!pdf || !mine.some((f) => /\.png$/i.test(f.filename))) add('MANIFEST_COVERAGE', pres.idnumber, `capítulo ${ch.number}: la presentación no lleva su PDF y su portada`);
      else {
        const b = await bin(`files/${pdf.hash.slice(0, 2)}/${pdf.hash}`);
        if (!b || b.subarray(0, 5).toString('latin1') !== '%PDF-') add('MANIFEST_COVERAGE', pres.idnumber, `capítulo ${ch.number}: el PDF de la presentación no es un PDF`);
      }
    }
    expectPart('video', ch.videoEnabled, 'h5pactivity');
    expectPart('activity', ch.activityEnabled, ch.activityVariant === 'scorm' ? 'scorm' : ch.activityVariant === 'h5p' ? 'h5pactivity' : null);
  }
  for (const a of acts) {
    const m = /^cv3:ch:([^:]+):/.exec(a.idnumber);
    if (m && !chapterById.has(m[1])) add('MANIFEST_COVERAGE', a.idnumber, 'módulo de un capítulo que no está en facts');
  }
  // EV6 T5: video pendiente = sin actividad de video; el aviso existe si y solo si facts lo pide.
  for (const ch of facts.chapters) {
    const hasVideo = acts.some((a) => a.idnumber === `cv3:ch:${ch.id}:video`);
    const hasNotice = labels.some((a) => a.idnumber === `cv3:ch:${ch.id}:video_pending`);
    if (ch.videoPending === true && hasVideo) add('STRUCTURE', `cv3:ch:${ch.id}:video`, 'video pendiente (vista previa) empaquetado como actividad');
    if (hasNotice !== (ch.videoPendingNotice === true)) add('STRUCTURE', `cv3:ch:${ch.id}:video_pending`, `aviso de video pendiente ${hasNotice ? 'sin' : 'faltante con'} video pendiente mencionado`);
  }
  // T6 (r57): los tokens, @@PLUGINFILE@@ y enlaces se revisan en TODO HTML visible del paquete: el intro de cada
  // actividad y el contenido de cada página (mod_page/content), cada uno contra SU filearea.
  const pageContent = new Map<number, string>();
  for (const a of acts.filter((x) => x.modname === 'page')) pageContent.set(a.mid, unxml(tag((await text(`${a.dir}/page.xml`)) ?? '', 'content') ?? ''));
  for (const a of acts) {
    const comp = a.modname === 'label' ? 'mod_label' : `mod_${a.modname}`;
    const surfaces: Array<{ html: string; filearea: string; where: string }> = [{ html: `${a.intro}`, filearea: 'intro', where: a.idnumber }];
    if (pageContent.has(a.mid)) surfaces.push({ html: pageContent.get(a.mid) as string, filearea: 'content', where: `${a.idnumber}#content` });
    for (const s of surfaces) {
      if (s.html.includes('cursia-cta://')) add('TOKEN_INVALID', s.where, 'botón de navegación con marcador cursia-cta sin resolver');
      for (const m of s.html.matchAll(/\$@([A-Z0-9_]+)(?:\*(\d+))?@\$/g)) {
        // Edu EV3: botón «Continuar con el módulo…» → sección del paquete (id de section.xml).
        if (m[1] === 'COURSESECTIONBYID') {
          if (!m[2] || !sectionIds.has(Number(m[2]))) add('TOKEN_INVALID', s.where, `token ${m[0]} no resuelve a una sección del paquete`);
          continue;
        }
        // EV6 T3: página de insignias (certificado) del curso DEL BACKUP (decode rule 'course').
        if (m[1] === 'BADGESVIEWBYID') {
          if (!m[2] || Number(m[2]) !== backupCourseId) add('TOKEN_INVALID', s.where, `token ${m[0]} no apunta al curso del backup (${backupCourseId})`);
          continue;
        }
        const kind = /^(.+)VIEWBYID$/.exec(m[1])?.[1]?.toLowerCase();
        const target = m[2] ? byMid.get(Number(m[2])) : undefined;
        if (!kind || !target || target.modname !== kind) add('TOKEN_INVALID', s.where, `token ${m[0]} no resuelve a un ${kind ?? '?'} del paquete`);
      }
      // T6 (r57): un enlace muerto (href="#", vacío o javascript:) es un token saneado o inventado: nunca se entrega.
      for (const m of s.html.matchAll(/\bhref\s*=\s*(["'])\s*(#?|javascript:[^"']*)\s*\1/gi)) {
        add('TOKEN_INVALID', s.where, `enlace muerto href=${m[1]}${m[2]}${m[1]} (un destino del paquete que no resolvió)`);
      }
      for (const m of s.html.matchAll(/@@PLUGINFILE@@\/([^"'?&<>\s]+)/g)) {
        const name = decodeURIComponent(m[1]);
        if (name.startsWith('..')) continue; // ruta del embed.php (se resuelve a wwwroot)
        if (!files.some((f) => f.ctx === a.ctx && f.component === comp && f.filearea === s.filearea && f.filename === name)) {
          add('FILES_INTEGRITY', s.where, `@@PLUGINFILE@@/${name} sin archivo en su filearea ${s.filearea}`);
        }
      }
    }
  }

  // UX r18 (problemas 1 y 4): orden de la sección 0 (hero con tema justo bajo el encabezado de Moodle,
  // foro de avisos al final) y botón «Iniciar actividad» solo hacia una actividad que NO se embebe.
  // Fix 1 (M4): solo para paquetes del builder ≥ 3.12.0 (los anteriores tenían otro orden y el botón siempre).
  if (builderVersionAtLeast(exp.builderVersion, '3.12.0')) {
    const sec0 = acts.filter((a) => a.sectionid === 0).map((a) => a.idnumber);
    if (sec0.length && sec0[0] !== 'cv3:shell:welcome') add('SECTIONS', 'sections/section_0', `la sección 0 abre con ${sec0[0]} (debe abrir con cv3:shell:welcome)`);
    if (sec0.length && sec0[sec0.length - 1] !== 'cv3:shell:forum') add('SECTIONS', 'sections/section_0', `la sección 0 cierra con ${sec0[sec0.length - 1]} (debe cerrar con cv3:shell:forum)`);
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i];
      if (!/^cv3:ch:[^:]+:activity_instruction$/.test(a.idnumber)) continue;
      const next = acts[i + 1];
      if (!next || next.sectionid !== a.sectionid || next.idnumber !== a.idnumber.replace(/:activity_instruction$/, ':activity')) {
        add('STRUCTURE', a.idnumber, 'la instrucción de la práctica no va seguida de su actividad');
        continue;
      }
      const tok = `VIEWBYID*${next.mid}@$`;
      if (next.modname === 'h5pactivity' && `${a.intro}`.includes(tok)) add('NAVIGATION', a.idnumber, `botón «Iniciar actividad» hacia ${next.idnumber}, que ya está embebida debajo`);
      if (next.modname === 'scorm' && !`${a.intro}`.includes(`$@SCORM${tok}`)) add('NAVIGATION', a.idnumber, `sin botón «Iniciar actividad» hacia el SCORM ${next.idnumber}`);
    }
  }

  // r19 W: la bienvenida es una pantalla compuesta (hero con superficie, entrada corta, cuerpo en párrafos), nunca
  // un muro de texto. Solo paquetes del builder ≥ 3.13.0 (los anteriores tenían la bienvenida en un solo párrafo).
  if (builderVersionAtLeast(exp.builderVersion, '3.13.0')) {
    const w = acts.find((a) => a.idnumber === 'cv3:shell:welcome');
    if (w) {
      const intro = w.intro;
      if (!/class="cvc-welcome-band cvc-hero-(?:band|rule|plate)"/.test(intro)) add('STRUCTURE', 'cv3:shell:welcome', 'la bienvenida no tiene la superficie del hero (cvc-welcome-band)');
      // Fix round 1 (M3): la entrada son TODOS los p.cvc-lead (el tope vale para el conjunto).
      const leadWords = [...intro.matchAll(/<p class="cvc-lead"[^>]*>([\s\S]*?)<\/p>/g)].reduce((n, m) => n + wordCountText(extractText(m[1])), 0);
      if (leadWords > WELCOME_LEAD_MAX_WORDS) add('STRUCTURE', 'cv3:shell:welcome', `la entrada de la bienvenida supera ${WELCOME_LEAD_MAX_WORDS} palabras`);
      for (const m of intro.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
        const n = wordCountText(extractText(m[1]));
        if (n > WELCOME_PARA_MAX_WORDS) add('STRUCTURE', 'cv3:shell:welcome', `párrafo de ${n} palabras en la bienvenida (máximo ${WELCOME_PARA_MAX_WORDS})`);
      }
    }
  }

  // ── EV6 T3: certificado (insignia de curso nativa) ──
  await checkCertificate();

  // ── EV6 P2-B5: banco aleatorio, página gated, fugas de respuestas ──
  for (const i of examChecksV3(await readExamPackageV3(zip), { facts, examBankPlans: exp.examBankPlans })) add(i.code, i.where, i.message);

  // ── H5P ── r55 (R7): TODO .h5p del curso es solo contenido (h5p.json + content/): sus librerías vienen del pack
  // del sitio (v3 si hay QuestionSet 1.21, caso ramificado o «Repaso»). Una carpeta de librería en el paquete es
  // H5P_LIBRARIES; y si trae alguna, su clausura de dependencias debe ser completa (H5P_PARTIAL_LIBRARY_CLOSURE): una
  // clausura parcial de una librería instalada cuelga `H5PValidator::isValidPackage` (dialogcards-diagnosis.md).
  const profileKeys = new Set(CURSIA_H5P_PROFILE_V3.libraries.map((l) => `${l.machineName} ${l.majorVersion}.${l.minorVersion}`));
  const mainRefs = CURSIA_H5P_PROFILE_V3.mainLibraries as Record<string, { majorVersion: number; minorVersion: number }>;
  const h5pActs = acts.filter((a) => a.modname === 'h5pactivity');
  for (const a of h5pActs) {
    const mine = files.filter((f) => f.ctx === a.ctx && f.component === 'mod_h5pactivity' && f.filename !== '.');
    const pkg = mine.find((f) => f.filearea === 'package');
    if (!pkg) {
      add('H5P_FILES', a.idnumber, 'falta la entrada package del .h5p');
      continue;
    }
    // V542 I2: UNA sola copia (el embed inline usa la de `package`); una segunda copia = dos contenidos
    // H5P sobre el mismo estado xAPI → «Data Reset» y progreso perdido.
    // Fix round 1 (M7): solo otra copia del PAQUETE (.h5p o el mismo blob) cuenta; un medio del intro (imagen) no.
    const copies = mine.filter((f) => f !== pkg && (/\.h5p$/i.test(f.filename) || f.hash === pkg.hash));
    if (copies.length) add('H5P_FILES', a.idnumber, `más de una copia del .h5p (${[pkg, ...copies].map((f) => f.filearea).join(', ')}): el estado se duplica`);
    if (!a.intro.includes(`url=@@PLUGINFILE@@/../package/0/${pkg.filename}&`)) add('H5P_FILES', a.idnumber, 'el intro no embebe el .h5p del filearea package');
    const blob = await bin(`files/${pkg.hash.slice(0, 2)}/${pkg.hash}`);
    if (!blob) continue;
    try {
      // Solo el directorio central + h5p.json (+ library.json de cada carpeta, si las hubiera): los JS/CSS nunca se inflan.
      const hz = await JSZip.loadAsync(blob);
      const names = Object.keys(hz.files).filter((n) => !hz.files[n].dir);
      const extra = names.filter((n) => n !== 'h5p.json' && !n.startsWith('content/'));
      const hjFile = hz.file('h5p.json');
      if (!hjFile) {
        add('H5P_LIBRARIES', a.idnumber, 'el paquete no tiene h5p.json');
        continue;
      }
      const hj = JSON.parse(await hjFile.async('string'));
      // T6 (r57): un .h5p sin content/content.json (o ilegible) se restaura vacío.
      const cj = hz.file('content/content.json');
      if (!cj) add('H5P_FILES', a.idnumber, 'el paquete no tiene content/content.json');
      else {
        try {
          JSON.parse(await cj.async('string'));
        } catch {
          add('H5P_FILES', a.idnumber, 'content/content.json no es JSON válido');
        }
      }
      const tops = [...new Set(extra.map((n) => n.split('/')[0]))].sort();
      if (extra.length) add('H5P_LIBRARIES', a.idnumber, `el paquete no es content-only: ${tops.slice(0, 5).join(', ')} (las librerías vienen del pack del sitio)`);
      // Clausura: toda dependencia (preloaded/dynamic/editor) de un library.json incluido debe venir incluida.
      if (tops.length) {
        const bundled = new Set<string>();
        const deps: string[] = [];
        for (const d of tops) {
          const lf = hz.file(`${d}/library.json`);
          if (!lf) continue;
          const lj = JSON.parse(await lf.async('string'));
          bundled.add(`${lj.machineName} ${lj.majorVersion}.${lj.minorVersion}`);
          for (const k of ['preloadedDependencies', 'dynamicDependencies', 'editorDependencies']) {
            for (const dep of (lj[k] ?? []) as Array<{ machineName: string; majorVersion: number; minorVersion: number }>) deps.push(`${dep.machineName} ${dep.majorVersion}.${dep.minorVersion}`);
          }
        }
        const missing = [...new Set(deps.filter((x) => !bundled.has(x)))].sort();
        if (missing.length) add('H5P_PARTIAL_LIBRARY_CLOSURE', a.idnumber, `carpetas de librería con dependencias que no vienen en el paquete: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5})` : ''}`);
      }
      const main = mainRefs[hj.mainLibrary];
      if (!main) add('H5P_LIBRARIES', a.idnumber, `librería principal fuera del perfil: ${hj.mainLibrary}`);
      else {
        const first = (hj.preloadedDependencies ?? [])[0];
        if (!first || first.machineName !== hj.mainLibrary || first.majorVersion !== main.majorVersion || first.minorVersion !== main.minorVersion) {
          add('H5P_LIBRARIES', a.idnumber, `${hj.mainLibrary} declarado ${first ? `${first.majorVersion}.${first.minorVersion}` : '(nada)'} ≠ perfil v3 ${main.majorVersion}.${main.minorVersion}`);
        }
      }
      // G6 M7: la librería principal debe corresponder al rol (video → IV; actividad → tipo de facts: h5pType del Manifest o, legacy, R-012 del UUID; calificable en Moodle).
      const role = /^cv3:ch:([^:]+):(video|activity|review_cards)$/.exec(a.idnumber);
      if (role && role[2] === 'review_cards' && hj.mainLibrary !== 'H5P.Dialogcards') {
        add('H5P_LIBRARIES', a.idnumber, `un «Repaso» debe ser H5P.Dialogcards (vino ${hj.mainLibrary})`);
      }
      if (role && role[2] === 'video' && hj.mainLibrary !== 'H5P.InteractiveVideo') {
        add('H5P_LIBRARIES', a.idnumber, `un video debe ser H5P.InteractiveVideo (vino ${hj.mainLibrary})`);
      }
      if (role && role[2] === 'activity') {
        // EV5-C: el tipo esperado sale de facts (resolveActivityType del Manifest), nunca del hash directo.
        const factType = chapterById.get(role[1])?.activityType ?? null;
        const want = factType ? ACTIVITY_MAIN_LIBRARY[factType] : undefined;
        if (!want) add('H5P_LIBRARIES', a.idnumber, `facts no declara un tipo h5p para la actividad del capítulo ${role[1]}`);
        if (!H5P_MOODLE_GRADING[hj.mainLibrary]?.gradable) add('H5P_LIBRARIES', a.idnumber, `${hj.mainLibrary} no es calificable en Moodle (R-011)`);
        if (want && hj.mainLibrary !== want) add('H5P_LIBRARIES', a.idnumber, `la actividad del capítulo debe ser ${want} (R-012), vino ${hj.mainLibrary}`);
      }
      for (const d of hj.preloadedDependencies ?? []) {
        const k = `${d.machineName} ${d.majorVersion}.${d.minorVersion}`;
        if (!profileKeys.has(k)) add('H5P_LIBRARIES', a.idnumber, `dependencia fuera del perfil v3 (pack del sitio): ${k}`);
      }
    } catch (err) {
      add('H5P_LIBRARIES', a.idnumber, `no se pudo leer el .h5p: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const p of keepBlobs) {
    keepBlobs.delete(p);
    const hit = binCache.get(p);
    if (hit && ((await hit)?.length ?? 0) > BIN_CACHE_MAX_BYTES) binCache.delete(p);
  }

  // ── audio ──
  const audioCheck = async (idnumber: string, expectSeconds: number, extra: (txt: string) => string[]) => {
    const a = acts.find((x) => x.idnumber === idnumber);
    if (!a) {
      add('AUDIO_DURATION', idnumber, 'falta el label de audio');
      return;
    }
    const f = files.find((x) => x.ctx === a.ctx && x.component === 'mod_label' && x.filearea === 'intro' && /\.mp3$/i.test(x.filename));
    const blob = f ? await bin(`files/${f.hash.slice(0, 2)}/${f.hash}`) : null;
    if (!blob) {
      add('AUDIO_DURATION', idnumber, 'el label no lleva su MP3 en el filearea intro');
      return;
    }
    let measured: number;
    try {
      measured = mp3DurationSeconds(blob);
    } catch (err) {
      add('AUDIO_DURATION', idnumber, `el MP3 del paquete no se puede medir: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (Math.abs(measured - expectSeconds) > 1e-6) add('AUDIO_DURATION', idnumber, `facts dice ${expectSeconds}s, el MP3 del paquete mide ${measured}s`);
    const txt = extractText(a.intro);
    for (const s of [formatDurationEs(measured), ...extra(txt)]) if (!txt.includes(s)) add('AUDIO_DURATION', idnumber, `no muestra la duración medida "${s}"`);
  };
  await audioCheck('cv3:shell:audio_welcome', facts.audio.welcomeSeconds, () => []);
  await audioCheck('cv3:shell:audiobook', facts.audio.audiobookSeconds, () =>
    facts.audio.audiobookParts.flatMap((p) => [formatDurationEs(p.seconds), formatDurationEs(p.offsetSeconds)]),
  );

  // ── Libro Guía ──
  const libro = acts.find((a) => a.idnumber === 'cv3:shell:libro');
  const libroFiles = libro ? files.filter((f) => f.ctx === libro.ctx && f.component === 'mod_resource' && f.filearea === 'content' && f.filename !== '.') : [];
  const lf = libroFiles[0];
  // r19: un paquete ≥ 3.13.0 (o cuyo Libro ya es PDF, con expectativas sin versión) sigue las reglas del PDF;
  // el botón (LIBRO_CTA) solo se exige con la versión declarada ≥ 3.13.0.
  const libroIsPdf = builderVersionAtLeast(exp.builderVersion, '3.13.0') || (!!lf && (lf.mimetype === 'application/pdf' || /\.pdf$/i.test(lf.filename)));
  if (libroIsPdf) {
    // r19 (L1/L5): un ÚNICO archivo, PDF real (application/pdf, .pdf), en el contexto del propio recurso.
    if (!libro || !lf) add('LIBRO', 'cv3:shell:libro', 'falta el Libro Guía');
    else {
      if (libroFiles.length !== 1) add('LIBRO', 'cv3:shell:libro', `el recurso debe tener exactamente 1 archivo (tiene ${libroFiles.length})`);
      const others = files.filter((f) => f !== lf && f.filename !== '.' && (f.hash === lf.hash || /^libro_guia/i.test(f.filename)));
      if (others.length) add('LIBRO', 'cv3:shell:libro', `copia del Libro Guía fuera del recurso: ${others.map((f) => `${f.component}/${f.filearea}/${f.filename}`).join(', ')}`);
      if (lf.mimetype !== 'application/pdf' || !/^libro_guia[a-z0-9_]*\.pdf$/.test(lf.filename)) add('LIBRO', 'cv3:shell:libro', `el Libro Guía debe ser un PDF libro_guia*.pdf (es ${lf.filename}, ${lf.mimetype || 'sin mimetype'})`);
      if (!libro.inforefFiles.includes(lf.id)) add('LIBRO', 'cv3:shell:libro', 'inforef del recurso no referencia el PDF');
      const pdf = await bin(`files/${lf.hash.slice(0, 2)}/${lf.hash}`);
      if (!pdf) add('LIBRO', 'cv3:shell:libro', 'falta el blob del PDF');
      else if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-' || !/%%EOF\s*$/.test(pdf.subarray(-32).toString('latin1'))) add('LIBRO', 'cv3:shell:libro', 'el PDF no empieza en %PDF- o no cierra en %%EOF (truncado)');
      // r19 (L4): botón «Abrir Libro Guía» hacia su PROPIO moduleid, en una pestaña nueva.
      if (builderVersionAtLeast(exp.builderVersion, '3.13.0')) {
        const anchors = [...libro.intro.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
        const tok = `$@RESOURCEVIEWBYID*${libro.mid}@$`;
        const ok = anchors.length === 1 && /Abrir Libro Guía/.test(extractText(anchors[0][2])) && anchors[0][1].includes(`href="${tok}"`) && /\btarget="_blank"/.test(anchors[0][1]) && /\brel="[^"]*\bnoopener\b[^"]*"/.test(anchors[0][1]);
        if (!ok) add('LIBRO_CTA', 'cv3:shell:libro#intro', `se esperaba exactamente un botón «Abrir Libro Guía» con href="${tok}" target="_blank" rel="noopener…" (hay ${anchors.length} enlace(s))`);
      }
    }
  } else {
    const lhtml = lf ? await text(`files/${lf.hash.slice(0, 2)}/${lf.hash}`) : null;
    if (!lhtml) add('LIBRO', 'cv3:shell:libro', 'falta el Libro Guía');
    else {
      if (!/<\/html>\s*$/i.test(lhtml)) add('LIBRO', 'cv3:shell:libro', 'no cierra en </html>');
      if (!/<style>[\s\S]*@media print[\s\S]*<\/style>/i.test(lhtml)) add('LIBRO', 'cv3:shell:libro', 'sin <style> con CSS de impresión');
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    stats: { activities: acts.length, labels: labels.filter((a) => a.modname === 'label').length, graded: gradedActs.length, h5p: h5pActs.length, files: files.length },
  };
}
