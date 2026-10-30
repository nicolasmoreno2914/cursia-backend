#!/usr/bin/env node
/* eslint-disable no-console */
// r79.2 · §13.3 «Todos los USD de la interfaz con máximo 2 decimales» (backend). Puro, USD 0.
//   U1 usd2 / usd2Es: redondeo a 2 decimales (bordes, negativos, strings, no numéricos) sin tocar el valor de entrada
//   U2 la línea de costo de la Verificación del diseño (dry-run real) nunca muestra más de 2 decimales
//   U3 escaneo estático: ningún texto «USD ${…toFixed(n>2)}» ni «USD ${…expected/max}» crudo fuera de los logs
// Uso: npm run build && node scripts/check-r79-2-usd-display.js [path/to/dist]
'use strict';
const fs = require('fs');
const path = require('path');
const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const U = require(path.join(distRoot, 'modules/finops/usd-display.js'));
const P = require(path.join(distRoot, 'modules/pedagogy/index.js'));
let passes = 0;
let failures = 0;
function check(name, fn) {
  try { fn(); passes++; console.log(`  ✅ ${name}`); } catch (e) { failures++; console.log(`  ❌ ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`); }
}
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const MORE_THAN_2 = /USD\s*[-−]?\d[\d.]*[.,]\d{3,}/;

console.log('r79.2 · USD con máximo 2 decimales (backend)');
check('U1 usd2 / usd2Es', () => {
  eq([60.194014265, '60.1940142650', 0.005, 1.005, 2.675, -1.234, -0.001, 0, 1234.5678, '18', null, 'x'].map(U.usd2), ['60.19', '60.19', '0.01', '1.01', '2.68', '-1.23', '0.00', '0.00', '1234.57', '18.00', '?', 'x'], 'usd2');
  eq(U.usd2Es('60.1940142650'), '60,19', 'usd2Es');
});
check('U2 Verificación del diseño (dry-run real): costo con ≤ 2 decimales', () => {
  const RCP = require('./fixtures/pedagogy/rcp-course.json');
  const PF = require('./fixtures/pedagogy/profiles.json');
  let seen = 0;
  for (const h of [20, 33, 64]) {
    const profile = { pedagogyProfileVersion: 1, primaryApproach: PF.profiles.competencias.primaryApproach, secondaryApproaches: PF.profiles.competencias.secondaryApproaches, learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', targetHours: h };
    const d = P.runPedagogyDryRun({ structure: JSON.parse(JSON.stringify(RCP)), profile, activityTypeRules: 2 });
    const e = d.distribution.materialized.providers.estimateUsd;
    const V = require(path.join(distRoot, 'modules/course-design/design-verification.js'));
    const t = V.verifyDesign({ status: 'within_tolerance', targetHours: h, estimatedHours: h, toleranceHours: 1, baseHours: h / 2, counts: { modules: 3, chapters: 9, contentChapters: 9, practiceChapters: 0, videoChapters: 9, activities: 9, applicationActivities: 9, evaluations: 4 },
      manifestErrors: [], alignment: { available: true, coverage: { outcomes: 6, covered: 6, partial: 0, uncovered: 0 }, findings: [] }, approach: { id: 'competencias', label: 'Competencias' }, policyKind: 'application_first', audiovisual: 'recommended', pinnedChapters: 0,
      cost: { min: String(e.min), expected: String(e.expected), max: String(e.max) }, preferences: { emphasis: 'balanced', applicationActivities: 'auto' }, autoLink: { chapterIds: [], outcomeIds: [], preview: [] }, proposedChapterIds: [], uncoveredContents: [], requiredEvaluations: [], uncoveredEvaluations: [] }).checks.find((c) => c.area === 'cost');
    assert(t && /USD \d+,\d{2} \(entre \d+,\d{2} y \d+,\d{2}\)/.test(t.title) && !MORE_THAN_2.test(t.title), `${h} h: ${t && t.title}`);
    seen++;
  }
  eq(seen, 3, 'tres diseños');
});
check('U3 escaneo estático del backend: sin USD con más de 2 decimales en textos para la interfaz', () => {
  const bad = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.ts$/.test(f.name) && !/\.spec\.ts$/.test(f.name)) scan(p); } };
  const scan = (p) => fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
    if (/logger\.|console\.|\.warn\(|\.log\(/.test(l)) return; // logs del servidor: no son interfaz
    if (/USD \$\{[^}]*toFixed\([3-9]\)/.test(l) || /USD \$\{[^}]*estimate\??\.(expected|max|min)\}/.test(l)) bad.push(`${path.relative(process.cwd(), p)}:${i + 1}`);
  });
  walk(path.join(__dirname, '..', 'src'));
  eq(bad, [], 'textos con USD sin redondear');
});
console.log(`\n${passes} OK, ${failures} fallidas`);
process.exit(failures ? 1 : 0);
