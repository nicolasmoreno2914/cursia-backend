#!/usr/bin/env node
/* eslint-disable no-console */
// r79 · F3 · Las huellas que ya están aprobadas NO se mueven sin presupuesto.
//
// El dorado `fixtures/r79/hash-stability-v1.json` se escribió con el código de staging ANTES de r79 (origin/staging
// 449dc02, `--write` con ese dist). Este check recalcula lo mismo con el código actual:
//
//   HS1  huella de la propuesta de «Aplicar diseño» (distributionProposalSha256) de cursos sintéticos S/M/L a 20/60/100 h,
//        con enfoques de aplicación y de profundidad, con y sin documento (6 contenidos fijados): idénticas
//   HS2  sha del perfil pedagógico normalizado (pedagogicalProfileSha256) de esos perfiles: idéntico
//   HS3  huella del Prebrief (prebriefModelSha) de las propuestas de los fixtures de staging (S/M/L, 4 × 5, prácticas,
//        excepción, aprobadas): idénticas
//   HS4  con el interruptor encendido y SIN presupuesto: las claves nuevas de la tarjeta (productionBudget: null,
//        budgetFit: null, cost.pricingSource, cost.provisionalPricing) no mueven la huella del Prebrief
//   HS5  un presupuesto SIN tope (el diseño que cabe es el de siempre) no mueve la huella de la propuesta; un tope sí
//   HS6  el dorado del diseño (design-baseline-v1.json): todas sus huellas de propuesta siguen iguales
//
// Uso: node scripts/check-r79-hash-stability.js [path/to/dist] [--write]
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const distRoot = path.resolve(process.cwd(), args.find((a) => !a.startsWith('--')) || 'dist');
const P = require(path.join(distRoot, 'modules/pedagogy/index.js'));
const M = require(path.join(distRoot, 'modules/prebrief/prebrief-model.js'));
const RA = require(path.join(distRoot, 'modules/academic-context/requirements/requirement-authority.js'));
const { fixture } = require('./fixtures/prebrief-fixtures.js');
const PF = require('./fixtures/pedagogy/profiles.json');
const GOLDEN = path.join(__dirname, 'fixtures/r79/hash-stability-v1.json');
const BASELINE = require('./fixtures/baseline/design-baseline-v1.json');

const clone = (o) => JSON.parse(JSON.stringify(o));
const TOPICS = ['Peligros', 'Riesgos', 'Controles', 'Protección', 'Incidentes', 'Emergencias', 'Indicadores', 'Cultura'];
const course = (mods, chs) => ({ course: { title: 'Curso sintético', finalExam: true, activityEngine: 'h5p' }, modules: Array.from({ length: mods }, (_, i) => ({ id: `m${i + 1}`, title: TOPICS[i], examEnabled: true, chapters: Array.from({ length: chs }, (_, j) => ({ id: `m${i + 1}c${j + 1}`, title: `${TOPICS[i]}: análisis ${j + 1}`, objective: 'Analizar riesgos' })) })) });
const profile = (h, approach, dp) => ({ pedagogyProfileVersion: 1, primaryApproach: PF.profiles[approach].primaryApproach, secondaryApproaches: PF.profiles[approach].secondaryApproaches, learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', targetHours: h, ...(dp ? { designPreferences: dp } : {}) });
const DOC6 = { sources: { chapters: 'REQ-1' }, modulesFixed: 2, contentChaptersPerModule: { min: 3, max: 3 }, noContentAdditions: true };

function scenarios() {
  const out = [];
  for (const [n, mods, chs] of [['S', 3, 2], ['M', 6, 1], ['L', 8, 2]]) for (const h of [20, 60, 100]) for (const ap of ['competencias', 'significativo']) for (const dp of [null, { audiovisual: 'recommended' }, { audiovisual: 'less', guidedPractice: 'none' }]) {
    out.push({ key: `${n}/${h}/${ap}/${dp ? JSON.stringify(dp) : 'sin-preferencias'}`, structure: course(mods, chs), profile: profile(h, ap, dp) });
  }
  for (const h of [20, 30, 60]) out.push({ key: `doc6/${h}`, structure: course(2, 3), profile: profile(h, 'competencias', { audiovisual: 'recommended' }), requirementConstraints: DOC6 });
  return out;
}
function prebriefInputs() {
  const list = [['S', { format: 'S', shape: [3, 3, 3] }], ['M', { format: 'M', shape: [4, 4, 4] }], ['L', { format: 'L', shape: [5, 5, 5, 5] }], ['doc4x5', { doc4x5: true, shape: [4, 4, 4] }],
    ['doc4x5-excepcion', { doc4x5: true, shape: [4, 4, 4], reason: 'La institución prefiere 3 módulos.' }], ['practica', { practice: true }], ['largo', { longTitles: true, longOutcomes: true }]];
  return list.map(([k, o]) => [k, fixture(o)]);
}
const prebriefSha = (inp) => M.prebriefModelSha(M.buildPrebriefModel(inp, RA.actualText, RA.requirementText));

function compute() {
  const g = { version: 1, writtenWith: null, proposals: {}, profiles: {}, prebrief: {} };
  for (const s of scenarios()) {
    const d = P.runPedagogyDryRun({ structure: s.structure, profile: s.profile, activityTypeRules: 2, ...(s.requirementConstraints ? { requirementConstraints: s.requirementConstraints } : {}) }).distribution;
    g.proposals[s.key] = d.proposalSha256;
    g.profiles[s.key] = P.pedagogicalProfileSha256(P.normalizePedagogicalProfile(s.profile));
  }
  for (const [k, inp] of prebriefInputs()) g.prebrief[k] = prebriefSha(inp);
  return g;
}

let passes = 0;
let failures = 0;
function check(name, fn) {
  try { fn(); passes++; console.log(`  ✅ ${name}`); } catch (err) { failures++; console.log(`  ❌ ${name}\n      ${err && err.message}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }

if (WRITE) {
  const g = compute();
  g.writtenWith = process.env.R79_GOLDEN_SOURCE || 'dist sin declarar';
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  fs.writeFileSync(GOLDEN, JSON.stringify(g, null, 2) + '\n');
  console.log(`dorado escrito: ${Object.keys(g.proposals).length} propuestas, ${Object.keys(g.prebrief).length} prebriefs`);
  process.exit(0);
}

const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const now = compute();
console.log(`r79 · huellas estables (dorado: ${golden.writtenWith})`);
check(`HS1 huella de la propuesta: ${Object.keys(golden.proposals).length} escenarios idénticos al código de antes de r79`, () => {
  const diff = Object.keys(golden.proposals).filter((k) => golden.proposals[k] !== now.proposals[k]);
  assert(!diff.length, `cambiaron: ${diff.join(', ')}`);
});
check('HS2 sha del perfil pedagógico normalizado: idéntico', () => {
  const diff = Object.keys(golden.profiles).filter((k) => golden.profiles[k] !== now.profiles[k]);
  assert(!diff.length, `cambiaron: ${diff.join(', ')}`);
});
check(`HS3 huella del Prebrief de las propuestas de los fixtures (${Object.keys(golden.prebrief).length}): idéntica`, () => {
  const diff = Object.keys(golden.prebrief).filter((k) => golden.prebrief[k] !== now.prebrief[k]);
  assert(!diff.length, `cambiaron: ${diff.join(', ')}`);
});
check('HS4 interruptor encendido sin presupuesto: las claves nuevas de la tarjeta no mueven la huella del Prebrief', () => {
  for (const [k, inp] of prebriefInputs()) {
    const x = { ...inp, card: clone(inp.card) };
    x.card.productionBudget = null;
    x.card.budgetFit = null;
    if (x.card.cost) { x.card.cost.pricingSource = 'pricing_catalog'; x.card.cost.provisionalPricing = { gamma: true, label: 'estimación provisional (precio de Gamma sin verificar)' }; }
    if (x.card.profile) x.card.profile.productionBudgetUsd = 35;
    assert(prebriefSha(x) === golden.prebrief[k], `${k}: la huella cambió`);
  }
});
check('HS5 presupuesto sin tope: la misma huella de propuesta; con tope, otra (y solo entonces)', () => {
  for (const s of scenarios().slice(0, 18)) {
    const withBudget = { ...s.profile, productionBudgetUsd: 50 };
    const d = P.runPedagogyDryRun({ structure: s.structure, profile: withBudget, activityTypeRules: 2 }).distribution;
    assert(d.proposalSha256 === golden.proposals[s.key], `${s.key}: el presupuesto movió la huella`);
    assert(!('contentChaptersMax' in d), `${s.key}: tope sin pedirlo`);
  }
  const s = scenarios().find((x) => x.key.startsWith('M/60/competencias'));
  const capped = P.runPedagogyDryRun({ structure: s.structure, profile: { ...s.profile, designPreferences: { ...(s.profile.designPreferences || {}), maxContentChaptersPerModule: 1 } }, activityTypeRules: 2 }).distribution;
  assert(capped.proposalSha256 !== golden.proposals[s.key], 'con tope la huella debía cambiar');
});
check('HS6 dorado del diseño (design-baseline-v1): todas sus huellas de propuesta siguen iguales', () => {
  const RCP = require('./fixtures/pedagogy/rcp-course.json');
  const rcp = () => { const x = clone(RCP); x.course.reviewCards = true; return x; };
  const prof = (extra) => ({ pedagogyProfileVersion: 1, primaryApproach: PF.profiles.competencias.primaryApproach, secondaryApproaches: PF.profiles.competencias.secondaryApproaches, learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', ...extra });
  const want = { 'competencias:20h': { targetHours: 20 }, 'competencias:33h': { targetHours: 33 }, 'competencias:50h': { targetHours: 50 }, 'competencias:64h': { targetHours: 64 },
    'competencias:64h:practice_only': { targetHours: 64, designPreferences: { applicationActivities: 'practice_only' } }, 'competencias:64h:none': { targetHours: 64, designPreferences: { applicationActivities: 'none' } } };
  for (const [k, extra] of Object.entries(want)) {
    const d = P.runPedagogyDryRun({ structure: rcp(), profile: prof(extra), activityTypeRules: 2 }).distribution;
    assert(d.proposalSha256 === BASELINE.scenarios[k].proposalSha256, `${k}: ${d.proposalSha256} ≠ ${BASELINE.scenarios[k].proposalSha256}`);
  }
});
console.log(`\n${passes} OK, ${failures} fallidas`);
if (failures) process.exit(1);
