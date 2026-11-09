// r107 B0 — check del corpus del Taller (manifest.json de build-corpus.js). Sin red, sin IA, USD 0.
//   C1 cada fixture existe y su sha1 coincide con el manifiesto
//   C2 cada dañado declara exactamente una falla esperada (check T01–T12 + destino) y difiere de su base
//   C3 los sintéticos sanos salen limpios del validador v3 con sus expectativas
//   C4 hay muestra real de cada familia de formato del censo (salvo `unreadable`)
//   C5 (línea de base, informativo) qué dañados v3 ya detecta el validador v3 existente: B3 debe cubrir el resto y V1
//
// Usage: node scripts/r107/check-r107-corpus.js --corpus <dir> [--dist dist]
'use strict';
require('reflect-metadata');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const corpus = path.resolve(arg('--corpus'));
const distRoot = path.resolve(arg('--dist', 'dist'));
const M = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
let ok = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => { ok++; console.log('✅ ' + name); }, (e) => { fail++; console.log('❌ ' + name + ': ' + e.message); });
}
function sha1File(p) { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); }

(async () => {
  const fx = M.fixtures.filter((f) => !f.skipped);
  await check('C1 fixtures presentes con su sha1', () => {
    const bad = fx.filter((f) => !fs.existsSync(f.path) || sha1File(f.path) !== f.sha1).map((f) => f.id);
    if (bad.length) throw new Error(bad.join(', '));
  });
  await check('C2 cada dañado: una falla esperada y distinto de su base', () => {
    const baseSha = new Set(fx.filter((f) => f.source !== 'damaged').map((f) => f.sha1));
    for (const f of fx.filter((x) => x.source === 'damaged')) {
      if (!Array.isArray(f.expectedDefects) || f.expectedDefects.length !== 1) throw new Error(f.id + ': expectedDefects');
      const d = f.expectedDefects[0];
      if (!/^T(0[1-9]|1[0-2])$/.test(d.check) || !d.target) throw new Error(f.id + ': ' + JSON.stringify(d));
      if (baseSha.has(f.sha1)) throw new Error(f.id + ': igual a su base');
    }
  });
  const V = require(path.join(distRoot, 'package/v3/mbz-validator-v3.js'));
  await check('C3 sintéticos sanos limpios en el validador v3', async () => {
    for (const f of fx.filter((x) => x.source === 'synthetic')) {
      const exp = JSON.parse(fs.readFileSync(f.path.replace(/\.mbz$/, '.expectations.json'), 'utf8'));
      const r = await V.validateMbzV3(fs.readFileSync(f.path), exp);
      if (!r.ok || r.issues.length) throw new Error(f.id + ': ' + JSON.stringify(r.issues[0]));
    }
  });
  await check('C4 muestra real por familia', () => {
    const fams = Object.keys(M.familyCounts || {}).filter((k) => k !== 'unreadable');
    const have = new Set(fx.filter((f) => f.source === 'real').map((f) => f.family));
    const miss = fams.filter((k) => !have.has(k));
    if (!fams.length || miss.length) throw new Error('faltan: ' + (miss.join(', ') || 'censo vacío'));
  });
  // C5: informativo (nunca falla).
  const exp = JSON.parse(fs.readFileSync(path.join(corpus, 'synthetic', 'v3-A-S.expectations.json'), 'utf8'));
  const rows = [];
  for (const f of fx.filter((x) => x.source === 'damaged' && x.format === 'v3')) {
    const r = await V.validateMbzV3(fs.readFileSync(f.path), exp);
    rows.push(`${f.mutation}=${r.issues.length ? [...new Set(r.issues.map((i) => i.code))].join('+') : 'NO'}`);
  }
  console.log('ℹ️  C5 línea de base validador v3 (con expectativas): ' + rows.join(' · '));
  console.log(`\n${fail ? '❌' : '✅'} check-r107-corpus: ${ok} ok, ${fail} fallidos`);
  process.exit(fail ? 1 : 0);
})();
