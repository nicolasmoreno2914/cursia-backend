#!/usr/bin/env node
/* eslint-disable */
// Fase 8 (F8-BE) — reglas PURAS del apply y del packaging (sin DB ni red):
//  - planApplyWrites: plan de invalidación → seeds de item runs de B, filas de
//    artifact "carried" (misma ruta inmutable) y cambios de status de A,
//    todo por UUID; STALE_NO_AUTO nunca genera un video; roles faltantes al
//    cruzar rulesVersion 1 → 2 quedan como bloqueo (409 en el apply).
//  - aggregateArtifactStatus: estado agregado de los artifacts de un item.
//  - staleArtifactWarnings: el packaging avisa de los artifacts 'stale'.
//  - isFromRunRequest: el body {fromRun} se distingue del contexto de curso.
//
// Carga los módulos COMPILADOS de dist/.
//   node scripts/check-invalidation-apply.js [path/to/dist]

const path = require('path');

const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
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

const { buildBlueprintSnapshot, snapshotSha256 } = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const { buildGenerationManifest } = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const { computeInvalidationPlan } = loadDist('modules/invalidation/plan.js');
const { computeFingerprints, matchFingerprint } = loadDist('modules/invalidation/fingerprints.js');
const { planApplyWrites, aggregateArtifactStatus } = loadDist('modules/invalidation/invalidation-apply.js');
const { staleArtifactWarnings } = loadDist('modules/dynamic-packaging/packaging-warnings.js');
const { requiredArtifactTypes } = loadDist('modules/dynamic-packaging/artifact-resolver.js');
const { isFromRunRequest } = loadDist('modules/invalidation/dto/from-run.dto.js');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`❌ ${name}\n   ${err && err.message ? err.message : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg}: esperado ${y}, encontrado ${x}`);
}
const clone = (x) => JSON.parse(JSON.stringify(x));

const COURSE_ID = 9009;
const M1 = 'b9000000-0000-4000-8000-000000000001';
const M2 = 'b9000000-0000-4000-8000-000000000002';
const ch = (n) => `c9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [C1, C2, C3, C4, C5] = [1, 2, 3, 4, 5].map(ch);
const CTX = 'd'.repeat(64);

function baseSpec() {
  return [
    { id: M1, title: 'Fundamentos', objective: 'Comprender', exam: true, chapters: [
      { id: C1, title: 'Uno', objective: 'Obj uno', video: true },
      { id: C2, title: 'Dos', objective: 'Obj dos' },
    ] },
    { id: M2, title: 'Aplicaciones', objective: 'Aplicar', exam: true, chapters: [
      { id: C3, title: 'Tres', objective: 'Obj tres', video: true },
      { id: C4, title: 'Cuatro', objective: 'Obj cuatro' },
    ] },
  ];
}
function buildBp(spec) {
  const modules = spec.map((m, i) => ({ id: m.id, position: i, title: m.title, objective: m.objective, exam_enabled: !!m.exam }));
  const chapters = [];
  spec.forEach((m) => m.chapters.forEach((c, j) => chapters.push({
    id: c.id, module_id: m.id, position: j, title: c.title, objective: c.objective, video_enabled: !!c.video,
  })));
  return buildBlueprintSnapshot({ id: COURSE_ID, title: 'Curso apply fixture' }, modules, chapters);
}
function manifest(bp, n, rulesVersion = 1) {
  return buildGenerationManifest(bp, { courseId: COURSE_ID, blueprintId: n, blueprintNumber: n, blueprintSha256: snapshotSha256(bp) }, { rulesVersion });
}
/** Artifacts de A por item (tipos reales por rulesVersion), todos ready. */
function runA(m, rulesVersion = 1) {
  const arts = new Map();
  const items = m.items.map((it) => {
    const types = requiredArtifactTypes(rulesVersion, it.type) || ['x'];
    const ids = types.map((t) => `art-${t}-${it.key}`);
    ids.forEach((id, i) => arts.set(id, { id, type: types[i], status: 'ready', metadata: {} }));
    return { itemKey: it.key, itemRunId: `ir-${it.key}`, status: 'completed', artifactIds: ids, artifactStatus: 'ready' };
  });
  return { items, arts };
}
function scenario(fromSpec, toSpec, { rvFrom = 1, rvTo = 1, mutate } = {}) {
  const fbp = buildBp(fromSpec);
  const tbp = buildBp(toSpec);
  const fm = manifest(fbp, 1, rvFrom);
  const tm = manifest(tbp, 2, rvTo);
  const A = runA(fm, rvFrom);
  if (mutate) mutate(A);
  const plan = computeInvalidationPlan({
    from: { blueprint: fbp, manifest: fm, items: A.items, courseContextSha256: CTX },
    to: { blueprint: tbp, manifest: tm, courseContextSha256: CTX },
  });
  const writes = planApplyWrites(
    plan,
    tm.items,
    fbp,
    CTX,
    (id) => A.arts.get(id)?.status ?? null,
    (id) => A.arts.get(id)?.metadata?.inputFingerprint ?? null,
    { required: (t) => requiredArtifactTypes(rvTo, t), typeOf: (id) => A.arts.get(id)?.type },
  );
  return { fbp, tbp, fm, tm, A, plan, writes };
}
const seed = (w, key) => w.seeds.find((s) => s.itemKey === key);

check('sin cambios: todo seed completed con carried_from = item run de A y una fila carried por artifact de A', () => {
  const r = scenario(baseSpec(), baseSpec());
  eq(r.writes.seeds.map((s) => s.itemKey), r.tm.items.map((i) => i.key), 'seeds en orden del Manifest destino');
  for (const s of r.writes.seeds) {
    eq([s.status, s.carriedFromItemRunId, s.action], ['completed', `ir-${s.itemKey}`, 'REUSE'], s.itemKey);
  }
  const carriedIds = r.writes.carried.map((c) => c.sourceArtifactId).sort();
  eq(carriedIds, [...r.A.arts.keys()].sort(), 'cada artifact de A se arrastra exactamente una vez');
  assert(r.writes.carried.every((c) => c.status === 'ready'), 'filas carried ready');
  eq(r.writes.statusChanges, [], 'A no cambia');
  eq(r.writes.missingRoles, [], 'sin roles faltantes');
});

check('editar título de C1: content/scorm pending (REGENERATE), video STALE_NO_AUTO carried stale, exam M1 pending; A stale solo en esos', () => {
  const to = baseSpec();
  to[0].chapters[0].title = 'Uno reescrito';
  const r = scenario(baseSpec(), to);
  eq([seed(r.writes, `content:${C1}`).status, seed(r.writes, `content:${C1}`).action], ['pending', 'REGENERATE'], 'content C1');
  eq([seed(r.writes, `scorm:${C1}`).status, seed(r.writes, `scorm:${C1}`).action], ['pending', 'REGENERATE'], 'scorm C1');
  eq([seed(r.writes, `video:${C1}`).status, seed(r.writes, `video:${C1}`).action], ['completed', 'STALE_NO_AUTO'], 'video C1');
  eq([seed(r.writes, `exam:${M1}`).status, seed(r.writes, `exam:${M1}`).action], ['pending', 'REGENERATE'], 'exam M1');
  const v = r.writes.carried.filter((c) => c.itemKey === `video:${C1}`);
  eq(v.map((c) => c.status), ['stale'], 'fila carried del video = stale');
  // El video sigue válido para la huella del Blueprint de A, nunca la del destino.
  const fpA = matchFingerprint(computeFingerprints(r.fbp, { courseContextSha256: CTX }), `video:${C1}`);
  const fpB = matchFingerprint(computeFingerprints(r.tbp, { courseContextSha256: CTX }), `video:${C1}`);
  assert(fpA !== fpB && v[0].inputFingerprint === fpA, 'inputFingerprint del video = huella de A');
  eq(r.writes.statusChanges.map((c) => `${c.itemKey}:${c.status}`).sort(),
    [`content:${C1}:stale`, `exam:${M1}:stale`, `scorm:${C1}:stale`, `video:${C1}:stale`].sort(), 'A: stale solo en los 4 items afectados');
  eq(r.writes.videoItemsToGenerate, [], 'ningún video a generar (STALE_NO_AUTO no paga)');
  assert(!r.writes.carried.some((c) => c.itemKey === `content:${C1}` || c.itemKey === `exam:${M1}`), 'lo que se regenera no se arrastra');
});

check('eliminar C4: sus items SOFT_DISABLE (disabled en A con huella de A), exam M2 pending', () => {
  const to = baseSpec();
  to[1].chapters = to[1].chapters.filter((c) => c.id !== C4);
  const r = scenario(baseSpec(), to);
  assert(!r.writes.seeds.some((s) => s.itemKey.endsWith(C4)), 'B no siembra items de C4');
  const dis = r.writes.statusChanges.filter((c) => c.status === 'disabled');
  eq(dis.map((c) => c.itemKey).sort(), [`content:${C4}`, `scorm:${C4}`].sort(), 'disabled por UUID');
  const fpA = matchFingerprint(computeFingerprints(r.fbp, { courseContextSha256: CTX }), `content:${C4}`);
  assert(dis.every((c) => c.inputFingerprint === fpA && c.reasons.includes('chapter_deleted')), 'huella de A + motivo chapter_deleted');
  eq(seed(r.writes, `exam:${M2}`).status, 'pending', 'exam M2');
});

check('video ON→OFF→ON: la huella guardada al deshabilitar permite reusar (REUSE) y no generar', () => {
  const off = baseSpec();
  off[0].chapters[0].video = false;
  const r1 = scenario(baseSpec(), off);
  const d = r1.writes.statusChanges.find((c) => c.itemKey === `video:${C1}`);
  assert(d && d.status === 'disabled', 'video deshabilitado');
  // Run A' (video OFF) + registro del linaje: el video deshabilitado con su huella.
  const fbp = buildBp(off);
  const fm = manifest(fbp, 2);
  const A2 = runA(fm);
  const tbp = buildBp(baseSpec());
  const tm = manifest(tbp, 3);
  const vid = `art-dynamic_video-video:${C1}`;
  A2.arts.set(vid, { id: vid, type: 'dynamic_video', status: 'disabled', metadata: { inputFingerprint: d.inputFingerprint } });
  A2.items.push({ itemKey: `video:${C1}`, itemRunId: `ir-old-video`, status: 'completed', artifactIds: [vid], artifactStatus: 'disabled', inputFingerprint: d.inputFingerprint });
  const plan = computeInvalidationPlan({ from: { blueprint: fbp, manifest: fm, items: A2.items, courseContextSha256: CTX }, to: { blueprint: tbp, manifest: tm, courseContextSha256: CTX } });
  const w = planApplyWrites(plan, tm.items, fbp, CTX, (id) => A2.arts.get(id)?.status ?? null, (id) => A2.arts.get(id)?.metadata?.inputFingerprint ?? null);
  eq([seed(w, `video:${C1}`).action, seed(w, `video:${C1}`).status, seed(w, `video:${C1}`).carriedFromItemRunId], ['REUSE', 'completed', 'ir-old-video'], 'video reusado del linaje');
  eq(w.carried.filter((c) => c.itemKey === `video:${C1}`).map((c) => [c.sourceArtifactId, c.status]), [[vid, 'ready']], 'fila carried ready');
  eq(w.videoItemsToGenerate, [], 'no se paga un video');
});

check('video OFF→ON sin artifact previo: GENERATE → pending y listado en videoItemsToGenerate (gate de video real)', () => {
  const from = baseSpec();
  from[1].chapters[1].video = false;
  const to = baseSpec();
  to[1].chapters[1].video = true;
  const r = scenario(from, to);
  eq([seed(r.writes, `video:${C4}`).action, seed(r.writes, `video:${C4}`).status], ['GENERATE', 'pending'], 'video C4');
  eq(r.writes.videoItemsToGenerate, [`video:${C4}`], 'videos a generar');
});

check('reordenar dentro de M1: REVIEW → completed con reviewMarks en seed y en las filas carried', () => {
  const to = baseSpec();
  to[0].chapters.reverse();
  const r = scenario(baseSpec(), to);
  for (const c of [C1, C2]) {
    const s = seed(r.writes, `content:${c}`);
    eq([s.action, s.status], ['REVIEW', 'completed'], `content ${c}`);
    eq(s.reviewMarks, ['review:reordered_within_module'], `reviewMarks ${c}`);
    assert(r.writes.carried.filter((x) => x.itemKey === `content:${c}`).every((x) => x.reviewMarks.join() === 'review:reordered_within_module'), 'marcas en carried');
  }
  eq(r.writes.statusChanges, [], 'A intacto');
});

check('v1 → v2: reusar content v1 en un run v2 → missingRoles (content sin dynamic_context_package_json) — el apply da 409', () => {
  const r = scenario(baseSpec(), baseSpec(), { rvFrom: 1, rvTo: 2 });
  const miss = r.writes.missingRoles.filter((m) => m.startsWith('content:'));
  eq(miss.sort(), [C1, C2, C3, C4].map((c) => `content:${c}:dynamic_context_package_json:missing_role`).sort(), 'roles faltantes por UUID');
});

check('v2 → v2 sin cambios: sin roles faltantes (plan, intros, package y sidecars se arrastran)', () => {
  const r = scenario(baseSpec(), baseSpec(), { rvFrom: 2, rvTo: 2 });
  eq(r.writes.missingRoles, [], 'sin faltantes');
  assert(r.writes.carried.some((c) => c.itemKey === `course_plan:${COURSE_ID}`), 'plan arrastrado');
});

check('plan incoherente: REUSE sin artifacts de origen → falla fuerte', () => {
  const r = scenario(baseSpec(), baseSpec());
  const bad = clone(r.plan);
  bad.actions[0].fromArtifactIds = [];
  let err = null;
  try { planApplyWrites(bad, r.tm.items, r.fbp, CTX, () => 'ready', () => null); } catch (e) { err = e; }
  assert(err && /INVALID_INVALIDATION_PLAN/.test(err.message), 'debe lanzar');
  const bad2 = clone(r.plan);
  bad2.actions = bad2.actions.filter((a) => a.itemKey !== `exam:${M1}`);
  err = null;
  try { planApplyWrites(bad2, r.tm.items, r.fbp, CTX, () => 'ready', () => null); } catch (e) { err = e; }
  assert(err && /no tiene acción/.test(err.message), 'item sin acción debe lanzar');
});

check('aggregateArtifactStatus', () => {
  eq([
    aggregateArtifactStatus([]),
    aggregateArtifactStatus(['ready', null]),
    aggregateArtifactStatus(['disabled', 'disabled']),
    aggregateArtifactStatus(['ready', 'stale']),
    aggregateArtifactStatus(['disabled', 'ready']),
  ], [null, 'ready', 'disabled', 'stale', 'mixed'], 'agregados');
});

check('staleArtifactWarnings: solo los stale, orden determinístico, vacío si no hay', () => {
  const byItem = new Map([
    ['video:b', [{ itemKey: 'video:b', artifactId: 'z', type: 'dynamic_video', status: 'stale' }]],
    ['content:a', [{ itemKey: 'content:a', artifactId: 'y', type: 'dynamic_content_md' }]],
    ['video:a', [{ itemKey: 'video:a', artifactId: 'x', type: 'dynamic_video', status: 'stale' }]],
  ]);
  eq(staleArtifactWarnings(byItem).map((w) => [w.code, w.itemKey, w.artifactId]), [['stale_artifact', 'video:a', 'x'], ['stale_artifact', 'video:b', 'z']], 'warnings');
  eq(staleArtifactWarnings(new Map([['content:a', [{ itemKey: 'content:a', artifactId: 'y', type: 'dynamic_content_md' }]]])), [], 'sin stale');
});

check('isFromRunRequest: {fromRun} vs contexto de curso', () => {
  eq([isFromRunRequest({ fromRun: 'x' }), isFromRunRequest({ nombre: 'x' }), isFromRunRequest(null), isFromRunRequest(undefined)], [true, false, false, false], 'detección');
});

if (failures > 0) {
  console.error(`\n❌ ${failures} check(s) fallaron`);
  process.exit(1);
}
console.log('\n✅ check-invalidation-apply: todo OK');
