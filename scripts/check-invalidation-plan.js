#!/usr/bin/env node
/* eslint-disable */
// Fase 8 — plan de invalidación (función pura, por UUID; sin DB ni red).
//
// Un check por fila de la tabla de reglas de la spec (§3), con aserción de la
// acción de CADA item por UUID (no por conteo), más determinismo /
// idempotencia, toggles que reutilizan artifacts deshabilitados, rulesVersion
// 1 y 2, y el criterio de aceptación de la spec general (agregar un capítulo
// no marca capítulos de otros módulos; eliminar uno regenera el examen de su
// módulo).
//
// Carga los módulos COMPILADOS de dist/.
//
// Usage:
//   node scripts/check-invalidation-plan.js
//   node scripts/check-invalidation-plan.js path/to/dist

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

const { buildBlueprintSnapshot, snapshotSha256 } = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const { buildGenerationManifest } = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const { computeInvalidationPlan } = loadDist('modules/invalidation/plan.js');
const { computeFingerprints, matchFingerprint } = loadDist('modules/invalidation/fingerprints.js');

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
function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: esperado ${e}, encontrado ${a}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
// Fixture base: M1 {c1(video), c2, c3} examen ON; M2 {c4(video), c5} examen
// ON; M3 {c6} examen OFF.
// ---------------------------------------------------------------------------
const COURSE_ID = 8008;
const M1 = 'b8000000-0000-4000-8000-000000000001';
const M2 = 'b8000000-0000-4000-8000-000000000002';
const M3 = 'b8000000-0000-4000-8000-000000000003';
const ch = (n) => `c8000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [C1, C2, C3, C4, C5, C6, C7] = [1, 2, 3, 4, 5, 6, 7].map(ch);

function baseSpec() {
  return [
    {
      id: M1,
      title: 'Fundamentos',
      objective: 'Comprender los fundamentos',
      exam: true,
      chapters: [
        { id: C1, title: 'Capítulo uno', objective: 'Objetivo uno', video: true },
        { id: C2, title: 'Capítulo dos', objective: 'Objetivo dos' },
        { id: C3, title: 'Capítulo tres', objective: 'Objetivo tres' },
      ],
    },
    {
      id: M2,
      title: 'Aplicaciones',
      objective: 'Aplicar lo aprendido',
      exam: true,
      chapters: [
        { id: C4, title: 'Capítulo cuatro', objective: 'Objetivo cuatro', video: true },
        { id: C5, title: 'Capítulo cinco', objective: 'Objetivo cinco' },
      ],
    },
    {
      id: M3,
      title: 'Cierre',
      objective: 'Integrar',
      exam: false,
      chapters: [{ id: C6, title: 'Capítulo seis', objective: 'Objetivo seis' }],
    },
  ];
}

function buildBp(spec) {
  const modules = spec.map((m, i) => ({
    id: m.id,
    position: m.position ?? i,
    title: m.title,
    objective: m.objective ?? null,
    exam_enabled: !!m.exam,
  }));
  const chapters = [];
  spec.forEach((m) =>
    m.chapters.forEach((c, j) =>
      chapters.push({
        id: c.id,
        module_id: m.id,
        position: c.position ?? j,
        title: c.title,
        objective: c.objective ?? null,
        video_enabled: !!c.video,
      }),
    ),
  );
  return buildBlueprintSnapshot({ id: COURSE_ID, title: 'Curso invalidación fixture' }, modules, chapters);
}

function manifestV1(bp, n = 1) {
  return buildGenerationManifest(bp, { courseId: COURSE_ID, blueprintId: n, blueprintNumber: n, blueprintSha256: snapshotSha256(bp) });
}

/** Manifest v2 mínimo (el builder v2 vive en otra rama): v1 + course_plan, course_intro y module_intro por módulo. */
function manifestV2(bp, n = 1) {
  const v1 = manifestV1(bp, n);
  const planKey = `course_plan:${COURSE_ID}`;
  const items = [
    { key: planKey, type: 'course_plan', scope: 'course', moduleId: null, chapterId: null, dependsOn: [] },
    { key: `course_intro:${COURSE_ID}`, type: 'course_intro', scope: 'course', moduleId: null, chapterId: null, dependsOn: [planKey] },
  ];
  for (const m of v1.modules) {
    items.push({ key: `module_intro:${m.moduleId}`, type: 'module_intro', scope: 'module', moduleId: m.moduleId, chapterId: null, dependsOn: [planKey] });
  }
  for (const it of v1.items) items.push(it.type === 'content' ? { ...it, dependsOn: [planKey] } : it);
  return { ...v1, rulesVersion: 2, items };
}

/** Run A completo: cada item del manifest con item run completado y artifact ready. */
function completedItems(manifest) {
  return manifest.items.map((it) => ({
    itemKey: it.key,
    itemRunId: `ir-${it.key}`,
    status: 'completed',
    artifactIds: [`art-${it.key}`],
    artifactStatus: 'ready',
  }));
}

function plan(fromSpec, toSpec, { v2From = false, v2To = false, mutateItems } = {}) {
  const fbp = buildBp(fromSpec);
  const tbp = buildBp(toSpec);
  const fm = v2From ? manifestV2(fbp, 1) : manifestV1(fbp, 1);
  const tm = v2To ? manifestV2(tbp, 2) : manifestV1(tbp, 2);
  let items = completedItems(fm);
  if (mutateItems) items = mutateItems(items, { fbp, tbp, fm, tm }) || items;
  const p = computeInvalidationPlan({ from: { blueprint: fbp, manifest: fm, items }, to: { blueprint: tbp, manifest: tm } });
  return { p, fbp, tbp, fm, tm, items };
}

/**
 * Asierta la acción de CADA item del plan. `expected` = mapa key → acción;
 * `defaultAction` cubre los items del manifest destino no listados. Todo
 * item del plan debe estar cubierto y ningún item esperado puede faltar.
 */
function expectActions(res, overrides, defaultAction = 'REUSE') {
  const expected = {};
  for (const it of res.tm.items) expected[it.key] = defaultAction;
  Object.assign(expected, overrides);
  const actual = {};
  for (const a of res.p.actions) {
    if (actual[a.itemKey]) throw new Error(`item repetido en el plan: ${a.itemKey}`);
    actual[a.itemKey] = a.action;
  }
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  const diffs = keys.filter((k) => expected[k] !== actual[k]).map((k) => `${k}: esperado ${expected[k]}, encontrado ${actual[k]}`);
  if (diffs.length) throw new Error(`acciones distintas:\n     ${diffs.join('\n     ')}`);
}
const act = (res, key) => res.p.actions.find((a) => a.itemKey === key);

// ---------------------------------------------------------------------------
check('sin cambios: todo REUSE con fromItemRunId del run A', () => {
  const r = plan(baseSpec(), baseSpec());
  expectActions(r, {});
  for (const a of r.p.actions) {
    assert(a.fromItemRunId === `ir-${a.itemKey}`, `fromItemRunId ${a.itemKey}`);
    assertDeepEqual(a.fromArtifactIds, [`art-${a.itemKey}`], `fromArtifactIds ${a.itemKey}`);
  }
  assertDeepEqual(r.p.totals, { REUSE: r.tm.items.length, GENERATE: 0, REGENERATE: 0, REVIEW: 0, STALE_NO_AUTO: 0, SOFT_DISABLE: 0 }, 'totals');
});

check('agregar capítulo (M2, con video): sus items GENERATE, examen de M2 REGENERATE, resto REUSE (criterio)', () => {
  const to = baseSpec();
  to[1].chapters.push({ id: C7, title: 'Capítulo siete', objective: 'Objetivo siete', video: true });
  const r = plan(baseSpec(), to);
  expectActions(r, {
    [`content:${C7}`]: 'GENERATE',
    [`scorm:${C7}`]: 'GENERATE',
    [`video:${C7}`]: 'GENERATE',
    [`exam:${M2}`]: 'REGENERATE',
  });
  // Criterio: ningún capítulo de otros módulos queda marcado.
  for (const id of [C1, C2, C3, C6]) {
    for (const t of ['content', 'scorm', 'video']) {
      const a = act(r, `${t}:${id}`);
      if (a) assert(a.action === 'REUSE', `${t}:${id} debía REUSE (otro módulo)`);
    }
  }
  assert(act(r, `exam:${M1}`).action === 'REUSE', 'examen de M1 intacto');
  assertDeepEqual(act(r, `exam:${M2}`).reasons, ['module_membership_changed'], 'motivo examen');
});

check('eliminar capítulo (C1 con video): sus items SOFT_DISABLE, examen de M1 REGENERATE (criterio)', () => {
  const to = baseSpec();
  to[0].chapters.shift();
  const r = plan(baseSpec(), to);
  expectActions(r, {
    [`content:${C1}`]: 'SOFT_DISABLE',
    [`scorm:${C1}`]: 'SOFT_DISABLE',
    [`video:${C1}`]: 'SOFT_DISABLE',
    [`exam:${M1}`]: 'REGENERATE',
  });
  for (const k of [`content:${C1}`, `scorm:${C1}`, `video:${C1}`]) {
    const a = act(r, k);
    assert(!a.inTargetManifest && a.fromItemRunId === `ir-${k}` && a.reasons[0] === 'chapter_deleted', `detalle ${k}`);
  }
  // C2 y C3 mantienen su orden relativo: no hay REVIEW por reorden.
  assert(act(r, `content:${C2}`).action === 'REUSE' && act(r, `content:${C3}`).action === 'REUSE', 'sin review');
});

check('reordenar dentro del módulo: REUSE + REVIEW de los afectados, examen REUSE, sin regeneración', () => {
  const to = baseSpec();
  const [a, b] = to[0].chapters;
  to[0].chapters[0] = b;
  to[0].chapters[1] = a;
  const r = plan(baseSpec(), to);
  expectActions(r, { [`content:${C1}`]: 'REVIEW', [`content:${C2}`]: 'REVIEW' });
  assertDeepEqual(act(r, `content:${C1}`).reasons, ['reordered_within_module'], 'motivo');
  assert(act(r, `content:${C1}`).fromItemRunId === `ir-content:${C1}`, 'REVIEW reutiliza el item run');
  assert(r.p.totals.REGENERATE === 0 && r.p.totals.GENERATE === 0, 'sin regeneración');
});

check('mover capítulo entre módulos (C3: M1→M2): content REVIEW, scorm REUSE, ambos exámenes REGENERATE', () => {
  const to = baseSpec();
  const moved = to[0].chapters.pop();
  to[1].chapters.push(moved);
  const r = plan(baseSpec(), to);
  expectActions(r, {
    [`content:${C3}`]: 'REVIEW',
    [`exam:${M1}`]: 'REGENERATE',
    [`exam:${M2}`]: 'REGENERATE',
  });
  assertDeepEqual(act(r, `content:${C3}`).reasons, ['moved_across_modules'], 'motivo');
  assert(act(r, `content:${C3}`).moduleId === M2, 'moduleId destino');
});

check('mover capítulo con video entre módulos (C1: M1→M3): video REUSE, examen M3 (OFF) no aparece', () => {
  const to = baseSpec();
  const moved = to[0].chapters.shift();
  to[2].chapters.unshift(moved);
  const r = plan(baseSpec(), to);
  // C6 queda REUSE: entre los capítulos comunes a M3 (solo C6) no hubo reorden.
  expectActions(r, { [`content:${C1}`]: 'REVIEW', [`exam:${M1}`]: 'REGENERATE' });
  assert(act(r, `video:${C1}`).action === 'REUSE', 'video REUSE');
});

check('editar título de capítulo (C4, con video): content+scorm REGENERATE, video STALE_NO_AUTO, examen REGENERATE', () => {
  const to = baseSpec();
  to[1].chapters[0].title = 'Capítulo cuatro (revisado)';
  const r = plan(baseSpec(), to);
  expectActions(r, {
    [`content:${C4}`]: 'REGENERATE',
    [`scorm:${C4}`]: 'REGENERATE',
    [`video:${C4}`]: 'STALE_NO_AUTO',
    [`exam:${M2}`]: 'REGENERATE',
  });
  assert(act(r, `video:${C4}`).fromItemRunId === `ir-video:${C4}`, 'STALE_NO_AUTO conserva el artifact viejo');
  assertDeepEqual(act(r, `exam:${M2}`).reasons, ['member_content_changed'], 'motivo examen');
});

check('editar objetivo de capítulo (C2, sin video): content+scorm REGENERATE, examen M1 REGENERATE', () => {
  const to = baseSpec();
  to[0].chapters[1].objective = 'Objetivo dos, reformulado';
  const r = plan(baseSpec(), to);
  expectActions(r, { [`content:${C2}`]: 'REGENERATE', [`scorm:${C2}`]: 'REGENERATE', [`exam:${M1}`]: 'REGENERATE' });
});

check('video OFF→ON (C2, sin artifact previo): solo video GENERATE', () => {
  const to = baseSpec();
  to[0].chapters[1].video = true;
  const r = plan(baseSpec(), to);
  expectActions(r, { [`video:${C2}`]: 'GENERATE' });
  assertDeepEqual(act(r, `video:${C2}`).reasons, ['video_toggled_on'], 'motivo');
});

function withDisabledVideoC1(extra = {}) {
  return (items) => [
    ...items,
    { itemKey: `video:${C1}`, itemRunId: 'ir-old-video-c1', status: 'completed', artifactIds: ['art-old-video-c1'], artifactStatus: 'disabled', ...extra },
  ];
}

check('video OFF→ON con artifact deshabilitado que coincide: REUSE del deshabilitado', () => {
  const from = baseSpec();
  from[0].chapters[0].video = false;
  const r = plan(from, baseSpec(), { mutateItems: withDisabledVideoC1() });
  expectActions(r, { [`video:${C1}`]: 'REUSE' });
  const a = act(r, `video:${C1}`);
  assert(a.fromItemRunId === 'ir-old-video-c1', 'fuente = item run deshabilitado');
  assertDeepEqual(a.reasons, ['reenabled_matching_disabled'], 'motivo');
});

check('video OFF→ON con deshabilitado que NO coincide (huella guardada distinta / capítulo editado): GENERATE', () => {
  const from = baseSpec();
  from[0].chapters[0].video = false;
  const r1 = plan(from, baseSpec(), { mutateItems: withDisabledVideoC1({ inputFingerprint: 'otra-huella' }) });
  expectActions(r1, { [`video:${C1}`]: 'GENERATE' });
  const to = baseSpec();
  to[0].chapters[0].title = 'Capítulo uno editado';
  const r2 = plan(from, to, { mutateItems: withDisabledVideoC1() });
  expectActions(r2, {
    [`content:${C1}`]: 'REGENERATE',
    [`scorm:${C1}`]: 'REGENERATE',
    [`video:${C1}`]: 'GENERATE',
    [`exam:${M1}`]: 'REGENERATE',
  });
  // Con la huella guardada correcta, coincide.
  const good = matchFingerprint(computeFingerprints(buildBp(baseSpec())), `video:${C1}`);
  const r3 = plan(from, baseSpec(), { mutateItems: withDisabledVideoC1({ inputFingerprint: good }) });
  expectActions(r3, { [`video:${C1}`]: 'REUSE' });
});

check('video ON→OFF (C4): video SOFT_DISABLE, resto REUSE', () => {
  const to = baseSpec();
  to[1].chapters[0].video = false;
  const r = plan(baseSpec(), to);
  expectActions(r, { [`video:${C4}`]: 'SOFT_DISABLE' });
  assertDeepEqual(act(r, `video:${C4}`).reasons, ['video_toggled_off'], 'motivo');
});

check('examen OFF→ON (M3): exam GENERATE; con deshabilitado que coincide: REUSE', () => {
  const to = baseSpec();
  to[2].exam = true;
  const r = plan(baseSpec(), to);
  expectActions(r, { [`exam:${M3}`]: 'GENERATE' });
  const r2 = plan(baseSpec(), to, {
    mutateItems: (items) => [
      ...items,
      { itemKey: `exam:${M3}`, itemRunId: 'ir-old-exam-m3', status: 'completed', artifactIds: ['art-old-exam-m3'], artifactStatus: 'disabled' },
    ],
  });
  expectActions(r2, { [`exam:${M3}`]: 'REUSE' });
  assert(act(r2, `exam:${M3}`).fromItemRunId === 'ir-old-exam-m3', 'fuente');
});

check('examen ON→OFF (M2): exam SOFT_DISABLE, resto REUSE', () => {
  const to = baseSpec();
  to[1].exam = false;
  const r = plan(baseSpec(), to);
  expectActions(r, { [`exam:${M2}`]: 'SOFT_DISABLE' });
  assertDeepEqual(act(r, `exam:${M2}`).reasons, ['exam_toggled_off'], 'motivo');
});

check('editar título/objetivo de módulo (v1): contents REVIEW, examen REGENERATE', () => {
  for (const field of ['title', 'objective']) {
    const to = baseSpec();
    to[0][field] = `${to[0][field]} (editado)`;
    const r = plan(baseSpec(), to);
    expectActions(r, {
      [`content:${C1}`]: 'REVIEW',
      [`content:${C2}`]: 'REVIEW',
      [`content:${C3}`]: 'REVIEW',
      [`exam:${M1}`]: 'REGENERATE',
    });
    assertDeepEqual(act(r, `content:${C1}`).reasons, ['module_context_changed'], `motivo (${field})`);
  }
});

check('editar módulo (v2): contents REVIEW, examen + module_intro REGENERATE; plan/intro del curso REGENERATE', () => {
  const to = baseSpec();
  to[0].objective = 'Objetivo del módulo reformulado';
  const r = plan(baseSpec(), to, { v2From: true, v2To: true });
  expectActions(r, {
    [`course_plan:${COURSE_ID}`]: 'REGENERATE',
    [`course_intro:${COURSE_ID}`]: 'REGENERATE',
    [`module_intro:${M1}`]: 'REGENERATE',
    [`content:${C1}`]: 'REVIEW',
    [`content:${C2}`]: 'REVIEW',
    [`content:${C3}`]: 'REVIEW',
    [`exam:${M1}`]: 'REGENERATE',
  });
});

check('v2 agregar capítulo: course_plan no encadena a los content; module_intro solo del módulo tocado', () => {
  const to = baseSpec();
  to[1].chapters.push({ id: C7, title: 'Capítulo siete', objective: 'Objetivo siete' });
  const r = plan(baseSpec(), to, { v2From: true, v2To: true });
  expectActions(r, {
    [`course_plan:${COURSE_ID}`]: 'REGENERATE',
    [`course_intro:${COURSE_ID}`]: 'REGENERATE',
    [`module_intro:${M2}`]: 'REGENERATE',
    [`content:${C7}`]: 'GENERATE',
    [`scorm:${C7}`]: 'GENERATE',
    [`exam:${M2}`]: 'REGENERATE',
  });
});

check('v2 sin cambios: todo REUSE (incluidos course_plan, course_intro y module_intro)', () => {
  const r = plan(baseSpec(), baseSpec(), { v2From: true, v2To: true });
  expectActions(r, {});
});

check('v1 → v2 (mismo Blueprint): items nuevos de v2 GENERATE, el resto REUSE', () => {
  const r = plan(baseSpec(), baseSpec(), { v2To: true });
  expectActions(r, {
    [`course_plan:${COURSE_ID}`]: 'GENERATE',
    [`course_intro:${COURSE_ID}`]: 'GENERATE',
    [`module_intro:${M1}`]: 'GENERATE',
    [`module_intro:${M2}`]: 'GENERATE',
    [`module_intro:${M3}`]: 'GENERATE',
  });
});

check('v2 → v1: items v2 ausentes del destino SOFT_DISABLE', () => {
  const r = plan(baseSpec(), baseSpec(), { v2From: true });
  expectActions(r, {
    [`course_plan:${COURSE_ID}`]: 'SOFT_DISABLE',
    [`course_intro:${COURSE_ID}`]: 'SOFT_DISABLE',
    [`module_intro:${M1}`]: 'SOFT_DISABLE',
    [`module_intro:${M2}`]: 'SOFT_DISABLE',
    [`module_intro:${M3}`]: 'SOFT_DISABLE',
  });
});

check('eliminar módulo completo (M3): sus items SOFT_DISABLE por módulo/capítulo borrado', () => {
  const to = baseSpec();
  to.pop();
  const r = plan(baseSpec(), to, { v2From: true, v2To: true });
  expectActions(r, {
    [`course_plan:${COURSE_ID}`]: 'REGENERATE',
    [`course_intro:${COURSE_ID}`]: 'REGENERATE',
    [`module_intro:${M3}`]: 'SOFT_DISABLE',
    [`content:${C6}`]: 'SOFT_DISABLE',
    [`scorm:${C6}`]: 'SOFT_DISABLE',
  });
  assertDeepEqual(act(r, `module_intro:${M3}`).reasons, ['module_deleted'], 'motivo');
});

check('reordenar módulos: content de los módulos movidos REVIEW, nada se regenera (v1)', () => {
  const to = baseSpec();
  [to[0], to[1]] = [to[1], to[0]];
  const r = plan(baseSpec(), to);
  expectActions(r, {
    [`content:${C1}`]: 'REVIEW',
    [`content:${C2}`]: 'REVIEW',
    [`content:${C3}`]: 'REVIEW',
    [`content:${C4}`]: 'REVIEW',
    [`content:${C5}`]: 'REVIEW',
  });
});

check('salida previa faltante / artifact stale: GENERATE o STALE_NO_AUTO, nunca REUSE a ciegas', () => {
  const r = plan(baseSpec(), baseSpec(), {
    mutateItems: (items) =>
      items.map((it) => {
        if (it.itemKey === `content:${C5}`) return { ...it, status: 'failed', artifactIds: [] };
        if (it.itemKey === `video:${C4}`) return { ...it, artifactStatus: 'stale' };
        if (it.itemKey === `scorm:${C2}`) return { ...it, artifactStatus: 'stale' };
        return it;
      }),
  });
  expectActions(r, {
    [`content:${C5}`]: 'GENERATE',
    [`scorm:${C5}`]: 'REGENERATE',
    [`exam:${M2}`]: 'REGENERATE',
    [`video:${C4}`]: 'STALE_NO_AUTO',
    [`scorm:${C2}`]: 'REGENERATE',
  });
  assertDeepEqual(act(r, `content:${C5}`).reasons, ['unchanged', 'previous_output_missing'], 'motivo');
  // Item del run A sin fila en items (nunca corrió): GENERATE.
  const r2 = plan(baseSpec(), baseSpec(), { mutateItems: (items) => items.filter((i) => i.itemKey !== `scorm:${C6}`) });
  expectActions(r2, { [`scorm:${C6}`]: 'GENERATE' });
});

check('determinismo: mismo planSha256 con arreglos/claves de entrada barajados; repetible', () => {
  const to = baseSpec();
  to[1].chapters.push({ id: C7, title: 'Capítulo siete', objective: 'Objetivo siete', video: true });
  to[0].chapters.shift();
  const a = plan(baseSpec(), to, { v2From: true, v2To: true });
  const again = computeInvalidationPlan({
    from: { blueprint: a.fbp, manifest: a.fm, items: a.items },
    to: { blueprint: a.tbp, manifest: a.tm },
  });
  assert(again.planSha256 === a.p.planSha256, 'repetible');
  const rev = (x) => {
    if (Array.isArray(x)) return x.map(rev);
    if (x && typeof x === 'object') {
      const o = {};
      for (const k of Object.keys(x).reverse()) o[k] = rev(x[k]);
      return o;
    }
    return x;
  };
  const fbp = rev(clone(a.fbp));
  fbp.modules.reverse();
  fbp.modules.forEach((m) => m.chapters.reverse());
  const fm = rev(clone(a.fm));
  fm.items.reverse();
  const tm = rev(clone(a.tm));
  tm.items.reverse();
  const items = rev(clone(a.items)).reverse();
  const shuffled = computeInvalidationPlan({ from: { blueprint: fbp, manifest: fm, items }, to: { blueprint: a.tbp, manifest: tm } });
  assert(shuffled.planSha256 === a.p.planSha256, 'planSha256 con entrada barajada');
  assertDeepEqual(shuffled.actions, a.p.actions, 'acciones idénticas y mismo orden');
  // Orden canónico: items del destino en orden de curso, luego los eliminados.
  const idxDisabled = a.p.actions.findIndex((x) => x.action === 'SOFT_DISABLE');
  assert(a.p.actions.slice(idxDisabled).every((x) => !x.inTargetManifest), 'eliminados al final');
  assert(a.p.actions[0].itemKey === `course_plan:${COURSE_ID}`, 'course_plan primero');
});

check('idempotencia: aplicar el plan A→B y replanificar B→B da todo REUSE', () => {
  const to = baseSpec();
  to[1].chapters[0].title = 'Capítulo cuatro (revisado)';
  to[0].chapters.pop();
  const r = plan(baseSpec(), to);
  // Simula el run B: lo reusado conserva artifact; lo (re)generado queda completado; STALE_NO_AUTO sigue stale.
  const itemsB = r.p.actions
    .filter((a) => a.inTargetManifest)
    .map((a) => ({
      itemKey: a.itemKey,
      itemRunId: `irB-${a.itemKey}`,
      status: 'completed',
      artifactIds: [`artB-${a.itemKey}`],
      artifactStatus: a.action === 'STALE_NO_AUTO' ? 'stale' : 'ready',
    }));
  const p2 = computeInvalidationPlan({ from: { blueprint: r.tbp, manifest: r.tm, items: itemsB }, to: { blueprint: r.tbp, manifest: r.tm } });
  const res2 = { p: p2, tm: r.tm };
  expectActions(res2, { [`video:${C4}`]: 'STALE_NO_AUTO' });
});

check('entrada inválida falla fuerte (item de un capítulo inexistente / key duplicada)', () => {
  const bp = buildBp(baseSpec());
  const m = manifestV1(bp);
  const bad = clone(m);
  bad.items.push({ key: `content:${C7}`, type: 'content', scope: 'chapter', moduleId: M1, chapterId: C7 });
  let e1 = '';
  try {
    computeInvalidationPlan({ from: { blueprint: bp, manifest: m, items: [] }, to: { blueprint: bp, manifest: bad } });
  } catch (e) {
    e1 = e.message;
  }
  assert(/INVALID_INVALIDATION_INPUT/.test(e1), `esperaba INVALID_INVALIDATION_INPUT, fue: ${e1}`);
  const dup = clone(m);
  dup.items.push(clone(dup.items[0]));
  let e2 = '';
  try {
    computeInvalidationPlan({ from: { blueprint: bp, manifest: dup, items: [] }, to: { blueprint: bp, manifest: m } });
  } catch (e) {
    e2 = e.message;
  }
  assert(/duplicada/.test(e2), 'key duplicada');
});

check('la posición no entra en la huella del content', () => {
  const a = computeFingerprints(buildBp(baseSpec()));
  const to = baseSpec();
  to[0].chapters.reverse();
  const b = computeFingerprints(buildBp(to));
  for (const id of [C1, C2, C3]) assert(a.content.get(id).full === b.content.get(id).full, `huella ${id}`);
  assert(a.exam.get(M1) === b.exam.get(M1), 'examen: conjunto ordenado de chapterIds');
});

if (failures > 0) {
  console.error(`\n${failures} check(s) fallaron`);
  process.exit(1);
}
console.log('\nPlan de invalidación: todos los checks pasaron');
