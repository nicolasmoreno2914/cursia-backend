#!/usr/bin/env node
/* eslint-disable no-console */
// T6 (r57) — restauración REAL en el Moodle 4.5 LOCAL desechable (moodle-local) de un paquete con la «Guía del docente»:
// restaura con 0 avisos, el estudiante NO ve ni puede abrir la guía (oculta + mod/page:view PROHIBIDO, también si un
// docente la muestra por error), el docente sí; sin completion. Restaura con la sesión del admin (restore-as-admin.php,
// como un restore web: el CLI de Moodle no aplica los overrides de permisos). Sin red, sin proveedores.
// Uso: node scripts/check-t6-teacher-guide-moodle.js   (después de npm run build; requiere moodle-local levantado)
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const ROOT = path.resolve(__dirname, '..');
const dist = path.join(ROOT, 'dist');
const B = require(path.join(dist, 'package/dynamic-mbz-builder-v3.js'));
const V = require(path.join(dist, 'package/v3/mbz-validator-v3.js'));
const P = require(path.join(dist, 'modules/course-profiles/course-profiles.js'));
const DF = require('./lib/deliverable-fixtures');
const ENV = path.join(os.homedir(), 'cursia-test-env');
const MOODLE_LOCAL_DIR = process.env.MOODLE_LOCAL_DIR || path.join(ENV, 'moodle-local');
const PHP = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';
const PHPINI = path.join(MOODLE_LOCAL_DIR, 'php.ini');
const OUT = process.env.T6_OUT_DIR || path.join(ENV, 'work/r57/t6-moodle-out');

let passes = 0;
let failures = 0;
function check(name, fn) {
  try { fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e && e.message ? e.message.slice(0, 800) : e}`); }
}
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); };
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const base = P.defaultAssessmentProfile({ finalExam: true });
  const input = DF.withProfile(DF.courseInput(dist, { courseId: 772 }), { ...DF.deliveryProfile(base, { graded: true, category: 'applications', rubric: true }), teacherGuide: { include: true } });
  const built = await B.buildDynamicMbzV3(input);
  const v = await V.validateMbzV3(built.mbz, built.expectations);
  check('validador en verde', () => assert(v.ok, JSON.stringify(v.issues.slice(0, 4))));
  fs.mkdirSync(OUT, { recursive: true });
  const mbzPath = path.join(OUT, 't6-teacher-guide.mbz');
  fs.writeFileSync(mbzPath, built.mbz);
  const rs = spawnSync(path.join(MOODLE_LOCAL_DIR, 'restore-and-inspect.sh'), [mbzPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, E2E_MOODLE_DIR: MOODLE_LOCAL_DIR, CURSIA_RESTORE_PHP: path.join(__dirname, 'moodle/restore-as-admin.php') } });
  if (rs.status !== 0) throw new Error(`restore-and-inspect.sh salió con ${rs.status}: ${rs.stderr.slice(-800)}`);
  const courseid = Number((/Restored course id: (\d+)/.exec(rs.stderr) || [])[1]);
  check(`restaurado (curso ${courseid}) sin avisos en la salida del CLI`, () => {
    assert(courseid > 0, 'sin course id');
    eq(rs.stderr.split('\n').filter((l) => /warning|notice|debug|error|exception/i.test(l)), [], 'CLI');
  });
  const inPath = path.join(OUT, 't6-teacher-guide.in.json');
  const outPath = path.join(OUT, 't6-teacher-guide.vis.json');
  fs.writeFileSync(inPath, JSON.stringify({ moodleRoot: path.join(MOODLE_LOCAL_DIR, 'source'), courseid, pagesPattern: '/^cv3:shell:teacher_guide$/', hiddenPattern: '/^cv3:shell:teacher_guide$/' }));
  execFileSync(PHP, ['-c', PHPINI, path.join(__dirname, 'moodle/v21-application-visibility.php'), inPath, outPath], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  const o = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  check('la Guía del docente: oculta, el estudiante no la ve ni la abre, el docente sí, sin completion', () => {
    eq(o.pages.length, 1, 'una guía');
    const p = o.pages[0];
    eq([p.visible, p.studentVisible, p.studentCanView, p.teacherVisible, p.completion], [0, false, false, true, 0], 'visibilidad');
  });
  check('mostrada por error: el estudiante sigue sin poder abrirla (override PROHIBIT restaurado)', () => {
    eq(o.shownByMistake.length, 1, 'probada');
    const x = o.shownByMistake[0];
    eq([x.visible, x.studentOverride, x.studentHasView, x.studentCanOpen, x.teacherCanOpen], [1, -1000, false, false, true], 'mostrada por error');
  });
  console.log(`\n${passes} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
