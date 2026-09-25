#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════════
// Tests de scripts/prod/migrate-v2-production.js y scripts/ops/v2-health-report.js
// contra un Postgres 16 LOCAL Y DESECHABLE (initdb en un dir temporal, puerto
// único, se destruye al final pase lo que pase). Nunca toca Supabase: todos
// los procesos hijos corren con un entorno construido desde cero (sin heredar
// DB_* del shell) y los casos "con ref de producción/staging" apuntan a
// 127.0.0.1 en un puerto cerrado o a un listener que cuenta conexiones.
//
// Requisitos: Postgres 16 (Homebrew: /opt/homebrew/opt/postgresql@16/bin o
// /opt/homebrew/bin; o PG_BIN=<dir>), `npm ci` hecho (driver pg).
//   node scripts/prod/test/run-local-pg-tests.js
// Puertos: PG 55481 (V2_TEST_PG_PORT), listener 55482, cerrado 55483.
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const REPO = path.resolve(__dirname, '..', '..', '..');
const RUNNER = path.join(REPO, 'scripts/prod/migrate-v2-production.js');
const HEALTH = path.join(REPO, 'scripts/ops/v2-health-report.js');
const FIXTURE = path.join(__dirname, 'fixtures/legacy-baseline.sql');
const FORBID = path.join(__dirname, 'fixtures/forbid-network.js');
const PG_PORT = Number(process.env.V2_TEST_PG_PORT || 55481);
const LISTEN_PORT = 55482;
const CLOSED_PORT = 55483;
const PROD_REF = 'hriwbakbuypaiovvvkqh';
const STAGING_REF = 'ljdtmkwuhkvtmlhugjrv';
const FAKE_REF = 'localprodlike0001';
const STAGING_LOCAL_ROLE = 'postgres.localstagingfake01';
const INVALIDATION_SQL = path.join(REPO, 'supabase-migration-invalidation.sql');
const WORKFLOW = path.join(REPO, '.github/workflows/v2-production-migrations.yml');
const DOC = path.join(REPO, 'docs/v2-production-migrations.md');
// Copia VERBATIM de scripts/migrate-production-jobs-constraints.js de origin/main
// (pre-V2): lo que correría deploy.yml tras un revert del código a main.
const MAIN_CONSTRAINTS_SCRIPT = path.join(__dirname, 'fixtures/main-migrate-production-jobs-constraints.js');
const MAIN_CONSTRAINTS_SHA256 = '8e05ff03aba60b40d76ea279bb4444ef24fc23cc9a3391d25c139c35f29a9f88';
const CONSTRAINTS_SCRIPT = path.join(REPO, 'scripts/migrate-production-jobs-constraints.js');
function writeTmpFile(name, content) {
  const p = path.join(TMP_CWD, name);
  fs.writeFileSync(p, content);
  return p;
}

function findPgBin() {
  const cands = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean);
  for (const d of cands) {
    const pg = path.join(d, 'postgres');
    if (!fs.existsSync(pg)) continue;
    const v = spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '';
    if (/\b16\./.test(v)) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? '\n     ' + String(detail).split('\n').join('\n     ') : ''}`);
}
async function test(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // Primera línea del mensaje (la aserción) + la cola de la salida del hijo.
    const lines = msg.split('\n');
    record(name, false, lines[0] + (lines.length > 1 ? '\n' + lines.slice(1).slice(-24).join('\n') : ''));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Entorno mínimo desde cero: NUNCA hereda DB_*, MIGRATION_ENV, CONFIRM_* del shell.
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}
const TMP_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v2-test-cwd-'));
function run(script, args, env, { preload } = {}) {
  const nodeArgs = preload ? ['-r', preload, script, ...args] : [script, ...args];
  const r = spawnSync(process.execPath, nodeArgs, { cwd: TMP_CWD, env: cleanEnv(env), encoding: 'utf8', timeout: 180000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}

function localEnv(db, extra) {
  return {
    DB_HOST: '127.0.0.1', DB_PORT: PG_PORT, DB_USER: 'postgres', DB_PASS: 'x', DB_NAME: db, DB_SSL: 'false',
    ...extra,
  };
}
function overrideEnv(db, extra) {
  return localEnv(db, {
    NODE_ENV: 'test', V2_TEST_FAKE_PROJECT_REF: FAKE_REF, MIGRATION_ENV: 'production',
    CONFIRM_PRODUCTION_REF: FAKE_REF, CONFIRM_BACKUP_TAKEN: 'yes', ...extra,
  });
}
const APPLY_ARGS = ['--apply', '--i-understand-this-mutates-production', '--test-allow-local-target', '--skip-unresolved-placeholders'];

async function withClient(db, fn, user = 'postgres') {
  const c = new Client({ host: '127.0.0.1', port: PG_PORT, user, database: db });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

function startCountingListener(port) {
  return new Promise((resolve, reject) => {
    const state = { connections: 0 };
    const srv = net.createServer((sock) => { state.connections++; sock.destroy(); });
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve({ state, close: () => new Promise((r) => srv.close(r)) }));
  });
}

async function schemaDump(pgBin, db) {
  const r = spawnSync(path.join(pgBin, 'pg_dump'), ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', '-s', '--no-owner', db], { encoding: 'utf8', env: cleanEnv() });
  if (r.status !== 0) throw new Error('pg_dump falló: ' + r.stderr);
  // pg_dump >= 16.10 emite \restrict/\unrestrict con un token aleatorio por
  // corrida — no es esquema, se descarta para comparar.
  return r.stdout.split('\n').filter((l) => !/^\\(un)?restrict /.test(l)).join('\n');
}

async function main() {
  const pgBin = findPgBin();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v2-pg16-'));
  let started = false;
  const pgEnv = cleanEnv();
  try {
    let r = spawnSync(path.join(pgBin, 'initdb'), ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'], { env: pgEnv, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = spawnSync(path.join(pgBin, 'pg_ctl'), ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${PG_PORT} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start'], { env: pgEnv, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`Postgres ${pgBin} en 127.0.0.1:${PG_PORT} (data ${dataDir})\n`);

    async function makeBaselineDb(db, { constraints = true } = {}) {
      await withClient('postgres', (c) => c.query(`create database ${db}`));
      await withClient(db, async (c) => c.query(fs.readFileSync(FIXTURE, 'utf8')));
      if (constraints) {
        // Lo que haría deploy.yml: el script REAL, apuntado al Postgres local.
        const res = run(path.join(REPO, 'scripts/migrate-production-jobs-constraints.js'), [], localEnv(db));
        if (res.code !== 0) throw new Error('migrate-production-jobs-constraints falló: ' + res.out);
      }
    }
    await makeBaselineDb('prodlike');
    await makeBaselineDb('failstop');
    await makeBaselineDb('noconstraint', { constraints: false });
    // Release-fix C1: producción ANTES del merge (CHECK de main, sin modos dynamic).
    await makeBaselineDb('schemafirst', { constraints: false });
    await makeBaselineDb('dn6', { constraints: false });
    await makeBaselineDb('nullmode', { constraints: false });
    await makeBaselineDb('cmpmain', { constraints: false });
    await makeBaselineDb('cmpcur', { constraints: false });
    await makeBaselineDb('locktest', { constraints: false });

    const listener = await startCountingListener(LISTEN_PORT);
    try {
      // ── 1. DRY-RUN no conecta a nada ───────────────────────────────────
      await test('dry-run (default) con TODAS las confirmaciones y ref de prod: exit 0, 0 conexiones, pg nunca cargado', async () => {
        const before = listener.state.connections;
        const res = run(RUNNER, [], {
          DB_HOST: '127.0.0.1', DB_PORT: LISTEN_PORT, DB_USER: `postgres.${PROD_REF}`, DB_SSL: 'true',
          MIGRATION_ENV: 'production', CONFIRM_PRODUCTION_REF: PROD_REF, CONFIRM_BACKUP_TAKEN: 'yes',
        }, { preload: FORBID });
        assert(res.code === 0, `exit ${res.code}\n${res.out}`);
        assert(/DRY-RUN: no se conectó/.test(res.out), 'falta el aviso de dry-run');
        assert(!/FORBIDDEN_/.test(res.out), 'intentó red o cargar pg');
        assert(listener.state.connections === before, 'el listener recibió conexiones');
      });
      await test('dry-run apuntando a un puerto CERRADO: exit 0 (nunca intentó conectar)', async () => {
        const res = run(RUNNER, [], { DB_HOST: '127.0.0.1', DB_PORT: CLOSED_PORT, DB_USER: `postgres.${PROD_REF}` }, { preload: FORBID });
        assert(res.code === 0, `exit ${res.code}\n${res.out}`);
      });
      await test('--plan-json: JSON válido, connected=false, orden fijo y sha256 reales', async () => {
        const res = run(RUNNER, ['--plan-json'], {}, { preload: FORBID });
        assert(res.code === 0, `exit ${res.code}\n${res.out}`);
        const plan = JSON.parse(res.stdout);
        assert(plan.connected === false && plan.mode === 'DRY-RUN', 'connected/mode');
        const files = plan.steps.map((s) => s.file);
        assert(JSON.stringify(files) === JSON.stringify([
          'scripts/lib/production-jobs-constraints.js',
          'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql',
          'supabase-migration-generation-manifests.sql', 'supabase-migration-dynamic-generation.sql',
          'supabase-migration-dynamic-generation-v2.sql', 'supabase-migration-invalidation.sql',
          'supabase-migration-storage-artifacts-policies.sql']), 'orden: ' + files.join(','));
        for (const s of plan.steps.filter((x) => x.status === 'included')) {
          const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, s.file))).digest('hex');
          assert(h === s.sha256, `sha256 de ${s.file}`);
          assert(s.transactional === true, `${s.file} no transaccional`);
        }
        assert(!files.includes('scripts/migrate-production-jobs-constraints.js'), 'no invoca el script de deploy.yml (usa su lib)');
        assert(plan.excluded.some((e) => /production-jobs-constraints/.test(e.file)), 'exclusión documentada');
        const s0 = plan.steps[0];
        assert(s0.order === 0 && s0.id === 'production-jobs-constraints' && s0.builtin === true && s0.status === 'included', 'paso 0: ' + JSON.stringify(s0));
        assert(!plan.preconditions.some((p) => /deploy\.yml ya corrió/.test(p)), 'la precondición "deploy.yml ya corrió" debe haber desaparecido (C1)');
      });
      await test('placeholder Fase 8 (M1): [included] si supabase-migration-invalidation.sql existe, [placeholder-unresolved] si no', async () => {
        const res = run(RUNNER, ['--plan-json'], {}, { preload: FORBID });
        const step = JSON.parse(res.stdout).steps.find((s) => s.id === 'invalidation-carried-from');
        const expected = fs.existsSync(INVALIDATION_SQL) ? 'included' : 'placeholder-unresolved';
        assert(step && step.status === expected, `status ${step && step.status}, esperado ${expected}`);
      });

      // ── 2. --apply sin cada confirmación → rechazado, sin conectar ──────
      const fullProdLike = {
        DB_HOST: '127.0.0.1', DB_PORT: LISTEN_PORT, DB_USER: `postgres.${PROD_REF}`, DB_PASS: 'x', DB_NAME: 'postgres', DB_SSL: 'true',
        MIGRATION_ENV: 'production', CONFIRM_PRODUCTION_REF: PROD_REF, CONFIRM_BACKUP_TAKEN: 'yes',
      };
      const applyArgs = ['--apply', '--i-understand-this-mutates-production', '--skip-unresolved-placeholders'];
      const missingCases = [
        ['sin --i-understand-this-mutates-production', ['--apply', '--skip-unresolved-placeholders'], {}, /--i-understand-this-mutates-production/],
        ['sin MIGRATION_ENV', applyArgs, { MIGRATION_ENV: undefined }, /MIGRATION_ENV/],
        ['MIGRATION_ENV=staging', applyArgs, { MIGRATION_ENV: 'staging' }, /MIGRATION_ENV/],
        ['sin CONFIRM_PRODUCTION_REF', applyArgs, { CONFIRM_PRODUCTION_REF: undefined }, /CONFIRM_PRODUCTION_REF/],
        ['CONFIRM_PRODUCTION_REF distinto', applyArgs, { CONFIRM_PRODUCTION_REF: 'otroref123456' }, /no coincide/],
        ['sin CONFIRM_BACKUP_TAKEN', applyArgs, { CONFIRM_BACKUP_TAKEN: undefined }, /CONFIRM_BACKUP_TAKEN/],
        ['CONFIRM_BACKUP_TAKEN=y (no "yes")', applyArgs, { CONFIRM_BACKUP_TAKEN: 'y' }, /CONFIRM_BACKUP_TAKEN/],
        ['DB_SSL=false', applyArgs, { DB_SSL: 'false' }, /DB_SSL/],
        ['--expect-plan-sha256 distinto', [...applyArgs, '--expect-plan-sha256', 'deadbeef'], {}, /expect-plan-sha256/],
        ['ref desconocido (ni prod ni staging)', applyArgs, { DB_USER: 'postgres.someotherref01', CONFIRM_PRODUCTION_REF: 'someotherref01' }, /no es el de producción conocido/],
        ['DB_HOST y DB_USER con refs distintos', applyArgs, { DB_HOST: `db.${PROD_REF}.supabase.co`, DB_USER: 'postgres.someotherref01' }, /proyectos distintos/],
        ['override de tests con NODE_ENV=production', [...applyArgs, '--test-allow-local-target'], { NODE_ENV: 'production', V2_TEST_FAKE_PROJECT_REF: FAKE_REF, DB_USER: 'postgres' }, /override de tests pedido pero incompleto/],
        ['override de tests sin el flag de CLI (solo env V2_TEST_ALLOW_LOCAL_TARGET)', applyArgs, { NODE_ENV: 'test', V2_TEST_ALLOW_LOCAL_TARGET: '1', V2_TEST_FAKE_PROJECT_REF: FAKE_REF, DB_USER: 'postgres', CONFIRM_PRODUCTION_REF: FAKE_REF }, /override de tests pedido pero incompleto/],
        ['override de tests con host NO loopback', [...applyArgs, '--test-allow-local-target'], { NODE_ENV: 'test', V2_TEST_FAKE_PROJECT_REF: FAKE_REF, DB_HOST: '10.255.255.1', DB_USER: 'postgres', CONFIRM_PRODUCTION_REF: FAKE_REF }, /override de tests pedido pero incompleto/],
      ];
      // M1: el placeholder de Fase 8 solo está "sin resolver" mientras el
      // archivo no exista en la rama; cuando se integre, el caso deja de aplicar
      // (y el test de --plan-json exige que quede [included]).
      if (!fs.existsSync(INVALIDATION_SQL)) {
        missingCases.push(['placeholder sin resolver y sin --skip-unresolved-placeholders', ['--apply', '--i-understand-this-mutates-production'], {}, /placeholder/]);
      }
      for (const [label, args, patch, re] of missingCases) {
        await test(`--apply ${label}: exit 3, 0 conexiones`, async () => {
          const before = listener.state.connections;
          const env = { ...fullProdLike, ...patch };
          const res = run(RUNNER, args, env, { preload: FORBID });
          assert(res.code === 3, `exit ${res.code}\n${res.out}`);
          assert(re.test(res.out), `no menciona ${re}\n${res.out}`);
          assert(!/FORBIDDEN_/.test(res.out), 'intentó red o cargar pg');
          assert(listener.state.connections === before, 'conectó');
        });
      }
      // ── I1: --env-file solo aporta claves de conexión DB_* ───────────────
      await test('I1: --env-file con TODAS las confirmaciones + DB_* NO habilita --apply (exit 3, 0 conexiones, claves ignoradas avisadas)', async () => {
        const before = listener.state.connections;
        const f = writeTmpFile('all-confirmations.env', [
          'DB_HOST=127.0.0.1', `DB_PORT=${LISTEN_PORT}`, `DB_USER=postgres.${PROD_REF}`, 'DB_PASS=x', 'DB_NAME=postgres', 'DB_SSL=true',
          'MIGRATION_ENV=production', `CONFIRM_PRODUCTION_REF=${PROD_REF}`, 'CONFIRM_BACKUP_TAKEN=yes',
          'NODE_ENV=test', `V2_TEST_FAKE_PROJECT_REF=${FAKE_REF}`, 'V2_TEST_ALLOW_LOCAL_TARGET=1', 'V2_VERIFY_MODE=production-readonly',
        ].join('\n') + '\n');
        const res = run(RUNNER, [...applyArgs, '--env-file', f], {}, { preload: FORBID });
        assert(res.code === 3, `exit ${res.code}\n${res.out}`);
        assert(/MIGRATION_ENV/.test(res.out) && /CONFIRM_BACKUP_TAKEN/.test(res.out), 'debe rechazar por confirmaciones ausentes');
        assert(/ignorad/i.test(res.out) && /CONFIRM_PRODUCTION_REF/.test(res.out), 'debe avisar las claves ignoradas del env-file');
        assert(!/FORBIDDEN_/.test(res.out) && listener.state.connections === before, 'conectó');
      });
      await test('I1: --env-file sí aporta DB_* (el rechazo ya no es por ref/SSL) — confirmaciones desde el proceso', async () => {
        const f = writeTmpFile('db-only.env', ['DB_HOST=127.0.0.1', `DB_PORT=${CLOSED_PORT}`, `DB_USER=postgres.${PROD_REF}`, 'DB_SSL=true'].join('\n') + '\n');
        const res = run(RUNNER, [...applyArgs, '--env-file', f], {
          MIGRATION_ENV: 'production', CONFIRM_PRODUCTION_REF: PROD_REF, CONFIRM_BACKUP_TAKEN: 'yes',
        });
        assert(res.code === 1 && /ECONNREFUSED|connect/i.test(res.out), `exit ${res.code}\n${res.out}`);
      });
      await test('M6: sin V2_DB_SSL_CA el runner avisa que corre con rejectUnauthorized=false', async () => {
        const res = run(RUNNER, applyArgs, { ...fullProdLike, DB_PORT: CLOSED_PORT });
        assert(/rejectUnauthorized=false/.test(res.out), res.out);
      });
      await test('M6: V2_DB_SSL_CA inexistente → rechazo antes de conectar', async () => {
        const before = listener.state.connections;
        const res = run(RUNNER, applyArgs, { ...fullProdLike, V2_DB_SSL_CA: '/nonexistent/ca.pem' }, { preload: FORBID });
        assert(res.code === 3 && /V2_DB_SSL_CA/.test(res.out), `exit ${res.code}\n${res.out}`);
        assert(listener.state.connections === before, 'conectó');
      });

      await test('--apply con TODAS las confirmaciones y ref de prod (puerto cerrado): pasa los guards y solo entonces intenta conectar', async () => {
        const res = run(RUNNER, applyArgs, { ...fullProdLike, DB_PORT: CLOSED_PORT });
        assert(res.code === 1 && /ECONNREFUSED|connect/i.test(res.out), `exit ${res.code}\n${res.out}`);
      });

      // ── 3. ref de STAGING rechazado ─────────────────────────────────────
      await test('--apply contra ref de STAGING (DB_USER pooler) con todas las confirmaciones: rechazado, 0 conexiones', async () => {
        const before = listener.state.connections;
        const res = run(RUNNER, applyArgs, { ...fullProdLike, DB_USER: `postgres.${STAGING_REF}`, CONFIRM_PRODUCTION_REF: STAGING_REF }, { preload: FORBID });
        assert(res.code === 3 && /STAGING — entorno equivocado/.test(res.out), `exit ${res.code}\n${res.out}`);
        assert(listener.state.connections === before, 'conectó');
      });
      await test('--verify-only contra ref de STAGING: rechazado', async () => {
        const res = run(RUNNER, ['--verify-only'], { ...fullProdLike, DB_USER: `postgres.${STAGING_REF}`, CONFIRM_PRODUCTION_REF: STAGING_REF }, { preload: FORBID });
        assert(res.code === 3 && /STAGING/.test(res.out), `exit ${res.code}\n${res.out}`);
      });
      await test('override de tests con ref falso == STAGING: rechazado', async () => {
        const res = run(RUNNER, APPLY_ARGS, overrideEnv('prodlike', { V2_TEST_FAKE_PROJECT_REF: STAGING_REF, CONFIRM_PRODUCTION_REF: STAGING_REF }), { preload: FORBID });
        assert(res.code === 3 && /STAGING/.test(res.out), `exit ${res.code}\n${res.out}`);
      });
      await test('verify-*.js en modo production-readonly contra ref de STAGING: rechazado (exit 1, sin conectar)', async () => {
        const res = run(path.join(REPO, 'scripts/verify-dynamic-generation-schema.js'), [], {
          ...fullProdLike, V2_VERIFY_MODE: 'production-readonly', DB_USER: `postgres.${STAGING_REF}`, CONFIRM_PRODUCTION_REF: STAGING_REF,
          V2_TEST_ALLOW_PG_LOAD: '1',
        }, { preload: FORBID });
        assert(res.code === 1 && /STAGING/.test(res.out), `exit ${res.code}\n${res.out}`);
      });
    } finally {
      await listener.close();
    }

    // ── Unitarios de la librería / estáticos ─────────────────────────────
    const lib = require('../../lib/v2-production-target');
    await test('M5: parseProjectRef acepta usuario de pooler de mínimo privilegio (<rol>.<ref de 20>) y mantiene el chequeo de conflicto', async () => {
      assert(lib.parseProjectRef({ DB_USER: `health_ro.${PROD_REF}` }).ref === PROD_REF, 'health_ro.<ref>');
      assert(lib.parseProjectRef({ DB_USER: `postgres.${PROD_REF}` }).ref === PROD_REF, 'postgres.<ref>');
      assert(lib.parseProjectRef({ DB_USER: 'health_ro.corto' }).ref === null, 'ref corto no es ref');
      assert(lib.parseProjectRef({ DB_HOST: `db.${STAGING_REF}.supabase.co`, DB_USER: `health_ro.${PROD_REF}` }).conflict, 'conflicto');
    });
    await test('M6: pgClientConfigFromEnv verifica certificados cuando hay V2_DB_SSL_CA', async () => {
      const ca = writeTmpFile('ca.pem', '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
      const cfg = lib.pgClientConfigFromEnv({ DB_SSL: 'true', V2_DB_SSL_CA: ca });
      assert(cfg.ssl && cfg.ssl.rejectUnauthorized === true && /BEGIN CERTIFICATE/.test(cfg.ssl.ca), JSON.stringify(cfg.ssl));
      const cfg2 = lib.pgClientConfigFromEnv({ DB_SSL: 'true' });
      assert(cfg2.ssl.rejectUnauthorized === false, 'sin CA');
    });
    await test('M2: cada paso del runner fija su propio lock_timeout y statement_timeout (SET LOCAL)', async () => {
      const runner = require('../migrate-v2-production');
      const pre = runner.STEP_PREAMBLE_SQL.join(';');
      assert(/set local lock_timeout = '5s'/.test(pre) && /set local statement_timeout/.test(pre), pre);
    });
    await test('I2: workflow — solo workflow_dispatch; el job migrate falla primero sin la variable del environment y no lee secretos antes', async () => {
      const y = fs.readFileSync(WORKFLOW, 'utf8');
      const onBlock = y.slice(y.indexOf('\non:'), y.indexOf('\npermissions:'));
      assert(/workflow_dispatch:/.test(onBlock) && !/\b(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/.test(onBlock), 'triggers');
      const job = y.slice(y.indexOf('\n  migrate:'));
      const s0 = job.indexOf('\n      - ', job.indexOf('steps:'));
      const firstStep = job.slice(s0, job.indexOf('\n      - ', s0 + 5));
      assert(/vars\.V2_PROD_MIGRATIONS_ENV_GUARD/.test(firstStep) && /production-v2-migrations/.test(firstStep), 'el primer step debe ser el guard');
      const guardIdx = job.indexOf('V2_PROD_MIGRATIONS_ENV_GUARD');
      assert(job.indexOf('secrets.') > guardIdx, 'secretos antes del guard');
      assert(y.slice(0, y.indexOf('\n  migrate:')).indexOf('secrets.') === -1, 'el job plan no debe leer secretos');
    });
    await test('I3: el doc incluye el chequeo SQL pre-merge obligatorio (DN-6) con resultados esperados', async () => {
      const d = fs.readFileSync(DOC, 'utf8');
      assert(/would_violate_execution_mode/.test(d) && /would_violate_worker_status/.test(d) && /DN-6/.test(d) && /begin transaction read only/i.test(d), 'falta el SQL pre-merge');
      assert(/V2_PROD_MIGRATIONS_ENV_GUARD/.test(d), 'falta el setup del guard del environment');
    });

    // ── 4. Guards de staging de los verify/audit: SIN cambios ────────────
    await test('verify-*.js sin V2_VERIFY_MODE (default staging): guard original intacto — MIGRATION_ENV=production rechazado', async () => {
      const res = run(path.join(REPO, 'scripts/verify-course-blueprints-schema.js'), [], { MIGRATION_ENV: 'production', DB_USER: `postgres.${PROD_REF}`, DB_HOST: '127.0.0.1', DB_PORT: CLOSED_PORT, V2_TEST_ALLOW_PG_LOAD: '1' }, { preload: FORBID });
      assert(res.code === 1 && /MIGRATION_ENV no es "staging"/.test(res.out), `exit ${res.code}\n${res.out}`);
    });
    await test('verify-*.js staging con ref de PRODUCCIÓN: blacklist original intacta', async () => {
      const res = run(path.join(REPO, 'scripts/audit-dynamic-generation.js'), [], { MIGRATION_ENV: 'staging', DB_USER: `postgres.${PROD_REF}`, DB_HOST: '127.0.0.1', DB_PORT: CLOSED_PORT, V2_TEST_ALLOW_PG_LOAD: '1' }, { preload: FORBID });
      assert(res.code === 1 && /PRODUCCIÓN/.test(res.out), `exit ${res.code}\n${res.out}`);
    });

    // ── 5. Servidor con supabase_admin + override de tests → rechazado ───
    await test('override de tests contra un servidor que tiene rol supabase_admin: rechazado tras conectar, sin aplicar nada', async () => {
      await withClient('postgres', (c) => c.query('create role supabase_admin nologin'));
      try {
        const res = run(RUNNER, APPLY_ARGS, overrideEnv('prodlike'));
        assert(res.code === 3 && /supabase_admin/.test(res.out), `exit ${res.code}\n${res.out}`);
        const t = await withClient('prodlike', (c) => c.query(`select to_regclass('public.course_modules') as t`));
        assert(t.rows[0].t === null, 'aplicó algo');
      } finally {
        await withClient('postgres', (c) => c.query('drop role supabase_admin'));
      }
    });

    // ── 6. C1 schema-first: el runner ensancha el CHECK él mismo (paso 0) ─
    const defsOf = (db) => withClient(db, async (c) => (await c.query(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'public.production_jobs'::regclass
          and conname in ('production_jobs_execution_mode_check','production_jobs_worker_status_check') order by conname`)).rows);
    await test('C1: base con el CHECK de main (sin modos dynamic, deploy.yml NO corrió) → el runner aplica el paso 0 + 1..7, exit 0', async () => {
      const before = await defsOf('schemafirst');
      assert(before.length === 2 && !before[0].def.includes('dynamic_generation'), 'fixture: ' + JSON.stringify(before));
      const res = run(RUNNER, APPLY_ARGS, overrideEnv('schemafirst'));
      assert(res.code === 0 && /APPLY \+ verificación read-only OK/.test(res.out), `exit ${res.code}\n${res.out}`);
      assert(/▶ 0\. scripts\/lib\/production-jobs-constraints\.js/.test(res.out) && /desactualizado/.test(res.out), 'no se vio el paso 0\n' + res.out);
      assert(/production-jobs-constraints/.test(res.out.split('Resumen apply:')[1] || ''), 'paso 0 no figura en el resumen');
      const t = await withClient('schemafirst', (c) => c.query(`select to_regclass('public.course_modules') as t`));
      assert(t.rows[0].t !== null, 'no aplicó el paso 1');
    });
    await test('C1: el CHECK que deja el runner es IDÉNTICO (pg_get_constraintdef) al del script real de deploy.yml', async () => {
      const a = await defsOf('schemafirst');
      const b = await defsOf('prodlike'); // prodlike: migrate-production-jobs-constraints.js real
      assert(a.length === 2 && JSON.stringify(a) === JSON.stringify(b), `runner ${JSON.stringify(a)}\nscript ${JSON.stringify(b)}`);
    });
    await test('C1: re-correr el runner con el CHECK ya al día → paso 0 es no-op (sin ALTER), exit 0', async () => {
      const res = run(RUNNER, APPLY_ARGS, overrideEnv('schemafirst'));
      assert(res.code === 0 && /ya al día — sin cambios/.test(res.out), `exit ${res.code}\n${res.out}`);
    });
    await test('C1: deploy.yml DESPUÉS del runner (script real sobre la base ya migrada) → exit 0 y mismo CHECK', async () => {
      const before = await defsOf('schemafirst');
      const res = run(path.join(REPO, 'scripts/migrate-production-jobs-constraints.js'), [], localEnv('schemafirst'));
      assert(res.code === 0, res.out);
      assert(JSON.stringify(await defsOf('schemafirst')) === JSON.stringify(before), 'cambió el CHECK');
    });
    await test('C1/DN-6: una fila que violaría el CHECK nuevo (brand_extraction) → exit 4, reporte claro, NADA aplicado (ni el paso 0)', async () => {
      await withClient('dn6', (c) => c.query(`
        alter table production_jobs drop constraint production_jobs_execution_mode_check;
        insert into production_jobs (owner_id, execution_mode, status) values ('u', 'brand_extraction', 'queued');`));
      const res = run(RUNNER, APPLY_ARGS, overrideEnv('dn6'));
      assert(res.code === 4, `exit ${res.code}\n${res.out}`);
      assert(/DN-6/.test(res.out) && /would_violate_execution_mode=1 \(brand_extraction=1\)/.test(res.out) && /would_violate_worker_status=0/.test(res.out), 'reporte DN-6\n' + res.out);
      assert(/no se aplicó NADA/.test(res.out), res.out);
      const t = await withClient('dn6', (c) => c.query(`select to_regclass('public.course_modules') as t,
        (select count(*) from pg_constraint where conname = 'production_jobs_execution_mode_check')::int as ck`));
      assert(t.rows[0].t === null && t.rows[0].ck === 0, 'aplicó algo: ' + JSON.stringify(t.rows[0]));
    });
    await test('N2/DN-6: una fila con execution_mode NULL (el CHECK acepta NULL; la consulta manual del doc no la cuenta) NO es violación → exit 0', async () => {
      await withClient('nullmode', (c) => c.query(`insert into production_jobs (owner_id, execution_mode, status) values ('u', null, 'queued')`));
      const doc = fs.readFileSync(DOC, 'utf8');
      const manual = doc.slice(doc.indexOf('select count(*) as would_violate_execution_mode'), doc.indexOf('select count(*) as would_violate_worker_status'));
      const m = await withClient('nullmode', (c) => c.query(manual.trim().replace(/;\s*$/, '')));
      assert(Number(m.rows[0].would_violate_execution_mode) === 0, 'la consulta manual del doc debería dar 0: ' + JSON.stringify(m.rows));
      const res = run(RUNNER, APPLY_ARGS, overrideEnv('nullmode'));
      assert(res.code === 0 && /APPLY \+ verificación read-only OK/.test(res.out), `exit ${res.code}\n${res.out}`);
      assert(!/\(null\)=/.test(res.out.split('DN-6')[1] || ''), 'reportó (null) como violación');
      const n = await withClient('nullmode', (c) => c.query(`select count(*)::int as n from production_jobs where execution_mode is null`));
      assert(n.rows[0].n === 1, 'la fila NULL debe seguir ahí');
    });
    // ── N1 (re-review): revert del código a main con filas dynamic ─────────
    await test('N1 fixture: la copia del script de main es byte-idéntica a origin/main (sha256 fijado)', async () => {
      const h = crypto.createHash('sha256').update(fs.readFileSync(MAIN_CONSTRAINTS_SCRIPT)).digest('hex');
      assert(h === MAIN_CONSTRAINTS_SHA256, h);
    });
    await test('N1 reproducido: con una fila dynamic_generation, el script de main (revert del código) falla 23514 (deploy.yml abortaría en [2/4], antes de pm2 reload) y el CHECK queda ancho', async () => {
      const before = await defsOf('schemafirst');
      await withClient('schemafirst', (c) => c.query(`insert into production_jobs (owner_id, execution_mode, status) values ('u', 'dynamic_generation', 'completed')`));
      try {
        const res = run(MAIN_CONSTRAINTS_SCRIPT, [], localEnv('schemafirst'));
        assert(res.code === 1 && /violated by some row|check constraint/i.test(res.out), `exit ${res.code}\n${res.out}`);
        assert(JSON.stringify(await defsOf('schemafirst')) === JSON.stringify(before), 'el CHECK cambió (el rollback de la transacción debería dejarlo ancho)');
        const cur = run(CONSTRAINTS_SCRIPT, [], localEnv('schemafirst'));
        assert(cur.code === 0, 'el script actual (forward-revert que conserva la lib) debe pasar: ' + cur.out);
      } finally {
        await withClient('schemafirst', (c) => c.query(`delete from production_jobs where execution_mode = 'dynamic_generation' and owner_id = 'u'`));
      }
    });
    await test('M5/N1: el SQL de constraint del script de deploy.yml es el de main + SOLO dynamic_generation/dynamic_package (PG16, pg_get_constraintdef)', async () => {
      const m = run(MAIN_CONSTRAINTS_SCRIPT, [], localEnv('cmpmain'));
      const c = run(CONSTRAINTS_SCRIPT, [], localEnv('cmpcur'));
      assert(m.code === 0 && c.code === 0, m.out + c.out);
      const dm = await defsOf('cmpmain');
      const dc = await defsOf('cmpcur');
      assert(dm.length === 2 && dc.length === 2, JSON.stringify([dm, dc]));
      const stripped = dc[0].def.replace(", 'dynamic_generation'::text, 'dynamic_package'::text", '');
      assert(dc[0].def !== stripped && stripped === dm[0].def, `execution_mode\nmain ${dm[0].def}\ncur  ${dc[0].def}`);
      assert(dc[1].def === dm[1].def, `worker_status\nmain ${dm[1].def}\ncur  ${dc[1].def}`);
    });
    await test('M5: el script de deploy.yml fija lock_timeout — con production_jobs bloqueada por otra sesión falla rápido (55P03) en vez de colgarse', async () => {
      const holder = new Client({ host: '127.0.0.1', port: PG_PORT, user: 'postgres', database: 'locktest' });
      await holder.connect();
      try {
        await holder.query('begin');
        await holder.query('lock table public.production_jobs in access share mode');
        const t0 = Date.now();
        const r = spawnSync(process.execPath, [CONSTRAINTS_SCRIPT], { cwd: TMP_CWD, env: cleanEnv(localEnv('locktest')), encoding: 'utf8', timeout: 40000 });
        const ms = Date.now() - t0;
        const out = (r.stdout || '') + (r.stderr || '');
        assert(r.status === 1 && /lock timeout/i.test(out), `status ${r.status} signal ${r.signal} (${ms} ms)\n${out}`);
        assert(ms < 30000, `tardó ${ms} ms`);
      } finally {
        await holder.query('rollback').catch(() => {});
        await holder.end();
      }
    });
    await test('C1: --verify-only falla (exit 5) si el CHECK de production_jobs no acepta los modos dynamic', async () => {
      const res = run(RUNNER, ['--verify-only', '--test-allow-local-target'], overrideEnv('noconstraint', { CONFIRM_BACKUP_TAKEN: undefined }));
      assert(res.code === 5 && /CHECK de production_jobs/.test(res.out), `exit ${res.code}\n${res.out}`);
    });

    // ── 7. Apply limpio + verify + idempotencia ─────────────────────────
    let dumpAfterFirst;
    await test('APPLY limpio sobre base legacy con ref falso tipo producción (override de tests): exit 0 + verificación read-only OK', async () => {
      const res = run(RUNNER, APPLY_ARGS, overrideEnv('prodlike'));
      assert(res.code === 0, `exit ${res.code}\n${res.out}`);
      assert(/APPLY \+ verificación read-only OK/.test(res.out), 'sin línea final OK');
      for (const id of ['dynamic-course-structure', 'course-blueprints', 'generation-manifests', 'dynamic-generation', 'dynamic-generation-v2', 'storage-artifacts-policies']) {
        assert(res.out.includes(id), 'no aplicó ' + id);
      }
      // 6 y no 7: audit-generation-manifests.js sale antes de su sonda cuando
      // la tabla está vacía (comportamiento original, tabla recién creada).
      assert((res.out.match(/sonda omitida/g) || []).length === 6, 'esperaba 6 sondas omitidas en production-readonly\n' + res.out);
      assert((res.out.match(/🔒 Modo production-readonly/g) || []).length === 7, 'los 7 verify/audit en production-readonly');
      assert((res.out.match(/✓ cursia_artifacts_/g) || []).length === 4, 'políticas de storage');
      dumpAfterFirst = await schemaDump(pgBin, 'prodlike');
    });
    await test('APPLY idempotente: segunda corrida exit 0 y esquema idéntico (pg_dump -s)', async () => {
      const res = run(RUNNER, APPLY_ARGS, overrideEnv('prodlike'));
      assert(res.code === 0, `exit ${res.code}\n${res.out}`);
      const dump2 = await schemaDump(pgBin, 'prodlike');
      if (dump2 !== dumpAfterFirst) {
        fs.writeFileSync(path.join(os.tmpdir(), 'cursia-v2-dump1.sql'), dumpAfterFirst);
        fs.writeFileSync(path.join(os.tmpdir(), 'cursia-v2-dump2.sql'), dump2);
      }
      assert(dump2 === dumpAfterFirst, 'el esquema cambió en la segunda corrida (dumps en ' + os.tmpdir() + '/cursia-v2-dump{1,2}.sql)');
    });
    await test('datos legacy intactos tras el apply (cursos legacy, versions, artifacts, jobs)', async () => {
      await withClient('prodlike', async (c) => {
        const r = await c.query(`select (select count(*) from courses where structure_version='legacy')::int as legacy,
                                        (select count(*) from course_versions)::int as cv,
                                        (select count(*) from artifacts)::int as art,
                                        (select count(*) from production_jobs)::int as pj`);
        const x = r.rows[0];
        assert(x.legacy === 2 && x.cv === 2 && x.art === 1 && x.pj === 2, JSON.stringify(x));
      });
    });
    await test('--verify-only (sin CONFIRM_BACKUP_TAKEN) pasa sobre la base migrada', async () => {
      const res = run(RUNNER, ['--verify-only', '--test-allow-local-target'], overrideEnv('prodlike', { CONFIRM_BACKUP_TAKEN: undefined }));
      assert(res.code === 0 && /Verificación read-only OK/.test(res.out), `exit ${res.code}\n${res.out}`);
    });
    await test('I1: --verify-only con DB_* desde --env-file (local) y confirmaciones desde el proceso → OK', async () => {
      const f = writeTmpFile('local-db.env', ['DB_HOST=127.0.0.1', `DB_PORT=${PG_PORT}`, 'DB_USER=postgres', 'DB_PASS=x', 'DB_NAME=prodlike', 'DB_SSL=false'].join('\n') + '\n');
      const res = run(RUNNER, ['--verify-only', '--test-allow-local-target', '--env-file', f], {
        NODE_ENV: 'test', V2_TEST_FAKE_PROJECT_REF: FAKE_REF, MIGRATION_ENV: 'production', CONFIRM_PRODUCTION_REF: FAKE_REF,
      });
      assert(res.code === 0 && /Verificación read-only OK/.test(res.out), `exit ${res.code}\n${res.out}`);
    });
    await test('camino de STAGING sin cambios: los 7 verify/audit con MIGRATION_ENV=staging y TODAS sus sondas de escritura revertida pasan sobre el esquema del runner', async () => {
      await withClient('postgres', (c) => c.query(`create role "${STAGING_LOCAL_ROLE}" login superuser`));
      const before = await withClient('prodlike', (c) => c.query(`select (select count(*) from courses)::int as c, (select count(*) from production_jobs)::int as j`));
      for (const s of ['verify-dynamic-course-structure-schema', 'verify-course-blueprints-schema', 'audit-course-blueprints',
        'verify-generation-manifests-schema', 'audit-generation-manifests', 'verify-dynamic-generation-schema', 'audit-dynamic-generation']) {
        const res = run(path.join(REPO, `scripts/${s}.js`), [], localEnv('prodlike', { MIGRATION_ENV: 'staging', DB_USER: STAGING_LOCAL_ROLE }));
        assert(res.code === 0, `${s} exit ${res.code}\n${res.out}`);
        assert(!/sonda omitida/.test(res.out), `${s} omitió sondas en modo staging`);
      }
      const after = await withClient('prodlike', (c) => c.query(`select (select count(*) from courses)::int as c, (select count(*) from production_jobs)::int as j`));
      assert(JSON.stringify(before.rows) === JSON.stringify(after.rows), 'las sondas dejaron filas');
    });
    await test('M3: production-readonly = BEGIN READ ONLY por transacción (sin setting de sesión, apto para pooler) y bloquea escrituras (25006)', async () => {
      await withClient('prodlike', async (c) => {
        await lib.enterProductionReadonlySession(c, { ref: FAKE_REF, testMode: true });
        const tro = await c.query('show transaction_read_only');
        const dtro = await c.query('show default_transaction_read_only');
        assert(tro.rows[0].transaction_read_only === 'on', 'transacción no read-only');
        assert(dtro.rows[0].default_transaction_read_only === 'off', 'no debe depender de un setting de sesión');
        let code = null;
        try { await c.query(`insert into courses (title) values ('x')`); } catch (e) { code = e.code; }
        assert(code === '25006', 'código ' + code);
      });
    });
    await test('M3: en production-readonly se rechaza cualquier control de transacción/sesión (commit, begin, set session)', async () => {
      await withClient('prodlike', async (c) => {
        await lib.enterProductionReadonlySession(c, { ref: FAKE_REF, testMode: true });
        for (const sql of ['commit', 'begin', 'set session characteristics as transaction read write', 'end']) {
          let rejected = false;
          try { await c.query(sql); } catch (e) { rejected = /production-readonly/.test(e.message); }
          assert(rejected, 'no rechazó: ' + sql);
        }
      });
    });

    // ── 8. Stop en el primer error ───────────────────────────────────────
    await test('falla en el paso 2 → exit 4, paso 1 commiteado, paso 2 revertido entero, pasos 3+ no aplicados', async () => {
      // Sabotaje: un course_blueprints preexistente con otra forma hace
      // fallar supabase-migration-course-blueprints.sql (FK a (id, course_id)).
      await withClient('failstop', (c) => c.query(`create table public.course_blueprints (id text primary key)`));
      const res = run(RUNNER, APPLY_ARGS, overrideEnv('failstop'));
      assert(res.code === 4 && /course-blueprints/.test(res.out), `exit ${res.code}\n${res.out}`);
      await withClient('failstop', async (c) => {
        const r = await c.query(`select to_regclass('public.course_modules') as m, to_regclass('public.course_generation_manifests') as g,
                                        exists (select 1 from information_schema.columns where table_name='courses' and column_name='current_blueprint_id') as cbi`);
        const x = r.rows[0];
        assert(x.m !== null, 'paso 1 no quedó commiteado');
        assert(x.cbi === false, 'paso 2 quedó a medias');
        assert(x.g === null, 'se aplicó el paso 3 tras el error');
      });
    });

    // ── 9. Health report ─────────────────────────────────────────────────
    await withClient('prodlike', async (c) => {
      await c.query(fs.readFileSync(path.join(__dirname, 'fixtures/health-seed.sql'), 'utf8'));
      await c.query(`create role health_ro login;
                     grant usage on schema public to health_ro;
                     grant select on all tables in schema public to health_ro;`);
    });
    const healthEnv = (extra) => localEnv('prodlike', { DB_USER: 'health_ro', ...extra });
    await test('health report (rol SOLO SELECT) con umbrales default → exit 2 con las alertas esperadas', async () => {
      const res = run(HEALTH, ['--json'], healthEnv());
      assert(res.code === 2, `exit ${res.code}\n${res.out}`);
      const rep = JSON.parse(res.stdout);
      const m = rep.metrics;
      assert(m.failedItems24h.value === 6, 'failed ' + m.failedItems24h.value);
      assert(m.stuckLeases.items.length === 1 && m.stuckLeases.jobs.length === 1, 'stuck ' + JSON.stringify(m.stuckLeases));
      assert(m.packageFailures24h.value === 1, 'pkg fail');
      assert(m.packageDuplicateActive.value === 1, 'dup');
      assert(m.longRunningRuns.value === 1, 'long');
      assert(Math.abs(m.videogenSpend.usd24h - 20) < 1e-9 && Math.abs(m.videogenSpend.usd7d - 35) < 1e-9, 'spend ' + JSON.stringify(m.videogenSpend));
      assert(m.videogenSpend.withoutCost7d === 1 && m.videogenSpend.ratePerVideoUsd === 10, 'rate/without');
      assert(Math.abs(m.dynamicStorage.bytes - 3 * 1024 ** 3) < 1, 'storage');
      assert(rep.alerts.length === 4, 'alertas: ' + rep.alerts.join(' | '));
      assert(!rep.alerts.some((a) => /Videogen|Storage/.test(a)), 'alertas de gasto/storage inesperadas');
    });
    await test('health report con umbrales altos → exit 0 (OK)', async () => {
      const res = run(HEALTH, [], healthEnv({
        V2_HEALTH_MAX_FAILED_ITEMS_24H: 100, V2_HEALTH_MAX_STUCK_LEASES: 10, V2_HEALTH_MAX_PACKAGE_FAILURES_24H: 10, V2_HEALTH_MAX_LONG_RUNS: 10,
      }));
      assert(res.code === 0 && /ESTADO: OK/.test(res.out), `exit ${res.code}\n${res.out}`);
    });
    await test('health report: umbrales de gasto 24h y Storage disparan alerta', async () => {
      const res = run(HEALTH, ['--json'], healthEnv({
        V2_HEALTH_MAX_FAILED_ITEMS_24H: 100, V2_HEALTH_MAX_STUCK_LEASES: 10, V2_HEALTH_MAX_PACKAGE_FAILURES_24H: 10, V2_HEALTH_MAX_LONG_RUNS: 10,
        V2_HEALTH_MAX_VIDEOGEN_USD_24H: 10, V2_HEALTH_MAX_DYNAMIC_STORAGE_GB: 1, V2_HEALTH_MAX_SPEND_RATIO_7D: 1.1,
      }));
      const rep = JSON.parse(res.stdout);
      assert(res.code === 2 && rep.alerts.length === 3, `exit ${res.code} ${rep.alerts.join(' | ')}`);
    });
    await test('health report sobre base sin tablas V2 → exit 0 con nota (no rompe antes de migrar)', async () => {
      const res = run(HEALTH, [], localEnv('noconstraint'));
      assert(res.code === 0 && /generation_item_runs no existe/.test(res.out), `exit ${res.code}\n${res.out}`);
    });
    await test('health report --expect-ref distinto → exit 3 sin conectar', async () => {
      const res = run(HEALTH, ['--expect-ref', PROD_REF], { DB_HOST: '127.0.0.1', DB_PORT: CLOSED_PORT, DB_USER: `postgres.${STAGING_REF}` }, { preload: FORBID });
      assert(res.code === 3, `exit ${res.code}\n${res.out}`);
    });
    await test('health report: umbral inválido → exit 1', async () => {
      const res = run(HEALTH, [], { V2_HEALTH_MAX_STUCK_LEASES: 'abc' }, { preload: FORBID });
      assert(res.code === 1, `exit ${res.code}\n${res.out}`);
    });
    await test('I1: health --env-file solo aporta DB_* (umbrales y expected-ref del archivo se ignoran)', async () => {
      const f = writeTmpFile('health.env', ['DB_HOST=127.0.0.1', `DB_PORT=${PG_PORT}`, 'DB_USER=health_ro', 'DB_NAME=prodlike', 'DB_SSL=false',
        'V2_HEALTH_MAX_STUCK_LEASES=abc', `V2_HEALTH_EXPECTED_REF=${STAGING_REF}`, 'MIGRATION_ENV=production'].join('\n') + '\n');
      const res = run(HEALTH, ['--json', '--env-file', f], {});
      assert(res.code === 2, `exit ${res.code}\n${res.out}`);
      assert(/ignorad/i.test(res.out), 'debe avisar claves ignoradas');
    });
    await test('M7: umbrales fraccionarios respetados (LONG_RUN_HOURS=8.5 → el run de 8 h no cuenta)', async () => {
      const res = run(HEALTH, ['--json'], healthEnv({ V2_HEALTH_LONG_RUN_HOURS: '8.5', V2_HEALTH_LEASE_GRACE_MINUTES: '25.5' }));
      const rep = JSON.parse(res.stdout);
      assert(rep.metrics.longRunningRuns.value === 0, 'long ' + rep.metrics.longRunningRuns.value);
      assert(rep.metrics.stuckLeases.items.length === 0 && rep.metrics.stuckLeases.jobs.length === 1, 'grace 25.5 min');
    });
    await test('M4: health report redacta JWT, tokens de query, URLs y emails en errores', async () => {
      await withClient('prodlike', (c) => c.query(`
        insert into production_jobs (owner_id, execution_mode, status, worker_status, input_payload, error_message)
          values ('u', 'dynamic_package', 'failed', 'failed', '{"runId":"r"}',
                  'GET https://abc.supabase.co/storage/v1/object/sign/x?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigSIG_123 by jane.doe@example.com');
        update generation_item_runs set error = 'upload 403 https://files.example.org/a?sig=SECRETSIG&x=1 bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.zzz_ZZZ mail ops@cursia.test'
          where item_key = 'scorm:c1';`));
      const res = run(HEALTH, ['--json'], healthEnv());
      for (const needle of ['eyJ', 'jane.doe@example.com', 'ops@cursia.test', 'SECRETSIG', 'https://abc.supabase.co', 'https://files.example.org', 'sigSIG_123']) {
        assert(!res.stdout.includes(needle), 'filtró: ' + needle);
      }
      assert(/\[redacted/.test(res.stdout), 'sin marcador de redacción');
    });
  } finally {
    if (started) {
      spawnSync(path.join(pgBin, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', 'stop'], { env: pgEnv });
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(TMP_CWD, { recursive: true, force: true });
    console.log(`\n(Postgres detenido y ${dataDir} borrado)`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} ok, ${failed} fail`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('❌ harness:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
