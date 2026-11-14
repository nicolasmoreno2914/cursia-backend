#!/usr/bin/env node
/* eslint-disable */
// r107 B12 — endurecimiento final del Taller de cursos, contra el código COMPILADO (dist/). Puro: sin red, sin IA, sin
// base, USD 0. Convierte en checks los repros de la revisión final (scratchpad h/redos2.js, h/bomb.js, h/ask.js).
//
//   K1 (H1 P0) escaneo lineal: tags abiertos SIN cierre (400 KB y 7,9 MB descomprimidos) en moodle_backup.xml,
//      files.xml, questions.xml, el XML de una actividad y su HTML → identificación (readPackageFacts), inventario
//      (readRawCourse + modelo) y diagnóstico técnico terminan en < 2 s cada uno y el event loop sigue avanzando
//      (un temporizador de 50 ms corre entre pasos); antes: 18 s (400 KB) / ~2 h (7,9 MB) sin un tick.
//   K1b equivalencia: allBlocks / matchBlocks / replaceBlocks / tagInner dan EXACTAMENTE lo mismo que la regex perezosa
//      de antes sobre 4000 textos al azar bien y mal formados (incluye cierres con referencia `</\1>`).
//   K2 (H2 P1) memoria sobre lo DESCOMPRIMIDO: bomb.js (1 MB → 140 × 7 MB) se rechaza al abrir (zip_bomb, no
//      reintentable) sin pasar de 300 MB de RSS; con razón total < 200× el presupuesto de lectura proporcional
//      (min(1 GB, max(64 MB, tamaño × 4))) corta la lectura (read_budget_exceeded) sin pasar de 300 MB; la reserva FIFO
//      del servicio se agranda a max(comprimido × factor, min(total, presupuesto) × 2) después de abrir; una expansión
//      mayor que el presupuesto entero → PackageExpansionError (zip_bomb, no reintentable).
//   K4 (B12 ronda 1) fuzz HOSTIL: 8 variantes malformadas (comilla sin cerrar en un atributo; muchos `<a`/`<img`/
//      `<iframe`/`<h1-6`/`<script`/`<style` sin `>`; 100 K espacios + «—»; 100 K espacios + `"`; `$@` sin cierre;
//      `href="javascript:` + espacios, con y sin la comilla de cierre) × 10 lugares que el Taller lee (moodle_backup,
//      files, section (XML y su resumen HTML), module, label.xml (XML y su HTML), questions (XML y un enunciado) y el
//      HTML del Libro Guía) sobre un V1 del builder real → identificar, inventario, diagnóstico técnico (con prueba en
//      seco), plan (openBuildCtx), compuerta del motor (edit_html + remove sobre la entrada) y aplicar: < 2 s cada uno.
//   K5 (B12 ronda 2) el HTML que reemplaza un enlace muerto (se ESCRIBE al paquete) respeta las comillas:
//      `<a href="#" title="x < y">Libro Guía</a>` → «Libro Guía» (helper y de punta a punta: diagnóstico → motor).
//   K6 (B12 ronda 2) 400 KB que llegan a defectKey (hallazgo con 400 K espacios antes de «—», por la compuerta del
//      motor) y al desenlace de un token (`<a` sin `>` × 400 KB): < 2 s cada uno.
//   K7 (B12 ronda 2) blockText = la versión con `\s*\uE000\s*` sobre 3000 HTML al azar con `&#10;`, `&#9;`, `&nbsp;`…
//   K3 (D3 P1) «Preguntar» sobre cobertura de examen: examen de 40 preguntas con las del capítulo 9 al final → llegan
//      las 40 (enunciado corto), ANTES del texto del capítulo, sin recorte; examen enorme (200) → recortado: el prompt
//      lo dice y un «no» baja a «parcial» con el aviso.
//
// Uso: npm run build && node scripts/r107/check-r107-hardening.js --ci [--dist dist]
//      node scripts/r107/check-r107-hardening.js --bite   (copia dist/ y rompe una defensa por vez: cada una tiene que
//                                                          hacer fallar su prueba)
'use strict';
require('reflect-metadata');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const DIST = path.resolve(arg('--dist', path.join(REPO, 'dist')));
if (!has('--ci') && !has('--bite')) { console.error('Uso: --ci [--dist dist] | --bite'); process.exit(2); }
const ONLY = arg('--only', null);

// ── --bite ────────────────────────────────────────────────────────────────────────────────────────────────────────
if (has('--bite')) {
  const bites = [
    { id: 'K1', file: 'modules/course-workshop/xml-scan.js', find: /function tagInner\(text, name, from = 0\) \{/, repl: 'function tagInner(text, name, from = 0) { const __m = new RegExp(`<${name}>([\\\\s\\\\S]*?)</${name}>`).exec(text.slice(from)); return __m ? __m[1] : null;' },
    { id: 'K2', file: 'modules/course-workshop/mbz-reader.js', find: /const checkTotalRatio = \(total\) => \{/, repl: 'const checkTotalRatio = (total) => { return;' },
    { id: 'K4', file: 'modules/course-workshop/diagnosis/checks.js', find: /const deadLinks = \(html\) => \{/, repl: 'const deadLinks = (html) => (0, xml_scan_1.allBlocks)(html, /<a\\b[^<>]*\\bhref\\s*=\\s*(["\'])\\s*(#?|javascript:[^"\'<>]*)\\s*\\1[^<>]*>/i, /<\\/a>/i).map((b) => Object.assign([b.whole, b.open[1], b.open[2], b.inner], { index: b.start }));\nconst __b12_unused = (html) => {' },
    { id: 'K5', file: 'modules/course-workshop/plan/builder.js', find: /function unwrapLinkHtml\(rawLink\) \{/, repl: 'function unwrapLinkHtml(rawLink) { return (0, preview_extract_1.xmlUnescape)(rawLink).replace(/<[^<>]*>/g, "");' },
    { id: 'K6', label: 'K6 defectKey', file: 'modules/course-workshop/patch/engine.js', find: /beforeSpacedDash\(f\.detail\)/, repl: "f.detail.replace(/\\s+—[\\s\\S]*$/, '')" },
    { id: 'K6', label: 'K6 OPEN_A', file: 'modules/course-workshop/patch/html-edit.js', find: /for \(const a of \(0, xml_scan_1\.openTags\)\(html, \/<a\\b\/i\)\) \{/, repl: 'for (const a of [...html.matchAll(/<a\\b(?:[^>"\']|"[^"]*"|\'[^\']*\')*>/gi)].map((m) => ({ start: m.index, end: m.index + m[0].length, attrs: (0, xml_scan_1.parseAttrs)(m[0], 2) }))) {' },
    { id: 'K7', file: 'modules/course-workshop/quality/docs.js', find: /return \(0, xml_scan_1\.replaceMarkWithWs\)\(/, repl: 'return ((s) => s.replace(/ ?\\uE000 ?/g, "\\n"))(' },
    { id: 'K3', file: 'modules/course-workshop/quality/ask.js', find: /if \(truncated && o\.verdict === 'no'\)/, repl: 'if (false)' },
  ];
  let bad = 0;
  for (const b of bites) {
    const tmp = fs.mkdtempSync(path.join(REPO, '.r107-b12-bite-')); // dentro del repo: resuelve node_modules
    try {
      fs.cpSync(DIST, tmp, { recursive: true });
      const f = path.join(tmp, b.file);
      const src = fs.readFileSync(f, 'utf8');
      if (!b.find.test(src)) { console.log(`❌ bite ${b.id}: no encontré la guarda en ${b.file}`); bad++; continue; }
      fs.writeFileSync(f, src.replace(b.find, b.repl));
      const r = spawnSync(process.execPath, [__filename, '--ci', '--dist', tmp, '--only', b.id, ...(b.id === 'K4' ? ['--k4-small'] : [])], { encoding: 'utf8', timeout: 300_000 });
      if (r.status !== 0 && !/❌ /.test(r.stdout || '')) console.log(`   (bite ${b.id}: terminó sin informe: ${r.signal || r.status}) ${(r.stderr || "").slice(0, 600)}`);
      // Cuenta solo una falla DE LA PRUEBA (❌ <id>), no un error de carga.
      const failed = r.status !== 0 && new RegExp(`❌ ${b.id} `).test(r.stdout || '');
      console.log(`${failed ? '✅' : '❌'} bite ${b.label || b.id}: ${failed ? 'la prueba falla con la defensa rota' : 'la prueba NO detectó la ruptura'}`);
      if (!failed) bad++;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log(`\n${bad ? '❌' : '✅'} check-r107-hardening --bite: ${bites.length - bad}/${bites.length} rupturas detectadas`);
  process.exit(bad ? 1 : 0);
}

const L = (rel) => require(path.join(DIST, rel));

// K2 en un proceso aparte (RSS limpio: solo el lector y el modelo cargados). Imprime una línea JSON.
if (has('--child-bomb')) {
  (async () => {
    const R0 = L('modules/course-workshop/mbz-reader.js');
    const CM0 = L('modules/course-workshop/course-model.js');
    const mk = (N, SZ, randomTail) => {
      let acts = '';
      for (let i = 1; i <= N; i++) acts += `<activity><moduleid>${i}</moduleid><sectionid>1</sectionid><modulename>page</modulename><title>x</title><directory>activities/page_${i}</directory></activity>`;
      const files = [['moodle_backup.xml', Buffer.from(`<?xml version="1.0"?><moodle_backup><information><contents><activities>${acts}</activities><sections></sections></contents></information></moodle_backup>`)]];
      const big = Buffer.alloc(SZ, 0x20);
      if (randomTail) crypto.randomBytes(randomTail).copy(big, SZ - randomTail);
      const def = zlib.deflateRawSync(big, { level: 9 });
      const crc = zlib.crc32(big);
      for (let i = 1; i <= N; i++) files.push([`activities/page_${i}/module.xml`, big, def, crc]);
      return zip(files);
    };
    const peak = async (fn) => {
      let p = process.memoryUsage().rss;
      const iv = setInterval(() => { p = Math.max(p, process.memoryUsage().rss); }, 5);
      let err = null;
      try { await fn(); } catch (e) { err = e; }
      clearInterval(iv);
      return { peak: Math.max(p, process.memoryUsage().rss), code: err ? err.code || err.message : null };
    };
    const z = mk(140, 7 * 1024 * 1024, 0);
    const a = await peak(async () => { const pkg = await R0.openMbz(z); await CM0.readRawCourse(pkg, { family: 'v1-legacy', builderLine: 'x' }); });
    // razón total < 200×: 20 × 7,5 MB con 50 KB al azar cada uno (~130×) → abre; el presupuesto proporcional corta la lectura
    const z2 = mk(20, 7.5 * 1024 * 1024, 50_000);
    const b = await peak(async () => { const pkg = await R0.openMbz(z2); if (pkg.readBudgetBytes !== R0.readBudgetFor(z2.length)) throw new Error('presupuesto no proporcional'); await CM0.readRawCourse(pkg, { family: 'v1-legacy', builderLine: 'x' }); });
    console.log(JSON.stringify({ a: { ...a, size: z.length }, b: { ...b, ratio: (20 * 7.5 * 1048576) / z2.length } }));
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
  return;
}
require(path.join(REPO, 'node_modules/@nestjs/common')).Logger.overrideLogger(false);
const R = L('modules/course-workshop/mbz-reader.js');
const ID = L('modules/course-workshop/identify.js');
const CM = L('modules/course-workshop/course-model.js');
const INV = L('modules/course-workshop/inventory.js');
const DX = L('modules/course-workshop/diagnosis/diagnose.js');
const XS = L('modules/course-workshop/xml-scan.js');
const SVC = L('modules/course-workshop/course-workshop.service.js');
const QL = L('modules/course-workshop/quality/ask.js');
const QT = L('modules/course-workshop/quality/types.js');

let ok = 0;
let fail = 0;
async function check(id, name, fn) {
  if (ONLY && ONLY !== id) return;
  try { await fn(); ok++; console.log(`✅ ${id} ${name}`); } catch (e) { fail++; console.log(`❌ ${id} ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); };

// ZIP mínimo (DEFLATE) — mismo armado que los repros del revisor.
function zip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const f of files) {
    const [name, data] = f; const def = f[2] || zlib.deflateRawSync(data); const crc = f[3] ?? zlib.crc32(data); const nb = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc >>> 0, 14); h.writeUInt32LE(def.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26);
    locals.push(h, nb, def);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc >>> 0, 16); c.writeUInt32LE(def.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    centrals.push(c, nb); off += 30 + nb.length + def.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

/** Mide `fn` con un temporizador de 50 ms: tiempo y ticks del event loop durante la medición (await entre pasos). */
async function timed(fn) {
  let ticks = 0;
  const iv = setInterval(() => ticks++, 50);
  const t0 = Date.now();
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 120)); // el loop sigue vivo después
  clearInterval(iv);
  return { ms, ticks, err };
}

(async () => {
  // ── K1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await check('K1', 'H1: tags abiertos sin cierre (400 KB y 7,9 MB) → identificación, inventario y diagnóstico < 2 s; el event loop avanza', async () => {
    const OPENERS = ['<sections>', '<section>', '<contents>', '<activities>', '<activity>', '<file id="1">', '<question_category id="1">', '<question id="1">', '<chapter id="1">', '<!--', '<script>', '<a href="#">', '<h2>', '<sco id="1">', '<setting>', '<intro>'];
    const unit = OPENERS.join('');
    const report = [];
    for (const kb of [400, 7900]) {
      const n = Math.ceil((kb * 1024) / unit.length);
      const junk = unit.repeat(n);
      const mbHead = '<?xml version="1.0"?><moodle_backup><information><name>x.mbz</name><original_course_fullname>Curso</original_course_fullname>';
      const goodActs = '<contents><activities><activity><moduleid>7</moduleid><sectionid>1</sectionid><modulename>page</modulename><title>P</title><directory>activities/page_7</directory></activity></activities><sections><section><sectionid>1</sectionid><title>S</title><directory>sections/section_1</directory></section></sections></contents>';
      const variants = {
        // todo el moodle_backup.xml abierto (el repro: <sections> repetido)
        'moodle_backup abierto': [['moodle_backup.xml', Buffer.from(mbHead + junk)]],
        // moodle_backup válido; files.xml / questions.xml / la actividad y su HTML abiertos
        'files/questions/actividad abiertos': [
          ['moodle_backup.xml', Buffer.from(`${mbHead}${goodActs}</information></moodle_backup>`)],
          ['files.xml', Buffer.from(`<?xml version="1.0"?><files>${junk}`)],
          ['questions.xml', Buffer.from(`<?xml version="1.0"?><question_categories>${junk}`)],
          ['sections/section_1/section.xml', Buffer.from(`<section id="1"><number>1</number><name>S</name><summary>${junk}`)],
          ['activities/page_7/module.xml', Buffer.from(`<module id="7"><sectionid>1</sectionid>${junk}`)],
          // el HTML (escapado en el XML) también abierto; < 8 MB por entrada (bajo el control de razón por entrada)
          ['activities/page_7/page.xml', Buffer.from(`<activity id="7" moduleid="7" modulename="page" contextid="70"><page id="7"><name>P</name><intro>${junk.slice(0, Math.floor(junk.length * 0.4)).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</intro><content>x</content></page></activity>`)],
        ],
      };
      for (const [label, files] of Object.entries(variants)) {
        const buf = zip(files);
        const pkg = await R.openMbz(buf);
        const t1 = await timed(() => ID.readPackageFacts(pkg, 'x.mbz').catch((e) => { if (!(e instanceof ID.PackageFactsError)) throw e; }));
        const t2 = await timed(() => INV.buildInventory(pkg, { family: 'v1-legacy', builderLine: 'legacy-v1', builderVersion: null }));
        const t3 = await timed(async () => { const p2 = await R.openMbz(buf); await DX.runTechnicalDiagnosis({ pkg: p2, packageBytes: buf, family: 'v1-legacy', builderLine: 'legacy-v1', builderVersion: null, expectations: null, expectationsReason: 'check' }, { prevalidateFixes: false }); });
        for (const [what, t] of [['identificación', t1], ['inventario', t2], ['diagnóstico', t3]]) {
          report.push(`${kb} KB ${label} ${what}: ${t.ms} ms, ${t.ticks} ticks`);
          if (t.err && !(t.err instanceof R.MbzReaderError)) throw new Error(`${kb} KB ${label} ${what}: error inesperado ${t.err && t.err.message}`);
          assert(t.ms < 2000, `${kb} KB ${label} ${what}: ${t.ms} ms (≥ 2 s): el escaneo no es lineal`);
          assert(t.ticks >= 1, `${kb} KB ${label} ${what}: el event loop no avanzó`);
        }
      }
    }
    console.log(`   ${report.filter((_, i) => i % 3 === 0 || /7900/.test(report[i])).slice(0, 6).join('\n   ')}`);
  });

  await check('K1', 'H1b: el escaneo lineal = la regex perezosa de antes (4000 textos al azar, bien y mal formados)', async () => {
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const PIECES = ['<x>', '</x>', '<y>', '</y>', 'a', ' ', '<file id="3">', '</file>', '<style>', '</style>', '<script a>', '</script >', '<!--', '-->', '<h2 c>', '</h2>', '<h3>', '</h3>'];
    const make = () => Array.from({ length: Math.floor(rnd() * 30) }, () => PIECES[Math.floor(rnd() * PIECES.length)]).join('');
    for (let i = 0; i < 4000; i++) {
      const t = make();
      const lazy = (re) => [...t.matchAll(re)].map((m) => [m.index, m[0]]);
      eq(XS.allBlocks(t, '<x>', '</x>').map((b) => [b.start, b.whole]), lazy(/<x>([\s\S]*?)<\/x>/g), `x: ${t}`);
      eq(XS.matchBlocks(t, /<file id="(\d+)">/, '</file>').map((m) => [m.index, m[0], m[1], m[2]]), [...t.matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g)].map((m) => [m.index, m[0], m[1], m[2]]), `file: ${t}`);
      eq(XS.matchBlocks(t, /<(style|script)\b/i, (o) => new RegExp(`</${o[1]}\\s*>`, 'i')).map((m) => [m.index, m[0]]), lazy(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi), `style/script: ${t}`);
      eq(XS.matchBlocks(t, /<h([1-3])\b[^<>]*>/i, (o) => new RegExp(`</h${o[1]}\\s*>`, 'i')).map((m) => [m.index, m[0], m[1], m[2]]), [...t.matchAll(/<h([1-3])\b[^<>]*>([\s\S]*?)<\/h\1\s*>/gi)].map((m) => [m.index, m[0], m[1], m[2]]), `h: ${t}`);
      eq(XS.replaceBlocks(t, '<!--', '-->', () => ' '), t.replace(/<!--[\s\S]*?-->/g, ' '), `comment: ${t}`);
      eq(XS.tagInner(t, 'y'), (/<y>([\s\S]*?)<\/y>/.exec(t) || [])[1] ?? null, `tagInner: ${t}`);
    }
  });

  // ── K2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const bombPkg = (N, SZ) => {
    let acts = '';
    for (let i = 1; i <= N; i++) acts += `<activity><moduleid>${i}</moduleid><sectionid>1</sectionid><modulename>page</modulename><title>x</title><directory>activities/page_${i}</directory></activity>`;
    const files = [['moodle_backup.xml', Buffer.from(`<?xml version="1.0"?><moodle_backup><information><contents><activities>${acts}</activities><sections></sections></contents></information></moodle_backup>`)]];
    const big = Buffer.alloc(SZ, 0x20);
    const def = zlib.deflateRawSync(big, { level: 9 });
    const crc = zlib.crc32(big);
    for (let i = 1; i <= N; i++) files.push([`activities/page_${i}/module.xml`, big, def, crc]);
    return zip(files);
  };
  const peakOf = async (fn) => {
    let peak = process.memoryUsage().rss;
    const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
    let err = null;
    try { await fn(); } catch (e) { err = e; }
    clearInterval(iv);
    return { peak: Math.max(peak, process.memoryUsage().rss), err };
  };
  await check('K2', 'H2: bomba 1 MB → 140 × 7 MB rechazada al abrir (zip_bomb) sin pasar de 300 MB de RSS; razón < 200× → el presupuesto proporcional corta la lectura', async () => {
    const r = spawnSync(process.execPath, [__filename, '--ci', '--child-bomb', '--dist', DIST], { encoding: 'utf8', timeout: 300_000 });
    const line = (r.stdout || '').trim().split('\n').pop();
    let out;
    try { out = JSON.parse(line); } catch { throw new Error(`proceso de la bomba: ${r.status} ${(r.stderr || '').slice(0, 300)}`); }
    console.log(`   bomba ${out.a.size} B: ${out.a.code}, RSS pico ${Math.round(out.a.peak / 1048576)} MB · razón ${Math.round(out.b.ratio)}×: ${out.b.code}, RSS pico ${Math.round(out.b.peak / 1048576)} MB`);
    assert(out.a.code === 'zip_bomb', `bomba: ${out.a.code || 'abrió y leyó'}`);
    assert(out.b.ratio < 200, `el segundo paquete tiene que quedar bajo 200× (${Math.round(out.b.ratio)}×)`);
    assert(out.a.peak < 300 * 1048576, `bomba: RSS ${Math.round(out.a.peak / 1048576)} MB ≥ 300 MB`);
    // razón total < 200×: se abre, pero leer más de max(64 MB, 4 × tamaño) se corta.
    assert(out.b.code === 'read_budget_exceeded' || out.b.code === 'zip_bomb', `razón ${Math.round(out.b.ratio)}×: ${out.b.code || 'leyó todo'}`);
    assert(out.b.peak < 300 * 1048576, `razón ${Math.round(out.b.ratio)}×: RSS ${Math.round(out.b.peak / 1048576)} MB ≥ 300 MB`);
    eq([R.readBudgetFor(1e6), R.readBudgetFor(100 * 1048576), R.readBudgetFor(300 * 1048576)], [64 * 1048576, 400 * 1048576, 1024 * 1048576], 'min(1 GB, max(64 MB, tamaño × 4))');
    // un error de bomba NO es reintentable (lo que el servicio guarda): mismo código que el lector
    const pe = new SVC.PackageExpansionError(3e9, 2e9);
    assert(R.isMbzReaderError(pe) && pe.code === 'zip_bomb', 'PackageExpansionError es zip_bomb');
  });

  await check('K2', 'H2b: la reserva FIFO se agranda tras abrir a max(comprimido × factor, min(total, presupuesto) × 2); expansión > presupuesto → zip_bomb', async () => {
    const svc = new SVC.CourseWorkshopService(null, null, null);
    svc.memoryBudgetBytes = 512 * 1048576;
    // 60 MB de XML declarado en ~0,1 MB comprimido (razón < 200 por debajo de 64 MB): antes reservaba 3 × 0,1 MB.
    const sp = Buffer.alloc(7.5 * 1048576, 0x20);
    const z = zip([['moodle_backup.xml', Buffer.from('<moodle_backup><information></information></moodle_backup>')], ...Array.from({ length: 8 }, (_, i) => [`files/${i}`, sp])]);
    const key = 'identify:k2';
    let reservedInside = 0;
    await svc.withMemory(key, z.length * SVC.IDENTIFY_MEMORY_FACTOR, async () => {
      const before = svc.reservedFor(key);
      assert(before === z.length * SVC.IDENTIFY_MEMORY_FACTOR, 'reserva inicial = comprimido × factor');
      const pkg = await svc.reserveForPackage(key, z, SVC.IDENTIFY_MEMORY_FACTOR);
      reservedInside = svc.reservedFor(key);
      eq(reservedInside, SVC.packageMemoryBytes(pkg, z.length, SVC.IDENTIFY_MEMORY_FACTOR), 'reserva = fórmula');
      assert(reservedInside >= 60 * 1048576 * 2, `reserva agrandada: ${reservedInside}`);
    });
    eq(svc.reservedMemoryBytes, 0, 'al terminar se suelta todo');
    // expansión por encima del presupuesto entero → zip_bomb (no reintentable)
    svc.memoryBudgetBytes = 64 * 1048576;
    let err = null;
    await svc.withMemory('identify:k2b', 1, async () => { await svc.reserveForPackage('identify:k2b', z, SVC.IDENTIFY_MEMORY_FACTOR); }).catch((e) => { err = e; });
    assert(err && err.code === 'zip_bomb' && R.isMbzReaderError(err), `expansión > presupuesto: ${err && err.code}`);
    eq(svc.reservedMemoryBytes, 0, 'sin fugas');
    // sin reserva previa con esa clave (quien llama no reservó) → no toma nada
    await svc.reserveForPackage('nadie', zip([['a', Buffer.from('x')]]), 3);
    eq(svc.reservedMemoryBytes, 0, 'sin clave previa no reserva');
  });


  // ── K4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await check('K4', 'fuzz hostil: 8 variantes × 10 lugares del paquete → identificar, inventario, diagnóstico, plan, motor y aplicar < 2 s cada uno', async () => {
    const JSZip = require(path.join(REPO, 'node_modules/jszip'));
    const CF = require(path.join(REPO, 'scripts/r107/lib/r107-chapter-fixtures.js'));
    const B = L('modules/course-workshop/plan/builder.js');
    const EN = L('modules/course-workshop/patch/engine.js');
    const AC = L('modules/course-workshop/apply/apply-core.js');
    const DRY = L('modules/pedagogy/dry-run.js');
    const PRICING = DRY.seedPricing();
    const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
    const xesc = (h) => h.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // --k4-small (solo la mordida): 25 K espacios, para que la versión cuadrática falle en segundos y no en minutos.
    const S = ' '.repeat(has('--k4-small') ? 25_000 : 100_000);
    const VARIANTS = {
      'comilla sin cerrar': `<p>x</p><a href="${S}>b</a><img alt='${S.slice(0, 20000)}><div class="${S.slice(0, 20000)}`,
      'aperturas sin >': ['<a ', '<img ', '<iframe ', '<h1 ', '<h2 ', '<h3 ', '<h4 ', '<h5 ', '<h6 ', '<script ', '<style '].join('').repeat(1500),
      'espacios + —': `x${S}—y`,
      'espacios + "': `x${S}"`,
      '$@ sin cierre': `${'$@'.repeat(20000)}${'$@PAGEVIEWBYID*'.repeat(2000)}`,
      'javascript: + espacios': `<a href="javascript:${S}">b</a>`,
      'javascript: sin comilla': `<a href="javascript:${S}>b`,
      'mezcla': `<h2 ${S.slice(0, 30000)}<a href="#${S.slice(0, 30000)}<script>${'<style>'.repeat(3000)}`,
    };
    const base = await CF.v1BuilderCourse(DIST, {});
    const z0 = await JSZip.loadAsync(base);
    const names = Object.keys(z0.files).filter((n) => !z0.files[n].dir);
    const labels = names.filter((n) => /^activities\/label_\d+\/label\.xml$/.test(n));
    const target = labels[1], victim = labels[2];
    const targetMid = Number(/label_(\d+)/.exec(target)[1]), victimMid = Number(/label_(\d+)/.exec(victim)[1]);
    const section = names.find((n) => /^sections\/section_\d+\/section\.xml$/.test(n));
    const filesXml = await z0.file('files.xml').async('string');
    const libroBlk = XS.matchBlocks(filesXml, /<file id="(\d+)">/, '</file>').find((m) => /<component>mod_resource<\/component>/.test(m[2]) && /<filename>[^<]*\.html<\/filename>/.test(m[2]));
    assert(libroBlk, 'el fixture trae el Libro Guía HTML');
    const libroHash = /<contenthash>([0-9a-f]{40})<\/contenthash>/.exec(libroBlk[2])[1];
    const insertAfterOpen = (xml, h) => { const k = xml.indexOf('>', xml.indexOf('<', xml.indexOf('?>') + 2)) + 1; return xml.slice(0, k) + h + xml.slice(k); };
    const PLACES = {
      'moodle_backup.xml (XML)': async (z, h) => z.file('moodle_backup.xml', (await z.file('moodle_backup.xml').async('string')).replace('<information>', `<information>${h}`)),
      'files.xml (XML)': async (z, h) => z.file('files.xml', insertAfterOpen(await z.file('files.xml').async('string'), h)),
      'section.xml (XML)': async (z, h) => z.file(section, insertAfterOpen(await z.file(section).async('string'), h)),
      'section.xml (resumen HTML)': async (z, h) => z.file(section, (await z.file(section).async('string')).replace(/<summary>/, `<summary>${xesc(h)}`)),
      'module.xml (XML)': async (z, h) => { const m = target.replace('label.xml', 'module.xml'); z.file(m, insertAfterOpen(await z.file(m).async('string'), h)); },
      'label.xml (XML)': async (z, h) => z.file(target, insertAfterOpen(await z.file(target).async('string'), h)),
      'label.xml (HTML)': async (z, h) => z.file(target, (await z.file(target).async('string')).replace('<intro>', `<intro>${xesc(h)}`)),
      'questions.xml (XML)': async (z, h) => z.file('questions.xml', insertAfterOpen(await z.file('questions.xml').async('string'), h)),
      'questions.xml (enunciado)': async (z, h) => z.file('questions.xml', (await z.file('questions.xml').async('string')).replace('<questiontext>', `<questiontext>${xesc(h)}`)),
      'Libro Guía (HTML)': async (z, h) => {
        const old = `files/${libroHash.slice(0, 2)}/${libroHash}`;
        const html = (await z.file(old).async('string')).replace('</body>', `${h}</body>`);
        const buf = Buffer.from(html, 'utf8');
        const nh = sha1(buf);
        z.remove(old);
        z.file(`files/${nh.slice(0, 2)}/${nh}`, buf);
        z.file('files.xml', (await z.file('files.xml').async('string')).split(libroHash).join(nh).replace(new RegExp(`(<contenthash>${nh}</contenthash>[\\s\\S]{0,400}?<filesize>)\\d+`), (_m, a) => `${a}${buf.length}`));
      },
    };
    const ops = [{ op: 'edit_html', target: { moduleId: targetMid, field: 'intro' }, change: { kind: 'replace', html: '<p>Texto nuevo</p>' } }, { op: 'remove_activity', moduleId: victimMid }];
    const slow = [];
    let cases = 0;
    let worst = { ms: 0, what: '' };
    for (const [vName, h] of Object.entries(VARIANTS)) {
      for (const [pName, put] of Object.entries(PLACES)) {
        const z = await JSZip.loadAsync(base);
        await put(z, h);
        const buf = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
        const steps = {
          identificar: async () => { const pkg = await R.openMbz(buf); await ID.readPackageFacts(pkg, 'x.mbz'); },
          inventario: async () => { const pkg = await R.openMbz(buf); await INV.buildInventory(pkg, { family: 'v1-legacy-hvp', builderLine: 'legacy-v1', builderVersion: null }); },
          diagnóstico: async () => { const pkg = await R.openMbz(buf); await DX.runTechnicalDiagnosis({ pkg, packageBytes: buf, family: 'v1-legacy-hvp', builderLine: 'legacy-v1', builderVersion: null, expectations: null, expectationsReason: 'check' }); },
          plan: async () => { await B.openBuildCtx(buf, { originalSha1: sha1(buf), pricing: PRICING }); },
          motor: async () => { await EN.applyPatchPlan({ original: buf, filename: 'x.mbz', operations: ops }); },
          aplicar: async () => { await AC.runApply({ original: buf, expectedSha1: sha1(buf), items: ops.map((o, i) => ({ id: `i${i}`, requestId: `r${i}`, operation: o.op, quote: '', summary: '', params: o })) }); },
        };
        for (const [sName, fn] of Object.entries(steps)) {
          const t0 = Date.now();
          try { await fn(); } catch (e) { /* una falla limpia vale: lo que se mide es el tiempo */ }
          const ms = Date.now() - t0;
          cases++;
          if (ms > worst.ms) worst = { ms, what: `${vName} · ${pName} · ${sName}` };
          if (ms >= 2000) slow.push(`${vName} · ${pName} · ${sName}: ${ms} ms`);
          if (slow.length) break;
        }
        if (slow.length) break;
      }
      if (slow.length) break;
    }
    console.log(`   ${cases} casos; el más lento: ${worst.ms} ms (${worst.what})`);
    assert(!slow.length, `≥ 2 s: ${slow.join('; ')}`);
  });


  // ── K5–K7 (B12 ronda 2) ────────────────────────────────────────────────────────────────────────────────────────
  const JSZ = require(path.join(REPO, 'node_modules/jszip'));
  const CFX = require(path.join(REPO, 'scripts/r107/lib/r107-chapter-fixtures.js'));
  const xmlEsc = (h) => h.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const withLabelHtml = async (labelNo, html, labelHtmlTail = '') => {
    const z = await JSZ.loadAsync(await CFX.v1BuilderCourse(DIST, {}));
    const labels = Object.keys(z.files).filter((n) => /^activities\/label_\d+\/label\.xml$/.test(n));
    const entry = labels[labelNo];
    const x = await z.file(entry).async('string');
    z.file(entry, x.replace(/<intro>[^<]*<\/intro>/, () => `<intro>${xmlEsc(html)}${labelHtmlTail}</intro>`)); // función: `$&` del token no es un patrón
    return { buf: await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), entry, moduleId: Number(/label_(\d+)/.exec(entry)[1]) };
  };
  const introOf = async (buf, entry) => { const z = await JSZ.loadAsync(buf); const x = await z.file(entry).async('string'); return x.slice(x.indexOf('<intro>') + 7, x.indexOf('</intro>')).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'); };

  await check('K5', 'enlace muerto con `title="x < y"`: el HTML que se escribe es «Libro Guía» (helper y diagnóstico → motor)', async () => {
    const B = L('modules/course-workshop/plan/builder.js');
    const EN = L('modules/course-workshop/patch/engine.js');
    const LINK = '<a href="#" title="x < y">Libro Guía</a>';
    eq(B.unwrapLinkHtml(xmlEsc(LINK)), 'Libro Guía', 'helper');
    eq(B.unwrapLinkHtml(xmlEsc('<a href="#" data-x=\'a>b\'>Ver <b>más</b></a>')), 'Ver más', 'comillas simples con «>»');
    const { buf, entry, moduleId } = await withLabelHtml(3, `<p>Antes</p>${LINK}<p>Después</p>`);
    const pkg = await R.openMbz(buf);
    const rep = await DX.runTechnicalDiagnosis({ pkg, packageBytes: buf, family: 'v1-legacy-hvp', builderLine: 'legacy-v1', builderVersion: null, expectations: null, expectationsReason: 'check' }, { prevalidateFixes: false });
    const f = rep.findings.find((x) => x.code === 'dead_link' && x.suggestedFix && x.suggestedFix.params.moduleId === moduleId);
    assert(f, `el diagnóstico ve el enlace muerto: ${rep.findings.map((x) => x.code).join(', ')}`);
    const p = f.suggestedFix.params;
    const z = await JSZ.loadAsync(buf);
    const raw = Buffer.from(await z.file(p.entry).async('uint8array')).subarray(p.fieldRawOffset + p.linkRawByteOffset, p.fieldRawOffset + p.linkRawByteOffset + p.linkRawBytes).toString('utf8');
    const html = B.unwrapLinkHtml(raw);
    eq(html, 'Libro Guía', 'el reemplazo que arma el plan');
    const res = await EN.applyPatchPlan({ original: buf, filename: 'x.mbz', operations: [{ op: 'edit_html', target: { moduleId, field: 'intro' }, expectRawSha1: p.fieldRawSha1, change: { kind: 'range', rawByteOffset: p.linkRawByteOffset, rawBytes: p.linkRawBytes, html } }] });
    assert(res.ok, `el motor aplica: ${res.failure && res.failure.message}`);
    eq(await introOf(res.package, entry), '<p>Antes</p>Libro Guía<p>Después</p>', 'el paquete queda con el texto, sin restos de la etiqueta');
  });

  await check('K6', '400 KB que llegan a defectKey (por la compuerta del motor) y al desenlace de un token (`<a` sin `>`) → < 2 s', async () => {
    const EN = L('modules/course-workshop/patch/engine.js');
    // a) hallazgo dead_link cuyo detalle trae 400 K espacios ANTES del «—» (el destino conserva los espacios del medio).
    const a = await withLabelHtml(3, `<p>x</p><a href="javascript:${' '.repeat(400_000)}x">b</a>`);
    let t0 = Date.now();
    const r1 = await EN.applyPatchPlan({ original: a.buf, filename: 'x.mbz', operations: [{ op: 'edit_html', target: { moduleId: a.moduleId, field: 'intro' }, change: { kind: 'replace', html: '<p>Otro texto</p>' } }] });
    const ms1 = Date.now() - t0;
    const pkg1 = await R.openMbz(a.buf);
    const rep = await DX.runTechnicalDiagnosis({ pkg: pkg1, packageBytes: a.buf, family: 'v1-legacy-hvp', builderLine: 'legacy-v1', builderVersion: null, expectations: null, expectationsReason: 'check' }, { prevalidateFixes: false });
    const big = rep.findings.find((x) => x.code === 'dead_link' && x.detail.length > 400_000);
    assert(big, 'el diagnóstico arma el hallazgo con el detalle de 400 K');
    t0 = Date.now();
    const k = EN.defectKey(big);
    const ms1b = Date.now() - t0;
    assert(!k.includes('—'), 'la clave corta en el «—»');
    console.log(`   defectKey: compuerta ${ms1} ms (ok=${r1.ok}), directo ${ms1b} ms`);
    assert(ms1 < 2000 && ms1b < 2000, `defectKey ≥ 2 s (compuerta ${ms1} ms, directo ${ms1b} ms)`);
    // b) quitar el enlace de un token con 400 KB de `<a ` sin `>` después.
    const TOKEN = '$@RESOURCEVIEWBYID*961@$';
    const b = await withLabelHtml(3, `<p><a href="${TOKEN}">Descargar</a></p>`, xmlEsc('<a '.repeat(133_000)));
    t0 = Date.now();
    const r2 = await EN.applyPatchPlan({ original: b.buf, filename: 'x.mbz', operations: [{ op: 'edit_html', target: { moduleId: b.moduleId, field: 'intro' }, change: { kind: 'token', token: TOKEN, action: 'unlink' } }] });
    const ms2 = Date.now() - t0;
    console.log(`   desenlace del token: ${ms2} ms (ok=${r2.ok}${r2.ok ? '' : `, ${r2.failure && r2.failure.code}`})`);
    assert(r2.ok || (r2.failure && r2.failure.code === 'invalid_content'), `el desenlace llegó al escaneo de enlaces: ${r2.failure && r2.failure.code} ${r2.failure && r2.failure.message}`);
    assert(ms2 < 2000, `desenlace ≥ 2 s (${ms2} ms)`);
  });

  await check('K7', 'blockText = la versión con `\\s*\\uE000\\s*` (3000 HTML al azar con &#10;, &#9;, &nbsp;, <br>, </p>…)', async () => {
    const D = L('modules/course-workshop/quality/docs.js');
    const BLOCK_END = /<\/(?:p|div|h[1-6]|li|tr|td|th|section|article|header|footer|blockquote|figcaption|dt|dd)\s*>|<br\s*\/?>|<hr\b[^<>]*>/gi;
    const ref = (html, max = 1e9) => D.decodeEntities(CM.plainText(String(html).replace(BLOCK_END, (m) => `${m}\uE000`), max * 2)).replace(/[^\S\n\uE000]+/g, ' ').replace(/\s*\uE000\s*/g, '\n').replace(/\n{2,}/g, '\n').trim().slice(0, max);
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const P = ['a', 'b', ' ', '  ', '\n', '&#10;', '&#9;', '&nbsp;', '&#13;', '<p>', '</p>', '<br>', '<br/>', '</li>', '<div>', '</div>', '&#10;&#10;', ' &#10; ', '&amp;', 'é'];
    for (let i = 0; i < 3000; i++) {
      const h = Array.from({ length: Math.floor(rnd() * 25) }, () => P[Math.floor(rnd() * P.length)]).join('');
      eq(D.blockText(h), ref(h), `blockText ${JSON.stringify(h)}`);
    }
    eq(D.blockText('<p>uno&#10;&#10; </p> &#10; <p>dos</p>'), 'uno\ndos', '`&#10;` junto a la marca');
    const t0 = Date.now();
    D.blockText(`<p>x${'&#10; '.repeat(40_000)}</p>y`);
    assert(Date.now() - t0 < 2000, 'lineal');
  });

  // ── K3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const askFixture = (nQ) => {
    const chapters = Array.from({ length: 9 }, (_, i) => ({ number: i + 1, moduleNumber: Math.floor(i / 3) + 1, title: 'C' + (i + 1), activities: [] }));
    const qs = Array.from({ length: nQ }, (_, i) => ({ id: 100 + i, chapterNumber: null }));
    const course = { chapters, modules: [], activities: [{ moduleId: 50, exam: { final: true, unit: null, questions: qs } }] };
    const docs = [];
    for (const c of chapters) for (let k = 0; k < 4; k++) docs.push({ key: `t${c.number}-${k}`, moduleId: 10 + c.number, questionId: null, chapterNumber: c.number, role: 'libro', what: 'libro', activityTitle: 'Libro', text: `Texto del capítulo ${c.number} sobre el tema de la ventilación mecánica número ${k}. `.repeat(8) });
    qs.forEach((q, i) => docs.push({ key: `q${q.id}`, moduleId: 50, questionId: q.id, chapterNumber: null, role: 'exam', what: 'pregunta', activityTitle: 'Evaluación final', text: `Pregunta ${i + 1} (tema del capítulo ${Math.floor(i / (nQ / 9)) + 1}): ¿Cuál es la respuesta correcta sobre el procedimiento ${i}? ${'Contexto largo del caso clínico. '.repeat(12)}` }));
    return { course, docs };
  };
  await check('K3', 'D3: examen de 40 preguntas (las del capítulo 9 al final) → llegan las 40, antes del capítulo, sin recorte; examen enorme → recorte dicho en el prompt y «no» → «parcial»', async () => {
    const { course, docs } = askFixture(40);
    const ev = QL.retrieveEvidence(course, docs, '¿El examen final cubre el capítulo 9?');
    const exam = ev.passages.filter((p) => p.role === 'exam');
    eq(exam.length, 40, 'todas las preguntas del examen');
    eq(exam[exam.length - 1].questionId, 139, 'incluye las del final (capítulo 9)');
    assert(exam.every((p) => p.text.length <= QT.QUALITY_LIMITS.askExamQuestionChars + 1), 'enunciado corto');
    const firstText = ev.passages.findIndex((p) => p.role !== 'exam');
    assert(firstText > 0 && ev.passages.slice(0, firstText).every((p) => p.role === 'exam'), 'las preguntas van ANTES del texto del capítulo');
    assert(ev.passages.some((p) => p.role !== 'exam' && p.chapterNumber === 9), 'texto del capítulo 9');
    eq(ev.truncated, false, 'sin recorte');
    assert(!/RECORTADA/.test(QL.askUser('C', 'q', ev.passages, ev.truncated)), 'sin aviso de recorte');
    // un «no» con evidencia completa se respeta
    const cite = { passageId: exam[0].id, quote: exam[0].text.slice(0, 40) };
    eq(QL.verifyAnswer({ verdict: 'no', answer: 'No lo cubre.', citations: [cite] }, ev.passages, ev.truncated).verdict, 'no', '«no» con todo a la vista');
    // examen enorme: no entra todo → recortado, el prompt lo dice, «no» baja a «parcial» con el aviso
    const big = askFixture(200);
    const ev2 = QL.retrieveEvidence(big.course, big.docs, '¿El examen final cubre el capítulo 9?');
    eq(ev2.truncated, true, 'examen enorme recortado');
    assert(ev2.examQuestions && ev2.examQuestions.total === 200 && ev2.examQuestions.sent < 200, 'cuenta lo que entró');
    assert(/RECORTADA/.test(QL.askUser('C', 'q', ev2.passages, true)) && /RECORTADA/.test(QL.ASK_SYSTEM), 'el prompt avisa el recorte');
    const ex2 = ev2.passages.find((p) => p.role === 'exam');
    const a = QL.verifyAnswer({ verdict: 'no', answer: 'No lo cubre.', citations: [{ passageId: ex2.id, quote: ex2.text.slice(0, 40) }] }, ev2.passages, true);
    eq(a.verdict, 'parcial', '«no» con evidencia recortada → parcial');
    assert(a.answer.includes(QL.TRUNCATED_NOTE), 'con el aviso para el docente');
  });

  console.log(`\n${fail ? '❌' : '✅'} check-r107-hardening --ci: ${ok}/${ok + fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
