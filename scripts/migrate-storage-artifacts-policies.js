#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Políticas RLS mínimas de Storage para el bucket cursia-artifacts — SOLO
// STAGING. Además del guardarraíl de intención (MIGRATION_ENV=staging) y de la
// lista negra del ref de producción, acá se exige positivamente el ref de
// staging conocido: las políticas de Storage son del proyecto de Supabase del
// frontend de staging y no deben aplicarse en ningún otro proyecto.
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — esta migración es para staging únicamente.\n' +
      '   deploy-staging.yml lo setea automáticamente; a mano:\n' +
      '   MIGRATION_ENV=staging node scripts/migrate-storage-artifacts-policies.js'
    );
    process.exit(1);
  }
}

const KNOWN_PRODUCTION_SUPABASE_REF = 'hriwbakbuypaiovvvkqh';
const KNOWN_STAGING_SUPABASE_REF = 'ljdtmkwuhkvtmlhugjrv';

function extractSupabaseProjectRef() {
  const host = String(process.env.DB_HOST || '');
  const user = String(process.env.DB_USER || '');
  let m = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (m) return m[1].toLowerCase();
  m = user.match(/^postgres\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  return null;
}

function assertStagingProject() {
  const ref = extractSupabaseProjectRef();
  if (ref === KNOWN_PRODUCTION_SUPABASE_REF) {
    console.error('❌ La conexión apunta al proyecto de PRODUCCIÓN (' + ref + '). Abortando.');
    process.exit(1);
  }
  if (ref !== KNOWN_STAGING_SUPABASE_REF) {
    console.error(
      '❌ El ref de proyecto (' + (ref || 'desconocido') + ') no es el de staging conocido (' +
      KNOWN_STAGING_SUPABASE_REF + '). Las políticas de Storage solo se aplican ahí. Abortando.'
    );
    process.exit(1);
  }
  console.log('✅ Ref de proyecto (' + ref + ') = staging conocido.');
}

const EXPECTED_POLICIES = [
  { name: 'cursia_artifacts_insert_own_folder', cmd: 'INSERT' },
  { name: 'cursia_artifacts_select_own_folder', cmd: 'SELECT' },
  { name: 'cursia_artifacts_delete_own_folder', cmd: 'DELETE' },
  { name: 'cursia_artifacts_update_own_folder', cmd: 'UPDATE' },
];

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  assertExplicitStagingIntent();
  assertStagingProject();

  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true'
      ? { rejectUnauthorized: false }
      : false,
  });

  await client.connect();
  try {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../supabase-migration-storage-artifacts-policies.sql'),
      'utf8',
    );
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    console.log('✅ Políticas de Storage de cursia-artifacts aplicadas (o ya existían — es idempotente).');

    // Verificación post-migración: las 3 políticas existen, para el rol
    // authenticated, con el comando esperado y restringidas al bucket.
    const { rows } = await client.query(
      `select policyname, cmd, roles::text as roles, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
         from pg_policies
        where schemaname = 'storage' and tablename = 'objects' and policyname = any($1::text[])`,
      [EXPECTED_POLICIES.map((p) => p.name)],
    );
    let ok = true;
    for (const exp of EXPECTED_POLICIES) {
      const row = rows.find((r) => r.policyname === exp.name);
      const good = row && row.cmd === exp.cmd && row.roles === '{authenticated}' &&
        row.expr.includes('cursia-artifacts') && row.expr.includes('auth.uid()');
      console.log(`  ${good ? '✓' : '❌'} ${exp.name} (${exp.cmd}${row ? ', roles=' + row.roles : ', NO EXISTE'})`);
      if (!good) ok = false;
    }
    if (!ok) {
      console.error('❌ Las políticas de Storage no quedaron como se esperaba');
      process.exitCode = 1;
    }
  } catch (err) {
    try { await client.query('rollback'); } catch { /* sin transacción activa */ }
    console.error('❌ Migración de políticas de Storage falló, rollback aplicado:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
