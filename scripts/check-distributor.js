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
//   D8  Fase 2: las Actividades de Aplicación se generan (horas generables = horas del diseño)
//   D9  prioridad: targetHours manda sobre la estructura del enfoque, pero solo PROPONE (no toca el Blueprint)
//   D10 límites: ningún capítulo > 240 min; ≤ 5 capítulos de contenido por módulo; aplicación ≤ tope del enfoque
//   D11 reordenar capítulos y cambiar targetHours: el resultado se recalcula sin estado oculto
//   D12 dry-run pedagógico: `distribution` con objetivo; null sin objetivo (salida de siempre)
//   D13 adversos: Blueprint vacío, módulo sin capítulos, targetHours inválido, tolerancia absurda
//   D18 LOOP 7 (A1): re-proponer sobre un diseño aplicado nunca quita la Actividad de las prácticas y converge
//       (punto fijo); «Ninguna» → «auto» sobre un diseño aplicado devuelve la actividad a las prácticas
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
  // Con minutos exactos (las horas redondeadas a 1 decimal no sirven para ±0,1 h).
  assert(tight.status !== 'within_tolerance' || Math.abs(tight.studyTime.courseEstimatedMinutes - 33 * 60) <= 6 + 1e-9, `con ±0,1 h: ${tight.status} ${tight.studyTime.courseEstimatedMinutes} min`);
  // Revisión L3 (I3): el ajuste fino nunca descarta un diseño válido (20 h ±0,1 h tiene uno a 1203 min).
  const t20 = dist(20, 'competencias', { opts: { tolerance: { pct: 0, minHours: 0.1 } } });
  eq(t20.status, 'within_tolerance', `20 h ±0,1 h (${t20.estimatedHours} h)`);
  for (const h of [12.5, 17, 21.5, 26, 29.5, 37, 44.5]) {
    const r = dist(h, 'competencias', { opts: { tolerance: { pct: 0, minHours: 0.25 } } });
    assert(r.status !== 'cannot_reach_target' || r.estimatedHours < h - 0.25, `${h} h: no reporta «no alcanza» con un diseño dentro de la tolerancia (${r.estimatedHours})`);
    if (r.status === 'cannot_reach_target') assert(dist(h, 'competencias').status !== 'within_tolerance' || r.estimatedHours < h - 0.25, `${h} h`);
  }
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

check('D8 Fase 2: las Actividades de Aplicación se generan — horas generables = horas del diseño (también por capítulo)', () => {
  const r = dist(33);
  assert(r.counts.applicationMinutes > 0, 'el diseño tiene actividades');
  eq(r.generableHours, r.estimatedHours, 'generable = diseño');
  for (const c of chapters(r)) eq(c.generableMinutes, c.targetMinutes, `capítulo ${c.id}`);
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

check('D10b otras formas de curso: cada nivel respeta el tope de su rol FINAL (los roles cambian al agregar capítulos y se informan)', () => {
  const shapes = [[2, 3], [1], [4, 1, 2], [5, 5], [1, 1, 1, 1], [3, 3, 3]];
  let roleChanges = 0;
  for (const shape of shapes) {
    const st = { course: { title: 'Forma', reviewCards: true, finalExam: true }, modules: shape.map((n, mi) => ({ title: `M${mi + 1}`, chapters: Array.from({ length: n }, (_, ci) => ({ title: `C${mi + 1}.${ci + 1}`, objective: 'Aplicar el procedimiento' })) })) };
    for (const k of ['competencias', 'significativo', null]) for (const h of [10, 20, 33, 50, 120]) {
      const r = ST.distributeCourseHours({ snapshot: P.snapshotFromStructure(clone(st)), rules: rulesOf(k), targetHours: h });
      for (const c of chapters(r)) {
        const cap = c.kind === 'practice' || c.role === 'module_closing' ? r.policy.closingTierMax : r.policy.contentTierMax;
        assert(c.applicationMinutes === null || c.applicationMinutes <= cap, `${shape}/${k}/${h}: ${c.id} (${c.role}) ${c.applicationMinutes} > ${cap}`);
        assert(c.targetMinutes <= ST.DISTRIBUTOR_RULES.maxChapterMinutes, `${shape}/${k}/${h}: ${c.id} ${c.targetMinutes} min`);
      }
      near(r.applicationShare, r.studyTime.byComponent.application / r.studyTime.courseEstimatedMinutes, 0.006, 'proporción informada');
      // Aviso exacto: con la proporción REAL (studyTime) por encima del tope del enfoque, y nunca por debajo.
      const realShare = r.studyTime.byComponent.application / r.studyTime.courseEstimatedMinutes;
      const warned = r.recommendations.some((x) => /% de este diseño son Actividades de Aplicación/i.test(x));
      if (realShare > r.policy.maxApplicationShare + 1e-6) assert(warned, `${shape}/${k}/${h}: falta el aviso (${realShare.toFixed(3)})`);
      if (realShare <= r.policy.maxApplicationShare) assert(!warned, `${shape}/${k}/${h}: aviso de más (${realShare.toFixed(3)})`);
      const rc = r.changes.filter((x) => x.type === 'role_changed');
      roleChanges += rc.length;
      for (const x of rc) assert(/deja de ser .+ y pasa a .+ del módulo/.test(x.detail), x.detail);
      for (const t of [...r.recommendations, ...r.priorityTrace, ...r.changes.map((x) => x.detail)]) {
        assert(!/Fase 2|lock|\d\.\d+ h/.test(t), `texto para el docente sin jerga ni decimales con punto: «${t}»`);
      }
    }
  }
  assert(roleChanges > 0, 'al cerrar un módulo con práctica, el cierre anterior cambia de rol y se informa');
});

check('D10c objetivos muy bajos: nunca propone quitar más capítulos de los que hay', () => {
  for (const h of [1, 2, 3.5]) {
    const r = dist(h);
    eq(r.status, 'minimum_exceeds_target', `${h} h`);
    const m = /quitar unos (\d+) capítulo/.exec(r.recommendations[1]);
    assert(!m || Number(m[1]) < r.counts.chapters, `${h} h: ${r.recommendations[1]}`);
  }
  assert(/Ni quitando capítulos se llega/.test(dist(1).recommendations[1]), dist(1).recommendations[1]);
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

check('D16 revisión final Fase 1 (M4): títulos propuestos ≤ 80 y la materialización valida como el camino real', () => {
  eq(ST.proposedTitle('Práctica integradora', 'Soporte vital'), 'Práctica integradora: Soporte vital', 'cabe');
  const long = 'Gestión integral de riesgos biológicos, químicos y ergonómicos en servicios hospitalarios de alta complejidad';
  eq(ST.proposedTitle('Práctica integradora', long), 'Práctica integradora', 'no cabe: solo el prefijo');
  const s = clone(RCP);
  s.modules[0].title = long.slice(0, 80);
  const r = P.runPedagogyDryRun({ structure: s, profile: profileOf('competencias', { targetHours: 50 }), activityTypeRules: 2 });
  const d = r.distribution;
  eq(d.materialized.manifestErrors, [], 'propuesta válida con un módulo de 80 caracteres');
  for (const m of d.modules) for (const c of m.chapters) assert(c.title.length <= 80, `título largo: ${c.title}`);
});

check('D17 revisión final Fase 1 (M3): si la materialización falla, el error es VISIBLE y el resto del dry-run sigue', () => {
  const s = clone(RCP);
  const base = P.runPedagogyDryRun({ structure: s, profile: profileOf('competencias', { targetHours: 33 }), activityTypeRules: 2 });
  // Un capítulo propuesto con video en práctica no es representable: la validación de entrada lo rechaza.
  const bad = { ...base.distribution, modules: base.distribution.modules.map((m) => ({ ...m, chapters: m.chapters.map((c) => (c.kind === 'practice' ? { ...c, videoEnabled: true } : c)) })) };
  let threw = null;
  try { P.materializeDistribution(base.baseline.blueprint, bad); } catch (e) { threw = e.message; }
  assert(threw && /DISTRIBUTION_MATERIALIZE_INVALID: .*PRACTICE_CHAPTER_VIDEO/.test(threw), `materializeDistribution falla fuerte: ${threw}`);
  const m = P.materializeOrError(base.baseline.blueprint, base.distribution, () => { throw new Error('bug simulado'); });
  eq([m.manifestErrors[0].code, m.generableHours, m.providers.estimateUsd], ['DISTRIBUTION_MATERIALIZE_FAILED', null, null], 'error visible');
  assert(/bug simulado/.test(m.manifestErrors[0].message) && /Sin estimación de costo/.test(m.providers.estimateNote), 'mensaje y nota de costo');
});

check('D18 LOOP 7 (A1): re-proponer sobre un diseño aplicado conserva las prácticas con su actividad y converge', () => {
  const rules = rulesOf('competencias');
  const run = (snap, h, prefs) => ST.distributeCourseHours({ snapshot: snap, rules, targetHours: h, activityTypeRules: 2, ...(prefs ? { preferences: prefs } : {}) });
  // Aplicar = materializar con ids NUEVOS para los capítulos agregados (en la base son gen_random_uuid).
  let nid = 0;
  const known = new Set(snapOf().modules.flatMap((m) => m.chapters.map((c) => c.id)));
  const apply = (snap, d) => {
    const out = clone(P.materializeDistribution(snap, d));
    for (const m of out.modules) for (const c of m.chapters) {
      if (known.has(c.id)) continue;
      c.id = `00000000-0000-4000-9000-${String(++nid).padStart(12, '0')}`;
      known.add(c.id);
    }
    return out;
  };
  for (const h of [50, 80]) {
    let snap = snapOf();
    let d = run(snap, h);
    const seen = [];
    for (let i = 0; i < 4 && d.changes.length; i++) {
      snap = apply(snap, d);
      d = run(snap, h);
      seen.push(d.changes.length);
      const practice = d.modules.flatMap((m) => m.chapters).filter((c) => c.kind === 'practice');
      assert(practice.length > 0 && practice.every((c) => c.applicationMinutes), `${h} h, vuelta ${i + 1}: cada práctica conserva su Actividad (${practice.map((c) => c.applicationMinutes).join(',')})`);
      const kindOf = new Map(d.modules.flatMap((m) => m.chapters.map((c) => [c.id, c.kind])));
      assert(!d.changes.some((c) => c.type === 'remove_application_activity' && kindOf.get(c.chapterId) === 'practice'), `${h} h: nunca propone quitar la Actividad de una práctica`);
    }
    eq(d.changes.length, 0, `${h} h: converge a un punto fijo (cambios por vuelta: ${seen.join(' → ')})`);
  }
  // «Ninguna» aplicada y después «auto»: las prácticas existentes recuperan su Actividad.
  let snap = snapOf();
  snap = apply(snap, run(snap, 50));
  snap = apply(snap, run(snap, 50, { applicationActivities: 'none' }));
  assert(snap.modules.flatMap((m) => m.chapters).every((c) => !c.applicationMinutes), 'con «Ninguna» no quedan actividades');
  const back = run(snap, 50, { applicationActivities: 'auto' });
  eq(back.status, 'within_tolerance', '«Ninguna» → «auto»: el diseño vuelve a cumplir');
  // REVIEW-L7 I1: una práctica existente recupera su actividad solo si cabe en la tolerancia y en la proporción.
  assert(back.estimatedHours <= back.targetHours + back.toleranceHours + 1e-9, `sin pasarse del objetivo (${back.estimatedHours} h)`);
  // Bajar el objetivo sobre un diseño aplicado nunca deja el diseño en peor estado que proponerlo desde cero.
  const rank = { within_tolerance: 0, cannot_reach_target: 1, above_tolerance: 2, minimum_exceeds_target: 3 };
  for (const [hi, lo] of [[50, 33], [80, 40], [40, 25]]) {
    let s2 = snapOf();
    s2 = apply(s2, run(s2, hi));
    const down = run(s2, lo);
    const scratch = run(snapOf(), lo);
    assert(rank[down.status] <= rank[scratch.status] || down.status === 'minimum_exceeds_target', `${hi}→${lo} h: ${down.status} (${down.estimatedHours} h) no peor que desde cero ${scratch.status} (${scratch.estimatedHours} h)`);
    assert(down.status === 'minimum_exceeds_target' || down.estimatedHours <= down.targetHours + down.toleranceHours + 1e-9 || scratch.status === 'above_tolerance', `${hi}→${lo} h: la siembra de prácticas no se pasa del objetivo (${down.estimatedHours} h)`);
  }
});

console.log(`\n${passes} OK, ${failures} fallidas`);
process.exit(failures ? 1 : 0);
