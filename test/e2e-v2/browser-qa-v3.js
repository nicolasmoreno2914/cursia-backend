#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — R13: QA de navegador de los cursos v3 RESTAURADOS por el E2E
// (e2e-v3.js) en el Moodle 4.5 local desechable. Chrome headless por CDP.
//
//  - Servidor PHP en 127.0.0.1:8099 SOLO durante esta prueba (se mata al final).
//  - Login del estudiante local de prueba (credenciales desde archivo; la
//    contraseña nunca se imprime) y matrícula en E1 y E2 (PHP CLI).
//  - E1 (aula-clara/light) y E2 (oscuro-premium/dark) a 390 / 768 / 1280 px
//    (métricas fijas, mobile:false) + una emulación móvil real a 390:
//    0 overflow horizontal, 0 texto recortado/oculto, texto pedagógico ≥ 16 px,
//    contraste WCAG ≥ 4.5, iframe IV inline con carga diferida que reproduce
//    (YouTube IdwOipZAeqY; solo reproducción), enlace de respaldo visible,
//    contenido Cursia solo en español.
//  - Una actividad H5P respondida en el reproductor real → nota en el gradebook.
//  - forceclean=1 TEMPORAL (admin/cli/cfg.php) + purge: completitud del texto y
//    enlaces de respaldo; forceclean=0 restaurado SIEMPRE (finally) y verificado.
//
// Uso: node browser-qa-v3.js <results-v3.json> --moodle <dir> --creds <file> --shots <dir>
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
const { launchChrome, sleep } = require(path.join(REPO, 'scripts/lib/v21-cdp.js'));
const { H5P_ANSWERS } = require('./llm-v3');
const R = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
const OUTJSON = path.join(path.dirname(resultsFile), 'browser-qa-v3.json');

const out = { startedAt: new Date().toISOString(), assertions: [], shots: [], metrics: {} };
let area = 'browser';
function ok(cond, msg, detail) {
  out.assertions.push({ area, ok: !!cond, msg, ...(cond ? {} : { detail }) });
  console.log(`${cond ? '✅' : '❌'} [${area}] ${msg}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 1200) : ''}`);
  return !!cond;
}
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
const MEASURE = (cmids) => `(() => {
  const CM = ${JSON.stringify(cmids)};
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const visible = (el) => { const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const inClosed = (el) => { for (let e = el; e; e = e.parentElement) { if (e.tagName === 'DETAILS' && !e.open) return true; if (e.getAttribute && e.getAttribute('aria-hidden') === 'true') return true; if (e.hidden) return true; } return false; };
  const res = { scrollW: document.documentElement.scrollWidth, innerW: innerWidth, bodyScrollW: document.body.scrollWidth,
    textEls: 0, mediaPlayerTexts: 0, metaChips: 0, small: [], lowContrast: [], clipped: [], internalScroll: [], hiddenText: [], cursiaText: '', missingCms: [] };
  for (const [cmid, kind] of CM) {
    const li = document.getElementById('module-' + cmid);
    if (!li) { res.missingCms.push(cmid); continue; }
    const roots = [...li.querySelectorAll('.activity-altcontent, .activity-description, .contentafterlink')];
    for (const root of roots) {
      // Scroll horizontal interno (p.ej. .no-overflow de Boost con contenido más ancho que la columna).
      root.querySelectorAll('*').forEach((e) => { const s = getComputedStyle(e); if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && e.scrollWidth > e.clientWidth + 1) res.internalScroll.push({ cmid, tag: e.tagName, cls: String(e.className).slice(0, 60), sw: e.scrollWidth, cw: e.clientWidth }); });
      if (getComputedStyle(root).overflowX !== 'visible' && root.scrollWidth > root.clientWidth + 1) res.internalScroll.push({ cmid, tag: root.tagName, cls: String(root.className).slice(0, 60), sw: root.scrollWidth, cw: root.clientWidth });
      res.cursiaText += '\\n' + root.innerText;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.nodeValue.trim()) continue;
        const el = n.parentElement;
        if (!el || seen.has(el) || el.closest('script,style,noscript,iframe')) continue;
        // Reproductor multimedia de Moodle (filtro mediaplugin / video.js sobre el <audio> del shell): UI de Moodle
        // en el idioma del sitio, con textos a11y visualmente ocultos por diseño. No es texto de Cursia.
        if (el.closest('.mediaplugin, .video-js, audio, video')) { res.mediaPlayerTexts++; continue; }
        seen.add(el);
        const txt = n.nodeValue.trim().slice(0, 50);
        if (inClosed(el)) continue;
        if (!visible(el)) { if (!el.closest('.cursia-iv-inline')) res.hiddenText.push({ cmid, txt }); continue; }
        res.textEls++;
        const s = getComputedStyle(el);
        const fs = parseFloat(s.fontSize);
        const nav = !!el.closest('.cursia-iv-fallback, .cursia-iv-open, .activity-instance, .activity-information');
        // .cvc-meta = chip/eyebrow de un componente ("Dato", "Para reflexionar", "Pregunta N"): metadato, no texto
        // pedagógico. Se exige ≥ 14 px y se cuenta aparte (hallazgo para el dueño, ver reporte R13).
        const meta = !!el.closest('.cvc-meta');
        if (meta) { res.metaChips++; if (fs < 14) res.small.push({ cmid, kind, fs, txt, meta: true }); }
        else if (fs < 16 && !nav) res.small.push({ cmid, kind, fs, txt });
        const fg = parse(s.color); const bg = bgOf(el);
        if (fg) { const cr = ratio({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) }, bg); if (cr < 4.5) res.lowContrast.push({ cmid, kind, cr: Math.round(cr * 100) / 100, fg: s.color, bg: [bg.r, bg.g, bg.b].join(','), txt }); }
        // Texto recortado: el elemento (o su contenedor con overflow hidden/clip) es más chico que su contenido.
        for (let e = el; e && e !== root.parentElement; e = e.parentElement) {
          const cs = getComputedStyle(e);
          if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && e.scrollWidth > e.clientWidth + 1) { res.clipped.push({ cmid, txt, tag: e.tagName, sw: e.scrollWidth, cw: e.clientWidth }); break; }
          if ((cs.overflowY === 'hidden' || cs.overflowY === 'clip') && e.scrollHeight > e.clientHeight + 2 && cs.textOverflow !== 'clip') { res.clipped.push({ cmid, txt, tag: e.tagName, sh: e.scrollHeight, ch: e.clientHeight, axis: 'y' }); break; }
        }
      }
    }
  }
  res.small = res.small.slice(0, 40); res.lowContrast = res.lowContrast.slice(0, 40); res.clipped = res.clipped.slice(0, 40); res.hiddenText = res.hiddenText.slice(0, 40);
  return res;
})()`;

let server = null;
let browser = null;
let forcecleanTouched = false;
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
};

async function main() {
  const creds = readCreds(CREDS);
  const courses = ['E1', 'E2'].map((k) => ({ key: k, moodle: R.moodle[k], info: R.courses[k] }));
  for (const c of courses) {
    if (!c.moodle || !c.moodle.courseid) throw new Error(`sin curso Moodle restaurado para ${c.key}`);
    const en = vm('enrol', String(c.moodle.courseid), creds.username);
    ok(en.enrolled === true, `${c.key}: estudiante local de prueba matriculado en el curso #${c.moodle.courseid}`, en);
  }
  if (await portInUse(8099)) { ok(false, 'puerto 8099 libre para el servidor PHP desechable'); return; }
  const logPath = path.join(SHOTS, 'php-server.log');
  server = spawn(PHP, ['-c', PHPINI, '-S', '127.0.0.1:8099', '-t', SRC], { stdio: ['ignore', fs.openSync(logPath, 'w'), fs.openSync(logPath, 'a')] });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { await sleep(200); up = await portInUse(8099); }
  if (!ok(up, 'servidor PHP desechable en 127.0.0.1:8099 (solo durante el QA)')) return;
  browser = await launchChrome();
  const b = browser;
  await b.setViewport(1280, 900, false);
  if (!ok(await login(b, creds), 'login del estudiante local de prueba')) return;

  const pageMetrics = async (c, width, label, mobile = false) => {
    await b.setViewport(width, 900, mobile);
    await b.navigate(`${WWW}/course/view.php?id=${c.moodle.courseid}`);
    await sleep(1200);
    const cmids = c.moodle.cms.filter((x) => x.idnumber && (x.modname === 'label' || x.modname === 'h5pactivity')).map((x) => [x.cmid, x.idnumber]);
    const m = await b.evaluate(MEASURE(cmids));
    const shot = path.join(SHOTS, `${c.key}-${label}.png`);
    await b.screenshot(shot, { fullPage: true });
    out.shots.push(shot);
    return m;
  };

  for (const c of courses) {
    const theme = c.key === 'E1' ? 'aula-clara/light' : 'oscuro-premium/dark';
    for (const width of [390, 768, 1280]) {
      area = `browser-${c.key}`;
      const m = await pageMetrics(c, width, `${width}`);
      out.metrics[`${c.key}-${width}`] = { scrollW: m.scrollW, innerW: m.innerW, textEls: m.textEls, metaChips14px: m.metaChips, mediaPlayerTextsSkipped: m.mediaPlayerTexts, small: m.small.length, lowContrast: m.lowContrast.length, clipped: m.clipped.length, internalScroll: m.internalScroll.length, hidden: m.hiddenText.length };
      const tag = `${c.key} (${theme}) @${width}`;
      eq0(m.missingCms, `${tag}: todas las actividades Cursia presentes en la página`);
      ok(m.scrollW <= m.innerW && m.bodyScrollW <= m.innerW, `${tag}: 0 overflow horizontal de la página (scrollWidth ${m.scrollW} ≤ ${m.innerW})`, { scrollW: m.scrollW, body: m.bodyScrollW, innerW: m.innerW });
      eq0(m.internalScroll, `${tag}: 0 scroll horizontal dentro de los labels`);
      eq0(m.clipped, `${tag}: 0 textos recortados`);
      eq0(m.hiddenText, `${tag}: 0 textos pedagógicos ocultos (fuera de acordeones/revelar cerrados)`);
      ok(m.textEls > 50, `${tag}: ${m.textEls} elementos de texto medidos`);
      eq0(m.small, `${tag}: texto pedagógico ≥ 16 px`);
      eq0(m.lowContrast, `${tag}: contraste WCAG ≥ 4.5 en todo el texto`);
      const enW = englishIn(m.cursiaText);
      eq0(enW, `${tag}: contenido Cursia solo en español (sin textos por defecto en inglés)`);
      // Enlace de respaldo visible en cada video.
      const vids = c.moodle.cms.filter((x) => /:video$/.test(x.idnumber || ''));
      const fb = await b.evaluate(`(()=>${JSON.stringify(vids.map((v) => v.cmid))}.map(id=>{const li=document.getElementById('module-'+id);const a=li&&li.querySelector('.cursia-iv-open a');const y=li&&li.querySelector('.cursia-iv-fallback a');const r=a&&a.getBoundingClientRect();return {id,open:!!a&&r.width>0&&r.height>0&&getComputedStyle(a).visibility!=='hidden',href:a&&a.getAttribute('href'),yt:!!y&&y.getBoundingClientRect().width>0}}))()`);
      ok(vids.length > 0 && fb.every((x) => x.open && /\/mod\/h5pactivity\/view\.php\?id=\d+/.test(x.href) && x.yt), `${tag}: enlace de respaldo visible en los ${vids.length} videos (→ view.php de la actividad + YouTube)`, fb);
    }
    // IV inline: carga diferida + reproduce (1280).
    area = `browser-${c.key}`;
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
    ok(yt.handler === 'YouTube' && Math.abs(yt.dur - 468) <= 2, `${c.key}: el reproductor YouTube (IdwOipZAeqY) se inicializa con la duración real ≈ 468 s`, yt);
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

  // Emulación móvil real a 390 (sanity).
  area = 'browser-mobile';
  {
    const c = courses[0];
    const m = await pageMetrics(c, 390, 'mobile-emulated-390', true);
    ok(m.scrollW <= m.innerW, `E1 móvil emulado 390 (mobile:true): 0 overflow horizontal (${m.scrollW} ≤ ${m.innerW})`, m.scrollW);
    eq0(m.clipped, 'E1 móvil emulado 390: 0 textos recortados');
    eq0(m.small, 'E1 móvil emulado 390: texto pedagógico ≥ 16 px');
    await b.setViewport(1280, 900, false);
  }

  // H5P respondido en el reproductor real → nota en el gradebook.
  area = 'browser-h5p-grade';
  {
    let target = null;
    for (const key of ['E1', 'E3']) {
      const mc = R.moodle[key];
      if (!mc) continue;
      for (const x of mc.cms.filter((y) => /:activity$/.test(y.idnumber || '') && y.modname === 'h5pactivity')) {
        const chId = x.idnumber.split(':')[2];
        const t = require(path.join(REPO, 'dist/modules/course-shell/index.js')).activityTypeForChapter(chId);
        if (!target || (t === 'questionset' && target.type !== 'questionset')) target = { key, courseid: mc.courseid, cmid: x.cmid, type: t };
      }
    }
    ok(!!target, `actividad H5P elegida para responder: ${target && `${target.key} ${target.type} (cm ${target.cmid})`}`);
    if (target && target.key !== 'E1' && target.key !== 'E2') vm('enrol', String(target.courseid), creds.username);
    await b.navigate(`${WWW}/mod/h5pactivity/view.php?id=${target.cmid}`);
    const lib = await b.waitFor(inH5p(`return inst.libraryInfo.versionedName;`), { timeoutMs: 30000, what: 'H5P' }).catch((e) => e.message);
    ok(/^H5P\.(QuestionSet|DragText|Blanks) /.test(String(lib)), `reproductor real carga ${lib}`, lib);
    let answered = true;
    try { await FLOWS[target.type](b); } catch (e) { answered = ok(false, `respondido a través del DOM (${target.type})`, e.message); }
    if (answered) ok(true, `respondido a través del DOM (${target.type}, todas correctas)`);
    await sleep(3000);
    const shot = path.join(SHOTS, `h5p-${target.type}-answered.png`);
    await b.screenshot(shot);
    out.shots.push(shot);
    const vis = await b.evaluate(inH5p(`return d.body.innerText;`)).catch(() => '');
    eq0(englishIn(vis), `reproductor ${target.type}: sin textos por defecto en inglés`);
    const st = vm('state', String(target.courseid), String(target.cmid), creds.username);
    ok(st.attempts.length === 1 && st.grade === 100 && st.completion === 'COMPLETE_PASS', 'DB: 1 intento, nota 100, COMPLETE_PASS', { attempts: st.attempts, grade: st.grade, completion: st.completion });
    await b.navigate(`${WWW}/grade/report/user/index.php?id=${target.courseid}`);
    await sleep(1000);
    const gb = await b.evaluate(`(()=>{const rows=[...document.querySelectorAll('table.user-grade tr')];const r=rows.find(x=>/h5pactivity/.test(x.innerHTML)&&/100[.,]00/.test(x.innerText));return {found:!!r,text:r?r.innerText.replace(/\\s+/g,' ').slice(0,200):null,rows:rows.length}})()`);
    ok(gb.found, 'gradebook del estudiante (grade/report/user): la nota 100 de la actividad aparece', gb);
    const shot2 = path.join(SHOTS, 'gradebook-after-h5p.png');
    await b.screenshot(shot2, { fullPage: true });
    out.shots.push(shot2);
    out.metrics.h5pGrade = { target, grade: st.grade, completion: st.completion };
  }

  // forceclean=1 TEMPORAL: completitud del texto (CLEAN_SAFE) + enlaces de respaldo.
  area = 'browser-forceclean';
  const KEY_TEXTS = ['Fuerza que el fluido ejerce sobre cada superficie del circuito.', 'Ruido anormal, temperatura elevada y respuesta lenta de los actuadores.', 'Pérdidas internas o un enfriamiento insuficiente del circuito.', '¿Qué señal de tu equipo pasarías por alto si trabajaras con prisa?'];
  const fc0 = cfg('forceclean');
  ok(fc0 === '0' || fc0 === '', `forceclean inicial = 0 (leído con admin/cli/cfg.php: "${fc0}")`);
  try {
    forcecleanTouched = true;
    cfg('forceclean', '1');
    purge();
    ok(cfg('forceclean') === '1', 'forceclean=1 aplicado temporalmente + caches purgadas');
    for (const c of courses) {
      for (const width of [390, 1280]) {
        await b.setViewport(width, 900, false);
        await b.navigate(`${WWW}/course/view.php?id=${c.moodle.courseid}`);
        await sleep(1000);
        const r = await b.evaluate(`(()=>{const t=document.body.innerText;return {has:${JSON.stringify(KEY_TEXTS)}.map(s=>t.includes(s)),iframes:document.querySelectorAll('.cursia-iv-inline iframe').length,scripts:[...document.querySelectorAll('.activity-altcontent script, .activity-description script')].length,scrollW:document.documentElement.scrollWidth,innerW:innerWidth}})()`);
        const nCh = c.info.modules.flatMap((m) => m.chapters).length;
        const counts = await b.evaluate(`(()=>{const t=document.body.innerText;return ${JSON.stringify(KEY_TEXTS)}.map(s=>t.split(s).length-1)})()`);
        ok(r.has.every(Boolean) && counts.every((n) => n >= 1), `${c.key} @${width} forceclean=1: el texto pedagógico de acordeones/autoevaluación/tarjetas queda VISIBLE (CLEAN_SAFE)`, { has: r.has, counts });
        ok(r.iframes === 0 && r.scripts === 0, `${c.key} @${width} forceclean=1: sin iframe ni script en los labels (Moodle los elimina)`, r);
        ok(r.scrollW <= r.innerW, `${c.key} @${width} forceclean=1: 0 overflow horizontal`, r);
        const vids = c.moodle.cms.filter((x) => /:video$/.test(x.idnumber || ''));
        const fb = await b.evaluate(`(()=>${JSON.stringify(vids.map((v) => v.cmid))}.map(id=>{const li=document.getElementById('module-'+id);const as=li?[...li.querySelectorAll('.activity-altcontent a, .activity-description a')]:[];const v=as.find(a=>/h5pactivity\\/view\\.php\\?id=/.test(a.href));const y=as.find(a=>/youtube\\.com\\/watch\\?v=IdwOipZAeqY/.test(a.href));const vis=(a)=>!!a&&a.getBoundingClientRect().width>0;return {id,view:vis(v),yt:vis(y)}}))()`);
        ok(fb.every((x) => x.view && x.yt), `${c.key} @${width} forceclean=1: enlace de respaldo visible en cada video (actividad + YouTube)`, fb);
        const shot = path.join(SHOTS, `${c.key}-forceclean-${width}.png`);
        await b.screenshot(shot, { fullPage: true });
        out.shots.push(shot);
      }
    }
  } finally {
    // SIEMPRE se vuelve a forceclean=0 (también si algo falló arriba).
    try { cfg('forceclean', '0'); purge(); } catch (e) { console.error('ERROR restaurando forceclean', e.message); }
    const back = cfg('forceclean');
    out.forcecleanRestored = back;
    ok(back === '0', `forceclean restaurado a 0 (leído: "${back}")`);
  }
  const phpErr = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => /PHP (Fatal|Parse) error/.test(l));
  eq0(phpErr, 'servidor PHP: sin errores fatales');
}
function eq0(arr, msg) { return ok(Array.isArray(arr) && arr.length === 0, msg, arr); }

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
    setTimeout(() => process.exit(out.totals.failed ? 1 : 0), 1500).unref();
  });
