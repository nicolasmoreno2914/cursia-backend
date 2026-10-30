#!/usr/bin/env node
/* eslint-disable no-console */
// r79.1 · «No cabe» más rápido SIN debilitar la búsqueda: el resultado optimizado = el de la búsqueda EXHAUSTIVA.
//
//   S1  equivalencia: en la matriz de cursos (S 3×2, M 6×1, L 8×2 y el microcurrículo de 6 contenidos) × 20/60/100 h ×
//       3 presupuestos × tipos de actividad bloqueados / libres, el resultado optimizado tiene el MISMO estado, la misma
//       alternativa «presupuesto mínimo» y la misma alternativa «horas que alcanzan» (horas y huella del diseño) que la
//       búsqueda exhaustiva de referencia: probar TODAS las medias horas desde la meta − 0,5 hacia abajo con la búsqueda
//       completa (con poda por presupuesto, como siempre) y quedarse con la primera que cabe
//   S2  rendimiento: cada caso «No cabe» (cursos grandes, con documento) en < 2 s (proceso ya caliente). En CI (máquinas
//       compartidas, `CI` definido) el tope es 6 s (el de BF24); la medición de referencia es la local (--full)
//   S3  sin red (0 intentos)
//
// Uso: npm run build && node scripts/check-r79-1-budget-search.js [path/to/dist] [--full]
//   sin --full (gate-core): la equivalencia corre sobre los casos CON la palanca de tipos (la búsqueda más grande); con
//   --full, también sin ella (72 casos).
'use strict';
const path = require('path');

const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  globalThis.fetch = deny('fetch');
}
const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const F = require(path.join(distRoot, 'modules/course-design/budget-fit.js'));
const D = require(path.join(distRoot, 'modules/study-time/distributor.js'));

let passes = 0;
let failures = 0;
function check(name, fn) {
  try { fn(); passes++; console.log(`  ✅ ${name}`); } catch (err) { failures++; console.log(`  ❌ ${name}\n      ${(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : err)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

const TOPICS = ['Identificación de peligros', 'Evaluación de riesgos', 'Controles de ingeniería', 'Elementos de protección', 'Investigación de incidentes', 'Plan de emergencias', 'Indicadores de seguridad', 'Cultura preventiva'];
const course = (mods, chs) => ({ course: { title: 'Seguridad y salud en el trabajo', finalExam: true, activityEngine: 'h5p' }, modules: Array.from({ length: mods }, (_, i) => ({ id: `m${i + 1}`, title: TOPICS[i], objective: 'Aplicar procedimientos de prevención', examEnabled: true, chapters: Array.from({ length: chs }, (_, j) => ({ id: `m${i + 1}c${j + 1}`, title: `${TOPICS[i]}: tema ${j + 1}`, objective: 'Analizar riesgos y proponer controles' })) })) });
const profile = (h) => ({ pedagogyProfileVersion: 1, primaryApproach: 'competencias', secondaryApproaches: [], learner: { description: 'Supervisores de planta', ageGroup: 'adults', educationLevel: 'technical', priorKnowledge: 'basic', experience: 'some' }, learningOutcomes: { know: ['Los tipos de riesgo'], do: ['Evaluar riesgos de una tarea', 'Proponer controles'], competencies: ['Gestiona la prevención en su área'] }, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', targetHours: h, designPreferences: { audiovisual: 'recommended' } });
const DOC6 = { sources: { chapters: 'REQ-contenidos' }, modulesFixed: 3, contentChaptersPerModule: { min: 2 } };
const LEV = (kinds) => ({ audiovisual: { base: 'recommended', locked: false }, guidedPractice: { base: 'auto', locked: false }, emphasis: { base: 'balanced', locked: false }, ...(kinds ? { activityKinds: { base: 'none', locked: false } } : {}) });

const CASES = [];
for (const [name, s, doc] of [['S', () => course(3, 2), null], ['M', () => course(6, 1), null], ['L', () => course(8, 2), null], ['DOC6', () => course(3, 2), DOC6]]) {
  for (const [h, budgets] of [[20, [15, 30, 60]], [60, [35, 62, 90]], [100, [60, 85, 150]]]) {
    for (const b of budgets) for (const kinds of (process.argv.includes('--full') ? [false, true] : [true])) CASES.push({ name, s, doc, h, b, kinds });
  }
}
const inputOf = (c, h) => ({ base: { structure: c.s(), profile: profile(h), activityTypeRules: 2, ...(c.doc ? { requirementConstraints: c.doc } : {}) }, levers: LEV(c.kinds) });

/** Referencia exhaustiva de «horas que alcanzan»: todas las medias horas desde la meta − 0,5 hacia abajo. */
function exhaustiveHoursAtBudget(c, minH) {
  for (let h = c.h - 0.5; h >= minH - 1e-9; h -= 0.5) {
    const hh = Math.round(h * 2) / 2;
    const r = F.fitDesignToBudget({ ...inputOf(c, hh), budgetUsd: c.b, searchAlternatives: false, prune: true });
    if (r.status === 'fits' && r.chosen) return { targetHours: hh, sha: r.chosen.proposalSha256, expected: r.chosen.cost.expected };
  }
  return null;
}

console.log('r79.1 · búsqueda de «No cabe»: optimizada = exhaustiva');
// Calentar el proceso (JIT, módulos) para medir el rendimiento de verdad.
F.fitDesignToBudget({ ...inputOf(CASES[0], 20), budgetUsd: 30 });

const rows = [];
let maxMs = 0;
check(`S1 equivalencia con la búsqueda exhaustiva en ${CASES.length} casos (estado, mínimo y «horas que alcanzan» idénticos)`, () => {
  const bad = [];
  for (const c of CASES) {
    const t0 = Date.now();
    const r = F.fitDesignToBudget({ ...inputOf(c, c.h), budgetUsd: c.b });
    const ms = Date.now() - t0;
    const alt = r.alternatives.find((a) => a.kind === 'hours_at_budget') || null;
    const row = { case: `${c.name} ${c.h}h USD${c.b}${c.kinds ? ' +tipos' : ''}`, status: r.status, ms, hoursAtBudget: alt ? alt.adjust.targetHours : null };
    if (r.status === 'does_not_fit') {
      // minH: el mismo piso que usa la búsqueda (horas base de la estructura sin Actividades).
      const ref = F.fitDesignToBudget({ ...inputOf(c, c.h), budgetUsd: 5000, searchAlternatives: false });
      const base = require(path.join(distRoot, 'modules/pedagogy/index.js')).runPedagogyDryRun({ ...inputOf(c, c.h).base }).distribution;
      const minH = Math.max(1, Math.ceil(base.baseHours * 2) / 2);
      const ex = exhaustiveHoursAtBudget(c, minH);
      row.exhaustive = ex ? ex.targetHours : null;
      if ((ex ? ex.targetHours : null) !== (alt ? alt.adjust.targetHours : null)) bad.push(`${row.case}: optimizada ${alt ? alt.adjust.targetHours : '—'} h, exhaustiva ${ex ? ex.targetHours : '—'} h`);
      else if (ex && alt && ex.sha !== alt.design.proposalSha256) bad.push(`${row.case}: mismo h (${ex.targetHours}) pero otro diseño`);
      void ref;
    }
    if (r.status !== 'fits') maxMs = Math.max(maxMs, ms);
    rows.push(row);
  }
  assert(bad.length === 0, `${bad.length} diferencias:\n      ${bad.join('\n      ')}`);
});

// gate-core limpia el entorno (env -i): CI se reconoce también por el runner Linux (la referencia de 2 s es la local, macOS).
const LIMIT_MS = process.env.CI || process.platform === 'linux' ? 6000 : 2000;
check(`S2 rendimiento: cada «No cabe» / «Imposible» en < ${LIMIT_MS / 1000} s (cursos grandes y con documento)`, () => {
  const slow = rows.filter((r) => r.status !== 'fits' && r.ms >= LIMIT_MS);
  console.log(`      máximo ${maxMs} ms · ${rows.filter((r) => r.status !== 'fits').length} casos sin «Cabe»`);
  assert(slow.length === 0, `lentos: ${slow.map((r) => `${r.case} ${r.ms} ms`).join(', ')}`);
});

check('S3 sin red', () => { assert(netAttempts.length === 0, netAttempts.join(', ')); });

console.log('\n| caso | estado | ms | horas que alcanzan (optimizada) | exhaustiva |');
console.log('|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.case} | ${r.status} | ${r.ms} | ${r.hoursAtBudget ?? '—'} | ${r.exhaustive === undefined ? '' : r.exhaustive ?? '—'} |`);
void D;
console.log(`\n${passes} OK, ${failures} fallidas`);
process.exit(failures ? 1 : 0);
