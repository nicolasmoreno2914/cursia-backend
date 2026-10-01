#!/usr/bin/env node
/* eslint-disable */
// Cursia EV6 P2-B3 — golden del XML de los quizzes con banco (`dynamic_exam_bank_json`).
// Puro: sin DB, sin red (fetch prohibido).
//
// Construye el paquete v3 del fixture de empaque (h5p, 2 módulos con examen + final) con bancos
// válidos (scripts/lib/exam-bank-fixtures.js, el mismo generador de test/fixtures/exam-bank-v1)
// cuyos textos llevan & < > " y apóstrofes, y verifica (P2-design §2.2):
//  - #question_set_reference = slots del plan; ninguna question_reference en quizzes de banco;
//  - cada filtercondition = {"filter":{"category":{"jointype":1,"values":[HOJA],"filteroptions":
//    {"includesubcategories":false}}}} (sin "cat"), HOJA del MISMO quiz con ≥ piso de preguntas;
//    por hoja #referencias = slots del plan; slots en el orden de las categorías, página = ⌈slot/5⌉;
//  - Σ maxmark = 100.0000000 exacto;
//  - árbol: top (parent 0) → «Por defecto en …» → «Capítulo N: título» | «Módulo N: título» →
//    hojas «… · Selección múltiple | Verdadero o falso | Emparejamiento» (solo las del plan),
//    contexto del quiz (contextlevel 70), sortorder determinístico;
//  - inforef.xml del quiz lista TODAS sus categorías;
//  - preguntas: name = id, questiontext = enunciado, generalfeedback = explicación (format 1),
//    MC: correcta + 3 distractores con su `why` (feedbackformat 1), V/F: `whyWrong` en la opción
//    equivocada, emparejamiento (fix 1): DEFINICIÓN = subpregunta (format 2), TÉRMINO = opción del
//    desplegable; combinados vacíos; todo escapado (XML bien formado);
//  - facts: preguntas del examen = slots, bankSize = banco; validateMbzV3 ok; determinista;
//  - A4: evidencia que no está en el Markdown del capítulo → EXAM_BANK_INVALID [EXAM_BANK_EVIDENCE];
//    fix 1: término con < > → [EXAM_BANK_MATCH]; control C0 → [EXAM_BANK_SCHEMA]; plan congelado que
//    no cubre un capítulo actual → [EXAM_BANK_PLAN];
//  - GIFT: sin question_set_reference y (BASE_DIST=<dist de la base>) byte a byte el builder anterior.
//
// Usage: node scripts/check-p2-bank-xml.js [path/to/dist] [--out paquete.mbz]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : null;
const positional = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
const ROOT = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), positional[0] || path.join(ROOT, 'dist'));
function loadDist(rel, root = distRoot) {
  try {
    return require(path.join(root, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${root} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };
const JSZip = require('jszip');

const EB = loadDist('modules/course-shell/exam-bank.js');
const B = loadDist('package/dynamic-mbz-builder-v3.js');
const V = loadDist('package/v3/mbz-validator-v3.js');
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
  if (x !== y) throw new Error(`${m}: esperado ${y.slice(0, 600)}, encontrado ${x.slice(0, 600)}`);
}
async function rejects(p, re, m) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err && re.test(String(err.message)), `${m}: ${err ? err.message : 'no lanzó'}`);
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** Decodifica el texto de un nodo XML (xmlEsc escapa & < > "). */
const dx = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** `esc` de mbz-common (HTML, sí escapa apóstrofes). */
const he = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const para = (s) => `<p>${he(s)}</p>`;
const tag = (xml, t) => {
  const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(xml);
  return m ? m[1] : null;
};
const LABEL = { multichoice: 'Selección múltiple', truefalse: 'Verdadero o falso', match: 'Emparejamiento' };

/** Bien formado: etiquetas balanceadas, sin '<' ni '&' sueltos (mini-tokenizador, suficiente para nuestro XML). */
function assertWellFormed(xml, where) {
  const body = xml.replace(/^<\?xml[^>]*\?>/, '');
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[2] === undefined) throw new Error(`${where}: '${m[0]}' suelto en ${JSON.stringify(body.slice(Math.max(0, m.index - 40), m.index + 40))}`);
    if (m[4]) continue;
    if (m[1]) {
      const open = stack.pop();
      if (open !== m[2]) throw new Error(`${where}: </${m[2]}> cierra <${open}>`);
    } else stack.push(m[2]);
  }
  if (stack.length) throw new Error(`${where}: sin cerrar ${stack.join('>')}`);
}

// ── Fixture: paquete con bancos (textos con & < > " ') ──
const SPECIAL = {
  stem: ` ¿Qué hace si «A & B» < 3 > 1 y la jefa dice "ya" o 'después'?`,
  explanation: ` Ojo: a < b & c > d, con "comillas" y l'apóstrofo del turno.`,
  why: ` (R&D: <x> "y" l'z)`,
  option: ` & <ok> "q" d'x`,
  term: ` & "Q" l'i`,
  definition: ` (R&D <i> "z" d'o)`,
};
function specialize(bank) {
  for (const q of bank.questions) {
    q.stem += SPECIAL.stem;
    q.explanation += SPECIAL.explanation;
    if (q.type === 'multichoice') {
      for (const o of [q.correct, ...q.distractors]) {
        o.text += SPECIAL.option;
        o.why += SPECIAL.why;
      }
    } else if (q.type === 'truefalse') {
      q.whyWrong += SPECIAL.why;
    } else {
      for (const p of q.pairs) {
        p.term += SPECIAL.term;
        p.definition += SPECIAL.definition;
      }
    }
  }
  return bank;
}

/** Entrada del builder con bancos para TODOS los exámenes (módulos + final), validados con evidencia. */
function bankInput(mutate) {
  const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 734 });
  const manifest = input.manifest;
  const all = manifest.modules.flatMap((m) => m.chapters.map((c) => ({ id: c.chapterId, moduleId: m.moduleId })));
  const gIndex = new Map(all.map((c, i) => [c.id, i]));
  const c = input.contents;
  for (const ch of all) c.contentMd.set(ch.id, `${c.contentMd.get(ch.id)}\n\n${EBF.chapterMarkdown(gIndex.get(ch.id), 'Reglas')}`);
  const banks = new Map();
  for (const m of manifest.modules) {
    if (!m.examEnabled) continue;
    const chs = all.filter((x) => x.moduleId === m.moduleId);
    const bank = specialize(EBF.makeExamBank({ scope: 'module', moduleId: m.moduleId, chapters: chs, chapterIndex: gIndex, prefix: `E${m.moduleNumber}L`, plan: EB.expectedExamPlan('module', chs) }));
    banks.set(m.moduleId, bank);
  }
  const fin = specialize(EBF.makeExamBank({ scope: 'final', moduleId: null, chapters: all, chapterIndex: gIndex, prefix: 'FL', plan: EB.expectedExamPlan('final', all) }));
  if (mutate) mutate(banks, fin);
  for (const [id, b] of banks) {
    const r = EB.validateExamBank(b, { scope: 'module', chapters: all.filter((x) => x.moduleId === id), chapterMd: c.contentMd });
    if (!mutate) assert(r.ok, `fixture de banco inválido (${id}): ${JSON.stringify(r.errors.slice(0, 3))}`);
  }
  if (!mutate) {
    const r = EB.validateExamBank(fin, { scope: 'final', chapters: all, chapterMd: c.contentMd });
    assert(r.ok, `fixture de banco final inválido: ${JSON.stringify(r.errors.slice(0, 3))}`);
  }
  c.examGift = new Map();
  c.finalExamGift = null;
  c.examBanks = banks;
  c.finalExamBank = fin;
  return { input, banks, fin };
}

async function readQuizzes(mbz) {
  const z = await JSZip.loadAsync(mbz);
  const questionsXml = await z.file('questions.xml').async('string');
  const cats = [];
  for (const m of questionsXml.matchAll(/<question_category id="(\d+)">([\s\S]*?)<\/question_category>/g)) {
    const x = m[2];
    const entries = [];
    for (const e of x.matchAll(/<question_bank_entry id="(\d+)">([\s\S]*?)<\/question_bank_entry>/g)) entries.push({ id: Number(e[1]), xml: e[2] });
    cats.push({
      id: Number(m[1]), name: dx(tag(x, 'name')), parent: Number(tag(x, 'parent')), sortorder: Number(tag(x, 'sortorder')),
      contextid: Number(tag(x, 'contextid')), contextlevel: Number(tag(x, 'contextlevel')), instance: Number(tag(x, 'contextinstanceid')), entries,
    });
  }
  const quizzes = [];
  for (const f of Object.keys(z.files).filter((n) => /^activities\/quiz_\d+\/quiz\.xml$/.test(n)).sort()) {
    const dir = path.dirname(f);
    const xml = await z.file(f).async('string');
    const mod = await z.file(`${dir}/module.xml`).async('string');
    const inforef = await z.file(`${dir}/inforef.xml`).async('string');
    const head = /<activity id="(\d+)" moduleid="(\d+)" modulename="quiz" contextid="(\d+)">/.exec(xml);
    const instances = [...xml.matchAll(/<question_instance id="\d+">([\s\S]*?)<\/question_instance>/g)].map((m) => m[1]);
    quizzes.push({
      dir, xml, inforef, idnumber: tag(mod, 'idnumber'), aid: Number(head[1]), mid: Number(head[2]), ctx: Number(head[3]),
      cats: cats.filter((c) => c.instance === Number(head[2])),
      slots: instances.map((x) => ({
        slot: Number(tag(x, 'slot')), page: Number(tag(x, 'page')), maxmark: tag(x, 'maxmark'),
        setref: /<question_set_reference /.test(x), ref: /<question_reference /.test(x),
        usingctx: Number(tag(x, 'usingcontextid')), qctx: Number(tag(x, 'questionscontextid')), filter: tag(x, 'filtercondition'),
      })),
    });
  }
  return { z, questionsXml, cats, quizzes };
}

/** Grupos esperados (orden del Manifest) de un examen. */
function expectedGroups(manifest, blueprint, quiz) {
  const titleOf = new Map();
  for (const m of blueprint.modules) {
    titleOf.set(m.id, m.title);
    for (const c of m.chapters) titleOf.set(c.id, c.title);
  }
  return quiz.idnumber === 'cv3:final_exam'
    ? manifest.modules.map((m) => ({ owner: m.moduleId, number: m.moduleNumber, kind: 'Módulo' }))
    : manifest.modules.find((m) => `cv3:exam:${m.moduleId}` === quiz.idnumber).chapters.map((c) => ({ owner: c.chapterId, number: c.chapterNumber, kind: 'Capítulo' }));
}

async function main() {
  const { input, banks, fin } = bankInput();
  const built = await B.buildDynamicMbzV3(input);
  if (OUT) {
    fs.writeFileSync(OUT, built.mbz);
    fs.writeFileSync(OUT.replace(/\.mbz$/, '') + '.banks.json', JSON.stringify({ modules: Object.fromEntries(banks), final: fin }, null, 1));
    console.log(`   paquete con bancos → ${OUT} (sha256 ${sha(built.mbz)})`);
  }
  const R = await readQuizzes(built.mbz);
  const bankOf = (q) => (q.idnumber === 'cv3:final_exam' ? fin : banks.get(q.idnumber.replace('cv3:exam:', '')));
  const ownerOfLeaf = (l) => ('chapterId' in l ? l.chapterId : l.moduleId);
  const ownerOfQ = (bank, q) => (bank.scope === 'final' ? q.moduleId : q.chapterId);

  await check('paquete con bancos: un quiz por examen (módulos con examen + final), todos en modo banco', () => {
    eq(R.quizzes.map((q) => q.idnumber).sort(), [...[...banks.keys()].map((id) => `cv3:exam:${id}`), 'cv3:final_exam'].sort(), 'quizzes');
  });

  await check('slots: #question_set_reference = slots del plan, sin question_reference, slot/página/contexto correctos', () => {
    for (const q of R.quizzes) {
      const bank = bankOf(q);
      eq(q.slots.length, EB.planSlotCount(bank.plan), `${q.idnumber}: slots`);
      assert(q.slots.every((s) => s.setref && !s.ref), `${q.idnumber}: todos los slots con question_set_reference y ninguno con question_reference`);
      assert(!/<question_reference /.test(q.xml), `${q.idnumber}: question_reference en un quiz de banco`);
      q.slots.forEach((s, i) => {
        eq([s.slot, s.page, s.usingctx, s.qctx], [i + 1, Math.ceil((i + 1) / 5), q.ctx, q.ctx], `${q.idnumber} slot ${i + 1}`);
      });
    }
  });

  await check('filtercondition: forma exacta de §2.2 (jointype 1, includesubcategories false, sin "cat"); hoja del MISMO quiz con ≥ piso; #referencias por hoja = slots del plan; orden = orden de categorías', () => {
    for (const q of R.quizzes) {
      const bank = bankOf(q);
      const byId = new Map(q.cats.map((c) => [c.id, c]));
      const leafRefs = new Map();
      let lastLeafOrder = -1;
      const leafOrder = q.cats.filter((c) => c.entries.length).map((c) => c.id);
      for (const s of q.slots) {
        const m = /^\{"filter":\{"category":\{"jointype":1,"values":\[(\d+)\],"filteroptions":\{"includesubcategories":false\}\}\}\}$/.exec(s.filter);
        assert(m, `${q.idnumber} slot ${s.slot}: filtercondition ${s.filter}`);
        const leaf = byId.get(Number(m[1]));
        assert(leaf, `${q.idnumber} slot ${s.slot}: la categoría ${m[1]} no es del quiz`);
        assert(leaf.entries.length > 0, `${q.idnumber}: la categoría ${leaf.name} no es una hoja`);
        const ord = leafOrder.indexOf(leaf.id);
        assert(ord >= lastLeafOrder, `${q.idnumber}: slots fuera del orden de categorías`);
        lastLeafOrder = ord;
        leafRefs.set(leaf.id, (leafRefs.get(leaf.id) || 0) + 1);
      }
      // hoja ↔ hoja del plan por las preguntas que contiene
      const qById = new Map(bank.questions.map((x) => [x.id, x]));
      for (const leaf of q.cats.filter((c) => c.entries.length)) {
        const ids = leaf.entries.map((e) => dx(/<name>([\s\S]*?)<\/name>/.exec(e.xml)[1]));
        const qs = ids.map((id) => qById.get(id));
        assert(qs.every(Boolean), `${q.idnumber}/${leaf.name}: pregunta desconocida`);
        const owner = ownerOfQ(bank, qs[0]);
        const type = qs[0].type;
        assert(qs.every((x) => ownerOfQ(bank, x) === owner && x.type === type), `${q.idnumber}/${leaf.name}: mezcla capítulos/tipos`);
        const planLeaf = bank.plan.find((l) => ownerOfLeaf(l) === owner && l.type === type);
        assert(planLeaf, `${q.idnumber}/${leaf.name}: hoja fuera del plan`);
        eq(leafRefs.get(leaf.id) || 0, planLeaf.slots, `${q.idnumber}/${leaf.name}: referencias = slots`);
        assert(ids.length >= EB.bankFloor(planLeaf.slots), `${q.idnumber}/${leaf.name}: ${ids.length} < piso ${EB.bankFloor(planLeaf.slots)}`);
        eq(ids.slice().sort(), bank.questions.filter((x) => ownerOfQ(bank, x) === owner && x.type === type).map((x) => x.id).sort(), `${q.idnumber}/${leaf.name}: TODAS las preguntas de la hoja`);
      }
      eq(q.cats.reduce((a, c) => a + c.entries.length, 0), bank.questions.length, `${q.idnumber}: todo el banco empaquetado`);
      eq(leafRefs.size, bank.plan.length, `${q.idnumber}: hojas referenciadas = hojas del plan`);
    }
  });

  await check('Σ maxmark = 100.0000000 exacto (sumgrades/grade 100) en cada quiz de banco', () => {
    for (const q of R.quizzes) {
      const units = q.slots.reduce((a, s) => {
        const [i, d] = s.maxmark.split('.');
        assert(d && d.length === 7, `${q.idnumber}: maxmark ${s.maxmark}`);
        return a + Number(i) * 1e7 + Number(d);
      }, 0);
      eq(units, 100 * 1e7, `${q.idnumber}: suma`);
      eq([tag(q.xml, 'sumgrades'), tag(q.xml, 'grade')], ['100.00000', '100.00000'], `${q.idnumber}: sumgrades/grade`);
    }
  });

  await check('árbol de categorías: top → «Por defecto en …» → «Capítulo N: título» | «Módulo N: título» → hojas por tipo (solo las del plan); contexto del quiz; sortorder determinístico', () => {
    for (const q of R.quizzes) {
      const bank = bankOf(q);
      assert(q.cats.every((c) => c.contextlevel === 70 && c.contextid === q.ctx && c.instance === q.mid), `${q.idnumber}: contexto`);
      const [top, def, ...rest] = q.cats;
      eq([top.name, top.parent, top.sortorder, top.entries.length], ['top', 0, 0, 0], `${q.idnumber}: top`);
      const quizName = dx(tag(q.xml, 'name'));
      eq([def.name, def.parent, def.sortorder, def.entries.length], [`Por defecto en ${quizName}`, top.id, 999, 0], `${q.idnumber}: por defecto`);
      const groups = expectedGroups(input.manifest, input.blueprint, q);
      const titleOf = new Map();
      for (const m of input.manifest.modules) {
        titleOf.set(m.moduleId, (input.blueprint.modules.find((x) => x.id === m.moduleId) || {}).title);
      }
      const plan = new Map(bank.plan.map((l) => [`${ownerOfLeaf(l)}|${l.type}`, l.slots]));
      const want = [];
      let gi = 0;
      for (const g of groups) {
        const types = EB.EXAM_QUESTION_TYPES.filter((t) => plan.has(`${g.owner}|${t}`));
        if (!types.length) continue;
        gi++;
        want.push({ kind: 'parent', sortorder: gi, owner: g.owner, number: g.number, label: g.kind });
        types.forEach((t, li) => want.push({ kind: 'leaf', sortorder: li + 1, type: t }));
      }
      eq(rest.length, want.length, `${q.idnumber}: #categorías`);
      let parent = null;
      rest.forEach((c, i) => {
        const w = want[i];
        if (w.kind === 'parent') {
          parent = c;
          assert(new RegExp(`^${w.label} ${w.number}: .+`).test(c.name), `${q.idnumber}: padre «${c.name}»`);
          eq([c.parent, c.sortorder, c.entries.length], [top.id, w.sortorder, 0], `${q.idnumber}: padre ${c.name}`);
        } else {
          eq([c.name, c.parent, c.sortorder], [`${parent.name} · ${LABEL[w.type]}`, parent.id, w.sortorder], `${q.idnumber}: hoja`);
          assert(c.entries.length > 0, `${q.idnumber}: hoja vacía ${c.name}`);
        }
      });
      // títulos reales del Manifest/Blueprint en los padres
      if (q.idnumber === 'cv3:final_exam') {
        for (const m of input.manifest.modules) {
          const t = input.blueprint.modules.find((x) => x.id === m.moduleId);
          assert(rest.some((c) => c.parent === top.id && c.name.startsWith(`Módulo ${m.moduleNumber}: `)), `final: falta Módulo ${m.moduleNumber}${t ? '' : ''}`);
        }
      }
    }
  });

  await check('inforef.xml de cada quiz lista TODAS sus categorías (top, por defecto, padres, hojas)', () => {
    for (const q of R.quizzes) {
      const listed = [...q.inforef.matchAll(/<question_category><id>(\d+)<\/id><\/question_category>/g)].map((m) => Number(m[1]));
      eq(listed.slice().sort((a, b) => a - b), q.cats.map((c) => c.id).sort((a, b) => a - b), `${q.idnumber}: inforef`);
    }
  });

  await check('preguntas: name = id, enunciado y explicación (format 1), MC con el `why` de cada opción, V/F con `whyWrong` en la equivocada, pares de emparejamiento; combinados vacíos; defaultmark 1', () => {
    let n = 0;
    for (const q of R.quizzes) {
      const bank = bankOf(q);
      const qById = new Map(bank.questions.map((x) => [x.id, x]));
      for (const c of q.cats) {
        for (const e of c.entries) {
          const x = e.xml;
          const b = qById.get(dx(tag(x, 'name')));
          assert(b, `${q.idnumber}: ${tag(x, 'name')}`);
          n++;
          eq([dx(tag(x, 'questiontext')), tag(x, 'questiontextformat')], [para(b.stem), '1'], `${b.id}: questiontext`);
          eq([dx(tag(x, 'generalfeedback')), tag(x, 'generalfeedbackformat')], [para(b.explanation), '1'], `${b.id}: generalfeedback`);
          eq([tag(x, 'qtype'), tag(x, 'defaultmark'), Number(tag(x, 'questioncategoryid'))], [b.type, '1.0000000', c.id], `${b.id}: qtype/defaultmark/categoría`);
          for (const k of ['correctfeedback', 'partiallycorrectfeedback', 'incorrectfeedback']) {
            if (b.type !== 'truefalse') eq(tag(x, k), '', `${b.id}: ${k} vacío`);
          }
          const answers = [...x.matchAll(/<answer id="\d+">([\s\S]*?)<\/answer>/g)].map((m) => ({
            text: dx(tag(m[1], 'answertext')), format: tag(m[1], 'answerformat'), fraction: tag(m[1], 'fraction'), feedback: dx(tag(m[1], 'feedback')), ff: tag(m[1], 'feedbackformat'),
          }));
          if (b.type === 'multichoice') {
            eq(answers, [
              { text: b.correct.text, format: '2', fraction: '1.0000000', feedback: para(b.correct.why), ff: '1' },
              ...b.distractors.map((d) => ({ text: d.text, format: '2', fraction: '0.0000000', feedback: para(d.why), ff: '1' })),
            ], `${b.id}: opciones MC`);
            eq([tag(x, 'single'), tag(x, 'shuffleanswers')], ['1', '1'], `${b.id}: single/shuffle`);
          } else if (b.type === 'truefalse') {
            eq(answers, [
              { text: 'Verdadero', format: '0', fraction: b.answer ? '1.0000000' : '0.0000000', feedback: b.answer ? '' : para(b.whyWrong), ff: '1' },
              { text: 'Falso', format: '0', fraction: b.answer ? '0.0000000' : '1.0000000', feedback: b.answer ? para(b.whyWrong) : '', ff: '1' },
            ], `${b.id}: V/F`);
          } else {
            // fix 1: subpregunta = definición, opción del desplegable = término
            const pairs = [...x.matchAll(/<match id="\d+"><questiontext>([\s\S]*?)<\/questiontext><questiontextformat>2<\/questiontextformat><answertext>([\s\S]*?)<\/answertext><\/match>/g)].map((m) => ({ term: dx(m[2]), definition: dx(m[1]) }));
            eq(pairs, b.pairs, `${b.id}: pares (definición → subpregunta, término → opción)`);
            assert(b.pairs.every((p) => !/[<>]/.test(p.term) && p.term.trim().length <= 60), `${b.id}: términos cortos sin < >`);
          }
        }
      }
    }
    eq(n, [...banks.values(), fin].reduce((a, b) => a + b.questions.length, 0), 'preguntas revisadas');
  });

  await check('escape: & < > " y apóstrofes del banco llegan escapados (XML bien formado en questions.xml y quiz.xml; HTML con &#39;)', () => {
    assertWellFormed(R.questionsXml, 'questions.xml');
    for (const q of R.quizzes) {
      assertWellFormed(q.xml, `${q.dir}/quiz.xml`);
      assertWellFormed(q.inforef, `${q.dir}/inforef.xml`);
    }
    // HTML (format 1) dentro de XML: doble escape; texto plano (format 2): escape XML simple.
    assert(R.questionsXml.includes('&lt;p&gt;') && R.questionsXml.includes('&amp;#39;') && R.questionsXml.includes('&amp;amp;') && R.questionsXml.includes('&amp;lt;x&amp;gt;'), 'HTML escapado');
    assert(R.questionsXml.includes(`<answertext>${'Revisar'}`) && R.questionsXml.includes(' &amp; &lt;ok&gt; &quot;q&quot; d\'x</answertext>'), 'opción plana escapada (apóstrofe literal, como xmlEsc)');
    assert(!/<p>[^<]*<\/p>/.test(R.questionsXml.replace(/&lt;p&gt;/g, '')), 'sin <p> crudo');
  });

  await check('facts: preguntas del examen = SLOTS (no banco), bankSize = banco; módulos y final', () => {
    const f = built.expectations.facts;
    for (const m of f.modules.filter((x) => x.examEnabled)) {
      const b = banks.get(m.id);
      eq([m.examQuestionCount, m.examBankSize], [EB.planSlotCount(b.plan), b.questions.length], `módulo ${m.number}`);
    }
    eq([f.finalExam.questionCount, f.finalExam.bankSize], [EB.planSlotCount(fin.plan), fin.questions.length], 'final');
    assert(EB.planSlotCount(fin.plan) < fin.questions.length, 'banco > slots');
  });

  await check('validateMbzV3 acepta el paquete con bancos; el builder es determinista', async () => {
    const v = await V.validateMbzV3(built.mbz, built.expectations);
    assert(v.ok, `validador: ${JSON.stringify(v.issues.slice(0, 5))}`);
    const again = await B.buildDynamicMbzV3(bankInput().input);
    eq(sha(again.mbz), sha(built.mbz), 'sha');
    eq(built.summary.builderVersion, B.DYNAMIC_MBZ_BUILDER_VERSION_V3, 'versión');
  });

  await check('A4: evidencia que no está en el Markdown de su capítulo → EXAM_BANK_INVALID [EXAM_BANK_EVIDENCE] (builder); banco bajo el piso → EXAM_BANK_INVALID', async () => {
    const bad = bankInput((mods) => { [...mods.values()][0].questions[3].evidence = 'Una frase que ningún capítulo de este curso dijo jamás sobre la planta.'; });
    await rejects(B.buildDynamicMbzV3(bad.input), /^EXAM_BANK_INVALID: exam:\S+ \[EXAM_BANK_EVIDENCE\]/, 'evidencia');
    const badF = bankInput((_m, f) => { f.questions[0].evidence = 'Una frase que ningún capítulo de este curso dijo jamás sobre la planta.'; });
    await rejects(B.buildDynamicMbzV3(badF.input), /^EXAM_BANK_INVALID: final_exam\S* \[EXAM_BANK_EVIDENCE\]/, 'evidencia final');
    const short = bankInput((mods) => {
      const b = [...mods.values()][0];
      const leaf = b.plan[0];
      const victims = b.questions.filter((x) => x.chapterId === leaf.chapterId && x.type === leaf.type).slice(0, leaf.slots);
      b.questions = b.questions.filter((x) => !victims.includes(x));
    });
    await rejects(B.buildDynamicMbzV3(short.input), /^EXAM_BANK_INVALID: exam:\S+ \[.*EXAM_BANK_LEAF_COUNT/, 'piso');
  });

  await check('fix 1: término con < > → EXAM_BANK_MATCH; carácter de control C0 → EXAM_BANK_SCHEMA; plan congelado que no cubre un capítulo actual → EXAM_BANK_PLAN (builder, falla fuerte)', async () => {
    const lt = bankInput((mods) => { [...mods.values()][0].questions.find((x) => x.type === 'match').pairs[0].term = 'Carga <5 kg'; });
    await rejects(B.buildDynamicMbzV3(lt.input), /^EXAM_BANK_INVALID: exam:\S+ \[EXAM_BANK_MATCH\]/, 'término con <');
    const ctl = bankInput((_m, f) => { f.questions[0].explanation += '\u0007'; });
    await rejects(B.buildDynamicMbzV3(ctl.input), /^EXAM_BANK_INVALID: final_exam\S* \[EXAM_BANK_SCHEMA\]/, 'control');
    const cut = bankInput((mods) => {
      // banco «viejo» cuyo plan congelado (bien formado, pertenencia OK) omite el último capítulo del módulo
      const b = [...mods.values()][0];
      const last = b.plan[b.plan.length - 1].chapterId;
      b.plan = b.plan.filter((l) => l.chapterId !== last);
      b.questions = b.questions.filter((x) => x.chapterId !== last);
    });
    await rejects(B.buildDynamicMbzV3(cut.input), /^EXAM_BANK_INVALID: exam:\S+ \[EXAM_BANK_PLAN\] el plan congelado del banco no cubre/, 'cobertura');
  });

  await check('GIFT: sin question_set_reference (slots fijos de siempre)' + (process.env.BASE_DIST ? ' y byte a byte el builder de la base (BASE_DIST)' : ''), async () => {
    const g = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 734 }));
    const RG = await readQuizzes(g.mbz);
    assert(RG.quizzes.length > 0 && RG.quizzes.every((q) => q.slots.every((s) => s.ref && !s.setref)), 'GIFT con question_reference');
    assert(g.expectations.facts.modules.every((m) => !('examBankSize' in m)) && !('bankSize' in g.expectations.facts.finalExam), 'facts GIFT sin campos de banco');
    if (process.env.BASE_DIST) {
      const baseRoot = path.resolve(process.env.BASE_DIST);
      const BB = loadDist('package/dynamic-mbz-builder-v3.js', baseRoot);
      for (const o of [{ engine: 'h5p', finalExam: true, courseId: 734 }, { engine: 'scorm', finalExam: false, courseId: 735 }]) {
        const mine = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, o));
        const base = await BB.buildDynamicMbzV3(PF.packagingInput(baseRoot, o));
        eq(sha(mine.mbz), sha(base.mbz), `sha GIFT ${o.engine}`);
        eq([mine.summary.builderVersion, base.summary.builderVersion], [B.DYNAMIC_MBZ_BUILDER_VERSION_V3, '3.3.0'], 'solo cambia la versión');
        console.log(`   sha256 GIFT (${o.engine}, ${o.courseId}) = base: ${sha(mine.mbz)}`);
      }
    }
  });

  console.log(`\n${passes} OK, ${failures} FALLAS`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
