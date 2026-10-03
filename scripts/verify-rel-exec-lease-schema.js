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

// Cursia REL: VERIFICA (solo lectura) el esquema de supabase-migration-rel-exec-lease.sql después de
// migrate-rel-exec-lease.js: columnas del lease de ejecución en production_jobs, sus constraints
// validadas y el trigger que lo suelta al terminar/cancelar el run. SOLO staging: la cablea
// deploy-staging.yml (nunca deploy.yml).
//
// Guardarraíl de intención explícita: esta migración es solo para staging.
// No se infiere nada de DB_HOST/DB_NAME — el operador tiene que
// declararlo. Mismo patrón que migrate-generation-manifests.js.
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — esta migración es para el entorno de\n' +
      '   staging únicamente (spec: docs/v21 cursia-v21-experience-audit §S).\n' +
      '   deploy-staging.yml lo setea automáticamente; si la corrés a mano contra\n' +
      '   staging, usá: MIGRATION_ENV=staging node scripts/verify-rel-exec-lease-schema.js'
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
    const snap = await readSchemaSnapshot(client);
    const problems = verifyRelExecLeaseSchema(snap);
    if (problems.length) {
      for (const p of problems) console.error('❌ ' + p);
      process.exitCode = 1;
    } else {
      console.log('✅ Esquema REL lease de ejecución completo: production_jobs.executor_lease_holder / executor_lease_expires_at, constraints y trigger de liberación.');
    }
  } catch (err) {
    console.error('❌ Verificación falló:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

const PJ_COLUMNS = { executor_lease_holder: 'text', executor_lease_expires_at: 'timestamp with time zone' };
const PJ_CONSTRAINTS = ['pj_exec_lease_holder_len', 'pj_exec_lease_pair'];
const TRIGGER = 'trg_pj_release_exec_lease';

async function readSchemaSnapshot(client) {
  const cols = (await client.query(
    `select column_name, data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'production_jobs'
        and column_name in ('executor_lease_holder', 'executor_lease_expires_at')`,
  )).rows;
  const cons = (await client.query(
    `select conname, convalidated from pg_constraint where conrelid = 'public.production_jobs'::regclass and conname = any($1::text[])`,
    [PJ_CONSTRAINTS],
  )).rows;
  const trg = (await client.query(
    `select tgname, tgenabled, pg_get_triggerdef(oid) as def from pg_trigger
      where tgrelid = 'public.production_jobs'::regclass and tgname = $1 and not tgisinternal`,
    [TRIGGER],
  )).rows;
  return { cols, cons, trg };
}

/** Puro (testeable): problemas del esquema leído. */
function verifyRelExecLeaseSchema(s) {
  const out = [];
  for (const [c, type] of Object.entries(PJ_COLUMNS)) {
    const x = s.cols.find((k) => k.column_name === c);
    if (!x) out.push(`production_jobs.${c} no existe (correr scripts/migrate-rel-exec-lease.js)`);
    else if (x.data_type !== type) out.push(`production_jobs.${c}: tipo ${x.data_type} ≠ ${type}`);
    else if (x.is_nullable !== 'YES') out.push(`production_jobs.${c} debe ser nullable`);
  }
  for (const c of PJ_CONSTRAINTS) {
    const x = s.cons.find((k) => k.conname === c);
    if (!x) out.push(`constraint ${c} no existe`);
    else if (!x.convalidated) out.push(`constraint ${c} sin validar`);
  }
  const t = s.trg[0];
  if (!t) out.push(`trigger ${TRIGGER} no existe`);
  else {
    if (t.tgenabled === 'D') out.push(`trigger ${TRIGGER} deshabilitado`);
    if (!/BEFORE UPDATE/i.test(t.def || '')) out.push(`trigger ${TRIGGER} debe ser BEFORE UPDATE`);
  }
  return out;
}

module.exports = { verifyRelExecLeaseSchema, readSchemaSnapshot };

if (require.main === module) main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
