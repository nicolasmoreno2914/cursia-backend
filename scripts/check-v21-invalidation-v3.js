#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — R5: invalidación para rulesVersion 3 + coherencia v3 +
// auditorías de staging v3.
//
// Parte pura (siempre; CI la corre con --pure-only):
//   - una aserción por fila de la tabla §P del audit, con la acción de CADA
//     item por key (no por conteo);
//   - perfiles (passingGrade, intentos, pesos, tema) y versiones que no son
//     inputs (promptVersion, renderer, builder) ⇒ todo REUSE;
//   - cambio de motor (activityEngine) ⇒ solo activity REGENERATE;
//   - toggles de finalExam / video / actividad, con reuso de deshabilitados
//     vía el apply real (planApplyWrites);
//   - STALE_NO_AUTO para presentation / audio / video al cambiar el content;
//   - video_interactions sigue al video;
//   - reorder (varias permutaciones) ⇒ ningún item de proveedor paga;
//   - determinismo + sha fijado; entradas inválidas fallan fuerte;
//   - v1/v2 sin cambios (re-corre check-invalidation-plan/apply y
//     check-coherence-engine contra el mismo dist);
//   - coherencia v3 (Blueprint schemaVersion 2) y tablas de las auditorías.
// Parte DB (default; PG16 desechable, puerto libre ≠ 5570, dir temporal que
// se destruye): InvalidationService.getPlan + RunsService.startRun({fromRun})
// v3 → v3 compilados contra la DB real, coherencia de un run v3 y las dos
// auditorías de staging con datos v3.
//
// Usage: node scripts/check-v21-invalidation-v3.js [--pure-only] [path/to/dist]

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
const P = loadDist('modules/invalidation/plan.js');
const PV3 = loadDist('modules/invalidation/plan-v3.js');
const F = loadDist('modules/invalidation/fingerprints.js');
const A = loadDist('modules/invalidation/invalidation-apply.js');
const R = loadDist('modules/dynamic-packaging/artifact-resolver.js');
const REPORT = loadDist('modules/coherence/report.js');
const AUD = require('./lib/audit-v3');

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

// ── Fixture ─────────────────────────────────────────────────────────────────
// M1 {C1 video+act, C2 act, C3 video} examen ON; M2 {C4 video+act, C5} examen
// ON; M3 {C6 act} examen OFF. finalExam ON, motor h5p.
const COURSE_ID = 5005;
const CTX = 'c'.repeat(64);
const mod = (n) => `a5000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const chp = (n) => `c5000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [M1, M2, M3, M4] = [1, 2, 3, 4].map(mod);
const [C1, C2, C3, C4, C5, C6, C7] = [1, 2, 3, 4, 5, 6, 7].map(chp);
const K = (t, id) => `${t}:${id}`;
const CK = (t) => `${t}:${COURSE_ID}`;
const PROVIDER_TYPES = ['video', 'presentation', 'audio_welcome', 'audiobook_chapter'];

function baseSpec() {
  return {
    title: 'Curso R5',
    finalExam: true,
    engine: 'h5p',
    modules: [
      { id: M1, title: 'Fundamentos', objective: 'Comprender los fundamentos', exam: true, chapters: [
        { id: C1, title: 'Capítulo uno', objective: 'Objetivo uno', video: true, act: true },
        { id: C2, title: 'Capítulo dos', objective: 'Objetivo dos', act: true },
        { id: C3, title: 'Capítulo tres', objective: 'Objetivo tres', video: true },
      ] },
      { id: M2, title: 'Aplicaciones', objective: 'Aplicar lo aprendido', exam: true, chapters: [
        { id: C4, title: 'Capítulo cuatro', objective: 'Objetivo cuatro', video: true, act: true },
        { id: C5, title: 'Capítulo cinco', objective: 'Objetivo cinco' },
      ] },
      { id: M3, title: 'Cierre', objective: 'Integrar', exam: false, chapters: [
        { id: C6, title: 'Capítulo seis', objective: 'Objetivo seis', act: true },
      ] },
    ],
  };
}
function chapterOf(spec, id) {
  for (const m of spec.modules) for (const c of m.chapters) if (c.id === id) return c;
  throw new Error(`fixture: ${id}`);
}
function buildBp(spec) {
  const modules = spec.modules.map((m, i) => ({
    id: m.id, position: m.position ?? i, title: m.title, objective: m.objective ?? null, exam_enabled: !!m.exam,
  }));
  const chapters = [];
  spec.modules.forEach((m) => m.chapters.forEach((c, j) => chapters.push({
    id: c.id, module_id: m.id, position: c.position ?? j, title: c.title, objective: c.objective ?? null,
    video_enabled: !!c.video, activity_enabled: !!c.act,
  })));
  return snap.buildBlueprintSnapshotV2(
    { id: COURSE_ID, title: spec.title, finalExam: spec.finalExam, activityEngine: spec.engine }, modules, chapters,
  );
}
function manifestOf(bp, n) {
  return B.buildGenerationManifest(
    bp, { courseId: COURSE_ID, blueprintId: n, blueprintNumber: n, blueprintSha256: snap.snapshotSha256V2(bp) }, { rulesVersion: 3 },
  );
}
/** Artifacts de un item: uno por rol obligatorio v3 (id = tag|key|rol). */
function roleIds(tag, it) {
  const roles = R.requiredArtifactTypesV3(it.type, it.variant);
  assert(roles && roles.length, `sin roles para ${it.key}`);
  return roles.map((r) => `${tag}|${it.key}|${r}`);
}
const typeOfId = (id) => String(id).split('|')[2];
/** Registros "completed + ready" de todos los items del Manifest (override por key; null = sin registro). */
function recordsOf(manifest, tag, over = {}) {
  const out = [];
  for (const it of manifest.items) {
    if (over[it.key] === null) continue;
    out.push({
      itemKey: it.key, itemRunId: `${tag}#${it.key}`, status: 'completed', artifactIds: roleIds(tag, it),
      artifactStatus: 'ready', inputFingerprint: null, outputIdentity: `out/${tag}/${it.key}`,
      // Fix round 1 (I3): las interacciones registran el video contra el que se generaron.
      ...(it.type === 'video_interactions' ? { consumedVideoIdentity: `out/${tag}/video:${it.chapterId}` } : {}),
      ...(over[it.key] || {}),
    });
  }
  return out;
}
function planOf(bpA, bpB, opts = {}) {
  const mA = opts.mA || manifestOf(bpA, opts.nA || 1);
  const mB = opts.mB || manifestOf(bpB, opts.nB || 2);
  const plan = P.computeInvalidationPlan({
    from: { blueprint: bpA, manifest: mA, items: opts.records || recordsOf(mA, 'A', opts.over), courseContextSha256: CTX },
    to: { blueprint: bpB, manifest: mB, courseContextSha256: CTX },
  });
  return { plan, mA, mB };
}
const byKey = (plan) => Object.fromEntries(plan.actions.map((a) => [a.itemKey, a]));
/** Cada acción del plan = `expected[key]` o `rest`; toda key esperada existe. */
function expectPlan(plan, expected, rest = 'REUSE') {
  const m = byKey(plan);
  for (const k of Object.keys(expected)) assert(m[k], `el plan no tiene ${k}`);
  const bad = [];
  for (const a of plan.actions) {
    const want = expected[a.itemKey] ?? rest;
    if (a.action !== want) bad.push(`${a.itemKey}: ${a.action} (esperado ${want}; reasons=${a.reasons.join(',')})`);
  }
  assert(bad.length === 0, `acciones inesperadas:\n${bad.join('\n')}`);
}
function assertReason(plan, key, reason) {
  const a = byKey(plan)[key];
  assert(a && a.reasons.includes(reason), `${key}: reasons=${a && a.reasons.join(',')} (esperado ${reason})`);
}
/** Ningún item de proveedor paga (GENERATE/REGENERATE). */
function assertNoProviderSpend(plan) {
  const spend = plan.actions.filter((a) => PROVIDER_TYPES.includes(a.type) && (a.action === 'GENERATE' || a.action === 'REGENERATE'));
  assert(spend.length === 0, `items de proveedor pagarían: ${spend.map((a) => `${a.itemKey}=${a.action}`).join(', ')}`);
}
const allReuse = (plan) => plan.actions.every((a) => a.action === 'REUSE');
/** planApplyWrites con roles v3 y fuentes "ready sin huella guardada". */
function applyOf(plan, mB, bpA, opts = {}) {
  return A.planApplyWrites(
    plan, mB.items, bpA, CTX,
    opts.srcStatus || (() => 'ready'),
    opts.srcFp || (() => null),
    { required: (t, v) => R.requiredArtifactTypes(3, t, v), typeOf: opts.typeOf || typeOfId },
  );
}
/** Registro "deshabilitado del linaje" de un item de A, con la huella que el apply le guardó. */
function disabledRecord(rec, fp) {
  return { ...rec, artifactStatus: 'disabled', inputFingerprint: fp };
}
function withNoise(bp) {
  // Perfiles y versiones que NO son parte del Blueprint: si alguien los colara
  // en el objeto, ninguna huella los lee.
  const x = clone(bp);
  x.course.theme = { family: 'aurora', mode: 'dark', themeVersion: 7 };
  x.course.assessmentProfile = { passingGrade: 85, attempts: 5, weights: { formative: 10, exams: 60, final: 30 } };
  x.course.promptVersion = 99;
  x.course.vcRendererVersion = 4;
  x.course.builderVersion = 'mbz@9';
  return x;
}

// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  const bp0 = buildBp(baseSpec());
  const m0 = manifestOf(bp0, 1);
  const chapterItems = (ch) => m0.items.filter((i) => i.chapterId === ch).map((i) => i.key);

  await check('fixture: el Manifest v3 tiene todos los tipos (13) y el plan sin cambios es todo REUSE', () => {
    const types = new Set(m0.items.map((i) => i.type));
    for (const t of B.MANIFEST_ITEM_TYPES_V3) assert(types.has(t), `falta ${t}`);
    const { plan } = planOf(bp0, buildBp(baseSpec()));
    assert(allReuse(plan), 'no todo REUSE');
    eq([plan.fromRulesVersion, plan.toRulesVersion, plan.fingerprintVersion, plan.invalidationPlanVersion], [3, 3, 2, 2], 'versiones');
    eq(plan.actions.length, m0.items.length, 'una acción por item');
  });

  // ── Filas de §P ───────────────────────────────────────────────────────────
  await check('§P activityEnabled ON→OFF: activity SOFT_DISABLE; todo lo demás REUSE (no se paga)', () => {
    const s = baseSpec(); chapterOf(s, C2).act = false;
    const { plan } = planOf(bp0, buildBp(s));
    expectPlan(plan, { [K('activity', C2)]: 'SOFT_DISABLE' });
    assertReason(plan, K('activity', C2), 'activity_toggled_off');
  });

  await check('§P activityEnabled OFF→ON: GENERATE sin artifact previo; REUSE del deshabilitado con la misma huella (vía apply)', () => {
    const s = baseSpec(); chapterOf(s, C5).act = true;
    const { plan } = planOf(bp0, buildBp(s));
    expectPlan(plan, { [K('activity', C5)]: 'GENERATE' });
    assertReason(plan, K('activity', C5), 'activity_toggled_on');
    // Ida y vuelta: A (C2 ON) → B (OFF) → C (ON).
    const sOff = baseSpec(); chapterOf(sOff, C2).act = false;
    const bpOff = buildBp(sOff);
    const ab = planOf(bp0, bpOff);
    const w = applyOf(ab.plan, ab.mB, bp0);
    const dis = w.statusChanges.find((x) => x.itemKey === K('activity', C2));
    assert(dis && dis.status === 'disabled' && dis.inputFingerprint, 'A→B deshabilita activity:C2 con huella');
    const recA = recordsOf(ab.mA, 'A').find((r) => r.itemKey === K('activity', C2));
    const recordsB = [...recordsOf(ab.mB, 'B'), disabledRecord(recA, dis.inputFingerprint)];
    const bc = planOf(bpOff, bp0, { mA: ab.mB, nB: 3, records: recordsB });
    expectPlan(bc.plan, { [K('activity', C2)]: 'REUSE' });
    assertReason(bc.plan, K('activity', C2), 'reenabled_matching_disabled');
    eq(byKey(bc.plan)[K('activity', C2)].fromItemRunId, recA.itemRunId, 'reusa el item run deshabilitado de A');
  });

  await check('§P videoEnabled ON→OFF: video + video_interactions SOFT_DISABLE; todo lo demás REUSE', () => {
    const s = baseSpec(); chapterOf(s, C1).video = false;
    const { plan } = planOf(bp0, buildBp(s));
    expectPlan(plan, { [K('video', C1)]: 'SOFT_DISABLE', [K('video_interactions', C1)]: 'SOFT_DISABLE' });
    assertReason(plan, K('video', C1), 'video_toggled_off');
    assertReason(plan, K('video_interactions', C1), 'video_toggled_off');
  });

  await check('§P videoEnabled OFF→ON: sin previo GENERATE (video pasa por el gate de Videogen); con deshabilitado coincidente REUSE de ambos', () => {
    const s = baseSpec(); chapterOf(s, C2).video = true;
    const bpOn = buildBp(s);
    const { plan, mB } = planOf(bp0, bpOn);
    expectPlan(plan, { [K('video', C2)]: 'GENERATE', [K('video_interactions', C2)]: 'GENERATE' });
    assertReason(plan, K('video', C2), 'video_toggled_on');
    eq(applyOf(plan, mB, bp0).videoItemsToGenerate, [K('video', C2)], 'videoItemsToGenerate (gate de aprobación)');
    // ON→OFF→ON: el video y sus interacciones vuelven sin pagar.
    const sOff = baseSpec(); chapterOf(sOff, C1).video = false;
    const bpOff = buildBp(sOff);
    const ab = planOf(bp0, bpOff);
    const w = applyOf(ab.plan, ab.mB, bp0);
    const fp = (k) => w.statusChanges.find((x) => x.itemKey === k && x.status === 'disabled').inputFingerprint;
    const recsA = recordsOf(ab.mA, 'A');
    const rec = (k) => recsA.find((r) => r.itemKey === k);
    const recordsB = [
      ...recordsOf(ab.mB, 'B'),
      disabledRecord(rec(K('video', C1)), fp(K('video', C1))),
      disabledRecord(rec(K('video_interactions', C1)), fp(K('video_interactions', C1))),
    ];
    const bc = planOf(bpOff, bp0, { mA: ab.mB, nB: 3, records: recordsB });
    expectPlan(bc.plan, {});
    assertReason(bc.plan, K('video_interactions', C1), 'reenabled_matching_disabled');
    eq(applyOf(bc.plan, bc.mB, bpOff).videoItemsToGenerate, [], 'ningún video a generar');
  });

  const profileRows = [
    ['§P passingGrade / intentos / pesos', (bp) => withNoise(bp)],
    ['§P theme (familia o modo)', (bp) => { const x = clone(bp); x.course.theme = { family: 'forest', mode: 'light' }; return x; }],
    ['§P subir promptVersion', (bp) => { const x = clone(bp); x.course.promptVersion = 2; return x; }],
    ['§P subir vcRendererVersion / themeVersion / builder', (bp) => { const x = clone(bp); x.course.vcRendererVersion = 2; x.course.themeVersion = 3; x.course.mbzBuilderVersion = 'v9'; return x; }],
  ];
  for (const [name, mutate] of profileRows) {
    await check(`${name}: no es input de ninguna huella ⇒ todo REUSE (solo re-empaquetar), plan idéntico al de "sin cambios"`, () => {
      const base = planOf(bp0, buildBp(baseSpec())).plan;
      const noisy = planOf(mutate(bp0), mutate(buildBp(baseSpec()))).plan;
      assert(allReuse(noisy), 'no todo REUSE');
      eq(noisy.planSha256, base.planSha256, 'planSha256');
    });
  }

  await check('perfiles: las huellas v3 (content, activity, video_interactions, final_exam, intros, audio) no cambian con perfiles colados', () => {
    const a = F.computeFingerprintsV3(bp0, { courseContextSha256: CTX });
    const b = F.computeFingerprintsV3(withNoise(bp0), { courseContextSha256: CTX });
    for (const it of m0.items) {
      const x = { variant: it.variant, videoIdentity: 'vid' };
      eq(F.matchFingerprintV3(b, it.key, x), F.matchFingerprintV3(a, it.key, x), `match ${it.key}`);
      eq(F.itemFingerprintV3(b, it.key, x), F.itemFingerprintV3(a, it.key, x), `item ${it.key}`);
    }
  });

  await check('§P contenido de un capítulo (título): LLM REGENERATE, Gamma/Videogen/TTS STALE_NO_AUTO, resto REUSE', () => {
    const s = baseSpec(); chapterOf(s, C1).title = 'Capítulo uno (revisado)';
    const { plan } = planOf(bp0, buildBp(s));
    expectPlan(plan, {
      [K('content', C1)]: 'REGENERATE',
      [K('experience', C1)]: 'REGENERATE',
      [K('presentation', C1)]: 'STALE_NO_AUTO',
      [K('video', C1)]: 'STALE_NO_AUTO',
      [K('video_interactions', C1)]: 'STALE_NO_AUTO',
      [K('activity', C1)]: 'REGENERATE',
      [K('audiobook_chapter', C1)]: 'STALE_NO_AUTO',
      [K('exam', M1)]: 'REGENERATE',
      [K('module_intro', M1)]: 'REGENERATE',
      [CK('course_plan')]: 'REGENERATE',
      [CK('course_intro')]: 'REGENERATE',
      [CK('audio_welcome')]: 'STALE_NO_AUTO',
      [CK('final_exam')]: 'REGENERATE',
    });
    assertNoProviderSpend(plan);
    assertReason(plan, K('video_interactions', C1), 'video_stale');
  });

  await check('§P contenido de un capítulo (objetivo, capítulo sin video ni actividad): mismo patrón, solo sus items', () => {
    const s = baseSpec(); chapterOf(s, C5).objective = 'Otro objetivo';
    const { plan } = planOf(bp0, buildBp(s));
    expectPlan(plan, {
      [K('content', C5)]: 'REGENERATE', [K('experience', C5)]: 'REGENERATE', [K('presentation', C5)]: 'STALE_NO_AUTO',
      [K('audiobook_chapter', C5)]: 'STALE_NO_AUTO', [K('exam', M2)]: 'REGENERATE', [K('module_intro', M2)]: 'REGENERATE',
      [CK('course_plan')]: 'REGENERATE', [CK('course_intro')]: 'REGENERATE', [CK('audio_welcome')]: 'STALE_NO_AUTO',
      [CK('final_exam')]: 'REGENERATE',
    });
  });

  await check('§P reorder del capítulo dentro del módulo: content REVIEW; nada más cambia (ni se paga)', () => {
    const s = baseSpec(); s.modules[0].chapters = [s.modules[0].chapters[1], s.modules[0].chapters[0], s.modules[0].chapters[2]];
    const { plan } = planOf(bp0, buildBp(s));
    expectPlan(plan, { [K('content', C1)]: 'REVIEW', [K('content', C2)]: 'REVIEW' });
    assertReason(plan, K('content', C1), 'reordered_within_module');
  });

  await check('§P mover el capítulo a otro módulo: content/experience REVIEW, exámenes e intros de ambos RG, final_exam y proveedores REUSE', () => {
    const s = baseSpec();
    const c3 = s.modules[0].chapters.pop();
    s.modules[1].chapters.push(c3);
    const { plan } = planOf(bp0, buildBp(s));
    expectPlan(plan, {
      [K('content', C3)]: 'REVIEW', [K('experience', C3)]: 'REVIEW',
      [K('exam', M1)]: 'REGENERATE', [K('exam', M2)]: 'REGENERATE',
      [K('module_intro', M1)]: 'REGENERATE', [K('module_intro', M2)]: 'REGENERATE',
      [CK('course_plan')]: 'REGENERATE', [CK('course_intro')]: 'REGENERATE', [CK('audio_welcome')]: 'STALE_NO_AUTO',
    });
    assertReason(plan, K('experience', C3), 'moved_across_modules');
    assertNoProviderSpend(plan);
  });

  await check('§P editar módulo (título/objetivo): content/experience del módulo REVIEW, exam + module_intro RG, proveedores REUSE', () => {
    const s = baseSpec(); s.modules[1].title = 'Aplicaciones prácticas';
    const { plan } = planOf(bp0, buildBp(s));
    expectPlan(plan, {
      [K('content', C4)]: 'REVIEW', [K('content', C5)]: 'REVIEW', [K('experience', C4)]: 'REVIEW', [K('experience', C5)]: 'REVIEW',
      [K('exam', M2)]: 'REGENERATE', [K('module_intro', M2)]: 'REGENERATE',
      [CK('course_plan')]: 'REGENERATE', [CK('course_intro')]: 'REGENERATE', [CK('audio_welcome')]: 'STALE_NO_AUTO',
    });
    assertReason(plan, K('experience', C4), 'module_context_changed');
    assertNoProviderSpend(plan);
  });

  await check('§P agregar capítulo: sus items GENERATE (según flags), exam/intros/final_exam RG, el resto REUSE', () => {
    const s = baseSpec(); s.modules[1].chapters.push({ id: C7, title: 'Capítulo siete', objective: 'Objetivo siete', video: true, act: true });
    const { plan, mB } = planOf(bp0, buildBp(s));
    const exp = {
      [K('exam', M2)]: 'REGENERATE', [K('module_intro', M2)]: 'REGENERATE', [CK('course_plan')]: 'REGENERATE',
      [CK('course_intro')]: 'REGENERATE', [CK('audio_welcome')]: 'STALE_NO_AUTO', [CK('final_exam')]: 'REGENERATE',
    };
    for (const t of ['content', 'experience', 'presentation', 'video', 'video_interactions', 'activity', 'audiobook_chapter']) exp[K(t, C7)] = 'GENERATE';
    expectPlan(plan, exp);
    assertReason(plan, K('presentation', C7), 'chapter_added');
    assertReason(plan, CK('final_exam'), 'course_membership_changed');
    eq(applyOf(plan, mB, bp0).videoItemsToGenerate, [K('video', C7)], 'videoItemsToGenerate');
  });

  await check('§P quitar capítulo: sus items SOFT_DISABLE, exam/intros/final_exam RG, el resto REUSE', () => {
    const s = baseSpec(); s.modules[1].chapters.shift(); // C4
    const { plan } = planOf(bp0, buildBp(s));
    const exp = {
      [K('exam', M2)]: 'REGENERATE', [K('module_intro', M2)]: 'REGENERATE', [CK('course_plan')]: 'REGENERATE',
      [CK('course_intro')]: 'REGENERATE', [CK('audio_welcome')]: 'STALE_NO_AUTO', [CK('final_exam')]: 'REGENERATE',
    };
    for (const k of chapterItems(C4)) exp[k] = 'SOFT_DISABLE';
    expectPlan(plan, exp);
    for (const k of chapterItems(C4)) assertReason(plan, k, 'chapter_deleted');
  });

  await check('§P cambiar activityEngine (h5p → scorm): SOLO activity REGENERATE (nueva variante); el apply no pide roles de más', () => {
    const s = baseSpec(); s.engine = 'scorm';
    const { plan, mB } = planOf(bp0, buildBp(s));
    const acts = m0.items.filter((i) => i.type === 'activity').map((i) => i.key);
    eq(acts.length, 4, 'actividades del fixture (C1, C2, C4, C6)');
    expectPlan(plan, Object.fromEntries(acts.map((k) => [k, 'REGENERATE'])));
    for (const k of acts) assertReason(plan, k, 'activity_engine_changed');
    const w = applyOf(plan, mB, bp0);
    eq(w.missingRoles, [], 'missingRoles');
    for (const k of acts) eq(w.seeds.find((x) => x.itemKey === k).status, 'pending', `${k} pending`);
  });

  await check('finalExam ON→OFF → SOFT_DISABLE; OFF→ON → GENERATE, o REUSE del deshabilitado; con un content nuevo en medio → GENERATE', () => {
    const sOff = baseSpec(); sOff.finalExam = false;
    const bpOff = buildBp(sOff);
    const ab = planOf(bp0, bpOff);
    expectPlan(ab.plan, { [CK('final_exam')]: 'SOFT_DISABLE' });
    assertReason(ab.plan, CK('final_exam'), 'final_exam_toggled_off');
    // OFF→ON sin historia.
    const fresh = planOf(bpOff, bp0);
    expectPlan(fresh.plan, { [CK('final_exam')]: 'GENERATE' });
    assertReason(fresh.plan, CK('final_exam'), 'final_exam_toggled_on');
    // OFF→ON con el deshabilitado de A.
    const w = applyOf(ab.plan, ab.mB, bp0);
    const fp = w.statusChanges.find((x) => x.itemKey === CK('final_exam')).inputFingerprint;
    const recA = recordsOf(ab.mA, 'A').find((r) => r.itemKey === CK('final_exam'));
    const recordsB = [...recordsOf(ab.mB, 'B'), disabledRecord(recA, fp)];
    const bc = planOf(bpOff, bp0, { mA: ab.mB, nB: 3, records: recordsB });
    expectPlan(bc.plan, {});
    // …pero si un content cambió, el banco viejo no sirve.
    const sOn2 = baseSpec(); chapterOf(sOn2, C6).title = 'Seis bis';
    const bc2 = planOf(bpOff, buildBp(sOn2), { mA: ab.mB, nB: 3, records: recordsB });
    eq(byKey(bc2.plan)[CK('final_exam')].action, 'GENERATE', 'final_exam con content nuevo');
  });

  await check('STALE_NO_AUTO: presentation / audio_welcome / audiobook_chapter / video nunca REGENERATE (content nuevo o artifact ya stale)', () => {
    const s = baseSpec(); chapterOf(s, C4).title = 'Cuatro bis';
    const { plan } = planOf(bp0, buildBp(s));
    for (const k of [K('presentation', C4), K('video', C4), K('audiobook_chapter', C4), CK('audio_welcome')]) {
      eq(byKey(plan)[k].action, 'STALE_NO_AUTO', k);
    }
    // Artifacts de proveedor ya stale y sin cambios: siguen STALE_NO_AUTO; un LLM stale sí REGENERATE.
    const staleOver = {};
    for (const k of [K('presentation', C2), K('audiobook_chapter', C2), K('video', C3), CK('audio_welcome'), K('experience', C2)]) {
      staleOver[k] = { artifactStatus: 'stale' };
    }
    const p2 = planOf(bp0, buildBp(baseSpec()), { over: staleOver }).plan;
    expectPlan(p2, {
      [K('presentation', C2)]: 'STALE_NO_AUTO', [K('audiobook_chapter', C2)]: 'STALE_NO_AUTO', [K('video', C3)]: 'STALE_NO_AUTO',
      // …y sus interacciones siguen al video stale (describen ese video).
      [K('video_interactions', C3)]: 'STALE_NO_AUTO',
      [CK('audio_welcome')]: 'STALE_NO_AUTO', [K('experience', C2)]: 'REGENERATE',
    });
    // Sin salida previa: no hay nada que conservar ⇒ GENERATE (nunca un STALE vacío).
    const p3 = planOf(bp0, buildBp(s), { over: { [K('presentation', C4)]: null } }).plan;
    eq(byKey(p3)[K('presentation', C4)].action, 'GENERATE', 'presentation sin salida previa');
  });

  await check('video_interactions sigue al video: video STALE ⇒ STALE; video GENERATE ⇒ REGENERATE; video reusado ⇒ REUSE; huella = own + identidad del video', () => {
    const s = baseSpec(); chapterOf(s, C1).title = 'Uno bis';
    const bp1 = buildBp(s);
    // (a) video con salida previa → STALE; interacciones STALE (describen el video vigente).
    const a = planOf(bp0, bp1).plan;
    eq([byKey(a)[K('video', C1)].action, byKey(a)[K('video_interactions', C1)].action], ['STALE_NO_AUTO', 'STALE_NO_AUTO'], '(a)');
    // (b) el video nunca se produjo → GENERATE ⇒ las interacciones describen un video nuevo.
    const b = planOf(bp0, bp1, { over: { [K('video', C1)]: null } }).plan;
    eq([byKey(b)[K('video', C1)].action, byKey(b)[K('video_interactions', C1)].action], ['GENERATE', 'REGENERATE'], '(b)');
    assertReason(b, K('video_interactions', C1), 'video_regenerated');
    // (b2) mismo caso sin cambio de content (video fallido en A).
    const b2 = planOf(bp0, buildBp(baseSpec()), { over: { [K('video', C1)]: { status: 'failed' } } }).plan;
    eq([byKey(b2)[K('video', C1)].action, byKey(b2)[K('video_interactions', C1)].action], ['GENERATE', 'REGENERATE'], '(b2)');
    // (c) video reusado ⇒ REUSE, y la huella de match depende de la identidad del video.
    const c = planOf(bp0, buildBp(baseSpec())).plan;
    const vi = byKey(c)[K('video_interactions', C1)];
    eq(vi.action, 'REUSE', '(c)');
    const fps = F.computeFingerprintsV3(bp0, { courseContextSha256: CTX });
    eq(vi.matchFingerprint, F.matchFingerprintV3(fps, K('video_interactions', C1), { videoIdentity: `out/A/${K('video', C1)}` }), 'match = own + identidad');
    assert(F.matchFingerprintV3(fps, K('video_interactions', C1), { videoIdentity: 'otro' }) !== vi.matchFingerprint, 'otra identidad ⇒ otra huella');
    eq(F.matchFingerprintV3(fps, K('video_interactions', C1), {}), null, 'sin identidad ⇒ null');
    // (d) deshabilitado cuyo video es OTRO (el video del linaje se regeneró) ⇒ GENERATE.
    const sOff = baseSpec(); chapterOf(sOff, C1).video = false;
    const bpOff = buildBp(sOff);
    const ab = planOf(bp0, bpOff);
    const w = applyOf(ab.plan, ab.mB, bp0);
    const fpOf = (k) => w.statusChanges.find((x) => x.itemKey === k).inputFingerprint;
    const recsA = recordsOf(ab.mA, 'A');
    const rec = (k) => recsA.find((r) => r.itemKey === k);
    const recordsB = [
      ...recordsOf(ab.mB, 'B'),
      { ...disabledRecord(rec(K('video', C1)), fpOf(K('video', C1))), outputIdentity: 'out/otro-video' },
      disabledRecord(rec(K('video_interactions', C1)), fpOf(K('video_interactions', C1))),
    ];
    const d = planOf(bpOff, bp0, { mA: ab.mB, nB: 3, records: recordsB }).plan;
    eq([byKey(d)[K('video', C1)].action, byKey(d)[K('video_interactions', C1)].action], ['REUSE', 'GENERATE'], '(d)');
    assertReason(d, K('video_interactions', C1), 'disabled_artifact_does_not_match');
  });

  await check('reorder (12 permutaciones de capítulos y módulos): nunca REGENERATE/GENERATE/STALE; proveedores siempre REUSE', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    for (let n = 0; n < 12; n++) {
      const s = baseSpec();
      s.modules = shuffle(s.modules).map((m) => ({ ...m, chapters: shuffle(m.chapters) }));
      const { plan } = planOf(bp0, buildBp(s));
      const bad = plan.actions.filter((a) => a.action !== 'REUSE' && a.action !== 'REVIEW');
      assert(bad.length === 0, `perm ${n}: ${bad.map((a) => `${a.itemKey}=${a.action}`).join(', ')}`);
      const rev = plan.actions.filter((a) => a.action === 'REVIEW' && a.type !== 'content');
      assert(rev.length === 0, `perm ${n}: REVIEW fuera de content: ${rev.map((a) => a.itemKey).join(', ')}`);
      assert(plan.actions.filter((a) => PROVIDER_TYPES.includes(a.type)).every((a) => a.action === 'REUSE'), `perm ${n}: proveedor no REUSE`);
    }
  });

  await check('determinismo: items/registros mezclados y Blueprint con claves reordenadas ⇒ mismo plan; sha fijado', () => {
    const s = baseSpec(); chapterOf(s, C1).title = 'Capítulo uno (revisado)';
    const bp1 = buildBp(s);
    const { plan, mA, mB } = planOf(bp0, bp1);
    const recs = recordsOf(mA, 'A').reverse();
    const again = P.computeInvalidationPlan({
      from: { blueprint: shuffleKeys(bp0), manifest: { ...mA, items: [...mA.items].reverse() }, items: recs, courseContextSha256: CTX },
      to: { blueprint: shuffleKeys(bp1), manifest: { ...mB, items: [...mB.items].reverse() }, courseContextSha256: CTX },
    });
    eq(again.planSha256, plan.planSha256, 'planSha256');
    eq(again.actions.map((a) => a.itemKey), plan.actions.map((a) => a.itemKey), 'orden canónico');
    eq(plan.planSha256, PINNED_PLAN_SHA, 'sha fijado (cambiar una huella v3 o una regla cambia el plan)');
    // Orden canónico v3: plan, intro, audio_welcome, luego por módulo…; final_exam al final.
    eq(plan.actions.slice(0, 4).map((a) => a.type), ['course_plan', 'course_intro', 'audio_welcome', 'module_intro'], 'orden (cabeza)');
    eq(plan.actions[plan.actions.length - 1].type, 'final_exam', 'orden (cola)');
  });

  await check('apply v3 (planApplyWrites): STALE_NO_AUTO carried stale con la huella de A; REGENERATE pending; SOFT_DISABLE con huella; roles por variant', () => {
    const s = baseSpec(); chapterOf(s, C1).title = 'Uno bis'; chapterOf(s, C2).act = false;
    const { plan, mB } = planOf(bp0, buildBp(s));
    const w = applyOf(plan, mB, bp0);
    eq(w.missingRoles, [], 'missingRoles');
    eq(w.videoItemsToGenerate, [], 'ningún video a generar');
    const seed = (k) => w.seeds.find((x) => x.itemKey === k);
    for (const k of [K('presentation', C1), K('video', C1), K('video_interactions', C1), K('audiobook_chapter', C1), CK('audio_welcome')]) {
      eq(seed(k).status, 'completed', `${k} seed completed`);
      const rows = w.carried.filter((c) => c.itemKey === k);
      assert(rows.length > 0 && rows.every((c) => c.status === 'stale'), `${k}: carried stale`);
      const a = byKey(plan)[k];
      assert(a.fromMatchFingerprint && rows.every((c) => c.inputFingerprint === a.fromMatchFingerprint), `${k}: huella de A`);
      assert(w.statusChanges.some((x) => x.itemKey === k && x.status === 'stale'), `${k}: A → stale`);
    }
    for (const k of [K('content', C1), K('experience', C1), K('activity', C1), K('exam', M1), CK('final_exam')]) {
      eq(seed(k).status, 'pending', `${k} pending`);
    }
    const dis = w.statusChanges.find((x) => x.itemKey === K('activity', C2));
    eq([dis.status, dis.inputFingerprint], ['disabled', byKey(plan)[K('activity', C2)].fromMatchFingerprint], 'activity:C2 disabled con huella');
    // Roles: un activity h5p cuya salida de origen es SCORM no se reutiliza en silencio.
    const recs = recordsOf(manifestOf(bp0, 1), 'A', {
      [K('activity', C4)]: { artifactIds: [`A|${K('activity', C4)}|dynamic_scorm_html`, `A|${K('activity', C4)}|dynamic_scorm_manifest`] },
    });
    const p2 = planOf(bp0, buildBp(baseSpec()), { records: recs });
    eq(applyOf(p2.plan, p2.mB, bp0).missingRoles, [`${K('activity', C4)}:dynamic_h5p_params_json:missing_role`], 'missingRoles activity');
  });

  await check('entradas inválidas fallan fuerte: mezclar v3 con v1/v2, Blueprint del schema equivocado, activity sin variant, scorm en v3, capítulo inexistente', () => {
    const m3 = manifestOf(bp0, 1);
    const v1bp = snap.buildBlueprintSnapshot({ id: COURSE_ID, title: 'x' },
      [{ id: M1, position: 0, title: 'M', objective: null, exam_enabled: false }],
      [{ id: C1, module_id: M1, position: 0, title: 'C', objective: null, video_enabled: false }]);
    const m1 = B.buildGenerationManifest(v1bp, { courseId: COURSE_ID, blueprintId: 9, blueprintNumber: 9, blueprintSha256: snap.snapshotSha256(v1bp) });
    throwsRe(() => P.computeInvalidationPlan({ from: { blueprint: v1bp, manifest: m1, items: [] }, to: { blueprint: bp0, manifest: m3 } }), /^INVALIDATION_V3_NOT_IMPLEMENTED/, 'v1 → v3');
    throwsRe(() => P.computeInvalidationPlan({ from: { blueprint: bp0, manifest: m3, items: [] }, to: { blueprint: v1bp, manifest: m1 } }), /^INVALIDATION_V3_NOT_IMPLEMENTED/, 'v3 → v1');
    throwsRe(() => P.computeInvalidationPlan({ from: { blueprint: v1bp, manifest: m3, items: [] }, to: { blueprint: bp0, manifest: m3 } }), /^INVALIDATION_V3_NOT_IMPLEMENTED/, 'v3 con Blueprint v1');
    P.assertInvalidationRulesSupported(3, 3, [2, 2]);
    P.assertInvalidationRulesSupported(1, 2, [1, 1]);
    throwsRe(() => P.assertInvalidationRulesSupported(2, 3), /^INVALIDATION_V3_NOT_IMPLEMENTED/, '(2,3)');
    const noVariant = clone(m3); noVariant.items.find((i) => i.type === 'activity').variant = undefined;
    throwsRe(() => P.computeInvalidationPlan({ from: { blueprint: bp0, manifest: m3, items: [] }, to: { blueprint: bp0, manifest: noVariant } }), /INVALID_INVALIDATION_INPUT.*variant/, 'activity sin variant');
    const withScorm = clone(m3); withScorm.items.push({ key: K('scorm', C1), type: 'scorm', scope: 'chapter', moduleId: M1, chapterId: C1, dependsOn: [] });
    throwsRe(() => P.computeInvalidationPlan({ from: { blueprint: bp0, manifest: m3, items: [] }, to: { blueprint: bp0, manifest: withScorm } }), /INVALID_INVALIDATION_INPUT.*tipo desconocido/, 'scorm en v3');
    const ghost = clone(m3); ghost.items.push({ key: K('experience', C7), type: 'experience', scope: 'chapter', moduleId: M1, chapterId: C7, dependsOn: [] });
    throwsRe(() => P.computeInvalidationPlan({ from: { blueprint: bp0, manifest: m3, items: [] }, to: { blueprint: bp0, manifest: ghost } }), /INVALID_INVALIDATION_INPUT.*capítulo/, 'capítulo inexistente');
    throwsRe(() => PV3.computeInvalidationPlanV3({ from: { blueprint: v1bp, manifest: m1, items: [] }, to: { blueprint: bp0, manifest: m3 } }), /INVALID_INVALIDATION_INPUT/, 'plan v3 directo con v1');
  });

  await check('huellas: v1/v2 siguen en INVALIDATION_FINGERPRINT_VERSION=1; v3 usa 2 y nunca coincide con v1 para el mismo capítulo', () => {
    eq([F.INVALIDATION_FINGERPRINT_VERSION, F.INVALIDATION_FINGERPRINT_VERSION_V3], [1, 2], 'versiones');
    const v1 = F.computeFingerprints(snap.structuralViewV1(bp0), { courseContextSha256: CTX });
    const v3 = F.computeFingerprintsV3(bp0, { courseContextSha256: CTX });
    assert(v1.content.get(C1).own !== v3.content.get(C1).own, 'own v1 = own v3');
    // Los toggles (video/actividad/examen/finalExam) no entran en ninguna huella de content.
    const s = baseSpec(); s.finalExam = false; chapterOf(s, C1).video = false; chapterOf(s, C1).act = false; s.modules[0].exam = false;
    const v3b = F.computeFingerprintsV3(buildBp(s), { courseContextSha256: CTX });
    eq(v3b.content.get(C1), v3.content.get(C1), 'content C1 independiente de los toggles');
    eq([v3b.courseOutline, v3b.finalExam], [v3.courseOutline, v3.finalExam], 'outline / final_exam independientes de los toggles');
  });

  await check('artifactOutputIdentity: filas carried (otro id, misma ruta) = misma identidad; otra ruta ≠; sin ruta → por id; vacío → null', () => {
    const a = [{ id: '1', type: 'dynamic_video', bucket: 'b', path: 'p/v1.json' }];
    const carried = [{ id: '2', type: 'dynamic_video', bucket: 'b', path: 'p/v1.json' }];
    const other = [{ id: '1', type: 'dynamic_video', bucket: 'b', path: 'p/v2.json' }];
    eq(A.artifactOutputIdentity(carried), A.artifactOutputIdentity(a), 'carried');
    assert(A.artifactOutputIdentity(other) !== A.artifactOutputIdentity(a), 'otra ruta');
    assert(A.artifactOutputIdentity([{ id: '1', path: null }]) !== A.artifactOutputIdentity([{ id: '2', path: null }]), 'sin ruta ⇒ por id');
    eq(A.artifactOutputIdentity([]), null, 'vacío');
  });

  await check('v1/v2 sin cambios: check-invalidation-plan.js, check-invalidation-apply.js y check-coherence-engine.js pasan contra este dist', () => {
    for (const s of ['check-invalidation-plan.js', 'check-invalidation-apply.js', 'check-coherence-engine.js']) {
      const r = spawnSync(process.execPath, [path.join(__dirname, s), distRoot], { encoding: 'utf8' });
      assert(r.status === 0, `${s}: exit ${r.status}\n${(r.stdout || '').slice(-800)}${(r.stderr || '').slice(-800)}`);
    }
  });

  // ── Coherencia v3 ─────────────────────────────────────────────────────────
  await check('coherencia v3: Blueprint schemaVersion 2 → ruleset coherence-rules-v3@1, sha v2, mismas S1–S3 que su vista v1; v1 byte-idéntico', () => {
    const s = baseSpec(); s.modules[1].chapters[1].title = 'Capítulo cuatro'; // casi duplicado de C4 (S1)
    const bp = buildBp(s);
    const rep = REPORT.buildCoherenceReport({ blueprint: bp });
    eq(rep.ruleset, 'coherence-rules-v3@1', 'ruleset');
    eq(rep.inputs.blueprintSha256, snap.snapshotSha256V2(bp), 'blueprintSha256 = sha v2');
    const view = snap.structuralViewV1(bp);
    const repV1 = REPORT.buildCoherenceReport({ blueprint: view });
    eq(repV1.ruleset, 'coherence-rules@1', 'ruleset v1');
    eq(repV1.inputs.blueprintSha256, REPORT.canonicalBlueprintSha256(view), 'sha v1');
    eq(rep.findings, repV1.findings, 'mismos findings S1–S3');
    assert(rep.findings.some((f) => f.rule === 'S1'), 'el fixture dispara S1');
    // jsonb round trip del Blueprint v2 ⇒ mismo reporte.
    eq(REPORT.buildCoherenceReport({ blueprint: shuffleKeys(bp) }).reportSha256, rep.reportSha256, 'claves reordenadas');
  });

  await check('coherencia v3: S4 (curso sin nada calificable) solo en Blueprints v2; capa de contenido sobre v2 funciona', () => {
    const s = baseSpec(); s.finalExam = false;
    for (const m of s.modules) { m.exam = false; for (const c of m.chapters) c.act = false; }
    const bp = buildBp(s);
    const rep = REPORT.buildCoherenceReport({ blueprint: bp });
    const s4 = rep.findings.filter((f) => f.rule === 'S4');
    eq(s4.length, 1, 'un S4');
    eq(s4[0].severity, 'info', 'S4 info');
    assert(!REPORT.buildCoherenceReport({ blueprint: bp0 }).findings.some((f) => f.rule === 'S4'), 'S4 con cosas calificables');
    const content = REPORT.buildCoherenceReport({
      blueprint: bp0,
      contextSummaries: { [C1]: { summary: 'x', concepts_introduced: ['a'], key_terms: ['a'] }, [C2]: { summary: 'y', concepts_introduced: ['a'], key_terms: ['a'] } },
      manifest: m0,
    });
    eq([content.layers.content, content.ruleset], [true, 'coherence-rules-v3@1'], 'capa de contenido');
    assert(content.inputs.manifestSha256 && content.inputs.contextSummariesSha256, 'hashes de inputs');
  });

  // ── Auditorías de staging v3 ──────────────────────────────────────────────
  const rowOf = (bp, m, over = {}) => {
    const t = m.totals;
    return {
      course_id: COURSE_ID, manifest_json: m, blueprint_snapshot_json: bp, scorm_count: 0,
      content_count: t.contentCount, video_count: t.videoCount, exam_count: t.examCount, course_plan_count: t.coursePlanCount,
      course_intro_count: t.courseIntroCount, module_intro_count: t.moduleIntroCount, experience_count: t.experienceCount,
      presentation_count: t.presentationCount, video_interactions_count: t.videoInteractionsCount, activity_count: t.activityCount,
      audiobook_chapter_count: t.audiobookChapterCount, audio_welcome_count: t.audioWelcomeCount, final_exam_count: t.finalExamCount,
      ...over,
    };
  };
  await check('auditoría v3 (lib/audit-v3.js): tablas = código compilado; Manifests del builder real sin violaciones (varias configs)', () => {
    eq(AUD.V3_ITEM_TYPES, [...B.MANIFEST_ITEM_TYPES_V3], 'tipos v3');
    for (const t of B.MANIFEST_ITEM_TYPES_V3) {
      if (t === 'activity') {
        for (const v of ['h5p', 'scorm']) eq(AUD.requiredRolesV3(t, v), R.requiredArtifactTypesV3(t, v), `roles ${t}/${v}`);
        eq(AUD.requiredRolesV3(t, undefined), undefined, 'activity sin variant');
      } else {
        eq(AUD.requiredRolesV3(t), R.requiredArtifactTypesV3(t), `roles ${t}`);
      }
    }
    const configs = [baseSpec(), (() => { const s = baseSpec(); s.engine = 'scorm'; s.finalExam = false; return s; })(),
      (() => { const s = baseSpec(); for (const m of s.modules) for (const c of m.chapters) { c.video = !c.video; c.act = !c.act; } return s; })()];
    for (const s of configs) {
      const bp = buildBp(s);
      eq(AUD.auditManifestV3(rowOf(bp, manifestOf(bp, 1)), 'M'), [], `config ${s.engine}/${s.finalExam}`);
    }
  });

  await check('auditoría v3: detecta scorm en v3, item faltante, variant equivocado, conteo de columna, features, video_interactions sin video, rol faltante', () => {
    const cases = [
      ['scorm en v3', (m) => m.items.push({ key: K('scorm', C1), type: 'scorm', scope: 'chapter', moduleId: M1, chapterId: C1, dependsOn: [] }), {}, /type desconocido/],
      ['experience faltante', (m) => { m.items = m.items.filter((i) => i.key !== K('experience', C2)); }, {}, /experience \(esperado 1\)/],
      ['variant', (m) => { m.items.find((i) => i.type === 'activity').variant = 'scorm'; }, {}, /variant/],
      ['columna', () => {}, { presentation_count: 99 }, /presentation_count=99/],
      ['scorm_count', () => {}, { scorm_count: 6 }, /scorm_count=6/],
      ['features', (m) => { m.features.finalExam = false; }, {}, /features=/],
      ['vi sin video', (m) => m.items.push({ key: K('video_interactions', C2), type: 'video_interactions', scope: 'chapter', moduleId: M1, chapterId: C2, dependsOn: [] }), {}, /video_interactions \(esperado 0\)/],
      ['final_exam de más', (m) => m.items.push({ key: CK('final_exam'), type: 'final_exam', scope: 'course', moduleId: null, chapterId: null, dependsOn: [] }), {}, /final_exam/],
      ['dependencia colgante', (m) => { m.items.find((i) => i.key === K('experience', C1)).dependsOn = ['content:nope']; }, {}, /content:nope/],
    ];
    for (const [name, mutate, over, re] of cases) {
      const m = clone(m0);
      mutate(m);
      const out = AUD.auditManifestV3(rowOf(bp0, m, over), 'M');
      assert(out.some((x) => re.test(x)), `${name}: ${JSON.stringify(out)}`);
    }
    const bpV1 = snap.structuralViewV1(bp0);
    assert(AUD.auditManifestV3(rowOf(bpV1, m0), 'M').some((x) => /schemaVersion 1/.test(x)), 'Blueprint v1 bajo rulesVersion 3');
    eq(AUD.auditItemRolesV3({ id: 1, item_key: 'activity:x', type: 'activity', variant: 'scorm', artifact_types: ['dynamic_scorm_html', 'dynamic_scorm_manifest'] }), [], 'roles OK');
    assert(AUD.auditItemRolesV3({ id: 1, item_key: 'activity:x', type: 'activity', variant: 'scorm', artifact_types: ['dynamic_scorm_html'] })[0].includes('dynamic_scorm_manifest'), 'rol faltante');
    assert(AUD.auditItemRolesV3({ id: 1, item_key: 'activity:x', type: 'activity', variant: null, artifact_types: [] })[0].includes('sin roles'), 'variant desconocido');
  });

  // ── Fix round 1 (review G2) ───────────────────────────────────────────────
  await check('fix round 1 I3: video_interactions compara contra la identidad REGISTRADA (no la del video actual): distinta → REGENERATE; ausente → REGENERATE', () => {
    const vi = K('video_interactions', C1);
    // El video de A se regeneró en el run (identidad nueva) y las interacciones no: describen el video viejo.
    const p1 = planOf(bp0, buildBp(baseSpec()), { over: { [vi]: { consumedVideoIdentity: 'out/A/video-gen1' } } }).plan;
    expectPlan(p1, { [vi]: 'REGENERATE' });
    assertReason(p1, vi, 'video_changed');
    eq(byKey(p1)[vi].fromMatchFingerprint, F.matchFingerprintV3(F.computeFingerprintsV3(bp0, { courseContextSha256: CTX }), vi, { videoIdentity: 'out/A/video-gen1' }), 'huella de origen = la registrada');
    const p2 = planOf(bp0, buildBp(baseSpec()), { over: { [vi]: { consumedVideoIdentity: null } } }).plan;
    expectPlan(p2, { [vi]: 'REGENERATE' });
    assertReason(p2, vi, 'video_identity_unknown');
  });

  await check('fix round 1 I1: providerModes explícitos (default real, mock solo con escape de entorno), nunca derivados de videoMode', () => {
    const PM = loadDist('modules/dynamic-generation/provider-modes.js');
    eq(PM.resolveProviderModes(3, undefined, {}), { presentation: 'real', audio: 'real' }, 'default real');
    eq(PM.resolveProviderModes(3, { audio: 'real' }, {}), { presentation: 'real', audio: 'real' }, 'parcial');
    throwsRe(() => PM.resolveProviderModes(3, { presentation: 'mock' }, {}), /^provider_mock_not_allowed/, 'mock sin escape');
    eq(PM.resolveProviderModes(3, { presentation: 'mock' }, { DYNAMIC_ALLOW_PROVIDER_MOCK: 'true' }), { presentation: 'mock', audio: 'real' }, 'mock con escape');
    throwsRe(() => PM.resolveProviderModes(3, { presentation: 'fake' }, {}), /^provider_mode_invalid/, 'valor inválido');
    throwsRe(() => PM.resolveProviderModes(3, { video: 'mock' }, {}), /^provider_mode_invalid/, 'clave desconocida');
    eq(PM.resolveProviderModes(1, undefined, {}), undefined, 'v1: nada congelado');
    eq(PM.frozenProviderModesOf({ videoMode: 'mock' }), null, 'videoMode no es un modo de proveedor');
    eq(PM.frozenProviderModesOf({ providerModes: { presentation: 'mock', audio: 'x' } }), null, 'corrupto → null');
    const W = loadDist('workers/dynamic-provider-worker.js');
    eq([W.providerModeOf({ videoMode: 'mock' }, 'presentation'), W.providerModeOf({ videoMode: 'real', providerModes: { presentation: 'mock', audio: 'real' } }, 'audiobook_chapter')], [null, 'real'], 'worker lee providerModes');
  });

  await check('fix round 1 I1: assertNoMockArtifactsForRealPackage — un run no congelado como mock nunca empaqueta fixtures; la auditoría aplica la misma regla', () => {
    const G = loadDist('modules/dynamic-packaging/packaging-guards.js');
    const mockPres = { id: 'a1', type: 'dynamic_presentation', metadata: { mock: true }, itemKey: 'presentation:x' };
    const mockAudio = { id: 'a2', type: 'dynamic_audio_mp3', metadata: { fixture: true }, itemKey: 'audio_welcome:1' };
    const realPres = { id: 'a3', type: 'dynamic_presentation', metadata: {}, itemKey: 'presentation:y' };
    const runReal = { id: 'r1', input_payload: { providerModes: { presentation: 'real', audio: 'real' } } };
    const runMockPres = { id: 'r2', input_payload: { providerModes: { presentation: 'mock', audio: 'real' } } };
    const runNone = { id: 'r3', input_payload: { videoMode: 'mock' } };
    G.assertNoMockArtifactsForRealPackage(runReal, [realPres]);
    G.assertNoMockArtifactsForRealPackage(runMockPres, [mockPres, realPres]);
    throwsRe(() => G.assertNoMockArtifactsForRealPackage(runReal, [mockPres]), /^MOCK_ARTIFACT_IN_REAL_RUN.*presentation:x/, 'real + fixture');
    throwsRe(() => G.assertNoMockArtifactsForRealPackage(runMockPres, [mockAudio]), /^MOCK_ARTIFACT_IN_REAL_RUN.*audio_welcome/, 'mock solo para Gamma, no TTS');
    throwsRe(() => G.assertNoMockArtifactsForRealPackage(runNone, [mockPres]), /^MOCK_ARTIFACT_IN_REAL_RUN/, 'sin modos congelados');
    throwsRe(() => G.assertNoMockArtifactsForRealPackage(runMockPres, [{ id: 'a4', type: 'dynamic_exam_gift', metadata: { mock: true } }]), /^MOCK_ARTIFACT_IN_REAL_RUN/, 'fixture de un tipo no proveedor');
    const row = (pm, types) => ({ id: 1, item_key: 'k', provider_modes: pm, mock_artifact_types: types });
    eq(AUD.auditMockArtifactsV3(row(runMockPres.input_payload.providerModes, ['dynamic_presentation'])), [], 'auditoría: ok');
    eq(AUD.auditMockArtifactsV3(row(runReal.input_payload.providerModes, ['dynamic_presentation'])).length, 1, 'auditoría: real + fixture');
    eq(AUD.auditMockArtifactsV3(row(null, ['dynamic_audio_mp3'])).length, 1, 'auditoría: sin modos');
  });

  await check('fix round 1 I2: cascada de regenerateItem por rulesVersion — v1/v2 idéntica a la de Fase 8; v3 según las reglas de invalidación v3', () => {
    const RC = loadDist('modules/dynamic-generation/regeneration-cascade.js');
    const v1items = [
      { key: `content:${C1}`, type: 'content', moduleId: M1, chapterId: C1 }, { key: `scorm:${C1}`, type: 'scorm', moduleId: M1, chapterId: C1 },
      { key: `video:${C1}`, type: 'video', moduleId: M1, chapterId: C1 }, { key: `exam:${M1}`, type: 'exam', moduleId: M1, chapterId: null },
    ];
    for (const rv of [1, 2]) {
      eq(RC.regenerationCascade(rv, v1items, v1items[0]), { regenerate: [`scorm:${C1}`, `exam:${M1}`], stale: [`video:${C1}`] }, `v${rv} content`);
      eq(RC.regenerationCascade(rv, v1items, v1items[2]), { regenerate: [], stale: [] }, `v${rv} video`);
    }
    const it = (k) => m0.items.find((x) => x.key === k);
    eq(RC.regenerationCascade(3, m0.items, it(K('content', C1))), {
      regenerate: [K('experience', C1), K('activity', C1), K('exam', M1), CK('final_exam')],
      stale: [K('presentation', C1), K('video', C1), K('video_interactions', C1), K('audiobook_chapter', C1)],
    }, 'v3 content');
    eq(RC.regenerationCascade(3, m0.items, it(K('content', C5))), {
      regenerate: [K('experience', C5), K('exam', M2), CK('final_exam')], stale: [K('presentation', C5), K('audiobook_chapter', C5)],
    }, 'v3 content sin video ni actividad');
    eq(RC.regenerationCascade(3, m0.items, it(K('video', C1))), { regenerate: [K('video_interactions', C1)], stale: [] }, 'v3 video');
    eq(RC.regenerationCascade(3, m0.items, it(CK('course_intro'))), { regenerate: [], stale: [CK('audio_welcome')] }, 'v3 course_intro');
    for (const k of [CK('course_plan'), K('presentation', C1), K('experience', C1), K('module_intro', M1)]) {
      eq(RC.regenerationCascade(3, m0.items, it(k)), { regenerate: [], stale: [] }, `v3 ${k} sin cascada`);
    }
  });

  await check('fix round 1 M1/M7: apply lista los items de Gamma/TTS a generar (providerItemsToGenerate); vacío en v1/v2', () => {
    const s = baseSpec(); s.modules[1].chapters.push({ id: C7, title: 'Capítulo siete', objective: 'O7', video: false, act: false });
    const { plan, mB } = planOf(bp0, buildBp(s));
    eq(applyOf(plan, mB, bp0).providerItemsToGenerate, [K('presentation', C7), K('audiobook_chapter', C7)], 'capítulo nuevo');
    const same = planOf(bp0, buildBp(baseSpec()));
    eq(applyOf(same.plan, same.mB, bp0).providerItemsToGenerate, [], 'sin cambios');
  });
}

// Sha fijado del plan "título de C1 editado" (fixture de arriba). Cambia solo
// si cambian las huellas v3, las reglas o la forma del plan: en ese caso,
// revisar el diff y actualizar a propósito.
const PINNED_PLAN_SHA = '4b299d6f5384576a6ebacd81bb2264064d566fa6ae95e5edbaddb8b1d3c0acd9';

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
  const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
  const { InvalidationService } = loadDist('modules/invalidation/invalidation.service.js');
  const { CoherenceService } = loadDist('modules/coherence/coherence.service.js');
  const { canonicalContextHash, itemIdempotencyKey } = loadDist('modules/dynamic-generation/run-hash.js');

  const pgBin = findPgBin();
  const port = await freePort();
  assert(port !== 5570, 'puerto 5570 prohibido');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-r5-pg16-'));
  const ROLE = 'postgres.r5localtest01';
  const DB = 'r5db';
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
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-r5-cwd-'));
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    // Esquema de staging con R3 + R4: baseline legacy + Fase 1..5 + v2 + invalidación + R3 + R4.
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
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out}`);
    }

    // ── Servicios compilados contra la DB real ──────────────────────────
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    // V2.1 F2: el preflight de startRun exige claves/themeIds para Gamma/TTS reales (valores FALSOS, 0 red).
    require('./lib/provider-test-env').applyFakeProviderEnv();
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube'; // V2.1 F2: v3 con videos exige YouTube (también en mock)
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [], synchronize: false });
    await ds.initialize();
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    // V2.1 RF-b (fix round 2): los gates de presupuesto fallan cerrados sin FinopsBudgetService;
    // este check prueba invalidación/providerModes → presupuesto falso permisivo (siempre AUTO).
    const { permissiveFinopsBudget } = require(path.join(REPO, 'scripts/lib/finops-test-fakes.js'));
    const runs = new RunsService(ds, manifests, { async getActiveRate() { return null; } }, undefined, permissiveFinopsBudget(loadDist('modules/finops/index.js')));
    const invalidation = new InvalidationService(ds, manifests);
    const texts = new Map(); // artifactId → contenido (descarga vía data: URL)
    const artifactsStub = {
      async getDownloadUrl(id) {
        const t = texts.get(id);
        return { url: t === undefined ? null : `data:application/json;base64,${Buffer.from(t).toString('base64')}`, method: 'stub' };
      },
      async putStorageObject({ buffer }) { return { sizeBytes: buffer.length, adopted: false }; },
    };
    const coherence = new CoherenceService(ds, blueprints, manifests, artifactsStub);

    // ── Fixtures DB: un curso = filas vivas + Blueprints v2 congelados (ids por prefijo) ──
    const ctx = { courseName: 'Curso R5', sector: 'Tecnología', pais: 'Chile' };
    const makeCourse = async (pfx, title) => {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cidX = course.id;
      const dmX = (n) => `00000000-0000-4000-8000-000000${pfx}05a${n}`;
      const dcX = (n) => `00000000-0000-4000-8000-000000${pfx}05c${n}`;
      const spec = { finalExam: true, activityEngine: 'h5p', title, chapters: [
        { id: dcX(1), m: dmX(1), pos: 0, title: 'C1', video: true, act: true },
        { id: dcX(2), m: dmX(1), pos: 1, title: 'C2', video: false, act: true },
        { id: dcX(3), m: dmX(2), pos: 0, title: 'C3', video: true, act: false },
      ] };
      const modsX = [{ id: dmX(1), position: 0, title: 'M1', objective: null, exam_enabled: true }, { id: dmX(2), position: 1, title: 'M2', objective: null, exam_enabled: false }];
      for (const m of modsX) await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cidX, m.position, m.title]);
      for (const c of spec.chapters) {
        await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`,
          [c.id, cidX, c.m, c.pos, c.title, c.video, c.act]);
      }
      const bpOfX = (sp) => snap.buildBlueprintSnapshotV2({ id: cidX, title: sp.title, finalExam: sp.finalExam, activityEngine: sp.activityEngine }, modsX,
        sp.chapters.map((c) => ({ id: c.id, module_id: c.m, position: c.pos, title: c.title, objective: null, video_enabled: c.video, activity_enabled: c.act })));
      const insertBpX = async (n, sp) => {
        const b = bpOfX(sp);
        await ds.query(
          `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
           values ($1, $2, 2, $3::jsonb, $4, 0, $5, $6)`,
          [cidX, n, snap.canonicalJsonV2(b), snap.snapshotSha256V2(b), b.modules.length, b.modules.reduce((x, m) => x + m.chapters.length, 0)]);
        return b;
      };
      return { cid: cidX, dm: dmX, dc: dcX, spec, bpOf: bpOfX, insertBp: insertBpX };
    };
    /**
     * Run v3 completado, sembrado como lo deja un run real: item runs
     * completed + un artifact por rol; las interacciones registran la
     * identidad del video contra el que se generaron (fix round 1, I3).
     */
    const seedCompletedRun = async (cidX, m, bpNumber, spec, extraPayload = {}) => {
      const [job] = await ds.query(
        `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, progress, input_payload, output_summary, options, result)
         values ($1, $2, 'dynamic_generation', 'completed', 'completed', 'dynamic_generation', 100, $3::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) returning id`,
        [OWNER, cidX, JSON.stringify({ manifestId: m.id, blueprintNumber: bpNumber, contextHash: canonicalContextHash(ctx), videoMode: 'mock',
          // V2.1 F2: un run v3 con videos se congela con entrega YouTube (preflight v3_requires_youtube_delivery).
          videoDelivery: 'youtube',
          providerModes: { presentation: 'real', audio: 'real' }, ...extraPayload })]);
      await ds.query(`insert into public.generation_run_contexts (job_id, manifest_id, context, context_hash) values ($1, $2, $3::jsonb, $4)`,
        [job.id, m.id, JSON.stringify(ctx), canonicalContextHash(ctx)]);
      const videoOf = new Map();
      for (const it of m.manifest.items) {
        const summary = {};
        if (it.type === 'video_interactions') summary.videoIdentity = videoOf.get(it.chapterId);
        const [ir] = await ds.query(
          `insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key, status, finished_at, output_summary)
           values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9::text[], $10, 'completed', now(), $11::jsonb) returning id`,
          [job.id, cidX, m.blueprintId, m.id, it.key, it.type, it.moduleId, it.chapterId, it.dependsOn, itemIdempotencyKey(m.id, it.key, 1), JSON.stringify(summary)]);
        const arts = [];
        for (const role of R.requiredArtifactTypesV3(it.type, it.variant)) {
          const path1 = `r5/${job.id}/${it.key}/${role}`;
          const [a] = await ds.query(
            `insert into public.artifacts (owner_id, course_id, job_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, metadata, module_id, chapter_id, manifest_id, manifest_item_key, item_run_id)
             values ($1, $2, $3, $4, 'supabase', 'cursia-artifacts', $5, 'f', 'application/json', '{}'::jsonb, $6, $7, $8, $9, $10) returning id`,
            [OWNER, String(cidX), job.id, role, path1, it.moduleId, it.chapterId, m.id, it.key, ir.id]);
          arts.push({ id: a.id, type: role, bucket: 'cursia-artifacts', path: path1 });
          if (role === 'dynamic_course_plan_json') {
            texts.set(a.id, JSON.stringify({ chapters: Object.fromEntries(spec.chapters.map((c) => [c.id, { summary: c.title, concepts_introduced: [c.title] }])) }));
          }
        }
        if (it.type === 'video') videoOf.set(it.chapterId, { identity: A.artifactOutputIdentity(arts), itemRunId: ir.id, generation: 1, artifactIds: arts.map((x) => x.id) });
      }
      return job;
    };

    const K1 = await makeCourse('01', 'Curso R5');
    const cid = K1.cid;
    const dm = K1.dm;
    const dc = K1.dc;
    const spec1 = K1.spec;
    const bp1 = await K1.insertBp(1, spec1);
    // Blueprint 2: título de C1 editado + actividad de C2 apagada.
    const spec2 = clone(spec1); spec2.chapters[0].title = 'C1 revisado'; spec2.chapters[1].act = false;
    const bp2 = await K1.insertBp(2, spec2);
    const mA = (await manifests.getOrCreate(cid, OWNER, 1)).manifest;
    const mB = (await manifests.getOrCreate(cid, OWNER, 2)).manifest;
    const jobA = await seedCompletedRun(cid, mA, 1, spec1);

    let planResp = null;
    await check('DB InvalidationService.getPlan v3 → v3: plan real (acciones por key), sin blockers, sin 501', async () => {
      planResp = await invalidation.getPlan(cid, OWNER, 2, jobA.id);
      eq([planResp.applied, planResp.toRulesVersion, planResp.blockers, planResp.videoItemsToGenerate, planResp.providerItemsToGenerate], [false, 3, [], [], []], 'respuesta');
      const m = byKey(planResp.plan);
      const want = {
        [K('content', dc(1))]: 'REGENERATE', [K('experience', dc(1))]: 'REGENERATE', [K('presentation', dc(1))]: 'STALE_NO_AUTO',
        [K('video', dc(1))]: 'STALE_NO_AUTO', [K('video_interactions', dc(1))]: 'STALE_NO_AUTO', [K('activity', dc(1))]: 'REGENERATE',
        [K('audiobook_chapter', dc(1))]: 'STALE_NO_AUTO', [K('activity', dc(2))]: 'SOFT_DISABLE', [K('exam', dm(1))]: 'REGENERATE',
        [K('module_intro', dm(1))]: 'REGENERATE', [`course_plan:${cid}`]: 'REGENERATE', [`course_intro:${cid}`]: 'REGENERATE',
        [`audio_welcome:${cid}`]: 'STALE_NO_AUTO', [`final_exam:${cid}`]: 'REGENERATE',
      };
      expectPlan(planResp.plan, want);
      assert(m[K('video_interactions', dc(1))].fromMatchFingerprint, 'huella de A de video_interactions (identidad por storage_path)');
    });

    let jobB = null;
    await check('DB RunsService.startRun({fromRun}) v3 → v3: run B sembrado en una tx; A stale/disabled con huella; carried stale para los items pagos', async () => {
      const res = await runs.startRun(cid, OWNER, 2, { fromRun: jobA.id });
      eq([res.created, res.invalidation && res.invalidation.planSha256], [true, planResp.plan.planSha256], 'creado con el mismo plan');
      jobB = res.run.id;
      const rowsB = await ds.query(`select item_key, status, carried_from_item_run_id from public.generation_item_runs where job_id = $1`, [jobB]);
      eq(rowsB.length, mB.totals.totalJobs, 'items de B = totalJobs');
      const st = Object.fromEntries(rowsB.map((x) => [x.item_key, x.status]));
      for (const k of [K('presentation', dc(1)), K('video', dc(1)), K('audiobook_chapter', dc(1)), `audio_welcome:${cid}`, K('experience', dc(2))]) eq(st[k], 'completed', k);
      for (const k of [K('content', dc(1)), K('activity', dc(1)), `final_exam:${cid}`]) eq(st[k], 'pending', k);
      const artsA = await ds.query(
        `select a.manifest_item_key k, a.status, a.metadata, a.storage_path from public.artifacts a where a.job_id = $1`, [jobA.id]);
      const aOf = (k) => artsA.filter((x) => x.k === k);
      assert(aOf(K('presentation', dc(1))).every((x) => x.status === 'stale'), 'presentation de A stale');
      const dis = aOf(K('activity', dc(2)));
      assert(dis.length && dis.every((x) => x.status === 'disabled' && x.metadata.inputFingerprint), 'activity:C2 de A disabled con huella');
      assert(aOf(K('experience', dc(2))).every((x) => x.status == null || x.status === 'ready'), 'reusados de A siguen ready (null = ready)');
      const carried = await ds.query(`select manifest_item_key k, status, storage_path, metadata from public.artifacts where job_id = $1`, [jobB]);
      const pres = carried.filter((x) => x.k === K('presentation', dc(1)));
      assert(pres.length === 1 && pres[0].status === 'stale' && pres[0].storage_path === aOf(K('presentation', dc(1)))[0].storage_path, 'presentation carried stale, misma ruta');
      const vi = carried.find((x) => x.k === K('video_interactions', dc(1)));
      eq(vi.metadata.inputFingerprint, byKey(planResp.plan)[K('video_interactions', dc(1))].fromMatchFingerprint, 'huella del vi carried = la de A');
      const again = await runs.startRun(cid, OWNER, 2, { fromRun: jobA.id });
      eq([again.created], [false], 'idempotente');
      const [jb] = await ds.query(`select input_payload from public.production_jobs where id = $1`, [jobB]);
      eq({ presentation: jb.input_payload.providerModes.presentation, audio: jb.input_payload.providerModes.audio }, { presentation: 'real', audio: 'real' }, 'B hereda providerModes de A (fix round 1, I1)');
    });

    await check('DB coherencia de un run v3 completado (antes 501): reporte coherence-rules-v3@1 persistido, idempotente', async () => {
      const r1 = await coherence.computeRunReport(cid, OWNER, 1, jobA.id);
      eq([r1.created, r1.report.ruleset, r1.report.inputs.blueprintSha256], [true, 'coherence-rules-v3@1', snap.snapshotSha256V2(bp1)], 'reporte');
      assert(r1.report.inputs.coursePlanSha256, 'course_plan leído (v3 lo exige como v2)');
      const r2 = await coherence.computeRunReport(cid, OWNER, 1, jobA.id);
      eq([r2.created, r2.artifactId], [false, r1.artifactId], 'idempotente');
      const st = await coherence.structure(cid, OWNER, { blueprintNumber: 2 });
      eq([st.ruleset, st.blueprintSha256], ['coherence-rules-v3@1', snap.snapshotSha256V2(bp2)], 'estructural sobre Blueprint v2');
    });

    await check('DB auditorías de staging con datos v3: audit-generation-manifests y audit-dynamic-generation verdes; un rol v3 faltante las hace fallar', async () => {
      const env = localEnv({ MIGRATION_ENV: 'staging' });
      const g = runScript('scripts/audit-generation-manifests.js', env);
      assert(g.code === 0 && /\(k\) rulesVersion 3.*\(2 Manifests v3 revisados\)/.test(g.out), `audit-generation-manifests: exit ${g.code}\n${g.out.slice(-2000)}`);
      const d = runScript('scripts/audit-dynamic-generation.js', env);
      const nDone = (await ds.query(`select count(*)::int n from public.generation_item_runs g join public.course_generation_manifests m on m.id = g.manifest_id and m.rules_version = 3 where g.status = 'completed'`))[0].n;
      assert(d.code === 0 && new RegExp(`\\(h3\\) rulesVersion 3.*\\(${nDone} revisados\\)`).test(d.out), `audit-dynamic-generation: exit ${d.code}\n${d.out.slice(-2000)}`);
      // Un item v3 completado sin su artifact ⇒ la auditoría falla fuerte.
      const [victim] = await ds.query(`select a.id from public.artifacts a where a.job_id = $1 and a.type = 'dynamic_experience_json' limit 1`, [jobA.id]);
      await ds.query(`update public.artifacts set item_run_id = null where id = $1`, [victim.id]);
      try {
        const bad = runScript('scripts/audit-dynamic-generation.js', env);
        assert(bad.code !== 0 && /dynamic_experience_json, encontrados 0/.test(bad.out), `debió fallar: exit ${bad.code}\n${bad.out.slice(-1500)}`);
      } finally {
        await ds.query(`update public.artifacts a set item_run_id = g.id from public.generation_item_runs g
                         where a.id = $1 and g.job_id = $2 and g.item_key = a.manifest_item_key`, [victim.id, jobA.id]);
      }
    });

    // ── Fix round 1 ────────────────────────────────────────────────────────
    await check('DB fix round 1 I1: startRun v3 congela providerModes explícitos (default real); mock exige DYNAMIC_ALLOW_PROVIDER_MOCK; sin worker → 501; otro modo → 409', async () => {
      const saved = { w: process.env.DYNAMIC_PROVIDER_WORKER_ENABLED, m: process.env.DYNAMIC_ALLOW_PROVIDER_MOCK };
      const body = { nombre: 'Curso R5 b', sector: 'Tecnología', pais: 'Chile', contexto: 'Empresa', nivel: 'Básico', tono: 'formal' };
      try {
        delete process.env.DYNAMIC_PROVIDER_WORKER_ENABLED;
        delete process.env.DYNAMIC_ALLOW_PROVIDER_MOCK;
        const K2 = await makeCourse('02', 'Curso R5 b');
        await K2.insertBp(1, K2.spec);
        await manifests.getOrCreate(K2.cid, OWNER, 1);
        await rejectsRe(runs.startRun(K2.cid, OWNER, 1, body), /PROVIDER_WORKER_NOT_DEPLOYED/, 'sin worker de proveedor', 501);
        process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
        await rejectsRe(runs.startRun(K2.cid, OWNER, 1, { ...body, providerModes: { presentation: 'mock' } }), /provider_mock_not_allowed/, 'mock sin escape', 403);
        const res = await runs.startRun(K2.cid, OWNER, 1, { ...body, videoMode: 'mock' });
        eq(res.created, true, 'creado');
        const [row] = await ds.query(`select input_payload from public.production_jobs where id = $1`, [res.run.id]);
        eq([row.input_payload.videoMode, row.input_payload.providerModes.presentation, row.input_payload.providerModes.audio], ['mock', 'real', 'real'], 'videoMode mock NO arrastra a los proveedores');
        process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = 'true';
        await rejectsRe(runs.startRun(K2.cid, OWNER, 1, { ...body, videoMode: 'mock', providerModes: { audio: 'mock' } }), /provider_modes_conflict|otros modos de proveedor/, 'modos distintos', 409);
        eq((await runs.startRun(K2.cid, OWNER, 1, { ...body, videoMode: 'mock' })).created, false, 'mismo pedido → idempotente');
        // v1/v2: providerModes no aplica (400) y el input_payload no cambia.
        const P2 = loadDist('modules/dynamic-generation/provider-modes.js');
        throwsRe(() => P2.resolveProviderModes(2, { audio: 'mock' }, {}), /provider_mode_invalid/, 'v2 con providerModes');
        eq(P2.resolveProviderModes(2, undefined, {}), undefined, 'v2 sin providerModes');
      } finally {
        for (const [k, v] of [['DYNAMIC_PROVIDER_WORKER_ENABLED', saved.w], ['DYNAMIC_ALLOW_PROVIDER_MOCK', saved.m]]) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
    });

    await check('DB fix round 1 I2: regenerateItem v3 de content → LLM REGENERATE (pending) + proveedores/video_interactions STALE con aviso; dryRun lista la cascada completa; video → interacciones', async () => {
      const K3 = await makeCourse('03', 'Curso R5 c');
      await K3.insertBp(1, K3.spec);
      const m3 = (await manifests.getOrCreate(K3.cid, OWNER, 1)).manifest;
      const job3 = await seedCompletedRun(K3.cid, m3, 1, K3.spec);
      const ch = K3.dc(1);
      const want = [
        [`content:${ch}`, 'REGENERATE'], [`experience:${ch}`, 'REGENERATE'], [`activity:${ch}`, 'REGENERATE'],
        [`exam:${K3.dm(1)}`, 'REGENERATE'], [`final_exam:${K3.cid}`, 'REGENERATE'],
        [`presentation:${ch}`, 'STALE_NO_AUTO'], [`video:${ch}`, 'STALE_NO_AUTO'], [`video_interactions:${ch}`, 'STALE_NO_AUTO'],
        [`audiobook_chapter:${ch}`, 'STALE_NO_AUTO'],
      ];
      const dry = await runs.regenerateItem(K3.cid, OWNER, 1, job3.id, `content:${ch}`, { dryRun: true });
      eq(dry.affected.map((x) => [x.itemKey, x.action]), want, 'dryRun: cascada completa');
      eq(dry.blockers, [], 'sin trabas');
      await rejectsRe(runs.regenerateItem(K3.cid, OWNER, 1, job3.id, `content:${ch}`, {}), /confirm_paid_required/, 'sin confirmPaid', 400);
      const res = await runs.regenerateItem(K3.cid, OWNER, 1, job3.id, `content:${ch}`, { confirmPaid: true });
      eq(res.affected.map((x) => [x.itemKey, x.action]), want, 'real = dryRun');
      const rows = await ds.query(
        `select g.item_key, g.generation, g.status from public.generation_item_runs g where g.job_id = $1 order by g.item_key, g.generation`, [job3.id]);
      const latest = new Map();
      for (const r of rows) latest.set(r.item_key, r);
      for (const [k, a] of want) {
        const r = latest.get(k);
        if (a === 'REGENERATE') eq([r.generation, r.status], [2, 'pending'], `${k}: generación nueva pending`);
        else eq([r.generation, r.status], [1, 'completed'], `${k}: sin regenerar`);
      }
      const stale = await ds.query(
        `select a.manifest_item_key k, a.status, a.metadata->>'staleReason' reason from public.artifacts a
          join public.generation_item_runs g on g.id = a.item_run_id where g.job_id = $1 and g.generation = 1`, [job3.id]);
      for (const k of [`presentation:${ch}`, `video:${ch}`, `video_interactions:${ch}`, `audiobook_chapter:${ch}`]) {
        const xs = stale.filter((x) => x.k === k);
        assert(xs.length && xs.every((x) => x.status === 'stale' && x.reason === 'content_regenerated'), `${k}: artifacts stale con motivo (${JSON.stringify(xs)})`);
      }
      const W = loadDist('modules/dynamic-packaging/packaging-warnings.js');
      assert(typeof W.staleArtifactWarnings === 'function', 'aviso de empaque disponible');
      // Video (mock, gratis) → regenera sus interacciones (LLM) ⇒ confirmPaid también.
      const K4 = await makeCourse('04', 'Curso R5 d');
      await K4.insertBp(1, K4.spec);
      const m4 = (await manifests.getOrCreate(K4.cid, OWNER, 1)).manifest;
      const job4 = await seedCompletedRun(K4.cid, m4, 1, K4.spec);
      const vdry = await runs.regenerateItem(K4.cid, OWNER, 1, job4.id, `video:${K4.dc(1)}`, { dryRun: true });
      eq(vdry.affected.map((x) => [x.itemKey, x.action]), [[`video:${K4.dc(1)}`, 'REGENERATE'], [`video_interactions:${K4.dc(1)}`, 'REGENERATE']], 'video → interacciones');
      await rejectsRe(runs.regenerateItem(K4.cid, OWNER, 1, job4.id, `video:${K4.dc(1)}`, {}), /confirm_paid_required.*video_interactions/, 'cascada paga', 400);
    });

    await check('DB fix round 1 I3: completar video_interactions registra la identidad del video vigente (output_summary.videoIdentity); sin video completado → 409', async () => {
      const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
      const sched = new SchedulerService(ds, { async tx() {}, async reconcileCancellation() {} });
      const [vi] = await ds.query(`select * from public.generation_item_runs where job_id = $1 and type = 'video_interactions' limit 1`, [jobA.id]);
      const got = await sched['consumedVideoIdentity'](ds, jobA.id, vi);
      eq(got.identity, vi.output_summary.videoIdentity.identity, 'identidad = la del video vigente (storage paths)');
      const [vrow] = await ds.query(`select id from public.generation_item_runs where job_id = $1 and item_key = $2`, [jobA.id, `video:${vi.chapter_id}`]);
      eq(got.itemRunId, vrow.id, 'item run del video');
      await ds.query('begin');
      try {
        await ds.query(`update public.generation_item_runs set status = 'failed' where id = $1`, [vrow.id]);
        await rejectsRe(sched['consumedVideoIdentity'](ds, jobA.id, vi), /video_not_completed/, 'video no completado', 409);
      } finally { await ds.query('rollback'); }
    });

    await check('DB fix round 1 I5: sin las columnas de R3 las rutas de estructura responden 503 schema_not_migrated_v21 (nunca 500 crudo)', async () => {
      const G = loadDist('modules/course-structure/v21-schema-guard.js');
      G._resetV21SchemaGuardForTests();
      await withClient(DB, async (c) => {
        await c.query('begin');
        try {
          await c.query(`alter table public.courses rename column activity_engine to activity_engine_x`);
          const err = await rejectsRe(G.assertV21StructureSchema(c), /schema_not_migrated_v21/, 'guarda', 503);
          eq(err.getResponse().missing, ['courses.activity_engine'], 'columnas faltantes');
        } finally { await c.query('rollback'); }
      });
      await G.assertV21StructureSchema(ds); // migrada → pasa (y queda cacheado)
    });

    await check('DB fix round 1 M11: la auditoría falla con un artifact simulado en un run no congelado como mock', async () => {
      const env = localEnv({ MIGRATION_ENV: 'staging' });
      const [victim] = await ds.query(`select a.id from public.artifacts a where a.job_id = $1 and a.type = 'dynamic_presentation' limit 1`, [jobA.id]);
      await ds.query(`update public.artifacts set metadata = metadata || '{"mock": true}'::jsonb where id = $1`, [victim.id]);
      try {
        const bad = runScript('scripts/audit-dynamic-generation.js', env);
        assert(bad.code !== 0 && /artifact simulado dynamic_presentation/.test(bad.out), `debió fallar: exit ${bad.code}\n${bad.out.slice(-1500)}`);
      } finally {
        await ds.query(`update public.artifacts set metadata = metadata - 'mock' where id = $1`, [victim.id]);
      }
      eq(runScript('scripts/audit-dynamic-generation.js', env).code, 0, 'vuelve a verde');
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
