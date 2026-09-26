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

// V2.1 RF-a — Cost Ledger / FinOps (audit §W.3). Aditiva, idempotente y SOLO
// staging. Crea las 6 tablas de FinOps (supabase-migration-v21-finops.sql) y
// siembra pricing_catalog desde src/modules/finops/pricing-seed.v1.json con
// ON CONFLICT DO NOTHING (las filas del catálogo son inmutables: re-correr
// nunca cambia un precio existente). No depende de otras tablas (FKs lógicas).
//
// Exporta applyV21Finops(client) para los checks locales (Postgres desechable);
// el guardarraíl solo corre cuando se ejecuta como script.
//
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — esta migración es para el entorno de\n' +
      '   staging únicamente (spec: 2026-09-26-cursia-v21-experience-audit §W).\n' +
      '   deploy-staging.yml lo setea automáticamente; si la corrés a mano contra\n' +
      '   staging, usá: MIGRATION_ENV=staging node scripts/migrate-v21-finops.js'
    );
    process.exit(1);
  }
}

// Guardarraíl de identidad de proyecto — ver migrate-dynamic-course-structure.js
// para la explicación completa de por qué es lista negra (ref de producción
// conocido) y no lista blanca (ref de staging sin confirmar para el backend).
const KNOWN_PRODUCTION_SUPABASE_REF = 'hriwbakbuypaiovvvkqh';
const KNOWN_STAGING_SUPABASE_REF_FRONTEND_ONLY = 'ljdtmkwuhkvtmlhugjrv';

function extractSupabaseProjectRef() {
  const host = String(process.env.DB_HOST || '');
  const user = String(process.env.DB_USER || '');
  let m = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (m) return m[1].toLowerCase();
  m = user.match(/^postgres\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  return null;
}

function assertNotProductionProject() {
  const ref = extractSupabaseProjectRef();
  if (ref === KNOWN_PRODUCTION_SUPABASE_REF) {
    console.error(
      '❌ La conexión efectiva (DB_HOST/DB_USER) apunta al proyecto de Supabase\n' +
      '   de PRODUCCIÓN (ref conocido: ' + KNOWN_PRODUCTION_SUPABASE_REF + '). Abortando —\n' +
      '   esto nunca debe correr contra producción, sin importar MIGRATION_ENV.'
    );
    process.exit(1);
  }
  if (ref === null) {
    console.error(
      '❌ No se pudo determinar el ref de proyecto de Supabase desde DB_HOST/\n' +
      '   DB_USER (formato inesperado: ni "db.<ref>.supabase.co" ni pooler\n' +
      '   "postgres.<ref>"). Abortando por seguridad — no se puede confirmar\n' +
      '   que la conexión NO sea producción.'
    );
    process.exit(1);
  }
  if (ref === KNOWN_STAGING_SUPABASE_REF_FRONTEND_ONLY) {
    console.log('✅ Ref de proyecto (' + ref + ') coincide con el de staging conocido (frontend Auth/Storage).');
  } else {
    console.warn(
      '⚠️  El ref de proyecto detectado (' + ref + ') no coincide con el único ref de\n' +
      '   staging conocido en este repo (' + KNOWN_STAGING_SUPABASE_REF_FRONTEND_ONLY + ', confirmado\n' +
      '   solo para Auth/Storage del frontend, no para esta base). Continuando\n' +
      '   porque definitivamente NO es el proyecto de producción — pero esto no\n' +
      '   es una confirmación positiva de que sea staging.'
    );
  }
}

const SQL_PATH = path.resolve(__dirname, '../supabase-migration-v21-finops.sql');
const SEED_PATH = path.resolve(__dirname, '../src/modules/finops/pricing-seed.v1.json');

const SEED_COLUMNS = [
  'provider', 'service', 'product_or_model', 'meter', 'unit_size', 'unit_price', 'currency',
  'pricing_version', 'effective_from', 'effective_to', 'source', 'source_ref', 'verified',
];

function loadPricingSeed(seedPath = SEED_PATH) {
  const doc = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  if (!doc || !Array.isArray(doc.rows) || doc.rows.length === 0) {
    throw new Error('pricing seed inválido: sin rows (' + seedPath + ')');
  }
  for (const r of doc.rows) {
    for (const c of ['provider', 'service', 'product_or_model', 'meter', 'unit_size', 'unit_price', 'currency', 'pricing_version', 'effective_from', 'source']) {
      if (r[c] === undefined || r[c] === null || r[c] === '') throw new Error('pricing seed: fila sin "' + c + '": ' + JSON.stringify(r));
    }
    if (typeof r.verified !== 'boolean') throw new Error('pricing seed: "verified" debe ser boolean explícito: ' + JSON.stringify(r));
  }
  return doc;
}

/** Aplica schema + seed dentro de una transacción ya abierta por el caller (o sin ella). Devuelve filas de seed insertadas. */
async function applyV21Finops(client, opts = {}) {
  const sql = fs.readFileSync(opts.sqlPath || SQL_PATH, 'utf8');
  await client.query(sql);
  return seedPricingCatalog(client, opts);
}

/** Solo el seed de pricing_catalog (ON CONFLICT DO NOTHING). Lo usa también el runner de producción. */
async function seedPricingCatalog(client, opts = {}) {
  const seed = loadPricingSeed(opts.seedPath || SEED_PATH);
  let inserted = 0;
  for (const r of seed.rows) {
    const vals = SEED_COLUMNS.map((c) => (r[c] === undefined ? null : r[c]));
    const res = await client.query(
      `insert into public.pricing_catalog (${SEED_COLUMNS.join(', ')}, created_by)
       values (${SEED_COLUMNS.map((_, i) => '$' + (i + 1)).join(', ')}, $${SEED_COLUMNS.length + 1})
       on conflict (provider, service, product_or_model, meter, pricing_version) do nothing`,
      [...vals, 'migrate-v21-finops:' + seed.seedVersion],
    );
    inserted += res.rowCount || 0;
  }
  return { seedVersion: seed.seedVersion, seedRows: seed.rows.length, inserted };
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  assertExplicitStagingIntent();
  assertNotProductionProject();

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
    await client.query('begin');
    const r = await applyV21Finops(client);
    await client.query('commit');
    console.log('✅ Migración V2.1 FinOps aplicada (o ya estaba aplicada — es idempotente). Seed ' +
      r.seedVersion + ': ' + r.inserted + ' filas nuevas de ' + r.seedRows + '.');
  } catch (err) {
    await client.query('rollback');
    console.error('❌ Migración falló, rollback aplicado:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

module.exports = { applyV21Finops, seedPricingCatalog, loadPricingSeed, SQL_PATH, SEED_PATH };

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error inesperado:', err.message);
    process.exitCode = 1;
  });
}
