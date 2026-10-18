#!/usr/bin/env node
/* eslint-disable */
// r58 (I6) — SUPUESTO DE LA FASE B: ¿el producto acepta un curso NUEVO de 1 módulo × 1 capítulo con examEnabled=false y
// finalExam=false (medios en mock) a través de Prebrief → Blueprint → Manifest → plan de claims? Check puro contra dist/
// (`npm run build` antes). Curso SINTÉTICO (scripts/fixtures/commercial-simulation/courses.json, «1x1-sin-examenes»),
// LLM falso, Gamma/TTS/Videogen simulados, barrera de red, sin DB ni Storage, USD 0.
//
//   OB1 perfiles: el perfil pedagógico (designPreferences applicationActivities/guidedPractice = none) y el de evaluación
//       con finalExam=false pasan los validadores reales del backend
//   OB2 Manifest = lista blanca de la Fase B (11 items; sin exam, final_exam, application_activity, guided_practice ni
//       capítulos de práctica); validateGenerationManifestV3 sin errores; Prebrief = Manifest (0 exámenes, 0 AA)
//   OB3 Verificación (verifyDesign, el cálculo del gate R68 GENERATION_NOT_VERIFIED y del Prebrief) con lo que produce el
//       distribuidor: aplicable, sin cambios pendientes, sin críticos; «El curso no tiene evaluaciones» es ADVERTENCIA;
//       prebriefReadiness sin bloqueos de diseño (críticos / pendientes / no aplicable)
//   OB4 plan de claims: el driver offline reclama y genera los 11 items en orden topológico (claim = el del scheduler),
//       todos validados por el validador de completeItem; empaque qa_preview válido (validateMbzV3), 0 quiz, marca
//       sintética, informe de calidad sin BLOCKER; ningún item queda como fixture del empaque
//   OB5 FinOps del run (modos mock de video/presentación/audio): solo items de IA en el estimado, 0 proveedores pagados
//       reales; decideRunBudget sin proveedor pagado
//   OB6 nota y aprobación (r55): con H5P calificable → criterio de nota del curso, SIN insignia (no hay evaluación
//       final); sin ítems calificables («1x1-sin-nota») → curso sin nota, completion por vista del Libro, sin insignia
//   OB7 los límites de la forma (para el plan de la Fase B): con examEnabled=true aparece exam:<m>; con
//       applicationActivities=auto aparece una AA; con 3 h el distribuidor agrega capítulos de práctica → el experimento
//       debe usar ≤ 2,5 h y las dos preferencias en none
//
// Uso: node scripts/check-r58-one-by-one.js [--out=<dir>]
'use strict';
require('reflect-metadata');
const fs = require('fs');
const os = require('os');
const path = require('path');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const S = require('./lib/commercial-simulation');
const D = require('./lib/offline-driver');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/commercial-simulation/courses.json'), 'utf8'));
const CFG = CONFIG.courses.find((c) => c.id === '1x1-sin-examenes');
const CFG_NG = CONFIG.courses.find((c) => c.id === '1x1-sin-nota');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6) || fs.mkdtempSync(path.join(os.tmpdir(), 'check-r58-one-by-one-'));
const L = (rel) => require(path.join(DIST, rel));
const WHITELIST = ['activity', 'audio_welcome', 'audiobook_chapter', 'content', 'course_intro', 'course_plan', 'experience', 'module_intro', 'presentation', 'video', 'video_interactions'];
const LLM_TYPES = ['activity', 'content', 'course_intro', 'course_plan', 'experience', 'module_intro', 'video_interactions'];

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.error(`❌ ${name}\n   ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 5).join('\n   ')}`); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const eq = (a, b, msg) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${msg}: ${x.slice(0, 500)} !== ${y.slice(0, 500)}`); };
const typesOf = (manifest) => manifest.items.map((i) => i.type).sort();
const evidence = {};

/** La entrada de verifyDesign como la arma CourseDesignService.recommend (sin documento académico ni formato). */
function verificationOf(prep) {
  const DV = L('modules/course-design/design-verification.js');
  const d = prep.dryRun.distribution;
  const prefs = d.preferences || {};
  return DV.verifyDesign({
    growth: 'any', status: d.status, targetHours: d.targetHours, estimatedHours: d.estimatedHours, toleranceHours: d.toleranceHours, baseHours: d.baseHours,
    counts: d.counts, manifestErrors: d.materialized ? d.materialized.manifestErrors : [{ code: 'NOT_MATERIALIZED' }], alignment: d.materialized ? d.materialized.alignment : null,
    approach: { id: prep.profile.primaryApproach, label: prep.profile.primaryApproach }, policyKind: d.policy ? d.policy.kind : null, audiovisual: prefs.audiovisual || null, pinnedChapters: 0,
    cost: d.materialized && d.materialized.providers ? d.materialized.providers.estimateUsd : null,
    preferences: { emphasis: prefs.emphasis || 'balanced', applicationActivities: prefs.applicationActivities || 'auto' },
    autoLink: { chapterIds: [], outcomeIds: [], preview: [] }, proposedChapterIds: d.modules.flatMap((m) => m.chapters.filter((c) => c.proposed).map((c) => c.id)),
    uncoveredContents: [], contentCoverage: null, requiredEvaluations: [], pinnedApplicationsOutsideMode: [], uncoveredEvaluations: [], requirementChecks: [], format: null,
  });
}
/** La tarjeta de «Cursia recomienda» que leen el gate R68 y prebriefReadiness (campos que usan). */
function cardOf(prep, verification) {
  const d = prep.dryRun.distribution;
  return {
    verification, profileChanged: false,
    design: { status: d.status, applicable: d.status !== 'minimum_exceeds_target' && !!d.materialized && !d.materialized.manifestErrors.length, changes: d.changes, modules: d.modules },
  };
}

(async () => {
  assert(CFG && CFG_NG, 'faltan los cursos 1x1 en courses.json');
  if (!D.loadH5p2Fixture()) {
    console.log('❌ faltan las fixtures H5P v2 del LLM falso (fixtures/h5p2/fake-llm-h5p2.json del frontend): definir CURSIA_FRONTEND_REPO');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const prep = await S.prepareCourse(DIST, CFG);

  await check('OB1 perfiles: pedagógico (applicationActivities/guidedPractice = none) y de evaluación con finalExam=false pasan los validadores reales', () => {
    const CP = L('modules/course-profiles/course-profiles.js');
    eq(CP.validateProfile('pedagogy', prep.profile, { finalExam: false }), [], 'perfil pedagógico');
    eq(CP.validateProfile('assessment', prep.assessment.profile, { finalExam: false }), [], 'perfil de evaluación');
    eq(prep.locked.course.finalExam, false, 'finalExam=false congelado en el Blueprint');
    eq(prep.locked.modules.map((m) => m.examEnabled), [false], 'examEnabled=false congelado en el Blueprint');
    eq(prep.dryRun.distribution.preferences.applicationActivities, 'none', 'preferencia AA');
  });

  await check('OB2 Manifest = lista blanca de la Fase B (11 items, sin exámenes ni AA ni práctica); validateGenerationManifestV3 limpio; Prebrief = Manifest', () => {
    const MB = L('modules/generation-manifests/generation-manifest-builder.js');
    eq([...new Set(typesOf(prep.manifest))], WHITELIST, 'tipos');
    eq(prep.manifest.items.length, WHITELIST.length, 'un item por tipo');
    eq(prep.manifest.modules.map((m) => m.chapters.length), [1], '1 módulo × 1 capítulo (sin capítulos de práctica)');
    eq(prep.manifest.features.finalExam, false, 'features.finalExam');
    const source = { courseId: prep.locked.course.id, blueprintId: 1, blueprintNumber: 1, blueprintSha256: prep.manifest.source.blueprintSha256 };
    eq(MB.validateGenerationManifestV3(prep.manifest, prep.locked, source), [], 'validateGenerationManifestV3');
    eq([prep.prebrief.resources.moduleExams, prep.prebrief.resources.applicationActivities, prep.prebrief.resources.videos], [0, 0, 1], 'Prebrief (exámenes / AA / videos)');
    const RS = L('modules/dynamic-generation/runs.service.js');
    const pc = RS.previewCounts({ manifest: prep.manifest });
    eq([pc.modules, pc.chapters, pc.moduleExams, pc.finalExam, pc.videos, pc.activities], [1, 1, 0, false, 1, 1], 'estimate-preview (previewCounts)');
    evidence.manifest = { types: typesOf(prep.manifest), hours: prep.dryRun.distribution.estimatedHours, status: prep.dryRun.distribution.status };
  });

  await check('OB3 Verificación (gate R68 + Prebrief): aplicable, sin pendientes ni críticos; «sin evaluaciones» = advertencia; prebriefReadiness sin bloqueos de diseño', () => {
    const v = verificationOf(prep);
    const card = cardOf(prep, v);
    eq(v.blocking, false, `verificación bloqueante: ${JSON.stringify(v.checks.filter((c) => c.severity === 'critical'))}`);
    eq(card.design.applicable, true, 'diseño aplicable');
    eq(card.design.changes.length, 0, 'sin cambios pendientes');
    const ev = v.checks.find((c) => c.id === 'evaluations');
    eq([ev && ev.severity, ev && ev.title], ['warning', 'El curso no tiene evaluaciones'], 'evaluaciones');
    const PR = L('modules/prebrief/prebrief-readiness.js');
    const r = PR.prebriefReadiness(prep.prebrief, card, [], []);
    const designCodes = ['design_unavailable', 'design_not_applicable', 'critical', 'pending_changes', 'design_not_saved', 'no_structure'];
    eq(r.blockers.filter((b) => designCodes.includes(b.code)), [], 'bloqueos de diseño');
    evidence.verification = { blocking: v.blocking, counts: v.counts, warnings: v.checks.filter((c) => c.severity === 'warning').map((c) => c.id), prebriefOtherBlockers: r.blockers.map((b) => b.code) };
  });

  await check('OB4 plan de claims (driver offline): los 11 items reclamados y generados en orden topológico, validados; qa_preview válido sin quiz; calidad sin BLOCKER', async () => {
    const r = await D.runComponents(DIST, CFG, { select: WHITELIST.map((type) => ({ type })), package: true });
    assert(r.ok, `driver: ${JSON.stringify(r.errors.slice(0, 3))}`);
    eq(r.selection.order.map((k) => k.split(':')[0]).sort(), WHITELIST, 'items reclamados');
    const pos = new Map(r.selection.order.map((k, i) => [k, i]));
    for (const it of prep.manifest.items) for (const dep of it.dependsOn || []) assert(pos.get(dep) < pos.get(it.key), `${it.key} antes que su dependencia ${dep}`);
    eq(r.package.packageFixtures, [], 'ningún item del empaque viene de fixtures');
    eq(r.package.validation.ok, true, 'validateMbzV3');
    eq(r.package.facts.counts.exams, 0, 'sin exámenes en el paquete');
    eq(r.package.marker.deliverable, false, 'marca sintética (no entregable)');
    eq(r.package.qualityReport.counts.BLOCKER, 0, 'informe de calidad sin BLOCKER');
    const insp = await S.inspectMbz(r.package.mbz);
    eq([insp.byModname.quiz || 0, insp.badges], [0, 0], 'quiz / insignias en el .mbz');
    fs.writeFileSync(path.join(OUT, 'one-by-one-driver.mbz'), r.package.mbz);
    evidence.driver = { order: r.selection.order.map((k) => k.split(':')[0]), mbzSha256: r.package.sha256, quality: r.package.qualityReport.counts, qualityCodes: r.package.qualityReport.findings.map((f) => `${f.severity}:${f.code}`) };
  });

  await check('OB5 FinOps con video/presentación/audio en mock: el estimado solo trae items de IA, sin proveedores pagados reales', () => {
    const RB = L('modules/finops/run-budget.js');
    const F = L('modules/finops/index.js');
    const modes = RB.runSpendModes('mock', { presentation: 'mock', audio: 'mock' });
    const items = RB.estimateItemsForRun(prep.manifest.items, modes);
    eq(items.map((i) => i.itemType).sort(), LLM_TYPES, 'items del estimado');
    eq(RB.paidRealProviders(items, modes), [], 'proveedores pagados reales');
    const { loadPricingSeed } = require('./migrate-v21-finops');
    const catalog = loadPricingSeed().rows.map((r0, i) => ({ id: `seed-${i}`, ...r0 }));
    const est = F.estimateCost({ items, catalog, usageModel: F.usageModelPriorsV1(), retryPolicy: { maxRetries: 1 } });
    assert(Number(est.totals.expected) > 0 && Number(est.totals.max) < 5, `estimado fuera del techo de la Fase B: ${JSON.stringify(est.totals)}`);
    eq(Object.keys(est.totals.byProvider || {}).filter((p) => p !== 'anthropic'), [], 'solo Anthropic');
    const dec = RB.decideRunBudget({ estimate: est, policy: null, paidRealProviders: [] });
    eq(dec.paidRealProviders, [], 'decideRunBudget');
    evidence.finops = { expected: est.totals.expected, max: est.totals.max, byItemType: Object.fromEntries(Object.entries(est.totals.byItemType || {}).map(([k, v]) => [k, v.expected])), decision: dec.decision };
  });

  await check('OB6 nota y aprobación (r55): con H5P calificable → criterio de nota sin insignia; sin ítems calificables → sin nota, completion por el Libro', async () => {
    const a = await S.simulateCourse(DIST, CFG);
    const ia = await S.inspectMbz(a.built.mbz);
    const ra = a.built.expectations.resolved;
    eq([a.validation.ok, !!ra.withoutGrades, ra.courseCompletion.requireCourseGradePass, ia.badges], [true, false, true, 0], '1x1 sin exámenes');
    eq(ra.categories.map((c) => [c.key, c.weight]), [['practice', 100]], 'categoría única: práctica 100 %');
    assert((a.built.summary.warnings || []).includes('certificate_omitted:no_final_exam'), 'aviso visible: certificado omitido');
    const b = await S.simulateCourse(DIST, CFG_NG);
    const ib = await S.inspectMbz(b.built.mbz);
    const rb = b.built.expectations.resolved;
    eq([b.validation.ok, !!rb.withoutGrades, rb.courseCompletion.requireCourseGradePass, ib.badges, ib.byModname.quiz || 0, ib.h5p.filter((h) => h.hasGradeItem).length], [true, true, false, 0, 0, 0], '1x1 sin nota');
    eq(ib.completionCriteria, [4], 'un criterio de actividad (vista del Libro)');
  });

  await check('OB7 límites de la forma: examEnabled=true → exam; applicationActivities=auto → AA; 3 h → capítulos de práctica (el experimento usa ≤ 2,5 h y ambas preferencias en none)', async () => {
    const clone = () => JSON.parse(JSON.stringify(CFG));
    const withExam = clone(); withExam.modules[0].examEnabled = true;
    assert(typesOf((await S.prepareCourse(DIST, withExam)).manifest).includes('exam'), 'examEnabled=true sin exam');
    const auto = clone(); auto.targetHours = 3; auto.pedagogy.designPreferences.applicationActivities = 'auto';
    assert(typesOf((await S.prepareCourse(DIST, auto)).manifest).includes('application_activity'), 'auto sin AA');
    const three = clone(); three.targetHours = 3;
    const p3 = await S.prepareCourse(DIST, three);
    assert(p3.manifest.modules[0].chapters.length > 1 && p3.manifest.modules[0].chapters.some((c) => c.kind === 'practice'), '3 h sin capítulos de práctica');
    for (const h of [1, 1.5, 2, 2.5]) {
      const c = clone(); c.targetHours = h;
      eq([...new Set(typesOf((await S.prepareCourse(DIST, c)).manifest))], WHITELIST, `${h} h: lista blanca`);
    }
    evidence.limits = { threeHoursChapters: p3.manifest.modules[0].chapters.map((c) => c.kind || 'content'), whitelistHours: [1, 1.5, 2, 2.5] };
  });

  fs.writeFileSync(path.join(OUT, 'one-by-one-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`\n${passed} ok, ${failed} fallos (evidencia: ${path.join(OUT, 'one-by-one-evidence.json')})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
