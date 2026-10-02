#!/usr/bin/env node
/* eslint-disable */
// REL R2 — log de intentos (generation_item_attempts) + columnas de recuperación por item.
//
// Parte pura (siempre; --pure-only para CI): redacción del extracto, outcome por código, actor de
// admin hasheado, executor_kind, vista de recuperación (registrada / derivada / sin fallo), redacción
// del costo para dueños, verificador de esquema.
// Parte DB (default; PG16 desechable en un puerto libre ≠ 5570/8099): esquema real de staging y
// RunsService/SchedulerService compilados sobre un run v3 real (proveedores solo como variables de
// entorno, nunca se llaman). DOS bases en el mismo cluster:
//   - `relbase`: SIN la migración de R2 → todo funciona igual (sonda de esquema: no-op) y la vista
//     del run deriva la clasificación en la lectura;
//   - `reldb`: con supabase-migration-rel-recovery.sql (aplicada 2 veces: idempotente; verify ok):
//     claim abre el intento; fail/barrido/drain/presupuesto lo cierran con clase/código/estrategia en
//     la MISMA transacción (un rollback deshace ambos); complete limpia el último fallo; retry/auto-heal/
//     reapertura agregan `reopened`; cancel deja `abandoned`; un intento abierto por item; filas
//     cerradas inmutables; RunDto.items[].recovery/cost.
//   - preservación: la MISMA secuencia de operaciones en las dos bases deja las filas de
//     generation_item_runs idénticas en todo lo que existía antes (status, intentos, error, espera…).
//
// Usage: npm run build && node scripts/check-rel-recovery.js [--pure-only] [path/to/dist]

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
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const AL = loadDist('modules/reliability/attempt-log.js');
const RV = loadDist('modules/dynamic-generation/item-recovery-view.js');
const OSI = loadDist('modules/dynamic-generation/owner-safe-run.interceptor.js');
const IT = loadDist('modules/dynamic-generation/item-transitions.js');
const VERIFY = require('./verify-rel-recovery-schema');
const { applyFakeProviderEnv } = require('./lib/provider-test-env');

const LOGS = [];
const capLogger = { log: (m) => LOGS.push(String(m)), warn: (m) => LOGS.push(String(m)), error: (m) => LOGS.push(String(m)) };
Logger.overrideLogger({ log: capLogger.log, warn: capLogger.warn, error: capLogger.error, debug: () => {}, verbose: () => {} });

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Parte pura
// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  await check('puro: extracto del error ≤ 500 y sin secretos (sk-, Bearer, JWT, firmas de URL, api_key=)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const raw = `fallo sk-ant-api03-ABCDEFGHIJKLMNOP Bearer abcdefghijklmnop token ${jwt} https://x.supabase.co/o?token=SECRETO123&X-Amz-Signature=deadbeef api_key=ABCDEF123456`;
    const r = AL.redactErrorExcerpt(raw);
    for (const s of ['sk-ant-api03-ABCDEFGHIJKLMNOP', 'abcdefghijklmnop', jwt, 'SECRETO123', 'deadbeef', 'ABCDEF123456']) assert(!r.includes(s), `filtra ${s}: ${r}`);
    eq(AL.redactErrorExcerpt('x'.repeat(2000)).length, 500, 'tope 500');
    eq(AL.redactErrorExcerpt('  '), null, 'vacío');
  });
  await check('puro: outcome por código, executor_kind por tipo, actor de admin hasheado (nunca el email)', () => {
    eq(['lease_expired', 'worker_draining', 'unexpected_error'].map(AL.outcomeForFailure), ['lease_expired', 'drained', 'failed'], 'outcome');
    eq([AL.executorKindFor('content', true), AL.executorKindFor('video', false), AL.executorKindFor('presentation', false), AL.executorKindFor('audiobook_chapter', false), AL.executorKindFor('content', false)],
      ['browser', 'video_worker', 'provider_worker', 'provider_worker', 'server_llm'], 'executor_kind');
    const a = AL.adminActor('Admin@Cursia.test');
    assert(/^admin:[0-9a-f]{8}$/.test(a) && !a.includes('cursia') && a === AL.adminActor('admin@cursia.test'), a);
    eq(AL.ATTEMPT_OUTCOMES, ['completed', 'failed', 'lease_expired', 'drained', 'abandoned', 'reopened'], 'outcomes');
  });
  await check('puro: vista de recuperación — registrada (columnas de R2), derivada (sin columnas, item fallado) o ninguna', () => {
    const rec = RV.recoveryViewOf({ status: 'retrying', error: 'gamma_poll_failed: x', type: 'presentation', failure_class: 'A', failure_code: 'gamma_poll_failed',
      recovery_strategy: 'repoll_external', recovery_round: 2, recovery_max_rounds: 3, next_retry_at: '2026-10-02T00:00:00Z', output_summary: { external: { gammaGenerationId: 'g' } } });
    eq([rec.source, rec.class, rec.code, rec.strategy, rec.round, rec.maxRounds, rec.nextRetryAt, rec.currentRecovery],
      ['recorded', 'A', 'gamma_poll_failed', 'repoll_external', 2, 3, '2026-10-02T00:00:00.000Z', 'auto_heal'], 'registrada');
    const der = RV.recoveryViewOf({ status: 'failed', error: 'ambiguous_video_submission', type: 'video', output_summary: {} });
    eq([der.source, der.class, der.code, der.attentionReason, der.maxRounds, der.currentRecovery], ['derived', 'C', 'ambiguous_video_submission', 'duplicate_charge', 0, 'denied'], 'derivada');
    const der2 = RV.recoveryViewOf({ status: 'failed', error: 'lease_expired', type: 'content', output_summary: {} });
    eq([der2.class, der2.maxRounds, der2.attentionReason], ['A', 1, null], 'derivada A (navegador: 1 ronda hoy)');
    const none = RV.recoveryViewOf({ status: 'completed', error: null, type: 'content', recovery_round: 1 });
    eq([none.source, none.class, none.round], ['none', null, 1], 'sin fallo');
    eq(RV.recoveryViewOf({ status: 'pending', error: 'lease_expired', type: 'content' }).source, 'none', 'pending sin registro = sin fallo vigente');
  });
  await check('puro: `items[].cost` solo para SUPER_ADMIN (el interceptor se lo quita al dueño; el resto del item intacto)', () => {
    const run = { id: 'r', items: [{ id: 'i1', recovery: { class: 'A' }, cost: { actual: '1' } }, { id: 'i2' }], completion: null };
    const out = OSI.redactRunPayloadForOwner({ run });
    eq(out.run.items, [{ id: 'i1', recovery: { class: 'A' } }, { id: 'i2' }], 'sin cost');
    eq(run.items[0].cost, { actual: '1' }, 'no muta el original');
    eq(OSI.redactRunPayloadForOwner(run).items[0].recovery, { class: 'A' }, 'RunDto suelto');
  });
  await check('puro: verificador de esquema — snapshot vacío reporta todo lo faltante', () => {
    const p = VERIFY.verifyRelRecoverySchema({ cols: [], idx: [], cons: [], trg: [], rls: null, ledger: true, view: false });
    assert(p.length > 30 && p.some((x) => /recovery_round/.test(x)) && p.some((x) => /uq_gia_open_attempt/.test(x)) && p.some((x) => /RLS/.test(x)) && p.some((x) => /vista/.test(x)), p.join(' | '));
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Parte DB
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
      srv.close(() => (port === 5570 || port === 8099 ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const ADMIN_EMAIL = 'admin@cursia.test';
const CONTEXT = { nombre: 'Curso REL', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY',
  'SUPER_ADMIN_EMAILS'];

/** Columnas de generation_item_runs que existían antes de R2 (comparación de preservación). */
const PRE_R2_COLS = ['status', 'attempt_count', 'max_attempts', 'error', 'worker_id'];

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
  const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
  const { Artifact } = loadDist('modules/artifacts/entities/artifact.entity.js');
  const F = loadDist('modules/finops/index.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-rel-r2-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-rel-r2-cwd-'));
  const ROLE = 'postgres.rellocaltest01';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const restoreProviders = applyFakeProviderEnv();
  const sources = [];
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
      await c.query(`create database relbase`);
      await c.query(`create database reldb`);
      await c.query(`create role "${ROLE}" superuser login`);
    });
    const localEnv = (db, extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: db, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    async function baseSchema(db) {
      await withClient(db, async (c) => {
        for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
          'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) {
          await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
        }
      });
      const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv(db, {}));
      assert(res.code === 0, `migrate-production-jobs-constraints: ${res.out}`);
      await withClient(db, async (c) => {
        for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) {
          await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
        }
      });
      for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js',
        'scripts/migrate-v21-finops.js', 'scripts/verify-v21-finops-schema.js']) {
        const x = runScript(s, localEnv(db, { MIGRATION_ENV: 'staging' }));
        assert(x.code === 0, `${s}: exit ${x.code}\n${x.out.slice(-2000)}`);
      }
    }
    await baseSchema('relbase');
    await baseSchema('reldb');

    await check('DB migración: sin MIGRATION_ENV=staging se niega; aplicada DOS veces (idempotente) + verify ok; deploy-staging la cablea (nunca deploy.yml); el migrador de prod la lista como preparación', async () => {
      let x = runScript('scripts/migrate-rel-recovery.js', localEnv('reldb', {}));
      assert(x.code !== 0 && /MIGRATION_ENV/.test(x.out), 'sin intención explícita: ' + x.out);
      x = runScript('scripts/verify-rel-recovery-schema.js', localEnv('reldb', { MIGRATION_ENV: 'staging' }));
      assert(x.code !== 0 && /no existe/.test(x.out), 'verify antes de migrar debe fallar: ' + x.out.slice(-400));
      for (let i = 0; i < 2; i++) {
        x = runScript('scripts/migrate-rel-recovery.js', localEnv('reldb', { MIGRATION_ENV: 'staging' }));
        assert(x.code === 0, `migrate #${i + 1}: ${x.out}`);
      }
      x = runScript('scripts/verify-rel-recovery-schema.js', localEnv('reldb', { MIGRATION_ENV: 'staging' }));
      assert(x.code === 0 && /Esquema REL R2 completo/.test(x.out), 'verify: ' + x.out);
      const stg = fs.readFileSync(path.join(REPO, '.github/workflows/deploy-staging.yml'), 'utf8');
      const prod = fs.readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8');
      assert(/MIGRATION_ENV=staging node scripts\/migrate-rel-recovery\.js/.test(stg) && /MIGRATION_ENV=staging node scripts\/verify-rel-recovery-schema\.js/.test(stg), 'staging');
      assert(stg.indexOf('migrate-rel-recovery.js') > stg.indexOf('migrate-v21-finops.js'), 'después del ledger FinOps (vista de costos)');
      assert(!/rel-recovery/.test(prod), 'deploy.yml (producción) no la corre');
      const plan = JSON.parse(spawnSync(process.execPath, [path.join(REPO, 'scripts/prod/migrate-v2-production.js'), '--plan-json'], { cwd: tmpCwd, env: cleanEnv({}), encoding: 'utf8' }).stdout);
      const st = plan.steps.find((s) => s.id === 'rel-recovery');
      assert(st && st.status === 'included' && st.transactional === true && st.file === 'supabase-migration-rel-recovery.sql', 'paso prod: ' + JSON.stringify(st));
      assert(plan.connected === false && plan.mode === 'DRY-RUN', 'el plan no conecta');
    });

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    delete process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT;
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    process.env.VIDEOGEN_API_KEY = 'fake-videogen-key-never-used-no-network';
    process.env.SUPER_ADMIN_EMAILS = ADMIN_EMAIL;

    async function env(db) {
      const ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: db, entities: [Artifact], synchronize: false });
      await ds.initialize();
      sources.push(ds);
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
        const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID();
        const s2 = snap.buildBlueprintSnapshotV2(
          { id: cid, title, finalExam: true, activityEngine: 'h5p' },
          [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
          [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: true, activity_enabled: true },
            { id: c2, module_id: m1, position: 1, title: 'Válvulas', objective: null, video_enabled: false, activity_enabled: false }],
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
           values ($1, 1, 2, $2::jsonb, $3, 0, 1, 2)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
        await manifests.getOrCreate(cid, OWNER, 1);
        let runId;
        try {
          runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
        } catch (err) {
          const body = err.getResponse ? err.getResponse() : null;
          assert(body && body.code === 'budget_approval_required', `startRun: ${err.message}`);
          await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: ADMIN_EMAIL, reason: 'check REL R2' });
          runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
        }
        return { cid, c1, c2, runId };
      }
      const itemRow = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
      const setRow = (id, sets, params = []) => ds.query(`update public.generation_item_runs set ${sets} where id = $1`, [id, ...params]);
      /** Completa por SQL (sin artifacts) las dependencias de un item para que sea reclamable. */
      const completeDeps = async (runId, key) => {
        const it = await itemRow(runId, key);
        for (const d of it.depends_on || []) await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and item_key = $2`, [runId, d]);
      };
      const claimWorker = (runId, type) => sched.claimNextItem({ runId, executorId: `rel-${type}-worker`, types: [type], leaseSeconds: 120 });
      const claimable = (id) => setRow(id, `next_retry_at = now() - interval '1 second'`);
      return { ds, runs, sched, makeCourse, itemRow, setRow, completeDeps, claimWorker, claimable };
    }

    /**
     * Secuencia idéntica en ambas bases (preservación): presentación de un worker con fail retryable →
     * re-claim → lease vencido → drain → fail con errorCode explícito → retry del dueño → complete.
     * Devuelve la traza de las columnas PRE-R2 tras cada paso.
     */
    async function sequence(E, label) {
      const C = await E.makeCourse(`Curso ${label}`);
      const key = `presentation:${C.c1}`;
      await E.completeDeps(C.runId, key);
      const trace = [];
      const snapRow = async (step) => {
        const r = await E.itemRow(C.runId, key);
        trace.push({ step, ...Object.fromEntries(PRE_R2_COLS.map((c) => [c, r[c]])), nextRetry: r.next_retry_at !== null, finished: r.finished_at !== null, lease: r.lease_until !== null });
        return r;
      };
      let item = await E.claimWorker(C.runId, 'presentation');
      assert(item && item.itemKey === key, `${label}: claim ${item && item.itemKey}`);
      await snapRow('claim1');
      eq(await E.sched.failItem(item.itemRunId, 'rel-presentation-worker', 'gamma_poll_failed: gamma: GET 503 (HTTP 503)', true), true, 'fail 1');
      await snapRow('fail_retryable');
      await E.claimable(item.itemRunId);
      item = await E.claimWorker(C.runId, 'presentation');
      await snapRow('claim2');
      await E.setRow(item.itemRunId, `lease_until = now() - interval '1 second'`);
      eq(await E.sched.sweepExpiredLeases(C.runId), 1, 'barrido');
      await snapRow('lease_expired');
      await E.claimable(item.itemRunId);
      item = await E.claimWorker(C.runId, 'presentation');
      eq(await E.sched.failItem(item.itemRunId, 'rel-presentation-worker', 'worker_draining: el worker se reinicia', true, undefined, { grantAttempt: true }), true, 'drain');
      await snapRow('drained');
      await E.claimable(item.itemRunId);
      item = await E.claimWorker(C.runId, 'presentation');
      const fr = await E.sched.failItemDetailed(item.itemRunId, 'rel-presentation-worker', 'la portada salió mal (texto libre)', false, undefined, { errorCode: 'presentation_artifact_invalid' });
      eq(fr, { ok: true }, 'fail con errorCode');
      await snapRow('failed_errorCode');
      const dto = await E.runs.retryItem(C.cid, OWNER, 1, C.runId, key);
      eq(dto.status, 'pending', 'retry del dueño');
      await snapRow('retried');
      item = await E.claimWorker(C.runId, 'presentation');
      const [art] = await E.ds.query(
        `insert into public.artifacts (owner_id, course_id, job_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, metadata, module_id, chapter_id, manifest_id, manifest_item_key)
         values ($1, $2, $3, 'dynamic_presentation', 'supabase', 'cursia-artifacts', $4, 'p.json', 'application/json', '{}'::jsonb, $5, $6, $7, $8) returning id`,
        [OWNER, String(item.artifactCourseId), C.runId, `${OWNER}/rel/${crypto.randomUUID()}.json`, item.moduleId ?? null, item.chapterId ?? null, item.manifestId, key]);
      const done = await E.sched.completeItemDetailed(item.itemRunId, 'rel-presentation-worker', { artifactIds: [art.id], summary: { mode: 'mock' } });
      eq(done, { ok: true }, 'complete');
      await snapRow('completed');
      return { C, key, trace, itemRunId: item.itemRunId };
    }

    // ── relbase: SIN la migración ────────────────────────────────────────────
    AL.resetRelSchemaCache();
    const B = await env('relbase');
    let baseSeq = null;
    await check('DB sin migración (relbase): claim/fail/barrido/drain/errorCode/retry/complete funcionan igual — la sonda de esquema deja todo como no-op', async () => {
      baseSeq = await sequence(B, 'base');
      const [{ n }] = await B.ds.query(`select count(*)::int n from information_schema.columns where table_name = 'generation_item_runs' and column_name = 'failure_class'`);
      eq(n, 0, 'sin columnas de R2');
      eq(await AL.relSchemaReady(B.ds), false, 'sonda negativa');
    });
    await check('DB sin migración: la vista del run deriva la clasificación en la lectura (source derived) para un item fallado', async () => {
      const it = await B.itemRow(baseSeq.C.runId, `video:${baseSeq.C.c1}`);
      await B.setRow(it.id, `status = 'failed', error = 'ambiguous_video_submission: timeout', finished_at = now()`);
      const run = await B.runs.getRun(baseSeq.C.cid, OWNER, 1, baseSeq.C.runId);
      const v = run.items.find((i) => i.itemKey === `video:${baseSeq.C.c1}`);
      eq([v.recovery.source, v.recovery.class, v.recovery.code, v.recovery.attentionReason], ['derived', 'C', 'ambiguous_video_submission', 'duplicate_charge'], 'derivada');
      const p = run.items.find((i) => i.itemKey === baseSeq.key);
      eq([p.recovery.source, p.recovery.class], ['none', null], 'completado: sin fallo');
    });

    // ── reldb: CON la migración ──────────────────────────────────────────────
    AL.resetRelSchemaCache();
    const R = await env('reldb');
    let relSeq = null;
    const attempts = (itemRunId) => R.ds.query(`select * from public.generation_item_attempts where item_run_id = $1 order by created_at, id`, [itemRunId]);

    await check('DB preservación: la MISMA secuencia deja generation_item_runs idéntica (columnas previas a R2) con y sin la migración', async () => {
      AL.resetRelSchemaCache();
      relSeq = await sequence(R, 'rel');
      eq(await AL.relSchemaReady(R.ds), true, 'sonda positiva');
      eq(relSeq.trace, baseSeq.trace, 'traza');
    });

    await check('DB log de intentos: claim abre, fail/barrido/drain/fail cierran (clase, código, estrategia, outcome, next_retry_at), retry agrega reopened, complete cierra', async () => {
      const rows = await attempts(relSeq.itemRunId);
      eq(rows.map((r) => [r.attempt_no, r.outcome, r.failure_class, r.failure_code, r.executor_kind, r.actor]), [
        [1, 'failed', 'A', 'gamma_poll_failed', 'provider_worker', 'system'],
        [2, 'lease_expired', 'A', 'lease_expired', 'provider_worker', 'system'],
        [3, 'drained', 'A', 'worker_draining', 'provider_worker', 'system'],
        [4, 'failed', 'B', 'presentation_artifact_invalid', 'provider_worker', 'system'],
        [4, 'reopened', 'B', 'presentation_artifact_invalid', null, 'owner'],
        [5, 'completed', null, null, 'provider_worker', 'system'],
      ], 'filas');
      assert(rows.every((r) => r.finished_at && r.started_at), 'todas cerradas');
      eq(rows[0].http_status, 503, 'http_status');
      eq(rows[0].strategy_applied, 'retry_backoff', 'sin generationId → retry_backoff (no repoll)');
      assert(rows[0].next_retry_at, 'next_retry_at del retrying');
      eq(rows[4].strategy_applied, 'manual_retry', 'estrategia de la reapertura');
      assert(rows[0].error_excerpt.startsWith('gamma_poll_failed'), 'extracto');
      eq(rows[0].executor_id, 'rel-presentation-worker', 'executor_id');
    });

    await check('DB columnas del item: complete limpia el último fallo; un fail no reintentable C deja attention_reason; maxRounds = lo que hace HOY el sistema', async () => {
      let row = await R.itemRow(relSeq.C.runId, relSeq.key);
      eq([row.status, row.failure_class, row.failure_code, row.recovery_strategy, row.attention_reason, row.recovery_round], ['completed', null, null, null, null, 0], 'completado');
      const vkey = `video:${relSeq.C.c1}`;
      await R.completeDeps(relSeq.C.runId, vkey);
      const v = await R.claimWorker(relSeq.C.runId, 'video');
      assert(v && v.itemKey === vkey, 'claim video');
      await R.sched.failItem(v.itemRunId, 'rel-video-worker', 'ambiguous_video_submission: timeout del batchCreate', false);
      row = await R.itemRow(relSeq.C.runId, vkey);
      eq([row.status, row.failure_class, row.failure_code, row.recovery_strategy, row.attention_reason, row.recovery_max_rounds],
        ['failed', 'C', 'ambiguous_video_submission', 'provider_check', 'duplicate_charge', 0], 'C terminal');
      const [a] = await attempts(v.itemRunId);
      eq([a.executor_kind, a.outcome, a.failure_class, a.provider], ['video_worker', 'failed', 'C', 'videogen'], 'intento del video');
    });

    await check('DB runtime guard de presupuesto: blocked + clase D budget (attention budget) en la misma transacción', async () => {
      const key = `audiobook_chapter:${relSeq.C.c1}`;
      await R.completeDeps(relSeq.C.runId, key);
      const it = await R.claimWorker(relSeq.C.runId, 'audiobook_chapter');
      assert(it && it.itemKey === key, 'claim audio');
      eq(await R.sched.blockItemForBudget(it.itemRunId, 'rel-audiobook_chapter-worker', 'no_authorization'), true, 'bloqueado');
      const row = await R.itemRow(relSeq.C.runId, key);
      eq([row.status, row.failure_class, row.failure_code, row.attention_reason], ['blocked', 'D', 'budget_exceeded', 'budget'], 'item');
      const [a] = await attempts(it.itemRunId);
      eq([a.outcome, a.failure_class, a.failure_code, a.strategy_applied], ['failed', 'D', 'budget_exceeded', 'hold_for_human'], 'intento');
    });

    await check('DB navegador: claim con ownerId → executor_kind browser; errorCode explícito del ejecutor gana (texto en español); recovery en RunDto', async () => {
      const item = await R.sched.claimNextItem({ runId: relSeq.C.runId, executorId: 'browser-tab-1', ownerId: OWNER, leaseSeconds: 120,
        types: ['content', 'scorm', 'exam', 'course_plan', 'course_intro', 'module_intro', 'experience', 'video_interactions', 'activity', 'final_exam'] });
      assert(item, 'claim del navegador');
      const res = await R.sched.failItemDetailed(item.itemRunId, 'browser-tab-1', 'el banco quedó incompleto: faltan 3 preguntas', true, OWNER, { errorCode: 'EXAM_BANK_INCOMPLETE' });
      eq(res, { ok: true }, 'fail');
      const row = await R.itemRow(relSeq.C.runId, item.itemKey);
      eq([row.status, row.failure_class, row.failure_code, row.recovery_strategy, row.error], ['retrying', 'B', 'EXAM_BANK_INCOMPLETE', 'regenerate_targeted', 'el banco quedó incompleto: faltan 3 preguntas'], 'fila');
      const [a] = await attempts(item.itemRunId);
      eq([a.executor_kind, a.executor_id, a.outcome, a.failure_code], ['browser', 'browser-tab-1', 'failed', 'EXAM_BANK_INCOMPLETE'], 'intento');
      const run = await R.runs.getRun(relSeq.C.cid, OWNER, 1, relSeq.C.runId);
      const dto = run.items.find((i) => i.itemKey === item.itemKey);
      eq([dto.recovery.source, dto.recovery.class, dto.recovery.code, dto.recovery.strategy, dto.attemptCount, dto.maxAttempts],
        ['recorded', 'B', 'EXAM_BANK_INCOMPLETE', 'regenerate_targeted', row.attempt_count, row.max_attempts], 'RunDto');
      assert(dto.recovery.nextRetryAt, 'nextRetryAt');
      // Costo: estimado del run + real del ledger (0 sin eventos); presente para todos los items.
      assert(run.items.every((i) => i.cost && i.cost.currency === 'USD' && typeof i.cost.actual === 'string'), 'cost en cada item');
      assert(run.items.some((i) => i.cost.estimated !== null && Number(i.cost.estimated) > 0), 'algún estimado > 0 (estimado congelado del run)');
      // Un evento del ledger del item se refleja en actual.
      await R.ds.query(
        `insert into public.generation_cost_events (event_kind, owner_id, course_id, run_id, item_run_id, item_key, item_type, operation, provider,
           idempotency_key, amount, cost_source, billing_account, billable, recorded_by, attempt)
         values ('CHARGE', $1, $2, $3, $4, $5, $6, 'llm', 'anthropic', $7, 0.4200, 'CALCULATED_FROM_USAGE', 'cursia', true, 'check-rel', 1)`,
        [OWNER, relSeq.C.cid, relSeq.C.runId, item.itemRunId, item.itemKey, item.type, `rel-check-${crypto.randomUUID()}`]);
      const run2 = await R.runs.getRun(relSeq.C.cid, OWNER, 1, relSeq.C.runId);
      eq(run2.items.find((i) => i.itemKey === item.itemKey).cost.actual, '0.42', 'actual del ledger');
      const [vc] = await R.ds.query(`select amount::text as amount, events from public.generation_item_attempt_costs where item_run_id = $1 and attempt_no = 1`, [item.itemRunId]);
      eq([Number(vc.amount), vc.events], [0.42, 1], 'vista de costo por intento');
    });

    await check('DB auto-heal: la reapertura automática es `reopened` actor auto_heal y suma recovery_round (el healer decide igual que siempre)', async () => {
      const key = `content:${relSeq.C.c2}`;
      const it = await R.itemRow(relSeq.C.runId, key);
      await R.setRow(it.id, `status = 'failed', error = 'lease_expired', finished_at = now() - interval '10 minutes', output_summary = '{}'::jsonb`);
      const r = await R.runs.autoHealFailedItems({ now: new Date() });
      assert(r.reopened.some((x) => x.itemKey === key), 'reabierto: ' + JSON.stringify(r));
      const row = await R.itemRow(relSeq.C.runId, key);
      eq([row.status, row.recovery_round], ['pending', 1], 'fila');
      const rows = await attempts(it.id);
      const last = rows[rows.length - 1];
      eq([last.outcome, last.actor, last.strategy_applied, last.recovery_round], ['reopened', 'auto_heal', 'auto_heal', 1], 'intento');
    });

    await check('DB admin: retry de SUPER_ADMIN → actor admin:<hash> (nunca el email)', async () => {
      const vkey = `video:${relSeq.C.c1}`;
      await R.runs.retryItem(relSeq.C.cid, OWNER, 1, relSeq.C.runId, vkey, true, false, undefined, { email: ADMIN_EMAIL });
      const v = await R.itemRow(relSeq.C.runId, vkey);
      const rows = await attempts(v.id);
      const last = rows[rows.length - 1];
      eq([last.outcome, last.actor, last.strategy_applied], ['reopened', AL.adminActor(ADMIN_EMAIL), 'manual_resubmit_video'], 'admin');
      assert(!JSON.stringify(rows).includes(ADMIN_EMAIL), 'sin email en el log');
      eq(v.attention_reason, null, 'la reapertura limpia attention_reason');
      eq(v.failure_code, 'ambiguous_video_submission', 'el último error se conserva hasta completar');
    });

    await check('DB misma transacción: si la transición se deshace (rollback), el cierre del intento también', async () => {
      const key = `video:${relSeq.C.c1}`;
      const it = await R.claimWorker(relSeq.C.runId, 'video');
      assert(it && it.itemKey === key, 'claim');
      const qr = R.ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        const t = await IT.applyItemFailure(qr, it.itemRunId, 'unexpected_error: boom', true);
        assert(t && t.status === 'retrying', 'transición dentro de la tx');
        const [inTx] = await qr.query(`select outcome from public.generation_item_attempts where item_run_id = $1 and attempt_no = $2`, [it.itemRunId, it.attempt]);
        eq(inTx.outcome, 'failed', 'cerrado dentro de la tx');
      } finally {
        await qr.rollbackTransaction();
        await qr.release();
      }
      const row = await R.itemRow(relSeq.C.runId, key);
      eq([row.status, row.failure_code], ['running', 'ambiguous_video_submission'], 'item intacto');
      const open = await R.ds.query(`select outcome, finished_at from public.generation_item_attempts where item_run_id = $1 and finished_at is null`, [it.itemRunId]);
      eq(open.length, 1, 'el intento sigue abierto');
    });

    await check('DB invariantes: a lo sumo UN intento abierto por item (23505); una fila cerrada es inmutable (P0001); abierto ⇔ sin outcome', async () => {
      const v = await R.itemRow(relSeq.C.runId, `video:${relSeq.C.c1}`);
      let err = null;
      try {
        await R.ds.query(`insert into public.generation_item_attempts (item_run_id, job_id, item_key, generation, attempt_no) values ($1, $2, $3, 1, 99)`, [v.id, v.job_id, v.item_key]);
      } catch (e) { err = e; }
      assert(err && (err.code === '23505' || (err.driverError && err.driverError.code === '23505')), 'segundo abierto: ' + (err && err.message));
      const [closed] = await R.ds.query(`select id from public.generation_item_attempts where finished_at is not null limit 1`);
      err = null;
      try { await R.ds.query(`update public.generation_item_attempts set failure_code = 'x' where id = $1`, [closed.id]); } catch (e) { err = e; }
      assert(err && /inmutable/.test(err.message), 'cerrada inmutable: ' + (err && err.message));
      err = null;
      try {
        await R.ds.query(`insert into public.generation_item_attempts (item_run_id, job_id, item_key, generation, finished_at) values ($1, $2, $3, 1, now())`, [v.id, v.job_id, v.item_key]);
      } catch (e) { err = e; }
      assert(err && /gia_open_closed/.test(err.message), 'cerrada sin outcome: ' + (err && err.message));
    });

    await check('DB cancelación: los intentos abiertos quedan `abandoned` (misma transacción del cancel)', async () => {
      const v = await R.itemRow(relSeq.C.runId, `video:${relSeq.C.c1}`);
      await R.runs.cancelRun(relSeq.C.cid, OWNER, 1, relSeq.C.runId, { email: ADMIN_EMAIL });
      const open = await R.ds.query(`select count(*)::int n from public.generation_item_attempts a join public.generation_item_runs g on g.id = a.item_run_id
                                       where g.job_id = $1 and a.finished_at is null`, [relSeq.C.runId]);
      eq(open[0].n, 0, 'sin abiertos');
      const rows = await attempts(v.id);
      eq(rows[rows.length - 1].outcome, 'abandoned', 'abandoned');
    });

    await check('DB RLS: generation_item_attempts con RLS habilitado; la vista de costos es security_invoker', async () => {
      const [t] = await R.ds.query(`select relrowsecurity from pg_class where oid = 'public.generation_item_attempts'::regclass`);
      eq(t.relrowsecurity, true, 'RLS');
      const [vw] = await R.ds.query(`select reloptions from pg_class where oid = 'public.generation_item_attempt_costs'::regclass`);
      assert(JSON.stringify(vw.reloptions || []).includes('security_invoker=true'), 'security_invoker: ' + JSON.stringify(vw.reloptions));
    });
  } finally {
    for (const ds of sources) { try { await ds.destroy(); } catch {} }
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
