#!/usr/bin/env node
/* eslint-disable */
// #583 QUAL — QA en navegador real (Chrome headless, CDP) de los H5P que cambió el bloque QUAL. NO es un check del
// runner (necesita Chrome, el core H5P del Moodle local y las librerías del perfil): se corre a mano o en el gate.
//
//  1. DragText a 390 px de ancho, con el viewport de 844 px de alto Y con 664 px (Safari/Chrome reales en un teléfono
//     de 390 px dejan ~660–750 px útiles): con el PEOR caso que acepta el objetivo móvil del ejecutor (texto de
//     maxText caracteres, maxBlanks huecos y 2 distractores de wordMax caracteres), del primer hueco al final del banco
//     de palabras cabe en la pantalla; sin scroll horizontal; el banco trae respuestas + distractores. Control negativo:
//     el texto del #583 (1.250 caracteres) NO cabe.
//  2. Caso ramificado: cada final muestra SU imagen (óptimo verde, aceptable ámbar, malo rojo) con la nota mínima 70;
//     con nota mínima 80 el aceptable (70) NO aprueba → rojo y «No aprobado».
//
// Reproductor «standalone»: el core H5P del Moodle local (h5plib v128 — mismos js/css que embed.php) + las librerías
// del perfil + el content.json que construye ESTE dist. Servidor estático en 127.0.0.1:<puerto libre> (nunca 8099);
// Chrome con red solo a 127.0.0.1. Sin LLM, sin proveedores, sin Moodle corriendo.
//
// Los límites del objetivo móvil se leen del ejecutor (DYN_DRAGTEXT_MOBILE en 45-dynamic-generation-executor.js de
// CURSIA_FRONTEND_REPO) o se pasan con DT_MAX_TEXT / DT_MAX_BLANKS / DT_WORD_MAX.
//
// Uso (después de `npm run build`):
//   CURSIA_FRONTEND_REPO=<campuscloud-gen> node scripts/qa-h5p-mobile-legibility.js [--core <h5p core>] [--libs <dir>] [--shots <dir>]
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const CORE = path.resolve(opt('--core', path.join(os.homedir(), 'cursia-test-env/moodle-local/source/h5p/h5plib/v128/joubel/core')));
const LIBS = path.resolve(opt('--libs', path.join(os.homedir(), 'cursia-test-env/h5p-libs')));
const OUT = path.resolve(opt('--shots', fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-h5p-mobile-'))));
fs.mkdirSync(OUT, { recursive: true });
process.env.CURSIA_CHROME_HOST_RESOLVER_RULES = 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost';
require('reflect-metadata');
const { launchChrome, freePort, sleep } = require('./lib/v21-cdp');
const h = require(path.join(ROOT, 'dist/package/h5p/index.js'));

function mobileLimits() {
  const env = { maxText: +process.env.DT_MAX_TEXT || 0, maxBlanks: +process.env.DT_MAX_BLANKS || 0, wordMax: +process.env.DT_WORD_MAX || 0 };
  let fe = null;
  const repo = process.env.CURSIA_FRONTEND_REPO;
  if (repo) {
    const src = fs.readFileSync(path.join(repo, 'src/js/45-dynamic-generation-executor.js'), 'utf8');
    const m = /var DYN_DRAGTEXT_MOBILE = (\{[^}]+\});/.exec(src);
    if (!m) throw new Error('DYN_DRAGTEXT_MOBILE no encontrado en el ejecutor');
    fe = JSON.parse(m[1].replace(/(\w+):/g, '"$1":'));
  }
  const base = fe || { maxText: 300, maxBlanks: 5, wordMax: 14 };
  return { maxText: env.maxText || base.maxText, maxBlanks: env.maxBlanks || base.maxBlanks, wordMax: env.wordMax || base.wordMax, source: fe ? 'ejecutor' : 'por defecto' };
}

// Peor caso del objetivo: maxBlanks respuestas y 2 distractores de wordMax caracteres, texto de maxText caracteres.
function worstCase(L) {
  const word = (base) => {
    let w = base;
    while (w.length < L.wordMax) w += ' registro';
    return w.slice(0, L.wordMax).replace(/\s+$/, 'x');
  };
  const answers = ['fecha de entrega', 'código del lote', 'cantidad llegada', 'costo por unidad', 'remisión firmada', 'firma del tendero'].slice(0, L.maxBlanks).map(word);
  const distractors = [word('precio de ventas'), word('fecha de vencido')];
  const glue = ['Al recibir la mercancía, el tendero anota primero la', 'después cada producto con su', 'y también la', 'Luego escribe el', 'Antes de firmar compara todo con la', 'y deja constancia con la'];
  let text = answers.map((a, i) => `${glue[i]} *${a}*`).join(', ') + '.';
  const filler = ' Si algo no cuadra, lo registra en el margen del cuaderno y llama ese mismo día al proveedor para resolverlo sin esperar a la siguiente visita de la ruta.';
  let k = 0;
  while (text.length < L.maxText && k < filler.length) text += filler[k++];
  text = text.slice(0, L.maxText);
  return { itemKey: 'activity:qa-max', title: 'El registro del tendero', taskDescription: 'Arrastra cada término al hueco que corresponde. Dos palabras sobran.', text, distractors };
}
const DT_583 = { itemKey: 'activity:qa-583', title: 'El registro de doña Carmen', taskDescription: 'Arrastra cada término al espacio donde corresponde dentro del texto. Lee con atención el caso para entender qué dato o acción completa correctamente cada oración.',
  text: 'Cuando el distribuidor de productos de aseo llega a la tienda de doña Carmen en Pereira, ella no guarda nada antes de abrir su cuaderno. Lo primero que anota es la *fecha de recepción*, para saber exactamente qué día entró esa mercancía. Luego escribe el nombre de cada producto junto con su *referencia*, un código corto que ella misma asignó para no confundir, por ejemplo, el jabón de 100 g con el de 250 g. A continuación registra la *cantidad y unidad de medida*: no pone solo el número sino también si llegaron unidades sueltas, cajas o docenas, porque sin ese dato el registro pierde sentido. Enseguida anota el *costo de compra* por unidad, que es el precio que pagó al proveedor, diferente al precio al que después le venderá cada producto al cliente del barrio. Antes de firmar cualquier papel, doña Carmen compara su anotación con la *remisión* que trajo el distribuidor para verificar que las cantidades coincidan. Si encuentra una diferencia entre el papel y lo que llegó físicamente, registra la *discrepancia de inventario* en el margen del cuaderno y llama al proveedor ese mismo día para resolverla, porque esperar hace más difícil el reclamo.' };
const BS_INPUT = {
  itemKey: 'activity:qa-bs', title: 'La entrega que no cuadra',
  situation: 'Eres Óscar, tendero en Pereira. El distribuidor de lácteos deja la mercancía y te pide firmar rápido.',
  decisions: [
    { id: 'd1', question: 'La remisión dice 24 bolsas de leche y cuentas 20. ¿Qué haces?', options: [{ text: 'Anotas la diferencia en la remisión antes de firmar.', next: 'd2' }, { text: 'Firmas para no demorarlo y reclamas la otra semana.', next: 'end:e3' }] },
    { id: 'd2', question: 'El conductor dice que la nota no vale sin el supervisor. ¿Cómo sigues?', options: [{ text: 'Llamas al supervisor y dejas constancia escrita.', next: 'end:e1' }, { text: 'Descuentas las cuatro bolsas del próximo pago sin avisar.', next: 'end:e2' }] },
  ],
  endings: [
    { id: 'e1', quality: 'optimal', title: 'Faltante resuelto el mismo día', text: 'Tu cuaderno dice lo que hay de verdad y el distribuidor repone las bolsas.' },
    { id: 'e2', quality: 'acceptable', title: 'Cobro sin respaldo', text: 'Recuperas el dinero, pero sin constancia el distribuidor puede discutir el descuento.' },
    { id: 'e3', quality: 'poor', title: 'Pagas leche que no llegó', text: 'El cuaderno no cuadra con la nevera y pierdes el valor de las bolsas.' },
  ],
};
const BS_PATHS = { optimal: [0, 0], acceptable: [0, 1], poor: [1] };

const CORE_JS = ['js/jquery.js', 'js/h5p.js', 'js/h5p-event-dispatcher.js', 'js/h5p-x-api-event.js', 'js/h5p-x-api.js', 'js/h5p-content-type.js', 'js/h5p-confirmation-dialog.js', 'js/h5p-action-bar.js', 'js/request-queue.js', 'js/h5p-tooltip.js'];
const CORE_CSS = ['styles/h5p-fonts.css', 'styles/h5p.css', 'styles/h5p-confirmation-dialog.css', 'styles/h5p-core-button.css', 'styles/h5p-theme.css', 'styles/h5p-theme-variables.css', 'styles/h5p-tooltip.css', 'styles/h5p-table.css'];
const libDir = (d) => `${d.machineName}-${d.majorVersion}.${d.minorVersion}`;
const lib = (dir) => JSON.parse(fs.readFileSync(path.join(LIBS, dir, 'library.json'), 'utf8'));
function closure(mains) {
  const order = [];
  const seen = new Set();
  const visit = (dir) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    if (!fs.existsSync(path.join(LIBS, dir, 'library.json'))) throw new Error('librería ausente: ' + dir);
    for (const d of lib(dir).preloadedDependencies || []) visit(libDir(d));
    order.push(dir);
  };
  mains.forEach(visit);
  return order;
}
function subLibs(node, out = new Set()) {
  if (Array.isArray(node)) node.forEach((x) => subLibs(x, out));
  else if (node && typeof node === 'object') {
    if (typeof node.library === 'string' && /^[\w.]+ \d+\.\d+$/.test(node.library)) out.add(node.library.replace(' ', '-'));
    Object.values(node).forEach((v) => subLibs(v, out));
  }
  return out;
}
function page(main, content) {
  const dirs = closure([main.replace(' ', '-'), ...subLibs(content)]);
  const js = [];
  const css = [];
  for (const d of dirs) {
    const l = lib(d);
    (l.preloadedCss || []).forEach((f) => css.push(`/libs/${d}/${f.path}`));
    (l.preloadedJs || []).forEach((f) => js.push(`/libs/${d}/${f.path}`));
  }
  const integration = {
    baseUrl: '', url: '/h5p', urlLibraries: '/libs', postUserStatistics: false, ajax: {}, saveFreq: false, siteUrl: '', user: {},
    l10n: { H5P: { fullscreen: 'Pantalla completa', disableFullscreen: 'Salir', close: 'Cerrar' } }, core: { scripts: [], styles: [] }, loadedJs: [], loadedCss: [],
    contents: { 'cid-1': { library: main, jsonContent: JSON.stringify(content), fullScreen: '0', exportUrl: '', embedCode: '', resizeCode: '', mainId: 1, url: '/c/1', title: 'qa', contentUserData: [{ state: '{}' }], displayOptions: { frame: false, export: false, embed: false, copyright: false, icon: false, copy: false }, metadata: { title: 'qa', license: 'U' }, contentUrl: '/content/1', styles: [], scripts: [] } },
  };
  // Igual que el iframe del reproductor en Moodle a 390 px: 16 px de margen a cada lado.
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${CORE_CSS.map((f) => `<link rel="stylesheet" href="/core/${f}">`).join('\n')}
${css.map((f) => `<link rel="stylesheet" href="${f}">`).join('\n')}
<style>body{margin:0;background:#fff;font-family:sans-serif}.wrap{box-sizing:border-box;width:100%;padding:16px}</style>
<script>window.H5PIntegration=${JSON.stringify(integration)};</script>
${CORE_JS.map((f) => `<script src="/core/${f}"></script>`).join('\n')}
${js.map((f) => `<script src="${f}"></script>`).join('\n')}
</head><body><div class="wrap"><div class="h5p-content" data-content-id="1"></div></div></body></html>`;
}
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject' };
async function serve(routes) {
  const port = await freePort();
  if (port === 8099) throw new Error('puerto 8099 prohibido');
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    let body = routes[u] ?? null;
    let file = null;
    if (body === null && u.startsWith('/core/')) file = path.join(CORE, u.slice(6));
    if (body === null && u.startsWith('/libs/')) file = path.join(LIBS, u.slice(6));
    if (file && !u.includes('..') && fs.existsSync(file) && fs.statSync(file).isFile()) body = fs.readFileSync(file);
    if (body === null) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file || u)] || 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { srv, base: `http://127.0.0.1:${port}` };
}

let failures = 0;
let passes = 0;
function report(name, ok, detail) {
  if (ok) passes++; else failures++;
  console.log((ok ? '✅ ' : '❌ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
}
const MEASURE = `(()=>{const d=document;const z=[...d.querySelectorAll('.h5p-drag-text [class*=dropzone]')].filter(e=>e.getBoundingClientRect().height>0&&!e.querySelector('[class*=dropzone]'));
  const g=[...d.querySelectorAll('.h5p-drag-text .h5p-draggable')].filter(e=>e.getBoundingClientRect().height>0);
  const sy=window.scrollY;const top=(e)=>Math.round(e.getBoundingClientRect().top+sy);const bot=(e)=>Math.round(e.getBoundingClientRect().bottom+sy);
  return {dropzones:z.length,draggables:g.length,firstBlankTop:z.length?Math.min(...z.map(top)):null,bankBottom:g.length?Math.max(...g.map(bot)):null,docW:d.documentElement.scrollWidth,winW:window.innerWidth,winH:window.innerHeight}})()`;

(async () => {
  const L = mobileLimits();
  const worst = worstCase(L);
  console.log(`objetivo móvil (${L.source}): texto ≤ ${L.maxText}, ≤ ${L.maxBlanks} huecos, palabras ≤ ${L.wordMax}; peor caso: ${worst.text.length} caracteres, respuestas ${[...worst.text.matchAll(/\*([^*]+)\*/g)].map((m) => m[1].length).join('/')}, distractores ${worst.distractors.map((x) => x.length).join('/')}`);
  h.validateDragTextInput(worst);
  const routes = {
    '/dt-max.html': page('H5P.DragText 1.10', h.buildDragText(worst).content),
    '/dt-583.html': page('H5P.DragText 1.10', h.buildDragText(DT_583).content),
  };
  for (const pg of [70, 80]) {
    const b = h.buildBranchingScenario(BS_INPUT, { passingGrade: pg });
    routes[`/bs-${pg}.html`] = page('H5P.BranchingScenario 1.10', b.content);
    for (const [p, data] of Object.entries(b.contentFiles || {})) routes['/content/1/' + p] = data;
  }
  const { srv, base } = await serve(routes);
  const b = await launchChrome();
  try {
    // ── DragText ──
    for (const [key, total] of [['max', worst.text.match(/\*/g).length / 2], ['583', 6]]) {
      for (const [w, hgt] of [[390, 844], [390, 664], [1280, 900]]) {
        await b.setViewport(w, hgt, w < 768);
        await b.navigate(`${base}/dt-${key}.html`);
        await b.waitFor('!!document.querySelector(".h5p-drag-text .h5p-draggable")', { timeoutMs: 20000, what: 'DragText listo' });
        await sleep(800);
        const m = await b.evaluate(MEASURE);
        m.span = m.bankBottom - m.firstBlankTop;
        await b.screenshot(path.join(OUT, `dragtext-${key}-${w}x${hgt}.png`), { fullPage: true });
        const words = key === 'max' ? total + 2 : total;
        if (key === 'max') {
          report(`DragText peor caso ${w}×${hgt}: ${total} huecos y ${words} palabras en el banco, sin scroll horizontal`, m.dropzones === total && m.draggables === words && m.docW <= m.winW, m);
          if (w === 390) report(`DragText peor caso ${w}×${hgt}: del primer hueco al final del banco cabe en la pantalla (${m.span} ≤ ${m.winH} px)`, m.span <= m.winH, m);
        } else if (w === 390 && hgt === 844) {
          report('control: el DragText del #583 (1.250 caracteres) a 390 px NO cabe en la pantalla', m.span > m.winH, m);
        }
      }
    }
    // ── Caso ramificado ──
    const hue = ([r, g, bl]) => (g > r && g > bl ? 'verde' : r > 180 && g > 120 && bl < 110 ? 'ámbar' : r > g && r > bl ? 'rojo' : 'otro');
    const want = { 70: { optimal: 'verde', acceptable: 'ámbar', poor: 'rojo' }, 80: { optimal: 'verde', acceptable: 'rojo', poor: 'rojo' } };
    for (const pg of [70, 80]) {
      for (const [quality, choices] of Object.entries(BS_PATHS)) {
        for (const [w, hgt] of [[1280, 900], [390, 664]]) {
          await b.setViewport(w, hgt, w < 768);
          await b.navigate(`${base}/bs-${pg}.html`);
          await b.waitFor('!!document.querySelector(".h5p-start-button")', { timeoutMs: 20000, what: 'BS listo' });
          await sleep(600);
          await b.evaluate(`(()=>{document.querySelector('.h5p-start-button').click();return true})()`);
          await sleep(900);
          await b.evaluate(`(()=>{const x=[...document.querySelectorAll('.h5p-proceed-button')].find(e=>e.offsetParent);if(x)x.click();return !!x})()`);
          await sleep(900);
          for (const c of choices) {
            await b.waitFor(`[...document.querySelectorAll('.h5p-branching-question-alternative')].filter(e=>e.offsetParent).length>=2`, { timeoutMs: 10000, what: 'decisión visible' });
            await b.evaluate(`(()=>{[...document.querySelectorAll('.h5p-branching-question-alternative')].filter(e=>e.offsetParent)[${c}].click();return true})()`);
            await sleep(1100);
          }
          const e = await b.waitFor(`(()=>{const s=[...document.querySelectorAll('.h5p-end-screen')].find(e=>e.offsetParent);if(!s)return null;const im=s.querySelector('img.h5p-background-image');if(!im||!im.complete||!im.naturalWidth)return null;
            const c=document.createElement('canvas');c.width=60;c.height=40;const g=c.getContext('2d');g.drawImage(im,0,0,60,40);const p=g.getImageData(4,4,1,1).data;
            return {src:im.getAttribute('src'),rgb:[p[0],p[1],p[2]],text:s.innerText.replace(/\\s+/g,' ').slice(0,300),docW:document.documentElement.scrollWidth,winW:window.innerWidth}})()`, { timeoutMs: 15000, what: `final ${quality}` });
          await b.screenshot(path.join(OUT, `bs-${pg}-${quality}-${w}x${hgt}.png`));
          const color = hue(e.rgb);
          const noAprobado = /No aprobado/.test(e.text);
          const okMsg = quality === 'acceptable' && pg > 70 ? noAprobado : !noAprobado;
          report(`BS nota mínima ${pg}, final ${quality} (${w}×${hgt}): imagen propia ${want[pg][quality]}${quality === 'acceptable' && pg > 70 ? ' + «No aprobado»' : ''}, sin scroll horizontal`,
            /\/content\/1\/images\/cursia-final-/.test(e.src) && color === want[pg][quality] && okMsg && e.docW <= e.winW, { src: e.src.replace(base, ''), color, noAprobado });
        }
      }
    }
  } catch (e) {
    report('QA sin excepciones', false, e.message);
  } finally {
    b.close();
    srv.close();
  }
  console.log(`\ncapturas: ${OUT}\n${failures ? 'HAY FALLOS' : 'QA móvil de H5P OK'} (${passes} ✅, ${failures} ❌).`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
