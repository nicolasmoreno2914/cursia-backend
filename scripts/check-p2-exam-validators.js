#!/usr/bin/env node
/* eslint-disable */
// Cursia EV6 P2-B5 — códigos del validador para las evaluaciones que certifican:
//   QUIZ_RANDOM, EXPLANATIONS_GATE, ANSWER_LEAK, TEACHER_NOTE (mbz-validator-v3 + exam-validator-v3).
// Puro: sin DB, sin red (fetch prohibido).
//
// A1 (P2-task-B5.md):
//  - el paquete BUENO con bancos (+ final + certificado), sin final, con intentos ilimitados y uno GIFT
//    validan limpios (también sin `examBankPlans` en las expectativas: expectativas viejas);
//  - cada mutación de un paquete bueno → EXACTAMENTE su código (nada más);
//  - ANSWER_LEAK (fix 1 + 2): fuga = enunciado + respuesta correcta juntos fuera de su página (en el texto
//    enseñado, además con una opción incorrecta); una respuesta sola o una explicación nunca; regresiones
//    del probe de la revisión (C1/C2, I3 worked.js) y respuestas cortas.
//  - opcional: `--corpus a.mbz b.mbz …` corre ANSWER_LEAK sobre paquetes existentes (reales/E2E): 0 hallazgos.
//
// Usage: node scripts/check-p2-exam-validators.js [path/to/dist] [--out dir] [--corpus x.mbz …]
//   --out dir: escribe bank.mbz, gift.mbz, unlimited.mbz, nofinal.mbz (para moodle-p2-exams.php)
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : null;
const corpusIdx = args.indexOf('--corpus');
const CORPUS = corpusIdx >= 0 ? args.slice(corpusIdx + 1).filter((a) => !a.startsWith('--')) : [];
const positional = args.slice(0, corpusIdx >= 0 ? corpusIdx : args.length).filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
const ROOT = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), positional[0] || path.join(ROOT, 'dist'));
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };
const JSZip = require('jszip');

const EB = loadDist('modules/course-shell/exam-bank.js');
const S = loadDist('modules/course-shell/index.js');
const B = loadDist('package/dynamic-mbz-builder-v3.js');
const V = loadDist('package/v3/mbz-validator-v3.js');
const EV = loadDist('package/v3/exam-validator-v3.js');
const P = loadDist('modules/course-profiles/course-profiles.js');
const PF = require('./lib/v21-packaging-fixtures');
const EBF = require('./lib/exam-bank-fixtures');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y.slice(0, 800)}, encontrado ${x.slice(0, 800)}`);
}
const tag = (xml, t) => {
  const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(xml);
  return m ? m[1] : null;
};
const xe = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Texto plano → como queda dentro del HTML escapado de un `<intro>`/`<content>` del XML. */
const inXmlHtml = (s) => xe(xe(s));

/** Entrada con bancos válidos (mismo generador que check-p2-bank-xml / check-p2-explanations). */
function bankInput(o = {}) {
  const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 754, ...o });
  const manifest = input.manifest;
  const all = manifest.modules.flatMap((m) => m.chapters.map((c) => ({ id: c.chapterId, moduleId: m.moduleId })));
  const gIndex = new Map(all.map((c, i) => [c.id, i]));
  const c = input.contents;
  for (const ch of all) c.contentMd.set(ch.id, `${c.contentMd.get(ch.id)}\n\n${EBF.chapterMarkdown(gIndex.get(ch.id), 'Reglas')}`);
  const banks = new Map();
  for (const m of manifest.modules) {
    if (!m.examEnabled) continue;
    const chs = all.filter((x) => x.moduleId === m.moduleId);
    const bank = EBF.makeExamBank({ scope: 'module', moduleId: m.moduleId, chapters: chs, chapterIndex: gIndex, prefix: `V${m.moduleNumber}L`, plan: EB.expectedExamPlan('module', chs) });
    const r = EB.validateExamBank(bank, { scope: 'module', chapters: chs, chapterMd: c.contentMd });
    assert(r.ok, `fixture de banco inválido: ${JSON.stringify(r.errors.slice(0, 3))}`);
    banks.set(m.moduleId, bank);
  }
  let fin = null;
  if (manifest.features.finalExam) {
    fin = EBF.makeExamBank({ scope: 'final', moduleId: null, chapters: all, chapterIndex: gIndex, prefix: 'VF', plan: EB.expectedExamPlan('final', all) });
    const r = EB.validateExamBank(fin, { scope: 'final', chapters: all, chapterMd: c.contentMd });
    assert(r.ok, `fixture de banco final inválido: ${JSON.stringify(r.errors.slice(0, 3))}`);
  }
  c.examGift = new Map();
  c.finalExamGift = null;
  c.examBanks = banks;
  c.finalExamBank = fin;
  return { input, banks, fin };
}

/** Lee el paquete para ubicar archivos por idnumber. */
async function index(mbz) {
  const z = await JSZip.loadAsync(mbz);
  const mb = await z.file('moodle_backup.xml').async('string');
  const byId = {};
  for (const m of tag(mb, 'activities').matchAll(/<activity>([\s\S]*?)<\/activity>/g)) {
    const dir = tag(m[1], 'directory');
    const modname = tag(m[1], 'modulename');
    const mid = Number(tag(m[1], 'moduleid'));
    const module = await z.file(`${dir}/module.xml`).async('string');
    byId[tag(module, 'idnumber')] = { dir, modname, mid, section: Number(tag(m[1], 'sectionid')) };
  }
  return { z, byId };
}

/** Aplica `edits` = { ruta: (xml) => xml } y regenera el zip. Falla si una edición no cambia nada. */
async function mutate(mbz, edits) {
  const z = await JSZip.loadAsync(mbz);
  for (const [p, fn] of Object.entries(edits)) {
    const before = await z.file(p).async('string');
    const after = fn(before);
    assert(after !== before, `la mutación de ${p} no cambió nada`);
    z.file(p, after);
  }
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const replaceOnce = (s, a, b) => {
  const i = s.indexOf(a);
  if (i < 0) throw new Error(`no encontrado: ${String(a).slice(0, 120)}`);
  return s.slice(0, i) + b + s.slice(i + a.length);
};
/** Inserta texto plano al final del primer párrafo «normal» (no transición) del HTML escapado. */
const insertText = (xml, field, text) => {
  const raw = tag(xml, field);
  const idx = raw.indexOf('&lt;/p&gt;');
  assert(idx > 0, `${field} sin </p>`);
  return xml.replace(raw, raw.slice(0, idx) + ' ' + inXmlHtml(text) + raw.slice(idx));
};

async function codes(mbz, exp) {
  const v = await V.validateMbzV3(mbz, exp);
  return { codes: [...new Set(v.issues.map((i) => i.code))].sort(), issues: v.issues };
}
async function expectOnly(mbz, exp, code, label) {
  const r = await codes(mbz, exp);
  eq(r.codes, [code], `${label}: códigos ${JSON.stringify(r.issues.slice(0, 4))}`);
  return r.issues;
}

async function main() {
  const A = bankInput();
  const built = await B.buildDynamicMbzV3(A.input);
  const exp = built.expectations;
  const I = await index(built.mbz);
  const examIdn = Object.keys(I.byId).find((k) => /^cv3:exam:/.test(k));
  const modId = examIdn.slice('cv3:exam:'.length);
  const quiz = I.byId[examIdn];
  const page = I.byId[`cv3:exam_explanations:${modId}`];
  const fquiz = I.byId['cv3:final_exam'];
  const fpage = I.byId['cv3:final_exam_explanations'];
  const QX = `${quiz.dir}/quiz.xml`;
  const PM = `${page.dir}/module.xml`;
  const PX = `${page.dir}/page.xml`;
  const mbank = A.banks.get(modId);
  const mc = mbank.questions.find((q) => q.type === 'multichoice');

  const G = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 755 });
  const builtG = await B.buildDynamicMbzV3(G);
  const NB = bankInput({ finalExam: false, courseId: 756 });
  const builtNB = await B.buildDynamicMbzV3(NB.input);
  const defaults = P.defaultAssessmentProfile({ finalExam: true });
  const U = bankInput({ courseId: 757, profile: { ...defaults, attempts: { ...defaults.attempts, exam: 0 } } });
  const builtU = await B.buildDynamicMbzV3(U.input);
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    const banksJson = (X) => ({ modules: Object.fromEntries(X.banks), final: X.fin });
    for (const [n, b, x] of [['bank', built, A], ['gift', builtG, null], ['nofinal', builtNB, NB], ['unlimited', builtU, U]]) {
      fs.writeFileSync(path.join(OUT, `${n}.mbz`), b.mbz);
      if (x) fs.writeFileSync(path.join(OUT, `${n}.banks.json`), JSON.stringify(banksJson(x)));
    }
    console.log(`   paquetes → ${OUT}/{bank,gift,nofinal,unlimited}.mbz (+ .banks.json)`);
  }

  // ── paquetes buenos ──
  await check('buenos: banco (+final+certificado), sin final, intentos ilimitados y GIFT validan limpios; plan por hoja en las expectativas', async () => {
    for (const [n, b] of [['banco', built], ['sin final', builtNB], ['ilimitados', builtU], ['GIFT', builtG]]) {
      const v = await V.validateMbzV3(b.mbz, b.expectations);
      assert(v.ok, `${n}: ${JSON.stringify(v.issues.slice(0, 4))}`);
    }
    eq(Object.keys(exp.examBankPlans).sort(), [examIdn, ...Object.keys(I.byId).filter((k) => /^cv3:exam:/.test(k) && k !== examIdn), 'cv3:final_exam'].sort(), 'examBankPlans: un plan por quiz con banco');
    eq(builtG.expectations.examBankPlans, {}, 'GIFT: sin planes');
    const leaves = exp.examBankPlans[examIdn];
    eq(leaves.reduce((a, l) => a + l.slots, 0), EB.planSlotCount(mbank.plan), 'Σ slots del plan = slots del banco');
    // Expectativas viejas (sin examBankPlans): sigue limpio (solo coherencia interna).
    const v = await V.validateMbzV3(built.mbz, { facts: exp.facts, resolved: exp.resolved });
    assert(v.ok, `sin examBankPlans: ${JSON.stringify(v.issues.slice(0, 4))}`);
  });

  // ── QUIZ_RANDOM ──
  const qx = await I.z.file(QX).async('string');
  const firstLeaf = Number(/"values":\[(\d+)\]/.exec(qx)[1]);
  const qxml = await I.z.file('questions.xml').async('string');
  const catBlock = (id) => new RegExp(`<question_category id="${id}">[\\s\\S]*?</question_category>`).exec(qxml)[0];
  const parentOf = (id) => Number(tag(catBlock(id), 'parent'));
  const leafIds = [...new Set(Array.from(qx.matchAll(/"values":\[(\d+)\]/g), (m) => Number(m[1])))];
  const otherLeaf = leafIds.find((x) => x !== firstLeaf);
  const fqx = await I.z.file(`${fquiz.dir}/quiz.xml`).async('string');
  const finalLeaf = Number(/"values":\[(\d+)\]/.exec(fqx)[1]);
  const QR = [
    ['includesubcategories true', { [QX]: (x) => replaceOnce(x, '"includesubcategories":false', '"includesubcategories":true') }],
    ['slot → categoría padre (no hoja)', { [QX]: (x) => replaceOnce(x, `"values":[${firstLeaf}]`, `"values":[${parentOf(firstLeaf)}]`) }],
    ['slot → hoja de OTRO quiz (otro contexto)', { [QX]: (x) => replaceOnce(x, `"values":[${firstLeaf}]`, `"values":[${finalLeaf}]`) }],
    ['slot → categoría inexistente', { [QX]: (x) => replaceOnce(x, `"values":[${firstLeaf}]`, '"values":[987654]') }],
    ['un slot movido a otra hoja (referencias por hoja ≠ plan)', { [QX]: (x) => replaceOnce(x, `"values":[${firstLeaf}]`, `"values":[${otherLeaf}]`) }],
    ['slot fijo mezclado con aleatorios', { [QX]: (x) => replaceOnce(x, /<question_set_reference id="\d+">[\s\S]*?<\/question_set_reference>/.exec(x)[0],
      `<question_reference id="99999"><usingcontextid>1</usingcontextid><component>mod_quiz</component><questionarea>slot</questionarea><questionbankentryid>1000</questionbankentryid><version>$@NULL@$</version></question_reference>`) }],
    ['Σ maxmark ≠ 100', { [QX]: (x) => replaceOnce(x, /<maxmark>[\d.]+<\/maxmark>/.exec(x)[0], '<maxmark>9.0000000</maxmark>') }],
    ['hoja bajo el piso (bankFloor)', { 'questions.xml': (x) => {
      const blk = catBlock(firstLeaf);
      const entries = Array.from(blk.matchAll(/<question_bank_entry id="\d+">[\s\S]*?<\/question_bank_entry>/g), (m) => m[0]);
      return x.replace(blk, entries.slice(1).reduce((b, e) => b.replace(e, ''), blk));
    } }],
    ['hoja con preguntas sin referencias', { [QX]: (x) => x.split(`"values":[${otherLeaf}]`).join(`"values":[${firstLeaf}]`) }],
  ];
  for (const [label, edits] of QR) {
    await check(`QUIZ_RANDOM: ${label} → solo QUIZ_RANDOM`, async () => {
      await expectOnly(await mutate(built.mbz, edits), exp, 'QUIZ_RANDOM', label);
    });
  }
  await check('QUIZ_RANDOM: GIFT con un slot aleatorio (facts dice preguntas fijas) → solo QUIZ_RANDOM', async () => {
    const IG = await index(builtG.mbz);
    const gq = IG.byId[Object.keys(IG.byId).find((k) => /^cv3:exam:/.test(k))];
    const gx = await IG.z.file(`${gq.dir}/quiz.xml`).async('string');
    const ctx = /contextid="(\d+)"/.exec(gx)[1];
    const cat = /<question_category id="(\d+)">[\s\S]*?<contextinstanceid>(\d+)<\//.exec(await IG.z.file('questions.xml').async('string'));
    const bad = await mutate(builtG.mbz, { [`${gq.dir}/quiz.xml`]: (x) => replaceOnce(x, /<question_reference id="\d+">[\s\S]*?<\/question_reference>/.exec(x)[0],
      `<question_set_reference id="99999"><usingcontextid>${ctx}</usingcontextid><component>mod_quiz</component><questionarea>slot</questionarea><questionscontextid>${ctx}</questionscontextid><filtercondition>{"filter":{"category":{"jointype":1,"values":[${cat[1]}],"filteroptions":{"includesubcategories":false}}}}</filtercondition></question_set_reference>`) });
    await expectOnly(bad, builtG.expectations, 'QUIZ_RANDOM', 'GIFT mezclado');
  });

  // ── EXPLANATIONS_GATE ──
  const pm = await I.z.file(PM).async('string');
  const EG = [
    ['availability sin e=3 con 3 intentos', { [PM]: (x) => replaceOnce(x, `,{"type":"completion","cm":${quiz.mid},"e":3}`, '') }],
    ['availability apunta a OTRO quiz', { [PM]: (x) => x.split(`"cm":${quiz.mid},`).join(`"cm":${fquiz.mid},`) }],
    ['show:true', { [PM]: (x) => replaceOnce(x, '"show":false', '"show":true') }],
    ['downloadcontent 1', { [PM]: (x) => replaceOnce(x, '<downloadcontent>0</downloadcontent>', '<downloadcontent>1</downloadcontent>') }],
    ['sin availability', { [PM]: (x) => replaceOnce(x, tag(pm, 'availability'), '$@NULL@$') }],
    ['contenido vacío', { [PX]: (x) => replaceOnce(x, tag(x, 'content'), '') }],
    ['contenido con <style> (CLEAN_SAFE)', { [PX]: (x) => replaceOnce(x, tag(x, 'content'), inXmlHtml('<style>p{color:red}</style>') + tag(x, 'content')) }],
    ['la página no va justo después del quiz', {
      [`sections/section_${quiz.section}/section.xml`]: (x) => {
        const seq = tag(x, 'sequence').split(',');
        const i = seq.indexOf(String(page.mid));
        [seq[i], seq[i + 1]] = [seq[i + 1], seq[i]];
        return x.replace(tag(x, 'sequence'), seq.join(','));
      },
      'moodle_backup.xml': (x) => {
        const acts = tag(x, 'activities');
        const blk = (mid) => new RegExp(`<activity>\\s*<moduleid>${mid}</moduleid>[\\s\\S]*?</activity>`).exec(acts)[0];
        const seqx = (tag(x, 'activities').match(/<moduleid>\d+<\/moduleid>/g) || []).map((m) => Number(/\d+/.exec(m)[0]));
        const next = seqx[seqx.indexOf(page.mid) + 1];
        const a = blk(page.mid);
        const b = blk(next);
        return x.replace(acts, acts.replace(a, '\u0000').replace(b, a).replace('\u0000', b));
      },
    }],
  ];
  for (const [label, edits] of EG) {
    await check(`EXPLANATIONS_GATE: ${label} → solo EXPLANATIONS_GATE`, async () => {
      await expectOnly(await mutate(built.mbz, edits), exp, 'EXPLANATIONS_GATE', label);
    });
  }
  await check('EXPLANATIONS_GATE: intentos ilimitados con e=1|e=3 (un reprobado abriría el banco) → solo EXPLANATIONS_GATE', async () => {
    const IU = await index(builtU.mbz);
    const uq = IU.byId[examIdn.replace(modId, Object.keys(IU.byId).find((k) => /^cv3:exam:/.test(k)).slice(9))];
    const up = IU.byId[`cv3:exam_explanations:${Object.keys(IU.byId).find((k) => /^cv3:exam:/.test(k)).slice(9)}`];
    const ux = await IU.z.file(`${uq.dir}/quiz.xml`).async('string');
    eq(tag(ux, 'attempts_number'), '0', 'fixture: intentos ilimitados');
    const bad = await mutate(builtU.mbz, { [`${up.dir}/module.xml`]: (x) => replaceOnce(x, `{"type":"completion","cm":${uq.mid},"e":1}]`, `{"type":"completion","cm":${uq.mid},"e":1},{"type":"completion","cm":${uq.mid},"e":3}]`) });
    await expectOnly(bad, builtU.expectations, 'EXPLANATIONS_GATE', 'ilimitados e=3');
  });

  // ── ANSWER_LEAK (fix 1: solo el par enunciado + respuesta correcta fuera de su página) ──
  const ch = Object.keys(I.byId).find((k) => /^cv3:ch:.*:deepening$/.test(k));
  const CHX = `${I.byId[ch].dir}/label.xml`;
  const FQX = `${fquiz.dir}/quiz.xml`;
  const FPX = `${fpage.dir}/page.xml`;
  const pair = (q) => `${q.stem} Respuesta: ${q.correct.text}.`;
  const pasted = (q) => `${q.stem} a) ${q.correct.text} b) ${q.distractors[0].text} c) ${q.distractors[1].text}`;
  await check('ANSWER_LEAK (verdadero positivo, fix 2): pregunta pegada CON sus opciones en el texto de un capítulo → solo ANSWER_LEAK', async () => {
    const iss = await expectOnly(await mutate(built.mbz, { [CHX]: (x) => insertText(x, 'intro', pasted(mc)) }), exp, 'ANSWER_LEAK', 'pregunta en capítulo');
    assert(iss.every((i) => i.where === ch) && iss.some((i) => i.message.includes(mc.id)), JSON.stringify(iss));
  });
  await check('ANSWER_LEAK sin falso positivo (fix 2, I3): enunciado + respuesta SIN opciones en el texto enseñado (el capítulo enuncia el hecho) → limpio', async () => {
    const r = await codes(await mutate(built.mbz, { [CHX]: (x) => insertText(x, 'intro', pair(mc)) }), exp);
    eq(r.codes, [], 'par sin opciones en capítulo');
  });
  await check('ANSWER_LEAK: par del examen de módulo en la intro del examen final → solo ANSWER_LEAK', async () => {
    await expectOnly(await mutate(built.mbz, { [FQX]: (x) => insertText(x, 'intro', pair(mc)) }), exp, 'ANSWER_LEAK', 'intro');
  });
  await check('ANSWER_LEAK: par del examen de módulo en la página del examen FINAL (otra página gated) → solo ANSWER_LEAK', async () => {
    await expectOnly(await mutate(built.mbz, { [FPX]: (x) => insertText(x, 'content', pair(mc)) }), exp, 'ANSWER_LEAK', 'otra página');
  });
  await check('ANSWER_LEAK: par GIFT (enunciado + respuesta correcta) en la intro de otro quiz → solo ANSWER_LEAK', async () => {
    const IG = await index(builtG.mbz);
    const fq = IG.byId['cv3:final_exam'];
    const modQuiz = IG.byId[Object.keys(IG.byId).find((k) => /^cv3:exam:/.test(k))];
    const qxg = await IG.z.file('questions.xml').async('string');
    const un = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const cats = Array.from(qxg.matchAll(/<question_category id="\d+">[\s\S]*?<\/question_category>/g), (m) => m[0]).filter((c) => tag(c, 'contextinstanceid') === String(modQuiz.mid));
    const mcq = cats.flatMap((c) => Array.from(c.matchAll(/<question id="\d+">[\s\S]*?<\/question>/g), (m) => m[0])).find((q) => tag(q, 'qtype') === 'multichoice' && un(tag(q, 'questiontext')).length >= 20);
    const right = un(/<answertext>([^<]*)<\/answertext><answerformat>\d<\/answerformat><fraction>1\.0000000<\/fraction>/.exec(mcq)[1]);
    await expectOnly(await mutate(builtG.mbz, { [`${fq.dir}/quiz.xml`]: (x) => insertText(x, 'intro', `${un(tag(mcq, 'questiontext'))} ${right}`) }), builtG.expectations, 'ANSWER_LEAK', 'GIFT');
  });
  await check('ANSWER_LEAK sin falsos positivos (mutaciones): respuesta sola en un capítulo / en la intro de otro quiz; explicación en un capítulo / en la página de otro quiz', async () => {
    for (const [label, edits] of [
      ['respuesta sola en capítulo', { [CHX]: (x) => insertText(x, 'intro', mc.correct.text) }],
      ['respuesta sola en la intro del final', { [FQX]: (x) => insertText(x, 'intro', mc.correct.text) }],
      ['explicación en capítulo', { [CHX]: (x) => insertText(x, 'intro', mc.explanation) }],
      ['explicación en la página final', { [FPX]: (x) => insertText(x, 'content', mc.explanation) }],
      ['enunciado solo en capítulo', { [CHX]: (x) => insertText(x, 'intro', mc.stem) }],
    ]) {
      const r = await codes(await mutate(built.mbz, edits), exp);
      eq(r.codes, [], label);
    }
  });

  // Regresiones del probe de la revisión (b5rev-probe.js, C1 + C2) y respuestas cortas realistas:
  // paquetes VÁLIDOS del builder de hoy → validateMbzV3 limpio con sus propias expectativas.
  const cleanBuild = async (label, input, expOf) => {
    const b = await B.buildDynamicMbzV3(input);
    const v = await V.validateMbzV3(b.mbz, expOf ? expOf(b) : b.expectations);
    assert(v.ok, `${label}: ${JSON.stringify(v.issues.slice(0, 3))}`);
  };
  const giftWith = (correct, n) => [
    `::M${n}P1:: ¿Cuál es el recurso que corresponde al caso descrito? {\n=${correct}\n~Interrumpir al cliente\n~Derivar sin explicar\n}`,
    `::M${n}P2:: ¿Qué conducta mejora la atención en el caso B? {\n=Escuchar y confirmar\n~Interrumpir\n~Derivar sin explicar\n}`,
    `::M${n}VF:: Confirmar lo entendido reduce malentendidos. {TRUE}`,
  ].join('\n\n');
  await check('ANSWER_LEAK regresión C2 + respuestas cortas: GIFT con respuesta correcta = microcopy del shell / título / «Sí» / número / palabra común → limpio', async () => {
    for (const ans of ['Video interactivo', 'Actividad práctica', 'Ruta de aprendizaje', 'Evaluación final', 'Nota mínima para aprobar', 'Material de estudio', 'Audio de bienvenida', 'Evaluación del módulo', 'Sí', 'No', '3', '70', 'Agua', 'Capítulo', 'Bienvenida']) {
      const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 760 });
      const first = input.manifest.modules.find((m) => m.examEnabled);
      input.contents.examGift.set(first.moduleId, giftWith(ans, first.moduleNumber));
      input.contents.finalExamGift = giftWith(ans, 9);
      await cleanBuild(`GIFT «${ans}»`, input);
    }
  });
  await check('ANSWER_LEAK regresión C1: banco con respuesta correcta = parte de un título de capítulo (final) / título del módulo (examen de módulo), que las páginas imprimen → limpio', async () => {
    const X = bankInput({ courseId: 761 });
    X.fin.questions.find((q) => q.type === 'multichoice').correct.text = 'Fundamentos de la atención';
    await cleanBuild('final = título de capítulo', X.input);
    const Y = bankInput({ courseId: 762 });
    const m1 = (await B.buildDynamicMbzV3(bankInput({ courseId: 762 }).input)).expectations.facts.modules[0];
    const t = m1.title.length >= 12 ? m1.title : `${m1.title} del servicio`;
    Y.banks.get(m1.id).questions.find((q) => q.type === 'multichoice').correct.text = t;
    await cleanBuild(`módulo = título del módulo «${t}»`, Y.input);
  });
  await check('ANSWER_LEAK regresión: respuestas cortas en un banco («Sí», número) y la MISMA pregunta (enunciado + respuesta) en el examen de módulo y en el final → limpio (material compartido)', async () => {
    const X = bankInput({ courseId: 763 });
    const mq = [...X.banks.values()][0].questions.filter((q) => q.type === 'multichoice');
    mq[0].correct.text = 'Sí';
    mq[1].correct.text = '12';
    const fq = X.fin.questions.find((q) => q.type === 'multichoice');
    fq.stem = mq[2].stem;
    fq.correct.text = mq[2].correct.text;
    await cleanBuild('cortas + compartida', X.input);
  });
  await check('ANSWER_LEAK regresión I3 (b5r1/worked.js): pregunta de completar cuyo enunciado + respuesta son una oración del texto de un capítulo → limpio', async () => {
    const base = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 770 }));
    const pkg = await EV.readExamPackageV3(await JSZip.loadAsync(base.mbz));
    const lab = pkg.acts.find((a) => /^cv3:ch:.*:deepening$/.test(a.idnumber));
    const VC = loadDist('modules/visual-components/index.js');
    const sent = VC.extractText(lab.intro).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).find((x) => x.length > 60 && x.length < 200 && !/[{}=~#:]/.test(x));
    assert(sent, 'fixture: sin oración en el capítulo');
    const words = sent.replace(/[.!?]$/, '').split(' ');
    const cut = Math.ceil(words.length * 0.6);
    const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 771 });
    const first = input.manifest.modules.find((m) => m.examEnabled);
    const g = input.contents.examGift.get(first.moduleId);
    input.contents.examGift.set(first.moduleId, `::W1:: ${words.slice(0, cut).join(' ')}: {\n=${words.slice(cut).join(' ')}\n~Una opción distinta del caso\n~Otra opción sin relación\n}\n\n` + g.split('\n\n').slice(1).join('\n\n'));
    await cleanBuild('worked.js', input);
  });
  await check('M1: examBankPlans = {} (vacío/serializado) se trata como ausente → limpio', async () => {
    await cleanBuild('plans {}', bankInput({ courseId: 764 }).input, (b) => ({ facts: b.expectations.facts, resolved: b.expectations.resolved, examBankPlans: {} }));
  });
  await check('probe: banco + scorm + intentos ilimitados en módulo y final → limpio', async () => {
    const d = P.defaultAssessmentProfile({ finalExam: true });
    await cleanBuild('scorm ilimitados', bankInput({ courseId: 765, engine: 'scorm', profile: { ...d, attempts: { ...d.attempts, exam: 0, finalExam: 0 } } }).input);
  });
  await check('M2: las hojas del plan (expectativas) son las categorías que el builder escribió', async () => {
    const names = Array.from(qxml.matchAll(/<question_category id="\d+">\s*<name>([^<]*)<\/name>/g), (m) => m[1].replace(/&amp;/g, '&'));
    for (const l of exp.examBankPlans[examIdn]) assert(names.includes(l.category), `hoja ${l.category} no está en questions.xml`);
  });

  // ── TEACHER_NOTE ──
  const ct = I.byId['cv3:shell:certificate_teacher'];
  await check('TEACHER_NOTE: sin la nota en el label del certificado → solo TEACHER_NOTE', async () => {
    const bad = await mutate(built.mbz, { [`${ct.dir}/label.xml`]: (x) => replaceOnce(x, inXmlHtml(S.EXAMS_TEACHER_NOTE_AVAILABILITY), '') });
    await expectOnly(bad, exp, 'TEACHER_NOTE', 'sin nota');
  });
  await check('TEACHER_NOTE: nota duplicada (también visible en la intro del examen final) → solo TEACHER_NOTE', async () => {
    const bad = await mutate(built.mbz, { [FQX]: (x) => insertText(x, 'intro', S.EXAMS_TEACHER_NOTE) });
    await expectOnly(bad, exp, 'TEACHER_NOTE', 'duplicada');
  });
  await check('TEACHER_NOTE: sin final, cv3:shell:exams_teacher VISIBLE → solo TEACHER_NOTE', async () => {
    const IN = await index(builtNB.mbz);
    const et = IN.byId['cv3:shell:exams_teacher'];
    const bad = await mutate(builtNB.mbz, { [`${et.dir}/module.xml`]: (x) => replaceOnce(x, '<visible>0</visible>', '<visible>1</visible>') });
    await expectOnly(bad, builtNB.expectations, 'TEACHER_NOTE', 'visible');
  });
  await check('TEACHER_NOTE: sin final, la nota pierde la oración de intentos → solo TEACHER_NOTE', async () => {
    const IN = await index(builtNB.mbz);
    const et = IN.byId['cv3:shell:exams_teacher'];
    const bad = await mutate(builtNB.mbz, { [`${et.dir}/label.xml`]: (x) => replaceOnce(x, inXmlHtml(S.EXAMS_TEACHER_NOTE_ATTEMPTS), '') });
    await expectOnly(bad, builtNB.expectations, 'TEACHER_NOTE', 'oración');
  });

  // ── corpus ──
  if (CORPUS.length) {
    await check(`corpus de ${CORPUS.length} paquete(s) existentes (reales, E2E, fixtures): ANSWER_LEAK 0; con páginas «Respuestas explicadas» (builder ≥ 3.6.0) también QUIZ_RANDOM/EXPLANATIONS_GATE 0`, async () => {
      const bad = [];
      let needles = 0;
      let full = 0;
      for (const f of CORPUS) {
        const pkg = await EV.readExamPackageV3(await JSZip.loadAsync(fs.readFileSync(f)));
        needles += EV.answerLeakNeedles(pkg).length;
        const withPages = pkg.acts.some((a) => /^cv3:(exam_explanations:|final_exam_explanations$)/.test(a.idnumber));
        if (withPages) full++;
        const issues = withPages ? EV.examChecksV3(pkg) : EV.answerLeakIssues(pkg);
        if (issues.length) bad.push([path.basename(f), issues.slice(0, 3)]);
      }
      console.log(`   ${CORPUS.length} paquetes (${full} con páginas gated), ${needles} pares enunciado + respuesta buscados`);
      eq(bad, [], 'hallazgos');
    });
  }

  console.log(failures ? `\nHAY FALLOS (${passes} ✅, ${failures} ❌).` : `\nTodos los checks de P2-B5 pasaron (${passes} ✅, 0 ❌).`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
