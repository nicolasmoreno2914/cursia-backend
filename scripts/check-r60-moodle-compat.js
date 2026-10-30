#!/usr/bin/env node
/* eslint-disable no-console */
// r60 (D1/D2) — compatibilidad REAL del paquete v3 con Moodle 4.1–4.5. Offline, determinístico, USD 0.
//   1. Tablas: API H5P del núcleo por versión (4.1 = 1.24 … 4.5 = 1.28) y token de sección solo desde 4.4.
//   2. cursia-h5p-core-api.json al día con las library.json que el repo versiona y con los perfiles (h5p-libs local: extra o SKIP).
//   3. Requisito H5P: cada principal de los perfiles v1/v2/v3 exige 1.28 → Moodle 4.5 (D1, documentado).
//   4. Paquetes de la simulación comercial: con H5P → minimumMoodle 4.5 y .mbz BYTE A BYTE igual a 3.15.1 (dorados);
//      sin H5P → minimumMoodle 4.1 y botones a secciones $@COURSEVIEWBYID*1@$&section=n (sin COURSESECTIONBYID).
//   5. Validador: MOODLE_COMPAT ante un mínimo declarado menor que el real (H5P o token 4.4+), COURSEVIEWBYID mal
//      apuntado, sección inexistente; sin declaración (expectativas viejas) no aplica.
//   6. Sanitizador del builder (assertTokensV3) consciente de la versión.
// Uso (después de npm run build): node scripts/check-r60-moodle-compat.js [--all]  (--all = los 17 dorados)
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const ROOT = path.resolve(__dirname, '..');
const dist = path.join(ROOT, 'dist');
const JSZip = require('jszip');
const MC = require(path.join(dist, 'package/v3/moodle-compat'));
const B = require(path.join(dist, 'package/dynamic-mbz-builder-v3'));
const VAL = require(path.join(dist, 'package/v3/mbz-validator-v3'));
const H = require(path.join(dist, 'package/h5p'));
const S = require('./lib/commercial-simulation');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/commercial-simulation/courses.json'), 'utf8'));

// sha256 de los .mbz de la simulación con el builder 3.15.1 (origin/staging 17dc7b0, r60): con H5P el paquete no cambia.
// r77 (builder 3.17.0, mobile-first): multi-h5p, 1x1-sin-examenes y 1x1-sin-nota recalculados a propósito — solo cambian los
// estilos de los botones (la píldora es el <a>) y de los enlaces de descarga; mismo texto, enlaces y archivos (diff por zip).
// r78 (builder 3.18.0, Libro Guía en el celular): los 17 recalculados a propósito (--all) — la sección 1 suma el libro en línea
// (mod_book, mismo texto del PDF) y la tarjeta del Libro su botón «Leer en el celular»; los moduleid siguientes corren uno.
// Mismos archivos de contenido (PDF del Libro byte a byte); el resto de los HTML igual salvo el id de los tokens (check-r78 B6).
const GOLDEN_3_15_1 = {
  'A-S': '875b5481e9c8e4ec7d0d741b181e26781d32c30984a3c88e74c91ed2a2b41910',
  'B-M': '0f992b9ab8ad18e9ac296b18413c7788f843d0d53d5dff0b2d712c3085e9ca8f',
  'C-L': 'e0e80ccac75b20ce8df9bc988a51528fa64cb72e388b55edfa5e36873abf5d93',
  procedimental: 'f4170cf6f8cb998b4015dafd5905221415b0f76334b019d244c7d4e1b3b8cd03',
  conceptual: '6d2899df4bc410c116d8922a7e5dc0d87724bcfc2c4f4ec0d54dce86137853d5',
  normativo: '128a709bfdbfede5e683880d3c65f34f2fde5a6c299d95001f57a138075ddf64',
  ofimatica: '0ef527ebf28535e47de8399efc63176090762c2be6435724977dfa137714a1f4',
  gagne: 'cd2a0a5abb3c9181930fc02021fb6b799d7bc3dfd315c7ff7f154ad04cf21133',
  'entrega-rubrica': '28ac6555ebf1eb35b486337977224b0081f0f85d5252f1ed5e60c5a21c2a59aa',
  'multi-h5p': '1379908f38919080cb5979cd3e97cf10168b6b1855c090d18b222c128a4703a6',
  'teorico-16': 'ff0a63eba74d1208e6eef4ba76488decfc85eca93db9695978dc15552efc2a94',
  'practico-32': '4e152df5d314026bccc103a0cbe72925cd0c6c8eace8de9c9c38c8ad677151d7',
  'protocolo-20': '752ef837caf39dda0a711dc5fd56640a0764dd0d0ed44cd598c45eb79a5b4492',
  'casos-64': '7088f758ca61bd71cdc791d543b85fbfd85e0204a3afcbb2c93d27c38c8876e2',
  'mixto-96': 'bf632cd5e6e3f75b4a4893f583507dadfe9d9f3b656e387a18c0d96f6a371f22',
  '1x1-sin-examenes': '8f05fdc19c961d44eea24b44f441aed2899c98f0342bc7c3566ec18ba2796881',
  '1x1-sin-nota': '248e41b9d498b977f9c30277fe0776a153a831431896927c68b8dc4b5c8ce175',
};
const QUICK = ['multi-h5p', '1x1-sin-examenes', '1x1-sin-nota'];
const ALL = process.argv.includes('--all');

let passed = 0;
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n   ') : err}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: ${x} ≠ ${y}`); };
const throws = (fn, re, m) => { try { fn(); } catch (e) { if (re.test(String(e.message))) return; throw new Error(`${m}: error inesperado ${e.message}`); } throw new Error(`${m}: no lanzó`); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const codes = (v) => v.issues.map((i) => i.code);
async function mutate(mbz, fn) {
  const zip = await JSZip.loadAsync(mbz);
  for (const name of Object.keys(zip.files)) {
    if (!/^activities\/label_\d+\/label\.xml$/.test(name)) continue;
    const x = await zip.file(name).async('string');
    const y = fn(x, name);
    if (y !== x) zip.file(name, y);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
async function labelXmls(mbz) {
  const zip = await JSZip.loadAsync(mbz);
  const out = {};
  for (const name of Object.keys(zip.files)) if (/^activities\/label_\d+\/label\.xml$/.test(name)) out[name] = await zip.file(name).async('string');
  return out;
}

(async () => {
  // ── 1. Tablas ──
  await check('tablas: API H5P por versión de Moodle y token de sección desde 4.4', async () => {
    eq(MC.MOODLE_COMPAT_VERSIONS, ['4.1', '4.2', '4.3', '4.4', '4.5'], 'versiones');
    eq(MC.MOODLE_H5P_CORE_API, { '4.1': '1.24', '4.2': '1.26', '4.3': '1.27', '4.4': '1.27', '4.5': '1.28' }, 'API H5P');
    eq(MC.MOODLE_TOKEN_MIN_VERSION, { COURSESECTIONBYID: '4.4' }, 'tokens');
    eq(['1.24', '1.26', '1.27', '1.28', '1.29', null].map(MC.minimumMoodleForH5pCoreApi), ['4.1', '4.2', '4.3', '4.5', null, '4.1'], 'piso por coreApi');
    assert(MC.compareMajorMinor('4.10', '4.5') > 0 && MC.compareMajorMinor('4.4', '4.4') === 0, 'compareMajorMinor numérico');
    assert(!MC.sectionTokenSupported('4.3') && MC.sectionTokenSupported('4.4') && MC.sectionTokenSupported('4.5'), 'sectionTokenSupported');
  });

  // Fuente: el núcleo de cada Moodle local (si existe) declara esa API (h5p/h5plib/vNNN/joubel/core/h5p.classes.php).
  const MV = path.join(os.homedir(), 'cursia-test-env/moodle-versions');
  if (fs.existsSync(MV)) {
    await check('tablas = $coreApi de h5plib en los Moodle locales 4.1–4.5', async () => {
      for (const v of MC.MOODLE_COMPAT_VERSIONS) {
        const src = path.join(MV, `m40${v.split('.')[1]}/source/h5p/h5plib`);
        if (!fs.existsSync(src)) continue;
        const lib = fs.readdirSync(src).filter((d) => /^v\d+$/.test(d)).sort().pop();
        const php = fs.readFileSync(path.join(src, lib, 'joubel/core/h5p.classes.php'), 'utf8');
        const m = /public static \$coreApi = array\(\s*'majorVersion' => (\d+),\s*'minorVersion' => (\d+)/.exec(php);
        assert(m, `${v}: sin $coreApi`);
        eq(`${m[1]}.${m[2]}`, MC.MOODLE_H5P_CORE_API[v], `Moodle ${v} (${lib})`);
      }
    });
    await check('tablas = reglas de decodificación de restore_course_task en 4.1–4.5', async () => {
      for (const v of MC.MOODLE_COMPAT_VERSIONS) {
        const f = path.join(MV, `m40${v.split('.')[1]}/source/backup/moodle2/restore_course_task.class.php`);
        if (!fs.existsSync(f)) continue;
        const php = fs.readFileSync(f, 'utf8');
        assert(/restore_decode_rule\('COURSEVIEWBYID'/.test(php), `${v}: sin COURSEVIEWBYID`);
        eq(/restore_decode_rule\('COURSESECTIONBYID'/.test(php), MC.compareMajorMinor(v, '4.4') >= 0, `${v}: COURSESECTIONBYID`);
      }
    });
  }

  // ── 2. Tabla de coreApi ──
  const LIBS = path.join(os.homedir(), 'cursia-test-env/h5p-libs');
  // Review r60 (I2): siempre con lo que el repo versiona (stores + fixture v1 = las 76 library.json), sin depender del entorno.
  await check('cursia-h5p-core-api.json = library.json versionadas en el repo (generate-h5p-core-api.js --check) y = perfiles v1/v2/v3', async () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'generate-h5p-core-api.js'), '--check'], { encoding: 'utf8' });
    assert(r.status === 0, r.stderr || r.stdout);
    eq(MC.coreApiTableMismatches(), [], 'tabla vs perfiles (machineName major.minor + patch)');
  });
  if (fs.existsSync(LIBS)) {
    await check('cursia-h5p-core-api.json = ~/cursia-test-env/h5p-libs (fuente completa del pack)', async () => {
      const r = spawnSync(process.execPath, [path.join(__dirname, 'generate-h5p-core-api.js'), LIBS, '--check'], { encoding: 'utf8' });
      assert(r.status === 0, r.stderr || r.stdout);
    });
  } else {
    console.log('⏭️  SKIP cursia-h5p-core-api.json vs ~/cursia-test-env/h5p-libs: carpeta ausente (no cuenta como aprobado)');
  }

  // ── 3. Requisito H5P ──
  await check('D1: toda principal de los perfiles v1/v2/v3 exige la API H5P 1.28 → Moodle 4.5', async () => {
    for (const prof of [H.CURSIA_H5P_PROFILE_V1, H.CURSIA_H5P_PROFILE_V2, H.CURSIA_H5P_PROFILE_V3]) {
      for (const main of Object.keys(prof.mainLibraries)) {
        const keys = H.profileRuntimeDependencies(prof, main).map((r) => `${r.machineName} ${r.majorVersion}.${r.minorVersion}`);
        const req = MC.h5pRequirement(keys);
        eq([req.coreApi, req.minimumMoodle], ['1.28', '4.5'], `${prof.profileId} ${main}`);
      }
    }
    eq(MC.h5pRequirement(['H5P.InteractiveVideo 1.27']).minimumMoodle, '4.3', 'IV 1.27.9 sola = 4.3 (sus dependencias suben a 4.5)');
    eq(MC.h5pRequirement(['H5P.QuestionSet 1.20']).minimumMoodle, '4.2', 'QS 1.20.29 = 4.2');
    eq(MC.h5pRequirement(['H5P.QuestionSet 1.21']).minimumMoodle, '4.5', 'QS 1.21.13 = 4.5');
    eq(MC.h5pRequirement([]), { coreApi: null, minimumMoodle: null, worst: [] }, 'sin H5P: no sube el piso');
    eq(MC.h5pRequirement(['FontAwesome 4.5']).minimumMoodle, null, 'librería sin coreApi: no sube el piso');
    // Review r60 (M1): la clausura del perfil cuenta aunque el h5p.json declare solo la principal.
    const JSZip2 = require('jszip');
    const z = new JSZip2();
    z.file('h5p.json', JSON.stringify({ title: 'x', mainLibrary: 'H5P.InteractiveVideo', preloadedDependencies: [{ machineName: 'H5P.InteractiveVideo', majorVersion: 1, minorVersion: 27 }] }));
    const keys = await MC.h5pPackageLibraryKeys([await z.generateAsync({ type: 'nodebuffer' })]);
    assert(keys.includes('H5P.JoubelUI 1.3') && keys.includes('H5P.Components 1.0'), `clausura: ${keys.join(', ')}`);
    eq(MC.h5pRequirement(keys).minimumMoodle, '4.5', 'IV declarado solo → piso de su clausura (4.5)');
    // Review r60 (M3/I1): versiones aceptadas como mínimo declarado.
    eq(['3.9', '3.11', '4.0', '4.1', '4.2', '4.5', '4.6', '5.0', '5.1', '3.8', '4', 'x'].map(MC.isKnownMoodleVersion), [true, true, true, true, true, true, true, true, true, false, false, false], 'versiones conocidas');
    throws(() => MC.h5pRequirement(['H5P.Inventada 9.9']), /MOODLE_COMPAT_UNKNOWN_H5P_LIBRARY/, 'librería desconocida');
  });

  // ── 4. Paquetes ──
  const sims = {};
  for (const cfg of CONFIG.courses.filter((c) => ALL || QUICK.includes(c.id))) {
    await check(`[${cfg.id}] con H5P: minimumMoodle 4.5, .mbz = dorado 3.15.1, validador limpio`, async () => {
      const sim = await S.simulateCourse(dist, cfg);
      sims[cfg.id] = sim;
      assert(sim.validation.ok, JSON.stringify(sim.validation.issues.slice(0, 4)));
      const c = sim.built.summary.moodleCompatibility;
      assert(sim.built.summary.h5pPackages.length > 0, 'sin H5P');
      eq([c.backupFormat, c.minimumMoodle, c.h5pCoreApi, c.sectionLinks, sim.built.expectations.moodleMinimum], ['4.1', '4.5', '1.28', 'COURSESECTIONBYID', '4.5'], 'compatibilidad');
      eq(sha256(sim.built.mbz), GOLDEN_3_15_1[cfg.id], 'sha256 del .mbz (con H5P no cambia)');
      eq(sim.built.summary.builderVersion, '3.19.0', 'builder'); // r79.1: tipos de Actividad; r78: Libro Guía en línea
    });
  }
  const noH5pCfg = { ...CONFIG.courses.find((c) => c.id === '1x1-sin-nota'), id: '1x1-sin-nota-sin-h5p', reviewCards: false };
  let noH5p;
  await check('[1x1-sin-nota sin «Repaso»] sin H5P: minimumMoodle 4.1 y botones $@COURSEVIEWBYID*1@$&section=n', async () => {
    noH5p = await S.simulateCourse(dist, noH5pCfg);
    assert(noH5p.validation.ok, JSON.stringify(noH5p.validation.issues.slice(0, 4)));
    eq(noH5p.built.summary.h5pPackages.length, 0, 'sin H5P');
    const c = noH5p.built.summary.moodleCompatibility;
    eq([c.minimumMoodle, c.h5pCoreApi, c.sectionLinks, noH5p.built.expectations.moodleMinimum], ['4.1', null, 'COURSEVIEWBYID_SECTION', '4.1'], 'compatibilidad');
    const labels = Object.values(await labelXmls(noH5p.built.mbz)).join('\n');
    assert(!labels.includes('COURSESECTIONBYID'), 'quedó un $@COURSESECTIONBYID');
    const links = labels.match(/\$@COURSEVIEWBYID\*1@\$&amp;amp;section=\d+/g) || [];
    assert(links.length >= 1, 'sin botón a sección en la forma de 4.1');
    assert(!noH5p.built.summary.restore, 'sin H5P no hay requisito de pack');
  });

  await check('I1: sin H5P y formato de backup 4.0 / 3.11 / 3.9 → arma, minimumMoodle = formato, validador limpio (como 17dc7b0)', async () => {
    const PF = require('./lib/v21-packaging-fixtures');
    const o = { engine: 'scorm', finalExam: false, courseId: 646, modules: [{ examEnabled: false, chapters: [{ video: false, activity: true }, { video: false, activity: false }] }] };
    for (const mv of ['4.0', '3.11', '3.9', '4.4', '4.5']) {
      const r = await B.buildDynamicMbzV3({ ...PF.packagingInput(dist, o), moodleVersion: mv });
      const c = r.summary.moodleCompatibility;
      eq([c.backupFormat, c.minimumMoodle, c.h5pCoreApi, c.sectionLinks], [mv, mv, null, MC.compareMajorMinor(mv, '4.4') >= 0 ? 'COURSESECTIONBYID' : 'COURSEVIEWBYID_SECTION'], `formato ${mv}`);
      const v = await VAL.validateMbzV3(r.mbz, r.expectations);
      assert(v.ok, `${mv}: ${JSON.stringify(v.issues.slice(0, 3))}`);
    }
  });
  await check('M2: la nota del pack v3 sale del piso calculado', async () => {
    eq(B.h5pSiteLibraryPackRestoreNote({ minimumMoodle: '4.6', h5pCoreApi: '1.29' }).note.slice(0, 40), 'Requiere Moodle 4.6 o superior: las acti', 'texto');
    eq(sims['1x1-sin-examenes'].built.summary.restore, B.H5P_SITE_LIBRARY_PACK_RESTORE_NOTE, 'paquete con QS 1.21 = nota del pack (4.5 / 1.28)');
  });

  // ── 5. Validador ──
  const h5pSim = sims['1x1-sin-examenes'];
  await check('validador: H5P declarado para 4.1 / 4.4 → MOODLE_COMPAT; 4.5 limpio; sin declarar no aplica', async () => {
    const e = h5pSim.built.expectations;
    for (const v of ['4.1', '4.4']) {
      const r = await VAL.validateMbzV3(h5pSim.built.mbz, { ...e, moodleMinimum: v });
      assert(!r.ok && codes(r).includes('MOODLE_COMPAT'), `${v}: ${JSON.stringify(r.issues.slice(0, 3))}`);
      assert(r.issues.some((i) => /H5P core API 1\.28/.test(i.message)), `${v}: motivo H5P`);
      if (v === '4.1') assert(r.issues.some((i) => /COURSESECTIONBYID/.test(i.message)), '4.1: motivo token de sección');
    }
    const ok = await VAL.validateMbzV3(h5pSim.built.mbz, { ...e, moodleMinimum: '4.5' });
    assert(ok.ok, JSON.stringify(ok.issues.slice(0, 3)));
    const { moodleMinimum, ...old } = e;
    const legacy = await VAL.validateMbzV3(h5pSim.built.mbz, old);
    assert(legacy.ok, 'sin moodleMinimum (expectativas anteriores a r60) no se evalúa');
    const bad = await VAL.validateMbzV3(h5pSim.built.mbz, { ...e, moodleMinimum: '4.0' });
    assert(codes(bad).includes('MOODLE_COMPAT') && bad.issues.some((i) => /exige Moodle 4\.5\+/.test(i.message)), '4.0 (formato válido) < requisito H5P');
    const unk = await VAL.validateMbzV3(h5pSim.built.mbz, { ...e, moodleMinimum: 'x.y' });
    assert(unk.issues.some((i) => /desconocido/.test(i.message)), 'versión mal formada');
    for (const v of ['4.6', '5.0']) {
      const nw = await VAL.validateMbzV3(h5pSim.built.mbz, { ...e, moodleMinimum: v });
      assert(nw.ok, `${v} (posterior a 4.5) debe pasar: ${JSON.stringify(nw.issues.slice(0, 2))}`);
    }
  });
  await check('validador: paquete 4.1 con un $@COURSESECTIONBYID*n@$ → MOODLE_COMPAT', async () => {
    const m = await mutate(noH5p.built.mbz, (x) => x.replace(/\$@COURSEVIEWBYID\*1@\$&amp;amp;section=(\d+)/, '$@COURSESECTIONBYID*$1@$'));
    const r = await VAL.validateMbzV3(m, noH5p.built.expectations);
    assert(codes(r).includes('MOODLE_COMPAT'), JSON.stringify(r.issues.slice(0, 3)));
    assert(r.issues.some((i) => /COURSESECTIONBYID\*\d+@\$ en .* exige Moodle 4\.4\+/.test(i.message)), 'motivo');
  });
  await check('validador: COURSEVIEWBYID a otro curso / a una sección inexistente → TOKEN_INVALID; navegación sigue la forma 4.1', async () => {
    const m1 = await mutate(noH5p.built.mbz, (x) => x.replace(/\$@COURSEVIEWBYID\*1@\$/, '$@COURSEVIEWBYID*7@$'));
    const r1 = await VAL.validateMbzV3(m1, noH5p.built.expectations);
    assert(codes(r1).includes('TOKEN_INVALID'), JSON.stringify(r1.issues.slice(0, 3)));
    const m2 = await mutate(noH5p.built.mbz, (x) => x.replace(/(\$@COURSEVIEWBYID\*1@\$&amp;amp;section=)\d+/, '$199'));
    const r2 = await VAL.validateMbzV3(m2, noH5p.built.expectations);
    assert(codes(r2).includes('TOKEN_INVALID'), JSON.stringify(r2.issues.slice(0, 3)));
    assert(codes(r2).includes('NAVIGATION'), 'el botón a la sección 99 no coincide con el destino esperado');
  });

  await check('CLI validate-mbz-v3 --moodle-minimum: 4.4 → MOODLE_COMPAT (exit 1); 4.5 → limpio', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r60-compat-'));
    try {
      fs.writeFileSync(path.join(dir, 'p.mbz'), h5pSim.built.mbz);
      fs.writeFileSync(path.join(dir, 'e.json'), JSON.stringify(h5pSim.built.expectations));
      const run = (v) => spawnSync(process.execPath, [path.join(__dirname, 'validate-mbz-v3.js'), path.join(dir, 'p.mbz'), '--expect', path.join(dir, 'e.json'), '--moodle-minimum', v, '--dist', dist], { encoding: 'utf8' });
      const r44 = run('4.4');
      assert(r44.status === 1 && /MOODLE_COMPAT/.test(r44.stdout), `4.4: rc ${r44.status} ${r44.stdout.slice(0, 300)}`);
      const r45 = run('4.5');
      assert(r45.status === 0, `4.5: rc ${r45.status} ${r45.stdout.slice(0, 300)}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // ── 6. Sanitizador del builder ──
  await check('assertTokensV3: token 4.4+ rechazado si el paquete funciona desde < 4.4; forma COURSEVIEWBYID+section validada', async () => {
    const secs = new Set([0, 1, 2]);
    throws(() => B.assertTokensV3('<a href="$@COURSESECTIONBYID*1@$">x</a>', new Map(), 'x', secs, 1, '4.1'), /MBZ_V3_TOKEN_INVALID.*solo Moodle 4\.4\+/, '4.1');
    throws(() => B.assertTokensV3('<a href="$@COURSESECTIONBYID*1@$">x</a>', new Map(), 'x', secs, 1, '4.3'), /MBZ_V3_TOKEN_INVALID/, '4.3');
    B.assertTokensV3('<a href="$@COURSESECTIONBYID*1@$">x</a>', new Map(), 'x', secs, 1, '4.4');
    B.assertTokensV3('<a href="$@COURSESECTIONBYID*1@$">x</a>', new Map(), 'x', secs, 1); // sin versión: como antes
    B.assertTokensV3('<a href="$@COURSEVIEWBYID*1@$&amp;section=2">x</a>', new Map(), 'x', secs, 1, '4.1');
    throws(() => B.assertTokensV3('<a href="$@COURSEVIEWBYID*1@$&amp;section=9">x</a>', new Map(), 'x', secs, 1, '4.1'), /MBZ_V3_TOKEN_INVALID/, 'sección inexistente');
    throws(() => B.assertTokensV3('<a href="$@COURSEVIEWBYID*2@$">x</a>', new Map(), 'x', secs, 1, '4.1'), /MBZ_V3_TOKEN_INVALID/, 'otro curso');
    eq(MC.rewriteSectionTokensLegacy('a $@COURSESECTIONBYID*3@$ b', 1), 'a $@COURSEVIEWBYID*1@$&amp;section=3 b', 'reescritura');
    eq(MC.sectionLinkTargets('<a href="$@COURSESECTIONBYID*2@$">', 1).concat(MC.sectionLinkTargets('<a href="$@COURSEVIEWBYID*1@$&amp;section=3">', 1)), [2, 3], 'destinos');
  });

  await check('nota de entrega: el requisito del pack v3 declara Moodle 4.5+', async () => {
    assert(/Requiere Moodle 4\.5 o superior/.test(B.H5P_SITE_LIBRARY_PACK_RESTORE_NOTE.note), 'nota');
  });

  // Salidas para las restauraciones reales (scripts/r60-moodle-compat-matrix.js).
  const OUT = process.env.R60_OUT_DIR;
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    if (noH5p) fs.writeFileSync(path.join(OUT, 'sin-h5p.mbz'), noH5p.built.mbz);
    if (h5pSim) fs.writeFileSync(path.join(OUT, 'con-h5p.mbz'), h5pSim.built.mbz);
  }

  console.log(`\n${failures ? '❌' : '✅'} check-r60-moodle-compat: ${passed} OK, ${failures} fallo(s)${ALL ? ' (17 dorados)' : ' (rápido: 3 dorados; --all = 17)'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
