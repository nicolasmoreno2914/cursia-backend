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
const MOODLE_LOCAL_DIR = process.env.MOODLE_LOCAL_DIR || process.env.E2E_MOODLE_DIR || path.join(SCRATCH, 'moodle-local');
const OUT_DIR = process.env.R12_OUT_DIR || path.join(MOODLE_LOCAL_DIR, 'r12-packaging-out');
const PHP = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';
const PHPINI = path.join(MOODLE_LOCAL_DIR, 'php.ini');
const dist = path.join(ROOT, 'dist');

const B = require(path.join(dist, 'package/dynamic-mbz-builder-v3.js'));
const A = require(path.join(dist, 'package/assessment/index.js'));
const PF = require('./lib/v21-packaging-fixtures');

let passed = 0;
const awards = [];
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
  // Motor de carga horaria: capítulos de práctica (sin presentación, Libro ni audiolibro; fuera de los exámenes).
  { id: 'practice-chapters', engine: 'h5p', finalExam: true, theme: { themeFamily: 'aula-clara', mode: 'light' }, courseId: 635,
    modules: [
      { examEnabled: true, chapters: [{ video: true, activity: true }, { video: false, activity: true }, { practice: true, activity: true }] },
      { examEnabled: false, chapters: [{ video: true, activity: true }, { practice: true, activity: true }, { video: false, activity: false }] },
    ] },
];
const QUIZ_GM = { highest: 1, average: 2, first: 3, last: 4 };
const H5P_GM = { highest: 1, average: 2, last: 3, first: 4 };
const WHATGRADE = { highest: 0, average: 1, first: 2, last: 3 };
// UX #5 (r18): el builder v3 arma QuestionSet 1.21 (CURSIA_H5P_PROFILE_V3, librería incluida en el .h5p).
const LIB = { questionset: 'H5P.QuestionSet 1.21', dragtext: 'H5P.DragText 1.10', blanks: 'H5P.Blanks 1.14' };

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
    // EV6: una sección por capítulo («Módulo m · Capítulo n: título»), una por evaluación de módulo,
    // la evaluación final (si hay) y el cierre SIEMPRE al final.
    const names = ['Bienvenida', 'Ruta de aprendizaje y Libro Guía'];
    for (const m of input.manifest.modules) {
      const bm = input.blueprint.modules.find((b) => b.id === m.moduleId);
      for (const ch of m.chapters) names.push(`Módulo ${m.moduleNumber} · Capítulo ${ch.chapterNumber}: ${bm.chapters.find((c) => c.id === ch.chapterId).title}`);
      if (m.examEnabled) names.push(`Módulo ${m.moduleNumber} · Evaluación`);
    }
    if (input.manifest.features.finalExam) names.push('Evaluación final');
    names.push('Cierre del curso');
    eq(o.sections.map((s) => s.name), names, 'nombres');
    eq(o.courseFormat, { format: 'topics', coursedisplay: 1 }, 'formato topics, una sección por página (coursedisplay = 1)');
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
  const hasCert = facts.finalExam.enabled;
  if (!hasCert) {
    // Fix round 1b (decisión M5): sin evaluación final no hay certificado.
    // EV6 P2-B4 (ruling 3): sin certificado, el único oculto es la nota para docentes de «Respuestas
    // explicadas» (solo si hay evaluaciones de módulo).
    const wantHidden = facts.counts.exams > 0 ? ['cv3:shell:exams_teacher'] : [];
    check(`${tag} EV6 T3: sin evaluación final → sin insignia, sin enlace en el cierre y sin más módulos ocultos que la nota para docentes de las evaluaciones`, () => {
      eq(o.badges, [], 'sin insignia');
      eq(o.closingBadgeLinks, [], 'sin enlace a insignias');
      eq(cms.filter((c) => c.visible !== 1).map((c) => c.idnumber), wantHidden, 'módulos ocultos');
    });
  }
  if (hasCert) check(`${tag} EV6 T3: certificado = insignia de curso restaurada (criterio del curso NUEVO, imagen f1/f2/f3, enlace del cierre)`, () => {
    eq(o.badges.length, 1, 'una insignia');
    const b = o.badges[0];
    const title = facts.course.title;
    eq([b.name, b.type, b.issuername, b.language, b.notification], [`Certificado: ${title}`, 2, 'Cursia', 'es', 0], 'insignia');
    // Fix round 1 (review I1): la descripción enuncia los criterios reales (por tipo) del paquete.
    assert(b.description.startsWith(`Otorgado al completar el curso «${title}»: `) && (facts.finalExam.enabled ? b.description.includes('la evaluación final') : !/evaluación final/.test(b.description)), `descripción: ${b.description}`);
    assert(b.description.includes(': aprobar ') && b.description.endsWith('la evaluación final.'), `descripción con los criterios reales: ${b.description}`);
    assert(b.message.includes('%badgename%'), 'mensaje con %badgename%');
    // Moodle core SIEMPRE restaura las insignias inactivas (restore_badges_structure_step): hay que habilitarla una vez.
    eq(b.status, 0, 'status tras restaurar (core fuerza INACTIVE)');
    eq(b.criteria, [{ criteriatype: 0, method: 1, params: [] }, { criteriatype: 4, method: 1, params: [[`course_${courseid}`, String(courseid)]] }], 'criterios remapeados al curso nuevo');
    eq(b.images.map((i) => [i.name, i.mime, i.w, i.h]), [['f1.png', 'image/png', 100, 100], ['f2.png', 'image/png', 35, 35], ['f3.png', 'image/png', 512, 512]], 'imagen');
    eq(o.closingBadgeLinks, [`${o.wwwroot}/badges/index.php?type=2&id=${courseid}`], 'enlace «Ver mi certificado →» decodificado');
    if (facts.finalExam.enabled) {
      assert(o.criteria.some((c) => c.criteriatype === 4 && c.idnumber === 'cv3:final_exam'), 'la evaluación final es criterio de completion');
      eq(cm['cv3:final_exam'].completionpassgrade, 1, 'la evaluación final solo cuenta aprobada');
    }
  });
  if (hasCert) check(`${tag} EV6 T3: la insignia se otorga sola al completar el curso (usuario de prueba, cron de completion real)`, () => {
    const awPath = path.join(OUT_DIR, `r12-${cfg.id}.award.json`);
    execFileSync(PHP, ['-c', PHPINI, path.join(__dirname, 'moodle/v21-certificate-award.php'), inPath, awPath], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const aw = JSON.parse(fs.readFileSync(awPath, 'utf8'));
    awards.push({ id: cfg.id, courseid, ...aw });
    eq([aw.statusAfterRestore, aw.statusAfterEnable], [0, 1], 'habilitar acceso (acción única del gestor)');
    // Fix 0b: el label para docentes existe oculto: el docente con edición lo ve, el estudiante no.
    eq(aw.hiddenModules, ['cv3:shell:certificate_teacher'], 'único módulo oculto');
    eq(aw.visibility.student['cv3:shell:certificate_teacher'], { visible: 0, uservisible: false, onCoursePage: false }, 'estudiante NO ve el label docente');
    eq(aw.visibility.editingteacher['cv3:shell:certificate_teacher'], { visible: 0, uservisible: true, onCoursePage: true }, 'docente lo ve (atenuado)');
    eq(aw.visibility.student['cv3:shell:closing'].uservisible, true, 'el estudiante sí ve el cierre');
    const closingSec = o.sections.find((s) => s.cms.some((c) => c.idnumber === 'cv3:shell:closing')).section;
    eq(aw.teacherLabel.section, closingSec, 'label docente en «Cierre del curso»');
    eq(aw.teacherLabel.links, [`${o.wwwroot}/badges/index.php?type=2&id=${courseid}`], 'botón a las insignias del curso nuevo');
    assert(aw.teacherLabel.text.includes(`Entra a Insignias → «Certificado: ${facts.course.title}» → «Habilitar acceso». Solo se hace una vez. Si no ves la insignia, revisa que las insignias estén habilitadas en el sitio y en el curso, y que la restauración haya incluido todas las actividades.`), aw.teacherLabel.text);
    eq([aw.beforeAny.courseComplete, aw.beforeAny.issued], [false, false], 'sin nada completado');
    if (aw.withoutLast) eq([aw.withoutLast.courseComplete, aw.withoutLast.issued], [false, false], `falta ${aw.lastIdnumber}: sin completar ni insignia`);
    if (facts.finalExam.enabled) {
      eq(aw.lastIdnumber, 'cv3:final_exam', 'el último criterio es la evaluación final');
      eq([aw.lastFailed.courseComplete, aw.lastFailed.issued], [false, false], 'evaluación final reprobada: sin completar ni insignia');
      eq(aw.marks.filter((m) => m.idnumber === 'cv3:final_exam').map((m) => m.completionstate), [3, 2], 'final: COMPLETE_FAIL y luego COMPLETE_PASS');
    }
    eq([aw.after.courseComplete, aw.after.issued], [true, true], 'curso completo → insignia otorgada');
    assert(aw.after.bakedPng && aw.after.bakedPng.w === 512, `PNG horneado: ${JSON.stringify(aw.after.bakedPng)}`);
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
    for (const [id, h] of Object.entries(o.h5ps)) {
      const k = resolved.kinds[kindOf(id)];
      eq([h.grade, h.grademethod, h.enabletracking, h.reviewmode, h.displayoptions], [100, H5P_GM[k.gradeMethod], 1, 1, 15], id);
      assert(h.deploy.h5pid && !h.deploy.exception && h.deploy.messages.length === 0, `${id} no despliega: ${JSON.stringify(h.deploy)}`);
      // EV5-C: el tipo esperado sale de facts (resolveActivityType del Manifest), no del hash directo.
      const want = kindOf(id) === 'video' ? 'H5P.InteractiveVideo 1.27' : LIB[facts.chapters.find((c) => c.id === id.split(':')[2]).activityType];
      eq(h.deploy.library, want, `librería ${id}`);
      const files = cm[id].files;
      const pkg = files.find((f) => f.area === 'package');
      // V542 I2: UNA sola copia restaurada (package); el embed inline usa esa misma (sin copia en intro).
      assert(pkg && files.filter((f) => /\.h5p$/.test(f.name)).length === 1, `${id}: un solo .h5p (package): ${JSON.stringify(files.map((f) => f.area + '/' + f.name))}`);
    }
  });
  const z = await JSZip.loadAsync(r.mbz);
  const blobHash = async (name) => {
    const fx = await z.file('files.xml').async('string');
    const f = fx.match(/<file id="\d+">[\s\S]*?<\/file>/g).find((x) => x.includes(`<filename>${name}</filename>`));
    return f && /<contenthash>(\w+)<\/contenthash>/.exec(f)[1];
  };
  const mbzFiles = {};
  // r19 (L1/L5, builder 3.13.0): el Libro Guía es un PDF `libro_guia_<slug>.pdf` (application/pdf).
  const fxAll = await z.file('files.xml').async('string');
  const libroName = (/<filename>(libro_guia_[a-z0-9_]+\.pdf)<\/filename>/.exec(fxAll) || [])[1];
  for (const n of ['audio_bienvenida.mp3', 'audiolibro.mp3', libroName]) mbzFiles[n] = await blobHash(n);
  check(`${tag} archivos restaurados: MP3 de bienvenida y audiolibro, PNG+PDF por tarjeta, Libro Guía PDF (mismo contenthash)`, () => {
    const aw = cm['cv3:shell:audio_welcome'].files.find((f) => f.name === 'audio_bienvenida.mp3');
    const ab = cm['cv3:shell:audiobook'].files.find((f) => f.name === 'audiolibro.mp3');
    const lbs = cm['cv3:shell:libro'].files;
    const lb = lbs.find((f) => f.name === libroName);
    assert(aw && ab && lb && libroName, 'faltan archivos');
    eq([lbs.length, lb.mime], [1, 'application/pdf'], 'un solo archivo del Libro Guía, PDF');
    eq([aw.hash, ab.hash, lb.hash], [mbzFiles['audio_bienvenida.mp3'], mbzFiles['audiolibro.mp3'], mbzFiles[libroName]], 'contenthash');
    eq([aw.area, ab.area, lb.area], ['intro', 'intro', 'content'], 'fileareas');
    for (const c of cms.filter((x) => /:presentation$/.test(x.idnumber))) {
      const names = c.files.map((f) => `${f.area}:${f.mime}`).sort();
      eq(names, ['intro:application/pdf', 'intro:image/png'], c.idnumber);
    }
  });
  check(`${tag} r19 L4: la descripción del Libro Guía restaurada lleva UN botón «Abrir Libro Guía» → mod/resource/view.php?id=<su cmid>, target _blank`, () => {
    const L = o.libro;
    assert(L, 'sin datos del recurso del Libro Guía');
    eq(L.display, 5, 'display 5 (view.php entrega el PDF)');
    eq(L.links.length, 1, `enlaces en la descripción: ${JSON.stringify(L.links)}`);
    const a = L.links[0];
    eq(a.href, `${o.wwwroot}/mod/resource/view.php?id=${L.cmid}`, 'href decodificado = el propio recurso');
    assert(a.target === '_blank' && /noopener/.test(a.rel || '') && /Abrir Libro Guía/.test(a.text), JSON.stringify(a));
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
  for (const a of awards) console.log(`docentes [${a.id} → curso ${a.courseid}]: ${JSON.stringify({ ocultos: a.hiddenModules, visibilidad: a.visibility, enlace: a.teacherLabel && a.teacherLabel.links })}`);
  for (const a of awards) console.log(`certificado [${a.id} → curso ${a.courseid}]: ${JSON.stringify({ badgeid: a.badgeid, criterios: a.criteriaCount, ultimo: a.lastIdnumber, sinElUltimo: a.withoutLast, ultimoReprobado: a.lastFailed, despues: a.after })}`);
  console.log(`${passed} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})();
