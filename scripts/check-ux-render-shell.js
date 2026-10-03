#!/usr/bin/env node
/* eslint-disable */
// UX r18 — render del curso empaquetado (builder v3 3.12.0). Sin DB, sin red, sin proveedores.
//
//   (a) Bienvenida: la sección 0 abre con el hero con tema (cv3:shell:welcome) justo bajo el encabezado
//       de Moodle y cierra con el foro «📢 Avisos del Curso»; el hero no repite «Bienvenida» (r19 W, 3.13.0: su única
//       línea meta es «Curso · N módulos · M capítulos», de facts);
//       sequence de section.xml = orden de moodle_backup.xml = moduleid de cada module.xml; en TODAS las
//       familias de diseño; el validador marca SECTIONS si el orden se rompe.
//   (b) Audio: audio() emite preload="metadata" (nunca "none"), también en los labels empaquetados.
//   (c) MP3 con frame Info: SOLO los MP3 finales de v3 (concatMp3/assembleAudiobook, también con UNA parte)
//       escriben un Info con el conteo REAL de frames y bytes (parser independiente, port de
//       r18/diagC/mp3scan.py). El transcode genérico (tts.service, audio-worker legacy, POST /tts/speech) NO
//       escribe Info: mismos argumentos de siempre (salida pipe:1) y devuelve tal cual lo que da ffmpeg (ffmpeg
//       FALSO en el PATH: no hay ffmpeg en esta máquina); sin ffmpeg → el buffer original.
//   (d) Portada: ≥ 1600 px desde un raster de 2000×1125 (cubre los 1544 px físicos de la columna a DPR 2).
//       Nitidez contra una referencia INDEPENDIENTE: la fuente reducida con un filtro triangular (tent), otro
//       método que el filtro de caja del builder. Umbrales: varianza del laplaciano ≥ 1.0 × referencia y
//       PSNR ≥ 40 dB contra ella; el tope viejo (640, ampliado) queda ≤ 0.2 × y < 35 dB. Las cifras a 1544 px
//       (ampliación/reducción bilineal, como el navegador) se imprimen. El <img> conserva width="240" (R13).
//   (e) «Iniciar actividad»: sin botón cuando la actividad H5P va embebida (el intro conserva el respaldo
//       «Ábrela en su propia página →»); SCORM lo conserva; finalización/nota de la actividad intactas;
//       el validador marca NAVIGATION en ambos sentidos.
//
// Opcional: UX_COVER_RASTER_DIR=<dir con p150_*.png> repite (d) sobre rasters reales y muestra las cifras.
//
// Usage: node scripts/check-ux-render-shell.js [path/to/dist]

const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const distArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const distRoot = path.resolve(process.cwd(), distArg || 'dist');
function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error('   (¿corriste "npm run build" antes? — dist/ no se versiona)');
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

// Directorio temporal propio ANTES de cargar el transcode (os.tmpdir() lee TMPDIR en cada llamada).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-ux-render-check-'));
process.env.TMPDIR = TMP;

const B = loadDist('package/dynamic-mbz-builder-v3.js');
const V = loadDist('package/v3/mbz-validator-v3.js');
const S = loadDist('modules/course-shell/index.js');
const HTML = loadDist('modules/course-shell/html.js');
const te = loadDist('modules/theme-engine/index.js');
const AUDIO = loadDist('package/audio/index.js');
const PNG = loadDist('package/v3/png-downscale.js');
const MEDIA = loadDist('package/v3/synthetic-media.js');
const TC = loadDist('tts/mp3-transcode.util.js');
const PF = require('./lib/v21-packaging-fixtures');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { assert(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
const visibleText = (html) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function pkg(mbz) {
  const z = await JSZip.loadAsync(mbz);
  const backup = await z.file('moodle_backup.xml').async('string');
  const acts = [];
  for (const m of backup.matchAll(/<activity>\s*<moduleid>(\d+)<\/moduleid>\s*<sectionid>(\d+)<\/sectionid>\s*<modulename>(\w+)<\/modulename>/g)) {
    const mid = Number(m[1]);
    const dir = `activities/${m[3]}_${mid}`;
    const mod = await z.file(`${dir}/module.xml`).async('string');
    acts.push({ mid, section: Number(m[2]), modname: m[3], dir, module: mod, idnumber: /<idnumber>([^<]*)<\/idnumber>/.exec(mod)[1] });
  }
  const xmlOf = async (a) => z.file(`${a.dir}/${a.modname}.xml`).async('string');
  const introOf = async (a) => unxml(/<intro>([\s\S]*?)<\/intro>/.exec(await xmlOf(a))?.[1] ?? '');
  return { z, acts, backup, xmlOf, introOf };
}
async function mutate(mbz, edits) {
  const z = await JSZip.loadAsync(mbz);
  for (const [file, fn] of Object.entries(edits)) {
    const cur = await z.file(file).async('string');
    const next = fn(cur);
    if (next === cur) throw new Error(`la mutación de ${file} no cambió nada`);
    z.file(file, next);
  }
  return z.generateAsync({ type: 'nodebuffer' });
}

// ── MP3: parser independiente (port de r18/diagC/mp3scan.py) ───────────────
const BR = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3scan(d) {
  let i = 0;
  let frames = 0;
  let dur = 0;
  let junk = 0;
  const xing = [];
  while (i < d.length - 4) {
    if (d.toString('latin1', i, i + 3) === 'ID3') {
      const sz = ((d[i + 6] & 0x7f) << 21) | ((d[i + 7] & 0x7f) << 14) | ((d[i + 8] & 0x7f) << 7) | (d[i + 9] & 0x7f);
      i += sz + 10;
      continue;
    }
    const h = d.readUInt32BE(i);
    if (((h >>> 21) & 0x7ff) === 0x7ff) {
      const ver = (h >>> 19) & 3, lay = (h >>> 17) & 3, bri = (h >>> 12) & 15, sri = (h >>> 10) & 3, pad = (h >>> 9) & 1, mode = (h >>> 6) & 3;
      const prot = (h >>> 16) & 1;
      if (ver !== 1 && lay === 1 && bri > 0 && bri < 15 && sri < 3) {
        const br = BR[ver === 3 ? 1 : 2][bri] * 1000, sr = SR[ver][sri];
        const spf = ver === 3 ? 1152 : 576;
        const fl = Math.floor(((ver === 3 ? 144 : 72) * br) / sr) + pad;
        const side = ver === 3 ? (mode !== 3 ? 32 : 17) : mode !== 3 ? 17 : 9;
        const o = i + 4 + (prot === 0 ? 2 : 0) + side;
        const tag = d.toString('latin1', o, o + 4);
        if (tag === 'Xing' || tag === 'Info') {
          const flags = d.readUInt32BE(o + 4);
          xing.push({ at: i, tag, frames: flags & 1 ? d.readUInt32BE(o + 8) : null, bytes: flags & 2 ? d.readUInt32BE(o + 12) : null, frameIndex: frames, spf, sr });
        } else {
          frames += 1;
          dur += spf / sr;
        }
        i += fl;
        continue;
      }
    }
    junk += 1;
    i += 1;
  }
  return { frames, dur, junk, xing };
}

// ── PNG / nitidez ───────────────────────────────────────────────────────────
function gray(dec) {
  const g = new Float64Array(dec.width * dec.height);
  for (let i = 0; i < g.length; i++) {
    const p = i * dec.channels;
    g[i] = 0.299 * dec.pixels[p] + 0.587 * dec.pixels[p + 1] + 0.114 * dec.pixels[p + 2];
  }
  return { w: dec.width, h: dec.height, g };
}
/** Bilineal (ampliación, como el navegador). */
function resize(img, tw, th) {
  const out = new Float64Array(tw * th);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(img.h - 1, Math.max(0, ((y + 0.5) * img.h) / th - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(img.h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(img.w - 1, Math.max(0, ((x + 0.5) * img.w) / tw - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(img.w - 1, x0 + 1), fx = sx - x0;
      const a = img.g[y0 * img.w + x0], b = img.g[y0 * img.w + x1], c = img.g[y1 * img.w + x0], d = img.g[y1 * img.w + x1];
      out[y * tw + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return { w: tw, h: th, g: out };
}
function lapVar(img) {
  let n = 0, s = 0, s2 = 0;
  for (let y = 1; y < img.h - 1; y++) {
    for (let x = 1; x < img.w - 1; x++) {
      const i = y * img.w + x;
      const v = img.g[i - 1] + img.g[i + 1] + img.g[i - img.w] + img.g[i + img.w] - 4 * img.g[i];
      n++; s += v; s2 += v * v;
    }
  }
  return s2 / n - (s / n) ** 2;
}
/** Raster «diapositiva» determinístico: fondo, bandas y trazos finos tipo texto (bordes duros). */
/**
 * Raster «diapositiva» determinístico: bloques de título, renglones de «texto», trazos diagonales y un gráfico
 * en damero. Se dibuja a 4× y se promedia 4×4 (antialias, como el rasterizador de pdftoppm), así los bordes
 * duros no producen el aliasing artificial de un patrón de 1 px.
 */
function slideRaster(w, h) {
  const S = 4, W = w * S, H = h * S;
  const at = (X, Y) => {
    const x = X / S, y = Y / S;
    if (y > h * 0.1 && y < h * 0.18 && x > w * 0.08 && x < w * 0.7 && Math.floor(x / 26) % 5 !== 4) return [30, 40, 60];
    if (y > h * 0.24 && y < h * 0.5 && x > w * 0.08 && x < w * 0.55 && Math.floor(y / 14) % 2 === 0 && (Math.floor(x / 9) % 7 !== 6) && ((y % 14) > 3)) return [50, 55, 70];
    if (y > h * 0.55 && x < w * 0.5 && ((x + 2 * y) % 60) < 5) return [120, 60, 20];
    if (x > w * 0.6 && y > h * 0.3 && y < h * 0.85 && ((Math.floor(x / 18) + Math.floor(y / 18)) % 2 === 0)) return [10, 110, 160];
    return [250, 248, 240];
  };
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const c = at(x * S + i + 0.5, y * S + j + 0.5); r += c[0]; g += c[1]; b += c[2]; }
      const o = (y * w + x) * 3;
      px[o] = Math.round(r / (S * S)); px[o + 1] = Math.round(g / (S * S)); px[o + 2] = Math.round(b / (S * S));
    }
  }
  void W; void H;
  return MEDIA.encodePng(w, h, 3, px);
}
const DISPLAY_PX = 1544; // 772 px CSS de la columna de Moodle × DPR 2 (r18/UX-diag-C.md)
/** Remuestreo separable con filtro triangular (tent), soporte = max(1, factor): referencia independiente del builder. */
function tent(img, tw, th) {
  const pass = (g, w, h, n, horiz) => {
    const L = horiz ? w : h;
    const sc = L / n;
    const sup = Math.max(1, sc);
    const W = [];
    for (let o = 0; o < n; o++) {
      const c = (o + 0.5) * sc - 0.5;
      const ws = [];
      let t = 0;
      for (let i = Math.max(0, Math.ceil(c - sup)); i <= Math.min(L - 1, Math.floor(c + sup)); i++) {
        const x = Math.max(0, 1 - Math.abs(i - c) / sup);
        ws.push([i, x]);
        t += x;
      }
      W.push(ws.map(([i, x]) => [i, x / t]));
    }
    const out = new Float64Array(horiz ? n * h : w * n);
    if (horiz) { for (let y = 0; y < h; y++) for (let o = 0; o < n; o++) { let a = 0; for (const [i, x] of W[o]) a += g[y * w + i] * x; out[y * n + o] = a; } }
    else { for (let o = 0; o < n; o++) for (let x0 = 0; x0 < w; x0++) { let a = 0; for (const [i, x] of W[o]) a += g[i * w + x0] * x; out[o * w + x0] = a; } }
    return out;
  };
  return { w: tw, h: th, g: pass(pass(img.g, img.w, img.h, tw, true), tw, img.h, th, false) };
}
function psnr(a, b) {
  let e = 0;
  for (let i = 0; i < a.g.length; i++) e += (a.g[i] - b.g[i]) ** 2;
  return 10 * Math.log10((255 * 255) / (e / a.g.length));
}
/**
 * Portada vs. referencia independiente (fuente → tent al ancho de la portada), y lo que ve el estudiante a
 * DPR 2 (bilineal a DISPLAY_PX, como el navegador; la referencia, tent a DISPLAY_PX).
 */
function coverSharpness(srcPng, coverPng, oldPng) {
  const S = gray(PNG.decodePng(srcPng));
  const C = gray(PNG.decodePng(coverPng));
  const O = gray(PNG.decodePng(oldPng));
  const ref = tent(S, C.w, C.h);
  const oldUp = resize(O, C.w, C.h);
  const dh = Math.round((C.h * DISPLAY_PX) / C.w);
  const refD = tent(S, DISPLAY_PX, dh), CD = resize(C, DISPLAY_PX, dh), OD = resize(O, DISPLAY_PX, dh);
  return {
    ref: lapVar(ref), cover: lapVar(C), old: lapVar(oldUp), psnrCover: psnr(C, ref), psnrOld: psnr(oldUp, ref),
    refD: lapVar(refD), coverD: lapVar(CD), oldD: lapVar(OD),
  };
}
function assertSharp(label, m) {
  console.log(`   ${label}: var. laplaciano ref(tent) ${m.ref.toFixed(1)} · portada ${m.cover.toFixed(1)} (${(m.cover / m.ref).toFixed(2)}×, PSNR ${m.psnrCover.toFixed(1)} dB) · 640 ampliada ${m.old.toFixed(1)} (${(m.old / m.ref).toFixed(2)}×, ${m.psnrOld.toFixed(1)} dB) | a ${DISPLAY_PX} px: ref ${m.refD.toFixed(1)} · portada ${m.coverD.toFixed(1)} (${(m.coverD / m.refD).toFixed(2)}×) · 640 ${m.oldD.toFixed(1)} (${(m.oldD / m.refD).toFixed(2)}×)`);
  assert(m.cover >= m.ref, `${label}: portada menos nítida que la referencia independiente (${m.cover} < ${m.ref})`);
  assert(m.psnrCover >= 40, `${label}: la portada se aparta de la referencia (PSNR ${m.psnrCover} < 40 dB)`);
  assert(m.old <= 0.2 * m.ref && m.psnrOld < 35, `${label}: control 640 px (${m.old}, ${m.psnrOld} dB) debía ser claramente peor`);
  assert(m.coverD >= 4 * m.oldD, `${label}: a ${DISPLAY_PX} px la portada debía ser ≥ 4× más nítida que la de 640 (${m.coverD} vs ${m.oldD})`);
}

(async () => {
  // ════ (a) Bienvenida: sección 0 en todas las familias ════
  const families = Object.entries(te.THEME_FAMILIES).map(([id, f]) => ({ themeFamily: id, mode: (f.supportedModes || ['light']).includes('light') ? 'light' : 'dark' }));
  // + el modo oscuro de la familia que soporta los dos (claro y oscuro).
  for (const [id, f] of Object.entries(te.THEME_FAMILIES)) if ((f.supportedModes || []).includes('dark') && (f.supportedModes || []).includes('light')) families.push({ themeFamily: id, mode: 'dark' });
  const built = {};
  for (const theme of families) {
    const key = `${theme.themeFamily}-${theme.mode}`;
    await check(`(a) [${key}] sección 0: hero primero bajo el encabezado, foro de avisos al final, sin kicker «Bienvenida»; sequence = moodle_backup = module.xml; validador OK`, async () => {
      const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, theme });
      const r = await B.buildDynamicMbzV3(input);
      built[key] = r;
      const P = await pkg(r.mbz);
      const sec0 = P.acts.filter((a) => a.section === 0);
      eq(sec0.map((a) => a.idnumber), ['cv3:shell:welcome', 'cv3:shell:audio_welcome', 'cv3:shell:competencies', 'cv3:shell:methodology', 'cv3:shell:start', 'cv3:shell:forum'], 'orden de la sección 0 (moodle_backup.xml)');
      const sx = await P.z.file('sections/section_0/section.xml').async('string');
      eq(/<sequence>([^<]*)<\/sequence>/.exec(sx)[1], sec0.map((a) => a.mid).join(','), 'sequence de section.xml = orden de moodle_backup.xml');
      eq(unxml(/<name>([^<]*)<\/name>/.exec(sx)[1]), 'Bienvenida', 'nombre corto y real de la sección 0');
      for (const a of sec0) {
        assert(new RegExp(`<module id="${a.mid}"`).test(a.module) && /<sectionnumber>0<\/sectionnumber>/.test(a.module), `${a.idnumber}: module.xml con su moduleid y la sección 0`);
      }
      const forum = sec0[sec0.length - 1];
      assert(forum.modname === 'forum' && new RegExp(`moduleid="${forum.mid}"`).test(await P.xmlOf(forum)), 'forum.xml con el moduleid del foro');
      const hero = await P.introOf(sec0[0]);
      // r19 W (builder 3.13.0): el hero lleva UNA línea meta, y es de cifras de facts («Curso · N módulos · M capítulos»),
      // nunca el kicker «Bienvenida» de antes (antes de 3.13.0 el hero no tenía línea meta; el criterio es el mismo).
      const kickers = [...hero.matchAll(/<p class="cvc-meta cvc-kicker"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => visibleText(m[1]).replace(/\u00AD/g, ''));
      assert(kickers.length === 1 && /^Curso · \d+ módulos? · \d+ capítulos?$/.test(kickers[0]), `línea meta del hero: ${JSON.stringify(kickers)}`);
      const txt = visibleText(hero);
      // Ningún elemento cuyo texto sea solo «Bienvenida» (el kicker viejo); la prosa («Te damos la bienvenida…») sí puede.
      assert(!/>\s*Bienvenida\s*</i.test(hero), `«Bienvenida» repetida como rótulo en el hero: ${txt.slice(0, 120)}`);
      assert(!txt.toLowerCase().startsWith('bienvenida'), 'el texto visible no empieza por el nombre de la sección 0');
      assert(txt.includes(r.expectations.facts.course.title), 'el hero abre con el título del curso');
      const v = await V.validateMbzV3(r.mbz, r.expectations);
      assert(v.ok, `validador: ${JSON.stringify(v.issues.slice(0, 5))}`);
    });
  }
  await check('(a) validador: sección 0 con el foro primero o sin el foro al final → SECTIONS (solo builder ≥ 3.12.0)', async () => {
    const r = built['aula-clara-light'];
    const P = await pkg(r.mbz);
    const [w, f] = ['cv3:shell:welcome', 'cv3:shell:forum'].map((id) => P.acts.find((a) => a.idnumber === id));
    // Intercambia los idnumbers: la sección 0 «abre» con el foro y «cierra» con la bienvenida.
    const bad = await mutate(r.mbz, {
      [`${w.dir}/module.xml`]: (x) => x.replace('<idnumber>cv3:shell:welcome</idnumber>', '<idnumber>cv3:shell:forum</idnumber>'),
      [`${f.dir}/module.xml`]: (x) => x.replace('<idnumber>cv3:shell:forum</idnumber>', '<idnumber>cv3:shell:welcome</idnumber>'),
    });
    const v = await V.validateMbzV3(bad, r.expectations);
    assert(v.issues.some((i) => i.code === 'SECTIONS' && /abre con cv3:shell:forum/.test(i.message)), JSON.stringify(v.issues.slice(0, 5)));
    assert(v.issues.some((i) => i.code === 'SECTIONS' && /cierra con cv3:shell:welcome/.test(i.message)), JSON.stringify(v.issues.slice(0, 5)));
    // Fix 1 (M4): con expectativas de un paquete anterior (sin builderVersion o 3.11.0) las reglas de UX r18 no aplican.
    for (const old of [undefined, '3.11.0', '3.9.9']) {
      const exp = { ...r.expectations };
      if (old === undefined) delete exp.builderVersion; else exp.builderVersion = old;
      const vo = await V.validateMbzV3(bad, exp);
      assert(!vo.issues.some((i) => /sección 0 (abre|cierra)/.test(i.message)), `builder ${old}: ${JSON.stringify(vo.issues.slice(0, 3))}`);
    }
    eq([V.builderVersionAtLeast('3.12.0', '3.12.0'), V.builderVersionAtLeast('3.13.1', '3.12.0'), V.builderVersionAtLeast('4.0.0', '3.12.0'), V.builderVersionAtLeast('3.11.9', '3.12.0'), V.builderVersionAtLeast(undefined, '3.12.0'), V.builderVersionAtLeast('x', '3.12.0')], [true, true, true, false, false, false], 'comparación de versiones');
    eq(r.expectations.builderVersion, B.DYNAMIC_MBZ_BUILDER_VERSION_V3, 'expectations.builderVersion = versión del builder');
  });

  // ════ (b) audio preload ════
  await check('(b) audio() emite preload="metadata" (nunca "none") y nombre accesible = título visible (title siempre; aria-label en ENHANCED), en todas las familias y en los labels empaquetados', async () => {
    for (const theme of families) {
      const h = HTML.hx(te.resolveTheme(theme));
      const html = HTML.audio(h, '@@PLUGINFILE@@/x.mp3', 'el audio', HTML.bgSurf(h), 'Audio de prueba');
      assert(html.includes('<audio controls preload="metadata" title="Audio de prueba" src="@@PLUGINFILE@@/x.mp3"') && !/preload="none"/.test(html) && !/aria-/.test(html), `${theme.themeFamily} CLEAN_SAFE: ${html.slice(0, 160)}`);
      const he = HTML.hx(te.resolveTheme(theme), { level: 'enhanced' });
      const enh = HTML.audio(he, '@@PLUGINFILE@@/x.mp3', 'el audio', HTML.bgSurf(he), 'Audio de prueba');
      assert(enh.includes('<audio controls preload="metadata" title="Audio de prueba" aria-label="Audio de prueba" src="@@PLUGINFILE@@/x.mp3"'), `${theme.themeFamily} ENHANCED: ${enh.slice(0, 160)}`);
      let threw = false;
      try { HTML.audio(h, '@@PLUGINFILE@@/x.mp3', 'el audio', HTML.bgSurf(h), ' '); } catch (_) { threw = true; }
      assert(threw, 'un reproductor sin nombre accesible falla fuerte');
    }
    const P = await pkg(built['editorial-light'].mbz);
    // Fix 1 (M6): nombre accesible = título visible del label.
    for (const [id, name] of [['cv3:shell:audio_welcome', 'Audio de bienvenida'], ['cv3:shell:audiobook', 'Audiolibro']]) {
      const intro = await P.introOf(P.acts.find((a) => a.idnumber === id));
      assert(new RegExp(`<audio controls preload="metadata" title="${name}"`).test(intro) && !/preload="none"/.test(intro), `${id}: preload + title (nombre accesible que sobrevive a forceclean)`);
      assert(new RegExp(`<h3[^>]*>(?:<[^>]+>)*${name}<`).test(intro), `${id}: el aria-label coincide con el título visible`);
    }
  });

  // ════ (c) MP3 con frame Info ════
  const FIX = path.join(__dirname, 'fixtures');
  const slices = ['slice-a.mp3', 'slice-b.mp3', 'slice-c.mp3'].map((f) => fs.readFileSync(path.join(FIX, f)));
  await check('(c) concatMp3: UN frame Info al inicio con el conteo REAL de frames y bytes (parser independiente) — TTS real (24 kHz mono) y sintético de 8 kbps', async () => {
    for (const [label, parts] of [['slices TTS', slices], ['sintético 8 kbps', [MEDIA.syntheticMp3(12), MEDIA.syntheticMp3(3.5)]]]) {
      const plain = parts.map((p) => mp3scan(p));
      const out = AUDIO.concatMp3(parts);
      const s = mp3scan(out);
      eq(s.junk, 0, `${label}: sin bytes basura`);
      eq(s.xing.length, 1, `${label}: exactamente un Info/Xing`);
      const x = s.xing[0];
      eq([x.tag, x.at, x.frameIndex], ['Info', 0, 0], `${label}: Info (CBR) como primer frame`);
      eq(x.frames, plain.reduce((n, p) => n + p.frames, 0), `${label}: frames declarados = suma de frames reales`);
      eq(x.frames, s.frames, `${label}: frames declarados = frames de audio contados en el resultado`);
      eq(x.bytes, out.length, `${label}: bytes declarados = tamaño real`);
      const declared = (x.frames * x.spf) / x.sr;
      assert(Math.abs(declared - AUDIO.mp3DurationSeconds(out)) < 1e-9 && Math.abs(declared - s.dur) < 1e-9, `${label}: duración del Info ${declared} = medida`);
    }
  });
  await check('(c) assembleAudiobook: el audiolibro ensamblado lleva Info con los frames reales; la duración sigue siendo la MEDIDA (las partes con Info propio no cuentan)', async () => {
    const withOwnInfo = AUDIO.concatMp3([slices[1]]); // una parte que ya trae Info
    const r = AUDIO.assembleAudiobook([
      { chapterId: 'c', chapterNumber: 3, mp3: slices[2] },
      { chapterId: 'a', chapterNumber: 1, mp3: slices[0] },
      { chapterId: 'b', chapterNumber: 2, mp3: withOwnInfo },
    ]);
    const s = mp3scan(r.buffer);
    eq(s.xing.length, 1, 'un solo Info (el de la parte se descarta)');
    eq(s.xing[0].frames, mp3scan(slices[0]).frames + mp3scan(slices[1]).frames + mp3scan(slices[2]).frames, 'frames del Info');
    assert(Math.abs(r.durationSeconds - s.dur) < 1e-9 && Math.abs((s.xing[0].frames * s.xing[0].spf) / s.xing[0].sr - r.durationSeconds) < 1e-9, 'duración medida = Info');
    const P = await pkg(built['aula-clara-light'].mbz);
    const files = await P.z.file('files.xml').async('string');
    const blk = files.match(/<file id="\d+">[\s\S]*?<\/file>/g).find((f) => /<filename>audiolibro\.mp3<\/filename>/.test(f));
    const h = /<contenthash>(\w+)</.exec(blk)[1];
    const mp3 = await P.z.file(`files/${h.slice(0, 2)}/${h}`).async('nodebuffer');
    const ps = mp3scan(mp3);
    assert(ps.xing.length === 1 && ps.xing[0].frames === ps.frames && ps.xing[0].bytes === mp3.length, `audiolibro.mp3 del paquete: ${JSON.stringify(ps.xing)} frames ${ps.frames}`);
    eq(Math.abs(built['aula-clara-light'].expectations.facts.audio.audiobookSeconds - ps.dur) < 1e-6, true, 'la duración del label es la de los frames reales');
  });

  // Transcode genérico: ffmpeg FALSO en el PATH (no hay ffmpeg en esta máquina). Con salida a pipe:1 el muxer mp3 de
  // ffmpeg no puede escribir Info/Xing (no es seekable) — el transcode no lo pide ni lo agrega.
  const fakeDir = fs.mkdtempSync(path.join(TMP, 'fake-ffmpeg-'));
  const argsLog = path.join(fakeDir, 'args.json');
  fs.writeFileSync(path.join(fakeDir, 'ffmpeg'), `#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(argsLog)},JSON.stringify(process.argv.slice(2)));\nconst c=[];process.stdin.on('data',(d)=>c.push(d));process.stdin.on('end',()=>{process.stdout.write(Buffer.concat(c));});\n`);
  fs.chmodSync(path.join(fakeDir, 'ffmpeg'), 0o755);
  const original = fs.readFileSync(path.join(FIX, 'welcome-100f.mp3'));
  const PATH0 = process.env.PATH;
  await check('(c) transcode genérico (tts.service / audio-worker legacy / POST /tts/speech): argumentos de siempre (salida pipe:1, sin -write_xing), NO agrega frame Info', async () => {
    process.env.PATH = `${fakeDir}${path.delimiter}${PATH0}`;
    try {
      const out = await TC.transcodeMp3Bitrate(original, 64);
      eq(JSON.parse(fs.readFileSync(argsLog, 'utf8')), ['-i', 'pipe:0', '-ac', '1', '-b:a', '64k', '-f', 'mp3', 'pipe:1'], 'argumentos de ffmpeg');
      assert(out.equals(original), 'devuelve exactamente lo que escribe ffmpeg');
      eq(mp3scan(out).xing.length, 0, 'sin frame Info/Xing');
      eq(mp3scan(original).xing.length, 0, 'fixture sin Info');
    } finally {
      process.env.PATH = PATH0;
    }
  });
  await check('(c) transcode genérico sin ffmpeg (ENOENT) → buffer ORIGINAL intacto', async () => {
    process.env.PATH = fakeDir.replace(/fake-ffmpeg-.*/, 'no-existe');
    try {
      const out = await TC.transcodeMp3Bitrate(original, 64);
      assert(out === original, 'debe devolver el mismo buffer');
    } finally {
      process.env.PATH = PATH0;
    }
  });
  await check('(c) MP3 final v3 de UNA sola parte (bienvenida corta): concatMp3([parte]) también lleva el Info con sus frames reales', async () => {
    const out = AUDIO.concatMp3([original]);
    const s = mp3scan(out);
    eq([s.xing.length, s.xing[0] && s.xing[0].frames, s.frames, s.xing[0] && s.xing[0].bytes], [1, mp3scan(original).frames, mp3scan(original).frames, out.length], 'Info de una parte');
    assert(out.subarray(out.length - original.length).equals(original), 'el audio que sigue al Info es el original byte a byte');
  });

  // ════ (d) Portada ════
  const src = slideRaster(2000, 1125);
  await check(`(d) portada: raster 2000×1125 → ${PNG.COVER_MAX_WIDTH} px (≥ 1600 ≥ ${DISPLAY_PX} px físicos a DPR 2), nitidez ≥ referencia independiente (tent) y PSNR ≥ 40 dB; el tope viejo (640) no`, async () => {
    assert(PNG.COVER_MAX_WIDTH >= 1600, `COVER_MAX_WIDTH ${PNG.COVER_MAX_WIDTH}`);
    const r = PNG.downscaleCoverPng(src);
    eq([r.width, r.height, r.downscaled], [1600, 900, true], 'dimensiones');
    assert(r.width >= DISPLAY_PX, `la portada (${r.width} px) no cubre los ${DISPLAY_PX} px físicos de la columna a DPR 2: el navegador la ampliaría`);
    const W = r.width;
    assertSharp(`sintético ${W}×${r.height} (${r.png.length} B)`, coverSharpness(src, r.png, PNG.downscaleCoverPng(src, 640).png));
    // Sin pérdida: el filtro adaptativo decodifica a los mismos píxeles que el filtro de caja.
    const dec = PNG.decodePng(r.png);
    const plain = PNG.decodePng(MEDIA.encodePng(dec.width, dec.height, dec.channels, dec.pixels));
    assert(dec.pixels.equals(plain.pixels), 'PNG filtrada sin pérdida');
    eq(PNG.downscaleCoverPng(r.png).reason, 'already_small', 'una portada de 1600 px no se toca');
  });
  const realDir = process.env.UX_COVER_RASTER_DIR;
  if (realDir && fs.existsSync(realDir)) {
    await check('(d) rasters reales (UX_COVER_RASTER_DIR): ≥ 1600 px y nitidez ≥ referencia independiente (tent), PSNR ≥ 40 dB', async () => {
      for (const f of fs.readdirSync(realDir).filter((x) => /^p150_.*\.png$/.test(x)).sort()) {
        const b = fs.readFileSync(path.join(realDir, f));
        const r = PNG.downscaleCoverPng(b);
        const o = PNG.downscaleCoverPng(b, 640);
        assert(r.width >= 1600, `${f}: ${r.width} px`);
        assertSharp(`${f} (fuente ${b.length} B · 640 ${o.png.length} B · ${r.width}×${r.height} ${r.png.length} B)`, coverSharpness(b, r.png, o.png));
      }
    });
  }
  await check('(d) paquete: portada de 1600 px en el filearea intro, <img width="240"> (R13, forceclean) intacto, sin avisos', async () => {
    const input = PF.packagingInput(distRoot, { engine: 'scorm', finalExam: false, theme: { themeFamily: 'institucional', mode: 'light' } });
    for (const [id, p] of input.contents.presentations) input.contents.presentations.set(id, { ...p, cover: src });
    const r = await B.buildDynamicMbzV3(input);
    const P = await pkg(r.mbz);
    const files = await P.z.file('files.xml').async('string');
    const cards = P.acts.filter((a) => /:presentation$/.test(a.idnumber));
    assert(cards.length > 0, 'tarjetas');
    let total = 0;
    for (const a of cards) {
      const intro = await P.introOf(a);
      assert(/<img [^>]*width="240"/.test(intro), `${a.idnumber}: width="240"`);
      const ctx = /contextid="(\d+)"/.exec(await P.xmlOf(a))[1];
      const blk = files.match(/<file id="\d+">[\s\S]*?<\/file>/g).find((f) => f.includes(`<contextid>${ctx}</contextid>`) && /portada\.png/.test(f));
      assert(/<filearea>intro<\/filearea>/.test(blk) && /<mimetype>image\/png<\/mimetype>/.test(blk), `${a.idnumber}: PNG en intro`);
      const h = /<contenthash>(\w+)</.exec(blk)[1];
      const png = await P.z.file(`files/${h.slice(0, 2)}/${h}`).async('nodebuffer');
      const dec = PNG.decodePng(png);
      eq([dec.width, dec.height], [1600, 900], `${a.idnumber}: portada`);
      total += png.length;
    }
    eq(r.summary.warnings.filter((w) => /cover/.test(w)), [], 'sin avisos de portada');
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, `validador: ${JSON.stringify(v.issues.slice(0, 5))}`);
    console.log(`   paquete: ${cards.length} portadas = ${total} B; .mbz ${r.mbz.length} B`);
  });

  // ════ (e) «Iniciar actividad» ════
  await check('(e) activityEmbedsInline: true solo para H5P (embebida en su intro); SCORM y desconocidos → false', () => {
    eq([S.activityEmbedsInline('h5p'), S.activityEmbedsInline('scorm'), S.activityEmbedsInline(undefined), S.activityEmbedsInline('otro')], [true, false, false, false], 'predicado');
  });
  const engines = {};
  for (const engine of ['h5p', 'scorm']) {
    await check(`(e) paquete ${engine}: ${engine === 'h5p' ? 'SIN' : 'CON'} botón «Iniciar actividad» en la instrucción; ${engine === 'h5p' ? 'el intro embebido conserva «Ábrela en su propia página →»' : 'apunta a su SCORM'}; finalización por aprobado intacta`, async () => {
      const r = engine === 'h5p' ? built['aula-clara-light'] : await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine, finalExam: true, theme: { themeFamily: 'editorial', mode: 'light' } }));
      engines[engine] = r;
      const P = await pkg(r.mbz);
      const instr = P.acts.filter((a) => /:activity_instruction$/.test(a.idnumber));
      assert(instr.length > 0, 'hay prácticas');
      for (const a of instr) {
        const i = P.acts.indexOf(a);
        const next = P.acts[i + 1];
        eq(next.idnumber, a.idnumber.replace(/:activity_instruction$/, ':activity'), 'la actividad va justo después');
        const intro = await P.introOf(a);
        const actIntro = await P.introOf(next);
        if (engine === 'h5p') {
          eq(next.modname, 'h5pactivity', 'H5P');
          assert(!intro.includes('Iniciar actividad') && !/VIEWBYID\*\d+@\$/.test(intro) && !intro.includes('cursia-cta://'), `${a.idnumber}: botón hacia la actividad embebida`);
          assert(/data-cursia-src="[^"]*embed\.php/.test(actIntro) || /embed\.php/.test(actIntro), `${next.idnumber}: embed en el intro`);
          assert(actIntro.includes(`$@H5PACTIVITYVIEWBYID*${next.mid}@$`) && /Ábrela en su propia página/.test(actIntro), `${next.idnumber}: respaldo «Ábrela en su propia página →»`);
        } else {
          eq(next.modname, 'scorm', 'SCORM');
          assert(intro.includes('Iniciar actividad →') && intro.includes(`href="$@SCORMVIEWBYID*${next.mid}@$"`), `${a.idnumber}: botón al SCORM`);
          assert(!intro.includes('cursia-cta://'), `${a.idnumber}: marcador next-activity resuelto`);
        }
        assert(/<completion>2<\/completion>/.test(next.module) && /<completionpassgrade>1<\/completionpassgrade>/.test(next.module) && /<completionview>0<\/completionview>/.test(next.module), `${next.idnumber}: finalización por aprobado`);
        const grades = await P.z.file(`${next.dir}/grades.xml`).async('string');
        assert(/<grade_item id="\d+">/.test(grades) && /<grademax>100\.00000<\/grademax>/.test(grades), `${next.idnumber}: grade item`);
      }
      const v = await V.validateMbzV3(r.mbz, r.expectations);
      assert(v.ok, `validador: ${JSON.stringify(v.issues.slice(0, 5))}`);
    });
  }
  await check('(e) validador: botón hacia una H5P embebida → NAVIGATION; SCORM sin su botón → NAVIGATION', async () => {
    {
      const r = engines.h5p;
      const P = await pkg(r.mbz);
      const a = P.acts.find((x) => /:activity_instruction$/.test(x.idnumber));
      const next = P.acts[P.acts.indexOf(a) + 1];
      // Reemplazo por FUNCIÓN: en un string de reemplazo «$&» (de «@$&quot;») es el match entero (CLAUDE.md, fix 1).
      const btn = `&lt;p&gt;&lt;a href=&quot;$@H5PACTIVITYVIEWBYID*${next.mid}@$&quot;&gt;Iniciar actividad →&lt;/a&gt;&lt;/p&gt;</intro>`;
      const bad = await mutate(r.mbz, { [`${a.dir}/label.xml`]: (x) => x.replace('</intro>', () => btn) });
      const v = await V.validateMbzV3(bad, r.expectations);
      assert(v.issues.some((i) => i.code === 'NAVIGATION' && /ya está embebida/.test(i.message)), JSON.stringify(v.issues.slice(0, 5)));
    }
    {
      const r = engines.scorm;
      const P = await pkg(r.mbz);
      const a = P.acts.find((x) => /:activity_instruction$/.test(x.idnumber));
      const bad = await mutate(r.mbz, { [`${a.dir}/label.xml`]: (x) => x.replace(/\$@SCORMVIEWBYID\*\d+@\$/, '#') });
      const v = await V.validateMbzV3(bad, r.expectations);
      assert(v.issues.some((i) => i.code === 'NAVIGATION' && /sin botón «Iniciar actividad»/.test(i.message)), JSON.stringify(v.issues.slice(0, 5)));
      // Fix 1 (M3): el marcador «next-activity» del SCORM sin resolver → TOKEN_INVALID.
      const raw = await mutate(r.mbz, { [`${a.dir}/label.xml`]: (x) => x.replace(/\$@SCORMVIEWBYID\*\d+@\$/, () => 'cursia-cta://next-activity') });
      const vr = await V.validateMbzV3(raw, r.expectations);
      assert(vr.issues.some((i) => i.code === 'TOKEN_INVALID' && i.where === a.idnumber), JSON.stringify(vr.issues.slice(0, 5)));
      // Fix 1 (M4): con expectativas de un paquete 3.11.0 la regla nueva no aplica.
      const vo = await V.validateMbzV3(bad, { ...r.expectations, builderVersion: '3.11.0' });
      assert(!vo.issues.some((i) => i.code === 'NAVIGATION' && /Iniciar actividad/.test(i.message)), JSON.stringify(vo.issues.slice(0, 5)));
    }
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${failures ? 'HAY FALLOS' : 'OK'} (${passes} ✅, ${failures} ❌).`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
