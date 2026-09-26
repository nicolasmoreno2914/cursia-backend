#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — R13: QA de navegador de los cursos v3 RESTAURADOS por el E2E
// (e2e-v3.js) en el Moodle 4.5 local desechable. Chrome headless por CDP.
//
//  - Red de Chrome RESTRINGIDA (--host-resolver-rules): solo 127.0.0.1 y los hosts de
//    reproducción de YouTube (youtube.com, youtube-nocookie.com, ytimg.com,
//    googlevideo.com, ggpht.com); todo lo demás ~NOTFOUND. Cada request (página +
//    iframes/workers adjuntados con Target.setAutoAttach) se registra por CDP y se
//    clasifica: 0 requests a APIs de proveedores pagados (medido).
//  - Servidor PHP en 127.0.0.1:8099 SOLO durante esta prueba (se mata al final).
//  - Login del estudiante local de prueba (credenciales desde archivo; la
//    contraseña nunca se imprime) y matrícula en E1, E2 y E3 (PHP CLI).
//  - E1 (aula-clara/light) y E2 (oscuro-premium/dark) a 390 / 768 / 1280 px
//    (métricas fijas, mobile:false = chequeo de referencia) + emulación móvil real a
//    390 (el overflow se mide contra 390, no contra el viewport que el modo móvil ensancha).
//    Dos pasadas por página: tal como carga (ENHANCED, acordeones cerrados) y con TODO
//    abierto (<details>, revelados, cada pestaña): 0 overflow, 0 texto recortado u
//    oculto, texto pedagógico ≥ 16 px, contraste ≥ 4.5, contenido Cursia en español.
//  - Iframe IV inline: carga diferida + reproduce; enlace de respaldo visible.
//  - Reproductor REAL: una actividad de CADA tipo calificable (QuestionSet, DragText,
//    Blanks) + el video interactivo (IV) respondidos → nota 100 en DB y en el gradebook.
//  - forceclean=1 TEMPORAL (admin/cli/cfg.php) + purge: extractText de cada label
//    renderizado con forceclean == el renderizado sin forceclean (100 %, por label),
//    conteos por capítulo, y las mismas métricas visuales; forceclean vuelve al valor
//    original (0) SIEMPRE (finally) y se verifica.
//
// Uso: node browser-qa-v3.js <results-v3.json> --moodle <dir> --creds <file> --shots <dir> [--repo <dir>]
'use strict';
const fs = require('fs');
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
if (!resultsFile || !MOODLE || !CREDS || !SHOTS) {
  console.error('uso: node browser-qa-v3.js <results-v3.json> --moodle <dir> --creds <file> --shots <dir> [--repo <backend>]');
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const SRC = path.join(MOODLE, 'source');
const PHPINI = path.join(MOODLE, 'php.ini');
const PHP = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';
const WWW = 'http://127.0.0.1:8099';
// Red de Chrome: allowlist de reproducción de YouTube + loopback.
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', 'youtube.com', '*.youtube.com', 'youtube-nocookie.com', '*.youtube-nocookie.com', '*.ytimg.com', '*.googlevideo.com', '*.ggpht.com'];
process.env.CURSIA_CHROME_HOST_RESOLVER_RULES = `MAP * ~NOTFOUND, ${ALLOWED_HOSTS.map((h) => `EXCLUDE ${h}`).join(', ')}`;
const hostAllowed = (h) => ALLOWED_HOSTS.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) : h === a));
const { launchChrome, sleep } = require(path.join(REPO, 'scripts/lib/v21-cdp.js'));
const VC = require(path.join(REPO, 'dist/modules/visual-components/index.js'));
const SHELL = require(path.join(REPO, 'dist/modules/course-shell/index.js'));
const H5PLIB = require(path.join(REPO, 'dist/package/h5p/index.js'));
const PV = require('./providers');
const { H5P_ANSWERS } = require('./llm-v3');
const R = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
const OUTJSON = path.join(path.dirname(resultsFile), 'browser-qa-v3.json');

const out = { startedAt: new Date().toISOString(), assertions: [], shots: [], metrics: {}, network: null };
let area = 'browser';
function ok(cond, msg, detail) {
  out.assertions.push({ area, ok: !!cond, msg, ...(cond ? {} : { detail }) });
  console.log(`${cond ? '✅' : '❌'} [${area}] ${msg}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 1200) : ''}`);
  return !!cond;
}
function eq0(arr, msg) { return ok(Array.isArray(arr) && arr.length === 0, msg, arr); }
function php(script, ...a) {
  return spawnSync(PHP, ['-c', PHPINI, script, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: SRC });
}
function vm(...a) {
  const r = php(path.join(REPO, 'scripts/moodle/v21-video-moodle.php'), SRC, ...a);
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT_JSON '));
  if (!line) throw new Error(`v21-video-moodle.php ${a[0]}: ${(r.stderr || r.stdout || '').slice(-800)}`);
  return JSON.parse(line.slice('RESULT_JSON '.length));
}
function cfg(name, value) {
  const r = php(path.join(SRC, 'admin/cli/cfg.php'), `--name=${name}`, ...(value === undefined ? [] : [`--set=${value}`]));
  if (r.status !== 0) throw new Error(`cfg.php ${name}: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}
function purge() {
  const r = php(path.join(SRC, 'admin/cli/purge_caches.php'));
  if (r.status !== 0) throw new Error(`purge_caches: ${r.stderr || r.stdout}`);
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

// Textos por defecto en inglés que NO deben verse en el contenido Cursia ni en los reproductores H5P.
const ENGLISH = ['Check', 'Retry', 'Show solution', 'Submit', 'Submit Answers', 'Untitled', 'You got', 'Question', 'Finish', 'Next', 'Previous', 'Correct!', 'Incorrect', 'Your result', 'Reuse', 'Embed', 'Rights of use', 'Continue', 'Summary', 'True', 'False'];
const englishIn = (t) => ENGLISH.filter((w) => new RegExp(`(^|[^A-Za-zÁ-ú])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-zÁ-ú]|$)`).test(t));

// ── Métricas de la página del curso (evaluadas en el navegador) ──
// openAll=true: abre cada <details> (acordeones, revelados, autoevaluación) y recorre
// CADA pestaña (click → mide su panel), para medir también el contenido que ENHANCED oculta.
//
// Nodos del reproductor multimedia de Moodle (el filtro mediaplugin envuelve el <audio>
// del shell en video.js) — tratamiento PRECISO:
//  - texto hijo de <audio>/<video> (contenido de respaldo): el navegador no lo renderiza si
//    soporta el elemento → excluido de todo (contado);
//  - .vjs-control-text: texto SOLO para lectores de pantalla por diseño de video.js
//    (clip 1 px) → excluido de tamaño/recorte/oculto (contado);
//  - controles del reproductor no visibles (menús cerrados, estados) → excluidos de "oculto";
//  - controles VISIBLES (tiempo, velocidad…): SE MIDEN contraste y recorte; el tamaño se
//    registra aparte (UI del reproductor, no texto pedagógico); el idioma no se evalúa (paquete
//    de idioma del sitio, lang=en en el Moodle local).
const MEASURE = (cmids, width, openAll) => `(() => {
  const CM = ${JSON.stringify(cmids)}; const W = ${width}; const OPEN = ${!!openAll};
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const res = { scrollW: document.documentElement.scrollWidth, innerW: innerWidth, bodyScrollW: document.body.scrollWidth, maxRight: 0,
    textEls: 0, openedDetails: 0, tabsVisited: 0, gradientBg: 0, metaChips: 0, media: { fallback: 0, srOnly: 0, hidden: 0, visible: 0, visibleSmall: 0 },
    small: [], lowContrast: [], clipped: [], internalScroll: [], hiddenText: [], closedSkipped: 0, cursiaText: '', missingCms: [] };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); const c = parse(s.backgroundColor); if (c && c.a > 0.5) return c; if (s.backgroundImage && s.backgroundImage !== 'none') res.gradientBg++; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const visible = (el) => { const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const inClosedDetails = (el) => { for (let e = el; e; e = e.parentElement) { if (e.tagName === 'DETAILS' && !e.open && !(el.closest('summary') && el.closest('summary').parentElement === e)) return true; } return false; };
  const measureTree = (root, cmid, kind, skipPanels) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      const el = n.parentElement;
      if (!el || seen.has(el) || el.closest('script,style,noscript,iframe')) continue;
      if (skipPanels && el.closest('[role=tabpanel]')) continue;
      seen.add(el);
      const txt = n.nodeValue.trim().slice(0, 50);
      const s = getComputedStyle(el);
      const media = el.closest('.video-js, .mediaplugin, audio, video');
      if (media) {
        if (el.closest('audio, video') && !el.closest('.video-js')) { res.media.fallback++; continue; }
        if (el.closest('audio, video')) { res.media.fallback++; continue; }
        if (el.closest('.vjs-control-text')) { res.media.srOnly++; continue; }
        if (!visible(el)) { res.media.hidden++; continue; }
        res.media.visible++;
        if (parseFloat(s.fontSize) < 16) res.media.visibleSmall++;
      } else {
        if (!OPEN && inClosedDetails(el)) { res.closedSkipped++; continue; }
        if (el.closest('.cvc-tablabel[hidden]') && root.querySelector('[role=tab]')) continue; // el rótulo pasó al botón de la pestaña (se mide ahí)
        if (!visible(el)) { if (!el.closest('.cursia-iv-inline')) res.hiddenText.push({ cmid, kind, txt }); continue; }
        res.cursiaText += '\\n' + n.nodeValue;
        res.textEls++;
        const fs = parseFloat(s.fontSize);
        const nav = !!el.closest('.cursia-iv-fallback, .cursia-iv-open, .activity-instance, .activity-information');
        const metaEl = el.closest('.cvc-meta');
        const metaOk = metaEl && metaEl.innerText.trim().length <= 30 && !/\\n/.test(metaEl.innerText.trim()) && getComputedStyle(metaEl).textTransform === 'uppercase';
        if (metaOk) { res.metaChips++; if (fs < 13) res.small.push({ cmid, kind, fs, txt, meta: true }); }
        else if (fs < 16 && !nav) res.small.push({ cmid, kind, fs, txt });
      }
      const fg = parse(s.color); const bg = bgOf(el);
      if (fg) { const cr = ratio({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) }, bg); if (cr < 4.5) res.lowContrast.push({ cmid, kind, cr: Math.round(cr * 100) / 100, fg: s.color, bg: [bg.r, bg.g, bg.b].join(','), txt, media: !!media }); }
      for (let e = el; e && e !== root.parentElement; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && e.scrollWidth > e.clientWidth + 1) { res.clipped.push({ cmid, txt, tag: e.tagName, sw: e.scrollWidth, cw: e.clientWidth }); break; }
        if ((cs.overflowY === 'hidden' || cs.overflowY === 'clip') && e.scrollHeight > e.clientHeight + 2) { res.clipped.push({ cmid, txt, tag: e.tagName, sh: e.scrollHeight, ch: e.clientHeight, axis: 'y' }); break; }
      }
    }
  };
  for (const [cmid, kind] of CM) {
    const li = document.getElementById('module-' + cmid);
    if (!li) { res.missingCms.push(cmid); continue; }
    const roots = [...li.querySelectorAll('.activity-altcontent, .activity-description, .contentafterlink')];
    for (const root of roots) {
      if (OPEN) {
        root.querySelectorAll('details').forEach((d) => { if (!d.open) { d.open = true; res.openedDetails++; } });
        root.querySelectorAll('[role=tablist]').forEach((tl) => {
          [...tl.querySelectorAll('[role=tab]')].forEach((tab) => {
            tab.click(); res.tabsVisited++;
            const panel = document.getElementById(tab.getAttribute('aria-controls'));
            if (panel) measureTree(panel, cmid, kind, false);
          });
        });
      }
      root.querySelectorAll('*').forEach((e) => { const r = e.getBoundingClientRect(); if (r.width > 0 && !e.closest('.cvc-scroll')) res.maxRight = Math.max(res.maxRight, r.right + scrollX); const s = getComputedStyle(e); if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && e.scrollWidth > e.clientWidth + 1 && !e.closest('.video-js')) res.internalScroll.push({ cmid, tag: e.tagName, cls: String(e.className).slice(0, 60), sw: e.scrollWidth, cw: e.clientWidth }); });
      if (getComputedStyle(root).overflowX !== 'visible' && root.scrollWidth > root.clientWidth + 1) res.internalScroll.push({ cmid, tag: root.tagName, cls: String(root.className).slice(0, 60), sw: root.scrollWidth, cw: root.clientWidth });
      measureTree(root, cmid, kind, OPEN);
    }
  }
  res.maxRight = Math.round(res.maxRight);
  for (const k of ['small', 'lowContrast', 'clipped', 'hiddenText']) res[k] = res[k].slice(0, 40);
  return res;
})()`;

let server = null;
let browser = null;
let forcecleanTouched = false;
let forcecleanOriginal = null;
function stopServer() { if (server) { try { server.kill('SIGTERM'); } catch (e) {} server = null; } }

async function login(b, creds) {
  await b.navigate(`${WWW}/login/index.php`);
  await b.evaluate(`(()=>{document.querySelector('#username').value=${JSON.stringify(creds.username)};document.querySelector('#password').value=${JSON.stringify(creds.password)};document.querySelector('#login').submit();return 1})()`);
  await sleep(2500);
  return b.evaluate(`!location.pathname.startsWith('/login')`);
}

// Accesos al iframe inline → iframe h5p-iframe (mismo origen) → instancia IV (patrón de check-v21-video-moodle.js).
const IV = (cmid, body) => `(()=>{const f=document.querySelector('#module-${cmid} .cursia-iv-inline iframe');if(!f||!f.contentDocument)return null;const i=f.contentDocument.querySelector('iframe.h5p-iframe');const w=i&&i.contentWindow;if(!w||!w.H5P||!w.H5P.instances||!w.H5P.instances.length)return null;const iv=w.H5P.instances[0];const d=w.document;${body}})()`;
const FIND = `(()=>{function find(w){try{if(w.H5P&&w.H5P.instances&&w.H5P.instances.length)return w}catch(e){}for(let i=0;i<w.frames.length;i++){const r=find(w.frames[i]);if(r)return r}return null}return find(window)})()`;
const inH5p = (body) => `(()=>{const w=${FIND};if(!w)throw new Error('sin ventana H5P');const d=w.document;const inst=w.H5P.instances[0];const vis=(e)=>!!e&&e.getClientRects().length>0&&w.getComputedStyle(e).visibility!=='hidden';${body}})()`;
const centerOf = (sel) => inH5p(`const el=(${sel});if(!el)return null;const r=el.getBoundingClientRect();let x=r.left+r.width/2,y=r.top+r.height/2;let cw=w;while(cw!==cw.parent){const fe=cw.frameElement;const fr=fe.getBoundingClientRect();x+=fr.left+fe.clientLeft;y+=fr.top+fe.clientTop;cw=cw.parent}return {x,y};`);
async function clickBtn(b, labels) {
  return b.evaluate(inH5p(`const L=${JSON.stringify(labels)};const lab=(e)=>[(e.innerText||'').trim(),e.getAttribute('aria-label')||'',e.getAttribute('title')||''];const x=[...d.querySelectorAll('button,[role=button]')].find(e=>vis(e)&&lab(e).some(t=>L.includes(t.trim())));if(!x)return 'no: '+[...d.querySelectorAll('button,[role=button]')].filter(vis).map(e=>lab(e).join('/')).join('|');x.click();return 'ok';`));
}
async function mouseDrag(b, from, to) {
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i++) { await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / 12, y: from.y + ((to.y - from.y) * i) / 12, button: 'left', buttons: 1 }); await sleep(25); }
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(300);
}
// Respuestas correctas de las fixtures del LLM falso (llm-v3.js) ⇒ nota 100.
const FLOWS = {
  async questionset(b) {
    const qs = H5P_ANSWERS.questionset.questions;
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      const pick = q.kind === 'truefalse' ? (q.correct ? 'Verdadero' : 'Falso') : q.answers.find((a) => a.correct).text;
      await b.waitFor(inH5p(`return [...d.querySelectorAll('.question-container')].some(c=>vis(c)&&c.innerText.includes(${JSON.stringify(q.question)}))?1:0;`), { timeoutMs: 15000, what: `QS pregunta ${i + 1}` });
      const r = await b.evaluate(inH5p(`const c=[...d.querySelectorAll('.question-container')].find(c=>vis(c)&&c.innerText.includes(${JSON.stringify(q.question)}));const o=[...c.querySelectorAll('.h5p-answer,.h5p-true-false-answer')].find(e=>e.innerText.trim()===${JSON.stringify(pick)});if(!o)return 'sin opción '+[...c.querySelectorAll('.h5p-answer,.h5p-true-false-answer')].map(e=>e.innerText.trim()).join('|');o.click();const k=[...c.querySelectorAll('button')].find(e=>vis(e)&&e.innerText.trim()==='Comprobar');if(!k)return 'sin Comprobar';k.click();return 'ok';`));
      if (r !== 'ok') throw new Error(`QS pregunta ${i + 1}: ${r}`);
      await sleep(700);
      const last = i === qs.length - 1;
      const n = await clickBtn(b, last ? ['Finalizar', 'Enviar'] : ['Pregunta siguiente']);
      if (n !== 'ok') throw new Error(`QS pregunta ${i + 1}: ${n}`);
      await sleep(900);
    }
  },
  async dragtext(b) {
    const words = [...H5P_ANSWERS.dragtext.text.matchAll(/\*([^*]+)\*/g)].map((m) => m[1]);
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const fromSel = `[...d.querySelectorAll('.h5p-drag-draggables-container .h5p-draggable')].find(e=>e.innerText.split('\\n')[0].trim()===${JSON.stringify(word)})`;
      const toSel = `d.querySelectorAll('.h5p-dropzone')[${i}]`;
      let from = null; let to = null;
      for (let k = 0; k < 20; k++) {
        const f1 = await b.evaluate(centerOf(fromSel)); const t1 = await b.evaluate(centerOf(toSel));
        await sleep(250);
        from = await b.evaluate(centerOf(fromSel)); to = await b.evaluate(centerOf(toSel));
        if (!from) throw new Error(`DT: no está "${word}"`);
        if (JSON.stringify([f1, t1]) === JSON.stringify([from, to])) break;
      }
      await mouseDrag(b, from, to);
    }
    const k = await clickBtn(b, ['Comprobar']);
    if (k !== 'ok') throw new Error(`DT Comprobar: ${k}`);
  },
  async blanks(b) {
    const answers = H5P_ANSWERS.blanks.questions.map((q) => /\*([^*/]+)[^*]*\*/.exec(q)[1]);
    const n = await b.evaluate(inH5p(`return d.querySelectorAll('.h5p-text-input').length;`));
    if (n !== answers.length) throw new Error(`BL: ${n} campos`);
    for (let i = 0; i < answers.length; i++) {
      await b.evaluate(inH5p(`const e=d.querySelectorAll('.h5p-text-input')[${i}];e.scrollIntoView({block:'center'});e.focus();return 1;`));
      await b.send('Input.insertText', { text: answers[i] });
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await sleep(150);
    }
    const k = await clickBtn(b, ['Comprobar']);
    if (k !== 'ok') throw new Error(`BL Comprobar: ${k}`);
  },
  // Video interactivo: en cada checkpoint planeado (468 s ⇒ 5) busca, responde lo correcto
  // (multichoice / verdadero-falso alternados, como la fixture de llm-v3.js), "Comprobar";
  // al final "Enviar respuestas".
  async interactivevideo(b) {
    const plan = H5PLIB.planInteractionCheckpoints(468);
    await b.waitFor(inH5p(`const v=inst.video;return v&&v.getDuration&&v.getDuration()>0?1:0;`), { timeoutMs: 60000, what: 'YouTube en el IV' });
    for (let i = 0; i < plan.length; i++) {
      const cp = plan[i];
      const mc = i % 2 === 0;
      const q = mc ? '¿Qué señal indica una pérdida de presión en este tramo?' : 'Registrar la temperatura ayuda a anticipar fallas.';
      const pick = mc ? 'Respuesta lenta del actuador' : 'Verdadero';
      await b.evaluate(inH5p(`inst.video.seek(${cp.atSec + 1});inst.video.play();return 1;`));
      await b.waitFor(inH5p(`return [...d.querySelectorAll('.h5p-interaction')].some(e=>e.offsetParent!==null&&e.innerText.includes(${JSON.stringify(q)}))?1:0;`), { timeoutMs: 30000, what: `IV checkpoint ${cp.index}` });
      const r = await b.evaluate(inH5p(`const box=[...d.querySelectorAll('.h5p-interaction')].find(e=>e.offsetParent!==null&&e.innerText.includes(${JSON.stringify(q)}));const o=[...box.querySelectorAll('.h5p-answer, .h5p-true-false-answer')].find(e=>e.innerText.trim()===${JSON.stringify(pick)});if(!o)return 'sin opción';o.click();const k=[...box.querySelectorAll('button')].find(x=>x.innerText.trim()==='Comprobar');if(!k)return 'sin Comprobar';k.click();return 'ok';`));
      if (r !== 'ok') throw new Error(`IV checkpoint ${cp.index}: ${r}`);
      await b.waitFor(inH5p(`return inst.getUsersScore()===${i + 1}?1:0;`), { timeoutMs: 10000, what: `IV puntaje ${i + 1}` });
      // Como un estudiante real: cerrar la interacción ("Continuar") antes de seguir. Una
      // interacción que pausa y queda abierta mantiene el video en pausa: sin esto, el salto
      // final no llega al "ended" y la pantalla de envío nunca aparece (flaky según timing).
      await b.evaluate(inH5p(`const c=[...d.querySelectorAll('button, .h5p-joubelui-button')].find(e=>e.offsetParent!==null&&e.innerText.trim()==='Continuar');if(c)c.click();return 1;`));
      await sleep(300);
    }
    await b.evaluate(inH5p(`inst.video.seek(465);inst.video.play();return 1;`));
    await b.waitFor(inH5p(`return [...d.querySelectorAll('button, .h5p-joubelui-button')].some(e=>e.offsetParent!==null&&e.innerText.trim()==='Enviar respuestas')?1:0;`), { timeoutMs: 40000, what: 'Enviar respuestas' });
    await b.evaluate(inH5p(`[...d.querySelectorAll('button, .h5p-joubelui-button')].find(e=>e.offsetParent!==null&&e.innerText.trim()==='Enviar respuestas').click();return 1;`));
    await b.waitFor(inH5p(`return d.body.innerText.includes('¡Tus respuestas fueron enviadas!')?1:0;`), { timeoutMs: 15000, what: 'confirmación de envío' });
  },
};

// Texto de cada label/descripción tal como lo sirve Moodle (HTML del servidor, sin ejecutar JS).
async function serverTexts(b, courseid, cmids) {
  const html = await b.evaluate(`fetch('/course/view.php?id=${courseid}',{credentials:'same-origin'}).then(r=>r.text()).then(t=>{const doc=new DOMParser().parseFromString(t,'text/html');const o={};for(const id of ${JSON.stringify(cmids)}){const li=doc.getElementById('module-'+id);o[id]=li?[...li.querySelectorAll('.activity-altcontent, .activity-description, .contentafterlink')].map(e=>e.innerHTML).join('\\n'):null}return o})`);
  return Object.fromEntries(Object.entries(html).map(([k, v]) => [k, v === null ? null : VC.extractText(v)]));
}

async function main() {
  const creds = readCreds(CREDS);
  const courses = ['E1', 'E2'].map((k) => ({ key: k, moodle: R.moodle[k], info: R.courses[k] }));
  for (const key of ['E1', 'E2', 'E3']) {
    const mc = R.moodle[key];
    if (!mc || !mc.courseid) throw new Error(`sin curso Moodle restaurado para ${key}`);
    const en = vm('enrol', String(mc.courseid), creds.username);
    ok(en.enrolled === true, `${key}: estudiante local de prueba matriculado en el curso #${mc.courseid}`, en);
  }
  if (await portInUse(8099)) { ok(false, 'puerto 8099 libre para el servidor PHP desechable'); return; }
  const logPath = path.join(SHOTS, 'php-server.log');
  server = spawn(PHP, ['-c', PHPINI, '-S', '127.0.0.1:8099', '-t', SRC], { stdio: ['ignore', fs.openSync(logPath, 'w'), fs.openSync(logPath, 'a')] });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { await sleep(200); up = await portInUse(8099); }
  if (!ok(up, 'servidor PHP desechable en 127.0.0.1:8099 (solo durante el QA)')) return;
  browser = await launchChrome();
  const b = browser;
  // Registro de red: página + cada iframe/worker adjuntado (sesiones planas).
  const requests = [];
  b.onEvent((m) => {
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
    if (m.method === 'Target.attachedToTarget') {
      const sid = m.params.sessionId;
      b.send('Network.enable', {}, sid).then(() => b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid)).then(() => b.send('Runtime.runIfWaitingForDebugger', {}, sid));
    }
  });
  await b.send('Network.enable');
  await b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await b.setViewport(1280, 900, false);
  if (!ok(await login(b, creds), 'login del estudiante local de prueba')) return;

  const cmsOf = (c) => c.moodle.cms.filter((x) => x.idnumber && (x.modname === 'label' || x.modname === 'h5pactivity')).map((x) => [x.cmid, x.idnumber]);
  const pageMetrics = async (c, width, label, { mobile = false, openAll = false, shot = true } = {}) => {
    await b.setViewport(width, 900, mobile);
    await b.navigate(`${WWW}/course/view.php?id=${c.moodle.courseid}`);
    await sleep(1200);
    const m = await b.evaluate(MEASURE(cmsOf(c), width, openAll));
    if (shot) {
      const file = path.join(SHOTS, `${c.key}-${label}.png`);
      await b.screenshot(file, { fullPage: true });
      out.shots.push(file);
    }
    return m;
  };
  const assertMetrics = (m, tag, width, { lang = true } = {}) => {
    eq0(m.missingCms, `${tag}: todas las actividades Cursia presentes en la página`);
    // Referencia = el ancho configurado (no innerWidth, que el modo móvil ensancha si hay overflow).
    ok(m.scrollW <= width && m.bodyScrollW <= width && m.maxRight <= width + 1, `${tag}: 0 overflow horizontal (scrollWidth ${m.scrollW}, borde derecho máx. ${m.maxRight} ≤ ${width})`, { scrollW: m.scrollW, body: m.bodyScrollW, maxRight: m.maxRight, innerW: m.innerW });
    eq0(m.internalScroll, `${tag}: 0 scroll horizontal dentro de los labels`);
    eq0(m.clipped, `${tag}: 0 textos recortados`);
    eq0(m.hiddenText, `${tag}: 0 textos ocultos (fuera de los controles cerrados, que se miden en la pasada "todo abierto")`);
    ok(m.textEls > 50, `${tag}: ${m.textEls} elementos de texto medidos`);
    eq0(m.small, `${tag}: texto pedagógico ≥ 16 px (chips de metadato .cvc-meta ≤ 30 car., 1 línea, mayúsculas: ≥ 13 px)`);
    eq0(m.lowContrast, `${tag}: contraste WCAG ≥ 4.5 en todo el texto (incluidos los controles visibles del reproductor)`);
    if (lang) eq0(englishIn(m.cursiaText), `${tag}: contenido Cursia solo en español`);
  };

  for (const c of courses) {
    const theme = c.key === 'E1' ? 'aula-clara/light' : 'oscuro-premium/dark';
    area = `browser-${c.key}`;
    for (const width of [390, 768, 1280]) {
      const tag = `${c.key} (${theme}) @${width}`;
      const m = await pageMetrics(c, width, `${width}`);
      ok(m.innerW === width, `${tag}: viewport de referencia = ${width} (mobile:false)`, m.innerW);
      assertMetrics(m, tag, width);
      ok(m.closedSkipped > 0, `${tag}: ENHANCED carga con controles cerrados (${m.closedSkipped} textos dentro de <details> cerrados)`);
      const mo = await pageMetrics(c, width, `${width}-abierto`, { openAll: true });
      ok(mo.openedDetails > 0, `${tag} TODO ABIERTO: ${mo.openedDetails} <details> abiertos, ${mo.tabsVisited} pestañas recorridas`);
      assertMetrics(mo, `${tag} TODO ABIERTO`, width);
      ok(mo.textEls > m.textEls, `${tag} TODO ABIERTO: se midió más texto (${mo.textEls} > ${m.textEls})`);
      out.metrics[`${c.key}-${width}`] = { closed: summarize(m), open: summarize(mo) };
      const vids = c.moodle.cms.filter((x) => /:video$/.test(x.idnumber || ''));
      const fb = await b.evaluate(`(()=>${JSON.stringify(vids.map((v) => v.cmid))}.map(id=>{const li=document.getElementById('module-'+id);const a=li&&li.querySelector('.cursia-iv-open a');const y=li&&li.querySelector('.cursia-iv-fallback a');const r=a&&a.getBoundingClientRect();return {id,open:!!a&&r.width>0&&r.height>0&&getComputedStyle(a).visibility!=='hidden',href:a&&a.getAttribute('href'),yt:!!y&&y.getBoundingClientRect().width>0}}))()`);
      ok(vids.length > 0 && fb.every((x) => x.open && /\/mod\/h5pactivity\/view\.php\?id=\d+/.test(x.href) && x.yt), `${tag}: enlace de respaldo visible en los ${vids.length} videos (→ view.php de la actividad + YouTube)`, fb);
    }
    // IV inline: carga diferida + reproduce (1280).
    await b.setViewport(1280, 900, false);
    await b.navigate(`${WWW}/course/view.php?id=${c.moodle.courseid}`);
    const vid = c.moodle.cms.find((x) => /:video$/.test(x.idnumber || ''));
    const before = await b.evaluate(`(()=>{const f=document.querySelector('#module-${vid.cmid} .cursia-iv-inline iframe');return f?{src:f.getAttribute('src')||'',data:!!f.getAttribute('data-cursia-src'),lazy:f.getAttribute('loading')}:null})()`);
    await b.evaluate(`(()=>{const e=document.getElementById('module-${vid.cmid}');e&&e.scrollIntoView({block:'center'});return 1})()`);
    const info = await b.waitFor(`(()=>{const f=document.querySelector('#module-${vid.cmid} .cursia-iv-inline iframe');return f&&f.src&&f.offsetWidth>300?JSON.stringify({src:f.src,w:f.offsetWidth,lazy:f.getAttribute('loading')}):null})()`, { timeoutMs: 20000, what: 'iframe inline' }).then((v) => JSON.parse(v), (e) => ({ error: e.message }));
    ok(before && before.data && info.src && /\/h5p\/embed\.php\?/.test(info.src) && info.lazy === 'lazy', `${c.key}: iframe IV inline con carga diferida (data-cursia-src → src embed.php, loading=lazy) al entrar en pantalla`, { before, info });
    const lib = await b.waitFor(IV(vid.cmid, `return iv.libraryInfo.versionedName;`), { timeoutMs: 45000, what: 'instancia IV' }).catch((e) => e.message);
    ok(lib === 'H5P.InteractiveVideo 1.27', `${c.key}: el iframe carga H5P.InteractiveVideo 1.27`, lib);
    const yt = await b.waitFor(IV(vid.cmid, `const v=iv.video;const dur=v&&v.getDuration&&v.getDuration();return dur>0&&d.querySelector('iframe[src*="youtube"]')?JSON.stringify({handler:v.getHandlerName&&v.getHandlerName(),dur}):false;`), { timeoutMs: 60000, what: 'YouTube' }).then((v) => JSON.parse(v), (e) => ({ error: e.message }));
    ok(yt.handler === 'YouTube' && Math.abs(yt.dur - 468) <= 2, `${c.key}: el reproductor YouTube (IdwOipZAeqY) se inicializa con la duración real ≈ 468 s (red restringida a hosts de reproducción)`, yt);
    await b.evaluate(IV(vid.cmid, `iv.video.seek(5);iv.video.play();return 1;`));
    const playing = await b.waitFor(IV(vid.cmid, `const t=iv.video.getCurrentTime();return t>5.5?t:0;`), { timeoutMs: 30000, what: 'reproducción' }).catch((e) => e.message);
    ok(typeof playing === 'number' && playing > 5.5, `${c.key}: el video REPRODUCE (tiempo avanza a ${playing})`, playing);
    const ivText = await b.evaluate(IV(vid.cmid, `return d.body.innerText;`));
    eq0(englishIn(ivText || ''), `${c.key}: UI del IV en español`);
    await b.evaluate(IV(vid.cmid, `iv.video.pause();return 1;`));
    const shot = path.join(SHOTS, `${c.key}-iv-inline-1280.png`);
    await b.screenshot(shot);
    out.shots.push(shot);
  }

  // Emulación móvil real a 390 (sanity): el overflow se mide contra 390, no contra innerWidth.
  area = 'browser-mobile';
  for (const c of courses) {
    const m = await pageMetrics(c, 390, 'mobile-emulated-390', { mobile: true });
    assertMetrics(m, `${c.key} móvil emulado 390 (mobile:true)`, 390);
    const mo = await pageMetrics(c, 390, 'mobile-emulated-390-abierto', { mobile: true, openAll: true, shot: false });
    assertMetrics(mo, `${c.key} móvil emulado 390 TODO ABIERTO`, 390);
  }
  await b.setViewport(1280, 900, false);

  // Reproductor REAL: una actividad de cada tipo calificable + el IV → nota 100 en DB y gradebook.
  area = 'browser-h5p-grade';
  {
    const targets = {};
    for (const key of ['E1', 'E3']) {
      const mc = R.moodle[key];
      for (const x of mc.cms.filter((y) => y.modname === 'h5pactivity')) {
        const t = /:activity$/.test(x.idnumber) ? SHELL.activityTypeForChapter(x.idnumber.split(':')[2]) : /:video$/.test(x.idnumber) ? 'interactivevideo' : null;
        if (t && !targets[t]) targets[t] = { key, courseid: mc.courseid, cmid: x.cmid, type: t };
      }
    }
    eq(Object.keys(targets).sort(), ['blanks', 'dragtext', 'interactivevideo', 'questionset'], 'E1+E3 restaurados: hay una actividad de cada tipo (QuestionSet, DragText, Blanks) y un video interactivo');
    const LIB = { questionset: 'H5P.QuestionSet 1.20', dragtext: 'H5P.DragText 1.10', blanks: 'H5P.Blanks 1.14', interactivevideo: 'H5P.InteractiveVideo 1.27' };
    out.metrics.h5pGrades = {};
    for (const t of ['questionset', 'dragtext', 'blanks', 'interactivevideo']) {
      const target = targets[t];
      if (!target) continue;
      await b.navigate(`${WWW}/mod/h5pactivity/view.php?id=${target.cmid}`);
      const lib = await b.waitFor(inH5p(`return inst.libraryInfo.versionedName;`), { timeoutMs: 30000, what: 'H5P' }).catch((e) => e.message);
      ok(lib === LIB[t], `${t}: el reproductor real despliega y carga ${LIB[t]} (${target.key}, cm ${target.cmid})`, lib);
      let answered = true;
      try { await FLOWS[t](b); } catch (e) { answered = ok(false, `${t}: respondido a través del DOM`, e.message); }
      if (answered) ok(true, `${t}: respondido a través del DOM (todas correctas)`);
      await sleep(3000); // deja terminar el POST xAPI
      const file = path.join(SHOTS, `h5p-${t}-answered.png`);
      await b.screenshot(file);
      out.shots.push(file);
      const vis = await b.evaluate(inH5p(`return d.body.innerText;`)).catch(() => '');
      eq0(englishIn(vis), `${t}: reproductor sin textos por defecto en inglés`);
      const st = vm('state', String(target.courseid), String(target.cmid), creds.username);
      ok(st.attempts.length === 1 && st.grade === 100 && st.completion === 'COMPLETE_PASS', `${t}: DB 1 intento, nota 100, COMPLETE_PASS`, { attempts: st.attempts, grade: st.grade, completion: st.completion });
      out.metrics.h5pGrades[t] = { ...target, grade: st.grade, completion: st.completion };
    }
    for (const key of [...new Set(Object.values(targets).map((x) => x.key))]) {
      const mc = R.moodle[key];
      const n = Object.values(targets).filter((x) => x.key === key).length;
      await b.navigate(`${WWW}/grade/report/user/index.php?id=${mc.courseid}`);
      await sleep(1000);
      const gb = await b.evaluate(`(()=>{const rows=[...document.querySelectorAll('table.user-grade tr')];return rows.filter(x=>/h5pactivity/.test(x.innerHTML)&&/100[.,]00/.test(x.innerText)).length})()`);
      ok(gb === n, `${key}: gradebook del estudiante (grade/report/user) muestra ${n} nota(s) 100 de H5P`, gb);
      const file = path.join(SHOTS, `gradebook-${key}.png`);
      await b.screenshot(file, { fullPage: true });
      out.shots.push(file);
    }
  }

  // Texto de referencia SIN forceclean (HTML del servidor, antes de tocar la configuración).
  area = 'browser-forceclean';
  const noclean = {};
  for (const c of courses) noclean[c.key] = await serverTexts(b, c.moodle.courseid, cmsOf(c).map(([id]) => id));

  // forceclean=1 TEMPORAL.
  forcecleanOriginal = cfg('forceclean');
  ok(forcecleanOriginal === '0', `forceclean original = 0 (leído con admin/cli/cfg.php: "${forcecleanOriginal}")`);
  const KEY = [
    { text: 'Fuerza que el fluido ejerce sobre cada superficie del circuito.', of: () => true },
    { text: 'Ruido anormal, temperatura elevada y respuesta lenta de los actuadores.', of: () => true },
    { text: '¿Qué señal de tu equipo pasarías por alto si trabajaras con prisa?', of: () => true },
    { text: 'Pérdidas internas o un enfriamiento insuficiente del circuito.', of: (ch) => !ch.a },
    { text: 'Fíjate en cómo cambia la respuesta del sistema cuando aumenta la carga.', of: (ch) => ch.v },
  ];
  try {
    forcecleanTouched = true;
    cfg('forceclean', '1');
    purge();
    ok(cfg('forceclean') === '1', 'forceclean=1 aplicado temporalmente + caches purgadas');
    for (const c of courses) {
      const ids = cmsOf(c).map(([id]) => id);
      const clean = await serverTexts(b, c.moodle.courseid, ids);
      const diff = ids.filter((id) => !noclean[c.key][id] || clean[id] !== noclean[c.key][id]).map((id) => {
        const a = noclean[c.key][id] || ''; const z = clean[id] || '';
        let i = 0; while (i < a.length && a[i] === z[i]) i++;
        return { cmid: id, idnumber: (cmsOf(c).find(([x]) => x === id) || [])[1], at: i, noclean: a.slice(Math.max(0, i - 30), i + 60), clean: z.slice(Math.max(0, i - 30), i + 60) };
      });
      eq(diff, [], `${c.key} CLEAN_SAFE: extractText(label con forceclean) === extractText(label sin forceclean) en los ${ids.length} labels/descripciones (100 % del texto)`);
      const chapters = c.info.modules.flatMap((m) => m.chapters);
      for (const width of [390, 1280]) {
        const tag = `${c.key} @${width} forceclean=1`;
        const m = await pageMetrics(c, width, `forceclean-${width}`, { openAll: true });
        assertMetrics(m, tag, width);
        const r = await b.evaluate(`(()=>{const t=document.body.innerText;return {counts:${JSON.stringify(KEY.map((k) => k.text))}.map(s=>t.split(s).length-1),iframes:document.querySelectorAll('.cursia-iv-inline iframe').length,scripts:[...document.querySelectorAll('.activity-altcontent script, .activity-description script')].length}})()`);
        const want = KEY.map((k) => chapters.filter(k.of).length);
        eq(r.counts, want, `${tag}: textos de acordeón/tarjeta/reflexión/autoevaluación/antesala del video VISIBLES exactamente una vez por capítulo que los tiene (${want.join('/')}, ${chapters.length} capítulos)`);
        ok(r.iframes === 0 && r.scripts === 0, `${tag}: sin iframe ni script en los labels (Moodle los elimina)`, r);
        const vids = c.moodle.cms.filter((x) => /:video$/.test(x.idnumber || ''));
        const fb = await b.evaluate(`(()=>${JSON.stringify(vids.map((v) => v.cmid))}.map(id=>{const li=document.getElementById('module-'+id);const as=li?[...li.querySelectorAll('.activity-altcontent a, .activity-description a')]:[];const v=as.find(a=>/h5pactivity\\/view\\.php\\?id=/.test(a.href));const y=as.find(a=>/youtube\\.com\\/watch\\?v=IdwOipZAeqY/.test(a.href));const vis=(a)=>!!a&&a.getBoundingClientRect().width>0;return {id,view:vis(v),yt:vis(y)}}))()`);
        ok(vids.length > 0 && fb.length === vids.length && fb.every((x) => x.view && x.yt), `${tag}: enlace de respaldo visible en los ${vids.length} videos (actividad + YouTube)`, fb);
        out.metrics[`${c.key}-forceclean-${width}`] = summarize(m);
      }
    }
  } finally {
    // SIEMPRE se vuelve a forceclean=0 (también si algo falló arriba).
    try { cfg('forceclean', '0'); purge(); } catch (e) { console.error('ERROR restaurando forceclean', e.message); }
    const back = cfg('forceclean');
    out.forcecleanRestored = back;
    ok(back === '0', `forceclean restaurado a 0 (leído: "${back}")`);
  }

  // Red de Chrome medida.
  area = 'browser-network';
  const urls = requests.filter((u) => /^https?:/.test(u));
  const hosts = {};
  for (const u of urls) { const h = new URL(u).hostname; hosts[h] = (hosts[h] || 0) + 1; }
  const cls = PV.countUrls(urls);
  const outside = Object.keys(hosts).filter((h) => !hostAllowed(h));
  out.network = { requests: urls.length, hosts, providerRequests: cls.byProvider, blockedByResolver: outside };
  ok(urls.length > 100 && Object.keys(hosts).includes('127.0.0.1'), `CDP registró ${urls.length} requests de la página y sus iframes/workers`);
  ok(Object.keys(hosts).some((h) => /googlevideo|youtube/.test(h)), 'CDP vio el tráfico de reproducción de YouTube (el registro incluye los iframes de otro origen)', hosts);
  eq(cls.byProvider, PV.emptyCounts(), `Chrome: 0 requests a APIs de proveedores pagados (Anthropic, OpenAI, Gamma, Videogen, YouTube Data/upload/OAuth): ${JSON.stringify(cls.byProvider)}`);
  ok(true, `hosts fuera del allowlist (resueltos a NOTFOUND por --host-resolver-rules, ninguno de proveedor): ${outside.join(', ') || 'ninguno'}`);
  const phpErr = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => /PHP (Fatal|Parse) error/.test(l));
  eq0(phpErr, 'servidor PHP: sin errores fatales');
}
function eq(a, b2, msg) { return ok(JSON.stringify(a) === JSON.stringify(b2), msg, { got: a, want: b2 }); }
function summarize(m) {
  return { scrollW: m.scrollW, maxRight: m.maxRight, innerW: m.innerW, textEls: m.textEls, openedDetails: m.openedDetails, tabsVisited: m.tabsVisited, closedSkipped: m.closedSkipped,
    metaChips: m.metaChips, gradientBg: m.gradientBg, media: m.media, small: m.small.length, lowContrast: m.lowContrast.length, clipped: m.clipped.length, hidden: m.hiddenText.length, internalScroll: m.internalScroll.length };
}

main()
  .catch((e) => ok(false, `QA sin excepciones: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`))
  .finally(async () => {
    if (forcecleanTouched) {
      try { if (cfg('forceclean') !== '0') { cfg('forceclean', '0'); purge(); } } catch (e) { console.error('ERROR final forceclean', e.message); }
    }
    try { if (browser) browser.close(); } catch (e) {}
    stopServer();
    await sleep(500);
    const stillUp = await portInUse(8099);
    area = 'browser';
    ok(!stillUp, 'servidor PHP de 127.0.0.1:8099 detenido al final');
    out.finishedAt = new Date().toISOString();
    out.totals = { assertions: out.assertions.length, failed: out.assertions.filter((a) => !a.ok).length };
    fs.writeFileSync(OUTJSON, JSON.stringify(out, null, 2));
    console.log(`\nQA navegador V2.1: ${out.totals.failed ? 'FAIL' : 'PASS'} — ${out.totals.assertions} aserciones, ${out.totals.failed} fallidas`);
    // Código de salida explícito (un timer con unref() podía no dispararse y dejar exit 0 con fallas).
    process.exitCode = out.totals.failed ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 1500);
  });
