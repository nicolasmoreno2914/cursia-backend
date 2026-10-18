#!/usr/bin/env node
/* eslint-disable no-console */
// T4/T5 (r57) — restauración REAL de paquetes con Tareas (mod_assign) y archivos de trabajo en Moodle LOCALES desechables:
//   - 4.5 local (moodle-local, Postgres 5570): restaurado por un DOCENTE (restore-as-teacher.php);
//   - 4.1, 4.2, 4.3, 4.4 y 4.5 (moodle-versions, cluster 127.0.0.1:5580): restaurado por un administrador.
// Dos paquetes: (A) AA como Tarea CALIFICADA con rúbrica en su categoría «Actividades de Aplicación» + archivos de trabajo
// xlsx/docx/pdf subidos y csv/xlsx generados enlazados desde la Tarea; (B) Tarea FORMATIVA (+ un capítulo en página).
// Por paquete y versión: scripts/moodle/check-application-deliverables.php (estudiante envía, docente califica con la
// rúbrica, nota final ponderada, solucionario oculto, descarga y enlace de los archivos) y limpieza (curso + usuarios).
// Sin red, sin proveedores. Uso: node scripts/check-application-deliverables-moodle.js [--only=4.5-local,4.1,…]
//   (después de npm run build). Salidas JSON en $T4_OUT_DIR (default ~/cursia-test-env/work/r57/t4t5-moodle-out).
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
const A = require(path.join(dist, 'package/assessment/index.js'));
const DF = require('./lib/deliverable-fixtures');
const PHP = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';
const ENV = path.join(os.homedir(), 'cursia-test-env');
const OUT = process.env.T4_OUT_DIR || path.join(ENV, 'work/r57/t4t5-moodle-out');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const TARGETS = [
  { id: '4.5-local', root: path.join(ENV, 'moodle-local/source'), ini: path.join(ENV, 'moodle-local/php.ini'), port: 5570, teacher: true },
  ...['401', '402', '403', '404', '405'].map((v) => ({ id: `${v[0]}.${Number(v.slice(1))}`, root: path.join(ENV, `moodle-versions/m${v}/source`), ini: path.join(ENV, 'moodle-versions/php.ini'), port: 5580, teacher: false })),
].filter((t) => !only.length || only.includes(t.id));

let passed = 0;
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.message ? err.message : err}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const php = (t, args, timeoutMs = 900000) => spawnSync('/usr/bin/perl', ['-e', '$t=shift; alarm $t; exec @ARGV', String(Math.ceil(timeoutMs / 1000)), PHP, '-d', 'memory_limit=2048M', '-c', t.ini, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const CAT_NAME = { practice: 'Práctica de capítulos', applications: 'Actividades de Aplicación', moduleExams: 'Evaluaciones de módulo', finalExam: 'Evaluación final' };

function expectFor(r, input, appChapterIds, o) {
  const d = r.expectations.resolved.application;
  const facts = r.expectations.facts;
  const assigns = facts.chapters.filter((c) => c.applicationDelivery && c.applicationDelivery.mode === 'assign').map((c, i) => ({
    idnumber: `cv3:ch:${c.id}:application`,
    graded: d.graded,
    maxGrade: d.maxGrade,
    gradepass: d.gradepass,
    categoryName: d.category ? CAT_NAME[d.category] : null,
    rubric: d.graded && d.rubric,
    rubricCriteria: input.contents.applications.get(c.id).activity.criteria.length,
    rubricPick: o.picks[i % o.picks.length],
    directGrade: 75,
    onlineText: d.submission.onlineText,
    file: d.submission.file,
    maxFiles: d.submission.maxFiles,
    maxBytes: d.submission.maxBytes,
    fileTypes: d.submission.fileTypes,
    dueOffsetDays: d.dueOffsetDays,
    linksResources: (c.resources || []).filter((x) => x.relation === 'application').map((x) => `cv3:ch:${c.id}:resource:${x.id}`),
  }));
  const resources = (r.summary.practiceResources || []).map((x) => ({
    idnumber: `cv3:ch:${x.chapterId}:resource:${x.id}`, filename: x.filename, mimetype: x.mimetype, sha256: x.sha256, bytes: x.bytes,
    linkedFrom: x.relation === 'application' ? `cv3:ch:${x.chapterId}:application` : null,
  }));
  return {
    assigns,
    resources,
    solutions: appChapterIds.map((id) => `cv3:ch:${id}:application_solution`),
    weights: Object.fromEntries(r.expectations.resolved.categories.map((c) => [CAT_NAME[c.key], c.weight])),
    finalExamIdnumber: 'cv3:final_exam',
    finalExamGrade: 90,
    expectAssignContributes: d.graded,
    assignCategoryName: d.category ? CAT_NAME[d.category] : null,
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const course = DF.courseInput(dist);
  const appChapterIds = course.manifest.items.filter((i) => i.type === 'application_activity').map((i) => i.key.slice('application_activity:'.length));
  const base = P.defaultAssessmentProfile({ finalExam: true });
  const pkgs = [];
  {
    const w = await DF.withPracticeFiles(dist, course, DF.deliveryProfile(base, { graded: true, category: 'applications', rubric: true }), appChapterIds);
    const r = await B.buildDynamicMbzV3(w.input);
    pkgs.push({ id: 'A-graded-rubric-files', r, input: w.input, picks: [[2, 1, 2], [1, 1, 0], [2, 2, 2], [0, 1, 1]] });
  }
  {
    const input = DF.withProfile(course, DF.deliveryProfile(base, { graded: false, chapterModes: { [appChapterIds[1]]: 'page' }, dueOffsetDays: null, submission: { onlineText: false, file: true, maxFiles: 1, maxBytes: 2 * 1024 * 1024, fileTypes: ['.pdf'] } }));
    const r = await B.buildDynamicMbzV3(input);
    pkgs.push({ id: 'B-formative', r, input, picks: [[0, 0, 0]] });
  }
  for (const p of pkgs) {
    await check(`${p.id}: build ${B.DYNAMIC_MBZ_BUILDER_VERSION_V3} + validador v3 limpio`, async () => {
      const v = await V.validateMbzV3(p.r.mbz, p.r.expectations);
      assert(v.ok, JSON.stringify(v.issues.slice(0, 5)));
      p.mbzPath = path.join(OUT, `${p.id}.mbz`);
      fs.writeFileSync(p.mbzPath, p.r.mbz);
      p.expectPath = path.join(OUT, `${p.id}.expect.json`);
      fs.writeFileSync(p.expectPath, JSON.stringify(expectFor(p.r, p.input, appChapterIds, p), null, 2));
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
      if (!p.mbzPath) continue;
      await check(`${t.id} · ${p.id}: restaurar${t.teacher ? ' como DOCENTE' : ''} + Tarea/rúbrica/entrega/calificación/nota final/solucionario/archivos + limpieza`, async () => {
        const script = t.teacher ? 'restore-as-teacher.php' : 'restore-as-admin.php';
        const rp = php(t, [path.join(__dirname, 'moodle', script), `--moodle=${t.root}`, `--file=${p.mbzPath}`, '--categoryid=1']);
        const courseid = Number((/Course ID: (\d+)/.exec(rp.stdout) || [])[1]);
        const teacherid = Number((/Teacher ID: (\d+)/.exec(rp.stdout) || [])[1]);
        fs.writeFileSync(path.join(OUT, `restore-${t.id}-${p.id}.log`), `${rp.stdout}\n${rp.stderr}`);
        assert(rp.status === 0 && courseid > 0, `restore rc ${rp.status}: ${(rp.stderr || rp.stdout).slice(-900)}`);
        const outJ = path.join(OUT, `check-${t.id}-${p.id}.json`);
        const args = [path.join(__dirname, 'moodle/check-application-deliverables.php'), `--moodle=${t.root}`, `--courseid=${courseid}`, `--expect=${p.expectPath}`, `--out=${outJ}`];
        if (process.env.T4_KEEP_COURSE !== '1') args.push('--cleanup', ...(teacherid ? [`--teacherid=${teacherid}`] : []));
        const cp = php(t, args);
        fs.writeFileSync(path.join(OUT, `check-${t.id}-${p.id}.log`), `${cp.stdout}\n${cp.stderr}`);
        assert(fs.existsSync(outJ), `sin salida (rc ${cp.status}): ${(cp.stderr || cp.stdout || '').slice(-900)}`);
        const o = JSON.parse(fs.readFileSync(outJ, 'utf8'));
        const bad = o.asserts.filter((a) => !a.ok).map((a) => a.msg);
        results[`${t.id}/${p.id}`] = { moodle: o.moodle, asserts: o.asserts.length, failed: bad.length, courseTotal: o.grades && o.grades.courseTotal, expected: o.grades && o.grades.expected, assigns: o.grades && o.grades.assigns, cleanup: o.cleanup };
        console.log(`   Moodle ${o.moodle}: ${o.asserts.length} asserts, nota final ${o.grades && o.grades.courseTotal} (esperada ${o.grades && o.grades.expected}); Tareas ${JSON.stringify(o.grades && o.grades.assigns)}`);
        assert(bad.length === 0 && o.ok, JSON.stringify(bad.slice(0, 8)));
        if (process.env.T4_KEEP_COURSE !== '1') assert(o.cleanup && o.cleanup.course_deleted && o.cleanup.users_deleted, `limpieza: ${JSON.stringify(o.cleanup)}`);
      });
    }
  }
  if (startedVersions) spawnSync('/bin/bash', [path.join(ENV, 'moodle-versions/stop.sh')], { stdio: 'ignore' });
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(results, null, 2));
  console.log(`\n${passed} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
