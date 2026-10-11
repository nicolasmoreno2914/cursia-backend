#!/usr/bin/env node
/* eslint-disable */
// Loop 4: copia del código de generación del navegador (campuscloud-gen/src/js) que corre el worker de IA del backend.
//   node scripts/sync-dynamic-executor-vendor.js [--from ../campuscloud-gen]   → copia
//   node scripts/sync-dynamic-executor-vendor.js --check [--from …]           → falla si difiere (gate)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FILES = ['05-libro.js', '06-scorms.js', '06b-scorm-templates.js', '42-scorm-templates-ui.js', '07-examenes.js', '08-downloads.js', '44-dynamic-prompt-builders.js', '46-dynamic-context-package.js', '24-backend-client.js', '45-dynamic-generation-executor.js'];
const args = process.argv.slice(2);
const check = args.includes('--check');
const fromIdx = args.indexOf('--from');
const fe = path.resolve(fromIdx >= 0 ? args[fromIdx + 1] : (process.env.CURSIA_FRONTEND_REPO || path.join(__dirname, '..', '..', 'campuscloud-gen')));
const dest = path.join(__dirname, '..', 'vendor', 'dynamic-executor');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let diff = 0;
for (const f of FILES) {
  const src = path.join(fe, 'src', 'js', f);
  if (!fs.existsSync(src)) { console.error(`❌ falta ${src}`); process.exit(2); }
  const a = fs.readFileSync(src);
  const dst = path.join(dest, f);
  const b = fs.existsSync(dst) ? fs.readFileSync(dst) : Buffer.alloc(0);
  if (sha(a) !== sha(b)) {
    diff++;
    if (check) console.error(`❌ vendor desalineado: ${f}`);
    else { fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(dst, a); console.log(`copiado ${f}`); }
  }
}
if (check) {
  if (diff) { console.error(`❌ ${diff} archivo(s) del ejecutor difieren de ${fe}: correr scripts/sync-dynamic-executor-vendor.js`); process.exit(1); }
  console.log(`✅ vendor del ejecutor alineado con ${fe}`);
}
