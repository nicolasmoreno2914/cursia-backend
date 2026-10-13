#!/usr/bin/env node
/* eslint-disable no-console */
// Loop 9 B · «Práctica guiada del capítulo» (formativa, sin nota; NO es una Actividad de Aplicación). USD 0: sin
// proveedores, sin base real (la migración se prueba en check-v21-manifest-v3 y en el E2E).
//
//   GP1  niveles: 40/60/80/120 (0 = sin); ejercicios 2×20, 2×30, 2×40, 3×40 (los fija Cursia)
//   GP2  Blueprint: `guidedPracticeMinutes` SOLO en capítulos de contenido que la tienen; inválidos o en práctica →
//        rechazados (entrada, builder y snapshot); sin ella, el sha de siempre
//   GP3  Manifest v3: guided_practice:<ch> SOLO en capítulos de contenido con minutos > 0, dependsOn [content],
//        después de application_activity; totals.guidedPracticeCount solo si hay; validador independiente
//   GP4  tiempo: el recurso guided_practice suma los minutos del nivel en «Práctica y repaso» (no en aplicación);
//        al empaquetar solo cuentan las validadas
//   GP5  distribuidor, caso real del piloto (3 × 4 contenido + 3 prácticas con AA de 120, 12 H5P, video en cada
//        capítulo, 40–44 h → meta 42): con las 3 AA fijadas por el documento la práctica guiada completa las horas
//        (≈ 40–44 h) sin AA ni capítulos de más; reparto parejo; ≤ 120 min y ≤ 4 h por capítulo; cambio registrado;
//        punto fijo al aplicar; sin alcance → se dice la diferencia
//   GP6  meta de un rango del documento: el punto medio (42 h para 40–44), igual que la «Meta de diseño» de la UI
//   GP7  validador del documento (servidor) = contrato; v3-validation y paridad con el ejecutor del navegador (vendor)
//   GP8  empaque: página «Práctica guiada — <capítulo>» justo después del texto (antes del video y de la actividad),
//        visible, formativa, con la respuesta modelo; en el Libro Guía al final del capítulo (sin sumar palabras);
//        sin documento o inválido → el paquete se rechaza; el validador del .mbz lo detecta
//   GP9  estimador: llm.guided_practice (Anthropic, Sonnet 4.6), salida escalada por ejercicios, categoría «content»,
//        en estimateItemsForRun y con presupuesto por parte
//   GP10 cascada, huellas, enrutamiento y clases de falla: la práctica guiada se rehace con su content
//
// Uso: node scripts/check-guided-practice.js [path/to/dist]   (después de npm run build)
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

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
const SNAP = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const MB = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const P = loadDist('modules/pedagogy/index.js');
const ST = loadDist('modules/study-time/index.js');
const RA = loadDist('modules/academic-context/requirements/requirement-authority.js');
const SHELL = loadDist('modules/course-shell/index.js');
const GP = loadDist('modules/course-shell/guided-practice.js');
const V3V = loadDist('modules/course-shell/v3-validation.js');
const CASCADE = loadDist('modules/dynamic-generation/regeneration-cascade.js');
const ROUTING = loadDist('modules/dynamic-generation/llm-worker-routing.js');
const FC = loadDist('modules/reliability/failure-classifier.js');
const GUARD = loadDist('modules/course-structure/v21-schema-guard.js');
const SCHED = loadDist('modules/dynamic-generation/scheduler.service.js');
const PROF = require('./fixtures/pedagogy/profiles.json');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
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
  const B2 = JSON.stringify(b);
  if (A !== B2) throw new Error(`${m}: esperado ${B2}, encontrado ${A}`);
}
function throwsRe(fn, re, m) {
  let msg = null;
  try {
    fn();
  } catch (e) {
    msg = e.message;
  }
  assert(msg !== null, `${m}: no falló`);
  assert(re.test(msg), `${m}: mensaje inesperado «${msg}»`);
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const profileOf = (k) => ({
  pedagogyProfileVersion: 1, primaryApproach: PROF.profiles[k].primaryApproach, secondaryApproaches: PROF.profiles[k].secondaryApproaches,
  learner: PROF.learner, learningOutcomes: PROF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual',
});
const rulesOf = (k) => P.deriveDesignRules(profileOf(k));
const srcOf = (bp, n = 1) => ({ courseId: bp.course.id, blueprintId: n, blueprintNumber: n, blueprintSha256: SNAP.snapshotSha256V2(bp) });
const manifestOf = (bp, n = 1) => MB.buildGenerationManifestV3(bp, srcOf(bp, n), { activityTypeRules: 2 });

/** Caso real del piloto: 3 módulos × 4 capítulos de contenido (video + H5P) + 1 de práctica con AA de 120 (sin H5P). */
function pilotStructure(gp) {
  return P.snapshotFromStructure({
    course: { title: 'Atención integral (piloto)', finalExam: true, activityEngine: 'h5p', reviewCards: false },
    modules: [1, 2, 3].map((i) => ({
      title: `Módulo ${i}`, examEnabled: true,
      chapters: [
        ...[1, 2, 3, 4].map((j) => ({ title: `Capítulo ${i}.${j}`, objective: `Aplicar el tema ${i}.${j}`, videoEnabled: true, activityEnabled: true, ...(gp && gp[`${i}.${j}`] ? { guidedPracticeMinutes: gp[`${i}.${j}`] } : {}) })),
        { title: `Práctica integradora ${i}`, kind: 'practice', videoEnabled: false, activityEnabled: false, applicationMinutes: 120 },
      ],
    })),
  });
}
/** Requisitos del documento del piloto: forma 3 × 4 + 1 práctica, 3 AA exactas en la práctica, 12 H5P, video en todos. */
const PILOT_REQ = {
  sources: {}, noContentAdditions: true, modulesFixed: 3, contentChaptersPerModule: { min: 4, max: 4 }, practicePerModule: { min: 1, max: 1 },
  applicationInPractice: true, applicationPerModule: { min: 1, max: 1 }, applicationTotal: { min: 3, max: 3 },
  activitiesTotal: { min: 12, max: 12 }, activitiesInEveryContent: true, videosAllContent: true,
};
const distribute = (snapshot, targetHours, extra = {}) => ST.distributeCourseHours({ snapshot, rules: rulesOf('competencias'), targetHours, requirements: PILOT_REQ, ...extra });

const SITUATION = 'Una tienda de barrio recibe a un cliente que compró un electrodoméstico hace diez días y vuelve porque no enciende. El cliente está molesto, trae la factura y pide que le devuelvan el dinero de inmediato. La política de la tienda permite cambio o reparación dentro del primer mes y la devolución solo con autorización de la administración, que hoy no está en el local.';
const ANSWER = '1. El cliente necesita un producto que funcione y una solución rápida; la política permite cambio o reparación en el primer mes, y la devolución requiere autorización. 2. Le ofreces el cambio inmediato por una unidad igual o la reparación con fecha, y si insiste en la devolución, registras la solicitud y le das la fecha en que la administración responde. 3. Registras fecha, producto, factura, problema reportado, solución ofrecida y responsable, y agendas la llamada de seguimiento.';
function exercise(over = {}) {
  return {
    kind: 'case_analysis', title: 'Un cliente con un reclamo', situation: SITUATION,
    tasks: ['Identifica qué necesita realmente el cliente.', 'Propón una respuesta concreta con los pasos.', 'Explica cómo registrarías el caso.'],
    expectedProduct: 'Una respuesta escrita al cliente con los pasos acordados.',
    criteria: [{ name: 'Comprensión', descriptor: 'Distingue lo que pide de lo que necesita.' }, { name: 'Política', descriptor: 'Respeta lo que la tienda permite.' }, { name: 'Registro', descriptor: 'Deja trazabilidad del caso.' }],
    modelAnswer: ANSWER, ...over,
  };
}
function gpDoc(chapterId, minutes) {
  return { schemaVersion: 1, chapterId, minutes, exercises: ST.guidedPracticeExercisePlan(minutes).map((p) => ({ id: p.id, minutes: p.minutes, ...exercise() })) };
}

(async () => {
  await check('GP1 niveles 40/60/80/120 (0 = sin) y ejercicios por nivel fijados por Cursia', () => {
    eq(ST.GUIDED_PRACTICE_TIERS, [40, 60, 80, 120], 'niveles');
    eq(ST.STUDY_TIME_RULES.guidedPracticeTiers, [40, 60, 80, 120], 'modelo de tiempo');
    eq([40, 60, 80, 120].map((m) => ST.guidedPracticeExercisePlan(m).map((e) => `${e.id}:${e.minutes}`)), [['E1:20', 'E2:20'], ['E1:30', 'E2:30'], ['E1:40', 'E2:40'], ['E1:40', 'E2:40', 'E3:40']], '2×20, 2×30, 2×40, 3×40');
    for (const m of [40, 60, 80, 120]) eq(ST.guidedPracticeExercisePlan(m).reduce((a, e) => a + e.minutes, 0), m, `suman ${m}`);
    for (const bad of [0, 30, 90, 100, '80', null]) throwsRe(() => ST.guidedPracticeExercisePlan(bad), /GUIDED_PRACTICE_MINUTES_INVALID/, `nivel ${bad}`);
    assert(!ST.isGuidedPracticeMinutes(30) && !ST.isGuidedPracticeMinutes(90) && ST.isGuidedPracticeMinutes(120), 'distintos de los de la AA');
  });

  const base = pilotStructure(null);
  const withGp = pilotStructure({ '1.1': 80, '1.2': 120, '2.1': 40 });
  await check('GP2 Blueprint: clave solo en contenido con práctica guiada; inválidos o en práctica rechazados; sin ella, sha de siempre', () => {
    const chs = withGp.modules.flatMap((m) => m.chapters);
    eq(chs.filter((c) => 'guidedPracticeMinutes' in c).map((c) => c.guidedPracticeMinutes), [80, 120, 40], 'solo los que la tienen');
    eq(Object.keys(chs[0]), ['id', 'position', 'title', 'objective', 'videoEnabled', 'activityEnabled', 'guidedPracticeMinutes'], 'orden canónico');
    eq(SNAP.validateBlueprintSnapshotV2(withGp), [], 'snapshot válido');
    eq(SNAP.snapshotSha256V2(SNAP.recanonicalizeBlueprintSnapshotV2(clone(withGp))), SNAP.snapshotSha256V2(withGp), 'jsonb → canónico');
    // Sin práctica guiada (null o 0 en la columna) = el snapshot de siempre.
    const r0 = SNAP.snapshotV2ToRows(base);
    const zero = SNAP.buildBlueprintSnapshotV2(r0.course, r0.modules, r0.chapters.map((c) => ({ ...c, guided_practice_minutes: c.chapter_kind === 'practice' ? null : 0 })));
    eq(SNAP.snapshotSha256V2(zero), SNAP.snapshotSha256V2(base), '0/null = sin clave (sha de siempre)');
    // Inválidos: entrada, builder y snapshot adulterado; en un capítulo de práctica.
    const r = SNAP.snapshotV2ToRows(withGp);
    const bad = r.chapters.map((c, i) => (i === 0 ? { ...c, guided_practice_minutes: 90 } : c));
    eq(SNAP.validateBlueprintInputV2(r.course, r.modules, bad).map((e) => e.code), ['INVALID_GUIDED_PRACTICE_MINUTES'], 'entrada (90 no es un nivel)');
    throwsRe(() => SNAP.buildBlueprintSnapshotV2(r.course, r.modules, bad), /INVALID_INPUT: .*práctica guiada inválidos \(90/, 'builder');
    const inPractice = r.chapters.map((c) => (c.chapter_kind === 'practice' ? { ...c, guided_practice_minutes: 80 } : c));
    assert(SNAP.validateBlueprintInputV2(r.course, r.modules, inPractice).every((e) => e.code === 'GUIDED_PRACTICE_IN_PRACTICE_CHAPTER') && SNAP.validateBlueprintInputV2(r.course, r.modules, inPractice).length === 3, 'en práctica: rechazada');
    const adulterado = clone(withGp);
    adulterado.modules[0].chapters[1].guidedPracticeMinutes = 0;
    adulterado.modules[0].chapters[4].guidedPracticeMinutes = 40;
    eq(SNAP.validateBlueprintSnapshotV2(adulterado).map((e) => e.code).sort(), ['GUIDED_PRACTICE_IN_PRACTICE_CHAPTER', 'INVALID_GUIDED_PRACTICE_MINUTES'], 'snapshot: clave en 0 y en práctica');
  });

  const m = manifestOf(withGp);
  await check('GP3 Manifest v3: solo contenido con minutos > 0, dependsOn [content], lugar canónico, totales; validador independiente', () => {
    const gps = m.items.filter((i) => i.type === 'guided_practice');
    eq(gps.map((i) => i.guidedPracticeMinutes), [80, 120, 40], 'items con minutos');
    for (const it of gps) {
      eq(it.key, `guided_practice:${it.chapterId}`, 'key');
      eq(it.dependsOn, [`content:${it.chapterId}`], 'depende del content de SU capítulo');
      eq(it.scope, 'chapter', 'scope');
      const keys = m.items.filter((x) => x.chapterId === it.chapterId).map((x) => x.type);
      eq(keys.slice(keys.indexOf('guided_practice') - 1, keys.indexOf('guided_practice') + 2), ['activity', 'guided_practice', 'audiobook_chapter'], 'después de activity/application y antes del audiolibro');
    }
    eq(m.items.some((i) => i.type === 'guided_practice' && withGp.modules.some((mm) => mm.chapters.some((c) => c.id === i.chapterId && c.kind === 'practice'))), false, 'nunca en práctica');
    eq([m.totals.guidedPracticeCount, m.totals.applicationActivityCount, m.totals.totalJobs], [3, 3, m.items.length], 'totales');
    eq(MB.validateGenerationManifest(m, withGp, m.source), [], 'válido');
    const m0 = manifestOf(base);
    assert(!('guidedPracticeCount' in m0.totals) && !m0.items.some((i) => i.type === 'guided_practice'), 'sin prácticas guiadas: totals de siempre');
    // Validador: minutos cambiados, item de más / faltante, totales.
    const t1 = clone(m); t1.items.find((i) => i.type === 'guided_practice').guidedPracticeMinutes = 60;
    assert(MB.validateGenerationManifest(t1, withGp, m.source).some((e) => e.code === 'WRONG_GUIDED_PRACTICE_MINUTES'), 'minutos cambiados');
    const t2 = clone(m); t2.items = t2.items.filter((i) => i.type !== 'guided_practice' || i.guidedPracticeMinutes !== 40); t2.totals.totalJobs = t2.items.length; t2.totals.guidedPracticeCount = 2;
    assert(MB.validateGenerationManifest(t2, withGp, m.source).some((e) => e.code === 'MISSING_GUIDED_PRACTICE'), 'faltante');
    const t3 = clone(m); const extra = clone(t3.items.find((i) => i.type === 'guided_practice')); const other = withGp.modules[2].chapters[2].id;
    Object.assign(extra, { key: `guided_practice:${other}`, chapterId: other, dependsOn: [`content:${other}`] }); t3.items.push(extra);
    assert(MB.validateGenerationManifest(t3, withGp, m.source).some((e) => e.code === 'GUIDED_PRACTICE_NOT_ENABLED'), 'de más');
    const t4 = clone(m); t4.items.find((i) => i.type === 'content').guidedPracticeMinutes = 80;
    assert(MB.validateGenerationManifest(t4, withGp, m.source).some((e) => e.code === 'UNEXPECTED_GUIDED_PRACTICE_MINUTES'), 'minutos en otro tipo');
    eq(MB.manifestSha256(manifestOf(withGp)), MB.manifestSha256(m), 'determinista');
  });

  await check('GP4 tiempo: guided_practice = minutos del nivel en «Práctica y repaso»; al empaquetar solo las validadas', () => {
    const est = ST.estimateCourseStudyTime(ST.studyTimeInputFromManifest(m, withGp));
    const est0 = ST.estimateCourseStudyTime(ST.studyTimeInputFromManifest(manifestOf(base), base));
    const res = est.modules.flatMap((x) => x.chapters).flatMap((c) => c.resources).filter((r) => r.resource === 'guided_practice');
    eq(res.map((r) => [r.minutes, r.component]), [[80, 'practice'], [120, 'practice'], [40, 'practice']], 'recurso y componente');
    eq(Math.round(est.byComponent.practice - est0.byComponent.practice), 240, 'suma a «Práctica y repaso»');
    eq(est.byComponent.application, est0.byComponent.application, 'no es una Actividad de Aplicación');
    eq(Math.round(est.courseEstimatedMinutes - est0.courseEstimatedMinutes), 240, 'al curso');
    const only = ST.estimateCourseStudyTime(ST.studyTimeInputFromManifest(m, withGp, { guidedPracticeChapterIds: [withGp.modules[0].chapters[0].id] }));
    eq(Math.round(only.courseEstimatedMinutes - est0.courseEstimatedMinutes), 80, 'solo la validada');
    throwsRe(() => ST.estimateChapterStudyTime({ chapterId: 'x', kind: 'practice', libro: false, presentation: false, video: false, activity: false, review: false, guidedPracticeMinutes: 80 }), /solo de los capítulos de contenido/, 'nunca en práctica');
    throwsRe(() => ST.estimateChapterStudyTime({ chapterId: 'x', libro: true, presentation: true, video: false, activity: false, review: false, guidedPracticeMinutes: 90 }), /guidedPracticeMinutes/, 'nivel inválido');
  });

  let pilot = null;
  await check('GP5 distribuidor (piloto 3 × 4 + 3 prácticas, 3 AA de 120, 12 H5P, video en todos, meta 42): ≈ 40–44 h sin AA ni capítulos de más; parejo; topes; registrado; punto fijo', () => {
    const before = ST.estimateCourseStudyTime(ST.studyTimeInputFromManifest(manifestOf(base), base)).courseEstimatedHours;
    const d = distribute(base, 42);
    pilot = { before, d };
    eq(d.status, 'within_tolerance', 'llega');
    assert(d.estimatedHours >= 40 && d.estimatedHours <= 44, `${d.estimatedHours} h dentro de 40–44`);
    assert(Math.abs(d.estimatedHours - 42) <= Math.abs(before - 42) && Math.abs(d.estimatedHours - 42) <= 0.7, `apunta a 42 (no al borde): ${d.estimatedHours}`);
    eq([d.counts.applicationActivities, d.counts.applicationMinutes, d.counts.contentChapters, d.counts.practiceChapters, d.counts.activities, d.counts.videoChapters], [3, 360, 12, 3, 12, 12], 'las cantidades del documento no cambian (0 AA de más)');
    assert(!d.changes.some((c) => c.type === 'add_content_chapter' || c.type === 'add_practice_chapter' || c.type === 'set_application_activity'), 'sin capítulos ni AA nuevas');
    const content = d.modules.flatMap((x) => x.chapters).filter((c) => c.kind === 'content');
    const levels = content.map((c) => c.guidedPracticeMinutes);
    assert(levels.every((x) => [40, 60, 80, 120].includes(x)), `niveles: ${levels}`);
    assert(new Set(levels).size <= 2 && Math.max(...levels) - Math.min(...levels) <= 40, `parejo (un nivel o el siguiente): ${levels}`);
    eq(d.counts.guidedPractices, 12, 'en los 12 capítulos de contenido');
    assert(d.modules.flatMap((x) => x.chapters).filter((c) => c.kind === 'practice').every((c) => c.guidedPracticeMinutes === null), 'nunca en la práctica');
    assert(d.modules.flatMap((x) => x.chapters).every((c) => c.targetMinutes <= ST.DISTRIBUTOR_RULES.maxChapterMinutes), '≤ 4 h por capítulo');
    const gpChanges = d.changes.filter((c) => c.type === 'set_guided_practice');
    eq(gpChanges.length, 12, 'un cambio por capítulo');
    assert(gpChanges.every((c) => /^Práctica guiada de (40|60|80|120) min en el capítulo «/.test(c.detail)), gpChanges[0].detail);
    assert(d.priorityTrace.some((t) => /práctica guiada \(formativa, sin nota\)/.test(t)), 'traza');
    eq([d.guidedPracticeFill.used, d.guidedPracticeFill.shortfallHours], [true, 0], 'sin diferencia');
    // Tiempo por componente: la práctica guiada va en «Práctica y repaso»; las AA siguen siendo las 3 de 120.
    eq(d.hoursByComponent.application, 6, 'aplicación = 3 × 120 min');
    // Materializado = la tarjeta (mismo Manifest, mismas horas).
    const mat = P.materializeDistribution(base, d);
    const mm = manifestOf(mat);
    eq(mm.totals.guidedPracticeCount, 12, 'Manifest de la propuesta');
    eq(ST.estimateCourseStudyTime(ST.studyTimeInputFromManifest(mm, mat)).courseEstimatedHours, d.estimatedHours, 'mismas horas que la tarjeta');
    // Punto fijo: aplicado el diseño, no propone nada más.
    const again = distribute(mat, 42);
    eq(again.changes.map((c) => c.detail), [], 'punto fijo');
    eq(again.estimatedHours, d.estimatedHours, 'mismas horas');
    // Lo fijado por el docente se respeta (un capítulo sin práctica guiada).
    const first = content[0].id;
    const pinned = distribute(base, 42, { pins: { [first]: { guided: 0 } } });
    eq(pinned.modules[0].chapters.find((c) => c.id === first).guidedPracticeMinutes, null, 'fijado sin práctica guiada');
    assert(pinned.estimatedHours >= 40, 'los demás compensan');
    console.log(`   piloto: antes ${before} h → con práctica guiada ${d.estimatedHours} h (${levels.join('/')} min; ${d.counts.guidedPracticeMinutes} min en total)`);
  });

  await check('GP5b sin alcance: ni con 120 min en todos los capítulos de contenido se llega → cannot_reach_target y la diferencia se dice; 0 AA de más', () => {
    const d = distribute(base, 70);
    eq(d.status, 'cannot_reach_target', 'no llega');
    assert(d.modules.flatMap((x) => x.chapters).filter((c) => c.kind === 'content').every((c) => c.guidedPracticeMinutes === 120 || c.targetMinutes + 40 > ST.DISTRIBUTOR_RULES.maxChapterMinutes), 'al máximo (o al tope de 4 h)');
    assert(d.recommendations.some((x) => /Ni con práctica guiada en los capítulos de contenido \(hasta 120 min por capítulo\) se llega: faltan/.test(x)), d.recommendations.join(' | '));
    assert(d.guidedPracticeFill.shortfallHours > 0, 'shortfall en horas');
    eq(d.counts.applicationActivities, 3, 'sin AA de más');
    // Dentro de la meta sin práctica guiada: nada se agrega.
    const small = distribute(base, 24);
    assert(!small.counts.guidedPractices && !small.guidedPracticeFill, 'si ya llega, no hay práctica guiada');
  });

  await check('GP6 meta de un rango del documento = su punto medio (la «Meta de diseño» de la UI); dentro del rango se respeta', () => {
    const req = { id: 'RQH', key: 'target_hours@course', kind: 'target_hours', scope: { level: 'course' }, mode: 'range', value: 40, valueMax: 44, obligation: 'required', confidence: 'high', active: true, source: { line: 1 } };
    eq([null, 24, 40, 42, 43.5, 48].map((p) => RA.hoursFromRequirements([req], p).value), [42, 42, 40, 42, 43.5, 42], 'fuera → 42; dentro → la propuesta');
    const exact = { ...req, mode: 'exact', value: 64, valueMax: undefined };
    eq(RA.hoursFromRequirements([exact], 48).value, 64, 'exacto: ese valor');
  });

  await check('GP7 validador del servidor (contrato) + v3-validation + paridad con el ejecutor del navegador (vendor)', () => {
    const ch = withGp.modules[0].chapters[0].id;
    const doc = gpDoc(ch, 80);
    eq(GP.validateGuidedPracticeDoc(doc, { chapterId: ch, minutes: 80 }), [], 'válido');
    const codes = (d, mins = 80) => [...new Set(GP.validateGuidedPracticeDoc(d, { chapterId: ch, minutes: mins }).map((e) => e.code))].sort();
    const mut = (fn) => { const d = clone(doc); fn(d); return d; };
    eq(codes(mut((d) => { d.solution = {}; })), ['GUIDED_PRACTICE_SHAPE'], 'sin clave oculta');
    eq(codes(mut((d) => { d.exercises[0].criteria[0].weight = 50; })), ['GUIDED_PRACTICE_SHAPE'], 'sin pesos');
    eq(codes(mut((d) => { d.exercises[1].minutes = 30; })), ['GUIDED_PRACTICE_EXERCISE_MINUTES'], 'minutos de Cursia');
    eq(codes(doc, 120), ['GUIDED_PRACTICE_COUNT', 'GUIDED_PRACTICE_MINUTES_MISMATCH'], '120 = 3 ejercicios');
    eq(codes(mut((d) => { d.exercises[0].modelAnswer = ANSWER.replace(/\b[123]\. /g, ''); })), ['GUIDED_PRACTICE_ANSWER_ORDER'], 'respuesta en orden');
    eq(codes(mut((d) => { d.exercises[0].tasks[0] = 'Mira el video del capítulo y responde.'; })), ['GUIDED_PRACTICE_RESOURCE_MENTION'], 'sin mencionar recursos');
    throwsRe(() => GP.validateGuidedPracticeDoc(doc, { chapterId: ch, minutes: 90 }), /V3_VALIDATION_CONTEXT/, 'contexto inválido');
    // v3-validation (lo que hace completeItem).
    eq(V3V.v3ValidatedArtifactType('guided_practice'), 'dynamic_guided_practice_json', 'artifact validado');
    const ok = V3V.validateV3ItemArtifact({ type: 'guided_practice', itemKey: `guided_practice:${ch}`, chapterId: ch, guidedPracticeMinutes: 80 }, JSON.stringify(doc));
    eq([ok.ok, ok.summary.exerciseCount, ok.summary.minutes], [true, 2, 80], 'servidor: válido + resumen');
    const lang = V3V.validateV3ItemArtifact({ type: 'guided_practice', itemKey: `guided_practice:${ch}`, chapterId: ch, guidedPracticeMinutes: 80 }, JSON.stringify(mut((d) => { d.exercises[0].tasks[0] = 'Vos tenés que identificar qué necesita realmente el cliente.'; })));
    assert(!lang.ok && lang.errors.some((e) => e.code === 'LANGUAGE_NOT_NEUTRAL'), 'idioma neutro (voseo)');
    throwsRe(() => V3V.validateV3ItemArtifact({ type: 'guided_practice', itemKey: 'x', chapterId: ch }, JSON.stringify(doc)), /sin chapterId o minutos/, 'sin minutos del Manifest → bug de integración');
    // Paridad con el ejecutor (el código que corre el worker de IA).
    const vendor = path.join(__dirname, '..', 'vendor', 'dynamic-executor');
    const ctx = { console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout, clearTimeout, Promise, Date, Math, JSON };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of ['44-dynamic-prompt-builders.js', '45-dynamic-generation-executor.js']) vm.runInContext(fs.readFileSync(path.join(vendor, f), 'utf8'), ctx, { filename: f });
    const cases = [doc, mut((d) => { d.solution = {}; }), mut((d) => { d.exercises[0].kind = 'quiz'; }), mut((d) => { d.exercises[0].situation = 'corta'; }), mut((d) => { d.exercises[0].criteria.pop(); d.exercises[0].criteria.pop(); }), mut((d) => { d.exercises[0].modelAnswer = ANSWER.replace('1. El', 'El'); }), mut((d) => { d.exercises[0].expectedProduct = 'Igual que en la Actividad de Aplicación.'; })];
    for (const [i, d] of cases.entries()) {
      const be = [...new Set(GP.validateGuidedPracticeDoc(d, { chapterId: ch, minutes: 80 }).map((e) => e.code))].sort();
      const fe = [...new Set(ctx.dynValidateGuidedPracticeDoc(d, { chapterId: ch, minutes: 80 }).map((e) => e.code))].sort();
      eq(fe, be, `caso ${i}: ejecutor = servidor`);
    }
    eq(JSON.parse(JSON.stringify(ctx.DYN_GUIDED_PRACTICE_EXERCISES_BY_MINUTES)), { 40: [20, 20], 60: [30, 30], 80: [40, 40], 120: [40, 40, 40] }, 'mismos niveles');
    eq(String(ctx.DYN_GUIDED_PRACTICE_RESOURCE_RE), String(GP.GUIDED_PRACTICE_RESOURCE_RE), 'misma regex de recursos');
    eq(JSON.parse(JSON.stringify(ctx.DYN_GUIDED_PRACTICE_LIM)), JSON.parse(JSON.stringify(GP.GUIDED_PRACTICE_LIMITS)), 'mismos límites');
  });

  const B = loadDist('package/dynamic-mbz-builder-v3.js');
  const VAL = loadDist('package/v3/mbz-validator-v3.js');
  const PF = require('./lib/v21-packaging-fixtures');
  const JSZip = require('jszip');
  const GP_MODULES = [
    { examEnabled: true, chapters: [{ video: true, activity: true, guided: 80 }, { video: false, activity: true, guided: 120, application: 60 }, { practice: true, activity: true, application: 120 }] },
    { examEnabled: false, chapters: [{ video: true, activity: true }, { video: false, activity: false, guided: 40 }] },
  ];
  let built = null;
  const pkg = async () => {
    if (built) return built;
    const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 650, modules: GP_MODULES });
    const r = await B.buildDynamicMbzV3(input);
    built = { input, r, zip: await JSZip.loadAsync(r.mbz) };
    return built;
  };
  const actsOf = async (zip) => {
    const mb = await zip.file('moodle_backup.xml').async('string');
    return [...mb.matchAll(/<activity>\s*<moduleid>(\d+)<\/moduleid>\s*<sectionid>(\d+)<\/sectionid>\s*<modulename>([a-z0-9_]+)<\/modulename>\s*<title>([^<]*)<\/title>\s*<directory>([^<]+)<\/directory>/g)].map((x) => ({ mid: Number(x[1]), sec: Number(x[2]), mod: x[3], title: x[4], dir: x[5] }));
  };
  const idnOf = async (zip, dir) => ((await zip.file(`${dir}/module.xml`).async('string')).match(/<idnumber>([^<]*)<\/idnumber>/) || [])[1];

  await check('GP8 empaque: página «Práctica guiada — <capítulo>» tras el texto (antes del video/actividad), visible, formativa, respuesta modelo; Libro Guía; validador', async () => {
    const { input, r, zip } = await pkg();
    const v = await VAL.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, `validador ${JSON.stringify(v.issues.slice(0, 5))}`);
    const gpChapters = input.manifest.modules.flatMap((mm) => mm.chapters).filter((c) => c.guidedPracticeMinutes !== undefined);
    eq(gpChapters.map((c) => c.guidedPracticeMinutes), [80, 120, 40], 'capítulos con práctica guiada');
    const acts = await actsOf(zip);
    for (const c of gpChapters) {
      const pages = [];
      for (const a of acts) if ((await idnOf(zip, a.dir)) === `cv3:ch:${c.chapterId}:guided_practice`) pages.push(a);
      eq(pages.length, 1, `capítulo ${c.chapterNumber}: una página`);
      const a = pages[0];
      eq(a.mod, 'page', 'mod_page');
      const title = input.blueprint.modules.flatMap((mm) => mm.chapters).find((x) => x.id === c.chapterId).title;
      eq(a.title, `Práctica guiada — ${title}`, 'nombre');
      const mx = await zip.file(`${a.dir}/module.xml`).async('string');
      eq([(mx.match(/<visible>(\d)<\/visible>/) || [])[1], (mx.match(/<completion>(\d)<\/completion>/) || [])[1]], ['1', '2'], 'visible, completion por vista');
      const page = await zip.file(`${a.dir}/page.xml`).async('string');
      const html = page.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      assert(!/<style|<script/i.test(html), 'sin <style>/<script>');
      const doc = input.contents.guidedPractices.get(c.chapterId);
      assert(html.includes('Respuesta modelo (revísala después de intentarlo)') && html.includes('Qué debes hacer') && html.includes('Producto esperado') && html.includes('Criterios para revisar tu trabajo'), 'estructura');
      eq((html.match(/Ejercicio \d de \d/g) || []).length, doc.exercises.length, 'un bloque por ejercicio');
      assert(html.includes(`~${doc.exercises[0].minutes} min`) && /no tiene nota/.test(html), 'minutos y formativa');
      assert(!/Solucionario|Nota mínima|calificad/i.test(html), 'sin solucionario ni nota');
      // Lugar: después de la profundización, antes del video y de la actividad.
      const sec = acts.filter((x) => x.sec === a.sec);
      const ids = [];
      for (const x of sec) ids.push((await idnOf(zip, x.dir)).split(':').pop());
      const i = ids.indexOf('guided_practice');
      eq(ids[i - 1], 'deepening', `capítulo ${c.chapterNumber}: después del texto`);
      assert(ids.indexOf('video') < 0 || ids.indexOf('video') > i, 'antes del video');
      assert(ids.indexOf('activity') < 0 || ids.indexOf('activity') > i, 'antes de la actividad');
    }
    // Secuencia completa = Manifest + chapterSlotSequence.
    const want = PF.expectedSequence(distRoot, input);
    const got = new Map();
    for (const a of acts) { if (!got.has(a.sec)) got.set(a.sec, []); got.get(a.sec).push(await idnOf(zip, a.dir)); }
    for (const [sec, ids] of want) eq(got.get(sec), ids, `sección ${sec}`);
    // Minutos en facts: base + práctica guiada; contada aparte de la AA.
    const facts = r.expectations.facts;
    for (const c of gpChapters) eq(facts.chapters.find((x) => x.id === c.chapterId).guidedPracticeMinutes, c.guidedPracticeMinutes, 'facts con minutos');
    eq(facts.counts.guidedPractices, 3, 'facts.counts');
    // Libro Guía: la práctica guiada al final del capítulo, sin sumar palabras al Libro.
    const LIBRO = loadDist('package/v3/libro-v3.js');
    const libroOf = (appendix) => LIBRO.renderLibroPdfV3({
      courseTitle: 'Curso', theme: loadDist('modules/theme-engine/index.js').resolveTheme({ themeFamily: 'aula-clara', mode: 'light' }), courseIntro: input.contents.courseIntro,
      modules: [{ number: 1, title: 'Módulo', intro: input.contents.moduleIntros.get(input.manifest.modules[0].moduleId), chapters: [{ number: 1, title: 'Capítulo', md: input.contents.contentMd.get(gpChapters[0].chapterId), ...(appendix ? { appendixMd: appendix } : {}) }] }],
      logo: loadDist('package/v3/libro-logo.js').cursiaDefaultLogo(),
    });
    const GPP = loadDist('modules/course-shell/guided-practice-page.js');
    const md = GPP.guidedPracticeLibroMarkdown(input.contents.guidedPractices.get(gpChapters[0].chapterId));
    assert(md.startsWith('## Práctica guiada del capítulo') && md.includes('**Respuesta modelo (revísala después de intentarlo).**') && md.includes('1. Identifica'), 'Markdown del Libro');
    const [l0, l1] = [await libroOf(null), await libroOf(md)];
    eq(l1.wordCount, l0.wordCount, 'no suma palabras al Libro (sus minutos son los de la práctica guiada)');
    assert(l1.pageCount > l0.pageCount, `más páginas con la práctica (${l0.pageCount} → ${l1.pageCount})`);
  });

  await check('GP8b sin documento o inválido → el paquete se rechaza; el validador del .mbz detecta una página faltante o de más', async () => {
    const { input, r } = await pkg();
    const gpCh = [...input.contents.guidedPractices.keys()][0];
    const missing = { ...input, contents: { ...input.contents, guidedPractices: new Map([...input.contents.guidedPractices].filter(([k]) => k !== gpCh)) } };
    let err = null;
    try { await B.buildDynamicMbzV3(missing); } catch (e) { err = e; }
    assert(err && /MBZ_V3_INVARIANT: práctica guiada del capítulo \d+ sin documento/.test(err.message), `sin documento: ${err && err.message}`);
    const badDoc = clone(input.contents.guidedPractices.get(gpCh)); badDoc.exercises[0].modelAnswer = 'Sin numerar.';
    const invalid = { ...input, contents: { ...input.contents, guidedPractices: new Map([...input.contents.guidedPractices].map(([k, v]) => [k, k === gpCh ? badDoc : v])) } };
    err = null;
    try { await B.buildDynamicMbzV3(invalid); } catch (e) { err = e; }
    assert(err && /práctica guiada del capítulo \d+ inválida/.test(err.message), `inválido: ${err && err.message}`);
    // facts sin la práctica validada → rechazo (nunca se omite en silencio).
    throwsRe(() => SHELL.buildCourseFacts({ manifest: input.manifest, blueprint: input.blueprint, assessment: input.assessmentProfile, artifacts: r.expectations.facts ? { slideCountByChapter: Object.fromEntries(r.expectations.facts.chapters.filter((c) => c.kind !== 'practice').map((c) => [c.id, c.slideCount])), audioWelcomeSeconds: 58, audiobookParts: r.expectations.facts.audio.audiobookParts.map((p) => ({ chapterId: p.chapterId, seconds: p.seconds })), examQuestionCountByModule: Object.fromEntries(r.expectations.facts.modules.filter((x) => x.examEnabled).map((x) => [x.id, x.examQuestionCount])), finalExamQuestionCount: r.expectations.facts.finalExam.questionCount, libroWordCount: r.expectations.facts.libro.wordCount } : null }), /no llegó validada al paquete/, 'facts');
    // El validador: facts con una práctica guiada más que el paquete / página de más.
    const exp2 = clone(r.expectations);
    exp2.facts.chapters.find((c) => c.guidedPracticeMinutes === undefined && c.kind !== 'practice').guidedPracticeMinutes = 60;
    assert((await VAL.validateMbzV3(r.mbz, exp2)).issues.some((i) => i.code === 'GUIDED_PRACTICE'), 'página faltante');
    const exp3 = clone(r.expectations);
    delete exp3.facts.chapters.find((c) => c.guidedPracticeMinutes !== undefined).guidedPracticeMinutes;
    assert((await VAL.validateMbzV3(r.mbz, exp3)).issues.some((i) => i.code === 'GUIDED_PRACTICE'), 'página de más');
  });

  await check('GP9 estimador: llm.guided_practice (Anthropic Sonnet 4.6), salida × ejercicios/2, categoría «content», presupuesto por parte; costo del piloto', () => {
    const F = loadDist('modules/finops/index.js');
    const RB = loadDist('modules/finops/run-budget.js');
    const NA = loadDist('modules/finops/normal-approval.js');
    const G = loadDist('modules/finops/run-spend-guard.js');
    const { loadPricingSeed } = require('./migrate-v21-finops');
    const CATALOG = loadPricingSeed().rows.map((r0, i) => ({ id: `seed-${i}`, ...r0 }));
    eq(F.operationsForItemType('guided_practice'), ['llm.guided_practice'], 'operación');
    const op = F.usageModelPriorsV1().operations['llm.guided_practice'];
    eq([op.provider, op.product, op.meters.input_tokens.p50, op.meters.output_tokens.p50], ['anthropic', 'claude-sonnet-4-6', 9000, 3200], 'priors');
    eq([40, 60, 80, 120].map((x) => RB.guidedPracticeUsageScale(x)), [{ output_tokens: 1 }, { output_tokens: 1 }, { output_tokens: 1 }, { output_tokens: 1.5 }], 'escala por ejercicios');
    eq(RB.guidedPracticeUsageScale(90), null, 'nivel inválido');
    const items = RB.estimateItemsForRun(m.items, 'real');
    const gpItems = items.filter((i) => i.itemType === 'guided_practice');
    eq(gpItems.map((i) => i.usageScale || null), [null, { output_tokens: 1.5 }, null], 'estimateItemsForRun fija la escala (120 = 3 ejercicios)');
    const e = F.estimateCost({ items, catalog: CATALOG, usageModel: F.usageModelPriorsV1(), retryPolicy: { maxRetries: 1 } });
    const lines = e.lines.filter((l) => l.itemType === 'guided_practice');
    eq([...new Set(lines.map((l) => `${l.provider}/${l.operation}`))], ['anthropic/llm.guided_practice'], 'Anthropic');
    eq(NA.ESTIMATE_CATEGORY_OF_PROVIDER.anthropic, 'content', 'categoría «content»');
    for (const l of lines) assert(G.itemHardLimit(Number(l.expected), Number(l.max), 0) >= Number(l.max), 'presupuesto de recuperación por parte');
    // Costo del piloto: la propuesta con 12 prácticas guiadas frente a la misma sin ellas.
    const mat = P.materializeDistribution(base, pilot.d);
    const cost = (mf) => Number(F.estimateCost({ items: RB.estimateItemsForRun(mf.items, 'real'), catalog: CATALOG, usageModel: F.usageModelPriorsV1(), retryPolicy: { maxRetries: 1 } }).totals.byItemType.guided_practice?.expected || 0);
    const delta = cost(manifestOf(mat));
    assert(delta > 0 && delta < 2.5, `delta del piloto ${delta.toFixed(2)} USD (12 partes)`);
    console.log(`   costo estimado de la práctica guiada del piloto: ≈ USD ${delta.toFixed(2)} (12 capítulos, ${pilot.d.counts.guidedPracticeMinutes} min)`);
  });

  await check('GP10 cascada, huellas, enrutamiento, claim y clases de falla', async () => {
    const ch = withGp.modules[0].chapters[0].id;
    const casc = CASCADE.regenerationCascade(3, m.items, m.items.find((i) => i.key === `content:${ch}`));
    assert(casc.regenerate.includes(`guided_practice:${ch}`), 'regenerar el content rehace la práctica guiada');
    assert(ROUTING.ALL_LLM_WORKER_TYPES.includes('guided_practice') && ROUTING.DEFAULT_LLM_WORKER_TYPES.includes('guided_practice'), 'worker de IA por defecto');
    assert(SCHED.BROWSER_CLAIMABLE_TYPES.includes('guided_practice'), 'reclamable por el navegador (con la capacidad)');
    eq(SCHED.GUIDED_PRACTICE_FEATURE, 'guided-practice-1', 'capacidad del claim');
    for (const code of ['GUIDED_PRACTICE_TEXT', 'GUIDED_PRACTICE_ANSWER_ORDER', 'GUIDED_PRACTICE_RESOURCE_MENTION']) assert(FC.isKnownValidationCode(code), `clase B: ${code}`);
    // Guarda de esquema (503 sin la migración).
    GUARD._resetGuidedPracticeSchemaGuardForTests();
    let err = null;
    try { await GUARD.assertGuidedPracticeSchema({ query: async () => [] }); } catch (e) { err = e; }
    assert(err && err.getStatus && err.getStatus() === 503 && /schema_not_migrated_guided_practice/.test(JSON.stringify(err.getResponse())), `503: ${err && err.message}`);
    eq(await GUARD.hasGuidedPracticeSchema({ query: async () => [] }), false, 'sin columna');
    eq(await GUARD.hasGuidedPracticeSchema({ query: async () => [{ '?column?': 1 }] }), true, 'con columna');
    GUARD._resetGuidedPracticeSchemaGuardForTests();
  });

  console.log(`\n${passes} OK, ${failures} fallidas`);
  process.exit(failures ? 1 : 0);
})();
