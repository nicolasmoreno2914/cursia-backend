#!/usr/bin/env node
/* eslint-disable */
// Cursia EV6 — H5P pack v2, tarea H1: checks PUROS (sin DB, sin red, sin Moodle).
//
//  1. Store de librerías assets/h5p-libs/v2 + manifest (sha256, versión upstream, licencia, repo)
//     + LICENSES.md; perfil v2 regenerado (fixture v1 ∪ store) = JSON committed; v1 intacto.
//  2. buildBundledH5p: delta exacta, bytes determinísticos (mismo proceso y otro proceso),
//     falla fuerte H5P_PACKAGE_MISSING_LIBRARY_FILES (archivo / carpeta faltante, sha distinto).
//  3. Branching Scenario: grafo válido, TODOS los códigos BS_*, finales 10/7/0, mapeo H5P
//     (feedback en todo nodo, -1 solo con endScreenScore), l10n español y conformidad con
//     semantics; validateH5pActivityPayload solo con activityTypeRules=2.
//  4. IV avanzado: planReflectionPauses (d<180, 180–299, ≥300, choques → droppedReflections),
//     video_interactions schemaVersion 2 contra la duración MEDIDA, remediación del plan,
//     H5P.Text en h5p.json solo con pausas.
//  5. Dialog Cards desde la experiencia (4–12; < 4 → null), determinístico.
//  6. mbz-validator-v3: acepta la delta y rechaza carpetas de más / de menos / versión distinta.
//  7. H5P_MOODLE_GRADING (BS calificable, DC no) y golden byte-identity de paquetes legacy.
//
// Uso: npm run build && node scripts/check-ev6-h5p2-contracts.js [--libs <libsDir>]
//   --libs (o H5P_LIBS_DIR): además compara el store contra la carpeta completa de librerías.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
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
const V3V = L('modules/course-shell/v3-validation.js');
const V = L('package/v3/mbz-validator-v3.js');
const B = L('package/dynamic-mbz-builder-v3.js');
const PF = require('./lib/v21-packaging-fixtures');
const VF = require('./lib/v21-video-fixture');
const VCF = require('./lib/v21-vc-fixtures');
const GOLD = require('./lib/h5p2-golden-legacy');

const STORE = path.join(ROOT, 'assets/h5p-libs/v2');
const FIXTURE_V1 = path.join(ROOT, 'test/fixtures/h5p-profile-v1/libs');
const PROFILE_V1_JSON = path.join(ROOT, 'src/package/h5p/cursia-h5p-profile.v1.json');
const PROFILE_V2_JSON = path.join(ROOT, 'src/package/h5p/cursia-h5p-profile.v2.json');
const argLibs = process.argv.indexOf('--libs');
const FULL_LIBS = argLibs >= 0 ? process.argv[argLibs + 1] : process.env.H5P_LIBS_DIR || null;

/**
 * Huellas sha256 de los paquetes LEGACY capturadas en el commit base (origin/staging bf44a9f,
 * antes de H5P v2) con `node scripts/lib/h5p2-golden-legacy.js`. H5P v2 no puede cambiar ni un byte.
 */
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
  // V542 (builder 3.6.0 → 3.8.0) cambia el .mbz a propósito: I4 `<reviewattempt>` de cada quiz.xml e I2 una sola
  // copia del .h5p por h5pactivity (h5pactivity.xml/inforef.xml, renumeración de ids en inforef.xml y files.xml;
  // ningún blob cambia — scratchpad/r18/v542fix/mbzdiff.js contra staging b959a89). Dorados anteriores (staging):
  // h5p-final-light 46c6eb95…, scorm-nofinal-dark ab7c5f58…, h5p-nofinal-dark-mock-cleansafe 2c074a37…,
  // scorm-final-light 68738242…, h5p-ev5c-rules1 9c3ede4f….
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
  mbz: {
    'h5p-final-light': 'ef14a6aff868d846d04839d88ee444050eef4b793dee035d855439d58e8964d4',
    'scorm-nofinal-dark': 'b967577f1cf7d78ab87a70442335d7cd636113e6774607a6d6e9480d8759e4c6',
    'h5p-nofinal-dark-mock-cleansafe': '715aa10f91b945f21f06904c46988c0f7baf91e44c9e646bdec30682676e7371',
    'scorm-final-light': '6c18bcced0c41fa4a59fe91529c077e0d53aa759bffcc69725d8bbb9d5897fa9',
    'h5p-ev5c-rules1': '4e5d160266833e479b86a891a3dab1e50c91baa0f9dc2a7eb5118ad650b6d51d',
  },
};

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
  if (x !== y) throw new Error(`${m}: esperado ${y.slice(0, 500)}, encontrado ${x.slice(0, 500)}`);
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
  return err;
}
async function rejects(p, re, m) {
  let err = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  assert(err, `${m}: no lanzó`);
  assert(!re || re.test(err.message), `${m}: mensaje inesperado: ${err.message}`);
  return err;
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const dirName = (r) => `${r.machineName}-${r.majorVersion}.${r.minorVersion}`;
const clone = (o) => JSON.parse(JSON.stringify(o));
function readLibraryJsons(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name, 'library.json');
    if (fs.existsSync(p)) out[name] = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return out;
}
async function zipNames(buf) {
  const z = await JSZip.loadAsync(buf);
  return { z, names: Object.keys(z.files).filter((n) => !z.files[n].dir).sort() };
}

// ── semantics (store v2 + fixture v1) para l10n y conformidad ─────────────────
// H5P.AdvancedText 1.1 y H5P.Text 1.1 (v1, sin semantics en el fixture): un único campo
// html `text` sin default (verificado contra la carpeta de librerías local durante el diseño).
const INLINE_SEMANTICS = {
  'H5P.AdvancedText 1.1': [{ name: 'text', type: 'text', widget: 'html' }],
  'H5P.Text 1.1': [{ name: 'text', type: 'text', widget: 'html' }],
};
function semanticsByLibraryString(lib) {
  if (INLINE_SEMANTICS[lib]) return INLINE_SEMANTICS[lib];
  const m = /^(\S+) (\d+)\.(\d+)$/.exec(lib);
  const d = `${m[1]}-${m[2]}.${m[3]}`;
  for (const base of [STORE, FIXTURE_V1]) {
    const p = path.join(base, d, 'semantics.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error(`sin semantics.json para ${lib}`);
}
function walkL10n(fields, params, prefix, problems) {
  for (const f of fields) {
    const p = prefix ? `${prefix}.${f.name}` : f.name;
    const v = params ? params[f.name] : undefined;
    if (f.type === 'group' && f.fields) walkL10n(f.fields, v, p, problems);
    else if (f.type === 'list' && f.field) {
      if (!Array.isArray(v)) continue;
      v.forEach((item, i) => {
        if (f.field.type === 'group') walkL10n(f.field.fields, item, `${p}[${i}]`, problems);
        else walkL10n([{ ...f.field, name: String(i) }], { [String(i)]: item }, p, problems);
      });
    } else if (f.type === 'library') {
      if (!v || !v.library) continue;
      if (!h.isUuid(v.subContentId)) problems.push(`${p}: subContentId no UUID`);
      if (!v.metadata || !v.metadata.title) problems.push(`${p}: metadata.title vacío`);
      walkL10n(semanticsByLibraryString(v.library), v.params, `${p}<${v.library}>`, problems);
    } else if ((f.type === 'text' || f.type === 'textarea') && typeof f.default === 'string' && f.default !== '') {
      if (typeof v !== 'string' || v.trim() === '') problems.push(`${p} sin valor (quedaría "${f.default}")`);
      else if (v === f.default && !h.H5P_L10N_IDENTICAL_ALLOWLIST.includes(v)) problems.push(`${p} quedó en inglés ("${v}")`);
    }
  }
}
function walkConformance(fields, params, prefix, problems) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    problems.push(`${prefix || '$'}: se esperaba un objeto`);
    return;
  }
  const byName = new Map(fields.map((f) => [f.name, f]));
  for (const [k, v] of Object.entries(params)) {
    const p = prefix ? `${prefix}.${k}` : k;
    const f = byName.get(k);
    if (!f) problems.push(`${p}: no existe en semantics`);
    else checkValue(f, v, p, problems);
  }
}
function checkValue(f, v, p, problems) {
  if (f.type === 'group') {
    if (f.fields && f.fields.length === 1 && (typeof v !== 'object' || v === null || Array.isArray(v))) return checkValue(f.fields[0], v, `${p}.${f.fields[0].name}`, problems);
    walkConformance(f.fields || [], v, p, problems);
  } else if (f.type === 'list') {
    if (!Array.isArray(v)) problems.push(`${p}: se esperaba una lista`);
    else if (v.length === 0) problems.push(`${p}: lista vacía (H5P la elimina)`);
    else v.forEach((item, i) => checkValue(f.field, item, `${p}[${i}]`, problems));
  } else if (f.type === 'library') {
    const extra = Object.keys(v || {}).filter((k) => !['library', 'params', 'subContentId', 'metadata'].includes(k));
    if (extra.length) problems.push(`${p}: claves extra ${extra}`);
    if (!(f.options || []).includes(v.library)) problems.push(`${p}: librería ${v.library} no permitida`);
    else walkConformance(semanticsByLibraryString(v.library), v.params, `${p}<${v.library}>`, problems);
  } else if (f.type === 'select') {
    if (!(f.options || []).map((o) => o.value).includes(v)) problems.push(`${p}: valor ${JSON.stringify(v)} fuera del select`);
  } else if (f.type === 'boolean') {
    if (typeof v !== 'boolean') problems.push(`${p}: se esperaba booleano`);
  } else if (f.type === 'number') {
    if (typeof v !== 'number') problems.push(`${p}: se esperaba número`);
    else if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) problems.push(`${p}: ${v} fuera de [${f.min}, ${f.max}]`);
  } else if (f.type === 'text' || f.type === 'textarea') {
    if (typeof v !== 'string') problems.push(`${p}: se esperaba texto`);
  } else if (f.type === 'video') {
    if (!Array.isArray(v) || !v.length) problems.push(`${p}: video vacío`);
  } else if (f.type === 'image') {
    // #583 (I4): campo image (H5PContentValidator::validateFile): {path relativo a content/, mime de imagen, width, height}.
    const extra = Object.keys(v || {}).filter((k) => !['path', 'mime', 'width', 'height', 'copyright'].includes(k));
    if (extra.length) problems.push(`${p}: claves extra ${extra}`);
    if (typeof v?.path !== 'string' || /^[a-z]+:|\.\./i.test(v.path)) problems.push(`${p}: path inválido`);
    if (!['image/png', 'image/jpeg', 'image/gif'].includes(v?.mime)) problems.push(`${p}: mime ${v?.mime} fuera de los de un campo image`);
    if (!Number.isInteger(v?.width) || !Number.isInteger(v?.height)) problems.push(`${p}: width/height`);
  } else problems.push(`${p}: tipo ${f.type} no verificado`);
}
function lintAndConform(mainLib, content) {
  const ref = h.CURSIA_H5P_PROFILE_V2.mainLibraries[mainLib];
  const sem = semanticsByLibraryString(`${ref.machineName} ${ref.majorVersion}.${ref.minorVersion}`);
  const problems = [];
  walkL10n(sem, content, '', problems);
  walkConformance(sem, content, '', problems);
  return problems;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const IK = 'activity:7a1c0de0-0000-4000-8000-0000000000b5';
/** Fix round 1 (I-2): fuente exacta de la licencia de cada librería del store (el resto: library.json). */
const LICENCE_EXPECTED = {
  'H5P.ContinuousText-1.2': 'upstream repository verified 2026-10-01',
  'H5P.ExportableTextArea-1.3': 'upstream repository verified 2026-10-01',
  'H5PEditor.BranchingQuestion-1.0': 'upstream repository verified 2026-10-01',
  'H5PEditor.ImageCoordinateSelector-1.2': 'upstream repository verified 2026-10-01',
  'H5PEditor.RadioSelector-1.2': 'upstream repository verified 2026-10-01',
  'H5PEditor.Shape-1.0': 'upstream repository verified 2026-10-01',
  'H5PEditor.CoursePresentation-1.26': 'local LICENCE/README file',
};
/** Repos que el controlador verificó en línea el 2026-10-01. */
const REPO_VERIFIED = new Set(['h5p-continuous-text', 'h5p-exportable-text-area', 'h5p-editor-branching-question', 'h5p-editor-image-coordinate-selector', 'h5p-editor-radio-selector', 'h5p-editor-shape', 'h5p-drag-question', 'h5p-audio-recorder', 'h5p-shape']);
function bsData() {
  return {
    title: 'Caso: un cliente molesto en caja',
    situation:
      'Son las 18:00 en una tienda de Bogotá. Un cliente llega a caja con un producto defectuoso y la boleta vencida hace 2 días.\nEstá levantando la voz y hay fila detrás.',
    decisions: [
      {
        id: 'd1',
        question: '¿Qué haces primero?',
        options: [
          { text: 'Lo escucho sin interrumpir y resumo su problema en voz alta.', next: 'd3', consequence: 'El cliente baja la voz: se siente escuchado.' },
          { text: 'Le explico de inmediato la política de cambios.', next: 'd2' },
          { text: 'Llamo al supervisor y atiendo al siguiente de la fila.', next: 'end:e3' },
        ],
      },
      {
        id: 'd2',
        question: 'El cliente se molesta más: «¡No me importa la política!». ¿Qué haces?',
        options: [
          { text: 'Me disculpo por cómo empezamos y le pido que me cuente qué pasó.', next: 'd3' },
          { text: 'Repito la política con más firmeza.', next: 'end:e3', consequence: 'La tensión sube y la fila se impacienta.' },
        ],
      },
      {
        id: 'd3',
        question: 'Ya está más calmado. La boleta venció hace 2 días. ¿Qué ofreces?',
        options: [
          { text: 'Un cambio excepcional registrando el motivo, dentro de tu margen.', next: 'end:e1' },
          { text: 'Derivarlo a servicio técnico con un número de caso.', next: 'end:e2' },
        ],
      },
    ],
    endings: [
      { id: 'e1', quality: 'optimal', title: 'Final óptimo', text: 'Resolviste en el primer contacto y dejaste trazabilidad.' },
      { id: 'e2', quality: 'acceptable', title: 'Final aceptable', text: 'Diste una salida, pero el cliente debe volver.' },
      { id: 'e3', quality: 'poor', title: 'Final: conflicto', text: 'La conversación escaló. La política sin escucha no resuelve.' },
    ],
  };
}
const codes = (issues) => [...new Set(issues.map((i) => i.code))].sort();

function experienceWithCards(nConcept, nReveal, nSelf) {
  const e = { vcSchemaVersion: 1, chapterId: 'ch-x', movements: { opening: [], deepening: [], synthesis: [], closing: [], video_primer: [], self_check: [] }, bridge_to_next: 'x' };
  if (nConcept) e.movements.deepening.push({ type: 'concept_cards', cards: Array.from({ length: nConcept }, (_, i) => ({ term: `Término ${i + 1}`, definition: `Definición **clave** ${i + 1}` })) });
  if (nReveal) e.movements.synthesis.push({ type: 'reveal_cards', cards: Array.from({ length: nReveal }, (_, i) => ({ front: `Frente ${i + 1}`, back: `Reverso ${i + 1}` })) });
  if (nSelf) e.movements.self_check.push({ type: 'self_check', items: Array.from({ length: nSelf }, (_, i) => ({ q: `¿Pregunta ${i + 1}?`, a: `Respuesta ${i + 1}` })) });
  // Un componente que no aporta tarjetas, al principio.
  e.movements.opening.push({ type: 'hero', title: 'Hola', lead: 'x' });
  return e;
}

function v2Doc(durationSec, videoItemKey = 'video:ch9') {
  const plan = h.planInteractionCheckpoints(durationSec);
  const doc = VF.makeInteractionsDoc(plan, { videoItemKey, durationSec });
  doc.schemaVersion = 2;
  doc.reflections = h.planReflectionPauses(durationSec, plan).reflections.map((r) => ({ index: r.index, prompt: `¿Cómo aplicarías lo visto hasta el minuto ${Math.floor(r.atSec / 60)} en tu trabajo?`, hint: 'Piensa en un caso real.' }));
  return doc;
}

(async () => {
  const P1 = h.CURSIA_H5P_PROFILE_V1;
  const P2 = h.CURSIA_H5P_PROFILE_V2;
  const store = h.openH5pLibraryStore(P2);
  const BS_DELTA = [
    'H5P.AudioRecorder-1.0', 'H5P.BranchingQuestion-1.0', 'H5P.BranchingScenario-1.10', 'H5P.ContinuousText-1.2', 'H5P.CoursePresentation-1.27',
    'H5P.Dialogcards-1.9', 'H5P.DragQuestion-1.15', 'H5P.ExportableTextArea-1.3', 'H5P.ImageHotspots-1.10', 'H5P.InteractiveVideo-1.28',
    'H5P.Shape-1.0', 'H5P.TwitterUserFeed-1.0', 'H5PEditor.BranchingQuestion-1.0', 'H5PEditor.BranchingScenario-1.5',
    'H5PEditor.CoursePresentation-1.26', 'H5PEditor.ImageCoordinateSelector-1.2', 'H5PEditor.InteractiveVideo-1.26', 'H5PEditor.RadioSelector-1.2', 'H5PEditor.Shape-1.0',
  ];

  // ══ 1. Perfil v2 + store ═══════════════════════════════════════════════════
  await check('perfil v1 intacto: h5pProfileVersion = 1, regenerado desde el fixture = JSON committed', () => {
    eq(h.h5pProfileVersion, 1, 'h5pProfileVersion');
    eq(h.serializeH5pProfile(h.computeH5pProfile(readLibraryJsons(FIXTURE_V1))), fs.readFileSync(PROFILE_V1_JSON, 'utf8'), 'v1');
    assert(!('deltaByMain' in P1) && !('baseProfileId' in P1), 'v1 no lleva campos de v2');
  });
  await check('perfil v2 = regeneración desde (fixture v1 ∪ store v2) — generate-h5p-profile.js --profile v2', () => {
    const libs = { ...readLibraryJsons(FIXTURE_V1), ...readLibraryJsons(STORE) };
    eq(h.serializeH5pProfile(h.computeH5pProfile(libs, h.CURSIA_H5P_PROFILE_SPEC_V2)), fs.readFileSync(PROFILE_V2_JSON, 'utf8'), 'v2');
  });
  if (FULL_LIBS) {
    await check(`perfil v1/v2 regenerados desde ${FULL_LIBS} = JSON committed; store --check al día`, () => {
      const libs = readLibraryJsons(path.resolve(FULL_LIBS));
      eq(h.serializeH5pProfile(h.computeH5pProfile(libs)), fs.readFileSync(PROFILE_V1_JSON, 'utf8'), 'v1');
      eq(h.serializeH5pProfile(h.computeH5pProfile(libs, h.CURSIA_H5P_PROFILE_SPEC_V2)), fs.readFileSync(PROFILE_V2_JSON, 'utf8'), 'v2');
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/sync-h5p-library-store-v2.js'), FULL_LIBS, '--check'], { encoding: 'utf8' });
      assert(r.status === 0, `sync --check: ${r.stderr || r.stdout}`);
    });
  }
  await check('perfil v2: v1 ⊂ v2 (mismos patch), principales v1 iguales + BS 1.10.1 y DC 1.9.40; delta BS = 19 carpetas, DC = 1', () => {
    eq([P2.profileId, P2.version, P2.baseProfileId, h.h5pProfileVersionV2], ['CURSIA_H5P_PROFILE_V2', 2, 'CURSIA_H5P_PROFILE_V1', 2], 'ids');
    const v2 = new Map(P2.libraries.map((r) => [dirName(r), r.patchVersion]));
    for (const r of P1.libraries) eq(v2.get(dirName(r)), r.patchVersion, `v1 ${dirName(r)} en v2`);
    for (const [k, r] of Object.entries(P1.mainLibraries)) eq(P2.mainLibraries[k], r, `principal ${k}`);
    eq(P2.mainLibraries['H5P.BranchingScenario'], { machineName: 'H5P.BranchingScenario', majorVersion: 1, minorVersion: 10, patchVersion: 1 }, 'BS 1.10.1 (Q6)');
    eq(P2.mainLibraries['H5P.Dialogcards'], { machineName: 'H5P.Dialogcards', majorVersion: 1, minorVersion: 9, patchVersion: 40 }, 'DC 1.9.40');
    eq(h.profileBundledMainLibraries(P2), ['H5P.BranchingScenario', 'H5P.Dialogcards'], 'bundled');
    eq(h.profileDeltaDirs(P2, 'H5P.BranchingScenario'), BS_DELTA, 'delta BS');
    eq(h.profileDeltaDirs(P2, 'H5P.Dialogcards'), ['H5P.Dialogcards-1.9'], 'delta DC');
    eq(P2.libraries.length, P1.libraries.length + 19, 'v2 = v1 + 19');
    throws(() => h.profileDeltaDirs(P2, 'H5P.QuestionSet'), /H5P_PROFILE_NOT_BUNDLED_MAIN/, 'QS no bundled');
    throws(() => h.profileDeltaDirs(P1, 'H5P.BranchingScenario'), /H5P_PROFILE_NOT_BUNDLED_MAIN/, 'v1 sin delta');
  });
  await check('store v2: carpetas = delta; cada archivo existe y su sha256 = manifest; procedencia (repo h5p, MIT, fuente) en cada librería; LICENSES.md', () => {
    const m = store.manifest;
    eq([m.profileId, m.baseProfileId, m.profileSha256], ['CURSIA_H5P_PROFILE_V2', 'CURSIA_H5P_PROFILE_V1', sha256(fs.readFileSync(PROFILE_V2_JSON))], 'cabecera');
    eq(m.libraries.map((l) => l.dir), BS_DELTA, 'carpetas (la delta de DC ⊂ BS)');
    const onDisk = fs.readdirSync(STORE).filter((n) => fs.statSync(path.join(STORE, n)).isDirectory()).sort();
    eq(onDisk, BS_DELTA, 'carpetas en disco');
    const lic = fs.readFileSync(path.join(STORE, 'LICENSES.md'), 'utf8');
    assert(/Permission is hereby granted, free of charge/.test(lic), 'LICENSES.md sin texto MIT');
    let nfiles = 0;
    for (const l of m.libraries) {
      const ref = P2.libraries.find((r) => dirName(r) === l.dir);
      eq([l.machineName, l.majorVersion, l.minorVersion, l.patchVersion, l.upstreamVersion], [ref.machineName, ref.majorVersion, ref.minorVersion, ref.patchVersion, `${ref.majorVersion}.${ref.minorVersion}.${ref.patchVersion}`], `${l.dir} versión`);
      assert(/^https:\/\/github\.com\/h5p\/h5p-[a-z0-9-]+$/.test(l.repoUrl), `${l.dir} repoUrl ${l.repoUrl}`);
      eq([l.licence, l.licenceSource, l.repoUrlVerified], ['MIT', LICENCE_EXPECTED[l.dir] || 'library.json', REPO_VERIFIED.has(l.repoUrl.replace('https://github.com/h5p/', ''))], `${l.dir} licencia / fuente / repo verificado`);
      assert(lic.includes(`| ${l.machineName} | ${l.upstreamVersion} |`) && lic.includes(l.repoUrl), `${l.dir} no figura en LICENSES.md`);
      const lj = JSON.parse(fs.readFileSync(path.join(STORE, l.dir, 'library.json'), 'utf8'));
      eq([lj.machineName, lj.majorVersion, lj.minorVersion, lj.patchVersion], [l.machineName, l.majorVersion, l.minorVersion, l.patchVersion], `${l.dir} library.json`);
      const listed = l.files.map((f) => f.path).sort();
      const walk = (root, rel = '') => fs.readdirSync(path.join(root, rel)).sort().flatMap((n) => {
        const r = rel ? `${rel}/${n}` : n;
        return fs.statSync(path.join(root, r)).isDirectory() ? walk(root, r) : [r];
      });
      eq(walk(path.join(STORE, l.dir)).sort(), listed, `${l.dir} archivos en disco = manifest`);
      for (const f of l.files) {
        const b = fs.readFileSync(path.join(STORE, l.dir, f.path));
        assert(b.length === f.bytes && sha256(b) === f.sha256, `${l.dir}/${f.path} sha256`);
        nfiles++;
      }
    }
    assert(nfiles > 800, `solo ${nfiles} archivos`);
  });
  await check('sync del store (fix round 1, I-2): licencia de library.json o archivo local; si no hay, solo repos verificados; no-MIT o sin evidencia → falla', () => {
    const SY = require('./sync-h5p-library-store-v2.js');
    eq([...SY.UPSTREAM_VERIFIED_MIT].sort(), [...REPO_VERIFIED].sort(), 'repos verificados por el controlador');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h5p2-lic-'));
    try {
      const mk = (name, files) => {
        const d = path.join(tmp, name);
        fs.mkdirSync(d);
        for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t);
        return d;
      };
      const MIT = 'MIT License\n\nCopyright (c) 2020 Joubel AS\n\nPermission is hereby granted, free of charge, to any person…';
      eq(SY.licenceOf(mk('a', {}), { license: 'MIT' }, 'h5p-x', 'a').licenceSource, 'library.json', 'library.json');
      eq(SY.licenceOf(mk('b', { 'LICENCE.md': MIT }), {}, 'h5p-x', 'b').licenceSource, 'local LICENCE/README file', 'archivo local');
      eq(SY.licenceOf(mk('c', { 'README.md': '# X\n\n## License\n\n' + MIT }), {}, 'h5p-x', 'c').licenceSource, 'local LICENCE/README file', 'README con licencia');
      eq(SY.licenceOf(mk('d', { 'README.md': '# Sin licencia' }), {}, 'h5p-shape', 'd').licenceSource, 'upstream repository verified 2026-10-01', 'repo verificado');
      throws(() => SY.licenceOf(mk('e', {}), { license: 'GPL-3.0' }, 'h5p-shape', 'e'), /^H5P_STORE_LICENCE_MISMATCH: e library\.json license="GPL-3\.0"/, 'library.json no MIT');
      throws(() => SY.licenceOf(mk('f', { 'LICENSE': 'GNU GENERAL PUBLIC LICENSE Version 3' }), { license: 'MIT' }, 'h5p-x', 'f'), /^H5P_STORE_LICENCE_MISMATCH: f LICENSE no es MIT/, 'archivo local no MIT');
      throws(() => SY.licenceOf(mk('g', { 'README.md': '# X\n\n## License\n\nGPL' }), {}, 'h5p-shape', 'g'), /H5P_STORE_LICENCE_MISMATCH: g README\.md no es MIT/, 'README no MIT aunque el repo esté verificado');
      throws(() => SY.licenceOf(mk('h', {}), {}, 'h5p-image-hotspots', 'h'), /^H5P_STORE_LICENCE_MISSING: h /, 'sin evidencia y repo no verificado');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  await check('store: un manifest de otro perfil o desactualizado se rechaza (H5P_STORE_PROFILE_MISMATCH)', () => {
    throws(() => h.openH5pLibraryStore(P1), /H5P_STORE_PROFILE_MISMATCH/, 'perfil v1');
    const fake = JSON.parse(JSON.stringify(P2));
    fake.libraries = fake.libraries.slice(1);
    throws(() => h.openH5pLibraryStore(fake), /H5P_STORE_PROFILE_MISMATCH: manifest.profileSha256/, 'sha distinto');
  });

  // ══ 2. buildBundledH5p ═════════════════════════════════════════════════════
  const bsBuilt = h.buildBranchingScenario({ ...bsData(), itemKey: IK });
  const bundle = (built, libraryStore = store) =>
    h.buildBundledH5p({ mainLibrary: built.mainLibrary, content: built.content, title: built.title, language: 'es', profile: P2, libraryStore, ...(built.contentFiles ? { contentFiles: built.contentFiles } : {}) });
  const bsPkg = await bundle(bsBuilt);
  await check('buildBundledH5p BS: h5p.json + content.json + EXACTAMENTE las 19 carpetas delta con todos sus archivos; deps = runtime v2', async () => {
    const { z, names } = await zipNames(bsPkg);
    const tops = [...new Set(names.filter((n) => n !== 'h5p.json' && !n.startsWith('content/')).map((n) => n.split('/')[0]))].sort();
    eq(tops, BS_DELTA, 'carpetas');
    // #583 (I4): + la imagen de cada final (óptimo / aceptable / malo) en content/images/.
    eq(names.filter((n) => n === 'h5p.json' || n.startsWith('content/')), ['content/content.json', 'content/images/cursia-final-acceptable.png', 'content/images/cursia-final-optimal.png', 'content/images/cursia-final-poor.png', 'h5p.json'], 'contenido');
    const nLib = store.manifest.libraries.reduce((a, l) => a + l.files.length, 0);
    // EV6 H5P v2 (H2, m-8): + un LICENSE.txt (aviso MIT) por carpeta delta.
    eq(names.length, nLib + 2 + 3 + BS_DELTA.length, 'cantidad de entradas');
    for (const d of BS_DELTA) {
      const notice = await z.file(`${d}/LICENSE.txt`).async('string');
      const e = store.manifest.libraries.find((l) => l.dir === d);
      assert(notice.startsWith(`${e.machineName} ${e.upstreamVersion} — MIT License\nCopyright (c) ${e.copyrightHolder}\nUpstream: ${e.repoUrl}\nLicence evidence: ${e.licenceSource}\n`), `${d}: aviso`);
      assert(notice.includes('Permission is hereby granted, free of charge'), `${d}: texto MIT`);
    }
    for (const l of store.manifest.libraries) for (const f of l.files.slice(0, 3)) eq(sha256(await z.file(`${l.dir}/${f.path}`).async('nodebuffer')), f.sha256, `${l.dir}/${f.path}`);
    const hj = JSON.parse(await z.file('h5p.json').async('string'));
    eq(hj.mainLibrary, 'H5P.BranchingScenario', 'main');
    eq(hj.preloadedDependencies.map((d) => `${d.machineName} ${d.majorVersion}.${d.minorVersion}`), ['H5P.BranchingScenario 1.10', 'FontAwesome 4.5', 'H5P.AdvancedText 1.1', 'H5P.BranchingQuestion 1.0'], 'deps');
    assert(bsPkg.length > 1024 * 1024 && bsPkg.length < 5 * 1024 * 1024, `tamaño ${bsPkg.length}`);
  });
  await check('buildBundledH5p: bytes determinísticos (dos builds, store reabierto y OTRO proceso node)', async () => {
    const again = await bundle(h.buildBranchingScenario({ ...bsData(), itemKey: IK }), h.openH5pLibraryStore(P2));
    eq(sha256(again), sha256(bsPkg), 'mismo proceso');
    const code =
      `require('reflect-metadata');const h=require(${JSON.stringify(path.join(distRoot, 'package/h5p/index.js'))});` +
      `const d=${JSON.stringify({ ...bsData(), itemKey: IK })};const b=h.buildBranchingScenario(d);` +
      `h.buildBundledH5p({mainLibrary:b.mainLibrary,content:b.content,title:b.title,language:'es',profile:h.CURSIA_H5P_PROFILE_V2,libraryStore:h.openH5pLibraryStore(h.CURSIA_H5P_PROFILE_V2),contentFiles:b.contentFiles})` +
      `.then(x=>process.stdout.write(require('crypto').createHash('sha256').update(x).digest('hex'))).catch(e=>{console.error(e);process.exit(1)})`;
    const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TZ: 'Pacific/Auckland' } });
    assert(r.status === 0, r.stderr);
    eq(r.stdout, sha256(bsPkg), 'otro proceso (TZ distinta)');
  });
  await check('buildBundledH5p falla fuerte H5P_PACKAGE_MISSING_LIBRARY_FILES: archivo faltante, carpeta faltante, sha distinto, store sin la carpeta', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h5p2-store-'));
    try {
      fs.cpSync(STORE, tmp, { recursive: true });
      const victim = store.manifest.libraries.find((l) => l.dir === 'H5PEditor.Shape-1.0');
      fs.rmSync(path.join(tmp, victim.dir, victim.files[0].path));
      await rejects(bundle(bsBuilt, h.openH5pLibraryStore(P2, tmp)), /^H5P_PACKAGE_MISSING_LIBRARY_FILES: H5PEditor\.Shape-1\.0\/.* \(falta\)/, 'archivo');
      fs.rmSync(path.join(tmp, 'H5P.Dialogcards-1.9'), { recursive: true });
      const dcBuilt = h.buildDialogCardsFromExperience({ chapterTitle: 'Atención', experience: experienceWithCards(4, 0, 0) });
      await rejects(bundle(dcBuilt, h.openH5pLibraryStore(P2, tmp)), /^H5P_PACKAGE_MISSING_LIBRARY_FILES: H5P\.Dialogcards-1\.9\/ \(carpeta faltante\)$/, 'carpeta');
      fs.cpSync(path.join(STORE, 'H5P.Dialogcards-1.9'), path.join(tmp, 'H5P.Dialogcards-1.9'), { recursive: true });
      fs.appendFileSync(path.join(tmp, 'H5P.Dialogcards-1.9', 'library.json'), ' ');
      await rejects(bundle(dcBuilt, h.openH5pLibraryStore(P2, tmp)), /H5P_PACKAGE_MISSING_LIBRARY_FILES: H5P\.Dialogcards-1\.9\/library\.json \(sha256 distinto\)/, 'sha');
      const holey = { profileId: P2.profileId, libraryFiles: (d) => (d === 'H5P.Shape-1.0' ? null : store.libraryFiles(d)) };
      await rejects(bundle(bsBuilt, holey), /^H5P_PACKAGE_MISSING_LIBRARY_FILES: H5P\.Shape-1\.0$/, 'store sin carpeta');
      await rejects(h.buildBundledH5p({ ...bsBuilt, language: 'es', profile: P2, libraryStore: undefined }), /H5P_PACKAGE_INVALID/, 'sin store');
      await rejects(h.buildBundledH5p({ ...bsBuilt, language: 'es', profile: P1, libraryStore: store }), /deltaByMain/, 'perfil v1');
      const qs = h.buildQuestionSet({ itemKey: 'activity:q', title: 'QS', passPercentage: 70, questions: [{ kind: 'truefalse', question: 'A', correct: true }, { kind: 'truefalse', question: 'B', correct: false }] });
      await rejects(h.buildBundledH5p({ mainLibrary: qs.mainLibrary, content: qs.content, title: qs.title, language: 'es', profile: P2, libraryStore: store }), /H5P_PROFILE_NOT_BUNDLED_MAIN/, 'QS');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ══ 3. Branching Scenario ══════════════════════════════════════════════════
  await check('BS válido: sin hallazgos; mapeo H5P (nodo 0 → 1, -1 solo con endScreenScore 10/7/0, feedback en todo nodo, p2 UUIDs, maxScore 10)', () => {
    eq(h.validateBranchingScenarioData(bsData()), [], 'issues');
    const c = bsBuilt.content.branchingScenario;
    eq(c.content.length, 4, 'nodos');
    eq([c.content[0].type.library, c.content[0].nextContentId], ['H5P.AdvancedText 1.1', 1], 'nodo 0');
    for (const n of c.content) eq([typeof n.feedback, n.proceedButtonText, n.contentBehaviour, n.forceContentFinished, n.showContentTitle], ['object', 'Continuar', 'useBehavioural', 'useBehavioural', false], 'nodo');
    const alts = c.content.slice(1).map((n) => n.type.params.branchingQuestion.alternatives.map((a) => [a.nextContentId, a.feedback.endScreenScore ?? null]));
    eq(alts, [[[3, null], [2, null], [-1, 0]], [[3, null], [-1, 0]], [[-1, 10], [-1, 7]]], 'aristas y puntajes (d2 y d1 convergen en d3)');
    eq(c.content[1].type.params.branchingQuestion.alternatives[0].feedback, { title: '<p>Consecuencia de tu decisión</p>', subtitle: '<p>El cliente baja la voz: se siente escuchado.</p>' }, 'consecuencia intermedia');
    eq(c.content[2].type.params.branchingQuestion.alternatives[1].feedback.subtitle, '<p>La tensión sube y la fila se impacienta.</p><p>La conversación escaló. La política sin escucha no resuelve.</p>', 'consecuencia + final');
    eq(c.content[0].type.params.text, '<p>Son las 18:00 en una tienda de Bogotá. Un cliente llega a caja con un producto defectuoso y la boleta vencida hace 2 días.</p><p>Está levantando la voz y hay fila detrás.</p>', 'situación');
    eq(c.scoringOptionGroup, { scoringOption: 'static-end-score', includeInteractionsScores: false }, 'puntaje');
    eq(bsBuilt.maxScore, 10, 'maxScore');
    eq(bsBuilt.subContentIds, [0, 1, 2, 3].map((i) => h.h5pSubContentId(IK, i, 2)), 'subContentIds p2');
    eq(h.assertH5pSubContentIds('H5P.BranchingScenario', bsBuilt.content).length, 4, 'UUID únicos');
  });
  await check('BS: l10n 100 % español (ningún default inglés) y conformidad con semantics de BS 1.10 / BQ 1.0 (store)', () => {
    eq(lintAndConform('H5P.BranchingScenario', bsBuilt.content), [], 'problemas');
  });
  await check('BS finales: óptimo 10 → 100 aprueba, aceptable 7 → 70 aprueba (pass 70, ruling Q3), malo 0 reprueba', () => {
    eq(h.BRANCHING_SCENARIO_ENDING_SCORES, { optimal: 10, acceptable: 7, poor: 0 }, 'puntajes');
    const grade = (q) => (100 * h.BRANCHING_SCENARIO_ENDING_SCORES[q]) / h.BRANCHING_SCENARIO_MAX_SCORE;
    eq([grade('optimal') >= 70, grade('acceptable') >= 70, grade('poor') >= 70], [true, true, false], 'aprobación');
  });
  const bsCases = [
    ['BS_SHAPE', (d) => { d.decisions = [d.decisions[0]]; }],
    ['BS_SHAPE', (d) => { d.decisions[1].id = 'd1'; }],
    ['BS_SHAPE', (d) => { d.endings[0].quality = 'excelente'; }],
    ['BS_SHAPE', (d) => { d.extra = 1; }],
    ['BS_TEXT', (d) => { d.situation = 'x'.repeat(701); }],
    ['BS_TEXT', (d) => { d.decisions[0].question = '<b>¿Qué haces?</b>'; }],
    ['BS_TEXT', (d) => { d.decisions[0].options[0].consequence = 'y'.repeat(251); }],
    ['BS_REF', (d) => { d.decisions[0].options[2].next = 'end:e9'; }],
    ['BS_REF', (d) => { d.decisions[0].options[1].next = 'd5'; }],
    ['BS_REF', (d) => { d.decisions[0].options[1].next = 'saltar'; }],
    ['BS_FORWARD_ONLY', (d) => { d.decisions[2].options[0].next = 'd1'; }],
    ['BS_FORWARD_ONLY', (d) => { d.decisions[1].options[0].next = 'd2'; }],
    ['BS_UNREACHABLE', (d) => { d.decisions[0].options[1].next = 'd3'; }],
    ['BS_UNREACHABLE', (d) => { d.endings.push({ id: 'e4', quality: 'poor', title: 'Huérfano', text: 'Nadie llega aquí.' }); }],
    ['BS_DEAD_END', (d) => { delete d.decisions[1].options[1].next; }],
    ['BS_DEAD_END', (d) => { d.decisions[1].options[1].next = ' '; }],
    ['BS_ENDINGS', (d) => { d.endings[2].quality = 'acceptable'; }],
    ['BS_ENDINGS', (d) => { d.decisions[2].options[0].next = 'end:e2'; d.decisions[0].options[2].next = 'end:e1'; }],
    ['BS_ENDINGS', (d) => { d.endings[1].quality = 'optimal'; d.endings.push({ id: 'e4', quality: 'optimal', title: 'Otro', text: 'x.' }); d.decisions[1].options[1].next = 'end:e4'; d.decisions[1].options.push({ text: 'Tercera.', next: 'end:e3' }); }],
    ['BS_DUP_OPTION', (d) => { d.decisions[2].options[1].text = '  un cambio EXCEPCIONAL registrando el motivo,  dentro de tu margen. '; }],
    ['BS_DEPTH', (d) => { d.decisions[0].options = [{ text: 'A.', next: 'end:e1' }, { text: 'B.', next: 'end:e2' }]; d.decisions.length = 1; d.decisions.push({ id: 'd2', question: '¿Y?', options: [{ text: 'C.', next: 'end:e3' }, { text: 'D.', next: 'end:e1' }] }); }],
  ];
  await check(`BS inválidos: cada caso produce su código (${[...new Set(bsCases.map((c) => c[0]))].join(', ')})`, () => {
    for (const [code, mut] of bsCases) {
      const d = bsData();
      mut(d);
      const got = codes(h.validateBranchingScenarioData(d));
      assert(got.includes(code), `${code} esperado, hallado ${JSON.stringify(got)} para ${mut.toString().slice(0, 120)}`);
    }
  });
  await check('BS (fix round 1, m-2/m-7): una arista inválida da SOLO su código (sin inalcanzables/profundidad derivados); mensaje con posición', () => {
    const d = bsData();
    d.decisions[0].options[0].next = ' d3';
    eq(codes(h.validateBranchingScenarioData(d)), ['BS_REF'], 'solo BS_REF');
    const f = bsData();
    f.decisions[1].options[0].next = 'd1';
    eq(codes(h.validateBranchingScenarioData(f)), ['BS_FORWARD_ONLY'], 'solo BS_FORWARD_ONLY');
    const u = bsData();
    u.decisions[0].options[1].next = 'd3';
    eq(h.validateBranchingScenarioData(u).find((i) => i.code === 'BS_UNREACHABLE').message, 'la decisión d2 (posición 2) no se alcanza desde la situación', 'mensaje');
  });
  await check('BS_PATHS (> 16 caminos), BS_DEPTH (camino de 6 decisiones) y BS_NODES (> 8 nodos)', () => {
    const chain = () => {
      const d = bsData();
      d.decisions = Array.from({ length: 6 }, (_, i) => ({
        id: `d${i + 1}`,
        question: `¿Decisión ${i + 1}?`,
        options: [
          ...(i < 5 ? [{ text: 'Avanzar uno.', next: `d${i + 2}` }] : [{ text: 'Cerrar bien.', next: 'end:e1' }]),
          ...(i < 4 ? [{ text: 'Avanzar dos.', next: `d${i + 3}` }] : [{ text: 'Cerrar regular.', next: 'end:e2' }]),
          { text: 'Abandonar.', next: 'end:e3' },
        ],
      }));
      return d;
    };
    const got = codes(h.validateBranchingScenarioData(chain()));
    assert(got.includes('BS_PATHS') && got.includes('BS_DEPTH'), JSON.stringify(got));
    const big = bsData();
    big.decisions = Array.from({ length: 8 }, (_, i) => ({ id: `d${i + 1}`, question: '¿?', options: [{ text: 'a', next: 'end:e1' }, { text: 'b', next: 'end:e3' }] }));
    const g2 = codes(h.validateBranchingScenarioData(big));
    assert(g2.includes('BS_NODES') && g2.includes('BS_SHAPE'), JSON.stringify(g2));
    const c = clone(bsBuilt.content);
    c.branchingScenario.content.push(...Array.from({ length: 5 }, () => clone(c.branchingScenario.content[1])));
    throws(() => h.assertBranchingScenarioContent(c), /H5P_BS_INVARIANT: 9 nodos/, 'invariante 8 nodos');
  });
  await check('BS invariantes del empaque: -1 sin endScreenScore, nodo sin feedback, arista hacia atrás → H5P_BS_INVARIANT', () => {
    const mk = (f) => { const c = clone(bsBuilt.content); f(c.branchingScenario.content); return c; };
    throws(() => h.assertBranchingScenarioContent(mk((n) => { delete n[3].type.params.branchingQuestion.alternatives[0].feedback.endScreenScore; })), /-1 sin endScreenScore/, '-1');
    throws(() => h.assertBranchingScenarioContent(mk((n) => { delete n[0].feedback; })), /nodo 0 sin feedback/, 'feedback');
    throws(() => h.assertBranchingScenarioContent(mk((n) => { n[3].type.params.branchingQuestion.alternatives[0].nextContentId = 1; })), /fuera de rango/, 'atrás');
    throws(() => h.buildBranchingScenario({ ...bsData(), itemKey: 'activity#x' }), /H5P_INPUT_INVALID\(BranchingScenario\)/, 'itemKey');
  });
  await check('validateH5pActivityPayload: branchingscenario SOLO con activityTypeRules=2; legacy sin cambios; RESOURCE_MENTION', () => {
    const payload = { type: 'branchingscenario', data: { ...bsData(), itemKey: IK } };
    const base = { chapterId: 'ch-1', itemKey: IK };
    eq(SHELL.validateH5pActivityPayload(payload, { ...base, expectedType: 'branchingscenario', activityTypeRules: 2 }), { ok: true, errors: [] }, 'rules 2');
    for (const rules of [undefined, 0, 1]) {
      const r = SHELL.validateH5pActivityPayload(payload, { ...base, expectedType: 'questionset', ...(rules !== undefined ? { activityTypeRules: rules } : {}) });
      eq(r.errors.map((e) => e.code), ['ACTIVITY_TYPE_UNKNOWN'], `rules ${rules}: tipo desconocido como antes`);
      const r2 = SHELL.validateH5pActivityPayload(payload, { ...base, expectedType: 'branchingscenario', ...(rules !== undefined ? { activityTypeRules: rules } : {}) });
      eq(r2.errors.map((e) => e.code), ['ACTIVITY_TYPE_RULES'], `rules ${rules}: tipo esperado BS sin marcador`);
    }
    const mism = SHELL.validateH5pActivityPayload(payload, { ...base, expectedType: 'questionset', activityTypeRules: 2 });
    eq(mism.errors.map((e) => e.code), ['ACTIVITY_TYPE_MISMATCH'], 'BS cuando el Manifest pide QS');
    const bad = clone(payload);
    bad.data.decisions[1].options[0].next = 'd1';
    bad.data.situation = 'Como viste en el video del módulo, un cliente llega a caja.';
    const rb = SHELL.validateH5pActivityPayload(bad, { ...base, expectedType: 'branchingscenario', activityTypeRules: 2 });
    eq([...new Set(rb.errors.map((e) => e.code))].sort(), ['BS_FORWARD_ONLY', 'RESOURCE_MENTION'], 'códigos');
    assert(rb.errors.find((e) => e.code === 'BS_FORWARD_ONLY').path === '$.data.decisions[1].options[0].next', 'ruta');
    // Legacy: un QS válido sigue OK, con y sin marcador.
    const qs = { type: 'questionset', data: { title: 'T', questions: [{ kind: 'truefalse', question: 'A', correct: true }, { kind: 'truefalse', question: 'B', correct: false }] } };
    eq(SHELL.validateH5pActivityPayload(qs, { ...base, expectedType: 'questionset' }), { ok: true, errors: [] }, 'QS legacy');
    eq(SHELL.validateH5pActivityPayload(qs, { ...base, expectedType: 'questionset', activityTypeRules: 2 }), { ok: true, errors: [] }, 'QS rules 2');
    // validateV3ItemArtifact pasa el marcador.
    const ctx = { type: 'activity', variant: 'h5p', itemKey: IK, chapterId: 'ch-1', expectedActivityType: 'branchingscenario' };
    eq(V3V.validateV3ItemArtifact({ ...ctx, activityTypeRules: 2 }, JSON.stringify(payload)).ok, true, 'v3 rules 2');
    eq(V3V.validateV3ItemArtifact(ctx, JSON.stringify(payload)).errors.map((e) => e.code), ['ACTIVITY_TYPE_RULES'], 'v3 sin marcador');
  });

  // ══ 4. IV avanzado ═════════════════════════════════════════════════════════
  await check('planReflectionPauses: d<180 → 0; 180–299 → 1; ≥300 → 2; posición = punto medio de las ranuras ⌈n/3⌉, ⌈2n/3⌉', () => {
    const at = (d) => h.planReflectionPauses(d, h.planInteractionCheckpoints(d));
    eq([140, 179].map((d) => at(d).reflections.length), [0, 0], 'd<180');
    eq([180, 240, 299].map((d) => at(d).reflections.length), [1, 1, 1], '180–299');
    eq([300, 468, 1200, 14400].map((d) => at(d).reflections.length), [2, 2, 2, 2], '≥300');
    const cp = h.planInteractionCheckpoints(180);
    eq(at(180).reflections, [{ index: 1, atSec: Math.round((cp[0].atSec + cp[1].atSec) / 2), afterCheckpoint: 1 }], '180 s');
    const cp4 = h.planInteractionCheckpoints(468); // n = 5 → ranuras 2 y 4
    eq(cp4.length, 5, 'n(468)');
    eq(at(468).reflections.map((r) => [r.index, r.afterCheckpoint, r.atSec]), [[1, 2, Math.round((cp4[1].atSec + cp4[2].atSec) / 2)], [2, 4, Math.round((cp4[3].atSec + cp4[4].atSec) / 2)]], '468 s');
    for (const d of [180, 240, 300, 468, 777, 1200, 3600, 14400]) {
      const p = at(d);
      eq(p.droppedReflections, [], `plan real ${d} s sin descartes`);
      const cps = h.planInteractionCheckpoints(d);
      for (const r of p.reflections) {
        assert(r.atSec >= 30 && r.atSec <= d - 15, `${d}: ventana`);
        for (const c of cps) assert(c.atSec <= r.atSec ? r.atSec >= c.atSec + 20 : c.atSec - r.atSec >= 10, `${d}: regla de 10 s con la pregunta ${c.index}`);
      }
    }
  });
  await check('planReflectionPauses: choques → droppedReflections (ventana de pregunta, pregunta siguiente, otra pausa, fuera de rango, sin checkpoint siguiente)', () => {
    const mk = (ats) => ats.map((a, i) => ({ index: i + 1, atSec: a, segment: [a - 5, a + 5] }));
    // d = 300 → 2 pausas. Ranuras sobre n = 3: k = 1 y 2.
    let p = h.planReflectionPauses(300, mk([100, 125, 200]));
    eq(p.reflections.map((r) => r.atSec), [163], 'ranura 2 queda');
    eq(p.droppedReflections.map((r) => [r.index, r.atSec, /pregunta 1/.test(r.reason)]), [[1, 113, true]], 'ranura 1 choca con la ventana de la pregunta 1');
    p = h.planReflectionPauses(300, mk([60, 100, 108]));
    eq(p.droppedReflections.map((r) => r.index), [2], 'ranura 2: a < 10 s de la pregunta siguiente / dentro de la ventana');
    p = h.planReflectionPauses(300, mk([60, 120]));
    eq(p.reflections.map((r) => r.atSec), [90], 'n = 2: ranuras 1 y 2');
    eq(p.droppedReflections.map((r) => [r.index, /no hay checkpoint 3/.test(r.reason)]), [[2, true]], 'sin checkpoint siguiente');
    p = h.planReflectionPauses(300, [{ index: 1, atSec: 20, segment: [0, 30] }, { index: 2, atSec: 24, segment: [20, 30] }, { index: 3, atSec: 290, segment: [280, 290] }]);
    eq(p.droppedReflections.map((r) => [r.index, /fuera de \[30, 285\]/.test(r.reason)]), [[1, true]], 'fuera de rango');
    eq(p.reflections.map((r) => r.atSec), [157], 'la otra queda');
    // Colisión entre pausas: ranuras sobre el mismo par (n = 1 → ⌈1/3⌉ = ⌈2/3⌉ = 1, sin siguiente) y pares distintos con el mismo punto medio.
    p = h.planReflectionPauses(300, [{ index: 1, atSec: 40, segment: [30, 50] }, { index: 2, atSec: 260, segment: [250, 270] }, { index: 3, atSec: 265, segment: [260, 270] }, { index: 4, atSec: 270, segment: [265, 275] }]);
    // n = 4 → ranuras 2 y 3: (260+265)/2 = 263 (choca con preguntas), (265+270)/2 = 268 (choca)
    eq(p.reflections, [], 'ambas descartadas');
    eq(p.droppedReflections.length, 2, 'dos descartes registrados');
    const collide = h.planReflectionPauses(300, [{ index: 1, atSec: 40, segment: [30, 50] }, { index: 2, atSec: 140, segment: [130, 150] }, { index: 3, atSec: 140, segment: [130, 150] }].map((c, i) => (i === 2 ? { ...c, atSec: 141 } : c)));
    assert(collide.droppedReflections.length >= 1, 'pausas a < 10 s entre sí o de una pregunta → descarte');
  });
  await check('video_interactions v2: válido con schemaVersion 2 exigido; v2 sin marcador rechazado; v1 bajo marcador rechazado; reflexiones contra la duración MEDIDA', () => {
    const d = 468;
    const doc = v2Doc(d);
    const full = h.validateVideoInteractionsDocFull(doc, { videoItemKey: 'video:ch9', durationSec: d, schemaVersion: 2 });
    eq([full.checkpoints.length, full.reflectionPlan.reflections.length], [5, 2], 'plan');
    throws(() => h.validateVideoInteractionsDoc(doc, { videoItemKey: 'video:ch9', durationSec: d }), /schemaVersion: debe ser 1.*campo desconocido "reflections"|campo desconocido "reflections".*schemaVersion: debe ser 1/, 'v2 sin marcador');
    const v1 = VF.makeInteractionsDoc(h.planInteractionCheckpoints(d), { videoItemKey: 'video:ch9', durationSec: d });
    eq(h.validateVideoInteractionsDoc(v1, { videoItemKey: 'video:ch9', durationSec: d }).length, 5, 'v1 legacy');
    throws(() => h.validateVideoInteractionsDoc(v1, { durationSec: d, schemaVersion: 2 }), /schemaVersion: debe ser 2/, 'v1 bajo marcador');
    const few = clone(doc);
    few.reflections.pop();
    throws(() => h.validateVideoInteractionsDoc(few, { durationSec: d, schemaVersion: 2 }), /reflections: debe tener entre 2 y 2/, 'cantidad');
    const idx = clone(doc);
    idx.reflections[0].index = 2;
    throws(() => h.validateVideoInteractionsDoc(idx, { durationSec: d, schemaVersion: 2 }), /reflections\[0\]\.index: debe ser 1/, 'índice');
    const html = clone(doc);
    html.reflections[1].prompt = '<p>hola</p>';
    throws(() => h.validateVideoInteractionsDoc(html, { durationSec: d, schemaVersion: 2 }), /reflections\[1\]\.prompt: no se permite HTML/, 'HTML');
    // m-6: sin pausas planificadas (140 s) `reflections` puede omitirse o venir vacío.
    const noRef = v2Doc(140);
    delete noRef.reflections;
    eq(h.validateVideoInteractionsDocFull(noRef, { durationSec: 140, schemaVersion: 2 }).reflectionPlan.reflections, [], 'omitido con 0 pausas');
    eq(h.validateVideoInteractionsDocFull({ ...noRef, reflections: [] }, { durationSec: 140, schemaVersion: 2 }).checkpoints.length, 3, 'vacío con 0 pausas');
    const missing = clone(doc);
    delete missing.reflections;
    throws(() => h.validateVideoInteractionsDoc(missing, { durationSec: d, schemaVersion: 2 }), /reflections: debe ser una lista/, 'omitido con 2 pausas');
    // Documento del LLM con una duración inventada (300) ≠ medida (468) → rechazo.
    const liar = v2Doc(300);
    throws(() => h.validateVideoInteractionsDoc(liar, { durationSec: 468, schemaVersion: 2 }), /durationSec: debe coincidir con la duración real 468/, 'duración medida');
    // v3-validation: summary con reflexiones solo en v2; v1 igual que siempre.
    const ctx = { type: 'video_interactions', itemKey: 'video_interactions:ch9', video: { videoItemKey: 'video:ch9', durationSec: d } };
    eq(V3V.validateV3ItemArtifact(ctx, JSON.stringify(v1)), { ok: true, errors: [], summary: { interactionCount: 5 } }, 'v3 v1');
    eq(V3V.validateV3ItemArtifact({ ...ctx, videoInteractionsSchemaVersion: 2 }, JSON.stringify(doc)), { ok: true, errors: [], summary: { interactionCount: 5, reflectionCount: 2, droppedReflections: [] } }, 'v3 v2');
    eq(V3V.validateV3ItemArtifact(ctx, JSON.stringify(doc)).ok, false, 'v3 v2 sin marcador');
    // videoClaimFacts: sin ivAdvanced idéntico; con ivAdvanced lleva el plan.
    const claim = V3V.videoClaimFacts({ videoItemKey: 'video:ch9', outputSummary: { youtubeVideoId: 'IdwOipZAeqY', durationSec: d } });
    eq(Object.keys(claim.video), ['videoItemKey', 'youtubeId', 'durationSec', 'checkpoints'], 'claim legacy');
    const claim2 = V3V.videoClaimFacts({ videoItemKey: 'video:ch9', outputSummary: { youtubeVideoId: 'IdwOipZAeqY', durationSec: d }, ivAdvanced: true });
    eq(claim2.video.reflectionPlan, full.reflectionPlan, 'claim v2');
  });
  await check('buildVideoActivity ivAdvanced: remediación al inicio del segmento, pausas H5P.Text, H5P.Text en h5p.json solo con pausas, maxScore = preguntas, determinístico', async () => {
    const d = 468;
    const key = 'video:ch9';
    const r = await h.buildVideoActivity({ itemKey: key, title: 'Video', youtubeId: 'IdwOipZAeqY', durationSec: d, interactionsDoc: v2Doc(d, key), ivAdvanced: true });
    const r2 = await h.buildVideoActivity({ itemKey: key, title: 'Video', youtubeId: 'IdwOipZAeqY', durationSec: d, interactionsDoc: v2Doc(d, key), ivAdvanced: true });
    eq(r.sha256, r2.sha256, 'determinístico');
    eq([r.maxScore, r.interactionCount, r.reflections.length, r.droppedReflections.length], [5, 5, 2, 0], 'conteos');
    const { z } = await zipNames(r.h5p);
    const hj = JSON.parse(await z.file('h5p.json').async('string'));
    assert(hj.preloadedDependencies.some((x) => x.machineName === 'H5P.Text' && x.minorVersion === 1), 'H5P.Text en h5p.json');
    const c = JSON.parse(await z.file('content/content.json').async('string'));
    const ints = c.interactiveVideo.assets.interactions;
    eq(ints.map((i) => i.duration.from), [...ints.map((i) => i.duration.from)].sort((a, b) => a - b), 'orden por tiempo');
    const qs = ints.filter((i) => i.action.library !== 'H5P.Text 1.1');
    const texts = ints.filter((i) => i.action.library === 'H5P.Text 1.1');
    eq(texts.map((t) => t.duration.from), r.reflections.map((x) => x.atSec), 'pausas en el plan');
    for (const t of texts) {
      eq([t.pause, t.displayType], [true, 'poster'], 'pausa');
      assert(/^<p><strong>Pausa para pensar:<\/strong> /.test(t.action.params.text) && /<p><em>Pista:<\/em> Piensa en un caso real\.<\/p>$/.test(t.action.params.text), t.action.params.text);
    }
    qs.forEach((q, i) => {
      const cp = r.checkpoints[i];
      const pause = r.reflections.find((x) => x.atSec >= cp.segment[0] && x.atSec < cp.atSec);
      // m-1: con una pausa dentro del tramo, el salto va al fin de su ventana (no se re-pausa); si no, al inicio del tramo.
      eq(q.adaptivity.wrong.seekTo, pause ? pause.atSec + 10 : cp.segment[0], `seekTo ${i}`);
      assert(q.adaptivity.wrong.seekTo < cp.atSec, `seekTo ${i} antes de la pregunta`);
      eq([q.adaptivity.wrong.allowOptOut, q.adaptivity.wrong.seekLabel, q.adaptivity.requireCompletion, q.adaptivity.correct.allowOptOut], [true, 'Volver a ver este tramo', false, true], `adaptivity ${i}`);
      assert(q.adaptivity.wrong.message.length > 0, 'mensaje de remediación');
    });
    eq(r.reflections.filter((x) => qs.some((q, i) => x.atSec >= r.checkpoints[i].segment[0] && x.atSec < r.checkpoints[i].atSec)).length, 2, 'd=468: ambas pausas caen dentro de un tramo (caso m-1 ejercitado)');
    eq(c.override.retryButton, 'off', 'sin reintento');
    eq(h.assertH5pSubContentIds('H5P.InteractiveVideo', c).length, 7, 'UUID únicos (5 preguntas + 2 pausas)');
    eq(r.subContentIds, qs.map((q) => q.action.subContentId), 'subContentIds = preguntas (p1, igual que v1)');
    eq(r.subContentIds[0], h.h5pSubContentId(key, 0, 1), 'preguntas siguen en p1');
    const problems = [];
    walkConformance(semanticsByLibraryString('H5P.InteractiveVideo 1.27'), c, '', problems);
    eq(problems, [], 'conformidad IV');
    // Video de 140 s con ivAdvanced: 0 pausas ⇒ sin H5P.Text, pero con remediación.
    const short = await h.buildVideoActivity({ itemKey: key, title: 'Video', youtubeId: 'IdwOipZAeqY', durationSec: 140, interactionsDoc: v2Doc(140, key), ivAdvanced: true });
    const hs = JSON.parse(await (await JSZip.loadAsync(short.h5p)).file('h5p.json').async('string'));
    assert(!hs.preloadedDependencies.some((x) => x.machineName === 'H5P.Text'), 'sin pausas no declara H5P.Text');
    await rejects(h.buildVideoActivity({ itemKey: key, title: 'Video', youtubeId: 'IdwOipZAeqY', durationSec: d, interactionsDoc: v2Doc(d, key) }), /schemaVersion: debe ser 1/, 'v2 sin ivAdvanced');
  });

  // ══ 5. Dialog Cards ════════════════════════════════════════════════════════
  await check('Dialog Cards desde la experiencia: orden de la experiencia, 4–12, < 4 → null, **énfasis** → <strong>, l10n español + semantics DC 1.9', () => {
    eq(h.buildDialogCardsFromExperience({ chapterTitle: 'X', experience: experienceWithCards(2, 0, 1) }), null, '3 tarjetas → null');
    eq(h.buildDialogCardsFromExperience({ chapterTitle: 'X', experience: { movements: {} } }), null, 'sin tarjetas');
    const four = h.buildDialogCardsFromExperience({ chapterTitle: 'Atención al cliente', experience: experienceWithCards(2, 0, 2) });
    eq(four.cards.map((c) => [c.source, c.front]), [['concept_cards', 'Término 1'], ['concept_cards', 'Término 2'], ['self_check', '¿Pregunta 1?'], ['self_check', '¿Pregunta 2?']], '4 tarjetas en orden');
    eq(four.content.dialogs[0], { text: '<p style="text-align: center;">Término 1</p>', answer: '<p style="text-align: center;">Definición <strong>clave</strong> 1</p>', tips: { front: '', back: '' } }, 'tarjeta 1');
    eq([four.title, four.maxScore, four.subContentIds], ['Repaso: Atención al cliente', 0, []], 'meta');
    const many = h.buildDialogCardsFromExperience({ chapterTitle: 'X', experience: experienceWithCards(6, 6, 4) });
    eq(many.cards.length, 12, 'tope 12');
    eq(many.cards.map((c) => c.source).join(','), 'concept_cards,concept_cards,concept_cards,concept_cards,concept_cards,concept_cards,reveal_cards,reveal_cards,reveal_cards,reveal_cards,reveal_cards,reveal_cards', 'primeras 12 en orden');
    eq(JSON.stringify(h.buildDialogCardsFromExperience({ chapterTitle: 'X', experience: experienceWithCards(6, 6, 4) })), JSON.stringify(many), 'determinístico');
    const fx = h.buildDialogCardsFromExperience({ chapterTitle: 'Fixture', experience: VCF.buildExperience() });
    assert(fx && fx.cards.length >= 4, 'la experiencia fixture produce un mazo');
    eq(lintAndConform('H5P.Dialogcards', four.content), [], 'l10n + conformidad');
  });
  await check('Dialog Cards bundled: solo H5P.Dialogcards-1.9; deps = runtime v2 (todas en v1 salvo la principal)', async () => {
    const dc = h.buildDialogCardsFromExperience({ chapterTitle: 'Atención', experience: experienceWithCards(4, 0, 0) });
    const pkg = await bundle(dc);
    const { z, names } = await zipNames(pkg);
    eq([...new Set(names.filter((n) => n !== 'h5p.json' && !n.startsWith('content/')).map((n) => n.split('/')[0]))], ['H5P.Dialogcards-1.9'], 'carpetas');
    const hj = JSON.parse(await z.file('h5p.json').async('string'));
    const v1Keys = new Set(P1.libraries.map(dirName));
    eq(hj.preloadedDependencies.filter((x) => !v1Keys.has(dirName(x))).map(dirName), ['H5P.Dialogcards-1.9'], 'deps fuera de v1');
    eq(sha256(await bundle(dc)), sha256(pkg), 'determinístico');
  });

  // ══ 6. mbz-validator-v3 ════════════════════════════════════════════════════
  const baseCfg = GOLD.MBZ_CONFIGS[0];
  const base = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, baseCfg));
  async function swapActivityPackage(mbz, h5pBuf, mutateZip) {
    const z = await JSZip.loadAsync(mbz);
    const mb = await z.file('moodle_backup.xml').async('string');
    const filesXml = await z.file('files.xml').async('string');
    const acts = [...mb.matchAll(/<activity>[\s\S]*?<moduleid>(\d+)<\/moduleid>[\s\S]*?<modulename>h5pactivity<\/modulename>[\s\S]*?<directory>([^<]+)<\/directory>[\s\S]*?<\/activity>/g)];
    let target = null;
    for (const m of acts) {
      const mod = await z.file(`${m[2]}/module.xml`).async('string');
      const idn = /<idnumber>([^<]*)<\/idnumber>/.exec(mod)[1];
      if (/^cv3:ch:[^:]+:activity$/.test(idn)) {
        target = { dir: m[2], idnumber: idn, chapterId: idn.split(':')[2] };
        break;
      }
    }
    assert(target, 'sin actividad h5p de capítulo en el fixture');
    const blocks = [...filesXml.matchAll(/<file id="\d+">[\s\S]*?<\/file>/g)].map((x) => x[0]).filter((b) => /<component>mod_h5pactivity<\/component>/.test(b) && /<filearea>(package|intro)<\/filearea>/.test(b) && !/<filename>\.<\/filename>/.test(b));
    // El .h5p de ESTA actividad (V542 I2: solo `package`, sin copia en intro): ids de archivo de su inforef.xml.
    const inforef = await z.file(`${target.dir}/inforef.xml`).async('string');
    const ids = [...inforef.matchAll(/<id>(\d+)<\/id>/g)].map((x) => x[1]);
    const mine = blocks.filter((b) => ids.includes(/<file id="(\d+)">/.exec(b)[1]));
    eq(mine.length, 1, 'solo package');
    const oldHash = /<contenthash>([0-9a-f]+)<\/contenthash>/.exec(mine[0])[1];
    const buf = mutateZip ? await mutateZip(h5pBuf) : h5pBuf;
    const newHash = crypto.createHash('sha1').update(buf).digest('hex');
    let fx = filesXml;
    for (const b of mine) fx = fx.replace(b, b.replace(oldHash, newHash).replace(/<filesize>\d+<\/filesize>/, `<filesize>${buf.length}</filesize>`));
    z.file('files.xml', fx);
    z.remove(`files/${oldHash.slice(0, 2)}/${oldHash}`);
    z.file(`files/${newHash.slice(0, 2)}/${newHash}`, buf);
    return { mbz: await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), target };
  }
  const withType = (exp, chapterId, type) => ({ ...exp, facts: { ...exp.facts, chapters: exp.facts.chapters.map((c) => (c.id === chapterId ? { ...c, activityType: type } : c)) } });
  const h5pIssues = (v, idn) => v.issues.filter((i) => i.where === idn && /^H5P_/.test(i.code));

  await check('mbz-validator-v3: el .mbz legacy del fixture sigue sin hallazgos', async () => {
    const v = await V.validateMbzV3(base.mbz, base.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 5)));
  });
  await check('mbz-validator-v3 ACEPTA un BS bundled (3.7 MB, > memo de 1 MiB) con la delta exacta', async () => {
    const { mbz, target } = await swapActivityPackage(base.mbz, bsPkg);
    const v = await V.validateMbzV3(mbz, withType(base.expectations, target.chapterId, 'branchingscenario'));
    assert(v.ok, JSON.stringify(v.issues.slice(0, 5)));
    eq(v.stats.h5p > 0, true, 'stats');
  });
  await check('mbz-validator-v3 RECHAZA carpetas de más, de menos y library.json con otra versión; un QS con carpetas sigue "no content-only"', async () => {
    const mut = (fn) => async (buf) => {
      const z = await JSZip.loadAsync(buf);
      await fn(z);
      return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    };
    const exp = (t) => withType(base.expectations, t.chapterId, 'branchingscenario');
    let r = await swapActivityPackage(base.mbz, bsPkg, mut((z) => z.file('H5P.Text-1.1/library.json', '{}')));
    let v = await V.validateMbzV3(r.mbz, exp(r.target));
    eq(h5pIssues(v, r.target.idnumber).map((i) => i.message), ['carpetas fuera del delta v2 de H5P.BranchingScenario: H5P.Text-1.1'], 'carpeta de más');
    r = await swapActivityPackage(base.mbz, bsPkg, mut((z) => { for (const n of Object.keys(z.files)) if (n.startsWith('H5PEditor.Shape-1.0/')) z.remove(n); }));
    v = await V.validateMbzV3(r.mbz, exp(r.target));
    eq(h5pIssues(v, r.target.idnumber).map((i) => i.message), ['faltan carpetas de librería del delta v2: H5PEditor.Shape-1.0'], 'carpeta de menos');
    r = await swapActivityPackage(base.mbz, bsPkg, mut(async (z) => {
      const lj = JSON.parse(await z.file('H5P.Shape-1.0/library.json').async('string'));
      lj.patchVersion += 1;
      z.file('H5P.Shape-1.0/library.json', JSON.stringify(lj));
    }));
    v = await V.validateMbzV3(r.mbz, exp(r.target));
    eq(h5pIssues(v, r.target.idnumber).map((i) => i.message), ['H5P.Shape-1.0: library.json distinto del store (sha256)', 'H5P.Shape-1.0: library.json H5P.Shape 1.0.6 ≠ perfil v2 5'], 'versión');
    // m-3: archivos de la carpeta delta = los del store (uno de menos, uno de más).
    const shapeFile = store.manifest.libraries.find((l) => l.dir === 'H5P.Shape-1.0').files.find((f) => f.path !== 'library.json').path;
    r = await swapActivityPackage(base.mbz, bsPkg, mut((z) => { z.remove(`H5P.Shape-1.0/${shapeFile}`); z.file('H5P.Shape-1.0/extra.js', 'x'); }));
    v = await V.validateMbzV3(r.mbz, exp(r.target));
    eq(h5pIssues(v, r.target.idnumber).map((i) => i.message), [`H5P.Shape-1.0: faltan archivos del store: ${shapeFile}`, 'H5P.Shape-1.0: archivos que no están en el store: extra.js'], 'archivos');
    // I-1: dependencias declaradas ⊆ perfil v1 ∪ SU delta. Dialog Cards declarando BS 1.10 (de v2, pero no viaja en el paquete) → rechazo.
    const dcI1 = h.buildDialogCardsFromExperience({ chapterTitle: 'Atención', experience: experienceWithCards(4, 0, 0) });
    const withDep = (dep) => mut(async (z) => {
      const hj = JSON.parse(await z.file('h5p.json').async('string'));
      hj.preloadedDependencies.push(dep);
      z.file('h5p.json', JSON.stringify(hj));
    });
    r = await swapActivityPackage(base.mbz, await bundle(dcI1), withDep({ machineName: 'H5P.BranchingScenario', majorVersion: 1, minorVersion: 10 }));
    v = await V.validateMbzV3(r.mbz, base.expectations);
    assert(h5pIssues(v, r.target.idnumber).some((i) => i.message === 'dependencia ni en el perfil v1 ni en la delta de H5P.Dialogcards: H5P.BranchingScenario 1.10'), JSON.stringify(h5pIssues(v, r.target.idnumber)));
    r = await swapActivityPackage(base.mbz, bsPkg, withDep({ machineName: 'H5P.CoursePresentation', majorVersion: 1, minorVersion: 27 }));
    v = await V.validateMbzV3(r.mbz, exp(r.target));
    eq(h5pIssues(v, r.target.idnumber), [], 'BS declarando una librería de SU delta: aceptado');
    // Un paquete con BS pero facts dice questionset (Manifest v1) → R-012.
    r = await swapActivityPackage(base.mbz, bsPkg);
    v = await V.validateMbzV3(r.mbz, base.expectations);
    assert(h5pIssues(v, r.target.idnumber).some((i) => /debe ser H5P\.(QuestionSet|DragText|Blanks) \(R-012\), vino H5P\.BranchingScenario/.test(i.message)), JSON.stringify(h5pIssues(v, r.target.idnumber)));
    // Dialog Cards en el lugar de una actividad calificada: sin hallazgos de carpetas, pero no calificable.
    const dc = h.buildDialogCardsFromExperience({ chapterTitle: 'Atención', experience: experienceWithCards(4, 0, 0) });
    r = await swapActivityPackage(base.mbz, await bundle(dc));
    v = await V.validateMbzV3(r.mbz, base.expectations);
    const msgs = h5pIssues(v, r.target.idnumber).map((i) => i.message);
    assert(msgs.some((m) => /H5P\.Dialogcards no es calificable/.test(m)) && !msgs.some((m) => /carpeta|delta|library\.json/.test(m)), JSON.stringify(msgs));
    // Legacy: un QS (content-only) con una carpeta de librería sigue rechazado como antes.
    const qsB = h.buildQuestionSet({ itemKey: 'activity:q', title: 'QS', passPercentage: 70, questions: [{ kind: 'truefalse', question: 'A', correct: true }, { kind: 'truefalse', question: 'B', correct: false }] });
    const qsPkg = await h.buildContentOnlyH5p({ mainLibrary: qsB.mainLibrary, content: qsB.content, title: qsB.title, language: 'es' });
    r = await swapActivityPackage(base.mbz, qsPkg, mut((z) => z.file('H5P.Text-1.1/library.json', '{}')));
    v = await V.validateMbzV3(r.mbz, withType(base.expectations, r.target.chapterId, 'questionset'));
    eq(h5pIssues(v, r.target.idnumber).map((i) => i.message), ['el paquete no es content-only: H5P.Text-1.1/library.json'], 'QS con carpeta');
  });

  // ══ 7. Calificación + golden legacy ════════════════════════════════════════
  await check('H5P_MOODLE_GRADING: BS calificable (evidencia de reproductor real), DC NO calificable (add-on «Repaso»)', () => {
    h.assertH5pGradableInMoodle('H5P.BranchingScenario');
    throws(() => h.assertH5pGradableInMoodle('H5P.Dialogcards'), /^H5P_NOT_GRADABLE_IN_MOODLE: H5P\.Dialogcards — Dialogcards 1\.9\.40 no emite xAPI/, 'DC');
    assert(/COMPLETE_PASS/.test(h.H5P_MOODLE_GRADING['H5P.BranchingScenario'].evidence), 'evidencia BS');
    eq(h.H5P_UNGRADED_ADDON_LIBRARIES, ['H5P.Dialogcards'], 'add-ons sin nota');
  });
  await check('golden: paquetes H5P legacy (QS/SCS/DT/Blanks/IV 140-468-1200 s) byte-idénticos al commit base', async () => {
    eq(await GOLD.legacyH5pShas(distRoot), GOLDEN.h5p, 'sha256');
  });
  await check('golden: .mbz v3 de la matriz de fixtures + EV5-C rules=1 byte-idénticos al commit base', async () => {
    eq(await GOLD.legacyMbzShas(distRoot), GOLDEN.mbz, 'sha256');
  });

  console.log(`\n${passes} ok, ${failures} fallas`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
