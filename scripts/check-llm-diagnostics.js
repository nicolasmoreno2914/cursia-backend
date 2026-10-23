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
const CONTEXT = { nombre: 'Curso diagnóstico', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };

const ENV_KEYS2 = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_GENERAL_AVAILABILITY', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION', 'DYNAMIC_VIDEO_DELIVERY',
  'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY', 'SUPER_ADMIN_EMAILS', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = L('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = L('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = L('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = L('modules/dynamic-generation/runs.service.js');
  const { SchedulerService } = L('modules/dynamic-generation/scheduler.service.js');
  const { ArtifactsService } = L('modules/artifacts/artifacts.service.js');
  const { Artifact } = L('modules/artifacts/entities/artifact.entity.js');
  const { LlmDiagnosticsService } = L('modules/dynamic-generation/llm-diagnostics.service.js');
  const { AdminDynamicRunsController } = L('modules/dynamic-generation/admin-runs.controller.js');
  const { SuperAdminGuard } = L('auth/super-admin.guard.js');
  const { SupabaseJwtGuard } = L('auth/supabase-jwt.guard.js');
  const AL = L('modules/reliability/attempt-log.js');
  const EL = L('modules/reliability/execution-lease.js');
  const F = L('modules/finops/index.js');
  const storage = startStorage();
  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-llmdiag-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-llmdiag-cwd-'));
  const ROLE = 'postgres.llmdiaglocal01';
  const DB = 'llmdiagdb';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS2.map((k) => [k, process.env[k]]));
  const restoreProviders = applyFakeProviderEnv();
  let ds = null;
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
    { const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({})); assert(res.code === 0, `migrate-production-jobs-constraints: ${res.out}`); }
    await withClient(DB, async (c) => { for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8')); });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js', 'scripts/migrate-v21-finops.js',
      'scripts/verify-v21-finops-schema.js', 'scripts/migrate-rel-recovery.js', 'scripts/migrate-rel-exec-lease.js', 'scripts/migrate-run-pause.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }
    await new Promise((res) => storage.srv.listen(0, '127.0.0.1', res));
    Object.assign(process.env, { DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_V2_GENERAL_AVAILABILITY: 'true', DYNAMIC_REAL_VIDEO_OWNERS: OWNER, DYNAMIC_MANIFEST_RULES_VERSION: '3', DYNAMIC_VIDEO_DELIVERY: 'youtube',
      DYNAMIC_PROVIDER_WORKER_ENABLED: 'true', VIDEOGEN_API_KEY: 'fake-videogen-key-never-used-no-network', SUPER_ADMIN_EMAILS: 'admin@cursia.test',
      SUPABASE_URL: `http://127.0.0.1:${storage.srv.address().port}`, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-local-only' });
    AL.resetRelSchemaCache(); EL.resetExecLeaseSchemaCache();
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 6 } });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const budget = new F.FinopsBudgetService(ds, new F.FinopsLedgerService(ds));
    const runs = new RunsService(ds, manifests, {}, { async check() { return { ok: true }; } }, budget);
    const sched = new SchedulerService(ds, runs);
    const diag = new LlmDiagnosticsService(ds, sched, new ArtifactsService(ds.getRepository(Artifact), { get: (k) => process.env[k] }));

    /** Curso v3 (1 módulo, 3 capítulos): todo completado salvo los 3 content y los video_interactions (pendientes). */
    async function makeCourse(title) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID(); const c3 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2({ id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: true, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'Válvulas', objective: null, video_enabled: false, activity_enabled: true },
          { id: c3, module_id: m1, position: 2, title: 'Sellos', objective: null, video_enabled: false, activity_enabled: true }]);
      for (const m of s2.modules) {
        await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
        for (const c of m.chapters) await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`, [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
      }
      await ds.query(`insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count) values ($1, 1, 2, $2::jsonb, $3, 0, 1, 3)`,
        [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      await manifests.getOrCreate(cid, OWNER, 1);
      let runId;
      try { runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id; } catch (err) {
        const body = err.getResponse ? err.getResponse() : null;
        assert(body && body.code === 'budget_approval_required', `startRun: ${err.message}`);
        await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test', reason: 'check llm-diagnostics' });
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      }
      const keys = [c1, c2, c3].map((c) => `content:${c}`);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and not (item_key = any($2::text[])) and type <> 'video_interactions'`, [runId, keys]);
      await ds.query(`update public.generation_item_runs set status = 'pending' where job_id = $1 and (item_key = any($2::text[]) or type = 'video_interactions')`, [runId, keys]);
      // Video completo con su entrega (lo que el claim de video_interactions necesita).
      const yt = 'IdwOipZAeqY';
      await ds.query(`update public.generation_item_runs set output_summary = $3::jsonb where job_id = $1 and item_key = $2`,
        [runId, `video:${c1}`, JSON.stringify({ mode: 'real', delivery: 'completed', youtubeVideoId: yt, youtubeUrl: `https://youtu.be/${yt}`, external: { durationSec: 468, videogenJobId: 'vg-1' } })]);
      // El video registra su duración medida en el artifact dynamic_video (lo que videoClaimFacts exige).
      const [vrow] = await ds.query(`select id, manifest_id, module_id, chapter_id from public.generation_item_runs where job_id = $1 and item_key = $2`, [runId, `video:${c1}`]);
      await ds.query(
        `insert into public.artifacts (owner_id, course_id, job_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, metadata, module_id, chapter_id, manifest_id, manifest_item_key, item_run_id)
         values ($1, $2, $3, 'dynamic_video', 'supabase', 'cursia-artifacts', $4, 'v.json', 'application/json', $5::jsonb, $6, $7, $8, $9, $10)`,
        [OWNER, String(cid), runId, `diag/${runId}/video`, JSON.stringify({ mode: 'real', durationSec: 468, youtubeVideoId: yt }), vrow.module_id, vrow.chapter_id, vrow.manifest_id, `video:${c1}`, vrow.id]);
      return { cid, c1, runId, keys };
    }
    const itemRow = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const fp = async (runId) => ds.query(`select item_key, status, attempt_count, max_attempts, worker_id, lease_until, md5(coalesce(output_summary::text,'')) os, updated_at::text u from public.generation_item_runs where job_id = $1 order by item_key`, [runId]);
    const jobFp = async (runId) => ds.query(`select status, worker_status, md5(coalesce(output_summary::text,'')) os, updated_at::text u, executor_lease_holder from public.production_jobs where id = $1`, [runId]);
    const cpPath = (it, hash, owner = OWNER) => `${owner}/dynamic/0679ca86-dcc2-4dee-b2cd-05c8d860c4e9/7/llm-checkpoints/${it.id}/${hash}.json`;
    const putCps = async (it, cps) => ds.query(`update public.generation_item_runs set output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('llmCheckpoints', $2::jsonb) where id = $1`, [it.id, JSON.stringify(cps)]);
    const h = (c) => c.repeat(64);

    await check('claim: el payload de claimPreview es IGUAL al de un claim real (content), salvo intento/lease — prompts idénticos', async () => {
      const C = await makeCourse('Diag claim');
      const previews = {};
      for (const k of C.keys) previews[k] = await diag.forItem(C.runId, k);
      const real = await sched.claimNextItemDetailed({ runId: C.runId, executorId: 'w-diag', types: ['content'], leaseSeconds: 60 });
      assert(real.item && C.keys.includes(real.item.itemKey), 'claim real: ' + JSON.stringify(real).slice(0, 200));
      const d = previews[real.item.itemKey];
      const it = await itemRow(C.runId, real.item.itemKey);
      const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.attempt; delete c.leaseUntil; delete c.leaseSeconds; return c; };
      eq(Object.keys(d.claim).sort(), Object.keys(real.item).sort(), 'mismas claves');
      eq(strip(d.claim), strip(real.item), 'mismo payload');
      assert(d.claim.attempt === real.item.attempt - 1, `intento: preview ${d.claim.attempt} = real ${real.item.attempt} - 1`);
      eq([d.itemRunId, d.status, d.checkpoints, d.truncated], [it.id, 'pending', [], false], 'sin checkpoints → lista vacía');
    });

    await check('review I1: video_interactions — claimPreview funciona en la transacción READ ONLY y NO registra la procedencia (sourceVideoItemRunId); el claim real sí', async () => {
      const C = await makeCourse('Diag video_interactions');
      const key = `video_interactions:${C.c1}`;
      // Sus dependencias (el Libro del capítulo) completas: así la parte es reclamable de verdad.
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and type = 'content'`, [C.runId]);
      const before = [await fp(C.runId), await jobFp(C.runId)];
      const d = await diag.forItem(C.runId, key);
      assert(d.claim && d.claim.itemKey === key && d.claim.claimPayload && d.claim.claimPayload.video, 'payload con el video: ' + String(JSON.stringify(d.claim && d.claim.claimPayload)).slice(0, 200));
      eq([await fp(C.runId), await jobFp(C.runId)], before, 'nada cambió (sin sourceVideoItemRunId)');
      const it = await itemRow(C.runId, key);
      const real = await sched.claimNextItemDetailed({ runId: C.runId, executorId: 'w-iv', types: ['video_interactions'], leaseSeconds: 60 });
      const after = await itemRow(C.runId, key); assert(real.item && after.output_summary && after.output_summary.sourceVideoItemRunId, 'el claim real sí registra la procedencia: ' + JSON.stringify({ real: real.item ? real.item.itemKey : real, os: after.output_summary, st: after.status }).slice(0, 400));
    });

    await check('checkpoints: los de ESTA parte se leen en orden (at, desempate por hash); otro dueño / otra parte / «..» / nombre ≠ hash → nunca se leen (Storage no se toca); ilegible → error por entrada', async () => {
      const C = await makeCourse('Diag checkpoints');
      const it = await itemRow(C.runId, C.keys[0]);
      const other = await itemRow(C.runId, C.keys[1]);
      const put = (p, body) => storage.blobs.set(`cursia-artifacts/${p}`, Buffer.from(body));
      put(cpPath(it, h('a')), JSON.stringify({ text: '{"questions":[1]}', usage: { output_tokens: 12 }, stopReason: 'end_turn' }));
      put(cpPath(it, h('b')), JSON.stringify({ text: 'B', usage: null, stopReason: 'max_tokens' }));
      put(cpPath(it, h('c')), 'no-json');
      put(cpPath(it, h('d'), OTHER), '{"text":"secreto-dueño"}');
      put(cpPath(other, h('e')), '{"text":"secreto-parte"}');
      await putCps(it, {
        [h('b')]: { path: cpPath(it, h('b')), at: '2026-10-14T21:50:00Z' },
        [h('a')]: { path: cpPath(it, h('a')), at: '2026-10-14T21:50:00Z' },
        [h('c')]: { path: cpPath(it, h('c')), at: '2026-10-14T21:51:00Z' },
        [h('d')]: { path: cpPath(it, h('d'), OTHER), at: '2026-10-14T21:52:00Z' },
        [h('e')]: { path: cpPath(other, h('e')), at: '2026-10-14T21:53:00Z' },
        [h('f')]: { path: cpPath(it, h('f')).replace(`${h('f')}.json`, `${h('a')}.json`), at: '2026-10-14T21:54:00Z' },
        [h('9')]: { path: cpPath(it, h('9')).replace('/llm-checkpoints/', '/llm-checkpoints/../'), at: '2026-10-14T21:55:00Z' },
      });
      const logBefore = storage.log.length;
      const d = await diag.forItem(C.runId, C.keys[0]);
      eq(d.checkpoints.map((c) => c.hash.slice(0, 1)), ['a', 'b', 'c', 'd', 'e', 'f', '9'], 'orden por at + hash');
      eq([d.checkpoints[0].text, d.checkpoints[0].usage, d.checkpoints[0].stopReason, d.checkpoints[1].stopReason], ['{"questions":[1]}', { output_tokens: 12 }, 'end_turn', 'max_tokens'], 'leídos');
      assert(/ilegible/.test(d.checkpoints[2].error), 'ilegible');
      for (const i of [3, 4, 5, 6]) assert(d.checkpoints[i].text === null && /fuera de la parte/.test(d.checkpoints[i].error), `rechazado ${i}`);
      const touched = storage.log.slice(logBefore).join('\n');
      assert(!touched.includes(OTHER) && !touched.includes(other.id) && !touched.includes('..'), 'Storage nunca se pidió para rutas ajenas: ' + touched.slice(0, 300));
      assert(!JSON.stringify(d).includes('secreto'), 'el contenido ajeno nunca aparece');
    });

    await check('review I2: ?hash= devuelve solo ese; ?limit=N los primeros N (truncated); tope de bytes → los siguientes omitidos con truncated', async () => {
      const C = await makeCourse('Diag límites');
      const it = await itemRow(C.runId, C.keys[0]);
      const cps = {};
      for (const ch of ['1', '2', '3', '4']) {
        storage.blobs.set(`cursia-artifacts/${cpPath(it, h(ch))}`, Buffer.from(JSON.stringify({ text: ch.repeat(1000) })));
        cps[h(ch)] = { path: cpPath(it, h(ch)), at: `2026-10-14T21:5${ch}:00Z` };
      }
      await putCps(it, cps);
      const one = await diag.forItem(C.runId, C.keys[0], { hash: h('3') });
      eq([one.checkpoints.length, one.checkpoints[0].hash, one.truncated], [1, h('3'), false], 'hash');
      const lim = await diag.forItem(C.runId, C.keys[0], { limit: 2 });
      eq([lim.checkpoints.map((c) => c.hash.slice(0, 1)), lim.truncated], [['1', '2'], true], 'limit');
      const small = await diag.forItem(C.runId, C.keys[0], { maxBytes: 1500 });
      assert(small.truncated && small.checkpoints.filter((c) => c.text).length < 4 && small.checkpoints.some((c) => /tope de bytes/.test(c.error || '')), 'tope de bytes: ' + JSON.stringify(small.checkpoints.map((c) => [c.hash.slice(0, 1), !!c.text, c.error])));
    });

    await check('SOLO LECTURA: forItem (×3, con checkpoints) no cambia items ni el run (estado, intentos, lease, output_summary, updated_at)', async () => {
      const C = await makeCourse('Diag solo lectura');
      const it = await itemRow(C.runId, C.keys[0]);
      storage.blobs.set(`cursia-artifacts/${cpPath(it, h('7'))}`, Buffer.from('{"text":"ok"}'));
      await putCps(it, { [h('7')]: { path: cpPath(it, h('7')), at: '2026-10-14T21:50:00Z' } });
      const before = [await fp(C.runId), await jobFp(C.runId)];
      for (let i = 0; i < 3; i++) await diag.forItem(C.runId, C.keys[0]);
      eq([await fp(C.runId), await jobFp(C.runId)], before, 'idénticos');
    });

    await check('404: parte inexistente / run inexistente', async () => {
      const C = await makeCourse('Diag 404');
      let e1 = null; try { await diag.forItem(C.runId, 'content:no-existe'); } catch (e) { e1 = e; }
      assert(e1 && e1.getStatus() === 404, 'parte: ' + (e1 && e1.message));
      let e2 = null; try { await diag.forItem(crypto.randomUUID(), C.keys[0]); } catch (e) { e2 = e; }
      assert(e2 && e2.getStatus() === 404, 'run: ' + (e2 && e2.message));
    });

    await check('acceso: SupabaseJwtGuard + SuperAdminGuard en el controlador; SuperAdminGuard rechaza (403) a un usuario que no es SUPER_ADMIN y deja pasar al admin; ruta GET :runId/items/:itemKey/llm-diagnostics', async () => {
      const guards = Reflect.getMetadata('__guards__', AdminDynamicRunsController) || [];
      assert(guards.includes(SupabaseJwtGuard) && guards.includes(SuperAdminGuard), 'guards: ' + guards.map((g) => g.name).join());
      eq(Reflect.getMetadata('path', AdminDynamicRunsController.prototype.llmDiagnosticsOf), ':runId/items/:itemKey/llm-diagnostics', 'ruta');
      const g = new SuperAdminGuard();
      const ctx = (user) => ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) });
      let denied = null;
      try { await g.canActivate(ctx({ id: OWNER, email: 'owner@cursia.test' })); } catch (e) { denied = e; }
      assert(denied && denied.getStatus && denied.getStatus() === 403, 'dueño no admin → 403: ' + (denied && denied.message));
      assert(await g.canActivate(ctx({ id: 'a', email: 'admin@cursia.test' })), 'SUPER_ADMIN pasa');
    });
  } finally {
    try { if (ds) await ds.destroy(); } catch {}
    try { storage.srv.close(); } catch {}
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
