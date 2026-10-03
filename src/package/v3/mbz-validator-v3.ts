/**
 * Cursia V2.1 — R12: validador del `.mbz` v3 (audit §Q.8), ANTES de subir.
 *
 * Lee el paquete ya armado (no el estado en memoria del builder) y lo compara
 * contra lo que DEBE decir (facts + evaluación resuelta del perfil vigente):
 *   GRADEPASS / GRADEMAX / COMPLETION     cada ítem calificable = perfil, 0–100, completion por nota aprobatoria
 *   CATEGORIES / COURSE_GRADEPASS          categorías, pesos y nota del curso
 *   COURSE_COMPLETION                      criterios de completion del curso
 *   RESOURCE_DISABLED / TRANSITION_*       ningún label menciona un recurso apagado
 *   NUMBER_NOT_FROM_FACTS                  cifras de los labels determinísticos ∈ facts
 *   CLEAN_SAFE                             lint CLEAN_SAFE (cuerpo ≥ 16 px, contraste, hex…) en todo label
 *   TOKEN_INVALID                          todo `$@…$` apunta a un módulo del paquete del tipo correcto
 *   H5P_FILES / H5P_LIBRARIES              un solo .h5p (package) por h5pactivity y el intro lo embebe (V542 I2); solo librerías del perfil
 *                                          EV6 H5P v2: un .h5p de una principal "bundled" de
 *                                          CURSIA_H5P_PROFILE_V2 (Branching Scenario, Dialog Cards)
 *                                          lleva EXACTAMENTE sus carpetas delta, con library.json =
 *                                          versión del perfil v2; los demás siguen content-only (v1)
 *   AUDIO_DURATION                         las duraciones mostradas = las medidas de los MP3 del paquete
 *   FILES_INTEGRITY / STRUCTURE / LIBRO    blobs, inforef, secuencias, Libro Guía
 *   SECTIONS / NAVIGATION                  EV6: una sección por capítulo/evaluación, cierre al final
 *                                          (después del examen final), coursedisplay = 1 y cada
 *                                          botón «Continuar…» → la sección que corresponde
 *   CERTIFICATE                            EV6 T3: insignia de curso (badges.xml) con criterio de
 *                                          completion del curso del backup, setting badges = 1,
 *                                          imagen f1/f2/f3 PNG, examen final como criterio y el
 *                                          panel «Tu certificado» con $@BADGESVIEWBYID*curso@$
 *   QUIZ_FEEDBACK                          QUIZFB: retroalimentación global «aprobaste / todavía no» con la nota mínima del perfil
 *   QUIZ_REVIEW / QUIZ_COMPLETION          EV6 P2-B1: revisión de las respuestas propias al terminar sin nota por pregunta (V542 I1), nota total más tarde; attemptsexhausted = intentos > 0
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
import { extractText, lintCleanSafe, lintResourceMentions, parseHtml } from '../../modules/visual-components';
import type { HtmlNode } from '../../modules/visual-components';
import { CERTIFICATE_TEACHER_TROUBLESHOOTING, EXAMS_TEACHER_NOTE, EXAMS_TEACHER_NOTE_ATTEMPTS, EXAMS_TEACHER_NOTE_AVAILABILITY, CertificateRequirements, CourseFacts, chapterNextSteps, closingCertificateText, examOverallFeedbackBands, lintShellNumbers, sectionLayoutFromFacts, stripStructureTitles } from '../../modules/course-shell';
import { safeActivityName } from '../mbz-common';
import { courseBadgeDescription } from './course-badge';
import { QUIZ_REVIEW_V3 } from './moodle-activities-v3';
import { formatDurationEs, mp3DurationSeconds } from '../audio';
import { ExamBankPlans, examChecksV3, readExamPackageV3 } from './exam-validator-v3';
import {
  CURSIA_H5P_PROFILE_V1,
  CURSIA_H5P_PROFILE_V2,
  H5P_MOODLE_GRADING,
  H5P_BUNDLE_LICENSE_NOTICE_FILE,
  H5pLibraryStoreManifest,
  h5pLibraryDirName,
  openH5pLibraryStore,
  profileBundledMainLibraries,
  profileDeltaDirs,
} from '../h5p';

// EV6 H5P v2 (fix round 1, m-3): manifest del store (lista de archivos y sha256 por carpeta delta), leído una vez.
let storeManifestMemo: H5pLibraryStoreManifest | null = null;
function storeManifest(): H5pLibraryStoreManifest {
  if (!storeManifestMemo) storeManifestMemo = openH5pLibraryStore(CURSIA_H5P_PROFILE_V2).manifest;
  return storeManifestMemo;
}

const ACTIVITY_MAIN_LIBRARY: Record<string, string> = {
  questionset: 'H5P.QuestionSet',
  dragtext: 'H5P.DragText',
  blanks: 'H5P.Blanks',
  singlechoiceset: 'H5P.SingleChoiceSet',
  // EV6 H5P v2 (solo Manifests con activityTypeRules=2 lo declaran en facts).
  branchingscenario: 'H5P.BranchingScenario',
};

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
  quiz: { attempts_number: string; completionattemptsexhausted: string; feedbacks: Array<{ text: string; min: number; max: number }> } & Record<keyof typeof QUIZ_REVIEW_V3, string> | null;
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
  const files: ParsedFile[] = blocks(filesXml, 'file').map((b) => ({
    id: num(/<file id="(\d+)"/.exec(b)?.[1]),
    hash: tag(b, 'contenthash') ?? '',
    ctx: num(tag(b, 'contextid')),
    component: tag(b, 'component') ?? '',
    filearea: tag(b, 'filearea') ?? '',
    filename: unxml(tag(b, 'filename') ?? ''),
    size: num(tag(b, 'filesize')),
    itemid: num(tag(b, 'itemid')),
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
    for (const k of ['idnumber', 'completion', 'completiongradeitemnumber', 'completionpassgrade', 'completionview', 'sectionnumber', 'visible']) {
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
            feedbacks: [...actXml.matchAll(/<feedback id="\d+">([\s\S]*?)<\/feedback>/g)].map((m) => ({
              text: unxml(tag(m[1], 'feedbacktext') ?? ''), min: Number(tag(m[1], 'mingrade')), max: Number(tag(m[1], 'maxgrade')),
            })),
            ...(Object.fromEntries(Object.keys(QUIZ_REVIEW_V3).map((k) => [k, tag(actXml, k) ?? ''])) as Record<keyof typeof QUIZ_REVIEW_V3, string>),
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
    if (/^cv3:shell:(forum|welcome|audio_welcome|competencies|methodology|start)$/.test(idn)) return 0;
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
    if (md.completion !== '2' || md.completiongradeitemnumber !== '0' || md.completionpassgrade !== '1') {
      add('COMPLETION', a.dir, `completion ${md.completion}/${md.completiongradeitemnumber}/${md.completionpassgrade} ≠ 2/0/1`);
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
      const wantExhausted = Number(q.attempts_number) > 0 ? '1' : '0';
      if (q.completionattemptsexhausted !== wantExhausted) {
        add('QUIZ_COMPLETION', a.dir, `completionattemptsexhausted ${q.completionattemptsexhausted} ≠ ${wantExhausted} (attempts_number ${q.attempts_number})`);
      }
    }
  }
  // F1 (I3): en un curso sin nota el Libro Guía se completa por vista (criterio del curso); el resto, 0.
  const viewCompletion = (a: ParsedActivity) => resolved.withoutGrades === true && a.modname === 'resource' && a.idnumber === 'cv3:shell:libro';
  for (const a of acts.filter((x) => !GRADED.has(x.modname))) {
    if (viewCompletion(a)) {
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
  if (resolved.withoutGrades === true && gradedActs.length > 0) add('STRUCTURE', 'graded', `curso sin nota con ${gradedActs.length} ítem(s) calificable(s)`);
  const practice = gradedActs.filter((g) => g.kind === 'activity' || g.kind === 'video').length;
  const expectedPractice = facts.counts.activities + facts.counts.videos;
  if (practice !== expectedPractice) add('STRUCTURE', 'graded', `ítems de práctica ${practice} ≠ facts ${expectedPractice}`);
  if (gradedActs.filter((g) => g.kind === 'exam').length !== facts.counts.exams) add('STRUCTURE', 'graded', 'cantidad de exámenes de módulo ≠ facts');
  if (gradedActs.filter((g) => g.kind === 'finalExam').length !== (facts.finalExam.enabled ? 1 : 0)) add('STRUCTURE', 'graded', 'examen final ≠ facts');

  // ── completion del curso ──
  const comp = (await text('completion.xml')) ?? '';
  const crit = blocks(comp, 'course_completion_criteria').map((b) => ({ type: num(tag(b, 'criteriatype')), mi: num(tag(b, 'moduleinstance')), gp: tag(b, 'gradepass') }));
  const wantCrit = resolved.withoutGrades === true
    ? acts.filter(viewCompletion).map((a) => a.mid)
    : completionCriteriaFor(gradedActs.map((g) => ({ moduleId: g.a.mid, modname: g.a.modname as 'quiz', kind: g.kind })), resolved.courseCompletion)
      .map((c) => c.moduleId);
  if (resolved.withoutGrades === true && wantCrit.length !== 1) add('COURSE_COMPLETION', 'completion.xml', `curso sin nota: se esperaba el Libro Guía como criterio (hay ${wantCrit.length})`);
  const gotCrit = crit.filter((c) => c.type === 4).map((c) => c.mi);
  if (JSON.stringify(gotCrit) !== JSON.stringify(wantCrit)) add('COURSE_COMPLETION', 'completion.xml', `criterios ${gotCrit.join(',')} ≠ ${wantCrit.join(',')}`);
  const gradeCrit = crit.filter((c) => c.type === 6);
  if (resolved.courseCompletion.requireCourseGradePass !== (gradeCrit.length === 1)) add('COURSE_COMPLETION', 'completion.xml', 'criterio de nota del curso incoherente con el perfil');
  if (gradeCrit.length === 1 && num(gradeCrit[0].gp) !== resolved.courseGradepass) add('COURSE_COMPLETION', 'completion.xml', 'gradepass del criterio de curso ≠ perfil');

  const backupCourseId = num(tag(mb, 'original_course_id'));
  const backupCourseCtx = num(tag(mb, 'original_course_contextid'));
  // Fix 0b: el ÚNICO módulo oculto del paquete es el label para docentes del certificado (si hay insignia).
  // EV6 P2-B4: sin insignia, el único oculto posible es la nota para docentes de las evaluaciones.
  const checkHidden = (allowed: string | null): void => {
    for (const a of acts) {
      if (a.module.visible === '1') continue;
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
    if (!t.includes(withCertificate ? EXAMS_TEACHER_NOTE : EXAMS_TEACHER_NOTE_ATTEMPTS)) add('TEACHER_NOTE', h.idnumber, 'la nota para docentes no trae las dos oraciones (acceso condicional + intentos adicionales)');
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
    // Fix round 1 (review I1): descripción y panel nombran EXACTAMENTE los criterios reales.
    const critSet = new Set(gotCrit);
    const kindsReq = new Set(gradedActs.filter((g) => critSet.has(g.a.mid)).map((g) => g.kind));
    const req: CertificateRequirements = {
      activities: kindsReq.has('activity'),
      videos: kindsReq.has('video'),
      moduleExams: kindsReq.has('exam'),
      finalExam: kindsReq.has('finalExam'),
      courseGrade: gradeCrit.length > 0,
    };
    if (!req.finalExam) {
      // (el chequeo de completion de abajo también lo reporta) — el validador nunca lanza.
      add('CERTIFICATE', 'completion.xml', 'la insignia existe pero la evaluación final no es criterio de completion');
    } else {
      const wantDesc = courseBadgeDescription(safeActivityName(facts.course.title, 254), req);
      const desc = unxml(tag(b, 'description') ?? '');
      if (desc !== wantDesc) add('CERTIFICATE', W, `descripción «${desc}» ≠ criterios reales «${wantDesc}»`);
      const closingTxt = extractText(acts.find((a) => a.idnumber === 'cv3:shell:closing')?.intro ?? '');
      if (!closingTxt.includes(closingCertificateText(req))) add('CERTIFICATE', 'cv3:shell:closing', `el panel no enuncia los criterios reales: «${closingCertificateText(req)}»`);
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
    // Completion del curso: el examen final (si hay) es criterio y solo cuenta aprobado.
    const fin = gradedActs.find((g) => g.kind === 'finalExam');
    if (fin) {
      if (!gotCrit.includes(fin.a.mid)) add('CERTIFICATE', 'completion.xml', 'la evaluación final no es criterio de completion del curso');
      if (fin.a.module.completionpassgrade !== '1') add('CERTIFICATE', fin.a.dir, 'la evaluación final no exige nota aprobatoria (completionpassgrade)');
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
      return { video: ch.videoEnabled || ch.videoPendingNotice === true, activity: ch.activityEnabled, exam: !!mod?.examEnabled && last, final_exam: toFinal, presentation: true, other: false };
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
  // EV6 T5: video pendiente = sin actividad de video; el aviso existe si y solo si facts lo pide.
  for (const ch of facts.chapters) {
    const hasVideo = acts.some((a) => a.idnumber === `cv3:ch:${ch.id}:video`);
    const hasNotice = labels.some((a) => a.idnumber === `cv3:ch:${ch.id}:video_pending`);
    if (ch.videoPending === true && hasVideo) add('STRUCTURE', `cv3:ch:${ch.id}:video`, 'video pendiente (vista previa) empaquetado como actividad');
    if (hasNotice !== (ch.videoPendingNotice === true)) add('STRUCTURE', `cv3:ch:${ch.id}:video_pending`, `aviso de video pendiente ${hasNotice ? 'sin' : 'faltante con'} video pendiente mencionado`);
  }
  for (const a of acts) {
    if (`${a.intro}`.includes('cursia-cta://')) add('TOKEN_INVALID', a.idnumber, 'botón de navegación con marcador cursia-cta sin resolver');
    for (const m of `${a.intro}`.matchAll(/\$@([A-Z0-9_]+)(?:\*(\d+))?@\$/g)) {
      // Edu EV3: botón «Continuar con el módulo…» → sección del paquete (id de section.xml).
      if (m[1] === 'COURSESECTIONBYID') {
        if (!m[2] || !sectionIds.has(Number(m[2]))) add('TOKEN_INVALID', a.idnumber, `token ${m[0]} no resuelve a una sección del paquete`);
        continue;
      }
      // EV6 T3: página de insignias (certificado) del curso DEL BACKUP (decode rule 'course').
      if (m[1] === 'BADGESVIEWBYID') {
        if (!m[2] || Number(m[2]) !== backupCourseId) add('TOKEN_INVALID', a.idnumber, `token ${m[0]} no apunta al curso del backup (${backupCourseId})`);
        continue;
      }
      const kind = /^(.+)VIEWBYID$/.exec(m[1])?.[1]?.toLowerCase();
      const target = m[2] ? byMid.get(Number(m[2])) : undefined;
      if (!kind || !target || target.modname !== kind) add('TOKEN_INVALID', a.idnumber, `token ${m[0]} no resuelve a un ${kind ?? '?'} del paquete`);
    }
    for (const m of a.intro.matchAll(/@@PLUGINFILE@@\/([^"'?&<>\s]+)/g)) {
      const name = decodeURIComponent(m[1]);
      if (name.startsWith('..')) continue; // ruta del embed.php (se resuelve a wwwroot)
      const comp = a.modname === 'label' ? 'mod_label' : `mod_${a.modname}`;
      if (!files.some((f) => f.ctx === a.ctx && f.component === comp && f.filearea === 'intro' && f.filename === name)) {
        add('FILES_INTEGRITY', a.idnumber, `@@PLUGINFILE@@/${name} sin archivo en su filearea intro`);
      }
    }
  }

  // ── EV6 T3: certificado (insignia de curso nativa) ──
  await checkCertificate();

  // ── EV6 P2-B5: banco aleatorio, página gated, fugas de respuestas ──
  for (const i of examChecksV3(await readExamPackageV3(zip), { facts, examBankPlans: exp.examBankPlans })) add(i.code, i.where, i.message);

  // ── H5P ──
  const profileKeys = new Set(CURSIA_H5P_PROFILE_V1.libraries.map((l) => `${l.machineName} ${l.majorVersion}.${l.minorVersion}`));
  const mainKeys = new Set(Object.values(CURSIA_H5P_PROFILE_V1.mainLibraries).map((l) => l.machineName));
  // EV6 H5P v2: principales con delta bundling y su perfil.
  const bundledMains = new Set(profileBundledMainLibraries(CURSIA_H5P_PROFILE_V2));
  const v2ByDir = new Map(CURSIA_H5P_PROFILE_V2.libraries.map((l) => [h5pLibraryDirName(l), l]));
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
      // Solo el directorio central + h5p.json (+ library.json de cada carpeta si es bundled):
      // los JS/CSS/fuentes de las librerías nunca se inflan.
      const hz = await JSZip.loadAsync(blob);
      const names = Object.keys(hz.files).filter((n) => !hz.files[n].dir);
      const extra = names.filter((n) => n !== 'h5p.json' && !n.startsWith('content/'));
      const hjFile = hz.file('h5p.json');
      // Sin h5p.json: mismo hallazgo y mismo error que antes de H5P v2.
      if (!hjFile && extra.length) add('H5P_LIBRARIES', a.idnumber, `el paquete no es content-only: ${extra.slice(0, 3).join(', ')}`);
      const hj = JSON.parse(await hjFile!.async('string'));
      const bundled = bundledMains.has(hj.mainLibrary);
      if (!bundled) {
        if (extra.length) add('H5P_LIBRARIES', a.idnumber, `el paquete no es content-only: ${extra.slice(0, 3).join(', ')}`);
        if (!mainKeys.has(hj.mainLibrary)) add('H5P_LIBRARIES', a.idnumber, `librería principal fuera del perfil: ${hj.mainLibrary}`);
      } else {
        // Carpetas de librería del paquete == delta calculada (ni una de más ni de menos).
        const want = profileDeltaDirs(CURSIA_H5P_PROFILE_V2, hj.mainLibrary);
        const tops = [...new Set(extra.map((n) => n.split('/')[0]))].sort();
        const missingDirs = want.filter((d) => !tops.includes(d));
        const extraDirs = tops.filter((d) => !want.includes(d));
        if (missingDirs.length) add('H5P_LIBRARIES', a.idnumber, `faltan carpetas de librería del delta v2: ${missingDirs.slice(0, 5).join(', ')}`);
        if (extraDirs.length) add('H5P_LIBRARIES', a.idnumber, `carpetas fuera del delta v2 de ${hj.mainLibrary}: ${extraDirs.slice(0, 5).join(', ')}`);
        const storeLibs = new Map(storeManifest().libraries.map((l) => [l.dir, l]));
        for (const d of tops.filter((x) => want.includes(x))) {
          // Archivos de la carpeta == los del store (nombres; sha256 de library.json). Los JS/CSS no se inflan.
          const st = storeLibs.get(d);
          const inPkg = extra.filter((n) => n.startsWith(`${d}/`)).map((n) => n.slice(d.length + 1)).sort();
          // EV6 H5P v2 (H2, m-8): + el aviso LICENSE.txt que agrega buildBundledH5p (si el store no lo trae).
          const inStore = st
            ? [...st.files.map((f) => f.path), ...(st.files.some((f) => f.path === H5P_BUNDLE_LICENSE_NOTICE_FILE) ? [] : [H5P_BUNDLE_LICENSE_NOTICE_FILE])].sort()
            : [];
          const missingFiles = inStore.filter((f) => !inPkg.includes(f));
          const extraFiles = inPkg.filter((f) => !inStore.includes(f));
          if (missingFiles.length) add('H5P_LIBRARIES', a.idnumber, `${d}: faltan archivos del store: ${missingFiles.slice(0, 3).join(', ')}${missingFiles.length > 3 ? ` (+${missingFiles.length - 3})` : ''}`);
          if (extraFiles.length) add('H5P_LIBRARIES', a.idnumber, `${d}: archivos que no están en el store: ${extraFiles.slice(0, 3).join(', ')}${extraFiles.length > 3 ? ` (+${extraFiles.length - 3})` : ''}`);
          const lf = hz.file(`${d}/library.json`);
          if (!lf) {
            add('H5P_LIBRARIES', a.idnumber, `${d} sin library.json`);
            continue;
          }
          const ljBuf = await lf.async('nodebuffer');
          const ljStore = st?.files.find((f) => f.path === 'library.json');
          if (ljStore && createHash('sha256').update(ljBuf).digest('hex') !== ljStore.sha256) {
            add('H5P_LIBRARIES', a.idnumber, `${d}: library.json distinto del store (sha256)`);
          }
          const lj = JSON.parse(ljBuf.toString('utf8'));
          const ref = v2ByDir.get(d)!;
          if (lj.machineName !== ref.machineName || lj.majorVersion !== ref.majorVersion || lj.minorVersion !== ref.minorVersion || lj.patchVersion !== ref.patchVersion) {
            add('H5P_LIBRARIES', a.idnumber, `${d}: library.json ${lj.machineName} ${lj.majorVersion}.${lj.minorVersion}.${lj.patchVersion} ≠ perfil v2 ${ref.patchVersion}`);
          }
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
      // Fix round 1 (I-1): un paquete bundled solo puede declarar lo que el sitio ya tiene (perfil v1)
      // o lo que trae adentro (SU delta) — nunca otra librería de v2 que no viaja en el paquete.
      const allowedDeps = bundled
        ? new Set([...profileKeys, ...(CURSIA_H5P_PROFILE_V2.deltaByMain![hj.mainLibrary] || []).map((l) => `${l.machineName} ${l.majorVersion}.${l.minorVersion}`)])
        : profileKeys;
      for (const d of hj.preloadedDependencies ?? []) {
        const k = `${d.machineName} ${d.majorVersion}.${d.minorVersion}`;
        if (!allowedDeps.has(k)) {
          add('H5P_LIBRARIES', a.idnumber, bundled ? `dependencia ni en el perfil v1 ni en la delta de ${hj.mainLibrary}: ${k}` : `dependencia fuera del perfil: ${k}`);
        }
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
  const lf = libro ? files.find((f) => f.ctx === libro.ctx && f.component === 'mod_resource' && f.filearea === 'content') : undefined;
  const lhtml = lf ? await text(`files/${lf.hash.slice(0, 2)}/${lf.hash}`) : null;
  if (!lhtml) add('LIBRO', 'cv3:shell:libro', 'falta el Libro Guía');
  else {
    if (!/<\/html>\s*$/i.test(lhtml)) add('LIBRO', 'cv3:shell:libro', 'no cierra en </html>');
    if (!/<style>[\s\S]*@media print[\s\S]*<\/style>/i.test(lhtml)) add('LIBRO', 'cv3:shell:libro', 'sin <style> con CSS de impresión');
  }

  return {
    ok: issues.length === 0,
    issues,
    stats: { activities: acts.length, labels: labels.filter((a) => a.modname === 'label').length, graded: gradedActs.length, h5p: h5pActs.length, files: files.length },
  };
}
