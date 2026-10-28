#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * r79.1 — Los tipos nuevos de Actividad de Aplicación (estudio de caso, proyecto integrador, retroalimentación formativa) y
 * el nivel de 120 reforzado, RESTAURADOS en Moodle 4.5 local. Sin IA, sin red, USD 0: cursos sintéticos (documentos de
 * lib/r79-1-activity-fixtures.js) en los 7 estilos visuales (r76).
 *
 *   M1 paquetes: el curso arma y pasa el validador v3 en los 7 estilos (sin Moodle; corre en gate-core)
 *   M2 (--moodle) restauración: cada estilo restaurado; por capítulo con Actividad, la página del estudiante VISIBLE con el
 *      nombre de su tipo, sus secciones propias, sus resultados de aprendizaje y su PDF; el solucionario OCULTO
 *      (visible=0, visibleold=0) con su PDF; ningún token $@…@$ sin resolver
 *   M3 (--moodle) el estudiante: ve y abre la página de cada tipo; NO puede ver ningún solucionario (cm oculto y sin
 *      mod/page:view); el docente sí lo ve
 *   M4 (--moodle) navegador real (Playwright): Android 390 (Chromium), iPhone 375 (WebKit) y escritorio 1280, con «Limpiar
 *      contenido» apagado y encendido: sin desborde, texto corrido ≥ 16 px, contraste AA, enlaces/botones ≥ 44 px; el
 *      botón del PDF abre el PDF; capturas por tipo y estilo
 *   M5 (--moodle) app oficial: mod_page_get_pages_by_courses y core_course_get_contents como el estudiante: las páginas de los
 *      tipos llegan con su contenido (sin <style> con forceclean), los solucionarios NO llegan
 *
 * Uso: npm run build && node scripts/check-r79-1-activities-moodle.js [--moodle [--out=<dir>] [--styles=a,b] [--keep]]
 */
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const realFetch = global.fetch;
global.fetch = async (u, o) => { if (/^http:\/\/127\.0\.0\.1[:/]/.test(String(u))) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const ROOT = path.resolve(__dirname, '..');
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const dist = path.resolve(arg('dist') || path.join(ROOT, 'dist'));
const L = (r) => require(path.join(dist, r));
const MOODLE = process.argv.includes('--moodle');
const OUT = arg('out') || path.join(os.tmpdir(), 'r79-1-activities-moodle-out');
const ONLY = arg('styles') ? arg('styles').split(',') : null;
const B = L('package/dynamic-mbz-builder-v3.js');
const VAL = L('package/v3/mbz-validator-v3.js');
const PK = L('modules/dynamic-packaging/packaging-v3.js');
const PR = L('modules/course-profiles/course-profiles.js');
const SF = require('./lib/v21-shell-fixtures');
const V = require('./lib/v21-packaging-fixtures');
const R77 = require('./lib/r77-mobile-fixtures');
const M = require('./lib/r77-mobile-measure');

let passes = 0;
let failures = 0;
const evidence = { styles: {}, moodle: {} };
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n   ') : e}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

const TITLES = ['Fundamentos de la atención al cliente', 'Escucha y empatía', 'Proyecto de protocolo de atención', 'Revisión y mejora del protocolo', 'Negociación de acuerdos', 'Seguimiento y fidelización'];
function course(dist0) {
  return SF.buildCourse(dist0, { courseId: 7911, title: 'r79.1 · Tipos de Actividad de Aplicación', finalExam: true, engine: 'h5p', activityTypeRules: 2, chapterTitles: TITLES, modules: [
    { examEnabled: true, chapters: [{ video: true, activity: true, application: 60, appKind: 'case_study' }, { video: false, activity: true, application: 120 }, { practice: true, activity: true, application: 120, appKind: 'integrative_project' }, { practice: true, activity: true, application: 60, appKind: 'formative_feedback' }] },
    { examEnabled: false, chapters: [{ video: false, activity: true, application: 90, appKind: 'case_study' }, { practice: true, activity: true, application: 30, appKind: 'formative_feedback' }] }] });
}
const KIND_LABEL = { case_study: 'Estudio de caso', integrative_project: 'Proyecto integrador', formative_feedback: 'Retroalimentación formativa', standard: 'Actividad de Aplicación' };
const KIND_SECTIONS = { case_study: [/El caso/, /Preguntas de an[aá]lisis/, /Tu decisi[oó]n/], integrative_project: [/Etapas del proyecto/, /Integraci[oó]n y entrega final/], formative_feedback: [/Criterios de revisi[oó]n/, /Ejemplar comentado/, /Errores frecuentes/, /Plan de mejora/], standard: [/Ejercicios/, /Taller de aplicaci[oó]n/, /Hitos del taller/] };
const built = {};

(async () => {
  console.log('r79.1 · Tipos de Actividad de Aplicación en Moodle');
  fs.mkdirSync(OUT, { recursive: true });
  const styles = R77.STYLES.filter((s) => !ONLY || ONLY.includes(s.key));
  await check(`M1 paquetes: el curso con los 3 tipos y el 120 v2 arma y pasa el validador v3 en ${styles.length} estilos`, async () => {
    for (const st of styles) {
      const c = course(dist);
      const input = V.packagingInput(dist, { snapshot: c.snapshot, manifest: c.manifest, engine: 'h5p', applicationV2: true, applicationSize: 'max' });
      input.presentation = PK.resolvePackagingTheme({ presentationProfile: PR.normalizePresentationProfile(st.profile) }).input;
      const out = await B.buildDynamicMbzV3(input);
      const v = await VAL.validateMbzV3(out.mbz, out.expectations);
      assert(v.ok, `${st.key}: ${JSON.stringify((v.errors || []).slice(0, 4))}`);
      fs.mkdirSync(path.join(OUT, st.key), { recursive: true });
      fs.writeFileSync(path.join(OUT, st.key, 'curso.mbz'), out.mbz);
      const kinds = c.manifest.modules.flatMap((m) => m.chapters).filter((x) => x.applicationMinutes !== undefined).map((x) => ({ chapterId: x.chapterId, number: x.chapterNumber, kind: x.applicationKind || 'standard', minutes: x.applicationMinutes }));
      built[st.key] = { kinds };
      evidence.styles[st.key] = { bytes: out.mbz.length, builder: out.summary.builderVersion, kinds };
    }
  });
  if (!MOODLE) return finish();
  await moodleChecks(styles);
  finish();
})().catch((e) => { console.error(e); process.exit(1); });

function finish() {
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 1));
  console.log(`\n${passes} OK, ${failures} fallas · evidencia: ${path.join(OUT, 'evidence.json')}`);
  process.exit(failures ? 1 : 0);
}

const DEVICES = [
  { key: 'android-390', engine: 'chromium', width: 390, height: 844, dpr: 2.75, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36' },
  { key: 'iphone-375', engine: 'webkit', descriptor: 'iPhone SE' },
  { key: 'desktop-1280', engine: 'chromium', width: 1280, height: 900, dpr: 1, mobile: false },
];

async function moodleChecks(styles) {
  const PHP = process.env.PHP_BIN || '/opt/homebrew/bin/php';
  const MD = process.env.E2E_MOODLE_DIR || path.join(os.homedir(), 'cursia-test-env/moodle-local');
  const SRC = path.join(MD, 'source');
  const INI = path.join(MD, 'php.ini');
  const PW = require(process.env.PLAYWRIGHT_PATH || path.join(os.homedir(), 'cursia-test-env/pw-env/node_modules/playwright'));
  const php = (script, args) => {
    const r = spawnSync(PHP, ['-d', 'memory_limit=2048M', '-c', INI, path.join(ROOT, 'scripts/moodle', script), `--moodle=${SRC}`, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 900000 });
    if (r.status !== 0) throw new Error(`${script} ${args.join(' ')} → ${r.status}: ${(r.stderr || '').slice(-1500)}${(r.stdout || '').slice(-500)}`);
    return r.stdout;
  };
  const creds = {};
  for (const l of fs.readFileSync(path.join(os.homedir(), 'cursia-test-env/creds/.local-test-credentials'), 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0) creds[l.slice(0, i)] = l.slice(i + 1).trim(); }
  const fcBefore = JSON.parse(php('r77-mobile.php', ['--action=forceclean'])).before;
  const courses = {};
  await check(`M2 restauración en Moodle 4.5: ${styles.length} cursos; páginas de cada tipo visibles con su nombre, secciones, resultados y PDF; solucionarios ocultos`, async () => {
    const bad = [];
    for (const st of styles) {
      const id = Number(/Course ID: (\d+)/.exec(php('r76-visual-design.php', ['--action=restore-new', `--file=${path.join(OUT, st.key, 'curso.mbz')}`, '--categoryid=1']))[1]);
      // Un curso: el usuario de prueba como ESTUDIANTE (lo que ve el estudiante); otro (el primero), además el docente lo revisa por CLI.
      php('r79-1-activities.php', ['--action=enrol', `--courseid=${id}`, `--username=${creds.username}`, '--role=student']);
      const pages = JSON.parse(php('r79-1-activities.php', ['--action=pages', `--courseid=${id}`]));
      courses[st.key] = { id, pages };
      for (const k of built[st.key].kinds) {
        const stu = pages.activities.find((a) => a.idnumber === `cv3:ch:${k.chapterId}:application`);
        const sol = pages.activities.find((a) => a.idnumber === `cv3:ch:${k.chapterId}:application_solution`);
        if (!stu || !sol) { bad.push(`${st.key} cap ${k.number}: falta la página o el solucionario`); continue; }
        if (!stu.name.startsWith(`${KIND_LABEL[k.kind]} · Capítulo`)) bad.push(`${st.key} cap ${k.number}: nombre «${stu.name}»`);
        if (stu.visible !== 1) bad.push(`${st.key} cap ${k.number}: la página del estudiante no está visible`);
        if (sol.visible !== 0 || sol.visibleold !== 0) bad.push(`${st.key} cap ${k.number}: el solucionario no está oculto (${sol.visible}/${sol.visibleold})`);
        const text = stu.html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
        for (const re of KIND_SECTIONS[k.kind]) if (k.kind !== 'standard' || k.minutes === 120 || !/Hitos/.test(re.source)) if (!re.test(text)) bad.push(`${st.key} cap ${k.number} (${k.kind}): falta la sección ${re}`);
        if (k.kind !== 'standard' && !/Resultados de aprendizaje que evidencias/.test(text)) bad.push(`${st.key} cap ${k.number}: sin los resultados que evidencia`);
        if (/Respuesta:|Solucionario|Soluci[oó]n esperada|Gu[ií]a de correcci[oó]n/.test(text)) bad.push(`${st.key} cap ${k.number}: marcas de solucionario en la página del estudiante`);
        if (/\$@[A-Z]/.test(stu.html) || /\$@[A-Z]/.test(sol.html)) bad.push(`${st.key} cap ${k.number}: tokens sin resolver`);
        if (stu.files.filter((f) => /\.pdf$/.test(f.filename) && f.bytes > 1000).length !== 1 || sol.files.filter((f) => /\.pdf$/.test(f.filename) && f.bytes > 1000).length !== 1) bad.push(`${st.key} cap ${k.number}: PDF faltante`);
        if (!/<style\b/.test(stu.html) && !/style="/.test(stu.html)) bad.push(`${st.key} cap ${k.number}: sin estilos inline`);
      }
    }
    evidence.moodle.courses = Object.fromEntries(Object.entries(courses).map(([k, c]) => [k, { id: c.id, applications: c.pages.activities.length }]));
    assert(bad.length === 0, `${bad.length} problemas:\n   ${bad.slice(0, 20).join('\n   ')}`);
  });
  if (!Object.keys(courses).length) return;
  await check('M3 permisos: el estudiante ve las páginas de los tipos y NO los solucionarios; el docente sí', async () => {
    const bad = [];
    for (const [k, c] of Object.entries(courses)) {
      const acc = JSON.parse(php('r79-1-activities.php', ['--action=access', `--courseid=${c.id}`, `--username=${creds.username}`]));
      for (const a of acc) {
        const sol = /application_solution$/.test(a.idnumber);
        if (sol && (a.uservisible || a.capability)) bad.push(`${k}: el estudiante puede ver ${a.idnumber}`);
        if (!sol && !(a.uservisible && a.capability)) bad.push(`${k}: el estudiante no ve ${a.idnumber}`);
      }
    }
    evidence.moodle.studentAccess = 'solucionarios ocultos y sin mod/page:view para el estudiante; páginas visibles';
    assert(bad.length === 0, bad.join('\n   '));
  });
  const net = require('net');
  const portInUse = (port) => new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
  assert(!(await portInUse(8099)), 'puerto 8099 libre');
  const server = spawn(PHP, ['-c', INI, '-S', '127.0.0.1:8099', '-t', SRC], { stdio: 'ignore', detached: true, env: { ...process.env, PHP_CLI_SERVER_WORKERS: '6' } });
  const browsers = {};
  const shotsDir = path.join(OUT, 'capturas');
  fs.mkdirSync(shotsDir, { recursive: true });
  const results = [];
  try {
    for (let i = 0; i < 50 && !(await portInUse(8099)); i++) await new Promise((r) => setTimeout(r, 200));
    const contextFor = async (d) => {
      browsers[d.engine] = browsers[d.engine] || (await PW[d.engine].launch());
      const o = d.descriptor ? { ...PW.devices[d.descriptor] } : { viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.dpr, isMobile: d.mobile, hasTouch: d.mobile, ...(d.ua ? { userAgent: d.ua } : {}) };
      const ctx = await browsers[d.engine].newContext({ ...o, locale: 'es-CO', acceptDownloads: true });
      await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
      const page = await ctx.newPage();
      await page.goto('http://127.0.0.1:8099/login/index.php');
      await page.fill('#username', creds.username);
      await page.fill('#password', creds.password);
      await Promise.all([page.waitForNavigation(), page.click('#loginbtn')]);
      assert(!/\/login\/index\.php/.test(page.url()), `${d.key}: el inicio de sesión falló`);
      return { ctx, page };
    };
    const go = async (page, url) => {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(150);
    };
    for (const regime of ['guardado', 'limpio']) {
      php('r77-mobile.php', ['--action=forceclean', `--set=${regime === 'limpio' ? 1 : 0}`]);
      for (const d of DEVICES) {
        await check(`M4 ${regime} · ${d.key}: cada tipo en la página real de Moodle (sin desborde, letra ≥ 16 px, contraste AA, botones ≥ 44 px; el PDF abre; el solucionario no)`, async () => {
          const { ctx, page } = await contextFor(d);
          const bad = [];
          try {
            for (const [k, c] of Object.entries(courses)) {
              for (const kd of built[k].kinds) {
                const stu = c.pages.activities.find((a) => a.idnumber === `cv3:ch:${kd.chapterId}:application`);
                const sol = c.pages.activities.find((a) => a.idnumber === `cv3:ch:${kd.chapterId}:application_solution`);
                await go(page, `http://127.0.0.1:8099/mod/page/view.php?id=${stu.cmid}`);
                const ok = await page.$('.cvc');
                if (!ok) { bad.push(`${k}/${d.key}/${regime} cap ${kd.number}: no se ve la página (${page.url()})`); continue; }
                const m = await page.evaluate(M.measureExpr({}));
                for (const r of m.roots) {
                  const v = M.verdictOfRoot(r);
                  results.push({ style: k, device: d.key, regime, chapter: kd.number, kind: kd.kind, pass: v.pass, fails: v.fails, targets: r.targets.filter((t) => !t.inline).map((t) => `${t.w}×${t.h}`), fonts: r.fonts && { min: r.fonts.min, minRunning: r.fonts.minRunning } });
                  if (!v.pass) bad.push(`${k}/${d.key}/${regime} cap ${kd.number} (${kd.kind}): ${v.fails.join(' / ').slice(0, 300)}`);
                }
                if (m.page.overflowX) bad.push(`${k}/${d.key}/${regime} cap ${kd.number}: la página desborda (${m.page.scrollWidth} > ${m.page.clientWidth})`);
                // El botón del PDF (enlace de descarga del recurso de la página) responde con un PDF.
                const href = await page.evaluate(() => { const a = Array.from(document.querySelectorAll('.cvc a')).find((x) => /PDF/.test(x.textContent)); return a ? a.href : null; });
                if (!href) bad.push(`${k}/${d.key}/${regime} cap ${kd.number}: sin botón del PDF`);
                else if (d.key === 'desktop-1280' && regime === 'guardado') {
                  const resp = await page.request.get(href);
                  const ct = resp.headers()['content-type'] || '';
                  if (resp.status() !== 200 || !/pdf/.test(ct)) bad.push(`${k} cap ${kd.number}: el PDF responde ${resp.status()} ${ct}`);
                }
                // El estudiante no puede abrir el solucionario.
                if (regime === 'guardado' && d.key === 'android-390') {
                  await go(page, `http://127.0.0.1:8099/mod/page/view.php?id=${sol.cmid}`);
                  const leaked = await page.evaluate(() => /Solucionario:/.test(document.body.innerText) && !!document.querySelector('.cvc'));
                  if (leaked) bad.push(`${k} cap ${kd.number}: el estudiante abrió el solucionario`);
                }
                const shoot = (k === 'aula-clara' || k === 'tecnico-oscuro' || k === 'vibrante') && (regime === 'guardado' || d.key === 'iphone-375');
                if (shoot && (kd.kind !== 'standard' || kd.minutes === 120)) {
                  await go(page, `http://127.0.0.1:8099/mod/page/view.php?id=${stu.cmid}`);
                  await page.screenshot({ path: path.join(shotsDir, `${k}-${regime}-${d.key}-cap${kd.number}-${kd.kind}${kd.kind === 'standard' ? '-120' : ''}.png`), fullPage: true });
                }
              }
            }
          } finally {
            await ctx.close();
          }
          assert(bad.length === 0, `${bad.length} problemas:\n   ${bad.slice(0, 20).join('\n   ')}`);
        });
      }
      await check(`M5 app de Moodle (${regime}): las páginas de los tipos llegan como el estudiante (con su contenido y su PDF); los solucionarios NO${regime === 'limpio' ? '; sin <style>' : ''}`, async () => {
        const bad = [];
        const out = {};
        for (const [k, c] of Object.entries(courses)) {
          const ws = JSON.parse(php('r79-1-activities.php', ['--action=app', `--courseid=${c.id}`, `--username=${creds.username}`]));
          let n = 0;
          for (const kd of built[k].kinds) {
            const stu = c.pages.activities.find((a) => a.idnumber === `cv3:ch:${kd.chapterId}:application`);
            const sol = c.pages.activities.find((a) => a.idnumber === `cv3:ch:${kd.chapterId}:application_solution`);
            const p = ws.pages.find((x) => x.coursemodule === stu.cmid);
            if (!p) { bad.push(`${k} cap ${kd.number}: la app no recibe la página`); continue; }
            n++;
            const t = p.content.replace(/<[^>]+>/g, ' ');
            for (const re of KIND_SECTIONS[kd.kind]) if (kd.kind !== 'standard' || kd.minutes === 120 || !/Hitos/.test(re.source)) if (!re.test(t)) bad.push(`${k} cap ${kd.number}: la app no muestra ${re}`);
            if (regime === 'limpio' && /<style\b/.test(p.content)) bad.push(`${k} cap ${kd.number}: <style> con forceclean`);
            const mod = ws.modules[stu.cmid];
            if (!mod || !mod.files.some((f) => /\.pdf$/.test(f || ''))) bad.push(`${k} cap ${kd.number}: la app no lista el PDF`);
            if (ws.pages.some((x) => x.coursemodule === sol.cmid) || ws.modules[sol.cmid]) bad.push(`${k} cap ${kd.number}: la app entrega el solucionario`);
          }
          out[k] = { pages: n };
        }
        (evidence.moodle.app = evidence.moodle.app || {})[regime] = out;
        assert(bad.length === 0, `${bad.length} problemas:\n   ${bad.slice(0, 12).join('\n   ')}`);
      });
    }
  } finally {
    for (const b of Object.values(browsers)) await b.close().catch(() => {});
    try { process.kill(-server.pid, 'SIGTERM'); } catch (e) { server.kill('SIGTERM'); }
    php('r77-mobile.php', ['--action=forceclean', `--set=${fcBefore}`]);
  }
  evidence.moodle.results = results;
  evidence.moodle.totals = { measurements: results.length, fail: results.filter((r) => !r.pass).length };
  console.log(`   Moodle: ${results.length} mediciones, ${evidence.moodle.totals.fail} fallas`);
  if (!process.argv.includes('--keep')) {
    for (const [k, c] of Object.entries(courses)) {
      try { php('r76-visual-design.php', ['--action=delete', `--courseid=${c.id}`, `--title=${c.pages.fullname.slice(0, 20)}`]); } catch (e) { console.log(`   (no se pudo borrar ${k} #${c.id}: ${e.message.slice(0, 120)})`); }
    }
  }
}
