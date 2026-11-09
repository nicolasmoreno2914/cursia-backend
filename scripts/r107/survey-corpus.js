// r107 B0 — censo de un corpus de .mbz de Cursia: por paquete, el contenedor (zip / tar.gz), la versión de Moodle que
// declara, el título, los tipos de actividad y las señas del builder que lo armó. Agrupa por «firma de formato» para
// elegir una muestra representativa por formato (los adaptadores de B2 se escriben contra esas firmas).
// Solo lee moodle_backup.xml y la lista de entradas (sin extraer el paquete). Sin red, sin IA, USD 0.
//
// Usage: node scripts/r107/survey-corpus.js --list <archivo con una ruta por línea> --out <dir>
// Salida: <out>/survey.json (un registro por paquete) y <out>/signatures.json (firmas con conteo y ejemplos).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function containerOf(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(4);
  fs.readSync(fd, b, 0, 4, 0);
  fs.closeSync(fd);
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'tar.gz';
  return 'unknown';
}

const MAX_BUF = 256 * 1024 * 1024;
function listEntries(file, container) {
  if (container === 'zip') {
    return execFileSync('unzip', ['-Z1', file], { maxBuffer: MAX_BUF }).toString('utf8').split('\n').filter(Boolean);
  }
  return execFileSync('tar', ['-tzf', file], { maxBuffer: MAX_BUF }).toString('utf8').split('\n').filter(Boolean)
    .map((e) => e.replace(/^\.\//, ''));
}

function readEntry(file, container, entry) {
  if (container === 'zip') return execFileSync('unzip', ['-p', file, entry], { maxBuffer: MAX_BUF }).toString('utf8');
  // tar: la entrada puede venir con o sin «./»
  for (const e of [entry, './' + entry]) {
    try { return execFileSync('tar', ['-xzOf', file, e], { maxBuffer: MAX_BUF, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8'); } catch { /* sigue */ }
  }
  return '';
}

function tag(xml, name) {
  const m = xml.match(new RegExp('<' + name + '>([^<]*)</' + name + '>'));
  return m ? m[1] : null;
}

function sha1File(file) {
  const h = crypto.createHash('sha1');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}

function surveyOne(file) {
  const rec = { file, size: fs.statSync(file).size };
  try {
    rec.container = containerOf(file);
    if (rec.container === 'unknown') { rec.error = 'contenedor desconocido'; return rec; }
    const entries = listEntries(file, rec.container);
    rec.entries = entries.length;
    const mb = readEntry(file, rec.container, 'moodle_backup.xml');
    if (!mb) { rec.error = 'sin moodle_backup.xml'; return rec; }
    rec.moodleRelease = tag(mb, 'moodle_release');
    rec.backupRelease = tag(mb, 'backup_release');
    rec.title = tag(mb, 'original_course_fullname');
    rec.backupDate = tag(mb, 'backup_date');
    rec.originalSiteHash = tag(mb, 'original_site_identifier_hash');
    const mods = {};
    for (const m of mb.matchAll(/<modulename>([^<]+)<\/modulename>/g)) mods[m[1]] = (mods[m[1]] || 0) + 1;
    rec.modules = mods;
    rec.sections = (mb.match(/<sectionid>/g) || []).length;
    const has = (re) => entries.some((e) => re.test(e));
    rec.traits = {
      gradebook: has(/^gradebook\.xml$/),
      questions: has(/^questions\.xml$/),
      completion: has(/^completion\.xml$/),
      badges: has(/^badges\.xml$/),
      groups: has(/^groups\.xml$/),
      filesDir: has(/^files\/[0-9a-f]{2}\//),
      xapistate: has(/\/xapistate\.xml$/),
    };
    // Señas del generador en el HTML de las labels (sin extraer todo: solo la primera label y el primer resource).
    const firstLabel = entries.find((e) => /^activities\/label_\d+\/label\.xml$/.test(e));
    const labelXml = firstLabel ? readEntry(file, rec.container, firstLabel) : '';
    rec.hints = {
      cursiaWord: /cursia/i.test(mb + labelXml),
      campuscloudWord: /campus ?cloud/i.test(mb + labelXml),
      practicarCta: /Practicar/.test(labelXml),
      inlineStyles: /style=&quot;|style="/.test(labelXml),
      styleTag: /&lt;style|<style/.test(labelXml),
      cursiaMeta: /cursia_meta/.test(mb),
    };
    // Moodle re-exportó el paquete (backup hecho desde un Moodle) vs. armado por Cursia: Moodle agrega `mnet_remoteusers`
    // y usuarios reales; los builders de Cursia no traen users.xml con usuarios.
    rec.moodleReexport = /copia_de_seguridad-moodle2|backup-moodle2/.test(path.basename(file)) || has(/^users\.xml$/) && /<user id=/.test(readEntry(file, rec.container, 'users.xml'));
    rec.sha1 = sha1File(file);
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 300);
  }
  return rec;
}

function signatureOf(r) {
  if (r.error) return 'ERROR:' + r.error.slice(0, 40);
  const mods = Object.keys(r.modules || {}).sort().join('+');
  const t = r.traits || {};
  return [r.container, 'moodle' + (r.backupRelease || '?'), mods, t.gradebook ? 'gb' : 'nogb', t.questions ? 'q' : 'noq',
    t.completion ? 'compl' : 'nocompl', r.hints?.styleTag ? 'style' : 'inline', r.moodleReexport ? 'reexport' : 'cursia'].join(' | ');
}

function main() {
  const list = arg('--list');
  const out = arg('--out');
  if (!list || !out) { console.error('Usage: --list <file> --out <dir>'); process.exit(2); }
  fs.mkdirSync(out, { recursive: true });
  const files = fs.readFileSync(list, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const recs = [];
  const seen = new Map();
  for (const f of files) {
    const r = surveyOne(f);
    if (r.sha1 && seen.has(r.sha1)) r.duplicateOf = seen.get(r.sha1);
    else if (r.sha1) seen.set(r.sha1, f);
    r.signature = signatureOf(r);
    recs.push(r);
    process.stderr.write('.');
  }
  process.stderr.write('\n');
  const sigs = {};
  for (const r of recs.filter((x) => !x.duplicateOf)) {
    const s = (sigs[r.signature] ||= { count: 0, totalBytes: 0, examples: [] });
    s.count++;
    s.totalBytes += r.size;
    if (s.examples.length < 5) s.examples.push({ file: r.file, size: r.size, title: r.title, backupDate: r.backupDate, modules: r.modules });
  }
  fs.writeFileSync(path.join(out, 'survey.json'), JSON.stringify(recs, null, 2));
  fs.writeFileSync(path.join(out, 'signatures.json'), JSON.stringify(sigs, null, 2));
  const uniq = recs.filter((x) => !x.duplicateOf).length;
  console.log(`paquetes=${recs.length} únicos=${uniq} errores=${recs.filter((x) => x.error).length} firmas=${Object.keys(sigs).length}`);
}

main();
