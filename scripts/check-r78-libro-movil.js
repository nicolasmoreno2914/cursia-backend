#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * r78 — «Libro Guía en el celular»: el paquete trae, junto al PDF, una versión de LECTURA EN LÍNEA del Libro Guía (libro de
 * Moodle, mod_book) con EXACTAMENTE el texto del PDF. Sin IA, sin red, USD 0. Cursos sintéticos (`lib/r78-libro-fixtures.js`):
 * 7 estilos + marca propia con un Libro rico (todas las formas del parser) y un curso GRANDE (9 capítulos, ≈ 150 páginas).
 *
 *   B1 paquetes: los 9 cursos arman y pasan el validador v3; la sección 1 = ruta → recurso PDF → libro en línea → …; el
 *      libro tiene portada e índice + un capítulo por módulo + los capítulos de contenido como subcapítulos (+ referencias);
 *      la tarjeta del Libro trae «Abrir Libro Guía →» (PDF, pestaña nueva) y «Leer en el celular →» (libro)
 *   B2 PARIDAD con el PDF REAL (pdfjs): por sección del PDF (portada, índice, cada módulo, cada capítulo, referencias), el
 *      texto que el PDF dibuja (sin encabezado, pie ni números del índice) = el texto visible del capítulo en línea (título
 *      que pinta Moodle + contenido, sin la navegación), letra por letra tras la normalización del PDF. Nada se omite
 *   B3 completo: el curso grande queda entero en línea (todos sus capítulos, todas sus palabras); sin recortes por tamaño
 *   B4 el validador se pone ROJO si falta el libro, si un capítulo queda truncado, si un enlace apunta a un capítulo que no
 *      existe o si la tarjeta pierde «Leer en el celular»
 *   B5 render SIN Moodle (gate-core, Chrome headless con emulación móvil) de cada capítulo en 320/375/390/768/1280 px, en
 *      los dos regímenes de Moodle («guardado» con <style>; «limpio» = forceclean / app: solo lo que deja HTMLPurifier):
 *      sin desborde, texto corrido ≥ 16 px (cuerpo 18 px, interlineado ≥ 1,5), contraste AA, áreas táctiles ≥ 44 px
 *   B6 (--base=<dist de origin/staging>) el PDF y todo archivo de contenido idénticos; solo cambian la tarjeta del Libro
 *      (mismo texto + la frase y el botón nuevos) y la actividad nueva
 *   B7 (--moodle) restauración REAL en Moodle 4.5 local; Playwright (Chromium Android 320/390, WebKit iPhone 375/390,
 *      escritorio 1280) con «Limpiar contenido» apagado y encendido: cada capítulo del libro (paridad con el PDF en la
 *      página real, mediciones, navegación «Siguiente» de verdad), la tarjeta → libro, y lo que recibe la app oficial
 *      (core_course_get_contents + index.html de cada capítulo). Capturas por estilo (teléfono y escritorio)
 *
 * Uso: npm run build && node scripts/check-r78-libro-movil.js [--base=<dist>] [--moodle [--out=<dir>] [--styles=a,b]
 *        [--devices=a,b] [--keep] [--no-fail]]
 */
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const realFetch = global.fetch;
global.fetch = async (u, o) => { if (/^http:\/\/127\.0\.0\.1[:/]/.test(String(u))) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const ROOT = path.resolve(__dirname, '..');
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const dist = path.resolve(arg('dist') || path.join(ROOT, 'dist'));
const L = (r) => require(path.join(dist, r));
const BASE = arg('base');
const MOODLE = process.argv.includes('--moodle');
const NO_FAIL = process.argv.includes('--no-fail');
const OUT = arg('out') || path.join(os.tmpdir(), 'r78-libro-movil-out');
const ONLY = arg('styles') ? arg('styles').split(',') : null;
const B = L('package/dynamic-mbz-builder-v3.js');
const VAL = L('package/v3/mbz-validator-v3.js');
const MEDIA = L('package/v3/synthetic-media.js');
const PX = L('modules/visual-design/preview-extract.js');
const LB = L('package/v3/libro-v3.js');
const LH = L('package/v3/libro-html-v3.js');
const F = require('./lib/r78-libro-fixtures');
const M = require('./lib/r77-mobile-measure');
const JSZip = require('jszip');

let passes = 0;
let failures = 0;
const evidence = { generatedAt: new Date().toISOString(), dist, courses: {}, parity: {}, render: {}, moodle: {} };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  const t = Date.now();
  try { await fn(); passes++; console.log(`✅ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${String(e.stack || e).slice(0, 6000)}`); }
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const WIDTHS = [320, 375, 390, 768, 1280];
const STYLES = [...F.STYLES, F.customStyle(MEDIA)].filter((s) => !ONLY || ONLY.includes(s.key));
const LARGE = { key: 'grande', label: 'Curso grande (9 capítulos, Técnico oscuro)', profile: F.STYLES.find((s) => s.key === 'tecnico-oscuro').profile };

const validate = (b) => VAL.validateMbzV3(b.mbz, {
  facts: b.expectations.facts, resolved: b.expectations.resolved, examBankPlans: b.expectations.examBankPlans, shellProseByLabel: b.expectations.shellProseByLabel,
  builderVersion: b.expectations.builderVersion, moodleMinimum: b.expectations.moodleMinimum, internalVocabularyExempt: b.expectations.internalVocabularyExempt,
  internalVocabularyUserTexts: b.expectations.internalVocabularyUserTexts, ...(b.expectations.audiobookLinks ? { audiobookLinks: b.expectations.audiobookLinks } : {}),
});

/** Flujo de letras y dígitos (normalización del PDF): igual = mismo texto, sin importar dónde corta cada renglón. */
const stream = (s) => LB.libroParityWords(s).join('').replace(/[-'’]/g, '');
const firstDiff = (a, b) => { let k = 0; while (k < a.length && a[k] === b[k]) k++; return k; };
const around = (s, k) => s.slice(Math.max(0, k - 40), k + 40);

// ── PDF → texto por sección (pdfjs) ───────────────────────────────────────
let pdfjs;
async function pdfSections(buf) {
  pdfjs = pdfjs || (await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs', { paths: [ROOT] })));
  const sf = path.join(path.dirname(require.resolve('pdfjs-dist/package.json', { paths: [ROOT] })), 'standard_fonts') + '/';
  const d = await pdfjs.getDocument({ data: new Uint8Array(buf), standardFontDataUrl: sf, verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= d.numPages; p++) {
    const tc = await (await d.getPage(p)).getTextContent();
    let out = '';
    let lastY = null;
    for (const it of tc.items) {
      const y = it.transform[5];
      const x = it.transform[4];
      if (p > 1 && (y > 735 || y < 60)) continue; // encabezado (título del curso · Libro Guía) y pie (Página X de Y)
      if (p > 1 && x > 470 && /^\d+$/.test(it.str.trim())) continue; // números de página del índice
      if (lastY !== null && Math.abs(y - lastY) > 1) out += ' ';
      out += it.str;
      if (it.hasEOL) out += ' ';
      lastY = y;
    }
    pages.push(out);
  }
  const dests = await d.getDestinations();
  const starts = [];
  for (const [key, v] of Object.entries(dests)) starts.push({ key, page: (await d.getPageIndex(v[0])) + 1 });
  starts.sort((a, b) => a.page - b.page);
  const sec = { portada: { pages: [pages[0]] }, indice: { pages: pages.slice(1, starts[0].page - 1) } };
  starts.forEach((s, i) => { sec[s.key] = { pages: pages.slice(s.page - 1, (starts[i + 1] ? starts[i + 1].page : d.numPages + 1) - 1) }; });
  return { sec, numPages: d.numPages };
}

/**
 * Texto de una sección del PDF. El PDF REPITE el encabezado de una tabla que sigue en la página siguiente: un encabezado
 * al inicio de una página se quita solo si el texto en línea, en ese mismo punto, no sigue con ese encabezado (es la copia).
 */
function pdfSectionStream(sec, theadStreams, onlineStream = null) {
  let out = '';
  sec.pages.forEach((p, i) => {
    let s = stream(p);
    if (i > 0) for (const h of theadStreams) if (h && s.startsWith(h) && (onlineStream === null || !onlineStream.startsWith(h, out.length))) { s = s.slice(h.length); break; }
    out += s;
  });
  return out;
}

/** Capítulos del libro en línea desde el .mbz. */
async function bookOf(mbz) {
  const acts = await PX.readMbzActivities(mbz);
  const book = acts.find((a) => a.idnumber === LH.LIBRO_HTML_IDNUMBER);
  const libro = acts.find((a) => a.idnumber === 'cv3:shell:libro');
  const pdf = libro && [...libro.files.values()].find((f) => f.mime === 'application/pdf');
  return { acts, book, libro, pdf: pdf && pdf.bytes };
}

const theads = (html) => [...html.matchAll(/<thead>([\s\S]*?)<\/thead>/g)].map((m) => stream(LH.libroHtmlVisibleText(m[1])));
const keyOfTitle = (title, i) => (i === 0 ? 'portada' : /^Módulo (\d+) — /.test(title) ? `mod-${/^Módulo (\d+)/.exec(title)[1]}` : /^Capítulo (\d+)\./.test(title) ? `cap-${/^Capítulo (\d+)/.exec(title)[1]}` : 'bibliografia');

/** Paridad de un libro (capítulos con html + título) contra las secciones del PDF. `htmlOf(ch)` = HTML visible del capítulo. */
function parityReport(chapters, pdfSec, htmlOf, titleOf) {
  const rows = [];
  chapters.forEach((ch, i) => {
    const key = keyOfTitle(ch.title, i);
    const sec = pdfSec[key];
    if (!sec) { rows.push({ key, ok: false, why: 'sin sección en el PDF' }); return; }
    const html = htmlOf(ch);
    const skip = [LH.LIBRO_HTML_NAV_CLASS, ...(i === 0 ? [LH.LIBRO_HTML_TOC_CLASS] : [])];
    // La portada no repite su título de Moodle («Portada e índice») en el PDF; los demás capítulos sí (eyebrow + título).
    const got = (i === 0 ? '' : stream(titleOf(ch))) + stream(LH.libroHtmlVisibleText(html, skip));
    const want = pdfSectionStream(sec, theads(html), got);
    const ok = got === want;
    const k = ok ? -1 : firstDiff(got, want);
    rows.push({ key, ok, chars: want.length, ...(ok ? {} : { at: k, online: around(got, k), pdf: around(want, k) }) });
    if (i === 0) {
      const tocHtml = (/<div class="cvc-libro-toc"[\s\S]*$/.exec(html) || [''])[0];
      const tg = stream(LH.libroHtmlVisibleText(tocHtml, [LH.LIBRO_HTML_NAV_CLASS]));
      const tw = pdfSectionStream(pdfSec.indice, [], tg);
      rows.push({ key: 'indice', ok: tg === tw, chars: tw.length, ...(tg === tw ? {} : { online: around(tg, firstDiff(tg, tw)), pdf: around(tw, firstDiff(tg, tw)) }) });
    }
  });
  const covered = new Set(rows.map((r) => r.key));
  for (const k of Object.keys(pdfSec)) if (!covered.has(k)) rows.push({ key: k, ok: false, why: 'sección del PDF sin capítulo en línea' });
  return rows;
}

const built = {};
(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // ── B1 ──────────────────────────────────────────────────────────────────
  await check(`B1 paquetes: ${STYLES.length} estilos + curso grande, validador v3, sección 1 y estructura del libro en línea, tarjeta con PDF + «Leer en el celular»`, async () => {
    for (const s of [...STYLES, LARGE]) {
      const input = s === LARGE ? F.largeCourseInput(dist, s.profile) : F.libroCourseInput(dist, s.profile);
      const b = await B.buildDynamicMbzV3(input);
      const v = await validate(b);
      assert(v.ok, `${s.key}: validador v3: ${JSON.stringify((v.issues || []).slice(0, 4))}`);
      const { acts, book, libro, pdf } = await bookOf(b.mbz);
      assert(book && book.modname === 'book' && book.chapters && book.chapters.length, `${s.key}: falta el libro en línea`);
      const s1 = acts.filter((a) => (a.dir || '').length >= 0).map((a) => a.idnumber);
      const iL = s1.indexOf('cv3:shell:libro');
      assert(s1[iL + 1] === LH.LIBRO_HTML_IDNUMBER, `${s.key}: el libro en línea va justo debajo del PDF (${s1.slice(iL - 1, iL + 3).join(', ')})`);
      const facts = b.expectations.facts;
      const contentCh = facts.chapters.filter((c) => c.kind !== 'practice');
      const want = 1 + facts.modules.length + contentCh.length;
      assert(book.chapters.length === want || book.chapters.length === want + 1, `${s.key}: ${book.chapters.length} capítulos en línea (se esperaban ${want}(+1))`);
      assert(book.chapters[0].title === LH.LIBRO_HTML_COVER_TITLE && !book.chapters[0].subchapter, `${s.key}: portada e índice primero`);
      for (const ch of book.chapters) assert(ch.subchapter === /^Capítulo \d+\./.test(ch.title), `${s.key}: «${ch.title}» subcapítulo=${ch.subchapter}`);
      const anchors = [...libro.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
      assert(anchors.length === 2, `${s.key}: la tarjeta del Libro tiene ${anchors.length} enlaces`);
      assert(anchors.some((x) => /Abrir Libro Guía/.test(x[2]) && x[1].includes(`$@RESOURCEVIEWBYID*${libro.moduleId}@$`) && /target="_blank"/.test(x[1])), `${s.key}: botón del PDF`);
      assert(anchors.some((x) => /Leer en el celular/.test(x[2]) && x[1].includes(`$@BOOKVIEWBYID*${book.moduleId}@$`) && !/target=/.test(x[1])), `${s.key}: botón «Leer en el celular» al libro (misma pestaña)`);
      assert(pdf && pdf.subarray(0, 5).toString() === '%PDF-', `${s.key}: el PDF sigue en el recurso`);
      assert(b.summary.libro.online && b.summary.libro.online.chapters === book.chapters.length, `${s.key}: resumen del paquete (libro.online)`);
      assert(b.expectations.builderVersion === '3.18.0', `${s.key}: builder 3.18.0`);
      built[s.key] = { mbz: b.mbz, book, libro, pdf, summary: b.summary, acts };
      evidence.courses[s.key] = { mbzBytes: b.mbz.length, pdfPages: b.summary.libro.pageCount, online: b.summary.libro.online, chapters: book.chapters.map((c) => c.title) };
      fs.mkdirSync(path.join(OUT, s.key), { recursive: true });
      fs.writeFileSync(path.join(OUT, s.key, 'curso.mbz'), b.mbz);
      fs.writeFileSync(path.join(OUT, s.key, 'libro.pdf'), pdf);
    }
  });
  if (!Object.keys(built).length) return finish();

  // ── B2 ──────────────────────────────────────────────────────────────────
  await check('B2 paridad con el PDF real (pdfjs): portada, índice, cada módulo, cada capítulo y referencias — mismo texto, letra por letra', async () => {
    const bad = [];
    for (const [k, c] of Object.entries(built)) {
      const { sec, numPages } = await pdfSections(c.pdf);
      const rows = parityReport(c.book.chapters, sec, (ch) => ch.html, (ch) => ch.title);
      evidence.parity[k] = { pdfPages: numPages, sections: rows.length, chars: rows.reduce((n, r) => n + (r.chars || 0), 0), rows: rows.filter((r) => !r.ok) };
      for (const r of rows) if (!r.ok) bad.push(`${k} ${r.key}: ${r.why || `difiere en el carácter ${r.at}\n      en línea …${r.online}…\n      PDF      …${r.pdf}…`}`);
      console.log(`   ${k}: ${rows.length} secciones, ${evidence.parity[k].chars} caracteres, ${numPages} páginas del PDF → ${rows.filter((r) => r.ok).length}/${rows.length} iguales`);
    }
    assert(bad.length === 0, `${bad.length} secciones distintas:\n   ${bad.slice(0, 8).join('\n   ')}`);
  });

  // ── B3 ──────────────────────────────────────────────────────────────────
  await check('B3 libro grande completo en línea (sin recortes por tamaño): todos los capítulos, todas las palabras del PDF', async () => {
    const c = built.grande;
    assert(c, 'falta el curso grande');
    const p = evidence.parity.grande;
    assert(p && p.pdfPages >= 100, `el PDF del curso grande tiene ${p && p.pdfPages} páginas (se espera ≥ 100)`);
    assert(c.book.chapters.length === 1 + 3 + 9 + 1, `capítulos en línea: ${c.book.chapters.length}`);
    for (const ch of c.book.chapters) assert(/<\/div>$/.test(ch.html) && ch.html.startsWith('<div class="cvc '), `«${ch.title}» completo`);
    const words = c.book.chapters.reduce((n, ch) => n + LB.libroParityWords(LH.libroHtmlVisibleText(ch.html)).length, 0);
    assert(words > 50000, `palabras en línea ${words}`);
    console.log(`   ${c.book.chapters.length} capítulos, ${words} palabras, HTML ${c.summary.libro.online.bytes} B, .mbz ${c.mbz.length} B`);
  });

  // ── B4 ──────────────────────────────────────────────────────────────────
  await check('B4 validador ROJO: sin libro, capítulo truncado, enlace a un capítulo inexistente, tarjeta sin «Leer en el celular»', async () => {
    const k = STYLES[0].key;
    const b = await B.buildDynamicMbzV3(F.libroCourseInput(dist, STYLES[0].profile));
    const zip0 = await JSZip.loadAsync(b.mbz);
    const bookDir = Object.keys(zip0.files).find((n) => /^activities\/book_\d+\/book\.xml$/.test(n));
    const libroDir = Object.keys(zip0.files).find((n) => /^activities\/resource_\d+\/resource\.xml$/.test(n) && n);
    const mutate = async (fn) => {
      const z = await JSZip.loadAsync(b.mbz);
      await fn(z);
      const mbz = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      return (await VAL.validateMbzV3(mbz, { ...b.expectations, ...(b.expectations.audiobookLinks ? { audiobookLinks: b.expectations.audiobookLinks } : {}) })).issues || [];
    };
    const codes = async (fn) => [...new Set((await mutate(fn)).map((i) => i.code))];
    const truncated = await codes(async (z) => { const x = await z.file(bookDir).async('string'); z.file(bookDir, x.replace(/(<content>[\s\S]{0,4000})[\s\S]*?(<\/content>)/, '$1$2')); });
    assert(truncated.includes('LIBRO_HTML'), `capítulo truncado → LIBRO_HTML (${truncated})`);
    const badTok = await codes(async (z) => { const x = await z.file(bookDir).async('string'); z.file(bookDir, x.replace(/BOOKVIEWBYIDCH\*(\d+)\*\d+@\$/, 'BOOKVIEWBYIDCH*$1*99999@$')); });
    assert(badTok.includes('TOKEN_INVALID'), `enlace a un capítulo inexistente → TOKEN_INVALID (${badTok})`);
    const noCta = await codes(async (z) => {
      for (const n of Object.keys(z.files).filter((x) => /^activities\/resource_\d+\/resource\.xml$/.test(x))) {
        const x = await z.file(n).async('string');
        if (x.includes('Leer en el celular')) z.file(n, x.replace(/&lt;a class=&quot;cvc-btn-link&quot; href=&quot;\$@BOOKVIEWBYID[\s\S]*?&lt;\/a&gt;/, ''));
      }
    });
    assert(noCta.includes('LIBRO_CTA'), `tarjeta sin «Leer en el celular» → LIBRO_CTA (${noCta})`);
    const noBook = await codes(async (z) => {
      const mb = await z.file('moodle_backup.xml').async('string');
      z.file('moodle_backup.xml', mb.replace(/<activity>\s*<moduleid>\d+<\/moduleid>\s*<sectionid>1<\/sectionid>\s*<modulename>book<\/modulename>[\s\S]*?<\/activity>\s*/, ''));
    });
    assert(noBook.includes('LIBRO_HTML') || noBook.includes('LIBRO_CTA') || noBook.includes('TOKEN_INVALID'), `sin libro → rojo (${noBook})`);
    void k; void libroDir;
    console.log(`   truncado: ${truncated.join(',')} · enlace roto: ${badTok.join(',')} · sin botón: ${noCta.join(',')} · sin libro: ${noBook.join(',')}`);
  });

  // ── B5 ──────────────────────────────────────────────────────────────────
  await check(`B5 render sin Moodle: ${STYLES.length} estilos × capítulos × ${WIDTHS.join('/')} px × guardado/limpio → sin desborde, cuerpo 18 px / interlineado ≥ 1,5, contraste AA, áreas táctiles ≥ 44 px`, async () => {
    const { launchChrome, sleep } = require('./lib/v21-cdp');
    const br = await launchChrome();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r78-render-'));
    const problems = [];
    let measured = 0;
    try {
      await br.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      for (const s of STYLES) {
        const c = built[s.key];
        for (const regime of ['guardado', 'limpio']) {
          // Como en Moodle: título del capítulo (h3 de Moodle) + contenido en su `.no-overflow`.
          const body = c.book.chapters.map((ch, i) => {
            const html = PX.displayableHtml({ html: ch.html, files: c.book.files });
            return `<section class="r78-ch" data-r77="${i}"><h3 style="font-size:1.4rem;margin:24px 0 12px">${ch.title.replace(/</g, '&lt;')}</h3><div class="no-overflow">${regime === 'limpio' ? M.purifyHtmlApprox(html) : html}</div></section>`;
          }).join('\n');
          const file = path.join(tmp, `${s.key}-${regime}.html`);
          fs.writeFileSync(file, `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;background:#fff;color:#1d2125;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:15px;line-height:1.5}.r78-wrap{padding:0 8px;max-width:830px;margin:0 auto}.no-overflow{overflow:auto}img{vertical-align:middle;border-style:none;max-width:100%;height:auto}</style></head><body><div class="r78-wrap">${body}</div></body></html>`);
          for (const w of WIDTHS) {
            const mobile = w < 768;
            await br.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: mobile ? 3 : 1, mobile });
            await br.send('Emulation.setUserAgentOverride', { userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36' : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36' });
            await br.navigate('file://' + file);
            await sleep(150);
            const m = await br.evaluate(M.measureExpr({}));
            const typo = await br.evaluate(`(() => {
              const ps = Array.from(document.querySelectorAll('.cvc-libro-online p, .cvc-libro-online li')).filter((p) => p.textContent.trim().length > 30 && !p.closest('.cvc-libro-nav') && !p.closest('.cvc-libro-toc') && !p.closest('.cvc-meta') && !p.closest('.cvc-identity'));
              let minFs = 99, minLh = 9, minBodyFs = 99;
              for (const p of ps) { const cs = getComputedStyle(p); const fs = parseFloat(cs.fontSize); const lh = cs.lineHeight === 'normal' ? 1.2 : parseFloat(cs.lineHeight) / fs; minFs = Math.min(minFs, fs); minLh = Math.min(minLh, lh); if (p.tagName === 'P' && !p.closest('table') && !p.closest('[style*="font-style:italic"]')) minBodyFs = Math.min(minBodyFs, fs); }
              return { n: ps.length, minFs, minLh: Math.round(minLh * 100) / 100, minBodyFs };
            })()`);
            for (const r of m.roots) {
              measured++;
              const v = M.verdictOfRoot(r);
              if (!v.pass) problems.push(`${s.key} ${regime} ${w}px «${c.book.chapters[Number(r.key)].title.slice(0, 40)}»: ${v.fails.join(' / ').slice(0, 400)}`);
            }
            if (typo.minFs < 16 || typo.minLh < 1.5 || typo.minBodyFs < 18) problems.push(`${s.key} ${regime} ${w}px: tipografía del cuerpo ${JSON.stringify(typo)}`);
            if (m.page.overflowX) problems.push(`${s.key} ${regime} ${w}px: la página desborda (${m.page.scrollWidth} > ${m.page.clientWidth}) ${JSON.stringify(m.page.culprits || []).slice(0, 300)}`);
            ((evidence.render[s.key] = evidence.render[s.key] || {})[regime] = evidence.render[s.key][regime] || {})[w] = { roots: m.roots.length, pass: m.roots.filter((r) => M.verdictOfRoot(r).pass).length, typo, pageOverflow: m.page.overflowX };
          }
        }
      }
    } finally {
      br.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    evidence.renderProblems = problems;
    console.log(`   ${measured} mediciones de capítulos`);
    assert(problems.length === 0, `${problems.length} problemas:\n   ${problems.slice(0, 30).join('\n   ')}`);
  });

  // ── B6 ──────────────────────────────────────────────────────────────────
  if (BASE) {
    await check('B6 frente a origin/staging: PDF del Libro y todo archivo de contenido idénticos; cambian solo la tarjeta del Libro y la actividad nueva', async () => {
      const BB = require(path.join(BASE, 'package/dynamic-mbz-builder-v3.js'));
      const BPX = require(path.join(BASE, 'modules/visual-design/preview-extract.js'));
      const changed = {};
      for (const s of STYLES) {
        const a = built[s.key].mbz;
        const bb = await BB.buildDynamicMbzV3(F.libroCourseInput(BASE, s.profile));
        const za = await JSZip.loadAsync(a);
        const zb = await JSZip.loadAsync(bb.mbz);
        const fa = Object.keys(za.files).filter((k) => k.startsWith('files/')).sort();
        const fb = Object.keys(zb.files).filter((k) => k.startsWith('files/')).sort();
        assert(JSON.stringify(fa) === JSON.stringify(fb), `${s.key}: mismos archivos de contenido (${fa.length} / ${fb.length})`);
        const base = await bookOf(bb.mbz);
        assert(sha256(base.pdf) === sha256(built[s.key].pdf), `${s.key}: el PDF del Libro es byte a byte el de antes`);
        const aa = (await PX.readMbzActivities(a)).filter((x) => x.idnumber !== LH.LIBRO_HTML_IDNUMBER);
        const ab = await BPX.readMbzActivities(bb.mbz);
        assert(aa.length === ab.length, `${s.key}: mismas actividades + el libro`);
        const text = (h) => h.replace(/<style\b[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        // El libro nuevo va en la sección 1: los moduleid que siguen corren uno (tokens $@X*mid@$): se comparan sin el id.
        const ids = (h) => h.replace(/(\$@[A-Z0-9_]+)\*\d+(?:\*\d+)?@\$/g, '$1*N@$');
        for (let i = 0; i < aa.length; i++) {
          assert(aa[i].idnumber === ab[i].idnumber, `${s.key}: mismo orden (${aa[i].idnumber} / ${ab[i].idnumber})`);
          if (ids(aa[i].html) === ids(ab[i].html)) continue;
          assert(aa[i].idnumber === 'cv3:shell:libro', `${s.key}: cambió ${aa[i].idnumber}`);
          const ta = text(aa[i].html);
          const tb = text(ab[i].html);
          assert(ta.startsWith(tb.replace(/ Abrir Libro Guía →$/, '')) && /Leer en el celular →$/.test(ta), `${s.key}: la tarjeta del Libro conserva su texto y suma la lectura en línea\n     antes: ${tb.slice(-160)}\n     ahora: ${ta.slice(-260)}`);
          changed[aa[i].idnumber] = (changed[aa[i].idnumber] || 0) + 1;
        }
      }
      evidence.changedVsBase = changed;
      console.log(`   actividades distintas de origin/staging (fuera del libro nuevo): ${JSON.stringify(changed)}`);
    });
  }

  if (MOODLE) await moodleChecks();
  finish();
})().catch((e) => { console.error(e); process.exit(1); });

function finish() {
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 1));
  console.log(`\n${passes} OK, ${failures} fallas · evidencia: ${path.join(OUT, 'evidence.json')}`);
  process.exit(failures && !NO_FAIL ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// B7 — Moodle 4.5 local + Playwright
// ─────────────────────────────────────────────────────────────────────────────
const DEVICES = [
  { key: 'android-320', engine: 'chromium', width: 320, height: 640, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 14; SM-A156M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36' },
  { key: 'android-390', engine: 'chromium', width: 390, height: 844, dpr: 2.75, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36' },
  { key: 'iphone-375', engine: 'webkit', descriptor: 'iPhone SE' },
  { key: 'iphone-390', engine: 'webkit', descriptor: 'iPhone 13' },
  { key: 'desktop-1280', engine: 'chromium', width: 1280, height: 900, dpr: 1, mobile: false },
];

async function moodleChecks() {
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
  const courses = {};
  const fcBefore = JSON.parse(php('r77-mobile.php', ['--action=forceclean'])).before;
  const pdfSec = {};
  for (const [k, c] of Object.entries(built)) pdfSec[k] = (await pdfSections(c.pdf)).sec;
  await check(`B7a Moodle 4.5: ${Object.keys(built).length} cursos restaurados, libro en la sección 1 debajo del PDF, «Leer en el celular» → el libro`, async () => {
    for (const k of Object.keys(built)) {
      const id = Number(/Course ID: (\d+)/.exec(php('r76-visual-design.php', ['--action=restore-new', `--file=${path.join(OUT, k, 'curso.mbz')}`, '--categoryid=1']))[1]);
      const r = spawnSync(PHP, ['-c', INI, path.join(ROOT, 'scripts/moodle/v21-video-moodle.php'), SRC, 'enrol', String(id), creds.username], { encoding: 'utf8' });
      assert(/"enrolled":true/.test(r.stdout || ''), `matrícula en ${k}`);
      const info = JSON.parse(php('r78-libro-movil.php', ['--action=book', `--courseid=${id}`]));
      courses[k] = { id, info };
      const s1 = info.section1.map((x) => x.idnumber);
      const iL = s1.indexOf('cv3:shell:libro');
      assert(iL >= 0 && s1[iL + 1] === LH.LIBRO_HTML_IDNUMBER, `${k}: sección 1 ${s1.join(', ')}`);
      assert(info.visible && info.chapters.length === built[k].book.chapters.length, `${k}: ${info.chapters.length} capítulos restaurados`);
      assert(info.chapters.map((c) => c.title).join('|') === built[k].book.chapters.map((c) => c.title).join('|'), `${k}: títulos de los capítulos`);
      assert(info.numbering === 0 && info.customtitles === 0, `${k}: sin numeración automática, títulos de Moodle`);
      const intro = info.libro.intro;
      assert(new RegExp(`href="http://127\\.0\\.0\\.1:8099/mod/book/view\\.php\\?id=${info.cmid}"`).test(intro), `${k}: «Leer en el celular» resuelto al libro (${(/href="([^"]*book[^"]*)"/.exec(intro) || [])[1]})`);
      assert(!/\$@/.test(intro), `${k}: sin tokens sin resolver en la tarjeta`);
    }
    evidence.moodle.courses = Object.fromEntries(Object.entries(courses).map(([k, c]) => [k, { id: c.id, cmid: c.info.cmid, chapters: c.info.chapters.length }]));
  });
  if (!Object.keys(courses).length) return;
  const net = require('net');
  const portInUse = (port) => new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
  assert(!(await portInUse(8099)), 'puerto 8099 libre (ver reference_gate_env_gotchas)');
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
      const ctx = await browsers[d.engine].newContext({ ...o, locale: 'es-CO' });
      await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
      const page = await ctx.newPage();
      await page.goto('http://127.0.0.1:8099/login/index.php');
      await page.fill('#username', creds.username);
      await page.fill('#password', creds.password);
      await Promise.all([page.waitForNavigation(), page.click('#loginbtn')]);
      assert(!/\/login\/index\.php/.test(page.url()), `${d.key}: el inicio de sesión falló (${page.url()})`);
      return { ctx, page };
    };
    const go = async (page, url) => {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(150);
    };
    for (const regime of ['guardado', 'limpio']) {
      php('r77-mobile.php', ['--action=forceclean', `--set=${regime === 'limpio' ? 1 : 0}`]);
      const ONLY_DEV = arg('devices') ? arg('devices').split(',') : null;
      for (const d of DEVICES.filter((x) => !ONLY_DEV || ONLY_DEV.includes(x.key))) {
        await check(`B7b ${regime} · ${d.key}: cada capítulo del libro en Moodle (paridad con el PDF en la página real, mediciones, enlaces resueltos), «Siguiente» de verdad`, async () => {
          let { ctx, page } = await contextFor(d);
          const bad = [];
          try {
            for (const k of Object.keys(courses)) {
              if (k === 'grande' && !['android-390', 'desktop-1280'].includes(d.key)) continue;
              const c = courses[k];
              const chs = c.info.chapters;
              const shootSet = new Set(regime === 'guardado'
                ? (['iphone-390', 'android-320', 'desktop-1280', 'android-390', 'iphone-375'].includes(d.key) ? [0, 2] : [])
                : (d.key === 'iphone-390' || d.key === 'android-320' ? [2] : []));
              if (k === 'grande') { shootSet.clear(); shootSet.add(chs.length - 2); }
              for (let i = 0; i < chs.length; i++) {
                const url = `http://127.0.0.1:8099/mod/book/view.php?id=${c.info.cmid}&chapterid=${chs[i].id}`;
                await go(page, url);
                for (let attempt = 0; attempt < 2 && !(await page.$('#mod_book-chapter')); attempt++) {
                  (evidence.moodle.sessionRetries = evidence.moodle.sessionRetries || []).push({ k, device: d.key, regime, url: page.url() });
                  await ctx.close();
                  ({ ctx, page } = await contextFor(d));
                  await go(page, url);
                }
                const info = await page.evaluate((args) => {
                  const box = document.querySelector('#mod_book-chapter');
                  if (!box) return null;
                  const clone = box.cloneNode(true);
                  clone.querySelectorAll('style,script,.cvc-libro-nav').forEach((x) => x.remove());
                  if (args.cover) clone.querySelectorAll('.cvc-libro-toc').forEach((x) => x.remove());
                  // Bloques separados (como el extractor del check): las palabras de dos párrafos no se pegan.
                  clone.querySelectorAll('p,div,li,td,th,tr,h1,h2,h3,h4,h5,h6,br').forEach((x) => x.insertAdjacentText('beforeend', '\n'));
                  const heads = Array.from(box.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter((h) => !h.closest('.cvc')).map((h) => h.textContent.trim());
                  const links = Array.from(box.querySelectorAll('.cvc-libro-nav a, .cvc-libro-toc a')).map((a) => a.getAttribute('href'));
                  const tocHtml = (box.querySelector('.cvc-libro-toc') || {}).outerHTML || '';
                  const theadHtml = Array.from(box.querySelectorAll('thead')).map((t) => t.textContent);
                  const nav = Array.from(document.querySelectorAll('#mod_book-chaptersnavigation a')).map((a) => { const b = a.getBoundingClientRect(); return `${a.className.split(' ').pop()} ${Math.round(b.width)}×${Math.round(b.height)}`; });
                  return { text: clone.textContent, heads, links, tocHtml, theadHtml, nav };
                }, { cover: i === 0 });
                if (!info) { bad.push(`${k}/${d.key}/${regime}: capítulo ${i + 1} no se ve (${page.url()})`); continue; }
                // Paridad en la PÁGINA REAL de Moodle (lo que ve el estudiante): título que pinta Moodle + contenido. En un
                // subcapítulo Moodle pinta también el título del módulo (no está en esa sección del PDF); la portada, su título.
                const key = keyOfTitle(chs[i].title, i);
                const all = stream(info.text);
                const drop = i === 0 || chs[i].subchapter ? stream(info.heads[0] || '') : '';
                const gotFull = all.startsWith(drop) ? all.slice(drop.length) : `(sin el título de Moodle) ${all}`;
                const want = pdfSectionStream(pdfSec[k][key], info.theadHtml.map((t) => stream(t)), gotFull);
                if (gotFull !== want) { const at = firstDiff(gotFull, want); bad.push(`${k}/${d.key}/${regime} ${key}: el texto en Moodle difiere del PDF en ${at}\n      Moodle …${around(gotFull, at)}…\n      PDF    …${around(want, at)}…`); }
                if (i === 0) {
                  const tg = stream(LH.libroHtmlVisibleText(info.tocHtml, []));
                  const tw = pdfSectionStream(pdfSec[k].indice, [], tg);
                  if (tg !== tw) bad.push(`${k}/${d.key}/${regime}: el índice en Moodle difiere del índice del PDF`);
                }
                for (const h of info.links) {
                  if (!(new RegExp(`^http://127\\.0\\.0\\.1:8099/mod/book/view\\.php\\?id=${c.info.cmid}&chapterid=(${chs.map((x) => x.id).join('|')})$`).test(h) || /^http:\/\/127\.0\.0\.1:8099\/mod\/resource\/view\.php\?id=\d+$/.test(h))) bad.push(`${k}/${d.key}/${regime} ${key}: enlace sin resolver o roto: ${h}`);
                }
                const m = await page.evaluate(M.measureExpr({}));
                for (const r of m.roots) {
                  const v = M.verdictOfRoot(r);
                  results.push({ style: k, device: d.key, regime, chapter: key, pass: v.pass, fails: v.fails, warns: v.warns, fonts: r.fonts && { min: r.fonts.min, minRunning: r.fonts.minRunning }, styleTags: r.styleTags, targets: r.targets.filter((t) => !t.inline).map((t) => `${t.w}×${t.h}`) });
                  if (!v.pass) bad.push(`${k}/${d.key}/${regime} ${key}: ${v.fails.join(' / ').slice(0, 300)}`);
                }
                if (m.page.overflowX) bad.push(`${k}/${d.key}/${regime} ${key}: la página de Moodle desborda (${m.page.scrollWidth} > ${m.page.clientWidth}) ${JSON.stringify(m.page.culprits || []).slice(0, 200)}`);
                results.push({ style: k, device: d.key, regime, chapter: key, moodle: true, moodleNav: info.nav, pageOverflow: m.page.overflowX });
                if (shootSet.has(i)) await page.screenshot({ path: path.join(shotsDir, `${k}-${regime}-${d.key}-libro-${key}.png`), fullPage: true });
              }
              // «Siguiente» de verdad (toque/clic) desde la portada → el capítulo 2 del libro.
              if (k !== 'grande') {
                await go(page, `http://127.0.0.1:8099/mod/book/view.php?id=${c.info.cmid}&chapterid=${chs[0].id}`);
                const next = await page.$('.cvc-libro-nav a.cvc-btn-link');
                assert(next, `${k}/${d.key}: botón «Siguiente» en la portada`);
                await Promise.all([page.waitForNavigation({ timeout: 30000 }), d.mobile && d.engine === 'chromium' ? next.tap() : next.click()]);
                if (!new RegExp(`chapterid=${chs[1].id}\\b`).test(page.url())) bad.push(`${k}/${d.key}/${regime}: «Siguiente» llevó a ${page.url()}`);
                // Sección 1: la tarjeta con los dos botones (captura del acceso).
                if (regime === 'guardado' && ['iphone-390', 'android-320', 'desktop-1280'].includes(d.key)) {
                  await go(page, `http://127.0.0.1:8099/course/view.php?id=${c.id}&section=1`);
                  const btn = await page.evaluate(() => { const a = Array.from(document.querySelectorAll('a.cvc-btn-link')).find((x) => /Leer en el celular/.test(x.textContent)); if (!a) return null; const b = a.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), href: a.getAttribute('href') }; });
                  if (!btn || btn.h < 44 || btn.w < 44) bad.push(`${k}/${d.key}: «Leer en el celular» en la sección 1 ${JSON.stringify(btn)}`);
                  results.push({ style: k, device: d.key, regime, chapter: 'seccion-1', cta: btn, moodle: true });
                  await page.screenshot({ path: path.join(shotsDir, `${k}-${regime}-${d.key}-seccion1.png`), fullPage: true });
                }
              }
            }
          } finally {
            await ctx.close();
          }
          assert(bad.length === 0, `${bad.length} problemas:\n   ${bad.slice(0, 20).join('\n   ')}`);
        });
      }
      // App oficial: lo que entrega core_course_get_contents (+ index.html de cada capítulo) con este régimen.
      await check(`B7c app de Moodle (${regime}): el libro llega por core_course_get_contents con un index.html por capítulo; cada capítulo = texto del PDF; enlaces resueltos${regime === 'limpio' ? '; sin <style> y los botones conservan su caja' : ''}`, async () => {
        const out = {};
        const bad = [];
        for (const k of Object.keys(courses)) {
          const c = courses[k];
          const ws = JSON.parse(php('r78-libro-movil.php', ['--action=app', `--courseid=${c.id}`, `--username=${creds.username}`]));
          const idx = ws.module.contents.filter((x) => x.filename === 'index.html');
          if (idx.length !== c.info.chapters.length) bad.push(`${k}: ${idx.length} index.html en core_course_get_contents (capítulos ${c.info.chapters.length})`);
          if (!/Leer en el celular/.test(ws.libroDescription || '') || !new RegExp(`mod/book/view\\.php\\?id=${c.info.cmid}`).test(ws.libroDescription || '')) bad.push(`${k}: la descripción del Libro en la app no trae «Leer en el celular» al libro`);
          const rows = parityReport(ws.chapters, pdfSec[k], (ch) => ch.html, (ch) => (ch.subchapter ? ch.titles.replace(/^<h3>[\s\S]*?<\/h3>/, '') : ch.titles).replace(/<[^>]+>/g, ' '));
          for (const r of rows) if (!r.ok) bad.push(`${k} ${r.key}: ${r.why || `difiere en ${r.at}: app …${r.online}… / PDF …${r.pdf}…`}`);
          const all = ws.chapters.map((x) => x.html).join('\n');
          const styleTags = (all.match(/<style\b/g) || []).length;
          const tok = (all.match(/\$@[A-Z]/g) || []).length;
          const btns = [...all.matchAll(/<a class="cvc-btn-link"[^>]*style="([^"]*)"/g)].map((m) => m[1]);
          if (tok) bad.push(`${k}: ${tok} tokens sin resolver en lo que recibe la app`);
          if (regime === 'limpio') {
            if (styleTags) bad.push(`${k}: con forceclean la app recibe ${styleTags} <style>`);
            const boxed = btns.filter((x) => /float:\s*left/.test(x) && /padding:\s*12px/.test(x) && /background-color/.test(x)).length;
            if (boxed !== btns.length || !btns.length) bad.push(`${k}: botones con caja en la app ${boxed}/${btns.length}`);
          }
          out[k] = { chapters: ws.chapters.length, indexHtml: idx.length, styleTags, buttons: btns.length, parityOk: rows.filter((r) => r.ok).length, sections: rows.length };
        }
        (evidence.moodle.app = evidence.moodle.app || {})[regime] = out;
        console.log(`   ${JSON.stringify(out).slice(0, 600)}`);
        assert(bad.length === 0, `${bad.length} problemas:\n   ${bad.slice(0, 12).join('\n   ')}`);
      });
    }
  } finally {
    for (const b of Object.values(browsers)) await b.close().catch(() => {});
    try { process.kill(-server.pid, 'SIGTERM'); } catch (e) { server.kill('SIGTERM'); }
    php('r77-mobile.php', ['--action=forceclean', `--set=${fcBefore}`]);
  }
  evidence.moodle.results = results;
  fs.writeFileSync(path.join(OUT, 'moodle-results.json'), JSON.stringify(results, null, 1));
  const cursia = results.filter((r) => !r.moodle);
  evidence.moodle.totals = { measurements: cursia.length, fail: cursia.filter((r) => !r.pass).length, pageOverflow: results.filter((r) => r.moodle && r.pageOverflow).length };
  console.log(`   Moodle: ${cursia.length} mediciones de capítulos de Cursia, ${evidence.moodle.totals.fail} fallas, ${evidence.moodle.totals.pageOverflow} páginas desbordadas`);
  if (!process.argv.includes('--keep')) {
    for (const [k, c] of Object.entries(courses)) {
      try { php('r76-visual-design.php', ['--action=delete', `--courseid=${c.id}`, `--title=${c.info.fullname.slice(0, 20)}`]); } catch (e) { console.log(`   (no se pudo borrar ${k} #${c.id}: ${e.message.slice(0, 120)})`); }
    }
  }
}
