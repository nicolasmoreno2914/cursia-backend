#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════════
// migrate-v2-production.js — Fase 9 / gap G6: aplica, en un orden FIJO y
// documentado, exactamente las migraciones de esquema de Cursia V2 que
// producción necesita, y después corre los verify-*/audit-* existentes en
// modo `production-readonly`.
//
// INERTE HASTA QUE SE DISPARE EXPLÍCITAMENTE (ruling B):
//   - Por defecto es DRY-RUN: imprime el plan y el sha256 de cada .sql, y NO
//     conecta a ningún lado (ni siquiera carga el driver `pg`).
//   - --apply exige TODO lo siguiente (ver scripts/lib/v2-production-target.js):
//       MIGRATION_ENV=production
//       CONFIRM_PRODUCTION_REF=<ref parseado de DB_HOST/DB_USER>
//       CONFIRM_BACKUP_TAKEN=yes
//       --i-understand-this-mutates-production
//     rechaza el ref de STAGING, cualquier ref que no sea el de producción
//     conocido, DB_SSL != true, y un servidor que no sea Supabase.
//   - --verify-only: solo las verificaciones read-only (sin backup, sin mutar).
//
// Nunca lee .env implícitamente: las credenciales vienen del entorno del
// proceso o de un --env-file <ruta> explícito. Los verify/audit hijos corren
// con cwd en un directorio temporal vacío, así tampoco cargan ningún .env.
//
// Uso: ver docs/v2-production-migrations.md.
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const target = require('../lib/v2-production-target');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TOOL_VERSION = 1;

// ── Plan FIJO ──────────────────────────────────────────────────────────────
// Mismo orden que deploy-staging.yml (pasos 3, 4b, 4e, 4h, 4h2, [4h3], 4k).
// production_jobs constraints y usage_events/cost_rates NO están acá: los
// aplica deploy.yml en cada push a main (migrate-production-jobs-constraints.js
// y migrate-usage-events-costs.js) — el runner solo verifica como
// PRECONDICIÓN que el CHECK de execution_mode ya acepte los modos dynamic.
const MIGRATION_STEPS = [
  {
    id: 'dynamic-course-structure',
    file: 'supabase-migration-dynamic-course-structure.sql',
    stagingStep: '3 (migrate-dynamic-course-structure.js)',
    summary: 'course_modules, course_chapters; columnas structure_version en courses, locked_at en course_versions, module/chapter/status en artifacts, blueprint_version_id en production_jobs',
  },
  {
    id: 'course-blueprints',
    file: 'supabase-migration-course-blueprints.sql',
    stagingStep: '4b (migrate-course-blueprints.js)',
    summary: 'course_blueprints inmutable + courses.current_blueprint_id; reapunta 3 FKs (vacías) de course_versions a course_blueprints',
  },
  {
    id: 'generation-manifests',
    file: 'supabase-migration-generation-manifests.sql',
    stagingStep: '4e (migrate-generation-manifests.js)',
    summary: 'course_generation_manifests inmutable',
  },
  {
    id: 'dynamic-generation',
    file: 'supabase-migration-dynamic-generation.sql',
    stagingStep: '4h (migrate-dynamic-generation.js)',
    summary: 'generation_item_runs, generation_run_contexts, uq_dynamic_generation_active_run en production_jobs, columnas manifest/item_run en artifacts',
  },
  {
    id: 'dynamic-generation-v2',
    file: 'supabase-migration-dynamic-generation-v2.sql',
    stagingStep: '4h2 (migrate-dynamic-generation-v2.js)',
    summary: 'rulesVersion 2: scope en generation_item_runs, tipos course_plan/course_intro/module_intro, conteos v2 en manifests',
  },
  {
    // HOOK del bloque paralelo v2/f78-backend (Fase 8, invalidación):
    // generation_item_runs.carried_from_item_run_id. Mientras ese bloque no
    // esté integrado en esta rama, el archivo no existe y el paso queda
    // UNRESOLVED: --apply se niega salvo --skip-unresolved-placeholders.
    // Cuando se integre: no hace falta tocar nada acá si el archivo conserva
    // este nombre y menciona `carried_from_item_run_id`.
    id: 'invalidation-carried-from',
    file: 'supabase-migration-invalidation.sql',
    stagingStep: '4h3 (migrate-invalidation.js — bloque paralelo v2/f78-backend)',
    summary: 'generation_item_runs.carried_from_item_run_id + FK + índice parcial (Fase 8)',
    placeholder: { mustMention: 'carried_from_item_run_id' },
  },
  {
    // Decisión: SÍ se necesita en producción. El ejecutor dynamic de V2 (y el
    // artifactUpload legacy de 39-brandkit/41-course-setup) sube a
    // cursia-artifacts DESDE EL NAVEGADOR con el JWT del usuario; el
    // frontend de producción usa el mismo proyecto de Supabase que esta DB
    // (hriwbakbuypaiovvvkqh, 20-supabase.js). Sin políticas → 403 en el
    // upload de cada item. Las políticas son mínimas (rol authenticated,
    // bucket cursia-artifacts, primer segmento del path = auth.uid()) y
    // permisivas/aditivas: si producción ya tiene otras políticas, estas solo
    // se suman (OR) dentro de la carpeta propia. El runner imprime las
    // políticas existentes antes de aplicar. --skip-storage-policies las
    // omite si el owner decide lo contrario.
    id: 'storage-artifacts-policies',
    file: 'supabase-migration-storage-artifacts-policies.sql',
    stagingStep: '4k (migrate-storage-artifacts-policies.js)',
    summary: 'políticas RLS mínimas de storage.objects para el bucket cursia-artifacts (own-folder, rol authenticated)',
    skippableWith: '--skip-storage-policies',
  },
];

// Verificaciones read-only posteriores (los scripts existentes, en modo
// V2_VERIFY_MODE=production-readonly). Mismo orden que deploy-staging.yml.
const VERIFY_SCRIPTS = [
  'scripts/verify-dynamic-course-structure-schema.js',
  'scripts/verify-course-blueprints-schema.js',
  'scripts/audit-course-blueprints.js',
  'scripts/verify-generation-manifests-schema.js',
  'scripts/audit-generation-manifests.js',
  'scripts/verify-dynamic-generation-schema.js',
  'scripts/audit-dynamic-generation.js',
];

const EXCLUDED = [
  { file: 'scripts/migrate-production-jobs-constraints.js', reason: 'ya lo corre deploy.yml en cada push a main (no se duplica); es PRECONDICIÓN verificada por este runner' },
  { file: 'scripts/migrate-usage-events-costs.js', reason: 'ya lo corre deploy.yml en cada push a main; no es V2' },
  { file: 'supabase-migration-p2-content-worker.sql', reason: 'legacy (P2.1), ya aplicada en producción' },
  { file: 'supabase-migration-brand-extraction-execution-mode.sql', reason: 'legacy, no V2' },
  { file: 'supabase-migration-dashboard-course-costs.sql', reason: 'legacy, no V2' },
];

const EXPECTED_STORAGE_POLICIES = [
  { name: 'cursia_artifacts_insert_own_folder', cmd: 'INSERT' },
  { name: 'cursia_artifacts_select_own_folder', cmd: 'SELECT' },
  { name: 'cursia_artifacts_delete_own_folder', cmd: 'DELETE' },
  { name: 'cursia_artifacts_update_own_folder', cmd: 'UPDATE' },
];

// Patrones que no pueden correr dentro de una transacción (o que la
// romperían). Ninguno de los .sql actuales los usa; si uno futuro los usa, el
// runner se niega en vez de aplicarlo a medias.
const NON_TRANSACTIONAL_PATTERNS = [
  { re: /\bconcurrently\b/i, why: 'CREATE/DROP INDEX CONCURRENTLY no puede correr en una transacción' },
  { re: /\bvacuum\b/i, why: 'VACUUM no puede correr en una transacción' },
  { re: /^\s*(begin|commit|rollback|start\s+transaction)\s*;/im, why: 'control de transacción explícito dentro del .sql' },
  { re: /\balter\s+type\b[^;]*\badd\s+value\b/i, why: 'ALTER TYPE ... ADD VALUE no puede usarse en la misma transacción' },
];

// ── CLI ────────────────────────────────────────────────────────────────────

const KNOWN_FLAGS = new Set([
  '--apply', '--verify-only', '--i-understand-this-mutates-production', '--plan-json',
  '--skip-unresolved-placeholders', '--skip-storage-policies', '--skip-verify',
  '--test-allow-local-target', '--help', '-h',
]);
const VALUE_FLAGS = new Set(['--env-file', '--expect-plan-sha256', '--plan-json-out']);

function parseArgs(argv) {
  const args = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} requiere un valor`);
      args.values[a] = argv[++i];
    } else if (KNOWN_FLAGS.has(a)) {
      args.flags.add(a);
    } else {
      throw new Error(`argumento desconocido: ${a} (usá --help)`);
    }
  }
  return args;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/prod/migrate-v2-production.js                # DRY-RUN (default): plan + sha256, no conecta',
    '  node scripts/prod/migrate-v2-production.js --plan-json    # plan en JSON por stdout (para el runbook)',
    '  MIGRATION_ENV=production CONFIRM_PRODUCTION_REF=<ref> \\',
    '    node scripts/prod/migrate-v2-production.js --verify-only [--env-file <ruta>]',
    '  MIGRATION_ENV=production CONFIRM_PRODUCTION_REF=<ref> CONFIRM_BACKUP_TAKEN=yes \\',
    '    node scripts/prod/migrate-v2-production.js --apply --i-understand-this-mutates-production [--env-file <ruta>]',
    '',
    'Opciones: --expect-plan-sha256 <hex>  --plan-json-out <ruta>  --skip-unresolved-placeholders',
    '          --skip-storage-policies  --skip-verify (solo con --apply; desaconsejado)',
    'Ver docs/v2-production-migrations.md.',
  ].join('\n');
}

function loadEnvFileExplicit(envPath) {
  const abs = path.resolve(envPath);
  if (!fs.existsSync(abs)) throw new Error(`--env-file no existe: ${abs}`);
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
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
    // El entorno del proceso gana (igual que los scripts existentes): así
    // MIGRATION_ENV/CONFIRM_* tienen que venir del operador, no del archivo.
    if (!(key in process.env)) process.env[key] = value;
  }
  return abs;
}

// ── Plan ───────────────────────────────────────────────────────────────────

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildPlan(opts) {
  const steps = MIGRATION_STEPS.map((s, idx) => {
    const abs = path.join(REPO_ROOT, s.file);
    const step = {
      order: idx + 1,
      id: s.id,
      file: s.file,
      stagingEquivalent: s.stagingStep,
      summary: s.summary,
      status: 'included',
      sha256: null,
      bytes: null,
      transactional: null,
      problems: [],
    };
    if (s.skippableWith && opts.skipStoragePolicies) {
      step.status = 'skipped';
      step.problems.push(`omitido por ${s.skippableWith}`);
      return step;
    }
    if (!fs.existsSync(abs)) {
      if (s.placeholder) {
        step.status = 'placeholder-unresolved';
        step.problems.push('archivo no presente en esta rama (bloque paralelo aún no integrado)');
      } else {
        step.status = 'missing';
        step.problems.push('archivo requerido no existe');
      }
      return step;
    }
    const buf = fs.readFileSync(abs);
    const text = buf.toString('utf8');
    step.sha256 = sha256(buf);
    step.bytes = buf.length;
    if (s.placeholder && !text.includes(s.placeholder.mustMention)) {
      step.status = 'placeholder-unresolved';
      step.problems.push(`el archivo existe pero no menciona ${s.placeholder.mustMention} — no es la migración esperada`);
    }
    const nonTx = NON_TRANSACTIONAL_PATTERNS.filter((p) => p.re.test(text));
    step.transactional = nonTx.length === 0;
    for (const p of nonTx) step.problems.push('no transaccional: ' + p.why);
    return step;
  });

  const applicable = steps.filter((s) => s.status === 'included');
  const planSha256 = sha256(
    applicable.map((s) => `${s.order}:${s.file}:${s.sha256}`).join('\n'),
  );

  return {
    tool: 'scripts/prod/migrate-v2-production.js',
    toolVersion: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    planSha256,
    steps,
    verifications: VERIFY_SCRIPTS.map((f, i) => ({ order: i + 1, script: f, mode: 'V2_VERIFY_MODE=production-readonly' }))
      .concat(opts.skipStoragePolicies ? [] : [{ order: VERIFY_SCRIPTS.length + 1, script: '(interno) políticas de storage.objects', mode: 'read-only' }]),
    excluded: EXCLUDED,
    preconditions: [
      'Backup/PITR de producción verificado por el owner (CONFIRM_BACKUP_TAKEN=yes)',
      'deploy.yml ya corrió con este código: production_jobs_execution_mode_check acepta dynamic_generation y dynamic_package',
      'Existen public.courses, public.course_versions, public.artifacts, public.production_jobs',
      'Para storage: existen storage.objects, storage.foldername() y auth.uid()',
      'El servidor es Supabase (rol supabase_admin)',
    ],
    confirmationsRequiredForApply: [
      'MIGRATION_ENV=production',
      'CONFIRM_PRODUCTION_REF=<ref parseado de DB_HOST/DB_USER> (== ' + target.KNOWN_PRODUCTION_SUPABASE_REF + ')',
      'CONFIRM_BACKUP_TAKEN=yes',
      '--apply --i-understand-this-mutates-production',
      'DB_SSL=true',
    ],
    refusedRefs: { staging: target.KNOWN_STAGING_SUPABASE_REF },
  };
}

function describeTargetNoConnect() {
  const parsed = target.parseProjectRef(process.env);
  if (parsed.conflict) return `CONFLICTO DB_HOST=${parsed.conflict.fromHost} vs DB_USER=${parsed.conflict.fromUser}`;
  if (!parsed.ref) return '(sin objetivo configurado o no es Supabase — no importa en dry-run)';
  let tag = '';
  if (parsed.ref === target.KNOWN_STAGING_SUPABASE_REF) tag = ' ← STAGING: --apply lo rechazaría';
  else if (parsed.ref === target.KNOWN_PRODUCTION_SUPABASE_REF) tag = ' ← producción conocida';
  else tag = ' ← desconocido: --apply lo rechazaría';
  return `${parsed.ref} (desde ${parsed.source})${tag}`;
}

function printPlanHuman(plan, mode) {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(` Cursia V2 — migraciones de PRODUCCIÓN  [modo: ${mode}]`);
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`Plan sha256: ${plan.planSha256}`);
  console.log(`Objetivo (parseado sin conectar): ${describeTargetNoConnect()}`);
  console.log('');
  console.log('Pasos (en este orden, cada uno en su propia transacción):');
  for (const s of plan.steps) {
    const mark = s.status === 'included' ? '•' : '!';
    console.log(`  ${mark} ${s.order}. [${s.status}] ${s.file}`);
    if (s.sha256) console.log(`       sha256 ${s.sha256}  (${s.bytes} bytes)`);
    console.log(`       staging: ${s.stagingEquivalent}`);
    console.log(`       ${s.summary}`);
    for (const p of s.problems) console.log(`       ⚠️  ${p}`);
  }
  console.log('');
  console.log('Verificaciones posteriores (solo lectura):');
  for (const v of plan.verifications) console.log(`  ${v.order}. ${v.script}  [${v.mode}]`);
  console.log('');
  console.log('Excluido a propósito:');
  for (const e of plan.excluded) console.log(`  - ${e.file}: ${e.reason}`);
  console.log('');
  console.log('Precondiciones:');
  for (const p of plan.preconditions) console.log(`  - ${p}`);
}

// ── Apply / verify (únicos caminos que conectan) ───────────────────────────

async function checkPreconditions(client, { includeStorage }) {
  const problems = [];
  const { rows: tbls } = await client.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p')
        and c.relname = any($1::text[])`,
    [['courses', 'course_versions', 'artifacts', 'production_jobs']],
  );
  const present = new Set(tbls.map((r) => r.relname));
  for (const t of ['courses', 'course_versions', 'artifacts', 'production_jobs']) {
    if (!present.has(t)) problems.push(`falta la tabla legacy public.${t} — ¿base equivocada?`);
  }
  if (present.has('production_jobs')) {
    const { rows } = await client.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'production_jobs_execution_mode_check' and conrelid = 'public.production_jobs'::regclass`,
    );
    const def = rows[0] ? rows[0].def : '';
    if (!def.includes('dynamic_generation') || !def.includes('dynamic_package')) {
      problems.push(
        'production_jobs_execution_mode_check no acepta dynamic_generation/dynamic_package — ' +
        'deploy.yml (migrate-production-jobs-constraints.js) todavía no corrió con el código V2; mergeá/deployá primero',
      );
    }
  }
  if (includeStorage) {
    const { rows } = await client.query(
      `select to_regclass('storage.objects') is not null as has_objects,
              to_regprocedure('storage.foldername(text)') is not null as has_foldername,
              to_regprocedure('auth.uid()') is not null as has_uid`,
    );
    const r = rows[0];
    if (!r.has_objects) problems.push('no existe storage.objects');
    if (!r.has_foldername) problems.push('no existe storage.foldername(text)');
    if (!r.has_uid) problems.push('no existe auth.uid()');
  }
  return problems;
}

async function describeCurrentState(client, { includeStorage }) {
  const { rows } = await client.query(
    `select t, to_regclass('public.' || t) is not null as present from unnest($1::text[]) as t`,
    [['course_modules', 'course_chapters', 'course_blueprints', 'course_generation_manifests', 'generation_item_runs', 'generation_run_contexts']],
  );
  console.log('Estado actual de tablas V2: ' + rows.map((r) => `${r.t}=${r.present ? 'existe' : 'no'}`).join(', '));
  if (includeStorage) {
    const pol = await client.query(
      `select policyname, cmd, roles::text as roles from pg_policies
        where schemaname = 'storage' and tablename = 'objects' order by policyname`,
    );
    console.log(`Políticas actuales en storage.objects (${pol.rows.length}):`);
    for (const p of pol.rows) console.log(`  - ${p.policyname} (${p.cmd}, roles=${p.roles})`);
  }
}

async function verifyStoragePolicies(client) {
  const { rows } = await client.query(
    `select policyname, cmd, roles::text as roles, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
       from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = any($1::text[])`,
    [EXPECTED_STORAGE_POLICIES.map((p) => p.name)],
  );
  let ok = true;
  for (const exp of EXPECTED_STORAGE_POLICIES) {
    const row = rows.find((r) => r.policyname === exp.name);
    const good = row && row.cmd === exp.cmd && row.roles === '{authenticated}' &&
      row.expr.includes('cursia-artifacts') && row.expr.includes('auth.uid()');
    console.log(`  ${good ? '✓' : '❌'} ${exp.name} (${exp.cmd}${row ? ', roles=' + row.roles : ', NO EXISTE'})`);
    if (!good) ok = false;
  }
  return ok;
}

function runVerifyScripts(tgt, { testFlag }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v2-verify-'));
  const env = {
    ...process.env,
    MIGRATION_ENV: 'production',
    V2_VERIFY_MODE: 'production-readonly',
    CONFIRM_PRODUCTION_REF: tgt.ref,
  };
  if (tgt.testMode && testFlag) env.V2_TEST_ALLOW_LOCAL_TARGET = '1';
  else delete env.V2_TEST_ALLOW_LOCAL_TARGET;
  const results = [];
  try {
    for (const rel of VERIFY_SCRIPTS) {
      console.log(`\n── verify: ${rel} ─────────────────────────────`);
      const res = spawnSync(process.execPath, [path.join(REPO_ROOT, rel)], {
        cwd, env, stdio: 'inherit', timeout: 10 * 60 * 1000,
      });
      const code = res.status === null ? 1 : res.status;
      results.push({ script: rel, exitCode: code });
      if (code !== 0) {
        console.error(`❌ ${rel} salió con código ${code}`);
        break;
      }
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  return results;
}

async function connect(tgt) {
  const { Client } = require('pg'); // lazy: dry-run nunca carga el driver
  const client = new Client(target.pgClientConfigFromEnv(process.env));
  await client.connect();
  try {
    await target.assertServerIdentity(client, { testMode: tgt.testMode });
  } catch (err) {
    await client.end();
    throw err;
  }
  return client;
}

async function applyMigrations(plan, tgt, opts) {
  const client = await connect(tgt);
  const applied = [];
  try {
    const includeStorage = !opts.skipStoragePolicies;
    // Precondiciones y foto del estado, en una transacción READ ONLY aparte.
    await client.query('begin transaction read only');
    let problems;
    try {
      problems = await checkPreconditions(client, { includeStorage });
      if (problems.length === 0) await describeCurrentState(client, { includeStorage });
    } finally {
      await client.query('rollback');
    }
    if (problems.length > 0) {
      console.error('❌ Precondiciones no cumplidas — no se aplicó NADA:');
      problems.forEach((p) => console.error('  - ' + p));
      return { ok: false, applied, stage: 'preconditions' };
    }

    for (const step of plan.steps) {
      if (step.status !== 'included') {
        console.log(`⏭️  ${step.order}. ${step.file} [${step.status}] — no se aplica`);
        continue;
      }
      const abs = path.join(REPO_ROOT, step.file);
      const buf = fs.readFileSync(abs);
      if (sha256(buf) !== step.sha256) {
        console.error(`❌ ${step.file} cambió entre el plan y la ejecución — abortando.`);
        return { ok: false, applied, stage: step.id };
      }
      const t0 = Date.now();
      console.log(`▶ ${step.order}. ${step.file} (sha256 ${step.sha256.slice(0, 12)}…)`);
      await client.query('begin');
      try {
        await client.query(`set local statement_timeout = '300s'`);
        await client.query(buf.toString('utf8'));
        await client.query('commit');
      } catch (err) {
        try { await client.query('rollback'); } catch { /* conexión rota */ }
        console.error(`❌ ${step.file} FALLÓ — rollback de ESTE paso aplicado; los pasos anteriores quedan commiteados (son idempotentes).`);
        console.error(`   ${err.code ? '[' + err.code + '] ' : ''}${err.message}`);
        return { ok: false, applied, stage: step.id };
      }
      applied.push({ id: step.id, file: step.file, sha256: step.sha256, ms: Date.now() - t0 });
      console.log(`  ✓ commit (${Date.now() - t0} ms)`);
    }
    return { ok: true, applied, stage: 'done' };
  } finally {
    await client.end();
  }
}

async function verifyAll(tgt, opts) {
  if (!opts.skipStoragePolicies) {
    const client = await connect(tgt);
    try {
      await target.enterReadOnlySession(client);
      console.log('\n── verify: políticas de storage.objects (read-only) ──');
      const ok = await verifyStoragePolicies(client);
      if (!ok) {
        console.error('❌ Las políticas de Storage no están como se esperaba');
        return { ok: false, results: [{ script: 'storage-policies', exitCode: 1 }] };
      }
    } finally {
      await client.end();
    }
  }
  const results = runVerifyScripts(tgt, opts);
  const ok = results.length === VERIFY_SCRIPTS.length && results.every((r) => r.exitCode === 0);
  return { ok, results };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('❌ ' + err.message);
    console.error(usage());
    return 2;
  }
  if (args.flags.has('--help') || args.flags.has('-h')) {
    console.log(usage());
    return 0;
  }

  const apply = args.flags.has('--apply');
  const verifyOnly = args.flags.has('--verify-only');
  if (apply && verifyOnly) {
    console.error('❌ --apply y --verify-only son excluyentes');
    return 2;
  }
  if (args.flags.has('--skip-verify') && !apply) {
    console.error('❌ --skip-verify solo tiene sentido con --apply');
    return 2;
  }
  const opts = {
    skipStoragePolicies: args.flags.has('--skip-storage-policies'),
    skipUnresolved: args.flags.has('--skip-unresolved-placeholders'),
    skipVerify: args.flags.has('--skip-verify'),
    testFlag: args.flags.has('--test-allow-local-target'),
  };
  if (args.values['--env-file']) {
    const abs = loadEnvFileExplicit(args.values['--env-file']);
    console.error(`(variables cargadas de --env-file ${abs}; el entorno del proceso tiene prioridad)`);
  }

  const mode = apply ? 'APPLY' : verifyOnly ? 'VERIFY-ONLY' : 'DRY-RUN';
  const plan = buildPlan(opts);

  if (args.flags.has('--plan-json') || args.values['--plan-json-out']) {
    const json = JSON.stringify({ ...plan, mode, connected: false }, null, 2);
    if (args.values['--plan-json-out']) fs.writeFileSync(args.values['--plan-json-out'], json + '\n');
    if (args.flags.has('--plan-json')) {
      process.stdout.write(json + '\n');
    }
  }
  if (!args.flags.has('--plan-json')) printPlanHuman(plan, mode);

  const blocking = plan.steps.filter((s) => s.status === 'missing' || (s.status === 'included' && s.transactional === false));
  const unresolved = plan.steps.filter((s) => s.status === 'placeholder-unresolved');

  if (!apply && !verifyOnly) {
    if (!args.flags.has('--plan-json')) {
      console.log('');
      console.log('DRY-RUN: no se conectó a ninguna base. Para aplicar, ver docs/v2-production-migrations.md.');
      if (unresolved.length) console.log(`⚠️  ${unresolved.length} paso(s) placeholder sin resolver — --apply se negará salvo --skip-unresolved-placeholders.`);
    }
    return blocking.length ? 1 : 0;
  }

  // ── Guardas (antes de conectar) ─────────────────────────────────────────
  const refusals = [];
  if (apply && !args.flags.has('--i-understand-this-mutates-production')) {
    refusals.push('falta el flag --i-understand-this-mutates-production');
  }
  if (apply && blocking.length) {
    refusals.push('el plan tiene pasos bloqueantes: ' + blocking.map((s) => `${s.file} (${s.problems.join('; ')})`).join(', '));
  }
  if (apply && unresolved.length && !opts.skipUnresolved) {
    refusals.push('placeholder(s) sin resolver: ' + unresolved.map((s) => s.file).join(', ') +
      ' — integrá el bloque que los provee, o pasá --skip-unresolved-placeholders conscientemente');
  }
  if (apply && args.values['--expect-plan-sha256'] && args.values['--expect-plan-sha256'] !== plan.planSha256) {
    refusals.push(`--expect-plan-sha256 (${args.values['--expect-plan-sha256']}) != plan actual (${plan.planSha256})`);
  }
  let tgt;
  try {
    tgt = target.assertProductionTarget(process.env, {
      kind: apply ? 'apply' : 'readonly',
      testFlag: opts.testFlag,
      envFlagAllowed: false,
    });
  } catch (err) {
    if (err instanceof target.TargetRefusal) refusals.push(...err.reasons);
    else throw err;
  }
  if (refusals.length) {
    console.error('');
    console.error(`❌ ${mode} RECHAZADO — no se conectó a ninguna base:`);
    refusals.forEach((r) => console.error('  - ' + r));
    return 3;
  }

  console.log('');
  console.log(`🎯 Objetivo: ref ${tgt.ref} (${tgt.source})${tgt.testMode ? '  ⚠️ OVERRIDE DE TESTS — Postgres local' : ''}`);

  if (apply) {
    const res = await applyMigrations(plan, tgt, opts);
    console.log('');
    console.log(`Resumen apply: ${res.applied.length} paso(s) commiteado(s): ${res.applied.map((a) => a.id).join(', ') || '(ninguno)'}`);
    if (!res.ok) {
      console.error(`❌ APPLY detenido en "${res.stage}". Ver docs/v2-production-migrations.md §Si algo falla.`);
      return 4;
    }
    if (opts.skipVerify) {
      console.warn('⚠️  --skip-verify: NO se corrieron las verificaciones. Corré --verify-only antes de activar nada.');
      return 0;
    }
  }

  const ver = await verifyAll(tgt, opts);
  console.log('');
  if (!ver.ok) {
    console.error(apply
      ? '❌ Migraciones aplicadas pero la VERIFICACIÓN FALLÓ — NO activar DYNAMIC_COURSE_STRUCTURE. Ver docs/v2-production-migrations.md §Si algo falla.'
      : '❌ VERIFICACIÓN FALLÓ.');
    return 5;
  }
  console.log(apply ? '✅ APPLY + verificación read-only OK.' : '✅ Verificación read-only OK.');
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      if (err instanceof target.TargetRefusal) {
        console.error('❌ ' + err.message);
        process.exitCode = 3;
        return;
      }
      console.error('❌ Error inesperado:', err && err.message ? err.message : err);
      process.exitCode = 1;
    },
  );
}

module.exports = { buildPlan, MIGRATION_STEPS, VERIFY_SCRIPTS, parseArgs };
