#!/usr/bin/env node
/* eslint-disable no-console */
// Motor de carga horaria — Loop 3: distribuidor de horas (src/modules/study-time/distributor.ts).
//
//   D1  20 / 33 / 50 h (competencias, RCP con «Repaso»): tres diseños distintos cerca del baseline de la Fase 0
//   D2  8 h: la estructura mínima supera el objetivo → informa y propone reducir; NO recorta nada
//   D3  80 h: no alcanza con topes razonables → propone módulos / capítulos; NO infla tiempos
//   D4  sin perfil (política neutra) y perfil vacío → mismo resultado; nunca falla
//   D5  cada enfoque existente: política según las dimensiones del motor pedagógico (sin segundo motor);
//       competencias → práctica antes que profundidad; significativo → profundidad antes que práctica
//   D6  tolerancia configurable (±5 % o ±1 h por defecto) y respetada en el estado
//   D7  determinista; los minutos los pone el modelo de tiempo (suma por capítulo = total)
//   D8  las horas generables HOY no cuentan las Actividades de aplicación (Fase 2)
//   D9  prioridad: targetHours manda sobre la estructura del enfoque, pero solo PROPONE (no toca el Blueprint)
//   D10 límites: ningún capítulo > 240 min; ≤ 5 capítulos de contenido por módulo; aplicación ≤ tope del enfoque
//   D11 reordenar capítulos y cambiar targetHours: el resultado se recalcula sin estado oculto
//   D12 dry-run pedagógico: `distribution` con objetivo; null sin objetivo (salida de siempre)
//   D13 adversos: Blueprint vacío, módulo sin capítulos, targetHours inválido, tolerancia absurda
//
// Uso: node scripts/check-distributor.js [path/to/dist]   (después de npm run build)
'use strict';
const path = require('path');

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
const ST = loadDist('modules/study-time/index.js');
const P = loadDist('modules/pedagogy/index.js');
const SNAP = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const RCP = require('./fixtures/pedagogy/rcp-course.json');
const PF = require('./fixtures/pedagogy/profiles.json');

let passes = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
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
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m}: esperado ${B}, encontrado ${A}`);
}
function near(a, b, tol, m) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m}: esperado ${b} ± ${tol}, encontrado ${a}`);
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
const profileOf = (k, extra = {}) => ({
  pedagogyProfileVersion: 1, primaryApproach: PF.profiles[k].primaryApproach, secondaryApproaches: PF.profiles[k].secondaryApproaches,
  learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', ...extra,
});
const rcp = (() => { const s = clone(RCP); s.course.reviewCards = true; return s; })();
const snapOf = (s = rcp) => P.snapshotFromStructure(clone(s));
const rulesOf = (k) => (k ? P.deriveDesignRules(profileOf(k)) : null);
const dist = (h, k = 'competencias', extra = {}) => ST.distributeCourseHours({ snapshot: snapOf(extra.structure), rules: rulesOf(k), targetHours: h, ...extra.opts });
const chapters = (r) => r.modules.flatMap((m) => m.chapters);
const snapshotSha = (s) => SNAP.snapshotSha256V2(s);

check('D1 20 / 33 / 50 h: tres diseños distintos cerca del baseline de la Fase 0', () => {
  const rows = [];
  const base = { 20: { h: 19.1, ch: 9, video: 9, practice: 0 }, 33: { h: 31.8, ch: 11, video: 9, practice: 2 }, 50: { h: 48.6, ch: 19, video: 13, practice: 6 } };
  const sig = new Set();
  for (const h of [20, 33, 50]) {
    const r = dist(h);
    eq(r.status, 'within_tolerance', `${h} h: estado`);
    near(r.estimatedHours, h, r.toleranceHours, `${h} h dentro de la tolerancia`);
    near(r.estimatedHours, base[h].h, 0.3, `${h} h ≈ baseline Fase 0`);
    eq([r.counts.chapters, r.counts.videoChapters, r.counts.practiceChapters], [base[h].ch, base[h].video, base[h].practice], `${h} h: capítulos / videos / práctica`);
    eq([r.dryRun, r.providersCalled], [true, 0], 'sin proveedores');
    sig.add(JSON.stringify(r.counts));
    rows.push(`${h} h → ${r.estimatedHours} h (generable hoy ${r.generableHours} h) · ${r.counts.chapters} cap. (${r.counts.videoChapters} con video, ${r.counts.practiceChapters} de práctica) · aplicación ${r.counts.applicationMinutes} min`);
  }
  eq(sig.size, 3, 'tres diseños diferentes');
  console.log(`   ${rows.join('\n   ')}`);
});

check('D2 8 h: la estructura mínima supera el objetivo → informa y propone, sin recortar', () => {
  const r = dist(8);
  eq(r.status, 'minimum_exceeds_target', 'estado');
  assert(r.recommendations[0].includes('La estructura mínima actual supera la carga horaria objetivo'), r.recommendations[0]);
  assert(/quitar unos \d+ capítulo/.test(r.recommendations[1]) && /decisión del docente/.test(r.recommendations[1]), r.recommendations[1]);
  eq(r.changes, [], 'ningún cambio');
  eq([r.counts.chapters, r.counts.applicationActivities], [9, 0], 'la estructura queda igual');
  eq(r.estimatedHours, r.baseHours, 'no inventa ni quita horas');
});

check('D3 80 h: no alcanza con topes razonables → propone módulos/capítulos, no infla', () => {
  const r = dist(80);
  eq(r.status, 'cannot_reach_target', 'estado');
  assert(r.estimatedHours < 80 - r.toleranceHours, `no llega (${r.estimatedHours})`);
  assert(/No alcanza 80 h sin rellenar/.test(r.recommendations[0]) && /módulo\(s\) nuevo\(s\)/.test(r.recommendations[1]), r.recommendations.join(' | '));
  for (const m of r.modules) assert(m.chapters.filter((c) => c.kind === 'content').length <= ST.DISTRIBUTOR_RULES.maxContentChaptersPerModule, 'tope de contenido');
  // Nada inflado: cada recurso sale del modelo de tiempo con valores planificados (ningún «medido» inventado).
  for (const c of r.studyTime.modules.flatMap((m) => m.chapters)) assert(c.resources.every((x) => !x.measured), 'sin medidas inventadas');
  eq(r.studyTime.modules.length, 3, 'no agrega módulos solo: los recomienda');
});

check('D4 sin perfil (neutra) y perfil vacío: mismo resultado, sin fallar', () => {
  const a = dist(33, null);
  const b = ST.distributeCourseHours({ snapshot: snapOf(), rules: P.deriveDesignRulesOrNull ? P.deriveDesignRulesOrNull(P.emptyPedagogicalProfile()) : null, targetHours: 33 });
  eq(a.policy.kind, 'application_first', 'neutra = aplicación primero (igual que la Fase 0)');
  eq(a.policy.weights, null, 'sin pesos');
  eq(b.counts, a.counts, 'perfil vacío = sin perfil');
  eq(a.status, 'within_tolerance', 'alcanza');
});

check('D5 cada enfoque: política desde las dimensiones del motor; competencias → práctica; significativo → profundidad', () => {
  const kinds = {};
  for (const k of Object.keys(PF.profiles)) {
    const r = dist(50, k);
    kinds[k] = r.policy.kind;
    assert(['within_tolerance', 'cannot_reach_target', 'above_tolerance'].includes(r.status), `${k}: ${r.status}`);
    eq(r.policy.weights.application >= r.policy.weights.depth, r.policy.kind === 'application_first', `${k}: la política sale de los pesos`);
  }
  eq(kinds.competencias, 'application_first', 'competencias');
  eq(kinds.significativo, 'depth_first', 'significativo');
  const c = dist(50, 'competencias');
  const s = dist(50, 'significativo');
  assert(c.counts.practiceChapters > s.counts.practiceChapters, `competencias más práctica (${c.counts.practiceChapters} vs ${s.counts.practiceChapters})`);
  assert(s.counts.contentChapters > c.counts.contentChapters, `significativo más profundidad (${s.counts.contentChapters} vs ${c.counts.contentChapters})`);
  const firstAdd = (r) => (r.changes.find((x) => x.type.startsWith('add_')) || {}).type;
  eq([firstAdd(c), firstAdd(s)], ['add_practice_chapter', 'add_content_chapter'], 'orden de crecimiento');
  assert(s.recommendations.length > 0 && s.status === 'cannot_reach_target', 'significativo 50 h: no rellena con práctica, recomienda');
});

check('D6 tolerancia configurable', () => {
  eq(dist(33).toleranceHours, 1.7, '5 % de 33 h');
  eq(dist(20).toleranceHours, 1, 'mínimo 1 h');
  const tight = dist(33, 'competencias', { opts: { tolerance: { pct: 0, minHours: 0.1 } } });
  eq(tight.toleranceHours, 0.1, 'tolerancia ajustada');
  assert(tight.status !== 'within_tolerance' || Math.abs(tight.estimatedHours - 33) <= 0.1, `con ±0,1 h: ${tight.status} ${tight.estimatedHours}`);
  const wide = dist(33, 'competencias', { opts: { tolerance: { pct: 0.3 } } });
  eq(wide.status, 'within_tolerance', 'tolerancia amplia');
  assert(wide.counts.chapters <= dist(33).counts.chapters, 'con más tolerancia no crece más');
});

check('D7 determinista; los minutos son los del modelo de tiempo', () => {
  const a = dist(50);
  const b = dist(50);
  eq(a, b, 'misma entrada → mismo resultado');
  for (const m of a.modules) for (const c of m.chapters) {
    const sc = a.studyTime.modules.flatMap((x) => x.chapters).find((x) => x.chapterId === c.id);
    eq(c.targetMinutes, sc.chapterEstimatedMinutes, `capítulo ${c.id}: minutos del modelo`);
  }
  near(a.studyTime.courseEstimatedMinutes / 60, a.estimatedHours, 0.05, 'total');
});

check('D8 horas generables HOY = diseño sin Actividades de aplicación (Fase 2)', () => {
  const r = dist(33);
  near(r.estimatedHours - r.generableHours, r.counts.applicationMinutes / 60, 0.1, 'la diferencia es exactamente la aplicación');
  for (const c of chapters(r)) near(c.targetMinutes - c.generableMinutes, c.applicationMinutes || 0, 0.01, `capítulo ${c.id}`);
  eq(r.baseHours, dist(20).baseHours, 'base igual para cualquier objetivo');
});

check('D9 prioridad: targetHours manda pero solo PROPONE (el Blueprint no cambia)', () => {
  const snap = snapOf();
  const sha = snapshotSha(snap);
  const r = ST.distributeCourseHours({ snapshot: snap, rules: rulesOf('competencias'), targetHours: 50 });
  eq(snapshotSha(snap), sha, 'el snapshot de entrada no se toca');
  assert(r.priorityTrace[0].includes('restricción del curso') && r.priorityTrace[0].includes('propuestas'), r.priorityTrace[0]);
  assert(r.changes.filter((x) => x.type.startsWith('add_')).every((x) => x.chapterId.startsWith('proposed:')), 'capítulos nuevos marcados como propuesta');
  assert(chapters(r).filter((c) => c.proposed).every((c) => c.id.startsWith('proposed:')), 'ids de propuesta');
  // Pedagogía recomienda 9 capítulos (estructura del docente); 50 h necesita 19: manda el objetivo del curso.
  eq(snap.modules.flatMap((m) => m.chapters).length, 9, 'estructura del docente');
  assert(r.counts.chapters > 9, 'el objetivo exige más capítulos');
});

check('D10 límites: ≤ 240 min por capítulo, ≤ 5 de contenido por módulo, aplicación ≤ tope del enfoque', () => {
  for (const k of ['competencias', 'significativo', null]) for (const h of [20, 33, 50, 80]) {
    const r = dist(h, k);
    for (const c of chapters(r)) assert(c.targetMinutes <= ST.DISTRIBUTOR_RULES.maxChapterMinutes, `${k}/${h}: ${c.id} ${c.targetMinutes} min`);
    for (const m of r.modules) assert(m.chapters.filter((c) => c.kind === 'content').length <= 5, `${k}/${h}: contenido por módulo`);
    for (const c of chapters(r)) {
      const cap = c.kind === 'practice' || c.role === 'module_closing' ? r.policy.closingTierMax : r.policy.contentTierMax;
      assert(c.applicationMinutes === null || (c.applicationMinutes <= cap && ST.STUDY_TIME_RULES.applicationActivityTiers.includes(c.applicationMinutes)), `${k}/${h}: nivel ${c.applicationMinutes} de ${c.id}`);
    }
    for (const c of chapters(r).filter((x) => x.kind === 'practice')) eq([c.videoEnabled, c.activityEnabled], [false, true], 'práctica sin video, con actividad');
  }
});

check('D11 reordenar capítulos y cambiar targetHours: se recalcula sin estado oculto', () => {
  const re = clone(rcp);
  re.modules[0].chapters.reverse();
  const a = dist(33);
  const b = dist(33, 'competencias', { structure: re });
  eq([b.estimatedHours, b.counts], [a.estimatedHours, a.counts], 'mismas horas y conteos');
  eq(b.modules[0].chapters.filter((c) => !c.proposed).map((c) => c.id), re.modules[0].chapters.map((c) => c.id), 'respeta el nuevo orden');
  eq([dist(20).counts.chapters, dist(50).counts.chapters, dist(20).counts.chapters], [9, 19, 9], 'cambiar el objetivo recalcula');
});

check('D12 dry-run pedagógico: distribution con objetivo; null sin objetivo', () => {
  const none = P.runPedagogyDryRun({ structure: clone(rcp), profile: profileOf('competencias') });
  eq(none.distribution, null, 'sin objetivo');
  const withT = P.runPedagogyDryRun({ structure: clone(rcp), profile: profileOf('competencias', { targetHours: 33 }) });
  eq([withT.distribution.status, withT.distribution.targetHours], ['within_tolerance', 33], 'con objetivo');
  eq(withT.pedagogical.blueprint.modules.flatMap((m) => m.chapters).length, 9, 'el dry-run no aplica la propuesta');
  const empty = P.runPedagogyDryRun({ structure: clone(rcp), profile: { ...P.emptyPedagogicalProfile(), targetHours: 20 } });
  eq([empty.distribution.policy.kind, empty.distribution.status], ['application_first', 'within_tolerance'], 'sin enfoque con objetivo');
});

check('D13 adversos', () => {
  const s = snapOf();
  for (const bad of [0, -1, 7.25, NaN, '33', null, undefined, 501]) throwsRe(() => ST.distributeCourseHours({ snapshot: s, rules: null, targetHours: bad }), /DISTRIBUTOR_INPUT_INVALID: targetHours/, `targetHours ${String(bad)}`);
  throwsRe(() => ST.distributeCourseHours({ snapshot: { ...s, modules: [] }, rules: null, targetHours: 20 }), /al menos un módulo/, 'sin módulos');
  throwsRe(() => ST.distributeCourseHours({ snapshot: { ...s, modules: [{ ...s.modules[0], chapters: [] }] }, rules: null, targetHours: 20 }), /al menos un capítulo/, 'módulo vacío');
  throwsRe(() => ST.distributeCourseHours({ snapshot: s, rules: null, targetHours: 20, tolerance: { pct: 2 } }), /tolerancia/, 'tolerancia absurda');
  throwsRe(() => ST.distributeCourseHours({ snapshot: s, rules: null, targetHours: 20, activityTypeRules: 3 }), /activityTypeRules/, 'reglas de actividad');
  throwsRe(() => ST.distributeCourseHours(null), /Blueprint v2/, 'sin entrada');
  // Un curso de 1 módulo × 1 capítulo con 500 h: recomienda, no se cuelga ni rellena.
  const tiny = P.snapshotFromStructure({ course: { title: 'x', reviewCards: true }, modules: [{ title: 'M', chapters: [{ title: 'C' }] }] });
  const r = ST.distributeCourseHours({ snapshot: tiny, rules: null, targetHours: 500 });
  eq(r.status, 'cannot_reach_target', '500 h en 1×1');
  assert(r.counts.chapters <= 1 + 5 + 2, 'topes respetados');
});

console.log(`\n${passes} OK, ${failures} fallidas`);
process.exit(failures ? 1 : 0);
