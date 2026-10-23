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
// Piloto Formato M (aprobado por el usuario en el chat, 2026-10-11): para la generación real del piloto autorizado (máximo
// estimado USD 105,62) los límites de STAGING pasan a maxCostPerRun 106, maxCostPerCourse 106 y tope mensual 162
// (56,35 ya gastados + 105,62). Misma mecánica: una versión nueva de la política vigente, el resto igual.
//
// T8 (factory mode, 2026-10-18): los límites se pueden fijar desde el .env de staging en el VPS, sin cambiar código,
// así un deploy ya no revierte un tope subido a mano por ops:
//   STAGING_BUDGET_MAX_COST_PER_RUN, STAGING_BUDGET_MAX_COST_PER_COURSE, STAGING_BUDGET_MONTHLY_CAP (USD, > 0).
// Ausentes/vacíos → los defaults de abajo (106 / 106 / 162, sin cambios). Un valor inválido (no numérico, ≤ 0) aborta
// ruidoso (exit 1) en vez de aplicar un tope que nadie pidió. Este código nunca sube ni baja los valores por sí solo.
//
// Uso: MIGRATION_ENV=staging node scripts/staging-budget-policy.js [ownerId]
const fs = require('fs');
const path = require('path');

const KNOWN_PRODUCTION_SUPABASE_REF = 'hriwbakbuypaiovvvkqh';
/** Límites aprobados para staging (USD). */
const STAGING_MAX_COST_PER_RUN = 106;
const STAGING_MAX_COST_PER_COURSE = 106;
const STAGING_MONTHLY_CAP = 162;
const CREATED_BY = 'staging-budget-policy (piloto Formato M: por generación 106, por curso 106, mensual 162 USD; aprobado por el usuario 2026-10-11)';
/** T8: variables del .env de staging que reemplazan los defaults (USD). */
const BUDGET_ENV = Object.freeze({
  maxCostPerRun: 'STAGING_BUDGET_MAX_COST_PER_RUN',
  maxCostPerCourse: 'STAGING_BUDGET_MAX_COST_PER_COURSE',
  monthly: 'STAGING_BUDGET_MONTHLY_CAP',
});
const DEFAULT_TARGET = Object.freeze({ maxCostPerRun: STAGING_MAX_COST_PER_RUN, maxCostPerCourse: STAGING_MAX_COST_PER_COURSE, monthly: STAGING_MONTHLY_CAP });

/**
 * T8 (puro): límites objetivo desde el entorno. → {target, overridden: string[], createdBy} o lanza con el motivo.
 * Cada variable ausente/vacía usa su default; un valor presente debe ser un número finito > 0 (hasta 2 decimales).
 */
function targetFromEnv(env = process.env) {
  const target = { ...DEFAULT_TARGET };
  const overridden = [];
  for (const [k, name] of Object.entries(BUDGET_ENV)) {
    const raw = env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const txt = String(raw).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(txt) || !(Number(txt) > 0)) throw new Error(`${name} inválido ("${txt.slice(0, 40)}"): debe ser un número > 0 en USD (p.ej. 110 o 75.50)`);
    target[k] = Number(txt);
    overridden.push(name);
  }
  const createdBy = overridden.length
    ? `staging-budget-policy (.env de staging: por generación ${target.maxCostPerRun}, por curso ${target.maxCostPerCourse}, mensual ${target.monthly} USD; ${overridden.join(', ')})`
    : CREATED_BY;
  return { target, overridden, createdBy };
}
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
 * Cada valor se guarda con el mismo tipo que tenía (texto → '106', número → 106). El tope mensual va en la clave que ya
 * usa la política (monthlyCap, o monthlyCapStaging, que es la que lee el flujo de aprobación cuando no hay monthlyCap).
 */
function planPolicy(current, target = DEFAULT_TARGET, createdBy = CREATED_BY) {
  if (!current) return { action: 'none' };
  const limits = current.limits && typeof current.limits === 'object' ? current.limits : {};
  const monthlyKey = limits.monthlyCap !== undefined && limits.monthlyCap !== null ? 'monthlyCap' : 'monthlyCapStaging';
  const want = { maxCostPerRun: target.maxCostPerRun, maxCostPerCourse: target.maxCostPerCourse, [monthlyKey]: target.monthly };
  if (Object.keys(want).every((k) => sameNum(limits[k], want[k]))) return { action: 'noop' };
  const next = { ...limits };
  for (const k of Object.keys(want)) next[k] = typeof limits[k] === 'number' ? want[k] : String(want[k]);
  return {
    action: 'insert',
    row: {
      scope: current.scope,
      scope_id: current.scope_id ?? null,
      version: Number(current.version) + 1,
      limits: next,
      require_human_approval_for_real_spend: current.require_human_approval_for_real_spend,
      on_exceed: current.on_exceed,
      created_by: createdBy,
    },
  };
}

/**
 * r62 (review M4): desde r62 la columna require_human_approval_for_real_spend ya no fuerza admin por sí sola y una
 * política con tope por run, por curso y mensual habilita la AUTORIZACIÓN ÚNICA del usuario. Ese cambio de semántica
 * se deja AUDITADO en una versión de la política: el deploy de staging escribe (una vez) una versión con el marcador
 * `limits.approvalSemantics` y un created_by que lo explica. Idempotente: con el marcador ya puesto, no hace nada más.
 * Puro. → plan con el marcador (insert) | el mismo noop/none.
 */
const APPROVAL_SEMANTICS = 'r62_single_authorization';
const SEMANTICS_CREATED_BY = 'staging-budget-policy r62: semántica de autorización única (tope por run + por curso + mensual + mensual por cliente (ownerMonthlyCap) → firma del usuario; admin solo si excede, sin topes o limits.requireHumanApprovalForRealSpend=true)';
function withApprovalSemantics(current, plan) {
  if (!current || plan.action === 'none') return plan;
  if (plan.action === 'insert') {
    if (plan.row.limits && plan.row.limits.approvalSemantics === APPROVAL_SEMANTICS) return plan;
    return { ...plan, row: { ...plan.row, limits: { ...plan.row.limits, approvalSemantics: APPROVAL_SEMANTICS }, created_by: `${plan.row.created_by} · r62 autorización única` } };
  }
  const limits = current.limits && typeof current.limits === 'object' ? current.limits : {};
  if (limits.approvalSemantics === APPROVAL_SEMANTICS) return plan;
  return {
    action: 'insert',
    semanticsOnly: true,
    row: {
      scope: current.scope, scope_id: current.scope_id ?? null, version: Number(current.version) + 1,
      limits: { ...limits, approvalSemantics: APPROVAL_SEMANTICS },
      require_human_approval_for_real_spend: current.require_human_approval_for_real_spend, on_exceed: current.on_exceed,
      created_by: SEMANTICS_CREATED_BY,
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

const fmt = (p) => `${p.scope}${p.scope_id ? ` ${p.scope_id}` : ''} v${p.version} (${p.id || 'nueva'}): maxCostPerRun ${p.limits && p.limits.maxCostPerRun} · maxCostPerCourse ${p.limits && p.limits.maxCostPerCourse} · mensual ${p.limits && (p.limits.monthlyCap ?? p.limits.monthlyCapStaging)} · on_exceed ${p.on_exceed}`;

async function run(env, ownerId) {
  const { target, overridden, createdBy } = targetFromEnv(env);
  if (overridden.length) console.log(`ℹ️  límites desde el .env de staging (${overridden.join(', ')}): ${target.maxCostPerRun} / ${target.maxCostPerCourse} / ${target.monthly}`);
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
    const plan = withApprovalSemantics(cur, planPolicy(cur, target, createdBy));
    if (plan.action === 'none') {
      console.log('⚠️  No hay política de presupuesto global (ni del owner de prueba) en staging: no se inventa una (el gate responde ADMIN_APPROVAL).');
      await c.query('rollback');
      return plan;
    }
    if (plan.action === 'noop') {
      console.log(`✓ La política vigente ya tiene los límites aprobados (${target.maxCostPerRun} / ${target.maxCostPerCourse} / ${target.monthly}) — no se crea otra versión`);
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
    if (plan.semanticsOnly) console.log('+ Política de staging: versión nueva SOLO para registrar la semántica r62 de autorización única (límites iguales)');
    else console.log(`+ Política de staging: nueva versión con por generación ${target.maxCostPerRun}, por curso ${target.maxCostPerCourse} y mensual ${target.monthly} (el resto igual)`);
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
  try {
    targetFromEnv(process.env);
  } catch (e) {
    console.error(`❌ staging-budget-policy: ${e.message}`);
    process.exit(1);
  }
  const ownerArg = process.argv[2] || null;
  if (ownerArg && !UUID_RE.test(ownerArg)) {
    console.error('❌ ownerId inválido (UUID)');
    process.exit(1);
  }
  await run(process.env, ownerArg);
}

module.exports = { APPROVAL_SEMANTICS, withApprovalSemantics, STAGING_MAX_COST_PER_RUN, STAGING_MAX_COST_PER_COURSE, STAGING_MONTHLY_CAP, BUDGET_ENV, targetFromEnv, planPolicy, refusal, dbProjectRef, CREATED_BY };
if (require.main === module) {
  main().catch((err) => {
    console.error(`❌ staging-budget-policy: ${String((err && (err.code || err.message)) || err).slice(0, 200)}`);
    process.exit(1);
  });
}
