#!/usr/bin/env node
/* eslint-disable */
// Cursia EV6 P2-B5 — evaluaciones que certifican en el Moodle 4.5 LOCAL desechable (CLI, sin servidor web).
//
//   1. `check-p2-exam-validators.js --out`: arma y valida (validateMbzV3 limpio) 4 paquetes:
//      banco + final + certificado, GIFT (preguntas fijas), banco con intentos ilimitados en el examen de
//      módulo, banco sin final (nota docente propia);
//   2. restaura cada uno en un curso NUEVO (admin/cli/restore_backup.php);
//   3. corre test/e2e-v2/moodle-p2-exams.php (intentos REALES; ver su cabecera) y exige 0 fallas;
//      en GIFT las aserciones de sorteo por hoja no aplican (slots fijos) y el script lo detecta solo;
//   4. control negativo: el paquete banco con la availability de la página SIN e=3 (3 intentos) se
//      restaura y el escenario DEBE fallar justo en «agotado → página disponible».
// Crea cursos/usuarios/intentos de prueba; nunca borra ni cambia configuración del sitio.
//
// Variables: E2E_MOODLE_DIR | MOODLE_LOCAL_DIR (default ~/cursia-test-env/moodle-local), PHP_BIN, P2_EXAMS_OUT_DIR.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..');
const MOODLE = process.env.E2E_MOODLE_DIR || process.env.MOODLE_LOCAL_DIR || path.join(os.homedir(), 'cursia-test-env/moodle-local');
const PHP = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';
const PHPINI = path.join(MOODLE, 'php.ini');
const OUT = process.env.P2_EXAMS_OUT_DIR || path.join(MOODLE, 'p2-exams-out');
const SCENARIO = path.join(ROOT, 'test/e2e-v2/moodle-p2-exams.php');
/** Fix 1 (M3): un PHP colgado (lock, correo) no detiene el gate. */
const PHP_TIMEOUT_MS = 300000;

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
function assert(c, m) { if (!c) throw new Error(m); }

function restore(file) {
  const r = spawnSync(PHP, ['-c', PHPINI, 'admin/cli/restore_backup.php', `--file=${file}`, '--categoryid=1'], { cwd: path.join(MOODLE, 'source'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: PHP_TIMEOUT_MS });
  const m = /Restored course ID:\s*(\d+)/i.exec(`${r.stdout}\n${r.stderr}`);
  assert(r.status === 0 && m, `restore de ${path.basename(file)} falló${r.error ? ` (${r.error.message})` : ''}: ${(r.stderr || r.stdout || '').slice(-600)}`);
  return Number(m[1]);
}
function scenario(courseid, tagname) {
  const out = path.join(OUT, `p2exams-${tagname}-${courseid}.json`);
  const r = spawnSync(PHP, ['-c', PHPINI, SCENARIO, path.join(MOODLE, 'source'), String(courseid), out], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: PHP_TIMEOUT_MS });
  assert(!r.error, `PHP: ${r.error && r.error.message}`);
  assert(!/warning|notice|deprecated|exception/i.test(r.stderr || ''), `PHP: ${(r.stderr || '').slice(-600)}`);
  assert(fs.existsSync(out), `sin salida: ${(r.stdout || '').slice(-400)} ${(r.stderr || '').slice(-400)}`);
  return { status: r.status, o: JSON.parse(fs.readFileSync(out, 'utf8')) };
}
const summary = (o) => Object.entries(o.quizzes).map(([k, q]) => `${k.replace(/^cv3:exam:.*(.{4})$/, 'exam…$1')} ${q.mode} ${q.slots} slots, ${q.attempts || '∞'} intentos`).join(' | ');

(async () => {
  assert(fs.existsSync(path.join(MOODLE, 'source/config.php')), `no hay Moodle local en ${MOODLE}`);
  fs.mkdirSync(OUT, { recursive: true });
  const build = spawnSync(process.execPath, [path.join(__dirname, 'check-p2-exam-validators.js'), path.join(ROOT, 'dist'), '--out', OUT], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: PHP_TIMEOUT_MS });
  check('paquetes banco / GIFT / ilimitados / sin final armados y validados (check-p2-exam-validators)', () => {
    assert(build.status === 0, (build.stderr || build.stdout || '').slice(-1200));
    for (const n of ['bank', 'gift', 'unlimited', 'nofinal']) assert(fs.existsSync(path.join(OUT, `${n}.mbz`)), `falta ${n}.mbz`);
  });
  if (build.status !== 0) return finish();

  for (const [n, what] of [['bank', 'banco + final + certificado'], ['gift', 'GIFT (slots fijos; sin aserciones de sorteo)'], ['unlimited', 'banco, examen de módulo con intentos ilimitados'], ['nofinal', 'banco sin evaluación final']]) {
    let res = null;
    let courseid = null;
    check(`${what}: restaurado en un curso nuevo`, () => { courseid = restore(path.join(OUT, `${n}.mbz`)); });
    if (!courseid) continue;
    check(`${what} (curso ${courseid}): moodle-p2-exams.php sin fallas`, () => {
      res = scenario(courseid, n);
      assert(res.status === 0 && res.o.pass === true, JSON.stringify(res.o.failed).slice(0, 1500));
      console.log(`   ${res.o.assertions} aserciones — ${summary(res.o)}`);
      for (const [who, steps] of Object.entries(res.o.steps)) {
        console.log(`   ${who}: ${steps.map((s) => `${s.step} → ${s.completion}${s.page ? `, página ${s.page.available ? 'abierta' : 'bloqueada'}` : ''}${s.courseComplete ? ', curso completo' : ''}${s.badge ? ', insignia' : ''}`).join(' · ')}`);
      }
    });
    if (res && n === 'gift') check('GIFT: todos los quizzes con slots fijos', () => assert(Object.values(res.o.quizzes).every((q) => q.mode === 'gift'), JSON.stringify(res.o.quizzes)));
    if (res && n !== 'gift') check(`${what}: todos los quizzes con slots aleatorios (banco)`, () => assert(Object.values(res.o.quizzes).every((q) => q.mode === 'bank'), JSON.stringify(res.o.quizzes)));
    if (res && n === 'unlimited') check('ilimitados: el escenario U (reprobar no abre; aprobar sí) corrió', () => assert(res.o.steps.U && res.o.steps.U.length >= 3, JSON.stringify(res.o.steps)));
  }

  // Control negativo: availability sin e=3 → el estudiante que agota NUNCA ve la página.
  let negId = null;
  try {
    const neg = path.join(OUT, 'negative-no-e3.mbz');
    const z = await JSZip.loadAsync(fs.readFileSync(path.join(OUT, 'bank.mbz')));
    const mb = await z.file('moodle_backup.xml').async('string');
    for (const m of mb.matchAll(/<directory>(activities\/page_\d+)<\/directory>/g)) {
      const p = `${m[1]}/module.xml`;
      const x = await z.file(p).async('string');
      if (/cv3:exam_explanations:/.test(x)) z.file(p, x.replace(/,\{"type":"completion","cm":\d+,"e":3\}/, ''));
    }
    fs.writeFileSync(neg, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    check('control negativo: paquete banco con la página del examen de módulo SIN e=3, restaurado', () => { negId = restore(neg); });
  } catch (err) {
    failures++;
    console.error(`❌ control negativo: no se pudo preparar\n   ${err.message}`);
  }
  if (negId) {
    check(`control negativo (curso ${negId}): el escenario FALLA en availability y en «agotado → página disponible»`, () => {
      const r = scenario(negId, 'negative');
      const names = r.o.failed.map((f) => f.name);
      assert(r.status === 1 && r.o.pass === false, 'el escenario pasó con una availability rota');
      assert(names.some((x) => /availability remapeada/.test(x)), `sin falla de availability: ${JSON.stringify(names)}`);
      assert(names.some((x) => /agotados .* página DISPONIBLE/.test(x)), `sin falla de agotado→disponible: ${JSON.stringify(names)}`);
      console.log(`   fallas esperadas: ${names.join(' | ')}`);
    });
  }
  finish();
})().catch((e) => {
  failures++;
  console.error(`❌ ${e && e.stack ? e.stack : e}`);
  finish();
});

function finish() {
  console.log(failures ? `\nHAY FALLOS (${passed} ✅, ${failures} ❌).` : `\nTodos los checks de P2-B5 (Moodle) pasaron (${passed} ✅, 0 ❌).`);
  process.exit(failures ? 1 : 0);
}
