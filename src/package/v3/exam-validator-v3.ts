/**
 * Cursia EV6 P2-B5 — chequeos de las evaluaciones que certifican (P2-design §1.3, §2.2, §4).
 *
 * Lee el `.mbz` ya armado (nunca el estado del builder) y devuelve hallazgos con estos códigos:
 *   QUIZ_RANDOM        banco: cada `question_set_reference` → una hoja existente del MISMO contexto
 *                      del quiz (`includesubcategories false`); por hoja #referencias = slots del plan
 *                      y #preguntas ≥ bankFloor; ninguna hoja con preguntas sin referencias; Σ maxmark
 *                      = 100; un quiz es todo fijo o todo aleatorio (y banco ⇔ facts dice banco).
 *   EXPLANATIONS_GATE  exactamente una página «Respuestas explicadas» por quiz, en su sección justo
 *                      después del quiz; availability BYTE-EXACTA según `attempts_number` del quiz
 *                      (> 0: e=1 | e=3; 0: solo e=1), show:false, downloadcontent 0, completion 0,
 *                      fuera de los criterios del curso, contenido no vacío y CLEAN_SAFE.
 *   ANSWER_LEAK        ninguna respuesta correcta (≥ 12 caracteres) ni explicación de un quiz aparece
 *                      en un label, en la intro de una actividad o en una página que no sea la
 *                      página «Respuestas explicadas» del MISMO quiz. Se compara por palabras
 *                      completas con la normalización del contrato B2 (`examTextContains`).
 *                      Excluido: el Libro Guía (el contenido enseñado reformula las respuestas
 *                      correctas; la regla de evidencia lo exige). Por la misma razón, en el texto
 *                      enseñado de los labels (capítulos, presentación del módulo, bienvenida…)
 *                      una respuesta correcta solo cuenta junto con su enunciado — ver
 *                      `answerLeakSurfaceKind`.
 * (TEACHER_NOTE vive en mbz-validator-v3.ts: depende del certificado.)
 *
 * Puro salvo el unzip en memoria; nunca lanza por un hallazgo.
 */
import * as JSZip from 'jszip';
import { extractText, lintCleanSafe } from '../../modules/visual-components';
import {
  CourseFacts,
  ExamQuestionType,
  bankFloor,
  examExplanationsAvailability,
  examTokens,
  normalizeExamText,
} from '../../modules/course-shell';

export interface ExamIssue {
  code: 'QUIZ_RANDOM' | 'EXPLANATIONS_GATE' | 'ANSWER_LEAK';
  where: string;
  message: string;
}

/** Hoja esperada de un quiz con banco, en el orden de categorías del builder. */
export interface ExamBankLeafPlan {
  /** Nombre de la categoría hoja (tal como la escribe el builder, sin escapar). */
  category: string;
  type: ExamQuestionType;
  slots: number;
}
/** Plan por quiz con banco: idnumber del quiz (`cv3:exam:<moduleId>` | `cv3:final_exam`) → hojas. */
export type ExamBankPlans = Record<string, ExamBankLeafPlan[]>;

/** Largo mínimo (caracteres, sin espacios extremos) de una respuesta correcta para contar como fuga. */
export const ANSWER_LEAK_MIN_CHARS = 12;
// Dónde se busca: labels (intro), intro de TODA actividad y páginas (intro + contenido) salvo la página
// gated del mismo quiz. Nunca: el archivo del Libro Guía (resource), los textos de las preguntas, los
// paquetes H5P/SCORM.

// ─── lectura ────────────────────────────────────────────────────────────────

export interface ExamPkgActivity {
  mid: number;
  sectionid: number;
  modname: string;
  dir: string;
  idnumber: string;
  ctx: number;
  /** HTML decodificado de la intro (todas las actividades). */
  intro: string;
  /** Solo page: HTML decodificado de `<content>`. */
  content: string;
  module: Record<string, string>;
  /** XML crudo de `<modname>.xml`. */
  actXml: string;
  inforefCategories: number[];
}

export interface ExamPkgQuestion {
  qtype: string;
  name: string;
  stem: string;
  generalfeedback: string;
  /** Todo texto visible de la pregunta (enunciado, explicación, opciones, feedback, pares). */
  texts: string[];
  /** Texto plano de las respuestas (formato 1 → texto extraído del HTML). */
  answers: Array<{ text: string; fraction: number }>;
}

export interface ExamPkgCategory {
  id: number;
  name: string;
  contextid: number;
  contextlevel: number;
  contextinstanceid: number;
  parent: number;
  sortorder: number;
  questions: ExamPkgQuestion[];
}

export interface ExamPkg {
  acts: ExamPkgActivity[];
  /** número de sección → sequence (moduleids). */
  sequences: Map<number, number[]>;
  categories: ExamPkgCategory[];
  /** moduleinstance de los criterios de actividad (criteriatype 4) del curso. */
  courseCriteria: number[];
  /** Títulos de la estructura legibles del paquete: nombre del curso, secciones, quizzes y páginas. */
  titles: string[];
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
}
function unxml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function blocks(xml: string, name: string): string[] {
  return Array.from(xml.matchAll(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}>`, 'g')), (m) => m[0]);
}
const num = (v: string | null | undefined): number => (v === null || v === undefined || v === '' ? NaN : Number(v));
/** Texto de un campo de pregunta según su formato (1 = HTML). */
const fieldText = (raw: string, format: string | null): string => (format === '1' ? extractText(unxml(raw)) : unxml(raw));

const MODULE_KEYS = ['idnumber', 'visible', 'completion', 'availability', 'downloadcontent', 'showdescription'];

export async function readExamPackageV3(zip: JSZip): Promise<ExamPkg> {
  const text = async (p: string): Promise<string> => (zip.file(p) ? zip.file(p)!.async('string') : '');
  const mb = await text('moodle_backup.xml');
  const contents = tag(mb, 'contents') ?? '';
  const acts: ExamPkgActivity[] = [];
  for (const b of blocks(tag(contents, 'activities') ?? '', 'activity')) {
    const modname = tag(b, 'modulename') ?? '';
    const dir = tag(b, 'directory') ?? '';
    const moduleXml = await text(`${dir}/module.xml`);
    const actXml = await text(`${dir}/${modname}.xml`);
    const module: Record<string, string> = {};
    for (const k of MODULE_KEYS) module[k] = tag(moduleXml, k) ?? '';
    const inf = await text(`${dir}/inforef.xml`);
    acts.push({
      mid: num(tag(b, 'moduleid')),
      sectionid: num(tag(b, 'sectionid')),
      modname,
      dir,
      idnumber: unxml(module.idnumber),
      ctx: num(/contextid="(\d+)"/.exec(actXml)?.[1]),
      intro: unxml(tag(actXml, 'intro') ?? ''),
      content: modname === 'page' ? unxml(tag(actXml, 'content') ?? '') : '',
      module,
      actXml,
      inforefCategories: Array.from((tag(inf, 'question_categoryref') ?? '').matchAll(/<id>(\d+)<\/id>/g), (m) => Number(m[1])),
    });
  }
  const sequences = new Map<number, number[]>();
  const titles: string[] = [];
  for (const b of blocks(tag(contents, 'sections') ?? '', 'section')) {
    const sx = await text(`${tag(b, 'directory') ?? ''}/section.xml`);
    sequences.set(num(tag(sx, 'number')), (tag(sx, 'sequence') ?? '').split(',').filter(Boolean).map(Number));
    titles.push(unxml(tag(sx, 'name') ?? ''));
  }
  titles.push(unxml(tag(await text('course/course.xml'), 'fullname') ?? ''));
  for (const a of acts) if (a.modname === 'quiz' || a.modname === 'page') titles.push(unxml(tag(a.actXml, 'name') ?? ''));
  const qx = await text('questions.xml');
  const categories: ExamPkgCategory[] = blocks(qx, 'question_category').map((c) => ({
    id: num(/<question_category id="(\d+)"/.exec(c)?.[1]),
    name: unxml(tag(c, 'name') ?? ''),
    contextid: num(tag(c, 'contextid')),
    contextlevel: num(tag(c, 'contextlevel')),
    contextinstanceid: num(tag(c, 'contextinstanceid')),
    parent: num(tag(c, 'parent')),
    sortorder: num(tag(c, 'sortorder')),
    questions: blocks(c, 'question').map((q) => {
      const answerBlocks = blocks(q, 'answer');
      const answers = answerBlocks.map((a) => ({ text: fieldText(tag(a, 'answertext') ?? '', tag(a, 'answerformat')), fraction: num(tag(a, 'fraction')) }));
      // Solo el bloque del enunciado: el primer <questiontext> (los <match> traen el suyo después).
      const stem = fieldText(tag(q, 'questiontext') ?? '', tag(q, 'questiontextformat'));
      const generalfeedback = fieldText(tag(q, 'generalfeedback') ?? '', tag(q, 'generalfeedbackformat'));
      const texts = [
        stem,
        generalfeedback,
        ...answers.map((a) => a.text),
        ...answerBlocks.map((a) => fieldText(tag(a, 'feedback') ?? '', tag(a, 'feedbackformat'))),
        ...blocks(q, 'match').flatMap((m) => [fieldText(tag(m, 'questiontext') ?? '', tag(m, 'questiontextformat')), unxml(tag(m, 'answertext') ?? '')]),
      ].filter((t) => t.trim());
      return { qtype: tag(q, 'qtype') ?? '', name: unxml(tag(q, 'name') ?? ''), stem, generalfeedback, texts, answers };
    }),
  }));
  const comp = await text('completion.xml');
  const courseCriteria = blocks(comp, 'course_completion_criteria')
    .filter((c) => num(tag(c, 'criteriatype')) === 4)
    .map((c) => num(tag(c, 'moduleinstance')));
  return { acts, sequences, categories, courseCriteria, titles: titles.filter((t) => t.trim()) };
}

// ─── chequeos ───────────────────────────────────────────────────────────────

/** La página «Respuestas explicadas» que corresponde a un quiz (por idnumber). */
export function explanationsIdnumberFor(quizIdnumber: string): string | null {
  if (quizIdnumber === 'cv3:final_exam') return 'cv3:final_exam_explanations';
  const m = /^cv3:exam:(.+)$/.exec(quizIdnumber);
  return m ? `cv3:exam_explanations:${m[1]}` : null;
}

/** maxmark → unidades de 1e-7 (exactas para los 7 decimales que escribe el builder). */
const markUnits = (s: string): number => Math.round(Number(s) * 1e7);

export interface ExamCheckOptions {
  /** Facts del paquete: si están, banco ⇔ `examBankSize`/`finalExam.bankSize` definido. */
  facts?: CourseFacts;
  /** Plan por hoja (expectativa del builder); sin él se exige solo la coherencia interna. */
  examBankPlans?: ExamBankPlans;
}

export function examChecksV3(pkg: ExamPkg, opts: ExamCheckOptions = {}): ExamIssue[] {
  const titles = opts.facts ? [opts.facts.course.title, ...opts.facts.modules.map((m) => m.title), ...opts.facts.chapters.map((c) => c.title)] : [];
  return [...quizRandomIssues(pkg, opts), ...explanationsGateIssues(pkg), ...answerLeakIssues(pkg, { titles })];
}

const quizzesOf = (pkg: ExamPkg): ExamPkgActivity[] => pkg.acts.filter((a) => a.modname === 'quiz');

export function quizRandomIssues(pkg: ExamPkg, opts: ExamCheckOptions = {}): ExamIssue[] {
  const out: ExamIssue[] = [];
  const add = (where: string, message: string) => out.push({ code: 'QUIZ_RANDOM', where, message });
  const catById = new Map(pkg.categories.map((c) => [c.id, c]));
  const children = new Map<number, number>();
  for (const c of pkg.categories) children.set(c.parent, (children.get(c.parent) ?? 0) + 1);
  for (const q of quizzesOf(pkg)) {
    const W = q.idnumber || q.dir;
    const instances = blocks(tag(q.actXml, 'question_instances') ?? '', 'question_instance');
    const random = instances.filter((i) => /<question_set_reference\b/.test(i));
    const fixed = instances.filter((i) => /<question_reference\b/.test(i));
    if (instances.length === 0) add(W, 'el quiz no tiene slots');
    if (random.length && fixed.length) add(W, `mezcla ${fixed.length} slot(s) fijos y ${random.length} aleatorio(s): un quiz es todo fijo o todo aleatorio`);
    if (instances.some((i) => /<question_set_reference\b/.test(i) === /<question_reference\b/.test(i))) add(W, 'un slot sin referencia (o con dos)');
    // Σ maxmark = 100 (unidades de 1e-7).
    const sum = instances.reduce((a, i) => a + markUnits(tag(i, 'maxmark') ?? 'NaN'), 0);
    if (sum !== 1e9) add(W, `Σ maxmark = ${sum / 1e7} ≠ 100`);
    // Banco según facts.
    const f = opts.facts;
    if (f) {
      const modId = /^cv3:exam:(.+)$/.exec(q.idnumber)?.[1];
      const bankSize = q.idnumber === 'cv3:final_exam' ? f.finalExam.bankSize : modId ? f.modules.find((m) => m.id === modId)?.examBankSize : undefined;
      const wantBank = bankSize !== undefined;
      if (wantBank && fixed.length) add(W, `facts dice banco (${bankSize} preguntas) y el quiz tiene ${fixed.length} slot(s) fijos`);
      if (!wantBank && random.length) add(W, `facts dice GIFT (preguntas fijas) y el quiz tiene ${random.length} slot(s) aleatorios`);
      if (wantBank) {
        const entries = pkg.categories.filter((c) => c.contextinstanceid === q.mid).reduce((a, c) => a + c.questions.length, 0);
        if (entries !== bankSize) add(W, `${entries} preguntas en las categorías del quiz ≠ banco de facts ${bankSize}`);
      }
    }
    if (!random.length) continue;
    // Cada referencia → hoja del MISMO contexto del quiz.
    const refsByLeaf = new Map<number, number>();
    random.forEach((inst, k) => {
      const where = `${W} slot ${tag(inst, 'slot') ?? k + 1}`;
      const ref = blocks(inst, 'question_set_reference')[0] ?? '';
      if (num(tag(ref, 'usingcontextid')) !== q.ctx || num(tag(ref, 'questionscontextid')) !== q.ctx) {
        add(where, `contextos ${tag(ref, 'usingcontextid')}/${tag(ref, 'questionscontextid')} ≠ contexto del quiz ${q.ctx}`);
      }
      if (tag(ref, 'component') !== 'mod_quiz' || tag(ref, 'questionarea') !== 'slot') add(where, 'component/questionarea ≠ mod_quiz/slot');
      let fc: unknown;
      try {
        fc = JSON.parse(unxml(tag(ref, 'filtercondition') ?? ''));
      } catch {
        add(where, 'filtercondition no es JSON');
        return;
      }
      const cat = (fc as { filter?: { category?: { jointype?: unknown; values?: unknown; filteroptions?: { includesubcategories?: unknown } } } })?.filter?.category;
      const values = Array.isArray(cat?.values) ? (cat!.values as unknown[]) : [];
      const id = values.length === 1 ? Number(values[0]) : NaN;
      const exact = JSON.stringify({ filter: { category: { jointype: 1, values: [id], filteroptions: { includesubcategories: false } } } });
      if (JSON.stringify(fc) !== exact) {
        add(where, `filtercondition ${JSON.stringify(fc)} ≠ una sola categoría con includesubcategories false`);
        if (!Number.isInteger(id)) return;
      }
      const c = catById.get(id);
      if (!c) return add(where, `la categoría ${id} no existe en questions.xml`);
      if (c.contextid !== q.ctx || c.contextlevel !== 70 || c.contextinstanceid !== q.mid) add(where, `la categoría ${id} no está en el contexto del quiz (ctx ${c.contextid}, nivel ${c.contextlevel}, instancia ${c.contextinstanceid})`);
      if (children.get(id)) add(where, `la categoría ${id} «${c.name}» no es hoja`);
      if (!q.inforefCategories.includes(id)) add(where, `la categoría ${id} no está en el inforef del quiz`);
      refsByLeaf.set(id, (refsByLeaf.get(id) ?? 0) + 1);
    });
    for (const [id, refs] of refsByLeaf) {
      const c = catById.get(id);
      if (c && c.questions.length < bankFloor(refs)) add(W, `hoja «${c.name}»: ${c.questions.length} preguntas < mínimo ${bankFloor(refs)} para ${refs} slot(s)`);
    }
    for (const c of pkg.categories.filter((x) => x.contextinstanceid === q.mid && x.questions.length > 0)) {
      if (!refsByLeaf.has(c.id)) add(W, `hoja «${c.name}» con ${c.questions.length} preguntas y ninguna referencia (nadie la sortea)`);
    }
    // Hojas = plan (si el builder lo declaró).
    const plan = opts.examBankPlans?.[q.idnumber];
    if (opts.examBankPlans && !plan) add(W, 'quiz con banco sin plan en las expectativas');
    if (plan) {
      const got = [...refsByLeaf].map(([id, refs]) => [catById.get(id)?.name ?? `#${id}`, refs] as [string, number]).sort((a, b) => a[0].localeCompare(b[0]));
      const want = plan.map((l) => [l.category, l.slots] as [string, number]).sort((a, b) => a[0].localeCompare(b[0]));
      if (JSON.stringify(got) !== JSON.stringify(want)) add(W, `referencias por hoja ${JSON.stringify(got)} ≠ plan ${JSON.stringify(want)}`);
      for (const l of plan) {
        const c = pkg.categories.find((x) => x.contextinstanceid === q.mid && x.name === l.category);
        if (c && c.questions.some((x) => x.qtype !== l.type)) add(W, `hoja «${l.category}» con preguntas de otro tipo que ${l.type}`);
      }
    }
  }
  return out;
}

export function explanationsGateIssues(pkg: ExamPkg): ExamIssue[] {
  const out: ExamIssue[] = [];
  const add = (where: string, message: string) => out.push({ code: 'EXPLANATIONS_GATE', where, message });
  const pages = pkg.acts.filter((a) => a.modname === 'page');
  const claimed = new Set<ExamPkgActivity>();
  for (const q of quizzesOf(pkg)) {
    const W = q.idnumber || q.dir;
    const want = explanationsIdnumberFor(q.idnumber);
    const mine = pages.filter((p) => p.idnumber === want);
    // También cuenta como «suya» cualquier página cuya availability apunta a este quiz.
    const pointing = pages.filter((p) => p.idnumber !== want && new RegExp(`"cm":${q.mid}\\b`).test(p.module.availability));
    for (const p of pointing) add(p.idnumber || p.dir, `página gated por ${W} que no es su página de respuestas explicadas`);
    if (mine.length !== 1) {
      add(W, `se esperaba exactamente una página «Respuestas explicadas» (${want}), hay ${mine.length}`);
      mine.forEach((p) => claimed.add(p));
      continue;
    }
    const p = mine[0];
    claimed.add(p);
    const P = p.idnumber;
    if (p.sectionid !== q.sectionid) add(P, `en la sección ${p.sectionid}, el quiz en la ${q.sectionid}`);
    const seq = pkg.sequences.get(q.sectionid) ?? [];
    const qi = seq.indexOf(q.mid);
    if (qi < 0 || seq[qi + 1] !== p.mid) add(P, `no va justo después del quiz en la secuencia de la sección (${seq.join(',')})`);
    const attempts = Number(tag(q.actXml, 'attempts_number'));
    let wantAvail = '';
    try {
      wantAvail = examExplanationsAvailability(q.mid, attempts);
    } catch (err) {
      add(W, `attempts_number inválido (${tag(q.actXml, 'attempts_number')})`);
    }
    if (wantAvail && p.module.availability !== wantAvail) add(P, `availability ${p.module.availability || '(vacía)'} ≠ ${wantAvail} (attempts_number ${attempts})`);
    if (p.module.downloadcontent !== '0') add(P, `downloadcontent ${p.module.downloadcontent} ≠ 0`);
    if (p.module.completion !== '0') add(P, `completion ${p.module.completion} ≠ 0`);
    if (p.module.visible !== '1') add(P, `visible ${p.module.visible} ≠ 1 (la oculta availability con show:false, no visible=0)`);
    if (pkg.courseCriteria.includes(p.mid)) add(P, 'la página es criterio de completion del curso');
    if (!extractText(p.content).trim()) add(P, 'contenido vacío');
    else {
      const lint = lintCleanSafe(p.content);
      if (!lint.ok) add(P, `CLEAN_SAFE: ${lint.errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join('; ')}`);
    }
  }
  for (const p of pages) {
    if (claimed.has(p)) continue;
    if (/^cv3:(exam_explanations:|final_exam_explanations$)/.test(p.idnumber)) add(p.idnumber, 'página de respuestas explicadas sin su quiz');
  }
  return out;
}

// ─── ANSWER_LEAK ────────────────────────────────────────────────────────────

type SurfaceKind = 'teaching' | 'deterministic' | 'gated';

/**
 * Clase de cada superficie donde se busca (Libro Guía: nunca se lee).
 *  - teaching: texto ENSEÑADO o del LLM del curso (labels de capítulo salvo la tarjeta de
 *    presentación, presentación del módulo, bienvenida, competencias, metodología, cierre). Ahí las
 *    respuestas correctas aparecen legítimamente (la regla de evidencia lo exige, como en el Libro):
 *    solo cuenta una respuesta correcta JUNTO con su enunciado (el par pregunta→respuesta) o una
 *    explicación completa.
 *  - gated: página «Respuestas explicadas» de OTRO quiz: muestra el material de su propio quiz; una
 *    cadena que ese material ya contiene (p. ej. la misma respuesta correcta en el examen final y en
 *    el de módulo) no es fuga.
 *  - deterministic: el resto (labels armados con facts y títulos, intros de actividades, otras
 *    páginas): cualquier respuesta correcta o explicación es fuga, salvo que la respuesta sea parte
 *    de un título de la estructura (curso, módulo, capítulo, sección), que esos labels imprimen.
 */
export function answerLeakSurfaceKind(a: Pick<ExamPkgActivity, 'idnumber' | 'modname'>): SurfaceKind {
  if (a.modname === 'page' && /^cv3:(exam_explanations:|final_exam_explanations$)/.test(a.idnumber)) return 'gated';
  if (/^cv3:ch:[^:]+:/.test(a.idnumber) && !/:presentation$/.test(a.idnumber)) return 'teaching';
  if (/^cv3:module_intro:/.test(a.idnumber) || /^cv3:shell:(welcome|competencies|methodology|closing)$/.test(a.idnumber)) return 'teaching';
  return 'deterministic';
}

interface Needle {
  quiz: ExamPkgActivity;
  kind: 'respuesta correcta' | 'explicación';
  question: string;
  text: string;
  tokens: string[];
  /** Solo respuesta correcta: tokens del enunciado de su pregunta. */
  stem: string[];
}

const toks = (s: string): string[] => examTokens(normalizeExamText(s));

/** Respuestas correctas (≥ 12 caracteres) y explicaciones de cada quiz del paquete. */
export function answerLeakNeedles(pkg: ExamPkg): Needle[] {
  const out: Needle[] = [];
  for (const q of quizzesOf(pkg)) {
    for (const c of pkg.categories.filter((x) => x.contextinstanceid === q.mid)) {
      for (const qq of c.questions) {
        const stem = toks(qq.stem);
        const push = (kind: Needle['kind'], text: string) => {
          const t = text.trim();
          if ([...t].length < ANSWER_LEAK_MIN_CHARS) return;
          const tokens = toks(t);
          if (tokens.length) out.push({ quiz: q, kind, question: qq.name, text: t, tokens, stem });
        };
        // MC: la(s) opción(es) con fracción completa. (V/F: «Verdadero»/«Falso» < 12; emparejamiento: no aplica.)
        if (qq.qtype === 'multichoice') for (const a of qq.answers) if (a.fraction >= 0.9999999) push('respuesta correcta', a.text);
        push('explicación', qq.generalfeedback);
      }
    }
  }
  return out;
}

interface Hay {
  tokens: string[];
  idx: Map<string, number[]>;
}
function hay(text: string): Hay {
  const tokens = toks(text);
  const idx = new Map<string, number[]>();
  tokens.forEach((t, i) => {
    const l = idx.get(t);
    if (l) l.push(i);
    else idx.set(t, [i]);
  });
  return { tokens, idx };
}
/** ¿`needle` es una secuencia contigua de tokens de `h`? (= `examTextContains`, con índice). */
function contains(h: Hay, needle: string[]): boolean {
  if (!needle.length || needle.length > h.tokens.length) return false;
  for (const k of h.idx.get(needle[0]) ?? []) {
    if (k + needle.length > h.tokens.length) break;
    let ok = true;
    for (let j = 1; j < needle.length; j++) {
      if (h.tokens[k + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export interface AnswerLeakOptions {
  /** Títulos de la estructura (curso, módulos, capítulos); se suman a los del paquete. */
  titles?: string[];
}

export function answerLeakIssues(pkg: ExamPkg, opts: AnswerLeakOptions = {}): ExamIssue[] {
  const out: ExamIssue[] = [];
  const needles = answerLeakNeedles(pkg);
  if (!needles.length) return out;
  const quizByPage = new Map<number, ExamPkgActivity>(); // mid de la página gated → su quiz
  for (const q of quizzesOf(pkg)) {
    const p = pkg.acts.find((a) => a.modname === 'page' && a.idnumber === explanationsIdnumberFor(q.idnumber));
    if (p) quizByPage.set(p.mid, q);
  }
  // Material propio de cada quiz (todo texto de sus preguntas), para las páginas gated de otro quiz.
  const material = new Map<number, Hay[]>();
  for (const q of quizzesOf(pkg)) {
    material.set(q.mid, pkg.categories.filter((c) => c.contextinstanceid === q.mid).flatMap((c) => c.questions.flatMap((x) => x.texts.map(hay))));
  }
  const titles = [...pkg.titles, ...(opts.titles ?? [])].map(hay);
  const isTitle = (n: Needle): boolean => titles.some((t) => contains(t, n.tokens));
  const hays = pkg.acts.map((a) => ({ a, kind: answerLeakSurfaceKind(a), h: hay(`${extractText(a.intro)} ${a.modname === 'page' ? extractText(a.content) : ''}`) }));
  for (const n of needles) {
    for (const { a, kind, h } of hays) {
      let leak = false;
      if (kind === 'gated') {
        const owner = quizByPage.get(a.mid);
        if (owner?.mid === n.quiz.mid) continue; // su propia página
        leak = contains(h, n.tokens) && !(owner && (material.get(owner.mid) ?? []).some((m) => contains(m, n.tokens)));
      } else if (kind === 'teaching') {
        leak = contains(h, n.tokens) && (n.kind === 'explicación' || contains(h, n.stem));
      } else {
        leak = contains(h, n.tokens) && (n.kind === 'explicación' || !isTitle(n));
      }
      if (leak) {
        out.push({
          code: 'ANSWER_LEAK',
          where: a.idnumber || a.dir,
          message: `${n.kind}${kind === 'teaching' && n.kind !== 'explicación' ? ' (con su enunciado)' : ''} de ${n.question} (${n.quiz.idnumber}) visible fuera de su página gated: «${n.text.slice(0, 80)}${n.text.length > 80 ? '…' : ''}»`,
        });
      }
    }
  }
  return out;
}

/** Atajo para corpus/scripts: lee el .mbz y corre solo ANSWER_LEAK (no necesita facts). */
export async function scanAnswerLeaksV3(mbz: Buffer, opts: AnswerLeakOptions = {}): Promise<{ needles: number; issues: ExamIssue[] }> {
  const pkg = await readExamPackageV3(await JSZip.loadAsync(mbz));
  return { needles: answerLeakNeedles(pkg).length, issues: answerLeakIssues(pkg, opts) };
}
