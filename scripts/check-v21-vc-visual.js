#!/usr/bin/env node
/* eslint-disable */
// R2 (Cursia V2.1) — wrapper del QA visual de Visual Components (scripts/visual/vc-gallery.mjs):
// Chrome headless + purify_html() del Moodle local. Propaga el código de salida (≠ 0 ante
// cualquier fallo). Requiere `npm run build`, Google Chrome y el Moodle local.
//
// Uso: node scripts/check-v21-vc-visual.js   (OUT_DIR / CHROME_BIN / PHP_* / MOODLE_CONFIG opcionales)

const { spawnSync } = require('child_process');
const path = require('path');

const r = spawnSync(process.execPath, [path.join(__dirname, 'visual', 'vc-gallery.mjs')], { stdio: 'inherit', env: process.env });
if (r.error) {
  console.error(`❌ no se pudo ejecutar vc-gallery.mjs: ${r.error.message}`);
  process.exit(1);
}
if (r.status !== 0) {
  console.error(`❌ QA visual de Visual Components falló (exit ${r.status})`);
  process.exit(1);
}
console.log('✅ QA visual de Visual Components: todas las mediciones pasaron');
