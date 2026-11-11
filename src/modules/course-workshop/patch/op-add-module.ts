/**
 * r107 B11 · motor de parches — Fase 4: `add_module`. Agrega un módulo (sección de Moodle) nuevo DESPUÉS del último
 * módulo del curso con N capítulos (N ≥ 1, cada uno con el patrón de `add_chapter`) y, como el builder V1 arma un examen
 * por unidad, su página «ℹ️ Información: Examen Unidad M» + el examen «📝 Examen Unidad M» con las preguntas GIFT del
 * generador de exámenes (`sysG` + `pGIFT`), escritas con las MISMAS plantillas XML del builder (`mbz-builder.service.ts`,
 * «GIFT Quiz» y «questions.xml»). Las secciones posteriores (cierre / examen final) bajan un número; sus ids no cambian.
 * Como el módulo va al final, ningún capítulo existente cambia de número.
 */
import { parseGIFT, GiftQuestion, safeActivityName } from '../../../package/mbz-common';
import { xmlUnescape } from '../../visual-design/preview-extract';
import { WorkshopActivity, plainText } from '../course-model';
import { ADD_CHAPTER_FAMILIES, AddModuleOp, V3_ADD_CHAPTER_UNAVAILABLE } from '../regenerate/chapter-types';
import { hasPendingMarker } from '../regenerate/target';
import { xmlEsc } from './html-edit';
import { OpContext } from './op-context';
import {
  ChapterPlacement, Texts, chapterPieces, editTag, formatChapterList, insertChapter, insertLibroChapter, pagesNeeded, producedChapterProblems, templateOf,
} from './op-add-chapter';
import { PatchError } from './types';

/** Preguntas GIFT del examen de unidad: todas de los tipos que el builder escribe; MC con exactamente una correcta. */
export function unitExamProblems(gift: string): { questions: GiftQuestion[]; problems: string[] } {
  const qs = parseGIFT(gift ?? '');
  const problems: string[] = [];
  if (qs.length < 5) problems.push(`el examen trae ${qs.length} pregunta(s) (mínimo 5)`);
  qs.forEach((q, i) => {
    if (!plainText(q.text, 20)) problems.push(`la pregunta ${i + 1} no tiene enunciado`);
    if (q.type === 'multichoice') {
      const ok = q.options.filter((o) => o.correct).length;
      if (ok !== 1) problems.push(`la pregunta ${i + 1} tiene ${ok} respuestas correctas`);
      if (q.options.length < 2) problems.push(`la pregunta ${i + 1} tiene menos de 2 opciones`);
      if (q.options.some((o) => /\b(todas|ninguna) las anteriores\b/i.test(o.text))) problems.push(`la pregunta ${i + 1} usa «todas / ninguna de las anteriores»`);
    }
    if (q.type === 'match' && q.pairs.length < 3) problems.push(`la pregunta ${i + 1} (emparejamiento) tiene menos de 3 pares`);
    if (q.type === 'shortanswer' && !q.answers.length) problems.push(`la pregunta ${i + 1} no tiene respuesta`);
  });
  if (hasPendingMarker(gift ?? '')) problems.push('el examen trae «⚠️ Pendiente»');
  return { questions: qs, problems };
}

export async function applyAddModule(ctx: OpContext, op: AddModuleOp): Promise<void> {
  if (!(ADD_CHAPTER_FAMILIES as readonly string[]).includes(ctx.family)) throw new PatchError('unavailable', ctx.family === 'v2-dynamic' ? V3_ADD_CHAPTER_UNAVAILABLE : `Agregar módulos no está disponible para cursos de la familia «${ctx.family}».`);
  const p = op.produced;
  if (!p || p.kind !== 'module') throw new PatchError('invalid_params', 'Falta el módulo producido: no se aplica nada.');
  if (!Array.isArray(op.chapters) || op.chapters.length < 1 || p.chapters.length !== op.chapters.length) throw new PatchError('invalid_params', 'El módulo nuevo necesita al menos un capítulo (y uno producido por cada uno).');
  const inv = ctx.inv;
  const lastMod = [...inv.modules].sort((a, b) => b.number - a.number)[0];
  if (!lastMod || lastMod.sectionNumbers.length !== 1) throw new PatchError('unsupported', 'El curso no tiene módulos en secciones propias: no se sabe dónde va el módulo nuevo.');
  if (op.moduleNumber !== lastMod.number + 1) throw new PatchError('invalid_params', `El módulo nuevo es el ${lastMod.number + 1} (va después del último).`);
  const t = templateOf(inv, op.templateChapter, op.expect?.templateModuleIds);
  const pieces = chapterPieces(t, op.omit ?? []);
  const need = await pagesNeeded(ctx.state, pieces, op.omit ?? []);
  const L = Math.max(...inv.chapters.map((c) => c.number));
  for (let i = 0; i < p.chapters.length; i++) {
    const c = p.chapters[i];
    if (c.chapterNumber !== L + 1 + i) throw new PatchError('invalid_params', `El capítulo producido ${i + 1} debería ser el ${L + 1 + i}.`);
    const pr = await producedChapterProblems(c, { video: pieces.some((x) => x.piece === 'video'), presentation: pieces.some((x) => x.piece === 'presentation'), ...need });
    if (pr.length) throw new PatchError('invalid_content', `El capítulo ${c.chapterNumber} del módulo nuevo no es válido y no se aplica nada: ${pr.join('; ')}.`);
  }
  const tSec = inv.sections.find((s) => s.number === lastMod.sectionNumbers[0]);
  if (!tSec?.entry) throw new PatchError('target_not_found', 'Falta la sección del último módulo.');
  // Examen de la unidad (si el formato lo tiene: el módulo molde tiene su examen).
  const tExam = op.templateExamModuleId !== null ? inv.activities.find((a) => a.moduleId === op.templateExamModuleId) ?? null : null;
  if (op.templateExamModuleId !== null && (!tExam || tExam.kind !== 'exam' || tExam.unit !== lastMod.number)) throw new PatchError('stale_target', 'El examen molde no es el de la última unidad.');
  const tInfo = tExam ? inv.activities.find((a) => a.kind === 'exam_info' && a.unit === lastMod.number && a.sectionId === tExam.sectionId) ?? null : null;
  let exam: ReturnType<typeof unitExamProblems> | null = null;
  if (tExam) {
    if (!p.exam) throw new PatchError('invalid_content', 'El formato del curso lleva examen por unidad y el módulo producido no lo trae.');
    exam = unitExamProblems(p.exam.gift);
    if (exam.problems.length) throw new PatchError('invalid_content', `El examen del módulo nuevo no es válido: ${exam.problems.join('; ')}.`);
    if (tInfo && !plainText(p.exam.infoHtml ?? '', 40)) throw new PatchError('invalid_content', 'Falta la página informativa del examen.');
  }

  const texts = new Texts(ctx);
  const alloc = await ctx.ids();
  const M = op.moduleNumber;
  const newSecId = alloc.take('section');
  const newSecNum = (tSec.number ?? 0) + 1;
  // Secciones posteriores: su número sube uno (section.xml y module.xml de sus actividades).
  for (const s of inv.sections.filter((x) => (x.number ?? -1) >= newSecNum)) {
    if (!s.entry) continue;
    await texts.set(s.entry, editTag(await texts.get(s.entry), 'number', () => String((s.number as number) + 1)));
    for (const id of s.sequence) {
      const a = inv.activities.find((x) => x.moduleId === id);
      if (!a || a.missingFolder) continue;
      const me = `${a.dir}/module.xml`;
      await texts.set(me, editTag(await texts.get(me), 'sectionnumber', () => String((s.number as number) + 1)));
    }
  }
  const pl: ChapterPlacement = { sectionId: newSecId, sectionNumber: newSecNum, sequenceIndex: 0, moduleNumber: M, moduleTitle: op.title };
  const seq: number[] = [];
  const unitExams = new Map<number, number>();
  const examMids = tExam ? { quiz: alloc.take('moduleid'), info: tInfo ? alloc.take('moduleid') : null } : null;
  if (examMids) unitExams.set(M, examMids.quiz);
  for (let i = 0; i < p.chapters.length; i++) {
    const c = p.chapters[i];
    const ins = await insertChapter(ctx, texts, { t, pl: { ...pl, sequenceIndex: seq.length }, pieces, p: c, title: op.chapters[i].title, renumber: false, unitExams, noVideo: (op.omit ?? []).includes('video'), afterMid: seq.length ? seq[seq.length - 1] : null });
    seq.push(...ins.moduleIds);
    await insertLibroChapter(ctx, texts, { position: c.chapterNumber, title: op.chapters[i].title, md: c.libroMd, moduleOf: (n) => (n > L ? M : inv.chapters.find((x) => x.number === n)?.moduleNumber ?? null), moduleNumber: M });
  }
  if (tExam && exam && examMids) {
    if (tInfo) seq.push(await cloneExamInfo(ctx, texts, tInfo, examMids.info as number, pl, lastMod.number, M, p.exam!.infoHtml, examMids.quiz));
    seq.push(await cloneUnitExam(ctx, texts, tExam, examMids.quiz, pl, lastMod.number, M, exam.questions));
  }
  // Libro: entrada del módulo en el índice, antes del primer capítulo nuevo.
  await addLibroModuleTocEntry(ctx, texts, M, op.title, L + 1);
  // Sección nueva (clon de la del último módulo).
  const sx = await ctx.state.readText(tSec.entry);
  const nums = p.chapters.map((c) => c.chapterNumber);
  let ns = sx.replace(/<section id="\d+">/, `<section id="${newSecId}">`);
  ns = editTag(ns, 'number', () => String(newSecNum));
  ns = editTag(ns, 'name', () => xmlEsc(safeActivityName(`Módulo ${M} — ${op.title}`, 255)));
  ns = editTag(ns, 'summary', (v) => (/^Capítulos [\d, y]+ con /.test(v) ? v.replace(/^Capítulos [\d, y]+? con /, `${nums.length === 1 ? 'Capítulo' : 'Capítulos'} ${formatChapterList(nums)} con `) : v));
  ns = editTag(ns, 'sequence', () => seq.join(','));
  if (/<section id="\d+">[\s\S]*<section id=/.test(ns)) throw new PatchError('unsupported', 'section.xml del molde trae más de una sección.');
  const secDir = `sections/section_${newSecId}`;
  for (const e of ctx.state.names().filter((n) => n.startsWith(`${tSec.dir}/`))) {
    const rel = e.slice(tSec.dir.length + 1);
    const body = rel === 'section.xml' ? ns : await ctx.state.readText(e);
    if (rel !== 'section.xml' && /\bid="\d+"/.test(body) && !/^<\?xml[^>]*>\s*<(inforef|roles)>/.test(body)) throw new PatchError('unsupported', `${e} trae ids que el Taller no sabe clonar.`);
    ctx.state.write(`${secDir}/${rel}`, body);
    ctx.report.entriesAdded.push(`${secDir}/${rel}`);
  }
  // moodle_backup.xml: <section> y sus <setting>, después de la del último módulo.
  let backup = await texts.get('moodle_backup.xml');
  const sb = new RegExp(`<section>\\s*<sectionid>${tSec.id}</sectionid>[\\s\\S]*?</section>`).exec(backup);
  if (!sb) throw new PatchError('invariant', 'moodle_backup.xml no lista la sección del último módulo.');
  const nsb = sb[0].replace(`<sectionid>${tSec.id}</sectionid>`, `<sectionid>${newSecId}</sectionid>`).replace(/<title>[\s\S]*?<\/title>/, `<title>${xmlEsc(safeActivityName(`Módulo ${M} — ${op.title}`, 255))}</title>`).replace(`<directory>${tSec.dir}</directory>`, `<directory>${secDir}</directory>`);
  const at = (sb.index ?? 0) + sb[0].length;
  backup = backup.slice(0, at) + nsb + backup.slice(at);
  const key = `section_${tSec.id}`;
  const sets = [...backup.matchAll(new RegExp(`\\s*<setting>\\s*<level>section</level>\\s*<section>${key}</section>[\\s\\S]*?</setting>`, 'g'))];
  if (sets.length) {
    const last = sets[sets.length - 1];
    const ins = sets.map((m) => m[0].split(`>${key}<`).join(`>section_${newSecId}<`).split(`>${key}_`).join(`>section_${newSecId}_`)).join('');
    const at2 = (last.index ?? 0) + last[0].length;
    backup = backup.slice(0, at2) + ins + backup.slice(at2);
  }
  await texts.set('moodle_backup.xml', backup);
  texts.flush();
  (ctx.report.idsAssigned.section ||= []).push(newSecId);
  const r = ctx.report;
  r.summary = `Módulo ${M} nuevo «${op.title}» con ${nums.length} capítulo(s) (${formatChapterList(nums)})${tExam ? ' y su examen de unidad' : ''}`;
  r.notes.push(`molde: capítulo ${t.number} y ${tExam ? `examen «${tExam.title}»` : 'sin examen'}`, `sección nueva ${newSecId} (número ${newSecNum}); las secciones siguientes bajan un número`);
  if (inv.audiobook.length) r.misalignment.push(`El audiolibro del curso no incluye los capítulos ${formatChapterList(nums)} nuevos: rehacerlo es un pedido aparte (regenerate_audio) con su costo.`);
  if (inv.activities.some((a) => a.exam?.final)) r.misalignment.push(`El examen final no tiene preguntas de los capítulos ${formatChapterList(nums)} nuevos: agregarlas es un pedido aparte (exam_question_add) con su costo.`);
  r.misalignment.push(`El Libro Guía no tiene la página de presentación del módulo ${M} (la escribe la IA en la generación completa): el índice sí lo nombra.`);
}

/** Página informativa del examen (label) con su contenido nuevo. */
async function cloneExamInfo(ctx: OpContext, texts: Texts, src: WorkshopActivity, mid: number, pl: ChapterPlacement, tu: number, M: number, html: string, quizMid: number): Promise<number> {
  const body = html.replace(/#exam-unit-(\d+)/g, (m, u: string) => (Number(u) === M ? `$@QUIZVIEWBYID*${quizMid}@$` : m));
  await cloneSimple(ctx, texts, src, mid, pl, (xml) => {
    let out = editTag(xml, 'name', (v) => xmlEsc(xmlUnescape(v).replace(new RegExp(`Unidad ${tu}(?!\\d)`), `Unidad ${M}`)));
    const i0 = out.indexOf('<intro>'); const i1 = out.indexOf('</intro>');
    out = out.slice(0, i0 + 7) + xmlEsc(body) + out.slice(i1);
    return out;
  }, (title) => title.replace(new RegExp(`Unidad ${tu}(?!\\d)`), `Unidad ${M}`), new Map());
  return mid;
}

/** Examen de unidad: el quiz del molde con sus preguntas reemplazadas por las del GIFT nuevo (plantillas del builder). */
async function cloneUnitExam(ctx: OpContext, texts: Texts, src: WorkshopActivity, mid: number, pl: ChapterPlacement, tu: number, M: number, qs: GiftQuestion[]): Promise<number> {
  const quiz = await ctx.state.readText(`${src.dir}/quiz.xml`);
  if (!/<question_reference\b/.test(quiz)) throw new PatchError('unsupported', 'El examen molde no usa el banco de Moodle 4 (question_reference): no se clona.');
  const alloc = await ctx.ids();
  const ctxId = alloc.take('contextid');
  const aid = alloc.take('activity');
  const cat = { top: alloc.take('question_category'), def: alloc.take('question_category'), cat: alloc.take('question_category') };
  const name = xmlUnescape(/<name>([\s\S]*?)<\/name>/.exec(quiz)?.[1] ?? '').replace(new RegExp(`Unidad ${tu}(?!\\d)`), `Unidad ${M}`);
  const ts = /<timecreated>(\d+)<\/timecreated>/.exec(quiz)?.[1] ?? '0';
  const markPerQ = (100 / Math.max(qs.length, 1)).toFixed(7);
  let inst = '';
  let entries = '';
  qs.forEach((q, qi) => {
    const qbe = alloc.take('question_bank_entry'); const qv = alloc.take('question_version'); const qid = alloc.take('question');
    const slot = qi + 1;
    inst += `      <question_instance id="${alloc.take('question_instance')}">
        <quizid>${aid}</quizid><slot>${slot}</slot><page>${Math.ceil(slot / 5)}</page>
        <displaynumber>$@NULL@$</displaynumber><requireprevious>0</requireprevious>
        <maxmark>${markPerQ}</maxmark><quizgradeitemid>$@NULL@$</quizgradeitemid>
        <question_reference id="${alloc.take('question_reference')}">
          <usingcontextid>${ctxId}</usingcontextid><component>mod_quiz</component>
          <questionarea>slot</questionarea><questionbankentryid>${qbe}</questionbankentryid>
          <version>$@NULL@$</version>
        </question_reference>
      </question_instance>\n`;
    entries += `      <question_bank_entry id="${qbe}">
        <questioncategoryid>${cat.cat}</questioncategoryid><idnumber>$@NULL@$</idnumber><ownerid>2</ownerid>
        <question_version><question_versions id="${qv}"><version>1</version><status>ready</status>
        <questions><question id="${qid}">
          <parent>0</parent><name>${xmlEsc(q.name || `Q-${qi + 1}`)}</name>
          <questiontext>${xmlEsc(q.text)}</questiontext><questiontextformat>0</questiontextformat>
          <generalfeedback></generalfeedback><generalfeedbackformat>0</generalfeedbackformat>
          <defaultmark>1.0000000</defaultmark><penalty>0.3333333</penalty><qtype>${q.type}</qtype>
          <length>1</length><stamp>campusvirtual.edu.co+${ts}+ws${qid}</stamp>
          <timecreated>${ts}</timecreated><timemodified>${ts}</timemodified>
          <createdby>2</createdby><modifiedby>2</modifiedby>
          ${pluginXml(q, () => alloc.take('question_answer'))}
          <plugin_qbank_comment_question><comments></comments></plugin_qbank_comment_question>
        </question></questions></question_versions></question_version>
      </question_bank_entry>\n`;
  });
  const fixQuiz = (xml: string) => {
    let out = xml.replace(/<question_instances>[\s\S]*?<\/question_instances>/, () => `<question_instances>\n${inst}    </question_instances>`);
    out = editTag(out, 'name', () => xmlEsc(name));
    // Intro: la del builder cuando no hay página del examen (`<p>📝 Examen Unidad M</p>`).
    out = out.replace(/<intro>[\s\S]*?<\/intro>/, () => `<intro>${xmlEsc(`<p>${xmlEsc(name)}</p>`)}</intro>`);
    out = editTag(out, 'sumgrades', () => '100.00000');
    return out;
  };
  const extra = new Map<number, number>([[Number(/<activity id="(\d+)"/.exec(quiz)?.[1]), aid]]);
  if (src.contextId !== null) extra.set(src.contextId, ctxId);
  await cloneSimple(ctx, texts, src, mid, pl, fixQuiz, (t) => t.replace(new RegExp(`Unidad ${tu}(?!\\d)`), `Unidad ${M}`), extra, (rel, xml) => {
    if (rel !== 'inforef.xml') return xml;
    return xml.replace(/<question_categoryref>[\s\S]*?<\/question_categoryref>/, `<question_categoryref>\n    <question_category><id>${cat.top}</id></question_category>\n    <question_category><id>${cat.def}</id></question_category>\n    <question_category><id>${cat.cat}</id></question_category>\n  </question_categoryref>`);
  });
  const qx = await texts.get('questions.xml');
  const catXml = (id: number, nm: string, parent: number, sortorder: number, info: string, body: string) => `  <question_category id="${id}">\n    <name>${xmlEsc(nm)}</name>\n    <contextid>${ctxId}</contextid><contextlevel>70</contextlevel><contextinstanceid>${mid}</contextinstanceid>\n    <info>${xmlEsc(info)}</info><infoformat>0</infoformat>\n    <stamp>campusvirtual.edu.co+${ts}+ws${id}</stamp>\n    <parent>${parent}</parent><sortorder>${sortorder}</sortorder><idnumber>$@NULL@$</idnumber>\n    <question_bank_entries>${body}</question_bank_entries>\n  </question_category>\n`;
  const add = catXml(cat.top, 'top', 0, 0, '', '') + catXml(cat.def, `Por defecto en ${name}`, cat.top, 999, `Categoría por defecto para preguntas compartidas en el contexto ${name}.`, '') + catXml(cat.cat, name, cat.top, 999, '', `\n${entries}    `);
  if (!/<\/question_categories>\s*$/.test(qx)) throw new PatchError('invariant', 'questions.xml no cierra en </question_categories>.');
  await texts.set('questions.xml', qx.replace(/<\/question_categories>\s*$/, () => `${add}</question_categories>`));
  ctx.report.notes.push(`examen «${name}»: ${qs.length} pregunta(s) (${[...new Set(qs.map((q) => q.type))].join(', ')})`);
  return mid;
}

/** XML de la pregunta por tipo: la plantilla del builder V1 (mbz-builder.service.ts, «GIFT Quiz»). */
function pluginXml(q: GiftQuestion, next: () => number): string {
  if (q.type === 'multichoice') {
    const answers = q.options.map((o) => `<answer id="${next()}"><answertext>${xmlEsc(o.text)}</answertext><answerformat>0</answerformat><fraction>${o.correct ? '1.0000000' : '0.0000000'}</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer>\n`).join('');
    return `<plugin_qtype_multichoice_question><answers>\n${answers}                  </answers><multichoice id="${next()}"><layout>0</layout><single>1</single><shuffleanswers>1</shuffleanswers><correctfeedback></correctfeedback><correctfeedbackformat>0</correctfeedbackformat><partiallycorrectfeedback></partiallycorrectfeedback><partiallycorrectfeedbackformat>0</partiallycorrectfeedbackformat><incorrectfeedback></incorrectfeedback><incorrectfeedbackformat>0</incorrectfeedbackformat><answernumbering>abc</answernumbering><shownumcorrect>0</shownumcorrect><showstandardinstruction>0</showstandardinstruction></multichoice></plugin_qtype_multichoice_question>`;
  }
  if (q.type === 'truefalse') {
    const ta = next(); const fa = next();
    return `<plugin_qtype_truefalse_question><answers><answer id="${ta}"><answertext>Verdadero</answertext><answerformat>0</answerformat><fraction>${q.answer ? '1.0000000' : '0.0000000'}</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer><answer id="${fa}"><answertext>Falso</answertext><answerformat>0</answerformat><fraction>${!q.answer ? '1.0000000' : '0.0000000'}</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer></answers><truefalse id="${next()}"><trueanswer>${ta}</trueanswer><falseanswer>${fa}</falseanswer><showstandardinstruction>0</showstandardinstruction></truefalse></plugin_qtype_truefalse_question>`;
  }
  if (q.type === 'match') {
    const opts = next();
    const matches = q.pairs.map((pr) => `<match id="${next()}"><questiontext>${xmlEsc(pr.q)}</questiontext><questiontextformat>0</questiontextformat><answertext>${xmlEsc(pr.a)}</answertext></match>\n`).join('');
    return `<plugin_qtype_match_question><matchoptions id="${opts}"><shuffleanswers>1</shuffleanswers><correctfeedback></correctfeedback><correctfeedbackformat>0</correctfeedbackformat><partiallycorrectfeedback></partiallycorrectfeedback><partiallycorrectfeedbackformat>0</partiallycorrectfeedbackformat><incorrectfeedback></incorrectfeedback><incorrectfeedbackformat>0</incorrectfeedbackformat><shownumcorrect>0</shownumcorrect></matchoptions><matches>\n${matches}                  </matches></plugin_qtype_match_question>`;
  }
  const answers = q.answers.map((s) => `<answer id="${next()}"><answertext>${xmlEsc(s)}</answertext><answerformat>0</answerformat><fraction>1.0000000</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer>\n`).join('');
  return `<plugin_qtype_shortanswer_question><answers>\n${answers}                  </answers><shortanswer id="${next()}"><usecase>0</usecase></shortanswer></plugin_qtype_shortanswer_question>`;
}

/** Clona una actividad sin archivos (label / quiz) con ids nuevos; `fix` reescribe su XML principal. */
async function cloneSimple(ctx: OpContext, texts: Texts, src: WorkshopActivity, mid: number, pl: ChapterPlacement, fix: (xml: string) => string, title: (t: string) => string, extra: Map<number, number>, post: (rel: string, xml: string) => string = (_r, x) => x): Promise<void> {
  const alloc = await ctx.ids();
  const idMap = new Map<number, number>([[src.moduleId, mid], ...extra]);
  if (src.contextId !== null && !idMap.has(src.contextId)) idMap.set(src.contextId, alloc.take('contextid'));
  const dir = `activities/${src.modname}_${mid}`;
  const entries = ctx.state.names().filter((n) => n.startsWith(`${src.dir}/`));
  const files = await texts.get('files.xml');
  if (src.contextId !== null && [...files.matchAll(/<file id="\d+">([\s\S]*?)<\/file>/g)].some((m) => m[1].includes(`<contextid>${src.contextId}</contextid>`) && !/<filename>\.<\/filename>/.test(m[1]))) throw new PatchError('unsupported', `${src.dir} trae archivos: no se clona como actividad simple.`);
  for (const e of entries) {
    const rel = e.slice(src.dir.length + 1);
    let xml = await ctx.state.readText(e);
    if (rel === `${src.modname}.xml`) xml = fix(xml);
    for (const m of xml.matchAll(/\bid="(\d+)"/g)) if (!idMap.has(Number(m[1]))) idMap.set(Number(m[1]), alloc.take('activity_item'));
    xml = xml.replace(/\b(id|moduleid|contextid)="(\d+)"/g, (mm, k: string, v: string) => (idMap.has(Number(v)) ? `${k}="${idMap.get(Number(v))}"` : mm))
      .replace(/(<grade_item>\s*<id>)(\d+)(<\/id>\s*<\/grade_item>)/g, (mm, a1: string, v: string, c: string) => (idMap.has(Number(v)) ? `${a1}${idMap.get(Number(v))}${c}` : mm))
      .replace(/(<iteminstance>)(\d+)(<\/iteminstance>)/g, (mm, a1: string, v: string, c: string) => (idMap.has(Number(v)) ? `${a1}${idMap.get(Number(v))}${c}` : mm))
      .replace(/(<quizid>)(\d+)(<\/quizid>)/g, (mm, a1: string, v: string, c: string) => (idMap.has(Number(v)) ? `${a1}${idMap.get(Number(v))}${c}` : mm));
    if (rel === 'module.xml') { xml = editTag(xml, 'sectionid', () => String(pl.sectionId)); xml = editTag(xml, 'sectionnumber', () => String(pl.sectionNumber)); }
    if (rel === 'grades.xml') xml = editTag(xml, 'itemname', (v) => xmlEsc(title(xmlUnescape(v))), true);
    if (/<file>\s*<id>/.test(xml)) throw new PatchError('unsupported', `${src.dir}/${rel} nombra archivos: no se clona como actividad simple.`);
    xml = post(rel, xml);
    ctx.state.write(`${dir}/${rel}`, xml);
    ctx.report.entriesAdded.push(`${dir}/${rel}`);
  }
  let backup = await texts.get('moodle_backup.xml');
  const blk = new RegExp(`<activity>\\s*<moduleid>${src.moduleId}</moduleid>[\\s\\S]*?</activity>`).exec(backup);
  if (!blk) throw new PatchError('invariant', `moodle_backup.xml no lista ${src.dir}.`);
  const nb = blk[0].replace(`<moduleid>${src.moduleId}</moduleid>`, `<moduleid>${mid}</moduleid>`).replace(/<sectionid>\d+<\/sectionid>/, `<sectionid>${pl.sectionId}</sectionid>`)
    .replace(/<title>([\s\S]*?)<\/title>/, (_m, v: string) => `<title>${xmlEsc(title(xmlUnescape(v)))}</title>`).replace(`<directory>${src.dir}</directory>`, `<directory>${dir}</directory>`);
  // Al final de la lista de actividades (después de las del capítulo recién agregadas).
  const lastAct = [...backup.matchAll(/<activity>\s*<moduleid>\d+<\/moduleid>[\s\S]*?<\/activity>/g)].pop()!;
  const at = (lastAct.index ?? 0) + lastAct[0].length;
  backup = backup.slice(0, at) + nb + backup.slice(at);
  const key = `${src.modname}_${src.moduleId}`;
  const sets = [...backup.matchAll(new RegExp(`\\s*<setting>\\s*<level>activity</level>\\s*<activity>${key}</activity>[\\s\\S]*?</setting>`, 'g'))];
  if (sets.length) {
    const last = sets[sets.length - 1];
    const ins = sets.map((m) => m[0].split(`>${key}<`).join(`>${src.modname}_${mid}<`).split(`>${key}_`).join(`>${src.modname}_${mid}_`)).join('');
    const at2 = (last.index ?? 0) + last[0].length;
    backup = backup.slice(0, at2) + ins + backup.slice(at2);
  }
  await texts.set('moodle_backup.xml', backup);
  (ctx.report.idsAssigned.moduleid ||= []).push(mid);
}

/** Índice del Libro: «MÓDULO M – título» antes del primer capítulo del módulo nuevo (formato de `buildLibroHTML`). */
async function addLibroModuleTocEntry(ctx: OpContext, texts: Texts, M: number, title: string, firstChapter: number): Promise<void> {
  const fx = await texts.get('files.xml');
  const libro = ctx.inv.activities.find((x) => x.kind === 'libro' && x.modname === 'resource' && !x.missingFolder);
  if (!libro || libro.contextId === null) return;
  const blk = [...fx.matchAll(/<file id="\d+">([\s\S]*?)<\/file>/g)].find((m) => m[1].includes(`<contextid>${libro.contextId}</contextid>`) && /<filename>[^<]*\.html?<\/filename>/.test(m[1]));
  if (!blk) return;
  const h = /<contenthash>([0-9a-f]{40})<\/contenthash>/.exec(blk[1])![1];
  const be = `files/${h.slice(0, 2)}/${h}`;
  const html = (await ctx.state.read(be)).toString('utf8');
  const m = new RegExp(`<div class="te tc"><span class="tt">Capítulo ${firstChapter}:`).exec(html);
  if (!m) { ctx.report.misalignment.push(`El índice del Libro no tiene el formato del builder: no se agregó la entrada del módulo ${M}.`); return; }
  const entry = `<div class="te tm"><span class="tt"><strong>MÓDULO ${M} – ${xmlEsc(title)}</strong></span><span class="td"></span></div>`;
  const out = Buffer.from(html.slice(0, m.index) + entry + html.slice(m.index), 'utf8');
  const crypto = await import('crypto');
  const nh = crypto.createHash('sha1').update(out).digest('hex');
  const ne = `files/${nh.slice(0, 2)}/${nh}`;
  ctx.state.write(ne, out);
  ctx.report.entriesAdded.push(ne);
  // P2-4: solo la entrada del Libro (mismo contexto) cambia de blob.
  await texts.set('files.xml', fx.replace(/<file id="(\d+)">([\s\S]*?)<\/file>/g, (m, id: string, body: string) => (body === blk[1]
    ? `<file id="${id}">${body.replace(`<contenthash>${h}</contenthash>`, `<contenthash>${nh}</contenthash>`).replace(/<filesize>\d+<\/filesize>/, `<filesize>${out.length}</filesize>`)}</file>` : m)));
  // El blob intermedio (sin la entrada del módulo) ya no lo usa nadie.
  if (ctx.state.has(be) && !ctx.inv.activities.some((a) => a.files.some((f) => f.contenthash === h)) && !(await texts.get('files.xml')).includes(`<contenthash>${h}</contenthash>`)) { ctx.state.remove(be); const k = ctx.report.entriesAdded.indexOf(be); if (k >= 0) ctx.report.entriesAdded.splice(k, 1); }
}
