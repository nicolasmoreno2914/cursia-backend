#!/usr/bin/env node
/* eslint-disable */
// UX #5 (r18) — QA en navegador real (Chrome headless, CDP) del assert de compuerta «ningún control
// visible del contenido H5P sin texto visible y sin icono» (scripts/lib/h5p-unlabeled-controls.js).
// NO es un check del runner (necesita Chrome, el core H5P del Moodle local y las librerías del perfil):
// se corre a mano o en el gate, como qa-h5p-mobile-legibility.js.
//
//  1. CONTROL NEGATIVO: el QuestionSet 1.20 de siempre (CURSIA_H5P_PROFILE_V1) DEBE fallar el assert
//     («Pregunta siguiente» = CTA azul vacío; en la pregunta 2 también «Pregunta anterior»).
//  2. QuestionSet 1.21 (CURSIA_H5P_PROFILE_V3, como lo arma el builder v3: librería incluida en el .h5p)
//     pasa en los estados inicial / tras Comprobar / tras Siguiente / resultado; la navegación dice
//     «Siguiente» / «Anterior»; la pantalla final queda en español (sin «Next», «Previous», «Score»,
//     «correct»); el xAPI de cierre (completed) trae la nota y cada pregunta su subContentId.
//  0. Fix round 1 (M-3): controles sintéticos (ancestro opacity:0 / visibility:hidden ignorados, etc.).
//  3. Sin falsos positivos: DragText, Blanks, SingleChoiceSet, Dialog Cards y Branching Scenario (este
//     tiene un botón solo-icono, «Pantalla completa», que cuenta como icono) pasan el assert.
//
// Reproductor «standalone»: el core H5P del Moodle local (h5plib v128) + librerías (las incluidas en el
// .h5p primero, después <libs>) + el content.json que construye ESTE dist, por file:// (sin red, sin
// servidor, sin Moodle corriendo, nunca el puerto 8099).
//
// Uso (después de `npm run build`):
//   node scripts/qa-h5p-unlabeled-controls.js [--core <h5p core>] [--libs <dir>] [--shots <dir>]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const CORE = path.resolve(opt('--core', path.join(os.homedir(), 'cursia-test-env/moodle-local/source/h5p/h5plib/v128/joubel/core')));
const LIBS = path.resolve(opt('--libs', path.join(os.homedir(), 'cursia-test-env/h5p-libs')));
const OUT = path.resolve(opt('--shots', fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-h5p-unlabeled-'))));
fs.mkdirSync(OUT, { recursive: true });
process.env.CURSIA_CHROME_HOST_RESOLVER_RULES = 'MAP * ~NOTFOUND';
require('reflect-metadata');
const JSZip = require('jszip');
const { launchChrome, sleep } = require('./lib/v21-cdp');
const { UNLABELED_CONTROLS_EXPR } = require('./lib/h5p-unlabeled-controls');
const h = require(path.join(ROOT, 'dist/package/h5p/index.js'));
const F = require('./lib/v21-player-fixture');

let passes = 0;
let failures = 0;
function report(name, ok, detail) {
  if (ok) { passes++; console.log(`✅ ${name}`); } else { failures++; console.error(`❌ ${name}`); if (detail !== undefined) console.error(`   ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 1500)}`); }
  return ok;
}

const CORE_STYLES = ['styles/h5p-fonts.css', 'styles/h5p.css', 'styles/h5p-confirmation-dialog.css', 'styles/h5p-core-button.css', 'styles/h5p-theme.css', 'styles/h5p-theme-variables.css', 'styles/h5p-tooltip.css', 'styles/h5p-table.css'];
const CORE_SCRIPTS = ['js/jquery.js', 'js/h5p.js', 'js/h5p-event-dispatcher.js', 'js/h5p-x-api-event.js', 'js/h5p-x-api.js', 'js/h5p-content-type.js', 'js/h5p-confirmation-dialog.js', 'js/h5p-action-bar.js', 'js/request-queue.js', 'js/h5p-tooltip.js'];

async function extract(buf, name) {
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const z = await JSZip.loadAsync(buf);
  for (const n of Object.keys(z.files)) {
    if (z.files[n].dir) continue;
    fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true });
    fs.writeFileSync(path.join(dir, n), await z.files[n].async('nodebuffer'));
  }
  return dir;
}

/** Página standalone del paquete extraído en `dir`. Devuelve la ruta del .html. */
function page(dir, name) {
  const h5pJson = JSON.parse(fs.readFileSync(path.join(dir, 'h5p.json'), 'utf8'));
  const content = fs.readFileSync(path.join(dir, 'content/content.json'), 'utf8');
  const libDir = (d) => {
    const n = `${d.machineName}-${d.majorVersion}.${d.minorVersion}`;
    return fs.existsSync(path.join(dir, n)) ? path.join(dir, n) : path.join(LIBS, n);
  };
  const order = [];
  const seen = new Set();
  const visit = (d) => {
    const k = `${d.machineName}-${d.majorVersion}.${d.minorVersion}`;
    if (seen.has(k)) return;
    seen.add(k);
    const ld = libDir(d);
    if (!fs.existsSync(path.join(ld, 'library.json'))) throw new Error(`falta la librería ${k} (ni en el paquete ni en ${LIBS})`);
    const lj = JSON.parse(fs.readFileSync(path.join(ld, 'library.json'), 'utf8'));
    (lj.preloadedDependencies || []).forEach(visit);
    order.push({ dir: ld, lj });
  };
  h5pJson.preloadedDependencies.forEach(visit);
  const css = CORE_STYLES.map((s) => path.join(CORE, s));
  const js = CORE_SCRIPTS.map((s) => path.join(CORE, s));
  for (const { dir: d, lj } of order) {
    (lj.preloadedCss || []).forEach((c) => css.push(path.join(d, c.path)));
    (lj.preloadedJs || []).forEach((c) => js.push(path.join(d, c.path)));
  }
  const main = h5pJson.preloadedDependencies.find((d) => d.machineName === h5pJson.mainLibrary);
  const integ = {
    baseUrl: 'file://', url: 'file://' + dir, postUserStatistics: false, ajax: {}, saveFreq: false, l10n: { H5P: {} },
    user: { name: 'qa', mail: 'qa@example.invalid' }, siteUrl: 'file://', hubIsEnabled: false, reportingIsEnabled: false,
    core: { styles: [], scripts: [] }, loadedJs: [], loadedCss: [],
    contents: { 'cid-1': { library: `${main.machineName} ${main.majorVersion}.${main.minorVersion}`, jsonContent: content, fullScreen: false, exportUrl: '', embedCode: '', resizeCode: '', mainId: 1, url: 'file://', title: h5pJson.title, contentUrl: 'file://' + path.join(dir, 'content'), metadata: { title: h5pJson.title, license: 'U' }, contentUserData: [{ state: false }], displayOptions: { frame: false, export: false, embed: false, copyright: false, icon: false, copy: false } } },
  };
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
${css.map((x) => `<link rel="stylesheet" href="file://${x}">`).join('\n')}
<script>window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});window.H5PIntegration=${JSON.stringify(integ)};</script>
${js.map((s) => `<script src="file://${s}"></script>`).join('\n')}
</head><body style="margin:0;background:#fff"><div style="max-width:880px;margin:16px auto"><div class="h5p-content" data-content-id="1"></div></div></body></html>`;
  const file = path.join(OUT, `${name}.html`);
  fs.writeFileSync(file, html);
  return { file, mainLibrary: `${main.machineName} ${main.majorVersion}.${main.minorVersion}` };
}

const W = (body) => `(()=>{const w=window,d=document;const vis=(e)=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';${body}})()`;
const GATE = W(`return ${UNLABELED_CONTROLS_EXPR};`);
const click = (labels) => W(`const L=${JSON.stringify(labels)};const lab=(e)=>[(e.innerText||'').trim(),e.getAttribute('aria-label')||''];const x=[...d.querySelectorAll('button,[role=button]')].find(e=>vis(e)&&lab(e).some(t=>L.includes(t.trim())));if(!x)return 'no';x.click();return 'ok';`);
const NAV_TEXTS = W(`return [...d.querySelectorAll('button,[role=button]')].filter(vis).map(e=>(e.innerText||'').trim()).filter(Boolean);`);
const XAPI_HOOK = `(()=>{window.__x=[];H5P.externalDispatcher.on('xAPI',function(e){var st=e.data.statement;window.__x.push({verb:st.verb.id.split('/').pop(),sub:((st.object.definition||{}).extensions||{})['http://h5p.org/x-api/h5p-subContentId']||null,score:st.result&&st.result.score?[st.result.score.raw,st.result.score.max]:null})});return 1})()`;

/** Recorre el paquete y devuelve, por estado, los controles sin rótulo. QS: hasta el resultado. */
async function walk(b, file, name, isQs) {
  await b.navigate('file://' + file);
  await sleep(2500);
  await b.evaluate(XAPI_HOOK);
  const states = [];
  const snap = async (s) => {
    await b.screenshot(path.join(OUT, `${name}-${s}.png`));
    states.push({ state: s, unlabeled: await b.evaluate(GATE), texts: await b.evaluate(NAV_TEXTS) });
  };
  await snap('inicial');
  const answer = W(`const c=[...d.querySelectorAll('.question-container')].find(vis)||d;const o=[...c.querySelectorAll('.h5p-answer,.h5p-true-false-answer')].find(vis);if(o)o.click();return o?'ok':'no';`);
  await b.evaluate(answer);
  if ((await b.evaluate(click(['Comprobar']))) === 'ok') { await sleep(800); await snap('tras-comprobar'); }
  if (!isQs) {
    if ((await b.evaluate(click(['Siguiente']))) === 'ok') { await sleep(900); await snap('tras-siguiente'); }
    return { states, errors: await b.evaluate('window.__errs'), xapi: await b.evaluate('window.__x') };
  }
  let finalText = null;
  for (let i = 0; i < 25; i++) {
    if ((await b.evaluate(click(['Finalizar']))) === 'ok') { await sleep(1500); await snap('resultado'); finalText = await b.evaluate('document.body.innerText'); break; }
    if ((await b.evaluate(click(['Siguiente', 'Pregunta siguiente']))) !== 'ok') break;
    await sleep(900);
    if (i === 0) await snap('tras-siguiente');
    await b.evaluate(answer);
    await b.evaluate(click(['Comprobar']));
    await sleep(700);
  }
  return { states, finalText, errors: await b.evaluate('window.__errs'), xapi: await b.evaluate('window.__x') };
}

(async () => {
  for (const [label, p] of [['core H5P', CORE], ['librerías', LIBS]]) {
    if (!fs.existsSync(p)) { report(`${label} disponible (${p})`, false); process.exit(1); }
  }
  const V3 = h.CURSIA_H5P_PROFILE_V3;
  const store = h.openH5pLibraryStore(V3);
  const bundled = (m, built) => h.buildBundledH5p({ mainLibrary: m, content: built.content, title: built.title, language: 'es', profile: V3, libraryStore: store, ...(built.contentFiles ? { contentFiles: built.contentFiles } : {}) });
  const contentOnly = (built) => h.buildContentOnlyH5p({ mainLibrary: built.mainLibrary, content: built.content, title: built.title, language: 'es' });
  const qs1 = h.buildQuestionSet(F.QS);
  const qs3 = h.buildQuestionSet(F.QS, { profile: V3 });
  const cases = [
    { name: 'qs-1.20-legacy', buf: await contentOnly(qs1), isQs: true, expectFail: true },
    { name: 'qs-1.21-v3', buf: await bundled('H5P.QuestionSet', qs3), isQs: true, qsIds: qs3.subContentIds },
    { name: 'dragtext', buf: await contentOnly(h.buildDragText(F.DT)) },
    { name: 'blanks', buf: await contentOnly(h.buildBlanks(F.BL)) },
    { name: 'singlechoiceset', buf: await contentOnly(h.buildSingleChoiceSet(F.SCS)) },
    { name: 'dialogcards', buf: await bundled('H5P.Dialogcards', h.libraryPackSampleContent('H5P.Dialogcards', V3)) },
    { name: 'branchingscenario', buf: await bundled('H5P.BranchingScenario', h.libraryPackSampleContent('H5P.BranchingScenario', V3)) },
  ];
  const b = await launchChrome({ extraArgs: ['--allow-file-access-from-files'] });
  try {
    await b.setViewport(900, 900);
    // Fix round 1 (M-3): controles sintéticos — qué cuenta como visible y qué como icono.
    const synth = path.join(OUT, 'synthetic.html');
    fs.writeFileSync(synth, `<!doctype html><html><head><meta charset="utf-8"><style>
      button{width:60px;height:24px;margin:4px}.glyph::before{content:"\\f054"}.bgonly::before{content:"";background:#00f;display:inline-block;width:8px;height:8px}
    </style></head><body>
      <div style="opacity:0"><div><button id="in-opacity0" aria-label="oculto por opacidad del abuelo"></button></div></div>
      <div style="visibility:hidden"><button id="in-hidden" aria-label="oculto por visibility del padre"></button></div>
      <div style="display:none"><button id="in-none" aria-label="oculto por display del padre"></button></div>
      <button id="own-opacity0" style="opacity:0" aria-label="transparente"></button>
      <button id="text">Siguiente</button>
      <button id="glyph" class="glyph" aria-label="icono glifo"></button>
      <button id="svg" aria-label="icono svg"><svg width="10" height="10"><rect width="10" height="10"/></svg></button>
      <button id="empty-aria" aria-label="Pregunta siguiente"></button>
      <span id="empty-role" role="button" style="display:inline-block;width:40px;height:20px"></span>
      <button id="bg-only" class="bgonly" aria-label="solo color de fondo"></button>
      <div style="opacity:0.5"><button id="half-opacity-empty" aria-label="medio transparente"></button></div>
    </body></html>`);
    await b.navigate('file://' + synth);
    await sleep(300);
    const flagged = (await b.evaluate(W(`return ${UNLABELED_CONTROLS_EXPR}.map(function(x){return x.aria||x.tag;});`))).sort();
    const ids = await b.evaluate(W(`const L=${UNLABELED_CONTROLS_EXPR};return [...d.querySelectorAll('button,[role=button]')].filter(e=>L.some(x=>x.aria===(e.getAttribute('aria-label')||'')&&x.tag===e.tagName)).map(e=>e.id).sort();`));
    report('assert sintético: ignora controles dentro de un ancestro opacity:0 / visibility:hidden / display:none y con opacity:0 propia; acepta texto, glifo y svg; marca vacío con aria, [role=button] vacío, ::before solo color y vacío con opacidad parcial',
      JSON.stringify(ids) === JSON.stringify(['bg-only', 'empty-aria', 'empty-role', 'half-opacity-empty']), { ids, flagged });
    for (const c of cases) {
      const dir = await extract(c.buf, c.name);
      const { file, mainLibrary } = page(dir, c.name);
      const r = await walk(b, file, c.name, !!c.isQs);
      const bad = r.states.filter((s) => s.unlabeled.length);
      report(`${c.name} (${mainLibrary}): reproductor sin errores de JS`, r.errors.length === 0, r.errors);
      if (c.expectFail) {
        report(`${c.name}: CONTROL NEGATIVO — el assert detecta el botón vacío «Pregunta siguiente» (y «Pregunta anterior» en la pregunta 2)`,
          bad.length > 0 && bad.some((s) => s.unlabeled.some((u) => u.aria === 'Pregunta siguiente')) && bad.some((s) => s.unlabeled.some((u) => u.aria === 'Pregunta anterior')),
          r.states.map((s) => [s.state, s.unlabeled]));
        continue;
      }
      report(`${c.name}: ningún control visible sin texto ni icono en ${r.states.map((s) => s.state).join(' / ')}`, r.states.length > 0 && bad.length === 0, bad.map((s) => [s.state, s.unlabeled]));
      if (c.isQs) {
        const after = r.states.find((s) => s.state === 'tras-siguiente');
        report(`${c.name}: navegación rotulada «Siguiente» / «Anterior» (pregunta 2)`, !!after && after.texts.includes('Siguiente') && after.texts.includes('Anterior'), after && after.texts);
        report(`${c.name}: pantalla de resultado en español (sin Next/Previous/Score/correct/Results)`, !!r.finalText && /Tu resultado/.test(r.finalText) && /Puntaje/.test(r.finalText) && /\d+ de \d+ correctas/.test(r.finalText) && !/\b(Next|Previous|Score|correct|Results)\b/.test(r.finalText), r.finalText);
        const done = r.xapi.filter((x) => x.verb === 'completed' && !x.sub);
        const answered = r.xapi.filter((x) => x.verb === 'answered' && x.sub);
        report(`${c.name}: xAPI completed con nota sobre ${c.qsIds.length} y un answered por pregunta con su subContentId`,
          done.length === 1 && done[0].score && done[0].score[1] === c.qsIds.length && JSON.stringify(answered.map((x) => x.sub).sort()) === JSON.stringify([...c.qsIds].sort()),
          r.xapi);
      }
    }
  } finally {
    b.close();
  }
  console.log(`\ncapturas: ${OUT}`);
  if (failures) { console.error(`❌ qa-h5p-unlabeled-controls: ${failures} fallo(s), ${passes} ok.`); process.exitCode = 1; } else console.log(`✅ qa-h5p-unlabeled-controls: ${passes} ok.`);
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
})().catch((e) => { console.error(e); process.exit(1); });
