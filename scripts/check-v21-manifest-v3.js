#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — R4: Generation Manifest rulesVersion 3.
//
// Parte pura (siempre; CI la corre con --pure-only):
//   - conjunto de items para las 4 combinaciones de capítulo (video/actividad
//     on/off) × examEnabled × finalExam × engine × 1/2/4/7 módulos, contra un
//     oráculo propio del test (no el builder);
//   - dependsOn exacto y orden canónico (JSON canónico fijado de un fixture);
//   - variant h5p/scorm, totales, determinismo + sha fijado;
//   - el validador detecta cada clase de mutación;
//   - v1/v2 sin cambios (re-corre check-generation-manifest-determinism.js);
//   - config acepta 3; roles de artifact v3; costKind; packaging e
//     invalidación rechazan v3; worker de proveedor mock/real.
// Parte DB (default; PG16 desechable, puerto libre ≠ 5570, dir temporal que
// se destruye): guardarraíles de la migración, migración real 2× +
// verificador, INSERT de items v3 pasa el CHECK, y GenerationManifestsService
// compilado crea/lee un Manifest v3 contra la DB real.
//
// Usage: node scripts/check-v21-manifest-v3.js [--pure-only] [path/to/dist]

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
const B = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const rulesCfg = loadDist('modules/generation-manifests/manifest-rules-config.js');

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
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── Fixtures ────────────────────────────────────────────────────────────────
const COURSE_ID = 4242;
const SOURCE = { courseId: COURSE_ID, blueprintId: 77, blueprintNumber: 3, blueprintSha256: 'a'.repeat(64) };
// Las 4 combinaciones de capítulo (video, actividad).
const COMBOS = [[true, true], [true, false], [false, true], [false, false]];

/**
 * Config → filas crudas → snapshot v2 (vía el builder de Blueprint v2 de R3).
 * Posiciones no contiguas y filas en orden inverso: el Manifest debe ordenar.
 */
function buildConfig({ moduleCount, examMode, finalExam, engine }) {
  const modules = [];
  const chapters = [];
  for (let mi = 0; mi < moduleCount; mi++) {
    const mid = `m${mi + 1}`;
    const exam = examMode === 'on' ? true : examMode === 'off' ? false : mi % 2 === 0;
    modules.push({ id: mid, position: (mi + 1) * 10, title: `Módulo ${mi + 1}`, objective: null, exam_enabled: exam });
    // Cada módulo recorre las 4 combinaciones, rotadas por módulo; 1..4 capítulos.
    const n = 1 + ((mi + 3) % 4);
    for (let ci = 0; ci < n; ci++) {
      const [video, activity] = COMBOS[(ci + mi) % 4];
      chapters.push({
        id: `${mid}c${ci + 1}`, module_id: mid, position: (ci + 1) * 5, title: `Cap ${mid}.${ci + 1}`,
        objective: null, video_enabled: video, activity_enabled: activity,
      });
    }
  }
  // Un solo módulo: forzar los 4 combos dentro del mismo módulo.
  if (moduleCount === 1) {
    chapters.length = 0;
    COMBOS.forEach(([video, activity], ci) => chapters.push({
      id: `m1c${ci + 1}`, module_id: 'm1', position: (ci + 1) * 5, title: `Cap m1.${ci + 1}`,
      objective: null, video_enabled: video, activity_enabled: activity,
    }));
  }
  const course = { id: COURSE_ID, title: 'Curso R4', finalExam, activityEngine: engine };
  return snap.buildBlueprintSnapshotV2(course, [...modules].reverse(), [...chapters].reverse());
}

/** Oráculo del test: lista esperada [key, type, dependsOn, variant?] escrita a mano desde la tabla del brief. */
function oracle(s) {
  const out = [];
  const P = `course_plan:${COURSE_ID}`;
  const I = `course_intro:${COURSE_ID}`;
  out.push([P, 'course_plan', []]);
  out.push([I, 'course_intro', [P]]);
  out.push([`audio_welcome:${COURSE_ID}`, 'audio_welcome', [I]]);
  const all = [];
  for (const m of [...s.modules].sort((a, b) => a.position - b.position)) {
    out.push([`module_intro:${m.id}`, 'module_intro', [P]]);
    const mc = [];
    for (const c of [...m.chapters].sort((a, b) => a.position - b.position)) {
      const C = `content:${c.id}`;
      mc.push(C);
      all.push(C);
      out.push([C, 'content', [P]]);
      out.push([`experience:${c.id}`, 'experience', [C]]);
      out.push([`presentation:${c.id}`, 'presentation', [C]]);
      if (c.videoEnabled) {
        out.push([`video:${c.id}`, 'video', [C]]);
        out.push([`video_interactions:${c.id}`, 'video_interactions', [`video:${c.id}`, C]]);
      }
      if (c.activityEnabled) out.push([`activity:${c.id}`, 'activity', [C], s.course.activityEngine]);
      out.push([`audiobook_chapter:${c.id}`, 'audiobook_chapter', [C]]);
    }
    if (m.examEnabled) out.push([`exam:${m.id}`, 'exam', mc]);
  }
  if (s.course.finalExam) out.push([`final_exam:${COURSE_ID}`, 'final_exam', all]);
  return out;
}

const SMALL = () => snap.buildBlueprintSnapshotV2(
  { id: COURSE_ID, title: 'Curso R4', finalExam: true, activityEngine: 'scorm' },
  [{ id: 'mA', position: 1, title: 'A', objective: null, exam_enabled: true }],
  [
    { id: 'cA1', module_id: 'mA', position: 1, title: 'A1', objective: null, video_enabled: true, activity_enabled: true },
    { id: 'cA2', module_id: 'mA', position: 2, title: 'A2', objective: null, video_enabled: false, activity_enabled: false },
  ],
);
// JSON canónico v3 esperado del fixture SMALL (escrito a mano desde la tabla del brief: fija
// la forma, el orden de claves, el orden de items y cada arista).
const SMALL_PINNED_JSON = JSON.stringify({
  manifestSchemaVersion: 1,
  rulesVersion: 3,
  source: SOURCE,
  features: { finalExam: true, activityEngine: 'scorm' },
  modules: [{ moduleId: 'mA', position: 1, moduleNumber: 1, examEnabled: true, chapters: [
    { chapterId: 'cA1', position: 1, chapterNumber: 1, videoEnabled: true, activityEnabled: true },
    { chapterId: 'cA2', position: 2, chapterNumber: 2, videoEnabled: false, activityEnabled: false },
  ] }],
  items: [
    ['course_plan:4242', 'course_plan', 'course', null, null, null, null, []],
    ['course_intro:4242', 'course_intro', 'course', null, null, null, null, ['course_plan:4242']],
    ['audio_welcome:4242', 'audio_welcome', 'course', null, null, null, null, ['course_intro:4242']],
    ['module_intro:mA', 'module_intro', 'module', 'mA', null, 1, null, ['course_plan:4242']],
    ['content:cA1', 'content', 'chapter', 'mA', 'cA1', 1, 1, ['course_plan:4242']],
    ['experience:cA1', 'experience', 'chapter', 'mA', 'cA1', 1, 1, ['content:cA1']],
    ['presentation:cA1', 'presentation', 'chapter', 'mA', 'cA1', 1, 1, ['content:cA1']],
    ['video:cA1', 'video', 'chapter', 'mA', 'cA1', 1, 1, ['content:cA1']],
    ['video_interactions:cA1', 'video_interactions', 'chapter', 'mA', 'cA1', 1, 1, ['video:cA1', 'content:cA1']],
    ['activity:cA1', 'activity', 'chapter', 'mA', 'cA1', 1, 1, ['content:cA1'], 'scorm'],
    ['audiobook_chapter:cA1', 'audiobook_chapter', 'chapter', 'mA', 'cA1', 1, 1, ['content:cA1']],
    ['content:cA2', 'content', 'chapter', 'mA', 'cA2', 1, 2, ['course_plan:4242']],
    ['experience:cA2', 'experience', 'chapter', 'mA', 'cA2', 1, 2, ['content:cA2']],
    ['presentation:cA2', 'presentation', 'chapter', 'mA', 'cA2', 1, 2, ['content:cA2']],
    ['audiobook_chapter:cA2', 'audiobook_chapter', 'chapter', 'mA', 'cA2', 1, 2, ['content:cA2']],
    ['exam:mA', 'exam', 'module', 'mA', null, 1, null, ['content:cA1', 'content:cA2']],
    ['final_exam:4242', 'final_exam', 'course', null, null, null, null, ['content:cA1', 'content:cA2']],
  ].map(([key, type, scope, moduleId, chapterId, moduleNumber, chapterNumber, dependsOn, variant]) => ({
    key, type, scope, moduleId, chapterId, moduleNumber, chapterNumber, dependsOn, ...(variant ? { variant } : {}),
  })),
  totals: {
    moduleCount: 1, chapterCount: 2, contentCount: 2, videoCount: 1, examCount: 1,
    coursePlanCount: 1, courseIntroCount: 1, moduleIntroCount: 1,
    experienceCount: 2, presentationCount: 2, videoInteractionsCount: 1, activityCount: 1,
    audiobookChapterCount: 2, audioWelcomeCount: 1, finalExamCount: 1, totalJobs: 17,
  },
});
// sha256 del Manifest v3 de buildConfig({moduleCount:4, examMode:'alt', finalExam:true, engine:'h5p'}).
const PINNED_SHA_V3 = '3992216d4b763eef3dca6524a313decf79af26715240782de928dc63be7953cc';

async function pureChecks() {
  const configs = [];
  for (const moduleCount of [1, 2, 4, 7]) {
    for (const examMode of ['on', 'off', 'alt']) {
      for (const finalExam of [true, false]) {
        for (const engine of ['h5p', 'scorm']) configs.push({ moduleCount, examMode, finalExam, engine });
      }
    }
  }

  await check(`conjunto de items = oráculo en ${configs.length} configs (4 combos V/A × examEnabled on/off/alt × finalExam × engine × 1/2/4/7 módulos)`, () => {
    for (const cfg of configs) {
      const s = buildConfig(cfg);
      const m = B.buildGenerationManifest(s, SOURCE, { rulesVersion: 3 });
      const got = m.items.map((i) => (i.variant ? [i.key, i.type, i.dependsOn, i.variant] : [i.key, i.type, i.dependsOn]));
      eq(got, oracle(s), `items ${JSON.stringify(cfg)}`);
      eq(B.validateGenerationManifest(m, s, SOURCE), [], `validador ${JSON.stringify(cfg)}`);
      // cada combinación de capítulo aparece
      const flags = new Set(m.modules.flatMap((mm) => mm.chapters.map((c) => `${c.videoEnabled}/${c.activityEnabled}`)));
      assert(flags.size === 4 || cfg.moduleCount === 2, `faltan combos en ${JSON.stringify(cfg)}: ${[...flags]}`);
    }
  });

  await check('dependsOn exacto, orden canónico y forma: JSON canónico del fixture chico = el escrito a mano', () => {
    const m = B.buildGenerationManifest(SMALL(), SOURCE, { rulesVersion: 3 });
    eq(B.canonicalManifestJson(m), SMALL_PINNED_JSON, 'canonical v3');
    eq(JSON.stringify(m), SMALL_PINNED_JSON, 'el objeto del builder ya está en orden canónico');
  });

  await check('variant: activity lleva course.activityEngine (h5p/scorm); ningún otro item tiene variant', () => {
    for (const engine of ['h5p', 'scorm']) {
      const m = B.buildGenerationManifest(buildConfig({ moduleCount: 4, examMode: 'on', finalExam: true, engine }), SOURCE, { rulesVersion: 3 });
      const acts = m.items.filter((i) => i.type === 'activity');
      assert(acts.length > 0, 'sin actividades');
      assert(acts.every((i) => i.variant === engine), `variant ≠ ${engine}`);
      assert(m.items.filter((i) => i.type !== 'activity').every((i) => !('variant' in i)), 'variant fuera de activity');
      eq(m.features, { finalExam: true, activityEngine: engine }, 'features');
    }
  });

  await check('totales v3: claves exactas (sin scormCount) y conteos = oráculo en todas las configs', () => {
    for (const cfg of configs) {
      const s = buildConfig(cfg);
      const m = B.buildGenerationManifest(s, SOURCE, { rulesVersion: 3 });
      eq(Object.keys(m.totals), B.MANIFEST_TOTALS_KEYS_V3, 'claves');
      const o = oracle(s);
      const c = (t) => o.filter((x) => x[1] === t).length;
      const chapters = s.modules.reduce((n, mm) => n + mm.chapters.length, 0);
      eq(m.totals, {
        moduleCount: s.modules.length, chapterCount: chapters, contentCount: c('content'), videoCount: c('video'),
        examCount: c('exam'), coursePlanCount: 1, courseIntroCount: 1, moduleIntroCount: s.modules.length,
        experienceCount: chapters, presentationCount: chapters, videoInteractionsCount: c('video'),
        activityCount: c('activity'), audiobookChapterCount: chapters, audioWelcomeCount: 1,
        finalExamCount: cfg.finalExam ? 1 : 0, totalJobs: o.length,
      }, `totals ${JSON.stringify(cfg)}`);
    }
  });

  await check('determinismo: entrada mezclada, jsonb round trip y sha fijado', () => {
    const cfg = { moduleCount: 4, examMode: 'alt', finalExam: true, engine: 'h5p' };
    const s = buildConfig(cfg);
    const m1 = B.buildGenerationManifest(s, SOURCE, { rulesVersion: 3 });
    const sShuffled = clone(s);
    sShuffled.modules.reverse().forEach((mm) => mm.chapters.reverse());
    const m2 = B.buildGenerationManifest(sShuffled, SOURCE, { rulesVersion: 3 });
    eq(B.manifestSha256(m2), B.manifestSha256(m1), 'entrada en otro orden');
    const roundTrip = JSON.parse(B.canonicalManifestJson(shuffleKeys(clone(m1))));
    eq(B.manifestSha256(roundTrip), B.manifestSha256(m1), 'jsonb (claves mezcladas)');
    eq(B.validateGenerationManifest(roundTrip, s, SOURCE), [], 'round trip válido');
    eq(B.manifestSha256(m1), PINNED_SHA_V3, 'sha fijado');
  });

  await check('validador v3 detecta cada clase de mutación', () => {
    const s = buildConfig({ moduleCount: 2, examMode: 'on', finalExam: true, engine: 'h5p' });
    const base = () => clone(B.buildGenerationManifest(s, SOURCE, { rulesVersion: 3 }));
    const codes = (m, snapshot = s) => B.validateGenerationManifest(m, snapshot, SOURCE).map((e) => e.code);
    const has = (m, code, label, snapshot) => {
      const c = codes(m, snapshot);
      assert(c.includes(code), `${label}: esperaba ${code}, obtuvo ${JSON.stringify(c)}`);
    };
    // missing item (uno por tipo relevante)
    for (const t of ['experience', 'presentation', 'audiobook_chapter', 'audio_welcome', 'final_exam', 'activity', 'video_interactions']) {
      const m = base();
      const i = m.items.findIndex((x) => x.type === t);
      assert(i >= 0, `fixture sin ${t}`);
      m.items.splice(i, 1);
      m.totals.totalJobs -= 1;
      has(m, `MISSING_${t.toUpperCase()}`, `falta ${t}`);
    }
    // extra video (y video_interactions) con video OFF
    const offCh = s.modules.flatMap((mm) => mm.chapters.map((c) => ({ ...c, moduleId: mm.id }))).find((c) => !c.videoEnabled);
    const offIdx = (m) => m.items.findIndex((x) => x.key === `presentation:${offCh.id}`);
    {
      const m = base();
      const ref = m.items[offIdx(m)];
      m.items.splice(offIdx(m) + 1, 0, { ...ref, key: `video:${offCh.id}`, type: 'video' });
      has(m, 'VIDEO_NOT_ENABLED', 'video extra');
      const m2 = base();
      m2.items.splice(offIdx(m2) + 1, 0, { ...m2.items[offIdx(m2)], key: `video_interactions:${offCh.id}`, type: 'video_interactions' });
      has(m2, 'VIDEO_NOT_ENABLED', 'video_interactions extra');
    }
    // activity con actividad OFF, final_exam con finalExam OFF, exam con examEnabled OFF
    {
      const noAct = s.modules.flatMap((mm) => mm.chapters).find((c) => !c.activityEnabled);
      const m = base();
      const i = m.items.findIndex((x) => x.key === `audiobook_chapter:${noAct.id}`);
      m.items.splice(i, 0, { ...m.items[i], key: `activity:${noAct.id}`, type: 'activity', variant: 'h5p' });
      has(m, 'ACTIVITY_NOT_ENABLED', 'activity extra');
      const sNoFinal = buildConfig({ moduleCount: 2, examMode: 'off', finalExam: false, engine: 'h5p' });
      const mf = clone(B.buildGenerationManifest(sNoFinal, SOURCE, { rulesVersion: 3 }));
      mf.items.push({ key: `final_exam:${COURSE_ID}`, type: 'final_exam', scope: 'course', moduleId: null, chapterId: null, moduleNumber: null, chapterNumber: null, dependsOn: [] });
      has(mf, 'FINAL_EXAM_NOT_ENABLED', 'final_exam extra', sNoFinal);
      const me = clone(B.buildGenerationManifest(sNoFinal, SOURCE, { rulesVersion: 3 }));
      me.items.push({ key: 'exam:m1', type: 'exam', scope: 'module', moduleId: 'm1', chapterId: null, moduleNumber: 1, chapterNumber: null, dependsOn: [] });
      has(me, 'EXAM_NOT_ENABLED', 'exam extra', sNoFinal);
    }
    // wrong variant / sin variant / variant en otro tipo
    {
      const m = base();
      m.items.find((x) => x.type === 'activity').variant = 'scorm';
      has(m, 'WRONG_VARIANT', 'variant cambiado');
      const m2 = base();
      delete m2.items.find((x) => x.type === 'activity').variant;
      has(m2, 'WRONG_VARIANT', 'variant ausente');
      const m3 = base();
      m3.items.find((x) => x.type === 'experience').variant = 'h5p';
      has(m3, 'UNEXPECTED_VARIANT', 'variant en experience');
      const m4 = base();
      m4.features.activityEngine = 'scorm';
      has(m4, 'FEATURES_MISMATCH', 'features');
    }
    // wrong deps (cada tipo con arista propia)
    for (const [t, deps] of [
      ['video_interactions', (i) => [...i.dependsOn].reverse()],
      ['audio_welcome', () => [`course_plan:${COURSE_ID}`]],
      ['experience', () => []],
      ['final_exam', (i) => i.dependsOn.slice(1)],
      ['exam', (i) => [...i.dependsOn, 'content:m2c1']],
      ['content', () => []],
    ]) {
      const m = base();
      const it = m.items.find((x) => x.type === t);
      it.dependsOn = deps(it);
      has(m, 'WRONG_DEPENDENCIES', `deps ${t}`);
    }
    // orden
    {
      const m = base();
      const a = m.items.findIndex((x) => x.type === 'presentation');
      [m.items[a], m.items[a - 1]] = [m.items[a - 1], m.items[a]];
      has(m, 'ORDER_MISMATCH', 'presentation antes que experience');
      const m2 = base();
      m2.items.push(m2.items.splice(m2.items.findIndex((x) => x.type === 'audio_welcome'), 1)[0]);
      has(m2, 'ORDER_MISMATCH', 'audio_welcome al final');
    }
    // totales
    {
      const m = base();
      m.totals.activityCount += 1;
      has(m, 'TOTALS_MISMATCH', 'activityCount');
      const m2 = base();
      m2.totals.scormCount = m2.totals.chapterCount;
      has(m2, 'TOTALS_MISMATCH', 'scormCount en v3');
      const m3 = B.buildGenerationManifest(s, SOURCE, { rulesVersion: 3 });
      const back = JSON.parse(B.canonicalManifestJson({ ...clone(m3), totals: { ...m3.totals, scormCount: 4 } }));
      has(back, 'TOTALS_MISMATCH', 'scormCount sobrevive a la canonicalización');
    }
    // scorm dentro de un v3 → UNKNOWN_TYPE; mirror de modules
    {
      const m = base();
      const i = m.items.findIndex((x) => x.type === 'activity');
      m.items.splice(i, 0, { ...m.items[i], key: m.items[i].key.replace('activity', 'scorm'), type: 'scorm', variant: undefined });
      has(m, 'UNKNOWN_TYPE', 'scorm en v3');
      const m2 = base();
      m2.modules[0].chapters[0].activityEnabled = !m2.modules[0].chapters[0].activityEnabled;
      has(m2, 'MODULES_MISMATCH', 'activityEnabled en modules');
    }
    // snapshot v1 como entrada
    {
      const m = base();
      const v1 = B.buildGenerationManifest ? snap.buildBlueprintSnapshot({ id: COURSE_ID, title: 'x' },
        [{ id: 'm1', position: 1, title: 'M', objective: null, exam_enabled: true }],
        [{ id: 'm1c1', module_id: 'm1', position: 1, title: 'C', objective: null, video_enabled: true }]) : null;
      has(m, 'BLUEPRINT_SCHEMA_MISMATCH', 'validar v3 contra snapshot v1', v1);
      eq(B.validateGenerationManifestV3(m, v1, SOURCE).map((e) => e.code), ['BLUEPRINT_SCHEMA_MISMATCH'], 'validador v3 directo');
      throwsRe(() => B.buildGenerationManifest(v1, SOURCE, { rulesVersion: 3 }), /^BLUEPRINT_SCHEMA_MISMATCH/, 'build v3 con snapshot v1');
      throwsRe(() => B.buildGenerationManifest(s, SOURCE, { rulesVersion: 2 }), /^BLUEPRINT_SCHEMA_MISMATCH/, 'build v2 con snapshot v2');
      throwsRe(() => B.buildGenerationManifest(s, SOURCE), /^BLUEPRINT_SCHEMA_MISMATCH/, 'build v1 (default) con snapshot v2');
      const bad = clone(s);
      bad.modules[0].chapters[0].activityEnabled = 'yes';
      throwsRe(() => B.buildGenerationManifestV3(bad, SOURCE), /BLUEPRINT_V2_INVALID_INPUT/, 'activityEnabled no boolean');
    }
    // tipos v3 en un Manifest v1/v2 → UNKNOWN_TYPE (validador legacy)
    {
      const v1snap = snap.buildBlueprintSnapshot({ id: COURSE_ID, title: 'x' },
        [{ id: 'm1', position: 1, title: 'M', objective: null, exam_enabled: false }],
        [{ id: 'm1c1', module_id: 'm1', position: 1, title: 'C', objective: null, video_enabled: false }]);
      for (const rv of [1, 2]) {
        const m = clone(B.buildGenerationManifest(v1snap, SOURCE, { rulesVersion: rv }));
        m.items.push({ key: 'experience:m1c1', type: 'experience', scope: 'chapter', moduleId: 'm1', chapterId: 'm1c1', moduleNumber: 1, chapterNumber: 1, dependsOn: ['content:m1c1'] });
        has(m, 'UNKNOWN_TYPE', `experience en v${rv}`, v1snap);
      }
    }
  });

  await check('v1/v2 byte-idénticos: check-generation-manifest-determinism.js (hashes fijados) pasa sin cambios', () => {
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/check-generation-manifest-determinism.js'),
      path.join(distRoot, 'modules/generation-manifests/generation-manifest-builder.js')], { encoding: 'utf8' });
    assert(r.status === 0, `exit ${r.status}\n${r.stdout}${r.stderr}`);
    assert(/13 ok, 0 fail|determinism check OK/.test(r.stdout + r.stderr), r.stdout);
  });

  await check('tipos: V3 = orden canónico, ALL = v2 ∪ v3, scope de audio_welcome/final_exam = course, itemTypesForRulesVersion(3)', () => {
    eq(B.MANIFEST_ITEM_TYPES_V3, ['course_plan', 'course_intro', 'audio_welcome', 'module_intro', 'content', 'experience',
      'presentation', 'video', 'video_interactions', 'activity', 'audiobook_chapter', 'exam', 'final_exam'], 'V3');
    eq(B.itemTypesForRulesVersion(3), B.MANIFEST_ITEM_TYPES_V3, 'rv 3');
    eq(B.itemTypesForRulesVersion(2), B.MANIFEST_ITEM_TYPES_V2, 'rv 2 sin cambios');
    eq(B.itemTypesForRulesVersion(1), B.MANIFEST_ITEM_TYPES_V1, 'rv 1 sin cambios');
    for (const t of B.MANIFEST_ITEM_TYPES_V3) assert(B.ALL_MANIFEST_ITEM_TYPES.includes(t), `ALL sin ${t}`);
    eq(['audio_welcome', 'final_exam', 'course_plan', 'exam', 'activity', 'presentation'].map(B.scopeOfItemType),
      ['course', 'course', 'course', 'module', 'chapter', 'chapter'], 'scopes');
    eq(B.SUPPORTED_RULES_VERSIONS, [1, 2, 3], 'rulesVersions');
  });

  await check('config: DYNAMIC_MANIFEST_RULES_VERSION acepta "3" (Manifest v3); 1/2/ausente igual; basura → throw', () => {
    const E = rulesCfg.MANIFEST_RULES_VERSION_ENV;
    eq(rulesCfg.readManifestRulesVersionConfig({ [E]: '3' }), 3, '3');
    eq(rulesCfg.readManifestRulesVersionConfig({ [E]: '2' }), 2, '2');
    eq(rulesCfg.readManifestRulesVersionConfig({ [E]: '1' }), 1, '1');
    eq(rulesCfg.readManifestRulesVersionConfig({}), 1, 'ausente');
    for (const bad of ['4', 'v3', ' 3', '3.0']) throwsRe(() => rulesCfg.readManifestRulesVersionConfig({ [E]: bad }), /inválido/, `"${bad}"`);
  });

  await check('roles de artifact v3 (completeItem): activity por variant; v1/v2 sin cambios', () => {
    const R = loadDist('modules/dynamic-packaging/artifact-resolver.js');
    eq(R.requiredArtifactTypesV3('activity', 'h5p'), ['dynamic_h5p_params_json'], 'activity h5p');
    eq(R.requiredArtifactTypesV3('activity', 'scorm'), ['dynamic_scorm_html', 'dynamic_scorm_manifest'], 'activity scorm');
    eq(R.requiredArtifactTypesV3('activity', null), undefined, 'activity sin variant');
    eq(R.requiredArtifactTypesV3('presentation'), ['dynamic_presentation'], 'presentation');
    eq(R.requiredArtifactTypesV3('audiobook_chapter'), ['dynamic_audio_mp3'], 'audiobook');
    eq(R.requiredArtifactTypesV3('final_exam'), ['dynamic_exam_gift'], 'final_exam');
    for (const t of B.MANIFEST_ITEM_TYPES_V3) if (t !== 'activity') assert(R.requiredArtifactTypesV3(t), `sin roles para ${t}`);
    eq(R.requiredArtifactTypes(1, 'content'), ['dynamic_content_md'], 'v1 content');
    eq(R.requiredArtifactTypes(2, 'content'), ['dynamic_content_md', 'dynamic_context_package_json'], 'v2 content');
    eq(R.requiredArtifactTypes(2, 'experience'), undefined, 'experience no existe en v2');
  });

  await check('regenerationCostKind: presentation→gamma, audio_*→tts, LLM→llm, video como antes', () => {
    const { regenerationCostKind } = loadDist('modules/dynamic-generation/runs.service.js');
    eq(['presentation', 'audio_welcome', 'audiobook_chapter'].map((t) => regenerationCostKind(t, 'mock')), ['gamma', 'tts', 'tts'], 'proveedores');
    eq(['course_plan', 'course_intro', 'module_intro', 'content', 'experience', 'video_interactions', 'activity', 'exam', 'final_exam', 'scorm']
      .map((t) => regenerationCostKind(t, 'real')), Array(10).fill('llm'), 'LLM');
    eq([regenerationCostKind('video', 'real'), regenerationCostKind('video', 'mock')], ['videogen', 'none'], 'video');
  });

  await check('clasificación: navegador = LLM (content…final_exam), worker = video/presentation/audio_*; DTO = scheduler', () => {
    const S = loadDist('modules/dynamic-generation/scheduler.service.js');
    const D = loadDist('modules/dynamic-generation/dto/executor.dto.js');
    const browser = ['course_plan', 'course_intro', 'module_intro', 'content', 'experience', 'video_interactions', 'activity', 'exam', 'final_exam'];
    for (const t of browser) assert(S.BROWSER_CLAIMABLE_TYPES.includes(t), `navegador sin ${t}`);
    for (const t of S.WORKER_ONLY_TYPES) assert(!S.BROWSER_CLAIMABLE_TYPES.includes(t), `${t} reclamable por el navegador`);
    eq([...S.WORKER_ONLY_TYPES].sort(), ['audio_welcome', 'audiobook_chapter', 'presentation', 'video'], 'worker');
    eq([...D.BROWSER_ITEM_TYPES].sort(), [...S.BROWSER_CLAIMABLE_TYPES].sort(), 'DTO = scheduler');
    for (const t of B.MANIFEST_ITEM_TYPES_V3) {
      assert(S.BROWSER_CLAIMABLE_TYPES.includes(t) !== S.WORKER_ONLY_TYPES.includes(t), `${t} clasificado 0 o 2 veces`);
    }
  });

  await check('packaging-plan y resolver rechazan v3 con PACKAGING_V3_NOT_IMPLEMENTED (sin tocar la DB)', async () => {
    const P = loadDist('modules/dynamic-packaging/packaging-plan.js');
    const m = B.buildGenerationManifest(SMALL(), SOURCE, { rulesVersion: 3 });
    throwsRe(() => P.buildPackagingPlan(m, SMALL()), /^PACKAGING_V3_NOT_IMPLEMENTED/, 'plan v3');
    const R = loadDist('modules/dynamic-packaging/artifact-resolver.js');
    let touched = false;
    await rejectsRe(R.resolveRunArtifacts({ query: async () => { touched = true; return []; } }, 'r', m), /^PACKAGING_V3_NOT_IMPLEMENTED/, 'resolver v3');
    assert(!touched, 'el resolver tocó la DB con un Manifest v3');
  });

  // R5 levantó el 501 de v3 → v3 (plan-v3.ts; ver check-v21-invalidation-v3.js).
  // Lo que sigue rechazado: mezclar rulesVersion 3 con 1/2 y Blueprints del schema equivocado.
  await check('invalidación: v3 → v3 se calcula (R5); mezclar v3 con v1/v2 → INVALIDATION_V3_NOT_IMPLEMENTED; v1/v2 no afectados', () => {
    const plan = loadDist('modules/invalidation/plan.js');
    const m3 = B.buildGenerationManifest(SMALL(), SOURCE, { rulesVersion: 3 });
    const input = { from: { blueprint: SMALL(), manifest: m3, items: [] }, to: { blueprint: SMALL(), manifest: m3 } };
    eq(plan.computeInvalidationPlan(input).toRulesVersion, 3, 'v3 → v3');
    throwsRe(() => plan.assertInvalidationRulesSupported(2, 3), /^INVALIDATION_V3_NOT_IMPLEMENTED/, 'v2 → v3');
    plan.assertInvalidationRulesSupported(1, 2, [1, 1]); // no lanza
    throwsRe(() => plan.assertInvalidationRulesSupported(2, 2, [1, 2]), /^INVALIDATION_V3_NOT_IMPLEMENTED/, 'Blueprint v2');
  });

  // Fix round 1 (review G2 I1): el modo sale de input_payload.providerModes (nunca de videoMode);
  // mock exige además DYNAMIC_ALLOW_PROVIDER_MOCK=true al ejecutar; sin modos → PROVIDER_MODE_UNSET.
  await check('worker de proveedor: providerModes mock (+env) → fixture mock:true + completeItem; real / sin modos / mock sin env → falla fuerte sin artifact', async () => {
    const W = loadDist('workers/dynamic-provider-worker.js');
    const item = (type, chapterId) => ({
      itemRunId: 'ir-1', runId: 'run-1', courseId: 1, artifactCourseId: 'front-1', manifestId: 9, itemKey: `${type}:${chapterId || 1}`,
      type, chapterId, chapterNumber: chapterId ? 2 : null, idempotencyKey: `idem-${type}`, attempt: 1,
    });
    const mk = (inputPayload, withBudget = true) => {
      const calls = { uploads: [], completes: [], fails: [] };
      return {
        calls,
        deps: {
          scheduler: {
            async claimNextItem() { return null; },
            async completeItem(id, ex, out) { calls.completes.push(out); return true; },
            async failItem(id, ex, err, retry) { calls.fails.push({ err, retry }); return true; },
          },
          dataSource: { async query() { return [{ owner_id: 'owner-1', input_payload: inputPayload }]; } },
          artifacts: { async uploadJsonArtifact(i) { calls.uploads.push(i); return { id: `art-${calls.uploads.length}` }; } },
          logger: { log() {}, warn() {}, error() {} },
          executorId: 'ex', leaseSeconds: 60,
          // V2.1 RF-b (fix round 2, M3): guard de presupuesto falso y permisivo (sin él, real falla cerrado).
          ...(withBudget ? { budget: { async guardPaidSubmission() { return { allow: true, decision: 'ALLOW', committed: '0', remaining: null, reason: 'test', authorizedBudget: '999' }; } } } : {}),
        },
      };
    };
    for (const [type, artifactType] of [['presentation', 'dynamic_presentation'], ['audio_welcome', 'dynamic_audio_mp3'], ['audiobook_chapter', 'dynamic_audio_mp3']]) {
      const ch = type === 'audio_welcome' ? null : 'c1';
      const savedMock = process.env.DYNAMIC_ALLOW_PROVIDER_MOCK;
      process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = 'true';
      const a = mk({ videoMode: 'real', providerModes: { presentation: 'mock', audio: 'mock' } });
      try { await W.processProviderItem(a.deps, item(type, ch)); } finally {
        if (savedMock === undefined) delete process.env.DYNAMIC_ALLOW_PROVIDER_MOCK; else process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = savedMock;
      }
      eq([a.calls.uploads[0].metadata.mock, a.calls.uploads[0].metadata.fixture], [true, true], `${type}: metadata mock/fixture`);
      eq(a.calls.uploads.map((u) => u.type), [artifactType], `${type}: tipo de artifact`);
      eq(a.calls.completes.map((c) => c.artifactIds), [['art-1']], `${type}: completeItem`);
      assert(a.calls.uploads[0].payload.fixture === true, 'payload sin fixture:true');
      eq(W.mockProviderOutput(item(type, ch)), W.mockProviderOutput(item(type, ch)), `${type}: determinística`);
      const R = loadDist('modules/dynamic-packaging/artifact-resolver.js');
      eq(R.requiredArtifactTypesV3(type), [artifactType], `${type}: rol que exige completeItem`);
      // videoMode 'mock' + providerModes real → real (el modo de video NO decide).
      const b = mk({ videoMode: 'mock', providerModes: { presentation: 'real', audio: 'real' } });
      await rejectsRe(W.processProviderItem(b.deps, item(type, ch)), /^PROVIDER_NOT_WIRED_V21/, `${type} real`);
      eq(b.calls.uploads.length + b.calls.completes.length, 0, `${type} real: sin artifact ni complete`);
      assert(b.calls.fails.length === 1 && b.calls.fails[0].retry === false && /^PROVIDER_NOT_WIRED_V21/.test(b.calls.fails[0].err), `${type} real: failItem no reintentable`);
      // Sin providerModes (solo videoMode 'mock', como antes del fix) → PROVIDER_MODE_UNSET, nunca fixture.
      const u = mk({ videoMode: 'mock' });
      await rejectsRe(W.processProviderItem(u.deps, item(type, ch)), /PROVIDER_MODE_UNSET/, `${type} sin modos`);
      eq(u.calls.uploads.length + u.calls.completes.length, 0, `${type} sin modos: sin artifact`);
      // Congelado mock pero el entorno ya no lo permite → falla fuerte.
      const m = mk({ providerModes: { presentation: 'mock', audio: 'mock' } });
      delete process.env.DYNAMIC_ALLOW_PROVIDER_MOCK;
      await rejectsRe(W.processProviderItem(m.deps, item(type, ch)), /provider_mock_not_allowed/, `${type} mock sin env`);
      if (savedMock !== undefined) process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = savedMock;
      eq(m.calls.uploads.length, 0, `${type} mock sin env: sin artifact`);
      // RF-b M3: real SIN guard de presupuesto → fail closed (sin llamada, sin artifact), no PROVIDER_NOT_WIRED.
      const c = mk({ videoMode: 'mock', providerModes: { presentation: 'real', audio: 'real' } }, false);
      await W.processProviderItem(c.deps, item(type, ch));
      eq(c.calls.uploads.length + c.calls.completes.length, 0, `${type} real sin guard: sin artifact`);
      assert(c.calls.fails.length === 1 && c.calls.fails[0].retry === false && /^finops_unavailable: /.test(c.calls.fails[0].err), `${type} real sin guard: ${JSON.stringify(c.calls.fails)}`);
      process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = 'true';
      const d = mk({ videoMode: 'real', providerModes: { presentation: 'mock', audio: 'mock' } }, false);
      try { await W.processProviderItem(d.deps, item(type, ch)); } finally {
        if (savedMock === undefined) delete process.env.DYNAMIC_ALLOW_PROVIDER_MOCK; else process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = savedMock;
      }
      eq(d.calls.completes.length, 1, `${type} mock sin guard: completa`);
    }
    eq([...W.PROVIDER_WORKER_TYPES].sort(), ['audio_welcome', 'audiobook_chapter', 'presentation'], 'tipos del worker');
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
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');

  const pgBin = findPgBin();
  const port = await freePort();
  assert(port !== 5570, 'puerto 5570 prohibido');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-r4-pg16-'));
  const ROLE = 'postgres.r4localtest01';
  const DB = 'r4db';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = {
    flag: process.env.DYNAMIC_COURSE_STRUCTURE, allow: process.env.DYNAMIC_V2_ALLOWED_OWNERS,
    rules: process.env.DYNAMIC_MANIFEST_RULES_VERSION, unowned: process.env.ALLOW_UNOWNED_COURSES,
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
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-r4-cwd-'));
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    // Esquema de staging ANTES de R4: baseline legacy + Fase 1..5 + v2 + invalidación + R3.
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
        'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    for (const s of ['scripts/migrate-production-jobs-constraints.js']) {
      const res = runScript(s, localEnv({}));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out}`);
    }
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out}`);
    }
    const gTypeDef = () => withClient(DB, async (c) => (await c.query(
      `select pg_get_constraintdef(oid) d from pg_constraint where conname='gir_type_check' and conrelid='public.generation_item_runs'::regclass`)).rows[0].d);

    await check('DB guard: sin MIGRATION_ENV=staging → exit ≠ 0 y no aplica nada', async () => {
      const res = runScript('scripts/migrate-v21-manifest-v3.js', localEnv({}));
      assert(res.code !== 0 && /MIGRATION_ENV no es "staging"/.test(res.out), `exit ${res.code}\n${res.out}`);
      assert(!(await gTypeDef()).includes('audiobook_chapter'), 'aplicó la migración igual');
    });
    await check('DB guard: ref de PRODUCCIÓN → exit ≠ 0 (migrate y verify), aunque MIGRATION_ENV=staging', async () => {
      const env = localEnv({ MIGRATION_ENV: 'staging', DB_USER: 'postgres.hriwbakbuypaiovvvkqh' });
      for (const s of ['scripts/migrate-v21-manifest-v3.js', 'scripts/verify-v21-manifest-v3-schema.js']) {
        const res = runScript(s, env);
        assert(res.code !== 0 && /PRODUCCIÓN/.test(res.out), `${s}: exit ${res.code}\n${res.out}`);
      }
      assert(!(await gTypeDef()).includes('audiobook_chapter'), 'aplicó la migración igual');
    });
    await check('DB: ANTES de la migración, un item v3 (audio_welcome) viola el CHECK de type (23514)', async () => {
      await withClient(DB, async (c) => {
        await c.query('begin');
        try {
          let code = null;
          try {
            await c.query(`insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, type, module_id, chapter_id, idempotency_key)
                           values (gen_random_uuid(), 1, 1, 1, 'audio_welcome:1', 'audio_welcome', null, null, $1)`, ['q'.repeat(64)]);
          } catch (e) { code = e.code; }
          assert(code === '23514', `código ${code}`);
        } finally { await c.query('rollback'); }
      });
    });
    await check('DB: migración real aplicada dos veces (idempotente) + verificador verde (incluye INSERT de cada tipo v3)', async () => {
      for (let i = 0; i < 2; i++) {
        const res = runScript('scripts/migrate-v21-manifest-v3.js', localEnv({ MIGRATION_ENV: 'staging' }));
        assert(res.code === 0, `corrida ${i + 1}: exit ${res.code}\n${res.out}`);
      }
      const v = runScript('scripts/verify-v21-manifest-v3-schema.js', localEnv({ MIGRATION_ENV: 'staging' }));
      assert(v.code === 0 && /Esquema V2.1 R4/.test(v.out), `verify: exit ${v.code}\n${v.out}`);
    });
    await check('DB: verificadores previos siguen verdes (dynamic-generation, generation-manifests)', async () => {
      for (const s of ['scripts/verify-dynamic-generation-schema.js', 'scripts/verify-generation-manifests-schema.js']) {
        const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
        assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-1500)}`);
      }
    });
    await check('DB: el cableado E2E corre la migración después de la v2 (run-e2e.sh) y deploy-staging la incluye', () => {
      const sh = fs.readFileSync(path.join(REPO, 'test/e2e-v2/run-e2e.sh'), 'utf8');
      const iV2 = sh.indexOf('migrate-dynamic-generation-v2.js');
      const iV3 = sh.indexOf('migrate-v21-manifest-v3.js');
      assert(iV2 > 0 && iV3 > iV2, 'run-e2e.sh: migrate-v21-manifest-v3 no corre después de la v2');
      assert(fs.readFileSync(path.join(REPO, 'test/e2e-v2/setup-schema.js'), 'utf8').includes('supabase-migration-v21-manifest-v3.sql'), 'setup-schema.js no documenta la migración');
      const yml = fs.readFileSync(path.join(REPO, '.github/workflows/deploy-staging.yml'), 'utf8');
      assert(yml.indexOf('migrate-v21-manifest-v3.js') > yml.indexOf('migrate-dynamic-generation-v2.js'), 'deploy-staging: orden');
    });

    // ── Servicios compilados contra la DB real ──────────────────────────
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [], synchronize: false });
    await ds.initialize();
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, 'Curso R4', 'dynamic') returning id`, [OWNER]);
    const cid = course.id;
    const s2 = snap.buildBlueprintSnapshotV2(
      { id: cid, title: 'Curso R4', finalExam: true, activityEngine: 'scorm' },
      [{ id: '00000000-0000-4000-8000-0000000000a1', position: 0, title: 'M1', objective: null, exam_enabled: true },
        { id: '00000000-0000-4000-8000-0000000000a2', position: 1, title: 'M2', objective: null, exam_enabled: false }],
      [{ id: '00000000-0000-4000-8000-0000000000c1', module_id: '00000000-0000-4000-8000-0000000000a1', position: 0, title: 'C1', objective: null, video_enabled: true, activity_enabled: true },
        { id: '00000000-0000-4000-8000-0000000000c2', module_id: '00000000-0000-4000-8000-0000000000a1', position: 1, title: 'C2', objective: null, video_enabled: false, activity_enabled: false },
        { id: '00000000-0000-4000-8000-0000000000c3', module_id: '00000000-0000-4000-8000-0000000000a2', position: 0, title: 'C3', objective: null, video_enabled: true, activity_enabled: false }],
    );
    // Estructura viva con los mismos ids (FKs de artifacts.module_id/chapter_id).
    for (const m of s2.modules) {
      await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
      for (const c of m.chapters) {
        await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled)
                        values ($1, $2, $3, $4, $5, $6, $7)`, [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
      }
    }
    await ds.query(
      `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
       values ($1, 1, 2, $2::jsonb, $3, 0, 2, 3)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
    const s1 = snap.buildBlueprintSnapshot({ id: cid, title: 'Curso R4' },
      [{ id: '00000000-0000-4000-8000-0000000000a1', position: 0, title: 'M1', objective: null, exam_enabled: true }],
      [{ id: '00000000-0000-4000-8000-0000000000c1', module_id: '00000000-0000-4000-8000-0000000000a1', position: 0, title: 'C1', objective: null, video_enabled: true }]);
    await ds.query(
      `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
       values ($1, 2, 1, $2::jsonb, $3, 0, 1, 1)`, [cid, snap.canonicalJson(s1), snap.snapshotSha256(s1)]);

    let dto = null;
    await check('DB servicio: config 3 + Blueprint v2 → Manifest v3 creado, conteos en columnas, lectura verificada (sha + validador)', async () => {
      process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
      const res = await manifests.getOrCreate(cid, OWNER, 1);
      eq([res.created, res.manifest.rulesVersion], [true, 3], 'creado v3');
      dto = res.manifest;
      const [row] = await ds.query(`select * from public.course_generation_manifests where id = $1`, [dto.id]);
      eq([row.scorm_count, row.experience_count, row.presentation_count, row.video_interactions_count, row.activity_count,
        row.audiobook_chapter_count, row.audio_welcome_count, row.final_exam_count, row.total_jobs],
      [0, 3, 3, 2, 1, 3, 1, 1, dto.manifest.items.length], 'columnas');
      eq(row.manifest_sha256, B.manifestSha256(B.buildGenerationManifest(s2, { courseId: cid, blueprintId: row.blueprint_id, blueprintNumber: 1, blueprintSha256: snap.snapshotSha256V2(s2) }, { rulesVersion: 3 })), 'sha = builder puro');
      const again = await manifests.getOrCreate(cid, OWNER, 1);
      eq([again.created, again.manifest.id, again.manifest.sha256], [false, dto.id, dto.sha256], 'idempotente');
      const got = await manifests.get(cid, OWNER, 1);
      eq(got.sha256, dto.sha256, 'get');
      const byId = await manifests.getById(cid, OWNER, 1, dto.id);
      eq(B.canonicalManifestJson(byId.manifest), B.canonicalManifestJson(dto.manifest), 'getById (jsonb round trip)');
      await manifests.assertBlueprintAccessible(cid, OWNER, 1);
    });
    await check('DB servicio: config 3 + Blueprint v1 → 409 BLUEPRINT_SCHEMA_MISMATCH; config 1 + Blueprint v2 → 501 (como en R3)', async () => {
      process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
      await rejectsRe(manifests.getOrCreate(cid, OWNER, 2), /BLUEPRINT_SCHEMA_MISMATCH/, 'v1 bajo reglas 3', 409);
      process.env.DYNAMIC_MANIFEST_RULES_VERSION = '1';
      await rejectsRe(manifests.getOrCreate(cid, OWNER, 1), /BLUEPRINT_V2_REQUIRES_RULES_V3/, 'v2 bajo reglas 1', 501);
      const v1 = await manifests.getOrCreate(cid, OWNER, 2);
      eq([v1.created, v1.manifest.rulesVersion, v1.manifest.totals.scormCount], [true, 1, 1], 'v1 sigue creando igual');
    });
    await check('DB: sembrar TODOS los items del Manifest v3 en generation_item_runs (como startRun, sin scope) pasa los CHECKs con el scope correcto', async () => {
      assert(dto, 'sin Manifest v3');
      const [job] = await ds.query(
        `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, input_payload)
         values ($1, $2, 'dynamic_generation', 'queued', 'queued', $3::jsonb) returning id`,
        [OWNER, cid, JSON.stringify({ manifestId: String(dto.id), blueprintNumber: 1, providerModes: { presentation: 'mock', audio: 'mock' } })]);
      let n = 0;
      for (const it of dto.manifest.items) {
        n += 1;
        await ds.query(
          `insert into public.generation_item_runs
             (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key, status)
           values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9::text[], $10, 'pending')`,
          [job.id, cid, dto.blueprintId, dto.id, it.key, it.type, it.moduleId, it.chapterId, it.dependsOn, String(n).padStart(64, 'r')]);
      }
      const rows = await ds.query(`select type, scope from public.generation_item_runs where job_id = $1 order by item_key`, [job.id]);
      eq(rows.length, dto.manifest.items.length, 'filas');
      for (const row of rows) eq(row.scope, B.scopeOfItemType(row.type), `scope ${row.type}`);
      const types = new Set(rows.map((x) => x.type));
      for (const t of B.MANIFEST_ITEM_TYPES_V3) assert(types.has(t), `el fixture no sembró ${t}`);
    });

    await check('DB scheduler: claim v3 (worker y navegador) con Blueprint v2, variant en el payload, v2-executor → 409, completeItem exige roles v3, worker de proveedor mock completa', async () => {
      assert(dto, 'sin Manifest v3');
      const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
      const { canonicalContextHash } = loadDist('modules/dynamic-generation/run-hash.js');
      const W = loadDist('workers/dynamic-provider-worker.js');
      const [job] = await ds.query(`select id from public.production_jobs where input_payload->>'manifestId' = $1`, [String(dto.id)]);
      const ctx = { courseName: 'Curso R4' };
      await ds.query(`insert into public.generation_run_contexts (job_id, manifest_id, context, context_hash) values ($1, $2, $3::jsonb, $4)`,
        [job.id, dto.id, JSON.stringify(ctx), canonicalContextHash(ctx)]);
      const runsStub = {
        async tx(fn) {
          const qr = ds.createQueryRunner();
          await qr.connect();
          await qr.startTransaction();
          try { const out = await fn(qr); await qr.commitTransaction(); return out; }
          catch (e) { if (qr.isTransactionActive) await qr.rollbackTransaction(); throw e; }
          finally { await qr.release(); }
        },
        async reconcileCancellation() {},
      };
      const sched = new SchedulerService(ds, runsStub);
      const PROVIDER = ['presentation', 'audio_welcome', 'audiobook_chapter'];
      eq(await sched.claimNextItem({ executorId: 'w1', types: PROVIDER, leaseSeconds: 60 }), null, 'nada reclamable antes de sus dependencias');
      // Navegador v2 (sin tipos v3) sobre un run v3 → 409.
      await rejectsRe(sched.claimNextItem({ executorId: 'b0', types: ['content', 'course_plan', 'course_intro', 'module_intro', 'exam', 'scorm'], runId: job.id, ownerId: OWNER }),
        /rules_version_mismatch/, 'ejecutor v2 en run v3', 409);
      await rejectsRe(sched.claimNextItem({ executorId: 'b0', types: ['presentation'], runId: job.id, ownerId: OWNER }), /browser_type_not_allowed/, 'navegador pide presentation', 400);
      // Completar plan / intro / content "a mano" (sus ejecutores reales son del navegador).
      await ds.query(`update public.generation_item_runs set status = 'completed' where job_id = $1 and type in ('course_plan', 'course_intro', 'content')`, [job.id]);
      const act = await sched.claimNextItem({ executorId: 'b1', types: ['experience', 'video_interactions', 'activity', 'final_exam', 'exam', 'module_intro'], runId: job.id, ownerId: OWNER });
      assert(act, 'el navegador v3 no reclamó nada');
      const claimedAct = act.type === 'activity' ? act : null;
      // Reclamar hasta dar con el activity (el orden es el del Manifest).
      let activity = claimedAct;
      for (let i = 0; i < 20 && !activity; i++) {
        const next = await sched.claimNextItem({ executorId: 'b1', types: ['activity'], runId: job.id, ownerId: OWNER });
        if (next && next.type === 'activity') activity = next;
        else break;
      }
      assert(activity, 'no se reclamó el activity');
      eq([activity.rulesVersion, activity.variant], [3, 'scorm'], 'payload del activity');
      assert(activity.blueprint.chapter && activity.blueprint.outline.length === 2, 'payload sin blueprint/outline');
      const insArt = async (type, itemKey) => (await ds.query(
        `insert into public.artifacts (owner_id, course_id, type, storage_path) values ($1, $2, $3, $4) returning id`,
        [OWNER, String(cid), type, `r4/${type}/${itemKey}/${Math.random()}`]))[0].id;
      const html = await insArt('dynamic_scorm_html', activity.itemKey);
      await rejectsRe(sched.completeItem(activity.itemRunId, 'b1', { artifactIds: [html], summary: {} }, OWNER), /missing_required_artifacts.*dynamic_scorm_manifest/, 'activity scorm sin manifest', 409);
      const man = await insArt('dynamic_scorm_manifest', activity.itemKey);
      eq(await sched.completeItem(activity.itemRunId, 'b1', { artifactIds: [html, man], summary: {} }, OWNER), true, 'activity completo');
      // Worker de proveedor (mock) con el scheduler real: reclama y completa un item de proveedor.
      const uploads = [];
      const deps = {
        scheduler: sched, dataSource: ds, logger: { log() {}, warn() {}, error() {} }, executorId: 'prov-1', leaseSeconds: 60,
        artifacts: { async uploadJsonArtifact(i) { uploads.push(i.type); return { id: await insArt(i.type, 'prov') }; } },
      };
      // Fix round 1 (I1): run congelado en providerModes mock + escape de entorno explícito.
      const savedMock = process.env.DYNAMIC_ALLOW_PROVIDER_MOCK;
      process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = 'true';
      try {
        eq(await W.runProviderOnce(deps), 'claimed', 'worker de proveedor reclamó');
      } finally {
        if (savedMock === undefined) delete process.env.DYNAMIC_ALLOW_PROVIDER_MOCK; else process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = savedMock;
      }
      const [done] = await ds.query(
        `select type, status, output_summary from public.generation_item_runs where job_id = $1 and worker_id = 'prov-1'`, [job.id]);
      assert(done && done.status === 'completed' && PROVIDER.includes(done.type), `item de proveedor: ${JSON.stringify(done)}`);
      eq(done.output_summary.fixture, true, 'output_summary marca fixture');
      eq(uploads.length, 1, 'un artifact');
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
