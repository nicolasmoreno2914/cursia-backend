#!/usr/bin/env node
/* eslint-disable */
// r61 Q-04 (re-review M-8) — pin del plan de las preguntas del video contra Postgres REAL.
//
// PG16 DESECHABLE (mismo arranque y migraciones que check-ev6-video-upgrade.js; puerto libre ≠ 5570/8099), 0 red:
//   1. un ejecutor del NAVEGADOR sin `video-scenes-1` reclama video_interactions de un video CON escenas →
//      claim equidistante (el de siempre) y `videoTimelinePinned = 'even_spacing'` en la MISMA transacción;
//   2. su lease vence; el barrido lo pasa a retrying;
//   3. un worker del SERVIDOR (sin ownerId) lo reclama → claim anclado + `videoTimelinePinned = 'videogen_scenes'`;
//   4. el complete tardío del primer ejecutor se RECHAZA (no es el dueño del lease): nunca se acepta un documento
//      escrito contra el pin de otro ejecutor; el pin y el worker siguen siendo los del segundo claim.
//
// Usage: node scripts/check-r61-video-pin-pg.js   (npm run build antes)
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const distRoot = path.join(REPO, 'dist');
const L = (rel) => require(path.join(distRoot, rel));
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { if (String(u).startsWith('data:')) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

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
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
async function rejectsRe(p, re, m, status) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${m}: no lanzó`);
  const text = err.message + ' ' + JSON.stringify(err.getResponse ? err.getResponse() : '');
  assert(re.test(text), `${m}: mensaje inesperado "${text.slice(0, 400)}"`);
  if (status !== undefined) assert(err.getStatus && err.getStatus() === status, `${m}: status ${err.getStatus && err.getStatus()} (esperado ${status})`);
  return err;
}
const dec = (x) => Number(x);

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
const OTHER = '22222222-3333-4444-8555-666666666666';
const CONTEXT = { nombre: 'Curso EV6 B2', sector: 'Salud', pais: 'Chile', contexto: 'x', nivel: 'Básico', tono: 'Formal' };
const MOCK_CTX = { ...CONTEXT, videoMode: 'mock', providerModes: { presentation: 'mock', audio: 'mock' } };
// EV6 DoD (BE-A): previewCourse congela Gamma/TTS como REALES (fixture comercial fuera de los videos); una pestaña
// vieja que reanuda manda el mismo cuerpo que congeló el run: video de vista previa + proveedores reales.
const RESUME_CTX = { ...CONTEXT, videoMode: 'mock', providerModes: { presentation: 'real', audio: 'real' } };

const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_GENERAL_AVAILABILITY', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'DYNAMIC_ALLOW_PROVIDER_MOCK', 'DYNAMIC_ALLOW_VIDEO_PREVIEW',
  'VIDEOGEN_API_KEY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'SUPER_ADMIN_EMAILS'];

(async () => {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const F = L('modules/finops/index.js');
  const snap = L('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = L('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = L('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = L('modules/dynamic-generation/runs.service.js');
  const { SchedulerService } = L('modules/dynamic-generation/scheduler.service.js');
  const P = L('package/h5p/interactive-video/plan.js');
  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r61-pin-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r61-pin-cwd-'));
  const ROLE = 'postgres.r61pinlocaltest01';
  const DB = 'r61pindb';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`Postgres ${pgBin} en 127.0.0.1:${port} (data ${dataDir})`);
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
    for (const s of ['scripts/migrate-production-jobs-constraints.js']) {
      const res = runScript(s, localEnv({}));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out}`);
    }
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js',
      'scripts/migrate-v21-finops.js', 'scripts/verify-v21-finops-schema.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    process.env.DYNAMIC_V2_GENERAL_AVAILABILITY = 'true'; // fail closed: sin lista, V2 solo con habilitación pública explícita
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    require('./lib/provider-test-env').applyFakeProviderEnv();
    delete process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT;
    process.env.VIDEOGEN_API_KEY = 'fake-key-never-used-no-network';
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = 'true';
    process.env.SUPER_ADMIN_EMAILS = 'admin@cursia.test';
    // EV6 DoD (BE-A): los runs de vista previa de este check nacen por el camino QA (escape explícito).
    process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW = 'true';

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [], synchronize: false });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const ytState = { ok: true, calls: 0 };
    const ytPreflight = { async check() { ytState.calls++; return ytState.ok ? { ok: true } : { ok: false, reason: 'no_connection' }; } };
    const runs = new RunsService(ds, manifests, {}, ytPreflight, budget);

    const sched = new SchedulerService(ds, runs);
    const latest = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];

    // Curso v3 con 1 capítulo con video; todo completado salvo las preguntas del video.
    const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, 'Curso r61 pin', 'dynamic') returning id`, [OWNER]);
    const cid = course.id;
    const m1 = crypto.randomUUID();
    const c1 = crypto.randomUUID();
    const s2 = snap.buildBlueprintSnapshotV2({ id: cid, title: 'Curso r61 pin', finalExam: false, activityEngine: 'h5p' },
      [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: false }],
      [{ id: c1, module_id: m1, position: 0, title: 'C1', objective: null, video_enabled: true, activity_enabled: false }]);
    for (const m of s2.modules) {
      await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
      for (const c of m.chapters) {
        await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`,
          [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
      }
    }
    await ds.query(`insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
                    values ($1, 1, 2, $2::jsonb, $3, 0, 1, 1)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
    await manifests.getOrCreate(cid, OWNER, 1);
    await ds.query(`insert into public.cost_budget_policies (scope, scope_id, version, limits, on_exceed) values ('course', $1, 1, $2::jsonb, 'ADMIN_APPROVAL')`,
      [String(cid), JSON.stringify({ maxCostPerRun: '1000', maxCostPerCourse: '1000', monthlyCap: '1000000000' })]);
    const runId = (await runs.startRun(cid, OWNER, 1, MOCK_CTX)).run.id;
    const VI = `video_interactions:${c1}`;
    await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and item_key <> $2`, [runId, VI]);
    const scenes = P.videoScenesFromVideogen(Array.from({ length: 12 }, (_, i) => ({ scene_order: i + 1, narration: `escena ${i + 1}`, duration_seconds: 39 + (i % 3) }))).scenes;
    const D = scenes[scenes.length - 1].endSec;
    await ds.query(`update public.generation_item_runs set output_summary = output_summary || $2::jsonb where job_id = $1 and item_key = $3`,
      [runId, JSON.stringify({ mode: 'mock', delivery: 'completed', youtubeVideoId: 'IdwOipZAeqY', durationSec: D, durationSource: 'mp4_mvhd', videoScenes: scenes }), `video:${c1}`]);
    const OLD_FEATURES = ['pedagogy-brief-1', 'application-activity-1', 'guided-practice-1'];
    const videoOf = (it) => (it && (it.claimPayload?.video ?? it.payload?.video ?? it.video)) || null;

    await check('M-8 pin con Postgres: ejecutor viejo → even_spacing; lease vencida; worker del servidor → videogen_scenes; el complete tardío del primero se rechaza', async () => {
      const a = await sched.claimNextItem({ executorId: 'old-fe-1', types: ['video_interactions'], runId, ownerId: OWNER, leaseSeconds: 60, executorFeatures: OLD_FEATURES });
      assert(a && a.itemKey === VI, `claim 1: ${a && a.itemKey}`);
      const va = videoOf(a);
      eq(va && va.checkpoints, P.planInteractionCheckpoints(D), 'claim 1 = plan de siempre');
      assert(!('videoScenes' in va) && !('timelineSource' in va), 'claim 1 sin escenas (claves de siempre)');
      let row = await latest(runId, VI);
      eq([row.worker_id, row.output_summary.videoTimelinePinned], ['old-fe-1', 'even_spacing'], 'pin 1 en la tx del claim');
      // Lease vencida → el barrido del próximo claim lo pasa a retrying; se adelanta su backoff.
      await ds.query(`update public.generation_item_runs set lease_until = now() - interval '5 seconds' where id = $1`, [row.id]);
      const none = await sched.claimNextItem({ executorId: 'srv-llm-1', types: ['video_interactions'], runId, leaseSeconds: 60 });
      if (!none) await ds.query(`update public.generation_item_runs set next_retry_at = now() - interval '1 second' where id = $1 and status = 'retrying'`, [row.id]);
      const b = none || await sched.claimNextItem({ executorId: 'srv-llm-1', types: ['video_interactions'], runId, leaseSeconds: 60 });
      assert(b && b.itemKey === VI, `claim 2: ${b && b.itemKey}`);
      const vb = videoOf(b);
      eq([vb.timelineSource, vb.checkpoints], ['videogen_scenes', P.planVideoCheckpoints(D, scenes).checkpoints], 'claim 2 anclado');
      row = await latest(runId, VI);
      eq([row.status, row.worker_id, row.output_summary.videoTimelinePinned], ['running', 'srv-llm-1', 'videogen_scenes'], 'pin 2');
      const late = await sched.completeItemDetailed(row.id, 'old-fe-1', { artifactIds: [crypto.randomUUID()], summary: {} }, OWNER);
      assert(late.ok === false, `complete tardío aceptado: ${JSON.stringify(late)}`);
      row = await latest(runId, VI);
      eq([row.status, row.worker_id, row.output_summary.videoTimelinePinned], ['running', 'srv-llm-1', 'videogen_scenes'], 'nada cambió');
      console.log(`   (complete tardío rechazado: ${late.reason})`);
    });
  } catch (err) {
    failures++;
    console.error(`❌ setup falló: ${err && err.stack ? err.stack : err}`);
  } finally {
    if (ds && ds.isInitialized) await ds.destroy().catch(() => {});
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    console.log('PG16 descartable destruido');
  }
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures === 0 ? 0 : 1);
})();
