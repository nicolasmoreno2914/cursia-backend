#!/usr/bin/env node
/* eslint-disable */
// r107 B4 — motor de parches determinista del Taller (Fase 2: edit_html, edit_libro_section, exam_question_*,
// brand_replace, remove_activity), contra el código COMPILADO (dist/). Sin red, sin IA, sin base, USD 0. Nunca escribe
// sobre los paquetes de entrada (los reales se leen donde están; las operaciones van sobre copias en memoria).
//
//   P1  catálogo cerrado, plan vacío, operación desconocida → falla tipada; el original NUNCA cambia
//   P2  edit_html: reemplazo completo (xmlEsc EXACTO: & < > ", sin apóstrofes; `$&`, `$1`, `$$`, emoji, tildes llegan
//       tal cual), resumen de sección, capítulo de book, rango en bytes (dead_link), token (quitar enlace / cambiar destino)
//       + casos malos (token huérfano / de otro tipo / roto / a otro curso, <style>, <script>, @@PLUGINFILE@@ ajeno,
//       rango que corta una entidad o un carácter, campo inexistente, precondición vencida)
//   P3  invariantes de bytes en TODOS los planes que salen bien: lo no tocado idéntico (contenido y, en zip, bytes
//       comprimidos), files.xml ↔ blobs coherentes (sha1 + tamaño, sin huérfanos nuevos), ids nuevos únicos en todo el
//       paquete, campos tocados = xmlUnescape del crudo, diagnóstico B3 recalculado acá sin hallazgos nuevos
//   P4  edit_libro_section: Libro V1 intacto (cuerpo + título), con páginas `<div class="page">` (buildLibroHTML),
//       capítulo faltante agregado, Libro CORTADO recompuesto desde la fuente, blob compartido (todas las entradas de
//       files.xml al día), PDF v3 / book → «no disponible», casos malos
//   P5  exam_question_*: aleatorias (v3 A-S), fijas (v3 ofimática), Moodle 3.x (V1 mínimo); 1 correcta, fracciones de
//       Moodle, sin «todas las anteriores», mínimo por ranura aleatoria y mínimo 1, sumgrades = Σ maxmark, grade igual
//   P6  brand_replace: logo en blob + data URI en HTML + portada del Libro; colores SOLO en style="" (no en texto
//       visible ni en el JS del SCORM); casos malos
//   P7  remove_activity: carpeta, moodle_backup (activity + settings), sequence, files.xml + blobs huérfanos (el
//       compartido se conserva), banco del examen, enlaces que la nombraban saneados; último examen / sección vacía /
//       token en iframe → falla
//   P8  todo o nada · P9 operación sobre un campo que cambió antes en el plan → stale · P10 un hallazgo nuevo → el
//       plan falla · P11 tar.gz → tar.gz · P12 determinismo
//   P13 los hallazgos SEMBRADOS de B0 se arreglan con su suggestedFix (token huérfano, pendiente, etiqueta vacía,
//       Libro cortado en V1 con la fuente, pregunta sin correcta) y el diagnóstico posterior los da por resueltos
//
//   --corpus: P13 sobre los dañados del corpus (incl. el V1 REAL de B0) + matriz de operaciones por familia sobre los
//             15 reales (cada operación sola y el plan combinado), con sus invariantes
//   --moodle: restauración REAL en el Moodle 4.5 local (v3 A-S y un V1 real, 5 operaciones cada uno) + inspector PHP
//   --bite:   rompe invariantes en una copia de dist/ y confirma que --ci falla
//
// Usage: node scripts/r107/check-r107-patch.js --ci | --corpus [manifest.json] | --moodle | --bite   [--dist dist]
'use strict';
require('reflect-metadata');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const DIST = path.resolve(arg('--dist', path.join(REPO, 'dist')));
const MODE = has('--ci') ? 'ci' : has('--corpus') ? 'corpus' : has('--moodle') ? 'moodle' : has('--bite') ? 'bite' : null;
if (!MODE) { console.error('Usage: --ci | --corpus [manifest.json] | --moodle | --bite  [--dist dist]'); process.exit(2); }
const DEFAULT_CORPUS = path.join(os.homedir(), 'cursia-test-env/work/r107/corpus/manifest.json');

let ok = 0;
let fail = 0;
const failed = [];
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; failed.push(name); console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 8).join('\n   ')}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
/** xmlEsc de los builders, escrito acá a mano (independiente del motor): & < > " — NUNCA el apóstrofe. */
const exactEsc = (s) => String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// ── --bite ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (MODE === 'bite') {
  const patches = [
    { name: 'xmlEsc escapa apóstrofes', file: 'modules/course-workshop/patch/html-edit.js', from: 'newRaw: (0, mbz_common_1.xmlEsc)(html)', to: "newRaw: (0, mbz_common_1.xmlEsc)(html).split(\"'\").join('&#39;')", expect: /P2/ },
    { name: 'String.replace con string de reemplazo (expande $&)', file: 'modules/course-workshop/patch/html-edit.js', from: 'newRaw: (0, mbz_common_1.xmlEsc)(html)', to: "newRaw: 'X'.replace('X', (0, mbz_common_1.xmlEsc)(html))", expect: /P2/ },
    { name: 'files.xml no se actualiza al cambiar un blob', file: 'modules/course-workshop/patch/op-context.js', from: "ctx.state.write('files.xml', xml);", to: '/* bite */', expect: /P4|P6/ },
    { name: 'el zip recomprime TODO (lo no tocado deja de ser byte a byte)', file: 'modules/course-workshop/patch/container.js', from: 'if (!ch && r) {', to: 'if (false) {', expect: /P3|P2/ },
    { name: 'sin validación de tokens del HTML nuevo', file: 'modules/course-workshop/patch/html-edit.js', from: 'if (bad.length) {', to: 'if (false) {', expect: /P2/ },
    { name: 'sin la regla «ningún hallazgo nuevo»', file: 'modules/course-workshop/patch/engine.js', from: 'if (delta.introduced.length) {', to: 'if (false) {', expect: /P10/ },
    { name: 'ranuras aleatorias: solo el filtercondition de Moodle 4.1 (no el de 4.3+)', file: 'modules/course-workshop/patch/op-exam.js', from: 'const cat = j.filter?.category;', to: 'const cat = undefined;', expect: /P5/ },
    { name: 'fix 1 P1-1: tokens del HTML nuevo con la validación vieja (deja pasar tipos inventados)', file: 'modules/course-workshop/patch/html-edit.js', from: 'const bad = strictTokenProblems(fragment, v.tokenCtx);', to: 'const bad = badTokens(fragment, v.tokenCtx).map((t) => t.token);', expect: /R1 P1-1/ },
    { name: 'fix 1 P2-8: quitar enlace sin mirar enlaces anidados', file: 'modules/course-workshop/patch/html-edit.js', from: 'if (no && no.index < cm.index)', to: 'if (false)', expect: /R1 P2-8/ },
    { name: 'fix 1 P2-6: comparación por firma gruesa (sin ocurrencia)', file: 'modules/course-workshop/patch/engine.js', from: "if (!touched)\n        return `id:${f.id}`;", to: 'return findingSignature(f);', expect: /R1 P2-6/ },
    { name: 'fix 1 P2-1: .ARCHIVE_INDEX sin regenerar', file: 'modules/course-workshop/patch/engine.js', from: 'if (await state.finalize())', to: 'if (false)', expect: /R1 P2-1/ },
    { name: 'remove_activity no sanea los enlaces que la nombran', file: 'modules/course-workshop/patch/op-remove.js', from: 'for (const t of targets) {', to: 'for (const t of []) {', expect: /P7/ },
  ];
  let bad = 0;
  for (const p of patches) {
    const tmp = fs.mkdtempSync(path.join(REPO, '.r107-bite-'));
    try {
      fs.cpSync(DIST, tmp, { recursive: true });
      const f = path.join(tmp, p.file);
      const src = fs.readFileSync(f, 'utf8');
      if (!src.includes(p.from)) { console.log(`❌ bite «${p.name}»: no encontré el texto a romper en ${p.file}`); bad++; continue; }
      fs.writeFileSync(f, src.split(p.from).join(p.to));
      const r = spawnSync(process.execPath, [__filename, '--ci', '--dist', tmp], { encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
      const lines = (r.stdout || '').split('\n').filter((l) => l.startsWith('❌'));
      const bit = r.status !== 0 && p.expect.test(lines.join('\n'));
      console.log(`${bit ? '✅' : '❌'} bite «${p.name}»: --ci ${r.status !== 0 ? 'falla' : 'PASA (no muerde)'} — ${lines.slice(0, 3).join(' | ').slice(0, 300) || (r.stderr || '').slice(0, 300)}`);
      if (!bit) bad++;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log(`\n${bad ? '❌' : '✅'} check-r107-patch --bite: ${patches.length - bad}/${patches.length} rupturas detectadas`);
  process.exit(bad ? 1 : 0);
}

const L = (rel) => { try { return require(path.join(DIST, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿npm run build?): ${e.message}`); process.exit(1); } };
const R = L('modules/course-workshop/mbz-reader.js');
const I = L('modules/course-workshop/identify.js');
const INV = L('modules/course-workshop/inventory.js');
const DG = L('modules/course-workshop/diagnosis/index.js');
const P = L('modules/course-workshop/patch/index.js');
const BC = require(path.join(REPO, 'scripts/r107/build-corpus.js'));
const FX = require(path.join(REPO, 'scripts/r107/lib/r107-fixtures.js'));
const JSZip = require('jszip');

// ── utilidades ─────────────────────────────────────────────────────────────────────────────────────────────────────────
async function inventoryOf(buf, filename = 'x.mbz') {
  const pkg = await R.openMbz(buf);
  const facts = await I.readPackageFacts(pkg, filename);
  return INV.buildInventory(pkg, { family: I.familyOf(facts), builderLine: I.builderLineOf(facts) });
}
const DIAG_CACHE = new Map();
async function diagnose(buf, filename = 'x.mbz', family = null) {
  const k = `${sha1(buf)}|${family}`;
  if (DIAG_CACHE.has(k)) return DIAG_CACHE.get(k);
  const r = await diagnoseRaw(buf, filename, family);
  if (DIAG_CACHE.size > 64) DIAG_CACHE.clear();
  DIAG_CACHE.set(k, r);
  return r;
}
async function diagnoseRaw(buf, filename = 'x.mbz', family = null) {
  const pkg = await R.openMbz(buf);
  const facts = await I.readPackageFacts(pkg, filename);
  return DG.runTechnicalDiagnosis({ pkg, packageBytes: buf, family: family || I.familyOf(facts), builderLine: I.builderLineOf(facts), builderVersion: null });
}
async function entriesOf(buf) {
  const pkg = await R.openMbz(buf);
  return { pkg, map: await pkg.readEntries(pkg.entries.map((e) => e.name)) };
}
const field = (inv, mid, f) => inv.activities.find((a) => a.moduleId === mid).html.find((h) => h.field === f);
async function zipEdit(buf, fn) { const z = await JSZip.loadAsync(buf); await fn(z); return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); }
const blobPath = (h) => `files/${h.slice(0, 2)}/${h}`;
/** Agrega un archivo a files.xml + su blob (para armar fixtures). */
async function addFile(z, { contextId, component, filearea, filename, data, mimetype, fileId }) {
  const h = sha1(data);
  z.file(blobPath(h), data);
  const fx = await z.file('files.xml').async('string');
  const blk = `<file id="${fileId}"><contenthash>${h}</contenthash><contextid>${contextId}</contextid><component>${component}</component><filearea>${filearea}</filearea><itemid>0</itemid><filepath>/</filepath><filename>${filename}</filename><userid>$@NULL@$</userid><filesize>${data.length}</filesize><mimetype>${mimetype}</mimetype><status>0</status><timecreated>1</timecreated><timemodified>1</timemodified><source>$@NULL@$</source><author>$@NULL@$</author><license>$@NULL@$</license><sortorder>0</sortorder><repositorytype>$@NULL@$</repositorytype><repositoryid>$@NULL@$</repositoryid><reference>$@NULL@$</reference></file>`;
  const i = fx.lastIndexOf('</files>');
  z.file('files.xml', fx.slice(0, i) + blk + fx.slice(i));
  return h;
}
async function setIntro(z, dir, html) {
  const p = `activities/${dir}/${dir.split('_')[0]}.xml`;
  const x = await z.file(p).async('string');
  const i = x.indexOf('<intro>'); const j = x.indexOf('</intro>', i);
  z.file(p, x.slice(0, i + 7) + exactEsc(html) + x.slice(j));
}
async function replaceBlobIn(z, filename, fn) {
  const files = await z.file('files.xml').async('string');
  const h = new RegExp(`<contenthash>([0-9a-f]{40})</contenthash>(?:(?!</file>)[\\s\\S])*<filename>${filename.replace(/\./g, '\\.')}</filename>`).exec(files)[1];
  const nb = Buffer.from(fn((await z.file(blobPath(h)).async('nodebuffer')).toString('utf8')));
  const nh = sha1(nb);
  z.remove(blobPath(h)); z.file(blobPath(nh), nb);
  let out = files;
  for (const m of [...files.matchAll(/<file id="\d+">[\s\S]*?<\/file>/g)].reverse()) {
    if (!m[0].includes(`<contenthash>${h}</contenthash>`)) continue;
    const blk = m[0].split(`<contenthash>${h}</contenthash>`).join(`<contenthash>${nh}</contenthash>`).replace(/<filesize>\d+<\/filesize>/, () => `<filesize>${nb.length}</filesize>`);
    out = out.slice(0, m.index) + blk + out.slice(m.index + m[0].length);
  }
  z.file('files.xml', out);
  return nh;
}
/** PNG 2×2 de un color (encoder mínimo, sin dependencias). */
function makePng(r, g, b) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.from([0, r, g, b, r, g, b]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))]);
}
/** tar.gz de un zip (writer propio, independiente del motor). `index`: con un .ARCHIVE_INDEX (viejo, como Moodle). */
async function zipToTarGz(buf, opts = {}) {
  const { map } = await entriesOf(buf);
  const all = new Map(map);
  for (const [k, v] of Object.entries(opts.extra || {})) all.set(k, v);
  const blocks = [];
  const ents = [...all];
  if (opts.index) ents.unshift(['.ARCHIVE_INDEX', Buffer.from(`Moodle archive file index. Count: ${all.size}\n` + [...all].map(([n, d]) => `${n}\tf\t${d.length}\t?\n`).join(''))]);
  const hdr = (name, prefix, size, type) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8'); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116); if (prefix) h.write(prefix, 345, 155, 'utf8');
    h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
    let s = 0; for (let i = 0; i < 512; i++) s += h[i];
    h.write(s.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  for (const [name0, data] of ents) {
    let name = name0; let prefix = '';
    if (Buffer.byteLength(name) > 100) { const i = name.lastIndexOf('/', name.length - 2); prefix = name.slice(0, i); name = name.slice(i + 1); }
    if (Buffer.byteLength(name) > 100) {
      // Un segmento de más de 100 bytes: solo se puede expresar con PAX (lo que el motor NUNCA escribe).
      const body = ` path=${name0}\n`; let len = body.length + 2; while (String(len).length + body.length !== len) len = String(len).length + body.length;
      const rec = Buffer.from(`${len}${body}`);
      blocks.push(hdr('PaxHeader/x', '', rec.length, 'x'), rec, Buffer.alloc((512 - (rec.length % 512)) % 512));
      name = 'pax-largo'; prefix = '';
    }
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8'); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116); if (prefix) h.write(prefix, 345, 155, 'utf8');
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let s = 0; for (let i = 0; i < 512; i++) s += h[i];
    h.write(s.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** Cabeceras de un tar (sin descomprimir nada más): tipo, nombre, prefix, ruta y datos. */
function tarHeaders(tar) {
  const out = [];
  let off = 0;
  const str = (b, o, l) => { const s = b.subarray(o, o + l); const z = s.indexOf(0); return (z < 0 ? s : s.subarray(0, z)).toString('utf8'); };
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(h, 124, 12) || '0', 8);
    const name = str(h, 0, 100); const prefix = str(h, 345, 155);
    out.push({ type: String.fromCharCode(h[156] || 48), name, prefix, path: prefix ? `${prefix}/${name}` : name, size, data: tar.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// ── Invariantes (P3) ───────────────────────────────────────────────────────────────────────────────────────────────────
const SIG = (f) => [f.check, f.code, f.severity, f.scope.activity ? f.scope.activity.dir : `${f.scope.level}:${f.scope.chapterNumber ?? ''}`, f.evidence.questionId ?? '', f.evidence.token ?? '', f.evidence.file ? `${f.evidence.file.component}/${f.evidence.file.filearea}/${f.evidence.file.filename}` : ''].join('|');
function bag(fs) { const m = new Map(); for (const x of fs.filter((y) => y.severity !== 'info')) m.set(SIG(x), (m.get(SIG(x)) ?? 0) + 1); return m; }

async function fileProblems(map) {
  const fx = map.get('files.xml');
  const out = new Set();
  if (!fx) return { problems: out, orphans: new Set() };
  const used = new Set();
  for (const m of fx.toString('utf8').matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g)) {
    const h = /<contenthash>([^<]*)<\/contenthash>/.exec(m[2])?.[1] ?? '';
    const size = Number(/<filesize>(\d+)<\/filesize>/.exec(m[2])?.[1] ?? -1);
    used.add(h);
    if (!/^[0-9a-f]{40}$/.test(h)) continue;
    const b = map.get(blobPath(h));
    if (!b) { out.add(`missing:${m[1]}`); continue; }
    if (sha1(b) !== h) out.add(`sha1:${m[1]}`);
    if (b.length !== size && !(h === 'da39a3ee5e6b4b0d3255bfef95601890afd80709')) out.add(`size:${m[1]}`);
  }
  const orphans = new Set([...map.keys()].filter((n) => /^files\/[0-9a-f]{2}\/[0-9a-f]{40}$/.test(n) && !used.has(n.slice(9))));
  return { problems: out, orphans };
}
function idSets(map) {
  const per = new Map();
  for (const [n, b] of map) {
    if (!/\.xml$/.test(n)) continue;
    for (const m of b.toString('utf8').matchAll(/<(question|answer|question_bank_entry|question_versions|question_instance|question_reference|question_category|file)\s+id="(\d+)"/g)) {
      const k = m[1];
      if (!per.has(k)) per.set(k, []);
      per.get(k).push(Number(m[2]));
    }
  }
  return per;
}
const dups = (xs) => xs.filter((v, i) => xs.indexOf(v) !== i);
function allIdsText(map) { const s = new Set(); for (const [n, b] of map) if (/\.xml$/.test(n)) { for (const m of b.toString('utf8').matchAll(/\bid="(\d+)"|<[a-z_]*id>(\d+)<\//g)) s.add(Number(m[1] ?? m[2])); } return s; }

/** Todas las invariantes de un plan aplicado con éxito. */
async function assertInvariants(orig, res, label, { family = null, filename = 'x.mbz' } = {}) {
  assert(res.ok, `${label}: el plan falló: ${JSON.stringify(res.failure)}`);
  assert(R.detectContainer(res.package) === R.detectContainer(orig), `${label}: cambió el contenedor`);
  const a = await entriesOf(orig);
  const b = await entriesOf(res.package);
  const touched = new Set(res.operations.flatMap((o) => [...o.entriesAdded, ...o.entriesRemoved, ...o.entriesModified]));
  for (const [n, buf] of a.map) {
    if (touched.has(n)) continue;
    assert(b.map.has(n), `${label}: falta ${n} (no tocada)`);
    assert(b.map.get(n).equals(buf), `${label}: ${n} cambió sin estar en el informe`);
  }
  for (const n of b.map.keys()) assert(a.map.has(n) || touched.has(n), `${label}: ${n} apareció sin estar en el informe`);
  for (const n of a.map.keys()) assert(b.map.has(n) || touched.has(n), `${label}: ${n} desapareció sin estar en el informe`);
  for (const o of res.operations) for (const n of o.entriesRemoved) assert(!b.map.has(n) || res.operations.some((p) => p.entriesAdded.includes(n)), `${label}: ${n} figura quitada pero sigue`);
  // zip: lo no tocado conserva los bytes COMPRIMIDOS.
  if (R.detectContainer(orig) === 'zip') {
    const ra = new Map(R.zipRawEntries(orig).map((e) => [e.name, e]));
    const rb = new Map(R.zipRawEntries(res.package).map((e) => [e.name, e]));
    let same = 0;
    for (const [n, e] of ra) {
      if (touched.has(n) || !rb.has(n)) continue;
      const f = rb.get(n);
      assert(e.method === f.method && e.crc32 === f.crc32 && orig.subarray(e.dataStart, e.dataEnd).equals(res.package.subarray(f.dataStart, f.dataEnd)), `${label}: ${n} (no tocada) no conserva sus bytes comprimidos`);
      same++;
    }
    eq(res.preservedEntries, same, `${label}: entradas preservadas`);
  }
  // files.xml ↔ blobs.
  const fa = await fileProblems(a.map);
  const fb = await fileProblems(b.map);
  const newP = [...fb.problems].filter((x) => !fa.problems.has(x));
  assert(!newP.length, `${label}: files.xml/blobs incoherentes: ${newP.slice(0, 5).join(', ')}`);
  const newO = [...fb.orphans].filter((x) => !fa.orphans.has(x));
  assert(!newO.length, `${label}: blobs huérfanos nuevos: ${newO.slice(0, 3).join(', ')}`);
  // Ids únicos (por tipo) y los nuevos no existían en el original.
  const ia = idSets(a.map); const ib = idSets(b.map);
  for (const [k, xs] of ib) { const d = dups(xs).filter((v) => !dups(ia.get(k) ?? []).includes(v)); assert(!d.length, `${label}: id ${k} repetido: ${d.slice(0, 5).join(', ')}`); }
  const origIds = allIdsText(a.map);
  for (const o of res.operations) for (const [k, vs] of Object.entries(o.idsAssigned)) for (const v of vs) assert(!origIds.has(v), `${label}: el id nuevo ${k} ${v} ya existía en el paquete`);
  // Campos tocados: el crudo nuevo se desescapa exactamente a «after».
  const inv = await inventoryOf(res.package);
  const lastOf = new Map();
  for (const o of res.operations) for (const f of o.fields) lastOf.set(`${f.moduleId}|${f.sectionId}|${f.field}`, f);
  for (const f of lastOf.values()) {
    if (f.entry === 'questions.xml' || f.field.startsWith('file:')) continue;
    const act = f.moduleId !== null ? inv.activities.find((x) => x.moduleId === f.moduleId) : null;
    const h = act ? act.html.find((x) => x.field === f.field) : f.sectionId !== null ? inv.sections.find((s) => s.id === f.sectionId)?.html.find((x) => x.field === f.field) : null;
    if (!h) { assert(res.operations.some((p) => p.op === 'remove_activity'), `${label}: el campo ${f.entry} ${f.field} no está en el resultado`); continue; }
    eq(h.html, f.after, `${label}: ${f.entry} ${f.field} ≠ «after» del informe`);
    const raw = b.map.get(h.entry).subarray(h.rawOffset, h.rawOffset + h.rawBytes).toString('utf8');
    eq(sha1(raw), f.afterRawSha1, `${label}: sha1 del crudo`);
    eq(unesc(raw), f.after, `${label}: xmlUnescape(crudo)`);
  }
  // Diagnóstico B3 recalculado acá: ningún error / warning nuevo.
  const fam = family;
  const da = await diagnose(orig, filename, fam);
  const db = await diagnose(res.package, filename, fam || da.family);
  const ba = bag(da.findings); const bb = bag(db.findings);
  const intro = [...bb].filter(([k, n]) => n > (ba.get(k) ?? 0)).map(([k]) => k);
  assert(!intro.length, `${label}: hallazgos nuevos: ${intro.slice(0, 3).join(' ; ')}`);
  return { inv, da, db, a, b };
}
async function applyOk(buf, ops, label, opts = {}) {
  const before = sha1(buf);
  const res = await P.applyPatchPlan({ original: buf, filename: opts.filename ?? 'x.mbz', operations: ops });
  eq(sha1(buf), before, `${label}: el original cambió`);
  const inv = await assertInvariants(buf, res, label, opts);
  return { res, ...inv };
}
async function applyFail(buf, ops, code, label, re = null) {
  const before = sha1(buf);
  const res = await P.applyPatchPlan({ original: buf, filename: 'x.mbz', operations: ops });
  eq(sha1(buf), before, `${label}: el original cambió`);
  assert(!res.ok && res.package === null, `${label}: esperaba falla (${code}), salió bien`);
  assert(res.failure.code === code, `${label}: esperaba ${code}, vino ${res.failure.code}: ${res.failure.message}`);
  if (re) assert(re.test(res.failure.message), `${label}: motivo inesperado: ${res.failure.message}`);
  return res;
}

// ── Hallazgos sembrados → su suggestedFix (P13) ────────────────────────────────────────────────────────────────────────
/** Libro sano de la base → fuente para recomponer: capítulos (título + cuerpo) y portada. */
function libroSource(html) {
  const st = P.libroStructure(html);
  const chapters = st.chapters.map((c) => {
    const head = html.slice(c.headStart, c.headEnd);
    const title = head.replace(/<[^>]+>/g, '').replace(/^\s*Cap[ií]tulo\s+\d+\s*[:—–-]\s*/i, '').trim();
    return { number: c.number, title: unesc(title), html: html.slice(c.headEnd, c.bodyEnd) };
  });
  const first = st.chapters[0];
  const pre = html.slice(0, first.blockStart);
  const headHtml = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(pre)?.[1] ?? '';
  const coverHtml = pre.slice(pre.search(/<body[^>]*>/i)).replace(/^<body[^>]*>/i, '');
  return { chapters, front: { headHtml, coverHtml } };
}
async function libroHtmlOf(buf) {
  const inv = await inventoryOf(buf);
  const a = inv.activities.find((x) => x.kind === 'libro' && x.modname === 'resource');
  const f = a && a.files.find((x) => x.filearea === 'content' && /\.html?$/i.test(x.filename));
  if (!f) return null;
  const { map } = await entriesOf(buf);
  return { a, html: map.get(blobPath(f.contenthash))?.toString('utf8') ?? null };
}
/** Operación RESUELTA desde el suggestedFix de un hallazgo (lo que haría B5 con la fuente / el contenido nuevo). */
async function resolveFix(finding, dmg, base) {
  const fx = finding.suggestedFix;
  assert(fx, `${finding.check}/${finding.code} sin suggestedFix`);
  const p = fx.params;
  const invD = await inventoryOf(dmg);
  if (fx.operation === 'remove_activity') return [{ op: 'remove_activity', moduleId: p.moduleId }];
  if (fx.operation === 'edit_html') {
    const f = field(invD, p.moduleId, p.field);
    if (p.token) return [{ op: 'edit_html', target: { moduleId: p.moduleId, field: p.field }, expectRawSha1: f.rawSha1, change: p.replaceWith ? { kind: 'token', token: p.token, action: 'retarget', to: p.replaceWith } : { kind: 'token', token: p.token, action: 'unlink' } }];
    if (Number.isInteger(p.linkRawByteOffset)) {
      const raw = (await entriesOf(dmg)).map.get(p.entry).subarray(p.fieldRawOffset + p.linkRawByteOffset, p.fieldRawOffset + p.linkRawByteOffset + p.linkRawBytes).toString('utf8');
      return [{ op: 'edit_html', target: { moduleId: p.moduleId, field: p.field }, expectRawSha1: p.fieldRawSha1, change: { kind: 'range', rawByteOffset: p.linkRawByteOffset, rawBytes: p.linkRawBytes, html: unesc(raw).replace(/<[^>]+>/g, '') } }];
    }
    // Contenido nuevo = la fuente (el campo de la base, sin el defecto).
    const invB = await inventoryOf(base);
    const bf = field(invB, p.moduleId, p.field);
    const html = bf && bf.html !== f.html ? bf.html : f.html.replace(/<p>⚠️ Pendiente[\s\S]*?<\/p>/g, '');
    return [{ op: 'edit_html', target: { moduleId: p.moduleId, field: p.field }, expectRawSha1: f.rawSha1, change: { kind: 'replace', html } }];
  }
  if (fx.operation === 'edit_libro_section') {
    const src = await libroHtmlOf(base);
    assert(src && src.html, 'la base no tiene el Libro HTML (fuente)');
    const s = libroSource(src.html);
    return [{ op: 'edit_libro_section', moduleId: p.moduleId, chapters: s.chapters, front: s.front }];
  }
  if (fx.operation === 'exam_question_replace') {
    const invB = await inventoryOf(base);
    const q = invB.activities.find((x) => x.moduleId === p.quizModuleId).exam.questions.find((x) => x.id === p.questionId);
    // La fuente puede traer defectos propios (opciones repetidas): B5 entrega opciones únicas con UNA correcta.
    const seen = new Set();
    let answers = q.answers.map((x) => ({ html: x.html, fraction: (x.fraction ?? 0) >= 0.9999 ? 1 : 0 })).filter((x) => { const k = x.html.replace(/<[^>]+>/g, '').trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
    if (!answers.some((x) => x.fraction === 1)) answers[0].fraction = 1;
    let one = false; answers = answers.map((x) => { if (x.fraction === 1 && one) return { ...x, fraction: 0 }; if (x.fraction === 1) one = true; return x; });
    while (answers.length < 3) answers.push({ html: `Opción distractora ${answers.length}`, fraction: 0 });
    return [{ op: 'exam_question_replace', quizModuleId: p.quizModuleId, questionId: p.questionId, question: { qtype: 'multichoice', text: q.html, answers } }];
  }
  throw new Error(`sin resolución para ${fx.operation}`);
}
/** P13: el dañado vs su base → el hallazgo sembrado → su arreglo → resuelto, sin hallazgos nuevos. */
async function fixSeeded(id, dmg, base, expected) {
  const dd = await diagnose(dmg); const db = await diagnose(base);
  const baseIds = new Set(db.findings.filter((x) => x.severity !== 'info').map((x) => x.id));
  const added = dd.findings.filter((x) => x.severity !== 'info' && !baseIds.has(x.id));
  assert(added.length >= 1, `${id}: el diagnóstico no ve la falla sembrada`);
  const seeded = added.find((x) => x.check === expected.check) ?? added[0];
  const ops = await resolveFix(seeded, dmg, base);
  const { res } = await applyOk(dmg, ops, id);
  const sig = SIG(seeded);
  // Fix round 1 (P2-6): si el arreglo quitó la actividad, el hallazgo figura como «quitado», no como «resuelto».
  const removedAct = ops.some((o) => o.op === 'remove_activity');
  const list = removedAct ? res.diagnosis.removed : res.diagnosis.resolved;
  assert(list.some((x) => x.signature === sig), `${id}: el diagnóstico posterior no da por ${removedAct ? 'quitado' : 'resuelto'} ${sig} (${list.map((x) => x.signature).join(' ; ')})`);
  if (removedAct) assert(!res.diagnosis.resolved.some((x) => x.signature === sig), `${id}: un hallazgo de una actividad quitada no es «resuelto»`);
  return { seeded, ops, res };
}

// ── Fixtures CI ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function ciFixtures() {
  const S = require(path.join(REPO, 'scripts/lib/commercial-simulation'));
  const COURSES = require(path.join(REPO, 'scripts/fixtures/commercial-simulation/courses.json')).courses;
  const out = {};
  for (const id of ['A-S', 'ofimatica', '1x1-sin-examenes']) out[id] = (await S.simulateCourse(DIST, COURSES.find((c) => c.id === id))).built.mbz;
  out.v1 = await FX.miniV1(await FX.audiobookOf(out['A-S']));
  return out;
}

const SPECIAL = `<div style="padding:12px;color:#20261E"><h2>Bienvenida ñandú 🎓 «Pingüino»</h2><p>Precio: $& y $1 y $$ y $\` — O'Brien dijo "hola" & <b>adiós</b> &amp; &lt;ya escapado&gt;</p></div>`;
const MC = (t) => ({ qtype: 'multichoice', text: `<p>${t}</p>`, answers: [{ html: 'Opción correcta', fraction: 1 }, { html: 'Opción distractora uno', fraction: 0 }, { html: 'Opción distractora dos', fraction: 0 }, { html: 'Opción distractora tres', fraction: 0 }] });

async function ciSuite(fx) {
  const AS = fx['A-S'];
  const OF = fx.ofimatica;
  const V1 = fx.v1;
  const invAS = await inventoryOf(AS);
  const invV1 = await inventoryOf(V1);

  await check('P1 catálogo cerrado: plan vacío / operación desconocida / de otra fase → falla tipada; el original no cambia', async () => {
    await applyFail(V1, [], 'invalid_params', 'vacío');
    await applyFail(V1, [{ op: 'edit_xml', entry: 'moodle_backup.xml', xml: '<x/>' }], 'invalid_params', 'edit_xml');
    await applyFail(V1, [{ op: 'regenerate_scorm', moduleId: 912 }], 'invalid_params', 'fase 3');
    await applyFail(Buffer.from('no soy un zip'), [{ op: 'remove_activity', moduleId: 1 }], 'package_unreadable', 'basura');
    // Curso sin exámenes (v3 1×1): edit_html funciona; una operación de examen sobre algo que no es examen → falla tipada.
    const X = fx['1x1-sin-examenes'];
    const lx = (await inventoryOf(X)).activities.find((a) => a.modname === 'label' && a.html[0] && a.html[0].html.length > 40);
    await applyOk(X, [{ op: 'edit_html', target: { moduleId: lx.moduleId, field: 'intro' }, change: { kind: 'replace', html: '<p style="color:#20261E">Texto nuevo — «1×1»</p>' } }], '1x1 edit_html');
    await applyFail(X, [{ op: 'exam_question_add', quizModuleId: lx.moduleId, question: MC('x') }], 'invalid_params', '1x1 sin examen', /no es un examen/);
  });

  await check('P2 edit_html reemplazo completo: xmlEsc EXACTO (& < > ", sin apóstrofes), `$&` `$1` `$$` emoji tildes tal cual', async () => {
    for (const [buf, mid] of [[V1, 901], [AS, 1000]]) {
      const { res, b, inv } = await applyOk(buf, [{ op: 'edit_html', target: { moduleId: mid, field: 'intro' }, change: { kind: 'replace', html: SPECIAL } }], `P2 ${mid}`);
      const h = field(inv, mid, 'intro');
      const raw = b.map.get(h.entry).subarray(h.rawOffset, h.rawOffset + h.rawBytes).toString('utf8');
      eq(raw, exactEsc(SPECIAL), `${mid}: crudo = xmlEsc exacto`);
      assert(raw.includes("O'Brien") && !raw.includes('&#39;') && raw.includes('$&amp; y $1 y $$') && raw.includes('&amp;amp;'), `${mid}: escapes`);
      eq(h.html, SPECIAL, `${mid}: desescapado`);
      eq(res.operations[0].fields[0].before, field(mid === 901 ? invV1 : invAS, mid, 'intro').html, 'before');
    }
    // Un token válido en el HTML nuevo sí se acepta; resumen de sección; capítulo de un book (v3).
    await applyOk(V1, [{ op: 'edit_html', target: { moduleId: 904, field: 'intro' }, change: { kind: 'replace', html: '<p>Guía. <a href="$@RESOURCEVIEWBYID*903@$">Descargar Libro Guía</a></p>' } }], 'token válido');
    await applyOk(V1, [{ op: 'edit_html', target: { sectionId: 12 }, change: { kind: 'replace', html: '<p style="color:#123456">Resumen del capítulo 1 — «nuevo»</p>' } }], 'sección');
    const book = invAS.activities.find((a) => a.modname === 'book');
    const ch = book.html.find((h) => h.field.startsWith('chapter:') && h.html.length > 100);
    await applyOk(AS, [{ op: 'edit_html', target: { moduleId: book.moduleId, field: ch.field }, change: { kind: 'replace', html: ch.html.replace('</p>', () => ' Párrafo editado por el Taller.</p>') } }], 'book');
  });

  await check('P2 edit_html casos malos: token huérfano / de otro tipo / roto / externo, <style>, <script>, @@PLUGINFILE@@ ajeno, rango que corta, campo inexistente, precondición vencida', async () => {
    const T = (html) => [{ op: 'edit_html', target: { moduleId: 901, field: 'intro' }, change: { kind: 'replace', html } }];
    await applyFail(V1, T('<p><a href="$@SCORMVIEWBYID*987654@$">x</a></p>'), 'invalid_content', 'huérfano', /no existe/);
    await applyFail(V1, T('<p><a href="$@QUIZVIEWBYID*901@$">x</a></p>'), 'invalid_content', 'otro tipo', /otro tipo/);
    await applyFail(V1, T('<p><a href="$@QUIZVIEWBYID*930@">x</a></p>'), 'invalid_content', 'roto', /mal formado/);
    await applyFail(V1, T('<p><a href="$@COURSEVIEWBYID*4242@$">x</a></p>'), 'invalid_content', 'externo', /otro curso/);
    await applyFail(V1, T('<style>p{color:red}</style><p>x</p>'), 'invalid_content', 'style', /style/);
    await applyFail(V1, T('<p>x</p><script>alert(1)</script>'), 'invalid_content', 'script', /script/);
    await applyFail(V1, T('<p>x<style>p{}</p>'), 'invalid_content', 'style sin cerrar');
    await applyFail(V1, T('<p><img src="@@PLUGINFILE@@/otro.png"></p>'), 'invalid_content', 'pluginfile', /otro\.png/);
    await applyFail(V1, [{ op: 'edit_html', target: { moduleId: 901, field: 'content' }, change: { kind: 'replace', html: '<p>x</p>' } }], 'target_not_found', 'campo');
    await applyFail(V1, [{ op: 'edit_html', target: { moduleId: 901, field: 'intro' }, expectRawSha1: '0'.repeat(40), change: { kind: 'replace', html: '<p>x</p>' } }], 'stale_target', 'precondición');
    const raw = field(invV1, 901, 'intro');
    const rawTxt = (await entriesOf(V1)).map.get(raw.entry).subarray(raw.rawOffset, raw.rawOffset + raw.rawBytes).toString('utf8');
    const amp = Buffer.byteLength(rawTxt.slice(0, rawTxt.indexOf('&lt;') + 2));
    await applyFail(V1, [{ op: 'edit_html', target: { moduleId: 901, field: 'intro' }, change: { kind: 'range', rawByteOffset: amp, rawBytes: 4, html: 'x' } }], 'invalid_params', 'rango en entidad', /entidad/);
    const ny = await zipEdit(V1, (z) => setIntro(z, 'label_901', '<p>Ñandú</p>'));
    const nyRaw = exactEsc('<p>Ñandú</p>');
    await applyFail(ny, [{ op: 'edit_html', target: { moduleId: 901, field: 'intro' }, change: { kind: 'range', rawByteOffset: Buffer.byteLength(nyRaw.slice(0, nyRaw.indexOf('Ñ'))) + 1, rawBytes: 1, html: 'x' } }], 'invalid_params', 'rango en UTF-8', /UTF-8/);
  });

  await check('P2 edit_html por rango (dead_link con «á» antes: bytes ≠ caracteres) y por token (quitar enlace / cambiar destino)', async () => {
    const dl = await zipEdit(V1, async (z) => setIntro(z, 'label_901', '<p style="color:#000">Bienvenidos al curso. á <a href="#">Ir al módulo</a> <a href="$@RESOURCEVIEWBYID*903@$">Abrir el Libro Guía</a></p>'));
    const f = (await diagnose(dl)).findings.find((x) => x.code === 'dead_link');
    assert(f && Number.isInteger(f.suggestedFix.params.linkRawByteOffset), 'el diagnóstico da el dead_link con bytes');
    const [op] = await resolveFix(f, dl, dl);
    const { res, inv } = await applyOk(dl, [op], 'dead_link');
    eq(field(inv, 901, 'intro').html, '<p style="color:#000">Bienvenidos al curso. á Ir al módulo <a href="$@RESOURCEVIEWBYID*903@$">Abrir el Libro Guía</a></p>', 'enlace muerto → texto');
    assert(res.diagnosis.resolved.some((x) => /dead_link/.test(x.signature)), 'dead_link resuelto');
    const r2 = await applyOk(V1, [{ op: 'edit_html', target: { moduleId: 911, field: 'intro' }, change: { kind: 'token', token: '$@SCORMVIEWBYID*912@$', action: 'unlink' } }], 'unlink');
    eq(field(r2.inv, 911, 'intro').html, '<p>Video del capítulo 1. Practicar</p>', 'unlink');
    const r3 = await applyOk(V1, [{ op: 'edit_html', target: { moduleId: 911, field: 'intro' }, change: { kind: 'token', token: '$@SCORMVIEWBYID*912@$', action: 'retarget', to: '$@SCORMVIEWBYID*922@$' } }], 'retarget');
    assert(field(r3.inv, 911, 'intro').html.includes('$@SCORMVIEWBYID*922@$'), 'retarget');
    await applyFail(V1, [{ op: 'edit_html', target: { moduleId: 911, field: 'intro' }, change: { kind: 'token', token: '$@SCORMVIEWBYID*912@$', action: 'retarget', to: '$@SCORMVIEWBYID*930@$' } }], 'invalid_content', 'retarget a otro tipo');
  });

  // P4 Libro Guía V1.
  const LIBRO_PAGES = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Libro</title><style>.page{padding:1cm}</style></head><body>'
    + '<div class="page"><div class="cover"><div class="cv-title">Curso V1</div><img src="data:image/png;base64,LOGO" alt="Logo"></div><div class="toc-w"><div class="toc-h">Tabla de Contenido</div><div class="te tc"><span class="tt">Capítulo 1: Primero</span></div><div class="te tc"><span class="tt">Capítulo 2: Segundo</span></div></div></div>'
    + '<div class="page"><h1>Módulo 1 — Bases</h1><p>Presentación del módulo.</p></div>'
    + '<div class="page"><h1>Capítulo 1: Primero</h1><p>Contenido del primero.</p><div class="bx-caso"><div class="bx-caso-t">Caso</div><p>Un caso.</p></div></div>'
    + '<div class="page"><h1>Capítulo 2: Segundo</h1><h2>Sección</h2><p>Contenido del segundo.</p></div>'
    + '<div class="page"><h1>Recursos y Bibliografía</h1><p>Referencias.</p></div></body></html>';
  await check('P4 edit_libro_section V1 intacto: cuerpo + título; con páginas <div class="page">; capítulo faltante agregado; cierra en </html>', async () => {
    const { res, b } = await applyOk(V1, [{ op: 'edit_libro_section', moduleId: 903, chapters: [{ number: 2, html: '<p>Nuevo cuerpo del 2 — «ñ» $& O\'Brien</p>', title: 'Segundo revisado' }] }], 'libro simple');
    const fc = res.operations[0].files;
    assert(fc.length === 1 && fc[0].after.contenthash !== fc[0].before.contenthash, 'files.xml con el hash nuevo');
    const nb = b.map.get(blobPath(fc[0].after.contenthash)).toString('utf8');
    eq(sha1(nb), fc[0].after.contenthash, 'sha1 del blob nuevo'); eq(Buffer.byteLength(nb), fc[0].after.filesize, 'tamaño');
    assert(/<\/html>$/.test(nb) && nb.includes('<h1>Capítulo 2: Segundo revisado</h1><p>Nuevo cuerpo del 2 — «ñ» $& O\'Brien</p></body>') && nb.includes('<h1>Capítulo 1: Primero</h1><p>Contenido del primero.</p>'), 'libro recompuesto');
    assert(!b.map.has(blobPath(fc[0].before.contenthash)), 'el blob viejo (ya sin uso) se quitó');
    // Con páginas, blob COMPARTIDO por dos entradas de files.xml.
    const pages = await zipEdit(V1, async (z) => {
      await replaceBlobIn(z, 'libro_guia_completo.html', () => LIBRO_PAGES);
      // Segunda entrada de files.xml con el MISMO blob (otro archivo del recurso del Libro).
      await addFile(z, { contextId: 103, component: 'mod_resource', filearea: 'content', filename: 'libro_copia.html', data: Buffer.from(LIBRO_PAGES), mimetype: 'text/html', fileId: 77 });
    });
    const r2 = await applyOk(pages, [{ op: 'edit_libro_section', moduleId: 903, chapters: [{ number: 1, html: '<p>Primero reescrito.</p><div class="bx-act"><p>Actividad</p></div>' }] }], 'libro con páginas');
    eq(r2.res.operations[0].files.length, 2, 'las DOS entradas de files.xml que usaban el blob');
    const nb2 = r2.b.map.get(blobPath(r2.res.operations[0].files[0].after.contenthash)).toString('utf8');
    assert(nb2.includes('<div class="page"><h1>Capítulo 1: Primero</h1><p>Primero reescrito.</p><div class="bx-act"><p>Actividad</p></div></div><div class="page"><h1>Capítulo 2: Segundo</h1>') && nb2.includes('<h1>Módulo 1 — Bases</h1>') && nb2.includes('<h1>Recursos y Bibliografía</h1>') && /<\/html>$/.test(nb2), 'páginas intactas salvo el cuerpo del 1');
    // Capítulo faltante (T07 libro_missing_chapters) → agregado.
    const miss = await zipEdit(V1, (z) => replaceBlobIn(z, 'libro_guia_completo.html', (h) => h.replace('<h1>Capítulo 2: Segundo</h1><p>Contenido del segundo.</p>', '')));
    const fm = (await diagnose(miss)).findings.find((x) => x.code === 'libro_missing_chapters');
    assert(fm && fm.suggestedFix.params.chapters[0] === 2, 'T07 libro_missing_chapters con su arreglo');
    const r3 = await applyOk(miss, [{ op: 'edit_libro_section', moduleId: 903, chapters: [{ number: 2, html: '<p>Contenido del segundo.</p>', title: 'Segundo' }] }], 'capítulo faltante');
    assert(r3.res.diagnosis.resolved.some((x) => /libro_missing_chapters/.test(x.signature)), 'resuelto');
  });

  await check('P4 edit_libro_section: Libro CORTADO recompuesto desde la fuente (portada + capítulos), sin fuente → falla; PDF v3 / book → no disponible; casos malos', async () => {
    const cut = await zipEdit(V1, (z) => replaceBlobIn(z, 'libro_guia_completo.html', () => LIBRO_PAGES.slice(0, LIBRO_PAGES.indexOf('Contenido del segundo') + 5)));
    const s = libroSource(LIBRO_PAGES);
    const { b, res } = await applyOk(cut, [{ op: 'edit_libro_section', moduleId: 903, chapters: s.chapters.filter((c) => c.number === 2) }], 'cortado sin portada nueva');
    const nb = b.map.get(blobPath(res.operations[0].files[0].after.contenthash)).toString('utf8');
    assert(nb.startsWith(LIBRO_PAGES.slice(0, LIBRO_PAGES.indexOf('<div class="page"><h1>Capítulo 2'))) && /<h1>Capítulo 2: Segundo<\/h1><h2>Sección<\/h2><p>Contenido del segundo\.<\/p><\/div><\/body><\/html>$/.test(nb), `recompuesto: …${nb.slice(-160)}`);
    assert(res.operations[0].misalignment.some((m) => /bibliograf/i.test(m)), 'avisa lo que se perdió tras el corte');
    await applyFail(cut, [{ op: 'edit_libro_section', moduleId: 903, chapters: [{ number: 1, html: '<p>x</p>' }] }], 'invalid_params', 'sin el capítulo cortado', /faltan los capítulos 2/);
    const head = await zipEdit(V1, (z) => replaceBlobIn(z, 'libro_guia_completo.html', () => LIBRO_PAGES.slice(0, 60)));
    await applyFail(head, [{ op: 'edit_libro_section', moduleId: 903, chapters: s.chapters }], 'invalid_params', 'cortado en la portada sin front', /portada/);
    await applyOk(head, [{ op: 'edit_libro_section', moduleId: 903, chapters: s.chapters, front: s.front }], 'cortado en la portada con front');
    const pdf = invAS.activities.find((a) => a.kind === 'libro' && a.modname === 'resource');
    await applyFail(AS, [{ op: 'edit_libro_section', moduleId: pdf.moduleId, chapters: [{ number: 1, html: '<p>x</p>' }] }], 'unavailable', 'PDF v3', /PDF/);
    const bk = invAS.activities.find((a) => a.modname === 'book');
    await applyFail(AS, [{ op: 'edit_libro_section', moduleId: bk.moduleId, chapters: [{ number: 1, html: '<p>x</p>' }] }], 'unavailable', 'book v3');
    await applyFail(V1, [{ op: 'edit_libro_section', moduleId: 903, chapters: [{ number: 1, html: '<p>x $@SCORMVIEWBYID*912@$</p>' }] }], 'invalid_content', 'token en el Libro');
    await applyFail(V1, [{ op: 'edit_libro_section', moduleId: 903, chapters: [{ number: 1, html: '<script>x</script><p>y</p>' }] }], 'invalid_content', 'script en el Libro');
    await applyFail(V1, [{ op: 'edit_libro_section', moduleId: 901, chapters: [{ number: 1, html: '<p>y</p>' }] }], 'invalid_params', 'no es el Libro');
  });

  await check('P5 exámenes v3 con ranuras ALEATORIAS: reemplazar / agregar al banco / quitar hasta el mínimo de la categoría; casos malos', async () => {
    const quiz = invAS.activities.find((a) => a.moduleId === 1049);
    const q0 = quiz.exam.questions[0];
    const { inv } = await applyOk(AS, [{ op: 'exam_question_replace', quizModuleId: 1049, questionId: q0.id, question: MC('¿Qué control se revisa antes del turno, según la regla «1.1»?') }], 'replace aleatoria');
    const nq = inv.activities.find((a) => a.moduleId === 1049).exam.questions.find((x) => x.id === q0.id);
    assert(nq.html.includes('regla «1.1»') && nq.answers.filter((x) => x.fraction === 1).length === 1, 'pregunta reemplazada en su lugar (mismo id)');
    const cat = q0.categoryId;
    const add = await applyOk(AS, [{ op: 'exam_question_add', quizModuleId: 1049, categoryId: cat, question: { qtype: 'truefalse', text: '<p>El punto de equilibrio iguala ingresos y costos.</p>', correct: true } }], 'add aleatoria');
    const qz = (b) => b.map.get('activities/quiz_1049/quiz.xml').toString('utf8');
    eq(qz(add.b), qz(add.a), 'las ranuras aleatorias no cambian');
    eq(add.inv.activities.find((a) => a.moduleId === 1049).exam.questions.length, quiz.exam.questions.length + 1, 'una más en el banco');
    await applyFail(AS, [{ op: 'exam_question_add', quizModuleId: 1049, question: MC('x') }], 'invalid_params', 'sin categoría', /categoría/);
    const inCat = quiz.exam.questions.filter((x) => x.categoryId === cat);
    const slotsOfCat = ((await entriesOf(AS)).map.get('activities/quiz_1049/quiz.xml').toString('utf8').match(new RegExp(`"questioncategoryid":${cat}\\b`, 'g')) || []).length;
    const removable = inCat.length - slotsOfCat;
    assert(removable >= 1, `la categoría ${cat} tiene ${inCat.length} preguntas para ${slotsOfCat} ranuras`);
    const ops = inCat.slice(0, removable).map((x) => ({ op: 'exam_question_remove', quizModuleId: 1049, questionId: x.id }));
    await applyOk(AS, ops, `quitar ${removable} (queda el mínimo)`);
    await applyFail(AS, [...ops, { op: 'exam_question_remove', quizModuleId: 1049, questionId: inCat[removable].id }], 'invariant', 'por debajo del mínimo', /mínimo/);
    const bad = (question) => applyFail(AS, [{ op: 'exam_question_replace', quizModuleId: 1049, questionId: q0.id, question }], 'invalid_content', JSON.stringify(question).slice(0, 60));
    await bad({ ...MC('dos correctas'), answers: [{ html: 'A', fraction: 1 }, { html: 'B', fraction: 1 }, { html: 'C', fraction: 0 }] });
    await bad({ ...MC('ninguna correcta'), answers: [{ html: 'A', fraction: 0 }, { html: 'B', fraction: 0 }] });
    await bad({ ...MC('todas'), answers: [{ html: 'A', fraction: 1 }, { html: 'Todas las anteriores', fraction: 0 }, { html: 'C', fraction: 0 }] });
    await bad({ ...MC('fracción'), answers: [{ html: 'A', fraction: 1 }, { html: 'B', fraction: 0.37 }] });
    await bad({ ...MC('repetida'), answers: [{ html: 'Á', fraction: 1 }, { html: 'a', fraction: 0 }] });
    await bad({ ...MC('una sola'), answers: [{ html: 'A', fraction: 1 }] });
    await bad({ ...MC('<p>token</p>'), text: '<p>Ver <a href="$@SCORMVIEWBYID*999999@$">x</a></p>' });
    await applyOk(AS, [{ op: 'exam_question_replace', quizModuleId: 1049, questionId: q0.id, question: { ...MC('varias respuestas'), single: false, answers: [{ html: 'A uno', fraction: 0.5 }, { html: 'B dos', fraction: 0.5 }, { html: 'C tres', fraction: -0.5 }, { html: 'D cuatro', fraction: 0 }] } }], 'varias respuestas que suman 1');
    await applyFail(AS, [{ op: 'exam_question_replace', quizModuleId: 1089, questionId: q0.id, question: MC('x') }], 'target_not_found', 'pregunta de otro examen');
  });

  await check('P5 ranuras aleatorias con el filtercondition de Moodle 4.3+ ({"filter":{"category":{"values":[N]…}}}): agregar / quitar hasta el mínimo / por debajo → falla', async () => {
    const m45 = await zipEdit(AS, async (z) => {
      for (const n of Object.keys(z.files).filter((x) => /^activities\/quiz_\d+\/quiz\.xml$/.test(x))) {
        const x = await z.file(n).async('string');
        z.file(n, x.replace(/<filtercondition>\{"questioncategoryid":(\d+),"includingsubcategories":0\}<\/filtercondition>/g, (_m, c) => `<filtercondition>{"filter":{"category":{"jointype":1,"values":[${c}],"filteroptions":{"includesubcategories":false}}}}</filtercondition>`));
      }
    });
    assert(/"filteroptions"/.test((await entriesOf(m45)).map.get('activities/quiz_1049/quiz.xml').toString('utf8')), 'fixture 4.3+');
    const quiz = invAS.activities.find((a) => a.moduleId === 1049);
    const cat = quiz.exam.questions[0].categoryId;
    const inCat = quiz.exam.questions.filter((x) => x.categoryId === cat);
    const slots = ((await entriesOf(m45)).map.get('activities/quiz_1049/quiz.xml').toString('utf8').match(new RegExp(`"values":\\[${cat}\\]`, 'g')) || []).length;
    await applyOk(m45, [{ op: 'exam_question_add', quizModuleId: 1049, categoryId: cat, question: MC('Pregunta 4.5') }], '4.5 add');
    const ops = inCat.slice(0, inCat.length - slots).map((x) => ({ op: 'exam_question_remove', quizModuleId: 1049, questionId: x.id }));
    await applyOk(m45, ops, '4.5 quitar hasta el mínimo');
    await applyFail(m45, [...ops, { op: 'exam_question_remove', quizModuleId: 1049, questionId: inCat[inCat.length - slots].id }], 'invariant', '4.5 por debajo del mínimo', /mínimo/);
  });

  await check('P5 exámenes con ranuras FIJAS (v3 ofimática) y Moodle 3.x (V1 mínimo): ranura nueva / quitada, sumgrades = Σ maxmark, grade igual, mínimo 1', async () => {
    const invOF = await inventoryOf(OF);
    const quiz = invOF.activities.find((a) => a.modname === 'quiz' && a.exam.slots === 25);
    const qx = (b) => b.map.get(`${quiz.dir}/quiz.xml`).toString('utf8');
    const sums = (x) => ({ sum: Number(/<sumgrades>([^<]*)/.exec(x)[1]), grade: Number(/<grade>([^<]*)/.exec(x)[1]), marks: [...x.matchAll(/<maxmark>([^<]*)/g)].map((m) => Number(m[1])), slots: [...x.matchAll(/<slot>(\d+)<\/slot>/g)].map((m) => Number(m[1])) });
    const add = await applyOk(OF, [{ op: 'exam_question_add', quizModuleId: quiz.moduleId, question: MC('Pregunta nueva de hoja de cálculo') }], 'add fija');
    const s1 = sums(qx(add.b));
    eq(s1.slots, Array.from({ length: 26 }, (_, i) => i + 1), 'ranuras 1..26');
    eq(Math.round(s1.sum * 1e5), Math.round(s1.marks.reduce((x, y) => x + y, 0) * 1e5), 'sumgrades = Σ maxmark');
    eq(s1.grade, sums(qx(add.a)).grade, 'grade igual');
    assert(add.res.operations[0].idsAssigned.question_instance && add.res.operations[0].idsAssigned.question_reference, 'ids de ranura nuevos');
    const victim = quiz.exam.questions[3];
    const rem = await applyOk(OF, [{ op: 'exam_question_remove', quizModuleId: quiz.moduleId, questionId: victim.id }], 'remove fija');
    const s2 = sums(qx(rem.b));
    eq(s2.slots, Array.from({ length: 24 }, (_, i) => i + 1), 'ranuras renumeradas 1..24');
    eq(Math.round(s2.sum * 1e5), Math.round(s2.marks.reduce((x, y) => x + y, 0) * 1e5), 'sumgrades = Σ maxmark');
    assert(!rem.inv.activities.find((a) => a.moduleId === quiz.moduleId).exam.questions.some((x) => x.id === victim.id), 'fuera del banco');
    // V1 mínimo (3.x): 2 ranuras → quitar una sí, las dos no; agregar y reemplazar.
    await applyOk(V1, [{ op: 'exam_question_replace', quizModuleId: 930, questionId: 5002, question: { qtype: 'truefalse', text: '<p>El agua hierve a 100 °C al nivel del mar.</p>', correct: true } }], 'V1 replace tf');
    const a1 = await applyOk(V1, [{ op: 'exam_question_add', quizModuleId: 930, question: MC('¿Cuánto es 3 + 3?') }], 'V1 add');
    eq(a1.inv.activities.find((a) => a.moduleId === 930).exam.slots, 3, 'V1: 3 ranuras');
    await applyOk(V1, [{ op: 'exam_question_remove', quizModuleId: 930, questionId: 5001 }], 'V1 remove');
    await applyFail(V1, [{ op: 'exam_question_remove', quizModuleId: 930, questionId: 5001 }, { op: 'exam_question_remove', quizModuleId: 930, questionId: 5002 }], 'invariant', 'V1 sin preguntas', /mínimo/);
  });

  // P6 marca.
  const LOGO = makePng(200, 30, 30);
  const LOGO2 = makePng(10, 120, 110);
  const b64 = (b) => b.toString('base64');
  const branded = await zipEdit(V1, async (z) => {
    await setIntro(z, 'label_901', `<p style="color:#B45309">Bienvenidos. El color #B45309 se ve en el texto.</p><img src="data:image/png;base64,${b64(LOGO)}" style="max-height:80px;border:1px solid #b45309">`);
    await setIntro(z, 'label_904', '<p>Tu guía completa del curso. <a href="$@RESOURCEVIEWBYID*903@$">Descargar Libro Guía</a></p><img src="@@PLUGINFILE@@/logo.png" alt="logo">');
    await addFile(z, { contextId: 104, component: 'mod_label', filearea: 'intro', filename: 'logo.png', data: LOGO, mimetype: 'image/png', fileId: 90 });
    await replaceBlobIn(z, 'libro_guia_completo.html', (h) => h.replace('<h1>Libro Guía</h1>', () => `<h1>Libro Guía</h1><img src="data:image/png;base64,${b64(LOGO)}" alt="Logo">`));
    await replaceBlobIn(z, 'index.html', (h) => h.replace('window.salas=[1,2,3];', () => 'window.salas=[1,2,3];var c="#B45309";'));
  });
  await check('P6 brand_replace: logo en blob + data URI en HTML + portada del Libro; colores SOLO en style="" (no texto visible, no JS del SCORM)', async () => {
    const imgs = P.listBrandImages(await inventoryOf(branded));
    assert(imgs[0].sha1 === sha1(LOGO) && imgs[0].places.length >= 2, `listBrandImages: ${JSON.stringify(imgs.slice(0, 2))}`);
    const { res, inv, b } = await applyOk(branded, [{ op: 'brand_replace', logo: { currentSha1: sha1(LOGO), image: { base64: b64(LOGO2), mimetype: 'image/png' } }, colors: { '#B45309': '#0F766E' } }], 'marca');
    const h901 = field(inv, 901, 'intro').html;
    eq(h901, `<p style="color:#0F766E">Bienvenidos. El color #B45309 se ve en el texto.</p><img src="data:image/png;base64,${b64(LOGO2)}" style="max-height:80px;border:1px solid #0F766E">`, 'label: style y logo cambiados, texto visible intacto');
    assert(b.map.has(blobPath(sha1(LOGO2))) && !b.map.has(blobPath(sha1(LOGO))), 'blob del logo reemplazado');
    const fxml = b.map.get('files.xml').toString('utf8');
    assert(fxml.includes(`<contenthash>${sha1(LOGO2)}</contenthash>`) && fxml.includes(`<filesize>${LOGO2.length}</filesize>`), 'files.xml al día');
    const lib = (await libroHtmlOf(res.package)).html;
    assert(lib.includes(b64(LOGO2)) && !lib.includes(b64(LOGO)), 'portada del Libro con el logo nuevo');
    const scormIdx = [...b.map].filter(([n, x]) => /^files\//.test(n) && x.toString('utf8').includes('var c="#B45309"'));
    eq(scormIdx.length, 1, 'el JS del SCORM conserva su color');
  });
  await check('P6 brand_replace casos malos: color que no aparece, logo que no está, tipo que no coincide, sin nada que cambiar', async () => {
    await applyFail(branded, [{ op: 'brand_replace', colors: { '#ABCDEF': '#000000' } }], 'target_not_found', 'color ausente');
    await applyFail(branded, [{ op: 'brand_replace', logo: { currentSha1: 'a'.repeat(40), image: { base64: b64(LOGO2), mimetype: 'image/png' } } }], 'target_not_found', 'logo ausente');
    await applyFail(branded, [{ op: 'brand_replace', logo: { currentSha1: sha1(LOGO), image: { base64: b64(LOGO2), mimetype: 'image/jpeg' } } }], 'invalid_content', 'mime falso');
    await applyFail(branded, [{ op: 'brand_replace', colors: { 'rojo': '#000' } }], 'invalid_params', 'color inválido');
    await applyFail(branded, [{ op: 'brand_replace' }], 'invalid_params', 'vacío');
  });

  await check('P7 remove_activity: carpeta, moodle_backup (activity + settings), sequence, files.xml + blobs huérfanos (el compartido se conserva), enlaces saneados', async () => {
    // Un blob del SCORM 912 compartido con otra entrada (en la etiqueta 904): se conserva.
    const shared = await zipEdit(V1, async (z) => {
      const fx2 = await z.file('files.xml').async('string');
      const blk = /<file id="\d+"><contenthash>([0-9a-f]{40})<\/contenthash><contextid>(\d+)<\/contextid><component>mod_scorm<\/component><filearea>content<\/filearea><itemid>0<\/itemid><filepath>\/<\/filepath><filename>imsmanifest\.xml<\/filename>/.exec(fx2);
      const data = await z.file(blobPath(blk[1])).async('nodebuffer');
      await addFile(z, { contextId: 104, component: 'mod_label', filearea: 'intro', filename: 'copia.xml', data, mimetype: 'application/xml', fileId: 91 });
      const mb = await z.file('moodle_backup.xml').async('string');
      const i = mb.indexOf('</contents>');
      z.file('moodle_backup.xml', mb.slice(0, i) + '</contents><settings><setting><level>activity</level><activity>scorm_912</activity><name>scorm_912_included</name><value>1</value></setting><setting><level>activity</level><activity>scorm_912</activity><name>scorm_912_userinfo</name><value>0</value></setting><setting><level>activity</level><activity>label_910</activity><name>label_910_included</name><value>1</value></setting></settings>' + mb.slice(i + '</contents>'.length));
    });
    const { res, b, inv } = await applyOk(shared, [{ op: 'remove_activity', moduleId: 912 }], 'quitar SCORM');
    assert(![...b.map.keys()].some((n) => n.startsWith('activities/scorm_912/')), 'carpeta fuera');
    const mb = b.map.get('moodle_backup.xml').toString('utf8');
    assert(!/<moduleid>912<\/moduleid>/.test(mb) && !mb.includes('scorm_912') && mb.includes('label_910_included'), 'activity + settings fuera (los demás quedan)');
    assert(!/(^|,)912(,|$)/.test(/<sequence>([^<]*)/.exec(b.map.get('sections/section_12/section.xml').toString('utf8'))[1]), 'sequence');
    const fx2 = b.map.get('files.xml').toString('utf8');
    const ctx912 = invV1.activities.find((a) => a.moduleId === 912).contextId;
    assert(!fx2.includes(`<contextid>${ctx912}</contextid>`), 'ningún archivo del contexto del SCORM queda en files.xml');
    const copia = /<file id="91">[\s\S]*?<contenthash>([0-9a-f]{40})/.exec(fx2)[1];
    assert(b.map.has(blobPath(copia)), 'el blob compartido se conserva');
    eq(field(inv, 911, 'intro').html, '<p>Video del capítulo 1. Practicar</p>', 'el enlace del video al juego quitado (texto conservado)');
    assert(res.operations[0].entriesRemoved.some((n) => /^files\//.test(n)), 'blobs huérfanos fuera');
    // Un examen (no el último) se lleva su banco.
    const invOF = await inventoryOf(OF);
    const qz = invOF.activities.find((a) => a.modname === 'quiz' && a.kind === 'exam');
    // v3: la página de respuestas explicadas tiene una condición de acceso sobre el examen → quitar el examen solo falla…
    const answers = invOF.activities.find((a) => a.kind === 'exam_answers' && a.unit === qz.unit);
    await applyFail(OF, [{ op: 'remove_activity', moduleId: qz.moduleId }], 'invariant', 'examen con condición de acceso', /condición de acceso/);
    // …y quitando antes esa página (plan de 2: la segunda ve lo que dejó la primera) el examen sale con su banco.
    const r2 = await applyOk(OF, [{ op: 'remove_activity', moduleId: answers.moduleId }, { op: 'remove_activity', moduleId: qz.moduleId }], 'quitar respuestas + examen');
    assert(!r2.b.map.get('questions.xml').toString('utf8').includes(`<contextid>${qz.contextId}</contextid>`), 'banco del examen fuera');
    assert(r2.res.operations[1].notes.some((n) => /categoría\(s\) del banco/.test(n)), 'informe: banco quitado');
  });
  await check('P7 remove_activity casos malos: último examen, sección vacía, token en un iframe, actividad inexistente', async () => {
    await applyFail(V1, [{ op: 'remove_activity', moduleId: 930 }], 'invariant', 'último examen', /último examen/);
    await applyFail(V1, [{ op: 'remove_activity', moduleId: 901 }], 'invariant', 'sección vacía', /sección/);
    const ifr = await zipEdit(V1, (z) => setIntro(z, 'label_910', '<p>MÓDULO 1 · CAPÍTULO 1</p><p>📺 Instrucciones: mira el video.</p><iframe src="$@HVPEMBEDBYID*911@$"></iframe>'));
    await applyFail(ifr, [{ op: 'remove_activity', moduleId: 911 }], 'unsupported', 'iframe', /iframe/);
    await applyFail(V1, [{ op: 'remove_activity', moduleId: 4242 }], 'target_not_found', 'inexistente');
  });

  await check('P8 todo o nada · P9 campo que cambió antes en el plan → stale · P10 un hallazgo nuevo → el plan falla', async () => {
    const r = await applyFail(V1, [{ op: 'edit_html', target: { moduleId: 901, field: 'intro' }, change: { kind: 'replace', html: '<p>ok</p>' } }, { op: 'remove_activity', moduleId: 930 }], 'invariant', 'P8');
    eq([r.failure.opIndex, r.failure.op, r.package], [1, 'remove_activity', null], 'P8: falla con la operación, sin paquete');
    const f = field(invV1, 901, 'intro');
    await applyFail(V1, [{ op: 'edit_html', target: { moduleId: 901, field: 'intro' }, change: { kind: 'replace', html: '<p>uno</p>' } }, { op: 'edit_html', target: { moduleId: 901, field: 'intro' }, expectRawSha1: f.rawSha1, change: { kind: 'range', rawByteOffset: 0, rawBytes: 3, html: '<p>' } }], 'stale_target', 'P9');
    const r10 = await applyFail(V1, [{ op: 'edit_html', target: { moduleId: 901, field: 'intro' }, change: { kind: 'replace', html: '<p>Bienvenidos. <a href="#">Ir</a></p>' } }], 'new_findings', 'P10', /hallazgo/);
    assert(r10.diagnosis && r10.diagnosis.introduced.some((x) => /dead_link/.test(x.signature)), 'P10: dice cuál');
  });

  await check('P11 tar.gz → tar.gz (contenido idéntico de lo no tocado) · P12 determinismo (mismo plan → mismos bytes)', async () => {
    const tgz = await zipToTarGz(V1);
    const { res } = await applyOk(tgz, [{ op: 'edit_html', target: { moduleId: 901, field: 'intro' }, change: { kind: 'replace', html: SPECIAL } }, { op: 'exam_question_add', quizModuleId: 930, question: MC('¿2 × 3?') }], 'tar.gz');
    eq(res.container, 'tar.gz', 'contenedor');
    const ops = [{ op: 'edit_html', target: { moduleId: 1000, field: 'intro' }, change: { kind: 'replace', html: SPECIAL } }, { op: 'brand_replace', colors: { '#B45309': '#0F766E' } }, { op: 'remove_activity', moduleId: 1051 }];
    const x = await P.applyPatchPlan({ original: AS, operations: ops });
    const y = await P.applyPatchPlan({ original: AS, operations: ops });
    assert(x.ok && y.ok && x.sha1 === y.sha1, 'mismos bytes');
  });

  await check('P13 hallazgos SEMBRADOS de B0 → su suggestedFix → resueltos, sin hallazgos nuevos (v3 A-S y V1 mínimo)', async () => {
    const plan = [['A-S', AS, ['orphan-token', 'pending-placeholder', 'empty-label', 'exam-no-correct', 'wrong-type-token']], ['v1', V1, ['orphan-token', 'pending-placeholder', 'exam-no-correct', 'libro-html-truncated']]];
    const lines = [];
    for (const [id, base, muts] of plan) {
      for (const m of muts) {
        const z = await JSZip.loadAsync(base);
        const exp = await BC.MUTATIONS[m](z);
        const dmg = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
        const r = await fixSeeded(`${id}~${m}`, dmg, base, exp);
        lines.push(`${id}~${m}: ${r.seeded.check}/${r.seeded.code} → ${r.ops.map((o) => o.op + (o.change ? `:${o.change.kind}${o.change.action ? `/${o.change.action}` : ''}` : '')).join(', ')} → resuelto`);
      }
    }
    console.log(`   ${lines.join('\n   ')}`);
  });

  // ── Fix round 1 ─────────────────────────────────────────────────────────────────────────────────────────────────────
  await check('R1 P1-1 tokens inventados en HTML nuevo (tipo desconocido / sin id) → falla, en campos y en preguntas; WWWROOT sí', async () => {
    for (const tok of ['$@ACTIVITYVIEWBYID*999@$', '$@MODVIEWBYID*5@$', '$@FOOBAR*77@$', '$@SCORMVIEWBYID@$', '$@BOOKVIEWBYIDCH*1@$']) {
      await applyFail(V1, [{ op: 'edit_html', target: { moduleId: 901, field: 'intro' }, change: { kind: 'replace', html: `<p><a href="${tok}">x</a></p>` } }], 'invalid_content', `campo ${tok}`, /token inválido/);
      await applyFail(V1, [{ op: 'edit_html', target: { sectionId: 12 }, change: { kind: 'replace', html: `<p><a href="${tok}">x</a></p>` } }], 'invalid_content', `sección ${tok}`);
      await applyFail(V1, [{ op: 'exam_question_add', quizModuleId: 930, question: { ...MC('x'), text: `<p>Ver <a href="${tok}">esto</a></p>` } }], 'invalid_content', `pregunta ${tok}`);
      await applyFail(V1, [{ op: 'edit_html', target: { moduleId: 911, field: 'intro' }, change: { kind: 'token', token: '$@SCORMVIEWBYID*912@$', action: 'retarget', to: tok } }], tok === '$@SCORMVIEWBYID@$' || tok === '$@BOOKVIEWBYIDCH*1@$' ? 'invalid_content' : 'invalid_content', `retarget ${tok}`);
    }
    await applyOk(V1, [{ op: 'edit_html', target: { moduleId: 901, field: 'intro' }, change: { kind: 'replace', html: '<p><a href="$@WWWROOT@$/my/">Mi área</a></p>' } }], 'WWWROOT');
  });

  await check('R1 P2-8 quitar enlace: `</a >`, `</A\n>`, «>» dentro de un atributo → texto conservado; enlace anidado o sin cerrar → falla', async () => {
    const T = '$@SCORMVIEWBYID*912@$';
    const cases = [
      [`<p>Video. <a href="${T}">Practicar</a >. <a href="$@RESOURCEVIEWBYID*903@$">Libro</a></p>`, '<p>Video. Practicar. <a href="$@RESOURCEVIEWBYID*903@$">Libro</a></p>'],
      [`<p>Video. <A title="a > b" HREF='${T}'>Practicar</A\n>.</p>`, '<p>Video. Practicar.</p>'],
    ];
    for (const [html, want] of cases) {
      const b = await zipEdit(V1, (z) => setIntro(z, 'hvp_911', html));
      const { inv } = await applyOk(b, [{ op: 'edit_html', target: { moduleId: 911, field: 'intro' }, change: { kind: 'token', token: T, action: 'unlink' } }], `unlink ${html.slice(0, 30)}`);
      eq(field(inv, 911, 'intro').html, want, 'unlink robusto');
    }
    for (const html of [`<p><a href="${T}">Practicar <a href="#x">otro</a></a></p>`, `<p><a href="${T}">Practicar</p>`]) {
      const b = await zipEdit(V1, (z) => setIntro(z, 'hvp_911', html));
      await applyFail(b, [{ op: 'edit_html', target: { moduleId: 911, field: 'intro' }, change: { kind: 'token', token: T, action: 'unlink' } }], 'invalid_content', 'anidado / sin cerrar');
    }
  });

  await check('R1 P2-5 colores: nunca dentro de <script>, <style> ni comentarios; logo: los SCORM no se tocan y el informe lo dice', async () => {
    const b = await zipEdit(V1, (z) => setIntro(z, 'label_904', '<p style="color:#B45309">Guía.</p><!-- <div style="color:#B45309"> --><script>var t = \'<div style="color:#B45309">\';</script><p><a href="$@RESOURCEVIEWBYID*903@$">Descargar Libro Guía</a></p>'));
    const { inv } = await applyOk(b, [{ op: 'brand_replace', colors: { '#B45309': '#0F766E' } }], 'colores con script');
    eq(field(inv, 904, 'intro').html, '<p style="color:#0F766E">Guía.</p><!-- <div style="color:#B45309"> --><script>var t = \'<div style="color:#B45309">\';</script><p><a href="$@RESOURCEVIEWBYID*903@$">Descargar Libro Guía</a></p>', 'solo el style real');
    // Logo que solo vive en un SCORM: no se reemplaza → el logo no aparece en otro lado → falla con motivo, y el aviso no miente.
    const L1 = makePng(9, 9, 9); const L2 = makePng(8, 8, 8);
    const sc = await zipEdit(V1, async (z) => { const c = (await inventoryOf(V1)).activities.find((a) => a.moduleId === 912).contextId; await addFile(z, { contextId: c, component: 'mod_scorm', filearea: 'content', filename: 'logo.png', data: L1, mimetype: 'image/png', fileId: 95 }); await setIntro(z, 'label_901', `<p>Bienvenidos.</p><img src="data:image/png;base64,${L1.toString('base64')}">`); });
    const r = await applyOk(sc, [{ op: 'brand_replace', logo: { currentSha1: sha1(L1), image: { base64: L2.toString('base64'), mimetype: 'image/png' } } }], 'logo con SCORM');
    assert(r.b.map.has(blobPath(sha1(L1))) && !r.res.operations[0].files.length, 'el blob del SCORM sigue con el logo viejo');
    assert(r.res.operations[0].misalignment.some((m) => /SCORM tienen el logo anterior/.test(m)), `aviso veraz: ${r.res.operations[0].misalignment.join(' | ')}`);
    const shared = await zipEdit(sc, (z) => addFile(z, { contextId: 104, component: 'mod_label', filearea: 'intro', filename: 'logo.png', data: L1, mimetype: 'image/png', fileId: 96 }));
    await applyFail(shared, [{ op: 'brand_replace', logo: { currentSha1: sha1(L1), image: { base64: L2.toString('base64'), mimetype: 'image/png' } } }], 'unsupported', 'blob compartido con un SCORM', /SCORM/);
  });

  await check('R1 P2-3 exámenes: respaldo con usuarios o intentos → no se editan (motivo claro)', async () => {
    const withUsers = await zipEdit(V1, async (z) => { const mb = await z.file('moodle_backup.xml').async('string'); const i = mb.indexOf('</contents>') + 11; z.file('moodle_backup.xml', mb.slice(0, i) + '<settings><setting><level>root</level><name>users</name><value>1</value></setting></settings>' + mb.slice(i)); });
    await applyFail(withUsers, [{ op: 'exam_question_remove', quizModuleId: 930, questionId: 5001 }], 'unsupported', 'con usuarios', /sin datos de usuarios/);
    const attempts = await zipEdit(V1, async (z) => { const p = 'activities/quiz_930/quiz.xml'; const x = await z.file(p).async('string'); z.file(p, x.replace('</quiz>', () => '<attempts><attempt id="1"><userid>5</userid></attempt></attempts></quiz>')); });
    await applyFail(attempts, [{ op: 'exam_question_replace', quizModuleId: 930, questionId: 5001, question: MC('x') }], 'unsupported', 'con intentos', /intentos/);
  });

  await check('R1 P2-7 preguntas: los archivos de sus respuestas (itemid = id de la respuesta) se van con ellas; el blob compartido se queda', async () => {
    const ctxQ = (await inventoryOf(V1)).activities.find((a) => a.moduleId === 930).contextId;
    const A1 = Buffer.from('respuesta-6001'); const A3 = Buffer.from('respuesta-6003'); const QT = Buffer.from('enunciado-5001');
    const b = await zipEdit(V1, async (z) => {
      const add = (fileId, filearea, itemid, data, name) => addFile(z, { contextId: ctxQ, component: 'question', filearea, filename: name, data, mimetype: 'image/png', fileId }).then(async () => { const fx = await z.file('files.xml').async('string'); z.file('files.xml', fx.replace(`<file id="${fileId}"><contenthash>${sha1(data)}</contenthash><contextid>${ctxQ}</contextid><component>question</component><filearea>${filearea}</filearea><itemid>0</itemid>`, () => `<file id="${fileId}"><contenthash>${sha1(data)}</contenthash><contextid>${ctxQ}</contextid><component>question</component><filearea>${filearea}</filearea><itemid>${itemid}</itemid>`)); });
      await add(81, 'answer', 6001, A1, 'a1.png'); await add(82, 'answerfeedback', 6003, A3, 'a3.png'); await add(83, 'questiontext', 5001, QT, 'q.png');
      await addFile(z, { contextId: 104, component: 'mod_label', filearea: 'intro', filename: 'copia-a1.png', data: A1, mimetype: 'image/png', fileId: 84 });
    });
    const rem = await applyOk(b, [{ op: 'exam_question_remove', quizModuleId: 930, questionId: 5001 }], 'quitar pregunta con archivos');
    const fx = rem.b.map.get('files.xml').toString('utf8');
    assert(!/<file id="8[123]">/.test(fx), 'los 3 archivos de la pregunta y sus respuestas fuera');
    assert(!rem.b.map.has(blobPath(sha1(A3))) && !rem.b.map.has(blobPath(sha1(QT))) && rem.b.map.has(blobPath(sha1(A1))), 'blobs huérfanos fuera, el compartido queda');
    const rep = await applyOk(b, [{ op: 'exam_question_replace', quizModuleId: 930, questionId: 5001, question: { qtype: 'multichoice', text: '<p>¿2 + 2?</p>', answers: [{ html: 'Cuatro', fraction: 1 }, { html: 'Tres', fraction: 0 }] } }], 'reemplazo con menos opciones');
    const fx2 = rep.b.map.get('files.xml').toString('utf8');
    assert(/<file id="81">/.test(fx2) && !/<file id="82">/.test(fx2) && /<file id="83">/.test(fx2), 'solo sale el archivo de la respuesta que ya no existe (6003)');
  });

  await check('R1 P2-4 Libro V1: capítulo faltante en su módulo (después de la página «Módulo 2»); pie de página conservado; módulo desconocido entre módulos → falla', async () => {
    const PG = (n) => `<div class="pg-hd"><div class="pg-hd-l">Libro Guía · Curso</div></div>`;
    const FT = '<div class="pg-ft">Libro Guía · Curso<br><span class="cp">© Material protegido</span></div>';
    const LIB = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>L</title></head><body>'
      + '<div class="page"><div class="cover">Portada</div></div>'
      + `<div class="page">${PG()}<h1>Módulo 1 — Bases</h1><p>Intro del módulo 1.</p>${FT}</div>`
      + `<div class="page">${PG()}<h1>Capítulo 1: Primero</h1><p>Contenido del primero.</p>${FT}</div>`
      + `<div class="page">${PG()}<h1>Módulo 2 — Avance</h1><p>Intro del módulo 2.</p>${FT}</div>`
      + `<div class="page">${PG()}<h1>Recursos y Bibliografía</h1><p>Refs.</p>${FT}</div></body></html>`;
    const base = await zipEdit(V1, async (z) => {
      await replaceBlobIn(z, 'libro_guia_completo.html', () => LIB);
      for (const [d, nm] of [['section_12', 'Módulo 1 · Capítulo 1: Primero'], ['section_13', 'Módulo 2 · Capítulo 2: Segundo']]) { const p = `sections/${d}/section.xml`; const x = await z.file(p).async('string'); z.file(p, x.replace(/<name>[^<]*<\/name>/, () => `<name>${nm}</name>`)); }
    });
    const inv0 = await inventoryOf(base);
    eq(inv0.chapters.map((c) => [c.number, c.moduleNumber]), [[1, 1], [2, 2]], 'módulos de los capítulos');
    const { res, b } = await applyOk(base, [{ op: 'edit_libro_section', moduleId: 903, chapters: [{ number: 2, html: '<p>Contenido del segundo.</p>', title: 'Segundo' }, { number: 1, html: '<p>Primero reescrito.</p>' }] }], 'libro con módulos');
    const out = b.map.get(blobPath(res.operations[0].files[0].after.contenthash)).toString('utf8');
    const iM2 = out.indexOf('Módulo 2 — Avance'); const iC2 = out.indexOf('Capítulo 2: Segundo'); const iB = out.indexOf('Recursos y Bibliografía');
    assert(iM2 > 0 && iC2 > iM2 && iB > iC2, 'Módulo 2 → Capítulo 2 → Bibliografía');
    assert(out.includes(`<h1>Capítulo 1: Primero</h1><p>Primero reescrito.</p>${FT}</div>`), 'el pie de la página reemplazada se conserva');
    assert(out.includes(`<div class="page">${PG()}<h1>Capítulo 2: Segundo</h1><p>Contenido del segundo.</p>${FT}</div>`), 'el capítulo agregado lleva encabezado y pie');
    // Sin módulos en el curso (secciones sin «Módulo M»): entre el cap. 1 y el final hay una página de módulo → falla.
    const plain = await zipEdit(V1, (z) => replaceBlobIn(z, 'libro_guia_completo.html', () => LIB));
    await applyFail(plain, [{ op: 'edit_libro_section', moduleId: 903, chapters: [{ number: 2, html: '<p>x</p>', title: 'Segundo' }] }], 'unsupported', 'módulo desconocido', /módulo/);
  });

  await check('R1 P2-6 hallazgos por ocurrencia: cambiar un enlace muerto por otro en la misma etiqueta → hallazgo nuevo; los de una actividad quitada → «quitados», no «resueltos»', async () => {
    const two = await zipEdit(V1, (z) => setIntro(z, 'label_901', '<p style="color:#000">Bienvenidos. <a href="#">Ir al módulo</a></p>'));
    const r = await applyFail(two, [{ op: 'edit_html', target: { moduleId: 901, field: 'intro' }, change: { kind: 'replace', html: '<p style="color:#000">Bienvenidos. <a href="#">Ver el foro</a></p>' } }], 'new_findings', 'cambio de un defecto por otro');
    assert(r.diagnosis.introduced.some((x) => /dead_link/.test(x.signature)) && r.diagnosis.resolved.some((x) => /dead_link/.test(x.signature)), 'uno resuelto + uno nuevo');
    const z = await JSZip.loadAsync(AS); const exp = await BC.MUTATIONS['empty-label'](z); const dmg = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const mid = Number(exp.target.split('_')[1]);
    const ok2 = await applyOk(dmg, [{ op: 'remove_activity', moduleId: mid }], 'quitar etiqueta vacía');
    assert(ok2.res.diagnosis.removed.some((x) => /empty_activity/.test(x.signature)) && !ok2.res.diagnosis.resolved.some((x) => /empty_activity/.test(x.signature)), 'quitado ≠ resuelto');
  });

  await check('R1 P2-2 remove_activity: condición de acceso por NOTA, cálculo ##giN## y bloque que la nombra → falla con motivo', async () => {
    const gi = Number(/<grade_item id="(\d+)"/.exec((await entriesOf(AS)).map.get('activities/h5pactivity_1020/grades.xml').toString('utf8'))[1]);
    const byGrade = await zipEdit(AS, async (z) => { const p = 'activities/label_1022/module.xml'; const x = await z.file(p).async('string'); z.file(p, x.replace('<availability>$@NULL@$</availability>', () => `<availability>{"op":"&amp;","c":[{"type":"grade","id":${gi},"min":50}],"showc":[true]}</availability>`)); });
    await applyFail(byGrade, [{ op: 'remove_activity', moduleId: 1020 }], 'invariant', 'por nota', /NOTA/);
    const calc = await zipEdit(AS, async (z) => { const x = await z.file('gradebook.xml').async('string'); z.file('gradebook.xml', x.replace('</gradebook>', () => `<calc>##gi${gi}##</calc></gradebook>`)); });
    await applyFail(calc, [{ op: 'remove_activity', moduleId: 1020 }], 'invariant', '##gi##', /##gi/);
    const blk = await zipEdit(AS, (z) => { z.file('course/blocks/completion_progress_9/block.xml', `<?xml version="1.0" encoding="UTF-8"?><block id="9" contextid="9999" version="1"><blockname>completion_progress</blockname><configdata>${Buffer.from('a:1:{s:15:"selectactivities";a:1:{i:0;s:18:"h5pactivity-1020";}}').toString('base64')}</configdata></block>`); });
    await applyFail(blk, [{ op: 'remove_activity', moduleId: 1020 }], 'invariant', 'bloque', /bloque/);
  });

  await check('R1 P2-1 tar.gz como el de Moodle: .ARCHIVE_INDEX regenerado (cuenta y líneas del paquete nuevo), carpetas, nombres largos con prefix (nunca PAX); un nombre que no entra → falla clara', async () => {
    const tgz = await zipToTarGz(V1, { index: true, extra: { [`activities/label_904/${'d'.repeat(60)}/${'n'.repeat(70)}.txt`]: Buffer.from('largo') } });
    const { res } = await applyOk(tgz, [{ op: 'remove_activity', moduleId: 912 }], 'tar.gz con índice');
    const hdrs = tarHeaders(zlib.gunzipSync(res.package));
    assert(hdrs.every((h) => h.type === '0' || h.type === '5'), `tipos: ${[...new Set(hdrs.map((h) => h.type))].join(',')}`);
    eq(hdrs[0].path, '.ARCHIVE_INDEX', 'el índice primero');
    const idx = hdrs[0].data.toString('utf8').split('\n').filter(Boolean);
    const rest = hdrs.slice(1);
    eq(idx[0], `Moodle archive file index. Count: ${rest.length}`, 'cuenta');
    eq(idx.slice(1).map((l) => l.split('\t')[0]), rest.map((h) => h.path), 'una línea por entrada, en orden');
    assert(!idx.some((l) => l.startsWith('activities/scorm_912/')), 'sin lo quitado');
    const long = rest.find((h) => h.path.endsWith('.txt'));
    assert(long && long.prefix && long.name.length <= 100, 'nombre largo partido en prefix + name');
    assert(res.operations[res.operations.length - 1].entriesModified.includes('.ARCHIVE_INDEX'), 'el informe dice que el índice cambió');
    const bad = await zipToTarGz(V1, { index: true, extra: { [`activities/label_904/${'x'.repeat(120)}.txt`]: Buffer.from('no entra') } });
    await applyFail(bad, [{ op: 'remove_activity', moduleId: 912 }], 'unsupported', 'nombre que no entra', /demasiado largo/);
  });
}

// ── --corpus ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function autoOps(inv, mapText) {
  const out = [];
  const lbl = inv.activities.find((a) => a.modname === 'label' && !a.missingFolder && a.html[0] && a.html[0].html.length > 40 && a.tokens.every((t) => t.status === 'ok' || t.status === 'unchecked') && !/<style|<script/i.test(a.html[0].html));
  if (lbl) out.push({ kind: 'edit_html', op: { op: 'edit_html', target: { moduleId: lbl.moduleId, field: lbl.html[0].field }, expectRawSha1: lbl.html[0].rawSha1, change: { kind: 'replace', html: `${lbl.html[0].html}<p style="margin:0">Nota del Taller: ñandú «$&» O'Brien &amp; 🎓</p>` } } });
  const libro = inv.activities.find((a) => a.kind === 'libro' && !a.missingFolder);
  if (libro) out.push({ kind: 'edit_libro_section', op: { op: 'edit_libro_section', moduleId: libro.moduleId, chapters: [{ number: inv.chapters[0]?.number ?? 1, html: '<p>Cuerpo nuevo del capítulo, escrito por el Taller («ñ», $&).</p>' }] } });
  const quiz = inv.activities.find((a) => a.modname === 'quiz' && !a.missingFolder && a.exam && a.exam.questions.some((q) => ['multichoice', 'truefalse'].includes(q.qtype)));
  if (quiz) {
    const q = quiz.exam.questions.find((x) => ['multichoice', 'truefalse'].includes(x.qtype));
    out.push({ kind: 'exam_question_replace', op: { op: 'exam_question_replace', quizModuleId: quiz.moduleId, questionId: q.id, question: MC('Pregunta reescrita por el Taller') } });
    const qxml = mapText(`${quiz.dir}/quiz.xml`) || '';
    const rnd = /"questioncategoryid"\s*:\s*(\d+)|"category"\s*:\s*\{[^}]*"values"\s*:\s*\[(\d+)/.exec(qxml.replace(/&quot;/g, '"'));
    out.push({ kind: 'exam_question_add', op: { op: 'exam_question_add', quizModuleId: quiz.moduleId, ...(rnd ? { categoryId: Number(rnd[1] ?? rnd[2]) } : (new Set(quiz.exam.questions.map((x) => x.categoryId)).size > 1 ? { categoryId: q.categoryId } : {})), question: MC('Pregunta agregada por el Taller') } });
    const last = quiz.exam.questions[quiz.exam.questions.length - 1];
    out.push({ kind: 'exam_question_remove', op: { op: 'exam_question_remove', quizModuleId: quiz.moduleId, questionId: last.id } });
  }
  const col = inv.activities.flatMap((a) => a.html).map((h) => /style\s*=\s*"[^"]*?(#[0-9a-fA-F]{6})\b/.exec(h.html)?.[1]).find(Boolean);
  if (col) out.push({ kind: 'brand_replace', op: { op: 'brand_replace', colors: { [col]: '#123456' } } });
  const img = P.listBrandImages(inv).find((x) => x.mimetype === 'image/png');
  if (img) out.push({ kind: 'brand_logo', op: { op: 'brand_replace', logo: { currentSha1: img.sha1, image: { base64: makePng(1, 2, 3).toString('base64'), mimetype: 'image/png' } } } });
  const anchored = new Set([...inv.activities.flatMap((a) => a.tokens), ...inv.sections.flatMap((x) => x.tokens)].filter((t) => t.anchor && t.anchor.type === 'module').map((t) => t.anchor.id));
  const rm = inv.activities.find((a) => a.modname === 'label' && !a.missingFolder && !anchored.has(a.moduleId) && !a.referencedBy.length && !a.referencedBySections.length && !a.referencedByCourse && inv.sections.find((s) => s.sequence.includes(a.moduleId))?.sequence.length > 1 && (!lbl || a.moduleId !== lbl.moduleId));
  if (rm) out.push({ kind: 'remove_activity', op: { op: 'remove_activity', moduleId: rm.moduleId } });
  return out;
}
const EXPECTED_FAIL = new Set(['unavailable', 'unsupported', 'invariant', 'invalid_params', 'invalid_content', 'target_not_found', 'new_findings']);

async function corpusSuite(manifestPath) {
  const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const fx = man.fixtures.filter((f) => !f.skipped);
  await check('P13 corpus: hallazgos SEMBRADOS (v3 A-S y V1 REAL de B0) → suggestedFix → resueltos, sin hallazgos nuevos', async () => {
    const bases = { 'v3-A-S': fs.readFileSync(fx.find((f) => f.id === 'synthetic:v3-A-S').path) };
    if (man.v1DamageBase) bases[`v1-${man.v1DamageBase.sha1.slice(0, 8)}`] = fs.readFileSync(man.v1DamageBase.path);
    const want = ['orphan-token', 'wrong-type-token', 'pending-placeholder', 'empty-label', 'exam-no-correct', 'libro-html-truncated'];
    const lines = [];
    const bad = [];
    for (const f of fx.filter((x) => x.source === 'damaged' && want.includes(x.mutation))) {
      try {
        const r = await fixSeeded(f.id, fs.readFileSync(f.path), bases[f.base], f.expectedDefects[0]);
        lines.push(`✓ ${f.id}: ${r.seeded.check}/${r.seeded.code} → ${r.ops.map((o) => o.op).join(', ')}`);
      } catch (e) { bad.push(`${f.id}: ${String(e.message).slice(0, 300)}`); lines.push(`✗ ${f.id}: ${String(e.message).slice(0, 200)}`); }
    }
    console.log(`   ${lines.join('\n   ')}`);
    assert(!bad.length, bad.join('\n'));
  });
  const reals = fx.filter((f) => f.source === 'real');
  const table = [];
  await check(`P14 corpus: matriz de operaciones sobre los ${reals.length} reales (cada una sola + plan combinado), invariantes en todo lo que se aplica, fallas siempre tipadas con motivo`, async () => {
    const problems = [];
    for (const f of reals) {
      const buf = fs.readFileSync(f.path);
      const before = sha1(buf);
      const inv = await inventoryOf(buf, path.basename(f.path));
      const { map } = await entriesOf(buf);
      const ops = autoOps(inv, (n) => map.get(n)?.toString('utf8') ?? null);
      const baseline = await diagnose(buf, path.basename(f.path));
      const row = { id: f.id, family: f.family, mb: Math.round(buf.length / 1048576), results: {} };
      const good = [];
      for (const o of ops) {
        const res = await P.applyPatchPlan({ original: buf, filename: path.basename(f.path), operations: [o.op], baseline: { originalSha1: before, report: baseline } });
        if (res.ok) {
          try { await assertInvariants(buf, res, `${f.id} ${o.kind}`, { filename: path.basename(f.path) }); row.results[o.kind] = 'ok'; good.push(o); } catch (e) { row.results[o.kind] = `INVARIANTE: ${e.message.slice(0, 160)}`; problems.push(`${f.id} ${o.kind}: ${e.message.slice(0, 300)}`); }
        } else {
          row.results[o.kind] = `falla ${res.failure.code}: ${res.failure.message.slice(0, 140)}`;
          if (!EXPECTED_FAIL.has(res.failure.code) || /Error interno/.test(res.failure.message)) problems.push(`${f.id} ${o.kind}: ${res.failure.code} ${res.failure.message}`);
        }
      }
      if (good.length >= 2) {
        const res = await P.applyPatchPlan({ original: buf, filename: path.basename(f.path), operations: good.map((o) => o.op), baseline: { originalSha1: before, report: baseline } });
        if (res.ok) { try { await assertInvariants(buf, res, `${f.id} combinado`, { filename: path.basename(f.path) }); row.results.combinado = `ok (${good.length} ops)`; } catch (e) { row.results.combinado = `INVARIANTE: ${e.message.slice(0, 160)}`; problems.push(`${f.id} combinado: ${e.message.slice(0, 300)}`); } }
        else { row.results.combinado = `falla ${res.failure.code} op ${res.failure.opIndex}: ${res.failure.message.slice(0, 140)}`; problems.push(`${f.id} combinado: ${res.failure.code} ${res.failure.message}`); }
      }
      eq(sha1(buf), before, `${f.id}: el original cambió`);
      table.push(row);
      console.log(`   ${f.family.padEnd(15)} ${f.id.padEnd(30)} ${String(row.mb).padStart(4)} MB  ${Object.entries(row.results).map(([k, v]) => `${k}=${v.split(':')[0]}`).join(' · ')}`);
    }
    const out = path.join(os.homedir(), 'cursia-test-env/work/r107/patch-corpus-matrix.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(table, null, 2));
    console.log(`   matriz completa: ${out}`);
    assert(!problems.length, problems.slice(0, 8).join('\n'));
  });
}

// ── --moodle ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function moodleSuite() {
  const MOODLE = process.env.MOODLE_LOCAL_DIR || path.join(os.homedir(), 'cursia-test-env/moodle-local');
  const PHP = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';
  const PHPINI = path.join(MOODLE, 'php.ini');
  const OUT = process.env.R107_PATCH_OUT || path.join(os.homedir(), 'cursia-test-env/work/r107/patch-moodle-out');
  try { execFileSync('pg_isready', ['-h', '127.0.0.1', '-p', '5570'], { stdio: 'ignore' }); } catch (_) {
    console.log(`❌ El Moodle local no está disponible (Postgres no responde en 127.0.0.1:5570). No se toca su configuración: arrancarlo con ${MOODLE}/start.sh y volver a correr --moodle.`);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const env = { ...process.env, E2E_MOODLE_DIR: MOODLE, CURSIA_RESTORE_PHP: path.join(REPO, 'scripts/moodle/restore-as-admin.php') };
  const restore = (buf, name) => {
    const p = path.join(OUT, `${name}.mbz`);
    fs.writeFileSync(p, buf);
    const rs = spawnSync(path.join(MOODLE, 'restore-and-inspect.sh'), [p], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    if (rs.status !== 0) throw new Error(`restore-and-inspect.sh salió con ${rs.status}: ${rs.stderr.slice(-800)}`);
    const courseid = Number((/Restored course id: (\d+)/.exec(rs.stderr) || [])[1]);
    assert(courseid > 0, 'sin course id');
    const inP = path.join(OUT, `${name}.in.json`); const outP = path.join(OUT, `${name}.out.json`);
    fs.writeFileSync(inP, JSON.stringify({ moodleRoot: path.join(MOODLE, 'source'), courseid, mbz: p }));
    execFileSync(PHP, ['-c', PHPINI, path.join(REPO, 'scripts/moodle/r107-patch-inspect.php'), inP, outP], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const o = JSON.parse(fs.readFileSync(outP, 'utf8'));
    o.cms = o.sections.flatMap((s) => s.cms);
    o.cli = rs.stderr.split('\n').filter((l) => /warning|notice|debug|error|exception/i.test(l));
    return o;
  };
  const clean = (o, tag) => {
    eq(o.restoreStatus, 1000, `${tag}: controller`);
    eq(o.restoreLogLines ?? [], [], `${tag}: log del restore`);
    eq(o.restoreDbLogWarnings ?? [], [], `${tag}: backup_logs`);
    eq(o.precheck, { warnings: [], errors: [] }, `${tag}: precheck`);
    eq(o.cli, [], `${tag}: salida del CLI`);
  };
  const S = require(path.join(REPO, 'scripts/lib/commercial-simulation'));
  const COURSES = require(path.join(REPO, 'scripts/fixtures/commercial-simulation/courses.json')).courses;
  const AS = (await S.simulateCourse(DIST, COURSES.find((c) => c.id === 'A-S'))).built.mbz;
  const invAS = await inventoryOf(AS);
  await check('M1 v3 A-S: plan de 5 operaciones (edit_html, exam_question_* ×2, brand_replace, remove_activity; edit_libro_section NO disponible en v3) → restaura sin errores ni warnings y muestra los cambios', async () => {
    const q0 = invAS.activities.find((a) => a.moduleId === 1049).exam.questions[0];
    const pdf = invAS.activities.find((a) => a.kind === 'libro' && a.modname === 'resource');
    await applyFail(AS, [{ op: 'edit_libro_section', moduleId: pdf.moduleId, chapters: [{ number: 1, html: '<p>x</p>' }] }], 'unavailable', 'libro v3');
    const ops = [
      { op: 'edit_html', target: { moduleId: 1000, field: 'intro' }, change: { kind: 'replace', html: SPECIAL } },
      { op: 'exam_question_replace', quizModuleId: 1049, questionId: q0.id, question: MC('Pregunta del Taller (reemplazo)') },
      { op: 'exam_question_add', quizModuleId: 1049, categoryId: q0.categoryId, question: { qtype: 'truefalse', text: '<p>Pregunta del Taller (agregada).</p>', correct: true } },
      { op: 'brand_replace', colors: { '#B45309': '#0F766E' } },
      { op: 'remove_activity', moduleId: 1051 },
    ];
    const { res } = await applyOk(AS, ops, 'M1');
    const o = restore(res.package, 'r107-patch-v3-AS');
    clean(o, 'M1');
    const cm = (n) => o.cms.find((c) => c.name === n);
    eq(cm('Bienvenida').intro, SPECIAL, 'M1: etiqueta editada tal cual (con $&, apóstrofe, emoji)');
    const quiz = o.cms.find((c) => c.modname === 'quiz' && /módulo 1/.test(c.name));
    const bank = quiz.slots.find((s) => s.kind === 'random').bank;
    const cat = quiz.slots.filter((s) => s.kind === 'random' && s.categoryid === quiz.slots[0].categoryid);
    assert(bank.includes('<p>Pregunta del Taller (reemplazo)</p>') && bank.includes('<p>Pregunta del Taller (agregada).</p>'), `M1: banco restaurado con el reemplazo y la nueva (${bank.length})`);
    eq([quiz.sumgrades, quiz.grade], [100, 100], 'M1: notas del examen');
    assert(cat.length >= 1, 'ranuras aleatorias');
    assert(!cm('Módulo 1: siguiente paso'), 'M1: actividad quitada');
    // Solo dentro de style="": lo que quede del color viejo fuera de un style (CSS de un <style>, atributos SVG) no cambia.
    const inStyle = (h, c) => [...String(h || '').matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)].some((m) => new RegExp(c, 'i').test(m[1]));
    const anyCol = o.cms.filter((c) => inStyle(c.intro, '#0F766E')).length;
    const oldCol = o.cms.filter((c) => inStyle(c.intro, '#B45309')).length;
    assert(anyCol >= 5 && oldCol === 0, `M1: color nuevo en style="" de ${anyCol} etiquetas, el viejo en ${oldCol}`);
    console.log(`   M1 curso restaurado ${o.courseid}: ${o.cms.length} actividades, banco de la categoría ${quiz.slots[0].categoryid} con ${bank.length} preguntas`);
  });
  // V1 real del corpus de B0 (v1-legacy, sin hvp —el Moodle local no tiene mod_hvp—, Libro Guía HTML del builder con páginas).
  const realPath = process.env.R107_V1_REAL || path.join(os.homedir(), 'Downloads/Anatomía_y_Fisiología_Animal_moodle (1).mbz');
  await check(`M2 V1 real (${path.basename(realPath)}): plan de 5 operaciones (una de cada tipo) → restaura sin errores ni warnings y muestra los cambios; el original también restaura limpio`, async () => {
    const buf = fs.readFileSync(realPath);
    const inv = await inventoryOf(buf, path.basename(realPath));
    const lbl = inv.activities.find((a) => a.kind === 'welcome');
    const libro = inv.activities.find((a) => a.kind === 'libro' && a.modname === 'resource');
    const quiz = inv.activities.find((a) => a.modname === 'quiz' && a.exam && a.exam.questions.length);
    const q = quiz.exam.questions[0];
    const col = inv.activities.flatMap((a) => a.html).map((h) => /style\s*=\s*"[^"]*?(#[0-9a-fA-F]{6})\b/.exec(h.html)?.[1]).find(Boolean);
    const rm = inv.activities.find((a) => a.kind === 'methodology');
    const ch1 = inv.chapters[0].number;
    const NEW_BODY = '<p>Cuerpo nuevo del capítulo escrito por el Taller — «ñandú» $& O\'Brien.</p>';
    const ops = [
      { op: 'edit_html', target: { moduleId: lbl.moduleId, field: 'intro' }, change: { kind: 'replace', html: SPECIAL } },
      { op: 'edit_libro_section', moduleId: libro.moduleId, chapters: [{ number: ch1, html: NEW_BODY }] },
      { op: 'exam_question_replace', quizModuleId: quiz.moduleId, questionId: q.id, question: MC('Pregunta del Taller en el V1 real') },
      { op: 'brand_replace', colors: { [col]: '#0F766E' } },
      { op: 'remove_activity', moduleId: rm.moduleId },
    ];
    const { res } = await applyOk(buf, ops, 'M2', { filename: path.basename(realPath) });
    clean(restore(buf, 'r107-patch-v1-real-original'), 'M2 original');
    const o = restore(res.package, 'r107-patch-v1-real');
    clean(o, 'M2');
    eq(o.cms.find((c) => c.name === lbl.title).intro, SPECIAL, 'M2: etiqueta editada');
    const lr = o.cms.find((c) => c.name === libro.title);
    const newHash = res.operations[1].files[0].after.contenthash;
    assert(lr.files.some((f) => f.hash === newHash), `M2: el recurso del Libro restaurado tiene el archivo nuevo (${newHash})`);
    const qr = o.cms.find((c) => c.name === quiz.title);
    assert(qr.slots.some((s) => s.question && s.question.text === '<p>Pregunta del Taller en el V1 real</p>' && s.question.answers.filter((a) => a.fraction === 1).length === 1), 'M2: pregunta reemplazada con 1 correcta');
    assert(Math.abs(qr.sumgrades - qr.slots.reduce((s, x) => s + x.maxmark, 0)) < 1e-4, 'M2: sumgrades = Σ maxmark');
    assert(!o.cms.some((c) => c.name === rm.title), 'M2: actividad quitada');
    assert(o.cms.some((c) => c.intro && c.intro.includes('#0F766E')), 'M2: color nuevo');
    console.log(`   M2 curso restaurado ${o.courseid}: ${o.cms.length} actividades; Libro ${newHash.slice(0, 10)}…; color ${col} → #0F766E`);
  });
  // Fix round 1 (P2-1): un tar.gz REAL (re-export de Moodle del corpus) parcheado → restauración real.
  const tgzPath = process.env.R107_REEXPORT || path.join(os.homedir(), 'Downloads/copia_de_seguridad-moodle2-course-183-matemáticas_para_grado_11-20260406-2235-nu.mbz');
  await check(`M3 tar.gz real (${path.basename(tgzPath)}): edit_html + brand_replace + remove_activity → índice regenerado, restaura igual de limpio que el original y muestra los cambios`, async () => {
    const buf = fs.readFileSync(tgzPath);
    eq(R.detectContainer(buf), 'tar.gz', 'contenedor');
    const inv = await inventoryOf(buf, path.basename(tgzPath));
    const { map } = await entriesOf(buf);
    const ops = autoOps(inv, (n) => map.get(n)?.toString('utf8') ?? null).filter((o) => ['edit_html', 'brand_replace', 'remove_activity'].includes(o.kind)).map((o) => o.op);
    assert(ops.length === 3, `operaciones: ${ops.map((o) => o.op).join(', ')}`);
    const { res } = await applyOk(buf, ops, 'M3', { filename: path.basename(tgzPath) });
    eq(res.container, 'tar.gz', 'sale tar.gz');
    assert(res.operations.some((o) => o.entriesModified.includes('.ARCHIVE_INDEX')), 'índice regenerado');
    const hdrs = tarHeaders(zlib.gunzipSync(res.package));
    assert(hdrs.every((h) => h.type === '0' || h.type === '5'), 'sin PAX');
    const o0 = restore(buf, 'r107-patch-reexport-original');
    const o = restore(res.package, 'r107-patch-reexport');
    // Igual de limpio que el original (el original es la línea de base de un backup ajeno).
    // (el log trae fecha e ids del curso nuevo: se comparan sin números; el original ya trae un aviso propio de Moodle).
    const norm = (v) => JSON.stringify(v ?? null).replace(/\d+/g, 'N');
    for (const k of ['restoreStatus', 'restoreLogLines', 'restoreDbLogWarnings', 'precheck', 'cli']) eq(norm(o[k]), norm(o0[k]), `M3: ${k} igual al original`);
    eq(o.restoreStatus, 1000, 'M3: controller');
    console.log(`   M3 avisos del restore, iguales en original y parcheado: ${JSON.stringify(o0.restoreLogLines)}`);
    const edited = ops[0];
    const a = inv.activities.find((x) => x.moduleId === edited.target.moduleId);
    const rc = o.cms.find((c) => c.name === a.title || (c.intro && c.intro.includes('Nota del Taller')));
    assert(rc && rc.intro.includes('Nota del Taller: ñandú «$&» O\'Brien'), 'M3: etiqueta editada');
    const removed = inv.activities.find((x) => x.moduleId === ops[2].moduleId);
    eq(o.cms.length, o0.cms.length - 1, `M3: una actividad menos (${removed.title})`);
    console.log(`   M3 curso restaurado ${o.courseid}: ${o.cms.length} actividades (original ${o0.cms.length})`);
  });
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const t0 = Date.now();
  if (MODE === 'ci') { console.log('  modo CI: sintéticos v3 (A-S, ofimática, 1×1) + V1 mínimo + dañados generados acá'); await ciSuite(await ciFixtures()); }
  if (MODE === 'corpus') { const m = arg('--corpus', DEFAULT_CORPUS); console.log(`  modo corpus: ${m}`); await corpusSuite(m); }
  if (MODE === 'moodle') { console.log('  modo Moodle 4.5 local (restauración real)'); await moodleSuite(); }
  console.log(`\n${fail ? '❌' : '✅'} check-r107-patch --${MODE}: ${ok} ok, ${fail} fallidos (${Math.round((Date.now() - t0) / 1000)} s)${fail ? ` — ${failed.join(' | ')}` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
