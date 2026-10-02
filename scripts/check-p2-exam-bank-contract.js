#!/usr/bin/env node
/* eslint-disable */
// Cursia EV6 P2-B2 — contrato del banco de preguntas (`dynamic_exam_bank_json`, bankVersion 1).
// Puro: sin DB, sin red (fetch prohibido).
//
//  - plan de slots: espejo de dynExamQuestionSplit / dynFinalExamQuestionSplit, hojas por
//    capítulo × tipo (1, 2, 3, 4, 7 capítulos) y módulo × tipo (final de 1/3/2 y 3/2 capítulos),
//    bankFloor / bankTarget / pedido / máximo;
//  - normalización (valores dorados que el frontend replica);
//  - fixtures commiteados (test/fixtures/exam-bank-v1) = los que genera scripts/lib/exam-bank-fixtures.js
//    (`--write-fixtures` los regenera) y validan limpios con la evidencia;
//  - un negativo por código (MISSING_FIELD, UNKNOWN_FIELD, EXAM_BANK_SCHEMA, _PLAN, _LEAF_COUNT,
//    _DUPLICATE, _LENGTH_BIAS, _OPTION_LINT, _TF_BALANCE, _MATCH, _EVIDENCE);
//  - dispatcher server-side (validateV3ItemArtifact): banco de exam y final_exam (questionCount = slots),
//    GIFT final como siempre, GIFT de módulo sin validación; roles con alternativas
//    (resolveRequiredArtifactTypesV3 / EXAM_ARTIFACT_AMBIGUOUS);
//  - empaque: resolveRunArtifactsV3 + loadContentsV3 con bancos → ExamSource 'bank', evidencia mala →
//    EXAM_BANK_INVALID, builder (P2-B3) → quiz de slots aleatorios; con GIFT el .mbz es byte a byte el de la
//    entrada directa (y, con BASE_DIST=<dist de la base>, el mismo sha256 que el builder anterior).
//
// Usage: node scripts/check-p2-exam-bank-contract.js [path/to/dist] [--write-fixtures]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const WRITE = args.includes('--write-fixtures');
const ROOT = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'dist'));
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

const EB = loadDist('modules/course-shell/exam-bank.js');
const S = loadDist('modules/course-shell/index.js');
const R = loadDist('modules/dynamic-packaging/artifact-resolver.js');
const PK = loadDist('modules/dynamic-packaging/packaging-v3.js');
const PV3 = loadDist('modules/dynamic-packaging/packaging-plan-v3.js');
const B = loadDist('package/dynamic-mbz-builder-v3.js');
const PF = require('./lib/v21-packaging-fixtures');
const SF = require('./lib/v21-shell-fixtures');
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
const clone = (v) => JSON.parse(JSON.stringify(v));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const codes = (r) => [...new Set(r.errors.map((e) => e.code))].sort();

// ── Fixtures del contrato ──
const FX_DIR = path.join(ROOT, 'test/fixtures/exam-bank-v1');
const M1 = '00000000-0000-4000-8000-0000000e0a01';
const M2 = '00000000-0000-4000-8000-0000000e0a02';
const ch = (n) => `00000000-0000-4000-8000-0000000e0c0${n}`;
const CHAPTERS = [
  { id: ch(1), moduleId: M1, title: 'Arranque seguro de la línea' },
  { id: ch(2), moduleId: M1, title: 'Bitácora del turno' },
  { id: ch(3), moduleId: M1, title: 'Controles previos' },
  { id: ch(4), moduleId: M2, title: 'Paradas de emergencia' },
  { id: ch(5), moduleId: M2, title: 'Entrega de turno' },
];
const MOD_CH = CHAPTERS.filter((c) => c.moduleId === M1).map(({ id, moduleId }) => ({ id, moduleId }));
const ALL_CH = CHAPTERS.map(({ id, moduleId }) => ({ id, moduleId }));
function buildFixtures() {
  const chapterMd = Object.fromEntries(CHAPTERS.map((c, i) => [c.id, EBF.chapterMarkdown(i, c.title)]));
  return {
    'chapters.json': {
      description: 'EV6 P2-B2: capítulos del fixture (orden del Manifest) y su Markdown; la evidencia de los bancos está copiada literal de aquí. Generado por scripts/lib/exam-bank-fixtures.js.',
      modules: [{ moduleId: M1, chapterIds: [ch(1), ch(2), ch(3)] }, { moduleId: M2, chapterIds: [ch(4), ch(5)] }],
      chapters: CHAPTERS.map((c) => ({ ...c, markdown: chapterMd[c.id] })),
    },
    'module-bank.json': EBF.makeExamBank({ scope: 'module', moduleId: M1, chapters: MOD_CH, plan: EB.moduleExamPlan(MOD_CH.map((c) => c.id)) }),
    'final-bank.json': EBF.makeExamBank({ scope: 'final', moduleId: null, chapters: ALL_CH, plan: EB.expectedExamPlan('final', ALL_CH) }),
  };
}

async function main() {
  // ── 1. Plan de slots ──
  await check('examSlotSplit / finalExamSlotSplit = dynExamQuestionSplit / dynFinalExamQuestionSplit (1–12 capítulos; 3 → 25)', () => {
    const want = {
      1: [8, 5, 2, 1], 2: [17, 10, 3, 4], 3: [25, 15, 5, 5], 4: [33, 20, 7, 6], 5: [42, 25, 8, 9], 6: [50, 30, 10, 10],
      7: [58, 35, 12, 11], 8: [67, 40, 13, 14], 9: [75, 45, 15, 15], 10: [83, 50, 17, 16], 11: [92, 55, 18, 19], 12: [100, 60, 20, 20],
    };
    for (const [n, [t, mc, tf, ma]] of Object.entries(want)) eq(EB.examSlotSplit(Number(n)), { total: t, multichoice: mc, truefalse: tf, match: ma }, `split ${n}`);
    eq(EB.examSlotSplit(0), EB.examSlotSplit(1), 'mínimo 1 capítulo');
    eq(EB.finalExamSlotSplit(4), EB.examSlotSplit(4), 'final ≤ 40 = módulo');
    eq(EB.finalExamSlotSplit(5), { total: 40, multichoice: 24, truefalse: 8, match: 8 }, 'final tope 40');
    eq(EB.finalExamSlotSplit(12), { total: 40, multichoice: 24, truefalse: 8, match: 8 }, 'final tope 40 (12)');
  });

  const leafRows = (plan) => plan.map((l) => `${l.chapterId || l.moduleId}:${l.type}:${l.slots}`);
  await check('moduleExamPlan: 1, 2, 3 (= 25: MC 5/5/5, TF 2/2/1, match 2/2/1), 4 y 7 capítulos; hojas con 0 slots omitidas', () => {
    const P = (k) => leafRows(EB.moduleExamPlan(Array.from({ length: k }, (_, i) => `c${i + 1}`)));
    eq(P(1), ['c1:multichoice:5', 'c1:truefalse:2', 'c1:match:1'], '1');
    eq(P(2), ['c1:multichoice:5', 'c2:multichoice:5', 'c1:truefalse:2', 'c2:truefalse:1', 'c1:match:2', 'c2:match:2'], '2');
    eq(P(3), ['c1:multichoice:5', 'c2:multichoice:5', 'c3:multichoice:5', 'c1:truefalse:2', 'c2:truefalse:2', 'c3:truefalse:1', 'c1:match:2', 'c2:match:2', 'c3:match:1'], '3');
    eq(EB.planSlotCount(EB.moduleExamPlan(['a', 'b', 'c'])), 25, '3 caps = 25');
    eq(P(4), ['c1:multichoice:5', 'c2:multichoice:5', 'c3:multichoice:5', 'c4:multichoice:5', 'c1:truefalse:2', 'c2:truefalse:2', 'c3:truefalse:2', 'c4:truefalse:1',
      'c1:match:2', 'c2:match:2', 'c3:match:1', 'c4:match:1'], '4');
    eq(P(7), [...[1, 2, 3, 4, 5, 6, 7].map((i) => `c${i}:multichoice:5`), ...[2, 2, 2, 2, 2, 1, 1].map((s, i) => `c${i + 1}:truefalse:${s}`),
      ...[2, 2, 2, 2, 1, 1, 1].map((s, i) => `c${i + 1}:match:${s}`)], '7');
    for (const k of [1, 2, 3, 4, 7]) eq(EB.planSlotCount(EB.moduleExamPlan(Array.from({ length: k }, (_, i) => `c${i}`))), EB.examSlotSplit(k).total, `suma ${k}`);
    // 10 capítulos: TF 17 → base 1, +1 a los 7 primeros; nunca 0 slots aquí. 1 capítulo con match 1 → hoja de 1 slot.
    const ten = EB.moduleExamPlan(Array.from({ length: 10 }, (_, i) => `c${i}`));
    assert(ten.every((l) => l.slots > 0), 'sin hojas vacías');
    let threw = false; try { EB.moduleExamPlan([]); } catch (e) { threw = /EXAM_BANK_PLAN/.test(e.message); } assert(threw, 'sin capítulos lanza');
  });

  await check('finalExamPlan: módulos de 1/3/2 capítulos (40 slots: MC 4/12/8, TF 1/4/3, match 1/4/3) y 3/2 (MC 14/10, TF 5/3, match 5/3); restos mayores enteros, empate → módulo anterior', () => {
    const mods = [{ moduleId: 'A', chapterIds: ['a1'] }, { moduleId: 'B', chapterIds: ['b1', 'b2', 'b3'] }, { moduleId: 'C', chapterIds: ['c1', 'c2'] }];
    eq(leafRows(EB.finalExamPlan(mods)), ['A:multichoice:4', 'B:multichoice:12', 'C:multichoice:8', 'A:truefalse:1', 'B:truefalse:4', 'C:truefalse:3', 'A:match:1', 'B:match:4', 'C:match:3'], '1/3/2');
    eq(EB.planSlotCount(EB.finalExamPlan(mods)), 40, 'suma 40');
    eq(leafRows(EB.finalExamPlan([{ moduleId: 'A', chapterIds: ['1', '2', '3'] }, { moduleId: 'B', chapterIds: ['4', '5'] }])),
      ['A:multichoice:14', 'B:multichoice:10', 'A:truefalse:5', 'B:truefalse:3', 'A:match:5', 'B:match:3'], '3/2');
    // 2/1 (3 capítulos = 25): TF 5·2/3 = 3 r1, 5·1/3 = 1 r2 → el resto mayor (B) gana.
    eq(leafRows(EB.finalExamPlan([{ moduleId: 'A', chapterIds: ['1', '2'] }, { moduleId: 'B', chapterIds: ['3'] }])),
      ['A:multichoice:10', 'B:multichoice:5', 'A:truefalse:3', 'B:truefalse:2', 'A:match:3', 'B:match:2'], '2/1');
    // empate de restos → módulo anterior: 1/1 con TF 3 → 2/1.
    eq(leafRows(EB.finalExamPlan([{ moduleId: 'A', chapterIds: ['1'] }, { moduleId: 'B', chapterIds: ['2'] }])),
      ['A:multichoice:5', 'B:multichoice:5', 'A:truefalse:2', 'B:truefalse:1', 'A:match:2', 'B:match:2'], '1/1 empate');
    // un módulo sin capítulos no recibe hojas
    eq(leafRows(EB.finalExamPlan([{ moduleId: 'A', chapterIds: [] }, { moduleId: 'B', chapterIds: ['1'] }])), ['B:multichoice:5', 'B:truefalse:2', 'B:match:1'], 'módulo vacío');
    eq(EB.expectedExamPlan('final', ALL_CH), EB.finalExamPlan([{ moduleId: M1, chapterIds: [ch(1), ch(2), ch(3)] }, { moduleId: M2, chapterIds: [ch(4), ch(5)] }]), 'expectedExamPlan agrupa por módulo');
  });

  await check('bankFloor / bankTarget / pedido / máximo por hoja', () => {
    eq([1, 2, 3, 4, 5, 12].map(EB.bankFloor), [2, 3, 5, 6, 8, 18], 'floor = max(s+1, ceil(1.5 s))');
    eq([1, 2, 5].map(EB.bankTarget), [2, 4, 10], 'target 2s');
    eq([1, 2, 5].map(EB.bankRequested), [3, 5, 11], 'pedido 2s+1');
    eq([1, 2, 5].map(EB.bankMax), [4, 6, 12], 'máximo 2s+2');
  });

  await check('normalizeExamText: NFD sin diacríticos, minúsculas, invisibles, viñetas, sin *_#>`[]()|, tipografía plegada, espacios colapsados (valores dorados para el frontend)', () => {
    const gold = [
      ['  **Árbol**  de\n\tdecisión  ', 'arbol de decision'],
      ['> Nota: el `PH` [ver](x) | Ñandú_2 #tag', 'nota: el ph verx nandu2 tag'],
      ['Señal \u2014 \u201cúnica\u201d, 30\u00a0%', 'senal - "unica", 30 %'],
      ['\u00abHola\u00bb \u2018tú\u2019 \u2013 fin\u00ad! \u2026', '"hola" \'tu\' - fin! ...'],
      ['- 1. Primero\n2) Segundo\u202fpaso\n* tercero\n  + cuarto\n> - cita\n\u2022 punto', '1. primero segundo paso tercero cuarto cita punto'],
      ['**Regla 1:** texto\u200b', 'regla 1: texto'],
      ['', ''],
    ];
    for (const [i, o] of gold) eq(EB.normalizeExamText(i), o, JSON.stringify(i));
    // evidencia que cruza dos viñetas del capítulo
    const md = '- **Paso 1:** cerrar la válvula principal.\n- **Paso 2:** abrir la purga lentamente.';
    assert(EB.normalizeExamText(md).includes(EB.normalizeExamText('Paso 1: cerrar la válvula principal. Paso 2: abrir la purga')), 'evidencia entre viñetas');
    // el fuente no tiene caracteres combinantes crudos (M6): todo escape \uXXXX
    const src = fs.readFileSync(path.join(ROOT, 'src/modules/course-shell/exam-bank.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export function normalizeExamText'), src.indexOf('/** Tokens de un texto'));
    assert(/^[\x00-\x7f]*$/.test(fn), 'normalizeExamText con caracteres no ASCII en el fuente');
    eq(EB.EXAM_OPTION_FORBIDDEN_RE.source,
      '^(?:(?:todas|ninguna|ambas) (?:de )?(?:las |los )?(?:otras |otros |demas )?(?:anteriores|opciones|respuestas|alternativas|demas)(?: anteriores)?(?: (?:son|es) (?:correctas?|incorrectas?|validas?))?|(?:todas|ambas|ninguna) (?:son|es) (?:correctas?|incorrectas?|validas?)|[a-e] y [a-e] (?:son )?correctas?)[.!]?$',
      'regex literal (byte-idéntica en F2)');
    eq(EB.EXAM_OPTION_FORBIDDEN_RE.flags, '', 'flags (se aplica al texto normalizado)');
    eq(EB.EXAM_TOKEN_RE.source, '\\p{N}+(?:[.,]\\p{N}+)*|\\p{L}+', 'regex de tokens');
    eq(EB.EXAM_TOKEN_RE.flags, 'gu', 'flags tokens');
    eq(EB.EXAM_BANK_ID_RE.source, '^[A-Za-z0-9_-]{1,40}$', 'regex id');
  });

  // ── 2. Fixtures + validación ──
  const built = buildFixtures();
  if (WRITE) {
    fs.mkdirSync(FX_DIR, { recursive: true });
    for (const [f, v] of Object.entries(built)) fs.writeFileSync(path.join(FX_DIR, f), JSON.stringify(v, null, 2) + '\n');
    console.log(`(fixtures escritos en ${FX_DIR})`);
  }
  const fx = Object.fromEntries(Object.keys(built).map((f) => [f, JSON.parse(fs.readFileSync(path.join(FX_DIR, f), 'utf8'))]));
  const MD = new Map(fx['chapters.json'].chapters.map((c) => [c.id, c.markdown]));
  const MOD = fx['module-bank.json'];
  const FIN = fx['final-bank.json'];
  const vMod = (doc, md = MD) => EB.validateExamBank(doc, { scope: 'module', chapters: MOD_CH, chapterMd: md });
  const vFin = (doc, md = MD) => EB.validateExamBank(doc, { scope: 'final', chapters: ALL_CH, chapterMd: md });

  await check('fixtures commiteados = los del generador (test/fixtures/exam-bank-v1; --write-fixtures los regenera)', () => {
    for (const f of Object.keys(built)) eq(fx[f], built[f], f);
  });

  await check('fixture módulo (3 capítulos, 50 preguntas) y final (2 módulos 3/2, 80 preguntas) validan limpios con la evidencia', () => {
    const a = vMod(MOD);
    eq([a.ok, a.slotCount, a.bankSize, a.errors], [true, 25, 50, []], 'módulo');
    const b = vFin(FIN);
    eq([b.ok, b.slotCount, b.bankSize, b.errors], [true, 40, 80, []], 'final');
    // sin Markdown (completeItem): mismo resultado, la evidencia no se re-chequea
    eq(EB.validateExamBank(MOD, { scope: 'module', chapters: MOD_CH }).ok, true, 'sin chapterMd');
    const mc = MOD.questions.filter((q) => q.type === 'multichoice');
    const longest = mc.filter((q) => q.correct.text.trim().length > Math.max(...q.distractors.map((d) => d.text.trim().length))).length;
    eq([mc.length, longest], [30, 6], 'la correcta es la más larga en el 20 %');
  });

  const negatives = [
    ['MISSING_FIELD (raíz)', vMod, (d) => { delete d.plan; }, 'MISSING_FIELD'],
    ['MISSING_FIELD (pregunta)', vMod, (d) => { delete d.questions[0].evidence; }, 'MISSING_FIELD'],
    ['UNKNOWN_FIELD (pregunta)', vMod, (d) => { d.questions[0].hint = 'pista'; }, 'UNKNOWN_FIELD'],
    ['UNKNOWN_FIELD (moduleId en un banco de módulo)', vMod, (d) => { d.questions[0].moduleId = M1; }, 'UNKNOWN_FIELD'],
    ['MISSING_FIELD (moduleId en el final)', vFin, (d) => { delete d.questions[0].moduleId; }, 'MISSING_FIELD'],
    ['EXAM_BANK_SCHEMA (enunciado corto)', vMod, (d) => { d.questions[0].stem = 'Muy corto'; }, 'EXAM_BANK_SCHEMA'],
    ['EXAM_BANK_SCHEMA (4 distractores)', vMod, (d) => { d.questions[0].distractors.push({ text: 'Otra cosa', why: 'Una razón suficientemente larga.' }); }, 'EXAM_BANK_SCHEMA'],
    ['EXAM_BANK_SCHEMA (level)', vMod, (d) => { d.questions[0].level = 'crear'; }, 'EXAM_BANK_SCHEMA'],
    ['EXAM_BANK_SCHEMA (id)', vMod, (d) => { d.questions[0].id = 'id con espacios'; }, 'EXAM_BANK_SCHEMA'],
    ['EXAM_BANK_SCHEMA (chapterId ajeno)', vMod, (d) => { d.questions[0].chapterId = ch(4); }, 'EXAM_BANK_SCHEMA'],
    ['EXAM_BANK_SCHEMA (moduleId ≠ módulo del capítulo, final)', vFin, (d) => { d.questions[0].moduleId = M2; }, 'EXAM_BANK_SCHEMA'],
    ['EXAM_BANK_SCHEMA (answer no booleano)', vMod, (d) => { d.questions.find((q) => q.type === 'truefalse').answer = 'true'; }, 'EXAM_BANK_SCHEMA'],
    ['EXAM_BANK_SCHEMA (3 pares)', vMod, (d) => { d.questions.find((q) => q.type === 'match').pairs.pop(); }, 'EXAM_BANK_SCHEMA'],
    ['EXAM_BANK_SCHEMA (bankVersion 2)', vMod, (d) => { d.bankVersion = 2; }, 'EXAM_BANK_SCHEMA'],
    ['EXAM_BANK_SCHEMA (scope)', vMod, (d) => { d.scope = 'final'; }, 'EXAM_BANK_SCHEMA'],
    ['EXAM_BANK_PLAN (slots)', vMod, (d) => { d.plan[0].slots += 1; }, 'EXAM_BANK_PLAN'],
    ['EXAM_BANK_PLAN (orden)', vMod, (d) => { d.plan.reverse(); }, 'EXAM_BANK_PLAN'],
    ['EXAM_BANK_LEAF_COUNT (hoja bajo el piso)', vMod, (d) => { const ids = d.questions.filter((q) => q.chapterId === ch(1) && q.type === 'multichoice').slice(0, 3).map((q) => q.id); d.questions = d.questions.filter((q) => !ids.includes(q.id)); }, 'EXAM_BANK_LEAF_COUNT'],
    ['EXAM_BANK_LEAF_COUNT (hoja sin slots)', vMod, (d) => { const q = clone(d.questions.find((x) => x.type === 'truefalse' && x.chapterId === ch(3))); q.id = 'extra-1'; q.stem = 'Caso extra: una pregunta de un tipo que no tiene slots.'; d.questions.push(q); d.questions = d.questions.filter((x) => !(x.type === 'match' && x.chapterId === ch(3))); }, 'EXAM_BANK_LEAF_COUNT'],
    ['EXAM_BANK_DUPLICATE (id)', vMod, (d) => { d.questions[1].id = d.questions[0].id; }, 'EXAM_BANK_DUPLICATE'],
    ['EXAM_BANK_DUPLICATE (enunciado normalizado)', vMod, (d) => { d.questions[1].stem = `  ${d.questions[0].stem.toUpperCase()} `; }, 'EXAM_BANK_DUPLICATE'],
    ['EXAM_BANK_LENGTH_BIAS (outlier ≥ 8 y ≥ 15 %)', vMod, (d) => { d.questions[0].correct.text += ' con todos los pasos'; }, 'EXAM_BANK_LENGTH_BIAS'],
    ['EXAM_BANK_LENGTH_BIAS (> 30 % más larga)', vMod, (d) => { d.questions.filter((q) => q.type === 'multichoice').slice(0, 10).forEach((q) => { q.correct.text = q.correct.text.replace('Revisar', 'Revisarlo'); }); }, 'EXAM_BANK_LENGTH_BIAS'],
    ['EXAM_BANK_OPTION_LINT («ninguna de las anteriores»)', vMod, (d) => { d.questions[0].distractors[0].text = 'Ninguna de las anteriores'; }, 'EXAM_BANK_OPTION_LINT'],
    ['EXAM_BANK_OPTION_LINT («todas son correctas»)', vMod, (d) => { d.questions[0].distractors[1].text = 'Todas son correctas'; }, 'EXAM_BANK_OPTION_LINT'],
    ['EXAM_BANK_OPTION_LINT (contención)', vMod, (d) => { d.questions[0].distractors[2].text = d.questions[0].correct.text.slice(0, 10); }, 'EXAM_BANK_OPTION_LINT'],
    ['EXAM_BANK_OPTION_LINT (iguales tras normalizar)', vMod, (d) => { d.questions[0].distractors[0].text = `**${d.questions[0].correct.text.toUpperCase()}**`; }, 'EXAM_BANK_OPTION_LINT'],
    ['EXAM_BANK_TF_BALANCE (≥ 4: 3/4 verdaderas)', vMod, (d) => { d.questions.filter((q) => q.type === 'truefalse' && q.chapterId === ch(1)).forEach((q, i) => { q.answer = i < 3; }); }, 'EXAM_BANK_TF_BALANCE'],
    ['EXAM_BANK_TF_BALANCE (2: misma respuesta)', vMod, (d) => { d.questions.filter((q) => q.type === 'truefalse' && q.chapterId === ch(3)).forEach((q) => { q.answer = false; }); }, 'EXAM_BANK_TF_BALANCE'],
    ['EXAM_BANK_TF_BALANCE (final, por módulo)', vFin, (d) => { d.questions.filter((q) => q.type === 'truefalse' && q.moduleId === M2).forEach((q) => { q.answer = true; }); }, 'EXAM_BANK_TF_BALANCE'],
    ['EXAM_BANK_MATCH (término repetido)', vMod, (d) => { const q = d.questions.find((x) => x.type === 'match'); q.pairs[1].term = q.pairs[0].term.toLowerCase(); }, 'EXAM_BANK_MATCH'],
    ['EXAM_BANK_MATCH (definición repetida)', vMod, (d) => { const q = d.questions.find((x) => x.type === 'match'); q.pairs[1].definition = q.pairs[0].definition; }, 'EXAM_BANK_MATCH'],
    ['EXAM_BANK_MATCH (la definición contiene su término)', vMod, (d) => { const q = d.questions.find((x) => x.type === 'match'); q.pairs[0].definition = `La ${q.pairs[0].term} del turno`; }, 'EXAM_BANK_MATCH'],
    ['EXAM_BANK_MATCH (término con < o >, fix 1 P2-B3)', vMod, (d) => { const q = d.questions.find((x) => x.type === 'match'); q.pairs[0].term = 'Carga <5 kg'; }, 'EXAM_BANK_MATCH'],
    ['EXAM_BANK_SCHEMA (término > 60, fix 1 P2-B3)', vMod, (d) => { const q = d.questions.find((x) => x.type === 'match'); q.pairs[0].term = 'T'.repeat(61); }, 'EXAM_BANK_SCHEMA'],
    ['EXAM_BANK_SCHEMA (carácter de control C0, fix 1 P2-B3)', vMod, (d) => { d.questions[0].correct.why += '\u0000'; }, 'EXAM_BANK_SCHEMA'],
    ['EXAM_BANK_SCHEMA (CR, fix 1 P2-B3)', vFin, (d) => { d.questions[0].stem += '\r'; }, 'EXAM_BANK_SCHEMA'],
    ['EXAM_BANK_EVIDENCE (no está en el capítulo)', vMod, (d) => { d.questions[0].evidence = 'Una frase inventada que el capítulo nunca dijo sobre la planta ni sobre el turno.'; }, 'EXAM_BANK_EVIDENCE'],
    ['EXAM_BANK_EVIDENCE (está en OTRO capítulo)', vMod, (d) => { d.questions[0].evidence = EBF.evidenceSentence(1, 0); }, 'EXAM_BANK_EVIDENCE'],
  ];
  await check(`un negativo por código (${negatives.length} casos): el código esperado aparece y el fixture sin tocar sigue limpio`, () => {
    for (const [name, v, mut, code] of negatives) {
      const base = v === vMod ? MOD : FIN;
      const d = clone(base);
      mut(d);
      const r = v(d);
      assert(!r.ok && codes(r).includes(code), `${name}: ${JSON.stringify(codes(r))} sin ${code}`);
    }
    // evidencia con Markdown distinto (negritas, acentos, espacios) sigue valiendo: normalización
    const d = clone(MOD);
    d.questions[0].evidence = `  ${d.questions[0].evidence.toUpperCase().replace(/ /g, '   ')}  `;
    eq(vMod(d).ok, true, 'evidencia normalizada');
    // nunca lanza por contenido
    for (const bad of [null, 'x', [], { bankVersion: 1 }, { ...clone(MOD), questions: [null, 3, 'x'] }]) {
      const r = vMod(bad);
      assert(!r.ok && r.errors.length > 0, `contenido ${JSON.stringify(bad).slice(0, 40)}`);
    }
    let threw = false; try { EB.validateExamBank(MOD, { scope: 'module', chapters: [] }); } catch (e) { threw = /EXAM_BANK_CONTEXT/.test(e.message); } assert(threw, 'contexto sin capítulos lanza');
  });

  await check('lints por palabras completas (I2/M4) y opciones prohibidas (M3)', () => {
    const C = EB.examTextContains;
    eq([C('15 mg/L de cloro libre', '5 mg/L de cloro libre'), C('50 mg/L', '5 mg/L'), C('12 horas', '2 horas'), C('2,5 horas', '5 horas'), C('Fosfato (phosphate)', 'pH')],
      [false, false, false, false, false], 'no contenidos');
    eq([C('agua tibia', 'agua'), C('Agua  TIBIA.', 'agua tibia'), C('el pH del agua', 'pH'), C('cerrar la válvula', 'Válvula')], [true, true, true, true], 'contenidos');
    eq(C('algo', ''), false, 'vacío');
    const F = (t) => EB.EXAM_OPTION_FORBIDDEN_RE.test(EB.normalizeExamText(t));
    for (const t of ['Ninguna de las anteriores', 'Todas las anteriores', 'Todas son correctas', 'Ninguna es correcta', 'Todas las respuestas anteriores',
      'Ninguna de las otras opciones', 'A y B son correctas', 'b y c correctas', 'Ambas son válidas', 'Todas las demás', 'NINGUNA DE LAS ALTERNATIVAS']) assert(F(t), `prohibida: ${t}`);
    for (const t of ['Todas las anteriores son correctas', 'Ninguna de las anteriores.', 'c y d son correctas']) assert(F(t), `prohibida: ${t}`);
    for (const t of ['Revisar todas las válvulas', 'Ninguna válvula abierta', 'Ambas bombas en paralelo', 'Las respuestas del equipo',
      'Revisar todas las opciones de filtrado', 'La vitamina a y e son correctas', 'Ninguna de las anteriores al arranque se registra']) assert(!F(t), `permitida (anclada): ${t}`);
    // en un banco: distractores numéricos con la misma unidad pasan
    const d = clone(MOD);
    const q = d.questions[0];
    q.correct.text = '5 mg/L de cloro libre';
    q.distractors = [{ text: '15 mg/L de cloro libre', why: q.distractors[0].why }, { text: '50 mg/L de cloro libre', why: q.distractors[1].why }, { text: '0,5 mg/L de cloro libre', why: q.distractors[2].why }];
    eq(codes(vMod(d)), [], 'numéricos misma unidad');
    q.distractors[0].text = '5 mg/L de cloro libre con agua tibia';
    assert(codes(vMod(d)).includes('EXAM_BANK_OPTION_LINT'), 'contención real');
  });

  await check('mensajes con ids de pregunta (M5): duplicados, conteo fuera del plan, balance V/F, sesgo de longitud', () => {
    const d = clone(MOD);
    d.questions[1].stem = d.questions[0].stem;
    const tf = d.questions.filter((q) => q.type === 'truefalse' && q.chapterId === ch(1));
    tf.forEach((q) => { q.answer = true; });
    d.questions.filter((q) => q.type === 'multichoice').slice(0, 10).forEach((q) => { q.correct.text = q.correct.text.replace('Revisar', 'Revisarlo'); });
    const r = vMod(d);
    const msg = (code) => r.errors.filter((e) => e.code === code).map((e) => e.message).join(' | ');
    assert(msg('EXAM_BANK_DUPLICATE').includes(d.questions[1].id) && msg('EXAM_BANK_DUPLICATE').includes(d.questions[0].id), msg('EXAM_BANK_DUPLICATE'));
    assert(tf.every((q) => msg('EXAM_BANK_TF_BALANCE').includes(q.id)), msg('EXAM_BANK_TF_BALANCE'));
    assert(msg('EXAM_BANK_LENGTH_BIAS').includes(d.questions[0].id), msg('EXAM_BANK_LENGTH_BIAS'));
  });

  await check('C2: el empaque valida el banco contra SU plan congelado + pertenencia (planSource frozen); completeItem exige el plan del Manifest', () => {
    const fz = (doc, scope, chapters) => EB.validateExamBank(doc, { scope, chapters, chapterMd: MD, planSource: 'frozen' });
    const rev = [...MOD_CH].reverse();
    // reorden de capítulos dentro del módulo: Manifest ≠, congelado OK
    assert(codes(EB.validateExamBank(MOD, { scope: 'module', chapters: rev, chapterMd: MD })).includes('EXAM_BANK_PLAN'), 'manifest: reorden ≠ plan');
    const r1 = fz(MOD, 'module', rev);
    eq([r1.ok, r1.slotCount, r1.plan], [true, 25, MOD.plan], 'módulo reordenado (congelado)');
    // módulos reordenados / capítulo movido entre módulos que siguen existiendo: el final empaqueta
    const reMods = [...ALL_CH.filter((c) => c.moduleId === M2), ...ALL_CH.filter((c) => c.moduleId === M1)];
    eq(fz(FIN, 'final', reMods).ok, true, 'final, módulos reordenados');
    const moved = ALL_CH.map((c) => (c.id === ch(3) ? { ...c, moduleId: M2 } : c));
    eq(fz(FIN, 'final', moved).ok, true, 'final, capítulo movido (módulos existentes)');
    assert(!EB.validateExamBank(FIN, { scope: 'final', chapters: moved }).ok, 'manifest: movido ≠ plan');
    // pertenencia rota: falla fuerte (la invalidación ya regeneró el examen en estos casos)
    const gone = MOD_CH.filter((c) => c.id !== ch(2));
    assert(codes(fz(MOD, 'module', gone)).includes('EXAM_BANK_PLAN'), 'capítulo borrado del módulo');
    const out = MOD_CH.map((c) => (c.id === ch(2) ? { ...c, moduleId: M2 } : c));
    assert(codes(fz(MOD, 'module', out.filter((c) => c.moduleId === M1))).includes('EXAM_BANK_PLAN'), 'capítulo movido fuera del módulo');
    const noM2 = ALL_CH.map((c) => ({ ...c, moduleId: M1 }));
    assert(codes(fz(FIN, 'final', noM2)).includes('EXAM_BANK_PLAN'), 'módulo del plan inexistente');
    // plan congelado mal formado
    for (const bad of [[], [{ chapterId: ch(1), type: 'multichoice', slots: 0 }], [{ chapterId: ch(1), type: 'x', slots: 1 }], [{ moduleId: M1, type: 'multichoice', slots: 1 }],
      [...MOD.plan, MOD.plan[0]]]) {
      const d = clone(MOD); d.plan = bad;
      assert(codes(fz(d, 'module', MOD_CH)).includes('EXAM_BANK_PLAN'), `mal formado ${JSON.stringify(bad).slice(0, 60)}`);
    }
    // el plan congelado manda en los conteos: un plan propio coherente y su banco empaquetan aunque el Manifest diga otra cosa
    const small = EBF.makeExamBank({ scope: 'module', moduleId: M1, chapters: MOD_CH, plan: EB.moduleExamPlan([ch(2), ch(1), ch(3)]) });
    eq(fz(small, 'module', MOD_CH).ok, true, 'plan propio (otro orden)');
  });

  await check('p2probe/reorder.js: las 3 variantes del review empaquetan con el plan congelado', () => {
    const m1 = MOD_CH;
    const mods = [M1, M2];
    const reMods = [...ALL_CH.filter((c) => c.moduleId === mods[1]), ...ALL_CH.filter((c) => c.moduleId === mods[0])];
    const moved = ALL_CH.map((c, i) => (i === 2 ? { ...c, moduleId: mods[1] } : c));
    const fz = (doc, scope, chapters) => codes(EB.validateExamBank(doc, { scope, chapters, chapterMd: MD, planSource: 'frozen' }));
    eq([fz(MOD, 'module', [...m1].reverse()), fz(FIN, 'final', reMods), fz(FIN, 'final', moved)], [[], [], []], 'sin errores');
  });

  // ── 3. Dispatcher server-side + roles ──
  await check('validateV3ItemArtifact: banco de exam (questionCount = 25 slots) y final_exam (40); GIFT final como siempre; GIFT de módulo sin validación', () => {
    eq([S.v3ValidatedArtifactTypes('exam'), S.v3ValidatedArtifactTypes('final_exam'), S.v3ValidatedArtifactTypes('content'), S.v3ValidatedArtifactTypes('activity', 'h5p')],
      [['dynamic_exam_bank_json'], ['dynamic_exam_bank_json', 'dynamic_exam_gift'], [], ['dynamic_h5p_params_json']], 'tabla');
    const ex = { type: 'exam', itemKey: `exam:${M1}`, artifactType: 'dynamic_exam_bank_json', examChapters: MOD_CH };
    const fe = { type: 'final_exam', itemKey: 'final_exam:1', artifactType: 'dynamic_exam_bank_json', examChapters: ALL_CH };
    eq(S.validateV3ItemArtifact(ex, JSON.stringify(MOD)), { ok: true, errors: [], summary: { questionCount: 25, bankSize: 50, bankVersion: 1 } }, 'exam');
    eq(S.validateV3ItemArtifact(fe, JSON.stringify(FIN)), { ok: true, errors: [], summary: { questionCount: 40, bankSize: 80, bankVersion: 1 } }, 'final');
    const bad = clone(MOD); bad.plan[0].slots = 9;
    eq(codes(S.validateV3ItemArtifact(ex, JSON.stringify(bad))), ['EXAM_BANK_PLAN'], 'plan ≠ Manifest');
    eq(codes(S.validateV3ItemArtifact(ex, '{roto')), ['JSON_INVALID'], 'json');
    // un banco de módulo NO sirve como final (scope / plan)
    assert(!S.validateV3ItemArtifact(fe, JSON.stringify(MOD)).ok, 'banco de módulo como final');
    const gift = S.validateV3ItemArtifact({ type: 'final_exam', itemKey: 'final_exam:1' }, SF.FINAL_GIFT);
    eq([gift.ok, gift.summary], [true, { questionCount: 12 }], 'GIFT final sin artifactType (compatibilidad)');
    eq(S.validateV3ItemArtifact({ type: 'final_exam', itemKey: 'final_exam:1', artifactType: 'dynamic_exam_gift' }, SF.FINAL_GIFT).summary, { questionCount: 12 }, 'GIFT final');
    let threw = false; try { S.validateV3ItemArtifact({ type: 'exam', itemKey: 'exam:m', artifactType: 'dynamic_exam_gift' }, 'x'); } catch (e) { threw = /V3_VALIDATION_CONTEXT/.test(e.message); } assert(threw, 'GIFT de módulo: sin validador (el scheduler lo salta)');
    threw = false; try { S.validateV3ItemArtifact({ ...ex, examChapters: [] }, JSON.stringify(MOD)); } catch (e) { threw = /V3_VALIDATION_CONTEXT/.test(e.message); } assert(threw, 'banco sin capítulos');
  });

  await check('examChaptersFromManifest / examBankClaimFacts: capítulos del Manifest y plan del claim = el que valida el servidor', () => {
    const manifest = { modules: [{ moduleId: M1, chapters: [{ chapterId: ch(1) }, { chapterId: ch(2) }, { chapterId: ch(3) }] }, { moduleId: M2, chapters: [{ chapterId: ch(4) }, { chapterId: ch(5) }] }] };
    eq(S.examChaptersFromManifest(manifest, 'exam', M1), MOD_CH, 'exam');
    eq(S.examChaptersFromManifest(manifest, 'final_exam'), ALL_CH, 'final');
    eq(S.examChaptersFromManifest(manifest, 'exam', 'otro'), [], 'módulo inexistente');
    const f = S.examBankClaimFacts(manifest, 'exam', M1);
    eq([f.artifactType, f.bankVersion, f.scope, f.moduleId, f.plan], ['dynamic_exam_bank_json', 1, 'module', M1, MOD.plan], 'claim exam');
    eq(S.examBankClaimFacts(manifest, 'final_exam').plan, FIN.plan, 'claim final');
    eq(S.examBankClaimFacts(manifest, 'exam', 'otro'), null, 'sin capítulos');
  });

  await check('roles: exam/final_exam aceptan exactamente uno de banco | GIFT (resolveRequiredArtifactTypesV3); el rol canónico sigue siendo GIFT', () => {
    eq(R.requiredArtifactTypesV3('exam'), ['dynamic_exam_gift'], 'canónico exam');
    eq(R.requiredArtifactTypesV3('final_exam'), ['dynamic_exam_gift'], 'canónico final');
    eq(R.resolveRequiredArtifactTypesV3('exam', null, ['dynamic_exam_bank_json']), { ok: true, types: ['dynamic_exam_bank_json'] }, 'banco');
    eq(R.resolveRequiredArtifactTypesV3('final_exam', null, ['dynamic_exam_gift']), { ok: true, types: ['dynamic_exam_gift'] }, 'gift');
    eq(R.resolveRequiredArtifactTypesV3('exam', null, []), { ok: true, types: ['dynamic_exam_gift'] }, 'ninguno → canónico (faltante)');
    eq(R.resolveRequiredArtifactTypesV3('exam', null, ['dynamic_exam_gift', 'dynamic_exam_bank_json']), { ok: false, code: 'EXAM_ARTIFACT_AMBIGUOUS', types: ['dynamic_exam_bank_json', 'dynamic_exam_gift'] }, 'ambos');
    eq(R.resolveRequiredArtifactTypesV3('content', null, ['dynamic_exam_bank_json']), { ok: true, types: ['dynamic_content_md', 'dynamic_context_package_json'] }, 'otro tipo: sin cambios');
    eq(R.resolveRequiredArtifactTypesV3('activity', null, []), undefined, 'activity sin variant');
    eq(R.missingRoleLabelV3('exam', 'dynamic_exam_gift'), 'dynamic_exam_bank_json|dynamic_exam_gift', 'etiqueta');
    const AUD = require('./lib/audit-v3');
    eq(AUD.V3_EXAM_ARTIFACT_ALTERNATIVES, [...R.EXAM_ARTIFACT_TYPES_V3], 'auditoría = resolver');
    eq(AUD.auditItemRolesV3({ id: 1, item_key: 'exam:m', type: 'exam', artifact_types: ['dynamic_exam_bank_json'] }), [], 'auditoría: banco');
    eq(AUD.auditItemRolesV3({ id: 1, item_key: 'exam:m', type: 'exam', artifact_types: ['dynamic_exam_gift'] }), [], 'auditoría: gift');
    eq(AUD.auditItemRolesV3({ id: 1, item_key: 'exam:m', type: 'exam', artifact_types: ['dynamic_exam_gift', 'dynamic_exam_bank_json'] }).length, 1, 'auditoría: ambos');
  });

  // ── 4. Empaque ──
  const OWNER = '11111111-2222-4333-8444-555555555555';
  const RUN_ID = '22222222-1111-4111-8111-111111111111';
  function runFixture(examMode, mutateBank) {
    const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 734 });
    const manifest = input.manifest;
    const allChapters = manifest.modules.flatMap((m) => m.chapters.map((c) => ({ id: c.chapterId, moduleId: m.moduleId })));
    const gIndex = new Map(allChapters.map((c, i) => [c.id, i]));
    if (examMode === 'bank') {
      // el Markdown del capítulo trae las frases de evidencia del banco
      for (const c of allChapters) input.contents.contentMd.set(c.id, `${input.contents.contentMd.get(c.id)}\n\n${EBF.chapterMarkdown(gIndex.get(c.id), 'Reglas')}`);
    }
    const files = new Map();
    const rows = [];
    let n = 0;
    const addArt = (item, type, content, mime = 'application/json') => {
      const id = `art-${String(++n).padStart(3, '0')}`;
      files.set(id, content);
      rows.push({ item_key: item.key, item_run_id: `gir-${item.key}`, gir_status: 'completed', gir_type: item.type, output_summary: {}, artifact_id: id, artifact_type: type, storage_bucket: 'cursia-artifacts', storage_path: `${OWNER}/dyn/${id}`, mime_type: mime, artifact_status: null, metadata: {} });
    };
    const bankFor = (type, moduleId) => {
      const chs = type === 'exam' ? allChapters.filter((c) => c.moduleId === moduleId) : allChapters;
      const bank = EBF.makeExamBank({ scope: type === 'exam' ? 'module' : 'final', moduleId: type === 'exam' ? moduleId : null, chapters: chs, chapterIndex: gIndex, plan: EB.expectedExamPlan(type === 'exam' ? 'module' : 'final', chs) });
      if (mutateBank) mutateBank(type, bank, { chs, gIndex });
      return JSON.stringify(bank);
    };
    const c = input.contents;
    for (const item of manifest.items) {
      const k = item.chapterId;
      switch (item.type) {
        case 'course_plan': addArt(item, 'dynamic_course_plan_json', '{}'); break;
        case 'course_intro': addArt(item, 'dynamic_course_intro_json', JSON.stringify(c.courseIntro)); break;
        case 'module_intro': addArt(item, 'dynamic_module_intro_json', JSON.stringify(c.moduleIntros.get(item.moduleId))); break;
        case 'content': addArt(item, 'dynamic_content_md', c.contentMd.get(k), 'text/markdown'); addArt(item, 'dynamic_context_package_json', '{}'); break;
        case 'experience': addArt(item, 'dynamic_experience_json', JSON.stringify(c.experiences.get(k))); break;
        case 'presentation': addArt(item, 'dynamic_presentation', JSON.stringify({ mock: true, slideCount: 3 }), 'application/json'); break;
        case 'audio_welcome': addArt(item, 'dynamic_audio_mp3', c.audioWelcome, 'audio/mpeg'); break;
        case 'audiobook_chapter': addArt(item, 'dynamic_audio_mp3', c.audiobookChapters.get(k), 'audio/mpeg'); break;
        case 'video': addArt(item, 'dynamic_video', JSON.stringify({ mode: 'real', delivery: 'youtube', videogenJobId: `vg-${k}`, youtubeVideoId: PF.YOUTUBE_ID, youtubeUrl: `https://www.youtube.com/watch?v=${PF.YOUTUBE_ID}`, durationSec: PF.VIDEO_SECONDS })); break;
        case 'video_interactions': addArt(item, 'dynamic_video_interactions_json', JSON.stringify(c.videoInteractions.get(k))); break;
        case 'activity': addArt(item, 'dynamic_h5p_params_json', JSON.stringify(c.activities.get(k).payload)); break;
        case 'exam':
          if (examMode === 'bank') addArt(item, 'dynamic_exam_bank_json', bankFor('exam', item.moduleId));
          else addArt(item, 'dynamic_exam_gift', c.examGift.get(item.moduleId), 'text/plain');
          if (examMode === 'both') addArt(item, 'dynamic_exam_bank_json', '{}');
          break;
        case 'final_exam':
          if (examMode === 'bank') addArt(item, 'dynamic_exam_bank_json', bankFor('final_exam'));
          else addArt(item, 'dynamic_exam_gift', c.finalExamGift, 'text/plain');
          break;
        default: throw new Error(`tipo sin fixture ${item.type}`);
      }
    }
    // run congelado en mock para las presentaciones (medios sintéticos, sin Storage)
    const run = { id: RUN_ID, owner_id: OWNER, input_payload: { videoMode: 'real', videoDelivery: 'youtube', providerModes: { presentation: 'mock', audio: 'real' } } };
    const q = {
      async query(sql) {
        if (/from public\.production_jobs where id = \$1/.test(sql)) return [{ id: RUN_ID, execution_mode: 'dynamic_generation', worker_status: 'completed', status: 'completed' }];
        if (/generation_item_runs/.test(sql)) return rows;
        throw new Error(`SQL no esperado: ${sql.slice(0, 60)}`);
      },
    };
    const L = {
      loadText: async (a) => { const v = files.get(a.artifactId); return Buffer.isBuffer(v) ? v.toString('utf8') : v; },
      loadBytes: async (a) => { const v = files.get(a.artifactId); return Buffer.isBuffer(v) ? v : Buffer.from(v); },
      loadStorageBytes: async (b, p) => { throw new Error(`Storage no esperado ${p}`); },
    };
    return { input, manifest, run, q, L };
  }
  async function load(f) {
    const byItem = await PK.resolveRunArtifactsV3(f.q, RUN_ID, f.manifest);
    const plan = PV3.buildPackagingPlanV3(f.manifest, f.input.blueprint, { manifestId: 9001 });
    return { byItem, loaded: await PK.loadContentsV3(f.L, plan, byItem, f.run, { familyId: 'aula-clara', mode: 'light' }) };
  }

  await check('empaque con bancos: resolve → ExamSource "bank" por módulo y final; el builder (P2-B3) los empaqueta como slots aleatorios (nunca los ignora)', async () => {
    const f = runFixture('bank');
    const { byItem, loaded } = await load(f);
    const examKeys = f.manifest.items.filter((i) => i.type === 'exam' || i.type === 'final_exam').map((i) => i.key);
    eq(examKeys.map((k) => byItem.get(k).artifacts.map((a) => a.type)), examKeys.map(() => ['dynamic_exam_bank_json']), 'roles resueltos');
    eq([...loaded.exams.modules.values()].map((s) => s.kind), f.manifest.modules.filter((m) => m.examEnabled).map(() => 'bank'), 'módulos');
    eq(loaded.exams.final.kind, 'bank', 'final');
    eq([loaded.contents.examGift.size, loaded.contents.finalExamGift, loaded.contents.examBanks.size, !!loaded.contents.finalExamBank], [0, null, examKeys.length - 1, true], 'contenidos');
    const built = await B.buildDynamicMbzV3({ ...f.input, contents: loaded.contents });
    eq(built.expectations.facts.modules.filter((m) => m.examEnabled).map((m) => m.examQuestionCount), [...loaded.contents.examBanks.values()].map((b) => EB.planSlotCount(b.plan)), 'facts: slots (no banco)');
    eq(built.expectations.facts.finalExam.questionCount, EB.planSlotCount(loaded.contents.finalExamBank.plan), 'facts final: slots');
    // banco + GIFT del mismo examen en el builder → falla fuerte (nunca elige uno en silencio)
    await rejects(B.buildDynamicMbzV3({ ...f.input, contents: { ...f.input.contents, finalExamBank: FIN } }), /^MBZ_V3_INVARIANT: .*GIFT y banco/, 'final banco + GIFT');
  });

  await check('empaque: banco con evidencia que no está en el capítulo → EXAM_BANK_INVALID (re-validación con el Markdown); banco + GIFT del mismo item → EXAM_ARTIFACT_AMBIGUOUS', async () => {
    const f = runFixture('bank', (type, bank) => { if (type === 'final_exam') bank.questions[0].evidence = 'Una frase que ningún capítulo de este curso dijo jamás sobre la planta.'; });
    await rejects(load(f), /^EXAM_BANK_INVALID: final_exam:\d+ \[EXAM_BANK_EVIDENCE\]/, 'evidencia');
    const both = runFixture('both');
    let err = null;
    try { await load(both); } catch (e) { err = e; }
    assert(err && err.name === 'PackagingNotReadyError' && err.missing.some((m) => /^exam:.*:EXAM_ARTIFACT_AMBIGUOUS=dynamic_exam_bank_json\+dynamic_exam_gift$/.test(m)), `ambiguo: ${err && (err.missing || err.message)}`);
  });

  await check('empaque (C2): bancos con plan congelado en OTRO orden que el Manifest actual (reorden posterior) → se cargan (no EXAM_BANK_INVALID) y llegan al builder', async () => {
    const f = runFixture('bank', (type, bank, { chs, gIndex }) => {
      const rev = [...chs].reverse();
      const plan = type === 'exam' ? EB.moduleExamPlan(rev.map((c) => c.id)) : EB.expectedExamPlan('final', rev);
      Object.assign(bank, EBF.makeExamBank({ scope: bank.scope, moduleId: bank.moduleId, chapters: rev, chapterIndex: gIndex, plan }));
    });
    const { loaded } = await load(f);
    assert([...loaded.exams.modules.values()].every((s) => s.kind === 'bank') && loaded.exams.final.kind === 'bank', 'bancos cargados');
    const built = await B.buildDynamicMbzV3({ ...f.input, contents: loaded.contents });
    assert(Buffer.isBuffer(built.mbz) && built.mbz.length > 0, 'builder empaqueta el banco reordenado');
  });

  await check('empaque con GIFT: ExamSource "gift" y el .mbz es byte a byte el de la entrada directa' + (process.env.BASE_DIST ? ' y el del builder de la base (BASE_DIST)' : ''), async () => {
    const f = runFixture('gift');
    const { loaded } = await load(f);
    eq([...loaded.exams.modules.values()].map((s) => s.kind).concat(loaded.exams.final.kind), [...loaded.exams.modules.keys()].map(() => 'gift').concat('gift'), 'kinds');
    assert(!('examBanks' in loaded.contents) && !('finalExamBank' in loaded.contents), 'sin campos de banco en contents');
    const direct = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 734 }));
    const viaLoader = await B.buildDynamicMbzV3({ ...f.input, contents: { ...loaded.contents, presentations: f.input.contents.presentations } });
    eq(sha(viaLoader.mbz), sha(direct.mbz), 'sha cargado = directo');
    if (process.env.BASE_DIST) {
      const baseRoot = path.resolve(process.env.BASE_DIST);
      const BB = loadDist('package/dynamic-mbz-builder-v3.js', baseRoot);
      const base = await BB.buildDynamicMbzV3(PF.packagingInput(baseRoot, { engine: 'h5p', finalExam: true, courseId: 734 }));
      eq(sha(direct.mbz), sha(base.mbz), 'sha = builder de la base');
      console.log(`   sha256 GIFT (h5p, 734): ${sha(direct.mbz)}`);
    }
  });

  await check('BANKOPT: bankAskCount = lo que pide el ejecutor (MC 2s+2, V/F y EM 2s+1), nunca más que bankMax; el banco subido sigue con bankTarget', () => {
    for (const sl of [1, 2, 5, 12]) {
      eq([EB.bankAskCount(sl, 'multichoice'), EB.bankAskCount(sl, 'truefalse'), EB.bankAskCount(sl, 'match')], [2 * sl + 2, 2 * sl + 1, 2 * sl + 1], 'slots ' + sl);
      assert(EB.bankAskCount(sl, 'multichoice') <= EB.bankMax(sl), 'dentro del máximo del contrato');
      eq(EB.bankTarget(sl), 2 * sl, 'objetivo sin cambio (2×)');
    }
  });
  await check('BANKOPT: FailItemDto acepta examBankDraftArtifactId (UUID, opcional) y rechaza otra cosa; whitelist estricta como en main.ts', async () => {
    const { plainToInstance } = require('class-transformer');
    const { validate } = require('class-validator');
    const { FailItemDto } = loadDist('modules/dynamic-generation/dto/executor.dto.js');
    const errs = async (body) => (await validate(plainToInstance(FailItemDto, body), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property).sort();
    const base = { executorId: 'ex-1', error: 'EXAM_BANK_INCOMPLETE: x', retryable: true };
    eq(await errs(base), [], 'sin borrador');
    eq(await errs({ ...base, examBankDraftArtifactId: '0b6b6b6b-0000-4000-8000-000000000001' }), [], 'con borrador');
    eq(await errs({ ...base, examBankDraftArtifactId: 'no-es-uuid' }), ['examBankDraftArtifactId'], 'no UUID');
    eq(await errs({ ...base, draft: 'x' }), ['draft'], 'otro campo sigue rechazado');
  });

  console.log(`\n${passes} OK, ${failures} FALLAS`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
