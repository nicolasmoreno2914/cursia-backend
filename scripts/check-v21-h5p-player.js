#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — prueba con REPRODUCTOR REAL (review G4 I4) de QuestionSet,
// SingleChoiceSet, DragText y Blanks en un Moodle LOCAL desechable.
//
//  1. Construye con dist/ los 4 paquetes solo-contenido (fixtures en español) y
//     un .mbz mínimo con 4 h5pactivity (grade 100, gradepass 70, completion por
//     nota aprobatoria, displayoptions 15).
//  2. Restaura en un curso NUEVO (0 errores/warnings) y matricula al estudiante
//     local de prueba.
//  3. Levanta el servidor PHP en 127.0.0.1:8099 SOLO durante la prueba y usa
//     Chrome headless (CDP, user-data-dir propio, puerto libre).
//  4. Por actividad, en view.php, responde a través del DOM (clics reales,
//     arrastre con eventos de ratón reales de CDP, texto con Input.insertText)
//     para una nota PARCIAL, y envía.
//  5. DB: exactamente 1 intento por envío, nota 0–100 esperada, completion
//     esperado y resultados hijos con subcontent UUID = los del paquete.
//  6. Idioma: sin textos por defecto en inglés visibles en el iframe H5P.
//
// Nunca borra datos: deja el curso y los intentos. La contraseña nunca se imprime.
//
// Uso (después de `npm run build`):
//   node scripts/check-v21-h5p-player.js <moodleDir> <phpIni> --creds <file> [--shots <dir>]

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [moodleDirArg, phpIniArg] = positional;
const credsFile = opt('--creds');
if (!moodleDirArg || !phpIniArg || !credsFile) {
  console.error('uso: node scripts/check-v21-h5p-player.js <moodleDir> <phpIni> --creds <file> [--shots <dir>]');
  process.exit(2);
}
const moodleDir = path.resolve(moodleDirArg);
const phpIni = path.resolve(phpIniArg);
const shotsDir = path.resolve(opt('--shots', fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-player-shots-'))));
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
const F = require('./lib/v21-player-fixture');
const { buildMiniH5pMbz } = require('./lib/v21-mini-mbz');
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
  const r = spawnSync(PHP, ['-c', phpIni, path.join(__dirname, 'moodle', 'v21-video-moodle.php'), moodleDir, ...cmdArgs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
const portInUse = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });

// Textos por defecto en inglés que NO deben verse (review G4 I4).
const ENGLISH = ['Check', 'Retry', 'Show solution', 'Submit', 'Untitled', 'You got', 'Question', 'Finish', 'Next', 'Previous', 'Correct!', 'Incorrect', 'Your result', 'Reuse', 'Embed', 'Rights of use'];
const englishIn = (text) => ENGLISH.filter((w) => new RegExp(`(^|[^A-Za-zÁ-ú])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-zÁ-ú]|$)`).test(text));

// Localiza la ventana con H5P.instances (atraviesa iframes del mismo origen).
const FIND = `(()=>{function find(w){try{if(w.H5P&&w.H5P.instances&&w.H5P.instances.length)return w}catch(e){}for(let i=0;i<w.frames.length;i++){const r=find(w.frames[i]);if(r)return r}return null}return find(window)})()`;
const inH5p = (body) => `(()=>{const w=${FIND};if(!w)throw new Error('sin ventana H5P');const d=w.document;const inst=w.H5P.instances[0];const vis=(e)=>!!e&&e.getClientRects().length>0&&w.getComputedStyle(e).visibility!=='hidden';${body}})()`;
const COLLECT = inH5p(`const a=[];d.querySelectorAll('[aria-label],[title],[placeholder]').forEach(e=>{['aria-label','title','placeholder'].forEach(k=>{const v=e.getAttribute(k);if(v)a.push(v)})});return {visible:d.body.innerText,attrs:a.join('\\n')};`);
// Centro de un elemento del frame H5P en coordenadas de la página principal.
const centerOf = (selectorExpr) =>
  inH5p(`const el=(${selectorExpr});if(!el)return null;const r=el.getBoundingClientRect();let x=r.left+r.width/2,y=r.top+r.height/2;let cw=w;while(cw!==cw.parent){const fe=cw.frameElement;const fr=fe.getBoundingClientRect();x+=fr.left+fe.clientLeft;y+=fr.top+fe.clientTop;cw=cw.parent}return {x,y};`);

let server = null;
let browser = null;
function cleanup() {
  if (browser) { try { browser.close(); } catch (e) {} browser = null; }
  if (server) { try { server.kill('SIGTERM'); } catch (e) {} server = null; }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function clickVisibleButton(b, labels) {
  // Algunos botones son solo icono: se identifican por texto visible, aria-label o title.
  return b.evaluate(inH5p(`const L=${JSON.stringify(labels)};const lab=(e)=>[(e.innerText||'').trim(),e.getAttribute('aria-label')||'',e.getAttribute('title')||''];const x=[...d.querySelectorAll('button,[role=button]')].find(e=>vis(e)&&lab(e).some(t=>L.includes(t.trim())));if(!x)return 'no: '+[...d.querySelectorAll('button,[role=button]')].filter(vis).map(e=>lab(e).join('/')).join('|');x.click();return 'ok';`));
}

async function mouseDrag(b, from, to) {
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, button: 'left', buttons: 1 });
    await sleep(25);
  }
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(300);
}

// ── Recorridos por tipo (solo DOM / eventos de entrada reales) ─────────────
const FLOWS = {
  async QS(b, texts) {
    for (let i = 0; i < F.QS.questions.length; i++) {
      const q = F.QS.questions[i];
      await b.waitFor(inH5p(`return [...d.querySelectorAll('.question-container')].some(c=>vis(c)&&c.innerText.includes(${JSON.stringify(q.question)}))?1:0;`), { timeoutMs: 15000, what: `QS pregunta ${i + 1}` });
      const r = await b.evaluate(inH5p(`const c=[...d.querySelectorAll('.question-container')].find(c=>vis(c)&&c.innerText.includes(${JSON.stringify(q.question)}));const o=[...c.querySelectorAll('.h5p-answer,.h5p-true-false-answer')].find(e=>e.innerText.trim()===${JSON.stringify(F.QS_PICKS[i])});if(!o)return 'sin opción';o.click();const k=[...c.querySelectorAll('button')].find(e=>vis(e)&&e.innerText.trim()==='Comprobar');if(!k)return 'sin Comprobar';k.click();return 'ok';`));
      if (r !== 'ok') throw new Error(`QS pregunta ${i + 1}: ${r}`);
      await sleep(700);
      texts.push(await b.evaluate(COLLECT));
      const last = i === F.QS.questions.length - 1;
      const n = await clickVisibleButton(b, last ? ['Finalizar', 'Enviar'] : ['Pregunta siguiente']);
      if (n !== 'ok') throw new Error(`QS pregunta ${i + 1}: botón ${last ? 'Finalizar' : 'siguiente'}: ${n}`);
      await sleep(900);
    }
    await b.waitFor(inH5p(`return d.body.innerText.includes('Tu resultado')?1:0;`), { timeoutMs: 10000, what: 'pantalla de resultado QS' });
  },
  async SCS(b, texts) {
    for (let i = 0; i < F.SCS.questions.length; i++) {
      const q = F.SCS.questions[i];
      await b.waitFor(inH5p(`return [...d.querySelectorAll('.h5p-sc-slide')].some(s=>vis(s)&&s.classList.contains('h5p-sc-current-slide')&&s.innerText.includes(${JSON.stringify(q.question)}))?1:0;`), { timeoutMs: 15000, what: `SCS pregunta ${i + 1}` });
      await sleep(400);
      const r = await b.evaluate(inH5p(`const s=[...d.querySelectorAll('.h5p-sc-slide.h5p-sc-current-slide')].find(vis);const o=[...s.querySelectorAll('.h5p-sc-alternative')].find(e=>e.innerText.trim()===${JSON.stringify(F.SCS_PICKS[i])});if(!o)return 'sin opción: '+[...s.querySelectorAll('.h5p-sc-alternative')].map(e=>e.innerText.trim()).join('|');o.click();return 'ok';`));
      if (r !== 'ok') throw new Error(`SCS pregunta ${i + 1}: ${r}`);
      await sleep(800);
      texts.push(await b.evaluate(COLLECT));
    }
    await b.waitFor(inH5p(`return [...d.querySelectorAll('.h5p-sc-set-results')].some(vis)?1:0;`), { timeoutMs: 15000, what: 'pantalla de resultado SCS' });
  },
  async DT(b, texts) {
    const zones = await b.evaluate(inH5p(`return d.querySelectorAll('.h5p-dropzone').length;`));
    if (zones !== F.DT_DROPS.length) throw new Error(`DT: ${zones} huecos (esperados ${F.DT_DROPS.length})`);
    for (let i = 0; i < F.DT_DROPS.length; i++) {
      const word = F.DT_DROPS[i];
      // Sin scrollIntoView dentro del iframe (el resizer lo revierte de forma asíncrona y
      // desfasa las coordenadas): la tarea cabe en el viewport de 1280×900; se mide y se arrastra.
      await sleep(250);
      // El resizer cambia la altura del iframe mientras el contenido se asienta: se mide hasta
      // que origen y destino queden estables Y el punto de origen caiga sobre la palabra.
      const fromSel = `[...d.querySelectorAll('.h5p-drag-draggables-container .h5p-draggable')].find(e=>e.innerText.split('\\n')[0].trim()===${JSON.stringify(word)})`;
      const toSel = `d.querySelectorAll('.h5p-dropzone')[${i}]`;
      let from = null;
      let to = null;
      for (let k = 0; k < 20; k++) {
        const f1 = await b.evaluate(centerOf(fromSel));
        const t1 = await b.evaluate(centerOf(toSel));
        await sleep(250);
        from = await b.evaluate(centerOf(fromSel));
        to = await b.evaluate(centerOf(toSel));
        if (!from) throw new Error(`DT: no está la palabra "${word}" en el banco`);
        const stable = JSON.stringify([f1, t1]) === JSON.stringify([from, to]);
        const hit = await b.evaluate(`(()=>{let w=window,x=${from.x},y=${from.y},el;for(let k=0;k<5;k++){el=w.document.elementFromPoint(x,y);if(el&&el.tagName==='IFRAME'){const r=el.getBoundingClientRect();x-=r.left+el.clientLeft;y-=r.top+el.clientTop;w=el.contentWindow;continue}break}return el?(el.innerText||'').trim().split('\\n')[0]:''})()`);
        if (stable && hit === word) break;
        if (k === 19) throw new Error(`DT: posición inestable o no coincide (${hit}) ${JSON.stringify({ from, to })}`);
      }
      if (![from, to].every((p) => p && p.x > 0 && p.y > 0 && p.x < 1280 && p.y < 900)) throw new Error(`DT: fuera del viewport ${JSON.stringify({ from, to })}`);
      await mouseDrag(b, from, to);
      const placed = await b.evaluate(inH5p(`const z=d.querySelectorAll('.h5p-dropzone')[${i}];return z?z.innerText.split('\\n')[0].trim():'';`));
      if (placed !== word) {
        await b.screenshot(path.join(shotsDir, `player-dt-debug-${i + 1}.png`));
        throw new Error(`DT: el hueco ${i + 1} contiene "${placed}", no "${word}" (arrastre ${JSON.stringify(from)} → ${JSON.stringify(to)})`);
      }
    }
    texts.push(await b.evaluate(COLLECT));
    const k = await clickVisibleButton(b, ['Comprobar']);
    if (k !== 'ok') throw new Error(`DT Comprobar: ${k}`);
    await sleep(1200);
  },
  async BL(b, texts) {
    const n = await b.evaluate(inH5p(`return d.querySelectorAll('.h5p-text-input').length;`));
    if (n !== F.BL_TYPED.length) throw new Error(`BL: ${n} campos (esperados ${F.BL_TYPED.length})`);
    for (let i = 0; i < F.BL_TYPED.length; i++) {
      await b.evaluate(inH5p(`const e=d.querySelectorAll('.h5p-text-input')[${i}];e.scrollIntoView({block:'center'});e.focus();return 1;`));
      await b.send('Input.insertText', { text: F.BL_TYPED[i] });
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await sleep(150);
    }
    const vals = await b.evaluate(inH5p(`return [...d.querySelectorAll('.h5p-text-input')].map(e=>e.value);`));
    if (JSON.stringify(vals) !== JSON.stringify(F.BL_TYPED)) throw new Error(`BL: valores ${JSON.stringify(vals)}`);
    texts.push(await b.evaluate(COLLECT));
    const k = await clickVisibleButton(b, ['Comprobar']);
    if (k !== 'ok') throw new Error(`BL Comprobar: ${k}`);
    await sleep(1200);
  },
};

async function main() {
  // ── 1. Build ──
  const specs = [
    { key: 'QS', lib: 'H5P.QuestionSet 1.20', built: h.buildQuestionSet(F.QS), expect: { raw: 3, grade: 75, completion: 'COMPLETE_PASS', perChild: [true, true, false, true] } },
    // SCS: C1 corregido (1 intento, hijos con UUID), pero Moodle NO califica SCS 1.11 (ver
    // src/package/h5p/moodle-grading.ts). Se verifica esa limitación tal cual: si algún día
    // Moodle/SCS la corrigen, este check falla y obliga a actualizar H5P_MOODLE_GRADING.
    { key: 'SCS', lib: 'H5P.SingleChoiceSet 1.11', built: h.buildSingleChoiceSet(F.SCS), expect: { raw: 1, knownUngraded: true, perChild: [true, false, false, false] } },
    { key: 'DT', lib: 'H5P.DragText 1.10', built: h.buildDragText(F.DT), expect: { raw: 2, grade: 50, completion: 'COMPLETE_FAIL' } },
    { key: 'BL', lib: 'H5P.Blanks 1.14', built: h.buildBlanks(F.BL), expect: { raw: 3, grade: 75, completion: 'COMPLETE_PASS' } },
  ];
  let mid = 4301;
  for (const s of specs) {
    s.mid = mid++;
    s.h5p = await h.buildContentOnlyH5p({ mainLibrary: s.built.mainLibrary, content: s.built.content, title: s.built.title, language: 'es' });
    s.name = `${s.key} — ${s.built.title}`;
  }
  report(`build: 4 paquetes (QS ${specs[0].built.subContentIds.length} UUID, SCS ${specs[1].built.subContentIds.length} UUID, DT, Blanks)`, specs[0].built.subContentIds.length === 4 && specs[1].built.subContentIds.length === 4);
  const mbz = await buildMiniH5pMbz({
    courseTitle: 'Cursia V2.1 — reproductor real QS/SCS/DT/Blanks',
    sectionName: 'Actividades H5P',
    activities: specs.map((s) => ({ mid: s.mid, name: s.name, packageFilename: `cursia-${s.key.toLowerCase()}.h5p`, h5p: s.h5p, introHtml: '', inlineIntroFile: false, showdescription: 0 })),
  });
  const mbzPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-player-mbz-')), 'cursia-v21-player.mbz');
  fs.writeFileSync(mbzPath, mbz);

  // ── 2. Restore + matrícula ──
  const R = php('restore', mbzPath).data;
  if (!report('restore: curso nuevo con 4 h5pactivity', R.courseid > 0 && R.h5pactivityCount === 4, { courseid: R.courseid, n: R.h5pactivityCount })) return;
  console.log(`   curso ${R.courseid}`);
  report('restore: 0 errores/warnings (precheck y log)', R.precheck.errors.length + R.precheck.warnings.length + R.logWarnings.length === 0, { pre: R.precheck, log: R.logWarnings });
  for (const s of specs) {
    const cm = R.cms.find((c) => c.name === s.name);
    s.cm = cm;
    report(`restore ${s.key}: grade 100 / gradepass 70 / completion 2 + pass grade / mismo .h5p`, !!cm && cm.grade === 100 && cm.grademax === 100 && cm.gradepass === 70 && cm.completion === 2 && cm.completionpassgrade === 1 && cm.package.length === 1 && cm.package[0].contenthash === require('crypto').createHash('sha1').update(s.h5p).digest('hex'), cm);
  }
  const creds = readCreds(credsFile);
  const en = php('enrol', String(R.courseid), creds.username).data;
  report(`matrícula de ${creds.username}`, en.enrolled === true, en);

  // ── 3. Servidor + navegador ──
  if (await portInUse(8099)) {
    report('puerto 8099 libre para el servidor PHP desechable', false, 'ya hay algo escuchando en 127.0.0.1:8099');
    return;
  }
  const logPath = path.join(os.tmpdir(), `cursia-player-php-${process.pid}.log`);
  const logFd = fs.openSync(logPath, 'w');
  server = spawn(PHP, ['-c', phpIni, '-S', '127.0.0.1:8099', '-t', moodleDir], { stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { await sleep(200); up = await portInUse(8099); }
  if (!report('servidor PHP desechable en 127.0.0.1:8099', up)) return;
  browser = await launchChrome();
  const b = browser;
  await b.setViewport(1280, 900);
  await b.navigate(`${WWWROOT}/login/index.php`);
  await b.evaluate(`(()=>{document.querySelector('#username').value=${JSON.stringify(creds.username)};document.querySelector('#password').value=${JSON.stringify(creds.password)};document.querySelector('#login').submit();return 1})()`);
  await sleep(2500);
  if (!report('login del estudiante local de prueba', await b.evaluate(`!location.pathname.startsWith('/login')`))) return;

  // ── 4. Responder en el reproductor real ──
  const only = opt('--only');
  for (const s of specs) {
    if (only && s.key !== only) continue;
    await b.navigate(`${WWWROOT}/mod/h5pactivity/view.php?id=${s.cm.cmid}`);
    const lib = await b.waitFor(inH5p(`return inst.libraryInfo.versionedName;`), { timeoutMs: 30000, what: `${s.key}: instancia H5P` }).catch((e) => e.message);
    report(`${s.key}: el reproductor real carga ${s.lib}`, lib === s.lib, lib);
    const bar = await b.evaluate(inH5p(`return [...d.querySelectorAll('.h5p-actions li, .h5p-actions button')].filter(vis).map(e=>e.innerText.trim());`));
    report(`${s.key}: sin barra de acciones (displayoptions 15: sin "Reuse"/"Embed")`, Array.isArray(bar) && bar.length === 0, bar);
    const texts = [await b.evaluate(COLLECT)];
    await b.screenshot(path.join(shotsDir, `player-${s.key.toLowerCase()}-01-start.png`));
    try {
      await FLOWS[s.key](b, texts);
      report(`${s.key}: respondido y enviado a través del DOM`, true);
    } catch (e) {
      report(`${s.key}: respondido y enviado a través del DOM`, false, e.message);
    }
    await sleep(2500); // deja terminar el POST xAPI
    texts.push(await b.evaluate(COLLECT));
    await b.screenshot(path.join(shotsDir, `player-${s.key.toLowerCase()}-02-result.png`));
    const visible = texts.map((t) => t.visible).join('\n');
    const attrs = texts.map((t) => t.attrs).join('\n');
    const enVis = englishIn(visible);
    report(`${s.key}: ningún texto VISIBLE por defecto en inglés (${ENGLISH.length} términos)`, enVis.length === 0, enVis);
    const enAttr = englishIn(attrs);
    report(`${s.key}: atributos a11y (aria-label/title) sin textos por defecto en inglés`, enAttr.length === 0, { found: enAttr, sample: attrs.split('\n').filter((l) => englishIn(l).length).slice(0, 5) });

    // ── 5. DB ──
    const st = php('state', String(R.courseid), String(s.cm.cmid), creds.username).data;
    const e = s.expect;
    report(`${s.key}: DB exactamente 1 intento`, st.attempts.length === 1, st.attempts);
    const a0 = st.attempts[0] || {};
    report(`${s.key}: DB rawscore ${e.raw}/4 (una sola fila de intento: sin inflado por respuestas hijas)`, a0.rawscore === e.raw && a0.maxscore === 4, a0);
    if (e.knownUngraded) {
      report(`${s.key}: gradable=false en H5P_MOODLE_GRADING (assertH5pGradableInMoodle falla fuerte)`, h.H5P_MOODLE_GRADING[s.built.mainLibrary].gradable === false && (() => { try { h.assertH5pGradableInMoodle(s.built.mainLibrary); return false; } catch (x) { return /H5P_NOT_GRADABLE_IN_MOODLE/.test(x.message); } })());
      report(`${s.key}: LIMITACIÓN UPSTREAM confirmada en el reproductor real — intento con completion NULL ⇒ sin nota, INCOMPLETE`, a0.completion === null && st.grade === null && st.completion === 'INCOMPLETE', { attempt: a0, grade: st.grade, completion: st.completion });
      console.log(`   ⚠️  ${s.key}: Moodle no califica ${s.lib} (ver moodle-grading.ts); los intentos y resultados por pregunta sí quedan bien (C1).`);
    } else {
      report(`${s.key}: gradable=true en H5P_MOODLE_GRADING`, h.H5P_MOODLE_GRADING[s.built.mainLibrary].gradable === true);
      report(`${s.key}: DB nota ${e.grade} (grademax 100, gradepass 70)`, st.grade === e.grade && st.grademax === 100 && st.gradepass === 70, { grade: st.grade, grademax: st.grademax, gradepass: st.gradepass });
      report(`${s.key}: DB completion ${e.completion}`, st.completion === e.completion, st.completion);
    }
    const rows = (st.results[0] && st.results[0].rows) || [];
    const child = rows.filter((r) => r.subcontent);
    const ids = s.built.subContentIds;
    report(
      `${s.key}: DB resultados hijos con subcontent UUID = los ${ids.length} del paquete`,
      child.length === ids.length && child.every((r) => h.isUuid(r.subcontent)) && JSON.stringify(child.map((r) => r.subcontent).sort()) === JSON.stringify([...ids].sort()),
      rows,
    );
    if (e.perChild) {
      const got = ids.map((id) => { const r = child.find((x) => x.subcontent === id); return r ? r.rawscore === r.maxscore && r.maxscore > 0 : null; });
      report(`${s.key}: DB acierto por pregunta coincide con lo respondido`, JSON.stringify(got) === JSON.stringify(e.perChild), got);
    }
  }
  const phpErrors = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => /PHP (Fatal|Parse) error/.test(l));
  report('servidor PHP: sin errores fatales', phpErrors.length === 0, phpErrors.slice(0, 5));
}

main()
  .catch((err) => report('ejecución sin excepciones', false, err.stack || err.message))
  .finally(() => {
    cleanup();
    console.log('');
    if (failures) {
      console.error(`❌ check-v21-h5p-player: ${failures} fallo(s), ${passes} ok.`);
      process.exitCode = 1;
    } else console.log(`✅ check-v21-h5p-player: ${passes} ok.`);
    setTimeout(() => process.exit(process.exitCode || 0), 2000).unref();
  });
