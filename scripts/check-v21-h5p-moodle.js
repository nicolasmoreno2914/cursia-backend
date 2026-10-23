#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 / R7-core — verificación end-to-end del motor H5P contra un
// Moodle LOCAL desechable (sin red, sin proveedores, sin gasto).
//
//  1. construye con los builders compilados (dist/) paquetes SOLO CONTENIDO de
//     QuestionSet, SingleChoiceSet, DragText, Blanks e InteractiveVideo (YouTube
//     IdwOipZAeqY) en un directorio temporal;
//  2. (opcional, con --libs) construye el Cursia H5P Library Pack;
//  3. ejecuta scripts/moodle/check-v21-h5p-moodle.php (crea un curso nuevo,
//     despliega, publica xAPI con subContentId UUID, verifica intento/nota/completion);
//  4. aplica el preflight de CURSIA_H5P_PROFILE_V1 a las librerías instaladas.
//
// Nunca borra datos del sitio: deja el curso y los usuarios de prueba.
//
// Uso (después de `npm run build`):
//   node scripts/check-v21-h5p-moodle.js <moodleDir> <phpIni> [--libs <libsDir>]
// PHP: env PHP_BIN (default "php").

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const li = args.indexOf('--libs');
const libsDir = li >= 0 ? args[li + 1] : null;
const [moodleDir, phpIni] = args.filter((a, i) => !a.startsWith('--') && (li < 0 || i !== li + 1));
if (!moodleDir || !phpIni) {
  console.error('uso: node scripts/check-v21-h5p-moodle.js <moodleDir> <phpIni> [--libs <libsDir>]');
  process.exit(2);
}

let h;
try {
  h = require(path.resolve(__dirname, '..', 'dist/package/h5p/index.js'));
} catch (err) {
  console.error(`❌ No se pudo cargar dist/package/h5p (¿npm run build?): ${err.message}`);
  process.exit(1);
}

let failures = 0;
function report(name, ok, detail) {
  if (ok) console.log(`✅ ${name}`);
  else {
    failures += 1;
    console.error(`❌ ${name}`);
    if (detail) console.error(`   ${detail}`);
  }
}

const mc = (q, correctText, wrong) => ({
  kind: 'multichoice',
  question: q,
  answers: [{ text: correctText, correct: true, feedback: 'Correcto.' }, ...wrong.map((t) => ({ text: t, correct: false }))],
});
const tf = (q, correct) => ({ kind: 'truefalse', question: q, correct, feedbackCorrect: 'Correcto.', feedbackWrong: 'Revisa el contenido.' });

const PASS = { raw: 3, childCorrect: [1, 1, 1, 0], expectedGrade: 75, expectedCompletion: 'COMPLETE_PASS' };
const FAIL = { raw: 2, childCorrect: [1, 0, 1, 0], expectedGrade: 50, expectedCompletion: 'COMPLETE_FAIL' };

const packages = [
  {
    key: 'questionset',
    name: 'V21 R7 — QuestionSet',
    built: h.buildQuestionSet({
      itemKey: 'activity:ch1',
      title: 'Comprueba tu comprensión',
      passPercentage: 70,
      questions: [
        mc('¿Qué componente capta el agua de la superficie?', 'Skimmer', ['Retorno', 'Filtro']),
        tf('El filtro se ubica antes de la bomba en el circuito típico.', false),
        mc('¿Qué devuelve el agua filtrada a la piscina?', 'Boquillas de retorno', ['Drenaje de fondo', 'Skimmer']),
        tf('El retrolavado limpia el lecho filtrante.', true),
      ],
    }),
    interactionTypes: ['choice', 'true-false', 'choice', 'true-false'],
  },
  {
    key: 'singlechoiceset',
    name: 'V21 R7 — SingleChoiceSet',
    built: h.buildSingleChoiceSet({
      itemKey: 'activity:ch2',
      title: 'Práctica rápida',
      passPercentage: 70,
      questions: [
        { question: '¿Dónde entra el agua?', answers: [{ text: 'Skimmer', correct: true }, { text: 'Retorno', correct: false }] },
        { question: '¿Qué retiene la suciedad?', answers: [{ text: 'Filtro', correct: true }, { text: 'Bomba', correct: false }] },
        { question: '¿Qué impulsa el agua?', answers: [{ text: 'Bomba', correct: true }, { text: 'Skimmer', correct: false }] },
        { question: '¿Qué limpia el lecho?', answers: [{ text: 'Retrolavado', correct: true }, { text: 'Cloración', correct: false }] },
      ],
    }),
    // Forma REAL de SCS 1.11 (review G4 C1/I4): hijos con ?subContentId=<uuid> y padre
    // 'answered' SIN result.completion ⇒ Moodle no califica (ver moodle-grading.ts).
    interactionTypes: ['choice', 'choice', 'choice', 'choice'],
    parentVerb: 'answered',
    parentCompletion: false,
    passScenario: { ...PASS, expectedGrade: null, expectedCompletion: 'INCOMPLETE' },
    failScenario: { ...FAIL, expectedGrade: null, expectedCompletion: 'INCOMPLETE' },
  },
  {
    key: 'dragtext',
    name: 'V21 R7 — DragText',
    built: h.buildDragText({
      itemKey: 'activity:ch3',
      title: 'Completa el circuito',
      taskDescription: 'Arrastra las palabras al lugar correcto.',
      text: 'El agua entra por el *skimmer* y vuelve por las *boquillas*. El *filtro* retiene la suciedad y la *bomba* la impulsa.',
    }),
  },
  {
    key: 'blanks',
    name: 'V21 R7 — Blanks',
    built: h.buildBlanks({
      itemKey: 'activity:ch4',
      title: 'Completa las frases',
      text: 'Escribe la palabra que falta.',
      questions: ['El agua entra por el *skimmer/desnatador* y vuelve por las *boquillas*.', 'El *filtro* retiene la suciedad y la *bomba* la impulsa.'],
    }),
  },
  {
    key: 'interactivevideo',
    name: 'V21 R7 — Video interactivo',
    built: h.buildInteractiveVideo({
      itemKey: 'video_interactions:ch1',
      title: 'Recorrido del agua',
      youtubeId: 'IdwOipZAeqY',
      durationSec: 468,
      interactions: [
        { ...mc('¿Qué componente aparece primero?', 'Skimmer', ['Filtro', 'Bomba']), atSec: 60 },
        { ...tf('La bomba impulsa el agua hacia el filtro.', true), atSec: 150 },
        { ...mc('¿Por dónde vuelve el agua?', 'Boquillas de retorno', ['Skimmer', 'Drenaje', 'Filtro']), atSec: 260 },
        { ...tf('El filtro nunca necesita limpieza.', false), atSec: 400 },
      ],
    }),
    interactionTypes: ['choice', 'true-false', 'choice', 'true-false'],
  },
];

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-r7-h5p-'));
  const plan = { gradepass: 70, packages: [], libraryPack: [] };
  for (const p of packages) {
    const b = p.built;
    const buf = await h.buildContentOnlyH5p({ mainLibrary: b.mainLibrary, content: b.content, title: b.title, language: 'es' });
    const file = path.join(tmp, `${p.key}.h5p`);
    fs.writeFileSync(file, buf);
    report(`${p.key}: paquete solo contenido construido (${buf.length} bytes, maxScore ${b.maxScore})`, b.maxScore === 4 && buf.length < 64 * 1024, `maxScore=${b.maxScore}`);
    plan.packages.push({
      key: p.key,
      name: p.name,
      file,
      mainLibrary: b.mainLibrary,
      mainLibraryString: h.profileLibraryString(h.CURSIA_H5P_PROFILE_V1, b.mainLibrary),
      subContentIds: b.subContentIds,
      interactionTypes: p.interactionTypes || [],
      maxScore: b.maxScore,
      passScenario: p.passScenario || PASS,
      failScenario: p.failScenario || FAIL,
      parentVerb: p.parentVerb || 'completed',
      parentCompletion: p.parentCompletion !== false,
    });
  }
  if (libsDir) {
    const packDir = path.join(tmp, 'library-pack');
    const manifest = await h.buildCursiaH5pLibraryPack({ libsDir: path.resolve(libsDir), outDir: packDir });
    report(`library pack construido (${manifest.packages.length} paquetes, ${manifest.libraries.length} librerías)`, manifest.packages.length === 7);
    plan.libraryPack = manifest.packages.map((x) => path.join(packDir, x.file));
  }
  const planFile = path.join(tmp, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  console.log(`(paquetes y plan en ${tmp})`);

  const php = process.env.PHP_BIN || 'php';
  const r = spawnSync(php, ['-c', phpIni, path.resolve(__dirname, 'moodle/check-v21-h5p-moodle.php'), moodleDir, planFile], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const lines = (r.stdout || '').split('\n');
  let resultJson = null;
  for (const line of lines) {
    if (line.startsWith('RESULT_JSON ')) resultJson = JSON.parse(line.slice('RESULT_JSON '.length));
    else if (line.trim()) console.log(line);
  }
  if (r.status !== 0) {
    failures += 1;
    console.error(`❌ check-v21-h5p-moodle.php terminó con código ${r.status}`);
    if (r.stderr) console.error(r.stderr.split('\n').slice(-30).join('\n'));
  }
  if (resultJson) {
    fs.writeFileSync(path.join(tmp, 'result.json'), JSON.stringify(resultJson, null, 2));
    const pf = h.h5pPreflight(h.CURSIA_H5P_PROFILE_V1, resultJson.installedLibraries);
    let msg = '';
    try {
      h.assertH5pPreflight(h.CURSIA_H5P_PROFILE_V1, resultJson.installedLibraries);
    } catch (e) {
      msg = e.message;
    }
    report(`preflight CURSIA_H5P_PROFILE_V1 contra el sitio (${pf.satisfied.length}/${pf.required.length} compatibles)`, pf.ok, msg);
    for (const p of resultJson.packages || []) {
      const changed = (p.filter && p.filter.changed) || [];
      if (changed.length) console.log(`   ℹ️  ${p.key}: el filtro H5P re-escapó ${changed.length} valor(es) (esperado en texto plano), p. ej. ${changed[0]}`);
    }
    console.log(`(curso de prueba id ${resultJson.courseid}; resultado completo en ${path.join(tmp, 'result.json')})`);
  } else {
    failures += 1;
    console.error('❌ el script PHP no devolvió RESULT_JSON');
    if (r.stderr) console.error(r.stderr.split('\n').slice(-30).join('\n'));
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) fallaron.`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(`❌ error inesperado: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
