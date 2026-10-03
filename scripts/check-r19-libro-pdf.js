#!/usr/bin/env node
/* eslint-disable */
// Cursia r19 (bloque L): Libro Guía en PDF real + marca de agua + logo + CTA. PURO: sin DB, sin red.
// Corre contra dist/ (npm run build antes).
//
//  1. PDF (pdfjs-dist) para 3 insumos (chico 1×1, 4 capítulos, grande ≈ 50 páginas):
//     páginas > 0; EXACTAMENTE una pintura de imagen por página (toda página: portada e índice incluidos);
//     la marca de agua se pinta ANTES de cualquier texto; su ExtGState `ca` ≤ 0.12; el texto trae el título,
//     cada capítulo y los caracteres del español; sin U+FFFD; determinismo (mismos insumos → mismos bytes).
//  2. Logo: A cuenta PNG/JPEG → la imagen de la marca de agua = el logo (dimensiones + hash de píxeles);
//     B sin logo → Cursia; C inválido (basura, SVG, PNG truncado, URL, mime ≠ bytes, 1×1) → Cursia + aviso.
//  3. .mbz construido: la descripción del recurso trae UN <a> «Abrir Libro Guía» con target=_blank, rel noopener
//     y el token de SU propio moduleid; files.xml con UN libro (application/pdf, .pdf) en el contexto del recurso;
//     validador en verde y ROJO ante mutaciones; un logo inválido deja su aviso en el resumen del paquete;
//     la clave de reuse cambia con el logo.
//
// Usage: node scripts/check-r19-libro-pdf.js [path/to/dist] [--out dir]  (--out: PNG de páginas 1, 2 y del medio)

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : null;
const distArg = args.find((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
const distRoot = path.resolve(process.cwd(), distArg || path.join(ROOT, 'dist'));
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const LB = loadDist('package/v3/libro-v3.js');
const LL = loadDist('package/v3/libro-logo.js');
const PNG = loadDist('package/v3/png-downscale.js');
const TE = loadDist('modules/theme-engine/index.js');
const B = loadDist('package/dynamic-mbz-builder-v3.js');
const V = loadDist('package/v3/mbz-validator-v3.js');
const PK = loadDist('modules/dynamic-packaging/packaging-v3.js');
const PF = require('./lib/v21-packaging-fixtures');

let passes = 0;
let fails = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    fails++;
    console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`);
  }
}
function assert(c, m) {
  if (!c) throw new Error(m || 'assert');
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ─── fixtures ──────────────────────────────────────────────────────────────
const SPANISH = ['á', 'é', 'í', 'ó', 'ú', 'ñ', 'ü', '¿', '¡', '«', '»', '“', '”', '–', '—', '•'];
const chapterMd = (n, paras) =>
  `# Capítulo ${n}\n\n---\n\n## ${n}.1 El primer contacto con el comensal\n\n` +
  '¿Qué notaste primero? La atención, el saludo y la ubicación. Pingüino, ñandú, acción; «comillas latinas», “tipográficas”, guiones – y — al pasar. ¡Bienvenido! Emoji 🎯 y flecha → siguen, −5 °C.\n\n' +
  '■ **Caso ilustrativo — Perú:** el mozo recibe a una familia con *calidez*.\n\n' +
  '> Mesa 4, 3 comensales.\n>\n> Puesto 1: Lomo saltado, sin cebolla.\n\n' +
  '- Saludo con **contacto visual**\n- Ubicación según el grupo\n\n1. Recibir\n2. Ubicar\n\n' +
  '| Tipo de comensal | Zona preferida | Qué evitar |\n|---|---|---|\n| Pareja | Ventana | Pasillo |\n| Familia | Cerca del baño | Mesas estrechas |\n\n' +
  '✏ **Actividad:** describe tu protocolo de bienvenida.\n\n' +
  Array.from({ length: paras }, (_, i) => `Párrafo ${i + 1} del capítulo ${n}: el servicio al cliente se construye con detalles concretos, escucha activa y una comunicación clara con la cocina y con el comensal.`).join('\n\n');
const BIB = [{ author: 'Hattie, John', year: 2009, title: 'Visible learning: A synthesis of over 800 meta-analyses relating to achievement', publisher: 'Routledge' }];
function libroInput({ modules, chapters, paras, logo, brandName, theme }) {
  let n = 0;
  return {
    courseTitle: 'Servicio al cliente en un restaurante familiar',
    theme: TE.resolveTheme(theme || { themeFamily: 'editorial', mode: 'light' }),
    courseIntro: { schemaVersion: 1, welcome: 'w', competencies: ['c'], methodology_note: 'm', closing: 'c', bibliography: BIB },
    modules: Array.from({ length: modules }, (_, mi) => ({
      number: mi + 1,
      title: `Atención y servicio — módulo ${mi + 1}`,
      intro: { schemaVersion: 1, presentation: 'Este módulo presenta la atención al comensal.\n\nSegundo párrafo.', outcomes: ['Recibir con calidez', 'Ubicar a cada grupo'], journey: [], bibliography: BIB },
      chapters: Array.from({ length: chapters }, () => {
        n++;
        return { number: n, title: `Bienvenida y ubicación del comensal ${n}`, md: chapterMd(n, paras) };
      }),
    })),
    logo: logo || LL.resolveLibroLogo(null),
    brandName: brandName === undefined ? 'Instituto Técnico Andino' : brandName,
  };
}

let pdfjs;
async function loadPdf(buf) {
  pdfjs = pdfjs || (await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs', { paths: [ROOT] })));
  const sf = path.join(path.dirname(require.resolve('pdfjs-dist/package.json', { paths: [ROOT] })), 'standard_fonts') + '/';
  return pdfjs.getDocument({ data: new Uint8Array(buf), standardFontDataUrl: sf, verbosity: 0, isOffscreenCanvasSupported: false, isImageDecoderSupported: false }).promise;
}
const IMAGE_OPS = () => new Set(['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintImageXObjectRepeat', 'paintInlineImageXObjectGroup', 'paintImageMaskXObjectGroup', 'paintImageMaskXObjectRepeat', 'paintSolidColorImageMask'].map((k) => pdfjs.OPS[k]).filter((v) => v !== undefined));
const TEXT_OPS = () => new Set(['showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText', 'beginText'].map((k) => pdfjs.OPS[k]));

/** Análisis de todas las páginas: imágenes, orden respecto del texto, opacidad, texto. */
async function analyze(buf) {
  const d = await loadPdf(buf);
  const pages = [];
  const IMG = IMAGE_OPS();
  const TXT = TEXT_OPS();
  for (let p = 1; p <= d.numPages; p++) {
    const pg = await d.getPage(p);
    const ol = await pg.getOperatorList();
    const imgIdx = [];
    let firstText = -1;
    let lastCa = null;
    let caAtImage = null;
    ol.fnArray.forEach((fn, i) => {
      if (fn === pdfjs.OPS.setGState) {
        for (const [k, v] of ol.argsArray[i][0]) if (k === 'ca') lastCa = v;
      }
      if (IMG.has(fn)) {
        imgIdx.push(i);
        if (caAtImage === null) caAtImage = lastCa;
      }
      if (TXT.has(fn) && firstText < 0) firstText = i;
    });
    const tc = await pg.getTextContent();
    const text = tc.items.map((it) => it.str).join(' ');
    let image = null;
    if (imgIdx.length) {
      const id = ol.argsArray[imgIdx[0]][0];
      // sin OffscreenCanvas/ImageDecoder el worker manda los píxeles crudos; un objeto que no llega = falla (no cuelga)
      const obj = await new Promise((res) => {
        const t = setTimeout(() => res(null), 5000);
        (String(id).startsWith('g_') ? pg.commonObjs : pg.objs).get(id, (o) => { clearTimeout(t); res(o); });
      });
      image = obj ? { width: obj.width, height: obj.height, kind: obj.kind, data: obj.data || null } : null;
    }
    pages.push({ imgCount: imgIdx.length, imgBeforeText: imgIdx.length > 0 && (firstText < 0 || imgIdx[0] < firstText), caAtImage, text, image });
  }
  const meta = await d.getMetadata();
  return { numPages: d.numPages, pages, text: pages.map((p) => p.text).join('\n'), info: meta.info };
}

/** RGBA de la imagen decodificada por pdfjs (kind 3 = RGBA, 2 = RGB) → hash de los píxeles RGB y del alfa. */
function pixelHash(img) {
  if (!img || !img.data) return null;
  const n = img.width * img.height;
  const ch = img.kind === 3 ? 4 : 3;
  const rgb = Buffer.alloc(n * 3);
  const a = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = img.data[i * ch];
    rgb[i * 3 + 1] = img.data[i * ch + 1];
    rgb[i * 3 + 2] = img.data[i * ch + 2];
    a[i] = ch === 4 ? img.data[i * ch + 3] : 255;
  }
  return { rgb: sha(rgb), a: sha(a), alphaRaw: a, rgbRaw: rgb };
}
/** Hash de píxeles de un PNG (decodificador propio) en el mismo formato. */
function pngPixelHash(buf) {
  const d = PNG.decodePng(buf);
  const n = d.width * d.height;
  const rgb = Buffer.alloc(n * 3);
  const a = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = d.pixels[i * d.channels];
    rgb[i * 3 + 1] = d.pixels[i * d.channels + 1];
    rgb[i * 3 + 2] = d.pixels[i * d.channels + 2];
    a[i] = d.channels === 4 ? d.pixels[i * d.channels + 3] : 255;
  }
  return { width: d.width, height: d.height, rgb: sha(rgb), a: sha(a), alphaRaw: a, rgbRaw: rgb };
}
/** Compara el logo esperado con la imagen pintada: mismo alfa exacto y RGB exacto donde el píxel es visible. */
function samePixels(img, expected) {
  const got = pixelHash(img);
  if (!got || img.width !== expected.width || img.height !== expected.height) return false;
  if (got.a !== expected.a) return false;
  for (let i = 0; i < expected.alphaRaw.length; i++) {
    if (expected.alphaRaw[i] === 0) continue;
    for (let k = 0; k < 3; k++) if (Math.abs(got.rgbRaw[i * 3 + k] - expected.rgbRaw[i * 3 + k]) > 1) return false;
  }
  return true;
}

/** PNG de prueba de una cuenta (200×80, RGBA con transparencia y un patrón). */
function accountPng(opaque = false) {
  const w = 200, h = 80;
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = (x - 100) ** 2 / 90 ** 2 + (y - 40) ** 2 / 34 ** 2 <= 1;
      px[i] = 200; px[i + 1] = (x * 3) & 255; px[i + 2] = (y * 5) & 255; px[i + 3] = opaque ? 255 : inside ? 255 : 0;
    }
  return PNG.encodePngFiltered(w, h, 4, px);
}
const dataUri = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

const keepAlive = setInterval(() => {}, 1 << 30); // una promesa de pdfjs que no resuelve nunca debe fallar, no salir con 0
(async () => {
  const results = {};
  for (const [id, cfg] of Object.entries({ small: { modules: 1, chapters: 1, paras: 3 }, multi: { modules: 2, chapters: 2, paras: 8 }, large: { modules: 3, chapters: 3, paras: 62 } })) {
    const input = libroInput(cfg);
    const r = await LB.renderLibroPdfV3(input);
    const r2 = await LB.renderLibroPdfV3(libroInput(cfg));
    results[id] = { input, r, r2, a: await analyze(r.pdf) };
  }

  for (const id of Object.keys(results)) {
    const { input, r, r2, a } = results[id];
    await check(`[${id}] PDF real: ${a.numPages} páginas, %PDF-…%%EOF, conteo del renderer = pdfjs`, () => {
      assert(a.numPages > 0 && a.numPages === r.pageCount, `${a.numPages} vs ${r.pageCount}`);
      assert(r.pdf.subarray(0, 5).toString() === '%PDF-' && /%%EOF\s*$/.test(r.pdf.subarray(-16).toString('latin1')), 'cabecera/cierre');
      if (id === 'large') assert(a.numPages >= 45 && a.numPages <= 70, `el fixture grande debe rondar 50 páginas (${a.numPages})`);
    });
    await check(`[${id}] exactamente UNA pintura de imagen por página, en TODAS (portada e índice incluidos)`, () => {
      const bad = a.pages.map((p, i) => [i + 1, p.imgCount]).filter(([, n]) => n !== 1);
      assert(bad.length === 0, `páginas con ≠ 1 imagen: ${JSON.stringify(bad)}`);
      assert(r.watermarkDrawsPerPage.every((n) => n === 1), 'contador del renderer');
    });
    await check(`[${id}] la marca de agua se pinta ANTES de cualquier texto y con opacidad ca ≤ 0.12`, () => {
      a.pages.forEach((p, i) => {
        assert(p.imgBeforeText, `página ${i + 1}: la imagen no va antes del texto`);
        assert(typeof p.caAtImage === 'number' && p.caAtImage > 0 && p.caAtImage <= 0.12, `página ${i + 1}: ca=${p.caAtImage}`);
      });
    });
    await check(`[${id}] texto: título, cada capítulo, español correcto, sin U+FFFD ni caracteres fuera de WinAnsi`, () => {
      assert(a.text.includes('Servicio al cliente en un restaurante familiar'), 'título');
      for (const m of input.modules) for (const c of m.chapters) assert(a.text.includes(c.title), `capítulo ${c.number}`);
      for (const ch of SPANISH) assert(a.text.includes(ch), `carácter ${ch}`);
      assert(!a.text.includes('�'), 'U+FFFD');
      assert(!/[🎯✏■−→]/u.test(a.text), 'símbolos fuera de WinAnsi deben mapearse o quitarse');
      assert(a.text.includes('Página 2 de') && a.text.includes('Índice') && a.text.includes('Bibliografía'), 'pie, índice, bibliografía');
      assert(a.text.includes('Instituto Técnico Andino'), 'nombre de la institución');
    });
    await check(`[${id}] determinismo: mismos insumos → mismos bytes (fecha e ID fijos)`, () => {
      assert(r.pdf.equals(r2.pdf), 'bytes distintos');
      assert(/^D:20260101000000/.test(a.info.CreationDate) && /^D:20260101000000/.test(a.info.ModDate), `fechas fijas: ${a.info.CreationDate}`);
      assert(a.info.Title === 'Servicio al cliente en un restaurante familiar', `/Title = título del curso: ${a.info.Title}`);
    });
  }
  await check('[multi] índice con números de página: cada capítulo apunta a la página donde empieza', async () => {
    const { r, a } = results.multi;
    const toc = a.pages[1].text;
    for (const [n, page] of Object.entries(r.chapterPages)) {
      assert(new RegExp(`Capítulo ${n}\\. Bienvenida[\\s\\S]*?\\b${page}\\b`).test(toc), `capítulo ${n} → ${page}`);
      assert(a.pages[page - 1].text.includes(`Bienvenida y ubicación del comensal ${n}`), `la página ${page} abre el capítulo ${n}`);
    }
  });
  await check('pdfText: mapeo determinístico a WinAnsi (español intacto, emoji/✏ fuera, ■ → •, − → -)', () => {
    assert(LB.pdfText('¿Áéíóú ñÑ ü «» “” – — •?') === '¿Áéíóú ñÑ ü «» “” – — •?', 'español');
    assert(LB.pdfText('■ caso 🎯 ✏ −5 → x') === '• caso -5 -> x', LB.pdfText('■ caso 🎯 ✏ −5 → x'));
  });

  // ── 2. Logo ──
  const cursia = LL.cursiaDefaultLogo();
  const cursiaPx = pngPixelHash(cursia.bytes);
  await check('logo de Cursia incluido: PNG RGBA con transparencia (assets/brand/cursia-logo-navy.png)', () => {
    assert(cursia.source === 'cursia_default' && cursia.hasAlpha && cursia.width === 560 && cursia.height === 211, JSON.stringify({ ...cursia, bytes: cursia.bytes.length }));
    const d = PNG.decodePng(fs.readFileSync(path.join(ROOT, 'assets/brand/cursia-logo-navy.png')));
    let transparent = 0;
    for (let i = 3; i < d.pixels.length; i += 4) if (d.pixels[i] === 0) transparent++;
    assert(d.channels === 4 && transparent / (d.width * d.height) > 0.5, 'alfa real');
  });
  await check('A: logo PNG de la cuenta → la marca de agua ES ese logo (dimensiones + píxeles), sin avisos', async () => {
    const png = accountPng();
    for (const source of ['user_settings', 'brand_profile']) {
      const logo = LL.resolveLibroLogo({ source, dataUri: dataUri('image/png', png) });
      assert(logo.source === source && logo.warnings.length === 0, JSON.stringify(logo.warnings));
      const r = await LB.renderLibroPdfV3(libroInput({ modules: 1, chapters: 1, paras: 2, logo }));
      const a = await analyze(r.pdf);
      const exp = pngPixelHash(png);
      a.pages.forEach((p, i) => assert(p.imgCount === 1 && samePixels(p.image, exp), `página ${i + 1}: la imagen no es el logo de la cuenta`));
      assert(!samePixels(a.pages[0].image, cursiaPx), 'no debe ser Cursia');
    }
  });
  await check('A: logo JPEG de la cuenta → se usa (dimensiones), con aviso libro_logo_no_alpha', async () => {
    const { createCanvas } = require(require.resolve('@napi-rs/canvas', { paths: [ROOT] }));
    const cv = createCanvas(160, 90);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 160, 90); ctx.fillStyle = '#c0392b'; ctx.fillRect(20, 20, 120, 50);
    const jpg = cv.toBuffer('image/jpeg');
    const logo = LL.resolveLibroLogo({ source: 'user_settings', dataUri: dataUri('image/jpeg', jpg) });
    assert(logo.kind === 'jpeg' && logo.width === 160 && logo.height === 90, JSON.stringify({ ...logo, bytes: 0 }));
    assert(logo.warnings.includes('libro_logo_no_alpha:user_settings'), JSON.stringify(logo.warnings));
    const a = await analyze((await LB.renderLibroPdfV3(libroInput({ modules: 1, chapters: 1, paras: 2, logo }))).pdf);
    a.pages.forEach((p, i) => assert(p.imgCount === 1 && p.image.width === 160 && p.image.height === 90, `página ${i + 1}`));
    // JPEG truncado → inválido
    const t = LL.resolveLibroLogo({ source: 'user_settings', dataUri: dataUri('image/jpeg', jpg.subarray(0, Math.floor(jpg.length / 2))) });
    assert(t.source === 'cursia_default' && /^libro_logo_invalid:user_settings:jpeg_/.test(t.warnings[0]), JSON.stringify(t.warnings));
  });
  await check('B: sin logo → logo de Cursia, sin avisos', async () => {
    for (const cand of [null, undefined, { source: 'user_settings', dataUri: '' }]) {
      const logo = LL.resolveLibroLogo(cand);
      assert(logo.source === 'cursia_default' && logo.warnings.length === 0 && logo.sha256 === cursia.sha256, 'Cursia');
    }
    const a = results.small.a;
    a.pages.forEach((p, i) => assert(samePixels(p.image, cursiaPx), `página ${i + 1}: no es el logo de Cursia`));
  });
  await check('C: logo inválido (basura, SVG, PNG truncado, URL, mime ≠ bytes, 1×1) → Cursia + aviso visible', async () => {
    const png = accountPng();
    const tiny = PNG.encodePngFiltered(1, 1, 4, Buffer.from([0, 0, 0, 255]));
    const cases = [
      ['basura', dataUri('image/png', Buffer.from('esto no es una imagen, son bytes basura')), /png_bad_magic/],
      ['svg', dataUri('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')), /svg_unsupported/],
      ['svg disfrazado de png', dataUri('image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), /svg_unsupported/],
      ['png truncado', dataUri('image/png', png.subarray(0, Math.floor(png.length * 0.6))), /png_/],
      ['url remota', 'https://example.org/logo.png', /remote_url_unsupported/],
      ['mime ≠ bytes', dataUri('image/jpeg', png), /mime_mismatch/],
      ['1×1', dataUri('image/png', tiny), /too_small/],
      ['gif', dataUri('image/gif', Buffer.from('GIF89a')), /mime_unsupported/],
      ['no data uri', 'logo.png', /not_base64_data_uri/],
    ];
    for (const [name, uri, re] of cases) {
      const logo = LL.resolveLibroLogo({ source: 'user_settings', dataUri: uri });
      assert(logo.source === 'cursia_default' && logo.sha256 === cursia.sha256, `${name}: debe caer a Cursia`);
      assert(logo.warnings.length === 1 && logo.warnings[0].startsWith('libro_logo_invalid:user_settings:') && re.test(logo.warnings[0]), `${name}: ${JSON.stringify(logo.warnings)}`);
    }
    const bad = LL.resolveLibroLogo({ source: 'brand_profile', dataUri: dataUri('image/png', png.subarray(0, 100)) });
    const a = await analyze((await LB.renderLibroPdfV3(libroInput({ modules: 1, chapters: 1, paras: 2, logo: bad }))).pdf);
    a.pages.forEach((p, i) => assert(p.imgCount === 1 && samePixels(p.image, cursiaPx), `página ${i + 1}: nunca una marca de agua vacía`));
  });

  // ── 3. .mbz ──
  const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true });
  const built = await B.buildDynamicMbzV3(input);
  const z = await JSZip.loadAsync(built.mbz);
  const filesXml = await z.file('files.xml').async('string');
  const fileBlocks = filesXml.match(/<file id="\d+">[\s\S]*?<\/file>/g);
  const tag = (x, t) => (new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(x) || [])[1];
  let libroDir = null;
  for (const p of Object.keys(z.files).filter((p) => /^activities\/resource_\d+\/module\.xml$/.test(p))) {
    if ((await z.file(p).async('string')).includes('<idnumber>cv3:shell:libro</idnumber>')) libroDir = p.replace(/\/module\.xml$/, '');
  }
  const resXml = libroDir ? await z.file(`${libroDir}/resource.xml`).async('string') : '';
  const unx = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const intro = unx(tag(resXml, 'intro'));
  const mid = Number((/moduleid="(\d+)"/.exec(resXml) || [])[1]);
  const ctx = Number((/contextid="(\d+)"/.exec(resXml) || [])[1]);
  await check('.mbz: la descripción del Libro Guía trae UN botón «Abrir Libro Guía» → su propio recurso, pestaña nueva', () => {
    assert(libroDir && mid > 0, 'recurso del Libro Guía');
    const anchors = [...intro.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
    assert(anchors.length === 1, `enlaces: ${anchors.length}`);
    const [, attrs, inner] = anchors[0];
    assert(/Abrir Libro Guía/.test(inner.replace(/<[^>]+>/g, '')), 'texto');
    assert(attrs.includes(`href="$@RESOURCEVIEWBYID*${mid}@$"`), `href → ${mid}: ${attrs}`);
    assert(/\btarget="_blank"/.test(attrs) && /\brel="[^"]*noopener/.test(attrs), 'target/rel');
    assert(/<display>5<\/display>/.test(resXml), 'display 5 (view.php entrega el archivo)');
    // el saneador de tokens del builder (assertTokensV3) lo deja pasar: el token apunta a un resource
    B.assertTokensV3(intro, new Map([[mid, 'resource']]), 'libro#intro');
    let threw = false;
    try { B.assertTokensV3(intro, new Map([[mid, 'page']]), 'libro#intro'); } catch { threw = true; }
    assert(threw, 'mal tipado → MBZ_V3_TOKEN_INVALID');
  });
  await check('.mbz: files.xml con UN solo Libro Guía, application/pdf, .pdf, en el contexto del recurso; blob = sha1', async () => {
    const libros = fileBlocks.filter((b) => /<filename>libro_guia/.test(b));
    assert(libros.length === 1, `libros: ${libros.length}`);
    const f = libros[0];
    assert(tag(f, 'mimetype') === 'application/pdf' && /^libro_guia_[a-z0-9_]+\.pdf$/.test(tag(f, 'filename')), `${tag(f, 'filename')} ${tag(f, 'mimetype')}`);
    assert(Number(tag(f, 'contextid')) === ctx && tag(f, 'component') === 'mod_resource' && tag(f, 'filearea') === 'content', 'contexto del recurso');
    const h = tag(f, 'contenthash');
    const blob = await z.file(`files/${h.slice(0, 2)}/${h}`).async('nodebuffer');
    assert(crypto.createHash('sha1').update(blob).digest('hex') === h && blob.subarray(0, 5).toString() === '%PDF-', 'blob');
    assert(!fileBlocks.some((b) => /libro_guia_completo\.html/.test(b)), 'sin copia HTML');
    const inforef = await z.file(`${libroDir}/inforef.xml`).async('string');
    assert(inforef.includes(`<id>${(/<file id="(\d+)"/.exec(f) || [])[1]}</id>`), 'inforef');
    const a = await analyze(blob);
    const title = built.expectations.facts.course.title;
    assert(a.pages.every((p) => p.imgCount === 1) && a.text.includes(title) && a.info.Title === title, 'PDF del paquete: marca de agua y /Title = título del curso (sin mezcla de cursos)');
    assert(built.summary.libro && built.summary.libro.logoSource === 'cursia_default' && built.summary.libro.pageCount === a.numPages, JSON.stringify(built.summary.libro));
    assert(built.expectations.facts.libro.wordCount > 100, 'palabras medidas');
  });
  const exp = { facts: built.expectations.facts, resolved: built.expectations.resolved, examBankPlans: built.expectations.examBankPlans, shellProseByLabel: built.expectations.shellProseByLabel, builderVersion: built.expectations.builderVersion };
  await check('.mbz: validador v3 en verde (builder 3.13.0)', async () => {
    assert(built.expectations.builderVersion === '3.13.0', built.expectations.builderVersion);
    const v = await V.validateMbzV3(built.mbz, exp);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 5)));
  });
  const mutate = async (fn) => {
    const zz = await JSZip.loadAsync(built.mbz);
    await fn(zz);
    return zz.generateAsync({ type: 'nodebuffer' });
  };
  await check('.mbz: validador ROJO ante botón sin target, token a otro mid, PDF truncado o mimetype HTML', async () => {
    const rx = `${libroDir}/resource.xml`;
    const cases = [
      ['sin target', (zz) => zz.file(rx, resXml.replace(/ target=&quot;_blank&quot;/, '')), 'LIBRO_CTA'],
      ['otro mid', (zz) => zz.file(rx, resXml.replace(`RESOURCEVIEWBYID*${mid}@$`, `RESOURCEVIEWBYID*${mid + 1}@$`)), 'LIBRO_CTA'],
      ['sin botón', (zz) => zz.file(rx, resXml.replace(/&lt;a [\s\S]*?&lt;\/a&gt;/, '')), 'LIBRO_CTA'],
      ['mimetype html', (zz) => zz.file('files.xml', filesXml.replace('<mimetype>application/pdf</mimetype>', '<mimetype>text/html</mimetype>')), 'LIBRO'],
      ['pdf truncado', async (zz) => {
        const f = fileBlocks.find((b) => /<filename>libro_guia/.test(b));
        const h = tag(f, 'contenthash');
        const blob = await zz.file(`files/${h.slice(0, 2)}/${h}`).async('nodebuffer');
        zz.file(`files/${h.slice(0, 2)}/${h}`, blob.subarray(0, blob.length - 200));
      }, 'LIBRO'],
    ];
    for (const [name, fn, code] of cases) {
      const v = await V.validateMbzV3(await mutate(fn), exp);
      assert(!v.ok && v.issues.some((i) => i.code === code), `${name}: ${JSON.stringify(v.issues.map((i) => i.code))}`);
    }
  });
  await check('.mbz: logo inválido de la cuenta → paquete con Cursia y aviso libro_logo_invalid en el resumen; logo válido → su sha', async () => {
    const bad = await B.buildDynamicMbzV3({ ...input, libroBrand: { logo: { source: 'user_settings', dataUri: dataUri('image/svg+xml', Buffer.from('<svg/>')) }, name: 'Colegio Demo' } });
    assert(bad.summary.warnings.includes('libro_logo_invalid:user_settings:svg_unsupported'), JSON.stringify(bad.summary.warnings));
    assert(bad.summary.libro.logoSource === 'cursia_default', 'Cursia');
    const good = await B.buildDynamicMbzV3({ ...input, libroBrand: { logo: { source: 'brand_profile', dataUri: dataUri('image/png', accountPng()) }, name: 'Colegio Demo' } });
    assert(good.summary.libro.logoSource === 'brand_profile' && !good.summary.warnings.some((w) => w.startsWith('libro_logo')), JSON.stringify(good.summary));
    const v = await V.validateMbzV3(good.mbz, { ...exp, facts: good.expectations.facts });
    assert(v.ok, JSON.stringify(v.issues.slice(0, 3)));
  });
  await check('clave de reuse: el logo resuelto (y el nombre) cambian la clave; logo inválido = misma clave que sin logo', () => {
    const base = { builderVersion: '3.13.0', manifestSha256: 'm', sourceArtifactIds: ['a'], themeSha256: 't', assessmentProfileSha256: 'p', h5pProfileVersion: 1, vcRendererVersion: 'v', moodleVersion: '4.5' };
    const fp = (logo, name = null) => PK.libroBrandFingerprintV3({ logo, name }).sha256;
    const none = fp(null);
    const acct = fp({ source: 'user_settings', dataUri: dataUri('image/png', accountPng()) });
    const acct2 = fp({ source: 'user_settings', dataUri: dataUri('image/png', accountPng(true)) });
    const svg = fp({ source: 'user_settings', dataUri: dataUri('image/svg+xml', Buffer.from('<svg/>')) });
    const k = (s) => PK.packageReuseHashV3({ ...base, libroBrandSha256: s });
    assert(new Set([k(none), k(acct), k(acct2), k(fp(null, 'Colegio'))]).size === 4, 'claves distintas');
    assert(k(svg) === k(none), 'inválido = Cursia');
    assert(PK.libroBrandFingerprintV3({ logo: { source: 'user_settings', dataUri: 'x' }, name: null }).warnings[0].startsWith('libro_logo_invalid'), 'aviso');
  });
  await check('loadLibroBrandV3: brand_profiles activo → user_settings → nada; tabla ausente no rompe; error de consulta → aviso', async () => {
    const mk = (rows) => ({ query: async (sql) => {
      if (/from public\.courses/.test(sql)) return [{ owner_id: 'u1', institution_id: rows.inst ? 'i1' : null }];
      if (/to_regclass/.test(sql)) return [{ bp: rows.bp !== false, us: rows.us !== false, inst: true }];
      if (/from public\.institutions/.test(sql)) return [{ name: 'Instituto Demo' }];
      if (/from public\.brand_profiles/.test(sql)) return rows.bpRow ? [rows.bpRow] : [];
      if (/from public\.user_settings/.test(sql)) return rows.usRow ? [rows.usRow] : [];
      throw new Error(`SQL inesperado: ${sql}`);
    } });
    let b = await PK.loadLibroBrandV3(mk({ inst: true, bpRow: { logo_url: 'data:image/png;base64,AAA' }, usRow: { logo_b64: 'data:image/png;base64,BBB' } }), 1, 'u1');
    assert(b.logo.source === 'brand_profile' && b.name === 'Instituto Demo', JSON.stringify(b));
    b = await PK.loadLibroBrandV3(mk({ inst: true, bpRow: { logo_url: null, logo_artifact_id: 'x' }, usRow: { logo_b64: 'data:image/png;base64,BBB' } }), 1, 'u1');
    assert(b.logo.source === 'user_settings' && b.warnings.includes('libro_logo_artifact_unsupported:brand_profile'), JSON.stringify(b));
    b = await PK.loadLibroBrandV3(mk({ inst: false, us: false }), 1, 'u1');
    assert(b.logo === null && b.warnings.length === 0, JSON.stringify(b));
    b = await PK.loadLibroBrandV3({ query: async () => { throw new Error('boom'); } }, 1, 'u1');
    assert(b.logo === null && /^libro_logo_lookup_failed/.test(b.warnings[0]), JSON.stringify(b));
  });

  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    const { createCanvas } = require(require.resolve('@napi-rs/canvas', { paths: [ROOT] }));
    const f = fileBlocks.find((b) => /<filename>libro_guia/.test(b));
    const h = tag(f, 'contenthash');
    const toRender = { fixture: await z.file(`files/${h.slice(0, 2)}/${h}`).async('nodebuffer'), large: results.large.r.pdf };
    for (const [name, buf] of Object.entries(toRender)) {
      fs.writeFileSync(path.join(OUT, `libro-${name}.pdf`), buf);
      const d = await loadPdf(buf);
      for (const p of [...new Set([1, 2, Math.ceil(d.numPages / 2)])]) {
        const pg = await d.getPage(p);
        const vp = pg.getViewport({ scale: 1.5 });
        const cv = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
        const cx = cv.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
        await pg.render({ canvasContext: cx, viewport: vp, canvas: cv }).promise;
        fs.writeFileSync(path.join(OUT, `libro-${name}-p${String(p).padStart(2, '0')}.png`), cv.toBuffer('image/png'));
      }
    }
    console.log(`(PNG de páginas en ${OUT})`);
  }

  console.log(fails ? `\n${fails} ❌, ${passes} ✅` : `\nTodos los checks r19 del Libro Guía en PDF pasaron (${passes} ✅, 0 ❌).`);
  clearInterval(keepAlive);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('❌ fallo inesperado', e);
  process.exit(1);
});
