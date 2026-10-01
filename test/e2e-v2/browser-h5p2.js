/* eslint-disable */
// EV6 H5P v2 (H4) — QA de reproductor REAL del curso E5 (DYNAMIC_ACTIVITY_TYPE_RULES=2) restaurado
// por e2e-v3.js en el Moodle 4.5 local:
//   - Branching Scenario: camino pobre → 0 (no aprueba), aceptable → 70 COMPLETE_PASS, óptimo → 100
//     COMPLETE_PASS (método «la más alta», intentos ilimitados), con clics REALES del mouse (CDP).
//   - «Repaso» (Dialog Cards): INCOMPLETE antes de verlo → COMPLETE al verlo; sin nota ni intentos.
//   - Video interactivo v2: la pausa de reflexión DETIENE el video y se reanuda con el botón de
//     reproducir (clic real); una respuesta INCORRECTA ofrece «Volver a ver este tramo», que salta al
//     seekTo del plan.
//   - 390 px (emulación móvil): sin scroll horizontal (página y documento H5P) y solo español
//     (lint de textos por defecto en inglés, el mismo de browser-qa-v3.js).
//
// Sin red: la API de iframe de YouTube (https://www.youtube.com/iframe_api) se sirve con CDP
// Fetch.fulfillRequest desde un STUB local (reloj de reproducción falso, duración 468 s = fixture
// IdwOipZAeqY); Chrome además corre con la red restringida a loopback. Nunca hay proveedores reales.
//
// Servidor:
//   (por defecto, compuerta) php -S 127.0.0.1:8099 SOLO durante la prueba (como browser-qa-v3.js).
//   --alt-port <p> (desarrollo; nunca abre ni contacta 8099): php -S 127.0.0.1:<p> con
//     moodle-alt-port-router.php (finge SERVER_PORT 8099) + proxy HTTP local en <p>-1; Chrome usa
//     --proxy-server, así el Host sigue siendo el wwwroot 127.0.0.1:8099 del Moodle local.
//
// Uso: node browser-h5p2.js <results-v3.json> --moodle <dir> --creds <file> --shots <dir> [--repo <dir>] [--alt-port 8198]
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const resultsFile = args[0];
const MOODLE = opt('--moodle');
const CREDS = opt('--creds');
const SHOTS = opt('--shots');
const REPO = opt('--repo', path.resolve(__dirname, '..', '..'));
const ALT = opt('--alt-port') ? Number(opt('--alt-port')) : null;
// Desarrollo: --only bs,repaso,iv,390 (por defecto, todo). La compuerta corre siempre todo.
const ONLY = opt('--only') ? new Set(opt('--only').split(',')) : null;
const want = (k) => !ONLY || ONLY.has(k);
if (!resultsFile || !MOODLE || !CREDS || !SHOTS || (ALT !== null && !(ALT > 1024 && ALT !== 8099 && ALT - 1 !== 8099))) {
  console.error('uso: node browser-h5p2.js <results-v3.json> --moodle <dir> --creds <file> --shots <dir> [--repo <backend>] [--alt-port <p≠8099>]');
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const SRC = path.join(MOODLE, 'source');
const PHPINI = path.join(MOODLE, 'php.ini');
const PHP = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';
const WWW = 'http://127.0.0.1:8099'; // wwwroot del Moodle local (en --alt-port solo como Host vía proxy)
const PROXY_PORT = ALT ? ALT - 1 : null;
// Red de Chrome: SOLO loopback (la API de YouTube la sirve el stub vía CDP Fetch, antes de resolver).
process.env.CURSIA_CHROME_HOST_RESOLVER_RULES = 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost';
const { launchChrome, sleep } = require(path.join(REPO, 'scripts/lib/v21-cdp.js'));
const R = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
const OUTJSON = path.join(path.dirname(resultsFile), 'browser-h5p2.json');
const VIDEO_SEC = 468;

const out = { startedAt: new Date().toISOString(), mode: ALT ? `alt-port ${ALT} (proxy ${PROXY_PORT})` : 'php -S 8099', assertions: [], shots: [], metrics: {}, network: null };
let area = 'browser-h5p2';
function ok(cond, msg, detail) {
  out.assertions.push({ area, ok: !!cond, msg, ...(cond ? {} : { detail }) });
  console.log(`${cond ? '✅' : '❌'} [${area}] ${msg}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 1200) : ''}`);
  return !!cond;
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b });
const eq0 = (arr, msg) => ok(Array.isArray(arr) && arr.length === 0, msg, arr);
function vm(...a) {
  const r = spawnSync(PHP, ['-c', PHPINI, path.join(REPO, 'scripts/moodle/v21-video-moodle.php'), SRC, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: SRC });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT_JSON '));
  if (!line) throw new Error(`v21-video-moodle.php ${a[0]}: ${(r.stderr || r.stdout || '').slice(-800)}`);
  return JSON.parse(line.slice('RESULT_JSON '.length));
}
function readCreds(file) {
  const m = {};
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const i = l.indexOf('=');
    if (i > 0 && /^[a-z]+$/.test(l.slice(0, i))) m[l.slice(0, i)] = l.slice(i + 1).trim();
  }
  if (!m.username || !m.password) throw new Error('credenciales sin username/password');
  return m;
}
const portInUse = (port) => new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });

// Mismo lint que browser-qa-v3.js: textos por defecto en inglés que NO deben verse en los reproductores.
const ENGLISH = ['Check', 'Retry', 'Show solution', 'Submit', 'Submit Answers', 'Untitled', 'You got', 'Question', 'Finish', 'Next', 'Previous', 'Correct!', 'Incorrect', 'Your result', 'Reuse', 'Embed', 'Rights of use', 'Continue', 'Summary', 'True', 'False'];
const englishIn = (t) => ENGLISH.filter((w) => new RegExp(`(^|[^A-Za-zÁ-ú])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-zÁ-ú]|$)`).test(t));
// + los textos por defecto en inglés propios de Branching Scenario / Dialog Cards / IV avanzado.
const ENGLISH_V2 = ['Start the course', 'Restart the course', 'Proceed', 'Turn', 'Back', 'Replay the video', 'Card', 'Go back', 'Pause to reflect', 'Score'];
const englishV2In = (t) => [...englishIn(t), ...ENGLISH_V2.filter((w) => new RegExp(`(^|[^A-Za-zÁ-ú])${w}([^A-Za-zÁ-ú]|$)`).test(t))];

// ── Stub de la API de iframe de YouTube (sin red): YT.Player con reloj de reproducción falso ──
// Cubre exactamente lo que usa H5P.Video 1.6 (scripts/youtube.js). La verdad del reloj queda en
// window.__cursiaFakeYt (ventana del documento H5P) para las aserciones.
const FAKE_YT_API = `(function(){
  if (window.YT && window.YT.Player) return;
  var DUR = ${VIDEO_SEC};
  function P(id, o) {
    var self = this, el = typeof id === 'string' ? document.getElementById(id) : id;
    var f = document.createElement('iframe');
    f.setAttribute('data-cursia-fake-yt', (o && o.videoId) || ''); f.setAttribute('title', 'Video'); f.src = 'about:blank';
    if (el && el.parentNode) el.parentNode.replaceChild(f, el);
    if (typeof id === 'string') f.id = id;
    self._f = f; self._ev = (o && o.events) || {}; self._t = Math.max(0, (o && o.playerVars && o.playerVars.start) || 0);
    self._st = -1; self._rate = 1; self._vol = 100; self._mute = false; self._last = 0; self.videoId = o && o.videoId; self.log = [];
    (window.__cursiaFakeYt = window.__cursiaFakeYt || []).push(self);
    setTimeout(function(){ self._emit('onReady'); self._emit('onApiChange'); }, 30);
    self._timer = setInterval(function(){ self._now(); if (self._st === 1 && self._t >= DUR) { self._t = DUR; self._set(0); } }, 50);
  }
  P.prototype._now = function(){ if (this._st === 1) { var n = Date.now(); this._t = Math.min(DUR, this._t + (n - this._last) / 1000 * this._rate); this._last = n; } return this._t; };
  P.prototype._emit = function(n, data){ var fn = this._ev[n]; if (fn) { try { fn({ target: this, data: data }); } catch (e) { setTimeout(function(){ throw e; }); } } };
  P.prototype._set = function(s){ this._now(); if (this._st === s) return; this._st = s; if (s === 1) this._last = Date.now(); this.log.push([s, Math.round(this._t * 10) / 10]); this._emit('onStateChange', s); };
  P.prototype.playVideo = function(){ var s = this; if (s._st === 1 || s._st === 3) return; s._set(3); setTimeout(function(){ if (s._st === 3) s._set(1); }, 40); };
  P.prototype.pauseVideo = function(){ if (this._st === 1 || this._st === 3) this._set(2); };
  P.prototype.seekTo = function(t){ this._now(); this._t = Math.max(0, Math.min(DUR, +t || 0)); this._last = Date.now(); this.log.push(['seek', this._t]); };
  P.prototype.getCurrentTime = function(){ return this._now(); };
  P.prototype.getDuration = function(){ return DUR; };
  P.prototype.getPlayerState = function(){ return this._st; };
  P.prototype.getVideoLoadedFraction = function(){ return 1; };
  P.prototype.mute = function(){ this._mute = true; }; P.prototype.unMute = function(){ this._mute = false; }; P.prototype.isMuted = function(){ return this._mute; };
  P.prototype.setVolume = function(v){ this._vol = v; }; P.prototype.getVolume = function(){ return this._vol; };
  P.prototype.setPlaybackRate = function(r){ this._now(); this._rate = r; this._emit('onPlaybackRateChange', r); };
  P.prototype.getPlaybackRate = function(){ return this._rate; };
  P.prototype.getAvailablePlaybackRates = function(){ return [0.5, 1, 1.5, 2]; };
  P.prototype.setPlaybackQuality = function(){}; P.prototype.getPlaybackQuality = function(){ return 'medium'; };
  P.prototype.getAvailableQualityLevels = function(){ return []; };
  P.prototype.getIframe = function(){ return this._f; };
  P.prototype.setSize = function(){}; P.prototype.loadModule = function(){}; P.prototype.getOption = function(){ return undefined; }; P.prototype.setOption = function(){};
  P.prototype.destroy = function(){ clearInterval(this._timer); if (this._f && this._f.parentNode) this._f.parentNode.removeChild(this._f); };
  window.YT = { Player: P, PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 }, loaded: 1 };
  if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
})();`;

// ── Acceso al documento H5P (patrón de browser-qa-v3.js / prueba de diseño) ──
const FIND = `(()=>{function find(w){try{if(w.H5P&&w.H5P.instances&&w.H5P.instances.length)return w}catch(e){}for(let i=0;i<w.frames.length;i++){const r=find(w.frames[i]);if(r)return r}return null}return find(window)})()`;
const inH5p = (body) => `(()=>{const w=${FIND};if(!w)throw new Error('sin ventana H5P');const d=w.document;const inst=w.H5P.instances[0];const vis=(e)=>!!e&&e.getClientRects().length>0&&w.getComputedStyle(e).visibility!=='hidden';const yt=()=>(w.__cursiaFakeYt||[])[0];${body}})()`;
const centerOf = (sel) => inH5p(`const el=(${sel});if(!el)return null;const r=el.getBoundingClientRect();let x=r.left+r.width/2,y=r.top+r.height/2;let cw=w;while(cw!==cw.parent){const fe=cw.frameElement;const fr=fe.getBoundingClientRect();x+=fr.left+fe.clientLeft;y+=fr.top+fe.clientTop;cw=cw.parent}return {x,y};`);
const BTNS = inH5p(`return [...d.querySelectorAll('button,[role=button],.h5p-joubelui-button,.h5p-branching-question-alternative')].filter(vis).map(e=>((e.innerText||'').trim()||e.getAttribute('aria-label')||e.className).slice(0,60));`);
const H5P_TEXT = inH5p(`return d.body.innerText;`);

/** Clic REAL (CDP) en el elemento visible más interno cuyo texto/aria-label contiene alguno de `labels`. */
async function clickText(b, labels, scopeSel = 'button,[role=button],.h5p-joubelui-button,.h5p-branching-question-alternative') {
  const sel = `(()=>{const L=${JSON.stringify(labels)};const els=[...d.querySelectorAll(${JSON.stringify(scopeSel)})].filter(e=>{if(!vis(e)||e.disabled||e.getAttribute('aria-disabled')==='true')return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.right>0&&r.left<w.innerWidth;});const m=els.filter(e=>{const t=((e.innerText||'').trim()+'|'+(e.getAttribute('aria-label')||''));return L.some(l=>t.includes(l))});return m[m.length-1]||null})()`;
  let c = await b.evaluate(centerOf(sel));
  if (!c) return 'no: ' + JSON.stringify(await b.evaluate(BTNS).catch((e) => e.message));
  const vh = await b.evaluate('window.innerHeight');
  if (c.y < 40 || c.y > vh - 40) { await b.evaluate(`window.scrollBy(0, ${Math.round(c.y - vh / 2)})`); await sleep(500); c = await b.evaluate(centerOf(sel)); }
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', buttons: 0, clickCount: 1 });
  return 'ok';
}
const visibleBtn = (b, label) => b.evaluate(BTNS).then((l) => l.some((t) => t.includes(label))).catch(() => false);
async function shot(b, name) {
  const f = path.join(SHOTS, `h5p2-${name}.png`);
  await b.screenshot(f);
  out.shots.push(f);
}

// ── Servidor: php -S en 8099 (compuerta) o en ALT detrás de un proxy local (nunca 8099) ──
let server = null;
let proxy = null;
let browser = null;
const proxyLog = { forwarded: 0, blocked: {} };
async function startServer() {
  const logPath = path.join(SHOTS, 'h5p2-php-server.log');
  const port = ALT || 8099;
  if (await portInUse(port)) { ok(false, `puerto ${port} libre para el servidor PHP desechable`); return false; }
  const phpArgs = ['-c', PHPINI, '-S', `127.0.0.1:${port}`, '-t', SRC, ...(ALT ? [path.join(__dirname, 'moodle-alt-port-router.php')] : [])];
  server = spawn(PHP, phpArgs, { stdio: ['ignore', fs.openSync(logPath, 'w'), fs.openSync(logPath, 'a')] });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { await sleep(200); up = await portInUse(port); }
  if (!ok(up, `servidor PHP desechable en 127.0.0.1:${port}${ALT ? ' (router: SERVER_PORT 8099 fingido; 8099 NO se abre)' : ''} solo durante el QA`)) return false;
  if (ALT) {
    if (await portInUse(PROXY_PORT)) { ok(false, `puerto ${PROXY_PORT} libre para el proxy`); return false; }
    // Proxy: solo reenvía Host 127.0.0.1:8099 → 127.0.0.1:ALT; todo lo demás se rechaza (403).
    proxy = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url); } catch (e) { res.writeHead(400); return res.end('bad'); }
      if (u.hostname !== '127.0.0.1' || u.port !== '8099') { proxyLog.blocked[u.host] = (proxyLog.blocked[u.host] || 0) + 1; res.writeHead(403); return res.end('blocked'); }
      proxyLog.forwarded++;
      const p = http.request({ host: '127.0.0.1', port: ALT, method: req.method, path: u.pathname + u.search, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      p.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
      req.pipe(p);
    });
    await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
  }
  return true;
}
function stopAll() {
  if (browser) { try { browser.close(); } catch (e) {} browser = null; }
  if (proxy) { try { proxy.close(); } catch (e) {} proxy = null; }
  if (server) { try { server.kill('SIGTERM'); } catch (e) {} server = null; }
}

async function login(b, creds) {
  await b.navigate(`${WWW}/login/index.php`);
  await b.evaluate(`(()=>{document.querySelector('#username').value=${JSON.stringify(creds.username)};document.querySelector('#password').value=${JSON.stringify(creds.password)};document.querySelector('#login').submit();return 1})()`);
  await sleep(2500);
  return b.evaluate(`!location.pathname.startsWith('/login')`);
}
async function openH5p(b, cmid, lib, what) {
  await b.navigate(`${WWW}/mod/h5pactivity/view.php?id=${cmid}`);
  const got = await b.waitFor(inH5p(`return inst.libraryInfo.versionedName;`), { timeoutMs: 60000, what }).catch((e) => e.message);
  ok(got === lib, `${what}: el reproductor real despliega y carga ${lib} (cm ${cmid})`, got);
  await sleep(1200);
  return got === lib;
}
const widths = (b) => b.evaluate(`({docW:document.documentElement.scrollWidth, winW:innerWidth})`).then(async (top) => ({ top, h5p: await b.evaluate(inH5p(`return {docW:d.documentElement.scrollWidth, winW:w.innerWidth};`)).catch((e) => ({ error: e.message })) }));

async function main() {
  const creds = readCreds(CREDS);
  const mc = R.moodle && R.moodle.E5;
  const info = R.courses && R.courses.E5;
  if (!ok(mc && mc.courseid && mc.h5p2 && Array.isArray(mc.cms), 'results-v3.json trae el curso E5 restaurado (moodle.E5 con h5p2 y cms)', { moodle: !!mc, h5p2: mc && !!mc.h5p2 })) return;
  const cmOf = (idn) => (mc.cms.find((x) => x.idnumber === idn) || {}).cmid;
  const bsCm = cmOf(mc.h5p2.bs);
  const dcCm = (mc.h5p2.reviews[0] || {}).cmid;
  const ivInfo = info && info.iv;
  const ivCm = ivInfo ? cmOf(`cv3:ch:${ivInfo.chapterId}:video`) : null;
  ok(bsCm && dcCm && ivCm && ivInfo.pauses.length > 0 && ivInfo.questions.length > 0, 'E5: cm del caso ramificado, de un «Repaso» y del video v2 (con pausas y preguntas) identificados', { bsCm, dcCm, ivCm, iv: ivInfo && { p: ivInfo.pauses.length, q: ivInfo.questions.length } });
  if (!bsCm || !dcCm || !ivCm) return;
  const en = vm('enrol', String(mc.courseid), creds.username);
  ok(en.enrolled === true, `E5: estudiante local de prueba matriculado en el curso #${mc.courseid}`, en);
  const st0 = { bs: vm('state', String(mc.courseid), String(bsCm), creds.username), dc: vm('state', String(mc.courseid), String(dcCm), creds.username) };
  if (want('bs') && want('repaso')) ok(st0.bs.attempts.length === 0 && st0.dc.completion === 'INCOMPLETE', 'E5: punto de partida limpio (BS sin intentos; «Repaso» INCOMPLETE)', { bs: st0.bs.attempts, dc: st0.dc.completion });

  if (!(await startServer())) return;
  browser = await launchChrome({ extraArgs: ALT ? [`--proxy-server=http://127.0.0.1:${PROXY_PORT}`, '--proxy-bypass-list=<-loopback>'] : [] });
  const b = browser;
  // Registro de red + stub de YouTube (CDP Fetch en la página: cubre los iframes H5P del mismo origen).
  const requests = [];
  let ytStubServed = 0;
  const blockedExternal = [];
  b.onEvent((m) => {
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
    if (m.method === 'Fetch.requestPaused') {
      const { requestId, request } = m.params;
      if (/^https:\/\/www\.youtube\.com\/iframe_api(\?|$)/.test(request.url)) {
        ytStubServed++;
        b.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/javascript; charset=utf-8' }], body: Buffer.from(FAKE_YT_API).toString('base64') });
      } else {
        blockedExternal.push(request.url.slice(0, 160));
        b.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
    }
  });
  await b.send('Network.enable');
  // Todo https (el Moodle local es http://127.0.0.1): la API de YouTube → stub; el resto → bloqueado.
  // http fuera de loopback ya no resuelve (CURSIA_CHROME_HOST_RESOLVER_RULES) ni pasa el proxy (--alt-port).
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*', requestStage: 'Request' }] });
  await b.setViewport(1280, 900, false);
  if (!ok(await login(b, creds), 'login del estudiante local de prueba')) return;

  // ── Branching Scenario: pobre → aceptable → óptimo ──
  area = 'browser-h5p2-bs';
  const BS_LIB = 'H5P.BranchingScenario 1.10';
  const PATHS = {
    poor: ['Dejar que siga operando'],
    acceptable: ['Detener la pala, aplicar el bloqueo', 'Cambiar solo el filtro'],
    optimal: ['Detener la pala, aplicar el bloqueo', 'Cambiar el filtro, tomar una muestra', 'Programar el cambio de aceite'],
  };
  const ENDING = { poor: 'La falla se agrava', acceptable: 'Síntoma resuelto, causa pendiente', optimal: 'Intervención segura y con causa raíz' };
  const WANT = { poor: { grade: 0, scaled: 0 }, acceptable: { grade: 70, scaled: 0.7 }, optimal: { grade: 100, scaled: 1 } };
  const proceed = async () => { await sleep(1200); if (await visibleBtn(b, 'Continuar')) { await clickText(b, ['Continuar']); await sleep(1200); } };
  out.metrics.bs = {};
  let n = 0;
  for (const k of want('bs') ? ['poor', 'acceptable', 'optimal'] : []) {
    n++;
    if (!(await openH5p(b, bsCm, BS_LIB, `BS intento ${n} (${k})`))) break;
    const steps = [];
    const btns0 = await b.evaluate(BTNS).catch(() => []);
    steps.push(await clickText(b, btns0.some((t) => t.includes('Reiniciar el caso')) ? ['Reiniciar el caso'] : ['Comenzar']));
    await sleep(1200);
    if (await visibleBtn(b, 'Comenzar')) { steps.push(await clickText(b, ['Comenzar'])); await sleep(1200); }
    if (n === 1) await shot(b, 'bs-1280-situacion');
    await proceed(); // situación → primera decisión
    for (const alt of PATHS[k]) {
      steps.push(await clickText(b, [alt], '.h5p-branching-question-alternative'));
      await proceed(); // consecuencia (si la hay) → siguiente pantalla
    }
    const endText = await b.waitFor(inH5p(`const t=d.body.innerText;return t.includes(${JSON.stringify(ENDING[k])})?t:'';`), { timeoutMs: 15000, what: `final ${k}` }).catch((e) => `ERROR ${e.message}`);
    ok(steps.every((s) => s === 'ok') && endText.includes(ENDING[k]), `BS ${k}: camino recorrido con clics reales hasta el final «${ENDING[k]}»`, { steps, end: endText.slice(0, 300) });
    eq0(englishV2In(endText), `BS ${k}: pantalla final solo en español`);
    await shot(b, `bs-1280-final-${k}`);
    await sleep(3000); // deja terminar el POST xAPI
    const st = vm('state', String(mc.courseid), String(bsCm), creds.username);
    const last = st.attempts[st.attempts.length - 1] || {};
    out.metrics.bs[k] = { grade: st.grade, completion: st.completion, attempts: st.attempts };
    ok(st.attempts.length === n && Math.abs(last.scaled - WANT[k].scaled) < 1e-6, `BS ${k}: intento ${n} registrado con scaled ${WANT[k].scaled}`, st.attempts);
    if (k === 'poor') ok(st.grade === 0 && st.completion !== 'COMPLETE_PASS', 'BS pobre → nota 0, NO aprueba', { grade: st.grade, completion: st.completion });
    else ok(st.grade === WANT[k].grade && st.completion === 'COMPLETE_PASS' && st.gradepass === 70, `BS ${k} → nota ${WANT[k].grade} (la más alta), COMPLETE_PASS (aprobación 70)`, { grade: st.grade, completion: st.completion, gradepass: st.gradepass });
  }

  // ── «Repaso» (Dialog Cards): completion por vista, sin nota ──
  area = 'browser-h5p2-repaso';
  if (want('repaso') && (await openH5p(b, dcCm, 'H5P.Dialogcards 1.9', '«Repaso»'))) {
    const turn = await clickText(b, ['Girar']);
    await sleep(1000);
    ok(turn === 'ok', '«Repaso»: la tarjeta se gira con un clic real («Girar»)', turn);
    await shot(b, 'repaso-1280-reverso');
    eq0(englishV2In(await b.evaluate(H5P_TEXT).catch(() => '')), '«Repaso»: reproductor solo en español');
    await sleep(1500);
    const st = vm('state', String(mc.courseid), String(dcCm), creds.username);
    out.metrics.repaso = { completion: st.completion, grade: st.grade, attempts: st.attempts.length };
    ok(st.completion === 'COMPLETE' && st.grade === null && st.grademax === null && st.attempts.length === 0, '«Repaso»: COMPLETE al verlo; sin ítem de calificación ni intentos registrados', out.metrics.repaso);
  }

  // ── Video interactivo v2: pausa de reflexión + remediación (seek) ──
  area = 'browser-h5p2-iv';
  if (want('iv') && (await openH5p(b, ivCm, 'H5P.InteractiveVideo 1.27', 'IV v2'))) {
    const ready = await b.waitFor(inH5p(`const v=inst.video;return yt()&&v&&v.getDuration&&v.getDuration()>0?JSON.stringify({handler:v.getHandlerName&&v.getHandlerName(),dur:v.getDuration(),id:yt().videoId}):'';`), { timeoutMs: 30000, what: 'stub YouTube' }).then(JSON.parse, (e) => ({ error: e.message }));
    ok(ready.handler === 'YouTube' && ready.dur === VIDEO_SEC && ytStubServed >= 1, `IV v2: handler YouTube sobre el stub local de la API (sin red), duración ${VIDEO_SEC} s`, { ready, ytStubServed });
    const ytT = () => b.evaluate(inH5p(`const p=yt();return {t:Math.round(p._now()*10)/10,st:p._st};`));
    const playReal = async () => clickText(b, ['Reproducir', 'Play'], '.h5p-control.h5p-play, .h5p-control.h5p-pause, button.h5p-play, [role=button].h5p-play');
    // 1) Remediación (primero: todos los saltos del harness van hacia adelante; el único salto atrás es el de la adaptividad): respuesta incorrecta → «Volver a ver este tramo» → seek al inicio del tramo.
    const q0 = ivInfo.questions[0];
    await b.evaluate(inH5p(`inst.video.seek(${q0.from - 2});inst.video.play();return 1;`));
    const qShown = await b.waitFor(inH5p(`return yt()._st===2&&[...d.querySelectorAll('.h5p-interaction')].some(e=>vis(e)&&e.querySelector('.h5p-answer, .h5p-true-false-answer'))?1:0;`), { timeoutMs: 20000, what: 'pregunta del IV' }).catch((e) => e.message);
    const qDbg = qShown === 1 ? null : await b.evaluate(inH5p(`const p=yt();return {t:p._now(),st:p._st,log:p.log.slice(-12),inter:[...d.querySelectorAll('.h5p-interaction')].filter(vis).map(e=>e.className+' :: '+e.innerText.slice(0,80))};`)).catch((e) => e.message);
    ok(qShown === 1, `IV v2: la pregunta del segundo ${q0.from} pausa el video y se muestra`, { qShown, qDbg });
    const ans = await b.evaluate(inH5p(`const box=[...d.querySelectorAll('.h5p-interaction')].find(e=>vis(e)&&e.querySelector('.h5p-answer, .h5p-true-false-answer'));if(!box)return 'sin pregunta visible';const o=[...box.querySelectorAll('.h5p-answer, .h5p-true-false-answer')].find(e=>e.innerText.trim()===${JSON.stringify(q0.wrongText)});if(!o)return 'sin opción: '+[...box.querySelectorAll('.h5p-answer, .h5p-true-false-answer')].map(e=>e.innerText.trim()).join('|');o.click();const k=[...box.querySelectorAll('button,.h5p-joubelui-button')].find(x=>vis(x)&&x.innerText.trim()==='Comprobar');if(k)k.click();return 'ok';`));
    ok(ans === 'ok', `IV v2: se responde MAL («${q0.wrongText}») y se comprueba`, ans);
    await sleep(1200);
    const seekBtn = await b.waitFor(inH5p(`return [...d.querySelectorAll('button,.h5p-joubelui-button')].some(e=>vis(e)&&e.innerText.trim()==='Volver a ver este tramo')?1:0;`), { timeoutMs: 10000, what: 'botón de remediación' }).catch((e) => e.message);
    ok(seekBtn === 1, 'IV v2: tras el error aparece «Volver a ver este tramo» (adaptividad)', seekBtn);
    await shot(b, 'iv-1280-remediacion');
    eq0(englishV2In(await b.evaluate(H5P_TEXT).catch(() => '')), 'IV v2: remediación solo en español');
    const before = await ytT();
    const clk = await clickText(b, ['Volver a ver este tramo']);
    await sleep(800);
    const sk = await b.evaluate(inH5p(`const p=yt();return {t:p._now(),seeks:p.log.filter(x=>x[0]==='seek').map(x=>x[1])};`));
    ok(clk === 'ok' && sk.seeks.includes(q0.seekTo) && sk.t >= q0.seekTo - 0.5 && sk.t < q0.from, `IV v2: «Volver a ver este tramo» (clic real) salta a ${q0.seekTo} s (inicio del tramo, antes de la pregunta en ${q0.from} s)`, { clk, before, after: sk });
    await b.evaluate(inH5p(`inst.video.pause();return 1;`));
    // 2) Pausa de reflexión (hacia adelante desde el tramo remediado): el video se detiene en el tramo y se reanuda con el botón de reproducir.
    const p0 = ivInfo.pauses[0];
    await b.evaluate(inH5p(`inst.video.seek(${p0.from - 2});inst.video.play();return 1;`));
    const paused = await b.waitFor(inH5p(`const p=yt();const t=d.body.innerText;return p._st===2&&t.includes('Pausa para pensar:')?JSON.stringify({t:p._now(),st:p._st}):'';`), { timeoutMs: 20000, what: 'pausa de reflexión' }).then(JSON.parse, (e) => ({ error: e.message, yt: null }));
    ok(paused.st === 2 && paused.t >= p0.from - 0.5 && paused.t <= p0.to + 0.5, `IV v2: la pausa de reflexión (${p0.from}–${p0.to} s) DETIENE el video y muestra «Pausa para pensar:»`, paused);
    await shot(b, 'iv-1280-pausa-reflexion');
    eq0(englishV2In(await b.evaluate(H5P_TEXT).catch(() => '')), 'IV v2: pausa de reflexión solo en español');
    const resume = await playReal();
    await sleep(2500);
    const after = await ytT();
    ok(resume === 'ok' && after.st === 1 && after.t > paused.t + 1, 'IV v2: tras la pausa, el botón de reproducir (clic real) REANUDA el video (el tiempo avanza)', { resume, paused, after });
    await b.evaluate(inH5p(`inst.video.pause();return 1;`)).catch(() => null);
  }

  // ── 390 px (emulación móvil): sin scroll horizontal, solo español ──
  area = 'browser-h5p2-390';
  await b.setViewport(390, 844, true);
  out.metrics.w390 = {};
  for (const [k, cm, lib] of want('390') ? [['bs', bsCm, BS_LIB], ['repaso', dcCm, 'H5P.Dialogcards 1.9'], ['iv', ivCm, 'H5P.InteractiveVideo 1.27']] : []) {
    if (!(await openH5p(b, cm, lib, `${k} @390`))) continue;
    await b.evaluate(`(()=>{const f=document.querySelector('iframe');if(f)f.scrollIntoView({block:'start'});return 1})()`);
    await sleep(800);
    if (k === 'bs') { await clickText(b, ['Reiniciar el caso', 'Comenzar']); await sleep(1200); if (await visibleBtn(b, 'Comenzar')) { await clickText(b, ['Comenzar']); await sleep(1200); } await proceed(); }
    if (k === 'repaso') { await clickText(b, ['Girar']); await sleep(900); }
    const wds = await widths(b);
    out.metrics.w390[k] = wds;
    ok(wds.top.winW === 390 && wds.top.docW <= 390 && wds.h5p.docW <= wds.h5p.winW, `${k} @390: sin scroll horizontal (página ${wds.top.docW}/${wds.top.winW}, H5P ${wds.h5p.docW}/${wds.h5p.winW})`, wds);
    eq0(englishV2In(await b.evaluate(H5P_TEXT).catch(() => '')), `${k} @390: solo español`);
    await shot(b, `${k}-390`);
  }
  await b.setViewport(1280, 900, false);

  // ── Red ──
  area = 'browser-h5p2-red';
  const hosts = {};
  for (const u of requests) { try { const h = new URL(u).host; hosts[h] = (hosts[h] || 0) + 1; } catch (e) {} }
  out.network = { hosts, ytStubServed, proxy: ALT ? proxyLog : null };
  // Todo pedido fuera de loopback quedó interceptado: la API de YouTube → stub; el resto (p. ej. el
  // MathJax de jsdelivr que configura el propio sitio Moodle) → bloqueado en el navegador, nunca sale.
  const handled = new Set([...blockedExternal, 'https://www.youtube.com/iframe_api'].map((u) => { try { return new URL(u).host; } catch (e) { return u; } }));
  const leaked = Object.keys(hosts).filter((h) => h && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h) && !handled.has(h));
  out.network.blockedExternal = [...new Set(blockedExternal)];
  ok(ytStubServed >= 1, `API de YouTube servida por el stub local (${ytStubServed}×), nunca por la red`);
  eq0(leaked, `ningún pedido sale del navegador: todo host externo quedó interceptado (bloqueados: ${[...new Set(blockedExternal.map((u) => { try { return new URL(u).host; } catch (e) { return u; } }))].join(', ') || 'ninguno'})`);
}

main()
  .catch((e) => ok(false, 'browser-h5p2 sin excepciones', e.stack || e.message))
  .finally(async () => {
    stopAll();
    await sleep(500);
    area = 'browser-h5p2';
    const port = ALT || 8099;
    ok(!(await portInUse(port)), `servidor PHP de 127.0.0.1:${port} detenido al final`);
    out.finishedAt = new Date().toISOString();
    const fails = out.assertions.filter((a) => !a.ok).length;
    out.pass = fails === 0 && out.assertions.length > 0;
    fs.writeFileSync(OUTJSON, JSON.stringify(out, null, 2));
    console.log(`browser-h5p2: ${out.assertions.length - fails}/${out.assertions.length} aserciones OK (${out.mode}) → ${OUTJSON}`);
    process.exit(out.pass ? 0 : 1);
  });
