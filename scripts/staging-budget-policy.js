#!/usr/bin/env node
/* eslint-disable */
// #583 (decisión del usuario, 2026-10-02) — límite POR GENERACIÓN de STAGING = USD 15.
//
// Una generación normal de 2×2 se estima en ~12.5 USD y la política de staging tenía maxCostPerRun 10:
// cada curso estándar pedía ADMIN_APPROVAL. El usuario aprobó subirlo a 15 SOLO en staging.
//
// Qué hace (idempotente): busca la política que hoy se aplica a las generaciones de staging — la misma
// resolución que FinopsBudgetService.policyFor sin el nivel de curso: la versión más alta de la política
// del OWNER de prueba de staging (si existe) y, si no, la GLOBAL — y, si su maxCostPerRun no es ya 15,
// inserta UNA versión nueva de ESA política (mismo scope/scope_id) con maxCostPerRun = 15 y TODO lo demás
// igual (resto de límites, on_exceed, require_human_approval_for_real_spend). Las políticas son filas
// inmutables: nunca se edita ni borra una versión. Sin política → no inventa una (aviso, exit 0).
//
// No cambia nada más: el presupuesto aprobado de cada run se sigue validando antes de cualquier gasto
// real y nunca se supera solo (flujo de aprobación + runtime guard sin cambios).
//
// SOLO staging: exige MIGRATION_ENV=staging y rechaza el proyecto de Supabase de producción (y un ref
// que no se pueda determinar). Lo invoca deploy-staging.yml ([4h10]); nunca deploy.yml ni el migrador
// de producción. Override SOLO para el check local: NODE_ENV=test + DB_HOST loopback.
//
// Uso: MIGRATION_ENV=staging node scripts/staging-budget-policy.js [ownerId]
const fs = require('fs');
const path = require('path');

const KNOWN_PRODUCTION_SUPABASE_REF = 'hriwbakbuypaiovvvkqh';
/** Límite por generación aprobado para staging (USD). */
const STAGING_MAX_COST_PER_RUN = 15;
const CREATED_BY = 'staging-budget-policy (#583: límite por generación de staging 15 USD, aprobado por el usuario 2026-10-02)';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function dbProjectRef(env) {
  const host = String(env.DB_HOST || '');
  const user = String(env.DB_USER || '');
  let m = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (m) return m[1].toLowerCase();
  m = user.match(/^postgres\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : null;
}
const isLoopback = (h) => ['127.0.0.1', '::1', 'localhost'].includes(String(h || ''));

/** Guardarraíl (puro). → null si puede correr, o el motivo del rechazo. */
function refusal(env) {
  if (env.MIGRATION_ENV !== 'staging') return 'MIGRATION_ENV no es "staging" — este ajuste es exclusivo de staging.';
  const ref = dbProjectRef(env);
  if (ref === KNOWN_PRODUCTION_SUPABASE_REF || String(env.SUPABASE_URL || '').includes(KNOWN_PRODUCTION_SUPABASE_REF)) {
    return 'la configuración apunta al proyecto de PRODUCCIÓN — abortado (solo staging).';
  }
  if (ref === null && !(env.NODE_ENV === 'test' && isLoopback(env.DB_HOST))) {
    return 'no se pudo determinar el ref de Supabase desde DB_HOST/DB_USER — abortado por seguridad.';
  }
  return null;
}

const sameNum = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && Number(a) === Number(b);

/**
 * Plan (puro) sobre la política vigente. → {action:'noop'|'insert'|'none', row?}
 * El valor se guarda con el mismo tipo que tenía (texto → '15', número → 15).
 */
function planPolicy(current, target = STAGING_MAX_COST_PER_RUN) {
  if (!current) return { action: 'none' };
  const limits = current.limits && typeof current.limits === 'object' ? current.limits : {};
  if (sameNum(limits.maxCostPerRun, target)) return { action: 'noop' };
  const value = typeof limits.maxCostPerRun === 'number' ? target : String(target);
  return {
    action: 'insert',
    row: {
      scope: current.scope,
      scope_id: current.scope_id ?? null,
      version: Number(current.version) + 1,
      limits: { ...limits, maxCostPerRun: value },
      require_human_approval_for_real_spend: current.require_human_approval_for_real_spend,
      on_exceed: current.on_exceed,
      created_by: CREATED_BY,
    },
  };
}

async function currentPolicy(c, ownerId) {
  const { rows } = await c.query(
    `select id, scope, scope_id, version, limits, require_human_approval_for_real_spend, on_exceed
       from public.cost_budget_policies
      where ($1::text is not null and scope = 'owner' and scope_id = $1::text) or scope = 'global'
      order by case scope when 'owner' then 0 else 1 end, version desc, created_at desc
      limit 1`,
    [ownerId],
  );
  return rows[0] || null;
}

const fmt = (p) => `${p.scope}${p.scope_id ? ` ${p.scope_id}` : ''} v${p.version} (${p.id || 'nueva'}): maxCostPerRun ${p.limits && p.limits.maxCostPerRun} · maxCostPerCourse ${p.limits && p.limits.maxCostPerCourse} · on_exceed ${p.on_exceed}`;

async function run(env, ownerId) {
  const { Client } = require('pg');
  const c = new Client({
    host: env.DB_HOST, port: Number(env.DB_PORT || 5432), user: env.DB_USER, password: env.DB_PASS, database: env.DB_NAME,
    ssl: String(env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  try {
    await c.query('begin');
    // Dos deploys a la vez nunca insertan dos versiones (además del índice único scope/scope_id/version).
    await c.query(`select pg_advisory_xact_lock(hashtext('cursia:staging-budget-policy'))`);
    const cur = await currentPolicy(c, ownerId);
    const plan = planPolicy(cur);
    if (plan.action === 'none') {
      console.log('⚠️  No hay política de presupuesto global (ni del owner de prueba) en staging: no se inventa una (el gate responde ADMIN_APPROVAL).');
      await c.query('rollback');
      return plan;
    }
    if (plan.action === 'noop') {
      console.log(`✓ La política vigente ya tiene maxCostPerRun ${STAGING_MAX_COST_PER_RUN} — no se crea otra versión`);
      console.log(`  ${fmt(cur)}`);
      await c.query('rollback');
      return plan;
    }
    const r = plan.row;
    const { rows } = await c.query(
      `insert into public.cost_budget_policies (scope, scope_id, version, limits, require_human_approval_for_real_spend, on_exceed, created_by)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7)
       returning id, scope, scope_id, version, limits, on_exceed`,
      [r.scope, r.scope_id, r.version, JSON.stringify(r.limits), r.require_human_approval_for_real_spend, r.on_exceed, r.created_by],
    );
    await c.query('commit');
    console.log(`+ Política de staging: nueva versión con maxCostPerRun ${STAGING_MAX_COST_PER_RUN} (el resto igual)`);
    console.log(`  antes:   ${fmt(cur)}`);
    console.log(`  después: ${fmt(rows[0])}`);
    return { ...plan, inserted: rows[0] };
  } catch (err) {
    await c.query('rollback').catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

async function main() {
  // La intención (MIGRATION_ENV) y el override de test vienen del entorno REAL del proceso, nunca del .env.
  const intent = { MIGRATION_ENV: process.env.MIGRATION_ENV, NODE_ENV: process.env.NODE_ENV };
  if (intent.MIGRATION_ENV !== 'staging') {
    console.error(`❌ staging-budget-policy: ${refusal(intent)}`);
    process.exit(1);
  }
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  const why = refusal({ ...process.env, ...intent });
  if (why) {
    console.error(`❌ staging-budget-policy: ${why}`);
    process.exit(1);
  }
  const ownerArg = process.argv[2] || null;
  if (ownerArg && !UUID_RE.test(ownerArg)) {
    console.error('❌ ownerId inválido (UUID)');
    process.exit(1);
  }
  await run(process.env, ownerArg);
}

module.exports = { STAGING_MAX_COST_PER_RUN, planPolicy, refusal, dbProjectRef, CREATED_BY };
if (require.main === module) {
  main().catch((err) => {
    console.error(`❌ staging-budget-policy: ${String((err && (err.code || err.message)) || err).slice(0, 200)}`);
    process.exit(1);
  });
}
