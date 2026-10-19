#!/usr/bin/env node
/* eslint-disable no-console */
// r60 (D1/D2) — restauraciones REALES en los Moodle locales desechables 4.1, 4.2, 4.3, 4.4, 4.5 (moodle-versions,
// cluster 127.0.0.1:5580) y 4.5 local (moodle-local, 5570) de dos paquetes armados con el motor de la simulación:
//   - «con-h5p»: [1x1-sin-examenes] (video interactivo + conjunto de preguntas, nota mínima 70) → minimumMoodle 4.5;
//   - «sin-h5p»: [1x1-sin-nota] sin «Repaso» (curso sin nota, sin H5P) → minimumMoodle 4.1.
// Por versión y paquete: restaurar (sesión de admin), scripts/moodle/r60-compat-inspect.php (API H5P del núcleo,
// librerías instaladas, despliegue de cada H5P, interacciones del video, tokens y destino de cada botón a sección,
// nota mínima y criterio), render HTTP como ESTUDIANTE (php -S en el wwwroot del sitio: curso, cada botón a sección,
// view.php de cada H5P y su embed), nota/finalización con estudiantes ficticios (check-grading-scenarios.php: xAPI
// real de H5P + cron ×2) y limpieza (curso + usuarios). El resultado de cada fila se compara con lo que el paquete
// DECLARA: en una versión ≥ minimumMoodle todo tiene que funcionar; en una menor, el H5P tiene que fallar como se
// documenta (no se finge compatibilidad).
// Requisito: el pack H5P v3 instalado en los sitios ≥ 4.5 (install-h5p-pack.php; en 4.1–4.4 Moodle lo rechaza).
// Sin red, sin proveedores, USD 0. Uso (después de npm run build):
//   node scripts/r60-moodle-compat-matrix.js [--targets=4.1,4.5-local] [--out=<dir>]
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const ROOT = path.resolve(__dirname, '..');
const dist = path.join(ROOT, 'dist');
const S = require('./lib/commercial-simulation');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/commercial-simulation/courses.json'), 'utf8'));
const PHP = process.env.PHP_BIN || '/opt/homebrew/bin/php';
const ENV = path.join(os.homedir(), 'cursia-test-env');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6) || path.join(ENV, 'work/r60/A/real');
const onlyTargets = ((process.argv.find((a) => a.startsWith('--targets=')) || '').slice(10)).split(',').filter(Boolean);
const TARGETS = [
  ...['401', '402', '403', '404', '405'].map((v) => ({ id: `4.${Number(v.slice(1))}`, root: path.join(ENV, `moodle-versions/m${v}/source`), ini: path.join(ENV, 'moodle-versions/php.ini'), port: 5580, host: 'localhost', web: 8100 + Number(v.slice(1)) })),
  { id: '4.5-local', root: path.join(ENV, 'moodle-local/source'), ini: path.join(ENV, 'moodle-local/php.ini'), port: 5570, host: '127.0.0.1', web: 8099 },
].filter((t) => !onlyTargets.length || onlyTargets.includes(t.id));
const cmp = (a, b) => { const [x1, x2] = a.split('.').map(Number); const [y1, y2] = b.split('.').map(Number); return x1 !== y1 ? x1 - y1 : x2 - y2; };

let passed = 0;
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.message ? err.message : err}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const php = (t, args, timeoutMs = 1800000) => spawnSync('/usr/bin/perl', ['-e', '$t=shift; alarm $t; exec @ARGV', String(Math.ceil(timeoutMs / 1000)), PHP, '-d', 'memory_limit=4096M', '-d', 'error_reporting=24575', '-c', t.ini, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Cliente HTTP mínimo (solo localhost) con cookies ──
function client(host, port) {
  const jar = {};
  const req = (method, p, body) => new Promise((resolve, reject) => {
    const u = new URL(p, `http://${host}:${port}`);
    if (!['localhost', '127.0.0.1'].includes(u.hostname)) return reject(new Error(`host no local: ${u.hostname}`));
    const headers = { Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(body); }
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, timeout: 180000 }, (res) => {
      for (const c of res.headers['set-cookie'] || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body: Buffer.concat(chunks).toString('utf8'), url: u.href }));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (body) r.write(body);
    r.end();
  });
  const get = async (p, hops = 5) => {
    let r = await req('GET', p);
    while (hops-- > 0 && r.status >= 300 && r.status < 400 && r.location) r = await req('GET', new URL(r.location, r.url).href);
    return r;
  };
  return { req, get };
}
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function startWeb(t) {
  const busy = spawnSync('/usr/sbin/lsof', ['-ti', `:${t.web}`], { encoding: 'utf8' }).stdout.trim();
  if (busy) return { proc: null, reused: true };
  const proc = spawn(PHP, ['-d', 'display_errors=0', '-d', 'error_reporting=24575', '-c', t.ini, '-S', `${t.host}:${t.web}`, '-t', t.root], { stdio: ['ignore', fs.openSync(path.join(OUT, `php-server-${t.id}.log`), 'a'), fs.openSync(path.join(OUT, `php-server-${t.id}.log`), 'a')] });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { const r = await client(t.host, t.web).req('GET', '/login/index.php'); if (r.status) return { proc, reused: false }; } catch (_) { /* aún no */ }
  }
  proc.kill();
  throw new Error(`php -S ${t.host}:${t.web} no respondió`);
}

async function studentRender(t, credsFile, insp, kind) {
  const c = client(t.host, t.web);
  const creds = Object.fromEntries(fs.readFileSync(credsFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const lp = await c.get('/login/index.php');
  const tok = (/name="logintoken" value="([^"]+)"/.exec(lp.body) || [])[1];
  const lr = await c.req('POST', '/login/index.php', new URLSearchParams({ username: creds.username, password: creds.password, logintoken: tok || '' }).toString());
  assert(lr.status === 303 || lr.status === 302, `login ${lr.status}: ${((/<div[^>]*(?:loginerrors|alert-danger)[^>]*>([\s\S]{0,300}?)<\/div>/.exec(lr.body) || [])[1] || lr.body.slice(0, 200)).replace(/\s+/g, " ")}`);
  const out = { course: null, sections: [], h5p: [] };
  const cv = await c.get(`/course/view.php?id=${insp.courseid}`);
  out.course = { status: cv.status, unresolvedTokens: (cv.body.match(/\$@[A-Z0-9_]+\*?\d*@\$/g) || []).length, error: /errorcode|class="errormessage"/.test(cv.body) };
  // Botones a secciones tal como los ve el estudiante (labels de la sección 0 y de cada sección visitada).
  const seen = new Set();
  const pages = [cv.body];
  for (const s of insp.sections) {
    const r = await c.get(`/course/view.php?id=${insp.courseid}&section=${s.num}`);
    pages.push(r.body);
  }
  const hrefs = new Set();
  for (const b of pages) for (const m of b.matchAll(/href="(http:\/\/[^"]+\/course\/(?:section|view)\.php\?[^"]+)"/g)) {
    const u = unesc(m[1]);
    if (/[?&]id=\d+/.test(u) && (/section\.php/.test(u) || /section=\d+/.test(u)) && !/[?&](edit|sesskey|notifyeditingon)=/.test(u)) hrefs.add(u);
  }
  // Solo los destinos de los botones de los labels (los del inspector), no la navegación del tema.
  const labelUrls = new Set(insp.links.map((l) => l.url));
  for (const u of hrefs) {
    if (!labelUrls.has(u) || seen.has(u)) continue;
    seen.add(u);
    const link = insp.links.find((l) => l.url === u);
    const r = await c.get(u);
    const sec = insp.sections.find((s) => s.num === link.sectionNum);
    out.sections.push({ url: u.replace(/^http:\/\/[^/]+/, ''), form: link.form, sectionNum: link.sectionNum, status: r.status, final: r.url.replace(/^http:\/\/[^/]+/, ''),
      showsSection: !!sec && r.body.includes(esc(sec.name)), unresolvedTokens: (r.body.match(/\$@[A-Z0-9_]+\*?\d*@\$/g) || []).length, error: /errorcode|class="errormessage"/.test(r.body) });
  }
  out.labelLinksNotRendered = insp.links.filter((l) => !seen.has(l.url)).map((l) => l.url);
  for (const h of insp.h5p) {
    const v = await c.get(`/mod/h5pactivity/view.php?id=${h.cmid}`);
    // El player de view.php es un iframe a /h5p/embed.php?url=<pluginfile del package>; el intro puede traer otro iframe
    // inline (cargador CursiaIV: su URL se reescribe en el navegador). Se prueban todos y se reporta el del player.
    const srcs = Array.from(v.body.matchAll(/<iframe[^>]+src="([^"]*\/h5p\/embed\.php[^"]*)"/g), (m) => unesc(m[1]));
    const tried = [];
    for (const u of srcs) {
      const e = await c.get(u);
      tried.push({ player: /mod_h5pactivity%2Fpackage|mod_h5pactivity\/package/.test(u) && /pluginfile\.php/.test(decodeURIComponent(u)), status: e.status, h5pIntegration: /H5PIntegration/.test(e.body),
        missing: (/(Missing (?:required|main) library[^<"]*)/.exec(e.body) || [])[1] || null, mainLibrary: (/"library":"([^"]+)"/.exec(e.body) || [])[1] || null,
        notice: !/H5PIntegration/.test(e.body) ? ((/class="[^"]*(?:alert|errormessage|notifyproblem)[^"]*"[^>]*>([\s\S]{0,240}?)<\/div>/.exec(e.body) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null });
    }
    const pl = tried.find((x) => x.h5pIntegration) || tried.find((x) => x.player) || tried[tried.length - 1] || null;
    out.h5p.push({ idnumber: h.idnumber, viewStatus: v.status, embeds: tried.length, embedStatus: pl && pl.status, h5pIntegration: !!pl && pl.h5pIntegration, missing: pl && pl.missing, mainLibraryInEmbed: pl && pl.mainLibrary, notice: pl && pl.notice, all: tried });
  }
  await c.get('/login/logout.php');
  return out;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const pkgs = [];
  for (const [kind, cfg] of [
    ['con-h5p', CONFIG.courses.find((c) => c.id === '1x1-sin-examenes')],
    ['sin-h5p', { ...CONFIG.courses.find((c) => c.id === '1x1-sin-nota'), id: '1x1-sin-nota-sin-h5p', reviewCards: false }],
  ]) {
    await check(`[${kind}] build + validador`, async () => {
      const sim = await S.simulateCourse(dist, cfg);
      assert(sim.validation.ok, JSON.stringify(sim.validation.issues.slice(0, 4)));
      const mbzPath = path.join(OUT, `${kind}.mbz`);
      fs.writeFileSync(mbzPath, sim.built.mbz);
      pkgs.push({ kind, mbzPath, compat: sim.built.summary.moodleCompatibility, withoutGrades: !!sim.built.expectations.resolved.withoutGrades, gradepass: sim.built.expectations.resolved.courseGradepass });
      console.log(`   ${kind}: minimumMoodle ${sim.built.summary.moodleCompatibility.minimumMoodle}, enlaces ${sim.built.summary.moodleCompatibility.sectionLinks}, H5P ${sim.built.summary.h5pPackages.map((p) => p.mainLibrary).join(', ') || '—'}`);
    });
  }

  const results = {};
  let startedVersions = false;
  for (const t of TARGETS) {
    try { execFileSync('pg_isready', ['-h', '127.0.0.1', '-p', String(t.port)], { stdio: 'ignore' }); } catch (_) {
      if (t.port === 5580 && !startedVersions) { spawnSync('/bin/bash', [path.join(ENV, 'moodle-versions/start.sh')], { stdio: 'ignore' }); startedVersions = true; await sleep(3000); }
    }
    let web;
    try { web = await startWeb(t); } catch (e) { failures++; console.error(`❌ ${t.id}: ${e.message}`); continue; }
    try {
      for (const p of pkgs) {
        const tag = `${t.id}-${p.kind}`;
        await check(`${t.id} · [${p.kind}] (declara Moodle ${p.compat.minimumMoodle}+) restaurar + inspección + render de estudiante + nota + limpieza`, async () => {
          const supported = cmp(t.id.replace('-local', ''), p.compat.minimumMoodle) >= 0;
          const minuserid = Number((php(t, [path.join(__dirname, 'moodle/cleanup-test-course.php'), `--moodle=${t.root}`, '--maxuserid']).stdout || '').trim().split('\n').pop());
          const rp = php(t, [path.join(__dirname, 'moodle/restore-as-admin.php'), `--moodle=${t.root}`, `--file=${p.mbzPath}`, '--categoryid=1']);
          const courseid = Number((/Course ID: (\d+)/.exec(rp.stdout) || [])[1]);
          fs.writeFileSync(path.join(OUT, `restore-${tag}.log`), `${rp.stdout}\n${rp.stderr}`);
          const row = results[tag] = { target: t.id, kind: p.kind, declaredMinimum: p.compat.minimumMoodle, supported, courseid, restore: rp.status === 0 && courseid > 0 };
          let fullname = null;
          let credsFile = null;
          try {
            assert(row.restore, `restore rc ${rp.status}: ${(rp.stderr || rp.stdout).slice(-600)}`);
            const inspOut = path.join(OUT, `inspect-${tag}.json`);
            const ip = php(t, [path.join(__dirname, 'moodle/r60-compat-inspect.php'), `--moodle=${t.root}`, `--courseid=${courseid}`, `--out=${inspOut}`]);
            assert(fs.existsSync(inspOut), `inspección sin salida: ${(ip.stderr || ip.stdout).slice(-600)}`);
            const insp = JSON.parse(fs.readFileSync(inspOut, 'utf8'));
            fullname = insp.fullname;
            row.moodle = insp.moodle;
            row.h5pCoreApi = insp.h5pCoreApi;
            row.h5pLibrariesInstalled = insp.h5pLibrariesInstalled;
            row.h5p = insp.h5p.map((h) => ({ idnumber: h.idnumber, deployed: h.deployed, mainLibrary: h.mainLibrary || null, errors: (h.errors || []).slice(0, 2), interactions: h.interactiveVideo ? h.interactiveVideo.interactions : undefined, questions: h.questionSet ? h.questionSet.questions : undefined, player: h.player ? h.player.ok : null }));
            row.unresolvedTokens = insp.unresolvedTokens;
            row.links = insp.links.map((l) => ({ idnumber: l.idnumber, form: l.form, sectionNum: l.sectionNum, ok: l.ok }));
            row.courseGradepass = insp.courseGradepass;
            row.completionCriteria = insp.completionCriteria;
            // Render del estudiante.
            credsFile = path.join(OUT, `.student-${tag}.creds`);
            const sp = php(t, [path.join(__dirname, 'moodle/r60-test-student.php'), `--moodle=${t.root}`, '--action=create', `--courseids=${courseid}`, `--creds=${credsFile}`]);
            assert(/created userid=\d+ siteadmin=0/.test(sp.stdout), `estudiante: ${(sp.stderr || sp.stdout).slice(-300)}`);
            row.student = await studentRender(t, credsFile, insp, p.kind);
            // Nota / finalización con estudiantes ficticios (xAPI real de H5P; curso sin nota: vista del Libro).
            const gOut = path.join(OUT, `grades-${tag}.json`);
            const gp = php(t, [path.join(__dirname, 'moodle/check-grading-scenarios.php'), `--moodle=${t.root}`, `--courseid=${courseid}`, `--out=${gOut}`]);
            fs.writeFileSync(path.join(OUT, `grades-${tag}.log`), `${gp.stdout}\n${gp.stderr}`);
            const g = fs.existsSync(gOut) ? JSON.parse(fs.readFileSync(gOut, 'utf8')) : null;
            row.grades = g ? { asserts: g.asserts.length, failed: g.asserts.filter((x) => !x.ok).length, users: Object.fromEntries(Object.entries(g.users || {}).map(([k, u]) => [k, { grade: u.course_grade, complete: u.complete }])) } : { error: (gp.stderr || gp.stdout).slice(-400) };
            fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(results, null, 2));

            // ── Veredicto ──
            const allLinksOk = row.links.length > 0 && row.links.every((l) => l.ok) && row.unresolvedTokens.length === 0;
            const studentLinksOk = row.student.sections.length > 0 && row.student.sections.every((s) => s.status === 200 && s.showsSection && !s.unresolvedTokens && !s.error) && !row.student.labelLinksNotRendered.length;
            const gradesOk = row.grades && row.grades.failed === 0 && row.grades.asserts > 0;
            row.navigation = allLinksOk && studentLinksOk ? 'OK' : 'FAIL';
            if (p.kind === 'con-h5p') {
              const h5pOk = row.h5p.length > 0 && row.h5p.every((h) => h.deployed && h.player && !h.errors.length) && row.student.h5p.every((h) => h.viewStatus === 200 && h.h5pIntegration && !h.missing);
              row.h5pStatus = h5pOk ? 'OK' : 'FAIL';
              const iv = row.h5p.find((h) => /:video$/.test(h.idnumber));
              row.interactiveVideo = iv && iv.deployed && iv.interactions > 0 ? `OK (${iv.mainLibrary}, ${iv.interactions} interacciones)` : 'FAIL';
            } else row.h5pStatus = row.h5p.length ? 'UNEXPECTED_H5P' : 'n/a';
            row.verdict = supported
              ? (row.navigation === 'OK' && gradesOk && (row.h5pStatus === 'OK' || row.h5pStatus === 'n/a') ? 'VALIDATED' : 'FAIL')
              : (row.h5pStatus === 'FAIL' ? 'NOT SUPPORTED (declarado; H5P no instalable)' : 'UNEXPECTED: funciona bajo el mínimo declarado');
            console.log(`   Moodle ${row.moodle} (H5P ${row.h5pCoreApi}, ${row.h5pLibrariesInstalled} libs): H5P ${row.h5pStatus}; navegación ${row.navigation} (${row.student.sections.map((s) => `${s.form}→${s.sectionNum}:${s.status}${s.showsSection ? '✓' : '✗'}`).join(' ')}); nota ${gradesOk ? 'OK' : 'FAIL'} ${JSON.stringify(row.grades.users || row.grades)} → ${row.verdict}`);
            if (supported) assert(row.verdict === 'VALIDATED', `${tag}: ${row.verdict} ${JSON.stringify({ h5p: row.h5p, student: row.student }).slice(0, 900)}`);
            else assert(/^NOT SUPPORTED/.test(row.verdict), `${tag}: ${row.verdict}`);
          } finally {
            if (credsFile && fs.existsSync(credsFile)) php(t, [path.join(__dirname, 'moodle/r60-test-student.php'), `--moodle=${t.root}`, '--action=delete', `--creds=${credsFile}`]);
            if (courseid > 0) {
              const cp = php(t, [path.join(__dirname, 'moodle/cleanup-test-course.php'), `--moodle=${t.root}`, `--courseid=${courseid}`, `--title=${fullname || '[SINTÉTICO]'}`, `--minuserid=${minuserid}`, `--prefixes=r55gs_${courseid}_,r60stu_`]);
              row.cleanup = (() => { try { return JSON.parse(cp.stdout.trim().split('\n').pop()); } catch (_) { return { raw: cp.stdout.slice(-300) }; } })();
            }
            fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(results, null, 2));
          }
          assert(row.cleanup && row.cleanup.course_deleted && row.cleanup.test_users_left === 0, `limpieza: ${JSON.stringify(row.cleanup)}`);
        });
      }
    } finally {
      if (web && web.proc) web.proc.kill();
    }
  }
  if (startedVersions) spawnSync('/bin/bash', [path.join(ENV, 'moodle-versions/stop.sh')], { stdio: 'ignore' });
  console.log(`\n${failures ? '❌' : '✅'} r60-moodle-compat-matrix: ${passed} OK, ${failures} fallo(s) (salidas: ${OUT})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
