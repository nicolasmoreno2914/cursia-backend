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

console.log('');
if (failures > 0) {
  console.error(`❌ Generation Manifest determinism check FALLÓ (${failures} chequeo(s) roto(s)).`);
  process.exit(1);
}
console.log('✅ Generation Manifest determinism check OK.');
