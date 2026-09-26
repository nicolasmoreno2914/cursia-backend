#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — R3 (Blueprint v2 + perfiles de curso). Check sin Jest, contra
// el código COMPILADO en dist/ (correr "npm run build" antes).
//
// Parte pura (siempre):
//   - v1 del snapshot byte-idéntico (sha fijado del fixture de
//     scripts/harness-blueprint-snapshot.js + hash fijado del Manifest v1 de
//     check-generation-manifest-determinism.js);
//   - v2: forma, orden de claves, determinismo, validador;
//   - readSnapshotAsV2 (compat §S);
//   - config DYNAMIC_MANIFEST_RULES_VERSION=3 (lock v2; Manifest v3 desde R4);
//   - perfiles: defaults (ambos sets de pesos), validadores, sha determinístico;
//   - perfiles FUERA de las huellas de invalidación.
// Parte DB (default; se salta SOLO con --pure-only, y lo dice): Postgres 16
// local y desechable (initdb en un dir temporal, puerto libre elegido al
// vuelo — nunca 5570 —, se destruye al final pase lo que pase). Aplica las
// migraciones reales y ejercita los servicios compilados.
//
// Usage: node scripts/check-v21-blueprint-profiles.js [--pure-only] [path/to/dist]

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
const distArg = args.find((a) => !a.startsWith('--'));
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), distArg || 'dist');

function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const rulesCfg = loadDist('modules/generation-manifests/manifest-rules-config.js');
const manifestBuilder = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const fingerprints = loadDist('modules/invalidation/fingerprints.js');
const profiles = loadDist('modules/course-profiles/course-profiles.js');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.message ? err.message.split('\n').join('\n   ') : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg}: esperado ${y}, encontrado ${x}`);
}
function throwsRe(fn, re, msg) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert(err, `${msg}: no lanzó`);
  assert(re.test(err.message), `${msg}: mensaje inesperado "${err.message}"`);
}
async function rejectsRe(p, re, msg, status) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${msg}: no lanzó`);
  const text = err.message + ' ' + JSON.stringify(err.getResponse ? err.getResponse() : '');
  assert(re.test(text), `${msg}: mensaje inesperado "${text}"`);
  if (status !== undefined) assert(err.getStatus && err.getStatus() === status, `${msg}: status ${err.getStatus && err.getStatus()} (esperado ${status})`);
  return err;
}
function shuffleKeys(value) {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).reverse()) out[k] = shuffleKeys(value[k]);
    return out;
  }
  return value;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// Fixture del "regression: known fixed snapshot yields a pinned hash" de
// scripts/harness-blueprint-snapshot.js. Sha calculado con el build ANTERIOR a
// R3 (f0da7f6) y fijado acá.
const V1_FIXED_COURSE = { id: 999, title: 'Curso Fijo' };
const V1_FIXED_MODULES = [
  { id: 'mod-a', position: 1, title: 'Módulo A', objective: 'Obj A', exam_enabled: true },
  { id: 'mod-b', position: 2, title: 'Módulo B', objective: null, exam_enabled: false },
];
const V1_FIXED_CHAPTERS = [
  { id: 'cap-a1', module_id: 'mod-a', position: 1, title: 'Cap A1', objective: 'Obj A1', video_enabled: true },
  { id: 'cap-a2', module_id: 'mod-a', position: 2, title: 'Cap A2', objective: null, video_enabled: false },
  { id: 'cap-b1', module_id: 'mod-b', position: 1, title: 'Cap B1', objective: null, video_enabled: true },
];
const V1_PINNED_JSON =
  '{"schemaVersion":1,"course":{"id":999,"title":"Curso Fijo","structureVersion":"dynamic"},"modules":[{"id":"mod-a","position":1,"title":"Módulo A","objective":"Obj A","examEnabled":true,"chapters":[{"id":"cap-a1","position":1,"title":"Cap A1","objective":"Obj A1","videoEnabled":true},{"id":"cap-a2","position":2,"title":"Cap A2","objective":null,"videoEnabled":false}]},{"id":"mod-b","position":2,"title":"Módulo B","objective":null,"examEnabled":false,"chapters":[{"id":"cap-b1","position":1,"title":"Cap B1","objective":null,"videoEnabled":true}]}]}';
const V1_PINNED_SHA = 'e10e12bd391fe9ac861e3b389a092eca1cf28d1427e080d1ba0c4fc60fb4b7e0';

// Manifest v1 del fixture de check-generation-manifest-determinism.js.
const MANIFEST_V1_PINNED = 'f7eaa79d7f88f474ff8459d6f31d1f1ae6055f8c6068f50ab889cdbf71d9cb46';
function manifestFixtureSnapshot() {
  const ch = (id, position, videoEnabled) => ({ id, position, title: `Chapter ${id}`, objective: null, videoEnabled });
  const mod = (id, position, examEnabled, chapters) => ({ id, position, title: `Module ${id}`, objective: null, examEnabled, chapters });
  return {
    schemaVersion: 1,
    course: { id: 12, title: 'Curso Fixture', structureVersion: 'dynamic' },
    modules: [
      mod('m1', 0, true, [ch('m1c1', 0, true), ch('m1c2', 1, false)]),
      mod('m2', 1, false, [ch('m2c1', 0, true), ch('m2c2', 1, false), ch('m2c3', 2, true), ch('m2c4', 3, false), ch('m2c5', 4, false)]),
      mod('m3', 2, true, [ch('m3c1', 0, true)]),
      mod('m4', 3, true, [ch('m4c1', 0, false), ch('m4c2', 1, true), ch('m4c3', 2, true)]),
    ],
  };
}

const V2_COURSE = { id: 999, title: 'Curso Fijo', finalExam: true, activityEngine: 'h5p' };
const V2_CHAPTERS = V1_FIXED_CHAPTERS.map((c, i) => ({ ...c, activity_enabled: i !== 1 }));
const V2_PINNED_JSON =
  '{"schemaVersion":2,"course":{"id":999,"title":"Curso Fijo","structureVersion":"dynamic","finalExam":true,"activityEngine":"h5p"},"modules":[{"id":"mod-a","position":1,"title":"Módulo A","objective":"Obj A","examEnabled":true,"chapters":[{"id":"cap-a1","position":1,"title":"Cap A1","objective":"Obj A1","videoEnabled":true,"activityEnabled":true},{"id":"cap-a2","position":2,"title":"Cap A2","objective":null,"videoEnabled":false,"activityEnabled":false}]},{"id":"mod-b","position":2,"title":"Módulo B","objective":null,"examEnabled":false,"chapters":[{"id":"cap-b1","position":1,"title":"Cap B1","objective":null,"videoEnabled":true,"activityEnabled":true}]}]}';

// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  await check('v1: buildBlueprintSnapshot byte-idéntico (canonicalJson y sha fijados antes de R3)', () => {
    const s = snap.buildBlueprintSnapshot(V1_FIXED_COURSE, V1_FIXED_MODULES, V1_FIXED_CHAPTERS);
    eq(snap.canonicalJson(s), V1_PINNED_JSON, 'canonicalJson v1');
    eq(snap.snapshotSha256(s), V1_PINNED_SHA, 'snapshotSha256 v1');
  });

  await check('v1: filas con activity_enabled extra NO cambian el snapshot v1 (el builder v1 lo ignora)', () => {
    const s = snap.buildBlueprintSnapshot(V1_FIXED_COURSE, V1_FIXED_MODULES, V2_CHAPTERS);
    eq(snap.snapshotSha256(s), V1_PINNED_SHA, 'sha v1 con filas v2');
  });

  await check('v1: Manifest v1 del fixture de determinismo sigue en su hash fijado', () => {
    const m = manifestBuilder.buildGenerationManifest(manifestFixtureSnapshot(), {
      courseId: 12, blueprintId: 31, blueprintNumber: 3, blueprintSha256: 'a'.repeat(64),
    });
    eq(manifestBuilder.manifestSha256(m), MANIFEST_V1_PINNED, 'manifestSha256 v1');
  });

  await check('v2: forma exacta y orden de claves fijo (canonicalJsonV2 fijado)', () => {
    const s = snap.buildBlueprintSnapshotV2(V2_COURSE, V1_FIXED_MODULES, V2_CHAPTERS);
    eq(snap.canonicalJsonV2(s), V2_PINNED_JSON, 'canonicalJsonV2');
    eq(Object.keys(s), ['schemaVersion', 'course', 'modules'], 'claves raíz');
    eq(Object.keys(s.course), ['id', 'title', 'structureVersion', 'finalExam', 'activityEngine'], 'claves course');
    eq(Object.keys(s.modules[0].chapters[0]), ['id', 'position', 'title', 'objective', 'videoEnabled', 'activityEnabled'], 'claves chapter');
    eq(snap.snapshotSha256V2(s), require('crypto').createHash('sha256').update(V2_PINNED_JSON, 'utf8').digest('hex'), 'sha v2');
  });

  await check('v2: determinismo (filas desordenadas, input sin mutar, round trip jsonb con claves mezcladas)', () => {
    const mods = JSON.parse(JSON.stringify(V1_FIXED_MODULES));
    const chs = JSON.parse(JSON.stringify(V2_CHAPTERS));
    const a = snap.buildBlueprintSnapshotV2(V2_COURSE, mods, chs);
    const b = snap.buildBlueprintSnapshotV2(V2_COURSE, [...mods].reverse(), [...chs].reverse());
    eq(snap.snapshotSha256V2(b), snap.snapshotSha256V2(a), 'sha con filas invertidas');
    eq(mods, V1_FIXED_MODULES, 'módulos sin mutar');
    eq(chs, V2_CHAPTERS, 'capítulos sin mutar');
    const rt = snap.recanonicalizeBlueprintSnapshotV2(shuffleKeys(JSON.parse(snap.canonicalJsonV2(a))));
    eq(snap.canonicalJsonV2(rt), snap.canonicalJsonV2(a), 'recanonicalize tras claves mezcladas');
  });

  await check('v2: cada toggle nuevo cambia el sha; v2 ≠ v1', () => {
    const base = snap.snapshotSha256V2(snap.buildBlueprintSnapshotV2(V2_COURSE, V1_FIXED_MODULES, V2_CHAPTERS));
    const shas = new Set([base, V1_PINNED_SHA]);
    shas.add(snap.snapshotSha256V2(snap.buildBlueprintSnapshotV2({ ...V2_COURSE, finalExam: false }, V1_FIXED_MODULES, V2_CHAPTERS)));
    shas.add(snap.snapshotSha256V2(snap.buildBlueprintSnapshotV2({ ...V2_COURSE, activityEngine: 'scorm' }, V1_FIXED_MODULES, V2_CHAPTERS)));
    shas.add(snap.snapshotSha256V2(snap.buildBlueprintSnapshotV2(V2_COURSE, V1_FIXED_MODULES, V2_CHAPTERS.map((c) => ({ ...c, activity_enabled: true })))));
    eq(shas.size, 5, 'shas distintos');
  });

  await check('v2: fail loud — activity_enabled ausente, engine inválido, finalExam no booleano, huérfano', () => {
    const noAct = V1_FIXED_CHAPTERS.map((c) => ({ ...c }));
    throwsRe(() => snap.buildBlueprintSnapshotV2(V2_COURSE, V1_FIXED_MODULES, noAct), /BLUEPRINT_V2_INVALID_INPUT.*activity_enabled/, 'sin activity_enabled');
    throwsRe(() => snap.buildBlueprintSnapshotV2({ ...V2_COURSE, activityEngine: 'hvp' }, V1_FIXED_MODULES, V2_CHAPTERS), /BLUEPRINT_V2_INVALID_INPUT.*activityEngine/, 'engine');
    throwsRe(() => snap.buildBlueprintSnapshotV2({ ...V2_COURSE, finalExam: 1 }, V1_FIXED_MODULES, V2_CHAPTERS), /BLUEPRINT_V2_INVALID_INPUT.*finalExam/, 'finalExam');
    const orphan = [...V2_CHAPTERS, { id: 'x', module_id: 'ghost', position: 1, title: 'X', objective: null, video_enabled: false, activity_enabled: true }];
    throwsRe(() => snap.buildBlueprintSnapshotV2(V2_COURSE, V1_FIXED_MODULES, orphan), /ORPHAN_CHAPTER/, 'huérfano');
    const codes = snap.validateBlueprintInputV2({ ...V2_COURSE, activityEngine: 'x' }, V1_FIXED_MODULES, orphan).map((e) => e.code);
    assert(codes.includes('ORPHAN_CHAPTER') && codes.includes('INVALID_ACTIVITY_ENGINE'), `códigos: ${codes}`);
  });

  await check('v2: validateBlueprintSnapshotV2 ([] si válido; reglas v1 + toggles) y blueprintV2Warnings (NO_GRADED_ITEMS)', () => {
    const s = snap.buildBlueprintSnapshotV2(V2_COURSE, V1_FIXED_MODULES, V2_CHAPTERS);
    eq(snap.validateBlueprintSnapshotV2(s), [], 'válido');
    const bad = JSON.parse(JSON.stringify(s));
    bad.course.activityEngine = 'hvp';
    bad.modules[0].chapters[0].activityEnabled = 'yes';
    bad.modules[1].title = '  ';
    const codes = snap.validateBlueprintSnapshotV2(bad).map((e) => e.code);
    eq(codes.sort(), ['BLANK_TITLE', 'INVALID_ACTIVITY_ENABLED', 'INVALID_ACTIVITY_ENGINE'], 'códigos');
    eq(snap.blueprintV2Warnings(s), [], 'sin advertencias');
    const none = snap.buildBlueprintSnapshotV2({ ...V2_COURSE, finalExam: false },
      V1_FIXED_MODULES.map((m) => ({ ...m, exam_enabled: false })), V2_CHAPTERS.map((c) => ({ ...c, activity_enabled: false })));
    eq(snap.blueprintV2Warnings(none).map((w) => w.code), ['NO_GRADED_ITEMS'], 'nada calificable');
    eq(snap.validateBlueprintSnapshotV2(none), [], 'la advertencia no bloquea');
  });

  await check('readSnapshotAsV2: v1 → finalExam=false, activityEngine=scorm, activityEnabled=true (sin tocar el sha v1)', () => {
    const v1 = snap.buildBlueprintSnapshot(V1_FIXED_COURSE, V1_FIXED_MODULES, V1_FIXED_CHAPTERS);
    const before = snap.canonicalJson(v1);
    const v2 = snap.readSnapshotAsV2(v1);
    eq(v2.schemaVersion, 2, 'schemaVersion');
    eq(v2.course, { id: 999, title: 'Curso Fijo', structureVersion: 'dynamic', finalExam: false, activityEngine: 'scorm' }, 'course');
    assert(v2.modules.every((m) => m.chapters.every((c) => c.activityEnabled === true)), 'activityEnabled=true');
    eq(v2.modules.map((m) => m.chapters.map((c) => c.videoEnabled)), [[true, false], [true]], 'videoEnabled preservado');
    eq(snap.validateBlueprintSnapshotV2(v2), [], 'la vista v2 valida');
    eq(snap.canonicalJson(v1), before, 'v1 sin mutar');
    eq(snap.snapshotSha256(v1), V1_PINNED_SHA, 'sha v1 intacto');
  });

  await check('readSnapshotAsV2: v2 → mismo snapshot canónico (también desde jsonb con claves mezcladas); otro schemaVersion → throw', () => {
    const s = snap.buildBlueprintSnapshotV2(V2_COURSE, V1_FIXED_MODULES, V2_CHAPTERS);
    eq(snap.canonicalJsonV2(snap.readSnapshotAsV2(shuffleKeys(s))), V2_PINNED_JSON, 'v2 identidad');
    throwsRe(() => snap.readSnapshotAsV2({ schemaVersion: 3, course: {}, modules: [] }), /schemaVersion no soportado: 3/, 'v3');
    eq(snap.anySnapshotSha256(snap.buildBlueprintSnapshot(V1_FIXED_COURSE, V1_FIXED_MODULES, V1_FIXED_CHAPTERS)), V1_PINNED_SHA, 'anySnapshotSha256 v1');
  });

  await check('config: DYNAMIC_MANIFEST_RULES_VERSION 1/2 sin cambios; 3 → Blueprint v2 y Manifest v3 (R4); basura → throw', () => {
    const E = rulesCfg.MANIFEST_RULES_VERSION_ENV;
    eq(rulesCfg.readManifestRulesVersionConfig({}), 1, 'ausente');
    eq(rulesCfg.readManifestRulesVersionConfig({ [E]: '1' }), 1, '1');
    eq(rulesCfg.readManifestRulesVersionConfig({ [E]: '2' }), 2, '2');
    // R4 levantó NOT_IMPLEMENTED_RULES_V3: el Manifest v3 ya existe.
    eq(rulesCfg.readManifestRulesVersionConfig({ [E]: '3' }), 3, 'manifest v3 (R4)');
    for (const bad of ['4', 'v3', ' 3']) throwsRe(() => rulesCfg.readConfiguredRulesVersion({ [E]: bad }), /inválido/, `"${bad}"`);
    eq([1, 2, 3].map((r) => rulesCfg.blueprintSchemaVersionForRules(r)), [1, 1, 2], 'schemaVersion por regla');
    eq(rulesCfg.blueprintSchemaVersionForRules(rulesCfg.readConfiguredRulesVersion({})), 1, 'default staging → v1');
  });

  // ── Perfiles ──────────────────────────────────────────────────────────────
  await check('perfiles: defaultPresentationProfile exacto', () => {
    eq(profiles.defaultPresentationProfile(), { themeFamily: 'aula-clara', mode: 'light', brandSeed: null, themeVersion: 1 }, 'default');
    eq(profiles.validatePresentationProfile(profiles.defaultPresentationProfile()), [], 'valida');
    eq([...profiles.THEME_FAMILY_IDS], ['aula-clara', 'institucional', 'editorial', 'tecnico', 'vibrante', 'oscuro-premium'], 'familias (copia de R1)');
  });

  const COMMON = {
    assessmentProfileVersion: 1,
    passingGrade: 70,
    overrides: { activity: null, video: null, exam: null, finalExam: null },
    attempts: { activity: 0, video: 0, exam: 3, finalExam: 3 },
    gradeMethod: { activity: 'highest', video: 'highest', exam: 'highest', finalExam: 'highest' },
  };
  const COMPLETION = { requireAllChapterActivities: true, requireExams: true, requireCourseGradePass: false };

  await check('perfiles: defaultAssessmentProfile con examen final (30/50/20) y sin (40/60), exactos y válidos', () => {
    const withF = profiles.defaultAssessmentProfile({ finalExam: true });
    const noF = profiles.defaultAssessmentProfile({ finalExam: false });
    eq(withF, { ...COMMON, categoryWeights: { practice: 30, moduleExams: 50, finalExam: 20 }, courseCompletion: COMPLETION }, 'con final');
    eq(noF, { ...COMMON, categoryWeights: { practice: 40, moduleExams: 60 }, courseCompletion: COMPLETION }, 'sin final');
    eq(profiles.validateAssessmentProfile(withF, { finalExam: true }), [], 'con final valida');
    eq(profiles.validateAssessmentProfile(noF, { finalExam: false }), [], 'sin final valida');
    eq(profiles.validateAssessmentProfile(withF, { finalExam: false }).map((e) => e.code), ['WEIGHTS_FINAL_EXAM_MISMATCH'], 'pesos con final en curso sin final');
    eq(profiles.validateAssessmentProfile(noF, { finalExam: true }).map((e) => e.code), ['WEIGHTS_FINAL_EXAM_MISMATCH'], 'pesos sin final en curso con final');
    throwsRe(() => profiles.defaultAssessmentProfile({}), /finalExam debe ser boolean/, 'sin finalExam');
  });

  await check('perfiles: validador de evaluación — códigos explícitos por cada regla', () => {
    const base = () => JSON.parse(JSON.stringify(profiles.defaultAssessmentProfile({ finalExam: true })));
    const codesOf = (p, fe = true) => profiles.validateAssessmentProfile(p, { finalExam: fe }).map((e) => e.code);
    const cases = [
      [(p) => { p.passingGrade = 101; }, 'INVALID_PASSING_GRADE'],
      [(p) => { p.passingGrade = 70.5; }, 'INVALID_PASSING_GRADE'],
      [(p) => { p.passingGrade = -1; }, 'INVALID_PASSING_GRADE'],
      [(p) => { p.overrides.exam = 120; }, 'INVALID_OVERRIDE'],
      [(p) => { p.overrides.activity = '80'; }, 'INVALID_OVERRIDE'],
      [(p) => { p.attempts.exam = -1; }, 'INVALID_ATTEMPTS'],
      [(p) => { p.attempts.video = 1.5; }, 'INVALID_ATTEMPTS'],
      [(p) => { p.gradeMethod.exam = 'best'; }, 'INVALID_GRADE_METHOD'],
      [(p) => { p.categoryWeights.practice = 31; }, 'WEIGHTS_SUM_NOT_100'],
      [(p) => { p.categoryWeights.practice = -10; p.categoryWeights.moduleExams = 90; }, 'INVALID_WEIGHT'],
      [(p) => { p.courseCompletion.requireExams = 'yes'; }, 'INVALID_COMPLETION_FLAG'],
      [(p) => { p.assessmentProfileVersion = 2; }, 'INVALID_PROFILE_VERSION'],
      [(p) => { p.extra = 1; }, 'UNKNOWN_FIELD'],
      [(p) => { p.overrides.quiz = null; }, 'UNKNOWN_FIELD'],
      [(p) => { delete p.attempts; }, 'MISSING_FIELD'],
      [(p) => { delete p.gradeMethod.finalExam; }, 'MISSING_FIELD'],
    ];
    for (const [mut, code] of cases) {
      const p = base();
      mut(p);
      const codes = codesOf(p);
      assert(codes.includes(code), `${mut.toString()} → esperaba ${code}, fue [${codes}]`);
    }
    eq(codesOf('x'), ['INVALID_TYPE'], 'no objeto');
    const ok = base();
    ok.overrides.exam = 80;
    ok.attempts.finalExam = 0;
    ok.gradeMethod.activity = 'last';
    eq(codesOf(ok), [], 'overrides/attempts/gradeMethod válidos');
  });

  await check('perfiles: validador de presentación — familia, modo, seed hex, versión, claves exactas', () => {
    const codesOf = (p) => profiles.validatePresentationProfile(p).map((e) => e.code);
    const d = profiles.defaultPresentationProfile();
    eq(codesOf({ ...d, themeFamily: 'oscuro' }), ['INVALID_THEME_FAMILY'], 'familia');
    eq(codesOf({ ...d, mode: 'sepia' }), ['INVALID_THEME_MODE'], 'modo');
    eq(codesOf({ ...d, themeVersion: 0 }), ['INVALID_THEME_VERSION'], 'versión');
    eq(codesOf({ ...d, brandSeed: { accent: 'red' } }), ['INVALID_BRAND_SEED_COLOR'], 'accent');
    eq(codesOf({ ...d, brandSeed: { moduleColors: ['#112233', '#12345'] } }), ['INVALID_BRAND_SEED_COLOR'], 'moduleColors');
    eq(codesOf({ ...d, brandSeed: { accent: '#112233', font: 'x' } }), ['UNKNOWN_FIELD'], 'seed clave extra');
    eq(codesOf({ ...d, brandSeed: 'x' }), ['INVALID_BRAND_SEED'], 'seed no objeto');
    eq(codesOf({ themeFamily: 'tecnico', mode: 'dark', themeVersion: 1 }), ['MISSING_FIELD'], 'falta brandSeed');
    eq(codesOf({ themeFamily: 'tecnico', mode: 'dark', brandSeed: { accent: '#AABBCC', moduleColors: ['#010203'] }, themeVersion: 2 }), [], 'válido con seed');
  });

  await check('perfiles: sha determinístico (orden de claves irrelevante; cualquier valor lo cambia); normalize fija el orden', () => {
    const a = profiles.defaultAssessmentProfile({ finalExam: true });
    const h = profiles.profileSha256(a);
    assert(/^[0-9a-f]{64}$/.test(h), 'hex 64');
    eq(profiles.profileSha256(shuffleKeys(a)), h, 'claves mezcladas');
    eq(profiles.profileSha256(profiles.normalizeAssessmentProfile(shuffleKeys(a))), h, 'normalize');
    eq(Object.keys(profiles.normalizeAssessmentProfile(shuffleKeys(a))), Object.keys(a), 'orden de claves normalizado');
    const b = JSON.parse(JSON.stringify(a));
    b.passingGrade = 71;
    assert(profiles.profileSha256(b) !== h, 'passingGrade cambia el sha');
    assert(profiles.profileSha256(profiles.defaultAssessmentProfile({ finalExam: false })) !== h, 'pesos cambian el sha');
    const p = profiles.defaultPresentationProfile();
    eq(profiles.profileSha256(shuffleKeys(p)), profiles.profileSha256(p), 'presentación claves mezcladas');
    eq(profiles.canonicalProfileJson(p), '{"brandSeed":null,"mode":"light","themeFamily":"aula-clara","themeVersion":1}', 'JSON canónico presentación');
    throwsRe(() => profiles.normalizePresentationProfile({ ...p, mode: 'x' }), /^PROFILE_INVALID: INVALID_THEME_MODE/, 'normalize inválido lanza');
  });

  // Fix round 1 (review G2 M9): la versión anterior pasaba los perfiles por
  // parámetros que nadie lee (tautológica). Ahora los perfiles se COLAN en el
  // propio snapshot v2 (el único lugar por donde una huella podría leerlos) y
  // se compara el plan de invalidación v3 real: tiene que ser todo REUSE e
  // idéntico al de "sin perfiles".
  await check('perfiles FUERA de las huellas: perfiles colados en el Blueprint v2 no mueven ninguna huella v3 ni el plan (todo REUSE)', () => {
    const planMod = loadDist('modules/invalidation/plan.js');
    const B = loadDist('modules/generation-manifests/generation-manifest-builder.js');
    const bp = snap.buildBlueprintSnapshotV2(V2_COURSE, V1_FIXED_MODULES, V2_CHAPTERS);
    const b = profiles.defaultAssessmentProfile({ finalExam: false });
    b.passingGrade = 55;
    const noisy = JSON.parse(JSON.stringify(bp));
    noisy.course.assessmentProfile = b;
    noisy.course.presentationProfile = { themeFamily: 'oscuro-premium', mode: 'dark', brandSeed: { accent: '#FF0000' }, themeVersion: 1 };
    const fA = fingerprints.computeFingerprintsV3(bp);
    const fB = fingerprints.computeFingerprintsV3(noisy);
    const ser = (f) => JSON.stringify({ c: [...f.content.entries()], e: [...f.exam.entries()], m: [...f.moduleIntro.entries()], o: f.courseOutline, x: f.finalExam });
    eq(ser(fB), ser(fA), 'huellas v3');
    const src = (n) => ({ courseId: V2_COURSE.id, blueprintId: n, blueprintNumber: n, blueprintSha256: snap.snapshotSha256V2(bp) });
    const m1 = B.buildGenerationManifest(bp, src(1), { rulesVersion: 3 });
    const m2 = B.buildGenerationManifest(bp, src(2), { rulesVersion: 3 });
    const items = m1.items.map((it) => ({
      itemKey: it.key, itemRunId: 'ir-' + it.key, status: 'completed', artifactIds: ['a-' + it.key], artifactStatus: 'ready',
      outputIdentity: 'o-' + it.key, consumedVideoIdentity: it.type === 'video_interactions' ? 'o-video:' + it.chapterId : undefined,
    }));
    const plain = planMod.computeInvalidationPlan({ from: { blueprint: bp, manifest: m1, items }, to: { blueprint: bp, manifest: m2 } });
    const withProfiles = planMod.computeInvalidationPlan({ from: { blueprint: noisy, manifest: m1, items }, to: { blueprint: noisy, manifest: m2 } });
    assert(withProfiles.actions.every((a) => a.action === 'REUSE'), 'plan con perfiles: no todo REUSE');
    eq(withProfiles.planSha256, plain.planSha256, 'planSha256');
    // Y el sha del Blueprint v2 (lo que decide si hay Manifest nuevo) tampoco los ve.
    eq(snap.snapshotSha256V2(snap.recanonicalizeBlueprintSnapshotV2(noisy)), snap.snapshotSha256V2(bp), 'sha del Blueprint v2');
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Parte DB: Postgres 16 desechable
// ════════════════════════════════════════════════════════════════════════════
function findPgBin() {
  const cands = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean);
  for (const d of cands) {
    const pg = path.join(d, 'postgres');
    if (!fs.existsSync(pg)) continue;
    const v = spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '';
    if (/\b16\./.test(v)) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => (port === 5570 ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}

function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

async function dbChecks() {
  require('reflect-metadata');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { NotFoundException } = require('@nestjs/common');
  const { CourseModule } = loadDist('modules/course-structure/entities/course-module.entity.js');
  const { CourseChapter } = loadDist('modules/course-structure/entities/course-chapter.entity.js');
  const { CourseStructureService } = loadDist('modules/course-structure/course-structure.service.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { CourseProfilesService } = loadDist('modules/course-profiles/course-profiles.service.js');
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-r3-pg16-'));
  const ROLE = 'postgres.r3localtest01';
  const DB = 'r3db';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = {
    flag: process.env.DYNAMIC_COURSE_STRUCTURE,
    allow: process.env.DYNAMIC_V2_ALLOWED_OWNERS,
    rules: process.env.DYNAMIC_MANIFEST_RULES_VERSION,
    unowned: process.env.ALLOW_UNOWNED_COURSES,
  };
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`\nPostgres ${pgBin} en 127.0.0.1:${port} (data ${dataDir})`);

    const withClient = async (db, fn) => {
      const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db });
      await c.connect();
      try { return await fn(c); } finally { await c.end(); }
    };
    await withClient('postgres', async (c) => {
      await c.query(`create database ${DB}`);
      await c.query(`create role "${ROLE}" superuser login`);
    });
    // Baseline legacy + Fase 1 + Fase 3 (lo que ya existe en staging antes de R3).
    await withClient(DB, async (c) => {
      await c.query(fs.readFileSync(path.join(REPO, 'scripts/prod/test/fixtures/legacy-baseline.sql'), 'utf8'));
      await c.query(fs.readFileSync(path.join(REPO, 'supabase-migration-dynamic-course-structure.sql'), 'utf8'));
      await c.query(fs.readFileSync(path.join(REPO, 'supabase-migration-course-blueprints.sql'), 'utf8'));
    });

    const OWNER = '11111111-2222-4333-8444-555555555555';
    const OTHER = '99999999-8888-4777-8666-555555555555';
    // Datos PREVIOS a la migración: deben quedar con los defaults "todo ON".
    const pre = await withClient(DB, async (c) => {
      const course = (await c.query(`insert into public.courses (owner_id, title, structure_version) values ($1, 'Curso R3', 'dynamic') returning id`, [OWNER])).rows[0];
      const legacy = (await c.query(`insert into public.courses (owner_id, title) values ($1, 'Curso legacy') returning id`, [OWNER])).rows[0];
      const m1 = (await c.query(`insert into public.course_modules (course_id, position, title) values ($1, 0, 'Módulo 1') returning id`, [course.id])).rows[0];
      const c1 = (await c.query(`insert into public.course_chapters (course_id, module_id, position, title, video_enabled) values ($1, $2, 0, 'Cap 1', true) returning id`, [course.id, m1.id])).rows[0];
      return { courseId: course.id, legacyId: legacy.id, moduleId: m1.id, chapterId: c1.id };
    });

    const MIGRATE = path.join(REPO, 'scripts/migrate-v21-blueprint-profiles.js');
    const VERIFY = path.join(REPO, 'scripts/verify-v21-blueprint-profiles-schema.js');
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-r3-cwd-'));
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [script], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    const hasColumn = (table, col) => withClient(DB, async (c) =>
      (await c.query(`select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2`, [table, col])).rows.length === 1);

    await check('DB guard: sin MIGRATION_ENV=staging → exit ≠ 0 y no aplica nada', async () => {
      const res = runScript(MIGRATE, localEnv({}));
      assert(res.code !== 0, `exit ${res.code}\n${res.out}`);
      assert(/MIGRATION_ENV no es "staging"/.test(res.out), res.out);
      assert(!(await hasColumn('courses', 'final_exam_enabled')), 'aplicó la migración igual');
    });
    await check('DB guard: ref de PRODUCCIÓN en DB_USER → exit ≠ 0 (aunque MIGRATION_ENV=staging)', async () => {
      const res = runScript(MIGRATE, localEnv({ MIGRATION_ENV: 'staging', DB_USER: 'postgres.hriwbakbuypaiovvvkqh' }));
      assert(res.code !== 0 && /PRODUCCIÓN/.test(res.out), `exit ${res.code}\n${res.out}`);
      const res2 = runScript(VERIFY, localEnv({ MIGRATION_ENV: 'staging', DB_USER: 'postgres.hriwbakbuypaiovvvkqh' }));
      assert(res2.code !== 0 && /PRODUCCIÓN/.test(res2.out), `verify: exit ${res2.code}\n${res2.out}`);
      assert(!(await hasColumn('courses', 'final_exam_enabled')), 'aplicó la migración igual');
    });
    await check('DB: migración real aplicada dos veces (idempotente) + verificador verde', async () => {
      for (let i = 0; i < 2; i++) {
        const res = runScript(MIGRATE, localEnv({ MIGRATION_ENV: 'staging' }));
        assert(res.code === 0, `corrida ${i + 1}: exit ${res.code}\n${res.out}`);
      }
      const v = runScript(VERIFY, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(v.code === 0 && /Esquema V2.1 R3 verificado/.test(v.out), `verify: exit ${v.code}\n${v.out}`);
    });
    // Fix round 1 (review G2 M2, audit §S): los cursos DINÁMICOS existentes al
    // agregar las columnas se leen como legado (SCORM, sin examen final); los
    // legacy y los cursos nuevos quedan con los defaults (h5p, examen final ON).
    await check('DB: filas existentes: dinámicos → (finalExam=false, scorm), legacy → defaults; capítulos activity_enabled=true; cursos nuevos → (true, h5p)', async () => {
      await withClient(DB, async (c) => {
        eq((await c.query(`select activity_enabled from public.course_chapters where id=$1`, [pre.chapterId])).rows[0].activity_enabled, true, 'activity_enabled');
        const row = (await c.query(`select final_exam_enabled, activity_engine from public.courses where id=$1`, [pre.courseId])).rows[0];
        eq([row.final_exam_enabled, row.activity_engine], [false, 'scorm'], 'curso dinámico existente');
        const leg = (await c.query(`select final_exam_enabled, activity_engine from public.courses where id=$1`, [pre.legacyId])).rows[0];
        eq([leg.final_exam_enabled, leg.activity_engine], [true, 'h5p'], 'curso legacy existente');
        await c.query('begin');
        try {
          const n = (await c.query(`insert into public.courses (owner_id, title, structure_version) values ($1, 'nuevo', 'dynamic') returning final_exam_enabled, activity_engine`, [OWNER])).rows[0];
          eq([n.final_exam_enabled, n.activity_engine], [true, 'h5p'], 'curso nuevo');
        } finally { await c.query('rollback'); }
      });
    });
    await check('DB: E2E setup-schema incluye la migración (mismo archivo)', () => {
      const src = fs.readFileSync(path.join(REPO, 'test/e2e-v2/setup-schema.js'), 'utf8');
      assert(src.includes("'supabase-migration-v21-blueprint-profiles.sql'"), 'falta en setup-schema.js');
    });

    // ── Servicios compilados contra la DB real ────────────────────────────
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.DYNAMIC_MANIFEST_RULES_VERSION;
    delete process.env.ALLOW_UNOWNED_COURSES;
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [CourseModule, CourseChapter], synchronize: false });
    await ds.initialize();
    // CoursesService.findOne real depende de TypeORM + AdminModule; el stub
    // replica su contrato (ownership → 404) con la misma tabla.
    const coursesStub = {
      async findOne(id, ownerId) {
        const [row] = await ds.query(
          `select id, title, structure_version, structure_version_counter from public.courses where id = $1 and owner_id = $2`, [id, ownerId]);
        if (!row) throw new NotFoundException(`Course #${id} not found`);
        return { id: row.id, title: row.title, structureVersion: row.structure_version, structureVersionCounter: row.structure_version_counter };
      },
    };
    const blueprints = new CourseBlueprintsService(ds);
    const structure = new CourseStructureService(ds.getRepository(CourseModule), ds.getRepository(CourseChapter), coursesStub, ds, blueprints);
    const profilesSvc = new CourseProfilesService(ds, coursesStub);
    const cid = pre.courseId;
    const counter = async () => (await structure.getStructure(cid, OWNER)).structureVersionCounter;

    await check('DB estructura: GET devuelve finalExam/activityEngine del curso y activityEnabled por capítulo', async () => {
      const s = await structure.getStructure(cid, OWNER);
      eq([s.finalExam, s.activityEngine], [false, 'scorm'], 'curso (dinámico existente, backfill M2)');
      eq(s.modules[0].chapters[0].activityEnabled, true, 'capítulo');
    });
    await check('DB estructura: updateChapter acepta activityEnabled (persiste, bump de counter) y 409 con counter viejo', async () => {
      const c0 = await counter();
      const res = await structure.updateChapter(cid, pre.moduleId, pre.chapterId, OWNER, { activityEnabled: false, expectedCounter: c0 });
      eq(res.structureVersionCounter, c0 + 1, 'counter');
      eq((await structure.getStructure(cid, OWNER)).modules[0].chapters[0].activityEnabled, false, 'persistido');
      await rejectsRe(structure.updateChapter(cid, pre.moduleId, pre.chapterId, OWNER, { activityEnabled: true, expectedCounter: c0 }), /expectedCounter desactualizado/, 'counter viejo', 409);
      eq((await structure.getStructure(cid, OWNER)).modules[0].chapters[0].activityEnabled, false, 'el 409 no escribió');
    });
    await check('DB estructura: createChapter acepta activityEnabled (false explícito; ausente → true)', async () => {
      const a = await structure.createChapter(cid, pre.moduleId, OWNER, { title: 'Cap 2', activityEnabled: false, expectedCounter: await counter() });
      eq(a.chapter.activityEnabled, false, 'explícito');
      const b = await structure.createChapter(cid, pre.moduleId, OWNER, { title: 'Cap 3', expectedCounter: await counter() });
      eq(b.chapter.activityEnabled, true, 'default');
      const m = await structure.createModule(cid, OWNER, { title: 'Módulo 2', expectedCounter: await counter() });
      eq(m.module.chapters[0].activityEnabled, true, 'primer capítulo del módulo nuevo');
    });
    await check('DB estructura: PATCH de settings (finalExam/activityEngine) con concurrencia optimista; vacío → 400; ajeno → 404', async () => {
      const c0 = await counter();
      const res = await structure.updateSettings(cid, OWNER, { finalExam: false, activityEngine: 'scorm', expectedCounter: c0 });
      eq(res, { structureVersionCounter: c0 + 1, finalExam: false, activityEngine: 'scorm' }, 'respuesta');
      const s = await structure.getStructure(cid, OWNER);
      eq([s.finalExam, s.activityEngine], [false, 'scorm'], 'GET');
      await rejectsRe(structure.updateSettings(cid, OWNER, { finalExam: true, expectedCounter: c0 }), /expectedCounter desactualizado/, 'counter viejo', 409);
      await rejectsRe(structure.updateSettings(cid, OWNER, { expectedCounter: await counter() }), /Nada para actualizar/, 'vacío', 400);
      await rejectsRe(structure.updateSettings(cid, OTHER, { finalExam: true, expectedCounter: await counter() }), /not found/, 'ajeno', 404);
      await rejectsRe(structure.updateSettings(pre.legacyId, OWNER, { finalExam: true, expectedCounter: 0 }), /solo admite cursos "dynamic"/, 'legacy', 400);
      await rejectsRe(ds.query(`update public.courses set activity_engine = 'hvp' where id = $1`, [cid]), /courses_activity_engine_check/, 'CHECK en la DB');
      await structure.updateSettings(cid, OWNER, { finalExam: true, activityEngine: 'h5p', expectedCounter: await counter() });
    });

    let v2Number = null;
    await check('DB Blueprint: config default → lock crea schemaVersion 1 (sin campos nuevos), igual que hoy', async () => {
      const r1 = await blueprints.lock(cid, OWNER, await counter());
      eq([r1.created, r1.blueprint.schemaVersion], [true, 1], 'v1');
      assert(!('finalExam' in r1.blueprint.snapshot.course), 'v1 no tiene finalExam');
      assert(!('activityEnabled' in r1.blueprint.snapshot.modules[0].chapters[0]), 'v1 no tiene activityEnabled');
      const again = await blueprints.lock(cid, OWNER, await counter());
      eq(again.created, false, 'idempotente');
      eq((await blueprints.getByNumber(cid, OWNER, r1.blueprint.blueprintNumber)).schemaVersion, 1, 'consumidor v1 lo lee');
    });
    await check('DB Blueprint: DYNAMIC_MANIFEST_RULES_VERSION=3 → lock v2 con toggles; lectura verificada; consumidor v1 → 501; idempotente', async () => {
      process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
      const r = await blueprints.lock(cid, OWNER, await counter());
      eq([r.created, r.blueprint.schemaVersion], [true, 2], 'v2 creado');
      v2Number = r.blueprint.blueprintNumber;
      const s = r.blueprint.snapshot;
      eq([s.course.finalExam, s.course.activityEngine], [true, 'h5p'], 'toggles de curso');
      eq(s.modules[0].chapters.map((c) => c.activityEnabled), [false, false, true], 'activityEnabled por capítulo');
      eq(snap.validateBlueprintSnapshotV2(s), [], 'valida');
      const read = await blueprints.getByNumberAnySchema(cid, OWNER, v2Number);
      eq(snap.canonicalJsonV2(read.snapshot), snap.canonicalJsonV2(s), 'round trip jsonb re-canonicalizado');
      eq(read.sha256, snap.snapshotSha256V2(s), 'sha');
      eq((await blueprints.getCurrent(cid, OWNER)).schemaVersion, 2, 'getCurrent v2');
      await rejectsRe(blueprints.getByNumber(cid, OWNER, v2Number), /BLUEPRINT_V2_REQUIRES_RULES_V3/, 'consumidor v1', 501);
      const again = await blueprints.lock(cid, OWNER, await counter());
      eq([again.created, again.blueprint.blueprintNumber], [false, v2Number], 'idempotente');
      const st = await structure.getStructure(cid, OWNER);
      eq([st.currentBlueprint.schemaVersion, st.liveMatchesCurrentBlueprint], [2, true], 'estructura viva = Blueprint v2');
    });

    await check('DB perfiles: GET sin versiones → default con isDefault:true (assessment según finalExam del curso)', async () => {
      const a = await profilesSvc.getCurrent(cid, OWNER, 'assessment');
      eq([a.isDefault, a.version], [true, 0], 'default');
      eq(a.profile, profiles.defaultAssessmentProfile({ finalExam: true }), 'perfil');
      eq(a.sha256, profiles.profileSha256(a.profile), 'sha');
      const p = await profilesSvc.getCurrent(cid, OWNER, 'presentation');
      eq([p.isDefault, p.profile], [true, profiles.defaultPresentationProfile()], 'presentation');
      await rejectsRe(profilesSvc.getCurrent(cid, OWNER, 'theme'), /Tipo de perfil inválido/, 'kind', 400);
      await rejectsRe(profilesSvc.getCurrent(cid, OTHER, 'assessment'), /not found/, 'ajeno', 404);
      await rejectsRe(profilesSvc.getCurrent(pre.legacyId, OWNER, 'assessment'), /solo admite cursos "dynamic"/, 'legacy', 400);
    });
    await check('DB perfiles: POST valida, agrega versiones 1→2, idéntico → created:false, expectedVersion viejo → 409, inválido → 400', async () => {
      const d = profiles.defaultAssessmentProfile({ finalExam: true });
      const r1 = await profilesSvc.append(cid, OWNER, 'assessment', shuffleKeys(d), 0);
      eq([r1.created, r1.profile.version, r1.profile.isDefault], [true, 1, false], 'v1');
      eq(Object.keys(r1.profile.profile), Object.keys(d), 'orden normalizado');
      const same = await profilesSvc.append(cid, OWNER, 'assessment', d);
      eq([same.created, same.profile.version], [false, 1], 'idéntico');
      const d2 = { ...d, passingGrade: 60 };
      const r2 = await profilesSvc.append(cid, OWNER, 'assessment', d2, 1);
      eq([r2.created, r2.profile.version], [true, 2], 'v2');
      await rejectsRe(profilesSvc.append(cid, OWNER, 'assessment', { ...d, passingGrade: 65 }, 1), /expectedVersion=1, actual=2/, 'expectedVersion', 409);
      await rejectsRe(profilesSvc.append(cid, OWNER, 'assessment', { ...d, categoryWeights: { practice: 40, moduleExams: 60 } }), /WEIGHTS_FINAL_EXAM_MISMATCH/, 'pesos sin final', 400);
      await rejectsRe(profilesSvc.append(cid, OWNER, 'presentation', { ...profiles.defaultPresentationProfile(), mode: 'sepia' }), /INVALID_THEME_MODE/, 'modo', 400);
      const cur = await profilesSvc.getCurrent(cid, OWNER, 'assessment');
      eq([cur.version, cur.profile.passingGrade, cur.sha256], [2, 60, r2.profile.sha256], 'vigente = última versión (sha verificado tras jsonb)');
      const rows = await ds.query(`select version from public.course_profiles where course_id = $1 and kind = 'assessment' order by version`, [cid]);
      eq(rows.map((x) => x.version), [1, 2], 'versiones');
      const pres = await profilesSvc.append(cid, OWNER, 'presentation', { themeFamily: 'tecnico', mode: 'dark', brandSeed: { accent: '#AABBCC' }, themeVersion: 1 });
      eq([pres.created, pres.profile.version], [true, 1], 'presentation v1 (versión independiente por kind)');
    });
    await check('DB perfiles: append-only — UPDATE y DELETE directos rechazados por la DB; el borrado del curso cascadea', async () => {
      const [row] = await ds.query(`select id from public.course_profiles where course_id = $1 order by id limit 1`, [cid]);
      await rejectsRe(ds.query(`update public.course_profiles set data = '{}'::jsonb where id = $1`, [row.id]), /append-only/, 'UPDATE');
      await rejectsRe(ds.query(`delete from public.course_profiles where id = $1`, [row.id]), /append-only/, 'DELETE');
      const tmp = (await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, 'Curso temporal', 'dynamic') returning id`, [OWNER]))[0].id;
      await profilesSvc.append(tmp, OWNER, 'presentation', profiles.defaultPresentationProfile());
      await ds.query(`delete from public.courses where id = $1`, [tmp]);
      eq((await ds.query(`select count(*)::int as n from public.course_profiles where course_id = $1`, [tmp]))[0].n, 0, 'cascada');
    });
    await check('DB perfiles: cambiar finalExam del curso → el GET avisa (warnings) sin bloquear; los perfiles no cambian el Blueprint', async () => {
      const locked = await blueprints.lock(cid, OWNER, await counter());
      eq([locked.created, locked.blueprint.blueprintNumber], [false, v2Number], 'perfiles no crean Blueprint nuevo');
      await structure.updateSettings(cid, OWNER, { finalExam: false, expectedCounter: await counter() });
      const a = await profilesSvc.getCurrent(cid, OWNER, 'assessment');
      eq(a.warnings.map((w) => w.code), ['WEIGHTS_FINAL_EXAM_MISMATCH'], 'warnings');
      const st = await structure.getStructure(cid, OWNER);
      eq(st.liveMatchesCurrentBlueprint, false, 'toggle de curso sí cambia la estructura vs. el Blueprint v2');
    });
    await check('DB perfiles: escritura con owner fuera de la allow-list V2 → 403', async () => {
      process.env.DYNAMIC_V2_ALLOWED_OWNERS = OTHER;
      try {
        await rejectsRe(profilesSvc.append(cid, OWNER, 'presentation', profiles.defaultPresentationProfile()), /./, 'allow-list', 403);
        await rejectsRe(structure.updateSettings(cid, OWNER, { finalExam: true, expectedCounter: await counter() }), /./, 'allow-list settings', 403);
      } finally {
        delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
      }
    });
  } finally {
    if (ds && ds.isInitialized) await ds.destroy().catch(() => {});
    for (const [k, v] of Object.entries({
      DYNAMIC_COURSE_STRUCTURE: saved.flag, DYNAMIC_V2_ALLOWED_OWNERS: saved.allow,
      DYNAMIC_MANIFEST_RULES_VERSION: saved.rules, ALLOW_UNOWNED_COURSES: saved.unowned,
    })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('PG16 descartable destruido');
  }
}

(async () => {
  await pureChecks();
  if (PURE_ONLY) {
    console.log('ℹ️  --pure-only: parte DB (PG16 desechable) NO ejecutada');
  } else {
    try {
      await dbChecks();
    } catch (err) {
      failures++;
      console.error(`❌ setup de la parte DB falló: ${err && err.stack ? err.stack : err}`);
    }
  }
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures > 0 ? 1 : 0);
})();
