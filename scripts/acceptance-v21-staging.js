#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — aceptación de staging: Blueprint v2 → Manifest v3 → facts →
// estimado de costo → budget gate → regeneración parcial, de punta a punta con
// el MISMO código compilado que corre en staging (dist/). PURO: sin DB, sin red,
// sin proveedores. Nunca cruza el gate hacia un proveedor real.
//
//   - Blueprint v2 con 2 y 4 módulos y las 4 combinaciones V/A por capítulo;
//     el snapshot tiene videoEnabled/activityEnabled/examEnabled/finalExam y NO
//     presentationEnabled/audioEnabled (Gamma, audio de bienvenida, audiolibro y
//     Libro son obligatorios).
//   - Facts derivados del Manifest (conteos) y sin referencias fantasma.
//   - Estimado min/expected/max por capítulo, proveedor y tipo de item;
//     video OFF / actividad OFF quitan su gasto.
//   - Budget gate sin política ⇒ ADMIN_APPROVAL (fail closed; montos = HD-V21-19).
//   - Regeneración parcial: tema, passingGrade, reorder, actividad OFF, video OFF
//     ⇒ 0 generación pagada; incremental_cost y avoided_cost calculados.
//
// Uso (después de `npm run build`): node scripts/acceptance-v21-staging.js [--json out.json]
const fs = require('fs');
const path = require('path');

const distRoot = path.resolve(__dirname, '..', 'dist');
const load = (rel) => require(path.join(distRoot, rel));
const snap = load('modules/course-blueprints/blueprint-snapshot.js');
const B = load('modules/generation-manifests/generation-manifest-builder.js');
const P = load('modules/invalidation/plan.js');
const F = load('modules/finops/index.js');

let passes = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.log(`❌ ${name}\n   ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { const ja = JSON.stringify(a), jb = JSON.stringify(b); if (ja !== jb) throw new Error(`${m}: got ${ja}, want ${jb}`); }
const clone = (x) => JSON.parse(JSON.stringify(x));
const dec = (x) => Number(x);
const usd = (x) => `$${dec(x).toFixed(4)}`;

// ── Fixtures ───────────────────────────────────────────────────────────────
const COURSE_ID = 9001;
const CTX = 'd'.repeat(64);
const mid = (n) => `a9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cid = (n) => `c9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// V/A: las 4 combinaciones aparecen en ambos cursos.
const COMBOS = [
  { video: true, act: true },
  { video: false, act: true },
  { video: true, act: false },
  { video: false, act: false },
];
function spec(nModules, chaptersPerModule, opts = {}) {
  let ci = 0;
  return {
    title: `Aceptación V2.1 — ${nModules} módulos`,
    finalExam: opts.finalExam ?? true,
    engine: 'h5p',
    modules: Array.from({ length: nModules }, (_, mi) => ({
      id: mid(mi + 1),
      title: `Módulo ${mi + 1}`,
      objective: `Objetivo del módulo ${mi + 1}`,
      exam: opts.examOff && opts.examOff.includes(mi) ? false : true,
      chapters: Array.from({ length: chaptersPerModule[mi] }, () => {
        const n = ++ci;
        return { id: cid(n), title: `Capítulo ${n}`, objective: `Objetivo ${n}`, ...COMBOS[(n - 1) % 4] };
      }),
    })),
  };
}
function buildBp(s) {
  const modules = s.modules.map((m, i) => ({ id: m.id, position: m.position ?? i, title: m.title, objective: m.objective, exam_enabled: !!m.exam }));
  const chapters = [];
  s.modules.forEach((m) => m.chapters.forEach((c, j) => chapters.push({
    id: c.id, module_id: m.id, position: c.position ?? j, title: c.title, objective: c.objective,
    video_enabled: !!c.video, activity_enabled: !!c.act,
  })));
  return snap.buildBlueprintSnapshotV2({ id: COURSE_ID, title: s.title, finalExam: s.finalExam, activityEngine: s.engine }, modules, chapters);
}
const manifestOf = (bp, n) =>
  B.buildGenerationManifest(bp, { courseId: COURSE_ID, blueprintId: n, blueprintNumber: n, blueprintSha256: snap.snapshotSha256V2(bp) }, { rulesVersion: 3 });

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/modules/finops/pricing-seed.v1.json'), 'utf8'));
const CATALOG = seed.rows.map((r, i) => ({ id: `seed-${i}`, ...r }));
const estimate = (items) => F.estimateCost({ items, catalog: CATALOG, usageModel: F.usageModelPriorsV1(), retryPolicy: { maxRetries: 1 } });
// Estimado "como si fuera real" (nunca se ejecuta): todos los proveedores en real.
const estimateManifest = (m, actions) => estimate(F.estimateItemsForRun(m.items, 'real', actions || null));

/** Facts del curso, derivados SOLO del Manifest (nunca de texto del LLM). */
function factsOf(m) {
  const n = (t) => m.items.filter((i) => i.type === t).length;
  return {
    modules: new Set(m.items.filter((i) => i.moduleId).map((i) => i.moduleId)).size,
    chapters: n('content'),
    videos: n('video'),
    videoInteractions: n('video_interactions'),
    activities: n('activity'),
    moduleExams: n('exam'),
    finalExam: n('final_exam'),
    presentations: n('presentation'),
    audiobookChapters: n('audiobook_chapter'),
    audioWelcome: n('audio_welcome'),
  };
}

const report = { courses: {} };
const FORBIDDEN_TOGGLES = ['presentationEnabled', 'audioEnabled', 'audiobookEnabled', 'libroEnabled', 'gammaEnabled'];
function keysDeep(o, out = new Set()) {
  if (Array.isArray(o)) o.forEach((x) => keysDeep(x, out));
  else if (o && typeof o === 'object') for (const k of Object.keys(o)) { out.add(k); keysDeep(o[k], out); }
  return out;
}

for (const [label, s] of [['2 módulos (3+4 capítulos)', spec(2, [3, 4])], ['4 módulos (2+3+1+2 capítulos, examen M3 OFF)', spec(4, [2, 3, 1, 2], { examOff: [2] })]]) {
  const bp = buildBp(s);
  const m = manifestOf(bp, 1);
  const facts = factsOf(m);
  const chs = s.modules.flatMap((x) => x.chapters);
  check(`[${label}] Blueprint v2: schemaVersion 2; toggles exactos por capítulo/módulo/curso; sin toggles de Gamma/audio/Libro`, () => {
    eq(bp.schemaVersion, 2, 'schemaVersion');
    eq([bp.course.finalExam, bp.course.activityEngine], [true, 'h5p'], 'curso');
    const snapCh = bp.modules.flatMap((x) => x.chapters);
    eq(snapCh.map((c) => [c.videoEnabled, c.activityEnabled]), chs.map((c) => [!!c.video, !!c.act]), 'V/A por capítulo');
    eq(bp.modules.map((x) => x.examEnabled), s.modules.map((x) => !!x.exam), 'examEnabled por módulo');
    const keys = keysDeep(bp);
    for (const k of ['videoEnabled', 'activityEnabled', 'examEnabled', 'finalExam']) assert(keys.has(k), `falta ${k}`);
    const bad = FORBIDDEN_TOGGLES.filter((k) => keys.has(k));
    eq(bad, [], 'toggles prohibidos presentes');
    // Las 4 combinaciones V/A están presentes.
    eq(new Set(snapCh.map((c) => `${c.videoEnabled}/${c.activityEnabled}`)).size, 4, 'combinaciones V/A');
  });
  check(`[${label}] Manifest v3: facts derivados = Blueprint (${JSON.stringify(facts)})`, () => {
    eq(m.rulesVersion, 3, 'rulesVersion');
    eq(facts.modules, s.modules.length, 'módulos');
    eq(facts.chapters, chs.length, 'capítulos');
    eq(facts.videos, chs.filter((c) => c.video).length, 'videos');
    eq(facts.videoInteractions, facts.videos, 'interacciones = videos');
    eq(facts.activities, chs.filter((c) => c.act).length, 'actividades');
    eq(facts.moduleExams, s.modules.filter((x) => x.exam).length, 'exámenes de módulo');
    eq(facts.finalExam, 1, 'examen final');
    // Obligatorios: Gamma, audiolibro y Libro por capítulo; bienvenida una vez.
    eq([facts.presentations, facts.audiobookChapters, facts.audioWelcome], [chs.length, chs.length, 1], 'obligatorios');
  });
  check(`[${label}] sin referencias fantasma: video OFF ⇒ sin video ni interacciones; actividad OFF ⇒ sin actividad; ambos OFF ⇒ capítulo completo`, () => {
    for (const c of chs) {
      const types = m.items.filter((i) => i.chapterId === c.id).map((i) => i.type).sort();
      assert(!c.video === !types.includes('video'), `${c.title}: video`);
      assert(!c.video === !types.includes('video_interactions'), `${c.title}: interacciones`);
      assert(!c.act === !types.includes('activity'), `${c.title}: actividad`);
      for (const t of ['content', 'presentation', 'audiobook_chapter']) assert(types.includes(t), `${c.title}: falta ${t} (capítulo incompleto)`);
      // Ninguna dependencia apunta a un item que no existe.
    }
    const keys = new Set(m.items.map((i) => i.key));
    const dangling = m.items.flatMap((i) => (i.dependsOn || []).filter((d) => !keys.has(d)).map((d) => `${i.key}→${d}`));
    eq(dangling, [], 'dependsOn colgantes');
  });
  const est = estimateManifest(m);
  report.courses[label] = { facts, estimate: F.estimateSummary ? F.estimateSummary(est) : est.totals, totals: est.totals };
  check(`[${label}] estimado: min ≤ expected ≤ max; sumas por capítulo/proveedor/tipo = total`, () => {
    const t = est.totals;
    assert(dec(t.min) <= dec(t.expected) && dec(t.expected) <= dec(t.max), 'orden min/exp/max');
    for (const g of ['byProvider', 'byItemType', 'byChapter']) {
      const sum = Object.values(t[g]).reduce((a, v) => a + dec(v.expected), 0);
      assert(Math.abs(sum - dec(t.expected)) < 1e-6, `${g}: ${sum} ≠ ${t.expected}`);
    }
    assert(!t.byItemType.video || Object.keys(t.byChapter).length > 0, 'por capítulo');
  });
  check(`[${label}] budget gate sin política ⇒ ADMIN_APPROVAL (fail closed); run mock ⇒ permitido`, () => {
    eq(F.evaluateBudget({ estimate: est, policy: null, realSpend: true }).decision, 'ADMIN_APPROVAL', 'real sin política');
    eq(F.evaluateBudget({ estimate: est, policy: null, realSpend: false }).decision, 'AUTO_WITHIN_POLICY', 'mock');
  });
}

// ── video OFF / actividad OFF quitan su gasto esperado ─────────────────────
const base = spec(2, [3, 4]);
const bpBase = buildBp(base);
const mBase = manifestOf(bpBase, 1);
const estBase = estimateManifest(mBase);
const target = base.modules[0].chapters[0]; // V ON / A ON
check('video OFF en un capítulo: su gasto de video + interacciones desaparece del estimado; el resto no cambia', () => {
  const s2 = clone(base);
  s2.modules[0].chapters[0].video = false;
  const e2 = estimateManifest(manifestOf(buildBp(s2), 2));
  const drop = dec(estBase.totals.expected) - dec(e2.totals.expected);
  const own = estBase.lines.filter((l) => l.itemKey === `video:${target.id}` || l.itemKey === `video_interactions:${target.id}`).reduce((a, l) => a + dec(l.wouldCost.expected), 0);
  assert(own > 0, 'el video tenía costo');
  assert(Math.abs(drop - own) < 1e-6, `baja ${drop} ≠ costo propio ${own}`);
  assert(!e2.lines.some((l) => l.itemKey.endsWith(target.id) && /^video/.test(l.itemKey)), 'sin líneas de video');
});
check('actividad OFF en un capítulo: su gasto de actividad desaparece del estimado; el resto no cambia', () => {
  const s2 = clone(base);
  s2.modules[0].chapters[0].act = false;
  const e2 = estimateManifest(manifestOf(buildBp(s2), 2));
  const drop = dec(estBase.totals.expected) - dec(e2.totals.expected);
  const own = estBase.lines.filter((l) => l.itemKey === `activity:${target.id}`).reduce((a, l) => a + dec(l.wouldCost.expected), 0);
  assert(own > 0, 'la actividad tenía costo');
  assert(Math.abs(drop - own) < 1e-6, `baja ${drop} ≠ costo propio ${own}`);
});

// ── Regeneración parcial ───────────────────────────────────────────────────
function recordsOf(manifest) {
  return manifest.items.map((it) => ({
    itemKey: it.key, itemRunId: `A#${it.key}`, status: 'completed', artifactIds: [`A|${it.key}`], artifactStatus: 'ready',
    inputFingerprint: null, outputIdentity: `out/A/${it.key}`,
    ...(it.type === 'video_interactions' ? { consumedVideoIdentity: `out/A/video:${it.chapterId}` } : {}),
  }));
}
function partial(label, mutate, expectFn) {
  check(`regeneración parcial — ${label}: 0 generación pagada; incremental_cost y avoided_cost correctos`, () => {
    const s2 = clone(base);
    const extra = mutate(s2) || {};
    const bpB = buildBp(s2);
    const mB = manifestOf(bpB, 2);
    const plan = P.computeInvalidationPlan({
      from: { blueprint: bpBase, manifest: mBase, items: recordsOf(mBase), courseContextSha256: CTX },
      to: { blueprint: bpB, manifest: mB, courseContextSha256: CTX },
    });
    const actions = Object.fromEntries(plan.actions.map((a) => [a.itemKey, a.action]));
    const paid = plan.actions.filter((a) => a.action === 'GENERATE' || a.action === 'REGENERATE');
    eq(paid.map((a) => `${a.itemKey}=${a.action}`), [], 'items que pagarían');
    // Estimado del destino con las acciones del plan; incremental/evitado.
    const est = estimate(F.estimateItemsForRun(mB.items, 'real', actions));
    const inc = F.incrementalCostForPlan(plan.actions.map((a) => ({ itemKey: a.itemKey, action: a.action, fromItemRunId: a.fromItemRunId ?? null })), est.lines, {});
    eq(inc.totals.incremental.expected, F.normalizeDecimal(0), 'incremental');
    const avoidedExp = est.lines.filter((l) => ['REUSE', 'REVIEW', 'STALE_NO_AUTO'].includes(l.action)).reduce((a, l) => a + dec(l.wouldCost.expected), 0);
    assert(Math.abs(dec(inc.totals.avoided) - avoidedExp) < 1e-6, `evitado ${inc.totals.avoided} ≠ ${avoidedExp}`);
    const counts = plan.actions.reduce((a, x) => ((a[x.action] = (a[x.action] || 0) + 1), a), {});
    if (expectFn) expectFn(actions, counts);
    report.partial = report.partial || {};
    report.partial[label] = { incremental: inc.totals.incremental.expected, avoided: inc.totals.avoided, actions: counts, ...extra };
  });
}
// Tema y passingGrade NO son parte del Blueprint (perfiles, solo packaging): el Blueprint no cambia.
partial('cambio de tema (perfil de presentación)', () => ({ note: 'perfil de presentación: fuera del Blueprint y de las huellas' }), (_a, c) => eq(Object.keys(c), ['REUSE'], 'todo REUSE'));
partial('cambio de passingGrade (perfil de evaluación)', () => ({ note: 'perfil de evaluación: solo re-empaque' }), (_a, c) => eq(Object.keys(c), ['REUSE'], 'todo REUSE'));
partial('reorder de capítulos dentro del módulo', (s) => {
  const ch = s.modules[1].chapters;
  ch.forEach((c, i) => (c.position = ch.length - 1 - i));
}, (_a, c) => assert(!c.GENERATE && !c.REGENERATE, 'nada pagado'));
partial('actividad OFF', (s) => { s.modules[0].chapters[0].act = false; }, (a) => eq(a[`activity:${target.id}`], 'SOFT_DISABLE', 'activity'));
partial('video OFF', (s) => { s.modules[0].chapters[0].video = false; }, (a) => eq([a[`video:${target.id}`], a[`video_interactions:${target.id}`]], ['SOFT_DISABLE', 'SOFT_DISABLE'], 'video'));

// ── Salida legible: Course estimate ────────────────────────────────────────
function printEstimate(label, t) {
  const row = (name, v) => console.log(`  ${name.padEnd(22)} ${usd(v.min).padStart(11)} ${usd(v.expected).padStart(11)} ${usd(v.max).padStart(11)}`);
  console.log(`\nCourse estimate — ${label}`);
  console.log(`  ${''.padEnd(22)} ${'min'.padStart(11)} ${'expected'.padStart(11)} ${'max'.padStart(11)}`);
  const NAMES = {
    course_plan: 'content (plan)', content: 'content', experience: 'experience', presentation: 'Gamma', video: 'videos',
    video_interactions: 'video interactions', activity: 'activities', exam: 'exams (módulo)', final_exam: 'final exam',
    audio_welcome: 'audio welcome', audiobook_chapter: 'audiobook', course_intro: 'course intro', module_intro: 'module intro',
  };
  for (const [k, v] of Object.entries(t.byItemType)) row(NAMES[k] || k, v);
  row('TOTAL', t);
  console.log('  por proveedor: ' + Object.entries(t.byProvider).map(([k, v]) => `${k} ${usd(v.expected)}`).join(' · '));
  console.log('  por capítulo:  ' + Object.entries(t.byChapter).map(([k, v]) => `${k === '_none' ? 'curso/módulo' : k.slice(-4)} ${usd(v.expected)}`).join(' · '));
}
for (const [label, r] of Object.entries(report.courses)) printEstimate(label, r.totals);
if (report.partial) {
  console.log('\nRegeneración parcial (estimado, sin gastar):');
  for (const [k, v] of Object.entries(report.partial)) console.log(`  ${k.padEnd(48)} incremental ${usd(v.incremental)} · evitado ${usd(v.avoided)} · ${JSON.stringify(v.actions)}`);
}
const jsonOut = process.argv.indexOf('--json');
if (jsonOut > 0) fs.writeFileSync(process.argv[jsonOut + 1], JSON.stringify(report, null, 2));
console.log(`\n${passes} ok, ${failures} fallos · 0 llamadas a proveedores (puro)`);
process.exit(failures ? 1 : 0);
