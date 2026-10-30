#!/usr/bin/env node
/* eslint-disable no-console */
// r79.1 · Tipos de Actividad de Aplicación (estudio de caso, proyecto integrador, retroalimentación formativa) y nivel de
// 120 min reforzado. Puro: sin IA, sin red, sin base. USD 0.
//
//   K1  candado de proporcionalidad (§12.1, §13.2): tabla de trabajo especificado por tipo y nivel; con la especificación
//       v2 TODOS los niveles de siempre (30/60/90/120) pasan y tienen candado; con la v1 (la de antes) 60/90/120 NO; los
//       niveles de los tipos nuevos pasan y tienen candado
//   K2  el candado se cumple: con el de v1, ni el distribuidor ni el ajuste al presupuesto eligen 120 (lo fijado se respeta)
//   K3  validadores: documentos sintéticos mín./máx. de cada tipo y nivel válidos; mutaciones rechazadas con su código;
//       v1 sigue válido; v2 de 120 sin hitos rechazado; un tipo nuevo exige v2
//   K4  paridad con el ejecutor del navegador (CURSIA_FRONTEND_REPO): mismos códigos sobre los mismos casos
//   K5  Blueprint: application_kind solo con su nivel y su tipo de capítulo; sin tipos, sha de siempre; ida y vuelta
//   K6  Manifest: applicationKind en el item y el capítulo; el validador detecta tipo cambiado / en otro item; totales iguales
//   K7  FinOps: el item → la MISMA operación (llm.application_activity) con su escala por tipo y nivel; tipo ≥ siempre
//   K8  modelo de horas: el tipo no cambia minutos (horas idénticas con y sin tipos)
//   K9  criterios de valor K1–K3 (positivos y negativos), topes, pines, determinismo, motivo de cada decisión
//   K10 dry-run: sin la preferencia, distribución byte a byte la de siempre; con «automático», misma estructura y horas;
//       punto fijo de «Usar este diseño» (la estructura con los tipos aplicados vuelve a dar la misma propuesta)
//   K11 invalidación: el tipo entra a la huella de SU Actividad solo si existe (las demás, de siempre)
//   K12 claim: especificación del tipo (esquema + cantidades + pisos), resultados del capítulo, capítulos del módulo y
//       prácticas a revisar; validación del servidor al completar con el tipo y los resultados
//   K13 perfil: designPreferences.activityKinds solo «auto» se guarda; inválido rechazado; sin él, sha de siempre
//   K14 empaque: .mbz con los tres tipos (y el 120 v2) en los 7 estilos, validador verde; el validador se pone ROJO con
//       nombre sin el tipo, secciones faltantes, solucionario visible y marcas en la página del estudiante
//   K15 ajuste al presupuesto: palanca de tipos (ambos valores explorados), calidad con kindFit, nunca relleno (mismas
//       horas), guardas de r79 intactas, rechazo por candado contado
//   K16 ejecutor: el servidor exige 'application-activity-2' (documento v2) antes de reclamar
//
// Uso: npm run build && node scripts/check-r79-1-activity-kinds.js [path/to/dist]
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  globalThis.fetch = deny('fetch');
}

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const L = (r) => require(path.join(distRoot, r));
const K = L('modules/course-shell/application-kinds.js');
const AA = L('modules/course-shell/application-activity.js');
const AP = L('modules/course-shell/application-pages.js');
const KT = L('modules/study-time/application-kind-tiers.js');
const AK = L('modules/study-time/activity-kinds.js');
const SNAP = L('modules/course-blueprints/blueprint-snapshot.js');
const MB = L('modules/generation-manifests/generation-manifest-builder.js');
const P = L('modules/pedagogy/index.js');
const PP = L('modules/pedagogy/pedagogy-profile.js');
const RB = L('modules/finops/run-budget.js');
const OPS = L('modules/finops/operations.js');
const FP = L('modules/invalidation/fingerprints.js');
const V3 = L('modules/course-shell/v3-validation.js');
const BF = L('modules/course-design/budget-fit.js');
const SCHED = L('modules/dynamic-generation/scheduler.service.js');
const B = L('package/dynamic-mbz-builder-v3.js');
const VAL = L('package/v3/mbz-validator-v3.js');
const F = require('./lib/r79-1-activity-fixtures');
const V = require('./lib/v21-packaging-fixtures');
const SF = require('./lib/v21-shell-fixtures');
const PF = require('./fixtures/pedagogy/profiles.json');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ❌ ${name}\n      ${(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : err)}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const A = JSON.stringify(a); const Bs = JSON.stringify(b); if (A !== Bs) throw new Error(`${m}: esperado ${Bs}, encontrado ${A}`); }
const clone = (o) => JSON.parse(JSON.stringify(o));
const codes = (errs) => [...new Set(errs.map((e) => e.code))].sort();

const KIND_TIERS = [['case_study', 60], ['case_study', 90], ['integrative_project', 90], ['integrative_project', 120], ['formative_feedback', 30], ['formative_feedback', 60], ['formative_feedback', 90], ['formative_feedback', 120]];
const legacyLock = () => K.applicationTierLock((k, m) => (k === 'standard' ? K.specifiedWorkMinutes(k, m, 1) : K.specifiedWorkMinutes(k, m)));

// Curso sintético de SST (mismo vocabulario que los ejemplos de r79).
const TOPICS = ['Identificación de peligros', 'Evaluación de riesgos', 'Controles de ingeniería', 'Elementos de protección', 'Investigación de incidentes', 'Plan de emergencias', 'Indicadores de seguridad', 'Cultura preventiva'];
const course = (mods, chs, objective = (j) => (j === 0 ? 'Analizar riesgos y proponer controles' : 'Diseñar un plan de controles para la planta')) => ({
  course: { title: 'Seguridad y salud en el trabajo (sintético)', finalExam: true, activityEngine: 'h5p' },
  modules: Array.from({ length: mods }, (_, i) => ({ id: `m${i + 1}`, title: TOPICS[i % TOPICS.length], objective: 'Aplicar procedimientos de prevención', examEnabled: true,
    chapters: Array.from({ length: chs }, (_, j) => ({ id: `m${i + 1}c${j + 1}`, title: `${TOPICS[i % TOPICS.length]}: tema ${j + 1}`, objective: objective(j) })) })),
});
const profile = (h, dp = {}) => ({ pedagogyProfileVersion: 1, primaryApproach: PF.profiles.competencias.primaryApproach, secondaryApproaches: PF.profiles.competencias.secondaryApproaches,
  learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', targetHours: h, designPreferences: { audiovisual: 'recommended', ...dp } });
const dry = (structure, h, dp, extra = {}) => P.runPedagogyDryRun({ structure, profile: profile(h, dp), activityTypeRules: 2, ...extra });

(async () => {
  console.log('r79.1 · Tipos de Actividad de Aplicación y nivel de 120 reforzado');

  await check('K1 candado de proporcionalidad: v2 abre el 120 de siempre, v1 lo cierra; todos los niveles nuevos con candado y proporcionales', () => {
    const lock = K.applicationTierLock();
    const row = (k, m, l = lock) => l.find((r) => r.kind === k && r.minutes === m);
    assert(row('standard', 120).enforced && row('standard', 120).proportional && row('standard', 120).selectable, `120 v2 ${JSON.stringify(row('standard', 120))}`);
    const v1 = legacyLock();
    const r1 = row('standard', 120, v1);
    assert(r1.enforced && !r1.proportional && !r1.selectable, `120 v1 debería estar cerrado ${JSON.stringify(r1)}`);
    assert(r1.ratio < K.PROPORTIONALITY_FACTOR && row('standard', 120).ratio >= K.PROPORTIONALITY_FACTOR, 'densidad 120/90: v1 < 0,9 ≤ v2');
    for (const [k, m] of KIND_TIERS) {
      const r = row(k, m);
      assert(r && r.enforced && r.proportional && r.selectable, `${k} ${m}: ${JSON.stringify(r)}`);
      assert(K.isTierSelectable(k, m), `${k} ${m} seleccionable`);
    }
    // r79.2 (§13.2): 30/60/90 de siempre TAMBIÉN con candado, y proporcionales con la v2 vigente.
    for (const m of [30, 60, 90, 120]) {
      const r = row('standard', m);
      assert(r.enforced && r.proportional && r.selectable, `standard ${m} con candado y proporcional: ${JSON.stringify(r)}`);
    }
    // Con la especificación de antes (v1: 30 y 60 pedían el mismo mínimo), 60/90/120 quedan CERRADOS.
    for (const m of [60, 90, 120]) {
      const r = row('standard', m, v1);
      assert(r.enforced && !r.proportional && !r.selectable && r.ratio < K.PROPORTIONALITY_FACTOR, `v1 ${m} cerrado: ${JSON.stringify(r)}`);
    }
    // El trabajo especificado crece con el nivel dentro de cada tipo y es dato (no minutos).
    for (const k of ['standard', ...KT.APPLICATION_KINDS]) {
      const rows = lock.filter((r) => r.kind === k);
      for (let i = 1; i < rows.length; i++) assert(rows[i].workMinutes > rows[i - 1].workMinutes, `${k}: más minutos ⇒ más trabajo especificado (${rows[i - 1].minutes}→${rows[i].minutes})`);
    }
    assert(row('standard', 120).workMinutes > row('standard', 90).workMinutes, 'standard 90→120: más trabajo especificado');
    eq(K.WORK_MODEL_VERSION, 1, 'versión del modelo de trabajo');
    console.log(`      ${lock.map((r) => `${r.kind}:${r.minutes} trabajo ${r.workMinutes} densidad ${r.density}${r.ratio === null ? '' : ` (×${r.ratio})`}${r.enforced ? ' [candado]' : ''}`).join(' · ')}`);
  });

  await check('K2 con el candado de v1 cerrado, ni el distribuidor ni el ajuste al presupuesto eligen 120 (los fijados se respetan)', () => {
    const v1 = legacyLock();
    const s = course(6, 1);
    const open = dry(s, 60, {}).distribution;
    assert(open.modules.some((m) => m.chapters.some((c) => c.applicationMinutes === 120)), 'con el candado abierto el diseño usa 120 (referencia)');
    const closed = dry(s, 60, {}, { tierLock: v1 }).distribution;
    assert(!closed.modules.some((m) => m.chapters.some((c) => c.applicationMinutes === 120)), 'candado cerrado: ningún 120');
    eq(closed.materialized.manifestErrors, [], 'diseño materializable');
    const r = BF.fitDesignToBudget({ base: { structure: s, profile: profile(60), activityTypeRules: 2 }, budgetUsd: 90, levers: { audiovisual: { base: 'recommended', locked: false }, guidedPractice: { base: 'auto', locked: false }, emphasis: { base: 'balanced', locked: false }, activityKinds: { base: 'none', locked: false } }, tierLock: v1 });
    const designs = [r.chosen, ...r.alternatives.map((a) => a.design)].filter(Boolean);
    assert(designs.length > 0, `el ajuste devuelve diseños (${r.status})`);
    for (const d of designs) assert(!d.structure.applicationTiers['120'], `ajuste con 120: ${JSON.stringify(d.structure.applicationTiers)}`);
    // Pin del docente en 120: se respeta aunque el candado esté cerrado.
    const pin = dry(s, 60, {}, { tierLock: v1, designPins: { m1c1: { application: 120 } } }).distribution;
    assert(pin.modules[0].chapters.find((c) => c.id === 'm1c1').applicationMinutes === 120, 'el 120 fijado por el docente se conserva');
  });

  await check('K3 validadores: mín./máx. válidos; mutaciones rechazadas; v1 vigente; 120 v2 sin hitos rechazado; tipo nuevo exige v2', () => {
    for (const size of ['min', 'max']) {
      for (const [k, m] of KIND_TIERS) {
        const d = F.kindDoc(V, k, 'ch1', m, 1, { size, outcomeIds: ['OBJ'] });
        eq(codes(AA.validateApplicationActivityDoc(d, { chapterId: 'ch1', minutes: m, kind: k, outcomeIds: ['OBJ'] })), [], `${k} ${m} ${size}`);
      }
      for (const m of [30, 60, 90, 120]) {
        const sd = F.standardV2Doc(V, 'ch1', m, 1, { size });
        eq(codes(AA.validateApplicationActivityDoc(sd, { chapterId: 'ch1', minutes: m })), [], `standard v2 ${m} ${size}`);
      }
    }
    // r79.2: la forma v1 de 60/90/120 ya no basta como v2 (más ejercicios, ejemplo, consignas, hitos, criterios).
    for (const m of [60, 90]) {
      const v2l = { ...V.applicationDoc('ch1', m, 1), schemaVersion: 2, kind: 'standard' };
      assert(codes(AA.validateApplicationActivityDoc(v2l, { chapterId: 'ch1', minutes: m })).includes('APPLICATION_COUNT'), `${m} v2 con la forma v1 rechazado`);
    }
    for (const m of [30, 60, 90, 120]) eq(codes(AA.validateApplicationActivityDoc(V.applicationDoc('ch1', m, 1), { chapterId: 'ch1', minutes: m })), [], `v1 ${m} sigue válido (re-empaque)`);
    const v2like = { ...V.applicationDoc('ch1', 120, 1), schemaVersion: 2, kind: 'standard' };
    const e120 = codes(AA.validateApplicationActivityDoc(v2like, { chapterId: 'ch1', minutes: 120 }));
    assert(e120.includes('APPLICATION_COUNT') || e120.includes('APPLICATION_LIST'), `120 v2 con la forma v1: ${e120}`);
    const v1kind = { ...F.caseStudyDoc('ch1', 60, 1), schemaVersion: 1 };
    eq(codes(AA.validateApplicationActivityDoc(v1kind, { chapterId: 'ch1', minutes: 60, kind: 'case_study' })), ['APPLICATION_SCHEMA_VERSION'], 'tipo nuevo en v1');
    const mut = (k, m, f, ctx = {}) => { const d = F.kindDoc(V, k, 'ch1', m, 1, { outcomeIds: ['OBJ'] }); f(d); return codes(AA.validateApplicationActivityDoc(d, { chapterId: 'ch1', minutes: m, kind: k, outcomeIds: ['OBJ'], ...ctx })); };
    const has = (got, c, what) => assert(got.includes(c), `${what}: ${got} sin ${c}`);
    has(mut('case_study', 60, (d) => { d.activity.questions.forEach((q) => { q.level = 'comprender'; }); }), 'APPLICATION_LEVELS', 'sin analizar/evaluar');
    has(mut('case_study', 60, (d) => { d.activity.questions[1].id = 'Q9'; }), 'APPLICATION_ID', 'id fuera de orden');
    has(mut('case_study', 60, (d) => { d.activity.questions = d.activity.questions.reverse().map((q, i) => ({ ...q, id: `Q${i + 1}` })); }), 'APPLICATION_ORDER', 'niveles en desorden');
    has(mut('case_study', 90, (d) => { d.activity.criteria[0].weight += 5; }), 'APPLICATION_CRITERIA_WEIGHTS', 'pesos ≠ 100');
    has(mut('case_study', 90, (d) => { d.activity.minutesBySection.analysis = 5; }), 'APPLICATION_SECTION_FLOOR', 'piso de análisis');
    has(mut('case_study', 60, (d) => { d.solution.questionGuides.pop(); }), 'APPLICATION_SOLUTION_COVERAGE', 'guía de pregunta faltante');
    has(mut('case_study', 60, (d) => { d.activity.outcomeLinks[0].outcomeId = 'RA99'; }), 'APPLICATION_OUTCOME_REF', 'resultado ajeno');
    has(mut('case_study', 60, (d) => { d.activity.decision.prompt = 'Respuesta: elige la opción B porque es la mejor del caso.'; }), 'APPLICATION_SOLUTION_MARKER', 'marca de solucionario');
    has(mut('case_study', 60, (d) => { d.activity.case.extra = 'x'; }), 'APPLICATION_SHAPE', 'campo extra');
    has(mut('integrative_project', 120, (d) => { d.activity.stages[0].minutes += 7; }), 'APPLICATION_STAGE_MINUTES', 'etapas ≠ minutesBySection.stages');
    has(mut('integrative_project', 90, (d) => { d.activity.stages.pop(); }), 'APPLICATION_COUNT', 'etapa faltante');
    has(mut('integrative_project', 90, (d) => { d.activity.outcomeLinks = [d.activity.outcomeLinks[0]]; }, { outcomeIds: ['RA1', 'RA2'] }), 'APPLICATION_OUTCOME_COVERAGE', 'proyecto con un solo resultado habiendo dos');
    has(mut('formative_feedback', 30, (d) => { d.activity.peerReview = { instructions: ['Comenta un acierto con un ejemplo concreto.'], protocol: 'Intercambio respetuoso entre pares.' }; }), 'APPLICATION_SHAPE', 'revisión entre pares en 30');
    has(mut('formative_feedback', 60, (d) => { delete d.activity.peerReview; }), 'APPLICATION_SHAPE', 'sin revisión entre pares en 60');
    has(mut('formative_feedback', 60, (d) => { d.solution.feedbackBank[0].criterion = 'Otro'; }), 'APPLICATION_SOLUTION_COVERAGE', 'banco con otro criterio');
    // Tipo distinto del Manifest y nivel ajeno al tipo.
    eq(codes(AA.validateApplicationActivityDoc(F.caseStudyDoc('ch1', 60, 1), { chapterId: 'ch1', minutes: 60, kind: 'formative_feedback' })), ['APPLICATION_KIND_MISMATCH'], 'tipo cambiado');
    eq(codes(AA.validateApplicationActivityDoc({ ...F.caseStudyDoc('ch1', 60, 1), minutes: 30 }, { chapterId: 'ch1', minutes: 30, kind: 'case_study' })), ['APPLICATION_KIND_TIER'], 'nivel ajeno');
    // 120 v2: hitos obligatorios y pisos.
    const s120 = F.standardV2Doc(V, 'ch1', 120, 1);
    const noMs = clone(s120); delete noMs.activity.workshop.milestones;
    has(codes(AA.validateApplicationActivityDoc(noMs, { chapterId: 'ch1', minutes: 120 })), 'APPLICATION_LIST', '120 sin hitos');
    const lowWs = clone(s120); lowWs.activity.minutesBySection = { examples: 20, exercises: 70, workshop: 20, selfCheck: 10 };
    has(codes(AA.validateApplicationActivityDoc(lowWs, { chapterId: 'ch1', minutes: 120 })), 'APPLICATION_SECTION_FLOOR', '120 con taller corto');
    const ms30 = clone(F.standardV2Doc(V, 'ch1', 30, 1)); ms30.activity.workshop.milestones = [{ title: 'Hito', product: 'Producto intermedio concreto del hito.' }];
    has(codes(AA.validateApplicationActivityDoc(ms30, { chapterId: 'ch1', minutes: 30 })), 'APPLICATION_SHAPE', 'hitos en 30');
    // r79.2: 60 y 90 exigen hitos y pisos de minutos.
    for (const m of [60, 90]) {
      const nm = clone(F.standardV2Doc(V, 'ch1', m, 1)); delete nm.activity.workshop.milestones;
      has(codes(AA.validateApplicationActivityDoc(nm, { chapterId: 'ch1', minutes: m })), 'APPLICATION_LIST', `${m} sin hitos`);
      const lw = clone(F.standardV2Doc(V, 'ch1', m, 1)); lw.activity.minutesBySection = { examples: 5, exercises: m - 15, workshop: 5, selfCheck: 5 };
      has(codes(AA.validateApplicationActivityDoc(lw, { chapterId: 'ch1', minutes: m })), 'APPLICATION_SECTION_FLOOR', `${m} con taller corto`);
    }
  });

  await check('K4 paridad con el ejecutor del navegador: mismos códigos en documentos válidos y mutados (los 3 tipos + 120 v2)', () => {
    const feRepo = process.env.CURSIA_FRONTEND_REPO;
    if (!feRepo || !fs.existsSync(path.join(feRepo, 'src/js/45-dynamic-generation-executor.js'))) { console.log('      (sin CURSIA_FRONTEND_REPO: se omite la paridad; en CI corre con el frontend)'); return; }
    const ctx = { console: { log() {}, warn() {}, error() {} }, window: {}, document: { getElementById: () => null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: { userAgent: 'node' }, location: { hostname: 'localhost', href: 'http://localhost/' }, setTimeout, clearTimeout, URL, TextEncoder, TextDecoder };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of ['05-libro.js', '07-examenes.js', '08-downloads.js', '44-dynamic-prompt-builders.js', '45-dynamic-generation-executor.js']) vm.runInContext(fs.readFileSync(path.join(feRepo, 'src/js', f), 'utf8'), ctx, { filename: f });
    eq(JSON.parse(JSON.stringify(ctx.DYN_APPLICATION_STANDARD_SPEC[2])), JSON.parse(JSON.stringify(K.STANDARD_SPEC_V2)), 'especificación v2 de siempre (espejo)');
    eq(JSON.parse(JSON.stringify(ctx.DYN_APPLICATION_STANDARD_SPEC[1])), JSON.parse(JSON.stringify(K.STANDARD_SPEC_V1)), 'especificación v1 de siempre (espejo)');
    eq(ctx.DYN_APPLICATION_SCHEMA_VERSION, AA.APPLICATION_ACTIVITY_SCHEMA_VERSION, 'schemaVersion');
    const cases = [];
    for (const [k, m] of KIND_TIERS) {
      cases.push([k, m, (d) => d]);
      cases.push([k, m, (d) => { d.activity.criteria[0].weight += 3; return d; }]);
      cases.push([k, m, (d) => { d.activity.minutesBySection[Object.keys(d.activity.minutesBySection)[0]] = 0; return d; }]);
      cases.push([k, m, (d) => { d.activity.outcomeLinks[0].outcomeId = 'ZZ'; return d; }]);
      cases.push([k, m, (d) => { d.solution.correctionGuide.pop(); return d; }]);
      cases.push([k, m, (d) => { d.activity.title = 'Respuesta: x'; return d; }]);
    }
    cases.push(['case_study', 60, (d) => { d.activity.questions.forEach((q) => { q.level = 'proponer'; }); return d; }]);
    cases.push(['integrative_project', 90, (d) => { d.activity.stages[1].id = 'S7'; return d; }]);
    cases.push(['formative_feedback', 60, (d) => { delete d.activity.peerReview; delete d.activity.minutesBySection.peerReview; return d; }]);
    for (const [k, m, f] of cases) {
      const d = f(F.kindDoc(V, k, 'ch1', m, 1, { outcomeIds: ['OBJ'] }));
      const spec = K.applicationClaimSpec(k, m, { modules: [] }, 'ch1').kindSpec;
      const be = codes(AA.validateApplicationActivityDoc(d, { chapterId: 'ch1', minutes: m, kind: k, outcomeIds: ['OBJ'] }));
      const fe = codes(ctx.dynValidateApplicationDoc(JSON.parse(JSON.stringify(d)), { chapterId: 'ch1', minutes: m, kind: k, kindSpec: JSON.parse(JSON.stringify(spec)), outcomeIds: ['OBJ'] }));
      eq(fe, be, `${k} ${m}`);
    }
    for (const m of [30, 60, 90, 120]) {
      const d = F.standardV2Doc(V, 'ch1', m, 1);
      const be = codes(AA.validateApplicationActivityDoc(d, { chapterId: 'ch1', minutes: m }));
      const fe = codes(ctx.dynValidateApplicationDoc(JSON.parse(JSON.stringify(d)), { chapterId: 'ch1', minutes: m }));
      eq(fe, be, `standard v2 ${m}`);
      const bad = clone(d); bad.activity.exercises = bad.activity.exercises.slice(0, 5);
      eq(codes(ctx.dynValidateApplicationDoc(clone(bad), { chapterId: 'ch1', minutes: m })), codes(AA.validateApplicationActivityDoc(bad, { chapterId: 'ch1', minutes: m })), `standard v2 ${m} con pocos ejercicios`);
    }
  });

  // Blueprint con los tres tipos.
  const built = SF.buildCourse(distRoot, { courseId: 7911, finalExam: true, engine: 'h5p', activityTypeRules: 2, modules: [
    { examEnabled: true, chapters: [{ video: true, activity: true, application: 60, appKind: 'case_study' }, { video: false, activity: true, application: 120 }, { practice: true, activity: true, application: 120, appKind: 'integrative_project' }, { practice: true, activity: true, application: 60, appKind: 'formative_feedback' }] },
    { examEnabled: false, chapters: [{ video: false, activity: true, application: 90, appKind: 'case_study' }, { practice: true, activity: true, application: 30, appKind: 'formative_feedback' }] }] });

  await check('K5 Blueprint: tipo solo con su nivel y su tipo de capítulo; sin tipos sha de siempre; ida y vuelta canónica', () => {
    const bp = built.snapshot;
    const chs = bp.modules.flatMap((m) => m.chapters);
    eq(chs.map((c) => c.applicationKind || null), ['case_study', null, 'integrative_project', 'formative_feedback', 'case_study', 'formative_feedback'], 'tipos');
    eq(SNAP.validateBlueprintSnapshotV2(bp), [], 'snapshot válido');
    eq(SNAP.snapshotSha256V2(SNAP.recanonicalizeBlueprintSnapshotV2(clone(bp))), SNAP.snapshotSha256V2(bp), 'jsonb → canónico');
    const r = SNAP.snapshotV2ToRows(bp);
    const plain = SNAP.buildBlueprintSnapshotV2(r.course, r.modules, r.chapters.map((c) => { const { application_kind: _k, ...rest } = c; return rest; }), r.pedagogy);
    const nulls = SNAP.buildBlueprintSnapshotV2(r.course, r.modules, r.chapters.map((c) => ({ ...c, application_kind: null })), r.pedagogy);
    eq(SNAP.snapshotSha256V2(nulls), SNAP.snapshotSha256V2(plain), 'application_kind null = sin la clave (sha de siempre)');
    assert(!JSON.stringify(plain).includes('applicationKind'), 'sin tipos no aparece la clave');
    const bad = (mut) => { const rr = SNAP.snapshotV2ToRows(bp); mut(rr.chapters); return SNAP.validateBlueprintInputV2(rr.course, rr.modules, rr.chapters).map((e) => e.code); };
    eq(bad((cs) => { cs[0].application_kind = 'integrative_project'; }), ['INVALID_APPLICATION_KIND'], 'proyecto en contenido');
    eq(bad((cs) => { cs[0].application_minutes = 30; }), ['INVALID_APPLICATION_KIND'], 'caso de 30');
    eq(bad((cs) => { cs[1].application_kind = 'case_study'; }), ['INVALID_APPLICATION_KIND'], 'caso de 120');
    eq(bad((cs) => { cs[0].application_minutes = null; }), ['INVALID_APPLICATION_KIND'], 'tipo sin Actividad');
    eq(bad((cs) => { cs[0].application_kind = 'workshop'; }), ['INVALID_APPLICATION_KIND'], 'tipo desconocido');
  });

  await check('K6 Manifest: tipo en el item y el capítulo; el validador detecta tipo cambiado o en otro item; totales y conteos de siempre', () => {
    const m = built.manifest;
    const items = m.items.filter((i) => i.type === 'application_activity');
    eq(items.map((i) => i.applicationKind || null), ['case_study', null, 'integrative_project', 'formative_feedback', 'case_study', 'formative_feedback'], 'items');
    eq(m.modules.flatMap((x) => x.chapters).map((c) => c.applicationKind || null), ['case_study', null, 'integrative_project', 'formative_feedback', 'case_study', 'formative_feedback'], 'capítulos');
    eq(m.totals.applicationActivityCount, 6, 'conteo de Actividades sin cambios');
    eq(MB.validateGenerationManifestV3(m, built.snapshot, built.source), [], 'válido');
    const t = clone(m); t.items.find((i) => i.key === items[0].key).applicationKind = 'formative_feedback';
    assert(MB.validateGenerationManifestV3(t, built.snapshot, built.source).some((e) => e.code === 'WRONG_APPLICATION_KIND'), 'tipo cambiado');
    const u = clone(m); u.items.find((i) => i.type === 'content').applicationKind = 'case_study';
    assert(MB.validateGenerationManifestV3(u, built.snapshot, built.source).some((e) => e.code === 'UNEXPECTED_APPLICATION_KIND'), 'tipo en otro item');
    // Sin tipos: el Manifest de siempre (sha).
    const r = SNAP.snapshotV2ToRows(built.snapshot);
    const plain = SNAP.buildBlueprintSnapshotV2(r.course, r.modules, r.chapters.map((c) => ({ ...c, application_kind: null })), r.pedagogy);
    const src = { ...built.source, blueprintSha256: SNAP.snapshotSha256V2(plain) };
    const mp = MB.buildGenerationManifestV3(plain, src, { activityTypeRules: 2 });
    assert(!JSON.stringify(mp).includes('applicationKind'), 'sin tipos no hay clave');
    eq(Object.keys(mp.totals), Object.keys(m.totals), 'mismas claves de totales');
  });

  await check('K7 FinOps: misma operación; escala por tipo y nivel; un tipo nunca cuesta menos que la de siempre del mismo nivel', () => {
    eq(OPS.ITEM_TYPE_OPERATIONS.application_activity, ['llm.application_activity'], 'operación');
    for (const [k, m] of KIND_TIERS) {
      const sk = RB.applicationUsageScale(m, k).output_tokens;
      const ss = RB.applicationUsageScale(m, null).output_tokens;
      assert(sk >= ss, `${k} ${m}: ${sk} < ${ss} (la poda del ajuste supone ≥)`);
      eq(sk, Math.round((K.APPLICATION_OUTPUT_UNITS[k][m] / 7) * 10000) / 10000, `${k} ${m} escala`);
    }
    // r79.2: 60/90/120 de siempre exigen más trabajo → 9/12/15 unidades (30 sin cambios: 6).
    eq([30, 60, 90].map((m) => RB.applicationUsageScale(m).output_tokens), [0.8571, 1.2857, 1.7143], '30/60/90 de siempre (r79.2: 6/9/12 unidades)');
    eq(RB.applicationUsageScale(120).output_tokens, 2.1429, '120 reforzado (15 unidades)');
    const it = RB.estimateItemsForRun(built.manifest.items, 'real').filter((x) => x.itemType === 'application_activity');
    eq(it.map((x) => (x.usageScale ? x.usageScale.output_tokens : 1)), [10 / 7, 15 / 7, 15 / 7, 9 / 7, 13 / 7, 6 / 7].map((x) => Math.round(x * 10000) / 10000), 'escalas del Manifest');
  });

  await check('K8 modelo de horas: el tipo no cambia minutos (mismas horas con y sin tipos)', () => {
    const s = course(8, 2);
    const off = dry(s, 100, { maxContentChaptersPerModule: 2 }).distribution;
    const on = dry(s, 100, { maxContentChaptersPerModule: 2, activityKinds: 'auto' }).distribution;
    assert(on.activityKinds.decisions.length > 0, 'hay tipos asignados');
    eq(on.estimatedHours, off.estimatedHours, 'horas');
    eq(on.counts, off.counts, 'conteos');
    eq(on.materialized.generableHours, off.materialized.generableHours, 'horas del Manifest materializado');
    eq(on.modules.flatMap((m) => m.chapters.map((c) => c.targetMinutes)), off.modules.flatMap((m) => m.chapters.map((c) => c.targetMinutes)), 'minutos por capítulo');
  });

  await check('K9 criterios de valor: caso donde se analiza/decide, proyecto donde se crea (≥ 2 contenidos), retroalimentación tras práctica evaluable; topes, pines y motivos', () => {
    const base = dry(course(8, 2), 100, { maxContentChaptersPerModule: 2, activityKinds: 'auto' }).distribution;
    const ds = base.activityKinds.decisions;
    for (const d of ds) assert(typeof d.reason === 'string' && d.reason.length > 40 && ['K1', 'K2', 'K3'].includes(d.ruleId), `motivo de ${d.chapterId}`);
    const perModule = {};
    for (const d of ds) if (d.kind === 'case_study') perModule[d.moduleId] = (perModule[d.moduleId] || 0) + 1;
    assert(Object.values(perModule).every((n) => n <= 1), 'a lo sumo un caso por módulo');
    const contentApps = base.modules.flatMap((m) => m.chapters.filter((c) => c.kind === 'content' && c.applicationMinutes !== null)).length;
    assert(ds.filter((d) => d.kind === 'case_study').length <= Math.floor(contentApps / 2), 'no más de la mitad');
    for (const m of base.modules) {
      const pr = m.chapters.filter((c) => c.kind === 'practice');
      for (const c of m.chapters) {
        if (c.applicationKind === 'integrative_project') assert(pr[0] && pr[0].id === c.id, 'el proyecto va en el primer capítulo de práctica');
        if (c.applicationKind === 'formative_feedback') {
          assert(pr.indexOf(c) >= 1, 'la retroalimentación nunca va en el integrador');
          assert(m.chapters.slice(0, m.chapters.indexOf(c)).some((x) => x.applicationMinutes !== null), 'después de una práctica evaluable');
        }
        if (c.applicationKind) assert(KT.APPLICATION_KIND_TIERS[c.applicationKind].includes(c.applicationMinutes), `nivel del tipo ${c.applicationKind} ${c.applicationMinutes}`);
      }
    }
    // Negativos: sin señal de análisis ni de creación → ningún caso ni proyecto.
    const flat = (j) => 'Conocer los conceptos del tema';
    const none = dry(course(4, 2, flat), 60, { activityKinds: 'auto' }, {}).distribution;
    const noneKinds = none.activityKinds.decisions.filter((d) => d.kind !== 'formative_feedback');
    // El título «tema N» y el objetivo «conocer» no piden analizar ni crear; los resultados del perfil sí («Proponer…»): a
    // lo sumo un proyecto por curso por esa señal, nunca casos.
    assert(!noneKinds.some((d) => d.kind === 'case_study'), `casos sin señal: ${JSON.stringify(noneKinds.map((d) => d.chapterId))}`);
    assert(noneKinds.filter((d) => d.kind === 'integrative_project').length <= 1, 'proyecto por resultados del curso: uno solo');
    // Un módulo con un solo capítulo de contenido nunca lleva proyecto.
    const single = dry(course(6, 1), 60, { activityKinds: 'auto' }).distribution;
    assert(!single.modules.some((m) => m.chapters.filter((c) => c.kind === 'content').length < 2 && m.chapters.some((c) => c.applicationKind === 'integrative_project')), 'proyecto con 1 contenido');
    // Pines: una Actividad fijada por el docente queda como la de siempre.
    const pinned = dry(course(8, 2), 100, { maxContentChaptersPerModule: 2, activityKinds: 'auto' }, { designPins: { m1c1: { application: 60 } } }).distribution;
    assert(!pinned.modules[0].chapters.find((c) => c.id === 'm1c1').applicationKind, 'fijada sin tipo');
    // Determinista.
    eq(dry(course(8, 2), 100, { maxContentChaptersPerModule: 2, activityKinds: 'auto' }).distribution.activityKinds, base.activityKinds, 'determinista');
  });

  await check('K10 dry-run: sin la preferencia, la de siempre; «automático» = misma estructura; punto fijo al aplicar', () => {
    const s = course(8, 2);
    const off = dry(s, 100, { maxContentChaptersPerModule: 2 }).distribution;
    const offNone = dry(s, 100, { maxContentChaptersPerModule: 2, activityKinds: 'none' }).distribution;
    eq(offNone.proposalSha256, off.proposalSha256, '«none» = sin preferencia (huella)');
    assert(!('activityKinds' in off), 'sin informe sin la preferencia');
    const on = dry(s, 100, { maxContentChaptersPerModule: 2, activityKinds: 'auto' }).distribution;
    assert(on.proposalSha256 !== off.proposalSha256, 'con tipos, otra huella');
    eq(on.modules.map((m) => m.chapters.map((c) => [c.id, c.kind, c.applicationMinutes])), off.modules.map((m) => m.chapters.map((c) => [c.id, c.kind, c.applicationMinutes])), 'misma estructura');
    eq(on.materialized.manifestErrors, [], 'materializable');
    // Punto fijo: la estructura materializada (con los tipos) vuelve a dar la misma propuesta.
    const mat = P.materializeDistribution(P.snapshotFromStructure(s), on, null);
    const again = P.runPedagogyDryRun({ structure: mat, profile: profile(100, { maxContentChaptersPerModule: 2, activityKinds: 'auto' }), activityTypeRules: 2 }).distribution;
    assert(again.modules.flatMap((m) => m.chapters).filter((c) => c.applicationKind).length === on.modules.flatMap((m) => m.chapters).filter((c) => c.applicationKind).length, 'mismos tipos tras aplicar');
    eq(again.changes.filter((c) => /application_kind/.test(c.type)), [], 'sin cambios de tipo tras aplicar');
    // Quitar la preferencia sobre una estructura con tipos: la propuesta los quita (y lo dice).
    const back = P.runPedagogyDryRun({ structure: mat, profile: profile(100, { maxContentChaptersPerModule: 2 }), activityTypeRules: 2 }).distribution;
    assert(back.modules.every((m) => m.chapters.every((c) => !c.applicationKind)), 'sin tipos');
    assert(back.changes.some((c) => c.type === 'remove_application_kind'), 'cambio visible');
  });

  await check('K11 invalidación: el tipo entra a la huella de SU Actividad solo si existe (las demás, de siempre)', () => {
    const bp = built.snapshot;
    const r = SNAP.snapshotV2ToRows(bp);
    const plain = SNAP.buildBlueprintSnapshotV2(r.course, r.modules, r.chapters.map((c) => ({ ...c, application_kind: null })), r.pedagogy);
    const changed = SNAP.buildBlueprintSnapshotV2(r.course, r.modules, r.chapters.map((c, i) => (i === 0 ? { ...c, application_kind: null } : c)), r.pedagogy);
    const fpOf = (b) => FP.computeFingerprintsV3(b);
    const a = fpOf(bp); const p = fpOf(plain); const c = fpOf(changed);
    const appKey = (id) => `application_activity:${id}`;
    const chs = bp.modules.flatMap((m) => m.chapters);
    const fp = (fps, id) => FP.itemFingerprintV3(fps, appKey(id));
    // Quitar el tipo del capítulo 1: cambia SOLO su Actividad.
    assert(fp(a, chs[0].id) !== fp(c, chs[0].id), 'la Actividad que cambia de tipo cambia de huella');
    for (const ch of chs.slice(1)) if (typeof ch.applicationMinutes === 'number') eq(fp(c, ch.id), fp(a, ch.id), `${ch.id}: las demás Actividades no cambian`);
    // Un capítulo sin tipo tiene la huella de siempre (con o sin tipos en el resto del curso).
    eq(fp(p, chs[1].id), fp(a, chs[1].id), 'la Actividad de siempre conserva su huella');
    // El contenido y la presentación del capítulo no dependen del tipo.
    eq(FP.itemFingerprintV3(c, `content:${chs[0].id}`), FP.itemFingerprintV3(a, `content:${chs[0].id}`), 'content sin cambios');
    eq(FP.itemFingerprintV3(c, `presentation:${chs[0].id}`), FP.itemFingerprintV3(a, `presentation:${chs[0].id}`), 'presentación sin cambios');
  });

  await check('K12 claim: especificación del tipo, resultados, capítulos del módulo y prácticas a revisar; el servidor valida con el tipo', () => {
    const bp = built.snapshot;
    const ch = bp.modules[0].chapters;
    const cs = K.applicationClaimSpec('case_study', 60, bp, ch[0].id);
    eq(cs.kind, 'case_study', 'tipo');
    eq(cs.kindSpec.counts, K.APPLICATION_KIND_COUNTS.case_study[60], 'cantidades del nivel');
    eq(cs.kindSpec.floors, K.APPLICATION_KIND_FLOORS.case_study[60], 'pisos');
    assert(cs.kindSpec.schema && cs.kindSpec.schema.rules.length, 'esquema');
    eq(cs.outcomes.map((o) => o.id), ['OBJ'], 'resultados (sin contexto: el objetivo/título)');
    const pj = K.applicationClaimSpec('integrative_project', 120, bp, ch[2].id);
    eq(pj.moduleChapters, ch.filter((c) => c.kind !== 'practice').map((c) => c.title), 'capítulos del módulo');
    const fb = K.applicationClaimSpec('formative_feedback', 60, bp, ch[3].id);
    eq(fb.reviewTargets.map((t) => t.kindLabel), ['Estudio de caso', 'Actividad de Aplicación', 'Proyecto integrador'], 'prácticas a revisar');
    const st = K.applicationClaimSpec(null, 120, bp, ch[1].id);
    eq(st.kind, 'standard', 'la de siempre'); eq(st.standardSpec, K.STANDARD_SPEC_V2[120], 'su especificación');
    // Resultados del contexto académico: ids del capítulo (y del módulo en la práctica).
    const ac = { modules: [{ id: 'm', chapters: [{ id: 'a', kind: undefined, outcomeIds: ['RA1'] }, { id: 'b', outcomeIds: ['RA2', 'CO1'] }, { id: 'p', kind: 'practice' }] }], course: { academicContext: { outcomes: [{ id: 'RA1', text: 'Analiza' }, { id: 'RA2', text: 'Diseña' }], competencies: [{ id: 'CO1', text: 'Gestiona' }] } } };
    eq(K.applicationOutcomeRefs(ac, 'a').map((o) => o.id), ['RA1'], 'contenido');
    eq(K.applicationOutcomeRefs(ac, 'p').map((o) => o.id), ['CO1', 'RA1', 'RA2'], 'práctica = unión del módulo');
    // Validación del servidor al completar (mismo camino que scheduler.completeItem).
    const doc = F.caseStudyDoc(ch[0].id, 60, 1, { outcomeIds: ['OBJ'] });
    const ok = V3.validateV3ItemArtifact({ type: 'application_activity', itemKey: `application_activity:${ch[0].id}`, chapterId: ch[0].id, applicationMinutes: 60, applicationKind: 'case_study', applicationOutcomeIds: ['OBJ'] }, JSON.stringify(doc));
    assert(ok.ok, `válido: ${JSON.stringify(ok.errors && ok.errors.slice(0, 3))}`);
    eq(ok.summary.kind, 'case_study', 'resumen con el tipo');
    const wrong = V3.validateV3ItemArtifact({ type: 'application_activity', itemKey: 'x', chapterId: ch[0].id, applicationMinutes: 60 }, JSON.stringify(doc));
    assert(!wrong.ok && wrong.errors.some((e) => e.code === 'APPLICATION_KIND_MISMATCH'), 'sin tipo en el Manifest: rechazado');
  });

  await check('K13 perfil: activityKinds solo «auto» se guarda; inválido rechazado; sin él, sha de siempre', () => {
    const p0 = profile(60);
    const pa = profile(60, { activityKinds: 'auto' });
    const pn = profile(60, { activityKinds: 'none' });
    eq(PP.validatePedagogicalProfile(pa), [], 'auto válido');
    assert(PP.validatePedagogicalProfile(profile(60, { activityKinds: 'siempre' })).some((e) => e.code === 'INVALID_OPTION'), 'inválido');
    eq(PP.normalizePedagogicalProfile(pa).designPreferences.activityKinds, 'auto', 'se guarda');
    eq(PP.pedagogicalProfileSha256(PP.normalizePedagogicalProfile(pn)), PP.pedagogicalProfileSha256(PP.normalizePedagogicalProfile(p0)), '«none» = sin la clave');
    eq(PP.profileActivityKinds(pa), 'auto', 'lectura'); eq(PP.profileActivityKinds(p0), 'none', 'por defecto');
  });

  await check('K14 empaque: .mbz con los tres tipos (y el 120 v2) en los 7 estilos; validador verde y ROJO ante cada adulteración', async () => {
    const R77 = require('./lib/r77-mobile-fixtures');
    const PK = L('modules/dynamic-packaging/packaging-v3.js');
    const PR = L('modules/course-profiles/course-profiles.js');
    for (const st of R77.STYLES) {
      const input = V.packagingInput(distRoot, { snapshot: built.snapshot, manifest: built.manifest, engine: 'h5p', applicationV2: true });
      input.presentation = PK.resolvePackagingTheme({ presentationProfile: PR.normalizePresentationProfile(st.profile || st) }).input;
      const out = await B.buildDynamicMbzV3(input);
      const v = await VAL.validateMbzV3(out.mbz, out.expectations);
      assert(v.ok, `${st.key || st.id || JSON.stringify(st).slice(0, 30)}: ${JSON.stringify((v.errors || v.issues || []).slice(0, 5))}`);
    }
    const input = V.packagingInput(distRoot, { snapshot: built.snapshot, manifest: built.manifest, engine: 'h5p', applicationV2: true });
    const out = await B.buildDynamicMbzV3(input);
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(out.mbz);
    const pages = {};
    for (const f of Object.keys(zip.files).filter((x) => /activities\/page_\d+\/page\.xml$/.test(x))) {
      const x = await zip.file(f).async('string');
      pages[f] = { name: /<name>([^<]*)<\/name>/.exec(x)[1], xml: x };
    }
    const names = Object.values(pages).map((p) => p.name);
    for (const lbl of ['Estudio de caso · Capítulo', 'Proyecto integrador · Capítulo', 'Retroalimentación formativa · Capítulo', 'Solucionario docente · Estudio de caso', 'Solucionario docente · Proyecto integrador', 'Solucionario docente · Retroalimentación formativa', 'Actividad de Aplicación · Capítulo']) {
      assert(names.some((n) => n.startsWith(lbl)), `falta la página «${lbl}…»`);
    }
    // Adulteraciones → el validador se pone ROJO.
    const tamper = async (fnc) => {
      const z = await JSZip.loadAsync(out.mbz);
      await fnc(z);
      const buf = await z.generateAsync({ type: 'nodebuffer' });
      return VAL.validateMbzV3(buf, out.expectations);
    };
    const pageOf = (re) => Object.keys(pages).find((k) => re.test(pages[k].name));
    const caseKey = pageOf(/^Estudio de caso · Capítulo 1/);
    let r = await tamper(async (z) => { const x = await z.file(caseKey).async('string'); z.file(caseKey, x.replace(/<name>Estudio de caso/, '<name>Actividad')); });
    assert(!r.ok && JSON.stringify(r).includes('Estudio de caso'), 'nombre sin el tipo');
    r = await tamper(async (z) => { const x = await z.file(caseKey).async('string'); z.file(caseKey, x.replace(/Preguntas de an(&aacute;|á)lisis/g, 'Preguntas')); });
    assert(!r.ok && JSON.stringify(r).includes('secciones propias'), 'secciones faltantes');
    r = await tamper(async (z) => { const x = await z.file(caseKey).async('string'); z.file(caseKey, x.replace('Tu decisión', 'Respuesta: tu decisión')); });
    assert(!r.ok && JSON.stringify(r).includes('solucionario'), 'marca de solucionario en la página del estudiante');
    const solKey = pageOf(/^Solucionario docente · Proyecto integrador/);
    const solMod = solKey.replace('page.xml', 'module.xml');
    r = await tamper(async (z) => { const x = await z.file(solMod).async('string'); z.file(solMod, x.replace('<visible>0</visible>', '<visible>1</visible>')); });
    assert(!r.ok, 'solucionario visible');
    // Guía del docente: nombra el tipo y su solucionario.
    const guide = Object.values(pages).find((p) => /Gu(í|i)a del docente/.test(p.name));
    if (guide) assert(/Estudio de caso/.test(guide.xml) && /Solucionario docente · Proyecto integrador/.test(guide.xml), 'la guía nombra los tipos');
  });

  await check('K15 ajuste al presupuesto: palanca de tipos (ambos explorados), kindFit en la calidad, mismas horas, guardas de r79, candado contado', () => {
    const LEV = { audiovisual: { base: 'recommended', locked: false }, guidedPractice: { base: 'auto', locked: false }, emphasis: { base: 'balanced', locked: false }, activityKinds: { base: 'none', locked: false } };
    const r = BF.fitDesignToBudget({ base: { structure: course(8, 2), profile: profile(100), activityTypeRules: 2 }, budgetUsd: 150, levers: LEV });
    eq(r.searchSpace.activityKinds, ['none', 'auto'], 'ambos valores');
    eq(r.status, 'fits', 'cabe');
    eq(r.chosen.preferences.activityKinds, 'auto', 'elige los tipos (aportan valor)');
    eq(r.chosen.quality.kindFit, 1, 'kindFit');
    assert(Object.keys(r.chosen.structure.applicationKinds).length > 0, 'tipos en la estructura');
    assert(r.reasons.some((x) => /Tipos de actividad donde aportan/.test(x)), 'lo explica');
    // Bloqueada: no los explora.
    const locked = BF.fitDesignToBudget({ base: { structure: course(8, 2), profile: profile(100), activityTypeRules: 2 }, budgetUsd: 150, levers: { ...LEV, activityKinds: { base: 'none', locked: true } } });
    eq(locked.searchSpace.activityKinds, ['none'], 'bloqueada');
    eq(locked.chosen.quality.kindFit, 0, 'sin tipos');
    // Nunca relleno: con y sin tipos, mismas horas.
    eq(r.chosen.estimatedHours, locked.chosen.estimatedHours, 'mismas horas');
    // Sin la palanca (r79): comportamiento de siempre.
    const r79 = BF.fitDesignToBudget({ base: { structure: course(8, 2), profile: profile(100), activityTypeRules: 2 }, budgetUsd: 150, levers: { audiovisual: LEV.audiovisual, guidedPractice: LEV.guidedPractice, emphasis: LEV.emphasis } });
    eq(r79.searchSpace.activityKinds, ['none'], 'sin la palanca, «ninguno»');
    // El candado cerrado se cuenta como rechazo (cuando aparece un 120 elegido por Cursia).
    const lockR = BF.fitDesignToBudget({ base: { structure: course(6, 1), profile: profile(60), activityTypeRules: 2 }, budgetUsd: 90, levers: LEV, tierLock: legacyLock() });
    assert(!lockR.chosen || !lockR.chosen.structure.applicationTiers['120'], 'sin 120');
    eq(netAttempts, [], 'sin red');
  });

  await check('K16 ejecutor: el servidor exige «application-activity-2» (documento v2) antes de reclamar', () => {
    eq(SCHED.APPLICATION_ACTIVITY_FEATURE, 'application-activity-2', 'feature');
    eq(AA.APPLICATION_ACTIVITY_SCHEMA_VERSION, 2, 'schemaVersion');
    const feRepo = process.env.CURSIA_FRONTEND_REPO;
    if (feRepo && fs.existsSync(path.join(feRepo, 'src/js/24-backend-client.js'))) {
      assert(/application-activity-2/.test(fs.readFileSync(path.join(feRepo, 'src/js/24-backend-client.js'), 'utf8')), 'el frontend anuncia -2');
    }
    const vend = path.join(__dirname, '..', 'vendor', 'dynamic-executor', '45-dynamic-generation-executor.js');
    assert(fs.existsSync(vend) && /DYN_APPLICATION_SCHEMA_VERSION = 2/.test(fs.readFileSync(vend, 'utf8')), 'el ejecutor del worker (vendor) escribe v2');
  });

  console.log(`\n${passes} OK, ${failures} fallidas`);
  process.exit(failures ? 1 : 0);
})();
