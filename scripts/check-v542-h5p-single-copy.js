#!/usr/bin/env node
/* eslint-disable */
// Cursia V542 I2 — cada actividad H5P del .mbz v3 se guarda y se presenta UNA sola vez.
//
// Antes (R8, builder ≤ 3.7.0) el .h5p iba en `package` (view.php) Y en `intro` (embed inline del
// capítulo): dos contenidos H5P (pathnamehash distintos) sobre el mismo estado xAPI del contexto; al
// desplegar el segundo, `resetContentUserData` borraba el progreso → modal «Data Reset» en inglés.
// Ahora (3.8.0) el embed inline carga el MISMO archivo que view.php (`mod_h5pactivity/package/0/…`).
//
//   1. matriz de fixtures (+ curso rules 2 con caso ramificado y «Repaso»): toda h5pactivity tiene
//      exactamente UNA entrada mod_h5pactivity (filearea package), su intro embebe
//      `url=@@PLUGINFILE@@/../package/0/<archivo>` con el cargador v2, validateMbzV3 limpio;
//   2. el cargador (CURSIA_IV_INLINE_SCRIPT_PKG, ejecutado sobre un DOM mínimo) resuelve la URL que
//      Moodle reescribe a la del reproductor de view.php (/h5p/embed.php?url=…/package/0/<archivo>);
//      el cargador R8 (modo intro) queda byte a byte igual;
//   3. el validador rechaza una segunda copia (filearea intro) y un intro que no embebe el package;
//   4. byte-identidad: un curso SIN actividades H5P ni quizzes da el .mbz dorado (3.6.0 = 3.10.0; 3.11.0 = #583 QUAL).
// Puro (sin red, sin Moodle). Uso: node scripts/check-v542-h5p-single-copy.js [dist]
'use strict';
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), process.argv[2] || path.join(ROOT, 'dist'));
require('reflect-metadata');
let B, V, H;
try {
  B = require(path.join(distRoot, 'package/dynamic-mbz-builder-v3.js'));
  V = require(path.join(distRoot, 'package/v3/mbz-validator-v3.js'));
  H = require(path.join(distRoot, 'package/h5p/index.js'));
} catch (e) {
  console.error(`❌ No se pudo cargar el módulo compilado (${distRoot}) — ¿npm run build?\n   ${e.message}`);
  process.exit(1);
}
const PF = require('./lib/v21-packaging-fixtures');
const GOLD = require('./lib/h5p2-golden-legacy');

let passed = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { assert(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

async function inspect(mbz) {
  const z = await JSZip.loadAsync(mbz);
  const mb = await z.file('moodle_backup.xml').async('string');
  const filesXml = await z.file('files.xml').async('string');
  const files = [...filesXml.matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g)].map((m) => ({
    id: m[1],
    ctx: /<contextid>(\d+)<\/contextid>/.exec(m[2])[1],
    component: /<component>([^<]*)<\/component>/.exec(m[2])[1],
    filearea: /<filearea>([^<]*)<\/filearea>/.exec(m[2])[1],
    filename: /<filename>([^<]*)<\/filename>/.exec(m[2])[1],
  }));
  const acts = [];
  for (const b of /<contents>([\s\S]*?)<\/contents>/.exec(mb)[1].match(/<activity>[\s\S]*?<\/activity>/g)) {
    if (/<modulename>(.*?)<\/modulename>/.exec(b)[1] !== 'h5pactivity') continue;
    const dir = /<directory>(.*?)<\/directory>/.exec(b)[1];
    const xml = await z.file(`${dir}/h5pactivity.xml`).async('string');
    const ctx = /contextid="(\d+)"/.exec(xml)[1];
    const idnumber = /<idnumber>(.*?)<\/idnumber>/.exec(await z.file(`${dir}/module.xml`).async('string'))[1];
    const intro = unxml(/<intro>([\s\S]*?)<\/intro>/.exec(xml)[1]);
    const refs = [...(await z.file(`${dir}/inforef.xml`).async('string')).matchAll(/<file>\s*<id>(\d+)<\/id>/g)].map((m) => m[1]);
    acts.push({ dir, ctx, idnumber, intro, refs, files: files.filter((f) => f.ctx === ctx && f.component === 'mod_h5pactivity' && f.filename !== '.') });
  }
  return { z, acts, filesXml };
}

/** Ejecuta el cargador sobre un DOM mínimo: devuelve el `src` que asigna a cada iframe. */
function runLoader(script, dataSrcs, pathname = '/course/view.php') {
  const iframes = dataSrcs.map((s) => {
    const attrs = { 'data-cursia-src': s };
    return { attrs, getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = v; } };
  });
  const blocks = iframes.map((f) => {
    const attrs = {};
    return { attrs, style: {}, parentNode: { removeChild() {}, querySelector: () => null }, getAttribute: (k) => attrs[k] || null, setAttribute: (k, v) => { attrs[k] = v; }, querySelector: () => f };
  });
  const w = { location: { pathname }, postMessage() {}, addEventListener() {}, h5pResizerInitialized: true };
  const d = { querySelectorAll: () => blocks, getElementsByTagName: () => [] };
  vm.runInNewContext(script, { window: w, document: d });
  return iframes.map((f) => f.attrs.src || null);
}

const BS_CFG = {
  id: 'h5p-rules2-bs-repaso', engine: 'h5p', finalExam: true, activityTypeRules: 2, reviewCards: true,
  chapterObjectives: ['Decidir la solución adecuada para el reclamo', 'Identificar partes', 'Organice las etapas del despacho', 'Decidir el canal de respuesta'],
};

(async () => {
  const built = {};
  for (const cfg of [...GOLD.MBZ_CONFIGS, BS_CFG]) {
    try {
      const r = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, cfg));
      built[cfg.id] = { r, i: await inspect(r.mbz) };
    } catch (e) {
      built[cfg.id] = { error: e.message };
    }
  }

  await check('builder 3.13.0 (3.8.0 = una sola copia; 3.9.0 = revisión del quiz; 3.10.0 = retroalimentación global; 3.11.0 = #583 QUAL; 3.12.0 = UX r18; 3.13.0 = r19 W bienvenida)', () => eq(B.DYNAMIC_MBZ_BUILDER_VERSION_V3, '3.13.0', 'versión'));

  await check('matriz + rules 2: toda h5pactivity tiene UNA sola copia del .h5p (filearea package) y su inforef apunta solo a ella', () => {
    let n = 0;
    const libs = new Set();
    for (const [id, b] of Object.entries(built)) {
      assert(!b.error, `${id}: ${b.error}`);
      for (const a of b.i.acts) {
        n++;
        eq(a.files.map((f) => f.filearea), ['package'], `${id} ${a.idnumber}: fileareas`);
        eq(a.refs, [a.files[0].id], `${id} ${a.idnumber}: inforef`);
      }
      for (const p of b.r.summary.h5pPackages || []) libs.add(p.mainLibrary);
    }
    assert(n >= 10, `se revisaron ${n} h5pactivity`);
    console.log(`   ${n} h5pactivity; librerías: ${[...libs].sort().join(', ')}`);
  });

  await check('rules 2: el curso trae caso ramificado y «Repaso» (el patrón del curso #542)', () => {
    const libs = (built[BS_CFG.id].r.summary.h5pPackages || []).map((p) => p.mainLibrary);
    assert(libs.includes('H5P.BranchingScenario') && libs.includes('H5P.Dialogcards') && libs.includes('H5P.InteractiveVideo'), JSON.stringify(libs));
  });

  await check('el intro de cada h5pactivity embebe el .h5p de package (url=@@PLUGINFILE@@/../package/0/<archivo>) con el cargador v2, UNA vez', () => {
    for (const [id, b] of Object.entries(built)) {
      for (const a of b.i.acts) {
        const name = a.files[0].filename;
        const srcs = [...a.intro.matchAll(/data-cursia-src="([^"]+)"/g)].map((m) => m[1]);
        eq(srcs, [`@@PLUGINFILE@@/../../../../h5p/embed.php?url=@@PLUGINFILE@@/../package/0/${name}&amp;component=mod_h5pactivity`], `${id} ${a.idnumber}: iframe`);
        assert(a.intro.includes(`<script>${H.CURSIA_IV_INLINE_SCRIPT_PKG}</script>`), `${id} ${a.idnumber}: cargador v2`);
        assert(!a.intro.includes(`<script>${H.CURSIA_IV_INLINE_SCRIPT}</script>`), `${id} ${a.idnumber}: sin el cargador R8`);
      }
    }
  });

  await check('validateMbzV3: la matriz + rules 2 sin hallazgos', async () => {
    for (const [id, b] of Object.entries(built)) {
      const v = await V.validateMbzV3(b.r.mbz, b.r.expectations);
      assert(v.ok, `${id}: ${JSON.stringify(v.issues.slice(0, 4))}`);
    }
  });

  await check('cargador v2: la URL que Moodle reescribe del intro se resuelve a la MISMA de view.php (/h5p/embed.php?url=…/package/0/<archivo>)', () => {
    const W = 'http://moodle.test/sub';
    const pf = `${W}/pluginfile.php/4772/mod_h5pactivity/intro`;
    const dataSrc = unxml(H.h5pInlineEmbedSrc('cursia-activity-x.h5p', 'package')).replace(/@@PLUGINFILE@@/g, pf);
    const [src] = runLoader(H.CURSIA_IV_INLINE_SCRIPT_PKG, [dataSrc]);
    const u = new URL(src);
    eq(u.origin + u.pathname, `${W}/h5p/embed.php`, 'embed.php (wwwroot en subcarpeta)');
    eq(u.searchParams.get('url'), `${W}/pluginfile.php/4772/mod_h5pactivity/package/0/cursia-activity-x.h5p`, 'url = make_pluginfile_url(ctx, mod_h5pactivity, package, 0, /, archivo) de view.php');
    eq(u.searchParams.get('component'), 'mod_h5pactivity', 'tracking');
    // Moodle 4.5 entrega el parámetro `url` URL-codificado (restauración real, curso 1278 del Moodle local).
    const enc = `${W}/pluginfile.php/4772/mod_h5pactivity/intro/../../../../h5p/embed.php?url=${encodeURIComponent(`${pf}/../package/0/cursia-activity-x.h5p`)}&component=mod_h5pactivity`;
    assert(/%2Fintro%2F\.\.%2Fpackage%2F0%2F/.test(enc), 'forma codificada');
    const ue = new URL(runLoader(H.CURSIA_IV_INLINE_SCRIPT_PKG, [enc])[0]);
    eq([ue.origin + ue.pathname, ue.searchParams.get('url')], [`${W}/h5p/embed.php`, `${W}/pluginfile.php/4772/mod_h5pactivity/package/0/cursia-activity-x.h5p`], 'url codificada');
    // Una ruta que solo PARECE (otro archivo llamado «intro…») no se toca.
    const other = `${W}/h5p/embed.php?url=${encodeURIComponent(`${W}/pluginfile.php/1/mod_h5pactivity/intro/x.h5p`)}`;
    eq(runLoader(H.CURSIA_IV_INLINE_SCRIPT_PKG, [other])[0], other, 'sin package/0 no cambia');
    // Idempotente: un iframe con src ya asignado no se toca.
    eq(runLoader(H.CURSIA_IV_INLINE_SCRIPT_PKG, [dataSrc])[0], src, 'determinístico');
    // En view.php de la actividad el bloque inline se elimina (Moodle ya muestra su reproductor).
    eq(runLoader(H.CURSIA_IV_INLINE_SCRIPT_PKG, [dataSrc], '/sub/mod/h5pactivity/view.php')[0], null, 'view.php: sin segundo reproductor');
    assert(!/[<>&]/.test(H.CURSIA_IV_INLINE_SCRIPT_PKG), 'el cargador no lleva <, > ni &');
  });

  await check('cargador R8 (modo intro, R8/v1-v2 y checks de video): sin cambios — misma URL que antes', () => {
    const pf = 'http://m/pluginfile.php/5/mod_h5pactivity/intro';
    const dataSrc = unxml(H.h5pInlineEmbedSrc('cursia-video-ch1.h5p')).replace(/@@PLUGINFILE@@/g, pf);
    eq(runLoader(H.CURSIA_IV_INLINE_SCRIPT, [dataSrc])[0], dataSrc, 'src = data-cursia-src');
    assert(H.CURSIA_IV_INLINE_SCRIPT.includes('{v:1}') && H.CURSIA_IV_INLINE_SCRIPT_PKG.includes('{v:2}'), 'versiones del cargador');
    const html = H.videoInlineIntroHtml({ packageFilename: 'cursia-video-ch1.h5p', title: 'T', activityMid: 3, youtubeId: 'IdwOipZAeqY' });
    assert(html.includes('url=@@PLUGINFILE@@/cursia-video-ch1.h5p&amp;') && html.includes(H.CURSIA_IV_INLINE_SCRIPT), 'videoInlineIntroHtml sin embed → receta R8');
  });

  await check('validador: una segunda copia del .h5p (filearea intro) → H5P_FILES «más de una copia»; un intro que embebe la copia intro → H5P_FILES', async () => {
    const b = built['h5p-final-light'];
    const a = b.i.acts[0];
    const f = a.files[0];
    const block = new RegExp(`<file id="${f.id}">[\\s\\S]*?<\\/file>`).exec(b.i.filesXml)[0];
    const copy = block.replace(`<file id="${f.id}">`, '<file id="99999">').replace('<filearea>package</filearea>', '<filearea>intro</filearea>');
    const z1 = await JSZip.loadAsync(b.r.mbz);
    z1.file('files.xml', b.i.filesXml.replace(block, `${block}\n  ${copy}`));
    const v1 = await V.validateMbzV3(await z1.generateAsync({ type: 'nodebuffer' }), b.r.expectations);
    const h1 = v1.issues.filter((i) => i.code === 'H5P_FILES');
    assert(h1.length === 1 && /más de una copia/.test(h1[0].message) && h1[0].where === a.idnumber, JSON.stringify(v1.issues.slice(0, 4)));
    const z2 = await JSZip.loadAsync(b.r.mbz);
    const xml = await z2.file(`${a.dir}/h5pactivity.xml`).async('string');
    z2.file(`${a.dir}/h5pactivity.xml`, xml.replace('url=@@PLUGINFILE@@/../package/0/', 'url=@@PLUGINFILE@@/'));
    const v2 = await V.validateMbzV3(await z2.generateAsync({ type: 'nodebuffer' }), b.r.expectations);
    assert(v2.issues.some((i) => i.code === 'H5P_FILES' && /no embebe el \.h5p del filearea package/.test(i.message)), JSON.stringify(v2.issues.slice(0, 4)));
    // Fix round 1 (M7): un medio del intro (imagen, otro blob) NO es «otra copia del .h5p».
    const other = /<file id="\d+">[\s\S]*?<\/file>/.exec(b.i.filesXml.replace(block, ''))[0];
    const otherHash = /<contenthash>(\w+)<\/contenthash>/.exec(other)[1];
    const img = block.replace(`<file id="${f.id}">`, '<file id="99998">').replace('<filearea>package</filearea>', '<filearea>intro</filearea>')
      .replace(/<filename>[^<]+<\/filename>/, '<filename>imagen.png</filename>').replace(/<contenthash>\w+<\/contenthash>/, `<contenthash>${otherHash}</contenthash>`);
    const z3 = await JSZip.loadAsync(b.r.mbz);
    z3.file('files.xml', b.i.filesXml.replace(block, `${block}\n  ${img}`));
    const v3 = await V.validateMbzV3(await z3.generateAsync({ type: 'nodebuffer' }), b.r.expectations);
    assert(!v3.issues.some((i) => i.code === 'H5P_FILES'), `imagen del intro: ${JSON.stringify(v3.issues.slice(0, 4))}`);
  });

  // Curso sin H5P (SCORM, sin videos) y sin quizzes: dorado = staging b959a89 (builder 3.6.0).
  await check('byte-identidad: un curso SIN actividades H5P ni quizzes da el .mbz dorado (3.6.0 = 3.10.0; 3.11.0 = #583 QUAL; 3.12.0 = UX r18; 3.13.0 = r19 W)', async () => {
    const o = { engine: 'scorm', finalExam: false, courseId: 646, modules: [{ examEnabled: false, chapters: [{ video: false, activity: true }, { video: false, activity: false }] }] };
    const r = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, o));
    // #583 QUAL (builder 3.11.0): reviewmaxmarks 69904 → 272, frase del cierre, tarjeta del Libro Guía como <intro> del recurso (sin label libro_card; ids renumerados) y runtime VC 4 — diff semántico en scratchpad/r18/qual/golddiff/sem.js (antes d4e6bc68…: staging 3.6.0 = 3.10.0 para este curso).
    // UX r18 (builder 3.12.0): sección 0 hero primero / foro al final, sin kicker, preload="metadata" + title/aria-label (fix 1), Info en audiolibro.mp3 y portadas a 1600 px — diff semántico en scratchpad/r18/uximpl-golddiff4.js (antes 80e8b108…, 3.11.0).
    // r19 W (builder 3.12.0 → 3.13.0): SOLO cambia el label cv3:shell:welcome (hero con superficie según heroTreatment, «Curso · N módulos · M capítulos», entrada ≤ 40 palabras y cuerpo en párrafos ≤ 70) — diff por entrada del zip en scratchpad/r19/w-logs/golddiff (hook.js + diff.js) (antes a169af34…, 3.12.0).
    eq(sha(r.mbz), 'd1110959eac9421203c98edd900af2ab60cc520c98830c16d27b079a289931c2', 'sha256');
  });

  console.log(`\n${failures ? 'HAY FALLOS' : 'Todos los checks de V542 I2 (H5P de una sola copia) pasaron'} (${passed} ✅, ${failures} ❌).`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
