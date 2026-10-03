#!/usr/bin/env node
/* eslint-disable */
// UX #5 (r18) — QuestionSet con navegación rotulada: checks PUROS (sin DB, sin red, sin Moodle, sin Chrome).
//
// Causa raíz: H5P.QuestionSet 1.20 registra «Pregunta siguiente/anterior» con label VACÍO (esperaba un
// icono CSS de JoubelUI); MultiChoice 1.16 / TrueFalse 1.8 (tema de H5P.Question 1.5) dibujan sus botones
// con H5P.Components y descartan esa clase → CTA azul sin texto ni icono junto a «Comprobar». Fix: el
// builder v3 arma H5P.QuestionSet 1.21 (CURSIA_H5P_PROFILE_V3), con su librería incluida en el .h5p.
//
//  1. Perfil v3: regenerado (fixture v1 + library.json del store v3) = JSON committed; v1 y v2 no cambian;
//     única diferencia con v2 = QuestionSet 1.20.29 → 1.21.13; delta de QuestionSet = su carpeta.
//  2. Store v3: manifest ↔ perfil; QuestionSet 1.21 MIT (library.json, github.com/h5p/h5p-question-set) con
//     sha256 por archivo; las 19 carpetas de v2, byte a byte iguales.
//  3. l10n: QuestionSet 1.20 (default) byte a byte igual al dorado legacy; v3 agrega SOLO texts.next /
//     texts.previous / endGame.scoreHeader / endGame.amountCorrect en español; cubre todos los textos de
//     interfaz con default inglés de la semantics 1.21 y no usa campos fuera de ella; mismos subContentId.
//  4. Paquete: el .h5p de QuestionSet 1.21 lleva EXACTAMENTE su carpeta delta (+ aviso MIT) y solo declara
//     librerías de v1 + esa delta; determinístico.
//  5. Builder v3 (3.12.0): cada actividad QuestionSet = 1.21 bundled; summary.restore (administrador o
//     gestor, pack v3); validateMbzV3 limpio; un QuestionSet 1.20 solo-contenido en su lugar → H5P_LIBRARIES.
//  6. Library Pack v3 / preflight v3: contenido de instalación con QuestionSet 1.21 rotulado; nombre
//     cursia-h5p-pack-v3-…; un sitio con solo v1 falla el preflight v3 (falta QuestionSet 1.21); con v3, OK.
//
// Uso (después de `npm run build`): node scripts/check-ux5-h5p-nav.js

const fs = require('fs');
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
const V = L('package/v3/mbz-validator-v3.js');
const B = L('package/dynamic-mbz-builder-v3.js');
const PF = require('./lib/v21-packaging-fixtures');
const SF = require('./lib/v21-shell-fixtures');
const GOLD = require('./lib/h5p2-golden-legacy');

const FIXTURE_V1 = path.join(ROOT, 'test/fixtures/h5p-profile-v1/libs');
const STORE_V2 = path.join(ROOT, 'assets/h5p-libs/v2');
const STORE_V3 = path.join(ROOT, 'assets/h5p-libs/v3');
const PJSON = (v) => path.join(ROOT, `src/package/h5p/cursia-h5p-profile.${v}.json`);
/** Huella del .h5p QuestionSet LEGACY (builder v1, CURSIA_H5P_PROFILE_V1) = GOLDEN.h5p.questionset de check-ev6-h5p2-contracts. */
const GOLDEN_QS_V1 = 'e9c32ce89c9d141d7b3e2e89370b136d831816c4e662cad005dd24222a9fa80a';
const QS_DIR = 'H5P.QuestionSet-1.21';

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
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const dirName = (r) => `${r.machineName}-${r.majorVersion}.${r.minorVersion}`;
function readLibraryJsons(...dirs) {
  const out = {};
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name, 'library.json');
      if (fs.existsSync(p)) out[name] = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }
  return out;
}

// Textos de interfaz (text/textarea con default no vacío) de una semantics, por ruta punteada (solo grupos).
function defaultTextPaths(fields, prefix, out) {
  for (const f of fields) {
    const p = prefix ? `${prefix}.${f.name}` : f.name;
    if (f.type === 'group' && f.fields) defaultTextPaths(f.fields, p, out);
    else if ((f.type === 'text' || f.type === 'textarea') && typeof f.default === 'string' && f.default !== '') out[p] = f.default;
  }
  return out;
}
// Claves del contenido que la semantics no conoce (lo que el filtro H5P de Moodle borraría). Recorre grupos.
function unknownKeys(fields, params, prefix, out) {
  const byName = new Map(fields.map((f) => [f.name, f]));
  for (const [k, v] of Object.entries(params || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    const f = byName.get(k);
    if (!f) out.push(p);
    else if (f.type === 'group' && f.fields && v && typeof v === 'object' && !Array.isArray(v)) unknownKeys(f.fields, v, p, out);
  }
  return out;
}
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

(async () => {
  const P1 = h.CURSIA_H5P_PROFILE_V1;
  const P2 = h.CURSIA_H5P_PROFILE_V2;
  const P3 = h.CURSIA_H5P_PROFILE_V3;

  // ══ 1. Perfil v3 ══════════════════════════════════════════════════════════
  await check('perfil v3: regenerado desde el fixture v1 + library.json del store v3 = cursia-h5p-profile.v3.json; v1 y v2 regenerados sin cambios', () => {
    const libs3 = readLibraryJsons(FIXTURE_V1, STORE_V3);
    eq(h.serializeH5pProfile(h.computeH5pProfile(libs3, h.CURSIA_H5P_PROFILE_SPEC_V3)), fs.readFileSync(PJSON('v3'), 'utf8'), 'v3');
    eq(h.serializeH5pProfile(h.computeH5pProfile(readLibraryJsons(FIXTURE_V1))), fs.readFileSync(PJSON('v1'), 'utf8'), 'v1');
    eq(h.serializeH5pProfile(h.computeH5pProfile(readLibraryJsons(FIXTURE_V1, STORE_V2), h.CURSIA_H5P_PROFILE_SPEC_V2)), fs.readFileSync(PJSON('v2'), 'utf8'), 'v2');
  });
  await check('perfil v3 = v2 con QuestionSet 1.20.29 → 1.21.13 (mismas principales, mismos sub-contenidos, base v1, h5pProfileVersionV3 = 3)', () => {
    eq([P3.profileId, P3.version, P3.baseProfileId, h.h5pProfileVersionV3], ['CURSIA_H5P_PROFILE_V3', 3, 'CURSIA_H5P_PROFILE_V1', 3], 'cabecera');
    eq(Object.keys(P3.mainLibraries), Object.keys(P2.mainLibraries), 'principales');
    for (const m of Object.keys(P2.mainLibraries)) {
      if (m === 'H5P.QuestionSet') continue;
      eq(P3.mainLibraries[m], P2.mainLibraries[m], m);
      eq(P3.closureByMain[m], P2.closureByMain[m], `clausura ${m}`);
    }
    eq(P2.mainLibraries['H5P.QuestionSet'], { machineName: 'H5P.QuestionSet', majorVersion: 1, minorVersion: 20, patchVersion: 29 }, 'QS v2');
    eq(P3.mainLibraries['H5P.QuestionSet'], { machineName: 'H5P.QuestionSet', majorVersion: 1, minorVersion: 21, patchVersion: 13 }, 'QS v3');
    eq(P3.contentLibrariesByMain, P2.contentLibrariesByMain, 'sub-contenidos');
    const k = (r) => `${dirName(r)}.${r.patchVersion}`;
    eq(P3.libraries.map(k).filter((x) => !P2.libraries.map(k).includes(x)), ['H5P.QuestionSet-1.21.13'], 'solo agrega QS 1.21');
    eq(P2.libraries.map(k).filter((x) => !P3.libraries.map(k).includes(x)), ['H5P.QuestionSet-1.20.29'], 'solo quita QS 1.20');
  });
  await check('perfil v3: delta de QuestionSet = [H5P.QuestionSet-1.21] (el resto de su clausura ya está en v1); BS y DC = las de v2', () => {
    eq(h.profileBundledMainLibraries(P3), ['H5P.BranchingScenario', 'H5P.Dialogcards', 'H5P.QuestionSet'], 'principales bundled');
    eq(h.profileDeltaDirs(P3, 'H5P.QuestionSet'), [QS_DIR], 'delta QS');
    eq(P3.deltaByMain['H5P.BranchingScenario'], P2.deltaByMain['H5P.BranchingScenario'], 'delta BS');
    eq(P3.deltaByMain['H5P.Dialogcards'], P2.deltaByMain['H5P.Dialogcards'], 'delta DC');
    const v1 = new Set(P1.libraries.map(dirName));
    eq(P3.closureByMain['H5P.QuestionSet'].full.map(dirName).filter((d) => !v1.has(d)), [QS_DIR], 'clausura full QS − v1');
  });

  // ══ 2. Store v3 ═══════════════════════════════════════════════════════════
  await check('store v3: manifest ↔ perfil v3; QuestionSet 1.21.13 MIT (library.json) de github.com/h5p/h5p-question-set con sha256 por archivo; las 19 carpetas de v2 iguales byte a byte', () => {
    const m = JSON.parse(fs.readFileSync(path.join(STORE_V3, 'manifest.json'), 'utf8'));
    eq([m.profileId, m.baseProfileId, m.profileSha256], ['CURSIA_H5P_PROFILE_V3', 'CURSIA_H5P_PROFILE_V1', sha256(fs.readFileSync(PJSON('v3')))], 'cabecera');
    eq(Object.keys(m.deltaByMain).sort(), ['H5P.BranchingScenario', 'H5P.Dialogcards', 'H5P.QuestionSet'], 'deltaByMain');
    const qs = m.libraries.find((l) => l.dir === QS_DIR);
    eq([qs.upstreamVersion, qs.licence, qs.licenceSource, qs.libraryJsonLicense, qs.repoUrl], ['1.21.13', 'MIT', 'library.json', 'MIT', 'https://github.com/h5p/h5p-question-set'], 'procedencia QS');
    // Fix round 1 (M-1): sin tag upstream → commit oficial exacto (48aa08f798, «bump patch 1.21.13») en manifest y LICENSES.md.
    eq([qs.upstreamCommit, qs.upstreamCommitUrl], ['48aa08f798c016a0bb9096804a6cf45fb890d3f7', 'https://github.com/h5p/h5p-question-set/commit/48aa08f798c016a0bb9096804a6cf45fb890d3f7'], 'commit upstream QS');
    assert(/sin tag/.test(qs.upstreamNote), 'nota «sin tag»');
    assert(fs.readFileSync(path.join(STORE_V3, 'LICENSES.md'), 'utf8').includes('https://github.com/h5p/h5p-question-set/commit/48aa08f798c016a0bb9096804a6cf45fb890d3f7'), 'LICENSES.md con el commit');
    for (const f of qs.files) {
      const b = fs.readFileSync(path.join(STORE_V3, QS_DIR, f.path));
      assert(b.length === f.bytes && sha256(b) === f.sha256, `${f.path} sha256`);
    }
    const m2 = JSON.parse(fs.readFileSync(path.join(STORE_V2, 'manifest.json'), 'utf8'));
    eq(m.libraries.filter((l) => l.dir !== QS_DIR), m2.libraries, 'las 19 de v2 (lista de archivos + sha256)');
    const store = h.openH5pLibraryStore(P3);
    assert(store.libraryFiles(QS_DIR)['library.json'], 'libraryFiles QS');
    assert(/H5P\.QuestionSet 1\.21\.13 — MIT License/.test(store.licenseNotice(QS_DIR)), 'aviso MIT');
    eq(h.h5pLibraryStoreDir(P3), STORE_V3, 'carpeta del store v3');
    eq(h.h5pLibraryStoreDir(P2), STORE_V2, 'carpeta del store v2');
  });

  // ══ 3. l10n ═══════════════════════════════════════════════════════════════
  const qsInput = () => {
    const p = SF.h5pPayload('questionset');
    return { ...p.data, itemKey: 'activity:golden-questionset', passPercentage: 70 };
  };
  const qs1 = h.buildQuestionSet(qsInput());
  const qs3 = h.buildQuestionSet(qsInput(), { profile: P3 });
  const sem121 = JSON.parse(fs.readFileSync(path.join(STORE_V3, QS_DIR, 'semantics.json'), 'utf8'));
  await check('l10n: QuestionSet 1.20 (default, perfil v1) byte a byte igual al dorado legacy y sin claves de 1.21', async () => {
    const buf = await h.buildContentOnlyH5p({ mainLibrary: qs1.mainLibrary, content: qs1.content, title: qs1.title, language: 'es' });
    eq(sha256(buf), GOLDEN_QS_V1, 'sha256 legacy');
    assert(!('next' in qs1.content.texts) && !('previous' in qs1.content.texts) && !('scoreHeader' in qs1.content.endGame), 'claves de 1.21 en 1.20');
    eq(h.h5pL10nTable('H5P.QuestionSet'), { ...h.H5P_L10N_ES419['H5P.QuestionSet'] }, 'tabla sin versión = base');
  });
  await check('l10n: QuestionSet 1.21 agrega SOLO «Siguiente» / «Anterior» / «Puntaje» / «@finals de @totals correctas»; mismos subContentId y preguntas', () => {
    eq([qs3.content.texts.next, qs3.content.texts.previous, qs3.content.endGame.scoreHeader, qs3.content.endGame.amountCorrect], ['Siguiente', 'Anterior', 'Puntaje', '@finals de @totals correctas'], 'textos nuevos');
    const strip = (c) => {
      const x = JSON.parse(JSON.stringify(c));
      delete x.texts.next;
      delete x.texts.previous;
      delete x.endGame.scoreHeader;
      delete x.endGame.amountCorrect;
      return x;
    };
    eq(strip(qs3.content), qs1.content, 'resto del contenido idéntico');
    eq(qs3.subContentIds, qs1.subContentIds, 'subContentId');
  });
  await check('l10n: la salida de QuestionSet 1.21 cubre TODOS los textos de interfaz con default inglés de su semantics, conserva placeholders y no usa campos fuera de ella', () => {
    const defaults = defaultTextPaths(sem121, '', {});
    const problems = [];
    const ph = (s) => (String(s).match(/(@[a-zA-Z]+|:[a-zA-Z]+|%[a-zA-Z]+|%d)/g) || []).sort().join(',');
    for (const [p, en] of Object.entries(defaults)) {
      const v = getPath(qs3.content, p);
      if (typeof v !== 'string' || !v.trim()) problems.push(`${p}: sin valor ("${en}")`);
      else if (v === en) problems.push(`${p}: quedó el default inglés`);
      else if (ph(v) !== ph(en)) problems.push(`${p}: placeholders ${ph(en)} ≠ ${ph(v)}`);
    }
    const unknown = unknownKeys(sem121, qs3.content, '', []);
    eq(problems, [], 'textos');
    eq(unknown, [], 'claves fuera de la semantics 1.21');
    assert(Object.keys(defaults).includes('texts.next') && Object.keys(defaults).includes('endGame.amountCorrect'), 'la semantics 1.21 trae las claves nuevas');
  });

  // ══ 4. Paquete ════════════════════════════════════════════════════════════
  const store3 = h.openH5pLibraryStore(P3);
  const bundleQs = (built) => h.buildBundledH5p({ mainLibrary: built.mainLibrary, content: built.content, title: built.title, language: 'es', profile: P3, libraryStore: store3 });
  const qsPkg = await bundleQs(qs3);
  await check('paquete QuestionSet 1.21: h5p.json + content + EXACTAMENTE H5P.QuestionSet-1.21 (archivos del store + LICENSE.txt); dependencias = v1 ∪ delta; determinístico', async () => {
    const z = await JSZip.loadAsync(qsPkg);
    const names = Object.keys(z.files).filter((n) => !z.files[n].dir);
    eq([...new Set(names.filter((n) => n !== 'h5p.json' && !n.startsWith('content/')).map((n) => n.split('/')[0]))], [QS_DIR], 'carpetas');
    const want = [...store3.manifest.libraries.find((l) => l.dir === QS_DIR).files.map((f) => f.path), 'LICENSE.txt'].sort();
    eq(names.filter((n) => n.startsWith(`${QS_DIR}/`)).map((n) => n.slice(QS_DIR.length + 1)).sort(), want, 'archivos');
    const hj = JSON.parse(await z.file('h5p.json').async('string'));
    eq([hj.mainLibrary, dirName(hj.preloadedDependencies[0])], ['H5P.QuestionSet', QS_DIR], 'principal');
    const v1 = new Set(P1.libraries.map(dirName));
    eq(hj.preloadedDependencies.map(dirName).filter((d) => !v1.has(d)), [QS_DIR], 'deps fuera de v1');
    eq(sha256(await bundleQs(h.buildQuestionSet(qsInput(), { profile: P3 }))), sha256(qsPkg), 'determinístico');
  });

  // ══ 5. Builder v3 + validador ═════════════════════════════════════════════
  const cfg = GOLD.MBZ_CONFIGS[0]; // h5p-final-light
  const built = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, cfg));
  await check('builder v3 ≥ 3.12.0: toda actividad QuestionSet es 1.21 con su delta; DragText/Blanks siguen content-only; summary.restore = administrador o gestor (pack v3); summary.h5pProfileVersion = 3', async () => {
    eq(B.DYNAMIC_MBZ_BUILDER_VERSION_V3, '3.13.0', 'versión'); // r19 W: 3.12.0 → 3.13.0 (solo la bienvenida)
    const z = await JSZip.loadAsync(built.mbz);
    const fx = await z.file('files.xml').async('string');
    const qsPkgs = built.summary.h5pPackages.filter((p) => p.mainLibrary === 'H5P.QuestionSet');
    assert(qsPkgs.length > 0, 'el fixture no trae QuestionSet');
    for (const p of built.summary.h5pPackages.filter((x) => x.itemKey.startsWith('activity:'))) {
      const blob = await z.file(`files/${p.sha1.slice(0, 2)}/${p.sha1}`).async('nodebuffer');
      const hz = await JSZip.loadAsync(blob);
      const tops = [...new Set(Object.keys(hz.files).filter((n) => !hz.files[n].dir && n !== 'h5p.json' && !n.startsWith('content/')).map((n) => n.split('/')[0]))];
      const hj = JSON.parse(await hz.file('h5p.json').async('string'));
      if (p.mainLibrary === 'H5P.QuestionSet') {
        eq([dirName(hj.preloadedDependencies[0]), tops], [QS_DIR, [QS_DIR]], `${p.itemKey}`);
        const c = JSON.parse(await hz.file('content/content.json').async('string'));
        eq([c.texts.next, c.texts.previous], ['Siguiente', 'Anterior'], `${p.itemKey} rótulos`);
      } else eq(tops, [], `${p.itemKey} (${p.mainLibrary}) content-only`);
    }
    assert(fx.length > 0, 'files.xml');
    eq(built.summary.restore && built.summary.restore.as, 'admin_or_manager', 'restore');
    // Fix round 1 (M-8): summary.h5pProfileVersion = perfil real (3 con QuestionSet 1.21); un curso SCORM sin H5P bundled = 1.
    eq(built.summary.h5pProfileVersion, 3, 'summary.h5pProfileVersion con QS 1.21');
    const scorm = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, GOLD.MBZ_CONFIGS.find((c) => c.engine === 'scorm')));
    eq([scorm.summary.h5pProfileVersion, !!scorm.summary.restore], [scorm.summary.h5pPackages.some((p) => p.mainLibrary in P3.deltaByMain) ? 3 : 1, scorm.summary.h5pPackages.some((p) => p.mainLibrary in P3.deltaByMain)], 'summary sin bundled');
    eq(B.summaryH5pProfileVersion([{ mainLibrary: 'H5P.DragText' }]), 1, 'solo-contenido = 1');
    eq(B.H5P_V2_RESTORE_NOTE, B.H5P_BUNDLED_RESTORE_NOTE, 'alias histórico');
    assert(/Library Pack v3/.test(built.summary.restore.note), built.summary.restore.note);
  });
  await check('validateMbzV3: el .mbz con QuestionSet 1.21 bundled queda limpio; un QuestionSet 1.20 solo-contenido en su lugar → H5P_LIBRARIES (falta la carpeta delta)', async () => {
    const v = await V.validateMbzV3(built.mbz, built.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 5)));
    const z = await JSZip.loadAsync(built.mbz);
    const p = built.summary.h5pPackages.find((x) => x.mainLibrary === 'H5P.QuestionSet');
    const legacy = await h.buildContentOnlyH5p({ mainLibrary: 'H5P.QuestionSet', content: qs1.content, title: qs1.title, language: 'es' });
    const newHash = crypto.createHash('sha1').update(legacy).digest('hex');
    const fx = (await z.file('files.xml').async('string')).split(p.sha1).join(newHash).replace(new RegExp(`(<contenthash>${newHash}</contenthash>[\\s\\S]*?<filesize>)\\d+(</filesize>)`), `$1${legacy.length}$2`);
    z.file('files.xml', fx);
    z.remove(`files/${p.sha1.slice(0, 2)}/${p.sha1}`);
    z.file(`files/${newHash.slice(0, 2)}/${newHash}`, legacy);
    const v2 = await V.validateMbzV3(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), built.expectations);
    const msgs = v2.issues.filter((i) => i.code === 'H5P_LIBRARIES').map((i) => i.message);
    assert(msgs.some((m) => /faltan carpetas de librería del delta del perfil: H5P\.QuestionSet-1\.21/.test(m)), JSON.stringify(v2.issues.slice(0, 5)));
  });

  // ══ 6. Library Pack v3 + preflight v3 ═════════════════════════════════════
  await check('Library Pack v3: QuestionSet 1.21 rotulado en el contenido de instalación; nombre cursia-h5p-pack-v3-H5P.QuestionSet-1.21.13.h5p; pack v1 igual', () => {
    const s3 = h.libraryPackSampleContent('H5P.QuestionSet', P3);
    eq([s3.content.texts.next, s3.content.texts.previous], ['Siguiente', 'Anterior'], 'rótulos');
    const s1 = h.libraryPackSampleContent('H5P.QuestionSet');
    assert(!('next' in s1.content.texts), 'pack v1 sin claves de 1.21');
    eq(h.libraryPackFileName(P3.mainLibraries['H5P.QuestionSet'], P3.version), 'cursia-h5p-pack-v3-H5P.QuestionSet-1.21.13.h5p', 'nombre');
  });
  await check('preflight v3: un sitio con solo el pack v1 (o v2) falla (falta H5P.QuestionSet-1.21); con las librerías de v3 pasa', () => {
    const r1 = h.h5pPreflight(P3, P1.libraries.map((r) => ({ ...r })));
    assert(!r1.ok && r1.missing.some((x) => dirName(x) === QS_DIR), 'v1 debería fallar por QS 1.21');
    const r2 = h.h5pPreflight(P3, P2.libraries.map((r) => ({ ...r })));
    eq(r2.missing.map(dirName), [QS_DIR], 'v2: solo falta QS 1.21');
    assert(h.h5pPreflight(P3, P3.libraries.map((r) => ({ ...r }))).ok, 'v3 debería pasar');
  });

  console.log('');
  if (failures) {
    console.error(`❌ check-ux5-h5p-nav: ${failures} fallo(s), ${passes} ok.`);
    process.exit(1);
  }
  console.log(`✅ check-ux5-h5p-nav: ${passes} ok.`);
})().catch((e) => {
  console.error(`❌ error inesperado: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
