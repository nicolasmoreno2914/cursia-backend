#!/usr/bin/env node
/* eslint-disable no-console */
// Baseline Cursia antes del Contexto académico (Loop 0 del roadmap Contexto → Coherencia → Regeneración).
//
// Fija, con un dorado versionado, la salida del camino de diseño que ya existe (perfil → dry-run pedagógico →
// distribuidor → Blueprint + Manifest materializados → modelo de tiempo → estimador de costo) para un conjunto de
// escenarios representativos. Cualquier fase posterior que cambie uno de estos números sin querer lo rompe:
//   BL1  sin perfil / perfil vacío / sin targetHours: sha de Blueprint y Manifest de siempre
//   BL2  cada enfoque, sin targetHours: sha de Blueprint y Manifest pedagógicos
//   BL3  competencias a 20 / 33 / 50 / 64 h: estado, horas, conteos, práctica, aplicación, costo, sha materializados
//   BL4  64 h con Actividades «solo en práctica» y «ninguna»
//   BL5  0 llamadas de red medidas
//
// Uso: node scripts/check-design-baseline.js [path/to/dist] [--write]   (--write regenera el dorado)
'use strict';
const fs = require('fs');
const path = require('path');

const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida en el baseline: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  const net = require('net'); net.connect = deny('net.connect'); net.createConnection = deny('net.createConnection');
  const tls = require('tls'); tls.connect = deny('tls.connect');
  globalThis.fetch = deny('fetch');
}

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const distRoot = path.resolve(process.cwd(), args.find((a) => !a.startsWith('--')) || 'dist');
const P = require(path.join(distRoot, 'modules/pedagogy/index.js'));
const RCP = require('./fixtures/pedagogy/rcp-course.json');
const PF = require('./fixtures/pedagogy/profiles.json');
const GOLDEN = path.join(__dirname, 'fixtures/baseline/design-baseline-v1.json');

const clone = (o) => JSON.parse(JSON.stringify(o));
const rcp = () => { const s = clone(RCP); s.course.reviewCards = true; return s; };
const profileOf = (k, extra = {}) => ({
  pedagogyProfileVersion: 1, primaryApproach: PF.profiles[k].primaryApproach, secondaryApproaches: PF.profiles[k].secondaryApproaches,
  learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', ...extra,
});
const dry = (profile) => P.runPedagogyDryRun({ structure: rcp(), profile, activityTypeRules: 2 });
const usdOf = (prov) => ({
  expected: Number(prov.estimateUsd.expected).toFixed(2),
  byProvider: Object.fromEntries(Object.entries(prov.estimateUsd.byProvider || {}).map(([k, v]) => [k, Number(v).toFixed(2)])),
});
const shas = (x) => ({ blueprint: x.blueprintSha256, manifest: x.manifestSha256, manifestErrors: x.manifestErrors.length });

function distSummary(r) {
  const d = r.distribution;
  return {
    status: d.status,
    estimatedHours: d.estimatedHours,
    baseHours: d.baseHours,
    applicationShare: d.applicationShare,
    counts: d.counts,
    proposalSha256: d.proposalSha256,
    materialized: { ...shas(d.materialized), totals: d.materialized.totals, generableHours: d.materialized.generableHours, usd: usdOf(d.materialized.providers) },
  };
}

function compute() {
  const out = { version: 1, fixture: RCP.course.title, scenarios: {} };
  const s = out.scenarios;
  s.noProfile = { baseline: shas(dry(null).baseline) };
  s.emptyProfile = { baseline: shas(dry(P.emptyPedagogicalProfile()).baseline) };
  s.competenciasNoTarget = { baseline: shas(dry(profileOf('competencias')).baseline) };
  for (const k of Object.keys(PF.profiles)) {
    const r = dry(profileOf(k));
    s[`approach:${k}`] = { pedagogical: { ...shas(r.pedagogical), usd: usdOf(r.pedagogical.providers), studyHours: r.pedagogical.studyTime.courseEstimatedHours } };
  }
  for (const h of [20, 33, 50, 64]) s[`competencias:${h}h`] = distSummary(dry(profileOf('competencias', { targetHours: h })));
  s['competencias:64h:practice_only'] = distSummary(dry(profileOf('competencias', { targetHours: 64, designPreferences: { applicationActivities: 'practice_only' } })));
  s['competencias:64h:none'] = distSummary(dry(profileOf('competencias', { targetHours: 64, designPreferences: { applicationActivities: 'none' } })));
  return out;
}

let passes = 0;
let failures = 0;
function check(name, fn) {
  try { fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e.message}`); }
}
function eq(a, b, m) {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m}:\n   esperado ${B}\n   encontrado ${A}`);
}

const now = compute();
if (WRITE) {
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  fs.writeFileSync(GOLDEN, JSON.stringify(now, null, 2) + '\n');
  console.log(`dorado escrito: ${GOLDEN}`);
}
const gold = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));

check('BL1 sin perfil / perfil vacío: sha de Blueprint y Manifest de siempre (= dorado de Fase 1)', () => {
  const LEGACY = ['21e0472599c9de15049ad55aba042b73a737cba1741554e62f550f7b7495d4e4', 'e4a859788fd35c2496fe7384e3e9c4e47be9b4e707f6a9b3380ca82ba0f31066'];
  for (const k of ['noProfile', 'emptyProfile']) {
    eq([now.scenarios[k].baseline.blueprint, now.scenarios[k].baseline.manifest], LEGACY, `${k}`);
    eq(now.scenarios[k], gold.scenarios[k], `${k} = dorado`);
  }
  eq(now.scenarios.competenciasNoTarget, gold.scenarios.competenciasNoTarget, 'con enfoque, sin objetivo: la base no cambia');
});
check('BL2 cada enfoque sin targetHours: Blueprint, Manifest, horas y costo pedagógicos = dorado', () => {
  for (const k of Object.keys(PF.profiles)) eq(now.scenarios[`approach:${k}`], gold.scenarios[`approach:${k}`], k);
});
check('BL3 competencias 20 / 33 / 50 / 64 h: estado, horas, conteos, aplicación, costo y sha = dorado', () => {
  for (const h of [20, 33, 50, 64]) eq(now.scenarios[`competencias:${h}h`], gold.scenarios[`competencias:${h}h`], `${h} h`);
});
check('BL4 64 h con Actividades «solo en práctica» y «ninguna» = dorado', () => {
  for (const k of ['practice_only', 'none']) eq(now.scenarios[`competencias:64h:${k}`], gold.scenarios[`competencias:64h:${k}`], k);
});
check('BL5 0 llamadas de red medidas', () => eq(netAttempts, [], 'intentos de red'));

const fmt = (n) => String(Math.round(n * 10) / 10).replace('.', ',');
console.log('\nBaseline (RCP, competencias, dry-run, USD 0)');
console.log('escenario                      | estado                 | horas | cap. | práct. | video | aplic. (min) | USD est.');
for (const [k, v] of Object.entries(now.scenarios)) {
  if (!v.status) continue;
  const c = v.counts;
  console.log(`${k.padEnd(30)} | ${v.status.padEnd(22)} | ${fmt(v.estimatedHours).padStart(5)} | ${String(c.chapters).padStart(4)} | ${String(c.practiceChapters).padStart(6)} | ${String(c.videoChapters).padStart(5)} | ${(c.applicationActivities + ' (' + c.applicationMinutes + ')').padStart(12)} | ${v.materialized.usd.expected}`);
}
console.log(`\n${passes} OK, ${failures} fallidas`);
process.exit(failures ? 1 : 0);
