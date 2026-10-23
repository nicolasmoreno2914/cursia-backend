#!/usr/bin/env node
/* eslint-disable */
// r65 — reintento seguro del DUEÑO (no admin) de una parte y ronda automática extra de una parte que agotó su tope
// interno (item_recovery_budget_exhausted). PG16 desechable + RunsService/FinopsBudgetService reales; el proveedor es
// el ledger simulado (proxy LLM del navegador como en check-recovery-budget.js). USD 0, sin red.
//
// Casos: (1) veredicto allowed + maxCostUsd = tope de la parte + retry del dueño registra ownerRetries; (2) 3.er reintento
// en 24 h → 409 owner_retry_limit (el admin sí); (3) reserva abierta → allowed=false + 409; (4) llm_pending_review /
// llm_response_lost → allowed=false; (5) video con render pagado sin conciliar → allowed=false (solo admin); (6) saldo del
// run < maxCostUsd → run_budget_insufficient; (7) budgetScope item vs run; (8) R4: UNA ronda extra con su marca y la
// reapertura del run, sin tercera ronda, sin saldo no hay ronda; (9) dos retries concurrentes del dueño = UN reintento.
//
// Usage: npm run build && node scripts/check-r65-owner-retry.js [path/to/dist]

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const distArg = args.find((a) => !a.startsWith('--'));
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), distArg || 'dist');

function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar ${abs} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}

require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const EL = loadDist('modules/reliability/execution-lease.js');
const { applyFakeProviderEnv } = require('./lib/provider-test-env');

Logger.overrideLogger({ log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {} });

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`);
}
async function rejectsCode(p, code, what) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${what}: debía rechazar con ${code}`);
  const body = err.getResponse ? err.getResponse() : null;
  const got = (body && typeof body === 'object' && body.code) || err.message;
  assert(String(got) === code || new RegExp(code).test(String(err.message)), `${what}: código ${got} (esperado ${code}) — ${err.message}`);
  return { err, body, status: err.getStatus ? err.getStatus() : null };
}

// ════════════════════════════════════════════════════════════════════════════
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
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => ([5570, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const CONTEXT = { nombre: 'Curso REL lease', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_GENERAL_AVAILABILITY', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY',
  'SUPER_ADMIN_EMAILS', 'DYNAMIC_AUTO_HEAL_POLICY'];
const A = 'browser-dev-AAAAAAAA';
const B = 'browser-dev-BBBBBBBB';
const TYPES = ['content', 'experience'];

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
  const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
  const { Artifact } = loadDist('modules/artifacts/entities/artifact.entity.js');
  const AL = loadDist('modules/reliability/attempt-log.js');
  const F = loadDist('modules/finops/index.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r65-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r65-cwd-'));
  const ROLE = 'postgres.r65local01';
  const DB = 'r65db';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const restoreProviders = applyFakeProviderEnv();
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`\nPostgres ${pgBin} en 127.0.0.1:${port} (data ${dataDir})`);
    const withClient = async (db, fn) => {
      const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db });
      await c.connect();
      try { return await fn(c); } finally { await c.end(); }
    };
    await withClient('postgres', async (c) => {
      await c.query(`create database ${DB}`);
      await c.query(`create role "${ROLE}" superuser login`);
    });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
        'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    {
      const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({}));
      assert(res.code === 0, `migrate-production-jobs-constraints: ${res.out}`);
    }
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js',
      'scripts/migrate-v21-finops.js', 'scripts/verify-v21-finops-schema.js', 'scripts/migrate-rel-recovery.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }

    {
      const res = runScript('scripts/migrate-rel-exec-lease.js', localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `migrate-rel-exec-lease: ${res.out.slice(-800)}`);
    }
    for (const s of ['scripts/migrate-run-pause.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: ${res.out.slice(-800)}`);
    }
    // r65 (R4): presencia del worker de IA (la ronda extra solo aplica a partes que ejecuta el servidor).
    await withClient(DB, async (c) => { await c.query(fs.readFileSync(path.join(REPO, 'supabase-migration-llm-worker-presence.sql'), 'utf8')); });

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    process.env.DYNAMIC_V2_GENERAL_AVAILABILITY = 'true'; // fail closed: sin lista, V2 solo con habilitación pública explícita
    delete process.env.ALLOW_UNOWNED_COURSES;
    delete process.env.DYNAMIC_AUTO_HEAL_POLICY;
    process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    delete process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT;
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    process.env.VIDEOGEN_API_KEY = 'fake-videogen-key-never-used-no-network';
    process.env.SUPER_ADMIN_EMAILS = 'admin@cursia.test';
    AL.resetRelSchemaCache();
    EL.resetExecLeaseSchemaCache();

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 6 } });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const ytOk = { async check() { return { ok: true }; } };
    const runs = new RunsService(ds, manifests, {}, ytOk, budget);
    const sched = new SchedulerService(ds, runs);

    async function makeCourse(title) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID(); const c3 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: true, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'Válvulas', objective: null, video_enabled: false, activity_enabled: true },
          { id: c3, module_id: m1, position: 2, title: 'Sellos', objective: null, video_enabled: false, activity_enabled: true }],
      );
      for (const m of s2.modules) {
        await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
        for (const c of m.chapters) {
          await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`,
            [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
        }
      }
      await ds.query(
        `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, 2, $2::jsonb, $3, 0, 1, 3)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      await manifests.getOrCreate(cid, OWNER, 1);
      let runId;
      try {
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      } catch (err) {
        const body = err.getResponse ? err.getResponse() : null;
        assert(body && body.code === 'budget_approval_required', `startRun: ${err.message}`);
        await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test', reason: 'check REL lease' });
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      }
      // Todo completado salvo los 3 content (pendientes, reclamables por el navegador).
      const keys = [c1, c2, c3].map((c) => `content:${c}`);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and not (item_key = any($2::text[]))`, [runId, keys]);
      await ds.query(`update public.generation_item_runs set status = 'pending' where job_id = $1 and item_key = any($2::text[])`, [runId, keys]);
      return { cid, m1, c1, c2, c3, runId, keys };
    }
    const runRow = async (runId) => (await ds.query(`select * from public.production_jobs where id = $1`, [runId]))[0];
    const claim = (runId, executorId, extra = {}) => sched.claimNextItemDetailed({ runId, executorId, types: TYPES, leaseSeconds: 120, ownerId: OWNER, ...extra });
    const secsLeft = (row) => (new Date(row.executor_lease_expires_at).getTime() - Date.now()) / 1000;
    const expire = (runId) => ds.query(`update public.production_jobs set executor_lease_expires_at = now() - interval '1 second' where id = $1`, [runId]);
    async function readsFor(C) {
      const out = {};
      for (const ex of [A, B, null]) {
        const dto = await runs.getRun(C.cid, OWNER, 1, C.runId, { executorId: ex });
        const cur = await runs.getCurrentRun(C.cid, OWNER, 1, { executorId: ex });
        assert(dto && dto.id === C.runId && cur && cur.id === C.runId, 'GET ok para ' + ex);
        assert(Array.isArray(dto.items) && dto.items.length > 0 && dto.progress, 'progreso visible para ' + ex);
        out[ex || 'anon'] = dto.executionLease;
      }
      return out;
    }

    const AH = loadDist('modules/dynamic-generation/auto-heal.js');
    const CL = loadDist('modules/reliability/failure-classifier.js');
    const G = loadDist('modules/finops/run-spend-guard.js');
    const OR = loadDist('modules/dynamic-generation/owner-retry.js');
    const LR = loadDist('modules/dynamic-generation/llm-worker-routing.js');
    const itemOf = async (C, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [C.runId, key]))[0];
    let msgSeq = 0;
    async function proxyCall(itemRunId, o = {}) {
      const promptChars = o.promptChars ?? 36000;
      const maxTokens = o.maxTokens ?? 8000;
      const deny = await budget.guardLlmProxyCall({ subject: OWNER, itemRunId, model: 'claude-sonnet-4-6', promptChars, maxTokens, billingAccount: 'cursia' });
      if (deny) return { denied: deny };
      const callId = crypto.randomUUID();
      await ledger.recordCharge(F.llmReservationToChargeInput(F.parseLlmReservationIngest({ subject: OWNER, itemRunId, callRole: 'main', attempt: 1, model: 'claude-sonnet-4-6', callId, promptChars, maxTokens, billingAccount: 'cursia' })));
      if (o.outcome === 'unknown') return { callId, pending: true };
      const u = F.parseLlmUsageIngest({ subject: OWNER, itemRunId, callRole: 'main', attempt: 1, model: 'claude-sonnet-4-6', messageId: 'msg_r65_' + (++msgSeq), usage: { input_tokens: o.inTok ?? 12000, output_tokens: o.outTok ?? 5400 }, billingAccount: 'cursia', callId });
      await ledger.settleReservation(F.llmProxyReservationKey(callId), F.llmIngestToChargeInput(u), 'llm_proxy_measured');
      return { callId, ok: true };
    }
    const OWNER_ACTOR = { id: OWNER, email: 'owner@cursia.test' };
    const ADMIN_ACTOR = { id: 'admin-1', email: 'admin@cursia.test' };
    const ownerRetry = (C, key, actor = OWNER_ACTOR) => runs.retryItem(C.cid, OWNER, 1, C.runId, key, false, false, undefined, actor);
    const dtoItem = async (C, key) => (await runs.getRun(C.cid, OWNER, 1, C.runId)).items.find((i) => i.itemKey === key);
    const failWith = (id, error) => ds.query(`update public.generation_item_runs set status = 'failed', error = $2, finished_at = now(), worker_id = null, lease_until = null where id = $1`, [id, error]);
    const budgetMsg = () => G.itemRecoveryBudgetMessage('esta parte ya gastó USD 0.62 (esperado USD 0.20, presupuesto de recuperación hasta USD 0.55)');
    async function exhaust(C, key) {
      const it = await itemOf(C, key);
      let denial = null;
      for (let i = 0; i < 20 && !denial; i++) { const r = await proxyCall(it.id); if (r.denied) denial = r.denied; }
      assert(denial && denial.code === 'item_recovery_budget_exhausted', 'agotó su tope: ' + JSON.stringify(denial));
      await failWith(it.id, budgetMsg());
      return itemOf(C, key);
    }
    // r65 fix round 1: gasto de la parte en su ventana vigente (desde el último reinicio del presupuesto).
    async function windowSpent(C, key) {
      const it = await itemOf(C, key);
      const [r] = await ds.query(`select coalesce(sum(amount),0)::text t from public.generation_cost_events
         where run_id = $1 and item_key = $2 and billing_account <> 'user_key'
           and created_at >= greatest($3::timestamptz, coalesce(nullif($4, '')::timestamptz, $3::timestamptz))`,
        [C.runId, key, it.created_at, (it.output_summary && it.output_summary.recoveryBudgetResetAt) || '']);
      return Number(r.t);
    }
    // Simula el PEOR caso real contra el guard: llamadas cuya reserva queda pendiente (cuenta la cota entera) hasta que
    // el guard niega. Devuelve lo gastado en la ventana nueva.
    async function burnUntilDenied(C, key, o = {}) {
      const it = await itemOf(C, key);
      let denial = null; let calls = 0;
      for (let i = 0; i < 40 && !denial; i++) { const r = await proxyCall(it.id, { outcome: 'unknown', ...o }); if (r.denied) denial = r.denied; else calls++; }
      assert(denial && denial.code === 'item_recovery_budget_exhausted', 'el guard terminó negando por el tope de la parte: ' + JSON.stringify(denial));
      return { spent: await windowSpent(C, key), calls };
    }
    const setAuthorized = (C, amount) => ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, authorized_budget, decision, approved_by, reason)
      values ($1, $2, $3, 'ADMIN_APPROVED', 'admin@cursia.test', 'r65: saldo del run')`, [C.runId, C.cid, amount]);
    const runSpent = async (C) => Number((await ds.query(`select coalesce(sum(amount),0)::text t from public.generation_cost_events where run_id = $1 and billing_account <> 'user_key'`, [C.runId]))[0].t);

    // ── 1 · veredicto allowed + reintento del dueño ─────────────────────────────
    const A1 = await makeCourse('r65 dueño');
    const kA = `content:${A1.c1}`;
    await check('1 · dueño con item_recovery_budget_exhausted, 0 reservas abiertas y saldo: allowed (maxCostUsd > 0; su peor caso real lo prueba fix1); retryItem del dueño reabre, reinicia el tope de la parte y registra ownerRetries', async () => {
      const row = await exhaust(A1, kA);
      const d = await dtoItem(A1, kA);
      assert(d.ownerRetry && d.ownerRetry.allowed === true && d.ownerRetry.reason === null, 'allowed: ' + JSON.stringify(d.ownerRetry));
      assert(Number(d.ownerRetry.maxCostUsd) > 0, 'maxCostUsd: ' + d.ownerRetry.maxCostUsd);
      eq([d.ownerRetry.retriesLeft, d.ownerRetry.windowHours], [2, 24], 'retriesLeft / ventana');
      eq(d.budgetScope, 'item', 'budgetScope');
      const before = await runSpent(A1);
      const it = await ownerRetry(A1, kA);
      eq(it.status, 'pending', 'reabierta');
      const after = await itemOf(A1, kA);
      assert(after.output_summary.recoveryBudgetResetAt, 'presupuesto de recuperación nuevo');
      const ors = after.output_summary.ownerRetries || [];
      assert(ors.length === 1 && ors[0].by === OWNER && ors[0].at, 'ownerRetries: ' + JSON.stringify(ors));
      eq(await runSpent(A1), before, 'el reintento no cambió el gasto ni la autorización del run');
      const auths = await ds.query(`select count(*)::int n from public.cost_budget_authorizations where run_id = $1`, [A1.runId]);
      eq(auths[0].n >= 1, true, 'autorización intacta');
      const r = await proxyCall(after.id);
      assert(r.ok, 'la parte vuelve a poder llamar dentro de lo autorizado: ' + JSON.stringify(r));
      void row;
    });

    // ── 2 · límite de 2 reintentos en 24 h ──────────────────────────────────────
    await check('2 · el 3.er reintento del dueño en 24 h → 409 owner_retry_limit sin cambios; el SUPER_ADMIN sí puede (sin consumir el límite)', async () => {
      let it = await itemOf(A1, kA);
      await failWith(it.id, budgetMsg());
      await ownerRetry(A1, kA); // 2.º
      it = await itemOf(A1, kA);
      await failWith(it.id, budgetMsg());
      const d = await dtoItem(A1, kA);
      eq([d.ownerRetry.allowed, d.ownerRetry.reason, d.ownerRetry.retriesLeft], [false, 'owner_retry_limit', 0], 'veredicto');
      const snap = JSON.stringify((await itemOf(A1, kA)).output_summary);
      const r = await rejectsCode(ownerRetry(A1, kA), 'owner_retry_limit', '3.er reintento');
      eq(r.status, 409, 'HTTP 409');
      const now = await itemOf(A1, kA);
      eq([now.status, JSON.stringify(now.output_summary)], ['failed', snap], 'nada cambió');
      const ad = await ownerRetry(A1, kA, ADMIN_ACTOR);
      eq(ad.status, 'pending', 'el admin reintenta');
      eq(((await itemOf(A1, kA)).output_summary.ownerRetries || []).length, 2, 'el reintento del admin no cuenta en el límite del dueño');
    });

    // ── 3 · reserva abierta ─────────────────────────────────────────────────────
    const A3 = await makeCourse('r65 reserva abierta');
    const kB = `content:${A3.c2}`;
    await check('3 · una reserva PENDIENTE sin conciliar de la parte → allowed=false (open_reservations) y retryItem del dueño 409 sin cambios', async () => {
      const it = await itemOf(A3, kB);
      const r = await proxyCall(it.id, { outcome: 'unknown' });
      assert(r.pending, 'reserva pendiente');
      await failWith(it.id, budgetMsg());
      const d = await dtoItem(A3, kB);
      eq([d.ownerRetry.allowed, d.ownerRetry.reason], [false, 'open_reservations'], 'veredicto');
      await rejectsCode(ownerRetry(A3, kB), 'open_reservations', 'retry del dueño');
      eq((await itemOf(A3, kB)).status, 'failed', 'sigue failed');
    });

    // ── 4 · resultados ambiguos de la IA ────────────────────────────────────────
    await check('4 · llm_pending_review y llm_response_lost → allowed=false (ambiguous_paid_result) y 409 al dueño', async () => {
      const k3 = `content:${A3.c3}`;
      const it = await itemOf(A3, k3);
      for (const err of ['llm_pending_review: resultado ambiguo repetido de la IA (2 desconocidos). Esta parte queda en revisión.',
        '⚠️ Resultado ambiguo de la IA (HTTP 524: la respuesta se perdió y el proveedor pudo cobrarla). No se reintenta solo para no pagarla dos veces.',
        'llm_response_lost: la respuesta se perdió (524)']) {
        await failWith(it.id, err);
        const d = await dtoItem(A3, k3);
        eq([d.ownerRetry.allowed, d.ownerRetry.reason], [false, 'ambiguous_paid_result'], 'veredicto de ' + err.slice(0, 30));
        await rejectsCode(ownerRetry(A3, k3), 'ambiguous_paid_result', 'retry del dueño ' + err.slice(0, 30));
        eq((await itemOf(A3, k3)).status, 'failed', 'sigue failed');
      }
    });

    // ── 5 · video con render pagado sin conciliar ──────────────────────────────
    await check('5 · video con render ya pagado y sin conciliar → allowed=false (paid_external_unreconciled); sigue siendo solo de admin (403 admin_recovery_only al dueño)', async () => {
      const kv = `video:${A3.c1}`;
      const it = await itemOf(A3, kv);
      assert(it, 'el curso tiene un video');
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'videogen_failed: render rechazado', finished_at = now(),
        output_summary = (coalesce(output_summary, '{}'::jsonb) - 'delivery' - 'external') || '{"externalSubmitStartedAt":"2026-10-01T00:00:00Z"}'::jsonb where id = $1`, [it.id]);
      const d = await dtoItem(A3, kv);
      // fix round 1: la ambigüedad va antes que el trabajo externo → videogen_failed (riesgo de cobro incierto) = ambiguous_paid_result.
      eq([d.ownerRetry.allowed, d.ownerRetry.reason], [false, 'ambiguous_paid_result'], 'veredicto');
      await rejectsCode(ownerRetry(A3, kv), 'admin_recovery_only', 'retry del dueño');
      eq((await itemOf(A3, kv)).status, 'failed', 'sigue failed');
      // Un re-poll GRATIS (video_timeout con su job de Videogen) sigue siendo del dueño: paid_external_unreconciled sin 409.
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'video_timeout: el render sigue en proceso', finished_at = now(),
        output_summary = (coalesce(output_summary, '{}'::jsonb) - 'delivery' - 'externalSubmitStartedAt') || '{"external":{"videogenJobId":"vg-job-r65"}}'::jsonb where id = $1`, [it.id]);
      const d2 = await dtoItem(A3, kv);
      eq([d2.ownerRetry.allowed, d2.ownerRetry.reason], [false, 'paid_external_unreconciled'], 'veredicto del re-poll');
      eq((await ownerRetry(A3, kv)).status, 'pending', 're-poll del dueño permitido');
    });

    // ── fix round 1 · reenvíos explícitos = solo SUPER_ADMIN ──────────────────
    await check('fix1 · el dueño NO puede reenviar a un proveedor (resubmitProvider / resubmitVideo → 403 admin_recovery_only); un envío ambiguo de Gamma da ambiguous_paid_result (409) al reintento simple', async () => {
      const P = await makeCourse('r65 reenvío');
      const pres = (await ds.query(`select * from public.generation_item_runs where job_id = $1 and type = 'presentation' order by item_key limit 1`, [P.runId]))[0];
      assert(pres, 'el curso tiene una presentación');
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'gamma_submit_ambiguous: no sabemos si Gamma recibió el pedido', finished_at = now(),
        output_summary = coalesce(output_summary, '{}'::jsonb) || '{"externalSubmitStartedAt":"2026-10-01T00:00:00Z"}'::jsonb where id = $1`, [pres.id]);
      const d = await dtoItem(P, pres.item_key);
      eq([d.ownerRetry.allowed, d.ownerRetry.reason], [false, 'ambiguous_paid_result'], 'veredicto (ambigüedad antes que el trabajo externo)');
      const r1 = await rejectsCode(runs.retryItem(P.cid, OWNER, 1, P.runId, pres.item_key, false, true, undefined, OWNER_ACTOR), 'admin_recovery_only', 'resubmitProvider del dueño');
      eq(r1.status, 403, 'HTTP 403');
      const kv = `video:${P.c1}`;
      await rejectsCode(runs.retryItem(P.cid, OWNER, 1, P.runId, kv, true, false, undefined, OWNER_ACTOR), 'admin_recovery_only', 'resubmitVideo del dueño');
      await rejectsCode(ownerRetry(P, pres.item_key), 'ambiguous_paid_result', 'reintento simple del dueño');
      eq((await itemOf(P, pres.item_key)).status, 'failed', 'nada cambió');
      const ad = await runs.retryItem(P.cid, OWNER, 1, P.runId, pres.item_key, false, true, undefined, ADMIN_ACTOR);
      eq(ad.status, 'pending', 'el SUPER_ADMIN sí reenvía');
    });

    // ── fix round 1 · el límite vale también fuera de la lista ────────────────
    await check('fix1 · un D FUERA de la lista (sin botón, endpoint de siempre): el 3.er reintento del dueño en 24 h → 409 owner_retry_limit', async () => {
      const L = await makeCourse('r65 límite fuera de lista');
      const kL = `content:${L.c1}`;
      const it = await itemOf(L, kL);
      for (let n = 1; n <= 2; n++) {
        await failWith(it.id, 'config rota: algo raro del ejecutor');
        const d = await dtoItem(L, kL);
        eq([d.ownerRetry.allowed, d.ownerRetry.reason], [false, 'failure_not_owner_retryable'], 'sin botón (' + n + ')');
        eq((await ownerRetry(L, kL)).status, 'pending', 'el endpoint lo acepta como antes (' + n + ')');
      }
      await failWith(it.id, 'config rota: algo raro del ejecutor');
      eq((await dtoItem(L, kL)).ownerRetry.reason, 'owner_retry_limit', 'el veredicto ya muestra el límite');
      await rejectsCode(ownerRetry(L, kL), 'owner_retry_limit', '3.er reintento');
      eq([(await itemOf(L, kL)).status, ((await itemOf(L, kL)).output_summary.ownerRetries || []).length], ['failed', 2], 'nada cambió');
    });

    // ── fix round 1 · maxCostUsd cubre el peor caso REAL del guard ─────────────
    await check('fix1 · el peor caso real de una ventana nueva (llamadas pendientes hasta que el guard niega) ≤ maxCostUsd', async () => {
      const S = await makeCourse('r65 peor caso');
      const kS = `content:${S.c1}`;
      await exhaust(S, kS);
      const d = await dtoItem(S, kS);
      assert(d.ownerRetry.allowed, JSON.stringify(d.ownerRetry));
      await ownerRetry(S, kS);
      const b = await burnUntilDenied(S, kS);
      assert(b.calls >= 1 && b.spent <= Number(d.ownerRetry.maxCostUsd) + 1e-9, `gastado en la ventana USD ${b.spent.toFixed(4)} (${b.calls} llamadas) ≤ maxCostUsd ${d.ownerRetry.maxCostUsd}`);
      console.log(`   peor caso: USD ${b.spent.toFixed(4)} en ${b.calls} llamadas; maxCostUsd ${d.ownerRetry.maxCostUsd}`);
    });

    // ── 6 · saldo del run insuficiente ─────────────────────────────────────────
    const A6 = await makeCourse('r65 sin saldo');
    const k6 = `content:${A6.c1}`;
    await check('6 · saldo del run < maxCostUsd → allowed=false (run_budget_insufficient, budgetScope run) y 409; nunca se amplía la autorización', async () => {
      const row = await exhaust(A6, k6);
      const spent = await runSpent(A6);
      await setAuthorized(A6, (spent + 0.05).toFixed(6));
      const d = await dtoItem(A6, k6);
      eq([d.ownerRetry.allowed, d.ownerRetry.reason, d.budgetScope], [false, 'run_budget_insufficient', 'run'], 'veredicto');
      await rejectsCode(ownerRetry(A6, k6), 'run_budget_insufficient', 'retry del dueño');
      eq((await itemOf(A6, k6)).status, 'failed', 'sigue failed');
      const [a] = await ds.query(`select authorized_budget::text b from public.cost_budget_authorizations where run_id = $1 order by created_at desc, id desc limit 1`, [A6.runId]);
      eq(Number(a.b).toFixed(4), (spent + 0.05).toFixed(4), 'la autorización no cambió');
      void row;
    });

    // ── 7 · budgetScope ─────────────────────────────────────────────────────────
    await check('7 · budgetScope: item_recovery_budget_exhausted → item; budget_exceeded / run_budget_not_authorized / pausa por tope → run; otro → null', async () => {
      eq(OR.budgetScopeOf({ status: 'failed', error: budgetMsg() }), 'item', 'tope de la parte');
      eq(OR.budgetScopeOf({ status: 'blocked', error: 'budget_exceeded: el run excede lo autorizado' }), 'run', 'budget_exceeded');
      eq(OR.budgetScopeOf({ status: 'failed', error: 'run_budget_not_authorized: sin autorización' }), 'run', 'run_budget_not_authorized');
      eq(OR.budgetScopeOf({ status: 'retrying', error: 'run_paused: Pausa automática: se alcanzó el presupuesto autorizado del run' }, 'run_budget_cap'), 'run', 'pausa por tope');
      eq(OR.budgetScopeOf({ status: 'retrying', error: 'run_paused: pausa del usuario' }, null), null, 'pausa del usuario');
      eq(OR.budgetScopeOf({ status: 'failed', error: 'validation_invalid: x' }), null, 'otro');
      const k2 = `content:${A6.c2}`;
      const it = await itemOf(A6, k2);
      await ds.query(`update public.generation_item_runs set status = 'blocked', error = 'budget_exceeded: prueba r65' where id = $1`, [it.id]);
      eq((await dtoItem(A6, k2)).budgetScope, 'run', 'DTO: bloqueado por presupuesto del run');
      eq((await dtoItem(A1, kA)).budgetScope, null, 'DTO: parte reabierta (sin motivo)');
    });

    // ── 8 · R4: ronda automática extra ─────────────────────────────────────────
    await check('8 · R4: una parte que agota su tope recibe UNA ronda automática (marca + presupuesto nuevo + run reabierto + log de intentos); una 2.ª falla queda hold_for_human sin 3.ª ronda; sin saldo del run no hay ronda', async () => {
      const prevFlag = process.env.DYNAMIC_LLM_WORKER_ENABLED;
      process.env.DYNAMIC_LLM_WORKER_ENABLED = 'true';
      try {
        await ds.query(`insert into public.llm_worker_presence (worker_id, item_types, last_seen, since) values ('r65-w1', $1, now(), '2000-01-01T00:00:00Z')
                        on conflict (worker_id) do update set last_seen = now()`, [['content', 'experience', 'application_activity', 'course_plan']]);
        LR.resetLlmWorkerPresenceCacheForTests && LR.resetLlmWorkerPresenceCacheForTests();
        const E = await makeCourse('r65 R4');
        const kE = `content:${E.c1}`;
        await exhaust(E, kE);
        await ds.query(`update public.production_jobs set status = 'failed', worker_status = 'failed', finished_at = now() where id = $1`, [E.runId]);
        const s1 = await runs.autoExtendItemRecoveryBudget({ now: new Date() });
        assert(s1.extended.some((x) => x.itemKey === kE), 'ronda extra: ' + JSON.stringify(s1));
        const it = await itemOf(E, kE);
        const mark = it.output_summary.autoBudgetExtension;
        assert(it.status === 'pending' && mark && mark.round === 1 && mark.at && /item_recovery_budget_exhausted/.test(mark.previousError), 'marca: ' + JSON.stringify(mark));
        assert(it.output_summary.recoveryBudgetResetAt, 'presupuesto de recuperación nuevo');
        eq(it.max_attempts - it.attempt_count, 1, 'UN intento');
        const [job] = await ds.query(`select worker_status from public.production_jobs where id = $1`, [E.runId]);
        eq(job.worker_status, 'queued', 'run reabierto');
        const [att] = await ds.query(`select actor, strategy_applied from public.generation_item_attempts where item_run_id = $1 and outcome = 'reopened' order by id desc limit 1`, [it.id]);
        eq([att.actor, att.strategy_applied], ['system', 'auto_budget_extension'], 'log de intentos');
        assert((await proxyCall(it.id)).ok, 'la ronda puede llamar');
        // 2.ª falla: sin tercera ronda.
        await failWith(it.id, budgetMsg());
        const s2 = await runs.autoExtendItemRecoveryBudget({ now: new Date() });
        assert(!s2.extended.some((x) => x.itemKey === kE), 'sin 3.ª ronda: ' + JSON.stringify(s2));
        const it2 = await itemOf(E, kE);
        eq(it2.status, 'failed', 'queda failed');
        const v = CL.classifyFailure({ error: it2.error, itemType: 'content', outputSummary: it2.output_summary });
        eq([v.class, v.strategy, v.targetRounds], ['D', 'hold_for_human', 0], 'clasificador sin cambios (D, rounds 0)');
        const d = await dtoItem(E, kE);
        eq(d.ownerRetry && d.ownerRetry.allowed, true, 'el dueño ve su reintento (R2)');
        // Sin saldo del run: no hay ronda.
        const N = await makeCourse('r65 R4 sin saldo');
        const kN = `content:${N.c1}`;
        await exhaust(N, kN);
        await setAuthorized(N, ((await runSpent(N)) + 0.05).toFixed(6));
        const s3 = await runs.autoExtendItemRecoveryBudget({ now: new Date() });
        assert(!s3.extended.some((x) => x.itemKey === kN) && s3.skipped.some((x) => x.itemKey === kN && x.reason === 'run_budget_insufficient'), 'sin saldo: ' + JSON.stringify(s3));
        const itN = await itemOf(N, kN);
        assert(itN.status === 'failed' && !itN.output_summary.autoBudgetExtension, 'sin marca ni reapertura');
        // Una parte del navegador (sin worker vivo que la cubra) tampoco: sería la misma solicitud.
        await ds.query(`delete from public.llm_worker_presence`);
        LR.resetLlmWorkerPresenceCacheForTests && LR.resetLlmWorkerPresenceCacheForTests();
        const Bw = await makeCourse('r65 R4 navegador');
        const kBw = `content:${Bw.c1}`;
        await exhaust(Bw, kBw);
        const s4 = await runs.autoExtendItemRecoveryBudget({ now: new Date() });
        assert(s4.skipped.some((x) => x.itemKey === kBw && x.reason === 'not_server_routed') && (await itemOf(Bw, kBw)).status === 'failed', 'navegador: ' + JSON.stringify(s4));
        // fix round 1: el peor caso REAL de la ronda extra (llamadas con max_tokens × 1,5, pendientes, hasta que el guard
        // niega) ≤ la marca maxCostUsd que se usó contra el saldo del run.
        await ds.query(`insert into public.llm_worker_presence (worker_id, item_types, last_seen, since) values ('r65-w1', $1, now(), '2000-01-01T00:00:00Z')
                        on conflict (worker_id) do update set last_seen = now()`, [['content']]);
        LR.resetLlmWorkerPresenceCacheForTests && LR.resetLlmWorkerPresenceCacheForTests();
        const W = await makeCourse('r65 R4 peor caso');
        const kW = `content:${W.c1}`;
        await exhaust(W, kW);
        const s5 = await runs.autoExtendItemRecoveryBudget({ now: new Date() });
        assert(s5.extended.some((x) => x.itemKey === kW), 'ronda extra: ' + JSON.stringify(s5));
        const markW = (await itemOf(W, kW)).output_summary.autoBudgetExtension;
        const bW = await burnUntilDenied(W, kW, { maxTokens: 12000 });
        assert(bW.spent <= Number(markW.maxCostUsd) + 1e-9, `R4: gastado USD ${bW.spent.toFixed(4)} ≤ maxCostUsd ${markW.maxCostUsd}`);
      } finally {
        if (prevFlag === undefined) delete process.env.DYNAMIC_LLM_WORKER_ENABLED; else process.env.DYNAMIC_LLM_WORKER_ENABLED = prevFlag;
      }
    });

    // ── 9 · concurrencia ───────────────────────────────────────────────────────
    await check('9 · dos retryItem CONCURRENTES del dueño consumen UN reintento y abren UNA ventana', async () => {
      const Q = await makeCourse('r65 concurrencia');
      const kQ = `content:${Q.c1}`;
      const row = await exhaust(Q, kQ);
      const res = await Promise.allSettled([ownerRetry(Q, kQ), ownerRetry(Q, kQ)]);
      eq(res.filter((x) => x.status === 'fulfilled').length, 1, 'uno solo pasa: ' + JSON.stringify(res.map((x) => x.status === 'rejected' ? x.reason.message : 'ok')));
      const it = await itemOf(Q, kQ);
      eq([(it.output_summary.ownerRetries || []).length, (it.output_summary.previousErrors || []).length], [1, 1], 'un reintento registrado, una reapertura');
      const [n] = await ds.query(`select count(*)::int n from public.generation_item_attempts where item_run_id = $1 and outcome = 'reopened'`, [row.id]);
      eq(n.n, 1, 'una sola ventana (un reopened en el log)');
    });

    // ── puro ────────────────────────────────────────────────────────────────────
    await check('puro · ownerRetryVerdict: orden de motivos, redondeo de maxCostUsd hacia arriba y retriesLeft', () => {
      const v = (error) => OR.itemFailureVerdict({ error, type: 'content', output_summary: {} });
      const base = { status: 'failed', verdict: v(budgetMsg()), openReservations: 0, paidType: false, paidExternalUnreconciled: false, maxCostUsd: 0.551, runRemainingUsd: 10, policyBlockedBy: null, ownerRetriesUsed24h: 0 };
      const ok = OR.ownerRetryVerdict(base);
      eq([ok.allowed, ok.maxCostUsd, ok.retriesLeft], [true, '0.56', 2], 'allowed');
      eq(OR.ownerRetryVerdict({ ...base, verdict: v('validation_invalid: falta campo') }).allowed, true, 'clase B');
      eq(OR.ownerRetryVerdict({ ...base, verdict: v('llm_output_cut_repeated: se cortó 2 veces') }).allowed, true, 'llm_output_cut_repeated');
      eq(OR.ownerRetryVerdict({ ...base, verdict: v('Falló algo raro') }).reason, 'failure_not_owner_retryable', 'D sin clasificar');
      eq(OR.ownerRetryVerdict({ ...base, verdict: v('provider_reconciliation_required: openai x') }).reason, 'ambiguous_paid_result', 'conciliación');
      eq(OR.ownerRetryVerdict({ ...base, maxCostUsd: null }).reason, 'no_item_estimate', 'sin estimado');
      eq(OR.ownerRetryVerdict({ ...base, runRemainingUsd: null }).reason, 'run_budget_insufficient', 'sin autorización');
      eq(OR.ownerRetryVerdict({ ...base, policyBlockedBy: 'ownerMonthlyCap' }).reason, 'policy_cap_reached', 'tope mensual');
      eq(OR.ownerRetryVerdict({ ...base, ownerRetriesUsed24h: 1 }).retriesLeft, 1, 'queda 1');
      eq(OR.ownerRetryVerdict({ ...base, ownerRetriesUsed24h: 2, verdict: v('Falló algo raro') }).reason, 'owner_retry_limit', 'el límite antes que la lista');
      eq(OR.ownerRetryVerdict({ ...base, paidType: true, paidExternalUnreconciled: true, verdict: v('gamma_submit_ambiguous: x') }).reason, 'ambiguous_paid_result', 'ambigüedad antes que el trabajo externo');
      eq(OR.ownerRetryVerdict({ ...base, paidType: true, paidExternalUnreconciled: true, verdict: v('video_timeout: x') }).reason, 'paid_external_unreconciled', 're-poll');
      eq(OR.OWNER_RETRY_ENFORCED_REASONS.has('no_item_estimate'), false, 'no_item_estimate no da 409');
      eq(OR.ownerRetryVerdict({ ...base, status: 'pending' }).reason, 'not_failed', 'no failed');
      const now = new Date();
      eq(OR.ownerRetriesUsed({ ownerRetries: [{ at: new Date(now - 25 * 3600e3).toISOString() }, { at: new Date(now - 3600e3).toISOString() }] }, now), 1, 'solo las de 24 h');
    });
  } finally {
    try { if (ds) await ds.destroy(); } catch {}
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    restoreProviders();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
}

(async () => {
  await dbChecks();
  console.log(`\n${passes} OK, ${failures} fallidos`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(`❌ fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
