#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════════
// check-active-runs.js — guardia de congelamiento de deploy (T8, factory mode).
//
// SOLO LECTURA. Lo corre deploy-staging.yml en el VPS ANTES del rsync (el
// script viaja por stdin: `ssh … "cd $VPS_PATH_STAGING && node - [args]" <
// scripts/ops/check-active-runs.js`, así corre la versión del commit que se
// despliega con el driver pg y el .env que ya están en el VPS). Responde:
// ¿se puede desplegar AHORA sin cambiar código a mitad de un curso?
//
// Bloquea (exit 2) si hay:
//   - runs dynamic_generation activos (worker_status queued | running |
//     retrying | waiting_external | pausing | cancelling);
//   - items generation_item_runs RECLAMADOS (status running con lease vigente);
//   - jobs dynamic_package activos (queued | running | retrying).
// Informa sin bloquear: runs pausados (se reanudarían con el código nuevo) e
// items running con lease vencido (los reclama el auto-healer).
//
// DEPLOY_FREEZE=true (entorno real o .env del directorio actual) bloquea
// TODO deploy (exit 3), haya o no runs activos.
//
// --force: solo reporta, siempre exit 0 (también ante un error de conexión).
// Es el escape explícito (workflow_dispatch con force_deploy=yes).
//
// Nunca escribe: `begin transaction read only` + rollback. Solo imprime ids,
// estados y conteos (sin emails, títulos ni textos de error).
//
// Código de salida: 0 = libre (o --force), 2 = runs/jobs activos,
// 3 = DEPLOY_FREEZE=true, 1 = error (no se pudo consultar → fail closed).
//
// Uso: node scripts/ops/check-active-runs.js [--json] [--force] [--no-env-file]
//      [--env-file <ruta>]   (default: ./.env si existe; solo agrega claves
//      que el entorno real no tiene)
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const ACTIVE_RUN_STATUSES = Object.freeze(['queued', 'running', 'retrying', 'waiting_external', 'pausing', 'cancelling']);
const ACTIVE_PACKAGE_STATUSES = Object.freeze(['queued', 'running', 'retrying']);
const MAX_LIST = 20;
const EXIT = Object.freeze({ CLEAR: 0, ERROR: 1, BUSY: 2, FROZEN: 3 });

function parseArgs(argv) {
  const a = { json: false, force: false, envFile: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') a.json = true;
    else if (x === '--force') a.force = true;
    else if (x === '--no-env-file') a.envFile = null;
    else if (x === '--env-file') {
      a.envFile = argv[++i];
      if (!a.envFile) throw new Error('--env-file requiere una ruta');
    } else if (x === '--help' || x === '-h') a.help = true;
    else throw new Error(`argumento desconocido: ${x}`);
  }
  return a;
}

/** Lee un .env (KEY=VALUE) sin pisar el entorno real. Devuelve el objeto resultante (no toca process.env). */
function mergeEnvFile(env, envPath) {
  const out = { ...env };
  if (!envPath || !fs.existsSync(envPath)) return out;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in out)) out[key] = value;
  }
  return out;
}

function deployFrozen(env) {
  return String(env.DEPLOY_FREEZE ?? '').trim().toLowerCase() === 'true';
}

async function tableExists(query, qualified) {
  const rows = await query('select to_regclass($1) is not null as ok', [qualified]);
  return rows[0] && rows[0].ok === true;
}

/**
 * Estado actual (solo lectura). `query(sql, params) → rows[]` es inyectable (tests sin base).
 * Sin las tablas V2 (base anterior a las migraciones) → nada activo, con nota.
 */
async function collectActivity(query) {
  const out = { activeRuns: [], claimedItems: [], activePackages: [], pausedRuns: [], staleItems: 0, notes: [] };
  const hasPj = await tableExists(query, 'public.production_jobs');
  const hasGir = await tableExists(query, 'public.generation_item_runs');
  if (!hasPj) {
    out.notes.push('production_jobs no existe — nada que bloquear');
    return out;
  }
  out.activeRuns = await query(
    `select id, course_id, worker_status, updated_at
       from public.production_jobs
      where execution_mode = 'dynamic_generation' and worker_status = any($1::text[])
        and coalesce(status, '') <> 'cancelled'
      order by updated_at desc nulls last limit $2`,
    [[...ACTIVE_RUN_STATUSES], MAX_LIST],
  );
  out.activePackages = await query(
    `select id, course_id, worker_status, input_payload->>'runId' as run_id, updated_at
       from public.production_jobs
      where execution_mode = 'dynamic_package' and worker_status = any($1::text[])
        and coalesce(status, '') <> 'cancelled'
      order by updated_at desc nulls last limit $2`,
    [[...ACTIVE_PACKAGE_STATUSES], MAX_LIST],
  );
  out.pausedRuns = await query(
    `select id, course_id, worker_status, output_summary->'pause'->>'reason' as reason
       from public.production_jobs
      where execution_mode = 'dynamic_generation' and worker_status = 'paused'
      order by updated_at desc nulls last limit $1`,
    [MAX_LIST],
  );
  if (hasGir) {
    out.claimedItems = await query(
      `select id, job_id, item_key, worker_id, lease_until
         from public.generation_item_runs
        where status = 'running' and lease_until is not null and lease_until > now()
        order by lease_until desc limit $1`,
      [MAX_LIST],
    );
    const [s] = await query(
      `select count(*)::int as n from public.generation_item_runs
        where status = 'running' and (lease_until is null or lease_until <= now())`,
    );
    out.staleItems = s ? Number(s.n) : 0;
  } else {
    out.notes.push('generation_item_runs no existe — sin items que revisar');
  }
  return out;
}

/** Decisión (pura). */
function decide({ frozen, force, activity, error }) {
  const busy = !!activity && (activity.activeRuns.length + activity.claimedItems.length + activity.activePackages.length) > 0;
  let code;
  let verdict;
  if (error) {
    code = force ? EXIT.CLEAR : EXIT.ERROR;
    verdict = force ? 'error_forced' : 'error';
  } else if (frozen) {
    code = force ? EXIT.CLEAR : EXIT.FROZEN;
    verdict = force ? 'frozen_forced' : 'frozen';
  } else if (busy) {
    code = force ? EXIT.CLEAR : EXIT.BUSY;
    verdict = force ? 'busy_forced' : 'busy';
  } else {
    code = EXIT.CLEAR;
    verdict = 'clear';
  }
  return { code, verdict, busy, frozen: !!frozen, force: !!force };
}

function render(report) {
  const a = report.activity || { activeRuns: [], claimedItems: [], activePackages: [], pausedRuns: [], staleItems: 0, notes: [] };
  const L = [];
  L.push(`deploy freeze guard: ${report.verdict}`);
  if (report.frozen) L.push('  DEPLOY_FREEZE=true — todo deploy está congelado');
  if (report.error) L.push(`  error al consultar: ${report.error}`);
  L.push(`  runs dinámicos activos: ${a.activeRuns.length}`);
  for (const r of a.activeRuns) L.push(`    - run ${r.id} (curso ${r.course_id}) ${r.worker_status}`);
  L.push(`  items reclamados (lease vigente): ${a.claimedItems.length}`);
  for (const r of a.claimedItems) L.push(`    - item ${r.item_key} del run ${r.job_id}`);
  L.push(`  jobs de empaque activos: ${a.activePackages.length}`);
  for (const r of a.activePackages) L.push(`    - package ${r.id} (run ${r.run_id}) ${r.worker_status}`);
  if (a.pausedRuns.length) {
    L.push(`  (info) runs pausados: ${a.pausedRuns.length} — al reanudarse correrán con el código nuevo`);
    for (const r of a.pausedRuns) L.push(`    - run ${r.id} (curso ${r.course_id}) ${r.reason || ''}`.trimEnd());
  }
  if (a.staleItems) L.push(`  (info) items running con lease vencido: ${a.staleItems} (los reclama el auto-healer)`);
  for (const n of a.notes) L.push(`  nota: ${n}`);
  if (report.verdict === 'busy') L.push('  → deploy ABORTADO. Esperar a que terminen, o forzar: workflow_dispatch con force_deploy=yes.');
  if (report.verdict === 'frozen') L.push('  → deploy ABORTADO por DEPLOY_FREEZE. Forzar: workflow_dispatch con force_deploy=yes.');
  if (report.verdict === 'error') L.push('  → deploy ABORTADO (fail closed). Forzar: workflow_dispatch con force_deploy=yes.');
  if (/_forced$/.test(report.verdict)) L.push('  → FORZADO: el deploy sigue igual (force_deploy=yes).');
  return L.join('\n');
}

const redact = (s) => String(s || '').replace(/postgres(ql)?:\/\/[^\s]+/gi, 'postgres://…').replace(/password[^\s,]*/gi, 'password=…').slice(0, 200);

/** Corre la guardia completa con un `query` inyectable. → report (con `code`). */
async function runGuard({ query, env = process.env, force = false }) {
  const frozen = deployFrozen(env);
  let activity = null;
  let error = null;
  try {
    activity = await collectActivity(query);
  } catch (e) {
    error = redact((e && (e.code || e.message)) || e);
  }
  const d = decide({ frozen, force, activity, error });
  return { generatedAt: new Date().toISOString(), ...d, error, activity };
}

async function pgQueryRunner(env) {
  const { Client } = require('pg');
  const c = new Client({
    host: env.DB_HOST, port: Number(env.DB_PORT || 5432), user: env.DB_USER, password: env.DB_PASS, database: env.DB_NAME,
    ssl: String(env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000,
    statement_timeout: 15000,
  });
  await c.connect();
  await c.query('begin transaction read only');
  return {
    query: async (sql, params) => (await c.query(sql, params)).rows,
    close: async () => { await c.query('rollback').catch(() => {}); await c.end().catch(() => {}); },
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`❌ check-active-runs: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
  if (args.help) {
    console.log('Uso: node scripts/ops/check-active-runs.js [--json] [--force] [--no-env-file] [--env-file <ruta>]');
    process.exit(EXIT.CLEAR);
  }
  const envPath = args.envFile === undefined ? path.resolve(process.cwd(), '.env') : args.envFile;
  const env = args.envFile === null ? { ...process.env } : mergeEnvFile(process.env, envPath);
  let runner = null;
  let report;
  try {
    runner = await pgQueryRunner(env);
    report = await runGuard({ query: runner.query, env, force: args.force });
  } catch (e) {
    const d = decide({ frozen: deployFrozen(env), force: args.force, activity: null, error: redact((e && (e.code || e.message)) || e) });
    report = { generatedAt: new Date().toISOString(), ...d, error: redact((e && (e.code || e.message)) || e), activity: null };
  } finally {
    if (runner) await runner.close();
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report));
  process.exit(report.code);
}

module.exports = { ACTIVE_RUN_STATUSES, ACTIVE_PACKAGE_STATUSES, EXIT, parseArgs, mergeEnvFile, deployFrozen, collectActivity, decide, render, runGuard };
// `node - < check-active-runs.js` (deploy-staging.yml): el módulo es `[stdin]` y require.main queda undefined.
if (require.main === module || module.id === '[stdin]') main();
