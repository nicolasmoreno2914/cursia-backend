/* eslint-disable */
// r95 — Postgres 16 DESCARTABLE para los checks del bloque Admin (presupuesto del usuario que manda, aprobaciones
// pendientes, vista/reintento de admin). Mismo esquema que check-r75-budgets (línea base legacy + V2 + FinOps + r75 access
// + r75 budgets) y los servicios reales sobre dist/ con el gate de presupuestos registrado. Sin red, sin proveedores.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const distRoot = path.join(REPO, 'dist');
const L = (rel) => { try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar dist/${rel} (¿npm run build?): ${err.message}`); process.exit(1); } };

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
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => ([5570, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port))); });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_GENERAL_AVAILABILITY', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION', 'SUPER_ADMIN_EMAILS',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DYNAMIC_ALLOW_VIDEO_PREVIEW', 'DYNAMIC_ALLOW_PROVIDER_MOCK', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'CURSIA_USER_BUDGETS',
  'CURSIA_RBAC_MODE', 'SUPABASE_JWT_SECRET', 'SUPER_ADMIN_EMAIL_VERIFICATION', 'SUPER_ADMIN_USER_IDS', 'CURSIA_BUDGET_RECONCILER', 'DYNAMIC_VIDEO_DELIVERY',
  'ALLOW_UNOWNED_COURSES', 'DYNAMIC_REAL_VIDEO_OWNERS'];

const SA = '11111111-2222-4333-8444-5555555555ff';
const SA_EMAIL = 'sa@cursia.test';
const CONTEXT = { nombre: 'Curso r95', sector: 'Salud', pais: 'Chile', contexto: 'Hospital', nivel: 'Intermedio', tono: 'cercano' };
/** Gamma/TTS reales (videos de vista previa): proveedores pagados reales ⇒ hace falta autorizar. */
const NCTX = { ...CONTEXT, videoMode: 'mock' };
const MOCK_CTX = { ...CONTEXT, videoMode: 'mock', providerModes: { presentation: 'mock', audio: 'mock' } };

/**
 * Levanta PG16 + esquema y devuelve { ds, svc, makeCourse, coursePolicy, setBudget, close, ... }.
 * `label` solo nombra los directorios temporales.
 */
async function setupR95Db(label) {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const { applyFakeProviderEnv } = require('./provider-test-env');
  const snap = L('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = L('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = L('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = L('modules/dynamic-generation/runs.service.js');
  const { AdminCourseOpsService } = L('modules/dynamic-generation/admin-course-ops.service.js');
  const { Artifact } = L('modules/artifacts/entities/artifact.entity.js');
  const AL = L('modules/reliability/attempt-log.js');
  const EL = L('modules/reliability/execution-lease.js');
  const F = L('modules/finops/index.js');
  const FC = L('modules/finops/finops.controller.js');
  const { BudgetReadService } = L('modules/budgets/budget-read.service.js');
  const { BudgetReservationService } = L('modules/budgets/budget-reservation.service.js');
  const { BudgetAdminService } = L('modules/budgets/budget-admin.service.js');
  const BCOM = L('modules/budgets/budget-common.js');
  const { AuditLogService } = L('modules/access/audit-log.service.js');
  const { SuspensionsService } = L('modules/access/suspensions.service.js');
  const { PlatformControlsService } = L('modules/access/platform-controls.service.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `cursia-${label}-pg16-`));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), `cursia-${label}-cwd-`));
  const ROLE = 'postgres.r95localtest01';
  const DB = 'r95db';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let started = false;
  let restoreProviders = null;
  let ds = null;
  const close = async () => {
    if (ds) await ds.destroy().catch(() => undefined);
    if (restoreProviders) restoreProviders();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  };
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create role "${ROLE}" superuser login`); });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => { const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 }); return { code: res.status, out: (res.stdout || '') + (res.stderr || '') }; };
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    { const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({})); if (res.code !== 0) throw new Error(`constraints: ${res.out}`); }
    await withClient(DB, async (c) => { for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8')); });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js', 'scripts/migrate-v21-finops.js',
      'scripts/migrate-v21-finops-rls.js', 'scripts/migrate-rel-recovery.js', 'scripts/migrate-rel-exec-lease.js', 'scripts/migrate-run-pause.js',
      'scripts/migrate-r75-access.js', 'scripts/migrate-r75-budgets.js', 'scripts/migrate-r99-activation.js']) {
      if (!fs.existsSync(path.join(REPO, s))) continue;
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      if (res.code !== 0) throw new Error(`${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }
    Object.assign(process.env, {
      DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_V2_GENERAL_AVAILABILITY: 'true', DYNAMIC_MANIFEST_RULES_VERSION: '3', SUPER_ADMIN_EMAILS: SA_EMAIL,
      SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-local-only', CURSIA_RBAC_MODE: 'off', DYNAMIC_ALLOW_VIDEO_PREVIEW: 'true',
      DYNAMIC_ALLOW_PROVIDER_MOCK: 'true', DYNAMIC_PROVIDER_WORKER_ENABLED: 'true', SUPABASE_JWT_SECRET: 'r95-local-' + crypto.randomBytes(8).toString('hex'),
      SUPER_ADMIN_EMAIL_VERIFICATION: 'off', CURSIA_BUDGET_RECONCILER: 'off', DYNAMIC_VIDEO_DELIVERY: 'youtube', CURSIA_USER_BUDGETS: 'enforce',
    });
    delete process.env.SUPER_ADMIN_USER_IDS;
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    restoreProviders = applyFakeProviderEnv();
    AL.resetRelSchemaCache(); EL.resetExecLeaseSchemaCache();

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 10 } });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const runs = new RunsService(ds, manifests, {}, { async check() { return { ok: true }; } }, budget);
    const read = new BudgetReadService(ds);
    const audit = new AuditLogService(ds);
    const suspensions = new SuspensionsService(ds, audit, null, null);
    const platform = new PlatformControlsService(ds, audit);
    const gate = new BudgetReservationService(ds, read, audit, budget, ledger, suspensions, platform);
    gate.onModuleInit();
    const budgetAdmin = new BudgetAdminService(ds, read, gate, audit);
    const courseOps = new AdminCourseOpsService(ds, manifests, runs, audit);
    const finopsAdmin = new FC.FinopsAdminController(ledger, budget);
    const saActor = { id: SA, email: SA_EMAIL, superAdmin: true };

    async function makeCourse(owner, title, ownerEmail = null) {
      const [course] = await ds.query(`insert into public.courses (owner_id, owner_email, title, structure_version) values ($1, $2, $3, 'dynamic') returning id`, [owner, ownerEmail, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2({ id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'C1', objective: null, video_enabled: true, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'C2', objective: null, video_enabled: true, activity_enabled: false }]);
      for (const m of s2.modules) {
        await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
        for (const c of m.chapters) await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`, [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
      }
      await ds.query(`insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count) values ($1, 1, 2, $2::jsonb, $3, 0, 1, 2)`,
        [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      const res = await manifests.getOrCreate(cid, owner, 1);
      return { cid, manifest: res.manifest };
    }
    let polVersion = 0;
    const coursePolicy = (cid, limits, onExceed = 'ADMIN_APPROVAL') => ds.query(
      `insert into public.cost_budget_policies (scope, scope_id, version, limits, on_exceed) values ('course', $1, $2, $3::jsonb, $4) returning id`,
      [String(cid), ++polVersion, JSON.stringify(limits), onExceed]);
    const setBudget = (userId, usd) => budgetAdmin.setRecurring(saActor, userId, { monthlyAmountUsd: String(usd), effectiveMonth: BCOM.currentMonth(), reason: 'QA r95' });
    return { ds, F, FC, runs, budget, ledger, gate, budgetAdmin, courseOps, finopsAdmin, audit, saActor, makeCourse, coursePolicy, setBudget, close, L };
  } catch (err) {
    await close();
    throw err;
  }
}

module.exports = { setupR95Db, SA, SA_EMAIL, CONTEXT, NCTX, MOCK_CTX, L, REPO };
