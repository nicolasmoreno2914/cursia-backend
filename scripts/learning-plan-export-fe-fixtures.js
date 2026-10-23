#!/usr/bin/env node
/* eslint-disable */
// T2 (r57) — exporta salidas REALES del backend compilado (dist/) para el harness del frontend
// test-68-learning-plan.mjs (panel 49 con metodología y tipo de aprendizaje + espejo del ejecutor 45).
// Curso genérico (scripts/lib/learning-plan-fixtures.js). Sin red, sin DB, sin gasto.
//
// Usage: node scripts/learning-plan-export-fe-fixtures.js <frontend-repo>/src/js/__harness__/fixtures [path/to/dist]

const fs = require('fs');
const path = require('path');

const [outDir, distArg] = process.argv.slice(2);
if (!outDir) {
  console.error('Uso: node scripts/learning-plan-export-fe-fixtures.js <dir de fixtures del frontend> [dist]');
  process.exit(2);
}
const dist = path.resolve(process.cwd(), distArg || 'dist');
const P = require(path.join(dist, 'modules/pedagogy/index.js'));
const svc = require(path.join(dist, 'modules/pedagogy/pedagogy.service.js'));
const L = require('./lib/learning-plan-fixtures');

const slim = (r) => {
  const out = JSON.parse(JSON.stringify(r));
  for (const k of ['baseline', 'pedagogical']) if (out[k]) out[k] = { blueprintSha256: out[k].blueprintSha256, manifestErrors: out[k].manifestErrors, totals: out[k].manifest.totals, estimateUsd: out[k].providers.estimateUsd };
  delete out.appliedRules; delete out.rules; out.generators = []; out.distribution = null;
  return out;
};
const prof = (lp) => L.baseProfile(lp ? { learningPlan: lp } : {});
const C8 = L.uuid('c', 8);
const lm = L.lockAndManifest(dist, L.STRUCTURE, prof({ framework: 'gagne_9_eventos' }), 2);
const expItem = lm.manifest.items.find((i) => i.type === 'experience' && i.chapterId === L.uuid('c', 1));
const out = {
  _generated: 'Salidas REALES del backend (plan de aprendizaje T2 r57 + composición T3 r57) para test-68-learning-plan.mjs. Regenerar con scripts/learning-plan-export-fe-fixtures.js.',
  catalog: svc.PedagogyService.prototype.catalog.call({}),
  dryRunTdp: Object.assign(slim(P.runPedagogyDryRun({ structure: L.STRUCTURE, profile: prof({ framework: 'teoria_demostracion_practica' }) })), { profileSource: 'request', savedProfileVersion: 0 }),
  dryRunTdpOverride: Object.assign(slim(P.runPedagogyDryRun({ structure: L.STRUCTURE, profile: prof({ framework: 'teoria_demostracion_practica', chapterOverrides: { [C8]: { learningType: 'conceptual' } } }) })), { profileSource: 'request', savedProfileVersion: 0 }),
  overrideChapterId: C8,
  // T3 (r57): composición por necesidad (videos por tipo de aprendizaje) con horas objetivo: el diseño recomendado
  // trae la decisión de video por capítulo.
  dryRunTdpComposition: Object.assign((() => {
    const r = P.runPedagogyDryRun({ structure: L.STRUCTURE, profile: { ...prof({ framework: 'teoria_demostracion_practica', composition: { videos: 'by_need', maxVideos: 4 } }), targetHours: 20 } });
    const d = r.distribution;
    const out = slim(r);
    // La propuesta completa (la tarjeta de horas la usa); sin el detalle del modelo de tiempo por capítulo.
    out.distribution = JSON.parse(JSON.stringify(d));
    delete out.distribution.studyTime;
    return out;
  })(), { profileSource: 'request', savedProfileVersion: 0 }),
  experienceBriefGagne: P.buildItemPedagogyBrief({ item: expItem, snapshot: lm.snapshot, activityTypeRules: 2 }),
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'learning-plan-backend-v1.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`✅ ${path.join(outDir, 'learning-plan-backend-v1.json')}`);
