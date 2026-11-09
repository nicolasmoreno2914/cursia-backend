// r107 B0 — corpus de prueba del Taller de cursos. Tres fuentes, un manifiesto:
//   real       muestra representativa por FAMILIA de formato del censo (survey-corpus.js): los paquetes se usan donde están
//              (contenido real de clientes: nunca se copian al repo ni se suben); el manifiesto guarda ruta + sha1.
//   synthetic  cursos v3 sanos armados con el MISMO motor de la simulación comercial (scripts/lib/commercial-simulation.js):
//              deterministas, sin red ni IA, USD 0.
//   damaged    copias de un sano (v3 sintético y V1 real) con UNA falla sembrada cada una y la falla esperada declarada
//              (check del diagnóstico técnico + actividad): B3 tiene que encontrar exactamente esa.
// Requiere dist/ (npm run build).
//
// Usage: node scripts/r107/build-corpus.js --survey <survey.json> --out <dir> [--dist dist]
'use strict';
require('reflect-metadata');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// ── Familias de formato (mismas reglas que usará el adaptador de B2) ─────────────────────────────────────────────────
function familyOf(r) {
  if (r.error) return 'unreadable';
  if (r.moodleReexport) return 'moodle-reexport';
  const m = r.modules || {};
  if (m.h5pactivity || m.book) return 'v2-dynamic';
  if (m.scorm && m.label && m.quiz) return m.hvp ? 'v1-legacy-hvp' : 'v1-legacy';
  return 'prototype';
}

function pickSample(recs, perFamily = 3) {
  const fam = {};
  for (const r of recs.filter((x) => !x.duplicateOf)) (fam[familyOf(r)] ||= []).push(r);
  const out = [];
  for (const [f, list] of Object.entries(fam)) {
    list.sort((a, b) => a.size - b.size);
    const idx = [...new Set([0, Math.floor((list.length - 1) / 2), list.length - 1])].slice(0, perFamily);
    for (const i of idx) out.push({ family: f, rec: list[i] });
  }
  return { sample: out, familyCounts: Object.fromEntries(Object.entries(fam).map(([k, v]) => [k, v.length])) };
}

// ── Edición de un .mbz (solo para sembrar fallas; el Taller real usa el motor de parches de B4) ─────────────────────────
async function loadZip(buf) {
  return JSZip.loadAsync(buf);
}
async function text(zip, name) {
  return zip.file(name).async('string');
}
function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
async function filesXmlEntries(zip) {
  const xml = await text(zip, 'files.xml');
  const out = [];
  for (const m of xml.matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g)) {
    const g = (t) => (m[2].match(new RegExp('<' + t + '>([^<]*)</' + t + '>')) || [])[1] ?? null;
    out.push({ id: m[1], contenthash: g('contenthash'), component: g('component'), filearea: g('filearea'), filename: g('filename'), filesize: Number(g('filesize') || 0), contextid: g('contextid') });
  }
  return out;
}
const blobPath = (h) => `files/${h.slice(0, 2)}/${h}`;
/** Reemplaza el contenido de un blob y actualiza TODAS las entradas de files.xml que lo usan (hash + tamaño). */
async function replaceBlob(zip, oldHash, newBuf) {
  const nh = sha1(newBuf);
  zip.remove(blobPath(oldHash));
  zip.file(blobPath(nh), newBuf);
  let xml = await text(zip, 'files.xml');
  xml = xml.replace(/<file id="\d+">[\s\S]*?<\/file>/g, (blk) => (blk.includes(`<contenthash>${oldHash}</contenthash>`)
    ? blk.replace(`<contenthash>${oldHash}</contenthash>`, `<contenthash>${nh}</contenthash>`).replace(/<filesize>\d+<\/filesize>/, `<filesize>${newBuf.length}</filesize>`)
    : blk));
  zip.file('files.xml', xml);
  return nh;
}
function activityDirs(zip) {
  const dirs = new Set();
  zip.forEach((p) => { const m = p.match(/^activities\/([a-z0-9]+_\d+)\//); if (m) dirs.add(m[1]); });
  return [...dirs].sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
}
async function moduleIdOf(zip, dir) {
  const x = await text(zip, `activities/${dir}/module.xml`);
  return (x.match(/<module id="(\d+)"/) || [])[1];
}
/** Primera label con HTML no vacío: dir + xml. */
async function firstLabel(zip) {
  for (const d of activityDirs(zip).filter((x) => x.startsWith('label_'))) {
    const xml = await text(zip, `activities/${d}/label.xml`);
    if (/<intro>[^<]{20,}<\/intro>/.test(xml)) return { dir: d, xml };
  }
  return null;
}
async function injectIntoLabel(zip, html) {
  const l = await firstLabel(zip);
  zip.file(`activities/${l.dir}/label.xml`, l.xml.replace(/<intro>/, '<intro>' + xmlEsc(html)));
  return l.dir;
}

// Cada mutación: (zip) → { check, target, note }  — la falla esperada.
const MUTATIONS = {
  async 'blob-missing'(zip) {
    const f = (await filesXmlEntries(zip)).find((e) => e.filename !== '.' && e.filesize > 0 && e.component !== 'user');
    zip.remove(blobPath(f.contenthash));
    return { check: 'T02', target: f.component + '/' + f.filearea + '/' + f.filename, note: 'blob borrado, la entrada de files.xml sigue' };
  },
  async 'blob-altered'(zip) {
    const f = (await filesXmlEntries(zip)).find((e) => e.filename !== '.' && e.filesize > 0 && e.component !== 'user');
    const b = await zip.file(blobPath(f.contenthash)).async('nodebuffer');
    b[0] = b[0] ^ 0xff;
    zip.file(blobPath(f.contenthash), b);
    return { check: 'T02', target: f.component + '/' + f.filearea + '/' + f.filename, note: 'el SHA1 del blob ya no coincide con su nombre' };
  },
  async 'orphan-token'(zip) {
    const dir = await injectIntoLabel(zip, '<p><a href="$@SCORMVIEWBYID*987654@$">Ir al juego</a></p>');
    return { check: 'T04', target: dir, note: 'token a un moduleid inexistente' };
  },
  async 'wrong-type-token'(zip) {
    const labels = activityDirs(zip).filter((x) => x.startsWith('label_'));
    const mid = await moduleIdOf(zip, labels[labels.length - 1]);
    const dir = await injectIntoLabel(zip, `<p><a href="$@QUIZVIEWBYID*${mid}@$">Ir al examen</a></p>`);
    return { check: 'T04', target: dir, note: `token QUIZ apuntando a una label (${mid})` };
  },
  async 'duplicate-moduleid'(zip) {
    const dirs = activityDirs(zip);
    const a = await moduleIdOf(zip, dirs[0]);
    const victim = dirs[dirs.length - 1];
    const p = `activities/${victim}/module.xml`;
    zip.file(p, (await text(zip, p)).replace(/<module id="\d+"/, `<module id="${a}"`));
    return { check: 'T03', target: victim, note: `moduleid ${a} repetido` };
  },
  async 'listed-missing-folder'(zip) {
    const dirs = activityDirs(zip).filter((x) => x.startsWith('label_'));
    const victim = dirs[Math.floor(dirs.length / 2)];
    zip.forEach((p) => { if (p.startsWith(`activities/${victim}/`)) zip.remove(p); });
    return { check: 'T01', target: victim, note: 'listada en moodle_backup.xml, carpeta ausente' };
  },
  async 'pending-placeholder'(zip) {
    const dir = await injectIntoLabel(zip, '<p>⚠️ Pendiente: este contenido no se generó.</p>');
    return { check: 'T05', target: dir, note: 'marcador «⚠️ Pendiente» visible para el estudiante' };
  },
  async 'empty-label'(zip) {
    const l = await firstLabel(zip);
    zip.file(`activities/${l.dir}/label.xml`, l.xml.replace(/<intro>[\s\S]*?<\/intro>/, '<intro></intro>'));
    return { check: 'T05', target: l.dir, note: 'label vacía' };
  },
  // V1: Libro Guía HTML cortado (sin </html>) con su SHA1 recalculado → solo T07, no T02.
  async 'libro-html-truncated'(zip) {
    const f = (await filesXmlEntries(zip)).find((e) => e.component === 'mod_resource' && /\.html?$/i.test(e.filename || ''));
    if (!f) return null;
    const b = await zip.file(blobPath(f.contenthash)).async('nodebuffer');
    await replaceBlob(zip, f.contenthash, b.subarray(0, Math.floor(b.length / 3)));
    return { check: 'T07', target: 'mod_resource/' + f.filename, note: 'Libro Guía cortado a un tercio, sin </html>' };
  },
  // v3: Libro Guía PDF cortado (sin %%EOF) con su SHA1 recalculado.
  async 'libro-pdf-truncated'(zip) {
    const f = (await filesXmlEntries(zip)).find((e) => /\.pdf$/i.test(e.filename || '') && /libro/i.test(e.filename || ''));
    if (!f) return null;
    const b = await zip.file(blobPath(f.contenthash)).async('nodebuffer');
    await replaceBlob(zip, f.contenthash, b.subarray(0, Math.floor(b.length / 2)));
    return { check: 'T07', target: f.component + '/' + f.filename, note: 'PDF del Libro Guía cortado, sin %%EOF' };
  },
  // V1: el SCORM del capítulo con el placeholder de juego no generado dentro de su contenido extraído.
  async 'scorm-pending'(zip) {
    const f = (await filesXmlEntries(zip)).find((e) => e.component === 'mod_scorm' && e.filearea === 'content' && /index\.html?$/i.test(e.filename || ''));
    if (!f) return null;
    const html = (await zip.file(blobPath(f.contenthash)).async('string')).replace(/<body([^>]*)>/i, '<body$1><div>⚠️ Pendiente: juego no generado</div>');
    await replaceBlob(zip, f.contenthash, Buffer.from(html, 'utf8'));
    return { check: 'T06', target: 'mod_scorm/' + f.filename, note: 'juego SCORM con «⚠️ Pendiente»' };
  },
  // Examen con una pregunta de opción múltiple sin respuesta correcta (todas las fracciones en 0).
  async 'exam-no-correct'(zip) {
    if (!zip.file('questions.xml')) return null;
    let xml = await text(zip, 'questions.xml');
    let done = null;
    xml = xml.replace(/<question id="(\d+)">([\s\S]*?)<\/question>/, (blk, id, body) => {
      if (!/<qtype>multichoice<\/qtype>/.test(body)) return blk;
      done = id;
      return blk.replace(/<fraction>[^<]*<\/fraction>/g, '<fraction>0.0000000</fraction>');
    });
    if (!done) {
      // la primera no era multichoice: buscar la primera que sí
      const all = [...xml.matchAll(/<question id="(\d+)">([\s\S]*?)<\/question>/g)].find((m) => /<qtype>multichoice<\/qtype>/.test(m[2]));
      if (!all) return null;
      done = all[1];
      xml = xml.replace(all[0], all[0].replace(/<fraction>[^<]*<\/fraction>/g, '<fraction>0.0000000</fraction>'));
    }
    zip.file('questions.xml', xml);
    return { check: 'T10', target: 'question/' + done, note: 'pregunta de opción múltiple sin ninguna respuesta correcta' };
  },
};

const COMMON = ['blob-missing', 'blob-altered', 'orphan-token', 'wrong-type-token', 'duplicate-moduleid', 'listed-missing-folder', 'pending-placeholder', 'empty-label', 'exam-no-correct'];
const PER_FORMAT = { v3: ['libro-pdf-truncated'], v1: ['libro-html-truncated', 'scorm-pending'] };

async function writeDamaged(base, baseId, format, outDir) {
  const res = [];
  for (const name of [...COMMON, ...PER_FORMAT[format]]) {
    const zip = await loadZip(base);
    const expected = await MUTATIONS[name](zip);
    if (!expected) { res.push({ id: `${baseId}~${name}`, skipped: 'la base no tiene el elemento a dañar' }); continue; }
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const file = path.join(outDir, 'damaged', `${baseId}~${name}.mbz`);
    fs.writeFileSync(file, buf);
    res.push({ id: `${baseId}~${name}`, source: 'damaged', format, base: baseId, mutation: name, path: file, sha1: sha1(buf), size: buf.length, expectedDefects: [expected] });
  }
  return res;
}

async function main() {
  const surveyPath = arg('--survey');
  const outDir = path.resolve(arg('--out'));
  const distRoot = path.resolve(arg('--dist', 'dist'));
  fs.mkdirSync(path.join(outDir, 'synthetic'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'damaged'), { recursive: true });
  const manifest = { version: 1, builtAt: new Date().toISOString(), fixtures: [] };

  // 1. Real: muestra por familia.
  const recs = JSON.parse(fs.readFileSync(surveyPath, 'utf8'));
  const { sample, familyCounts } = pickSample(recs);
  manifest.familyCounts = familyCounts;
  for (const { family, rec } of sample) {
    manifest.fixtures.push({ id: 'real:' + family + ':' + rec.sha1.slice(0, 8), source: 'real', family, path: rec.file, sha1: rec.sha1, size: rec.size, title: rec.title, expectedDefects: null });
  }

  // 2. Sintéticos v3 sanos.
  const S = require(path.join(__dirname, '..', 'lib', 'commercial-simulation'));
  const COURSES = require(path.join(__dirname, '..', 'fixtures', 'commercial-simulation', 'courses.json')).courses;
  const synth = {};
  for (const id of ['A-S', 'ofimatica', '1x1-sin-examenes']) {
    const sim = await S.simulateCourse(distRoot, COURSES.find((c) => c.id === id));
    if (!sim.validation.ok || sim.validation.issues.length) throw new Error(`sintético ${id} no sale limpio del validador: ${JSON.stringify(sim.validation.issues[0])}`);
    const file = path.join(outDir, 'synthetic', `v3-${id}.mbz`);
    fs.writeFileSync(file, sim.built.mbz);
    fs.writeFileSync(file.replace(/\.mbz$/, '.expectations.json'), JSON.stringify(sim.built.expectations));
    synth[id] = sim.built.mbz;
    manifest.fixtures.push({ id: 'synthetic:v3-' + id, source: 'synthetic', family: 'v2-dynamic', builderVersion: sim.builderVersion, path: file, sha1: sha1(sim.built.mbz), size: sim.built.mbz.length, expectedDefects: [] });
  }

  // 3. Dañados: desde el v3 sintético A-S y desde el V1 real más chico con SCORM + Libro Guía HTML.
  manifest.fixtures.push(...await writeDamaged(synth['A-S'], 'v3-A-S', 'v3', outDir));
  const v1 = recs.filter((r) => !r.duplicateOf && familyOf(r) === 'v1-legacy-hvp' && r.modules.resource).sort((a, b) => a.size - b.size)[0];
  if (v1) {
    const buf = fs.readFileSync(v1.file);
    manifest.fixtures.push(...await writeDamaged(buf, 'v1-' + v1.sha1.slice(0, 8), 'v1', outDir));
    manifest.v1DamageBase = { path: v1.file, sha1: v1.sha1, title: v1.title };
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const by = (s) => manifest.fixtures.filter((f) => f.source === s && !f.skipped).length;
  console.log(`real=${by('real')} synthetic=${by('synthetic')} damaged=${by('damaged')} skipped=${manifest.fixtures.filter((f) => f.skipped).map((f) => f.id).join(',') || '-'}`);
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
module.exports = { familyOf, pickSample, MUTATIONS };
