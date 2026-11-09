#!/usr/bin/env node
/* eslint-disable */
// r107 B2 — inventario del Taller de cursos (modelo único WorkshopCourse + adaptadores por familia), contra el código
// COMPILADO (dist/). Sin red, sin IA, sin base, USD 0. Nada se escribe a disco (espías sobre fs).
//
//   V1 todos los fixtures producen inventario SIN excepción (también la forma persistida), sin escribir a disco
//   V2 sintéticos v3: el inventario coincide EXACTO con lo que sabe el builder (expectations.facts de la simulación):
//      capítulos (número, título, módulo, uuid), videos, juegos, repasos, actividades de aplicación, exámenes (ranuras y
//      banco por módulo + final), Libro Guía, módulos; 0 unknown, 0 issues, todos los tokens ok
//   V3 reales: cada capítulo tiene los roles esperados de su familia; % de roles / clases `unknown` por familia
//      (objetivo 0 en V1 y v2: falla si no); en re-export y prototipo se informa
//   V4 tokens: `orphan-token` / `wrong-type-token` aparecen como huérfano / tipo incorrecto en la actividad sembrada;
//      en los sanos 0 huérfanos / mal tipados / rotos; referencias inversas coherentes con los tokens
//   V5 determinismo: dos corridas sobre el mismo paquete (abierto de nuevo) → el mismo JSON byte a byte
//   V6 fallas estructurales sembradas quedan como `issues` del inventario (carpeta listada ausente, moduleid distinto)
//   V7 fuente recuperada (pura): enganche por uuid / posición / módulo / clave del final / snapshot; la más reciente
//      por clave; «no hay» y «error» distinguibles; forma persistida sin HTML
//   V8 N1: la descarga con tope reserva UN buffer por content-length / sizeHint (sin Buffer.concat) y da los mismos bytes
//   V9 N2: el plazo del cuerpo no lo corta el timeout de los encabezados; vencido → StorageDownloadTimeoutError claro
//   V10 (fix round 1) espacio de ids de cada token, sobre un paquete mínimo armado acá: COURSEVIEWBYID contra el
//      curso del backup (otro curso → `external`, con su `#module-N` resuelto aparte), HVPEMBEDBYID contra el moduleid del
//      hvp (huérfano / roto), id de instancia (FORUMVIEWBYF), BOOKVIEWBYIDCH, *INDEX, PLUGINFILEBYCONTEXT del curso
//
//   --census <survey.json> (local, fix round 1): TODO el censo real (survey-corpus.js): 0 excepciones salvo los rechazos
//      tipados del lector; unknown 0 en V1 y v2; por familia se imprimen capítulos, paquetes sin capítulos, unknown y los
//      estados de los tokens (y el detalle de los no ok)
//
// Usage:
//   node scripts/r107/check-r107-inventory.js --corpus [manifest.json|dir]   (completo, local: corpus de B0)
//   node scripts/r107/check-r107-inventory.js --ci                            (CI: sintéticos + dañados generados acá)
//   node scripts/r107/check-r107-inventory.js --census <survey.json>          (local: todo el censo real)
//   [--dist dist]
'use strict';
require('reflect-metadata');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const DIST = path.resolve(arg('--dist', path.join(REPO, 'dist')));
const CI = has('--ci');
const CENSUS = has('--census') ? arg('--census', path.join(os.homedir(), 'cursia-test-env/work/r107/survey/survey.json')) : null;
const DEFAULT_CORPUS = path.join(os.homedir(), 'cursia-test-env/work/r107/corpus/manifest.json');
if (!CI && !CENSUS && !has('--corpus')) { console.error('Usage: --corpus [manifest.json|dir] | --ci | --census <survey.json>  [--dist dist]'); process.exit(2); }
let corpusArg = CI || CENSUS ? null : arg('--corpus', DEFAULT_CORPUS);
if (corpusArg && fs.existsSync(corpusArg) && fs.statSync(corpusArg).isDirectory()) corpusArg = path.join(corpusArg, 'manifest.json');

const L = (rel) => { try { return require(path.join(DIST, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿npm run build?): ${e.message}`); process.exit(1); } };
const R = L('modules/course-workshop/mbz-reader.js');
const I = L('modules/course-workshop/identify.js');
const M = L('modules/course-workshop/course-model.js');
const INV = L('modules/course-workshop/inventory.js');
const ART = L('modules/artifacts/artifacts.service.js');
const BC = require(path.join(REPO, 'scripts/r107/build-corpus.js'));

let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 8).join('\n   ')}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };

function spyWrites() {
  const names = ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream', 'mkdtempSync', 'mkdirSync', 'openSync', 'copyFileSync', 'renameSync'];
  const saved = {};
  const calls = [];
  for (const n of names) {
    saved[n] = fs[n];
    fs[n] = function (...a) {
      // openSync de LECTURA (readFileSync del censo) no es una escritura.
      if (!(n === 'openSync' && (a[1] === undefined || a[1] === 'r' || a[1] === 0))) calls.push(`${n}(${String(a[0]).slice(0, 80)})`);
      return saved[n].apply(fs, a);
    };
  }
  const p = fs.promises;
  const savedP = { writeFile: p.writeFile, open: p.open, mkdtemp: p.mkdtemp };
  for (const n of Object.keys(savedP)) p[n] = function (...a) { calls.push(`promises.${n}(${String(a[0]).slice(0, 80)})`); return savedP[n].apply(p, a); };
  return () => { for (const n of names) fs[n] = saved[n]; for (const n of Object.keys(savedP)) p[n] = savedP[n]; return calls; };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async function ciFixtures() {
  // Sintéticos v3 con el MISMO motor de B0 (determinista, sin red) + dañados con las MISMAS mutaciones de B0.
  const S = require(path.join(REPO, 'scripts/lib/commercial-simulation'));
  const COURSES = require(path.join(REPO, 'scripts/fixtures/commercial-simulation/courses.json')).courses;
  const JSZip = require('jszip');
  const out = [];
  let base = null;
  for (const id of ['A-S', 'ofimatica', '1x1-sin-examenes']) {
    const sim = await S.simulateCourse(DIST, COURSES.find((c) => c.id === id));
    out.push({ id: 'synthetic:v3-' + id, source: 'synthetic', family: 'v2-dynamic', filename: `v3-${id}.mbz`, load: () => sim.built.mbz, expectations: sim.built.expectations, summary: sim.built.summary });
    if (id === 'A-S') base = sim.built.mbz;
  }
  for (const name of ['orphan-token', 'wrong-type-token', 'listed-missing-folder', 'duplicate-moduleid']) {
    const zip = await JSZip.loadAsync(base);
    const exp = await BC.MUTATIONS[name](zip);
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    out.push({ id: `v3-A-S~${name}`, source: 'damaged', mutation: name, family: 'v2-dynamic', filename: `v3-A-S~${name}.mbz`, load: () => buf, expectedDefects: [exp] });
  }
  return out;
}
function corpusFixtures(manifestPath) {
  const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const v1Base = man.v1DamageBase ? man.fixtures.find((f) => f.sha1 === man.v1DamageBase.sha1) : null;
  return man.fixtures.filter((f) => !f.skipped).map((f) => {
    let family = f.family;
    if (!family && f.source === 'damaged') family = f.format === 'v3' ? 'v2-dynamic' : (v1Base ? v1Base.family : 'v1-legacy-hvp');
    const expPath = f.source === 'synthetic' ? f.path.replace(/\.mbz$/, '.expectations.json') : null;
    return {
      ...f, family, filename: path.basename(f.path), load: () => fs.readFileSync(f.path),
      expectations: expPath && fs.existsSync(expPath) ? JSON.parse(fs.readFileSync(expPath, 'utf8')) : null,
    };
  });
}

async function inventoryOf(buf, filename) {
  const pkg = await R.openMbz(buf);
  const facts = await I.readPackageFacts(pkg, filename);
  const family = I.familyOf(facts);
  const inv = await INV.buildInventory(pkg, { family, builderLine: I.builderLineOf(facts) });
  return { inv, family };
}

// Paquete mínimo (zip) para V10: label 10 con todos los tokens, hvp 11, foro 12 (instancia 5), book 13 (capítulo 7).
// Solo prueba el espacio de ids de los tokens (con el book la familia es v2-dynamic: los roles no son el punto).
async function tokenFixture() {
  const JSZip = require('jszip');
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const z = new JSZip();
  const acts = [[10, 'label', '🎯 Practicar — Cap 1'], [11, 'hvp', '🎥 Video Interactivo Cap 1 — Uno'], [12, 'forum', '📢 Avisos'], [13, 'book', 'Libro']];
  z.file('moodle_backup.xml', `<?xml version="1.0" encoding="UTF-8"?><moodle_backup><information><name>t.mbz</name><original_course_id>1</original_course_id>`
    + `<original_course_contextid>2</original_course_contextid><original_course_fullname>Tokens</original_course_fullname><contents><activities>`
    + acts.map(([id, mod, t]) => `<activity><moduleid>${id}</moduleid><sectionid>2</sectionid><modulename>${mod}</modulename><title>${t}</title><directory>activities/${mod}_${id}</directory></activity>`).join('')
    + `</activities><sections><section><sectionid>2</sectionid><title>Módulo 1 — Uno</title><directory>sections/section_2</directory></section></sections></contents></information></moodle_backup>`);
  z.file('course/course.xml', '<course id="1" contextid="2"></course>');
  z.file('sections/section_2/section.xml', '<section id="2"><number>2</number><name>Módulo 1 — Uno</name><sequence>10,11,12,13</sequence><visible>1</visible></section>');
  const html = '<a href="$@COURSEVIEWBYID*1@$#module-11">a</a><a href="$@COURSEVIEWBYID*2006@$#module-77">b</a><a href="$@COURSEVIEWBYID*2006@$">c</a>'
    + '<iframe src="$@HVPEMBEDBYID*11@$"></iframe><iframe src="$@HVPEMBEDBYID*4821@$"></iframe><a href="$@FORUMVIEWBYF*5@$">f</a><a href="$@FORUMVIEWBYF*12@$">g</a>'
    + '<a href="$@BOOKVIEWBYIDCH*13*7@$">h</a><a href="$@BOOKVIEWBYIDCH*13*8@$">i</a><a href="$@SCORMINDEX*1@$">j</a><img src="$@PLUGINFILEBYCONTEXT*2@$/x.png">'
    + '<a href="$@QUIZVIEWBYID*11@$">k</a><iframe src="$@HVPEMBEDBYID*11@<intro>quot;"></iframe>';
  const inst = { 10: 1, 11: 2, 12: 5, 13: 3 };
  for (const [id, mod, t] of acts) {
    const extra = mod === 'book' ? '<chapters><chapter id="7"><title>C</title><content>&lt;p&gt;x&lt;/p&gt;</content></chapter></chapters>' : '';
    z.file(`activities/${mod}_${id}/module.xml`, `<module id="${id}"><modulename>${mod}</modulename><sectionid>2</sectionid><sectionnumber>2</sectionnumber><idnumber></idnumber><visible>1</visible></module>`);
    z.file(`activities/${mod}_${id}/${mod}.xml`, `<activity id="${inst[id]}" moduleid="${id}" modulename="${mod}" contextid="${100 + id}"><${mod} id="${inst[id]}"><name>${esc(t)}</name><intro>${id === 10 ? esc(html) : ''}</intro>${extra}</${mod}></activity>`);
  }
  z.file('files.xml', '<files></files>');
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// --census: todo el censo real (local).
async function censusMode(surveyPath) {
  const recs = JSON.parse(fs.readFileSync(surveyPath, 'utf8')).filter((r) => !r.duplicateOf);
  console.log(`  modo censo: ${surveyPath} — ${recs.length} paquetes únicos`);
  const fam = {};
  const rejected = [];
  const errors = [];
  const notOk = [];
  const unspy = spyWrites();
  try {
    for (const r of recs) {
      let pkg;
      try { pkg = await R.openMbz(fs.readFileSync(r.file)); } catch (e) { if (R.isMbzReaderError(e)) rejected.push(`${path.basename(r.file)}: ${e.code}`); else errors.push(`${path.basename(r.file)}: ${e && e.stack}`); continue; }
      try {
        const facts = await I.readPackageFacts(pkg, path.basename(r.file));
        const family = I.familyOf(facts);
        const inv = await INV.buildInventory(pkg, { family, builderLine: I.builderLineOf(facts) });
        M.stableStringify(INV.persistableInventory(inv));
        const f = (fam[family] ||= { packages: 0, chapters: 0, noChapters: 0, activities: 0, unknown: 0, tokens: {} });
        f.packages++; f.chapters += inv.chapters.length; f.activities += inv.activities.length;
        if (!inv.chapters.length) f.noChapters++;
        f.unknown += unknownActs(inv).length;
        for (const a of inv.activities) for (const t of a.tokens) {
          f.tokens[t.status] = (f.tokens[t.status] || 0) + t.count;
          if (!['ok', 'unchecked', 'external'].includes(t.status)) notOk.push(`${family} | ${path.basename(r.file)} | ${a.dir} | ${t.token.slice(0, 40)} → ${t.status}`);
        }
      } catch (e) {
        if (e instanceof I.PackageFactsError) rejected.push(`${path.basename(r.file)}: ${e.code}`); else errors.push(`${path.basename(r.file)}: ${e && e.stack}`);
      }
    }
  } finally {
    const calls = unspy();
    if (calls.length) errors.push(`escribió a disco: ${calls.slice(0, 3).join(', ')}`);
  }
  for (const [k, f] of Object.entries(fam).sort()) console.log(`   ${k.padEnd(16)} paquetes ${f.packages} · capítulos ${f.chapters} · sin capítulos ${f.noChapters} · unknown ${f.unknown}/${f.activities} · tokens ${JSON.stringify(f.tokens)}`);
  console.log(`   rechazos tipados del lector: ${rejected.length}${rejected.length ? ' — ' + rejected.join('; ') : ''}`);
  console.log(`   tokens no ok (huérfanos / mal tipados / rotos): ${notOk.length}`);
  for (const x of notOk) console.log(`      · ${x}`);
  await check('C1 censo: 0 excepciones (salvo los rechazos tipados del lector), 0 escrituras a disco', async () => { if (errors.length) throw new Error(errors.slice(0, 5).join('\n')); });
  await check('C2 censo: 0 roles / clases unknown en V1 y v2', async () => {
    const bad = ['v1-legacy', 'v1-legacy-hvp', 'v2-dynamic'].filter((k) => fam[k] && fam[k].unknown);
    if (bad.length) throw new Error(bad.map((k) => `${k}: ${fam[k].unknown}`).join(', '));
  });
  console.log(`\n${fail ? '❌' : '✅'} check-r107-inventory --census: ${ok} ok, ${fail} fallidos`);
  process.exit(fail ? 1 : 0);
}

const unknownActs = (inv) => inv.activities.filter((a) => a.role === 'unknown' || (a.placement.scope === 'course' && a.kind === 'unknown'));
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '0.0') + '%';

(async () => {
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  // Los fixtures CI se generan ANTES de espiar (el motor de la simulación no es parte del inventario).
  if (CENSUS) return censusMode(CENSUS);
  const fixtures = CI ? await ciFixtures() : corpusFixtures(corpusArg);
  console.log(`  modo ${CI ? 'CI (sintéticos + dañados generados)' : 'completo: ' + corpusArg} — ${fixtures.length} fixtures`);
  const built = new Map(); // id → { inv, family, json }
  const bufs = new Map();
  for (const f of fixtures) bufs.set(f.id, f.load());

  await check(`V1 los ${fixtures.length} fixtures producen inventario sin excepción (completo + persistido), sin escribir a disco`, async () => {
    const unspy = spyWrites();
    const errs = [];
    try {
      for (const f of fixtures) {
        try {
          const { inv, family } = await inventoryOf(bufs.get(f.id), f.filename);
          const json = M.stableStringify(inv);
          const persisted = M.stableStringify(INV.persistableInventory(inv));
          assert(Buffer.byteLength(persisted) < INV.INVENTORY_PERSIST_MAX_BYTES, `${f.id}: persistido ${persisted.length} bytes`);
          built.set(f.id, { inv, family, json });
        } catch (e) { errs.push(`${f.id}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); }
      }
    } finally {
      const calls = unspy();
      assert(!calls.length, `escribió a disco: ${calls.slice(0, 5).join(', ')}`);
    }
    if (errs.length) throw new Error(errs.join('\n'));
    const fam = {};
    for (const [, b] of built) fam[b.family] = (fam[b.family] || 0) + 1;
    console.log(`   familias: ${JSON.stringify(fam)}`);
  });

  await check('V2 sintéticos v3: inventario = lo que sabe el builder (capítulos, videos, juegos, aplicación, exámenes, Libro Guía, módulos)', async () => {
    const synth = fixtures.filter((f) => f.source === 'synthetic');
    assert(synth.length >= (CI ? 3 : 3), `sintéticos: ${synth.length}`);
    for (const f of synth) {
      const b = built.get(f.id);
      assert(b, `${f.id}: sin inventario`);
      assert(f.expectations, `${f.id}: sin expectativas del builder`);
      const inv = b.inv;
      const F = f.expectations.facts;
      const tag = f.id;
      eq(inv.family, 'v2-dynamic', `${tag} familia`);
      eq(inv.course.builder.line, 'v3', `${tag} línea de builder`);
      eq(inv.course.title, F.course.title, `${tag} título`);
      eq(inv.chapters.length, F.counts.chapters, `${tag} capítulos`);
      eq(inv.modules.length, F.counts.modules, `${tag} módulos`);
      for (const ch of F.chapters) {
        const c = inv.chapters.find((x) => x.number === ch.number);
        assert(c, `${tag}: falta el capítulo ${ch.number}`);
        eq([c.title, c.moduleNumber, c.builderUuid], [ch.title, ch.moduleNumber, ch.id], `${tag} cap ${ch.number} título/módulo/uuid`);
        const kinds = c.activities.map((mid) => inv.activities.find((a) => a.moduleId === mid)).map((a) => a.kind);
        eq(c.roles.video.length, ch.videoEnabled ? 1 : 0, `${tag} cap ${ch.number} video`);
        eq(kinds.filter((k) => k === 'practice').length, ch.activityEnabled ? 1 : 0, `${tag} cap ${ch.number} juego`);
        eq(kinds.filter((k) => k === 'review_cards').length, ch.reviewCards ? 1 : 0, `${tag} cap ${ch.number} repaso`);
        const gameMods = c.roles.game.map((mid) => inv.activities.find((a) => a.moduleId === mid)).filter((a) => a.kind === 'practice').map((a) => a.modname);
        if (ch.activityEnabled) eq(gameMods, [ch.activityVariant === 'scorm' ? 'scorm' : 'h5pactivity'], `${tag} cap ${ch.number} motor del juego`);
        eq(c.missingRoles, [], `${tag} cap ${ch.number} roles faltantes`);
      }
      eq(inv.stats.byRole.video, F.counts.videos, `${tag} videos`);
      eq(inv.activities.filter((a) => a.kind === 'practice').length, F.counts.activities, `${tag} actividades prácticas`);
      eq(inv.activities.filter((a) => a.kind === 'review_cards').length, F.counts.reviewCards ?? 0, `${tag} repasos`);
      eq(inv.activities.filter((a) => a.kind === 'application').length, F.counts.applicationActivities ?? 0, `${tag} actividades de aplicación`);
      // Exámenes: ranuras y banco por módulo, y el final.
      const modExams = inv.exams.filter((e) => !e.final);
      eq(modExams.length, F.counts.exams, `${tag} exámenes de módulo`);
      for (const m of F.modules.filter((x) => x.examEnabled)) {
        const e = modExams.find((x) => x.unit === m.number);
        assert(e, `${tag}: falta el examen del módulo ${m.number}`);
        // Sin banco (examen GIFT fijo) el builder no declara examBankSize: el banco son las mismas preguntas.
        eq([e.slots, e.questions], [m.examQuestionCount, m.examBankSize ?? m.examQuestionCount], `${tag} examen módulo ${m.number} (ranuras / banco)`);
      }
      const fin = inv.exams.filter((e) => e.final);
      eq(fin.length, F.finalExam && F.finalExam.enabled ? 1 : 0, `${tag} examen final`);
      if (fin.length) eq([fin[0].slots, fin[0].questions], [F.finalExam.questionCount, F.finalExam.bankSize ?? F.finalExam.questionCount], `${tag} examen final (ranuras / banco)`);
      for (const m of F.modules) {
        const im = inv.modules.find((x) => x.number === m.number);
        assert(im, `${tag}: falta el módulo ${m.number}`);
        eq([im.title, im.builderUuid, im.chapterNumbers], [m.title, m.id, m.chapterNumbers], `${tag} módulo ${m.number} título / uuid / capítulos`);
      }
      // Libro Guía: el resource PDF (v3) + el libro en línea (book) si el builder lo arma.
      const libros = inv.libro.filter((l) => l.format !== 'book');
      eq(libros.map((l) => l.format), ['pdf'], `${tag} Libro Guía (resource PDF)`);
      assert(libros[0].filename && /^libro_guia_/.test(libros[0].filename), `${tag} archivo del Libro Guía: ${libros[0].filename}`);
      eq(inv.audiobook.length, F.audio && F.audio.audiobookSeconds ? 1 : 0, `${tag} audiolibro`);
      eq([inv.stats.unknownChapterRoles, inv.stats.unknownCourseKinds, inv.issues.length], [0, 0, 0], `${tag} unknown / issues`);
      eq([inv.stats.tokens.orphan, inv.stats.tokens.wrong_type, inv.stats.tokens.external, inv.stats.tokens.malformed, inv.stats.tokens.unchecked], [0, 0, 0, 0, 0], `${tag} tokens`);
      if (f.summary) eq(f.summary.builderVersion, f.expectations.builderVersion, `${tag} versión del builder (summary = expectativas)`);
    }
  });

  await check('V3 reales: roles esperados por capítulo y % unknown por familia (objetivo 0 en V1 y v2)', async () => {
    const byFam = {};
    for (const f of fixtures.filter((x) => x.source !== 'synthetic')) {
      const b = built.get(f.id);
      const s = (byFam[b.family] ||= { fixtures: 0, chapters: 0, chActs: 0, chUnknown: 0, courseActs: 0, courseUnknown: 0, missing: [], unknown: [] });
      s.fixtures++;
      s.chapters += b.inv.chapters.length;
      for (const a of b.inv.activities) {
        if (a.placement.scope === 'chapter') { s.chActs++; if (a.role === 'unknown') s.chUnknown++; } else { s.courseActs++; if (a.kind === 'unknown') s.courseUnknown++; }
      }
      for (const c of b.inv.chapters) if (c.missingRoles.length) s.missing.push(`${f.id} cap ${c.number}: falta ${c.missingRoles.join(', ')}`);
      for (const a of unknownActs(b.inv)) s.unknown.push(`${f.id} ${a.dir}: ${a.unknownReason}`);
    }
    const strict = ['v1-legacy', 'v1-legacy-hvp', 'v2-dynamic'];
    const errs = [];
    for (const [fam, s] of Object.entries(byFam).sort()) {
      console.log(`   ${fam.padEnd(16)} fixtures ${s.fixtures} · capítulos ${s.chapters} · unknown en capítulos ${s.chUnknown}/${s.chActs} (${pct(s.chUnknown, s.chActs)}) · unknown fuera de capítulos ${s.courseUnknown}/${s.courseActs} (${pct(s.courseUnknown, s.courseActs)}) · capítulos con roles faltantes ${s.missing.length}`);
      for (const m of s.missing.slice(0, 12)) console.log(`      · ${m}`);
      for (const u of s.unknown.slice(0, 12)) console.log(`      · unknown ${u}`);
      if (strict.includes(fam) && (s.chUnknown || s.courseUnknown || s.missing.length)) errs.push(`${fam}: ${s.chUnknown + s.courseUnknown} unknown, ${s.missing.length} capítulos con roles faltantes`);
    }
    if (!CI) for (const fam of ['v1-legacy', 'v1-legacy-hvp', 'v2-dynamic', 'moodle-reexport', 'prototype']) assert(byFam[fam] || fam === 'v1-legacy', `sin fixtures de ${fam}`);
    // Prototipo: nada inventado — cada capítulo lo nombra al menos una actividad (número explícito o clave del builder).
    for (const f of fixtures.filter((x) => built.get(x.id).family === 'prototype')) {
      const inv = built.get(f.id).inv;
      for (const c of inv.chapters) {
        const named = c.activities.map((mid) => inv.activities.find((a) => a.moduleId === mid)).some((a) => a.placement.by === 'number' || a.placement.by === 'builder_key');
        if (!named) errs.push(`${f.id}: capítulo ${c.number} sin ninguna actividad que lo nombre (inventado)`);
      }
    }
    if (errs.length) throw new Error(errs.join('; '));
  });

  await check('V4 tokens: huérfano / tipo incorrecto en la actividad sembrada; sanos sin huérfanos; referencias inversas coherentes', async () => {
    const errs = [];
    const seeded = fixtures.filter((f) => f.source === 'damaged' && /token$/.test(f.mutation || ''));
    assert(seeded.length >= (CI ? 2 : 4), `dañados de token: ${seeded.length}`);
    for (const f of seeded) {
      const inv = built.get(f.id).inv;
      const target = f.expectedDefects[0].target;
      const bad = inv.activities.flatMap((a) => a.tokens.filter((t) => t.status !== 'ok').map((t) => ({ a, t })));
      const want = f.mutation === 'orphan-token' ? 'orphan' : 'wrong_type';
      eq(bad.map((x) => [x.a.dir, x.t.status]), [[`activities/${target}`, want]], `${f.id} tokens no ok`);
      const t = bad[0].t;
      if (want === 'wrong_type') eq([t.expected, t.actual], ['quiz', 'label'], `${f.id} tipo esperado / real`);
      else eq([t.targetId, t.actual], [987654, null], `${f.id} destino inexistente`);
      eq(t.entry, `activities/${target}/label.xml`, `${f.id} entrada del token`);
    }
    const healthy = fixtures.filter((f) => f.source === 'synthetic' || (f.source === 'damaged' && !/token$/.test(f.mutation || '')) || (f.source === 'real' && f.family !== 'moodle-reexport'));
    for (const f of healthy) {
      const s = built.get(f.id).inv.stats.tokens;
      if (s.orphan || s.wrong_type || s.malformed || s.external) errs.push(`${f.id}: ${JSON.stringify(s)}`);
    }
    for (const f of fixtures.filter((x) => x.source === 'real' && x.family === 'moodle-reexport')) {
      const inv = built.get(f.id).inv;
      const bad = inv.activities.flatMap((a) => a.tokens.filter((t) => t.status !== 'ok').map((t) => `${a.dir} ${t.token} → ${t.status}`));
      console.log(`   re-export ${f.id}: ${bad.length ? bad.length + ' tokens no ok (dato real del paquete): ' + [...new Set(bad.map((x) => x.split(' ')[1]))].join(', ') : '0 tokens no ok'}`);
    }
    // Referencias inversas: cada token ok a una actividad figura en su referencedBy, y nada más.
    for (const f of fixtures) {
      const inv = built.get(f.id).inv;
      const want = new Map();
      for (const a of inv.activities) for (const t of a.tokens) {
        if (t.targetModuleId !== null) {
          if (!want.has(t.targetModuleId)) want.set(t.targetModuleId, new Set());
          want.get(t.targetModuleId).add(a.moduleId);
        }
      }
      for (const a of inv.activities) {
        const w = [...(want.get(a.moduleId) || [])].sort((x, y) => x - y);
        if (JSON.stringify(w) !== JSON.stringify(a.referencedBy)) { errs.push(`${f.id} ${a.dir}: referencedBy ${JSON.stringify(a.referencedBy)} ≠ ${JSON.stringify(w)}`); break; }
      }
    }
    // Un token roto (`$@…@` sin `$`, p. ej. el `$&` de un String.replace) se ve como `malformed`.
    const tk = M.extractTokens('<a href="$@SCORMVIEWBYID*12@<intro>quot;">x</a> $@QUIZVIEWBYID*13@$ $@NULL@$', { field: 'intro', entry: 'e' },
      { modnameByMid: new Map([[13, 'quiz']]), sectionIds: new Set(), sectionNumbers: new Set(), courseIds: new Set([1]), contextIds: new Set(), instances: new Map(), bookChapters: new Map() });
    eq(tk.map((t) => t.status).sort(), ['malformed', 'ok'], 'token roto + sano (y $@NULL@$ ignorado)');
    if (errs.length) throw new Error(errs.slice(0, 8).join('\n'));
  });

  await check('V5 determinismo: dos corridas sobre el mismo paquete → el mismo inventario byte a byte', async () => {
    for (const f of fixtures) {
      const again = await inventoryOf(Buffer.from(bufs.get(f.id)), f.filename);
      const a = built.get(f.id).json;
      const b = M.stableStringify(again.inv);
      if (a !== b) {
        let i = 0; while (i < a.length && a[i] === b[i]) i++;
        throw new Error(`${f.id}: difiere en el byte ${i}: …${a.slice(Math.max(0, i - 60), i + 60)}… vs …${b.slice(Math.max(0, i - 60), i + 60)}…`);
      }
      eq(M.stableStringify(INV.persistableInventory(again.inv)), M.stableStringify(INV.persistableInventory(built.get(f.id).inv)), `${f.id} persistido`);
    }
  });

  await check('V6 fallas estructurales sembradas → issues del inventario en la actividad correcta (sin excepción)', async () => {
    const map = { 'listed-missing-folder': 'listed_missing_folder', 'duplicate-moduleid': 'moduleid_mismatch' };
    const ds = fixtures.filter((f) => f.source === 'damaged' && map[f.mutation]);
    assert(ds.length >= 2, `dañados estructurales: ${ds.length}`);
    for (const f of ds) {
      const inv = built.get(f.id).inv;
      const target = `activities/${f.expectedDefects[0].target}`;
      assert(inv.issues.some((x) => x.code === map[f.mutation] && x.target === target), `${f.id}: issues ${JSON.stringify(inv.issues)}`);
      if (f.mutation === 'listed-missing-folder') assert(inv.activities.find((a) => a.dir === target).missingFolder === true, `${f.id}: missingFolder`);
    }
    for (const f of fixtures.filter((x) => x.source === 'synthetic')) eq(built.get(f.id).inv.issues, [], `${f.id} sin issues`);
  });

  await check('V7 fuente recuperada (pura): uuid / posición / módulo / final / snapshot; la más reciente; «none» y «error»; persistido sin HTML', async () => {
    const f = fixtures.find((x) => x.id === 'synthetic:v3-A-S');
    const inv = built.get(f.id).inv;
    const ch1 = inv.chapters[0];
    const ch2 = inv.chapters[1];
    const m1 = inv.modules[0];
    const rows = [
      { id: 'a-new', type: 'dynamic_content_md', chapterId: ch1.builderUuid, moduleId: m1.builderUuid, itemKey: 'cv3:content:1', createdAt: '2026-11-02T00:00:00.000Z' },
      { id: 'a-old', type: 'dynamic_content_md', chapterId: ch1.builderUuid, moduleId: m1.builderUuid, itemKey: 'cv3:content:1', createdAt: '2026-11-01T00:00:00.000Z' },
      { id: 'b-pos', type: 'dynamic_video_interactions_json', chapterId: 'aaaaaaaa-0000-4000-8000-000000000002', moduleId: null, itemKey: null, createdAt: null },
      { id: 'c-exam', type: 'dynamic_exam_bank_json', chapterId: null, moduleId: m1.builderUuid, itemKey: 'cv3:exam:1', createdAt: null },
      { id: 'd-final', type: 'dynamic_exam_gift', chapterId: null, moduleId: null, itemKey: 'cv3:final_exam', createdAt: null },
      { id: 'e-snap', type: 'content_snapshot', chapterId: null, moduleId: null, itemKey: null, createdAt: null },
      { id: 'z-other', type: 'mbz_final', chapterId: null, moduleId: null, itemKey: null, createdAt: null },
    ];
    const structure = { chapters: [{ id: 'aaaaaaaa-0000-4000-8000-000000000002', number: 4, moduleId: 'm' }], modules: [] };
    const c = INV.attachSources(inv, { courseId: 7, rows, structure });
    eq([c.sourceLookup.status, c.sourceLookup.courseId], ['found', 7], 'estado');
    const s1 = c.chapters[0].source;
    assert(s1.some((s) => s.artifactId === 'a-new' && s.matchedBy === 'chapter_uuid') && !s1.some((s) => s.artifactId === 'a-old'), `cap 1: la más reciente por uuid ${JSON.stringify(s1)}`);
    assert(s1.some((s) => s.artifactId === 'e-snap' && s.entryHint === 'libro_cap1.md'), 'cap 1: snapshot con la clave del libro');
    const text1 = c.activities.filter((a) => a.placement.chapterNumber === 1 && a.role === 'text');
    assert(text1.length && text1.every((a) => (a.source || []).some((s) => s.artifactId === 'a-new')), 'el md del capítulo llega a sus actividades de texto');
    assert(c.activities.filter((a) => a.placement.chapterNumber === 1 && a.role === 'game').every((a) => !(a.source || []).some((s) => s.artifactId === 'a-new')), 'el md NO se engancha al juego');
    const v4 = c.activities.find((a) => a.placement.chapterNumber === 4 && a.role === 'video');
    assert(v4 && v4.source.some((s) => s.artifactId === 'b-pos' && s.matchedBy === 'chapter_position'), 'por posición (course_chapters)');
    const e1 = c.activities.find((a) => a.kind === 'exam' && a.unit === 1);
    assert(e1.source.some((s) => s.artifactId === 'c-exam' && s.matchedBy === 'module_uuid'), 'examen del módulo por uuid');
    const fin = c.activities.find((a) => a.kind === 'final_exam');
    assert(fin.source.some((s) => s.artifactId === 'd-final' && s.matchedBy === 'item_key'), 'final por la clave del item');
    assert(!JSON.stringify(c).includes('z-other'), 'un tipo que no es fuente no se engancha');
    eq(inv.sourceLookup.status, 'not_identified', 'no muta la entrada');
    eq(INV.attachSources(inv, { courseId: 7, rows: [], structure: null }).sourceLookup.status, 'none', 'sin filas → none');
    const er = INV.attachSources(inv, { courseId: 7, error: 'x' }).sourceLookup;
    eq([er.status, er.detail], ['error', 'x'], 'error de lectura → error');
    const p = INV.persistableInventory(c);
    assert(p.htmlOmitted === true && p.activities.every((a) => a.html.every((h) => h.html === '' && /^[0-9a-f]{40}$/.test(h.sha1) && h.entry)), 'persistido sin HTML, con entrada y sha1');
    eq(p.activities[0].html[0].sha1, inv.activities[0].html[0].sha1, 'sha1 del HTML original');
    assert(p.activities.some((a) => a.exam && a.exam.questions.length && a.exam.questions[0].html), 'las preguntas van completas');
  });

  await check('V8 N1: descarga con tope — UN buffer reservado por content-length / sizeHint (sin Buffer.concat), mismos bytes', async () => {
    const data = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff;
    const body = (b, step = 64 * 1024) => new ReadableStream({ start(c) { for (let i = 0; i < b.length; i += step) c.enqueue(new Uint8Array(b.buffer, b.byteOffset + i, Math.min(step, b.length - i))); c.close(); } });
    const origConcat = Buffer.concat;
    let concats = 0;
    Buffer.concat = function (...a) { concats++; return origConcat.apply(Buffer, a); };
    try {
      const r1 = await ART.readBodyCapped(new Response(body(data), { headers: { 'content-length': String(data.length) } }), 10 << 20, () => {});
      eq([r1.equals(data), concats], [true, 0], 'content-length → reservado, sin concat');
      const r2 = await ART.readBodyCapped(new Response(body(data)), 10 << 20, () => {}, undefined, { sizeHint: data.length });
      eq([r2.equals(data), concats], [true, 0], 'sizeHint (HEAD) → reservado, sin concat');
      const r3 = await ART.readBodyCapped(new Response(body(data)), 10 << 20, () => {}, undefined, { sizeHint: 1000 });
      eq(r3.equals(data), true, 'más bytes que la reserva (el objeto cambió) → mismos bytes por la lista');
      const r4 = await ART.readBodyCapped(new Response(body(data)), 10 << 20, () => {});
      eq(r4.equals(data), true, 'sin tamaño conocido → mismos bytes');
      let aborted = 0;
      let e = null;
      try { await ART.readBodyCapped(new Response(body(data)), 1 << 20, () => aborted++, undefined, { sizeHint: 512 }); } catch (x) { e = x; }
      eq([e && e.code, aborted], [ART.STORAGE_OBJECT_TOO_LARGE, 1], 'el tope sigue mandando');
    } finally {
      Buffer.concat = origConcat;
    }
  });

  await check('V9 N2: el cuerpo tiene su propio plazo (no lo corta el timeout de encabezados); vencido → StorageDownloadTimeoutError con lo recibido', async () => {
    eq([ART.cappedBodyTimeoutMs(300 * 1024 * 1024, 300000), ART.cappedBodyTimeoutMs(null, 300000), ART.cappedBodyTimeoutMs(10, 1000)], [660000, 300000, 61000], 'plazos');
    const cfg = { SUPABASE_URL: 'http://storage.invalid', SUPABASE_SERVICE_ROLE_KEY: 'k', STORAGE_RETRY_MAX_ATTEMPTS: '1' };
    const svc = new ART.ArtifactsService({}, { get: (k) => cfg[k] });
    const realFetch = global.fetch;
    const slow = (n, gapMs) => async (url, init) => new Response(new ReadableStream({
      async start(c) {
        for (let i = 0; i < n; i++) {
          await new Promise((r) => setTimeout(r, gapMs));
          if (init.signal.aborted) { c.error(init.signal.reason || new Error('aborted')); return; }
          c.enqueue(new Uint8Array(1024));
        }
        c.close();
      },
    }), { headers: { 'content-length': String(n * 1024) } });
    try {
      global.fetch = slow(5, 300); // 1,5 s de cuerpo con 1 s de timeout de encabezados
      const t0 = Date.now();
      const b = await svc.downloadStorageObjectCapped('cursia-artifacts', 'u/workshop/s/original.mbz', { maxBytes: 1 << 20, timeoutMs: 1000, bodyTimeoutMs: 10000 });
      eq(b.length, 5 * 1024, 'el cuerpo llegó entero aunque tardó más que el timeout de encabezados');
      assert(Date.now() - t0 >= 1400, 'tardó lo que debía');
      global.fetch = slow(20, 100);
      let e = null;
      try { await svc.downloadStorageObjectCapped('cursia-artifacts', 'u/workshop/s/original.mbz', { maxBytes: 1 << 20, timeoutMs: 1000, bodyTimeoutMs: 450 }); } catch (x) { e = x; }
      assert(e && e.code === ART.STORAGE_DOWNLOAD_TIMEOUT, `esperaba StorageDownloadTimeoutError: ${e && (e.code || e.message)}`);
      assert(e.receivedBytes > 0 && e.receivedBytes < 20 * 1024 && e.expectedBytes === 20 * 1024, `lo recibido: ${e.receivedBytes}/${e.expectedBytes}`);
      assert(/no terminó de llegar/.test(e.message), 'mensaje claro');
    } finally {
      global.fetch = realFetch;
    }
  });

  await check('V10 espacio de ids de cada token (paquete mínimo armado acá): curso / hvp embebido / instancia / capítulo de libro / índice / contexto', async () => {
    const inv = (await inventoryOf(await tokenFixture(), 'tokens.mbz')).inv;
    const lab = inv.activities.find((a) => a.moduleId === 10);
    const st = (tok) => { const t = lab.tokens.filter((x) => x.token === tok); assert(t.length, `falta ${tok}`); return t.map((x) => [x.status, x.anchor ? x.anchor.status : null]); };
    eq(st('$@COURSEVIEWBYID*1@$'), [['ok', 'ok']], 'curso del backup con #module-11 (existe)');
    eq(st('$@COURSEVIEWBYID*2006@$'), [['external', 'orphan'], ['external', null]], 'otro curso del sitio → external (no huérfano), #module-77 no existe');
    eq(st('$@HVPEMBEDBYID*11@$'), [['ok', null]], 'hvp embebido por su moduleid');
    eq(st('$@HVPEMBEDBYID*4821@$'), [['orphan', null]], 'hvp que no está en el paquete');
    eq(st('$@FORUMVIEWBYF*5@$'), [['ok', null]], 'foro por id de INSTANCIA');
    eq(st('$@FORUMVIEWBYF*12@$'), [['orphan', null]], 'instancia inexistente (12 es un moduleid, no una instancia)');
    eq(st('$@BOOKVIEWBYIDCH*13*7@$'), [['ok', null]], 'capítulo 7 del libro 13');
    eq(st('$@BOOKVIEWBYIDCH*13*8@$'), [['orphan', null]], 'capítulo inexistente');
    eq(st('$@SCORMINDEX*1@$'), [['ok', null]], 'índice por id de curso');
    eq(st('$@PLUGINFILEBYCONTEXT*2@$'), [['ok', null]], 'contexto del curso');
    eq(st('$@QUIZVIEWBYID*11@$'), [['wrong_type', null]], 'quiz que es un hvp');
    eq(lab.tokens.filter((x) => x.status === 'malformed').length, 1, 'hvp roto por $&');
    eq(inv.activities.find((a) => a.moduleId === 11).referencedBy, [10], 'el hvp lo referencia el label');
    eq(inv.activities.find((a) => a.moduleId === 12).referencedBy, [10], 'el foro (por instancia) también');
  });

  console.log(`\n${fail ? '❌' : '✅'} check-r107-inventory: ${ok} ok, ${fail} fallidos`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
