#!/usr/bin/env node
/* eslint-disable */
// r58 (I3) — registro de horas (HoursReport), configuración del modelo de tiempo y arreglos de horas. USD 0: sin red, sin
// IA, sin base. Fixtures GENÉRICOS («Curso de ejemplo …», scripts/lib/composition-fixtures.js + v21-packaging-fixtures.js).
//
//   H1  configuración: el default tiene EXACTAMENTE los valores de siempre (STUDY_TIME_RULES), validación estricta con
//       HOURS_MODEL_INVALID, forma canónica estable, tolerancia del informe = la del distribuidor
//   H2  líneas: suman exactamente la estimación (curso, módulo y capítulo), base measured / estimated_with_evidence /
//       declared por regla, evidencia y ruleId en cada línea, observado siempre null
//   H3  fix usesPlannedValues: un curso medido con niveles declarados (AA, práctica guiada, foro) ya no dice «todo medido»
//   H4  duraciones 16, 32, 40, 64, 76 y 96 h + formatos S/M/L, 4×4 9+7, 4×5 9+11: total = Σ líneas = estimado + asignado;
//       gap = objetivo − total explícito; las formas de práctica pesada NO llegan y el gap > 0 se informa (r57: 52,5/64,
//       55,8/76, 29,9/32, 60,7/96 h — mismos números, ningún minuto inventado)
//   H5  práctica baja / alta: la parte declarada (asignada) sube con la práctica; nunca se rellena el gap
//   H6  override: cambia SOLO las líneas con su configId (tasa de lectura; minutos acreditados de un nivel); el dry-run
//       con `hoursModel` lo congela en el Blueprint y lo informa; sin `hoursModel` ni `hoursReport` el dry-run es el de
//       siempre (pedir el informe no cambia nada más)
//   H7  declarado del documento: componentes y créditos → «mapeo no definido» / «conversión no definida» sin política;
//       con política configurada, comparación por componente (HOURS_COMPONENT_MISMATCH)
//   H8  perfil y Blueprint: `hoursModel` opcional (sha de siempre sin él), INVALID_HOURS_MODEL, lock lo congela,
//       validador del snapshot exige forma canónica
//   H9  empaque: el worker pasa las horas objetivo (fix: «Duración estimada» faltaba siempre); sin objetivo el .mbz es
//       byte a byte el de antes; facts.hoursReport en el paquete (etapa package); desglose opcional en la Guía del docente
//
// Uso: node scripts/check-hours-model.js [dist]   (después de npm run build)
'use strict';
require('reflect-metadata');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const L = (rel) => require(path.join(distRoot, rel));
const ST = L('modules/study-time/index.js');
const P = L('modules/pedagogy/index.js');
const PP = L('modules/pedagogy/pedagogy-profile.js');
const SNAP = L('modules/course-blueprints/blueprint-snapshot.js');
const LOCK = L('modules/course-blueprints/lock-snapshot.js');
const MB = L('modules/generation-manifests/generation-manifest-builder.js');
const B = L('package/dynamic-mbz-builder-v3.js');
const V = L('package/v3/mbz-validator-v3.js');
const W = L('workers/dynamic-package-worker.js');
const FC = L('modules/reliability/failure-classifier.js');
const C = require('./lib/composition-fixtures');
const PF = require('./lib/v21-packaging-fixtures');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ ${name}\n   ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 5).join('\n   ')}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: ${x} !== ${y}`); };
const throwsRe = (fn, re, m) => {
  try { fn(); } catch (e) { if (re.test(String(e.message))) return; throw new Error(`${m}: error inesperado ${e.message}`); }
  throw new Error(`${m}: no lanzó`);
};
const sha = (b) => crypto.createHash('sha256').update(typeof b === 'string' ? b : b).digest('hex');
const r2 = (n) => Math.round(n * 100) / 100;
const sum = (xs) => r2(xs.reduce((a, b) => a + b, 0));
const FIXED = { noContentAdditions: true, sources: {} };
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const text = (html) => unxml(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

/** Duraciones extra (16 h) sobre los fixtures de composición (32/40/64/76/96 h y S/M/L ya existen). */
const EXTRA = [{ id: '16h-2x2', targetHours: 16, modules: ['PC', 'KD'], practiceMix: null }];
const ALL = [...C.COURSES, ...EXTRA];
const dryRun = (fx, o = {}) => P.runPedagogyDryRun({
  structure: C.plainStructure(C.structureOf(fx)),
  profile: o.profile || C.profileOf(fx),
  activityTypeRules: 2,
  requirementConstraints: o.req !== undefined ? o.req : FIXED,
  ...(o.hoursReport !== undefined ? { hoursReport: o.hoursReport } : {}),
});

/** Invariantes de un informe (cualquier etapa). */
function invariants(r, label) {
  const lines = r.lines;
  assert(lines.length > 0, `${label}: hay líneas`);
  eq(r.totals.minutes, sum(lines.map((l) => l.minutes)), `${label}: total = Σ líneas`);
  eq(r2(r.estimated.minutes + r.assigned.minutes), r.totals.minutes, `${label}: total = estimado + asignado`);
  eq(r.estimated.minutes, sum(lines.filter((l) => l.basis !== 'declared').map((l) => l.minutes)), `${label}: estimado = measured + estimated_with_evidence`);
  eq(r.assigned.minutes, sum(lines.filter((l) => l.basis === 'declared').map((l) => l.minutes)), `${label}: asignado = declared`);
  for (const k of ST.HOUR_CATEGORIES) eq(r.totals.byCategory[k], sum(lines.filter((l) => l.category === k).map((l) => l.minutes)), `${label}: categoría ${k}`);
  eq(r.observed, null, `${label}: observado null`);
  eq(r.observedReason, 'no_data_source', `${label}: motivo`);
  for (const l of lines) {
    assert(ST.HOUR_CATEGORIES.includes(l.category), `${label}: categoría ${l.category}`);
    assert(['measured', 'estimated_with_evidence', 'declared'].includes(l.basis), `${label}: base ${l.basis}`);
    assert(/^st\.[a-z_.]+@1$/.test(l.ruleId), `${label}: ruleId ${l.ruleId}`);
    assert(typeof l.configId === 'string' && l.configId, `${label}: configId`);
    assert(typeof l.evidence.quantity === 'number' && l.evidence.quantity > 0 || l.resource === 'forum', `${label}: evidencia de ${l.activityKey}`);
    const declaredKind = ['forum', 'application_activity', 'guided_practice'].includes(l.resource);
    eq(l.basis === 'declared', declaredKind, `${label}: base declarada solo para niveles y foro (${l.activityKey})`);
    if (l.basis === 'estimated_with_evidence') assert(l.evidence.source === 'planned' && /calibrado/.test(l.evidence.calibration), `${label}: calibración citada (${l.activityKey})`);
    if (l.basis === 'measured') eq(l.evidence.source, 'measured', `${label}: medida (${l.activityKey})`);
  }
  if (r.target.hours !== null) {
    eq(r.gap.minutes, r2(r.target.hours * 60 - r.totals.minutes), `${label}: gap = objetivo − total`);
    eq(r.gap.within, Math.abs(r.gap.minutes) <= r.target.toleranceHours * 60 + 1e-6, `${label}: dentro/fuera de la tolerancia`);
    eq(r.findings.some((f) => f.code === 'HOURS_TARGET_GAP'), !r.gap.within, `${label}: HOURS_TARGET_GAP solo fuera de la tolerancia`);
  } else eq(r.gap, null, `${label}: sin objetivo no hay gap`);
  eq(r.declaredShare, r.totals.minutes > 0 ? Math.round((r.assigned.minutes / r.totals.minutes) * 10000) / 10000 : 0, `${label}: proporción declarada`);
}

const fullChapter = (id, o = {}) => ({ chapterId: id, libro: true, presentation: true, video: true, ivAdvanced: true, activity: true, review: true, ...o });
const measuredCourse = (o = {}) => ({
  frame: true, frameWords: 900, welcomeAudio: true, welcomeAudioSeconds: 55, forum: true, finalExam: true, finalExamQuestions: 10,
  modules: [{
    moduleId: 'm1', intro: true, introWords: 400, exam: true, examQuestions: 8,
    chapters: [
      fullChapter('c1', { pageWords: 2000, libroWords: 2500, slides: 9, videoSeconds: 540, activityItems: 7, reviewCards: 8, ...(o.c1 || {}) }),
      fullChapter('c2', { pageWords: 1800, libroWords: 2600, slides: 11, videoSeconds: 660, activityItems: 9, reviewCards: 10, ...(o.c2 || {}) }),
    ],
  }],
});

(async () => {
  await check('H1 configuración: default = valores de siempre, validación estricta, forma canónica, tolerancia = la del distribuidor', () => {
    const D = ST.DEFAULT_TIME_MODEL_CONFIG;
    const R = ST.STUDY_TIME_RULES;
    eq(D.id, 'cursia.default.v1', 'id');
    for (const k of ST.TIME_MODEL_RATE_KEYS) eq(D.rates[k], R[k], `tasa ${k} = STUDY_TIME_RULES`);
    eq([R.readingWordsPerMinute, R.minutesPerSlide, R.minutesPerVideoInteraction, R.minutesPerActivityItem, R.minutesPerReviewCard, R.minutesPerExamQuestion, R.forumMinutes], [150, 0.6, 1, 1.2, 0.5, 1.2, 10], 'valores históricos');
    for (const t of ST.APPLICATION_ACTIVITY_TIERS) eq(D.applicationTierMinutes[t], t, `AA ${t} acredita ${t}`);
    for (const t of ST.GUIDED_PRACTICE_TIERS) eq(D.guidedPracticeTierMinutes[t], t, `PG ${t} acredita ${t}`);
    eq([D.hoursPerCredit, D.componentMap, D.teacherGuideBreakdown], [null, null, false], 'sin política supuesta');
    assert(ST.resolveTimeModelConfig(null) === D && ST.resolveTimeModelConfig(undefined) === D, 'sin configuración → el default');
    eq(ST.HOURS_REPORT_TOLERANCE, { pct: ST.DISTRIBUTOR_RULES.tolerance.pct, minHours: ST.DISTRIBUTOR_RULES.tolerance.minHours }, 'tolerancia del informe = distribuidor');
    const bad = [
      [{ rates: {} }, /hoursModel.id/], [{ id: 'cursia.default.v1' }, /default/], [{ id: 'X Mayúscula' }, /hoursModel.id/],
      [{ id: 'a', ratez: {} }, /desconocido/], [{ id: 'a', rates: { readingWordsPerMinute: 5 } }, /entre 30 y 600/], [{ id: 'a', rates: { minutosPorPagina: 1 } }, /desconocido/],
      [{ id: 'a', applicationTierMinutes: { 45: 30 } }, /nivel desconocido/], [{ id: 'a', guidedPracticeTierMinutes: { 40: 0 } }, /> 0/],
      [{ id: 'a', hoursPerCredit: -1 }, /hoursPerCredit/], [{ id: 'a', componentMap: { contact: ['video'], practice: ['video'] } }, /dos componentes/],
      [{ id: 'a', componentMap: { lab: ['video'] } }, /componente desconocido/], [{ id: 'a', componentMap: { practice: ['taller'] } }, /categoría desconocida/],
      [{ id: 'a', teacherGuideBreakdown: 'si' }, /boolean/], ['x', /objeto/],
    ];
    for (const [v, re] of bad) throwsRe(() => ST.canonicalHoursModel(v), re, JSON.stringify(v));
    try { ST.canonicalHoursModel({ rates: {} }); } catch (e) { eq(e.code, 'HOURS_MODEL_INVALID', 'código estable'); }
    const a = ST.canonicalHoursModel({ teacherGuideBreakdown: false, rates: { forumMinutes: 15, readingWordsPerMinute: 180 }, id: 'inst.demo.v1', componentMap: { practice: ['entregable', 'practica_guiada'] } });
    eq(JSON.stringify(a), JSON.stringify({ id: 'inst.demo.v1', rates: { readingWordsPerMinute: 180, forumMinutes: 15 }, componentMap: { practice: ['practica_guiada', 'entregable'] } }), 'canónica: orden fijo, sin falsos');
    eq(ST.canonicalHoursModel(a), a, 'idempotente');
  });

  await check('H2 líneas: suman la estimación, base por regla, evidencia y ruleId; observado null', () => {
    const fx = C.COURSES.find((x) => x.id === 'M');
    const dr = dryRun(fx, { hoursReport: true });
    const r = dr.hoursReport;
    invariants(r, 'M');
    eq(r.stage, 'design', 'etapa');
    eq(r.configId, 'cursia.default.v1', 'config default');
    eq(r.totals.hours, dr.distribution.estimatedHours, 'total = horas del distribuidor');
    assert(r.lines.every((l) => l.basis !== 'measured'), 'antes de generar nada es medido');
    assert(r.lines.every((l) => l.configId === 'cursia.default.v1'), 'todas con el default');
    // Por capítulo: las líneas del capítulo suman su estimación.
    const est = ST.estimateCourseStudyTimeDetailed(measuredCourse());
    for (const m of est.estimate.modules) for (const c of m.chapters) eq(sum(est.lines.filter((l) => l.chapterId === c.chapterId).map((l) => l.minutes)), c.chapterEstimatedMinutes, `capítulo ${c.chapterId}`);
    eq(est.lines.map((l) => l.activityKey).slice(0, 4), ['course_frame:course', 'welcome_audio:course', 'forum:course', 'module_intro:m1'], 'orden y claves');
    eq(est.lines.find((l) => l.activityKey === 'libro:c1').evidence, { quantity: 2500, unit: 'palabras', rate: 150, rateUnit: 'palabras/min', source: 'measured' }, 'evidencia medida');
    eq(est.lines.find((l) => l.activityKey === 'forum:course').basis, 'declared', 'foro declarado');
    eq(est.lines.find((l) => l.activityKey === 'libro:c1').category, 'lectura', 'categoría del Libro');
    eq(est.lines.find((l) => l.activityKey === 'video_interactions:c1').category, 'video', 'preguntas dentro del video');
    eq(ST.estimateCourseStudyTime(measuredCourse()), est.estimate, 'la estimación es la misma con o sin líneas');
  });

  await check('H3 fix usesPlannedValues: niveles declarados y foro ya no cuentan como medidos', () => {
    const e = ST.estimateCourseStudyTime(measuredCourse());
    // Todo lo contable está medido; solo queda el foro (constante declarada) → antes daba false.
    eq(e.usesPlannedValues, true, 'el foro es un valor declarado');
    const noForum = ST.estimateCourseStudyTime({ ...measuredCourse(), forum: false });
    eq(noForum.usesPlannedValues, false, 'todo medido de verdad → false');
    const withAa = ST.estimateCourseStudyTime({ ...measuredCourse({ c1: { applicationMinutes: 120 } }), forum: false });
    eq(withAa.usesPlannedValues, true, 'una AA de 120 min (nivel declarado) → true (antes false)');
  });

  const results = {};
  await check('H4 duraciones 16/32/40/64/76/96 h y S/M/L, 4×4 9+7, 4×5 9+11: invariantes y gap explícito (r57 reproducido)', () => {
    for (const fx of ALL) {
      const dr = dryRun(fx, { hoursReport: true });
      const r = dr.hoursReport;
      invariants(r, fx.id);
      eq(r.target.hours, fx.targetHours, `${fx.id}: objetivo`);
      eq(r.totals.hours, dr.distribution.estimatedHours, `${fx.id}: total = horas del distribuidor`);
      eq(dr.distribution.materialized.generableHours, r.totals.hours, `${fx.id}: = Manifest materializado`);
      if (dr.distribution.status === 'cannot_reach_target') {
        assert(r.gap.minutes > 0 && !r.gap.within, `${fx.id}: gap > 0 informado`);
        assert(r.findings.some((f) => f.code === 'HOURS_TARGET_GAP' && f.severity === 'MAJOR' && /no se rellena/.test(f.detail)), `${fx.id}: hallazgo`);
      }
      results[fx.id] = { target: fx.targetHours, total: r.totals.hours, estimated: r.estimated.hours, assigned: r.assigned.hours, gap: r.gap.hours, share: r.declaredShare, status: dr.distribution.status };
    }
    // r57 T3 (AU2 §F3): mismas horas alcanzadas, el gap queda a la vista.
    eq(['4x4-9+7', '4x5-9+11', '32h-3x3-5+4', '96h-4x6-10+14'].map((k) => [results[k].total, results[k].target, results[k].status]),
      [[52.5, 64, 'cannot_reach_target'], [55.8, 76, 'cannot_reach_target'], [29.9, 32, 'cannot_reach_target'], [60.7, 96, 'cannot_reach_target']], 'r57: 52,5/64 · 55,8/76 · 29,9/32 · 60,7/96');
    eq(['4x4-9+7', '4x5-9+11', '32h-3x3-5+4', '96h-4x6-10+14'].map((k) => results[k].gap), [11.5, 20.2, 2.1, 35.3], 'gaps');
    for (const k of ['S', 'M', 'L', '3x4-7+5']) eq(results[k].status, 'within_tolerance', `${k}: dentro de la tolerancia`);
    // Las formas de práctica pesada llegan a sus horas sobre todo con minutos DECLARADOS (niveles), y eso se ve.
    for (const k of ['4x4-9+7', '4x5-9+11', '96h-4x6-10+14']) assert(results[k].share > 0.6, `${k}: proporción declarada visible (${results[k].share})`);
    console.log('   ' + Object.entries(results).map(([k, v]) => `${k}: ${v.total}/${v.target} h (est ${v.estimated} + decl ${v.assigned}; gap ${v.gap}; ${Math.round(v.share * 100)} % declarado)`).join('\n   '));
  });

  await check('H5 práctica baja / alta: lo declarado sube con la práctica; el gap nunca se rellena', () => {
    const fx = C.VIDEO_40H[0];
    const low = dryRun(fx, { profile: C.profileOf(fx, { designPreferences: { applicationActivities: 'none', guidedPractice: 'none' } }), req: null, hoursReport: true });
    const high = dryRun(fx, { profile: C.profileOf(fx, { designPreferences: { emphasis: 'application' } }), req: null, hoursReport: true });
    invariants(low.hoursReport, 'baja');
    invariants(high.hoursReport, 'alta');
    const lowAsg = low.hoursReport.lines.filter((l) => l.basis === 'declared').map((l) => l.resource);
    eq([...new Set(lowAsg)], ['forum'], 'práctica baja: solo el foro es declarado');
    assert(high.hoursReport.assigned.minutes > low.hoursReport.assigned.minutes, 'práctica alta: más minutos declarados');
    // Práctica baja no llega a 40 h: el gap se informa; los minutos son los del modelo (nada inventado).
    assert(low.hoursReport.gap.minutes > 0 && low.hoursReport.findings.some((f) => f.code === 'HOURS_TARGET_GAP'), `baja: gap informado (${low.hoursReport.gap.hours} h)`);
    eq(low.hoursReport.totals.hours, low.distribution.estimatedHours, 'baja: total del distribuidor');
    console.log(`   práctica baja: ${low.hoursReport.totals.hours}/40 h (decl ${low.hoursReport.assigned.hours} h, gap ${low.hoursReport.gap.hours} h) · alta: ${high.hoursReport.totals.hours}/40 h (decl ${high.hoursReport.assigned.hours} h)`);
  });

  await check('H6 override: cambia solo las líneas con su configId; dry-run con hoursModel lo congela; sin pedirlo, dry-run de siempre', () => {
    const input = measuredCourse({ c1: { applicationMinutes: 90 }, c2: { applicationMinutes: 60 } });
    const base = ST.estimateCourseStudyTimeDetailed(input);
    const cfgRead = ST.resolveTimeModelConfig({ id: 'inst.lectura.v1', rates: { readingWordsPerMinute: 200 } });
    const o = ST.estimateCourseStudyTimeDetailed(input, cfgRead);
    eq(o.lines.length, base.lines.length, 'mismas líneas');
    o.lines.forEach((l, i) => {
      const b = base.lines[i];
      eq(l.activityKey, b.activityKey, 'mismo orden');
      if (l.configId === 'cursia.default.v1') eq(l, b, `${l.activityKey}: sin cambio`);
      else {
        eq(l.configId, 'inst.lectura.v1', `${l.activityKey}: id propio`);
        assert(/^st\.read\./.test(l.ruleId) && l.minutes < b.minutes, `${l.activityKey}: solo lectura, menos minutos`);
      }
    });
    assert(o.lines.some((l) => l.configId === 'inst.lectura.v1'), 'hay líneas del override');
    eq(o.estimate.configId, 'inst.lectura.v1', 'la estimación anota la configuración');
    assert(base.estimate.configId === undefined, 'default: sin la clave');
    // Minutos acreditados de un nivel: solo las AA de ese nivel.
    const cfgTier = ST.resolveTimeModelConfig({ id: 'inst.tier.v1', applicationTierMinutes: { 90: 60 } });
    const t = ST.estimateCourseStudyTimeDetailed(input, cfgTier);
    const changed = t.lines.filter((l, i) => JSON.stringify(l) !== JSON.stringify(base.lines[i]));
    eq(changed.map((l) => [l.activityKey, l.configId, l.minutes, l.evidence.quantity, l.evidence.creditedMinutes]), [['application_activity:c1', 'inst.tier.v1', 60, 90, 60]], 'solo la AA de 90 → 60 acreditados');
    eq(t.lines.find((l) => l.activityKey === 'application_activity:c2').configId, 'cursia.default.v1', 'la AA de 60 no cambia');
    // Dry-run: sin hoursModel ni hoursReport, sin la clave; pedir el informe no cambia nada más.
    const fx = C.COURSES.find((x) => x.id === '4x4-9+7');
    const plain = dryRun(fx);
    const asked = dryRun(fx, { hoursReport: true });
    assert(!('hoursReport' in plain), 'sin pedirlo no hay informe');
    const { hoursReport: _h, ...rest } = asked;
    eq(sha(JSON.stringify(rest)), sha(JSON.stringify(plain)), 'pedir el informe no cambia el resto del dry-run');
    // Con hoursModel en el perfil: congelado en el Blueprint, informe automático, distribuidor con la misma configuración.
    const hm = { id: 'inst.demo.v1', rates: { readingWordsPerMinute: 120 } };
    const withHm = dryRun(fx, { profile: { ...C.profileOf(fx), hoursModel: hm } });
    assert(withHm.hoursReport && withHm.hoursReport.configId === 'inst.demo.v1', 'informe con la configuración propia');
    eq(withHm.baseline.blueprint.course.hoursModel, hm, 'congelado en el Blueprint');
    eq(withHm.baseline.studyTime.configId, 'inst.demo.v1', 'studyTime anota la configuración');
    invariants(withHm.hoursReport, 'override');
    eq(withHm.hoursReport.totals.hours, withHm.distribution.estimatedHours, 'distribuidor y registro con la misma configuración');
    eq(withHm.distribution.materialized.generableHours, withHm.distribution.estimatedHours, 'Manifest materializado = distribuidor');
    assert(withHm.distribution.estimatedHours > asked.hoursReport.totals.hours, `lectura más lenta → más horas (${withHm.distribution.estimatedHours} vs ${asked.hoursReport.totals.hours})`);
  });

  await check('H7 declarado del documento: sin política → «mapeo no definido» y «conversión no definida»; con política → comparación', () => {
    const ctx = {
      hours: {
        total: { status: 'found', value: 64, sources: [] }, weekly: { status: 'found', value: 4, sources: [] }, weeks: { status: 'found', value: 16, sources: [] },
        credits: { status: 'found', value: 3, sources: [] },
        components: [{ id: 'h1', label: 'Trabajo presencial', kind: 'contact', hours: 16, status: 'found', sources: [] }, { id: 'h2', label: 'Trabajo práctico', kind: 'practice', hours: 24, status: 'found', sources: [] }, { id: 'h3', label: 'Trabajo independiente', kind: 'autonomous', hours: 24, status: 'found', sources: [] }],
      },
    };
    const declared = ST.declaredHoursFromAcademicContext(ctx);
    eq(declared.total, 64, 'total');
    eq(ST.declaredHoursFromAcademicContext({ hours: { total: { status: 'missing', value: null }, weekly: { status: 'missing', value: null }, weeks: { status: 'missing', value: null }, credits: { status: 'missing', value: null }, components: [] } }), null, 'sin horas → null');
    const fx = C.COURSES.find((x) => x.id === '4x4-9+7');
    const r = dryRun(fx, { hoursReport: { declared } }).hoursReport;
    invariants(r, 'declarado');
    eq(r.declared.credits, { value: 3, conversion: 'no_definida' }, 'créditos sin conversión');
    eq(r.declared.weeklyTimesWeeks, 64, 'semanas × horas');
    assert(r.declared.components.every((c) => c.mappedCategories === null && c.modelHours === null), 'componentes sin mapeo');
    eq(r.findings.map((f) => f.code).sort(), ['HOURS_COMPONENT_MAPPING_UNDEFINED', 'HOURS_CREDITS_CONVERSION_UNDEFINED', 'HOURS_TARGET_GAP'], 'hallazgos');
    // Declarado ≠ estimado ≠ asignado: tres cifras separadas.
    assert(r.declared.totalHours === 64 && r.estimated.hours !== r.assigned.hours && r.estimated.hours + r.assigned.hours > 0, 'separados');
    const hm = { id: 'inst.mapa.v1', hoursPerCredit: 48, componentMap: { practice: ['practica_guiada', 'practica_autonoma', 'entregable'], autonomous: ['estudio_contenido', 'video', 'lectura'] } };
    const r2_ = dryRun(fx, { profile: { ...C.profileOf(fx), hoursModel: hm }, hoursReport: { declared } }).hoursReport;
    eq(r2_.declared.credits, { value: 3, conversion: 'configurada', hoursPerCredit: 48, hours: 144 }, 'conversión configurada');
    const pr = r2_.declared.components.find((c) => c.kind === 'practice');
    eq(pr.mappedCategories, ['practica_guiada', 'practica_autonoma', 'entregable'], 'mapeo');
    eq(pr.modelHours, Math.round((r2_.totals.byCategory.practica_guiada + r2_.totals.byCategory.practica_autonoma + r2_.totals.byCategory.entregable) / 60 * 10) / 10, 'horas del modelo en el componente');
    eq(r2_.declared.components.find((c) => c.kind === 'contact').mappedCategories, null, 'contacto sigue sin mapeo');
    assert(r2_.findings.some((f) => f.code === 'HOURS_COMPONENT_MISMATCH'), 'diferencia por componente informada');
    assert(!r2_.findings.some((f) => f.code === 'HOURS_CREDITS_CONVERSION_UNDEFINED'), 'con conversión configurada no se avisa');
  });

  await check('H8 perfil y Blueprint: hoursModel opcional (sha de siempre), INVALID_HOURS_MODEL, lock lo congela, snapshot canónico', () => {
    const fx = C.COURSES.find((x) => x.id === 'M');
    const p = C.profileOf(fx);
    eq(PP.validatePedagogicalProfile(p), [], 'perfil sin hoursModel válido');
    eq(PP.pedagogicalProfileSha256(PP.normalizePedagogicalProfile({ ...p, hoursModel: null })), PP.pedagogicalProfileSha256(PP.normalizePedagogicalProfile(p)), 'hoursModel null = sin la clave (sha de siempre)');
    assert(!('hoursModel' in PP.normalizePedagogicalProfile(p)), 'sin la clave');
    eq(PP.validatePedagogicalProfile({ ...p, hoursModel: { id: 'X' } }).map((e) => e.code), ['INVALID_HOURS_MODEL'], 'inválido → INVALID_HOURS_MODEL');
    throwsRe(() => PP.profileHoursModel({ ...p, hoursModel: { id: 'a', rates: { x: 1 } } }), /PROFILE_INVALID: INVALID_HOURS_MODEL/, 'profileHoursModel lanza');
    const hm = { id: 'inst.demo.v1', rates: { minutesPerSlide: 1 } };
    eq(PP.normalizePedagogicalProfile({ ...p, hoursModel: { ...hm, teacherGuideBreakdown: false } }).hoursModel, hm, 'normalizado canónico');
    // Lock: misma composición que el dry-run.
    const s = C.plainStructure(C.structureOf(fx));
    const rows = SNAP.snapshotV2ToRows(P.snapshotFromStructure(s));
    const locked = LOCK.composeLockSnapshotV2({ id: rows.course.id, title: rows.course.title, final_exam_enabled: true, activity_engine: 'h5p', review_cards_enabled: true }, { modules: rows.modules, chapters: rows.chapters }, { ...p, hoursModel: hm }, null);
    eq(locked.errors, [], 'lock sin errores');
    eq(locked.snapshot.course.hoursModel, hm, 'el lock congela hoursModel');
    const lockedPlain = LOCK.composeLockSnapshotV2({ id: rows.course.id, title: rows.course.title, final_exam_enabled: true, activity_engine: 'h5p', review_cards_enabled: true }, { modules: rows.modules, chapters: rows.chapters }, p, null);
    assert(!('hoursModel' in lockedPlain.snapshot.course), 'sin hoursModel la clave no entra (sha de siempre)');
    eq(SNAP.validateBlueprintSnapshotV2(locked.snapshot).filter((e) => e.code === 'INVALID_HOURS_MODEL'), [], 'canónico válido');
    const broken = JSON.parse(JSON.stringify(locked.snapshot));
    broken.course.hoursModel = { rates: { minutesPerSlide: 1 }, id: 'inst.demo.v1' };
    eq(SNAP.validateBlueprintSnapshotV2(broken).map((e) => e.code).filter((c) => c === 'INVALID_HOURS_MODEL'), ['INVALID_HOURS_MODEL'], 'orden no canónico → INVALID_HOURS_MODEL');
    eq(ST.timeModelConfigOf(locked.snapshot).id, 'inst.demo.v1', 'configuración del Blueprint');
    eq(ST.timeModelConfigOf(lockedPlain.snapshot), ST.DEFAULT_TIME_MODEL_CONFIG, 'sin clave → default');
    // Clasificación de los códigos nuevos (empaque): bug de producto, retenido.
    for (const code of ['HOURS_MODEL_INVALID', 'HOURS_REPORT_INVARIANT']) {
      const c = FC.classifyFailure({ source: 'package_worker', error: `${code}: y` });
      assert(c && c.class === 'D' && c.rule === 'package_product' && c.unclassified === false, `${code}: clase D explícita (${JSON.stringify(c)})`);
    }
  });

  await check('H9 empaque: horas objetivo en la bienvenida (fix), sin objetivo bytes de siempre, facts.hoursReport y desglose en la Guía', async () => {
    const base = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 812 });
    const rebuild = (snapshot) => {
      const source = { courseId: snapshot.course.id, blueprintId: 812 + 7000, blueprintNumber: 1, blueprintSha256: SNAP.snapshotSha256V2(snapshot) };
      return PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 812, snapshot, manifest: MB.buildGenerationManifestV3(snapshot, source) });
    };
    // Sin objetivo: el worker no pasa horas y el .mbz es el de siempre.
    eq(W.packageDeclaredHours(base.blueprint), null, 'sin objetivo → null');
    const off = await B.buildDynamicMbzV3(base);
    const offNull = await B.buildDynamicMbzV3({ ...base, hours: W.packageDeclaredHours(base.blueprint) });
    eq(sha(offNull.mbz), sha(off.mbz), 'sin objetivo: byte a byte');
    eq(off.expectations.facts.hours, null, 'facts.hours null');
    const welcomeOf = async (mbz) => {
      const z = await JSZip.loadAsync(mbz);
      for (const f of Object.keys(z.files).filter((n) => /^activities\/label_\d+\/label\.xml$/.test(n))) {
        const x = await z.file(f).async('string');
        if (/Bienvenida/.test(x) && /cvc-welcome-band/.test(unxml(x))) return text((x.match(/<intro>([\s\S]*?)<\/intro>/) || [])[1] || '');
      }
      return null;
    };
    const wOff = await welcomeOf(off.mbz);
    assert(wOff && !/Duración estimada/.test(wOff), 'sin objetivo: sin «Duración estimada»');
    // Con objetivo (40 h): el builder ya lo soportaba, el worker no lo pasaba → ahora sí.
    const withTarget = P.withTargetHours(base.blueprint, 40);
    eq(W.packageDeclaredHours(withTarget), 40, 'el worker toma las horas objetivo del Blueprint');
    const inT = rebuild(withTarget);
    const before = await B.buildDynamicMbzV3(inT); // lo que armaba el worker antes (sin `hours`)
    const after = await B.buildDynamicMbzV3({ ...inT, hours: W.packageDeclaredHours(withTarget) });
    assert(!/Duración estimada/.test(await welcomeOf(before.mbz)), 'antes del fix: la línea faltaba (bug confirmado en el fixture)');
    // Review r1 (M-5): sin origen congelado = redacción neutra; «(definida por la institución)» solo con horas del documento.
    assert((await welcomeOf(after.mbz)).includes('Duración estimada del curso: 40 h.'), 'después: la bienvenida dice la duración (neutra)');
    assert(!/definida por la instituci/.test(await welcomeOf(after.mbz)), 'neutra: sin «definida por la institución»');
    eq(W.packageDeclaredHoursSource(withTarget), null, 'sin origen congelado → null');
    const docBp = { ...withTarget, course: { ...withTarget.course, targetHoursSource: 'document' } };
    eq(W.packageDeclaredHoursSource(docBp), 'document', 'origen documento congelado');
    const afterDoc = await B.buildDynamicMbzV3({ ...inT, hours: 40, hoursSource: 'document' });
    assert((await welcomeOf(afterDoc.mbz)).includes('Duración estimada: 40 h (definida por la institución).'), 'documento: etiqueta de la institución');
    assert((await V.validateMbzV3(afterDoc.mbz, afterDoc.expectations)).ok, 'documento: valida');
    const v = await V.validateMbzV3(after.mbz, after.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 5)));
    const fr = after.expectations.facts.hoursReport;
    assert(fr && fr.stage === 'package', 'facts.hoursReport del paquete');
    invariants(fr, 'paquete');
    eq(fr.totals.minutes, after.expectations.facts.studyTime.courseEstimatedMinutes, 'registro = studyTime del paquete');
    assert(fr.lines.some((l) => l.basis === 'measured'), 'al empaquetar hay medidas');
    assert(fr.findings.some((f) => f.code === 'HOURS_UNMEASURED'), 'lo no medido se lista');
    eq([fr.declared, fr.declaredReason], [null, 'document_hours_not_frozen'], 'declarado del documento: no se congela (motivo explícito)');
    const sumy = ST.hoursReportSummary(fr);
    assert(!('lines' in sumy) && sumy.lineCount === fr.lines.length, 'resumen para el job sin líneas');
    // Guía del docente: «Carga horaria declarada» con objetivo; desglose solo con hoursModel.teacherGuideBreakdown.
    const guideOf = async (mbz) => {
      const z = await JSZip.loadAsync(mbz);
      for (const f of Object.keys(z.files).filter((n) => /^activities\/page_\d+\/page\.xml$/.test(n))) {
        const x = await z.file(f).async('string');
        if (unxml(x).includes('Guía del docente')) return text((x.match(/<content>([\s\S]*?)<\/content>/) || [])[1] || '');
      }
      return null;
    };
    const tgProfile = { ...inT.assessmentProfile, teacherGuide: { include: true } };
    const g1 = await B.buildDynamicMbzV3({ ...inT, assessmentProfile: tgProfile, hours: 40 });
    const t1 = await guideOf(g1.mbz);
    assert(t1 && t1.includes('Carga horaria declarada: 40 h'), 'Guía: carga horaria declarada');
    assert(!/de dónde salen las horas/.test(t1), 'sin hoursModel: sin desglose (Guía de siempre)');
    const withHm = P.withHoursModel(withTarget, { id: 'inst.guia.v1', teacherGuideBreakdown: true });
    const inH = rebuild(withHm);
    const g2 = await B.buildDynamicMbzV3({ ...inH, assessmentProfile: { ...inH.assessmentProfile, teacherGuide: { include: true } }, hours: W.packageDeclaredHours(withHm) });
    const v2 = await V.validateMbzV3(g2.mbz, g2.expectations);
    assert(v2.ok, JSON.stringify(v2.issues.slice(0, 5)));
    const t2 = await guideOf(g2.mbz);
    assert(/Carga horaria: de dónde salen las horas/.test(t2) && /Tiempo observado: sin datos/.test(t2) && /Modelo de tiempo: inst\.guia\.v1/.test(t2), 'desglose en la Guía');
    assert(/Declaradas por nivel \(sin medición\)/.test(t2), 'declarado separado de lo estimado');
    eq(g2.expectations.facts.hoursReport.configId, 'inst.guia.v1', 'configId en facts');
    // Mismas tasas que el default: solo cambia la configuración anotada, no los minutos.
    eq(g2.expectations.facts.studyTime.courseEstimatedMinutes, after.expectations.facts.studyTime.courseEstimatedMinutes, 'sin tasas propias, mismos minutos');
  });

  console.log(`\n${passed} OK, ${failed} fallidas`);
  process.exit(failed ? 1 : 0);
})();
