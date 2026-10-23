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

function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — este verificador es para el entorno de\n' +
      '   staging únicamente (spec: 2026-09-26-cursia-v21-experience-audit §W).\n' +
      '   deploy-staging.yml lo setea automáticamente; si la corrés a mano contra\n' +
      '   staging, usá: MIGRATION_ENV=staging node scripts/verify-v21-finops-schema.js'
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


// V2.1 RF-a — verificador del schema de FinOps (supabase-migration-v21-finops.sql).
// Solo staging (mismo guardarraíl que la migración). Chequea tablas, columnas,
// constraints, triggers de inmutabilidad y el seed; y hace un probe dentro de
// una transacción que SIEMPRE termina en ROLLBACK (no deja filas): un CHARGE
// válido se inserta, su UPDATE/DELETE se rechazan con P0001 y la misma
// idempotency_key se rechaza con 23505.

const EXPECTED_COLUMNS = {
  pricing_catalog: ['id', 'provider', 'service', 'product_or_model', 'meter', 'unit_size', 'unit_price', 'currency',
    'pricing_version', 'effective_from', 'effective_to', 'source', 'source_ref', 'verified', 'created_at'],
  generation_cost_events: ['id', 'created_at', 'event_kind', 'corrects_event_id', 'owner_id', 'course_id', 'blueprint_id',
    'manifest_id', 'run_id', 'item_run_id', 'item_key', 'item_type', 'item_generation', 'scope', 'module_id', 'chapter_id',
    'operation', 'call_role', 'attempt', 'provider', 'service', 'model_or_product', 'external_operation_id', 'idempotency_key',
    'usage', 'usage_quantity', 'usage_unit', 'pricing_snapshot', 'amount', 'currency', 'cost_source', 'measurement_status',
    'billing_account', 'billable', 'outcome', 'quota_units', 'recorded_by', 'metadata'],
  cost_estimates: ['id', 'created_at', 'scope', 'owner_id', 'course_id', 'manifest_id', 'run_id', 'invalidation_plan_sha',
    'estimator_version', 'pricing_versions', 'usage_model_version', 'lines', 'totals', 'currency'],
  cost_budget_policies: ['id', 'scope', 'scope_id', 'version', 'limits', 'require_human_approval_for_real_spend', 'on_exceed', 'created_at'],
  cost_budget_authorizations: ['id', 'created_at', 'run_id', 'course_id', 'estimate_id', 'authorized_budget', 'policy_id',
    'decision', 'approved_by', 'reason'],
  cost_avoidance_events: ['id', 'created_at', 'run_id', 'item_key', 'action', 'source_item_run_id', 'basis', 'avoided_amount',
    'currency', 'source_charge_event_ids', 'pricing_snapshot'],
};

const EXPECTED_CONSTRAINTS = [
  { conname: 'pricing_catalog_version_key', contype: 'u' },
  { conname: 'gce_idempotency_key', contype: 'u' },
  { conname: 'gce_corrects_kind', contype: 'c' },
  { conname: 'gce_no_estimated', contype: 'c' },
  { conname: 'cae_run_item_key', contype: 'u' },
  { conname: 'cba_admin_approved_by', contype: 'c' },
];

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
    ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  const failures = [];
  try {
    for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
      const res = await client.query(
        `select column_name from information_schema.columns where table_schema='public' and table_name=$1`, [table]);
      const have = res.rows.map((r) => r.column_name);
      if (!have.length) { failures.push(`Tabla "${table}" no existe.`); continue; }
      for (const c of cols) if (!have.includes(c)) failures.push(`Tabla "${table}" no tiene la columna "${c}".`);
      for (const suffix of ['_append_only', '_no_truncate']) {
        const t = await client.query(
          `select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
             join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
            where c.relname = $1 and tg.tgname = $2 and not tg.tgisinternal`, [table, table + suffix]);
        if (!t.rows.length) failures.push(`Falta el trigger "${table + suffix}".`);
      }
    }
    for (const exp of EXPECTED_CONSTRAINTS) {
      const res = await client.query(`select contype from pg_constraint where conname = $1`, [exp.conname]);
      if (!res.rows.length) failures.push(`Falta el constraint "${exp.conname}".`);
      else if (res.rows[0].contype !== exp.contype) failures.push(`Constraint "${exp.conname}" contype=${res.rows[0].contype}, esperado ${exp.contype}.`);
    }
    const seed = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/modules/finops/pricing-seed.v1.json'), 'utf8'));
    for (const r of seed.rows) {
      const res = await client.query(
        `select 1 from public.pricing_catalog where provider=$1 and service=$2 and product_or_model=$3 and meter=$4 and pricing_version=$5`,
        [r.provider, r.service, r.product_or_model, r.meter, r.pricing_version]);
      if (!res.rows.length) failures.push(`Falta la fila de seed ${r.provider}/${r.product_or_model}/${r.meter}@${r.pricing_version}.`);
    }

    if (!failures.length) {
      await client.query('begin');
      try {
        const key = 'verify-v21-finops:' + Date.now();
        const ins = await client.query(
          `insert into public.generation_cost_events
             (event_kind, operation, provider, idempotency_key, amount, cost_source, billing_account, billable, recorded_by)
           values ('CHARGE','llm.unattributed','anthropic',$1,0,'MOCK','mock',false,'verify-v21-finops') returning id`, [key]);
        const id = ins.rows[0].id;
        for (const [label, sql] of [
          ['UPDATE', `update public.generation_cost_events set amount = 1 where id = $1`],
          ['DELETE', `delete from public.generation_cost_events where id = $1`],
        ]) {
          await client.query('savepoint sp');
          let code = null;
          try { await client.query(sql, [id]); } catch (e) { code = e.code; }
          await client.query('rollback to savepoint sp');
          if (code !== 'P0001') failures.push(`${label} sobre generation_cost_events NO fue rechazado con P0001 (código: ${code || 'se permitió'}).`);
        }
        await client.query('savepoint sp');
        let code = null;
        try {
          await client.query(
            `insert into public.generation_cost_events
               (event_kind, operation, provider, idempotency_key, amount, cost_source, billing_account, billable, recorded_by)
             values ('CHARGE','llm.unattributed','anthropic',$1,0,'MOCK','mock',false,'verify-v21-finops')`, [key]);
        } catch (e) { code = e.code; }
        await client.query('rollback to savepoint sp');
        if (code !== '23505') failures.push(`idempotency_key duplicada NO fue rechazada con 23505 (código: ${code || 'se permitió'}).`);
      } finally {
        await client.query('rollback');
      }
    }
  } finally {
    await client.end();
  }
  if (failures.length) {
    console.error('❌ Schema V2.1 FinOps con problemas:');
    for (const f of failures) console.error('   - ' + f);
    process.exitCode = 1;
  } else {
    console.log('✅ Schema V2.1 FinOps verificado (tablas, columnas, constraints, triggers append-only, seed; probe con ROLLBACK).');
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
