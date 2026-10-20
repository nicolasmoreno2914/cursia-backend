#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════════
// v2-schema-probes.js — r61: ¿el esquema de Cursia V2 está COMPLETO en esta
// base? Sondas de CATÁLOGO, SOLO LECTURA (pg_class / pg_attribute /
// pg_constraint / pg_indexes / pg_trigger / pg_policies + pricing_catalog).
//
// Dos usos:
//   1. Módulo: scripts/prod/migrate-v2-production.js --verify-only lo usa como
//      verificación interna de TODOS los pasos del plan (en particular los 6
//      pasos de r60 que no tienen verify-* en modo production-readonly:
//      pedagogy-profiles, practice-chapters, application-activities,
//      guided-practice, academic-context, prebrief).
//   2. CLI AUTOCONTENIDO (solo requiere `pg`): .github/workflows/deploy.yml lo
//      corre en el VPS ANTES del rsync, por stdin, con el .env y el driver pg
//      que ya están allí:
//        ssh … "cd '$VPS_PATH' && node - --pricing-keys-b64 <b64>" < scripts/prod/v2-schema-probes.js
//      Si falta cualquier pieza del esquema V2 (o una fila del seed de precios
//      v1), el deploy de producción se ABORTA sin tocar nada (fail closed): el
//      esquema se migra SOLO con el workflow protegido
//      v2-production-migrations.yml, nunca desde deploy.yml.
//
// Nunca escribe: `begin transaction read only` + rollback. Solo imprime
// nombres de objetos y conteos (nunca valores del .env ni datos de filas).
//
// Exit: 0 = esquema completo, 4 = incompleto (lista qué falta), 1 = error de
// conexión/consulta (fail closed), 2 = uso inválido.
//
// Uso: node scripts/prod/v2-schema-probes.js [--json] [--no-env-file | --env-file <ruta>]
//        [--pricing-keys-b64 <b64 JSON [[provider,service,model,meter,pricing_version],…]>]
//        [--info-pricing-keys-b64 <b64>]   (faltantes = aviso, no fatal; p. ej. la propuesta r60)
//        [--skip-storage-policies] [--steps id1,id2]
//      (default: ./.env del cwd si existe; solo agrega claves que el entorno real no tiene)
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const EXIT = Object.freeze({ READY: 0, ERROR: 1, USAGE: 2, NOT_READY: 4 });

// ── Sondas por paso del plan (mismo id que MIGRATION_STEPS del runner) ─────
const T = (table) => ({ kind: 'table', table });
const C = (table, column) => ({ kind: 'column', table, column });
const K = (table, conname, includes = []) => ({ kind: 'constraint', table, conname, includes });
const F = (fn) => ({ kind: 'function', fn });
const TG = (table, trigger) => ({ kind: 'trigger', table, trigger });
const IX = (index, includes = []) => ({ kind: 'index', index, includes });
const RLS = (table) => ({ kind: 'rls', table });
const V = (view) => ({ kind: 'view', view });
const POL = (policy) => ({ kind: 'storage_policy', policy });

const FINOPS_TABLES = ['pricing_catalog', 'generation_cost_events', 'cost_estimates', 'cost_budget_policies',
  'cost_budget_authorizations', 'cost_avoidance_events'];

const PROBES = Object.freeze([
  { step: 'production-jobs-constraints', probes: [
    K('production_jobs', 'production_jobs_execution_mode_check', ['dynamic_generation', 'dynamic_package']),
    K('production_jobs', 'production_jobs_worker_status_check', ['paused', 'preview']),
  ] },
  { step: 'dynamic-course-structure', probes: [
    T('course_modules'), T('course_chapters'),
    C('courses', 'structure_version'), C('courses', 'structure_version_counter'), C('course_versions', 'locked_at'),
    C('artifacts', 'module_id'), C('artifacts', 'chapter_id'), C('production_jobs', 'blueprint_version_id'),
  ] },
  { step: 'course-blueprints', probes: [T('course_blueprints'), C('courses', 'current_blueprint_id'), F('course_blueprints_forbid_update')] },
  { step: 'v21-blueprint-profiles', probes: [
    T('course_profiles'), C('courses', 'final_exam_enabled'), C('courses', 'activity_engine'), C('course_chapters', 'activity_enabled'),
  ] },
  // ── r60: los 6 pasos que antes eran solo de staging ──
  { step: 'pedagogy-profiles', probes: [K('course_profiles', 'course_profiles_kind_check', ['pedagogy'])] },
  { step: 'practice-chapters', probes: [
    C('course_chapters', 'chapter_kind'), K('course_chapters', 'course_chapters_chapter_kind_check', ['practice']),
  ] },
  { step: 'generation-manifests', probes: [T('course_generation_manifests'), F('course_generation_manifests_forbid_update')] },
  { step: 'dynamic-generation', probes: [
    T('generation_item_runs'), T('generation_run_contexts'), C('artifacts', 'manifest_id'), C('artifacts', 'item_run_id'),
    IX('uq_dynamic_generation_active_run'),
  ] },
  { step: 'dynamic-generation-v2', probes: [
    C('generation_item_runs', 'scope'), C('course_generation_manifests', 'course_plan_count'), F('generation_item_runs_default_scope'),
  ] },
  { step: 'invalidation-carried-from', probes: [C('generation_item_runs', 'carried_from_item_run_id')] },
  { step: 'v21-manifest-v3', probes: [
    K('generation_item_runs', 'gir_type_check', ['final_exam', 'audio_welcome']), C('course_generation_manifests', 'final_exam_count'),
  ] },
  { step: 'application-activities', probes: [
    C('course_chapters', 'application_minutes'), K('course_chapters', 'course_chapters_application_minutes_check'),
    C('course_generation_manifests', 'application_activity_count'),
    K('generation_item_runs', 'gir_type_check', ['application_activity']),
    K('course_generation_manifests', 'cgm_counts_consistent', ['application_activity_count']),
  ] },
  { step: 'guided-practice', probes: [
    C('course_chapters', 'guided_practice_minutes'), K('course_chapters', 'course_chapters_guided_practice_minutes_check'),
    C('course_generation_manifests', 'guided_practice_count'),
    K('generation_item_runs', 'gir_type_check', ['guided_practice']),
    K('course_generation_manifests', 'cgm_counts_consistent', ['guided_practice_count']),
  ] },
  { step: 'academic-context', probes: [
    K('course_profiles', 'course_profiles_kind_check', ['academic']),
    C('course_chapters', 'outcome_ids'), K('course_chapters', 'course_chapters_outcome_ids_check'),
  ] },
  { step: 'prebrief', probes: [
    T('course_prebrief_versions'), T('course_prebrief_events'), T('course_prebrief_pdfs'),
    RLS('course_prebrief_versions'), RLS('course_prebrief_events'), RLS('course_prebrief_pdfs'),
    TG('course_prebrief_versions', 'course_prebrief_versions_guard'),
    TG('course_prebrief_events', 'course_prebrief_events_append_only'),
    TG('course_prebrief_pdfs', 'course_prebrief_pdfs_append_only'),
  ] },
  // ── resto del plan ──
  { step: 'v21-finops', probes: [...FINOPS_TABLES.map(T), F('finops_forbid_mutation')] },
  { step: 'v21-finops-rls', probes: [...FINOPS_TABLES.map(RLS), RLS('course_profiles')] },
  { step: 'ev6-h5p2', probes: [C('courses', 'review_cards_enabled')] },
  { step: 'rel-recovery', probes: [
    T('generation_item_attempts'), RLS('generation_item_attempts'), C('generation_item_runs', 'failure_class'),
    C('generation_item_runs', 'cooldown_until'), V('generation_item_attempt_costs'),
  ] },
  { step: 'rel-exec-lease', probes: [
    C('production_jobs', 'executor_lease_holder'), C('production_jobs', 'executor_lease_expires_at'),
    TG('production_jobs', 'trg_pj_release_exec_lease'),
  ] },
  { step: 'run-pause', probes: [IX('uq_dynamic_generation_active_run', ['paused'])] },
  { step: 'llm-worker-presence', probes: [T('llm_worker_presence'), RLS('llm_worker_presence')] },
  { step: 'storage-artifacts-policies', optional: 'storage', probes: [
    POL('cursia_artifacts_insert_own_folder'), POL('cursia_artifacts_select_own_folder'),
    POL('cursia_artifacts_delete_own_folder'), POL('cursia_artifacts_update_own_folder'),
  ] },
]);

/** Las 6 que r60 agregó al plan de producción (antes solo staging). */
const R60_STEPS = Object.freeze(['pedagogy-profiles', 'practice-chapters', 'application-activities', 'guided-practice', 'academic-context', 'prebrief']);

function describeProbe(p) {
  switch (p.kind) {
    case 'table': return `tabla public.${p.table}`;
    case 'column': return `columna public.${p.table}.${p.column}`;
    case 'constraint': return `constraint ${p.conname} en public.${p.table}${p.includes.length ? ' ⊇ ' + p.includes.join(',') : ''}`;
    case 'function': return `función public.${p.fn}()`;
    case 'trigger': return `trigger ${p.trigger} en public.${p.table}`;
    case 'index': return `índice public.${p.index}${p.includes.length ? ' ⊇ ' + p.includes.join(',') : ''}`;
    case 'rls': return `RLS en public.${p.table}`;
    case 'view': return `vista public.${p.view}`;
    case 'storage_policy': return `política ${p.policy} en storage.objects`;
    default: return JSON.stringify(p);
  }
}

/** Una sonda → true/false. `query(sql, params) → rows[]`. Solo SELECT de catálogo. */
async function evalProbe(query, p) {
  switch (p.kind) {
    case 'table': {
      const r = await query(`select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1 and c.relkind in ('r','p')`, [p.table]);
      return r.length > 0;
    }
    case 'view': {
      const r = await query(`select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1 and c.relkind in ('v','m')`, [p.view]);
      return r.length > 0;
    }
    case 'column': {
      const r = await query(`select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1 and a.attname = $2 and a.attnum > 0 and not a.attisdropped`, [p.table, p.column]);
      return r.length > 0;
    }
    case 'constraint': {
      const r = await query(`select pg_get_constraintdef(k.oid) as def from pg_constraint k
        join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1 and k.conname = $2`, [p.table, p.conname]);
      if (!r.length) return false;
      return p.includes.every((s) => String(r[0].def).includes(s));
    }
    case 'function': {
      const r = await query(`select 1 from pg_proc f join pg_namespace n on n.oid = f.pronamespace
        where n.nspname = 'public' and f.proname = $1`, [p.fn]);
      return r.length > 0;
    }
    case 'trigger': {
      const r = await query(`select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1 and t.tgname = $2 and not t.tgisinternal`, [p.table, p.trigger]);
      return r.length > 0;
    }
    case 'index': {
      const r = await query(`select indexdef from pg_indexes where schemaname = 'public' and indexname = $1`, [p.index]);
      if (!r.length) return false;
      return p.includes.every((s) => String(r[0].indexdef).includes(s));
    }
    case 'rls': {
      const r = await query(`select c.relrowsecurity as on from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1`, [p.table]);
      return r.length > 0 && r[0].on === true;
    }
    case 'storage_policy': {
      const r = await query(`select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = $1`, [p.policy]);
      return r.length > 0;
    }
    default:
      throw new Error(`sonda desconocida: ${p.kind}`);
  }
}

function decodeKeys(b64, label) {
  if (!b64) return null;
  let arr;
  try {
    arr = JSON.parse(Buffer.from(String(b64), 'base64').toString('utf8'));
  } catch (e) {
    throw new Error(`${label}: base64/JSON inválido`);
  }
  if (!Array.isArray(arr) || arr.some((k) => !Array.isArray(k) || k.length !== 5 || k.some((x) => typeof x !== 'string' || !x))) {
    throw new Error(`${label}: se espera [[provider,service,product_or_model,meter,pricing_version], …]`);
  }
  return arr;
}

/** Claves (5-tupla) de un seed/propuesta de precios (JSON con `rows`). Lo usa deploy.yml en el runner. */
function pricingKeysOf(doc, { verifiedOnly = false } = {}) {
  return (doc.rows || [])
    .filter((r) => !verifiedOnly || r.verified === true)
    .map((r) => [r.provider, r.service, r.product_or_model, r.meter, r.pricing_version].map(String));
}

async function missingPricingKeys(query, keys) {
  const missing = [];
  for (const k of keys) {
    const r = await query(`select 1 from public.pricing_catalog where provider = $1 and service = $2 and product_or_model = $3
      and meter = $4 and pricing_version = $5 limit 1`, k);
    if (!r.length) missing.push(k);
  }
  return missing;
}

/**
 * Corre las sondas con un `query` inyectable (tests sin base). → report.
 * opts: { steps?: string[], skipStorage?: boolean, pricingKeys?: [][], infoPricingKeys?: [][] }
 */
async function runProbes(query, opts = {}) {
  const wanted = opts.steps && opts.steps.length ? new Set(opts.steps) : null;
  const unknown = wanted ? [...wanted].filter((s) => !PROBES.some((g) => g.step === s)) : [];
  if (unknown.length) throw new Error(`pasos desconocidos: ${unknown.join(', ')}`);
  const steps = [];
  for (const g of PROBES) {
    if (wanted && !wanted.has(g.step)) continue;
    if (g.optional === 'storage' && opts.skipStorage) { steps.push({ step: g.step, skipped: true, ok: true, missing: [] }); continue; }
    const missing = [];
    for (const p of g.probes) if (!(await evalProbe(query, p))) missing.push(describeProbe(p));
    steps.push({ step: g.step, ok: missing.length === 0, missing });
  }
  const notes = [];
  let pricing = null;
  const hasPricing = steps.find((s) => s.step === 'v21-finops');
  const pricingTableOk = !hasPricing || hasPricing.ok;
  if (opts.pricingKeys) {
    pricing = { expected: opts.pricingKeys.length, missing: pricingTableOk ? await missingPricingKeys(query, opts.pricingKeys) : opts.pricingKeys };
  }
  let infoPricing = null;
  if (opts.infoPricingKeys && pricingTableOk) {
    infoPricing = { expected: opts.infoPricingKeys.length, missing: await missingPricingKeys(query, opts.infoPricingKeys) };
  }
  if (pricingTableOk && hasPricing) {
    const [b] = await query(`select count(*)::int as n from public.cost_budget_policies`);
    if (b && Number(b.n) === 0) notes.push('cost_budget_policies vacía: todo run V2 iría a ADMIN_APPROVAL (definir la política de producción antes del canario)');
  }
  const ok = steps.every((s) => s.ok) && (!pricing || pricing.missing.length === 0);
  return { ok, steps, pricing, infoPricing, notes };
}

function render(report) {
  const L = [];
  L.push(`esquema V2: ${report.ok ? 'COMPLETO' : 'INCOMPLETO'}`);
  for (const s of report.steps) {
    if (s.skipped) { L.push(`  ⏭️  ${s.step} (omitido)`); continue; }
    L.push(`  ${s.ok ? '✓' : '❌'} ${s.step}${R60_STEPS.includes(s.step) ? ' [r60]' : ''}`);
    for (const m of s.missing) L.push(`      falta: ${m}`);
  }
  if (report.pricing) {
    L.push(`  ${report.pricing.missing.length ? '❌' : '✓'} seed de precios: ${report.pricing.expected - report.pricing.missing.length}/${report.pricing.expected} filas presentes`);
    for (const k of report.pricing.missing.slice(0, 10)) L.push(`      falta: ${k.join(' / ')}`);
  }
  if (report.infoPricing) {
    L.push(`  (info) filas extra de precios: ${report.infoPricing.expected - report.infoPricing.missing.length}/${report.infoPricing.expected} presentes${report.infoPricing.missing.length ? ' — sembrarlas requiere aprobación del owner (runbook)' : ''}`);
  }
  for (const n of report.notes) L.push(`  (info) ${n}`);
  if (!report.ok) L.push('  → el esquema se migra SOLO con .github/workflows/v2-production-migrations.yml (apply, aprobación del owner). Ver docs/v2-production-promotion-runbook.md.');
  return L.join('\n');
}

function parseArgs(argv) {
  const a = { json: false, envFile: undefined, pricingB64: null, infoPricingB64: null, skipStorage: false, steps: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${x} requiere un valor`); return v; };
    if (x === '--json') a.json = true;
    else if (x === '--no-env-file') a.envFile = null;
    else if (x === '--env-file') a.envFile = val();
    else if (x === '--pricing-keys-b64') a.pricingB64 = val();
    else if (x === '--info-pricing-keys-b64') a.infoPricingB64 = val();
    else if (x === '--skip-storage-policies') a.skipStorage = true;
    else if (x === '--steps') a.steps = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (x === '--help' || x === '-h') a.help = true;
    else throw new Error(`argumento desconocido: ${x}`);
  }
  return a;
}

/** Lee un .env (KEY=VALUE) sin pisar el entorno real (mismo criterio que scripts/ops/check-active-runs.js). */
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

const redact = (s) => String(s || '').replace(/postgres(ql)?:\/\/[^\s]+/gi, 'postgres://…').replace(/password[^\s,]*/gi, 'password=…').slice(0, 200);

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`❌ v2-schema-probes: ${e.message}`);
    process.exit(EXIT.USAGE);
  }
  if (args.help) {
    console.log('Uso: node scripts/prod/v2-schema-probes.js [--json] [--no-env-file|--env-file <ruta>] [--pricing-keys-b64 <b64>] [--info-pricing-keys-b64 <b64>] [--skip-storage-policies] [--steps a,b]');
    process.exit(EXIT.READY);
  }
  let pricingKeys;
  let infoPricingKeys;
  try {
    pricingKeys = decodeKeys(args.pricingB64, '--pricing-keys-b64');
    infoPricingKeys = decodeKeys(args.infoPricingB64, '--info-pricing-keys-b64');
  } catch (e) {
    console.error(`❌ v2-schema-probes: ${e.message}`);
    process.exit(EXIT.USAGE);
  }
  const envPath = args.envFile === undefined ? path.resolve(process.cwd(), '.env') : args.envFile;
  const env = args.envFile === null ? { ...process.env } : mergeEnvFile(process.env, envPath);
  let client = null;
  let report;
  let code;
  try {
    const { Client } = require('pg');
    client = new Client({
      host: env.DB_HOST, port: Number(env.DB_PORT || 5432), user: env.DB_USER, password: env.DB_PASS, database: env.DB_NAME,
      ssl: String(env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 15000,
      application_name: 'cursia-v2-schema-probes',
    });
    await client.connect();
    await client.query('begin transaction read only');
    await client.query("set local statement_timeout = '60s'");
    const query = async (sql, params) => (await client.query(sql, params)).rows;
    report = await runProbes(query, { steps: args.steps, skipStorage: args.skipStorage, pricingKeys, infoPricingKeys });
    code = report.ok ? EXIT.READY : EXIT.NOT_READY;
  } catch (e) {
    report = { ok: false, error: redact((e && (e.code || e.message)) || e) };
    code = EXIT.ERROR;
  } finally {
    if (client) {
      await client.query('rollback').catch(() => {});
      await client.end().catch(() => {});
    }
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (report.error) console.log(`esquema V2: ERROR al consultar (${report.error}) — fail closed`);
  else console.log(render(report));
  process.exit(code);
}

module.exports = { PROBES, R60_STEPS, EXIT, evalProbe, runProbes, render, describeProbe, decodeKeys, pricingKeysOf, parseArgs, mergeEnvFile };
// `node - < v2-schema-probes.js` (deploy.yml): el módulo es `[stdin]` y require.main queda undefined.
if (require.main === module || module.id === '[stdin]') main();
