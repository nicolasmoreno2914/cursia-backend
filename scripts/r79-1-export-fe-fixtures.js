#!/usr/bin/env node
/* eslint-disable */
// r79.1: fixtures del harness del frontend (test-90-r79-1-activity-kinds.mjs) salidas del backend REAL (sin IA, sin red):
//   - claim de cada tipo y nivel (applicationClaimSpec: especificación, cantidades, pisos, resultados, capítulos del módulo,
//     prácticas a revisar) y un documento sintético válido de cada uno, con los códigos que da el validador del servidor a
//     un conjunto de mutaciones (el harness exige los MISMOS en el ejecutor del navegador: paridad sin el backend);
//   - un diseño de «Cursia recomienda» con tipos (dry-run real) para la tarjeta y la lista de capítulos.
//
// Uso: node scripts/r79-1-export-fe-fixtures.js [dist] --fe <repo del frontend>
'use strict';
const path = require('path');
const fs = require('fs');
const args = process.argv.slice(2);
const feI = args.indexOf('--fe');
const fe = path.resolve(feI >= 0 ? args[feI + 1] : process.env.CURSIA_FRONTEND_REPO || '');
const dist = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--fe') || 'dist');
const L = (r) => require(path.join(dist, r));
const K = L('modules/course-shell/application-kinds.js');
const AA = L('modules/course-shell/application-activity.js');
const P = L('modules/pedagogy/index.js');
const SF = require('./lib/v21-shell-fixtures');
const F = require('./lib/r79-1-activity-fixtures');
const V = require('./lib/v21-packaging-fixtures');
const PF = require('./fixtures/pedagogy/profiles.json');

const codes = (errs) => [...new Set(errs.map((e) => e.code))].sort();
const built = SF.buildCourse(dist, { courseId: 7911, finalExam: true, engine: 'h5p', activityTypeRules: 2, modules: [
  { examEnabled: true, chapters: [{ video: true, activity: true, application: 60, appKind: 'case_study' }, { video: false, activity: true, application: 120 }, { practice: true, activity: true, application: 120, appKind: 'integrative_project' }, { practice: true, activity: true, application: 60, appKind: 'formative_feedback' }] },
  { examEnabled: false, chapters: [{ video: false, activity: true, application: 90, appKind: 'case_study' }, { practice: true, activity: true, application: 30, appKind: 'formative_feedback' }] }] });
const chs = built.snapshot.modules.flatMap((m) => m.chapters);
const MUTATIONS = {
  weights: (d) => { d.activity.criteria[0].weight += 3; },
  outcome: (d) => { d.activity.outcomeLinks[0].outcomeId = 'ZZ'; },
  marker: (d) => { d.activity.title = 'Respuesta: título'; },
  coverage: (d) => { d.solution.correctionGuide.pop(); },
  extra: (d) => { d.activity.extra = 1; },
};
const claims = [];
for (const [kind, minutes, ci] of [['case_study', 60, 0], ['case_study', 90, 4], ['integrative_project', 90, 2], ['integrative_project', 120, 2], ['formative_feedback', 30, 5], ['formative_feedback', 60, 3], ['formative_feedback', 90, 3]]) {
  const ch = chs[ci];
  const spec = K.applicationClaimSpec(kind, minutes, built.snapshot, ch.id);
  const ids = spec.outcomes.map((o) => o.id);
  const doc = F.kindDoc(V, kind, ch.id, minutes, ci + 1, { outcomeIds: ids });
  const ctx = { chapterId: ch.id, minutes, kind, outcomeIds: ids };
  const ok = codes(AA.validateApplicationActivityDoc(doc, ctx));
  if (ok.length) throw new Error(`fixture inválido ${kind} ${minutes}: ${ok}`);
  const mutated = {};
  for (const [name, f] of Object.entries(MUTATIONS)) { const d = JSON.parse(JSON.stringify(doc)); f(d); mutated[name] = codes(AA.validateApplicationActivityDoc(d, ctx)); }
  claims.push({ kind, minutes, chapter: { id: ch.id, title: ch.title }, claim: { minutes, chapterKind: ch.kind === 'practice' ? 'practice' : 'content', schemaVersion: AA.APPLICATION_ACTIVITY_SCHEMA_VERSION, ...spec }, doc, mutated });
}
// Diseño real con tipos (para la tarjeta del frontend).
const TOPICS = ['Identificación de peligros', 'Evaluación de riesgos', 'Controles de ingeniería', 'Elementos de protección'];
const s = { course: { title: 'SST', finalExam: true, activityEngine: 'h5p' }, modules: TOPICS.map((t, i) => ({ id: `m${i + 1}`, title: t, objective: 'Aplicar procedimientos de prevención', examEnabled: true, chapters: [0, 1].map((j) => ({ id: `m${i + 1}c${j + 1}`, title: `${t}: tema ${j + 1}`, objective: j === 0 ? 'Analizar riesgos y proponer controles' : 'Diseñar un plan de controles para la planta' })) })) };
const prof = { pedagogyProfileVersion: 1, primaryApproach: PF.profiles.competencias.primaryApproach, secondaryApproaches: PF.profiles.competencias.secondaryApproaches, learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', targetHours: 50, designPreferences: { audiovisual: 'recommended', maxContentChaptersPerModule: 2, activityKinds: 'auto' } };
const d = P.runPedagogyDryRun({ structure: s, profile: prof, activityTypeRules: 2 }).distribution;
const design = {
  status: d.status, estimatedHours: d.estimatedHours, counts: d.counts, activityKinds: d.activityKinds,
  modules: d.modules.map((m) => ({ id: m.id, title: m.title, examEnabled: m.examEnabled, chapters: m.chapters.map((c) => ({ id: c.id, proposed: c.proposed, kind: c.kind, title: c.title, role: c.role, videoEnabled: c.videoEnabled, videoPinned: c.videoPinned, applicationPinned: c.applicationPinned, activityEnabled: c.activityEnabled, review: c.review, applicationMinutes: c.applicationMinutes, hours: Math.round((c.targetMinutes / 60) * 10) / 10, ...(c.applicationKind ? { applicationKind: c.applicationKind } : {}), guidedPracticeMinutes: c.guidedPracticeMinutes ?? null, guidedPracticePinned: c.guidedPracticePinned, outcomeIds: [] })) })),
};
const out = { generatedWith: 'scripts/r79-1-export-fe-fixtures.js (backend r79.1)', applicationSchemaVersion: AA.APPLICATION_ACTIVITY_SCHEMA_VERSION, standardSpecV2: K.STANDARD_SPEC_V2, claims, design };
const file = path.join(fe, 'src/js/__harness__/fixtures/r79-1-activity-kinds-v1.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`escrito ${file} (${claims.length} claims, diseño con ${Object.values(d.activityKinds.counts).reduce((a, b) => a + b, 0)} tipos)`);
