#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — controles de la CALIBRACIÓN de proveedores en STAGING (aprobada por Nicolás en el
// chat el 2026-09-26). Solo lo invoca deploy-staging.yml en un dispatch MANUAL (nunca en un push).
//
// Acciones:
//   policy               Política GLOBAL de staging con los límites aprobados (nueva versión solo si la
//                        vigente no es exactamente esa: idempotente). Las políticas son inmutables.
//   authorize <courseId> UNA aprobación ADMIN_APPROVED de $8 para el estimado pendiente del curso de
//                        calibración. Se niega si: el curso no es "[CALIBRATION V2.1] …", ya hay una
//                        aprobación en el curso, el estimado supera $8, o el gasto del mes + $8 supera
//                        el tope mensual de staging ($50).
//   report <courseId>    Solo lectura: runs, estimados, autorizaciones y eventos FinOps del curso
//                        (atribución, precio, liquidación, duplicados por operación del proveedor).
//
// Límites TEMPORALES de calibración, no los comerciales de HD-V21-19. Nunca imprime secretos.
// Uso: MIGRATION_ENV=staging node scripts/staging-v21-calibration.js <policy|authorize|report> [courseId]
const fs = require('fs');
const path = require('path');

const KNOWN_PRODUCTION_SUPABASE_REF = 'hriwbakbuypaiovvvkqh';
const CALIBRATION_TITLE_PREFIX = '[CALIBRATION V2.1]';
const CREATED_BY = 'staging-v21-calibration (aprobado en el chat por Nicolás, 2026-09-26)';

/** Límites aprobados. monthlyCapStaging no lo aplica el gate del run: lo aplica `authorize`. */
const APPROVED = Object.freeze({
  limits: { maxCostPerRun: '10', maxCostPerCourse: '15', monthlyCapStaging: '50' },
  onExceed: 'ADMIN_APPROVAL',
  requireHumanApprovalForRealSpend: true,
  calibrationAuthorization: '8',
});

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

const num = (v) => Number(v);
const sameNum = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && Number(a) === Number(b);

/** ¿La fila vigente ya es exactamente la política aprobada? (pura) */
function policyMatches(row) {
  if (!row) return false;
  const l = row.limits || {};
  const keys = Object.keys(APPROVED.limits);
  if (Object.keys(l).length !== keys.length) return false;
  return keys.every((k) => sameNum(l[k], APPROVED.limits[k]))
    && row.on_exceed === APPROVED.onExceed
    && row.require_human_approval_for_real_spend === APPROVED.requireHumanApprovalForRealSpend;
}

/**
 * Decisión de la aprobación de calibración (pura). Devuelve {ok:true} o {ok:false, reason}.
 * a = { course:{title}, estimate:{totals:{max}}|null, existingApprovals:number, monthSpent:string|number, policy:{limits}|null }
 */
function decideAuthorization(a) {
  if (!a.course) return { ok: false, reason: 'el curso no existe' };
  if (!String(a.course.title || '').startsWith(CALIBRATION_TITLE_PREFIX)) {
    return { ok: false, reason: `el curso no es de calibración (el título debe empezar con "${CALIBRATION_TITLE_PREFIX}")` };
  }
  if (!policyMatches(a.policy)) return { ok: false, reason: 'la política global vigente no es la aprobada (correr la acción policy primero)' };
  if (a.existingApprovals > 0) return { ok: false, reason: 'el curso ya tiene una aprobación ADMIN_APPROVED (solo se autoriza UNA)' };
  if (!a.estimate) return { ok: false, reason: 'no hay un estimado pendiente (sin run ni aprobación) para este curso' };
  const max = num(a.estimate.totals && a.estimate.totals.max);
  const expected = num(a.estimate.totals && a.estimate.totals.expected);
  const budget = num(APPROVED.calibrationAuthorization);
  if (!Number.isFinite(max) || !Number.isFinite(expected)) return { ok: false, reason: 'el estimado no tiene totales numéricos' };
  if (max > budget) return { ok: false, reason: `el máximo estimado (${max}) supera la aprobación de ${budget} USD` };
  const cap = num(a.policy.limits.monthlyCapStaging);
  const spent = num(a.monthSpent || 0);
  if (spent + budget > cap) return { ok: false, reason: `gasto del mes (${spent}) + ${budget} supera el tope mensual de staging (${cap})` };
  return { ok: true };
}

async function connect(env) {
  const { Client } = require('pg');
  const client = new Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    user: env.DB_USER,
    password: env.DB_PASS,
    database: env.DB_NAME,
    ssl: String(env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  return client;
}

async function latestGlobalPolicy(c) {
  const [row] = (await c.query(
    `select id, version, limits, on_exceed, require_human_approval_for_real_spend, created_at
       from public.cost_budget_policies where scope = 'global' order by version desc, created_at desc limit 1`,
  )).rows;
  return row || null;
}

function printPolicy(p) {
  const l = p.limits || {};
  console.log(`  política global v${p.version} (${p.id})`);
  console.log(`    maxCostPerRun ${l.maxCostPerRun} USD · maxCostPerCourse ${l.maxCostPerCourse} USD · tope mensual staging ${l.monthlyCapStaging} USD (lo aplica authorize)`);
  console.log(`    on_exceed ${p.on_exceed} · requireHumanApprovalForRealSpend ${p.require_human_approval_for_real_spend}`);
}

async function actionPolicy(c) {
  const cur = await latestGlobalPolicy(c);
  if (policyMatches(cur)) {
    console.log('✓ La política global vigente ya es la aprobada — no se crea otra versión');
    printPolicy(cur);
    return;
  }
  const version = cur ? Number(cur.version) + 1 : 1;
  const [row] = (await c.query(
    `insert into public.cost_budget_policies (scope, scope_id, version, limits, require_human_approval_for_real_spend, on_exceed, created_by)
     values ('global', null, $1, $2::jsonb, $3, $4, $5)
     returning id, version, limits, on_exceed, require_human_approval_for_real_spend`,
    [version, JSON.stringify(APPROVED.limits), APPROVED.requireHumanApprovalForRealSpend, APPROVED.onExceed, CREATED_BY],
  )).rows;
  console.log('+ Política global de calibración creada');
  printPolicy(row);
}

async function actionAuthorize(c, courseId) {
  const [course] = (await c.query(`select id, title, owner_id from public.courses where id = $1`, [courseId])).rows;
  const policy = await latestGlobalPolicy(c);
  const [{ n: existingApprovals }] = (await c.query(
    `select count(*)::int n from public.cost_budget_authorizations where course_id = $1 and decision = 'ADMIN_APPROVED'`,
    [courseId],
  )).rows;
  const [estimate] = (await c.query(
    `select e.id, e.manifest_id, e.totals from public.cost_estimates e
      where e.course_id = $1 and e.scope = 'run' and e.run_id is null
        and not exists (select 1 from public.cost_budget_authorizations a where a.estimate_id = e.id)
      order by e.created_at desc limit 1`,
    [courseId],
  )).rows;
  const [{ total: monthSpent }] = (await c.query(
    `select coalesce(sum(amount),0)::text total from public.generation_cost_events
      where billing_account = 'cursia' and created_at >= date_trunc('month', now())`,
  )).rows;
  const d = decideAuthorization({ course, estimate: estimate || null, existingApprovals, monthSpent, policy });
  console.log(`  curso #${courseId}: ${course ? JSON.stringify(course.title) : '(no existe)'}`);
  if (estimate) console.log(`  estimado ${estimate.id} (Manifest #${estimate.manifest_id}): ${JSON.stringify(estimate.totals && { min: estimate.totals.min, expected: estimate.totals.expected, max: estimate.totals.max })}`);
  console.log(`  gasto del mes en staging (cursia): ${monthSpent} USD`);
  if (!d.ok) {
    console.log(`✗ Aprobación NO emitida: ${d.reason}`);
    process.exitCode = 1;
    return;
  }
  const [row] = (await c.query(
    `insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, currency, policy_id, decision, approved_by, reason)
     values ($1, $2, $3::numeric, 'USD', $4, 'ADMIN_APPROVED', $5, $6)
     returning id, authorized_budget::text as authorized_budget`,
    [courseId, estimate.id, APPROVED.calibrationAuthorization, policy.id, 'nicolas (aprobación en el chat, 2026-09-26)',
      'calibración de proveedores V2.1 en staging (límite temporal, no comercial)'],
  )).rows;
  console.log(`+ Aprobación ADMIN_APPROVED ${row.id}: ${row.authorized_budget} USD para el estimado ${estimate.id}`);
}

async function actionReport(c, courseId) {
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const [course] = await q(`select id, title, owner_id, structure_version from public.courses where id = $1`, [courseId]);
  if (!course) { console.log(`✗ curso #${courseId} no existe`); process.exitCode = 1; return; }
  console.log(`curso #${course.id} ${JSON.stringify(course.title)} owner ${course.owner_id} (${course.structure_version})`);
  for (const b of await q(`select id, blueprint_number, schema_version, module_count, chapter_count from public.course_blueprints where course_id = $1 order by blueprint_number`, [courseId])) {
    console.log(`  Blueprint #${b.id} n${b.blueprint_number} schema ${b.schema_version} · ${b.module_count} módulo(s) / ${b.chapter_count} capítulo(s)`);
  }
  for (const m of await q(`select id, blueprint_id, rules_version, content_count, scorm_count, video_count, exam_count from public.course_generation_manifests where course_id = $1 order by id`, [courseId])) {
    console.log(`  Manifest #${m.id} (Blueprint #${m.blueprint_id}) rulesVersion ${m.rules_version} · content ${m.content_count} scorm ${m.scorm_count} video ${m.video_count} exam ${m.exam_count}`);
  }
  for (const r of await q(
    `select id, status, worker_status, created_at, input_payload->>'manifestId' manifest_id, input_payload->>'videoMode' video_mode,
            input_payload->'providerModes' provider_modes from public.production_jobs
      where course_id = $1 and execution_mode = 'dynamic_generation' order by created_at`, [courseId])) {
    console.log(`  run ${r.id} Manifest #${r.manifest_id} status ${r.status}/${r.worker_status} video ${r.video_mode} modes ${JSON.stringify(r.provider_modes)}`);
    for (const it of await q(`select id, item_key, type, status, generation, chapter_id from public.generation_item_runs where job_id = $1 order by item_key, generation`, [r.id])) {
      console.log(`    item_run ${it.id} ${it.item_key} (${it.type}) g${it.generation} ${it.status} chapter ${it.chapter_id || '-'}`);
    }
  }
  for (const e of await q(`select id, scope, run_id, manifest_id, totals, created_at from public.cost_estimates where course_id = $1 order by created_at`, [courseId])) {
    const t = e.totals || {};
    console.log(`  estimado ${e.id} scope ${e.scope} run_id ${e.run_id || '-'} Manifest #${e.manifest_id} min ${t.min} expected ${t.expected} max ${t.max} byProvider ${JSON.stringify(Object.fromEntries(Object.entries(t.byProvider || {}).map(([k, v]) => [k, v.expected])))}`);
  }
  for (const a of await q(`select id, run_id, estimate_id, authorized_budget::text ab, decision, reason from public.cost_budget_authorizations where course_id = $1 order by created_at`, [courseId])) {
    console.log(`  autorización ${a.id} ${a.decision} ${a.ab} USD run ${a.run_id || '-'} estimado ${a.estimate_id || '-'} (${a.reason || ''})`);
  }
  const ev = await q(
    `select id, event_kind, provider, service, model_or_product, operation, call_role, attempt, usage, usage_quantity, usage_unit,
            pricing_snapshot, amount::text amount, cost_source, measurement_status, billing_account, outcome, quota_units::text quota_units,
            owner_id, blueprint_id, manifest_id, run_id, item_run_id, item_key, item_type, chapter_id, external_operation_id, idempotency_key, recorded_by, created_at
       from public.generation_cost_events where course_id = $1 order by created_at`, [courseId]);
  console.log(`── ${ev.length} evento(s) FinOps del curso ──`);
  for (const e of ev) {
    const ps = e.pricing_snapshot || {};
    const psTxt = Array.isArray(ps) ? ps.map((p) => `${p.meter}@${p.unit_price}/${p.unit_size}${p.verified === false ? '(no verif.)' : ''}`).join(',')
      : (ps.pricingVersion || ps.pricing_version || Object.keys(ps).slice(0, 4).join('|'));
    console.log(`  ${e.created_at.toISOString ? e.created_at.toISOString() : e.created_at} ${e.event_kind} ${e.provider}/${e.service || '-'}/${e.model_or_product || '-'} op=${e.operation} role=${e.call_role} att=${e.attempt}`);
    console.log(`     amount ${e.amount} ${e.cost_source} ${e.measurement_status} ${e.billing_account} ${e.outcome} usage ${JSON.stringify(e.usage)} qty ${e.usage_quantity || '-'} ${e.usage_unit || ''} quota ${e.quota_units || '-'}`);
    console.log(`     pricing ${psTxt || '-'} · owner ${e.owner_id || '-'} blueprint ${e.blueprint_id || '-'} manifest ${e.manifest_id || '-'} run ${e.run_id || '-'} item_run ${e.item_run_id || '-'} item ${e.item_key || '-'} (${e.item_type || '-'}) chapter ${e.chapter_id || '-'}`);
    console.log(`     providerOp ${e.external_operation_id || '-'} · idem ${e.idempotency_key} · por ${e.recorded_by}`);
  }
  const sum = (f) => ev.filter(f).reduce((s, e) => s + Number(e.amount), 0);
  const byProv = {};
  for (const e of ev) byProv[e.provider] = (byProv[e.provider] || 0) + Number(e.amount);
  console.log(`  total por proveedor: ${JSON.stringify(Object.fromEntries(Object.entries(byProv).map(([k, v]) => [k, v.toFixed(6)])))}`);
  console.log(`  total medido/calculado: ${sum(() => true).toFixed(6)} USD`);
  console.log(`  pending: ${ev.filter((e) => e.measurement_status === 'pending').length}`);
  console.log(`  sin atribuir (sin run o sin item_run): ${ev.filter((e) => !e.run_id || !e.item_run_id).length}`);
  const dup = await q(
    `select provider, external_operation_id, count(*)::int n from public.generation_cost_events
      where course_id = $1 and event_kind = 'CHARGE' and external_operation_id is not null
      group by provider, external_operation_id having count(*) > 1`, [courseId]);
  console.log(`  CHARGE duplicados por operación del proveedor: ${dup.length}${dup.length ? ' ' + JSON.stringify(dup) : ''}`);
  const [{ total: monthSpent }] = await q(`select coalesce(sum(amount),0)::text total from public.generation_cost_events where billing_account = 'cursia' and created_at >= date_trunc('month', now())`);
  console.log(`  gasto del mes en staging (cursia, todos los cursos): ${monthSpent} USD`);
}

async function main() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error('❌ MIGRATION_ENV no es "staging" — calibración exclusiva de staging.');
    process.exit(1);
  }
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  const env = process.env;
  const ref = dbProjectRef(env);
  if (ref === KNOWN_PRODUCTION_SUPABASE_REF || String(env.SUPABASE_URL || '').includes(KNOWN_PRODUCTION_SUPABASE_REF)) {
    console.error('❌ La configuración apunta al proyecto de PRODUCCIÓN — abortado (solo staging).');
    process.exit(1);
  }
  if (ref === null) {
    console.error('❌ No se pudo determinar el ref de Supabase desde DB_HOST/DB_USER — abortado por seguridad.');
    process.exit(1);
  }
  const [action, courseArg] = process.argv.slice(2);
  if (!['policy', 'authorize', 'report'].includes(action)) {
    console.error('uso: staging-v21-calibration.js <policy|authorize|report> [courseId]');
    process.exit(1);
  }
  let courseId = null;
  if (action !== 'policy') {
    if (!/^[0-9]{1,9}$/.test(String(courseArg || ''))) {
      console.error('❌ courseId inválido (entero)');
      process.exit(1);
    }
    courseId = Number(courseArg);
  }
  const c = await connect(env);
  try {
    if (action === 'policy') await actionPolicy(c);
    else if (action === 'authorize') await actionAuthorize(c, courseId);
    else await actionReport(c, courseId);
  } finally {
    await c.end().catch(() => {});
  }
}

module.exports = { APPROVED, policyMatches, decideAuthorization, CALIBRATION_TITLE_PREFIX };
if (require.main === module) {
  main().catch((err) => {
    console.error(`❌ staging-v21-calibration: ${String((err && (err.code || err.message)) || err).slice(0, 200)}`);
    process.exit(1);
  });
}
