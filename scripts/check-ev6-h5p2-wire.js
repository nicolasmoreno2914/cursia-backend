#!/usr/bin/env node
/* eslint-disable */
// Cursia EV6 — H5P pack v2, tarea H2 (cableado): checks PUROS (sin DB, sin red, sin Moodle).
//
//  1. Reglas de tipo v2: decide → branchingscenario, el resto igual que rules 1 (categorizar/secuenciar
//     → dragtext), tope de BS max(1, floor(n/4)) con descenso por fnv1a32, balance de «escenario»,
//     determinismo e independencia del orden; listas congeladas (sha).
//  2. Marcador del Manifest: activityTypeRules=2 ⇒ ivAdvanced=1; validador; resolveActivityType
//     acepta branchingscenario SOLO con el marcador 2; rules 1 nunca produce BS; config "2".
//  3. Blueprint «Repaso» (reviewCards): solo `true` entra al snapshot (sha legacy intacto).
//  4. .mbz con reglas 2 + «Repaso» + IV avanzado: BS con EXACTAMENTE la delta, Dialog Cards sin nota
//     (completion por vista, sin ítem de calificación, fuera de los criterios del curso), IV
//     schemaVersion 2 (pausas + remediación), secuencia de secciones, mbz-validator-v3 limpio.
//  5. Validador: negativos del add-on (ítem de nota, facts, texto «calificable»).
//  6. Invalidación: encender «Repaso» ⇒ todo REUSE (sin costo); cambiar a decide ⇒ regenera la actividad.
//  7. Golden: paquetes y .mbz legacy byte-idénticos (rules 0/1, sin «Repaso», schemaVersion 1).
//  8. Library Pack v2 + preflight v2 (puros).
//
// Uso: npm run build && node scripts/check-ev6-h5p2-wire.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..');
const distRoot = path.join(ROOT, 'dist');
const L = (rel) => require(path.join(distRoot, rel));
require('reflect-metadata');
global.fetch = async (u) => {
  throw new Error(`NETWORK FORBIDDEN in check: ${u}`);
};

const h = L('package/h5p/index.js');
const SHELL = L('modules/course-shell/index.js');
const RULES1 = L('modules/generation-manifests/activity-type-rules.js');
const RULES2 = L('modules/generation-manifests/activity-type-rules-v2.js');
const MB = L('modules/generation-manifests/generation-manifest-builder.js');
const CFG = L('modules/generation-manifests/manifest-rules-config.js');
const snap = L('modules/course-blueprints/blueprint-snapshot.js');
const B = L('package/dynamic-mbz-builder-v3.js');
const V = L('package/v3/mbz-validator-v3.js');
const P = L('modules/invalidation/plan.js');
const R = L('modules/dynamic-packaging/artifact-resolver.js');
const PACK = L('package/h5p/library-pack.js');
const PF = require('./lib/v21-packaging-fixtures');
const GOLD = require('./lib/h5p2-golden-legacy');

/** Huellas de los paquetes legacy en el commit base de H5P v2 (las mismas de check-ev6-h5p2-contracts.js). */
const GOLDEN = {
  h5p: {
    questionset: 'e9c32ce89c9d141d7b3e2e89370b136d831816c4e662cad005dd24222a9fa80a',
    singlechoiceset: '335e37588ee4ebe730bfb40dff10ca3fbb118d0e48399c451d245783fd885888',
    dragtext: '3486cac60d06bcaa2fc6f5b8b946f3eff282a39c0f5da775b5a845343813f756',
    blanks: 'f9a806c82239eaff8eebaf04720538a12365775c3c4039dca40b10075459126b',
    'interactivevideo-140': '8d5f6d0470cf55bbc52d1d7805681f6f3e87521531be81c68639df5e8e7dd665',
    'interactivevideo-468': 'e76d7faf1142cbb67e06f1531115d6dcfac35745d88584ddb331d486253de0ce',
    'interactivevideo-1200': '62c10cbbbda74c8b67e56bccb41d9be600a6866c40ca1c01e3482976f4f209b7',
  },
  // V542 + QUIZFB (builder 3.6.0 → 3.10.0: revisión del quiz D|I|C / notas O|C, retroalimentación global I|O|C con bandas «aprobaste / todavía no» + H5P de una sola copia) — los mismos dorados nuevos que
  // check-ev6-h5p2-contracts.js (diferencias contra staging verificadas archivo por archivo; ningún blob cambia).
  // #583 QUAL (builder 3.10.0 → 3.11.0) cambia el .mbz a propósito, y SOLO en esto (diff semántico por idnumber
  // contra origin/staging, scratchpad/r18/qual/golddiff/sem.js): reviewmaxmarks 69904 → 272 en cada quiz.xml; la frase
  // del cierre; el label cv3:shell:libro_card se va y su tarjeta es el <intro> del recurso del Libro Guía
  // (showdescription 1), con la renumeración de ids que eso trae; runtime VC 3 → 4 (esquina de la tabla sin «Aspecto»).
  // Dorados anteriores (3.10.0): h5p-final-light 6ce9ebb3…, scorm-nofinal-dark b7aeda95…, h5p-nofinal-dark-mock-cleansafe
  // ab93ce5b…, scorm-final-light 6619628e…, h5p-ev5c-rules1 c96fb4bb….
  // UX r18 (builder 3.11.0 → 3.12.0) cambia el .mbz a propósito, y SOLO en esto (diff semántico por idnumber contra
  // origin/staging, scratchpad/r18/uximpl-golddiff4.js): sección 0 con el hero primero y el foro al final (ids de la
  // sección 0 renumerados), sin kicker «Bienvenida» en el hero, <audio preload="metadata" title=…> (+ aria-label en ENHANCED; fix 1, M6), frame Info en
  // audiolibro.mp3, portadas a 1600 px (antes 640) y sin botón «Iniciar actividad» hacia la H5P embebida.
  // Dorados anteriores (3.11.0): h5p-final-light 03bb4e8b…, scorm-nofinal-dark 9500797e…, h5p-nofinal-dark-mock-cleansafe
  // 5329675d…, scorm-final-light 948e402d…, h5p-ev5c-rules1 4a1532f2….
  // r19 W (builder 3.12.0 → 3.13.0): SOLO cambia el label cv3:shell:welcome (hero con superficie según heroTreatment, «Curso · N módulos · M capítulos», entrada ≤ 40 palabras y cuerpo en párrafos ≤ 70) — diff por entrada del zip en scratchpad/r19/w-logs/golddiff (hook.js + diff.js).
  // Dorados anteriores (3.12.0): h5p-final-light 5e9bf0f0…, scorm-nofinal-dark b967577f…, h5p-nofinal-dark-mock-cleansafe
  // 14d45c9d…, scorm-final-light 6c18bcce…, h5p-ev5c-rules1 3c6d123e….
  mbz: {
    'h5p-final-light': 'e08b30ead92b6daecc5a1c86683b8971300cf9327d84b2927575f5fb1fda4b6f',
    'scorm-nofinal-dark': '27ddce40a5acbfbeac2b4776ba6e661d4f0955bfb676cffb4c1251ea38d61373',
    'h5p-nofinal-dark-mock-cleansafe': 'd959978f2a2847b0e817d940f029791f3fe2145e8ee0e232fda7d98fb9257401',
    'scorm-final-light': 'e18851b4b4c6ed7c00ddd5f9e7246cd2396f6e4f8777f6909192e9e2a09413c2',
    'h5p-ev5c-rules1': '04da54bf506ca3bde3eb1b1ce2af89ce618ed192917ba706e73db6c423bcfac0',
  },
};
/** Listas propias de rules 2 (CONGELADO: cambiar cualquiera = reglas 3). */
const RULES_V2_LISTS_SHA256 = '8cb1821e324ce2b6ed3c33a68996eac2605444eff9886851453176e7e11a494f';

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`);
  }
}
function assert(c, m) {
  if (!c) throw new Error(m);
}
function eq(a, e, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(e);
  if (x !== y) throw new Error(`${m}: esperado ${y.slice(0, 600)}, encontrado ${x.slice(0, 600)}`);
}
function throws(fn, re, m) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert(err, `${m}: no lanzó`);
  assert(!re || re.test(err.message), `${m}: mensaje inesperado: ${err.message}`);
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Blueprint v2 de un módulo con capítulos {objective} (todos con actividad, motor h5p). */
function bpWith(objs, { reviewCards = false, engine = 'h5p', moduleOrder = false } = {}) {
  const mods = [{ id: uuid(9001), position: 0, title: 'Módulo', objective: null, exam_enabled: false }];
  const chs = objs.map((o, i) => ({
    id: typeof o === 'object' && o.id ? o.id : uuid(100 + i),
    module_id: mods[0].id,
    position: moduleOrder ? objs.length - i : i,
    title: `Capítulo ${i + 1}`,
    objective: typeof o === 'object' ? o.objective : o,
    video_enabled: false,
    activity_enabled: true,
  }));
  return snap.buildBlueprintSnapshotV2({ id: 777, title: 'Curso', finalExam: false, activityEngine: engine, ...(reviewCards ? { reviewCards: true } : {}) }, mods, chs);
}
const typesOf = (m) => Object.fromEntries([...m.values()].map((d) => [d.chapterId, d.type]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
const SRC = (bp) => ({ courseId: 777, blueprintId: 1, blueprintNumber: 1, blueprintSha256: snap.snapshotSha256V2(bp) });

(async () => {
  // ══ 1. Reglas v2 ═══════════════════════════════════════════════════════════
  await check('reglas v2: listas congeladas (sha) y rules 1 intacto (sus sha siguen en check-v21-activity-type-rules)', () => {
    eq(RULES2.activityTypeRulesV2ListsSha256(), RULES_V2_LISTS_SHA256, 'sha listas v2');
    eq(RULES2.INTENT_TO_TYPE_V2, { recall: 'blanks', relate: 'dragtext', apply: 'questionset', reflect: 'questionset', understand: 'questionset', decide: 'branchingscenario' }, 'mapeo');
    for (const k of Object.keys(RULES1.INTENT_TO_TYPE_V1)) eq(RULES2.INTENT_TO_TYPE_V2[k], RULES1.INTENT_TO_TYPE_V1[k], `${k} igual que rules 1`);
  });
  await check('reglas v2: decide (verbos y frases) > apply; categorizar/secuenciar siguen en dragtext; «resolver»/«responder» solos no deciden', () => {
    const t = (s, o) => RULES2.classifyTextIntentV2(s, o);
    for (const s of ['Decidir cómo atender un reclamo', 'Elegir el proveedor adecuado', 'Priorizar pedidos urgentes', 'Negocia acuerdos con el cliente', 'Resolver conflictos con clientes', 'Responder ante una emergencia', 'Interviene en una crisis', 'Analizar datos y decidir el precio', 'decidió el comité'])
      eq(t(s), 'decide', s);
    eq(t('Resolver ejercicios de cálculo'), 'apply', 'resolver solo = apply (rules 1)');
    eq(t('Responder preguntas frecuentes'), null, 'responder solo');
    eq([t('Clasificar residuos'), t('Ordenar las etapas'), t('Identificar partes'), t('Explicar el proceso'), t('Diseñar estrategias')], ['relate', 'relate', 'recall', 'understand', 'apply'], 'resto = rules 1');
    eq([t('Taller sobre toma de decisiones', { nounsOnly: true }), t('Debes decidir rápido', { nounsOnly: true })], ['decide', null], 'descripción: solo frases');
    eq(RULES2.classifyChapterIntentV2({ objective: null, title: 'Capítulo uno', description: 'Una guía para la toma de decisiones' }), 'decide', 'cascada');
    eq(RULES2.classifyChapterIntentV2({ objective: null, title: 'Fundamentos', description: 'Una guía para la toma de decisiones' }), 'understand', 'el título clasifica primero (como rules 1)');
  });
  await check('reglas v2: tope de BS max(1, floor(n/4)); los que sobran bajan a questionset por fnv1a32 (independiente del orden)', () => {
    eq([0, 1, 3, 4, 7, 8, 12].map(RULES2.maxBranchingScenariosFor), [0, 1, 1, 1, 1, 2, 3], 'tope');
    const objs = ['Decidir A', 'Decidir B', 'Decidir C', 'Decidir D', 'Identificar partes', 'Clasificar tipos', 'Identificar piezas', 'Ordenar pasos'];
    const d = RULES2.chooseActivityTypesV2(bpWith(objs));
    const bs = [...d.values()].filter((x) => x.type === 'branchingscenario');
    eq(bs.length, 2, 'n=8 ⇒ 2 BS');
    const decideIds = [...d.values()].filter((x) => x.intent === 'decide').map((x) => x.chapterId);
    const kept = decideIds.slice().sort((a, b) => SHELL.fnv1a32(a.toLowerCase()) - SHELL.fnv1a32(b.toLowerCase()) || (a < b ? -1 : 1)).slice(0, 2);
    eq(bs.map((x) => x.chapterId).sort(), kept.sort(), 'quedan los de menor fnv1a32');
    eq([...d.values()].filter((x) => x.demoted).map((x) => x.type), ['questionset', 'questionset'], 'los demás bajan a questionset');
    eq(typesOf(RULES2.chooseActivityTypesV2(bpWith(objs, { moduleOrder: true }))), typesOf(d), 'mismo resultado con otro orden');
    eq(typesOf(RULES2.chooseActivityTypesV2(bpWith(objs))), typesOf(d), 'determinístico');
  });
  await check('reglas v2: balance de «escenario» (QS + BS) ≥ max(1, floor(n/3)); BS cuenta como escenario', () => {
    const d1 = RULES2.chooseActivityTypesV2(bpWith(['Decidir A', 'Identificar partes', 'Clasificar tipos']));
    eq([...d1.values()].map((x) => [x.type, x.promoted]), [['branchingscenario', false], ['blanks', false], ['dragtext', false]], 'n=3: 1 BS basta');
    const d2 = RULES2.chooseActivityTypesV2(bpWith(['Identificar partes', 'Clasificar tipos', 'Identificar piezas', 'Ordenar pasos', 'Identificar fases', 'Clasificar casos']));
    eq([...d2.values()].filter((x) => x.type === 'questionset').length, 2, 'n=6 sin escenario: se promueven 2 a questionset');
    eq(RULES2.chooseActivityTypesV2(bpWith(['Decidir A'], { engine: 'scorm' })).size, 0, 'scorm: sin tipos');
  });

  // ══ 2. Marcador del Manifest ═══════════════════════════════════════════════
  const bp2 = bpWith(['Decidir cómo atender un reclamo', 'Identificar partes', 'Clasificar tipos', 'Explicar el proceso']);
  const m2 = MB.buildGenerationManifestV3(bp2, SRC(bp2), { activityTypeRules: 2 });
  await check('Manifest rules 2: features {activityTypeRules: 2, ivAdvanced: 1}; h5pType branchingscenario; validador limpio; sha determinístico', () => {
    eq(m2.features, { finalExam: false, activityEngine: 'h5p', activityTypeRules: 2, ivAdvanced: 1 }, 'features');
    eq(m2.items.filter((i) => i.type === 'activity').map((i) => i.h5pType), ['branchingscenario', 'blanks', 'dragtext', 'questionset'], 'tipos');
    eq(MB.validateGenerationManifest(m2, bp2, SRC(bp2)), [], 'validador');
    eq(MB.manifestSha256(MB.buildGenerationManifestV3(clone(bp2), SRC(bp2), { activityTypeRules: 2 })), MB.manifestSha256(m2), 'sha');
    const codes = (m) => [...new Set(MB.validateGenerationManifest(m, bp2, SRC(bp2)).map((e) => e.code))].sort();
    const t1 = clone(m2); delete t1.features.ivAdvanced;
    eq(codes(t1), ['FEATURES_MISMATCH'], 'sin ivAdvanced');
    const t2 = clone(m2); t2.features.activityTypeRules = 1;
    assert(codes(t2).includes('WRONG_H5P_TYPE') && codes(t2).includes('FEATURES_MISMATCH'), `BS bajo marcador 1: ${codes(t2)}`);
    const t3 = clone(m2); t3.items.find((i) => i.h5pType === 'branchingscenario').h5pType = 'questionset';
    eq(codes(t3), ['WRONG_H5P_TYPE'], 'tipo cambiado');
    const m1 = MB.buildGenerationManifestV3(bp2, SRC(bp2), { activityTypeRules: 1 });
    const t4 = clone(m1); t4.features.ivAdvanced = 1;
    eq([...new Set(MB.validateGenerationManifest(t4, bp2, SRC(bp2)).map((e) => e.code))], ['FEATURES_MISMATCH'], 'ivAdvanced sin rules 2');
  });
  await check('gating: rules 0/1 nunca producen BS; resolveActivityType acepta branchingscenario SOLO con el marcador 2; config "2"', () => {
    for (const rules of [0, 1]) {
      const m = rules ? MB.buildGenerationManifestV3(bp2, SRC(bp2), { activityTypeRules: rules }) : MB.buildGenerationManifestV3(bp2, SRC(bp2));
      assert(!m.items.some((i) => i.h5pType === 'branchingscenario'), `rules ${rules} produjo BS`);
      assert(!('ivAdvanced' in m.features), `rules ${rules} con ivAdvanced`);
    }
    eq(MB.buildGenerationManifestV3(bp2, SRC(bp2), { activityTypeRules: 1 }).items.find((i) => i.type === 'activity').h5pType, 'questionset', 'decide bajo rules 1 = apply → questionset');
    const it = m2.items.find((i) => i.h5pType === 'branchingscenario');
    eq(SHELL.resolveActivityType(it, { activityTypeRules: 2 }), 'branchingscenario', 'con marcador 2');
    throws(() => SHELL.resolveActivityType(it), /ACTIVITY_TYPE_INVALID_MANIFEST/, 'sin marcador');
    throws(() => SHELL.resolveActivityType(it, { activityTypeRules: 1 }), /ACTIVITY_TYPE_INVALID_MANIFEST/, 'marcador 1');
    eq(CFG.readActivityTypeRulesConfig({ DYNAMIC_ACTIVITY_TYPE_RULES: '2' }), 2, 'config 2');
    eq(CFG.readActivityTypeRulesConfig({}), 0, 'default sigue 0');
  });

  // ══ 3. Blueprint «Repaso» ══════════════════════════════════════════════════
  await check('Blueprint: reviewCards solo entra al snapshot si es true (false/null/ausente ⇒ sha de siempre); round trip', () => {
    const base = bpWith(['Identificar partes']);
    for (const v of [false, null, undefined]) {
      const mods = [{ id: uuid(9001), position: 0, title: 'Módulo', objective: null, exam_enabled: false }];
      const chs = [{ id: uuid(100), module_id: mods[0].id, position: 0, title: 'Capítulo 1', objective: 'Identificar partes', video_enabled: false, activity_enabled: true }];
      const s = snap.buildBlueprintSnapshotV2({ id: 777, title: 'Curso', finalExam: false, activityEngine: 'h5p', ...(v !== undefined ? { reviewCards: v } : {}) }, mods, chs);
      eq(snap.snapshotSha256V2(s), snap.snapshotSha256V2(base), `reviewCards ${v}`);
    }
    const on = bpWith(['Identificar partes'], { reviewCards: true });
    eq(on.course.reviewCards, true, 'clave');
    eq(Object.keys(on.course), ['id', 'title', 'structureVersion', 'finalExam', 'activityEngine', 'reviewCards'], 'orden de claves');
    eq(snap.canonicalJsonV2(snap.recanonicalizeBlueprintSnapshotV2(JSON.parse(JSON.stringify(on)))), snap.canonicalJsonV2(on), 'round trip');
    assert(snap.snapshotSha256V2(on) !== snap.snapshotSha256V2(base), 'encendido cambia el sha');
    throws(() => snap.buildBlueprintSnapshotV2({ id: 1, title: 'x', finalExam: false, activityEngine: 'h5p', reviewCards: 'si' }, [], []), /course\.reviewCards debe ser boolean o null/, 'tipo inválido');
  });

  // ══ 4. Paquete completo con H5P v2 ═════════════════════════════════════════
  const V2CFG = { engine: 'h5p', finalExam: true, activityTypeRules: 2, reviewCards: true, chapterObjectives: ['Decidir cómo atender un reclamo', 'Escuchar al cliente', 'Identificar partes', 'Identificar partes'] };
  const input2 = PF.packagingInput(distRoot, V2CFG);
  const built2 = await B.buildDynamicMbzV3(input2);
  const z2 = await JSZip.loadAsync(built2.mbz);
  const filesXml = await z2.file('files.xml').async('string');
  const blobOf = async (dir, filearea) => {
    const inf = await z2.file(`${dir}/inforef.xml`).async('string');
    const ids = [...inf.matchAll(/<id>(\d+)<\/id>/g)].map((x) => x[1]);
    const b = [...filesXml.matchAll(/<file id="(\d+)">[\s\S]*?<\/file>/g)].find((x) => ids.includes(x[1]) && x[0].includes(`<filearea>${filearea}</filearea>`) && x[0].includes('<component>mod_h5pactivity</component>'));
    const hash = /<contenthash>([0-9a-f]+)<\/contenthash>/.exec(b[0])[1];
    return z2.file(`files/${hash.slice(0, 2)}/${hash}`).async('nodebuffer');
  };
  const mb = await z2.file('moodle_backup.xml').async('string');
  const acts = [];
  for (const m of mb.matchAll(/<activity>[\s\S]*?<moduleid>(\d+)<\/moduleid>[\s\S]*?<modulename>([a-z0-9]+)<\/modulename>[\s\S]*?<directory>([^<]+)<\/directory>[\s\S]*?<\/activity>/g)) {
    const mod = await z2.file(`${m[3]}/module.xml`).async('string');
    acts.push({ mid: Number(m[1]), modname: m[2], dir: m[3], idnumber: /<idnumber>([^<]*)<\/idnumber>/.exec(mod)[1], module: mod });
  }
  const chapters2 = input2.manifest.modules.flatMap((m) => m.chapters);
  await check('paquete v2: mbz-validator-v3 limpio; secuencia de secciones = Manifest + chapterSlotSequence (con «Repaso»)', async () => {
    const v = await V.validateMbzV3(built2.mbz, built2.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 6)));
    const want = PF.expectedSequence(distRoot, input2);
    const bySec = [];
    for (const a of acts) {
      const mod = a.module;
      const sec = Number(/<sectionnumber>(\d+)<\/sectionnumber>/.exec(mod)[1]);
      (bySec[sec] = bySec[sec] || []).push(a.idnumber);
    }
    eq(bySec.map((x, i) => [i, x]).filter((x) => x[1]), want, 'secuencia');
  });
  await check('paquete v2: la actividad BS lleva EXACTAMENTE las 19 carpetas delta; calificable (nota 100, aprobación del perfil, completion por nota)', async () => {
    const chBs = input2.manifest.items.find((i) => i.h5pType === 'branchingscenario').chapterId;
    const a = acts.find((x) => x.idnumber === `cv3:ch:${chBs}:activity`);
    const pkg = await JSZip.loadAsync(await blobOf(a.dir, 'package'));
    const tops = [...new Set(Object.keys(pkg.files).filter((n) => !pkg.files[n].dir && n !== 'h5p.json' && !n.startsWith('content/')).map((n) => n.split('/')[0]))].sort();
    eq(tops, h.profileDeltaDirs(h.CURSIA_H5P_PROFILE_V2, 'H5P.BranchingScenario'), 'delta');
    for (const d of tops) assert(pkg.file(`${d}/LICENSE.txt`) && /— MIT License/.test(await pkg.file(`${d}/LICENSE.txt`).async('string')), `${d}: aviso MIT (m-8)`);
    eq(JSON.parse(await pkg.file('h5p.json').async('string')).mainLibrary, 'H5P.BranchingScenario', 'principal');
    const grades = await z2.file(`${a.dir}/grades.xml`).async('string');
    assert(/<grademax>100\.00000<\/grademax>|<grademax>100<\/grademax>/.test(grades) && /<gradepass>70/.test(grades), 'grade item 100 / 70');
    assert(/<completion>2<\/completion>/.test(a.module) && /<completionpassgrade>1<\/completionpassgrade>/.test(a.module), 'completion por nota');
    eq(built2.summary.restore && built2.summary.restore.as, 'admin_or_manager', 'resumen: restaurar como administrador o gestor');
  });
  await check('paquete v2: «Repaso» Dialog Cards SIN nota — sin grade item, grade 0, sin tracking, completion por vista, fuera de los criterios del curso; texto «Repaso», nunca «calificable»', async () => {
    const reviews = acts.filter((x) => /:review_cards$/.test(x.idnumber));
    eq(reviews.length, chapters2.length, 'un «Repaso» por capítulo (la experiencia fixture trae ≥ 4 tarjetas)');
    eq(built2.expectations.facts.counts.reviewCards, chapters2.length, 'facts');
    const completion = await z2.file('completion.xml').async('string');
    const critMids = [...completion.matchAll(/<moduleinstance>(\d+)<\/moduleinstance>/g)].map((x) => Number(x[1]));
    for (const r of reviews) {
      eq(r.modname, 'h5pactivity', 'modname');
      const grades = await z2.file(`${r.dir}/grades.xml`).async('string');
      assert(!/<grade_item /.test(grades), `${r.idnumber}: con grade item`);
      const hx = await z2.file(`${r.dir}/h5pactivity.xml`).async('string');
      assert(/<grade>0<\/grade>/.test(hx) && /<enabletracking>0<\/enabletracking>/.test(hx), 'grade 0 / tracking 0');
      assert(/<completion>2<\/completion>/.test(r.module) && /<completionview>1<\/completionview>/.test(r.module) && /<completionpassgrade>0<\/completionpassgrade>/.test(r.module), 'completion por vista');
      assert(!critMids.includes(r.mid), `${r.idnumber} es criterio de completion del curso`);
      const pkg = await JSZip.loadAsync(await blobOf(r.dir, 'package'));
      eq(JSON.parse(await pkg.file('h5p.json').async('string')).mainLibrary, 'H5P.Dialogcards', 'Dialog Cards');
      eq([...new Set(Object.keys(pkg.files).filter((n) => !pkg.files[n].dir && n !== 'h5p.json' && !n.startsWith('content/')).map((n) => n.split('/')[0]))], ['H5P.Dialogcards-1.9'], 'delta DC');
      const intro = hx.match(/<intro>([\s\S]*?)<\/intro>/)[1];
      assert(/Repaso del capítulo/.test(intro) && !/calificab|nota de esta actividad/i.test(intro), 'texto del «Repaso»');
      const name = /<name>([^<]*)<\/name>/.exec(hx)[1];
      assert(/^Repaso · Capítulo \d+:/.test(name), `nombre ${name}`);
    }
    // Los ítems de nota del curso no cambian por los add-ons: mismas cantidades que facts.
    const graded = acts.filter((x) => /^cv3:ch:[^:]+:(activity|video)$/.test(x.idnumber) || /^cv3:exam:/.test(x.idnumber) || x.idnumber === 'cv3:final_exam');
    eq(graded.length, built2.expectations.facts.counts.activities + built2.expectations.facts.counts.videos + built2.expectations.facts.counts.exams + 1, 'ítems calificables');
  });
  await check('paquete v2: IV avanzado (schemaVersion 2) — pausas H5P.Text, remediación al inicio del tramo, H5P.Text declarado', async () => {
    const vid = acts.find((x) => /:video$/.test(x.idnumber));
    const pkg = await JSZip.loadAsync(await blobOf(vid.dir, 'package'));
    const hj = JSON.parse(await pkg.file('h5p.json').async('string'));
    assert(hj.preloadedDependencies.some((d) => d.machineName === 'H5P.Text'), 'H5P.Text en h5p.json');
    const c = JSON.parse(await pkg.file('content/content.json').async('string'));
    const ints = c.interactiveVideo.assets.interactions;
    const pauses = ints.filter((i) => i.action.library === 'H5P.Text 1.1');
    eq(pauses.length, h.planReflectionPauses(PF.VIDEO_SECONDS, h.planInteractionCheckpoints(PF.VIDEO_SECONDS)).reflections.length, 'pausas del plan');
    for (const q of ints.filter((i) => i.action.library !== 'H5P.Text 1.1')) {
      assert(Number.isInteger(q.adaptivity.wrong.seekTo) && q.adaptivity.wrong.seekTo < q.duration.from, 'seekTo antes de la pregunta');
      eq(q.adaptivity.wrong.seekLabel, 'Volver a ver este tramo', 'etiqueta');
    }
  });
  await check('paquete v2: bytes determinísticos (mismo input ⇒ mismo .mbz)', async () => {
    const again = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, V2CFG));
    eq(sha256(again.mbz), sha256(built2.mbz), 'sha');
  });
  await check('IV avanzado solo con el marcador: rules 2 sin «Repaso» ⇒ sin add-ons; rules 1 ⇒ schemaVersion 1 (sin H5P.Text)', async () => {
    const r = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { ...V2CFG, reviewCards: false }));
    assert(!r.summary.h5pPackages.some((p) => p.itemKey.startsWith('review_cards:')), 'sin «Repaso» sin el ajuste');
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 4)));
    const r1 = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { ...V2CFG, activityTypeRules: 1, reviewCards: false }));
    const zz = await JSZip.loadAsync(r1.mbz);
    for (const p of r1.summary.h5pPackages.filter((x) => x.mainLibrary === 'H5P.InteractiveVideo')) {
      const blob = await zz.file(`files/${p.sha1.slice(0, 2)}/${p.sha1}`).async('nodebuffer');
      const hj = JSON.parse(await (await JSZip.loadAsync(blob)).file('h5p.json').async('string'));
      assert(!hj.preloadedDependencies.some((d) => d.machineName === 'H5P.Text'), 'rules 1: sin H5P.Text');
    }
    // UX #5: la nota de restauración sale con cualquier paquete bundled del perfil v3 (desde 3.12.0 también QuestionSet 1.21).
    const bundled1 = r1.summary.h5pPackages.some((p) => p.mainLibrary in h.CURSIA_H5P_PROFILE_V3.deltaByMain);
    eq([!!r1.summary.restore, r1.summary.h5pPackages.some((p) => p.mainLibrary === 'H5P.Dialogcards' || p.mainLibrary === 'H5P.BranchingScenario')], [bundled1, false], 'rules 1: sin BS/DC; nota de restauración solo si hay QuestionSet 1.21');
  });

  await check('fix round 1 (I-2/M-4): «Repaso» SOLO con H5P v2 y motor h5p — reviewCards con rules 0/1 o motor SCORM ⇒ sin Dialog Cards, sin nota de restauración; facts lo rechaza', async () => {
    for (const cfg of [{ ...V2CFG, activityTypeRules: 1 }, { ...V2CFG, activityTypeRules: 0 }, { ...V2CFG, engine: 'scorm' }]) {
      const inp = PF.packagingInput(distRoot, cfg);
      eq(inp.blueprint.course.reviewCards, true, 'el Blueprint lo pide');
      eq(B.reviewCardsApply(inp.blueprint, inp.manifest), false, `apagado (${cfg.engine}, rules ${cfg.activityTypeRules})`);
      const r = await B.buildDynamicMbzV3(inp);
      assert(!r.summary.h5pPackages.some((p) => p.mainLibrary === 'H5P.Dialogcards'), `sin Dialog Cards (${cfg.engine}, rules ${cfg.activityTypeRules})`);
      assert(!r.expectations.facts.counts.reviewCards, 'facts sin «Repaso»');
      // UX #5: con QuestionSet 1.21 (bundled) la nota sí sale; sin BS/DC y sin QuestionSet, no.
      if (cfg.engine === 'h5p' && cfg.activityTypeRules !== 2) eq(!!r.summary.restore, r.summary.h5pPackages.some((p) => p.mainLibrary in h.CURSIA_H5P_PROFILE_V3.deltaByMain), 'nota de restauración solo con paquetes bundled');
      const v = await V.validateMbzV3(r.mbz, r.expectations);
      assert(v.ok, JSON.stringify(v.issues.slice(0, 3)));
    }
    eq(B.reviewCardsApply(input2.blueprint, input2.manifest), true, 'v2 + h5p + ajuste ⇒ encendido');
    const inp1 = PF.packagingInput(distRoot, { ...V2CFG, activityTypeRules: 1 });
    const f = built2.expectations.facts;
    throws(() => SHELL.buildCourseFacts({
      manifest: inp1.manifest, blueprint: inp1.blueprint, assessment: inp1.assessmentProfile,
      reviewCardsChapterIds: [f.chapters[0].id],
      artifacts: {
        audioWelcomeSeconds: 10, audiobookParts: f.chapters.map((c) => ({ chapterId: c.id, seconds: 10 })),
        slideCountByChapter: Object.fromEntries(f.chapters.map((c) => [c.id, 8])), examQuestionCountByModule: Object.fromEntries(f.modules.filter((m) => m.examEnabled).map((m) => [m.id, 8])),
        finalExamQuestionCount: 12, libroWordCount: 1000,
      },
    }), /solo con H5P v2 \(activityTypeRules=2\) y motor h5p/, 'facts con rules 1');
  });
  await check('fix round 1 (M-5/M-6): un capítulo con < 4 tarjetas no lleva «Repaso»; facts, secuencia y validador coherentes; el label de autoevaluación no repite «Repaso»', async () => {
    const VCF = require('./lib/v21-vc-fixtures');
    const inp = PF.packagingInput(distRoot, V2CFG);
    const chs = inp.manifest.modules.flatMap((m) => m.chapters);
    const few = VCF.buildExperience();
    few.chapterId = chs[1].chapterId;
    few.movements.deepening = few.movements.deepening.filter((c) => c.type !== 'concept_cards');
    eq(h.dialogCardsFromExperience(few).length, 2, 'fixture: 2 tarjetas');
    inp.contents.experiences.set(chs[1].chapterId, few);
    const r = await B.buildDynamicMbzV3(inp);
    const reviewKeys = r.summary.h5pPackages.filter((p) => p.itemKey.startsWith('review_cards:')).map((p) => p.itemKey.slice('review_cards:'.length));
    eq(reviewKeys.sort(), chs.filter((c, i) => i !== 1).map((c) => c.chapterId).sort(), '«Repaso» en todos menos el de 2 tarjetas');
    eq(r.expectations.facts.counts.reviewCards, chs.length - 1, 'facts');
    assert(!r.expectations.facts.chapters.find((c) => c.id === chs[1].chapterId).reviewCards, 'facts: el capítulo sin mazo');
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 3)));
    const z = await JSZip.loadAsync(r.mbz);
    const mbx = await z.file('moodle_backup.xml').async('string');
    const bySec = [];
    for (const m of mbx.matchAll(/<activity>[\s\S]*?<directory>([^<]+)<\/directory>[\s\S]*?<\/activity>/g)) {
      const mod = await z.file(`${m[1]}/module.xml`).async('string');
      (bySec[Number(/<sectionnumber>(\d+)<\/sectionnumber>/.exec(mod)[1])] = bySec[Number(/<sectionnumber>(\d+)<\/sectionnumber>/.exec(mod)[1])] || []).push(/<idnumber>([^<]*)<\/idnumber>/.exec(mod)[1]);
    }
    eq(bySec.map((x, i) => [i, x]).filter((x) => x[1]), PF.expectedSequence(distRoot, inp), 'secuencia');
    // M-6: capítulo sin actividad y con «Repaso»: el label del self_check se llama «Comprueba lo aprendido».
    const noAct = chs.find((c, i) => i !== 1 && !c.activityEnabled);
    const dir = [...mbx.matchAll(/<activity>[\s\S]*?<title>([^<]*)<\/title>[\s\S]*?<directory>([^<]+)<\/directory>[\s\S]*?<\/activity>/g)];
    const labels = [];
    for (const d of dir) {
      const mod = await z.file(`${d[2]}/module.xml`).async('string');
      if (/<idnumber>([^<]*)<\/idnumber>/.exec(mod)[1] === `cv3:ch:${noAct.chapterId}:self_check`) labels.push(d[1]);
    }
    eq(labels, [`Capítulo ${noAct.chapterNumber} · Comprueba lo aprendido`], 'nombre del label con «Repaso»');
  });

  await check('fix round 1 (M-1): scheduler — prevalidateV3 y claim con un Manifest rules 2 (BS) e ivAdvanced (video_interactions v2)', async () => {
    const { SchedulerService } = L('modules/dynamic-generation/scheduler.service.js');
    const VF = require('./lib/v21-video-fixture');
    const SFX = require('./lib/v21-shell-fixtures');
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const runId = '33333333-3333-4333-8333-333333333333';
    const chId = uuid(100);
    const bsItem = { key: `activity:${chId}`, type: 'activity', variant: 'h5p', chapterId: chId, h5pType: 'branchingscenario' };
    const viItem = { key: `video_interactions:${chId}`, type: 'video_interactions', chapterId: chId, chapterNumber: 1 };
    const DUR = 468;
    const videoRow = { video_item_run_id: 'vrun', output_summary: { youtubeVideoId: 'IdwOipZAeqY', durationSec: DUR }, metadata: {} };
    const mkSvc = (mItem, features, payload, type) => {
      const svc = Object.create(SchedulerService.prototype);
      svc.dataSource = {
        async query(sql) {
          if (/from public\.generation_item_runs d\b/.test(sql)) return [videoRow];
          if (/from public\.generation_item_runs g\b/.test(sql)) {
            return [{ id: runId, job_id: 'j', manifest_id: 1, item_key: mItem.key, type, status: 'running', worker_id: 'ex', chapter_id: chId,
              module_id: 'm', owner_id: OWNER, job_course_id: 1, frontend_course_id: 'fc', rules_version: 3,
              manifest_json: { rulesVersion: 3, features: { finalExam: false, activityEngine: 'h5p', ...features }, items: [mItem] } }];
          }
          if (/from public\.artifacts/.test(sql)) return [{ id: 'a1', type: type === 'activity' ? 'dynamic_h5p_params_json' : 'dynamic_video_interactions_json', storage_bucket: 'b', storage_path: 'p' }];
          throw new Error(`query inesperada ${sql.slice(0, 60)}`);
        },
      };
      svc.v3Reader = { readText: async () => JSON.stringify(payload) };
      return svc;
    };
    const bsPayload = SFX.h5pPayload('branchingscenario');
    const ok = await mkSvc(bsItem, { activityTypeRules: 2, ivAdvanced: 1 }, bsPayload, 'activity').prevalidateV3(runId, 'ex', ['a1'], OWNER, null);
    eq([ok.kind, ok.summary.activityType], ['valid', 'branchingscenario'], 'BS aceptado con marcador 2');
    let err = null;
    try {
      await mkSvc(bsItem, { activityTypeRules: 1 }, bsPayload, 'activity').prevalidateV3(runId, 'ex', ['a1'], OWNER, null);
    } catch (e) {
      err = e;
    }
    assert(err && /ACTIVITY_TYPE_INVALID_MANIFEST/.test(err.message), `marcador 1: ${err && err.message}`);
    const plan = h.planInteractionCheckpoints(DUR);
    const docV2 = VF.makeInteractionsDoc(plan, { videoItemKey: `video:${chId}`, durationSec: DUR });
    docV2.schemaVersion = 2;
    docV2.reflections = h.planReflectionPauses(DUR, plan).reflections.map((r) => ({ index: r.index, prompt: '¿Cómo lo aplicarías?' }));
    const v2ok = await mkSvc(viItem, { activityTypeRules: 2, ivAdvanced: 1 }, docV2, 'video_interactions').prevalidateV3(runId, 'ex', ['a1'], OWNER, null);
    assert(v2ok.kind === 'valid', JSON.stringify(v2ok)); eq(v2ok.summary.reflectionCount, 2, 'video_interactions v2 con ivAdvanced');
    const v2bad = await mkSvc(viItem, {}, docV2, 'video_interactions').prevalidateV3(runId, 'ex', ['a1'], OWNER, null);
    eq(v2bad.kind, 'invalid', 'v2 sin ivAdvanced se rechaza');
    const v1 = VF.makeInteractionsDoc(plan, { videoItemKey: `video:${chId}`, durationSec: DUR });
    eq((await mkSvc(viItem, {}, v1, 'video_interactions').prevalidateV3(runId, 'ex', ['a1'], OWNER, null)).summary, { interactionCount: plan.length }, 'v1 legacy igual que siempre');
    // Claim
    const svc = Object.create(SchedulerService.prototype);
    const manifest2 = { rulesVersion: 3, features: { activityTypeRules: 2, ivAdvanced: 1 }, modules: [], items: [] };
    eq(await svc.buildClaimV3({}, { type: 'activity', chapter_id: chId }, bsItem, manifest2), { validatedArtifactType: 'dynamic_h5p_params_json', activityType: 'branchingscenario', activityTypeSource: 'manifest', activityFeatures: { dragTextDistractors: true } }, 'claim BS');
    const writes = [];
    const qr = { async query(sql, params) { if (/update public\.generation_item_runs/.test(sql)) { writes.push(params); return []; } return [videoRow]; } };
    const claim = await svc.buildClaimV3(qr, { type: 'video_interactions', chapter_id: chId, id: 'run1', job_id: 'j', manifest_id: 1 }, viItem, manifest2);
    eq([claim.videoInteractionsSchemaVersion, claim.video.reflectionPlan.reflections.length], [2, 2], 'claim v2 con plan de pausas');
    const claim1 = await svc.buildClaimV3(qr, { type: 'video_interactions', chapter_id: chId, id: 'run1', job_id: 'j', manifest_id: 1 }, viItem, { rulesVersion: 3, features: {}, modules: [], items: [] });
    assert(!('videoInteractionsSchemaVersion' in claim1) && !('reflectionPlan' in claim1.video), 'claim legacy sin campos v2');
  });

  await check('fix round 2: getPackageStatus devuelve `restore` del job; reviewCardsAvailable = columna + h5p + reglas 2 (Manifest heredado o config)', async () => {
    const { PackagingService } = L('modules/dynamic-packaging/packaging.service.js');
    const pkg = (summary) => {
      const svc = Object.create(PackagingService.prototype);
      svc.manifestOfRun = async () => ({ rulesVersion: 3 });
      svc.loadRunRow = async () => ({});
      svc.findLatestPackageJob = async () => ({ worker_status: 'running', output_summary: summary });
      return svc.getPackageStatus(1, 'o', 1, 'r');
    };
    eq((await pkg({ restore: built2.summary.restore })).restore, { as: 'admin_or_manager', note: B.H5P_BUNDLED_RESTORE_NOTE.note }, 'con librerías incluidas');
    assert(!('restore' in (await pkg({}))), 'paquete de siempre: sin restore');
    assert(!('restore' in (await pkg({ restore: { as: 'otro', note: 'x' } }))), 'forma inesperada: se ignora');
    const { CourseStructureService } = L('modules/course-structure/course-structure.service.js');
    const cs = Object.create(CourseStructureService.prototype);
    const exec = (rows, fail = false) => ({ calls: 0, async query() { this.calls++; if (fail) throw new Error('relation does not exist'); return rows; } });
    const withEnv = async (v, fn) => {
      const saved = process.env.DYNAMIC_ACTIVITY_TYPE_RULES;
      if (v === undefined) delete process.env.DYNAMIC_ACTIVITY_TYPE_RULES; else process.env.DYNAMIC_ACTIVITY_TYPE_RULES = v;
      try { return await fn(); } finally { if (saved === undefined) delete process.env.DYNAMIC_ACTIVITY_TYPE_RULES; else process.env.DYNAMIC_ACTIVITY_TYPE_RULES = saved; }
    };
    const e0 = exec([]);
    eq(await withEnv('2', () => cs.reviewCardsAvailable(e0, 1, false, 'h5p')), false, 'sin columna');
    eq(await withEnv('2', () => cs.reviewCardsAvailable(e0, 1, true, 'scorm')), false, 'SCORM');
    eq(e0.calls, 0, 'sin columna / SCORM: sin consultar la base');
    eq(await withEnv(undefined, () => cs.reviewCardsAvailable(exec([{ activity_type_rules: 2 }]), 1, true, 'h5p')), true, 'Manifest heredado con reglas 2 (config sin definir)');
    eq(await withEnv('2', () => cs.reviewCardsAvailable(exec([{ activity_type_rules: 1 }]), 1, true, 'h5p')), false, 'Manifest heredado con reglas 1 (aunque la config sea 2)');
    eq(await withEnv('2', () => cs.reviewCardsAvailable(exec([{ activity_type_rules: null }]), 1, true, 'h5p')), false, 'Manifest legacy');
    eq(await withEnv('2', () => cs.reviewCardsAvailable(exec([]), 1, true, 'h5p')), true, 'curso sin Manifest v3: config 2');
    eq(await withEnv(undefined, () => cs.reviewCardsAvailable(exec([]), 1, true, 'h5p')), false, 'curso sin Manifest v3: config sin definir');
    eq(await withEnv('2', () => cs.reviewCardsAvailable(exec([], true), 1, true, 'h5p')), true, 'base sin tabla de Manifests: decide la config');
  });

  // ══ 5. Validador: negativos del add-on ═════════════════════════════════════
  await check('mbz-validator-v3: «Repaso» con ítem de nota, sin facts o «calificable» ⇒ ADDON; criterio de curso ⇒ COURSE_COMPLETION', async () => {
    const reviews = acts.filter((x) => /:review_cards$/.test(x.idnumber));
    const r0 = reviews[0];
    const mut = async (fn) => {
      const z = await JSZip.loadAsync(built2.mbz);
      await fn(z);
      return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    };
    let v = await V.validateMbzV3(await mut(async (z) => {
      const m = await z.file(`${r0.dir}/module.xml`).async('string');
      z.file(`${r0.dir}/module.xml`, m.replace('<completionview>1</completionview>', '<completionview>0</completionview>'));
    }), built2.expectations);
    assert(v.issues.some((i) => i.code === 'ADDON' && /completion/.test(i.message)), JSON.stringify(v.issues.slice(0, 3)));
    v = await V.validateMbzV3(await mut(async (z) => {
      const x = await z.file(`${r0.dir}/h5pactivity.xml`).async('string');
      z.file(`${r0.dir}/h5pactivity.xml`, x.replace('<grade>0</grade>', '<grade>100</grade>'));
    }), built2.expectations);
    assert(v.issues.some((i) => i.code === 'ADDON' && /grade 100/.test(i.message)), JSON.stringify(v.issues.slice(0, 3)));
    const facts = clone(built2.expectations.facts);
    facts.chapters.forEach((c) => delete c.reviewCards);
    delete facts.counts.reviewCards;
    v = await V.validateMbzV3(built2.mbz, { ...built2.expectations, facts });
    assert(v.issues.filter((i) => i.code === 'ADDON').length >= reviews.length + 1, 'facts sin «Repaso»');
    v = await V.validateMbzV3(await mut(async (z) => {
      const x = await z.file(`${r0.dir}/h5pactivity.xml`).async('string');
      z.file(`${r0.dir}/h5pactivity.xml`, x.replace('Repaso del capítulo', 'Práctica calificable del capítulo'));
    }), built2.expectations);
    assert(v.issues.some((i) => i.code === 'ADDON' && /calificable/.test(i.message)), 'texto calificable');
    v = await V.validateMbzV3(await mut(async (z) => {
      const c = await z.file('completion.xml').async('string');
      const first = /<course_completion_criteria id="\d+">[\s\S]*?<\/course_completion_criteria>/.exec(c)[0];
      z.file('completion.xml', c.replace(first, first + first.replace(/<moduleinstance>\d+<\/moduleinstance>/, `<moduleinstance>${r0.mid}</moduleinstance>`).replace(/id="\d+"/, 'id="99999"')));
    }), built2.expectations);
    assert(v.issues.some((i) => i.code === 'COURSE_COMPLETION'), 'add-on como criterio del curso');
  });
  await check('facts: «Repaso» sin el ajuste del Blueprint ⇒ FACTS_INVALID (nunca se agrega en silencio)', () => {
    const inp = PF.packagingInput(distRoot, { ...V2CFG, reviewCards: false });
    const f = built2.expectations.facts;
    throws(() => SHELL.buildCourseFacts({
      manifest: inp.manifest, blueprint: inp.blueprint, assessment: inp.assessmentProfile,
      reviewCardsChapterIds: [f.chapters[0].id],
      artifacts: {
        audioWelcomeSeconds: 10, audiobookParts: f.chapters.map((c) => ({ chapterId: c.id, seconds: 10 })),
        slideCountByChapter: Object.fromEntries(f.chapters.map((c) => [c.id, 8])), examQuestionCountByModule: Object.fromEntries(f.modules.filter((m) => m.examEnabled).map((m) => [m.id, 8])),
        finalExamQuestionCount: 12, libroWordCount: 1000,
      },
    }), /FACTS_INVALID: «Repaso» \(Dialog Cards\) sin el ajuste course\.reviewCards/, 'sin ajuste');
  });

  // ══ 6. Invalidación ════════════════════════════════════════════════════════
  const CTX = 'a'.repeat(64);
  const recordsOf = (manifest, tag) =>
    manifest.items.map((it) => ({
      itemKey: it.key, itemRunId: `${tag}#${it.key}`, status: 'completed',
      artifactIds: R.requiredArtifactTypesV3(it.type, it.variant).map((r) => `${tag}|${it.key}|${r}`), artifactStatus: 'ready',
      inputFingerprint: null, outputIdentity: `out/${tag}/${it.key}`,
    }));
  const planOf = (bpA, mA, bpB, mB) =>
    P.computeInvalidationPlan({
      from: { blueprint: bpA, manifest: mA, items: recordsOf(mA, 'A'), courseContextSha256: CTX },
      to: { blueprint: bpB, manifest: mB, courseContextSha256: CTX },
    });
  await check('invalidación: encender «Repaso» ⇒ todo REUSE (sin costo LLM; el empaque arma las tarjetas desde la experiencia reutilizada)', () => {
    const objs = ['Decidir cómo atender un reclamo', 'Identificar partes'];
    const a = bpWith(objs);
    const b = bpWith(objs, { reviewCards: true });
    const ma = MB.buildGenerationManifestV3(a, { ...SRC(a), blueprintNumber: 1 }, { activityTypeRules: 2 });
    const mbm = MB.buildGenerationManifestV3(b, { ...SRC(b), blueprintId: 2, blueprintNumber: 2 }, { activityTypeRules: 2 });
    const plan = planOf(a, ma, b, mbm);
    assert(plan.actions.every((x) => x.action === 'REUSE'), plan.actions.filter((x) => x.action !== 'REUSE').map((x) => `${x.itemKey}=${x.action}`).join(', '));
  });
  await check('invalidación (fix round 1, M-2): el tope de BS sube 1 → 2 al agregar un capítulo ⇒ SOLO la actividad que pasa a BS se regenera (activity_type_changed); el resto REUSE', () => {
    const objs7 = Array.from({ length: 7 }, (_, i) => ({ id: uuid(200 + i), objective: `Decidir el caso ${i + 1}` }));
    const a = bpWith(objs7);
    const b = bpWith([...objs7, { id: uuid(299), objective: 'Identificar partes' }]);
    const ma = MB.buildGenerationManifestV3(a, SRC(a), { activityTypeRules: 2 });
    const mb2 = MB.buildGenerationManifestV3(b, { ...SRC(b), blueprintId: 2, blueprintNumber: 2 }, { activityTypeRules: 2 });
    const bsOf = (m) => m.items.filter((i) => i.h5pType === 'branchingscenario').map((i) => i.chapterId).sort();
    eq([bsOf(ma).length, bsOf(mb2).length], [1, 2], 'tope 1 → 2');
    const flipped = bsOf(mb2).filter((id) => !bsOf(ma).includes(id));
    eq(flipped.length, 1, 'un capítulo pasa de questionset a BS');
    const plan = planOf(a, ma, b, mb2);
    const byKey = Object.fromEntries(plan.actions.map((x) => [x.itemKey, x]));
    const act = byKey[`activity:${flipped[0]}`];
    eq([act.action, act.reasons], ['REGENERATE', ['activity_type_changed']], 'la actividad que cambia de tipo');
    for (const o of objs7.filter((o) => o.id !== flipped[0])) eq(byKey[`activity:${o.id}`].action, 'REUSE', `activity:${o.id}`);
    for (const x of plan.actions) {
      if (x.itemKey === `activity:${flipped[0]}` || x.itemKey.endsWith(uuid(299))) continue;
      if (/^(module_intro|final_exam|exam|course_intro|course_plan|audio_welcome):/.test(x.itemKey)) continue;
      eq(x.action, 'REUSE', `${x.itemKey} (capítulo existente)`);
    }
  });

  // ══ 7. Golden legacy ═══════════════════════════════════════════════════════
  await check('golden: paquetes H5P y .mbz legacy (rules 0/1, sin «Repaso», schemaVersion 1) byte-idénticos al commit base', async () => {
    eq(await GOLD.legacyH5pShas(distRoot), GOLDEN.h5p, 'h5p');
    eq(await GOLD.legacyMbzShas(distRoot), GOLDEN.mbz, 'mbz');
  });

  // ══ 8. Library Pack v2 + preflight v2 ══════════════════════════════════════
  await check('Library Pack v2: contenido de instalación válido para BS y Dialog Cards; nombres v2; v1 sin cambios', () => {
    const bs = PACK.libraryPackSampleContent('H5P.BranchingScenario');
    eq([bs.mainLibrary, bs.maxScore], ['H5P.BranchingScenario', 10], 'BS');
    const dc = PACK.libraryPackSampleContent('H5P.Dialogcards');
    eq([dc.mainLibrary, dc.content.dialogs.length], ['H5P.Dialogcards', 4], 'DC');
    eq(PACK.libraryPackFileName(h.CURSIA_H5P_PROFILE_V2.mainLibraries['H5P.BranchingScenario'], 2), 'cursia-h5p-pack-v2-H5P.BranchingScenario-1.10.1.h5p', 'nombre v2');
    eq(PACK.libraryPackFileName(h.CURSIA_H5P_PROFILE_V1.mainLibraries['H5P.Blanks']), 'cursia-h5p-pack-v1-H5P.Blanks-1.14.37.h5p', 'nombre v1');
    const readme = fs.readFileSync(path.join(ROOT, 'src/package/h5p/README-library-pack.md'), 'utf8');
    assert(/Restaurar como administrador o gestor/.test(readme), 'README: restaurar como administrador o gestor');
  });
  await check('preflight v2: exige v1 + las 19 librerías delta; un sitio solo con v1 falla (missing) y con v2 completo pasa', () => {
    const P2 = h.CURSIA_H5P_PROFILE_V2;
    const v1Only = h.CURSIA_H5P_PROFILE_V1.libraries.map((r) => ({ ...r, enabled: 1 }));
    const r = h.h5pPreflight(P2, v1Only);
    eq([r.ok, r.missing.length], [false, 19], 'sitio v1');
    assert(h.h5pPreflight(P2, P2.libraries.map((x) => ({ ...x, enabled: 1 }))).ok, 'sitio v2');
    assert(h.h5pPreflight(h.CURSIA_H5P_PROFILE_V1, v1Only).ok, 'v1 sigue OK con v1');
  });

  console.log(`\n${passes} ok, ${failures} fallas`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
