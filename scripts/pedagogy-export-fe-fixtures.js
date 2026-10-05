#!/usr/bin/env node
/* eslint-disable */
// Motor pedagógico — exporta salidas REALES del backend compilado (dist/) como fixtures de los
// harness del frontend (cursia: src/js/__harness__/fixtures/). Sin red, sin DB, sin gasto.
//
//   pedagogy-backend-v1.json   catálogo, preguntas, recomendación y dry-run (panel 49)
//   pedagogy-prompts-rcp.json  RCP × 5 enfoques (+ sin perfil): los items del Manifest como los
//                              entrega el claim (outline + brief pedagógico), para armar los
//                              prompts FINALES con los builders reales del navegador (test-50)
//
// Usage: node scripts/pedagogy-export-fe-fixtures.js <frontend-repo>/src/js/__harness__/fixtures [path/to/dist]

const fs = require('fs');
const path = require('path');

const [outDir, distArg] = process.argv.slice(2);
if (!outDir) {
  console.error('Uso: node scripts/pedagogy-export-fe-fixtures.js <dir de fixtures del frontend> [dist]');
  process.exit(2);
}
const REPO = path.resolve(__dirname, '..');
const dist = path.resolve(process.cwd(), distArg || 'dist');
const P = require(path.join(dist, 'modules/pedagogy/index.js'));
const FIX = path.join(REPO, 'scripts/fixtures/pedagogy');
const RCP = require(path.join(FIX, 'rcp-course.json'));
const PF = require(path.join(FIX, 'profiles.json'));
const APPROACHES = ['competencias', 'problemas', 'experiencial', 'significativo', 'autodirigido'];
const prof = (k) => ({
  pedagogyProfileVersion: 1, primaryApproach: PF.profiles[k].primaryApproach, secondaryApproaches: PF.profiles[k].secondaryApproaches,
  learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual',
});

// ── pedagogy-backend-v1.json (panel 49) ──
const slim = (r) => {
  const out = JSON.parse(JSON.stringify(r));
  for (const k of ['baseline', 'pedagogical']) if (out[k]) out[k] = { blueprintSha256: out[k].blueprintSha256, manifestErrors: out[k].manifestErrors, totals: out[k].manifest.totals, estimateUsd: out[k].providers.estimateUsd };
  delete out.appliedRules; delete out.rules;
  // Fase 2 · «Ver diseño»: del modelo de tiempo solo lo que lee el panel (piezas y minutos por capítulo).
  if (out.distribution && out.distribution.studyTime) {
    out.distribution.studyTime = { modules: out.distribution.studyTime.modules.map((m) => ({ chapters: m.chapters.map((c) => ({ chapterId: c.chapterId, chapterEstimatedMinutes: c.chapterEstimatedMinutes, resources: c.resources.map((r) => ({ resource: r.resource, minutes: r.minutes })) })) })) };
  }
  return out;
};
const reg = P.defaultApproachRegistry();
const panel = {
  _generated: 'Salidas REALES del backend (orbia-backend src/modules/pedagogy; dry-run recortado: sin Blueprints/Manifests completos) para el harness test-49-pedagogy-panel. Regenerar con scripts/pedagogy-export-fe-fixtures.js.',
  catalog: { engineVersion: 1, approaches: reg.list().map((a) => ({ id: a.id, label: a.label, shortLabel: a.shortLabel, summary: a.summary, sequence: a.sequence })), labels: { values: P.PEDAGOGY_VALUE_LABELS, sections: P.PEDAGOGY_SECTION_LABELS, targets: P.PEDAGOGY_TARGET_LABELS, roles: P.PEDAGOGY_ROLE_LABELS } },
  wizard: { questions: P.WIZARD_QUESTIONS, approaches: reg.list().map((a) => ({ id: a.id, label: a.label })) },
  recommendRcpAnswers: PF.wizardAnswers['rcp-practico'],
  recommendRcp: P.recommendApproaches(PF.wizardAnswers['rcp-practico']),
  dryRunProblemas: slim(Object.assign(P.runPedagogyDryRun({ structure: RCP, profile: prof('problemas') }), { profileSource: 'request', savedProfileVersion: 0 })),
  dryRunEmpty: slim(Object.assign(P.runPedagogyDryRun({ structure: RCP, profile: null }), { profileSource: 'none', savedProfileVersion: 0 })),
  // Motor de carga horaria (Loop 3): RCP con «Repaso» + competencias + 33 h, y sin enfoque + 8 h (mínimo supera el objetivo).
  dryRunCompetencias33: slim(Object.assign(P.runPedagogyDryRun({ structure: { ...RCP, course: { ...RCP.course, reviewCards: true } }, profile: { ...prof('competencias'), targetHours: 33 } }), { profileSource: 'request', savedProfileVersion: 0 })),
  dryRunHours8: slim(Object.assign(P.runPedagogyDryRun({ structure: { ...RCP, course: { ...RCP.course, reviewCards: true } }, profile: { ...P.emptyPedagogicalProfile(), targetHours: 8 } }), { profileSource: 'request', savedProfileVersion: 0 })),
};

// ── pedagogy-prompts-rcp.json (test-50) ──
// Outline y campos del item con la MISMA forma que ClaimedItem (scheduler.buildClaimedItem).
function claimsOf(side) {
  const snap = side.blueprint;
  const man = side.manifest;
  const outline = man.modules.map((mm) => {
    const sm = snap.modules.find((m) => m.id === mm.moduleId);
    return {
      moduleNumber: mm.moduleNumber, id: sm.id, title: sm.title, objective: sm.objective ?? null, description: sm.description ?? null,
      chapters: mm.chapters.map((mc) => {
        const sc = sm.chapters.find((c) => c.id === mc.chapterId);
        return { chapterNumber: mc.chapterNumber, id: sc.id, title: sc.title, objective: sc.objective ?? null, description: sc.description ?? null };
      }),
    };
  });
  const rules = man.features && man.features.activityTypeRules;
  const items = man.items.map((it) => {
    const brief = P.buildItemPedagogyBrief({ item: it, snapshot: snap, activityTypeRules: rules ?? null });
    return {
      itemKey: it.key, type: it.type, moduleId: it.moduleId, chapterId: it.chapterId, moduleNumber: it.moduleNumber, chapterNumber: it.chapterNumber,
      ...(it.variant ? { variant: it.variant } : {}), ...(it.h5pType ? { h5pType: it.h5pType } : {}),
      ...(brief ? { pedagogy: { version: brief.version, engineVersion: brief.engineVersion, generator: brief.generator, text: brief.text, textSha256: brief.textSha256 } } : {}),
    };
  });
  return { outline, items };
}
const base = P.runPedagogyDryRun({ structure: RCP, profile: null, applyStructureAdjustments: false });
const prompts = {
  _generated: 'Salidas REALES del backend: el Manifest v3 del curso RCP (scripts/fixtures/pedagogy/rcp-course.json) con cada enfoque, como lo entrega el claim (outline + brief pedagógico de cada item). Sin aplicar sugerencias de estructura (igual que el lock). Regenerar con scripts/pedagogy-export-fe-fixtures.js.',
  courseContext: { nombre: RCP.course.title, sector: 'Salud', pais: 'Colombia', contexto: 'Auxiliares de enfermería de planta hospitalaria', nivel: 'Técnico', tono: 'Profesional y cercano', comp: 'Atender un paro cardiorrespiratorio con RCP de alta calidad' },
  baseline: claimsOf(base.baseline),
  approaches: Object.fromEntries(APPROACHES.map((a) => [a, claimsOf(P.runPedagogyDryRun({ structure: RCP, profile: prof(a), applyStructureAdjustments: false }).pedagogical)])),
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'pedagogy-backend-v1.json'), JSON.stringify(panel, null, 1) + '\n');
fs.writeFileSync(path.join(outDir, 'pedagogy-prompts-rcp.json'), JSON.stringify(prompts, null, 1) + '\n');
console.log(`✅ fixtures escritos en ${outDir}`);
