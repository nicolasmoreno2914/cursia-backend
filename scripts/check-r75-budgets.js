#!/usr/bin/env node
/* eslint-disable */
// r75 (Agente C) — presupuestos mensuales por usuario, reservas transaccionales, solicitudes y gasto por institución.
// PG16 desechable (127.0.0.1), proveedores falsos, sin red ni IA: USD 0. Cubre (03 «Agente C» + 01 §5):
//   [MIG]   migración aditiva/idempotente + verificación; guardarraíles MIGRATION_ENV=staging y ref de producción;
//   [OFF]   CURSIA_USER_BUDGETS=off → todo como antes (sin filas nuevas, rutas 404, ledger sin institution_id);
//   [ZERO]  un usuario en USD 0 no puede arrancar (409 user_budget_not_assigned) y no queda NADA escrito;
//   [SET]   el SA asigna presupuesto (auditado) → el arranque reserva (start = authorized_budget) + startedBy;
//   [CONC]  N arranques EN PARALELO del mismo usuario en cursos distintos, desde 3 «procesos» → Σ reservado ≤ disponible;
//   [TERM]  run terminal libera (released/settled); run pausado retiene; liberación tardía no bloquea (fórmula);
//   [RETRY] reintentos no doble-cuentan (bindRun repetido, reserva+liquidación del ledger, gasto dentro del run neutro);
//   [BYOK]  BYOK y mock no consumen presupuesto;
//   [MANIP] una llamada manipulada de un usuario no cambia un presupuesto (HTTP real con JWT; trigger append-only);
//   [INST]  gasto por institución: el admin institucional ve SOLO la suya; «sin institución» solo el SA;
//   [REQ]   solicitud creada → aprobada (ajuste + auditoría) / rechazada (auditoría) / duplicada / vencida;
//   [REC]   reconciliación contra el ledger (drift por cargo tardío, auditada);
//   [NORUN] llamada sin run (proxy) por encima del disponible → USER_BUDGET_EXHAUSTED → 409 user_budget_insufficient;
//   [SAEXT] autorización del SA por encima del disponible: 409 sin extendUserBudget; con él, month_adjustment auditado;
//   [SHADOW] shadow: calcula, registra (auditoría) y deja arrancar;
//   [COST]  CostReadService: mismos totales para eventos sin institución; atribución por institución; fecha efectiva.
//
// Usage: npm run build && node scripts/check-r75-budgets.js
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..');
const distRoot = path.join(REPO, 'dist');
const L = (rel) => { try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar dist/${rel} (¿npm run build?): ${err.message}`); process.exit(1); } };
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (/^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const { applyFakeProviderEnv } = require('./lib/provider-test-env');

let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
const near = (a, b, m) => assert(Math.abs(Number(a) - Number(b)) < 1e-6, `${m}: esperado ${b}, encontrado ${a}`);
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

const U1 = '11111111-2222-4333-8444-555555555551'; // creador A
const U2 = '11111111-2222-4333-8444-555555555552'; // creador B
const U3 = '11111111-2222-4333-8444-555555555553'; // concurrencia
const ADMIN_A = '11111111-2222-4333-8444-5555555555a1';
const SA = '11111111-2222-4333-8444-5555555555ff';
const SA_EMAIL = 'sa@cursia.test';
const CONTEXT = { nombre: 'Curso presupuestos r75', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_GENERAL_AVAILABILITY', 'DYNAMIC_MANIFEST_RULES_VERSION', 'SUPER_ADMIN_EMAILS', 'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY', 'DYNAMIC_ALLOW_VIDEO_PREVIEW', 'DYNAMIC_ALLOW_PROVIDER_MOCK', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'CURSIA_USER_BUDGETS', 'CURSIA_RBAC_MODE', 'SUPABASE_JWT_SECRET', 'SUPER_ADMIN_EMAIL_VERIFICATION', 'SUPER_ADMIN_USER_IDS', 'CURSIA_BUDGET_RECONCILER'];
const setMode = (m) => { process.env.CURSIA_USER_BUDGETS = m; };

async function main() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = L('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = L('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = L('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = L('modules/dynamic-generation/runs.service.js');
  const { Artifact } = L('modules/artifacts/entities/artifact.entity.js');
  const AL = L('modules/reliability/attempt-log.js');
  const EL = L('modules/reliability/execution-lease.js');
  const F = L('modules/finops/index.js');
  const FC = L('modules/finops/finops.controller.js');
  const { BudgetReadService } = L('modules/budgets/budget-read.service.js');
  const { BudgetReservationService } = L('modules/budgets/budget-reservation.service.js');
  const { BudgetAdminService } = L('modules/budgets/budget-admin.service.js');
  const { BudgetRequestsService } = L('modules/budgets/budget-requests.service.js');
  const { BudgetAccessService } = L('modules/budgets/budget-access.service.js');
  const BC = L('modules/budgets/budgets.controller.js');
  const SC = L('modules/budgets/spend.controller.js');
  const BCOM = L('modules/budgets/budget-common.js');
  const { AuditLogService } = L('modules/access/audit-log.service.js');
  const { SuspensionsService } = L('modules/access/suspensions.service.js');
  const { PlatformControlsService } = L('modules/access/platform-controls.service.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r75c-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r75c-cwd-'));
  const ROLE = 'postgres.r75budgetslocal';
  const DB = 'r75budgetsdb';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const restoreProviders = applyFakeProviderEnv();
  const pools = [];
  let app = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1 -c max_connections=80`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create role "${ROLE}" superuser login`); });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => { const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 }); return { code: res.status, out: (res.stdout || '') + (res.stderr || '') }; };
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    // D-2 / H13: con E2E_PROD_COLUMN_TYPES=1, los tipos legacy de PRODUCCIÓN (production_jobs.course_id text, owner_id uuid;
    // artifacts.owner_id uuid), igual que test/e2e-v2/run-e2e.sh.
    if (process.env.E2E_PROD_COLUMN_TYPES === '1') {
      await withClient(DB, (c) => c.query('alter table public.production_jobs alter column course_id type text using course_id::text, alter column owner_id type uuid using owner_id::uuid; alter table public.artifacts alter column owner_id type uuid using owner_id::uuid'));
      console.log('   (tipos de columnas de producción aplicados: E2E_PROD_COLUMN_TYPES=1)');
    }
    { const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({})); assert(res.code === 0, `migrate-production-jobs-constraints: ${res.out}`); }
    await withClient(DB, async (c) => { for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8')); });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js', 'scripts/migrate-v21-finops.js',
      'scripts/verify-v21-finops-schema.js', 'scripts/migrate-v21-finops-rls.js', 'scripts/migrate-rel-recovery.js', 'scripts/migrate-rel-exec-lease.js', 'scripts/migrate-run-pause.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }
    // A (rama base r75/a-institutions): su migración real (membresías, suspensiones, congelación, auditoría, autoría).
    { const res = runScript('scripts/migrate-r75-access.js', localEnv({ MIGRATION_ENV: 'staging' })); assert(res.code === 0, `migrate-r75-access: ${res.out.slice(-1500)}`); }

    // ── [MIG] ───────────────────────────────────────────────────────────────────────────────────────────────────
    await check('[MIG] sin MIGRATION_ENV=staging la migración NO corre (exit ≠ 0, sin tablas); con el ref de producción tampoco aunque se fije MIGRATION_ENV', async () => {
      const a = runScript('scripts/migrate-r75-budgets.js', localEnv({}));
      assert(a.code !== 0 && /MIGRATION_ENV/.test(a.out), 'sin MIGRATION_ENV: ' + a.out);
      const b = runScript('scripts/migrate-r75-budgets.js', localEnv({ MIGRATION_ENV: 'staging', DB_HOST: 'db.hriwbakbuypaiovvvkqh.supabase.co' }));
      assert(b.code !== 0 && /PRODUCCI/.test(b.out), 'ref de prod: ' + b.out);
      const v = runScript('scripts/verify-r75-budgets-schema.js', localEnv({ MIGRATION_ENV: 'staging', DB_USER: 'postgres.hriwbakbuypaiovvvkqh' }));
      assert(v.code !== 0, 'verify con ref de prod');
      const t = await withClient(DB, (c) => c.query(`select to_regclass('public.user_budgets') as t`));
      eq(t.rows[0].t, null, 'no se creó nada');
    });
    await check('[MIG] migrate-r75-budgets.js aplica y es idempotente (2 veces); verify-r75-budgets-schema.js pasa (RLS sin políticas, triggers, índices, sonda revertida)', async () => {
      for (let i = 0; i < 2; i++) { const res = runScript('scripts/migrate-r75-budgets.js', localEnv({ MIGRATION_ENV: 'staging' })); assert(res.code === 0, `migrate #${i + 1}: ${res.out}`); }
      const v = runScript('scripts/verify-r75-budgets-schema.js', localEnv({ MIGRATION_ENV: 'staging' }));
      assert(v.code === 0, 'verify: ' + v.out);
      const n = await withClient(DB, (c) => c.query(`select (select count(*) from public.user_budgets) + (select count(*) from public.budget_reservations) + (select count(*) from public.budget_requests) as n`));
      eq(Number(n.rows[0].n), 0, 'la sonda no dejó filas');
    });

    Object.assign(process.env, { DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_V2_GENERAL_AVAILABILITY: 'true', DYNAMIC_MANIFEST_RULES_VERSION: '3',
      SUPER_ADMIN_EMAILS: SA_EMAIL, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-local-only', CURSIA_RBAC_MODE: 'off', DYNAMIC_ALLOW_VIDEO_PREVIEW: 'true', DYNAMIC_ALLOW_PROVIDER_MOCK: 'true', DYNAMIC_PROVIDER_WORKER_ENABLED: 'true',
      SUPABASE_JWT_SECRET: 'r75-local-test-secret-' + crypto.randomBytes(8).toString('hex'), SUPER_ADMIN_EMAIL_VERIFICATION: 'off', CURSIA_BUDGET_RECONCILER: 'off' });
    delete process.env.SUPER_ADMIN_USER_IDS;
    setMode('off');
    AL.resetRelSchemaCache(); EL.resetExecLeaseSchemaCache();

    /** Un «proceso»: DataSource propio + servicios + gate registrado (como BudgetsModule.onModuleInit). */
    async function proc() {
      const ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 10 } });
      await ds.initialize(); pools.push(ds);
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
      const access = new BudgetAccessService(ds, undefined);
      const admin = new BudgetAdminService(ds, read, gate, audit);
      const requests = new BudgetRequestsService(ds, read, gate, access, audit, ledger);
      return { ds, manifests, ledger, budget, runs, read, gate, access, admin, requests, audit, platform };
    }
    const P = await proc();
    const ds = P.ds;
    const saActor = { id: SA, email: SA_EMAIL, superAdmin: true };
    const userActor = (id) => ({ id, email: `${id.slice(-4)}@x.test`, superAdmin: false });

    const [instA] = await ds.query(`insert into public.institutions (owner_id, name, slug) values ($1, 'QA r75 Institución A', 'qa-r75-a') returning id`, [ADMIN_A]);
    const [instB] = await ds.query(`insert into public.institutions (owner_id, name, slug) values ($1, 'QA r75 Institución B', 'qa-r75-b') returning id`, [U2]);
    await ds.query(`insert into public.institution_memberships (institution_id, user_id, role) values ($1, $2, 'ADMIN_INSTITUCIONAL'), ($1, $3, 'CREADOR'), ($4, $5, 'CREADOR')`,
      [instA.id, ADMIN_A, U1, instB.id, U2]);

    async function makeCourse(owner, title, institutionId = null) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version, institution_id) values ($1, $2, 'dynamic', $3) returning id`, [owner, title, institutionId]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2({ id: cid, title, finalExam: false, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: false }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: false, activity_enabled: false },
          { id: c2, module_id: m1, position: 1, title: 'Válvulas', objective: null, video_enabled: false, activity_enabled: false }]);
      for (const m of s2.modules) {
        await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
        for (const c of m.chapters) await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`, [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
      }
      await ds.query(`insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count) values ($1, 1, 2, $2::jsonb, $3, 0, 1, 2)`,
        [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      await P.manifests.getOrCreate(cid, owner, 1);
      return cid;
    }
    const start = (p, cid, owner) => p.runs.startRun(cid, owner, 1, { ...CONTEXT, videoMode: 'mock', providerModes: { presentation: 'mock', audio: 'mock' } });
    const bodyOf = (err) => (err && err.getResponse ? err.getResponse() : null);
    const httpCode = (err) => { const b = bodyOf(FC.finopsErrorToHttp(err)); return b && b.code; };
    const count = async (sql, p = []) => Number((await ds.query(sql, p))[0].n);
    const runAuth = async (runId) => (await ds.query(`select authorized_budget::text as b from public.cost_budget_authorizations where run_id = $1 order by created_at desc, id desc limit 1`, [runId]))[0];
    const cancelRun = (runId) => ds.query(`update public.production_jobs set status = 'cancelled', worker_status = 'cancelled' where id = $1`, [runId]);
    const charge = (o) => P.ledger.recordCharge({
      itemRunId: o.itemRunId ?? null, attributionRunId: o.runId && !o.itemRunId ? o.runId : null, attributionCourseId: o.courseId ?? null,
      ownerIdFromAuth: o.owner, provider: 'anthropic', service: 'messages', modelOrProduct: 'claude-sonnet-4-6',
      costSource: 'ACTUAL_PROVIDER', actualAmount: o.amount, idempotencyKey: o.key || `r75c:${crypto.randomUUID()}`, callRole: 'main', attempt: 1,
      billingAccount: o.billing || 'cursia', mode: o.billing === 'mock' ? 'mock' : 'real', measurementStatus: 'final', recordedBy: 'check-r75',
      executorAuthorization: o.runId ? 'server_worker' : undefined, metadata: o.metadata || {},
    });
    const itemOf = async (runId) => (await ds.query(`select id from public.generation_item_runs where job_id = $1 order by item_key limit 1`, [runId]))[0];

    // ── [OFF] ───────────────────────────────────────────────────────────────────────────────────────────────────
    let offRun = null;
    await check('[OFF] CURSIA_USER_BUDGETS=off: un usuario sin presupuesto arranca como hoy, no se escribe ninguna fila r75, el evento del ledger queda con institution_id null y las rutas de presupuesto responden 404', async () => {
      setMode('off');
      const cid = await makeCourse(U2, 'OFF', instB.id);
      const res = await start(P, cid, U2);
      offRun = res.run.id;
      eq(await count(`select count(*) n from public.budget_reservations`), 0, 'sin reservas');
      const [j] = await ds.query(`select input_payload->>'startedBy' as s from public.production_jobs where id = $1`, [offRun]);
      eq(j.s, null, 'sin startedBy');
      const ev = await charge({ owner: U2, runId: offRun, amount: '0.01' });
      eq(ev.event.institution_id, null, 'institution_id null');
      let e = null; try { BCOM.assertBudgetsEnabled(); } catch (x) { e = x; }
      eq([e && e.getStatus(), bodyOf(e).code], [404, 'budgets_disabled'], 'rutas 404');
      await cancelRun(offRun);
    });

    setMode('enforce');
    // ── [ZERO] ──────────────────────────────────────────────────────────────────────────────────────────────────
    let zeroCourse = null;
    await check('[ZERO] enforce: un usuario nuevo (USD 0) NO puede arrancar → 409 user_budget_not_assigned (canRequest); no queda run, autorización ni reserva', async () => {
      zeroCourse = await makeCourse(U1, 'ZERO', instA.id);
      const jobs0 = await count(`select count(*) n from public.production_jobs where course_id = $1`, [zeroCourse]);
      let e = null; try { await start(P, zeroCourse, U1); } catch (x) { e = x; }
      assert(e, 'debía rechazar');
      const b = bodyOf(FC.finopsErrorToHttp(e));
      eq([b.code, b.canRequest, b.payerUserId, b.availableUsd], ['user_budget_not_assigned', true, U1, '0.0000000000'], 'cuerpo 409');
      assert(Number(b.requiredUsd) > 0, 'requiredUsd > 0: ' + b.requiredUsd);
      eq(FC.finopsErrorToHttp(e).getStatus(), 409, 'HTTP 409');
      eq(await count(`select count(*) n from public.production_jobs where course_id = $1`, [zeroCourse]), jobs0, 'sin run (rollback)');
      eq(await count(`select count(*) n from public.cost_budget_authorizations where course_id = $1 and run_id is not null`, [zeroCourse]), 0, 'sin autorización');
      eq(await count(`select count(*) n from public.budget_reservations`), 0, 'sin reserva');
    });

    // ── [SET] ───────────────────────────────────────────────────────────────────────────────────────────────────
    let A = null; let setRun = null;
    await check('[SET] el SuperAdmin asigna USD 5 (versión recurring, auditada) → el arranque reserva exactamente el authorized_budget del run, con institución, startedBy y generated_by', async () => {
      const d = await P.admin.setRecurring(saActor, U1, { monthlyAmountUsd: '5', effectiveMonth: BCOM.currentMonth(), reason: 'QA r75' });
      eq([d.limitUsd, d.availableUsd, d.versions.length, d.versions[0].kind], ['5.0000000000', '5.0000000000', 1, 'recurring'], 'detalle');
      eq(await count(`select count(*) n from public.admin_audit_log where action = 'budget.set' and target_id = $1`, [U1]), 1, 'auditoría budget.set');
      const res = await start(P, zeroCourse, U1);
      setRun = res.run.id;
      A = (await runAuth(setRun)).b;
      const [rsv] = await ds.query(`select *, amount_usd::text as a from public.budget_reservations where run_id = $1`, [setRun]);
      eq([rsv.kind, rsv.a, rsv.user_id, rsv.institution_id, rsv.status], ['start', A, U1, instA.id, 'active'], 'reserva');
      const [j] = await ds.query(`select input_payload->>'startedBy' as s from public.production_jobs where id = $1`, [setRun]);
      eq(j.s, U1, 'startedBy');
      const [c] = await ds.query(`select generated_by from public.courses where id = $1`, [zeroCourse]);
      eq(c.generated_by, U1, 'generated_by');
      const s = await P.read.summary(U1);
      eq([s.heldUsd, s.availableUsd], [A, (5 - Number(A)).toFixed(10)], 'held / disponible');
    });

    // ── [RETRY] ─────────────────────────────────────────────────────────────────────────────────────────────────
    await check('[RETRY] bindRun repetido sobre el mismo run → la misma reserva (sin doble reserva); el índice único rechaza una segunda «start»', async () => {
      const r1 = await P.gate.reserveRun(ds, { runId: setRun, courseId: zeroCourse, payerUserId: U1, kind: 'start', authorizationId: null, authorizedBudget: A });
      eq(await count(`select count(*) n from public.budget_reservations where run_id = $1`, [setRun]), 1, 'una sola');
      assert(r1.reservationId, 'devuelve la existente');
      let e = null; try { await ds.query(`insert into public.budget_reservations (user_id, course_id, run_id, kind, amount_usd, period_month) values ($1, $2, $3, 'start', 1, date_trunc('month', now())::date)`, [U1, zeroCourse, setRun]); } catch (x) { e = x; }
      eq(e && e.code, '23505', 'índice único');
    });
    await check('[RETRY] gasto DENTRO del run es neutro para el disponible (spent sube, held baja igual); reserva + liquidación del ledger y su reintento idempotente cuentan UNA vez', async () => {
      const before = await P.read.summary(U1);
      const it = await itemOf(setRun);
      const key = `reservation:test:${it.id}:r1`;
      const resIn = { itemRunId: it.id, ownerIdFromAuth: U1, provider: 'anthropic', service: 'messages', modelOrProduct: 'claude-sonnet-4-6',
        usage: { input_tokens: 1000, output_tokens: 1000 }, idempotencyKey: key, callRole: 'main', attempt: 1, billingAccount: 'cursia', mode: 'real',
        costSource: 'CALCULATED_FROM_USAGE', measurementStatus: 'pending', recordedBy: 'check', metadata: { reservation: true } };
      await P.ledger.recordCharge(resIn);
      await P.ledger.recordCharge(resIn); // reintento idempotente
      const mid = await P.read.summary(U1);
      eq(mid.availableUsd, before.availableUsd, 'disponible sin cambio con la reserva abierta');
      await P.ledger.settleReservation(key, { ...resIn, idempotencyKey: undefined, idempotency: { kind: 'anthropic', parts: { messageId: 'msg_r75_r1' } }, usage: { input_tokens: 500, output_tokens: 500 }, measurementStatus: 'final', metadata: {} }, 'test_settled');
      const after = await P.read.summary(U1);
      eq(after.availableUsd, before.availableUsd, 'disponible sin cambio tras liquidar');
      const net = Number((await ds.query(`select coalesce(sum(amount),0)::text t from public.generation_cost_events where run_id = $1 and billing_account = 'cursia'`, [setRun]))[0].t);
      near(after.spentUsd, net, 'spent = neto del ledger (una vez)');
      near(Number(after.heldUsd) + Number(after.spentUsd), Number(A), 'held + spent = autorizado');
    });

    // ── [BYOK] ──────────────────────────────────────────────────────────────────────────────────────────────────
    await check('[BYOK] cargos BYOK (user_key) y mock del run no cuentan en spent; al terminar el run el disponible vuelve a límite − gasto de Cursia', async () => {
      const before = await P.read.summary(U1);
      await charge({ owner: U1, runId: setRun, amount: '1.5', billing: 'user_key' });
      await charge({ owner: U1, runId: setRun, amount: '0', billing: 'mock' });
      await charge({ owner: U1, amount: '2.0', billing: 'user_key' }); // BYOK sin run
      const mid = await P.read.summary(U1);
      eq([mid.spentUsd, mid.heldUsd], [before.spentUsd, before.heldUsd], 'BYOK/mock fuera');
      await ds.query(`update public.production_jobs set worker_status = 'completed', status = 'completed' where id = $1`, [setRun]);
      const done = await P.read.summary(U1);
      eq(done.heldUsd, '0.0000000000', 'terminal: no retiene');
      near(done.availableUsd, 5 - Number(done.spentUsd), 'disponible = límite − gasto Cursia');
    });

    // ── [TERM] ──────────────────────────────────────────────────────────────────────────────────────────────────
    await check('[TERM] el reconciliador libera: run terminal con gasto → settled (foto en settled_usd); sin gasto → released; run pausado → sigue active y RETIENE', async () => {
      const r1 = await P.gate.releaseTerminalRuns();
      const [rs] = await ds.query(`select status, settled_usd::text s, release_reason from public.budget_reservations where run_id = $1`, [setRun]);
      eq([rs.status, rs.release_reason], ['settled', 'run_completed'], 'settled');
      assert(Number(rs.s) > 0, 'settled_usd');
      assert(r1.settled >= 1, 'contó');
      // Pausado: otro run de U1.
      const cid = await makeCourse(U1, 'TERM pausa', instA.id);
      const res = await start(P, cid, U1);
      await ds.query(`update public.production_jobs set worker_status = 'paused', status = 'paused' where id = $1`, [res.run.id]);
      const held = (await P.read.summary(U1)).heldUsd;
      eq(held, (await runAuth(res.run.id)).b, 'pausado retiene su autorizado');
      await P.gate.releaseTerminalRuns();
      eq((await ds.query(`select status from public.budget_reservations where run_id = $1`, [res.run.id]))[0].status, 'active', 'pausado: active');
      await cancelRun(res.run.id);
      eq((await P.read.summary(U1)).heldUsd, '0.0000000000', 'cancelado: deja de retener aunque la reserva siga active (fórmula)');
      await P.gate.releaseTerminalRuns(res.run.id);
      eq((await ds.query(`select status, release_reason from public.budget_reservations where run_id = $1`, [res.run.id]))[0], { status: 'released', release_reason: 'run_cancelled' }, 'cancelado sin gasto: released');
    });

    // ── [CONC] ──────────────────────────────────────────────────────────────────────────────────────────────────
    await check('[CONC] 9 arranques EN PARALELO del mismo usuario en 9 cursos distintos desde 3 «procesos»: Σ reservado nunca supera el disponible; entran exactamente floor(disponible / A); el resto 409 sin dejar nada', async () => {
      const procs = [P, await proc(), await proc()];
      const courses = [];
      for (let i = 0; i < 9; i++) courses.push(await makeCourse(U3, `CONC ${i}`, instA.id));
      // A de un run (todos los cursos son iguales): con un presupuesto de 3,5 × A entran 3.
      const a = Number(A);
      const limit = (a * 3.5).toFixed(10);
      await P.admin.setRecurring(saActor, U3, { monthlyAmountUsd: limit, effectiveMonth: BCOM.currentMonth(), reason: 'QA concurrencia' });
      const results = await Promise.allSettled(courses.map((cid, i) => start(procs[i % 3], cid, U3)));
      const ok = results.filter((r) => r.status === 'fulfilled');
      const isInsufficient = (r) => r.status === 'rejected' && r.reason && r.reason.getStatus && r.reason.getStatus() === 409 && bodyOf(r.reason).code === 'user_budget_insufficient';
      const insufficient = results.filter(isInsufficient);
      eq([ok.length, insufficient.length, results.length - ok.length - insufficient.length], [3, 6, 0], `ok / insuficiente / otros (${results.filter((r) => r.status === 'rejected' && !isInsufficient(r)).map((r) => r.reason && r.reason.message).join(' | ')})`);
      const [sum] = await ds.query(`select coalesce(sum(amount_usd),0)::text t, count(*)::int n from public.budget_reservations where user_id = $1 and status = 'active'`, [U3]);
      eq(sum.n, 3, 'tres reservas');
      assert(Number(sum.t) <= Number(limit) + 1e-9, `Σ reservado ${sum.t} ≤ ${limit}`);
      const s = await P.read.summary(U3);
      assert(Number(s.availableUsd) >= 0, 'disponible nunca negativo: ' + s.availableUsd);
      eq(await count(`select count(*) n from public.production_jobs where owner_id = $1`, [U3]), 3, 'solo 3 runs (los rechazados se revirtieron)');
      for (const r of ok) await cancelRun(r.value.run.id);
    });

    // ── [NORUN] ─────────────────────────────────────────────────────────────────────────────────────────────────
    await check('[NORUN] reserva del proxy SIN run por encima del disponible → USER_BUDGET_EXHAUSTED → HTTP 409 user_budget_insufficient; dentro del disponible pasa; en paralelo nunca se pasa', async () => {
      // U2 tiene USD 0: cualquier reserva sin run se rechaza; con USD 0.05 entran 2 de 0.02.
      const resIn = (tag, amount) => ({ itemRunId: null, ownerIdFromAuth: U2, provider: 'anthropic', service: 'messages', modelOrProduct: 'claude-sonnet-4-6',
        costSource: 'ACTUAL_PROVIDER', actualAmount: amount, idempotencyKey: `reservation:llm-proxy:${tag}`, callRole: 'main', attempt: 1,
        billingAccount: 'cursia', mode: 'real', measurementStatus: 'pending', recordedBy: 'check', metadata: { reservation: true } });
      let e = null; try { await P.ledger.recordCharge(resIn('z0', '0.01')); } catch (x) { e = x; }
      eq([e && e.code, httpCode(e)], ['USER_BUDGET_EXHAUSTED', 'user_budget_not_assigned'], 'USD 0 → rechazo');
      const spentU2 = Number((await P.read.summary(U2)).spentUsd);
      await P.admin.adjust(saActor, U2, { month: BCOM.currentMonth(), amountUsd: (spentU2 + 0.05).toFixed(10), reason: 'QA sin run' });
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => P.ledger.recordCharge(resIn(`p${i}`, '0.02'))));
      const ok = results.filter((r) => r.status === 'fulfilled');
      eq(ok.length, 2, 'entran 2 de 0.02 con 0.05 disponible');
      assert(results.filter((r) => r.status === 'rejected').every((r) => httpCode(r.reason) === 'user_budget_insufficient'), '409 user_budget_insufficient');
      const again = await P.ledger.recordCharge(resIn('p' + results.findIndex((r) => r.status === 'fulfilled'), '0.02'));
      eq(again.inserted, false, 'reintento idempotente sin evaluar');
      // BYOK sin run: nunca se rechaza por presupuesto.
      const byok = await P.ledger.recordCharge({ ...resIn('byok1', '5'), billingAccount: 'user_key' });
      assert(byok.inserted, 'BYOK pasa');
    });

    // ── [SAEXT] ─────────────────────────────────────────────────────────────────────────────────────────────────
    await check('[SAEXT] autorización del SA de un run por encima del disponible del iniciador: sin extendUserBudget → 409 (sin escribir); con él → month_adjustment auditado por la diferencia y reserva extension', async () => {
      const cid = await makeCourse(U1, 'SAEXT', instA.id);
      const res = await start(P, cid, U1);
      const before = await P.read.summary(U1);
      const auth0 = (await runAuth(res.run.id)).b;
      const big = (Number(auth0) + Number(before.availableUsd) + 1).toFixed(10);
      const nAuth = await count(`select count(*) n from public.cost_budget_authorizations where run_id = $1`, [res.run.id]);
      let e = null; try { await P.budget.adminAuthorizeRun({ courseId: cid, runId: res.run.id, authorizedBudget: big, approvedBy: SA_EMAIL, actorId: SA }); } catch (x) { e = x; }
      eq(httpCode(e), 'user_budget_insufficient', '409');
      eq(await count(`select count(*) n from public.cost_budget_authorizations where run_id = $1`, [res.run.id]), nAuth, 'sin autorización nueva (rollback)');
      await P.budget.adminAuthorizeRun({ courseId: cid, runId: res.run.id, authorizedBudget: big, approvedBy: SA_EMAIL, actorId: SA, extendUserBudget: true, reason: 'QA ext' });
      eq((await runAuth(res.run.id)).b, big, 'autorización nueva');
      const [adj] = await ds.query(`select amount_usd::text a from public.user_budgets where user_id = $1 and kind = 'month_adjustment' order by created_at desc limit 1`, [U1]);
      near(adj.a, 1, 'ajuste = diferencia (USD 1)');
      eq(await count(`select count(*) n from public.admin_audit_log where action = 'budget.adjust' and target_id = $1 and after->>'source' = 'run_authorization'`, [U1]), 1, 'auditado');
      eq(await count(`select count(*) n from public.budget_reservations where run_id = $1 and kind = 'extension'`, [res.run.id]), 1, 'reserva extension');
      near((await P.read.summary(U1)).availableUsd, 0, 'disponible exacto en 0 (no se pasa)');
      await cancelRun(res.run.id);
    });

    // ── [REQ] ───────────────────────────────────────────────────────────────────────────────────────────────────
    await check('[REQ] solicitud: creada (auditada) → duplicada 409 → aprobada por el SA (month_adjustment + auditoría request.approve y budget.adjust, disponible sube, NO arranca nada) → otra rechazada (auditada) → cancelar una cerrada 409', async () => {
      const cid = await makeCourse(U2, 'REQ', instB.id);
      const r1 = await P.requests.create(userActor(U2), { courseId: cid, amountUsd: '3.5', reason: 'Necesito generar el curso de seguridad' });
      eq([r1.status, r1.amountUsd, r1.institutionId, r1.courseTitle], ['pending', '3.5000000000', instB.id, 'REQ'], 'creada');
      let e = null; try { await P.requests.create(userActor(U2), { courseId: cid, amountUsd: '1', reason: 'otra' }); } catch (x) { e = x; }
      eq(bodyOf(e).code, 'budget_request_duplicate', 'una pendiente por curso');
      let e2 = null; try { await P.requests.create(userActor(U1), { courseId: cid, amountUsd: '1', reason: 'curso ajeno' }); } catch (x) { e2 = x; }
      eq(e2 && e2.getStatus(), 404, 'curso ajeno → 404 (RBAC off: dueño único)');
      const before = await P.read.summary(U2);
      eq(before.pendingRequests, 1, 'pendiente visible');
      const jobs0 = await count(`select count(*) n from public.production_jobs where course_id = $1`, [cid]);
      const ap = await P.requests.approve(saActor, r1.id, { approvedAmountUsd: '3', note: 'ok QA' });
      eq([ap.status, ap.approvedAmountUsd, ap.decidedBy], ['approved', '3.0000000000', SA], 'aprobada');
      const after = await P.read.summary(U2);
      near(Number(after.availableUsd) - Number(before.availableUsd), 3, 'disponible +3');
      eq(after.pendingRequests, 0, 'sin pendientes');
      eq(await count(`select count(*) n from public.production_jobs where course_id = $1`, [cid]), jobs0, 'D-21: aprobar no arranca');
      eq(await count(`select count(*) n from public.admin_audit_log where action = 'request.approve' and target_id = $1`, [r1.id]), 1, 'auditoría approve');
      eq(await count(`select count(*) n from public.user_budgets where source_request_id = $1`, [r1.id]), 1, 'ajuste ligado a la solicitud');
      let e3 = null; try { await P.requests.approve(saActor, r1.id, { approvedAmountUsd: '3' }); } catch (x) { e3 = x; }
      eq(bodyOf(e3).code, 'budget_request_not_pending', 'no se aprueba dos veces');
      const r2 = await P.requests.create(userActor(U2), { courseId: cid, amountUsd: '10', reason: 'más' });
      const rj = await P.requests.reject(saActor, r2.id, { note: 'fuera de política' });
      eq([rj.status, rj.decisionNote], ['rejected', 'fuera de política'], 'rechazada');
      eq(await count(`select count(*) n from public.admin_audit_log where action = 'request.reject' and target_id = $1`, [r2.id]), 1, 'auditoría reject');
      let e4 = null; try { await P.requests.cancel(userActor(U2), r2.id); } catch (x) { e4 = x; }
      eq(bodyOf(e4).code, 'budget_request_not_pending', 'cancelar cerrada');
      const r3 = await P.requests.create(userActor(U2), { courseId: cid, amountUsd: '1', reason: 'se cancela' });
      let e5 = null; try { await P.requests.cancel(userActor(U1), r3.id); } catch (x) { e5 = x; }
      eq(e5 && e5.getStatus(), 404, 'otro usuario no cancela');
      eq((await P.requests.cancel(userActor(U2), r3.id)).status, 'cancelled', 'el solicitante cancela');
      // Vencida: una pendiente con expires_at pasado (insert directo: la columna es inmutable por trigger).
      const [old] = await ds.query(`insert into public.budget_requests (user_id, course_id, amount_usd, reason, created_at, expires_at) values ($1, $2, 1, 'vieja', now() - interval '8 days', now() - interval '1 day') returning id`, [U2, cid]);
      let e6 = null; try { await P.requests.approve(saActor, old.id, { approvedAmountUsd: '1' }); } catch (x) { e6 = x; }
      eq(bodyOf(e6).code, 'budget_request_expired', 'vencida');
      let e7 = null; try { await P.requests.approve(userActor(U2), (await P.requests.create(userActor(U2), { courseId: cid, amountUsd: '1', reason: 'x' })).id, { approvedAmountUsd: '1' }); } catch (x) { e7 = x; }
      eq(e7 && e7.getStatus(), 403, 'un usuario no aprueba (servicio, defensa en profundidad)');
    });

    // ── [REC] ───────────────────────────────────────────────────────────────────────────────────────────────────
    await check('[REC] reconciliación vs ledger: un cargo tardío sobre un run ya liquidado aparece como drift (= el cargo) y queda auditado finops.reconcile_drift; sin cargos tardíos drift 0', async () => {
      const r0 = await P.gate.reconcile(BCOM.currentMonth(), { id: SA, email: SA_EMAIL });
      const u0 = r0.users.find((u) => u.userId === U1);
      assert(u0 && u0.driftUsd === '0.0000000000', 'sin drift: ' + JSON.stringify(u0));
      await charge({ owner: U1, runId: setRun, amount: '0.25' }); // cargo tardío (conciliación manual, p. ej.)
      const r1 = await P.gate.reconcile(BCOM.currentMonth(), { id: SA, email: SA_EMAIL });
      const u1 = r1.users.find((u) => u.userId === U1);
      near(u1.driftUsd, 0.25, 'drift = cargo tardío');
      near(Number(u1.ledgerSpentUsd) - Number(u1.settledReservationsUsd), 0.25, 'ledger − liquidado');
      eq(await count(`select count(*) n from public.admin_audit_log where action = 'finops.reconcile_drift' and target_id = $1`, [U1]), 1, 'auditado');
      near((await P.read.summary(U1)).spentUsd, Number(u1.monthSpentUsd), 'monthSpentUsd = spent');
    });

    // ── [A] controles de A en el arranque ───────────────────────────────────────────────────────────────────────
    await check('[A] congelación de plataforma y suspensión de generación / cuenta de quien paga → 403 estable en el arranque (aunque tenga presupuesto), sin dejar nada; levantadas → arranca', async () => {
      const cid = await makeCourse(U1, 'A controles', instA.id);
      await P.admin.adjust(saActor, U1, { month: BCOM.currentMonth(), amountUsd: '5', reason: 'QA controles A' });
      const jobs = async () => count(`select count(*) n from public.production_jobs where course_id = $1`, [cid]);
      const tryStart = async () => { try { await start(P, cid, U1); return null; } catch (x) { return x; } };
      await ds.query(`insert into public.platform_controls (key, enabled, reason, updated_by) values ('generation_freeze', true, 'QA', $1)
                      on conflict (key) do update set enabled = true`, [SA]);
      P.platform.cache = null;
      let e = await tryStart();
      eq([e && e.getStatus(), bodyOf(e) && bodyOf(e).code, await jobs()], [403, 'platform_generation_frozen', 0], 'congelada');
      await ds.query(`update public.platform_controls set enabled = false where key = 'generation_freeze'`);
      P.platform.cache = null;
      const [sus] = await ds.query(`insert into public.user_suspensions (user_id, kind, reason, created_by) values ($1, 'generation', 'QA', $2) returning id`, [U1, SA]);
      e = await tryStart();
      eq([e && e.getStatus(), bodyOf(e) && bodyOf(e).code, await jobs()], [403, 'generation_suspended', 0], 'generación suspendida');
      await ds.query(`update public.user_suspensions set lifted_at = now(), lifted_by = $2 where id = $1`, [sus.id, SA]);
      const [acc] = await ds.query(`insert into public.user_suspensions (user_id, kind, reason, created_by) values ($1, 'account', 'QA', $2) returning id`, [U1, SA]);
      e = await tryStart();
      eq(bodyOf(e) && bodyOf(e).code, 'account_suspended', 'cuenta suspendida');
      eq((await P.gate.denialFor(U1)).code, 'account_suspended', 'proxy: cuenta suspendida → 403');
      eq(await P.gate.denialFor(U2), null, 'otro usuario sin denegación');
      await ds.query(`update public.user_suspensions set lifted_at = now(), lifted_by = $2 where id = $1`, [acc.id, SA]);
      const res = await start(P, cid, U1);
      assert(res.run.id, 'levantadas: arranca');
      // Cuenta suspendida con un run PAUSADO por el sistema: sigue reteniendo y nadie lo reanuda a su nombre.
      await ds.query(`update public.production_jobs set worker_status = 'paused', status = 'paused' where id = $1`, [res.run.id]);
      const [acc2] = await ds.query(`insert into public.user_suspensions (user_id, kind, reason, created_by) values ($1, 'account', 'QA', $2) returning id`, [U1, SA]);
      eq((await P.read.summary(U1)).heldUsd !== '0.0000000000', true, 'pausado retiene');
      let e2 = null; try { await P.gate.assertPayerMaySpend(ds, res.run.id); } catch (x) { e2 = x; }
      eq(bodyOf(e2) && bodyOf(e2).code, 'account_suspended', 'reanudar a nombre del suspendido: 403');
      await ds.query(`update public.user_suspensions set lifted_at = now(), lifted_by = $2 where id = $1`, [acc2.id, SA]);
      await cancelRun(res.run.id);
    });
    await check('[A] R75_BUDGET_READ_SERVICE: getSummary / getSummaries (contrato de A para /me/context y GET /admin/users); null con el flag en off', async () => {
      const s1 = await P.read.getSummary(U1);
      eq(Object.keys(s1).filter((k) => ['month', 'limitUsd', 'spentUsd', 'heldUsd', 'availableUsd', 'pendingRequests'].includes(k)).length, 6, 'forma');
      const many = await P.read.getSummaries([U1, U2, 'no-uuid']);
      eq(Object.keys(many).sort(), [U1, U2].sort(), 'por usuario');
      setMode('off');
      eq(await P.read.getSummary(U1), null, 'off → null');
      setMode('enforce');
    });

    // ── [RUNS] integración runs.service (commit C2, rebasar después de r74) ──────────────────────────────────────
    await check('[RUNS] estimate-preview: userBudget aditivo (disponible, requerido = authorized del arranque, sufficient) y H5: policy.monthSpent null para quien no es SA (el SA lo ve)', async () => {
      if (typeof P.runs.userBudgetPreview !== 'function') { console.log('   (sin la integración C2: se omite)'); return; }
      const U5 = '11111111-2222-4333-8444-555555555555';
      const cid = await makeCourse(U5, 'RUNS preview', instA.id);
      const ctx = { ...CONTEXT, videoMode: 'mock', providerModes: { presentation: 'mock', audio: 'mock' } };
      const pv = await P.runs.previewStart(cid, { id: U5, email: 'u5@x.test' }, 1, ctx);
      assert(pv.userBudget && pv.userBudget.mode === 'enforce' && pv.userBudget.availableUsd === '0.0000000000' && pv.userBudget.sufficient === false && pv.userBudget.canRequest === true, 'userBudget: ' + JSON.stringify(pv.userBudget));
      eq(pv.policy ? pv.policy.monthSpent : null, null, 'monthSpent oculto');
      // Pre-tx: 409 sin crear nada, con estimateId persistido para «Solicitar autorización».
      let e = null; try { await start(P, cid, U5); } catch (x) { e = x; }
      const b = bodyOf(e);
      eq([e && e.getStatus(), b && b.code, b && b.payerUserId], [409, 'user_budget_not_assigned', U5], 'pre-tx 409');
      assert(b.estimateId && (await count(`select count(*) n from public.cost_estimates where id = $1 and run_id is null`, [b.estimateId])) === 1, 'estimado persistido');
      eq(await count(`select count(*) n from public.production_jobs where course_id = $1`, [cid]), 0, 'sin run');
      const req = await P.requests.create(userActor(U5), { courseId: cid, estimateId: b.estimateId, amountUsd: b.requiredUsd, reason: 'para este curso' });
      await P.requests.approve(saActor, req.id, { approvedAmountUsd: b.requiredUsd });
      const pv2 = await P.runs.previewStart(cid, { id: U5, email: 'u5@x.test' }, 1, ctx);
      eq([pv2.userBudget.sufficient, pv2.userBudget.requiredUsd], [true, b.requiredUsd], 'tras aprobar: alcanza');
      const res = await start(P, cid, U5);
      eq((await runAuth(res.run.id)).b, b.requiredUsd, 'requiredUsd = authorized_budget real');
      const pvSa = await P.runs.previewStart(cid, { id: U5, email: SA_EMAIL }, 1, ctx).catch((x) => x);
      assert(!(pvSa instanceof Error) || /run/i.test(String(pvSa.message)), 'preview SA');
      // Retry / reanudar con el iniciador suspendido → 403 (nadie gasta a su nombre).
      await ds.query(`update public.production_jobs set worker_status = 'paused', status = 'paused', output_summary = output_summary || '{"pause":{"reason":"user"}}'::jsonb where id = $1`, [res.run.id]);
      const [sus] = await ds.query(`insert into public.user_suspensions (user_id, kind, reason, created_by) values ($1, 'generation', 'QA', $2) returning id`, [U5, SA]);
      let e2 = null; try { await P.runs.resumeRun(cid, U5, 1, res.run.id, { id: U5, email: 'u5@x.test' }); } catch (x) { e2 = x; }
      eq(bodyOf(e2) && bodyOf(e2).code, 'generation_suspended', 'reanudar con el iniciador suspendido');
      await ds.query(`update public.user_suspensions set lifted_at = now(), lifted_by = $2 where id = $1`, [sus.id, SA]);
      await cancelRun(res.run.id);
    });

    // ── [SHADOW] ────────────────────────────────────────────────────────────────────────────────────────────────
    await check('[SHADOW] shadow: un usuario sin presupuesto ARRANCA (se aplica la regla vieja), la reserva se escribe igual y queda auditado budget.shadow_insufficient', async () => {
      setMode('shadow');
      const U4 = '11111111-2222-4333-8444-555555555554';
      const cid = await makeCourse(U4, 'SHADOW', instA.id);
      const res = await start(P, cid, U4);
      eq(await count(`select count(*) n from public.budget_reservations where run_id = $1`, [res.run.id]), 1, 'reserva escrita');
      eq(await count(`select count(*) n from public.admin_audit_log where action = 'budget.shadow_insufficient' and target_id = $1`, [res.run.id]), 1, 'auditado');
      await cancelRun(res.run.id);
      setMode('enforce');
    });

    // ── [COST] ──────────────────────────────────────────────────────────────────────────────────────────────────
    await check('[COST] CostReadService: periodSummary da los mismos totales con o sin institution_id escrito; institutionPeriodSummary(A)+(B)+(sin institución) = total; eventos nuevos llevan institution_id', async () => {
      const { from, to } = BCOM.monthRange(BCOM.currentMonth());
      const cr = new F.CostReadService(ds);
      const all = await cr.periodSummary(from, to);
      const a = await cr.institutionPeriodSummary(instA.id, from, to);
      const b = await cr.institutionPeriodSummary(instB.id, from, to);
      const none = await cr.institutionPeriodSummary(null, from, to);
      near(Number(a.committed || 0) + Number(b.committed || 0) + Number(none.committed || 0), Number(all.committed), 'A + B + sin institución = total');
      const ev = await charge({ owner: U1, courseId: zeroCourse, amount: '0.03' });
      eq(ev.event.institution_id, instA.id, 'evento nuevo con institution_id');
      const all2 = await cr.periodSummary(from, to);
      near(Number(all2.committed) - Number(all.committed), 0.03, 'el total solo cambia por el evento nuevo');
      // El evento viejo (OFF, institution_id null) se resuelve por su curso (B).
      const offEvents = Number((await ds.query(`select coalesce(sum(amount),0)::text t from public.generation_cost_events where run_id = $1 and billing_account = 'cursia'`, [offRun]))[0].t);
      assert(offEvents > 0 && Number(b.committed) >= offEvents, 'evento viejo atribuido a B por su curso');
    });
    await check('[COST] fecha efectiva (H6 d): un ajuste del mes actual sobre un cargo del mes pasado NO cuenta en monthCommitted del mes con presupuestos activos (en off, como antes, sí)', async () => {
      const prev = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) - 5 * 86400000).toISOString();
      const [c] = await ds.query(
        `insert into public.generation_cost_events (event_kind, owner_id, provider, service, model_or_product, operation, call_role, attempt, idempotency_key, amount, currency, cost_source, measurement_status, billing_account, billable, outcome, recorded_by, created_at)
         values ('CHARGE', $1, 'anthropic', 'messages', 'm', 'llm.unattributed', 'main', 1, $2, 1, 'USD', 'ACTUAL_PROVIDER', 'final', 'cursia', true, 'succeeded', 'check', $3) returning id`,
        ['99999999-0000-4000-8000-000000000001', 'r75c:eff:' + crypto.randomUUID(), prev]);
      await ds.query(
        `insert into public.generation_cost_events (event_kind, corrects_event_id, owner_id, provider, service, model_or_product, operation, call_role, attempt, idempotency_key, amount, currency, cost_source, measurement_status, billing_account, billable, outcome, recorded_by)
         values ('ADJUSTMENT', $1, $2, 'anthropic', 'messages', 'm', 'llm.unattributed', 'main', 1, $3, -0.4, 'USD', 'ACTUAL_PROVIDER', 'final', 'cursia', true, 'succeeded', 'check')`,
        [c.id, '99999999-0000-4000-8000-000000000001', 'r75c:eff-adj:' + crypto.randomUUID()]);
      setMode('off');
      const off = await P.budget.ownerMonthCommitted('99999999-0000-4000-8000-000000000001');
      setMode('enforce');
      const on = await P.budget.ownerMonthCommitted('99999999-0000-4000-8000-000000000001');
      eq([off.spent, on.spent], ['-0.4000000000', '0.0000000000'], 'off: created_at (legacy) / enforce: fecha efectiva');
    });

    // ── HTTP real (JWT + guards + controllers) para [MANIP] e [INST] ─────────────────────────────────────────────
    const jwt = require('jsonwebtoken');
    const { NestFactory } = require('@nestjs/core');
    const { Module } = require('@nestjs/common');
    const { AllExceptionsFilter } = L('common/filters/http-exception.filter.js');
    const { ResponseInterceptor } = L('common/interceptors/response.interceptor.js');
    // Puerto de permisos FALSO (en lugar de PermissionService de B): spend.view = ADMIN_INSTITUCIONAL activo en ESA institución.
    // r75 (integración, P0): devuelve una DECISIÓN con la forma de PermissionService de B ({allowed, …}), NO un booleano:
    // un rechazo es un objeto «truthy» y antes abría el gasto a cualquiera (B → 200). [INST] lo cubre por HTTP.
    const fakePermissions = { async can(actor, permission, institutionId) {
      const deny = { allowed: false, code: 'permission_denied', httpStatus: 403, permission, institutionId, reason: 'fake' };
      if (permission !== 'spend.view') return deny;
      const [m] = await ds.query(`select 1 from public.institution_memberships where user_id = $1 and institution_id = $2 and status = 'active' and role = 'ADMIN_INSTITUCIONAL'`, [actor.id, institutionId]);
      return m ? { allowed: true, via: 'role', permission, institutionId, role: 'ADMIN_INSTITUCIONAL' } : deny;
    } };
    await check('[P0] permissionAllowed: solo {allowed:true} (o true) permite; {allowed:false}, objetos sin allowed, null y undefined NIEGAN', async () => {
      const { permissionAllowed } = L('modules/budgets/budget-common.js');
      const got = [true, { allowed: true }, { allowed: false, code: 'permission_denied' }, {}, null, undefined, false, 'yes', { allowed: 'true' }].map(permissionAllowed);
      assert(JSON.stringify(got) === JSON.stringify([true, true, false, false, false, false, false, false, false]), JSON.stringify(got));
    });
    // B registra su PermissionService con el token compartido R75_PERMISSION_SERVICE; acá un ModuleRef falso lo devuelve.
    const accessWithPort = new BudgetAccessService(ds, { get: (token) => (token === 'R75_PERMISSION_SERVICE' ? fakePermissions : undefined) });
    const requestsHttp = new BudgetRequestsService(ds, P.read, P.gate, accessWithPort, P.audit, P.ledger);
    class TestModule {}
    Module({
      controllers: [BC.BudgetsController, BC.BudgetsAdminController, SC.InstitutionSpendController, SC.AdminSpendController],
      providers: [
        { provide: DataSource, useValue: ds }, { provide: BudgetReadService, useValue: P.read }, { provide: BudgetRequestsService, useValue: requestsHttp },
        { provide: BudgetAccessService, useValue: accessWithPort }, { provide: BudgetAdminService, useValue: P.admin }, { provide: BudgetReservationService, useValue: P.gate },
        { provide: F.CostReadService, useValue: new F.CostReadService(ds) },
      ],
    })(TestModule);
    app = await NestFactory.create(TestModule, { logger: false });
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    const tok = (sub, email) => jwt.sign({ sub, email, role: 'authenticated', user_metadata: { email_verified: true } }, process.env.SUPABASE_JWT_SECRET, { expiresIn: 600 });
    const call = async (method, p, who, body) => {
      const headers = { 'content-type': 'application/json' };
      if (who) headers.authorization = `Bearer ${tok(who.id, who.email)}`;
      const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      let json = null; try { json = await res.json(); } catch { /* vacío */ }
      return { status: res.status, body: json };
    };
    const u1 = { id: U1, email: 'u1@x.test' }; const u2 = { id: U2, email: 'u2@x.test' }; const adminA = { id: ADMIN_A, email: 'admin-a@x.test' }; const sa = { id: SA, email: SA_EMAIL };

    await check('[MANIP] una llamada manipulada de un usuario NO cambia un presupuesto: PUT/ajuste/aprobación/listados admin → 403; sin JWT → 401; campos extra → 400; el límite queda igual; UPDATE directo a user_budgets → trigger', async () => {
      const before = (await call('GET', '/me/budget', u1)).body.data;
      const attempts = [
        ['PUT', `/admin/users/${U1}/budget`, { monthlyAmountUsd: '9999', effectiveMonth: BCOM.currentMonth(), reason: 'yo mismo' }],
        ['POST', `/admin/users/${U1}/budget-adjustments`, { month: BCOM.currentMonth(), amountUsd: '9999', reason: 'yo mismo' }],
        ['GET', '/admin/budgets', undefined],
        ['GET', `/admin/users/${U1}/budget`, undefined],
        ['GET', '/admin/budget-requests', undefined],
        ['POST', `/admin/budget-requests/${crypto.randomUUID()}/approve`, { approvedAmountUsd: '9999' }],
        ['POST', '/admin/budgets/reconcile', { month: BCOM.currentMonth() }],
        ['GET', '/admin/spend', undefined],
      ];
      for (const [m, p, b] of attempts) {
        const r = await call(m, p, u1, b);
        eq(r.status, 403, `${m} ${p}`);
      }
      eq((await call('GET', '/me/budget', null)).status, 401, 'sin JWT');
      const forged = await call('POST', '/budget-requests', u1, { courseId: zeroCourse, amountUsd: '5', reason: 'x', limitUsd: '9999', userId: U2 });
      eq([forged.status, forged.body.code], [400, 'invalid_input'], 'campos extra');
      const asNumber = await call('POST', '/budget-requests', u1, { courseId: zeroCourse, amountUsd: 5, reason: 'x' });
      eq([asNumber.status, asNumber.body.code], [400, 'invalid_amount'], 'monto como number');
      const after = (await call('GET', '/me/budget', u1)).body.data;
      eq([after.limitUsd, after.availableUsd], [before.limitUsd, before.availableUsd], 'límite intacto');
      let e = null; try { await ds.query(`update public.user_budgets set amount_usd = 9999 where user_id = $1`, [U1]); } catch (x) { e = x; }
      assert(e && /append-only/.test(e.message), 'trigger append-only');
      const ok = await call('PUT', `/admin/users/${U2}/budget`, sa, { monthlyAmountUsd: '2', effectiveMonth: BCOM.currentMonth(), reason: 'SA vía HTTP' });
      eq([ok.status, ok.body.data.userId], [200, U2], 'el SA sí');
      const past = await call('PUT', `/admin/users/${U2}/budget`, sa, { monthlyAmountUsd: '2', effectiveMonth: '2021-01', reason: 'pasado' });
      eq([past.status, past.body.code], [400, 'month_invalid'], 'mes pasado');
    });

    await check('[INST] gasto por institución: el ADMIN_INSTITUCIONAL de A ve SOLO A (totales = atribuido a A, sin detalle por item); B → 403; un CREADOR sin spend.view → 403; el SA ve A, B y «sin institución» en /admin/spend', async () => {
      const { from, to } = BCOM.monthRange(BCOM.currentMonth());
      const cr = new F.CostReadService(ds);
      const expectA = await cr.institutionPeriodSummary(instA.id, from, to);
      const ra = await call('GET', `/institutions/${instA.id}/spend`, adminA);
      eq(ra.status, 200, 'A: 200');
      eq([ra.body.data.institutionId, ra.body.data.committedUsd], [instA.id, expectA.committed], 'solo lo de A');
      assert(Array.isArray(ra.body.data.byUser) && Array.isArray(ra.body.data.byCourse) && Array.isArray(ra.body.data.byProvider), 'agrupaciones');
      assert(!('byItemType' in ra.body.data) && !('byItemKey' in ra.body.data), 'sin detalle por item (D-24)');
      const courseIdsA = (await ds.query(`select id from public.courses where institution_id = $1`, [instA.id])).map((x) => Number(x.id));
      // courseId null = eventos SIN curso atribuidos a A por la única membresía activa del usuario (01 §6).
      assert(ra.body.data.byCourse.every((c) => c.courseId === null || courseIdsA.includes(c.courseId)), 'ningún curso de otra institución');
      assert(ra.body.data.byCourse.some((c) => c.courseId !== null), 'hay cursos de A');
      eq((await call('GET', `/institutions/${instB.id}/spend`, adminA)).status, 403, 'B: 403');
      eq((await call('GET', `/institutions/${instA.id}/spend`, u1)).status, 403, 'creador sin spend.view: 403');
      const rs = await call('GET', `/institutions/${instB.id}/spend?groupBy=course`, sa);
      eq([rs.status, 'byUser' in rs.body.data], [200, false], 'SA ve B; groupBy');
      const all = await call('GET', '/admin/spend?groupBy=institution', sa);
      eq(all.status, 200, 'admin/spend');
      const keys = all.body.data.rows.map((x) => x.key);
      assert(keys.includes(instA.id) && keys.includes(instB.id), 'A y B');
      assert(typeof all.body.data.unattributedUsd === 'string', 'sin institución (solo SA)');
      const byUser = await call('GET', '/admin/spend?groupBy=user', sa);
      assert(byUser.body.data.rows.some((x) => x.key === U1), 'por usuario');
      const bad = await call('GET', `/institutions/not-a-uuid/spend`, sa);
      eq(bad.status, 400, 'id inválido');
    });

    await check('[HTTP] contrato de errores: 409 user_budget_insufficient llega con code + requiredUsd/availableUsd/payerUserId/canRequest (requiere el cambio de AllExceptionsFilter documentado); /me/budget-requests y cancel por HTTP', async () => {
      const e = FC.finopsErrorToHttp(new F.FinopsError('USER_BUDGET_INSUFFICIENT', 'x', { requiredUsd: '2.0000000000', availableUsd: '1.0000000000', payerUserId: U1, notAssigned: false }));
      const b = e.getResponse();
      eq([e.getStatus(), b.code, b.requiredUsd, b.availableUsd, b.payerUserId, b.canRequest], [409, 'user_budget_insufficient', '2.0000000000', '1.0000000000', U1, true], 'cuerpo');
      const mine = await call('GET', '/me/budget-requests?status=pending', u2);
      eq(mine.status, 200, 'listado propio');
      assert(mine.body.data.every((r) => r.userId === U2), 'solo las propias');
    });
  } finally {
    if (app) await app.close().catch(() => undefined);
    for (const d of pools) await d.destroy().catch(() => undefined);
    restoreProviders();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log(`\n${passes} OK, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
}).catch((err) => { console.error('❌ Error inesperado:', err && err.stack ? err.stack : err); process.exit(1); });
