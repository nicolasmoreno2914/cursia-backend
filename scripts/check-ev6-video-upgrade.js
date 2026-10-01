#!/usr/bin/env node
/* eslint-disable */
// Cursia EV6 — T5 fase B2: «Generar videos reales» (upgrade de los videos de vista previa del run).
//
// PG16 DESECHABLE (puerto libre ≠ 5570 y ≠ 8099, dir temporal que se destruye) con el esquema real
// (mismas migraciones que check-v21-finops-wiring.js); RunsService / FinOps / worker de items
// COMPILADOS con Videogen y YouTube FALSOS (0 red, 0 gasto real). Cubre:
//  - vista previa SOLO lectura: exactamente los videos pendientes del run + sus interacciones,
//    estimado USD de eso (videos + IA), huella, aprobación (SUPER_ADMIN), trabas;
//  - gates: allow-list de video real, rol de aprobación, YouTube, run no terminado, nada pendiente,
//    rulesVersion, política BLOCK / tope, ruling 6 (mock dentro de un run real sin upgrade);
//  - confirmación: huella vieja → 409 sin escribir; OK → UNA tx con aprobación (estimado scope
//    regeneration + ADMIN_APPROVED del run = gasto real + monto) + generaciones nuevas SOLO de los
//    videos pendientes y sus interacciones + upgrade del run (videoMode real, original, videoUpgrade);
//  - idempotencia: misma huella / otra huella / dos confirmaciones SIMULTÁNEAS → un solo upgrade;
//  - flujo falso mock→real: el worker real envía a Videogen (fake) en modo REAL, publica en YouTube
//    (fake), cargos en el ledger del run SOLO de los videos del upgrade; el run vuelve a completed
//    y el precheck del paquete pasa; un video del upgrade que falla para siempre deja el run failed
//    pero empaquetable (§2.6).
//
// Usage: node scripts/check-ev6-video-upgrade.js   (npm run build antes)

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
const ADMIN = { id: OWNER, email: 'Admin@Cursia.test' };
const NOT_ADMIN = { id: OWNER, email: 'owner@cursia.test' };
const ENV_KEYS = [
  'DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'VIDEOGEN_API_KEY', 'ALLOW_UNOWNED_COURSES',
  'DYNAMIC_PROVIDER_WORKER_ENABLED', 'DYNAMIC_ALLOW_PROVIDER_MOCK', 'SUPER_ADMIN_EMAILS', 'DYNAMIC_ALLOW_VIDEO_PREVIEW',
];

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
  const { PackagingService } = L('modules/dynamic-packaging/packaging.service.js');
  const { mergeOutputSummary } = L('modules/dynamic-generation/scheduler.service.js');
  const VU = L('modules/dynamic-generation/video-upgrade.js');
  const itemWorker = L('workers/dynamic-item-worker.js');
  const { syntheticMp4WithMvhd } = require(path.join(REPO, 'test/e2e-v2/fakes.js'));

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-ev6-b2-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-ev6-b2-cwd-'));
  const ROLE = 'postgres.ev6b2localtest01';
  const DB = 'ev6b2db';
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
    const packaging = new PackagingService(ds, manifests, {});

    const coursePolicy = (cid, limits, onExceed = 'ADMIN_APPROVAL') => ds.query(
      `insert into public.cost_budget_policies (scope, scope_id, version, limits, on_exceed) values ('course', $1, 1, $2::jsonb, $3)`,
      [String(cid), JSON.stringify(limits), onExceed]);
    const counts = async (cid) => {
      const [g] = await ds.query(`select count(*)::int n from public.generation_item_runs where course_id = $1`, [cid]);
      const [e] = await ds.query(`select count(*)::int n from public.cost_estimates where course_id = $1`, [cid]);
      const [a] = await ds.query(`select count(*)::int n from public.cost_budget_authorizations where course_id = $1`, [cid]);
      return { gens: g.n, estimates: e.n, auths: a.n };
    };
    const latest = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const jobOf = async (runId) => (await ds.query(`select * from public.production_jobs where id = $1`, [runId]))[0];

    /** Curso v3 (2 capítulos con video, 1 con actividad) con un run de VISTA PREVIA completado. */
    async function previewCourse(title, { policy = { maxCostPerRun: '1000', maxCostPerCourse: '1000', monthlyCap: '1000000000' } } = {}) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID();
      const c1 = crypto.randomUUID();
      const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'C1', objective: null, video_enabled: true, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'C2', objective: null, video_enabled: true, activity_enabled: false }],
      );
      for (const m of s2.modules) {
        await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
        for (const c of m.chapters) {
          await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled)
                          values ($1, $2, $3, $4, $5, $6, $7)`, [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
        }
      }
      await ds.query(
        `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, 2, $2::jsonb, $3, 0, 1, 2)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      const mf = await manifests.getOrCreate(cid, OWNER, 1);
      if (policy) await coursePolicy(cid, policy);
      const res = await runs.startRun(cid, OWNER, 1, MOCK_CTX);
      const runId = res.run.id;
      // Vista previa completada: todas las partes listas; los videos con el publicador simulado (mode mock).
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1`, [runId]);
      // EV6 DoD (BE-A): este check prueba los VIDEOS. El resto del curso es el de un run comercial: Gamma/TTS
      // congelados reales (se crean por el camino QA para no gastar; nada los re-ejecuta) y los tipos v3 que el
      // servidor valida llevan su v3Validation. Así, tras el upgrade, el run queda `completed` solo por sus videos.
      await ds.query(`update public.production_jobs set input_payload = input_payload || '{"providerModes":{"presentation":"real","audio":"real"}}'::jsonb where id = $1`, [runId]);
      await ds.query(`update public.generation_item_runs set output_summary = output_summary || $2::jsonb
                       where job_id = $1 and type in ('course_intro', 'module_intro', 'experience', 'video_interactions', 'activity', 'exam', 'final_exam')`,
        [runId, JSON.stringify({ v3Validation: { artifactType: 'fixture', artifactId: crypto.randomUUID(), contentSha256: 'x'.repeat(64) } })]);
      for (const c of [c1, c2]) {
        await ds.query(`update public.generation_item_runs set output_summary = output_summary || $2::jsonb where job_id = $1 and item_key = $3`,
          [runId, JSON.stringify({ mode: 'mock', delivery: 'completed', youtubeVideoId: 'MockMockM' + c.slice(0, 2), external: { durationSec: 468 } }), `video:${c}`]);
      }
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now() where id = $1`, [runId]);
      return { cid, c1, c2, m1, runId, manifest: mf.manifest };
    }

    // ════ Vista previa ════════════════════════════════════════════════════
    const A = await previewCourse('Curso B2 A');
    let pvA = null;
    await check('vista previa: SOLO los videos pendientes del run + sus interacciones; estimado USD de exactamente eso (videos + IA); aprobación por SUPER_ADMIN; huella; NO escribe nada', async () => {
      const before = await counts(A.cid);
      pvA = await runs.previewVideoUpgrade(A.cid, ADMIN, 1, A.runId);
      eq(pvA.pendingVideos.map((p) => [p.itemKey, p.generation]).sort(), [[`video:${A.c1}`, 1], [`video:${A.c2}`, 1]].sort(), 'videos pendientes');
      eq(pvA.interactions.map((p) => p.itemKey).sort(), [`video_interactions:${A.c1}`, `video_interactions:${A.c2}`].sort(), 'interacciones');
      eq(pvA.blockers, [], 'sin trabas');
      eq([pvA.eligible, pvA.upgrade], [true, null], 'elegible');
      eq(Object.keys(pvA.estimate.byItemType).sort(), ['video', 'video_interactions'], 'el estimado cubre SOLO videos e interacciones');
      assert(dec(pvA.estimate.byCategory.videos.expected) > 0 && dec(pvA.estimate.byCategory.content.expected) > 0, 'videos + IA');
      eq(dec(pvA.estimate.byCategory.presentations?.expected ?? 0) + dec(pvA.estimate.byCategory.audio?.expected ?? 0), 0, 'nada de Gamma/TTS');
      eq([pvA.approval.required, pvA.approval.canApprove, pvA.approval.withinPolicy, pvA.approval.existing], [true, true, true, null], 'aprobación');
      assert(dec(pvA.approval.amount) >= dec(pvA.estimate.expected), 'monto cubre el esperado');
      assert(/^[0-9a-f]{64}$/.test(pvA.estimateHash), 'huella');
      eq(await counts(A.cid), before, 'sin escrituras');
      // EV6 DoD (BE-A, R5): «Generar videos reales» es herramienta de admin → la vista previa también es 403 a un no admin.
      await rejectsRe(runs.previewVideoUpgrade(A.cid, NOT_ADMIN, 1, A.runId), /admin_recovery_only/, 'sin rol no ve el estimado', 403);
    });

    await check('confirmación sin rol de administrador → 403 approval_forbidden; nada escrito', async () => {
      const before = await counts(A.cid);
      await rejectsRe(runs.confirmVideoUpgrade(A.cid, NOT_ADMIN, 1, A.runId, pvA.estimateHash), /approval_forbidden/, 'sin rol', 403);
      eq(await counts(A.cid), before, 'nada escrito');
      eq((await jobOf(A.runId)).input_payload.videoMode, 'mock', 'run intacto');
    });

    await check('allow-list de video real (realVideo): owner fuera de DYNAMIC_REAL_VIDEO_OWNERS → traba en la vista previa y 403 al confirmar; nada escrito', async () => {
      process.env.DYNAMIC_REAL_VIDEO_OWNERS = OTHER;
      try {
        const pv = await runs.previewVideoUpgrade(A.cid, ADMIN, 1, A.runId);
        assert(pv.blockers.some((b) => b.code === 'real_video_not_allowed') && pv.eligible === false, JSON.stringify(pv.blockers));
        const before = await counts(A.cid);
        await rejectsRe(runs.confirmVideoUpgrade(A.cid, ADMIN, 1, A.runId, pv.estimateHash), /video real/i, 'no habilitado', 403);
        eq(await counts(A.cid), before, 'nada escrito');
      } finally {
        process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
      }
    });

    await check('YouTube no conectado → traba youtube_preflight_failed y 409 al confirmar, ANTES de escribir', async () => {
      ytState.ok = false;
      try {
        const pv = await runs.previewVideoUpgrade(A.cid, ADMIN, 1, A.runId);
        assert(pv.blockers.some((b) => /youtube_preflight_failed/.test(b.code)), JSON.stringify(pv.blockers));
        const before = await counts(A.cid);
        await rejectsRe(runs.confirmVideoUpgrade(A.cid, ADMIN, 1, A.runId, pv.estimateHash), /youtube_preflight_failed/, 'sin YouTube', 409);
        eq(await counts(A.cid), before, 'nada escrito');
      } finally {
        ytState.ok = true;
      }
    });

    await check('huella vieja / ajena → 409 estimate_stale con el estimado vigente; nada escrito', async () => {
      const before = await counts(A.cid);
      const err = await rejectsRe(runs.confirmVideoUpgrade(A.cid, ADMIN, 1, A.runId, 'f'.repeat(64)), /estimate_stale/, 'huella vieja', 409);
      eq(err.getResponse().preview.estimateHash, pvA.estimateHash, 'devuelve el vigente');
      assert(!('_blockers' in err.getResponse().preview), 'sin internos');
      eq(await counts(A.cid), before, 'nada escrito');
    });

    // ════ Confirmación ════════════════════════════════════════════════════
    let upA = null;
    await check('confirmación OK → UNA tx: estimado (regeneration, run) + ADMIN_APPROVED del run = gasto real + monto; generación 2 SOLO de los 2 videos y sus 2 interacciones; run real (original mock) y reabierto', async () => {
      const before = await counts(A.cid);
      const actual = await budget.runActual(A.runId);
      const res = await runs.confirmVideoUpgrade(A.cid, ADMIN, 1, A.runId, pvA.estimateHash);
      eq(res.created, true, 'creado');
      upA = res.upgrade;
      const after = await counts(A.cid);
      eq([after.gens - before.gens, after.estimates - before.estimates, after.auths - before.auths], [4, 1, 1], 'escrituras');
      const newGens = await ds.query(`select item_key, generation, status, output_summary from public.generation_item_runs where job_id = $1 and generation > 1 order by item_key`, [A.runId]);
      eq(newGens.map((g) => [g.item_key, g.generation, g.status]).sort(), [
        [`video:${A.c1}`, 2, 'pending'], [`video:${A.c2}`, 2, 'pending'],
        [`video_interactions:${A.c1}`, 2, 'pending'], [`video_interactions:${A.c2}`, 2, 'pending'],
      ].sort(), 'solo videos + interacciones');
      for (const g of newGens) {
        const reg = g.output_summary.regeneration;
        eq(reg.upgradeId, upA.id, 'upgradeId');
        eq(reg.reason, g.item_key.startsWith('video:') ? 'video_upgrade' : 'cascade_from_video', 'motivo');
      }
      const job = await jobOf(A.runId);
      eq([job.input_payload.videoMode, job.input_payload.videoModeOriginal, job.input_payload.videoUpgrade.id, job.worker_status], ['real', 'mock', upA.id, 'queued'], 'run');
      eq(job.input_payload.videoUpgrade.itemKeys, [`video:${A.c1}`, `video:${A.c2}`].sort(), 'items del upgrade');
      const [auth] = await ds.query(`select * , authorized_budget::text as b from public.cost_budget_authorizations where id = $1`, [upA.authorizationId]);
      eq([auth.run_id, auth.decision, auth.approved_by, auth.reason], [A.runId, 'ADMIN_APPROVED', 'Admin@Cursia.test', `video_upgrade:${pvA.estimateHash}`], 'autorización');
      eq(dec(auth.b), dec(actual) + dec(upA.amount), 'presupuesto del run = gasto real + monto');
      eq(dec(await budget.runPaidAuthorizedBudget(A.runId)), dec(auth.b), 'el runtime guard la usa');
      const [est] = await ds.query(`select scope, run_id, lines from public.cost_estimates where id = $1`, [upA.estimateId]);
      eq([est.scope, est.run_id], ['regeneration', A.runId], 'estimado');
      eq([...new Set(est.lines.map((l) => l.itemType))].sort(), ['video', 'video_interactions'], 'líneas del estimado');
      eq(res.run.videoMode, 'real', 'DTO');
      eq([res.run.videoModeOriginal, res.run.videoUpgrade.id], ['mock', upA.id], 'DTO upgrade');
    });

    await check('idempotencia: repetir con la MISMA huella (doble clic / reintento tras timeout) o con OTRA → created:false, mismo upgrade, nada escrito', async () => {
      const before = await counts(A.cid);
      const again = await runs.confirmVideoUpgrade(A.cid, ADMIN, 1, A.runId, pvA.estimateHash);
      eq([again.created, again.upgrade.id], [false, upA.id], 'misma huella');
      const other = await runs.confirmVideoUpgrade(A.cid, ADMIN, 1, A.runId, 'a'.repeat(64));
      eq([other.created, other.upgrade.id], [false, upA.id], 'otra huella (otra pestaña)');
      eq(await counts(A.cid), before, 'nada escrito');
      const pv = await runs.previewVideoUpgrade(A.cid, ADMIN, 1, A.runId);
      eq([pv.upgrade && pv.upgrade.id, pv.eligible, pv.estimate], [upA.id, false, null], 'la vista previa devuelve el upgrade');
    });

    await check('dos confirmaciones SIMULTÁNEAS (dos pestañas) → UN upgrade, UNA aprobación, 4 generaciones (lock del curso + FOR UPDATE)', async () => {
      const Q = await previewCourse('Curso B2 concurrente');
      const pv = await runs.previewVideoUpgrade(Q.cid, ADMIN, 1, Q.runId);
      const before = await counts(Q.cid);
      const [r1, r2] = await Promise.all([
        runs.confirmVideoUpgrade(Q.cid, ADMIN, 1, Q.runId, pv.estimateHash),
        runs.confirmVideoUpgrade(Q.cid, ADMIN, 1, Q.runId, pv.estimateHash),
      ]);
      eq([r1.created, r2.created].sort(), [false, true], 'uno creado, otro existente');
      eq(r1.upgrade.id, r2.upgrade.id, 'mismo upgrade');
      const after = await counts(Q.cid);
      eq([after.gens - before.gens, after.estimates - before.estimates, after.auths - before.auths], [4, 1, 1], 'un solo juego');
    });

    // ════ Trabas ══════════════════════════════════════════════════════════
    await check('traba: run no terminado (activo) → video_upgrade_run_not_ready (vista previa y 409 al confirmar)', async () => {
      const R = await previewCourse('Curso B2 activo');
      await ds.query(`update public.production_jobs set status = 'running', worker_status = 'running' where id = $1`, [R.runId]);
      const pv = await runs.previewVideoUpgrade(R.cid, ADMIN, 1, R.runId);
      assert(pv.blockers.some((b) => b.code === VU.VIDEO_UPGRADE_RUN_NOT_READY), JSON.stringify(pv.blockers));
      await rejectsRe(runs.confirmVideoUpgrade(R.cid, ADMIN, 1, R.runId, pv.estimateHash || 'b'.repeat(64)), /video_upgrade_run_not_ready/, 'activo', 409);
    });

    await check('ruling 6: run REAL sin upgrade con un video de vista previa → video_mode_inconsistent (vista previa, confirmación 409 y empaquetado), nunca «pendiente»', async () => {
      const I = await previewCourse('Curso B2 inconsistente');
      await ds.query(`update public.production_jobs set input_payload = input_payload || '{"videoMode":"real"}'::jsonb where id = $1`, [I.runId]);
      const pv = await runs.previewVideoUpgrade(I.cid, ADMIN, 1, I.runId);
      assert(pv.blockers.some((b) => b.code === VU.VIDEO_MODE_INCONSISTENT) && pv.pendingVideos.length === 0, JSON.stringify(pv.blockers));
      await rejectsRe(runs.confirmVideoUpgrade(I.cid, ADMIN, 1, I.runId, 'c'.repeat(64)), /video_mode_inconsistent/, 'confirmación', 409);
    });

    await check('traba: Manifest rulesVersion ≠ 3 → el planificador rechaza (video_upgrade_rules_version_unsupported) sin leer videos', async () => {
      const job = await jobOf(A.runId);
      const plan = await runs.planVideoUpgrade(ds, false, A.cid, OWNER, job, { id: 1, rulesVersion: 2, manifest: { items: [] } });
      eq([plan.blockers.map((b) => b.code), plan.pending.length], [[VU.VIDEO_UPGRADE_NOT_ALLOWED_RULES], 0], 'rechazo');
    });

    await check('traba: política del curso BLOCK → aprobación fuera de política (budget_blocked al confirmar, nada escrito)', async () => {
      const Bk = await previewCourse('Curso B2 bloqueado', { policy: null });
      await coursePolicy(Bk.cid, { maxCostPerRun: '0.0001' }, 'BLOCK');
      const pv = await runs.previewVideoUpgrade(Bk.cid, ADMIN, 1, Bk.runId);
      eq(pv.approval.withinPolicy, false, 'fuera de política');
      const before = await counts(Bk.cid);
      await rejectsRe(runs.confirmVideoUpgrade(Bk.cid, ADMIN, 1, Bk.runId, pv.estimateHash), /budget_blocked/, 'bloqueado', 409);
      eq(await counts(Bk.cid), before, 'nada escrito');
    });

    await check('tope mensual: gasto nuevo del mes entre la vista previa y la confirmación → huella vieja (409 estimate_stale), nada escrito', async () => {
      const Mo = await previewCourse('Curso B2 mes');
      const pv = await runs.previewVideoUpgrade(Mo.cid, ADMIN, 1, Mo.runId);
      // Gasto nuevo del curso (otro cargo de Videogen, por el ledger real) entre la vista previa y la confirmación.
      const content = await latest(Mo.runId, `content:${Mo.c1}`);
      await L('workers/finops-worker-hooks.js').recordVideogenCharge(ledger, { ownerId: OWNER, itemRunId: content.id, jobId: 'vg_extra_' + crypto.randomUUID().slice(0, 8), mode: 'real', cost: 0.5 });
      const before = await counts(Mo.cid);
      await rejectsRe(runs.confirmVideoUpgrade(Mo.cid, ADMIN, 1, Mo.runId, pv.estimateHash), /estimate_stale/, 'gasto nuevo', 409);
      eq(await counts(Mo.cid), before, 'nada escrito');
      const pv2 = await runs.previewVideoUpgrade(Mo.cid, ADMIN, 1, Mo.runId);
      eq((await runs.confirmVideoUpgrade(Mo.cid, ADMIN, 1, Mo.runId, pv2.estimateHash)).created, true, 'con la huella nueva sí');
    });

    // ════ Flujo falso mock → real (worker real, Videogen/YouTube falsos) ═══
    const workerLog = { log() {}, warn() {}, error(m) { workerLog.errors.push(m); }, errors: [] };
    const patchSummary = async (id, patch) => {
      const [row] = await ds.query(`select output_summary from public.generation_item_runs where id = $1`, [id]);
      const m = mergeOutputSummary(row.output_summary || {}, patch);
      if (!m.ok) return false;
      await ds.query(`update public.generation_item_runs set output_summary = $2::jsonb where id = $1`, [id, JSON.stringify(m.merged)]);
      return true;
    };
    function dbScheduler() {
      const st = { failed: [], completed: [] };
      return {
        st,
        async heartbeatItem() { return true; },
        async recordItemExternal(id, _e, patch) { return patchSummary(id, patch); },
        async failItem(id, _e, msg, retryable) {
          st.failed.push({ id, msg, retryable });
          await ds.query(`update public.generation_item_runs set status = 'failed', error = $2, finished_at = now() where id = $1`, [id, msg]);
          return true;
        },
        async completeItem(id, _e, payload) {
          st.completed.push({ id, payload });
          await patchSummary(id, payload.summary || {});
          await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now(), output_summary = coalesce(output_summary, '{}'::jsonb) || '{"v3Validation":{"artifactType":"fixture"}}'::jsonb where id = $1`, [id]);
          return true;
        },
        async blockItemForBudget(id, _e, msg) { st.failed.push({ id, msg, blocked: true }); return true; },
      };
    }
    function fakeVideogen() {
      const st = { submits: 0 };
      return {
        st,
        async batchCreate() { st.submits++; return { batch_id: 'b_' + st.submits, jobs: [{ job_id: `vg_up_${st.submits}_${crypto.randomUUID().slice(0, 8)}` }] }; },
        async getVideoStatus(id) { return { job_id: id, status: 'completed_local', download_url: 'https://fake-videogen.invalid/x.mp4', progress: 100, error: null }; },
        async getVideoCost() { return { estimated_total_cost: 0.97 }; },
      };
    }
    const mp4 = syntheticMp4WithMvhd(300);
    const yt = { uploads: 0 };
    const publisher = {
      async getConnection(ownerId) { return { userId: ownerId, status: 'active', scopes: 'youtube.upload,youtube.readonly' }; },
      async getAccessToken() { return 'tok'; },
      async uploadFromUrl(_c, options) {
        yt.uploads++;
        if (options.onBeforeUpload) await options.onBeforeUpload(mp4);
        const id = ('RealVid' + yt.uploads + 'xxxxxxxx').slice(0, 11);
        return { videoId: id, youtubeUrl: `https://www.youtube.com/watch?v=${id}` };
      },
    };
    const claim = async (runId, key, chapterId) => {
      const row = await latest(runId, key);
      return {
        itemRunId: row.id, runId, itemKey: row.item_key, type: 'video', idempotencyKey: row.idempotency_key, attempt: 1,
        chapterId, chapterNumber: 1, manifestId: row.manifest_id, artifactCourseId: String(row.course_id), generation: row.generation,
        blueprint: { course: { id: row.course_id, title: 'Curso' }, chapter: { title: 'C' } },
        dependencyArtifacts: [{ type: 'dynamic_content_md', artifactId: 'content-art' }], outputSummary: row.output_summary || {},
      };
    };
    const deps = (s, vg) => ({
      scheduler: s, dataSource: ds, videogen: vg, logger: workerLog, executorId: 'w-ev6b2', leaseSeconds: 60, heartbeatMs: 600000,
      videoTimeoutMin: 1, videoPollMs: 5, mockScenario: 'success', mockResolvePolls: 1, youtube: publisher,
      youtubeUploadRetryBaseMs: 1, fetchMp4: async () => mp4,
      artifacts: { async getDownloadUrl() { return { url: 'data:text/plain,Contenido' }; }, async uploadJsonArtifact() { return { id: 'art-' + crypto.randomUUID() }; } },
      finops: ledger, budget,
    });
    const chargesOf = (runId) => ds.query(
      `select item_key, provider, event_kind, amount::text as amount, cost_source, metadata from public.generation_cost_events where run_id = $1 order by created_at, id`, [runId]);

    await check('flujo falso mock→real: el worker REAL envía cada video del upgrade a Videogen (fake) en modo REAL, lo publica en YouTube (fake) y lo completa con mode real; ledger del run con cargos SOLO de esos videos', async () => {
      const vg = fakeVideogen();
      for (const c of [A.c1, A.c2]) {
        const s = dbScheduler();
        await itemWorker.processItem(deps(s, vg), await claim(A.runId, `video:${c}`, c));
        eq([s.st.failed.length, s.st.completed.length], [0, 1], `video ${c}: ${JSON.stringify(s.st.failed)} ${workerLog.errors.join(' | ')}`);
        const row = await latest(A.runId, `video:${c}`);
        eq([row.generation, row.status, row.output_summary.mode, !!row.output_summary.youtubeVideoId], [2, 'completed', 'real', true], 'generación 2 real');
      }
      eq([vg.st.submits, yt.uploads], [2, 2], 'dos envíos a Videogen, dos subidas');
      const ev = await chargesOf(A.runId);
      const vgEv = ev.filter((e) => e.provider === 'videogen');
      assert(vgEv.length > 0 && vgEv.every((e) => e.item_key.startsWith('video:')), `cargos de Videogen solo de videos: ${JSON.stringify(vgEv.map((e) => e.item_key))}`);
      const finals = vgEv.filter((e) => e.event_kind === 'CHARGE' && e.metadata?.reservation !== true && e.metadata?.reservation !== 'true');
      eq(finals.length, 2, 'un cargo final por video');
      assert(finals.every((e) => e.cost_source === 'CALCULATED_FROM_USAGE' && Math.abs(dec(e.amount) - 0.97) < 1e-9), JSON.stringify(finals));
      assert(ev.filter((e) => e.provider === 'youtube').length >= 2, 'publicación en YouTube registrada (ZERO_BY_DESIGN + cuota)');
      assert(!ev.some((e) => ['gamma', 'openai'].includes(e.provider)), 'nada de Gamma/TTS re-facturado');
    });

    await check('flujo falso: interacciones listas (ejecutor del navegador) → run completed; el precheck del paquete pasa (videos reales publicados, sin pendientes)', async () => {
      for (const c of [A.c1, A.c2]) {
        const row = await latest(A.runId, `video_interactions:${c}`);
        await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now(), output_summary = coalesce(output_summary, '{}'::jsonb) || '{"v3Validation":{"artifactType":"fixture"}}'::jsonb where id = $1`, [row.id]);
      }
      await runs.tx((qr) => L('modules/dynamic-generation/item-transitions.js').recomputeRunStatus(qr, A.runId));
      const job = await jobOf(A.runId);
      eq(job.worker_status, 'completed', 'run completed');
      await packaging.assertRunReady(job, { rulesVersion: 3, manifest: A.manifest.manifest ?? A.manifest }, { email: ADMIN.email });
      const pv = await runs.previewVideoUpgrade(A.cid, ADMIN, 1, A.runId);
      eq([pv.upgrade.id, pv.eligible], [upA.id, false], 'sigue el mismo upgrade; nada más que generar');
      const before = await counts(A.cid);
      eq((await runs.confirmVideoUpgrade(A.cid, ADMIN, 1, A.runId, pvA.estimateHash)).created, false, 'tras terminar, otra confirmación no paga nada');
      eq(await counts(A.cid), before, 'nada escrito');
    });

    await check('§2.6: un video del upgrade que falla para siempre → run failed PERO empaquetable (ese capítulo queda pendiente); un fallo AJENO al upgrade sigue bloqueando', async () => {
      const D = await previewCourse('Curso B2 degradado');
      const pv = await runs.previewVideoUpgrade(D.cid, ADMIN, 1, D.runId);
      await runs.confirmVideoUpgrade(D.cid, ADMIN, 1, D.runId, pv.estimateHash);
      const vg = fakeVideogen();
      const s1 = dbScheduler();
      await itemWorker.processItem(deps(s1, vg), await claim(D.runId, `video:${D.c1}`, D.c1));
      const v2 = await latest(D.runId, `video:${D.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'videogen_failed: definitivo' where id = $1`, [v2.id]);
      const i2 = await latest(D.runId, `video_interactions:${D.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'blocked' where id = $1`, [i2.id]);
      const i1 = await latest(D.runId, `video_interactions:${D.c1}`);
      await ds.query(`update public.generation_item_runs set status = 'completed', output_summary = coalesce(output_summary, '{}'::jsonb) || '{"v3Validation":{"artifactType":"fixture"}}'::jsonb where id = $1`, [i1.id]);
      await runs.tx((qr) => L('modules/dynamic-generation/item-transitions.js').recomputeRunStatus(qr, D.runId));
      const job = await jobOf(D.runId);
      eq(job.worker_status, 'failed', 'run failed');
      eq(await VU.runIsUpgradeOnlyFailure(ds, job), true, 'fallo solo del upgrade');
      await packaging.assertRunReady(job, { rulesVersion: 3, manifest: D.manifest.manifest ?? D.manifest }, { email: ADMIN.email });
      // Un fallo de OTRA parte (no del upgrade) sigue bloqueando el paquete.
      const content = await latest(D.runId, `content:${D.c1}`);
      await ds.query(`update public.generation_item_runs set status = 'failed' where id = $1`, [content.id]);
      eq(await VU.runIsUpgradeOnlyFailure(ds, job), false, 'fallo ajeno');
      await rejectsRe(packaging.assertRunReady(job, { rulesVersion: 3, manifest: D.manifest.manifest ?? D.manifest }, { email: ADMIN.email }), /no está lista para empaquetar/, 'bloquea', 409);
    });

    await check('puro: huella del upgrade estable (orden de items irrelevante) y sensible a generación / monto / gasto del run; isUpgradeOnlyFailure exige upgrade + run failed + solo items del upgrade terminados con generación completada previa', async () => {
      const base = { runId: 'r', manifestId: 1, pending: [{ itemKey: 'video:b', generation: 1 }, { itemKey: 'video:a', generation: 1 }], interactions: [],
        modes: { video: 'real' }, estimate: { totals: { expected: '1' } }, policyId: null, plan: { amount: '2', withinPolicy: true }, courseSpent: '0', runActual: '0', runPaidAuthorized: null };
      const h = VU.videoUpgradeFingerprint(base);
      eq(VU.videoUpgradeFingerprint({ ...base, pending: [...base.pending].reverse() }), h, 'orden');
      for (const mut of [{ pending: [{ itemKey: 'video:a', generation: 2 }, { itemKey: 'video:b', generation: 1 }] }, { plan: { amount: '3', withinPolicy: true } }, { runActual: '0.5' }, { courseSpent: '1' }]) {
        assert(VU.videoUpgradeFingerprint({ ...base, ...mut }) !== h, `cambia con ${JSON.stringify(mut)}`);
      }
      const run = { worker_status: 'failed', input_payload: { videoUpgrade: { id: 'u', itemKeys: ['video:a'] } } };
      const vfail = { item_key: 'video:a', type: 'video', status: 'failed', output_summary: { regeneration: { reason: 'video_upgrade' } } };
      const ifail = { item_key: 'video_interactions:a', type: 'video_interactions', status: 'blocked', output_summary: { regeneration: { reason: 'cascade_from_video', cascadeFromItemKey: 'video:a' } } };
      const done = new Set(['video:a', 'video_interactions:a']);
      eq(VU.isUpgradeOnlyFailure(run, [vfail, ifail], done), true, 'solo upgrade');
      eq(VU.isUpgradeOnlyFailure({ ...run, input_payload: {} }, [vfail], done), false, 'sin upgrade');
      eq(VU.isUpgradeOnlyFailure({ ...run, worker_status: 'running' }, [vfail], done), false, 'run activo');
      eq(VU.isUpgradeOnlyFailure(run, [{ ...vfail, status: 'pending' }], done), false, 'item en vuelo');
      eq(VU.isUpgradeOnlyFailure(run, [vfail], new Set()), false, 'sin generación completada previa');
      eq(VU.isUpgradeOnlyFailure(run, [vfail, { item_key: 'content:a', type: 'content', status: 'failed', output_summary: {} }], done), false, 'fallo ajeno');
    });

    await check('fix round 1 (m-4) existingRunOrConflict: con el upgrade EN VUELO, una pestaña vieja que reanuda con videoMode mock recibe el run (no 409)', async () => {
      const Q2 = await previewCourse('Curso B2 pestaña vieja');
      const pv = await runs.previewVideoUpgrade(Q2.cid, ADMIN, 1, Q2.runId);
      await runs.confirmVideoUpgrade(Q2.cid, ADMIN, 1, Q2.runId, pv.estimateHash);
      eq((await jobOf(Q2.runId)).worker_status, 'queued', 'upgrade en vuelo');
      const res = await runs.startRun(Q2.cid, OWNER, 1, RESUME_CTX);
      eq([res.created, res.run.id, res.run.videoMode], [false, Q2.runId, 'real'], 'mismo run');
    });

    // ════ Fix round 1 (I-1): cancelar durante el upgrade ═══════════════════
    const C = await previewCourse('Curso B2 cancelado');
    let pvC = null;
    let upC = null;
    let chargesBeforeCancel = null;
    await check('I-1 cancelar DURANTE el upgrade (un video ya terminó real, el otro no): run cancelado SIGUE empaquetable (precheck OK) y el ledger no cambia', async () => {
      pvC = await runs.previewVideoUpgrade(C.cid, ADMIN, 1, C.runId);
      upC = (await runs.confirmVideoUpgrade(C.cid, ADMIN, 1, C.runId, pvC.estimateHash)).upgrade;
      const vg = fakeVideogen();
      await itemWorker.processItem(deps(dbScheduler(), vg), await claim(C.runId, `video:${C.c1}`, C.c1));
      // El 2º video ya estaba en Videogen (job real registrado) cuando se canceló.
      const v2 = await latest(C.runId, `video:${C.c2}`);
      await patchSummary(v2.id, { external: { videogenJobId: 'vg_cancelled_job', mode: 'real', batchId: 'b_x' }, mode: 'real' });
      chargesBeforeCancel = (await chargesOf(C.runId)).length;
      await runs.cancelRun(C.cid, OWNER, 1, C.runId, { email: ADMIN.email });
      const job = await jobOf(C.runId);
      eq(job.worker_status, 'cancelled', 'cancelado');
      eq(await VU.runIsUpgradeOnlyFailure(ds, job), true, 'solo partes del upgrade sin terminar');
      await packaging.assertRunReady(job, { rulesVersion: 3, manifest: C.manifest.manifest ?? C.manifest }, { email: ADMIN.email });
      eq((await chargesOf(C.runId)).length, chargesBeforeCancel, 'cancelar no cobra ni libera nada');
    });

    await check('I-1 reanudar con el modo ORIGINAL (mock) tras cancelar → reabre SIN 409 y SIN volver a encolar el video pago cancelado (solo las preguntas del video que sí terminó)', async () => {
      const gensBefore = (await counts(C.cid)).gens;
      const res = await runs.startRun(C.cid, OWNER, 1, RESUME_CTX);
      eq([res.reopened, res.run.id], [true, C.runId], 'reabierto');
      eq((await counts(C.cid)).gens, gensBefore, 'sin generaciones nuevas');
      eq((await latest(C.runId, `video:${C.c2}`)).status, 'cancelled', 'el video pago cancelado NO se re-encola');
      eq((await latest(C.runId, `video_interactions:${C.c2}`)).status, 'cancelled', 'sus preguntas tampoco');
      eq((await latest(C.runId, `video_interactions:${C.c1}`)).status, 'pending', 'las preguntas del video real que terminó sí (LLM)');
      eq((await chargesOf(C.runId)).length, chargesBeforeCancel, 'sin cargos nuevos');
      // Las preguntas del 1º terminan → el run queda failed SOLO por el upgrade cancelado → empaquetable.
      const i1 = await latest(C.runId, `video_interactions:${C.c1}`);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now(), output_summary = coalesce(output_summary, '{}'::jsonb) || '{"v3Validation":{"artifactType":"fixture"}}'::jsonb where id = $1`, [i1.id]);
      await runs.tx((qr) => L('modules/dynamic-generation/item-transitions.js').recomputeRunStatus(qr, C.runId));
      const job = await jobOf(C.runId);
      eq(job.worker_status, 'failed', 'failed solo por el upgrade');
      await packaging.assertRunReady(job, { rulesVersion: 3, manifest: C.manifest.manifest ?? C.manifest }, { email: ADMIN.email });
    });

    let upC2 = null;
    await check('I-1 SEGUNDO upgrade en el mismo run: vista previa NUEVA solo con el video que quedó pendiente; reutiliza su job de Videogen (fuera del estimado, sin envío nuevo, sin cargo duplicado)', async () => {
      const pv2 = await runs.previewVideoUpgrade(C.cid, ADMIN, 1, C.runId);
      eq([pv2.upgradeInFlight, pv2.eligible, pv2.blockers], [false, true, []], 'se puede pedir otro');
      eq(pv2.pendingVideos.map((p) => [p.itemKey, p.reusesVideogenJob === true]), [[`video:${C.c2}`, true]], 'solo el pendiente, reutilizando su job');
      eq(Object.keys(pv2.estimate.byItemType), ['video_interactions'], 'sin costo nuevo de Videogen');
      assert(pv2.estimateHash !== pvC.estimateHash, 'huella nueva');
      const before = await counts(C.cid);
      const r2 = await runs.confirmVideoUpgrade(C.cid, ADMIN, 1, C.runId, pv2.estimateHash);
      upC2 = r2.upgrade;
      eq([r2.created, upC2.itemKeys], [true, [`video:${C.c2}`]], 'creado solo para ese video');
      const after = await counts(C.cid);
      eq([after.gens - before.gens, after.auths - before.auths], [2, 1], 'video + preguntas, aprobación nueva');
      const job = await jobOf(C.runId);
      eq([job.input_payload.videoModeOriginal, job.input_payload.videoUpgradeHistory.map((u) => u.id)], ['mock', [upC.id]], 'original e historial');
      const v3 = await latest(C.runId, `video:${C.c2}`);
      eq([v3.generation, v3.output_summary.external.videogenJobId], [3, 'vg_cancelled_job'], 'job reutilizado');
      const vg = fakeVideogen();
      const s = dbScheduler();
      await itemWorker.processItem(deps(s, vg), await claim(C.runId, `video:${C.c2}`, C.c2));
      eq([s.st.failed.length, s.st.completed.length, vg.st.submits], [0, 1, 0], `re-consulta el job, sin envío nuevo: ${JSON.stringify(s.st.failed)}`);
      const vgCharges = (await chargesOf(C.runId)).filter((e) => e.provider === 'videogen' && e.event_kind === 'CHARGE' && e.metadata?.reservation !== true && e.metadata?.reservation !== 'true');
      const byJob = {};
      for (const e of await ds.query(`select external_operation_id from public.generation_cost_events where run_id = $1 and provider = 'videogen' and event_kind = 'CHARGE' and coalesce(metadata->>'reservation','false') <> 'true'`, [C.runId])) byJob[e.external_operation_id] = (byJob[e.external_operation_id] || 0) + 1;
      assert(Object.values(byJob).every((n) => n === 1), `un cargo por job: ${JSON.stringify(byJob)}`);
      assert(vgCharges.length === 2, `2 videos, 2 cargos en total: ${vgCharges.length}`);
    });

    await check('I-1 idempotencia POR UPGRADE: la huella del 1º devuelve el 1º; la del 2º devuelve el 2º; con el 2º en vuelo cualquier otra devuelve el 2º; nada escrito', async () => {
      const before = await counts(C.cid);
      const a = await runs.confirmVideoUpgrade(C.cid, ADMIN, 1, C.runId, pvC.estimateHash);
      eq([a.created, a.upgrade.id], [false, upC.id], '1º');
      const b = await runs.confirmVideoUpgrade(C.cid, ADMIN, 1, C.runId, upC2.estimateHash);
      eq([b.created, b.upgrade.id], [false, upC2.id], '2º');
      const c = await runs.confirmVideoUpgrade(C.cid, ADMIN, 1, C.runId, 'e'.repeat(64));
      eq([c.created, c.upgrade.id], [false, upC2.id], 'en vuelo');
      eq(await counts(C.cid), before, 'nada escrito');
    });

    // ════ Fix round 2 ═══════════════════════════════════════════════════
    const recompute = (runId) => runs.tx((qr) => L('modules/dynamic-generation/item-transitions.js').recomputeRunStatus(qr, runId));
    /** Upgrade 1 confirmado; el video 1 termina REAL (worker) con sus preguntas propias completadas. */
    async function upgradedWithFirstDone(title) {
      const X = await previewCourse(title);
      const pv = await runs.previewVideoUpgrade(X.cid, ADMIN, 1, X.runId);
      await runs.confirmVideoUpgrade(X.cid, ADMIN, 1, X.runId, pv.estimateHash);
      await itemWorker.processItem(deps(dbScheduler(), fakeVideogen()), await claim(X.runId, `video:${X.c1}`, X.c1));
      const i1 = await latest(X.runId, `video_interactions:${X.c1}`);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now(), output_summary = coalesce(output_summary, '{}'::jsonb) || '{"v3Validation":{"artifactType":"fixture"}}'::jsonb where id = $1`, [i1.id]);
      return X;
    }

    await check('fix round 2 (I-2): render FALLIDO en Videogen → 2º upgrade elegible (sus preguntas `blocked` no son «en curso»), el video NO reutiliza el job fallido: se estima Videogen y se envía UNA vez como nuevo', async () => {
      const X = await upgradedWithFirstDone('Curso B2 render fallido');
      const v2 = await latest(X.runId, `video:${X.c2}`);
      await patchSummary(v2.id, { external: { videogenJobId: 'vg_failed_render', mode: 'real' }, mode: 'real' });
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'videogen_failed: render error' where id = $1`, [v2.id]);
      const i2 = await latest(X.runId, `video_interactions:${X.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'blocked' where id = $1`, [i2.id]);
      await recompute(X.runId);
      eq((await jobOf(X.runId)).worker_status, 'failed', 'run failed solo por el upgrade');
      const pv2 = await runs.previewVideoUpgrade(X.cid, ADMIN, 1, X.runId);
      eq([pv2.eligible, pv2.blockers.map((b) => b.code)], [true, []], 'elegible, sin dependent_running');
      eq(pv2.pendingVideos.map((p) => [p.itemKey, !!p.reusesVideogenJob]), [[`video:${X.c2}`, false]], 'no reutiliza un render fallido');
      assert(Object.keys(pv2.estimate.byItemType).includes('video') && dec(pv2.estimate.byCategory.videos.expected) > 0, 'Videogen estimado y aprobado');
      await runs.confirmVideoUpgrade(X.cid, ADMIN, 1, X.runId, pv2.estimateHash);
      const v3 = await latest(X.runId, `video:${X.c2}`);
      eq([v3.generation, v3.output_summary.external], [3, undefined], 'generación nueva sin job heredado');
      const vg = fakeVideogen();
      const s = dbScheduler();
      await itemWorker.processItem(deps(s, vg), await claim(X.runId, `video:${X.c2}`, X.c2));
      eq([vg.st.submits, s.st.completed.length, s.st.failed.length], [1, 1, 0], `un envío nuevo: ${JSON.stringify(s.st.failed)}`);
    });

    await check('fix round 2 (I-2): video del upgrade FRENADO por presupuesto (`blocked`) → 2º upgrade elegible con aprobación nueva (sin dependent_running)', async () => {
      const X = await upgradedWithFirstDone('Curso B2 presupuesto');
      const v2 = await latest(X.runId, `video:${X.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'blocked', error = 'budget_exceeded: sin presupuesto' where id = $1`, [v2.id]);
      const i2 = await latest(X.runId, `video_interactions:${X.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'blocked' where id = $1`, [i2.id]);
      await recompute(X.runId);
      const pv2 = await runs.previewVideoUpgrade(X.cid, ADMIN, 1, X.runId);
      eq([pv2.eligible, pv2.blockers.map((b) => b.code), pv2.pendingVideos.map((p) => p.itemKey)], [true, [], [`video:${X.c2}`]], 'elegible');
      const before = await counts(X.cid);
      const r = await runs.confirmVideoUpgrade(X.cid, ADMIN, 1, X.runId, pv2.estimateHash);
      eq([r.created, (await counts(X.cid)).auths - before.auths], [true, 1], 'aprobación nueva');
    });

    await check('fix round 2 (I-3): cancelado DESPUÉS de que el video 1 quedó real (pagado) pero ANTES de sus preguntas → el 2º upgrade regenera SOLO sus preguntas (LLM, sin costo de video) + el video 2; al terminar, el paquete INCLUYE el video 1 con SUS preguntas', async () => {
      const X = await previewCourse('Curso B2 preguntas');
      const pv = await runs.previewVideoUpgrade(X.cid, ADMIN, 1, X.runId);
      await runs.confirmVideoUpgrade(X.cid, ADMIN, 1, X.runId, pv.estimateHash);
      await itemWorker.processItem(deps(dbScheduler(), fakeVideogen()), await claim(X.runId, `video:${X.c1}`, X.c1));
      await runs.cancelRun(X.cid, OWNER, 1, X.runId, { email: ADMIN.email });
      const v1 = await latest(X.runId, `video:${X.c1}`);
      eq([v1.status, v1.output_summary.mode], ['completed', 'real'], 'video 1 real y pagado');
      const pv2 = await runs.previewVideoUpgrade(X.cid, ADMIN, 1, X.runId);
      eq(pv2.pendingVideos.map((p) => p.itemKey), [`video:${X.c2}`], 'video pendiente');
      eq(pv2.questionsOnly.map((q) => [q.videoItemKey, q.itemKey]), [[`video:${X.c1}`, `video_interactions:${X.c1}`]], 'preguntas del video 1');
      const chargesBefore = (await chargesOf(X.runId)).filter((e) => e.provider === 'videogen').length;
      await runs.confirmVideoUpgrade(X.cid, ADMIN, 1, X.runId, pv2.estimateHash);
      const i1 = await latest(X.runId, `video_interactions:${X.c1}`);
      eq([i1.generation, i1.status, i1.output_summary.regeneration.cascadeFromItemRunId], [3, 'pending', v1.id], 'preguntas nuevas DE ese video');
      eq((await latest(X.runId, `video:${X.c1}`)).generation, 2, 'el video 1 no se regenera');
      // El video 2 se genera; las preguntas (ejecutor del navegador) terminan.
      await itemWorker.processItem(deps(dbScheduler(), fakeVideogen()), await claim(X.runId, `video:${X.c2}`, X.c2));
      for (const c of [X.c1, X.c2]) {
        const ir = await latest(X.runId, `video_interactions:${c}`);
        await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now(), output_summary = coalesce(output_summary, '{}'::jsonb) || '{"v3Validation":{"artifactType":"fixture"}}'::jsonb where id = $1`, [ir.id]);
      }
      await recompute(X.runId);
      eq((await jobOf(X.runId)).worker_status, 'completed', 'run completed');
      eq((await chargesOf(X.runId)).filter((e) => e.provider === 'videogen').length > chargesBefore, true, 'solo el video 2 cobró');
      // Lo que el empaque vería: filas efectivas reales → ningún video pendiente (video 1 CON sus preguntas).
      const PK = L('modules/dynamic-packaging/packaging-v3.js');
      const job = await jobOf(X.runId);
      const eff = await ds.query(`select distinct on (item_key) * from public.generation_item_runs where job_id = $1 and type in ('video','video_interactions')
                                  order by item_key, (status = 'completed') desc, generation desc`, [X.runId]);
      const byItem = new Map(eff.map((r) => [r.item_key, { itemKey: r.item_key, type: r.type, artifacts: [{ artifactId: 'a-' + r.id, itemRunId: r.id }], outputSummary: r.output_summary }]));
      const mf = { items: eff.map((r) => ({ key: r.item_key, type: r.type, chapterId: r.chapter_id })) };
      const split = PK.splitPendingVideosV3(mf, byItem, job.input_payload.videoMode, { videoUpgrade: true, upgradedKeys: VU.upgradedVideoKeysOf(job.input_payload), fallbackMode: VU.fallbackVideoModeOf(job.input_payload), runId: X.runId });
      eq(split.pendingVideos, [], 'el paquete incluye ambos videos reales con sus preguntas');
      await packaging.assertRunReady(job, { rulesVersion: 3, manifest: X.manifest.manifest ?? X.manifest }, { email: ADMIN.email });
    });

    await check('fix round 2 (m-8): un video con envío AMBIGUO queda fuera (needsReconciliation) y el resto del 2º upgrade sigue', async () => {
      const X = await upgradedWithFirstDone('Curso B2 ambiguo');
      const v2 = await latest(X.runId, `video:${X.c2}`);
      await patchSummary(v2.id, { externalSubmitStartedAt: new Date().toISOString() });
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'ambiguous_video_submission: timeout' where id = $1`, [v2.id]);
      const i2 = await latest(X.runId, `video_interactions:${X.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'blocked' where id = $1`, [i2.id]);
      await recompute(X.runId);
      const pv2 = await runs.previewVideoUpgrade(X.cid, ADMIN, 1, X.runId);
      eq([pv2.pendingVideos, pv2.needsReconciliation.map((r) => r.itemKey)], [[], [`video:${X.c2}`]], 'ambiguo fuera');
      assert(pv2.blockers.some((b) => b.code === VU.VIDEO_UPGRADE_AMBIGUOUS_SUBMISSION), 'si no queda nada más, traba clara');
    });

    await check('fix round 2 (m-7): reutilizar un job cuyo 1er intento YA publicó en YouTube → reutiliza ese id, 0 subidas nuevas', async () => {
      const X = await previewCourse('Curso B2 youtube');
      const pv = await runs.previewVideoUpgrade(X.cid, ADMIN, 1, X.runId);
      await runs.confirmVideoUpgrade(X.cid, ADMIN, 1, X.runId, pv.estimateHash);
      await itemWorker.processItem(deps(dbScheduler(), fakeVideogen()), await claim(X.runId, `video:${X.c1}`, X.c1));
      const v2 = await latest(X.runId, `video:${X.c2}`);
      await patchSummary(v2.id, { external: { videogenJobId: 'vg_published', mode: 'real', youtubeVideoId: 'PubVid12345', youtubeUrl: 'https://www.youtube.com/watch?v=PubVid12345' }, mode: 'real' });
      await runs.cancelRun(X.cid, OWNER, 1, X.runId, { email: ADMIN.email });
      const pv2 = await runs.previewVideoUpgrade(X.cid, ADMIN, 1, X.runId);
      eq(pv2.pendingVideos.map((p) => [p.itemKey, !!p.reusesVideogenJob]), [[`video:${X.c2}`, true]], 'reutiliza');
      await runs.confirmVideoUpgrade(X.cid, ADMIN, 1, X.runId, pv2.estimateHash);
      const uploadsBefore = yt.uploads;
      const vg = fakeVideogen();
      const s = dbScheduler();
      await itemWorker.processItem(deps(s, vg), await claim(X.runId, `video:${X.c2}`, X.c2));
      eq([s.st.failed.length, s.st.completed.length, vg.st.submits, yt.uploads - uploadsBefore], [0, 1, 0, 0], `sin envío ni subida nuevos: ${JSON.stringify(s.st.failed)}`);
      eq((await latest(X.runId, `video:${X.c2}`)).output_summary.youtubeVideoId, 'PubVid12345', 'mismo id de YouTube');
    });

    // ════ Fix round 3 (I-4): procedencia explícita de las preguntas ═════════
    const { SchedulerService } = L('modules/dynamic-generation/scheduler.service.js');
    const sched = new SchedulerService(ds, runs);
    const splitOf = async (runId) => {
      const PK = L('modules/dynamic-packaging/packaging-v3.js');
      const job = await jobOf(runId);
      const eff = await ds.query(`select distinct on (item_key) * from public.generation_item_runs where job_id = $1 and type in ('video','video_interactions')
                                  order by item_key, (status = 'completed') desc, generation desc`, [runId]);
      const byItem = new Map(eff.map((r) => [r.item_key, { itemKey: r.item_key, type: r.type, artifacts: [{ artifactId: 'a-' + r.id, itemRunId: r.id }], outputSummary: r.output_summary, finishedAt: r.finished_at }]));
      const mf = { items: eff.map((r) => ({ key: r.item_key, type: r.type, chapterId: r.chapter_id })) };
      return PK.splitPendingVideosV3(mf, byItem, job.input_payload.videoMode, { videoUpgrade: true, upgradedKeys: VU.upgradedVideoKeysOf(job.input_payload), fallbackMode: VU.fallbackVideoModeOf(job.input_payload), runId });
    };
    let I4 = null;
    await check('fix round 3 (I-4): upgrade COMPLETO → el dueño «Regenera» las preguntas del video 1 (regenerateItem normal) → el claim registra sourceVideoItemRunId = video vigente; el paquete INCLUYE el video real con las preguntas nuevas, el planificador no muestra nada pendiente y no pide aprobación', async () => {
      const X = await previewCourse('Curso B2 regenerar preguntas');
      const pv = await runs.previewVideoUpgrade(X.cid, ADMIN, 1, X.runId);
      await runs.confirmVideoUpgrade(X.cid, ADMIN, 1, X.runId, pv.estimateHash);
      for (const c of [X.c1, X.c2]) await itemWorker.processItem(deps(dbScheduler(), fakeVideogen()), await claim(X.runId, `video:${c}`, c));
      for (const c of [X.c1, X.c2]) {
        const ir = await latest(X.runId, `video_interactions:${c}`);
        eq(ir.output_summary.sourceVideoItemRunId, (await latest(X.runId, `video:${c}`)).id, 'el upgrade la registra al crearla');
        await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now(), output_summary = coalesce(output_summary, '{}'::jsonb) || '{"v3Validation":{"artifactType":"fixture"}}'::jsonb where id = $1`, [ir.id]);
      }
      await recompute(X.runId);
      eq((await splitOf(X.runId)).pendingVideos, [], 'nada pendiente tras el upgrade');
      // El dueño regenera las preguntas del video 1 con el «Regenerar» normal (sin cascada del upgrade).
      const res = await runs.regenerateItem(X.cid, OWNER, 1, X.runId, `video_interactions:${X.c1}`, { confirmPaid: true });
      eq([res.created, res.item.generation], [true, 3], 'generación 3 de las preguntas');
      const claimed = await sched.claimNextItem({ executorId: 'b-ev6', types: ['video_interactions'], runId: X.runId, ownerId: OWNER, leaseSeconds: 60 });
      assert(claimed && claimed.itemKey === `video_interactions:${X.c1}`, `claim: ${claimed && claimed.itemKey}`);
      const v1 = await latest(X.runId, `video:${X.c1}`);
      const q3 = await latest(X.runId, `video_interactions:${X.c1}`);
      eq([q3.generation, q3.output_summary.sourceVideoItemRunId], [3, v1.id], 'el CLAIM registra la procedencia');
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now(), lease_until = null, output_summary = coalesce(output_summary, '{}'::jsonb) || '{"v3Validation":{"artifactType":"fixture"}}'::jsonb where id = $1`, [q3.id]);
      await recompute(X.runId);
      eq((await jobOf(X.runId)).worker_status, 'completed', 'run completed');
      eq((await splitOf(X.runId)).pendingVideos, [], 'el paquete incluye el video real con las preguntas nuevas');
      const before = await counts(X.cid);
      const pv2 = await runs.previewVideoUpgrade(X.cid, ADMIN, 1, X.runId);
      eq([pv2.eligible, pv2.pendingVideos, pv2.questionsOnly, pv2.estimate], [false, [], [], null], 'nada pendiente, sin estimado ni aprobación');
      assert(pv2.blockers.some((b) => b.code === VU.VIDEO_UPGRADE_NOTHING_PENDING), 'nada que generar');
      eq(await counts(X.cid), before, 'sin escrituras');
      await packaging.assertRunReady(await jobOf(X.runId), { rulesVersion: 3, manifest: X.manifest.manifest ?? X.manifest });
      I4 = X;
    });

    await check('fix round 3 (I-4) legacy: preguntas SIN sourceVideoItemRunId → son del video si completaron DESPUÉS que su generación vigente; si completaron antes → pendientes (questionsOnly) y el paquete las omite', async () => {
      const X = I4;
      const v1 = await latest(X.runId, `video:${X.c1}`);
      const q = await latest(X.runId, `video_interactions:${X.c1}`);
      await ds.query(`update public.generation_item_runs set output_summary = output_summary - 'sourceVideoItemRunId', finished_at = $2::timestamptz + interval '1 minute' where id = $1`, [q.id, v1.finished_at]);
      eq((await splitOf(X.runId)).pendingVideos, [], 'legacy completada después → suya');
      eq((await runs.previewVideoUpgrade(X.cid, ADMIN, 1, X.runId)).questionsOnly, [], 'planificador: nada');
      await ds.query(`update public.generation_item_runs set finished_at = $2::timestamptz - interval '1 minute' where id = $1`, [q.id, v1.finished_at]);
      eq((await splitOf(X.runId)).pendingVideos.map((p) => p.itemKey), [`video:${X.c1}`], 'legacy completada antes → pendiente');
      eq((await runs.previewVideoUpgrade(X.cid, ADMIN, 1, X.runId)).questionsOnly.map((x) => x.itemKey), [`video_interactions:${X.c1}`], 'planificador: preguntas del video');
      // Pura: la regla única.
      eq([
        VU.questionsBelongToVideo({ id: 'v', finishedAt: '2026-01-01T00:00:00Z' }, { status: 'completed', outputSummary: { sourceVideoItemRunId: 'v' } }),
        VU.questionsBelongToVideo({ id: 'v', finishedAt: '2026-01-01T00:00:00Z' }, { status: 'completed', outputSummary: { sourceVideoItemRunId: 'old' }, finishedAt: '2027-01-01T00:00:00Z' }),
        VU.questionsBelongToVideo({ id: 'v', finishedAt: '2026-01-01T00:00:00Z' }, { status: 'pending', outputSummary: { sourceVideoItemRunId: 'v' } }),
        VU.questionsBelongToVideo({ id: 'v', finishedAt: new Date('2026-01-01T00:00:00Z') }, { status: 'completed', outputSummary: {}, finishedAt: new Date('2026-01-01T00:00:00.500Z') }),
        VU.questionsBelongToVideo({ id: 'v', finishedAt: '2026-01-01T00:00:01Z' }, { status: 'completed', outputSummary: {}, finishedAt: '2026-01-01T00:00:00Z' }),
        VU.questionsBelongToVideo({ id: 'v', finishedAt: null }, { status: 'completed', outputSummary: {}, finishedAt: '2026-01-01T00:00:00Z' }),
      ], [true, false, false, true, false, false], 'regla');
    });

    await check('m-11: el ejecutor del NAVEGADOR no puede fijar claves del servidor al completar (sourceVideoItemRunId, regeneration, mode, external, …); los workers internos sí escriben las suyas', async () => {
      const SCH = L('modules/dynamic-generation/scheduler.service.js');
      const evil = { sourceVideoItemRunId: 'otro-video', cascadeFromItemRunId: 'x', regeneration: { reason: 'video_upgrade' }, mode: 'real',
        external: { videogenJobId: 'falso' }, videoUpgrade: { id: 'u' }, videoIdentity: {}, v3Validation: {}, delivery: 'completed', youtubeVideoId: 'AAAAAAAAAAA',
        interactionCount: 4, promptVersion: 'v21-vint-2', chapterId: 'c1' };
      const st = SCH.stripServerOwnedSummaryKeys(evil);
      eq(st.summary, { interactionCount: 4, promptVersion: 'v21-vint-2', chapterId: 'c1' }, 'solo lo del ejecutor');
      for (const k of ['sourceVideoItemRunId', 'cascadeFromItemRunId', 'regeneration', 'mode', 'external', 'videoUpgrade', 'videoIdentity', 'v3Validation', 'delivery', 'youtubeVideoId']) {
        assert(st.dropped.includes(k), `descarta ${k}`);
      }
      // Integración (DB real): completar como NAVEGADOR (ownerId) un item ya reclamado con un sourceVideoItemRunId
      // falso → el valor del servidor se conserva. Item LLM de v3 sin validación de contenido no hay: se usa el
      // camino de merge del servidor directamente sobre la fila reclamada en I-4.
      const row = await latest(I4.runId, `video_interactions:${I4.c1}`);
      const merged = SCH.mergeOutputSummary(row.output_summary, SCH.stripServerOwnedSummaryKeys({ sourceVideoItemRunId: 'otro-video', interactionCount: 3 }).summary);
      eq([merged.ok, merged.merged.sourceVideoItemRunId === row.output_summary.sourceVideoItemRunId || row.output_summary.sourceVideoItemRunId === undefined, merged.merged.interactionCount], [true, true, 3], 'merge conserva la procedencia');
      const src = fs.readFileSync(path.join(REPO, 'src/modules/dynamic-generation/scheduler.service.ts'), 'utf8');
      assert(/if \(ownerId !== undefined\) \{\s*const st = stripServerOwnedSummaryKeys\(rawSummary\)/.test(src), 'completeItemDetailed lo aplica en el camino del navegador');
    });

    await check('I-1 empaquetado: un video real del upgrade cuyas preguntas siguen siendo las de la vista previa (upgrade cancelado antes) se OMITE (pendiente), nunca un H5P con preguntas de otro video', async () => {
      const PK = L('modules/dynamic-packaging/packaging-v3.js');
      const mf = { items: [{ key: 'video:x', type: 'video', chapterId: 'x' }, { key: 'video_interactions:x', type: 'video_interactions', chapterId: 'x' }] };
      const mk = (cascade) => new Map([
        ['video:x', { itemKey: 'video:x', type: 'video', artifacts: [{ artifactId: 'a1', itemRunId: 'gen2' }], outputSummary: { mode: 'real', regeneration: { reason: 'video_upgrade' } } }],
        ['video_interactions:x', { itemKey: 'video_interactions:x', type: 'video_interactions', artifacts: [{ artifactId: 'a2', itemRunId: 'i' }], outputSummary: cascade ? { sourceVideoItemRunId: cascade } : {} }],
      ]);
      const opts = { videoUpgrade: true, upgradedKeys: new Set(['video:x']), fallbackMode: 'mock' };
      eq(PK.splitPendingVideosV3(mf, mk(null), 'real', opts).pendingVideos.map((p) => p.itemKey), ['video:x'], 'preguntas viejas → pendiente');
      eq(PK.splitPendingVideosV3(mf, mk('gen2'), 'real', opts).pendingVideos, [], 'preguntas del video nuevo → se empaqueta');
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
  console.log(`\n${failures === 0 ? 'Todos los checks de EV6 T5 B2 pasaron' : 'HAY FALLOS'} (${passes} ✅, ${failures} ❌).`);
  process.exit(failures === 0 ? 0 : 1);
})();
