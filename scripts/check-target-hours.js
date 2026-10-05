#!/usr/bin/env node
/* eslint-disable no-console */
// Motor de carga horaria — Loop 2: `targetHours` como propiedad formal del diseño del curso.
//
//   Curso → Perfil (pedagógico, con o sin enfoque) → targetHours → Blueprint (course.targetHours) → Manifest
//
//   TH1 perfil: targetHours opcional, validado y normalizado (clave solo si se definió); vale sin enfoque
//   TH2 REGRESIÓN: sin targetHours, Blueprint y Manifest (línea base y pedagógico) y sha del perfil son
//       EXACTAMENTE los del código de staging anterior (80 casos: 4 estructuras × 10 perfiles × H5P v1/v2)
//   TH3 Blueprint con targetHours: clave en el snapshot, ida y vuelta canónica, inválido → falla
//   TH4 el Manifest no cambia por targetHours (mismos items, features y totales; solo el sha del Blueprint)
//   TH5 dry-run: targetHours del perfil (con y sin enfoque) → Blueprint + workload (objetivo vs. estimado)
//   TH6 cada enfoque conserva targetHours a través del diseño pedagógico y del ajuste de estructura
//   TH7 cambiar targetHours después de crear el Blueprint: nuevo sha (hay que reconfirmar) y la
//       invalidación NO regenera nada (cero trabajos, cero proveedores)
//   TH8 reordenar capítulos con targetHours: el objetivo se conserva y las horas estimadas no cambian
//   TH9 adversos: tipos raros, NaN, fuera de rango, pasos que no son de 0,5, string
//
// Uso: node scripts/check-target-hours.js [path/to/dist]   (después de npm run build)
'use strict';
const path = require('path');

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar ${abs} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
const P = loadDist('modules/pedagogy/index.js');
const PP = loadDist('modules/pedagogy/pedagogy-profile.js');
const DR = loadDist('modules/pedagogy/dry-run.js');
const MB = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const SNAP = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const PV3 = loadDist('modules/invalidation/plan-v3.js');
const RES = loadDist('modules/dynamic-packaging/artifact-resolver.js');
const ST = loadDist('modules/study-time/index.js');
const RCP = require('./fixtures/pedagogy/rcp-course.json');
const PF = require('./fixtures/pedagogy/profiles.json');
const LEGACY = require('./fixtures/study-time/legacy-shas.json');

let passes = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${name}\n   ${e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`);
  }
}
function assert(c, m) {
  if (!c) throw new Error(m);
}
function eq(a, b, m) {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m}: esperado ${B}, encontrado ${A}`);
}
function throwsRe(fn, re, m) {
  let msg = null;
  try {
    fn();
  } catch (e) {
    msg = e.message;
  }
  assert(msg !== null, `${m}: no falló`);
  assert(re.test(msg), `${m}: mensaje inesperado «${msg}»`);
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const profileOf = (k, extra = {}) => ({
  pedagogyProfileVersion: 1, primaryApproach: PF.profiles[k].primaryApproach, secondaryApproaches: PF.profiles[k].secondaryApproaches,
  learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', ...extra,
});
const emptyWith = (targetHours) => ({ ...PP.emptyPedagogicalProfile(), targetHours });
const manifestOf = (bp, n = 1, rules = 2) => MB.buildGenerationManifestV3(bp, { courseId: bp.course.id, blueprintId: n, blueprintNumber: n, blueprintSha256: SNAP.snapshotSha256V2(bp) }, { activityTypeRules: rules });
const structures = {
  rcp: clone(RCP),
  rcpReview: (() => { const s = clone(RCP); s.course.reviewCards = true; return s; })(),
  rcpToggles: (() => { const s = clone(RCP); s.modules[0].chapters[0].videoEnabled = false; s.modules[1].chapters[1].activityEnabled = false; s.modules[2].examEnabled = false; s.course.finalExam = false; return s; })(),
  rcpScorm: (() => { const s = clone(RCP); s.course.activityEngine = 'scorm'; return s; })(),
};
const profiles = { none: null, empty: PP.emptyPedagogicalProfile(), ...Object.fromEntries(Object.keys(PF.profiles).map((k) => [k, profileOf(k)])) };

check('TH1 perfil: targetHours opcional, validado y normalizado; vale sin enfoque', () => {
  const p = profileOf('competencias');
  eq(PP.validatePedagogicalProfile(p), [], 'perfil sin targetHours (como siempre)');
  eq('targetHours' in PP.normalizePedagogicalProfile(p), false, 'sin targetHours: la clave no aparece');
  eq(PP.validatePedagogicalProfile({ ...p, targetHours: 33 }), [], 'con 33 h');
  eq(PP.normalizePedagogicalProfile({ ...p, targetHours: 33.5 }).targetHours, 33.5, 'normalizado conserva el valor');
  eq('targetHours' in PP.normalizePedagogicalProfile({ ...p, targetHours: null }), false, 'null = sin objetivo');
  assert(PP.pedagogicalProfileSha256(PP.normalizePedagogicalProfile({ ...p, targetHours: 20 })) !== PP.pedagogicalProfileSha256(PP.normalizePedagogicalProfile(p)), 'el objetivo es parte del perfil versionado');
  const e = emptyWith(20);
  eq(PP.validatePedagogicalProfile(e), [], 'perfil sin enfoque con horas');
  eq(PP.isEmptyPedagogicalProfile(e), true, 'sin enfoque sigue siendo pedagógicamente vacío');
  eq([PP.profileTargetHours(e), PP.profileTargetHours(p), PP.profileTargetHours(null), PP.profileTargetHours(undefined)], [20, null, null, null], 'profileTargetHours');
  eq([ST.TARGET_HOURS_MIN, ST.TARGET_HOURS_MAX], [1, 500], 'rango');
});

check('TH2 REGRESIÓN: sin targetHours todo es byte a byte lo de staging (80 casos + sha de perfiles)', () => {
  eq(LEGACY.cases.length, 80, 'casos de referencia');
  for (const c of LEGACY.cases) {
    const r = P.runPedagogyDryRun({ structure: clone(structures[c.structure]), profile: profiles[c.profile] ? clone(profiles[c.profile]) : profiles[c.profile], activityTypeRules: c.activityTypeRules });
    const tag = `${c.structure}/${c.profile}/H5P v${c.activityTypeRules}`;
    eq({ blueprintSha256: r.baseline.blueprintSha256, manifestSha256: r.baseline.manifestSha256 }, c.baseline, `${tag} línea base`);
    eq(r.pedagogical ? { blueprintSha256: r.pedagogical.blueprintSha256, manifestSha256: r.pedagogical.manifestSha256 } : null, c.pedagogical, `${tag} pedagógico`);
    eq([r.targetHours, r.workload], [null, null], `${tag}: sin objetivo`);
    assert(!('targetHours' in r.baseline.blueprint.course), `${tag}: sin clave en el Blueprint`);
  }
  for (const [k, sha] of Object.entries(LEGACY.profileSha256)) eq(PP.pedagogicalProfileSha256(PP.normalizePedagogicalProfile(clone(profiles[k]))), sha, `sha del perfil ${k}`);
});

check('TH3 Blueprint con targetHours: clave, ida y vuelta canónica, inválido falla', () => {
  const plain = P.snapshotFromStructure(clone(RCP));
  const bp = DR.withTargetHours(plain, 33);
  eq(bp.course.targetHours, 33, 'clave en el snapshot');
  eq(Object.keys(bp.course), ['id', 'title', 'structureVersion', 'finalExam', 'activityEngine', 'targetHours'], 'orden canónico');
  const round = SNAP.recanonicalizeBlueprintSnapshotV2(JSON.parse(JSON.stringify(bp)));
  eq(SNAP.snapshotSha256V2(round), SNAP.snapshotSha256V2(bp), 'jsonb → canónico conserva el sha');
  eq(SNAP.snapshotSha256V2(DR.withTargetHours(bp, null)), SNAP.snapshotSha256V2(plain), 'quitar el objetivo vuelve al sha de siempre');
  for (const bad of [0, -5, 0.3, 501, NaN, '20', true]) throwsRe(() => DR.withTargetHours(plain, bad), /BLUEPRINT_V2_INVALID_INPUT: course.targetHours/, `targetHours ${JSON.stringify(bad)}`);
});

check('TH4 el Manifest no cambia por targetHours (solo el sha del Blueprint)', () => {
  for (const [k, s] of Object.entries(structures)) {
    for (const rules of [1, 2]) {
      const plain = P.snapshotFromStructure(clone(s));
      const a = manifestOf(plain, 1, rules);
      const bp = DR.withTargetHours(plain, 50);
      const b = manifestOf(bp, 1, rules);
      eq(MB.validateGenerationManifestV3(b, bp, b.source), [], `${k}: válido`);
      eq([b.items, b.features, b.totals, b.modules], [a.items, a.features, a.totals, a.modules], `${k} v${rules}: mismos trabajos`);
      assert(a.source.blueprintSha256 !== b.source.blueprintSha256, `${k}: el Blueprint sí cambia`);
    }
  }
});

check('TH5 dry-run: targetHours del perfil → Blueprint + workload (objetivo vs. estimado)', () => {
  const e = P.runPedagogyDryRun({ structure: clone(RCP), profile: emptyWith(20) });
  eq([e.profileEmpty, e.pedagogical, e.targetHours, e.baseline.blueprint.course.targetHours], [true, null, 20, 20], 'perfil sin enfoque con 20 h');
  eq(e.workload, { targetHours: 20, estimatedHours: e.baseline.studyTime.courseEstimatedHours, deltaHours: Math.round((e.baseline.studyTime.courseEstimatedHours - 20) * 10) / 10 }, 'workload de la línea base');
  const c = P.runPedagogyDryRun({ structure: clone(RCP), profile: profileOf('competencias', { targetHours: 33 }) });
  eq([c.targetHours, c.baseline.blueprint.course.targetHours, c.pedagogical.blueprint.course.targetHours], [33, 33, 33], 'competencias + 33 h');
  eq(c.workload.estimatedHours, c.pedagogical.studyTime.courseEstimatedHours, 'workload de la vista pedagógica');
  eq(c.pedagogical.manifestErrors, [], 'Manifest válido');
  eq(c.profile.targetHours, 33, 'el perfil normalizado lo conserva');
  // Estructura viva (snapshot) con objetivo propio y perfil sin objetivo: se conserva el del snapshot.
  const live = DR.withTargetHours(P.snapshotFromStructure(clone(RCP)), 40);
  eq(P.runPedagogyDryRun({ structure: live, profile: null }).targetHours, 40, 'objetivo del snapshot');
  eq(P.runPedagogyDryRun({ structure: live, profile: emptyWith(25) }).targetHours, 25, 'el perfil manda');
  throwsRe(() => P.runPedagogyDryRun({ structure: clone(RCP), profile: emptyWith(7.25) }), /PROFILE_INVALID: INVALID_TARGET_HOURS/, 'objetivo inválido → 400');
  throwsRe(() => P.runPedagogyDryRun({ structure: clone(RCP), profile: profileOf('competencias', { targetHours: 'treinta' }) }), /PROFILE_INVALID/, 'string → 400');
});

check('TH6 cada enfoque conserva targetHours a través del diseño y del ajuste de estructura', () => {
  for (const k of Object.keys(PF.profiles)) {
    for (const adj of [true, false]) {
      const r = P.runPedagogyDryRun({ structure: clone(structures.rcpReview), profile: profileOf(k, { targetHours: 50 }), applyStructureAdjustments: adj });
      eq(r.pedagogical.blueprint.course.targetHours, 50, `${k} (ajuste ${adj})`);
      eq(r.pedagogical.manifestErrors, [], `${k}: Manifest válido`);
      eq(r.workload.targetHours, 50, `${k}: workload`);
    }
  }
});

check('TH7 cambiar targetHours después del Blueprint: nuevo sha, invalidación sin regenerar nada', () => {
  const rules = P.deriveDesignRules(profileOf('competencias'));
  const bpA = P.applyPedagogyToSnapshot(DR.withTargetHours(P.snapshotFromStructure(clone(RCP)), 20), rules);
  const bpB = P.applyPedagogyToSnapshot(DR.withTargetHours(P.snapshotFromStructure(clone(RCP)), 33), rules);
  const bpNone = P.applyPedagogyToSnapshot(P.snapshotFromStructure(clone(RCP)), rules);
  assert(new Set([bpA, bpB, bpNone].map((b) => SNAP.snapshotSha256V2(b))).size === 3, 'tres sha distintos (reconfirmar el Blueprint)');
  for (const [from, to, label] of [[bpA, bpB, '20 → 33'], [bpNone, bpA, 'sin → 20'], [bpB, bpNone, '33 → sin']]) {
    const mA = manifestOf(from, 1);
    const mB = manifestOf(to, 2);
    const items = mA.items.map((it) => ({
      itemKey: it.key, itemRunId: `A#${it.key}`, status: 'completed', artifactIds: RES.requiredArtifactTypesV3(it.type, it.variant).map((r) => `A|${it.key}|${r}`),
      artifactStatus: 'ready', inputFingerprint: null, outputIdentity: `out/A/${it.key}`,
      ...(it.type === 'video_interactions' ? { consumedVideoIdentity: `out/A/video:${it.chapterId}` } : {}),
    }));
    const plan = PV3.computeInvalidationPlanV3({ from: { blueprint: from, manifest: mA, items }, to: { blueprint: to, manifest: mB } });
    const fresh = plan.actions.filter((a) => a.action !== 'REUSE');
    eq(fresh.map((a) => `${a.itemKey}=${a.action}`), [], `${label}: nada que regenerar`);
  }
});

check('TH7b con enfoque: cambiar las horas cambia el sha del perfil en el diseño, pero los trabajos y la invalidación no', () => {
  const mk = (h) => P.runPedagogyDryRun({ structure: clone(RCP), profile: profileOf('competencias', h === null ? {} : { targetHours: h }) }).pedagogical;
  const [a, b] = [mk(20), mk(33)];
  assert(a.blueprint.course.pedagogy.profileSha256 !== b.blueprint.course.pedagogy.profileSha256, 'el sha del perfil cambia con las horas');
  assert(a.manifest.features.pedagogy.profileSha256 !== b.manifest.features.pedagogy.profileSha256, 'y el del Manifest también');
  eq(b.manifest.items, a.manifest.items, 'mismos trabajos con el mismo diseño');
  const mA = manifestOf(a.blueprint, 1);
  const mB = manifestOf(b.blueprint, 2);
  const items = mA.items.map((it) => ({
    itemKey: it.key, itemRunId: `A#${it.key}`, status: 'completed', artifactIds: RES.requiredArtifactTypesV3(it.type, it.variant).map((r) => `A|${it.key}|${r}`),
    artifactStatus: 'ready', inputFingerprint: null, outputIdentity: `out/A/${it.key}`,
    ...(it.type === 'video_interactions' ? { consumedVideoIdentity: `out/A/video:${it.chapterId}` } : {}),
  }));
  const plan = PV3.computeInvalidationPlanV3({ from: { blueprint: a.blueprint, manifest: mA, items }, to: { blueprint: b.blueprint, manifest: mB } });
  eq(plan.actions.filter((x) => x.action !== 'REUSE').map((x) => `${x.itemKey}=${x.action}`), [], '20 → 33 h con enfoque: nada que regenerar');
});

check('TH8 reordenar capítulos con targetHours: el objetivo se conserva y las horas no cambian', () => {
  const re = clone(RCP);
  re.modules[0].chapters.reverse();
  re.modules.reverse();
  const a = P.runPedagogyDryRun({ structure: clone(RCP), profile: profileOf('significativo', { targetHours: 33 }) });
  const b = P.runPedagogyDryRun({ structure: re, profile: profileOf('significativo', { targetHours: 33 }) });
  eq(b.targetHours, 33, 'objetivo');
  eq(b.workload.estimatedHours, a.workload.estimatedHours, 'mismas horas (la suma no depende del orden)');
  eq(b.pedagogical.manifestErrors, [], 'Manifest válido');
});

check('TH9 adversos: tipos raros, NaN, fuera de rango, pasos que no son de 0,5', () => {
  const p = profileOf('competencias');
  for (const bad of [0, 0.5, -1, 500.5, 1000, NaN, Infinity, '20', [20], { h: 20 }, true, 20.25]) {
    const errs = PP.validatePedagogicalProfile({ ...p, targetHours: bad });
    eq(errs.map((x) => x.code), ['INVALID_TARGET_HOURS'], `targetHours ${String(bad)}`);
    throwsRe(() => PP.profileTargetHours({ targetHours: bad }), /INVALID_TARGET_HOURS/, `profileTargetHours ${String(bad)}`);
  }
  for (const ok of [1, 1.5, 20, 33, 49.5, 500]) eq(PP.validatePedagogicalProfile({ ...p, targetHours: ok }), [], `targetHours ${ok}`);
  eq(PP.validatePedagogicalProfile({ ...p, targethours: 20 }).map((x) => x.code), ['UNKNOWN_FIELD'], 'typo en la clave → campo desconocido');
});

console.log(`\n${passes} OK, ${failures} fallidas`);
process.exit(failures ? 1 : 0);
