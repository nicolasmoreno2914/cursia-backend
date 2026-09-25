#!/usr/bin/env node
/* eslint-disable */
// Fase 5B.1 B1 — no-DB determinism check for buildPackagingPlan, wired into
// deploy-staging.yml right after the Generation Manifest determinism check
// (same rationale: a build that produces a non-deterministic — or otherwise
// regressed — PackagingPlan should never reach staging).
//
// This is deliberately OUTSIDE src/ so Nest's `tsc -p tsconfig.build.json`
// never compiles it (tsconfig.build.json's `include` is `src/**/*`), and it
// requires the COMPILED modules from `dist/` (never ts-node, never the
// TypeScript source) so it exercises exactly what actually ships.
//
// Usage:
//   node scripts/check-packaging-plan-determinism.js
//   node scripts/check-packaging-plan-determinism.js path/to/dist

const path = require('path');

const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');

function loadDist(relPath) {
  const abs = path.join(distRoot, relPath);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

const planModule = loadDist('modules/dynamic-packaging/packaging-plan.js');
const manifestModule = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const blueprintModule = loadDist('modules/course-blueprints/blueprint-snapshot.js');

const { buildPackagingPlan, canonicalPackagingPlanJson, packagingPlanSha256, PackagingPlanError } = planModule;
const { buildGenerationManifest } = manifestModule;
const { buildBlueprintSnapshot, snapshotSha256 } = blueprintModule;

for (const [name, fn] of Object.entries({
  buildPackagingPlan,
  canonicalPackagingPlanJson,
  packagingPlanSha256,
  buildGenerationManifest,
  buildBlueprintSnapshot,
  snapshotSha256,
})) {
  if (typeof fn !== 'function') {
    console.error(`❌ Falta la función "${name}" en los módulos compilados bajo ${distRoot}.`);
    process.exit(1);
  }
}
if (typeof PackagingPlanError !== 'function') {
  console.error(`❌ Falta la clase "PackagingPlanError" en el módulo compilado.`);
  process.exit(1);
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.message ? err.message : err}`);
  }
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: esperado ${JSON.stringify(expected)}, encontrado ${JSON.stringify(actual)}`);
  }
}
function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg}: esperado ${e}, encontrado ${a}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture de aceptación (spec §9 / plan B1): 4 módulos {2,5,1,3} capítulos
// (global 1..11), videos en capítulos 1,3,4,6,8,10, exámenes en módulos
// 1,2,4 — igual forma que el fixture del harness de Task 2, para que el
// hash pinneado coincida.
// ---------------------------------------------------------------------------

function rawChapter(id, moduleId, position, videoEnabled) {
  return { id, module_id: moduleId, position, title: `Capítulo ${id}`, objective: `Objetivo ${id}`, video_enabled: videoEnabled };
}
function rawModule(id, position, examEnabled) {
  return { id, position, title: `Módulo ${id}`, objective: `Objetivo módulo ${id}`, exam_enabled: examEnabled };
}

function buildFixtureSnapshot() {
  const modules = [
    rawModule('m1', 0, true),
    rawModule('m2', 1, true),
    rawModule('m3', 2, false),
    rawModule('m4', 3, true),
  ];
  const chapters = [
    rawChapter('m1c1', 'm1', 0, true), // chapterNumber 1 — video
    rawChapter('m1c2', 'm1', 1, false), // 2
    rawChapter('m2c1', 'm2', 0, true), // 3 — video
    rawChapter('m2c2', 'm2', 1, true), // 4 — video
    rawChapter('m2c3', 'm2', 2, false), // 5
    rawChapter('m2c4', 'm2', 3, true), // 6 — video
    rawChapter('m2c5', 'm2', 4, false), // 7
    rawChapter('m3c1', 'm3', 0, true), // 8 — video
    rawChapter('m4c1', 'm4', 0, false), // 9
    rawChapter('m4c2', 'm4', 1, true), // 10 — video
    rawChapter('m4c3', 'm4', 2, false), // 11
  ];
  return buildBlueprintSnapshot({ id: 39, title: 'Curso Fixture Aceptación' }, modules, chapters);
}

function fixtureSource(snapshot) {
  return {
    courseId: 39,
    blueprintId: 46,
    blueprintNumber: 1,
    blueprintSha256: snapshotSha256(snapshot),
  };
}

function buildFixturePlan() {
  const snapshot = buildFixtureSnapshot();
  const source = fixtureSource(snapshot);
  const manifest = buildGenerationManifest(snapshot, source);
  return buildPackagingPlan(manifest, snapshot, { manifestId: 46 });
}

function shuffleKeys(value) {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    const shuffled = [...keys].reverse();
    const out = {};
    for (const k of shuffled) out[k] = shuffleKeys(value[k]);
    return out;
  }
  return value;
}

const PINNED_HASH = 'f9cf891a5dbacfb4de03cfebb5c7529349c6725f81f075dcb00e0a65d569b7b9';

check('totals = 4 módulos / 11 capítulos / 11 scorm / 6 video / 3 exam', () => {
  const plan = buildFixturePlan();
  assertDeepEqual(plan.totals, { modules: 4, chapters: 11, scorms: 11, videos: 6, exams: 3 }, 'totals');
});

check('secciones: 0 welcome, 1 route_and_book, 2..5 module (sin cierre/examen final)', () => {
  const plan = buildFixturePlan();
  assertDeepEqual(
    plan.sections.map((s) => [s.sectionNum, s.kind]),
    [[0, 'welcome'], [1, 'route_and_book'], [2, 'module'], [3, 'module'], [4, 'module'], [5, 'module']],
    'sections',
  );
});

check('capítulos {2,5,1,3} por módulo, en orden', () => {
  const plan = buildFixturePlan();
  assertDeepEqual(plan.modules.map((m) => m.chapters.length), [2, 5, 1, 3], 'tamaños de módulo');
});

check('videos exactos en capítulos 1,3,4,6,8,10', () => {
  const plan = buildFixturePlan();
  const withVideo = plan.modules
    .flatMap((m) => m.chapters)
    .filter((c) => c.videoItemKey !== null)
    .map((c) => c.chapterNumber)
    .sort((a, b) => a - b);
  assertDeepEqual(withVideo, [1, 3, 4, 6, 8, 10], 'capítulos con video');
});

check('exámenes exactos en módulos 1,2,4; sin examen final', () => {
  const plan = buildFixturePlan();
  const examModules = plan.modules.filter((m) => m.examItemKey !== null).map((m) => m.moduleNumber);
  assertDeepEqual(examModules, [1, 2, 4], 'módulos con examen');
  const hasClosing = plan.sections.some((s) => /examen final|cierre/i.test(s.title));
  assertEqual(hasClosing, false, 'sin sección de cierre/examen final');
});

check('shuffled-input (reversed modules/chapters) -> mismo hash', () => {
  const snapshot = buildFixtureSnapshot();
  const source = fixtureSource(snapshot);
  const manifest = buildGenerationManifest(snapshot, source);
  const plan1 = buildPackagingPlan(manifest, snapshot, { manifestId: 46 });

  const shuffledSnapshot = {
    ...snapshot,
    modules: [...snapshot.modules].reverse().map((m) => ({ ...m, chapters: [...m.chapters].reverse() })),
  };
  // El manifest debe seguir siendo el mismo (mismo orden canónico) — solo el
  // ORDEN DE INPUT del snapshot se baraja; buildGenerationManifest ya está
  // probado para ser insensible a esto (check-generation-manifest-determinism.js).
  // blueprintSha256 se recalcula sobre CADA snapshot que se le pasa a
  // buildPackagingPlan — reordenar modules/chapters cambia el JSON canónico
  // del snapshot (y por lo tanto su sha256) aunque el contenido semántico
  // sea el mismo, así que el source de este segundo build usa el sha256 del
  // snapshot barajado, no el del original.
  const source2 = { ...source, blueprintSha256: snapshotSha256(shuffledSnapshot) };
  const manifest2 = buildGenerationManifest(shuffledSnapshot, source2);
  const plan2 = buildPackagingPlan(manifest2, shuffledSnapshot, { manifestId: 46 });

  assertEqual(packagingPlanSha256(plan2), packagingPlanSha256(plan1), 'hash con snapshot de input barajado');
});

check('jsonb-style key-shuffled round trip -> mismo hash', () => {
  const plan = buildFixturePlan();
  const h1 = packagingPlanSha256(plan);
  const roundTripped = shuffleKeys(JSON.parse(JSON.stringify(plan)));
  const h2 = packagingPlanSha256(roundTripped);
  assertEqual(h2, h1, 'hash tras shuffle de claves');
});

check(`hash del plan de aceptación es estable`, () => {
  const plan = buildFixturePlan();
  const h1 = packagingPlanSha256(plan);
  const h2 = packagingPlanSha256(buildFixturePlan());
  assertEqual(h2, h1, 'packagingPlanSha256 debe ser determinístico entre corridas');
});

check(`hash equals pinned value ${PINNED_HASH}`, () => {
  const plan = buildFixturePlan();
  const hash = packagingPlanSha256(plan);
  assertEqual(hash, PINNED_HASH, 'packagingPlanSha256 del plan de aceptación');
});

// ── rulesVersion 2 (5B.2.B): mismo fixture con Manifest v2 ────────────────
// El plan v2 agrega rulesVersion/courseIntroItemKey/moduleIntroItemKey; el
// hash v1 de arriba no cambia.
const PINNED_HASH_V2 = 'd2c6e11405fa2f85a67e3e7e370b417d2a365f2a205385d3e90e7087b8c07886';
function buildFixturePlanV2() {
  const snapshot = buildFixtureSnapshot();
  const manifest = buildGenerationManifest(snapshot, fixtureSource(snapshot), { rulesVersion: 2 });
  return buildPackagingPlan(manifest, snapshot, { manifestId: 46 });
}

check('v2: intros por UUID/key y mismos totals/secciones que v1', () => {
  const plan = buildFixturePlanV2();
  assertEqual(plan.rulesVersion, 2, 'rulesVersion');
  assertEqual(plan.courseIntroItemKey, 'course_intro:39', 'courseIntroItemKey');
  assertDeepEqual(plan.modules.map((m) => m.moduleIntroItemKey), ['m1', 'm2', 'm3', 'm4'].map((id) => `module_intro:${id}`), 'moduleIntroItemKey');
  assertDeepEqual(plan.totals, buildFixturePlan().totals, 'totals');
  assertDeepEqual(plan.sections, buildFixturePlan().sections, 'sections');
  assertEqual('rulesVersion' in buildFixturePlan(), false, 'un plan v1 no lleva rulesVersion');
});

check('v2: jsonb round trip → mismo hash, y distinto del v1', () => {
  const plan = buildFixturePlanV2();
  const h1 = packagingPlanSha256(plan);
  assertEqual(packagingPlanSha256(shuffleKeys(JSON.parse(JSON.stringify(plan)))), h1, 'round trip v2');
  assertEqual(h1 !== PINNED_HASH, true, 'el hash v2 no puede coincidir con el v1');
});

check(`v2: hash equals pinned value ${PINNED_HASH_V2}`, () => {
  assertEqual(packagingPlanSha256(buildFixturePlanV2()), PINNED_HASH_V2, 'packagingPlanSha256 v2');
});

console.log('');
if (failures > 0) {
  console.error(`❌ Packaging Plan determinism check FALLÓ (${failures} chequeo(s) roto(s)).`);
  process.exit(1);
}
console.log('✅ Packaging Plan determinism check OK.');
