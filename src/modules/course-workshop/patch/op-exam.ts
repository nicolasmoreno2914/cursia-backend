/**
 * r107 B4 · `exam_question_replace` / `exam_question_add` / `exam_question_remove` — preguntas de un examen sobre
 * questions.xml y las ranuras (`question_instances`) del quiz.xml.
 *
 * Formatos (los de los builders y de Moodle):
 *   - Moodle 4.x (4.1 / 4.5): banco con `question_bank_entry` → `question_versions` → `question`. Ranura FIJA =
 *     `question_reference` (entrada + versión, `$@NULL@$` = la última); ranura ALEATORIA = `question_set_reference`
 *     (sortea de una categoría, `filtercondition`). Se edita SIEMPRE la versión que usa la ranura (la que eligió el
 *     inventario de B2).
 *   - Moodle 3.x: `<question>` directo en la categoría; la ranura nombra `<questionid>`.
 * Invariantes: opción múltiple de una respuesta con EXACTAMENTE una opción al 100 % (y el resto ≤ 0); varias respuestas
 * con fracciones positivas que suman 1; fracciones de la lista de Moodle; sin «todas / ninguna de las anteriores»; ids
 * nuevos únicos en todo el paquete; quitar nunca deja el examen sin ranuras (mínimo 1: el inventario no conoce otro) ni
 * una ranura aleatoria con menos preguntas en su categoría que las que sortea; `sumgrades` = Σ maxmark de las ranuras
 * (la nota máxima `grade` no cambia: Moodle escala).
 */
import { EXAM_OPTION_FORBIDDEN_RE, normalizeExamText } from '../../course-shell/exam-bank';
import { WorkshopActivity, plainText } from '../course-model';
import { sha1Of } from './container';
import { validateNewHtml, xmlEsc } from './html-edit';
import { OpContext, blobPath, noteModified, setTag } from './op-context';
import { ExamQuestionAddOp, ExamQuestionRemoveOp, ExamQuestionReplaceOp, NewQuestion, PatchError } from './types';
import { matchBlocks } from '../xml-scan';

/** question_bank::fraction_options_full() de Moodle (y sus negativos). */
const FRACTIONS = [1, 0.9, 0.8333333, 0.8, 0.75, 0.7, 0.6666667, 0.6, 0.5, 0.4, 0.3333333, 0.3, 0.25, 0.2, 0.1666667, 0.1428571, 0.125, 0.1111111, 0.1, 0.05, 0];
const validFraction = (f: number) => Number.isFinite(f) && FRACTIONS.some((o) => Math.abs(Math.abs(f) - o) < 1e-6);
const fr = (f: number) => f.toFixed(7);

interface Slot {
  start: number; end: number; block: string; id: number; slot: number; page: number; maxmark: number;
  kind: 'fixed' | 'random' | 'legacy'; entryId: number | null; version: number | null; questionId: number | null;
  categoryId: number | null; includeSub: boolean;
}
interface QuizXml { entry: string; xml: string; slots: Slot[]; instStart: number; instEnd: number; qpp: number; quizId: number | null; ctxId: number | null }

/**
 * Categoría (y subcategorías) que sortea una ranura aleatoria. Dos formatos de `filtercondition`:
 *   Moodle 4.1/4.2: `{"questioncategoryid":N,"includingsubcategories":0}`;
 *   Moodle 4.3+:    `{"filter":{"category":{"jointype":1,"values":[N],"filteroptions":{"includesubcategories":false}}}}`.
 * Si no se reconoce, la ranura queda sin categoría y las operaciones que dependen de ella fallan con motivo.
 */
export function randomFilter(filter: string): { categoryId: number | null; includeSub: boolean } {
  let j: Record<string, any> | null = null;
  try { j = JSON.parse(filter); } catch { j = null; }
  const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
  if (j && typeof j === 'object') {
    const cat = j.filter?.category;
    const id = Number(j.questioncategoryid ?? (Array.isArray(cat?.values) ? cat.values[0] : NaN));
    if (Number.isInteger(id) && id > 0) return { categoryId: id, includeSub: truthy(j.includingsubcategories ?? cat?.filteroptions?.includesubcategories) };
  }
  const m = /"questioncategoryid"\s*:\s*(\d+)/.exec(filter);
  return { categoryId: m ? Number(m[1]) : null, includeSub: /"includ(?:ing|e)subcategories"\s*:\s*(1|true)/.test(filter) };
}

function parseQuiz(entry: string, xml: string): QuizXml {
  const open = xml.indexOf('<question_instances>');
  const close = xml.indexOf('</question_instances>');
  if (open < 0 || close < 0) throw new PatchError('unsupported', `${entry}: sin <question_instances>.`);
  const slots: Slot[] = [];
  for (const m of matchBlocks(xml, /<question_instance id="(\d+)">/, '</question_instance>', open)) {
    if (m.index >= close) break;
    const b = m[2];
    const g = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(b)?.[1] ?? null;
    const n = (t: string) => { const v = g(t); return v !== null && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null; };
    const fixed = /<question_reference\b/.test(b);
    const random = /<question_set_reference\b/.test(b);
    const filter = random ? (g('filtercondition') ?? '').replace(/&quot;/g, '"') : '';
    const rf = random ? randomFilter(filter) : { categoryId: null, includeSub: false };
    slots.push({
      start: m.index, end: m.index + m[0].length, block: m[0], id: Number(m[1]), slot: n('slot') ?? 0, page: n('page') ?? 1, maxmark: n('maxmark') ?? 1,
      kind: fixed ? 'fixed' : random ? 'random' : 'legacy', entryId: fixed ? n('questionbankentryid') : null, version: fixed ? n('version') : null,
      questionId: !fixed && !random ? n('questionid') : null,
      categoryId: rf.categoryId,
      includeSub: rf.includeSub,
    });
  }
  return {
    entry, xml, slots, instStart: open + '<question_instances>'.length, instEnd: close,
    qpp: Number(/<questionsperpage>(\d+)<\/questionsperpage>/.exec(xml)?.[1] ?? 0),
    quizId: Number(/<quiz id="(\d+)">/.exec(xml)?.[1] ?? NaN) || null,
    ctxId: Number(/<activity [^<>]*contextid="(\d+)"/.exec(xml)?.[1] ?? NaN) || null,
  };
}

/** Reescribe las ranuras (bloques en orden) + sumgrades + firstslot de las secciones del quiz. */
function writeSlots(q: QuizXml, blocks: string[], removedSlots: number[]): string {
  let xml = q.xml.slice(0, q.instStart) + '\n' + blocks.map((b) => `      ${b}\n`).join('') + '    ' + q.xml.slice(q.instEnd);
  const sum = blocks.reduce((s, b) => s + Number(/<maxmark>([^<]*)<\/maxmark>/.exec(b)?.[1] ?? 0), 0);
  xml = setTag(xml, 'sumgrades', sum.toFixed(5));
  if (removedSlots.length) {
    const sOpen = xml.indexOf('<sections>');
    const sClose = xml.indexOf('</sections>');
    if (sOpen >= 0 && sClose > sOpen) {
      const inner = xml.slice(sOpen + 10, sClose);
      const secs = matchBlocks(inner, /<section id="(\d+)">/, '</section>').map((m) => ({ id: m[1], body: m[2], first: Number(/<firstslot>(\d+)<\/firstslot>/.exec(m[2])?.[1] ?? 1) }));
      const total = blocks.length;
      const seen = new Set<number>();
      const out: string[] = [];
      for (const s of secs) {
        const nf = s.first - removedSlots.filter((r) => r < s.first).length;
        if (nf > total || seen.has(nf)) continue; // sección que quedó sin ranuras
        seen.add(nf);
        out.push(`<section id="${s.id}">${setTag(s.body, 'firstslot', String(Math.max(1, nf)))}</section>`);
      }
      if (!seen.has(1) && out.length) out[0] = out[0].replace(/<firstslot>\d+<\/firstslot>/, () => '<firstslot>1</firstslot>');
      xml = xml.slice(0, sOpen + 10) + out.join('') + xml.slice(sClose);
    }
  }
  return xml;
}

function renumber(blocks: string[], qpp: number): string[] {
  return blocks.map((b, i) => {
    let x = b.replace(/<slot>\d+<\/slot>/, () => `<slot>${i + 1}</slot>`);
    if (qpp > 0) x = x.replace(/<page>\d+<\/page>/, () => `<page>${Math.ceil((i + 1) / qpp)}</page>`);
    return x;
  });
}

// ─── Banco (questions.xml) ──────────────────────────────────────────────────

interface Cat { id: number; start: number; end: number; contextId: number | null; parent: number | null; modern: boolean; questionIds: number[]; entryIds: number[] }
function parseCats(xml: string): Cat[] {
  return matchBlocks(xml, /<question_category id="(\d+)">/, '</question_category>').map((m) => ({
    id: Number(m[1]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length,
    contextId: Number(/<contextid>(\d+)<\/contextid>/.exec(m[2])?.[1] ?? NaN) || null,
    parent: Number(/<parent>(\d+)<\/parent>/.exec(m[2])?.[1] ?? NaN) || null,
    modern: /<question_bank_entries>/.test(m[2]),
    questionIds: [...m[2].matchAll(/<question id="(\d+)">/g)].map((x) => Number(x[1])),
    entryIds: [...m[2].matchAll(/<question_bank_entry id="(\d+)">/g)].map((x) => Number(x[1])),
  }));
}
const descendants = (cats: Cat[], id: number): number[] => {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const c of cats) if (c.parent === out[i] && !out.includes(c.id)) out.push(c.id);
  return out;
};

function validateQuestion(ctx: OpContext, q: NewQuestion, where: string): void {
  if (!q || (q.qtype !== 'multichoice' && q.qtype !== 'truefalse')) throw new PatchError('unsupported', `Tipo de pregunta no soportado: ${(q as { qtype?: string })?.qtype}. Solo opción múltiple y verdadero/falso.`);
  if (typeof q.text !== 'string' || !plainText(q.text, 20)) throw new PatchError('invalid_content', `La pregunta de ${where} no tiene enunciado.`);
  const v = (h: string | undefined, w: string) => { if (h !== undefined) validateNewHtml(h, h, { tokenCtx: ctx.tokenCtx, oldHtml: '', files: [], where: `${where} (${w})` }); };
  v(q.text, 'enunciado'); v(q.generalFeedback, 'retroalimentación');
  if (q.qtype === 'truefalse') {
    if (typeof q.correct !== 'boolean') throw new PatchError('invalid_content', `Verdadero/falso de ${where} sin respuesta correcta.`);
    v(q.feedbackTrue, 'retroalimentación V'); v(q.feedbackFalse, 'retroalimentación F');
    return;
  }
  const single = q.single !== false;
  if (!Array.isArray(q.answers) || q.answers.length < 2) throw new PatchError('invalid_content', `La pregunta de ${where} necesita al menos 2 opciones.`);
  const norm = q.answers.map((a) => normalizeExamText(plainText(a?.html ?? '', 400)));
  norm.forEach((t, i) => {
    if (!t) throw new PatchError('invalid_content', `La opción ${i + 1} de ${where} está vacía.`);
    if (EXAM_OPTION_FORBIDDEN_RE.test(t)) throw new PatchError('invalid_content', `La opción «${plainText(q.answers[i].html, 60)}» de ${where} es del tipo «todas / ninguna de las anteriores»: Moodle baraja las opciones.`);
  });
  if (new Set(norm).size !== norm.length) throw new PatchError('invalid_content', `La pregunta de ${where} repite una opción.`);
  q.answers.forEach((a, i) => {
    if (!validFraction(a.fraction)) throw new PatchError('invalid_content', `La opción ${i + 1} de ${where} tiene una fracción que Moodle no acepta (${a.fraction}).`);
    v(a.html, `opción ${i + 1}`); v(a.feedback, `retroalimentación de la opción ${i + 1}`);
  });
  const full = q.answers.filter((a) => Math.abs(a.fraction - 1) < 1e-6).length;
  const pos = q.answers.filter((a) => a.fraction > 1e-9);
  if (single) {
    if (full !== 1 || pos.length !== 1) throw new PatchError('invalid_content', `La pregunta de ${where} es de una respuesta: tiene que tener exactamente UNA opción correcta (100 %) y el resto en 0 o negativo; tiene ${full} al 100 % y ${pos.length} con puntaje.`);
  } else {
    const sum = pos.reduce((s, a) => s + a.fraction, 0);
    if (!pos.length || Math.abs(sum - 1) > 1e-4) throw new PatchError('invalid_content', `La pregunta de ${where} es de varias respuestas: las fracciones positivas tienen que sumar 1 (suman ${Math.round(sum * 1e4) / 1e4}).`);
  }
}

/** Bloque del plugin del tipo + ids de respuesta (se reutilizan los viejos en orden; los que faltan son nuevos). */
async function pluginXml(ctx: OpContext, q: NewQuestion, oldAnswerIds: number[], oldOptionsId: number | null, assigned: (k: string) => Promise<number>): Promise<string> {
  const aid = async (i: number) => (i < oldAnswerIds.length ? oldAnswerIds[i] : assigned('answer'));
  const opt = async () => oldOptionsId ?? assigned('question_options');
  if (q.qtype === 'truefalse') {
    const t = await aid(0); const f = await aid(1);
    return `<plugin_qtype_truefalse_question><answers><answer id="${t}"><answertext>Verdadero</answertext><answerformat>0</answerformat><fraction>${q.correct ? fr(1) : fr(0)}</fraction><feedback>${xmlEsc(q.feedbackTrue ?? '')}</feedback><feedbackformat>1</feedbackformat></answer><answer id="${f}"><answertext>Falso</answertext><answerformat>0</answerformat><fraction>${!q.correct ? fr(1) : fr(0)}</fraction><feedback>${xmlEsc(q.feedbackFalse ?? '')}</feedback><feedbackformat>1</feedbackformat></answer></answers><truefalse id="${await opt()}"><trueanswer>${t}</trueanswer><falseanswer>${f}</falseanswer><showstandardinstruction>0</showstandardinstruction></truefalse></plugin_qtype_truefalse_question>`;
  }
  let ans = '';
  for (let i = 0; i < q.answers.length; i++) {
    const a = q.answers[i];
    ans += `<answer id="${await aid(i)}"><answertext>${xmlEsc(a.html)}</answertext><answerformat>1</answerformat><fraction>${fr(a.fraction)}</fraction><feedback>${xmlEsc(a.feedback ?? '')}</feedback><feedbackformat>1</feedbackformat></answer>`;
  }
  return `<plugin_qtype_multichoice_question><answers>${ans}</answers><multichoice id="${await opt()}"><layout>0</layout><single>${q.single === false ? 0 : 1}</single><shuffleanswers>1</shuffleanswers><correctfeedback></correctfeedback><correctfeedbackformat>1</correctfeedbackformat><partiallycorrectfeedback></partiallycorrectfeedback><partiallycorrectfeedbackformat>1</partiallycorrectfeedbackformat><incorrectfeedback></incorrectfeedback><incorrectfeedbackformat>1</incorrectfeedbackformat><answernumbering>abc</answernumbering><shownumcorrect>0</shownumcorrect><showstandardinstruction>0</showstandardinstruction></multichoice></plugin_qtype_multichoice_question>`;
}

function quizOf(ctx: OpContext, moduleId: number): WorkshopActivity {
  const a = ctx.inv.activities.find((x) => x.moduleId === moduleId);
  if (!a) throw new PatchError('target_not_found', `No existe la actividad ${moduleId}.`);
  if (a.modname !== 'quiz' || !a.exam) throw new PatchError('invalid_params', `${a.dir} no es un examen.`);
  return a;
}

async function loadQuiz(ctx: OpContext, a: WorkshopActivity): Promise<QuizXml> {
  const entry = `${a.dir}/quiz.xml`;
  return parseQuiz(entry, await ctx.state.readText(entry));
}

/**
 * Fix round 1 (P2-3): un paquete con datos de usuarios (respaldo «con usuarios») o con intentos / notas del examen no se
 * toca: renumerar o quitar ranuras, o cambiar una pregunta, dejaría intentos apuntando a lo que ya no existe.
 */
export async function examUserDataProblem(ctx: Pick<OpContext, 'state'>, quizDir: string): Promise<string | null> {
  const mb = ctx.state.has('moodle_backup.xml') ? await ctx.state.readText('moodle_backup.xml') : '';
  if (/<setting>\s*<level>root<\/level>\s*<name>users<\/name>\s*<value>1<\/value>/.test(mb)) return 'el paquete es un respaldo CON usuarios: exporta el curso sin datos de usuarios para editar sus exámenes.';
  const qx = ctx.state.has(`${quizDir}/quiz.xml`) ? await ctx.state.readText(`${quizDir}/quiz.xml`) : '';
  if (/<attempt id="\d+"|<grade id="\d+"|<question_usage id="\d+"/.test(qx)) return 'el examen trae intentos o notas de estudiantes: exporta el curso sin datos de usuarios para editar sus preguntas.';
  return null;
}
async function assertNoUserData(ctx: OpContext, a: WorkshopActivity): Promise<void> {
  const why = await examUserDataProblem(ctx, a.dir);
  if (why) throw new PatchError('unsupported', `No se editan las preguntas de «${a.title || a.dir}»: ${why}`);
}

/** Ranuras FIJAS de todos los quiz del paquete que usan una entrada / pregunta (fuera del quiz dado). */
async function otherUses(ctx: OpContext, skip: number, entryId: number | null, questionId: number): Promise<string[]> {
  const out: string[] = [];
  for (const x of ctx.inv.activities.filter((y) => y.modname === 'quiz' && y.moduleId !== skip && !y.missingFolder)) {
    const q = await loadQuiz(ctx, x);
    if (q.slots.some((s) => (entryId !== null && s.entryId === entryId) || s.questionId === questionId)) out.push(x.title || x.dir);
  }
  return out;
}

function misalignExplanations(ctx: OpContext, a: WorkshopActivity): void {
  const page = ctx.inv.activities.find((x) => x.kind === 'exam_answers' && (x.unit === a.unit || (a.kind === 'final_exam' && /final/i.test(x.title))));
  if (page) ctx.report.misalignment.push(`La página «${page.title}» (respuestas explicadas) no se actualizó con este cambio: revísala o pide su arreglo aparte.`);
}

export async function applyExamReplace(ctx: OpContext, op: ExamQuestionReplaceOp): Promise<void> {
  const a = quizOf(ctx, op.quizModuleId);
  await assertNoUserData(ctx, a);
  const wq = a.exam!.questions.find((q) => q.id === op.questionId);
  if (!wq) throw new PatchError('target_not_found', `La pregunta ${op.questionId} no es de ${a.dir} (o no es la versión que usa su ranura).`);
  validateQuestion(ctx, op.question, `${a.title || a.dir}`);
  let xml = await ctx.state.readText('questions.xml');
  const open = `<question id="${wq.id}">`;
  const s = xml.indexOf(open);
  const e = s >= 0 ? xml.indexOf('</question>', s) : -1;
  if (s < 0 || e < 0) throw new PatchError('target_not_found', `questions.xml no tiene la pregunta ${wq.id}.`);
  const oldBody = xml.slice(s + open.length, e);
  const oldQtype = /<qtype>([^<]*)<\/qtype>/.exec(oldBody)?.[1] ?? '';
  const pm = matchBlocks(oldBody, `<plugin_qtype_${oldQtype}_question>`, `</plugin_qtype_${oldQtype}_question>`)[0] ?? null;
  if (!pm) throw new PatchError('unsupported', `La pregunta ${wq.id} (${oldQtype}) no tiene el bloque de su tipo.`);
  const oldAnswerIds = [...pm[0].matchAll(/<answer id="(\d+)">/g)].map((m) => Number(m[1]));
  const oldOpt = Number(/<(?:multichoice|truefalse) id="(\d+)">/.exec(pm[0])?.[1] ?? NaN);
  const ids = await ctx.ids();
  const plugin = await pluginXml(ctx, op.question, oldAnswerIds, Number.isFinite(oldOpt) && oldQtype === op.question.qtype ? oldOpt : null, async (k) => ids.take(k));
  let body = oldBody.slice(0, pm.index) + plugin + oldBody.slice(pm.index + pm[0].length);
  body = setTag(body, 'questiontext', xmlEsc(op.question.text));
  body = setTag(body, 'questiontextformat', '1');
  body = setTag(body, 'generalfeedback', xmlEsc(op.question.generalFeedback ?? ''));
  body = setTag(body, 'generalfeedbackformat', '1');
  body = setTag(body, 'qtype', op.question.qtype);
  if (op.question.name) body = setTag(body, 'name', xmlEsc(op.question.name));
  xml = xml.slice(0, s + open.length) + body + xml.slice(e);
  ctx.state.write('questions.xml', xml);
  noteModified(ctx, 'questions.xml');
  // Respuestas que ya no existen (menos opciones que antes): sus archivos fuera (P2-7).
  const kept = op.question.qtype === 'truefalse' ? 2 : op.question.answers.length;
  await dropQuestionFiles(ctx, { questionIds: [], answerIds: oldAnswerIds.slice(kept) });
  ctx.report.fields.push({ entry: 'questions.xml', field: `question:${wq.id}`, moduleId: a.moduleId, sectionId: null, questionId: wq.id, before: describe(wq.html, wq.answers.map((x) => ({ html: x.html, fraction: x.fraction ?? 0 }))), after: describeNew(op.question), beforeRawSha1: sha1Of(oldBody), afterRawSha1: sha1Of(body) });
  Object.assign(ctx.report.idsAssigned, ids.assigned);
  const others = await otherUses(ctx, a.moduleId, wq.bankEntryId, wq.id);
  if (others.length) ctx.report.notes.push(`la misma pregunta la usa también: ${others.join(', ')} (cambia ahí también)`);
  if (wq.otherVersions.length) ctx.report.notes.push(`se editó la versión ${wq.version} (la que usa la ranura); las otras versiones (${wq.otherVersions.join(', ')}) no cambian`);
  misalignExplanations(ctx, a);
  ctx.report.summary = `${a.title || a.dir}: pregunta ${wq.id} reemplazada`;
}

const describe = (html: string, answers: Array<{ html: string; fraction: number }>) => `${html}\n${answers.map((x) => `${x.fraction >= 0.9999 ? '✔' : x.fraction > 0 ? `${Math.round(x.fraction * 100)} %` : '✘'} ${x.html}`).join('\n')}`;
const describeNew = (q: NewQuestion) => (q.qtype === 'truefalse' ? describe(q.text, [{ html: 'Verdadero', fraction: q.correct ? 1 : 0 }, { html: 'Falso', fraction: q.correct ? 0 : 1 }]) : describe(q.text, q.answers));

/** Marca de tiempo determinista: la de una pregunta existente (o 0). */
const tsOf = (xml: string) => /<timecreated>(\d+)<\/timecreated>/.exec(xml)?.[1] ?? '0';

export async function applyExamAdd(ctx: OpContext, op: ExamQuestionAddOp): Promise<void> {
  const a = quizOf(ctx, op.quizModuleId);
  await assertNoUserData(ctx, a);
  validateQuestion(ctx, op.question, `${a.title || a.dir}`);
  const quiz = await loadQuiz(ctx, a);
  let xml = await ctx.state.readText('questions.xml');
  const cats = parseCats(xml);
  const modern = cats.some((c) => c.modern);
  const random = quiz.slots.length > 0 && quiz.slots.every((s) => s.kind === 'random');
  // Categoría destino.
  let catId = op.categoryId ?? null;
  if (catId === null) {
    if (random) throw new PatchError('invalid_params', `${a.dir} sortea sus preguntas (ranuras aleatorias): indica la categoría del banco (categoryId).`);
    const used = [...new Set(a.exam!.questions.map((q) => q.categoryId).filter((v): v is number => v !== null))];
    if (used.length !== 1) throw new PatchError('invalid_params', `${a.dir} usa ${used.length} categorías del banco: indica cuál (categoryId).`);
    catId = used[0];
  }
  const cat = cats.find((c) => c.id === catId);
  if (!cat) throw new PatchError('target_not_found', `No existe la categoría ${catId} en questions.xml.`);
  if (cat.contextId !== quiz.ctxId && !a.exam!.questions.some((q) => q.categoryId === catId)) throw new PatchError('invalid_params', `La categoría ${catId} no es del examen ${a.dir}.`);
  if (random && !quiz.slots.some((s) => s.categoryId !== null && descendants(cats, s.categoryId).includes(catId as number) && (s.includeSub || s.categoryId === catId))) {
    throw new PatchError('invalid_params', `Ninguna ranura de ${a.dir} sortea de la categoría ${catId}: la pregunta nunca aparecería.`);
  }
  const ids = await ctx.ids();
  const qid = ids.take('question');
  const plugin = await pluginXml(ctx, op.question, [], null, async (k) => ids.take(k));
  const ts = tsOf(xml);
  const name = xmlEsc(op.question.name ?? `T-${qid}`);
  const qEl = `<question id="${qid}">
          <parent>0</parent><name>${name}</name>
          <questiontext>${xmlEsc(op.question.text)}</questiontext><questiontextformat>1</questiontextformat>
          <generalfeedback>${xmlEsc(op.question.generalFeedback ?? '')}</generalfeedback><generalfeedbackformat>1</generalfeedbackformat>
          <defaultmark>1.0000000</defaultmark><penalty>0.3333333</penalty><qtype>${op.question.qtype}</qtype>
          <length>1</length><stamp>cursia.workshop+${sha1Of(`${qid}|${op.question.text}`).slice(0, 20)}</stamp>${modern ? '' : '<hidden>0</hidden>'}
          <timecreated>${ts}</timecreated><timemodified>${ts}</timemodified>
          <createdby>2</createdby><modifiedby>2</modifiedby>
          ${plugin}
          <plugin_qbank_comment_question><comments></comments></plugin_qbank_comment_question>
        </question>`;
  let entryId: number | null = null;
  const catXml = xml.slice(cat.start, cat.end);
  let newCat: string;
  if (cat.modern || modern) {
    entryId = ids.take('question_bank_entry');
    const vid = ids.take('question_version');
    const entry = `      <question_bank_entry id="${entryId}">
        <questioncategoryid>${catId}</questioncategoryid><idnumber>$@NULL@$</idnumber><ownerid>2</ownerid>
        <question_version><question_versions id="${vid}"><version>1</version><status>ready</status>
        <questions>${qEl}</questions></question_versions></question_version>
      </question_bank_entry>\n`;
    const close = catXml.lastIndexOf('</question_bank_entries>');
    if (close >= 0) newCat = catXml.slice(0, close) + entry + '    ' + catXml.slice(close);
    else {
      const i = catXml.lastIndexOf('</question_category>');
      newCat = catXml.slice(0, i) + `<question_bank_entries>\n${entry}    </question_bank_entries>\n  ` + catXml.slice(i);
    }
  } else {
    const close = catXml.lastIndexOf('</questions>');
    if (close >= 0) newCat = catXml.slice(0, close) + qEl + catXml.slice(close);
    else { const i = catXml.lastIndexOf('</question_category>'); newCat = catXml.slice(0, i) + `<questions>${qEl}</questions>` + catXml.slice(i); }
  }
  xml = xml.slice(0, cat.start) + newCat + xml.slice(cat.end);
  ctx.state.write('questions.xml', xml);
  noteModified(ctx, 'questions.xml');
  if (!random) {
    const fixed = quiz.slots.filter((s) => s.kind !== 'random');
    const marks = fixed.map((s) => s.maxmark);
    const common = marks.length ? [...marks].sort((x, y) => marks.filter((m) => m === y).length - marks.filter((m) => m === x).length)[0] : 1;
    const maxmark = op.maxmark ?? common;
    if (!(maxmark > 0)) throw new PatchError('invalid_params', `Nota de la ranura inválida: ${op.maxmark}.`);
    const slotN = quiz.slots.length + 1;
    const page = quiz.qpp > 0 ? Math.ceil(slotN / quiz.qpp) : Math.max(1, ...quiz.slots.map((s) => s.page));
    const instId = ids.take('question_instance');
    let block: string;
    const tmpl = [...fixed].reverse().find((s) => (entryId !== null ? s.kind === 'fixed' : s.kind === 'legacy'));
    if (tmpl) {
      block = tmpl.block.replace(/^<question_instance id="\d+">/, () => `<question_instance id="${instId}">`);
      block = setTag(block, 'slot', String(slotN)); block = setTag(block, 'page', String(page)); block = setTag(block, 'maxmark', fr(maxmark));
      if (entryId !== null) {
        const refId = ids.take('question_reference');
        block = block.replace(/<question_reference id="\d+">/, () => `<question_reference id="${refId}">`);
        block = setTag(block, 'questionbankentryid', String(entryId)); block = setTag(block, 'version', '$@NULL@$');
      } else block = setTag(block, 'questionid', String(qid));
    } else if (entryId !== null) {
      const refId = ids.take('question_reference');
      block = `<question_instance id="${instId}">
        <quizid>${quiz.quizId}</quizid><slot>${slotN}</slot><page>${page}</page>
        <displaynumber>$@NULL@$</displaynumber><requireprevious>0</requireprevious>
        <maxmark>${fr(maxmark)}</maxmark><quizgradeitemid>$@NULL@$</quizgradeitemid>
        <question_reference id="${refId}">
          <usingcontextid>${quiz.ctxId}</usingcontextid><component>mod_quiz</component>
          <questionarea>slot</questionarea><questionbankentryid>${entryId}</questionbankentryid>
          <version>$@NULL@$</version>
        </question_reference>
      </question_instance>`;
    } else {
      block = `<question_instance id="${instId}"><slot>${slotN}</slot><page>${page}</page><questionid>${qid}</questionid><maxmark>${fr(maxmark)}</maxmark></question_instance>`;
    }
    const blocks = [...quiz.slots.map((s) => s.block), block];
    const nx = writeSlots(quiz, blocks, []);
    ctx.state.write(quiz.entry, nx);
    noteModified(ctx, quiz.entry);
    ctx.report.notes.push(`ranura ${slotN} nueva (nota ${maxmark}); sumgrades ${(quiz.slots.reduce((s, x) => s + x.maxmark, 0) + maxmark).toFixed(5)}`);
  } else {
    ctx.report.notes.push(`el examen sortea sus ranuras: la pregunta entra al banco de la categoría ${catId} (las ranuras no cambian)`);
  }
  ctx.report.fields.push({ entry: 'questions.xml', field: `question:${qid}`, moduleId: a.moduleId, sectionId: null, questionId: qid, before: '', after: describeNew(op.question), beforeRawSha1: sha1Of(''), afterRawSha1: sha1Of(qEl) });
  Object.assign(ctx.report.idsAssigned, ids.assigned);
  misalignExplanations(ctx, a);
  ctx.report.summary = `${a.title || a.dir}: pregunta ${qid} agregada`;
}

export async function applyExamRemove(ctx: OpContext, op: ExamQuestionRemoveOp): Promise<void> {
  const a = quizOf(ctx, op.quizModuleId);
  await assertNoUserData(ctx, a);
  const wq = a.exam!.questions.find((q) => q.id === op.questionId);
  if (!wq) throw new PatchError('target_not_found', `La pregunta ${op.questionId} no es de ${a.dir}.`);
  const quiz = await loadQuiz(ctx, a);
  let xml = await ctx.state.readText('questions.xml');
  const cats = parseCats(xml);
  const mine = quiz.slots.filter((s) => (wq.bankEntryId !== null && s.entryId === wq.bankEntryId) || s.questionId === wq.id);
  if (mine.length) {
    const left = quiz.slots.length - mine.length;
    if (left < 1) throw new PatchError('invariant', `Quitar la pregunta ${wq.id} deja ${a.title || a.dir} sin preguntas: el mínimo es 1.`);
    const removedSlots = mine.map((s) => s.slot);
    const blocks = renumber(quiz.slots.filter((s) => !mine.includes(s)).map((s) => s.block), quiz.qpp);
    ctx.state.write(quiz.entry, writeSlots(quiz, blocks, removedSlots));
    noteModified(ctx, quiz.entry);
    ctx.report.notes.push(`ranura(s) ${removedSlots.join(', ')} quitada(s); quedan ${left}; sumgrades ${quiz.slots.filter((s) => !mine.includes(s)).reduce((s, x) => s + x.maxmark, 0).toFixed(5)}`);
  }
  // ¿Se puede sacar del banco? Ninguna otra ranura fija la usa y ninguna ranura aleatoria se queda corta.
  const others = await otherUses(ctx, a.moduleId, wq.bankEntryId, wq.id);
  const draws: string[] = [];
  let shortBy: string | null = null;
  const catOfQ = wq.categoryId;
  for (const x of ctx.inv.activities.filter((y) => y.modname === 'quiz' && !y.missingFolder)) {
    const qz = x.moduleId === a.moduleId ? quiz : await loadQuiz(ctx, x);
    const byFilter = new Map<string, { cats: number[]; n: number }>();
    for (const s of qz.slots.filter((y) => y.kind === 'random' && y.categoryId !== null)) {
      const k = `${s.categoryId}|${s.includeSub}`;
      const cs = s.includeSub ? descendants(cats, s.categoryId as number) : [s.categoryId as number];
      byFilter.set(k, { cats: cs, n: (byFilter.get(k)?.n ?? 0) + 1 });
    }
    for (const [, f] of byFilter) {
      if (catOfQ === null || !f.cats.includes(catOfQ)) continue;
      draws.push(x.title || x.dir);
      const avail = cats.filter((c) => f.cats.includes(c.id)).reduce((s, c) => s + (c.modern ? c.entryIds.length : c.questionIds.length), 0);
      if (avail - 1 < f.n) shortBy = `${x.title || x.dir} sortea ${f.n} pregunta(s) de esa categoría y quedarían ${avail - 1}`;
    }
  }
  if (!mine.length && !draws.length) throw new PatchError('invariant', `Ninguna ranura de ${a.dir} usa la pregunta ${wq.id}.`);
  if (shortBy) throw new PatchError('invariant', `No se puede quitar la pregunta ${wq.id}: ${shortBy} (el examen quedaría por debajo de su mínimo).`);
  if (!others.length) {
    // Sale del banco: la entrada entera (todas sus versiones) o la pregunta (3.x), y sus archivos.
    let s: number; let e: number;
    if (wq.bankEntryId !== null) {
      const open = `<question_bank_entry id="${wq.bankEntryId}">`;
      s = xml.indexOf(open); e = s >= 0 ? xml.indexOf('</question_bank_entry>', s) + '</question_bank_entry>'.length : -1;
    } else {
      const open = `<question id="${wq.id}">`;
      s = xml.indexOf(open); e = s >= 0 ? xml.indexOf('</question>', s) + '</question>'.length : -1;
    }
    if (s < 0 || e < 0) throw new PatchError('target_not_found', `questions.xml no tiene la pregunta ${wq.id}.`);
    // Se lleva también el salto de línea + sangría anteriores (bloque limpio).
    const ls = xml.lastIndexOf('\n', s);
    const cut = ls >= 0 && /^\s*$/.test(xml.slice(ls, s)) ? ls : s;
    const seg = xml.slice(s, e);
    const removedIds = [...seg.matchAll(/<question id="(\d+)">/g)].map((m) => Number(m[1]));
    const answerIds = [...seg.matchAll(/<answer id="(\d+)">/g)].map((m) => Number(m[1]));
    xml = xml.slice(0, cut) + xml.slice(e);
    ctx.state.write('questions.xml', xml);
    noteModified(ctx, 'questions.xml');
    await dropQuestionFiles(ctx, { questionIds: removedIds, answerIds });
    ctx.report.notes.push(`la pregunta ${wq.id} sale del banco${wq.otherVersions.length ? ` (con sus versiones ${wq.otherVersions.join(', ')})` : ''}`);
  } else {
    ctx.report.notes.push(`la pregunta ${wq.id} queda en el banco: la usa también ${others.join(', ')}`);
  }
  if (!mine.length) ctx.report.notes.push(`el examen sortea sus ranuras: sale del banco de la categoría ${catOfQ}`);
  ctx.report.fields.push({ entry: 'questions.xml', field: `question:${wq.id}`, moduleId: a.moduleId, sectionId: null, questionId: wq.id, before: describe(wq.html, wq.answers.map((x) => ({ html: x.html, fraction: x.fraction ?? 0 }))), after: '', beforeRawSha1: sha1Of(wq.html), afterRawSha1: sha1Of('') });
  misalignExplanations(ctx, a);
  ctx.report.summary = `${a.title || a.dir}: pregunta ${wq.id} quitada`;
}

/**
 * Archivos de files.xml (component `question`) de lo que se quita, y sus blobs si quedan huérfanos (un blob que otra
 * entrada usa se conserva). Fix round 1 (P2-7): las áreas de la PREGUNTA (questiontext, generalfeedback, *feedback,
 * hint) usan el id de la pregunta como itemid; las de las RESPUESTAS (answer, answerfeedback), el id de la respuesta.
 */
async function dropQuestionFiles(ctx: OpContext, ids: { questionIds: number[]; answerIds: number[] }): Promise<number> {
  if (!ctx.state.has('files.xml')) return 0;
  let xml = await ctx.state.readText('files.xml');
  const ANSWER_AREAS = new Set(['answer', 'answerfeedback']);
  const victims = matchBlocks(xml, /<file id="(\d+)">/, '</file>').filter((m) => {
    if (!/<component>question<\/component>/.test(m[2])) return false;
    const area = /<filearea>([^<]*)<\/filearea>/.exec(m[2])?.[1] ?? '';
    const item = Number(/<itemid>(\d+)<\/itemid>/.exec(m[2])?.[1] ?? -1);
    return ANSWER_AREAS.has(area) ? ids.answerIds.includes(item) : ids.questionIds.includes(item);
  });
  if (!victims.length) return 0;
  const hashes = new Set<string>();
  for (const m of victims.reverse()) {
    hashes.add(/<contenthash>([0-9a-f]{40})<\/contenthash>/.exec(m[2])?.[1] ?? '');
    const s = m.index ?? 0;
    xml = xml.slice(0, s) + xml.slice(s + m[0].length);
  }
  ctx.state.write('files.xml', xml);
  noteModified(ctx, 'files.xml');
  for (const h of hashes) {
    if (h && !xml.includes(`<contenthash>${h}</contenthash>`) && ctx.state.has(blobPath(h))) { ctx.state.remove(blobPath(h)); ctx.report.entriesRemoved.push(blobPath(h)); }
  }
  ctx.report.notes.push(`files.xml: ${victims.length} archivo(s) de preguntas / respuestas quitadas`);
  return victims.length;
}
