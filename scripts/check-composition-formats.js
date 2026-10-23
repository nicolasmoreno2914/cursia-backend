#!/usr/bin/env node
/* eslint-disable */
// T3 (r57) — Composición por necesidad (video por tipo de aprendizaje), mezcla de capítulos de práctica y formatos
// S/M/L de punta a punta. Check puro contra el código COMPILADO (dist/; correr "npm run build" antes). Sin red, sin IA,
// sin DB, USD 0. Proveedores: los artifacts simulados de los checks de empaque (scripts/lib/v21-packaging-fixtures.js).
//
//   C1  reglas del video por necesidad: tabla, precedencia (fijado > documento > mín/máx > «Ajustar» > necesidad >
//       presupuesto de horas), determinismo, errores
//   C2  40 h con la MISMA forma: 8, 12 o 15 videos según las necesidades de sus capítulos; motivo (ruleId) por capítulo
//       en la proyección del diseño; FinOps sale del Manifest (videogen = videos; costo crece con los videos)
//   C3  mezcla de práctica: 4×4 (9+7), 4×5 (9+11), 3×4 (7+5), formatos con práctica; validación; el documento manda;
//       forma de contenidos distinta → no se aplica (se informa)
//   C4  punto fijo: aplicar el diseño y volver a calcular no propone cambios (videos ni capítulos)
//   C5  S/M/L + 4×4, 4×5, 3×4, 32 h, 96 h de punta a punta: formato → Prebrief → Blueprint → distribuidor → Manifest →
//       artifacts simulados → buildDynamicMbzV3 → validateMbzV3; conteos, exámenes, horas y validez del paquete
//   C6  S, M y L NO pueden salir casi iguales (falla si la composición se uniforma)
//   C7  perfil: composition validada (errores con código); normalización estable
//   C8  compatibilidad: sin `composition`, el dry-run completo es byte a byte el de antes (44 huellas, BE 5ec26c8)
//
// Usage: node scripts/check-composition-formats.js [path/to/dist]
'use strict';
require('reflect-metadata');
const path = require('path');

const distArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const distRoot = path.resolve(process.cwd(), distArg || 'dist');
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿corriste "npm run build"?): ${err.message}`);
    process.exit(1);
  }
}

const P = loadDist('modules/pedagogy/index.js');
const ST = loadDist('modules/study-time/index.js');
const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const MB = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const B = loadDist('package/dynamic-mbz-builder-v3.js');
const VAL = loadDist('package/v3/mbz-validator-v3.js');
const EB = loadDist('modules/course-shell/exam-bank.js');
const SO = loadDist('modules/course-design/structure-options.js');
const CF = loadDist('modules/prebrief/course-formats.js');
const PM = loadDist('modules/prebrief/prebrief-model.js');
const RA = loadDist('modules/academic-context/requirements/requirement-authority.js');
const C = require('./lib/composition-fixtures');
const PF = require('./lib/v21-packaging-fixtures');
const { fixture: prebriefFixture } = require('./fixtures/prebrief-fixtures.js');
const GOLDEN = require('./fixtures/composition/golden-off.json');
const { digests: goldenDigests } = require('./composition-export-golden');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ ${name}\n   ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 4).join('\n   ')}`);
  }
}
function assert(c, msg) { if (!c) throw new Error(msg); }
function eq(a, b, msg) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${msg}: ${x} !== ${y}`); }
function throwsRe(fn, re, msg) {
  try { fn(); } catch (e) { if (re.test(String(e.message))) return; throw new Error(`${msg}: error inesperado ${e.message}`); }
  throw new Error(`${msg}: no lanzó`);
}

const FIXED = { noContentAdditions: true, sources: {} };
const ch = (id, order, learningType, pinned) => ({ chapterId: id, order, learningType, ...(pinned !== undefined ? { pinned } : {}) });
const dec = (r) => Object.fromEntries(r.decisions.map((d) => [d.chapterId, `${d.enabled ? 'V' : '-'}:${d.ruleId}`]));
const dryRun = (fx, o = {}) => P.runPedagogyDryRun({
  structure: o.structure || C.plainStructure(C.structureOf(fx)),
  profile: o.profile || C.profileOf(fx, o.profileOpts || {}),
  activityTypeRules: 2,
  requirementConstraints: o.req !== undefined ? o.req : FIXED,
  ...(o.pins ? { designPins: o.pins } : {}),
});
const contentChapters = (d) => d.modules.flatMap((m) => m.chapters.filter((c) => c.kind === 'content'));
const videogenOps = (providers) => Object.values(providers.byProvider).reduce((n, p) => n + (p.operations['videogen.render'] || 0), 0);

/** Materializa la propuesta como lo haría «Usar este diseño» + lock (mismo cálculo que el dry-run). */
function materialize(fx, profile, dist, structure) {
  const rules = P.deriveDesignRules(P.normalizePedagogicalProfile(profile));
  let base = P.snapshotFromStructure(structure);
  base = P.withTargetHours(base, fx.targetHours);
  const ac = P.profileApplicationContext(profile);
  if (ac) base = P.withApplicationContext(base, ac);
  const lockShaped = P.applyPedagogyToSnapshot(base, rules);
  const plain = P.materializeDistribution(lockShaped, dist, ac);
  const locked = P.applyPedagogyToSnapshot(plain, rules);
  const source = { courseId: locked.course.id, blueprintId: 1, blueprintNumber: 1, blueprintSha256: snap.snapshotSha256V2(locked) };
  const manifest = MB.buildGenerationManifestV3(locked, source, { activityTypeRules: 2 });
  return { plain, locked, source, manifest, errors: MB.validateGenerationManifestV3(manifest, locked, source) };
}

(async () => {
  // ── C1 ────────────────────────────────────────────────────────────────────
  await check('C1 tabla: procedimiento, protocolo y comunicación exigen video; decisión, normativo y conceptual son opcionales (en ese orden)', () => {
    const T = ST.VIDEO_NEED_BY_LEARNING_TYPE;
    eq(P.LEARNING_TYPES.map((t) => [t, T[t].need, T[t].ruleId]), [
      ['conceptual', 'optional', 'vid.optional.conceptual'], ['procedimental', 'demonstration', 'vid.need.demonstration'], ['protocolo', 'demonstration', 'vid.need.protocol'],
      ['decision_caso', 'optional', 'vid.optional.case'], ['comunicacion', 'modelling', 'vid.need.modelling'], ['normativo_etico', 'optional', 'vid.optional.normative'],
    ], 'tabla v1');
    eq([T.decision_caso.priority, T.normativo_etico.priority, T.conceptual.priority], [0, 1, 2], 'prioridad de los opcionales');
    eq(ST.VIDEO_COMPOSITION_RULES.hoursPerBudgetVideo, 5, 'presupuesto: 1 video cada 5 h');
    for (const t of P.LEARNING_TYPES) assert(T[t].text.length > 20, `texto para ${t}`);
  });

  await check('C1 precedencia: fijado > documento > mín/máx > «Ajustar» > necesidad > presupuesto de horas', () => {
    const chs = [ch('a', 0, 'conceptual'), ch('b', 1, 'procedimental'), ch('c', 2, 'decision_caso'), ch('d', 3, 'normativo_etico'), ch('e', 4, 'conceptual')];
    const base = { chapters: chs, targetHours: 10, audiovisual: null, documentVideo: null };
    // 10 h → presupuesto 2: el procedimiento (necesidad) + el caso (primer opcional).
    eq(dec(ST.decideVideosByNeed(base)), { a: '-:vid.optional.no_budget', b: 'V:vid.need.demonstration', c: 'V:vid.optional.hours_budget', d: '-:vid.optional.no_budget', e: '-:vid.optional.no_budget' }, 'necesidad + presupuesto');
    // 25 h → presupuesto 5: todos.
    eq(ST.decideVideosByNeed({ ...base, targetHours: 25 }).counts.videos, 5, 'presupuesto amplio');
    eq(dec(ST.decideVideosByNeed({ ...base, audiovisual: 'less' })).c, '-:vid.optional.less', '«Menos»: solo los que lo necesitan');
    eq(ST.decideVideosByNeed({ ...base, audiovisual: 'more' }).counts.videos, 5, '«Más»: todos');
    eq(dec(ST.decideVideosByNeed({ ...base, audiovisual: 'less' })).b, 'V:vid.need.demonstration', '«Menos» no quita la necesidad');
    // Mínimo y máximo explícitos.
    const mn = ST.decideVideosByNeed({ ...base, minVideos: 4 });
    eq([mn.counts.videos, dec(mn).d, dec(mn).a], [4, 'V:vid.min_videos', 'V:vid.min_videos'], 'mínimo: opcionales por prioridad (normativo, después conceptual por posición)');
    const mx = ST.decideVideosByNeed({ ...base, audiovisual: 'more', maxVideos: 2 });
    eq([mx.counts.videos, dec(mx).b, dec(mx).c], [2, 'V:vid.need.demonstration', 'V:vid.optional.more'], 'máximo: se quitan primero los opcionales de menor prioridad');
    const mx0 = ST.decideVideosByNeed({ ...base, maxVideos: 0 });
    eq([mx0.counts.videos, dec(mx0).b], [0, '-:vid.max_videos'], 'máximo 0 quita también la necesidad');
    // Mín/máx sobre «Ajustar».
    eq(ST.decideVideosByNeed({ ...base, audiovisual: 'less', minVideos: 3 }).counts.videos, 3, 'mínimo > «Menos»');
    // Documento > mín/máx y necesidad; fijado > documento.
    const doc = ST.decideVideosByNeed({ ...base, documentVideo: false, minVideos: 2 });
    eq([doc.counts.videos, dec(doc).b], [0, '-:vid.document'], 'documento sin videos manda');
    assert(doc.unmet.length === 1 && /al menos 2 videos/.test(doc.unmet[0]), 'mínimo incumplido a la vista');
    const pin = ST.decideVideosByNeed({ ...base, chapters: [ch('a', 0, 'conceptual', true), ch('b', 1, 'procedimental', false)], documentVideo: false });
    eq(dec(pin), { a: 'V:vid.pinned', b: '-:vid.pinned' }, 'fijado manda sobre documento y necesidad');
    const pinMax = ST.decideVideosByNeed({ ...base, chapters: [ch('a', 0, 'conceptual', true), ch('b', 1, 'conceptual', true)], maxVideos: 1 });
    eq([pinMax.counts.videos, pinMax.unmet.length], [2, 1], 'máximo no quita lo fijado (se informa)');
  });

  await check('C1 determinismo y errores (falla fuerte)', () => {
    const chs = [ch('x', 1, 'comunicacion'), ch('y', 0, 'decision_caso')];
    eq(ST.decideVideosByNeed({ chapters: chs, targetHours: 7, audiovisual: null, documentVideo: null }), ST.decideVideosByNeed({ chapters: [...chs].reverse(), targetHours: 7, audiovisual: null, documentVideo: null }), 'mismo resultado con otro orden de entrada');
    throwsRe(() => ST.decideVideosByNeed({ chapters: [ch('x', 0, 'otro')], targetHours: 7, audiovisual: null, documentVideo: null }), /VIDEO_COMPOSITION_INVALID: tipo de aprendizaje/, 'tipo desconocido');
    throwsRe(() => ST.decideVideosByNeed({ chapters: [], targetHours: 7, audiovisual: null, documentVideo: null, minVideos: 3, maxVideos: 2 }), /VIDEO_COMPOSITION_INVALID: minVideos/, 'mín > máx');
    throwsRe(() => ST.decideVideosByNeed({ chapters: [ch('x', 0, 'conceptual'), ch('x', 1, 'conceptual')], targetHours: 7, audiovisual: null, documentVideo: null }), /repetido/, 'id repetido');
    throwsRe(() => ST.decideVideosByNeed({ chapters: [], targetHours: 0, audiovisual: null, documentVideo: null }), /targetHours/, 'horas inválidas');
  });

  // ── C2 ────────────────────────────────────────────────────────────────────
  const v40 = {};
  await check('C2 40 h, misma forma 4 × 4: 8, 12 o 15 videos según las necesidades (motivo por capítulo)', () => {
    for (const fx of C.VIDEO_40H) {
      const s = C.structureOf(fx);
      for (const c of s.modules.flatMap((m) => m.chapters)) eq(P.classifyLearningType(c).type, c.expectedType, `${fx.id}: tipo de «${c.title}»`);
      const dr = dryRun(fx);
      const d = dr.distribution;
      v40[fx.id] = dr;
      eq(d.materialized.manifestErrors, [], `${fx.id}: Manifest materializado`);
      eq(d.counts.videoChapters, fx.expectVideos, `${fx.id}: videos`);
      eq(d.materialized.totals.videoCount, fx.expectVideos, `${fx.id}: videos del Manifest`);
      eq(d.composition.videos.hoursBudgetVideos, 8, `${fx.id}: presupuesto 40 / 5`);
      const cc = contentChapters(d);
      assert(cc.every((c) => c.videoDecision && /^vid\./.test(c.videoDecision.ruleId) && c.videoDecision.reason.length > 20), `${fx.id}: cada capítulo con su regla y motivo`);
      // La necesidad SIEMPRE lleva video (sin fijados ni documento ni máximo).
      assert(cc.filter((c) => c.videoDecision.need !== 'optional').every((c) => c.videoEnabled && c.videoDecision.ruleId.startsWith('vid.need.')), `${fx.id}: necesidad → video`);
      eq(d.composition.videos.counts.byNeed + d.composition.videos.counts.optional, fx.expectVideos, `${fx.id}: conteos de la composición`);
      assert(d.priorityTrace.some((t) => t.startsWith('Composición por necesidad')), `${fx.id}: traza visible`);
      assert(d.changes.filter((x) => x.type === 'set_video').every((x) => /\.$/.test(x.detail) && x.detail.split('. ').length >= 2), `${fx.id}: el cambio de video lleva su motivo`);
      eq([d.status, d.counts.contentChapters, d.counts.practiceChapters], ['within_tolerance', 16, 0], `${fx.id}: forma y horas`);
    }
    // need4: 4 por necesidad + 4 opcionales por presupuesto (decisión/caso primero).
    const n4 = contentChapters(v40['40h-need4'].distribution);
    // need4 tiene 2 capítulos de decisión/caso, 3 normativos y 7 conceptuales: el presupuesto (8 − 4) va a los 2 de
    // decisión y a los 2 primeros normativos; ningún conceptual.
    eq(n4.filter((c) => c.videoDecision.ruleId === 'vid.optional.hours_budget').map((c) => c.videoDecision.learningType).sort(), ['decision_caso', 'decision_caso', 'normativo_etico', 'normativo_etico'], 'opcionales por prioridad');
    assert(n4.filter((c) => c.videoDecision.learningType === 'conceptual').every((c) => !c.videoEnabled), 'need4: conceptuales sin video');
    // need12 / need15: los opcionales se quedan sin presupuesto.
    assert(contentChapters(v40['40h-need12'].distribution).filter((c) => c.videoDecision.need === 'optional').every((c) => !c.videoEnabled && c.videoDecision.ruleId === 'vid.optional.no_budget'), 'need12: opcionales sin presupuesto');
  });

  await check('C2 FinOps sale del Manifest: videogen.render = videos; el costo esperado crece con los videos; la propuesta cambia de huella', () => {
    const rows = C.VIDEO_40H.map((fx) => v40[fx.id].distribution);
    for (const [i, d] of rows.entries()) {
      eq(videogenOps(d.materialized.providers), C.VIDEO_40H[i].expectVideos, `${C.VIDEO_40H[i].id}: operaciones de video`);
      assert(d.materialized.providers.estimateUsd, 'estimado disponible');
    }
    const usd = rows.map((d) => Number(d.materialized.providers.estimateUsd.expected));
    assert(usd[0] < usd[1] && usd[1] < usd[2], `costo esperado creciente: ${usd.join(' < ')}`);
    assert(Number(rows[0].materialized.providers.byCategory.audiovisual) < Number(rows[2].materialized.providers.byCategory.audiovisual), 'audiovisual más caro con más videos');
    eq(new Set(rows.map((d) => d.proposalSha256)).size, 3, 'huellas distintas');
    // Sin composición, los tres cursos llevan los 16 videos del toggle (la composición era la única diferencia).
    for (const fx of C.VIDEO_40H) eq(dryRun(fx, { profileOpts: { composition: null } }).distribution.counts.videoChapters, 16, `${fx.id}: sin composición`);
  });

  await check('C2 restricciones explícitas del curso (mín/máx) y capítulo fijado, de punta a punta en el dry-run', () => {
    const fx = C.VIDEO_40H[1];
    const mx = dryRun(fx, { profile: C.profileOf(fx, { composition: { videos: 'by_need', maxVideos: 10 } }) }).distribution;
    eq([mx.counts.videoChapters, mx.composition.videos.maxVideos], [10, 10], 'máximo 10');
    eq(contentChapters(mx).filter((c) => c.videoDecision.ruleId === 'vid.max_videos').length, 2, 'dos quitados por el máximo');
    const mn = dryRun(C.VIDEO_40H[0], { profile: C.profileOf(C.VIDEO_40H[0], { composition: { videos: 'by_need', minVideos: 14 } }) }).distribution;
    eq(mn.counts.videoChapters, 14, 'mínimo 14');
    const first = contentChapters(mn)[0];
    const pinned = dryRun(fx, { pins: { [first.id]: { video: false } } }).distribution;
    const p0 = contentChapters(pinned)[0];
    eq([p0.videoEnabled, p0.videoDecision.ruleId, p0.videoPinned], [false, 'vid.pinned', true], 'fijado por el docente');
    // Requisito del documento «sin videos».
    const nov = dryRun(fx, { req: { ...FIXED, videosNone: true } }).distribution;
    eq([nov.counts.videoChapters, contentChapters(nov)[0].videoDecision.ruleId], [0, 'vid.document'], 'documento sin videos');
    // «Ajustar» audiovisual más / menos.
    eq(dryRun(fx, { profileOpts: { designPreferences: { audiovisual: 'more' } } }).distribution.counts.videoChapters, 16, '«Más»');
    eq(dryRun(C.VIDEO_40H[0], { profileOpts: { designPreferences: { audiovisual: 'less' } } }).distribution.counts.videoChapters, 4, '«Menos» (need4)');
  });

  // ── C3 ────────────────────────────────────────────────────────────────────
  await check('C3 mezcla de práctica: 4×4 → 9+7, 4×5 → 9+11, 3×4 → 7+5, 32 h 3×3 → 5+4, 96 h 4×6 → 10+14; formatos con práctica', () => {
    const plan = (s) => ST.planPracticeMix(s).modules.map((m) => `${m.content}+${m.practice}`).join(' ');
    eq(plan({ modules: 4, chaptersPerModule: 4, practiceTotal: 7 }), '3+1 2+2 2+2 2+2', '4×4 · 7 prácticas');
    eq(plan({ modules: 4, chaptersPerModule: 4, audiovisualTotal: 9 }), '3+1 2+2 2+2 2+2', '4×4 · 9 audiovisuales (equivalente)');
    eq(plan({ modules: 4, chaptersPerModule: 5, practiceTotal: 11 }), '3+2 2+3 2+3 2+3', '4×5 · 11 prácticas');
    eq(plan({ modules: 3, chaptersPerModule: 4, practiceTotal: 5 }), '3+1 2+2 2+2', '3×4 · 5 prácticas');
    eq(plan({ modules: 3, chaptersPerModule: 3, practiceTotal: 4 }), '2+1 2+1 1+2', '3×3 · 4 prácticas');
    eq(plan({ modules: 4, chaptersPerModule: 6, practiceTotal: 14 }), '3+3 3+3 2+4 2+4', '4×6 · 14 prácticas');
    eq(plan({ format: 'M', practicePerModule: 1 }), '4+1 4+1 4+1', 'M + 1 práctica por módulo');
    eq(plan({ format: 'L', practiceTotal: 6 }), '5+1 5+1 5+2 5+2', 'L + 6 prácticas (al final)');
    eq(plan({ format: 'S', practicePerModule: 0 }), '3+0 3+0 3+0', 'S sin práctica');
    const p = ST.planPracticeMix({ modules: 4, chaptersPerModule: 5, practiceTotal: 11 });
    eq([p.contentTotal, p.practiceTotal, p.chaptersTotal, p.ruleId], [9, 11, 20, 'mix.front_loaded_content'], 'totales');
    const c = ST.practiceMixConstraints(p);
    eq([c.noContentAdditions, c.practiceByModule, c.practiceTotal, c.chaptersPerModule], [true, [2, 3, 3, 3], { min: 11, max: 11 }, { min: 5, max: 5 }], 'restricciones del distribuidor');
  });

  await check('C3 validación: combinaciones inválidas fallan fuerte con mensaje', () => {
    const bad = [
      [{ modules: 4, chaptersPerModule: 4, practiceTotal: 13 }, /al menos un capítulo audiovisual/],
      [{ modules: 4, chaptersPerModule: 4 }, /practiceTotal o audiovisualTotal/],
      [{ modules: 4, chaptersPerModule: 4, practiceTotal: 7, audiovisualTotal: 9 }, /uno solo/],
      [{ format: 'M' }, /practicePerModule o practiceTotal/],
      [{ format: 'X', practicePerModule: 1 }, /formato desconocido/],
      [{ format: 'M', modules: 3, practicePerModule: 1 }, /la forma la fija el formato/],
      [{ modules: 3, chaptersPerModule: 4, practicePerModule: 1 }, /no practicePerModule/],
      [{ modules: 0, chaptersPerModule: 4, practiceTotal: 1 }, /modules debe ser/],
      [{ modules: 2, chaptersPerModule: 4, practiceTotal: 1, extra: 1 }, /campo desconocido/],
      [{ modules: 2, chaptersPerModule: 4, audiovisualTotal: 9 }, /no caben/],
      [{ format: 'L', practicePerModule: 26 }, /más de 30 capítulos/],
    ];
    for (const [spec, re] of bad) throwsRe(() => ST.planPracticeMix(spec), re, JSON.stringify(spec));
  });

  await check('C3 en el diseño: práctica exacta por módulo; el documento manda; forma distinta → no se aplica (a la vista)', () => {
    const fx = C.COURSES.find((x) => x.id === '4x5-9+11');
    const d = dryRun(fx).distribution;
    eq(d.practiceMix.status, 'applied', 'aplicada');
    eq(d.modules.map((m) => m.chapters.filter((c) => c.kind === 'practice').length), [2, 3, 3, 3], 'prácticas por módulo');
    eq(d.modules.map((m) => m.chapters.length), [5, 5, 5, 5], '5 capítulos por módulo');
    const titles = d.modules.flatMap((m) => m.chapters.filter((c) => c.kind === 'practice').map((c) => c.title));
    eq(new Set(titles).size, titles.length, 'títulos de práctica distintos');
    assert(d.changes.filter((x) => x.type === 'add_practice_chapter').every((x) => /mezcla de práctica/.test(x.detail)), 'el motivo cita la mezcla, no el documento');
    // El documento fija la práctica: manda.
    const doc = dryRun(fx, { req: { ...FIXED, practicePerModule: { min: 1, max: 1 }, sources: { practice: 'req-p' } } }).distribution;
    eq([doc.practiceMix.status, doc.counts.practiceChapters], ['document_wins', 4], 'documento manda');
    // Forma de contenidos distinta (4 × 4 de contenido contra 3+2+2+2): no se aplica.
    const wrong = dryRun(fx, { structure: C.plainStructure(C.structureOf({ ...fx, modules: ['PCDC', 'RKCN', 'NPCD', 'DCPR'] })) }).distribution;
    eq(wrong.practiceMix.status, 'structure_mismatch', 'forma distinta');
    assert(wrong.practiceMix.notes.some((n) => /Módulo 1: la mezcla pide 3/.test(n)), 'qué cambiar');
    eq(wrong.practiceMix.fit.expectedContentShape, [3, 2, 2, 2], 'forma esperada');
  });

  // ── C4 ────────────────────────────────────────────────────────────────────
  await check('C4 punto fijo: aplicar el diseño y recalcular no propone videos ni capítulos nuevos', () => {
    for (const fx of [...C.VIDEO_40H, ...C.COURSES]) {
      const s = C.plainStructure(C.structureOf(fx));
      const profile = C.profileOf(fx);
      const d = dryRun(fx, { structure: s, profile }).distribution;
      const m = materialize(fx, profile, d, s);
      eq(m.errors, [], `${fx.id}: Manifest`);
      eq(snap.snapshotSha256V2(m.locked), d.materialized.blueprintSha256, `${fx.id}: misma materialización que el dry-run`);
      const again = P.runPedagogyDryRun({ structure: m.plain, profile, activityTypeRules: 2, requirementConstraints: FIXED }).distribution;
      const structural = again.changes.filter((x) => ['add_practice_chapter', 'add_content_chapter', 'set_video'].includes(x.type));
      eq(structural.map((x) => x.detail), [], `${fx.id}: sin cambios de estructura ni de video`);
      eq(again.counts.videoChapters, d.counts.videoChapters, `${fx.id}: mismos videos`);
      const vid = (x) => x.modules.flatMap((mm) => mm.chapters.map((c) => `${c.title}:${c.videoEnabled ? 1 : 0}`));
      eq(vid(again), vid(d), `${fx.id}: mismo video por capítulo`);
    }
  });

  // ── C5 ────────────────────────────────────────────────────────────────────
  const sig = {};
  await check('C5 S/M/L + 4×4, 4×5, 3×4, 32 h y 96 h: formato → Prebrief → Blueprint → distribuidor → Manifest → artifacts → .mbz válido', async () => {
    for (const fx of C.COURSES) {
      // Formato: «¿Cómo quieres estructurar tu curso?» recomienda la forma del formato para esas horas.
      if (fx.format) {
        const rec = SO.recommendShape([], null, fx.targetHours);
        const f = CF.COURSE_FORMATS[fx.format];
        eq([rec.modules, rec.chaptersPerModule], [f.modules, f.chaptersPerModule], `${fx.id}: forma recomendada`);
        eq(fx.modules.map((x) => x.length), Array(f.modules).fill(f.chaptersPerModule), `${fx.id}: estructura con la forma del formato`);
      }
      const s = C.plainStructure(C.structureOf(fx));
      const profile = C.profileOf(fx);
      const dr = dryRun(fx, { structure: s, profile });
      const d = dr.distribution;
      eq(d.materialized.manifestErrors, [], `${fx.id}: Manifest materializado sin errores`);
      if (fx.practiceMix) eq(d.practiceMix.status, 'applied', `${fx.id}: mezcla aplicada`);
      eq([d.counts.modules, d.counts.contentChapters, d.counts.practiceChapters], [fx.expect.modules, fx.expect.content, fx.expect.practice], `${fx.id}: módulos / contenido / práctica`);
      if (fx.expect.practiceByModule) eq(d.modules.map((m) => m.chapters.filter((c) => c.kind === 'practice').length), fx.expect.practiceByModule, `${fx.id}: práctica por módulo`);
      // Horas: el distribuidor y el Manifest materializado dan las mismas (modelo de tiempo); dentro de la tolerancia o
      // declarado («no alcanza», nunca relleno mudo).
      eq(d.materialized.generableHours, d.estimatedHours, `${fx.id}: horas distribuidor = Manifest`);
      if (d.status === 'within_tolerance') assert(Math.abs(d.estimatedHours - fx.targetHours) <= d.toleranceHours + 1e-9, `${fx.id}: dentro de la tolerancia`);
      else {
        eq(d.status, 'cannot_reach_target', `${fx.id}: estado`);
        assert(d.recommendations.some((r) => /No alcanza/.test(r)), `${fx.id}: lo dice`);
      }
      // Prebrief: la misma tarjeta que ve la institución (diseño + totales del Manifest).
      const inp = prebriefFixture({ format: fx.format || null, targetHours: fx.targetHours });
      inp.card.hours = { target: fx.targetHours, source: 'user' };
      inp.card.design = {
        status: d.status, estimatedHours: d.estimatedHours, baseHours: d.baseHours, applicable: true, changes: [],
        counts: { modules: d.counts.modules, chapters: d.counts.chapters, evaluations: d.counts.evaluations },
        modules: d.modules.map((m) => ({ id: m.id, title: m.title, examEnabled: m.examEnabled, chapters: m.chapters.map((c) => ({ ...c, hours: c.targetMinutes / 60, outcomeIds: ['RA1'] })) })),
      };
      inp.card.manifestTotals = { ...d.materialized.totals };
      const pb = PM.buildPrebriefModel(inp, RA.actualText, RA.requirementText);
      eq([pb.structure.totals.contentChapters, pb.structure.totals.practiceChapters, pb.resources.videos, pb.resources.applicationActivities, pb.resources.moduleExams], [fx.expect.content, fx.expect.practice, d.counts.videoChapters, d.counts.applicationActivities, fx.expect.modules], `${fx.id}: Prebrief`);
      eq(pb.structure.totals.hours, d.estimatedHours, `${fx.id}: horas del Prebrief`);
      if (fx.format) assert(pb.duration.format && pb.duration.format.code === fx.format, `${fx.id}: formato en el Prebrief`);
      // Blueprint + Manifest (lo que congelaría el lock).
      const m = materialize(fx, profile, d, s);
      eq(m.errors, [], `${fx.id}: Manifest`);
      eq(snap.snapshotSha256V2(m.locked), d.materialized.blueprintSha256, `${fx.id}: Blueprint = el del dry-run`);
      const t = m.manifest.totals;
      eq([t.videoCount, t.activityCount, t.applicationActivityCount, t.examCount], [d.counts.videoChapters, d.counts.activities, d.counts.applicationActivities, fx.expect.modules], `${fx.id}: totales del Manifest`);
      eq(videogenOps(d.materialized.providers), t.videoCount, `${fx.id}: FinOps = videos del Manifest`);
      // Artifacts simulados (proveedores falsos de los checks de empaque) + bancos de examen del tamaño del plan.
      const input = PF.packagingInput(distRoot, { snapshot: m.locked, manifest: m.manifest, engine: 'h5p', finalExam: true });
      const planned = {};
      for (const mod of m.manifest.modules) {
        const n = mod.chapters.filter((c) => c.kind !== 'practice').length;
        planned[mod.moduleId] = EB.examSlotSplit(n);
        input.contents.examGift.set(mod.moduleId, C.giftOf(`M${mod.moduleNumber}`, planned[mod.moduleId]));
      }
      const finalSplit = EB.finalExamSlotSplit(fx.expect.content);
      input.contents.finalExamGift = C.giftOf('F', finalSplit);
      const r = await B.buildDynamicMbzV3(input);
      const v = await VAL.validateMbzV3(r.mbz, r.expectations);
      assert(v.ok, `${fx.id}: paquete válido ${JSON.stringify(v.issues.slice(0, 3))}`);
      const f = r.expectations.facts;
      eq([f.counts.modules, f.counts.chapters, f.counts.videos, f.counts.activities, f.counts.applicationActivities, f.counts.exams, f.counts.finalExam],
        [fx.expect.modules, fx.expect.content + fx.expect.practice, t.videoCount, t.activityCount, t.applicationActivityCount, fx.expect.modules, true], `${fx.id}: conteos del paquete`);
      eq(f.modules.map((x) => x.examQuestionCount), m.manifest.modules.map((mod) => planned[mod.moduleId].total), `${fx.id}: preguntas por examen de módulo`);
      eq(f.finalExam.questionCount, finalSplit.total, `${fx.id}: preguntas del final`);
      const libs = (r.summary.h5pPackages || []).map((p) => p.mainLibrary);
      const iv = libs.filter((l) => l === 'H5P.InteractiveVideo').length;
      eq(iv, t.videoCount, `${fx.id}: H5P de video interactivo = videos`);
      assert(f.studyTime && f.studyTime.courseEstimatedHours > 0, `${fx.id}: studyTime en el paquete`);
      sig[fx.id] = {
        modules: fx.expect.modules, chapters: f.counts.chapters, content: fx.expect.content, practice: fx.expect.practice, videos: t.videoCount,
        h5p: libs.length, activities: t.activityCount, application: t.applicationActivityCount, guided: t.guidedPracticeCount || 0,
        exams: f.counts.exams + 1, questions: f.modules.reduce((n, x) => n + x.examQuestionCount, 0) + f.finalExam.questionCount,
        hours: d.estimatedHours, status: d.status, usd: Number(d.materialized.providers.estimateUsd.expected),
      };
    }
    console.log('   ' + Object.entries(sig).map(([k, s]) => `${k}: ${s.modules}m ${s.content}+${s.practice}c ${s.videos}v ${s.h5p}h5p ${s.application}AA ${s.guided}EG ${s.exams}ex/${s.questions}p ${s.hours}h ${s.status === 'within_tolerance' ? 'ok' : 'NO ALCANZA'} USD ${s.usd.toFixed(2)}`).join('\n   '));
  });

  // ── C6 ────────────────────────────────────────────────────────────────────
  await check('C6 S, M y L no salen casi iguales: difieren en ≥ 6 dimensiones y en ≥ 15 h; las formas de práctica también', () => {
    const dims = ['modules', 'chapters', 'content', 'practice', 'videos', 'h5p', 'activities', 'application', 'questions', 'hours'];
    const diff = (a, b) => dims.filter((k) => sig[a][k] !== sig[b][k]);
    for (const [a, b] of [['S', 'M'], ['M', 'L'], ['S', 'L']]) {
      assert(sig[a] && sig[b], 'C5 corrió');
      const dd = diff(a, b);
      assert(dd.length >= 6, `${a} vs ${b}: solo difieren en ${dd.join(', ')}`);
      assert(Math.abs(sig[a].hours - sig[b].hours) >= 15, `${a} vs ${b}: horas ${sig[a].hours} / ${sig[b].hours}`);
      assert(sig[a].usd < sig[b].usd, `${a} cuesta menos que ${b}`);
    }
    assert(sig.S.videos < sig.M.videos && sig.M.videos < sig.L.videos, 'videos crecen S < M < L');
    assert(sig.S.questions < sig.M.questions && sig.M.questions < sig.L.questions, 'preguntas crecen S < M < L');
    // Las formas de propuesta: más práctica que contenido donde se pidió, y distintas entre sí.
    assert(sig['4x5-9+11'].practice > sig['4x5-9+11'].content && sig['4x4-9+7'].practice < sig['4x4-9+7'].content, 'proporción de práctica');
    const shapes = ['4x4-9+7', '4x5-9+11', '3x4-7+5', '32h-3x3-5+4', '96h-4x6-10+14'];
    for (const a of shapes) for (const b of shapes) if (a < b) assert(diff(a, b).length >= 3, `${a} vs ${b}: casi iguales (${diff(a, b).join(', ')})`);
    // Guarda del propio check: si todo saliera igual (p. ej. composición uniforme), la función de diferencia lo ve.
    eq(diff('S', 'S'), [], 'diff reflexivo');
  });

  // ── C7 ────────────────────────────────────────────────────────────────────
  await check('C7 perfil: composition validada con códigos; normalización estable; videos «by_need» requerido para mín/máx', () => {
    const fx = C.VIDEO_40H[0];
    const errs = (composition) => P.validatePedagogicalProfile(C.profileOf(fx, { composition })).map((e) => e.code);
    eq(errs({ videos: 'by_need', minVideos: 3, maxVideos: 9 }), [], 'válida');
    assert(errs({ videos: 'siempre' }).includes('INVALID_OPTION'), 'modo inválido');
    assert(errs({ minVideos: 2 }).includes('COMPOSITION_REQUIRES_BY_NEED'), 'mín sin by_need');
    assert(errs({ videos: 'by_need', minVideos: 5, maxVideos: 2 }).includes('COMPOSITION_MIN_ABOVE_MAX'), 'mín > máx');
    assert(errs({ videos: 'by_need', maxVideos: -1 }).includes('INVALID_NUMBER'), 'negativo');
    assert(errs({ videos: 'by_need', otra: 1 }).includes('UNKNOWN_FIELD'), 'campo desconocido');
    assert(errs({ practiceMix: { modules: 4, chaptersPerModule: 4 } }).includes('PRACTICE_MIX_INVALID'), 'mezcla inválida');
    const a = P.normalizePedagogicalProfile(C.profileOf(fx, { composition: { maxVideos: 9, practiceMix: { practiceTotal: 7, chaptersPerModule: 4, modules: 4 }, videos: 'by_need' } }));
    eq(Object.keys(a.learningPlan.composition), ['videos', 'maxVideos', 'practiceMix'], 'orden de claves');
    eq(Object.keys(a.learningPlan.composition.practiceMix), ['modules', 'chaptersPerModule', 'practiceTotal'], 'orden de la mezcla');
    // composition vacía = sin clave (perfil de siempre).
    const e = P.normalizePedagogicalProfile(C.profileOf(fx, { composition: {} }));
    eq('composition' in e.learningPlan, false, 'vacía se descarta');
    eq(P.pedagogicalProfileSha256(e), P.pedagogicalProfileSha256(P.normalizePedagogicalProfile(C.profileOf(fx, { composition: null }))), 'misma huella sin composición');
  });

  // ── C8 ────────────────────────────────────────────────────────────────────
  await check(`C8 compatibilidad: sin composition, dry-run byte a byte el de antes (${Object.keys(GOLDEN.digests).length} huellas, ${GOLDEN.computedWith})`, () => {
    const now = goldenDigests(distRoot);
    const bad = Object.keys(GOLDEN.digests).filter((k) => now[k] !== GOLDEN.digests[k]);
    eq(bad, [], 'huellas distintas');
    eq(Object.keys(now).sort(), Object.keys(GOLDEN.digests).sort(), 'mismo conjunto');
  });

  console.log(`\n${passed} OK · ${failed} con fallas`);
  process.exit(failed ? 1 : 0);
})();
