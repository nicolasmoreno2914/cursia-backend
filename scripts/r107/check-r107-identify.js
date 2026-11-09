#!/usr/bin/env node
/* eslint-disable */
// r107 B1 — lector seguro + identificación del Taller de cursos, contra el código COMPILADO (dist/). Sin red, sin IA,
// sin base, USD 0. Nada se escribe a disco (se verifica con espías sobre fs).
//
//   I1 cada fixture abre con el lector seguro (zip / tar.gz por bytes mágicos); la lista de archivos coincide con
//      `unzip -Z1` / `tar -tzf` (modo completo, si hay binarios); cada blob files/xx/<sha1> leído tiene ese sha1
//      (salvo el dañado `blob-altered`, que tiene EXACTAMENTE uno distinto)
//   I2 familia de formato: la de identify.ts coincide con la del manifiesto (sintéticos y dañados v3 = v2-dynamic) Y con
//      `familyOf` de scripts/r107/build-corpus.js aplicada a los mismos hechos (misma regla, sin copia divergente)
//   I3 identificación pura con un catálogo simulado (dueño A + un curso de OTRA cuenta con el mismo título, sha256 y
//      estructura, y con el id que nombra la marca v3): huella → exacta; marca v3 + título → exacta; título +
//      estructura → heurística alta; nada → «solo el paquete»; el curso ajeno NUNCA aparece (ni curso, ni candidato)
//   I4 marca futura `cursia_meta.json` (inyectada en un sintético): se lee → exacta; apuntando a otra cuenta → ignorada
//   I5 paquetes hostiles generados acá: `../evil`, ruta absoluta, letra de unidad, enlace tar, nombre repetido,
//      demasiadas entradas, entrada con razón de compresión absurda, entrada que miente su tamaño, total > límite,
//      tar.gz bomba, archivo que no es zip ni tar.gz, zip cortado → rechazados con código y motivo claro, sin escribir
//   I6 piezas puras del servicio: nombre de archivo saneado, ruta en la carpeta del dueño, flag COURSE_WORKSHOP
//
// Usage:
//   node scripts/r107/check-r107-identify.js --corpus [manifest.json|dir]   (completo, local: corpus real de B0)
//   node scripts/r107/check-r107-identify.js --ci                            (CI: solo sintéticos + dañados generados acá)
//   [--dist dist]
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
const CI = has('--ci');
const DEFAULT_CORPUS = path.join(os.homedir(), 'cursia-test-env/work/r107/corpus/manifest.json');
if (!CI && !has('--corpus')) { console.error('Usage: --corpus [manifest.json|dir] | --ci  [--dist dist]'); process.exit(2); }
let corpusArg = CI ? null : arg('--corpus', DEFAULT_CORPUS);
if (corpusArg && fs.existsSync(corpusArg) && fs.statSync(corpusArg).isDirectory()) corpusArg = path.join(corpusArg, 'manifest.json');

const L = (rel) => { try { return require(path.join(DIST, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿npm run build?): ${e.message}`); process.exit(1); } };
const R = L('modules/course-workshop/mbz-reader.js');
const I = L('modules/course-workshop/identify.js');
const SVC = L('modules/course-workshop/course-workshop.service.js');
const FLAG = L('modules/features/course-workshop-flag.js');
const ART = L('modules/artifacts/artifacts.service.js');
const BC = require(path.join(REPO, 'scripts/r107/build-corpus.js'));

let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n   ')}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const sha = (algo, b) => crypto.createHash(algo).update(b).digest('hex');

// ── Espía de escrituras: el lector y la identificación no escriben NADA a disco ───────────────────────────────────────
const writes = [];
function spyWrites() {
  const orig = {};
  const names = ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream', 'mkdirSync', 'mkdir', 'mkdtempSync', 'openSync', 'symlinkSync', 'renameSync', 'copyFileSync'];
  for (const n of names) {
    orig[n] = fs[n];
    fs[n] = function (...a) {
      if (n === 'openSync' && !/[wa+]/.test(String(a[1] ?? 'r'))) return orig[n].apply(fs, a);
      writes.push(`${n}(${String(a[0]).slice(0, 80)})`);
      return orig[n].apply(fs, a);
    };
  }
  const p = fs.promises;
  const porig = { writeFile: p.writeFile, appendFile: p.appendFile, mkdir: p.mkdir, open: p.open };
  p.writeFile = (...a) => { writes.push(`promises.writeFile(${String(a[0]).slice(0, 80)})`); return porig.writeFile.apply(p, a); };
  p.appendFile = (...a) => { writes.push(`promises.appendFile(${String(a[0]).slice(0, 80)})`); return porig.appendFile.apply(p, a); };
  p.mkdir = (...a) => { writes.push(`promises.mkdir(${String(a[0]).slice(0, 80)})`); return porig.mkdir.apply(p, a); };
  return () => { for (const n of names) fs[n] = orig[n]; Object.assign(p, porig); };
}

// ── Mini escritor de zip / tar crudos (para fabricar paquetes hostiles que JSZip normalizaría) ────────────────────────
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
/** entries: [{ name, data?, deflate?, declaredSize?, raw? (bytes comprimidos ya hechos) }] */
function rawZip(entries) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data ?? Buffer.alloc(0);
    const comp = e.raw ?? (e.deflate ? zlib.deflateRawSync(data) : data);
    const method = e.raw || e.deflate ? 8 : 0;
    const size = e.declaredSize ?? data.length;
    const crc = e.crc ?? crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Math.min(entries.length, 0xffff), 8); eocd.writeUInt16LE(Math.min(entries.length, 0xffff), 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
function tarHeader(name, size, type = '0', linkname = '') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
  h.write('        ', 148); h.write(type, 156); h.write(linkname.slice(0, 100), 157); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
function rawTarGz(entries) {
  const parts = [];
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    parts.push(tarHeader(e.name, data.length, e.type || '0', e.link || ''));
    parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}
const MIN_BACKUP = (title = 'Curso hostil', extra = '') => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<moodle_backup><information><name>x.mbz</name><original_course_fullname>${title}</original_course_fullname><contents><activities></activities><sections></sections></contents>${extra}</information></moodle_backup>`);

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async function ciFixtures() {
  // Sintéticos v3 sanos con el MISMO motor de B0 (determinista, sin red) + dañados con las MISMAS mutaciones de B0.
  const S = require(path.join(REPO, 'scripts/lib/commercial-simulation'));
  const COURSES = require(path.join(REPO, 'scripts/fixtures/commercial-simulation/courses.json')).courses;
  const JSZip = require('jszip');
  const out = [];
  let base = null;
  for (const id of ['A-S', '1x1-sin-examenes']) {
    const sim = await S.simulateCourse(DIST, COURSES.find((c) => c.id === id));
    out.push({ id: 'synthetic:v3-' + id, source: 'synthetic', family: 'v2-dynamic', buf: sim.built.mbz, filename: `v3-${id}.mbz` });
    if (id === 'A-S') base = sim.built.mbz;
  }
  for (const name of ['blob-altered', 'orphan-token', 'listed-missing-folder']) {
    const zip = await JSZip.loadAsync(base);
    const exp = await BC.MUTATIONS[name](zip);
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    out.push({ id: `v3-A-S~${name}`, source: 'damaged', mutation: name, family: 'v2-dynamic', buf, filename: `v3-A-S~${name}.mbz`, expectedDefects: [exp] });
  }
  return out;
}
function corpusFixtures(manifestPath) {
  const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const v1Base = man.v1DamageBase ? man.fixtures.find((f) => f.sha1 === man.v1DamageBase.sha1) : null;
  return man.fixtures.filter((f) => !f.skipped).map((f) => {
    let family = f.family;
    if (!family && f.source === 'damaged') family = f.format === 'v3' ? 'v2-dynamic' : (v1Base ? v1Base.family : 'v1-legacy-hvp');
    return { ...f, family, filename: path.basename(f.path), load: () => fs.readFileSync(f.path) };
  });
}

function listWithSystemTool(file, container) {
  const r = container === 'zip' ? spawnSync('unzip', ['-Z1', file], { maxBuffer: 1 << 28, encoding: 'utf8' }) : spawnSync('tar', ['-tzf', file], { maxBuffer: 1 << 28, encoding: 'utf8' });
  if (r.status !== 0 || r.error) return null;
  return r.stdout.split('\n').filter(Boolean).map((e) => e.replace(/^(\.\/)+/, '')).filter((e) => e && !e.endsWith('/')).sort();
}

// ── Catálogo simulado para I3 ─────────────────────────────────────────────────────────────────────────────────────────
const OWNER_A = '11111111-2222-4333-8444-555555555555';
const OWNER_B = '99999999-8888-4777-8666-555555555555';
const SCOPE_A = { ownerId: OWNER_A, institutionId: null };
const FOREIGN_ID = 900001;
function foreignCourse(facts, sha256, size, idOverride) {
  // Curso de OTRA cuenta que coincide en TODO (título, huella, estructura, tamaño). Nunca debe aparecer.
  return { courseId: idOverride ?? FOREIGN_ID, title: facts.title || 'X', ownerId: OWNER_B, institutionId: null, packages: [{ artifactId: 'art-foreign', type: 'mbz_final', sha256, sizeBytes: size, builderVersion: '9.9.9', activityCount: facts.activities }] };
}
function assertNoForeign(r, foreignIds, m) {
  for (const id of foreignIds) {
    assert(r.courseId !== id, `${m}: identificó un curso de otra cuenta (${id})`);
    assert(!r.candidates.some((c) => c.courseId === id), `${m}: candidato de otra cuenta (${id})`);
  }
  assert(!JSON.stringify(r).includes('art-foreign'), `${m}: filtró el artifact ajeno`);
}

(async () => {
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const unspy = spyWrites();
  const fixtures = CI ? await ciFixtures() : corpusFixtures(corpusArg);
  console.log(`  modo ${CI ? 'CI (sintéticos + dañados generados)' : 'completo: ' + corpusArg} — ${fixtures.length} fixtures`);
  const opened = [];

  await check(`I1 cada fixture abre con el lector seguro; blobs con su sha1; lista = herramienta del sistema (${CI ? 'CI: sin comparación externa' : 'completo'})`, async () => {
    const problems = [];
    for (const f of fixtures) {
      const buf = f.buf ?? f.load();
      let pkg;
      try { pkg = await R.openMbz(buf); } catch (e) { problems.push(`${f.id}: ${e.code} ${e.message}`); continue; }
      if (!CI) {
        const sys = listWithSystemTool(f.path, pkg.container);
        if (sys) {
          const mine = pkg.entries.map((e) => e.name).sort();
          if (JSON.stringify(sys) !== JSON.stringify(mine)) problems.push(`${f.id}: lista distinta (${mine.length} vs ${sys.length})`);
        }
      }
      const blobs = pkg.entries.filter((e) => /^files\/[0-9a-f]{2}\/[0-9a-f]{40}$/.test(e.name)).map((e) => e.name);
      const got = await pkg.readEntries(blobs);
      let bad = 0;
      for (const [n, b] of got) if (sha('sha1', b) !== n.split('/').pop()) bad++;
      const expectBad = f.mutation === 'blob-altered' ? 1 : 0;
      if (bad !== expectBad) problems.push(`${f.id}: ${bad} blobs con sha1 distinto (esperado ${expectBad})`);
      if (got.size !== blobs.length) problems.push(`${f.id}: leí ${got.size}/${blobs.length} blobs`);
      opened.push({ f, buf, pkg, sha1: sha('sha1', buf), sha256: sha('sha256', buf) });
    }
    eq(problems, [], 'problemas');
    assert(opened.some((o) => o.pkg.container === 'zip'), 'hay zip');
    if (!CI) assert(opened.some((o) => o.pkg.container === 'tar.gz'), 'el corpus completo tiene tar.gz');
  });

  await check('I2 familia de formato = manifiesto (sintéticos/dañados v3 = v2-dynamic) = familyOf de build-corpus.js', async () => {
    const bad = [];
    const counts = {};
    for (const o of opened) {
      o.facts = await I.readPackageFacts(o.pkg, o.f.filename);
      const fam = I.familyOf(o.facts);
      const bcFam = BC.familyOf({ modules: o.facts.modules, moodleReexport: o.facts.moodleReexport });
      counts[fam] = (counts[fam] || 0) + 1;
      if (fam !== o.f.family) bad.push(`${o.f.id}: ${fam} ≠ manifiesto ${o.f.family}`);
      if (fam !== bcFam) bad.push(`${o.f.id}: ${fam} ≠ build-corpus ${bcFam}`);
    }
    eq(bad, [], 'familias');
    console.log(`     familias: ${JSON.stringify(counts)}`);
    if (!CI) eq(Object.keys(counts).sort(), [...I.WORKSHOP_FAMILIES].sort(), 'las 5 familias presentes en el corpus');
  });

  await check('I2b línea de builder: v2-dynamic → v3, V1/prototipo → legacy-v1, re-export → moodle-reexport', async () => {
    const want = { 'v2-dynamic': 'v3', 'v1-legacy': 'legacy-v1', 'v1-legacy-hvp': 'legacy-v1', prototype: 'legacy-v1', 'moodle-reexport': 'moodle-reexport' };
    const bad = opened.filter((o) => I.builderLineOf(o.facts) !== want[o.f.family]).map((o) => `${o.f.id}: ${I.builderLineOf(o.facts)}`);
    eq(bad, [], 'líneas');
  });

  await check('I3 identificación pura por fixture: huella / marca v3 / heurística / nada — y el curso de otra cuenta NUNCA aparece', async () => {
    const tally = { package_hash: 0, v3_name_marker: 0, heuristic: 0, none: 0 };
    for (const o of opened) {
      const { facts, sha1, sha256 } = o;
      const size = o.buf.length;
      const foreign = foreignCourse(facts, sha256, size);
      const foreignMarker = facts.v3NameCourseId ? foreignCourse(facts, sha256, size, facts.v3NameCourseId) : null;
      const foreigns = [foreign, ...(foreignMarker ? [foreignMarker] : [])];
      const fids = foreigns.map((x) => x.courseId);
      const unrelated = { courseId: 1, title: 'Curso que no tiene nada que ver', ownerId: OWNER_A, institutionId: null, packages: [] };
      const run = (catalog) => I.identifyPackage({ facts, sha1, sha256, sizeBytes: size, scope: SCOPE_A, catalog });
      const tag = o.f.id;

      // (a) huella: un artifact del dueño A con el mismo sha256 → exacta, con la versión de builder del artifact.
      let r = run([...foreigns, unrelated, { courseId: 10, title: 'otro título', ownerId: OWNER_A, institutionId: null, packages: [{ artifactId: 'art-a', type: 'dynamic_mbz', sha256, sizeBytes: size, builderVersion: '3.19.0', activityCount: null }] }]);
      eq([r.method, r.confidence, r.courseId, r.matchedArtifactId, r.builder.version, r.family], ['package_hash', 'exact', 10, 'art-a', '3.19.0', o.f.family], `${tag} huella`);
      assertNoForeign(r, fids, `${tag} huella`);
      tally.package_hash++;

      // (b) solo la cuenta ajena coincide → nada (o heurística sin ella).
      r = run([...foreigns, unrelated]);
      assertNoForeign(r, fids, `${tag} solo ajeno`);
      eq([r.courseId, r.method], [null, 'none'], `${tag} solo ajeno → solo el paquete`);
      tally.none++;

      // (c) marca v3: el curso del dueño con el id que nombra el paquete y el mismo título → exacta.
      if (facts.v3NameCourseId && facts.title) {
        r = run([unrelated, { courseId: facts.v3NameCourseId, title: facts.title, ownerId: OWNER_A, institutionId: null, packages: [] }]);
        eq([r.method, r.confidence, r.courseId], ['v3_name_marker', 'exact', facts.v3NameCourseId], `${tag} marca v3`);
        tally.v3_name_marker++;
        // mismo id, otro título → no es exacta (queda como candidato con la seña)
        r = run([{ courseId: facts.v3NameCourseId, title: 'Un título completamente distinto', ownerId: OWNER_A, institutionId: null, packages: [] }]);
        assert(r.method !== 'v3_name_marker' && r.confidence !== 'exact', `${tag} marca v3 sin título no es exacta: ${r.method}`);
      }

      // (d) heurística: mismo título + misma cantidad de actividades (sin huella) → alta, pide confirmación.
      if (facts.title && facts.activities > 0) {
        r = run([...foreigns.map((x) => ({ ...x, packages: x.packages.map((p) => ({ ...p, sha256: null })) })), unrelated,
          { courseId: 20, title: facts.title, ownerId: OWNER_A, institutionId: null, packages: [{ artifactId: 'art-h', type: 'mbz_final', sha256: null, sizeBytes: null, builderVersion: null, activityCount: facts.activities }] }]);
        eq([r.method, r.confidence, r.courseId, r.needsConfirmation], ['heuristic', 'high', 20, true], `${tag} heurística`);
        assertNoForeign(r, fids, `${tag} heurística`);
        tally.heuristic++;
        // dos cursos igual de parecidos → no identifica, devuelve ambos candidatos
        r = run([{ courseId: 21, title: facts.title, ownerId: OWNER_A, institutionId: null, packages: [{ artifactId: 'x1', type: 'mbz_final', sha256: null, sizeBytes: null, builderVersion: null, activityCount: facts.activities }] },
          { courseId: 22, title: facts.title, ownerId: OWNER_A, institutionId: null, packages: [{ artifactId: 'x2', type: 'mbz_final', sha256: null, sizeBytes: null, builderVersion: null, activityCount: facts.activities }] }]);
        eq([r.courseId, r.candidates.map((c) => c.courseId)], [null, [21, 22]], `${tag} empate`);
      }

      // (e) institución: un curso de la institución de la sesión cuenta; uno de otra institución no.
      const INST = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      r = I.identifyPackage({ facts, sha1, sha256, sizeBytes: size, scope: { ownerId: OWNER_A, institutionId: INST }, catalog: [
        { courseId: 30, title: 'x', ownerId: OWNER_B, institutionId: INST, packages: [{ artifactId: 'art-i', type: 'mbz_final', sha256, sizeBytes: size, builderVersion: null, activityCount: null }] }] });
      eq([r.method, r.courseId], ['package_hash', 30], `${tag} institución`);
      r = I.identifyPackage({ facts, sha1, sha256, sizeBytes: size, scope: { ownerId: OWNER_A, institutionId: INST }, catalog: [
        { courseId: 31, title: 'x', ownerId: OWNER_B, institutionId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', packages: [{ artifactId: 'art-foreign', type: 'mbz_final', sha256, sizeBytes: size, builderVersion: null, activityCount: null }] }] });
      assertNoForeign(r, [31], `${tag} otra institución`);
    }
    console.log(`     escenarios: ${JSON.stringify(tally)} sobre ${opened.length} fixtures`);
  });

  await check('I4 marca futura cursia_meta.json (inyectada en un sintético): se lee → exacta con su versión; a otra cuenta → ignorada', async () => {
    const JSZip = require('jszip');
    const o = opened.find((x) => x.f.source === 'synthetic');
    assert(o, 'hay un sintético');
    const zip = await JSZip.loadAsync(o.buf);
    zip.file('cursia_meta.json', JSON.stringify({ schema: 1, courseId: 4242, builderVersion: '3.20.0' }));
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const pkg = await R.openMbz(buf);
    const facts = await I.readPackageFacts(pkg, 'curso.mbz');
    eq(facts.cursiaMeta, { schema: 1, courseId: 4242, builderVersion: '3.20.0' }, 'marca leída');
    let r = I.identifyPackage({ facts, sha1: sha('sha1', buf), sha256: sha('sha256', buf), sizeBytes: buf.length, scope: SCOPE_A, catalog: [{ courseId: 4242, title: 'otro', ownerId: OWNER_A, institutionId: null, packages: [] }] });
    eq([r.method, r.confidence, r.courseId, r.builder.version, r.builder.source], ['cursia_meta', 'exact', 4242, '3.20.0', 'cursia_meta'], 'exacta');
    r = I.identifyPackage({ facts, sha1: sha('sha1', buf), sha256: sha('sha256', buf), sizeBytes: buf.length, scope: SCOPE_A, catalog: [{ courseId: 4242, title: facts.title, ownerId: OWNER_B, institutionId: null, packages: [] }] });
    assertNoForeign(r, [4242], 'marca a otra cuenta');
    assert(r.notes.some((n) => /no está en tu cuenta/.test(n)), 'avisa sin nombrar el curso ajeno');
    eq(I.parseCursiaMeta('{roto'), null, 'JSON roto → sin marca');
    eq(I.parseCursiaMeta('{"courseId":"x","builderVersion":"<script>"}'), { schema: 1, courseId: null, builderVersion: null }, 'valores inválidos se descartan');
  });

  // ── I5 hostiles ──
  const hostile = [];
  const big = Buffer.alloc(64 * 1024 * 1024); // ceros: comprimen ~1000×
  const bigDeflated = zlib.deflateRawSync(big, { level: 9 });
  hostile.push(['zip con ../evil', rawZip([{ name: 'moodle_backup.xml', data: MIN_BACKUP() }, { name: '../evil', data: Buffer.from('x') }]), 'unsafe_path', /«\.\.»/]);
  hostile.push(['zip con ruta absoluta', rawZip([{ name: '/etc/passwd', data: Buffer.from('x') }]), 'unsafe_path', /absoluta/]);
  hostile.push(['zip con letra de unidad', rawZip([{ name: 'C:\\Windows\\evil.dll', data: Buffer.from('x') }]), 'unsafe_path', /unidad/]);
  hostile.push(['zip con ..\\ (barra invertida)', rawZip([{ name: 'activities\\..\\..\\evil', data: Buffer.from('x') }]), 'unsafe_path', /«\.\.»/]);
  hostile.push(['zip con nombre repetido', rawZip([{ name: 'moodle_backup.xml', data: MIN_BACKUP('A') }, { name: 'moodle_backup.xml', data: MIN_BACKUP('B') }]), 'duplicate_entry', /mismo nombre/]);
  hostile.push(['zip con 20 001 entradas', rawZip(Array.from({ length: 20001 }, (_, i) => ({ name: `f/${i}` }))), 'too_many_entries', /20000/]);
  hostile.push(['zip con razón de compresión absurda (64 MB de ceros)', rawZip([{ name: 'moodle_backup.xml', data: MIN_BACKUP() }, { name: 'files/00/bomba', raw: bigDeflated, declaredSize: big.length, crc: crc32(big) }]), 'zip_bomb', /bomba/]);
  hostile.push(['no es zip ni tar.gz (PDF)', Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n'), 'not_mbz', /no es un zip ni un tar\.gz/]);
  hostile.push(['no es zip ni tar.gz (tar sin comprimir)', Buffer.concat([tarHeader('moodle_backup.xml', 0), Buffer.alloc(1024)]), 'not_mbz', /no es un zip ni un tar\.gz/]);
  hostile.push(['archivo vacío', Buffer.alloc(0), 'not_mbz', /vacío/]);
  hostile.push(['zip cortado (sin directorio central)', rawZip([{ name: 'moodle_backup.xml', data: MIN_BACKUP() }]).subarray(0, 60), 'corrupt', /dañado/]);
  hostile.push(['tar.gz con ../evil', rawTarGz([{ name: 'moodle_backup.xml', data: MIN_BACKUP() }, { name: '../evil', data: Buffer.from('x') }]), 'unsafe_path', /«\.\.»/]);
  hostile.push(['tar.gz con ruta absoluta', rawTarGz([{ name: '/tmp/evil', data: Buffer.from('x') }]), 'unsafe_path', /absoluta/]);
  hostile.push(['tar.gz con enlace simbólico', rawTarGz([{ name: 'files/link', type: '2', link: '/etc/passwd' }]), 'unsafe_path', /enlace/]);
  hostile.push(['tar.gz bomba (64 MB de ceros)', rawTarGz([{ name: 'moodle_backup.xml', data: MIN_BACKUP() }, { name: 'files/00/bomba', data: big }]), 'zip_bomb', /bomba|expande/]);

  await check(`I5 ${hostile.length} paquetes hostiles → rechazados con código y motivo claro, sin escribir nada`, async () => {
    const w0 = writes.length;
    const bad = [];
    for (const [name, buf, code, re] of hostile) {
      try {
        await R.openMbz(buf);
        bad.push(`${name}: se abrió`);
      } catch (e) {
        if (!(e instanceof R.MbzReaderError)) bad.push(`${name}: error no tipado ${e && e.message}`);
        else if (e.code !== code) bad.push(`${name}: código ${e.code} (esperado ${code}) — ${e.message}`);
        else if (!re.test(e.message) || /\bat \w|Error:/.test(e.message)) bad.push(`${name}: mensaje poco claro ${JSON.stringify(e.message)}`);
      }
    }
    eq(bad, [], 'rechazos');
    eq(writes.slice(w0), [], 'escrituras a disco');
  });

  await check('I5b ataques que pasan la apertura y caen al LEER: entrada que miente su tamaño; total descomprimido > límite; tope por lectura', async () => {
    const w0 = writes.length;
    // declara 1 KB pero se expande a 64 MB: se corta en el tamaño declarado (nunca 64 MB en memoria).
    const liar = rawZip([{ name: 'moodle_backup.xml', data: MIN_BACKUP() }, { name: 'files/00/mentira', raw: bigDeflated, declaredSize: 1024, crc: 0 }]);
    const pkg = await R.openMbz(liar);
    let err = null;
    try { await pkg.readEntry('files/00/mentira'); } catch (e) { err = e; }
    assert(err && ['zip_bomb', 'corrupt'].includes(err.code), `mentira: ${err && err.code}`);
    // total: 3 entradas de 600 KB aleatorias (sin razón sospechosa) con un límite de 1 MB.
    const rnd = (n) => crypto.randomBytes(n);
    let e2 = null;
    try { await R.openMbz(rawZip([{ name: 'a', data: rnd(600000) }, { name: 'b', data: rnd(600000) }]), { maxTotalUncompressedBytes: 1000000 }); } catch (e) { e2 = e; }
    eq(e2 && e2.code, 'zip_bomb', 'total > límite (zip)');
    let e3 = null;
    try { await R.openMbz(rawTarGz([{ name: 'a', data: rnd(600000) }, { name: 'b', data: rnd(600000) }]), { maxTotalUncompressedBytes: 1000000 }); } catch (e) { e3 = e; }
    eq(e3 && e3.code, 'zip_bomb', 'total > límite (tar.gz)');
    // tope por lectura: un moodle_backup.xml más grande que maxBytes no se descomprime.
    const p2 = await R.openMbz(rawZip([{ name: 'moodle_backup.xml', data: MIN_BACKUP('x'.repeat(5000)), deflate: true }]));
    let e4 = null;
    try { await p2.readEntry('moodle_backup.xml', { maxBytes: 100 }); } catch (e) { e4 = e; }
    eq(e4 && e4.code, 'entry_too_large', 'tope por lectura');
    // CRC distinto (si el runtime trae zlib.crc32)
    if (typeof zlib.crc32 === 'function') {
      const badCrc = await R.openMbz(rawZip([{ name: 'moodle_backup.xml', data: MIN_BACKUP(), crc: 1234 }]));
      let e5 = null;
      try { await badCrc.readEntry('moodle_backup.xml'); } catch (e) { e5 = e; }
      eq(e5 && e5.code, 'corrupt', 'CRC');
    }
    // sin moodle_backup.xml → la identificación lo dice (no es un error del lector)
    const noBackup = await R.openMbz(rawZip([{ name: 'otra/cosa.txt', data: Buffer.from('hola') }]));
    let e6 = null;
    try { await I.readPackageFacts(noBackup, 'x.mbz'); } catch (e) { e6 = e; }
    eq(e6 && e6.code, 'missing_moodle_backup', 'sin moodle_backup.xml');
    eq(writes.slice(w0), [], 'escrituras a disco');
  });

  await check('I5c nombres de entrada: normalización (./ del tar, carpetas) y rechazos', async () => {
    const n = R.normalizeEntryName;
    eq(n('./moodle_backup.xml'), { name: 'moodle_backup.xml', dir: false }, './');
    eq(n('activities/label_1/'), { name: 'activities/label_1', dir: true }, 'carpeta');
    eq(n('./'), { name: '', dir: true }, 'raíz del tar');
    for (const bad of ['../x', 'a/../../x', '/abs', 'C:/x', 'a\u0000b', 'a//b', 'a/./b', '']) assert('problem' in n(bad), `debió rechazar ${JSON.stringify(bad)}`);
  });

  await check('I6 servicio (puro): nombre saneado, ruta en la carpeta del dueño, flag COURSE_WORKSHOP fail closed', async () => {
    eq(SVC.sanitizeUploadFilename('C:\\Users\\x\\Mi curso.mbz'), 'Mi curso.mbz', 'basename');
    eq(SVC.sanitizeUploadFilename('../../etc/evil.mbz'), 'evil.mbz', 'sin ruta');
    eq(SVC.sanitizeUploadFilename('curso.zip'), null, 'solo .mbz');
    eq(SVC.sanitizeUploadFilename(42), null, 'no string');
    const sid = 'cccccccc-dddd-4eee-8fff-000000000000';
    const p = SVC.workshopStoragePath(OWNER_A, sid);
    eq(p, `${OWNER_A}/workshop/${sid}/original.mbz`, 'ruta');
    assert(ART.storagePathOwnedBy(OWNER_A, 'cursia-artifacts', p), 'la ruta es de la carpeta del dueño');
    assert(!ART.storagePathOwnedBy(OWNER_B, 'cursia-artifacts', p), 'no es de otra cuenta');
    eq(SVC.WORKSHOP_MAX_UPLOAD_BYTES, 300 * 1024 * 1024, 'tope 300 MB');
    const F = FLAG.isCourseWorkshopAllowedForOwner;
    eq(F(OWNER_A, {}), false, 'off');
    eq(F(OWNER_A, { COURSE_WORKSHOP: 'True', COURSE_WORKSHOP_ALLOWED_OWNERS: OWNER_A }), false, 'solo "true" exacto');
    eq(F(OWNER_A, { COURSE_WORKSHOP: 'true' }), false, 'on + lista vacía → nadie');
    eq(F(OWNER_A, { COURSE_WORKSHOP: 'true', COURSE_WORKSHOP_ALLOWED_OWNERS: OWNER_A.toUpperCase() }), true, 'listado');
    eq(F(OWNER_B, { COURSE_WORKSHOP: 'true', COURSE_WORKSHOP_ALLOWED_OWNERS: OWNER_A }), false, 'no listado');
    eq(F(OWNER_B, { COURSE_WORKSHOP: 'true', COURSE_WORKSHOP_ALL_OWNERS: 'true' }), true, 'habilitación pública');
    let err = null;
    try { F(OWNER_A, { COURSE_WORKSHOP: 'true', COURSE_WORKSHOP_ALLOWED_OWNERS: 'no-es-uuid' }); } catch (e) { err = e; }
    assert(err && /COURSE_WORKSHOP_ALLOWED_OWNERS/.test(err.message), 'lista inválida → error ruidoso');
    const POL = L('modules/artifacts/artifact-type-policy.js');
    assert(POL.isServerOnlyArtifactType('workshop_original'), 'workshop_original solo del servidor');
  });

  unspy();
  console.log(`\n${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
