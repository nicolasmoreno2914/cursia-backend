#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 / R8 — verificación end-to-end del VIDEO INTERACTIVO en un Moodle
// LOCAL desechable (sin Videogen, sin upload, sin LLM; YouTube solo se reproduce).
//
//  1. Construye con dist/ la actividad (IV YouTube IdwOipZAeqY, 468 s ⇒ 5
//     checkpoints) + intro inline, y un .mbz mínimo (scripts/lib/v21-mini-mbz.js).
//  2. Restaura el .mbz en un curso NUEVO (PHP CLI) y verifica: 0 errores/warnings
//     de restore, ajustes de nota/completion, el mismo .h5p en package + intro,
//     @@PLUGINFILE@@ reescrito en el iframe y el enlace de respaldo resuelto a
//     view.php?id=<cmid>.
//  3. Matricula al estudiante local de prueba y levanta el servidor PHP en
//     127.0.0.1:8099 SOLO durante la prueba de navegador (se detiene al final).
//  4. Chrome headless (CDP, user-data-dir propio, puerto libre): login, iframe
//     inline presente y cargado, reproductor YouTube inicializado, en cada
//     checkpoint busca el tiempo, responde (4/5 correctas ⇒ 80, o --scenario fail
//     2/5 ⇒ 40), pulsa "Comprobar", y al final "Enviar respuestas". Texto de la UI
//     del contenido en español (sin "Submit Answers" ni "Untitled").
//  5. DB: 1 intento, nota esperada, COMPLETE_PASS/COMPLETE_FAIL, resultados con
//     subContentId UUID (los 5 del paquete).
// 5b. HD-V21-22: en la primera respuesta incorrecta no hay "Reintentar" y "Ver
//     solución" no permite corregir; recargar = intento NUEVO limpio, 5/5 ⇒ 2
//     intentos en la DB y gradebook = 100; un 3er intento peor NO la baja (highest ≠ last).
//  6. 390 px: sin scroll horizontal y el enlace de respaldo visible. view.php: el
//     iframe inline queda oculto (un solo reproductor).
//
// Nunca borra datos del sitio: deja el curso restaurado y el intento.
// La contraseña del estudiante se lee del archivo de credenciales y NUNCA se imprime.
//
// Uso (después de `npm run build`):
//   node scripts/check-v21-video-moodle.js <moodleDir> <phpIni> --creds <file> [--shots <dir>] [--scenario pass|fail]
// PHP: env PHP_BIN (default /opt/homebrew/opt/php@8.3/bin/php). Chrome: env CHROME_BIN.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
}
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [moodleDirArg, phpIniArg] = positional;
const credsFile = opt('--creds');
const scenario = opt('--scenario', 'pass');
if (!moodleDirArg || !phpIniArg || !credsFile || !['pass', 'fail'].includes(scenario)) {
  console.error('uso: node scripts/check-v21-video-moodle.js <moodleDir> <phpIni> --creds <file> [--shots <dir>] [--scenario pass|fail]');
  process.exit(2);
}
const moodleDir = path.resolve(moodleDirArg);
const phpIni = path.resolve(phpIniArg);
const shotsDir = path.resolve(opt('--shots', fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r8-shots-'))));
fs.mkdirSync(shotsDir, { recursive: true });
const PHP = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';
const WWWROOT = 'http://127.0.0.1:8099';

let h;
try {
  h = require(path.resolve(__dirname, '..', 'dist/package/h5p/index.js'));
} catch (err) {
  console.error(`❌ No se pudo cargar dist/package/h5p (¿npm run build?): ${err.message}`);
  process.exit(1);
}
const { makeInteractionsDoc, BANK } = require('./lib/v21-video-fixture');
const { buildMiniVideoMbz } = require('./lib/v21-mini-mbz');
const { launchChrome, sleep } = require('./lib/v21-cdp');

let failures = 0;
let passes = 0;
function report(name, ok, detail) {
  if (ok) {
    passes++;
    console.log(`✅ ${name}`);
  } else {
    failures++;
    console.error(`❌ ${name}`);
    if (detail !== undefined) console.error(`   ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return ok;
}

function php(...cmdArgs) {
  const r = spawnSync(PHP, ['-c', phpIni, path.join(__dirname, 'moodle', 'v21-video-moodle.php'), moodleDir, ...cmdArgs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT_JSON '));
  if (!line) throw new Error(`PHP ${cmdArgs[0]} sin RESULT_JSON (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(-2000)}`);
  return { code: r.status, data: JSON.parse(line.slice('RESULT_JSON '.length)) };
}

function readCreds(file) {
  const m = {};
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const i = l.indexOf('=');
    if (i > 0 && /^[a-z]+$/.test(l.slice(0, i))) m[l.slice(0, i)] = l.slice(i + 1).trim();
  }
  if (!m.username || !m.password) throw new Error('el archivo de credenciales no tiene username/password');
  return m;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

// ── Fixture ────────────────────────────────────────────────────────────────
const ITEM_KEY = 'video:ch1';
const TITLE = 'Matriz de peligros y valoración de riesgos';
const YOUTUBE_ID = 'IdwOipZAeqY';
const DURATION = 468; // medido en R0
const MID = 4201;
const PLAN = h.planInteractionCheckpoints(DURATION);
const DOC = makeInteractionsDoc(PLAN, { videoItemKey: ITEM_KEY, durationSec: DURATION });
// pass: todas correctas salvo la 4 ⇒ 4/5 = 80. fail: correctas solo 1 y 3 ⇒ 2/5 = 40.
const CORRECT_PLAN = scenario === 'pass' ? [true, true, true, false, true] : [true, false, true, false, false];
const EXPECT_RAW = CORRECT_PLAN.filter(Boolean).length;
const EXPECT_GRADE = (EXPECT_RAW / PLAN.length) * 100;
const EXPECT_COMPLETION = EXPECT_GRADE >= 70 ? 'COMPLETE_PASS' : 'COMPLETE_FAIL';

let server = null;
let browser = null;
function cleanup() {
  if (browser) {
    try { browser.close(); } catch (e) {}
    browser = null;
  }
  if (server) {
    try { server.kill('SIGTERM'); } catch (e) {}
    server = null;
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// Accesos al iframe inline → iframe h5p-iframe (mismo origen) → instancia IV.
const FRAME = `(()=>{const f=document.querySelector('.cursia-iv-inline iframe');if(!f||!f.contentDocument)return null;const i=f.contentDocument.querySelector('iframe.h5p-iframe');return i&&i.contentWindow&&i.contentWindow.H5P?i.contentWindow:null;})()`;
const iv = (body) => `(()=>{const w=${FRAME};if(!w)throw new Error('sin frame H5P');const iv=w.H5P.instances[0];const d=w.document;${body}})()`;
// Todos los textos visibles + aria-label/title del contenido H5P (para el control de idioma).
const COLLECT_TEXT = iv(`const a=[];d.querySelectorAll('[aria-label],[title],[placeholder]').forEach(e=>{['aria-label','title','placeholder'].forEach(k=>{const v=e.getAttribute(k);if(v)a.push(v)})});return {visible:d.body.innerText,attrs:a.join('\\n')};`);

async function main() {
  console.log(`— escenario ${scenario}: ${EXPECT_RAW}/${PLAN.length} ⇒ ${EXPECT_GRADE} (${EXPECT_COMPLETION}); capturas en ${shotsDir}`);

  // ── 1. Build ──
  const built = await h.buildVideoActivity({ itemKey: ITEM_KEY, title: TITLE, youtubeId: YOUTUBE_ID, durationSec: DURATION, interactionsDoc: DOC });
  report(`build: ${built.interactionCount} interacciones en ${PLAN.map((c) => c.atSec).join(', ')} s, maxScore ${built.maxScore}`, built.interactionCount === 5 && built.maxScore === 5);
  const packageFilename = h.videoPackageFilename(ITEM_KEY);
  const introHtml = h.videoInlineIntroHtml({ packageFilename, title: TITLE, activityMid: MID, youtubeId: YOUTUBE_ID });
  const mbz = await buildMiniVideoMbz({
    courseTitle: `Cursia V2.1 R8 video (${scenario})`,
    activityName: `🎬 Video interactivo — ${TITLE}`,
    packageFilename,
    h5p: built.h5p,
    introHtml,
    mid: MID,
  });
  const mbzPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r8-mbz-')), 'cursia-v21-r8-video.mbz');
  fs.writeFileSync(mbzPath, mbz);

  // ── 2. Restore ──
  const rs = php('restore', mbzPath);
  const R = rs.data;
  if (!report('restore: curso nuevo creado', rs.code === 0 && R.courseid > 0, R)) return;
  console.log(`   curso ${R.courseid}, cmid ${R.cmid}, contexto ${R.contextid}`);
  report('restore: 0 errores y 0 warnings de precheck', R.precheck.errors.length === 0 && R.precheck.warnings.length === 0, R.precheck);
  report('restore: 0 warnings/errores en el log de restore', R.logWarnings.length === 0, R.logWarnings);
  report('restore: 1 h5pactivity en la sección 1', R.h5pactivityCount === 1 && R.sectionnum === 1, { n: R.h5pactivityCount, s: R.sectionnum });
  report('restore: grade 100, gradepass 70 (grade item)', R.h5pactivity.grade === 100 && R.gradeItem && R.gradeItem.grademax === 100 && R.gradeItem.gradepass === 70, { a: R.h5pactivity, gi: R.gradeItem });
  report('restore: completion=2, completionpassgrade=1, gradeitemnumber=0, showdescription=1', R.cm.completion === 2 && R.cm.completionpassgrade === 1 && R.cm.completiongradeitemnumber === 0 && R.cm.showdescription === 1, R.cm);
  report('restore: tracking ON, nota "más alta", introformat HTML', R.h5pactivity.enabletracking === 1 && R.h5pactivity.grademethod === 1 && R.h5pactivity.introformat === 1, R.h5pactivity);
  const pkg = R.files.filter((f) => f.filearea === 'package');
  const intr = R.files.filter((f) => f.filearea === 'intro');
  report(
    'restore: el mismo .h5p (mismo hash) en package e intro',
    pkg.length === 1 && intr.length === 1 && pkg[0].filename === packageFilename && intr[0].filename === packageFilename &&
      pkg[0].contenthash === built.sha1 && intr[0].contenthash === built.sha1,
    R.files,
  );
  report('restore: intro guardado con @@PLUGINFILE@@ (Moodle lo reescribe al mostrar)', R.introRaw.includes(`data-cursia-src="@@PLUGINFILE@@/../../../../h5p/embed.php?url=@@PLUGINFILE@@/${packageFilename}&amp;component=mod_h5pactivity"`));
  const viewUrl = `${R.wwwroot}/mod/h5pactivity/view.php?id=${R.cmid}`;
  report('restore: enlace de respaldo resuelto a view.php?id=<cmid> real', R.introRaw.includes(`href="${viewUrl}"`) && !R.introRaw.includes('$@'), viewUrl);
  const pfBase = `${R.wwwroot}/pluginfile.php/${R.contextid}/mod_h5pactivity/intro`;
  const pf = encodeURIComponent(`${pfBase}/${packageFilename}`);
  report(
    'restore: data-cursia-src del intro formateado = <pluginfile intro>/../../../../h5p/embed.php?url=<pluginfile intro>/<file>',
    R.introFormatted.includes(`data-cursia-src="${pfBase}/../../../../h5p/embed.php?url=${pf}&amp;component=mod_h5pactivity"`) && !R.introFormatted.includes('@@PLUGINFILE@@'),
    R.introFormatted.slice(0, 700),
  );
  report('restore: el script inline sobrevive intacto a format_text (forceclean=0)', R.introFormatted.includes(`<script>${h.CURSIA_IV_INLINE_SCRIPT}</script>`));
  const FC = R.introFormattedForceclean;
  report(
    'forceclean=1 (format_text real, en memoria): sin iframe/script; bloque de respaldo, ambos enlaces, nomediaplugin y hex intactos',
    !/<iframe|<script|<style/i.test(FC) && FC.includes(`href="${viewUrl}"`) && /<a class="nomediaplugin" href="https:\/\/www\.youtube\.com\/watch\?v=IdwOipZAeqY"/.test(FC) &&
      FC.includes('Video interactivo calificable') && /background-color:\s*#F4F6FA/i.test(FC) && /border:\s*1px solid #1F5FBF/i.test(FC) && !/border-left/i.test(FC),
    FC.slice(0, 900),
  );
  report('forceclean: la configuración del sitio sigue en 0', String(R.forcecleanSetting) === '0' || R.forcecleanSetting === false || R.forcecleanSetting === '', R.forcecleanSetting);
  report('restore: YouTube con class="nomediaplugin" (sin segundo reproductor del filtro)', /<a class="nomediaplugin" href="https:\/\/www\.youtube\.com\/watch\?v=IdwOipZAeqY"/.test(R.introFormatted));

  // ── 3. Matrícula + servidor ──
  const creds = readCreds(credsFile);
  const en = php('enrol', String(R.courseid), creds.username);
  report(`matrícula de ${creds.username} como estudiante`, en.code === 0 && en.data.enrolled === true, en.data);

  if (await portInUse(8099)) {
    report('puerto 8099 libre para el servidor PHP desechable', false, 'ya hay algo escuchando en 127.0.0.1:8099');
    return;
  }
  const logPath = path.join(os.tmpdir(), `cursia-r8-php-${process.pid}.log`);
  const logFd = fs.openSync(logPath, 'w');
  server = spawn(PHP, ['-c', phpIni, '-S', '127.0.0.1:8099', '-t', moodleDir], { stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await sleep(200);
    up = await portInUse(8099);
  }
  if (!report('servidor PHP desechable en 127.0.0.1:8099', up)) return;

  // ── 4. Navegador ──
  browser = await launchChrome();
  const b = browser;
  await b.setViewport(1280, 900);
  await b.navigate(`${WWWROOT}/login/index.php`);
  await b.evaluate(`(()=>{document.querySelector('#username').value=${JSON.stringify(creds.username)};document.querySelector('#password').value=${JSON.stringify(creds.password)};document.querySelector('#login').submit();return 1})()`);
  await sleep(2500);
  const loggedIn = await b.evaluate(`!location.pathname.startsWith('/login') && !!document.querySelector('.usermenu, #user-menu-toggle')`);
  if (!report('login del estudiante local de prueba', loggedIn)) return;

  await b.navigate(`${WWWROOT}/course/view.php?id=${R.courseid}`);
  const iframeInfo = await b
    .waitFor(`(()=>{const f=document.querySelector('.cursia-iv-inline iframe');return f&&f.src?JSON.stringify({src:f.src,h:f.offsetHeight,w:f.offsetWidth,lazy:f.getAttribute('loading'),ns:!!window.CursiaIV,resizer:!!window.h5pResizerInitialized}):null})()`, { timeoutMs: 15000, what: 'iframe inline con src' })
    .then((v) => JSON.parse(v), (e) => ({ error: e.message }));
  let resolved = null;
  try {
    const u = new URL(iframeInfo.src);
    resolved = { path: u.origin + u.pathname, url: u.searchParams.get('url'), component: u.searchParams.get('component') };
  } catch (e) {}
  report('curso: iframe inline presente, visible y con carga diferida (data-cursia-src → src, loading=lazy, CursiaIV + resizer inline)', !!iframeInfo.src && iframeInfo.w > 300 && iframeInfo.lazy === 'lazy' && iframeInfo.ns && iframeInfo.resizer, iframeInfo);
  report(
    'curso: el navegador resuelve el embed a <wwwroot>/h5p/embed.php (dot-segments desde pluginfile)',
    !!resolved && resolved.path === `${WWWROOT}/h5p/embed.php` && resolved.url === `${WWWROOT}/pluginfile.php/${R.contextid}/mod_h5pactivity/intro/${packageFilename}` && resolved.component === 'mod_h5pactivity',
    resolved,
  );
  await b.waitFor(iv(`return iv.libraryInfo.versionedName`), { timeoutMs: 45000, what: 'instancia H5P en el iframe' }).then(
    (v) => report(`curso: el iframe carga ${v}`, v === 'H5P.InteractiveVideo 1.27', v),
    (e) => report('curso: el iframe carga H5P.InteractiveVideo', false, e.message),
  );
  const yt = await b
    .waitFor(iv(`const v=iv.video;const dur=v&&v.getDuration&&v.getDuration();const yt=!!d.querySelector('iframe[src*="youtube"]');return dur>0&&yt?JSON.stringify({handler:v.getHandlerName&&v.getHandlerName(),dur}):false;`), { timeoutMs: 60000, what: 'reproductor YouTube' })
    .then((v) => JSON.parse(v), (e) => ({ error: e.message }));
  report('curso: el reproductor YouTube se inicializa (handler YouTube, duración real ≈ 468 s)', yt.handler === 'YouTube' && Math.abs(yt.dur - DURATION) <= 2, yt);
  await b.screenshot(path.join(shotsDir, `r8-${scenario}-01-course-inline.png`));

  const texts = [await b.evaluate(COLLECT_TEXT)];
  for (let i = 0; i < PLAN.length; i++) {
    const cp = PLAN[i];
    const q = DOC.checkpoints[i];
    const bank = BANK[i];
    const wantCorrect = CORRECT_PLAN[i];
    await b.evaluate(iv(`iv.video.seek(${cp.atSec + 1});iv.video.play();return 1;`));
    let shown;
    try {
      shown = await b.waitFor(
        iv(`const els=[...d.querySelectorAll('.h5p-interaction')].filter(e=>e.offsetParent!==null&&e.innerText.includes(${JSON.stringify(q.question)}));return els.length?1:0;`),
        { timeoutMs: 30000, what: `interacción ${cp.index}` },
      );
    } catch (e) {
      report(`checkpoint ${cp.index} (${cp.atSec} s): la interacción aparece`, false, e.message);
      continue;
    }
    const paused = await b.waitFor(iv(`return iv.currentState===2?2:0;`), { timeoutMs: 5000, what: 'pausa' }).catch(() => b.evaluate(iv(`return iv.currentState;`)));
    report(`checkpoint ${cp.index} (${cp.atSec} s): la interacción aparece y pausa el video`, shown === 1 && paused === 2, { paused });
    let pickText;
    if (q.kind === 'multichoice') pickText = wantCorrect ? bank.correct : bank.wrong[0];
    else pickText = (wantCorrect ? bank.correct : !bank.correct) ? 'Verdadero' : 'Falso';
    const clicked = await b.evaluate(
      iv(`const box=[...d.querySelectorAll('.h5p-interaction')].find(e=>e.offsetParent!==null&&e.innerText.includes(${JSON.stringify(q.question)}));
        const opts=[...box.querySelectorAll('.h5p-answer, .h5p-true-false-answer')];
        const o=opts.find(e=>e.innerText.trim()===${JSON.stringify(pickText)});
        if(!o)return 'sin opción: '+opts.map(e=>e.innerText.trim()).join('|');
        o.click();
        const btn=[...box.querySelectorAll('button')].find(x=>x.innerText.trim()==='Comprobar');
        if(!btn)return 'sin botón Comprobar: '+[...box.querySelectorAll('button')].map(x=>x.innerText.trim()).join('|');
        btn.click();return 'ok';`),
    );
    if (!report(`checkpoint ${cp.index}: elige "${pickText}" (${wantCorrect ? 'correcta' : 'incorrecta'}) y pulsa "Comprobar"`, clicked === 'ok', clicked)) continue;
    const runningScore = CORRECT_PLAN.slice(0, i + 1).filter(Boolean).length;
    const scored = await b
      .waitFor(iv(`return iv.getUsersScore()===${runningScore}?1:0;`), { timeoutMs: 10000, what: 'puntaje acumulado' })
      .then(() => true, () => false);
    const fb = await b.evaluate(iv(`const box=[...d.querySelectorAll('.h5p-interaction')].find(e=>e.offsetParent!==null&&e.innerText.includes(${JSON.stringify(q.question)}));return box?box.innerText:'';`));
    const fbOk = wantCorrect ? fb.includes('¡Correcto') && fb.includes('Obtuviste 1 de 1 puntos') : fb.includes('No es correcto') && fb.includes('Obtuviste 0 de 1 puntos');
    report(`checkpoint ${cp.index}: puntaje acumulado ${runningScore} y feedback en español`, scored && fbOk, fb.replace(/\s+/g, ' ').slice(0, 240));
    if (i === 0) await b.screenshot(path.join(shotsDir, `r8-${scenario}-02-checkpoint1-answered.png`));
    // HD-V21-22: en la primera respuesta incorrecta → no hay "Reintentar"; "Ver solución" sí, y ver la
    // solución NO permite corregir (opciones bloqueadas) ni cambia el puntaje del intento.
    if (!wantCorrect && CORRECT_PLAN.indexOf(false) === i) {
      const box = `[...d.querySelectorAll('.h5p-interaction')].find(e=>e.offsetParent!==null&&e.innerText.includes(${JSON.stringify(q.question)}))`;
      const btns = await b.evaluate(iv(`const box=${box};return [...box.querySelectorAll('button, .h5p-joubelui-button')].filter(x=>x.offsetParent!==null).map(x=>(x.innerText.trim()||x.getAttribute('aria-label')||'')).filter(Boolean);`));
      report(`HD-V21-22 intento 1: tras responder mal no hay "Reintentar" y sí "Ver solución" (${btns.join(' | ')})`, !btns.some((t) => /^Reintentar|Reintentar la tarea/i.test(t)) && btns.some((t) => /^Ver (la )?solución/i.test(t)), btns);
      await b.evaluate(iv(`const box=${box};[...box.querySelectorAll('button, .h5p-joubelui-button')].find(x=>/^Ver (la )?solución/i.test((x.innerText.trim()||x.getAttribute('aria-label')||''))).click();return 1;`));
      await sleep(600);
      const after = await b.evaluate(iv(`const box=${box};const opts=[...box.querySelectorAll('.h5p-answer, .h5p-true-false-answer')];
        const o=opts.find(e=>!e.classList.contains('h5p-selected')&&!/selected/.test(e.getAttribute('aria-checked')||''));
        if(o)o.click();
        const btns=[...box.querySelectorAll('button, .h5p-joubelui-button')].filter(x=>x.offsetParent!==null).map(x=>(x.innerText.trim()||x.getAttribute('aria-label')||'')).filter(Boolean);
        return JSON.stringify({score:iv.getUsersScore(),btns,disabled:opts.every(e=>e.getAttribute('aria-disabled')==='true'||e.classList.contains('h5p-disabled')||e.hasAttribute('disabled')||(e.closest('[aria-disabled="true"]')!==null))});`)).then(JSON.parse);
      report('HD-V21-22 intento 1: ver la solución no permite corregir (sin Comprobar/Reintentar) y el puntaje no cambia',
        after.score === runningScore && after.disabled === true && !after.btns.some((t) => /^Comprobar|^Reintentar/i.test(t)), after);
      await b.screenshot(path.join(shotsDir, `r8-${scenario}-02b-solution-no-retry.png`));
    }
    texts.push(await b.evaluate(COLLECT_TEXT));
  }

  // Pantalla final de envío
  await b.evaluate(iv(`iv.video.seek(${DURATION - 3});iv.video.play();return 1;`));
  const submitBtn = await b
    .waitFor(iv(`const x=[...d.querySelectorAll('button, .h5p-joubelui-button')].find(e=>e.offsetParent!==null&&e.innerText.trim()==='Enviar respuestas');return x?1:0;`), { timeoutMs: 40000, what: 'botón Enviar respuestas' })
    .then(() => true, () => false);
  report('final: aparece la pantalla de envío con el botón "Enviar respuestas"', submitBtn);
  await b.screenshot(path.join(shotsDir, `r8-${scenario}-03-endscreen.png`));
  texts.push(await b.evaluate(COLLECT_TEXT));
  if (submitBtn) {
    await b.evaluate(iv(`[...d.querySelectorAll('button, .h5p-joubelui-button')].find(e=>e.offsetParent!==null&&e.innerText.trim()==='Enviar respuestas').click();return 1;`));
    const sent = await b.waitFor(iv(`return d.body.innerText.includes('¡Tus respuestas fueron enviadas!')?1:0;`), { timeoutMs: 15000, what: 'confirmación de envío' }).then(() => true, () => false);
    report('final: "¡Tus respuestas fueron enviadas!"', sent);
    await sleep(2500); // deja terminar el POST xAPI
    await b.screenshot(path.join(shotsDir, `r8-${scenario}-04-submitted.png`));
    texts.push(await b.evaluate(COLLECT_TEXT));
  }

  const visible = texts.map((t) => t.visible).join('\n');
  const attrs = texts.map((t) => t.attrs).join('\n');
  report('idioma: sin "Submit Answers" ni "Untitled" (texto visible y atributos a11y)', !/Submit Answers|Untitled/.test(visible + '\n' + attrs));
  const ENGLISH = ['Check', 'Retry', 'Show solution', 'Submit', 'Continue', 'Correct!', 'Incorrect', 'Play', 'Pause', 'Mute', 'Unmute', 'Bookmarks', 'Quality', 'Playback Rate', 'Rewind 10 Seconds', 'Summary', 'Interaction', 'You got', 'You have', 'Your answers', 'Answered questions', 'Score'];
  const reEn = (w) => new RegExp(`(^|\\n)\\s*${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm');
  const englishVisible = ENGLISH.filter((w) => reEn(w).test(visible));
  report('idioma: ningún texto VISIBLE del reproductor/preguntas/pantalla final en inglés', englishVisible.length === 0, englishVisible);
  // Bug upstream de IV 1.27: la fila del resumen final usa l10n.endCardTableRowSummary (clave que no
  // existe en semantics) ⇒ su aria-label siempre sale con el default inglés "You got @score out of…".
  const UPSTREAM_IV_BUG = /^You got \d+ out of \d+ points for the .* that appeared after \d+ minutes and \d+ seconds\.$/;
  const attrLines = attrs.split('\n');
  const upstream = attrLines.filter((l) => UPSTREAM_IV_BUG.test(l.trim()));
  const englishAttrs = ENGLISH.filter((w) => attrLines.filter((l) => !UPSTREAM_IV_BUG.test(l.trim())).some((l) => reEn(w).test(l)));
  report('idioma: atributos a11y del contenido en español (salvo el bug upstream conocido de IV 1.27)', englishAttrs.length === 0, englishAttrs);
  if (upstream.length) console.log(`   (info) bug upstream IV 1.27: ${upstream.length} aria-label(s) del resumen final en inglés, p. ej. "${upstream[0].trim().slice(0, 70)}…"`);
  const coreEnglish = ['Close', 'Fullscreen', 'Reuse', 'Embed', 'Rights of use'].filter((w) => new RegExp(`(^|\\n)${w}$`, 'm').test(visible + '\n' + attrs));
  if (coreEnglish.length) console.log(`   (info) textos del núcleo H5P en el idioma del usuario de Moodle (en): ${coreEnglish.join(', ')}`);

  // ── 5. DB ──
  const st = php('state', String(R.courseid), String(R.cmid), creds.username).data;
  report('DB: exactamente 1 intento', st.attempts.length === 1, st.attempts);
  const a0 = st.attempts[0] || {};
  report(`DB: intento con rawscore ${EXPECT_RAW}/${PLAN.length}`, a0.rawscore === EXPECT_RAW && a0.maxscore === PLAN.length, a0);
  report(`DB: nota ${EXPECT_GRADE} en el gradebook (grademax 100, gradepass 70)`, st.grade === EXPECT_GRADE && st.grademax === 100 && st.gradepass === 70, st);
  report(`DB: completion ${EXPECT_COMPLETION}`, st.completion === EXPECT_COMPLETION, st.completion);
  const rows = (st.results[0] && st.results[0].rows) || [];
  const childRows = rows.filter((r) => r.subcontent);
  const subs = childRows.map((r) => r.subcontent).sort();
  report(
    'DB: resultados por interacción con subContentId UUID = los 5 del paquete',
    childRows.length === 5 && childRows.every((r) => h.isUuid(r.subcontent)) && JSON.stringify(subs) === JSON.stringify([...built.subContentIds].sort()),
    rows,
  );
  const childCorrect = built.subContentIds.map((id) => {
    const r = childRows.find((x) => x.subcontent === id);
    return r ? r.rawscore === r.maxscore && r.maxscore > 0 : null;
  });
  report('DB: acierto por interacción coincide con lo respondido', JSON.stringify(childCorrect) === JSON.stringify(CORRECT_PLAN), childCorrect);

  // ── 5b. HD-V21-22: mejorar la nota = NUEVO intento (recargar); nota = la más alta ──
  await b.navigate(`${WWWROOT}/course/view.php?id=${R.courseid}`);
  await b.waitFor(iv(`return iv.video&&iv.video.getDuration&&iv.video.getDuration()>0?1:0;`), { timeoutMs: 60000, what: 'IV recargado' });
  const fresh = await b.evaluate(iv(`return iv.getUsersScore();`));
  report('HD-V21-22 intento 2: al recargar la actividad empieza limpia (puntaje 0, no hereda el intento enviado)', fresh === 0, fresh);
  const answerAll = async (correct, tag) => { for (let i = 0; i < PLAN.length; i++) {
    const cp = PLAN[i];
    const q = DOC.checkpoints[i];
    const bank = BANK[i];
    await b.evaluate(iv(`iv.video.seek(${cp.atSec + 1});iv.video.play();return 1;`));
    await b.waitFor(iv(`const els=[...d.querySelectorAll('.h5p-interaction')].filter(e=>e.offsetParent!==null&&e.innerText.includes(${JSON.stringify(q.question)}));return els.length?1:0;`), { timeoutMs: 30000, what: `${tag}: interacción ${cp.index}` }).catch(() => 0);
    const pick = q.kind === 'multichoice' ? (correct ? bank.correct : bank.wrong[0]) : (correct ? bank.correct : !bank.correct) ? 'Verdadero' : 'Falso';
    await b.evaluate(iv(`const box=[...d.querySelectorAll('.h5p-interaction')].find(e=>e.offsetParent!==null&&e.innerText.includes(${JSON.stringify(q.question)}));
      if(!box)return 0;const o=[...box.querySelectorAll('.h5p-answer, .h5p-true-false-answer')].find(e=>e.innerText.trim()===${JSON.stringify(pick)});if(o)o.click();
      const btn=[...box.querySelectorAll('button')].find(x=>x.innerText.trim()==='Comprobar');if(btn)btn.click();
      const c=[...box.querySelectorAll('button')].find(x=>x.innerText.trim()==='Continuar');if(c)setTimeout(()=>c.click(),300);return 1;`));
    await b.waitFor(iv(`return iv.getUsersScore()===${correct ? i + 1 : 0}?1:0;`), { timeoutMs: 10000, what: `${tag}: puntaje` }).catch(() => 0);
    await sleep(500);
  } };
  await answerAll(true, 'intento 2');
  const score2 = await b.evaluate(iv(`return iv.getUsersScore();`));
  report(`HD-V21-22 intento 2: todas correctas ⇒ ${PLAN.length}/${PLAN.length}`, score2 === PLAN.length, score2);
  await b.evaluate(iv(`iv.video.seek(${DURATION - 3});iv.video.play();return 1;`));
  const sub2 = await b
    .waitFor(iv(`const x=[...d.querySelectorAll('button, .h5p-joubelui-button')].find(e=>e.offsetParent!==null&&e.innerText.trim()==='Enviar respuestas');if(x){x.click();return 1}return 0;`), { timeoutMs: 40000, what: 'intento 2: Enviar respuestas' })
    .then(() => true, () => false);
  report('HD-V21-22 intento 2: envío', sub2);
  await sleep(3000);
  await b.screenshot(path.join(shotsDir, `r8-${scenario}-05-attempt2-submitted.png`));
  const st2 = php('state', String(R.courseid), String(R.cmid), creds.username).data;
  report('HD-V21-22 DB: 2 intentos registrados (el primero intacto)', st2.attempts.length === 2 && st2.attempts[0].rawscore === EXPECT_RAW && st2.attempts[1].rawscore === PLAN.length, st2.attempts);
  report('HD-V21-22 DB: gradebook = la nota MÁS ALTA (100) y completion COMPLETE_PASS', st2.grade === 100 && st2.completion === 'COMPLETE_PASS', { grade: st2.grade, completion: st2.completion });

  // Intento 3 PEOR que el anterior (todas incorrectas): si el gradebook siguiera "el último" bajaría;
  // con "la más alta" se queda en 100. Distingue highest de last.
  await b.navigate(`${WWWROOT}/course/view.php?id=${R.courseid}`);
  await b.waitFor(iv(`return iv.video&&iv.video.getDuration&&iv.video.getDuration()>0?1:0;`), { timeoutMs: 60000, what: 'IV recargado (intento 3)' });
  await answerAll(false, 'intento 3');
  await b.evaluate(iv(`iv.video.seek(${DURATION - 3});iv.video.play();return 1;`));
  const sub3 = await b
    .waitFor(iv(`const x=[...d.querySelectorAll('button, .h5p-joubelui-button')].find(e=>e.offsetParent!==null&&e.innerText.trim()==='Enviar respuestas');if(x){x.click();return 1}return 0;`), { timeoutMs: 40000, what: 'intento 3: Enviar respuestas' })
    .then(() => true, () => false);
  await sleep(3000);
  const st3 = php('state', String(R.courseid), String(R.cmid), creds.username).data;
  const last = st3.attempts[st3.attempts.length - 1] || {};
  report('HD-V21-22 intento 3 (peor): se registra como 3er intento con menos puntaje que el 2º',
    sub3 && st3.attempts.length === 3 && last.rawscore < PLAN.length, st3.attempts);
  report('HD-V21-22 DB: tras un intento PEOR el gradebook sigue en 100 (calificación = la más alta, no la última)', st3.grade === 100, { grade: st3.grade });

  // ── 6. view.php (un solo reproductor) y 390 px ──
  await b.navigate(`${WWWROOT}/mod/h5pactivity/view.php?id=${R.cmid}`);
  await sleep(2500);
  await sleep(3000);
  const view = await b.evaluate(`(()=>{const o=document.querySelector('.cursia-iv-open');const all=[...document.querySelectorAll('iframe')];const h5p=all.filter(x=>/h5p|embed\\.php/.test((x.src||'')+' '+x.className));const inst=h5p.map(x=>{try{const d=x.contentDocument;const i=d&&d.querySelector('iframe.h5p-iframe');const w=i?i.contentWindow:x.contentWindow;return w&&w.H5P?w.H5P.instances.length:0}catch(e){return -1}});return {bodyId:document.body.id,inlineInDom:!!document.querySelector('.cursia-iv-inline'),dataSrcFrames:document.querySelectorAll('iframe[data-cursia-src]').length,openHidden:!!o&&getComputedStyle(o).display==='none',h5pIframes:h5p.length,instances:inst,fallback:!!document.querySelector('.cursia-iv-fallback a.nomediaplugin')}})()`);
  report(
    'view.php: el bloque inline se ELIMINA sin cargarse (1 solo iframe H5P, 1 sola instancia IV), "Abrir…" oculto, bloque YouTube visible',
    view.bodyId === 'page-mod-h5pactivity-view' && !view.inlineInDom && view.dataSrcFrames === 0 && view.h5pIframes === 1 && view.instances.reduce((a, x) => a + x, 0) === 1 && view.openHidden && view.fallback,
    view,
  );
  await b.screenshot(path.join(shotsDir, `r8-${scenario}-05-view-php.png`));

  await b.setViewport(390, 844, true);
  await b.navigate(`${WWWROOT}/course/view.php?id=${R.courseid}`);
  await sleep(4000);
  const m = await b.evaluate(`(()=>{const a=document.querySelector('.cursia-iv-open a');const y=document.querySelector('.cursia-iv-fallback a.nomediaplugin');const r=a&&a.getBoundingClientRect();const f=document.querySelector('.cursia-iv-inline iframe');const fr=f&&f.getBoundingClientRect();const inner=f&&f.contentDocument&&f.contentDocument.querySelector('iframe.h5p-iframe');return {ifH:f?f.offsetHeight:0,contentH:inner?Math.round(inner.getBoundingClientRect().height):0,scrollW:document.documentElement.scrollWidth,innerW:innerWidth,link:r?{w:r.width,h:r.height,left:r.left,right:r.right}:null,linkVisible:!!a&&getComputedStyle(a).visibility!=='hidden'&&getComputedStyle(a.closest('p')).display!=='none'&&r.width>0,ytVisible:!!y&&y.getBoundingClientRect().width>0,iframe:fr?{left:fr.left,right:fr.right}:null}})()`);
  report('390 px: sin scroll horizontal', m.scrollW <= m.innerW, m);
  report('390 px: enlace de respaldo visible y dentro del viewport', m.linkVisible && m.ytVisible && m.link.left >= 0 && m.link.right <= m.innerW, m);
  report('390 px: el iframe inline no desborda el viewport', m.iframe && m.iframe.left >= 0 && m.iframe.right <= m.innerW, m.iframe);
  report('390 px: h5p-resizer ajusta la altura del iframe al contenido (sin hueco en blanco)', m.contentH > 100 && Math.abs(m.ifH - m.contentH) <= 40, { ifH: m.ifH, contentH: m.contentH });
  await b.evaluate(`(()=>{const e=document.querySelector('.cursia-iv');if(e)e.scrollIntoView();return 1})()`);
  await sleep(1500);
  await b.screenshot(path.join(shotsDir, `r8-${scenario}-06-mobile-390.png`));
  await b.evaluate(`(()=>{const e=document.querySelector('.cursia-iv-fallback');if(e)e.scrollIntoView();return 1})()`);
  await sleep(500);
  await b.screenshot(path.join(shotsDir, `r8-${scenario}-07-mobile-390-fallback.png`));

  const phpErrors = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => /PHP (Fatal|Parse) error/.test(l));
  report('servidor PHP: sin errores fatales durante la prueba', phpErrors.length === 0, phpErrors.slice(0, 5));
}

main()
  .catch((err) => report('ejecución sin excepciones', false, err.stack || err.message))
  .finally(() => {
    cleanup();
    console.log('');
    if (failures) {
      console.error(`❌ check-v21-video-moodle: ${failures} fallo(s), ${passes} ok.`);
      process.exitCode = 1;
    } else {
      console.log(`✅ check-v21-video-moodle: ${passes} ok.`);
    }
    setTimeout(() => process.exit(process.exitCode || 0), 2000).unref();
  });
