#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 / R7-core — checks PUROS (sin DB, sin red, sin Moodle) del motor
// H5P: perfil, preflight, subContentId UUIDv5, l10n es-419, validadores,
// determinismo del zip y dependencias de h5p.json.
//
// Requiere el módulo COMPILADO (`npm run build` antes), igual que los demás
// scripts/check-*.js.
//
// Uso:
//   node scripts/check-v21-h5p.js [--libs <libsDir>]
// El fixture committed `test/fixtures/h5p-profile-v1/libs` (library.json de
// cada librería del perfil + semantics.json de las 7 principales) basta. Con
// --libs (o H5P_LIBS_DIR) además se re-verifica el perfil contra la carpeta
// completa de librerías.

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const modPath = path.resolve(process.cwd(), 'dist/package/h5p/index.js');
let h;
try {
  h = require(modPath);
} catch (err) {
  console.error(`❌ No se pudo cargar el módulo compilado en ${modPath}`);
  console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
  console.error(`   ${err.message}`);
  process.exit(1);
}

const FIXTURE_LIBS = path.resolve('test/fixtures/h5p-profile-v1/libs');
const PROFILE_JSON = path.resolve('src/package/h5p/cursia-h5p-profile.v1.json');
const argLibs = process.argv.indexOf('--libs');
const FULL_LIBS = argLibs >= 0 ? process.argv[argLibs + 1] : process.env.H5P_LIBS_DIR || null;

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.message ? err.message : err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEqual(a, e, msg) {
  if (a !== e) throw new Error(`${msg}: esperado ${JSON.stringify(e)}, encontrado ${JSON.stringify(a)}`);
}
function assertDeepEqual(a, e, msg) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(e);
  if (x !== y) throw new Error(`${msg}: esperado ${y.slice(0, 400)}, encontrado ${x.slice(0, 400)}`);
}
function expectThrow(fn, re, msg) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error(`${msg}: no lanzó error`);
  if (re && !re.test(err.message)) throw new Error(`${msg}: mensaje inesperado: ${err.message}`);
  return err;
}
function readLibraryJsons(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name, 'library.json');
    if (fs.existsSync(p)) out[name] = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return out;
}
function semanticsOf(machineName, majorVersion, minorVersion) {
  const p = path.join(FIXTURE_LIBS, `${machineName}-${majorVersion}.${minorVersion}`, 'semantics.json');
  if (!fs.existsSync(p)) throw new Error(`fixture sin semantics.json: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function semanticsByLibraryString(lib) {
  const m = /^(\S+) (\d+)\.(\d+)$/.exec(lib);
  if (!m) throw new Error(`library inválida: ${lib}`);
  return semanticsOf(m[1], Number(m[2]), Number(m[3]));
}

const P = h.CURSIA_H5P_PROFILE_V1;
const IK = 'activity:ch3';

// ── Fixtures de entrada (texto plano, como vendría del LLM) ──────────────────
const mc = (q, n = 3) => ({
  kind: 'multichoice',
  question: q,
  answers: [
    { text: 'Opción correcta', correct: true, feedback: 'Bien: así funciona.' },
    { text: 'Opción incorrecta A', correct: false },
    { text: 'Opción incorrecta B', correct: false },
    { text: 'Opción incorrecta C', correct: false },
  ].slice(0, n),
});
const tf = (q, correct = true) => ({ kind: 'truefalse', question: q, correct, feedbackCorrect: 'Correcto.', feedbackWrong: 'Revisa el segmento.' });

const inputs = {
  qs: () => ({
    itemKey: IK,
    title: 'Comprueba tu comprensión',
    passPercentage: 70,
    questions: [mc('¿Qué capta el agua de la superficie?'), tf('El filtro va antes de la bomba.', false), mc('¿Qué devuelve el agua filtrada?', 4), tf('El retrolavado limpia el lecho.')],
  }),
  scs: () => ({
    itemKey: 'activity:ch4',
    title: 'Práctica rápida',
    passPercentage: 70,
    questions: [
      { question: '¿Dónde entra el agua?', answers: [{ text: 'Retorno', correct: false }, { text: 'Skimmer', correct: true }, { text: 'Filtro', correct: false }] },
      { question: '¿Qué limpia el lecho?', answers: [{ text: 'Retrolavado', correct: true }, { text: 'Bomba', correct: false }] },
    ],
  }),
  dt: () => ({
    itemKey: 'activity:ch5',
    title: 'Completa el circuito',
    taskDescription: 'Arrastra las palabras al lugar correcto.',
    text: 'El agua entra por el *skimmer* y vuelve por las *boquillas*.\nEl *filtro* retiene la suciedad y la *bomba* la impulsa.',
  }),
  bl: () => ({
    itemKey: 'activity:ch6',
    title: 'Completa las frases',
    text: 'Escribe la palabra que falta.',
    questions: ['El agua entra por el *skimmer/desnatador*.', 'El *filtro* retiene la suciedad y la *bomba* la impulsa.'],
  }),
  iv: () => ({
    itemKey: 'video_interactions:ch3',
    title: 'Recorrido del agua',
    youtubeId: 'IdwOipZAeqY',
    durationSec: 468,
    interactions: [
      { ...mc('¿Qué componente se muestra primero?'), atSec: 60 },
      { ...tf('La bomba impulsa el agua.'), atSec: 150 },
      { ...mc('¿Qué se ve en el retorno?', 4), atSec: 260 },
      { ...tf('El filtro nunca se limpia.', false), atSec: 400 },
    ],
  }),
};

function builtAll() {
  return {
    'H5P.QuestionSet': h.buildQuestionSet(inputs.qs()),
    'H5P.SingleChoiceSet': h.buildSingleChoiceSet(inputs.scs()),
    'H5P.DragText': h.buildDragText(inputs.dt()),
    'H5P.Blanks': h.buildBlanks(inputs.bl()),
    'H5P.InteractiveVideo': h.buildInteractiveVideo(inputs.iv()),
    'H5P.MultiChoice': h.libraryPackSampleContent('H5P.MultiChoice'),
    'H5P.TrueFalse': h.libraryPackSampleContent('H5P.TrueFalse'),
  };
}

// ── Recorrido de semantics vs. salida del builder ────────────────────────────
// Devuelve la lista de problemas: campos de texto con default inglés que quedaron
// sin valor, con el default, o sub-contenidos sin título/subContentId UUID.
function walkL10n(semanticsFields, params, pathPrefix, libName, problems, stats) {
  for (const f of semanticsFields) {
    const p = pathPrefix ? `${pathPrefix}.${f.name}` : f.name;
    const v = params ? params[f.name] : undefined;
    if (f.type === 'group' && f.fields) {
      // Un grupo de un solo campo puede venir "aplanado" en H5P; no usamos esa forma.
      if (f.isSubContent && v && typeof v === 'object') {
        stats.subContents += 1;
        if (!h.isUuid(v.subContentId)) problems.push(`${libName}:${p} grupo isSubContent sin subContentId UUID (${v.subContentId})`);
      }
      walkL10n(f.fields, v, p, libName, problems, stats);
    } else if (f.type === 'list' && f.field) {
      if (!Array.isArray(v)) {
        // Lista ausente: solo es problema si su item tiene textos con default (se reportan al revisar items presentes).
        continue;
      }
      v.forEach((item, i) => {
        if (f.field.type === 'group') {
          if (f.field.isSubContent && item && typeof item === 'object') {
            stats.subContents += 1;
            if (!h.isUuid(item.subContentId)) problems.push(`${libName}:${p}[${i}] grupo isSubContent sin subContentId UUID (${item.subContentId})`);
          }
          walkL10n(f.field.fields, item, `${p}[${i}]`, libName, problems, stats);
        }
        else walkL10n([{ ...f.field, name: String(i) }], { [String(i)]: item }, p, libName, problems, stats);
      });
    } else if (f.type === 'library') {
      if (!v || typeof v !== 'object' || !v.library) continue;
      stats.subContents += 1;
      if (!h.isUuid(v.subContentId)) problems.push(`${libName}:${p} subContentId no es UUID (${v.subContentId})`);
      const t = v.metadata && v.metadata.title;
      if (!t || /untitled/i.test(t)) problems.push(`${libName}:${p} metadata.title vacío o "Untitled" (${t})`);
      walkL10n(semanticsByLibraryString(v.library), v.params, `${p}<${v.library}>`, libName, problems, stats);
    } else if ((f.type === 'text' || f.type === 'textarea') && typeof f.default === 'string' && f.default !== '') {
      stats.textFields += 1;
      if (typeof v !== 'string' || v.trim() === '') problems.push(`${libName}:${p} sin valor (quedaría "${f.default}")`);
      else if (v === f.default && !h.H5P_L10N_IDENTICAL_ALLOWLIST.includes(v)) problems.push(`${libName}:${p} quedó en inglés ("${v}")`);
    }
  }
}

// Conformidad con semantics (lo que el validador H5P de Moodle eliminaría al
// filtrar): claves fuera de semantics, listas vacías, selects con valor inválido.
function walkConformance(semanticsFields, params, pathPrefix, problems) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    problems.push(`${pathPrefix || '$'}: se esperaba un objeto`);
    return;
  }
  const byName = new Map(semanticsFields.map((f) => [f.name, f]));
  for (const [k, v] of Object.entries(params)) {
    const p = pathPrefix ? `${pathPrefix}.${k}` : k;
    const f = byName.get(k);
    if (!f) {
      problems.push(`${p}: no existe en semantics`);
      continue;
    }
    checkValue(f, v, p, problems);
  }
}
function checkValue(f, v, p, problems) {
  if (f.type === 'group') {
    // H5P "aplana" los grupos de un solo campo: el valor es directamente el del campo interno.
    if (f.fields && f.fields.length === 1 && (typeof v !== 'object' || v === null || Array.isArray(v))) {
      checkValue(f.fields[0], v, `${p}.${f.fields[0].name}`, problems);
      return;
    }
    if (f.isSubContent && v && typeof v === 'object' && !Array.isArray(v)) {
      // H5P conserva subContentId en grupos isSubContent (h5p.classes.php validateGroup).
      if (!h.isUuid(v.subContentId)) problems.push(`${p}: grupo isSubContent sin subContentId UUID`);
      const { subContentId, ...rest } = v;
      walkConformance(f.fields || [], rest, p, problems);
      return;
    }
    walkConformance(f.fields || [], v, p, problems);
  } else if (f.type === 'list') {
    if (!Array.isArray(v)) problems.push(`${p}: se esperaba una lista`);
    else if (v.length === 0) problems.push(`${p}: lista vacía (H5P la elimina)`);
    else v.forEach((item, i) => checkValue(f.field, item, `${p}[${i}]`, problems));
  } else if (f.type === 'library') {
    const extra = Object.keys(v || {}).filter((k) => !['library', 'params', 'subContentId', 'metadata'].includes(k));
    if (extra.length) problems.push(`${p}: claves extra en sub-contenido ${extra}`);
    if (!(f.options || []).includes(v.library)) problems.push(`${p}: librería ${v.library} no permitida en ${JSON.stringify(f.options)}`);
    else walkConformance(semanticsByLibraryString(v.library), v.params, `${p}<${v.library}>`, problems);
  } else if (f.type === 'select') {
    const vals = (f.options || []).map((o) => o.value);
    if (!vals.includes(v)) problems.push(`${p}: valor ${JSON.stringify(v)} fuera de ${JSON.stringify(vals)}`);
  } else if (f.type === 'boolean') {
    if (typeof v !== 'boolean') problems.push(`${p}: se esperaba booleano`);
  } else if (f.type === 'number') {
    if (typeof v !== 'number') problems.push(`${p}: se esperaba número`);
    else if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) problems.push(`${p}: ${v} fuera de [${f.min}, ${f.max}]`);
  } else if (f.type === 'text' || f.type === 'textarea') {
    if (typeof v !== 'string') problems.push(`${p}: se esperaba texto`);
  } else if (f.type === 'video') {
    // H5PContentValidator::validateVideo → _validateFilelike: path, mime, copyright (+ width, height, codecs, quality, bitrate).
    if (!Array.isArray(v) || v.length === 0) problems.push(`${p}: se esperaba una lista de archivos no vacía`);
    else v.forEach((file, i) => {
      const extra = Object.keys(file).filter((k) => !['path', 'mime', 'copyright', 'width', 'height', 'codecs', 'quality', 'bitrate'].includes(k));
      if (extra.length) problems.push(`${p}[${i}]: claves que H5P elimina: ${extra}`);
    });
  } else {
    problems.push(`${p}: tipo de semantics "${f.type}" no verificado por este check`);
  }
}

// Todas las rutas (fuera de listas) de texto con default no vacío.
function defaultTextPaths(fields, prefix, out) {
  for (const f of fields) {
    const p = prefix ? `${prefix}.${f.name}` : f.name;
    if (f.type === 'group' && f.fields) defaultTextPaths(f.fields, p, out);
    else if ((f.type === 'text' || f.type === 'textarea') && typeof f.default === 'string' && f.default !== '') out[p] = f.default;
  }
  return out;
}

const CONTENT_FILLED = {
  'H5P.DragText': ['taskDescription'],
  'H5P.Blanks': ['text'],
  'H5P.InteractiveVideo': ['interactiveVideo.video.startScreenOptions.title'],
};

function placeholders(s) {
  return (s.match(/(@[a-zA-Z]+|:[a-zA-Z]+|%[a-zA-Z]+|%d)/g) || []).sort();
}

async function unzip(buf) {
  const z = await JSZip.loadAsync(buf);
  const names = Object.keys(z.files).sort();
  const out = {};
  for (const n of names) out[n] = await z.files[n].async('string');
  return { names, out, z };
}

(async () => {
  // ── 1. Perfil ──────────────────────────────────────────────────────────────
  await check('perfil: la clausura recalculada desde el fixture es idéntica al JSON committed', () => {
    const regenerated = h.serializeH5pProfile(h.computeH5pProfile(readLibraryJsons(FIXTURE_LIBS)));
    const committed = fs.readFileSync(PROFILE_JSON, 'utf8');
    assert(regenerated === committed, 'cursia-h5p-profile.v1.json difiere de la regeneración (corre scripts/generate-h5p-profile.js)');
  });

  if (FULL_LIBS) {
    await check(`perfil: la clausura recalculada desde ${FULL_LIBS} es idéntica al JSON committed`, () => {
      const regenerated = h.serializeH5pProfile(h.computeH5pProfile(readLibraryJsons(path.resolve(FULL_LIBS))));
      assert(regenerated === fs.readFileSync(PROFILE_JSON, 'utf8'), 'difiere de la carpeta completa de librerías');
    });
  }

  await check('perfil: versiones exactas certificadas (IV 1.27, QS 1.20, MC 1.16, TF 1.8, SCS 1.11, DT 1.10, Blanks 1.14)', () => {
    assertEqual(P.profileId, 'CURSIA_H5P_PROFILE_V1', 'profileId');
    assertEqual(P.version, 1, 'version');
    assertEqual(h.h5pProfileVersion, 1, 'h5pProfileVersion');
    const expected = {
      'H5P.InteractiveVideo': [1, 27],
      'H5P.QuestionSet': [1, 20],
      'H5P.MultiChoice': [1, 16],
      'H5P.TrueFalse': [1, 8],
      'H5P.SingleChoiceSet': [1, 11],
      'H5P.DragText': [1, 10],
      'H5P.Blanks': [1, 14],
    };
    assertDeepEqual(Object.keys(P.mainLibraries).sort(), Object.keys(expected).sort(), 'mainLibraries');
    for (const [m, [maj, min]] of Object.entries(expected)) {
      const r = P.mainLibraries[m];
      assert(r.majorVersion === maj && r.minorVersion === min && Number.isInteger(r.patchVersion), `${m} versión ${JSON.stringify(r)}`);
    }
  });

  await check('perfil: cada clausura contiene su librería principal y sus sub-contenidos; full ⊇ runtime; libraries = unión', () => {
    const key = (r) => `${r.machineName}-${r.majorVersion}.${r.minorVersion}.${r.patchVersion}`;
    const union = new Set();
    for (const [m, c] of Object.entries(P.closureByMain)) {
      const rt = new Set(c.runtime.map(key));
      const full = new Set(c.full.map(key));
      assert(rt.has(key(P.mainLibraries[m])), `${m} runtime sin la principal`);
      for (const k of rt) assert(full.has(k), `${m}: ${k} en runtime pero no en full`);
      for (const sub of P.contentLibrariesByMain[m]) {
        assert(c.runtime.some((r) => r.machineName === sub.machineName && r.minorVersion === sub.minorVersion), `${m} sin sub-contenido ${sub.machineName}`);
      }
      assert(!c.runtime.some((r) => r.machineName.startsWith('H5PEditor.')), `${m}: runtime con librería de editor`);
      for (const k of full) union.add(k);
    }
    assertDeepEqual([...union].sort(), P.libraries.map(key).sort(), 'libraries');
  });

  await check('perfil: falla fuerte si falta una librería de la clausura', () => {
    const libs = readLibraryJsons(FIXTURE_LIBS);
    delete libs['H5P.Question-1.5'];
    expectThrow(() => h.computeH5pProfile(libs), /H5P_PROFILE_MISSING_LIBRARY: H5P\.Question-1\.5/, 'computeH5pProfile');
  });

  // ── 2. Preflight ───────────────────────────────────────────────────────────
  const installedAll = () => P.libraries.map((r) => ({ ...r }));
  await check('preflight: todas instaladas → ok', () => {
    const r = h.h5pPreflight(P, installedAll());
    assert(r.ok, 'ok=false');
    assertEqual(r.missing.length + r.incompatible.length, 0, 'missing+incompatible');
    assertEqual(r.satisfied.length, P.libraries.length, 'satisfied');
    assertEqual(r.required.length, P.libraries.length, 'required');
  });
  await check('preflight: librería faltante → missing y assert lanza H5P_PREFLIGHT_FAILED', () => {
    const inst = installedAll().filter((r) => r.machineName !== 'H5P.DragText');
    const r = h.h5pPreflight(P, inst);
    assert(!r.ok, 'ok=true');
    assertDeepEqual(r.missing.map((x) => x.machineName), ['H5P.DragText'], 'missing');
    expectThrow(() => h.assertH5pPreflight(P, inst), /^H5P_PREFLIGHT_FAILED: missing=\[H5P\.DragText-1\.10\.\d+\] incompatible=\[\] disabled=\[\]$/, 'assert');
  });
  await check('preflight: patch instalado MENOR → incompatible', () => {
    const inst = installedAll().map((r) => (r.machineName === 'H5P.Blanks' ? { ...r, patchVersion: r.patchVersion - 1 } : r));
    const r = h.h5pPreflight(P, inst);
    assert(!r.ok, 'ok=true');
    assertEqual(r.incompatible.length, 1, 'incompatible');
    assertEqual(r.incompatible[0].required.machineName, 'H5P.Blanks', 'incompatible[0]');
    expectThrow(() => h.assertH5pPreflight(P, inst), /incompatible=\[H5P\.Blanks-1\.14\.\d+ \(instalada \.\d+\)\]/, 'assert');
  });
  await check('preflight: patch instalado MAYOR → ok; otro minor → missing', () => {
    const hi = installedAll().map((r) => ({ ...r, patchVersion: r.patchVersion + 5 }));
    assert(h.h5pPreflight(P, hi).ok, 'patch mayor debería pasar');
    const otherMinor = installedAll().map((r) => (r.machineName === 'H5P.TrueFalse' ? { ...r, minorVersion: r.minorVersion + 1 } : r));
    const r = h.h5pPreflight(P, otherMinor);
    assert(!r.ok && r.missing.some((x) => x.machineName === 'H5P.TrueFalse'), 'otro minor debería faltar');
  });
  await check('preflight: scope runtime ignora librerías de editor', () => {
    const inst = installedAll().filter((r) => !r.machineName.startsWith('H5PEditor.'));
    assert(!h.h5pPreflight(P, inst).ok, 'full debería fallar sin editor');
    assert(h.h5pPreflight(P, inst, { scope: 'runtime' }).ok, 'runtime debería pasar sin editor');
  });

  await check('preflight: tipo de contenido principal DESHABILITADO (enabled=0) → disabled[] y FAIL LOUD', () => {
    const inst = installedAll().map((r) => ({ ...r, enabled: 1 }));
    assert(h.h5pPreflight(P, inst).ok, 'todo habilitado debería pasar');
    // Basta UNA fila deshabilitada del machineName (api::is_library_enabled), aunque otra versión esté habilitada.
    const dis = [...inst.map((r) => (r.machineName === 'H5P.SingleChoiceSet' ? { ...r, enabled: 0 } : r)), { machineName: 'H5P.SingleChoiceSet', majorVersion: 1, minorVersion: 9, patchVersion: 0, enabled: 1 }]
      .map((r) => (r.machineName === 'H5P.TrueFalse' ? { ...r, enabled: '0' } : r));
    const r = h.h5pPreflight(P, dis);
    assert(!r.ok, 'ok=true con librerías deshabilitadas');
    assertDeepEqual(r.disabled, ['H5P.SingleChoiceSet', 'H5P.TrueFalse'], 'disabled');
    expectThrow(() => h.assertH5pPreflight(P, dis), /disabled=\[H5P\.SingleChoiceSet, H5P\.TrueFalse\]$/, 'assert');
    // Una dependencia no principal deshabilitada no bloquea (Moodle solo filtra por la principal).
    const dep = inst.map((r) => (r.machineName === 'H5P.JoubelUI' ? { ...r, enabled: 0 } : r));
    assert(h.h5pPreflight(P, dep).ok, 'dependencia deshabilitada no debería bloquear');
  });
  await check('preflight: entrada inválida (null, "", enabled raro) → H5P_PREFLIGHT_BAD_INPUT, no "patch 0"', () => {
    const base = installedAll();
    for (const bad of [{ patchVersion: null }, { patchVersion: '' }, { minorVersion: '1.5' }, { majorVersion: -1 }, { enabled: 'yes' }, { machineName: '' }]) {
      const inst = base.map((r, i) => (i === 0 ? { ...r, ...bad } : r));
      expectThrow(() => h.h5pPreflight(P, inst), /^H5P_PREFLIGHT_BAD_INPUT: installed\[0\]/, JSON.stringify(bad));
    }
    assert(h.h5pPreflight(P, base.map((r) => ({ ...r, patchVersion: String(r.patchVersion) }))).ok, 'string numérico aceptado');
  });

  // ── 3. IDs ─────────────────────────────────────────────────────────────────
  await check('uuidV5: vector conocido (NAMESPACE_DNS, "python.org") = 886313e1-3b8a-5372-9b90-0c9aee199e5d', () => {
    assertEqual(h.uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '886313e1-3b8a-5372-9b90-0c9aee199e5d', 'uuidV5');
  });
  await check('h5pSubContentId: estable, versión 5 / variante RFC 4122, valor fijado', () => {
    const a = h.h5pSubContentId('activity:ch1', 0, 1);
    assertEqual(a, h.h5pSubContentId('activity:ch1', 0, 1), 'estable');
    assertEqual(a, '4ccfc6c5-19b9-560f-9fb2-9ea26835665b', 'valor fijado (namespace Cursia)');
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a), `formato ${a}`);
  });
  await check('h5pSubContentId: distinto entre ítems, índices y versiones de perfil', () => {
    const ids = new Set([
      h.h5pSubContentId('activity:ch1', 0, 1),
      h.h5pSubContentId('activity:ch2', 0, 1),
      h.h5pSubContentId('activity:ch1', 1, 1),
      h.h5pSubContentId('activity:ch1', 0, 2),
      h.h5pSubContentId('video_interactions:ch1', 0, 1),
    ]);
    assertEqual(ids.size, 5, 'ids únicos');
    expectThrow(() => h.h5pSubContentId('', 0, 1), /H5P_SUBCONTENT_ID_INVALID/, 'itemKey vacío');
    expectThrow(() => h.h5pSubContentId('x', -1, 1), /H5P_SUBCONTENT_ID_INVALID/, 'index negativo');
  });
  await check('builders: subContentId = h5pSubContentId(itemKey, índice, 1) y estable entre builds', () => {
    const a = h.buildQuestionSet(inputs.qs());
    const b = h.buildQuestionSet(inputs.qs());
    assertDeepEqual(a.subContentIds, b.subContentIds, 'estable');
    assertDeepEqual(a.subContentIds, [0, 1, 2, 3].map((i) => h.h5pSubContentId(IK, i, 1)), 'derivación');
    assertDeepEqual(a.content.questions.map((q) => q.subContentId), a.subContentIds, 'en el contenido');
    const iv = h.buildInteractiveVideo(inputs.iv());
    assertDeepEqual(iv.content.interactiveVideo.assets.interactions.map((x) => x.action.subContentId), [0, 1, 2, 3].map((i) => h.h5pSubContentId('video_interactions:ch3', i, 1)), 'IV');
    const other = h.buildQuestionSet({ ...inputs.qs(), itemKey: 'activity:ch9' });
    assert(!other.subContentIds.some((id) => a.subContentIds.includes(id)), 'ítems distintos comparten ids');
  });

  // ── 4. l10n ────────────────────────────────────────────────────────────────
  const built = builtAll();
  for (const [lib, b] of Object.entries(built)) {
    await check(`l10n es-419 completa: ${lib} (ningún campo con default inglés; sub-contenidos con título y UUID)`, () => {
      const ref = P.mainLibraries[lib];
      const problems = [];
      const stats = { textFields: 0, subContents: 0 };
      walkL10n(semanticsOf(ref.machineName, ref.majorVersion, ref.minorVersion), b.content, '', lib, problems, stats);
      assert(problems.length === 0, `${problems.length} problema(s):\n     - ${problems.join('\n     - ')}`);
      assert(stats.textFields > 5, `muy pocos campos revisados (${stats.textFields})`);
      if (lib === 'H5P.QuestionSet' || lib === 'H5P.InteractiveVideo') assertEqual(stats.subContents, 4, 'sub-contenidos revisados');
      if (lib === 'H5P.SingleChoiceSet') assertEqual(stats.subContents, 2, 'sub-contenidos revisados');
    });
  }
  for (const [lib, b] of Object.entries(built)) {
    await check(`semantics: ${lib} solo usa campos de semantics, sin listas vacías ni selects inválidos (nada que el filtro H5P elimine)`, () => {
      const ref = P.mainLibraries[lib];
      const problems = [];
      walkConformance(semanticsOf(ref.machineName, ref.majorVersion, ref.minorVersion), b.content, '', problems);
      assert(problems.length === 0, problems.join('; '));
    });
  }
  // ── C1 (review G4): subContentId en TODO sub-contenido de TODO paquete ─────
  // Recorre el content.json REAL de cada paquete: todo objeto con "library" y todo
  // elemento de un grupo isSubContent de semantics (a cualquier profundidad) debe
  // llevar un subContentId UUID v5 en minúsculas, único dentro del paquete.
  function collectSubContent(fields, params, p, out) {
    for (const f of fields) {
      const v = params ? params[f.name] : undefined;
      const fp = p ? `${p}.${f.name}` : f.name;
      if (v === undefined) continue;
      if (f.type === 'group' && f.fields) {
        if (f.isSubContent) out.push({ path: fp, id: v && v.subContentId });
        collectSubContent(f.fields, v, fp, out);
      } else if (f.type === 'list' && f.field && Array.isArray(v)) {
        v.forEach((item, i) => collectSubContent([{ ...f.field, name: String(i) }], { [String(i)]: item }, `${fp}`, out));
      } else if (f.type === 'library' && v && v.library) {
        collectSubContent(semanticsByLibraryString(v.library), v.params, `${fp}<${v.library}>`, out);
      }
    }
  }
  function genericSubContentAudit(mainLibrary, content) {
    const problems = [];
    const ids = [];
    const libObjs = [];
    (function walk(v, p) {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
      else if (v && typeof v === 'object') {
        if (typeof v.library === 'string') libObjs.push({ path: p || '$', id: v.subContentId });
        for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
      }
    })(content, '');
    const ref = P.mainLibraries[mainLibrary];
    const groups = [];
    collectSubContent(semanticsOf(ref.machineName, ref.majorVersion, ref.minorVersion), content, '', groups);
    for (const x of [...libObjs, ...groups]) {
      if (!h.isUuid(x.id) || !/^[0-9a-f-]+$/.test(x.id)) problems.push(`${x.path}: subContentId inválido (${x.id})`);
      else if (ids.includes(x.id)) problems.push(`${x.path}: duplicado ${x.id}`);
      else ids.push(x.id);
    }
    return { problems, count: ids.length };
  }
  const EXPECTED_SUBCONTENT = { 'H5P.QuestionSet': 4, 'H5P.SingleChoiceSet': 2, 'H5P.DragText': 0, 'H5P.Blanks': 0, 'H5P.InteractiveVideo': 4, 'H5P.MultiChoice': 0, 'H5P.TrueFalse': 0 };
  for (const [lib, b] of Object.entries(built)) {
    await check(`subContentId genérico: ${lib} — content.json del paquete, todo sub-contenido con UUID v5 único`, async () => {
      const buf = await h.buildContentOnlyH5p({ mainLibrary: b.mainLibrary || lib, content: b.content, title: b.title || 'Ejemplo', language: 'es' });
      const { out } = await unzip(buf);
      const content = JSON.parse(out['content/content.json']);
      const r = genericSubContentAudit(lib, content);
      assert(r.problems.length === 0, r.problems.join('; '));
      assertEqual(r.count, EXPECTED_SUBCONTENT[lib], 'sub-contenidos encontrados');
      if (b.subContentIds) assertEqual(b.subContentIds.length, r.count, 'subContentIds declarados = encontrados');
    });
  }
  await check('subContentId genérico: la Library Pack sample de IV/QS/SCS también cumple', async () => {
    for (const lib of ['H5P.InteractiveVideo', 'H5P.QuestionSet', 'H5P.SingleChoiceSet']) {
      const r = genericSubContentAudit(lib, h.libraryPackSampleContent(lib).content);
      assert(r.problems.length === 0 && r.count > 0, `${lib}: ${r.problems.join('; ')} (n=${r.count})`);
    }
  });
  await check('H5P_SUBCONTENT_GROUP_PATHS coincide con los grupos isSubContent de primer nivel de las 7 semantics', () => {
    for (const lib of Object.keys(P.mainLibraries)) {
      const ref = P.mainLibraries[lib];
      const found = [];
      (function scan(fields, p) {
        for (const f of fields) {
          const fp = p ? `${p}.${f.name}` : f.name;
          if (f.type === 'group' && f.isSubContent) found.push(fp.replace(/\.[^.]+$/, '') || fp);
          if (f.type === 'group' && f.fields && !f.isSubContent) scan(f.fields, fp);
          if (f.type === 'list' && f.field) scan([f.field], fp);
        }
      })(semanticsOf(ref.machineName, ref.majorVersion, ref.minorVersion), '');
      assertDeepEqual(found, [...(h.H5P_SUBCONTENT_GROUP_PATHS[lib] || [])], lib);
    }
  });
  await check('paquete: falla fuerte sin subContentId, con id no UUID, en mayúsculas o duplicado (SCS y QS)', async () => {
    const tries = [
      ['H5P.SingleChoiceSet', (c) => { delete c.choices[0].subContentId; }],
      ['H5P.SingleChoiceSet', (c) => { c.choices[1].subContentId = c.choices[0].subContentId; }],
      ['H5P.QuestionSet', (c) => { c.questions[2].subContentId = 'q3'; }],
      ['H5P.QuestionSet', (c) => { c.questions[0].subContentId = c.questions[0].subContentId.toUpperCase(); }],
      ['H5P.InteractiveVideo', (c) => { delete c.interactiveVideo.assets.interactions[1].action.subContentId; }],
    ];
    for (const [lib, mut] of tries) {
      const b = built[lib];
      const c = JSON.parse(JSON.stringify(b.content));
      mut(c);
      let err = null;
      try {
        await h.buildContentOnlyH5p({ mainLibrary: lib, content: c, title: b.title, language: 'es' });
      } catch (e) {
        err = e;
      }
      assert(err && /H5P_PACKAGE_SUBCONTENT_ID/.test(err.message), `${lib}: sin error (${err && err.message})`);
    }
  });
  await check('SCS: cada pregunta (grupo isSubContent "choice") lleva h5pSubContentId(itemKey, i, 1)', () => {
    const b = built['H5P.SingleChoiceSet'];
    assertDeepEqual(b.content.choices.map((c) => c.subContentId), b.content.choices.map((_, i) => h.h5pSubContentId(inputs.scs().itemKey, i, 1)), 'ids');
    assertDeepEqual(b.subContentIds, b.content.choices.map((c) => c.subContentId), 'subContentIds');
  });
  await check('H5P_MOODLE_GRADING: cubre las 7 principales; SCS no calificable ⇒ assertH5pGradableInMoodle lanza', () => {
    assertDeepEqual(Object.keys(h.H5P_MOODLE_GRADING).sort(), Object.keys(P.mainLibraries).sort(), 'claves');
    for (const lib of ['H5P.InteractiveVideo', 'H5P.QuestionSet', 'H5P.DragText', 'H5P.Blanks']) h.assertH5pGradableInMoodle(lib);
    expectThrow(() => h.assertH5pGradableInMoodle('H5P.SingleChoiceSet'), /^H5P_NOT_GRADABLE_IN_MOODLE: H5P\.SingleChoiceSet/, 'SCS');
    expectThrow(() => h.assertH5pGradableInMoodle('H5P.Accordion'), /H5P_NOT_GRADABLE_IN_MOODLE/, 'desconocida');
  });
  await check('isUuid: solo minúsculas (Moodle elimina UUID en mayúsculas)', () => {
    const id = h.h5pSubContentId('x', 0, 1);
    assert(h.isUuid(id) && !h.isUuid(id.toUpperCase()), 'mayúsculas aceptadas');
  });
  await check('semantics: el control de conformidad SÍ detecta campo extra, lista vacía y select inválido (control negativo)', () => {
    const iv = JSON.parse(JSON.stringify(built['H5P.InteractiveVideo'].content));
    iv.interactiveVideo.video.files[0].aspectRatio = '16:9';
    iv.interactiveVideo.assets.bookmarks = [];
    iv.override.preventSkippingMode = 'off';
    const problems = [];
    const ref = P.mainLibraries['H5P.InteractiveVideo'];
    walkConformance(semanticsOf(ref.machineName, ref.majorVersion, ref.minorVersion), iv, '', problems);
    assertEqual(problems.length, 3, `problemas detectados (${problems.join(' | ')})`);
  });
  await check('l10n: el recorrido SÍ detecta campos faltantes, en inglés, títulos "Untitled" y ids no UUID (control negativo)', () => {
    const qs = JSON.parse(JSON.stringify(built['H5P.QuestionSet'].content));
    delete qs.texts.prevButton;
    qs.endGame.retryButtonText = 'Retry';
    qs.questions[0].metadata.title = 'Untitled Multiple Choice';
    qs.questions[1].subContentId = 'q2';
    delete qs.questions[2].params.UI.checkAnswerButton;
    const problems = [];
    const ref = P.mainLibraries['H5P.QuestionSet'];
    walkL10n(semanticsOf(ref.machineName, ref.majorVersion, ref.minorVersion), qs, '', 'H5P.QuestionSet', problems, { textFields: 0, subContents: 0 });
    assertEqual(problems.length, 5, `problemas detectados (${problems.join(' | ')})`);
  });
  await check('l10n: la tabla cubre exactamente los campos de interfaz de semantics y conserva placeholders', () => {
    const problems = [];
    for (const [lib, ref] of Object.entries(P.mainLibraries)) {
      const defaults = defaultTextPaths(semanticsOf(ref.machineName, ref.majorVersion, ref.minorVersion), '', {});
      const table = h.H5P_L10N_ES419[lib] || {};
      const filled = CONTENT_FILLED[lib] || [];
      for (const [p, en] of Object.entries(defaults)) {
        if (filled.includes(p)) continue;
        if (!(p in table)) problems.push(`${lib}: falta traducción de ${p} ("${en}")`);
        else if (JSON.stringify(placeholders(en)) !== JSON.stringify(placeholders(table[p]))) {
          problems.push(`${lib}:${p} placeholders ${placeholders(en)} ≠ ${placeholders(table[p])}`);
        }
      }
      for (const p of Object.keys(table)) if (!(p in defaults)) problems.push(`${lib}: clave sobrante ${p}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });
  await check('l10n: IV sin "Submit Answers"/"Untitled"; pantalla final en español', () => {
    const s = JSON.stringify(built['H5P.InteractiveVideo'].content);
    assert(!/Submit Answers|Untitled/.test(s), 'quedó texto inglés');
    assertEqual(built['H5P.InteractiveVideo'].content.l10n.endcardSubmitButton, 'Enviar respuestas', 'endcardSubmitButton');
  });

  // ── 5. Validadores ─────────────────────────────────────────────────────────
  await check('validador QuestionSet: multichoice con EXACTAMENTE 1 correcta (0 o 2 correctas → rechazo; R13 fix round 1)', () => {
    const two = inputs.qs();
    const mc = two.questions.findIndex((q) => q.kind === 'multichoice');
    two.questions[mc].answers.forEach((a, i) => { a.correct = i < 2; });
    expectThrow(() => h.buildQuestionSet(two), /H5P_INPUT_INVALID\(QuestionSet\).*answers: debe haber exactamente 1 correcta \(hay 2\)/, 'dos correctas');
    const none = inputs.qs();
    none.questions[mc].answers.forEach((a) => { a.correct = false; });
    expectThrow(() => h.buildQuestionSet(none), /debe haber exactamente 1 correcta \(hay 0\)/, 'ninguna correcta');
    h.buildQuestionSet(inputs.qs()); // la fixture válida (1 correcta por multichoice) sigue pasando
  });
  await check('validador: rechaza HTML y entidades en la entrada', () => {
    const q1 = inputs.qs();
    q1.questions[0].question = '¿Qué es <b>esto</b>?';
    expectThrow(() => h.buildQuestionSet(q1), /H5P_INPUT_INVALID\(QuestionSet\).*questions\[0\]\.question: no se permite HTML/, 'tag');
    const q2 = inputs.qs();
    q2.questions[0].answers[1].text = 'A &amp; B';
    expectThrow(() => h.buildQuestionSet(q2), /entidades HTML/, 'entidad');
    const d = inputs.dt();
    d.taskDescription = '<script>alert(1)</script>';
    expectThrow(() => h.buildDragText(d), /taskDescription: no se permite HTML/, 'script');
    const v = inputs.iv();
    v.title = 'Video <img src=x onerror=1>';
    expectThrow(() => h.buildInteractiveVideo(v), /title: no se permite HTML/, 'img');
  });
  await check('validador: texto plano con < > & se acepta y se escapa (nunca HTML crudo)', () => {
    const q = inputs.qs();
    q.questions[0].question = '¿Es 3 < 5 & 5 > 3?';
    const b = h.buildQuestionSet(q);
    assertEqual(b.content.questions[0].params.question, '<p>¿Es 3 &lt; 5 &amp; 5 &gt; 3?</p>', 'escape');
  });
  await check('validador: DragText con menos de 2 huecos, anidados, vacíos o desbalanceados', () => {
    const t = (text) => ({ ...inputs.dt(), text });
    expectThrow(() => h.buildDragText(t('Solo un *hueco* aquí.')), /al menos 2 huecos \(hay 1\)/, 'pocos');
    expectThrow(() => h.buildDragText(t('A *uno *dos* tres* y *cuatro*.')), /espacios en los bordes/, 'anidado');
    expectThrow(() => h.buildDragText(t('A ** y *b* y *c*.')), /hueco vacío/, 'vacío');
    expectThrow(() => h.buildDragText(t('A *b* y *c.')), /desbalanceados/, 'desbalanceado');
    expectThrow(() => h.buildDragText(t('A *b:pista* y *c*.')), /sintaxis avanzada/, 'tip');
  });
  await check('validador: Blanks con menos de 2 huecos, frase sin hueco o alternativa vacía', () => {
    expectThrow(() => h.buildBlanks({ ...inputs.bl(), questions: ['Solo *uno*.'] }), /al menos 2 huecos en total/, 'pocos');
    expectThrow(() => h.buildBlanks({ ...inputs.bl(), questions: ['Sin hueco.', 'Con *a* y *b*.'] }), /al menos 1 hueco/, 'sin hueco');
    expectThrow(() => h.buildBlanks({ ...inputs.bl(), questions: ['A *b/* y *c*.'] }), /alternativa vacía/, 'alt vacía');
    expectThrow(() => h.buildBlanks({ ...inputs.bl(), questions: ['Va a 60 *km/h* y *rápido*.'] }), /parece una unidad o fracción/, 'km/h');
    expectThrow(() => h.buildBlanks({ ...inputs.bl(), questions: ['Es *1/2* de la *mezcla*.'] }), /parece una unidad o fracción/, '1/2');
    h.buildBlanks({ ...inputs.bl(), questions: ['El *skimmer/desnatador* y la *bomba*.'] });
  });
  await check('validador: IV con tiempos inválidos (antes de 30 s, en los últimos 15 s, no creciente, < 20 s, 2 o 9 interacciones)', () => {
    const withTimes = (times) => {
      const v = inputs.iv();
      v.interactions = times.map((t, i) => ({ ...(i % 2 ? tf(`Afirmación ${i}`) : mc(`Pregunta ${i}`)), atSec: t }));
      return v;
    };
    expectThrow(() => h.buildInteractiveVideo(withTimes([20, 100, 200])), /interactions\[0\]\.atSec: 20 fuera de \[30, 453\]/, '< 30');
    expectThrow(() => h.buildInteractiveVideo(withTimes([60, 150, 460])), /interactions\[2\]\.atSec: 460 fuera de/, 'últimos 15 s');
    expectThrow(() => h.buildInteractiveVideo(withTimes([60, 150, 100])), /estrictamente mayor que 150/, 'no creciente');
    expectThrow(() => h.buildInteractiveVideo(withTimes([60, 70, 200])), /≥ 20 s de la anterior/, 'gap');
    expectThrow(() => h.buildInteractiveVideo(withTimes([60, 150])), /entre 3 y 8 elementos \(tiene 2\)/, 'pocas');
    expectThrow(() => h.buildInteractiveVideo(withTimes([40, 70, 100, 130, 160, 190, 220, 250, 280])), /entre 3 y 8 elementos \(tiene 9\)/, 'muchas');
    h.buildInteractiveVideo(withTimes([30, 50, 453])); // bordes exactos válidos
  });
  await check('validador: IV MultiChoice con 2 correctas o 2 opciones; youtubeId inválido; campo desconocido', () => {
    const v = inputs.iv();
    v.interactions[0].answers[1].correct = true;
    expectThrow(() => h.buildInteractiveVideo(v), /exactamente 1 correcta \(hay 2\)/, '2 correctas');
    const v2 = inputs.iv();
    v2.interactions[0].answers = v2.interactions[0].answers.slice(0, 2);
    expectThrow(() => h.buildInteractiveVideo(v2), /entre 3 y 4 elementos/, '2 opciones');
    expectThrow(() => h.buildInteractiveVideo({ ...inputs.iv(), youtubeId: 'https://youtu.be/x' }), /youtubeId/, 'youtubeId');
    expectThrow(() => h.buildInteractiveVideo({ ...inputs.iv(), html: '<p>x</p>' }), /campo desconocido "html"/, 'extra');
  });
  await check('validador: SingleChoiceSet exige exactamente 1 correcta y la coloca primero', () => {
    const s = inputs.scs();
    s.questions[0].answers[0].correct = true;
    expectThrow(() => h.buildSingleChoiceSet(s), /exactamente 1 correcta \(hay 2\)/, '2 correctas');
    const b = h.buildSingleChoiceSet(inputs.scs());
    assertEqual(b.content.choices[0].answers[0], '<p>Skimmer</p>', 'correcta primero');
  });

  // ── 6. IV: contrato del contenido ──────────────────────────────────────────
  await check('IV: YouTube video/YouTube, pausa, ventana 10 s, sin adaptividad, endscreen, preventSkipping OFF, sin Summary', () => {
    const c = built['H5P.InteractiveVideo'].content;
    const f = c.interactiveVideo.video.files[0];
    assertEqual(f.path, 'https://www.youtube.com/watch?v=IdwOipZAeqY', 'path');
    assertEqual(f.mime, 'video/YouTube', 'mime');
    for (const [i, it] of c.interactiveVideo.assets.interactions.entries()) {
      assert(it.pause === true, `pause ${i}`);
      assertEqual(it.duration.to - it.duration.from, 10, `ventana ${i}`);
      assert(it.adaptivity.correct.seekTo === undefined && it.adaptivity.wrong.seekTo === undefined && it.adaptivity.requireCompletion === false, `adaptividad ${i}`);
      assert(/^<p>Pregunta \d+<\/p>$/.test(it.label), `label ${i}`);
    }
    assertEqual(c.interactiveVideo.assets.endscreens.length, 1, 'endscreens');
    assertEqual(c.interactiveVideo.assets.endscreens[0].time, 468, 'endscreen.time');
    assertEqual(c.override.preventSkippingMode, 'none', 'preventSkippingMode');
    assert(c.interactiveVideo.summary.task === undefined, 'summary.task debe no existir');
    assertEqual(built['H5P.InteractiveVideo'].maxScore, 4, 'maxScore');
  });

  // ── 7. Paquetes ────────────────────────────────────────────────────────────
  await check('zip: mismo input ⇒ mismo sha256 (también con otra zona horaria)', async () => {
    const make = () => h.buildContentOnlyH5p({ ...h.buildQuestionSet(inputs.qs()), language: 'es' });
    const a = h.sha256Hex(await make());
    const b = h.sha256Hex(await make());
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    const c = h.sha256Hex(await make());
    process.env.TZ = tz === undefined ? '' : tz;
    if (tz === undefined) delete process.env.TZ;
    assertEqual(b, a, 'segunda construcción');
    assertEqual(c, a, 'otra zona horaria');
    const other = h.sha256Hex(await h.buildContentOnlyH5p({ ...h.buildQuestionSet({ ...inputs.qs(), title: 'Otro' }), language: 'es' }));
    assert(other !== a, 'inputs distintos con el mismo sha');
  });
  for (const [lib, b] of Object.entries(built)) {
    await check(`h5p.json: ${lib} declara exactamente la clausura de runtime del perfil (principal primero); solo h5p.json + content.json`, async () => {
      const buf = await h.buildContentOnlyH5p({ mainLibrary: b.mainLibrary, content: b.content, title: b.title, language: 'es' });
      const { names, out } = await unzip(buf);
      assertDeepEqual(names, ['content/content.json', 'h5p.json'], 'entradas');
      const hj = JSON.parse(out['h5p.json']);
      assertEqual(hj.mainLibrary, lib, 'mainLibrary');
      assertEqual(hj.language, 'es', 'language');
      const k = (r) => `${r.machineName} ${r.majorVersion}.${r.minorVersion}`;
      assertEqual(k(hj.preloadedDependencies[0]), k(P.mainLibraries[lib]), 'principal primero');
      assertDeepEqual(hj.preloadedDependencies.map(k).sort(), P.closureByMain[lib].runtime.map(k).sort(), 'deps = runtime');
      assert(hj.preloadedDependencies.every((d) => d.patchVersion === undefined), 'h5p.json no lleva patch');
      assertDeepEqual(JSON.parse(out['content/content.json']), b.content, 'content.json');
    });
  }
  await check('paquete: falla fuerte ante librería principal fuera del perfil o sub-contenido no declarado', async () => {
    let err = null;
    try {
      await h.buildContentOnlyH5p({ mainLibrary: 'H5P.CoursePresentation', content: {}, title: 'x', language: 'es' });
    } catch (e) {
      err = e;
    }
    assert(err && /H5P_PROFILE_UNKNOWN_MAIN_LIBRARY/.test(err.message), `sin error: ${err && err.message}`);
    err = null;
    try {
      await h.buildContentOnlyH5p({ mainLibrary: 'H5P.DragText', content: { x: { library: 'H5P.Summary 1.10', params: {} } }, title: 'x', language: 'es' });
    } catch (e) {
      err = e;
    }
    assert(err && /H5P_PACKAGE_UNDECLARED_LIBRARY: H5P\.Summary 1\.10/.test(err.message), `sin error: ${err && err.message}`);
  });
  await check('paquete autocontenido: exige exactamente los archivos de la clausura full', async () => {
    const b = built['H5P.DragText'];
    let err = null;
    try {
      await h.buildSelfContainedH5p({ ...b, language: 'es', libraryFiles: { 'H5P.DragText-1.10/library.json': Buffer.from('{}') } });
    } catch (e) {
      err = e;
    }
    assert(err && /H5P_PACKAGE_MISSING_LIBRARY_FILES/.test(err.message), `sin error: ${err && err.message}`);
    err = null;
    try {
      await h.buildSelfContainedH5p({ ...b, language: 'es', libraryFiles: { 'H5P.Accordion-1.0/library.json': Buffer.from('{}') } });
    } catch (e) {
      err = e;
    }
    assert(err && /H5P_PACKAGE_UNEXPECTED_LIBRARY_FILE/.test(err.message), `sin error: ${err && err.message}`);
  });

  if (failures > 0) {
    console.error(`\n${failures} check(s) fallaron.`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(`❌ error inesperado: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
