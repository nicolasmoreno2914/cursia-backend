#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — R12: validador CLI del .mbz v3 (audit §Q.8). Lee el paquete y
// las expectativas (facts + evaluación resuelta del perfil vigente, tal como
// las devuelve buildDynamicMbzV3 en `expectations`) y lista cada hallazgo.
//
// Usage: node scripts/validate-mbz-v3.js <paquete.mbz> --expect <expectativas.json> [--dist <dist>]
// Salida: una línea por hallazgo (❌ CODE where: message) o ✅; exit 1 si hay alguno.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const mbzPath = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--expect' && args[args.indexOf(a) - 1] !== '--dist');
const expectPath = opt('--expect');
if (!mbzPath || !expectPath) {
  console.error('Usage: node scripts/validate-mbz-v3.js <paquete.mbz> --expect <expectativas.json> [--dist <dist>]');
  process.exit(2);
}
const dist = path.resolve(opt('--dist') || path.join(__dirname, '..', 'dist'));
const { validateMbzV3 } = require(path.join(dist, 'package/v3/mbz-validator-v3.js'));

(async () => {
  const mbz = fs.readFileSync(mbzPath);
  const exp = JSON.parse(fs.readFileSync(expectPath, 'utf8'));
  if (!exp || !exp.facts || !exp.resolved) {
    console.error('❌ el archivo de expectativas debe tener { facts, resolved }');
    process.exit(2);
  }
  const r = await validateMbzV3(mbz, exp);
  for (const i of r.issues) console.log(`❌ ${i.code} ${i.where}: ${i.message}`);
  if (r.ok) console.log(`✅ ${path.basename(mbzPath)}: sin hallazgos (${JSON.stringify(r.stats)})`);
  process.exit(r.ok ? 0 : 1);
})().catch((e) => {
  console.error(`❌ ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
