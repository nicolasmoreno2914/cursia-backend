#!/usr/bin/env node
/* eslint-disable */
// UX r18 — render del curso empaquetado (builder v3 3.12.0). Sin DB, sin red, sin proveedores.
//
//   (a) Bienvenida: la sección 0 abre con el hero con tema (cv3:shell:welcome) justo bajo el encabezado
//       de Moodle y cierra con el foro «📢 Avisos del Curso»; el hero no repite «Bienvenida» (sin kicker);
//       sequence de section.xml = orden de moodle_backup.xml = moduleid de cada module.xml; en TODAS las
//       familias de diseño; el validador marca SECTIONS si el orden se rompe.
//   (b) Audio: audio() emite preload="metadata" (nunca "none"), también en los labels empaquetados.
//   (c) MP3 con frame Info: concatMp3/assembleAudiobook escriben un Info con el conteo REAL de frames y
//       bytes (parser independiente, port de r18/diagC/mp3scan.py); transcodeMp3Bitrate escribe a un
//       archivo temporal con -write_xing 1 (ffmpeg FALSO vía FFMPEG_BIN: no hay ffmpeg en esta máquina),
//       borra el temporal, y sin ffmpeg / con error devuelve el buffer original (comportamiento previo).
//   (d) Portada: ≥ 1600 px desde un raster de 2000×1125 (cubre los 1544 px físicos de la columna a DPR 2),
//       nitidez (varianza del laplaciano) a su ancho no peor que la fuente llevada al mismo ancho; el <img>
//       conserva width="240" (R13, forceclean).
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
/** Promedio por área (reducción sin aliasing, como el filtro de caja del builder). */
function boxDown(img, tw, th) {
  const out = new Float64Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const y0 = (ty * img.h) / th, y1 = ((ty + 1) * img.h) / th;
    for (let tx = 0; tx < tw; tx++) {
      const x0 = (tx * img.w) / tw, x1 = ((tx + 1) * img.w) / tw;
      let acc = 0, area = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          acc += img.g[sy * img.w + sx] * wx * wy;
          area += wx * wy;
        }
      }
      out[ty * tw + tx] = acc / area;
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
function slideRaster(w, h) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      let r = 250, g = 248, b = 240;
      if (y > h * 0.12 && y < h * 0.3 && (Math.floor(x / 7) % 3 !== 0) && (Math.floor(y / 5) % 4 !== 0) && x > w * 0.08 && x < w * 0.8) { r = 30; g = 40; b = 60; }
      if (y > h * 0.4 && ((x * 13 + y * 7) % 23) < 3) { r = 120; g = 60; b = 20; }
      if (x > w * 0.6 && y > h * 0.5 && ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0)) { r = 10; g = 110; b = 160; }
      px[o] = r; px[o + 1] = g; px[o + 2] = b;
    }
  }
  return MEDIA.encodePng(w, h, 3, px);
}
const DISPLAY_PX = 1544; // 772 px CSS de la columna de Moodle × DPR 2 (r18/UX-diag-C.md)
/**
 * Nitidez (varianza del laplaciano) de una imagen llevada a `W` px de ancho: reducción por área si es más
 * grande, ampliación bilineal (como el navegador) si es más chica. Se compara la portada contra la FUENTE
 * llevada al mismo ancho: cuánto detalle de la fuente conserva la portada a su tamaño.
 */
function sharpnessAt(pngBuf, W) {
  const img = gray(PNG.decodePng(pngBuf));
  const th = Math.round((img.h * W) / img.w);
  return lapVar(img.w >= W ? boxDown(img, W, th) : resize(img, W, th));
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
      assert(!/cvc-kicker/.test(hero), 'el hero no lleva kicker');
      const txt = visibleText(hero);
      // Ningún elemento cuyo texto sea solo «Bienvenida» (el kicker viejo); la prosa («Te damos la bienvenida…») sí puede.
      assert(!/>\s*Bienvenida\s*</i.test(hero), `«Bienvenida» repetida como rótulo en el hero: ${txt.slice(0, 120)}`);
      assert(!txt.toLowerCase().startsWith('bienvenida'), 'el texto visible no empieza por el nombre de la sección 0');
      assert(txt.includes(r.expectations.facts.course.title), 'el hero abre con el título del curso');
      const v = await V.validateMbzV3(r.mbz, r.expectations);
      assert(v.ok, `validador: ${JSON.stringify(v.issues.slice(0, 5))}`);
    });
  }
  await check('(a) validador: sección 0 con el foro primero o sin el foro al final → SECTIONS', async () => {
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
  });

  // ════ (b) audio preload ════
  await check('(b) audio() emite preload="metadata" (nunca "none") en todas las familias; los labels de audio empaquetados también', async () => {
    for (const theme of families) {
      const h = HTML.hx(te.resolveTheme(theme));
      const html = HTML.audio(h, '@@PLUGINFILE@@/x.mp3', 'el audio', HTML.bgSurf(h));
      assert(html.includes('<audio controls preload="metadata" src="@@PLUGINFILE@@/x.mp3"') && !/preload="none"/.test(html), `${theme.themeFamily}: ${html.slice(0, 160)}`);
    }
    const P = await pkg(built['editorial-light'].mbz);
    for (const id of ['cv3:shell:audio_welcome', 'cv3:shell:audiobook']) {
      const intro = await P.introOf(P.acts.find((a) => a.idnumber === id));
      assert(/<audio controls preload="metadata"/.test(intro) && !/preload="none"/.test(intro), `${id}: preload`);
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

  // Transcode: ffmpeg falso (no hay ffmpeg en esta máquina; ver el reporte).
  const fakeDir = fs.mkdtempSync(path.join(TMP, 'fake-ffmpeg-'));
  const argsLog = path.join(fakeDir, 'args.json');
  const infoMp3 = path.join(fakeDir, 'with-info.mp3');
  fs.writeFileSync(infoMp3, AUDIO.concatMp3([fs.readFileSync(path.join(FIX, 'welcome-100f.mp3'))]));
  const fake = (name, body) => {
    const p = path.join(fakeDir, name);
    fs.writeFileSync(p, `#!${process.execPath}\nconst fs=require('fs');const a=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(argsLog)},JSON.stringify(a));\nlet n=0;process.stdin.on('data',(c)=>{n+=c.length});process.stdin.on('end',()=>{${body}});\n`);
    fs.chmodSync(p, 0o755);
    return p;
  };
  const fakeOk = fake('ffmpeg-ok', `const out=a[a.length-1];if(!a.includes('-write_xing')||a[a.indexOf('-write_xing')+1]!=='1'||/^pipe:/.test(out)){process.stderr.write('bad args');process.exit(3)}fs.writeFileSync(out,fs.readFileSync(${JSON.stringify(infoMp3)}));process.exit(0);`);
  const fakeFail = fake('ffmpeg-fail', `process.stderr.write('boom');process.exit(1);`);
  const fakeNoOut = fake('ffmpeg-noout', `process.exit(0);`);
  const leftovers = () => fs.readdirSync(TMP).filter((f) => f.startsWith('cursia-mp3-transcode-'));
  const original = fs.readFileSync(path.join(FIX, 'welcome-100f.mp3'));
  await check('(c) transcodeMp3Bitrate: ffmpeg escribe a un archivo temporal con -write_xing 1 (no pipe:1), se lee ese archivo (con Info) y el temporal se borra', async () => {
    process.env.FFMPEG_BIN = fakeOk;
    const out = await TC.transcodeMp3Bitrate(original, 64);
    const args = JSON.parse(fs.readFileSync(argsLog, 'utf8'));
    eq(args.slice(0, 4), ['-i', 'pipe:0', '-ac', '1'], 'entrada por stdin, mono');
    assert(args.includes('64k') && args[args.indexOf('-write_xing') + 1] === '1' && args.includes('-y'), `args ${JSON.stringify(args)}`);
    assert(path.basename(args[args.length - 1]) === 'out.mp3' && args[args.length - 1].startsWith(TMP), `salida a archivo temporal: ${args[args.length - 1]}`);
    assert(out.equals(fs.readFileSync(infoMp3)), 'devuelve el archivo escrito por ffmpeg');
    const s = mp3scan(out);
    assert(s.xing.length === 1 && s.xing[0].frames === s.frames, 'con Info y frames correctos');
    eq(leftovers(), [], 'temporal borrado');
  });
  await check('(c) transcodeMp3Bitrate fallback: sin ffmpeg (ENOENT), ffmpeg con error o sin archivo de salida → buffer ORIGINAL intacto y sin temporales', async () => {
    for (const [label, bin] of [['ENOENT', path.join(fakeDir, 'no-existe-ffmpeg')], ['exit 1', fakeFail], ['sin salida', fakeNoOut]]) {
      process.env.FFMPEG_BIN = bin;
      const out = await TC.transcodeMp3Bitrate(original, 64);
      assert(out === original, `${label}: debe devolver el mismo buffer`);
      eq(leftovers(), [], `${label}: temporal borrado`);
    }
    delete process.env.FFMPEG_BIN;
  });

  // ════ (d) Portada ════
  const src = slideRaster(2000, 1125);
  await check(`(d) portada: raster 2000×1125 → ${PNG.COVER_MAX_WIDTH} px (≥ 1600 ≥ ${DISPLAY_PX} px físicos a DPR 2), nitidez a su ancho no peor que la fuente; el tope viejo (640) sí era peor`, async () => {
    assert(PNG.COVER_MAX_WIDTH >= 1600, `COVER_MAX_WIDTH ${PNG.COVER_MAX_WIDTH}`);
    const r = PNG.downscaleCoverPng(src);
    eq([r.width, r.height, r.downscaled], [1600, 900, true], 'dimensiones');
    assert(r.width >= DISPLAY_PX, `la portada (${r.width} px) no cubre los ${DISPLAY_PX} px físicos de la columna a DPR 2: el navegador la ampliaría`);
    const W = r.width;
    const sSrc = sharpnessAt(src, W), sNew = sharpnessAt(r.png, W), sOld = sharpnessAt(PNG.downscaleCoverPng(src, 640).png, W);
    console.log(`   nitidez (var. laplaciano a ${W} px): fuente ${sSrc.toFixed(1)} · portada ${sNew.toFixed(1)} · tope viejo 640 ${sOld.toFixed(1)}; bytes fuente ${src.length} · portada ${r.png.length}`);
    assert(sNew >= 0.99 * sSrc, `portada más borrosa que la fuente (${sNew} < ${sSrc})`);
    assert(sOld < 0.5 * sSrc, `control: 640 px debía ser claramente más borrosa (${sOld} vs ${sSrc})`);
    // Sin pérdida: el filtro adaptativo decodifica a los mismos píxeles que el filtro de caja.
    const dec = PNG.decodePng(r.png);
    const plain = PNG.decodePng(MEDIA.encodePng(dec.width, dec.height, dec.channels, dec.pixels));
    assert(dec.pixels.equals(plain.pixels), 'PNG filtrada sin pérdida');
    eq(PNG.downscaleCoverPng(r.png).reason, 'already_small', 'una portada de 1600 px no se toca');
  });
  const realDir = process.env.UX_COVER_RASTER_DIR;
  if (realDir && fs.existsSync(realDir)) {
    await check('(d) rasters reales (UX_COVER_RASTER_DIR): ≥ 1600 px y nitidez no peor que la fuente', async () => {
      for (const f of fs.readdirSync(realDir).filter((x) => /^p150_.*\.png$/.test(x)).sort()) {
        const b = fs.readFileSync(path.join(realDir, f));
        const r = PNG.downscaleCoverPng(b);
        const o = PNG.downscaleCoverPng(b, 640);
        const [s0, s1, s2] = [sharpnessAt(b, r.width), sharpnessAt(r.png, r.width), sharpnessAt(o.png, r.width)];
        const d0 = sharpnessAt(b, DISPLAY_PX), d1 = sharpnessAt(r.png, DISPLAY_PX), d2 = sharpnessAt(o.png, DISPLAY_PX);
        console.log(`   ${f}: fuente ${b.length} B · 640 ${o.png.length} B · ${r.width}×${r.height} ${r.png.length} B | nitidez a ${r.width}: fuente ${s0.toFixed(1)} · portada ${s1.toFixed(1)} · 640 ${s2.toFixed(1)} | a ${DISPLAY_PX}: fuente ${d0.toFixed(1)} · portada ${d1.toFixed(1)} · 640 ${d2.toFixed(1)}`);
        assert(r.width >= 1600 && s1 >= 0.99 * s0, `${f}: ${r.width} px, nitidez ${s1} vs ${s0}`);
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
