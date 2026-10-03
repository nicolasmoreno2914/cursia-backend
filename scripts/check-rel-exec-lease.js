#!/usr/bin/env node
/* eslint-disable */
// REL — lease de EJECUCIÓN del navegador por run (servidor = autoridad). Acceso al curso ≠ lease.
//
// Parte pura (siempre; --pure-only para CI):
//   - executionLeaseView: held / heldByYou / expiresAt; run no activo o vencido → libre; sin columnas → null;
//   - verifyRelExecLeaseSchema: un esquema vacío reporta columnas, constraints y trigger.
// Parte DB (default; PG16 desechable, puerto libre ≠ 5570 / 8099; proveedores solo como variables de
// entorno falsas, nunca se llaman):
//   - migración idempotente + verificación de esquema;
//   - dos ejecutores del navegador sobre el mismo run → el segundo recibe `run_leased_elsewhere`, nunca un
//     item; dos claims simultáneos → exactamente uno gana;
//   - el titular renueva con claim (aunque no haya nada) / heartbeat / fail;
//   - tras vencer, el segundo toma el lease y el primero recibe `run_leased_elsewhere` en su próximo claim
//     (su item en vuelo sigue con las reglas del lease por item: su heartbeat sigue ok y no recupera el lease);
//   - los workers del servidor (sin ownerId) no pasan por el lease;
//   - fin del run (fallido / cancelado) suelta el lease (trigger); liberación explícita solo del titular;
//   - GET del run / run actual funciona para los dos ejecutores en todo momento (executionLease solo informa);
//   - kill-switch legacy (DYNAMIC_AUTO_HEAL_POLICY=legacy): autoRecovery=false y el lease sigue protegiendo;
//   - sin la migración (rollback documentado) → no-op: el claim se comporta como antes y executionLease = null.
//
// Usage: npm run build && node scripts/check-rel-exec-lease.js [--pure-only] [path/to/dist]

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
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
const { verifyRelExecLeaseSchema } = require('./verify-rel-exec-lease-schema');
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

// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  const NOW = new Date('2026-10-02T12:00:00Z');
  const later = new Date(NOW.getTime() + 60000).toISOString();
  const before = new Date(NOW.getTime() - 1000).toISOString();
  await check('puro: executionLeaseView — vigente (de quien consulta / de otro), vencido, run no activo, sin columnas', () => {
    const job = { executor_lease_holder: 'dev-A', executor_lease_expires_at: later };
    eq(EL.executionLeaseView(job, 'dev-A', true, NOW), { held: true, heldByYou: true, expiresAt: later }, 'propio');
    eq(EL.executionLeaseView(job, 'dev-B', true, NOW), { held: true, heldByYou: false, expiresAt: later }, 'de otro');
    eq(EL.executionLeaseView(job, null, true, NOW), { held: true, heldByYou: false, expiresAt: later }, 'sin executorId');
    eq(EL.executionLeaseView({ ...job, executor_lease_expires_at: before }, 'dev-B', true, NOW), { held: false, heldByYou: false, expiresAt: null }, 'vencido');
    eq(EL.executionLeaseView(job, 'dev-A', false, NOW), { held: false, heldByYou: false, expiresAt: null }, 'run no activo');
    eq(EL.executionLeaseView({ executor_lease_holder: null, executor_lease_expires_at: null }, 'dev-A', true, NOW).held, false, 'libre');
    eq(EL.executionLeaseView({ id: 'x' }, 'dev-A', true, NOW), null, 'sin migración → null');
    eq([EL.normalizeRequestingExecutorId(' a '), EL.normalizeRequestingExecutorId(''), EL.normalizeRequestingExecutorId('x'.repeat(201)), EL.normalizeRequestingExecutorId(3)],
      ['a', null, null, null], 'executorId de consulta');
  });
  await check('puro: verifyRelExecLeaseSchema — esquema vacío → columnas, constraints y trigger faltantes; esquema completo → ok', () => {
    const p = verifyRelExecLeaseSchema({ cols: [], cons: [], trg: [] });
    assert(p.some((x) => /executor_lease_holder no existe/.test(x)) && p.some((x) => /executor_lease_expires_at no existe/.test(x)), 'columnas');
    assert(p.some((x) => /pj_exec_lease_pair/.test(x)) && p.some((x) => /trg_pj_release_exec_lease/.test(x)), 'constraint / trigger');
    const ok = verifyRelExecLeaseSchema({
      cols: [{ column_name: 'executor_lease_holder', data_type: 'text', is_nullable: 'YES' }, { column_name: 'executor_lease_expires_at', data_type: 'timestamp with time zone', is_nullable: 'YES' }],
      cons: [{ conname: 'pj_exec_lease_holder_len', convalidated: true }, { conname: 'pj_exec_lease_pair', convalidated: true }],
      trg: [{ tgname: 'trg_pj_release_exec_lease', tgenabled: 'O', def: 'CREATE TRIGGER trg_pj_release_exec_lease BEFORE UPDATE ON public.production_jobs ...' }],
    });
    eq(ok, [], 'completo');
  });
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
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-execlease-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-execlease-cwd-'));
  const ROLE = 'postgres.execleaselocal01';
  const DB = 'execleasedb';
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

    await check('DB migración: verify sin migrar → falla; migrate-rel-exec-lease dos veces (idempotente) → verify ok; sin MIGRATION_ENV=staging → se niega', async () => {
      let res = runScript('scripts/verify-rel-exec-lease-schema.js', localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code !== 0 && /executor_lease_holder no existe/.test(res.out), 'verify antes: ' + res.out.slice(-500));
      res = runScript('scripts/migrate-rel-exec-lease.js', localEnv({}));
      assert(res.code !== 0 && /MIGRATION_ENV/.test(res.out), 'guardarraíl staging');
      for (let i = 0; i < 2; i++) {
        res = runScript('scripts/migrate-rel-exec-lease.js', localEnv({ MIGRATION_ENV: 'staging' }));
        assert(res.code === 0, `migrate #${i + 1}: ${res.out.slice(-800)}`);
      }
      res = runScript('scripts/verify-rel-exec-lease-schema.js', localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, 'verify: ' + res.out.slice(-800));
    });

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
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

    const C = await makeCourse('REL lease dos equipos');
    let aItem = null;

    await check('DB: antes de cualquier claim → lease libre; el GET del run / run actual funciona para los dos equipos', async () => {
      const L = await readsFor(C);
      eq([L[A].held, L[B].held, L.anon.held], [false, false, false], 'libre');
    });

    await check('DB: A reclama → item + lease del run (titular A, ~120 s); B reclama → `run_leased_elsewhere` con el vencimiento, NUNCA un item (5 intentos)', async () => {
      const ra = await claim(C.runId, A);
      assert(ra.item && C.keys.includes(ra.item.itemKey), 'A recibe un item: ' + JSON.stringify(ra).slice(0, 300));
      aItem = ra.item;
      const row = await runRow(C.runId);
      eq(row.executor_lease_holder, A, 'titular');
      assert(secsLeft(row) > 100 && secsLeft(row) <= 121, 'TTL ~120 s: ' + secsLeft(row));
      for (let i = 0; i < 5; i++) {
        const rb = await claim(C.runId, B);
        eq([rb.item, rb.reason], [null, 'run_leased_elsewhere'], `B intento ${i + 1}`);
        eq(new Date(rb.leaseExpiresAt).getTime(), new Date(row.executor_lease_expires_at).getTime(), 'vencimiento informado');
      }
      const running = await ds.query(`select item_key, worker_id from public.generation_item_runs where job_id = $1 and status = 'running'`, [C.runId]);
      eq(running.map((x) => x.worker_id), [A], 'solo A tiene partes en curso');
      eq((await runRow(C.runId)).executor_lease_holder, A, 'el rechazo no toca el lease');
    });

    await check('DB: GET del run con los dos executorId mientras A tiene el lease → A heldByYou, B held (no suyo); ninguno bloqueado', async () => {
      const L = await readsFor(C);
      eq([L[A].held, L[A].heldByYou, L[B].held, L[B].heldByYou, L.anon.held, L.anon.heldByYou], [true, true, true, false, true, false], 'vista');
      assert(L[B].expiresAt && Date.parse(L[B].expiresAt) > Date.now(), 'expiresAt');
    });

    await check('DB: el titular renueva — claim (aunque reclame otra parte), heartbeat y fail lo llevan de nuevo a ~120 s', async () => {
      const shrink = () => ds.query(`update public.production_jobs set executor_lease_expires_at = now() + interval '5 seconds' where id = $1`, [C.runId]);
      await shrink();
      const hb = await sched.heartbeatItemDetailed(aItem.itemRunId, A, 120, OWNER);
      eq(hb.ok, true, 'heartbeat ok');
      assert(secsLeft(await runRow(C.runId)) > 100, 'heartbeat renueva');
      await shrink();
      const fr = await sched.failItemDetailed(aItem.itemRunId, A, 'fetch failed', true, OWNER);
      eq(fr.ok, true, 'fail ok');
      assert(secsLeft(await runRow(C.runId)) > 100, 'fail renueva');
      await shrink();
      const ra = await claim(C.runId, A);
      assert(ra.item, 'A reclama otra parte');
      aItem = ra.item;
      assert(secsLeft(await runRow(C.runId)) > 100, 'claim renueva');
      eq((await runRow(C.runId)).executor_lease_holder, A, 'sigue A');
    });

    await check('DB: dos claims SIMULTÁNEOS sobre un lease libre (A y B) → exactamente uno recibe item y lease; el otro `run_leased_elsewhere`', async () => {
      const D = await makeCourse('REL lease carrera');
      const [ra, rb] = await Promise.all([claim(D.runId, A), claim(D.runId, B)]);
      const winners = [ra, rb].filter((x) => x.item);
      const losers = [ra, rb].filter((x) => x.reason === 'run_leased_elsewhere');
      eq([winners.length, losers.length], [1, 1], 'uno y uno');
      const holder = (await runRow(D.runId)).executor_lease_holder;
      eq(holder, ra.item ? A : B, 'titular = ganador');
      const workers = await ds.query(`select distinct worker_id from public.generation_item_runs where job_id = $1 and status = 'running'`, [D.runId]);
      eq(workers.map((x) => x.worker_id), [holder], 'un solo ejecutor con partes');
    });

    await check('DB: A deja de latir y el lease vence → B lo toma y reclama; el próximo claim de A → `run_leased_elsewhere`; el item en vuelo de A sigue con su lease por item (heartbeat ok) sin recuperar el lease del run', async () => {
      await expire(C.runId);
      const L0 = await readsFor(C);
      eq([L0[A].held, L0[B].held], [false, false], 'vencido = libre en la vista');
      const rb = await claim(C.runId, B);
      assert(rb.item && rb.item.itemRunId !== aItem.itemRunId, 'B recibe OTRA parte (la de A sigue con su lease por item)');
      eq((await runRow(C.runId)).executor_lease_holder, B, 'titular B');
      const ra = await claim(C.runId, A);
      eq([ra.item, ra.reason], [null, 'run_leased_elsewhere'], 'A rechazado');
      const hb = await sched.heartbeatItemDetailed(aItem.itemRunId, A, 120, OWNER);
      eq(hb.ok, true, 'el item en vuelo de A sigue vivo (reglas del lease por item, sin cambios)');
      eq((await runRow(C.runId)).executor_lease_holder, B, 'el latido de A no recupera el lease');
      const fa = await sched.failItemDetailed(aItem.itemRunId, A, 'fetch failed', true, OWNER);
      eq(fa.ok, true, 'A puede cerrar su item');
      eq((await runRow(C.runId)).executor_lease_holder, B, 'ni su fail');
      const L = await readsFor(C);
      eq([L[A].heldByYou, L[B].heldByYou, L[A].held], [false, true, true], 'vista tras el traspaso');
    });

    await check('DB: los workers del servidor (sin ownerId) no pasan por el lease: con un titular del navegador vigente, un worker reclama su parte y el lease no cambia', async () => {
      const W = await makeCourse('REL lease worker');
      assert((await claim(W.runId, B)).item, 'B titular');
      const pres = `presentation:${W.c1}`;
      // Todo completado salvo la presentación (pendiente, dependencias completas).
      await ds.query(`update public.generation_item_runs set status = 'completed', worker_id = null, lease_until = null, finished_at = now() where job_id = $1 and item_key <> $2`, [W.runId, pres]);
      await ds.query(`update public.generation_item_runs set status = 'pending', finished_at = null where job_id = $1 and item_key = $2`, [W.runId, pres]);
      const before = await runRow(W.runId);
      eq(before.executor_lease_holder, B, 'lease de B vigente');
      const r = await sched.claimNextItemDetailed({ runId: W.runId, executorId: 'provider-worker-1', types: ['presentation'], leaseSeconds: 300 });
      assert(r.reason === undefined, 'sin motivo de lease: ' + JSON.stringify(r).slice(0, 200));
      const [after] = await ds.query(`select status, worker_id, error from public.generation_item_runs where job_id = $1 and item_key = $2`, [W.runId, pres]);
      // El worker lo tomó (running) o lo cerró en el claim por un dato ausente del fixture: nunca quedó intacto por el lease.
      assert(after.status !== 'pending', 'el worker llegó al item: ' + JSON.stringify(after));
      if (after.status === 'running') eq(after.worker_id, 'provider-worker-1', 'worker titular del item');
      const now = await runRow(W.runId);
      eq([now.executor_lease_holder, String(now.executor_lease_expires_at)], [before.executor_lease_holder, String(before.executor_lease_expires_at)], 'lease intacto');
      const g = await sched.claimNextItemDetailed({ executorId: 'provider-worker-2', types: ['presentation'], leaseSeconds: 300 });
      assert(g.reason === undefined, 'global sin motivo');
    });

    await check('DB: liberación explícita — solo el titular (B); A no puede soltar el lease de B; tras soltarlo A lo toma', async () => {
      eq(await sched.releaseRunExecutionLease(C.runId, A, OWNER), { ok: true, released: false }, 'A no es titular');
      eq((await runRow(C.runId)).executor_lease_holder, B, 'sigue B');
      eq(await sched.releaseRunExecutionLease(C.runId, B, '99999999-2222-4333-8444-555555555555'), { ok: true, released: false }, 'otro dueño no');
      eq(await sched.releaseRunExecutionLease(C.runId, B, OWNER), { ok: true, released: true }, 'B suelta');
      const row = await runRow(C.runId);
      eq([row.executor_lease_holder, row.executor_lease_expires_at], [null, null], 'libre');
      const ra = await claim(C.runId, A);
      assert(ra.item || ra.reason === undefined, 'A puede reclamar');
      eq((await runRow(C.runId)).executor_lease_holder, A, 'titular A');
    });

    await check('DB: fin del run suelta el lease — el último fail no reintentable deja el run `failed` y el lease null (trigger), el GET sigue para los dos', async () => {
      const E = await makeCourse('REL lease fin');
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and item_key = any($2::text[])`, [E.runId, E.keys.slice(1)]);
      const ra = await claim(E.runId, A);
      assert(ra.item && ra.item.itemKey === E.keys[0], 'A reclama la última parte');
      eq((await runRow(E.runId)).executor_lease_holder, A, 'lease');
      const fr = await sched.failItemDetailed(ra.item.itemRunId, A, 'config rota', false, OWNER);
      eq(fr.ok, true, 'fail');
      const row = await runRow(E.runId);
      eq([row.worker_status, row.executor_lease_holder, row.executor_lease_expires_at], ['failed', null, null], 'run terminado sin lease');
      const L = await readsFor(E);
      eq([L[A].held, L[B].held], [false, false], 'vista libre');
      // Reabierto (reintento del dueño) → B puede tomarlo al instante (no hereda el lease viejo de A).
      await runs.retryItem(E.cid, OWNER, 1, E.runId, E.keys[0], false, false, undefined, { id: OWNER, email: 'owner@cursia.test' });
      const rb = await claim(E.runId, B);
      assert(rb.item, 'B reclama tras la reapertura: ' + JSON.stringify(rb).slice(0, 200));
      eq((await runRow(E.runId)).executor_lease_holder, B, 'titular B');
    });

    await check('DB: cancelar el run suelta el lease; después nadie lo toma (claim sobre run cancelado → nada, sin lease)', async () => {
      const G = await makeCourse('REL lease cancelado');
      assert((await claim(G.runId, A)).item, 'A reclama');
      await runs.cancelRun(G.cid, OWNER, 1, G.runId, { id: OWNER, email: 'owner@cursia.test' });
      let row = await runRow(G.runId);
      eq([row.worker_status, row.executor_lease_holder], ['cancelled', null], 'cancelado sin lease');
      const rb = await claim(G.runId, B);
      eq([rb.item, rb.reason], [null, undefined], 'nada que reclamar, sin motivo de lease');
      row = await runRow(G.runId);
      eq(row.executor_lease_holder, null, 'sigue sin lease');
      // Cualquier camino de escritura (p.ej. PATCH legacy del job) también lo suelta.
      const H = await makeCourse('REL lease legacy');
      assert((await claim(H.runId, A)).item, 'A reclama');
      await ds.query(`update public.production_jobs set status = 'cancelling' where id = $1`, [H.runId]);
      eq((await runRow(H.runId)).executor_lease_holder, null, 'cancelling por SQL directo → suelto');
    });

    await check('DB kill-switch legacy (DYNAMIC_AUTO_HEAL_POLICY=legacy): autoRecovery=false en el RunDto y el lease sigue protegiendo el run', async () => {
      process.env.DYNAMIC_AUTO_HEAL_POLICY = 'legacy';
      try {
        const K = await makeCourse('REL lease legacy kill-switch');
        assert((await claim(K.runId, A)).item, 'A reclama');
        eq((await claim(K.runId, B)).reason, 'run_leased_elsewhere', 'B rechazado igual');
        const dto = await runs.getRun(K.cid, OWNER, 1, K.runId, { executorId: B });
        eq([dto.autoRecovery, dto.executionLease.held, dto.executionLease.heldByYou], [false, true, false], 'dto');
      } finally {
        delete process.env.DYNAMIC_AUTO_HEAL_POLICY;
      }
    });

    await check('DB fix m3: columnas borradas con la sonda en caché positiva (rollback sin pm2 reload) → nunca 500: claim y fail siguen por el camino previo, la sonda se invalida', async () => {
      const dropCols = () => ds.query(`drop trigger if exists trg_pj_release_exec_lease on public.production_jobs;
                      drop function if exists public.pj_release_exec_lease();
                      alter table public.production_jobs drop column if exists executor_lease_holder, drop column if exists executor_lease_expires_at`);
      const remigrate = () => {
        const res = runScript('scripts/migrate-rel-exec-lease.js', localEnv({ MIGRATION_ENV: 'staging' }));
        assert(res.code === 0, 're-migrar: ' + res.out.slice(-500));
        EL.resetExecLeaseSchemaCache();
      };
      const M = await makeCourse('REL lease rollback en caliente');
      try {
        // 1) acquire dentro del claim (transacción): sonda positiva, columnas ausentes.
        assert((await claim(M.runId, A)).item, 'claim con columnas (sonda positiva)');
        assert(await EL.execLeaseSchemaReady(ds), 'sonda positiva en caché');
        await dropCols();
        const rb = await claim(M.runId, B);
        assert(rb.item && rb.reason === undefined, 'B reclama por el camino previo (sin 500): ' + JSON.stringify(rb).slice(0, 200));
        eq(await EL.execLeaseSchemaReady(ds), false, 'sonda invalidada');
        // 2) refresh dentro de complete/fail (transacción con SAVEPOINT): sonda positiva otra vez, columnas ausentes.
        remigrate();
        const ra = await claim(M.runId, A);
        assert(ra.item, 'A reclama');
        assert(await EL.execLeaseSchemaReady(ds), 'sonda positiva');
        await dropCols();
        const fr = await sched.failItemDetailed(ra.item.itemRunId, A, 'fetch failed', true, OWNER);
        eq(fr.ok, true, 'fail ok (la transacción no se abortó)');
        eq((await ds.query(`select status from public.generation_item_runs where id = $1`, [ra.item.itemRunId]))[0].status, 'retrying', 'transición aplicada');
        eq(await EL.execLeaseSchemaReady(ds), false, 'sonda invalidada');
        // 3) heartbeat (fuera de transacción) y release: sin 500.
        remigrate();
        const M2 = await makeCourse('REL lease rollback en caliente 2');
        const rc = await claim(M2.runId, A);
        assert(rc.item, 'A reclama (curso nuevo)');
        await dropCols();
        eq((await sched.heartbeatItemDetailed(rc.item.itemRunId, A, 120, OWNER)).ok, true, 'heartbeat ok');
        eq(await sched.releaseRunExecutionLease(M2.runId, A, OWNER), { ok: true, released: false }, 'release sin 500');
      } finally {
        remigrate();
      }
    });

    await check('DB sin la migración (rollback documentado) → no-op: dos ejecutores reclaman como antes y executionLease = null', async () => {
      const R = await makeCourse('REL lease rollback');
      await ds.query(`drop trigger if exists trg_pj_release_exec_lease on public.production_jobs;
                      drop function if exists public.pj_release_exec_lease();
                      alter table public.production_jobs drop column if exists executor_lease_holder, drop column if exists executor_lease_expires_at`);
      EL.resetExecLeaseSchemaCache();
      try {
        const ra = await claim(R.runId, A);
        const rb = await claim(R.runId, B);
        assert(ra.item && rb.item && ra.item.itemRunId !== rb.item.itemRunId, 'ambos reclaman partes distintas (comportamiento previo)');
        eq([ra.reason, rb.reason], [undefined, undefined], 'sin motivo');
        eq((await sched.heartbeatItemDetailed(ra.item.itemRunId, A, 120, OWNER)).ok, true, 'heartbeat ok');
        eq(await sched.releaseRunExecutionLease(R.runId, A, OWNER), { ok: true, released: false }, 'release no-op');
        const dto = await runs.getRun(R.cid, OWNER, 1, R.runId, { executorId: A });
        eq(dto.executionLease, null, 'executionLease null');
      } finally {
        const res = runScript('scripts/migrate-rel-exec-lease.js', localEnv({ MIGRATION_ENV: 'staging' }));
        assert(res.code === 0, 're-migrar: ' + res.out.slice(-500));
        EL.resetExecLeaseSchemaCache();
      }
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
  await pureChecks();
  if (!PURE_ONLY) await dbChecks();
  console.log(`\n${passes} OK, ${failures} fallidos`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(`❌ fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
