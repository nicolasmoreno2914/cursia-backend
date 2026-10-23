'use strict';

/**
 * Node harness for blueprint-snapshot.ts. Runs against compiled output
 * (dist path passed as argv[2], or defaults to ../dist relative to this
 * script inside the scratch build dir). Not wired into `npm test` — this
 * repo has no Jest configured (see package.json: "test": "echo 'no tests
 * yet'"). Kept as a standalone regression harness; run manually with:
 *
 *   node scripts/harness-blueprint-snapshot.js <path-to-compiled-module-dir>
 */

const path = require('path');

const distDir = process.argv[2];
if (!distDir) {
  console.error('Usage: node harness-blueprint-snapshot.js <compiled-dir>');
  process.exit(2);
}

// tsconfig.json has rootDir: "./src", so the compiled output does NOT keep
// the "src/" prefix (e.g. dist/modules/... not dist/src/modules/...).
const modPath = path.join(distDir, 'modules/course-blueprints/blueprint-snapshot.js');

let mod;
try {
  mod = require(modPath);
} catch (e) {
  console.error('FAILED TO LOAD MODULE:', modPath);
  console.error(e.message);
  process.exit(1);
}

const {
  buildBlueprintSnapshot,
  canonicalJson,
  snapshotSha256,
  validateBlueprintSnapshot,
  validateBlueprintInput,
} = mod;

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL: ${name}`);
    console.log(`  ${e.message}`);
  }
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg || 'assertEqual failed'}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function codesOf(errors) {
  return errors.map((e) => e.code).sort();
}

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const course = { id: 42, title: 'Curso de prueba' };

const modulesBase = [
  {
    id: 'm1',
    position: 1,
    title: 'Módulo 1',
    objective: 'Objetivo 1',
    exam_enabled: true,
  },
  {
    id: 'm2',
    position: 2,
    title: 'Módulo 2',
    objective: null,
    exam_enabled: false,
  },
];

const chaptersBase = [
  {
    id: 'c1',
    module_id: 'm1',
    position: 1,
    title: 'Cap 1',
    objective: 'obj c1',
    video_enabled: true,
  },
  {
    id: 'c2',
    module_id: 'm1',
    position: 2,
    title: 'Cap 2',
    objective: null,
    video_enabled: false,
  },
  {
    id: 'c3',
    module_id: 'm2',
    position: 1,
    title: 'Cap 3',
    objective: undefined, // undefined on purpose
    video_enabled: true,
  },
];

// ---------------------------------------------------------------------
// Step 1 cases (RED before implementation, GREEN after)
// ---------------------------------------------------------------------

check('same rows in different order -> same hash', () => {
  const snapA = buildBlueprintSnapshot(course, modulesBase, chaptersBase);
  const shuffledModules = [modulesBase[1], modulesBase[0]];
  const shuffledChapters = [chaptersBase[2], chaptersBase[0], chaptersBase[1]];
  const snapB = buildBlueprintSnapshot(course, shuffledModules, shuffledChapters);
  assertEqual(snapshotSha256(snapA), snapshotSha256(snapB), 'hashes should match regardless of row order');
});

check('objects with keys in different order -> same canonicalJson', () => {
  const snap = buildBlueprintSnapshot(course, modulesBase, chaptersBase);
  // Build an equivalent object by hand with keys inserted in a different order,
  // then re-derive it through buildBlueprintSnapshot to prove canonicalJson
  // itself imposes a fixed order regardless of how callers assemble rows.
  const reorderedModuleRow = {
    exam_enabled: modulesBase[0].exam_enabled,
    title: modulesBase[0].title,
    id: modulesBase[0].id,
    objective: modulesBase[0].objective,
    position: modulesBase[0].position,
  };
  const snap2 = buildBlueprintSnapshot(course, [reorderedModuleRow, modulesBase[1]], chaptersBase);
  assertEqual(canonicalJson(snap), canonicalJson(snap2), 'canonicalJson should be identical');
});

check('changing a title -> different hash', () => {
  const snapA = buildBlueprintSnapshot(course, modulesBase, chaptersBase);
  const modulesChanged = [{ ...modulesBase[0], title: 'Módulo 1 (editado)' }, modulesBase[1]];
  const snapB = buildBlueprintSnapshot(course, modulesChanged, chaptersBase);
  assert(snapshotSha256(snapA) !== snapshotSha256(snapB), 'hash must change when a title changes');
});

check('objective undefined and null produce the same result (null)', () => {
  const rowUndef = { ...modulesBase[0], objective: undefined };
  const rowNull = { ...modulesBase[0], objective: null };
  const snapUndef = buildBlueprintSnapshot(course, [rowUndef, modulesBase[1]], chaptersBase);
  const snapNull = buildBlueprintSnapshot(course, [rowNull, modulesBase[1]], chaptersBase);
  assertEqual(snapUndef.modules[0].objective, null);
  assertEqual(snapNull.modules[0].objective, null);
  assertEqual(canonicalJson(snapUndef), canonicalJson(snapNull));
});

check('gaps in positions are valid (no contiguity requirement, R2)', () => {
  const gappedModules = [
    { id: 'm1', position: 1, title: 'M1', objective: null, exam_enabled: false },
    { id: 'm2', position: 5, title: 'M2', objective: null, exam_enabled: false },
  ];
  const gappedChapters = [
    { id: 'c1', module_id: 'm1', position: 10, title: 'C1', objective: null, video_enabled: false },
    { id: 'c2', module_id: 'm2', position: 20, title: 'C2', objective: null, video_enabled: false },
  ];
  const snap = buildBlueprintSnapshot(course, gappedModules, gappedChapters);
  const errors = validateBlueprintSnapshot(snap);
  assertEqual(errors, [], 'gaps must not produce validation errors');
});

check('validate: EMPTY_COURSE', () => {
  const snap = buildBlueprintSnapshot(course, [], []);
  assertEqual(codesOf(validateBlueprintSnapshot(snap)), ['EMPTY_COURSE']);
});

check('validate: EMPTY_MODULE', () => {
  const mods = [{ id: 'm1', position: 1, title: 'M1', objective: null, exam_enabled: false }];
  const snap = buildBlueprintSnapshot(course, mods, []);
  assertEqual(codesOf(validateBlueprintSnapshot(snap)), ['EMPTY_MODULE']);
});

check('validate: BLANK_TITLE (course, module, chapter — including whitespace-only)', () => {
  const blankCourse = { id: 1, title: '   ' };
  const mods = [{ id: 'm1', position: 1, title: '  ', objective: null, exam_enabled: false }];
  const chaps = [{ id: 'c1', module_id: 'm1', position: 1, title: '', objective: null, video_enabled: false }];
  const snap = buildBlueprintSnapshot(blankCourse, mods, chaps);
  const codes = codesOf(validateBlueprintSnapshot(snap));
  assertEqual(codes, ['BLANK_TITLE', 'BLANK_TITLE', 'BLANK_TITLE']);
});

check('validate: TITLE_TOO_LONG (> 255 after trim)', () => {
  const longTitle = '  ' + 'a'.repeat(256) + '  ';
  const mods = [{ id: 'm1', position: 1, title: longTitle, objective: null, exam_enabled: false }];
  const chaps = [{ id: 'c1', module_id: 'm1', position: 1, title: 'ok', objective: null, video_enabled: false }];
  const snap = buildBlueprintSnapshot(course, mods, chaps);
  assertEqual(codesOf(validateBlueprintSnapshot(snap)), ['TITLE_TOO_LONG']);
  // exactly 255 after trim must be fine
  const exact255 = '  ' + 'a'.repeat(255) + '  ';
  const modsOk = [{ id: 'm1', position: 1, title: exact255, objective: null, exam_enabled: false }];
  const snapOk = buildBlueprintSnapshot(course, modsOk, chaps);
  assertEqual(codesOf(validateBlueprintSnapshot(snapOk)), []);
});

check('validate: DUPLICATE_POSITION for modules', () => {
  const mods = [
    { id: 'm1', position: 1, title: 'M1', objective: null, exam_enabled: false },
    { id: 'm2', position: 1, title: 'M2', objective: null, exam_enabled: false },
  ];
  const chaps = [
    { id: 'c1', module_id: 'm1', position: 1, title: 'C1', objective: null, video_enabled: false },
    { id: 'c2', module_id: 'm2', position: 1, title: 'C2', objective: null, video_enabled: false },
  ];
  const snap = buildBlueprintSnapshot(course, mods, chaps);
  assertEqual(codesOf(validateBlueprintSnapshot(snap)), ['DUPLICATE_POSITION']);
});

check('validate: DUPLICATE_POSITION for chapters within the same module', () => {
  const mods = [{ id: 'm1', position: 1, title: 'M1', objective: null, exam_enabled: false }];
  const chaps = [
    { id: 'c1', module_id: 'm1', position: 1, title: 'C1', objective: null, video_enabled: false },
    { id: 'c2', module_id: 'm1', position: 1, title: 'C2', objective: null, video_enabled: false },
  ];
  const snap = buildBlueprintSnapshot(course, mods, chaps);
  assertEqual(codesOf(validateBlueprintSnapshot(snap)), ['DUPLICATE_POSITION']);
});

check('duplicate positions across DIFFERENT modules\' chapters are NOT an error', () => {
  const mods = [
    { id: 'm1', position: 1, title: 'M1', objective: null, exam_enabled: false },
    { id: 'm2', position: 2, title: 'M2', objective: null, exam_enabled: false },
  ];
  const chaps = [
    { id: 'c1', module_id: 'm1', position: 1, title: 'C1', objective: null, video_enabled: false },
    { id: 'c2', module_id: 'm2', position: 1, title: 'C2', objective: null, video_enabled: false },
  ];
  const snap = buildBlueprintSnapshot(course, mods, chaps);
  assertEqual(codesOf(validateBlueprintSnapshot(snap)), []);
});

check('validateBlueprintInput: ORPHAN_CHAPTER', () => {
  const mods = [{ id: 'm1', position: 1, title: 'M1', objective: null, exam_enabled: false }];
  const chaps = [
    { id: 'c1', module_id: 'm1', position: 1, title: 'C1', objective: null, video_enabled: false },
    { id: 'c2', module_id: 'DOES_NOT_EXIST', position: 2, title: 'C2', objective: null, video_enabled: false },
  ];
  const errors = validateBlueprintInput(course, mods, chaps);
  assertEqual(codesOf(errors), ['ORPHAN_CHAPTER']);
});

check('buildBlueprintSnapshot throws loudly on orphan chapter (fail-hard guard)', () => {
  const mods = [{ id: 'm1', position: 1, title: 'M1', objective: null, exam_enabled: false }];
  const chaps = [{ id: 'c1', module_id: 'GHOST', position: 1, title: 'C1', objective: null, video_enabled: false }];
  let threw = false;
  try {
    buildBlueprintSnapshot(course, mods, chaps);
  } catch (e) {
    threw = true;
    assert(/ORPHAN_CHAPTER/.test(e.message), 'error message should mention ORPHAN_CHAPTER');
  }
  assert(threw, 'expected buildBlueprintSnapshot to throw on orphan chapter');
});

check('buildBlueprintSnapshot never mutates input arrays', () => {
  const mods = [
    { id: 'm2', position: 2, title: 'M2', objective: null, exam_enabled: false },
    { id: 'm1', position: 1, title: 'M1', objective: null, exam_enabled: false },
  ];
  const chaps = [
    { id: 'c2', module_id: 'm1', position: 2, title: 'C2', objective: null, video_enabled: false },
    { id: 'c1', module_id: 'm1', position: 1, title: 'C1', objective: null, video_enabled: false },
  ];
  const modsCopy = JSON.stringify(mods);
  const chapsCopy = JSON.stringify(chaps);
  buildBlueprintSnapshot(course, mods, chaps);
  assertEqual(JSON.stringify(mods), modsCopy, 'modules array order/content must be untouched');
  assertEqual(JSON.stringify(chaps), chapsCopy, 'chapters array order/content must be untouched');
});

check('position coercion: string-like numbers still sort/hash correctly (defensive Number())', () => {
  const mods = [
    { id: 'm1', position: '2', title: 'M1', objective: null, exam_enabled: false },
    { id: 'm2', position: '1', title: 'M2', objective: null, exam_enabled: false },
  ];
  const snap = buildBlueprintSnapshot(course, mods, []);
  assertEqual(snap.modules.map((m) => m.id), ['m2', 'm1']);
  assertEqual(snap.modules[0].position, 1);
  assert(typeof snap.modules[0].position === 'number', 'position must be coerced to number');
});

check('ALL error codes together (except EMPTY_COURSE, mutually exclusive with having modules)', () => {
  const bigCourse = { id: 1, title: 'a'.repeat(300) }; // TITLE_TOO_LONG on course
  const mods = [
    { id: 'm1', position: 1, title: '   ', objective: null, exam_enabled: false }, // BLANK_TITLE
    { id: 'm2', position: 1, title: 'M2', objective: null, exam_enabled: false }, // DUPLICATE_POSITION (module)
    { id: 'm3', position: 3, title: 'M3', objective: null, exam_enabled: false }, // EMPTY_MODULE
  ];
  const chaps = [
    { id: 'c1', module_id: 'm1', position: 1, title: 'ok', objective: null, video_enabled: false },
    { id: 'c2', module_id: 'm2', position: 1, title: 'ok', objective: null, video_enabled: false },
    { id: 'c3', module_id: 'm2', position: 1, title: 'ok', objective: null, video_enabled: false }, // DUPLICATE_POSITION (chapter)
    { id: 'c4', module_id: 'ghost', position: 1, title: 'ok', objective: null, video_enabled: false }, // ORPHAN_CHAPTER
  ];
  const errors = validateBlueprintInput(bigCourse, mods, chaps);
  const codes = codesOf(errors);
  assert(codes.includes('TITLE_TOO_LONG'), 'expected TITLE_TOO_LONG');
  assert(codes.includes('BLANK_TITLE'), 'expected BLANK_TITLE');
  assert(codes.includes('DUPLICATE_POSITION'), 'expected DUPLICATE_POSITION (at least one)');
  assert(codes.filter((c) => c === 'DUPLICATE_POSITION').length === 2, 'expected 2 DUPLICATE_POSITION (module + chapter)');
  assert(codes.includes('EMPTY_MODULE'), 'expected EMPTY_MODULE');
  assert(codes.includes('ORPHAN_CHAPTER'), 'expected ORPHAN_CHAPTER');
  assert(!codes.includes('EMPTY_COURSE'), 'must not report EMPTY_COURSE when modules exist');
});

check('hash format: 64 lowercase hex characters', () => {
  const snap = buildBlueprintSnapshot(course, modulesBase, chaptersBase);
  const hash = snapshotSha256(snap);
  assert(/^[0-9a-f]{64}$/.test(hash), `hash "${hash}" is not 64 lowercase hex chars`);
});

check('regression: known fixed snapshot yields a pinned hash', () => {
  const fixedCourse = { id: 999, title: 'Curso Fijo' };
  const fixedModules = [
    { id: 'mod-a', position: 1, title: 'Módulo A', objective: 'Obj A', exam_enabled: true },
    { id: 'mod-b', position: 2, title: 'Módulo B', objective: null, exam_enabled: false },
  ];
  const fixedChapters = [
    { id: 'cap-a1', module_id: 'mod-a', position: 1, title: 'Cap A1', objective: 'Obj A1', video_enabled: true },
    { id: 'cap-a2', module_id: 'mod-a', position: 2, title: 'Cap A2', objective: null, video_enabled: false },
    { id: 'cap-b1', module_id: 'mod-b', position: 1, title: 'Cap B1', objective: null, video_enabled: true },
  ];
  const snap = buildBlueprintSnapshot(fixedCourse, fixedModules, fixedChapters);
  const json = canonicalJson(snap);
  const hash = snapshotSha256(snap);

  const PINNED_JSON =
    '{"schemaVersion":1,"course":{"id":999,"title":"Curso Fijo","structureVersion":"dynamic"},"modules":[{"id":"mod-a","position":1,"title":"Módulo A","objective":"Obj A","examEnabled":true,"chapters":[{"id":"cap-a1","position":1,"title":"Cap A1","objective":"Obj A1","videoEnabled":true},{"id":"cap-a2","position":2,"title":"Cap A2","objective":null,"videoEnabled":false}]},{"id":"mod-b","position":2,"title":"Módulo B","objective":null,"examEnabled":false,"chapters":[{"id":"cap-b1","position":1,"title":"Cap B1","objective":null,"videoEnabled":true}]}]}';
  const PINNED_HASH = require('crypto').createHash('sha256').update(PINNED_JSON, 'utf8').digest('hex');

  assertEqual(json, PINNED_JSON, 'canonicalJson drifted from the pinned regression value');
  assertEqual(hash, PINNED_HASH, 'snapshotSha256 drifted from the pinned regression value');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
