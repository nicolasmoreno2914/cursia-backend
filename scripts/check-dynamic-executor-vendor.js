#!/usr/bin/env node
/* eslint-disable */
// Loop 4 (gate): el código de generación que corre el worker de IA es EXACTAMENTE el del navegador.
// Sin el repo del frontend (CURSIA_FRONTEND_REPO) se omite con aviso (CI del backend solo).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const fe = process.env.CURSIA_FRONTEND_REPO;
if (!fe || !fs.existsSync(path.join(fe, 'src', 'js', '45-dynamic-generation-executor.js'))) {
  console.log('⚠️  sin CURSIA_FRONTEND_REPO: se omite la comparación del vendor del ejecutor');
  console.log('\n1 ok, 0 fail');
  process.exit(0);
}
const r = spawnSync(process.execPath, [path.join(__dirname, 'sync-dynamic-executor-vendor.js'), '--check', '--from', fe], { encoding: 'utf8' });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
console.log(`\n${r.status === 0 ? 1 : 0} ok, ${r.status === 0 ? 0 : 1} fail`);
process.exit(r.status === 0 ? 0 : 1);
