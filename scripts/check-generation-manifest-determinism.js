#!/usr/bin/env node
/* eslint-disable */
// FIX M3 (final-review fix wave, 2026-09-24) — no-DB determinism check for the
// Generation Manifest builder, wired into deploy-staging.yml right after
// "Verify dist/main.js" so a build that produces a non-deterministic (or
// otherwise regressed) manifest never reaches staging.
//
// This is deliberately OUTSIDE src/ so Nest's `tsc -p tsconfig.build.json`
// never compiles it (tsconfig.build.json's `include` is `src/**/*`), and it
// requires the COMPILED builder from `dist/` (never ts-node, never the
// TypeScript source) so it exercises exactly what actually ships.
//
// Usage:
//   node scripts/check-generation-manifest-determinism.js [path/to/builder.js]
// Default path: dist/modules/generation-manifests/generation-manifest-builder.js

const path = require('path');

const builderPath = path.resolve(
  process.cwd(),
  process.argv[2] || 'dist/modules/generation-manifests/generation-manifest-builder.js',
);

let builder;
try {
  builder = require(builderPath);
} catch (err) {
  console.error(`❌ No se pudo cargar el builder compilado en ${builderPath}`);
  console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
  console.error(`   ${err.message}`);
  process.exit(1);
}

const { buildGenerationManifest, validateGenerationManifest, canonicalManifestJson, manifestSha256 } = builder;

for (const [name, fn] of Object.entries({
  buildGenerationManifest,
  validateGenerationManifest,
  canonicalManifestJson,
  manifestSha256,
})) {
  if (typeof fn !== 'function') {
    console.error(`❌ El builder compilado en ${builderPath} no exporta "${name}" como función.`);
    process.exit(1);
  }
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

// --- Acceptance fixture — same shape/ids as Task 2's harness, so the pinned
// hash matches exactly:
// M1: 2 caps video [on,off] exam on
// M2: 5 caps video [on,off,on,off,off] exam off
// M3: 1 cap video on exam on
// M4: 3 caps video [off,on,on] exam on
function chapter(id, position, videoEnabled) {
  return { id, position, title: `Chapter ${id}`, objective: null, videoEnabled };
}
function mod(id, position, examEnabled, chapters) {
  return { id, position, title: `Module ${id}`, objective: null, examEnabled, chapters };
}
function buildFixtureSnapshot() {
  return {
    schemaVersion: 1,
    course: { id: 12, title: 'Curso Fixture', structureVersion: 'dynamic' },
    modules: [
      mod('m1', 0, true, [chapter('m1c1', 0, true), chapter('m1c2', 1, false)]),
      mod('m2', 1, false, [
        chapter('m2c1', 0, true),
        chapter('m2c2', 1, false),
        chapter('m2c3', 2, true),
        chapter('m2c4', 3, false),
        chapter('m2c5', 4, false),
      ]),
      mod('m3', 2, true, [chapter('m3c1', 0, true)]),
      mod('m4', 3, true, [chapter('m4c1', 0, false), chapter('m4c2', 1, true), chapter('m4c3', 2, true)]),
    ],
  };
}
function fixtureSource() {
  return {
    courseId: 12,
    blueprintId: 31,
    blueprintNumber: 3,
    blueprintSha256: 'a'.repeat(64),
  };
}

function shuffleKeys(value) {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    const shuffled = [...keys].reverse(); // deterministic-but-different order
    const out = {};
    for (const k of shuffled) out[k] = shuffleKeys(value[k]);
    return out;
  }
  return value;
}

const PINNED_HASH = 'f7eaa79d7f88f474ff8459d6f31d1f1ae6055f8c6068f50ab889cdbf71d9cb46';

check('totals = 4 módulos / 11 capítulos / 11 content / 11 scorm / 6 video / 3 exam / 31 jobs', () => {
  const manifest = buildGenerationManifest(buildFixtureSnapshot(), fixtureSource());
  assertDeepEqual(
    manifest.totals,
    {
      moduleCount: 4,
      chapterCount: 11,
      contentCount: 11,
      scormCount: 11,
      videoCount: 6,
      examCount: 3,
      totalJobs: 31,
    },
    'totals',
  );
});

check('validateGenerationManifest(manifest, snapshot, source) === []', () => {
  const snapshot = buildFixtureSnapshot();
  const source = fixtureSource();
  const manifest = buildGenerationManifest(snapshot, source);
  const errors = validateGenerationManifest(manifest, snapshot, source);
  assertDeepEqual(errors, [], 'validator errors');
});

check('shuffled-input (reversed modules/chapters) -> same hash', () => {
  const snapshot = buildFixtureSnapshot();
  const shuffled = {
    ...snapshot,
    modules: [...snapshot.modules].reverse().map((m) => ({ ...m, chapters: [...m.chapters].reverse() })),
  };
  const h1 = manifestSha256(buildGenerationManifest(snapshot, fixtureSource()));
  const h2 = manifestSha256(buildGenerationManifest(shuffled, fixtureSource()));
  assertEqual(h2, h1, 'hash with shuffled input snapshot');
});

check('jsonb-style key-shuffled round trip -> same hash', () => {
  const manifest = buildGenerationManifest(buildFixtureSnapshot(), fixtureSource());
  const h1 = manifestSha256(manifest);
  const roundTripped = shuffleKeys(JSON.parse(JSON.stringify(manifest)));
  const h2 = manifestSha256(roundTripped);
  assertEqual(h2, h1, 'hash after jsonb-style key shuffle round trip');
});

check(`hash equals pinned value ${PINNED_HASH}`, () => {
  const manifest = buildGenerationManifest(buildFixtureSnapshot(), fixtureSource());
  const hash = manifestSha256(manifest);
  assertEqual(hash, PINNED_HASH, 'manifestSha256 of the acceptance fixture');
});

// ── rulesVersion 2 (5B.2.B + Fase 6) ─────────────────────────────────────
// Mismo fixture: v1 + course_plan + course_intro + 4 module_intro = 37 items;
// content depende de course_plan. El hash v1 de arriba NO cambia.
const PINNED_HASH_V2 = 'd9cacedae51d4b8291fbebeec20ea125fff2532848ba2b8b7774f4af57a0d569';
const V2 = { rulesVersion: 2 };

check('v2: totals = v1 + 1 plan + 1 intro de curso + 4 intros de módulo = 37 jobs', () => {
  const manifest = buildGenerationManifest(buildFixtureSnapshot(), fixtureSource(), V2);
  assertDeepEqual(
    manifest.totals,
    {
      moduleCount: 4, chapterCount: 11, contentCount: 11, scormCount: 11, videoCount: 6, examCount: 3,
      coursePlanCount: 1, courseIntroCount: 1, moduleIntroCount: 4, totalJobs: 37,
    },
    'totals v2',
  );
  assertEqual(manifest.rulesVersion, 2, 'rulesVersion');
});

check('v2: orden canónico y aristas (plan → intro de curso; por módulo intro → caps → exam; content → plan)', () => {
  const manifest = buildGenerationManifest(buildFixtureSnapshot(), fixtureSource(), V2);
  const keys = manifest.items.map((i) => i.key);
  assertDeepEqual(keys.slice(0, 5), ['course_plan:12', 'course_intro:12', 'module_intro:m1', 'content:m1c1', 'scorm:m1c1'], 'primeras keys');
  const byKey = Object.fromEntries(manifest.items.map((i) => [i.key, i]));
  assertDeepEqual(byKey['course_plan:12'].dependsOn, [], 'course_plan.dependsOn');
  assertDeepEqual(
    [byKey['course_plan:12'].scope, byKey['course_plan:12'].moduleId, byKey['course_plan:12'].chapterId, byKey['course_plan:12'].moduleNumber],
    ['course', null, null, null],
    'course_plan scope/ids',
  );
  assertDeepEqual(byKey['course_intro:12'].dependsOn, ['course_plan:12'], 'course_intro.dependsOn');
  for (const m of ['m1', 'm2', 'm3', 'm4']) {
    const it = byKey[`module_intro:${m}`];
    assertDeepEqual([it.scope, it.moduleId, it.chapterId, it.dependsOn], ['module', m, null, ['course_plan:12']], `module_intro:${m}`);
    assertEqual(keys.indexOf(`module_intro:${m}`) < keys.findIndex((k) => k.startsWith(`content:${m}c`)), true, `module_intro:${m} antes de sus capítulos`);
  }
  for (const it of manifest.items.filter((i) => i.type === 'content')) {
    assertDeepEqual(it.dependsOn, ['course_plan:12'], `${it.key}.dependsOn`);
  }
  assertDeepEqual(byKey['exam:m1'].dependsOn, ['content:m1c1', 'content:m1c2'], 'exam:m1.dependsOn (igual que v1)');
});

check('v2: validateGenerationManifest === [] y un v1 NO valida como v2 (ni al revés)', () => {
  const snapshot = buildFixtureSnapshot();
  const source = fixtureSource();
  const v2 = buildGenerationManifest(snapshot, source, V2);
  assertDeepEqual(validateGenerationManifest(v2, snapshot, source), [], 'validator errors v2');
  const v1AsV2 = { ...buildGenerationManifest(snapshot, source), rulesVersion: 2 };
  const e1 = validateGenerationManifest(v1AsV2, snapshot, source).map((e) => e.code);
  assertEqual(e1.includes('MISSING_COURSE_PLAN') && e1.includes('MISSING_MODULE_INTRO') && e1.includes('WRONG_DEPENDENCIES'), true, 'v1 etiquetado v2 → faltan items v2');
  const v2AsV1 = { ...v2, rulesVersion: 1 };
  const e2 = validateGenerationManifest(v2AsV1, snapshot, source).map((e) => e.code);
  assertEqual(e2.includes('UNKNOWN_TYPE') && e2.includes('WRONG_DEPENDENCIES'), true, 'v2 etiquetado v1 → tipos desconocidos');
  const v3 = { ...v2, rulesVersion: 3 };
  assertEqual(validateGenerationManifest(v3, snapshot, source).some((e) => e.code === 'VERSION_MISMATCH'), true, 'rulesVersion 3 → VERSION_MISMATCH');
});

check('v2: el validador detecta plan duplicado, intro de módulo faltante, content sin arista al plan y scope curso con módulo', () => {
  const snapshot = buildFixtureSnapshot();
  const source = fixtureSource();
  const base = () => JSON.parse(JSON.stringify(buildGenerationManifest(snapshot, source, V2)));
  const codes = (m) => validateGenerationManifest(m, snapshot, source).map((e) => e.code);
  const dup = base();
  dup.items.splice(1, 0, { ...dup.items[0] });
  assertEqual(codes(dup).includes('DUPLICATE_KEY'), true, 'course_plan duplicado');
  const noIntro = base();
  noIntro.items = noIntro.items.filter((i) => i.key !== 'module_intro:m3');
  assertEqual(codes(noIntro).includes('MISSING_MODULE_INTRO'), true, 'module_intro faltante');
  const noEdge = base();
  noEdge.items.find((i) => i.key === 'content:m2c1').dependsOn = [];
  assertEqual(codes(noEdge).includes('WRONG_DEPENDENCIES'), true, 'content sin course_plan');
  const withModule = base();
  withModule.items[0].moduleId = 'm1';
  assertEqual(codes(withModule).includes('NUMBERING_MISMATCH'), true, 'course_plan con moduleId');
  const ghost = base();
  ghost.items.find((i) => i.key === 'module_intro:m4').moduleId = 'm9';
  assertEqual(codes(ghost).includes('UNKNOWN_MODULE'), true, 'module_intro de un módulo inexistente');
});

check('v2: shuffled input y jsonb round trip → mismo hash', () => {
  const snapshot = buildFixtureSnapshot();
  const shuffled = {
    ...snapshot,
    modules: [...snapshot.modules].reverse().map((m) => ({ ...m, chapters: [...m.chapters].reverse() })),
  };
  const manifest = buildGenerationManifest(snapshot, fixtureSource(), V2);
  const h1 = manifestSha256(manifest);
  assertEqual(manifestSha256(buildGenerationManifest(shuffled, fixtureSource(), V2)), h1, 'shuffled v2');
  assertEqual(manifestSha256(shuffleKeys(JSON.parse(JSON.stringify(manifest)))), h1, 'round trip v2');
});

check(`v2: hash equals pinned value ${PINNED_HASH_V2}`, () => {
  const hash = manifestSha256(buildGenerationManifest(buildFixtureSnapshot(), fixtureSource(), V2));
  assertEqual(hash, PINNED_HASH_V2, 'manifestSha256 v2 of the acceptance fixture');
});

check('v1 explícito ({rulesVersion:1}) === default: mismo hash fijado', () => {
  const hash = manifestSha256(buildGenerationManifest(buildFixtureSnapshot(), fixtureSource(), { rulesVersion: 1 }));
  assertEqual(hash, PINNED_HASH, 'hash v1 explícito');
});

console.log('');
if (failures > 0) {
  console.error(`❌ Generation Manifest determinism check FALLÓ (${failures} chequeo(s) roto(s)).`);
  process.exit(1);
}
console.log('✅ Generation Manifest determinism check OK.');
