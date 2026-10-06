#!/usr/bin/env node
/* eslint-disable no-console */
// Fase 5 · Regeneración parcial inteligente — pruebas puras (USD 0: sin proveedores, sin base, red bloqueada).
//
// Un curso «ya generado» (microcurrículo de 64 h, competencias, Actividades de Aplicación) y cambios típicos; el impacto
// sale del MISMO plan de invalidación v3 que usa la regeneración real:
//   CI1  dependencias (5.1): tabla por tipo (de qué depende, qué entra en su huella, si es pagado)
//   CI2  cambiar UN capítulo (5.2): solo sus items (y lo que lo incluye: examen del módulo, examen final, intro del
//        módulo); los demás capítulos quedan intactos; lo pagado (video, Gamma, audio) NO se regenera solo
//   CI3  cambiar el enfoque (5.3): se regenera lo que depende del diseño; lo pagado queda marcado, no se regenera
//   CI4  cambiar las horas 64 → 48 (5.4): nueva propuesta sin destruir nada (ningún capítulo se borra); qué cambiaría
//   CI5  costo (5.5): costo simulado de lo que se ejecutaría ≤ costo del curso completo; lo pagado marcado, aparte
//   CI6  sin cambios: todo intacto, costo 0; y 0 llamadas de red
//
// Uso: node scripts/check-change-impact.js [path/to/dist]
'use strict';
const path = require('path');

const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  const net = require('net'); net.connect = deny('net.connect'); net.createConnection = deny('net.createConnection');
  const tls = require('tls'); tls.connect = deny('tls.connect');
  globalThis.fetch = deny('fetch');
}
const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const load = (rel) => require(path.join(distRoot, rel));
const A = load('modules/academic-context/index.js');
const SNAP = load('modules/course-blueprints/blueprint-snapshot.js');
const P = load('modules/pedagogy/index.js');
const DR = load('modules/pedagogy/dry-run.js');
const MB = load('modules/generation-manifests/generation-manifest-builder.js');
const PLAN = load('modules/invalidation/plan.js');
const CI = load('modules/invalidation/change-impact.js');
const ST = load('modules/study-time/index.js');
const MI = load('modules/study-time/manifest-input.js');
const DIST = load('modules/study-time/distributor.js');
const F = require('./lib/academic-fixtures.js');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const A1 = JSON.stringify(a); const B1 = JSON.stringify(b); if (A1 !== B1) throw new Error(`${m}: esperado ${B1}, encontrado ${A1}`); };
const clone = (o) => JSON.parse(JSON.stringify(o));

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const source = (snap) => ({ courseId: 7001, blueprintId: 1, blueprintNumber: 1, blueprintSha256: SNAP.snapshotSha256V2(snap) });
const sideOf = (snap) => {
  const manifest = MB.buildGenerationManifestV3(snap, source(snap), { activityTypeRules: 2 });
  return { blueprint: snap, manifest, studyTime: ST.estimateCourseStudyTime(MI.studyTimeInputFromManifest(manifest, snap)) };
};
/** Items «generados» del run de origen: todos completados con su artifact listo. */
const fromItemsOf = (manifest) => manifest.items.map((i) => ({
  itemKey: i.key, itemRunId: `run-${i.key}`, status: 'completed', artifactIds: [`art-${i.key}`], artifactStatus: 'ready',
  outputIdentity: `out-${i.key}`, ...(i.type === 'video_interactions' ? { consumedVideoIdentity: `out-video:${i.chapterId}` } : {}),
}));
const impactOf = (from, to) => {
  const plan = PLAN.computeInvalidationPlan({
    from: { blueprint: from.blueprint, manifest: from.manifest, items: fromItemsOf(from.manifest), courseContextSha256: 'ctx' },
    to: { blueprint: to.blueprint, manifest: to.manifest, courseContextSha256: 'ctx' },
  });
  return CI.summarizeChangeImpact({ plan, to, from });
};

(async () => {
  const ctx = (await A.extractAcademicContext([{ name: 'm.docx', data: await F.fixture('consistent', 'docx') }])).context;
  const prop = A.proposeStructureFromContext(ctx);
  const modules = [];
  const chapters = [];
  prop.modules.forEach((m, mi) => {
    const id = uuid();
    modules.push({ id, position: mi, title: m.title, objective: m.objective, description: m.description, exam_enabled: true });
    m.chapters.forEach((c, ci) => chapters.push({ id: uuid(), module_id: id, position: ci, title: c.title, objective: c.objective, description: c.description, video_enabled: true, activity_enabled: true, application_minutes: 60, outcome_ids: c.outcomeIds }));
  });
  const profileOf = (approach, hours) => ({ ...A.suggestProfileFromContext(ctx, null).profile, primaryApproach: approach, secondaryApproaches: [], targetHours: hours });
  const courseRef = (hours) => ({ id: 7001, title: 'Contabilidad de Costos', finalExam: true, activityEngine: 'h5p', reviewCards: true, targetHours: hours, academicContext: A.academicBlueprintContext(ctx) });
  const designed = (mods, chs, approach, hours) => {
    const plain = SNAP.buildBlueprintSnapshotV2(courseRef(hours), mods, chs);
    return P.applyPedagogyToSnapshot(plain, P.deriveDesignRulesOrNull(profileOf(approach, hours)));
  };
  const from = sideOf(designed(modules, chapters, 'competencias', 64));

  await check('CI1 dependencias: cada tipo con lo que lo alimenta, su huella y si es pagado', () => {
    const t = CI.dependencyTable();
    const by = Object.fromEntries(t.map((x) => [x.type, x]));
    eq(Object.keys(by).length, 14, 'los 14 tipos del Manifest v3');
    eq([by.video.paid, by.presentation.paid, by.audiobook_chapter.paid, by.audio_welcome.paid, by.content.paid], [true, true, true, true, false], 'pagados');
    eq([by.activity.outcomesInFingerprint, by.exam.outcomesInFingerprint, by.content.outcomesInFingerprint], [true, true, false], 'resultados solo en la huella de la evidencia (R26)');
    assert(/content/.test(by.application_activity.dependsOn) && /video/.test(by.video_interactions.dependsOn), 'aristas');
  });

  await check('CI2 cambiar UN capítulo: solo él (y su examen / intro de módulo / examen final); el resto intacto; lo pagado no se regenera solo', () => {
    const target = chapters[2]; // módulo 1, capítulo 3
    const chs = chapters.map((c) => (c.id === target.id ? { ...c, title: 'Clasificación de los costos por comportamiento' } : c));
    const imp = impactOf(from, sideOf(designed(modules, chs, 'competencias', 64)));
    const ch = imp.chapters.find((c) => c.chapterId === target.id);
    eq(ch.regenerate.map((k) => k.split(':')[0]).sort(), ['activity', 'application_activity', 'content', 'experience'], 'items de texto del capítulo');
    // Lo pagado (video, Gamma, audiolibro) queda marcado, y las preguntas del video SIGUEN a su video (describen el
    // video que sigue en el curso): se regenerarían junto con él solo si el docente lo confirma.
    eq(ch.paidStale.map((k) => k.split(':')[0]).sort(), ['audiobook_chapter', 'presentation', 'video', 'video_interactions'], 'pagado marcado (STALE_NO_AUTO), no se regenera solo');
    eq(imp.reasons[`video_interactions:${target.id}`], ['video_stale'], 'motivo: el video quedó marcado');
    eq(imp.untouchedChapters, imp.chapters.length - 1, 'los demás capítulos intactos');
    const others = imp.toRun.filter((k) => !k.includes(target.id));
    eq(others.map((k) => k.split(':')[0]).sort(), ['course_intro', 'course_plan', 'exam', 'final_exam', 'module_intro'].filter((t) => others.some((k) => k.startsWith(t + ':'))).sort(), 'fuera del capítulo solo lo que lo incluye');
    assert(others.every((k) => /^(course_plan|course_intro|module_intro|exam|final_exam):/.test(k)), `fuera del capítulo: ${others.join(', ')}`);
    assert(!others.some((k) => k.startsWith('exam:') && !k.includes(modules[0].id)), 'solo el examen de SU módulo');
    assert(Object.keys(imp.reasons).some((k) => k.includes(target.id)), 'motivos por item');
  });

  await check('CI3 cambiar el enfoque (competencias → significativo): regenera lo que depende del diseño; lo pagado queda marcado', () => {
    const imp = impactOf(from, sideOf(designed(modules, chapters, 'significativo', 64)));
    assert(imp.toRun.length > 0, 'hay items a regenerar');
    eq(imp.paidNew.length, 0, 'ningún pago nuevo');
    assert(imp.toRun.every((k) => !/^(video|presentation|audiobook_chapter|audio_welcome):/.test(k)), 'nada pagado se ejecuta solo');
    // Cada item de texto lleva su diseño pedagógico: cambiar el enfoque los alcanza a todos, y el plan dice por qué.
    assert(imp.toRun.every((k) => (imp.reasons[k] || []).length > 0), 'cada regeneración tiene su motivo');
    assert(imp.paidStale.length > 0 && imp.paidStale.every((k) => !imp.toRun.includes(k)), 'lo pagado se conserva marcado');
    const noDesign = imp.toRun.filter((k) => /^(audio_welcome):/.test(k));
    eq(noDesign, [], 'lo que no lleva diseño no se toca');
    const ped = from.blueprint.course.pedagogy;
    assert(ped && ped.approaches[0].id === 'competencias', 'desde: competencias');
  });

  await check('CI4 horas 64 → 48: nueva propuesta sin borrar capítulos; qué cambiaría', () => {
    // «Desde» = el curso generado con el diseño de 64 h ya aplicado (práctica + Actividades de Aplicación).
    const at = (h, rows) => {
      const base = SNAP.buildBlueprintSnapshotV2(courseRef(h), rows.modules, rows.chapters);
      const rules = P.deriveDesignRulesOrNull(profileOf('competencias', h));
      const lockShaped = P.applyPedagogyToSnapshot(base, rules);
      const dist = DIST.distributeCourseHours({ snapshot: lockShaped, rules, targetHours: h, activityTypeRules: 2, preferences: {} });
      return { dist, snap: P.applyPedagogyToSnapshot(DR.materializeDistribution(lockShaped, dist), rules) };
    };
    const at64 = at(64, { modules, chapters: chapters.map(({ application_minutes, ...c }) => c) });
    const from64 = sideOf(at64.snap);
    const live = SNAP.snapshotV2ToRows(at64.snap);
    const { dist, snap } = at(48, { modules: live.modules, chapters: live.chapters });
    const to = sideOf(snap);
    const fromForThis = from64;
    const imp = impactOf(fromForThis, to);
    const fromIds = new Set(fromForThis.blueprint.modules.flatMap((m) => m.chapters.map((c) => c.id)));
    const toIds = new Set(to.blueprint.modules.flatMap((m) => m.chapters.map((c) => c.id)));
    assert([...fromIds].every((id) => toIds.has(id)), 'ningún capítulo se borra');
    assert(imp.hours && imp.hours.to < imp.hours.from, `horas: ${JSON.stringify(imp.hours)}`);
    assert(dist.changes.length > 0 && ['within_tolerance', 'above_tolerance', 'minimum_exceeds_target'].includes(dist.status), `propuesta: ${dist.status}`);
    const contentRun = imp.toRun.filter((k) => k.startsWith('content:'));
    eq(contentRun, [], 'bajar horas no regenera el contenido de los capítulos');
    eq(imp.paidStale, [], 'ni toca lo pagado');
  });

  await check('CI5 costo de los cambios (simulado): ≤ curso completo; lo pagado marcado se informa aparte; USD 0', () => {
    const chs = chapters.map((c, i) => (i === 2 ? { ...c, title: 'Clasificación de los costos por comportamiento' } : c));
    const imp = impactOf(from, sideOf(designed(modules, chs, 'competencias', 64)));
    const full = Number(DR.providerPlanFor(from.manifest).estimateUsd.expected);
    const cost = Number(imp.cost.toRun.estimateUsd.expected);
    const paid = Number(imp.cost.paidStaleIfRegenerated.estimateUsd.expected);
    assert(cost > 0 && cost < full / 3, `cambiar un capítulo cuesta USD ${cost.toFixed(2)} (curso completo USD ${full.toFixed(2)})`);
    assert(paid > 0, `regenerar sus pagados costaría USD ${paid.toFixed(2)}, aparte`);
    eq([imp.dryRun, imp.providersCalled, imp.spendUsd], [true, 0, '0.00'], 'nada se ejecuta');
  });

  await check('CI6 sin cambios: todo intacto y costo 0; red', () => {
    const imp = impactOf(from, sideOf(designed(modules, chapters, 'competencias', 64)));
    eq([imp.toRun.length, imp.paidStale.length, imp.untouchedChapters === imp.chapters.length], [0, 0, true], 'nada que regenerar');
    eq(Number(imp.cost.toRun.estimateUsd.expected), 0, 'USD 0');
    eq(netAttempts, [], 'red');
  });

  // --export <dir>: respuestas REALES de la vista previa para el harness del frontend (test-53).
  const exp = process.argv.indexOf('--export');
  if (exp > 0) {
    const fs = require('fs');
    const chs = chapters.map((c, i) => (i === 2 ? { ...c, title: 'Clasificación de los costos por comportamiento' } : c));
    const imp = impactOf(from, sideOf(designed(modules, chs, 'competencias', 64)));
    const out = {
      generatedFrom: 'cursia-backend scripts/check-change-impact.js --export',
      available: { available: true, fromRunId: '11111111-1111-4111-8111-111111111111', fromBlueprintNumber: 1, blueprintChanged: true, impact: imp, distribution: null, dependencies: CI.dependencyTable() },
      none: { available: false, reason: 'NO_PREVIOUS_RUN', dryRun: true, providersCalled: 0, spendUsd: '0.00', message: 'El curso todavía no se generó: no hay nada que conservar. Generarlo completo costaría lo estimado.', fullGeneration: DR.providerPlanFor(from.manifest), hours: from.studyTime.courseEstimatedHours, distribution: null, dependencies: CI.dependencyTable() },
    };
    fs.writeFileSync(path.join(process.argv[exp + 1], 'change-impact-v1.json'), JSON.stringify(out, null, 1) + '\n');
    console.log('fixture exportado');
  }
  console.log(`\n${passes} OK, ${failures} fallidas`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
