#!/usr/bin/env node
/* eslint-disable no-console */
// Loop 10 C2 — métricas del piloto de UN run dinámico, desde la base (SOLO LECTURA, sin proveedores).
//
//   npm run build && node scripts/pilot-metrics.js <runId> [--dist dist] [--compact]
//
// Conexión: DB_HOST / DB_PORT / DB_USER / DB_PASS / DB_NAME / DB_SSL (y .env del repo si existe), como los demás
// scripts. Todas las consultas corren en una transacción READ ONLY que termina en ROLLBACK: Postgres rechaza cualquier
// escritura. Misma función que el endpoint GET /admin/dynamic-runs/:runId/pilot-metrics (computePilotMetrics); la
// batería de calidad completa necesita leer artifacts del storage, así que aquí sale `battery: null` con el motivo y
// solo la parte de ejercicios guiados que vive en la base (huellas del servidor). Campos: docs/v21/pilot-metrics.md.
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

async function main(argv) {
  const args = argv.slice(2);
  const runId = args.find((a) => !a.startsWith('--') && UUID_RE.test(a));
  const di = args.indexOf('--dist');
  const dist = path.resolve(process.cwd(), di >= 0 ? args[di + 1] : path.join(__dirname, '..', 'dist'));
  if (!runId) {
    console.error('uso: node scripts/pilot-metrics.js <runId (uuid)> [--dist dist] [--compact]');
    return 2;
  }
  let PM;
  try {
    PM = require(path.join(dist, 'modules/dynamic-generation/pilot-metrics.js'));
  } catch (e) {
    console.error(`❌ no se pudo cargar ${dist} (¿npm run build?): ${e.message}`);
    return 2;
  }
  loadEnvFile(path.resolve(__dirname, '..', '.env'));
  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    await client.query('start transaction read only');
    const m = await PM.computePilotMetrics(client, runId, {
      quality: null,
      qualityUnavailableReason: 'CLI solo base: la batería completa lee artifacts del storage; usar GET /admin/dynamic-runs/:runId/pilot-metrics',
    });
    console.log(JSON.stringify(m, null, args.includes('--compact') ? 0 : 2));
    return 0;
  } catch (e) {
    if (e && /pilot_metrics_run_not_found/.test(e.message)) { console.error(`❌ no existe la ejecución dinámica ${runId}`); return 1; }
    throw e;
  } finally {
    try { await client.query('rollback'); } catch { /* sin transacción */ }
    await client.end();
  }
}

if (require.main === module) {
  main(process.argv).then((code) => process.exit(code), (e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
}
module.exports = { main };
