#!/usr/bin/env node
/* eslint-disable */
// EV5-C (fase 1, backend) — tipo de la actividad de práctica elegido por el
// objetivo del capítulo, congelado en el Manifest v3.
//
// Todo puro/in-process (sin DB, sin red, sin LLM):
//   - clasificador (vectores fijos, incluye los objetivos reales de la auditoría P2);
//   - chooseActivityTypesV1: null → hash, balance max(1, floor(n/3)) sin tope,
//     orden de promoción fallback → relate → recall por fnv1a32, independiente del orden;
//   - Manifest v3: reglas 0 = sha fijado de siempre (byte-idéntico), reglas 1 =
//     features.activityTypeRules + h5pType, determinismo de ambos;
//   - validador: MISSING_H5P_TYPE / WRONG_H5P_TYPE / UNEXPECTED_H5P_TYPE / FEATURES_MISMATCH;
//   - config DYNAMIC_ACTIVITY_TYPE_RULES (default 0, ruidosa ante basura);
//   - GenerationManifestsService.getOrCreate con DataSource falso: fila legacy +
//     flag 1 sin error de determinismo; Blueprint nuevo de un curso legacy hereda
//     el hash (ruling); curso nuevo con flag 1; fila rules 1 + flag 0;
//   - resolveActivityType + claim (activityTypeSource) + validación al completar;
//   - invalidación v3: legacy → reglas 1 REGENERATE activity_type_changed solo
//     donde cambia el tipo resuelto, REUSE donde no; huellas legacy intactas;
//   - empaque + validador .mbz con h5pType ≠ hash (lee facts, no el hash).
//
// Usage: node scripts/check-v21-activity-type-rules.js [path/to/dist]

const path = require('path');
const fs = require('fs');

const distArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
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
const RULES = loadDist('modules/generation-manifests/activity-type-rules.js');
const CFG = loadDist('modules/generation-manifests/manifest-rules-config.js');
const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
const SHELL = loadDist('modules/course-shell/index.js');
const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
const P = loadDist('modules/invalidation/plan.js');
const F = loadDist('modules/invalidation/fingerprints.js');
const A = loadDist('modules/invalidation/invalidation-apply.js');
const R = loadDist('modules/dynamic-packaging/artifact-resolver.js');
const MBZ = loadDist('package/dynamic-mbz-builder-v3.js');
const V = loadDist('package/v3/mbz-validator-v3.js');
const PF = require('./lib/v21-packaging-fixtures');
const SF = require('./lib/v21-shell-fixtures');
const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'v21-activity-type-rules-vectors.json'), 'utf8'));
const HASH_VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'v21-activity-type-vectors.json'), 'utf8'));

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`);
}
function throwsRe(fn, re, m) {
  let e = null;
  try { fn(); } catch (x) { e = x; }
  assert(e, `${m}: no lanzó`);
  assert(re.test(e.message), `${m}: mensaje inesperado "${e.message}"`);
}
async function rejectsRe(p, re, m) {
  let e = null;
  try { await p; } catch (x) { e = x; }
  assert(e, `${m}: no lanzó`);
  const text = e.message + ' ' + JSON.stringify(e.getResponse ? e.getResponse() : '');
  assert(re.test(text), `${m}: mensaje inesperado "${text}"`);
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
const codesOf = (errs) => [...new Set(errs.map((e) => e.code))].sort();
const withEnv = async (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

// ── Fixtures ────────────────────────────────────────────────────────────────
// Mismo buildConfig que check-v21-manifest-v3.js (el sha fijado de reglas 0 debe seguir igual).
const COURSE_ID = 4242;
const SOURCE = { courseId: COURSE_ID, blueprintId: 77, blueprintNumber: 3, blueprintSha256: 'a'.repeat(64) };
const COMBOS = [[true, true], [true, false], [false, true], [false, false]];
function buildConfig({ moduleCount, examMode, finalExam, engine, objectives }) {
  const modules = [];
  const chapters = [];
  let k = 0;
  for (let mi = 0; mi < moduleCount; mi++) {
    const mid = `m${mi + 1}`;
    const exam = examMode === 'on' ? true : examMode === 'off' ? false : mi % 2 === 0;
    modules.push({ id: mid, position: (mi + 1) * 10, title: `Módulo ${mi + 1}`, objective: null, exam_enabled: exam });
    const n = 1 + ((mi + 3) % 4);
    for (let ci = 0; ci < n; ci++) {
      const [video, activity] = COMBOS[(ci + mi) % 4];
      chapters.push({
        id: `${mid}c${ci + 1}`, module_id: mid, position: (ci + 1) * 5, title: `Cap ${mid}.${ci + 1}`,
        objective: objectives ? objectives[k++ % objectives.length] : null, video_enabled: video, activity_enabled: activity,
      });
    }
  }
  const course = { id: COURSE_ID, title: 'Curso R4', finalExam, activityEngine: engine };
  return snap.buildBlueprintSnapshotV2(course, [...modules].reverse(), [...chapters].reverse());
}
// sha256 del Manifest v3 de buildConfig({moduleCount:4, examMode:'alt', finalExam:true, engine:'h5p'}) — fijado en check-v21-manifest-v3.js.
const PINNED_SHA_V3 = '3992216d4b763eef3dca6524a313decf79af26715240782de928dc63be7953cc';
const GOLDEN_CFG = { moduleCount: 4, examMode: 'alt', finalExam: true, engine: 'h5p' };
const OBJECTIVES = [
  'Diseñar estrategias de empaque para exportación',
  'Identificar los tipos de empaque',
  'Clasificar los residuos según su origen',
  null,
  'Explicar el ciclo de vida del producto',
  'Enumerar las etapas de la cadena de frío',
  'Comparar métodos de conservación',
];
// sha256 del Manifest v3 con reglas 1 de buildConfig({...GOLDEN_CFG, objectives: OBJECTIVES}).
// sha256 de TODAS las listas de las reglas v1 (verbos, raíces, terminaciones, lista negra, pistas, rangos, mapeo).
// CONGELADO: si cambia, no es rules 1 — nuevas reglas (activityTypeRules 2) con despacho propio.
const PINNED_RULES_V1_LISTS_SHA = 'c3e7f395a95bed0faf123d66421fd58bae92d8f56806c958021c966eee10fb67';
const PINNED_SHA_V3_RULES1 = 'c9ad40c71ef93f797c35e6cded78f439217b1e8b16a5b297e9ac4b62d4414b48';

/** Blueprint v2 a medida: chapters = [{ id, objective, title?, activity }] en un solo módulo. */
function oneModule(chapters, engine = 'h5p') {
  return snap.buildBlueprintSnapshotV2(
    { id: 7, title: 'Curso', finalExam: false, activityEngine: engine },
    [{ id: 'm1', position: 1, title: 'M', objective: null, exam_enabled: false }],
    chapters.map((c, i) => ({
      id: c.id, module_id: 'm1', position: c.position ?? i + 1, title: c.title ?? `Capítulo ${i + 1}`,
      objective: c.objective ?? null, video_enabled: false, activity_enabled: c.activity !== false,
    })),
  );
}
const cid = (n) => `c7000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function main() {
  // ── 1. Clasificador ─────────────────────────────────────────────────────
  await check(`clasificador: ${VECTORS.text.length} vectores de texto (objetivos de la auditoría, subjuntivos, títulos nominales, sustantivos que no son verbo)`, () => {
    for (const v of VECTORS.text) eq(RULES.classifyTextIntent(v.text), v.intent, JSON.stringify(v.text));
    eq(RULES.INTENT_TO_TYPE_V1, VECTORS.intentToType, 'INTENT_TO_TYPE_V1');
    // Ruling: understand → questionset; recall → blanks.
    eq([RULES.INTENT_TO_TYPE_V1.understand, RULES.INTENT_TO_TYPE_V1.recall], ['questionset', 'blanks'], 'rulings');
  });
  await check('clasificador de capítulo: objective → title → description; nada → null', () => {
    for (const v of VECTORS.chapter) eq(RULES.classifyChapterIntent(v.chapter), v.intent, v.note);
  });
  await check('plegado + mayor nivel cognitivo: con varios verbos gana apply > reflect > relate > understand > recall (no el más temprano)', () => {
    eq(RULES.foldText('Diseñar ESTRATEGIAS, análisis!'), ['disenar', 'estrategias', 'analisis'], 'fold');
    eq(RULES.classifyTextIntent('Comparar y luego aplicar'), 'apply', 'comparar + aplicar');
    eq(RULES.classifyTextIntent('Aplicar y luego comparar'), 'apply', 'aplicar + comparar');
    eq(RULES.classifyTextIntent('Identificar y comparar'), 'relate', 'recall + relate');
    eq(RULES.classifyTextIntent('Describir y valorar'), 'reflect', 'understand + reflect');
    // Un verbo en cualquier posición gana a cualquier pista de sustantivo.
    eq(RULES.classifyTextIntent('Glosario para aplicar en planta'), 'apply', 'verbo > sustantivo');
    eq(RULES.classifyTextIntent('Análisis de casos para identificar'), 'recall', 'hay verbo ⇒ las pistas no cuentan');
    eq(RULES.INTENT_RANK_V1, { apply: 5, reflect: 4, relate: 3, understand: 2, recall: 1 }, 'rangos');
  });
  await check('solo formas verbales: nominalizaciones (-ción/-sión/-miento/-anza/-ncia/-dor/-dora), participios y -mente nunca son verbo', () => {
    const nouns = ['aplicacion', 'aplicaciones', 'identificacion', 'construccion', 'valoracion', 'conocimiento', 'conocimientos', 'ordenamiento',
      'nombramiento', 'ordenador', 'ordenadora', 'evaluacion', 'comprension', 'diferenciacion', 'aplicado', 'aplicada', 'definido', 'definida',
      'organizadamente', 'comparativamente', 'confianza', 'diferencia', 'secuencia', 'resumen', 'nombre', 'uso', 'diseno', 'calculo', 'negocio',
      'mejora', 'formula', 'contraste', 'compartir', 'relevancia'];
    for (const w of nouns) eq(RULES.verbIntentOfWord(w), null, w);
    const verbs = { aplicar: 'apply', aplique: 'apply', apliquen: 'apply', aplicando: 'apply', aplicarlos: 'apply', analice: 'apply', elija: 'apply',
      resuelva: 'apply', construya: 'apply', establezca: 'apply', prevenga: 'apply', convierta: 'apply', usar: 'apply', utilice: 'apply',
      negocie: 'apply', fije: 'apply', conozca: 'recall', reconozca: 'recall', recuerde: 'recall', identifique: 'recall', distinga: 'relate',
      distingue: 'relate', organice: 'relate', clasifique: 'relate', ordene: 'relate', entienda: 'understand', explique: 'understand', resume: 'understand' };
    for (const [w, i] of Object.entries(verbs)) eq(RULES.verbIntentOfWord(w), i, w);
    // Las apply agregadas en la review.
    for (const v of ['elegir', 'establecer', 'usar', 'utilizar', 'adaptar', 'detectar', 'revisar', 'auditar', 'formular', 'redactar', 'prevenir', 'crear', 'convertir', 'generar', 'negociar', 'fijar']) {
      eq(RULES.verbIntentOfWord(v), 'apply', v);
    }
  });
  await check('CONGELADO: sha256 de la serialización canónica de todas las listas v1 = el fijado (cambiarlas exige activityTypeRules 2)', () => {
    eq(RULES.activityTypeRulesV1ListsSha256(), PINNED_RULES_V1_LISTS_SHA, 'listas v1');
  });

  // ── 2. chooseActivityTypesV1 ────────────────────────────────────────────
  await check('reglas v1: tipo por intención; sin clase → hash de siempre (vectores fijos del hash)', () => {
    const hv = HASH_VECTORS.vectors;
    const bp = oneModule([
      { id: hv[0].chapterId, objective: 'Aplicar técnicas' },
      { id: hv[1].chapterId, objective: 'Identificar partes' },
      { id: hv[2].chapterId, objective: 'Clasificar residuos' },
      { id: hv[3].chapterId, objective: null },
      { id: hv[4].chapterId, objective: 'Explicar el proceso' },
    ]);
    const m = RULES.chooseActivityTypesV1(bp);
    eq([...m.values()].map((d) => [d.intent, d.type, d.promoted]), [
      ['apply', 'questionset', false], ['recall', 'blanks', false], ['relate', 'dragtext', false],
      [null, hv[3].type, false], ['understand', 'questionset', false],
    ], 'decisiones');
  });
  await check('balance: mínimo max(1, floor(n/3)) questionset, SIN tope; promueve fallback → relate → recall por fnv1a32 ascendente', () => {
    // 6 recall ⇒ mínimo 2: los dos de menor fnv1a32.
    const ids6 = [1, 2, 3, 4, 5, 6].map(cid);
    const m6 = RULES.chooseActivityTypesV1(oneModule(ids6.map((id) => ({ id, objective: 'Identificar partes' }))));
    const byHash = [...ids6].sort((a, b) => SHELL.fnv1a32(a.toLowerCase()) - SHELL.fnv1a32(b.toLowerCase()));
    eq(ids6.filter((id) => m6.get(id).type === 'questionset').sort(), byHash.slice(0, 2).sort(), 'promovidos = 2 menores fnv');
    assert(ids6.filter((id) => m6.get(id).promoted).length === 2, 'marcados promoted');
    // Grupo antes que hash: un relate y un recall, 3 actividades ⇒ mínimo 1 ⇒ se promueve el relate.
    const m3 = RULES.chooseActivityTypesV1(oneModule([
      { id: cid(11), objective: 'Identificar partes' }, { id: cid(12), objective: 'Clasificar residuos' }, { id: cid(13), objective: 'Enumerar pasos' },
    ]));
    eq([m3.get(cid(11)).type, m3.get(cid(12)).type, m3.get(cid(13)).type], ['blanks', 'questionset', 'blanks'], 'relate antes que recall');
    // Fallback antes que relate: buscar un id sin clase cuyo hash no sea questionset.
    let fb = 20;
    while (SHELL.activityTypeForChapter(cid(fb)) === 'questionset') fb++;
    const mf = RULES.chooseActivityTypesV1(oneModule([
      { id: cid(fb), objective: null }, { id: cid(90), objective: 'Clasificar residuos' }, { id: cid(91), objective: 'Identificar partes' },
    ]));
    eq([mf.get(cid(fb)).type, mf.get(cid(90)).type, mf.get(cid(91)).type], ['questionset', 'dragtext', 'blanks'], 'fallback antes que relate');
    // Sin tope: todo apply ⇒ todo questionset.
    const ma = RULES.chooseActivityTypesV1(oneModule([1, 2, 3, 4, 5].map((n) => ({ id: cid(30 + n), objective: 'Diseñar planes' }))));
    assert([...ma.values()].every((d) => d.type === 'questionset' && !d.promoted), 'sin tope');
    // n = 1 ⇒ esa actividad es questionset; n = 0 / motor scorm ⇒ vacío.
    eq(RULES.chooseActivityTypesV1(oneModule([{ id: cid(40), objective: 'Identificar partes' }])).get(cid(40)).type, 'questionset', 'n=1');
    eq(RULES.chooseActivityTypesV1(oneModule([{ id: cid(41), objective: 'Identificar', activity: false }])).size, 0, 'n=0');
    eq(RULES.chooseActivityTypesV1(oneModule([{ id: cid(42), objective: 'Identificar' }], 'scorm')).size, 0, 'scorm');
    eq([0, 1, 2, 3, 5, 6, 9].map(RULES.minQuestionsetsFor), [0, 1, 1, 1, 1, 2, 3], 'minQuestionsetsFor');
  });
  await check('reglas v1 independientes del orden (módulos/capítulos/posiciones reordenados ⇒ mismo resultado)', () => {
    const chs = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: cid(50 + n), objective: n % 3 === 0 ? null : 'Identificar partes' }));
    const a = RULES.chooseActivityTypesV1(oneModule(chs));
    const b = RULES.chooseActivityTypesV1(oneModule([...chs].reverse().map((c, i) => ({ ...c, position: i + 1 }))));
    const norm = (m) => [...m.values()].map((d) => [d.chapterId, d.type]).sort();
    eq(norm(b), norm(a), 'reordenado');
    // Mismos capítulos repartidos en dos módulos.
    const two = snap.buildBlueprintSnapshotV2(
      { id: 7, title: 'Curso', finalExam: false, activityEngine: 'h5p' },
      [{ id: 'mB', position: 1, title: 'B', objective: null, exam_enabled: false }, { id: 'mA', position: 2, title: 'A', objective: null, exam_enabled: false }],
      chs.map((c, i) => ({ id: c.id, module_id: i % 2 ? 'mA' : 'mB', position: 100 - i, title: `Capítulo ${i + 1}`, objective: c.objective, video_enabled: false, activity_enabled: true })),
    );
    eq(norm(RULES.chooseActivityTypesV1(two)), norm(a), 'repartido en módulos');
  });

  // ── 3. Manifest v3 ──────────────────────────────────────────────────────
  const golden = buildConfig(GOLDEN_CFG);
  const goldenObj = buildConfig({ ...GOLDEN_CFG, objectives: OBJECTIVES });
  await check('reglas 0: sha fijado de siempre (default y explícito 0), sin activityTypeRules ni h5pType en el canonical', () => {
    const m0 = B.buildGenerationManifest(golden, SOURCE, { rulesVersion: 3 });
    const m0x = B.buildGenerationManifest(golden, SOURCE, { rulesVersion: 3, activityTypeRules: 0 });
    const mv3 = B.buildGenerationManifestV3(golden, SOURCE);
    eq([B.manifestSha256(m0), B.manifestSha256(m0x), B.manifestSha256(mv3)], [PINNED_SHA_V3, PINNED_SHA_V3, PINNED_SHA_V3], 'sha');
    const canon = B.canonicalManifestJson(m0);
    assert(!canon.includes('activityTypeRules') && !canon.includes('h5pType'), 'canonical legacy sin campos nuevos');
    // Con objetivos (que cambian el Blueprint pero no el Manifest de reglas 0): tampoco hay campos nuevos.
    const mo = B.buildGenerationManifest(goldenObj, SOURCE, { rulesVersion: 3 });
    assert(!B.canonicalManifestJson(mo).includes('h5pType'), 'reglas 0 con objetivos');
    eq(B.validateGenerationManifest(m0, golden, SOURCE), [], 'validador reglas 0');
  });
  await check('reglas 1: features.activityTypeRules = 1 y cada activity h5p con h5pType = chooseActivityTypesV1; sha fijado; resto idéntico a reglas 0', () => {
    const m1 = B.buildGenerationManifest(goldenObj, SOURCE, { rulesVersion: 3, activityTypeRules: 1 });
    const m0 = B.buildGenerationManifest(goldenObj, SOURCE, { rulesVersion: 3 });
    eq(m1.features, { finalExam: true, activityEngine: 'h5p', activityTypeRules: 1 }, 'features');
    const chosen = RULES.chooseActivityTypesV1(goldenObj);
    const acts = m1.items.filter((i) => i.type === 'activity');
    assert(acts.length > 0, 'hay actividades');
    for (const it of acts) eq(it.h5pType, chosen.get(it.chapterId).type, `h5pType ${it.key}`);
    assert(m1.items.filter((i) => i.type !== 'activity').every((i) => i.h5pType === undefined), 'solo activity');
    const strip = (m) => { const x = clone(m); delete x.features.activityTypeRules; for (const i of x.items) delete i.h5pType; return x; };
    eq(strip(m1), m0, 'sin los campos nuevos = reglas 0');
    // Hay al menos una actividad cuyo tipo por objetivo difiere del hash (si no, el fixture no prueba nada).
    assert(acts.some((i) => i.h5pType !== SHELL.activityTypeForChapter(i.chapterId)), 'alguna h5pType ≠ hash');
    const sha1 = B.manifestSha256(m1);
    assert(sha1 !== B.manifestSha256(m0), 'sha distinto de reglas 0');
    eq(sha1, PINNED_SHA_V3_RULES1, 'sha fijado reglas 1');
    eq(B.validateGenerationManifest(m1, goldenObj, SOURCE), [], 'validador reglas 1');
    // Motor scorm con reglas 1: marcador sí, h5pType no.
    const ms = B.buildGenerationManifest(buildConfig({ ...GOLDEN_CFG, engine: 'scorm', objectives: OBJECTIVES }), SOURCE, { rulesVersion: 3, activityTypeRules: 1 });
    assert(ms.features.activityTypeRules === 1 && ms.items.every((i) => i.h5pType === undefined), 'scorm');
  });
  await check('determinismo reglas 0 y 1: jsonb (claves reordenadas) → mismo canonical/sha; filas de entrada invertidas → mismo Manifest', () => {
    for (const rules of [0, 1]) {
      const m = B.buildGenerationManifest(goldenObj, SOURCE, { rulesVersion: 3, activityTypeRules: rules });
      const round = shuffleKeys(JSON.parse(B.canonicalManifestJson(m)));
      eq(B.canonicalManifestJson(round), B.canonicalManifestJson(m), `canonical rules ${rules}`);
      eq(B.manifestSha256(round), B.manifestSha256(m), `sha rules ${rules}`);
      eq(B.validateGenerationManifest(round, goldenObj, SOURCE), [], `validador tras jsonb rules ${rules}`);
      const again = B.buildGenerationManifest(clone(goldenObj), SOURCE, { rulesVersion: 3, activityTypeRules: rules });
      eq(B.manifestSha256(again), B.manifestSha256(m), `rebuild rules ${rules}`);
    }
  });
  await check('builder: activityTypeRules inválido o con rulesVersion 1/2 → throw', () => {
    throwsRe(() => B.buildGenerationManifestV3(golden, SOURCE, { activityTypeRules: 2 }), /activityTypeRules inválido/, 'valor 2');
    throwsRe(() => B.buildGenerationManifest({ schemaVersion: 1, course: { id: 1, title: 'x', structureVersion: 'dynamic' }, modules: [] }, SOURCE, { rulesVersion: 1, activityTypeRules: 1 }), /requiere rulesVersion 3/, 'v1 con reglas 1');
  });

  // ── 4. Validador ────────────────────────────────────────────────────────
  await check('validador: MISSING_H5P_TYPE / WRONG_H5P_TYPE / UNEXPECTED_H5P_TYPE / FEATURES_MISMATCH', () => {
    const m1 = B.buildGenerationManifest(goldenObj, SOURCE, { rulesVersion: 3, activityTypeRules: 1 });
    const m0 = B.buildGenerationManifest(goldenObj, SOURCE, { rulesVersion: 3 });
    const act = m1.items.find((i) => i.type === 'activity').key;
    const mut = (m, fn) => { const x = clone(m); fn(x); return codesOf(B.validateGenerationManifest(x, goldenObj, SOURCE)); };
    eq(mut(m1, (x) => { delete x.items.find((i) => i.key === act).h5pType; }), ['MISSING_H5P_TYPE'], 'falta h5pType');
    eq(mut(m1, (x) => { const it = x.items.find((i) => i.key === act); it.h5pType = it.h5pType === 'blanks' ? 'dragtext' : 'blanks'; }), ['WRONG_H5P_TYPE'], 'h5pType distinto');
    eq(mut(m1, (x) => { x.items.find((i) => i.key === act).h5pType = 'singlechoiceset'; }), ['WRONG_H5P_TYPE'], 'SCS');
    eq(mut(m0, (x) => { x.items.find((i) => i.key === act).h5pType = SHELL.activityTypeForChapter(x.items.find((i) => i.key === act).chapterId); }), ['UNEXPECTED_H5P_TYPE'], 'h5pType sin marcador (aunque sea el hash)');
    eq(mut(m1, (x) => { x.items.find((i) => i.type === 'content').h5pType = 'blanks'; }), ['UNEXPECTED_H5P_TYPE'], 'h5pType en content');
    eq(mut(m1, (x) => { delete x.features.activityTypeRules; }), ['UNEXPECTED_H5P_TYPE'], 'marcador borrado');
    // Marcador inválido: no se toma como 1 ⇒ además cada h5pType queda sin marcador válido.
    eq(mut(m1, (x) => { x.features.activityTypeRules = 2; }), ['FEATURES_MISMATCH', 'UNEXPECTED_H5P_TYPE'], 'marcador 2');
    eq(mut(m0, (x) => { x.features.activityTypeRules = 0; }), ['FEATURES_MISMATCH'], 'marcador 0 explícito');
    // El canonical conserva los campos para que el validador los vea (no los esconde).
    const tampered = clone(m0);
    tampered.items.find((i) => i.key === act).h5pType = 'blanks';
    assert(B.canonicalManifestJson(tampered).includes('"h5pType":"blanks"'), 'canonical copia h5pType');
  });

  // ── 5. Config ───────────────────────────────────────────────────────────
  await check('config DYNAMIC_ACTIVITY_TYPE_RULES: ausente/""/"0" → 0, "1" → 1, basura → throw ruidoso', () => {
    eq(CFG.ACTIVITY_TYPE_RULES_ENV, 'DYNAMIC_ACTIVITY_TYPE_RULES', 'nombre');
    eq([CFG.readActivityTypeRulesConfig({}), CFG.readActivityTypeRulesConfig({ DYNAMIC_ACTIVITY_TYPE_RULES: '' }),
      CFG.readActivityTypeRulesConfig({ DYNAMIC_ACTIVITY_TYPE_RULES: '0' }), CFG.readActivityTypeRulesConfig({ DYNAMIC_ACTIVITY_TYPE_RULES: '1' })], [0, 0, 0, 1], 'válidos');
    for (const bad of ['true', ' 1', '2', 'on', '01']) {
      throwsRe(() => CFG.readActivityTypeRulesConfig({ DYNAMIC_ACTIVITY_TYPE_RULES: bad }), /DYNAMIC_ACTIVITY_TYPE_RULES inválido/, JSON.stringify(bad));
    }
  });

  // ── 6. getOrCreate (DataSource falso, mismo contrato de filas que Postgres) ──
  // Varias filas (cursos / versiones de Blueprint); el INSERT guarda lo que el
  // servicio manda de verdad (canonical + sha de los parámetros).
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const bpSnap = goldenObj;
  const bpSnap4 = (() => { const x = clone(goldenObj); x.modules[0].chapters[0].title = 'Capítulo reescrito en v4'; return x; })();
  const BP = {
    3: { id: 77, courseId: COURSE_ID, blueprintNumber: 3, sha256: 'a'.repeat(64), schemaVersion: 2, snapshot: bpSnap },
    4: { id: 78, courseId: COURSE_ID, blueprintNumber: 4, sha256: 'b'.repeat(64), schemaVersion: 2, snapshot: bpSnap4 },
  };
  const blueprints = { getByNumberAnySchema: async (_c, _o, n) => BP[n], getByNumber: async () => { throw new Error('no v1'); } };
  const srcFor = (n) => ({ courseId: COURSE_ID, blueprintId: BP[n].id, blueprintNumber: n, blueprintSha256: BP[n].sha256 });
  const rowOf = (m, id = 900, courseId = COURSE_ID) => {
    const t = m.totals;
    return {
      id, course_id: courseId, blueprint_id: m.source.blueprintId, rules_version: 3, manifest_schema_version: 1,
      manifest_json: shuffleKeys(JSON.parse(B.canonicalManifestJson(m))), manifest_sha256: B.manifestSha256(m), blueprint_sha256: m.source.blueprintSha256,
      module_count: t.moduleCount, chapter_count: t.chapterCount, content_count: t.contentCount, scorm_count: 0, video_count: t.videoCount,
      exam_count: t.examCount, total_jobs: t.totalJobs, course_plan_count: t.coursePlanCount, course_intro_count: t.courseIntroCount,
      module_intro_count: t.moduleIntroCount, experience_count: t.experienceCount, presentation_count: t.presentationCount,
      video_interactions_count: t.videoInteractionsCount, activity_count: t.activityCount, audiobook_chapter_count: t.audiobookChapterCount,
      audio_welcome_count: t.audioWelcomeCount, final_exam_count: t.finalExamCount, created_at: new Date(Date.UTC(2026, 8, 1) + id * 1000), created_by: OWNER,
    };
  };
  function fakeDs(...existing) {
    const state = { rows: existing.filter(Boolean), inserts: 0, nextId: 950 };
    return {
      state,
      async query(sql, params) {
        if (/insert into public\.course_generation_manifests/.test(sql)) {
          const [courseId, blueprintId] = params;
          if (state.rows.some((r) => r.blueprint_id === blueprintId && r.rules_version === 3)) return [];
          const m = JSON.parse(params[3]);
          assert(B.manifestSha256(m) === params[4], 'sha del INSERT = sha del canonical');
          state.inserts++;
          const row = rowOf(m, state.nextId++, courseId);
          state.rows.push(row);
          return [row];
        }
        if (/select id, manifest_json->'features'->'activityTypeRules' as activity_type_rules/.test(sql)) {
          // Review (4): solo el marcador jsonb, no el documento. jsonb ausente → null (como Postgres).
          assert(/rules_version = 3/.test(sql) && /order by created_at desc, id desc/.test(sql), 'consulta del Manifest previo');
          return state.rows.filter((r) => r.course_id === params[0] && r.rules_version === 3)
            .sort((a, b) => b.created_at - a.created_at || b.id - a.id).slice(0, 1)
            .map((r) => ({ id: r.id, activity_type_rules: r.manifest_json.features.activityTypeRules ?? null }));
        }
        if (/select \* from public\.course_generation_manifests/.test(sql)) {
          return state.rows.filter((r) => r.blueprint_id === params[0] && r.course_id === params[1] && r.rules_version === params[2]);
        }
        throw new Error(`query inesperada: ${sql.slice(0, 80)}`);
      },
    };
  }
  const gcEnv = { DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_V2_ALLOWED_OWNERS: undefined, DYNAMIC_MANIFEST_RULES_VERSION: '3' };
  const legacy = B.buildGenerationManifest(bpSnap, srcFor(3), { rulesVersion: 3 });
  const withRules = B.buildGenerationManifest(bpSnap, srcFor(3), { rulesVersion: 3, activityTypeRules: 1 });
  const noMarker = (m) => m.features.activityTypeRules === undefined && m.items.every((i) => i.h5pType === undefined);

  await check('getOrCreate: fila legacy (sin marcador) + DYNAMIC_ACTIVITY_TYPE_RULES=1 → devuelve la legacy, sin error de determinismo', async () => {
    await withEnv({ ...gcEnv, DYNAMIC_ACTIVITY_TYPE_RULES: '1' }, async () => {
      const ds = fakeDs(rowOf(legacy));
      const res = await new GenerationManifestsService(ds, blueprints).getOrCreate(COURSE_ID, OWNER, 3);
      eq([res.created, ds.state.inserts], [false, 0], 'created');
      eq(res.manifest.sha256, B.manifestSha256(legacy), 'sha legacy');
      assert(noMarker(res.manifest.manifest), 'sin marcador ni h5pType');
    });
  });
  await check('getOrCreate (ruling: cursos existentes conservan el hash para siempre): curso con Manifest legacy + flag 1 + Blueprint NUEVO → Manifest nuevo SIN marcador ni h5pType', async () => {
    await withEnv({ ...gcEnv, DYNAMIC_ACTIVITY_TYPE_RULES: '1' }, async () => {
      // Otro curso con reglas 1 en la misma tabla: no se hereda de otro curso.
      const otherCourse = rowOf(B.buildGenerationManifest(bpSnap, { ...srcFor(3), courseId: 999, blueprintId: 55 }, { rulesVersion: 3, activityTypeRules: 1 }), 990, 999);
      const ds = fakeDs(rowOf(legacy, 900), otherCourse);
      const res = await new GenerationManifestsService(ds, blueprints).getOrCreate(COURSE_ID, OWNER, 4);
      eq([res.created, ds.state.inserts, res.manifest.blueprintId], [true, 1, 78], 'insertó v4');
      assert(noMarker(res.manifest.manifest), 'v4 hereda legacy (sin marcador ni h5pType)');
      eq(res.manifest.sha256, B.manifestSha256(B.buildGenerationManifest(bpSnap4, srcFor(4), { rulesVersion: 3 })), 'sha = build legacy de v4');
      // Idempotente: repetir el POST devuelve la misma fila (determinismo intacto).
      const again = await new GenerationManifestsService(ds, blueprints).getOrCreate(COURSE_ID, OWNER, 4);
      eq([again.created, again.manifest.sha256, ds.state.inserts], [false, res.manifest.sha256, 1], 'repetido');
    });
    // Un curso que ya tiene reglas 1 las conserva en su versión siguiente aunque la config vuelva a 0 o sea basura.
    for (const flag of ['0', 'yes']) {
      await withEnv({ ...gcEnv, DYNAMIC_ACTIVITY_TYPE_RULES: flag }, async () => {
        const res = await new GenerationManifestsService(fakeDs(rowOf(withRules, 900)), blueprints).getOrCreate(COURSE_ID, OWNER, 4);
        eq([res.created, res.manifest.manifest.features.activityTypeRules], [true, 1], `hereda reglas 1 con flag ${flag}`);
      });
    }
  });
  await check('getOrCreate: curso SIN Manifest v3 previo + flag 1 → fila nueva con marcador + h5pType; flag 0 sobre esa fila → la conserva', async () => {
    await withEnv({ ...gcEnv, DYNAMIC_ACTIVITY_TYPE_RULES: '1' }, async () => {
      const ds = fakeDs();
      const res = await new GenerationManifestsService(ds, blueprints).getOrCreate(COURSE_ID, OWNER, 3);
      eq([res.created, ds.state.inserts], [true, 1], 'insertó');
      eq(res.manifest.sha256, B.manifestSha256(withRules), 'sha reglas 1');
      eq(res.manifest.manifest.features.activityTypeRules, 1, 'marcador');
      assert(res.manifest.manifest.items.filter((i) => i.type === 'activity').every((i) => typeof i.h5pType === 'string'), 'h5pType');
    });
    await withEnv({ ...gcEnv, DYNAMIC_ACTIVITY_TYPE_RULES: '0' }, async () => {
      const ds = fakeDs();
      const res = await new GenerationManifestsService(ds, blueprints).getOrCreate(COURSE_ID, OWNER, 3);
      assert(res.created && noMarker(res.manifest.manifest), 'curso nuevo con flag 0 → legacy');
    });
    for (const flag of ['0', undefined]) {
      await withEnv({ ...gcEnv, DYNAMIC_ACTIVITY_TYPE_RULES: flag }, async () => {
        const res = await new GenerationManifestsService(fakeDs(rowOf(withRules)), blueprints).getOrCreate(COURSE_ID, OWNER, 3);
        eq([res.created, res.manifest.sha256], [false, B.manifestSha256(withRules)], `flag ${flag}`);
      });
    }
  });
  await check('getOrCreate: una fila con marcador cuyo h5pType no es el recalculado → "no determinístico" (500); curso nuevo con flag basura → error ruidoso', async () => {
    const bad = clone(withRules);
    const it = bad.items.find((i) => i.type === 'activity');
    it.h5pType = it.h5pType === 'blanks' ? 'dragtext' : 'blanks';
    await withEnv({ ...gcEnv, DYNAMIC_ACTIVITY_TYPE_RULES: '0' }, async () => {
      await rejectsRe(new GenerationManifestsService(fakeDs(rowOf(bad)), blueprints).getOrCreate(COURSE_ID, OWNER, 3), /no determinístico.*activityTypeRules 1/, 'tampered');
    });
    await withEnv({ ...gcEnv, DYNAMIC_ACTIVITY_TYPE_RULES: 'yes' }, async () => {
      await rejectsRe(new GenerationManifestsService(fakeDs(), blueprints).getOrCreate(COURSE_ID, OWNER, 3), /DYNAMIC_ACTIVITY_TYPE_RULES inválido/, 'basura');
    });
  });

  await check('getOrCreate: marcador heredado solo como número JS 0/1 (null → 0); un string "1" u otro valor → 500 explícito', async () => {
    const dsWith = (val) => {
      const base = fakeDs();
      const q = base.query;
      base.query = async (sql, params) => (/as activity_type_rules/.test(sql) ? [{ id: 7, activity_type_rules: val }] : q(sql, params));
      return base;
    };
    await withEnv({ ...gcEnv, DYNAMIC_ACTIVITY_TYPE_RULES: '1' }, async () => {
      for (const [val, want] of [[null, undefined], [0, undefined], [1, 1]]) {
        const res = await new GenerationManifestsService(dsWith(val), blueprints).getOrCreate(COURSE_ID, OWNER, 3);
        eq(res.manifest.manifest.features.activityTypeRules, want, `valor ${JSON.stringify(val)}`);
      }
      for (const val of ['1', '0', 2, true, {}, [1]]) {
        await rejectsRe(new GenerationManifestsService(dsWith(val), blueprints).getOrCreate(COURSE_ID, OWNER, 3),
          /Generation Manifest #7: features\.activityTypeRules guardado inválido/, `valor ${JSON.stringify(val)}`);
      }
    });
  });
  await check('arranque: cada config inválida se loguea por separado (una no esconde a la otra)', async () => {
    const { Logger } = require(require.resolve('@nestjs/common', { paths: [distRoot] }));
    const orig = Logger.prototype.error;
    const logged = [];
    Logger.prototype.error = function (msg) { logged.push(String(msg)); };
    try {
      await withEnv({ DYNAMIC_MANIFEST_RULES_VERSION: 'v9', DYNAMIC_ACTIVITY_TYPE_RULES: 'yes' }, async () => {
        new GenerationManifestsService(fakeDs(), blueprints);
      });
    } finally {
      Logger.prototype.error = orig;
    }
    assert(logged.some((m) => /DYNAMIC_MANIFEST_RULES_VERSION inválido/.test(m)), `sin error de rulesVersion: ${logged}`);
    assert(logged.some((m) => /DYNAMIC_ACTIVITY_TYPE_RULES inválido/.test(m)), `sin error de activityTypeRules: ${logged}`);
  });

  // ── 7. Resolvedor + claim + validación al completar ─────────────────────
  const chId = HASH_VECTORS.vectors[0].chapterId; // hash = questionset
  const hashType = SHELL.activityTypeForChapter(chId);
  const other = hashType === 'blanks' ? 'dragtext' : 'blanks';
  const itemLegacy = { key: `activity:${chId}`, type: 'activity', chapterId: chId, variant: 'h5p' };
  const itemRules = { ...itemLegacy, h5pType: other };
  await check('resolveActivityType: h5pType explícito (manifest) ?? hash (rotation); no-h5p → null; h5pType inválido → throw', () => {
    eq(SHELL.resolveActivityTypeWithSource(itemLegacy), { type: hashType, source: 'rotation' }, 'legacy');
    eq(SHELL.resolveActivityTypeWithSource(itemRules), { type: other, source: 'manifest' }, 'manifest');
    eq(SHELL.resolveActivityType({ key: `activity:${chId}`, variant: 'h5p' }), hashType, 'chapterId desde la key');
    eq([SHELL.resolveActivityType({ ...itemLegacy, variant: 'scorm' }), SHELL.resolveActivityType({ key: `content:${chId}`, type: 'content', chapterId: chId }), SHELL.resolveActivityType(null)], [null, null, null], 'null');
    throwsRe(() => SHELL.resolveActivityType({ ...itemLegacy, h5pType: 'singlechoiceset' }), /ACTIVITY_TYPE_INVALID_MANIFEST/, 'SCS');
    // Vectores del hash: el resolvedor legacy = activityTypeForChapter.
    for (const v of HASH_VECTORS.vectors) eq(SHELL.resolveActivityType({ key: `activity:${v.chapterId}`, type: 'activity', chapterId: v.chapterId, variant: 'h5p' }), v.type, v.chapterId);
  });
  await check('validateH5pActivityPayload / validateV3ItemArtifact: expectedType del Manifest; sin él, el hash de siempre', () => {
    const pOther = SF.h5pPayload(other);
    const pHash = SF.h5pPayload(hashType);
    const exp = { chapterId: chId, itemKey: itemLegacy.key };
    assert(SHELL.validateH5pActivityPayload(pHash, exp).ok, 'legacy acepta hash');
    eq(codesOf(SHELL.validateH5pActivityPayload(pOther, exp).errors), ['ACTIVITY_TYPE_MISMATCH'], 'legacy rechaza otro');
    assert(SHELL.validateH5pActivityPayload(pOther, { ...exp, expectedType: other }).ok, 'manifest acepta h5pType');
    const mis = SHELL.validateH5pActivityPayload(pHash, { ...exp, expectedType: other });
    eq(codesOf(mis.errors), ['ACTIVITY_TYPE_MISMATCH'], 'manifest rechaza el hash');
    assert(/\(Manifest\)/.test(mis.errors[0].message), 'mensaje dice Manifest');
    const ctx = { type: 'activity', variant: 'h5p', itemKey: itemLegacy.key, chapterId: chId, expectedActivityType: other };
    const r = SHELL.validateV3ItemArtifact(ctx, JSON.stringify(pOther));
    eq([r.ok, r.summary.activityType], [true, other], 'v3 validation');
    eq(SHELL.validateV3ItemArtifact({ ...ctx, expectedActivityType: undefined }, JSON.stringify(pHash)).summary.activityType, hashType, 'v3 legacy');
  });
  await check('scheduler: claim trae activityType + activityTypeSource (manifest | rotation)', async () => {
    const svc = Object.create(SchedulerService.prototype);
    const manifest = { rulesVersion: 3, modules: [], items: [] };
    const row = { type: 'activity', chapter_id: chId };
    eq(await svc.buildClaimV3({}, row, itemRules, manifest), { validatedArtifactType: 'dynamic_h5p_params_json', activityType: other, activityTypeSource: 'manifest' }, 'manifest');
    eq(await svc.buildClaimV3({}, row, itemLegacy, manifest), { validatedArtifactType: 'dynamic_h5p_params_json', activityType: hashType, activityTypeSource: 'rotation' }, 'rotation');
    eq(await svc.buildClaimV3({}, row, { ...itemLegacy, variant: 'scorm' }, manifest), { validatedArtifactType: null }, 'scorm');
  });
  await check('scheduler: la validación al completar exige el tipo del Manifest congelado del run (h5pType ≠ hash)', async () => {
    const runId = '22222222-2222-4222-8222-222222222222';
    const run = (mItem, payload) => {
      const svc = Object.create(SchedulerService.prototype);
      svc.dataSource = {
        async query(sql) {
          if (/from public\.generation_item_runs g/.test(sql)) {
            return [{ id: runId, job_id: 'j', manifest_id: 1, item_key: mItem.key, type: 'activity', status: 'running', worker_id: 'ex', chapter_id: chId,
              module_id: 'm', owner_id: OWNER, job_course_id: 1, frontend_course_id: 'fc', rules_version: 3, manifest_json: { rulesVersion: 3, items: [mItem] } }];
          }
          if (/from public\.artifacts/.test(sql)) return [{ id: 'a1', type: 'dynamic_h5p_params_json', storage_bucket: 'b', storage_path: 'p' }];
          throw new Error(`query inesperada ${sql.slice(0, 60)}`);
        },
      };
      svc.v3Reader = { readText: async () => JSON.stringify(payload) };
      return svc.prevalidateV3(runId, 'ex', ['a1'], OWNER, null);
    };
    const okR = await run(itemRules, SF.h5pPayload(other));
    eq([okR.kind, okR.summary.activityType], ['valid', other], 'h5pType aceptado');
    const badR = await run(itemRules, SF.h5pPayload(hashType));
    eq([badR.kind, badR.codes], ['invalid', ['ACTIVITY_TYPE_MISMATCH']], 'hash rechazado con h5pType');
    const legacyR = await run(itemLegacy, SF.h5pPayload(hashType));
    eq(legacyR.kind, 'valid', 'legacy: hash aceptado');
  });

  // ── 8. Invalidación v3 ──────────────────────────────────────────────────
  const CTX = 'c'.repeat(64);
  const invBp = goldenObj;
  const srcOf = (n) => ({ courseId: COURSE_ID, blueprintId: n, blueprintNumber: n, blueprintSha256: snap.snapshotSha256V2(invBp) });
  const recordsOf = (manifest, tag) => manifest.items.map((it) => ({
    itemKey: it.key, itemRunId: `${tag}#${it.key}`, status: 'completed',
    artifactIds: R.requiredArtifactTypesV3(it.type, it.variant).map((r) => `${tag}|${it.key}|${r}`),
    artifactStatus: 'ready', inputFingerprint: null, outputIdentity: `out/${tag}/${it.key}`,
    ...(it.type === 'video_interactions' ? { consumedVideoIdentity: `out/${tag}/video:${it.chapterId}` } : {}),
  }));
  const planOf = (mA, mB) => P.computeInvalidationPlan({
    from: { blueprint: invBp, manifest: mA, items: recordsOf(mA, 'A'), courseContextSha256: CTX },
    to: { blueprint: invBp, manifest: mB, courseContextSha256: CTX },
  });
  const mLegacy = B.buildGenerationManifest(invBp, srcOf(1), { rulesVersion: 3 });
  const mRules = B.buildGenerationManifest(invBp, srcOf(2), { rulesVersion: 3, activityTypeRules: 1 });
  await check('invalidación: legacy (hash) → reglas 1, mismo Blueprint: REGENERATE activity_type_changed SOLO donde cambia el tipo resuelto; el resto REUSE', () => {
    const plan = planOf(mLegacy, mRules);
    const changed = mRules.items.filter((i) => i.type === 'activity' && i.h5pType !== SHELL.activityTypeForChapter(i.chapterId)).map((i) => i.key);
    const same = mRules.items.filter((i) => i.type === 'activity' && i.h5pType === SHELL.activityTypeForChapter(i.chapterId)).map((i) => i.key);
    assert(changed.length > 0 && same.length > 0, `fixture sin ambos casos (cambian ${changed.length}, iguales ${same.length})`);
    for (const a of plan.actions) {
      const want = changed.includes(a.itemKey) ? 'REGENERATE' : 'REUSE';
      eq(a.action, want, `${a.itemKey} (${a.reasons.join(',')})`);
      if (want === 'REGENERATE') eq(a.reasons, ['activity_type_changed'], `${a.itemKey} reasons`);
    }
    // Y al revés (reglas 1 → legacy): las mismas actividades vuelven a cambiar.
    const back = planOf(mRules, mLegacy);
    eq(back.actions.filter((a) => a.action === 'REGENERATE').map((a) => a.itemKey).sort(), [...changed].sort(), 'reverso');
    // El apply deja pendientes solo esas actividades.
    const w = A.planApplyWrites(plan, mRules.items, invBp, CTX, () => 'ready', () => null,
      { required: (t, v) => R.requiredArtifactTypes(3, t, v), typeOf: (id) => String(id).split('|')[2] });
    eq(w.missingRoles, [], 'missingRoles');
    eq(w.seeds.filter((s) => s.status === 'pending').map((s) => s.itemKey).sort(), [...changed].sort(), 'pendientes');
  });
  await check('invalidación: reglas 1 → reglas 1 (mismo Blueprint) todo REUSE; legacy → legacy todo REUSE (sin cambios de siempre)', () => {
    const mRules3 = B.buildGenerationManifest(invBp, srcOf(3), { rulesVersion: 3, activityTypeRules: 1 });
    assert(planOf(mRules, mRules3).actions.every((a) => a.action === 'REUSE'), 'reglas 1 estable');
    const mLegacy3 = B.buildGenerationManifest(invBp, srcOf(3), { rulesVersion: 3 });
    assert(planOf(mLegacy, mLegacy3).actions.every((a) => a.action === 'REUSE'), 'legacy estable');
  });
  await check('huellas: h5pType entra SOLO si es explícito (las legacy no cambian); assertItemsMatchBlueprintV3 valida h5pType', () => {
    const fps = F.computeFingerprintsV3(invBp, { courseContextSha256: CTX });
    const key = mRules.items.find((i) => i.type === 'activity').key;
    const legacyFp = F.matchFingerprintV3(fps, key, { variant: 'h5p' });
    eq(F.matchFingerprintV3(fps, key, { variant: 'h5p', h5pType: null }), legacyFp, 'h5pType null = legacy');
    eq(F.itemFingerprintV3(fps, key, { variant: 'h5p', h5pType: undefined }), F.itemFingerprintV3(fps, key, { variant: 'h5p' }), 'full legacy');
    assert(F.matchFingerprintV3(fps, key, { variant: 'h5p', h5pType: 'blanks' }) !== legacyFp, 'explícito cambia la huella');
    assert(F.matchFingerprintV3(fps, key, { variant: 'h5p', h5pType: 'blanks' }) !== F.matchFingerprintV3(fps, key, { variant: 'h5p', h5pType: 'dragtext' }), 'tipo distinto, huella distinta');
    const bad1 = clone(mRules); bad1.items.find((i) => i.type === 'content').h5pType = 'blanks';
    throwsRe(() => planOf(mLegacy, bad1), /declara h5pType pero no es una activity h5p/, 'h5pType en content');
    const bad2 = clone(mRules); bad2.items.find((i) => i.type === 'activity').h5pType = 'singlechoiceset';
    throwsRe(() => planOf(mLegacy, bad2), /h5pType inválido/, 'h5pType inválido');
  });

  // ── 9. Empaque + validador .mbz con h5pType ≠ hash ──────────────────────
  // course2: actividades en los capítulos 1 (hash blanks) y 3 (hash questionset).
  const PKG = { engine: 'h5p', finalExam: true, activityTypeRules: 1, chapterObjectives: ['Diseñar estrategias de empaque', 'Identificar partes', 'Organice las etapas del despacho', 'Identificar partes'] };
  await check('empaque v3 con reglas 1: cada .h5p usa h5pType (≠ hash) y el validador .mbz (vía facts) lo acepta', async () => {
    const input = PF.packagingInput(distRoot, PKG);
    const acts = input.manifest.items.filter((i) => i.type === 'activity');
    eq(acts.length, 2, 'dos actividades');
    assert(acts.every((i) => i.h5pType && i.h5pType !== SHELL.activityTypeForChapter(i.chapterId)), `h5pType ≠ hash: ${JSON.stringify(acts.map((i) => [i.h5pType, SHELL.activityTypeForChapter(i.chapterId)]))}`);
    const r = await MBZ.buildDynamicMbzV3(input);
    const LIB = { questionset: 'H5P.QuestionSet', dragtext: 'H5P.DragText', blanks: 'H5P.Blanks' };
    for (const it of acts) {
      const p = r.summary.h5pPackages.find((x) => x.itemKey === it.key);
      eq(p.mainLibrary, LIB[it.h5pType], `librería ${it.key}`);
      eq(r.expectations.facts.chapters.find((c) => c.id === it.chapterId).activityType, it.h5pType, `facts ${it.key}`);
    }
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, `validador: ${JSON.stringify(v.issues.slice(0, 5))}`);
    // Si facts dijera el hash (como antes), el validador marcaría las dos actividades.
    const exp = { ...r.expectations, facts: clone(r.expectations.facts) };
    for (const c of exp.facts.chapters) if (c.activityType) c.activityType = SHELL.activityTypeForChapter(c.id);
    const v2 = await V.validateMbzV3(r.mbz, exp);
    eq(v2.issues.filter((i) => i.code === 'H5P_LIBRARIES' && /debe ser/.test(i.message)).length, 2, 'facts con hash ⇒ 2 hallazgos');
  });
  await check('empaque v3 con reglas 1: un payload con el tipo del hash (≠ h5pType) falla fuerte con ACTIVITY_TYPE_MISMATCH', async () => {
    const input = PF.packagingInput(distRoot, PKG);
    const it = input.manifest.items.find((i) => i.type === 'activity');
    const p = SF.h5pPayload(SHELL.activityTypeForChapter(it.chapterId));
    p.data.itemKey = it.key;
    input.contents.activities.set(it.chapterId, { variant: 'h5p', payload: p });
    let e = null;
    try { await MBZ.buildDynamicMbzV3(input); } catch (x) { e = x; }
    assert(e && /H5P_ACTIVITY_PAYLOAD_INVALID: .*ACTIVITY_TYPE_MISMATCH.*\(Manifest\)/.test(e.message), `mensaje: ${e && e.message}`);
  });
  await check('empaque v3 legacy (reglas 0): mismos tipos del hash de siempre y validador ok', async () => {
    const input = PF.packagingInput(distRoot, { ...PKG, activityTypeRules: 0 });
    assert(input.manifest.items.every((i) => i.h5pType === undefined), 'sin h5pType');
    const r = await MBZ.buildDynamicMbzV3(input);
    const LIB = { questionset: 'H5P.QuestionSet', dragtext: 'H5P.DragText', blanks: 'H5P.Blanks' };
    for (const p of r.summary.h5pPackages.filter((x) => x.itemKey.startsWith('activity:'))) eq(p.mainLibrary, LIB[SHELL.activityTypeForChapter(p.itemKey.slice(9))], p.itemKey);
    assert((await V.validateMbzV3(r.mbz, r.expectations)).ok, 'validador legacy');
  });

  console.log(`\n${passes} ok, ${failures} fallas`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
