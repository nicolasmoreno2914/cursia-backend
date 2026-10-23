// R2 (Cursia V2.1) — QA visual de Visual Components en Chrome headless (CDP).
//
// Construye una galería estática por tema (claros: aula-clara, institucional, editorial,
// vibrante, tecnico-light; oscuros: oscuro-premium, tecnico-dark), en ENHANCED y en
// CLEAN_SAFE (= el ENHANCED pasado por purify_html() real de Moodle), con tres páginas por
// combinación: componentes (16 tipos + variantes de callout), textos largos (palabras de 400
// caracteres) y el capítulo completo (6 movimientos). Mide a 390 / 768 / 1280 px:
//   - 0 desborde horizontal (scrollingElement.scrollWidth <= innerWidth);
//   - ningún texto recortado (overflow ≠ visible con scrollWidth > clientWidth + 1) ni de tamaño 0;
//   - font-size computado ≥ 16 px en texto pedagógico (.cvc-meta ≥ 13);
//   - contraste WCAG (color vs fondo opaco más cercano, getComputedStyle) ≥ 4.5;
//   - sin JS / CLEAN_SAFE: todo el texto visible.
// ENHANCED además: tabs y revelados operables con teclado (CDP Input.dispatchKeyEvent) y todo
// el contenido presente con JS deshabilitado (Emulation.setScriptExecutionDisabled).
// Guarda PNGs en OUT_DIR, imprime una tabla y sale ≠ 0 ante cualquier fallo.
//
// Uso: node scripts/visual/vc-gallery.mjs   (requiere npm run build + Moodle local)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const vc = require(path.join(repo, 'dist/modules/visual-components/index.js'));
const te = require(path.join(repo, 'dist/modules/theme-engine/index.js'));
const F = require(path.join(repo, 'scripts/lib/v21-vc-fixtures.js'));
const { purifyMany } = require(path.join(repo, 'scripts/lib/v21-moodle-purify.js'));

const OUT =
  process.env.OUT_DIR ||
  '/private/tmp/claude-501/-Users-nicolas-Documents-Claude-course-gen/c3707ccd-9a84-4474-8052-2f6dfeb251b1/scratchpad/v21/visual/r2';
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// mobile:false en TODOS los anchos (fix round 1 / I2): con mobile:true Chrome ensancha el
// layout viewport hasta el contenido y un desborde a 390 px deja de ser detectable.
const WIDTHS = [
  [390, 844, false],
  [768, 1024, false],
  [1280, 900, false],
];
const SHOT_SLICE = 8000;
const SHOT_MAX_SLICES = 4;
mkdirSync(path.join(OUT, 'pages'), { recursive: true });
// sin capturas viejas mezcladas con las de esta corrida
for (const f of readdirSync(OUT)) if (f.endsWith('.png')) rmSync(path.join(OUT, f));

// ─── Galería ────────────────────────────────────────────────────────────────
function page(title, labels) {
  const body = labels
    .map((l) => `<section class="gal-label" data-name="${l.name}" style="margin:0 0 24px 0">${l.html}</section>`)
    .join('\n');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;padding:12px;background:#FFFFFF;color:#1A1A1A}</style></head><body>${body}</body></html>`;
}

const components = F.loadComponents();
const chapter = F.buildExperience();
const pages = [];
const toPurify = [];
for (const combo of F.THEME_COMBOS) {
  const theme = te.resolveTheme(combo);
  const tl = F.themeLabel(combo);
  const sets = {
    componentes: components.map((c, i) => ({ name: F.fixtureName(c), list: [c], uid: `g${i}` })),
    largos: components.map((c, i) => ({ name: `${F.fixtureName(c)}-largo`, list: [F.longVariant(c)], uid: `l${i}` })),
    capitulo: Object.entries(chapter.movements).map(([mv, list]) => ({ name: mv, list, uid: `c-${mv.replace('_', '-')}` })),
  };
  for (const [kind, labels] of Object.entries(sets)) {
    const enh = labels.map((l) => ({ name: l.name, html: vc.renderMovement(l.list, theme, { uid: l.uid, level: 'enhanced' }) }));
    pages.push({ id: `${tl}-${kind}-enhanced`, theme: tl, kind, level: 'enhanced', labels: enh });
    const clean = { id: `${tl}-${kind}-clean_safe`, theme: tl, kind, level: 'clean_safe', labels: enh.map((l) => ({ name: l.name, html: null })) };
    enh.forEach((l, i) => toPurify.push({ page: clean, i, html: l.html }));
    pages.push(clean);
    // nivel CLEAN_SAFE propio del renderer (sin ENHANCED), tal cual (M8)
    pages.push({ id: `${tl}-${kind}-clean_raw`, theme: tl, kind, level: 'clean_raw', labels: labels.map((l) => ({ name: l.name, html: vc.renderMovement(l.list, theme, { uid: l.uid }) })) });
  }
}
const purified = purifyMany(toPurify.map((x) => x.html));
toPurify.forEach((x, k) => (x.page.labels[x.i].html = purified[k]));
for (const p of pages) {
  p.file = path.join(OUT, 'pages', `${p.id}.html`);
  writeFileSync(p.file, page(p.id, p.labels));
}

// ─── Chrome / CDP ───────────────────────────────────────────────────────────
const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
let PORT = await freePort();
if (PORT === 9334) PORT = await freePort();
const profile = path.join(OUT, '.chrome-profile');
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, 'about:blank'],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
const pending = new Map();
let seq = 0;
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalv = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
};
async function key(k, code, vk) {
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if (k === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(60);
}
async function load(url) {
  // pasar por about:blank evita la restauración de scroll de una recarga de la misma URL
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(30);
  await send('Page.navigate', { url });
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    try {
      if ((await evalv('document.readyState')) === 'complete') break;
    } catch (e) {}
  }
  await sleep(80);
}

// Medición en la página. mode: 'js' (ENHANCED con JS), 'static' (CLEAN_SAFE o sin JS: todo visible).
const MEASURE = (mode, VIEW_W) => `(() => {
  const mode = ${JSON.stringify(mode)};
  const lum = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const L = (c) => 0.2126 * lum(c.r) + 0.7152 * lum(c.g) + 0.0722 * lum(c.b);
  const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a >= 1) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const vw = document.documentElement.clientWidth;
  const out = { hscroll: document.scrollingElement.scrollWidth > vw || innerWidth !== ${VIEW_W}, scrollW: document.scrollingElement.scrollWidth, innerW: innerWidth, vw,
    rootsOver: [...document.querySelectorAll('.cvc')].filter((r) => r.getBoundingClientRect().right > vw + 0.5).map((r) => r.closest('.gal-label')?.dataset.name),
    texts: 0, uiTexts: 0, hiddenBad: [], small: [], lowContrast: [], clipped: [], zero: [], offscreen: [], allowedHidden: 0 };
  const roots = [...document.querySelectorAll('.cvc')];
  const clipChecked = new Set();
  for (const root of roots) {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const txt = n.nodeValue.replace(/[\\u00AD\\u200B]/g, '').trim();
      if (!txt) continue;
      const el = n.parentElement;
      if (el.closest('style,script')) continue;
      // el texto de los botones de tab lo crea el runtime (duplica la etiqueta del panel): se mide, pero no se cuenta
      if (el.closest('.cvc-tablist, .cvc-cmp-full')) out.uiTexts++; else out.texts++;
      const label = el.closest('.gal-label')?.dataset.name + ' «' + txt.slice(0, 30) + '»';
      const visible = el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: false });
      if (!visible) {
        const allowed = mode === 'js' && (el.closest('[role=tabpanel][hidden]') || el.closest('.cvc-tablabel[hidden]') || (el.closest('details:not([open])') && !el.closest('summary')) || el.closest('.cvc-cmp-full') || el.closest('.cvc-js .cvc-cmp-stack'));
        if (allowed) { out.allowedHidden++; continue; }
        out.hiddenBad.push(label); continue;
      }
      const range = document.createRange(); range.selectNodeContents(n);
      const rects = [...range.getClientRects()];
      if (!rects.length || rects.every((r) => r.width < 1 || r.height < 1)) { out.zero.push(label); continue; }
      const right = Math.max(...rects.map((r) => r.right + scrollX));
      if (!el.closest('.cvc-scroll') && (right > document.scrollingElement.scrollWidth + 1 || right > vw + 1)) out.offscreen.push(label + ' right=' + Math.round(right));
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize);
      const meta = !!el.closest('.cvc-meta');
      if (fs < (meta ? 13 : 16)) out.small.push(label + ' ' + fs + 'px');
      const fg = parse(cs.color);
      const cr = ratio(fg, bgOf(el));
      if (cr < 4.5) out.lowContrast.push(label + ' ' + cr.toFixed(2));
      for (let e = el; e && e !== root.parentElement; e = e.parentElement) {
        if (clipChecked.has(e)) continue; clipChecked.add(e);
        const s = getComputedStyle(e);
        const clips = s.overflowX !== 'visible' || s.overflowY !== 'visible';
        if (clips && !e.matches('.cvc-scroll[role=region]') && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)) out.clipped.push(label + ' <' + e.tagName.toLowerCase() + '>');
      }
    }
  }
  out.tabsBoxes = root_count('.cvc-tabs'); out.tablists = root_count('[role=tablist]');
  out.detailsTotal = root_count('details'); out.detailsOpen = root_count('details[open]');
  function root_count(sel) { return document.querySelectorAll(sel).length; }
  return out;
})()`;

const rows = [];
const failures = [];
function record(row) {
  rows.push(row);
  if (!row.pass) failures.push(row);
}

async function shoot(name) {
  await evalv('window.scrollTo(0, 0); true');
  const m = await send('Page.getLayoutMetrics');
  const width = Math.ceil(m.cssContentSize.width);
  const height = Math.ceil(m.cssContentSize.height);
  const slices = Math.min(SHOT_MAX_SLICES, Math.ceil(height / SHOT_SLICE));
  const files = [];
  for (let s = 0; s < slices; s++) {
    const y = s * SHOT_SLICE;
    const h = Math.min(SHOT_SLICE, height - y);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width, height: h, scale: 1 } });
    const f = `${name}${slices > 1 ? `-${s + 1}` : ''}.png`;
    writeFileSync(path.join(OUT, f), Buffer.from(shot.data, 'base64'));
    files.push(f);
  }
  return files;
}

function summarize(m) {
  const probs = [];
  if (m.hscroll) probs.push(`hscroll scrollWidth=${m.scrollW} viewport=${m.vw} innerWidth=${m.innerW}`);
  if (m.rootsOver.length) probs.push(`labels más anchos que el viewport: ${m.rootsOver.slice(0, 3).join(', ')}`);
  for (const k of ['hiddenBad', 'zero', 'small', 'lowContrast', 'clipped', 'offscreen']) if (m[k].length) probs.push(`${k}:${m[k].length} (${m[k].slice(0, 2).join(' | ')})`);
  return probs;
}

// Comparaciones de > 2 columnas con JS: tabla completa en región accesible en pantallas anchas,
// versión apilada en angostas; siempre exactamente una de las dos visible.
async function comparisonChecks(w) {
  const r = await evalv(`[...document.querySelectorAll('.cvc-cmp-stack')].map((st) => { const full = st.parentNode.querySelector('.cvc-cmp-full');
    return { full: !!full, fullVis: !!full && full.checkVisibility(), stackVis: st.checkVisibility(), region: !!full && full.getAttribute('role') === 'region' && full.tabIndex === 0 && !!full.getAttribute('aria-label'),
      cols: full ? full.querySelectorAll('thead th').length : 0 }; })`);
  const probs = [];
  if (!r.length) probs.push('sin comparaciones apiladas en la página');
  for (const c of r) {
    if (!c.full || !c.region) probs.push(`tabla ENHANCED ausente o sin región accesible ${JSON.stringify(c)}`);
    const wide = w >= 720;
    if (c.fullVis !== wide || c.stackVis === wide) probs.push(`visibilidad tabla/apilado incorrecta a ${w}px ${JSON.stringify(c)}`);
  }
  return probs;
}

// Pruebas de teclado sobre la página ENHANCED (JS activo).
async function keyboardChecks() {
  const probs = [];
  const st = () =>
    evalv(`(() => { const box = document.querySelector('.cvc-tabs'); if (!box) return null; const tabs = [...box.querySelectorAll('[role=tab]')];
      const panels = [...box.querySelectorAll(':scope > .cvc-tabpanel')];
      return { n: tabs.length, sel: tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true'), focus: tabs.indexOf(document.activeElement),
        shown: panels.map((p) => !p.hidden), roles: panels.every((p) => p.getAttribute('role') === 'tabpanel' && p.getAttribute('aria-labelledby')) }; })()`);
  await evalv(`document.querySelector('.cvc-tabs [role=tab]').focus(); true`);
  let s = await st();
  if (!s || s.n < 2 || s.sel !== 0 || s.focus !== 0 || !s.roles) probs.push(`tabs init ${JSON.stringify(s)}`);
  await key('ArrowRight', 'ArrowRight', 39);
  s = await st();
  if (s.sel !== 1 || s.focus !== 1 || !s.shown[1] || s.shown[0]) probs.push(`tabs ArrowRight ${JSON.stringify(s)}`);
  await key('End', 'End', 35);
  s = await st();
  if (s.sel !== s.n - 1 || s.focus !== s.n - 1) probs.push(`tabs End ${JSON.stringify(s)}`);
  await key('ArrowRight', 'ArrowRight', 39);
  s = await st();
  if (s.sel !== 0 || s.focus !== 0) probs.push(`tabs wrap ${JSON.stringify(s)}`);
  await key('ArrowLeft', 'ArrowLeft', 37);
  await key('Home', 'Home', 36);
  s = await st();
  if (s.sel !== 0 || s.focus !== 0) probs.push(`tabs Home ${JSON.stringify(s)}`);

  for (const sel of ['details.cvc-reveal', 'details.cvc-selfcheck', 'details.cvc-myth', 'details.cvc-hint']) {
    const before = await evalv(`(() => { const d = document.querySelector('${sel}'); if (!d) return null; d.querySelector('summary').focus(); return { open: d.open, focused: document.activeElement === d.querySelector('summary') }; })()`);
    if (!before) {
      probs.push(`${sel} ausente`);
      continue;
    }
    if (before.open || !before.focused) probs.push(`${sel} init ${JSON.stringify(before)}`);
    await key('Enter', 'Enter', 13);
    const after = await evalv(`document.querySelector('${sel}').open`);
    if (!after) probs.push(`${sel} Enter no abrió`);
    await key('Enter', 'Enter', 13);
    const again = await evalv(`document.querySelector('${sel}').open`);
    if (again) probs.push(`${sel} Enter no cerró`);
  }
  // Espacio también alterna (patrón de botón)
  await evalv(`document.querySelector('details.cvc-selfcheck summary').focus(); true`);
  await key(' ', 'Space', 32);
  if (!(await evalv(`document.querySelector('details.cvc-selfcheck').open`))) probs.push('Espacio no abrió el revelado');
  await key(' ', 'Space', 32);
  // todas las instancias de tabs quedan operables (no solo la primera)
  const allTabs = await evalv(`[...document.querySelectorAll('.cvc-tabs')].map((b) => ({ n: b.querySelectorAll('[role=tab]').length, named: !!(b.querySelector('[role=tablist]').getAttribute('aria-labelledby') || b.querySelector('[role=tablist]').getAttribute('aria-label')) }))`);
  if (!allTabs.length || allTabs.some((t) => t.n < 2 || !t.named)) probs.push(`tablists sin nombre o incompletos ${JSON.stringify(allTabs)}`);
  const acc = await evalv(`(() => { const ds = [...document.querySelectorAll('details.cvc-acc')]; return ds.map((d) => d.open); })()`);
  if (!acc.length || !acc[0] || acc.slice(1).some(Boolean)) probs.push(`accordion estado inicial ${JSON.stringify(acc)}`);
  const idem = await evalv(`(() => { const n = document.querySelectorAll('[role=tablist]').length; for (const r of document.querySelectorAll('[data-cvc-uid]')) window.CursiaVC.init(r.getAttribute('data-cvc-uid')); return n === document.querySelectorAll('[role=tablist]').length; })()`);
  if (!idem) probs.push('runtime no idempotente');
  return probs;
}

try {
  ws = new WebSocket(
    await (async () => {
      for (let i = 0; i < 100; i++) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
          const p = list.find((t) => t.type === 'page');
          if (p) return p.webSocketDebuggerUrl;
        } catch (e) {}
        await sleep(100);
      }
      throw new Error('Chrome CDP no respondió');
    })(),
  );
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  for (const p of pages) {
    const url = pathToFileURL(p.file).href;
    for (const [w, h, mobile] of WIDTHS) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      await send('Emulation.setScriptExecutionDisabled', { value: false });
      await load(url);
      const mode = p.level === 'enhanced' ? 'js' : 'static';
      const m = await evalv(MEASURE(mode, w));
      const probs = summarize(m);
      if (p.level === 'enhanced' && m.tablists !== m.tabsBoxes) probs.push(`tablists ${m.tablists}/${m.tabsBoxes}`);
      if (p.level !== 'enhanced' && (m.tablists || m.detailsTotal)) probs.push('capa enhanced en CLEAN_SAFE');
      if (p.level === 'enhanced' && p.kind === 'componentes') probs.push(...(await comparisonChecks(w)));
      const files = await shoot(`${p.id}-${w}`);
      if (p.level === 'enhanced' && p.kind === 'componentes' && w === 1280) probs.push(...(await keyboardChecks()));
      record({ page: p.id, w, mode: p.level === 'enhanced' ? 'enhanced+js' : p.level, texts: m.texts, hidden: m.allowedHidden, pass: probs.length === 0, probs, png: files[0] });

      if (p.level === 'enhanced') {
        await send('Emulation.setScriptExecutionDisabled', { value: true });
        await load(url);
        const n = await evalv(MEASURE('static', w));
        const probs2 = summarize(n);
        if (n.tablists !== 0) probs2.push('tablist sin JS');
        if (n.detailsOpen !== n.detailsTotal) probs2.push(`details cerrados sin JS ${n.detailsOpen}/${n.detailsTotal}`);
        if (n.texts !== m.texts) probs2.push(`texto sin JS ${n.texts} ≠ con JS ${m.texts}`);
        const files2 = w === 390 ? await shoot(`${p.id}-nojs-${w}`) : [];
        record({ page: p.id, w, mode: 'enhanced-nojs', texts: n.texts, hidden: 0, pass: probs2.length === 0, probs: probs2, png: files2[0] || '' });
        await send('Emulation.setScriptExecutionDisabled', { value: false });
      }
    }
  }
  // Control negativo (I2): una tabla ancha conocida a 390 px DEBE detectarse como desborde.
  const ctrl = path.join(OUT, 'pages', '_control-overflow.html');
  writeFileSync(ctrl, page('control', [{ name: 'control', html: '<div class="cvc" style="background-color:#FAFAFA;color:#111111"><table style="border-collapse:collapse;width:100%"><tr>' + Array.from({ length: 5 }, () => '<td style="border:1px solid #333333;padding:8px">Interdepartamentalidad</td>').join('') + '</tr></table></div>' }]));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await load(pathToFileURL(ctrl).href);
  const cm = await evalv(MEASURE('static', 390));
  const detected = summarize(cm).length > 0;
  record({ page: '_control-overflow (debe detectarse)', w: 390, mode: 'control', texts: cm.texts, hidden: 0, pass: detected, probs: detected ? [] : ['el check NO detectó una tabla que desborda a 390 px'], png: '' });
} finally {
  try {
    ws && ws.close();
  } catch (e) {}
  chrome.kill();
}

// ─── Reporte ────────────────────────────────────────────────────────────────
writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 2));
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('página', 44)} ${pad('ancho', 5)} ${pad('modo', 14)} ${pad('textos', 6)} resultado`);
for (const r of rows) {
  console.log(`${pad(r.page, 44)} ${pad(r.w, 5)} ${pad(r.mode, 14)} ${pad(r.texts, 6)} ${r.pass ? '✅' : '❌ ' + r.probs.join('; ')}`);
}
console.log(`\n${rows.length} mediciones, ${failures.length} con fallos. PNGs en ${OUT}`);
process.exit(failures.length ? 1 : 0);
