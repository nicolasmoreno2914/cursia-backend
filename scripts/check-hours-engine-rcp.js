#!/usr/bin/env node
/* eslint-disable no-console */
// Motor de carga horaria — validación final de la Fase 1 (dry-run completo, sin proveedores, USD 0).
//
// «RCP Básico para Auxiliares de Enfermería» (con «Repaso», H5P v2) por el MISMO camino que usa el panel:
//   perfil (enfoque + targetHours) → dry-run pedagógico → distribuidor → propuesta materializada en un
//   Blueprint en memoria → Manifest v3 real + validador → modelo de tiempo → estimador de costo.
//
//   HE1  20 / 33 / 50 h (competencias): tres diseños distintos, dentro de la tolerancia, cerca del baseline de la
//        Fase 0 (~19 / ~32 / ~49 h; ~9 / ~11 / ~19 capítulos; ~9 / ~9 / ~13 videos; ~0 / ~2 / ~6 de práctica)
//   HE2  la propuesta materializada es un Blueprint + Manifest VÁLIDOS y sus horas son las del distribuidor
//   HE3  8 h → la estructura mínima supera el objetivo (sin recortar); 80 h → no alcanza (propone módulos)
//   HE4  sin targetHours y con perfil vacío: la salida de siempre (distribution null; sha de Blueprint y Manifest = dorado)
//   HE5  cada enfoque existente produce una propuesta válida; competencias y significativo crecen distinto
//   HE6  costo: el video no crece con las horas (solo con capítulos de profundización); la práctica cuesta
//        mucho menos que un capítulo de contenido
//   HE7  0 llamadas de red MEDIDAS (fetch, http/https, net/tls interceptados antes de cargar el código)
//
// Imprime la tabla comparativa del reporte. Uso: node scripts/check-hours-engine-rcp.js [path/to/dist]
'use strict';
const path = require('path');

// Guarda de red REAL (revisión final Fase 1, M5): cualquier intento de salir a la red se cuenta y falla.
const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida en el dry-run: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  const net = require('net'); net.connect = deny('net.connect'); net.createConnection = deny('net.createConnection');
  const tls = require('tls'); tls.connect = deny('tls.connect');
  globalThis.fetch = deny('fetch');
}

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar ${abs} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
const P = loadDist('modules/pedagogy/index.js');
const RCP = require('./fixtures/pedagogy/rcp-course.json');
const PF = require('./fixtures/pedagogy/profiles.json');

let passes = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${name}\n   ${e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`);
  }
}
function assert(c, m) {
  if (!c) throw new Error(m);
}
function eq(a, b, m) {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m}: esperado ${B}, encontrado ${A}`);
}
function near(a, b, tol, m) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m}: esperado ${b} ± ${tol}, encontrado ${a}`);
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const rcp = () => { const s = clone(RCP); s.course.reviewCards = true; return s; };
const profileOf = (k, extra = {}) => ({
  pedagogyProfileVersion: 1, primaryApproach: PF.profiles[k].primaryApproach, secondaryApproaches: PF.profiles[k].secondaryApproaches,
  learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', ...extra,
});
const run = (h, k = 'competencias') => P.runPedagogyDryRun({ structure: rcp(), profile: k ? profileOf(k, { targetHours: h }) : { ...P.emptyPedagogicalProfile(), targetHours: h }, activityTypeRules: 2 });
const usd = (x) => Number(x.estimateUsd.expected);
const prov = (x, p) => Number((x.estimateUsd.byProvider || {})[p] || 0);

const rows = [];
const S = {};
for (const h of [20, 33, 50]) S[h] = run(h);

check('HE1 20 / 33 / 50 h (competencias): tres diseños distintos, dentro de la tolerancia, cerca del baseline de la Fase 0', () => {
  const base = { 20: [19.1, 9, 9, 0], 33: [31.8, 11, 9, 2], 50: [48.6, 19, 13, 6] };
  for (const h of [20, 33, 50]) {
    const d = S[h].distribution;
    eq([S[h].dryRun, S[h].providersCalled, S[h].spendUsd], [true, 0, '0.00'], `${h} h: sin proveedores`);
    eq(d.status, 'within_tolerance', `${h} h: estado`);
    near(d.estimatedHours, base[h][0], 0.3, `${h} h: horas ≈ Fase 0`);
    eq([d.counts.chapters, d.counts.videoChapters, d.counts.practiceChapters], base[h].slice(1), `${h} h: capítulos / videos / práctica`);
  }
  eq(new Set([20, 33, 50].map((h) => JSON.stringify(S[h].distribution.counts))).size, 3, 'tres diseños');
});

check('HE2 la propuesta materializada es un Blueprint + Manifest VÁLIDOS y sus horas son las del distribuidor', () => {
  for (const h of [20, 33, 50]) {
    const d = S[h].distribution;
    eq(d.materialized.manifestErrors, [], `${h} h: Manifest válido`);
    near(d.materialized.generableHours, d.generableHours, 0.1, `${h} h: horas del Manifest = horas generables del distribuidor`);
    eq(d.materialized.totals.chapterCount, d.counts.chapters, `${h} h: capítulos`);
    eq(d.materialized.totals.videoCount, d.counts.videoChapters, `${h} h: videos`);
    eq(d.materialized.totals.presentationCount, d.counts.contentChapters, `${h} h: Gamma solo en capítulos de contenido`);
    eq(d.materialized.totals.audiobookChapterCount, d.counts.contentChapters, `${h} h: audiolibro solo en capítulos de contenido`);
    eq(d.materialized.totals.activityCount, d.counts.activities, `${h} h: actividades H5P`);
  }
});

check('HE3 8 h: el mínimo supera el objetivo (sin recortar); 80 h: no alcanza (propone módulos, no infla)', () => {
  const d8 = run(8).distribution;
  eq(d8.status, 'minimum_exceeds_target', '8 h');
  assert(d8.recommendations[0].startsWith('La estructura mínima actual supera la carga horaria objetivo'), d8.recommendations[0]);
  eq(d8.counts.chapters, 9, '8 h: nada se recorta');
  const d80 = run(80).distribution;
  eq(d80.status, 'cannot_reach_target', '80 h');
  assert(/módulo\(s\) nuevo\(s\)/.test(d80.recommendations.join(' ')), d80.recommendations.join(' | '));
  eq(d80.materialized.manifestErrors, [], '80 h: lo propuesto igual es válido');
  rows.push(['8 h', d8], ['80 h', d80]);
});

check('HE4 sin targetHours y con perfil vacío: la salida de siempre', () => {
  const a = P.runPedagogyDryRun({ structure: rcp(), profile: profileOf('competencias'), activityTypeRules: 2 });
  eq([a.targetHours, a.workload, a.distribution], [null, null, null], 'sin objetivo');
  const b = P.runPedagogyDryRun({ structure: rcp(), profile: null, activityTypeRules: 2 });
  eq([b.distribution, b.pedagogical], [null, null], 'perfil vacío');
  eq(S[33].baseline.blueprintSha256 !== b.baseline.blueprintSha256, true, 'con objetivo, el Blueprint lleva targetHours');
  // Dorado (rama staging 00d2399, idéntico al de antes del motor de horas: check-target-hours fija los 80 casos legacy).
  const GOLD = ['21e0472599c9de15049ad55aba042b73a737cba1741554e62f550f7b7495d4e4', 'e4a859788fd35c2496fe7384e3e9c4e47be9b4e707f6a9b3380ca82ba0f31066'];
  eq([a.baseline.blueprintSha256, a.baseline.manifestSha256], GOLD, 'sin objetivo: sha de siempre');
  eq([b.baseline.blueprintSha256, b.baseline.manifestSha256], GOLD, 'perfil vacío: sha de siempre');
});

check('HE5 cada enfoque existente produce una propuesta válida; competencias y significativo crecen distinto', () => {
  for (const k of Object.keys(PF.profiles)) {
    const d = run(50, k).distribution;
    eq(d.materialized.manifestErrors, [], `${k}: Manifest de la propuesta válido`);
    assert(['within_tolerance', 'above_tolerance', 'cannot_reach_target'].includes(d.status), `${k}: ${d.status}`);
  }
  const c = run(50, 'competencias').distribution;
  const s = run(50, 'significativo').distribution;
  assert(c.counts.practiceChapters > s.counts.practiceChapters && s.counts.contentChapters > c.counts.contentChapters, 'práctica vs profundidad');
  const e = run(33, null).distribution;
  eq([e.policy.kind, e.status], ['application_first', 'within_tolerance'], 'perfil vacío con 33 h');
  rows.push(['50 h significativo', s]);
});

check('HE6 costo: el video no crece con las horas; la práctica cuesta mucho menos que un capítulo de contenido', () => {
  const m = (h) => S[h].distribution.materialized.providers;
  eq(prov(m(20), 'videogen'), prov(m(33), 'videogen'), '20 → 33 h: mismo video (crece con práctica y aplicación)');
  assert(prov(m(50), 'videogen') > prov(m(33), 'videogen'), '50 h: más video solo por capítulos de profundización');
  const perPractice = (usd(m(33)) - usd(m(20))) / 2;
  const perContent = (usd(m(50)) - usd(m(33)) - 4 * perPractice) / 4;
  // Fase 2: la práctica incluye su Actividad de Aplicación (texto LLM): sigue muy por debajo de un capítulo de contenido.
  assert(perPractice > 0 && perPractice < 0.8, `práctica ≈ USD ${perPractice.toFixed(2)}`);
  assert(perContent > 5 * perPractice, `contenido ≈ USD ${perContent.toFixed(2)} (≫ práctica)`);
});

check('HE7 0 llamadas de red medidas durante todos los dry-runs (no un literal del objeto de retorno)', () => {
  eq(netAttempts, [], 'intentos de red');
  let threw = false;
  try { require('https').request('https://example.invalid'); } catch { threw = true; }
  assert(threw && netAttempts.length === 1, 'la guarda está activa (una llamada de control se intercepta)');
  netAttempts.length = 0;
});

// ── Tabla del reporte ──
const fmt = (n) => String(Math.round(n * 10) / 10).replace('.', ',');
const all = [['20 h', S[20].distribution], ['33 h', S[33].distribution], ['50 h', S[50].distribution], ...rows];
console.log('\nRCP Básico para Auxiliares de Enfermería · competencias · «Repaso» · H5P v2 (dry-run, 0 proveedores, USD 0)');
console.log('objetivo           | estado                 | horas diseño | generables hoy | cap. | video | práctica | H5P | aplic. (min) | eval. | USD (hoy)');
for (const [label, d] of all) {
  const c = d.counts;
  console.log(`${label.padEnd(18)} | ${d.status.padEnd(22)} | ${fmt(d.estimatedHours).padStart(12)} | ${fmt(d.generableHours).padStart(14)} | ${String(c.chapters).padStart(4)} | ${String(c.videoChapters).padStart(5)} | ${String(c.practiceChapters).padStart(8)} | ${String(c.activities).padStart(3)} | ${(c.applicationActivities + ' (' + c.applicationMinutes + ')').padStart(12)} | ${String(c.evaluations).padStart(5)} | ${Number(d.materialized.providers.estimateUsd.expected).toFixed(2)}`);
}
console.log(`\n${passes} OK, ${failures} fallidas`);
process.exit(failures ? 1 : 0);
