#!/usr/bin/env node
/* eslint-disable no-console */
// T7 (r57) — paso Moodle de la SIMULACIÓN COMERCIAL: cada curso de scripts/fixtures/commercial-simulation/courses.json
// se arma con el MISMO motor (scripts/lib/commercial-simulation.js) y se restaura de verdad en Moodle LOCALES desechables:
//   - 4.5 local (moodle-local, Postgres 5570);
//   - 4.1, 4.2, 4.3, 4.4 y 4.5 (moodle-versions, cluster 127.0.0.1:5580; se levanta y se apaga aquí si estaba apagado).
// Restauración con la sesión del admin (scripts/moodle/restore-as-admin.php: aplica los overrides de permisos como un
// restore web). Por curso y versión:
//   1. scripts/moodle/check-commercial-acceptance.php — 0 avisos, conteos por modname, H5P evaluativo / «Repaso»,
//      slots aleatorios resolubles + intentos + «Respuestas explicadas», criterio tipo 6, insignia por finalización del
//      curso, categorías y pesos (Tareas en su categoría), archivos descargables, guía del docente y solucionarios ocultos;
//   2. nota final con estudiantes ficticios:
//      - cursos SIN Tarea calificada: scripts/moodle/check-grading-scenarios.php (intentos reales de quiz, xAPI real de
//        H5P, cron de completion ×2, insignia; aprobados y reprobados, «Repaso» sin efecto, override del docente);
//      - cursos CON Tarea calificada: scripts/moodle/check-application-deliverables.php (entrega del estudiante,
//        calificación con rúbrica o directa, nota final = Σ peso × categoría, solucionario oculto, archivos);
//   3. limpieza: curso + usuarios creados (y una limpieza defensiva si un paso falló antes).
// Sin red, sin proveedores, USD 0. Uso (después de npm run build):
//   node scripts/check-commercial-simulation-moodle.js [--targets=4.5-local,4.1,…] [--courses=A-S,…]
// Salidas en $T7_OUT_DIR (default ~/cursia-test-env/work/r57/t7-moodle-out).
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const ROOT = path.resolve(__dirname, '..');
const dist = path.join(ROOT, 'dist');
const S = require('./lib/commercial-simulation');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/commercial-simulation/courses.json'), 'utf8'));
const PHP = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';
const ENV = path.join(os.homedir(), 'cursia-test-env');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6) || process.env.T7_OUT_DIR || path.join(ENV, 'work/r57/t7-moodle-out');
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3).split(',').filter(Boolean);
const onlyTargets = arg('targets');
const onlyCourses = arg('courses');
const TARGETS = [
  { id: '4.5-local', root: path.join(ENV, 'moodle-local/source'), ini: path.join(ENV, 'moodle-local/php.ini'), port: 5570 },
  ...['401', '402', '403', '404', '405'].map((v) => ({ id: `${v[0]}.${Number(v.slice(1))}`, root: path.join(ENV, `moodle-versions/m${v}/source`), ini: path.join(ENV, 'moodle-versions/php.ini'), port: 5580 })),
].filter((t) => !onlyTargets.length || onlyTargets.includes(t.id));
const COURSES = CONFIG.courses.filter((c) => !onlyCourses.length || onlyCourses.includes(c.id));
const CAT_NAME = { practice: 'Práctica de capítulos', applications: 'Actividades de Aplicación', moduleExams: 'Evaluaciones de módulo', finalExam: 'Evaluación final' };

let passed = 0;
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.message ? err.message : err}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const php = (t, args, timeoutMs = 1800000) => spawnSync('/usr/bin/perl', ['-e', '$t=shift; alarm $t; exec @ARGV', String(Math.ceil(timeoutMs / 1000)), PHP, '-d', 'memory_limit=4096M', '-c', t.ini, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
// Avisos de PHP / Moodle. Excepción documentada: «Deprecated: … in <Moodle>/…» de código del NÚCLEO de Moodle 4.1 bajo
// PHP 8.3 (4.1 soporta hasta PHP 8.1: propiedades dinámicas del core) — es del entorno de prueba, no del paquete; se
// cuentan aparte (phpCoreDeprecations) y nunca esconden un Warning/Notice/Fatal/Exception.
const CORE_DEPRECATION = /^\s*(PHP )?Deprecated: .* in \/\S*\/moodle-versions\/m401\/source\/\S+ on line \d+\s*$/;
const stripCoreDeprecations = (s) => String(s || '').split('\n').filter((l) => !CORE_DEPRECATION.test(l)).join('\n');
const coreDeprecations = (s) => String(s || '').split('\n').filter((l) => CORE_DEPRECATION.test(l)).length;
const noPhpNoise = (s) => !/(PHP )?(Warning|Notice|Deprecated|Fatal error):|Debugging:|Exception/i.test(stripCoreDeprecations(s));

/** Expectativas de la aceptación (desde el .mbz y sus facts: lo que Moodle tiene que reproducir). */
async function acceptanceExpect(sim) {
  const insp = await S.inspectMbz(sim.built.mbz);
  const f = sim.built.expectations.facts;
  const res = sim.built.expectations.resolved;
  const appByChapter = new Map(f.chapters.filter((c) => c.applicationDelivery).map((c) => [c.id, c.applicationDelivery]));
  return {
    byModname: insp.byModname,
    h5p: insp.h5p.map((h) => ({ idnumber: h.idnumber, evaluative: !/:review_cards$/.test(h.idnumber) })),
    quizzes: insp.quizzes.map((q) => ({
      idnumber: q.idnumber, slots: q.slots, random: q.randomSlots > 0, attempts: q.attempts,
      explanations: q.idnumber === 'cv3:final_exam' ? 'cv3:final_exam_explanations' : q.idnumber.replace(/^cv3:exam:/, 'cv3:exam_explanations:'),
    })),
    courseGradepass: res.courseGradepass,
    categories: res.categories.map((c) => ({ fullname: c.fullname, weight: c.weight })),
    badge: !!f.finalExam.enabled,
    // r58 (I6): curso sin ítems calificables (r55 R3) → completion por vista del Libro Guía, sin nota.
    withoutGrades: !!res.withoutGrades,
    assigns: insp.pages.filter((p) => p.modname === 'assign').map((p) => {
      const chId = p.idnumber.split(':')[2];
      const d = appByChapter.get(chId);
      return { idnumber: p.idnumber, graded: !!(d && d.graded), categoryName: res.application && res.application.category ? CAT_NAME[res.application.category] : null, maxGrade: res.application ? res.application.maxGrade : null };
    }),
    practiceFiles: (sim.built.summary.practiceResources || []).map((x) => ({ idnumber: `cv3:ch:${x.chapterId}:resource:${x.id}`, filename: x.filename, mimetype: x.mimetype, sha256: x.sha256 })),
    hidden: insp.pages.filter((p) => p.visible === 0 && (p.idnumber === 'cv3:shell:teacher_guide' || /:application_solution$/.test(p.idnumber))).map((p) => p.idnumber),
  };
}

/** Expectativas de check-application-deliverables.php (mismo formato que check-application-deliverables-moodle.js). */
function deliverablesExpect(sim) {
  const r = sim.built;
  const input = sim.input;
  const d = r.expectations.resolved.application;
  const facts = r.expectations.facts;
  const picks = [[2, 1, 2], [1, 1, 0], [2, 2, 2], [0, 1, 1]];
  const appChapterIds = sim.manifest.items.filter((i) => i.type === 'application_activity').map((i) => i.chapterId);
  const assigns = facts.chapters.filter((c) => c.applicationDelivery && c.applicationDelivery.mode === 'assign').map((c, i) => ({
    idnumber: `cv3:ch:${c.id}:application`, graded: d.graded, maxGrade: d.maxGrade, gradepass: d.gradepass,
    categoryName: d.category ? CAT_NAME[d.category] : null, rubric: d.graded && d.rubric,
    rubricCriteria: input.contents.applications.get(c.id).activity.criteria.length, rubricPick: picks[i % picks.length], directGrade: 75,
    onlineText: d.submission.onlineText, file: d.submission.file, maxFiles: d.submission.maxFiles, maxBytes: d.submission.maxBytes,
    fileTypes: d.submission.fileTypes, dueOffsetDays: d.dueOffsetDays,
    linksResources: (c.resources || []).filter((x) => x.relation === 'application').map((x) => `cv3:ch:${c.id}:resource:${x.id}`),
  }));
  const resources = (r.summary.practiceResources || []).map((x) => ({
    idnumber: `cv3:ch:${x.chapterId}:resource:${x.id}`, filename: x.filename, mimetype: x.mimetype, sha256: x.sha256, bytes: x.bytes,
    linkedFrom: x.relation === 'application' && appChapterIds.includes(x.chapterId) ? `cv3:ch:${x.chapterId}:application` : null,
  }));
  return {
    assigns, resources, solutions: appChapterIds.map((id) => `cv3:ch:${id}:application_solution`),
    weights: Object.fromEntries(r.expectations.resolved.categories.map((c) => [CAT_NAME[c.key], c.weight])),
    finalExamIdnumber: 'cv3:final_exam', finalExamGrade: 90, expectAssignContributes: d.graded, assignCategoryName: d.category ? CAT_NAME[d.category] : null,
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const pkgs = [];
  for (const cfg of COURSES) {
    await check(`[${cfg.id}] build + validador (mismo motor; solo configuración)`, async () => {
      const sim = await S.simulateCourse(dist, cfg);
      assert(sim.validation.ok, JSON.stringify(sim.validation.issues.slice(0, 4)));
      const mbzPath = path.join(OUT, `${cfg.id}.mbz`);
      fs.writeFileSync(mbzPath, sim.built.mbz);
      const accPath = path.join(OUT, `${cfg.id}.acceptance.expect.json`);
      fs.writeFileSync(accPath, JSON.stringify(await acceptanceExpect(sim), null, 2));
      const graded = (sim.built.expectations.facts.counts.applicationAssignsGraded || 0) > 0;
      let delPath = null;
      if (graded) { delPath = path.join(OUT, `${cfg.id}.deliverables.expect.json`); fs.writeFileSync(delPath, JSON.stringify(deliverablesExpect(sim), null, 2)); }
      pkgs.push({ cfg, mbzPath, accPath, delPath, graded, title: cfg.title, bytes: sim.built.mbz.length });
    });
  }

  const results = {};
  let startedVersions = false;
  for (const t of TARGETS) {
    try { execFileSync('pg_isready', ['-h', '127.0.0.1', '-p', String(t.port)], { stdio: 'ignore' }); } catch (_) {
      if (t.port === 5580 && !startedVersions) {
        spawnSync('/bin/bash', [path.join(ENV, 'moodle-versions/start.sh')], { stdio: 'ignore' });
        startedVersions = true;
        spawnSync('/bin/sleep', ['3']);
      }
      try { execFileSync('pg_isready', ['-h', '127.0.0.1', '-p', String(t.port)], { stdio: 'ignore' }); } catch (_e) {
        failures++;
        console.error(`❌ ${t.id}: Postgres 127.0.0.1:${t.port} no responde`);
        continue;
      }
    }
    for (const p of pkgs) {
      const tag = `${t.id}-${p.cfg.id}`;
      await check(`${t.id} · [${p.cfg.id}] restaurar + aceptación + nota final con estudiantes ficticios + limpieza`, async () => {
        const t0 = Date.now();
        const minuserid = Number((php(t, [path.join(__dirname, 'moodle/cleanup-test-course.php'), `--moodle=${t.root}`, '--maxuserid']).stdout || '').trim().split('\n').pop());
        assert(minuserid > 0, 'no se pudo leer el mayor id de usuario');
        const rp = php(t, [path.join(__dirname, 'moodle/restore-as-admin.php'), `--moodle=${t.root}`, `--file=${p.mbzPath}`, '--categoryid=1']);
        const courseid = Number((/Course ID: (\d+)/.exec(rp.stdout) || [])[1]);
        fs.writeFileSync(path.join(OUT, `restore-${tag}.log`), `${rp.stdout}\n${rp.stderr}`);
        const row = results[`${t.id}/${p.cfg.id}`] = { courseid, restoreSec: Math.round((Date.now() - t0) / 1000), phpCoreDeprecations: coreDeprecations(rp.stdout) + coreDeprecations(rp.stderr) };
        try {
          assert(rp.status === 0 && courseid > 0, `restore rc ${rp.status}: ${(rp.stderr || rp.stdout).slice(-900)}`);
          assert(noPhpNoise(rp.stderr) && noPhpNoise(rp.stdout.replace(/Course ID: \d+/, '')), `avisos en el restore: ${(rp.stderr || rp.stdout).slice(-600)}`);
          // 1. aceptación
          const accOut = path.join(OUT, `acceptance-${tag}.json`);
          const ap = php(t, [path.join(__dirname, 'moodle/check-commercial-acceptance.php'), `--moodle=${t.root}`, `--courseid=${courseid}`, `--expect=${p.accPath}`, `--out=${accOut}`]);
          fs.writeFileSync(path.join(OUT, `acceptance-${tag}.log`), `${ap.stdout}\n${ap.stderr}`);
          assert(fs.existsSync(accOut), `aceptación sin salida (rc ${ap.status}): ${(ap.stderr || ap.stdout || '').slice(-900)}`);
          const a = JSON.parse(fs.readFileSync(accOut, 'utf8'));
          const badA = a.asserts.filter((x) => !x.ok).map((x) => x.msg);
          row.moodle = a.moodle;
          row.acceptance = { asserts: a.asserts.length, failed: badA.length, counts: a.counts, categories: a.categories };
          assert(badA.length === 0 && a.ok && noPhpNoise(ap.stderr), `aceptación: ${JSON.stringify(badA.slice(0, 6))} ${noPhpNoise(ap.stderr) ? '' : ap.stderr.slice(-400)}`);
          // 2. nota final con estudiantes ficticios (+ limpieza del curso y de sus usuarios)
          const gOut = path.join(OUT, `grades-${tag}.json`);
          const gp = p.graded
            ? php(t, [path.join(__dirname, 'moodle/check-application-deliverables.php'), `--moodle=${t.root}`, `--courseid=${courseid}`, `--expect=${p.delPath}`, `--out=${gOut}`, '--cleanup'])
            : php(t, [path.join(__dirname, 'moodle/check-grading-scenarios.php'), `--moodle=${t.root}`, `--courseid=${courseid}`, `--out=${gOut}`, '--cleanup']);
          fs.writeFileSync(path.join(OUT, `grades-${tag}.log`), `${gp.stdout}\n${gp.stderr}`);
          assert(fs.existsSync(gOut), `nota final sin salida (rc ${gp.status}): ${(gp.stderr || gp.stdout || '').slice(-900)}`);
          const g = JSON.parse(fs.readFileSync(gOut, 'utf8'));
          const badG = (g.asserts || []).filter((x) => !x.ok).map((x) => x.msg);
          row.grades = p.graded
            ? { kind: 'deliverables', asserts: g.asserts.length, failed: badG.length, courseTotal: g.grades && g.grades.courseTotal, expected: g.grades && g.grades.expected, assigns: g.grades && g.grades.assigns }
            : { kind: 'scenarios', asserts: g.asserts.length, failed: badG.length, users: Object.fromEntries(Object.entries(g.users || {}).map(([k, u]) => [k, { grade: u.course_grade, complete: u.complete, badges: u.badges }])) };
          if (p.graded) console.log(`   Moodle ${a.moodle}: aceptación ${a.asserts.length} OK; nota final ${row.grades.courseTotal} (esperada ${row.grades.expected}); Tareas ${JSON.stringify(row.grades.assigns)}`);
          else console.log(`   Moodle ${a.moodle}: aceptación ${a.asserts.length} OK; escenarios ${g.asserts.length} OK — ${Object.entries(row.grades.users).map(([k, u]) => `${k.replace(/_.*/, '')}=${u.grade}${u.complete ? '✓' : '✗'}${u.badges ? '🏅' : ''}`).join(' ')}`);
          assert(badG.length === 0 && g.ok !== false && noPhpNoise(gp.stderr), `nota final: ${JSON.stringify(badG.slice(0, 6))} ${noPhpNoise(gp.stderr) ? '' : gp.stderr.slice(-400)}`);
        } finally {
          // 3. limpieza defensiva (idempotente): el curso de ESTA restauración y los usuarios de prueba de estos scripts.
          if (courseid > 0) {
            const cp = php(t, [path.join(__dirname, 'moodle/cleanup-test-course.php'), `--moodle=${t.root}`, `--courseid=${courseid}`, `--title=${p.title}`, `--minuserid=${minuserid}`, `--prefixes=cursia_t7_est_${courseid}_,r55gs_${courseid}_,cursia_t4_`]);
            row.cleanup = (() => { try { return JSON.parse(cp.stdout.trim().split('\n').pop()); } catch (_) { return { raw: cp.stdout.slice(-300) }; } })();
            row.totalSec = Math.round((Date.now() - t0) / 1000);
          }
        }
        assert(row.cleanup && row.cleanup.course_deleted && row.cleanup.test_users_left === 0, `limpieza: ${JSON.stringify(row.cleanup)}`);
      });
      fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(results, null, 2));
    }
  }
  if (startedVersions) spawnSync('/bin/bash', [path.join(ENV, 'moodle-versions/stop.sh')], { stdio: 'ignore' });
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(results, null, 2));
  console.log(`\n${passed} ok, ${failures} fallos (salidas: ${OUT})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
