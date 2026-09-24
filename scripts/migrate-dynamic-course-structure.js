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

// Guardarraíl de intención explícita: esta migración es solo para staging
// (spec: 2026-09-23-dynamic-course-structure-design.md). No se infiere nada
// de DB_HOST/DB_NAME (los hosts reales de Supabase nunca contienen "staging"
// y DB_NAME siempre es "postgres") — el operador tiene que declararlo.
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — esta migración es para el entorno de\n' +
      '   staging únicamente (spec: 2026-09-23-dynamic-course-structure-design.md).\n' +
      '   deploy-staging.yml lo setea automáticamente; si la corrés a mano contra\n' +
      '   staging, usá: MIGRATION_ENV=staging node scripts/migrate-dynamic-course-structure.js'
    );
    process.exit(1);
  }
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  assertExplicitStagingIntent();

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
      path.resolve(__dirname, '../supabase-migration-dynamic-course-structure.sql'),
      'utf8',
    );
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    console.log('✅ Migración dynamic-course-structure aplicada (o ya estaba aplicada — es idempotente).');
  } catch (err) {
    await client.query('rollback');
    console.error('❌ Migración falló, rollback aplicado:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
