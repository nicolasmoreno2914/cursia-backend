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

// Cursia REL R2: VERIFICA (solo lectura) el esquema de supabase-migration-rel-recovery.sql
// después de migrate-rel-recovery.js: columnas de recuperación de generation_item_runs,
// generation_item_attempts (columnas, índices, un intento abierto por item, trigger de
// inmutabilidad, RLS) y la vista de costo por intento. SOLO staging: la cablea
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
      '   staging, usá: MIGRATION_ENV=staging node scripts/verify-rel-recovery-schema.js'
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
    const problems = verifyRelRecoverySchema(snap);
    if (problems.length) {
      for (const p of problems) console.error('❌ ' + p);
      process.exitCode = 1;
    } else {
      console.log('✅ Esquema REL R2 completo: columnas de recuperación, generation_item_attempts (índices, un intento abierto por item, trigger, RLS) y vista de costos.');
    }
  } catch (err) {
    console.error('❌ Verificación falló:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

const GIR_COLUMNS = {
  failure_class: 'character', failure_code: 'text', recovery_strategy: 'text', recovery_round: 'integer',
  recovery_max_rounds: 'integer', cooldown_until: 'timestamp with time zone', attention_reason: 'text',
};
const GIA_COLUMNS = [
  'id', 'item_run_id', 'job_id', 'course_id', 'item_key', 'generation', 'attempt_no', 'executor_kind', 'executor_id', 'bundle_sha',
  'worker_version', 'started_at', 'heartbeat_at', 'finished_at', 'outcome', 'failure_class', 'failure_code', 'error_excerpt',
  'http_status', 'provider', 'provider_request_id', 'strategy_applied', 'next_retry_at', 'recovery_round', 'actor', 'created_at',
];
const GIA_INDEXES = ['idx_gia_job_item_attempt', 'idx_gia_failure_code', 'idx_gia_item_run', 'uq_gia_open_attempt'];
const GIR_CONSTRAINTS = ['gir_failure_class_check', 'gir_failure_code_len', 'gir_attention_reason_check', 'gir_recovery_rounds_check'];

async function readSchemaSnapshot(client) {
  const cols = (await client.query(
    `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name in ('generation_item_runs', 'generation_item_attempts')`,
  )).rows;
  const idx = (await client.query(`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'generation_item_attempts'`)).rows;
  const cons = (await client.query(
    `select conname, convalidated from pg_constraint where conrelid = 'public.generation_item_runs'::regclass`,
  )).rows;
  const trg = (await client.query(`select tgname from pg_trigger where tgname = 'trg_gia_closed_row_immutable'`)).rows;
  const rls = (await client.query(`select relrowsecurity from pg_class where oid = to_regclass('public.generation_item_attempts')`)).rows;
  const ledger = (await client.query(`select to_regclass('public.generation_cost_events') is not null as ok`)).rows[0];
  const view = (await client.query(`select to_regclass('public.generation_item_attempt_costs') is not null as ok`)).rows[0];
  return { cols, idx, cons, trg, rls: rls[0] ? rls[0].relrowsecurity : null, ledger: !!ledger.ok, view: !!view.ok };
}

/** Puro (testeable): problemas del esquema leído. */
function verifyRelRecoverySchema(s) {
  const out = [];
  const col = (t, c) => s.cols.find((x) => x.table_name === t && x.column_name === c);
  for (const [c, type] of Object.entries(GIR_COLUMNS)) {
    const x = col('generation_item_runs', c);
    if (!x) out.push(`generation_item_runs.${c} no existe (correr scripts/migrate-rel-recovery.js)`);
    else if (x.data_type !== type) out.push(`generation_item_runs.${c}: tipo ${x.data_type} ≠ ${type}`);
  }
  const rr = col('generation_item_runs', 'recovery_round');
  if (rr && (rr.is_nullable !== 'NO' || !/^0$/.test(String(rr.column_default || '').trim()))) out.push('generation_item_runs.recovery_round debe ser not null default 0');
  for (const c of GIR_CONSTRAINTS) {
    const x = s.cons.find((k) => k.conname === c);
    if (!x) out.push(`constraint ${c} no existe`);
    else if (!x.convalidated) out.push(`constraint ${c} sin validar`);
  }
  for (const c of GIA_COLUMNS) if (!col('generation_item_attempts', c)) out.push(`generation_item_attempts.${c} no existe`);
  for (const i of GIA_INDEXES) if (!s.idx.find((x) => x.indexname === i)) out.push(`índice ${i} no existe`);
  const open = s.idx.find((x) => x.indexname === 'uq_gia_open_attempt');
  if (open && !/UNIQUE/i.test(open.indexdef || '') ) out.push('uq_gia_open_attempt debe ser UNIQUE');
  if (open && !/finished_at IS NULL/i.test(open.indexdef || '')) out.push('uq_gia_open_attempt debe ser parcial (finished_at is null)');
  if (!s.trg.length) out.push('trigger trg_gia_closed_row_immutable no existe');
  if (s.rls !== true) out.push('generation_item_attempts sin RLS habilitado');
  if (s.ledger && !s.view) out.push('vista generation_item_attempt_costs no existe (el ledger sí)');
  return out;
}

module.exports = { verifyRelRecoverySchema, readSchemaSnapshot };

if (require.main === module) main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
