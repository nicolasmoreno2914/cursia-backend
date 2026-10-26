#!/usr/bin/env node
/* eslint-disable */
// Cursia r75 · A — migración de accesos: institution_memberships, institution_permission_overrides, user_suspensions,
// platform_controls, admin_audit_log (RLS sin políticas + REVOKE; auditoría append-only), columnas nuevas en
// institutions y courses, y authorized_users (user_id, status, SOLO «SELECT de la propia fila»).
// Aditiva, idempotente y SOLO STAGING (MIGRATION_ENV=staging; el ref de producción se rechaza siempre).
// Producción: NUNCA en r75 (EXCLUDED en scripts/prod/migrate-v2-production.js hasta aprobación del owner).
// Uso: MIGRATION_ENV=staging node scripts/migrate-r75-access.js
const fs = require('fs');
const path = require('path');
const G = require('./lib/r75-migration-guard');

async function main() {
  G.loadEnvFile(path.resolve(process.cwd(), '.env'));
  G.assertExplicitStagingIntent('migrate-r75-access.js');
  G.assertNotProductionProject();
  const client = G.pgClient();
  await client.connect();
  client.on('notice', (n) => { if (/^r75:/.test(String(n.message || ''))) console.log('ℹ️  ' + n.message); });
  try {
    const sql = fs.readFileSync(path.resolve(__dirname, '../supabase-migration-r75-access.sql'), 'utf8');
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    console.log('✅ Migración r75-access aplicada (o ya estaba aplicada — es idempotente).');
  } catch (err) {
    try { await client.query('rollback'); } catch { /* ya cerrada */ }
    console.error('❌ Migración r75-access falló, rollback aplicado:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error('❌ Error inesperado:', err.message); process.exitCode = 1; });
