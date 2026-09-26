#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — R12: paquetes v3 restaurados en el Moodle 4.5 LOCAL desechable.
//
// Para 2 MBZ de la matriz del check puro (h5p + examen final + tema claro;
// scorm + sin final + tema oscuro + MP3 reales):
//   1. build (reloj fijo) + validador CLI `validate-mbz-v3.js`;
//   2. preflight de librerías H5P del sitio vs CURSIA_H5P_PROFILE_V1 (R7);
//   3. restore-and-inspect.sh (curso nuevo) + inspector PHP;
//   4. aserciones: 0 warnings, estructura por UUID (idnumber cv3:…), gradepass /
//      grademax / categorías / pesos / criterios de completion, quiz y SCORM según
//      el perfil, cada H5P despliega con su librería, audio/pdf/png/libro presentes
//      con el mismo contenthash que el paquete.
// Nunca borra datos ni cambia configuración; no levanta el servidor web (QA de
// navegador = R13). Requiere Postgres del Moodle local en 127.0.0.1:5570 y `npm run build`.
//
// Variables: MOODLE_LOCAL_DIR, R12_OUT_DIR, PHP_BIN (defaults al scratchpad de la sesión).

const path = require('path');
const fs = require('fs');
const { spawnSync, execFileSync } = require('child_process');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH = '/private/tmp/claude-501/-Users-nicolas-Documents-Claude-course-gen/c3707ccd-9a84-4474-8052-2f6dfeb251b1/scratchpad';
const MOODLE_LOCAL_DIR = process.env.MOODLE_LOCAL_DIR || path.join(SCRATCH, 'moodle-local');
const OUT_DIR = process.env.R12_OUT_DIR || path.join(MOODLE_LOCAL_DIR, 'r12-packaging-out');
const PHP = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';
const PHPINI = path.join(MOODLE_LOCAL_DIR, 'php.ini');
const dist = path.join(ROOT, 'dist');

const B = require(path.join(dist, 'package/dynamic-mbz-builder-v3.js'));
const A = require(path.join(dist, 'package/assessment/index.js'));
const PF = require('./lib/v21-packaging-fixtures');

let passed = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.message ? err.message : err}`);
  }
}
function eq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, recibido ${JSON.stringify(a)}`);
}
function assert(c, m) { if (!c) throw new Error(m); }

const CONFIGS = [
  { id: 'h5p-final-light', engine: 'h5p', finalExam: true, theme: { themeFamily: 'aula-clara', mode: 'light' }, courseId: 631 },
  { id: 'scorm-nofinal-dark', engine: 'scorm', finalExam: false, theme: { themeFamily: 'oscuro-premium', mode: 'dark' }, realAudio: true, courseId: 632 },
  // F1 (I3): sin exámenes de módulo → pesos normalizados (práctica/final 60/40).
  { id: 'f1-noexams-normalized', engine: 'h5p', finalExam: true, theme: { themeFamily: 'tecnico', mode: 'dark' }, courseId: 633,
    modules: [{ examEnabled: false, chapters: [{ video: false, activity: true }, { video: false, activity: true }] }] },
  // F1 (I3): curso sin nota → sin categorías, completion del curso por vista del Libro Guía.
  { id: 'f1-without-grades', engine: 'h5p', finalExam: false, theme: { themeFamily: 'aula-clara', mode: 'light' }, courseId: 634,
    modules: [{ examEnabled: false, chapters: [{ video: false, activity: false }] }] },
];
const QUIZ_GM = { highest: 1, average: 2, first: 3, last: 4 };
const H5P_GM = { highest: 1, average: 2, last: 3, first: 4 };
const WHATGRADE = { highest: 0, average: 1, first: 2, last: 3 };
const LIB = { questionset: 'H5P.QuestionSet 1.20', dragtext: 'H5P.DragText 1.10', blanks: 'H5P.Blanks 1.14' };

function kindOf(idnumber) {
  if (/:video$/.test(idnumber)) return 'video';
  if (/:activity$/.test(idnumber)) return 'activity';
  if (/^cv3:exam:/.test(idnumber)) return 'exam';
  if (idnumber === 'cv3:final_exam') return 'finalExam';
  return null;
}

async function runConfig(cfg) {
  const input = PF.packagingInput(dist, cfg);
  const r = await B.buildDynamicMbzV3(input);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mbzPath = path.join(OUT_DIR, `r12-${cfg.id}.mbz`);
  const expPath = path.join(OUT_DIR, `r12-${cfg.id}.expect.json`);
  fs.writeFileSync(mbzPath, r.mbz);
  fs.writeFileSync(expPath, JSON.stringify(r.expectations));
  const tag0 = `[${cfg.id}]`;

  check(`${tag0} validate-mbz-v3.js (CLI) sin hallazgos`, () => {
    const v = spawnSync(process.execPath, [path.join(__dirname, 'validate-mbz-v3.js'), mbzPath, '--expect', expPath], { encoding: 'utf8' });
    assert(v.status === 0, v.stdout + v.stderr);
  });

  const rs = spawnSync(path.join(MOODLE_LOCAL_DIR, 'restore-and-inspect.sh'), [mbzPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (rs.status !== 0) throw new Error(`restore-and-inspect.sh salió con ${rs.status}: ${rs.stderr.slice(-800)}`);
  const courseid = Number((/Restored course id: (\d+)/.exec(rs.stderr) || [])[1]);
  assert(courseid > 0, 'sin course id');
  const inPath = path.join(OUT_DIR, `r12-${cfg.id}.in.json`);
  const outPath = path.join(OUT_DIR, `r12-${cfg.id}.out.json`);
  fs.writeFileSync(inPath, JSON.stringify({ moodleRoot: path.join(MOODLE_LOCAL_DIR, 'source'), courseid, mbz: mbzPath }));
  execFileSync(PHP, ['-c', PHPINI, path.join(__dirname, 'moodle/v21-packaging-v3-inspect.php'), inPath, outPath], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const o = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const tag = `[${cfg.id} → curso ${courseid}]`;
  const resolved = r.expectations.resolved;
  const facts = r.expectations.facts;
  const cms = o.sections.flatMap((s) => s.cms);
  const cm = Object.fromEntries(cms.map((c) => [c.idnumber, c]));

  check(`${tag} restore con 0 warnings (precheck, controller 1000, log del restore, backup_logs, salida del CLI)`, () => {
    eq(o.precheck, { warnings: [], errors: [] }, 'precheck');
    eq(o.restoreStatus, 1000, 'controller');
    assert(o.restoreLogFound, 'log del restore');
    eq(o.restoreLogLines, [], 'log');
    eq(o.restoreDbLogWarnings, [], 'backup_logs');
    eq(rs.stderr.split('\n').filter((l) => /warning|notice|debug|error|exception/i.test(l)), [], 'CLI');
  });
  check(`${tag} estructura por UUID: secciones × idnumber cv3:… = Manifest + chapterSlotSequence`, () => {
    eq(o.sections.map((s) => [s.section, s.cms.map((c) => c.idnumber)]), PF.expectedSequence(dist, input), 'secuencia');
    eq(o.sections.map((s) => s.name), ['Bienvenida', 'Ruta de aprendizaje y Libro Guía',
      ...input.manifest.modules.map((m) => `Módulo ${m.moduleNumber} — ${input.blueprint.modules.find((b) => b.id === m.moduleId).title}`), 'Cierre del curso'], 'nombres');
  });
  check(`${tag} ítems calificables: gradepass = perfil, 0–100, categoría; completion 2/0/1 y showdescription`, () => {
    const graded = cms.filter((c) => kindOf(c.idnumber));
    eq(graded.length, facts.counts.videos + facts.counts.activities + facts.counts.exams + (facts.finalExam.enabled ? 1 : 0), 'cantidad');
    for (const c of graded) {
      const k = resolved.kinds[kindOf(c.idnumber)];
      const it = o.items.find((i) => i.idnumber === c.idnumber);
      assert(it, `grade item de ${c.idnumber}`);
      eq([it.gradepass, it.grademax, it.grademin, it.category], [k.passingGrade, 100, 0, A.ASSESSMENT_CATEGORY_NAMES[k.category]], c.idnumber);
      eq([c.completion, String(c.completiongradeitemnumber), c.completionpassgrade, c.showdescription], [2, '0', 1, 1], `completion ${c.idnumber}`);
    }
    for (const c of cms.filter((x) => !kindOf(x.idnumber))) {
      // F1 (I3): en un curso sin nota el Libro Guía se completa por vista.
      if (resolved.withoutGrades && c.idnumber === 'cv3:shell:libro') eq([c.completion, c.completionview], [2, 1], 'Libro por vista');
      else eq(c.completion, 0, `sin completion ${c.idnumber}`);
    }
  });
  check(`${tag} gradebook: media ponderada, categorías y pesos ${resolved.categories.map((c) => c.weight).join('/')}, gradepass del curso ${resolved.courseGradepass}`, () => {
    const top = o.categories.find((c) => c.depth === 1);
    eq([top.aggregation, top.aggregateonlygraded], [10, 0], 'curso');
    eq(o.categories.filter((c) => c.depth === 2).map((c) => [c.fullname, c.weight, c.aggregation]), resolved.categories.map((c) => [c.fullname, c.weight, 0]), 'hijas');
    eq(o.courseItem, { gradepass: resolved.courseGradepass, grademax: 100 }, 'curso');
  });
  check(`${tag} completion del curso: un criterio por ítem requerido (por UUID) + agregación ALL`, () => {
    const expected = A.completionCriteriaFor(
      cms.filter((c) => kindOf(c.idnumber)).map((c) => ({ moduleId: c.cmid, modname: c.modname, kind: kindOf(c.idnumber) })),
      resolved.courseCompletion,
    ).map((x) => cms.find((c) => c.cmid === x.moduleId).idnumber);
    eq(o.criteria.filter((c) => c.criteriatype === 4).map((c) => c.idnumber), resolved.withoutGrades ? ['cv3:shell:libro'] : expected, 'criterios');
    eq(o.criteria.filter((c) => c.criteriatype === 6).length, resolved.courseCompletion.requireCourseGradePass ? 1 : 0, 'criterio de nota');
    eq(o.aggr, [{ criteriatype: null, method: 1 }], 'agregación');
  });
  check(`${tag} quiz: intentos/método del perfil, sumgrades = Σ maxmark = 100, preguntas = GIFT`, () => {
    for (const [id, q] of Object.entries(o.quizzes)) {
      const k = resolved.kinds[kindOf(id)];
      const n = kindOf(id) === 'finalExam' ? facts.finalExam.questionCount : facts.modules.find((m) => id.endsWith(m.id)).examQuestionCount;
      eq([q.attempts, q.grademethod, q.sumgrades, q.grade, q.maxmarkSum, q.preferredbehaviour, q.slots], [k.attempts, QUIZ_GM[k.gradeMethod], 100, 100, 100, 'deferredfeedback', n], id);
    }
  });
  check(`${tag} SCORM / H5P: campos de evaluación restaurados; cada H5P despliega con la librería esperada`, () => {
    for (const [id, s] of Object.entries(o.scorms)) {
      const k = resolved.kinds.activity;
      eq([s.maxgrade, s.grademethod, s.whatgrade, s.maxattempt, s.masteryoverride, s.completionstatusrequired, s.completionscorerequired, s.scoes], [100, 1, WHATGRADE[k.gradeMethod], k.attempts, 1, null, null, 2], id);
    }
    eq(Object.keys(o.scorms).length, cfg.engine === 'scorm' ? facts.counts.activities : 0, 'scorms');
    const shellMod = require(path.join(dist, 'modules/course-shell/index.js'));
    for (const [id, h] of Object.entries(o.h5ps)) {
      const k = resolved.kinds[kindOf(id)];
      eq([h.grade, h.grademethod, h.enabletracking, h.reviewmode, h.displayoptions], [100, H5P_GM[k.gradeMethod], 1, 1, 15], id);
      assert(h.deploy.h5pid && !h.deploy.exception && h.deploy.messages.length === 0, `${id} no despliega: ${JSON.stringify(h.deploy)}`);
      const want = kindOf(id) === 'video' ? 'H5P.InteractiveVideo 1.27' : LIB[shellMod.activityTypeForChapter(id.split(':')[2])];
      eq(h.deploy.library, want, `librería ${id}`);
      const files = cm[id].files;
      const pkg = files.find((f) => f.area === 'package');
      const intro = files.find((f) => f.area === 'intro');
      assert(pkg && intro && pkg.hash === intro.hash && pkg.name === intro.name, `${id}: package + intro (mismo .h5p)`);
    }
  });
  const z = await JSZip.loadAsync(r.mbz);
  const blobHash = async (name) => {
    const fx = await z.file('files.xml').async('string');
    const f = fx.match(/<file id="\d+">[\s\S]*?<\/file>/g).find((x) => x.includes(`<filename>${name}</filename>`));
    return f && /<contenthash>(\w+)<\/contenthash>/.exec(f)[1];
  };
  const mbzFiles = {};
  for (const n of ['audio_bienvenida.mp3', 'audiolibro.mp3', 'libro_guia_completo.html']) mbzFiles[n] = await blobHash(n);
  check(`${tag} archivos restaurados: MP3 de bienvenida y audiolibro, PNG+PDF por tarjeta, Libro Guía (mismo contenthash)`, () => {
    const aw = cm['cv3:shell:audio_welcome'].files.find((f) => f.name === 'audio_bienvenida.mp3');
    const ab = cm['cv3:shell:audiobook'].files.find((f) => f.name === 'audiolibro.mp3');
    const lb = cm['cv3:shell:libro'].files.find((f) => f.name === 'libro_guia_completo.html');
    assert(aw && ab && lb, 'faltan archivos');
    eq([aw.hash, ab.hash, lb.hash], [mbzFiles['audio_bienvenida.mp3'], mbzFiles['audiolibro.mp3'], mbzFiles['libro_guia_completo.html']], 'contenthash');
    eq([aw.area, ab.area, lb.area], ['intro', 'intro', 'content'], 'fileareas');
    for (const c of cms.filter((x) => /:presentation$/.test(x.idnumber))) {
      const names = c.files.map((f) => `${f.area}:${f.mime}`).sort();
      eq(names, ['intro:application/pdf', 'intro:image/png'], c.idnumber);
    }
  });
  return courseid;
}

(async () => {
  try {
    execFileSync('pg_isready', ['-h', '127.0.0.1', '-p', '5570'], { stdio: 'ignore' });
  } catch (_) {
    console.error('❌ Postgres del Moodle local no responde en 127.0.0.1:5570 (correr moodle-local/start.sh)');
    process.exit(1);
  }
  check('preflight H5P del sitio vs CURSIA_H5P_PROFILE_V1 (h5p-preflight-moodle.js)', () => {
    const pf = spawnSync(process.execPath, [path.join(__dirname, 'h5p-preflight-moodle.js'), path.join(MOODLE_LOCAL_DIR, 'source'), PHPINI], {
      encoding: 'utf8', env: { ...process.env, PHP_BIN: PHP },
    });
    assert(pf.status === 0, pf.stdout + pf.stderr);
  });
  const courses = [];
  for (const cfg of CONFIGS) {
    try {
      courses.push(await runConfig(cfg));
    } catch (err) {
      failures++;
      console.error(`❌ [${cfg.id}] no se pudo completar\n   ${err && err.stack ? err.stack : err}`);
    }
  }
  console.log(`\ncursos restaurados: ${courses.join(', ')}`);
  console.log(`${passed} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})();
