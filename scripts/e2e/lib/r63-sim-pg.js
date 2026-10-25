/* eslint-disable */
// r63 (SC) — Postgres 16 DESECHABLE + cursos/runs sintéticos rulesVersion 3 para el check del reparto justo
// (scripts/check-r63-fair-scheduler.js) y la simulación de carga (scripts/e2e/r63-load-sim.js).
// Mismo arranque y migraciones que check-r61-video-pin-pg.js (puerto libre ≠ 5570/8099, socket en el data dir).
// No es código de producto. 0 red: solo 127.0.0.1.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const distRoot = path.join(REPO, 'dist');
const L = (rel) => require(path.join(distRoot, rel));

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
      srv.close(() => (port === 5570 || port === 8099 ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'DYNAMIC_ALLOW_PROVIDER_MOCK', 'DYNAMIC_ALLOW_VIDEO_PREVIEW',
  'VIDEOGEN_API_KEY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'SUPER_ADMIN_EMAILS',
  'DYNAMIC_SCHEDULER_POLICY', 'DYNAMIC_SCHEDULER_TYPE_CAPS', 'DYNAMIC_SCHEDULER_PROVIDER_CAPS', 'DYNAMIC_ADMISSION_ENABLED',
  'DYNAMIC_ADMISSION_MAX_ACTIVE_RUNS', 'DYNAMIC_ADMISSION_MAX_ACTIVE_PER_OWNER'];

/**
 * Arranca PG16, aplica las migraciones y devuelve { ds, runs, sched, ledger, budget, mods, stop(), pool(n) }.
 * `poolMax` = conexiones del DataSource principal (los «procesos» extra se piden con pool()).
 */
async function startSimPg({ poolMax = 10, log = console.log } = {}) {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r63sc-db-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r63sc-cwd-'));
  const ROLE = 'postgres.r63sclocaltest01';
  const DB = 'r63scdb';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let started = false;
  const extra = [];
  const stop = async () => {
    for (const d of extra) if (d.isInitialized) await d.destroy().catch(() => {});
    if (ds && ds.isInitialized) await ds.destroy().catch(() => {});
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    log('PG16 descartable destruido');
  };
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1 -c max_connections=200 -c fsync=off -c synchronous_commit=off`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    log(`Postgres ${pgBin} en 127.0.0.1:${port} (data ${dataDir})`);
    const withClient = async (db, fn) => {
      const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db });
      await c.connect();
      try { return await fn(c); } finally { await c.end(); }
    };
    await withClient('postgres', async (c) => {
      await c.query(`create database ${DB}`);
      await c.query(`create role "${ROLE}" superuser login`);
    });
    const localEnv = (x) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...x });
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 180000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
        'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    for (const s of ['scripts/migrate-production-jobs-constraints.js']) {
      const res = runScript(s, localEnv({}));
      if (res.code !== 0) throw new Error(`${s}: exit ${res.code}\n${res.out}`);
    }
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js',
      'scripts/migrate-v21-finops.js', 'scripts/verify-v21-finops-schema.js', 'scripts/migrate-rel-recovery.js', 'scripts/migrate-rel-exec-lease.js', 'scripts/migrate-run-pause.js']) {
      if (!fs.existsSync(path.join(REPO, s))) continue;
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      if (res.code !== 0) throw new Error(`${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    require(path.join(REPO, 'scripts/lib/provider-test-env')).applyFakeProviderEnv();
    delete process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT;
    process.env.VIDEOGEN_API_KEY = 'fake-key-never-used-no-network';
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = 'true';
    process.env.SUPER_ADMIN_EMAILS = 'admin@cursia.test';
    process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW = 'true';
    for (const k of ENV_KEYS.filter((k) => /SCHEDULER|ADMISSION/.test(k))) delete process.env[k];

    const mkDs = async (max) => {
      const d = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [], synchronize: false, extra: { max } });
      await d.initialize();
      return d;
    };
    ds = await mkDs(poolMax);
    const F = L('modules/finops/index.js');
    const { CourseBlueprintsService } = L('modules/course-blueprints/course-blueprints.service.js');
    const { GenerationManifestsService } = L('modules/generation-manifests/generation-manifests.service.js');
    const { RunsService } = L('modules/dynamic-generation/runs.service.js');
    const { SchedulerService } = L('modules/dynamic-generation/scheduler.service.js');
    const build = (d) => {
      const blueprints = new CourseBlueprintsService(d);
      const manifests = new GenerationManifestsService(d, blueprints);
      const ledger = new F.FinopsLedgerService(d);
      const budget = new F.FinopsBudgetService(d, ledger);
      const ytPreflight = { async check() { return { ok: true }; } };
      const runs = new RunsService(d, manifests, {}, ytPreflight, budget);
      const sched = new SchedulerService(d, runs);
      return { ds: d, blueprints, manifests, ledger, budget, runs, sched };
    };
    const main = build(ds);
    /** Un «proceso» más: su propio DataSource (pool propio) + servicios. */
    const proc = async (max = 1) => { const d = await mkDs(max); extra.push(d); return build(d); };
    return { ...main, proc, stop, port };
  } catch (err) {
    await stop();
    throw err;
  }
}

const CONTEXT = { nombre: 'Curso r63 SC', sector: 'Salud', pais: 'Chile', contexto: 'x', nivel: 'Básico', tono: 'Formal' };
const MOCK_CTX = { ...CONTEXT, videoMode: 'mock', providerModes: { presentation: 'mock', audio: 'mock' } };

/**
 * Curso dinámico rulesVersion 3 (modules × chapters, video en cada capítulo) + Blueprint + Manifest + política y run
 * (startRun real) + autorización de presupuesto de `authorizedUsd` (fila directa, como check-finops-atomic-cap).
 * Devuelve { cid, runId, ownerId, items }.
 */
async function createCourseRun(env, { ownerId, title, modules = 1, chapters = 2, authorizedUsd = '50' }) {
  const snap = L('modules/course-blueprints/blueprint-snapshot.js');
  const { ds, manifests, runs } = env;
  const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [ownerId, title]);
  const cid = course.id;
  const mods = [];
  const chs = [];
  for (let m = 0; m < modules; m++) {
    const mid = crypto.randomUUID();
    mods.push({ id: mid, position: m, title: `M${m + 1}`, objective: null, exam_enabled: false });
    for (let c = 0; c < chapters; c++) chs.push({ id: crypto.randomUUID(), module_id: mid, position: c, title: `C${m + 1}.${c + 1}`, objective: null, video_enabled: true, activity_enabled: false });
  }
  const s2 = snap.buildBlueprintSnapshotV2({ id: cid, title, finalExam: false, activityEngine: 'h5p' }, mods, chs);
  for (const m of s2.modules) {
    await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
    for (const c of m.chapters) {
      await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`,
        [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
    }
  }
  await ds.query(`insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
                  values ($1, 1, 2, $2::jsonb, $3, 0, $4, $5)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2), modules, modules * chapters]);
  await manifests.getOrCreate(cid, ownerId, 1);
  await ds.query(`insert into public.cost_budget_policies (scope, scope_id, version, limits, on_exceed) values ('course', $1, 1, $2::jsonb, 'ADMIN_APPROVAL')`,
    [String(cid), JSON.stringify({ maxCostPerRun: '1000', maxCostPerCourse: '1000', monthlyCap: '1000000000' })]);
  const runId = (await runs.startRun(cid, ownerId, 1, MOCK_CTX)).run.id;
  await ds.query(
    `insert into public.cost_budget_authorizations (run_id, course_id, authorized_budget, currency, decision, approved_by, reason) values ($1, $2, $3, 'USD', 'ADMIN_APPROVED', 'admin@cursia.test', 'r63 sim')`,
    [runId, cid, authorizedUsd]);
  const items = await ds.query(`select id, item_key, type, depends_on from public.generation_item_runs where job_id = $1 order by item_key`, [runId]);
  return { cid, runId, ownerId, items };
}

/**
 * Cierre de una parte reclamada, como lo deja completeItem DESPUÉS de validar (la validación v3 de artifacts no es parte
 * de lo que se mide): con el lock del run, solo si sigue running y es de este ejecutor (mismo cerco que el real), y el
 * recálculo real del run (recomputeRunStatus). Para `video` deja los datos que el claim de video_interactions exige.
 */
async function simCompleteItem(ds, itemRunId, executorId) {
  const IT = L('modules/dynamic-generation/item-transitions.js');
  const qr = ds.createQueryRunner();
  await qr.connect();
  try {
    await qr.startTransaction();
    const [it] = await qr.query(`select job_id, type, status, worker_id from public.generation_item_runs where id = $1`, [itemRunId]);
    if (!it) { await qr.rollbackTransaction(); return false; }
    await qr.query(`select id from public.production_jobs where id = $1 for update`, [it.job_id]);
    const extra = it.type === 'video'
      ? { mode: 'mock', delivery: 'completed', youtubeVideoId: 'IdwOipZAeqY', durationSec: 300, durationSource: 'mp4_mvhd' }
      : {};
    const rows = await qr.query(
      `update public.generation_item_runs
          set status = 'completed', finished_at = now(), lease_until = null, next_retry_at = null, updated_at = now(),
              output_summary = coalesce(output_summary, '{}'::jsonb) || $3::jsonb
        where id = $1 and status = 'running' and worker_id = $2
        returning id`, [itemRunId, executorId, JSON.stringify({ ...extra, v3Validation: { ok: true, sim: true } })]);
    const done = (Array.isArray(rows[0]) ? rows[0] : rows).length === 1;
    if (done) await IT.recomputeRunStatus(qr, it.job_id);
    await qr.commitTransaction();
    return done;
  } catch (err) {
    try { await qr.rollbackTransaction(); } catch {}
    throw err;
  } finally {
    await qr.release();
  }
}

module.exports = { startSimPg, createCourseRun, simCompleteItem, REPO, L };
