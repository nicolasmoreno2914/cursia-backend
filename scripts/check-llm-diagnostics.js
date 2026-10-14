#!/usr/bin/env node
/* eslint-disable */
// Diagnóstico de una parte del worker de IA (2026-10-14, examen final de #1353):
// GET /api/v1/admin/dynamic-runs/:runId/items/:itemKey/llm-diagnostics (SUPER_ADMIN, SOLO LECTURA) devuelve el payload
// EXACTO del claim (SchedulerService.claimPreview, transacción READ ONLY) y las respuestas pagadas de sus puntos de
// guardado (Storage), para reproducir la parte localmente a USD 0.
//   - el claim es el mismo que entrega claimNextItem (mismas claves) y no cambia nada (huella de items y del run);
//   - los checkpoints de ESA parte se leen (texto, usage, stopReason); una ruta de otra parte / otro dueño / con «..» nunca
//     se lee; uno ilegible → error por entrada (no rompe el resto);
//   - SupabaseJwtGuard + SuperAdminGuard en el controlador; parte inexistente → 404.
// PG16 desechable + Storage falso en 127.0.0.1; 0 red externa, USD 0.
//
// Usage: npm run build && node scripts/check-llm-diagnostics.js
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
global.fetch = async (u, o) => { const s = String(u); if (s.startsWith('data:') || /^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const { applyFakeProviderEnv } = require('./lib/provider-test-env');
const { startStorage } = require(path.join(REPO, 'test/e2e-v2/fakes.js'));
let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
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
const OTHER = '99999999-2222-4333-8444-555555555555';
const CONTEXT = { nombre: 'Curso stop-after', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY',
  'SUPER_ADMIN_EMAILS', 'DYNAMIC_AUTO_HEAL_POLICY', 'DYNAMIC_AUTO_PACKAGE_ENABLED', 'DYNAMIC_AUTO_HEAL_ENABLED', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const TYPES = ['content'];

async function dbChecks() {
  const storage = startStorage();
  const { LlmDiagnosticsService } = L('modules/dynamic-generation/llm-diagnostics.service.js');
  const { AdminDynamicRunsController } = L('modules/dynamic-generation/admin-runs.controller.js');
  const { SuperAdminGuard } = L('auth/super-admin.guard.js');
  const { SupabaseJwtGuard } = L('auth/supabase-jwt.guard.js');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = L('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = L('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = L('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = L('modules/dynamic-generation/runs.service.js');
  const { RunsController } = L('modules/dynamic-generation/runs.controller.js');
  const { SchedulerService } = L('modules/dynamic-generation/scheduler.service.js');
  const { PackagingService } = L('modules/dynamic-packaging/packaging.service.js');
  const { AutoPackageService } = L('modules/dynamic-packaging/auto-package.service.js');
  const { AdminRecoveryService } = L('modules/dynamic-generation/admin-recovery.service.js');
  const { ArtifactsService } = L('modules/artifacts/artifacts.service.js');
  const { Artifact } = L('modules/artifacts/entities/artifact.entity.js');
  const AL = L('modules/reliability/attempt-log.js');
  const EL = L('modules/reliability/execution-lease.js');
  const F = L('modules/finops/index.js');
  const T = L('modules/dynamic-generation/item-transitions.js');
  const RC = L('modules/dynamic-generation/run-completion.js');
  const AR = L('modules/dynamic-packaging/artifact-resolver.js');
  const IA = L('modules/invalidation/invalidation-apply.js');
  const RH = L('modules/dynamic-generation/run-hash.js');
  const PFR = L('modules/dynamic-packaging/package-freshness.js');
  const RR = L('common/db/returning-rows.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-stopafter-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-stopafter-cwd-'));
  const ROLE = 'postgres.stopafterlocal01';
  const DB = 'stopafterdb';
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
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create role "${ROLE}" superuser login`); });
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
    { const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({})); assert(res.code === 0, `migrate-production-jobs-constraints: ${res.out}`); }
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js',
      'scripts/migrate-v21-finops.js', 'scripts/verify-v21-finops-schema.js', 'scripts/migrate-rel-recovery.js', 'scripts/migrate-rel-exec-lease.js', 'scripts/migrate-run-pause.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    for (const k of ['DYNAMIC_V2_ALLOWED_OWNERS', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_AUTO_HEAL_POLICY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'DYNAMIC_AUTO_PACKAGE_ENABLED']) delete process.env[k];
    process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    process.env.VIDEOGEN_API_KEY = 'fake-videogen-key-never-used-no-network';
    process.env.SUPER_ADMIN_EMAILS = 'admin@cursia.test';
    process.env.SUPABASE_URL = 'http://127.0.0.1:9';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-local-only';
    AL.resetRelSchemaCache();
    EL.resetExecLeaseSchemaCache();

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 8 } });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const ytOk = { async check() { return { ok: true }; } };
    const runs = new RunsService(ds, manifests, {}, ytOk, budget);
    const sched = new SchedulerService(ds, runs);
    const ctrl = new RunsController(runs);
    const artifacts = new ArtifactsService(ds.getRepository(Artifact), { get: (k) => process.env[k] });
    const packaging = new PackagingService(ds, manifests, artifacts);
    // Como check-ev6-dod-autopkg: el build real del .mbz queda fuera (acá importa QUIÉN encola y cuántas veces).
    packaging.prepareV3OrConflict = async () => {};
    packaging.isSameBuild = async () => true;
    PFR.hasDeliverablePackage = async () => false;
    const autoPkg = new AutoPackageService(ds, packaging, runs);
    autoPkg.onModuleInit();
    const admin = new AdminRecoveryService(ds, manifests, runs);

    /** Curso v3 (1 módulo, 3 capítulos): todo completado salvo los 3 content (pendientes, reclamables). Igual que check-run-pause. */
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
        await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test', reason: 'check stop-after' });
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      }
      const keys = [c1, c2, c3].map((c) => `content:${c}`);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and not (item_key = any($2::text[]))`, [runId, keys]);
      await ds.query(`update public.generation_item_runs set status = 'pending' where job_id = $1 and item_key = any($2::text[])`, [runId, keys]);
      return { cid, m1, c1, c2, c3, runId, keys };
    }

    await new Promise((res) => storage.srv.listen(0, '127.0.0.1', res));
    process.env.SUPABASE_URL = `http://127.0.0.1:${storage.srv.address().port}`;
    const artifacts2 = new ArtifactsService(ds.getRepository(Artifact), { get: (k) => process.env[k] });
    const diag = new LlmDiagnosticsService(ds, sched, artifacts2);
    const C = await makeCourse('Diagnóstico');
    const key = C.keys[0];
    const [it] = await ds.query(`select id from public.generation_item_runs where job_id = $1 and item_key = $2`, [C.runId, key]);
    const good = 'a'.repeat(64); const foreign = 'b'.repeat(64); const broken = 'c'.repeat(64); const evil = 'd'.repeat(64);
    const base = `${OWNER}/dynamic/x/1/llm-checkpoints/${it.id}`;
    storage.blobs.set(`cursia-artifacts/${base}/${good}.json`, Buffer.from(JSON.stringify({ text: '{"questions":[]}', usage: { output_tokens: 12 }, stopReason: 'end_turn' })));
    storage.blobs.set(`cursia-artifacts/${OTHER}/dynamic/x/1/llm-checkpoints/${it.id}/${foreign}.json`, Buffer.from('{"text":"secreto"}'));
    storage.blobs.set(`cursia-artifacts/${base}/${broken}.json`, Buffer.from('no-json'));
    const cps = {
      [good]: { path: `${base}/${good}.json`, at: '2026-10-14T21:50:00Z' },
      [foreign]: { path: `${OTHER}/dynamic/x/1/llm-checkpoints/${it.id}/${foreign}.json`, at: '2026-10-14T21:51:00Z' },
      [broken]: { path: `${base}/${broken}.json`, at: '2026-10-14T21:52:00Z' },
      [evil]: { path: `${base}/../../other/${evil}.json`, at: '2026-10-14T21:53:00Z' },
    };
    await ds.query(`update public.generation_item_runs set output_summary = jsonb_build_object('llmCheckpoints', $2::jsonb) where id = $1`, [it.id, JSON.stringify(cps)]);
    const fp = async () => ds.query(`select item_key, status, attempt_count, max_attempts, worker_id, lease_until, md5(coalesce(output_summary::text,'')) os, updated_at::text u from public.generation_item_runs where job_id = $1 order by item_key`, [C.runId]);
    const jobFp = async () => ds.query(`select status, worker_status, md5(coalesce(output_summary::text,'')) os, updated_at::text u, executor_lease_holder from public.production_jobs where id = $1`, [C.runId]);
    const before = [await fp(), await jobFp()];

    await check('claim: el payload es el MISMO que entrega claimNextItem (mismas claves y valores salvo lease/intento)', async () => {
      const d = await diag.forItem(C.runId, key);
      const real = await sched.claimNextItemDetailed({ runId: C.runId, executorId: 'w-diag', types: TYPES, leaseSeconds: 60, itemId: it.id });
      assert(real.item, 'claim real: ' + JSON.stringify(real).slice(0, 200));
      const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.attempt; delete c.leaseUntil; delete c.leaseSeconds; return c; };
      eq(Object.keys(d.claim).sort(), Object.keys(real.item).sort(), 'mismas claves');
      eq(strip(d.claim), strip(real.item), 'mismo payload');
      // Devolver el claim real (vuelve a pending): la prueba de solo-lectura se hace sobre forItem, no sobre el claim.
      await ds.query(`update public.generation_item_runs set status = 'pending', worker_id = null, lease_until = null, claimed_at = null, attempt_count = 0, updated_at = $2::timestamptz where id = $1`, [it.id, before[0].find((r) => r.item_key === key).u]);
      await ds.query(`update public.production_jobs set status = $2, worker_status = $3, updated_at = $4::timestamptz where id = $1`, [C.runId, before[1][0].status, before[1][0].worker_status, before[1][0].u]);
    });

    await check('checkpoints: los de ESTA parte se leen (texto, usage, stopReason) en orden; otro dueño / «..» → nunca se leen; ilegible → error por entrada', async () => {
      const d = await diag.forItem(C.runId, key);
      eq(d.checkpoints.map((c) => c.hash), [good, foreign, broken, evil], 'orden por at');
      eq([d.checkpoints[0].text, d.checkpoints[0].usage, d.checkpoints[0].stopReason], ['{"questions":[]}', { output_tokens: 12 }, 'end_turn'], 'leído');
      assert(d.checkpoints[1].text === null && /fuera de la parte/.test(d.checkpoints[1].error), 'otro dueño no se lee');
      assert(d.checkpoints[2].text === null && /ilegible/.test(d.checkpoints[2].error), 'ilegible');
      assert(d.checkpoints[3].text === null && /fuera de la parte/.test(d.checkpoints[3].error), '«..» no se lee');
      assert(!JSON.stringify(d).includes('secreto'), 'el contenido ajeno nunca aparece');
      eq([d.itemRunId, d.status, d.truncated], [it.id, 'pending', false], 'cabecera');
    });

    await check('SOLO LECTURA: forItem (×3) no cambia items ni el run (estado, intentos, lease, output_summary, updated_at)', async () => {
      for (let i = 0; i < 3; i++) await diag.forItem(C.runId, key);
      eq(await fp(), before[0], 'items idénticos');
      eq(await jobFp(), before[1], 'run idéntico');
    });

    await check('404: parte inexistente / run inexistente', async () => {
      let e1 = null; try { await diag.forItem(C.runId, 'content:no-existe'); } catch (e) { e1 = e; }
      assert(e1 && e1.getStatus() === 404, 'parte: ' + (e1 && e1.message));
      let e2 = null; try { await diag.forItem(crypto.randomUUID(), key); } catch (e) { e2 = e; }
      assert(e2 && e2.getStatus() === 404, 'run: ' + (e2 && e2.message));
    });

    await check('controlador: SupabaseJwtGuard + SuperAdminGuard (cualquier otro usuario → 403) y la ruta GET :runId/items/:itemKey/llm-diagnostics', async () => {
      const guards = Reflect.getMetadata('__guards__', AdminDynamicRunsController) || [];
      assert(guards.includes(SupabaseJwtGuard) && guards.includes(SuperAdminGuard), 'guards: ' + guards.map((g) => g.name).join());
      eq(Reflect.getMetadata('path', AdminDynamicRunsController.prototype.llmDiagnosticsOf), ':runId/items/:itemKey/llm-diagnostics', 'ruta');
    });
  } finally {
    try { storage.srv.close(); } catch {}
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
})().catch((err) => { console.error(`❌ fatal: ${err && err.stack ? err.stack : err}`); process.exit(1); });
