#!/usr/bin/env node
/* eslint-disable */
// Cursia r55 (R1–R8) — invariantes de calificación y «Repaso» solo contenido en el Moodle 4.5 LOCAL desechable.
// Sin red, sin proveedores, sin Moodle remoto. Requiere Postgres del Moodle local (127.0.0.1:5570) y `npm run build`.
//
//  1. build (reloj fijo) de un curso fixture con H5P v2 (caso ramificado + «Repaso»), evaluación de módulo y final;
//     validador v3 limpio;
//  2. preflight del sitio vs CURSIA_H5P_PROFILE_V3 (requisito del sitio de los paquetes ≥ 3.14.0);
//  3. scripts/moodle/check-review-cards-deploy.php con un «Repaso» del paquete: despliegue real con dueño admin y
//     DOCENTE, 4 estados de librerías del sitio, procesos nuevos con timeout + un proceso cebado admin → docente;
//  4. restauración como DOCENTE (scripts/moodle/restore-as-teacher.php: archivos con el docente como dueño);
//  5. scripts/moodle/check-grading-scenarios.php sobre ese curso (intentos reales de quiz, xAPI real de H5P, cron
//     de completion ×2, insignia activada como el docente): curso completo ⇔ nota final ≥ mínimo, etc.;
//  6. limpieza: borra el curso, los estudiantes y el docente creados aquí (nunca otros cursos).
//
// Variables: E2E_MOODLE_DIR / MOODLE_LOCAL_DIR (raíz del Moodle local, con source/ y php.ini), PHP_BIN,
// R55_OUT_DIR (salidas JSON; default <moodle>/r55-grading-out). Uso: node scripts/check-moodle-grading-invariants.js

const path = require('path');
const fs = require('fs');
const { spawnSync, execFileSync } = require('child_process');
const JSZip = require('jszip');
require('reflect-metadata');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const ROOT = path.resolve(__dirname, '..');
const dist = path.join(ROOT, 'dist');
const MOODLE = process.env.E2E_MOODLE_DIR || process.env.MOODLE_LOCAL_DIR || '/Users/nicolas/cursia-test-env/moodle-local';
const PHP = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';
const PHPINI = path.join(MOODLE, 'php.ini');
const OUT = process.env.R55_OUT_DIR || path.join(MOODLE, 'r55-grading-out');
const B = require(path.join(dist, 'package/dynamic-mbz-builder-v3.js'));
const V = require(path.join(dist, 'package/v3/mbz-validator-v3.js'));
const PF = require('./lib/v21-packaging-fixtures');

let passed = 0;
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.message ? err.message : err}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const php = (args, timeoutMs = 900000) => spawnSync('/usr/bin/perl', ['-e', '$t=shift; alarm $t; exec @ARGV', String(Math.ceil(timeoutMs / 1000)), PHP, '-d', 'memory_limit=2048M', '-c', PHPINI, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const failedAsserts = (o) => (o.asserts || []).filter((a) => !a.ok).map((a) => a.msg);

const CFG = { engine: 'h5p', finalExam: true, activityTypeRules: 2, reviewCards: true, courseId: 655, chapterObjectives: ['Decidir cómo atender un reclamo', 'Escuchar al cliente', 'Identificar partes', 'Identificar partes'] };

(async () => {
  try { execFileSync('pg_isready', ['-h', '127.0.0.1', '-p', '5570'], { stdio: 'ignore' }); } catch (_) {
    console.error('❌ Postgres del Moodle local no responde en 127.0.0.1:5570 (correr moodle-local/start.sh)');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const r = await B.buildDynamicMbzV3(PF.packagingInput(dist, CFG));
  const mbzPath = path.join(OUT, 'r55-grading-fixture.mbz');
  fs.writeFileSync(mbzPath, r.mbz);
  await check(`build ${B.DYNAMIC_MBZ_BUILDER_VERSION_V3} + validador v3 limpio (H5P v2 + «Repaso» + evaluaciones)`, async () => {
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 5)));
    assert((r.expectations.facts.counts.reviewCards || 0) > 0 && r.expectations.facts.counts.exams > 0 && r.expectations.facts.finalExam.enabled, 'fixture incompleto');
  });
  await check('preflight del sitio vs CURSIA_H5P_PROFILE_V3', async () => {
    const pf = spawnSync(process.execPath, [path.join(__dirname, 'h5p-preflight-moodle.js'), path.join(MOODLE, 'source'), PHPINI, '--profile', 'v3'], { encoding: 'utf8', env: { ...process.env, PHP_BIN: PHP } });
    assert(pf.status === 0, pf.stdout + pf.stderr);
  });

  // ── «Repaso» solo contenido: despliegue real ──
  const z = await JSZip.loadAsync(r.mbz);
  const dc = r.summary.h5pPackages.find((p) => p.mainLibrary === 'H5P.Dialogcards');
  const dcPath = path.join(OUT, dc.filename);
  fs.writeFileSync(dcPath, await z.file(`files/${dc.sha1.slice(0, 2)}/${dc.sha1}`).async('nodebuffer'));
  await check('«Repaso» solo contenido en Moodle: despliega con dueño admin y docente, falla limpio sin la librería, nunca cuelga (procesos nuevos + proceso cebado admin → docente)', async () => {
    const outJ = path.join(OUT, 'review-cards-deploy.json');
    const p = php([path.join(__dirname, 'moodle/check-review-cards-deploy.php'), `--moodle=${path.join(MOODLE, 'source')}`, `--h5p=${dcPath}`, `--out=${outJ}`, '--timeout=20', `--php=${PHP}`, `--phpini=${PHPINI}`], 600000);
    assert(fs.existsSync(outJ), `sin salida (rc ${p.status}): ${(p.stderr || '').slice(-600)}`);
    const o = JSON.parse(fs.readFileSync(outJ, 'utf8'));
    assert(o.ok && p.status === 0, JSON.stringify(failedAsserts(o)));
    assert(o.cleanup && o.cleanup.course_deleted && o.cleanup.users_deleted, `limpieza: ${JSON.stringify(o.cleanup)}`);
    console.log(`   ${o.asserts.length} asserts; ${o.cases.length} casos (máx ${Math.max(...o.cases.map((c) => c.secs))} s)`);
  });

  // ── Restauración como DOCENTE + escenarios reales ──
  let courseid = null;
  let teacherid = null;
  await check('restauración como docente (editingteacher, archivos con el docente como dueño): sin errores', async () => {
    const p = php([path.join(__dirname, 'moodle/restore-as-teacher.php'), `--moodle=${path.join(MOODLE, 'source')}`, `--file=${mbzPath}`, '--categoryid=1']);
    courseid = Number((/Course ID: (\d+)/.exec(p.stdout) || [])[1]);
    teacherid = Number((/Teacher ID: (\d+)/.exec(p.stdout) || [])[1]);
    fs.writeFileSync(path.join(OUT, 'restore-as-teacher.log'), `${p.stdout}\n${p.stderr}`);
    assert(p.status === 0 && courseid > 0 && teacherid > 0, `rc ${p.status}: ${(p.stderr || p.stdout).slice(-800)}`);
    assert(!/warning|notice|exception/i.test(p.stderr || ''), (p.stderr || '').slice(-800));
  });
  if (courseid) {
    await check(`escenarios de calificación reales en el curso restaurado por el docente (curso ${courseid})`, async () => {
      const outJ = path.join(OUT, 'grading-scenarios.json');
      const args = [path.join(__dirname, 'moodle/check-grading-scenarios.php'), `--moodle=${path.join(MOODLE, 'source')}`, `--courseid=${courseid}`, `--out=${outJ}`];
      if (process.env.R55_KEEP_COURSE !== '1') args.push('--cleanup', `--teacherid=${teacherid}`);
      const p = php(args);
      assert(fs.existsSync(outJ), `sin salida (rc ${p.status}): ${(p.stderr || p.stdout || '').slice(-800)}`);
      const o = JSON.parse(fs.readFileSync(outJ, 'utf8'));
      const bad = failedAsserts(o);
      for (const [tag, u] of Object.entries(o.users || {})) console.log(`   ${tag}: nota ${u.course_grade} completo ${u.complete} insignias ${u.badges}`);
      assert(o.ok && p.status === 0 && bad.length === 0, JSON.stringify(bad));
      assert(!/PHP (Warning|Notice|Deprecated)/.test(p.stderr || ''), (p.stderr || '').slice(-600));
      console.log(`   ${o.asserts.length} asserts OK`);
    });
  }
  console.log(`\n${passed} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
