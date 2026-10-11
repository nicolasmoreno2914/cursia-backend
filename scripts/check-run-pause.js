#!/usr/bin/env node
/* eslint-disable */
// Pausa REAL de un run dinámico (2026-10-11, piloto #1209): el auto-resume del navegador relanzó un run que el usuario
// había detenido y siguió gastando. La pausa ahora vive en el SERVIDOR (worker_status = 'paused').
//
// Parte pura: listas abierto / despachable (paused abierto, nunca despachable); isPausedRun / isDispatchableRun.
// Parte DB (PG16 desechable; proveedores solo como variables falsas, nunca se llaman):
//   - migración run-pause idempotente (índice único de run activo con 'paused'); sin MIGRATION_ENV=staging se niega;
//   - pausar → ningún claim entrega partes (navegador A, otro navegador B, worker global sin owner): `run_paused`;
//   - lo que estaba en vuelo termina (heartbeat / complete) y el run SIGUE pausado (recomputeRunStatus no lo cambia);
//   - lease vencido barrido → la parte vuelve a la cola y el run sigue pausado;
//   - auto-healer (autoHealFailedItems) y retryItem(auto) NO tocan un run pausado; un reintento MANUAL reabre la parte
//     pero el run sigue pausado;
//   - un segundo run del mismo Manifest no puede arrancar mientras está pausado (índice + conflicto);
//   - GET: paused=true y sin lease de ejecución; pausar es idempotente; pausar terminado / reanudar no pausado → 409;
//   - SOLO resumeRun lo vuelve a despachar; cancelar desde pausado funciona.
//
// Usage: npm run build && node scripts/check-run-pause.js [--pure-only] [path/to/dist]

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
  const IT = loadDist('modules/dynamic-generation/item-transitions.js');
  await check('puro: paused es ABIERTO (índice, conflicto, drenaje) pero NUNCA despachable (claim)', () => {
    assert(IT.ACTIVE_RUN_WORKER_STATUSES.includes('paused'), 'abierto incluye paused');
    eq(IT.DISPATCHABLE_RUN_WORKER_STATUSES, ['queued', 'running', 'retrying'], 'despachable');
    eq([IT.isActiveRun({ worker_status: 'paused' }), IT.isDispatchableRun({ worker_status: 'paused' }), IT.isPausedRun({ worker_status: 'paused' })], [true, false, true], 'paused');
    eq([IT.isDispatchableRun({ worker_status: 'running' }), IT.isPausedRun({ worker_status: 'running' })], [true, false], 'running');
    eq(IT.isPausedRun({ worker_status: 'paused', status: 'cancelled' }), false, 'cancelado no es pausa');
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-runpause-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-runpause-cwd-'));
  const ROLE = 'postgres.runpauselocal01';
  const DB = 'runpausedb';
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
    const indexDef = async () => (await withClient(DB, (c) => c.query(`select indexdef from pg_indexes where indexname = 'uq_dynamic_generation_active_run'`))).rows[0].indexdef;

    await check('DB migración run-pause: sin MIGRATION_ENV=staging se niega; dos veces (idempotente) → el índice único de run activo incluye paused', async () => {
      assert(!/'paused'/.test(await indexDef()), 'antes: sin paused');
      let res = runScript('scripts/migrate-run-pause.js', localEnv({}));
      assert(res.code !== 0 && /MIGRATION_ENV/.test(res.out), 'guardarraíl staging: ' + res.out.slice(-300));
      for (let i = 0; i < 2; i++) {
        res = runScript('scripts/migrate-run-pause.js', localEnv({ MIGRATION_ENV: 'staging' }));
        assert(res.code === 0, `migrate #${i + 1}: ${res.out.slice(-800)}`);
      }
      const def = await indexDef();
      assert(/'queued'/.test(def) && /'running'/.test(def) && /'retrying'/.test(def) && /'paused'/.test(def) && /UNIQUE/i.test(def), def);
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

    const AH = loadDist('modules/dynamic-generation/auto-heal.js');
    const IT = loadDist('modules/dynamic-generation/item-transitions.js');
    const C = await makeCourse('Pausa real');
    const status = async () => { const r = await runRow(C.runId); return [r.status, r.worker_status]; };
    const itemOf = async (key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [C.runId, key]))[0];
    const pause = () => runs.pauseRun(C.cid, OWNER, 1, C.runId);
    const resume = () => runs.resumeRun(C.cid, OWNER, 1, C.runId);
    let inflight = null;

    await check('DB: A reclama una parte (queda EN VUELO); el usuario pausa → run paused, sin lease de ejecución, GET paused=true', async () => {
      const ra = await claim(C.runId, A);
      assert(ra.item, 'A recibe una parte');
      inflight = ra.item;
      const dto = await pause();
      eq([dto.paused, dto.workerStatus, dto.status], [true, 'paused', 'paused'], 'dto');
      eq(await status(), ['paused', 'paused'], 'fila');
      const row = await runRow(C.runId);
      eq([row.executor_lease_holder, row.executor_lease_expires_at], [null, null], 'el trigger soltó el lease');
      const g = await runs.getRun(C.cid, OWNER, 1, C.runId, { executorId: A });
      eq([g.paused, g.executionLease && g.executionLease.held], [true, false], 'GET');
      eq(row.output_summary.pause.previousWorkerStatus, 'running', 'se registra de dónde venía');
    });

    await check('DB: pausado → NINGÚN claim entrega partes: A, otro navegador B (5 veces) → run_paused; worker global sin owner → nada de este run', async () => {
      eq(await claim(C.runId, A), { item: null, reason: 'run_paused' }, 'A');
      for (let i = 0; i < 5; i++) eq(await claim(C.runId, B), { item: null, reason: 'run_paused' }, `B ${i + 1}`);
      const g = await sched.claimNextItemDetailed({ executorId: 'worker-srv', types: TYPES, leaseSeconds: 60 });
      assert(!g.item || g.item.runId !== C.runId, 'worker global: ' + JSON.stringify(g).slice(0, 200));
      const running = await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and status = 'running'`, [C.runId]);
      eq(running.map((x) => x.item_key), [inflight.itemKey], 'solo la parte que ya estaba en vuelo');
    });

    await check('DB: lo que estaba en vuelo puede terminar (heartbeat + fail del titular) y el run SIGUE pausado', async () => {
      eq((await sched.heartbeatItemDetailed(inflight.itemRunId, A, 120, OWNER)).ok, true, 'heartbeat');
      const r = await sched.failItemDetailed(inflight.itemRunId, A, 'respuesta cortada (prueba)', true, OWNER);
      eq(r.ok, true, 'fail: ' + JSON.stringify(r));
      assert(['retrying', 'failed'].includes((await itemOf(inflight.itemKey)).status), 'la parte salió de running');
      eq(await status(), ['paused', 'paused'], 'sigue pausado (recomputeRunStatus no lo cambia)');
    });

    await check('DB: el run pausado con TODAS sus partes completas se cierra (lo que estaba en vuelo terminó) — nunca queda colgado', async () => {
      const E = await makeCourse('Pausa que termina sola');
      const ra = await claim(E.runId, A);
      await runs.pauseRun(E.cid, OWNER, 1, E.runId);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and id <> $2`, [E.runId, ra.item.itemRunId]);
      const qr = ds.createQueryRunner(); await qr.connect();
      try { await qr.startTransaction(); await IT.recomputeRunStatus(qr, E.runId); await qr.commitTransaction(); } finally { await qr.release(); }
      eq((await runRow(E.runId)).worker_status, 'paused', 'con una parte en vuelo sigue pausado');
    });

    await check('DB: una parte con lease vencido en un run pausado vuelve a la cola, pero NADIE la reclama y el run sigue pausado', async () => {
      const k = C.keys.find((x) => x !== inflight.itemKey);
      const it = await itemOf(k);
      await ds.query(`update public.generation_item_runs set status = 'running', worker_id = 'exec-old', lease_until = now() - interval '1 second', attempt_count = 1 where id = $1`, [it.id]);
      await sched.sweepExpiredLeases(C.runId);
      assert(['retrying', 'pending'].includes((await itemOf(k)).status), 'vuelve a la cola');
      eq(await status(), ['paused', 'paused'], 'sigue pausado');
      eq(await claim(C.runId, A), { item: null, reason: 'run_paused' }, 'nadie la reclama');
    });

    await check('DB: auto-recovery NO reabre un run pausado — autoHealFailedItems no toca su parte fallida; retryItem(auto) → 409 run_paused', async () => {
      const k = C.keys[C.keys.length - 1];
      const it = await itemOf(k);
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'Error del servidor (524). Reintentando…', attempt_count = max_attempts, finished_at = now() - interval '2 hours' where id = $1`, [it.id]);
      const res = await runs.autoHealFailedItems({ now: new Date(Date.now() + 6 * 3600 * 1000), policy: AH.LEGACY_AUTO_HEAL_POLICY });
      assert(!(res.reopened || []).some((r) => r.runId === C.runId), 'no reabrió nada de este run: ' + JSON.stringify(res).slice(0, 300));
      eq((await itemOf(k)).status, 'failed', 'sigue failed');
      let err = null;
      try { await runs.retryItem(C.cid, OWNER, 1, C.runId, k, false, false, { policy: AH.LEGACY_AUTO_HEAL_POLICY, now: new Date() }); } catch (e) { err = e; }
      const body = err && err.getResponse ? err.getResponse() : null;
      assert(err && err.getStatus && err.getStatus() === 409 && body && body.code === 'run_paused', 'retryItem(auto): ' + (err && err.message));
      eq(await status(), ['paused', 'paused'], 'sigue pausado');
    });

    await check('DB: un reintento MANUAL del usuario reabre la parte, pero el run sigue pausado (no se despacha)', async () => {
      const k = C.keys[C.keys.length - 1];
      await runs.retryItem(C.cid, OWNER, 1, C.runId, k);
      eq((await itemOf(k)).status, 'pending', 'parte reabierta');
      eq(await status(), ['paused', 'paused'], 'run pausado');
      eq(await claim(C.runId, A), { item: null, reason: 'run_paused' }, 'nadie la reclama');
    });

    await check('DB: pausado sigue ABIERTO — un segundo run del mismo Manifest no puede arrancar (conflicto), y el índice lo impediría igual', async () => {
      let err = null;
      try { await runs.startRun(C.cid, OWNER, 1, { ...CONTEXT, nombre: 'Otro contexto', videoMode: 'real' }); } catch (e) { err = e; }
      assert(err && err.getStatus && err.getStatus() === 409, 'startRun con otro contexto: ' + (err && err.message));
      const same = await runs.startRun(C.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' }).catch((e) => e);
      assert(!(same instanceof Error) ? same.run.id === C.runId : same.getStatus() === 409, 'mismo contexto devuelve el MISMO run o 409');
      const row = await runRow(C.runId);
      let dup = null;
      try {
        await ds.query(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, input_payload) values ($1, $2, 'dynamic_generation', 'queued', 'queued', $3::jsonb)`,
          [OWNER, C.cid, JSON.stringify({ manifestId: row.input_payload.manifestId })]);
      } catch (e) { dup = e; }
      assert(dup && dup.code === '23505', 'índice único: ' + (dup && dup.message));
    });

    await check('DB: pausar es idempotente; reanudar algo no pausado o pausar algo terminado → 409', async () => {
      eq((await pause()).workerStatus, 'paused', 'pausar de nuevo');
      const D = await makeCourse('Pausa sobre terminado');
      let e1 = null;
      try { await runs.resumeRun(D.cid, OWNER, 1, D.runId); } catch (e) { e1 = e; }
      assert(e1 && e1.getStatus() === 409 && e1.getResponse().code === 'run_not_paused', 'reanudar no pausado');
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed' where id = $1`, [D.runId]);
      let e2 = null;
      try { await runs.pauseRun(D.cid, OWNER, 1, D.runId); } catch (e) { e2 = e; }
      assert(e2 && e2.getStatus() === 409 && e2.getResponse().code === 'run_not_active', 'pausar terminado');
    });

    await check('DB: SOLO resumeRun lo vuelve a despachar → queued, la parte pendiente se reclama; registro de quién/cuándo', async () => {
      const dto = await resume();
      assert(dto.paused === false && IT.DISPATCHABLE_RUN_WORKER_STATUSES.includes(dto.workerStatus), 'reanudado y despachable: ' + dto.workerStatus);
      const r = await claim(C.runId, A);
      assert(r.item && C.keys.includes(r.item.itemKey), 'vuelve a entregar partes: ' + JSON.stringify(r).slice(0, 200));
      const row = await runRow(C.runId);
      assert(row.output_summary.pause.resumedAt && row.output_summary.pause.resumedBy === OWNER, 'registro');
    });

    await check('DB (review I1): con el run PAUSADO, el guard del servidor niega todo envío pagado NUEVO (run_paused) aunque un worker ya tuviera la parte; al reanudar, vuelve a la política de presupuesto normal', async () => {
      const [vid] = await ds.query(`select id from public.generation_item_runs where job_id = $1 and type = 'video' limit 1`, [C.runId]);
      assert(vid, 'hay un item de video');
      await pause();
      const g = await budget.guardPaidSubmission({ runId: C.runId, itemRunId: vid.id, itemType: 'video' });
      eq([g.allow, g.reason], [false, F.RUN_PAUSED_GUARD_REASON], 'pausado → run_paused');
      await resume();
      const g2 = await budget.guardPaidSubmission({ runId: C.runId, itemRunId: vid.id, itemType: 'video' });
      assert(g2.reason !== F.RUN_PAUSED_GUARD_REASON, 'reanudado → guard normal: ' + g2.reason);
    });

    await check('DB (review I3): reanudar un run pausado cuyas partes restantes ya FALLARON → queda terminal con fallas (no despachable, no pausado), nunca colgado en queued', async () => {
      const E = await makeCourse('Pausa con fallas');
      await runs.pauseRun(E.cid, OWNER, 1, E.runId);
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'x', finished_at = now() where job_id = $1 and item_key = any($2::text[])`, [E.runId, E.keys]);
      const dto = await runs.resumeRun(E.cid, OWNER, 1, E.runId);
      const row = await runRow(E.runId);
      assert(!dto.paused && !IT.DISPATCHABLE_RUN_WORKER_STATUSES.includes(row.worker_status), 'terminal: ' + row.worker_status);
      eq(row.worker_status, 'failed', 'muestra las partes fallidas para reintentarlas a mano');
      assert(row.output_summary.pause.resumedAt, 'registro del reanudar');
    });

    await check('DB: cancelar desde pausado funciona (pausar → cancelar → cancelled; nadie reclama)', async () => {
      await pause();
      await runs.cancelRun(C.cid, OWNER, 1, C.runId);
      eq(await status(), ['cancelled', 'cancelled'], 'cancelado');
      const r = await claim(C.runId, A);
      eq(r.item, null, 'sin partes');
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

