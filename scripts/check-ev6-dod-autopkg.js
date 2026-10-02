#!/usr/bin/env node
/* eslint-disable */
// Cursia EV6 — DoD «curso completo», Fase B / BE-B: paquete final AUTOMÁTICO, cola de recuperación de
// admin, reintento automático SEGURO y reporte de cursos viejos de vista previa.
//
//   [AP] completion → el paquete final se encola SOLO, una vez (re-disparos, barrido y botón manual
//        idempotentes, también en paralelo); preview / failed / runs viejos → nunca; paquete fallido →
//        `packaging` mientras queda reintento automático, después `needs_attention` + `retry_package`;
//        precheck bloqueado → needs_attention; rollback → no se encola nada.
//   [AD] GET /api/v1/admin/dynamic-runs/needs-attention: 401 sin token, 403 al dueño, 200 a SUPER_ADMIN
//        con las acciones y su endpoint existente; sin texto de errores ni emails. GET /features:
//        `dodContract:true` y `superAdmin` del usuario (sin lista de admins).
//   [AR] reintento automático SEGURO: videogen_submit_rejected → UN reintento (worker real, Videogen
//        falso) y después needs_attention; ambiguous_video_submission / videogen_failed → 0 reintentos;
//        FinOps sigue mandando (gate en simulación + runtime guard del worker; nunca aprobaciones nuevas);
//        gamma_submit_failed (rechazo probado sin gasto) → un reintento común.
//   [RP] scripts/report-ev6-legacy-preview-runs.js: solo lectura (rechaza flags de escritura sin
//        conectarse; solo SELECT en una transacción READ ONLY; la base queda idéntica).
//
// PG16 DESECHABLE (puerto libre ≠ 5570 y ≠ 8099), esquema real, servicios y workers COMPILADOS,
// Storage/Videogen/YouTube falsos en 127.0.0.1: 0 red externa, 0 gasto.
//
// Usage: npm run build && node scripts/check-ev6-dod-autopkg.js

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
global.fetch = async (u, o) => {
  const s = String(u);
  if (s.startsWith('data:') || /^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o);
  throw new Error(`NETWORK FORBIDDEN in check: ${s}`);
};

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    const msg = err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : String(err);
    console.error(`❌ ${name}\n   ${msg}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
async function rejectsRe(p, re, m, status) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${m}: NO lanzó`);
  const text = err.message + ' ' + JSON.stringify(err.getResponse ? err.getResponse() : '');
  assert(re.test(text), `${m}: mensaje inesperado "${text.slice(0, 300)}"`);
  if (status !== undefined) assert(err.getStatus && err.getStatus() === status, `${m}: status ${err.getStatus && err.getStatus()} (esperado ${status})`);
  return err;
}
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
const ADMIN_X = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'admin@cursia.test' }; // SUPER_ADMIN que NO es el dueño
const OWNER_ACTOR = { id: OWNER, email: 'owner@cursia.test' };
const CONTEXT = { nombre: 'Curso BE-B', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const JWT_SECRET = 'beb-local-hs256-secret-only-for-this-check';
const ENV_KEYS = [
  'DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED',
  'DYNAMIC_ALLOW_PROVIDER_MOCK', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DYNAMIC_ALLOW_VIDEO_PREVIEW', 'SUPER_ADMIN_EMAILS',
  'GAMMA_API_KEY', 'GAMMA_THEME_V21_LIGHT_DEFAULT', 'GAMMA_THEME_V21_DARK_DEFAULT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'VIDEOGEN_API_KEY', 'SUPABASE_JWT_SECRET', 'DYNAMIC_AUTO_PACKAGE_ENABLED', 'DYNAMIC_REAL_VIDEO_ALL_OWNERS',
  'DYNAMIC_AUTO_HEAL_ENABLED',
];

(async () => {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { Logger, ConflictException } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const F = L('modules/finops/index.js');
  const snap = L('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = L('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = L('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = L('modules/dynamic-generation/runs.service.js');
  const { SchedulerService } = L('modules/dynamic-generation/scheduler.service.js');
  const { PackagingService } = L('modules/dynamic-packaging/packaging.service.js');
  const { AutoPackageService } = L('modules/dynamic-packaging/auto-package.service.js');
  const { AdminRecoveryService } = L('modules/dynamic-generation/admin-recovery.service.js');
  const { AdminDynamicRunsController } = L('modules/dynamic-generation/admin-runs.controller.js');
  const { FeaturesController } = L('modules/features/features.controller.js');
  const { ArtifactsService } = L('modules/artifacts/artifacts.service.js');
  const { Artifact } = L('modules/artifacts/entities/artifact.entity.js');
  const { AllExceptionsFilter } = L('common/filters/http-exception.filter.js');
  const { ResponseInterceptor } = L('common/interceptors/response.interceptor.js');
  const T = L('modules/dynamic-generation/item-transitions.js');
  const RC = L('modules/dynamic-generation/run-completion.js');
  const AH = L('modules/dynamic-generation/auto-heal.js');
  const APS = L('modules/dynamic-packaging/auto-package-state.js');
  const AR = L('modules/dynamic-packaging/artifact-resolver.js');
  const IA = L('modules/invalidation/invalidation-apply.js');
  const RH = L('modules/dynamic-generation/run-hash.js');
  const IW = L('workers/dynamic-item-worker.js');
  const { startStorage, syntheticMp4WithMvhd } = require(path.join(REPO, 'test/e2e-v2/fakes.js'));

  // ════ Puros (sin DB) ═══════════════════════════════════════════════════════
  await check('[AP] puro: completion con generación completa → `complete` con paquete vigente; `packaging` con el job en cola o fallido con reintento automático pendiente; fallido SIN reintento → needs_attention + retry_package (nunca complete)', () => {
    const manifest = { rulesVersion: 2, items: [{ key: 'content:a', type: 'content' }] };
    const rows = [{ id: 'r1', item_key: 'content:a', type: 'content', status: 'completed', output_summary: {} }];
    const job = { status: 'completed', worker_status: 'completed', input_payload: { videoMode: 'real' } };
    const c1 = RC.evaluateRunCompletion(job, rows, manifest, { ready: true, status: 'completed' });
    eq([c1.state, c1.complete, c1.packageJob], ['complete', true, { status: 'completed', autoRetryPending: false, auto: false }], 'paquete vigente');
    const c2 = RC.evaluateRunCompletion(job, rows, manifest, { ready: false, status: 'queued' });
    eq([c2.state, c2.complete, c2.adminActions], ['packaging', false, []], 'en cola');
    const c3 = RC.evaluateRunCompletion(job, rows, manifest, { ready: false, status: 'failed', autoRetryPending: true, auto: true });
    eq([c3.state, c3.adminActions, c3.packageJob], ['packaging', [], { status: 'failed', autoRetryPending: true, auto: true }], 'fallido con reintento automático');
    const c4 = RC.evaluateRunCompletion(job, rows, manifest, { ready: false, status: 'failed', autoRetryPending: false });
    eq([c4.state, c4.complete, c4.adminActions], ['needs_attention', false, [{ code: 'retry_package' }]], 'fallido sin reintento');
    const c5 = RC.evaluateRunCompletion(job, rows, manifest, { ready: false, status: 'none' });
    eq(c5.state, 'packaging', 'sin job todavía');
    const c6 = RC.evaluateRunCompletion(job, rows, manifest, { ready: true });
    eq([c6.state, 'packageJob' in c6], ['complete', false], 'llamador viejo ({ready}) sin packageJob');
    // Fix round 1: no vigente / sin job y SIN nada automático pendiente: auto → needs_attention; viejo → packaging (manual).
    eq(RC.evaluateRunCompletion(job, rows, manifest, { ready: false, status: 'stale', autoRetryPending: false, auto: true }).state, 'needs_attention', 'stale auto');
    eq(RC.evaluateRunCompletion(job, rows, manifest, { ready: false, status: 'stale', autoRetryPending: true, auto: true }).state, 'packaging', 'stale con re-armado pendiente');
    eq(RC.evaluateRunCompletion(job, rows, manifest, { ready: false, status: 'stale', autoRetryPending: false, auto: false }).state, 'packaging', 'stale viejo');
    eq(RC.evaluateRunCompletion(job, rows, manifest, { ready: false, status: 'none', autoRetryPending: false, auto: true }).adminActions, [{ code: 'retry_package' }], 'none sin pendiente');
    const cb = RC.evaluateRunCompletion(job, rows, manifest, { ready: false, status: 'failed', blocked: { code: 'package_not_ready', message: 'm', missing: ['content:a:missing_artifact'] }, auto: true });
    eq([cb.state, cb.adminActions, cb.packageJob.blocked], ['needs_attention', [{ code: 'regenerate_item', itemKey: 'content:a', reason: 'package_not_ready' }], { code: 'package_not_ready', message: 'm' }], 'bloqueo → acción del componente');
  });

  await check('[AR] puro: clasificación — videogen_submit_rejected (4xx probado, sin job) → 1 reintento automático tras la espera; 408/409, con job, «quota», videogen_failed, ambiguous, provider_reconciliation, tts_failed → nunca; gamma_submit_failed sin generationId → 1 reintento', () => {
    const now = new Date();
    const prevDyn = process.env.DYNAMIC_COURSE_STRUCTURE;
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true'; // el tick del auto-healer corre (fix M5)
    const ago = (s) => new Date(now.getTime() - s * 1000);
    const d = (error, os, type = 'video', at = ago(600)) => AH.safeAutoRetryDecision({ status: 'failed', type, error, output_summary: os, finished_at: at }, now);
    const rej = 'videogen_submit_rejected: Error: Videogen batch-create failed (HTTP 422): invalid content';
    eq([d(rej, { externalSubmitStartedAt: 'x' }).heal, d(rej, {}).round], [true, 1], 'rechazo 422 → sí');
    eq(d(rej, {}, 'video', ago(30)).reason, 'backoff', 'recién rechazado → espera');
    eq(d(rej, { safeAutoRetry: { rounds: 1 } }).reason, 'cap_reached', 'una sola vez');
    eq(d(rej, { safeAutoRetry: { declined: 'budget_approval_required' } }).reason, 'declined', 'rechazado por FinOps → humano');
    eq(d(rej.replace('422', '409'), {}).reason, 'missing_precondition', '409 no prueba «nada creado»');
    eq(d(rej.replace('422', '408'), {}).reason, 'missing_precondition', '408 no prueba «nada creado»');
    eq(d(rej, { external: { videogenJobId: 'vg1' } }).reason, 'missing_precondition', 'con job registrado → nunca');
    eq(d('videogen_submit_rejected: Videogen batch-create failed (HTTP 429): quota exceeded', {}).reason, 'denied', 'cuota → deny-list');
    eq(d(rej, {}, 'audio_welcome').reason, 'not_allow_listed', 'otro tipo');
    for (const e of ['videogen_failed: render error', 'ambiguous_video_submission: timeout', 'provider_reconciliation_required: videogen — x', 'tts_failed: chunk 2/3: HTTP 400']) {
      eq(d(e, {}, e.startsWith('tts') ? 'audio_welcome' : 'video').heal, false, `${e.split(':')[0]} → nunca automático`);
      eq(AH.autoHealDecision({ status: 'failed', type: 'video', error: e, output_summary: {}, finished_at: ago(3600) }, now).heal, false, `${e.split(':')[0]}: tampoco el auto-healer`);
    }
    eq(d('gamma_submit_failed: Gamma 400 bad request', {}, 'presentation').heal, true, 'gamma 4xx sin id → sí');
    eq(d('gamma_submit_failed: Gamma 400', { external: { gammaGenerationId: 'g' } }, 'presentation').reason, 'missing_precondition', 'gamma con id → nunca');
    // Mientras el reintento automático está pendiente no hay acción de admin; usado → retry_video_render.
    const row = (os, at) => ({ id: 'v', item_key: 'video:x', type: 'video', status: 'failed', error: rej, output_summary: os, finished_at: at });
    eq(RC.adminActionFor(row({}, ago(30)), 'not_done', now), null, 'pendiente (espera) → sin acción');
    eq(RC.adminActionFor(row({}, ago(600)), 'not_done', now), null, 'pendiente → sin acción');
    eq(RC.adminActionFor(row({ safeAutoRetry: { rounds: 1 } }, ago(600)), 'not_done', now), { code: 'retry_video_render', itemKey: 'video:x' }, 'usado → admin');
    // Fix M5: con el tick del auto-healer apagado nadie lo reintenta → la acción de admin se muestra ya.
    const prevAH = process.env.DYNAMIC_AUTO_HEAL_ENABLED;
    process.env.DYNAMIC_AUTO_HEAL_ENABLED = 'false';
    try {
      eq(RC.adminActionFor(row({}, ago(30)), 'not_done', now), { code: 'retry_video_render', itemKey: 'video:x' }, 'tick apagado → admin');
    } finally {
      if (prevAH === undefined) delete process.env.DYNAMIC_AUTO_HEAL_ENABLED; else process.env.DYNAMIC_AUTO_HEAL_ENABLED = prevAH;
      if (prevDyn === undefined) delete process.env.DYNAMIC_COURSE_STRUCTURE; else process.env.DYNAMIC_COURSE_STRUCTURE = prevDyn;
    }
  });

  // ════ DB ═══════════════════════════════════════════════════════════════════
  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-ev6-beb-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-ev6-beb-cwd-'));
  const ROLE = 'postgres.ev6beblocaltest01';
  const DB = 'ev6bebdb';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let ds = null;
  let app = null;
  const storage = startStorage();
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
    const runScript = (script, env, args = [], nodeOpts) => {
      const res = spawnSync(process.execPath, [...(nodeOpts || []), path.join(REPO, script), ...args], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || ''), stdout: res.stdout || '' };
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
      'scripts/migrate-v21-finops.js', 'scripts/verify-v21-finops-schema.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }
    await new Promise((res) => storage.srv.listen(0, '127.0.0.1', res));
    const storageUrl = `http://127.0.0.1:${storage.srv.address().port}`;

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    delete process.env.DYNAMIC_REAL_VIDEO_ALL_OWNERS;
    delete process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW;
    delete process.env.DYNAMIC_ALLOW_PROVIDER_MOCK;
    delete process.env.DYNAMIC_AUTO_PACKAGE_ENABLED;
    delete process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT;
    process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    process.env.SUPER_ADMIN_EMAILS = 'admin@cursia.test';
    process.env.SUPABASE_URL = storageUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-local-only';
    process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
    Object.assign(process.env, {
      GAMMA_API_KEY: 'fake-gamma-never-called', GAMMA_THEME_V21_LIGHT_DEFAULT: 'theme-l', GAMMA_THEME_V21_DARK_DEFAULT: 'theme-d',
      OPENAI_API_KEY: 'fake-openai-never-called', ANTHROPIC_API_KEY: 'fake-anthropic-never-called', VIDEOGEN_API_KEY: 'fake-videogen-never-called',
    });

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const ytOk = { async check() { return { ok: true }; } };
    const runs = new RunsService(ds, manifests, {}, ytOk, budget);
    const sched = new SchedulerService(ds, runs);
    const artifacts = new ArtifactsService(ds.getRepository(Artifact), { get: (k) => process.env[k] });
    const packaging = new PackagingService(ds, manifests, artifacts);
    // El build real del .mbz (prepareV3Package) necesita los archivos de cada artifact: fuera del alcance de este
    // check (lo cubren check-v21-packaging-v3 / check-ev6-dod). Acá se prueba QUIÉN encola, CUÁNTAS veces y con qué
    // estado: el precheck v3 y la comparación de build se sustituyen (por run, para poder simular un precheck 409).
    const blockedPrecheck = new Map();
    packaging.prepareV3OrConflict = async (run) => {
      const b = blockedPrecheck.get(run.id);
      if (b && b.status === 403) {
        const { ForbiddenException } = require('@nestjs/common');
        throw new ForbiddenException('La estructura dinámica no está habilitada para esta cuenta (simulado)');
      }
      if (b) throw new ConflictException({ message: `${b.code}: precheck simulado`, missing: b.missing || [], code: b.code });
    };
    // Fix round 1 (I1/M8): la vigencia del paquete se controla por run/job (antes: siempre «mismo build»).
    const staleBuildRuns = new Set();
    packaging.isSameBuild = async (run) => !staleBuildRuns.has(run.id);
    const PFR = L('modules/dynamic-packaging/package-freshness.js');
    const deliverableJobs = new Set();
    PFR.hasDeliverablePackage = async (q, run) => {
      const [j] = await q.query(`select id from public.production_jobs where execution_mode = 'dynamic_package' and input_payload->>'runId' = $1
                                   and worker_status = 'completed' order by created_at desc, id desc limit 1`, [run.id]);
      return !!j && deliverableJobs.has(j.id);
    };
    // Builder VIGENTE del dist (V542 lo subió a 3.8.0): un paquete con esta versión es «el mismo build».
    const CUR_BUILDER = L('package/dynamic-mbz-builder-v3.js').DYNAMIC_MBZ_BUILDER_VERSION_V3;
    const completeJob = (id, builder = CUR_BUILDER) => ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now(),
      output_summary = $2::jsonb where id = $1`, [id, JSON.stringify({ artifactId: crypto.randomUUID(), builderVersion: builder, sourceIdsHash: 'h'.repeat(64) })]);
    const autoPkg = new AutoPackageService(ds, packaging, runs);
    autoPkg.onModuleInit();
    const recovery = new AdminRecoveryService(ds, manifests, runs);

    const jobOf = async (id) => (await ds.query(`select * from public.production_jobs where id = $1`, [id]))[0];
    const pkgJobs = (runId) => ds.query(`select * from public.production_jobs where execution_mode = 'dynamic_package' and input_payload->>'runId' = $1 order by created_at, id`, [runId]);
    const recompute = async (runId) => { const st = await runs.tx((qr) => T.recomputeRunStatus(qr, runId)); await runs.settleRunCompletedHooks(); return st; };
    const latest = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const failPkg = (id, minsAgo = 5) => ds.query(`update public.production_jobs set status = 'failed', worker_status = 'failed', error_message = 'build falló (simulado)',
      finished_at = now() - make_interval(mins => $2::int), updated_at = now() - make_interval(mins => $2::int) where id = $1`, [id, minsAgo]);
    const V3VAL = { v3Validation: { artifactType: 'fixture', artifactId: crypto.randomUUID(), contentSha256: 'x'.repeat(64) } };

    /** Curso v3 confirmado (1 módulo, 2 capítulos con video; uno con actividad; examen de módulo + final). */
    async function confirmedCourse(title, { c2Video = true, c2Title = 'C2' } = {}) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: true, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: c2Title, objective: null, video_enabled: c2Video, activity_enabled: false }],
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
      const mf = await manifests.getOrCreate(cid, OWNER, 1);
      await ds.query(`insert into public.cost_budget_policies (scope, scope_id, version, limits, on_exceed) values ('course', $1, 1, $2::jsonb, 'ADMIN_APPROVAL')`,
        [String(cid), JSON.stringify({ maxCostPerRun: '1000', maxCostPerCourse: '1000', monthlyCap: '1000000000' })]);
      return { cid, c1, c2, m1, manifest: mf.manifest };
    }

    /** Run v3 100 % REAL sembrado (items completados y validados + un artifact por rol), todavía `running`. */
    async function seededRealRun(C, { videoModeOf = () => 'real' } = {}) {
      const ctx = { ...CONTEXT };
      const contextHash = RH.canonicalContextHash(RH.normalizeCourseContext(ctx));
      const m = C.manifest;
      const [job] = await ds.query(
        `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, progress, input_payload, output_summary, options, result)
         values ($1, $2, 'dynamic_generation', 'running', 'running', 'dynamic_generation', 0, $3::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) returning id`,
        [OWNER, C.cid, JSON.stringify({ manifestId: m.id, blueprintNumber: 1, contextHash, videoMode: 'real', videoDelivery: 'youtube', providerModes: { presentation: 'real', audio: 'real' } })]);
      await ds.query(`insert into public.generation_run_contexts (job_id, manifest_id, context, context_hash) values ($1, $2, $3::jsonb, $4)`,
        [job.id, m.id, JSON.stringify(RH.normalizeCourseContext(ctx)), contextHash]);
      const items = [...m.manifest.items].sort((a, b) => (a.type === 'video' ? -1 : 0) - (b.type === 'video' ? -1 : 0));
      const videoOf = new Map();
      for (const it of items) {
        let summary = {};
        if (it.type === 'video') {
          const yt = 'Yt' + it.chapterId.replace(/-/g, '').slice(0, 9);
          summary = { mode: videoModeOf(it.chapterId), delivery: 'completed', youtubeVideoId: yt, youtubeUrl: `https://youtu.be/${yt}`, external: { durationSec: 468, videogenJobId: 'vg-' + it.chapterId } };
        }
        if (['presentation', 'audio_welcome', 'audiobook_chapter'].includes(it.type)) summary = { mode: 'real' };
        if (RC.requiresV3Validation(it.type, it.variant)) summary = { ...summary, ...V3VAL };
        if (it.type === 'video_interactions') {
          const v = videoOf.get(it.chapterId);
          summary = { ...summary, sourceVideoItemRunId: v.itemRunId, videoIdentity: v };
        }
        const [ir] = await ds.query(
          `insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key, status, finished_at, output_summary)
           values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9::text[], $10, 'completed', now(), $11::jsonb) returning id`,
          [job.id, C.cid, m.blueprintId, m.id, it.key, it.type, it.moduleId, it.chapterId, it.dependsOn, RH.itemIdempotencyKey(m.id, it.key, 1), JSON.stringify(summary)]);
        const arts = [];
        for (const role of AR.requiredArtifactTypesV3(it.type, it.variant)) {
          const p1 = `beb/${job.id}/${it.key}/${role}`;
          const [a] = await ds.query(
            `insert into public.artifacts (owner_id, course_id, job_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, metadata, module_id, chapter_id, manifest_id, manifest_item_key, item_run_id)
             values ($1, $2, $3, $4, 'supabase', 'cursia-artifacts', $5, 'f', 'application/json', $6::jsonb, $7, $8, $9, $10, $11) returning id`,
            [OWNER, String(C.cid), job.id, role, p1, JSON.stringify(['dynamic_presentation', 'dynamic_audio_mp3'].includes(role) ? { mode: 'real' } : {}), it.moduleId, it.chapterId, m.id, it.key, ir.id]);
          arts.push({ id: a.id, type: role, bucket: 'cursia-artifacts', path: p1 });
        }
        if (it.type === 'video') videoOf.set(it.chapterId, { identity: IA.artifactOutputIdentity(arts), itemRunId: ir.id, generation: 1, artifactIds: arts.map((x) => x.id) });
      }
      return job.id;
    }

    // ════ [AP] paquete final automático ═══════════════════════════════════════
    let AP = null; // run cuyo paquete se hace fallar (lo usa la cola de admin)
    await check('[AP] el run pasa a `completed` (todo real y validado) → DESPUÉS del commit se encola el paquete FINAL solo (sin clic), una vez; el run queda marcado (autoPackage.eligibleAt); completion = packaging con el job en cola', async () => {
      const C = await confirmedCourse('BE-B auto');
      const runId = await seededRealRun(C);
      eq(await recompute(runId), 'completed', 'run completed');
      const jobs = await pkgJobs(runId);
      eq(jobs.length, 1, 'un job de paquete');
      eq([jobs[0].worker_status, jobs[0].input_payload.auto, 'packageKind' in jobs[0].input_payload, jobs[0].owner_id], ['queued', true, false, OWNER], 'job final automático del dueño');
      const run = await jobOf(runId);
      assert(run.output_summary.autoPackage && Number.isFinite(Date.parse(run.output_summary.autoPackage.eligibleAt)), `marca ${JSON.stringify(run.output_summary)}`);
      const dto = await runs.getRun(C.cid, OWNER, 1, runId);
      eq([dto.completion.state, dto.completion.complete, dto.completion.generationComplete, dto.completion.packageJob], ['packaging', false, true, { status: 'queued', autoRetryPending: false, auto: true }], 'completion');
      AP = { C, runId, firstJob: jobs[0].id };
    });

    await check('[AP] idempotente: re-disparo (ensure ×2), barrido y el botón manual del dueño devuelven el MISMO job; en paralelo tampoco se crean dos', async () => {
      const { C, runId, firstJob } = AP;
      const o1 = await autoPkg.ensure(runId);
      const o2 = await autoPkg.ensure(runId, 'sweep');
      // Fix round 1: el barrido solo actúa si el estado declara algo pendiente (un job en cola no lo es).
      eq([o1.action, o1.jobId, o2.action, o2.reason], ['reused', firstJob, 'skipped', 'nothing_pending'], 're-disparos');
      const sw = await autoPkg.sweep();
      assert(!sw.some((o) => o.runId === runId), 'el barrido no toma un run con job activo');
      const man = await packaging.requestPackage(C.cid, OWNER, 1, runId, OWNER_ACTOR);
      eq([man.created, man.jobId, man.packageKind], [false, firstJob, 'final'], 'botón manual = mismo job');
      await Promise.all([autoPkg.ensure(runId), autoPkg.ensure(runId), packaging.requestPackage(C.cid, OWNER, 1, runId, OWNER_ACTOR), autoPkg.sweep()]);
      eq((await pkgJobs(runId)).length, 1, 'sigue habiendo UN job');
      // Desde un fallo: varios disparos simultáneos crean exactamente UN job nuevo (lock por run).
      await failPkg(firstJob);
      await Promise.all([autoPkg.ensure(runId), autoPkg.ensure(runId), autoPkg.ensure(runId, 'sweep'), packaging.requestPackage(C.cid, OWNER, 1, runId, OWNER_ACTOR), autoPkg.sweep()]);
      const jobs = await pkgJobs(runId);
      eq(jobs.map((j) => j.worker_status), ['failed', 'queued'], 'un solo reintento');
    });

    await check('[AP] paquete que falla: mientras queda reintento automático → `packaging` (el barrido lo vuelve a encolar tras la espera, tope 3 intentos); agotado → needs_attention + retry_package (nunca complete); el barrido ya no lo toma; un SUPER_ADMIN lo reintenta con el endpoint existente', async () => {
      const { C, runId } = AP;
      let jobs = await pkgJobs(runId);
      await failPkg(jobs[1].id, 0); // recién fallado: dentro de la espera
      let dto = await runs.getRun(C.cid, OWNER, 1, runId);
      eq([dto.completion.state, dto.completion.packageJob], ['packaging', { status: 'failed', autoRetryPending: true, auto: true }], '2/3: reintento pendiente');
      assert(!(await autoPkg.sweep()).some((o) => o.runId === runId), 'dentro de la espera no reintenta');
      await ds.query(`update public.production_jobs set finished_at = now() - interval '5 minutes', updated_at = now() - interval '5 minutes' where id = $1`, [jobs[1].id]);
      const sw = await autoPkg.sweep();
      eq(sw.filter((o) => o.runId === runId).map((o) => o.action), ['enqueued'], 'el barrido encola el 3.º intento');
      jobs = await pkgJobs(runId);
      eq(jobs.length, 3, 'tres jobs');
      await failPkg(jobs[2].id);
      dto = await runs.getRun(C.cid, OWNER, 1, runId);
      eq([dto.completion.state, dto.completion.complete, dto.completion.adminActions, dto.completion.packageJob],
        ['needs_attention', false, [{ code: 'retry_package' }], { status: 'failed', autoRetryPending: false, auto: true }], 'agotado');
      assert(!(await autoPkg.sweep()).some((o) => o.runId === runId), 'agotado: el barrido no lo toma');
      eq((await autoPkg.ensure(runId)).reason, 'attempts_exhausted', 'ensure tampoco');
      eq((await pkgJobs(runId)).length, 3, 'sin jobs nuevos');
      // La acción retry_package = POST …/package (existente) por un SUPER_ADMIN sobre el curso del cliente.
      const res = await packaging.requestPackage(C.cid, ADMIN_X.id, 1, runId, ADMIN_X);
      eq([res.created, res.packageKind, res.deliverable], [true, 'final', true], 'reintento de admin');
      dto = await runs.getRun(C.cid, OWNER, 1, runId);
      eq(dto.completion.state, 'packaging', 'vuelve a packaging');
      await failPkg(res.jobId); // para la cola de admin: queda needs_attention
    });

    let BLK = null;
    let BLK403 = null;
    await check('[AP] fix I2: precheck que no deja encolar (409 youtube_delivery_incomplete con el video que falta) → nada encolado; código + mensaje + faltantes en la marca y en completion.packageJob.blocked; la acción es la del COMPONENTE (resolve_youtube del video), nunca retry_package; el barrido no lo reintenta', async () => {
      const C = await confirmedCourse('BE-B precheck');
      const runId = await seededRealRun(C);
      blockedPrecheck.set(runId, { code: 'youtube_delivery_incomplete', missing: [`video:${C.c2}:missing_youtube_url`, `video:${C.c2}:youtube_delivery_not_completed`] });
      eq(await recompute(runId), 'completed', 'run completed');
      eq((await pkgJobs(runId)).length, 0, 'sin job');
      const run = await jobOf(runId);
      eq([run.output_summary.autoPackage.blocked.code, run.output_summary.autoPackage.blocked.missing.length], ['youtube_delivery_incomplete', 2], 'bloqueo registrado');
      const dto = await runs.getRun(C.cid, OWNER, 1, runId);
      eq([dto.completion.state, dto.completion.adminActions], ['needs_attention', [{ code: 'resolve_youtube', itemKey: `video:${C.c2}`, reason: 'youtube_delivery_incomplete' }]], 'acción del componente');
      eq([dto.completion.packageJob.status, dto.completion.packageJob.blocked.code, /precheck simulado/.test(dto.completion.packageJob.blocked.message)], ['failed', 'youtube_delivery_incomplete', true], 'packageJob.blocked');
      assert(!dto.completion.adminActions.some((a) => a.code === 'retry_package'), 'sin retry_package');
      assert(!(await autoPkg.sweep()).some((o) => o.runId === runId), 'el barrido no lo toma');
      blockedPrecheck.delete(runId);
      BLK = { C, runId };
      // Bloqueo sin componente (403: dueño fuera de la allow-list) → resolve_package_block con el código.
      const C2 = await confirmedCourse('BE-B precheck 403');
      const r2 = await seededRealRun(C2);
      blockedPrecheck.set(r2, { status: 403 });
      eq(await recompute(r2), 'completed', 'run completed');
      const d2 = await runs.getRun(C2.cid, OWNER, 1, r2);
      eq([d2.completion.state, d2.completion.adminActions, d2.completion.packageJob.blocked.code], ['needs_attention', [{ code: 'resolve_package_block', reason: 'http_403' }], 'http_403'], '403');
      blockedPrecheck.delete(r2);
      BLK403 = { C: C2, runId: r2 };
    });

    await check('[AP] runs de vista previa y fallidos → NUNCA un paquete automático (ni marca); el disparo manual de ensure tampoco', async () => {
      const Cp = await confirmedCourse('BE-B preview');
      const rp = await seededRealRun(Cp, { videoModeOf: () => 'mock' });
      eq(await recompute(rp), 'preview', 'run preview');
      const Cf = await confirmedCourse('BE-B failed');
      const rf = await seededRealRun(Cf);
      const v = await latest(rf, `video:${Cf.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'videogen_failed: render rechazado', finished_at = now() where id = $1`, [v.id]);
      const vi = await latest(rf, `video_interactions:${Cf.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'blocked' where id = $1`, [vi.id]);
      eq(await recompute(rf), 'failed', 'run failed');
      for (const id of [rp, rf]) {
        eq((await pkgJobs(id)).length, 0, `sin job (${id})`);
        assert(!(await jobOf(id)).output_summary.autoPackage, 'sin marca');
        assert(/^not_completed/.test((await autoPkg.ensure(id)).reason), 'ensure lo rechaza');
      }
      eq((await pkgJobs(rp)).length + (await pkgJobs(rf)).length, 0, 'nada encolado');
    });

    let OLD = null;
    await check('[AP] run VIEJO `completed` (anterior a BE-B, sin marca) → nunca se empaqueta solo ni se toca (fila byte-idéntica); un rollback de la transición tampoco encola', async () => {
      const C = await confirmedCourse('BE-B viejo');
      const runId = await seededRealRun(C);
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', progress = 100,
        finished_at = now() - interval '10 days', updated_at = now() - interval '10 days' where id = $1`, [runId]);
      const before = await jobOf(runId);
      eq((await autoPkg.ensure(runId)).reason, 'not_eligible', 'ensure');
      assert(!(await autoPkg.sweep()).some((o) => o.runId === runId), 'barrido');
      const dtoOld = await runs.getRun(C.cid, OWNER, 1, runId);
      eq([dtoOld.completion.state, dtoOld.completion.packageJob], ['packaging', { status: 'none', autoRetryPending: false, auto: false }], 'sin empaque automático: el paquete se pide a mano');
      const after = await jobOf(runId);
      eq([JSON.stringify(after.output_summary), String(after.updated_at), after.worker_status], [JSON.stringify(before.output_summary), String(before.updated_at), before.worker_status], 'fila intacta');
      eq((await pkgJobs(runId)).length, 0, 'sin job');
      OLD = { C, runId };
      // Rollback: la transición se deshace → el aviso no ocurre.
      const C2 = await confirmedCourse('BE-B rollback');
      const r2 = await seededRealRun(C2);
      await rejectsRe(runs.tx(async (qr) => { await T.recomputeRunStatus(qr, r2); throw new Error('boom después de la transición'); }), /boom/, 'tx');
      await runs.settleRunCompletedHooks();
      eq([(await jobOf(r2)).worker_status, (await pkgJobs(r2)).length], ['running', 0], 'rollback: run sigue activo y sin job');
    });

    await check('[AP] DYNAMIC_AUTO_PACKAGE_ENABLED=false apaga el disparo y el barrido (el botón manual sigue)', async () => {
      process.env.DYNAMIC_AUTO_PACKAGE_ENABLED = 'false';
      try {
        const C = await confirmedCourse('BE-B apagado');
        const runId = await seededRealRun(C);
        eq(await recompute(runId), 'completed', 'completed');
        eq((await pkgJobs(runId)).length, 0, 'sin job automático');
        eq((await autoPkg.sweep()).length, 0, 'barrido apagado');
        eq((await packaging.requestPackage(C.cid, OWNER, 1, runId, OWNER_ACTOR)).created, true, 'manual sigue');
      } finally {
        delete process.env.DYNAMIC_AUTO_PACKAGE_ENABLED;
      }
    });

    let STALE_OLD = null;
    await check('[AP] fix I1: paquete automático COMPLETADO y vigente → complete; deja de ser vigente sin builder nuevo (p.ej. tema) → needs_attention + retry_package (nunca packaging sin nada pendiente); con builder nuevo → packaging y el barrido lo RE-ARMA (mismos topes)', async () => {
      const C = await confirmedCourse('BE-B vigencia');
      const runId = await seededRealRun(C);
      eq(await recompute(runId), 'completed', 'completed');
      const [j1] = await pkgJobs(runId);
      await completeJob(j1.id);
      deliverableJobs.add(j1.id);
      let dto = await runs.getRun(C.cid, OWNER, 1, runId);
      eq([dto.completion.state, dto.completion.complete, dto.completion.packageJob], ['complete', true, { status: 'completed', autoRetryPending: false, auto: true }], 'vigente');
      // Deja de ser vigente (mismo builder): no hay reconstrucción automática → acción visible.
      deliverableJobs.delete(j1.id);
      dto = await runs.getRun(C.cid, OWNER, 1, runId);
      eq([dto.completion.state, dto.completion.adminActions, dto.completion.packageJob], ['needs_attention', [{ code: 'retry_package' }], { status: 'stale', autoRetryPending: false, auto: true }], 'no vigente sin reconstrucción automática');
      assert(!(await autoPkg.sweep()).some((o) => o.runId === runId), 'el barrido no lo toma');
      // Builder nuevo (el job se armó con otra versión): pendiente → packaging, y el barrido lo re-arma.
      await ds.query(`update public.production_jobs set output_summary = output_summary || '{"builderVersion":"3.5.0"}'::jsonb where id = $1`, [j1.id]);
      staleBuildRuns.add(runId);
      dto = await runs.getRun(C.cid, OWNER, 1, runId);
      eq([dto.completion.state, dto.completion.packageJob], ['packaging', { status: 'stale', autoRetryPending: true, auto: true }], 'builder nuevo: re-armado pendiente');
      const sw = await autoPkg.sweep();
      eq(sw.filter((o) => o.runId === runId).map((o) => o.action), ['enqueued'], 're-armado por el barrido');
      eq((await pkgJobs(runId)).map((j) => j.worker_status), ['completed', 'queued'], 'un job nuevo');
      dto = await runs.getRun(C.cid, OWNER, 1, runId);
      eq([dto.completion.state, dto.completion.packageJob.status], ['packaging', 'queued'], 'armándose');
      // Mismos topes: 3 fallos desde la marca → agotado → needs_attention + retry_package.
      for (let i = 0; i < 3; i++) {
        const jobs = await pkgJobs(runId);
        const last = jobs[jobs.length - 1];
        if (last.worker_status === 'queued') await failPkg(last.id);
        await autoPkg.sweep();
      }
      const fails = (await pkgJobs(runId)).filter((j) => j.worker_status === 'failed').length;
      eq(fails, 3, 'tres intentos fallidos');
      eq((await pkgJobs(runId)).filter((j) => j.worker_status === 'queued').length, 0, 'sin un cuarto intento');
      dto = await runs.getRun(C.cid, OWNER, 1, runId);
      eq([dto.completion.state, dto.completion.adminActions], ['needs_attention', [{ code: 'retry_package' }]], 'agotado');
      staleBuildRuns.delete(runId);
      // Run VIEJO (sin marca) con un paquete final de un builder anterior → packaging con auto:false; nunca se toca solo.
      const Co = await confirmedCourse('BE-B viejo builder');
      const ro = await seededRealRun(Co);
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now() - interval '9 days' where id = $1`, [ro]);
      const [jo] = await ds.query(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, input_payload, output_summary, options, result)
        values ($1, $2, 'dynamic_package', 'completed', 'completed', 'dynamic_package', $3::jsonb, $4::jsonb, '{}'::jsonb, '{}'::jsonb) returning id`,
        [OWNER, Co.cid, JSON.stringify({ runId: ro, manifestId: Co.manifest.id, blueprintNumber: 1 }), JSON.stringify({ artifactId: crypto.randomUUID(), builderVersion: '3.0.0', sourceIdsHash: 'o'.repeat(64) })]);
      const before = JSON.stringify(await jobOf(ro));
      dto = await runs.getRun(Co.cid, OWNER, 1, ro);
      eq([dto.completion.state, dto.completion.packageJob, dto.completion.adminActions], ['packaging', { status: 'stale', autoRetryPending: false, auto: false }, []], 'viejo: acción manual');
      assert(!(await autoPkg.sweep()).some((o) => o.runId === ro), 'el barrido no toca runs viejos');
      eq([JSON.stringify(await jobOf(ro)), (await pkgJobs(ro)).length, jo.id.length > 0], [before, 1, true], 'run viejo intacto, sin jobs nuevos');
      STALE_OLD = { C: Co, runId: ro };
    });

    await check('[AP] fix M2: re-completitud con el MISMO build (job completado antes de la marca nueva) → el barrido lo confirma UNA vez (satisfiedJobId) y no lo vuelve a evaluar en cada tick', async () => {
      const C = await confirmedCourse('BE-B mismo build');
      const runId = await seededRealRun(C);
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now() where id = $1`, [runId]);
      const [j] = await ds.query(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, input_payload, output_summary, options, result, created_at)
        values ($1, $2, 'dynamic_package', 'completed', 'completed', 'dynamic_package', $3::jsonb, $4::jsonb, '{}'::jsonb, '{}'::jsonb, now() - interval '1 hour') returning id`,
        [OWNER, C.cid, JSON.stringify({ runId, manifestId: C.manifest.id, blueprintNumber: 1 }), JSON.stringify({ artifactId: crypto.randomUUID(), builderVersion: CUR_BUILDER, sourceIdsHash: 's'.repeat(64) })]);
      // Marca de una re-completitud cuyo disparo se perdió.
      await ds.query(`update public.production_jobs set output_summary = output_summary || jsonb_build_object('autoPackage', jsonb_build_object('eligibleAt', now())) where id = $1`, [runId]);
      let sw = await autoPkg.sweep();
      eq(sw.filter((o) => o.runId === runId).map((o) => [o.action, o.jobId]), [['reused', j.id]], 'confirmado (mismo build)');
      eq((await jobOf(runId)).output_summary.autoPackage.satisfiedJobId, j.id, 'satisfiedJobId');
      sw = await autoPkg.sweep();
      eq(sw.filter((o) => o.runId === runId).length, 0, 'no vuelve a evaluarlo');
      eq((await pkgJobs(runId)).length, 1, 'sin jobs nuevos');
    });

    await check('[AP] fix M1: error transitorio del empaque automático (sin job) → cuenta contra su tope con espera; agotado → needs_attention + retry_package', async () => {
      const C = await confirmedCourse('BE-B transitorio');
      const runId = await seededRealRun(C);
      const orig = packaging.requestPackage.bind(packaging);
      packaging.requestPackage = async (...a) => { if (a[3] === runId) throw new Error('EMAXCONNSESSION simulado'); return orig(...a); };
      try {
        eq(await recompute(runId), 'completed', 'completed');
        eq((await jobOf(runId)).output_summary.autoPackage.transient.count, 1, 'transitorio contado');
        assert(!(await autoPkg.sweep()).some((o) => o.runId === runId), 'dentro de la espera no reintenta');
        await ds.query(`update public.production_jobs set output_summary = jsonb_set(output_summary, '{autoPackage,transient,at}', to_jsonb((now() - interval '10 minutes')::text)) where id = $1`, [runId]);
        eq((await autoPkg.sweep()).filter((o) => o.runId === runId).map((o) => o.reason), ['transient_error'], 'pasada la espera reintenta');
        let dto = await runs.getRun(C.cid, OWNER, 1, runId);
        eq([dto.completion.state, dto.completion.packageJob], ['packaging', { status: 'none', autoRetryPending: true, auto: true }], 'pendiente');
        await ds.query(`update public.production_jobs set output_summary = jsonb_set(output_summary, '{autoPackage,transient}', jsonb_build_object('count', 5, 'at', (now() - interval '1 hour')::text)) where id = $1`, [runId]);
        assert(!(await autoPkg.sweep()).some((o) => o.runId === runId), 'agotado: el barrido no lo toma');
        dto = await runs.getRun(C.cid, OWNER, 1, runId);
        eq([dto.completion.state, dto.completion.adminActions], ['needs_attention', [{ code: 'retry_package' }]], 'agotado → acción visible');
      } finally {
        packaging.requestPackage = orig;
      }
    });

    // ════ DoD follow-up: R2 (tick apagado) y R8 (SQL ≡ estado) ═══════════════
    const withAutoHealOff = async (fn) => {
      const prev = process.env.DYNAMIC_AUTO_HEAL_ENABLED;
      process.env.DYNAMIC_AUTO_HEAL_ENABLED = 'false';
      try { return await fn(); } finally { if (prev === undefined) delete process.env.DYNAMIC_AUTO_HEAL_ENABLED; else process.env.DYNAMIC_AUTO_HEAL_ENABLED = prev; }
    };
    let R2RUN = null;
    await check('[AP] follow-up R2: con el tick del barrido apagado (DYNAMIC_AUTO_HEAL_ENABLED=false) nada queda «pendiente»: re-armado por builder nuevo, reintento de un fallo o run sin job → needs_attention + retry_package (acción manual/admin), nunca `packaging` para siempre; solo un run recién marcado sin job (el aviso post-commit lo encola) espera la gracia; con el tick encendido → packaging como antes', async () => {
      const C = await confirmedCourse('BE-B R2 builder');
      const runId = await seededRealRun(C);
      eq(await recompute(runId), 'completed', 'completed');
      const [j1] = await pkgJobs(runId);
      await completeJob(j1.id, '3.5.0'); // builder anterior
      staleBuildRuns.add(runId);
      try {
        let dto = await runs.getRun(C.cid, OWNER, 1, runId);
        eq([dto.completion.state, dto.completion.packageJob], ['packaging', { status: 'stale', autoRetryPending: true, auto: true }], 'tick encendido: re-armado pendiente');
        await withAutoHealOff(async () => {
          dto = await runs.getRun(C.cid, OWNER, 1, runId);
          eq([dto.completion.state, dto.completion.adminActions, dto.completion.packageJob], ['needs_attention', [{ code: 'retry_package' }], { status: 'stale', autoRetryPending: false, auto: true }], 'tick apagado: acción visible');
          const list = await recovery.listNeedsAttention({ limit: 500 });
          assert(list.needsAttention.some((e) => e.runId === runId && e.adminActions.some((a) => a.code === 'retry_package')), 'aparece en la cola de admin con retry_package');
        });
        // Fallo con reintento disponible: igual (nadie lo reintenta sin el tick).
        const res = await packaging.requestPackage(C.cid, ADMIN_X.id, 1, runId, ADMIN_X);
        await failPkg(res.jobId);
        dto = await runs.getRun(C.cid, OWNER, 1, runId);
        eq([dto.completion.state, dto.completion.packageJob.status, dto.completion.packageJob.autoRetryPending], ['packaging', 'failed', true], 'tick encendido: reintento pendiente');
        await withAutoHealOff(async () => {
          dto = await runs.getRun(C.cid, OWNER, 1, runId);
          eq([dto.completion.state, dto.completion.adminActions], ['needs_attention', [{ code: 'retry_package' }]], 'tick apagado: fallo → acción');
        });
      } finally {
        staleBuildRuns.delete(runId);
      }
      // Run recién marcado SIN job (el aviso post-commit todavía no encoló): gracia; vencida → acción.
      const C2 = await confirmedCourse('BE-B R2 sin job');
      const r2 = await seededRealRun(C2);
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now(),
        output_summary = output_summary || jsonb_build_object('autoPackage', jsonb_build_object('eligibleAt', now())) where id = $1`, [r2]);
      await withAutoHealOff(async () => {
        let d2 = await runs.getRun(C2.cid, OWNER, 1, r2);
        eq([d2.completion.state, d2.completion.packageJob], ['packaging', { status: 'none', autoRetryPending: true, auto: true }], 'gracia del aviso post-commit');
        await ds.query(`update public.production_jobs set output_summary = jsonb_set(output_summary, '{autoPackage,eligibleAt}', to_jsonb((now() - interval '10 minutes')::text)) where id = $1`, [r2]);
        d2 = await runs.getRun(C2.cid, OWNER, 1, r2);
        eq([d2.completion.state, d2.completion.adminActions, d2.completion.packageJob], ['needs_attention', [{ code: 'retry_package' }], { status: 'none', autoRetryPending: false, auto: true }], 'gracia vencida → acción');
      });
      const d3 = await runs.getRun(C2.cid, OWNER, 1, r2);
      eq([d3.completion.state, d3.completion.packageJob.autoRetryPending], ['packaging', true], 'tick encendido: el barrido lo toma');
      R2RUN = { C: C2, runId: r2 };
    });

    await check('[AP] follow-up R8: el SQL del barrido clasifica «final» EXACTAMENTE como packageKindOf (mismos jobs, también los anteriores sin packageKind con videos omitidos / mocks)', async () => {
      const C = await confirmedCourse('BE-B R8 clasificación');
      const runId = await seededRealRun(C);
      const PFR2 = L('modules/dynamic-packaging/package-freshness.js');
      const variants = [
        [{}, {}], [{ packageKind: 'qa_preview' }, {}], [{ packageKind: 'degraded' }, {}], [{}, { packageKind: 'qa_preview' }], [{ packageKind: 'final' }, { packageKind: 'degraded' }],
        [{}, { packageKind: 'raro', pendingVideos: [] }], [{}, { pendingVideos: [{ itemKey: 'video:x' }] }], [{}, { pendingVideos: [] }], [{}, { pendingVideos: 'x' }],
        [{}, { mockProviderItems: ['presentation:x'] }], [{}, { mockProviderItems: [] }], [{}, { mockProviderItems: 2 }], [{}, { mockProviderItems: 0 }],
        [{}, { mockProviderItems: '3' }], [{}, { mockProviderItems: ' 0 ' }], [{}, { mockProviderItems: true }], [{}, { mockProviderItems: false }], [{}, { mockProviderItems: 'abc' }],
        [{ packageKind: 'raro' }, { mockProviderItems: 1 }], [{ packageKind: 'qa_preview' }, { packageKind: 'final' }],
      ];
      const ids = [];
      for (const [ip, os] of variants) {
        const [j] = await ds.query(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, input_payload, output_summary, options, result)
          values ($1, $2, 'dynamic_package', 'failed', 'failed', 'dynamic_package', $3::jsonb, $4::jsonb, '{}'::jsonb, '{}'::jsonb) returning id`,
          [OWNER, C.cid, JSON.stringify({ runId, manifestId: C.manifest.id, blueprintNumber: 1, ...ip }), JSON.stringify(os)]);
        ids.push(j.id);
      }
      const rows = await ds.query(`select p.id, p.input_payload, p.output_summary, ${APS.finalPackageKindSql('p')} as fin from public.production_jobs p where p.id = any($1::uuid[])`, [ids]);
      const diff = rows.filter((r) => r.fin !== (PFR2.packageKindOf(r) === 'final')).map((r) => [r.input_payload.packageKind, r.output_summary, r.fin]);
      eq(diff, [], 'SQL ≡ packageKindOf');
      eq(rows.length, variants.length, 'todas evaluadas');
      await ds.query(`delete from public.production_jobs where id = any($1::uuid[])`, [ids]);
    });

    await check('[AP] follow-up R8: un run nunca queda «seleccionado y saltado» en cada tick — un paquete anterior de vista previa (sin packageKind) con builder viejo no lo selecciona fuera de la ventana; un bloqueo superado por un job final posterior vuelve a contar como en el estado; lo que el SQL elige y el estado no declara pendiente queda registrado (lastSkip) y espera; los saltos por Blueprint irresoluble o error de lectura cuentan como transitorios', async () => {
      // (a) job anterior «de vista previa» (pendingVideos, sin packageKind) con builder viejo; marca fuera de la ventana.
      const C = await confirmedCourse('BE-B R8 preview viejo');
      const runId = await seededRealRun(C);
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now(),
        output_summary = output_summary || jsonb_build_object('autoPackage', jsonb_build_object('eligibleAt', (now() - interval '100 hours')::text)) where id = $1`, [runId]);
      await ds.query(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, input_payload, output_summary, options, result, created_at)
        values ($1, $2, 'dynamic_package', 'completed', 'completed', 'dynamic_package', $3::jsonb, $4::jsonb, '{}'::jsonb, '{}'::jsonb, now() - interval '101 hours')`,
        [OWNER, C.cid, JSON.stringify({ runId, manifestId: C.manifest.id, blueprintNumber: 1 }),
          JSON.stringify({ artifactId: crypto.randomUUID(), builderVersion: '3.0.0', sourceIdsHash: 'v'.repeat(64), pendingVideos: [{ itemKey: `video:${C.c1}` }] })]);
      let cands = await APS.findAutoPackageCandidates(ds, new Date(), 500);
      assert(!cands.includes(runId), 'el SQL no lo selecciona (el estado tampoco lo ve pendiente)');
      let dto = await runs.getRun(C.cid, OWNER, 1, runId);
      eq([dto.completion.state, dto.completion.packageJob], ['needs_attention', { status: 'none', autoRetryPending: false, auto: true }], 'estado: acción visible, sin pendiente');
      // (b) bloqueo superado por un job final posterior (p.ej. el POST del admin) que falló: SQL y estado coinciden.
      const C2 = await confirmedCourse('BE-B R8 bloqueo superado');
      const r2 = await seededRealRun(C2);
      blockedPrecheck.set(r2, { code: 'youtube_delivery_incomplete', missing: [`video:${C2.c2}:missing_youtube_url`] });
      eq(await recompute(r2), 'completed', 'completed (bloqueado)');
      blockedPrecheck.delete(r2);
      const adm = await packaging.requestPackage(C2.cid, ADMIN_X.id, 1, r2, ADMIN_X);
      await failPkg(adm.jobId);
      dto = await runs.getRun(C2.cid, OWNER, 1, r2);
      eq([dto.completion.state, dto.completion.packageJob.status, dto.completion.packageJob.autoRetryPending], ['packaging', 'failed', true], 'estado: reintento pendiente (el bloqueo quedó atrás)');
      cands = await APS.findAutoPackageCandidates(ds, new Date(), 500);
      assert(cands.includes(r2), 'el SQL también lo selecciona (antes lo excluía para siempre)');
      eq((await autoPkg.sweep({ limit: 500 })).filter((o) => o.runId === r2).map((o) => o.action), ['enqueued'], 'el barrido lo reintenta');
      // (c) seleccionado por el SQL y sin nada pendiente para el estado (barrido corriendo con el tick apagado) → lastSkip + espera.
      const C3 = await confirmedCourse('BE-B R8 lastSkip');
      const r3 = await seededRealRun(C3);
      eq(await recompute(r3), 'completed', 'completed');
      const [j3] = await pkgJobs(r3);
      await completeJob(j3.id, '3.5.0');
      staleBuildRuns.add(r3);
      try {
        await withAutoHealOff(async () => {
          const o1 = (await autoPkg.sweep({ limit: 500 })).filter((o) => o.runId === r3);
          eq(o1.map((o) => o.reason), ['nothing_pending'], 'seleccionado y saltado una vez');
          eq((await jobOf(r3)).output_summary.autoPackage.lastSkip.reason, 'nothing_pending', 'registrado');
          eq((await autoPkg.sweep({ limit: 500 })).filter((o) => o.runId === r3).length, 0, 'no se vuelve a seleccionar en el tick siguiente');
        });
        await ds.query(`update public.production_jobs set output_summary = jsonb_set(output_summary, '{autoPackage,lastSkip,at}', to_jsonb((now() - interval '10 minutes')::text)) where id = $1`, [r3]);
        eq((await autoPkg.sweep({ limit: 500 })).filter((o) => o.runId === r3).map((o) => o.action), ['enqueued'], 'pasada la espera, con el tick: re-armado');
      } finally {
        staleBuildRuns.delete(r3);
      }
      // (d) Blueprint irresoluble y error de lectura → transitorios (tope + espera), nunca un salto mudo.
      const C4 = await confirmedCourse('BE-B R8 transitorios');
      const r4 = await seededRealRun(C4);
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now(),
        output_summary = output_summary || jsonb_build_object('autoPackage', jsonb_build_object('eligibleAt', now())),
        input_payload = input_payload || '{"manifestId": 987654321}'::jsonb where id = $1`, [r4]);
      eq((await autoPkg.ensure(r4)).reason, 'manifest_unresolvable', 'Blueprint irresoluble');
      eq((await jobOf(r4)).output_summary.autoPackage.transient.count, 1, 'contado como transitorio');
      const origQ = ds.query.bind(ds);
      ds.query = async (sql, params) => { if (/limit 50/.test(String(sql)) && params && params[0] === r4) throw new Error('ECONNRESET simulado'); return origQ(sql, params); };
      try {
        eq((await autoPkg.ensure(r4)).reason, 'transient_error', 'error de lectura');
      } finally {
        ds.query = origQ;
      }
      eq((await jobOf(r4)).output_summary.autoPackage.transient.count, 2, 'contado como transitorio');
      // Sin dejar un run roto para la cola de admin de los casos siguientes.
      await ds.query(`update public.production_jobs set input_payload = input_payload || jsonb_build_object('manifestId', $2::bigint) where id = $1`, [r4, C4.manifest.id]);
    });

    // ════ [AR] reintento automático SEGURO (worker real + Videogen falso) ══════
    const ytPublisher = {
      async getConnection() { return { userId: OWNER, status: 'active', scopes: 'youtube.upload,youtube.readonly' }; },
      async getAccessToken() { return 'fake-access'; },
      async uploadFromUrl(_c, options) { await options.onBeforeUpload(syntheticMp4WithMvhd(120, 'beb')); const id = `Yb${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`; return { videoId: id, youtubeUrl: `https://www.youtube.com/watch?v=${id}` }; },
    };
    const vgFake = (behavior) => {
      const st = { submits: 0 };
      return {
        st,
        async batchCreate() {
          st.submits++;
          if (behavior === '422') throw new Error('Videogen batch-create failed (HTTP 422): invalid content');
          if (behavior === 'timeout') throw new Error('The operation was aborted due to timeout');
          return { batch_id: `b_${st.submits}`, jobs: [{ job_id: `vg_beb_${crypto.randomUUID().slice(0, 8)}` }] };
        },
        async getVideoStatus(id) {
          if (behavior === 'renderfail') return { job_id: id, status: 'failed', download_url: null, progress: 100, error: 'render error' };
          return { job_id: id, status: 'completed_local', download_url: 'https://fake-videogen.invalid/x.mp4', progress: 100, error: null };
        },
        async getVideoCost() { return { estimated_total_cost: 0.9 }; },
      };
    };
    const quietLogger = { log() {}, warn() {}, error() {} };
    const videoDeps = (videogen) => ({
      scheduler: sched, dataSource: ds, artifacts: { getDownloadUrl: (id, o) => artifacts.getDownloadUrl(id, o), uploadJsonArtifact: (i) => artifacts.uploadJsonArtifact(i) },
      videogen, youtube: ytPublisher, logger: quietLogger, executorId: 'beb-item-worker', leaseSeconds: 120, heartbeatMs: 600000,
      videoTimeoutMin: 1, videoPollMs: 5, mockScenario: 'success', mockResolvePolls: 1, finops: ledger, budget,
    });
    const claimVideo = (rid) => sched.claimNextItem({ executorId: 'beb-item-worker', types: ['video'], leaseSeconds: 120, runId: rid });
    async function seedDependency(runId, key, type, body, mime) {
      const row = await latest(runId, key);
      const p = `${OWNER}/dynamic/beb/${runId}/${key.replace(/[^A-Za-z0-9._-]/g, '_')}.${type}`;
      storage.blobs.set(`cursia-artifacts/${p}`, Buffer.from(body));
      await ds.query(
        `insert into public.artifacts (owner_id, course_id, job_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, metadata, module_id, chapter_id, manifest_id, manifest_item_key, item_run_id)
         values ($1, $2, $3, $4, 'supabase', 'cursia-artifacts', $5, 'f', $6, '{}'::jsonb, $7, $8, $9, $10, $11)`,
        [OWNER, String(row.course_id), runId, type, p, mime, row.module_id, row.chapter_id, row.manifest_id, key, row.id]);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where id = $1`, [row.id]);
    }
    const CONTENT_MD = (t) => `# ${t}\n\nLa bomba de engranajes mueve el aceite a presión constante. El técnico revisa ruido, temperatura y caudal.\n\n## Mantenimiento\n\nSe cambia el filtro.`;
    /** Run REAL arrancado por el camino normal (estimado → aprobación de admin → start), con el content del cap. 1 listo. */
    async function freshRun(title) {
      const K = await confirmedCourse(title, { c2Video: false, c2Title: 'Válvulas' });
      const e = await rejectsRe(runs.startRun(K.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' }), /^budget_approval_required/, `aprobación ${title}`, 409);
      await budget.adminAuthorize({ courseId: K.cid, estimateId: e.getResponse().estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test' });
      const rid = (await runs.startRun(K.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      await seedDependency(rid, `content:${K.c1}`, 'dynamic_content_md', CONTENT_MD('Bombas'), 'text/markdown');
      return { ...K, rid, vkey: `video:${K.c1}` };
    }
    const reservationsOf = (itemRunId) => ds.query(`select settled from public.generation_cost_events where item_run_id = $1 and provider = 'videogen' and idempotency_key like 'reservation:%' order by created_at, id`, [itemRunId])
      .then((rows) => rows.map((x) => x.settled)).catch(async () => {
        const rows = await ds.query(`select * from public.generation_cost_events where item_run_id = $1 and provider = 'videogen' order by created_at, id`, [itemRunId]);
        return rows.map((x) => (x.metadata && x.metadata.settled) ?? x.settled ?? null);
      });
    const finopsCounts = async (cid) => (await ds.query(
      `select (select count(*)::int from public.cost_estimates where course_id = $1) as estimates,
              (select count(*)::int from public.cost_budget_authorizations where course_id = $1) as auths`, [cid]))[0];
    const later = (mins) => new Date(Date.now() + mins * 60_000);

    let REJ2 = null;
    await check('[AR] videogen_submit_rejected (4xx, reserva liberada) → UN reintento automático tras la espera (archiva el marcador, sin reconocer pagos, sin estimados ni aprobaciones nuevas) → el worker reenvía UNA vez y completa', async () => {
      const R = await freshRun('BE-B rechazo');
      let vg = vgFake('422');
      await IW.processItem(videoDeps(vg), await claimVideo(R.rid));
      let row = await latest(R.rid, R.vkey);
      eq([row.status, /^videogen_submit_rejected: .*HTTP 422/.test(row.error), vg.st.submits], ['failed', true, 1], `rechazo (${row.error})`);
      assert(row.output_summary.externalSubmitStartedAt && !(row.output_summary.external && row.output_summary.external.videogenJobId), 'marcador sin job (como lo deja el worker)');
      const f0 = await finopsCounts(R.cid);
      let res = await runs.autoRetrySafeRejections({ now: new Date() });
      eq(res.retried.filter((x) => x.runId === R.rid).length, 0, 'dentro de la espera: no');
      res = await runs.autoRetrySafeRejections({ now: later(3) });
      eq(res.retried.filter((x) => x.runId === R.rid), [{ runId: R.rid, itemKey: R.vkey, code: 'videogen_submit_rejected' }], 'reintentado');
      row = await latest(R.rid, R.vkey);
      const os0 = row.output_summary;
      const last = os0.previousErrors[os0.previousErrors.length - 1];
      eq([row.status, os0.safeAutoRetry.rounds, !!os0.externalSubmitStartedAt, os0.previousExternals.length, last.auto, last.safeAutoRetry, os0.reconciliationAcknowledgedThroughAttempt, row.max_attempts - row.attempt_count],
        ['pending', 1, false, 1, true, true, 0, 1], 'reapertura segura');
      eq(await finopsCounts(R.cid), f0, 'sin estimados ni aprobaciones nuevas');
      vg = vgFake('ok');
      await IW.processItem(videoDeps(vg), await claimVideo(R.rid));
      row = await latest(R.rid, R.vkey);
      eq([row.status, vg.st.submits], ['completed', 1], `reenvío único y completa (${row.error})`);
      eq((await runs.autoRetrySafeRejections({ now: later(10) })).retried.filter((x) => x.runId === R.rid).length, 0, 'nada más que reintentar');
    });

    await check('[AR] rechazado OTRA vez después de su reintento automático → no hay segundo reintento; el curso termina needs_attention con retry_video_render (admin); el dueño no puede reenviar (403)', async () => {
      const R = await freshRun('BE-B rechazo doble');
      await IW.processItem(videoDeps(vgFake('422')), await claimVideo(R.rid));
      eq((await runs.autoRetrySafeRejections({ now: later(3) })).retried.filter((x) => x.runId === R.rid).length, 1, 'primer reintento');
      const vg = vgFake('422');
      await IW.processItem(videoDeps(vg), await claimVideo(R.rid));
      let row = await latest(R.rid, R.vkey);
      eq([row.status, vg.st.submits, /^videogen_submit_rejected/.test(row.error)], ['failed', 1, true], 'segundo rechazo');
      const res = await runs.autoRetrySafeRejections({ now: later(30) });
      eq(res.retried.filter((x) => x.runId === R.rid).length, 0, 'sin segundo reintento automático');
      eq(AH.safeAutoRetryDecision(row, later(30)).reason, 'cap_reached', 'tope');
      eq((await runs.autoHealFailedItems({ now: later(30) })).reopened.filter((x) => x.runId === R.rid).length, 0, 'el auto-healer tampoco');
      // El resto del curso termina (como lo harían el navegador y los workers).
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now(), output_summary = output_summary || $2::jsonb
                       where job_id = $1 and status in ('pending', 'retrying')`, [R.rid, JSON.stringify({ mode: 'real', ...V3VAL })]);
      eq(await recompute(R.rid), 'failed', 'run failed');
      const dto = await runs.getRun(R.cid, OWNER, 1, R.rid);
      eq(dto.completion.state, 'needs_attention', 'needs_attention');
      assert(dto.completion.adminActions.some((a) => a.code === 'retry_video_render' && a.itemKey === R.vkey), `acciones ${JSON.stringify(dto.completion.adminActions)}`);
      await rejectsRe(runs.retryItem(R.cid, OWNER, 1, R.rid, R.vkey, true, false, undefined, OWNER_ACTOR), /admin_recovery_only/, 'dueño', 403);
      REJ2 = R;
    });

    await check('[AR] ambiguous_video_submission y videogen_failed (render fallido después de aceptado) → CERO reintentos automáticos (ni el reintento seguro ni el auto-healer), aunque pase el tiempo', async () => {
      const A = await freshRun('BE-B ambiguo');
      const va = vgFake('timeout');
      await IW.processItem(videoDeps(va), await claimVideo(A.rid));
      const B = await freshRun('BE-B render fallido');
      const vb = vgFake('renderfail');
      await IW.processItem(videoDeps(vb), await claimVideo(B.rid));
      const ra = await latest(A.rid, A.vkey);
      const rb = await latest(B.rid, B.vkey);
      eq([ra.status, /^ambiguous_video_submission/.test(ra.error), rb.status, /^videogen_failed/.test(rb.error)], ['failed', true, 'failed', true], `errores (${ra.error} | ${rb.error})`);
      for (const mins of [3, 60, 600]) {
        const s = await runs.autoRetrySafeRejections({ now: later(mins) });
        eq(s.retried.filter((x) => [A.rid, B.rid].includes(x.runId)).length, 0, `seguro +${mins} min`);
        const h = await runs.autoHealFailedItems({ now: later(mins) });
        eq(h.reopened.filter((x) => [A.rid, B.rid].includes(x.runId)).length, 0, `auto-healer +${mins} min`);
      }
      eq([(await latest(A.rid, A.vkey)).status, (await latest(B.rid, B.vkey)).status, va.st.submits, vb.st.submits], ['failed', 'failed', 1, 1], 'siguen failed, un solo envío');
    });

    await check('[AR] FinOps manda en el reintento automático: sin presupuesto aprobado que lo cubra → no se reabre (sin estimado ni aprobación nueva) y queda para un admin; con presupuesto pero revocado antes del envío → el runtime guard del worker lo bloquea (0 envíos)', async () => {
      const R = await freshRun('BE-B finops gate');
      await IW.processItem(videoDeps(vgFake('422')), await claimVideo(R.rid));
      const [est] = await ds.query(`select id from public.cost_estimates where run_id = $1 and scope = 'run'`, [R.rid]);
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, estimate_id, authorized_budget, decision, reason) values ($1, $2, $3, 0, 'BLOCKED', 'check BE-B: revocado')`, [R.rid, R.cid, est.id]);
      const f0 = await finopsCounts(R.cid);
      const res = await runs.autoRetrySafeRejections({ now: later(3) });
      eq(res.retried.filter((x) => x.runId === R.rid).length, 0, 'no se reabre');
      eq(res.skipped.filter((x) => x.runId === R.rid).map((x) => x.reason), ['budget_approval_required'], 'motivo FinOps');
      const row = await latest(R.rid, R.vkey);
      eq([row.status, row.output_summary.safeAutoRetry.declined], ['failed', 'budget_approval_required'], 'declinado → admin');
      eq(await finopsCounts(R.cid), f0, 'sin estimados ni aprobaciones nuevas');
      eq((await runs.autoRetrySafeRejections({ now: later(60) })).candidates, 0, 'no vuelve a intentarlo en cada tick');
      eq(RC.adminActionFor(row, 'not_done', later(60)), { code: 'retry_video_render', itemKey: R.vkey }, 'acción de admin');
      // Runtime guard: reabierto con presupuesto y revocado antes de que el worker envíe → bloqueado, 0 envíos.
      const G = await freshRun('BE-B runtime guard');
      await IW.processItem(videoDeps(vgFake('422')), await claimVideo(G.rid));
      eq((await runs.autoRetrySafeRejections({ now: later(3) })).retried.filter((x) => x.runId === G.rid).length, 1, 'reabierto');
      const [estG] = await ds.query(`select id from public.cost_estimates where run_id = $1 and scope = 'run'`, [G.rid]);
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, estimate_id, authorized_budget, decision, reason) values ($1, $2, $3, 0, 'BLOCKED', 'check BE-B: revocado')`, [G.rid, G.cid, estG.id]);
      const vg = vgFake('ok');
      await IW.processItem(videoDeps(vg), await claimVideo(G.rid));
      const rg = await latest(G.rid, G.vkey);
      eq([rg.status, /budget_exceeded/.test(rg.error), vg.st.submits], ['blocked', true, 0], `runtime guard (${rg.error})`);
    });

    await check('[AR] gamma_submit_failed (rechazo 4xx definitivo de Gamma: reserva liberada, marcador limpio) → UN reintento automático común (sin reenvío forzado); una segunda vez → admin', async () => {
      const R = await freshRun('BE-B gamma');
      const key = `presentation:${R.c1}`;
      const p = await latest(R.rid, key);
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'gamma_submit_failed: Gamma respondió 400 (bad request)',
        finished_at = now() - interval '10 minutes', output_summary = '{}'::jsonb where id = $1`, [p.id]);
      const res = await runs.autoRetrySafeRejections({ now: new Date() });
      eq(res.retried.filter((x) => x.runId === R.rid), [{ runId: R.rid, itemKey: key, code: 'gamma_submit_failed' }], 'reintentado');
      let row = await latest(R.rid, key);
      eq([row.status, row.output_summary.safeAutoRetry.rounds, 'previousExternals' in row.output_summary], ['pending', 1, false], 'reintento común');
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'gamma_submit_failed: Gamma respondió 400 (bad request)', finished_at = now() - interval '10 minutes' where id = $1`, [p.id]);
      eq((await runs.autoRetrySafeRejections({ now: new Date() })).retried.filter((x) => x.runId === R.rid).length, 0, 'segunda vez: no');
      row = await latest(R.rid, key);
      eq(RC.adminActionFor(row, 'not_done', new Date()), { code: 'retry_item', itemKey: key }, 'queda para un humano');
    });

    // ════ [AD] cola de admin + features (HTTP real con los guards reales) ══════
    const { Test } = require('@nestjs/testing');
    const jwt = require('jsonwebtoken');
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminDynamicRunsController, FeaturesController],
      providers: [{ provide: AdminRecoveryService, useValue: recovery }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    const token = (u) => jwt.sign({ sub: u.id, email: u.email, role: 'authenticated' }, JWT_SECRET, { expiresIn: 600 });
    const get = async (p, u) => {
      const res = await realFetch(base + p, { headers: u ? { authorization: `Bearer ${token(u)}` } : {} });
      let json = null;
      try { json = await res.json(); } catch {}
      return { status: res.status, json };
    };

    // Escenarios extra para la cola: video ambiguo, presupuesto bloqueado, curso viejo de vista previa con paquete.
    const Camb = await confirmedCourse('BE-B cola ambiguo');
    const ramb = await seededRealRun(Camb);
    {
      const v = await latest(ramb, `video:${Camb.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'ambiguous_video_submission: TEXTO-TECNICO-SECRETO timeout', finished_at = now(),
                        output_summary = (output_summary - 'external') || '{"externalSubmitStartedAt":"2026-10-01T00:00:00Z"}'::jsonb where id = $1`, [v.id]);
      await ds.query(`update public.generation_item_runs set status = 'blocked' where id = $1`, [(await latest(ramb, `video_interactions:${Camb.c2}`)).id]);
      await recompute(ramb);
    }
    const Cbud = await confirmedCourse('BE-B cola presupuesto');
    const rbud = await seededRealRun(Cbud);
    {
      const v = await latest(rbud, `video:${Cbud.c2}`);
      await ds.query(`update public.generation_item_runs set status = 'blocked', error = 'budget_exceeded: TEXTO-TECNICO-SECRETO' where id = $1`, [v.id]);
      await ds.query(`update public.generation_item_runs set status = 'blocked' where id = $1`, [(await latest(rbud, `video_interactions:${Cbud.c2}`)).id]);
      await recompute(rbud);
    }
    const Cleg = await confirmedCourse('BE-B cola viejo preview');
    const rleg = await seededRealRun(Cleg, { videoModeOf: () => 'mock' });
    await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now() - interval '20 days' where id = $1`, [rleg]);
    await ds.query(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, input_payload, output_summary, options, result)
      values ($1, $2, 'dynamic_package', 'completed', 'completed', 'dynamic_package', $3::jsonb, $4::jsonb, '{}'::jsonb, '{}'::jsonb)`,
      [OWNER, Cleg.cid, JSON.stringify({ runId: rleg, manifestId: Cleg.manifest.id, blueprintNumber: 1 }),
        JSON.stringify({ artifactId: crypto.randomUUID(), sourceIdsHash: 'b1'.repeat(32), builderVersion: '3.6.0', pendingVideos: [{ itemKey: `video:${Cleg.c1}`, chapterId: Cleg.c1, chapterNumber: 1 }] })]);

    await check('[AD] GET /admin/dynamic-runs/needs-attention: 401 sin token, 403 al dueño (y a cualquier no admin), 200 a SUPER_ADMIN; solo lectura (nada cambia en la base)', async () => {
      eq((await get('/api/v1/admin/dynamic-runs/needs-attention')).status, 401, 'sin token');
      const o = await get('/api/v1/admin/dynamic-runs/needs-attention', OWNER_ACTOR);
      eq(o.status, 403, `dueño ${JSON.stringify(o.json)}`);
      eq((await get('/api/v1/admin/dynamic-runs/needs-attention', { id: crypto.randomUUID(), email: 'otro@cliente.test' })).status, 403, 'otro usuario');
      // Fix M6: el guard usa EXACTAMENTE isSuperAdminEmail (mismo resultado que /features.superAdmin).
      eq((await get('/api/v1/admin/dynamic-runs/needs-attention?limit=1', { id: ADMIN_X.id, email: ' Admin@Cursia.test ' })).status, 200, 'email con espacios/mayúsculas');
      eq((await get('/api/v1/features', { id: ADMIN_X.id, email: ' Admin@Cursia.test ' })).json.data.superAdmin, true, '/features coincide');
      const fp = async () => (await ds.query(`select md5(string_agg(t::text, '|' order by t.id)) as h from public.production_jobs t`))[0].h +
        (await ds.query(`select md5(string_agg(t::text, '|' order by t.id)) as h from public.generation_item_runs t`))[0].h;
      const before = await fp();
      const a = await get('/api/v1/admin/dynamic-runs/needs-attention', ADMIN_X);
      eq(a.status, 200, `admin ${JSON.stringify(a.json).slice(0, 300)}`);
      eq(await fp(), before, 'la lectura no escribe');
    });

    await check('[AD] la cola lista los runs needs_attention con ids, componentes fallidos, código de fallo y cada acción con su endpoint EXISTENTE (retry_package → POST …/package; retry_video_render → …/retry {resubmitVideo}; reconcile_videogen; approve_budget → aprobación FinOps + retry); los cursos viejos de vista previa van aparte (paquete armado/descargable); nunca el texto del error ni emails', async () => {
      const a = await get('/api/v1/admin/dynamic-runs/needs-attention?limit=500', ADMIN_X);
      eq(a.status, 200, 'status');
      const L0 = a.json.data;
      const byRun = new Map(L0.needsAttention.map((e) => [e.runId, e]));
      const runBase = (cid, rid) => `/api/v1/courses/${cid}/blueprints/1/manifest/runs/${rid}`;
      // Paquete agotado
      const ep = byRun.get(AP.runId);
      assert(ep, 'run con paquete fallido listado');
      eq([ep.courseId, ep.ownerId, ep.state, ep.workerStatus, ep.failedComponents], [AP.C.cid, OWNER, 'needs_attention', 'completed', []], 'entrada del paquete');
      eq(ep.adminActions.map((x) => [x.code, x.endpoint.method, x.endpoint.path]), [['retry_package', 'POST', `${runBase(AP.C.cid, AP.runId)}/package`]], 'retry_package → POST …/package');
      // Precheck bloqueado
      // Fix I2: el bloqueo se muestra (código + mensaje) y la acción es la del componente, con su porqué.
      const eb0 = byRun.get(BLK.runId);
      assert(eb0, 'precheck bloqueado listado');
      eq([eb0.packageJob.blocked.code, eb0.adminActions.map((x) => [x.code, x.itemKey, x.reason, x.endpoint.path])],
        ['youtube_delivery_incomplete', [['resolve_youtube', `video:${BLK.C.c2}`, 'youtube_delivery_incomplete', `${runBase(BLK.C.cid, BLK.runId)}/items/${encodeURIComponent(`video:${BLK.C.c2}`)}/youtube-resolution`]]], 'acción del componente');
      assert(/bloquea el paquete final/.test(eb0.adminActions[0].endpoint.note), 'la nota dice por qué');
      const e403 = byRun.get(BLK403.runId);
      eq([e403.adminActions[0].code, e403.adminActions[0].endpoint.path, /http_403/.test(e403.adminActions[0].endpoint.note)], ['resolve_package_block', `${runBase(BLK403.C.cid, BLK403.runId)}/package`, true], '403 → resolver la causa');
      // Video rechazado dos veces
      const ev = byRun.get(REJ2.rid);
      assert(ev, 'video rechazado listado');
      const fv = ev.failedComponents.find((x) => x.itemKey === REJ2.vkey);
      eq([fv.type, fv.status, fv.failureCode], ['video', 'failed', 'videogen_submit_rejected'], 'componente fallido con código');
      const av = ev.adminActions.find((x) => x.code === 'retry_video_render');
      eq([av.endpoint.path, av.endpoint.body], [`${runBase(REJ2.cid, REJ2.rid)}/items/${encodeURIComponent(REJ2.vkey)}/retry`, { resubmitVideo: true }], 'retry_video_render → retry resubmitVideo');
      // Ambiguo
      const ea = byRun.get(ramb);
      const aa = ea.adminActions.find((x) => x.code === 'reconcile_videogen');
      assert(aa && aa.endpoint.body.resubmitVideo === true && /Videogen/.test(aa.endpoint.note), `reconcile_videogen ${JSON.stringify(ea.adminActions)}`);
      eq(ea.failedComponents.find((x) => x.itemKey === `video:${Camb.c2}`).failureCode, 'ambiguous_video_submission', 'código del ambiguo');
      // Presupuesto
      const eb = byRun.get(rbud);
      const ab = eb.adminActions.find((x) => x.code === 'approve_budget');
      eq([ab.endpoint.before.path, ab.endpoint.before.body.runId, ab.endpoint.path], [`/api/v1/finops/courses/${Cbud.cid}/authorizations`, rbud, `${runBase(Cbud.cid, rbud)}/items/${encodeURIComponent(`video:${Cbud.c2}`)}/retry`], 'approve_budget');
      // Cursos viejos de vista previa: aparte, con el paquete armado/descargable.
      const lg = L0.legacyPreview.find((x) => x.runId === rleg);
      assert(lg, 'curso viejo de vista previa listado aparte');
      eq([lg.legacyPreview, lg.state, lg.packageBuilt, lg.packageDownloadable, lg.previewComponents.includes(`video:${Cleg.c1}`)], [true, 'preview', true, true, true], 'entrada legacy');
      assert(!L0.needsAttention.some((x) => x.runId === rleg), 'no mezclado con needs_attention');
      // Los que no necesitan atención no aparecen (run viejo real sin paquete = packaging).
      assert(!byRun.has(OLD.runId) && !L0.legacyPreview.some((x) => x.runId === OLD.runId), 'run viejo sin paquete: fuera de needs_attention');
      // Fix M7: runs completos fuera del empaque automático sin paquete vigente → tercer grupo, con la acción manual.
      for (const rid of [OLD.runId, STALE_OLD.runId]) {
        const m = L0.manualPackage.find((x) => x.runId === rid);
        assert(m && m.adminActions[0].code === 'retry_package' && /\/package$/.test(m.adminActions[0].endpoint.path), `manualPackage ${rid}: ${JSON.stringify(m)}`);
      }
      const dump = JSON.stringify(a.json);
      assert(!dump.includes('TEXTO-TECNICO-SECRETO') && !dump.includes('render rechazado') && !dump.includes('build falló'), 'sin texto técnico de errores');
      assert(!/@/.test(dump), 'sin emails');
      eq(L0.errors, [], 'sin errores de evaluación');
    });

    await check('[AD] coordinador: GET /features agrega dodContract:true y superAdmin del usuario (mismo chequeo SUPER_ADMIN del servidor), sin lista de admins', async () => {
      const o = await get('/api/v1/features', OWNER_ACTOR);
      eq(o.status, 200, 'dueño');
      eq([o.json.data.dodContract, o.json.data.superAdmin], [true, false], 'dueño: no admin');
      const a = await get('/api/v1/features', { id: ADMIN_X.id, email: 'ADMIN@Cursia.test' });
      eq([a.json.data.dodContract, a.json.data.superAdmin], [true, true], 'admin (mayúsculas como el guard)');
      eq(Object.keys(a.json.data).sort(), ['coherenceLlm', 'dodContract', 'dynamicCourseStructure', 'manifestRulesVersion', 'realVideo', 'superAdmin'], 'claves exactas');
      assert(!JSON.stringify(a.json).includes('admin@cursia.test'), 'sin la lista de admins');
      eq((await get('/api/v1/features')).status, 401, 'sin token');
    });

    // ════ [RP] reporte de cursos viejos: solo lectura ═════════════════════════
    const REPORT = 'scripts/report-ev6-legacy-preview-runs.js';
    await check('[RP] el reporte rechaza cualquier flag de escritura y exige REPORT_TARGET, SIN conectarse', async () => {
      const unreachable = { DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'x', DB_PASS: 'x', DB_NAME: 'x', DB_SSL: 'false' };
      for (const f of ['--apply', '--write', '--fix', '--update=1', '--delete', '--commit', '--execute', '--migrate', '--repair']) {
        const r1 = runScript(REPORT, { ...unreachable, REPORT_TARGET: 'local' }, [f]);
        eq(r1.code, 2, `${f}: exit`);
        assert(/SOLO LECTURA/.test(r1.out) && /No se conectó/.test(r1.out), `${f}: ${r1.out}`);
      }
      const r2 = runScript(REPORT, unreachable, []);
      eq(r2.code, 2, 'sin REPORT_TARGET');
      assert(/REPORT_TARGET es obligatorio/.test(r2.out), r2.out);
    });

    await check('[RP] contra la base: solo SELECT dentro de una transacción READ ONLY (espía de pg), la base queda idéntica, y lista los runs `completed` que hoy se leen preview (ids + paquete armado/descargable), sin los reales', async () => {
      const spyLog = path.join(tmpCwd, 'sql-spy.log');
      const spy = path.join(tmpCwd, 'sql-spy.js');
      fs.writeFileSync(spy, `const fs = require('fs'); const pg = require(${JSON.stringify(path.join(REPO, 'node_modules', 'pg'))});
const orig = pg.Client.prototype.query;
pg.Client.prototype.query = function (sql, ...rest) { const t = typeof sql === 'string' ? sql : (sql && sql.text) || ''; fs.appendFileSync(${JSON.stringify(spyLog)}, JSON.stringify(t.trim().replace(/\\s+/g, ' ').slice(0, 80)) + '\\n'); return orig.call(this, sql, ...rest); };\n`);
      const fp = async () => {
        const out = [];
        for (const t of ['production_jobs', 'generation_item_runs', 'artifacts', 'cost_estimates', 'cost_budget_authorizations', 'generation_cost_events']) {
          out.push((await ds.query(`select count(*)::int as n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from public.${t} t`))[0]);
        }
        return JSON.stringify(out);
      };
      const before = await fp();
      const r3 = runScript(REPORT, localEnv({ REPORT_TARGET: 'local' }), ['--json'], ['--require', spy]);
      eq(r3.code, 0, `exit ${r3.out.slice(-800)}`);
      eq(await fp(), before, 'la base quedó idéntica');
      const stmts = fs.readFileSync(spyLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert(stmts.length > 3, `pocas consultas: ${stmts.length}`);
      eq(stmts[0], 'begin transaction isolation level repeatable read read only', 'transacción READ ONLY');
      const bad = stmts.filter((s, i) => i > 0 && !/^(select|with)\b/i.test(s) && s !== 'rollback');
      eq(bad, [], 'solo SELECT/WITH');
      const out = JSON.parse(r3.stdout);
      const ids = out.runs.map((x) => x.runId);
      assert(ids.includes(rleg), 'el curso viejo de vista previa aparece');
      const lg = out.runs.find((x) => x.runId === rleg);
      eq([lg.courseId, lg.ownerId, lg.packageBuilt, lg.packageDownloadable], [Cleg.cid, OWNER, true, true], 'entrada');
      assert(!ids.includes(OLD.runId) && !ids.includes(AP.runId), 'los runs reales no aparecen');
      eq([out.summary.readOnly, out.summary.downloadsTracked, out.summary.target], [true, false, 'local'], 'resumen');
      assert(!/@/.test(r3.stdout) && !r3.stdout.includes('BE-B'), 'sin emails ni títulos');
    });

    await check('[RP] follow-up R5: el reporte (solo lectura) lista además los .mbz QA / degradados DECLARADOS que quedaron en la carpeta del dueño (anteriores a qa-internal/), con ids; nunca los que ya están en qa-internal/ ni los finales', async () => {
      const ins = async (pathS, meta) => (await ds.query(
        `insert into public.artifacts (owner_id, course_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, metadata)
         values ($1, '1', 'dynamic_mbz', 'supabase', 'cursia-artifacts', $2, 'f.mbz', 'application/vnd.moodle.backup', $3::jsonb) returning id`,
        [OWNER, pathS, JSON.stringify(meta)]))[0].id;
      const legacyQa = await ins(`${OWNER}/dynamic/1/1/dynamic_mbz/r5/QA-VISTA-PREVIA-a.mbz`, { runId: 'r5-run', packageKind: 'qa_preview', deliverable: false });
      const legacyDeg = await ins(`${OWNER}/dynamic/1/1/dynamic_mbz/r5/QA-VISTA-PREVIA-b.mbz`, { runId: 'r5-run', packageKind: 'degraded', deliverable: false });
      const internal = await ins(`qa-internal/${OWNER}/dynamic/1/1/dynamic_mbz/r5/QA-VISTA-PREVIA-c.mbz`, { runId: 'r5-run', packageKind: 'qa_preview', deliverable: false });
      const fin = await ins(`${OWNER}/dynamic/1/1/dynamic_mbz/r5/d.mbz`, { runId: 'r5-run' });
      const r = runScript(REPORT, localEnv({ REPORT_TARGET: 'local' }), ['--json']);
      eq(r.code, 0, `exit ${r.out.slice(-800)}`);
      const out = JSON.parse(r.stdout);
      const got = out.qaPackagesInOwnerFolder.map((a) => a.artifactId);
      assert(got.includes(legacyQa) && got.includes(legacyDeg), `lista los QA en la carpeta del dueño: ${JSON.stringify(got)}`);
      assert(!got.includes(internal) && !got.includes(fin), 'nunca los de qa-internal/ ni los finales');
      const e = out.qaPackagesInOwnerFolder.find((a) => a.artifactId === legacyQa);
      eq([e.ownerId, e.runId, e.packageKind, e.storageFolder, 'storagePath' in e], [OWNER, 'r5-run', 'qa_preview', 'owner', false], 'entrada (ids, sin ruta)');
      eq(out.summary.qaPackagesInOwnerFolder, got.length, 'resumen');
      const t = runScript(REPORT, localEnv({ REPORT_TARGET: 'local' }), []);
      assert(t.code === 0 && /paquetes QA\/degradados en la carpeta del dueño/.test(t.out) && t.out.includes(legacyQa), 'salida de texto');
      await ds.query(`delete from public.artifacts where id = any($1::uuid[])`, [[legacyQa, legacyDeg, internal, fin]]);
    });

    const VERIFY = 'scripts/verify-ev6-storage-policies.js';
    await check('[SP] follow-up R6: verify-ev6-storage-policies (solo lectura) — con las políticas del repo (own-folder) y el bucket privado pasa; falla si una política de un rol de cliente puede coincidir con qa-internal/ (sin carpeta propia, con OR, sin expresión, para `public`) o si el bucket es público; ignora service_role, restrictivas y otros buckets; nunca escribe; exige MIGRATION_ENV=staging y rechaza el ref de producción SIN conectarse; cableado solo en deploy-staging.yml', async () => {
      const SP = require(path.join(REPO, VERIFY));
      await withClient(DB, async (c) => {
        await c.query(`do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
        end $$`);
        await c.query(`create table if not exists storage.buckets (id text primary key, name text, public boolean not null default false)`);
        await c.query(`insert into storage.buckets (id, name, public) values ('cursia-artifacts', 'cursia-artifacts', false) on conflict (id) do update set public = false`);
        await c.query(fs.readFileSync(path.join(REPO, 'supabase-migration-storage-artifacts-policies.sql'), 'utf8'));
      });
      const fpPol = async () => JSON.stringify(await ds.query(`select policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname = 'storage' order by 1`));
      const verify = () => withClient(DB, (c) => SP.verifyEv6StoragePolicies(c));
      const before = await fpPol();
      let r = await verify();
      eq(r.failures, [], 'políticas del repo: sin problemas');
      eq(r.policies, 4, 'cuatro políticas own-folder');
      eq(await fpPol(), before, 'no escribió');
      const bad = async (sql, re, why) => {
        await ds.query(sql);
        try {
          const v = await verify();
          assert(v.failures.some((f) => re.test(f)), `${why}: ${JSON.stringify(v.failures)}`);
        } finally {
          await ds.query(`drop policy if exists ev6_bad on storage.objects`);
        }
      };
      await bad(`create policy ev6_bad on storage.objects for select to authenticated using (bucket_id = 'cursia-artifacts')`, /ev6_bad: no exige la carpeta propia/, 'solo bucket');
      await bad(`create policy ev6_bad on storage.objects for select to authenticated using (bucket_id = 'cursia-artifacts' and ((storage.foldername(name))[1] = (select auth.uid())::text or name like 'qa-internal/%'))`, /ev6_bad: usa OR/, 'OR');
      await bad(`create policy ev6_bad on storage.objects for insert to anon with check (true)`, /ev6_bad: no exige la carpeta propia/, 'anon insert');
      await bad(`create policy ev6_bad on storage.objects for all to public using ((storage.foldername(name))[1] = (select auth.uid())::text) with check (bucket_id = 'cursia-artifacts')`, /ev6_bad: no exige la carpeta propia.* en ALL para public/, 'ALL a public, with_check flojo');
      await bad(`create policy ev6_bad on storage.objects for select to authenticated using (bucket_id = 'cursia-artifacts' and name like 'qa-internal/%')`, /ev6_bad/, 'lectura de qa-internal/');
      // Fix round 1 (m4): negaciones → falla cerrada (el regex no puede probar que excluyan qa-internal/).
      await bad(`create policy ev6_bad on storage.objects for select to authenticated using (not (bucket_id = 'avatars'))`, /ev6_bad: usa una negación/, 'NOT otro bucket');
      await bad(`create policy ev6_bad on storage.objects for select to authenticated using (bucket_id = 'cursia-artifacts' and not ((storage.foldername(name))[1] = (select auth.uid())::text))`, /ev6_bad: usa una negación/, 'NOT carpeta propia');
      await bad(`create policy ev6_bad on storage.objects for select to authenticated using (bucket_id <> 'avatars')`, /ev6_bad: usa una negación/, '<> otro bucket');
      await bad(`create policy ev6_bad on storage.objects for select to authenticated using (bucket_id = 'cursia-artifacts' and (storage.foldername(name))[1] = (select auth.uid())::text and name is not null)`, /ev6_bad: usa una negación/, 'IS NOT');
      eq([SP.policyRisk({ roles: '{authenticated}', cmd: 'SELECT', qual: "(NOT (bucket_id = 'avatars'::text))" }) !== null,
        SP.policyRisk({ roles: '{authenticated}', cmd: 'SELECT', qual: "((bucket_id = 'cursia-artifacts'::text) AND (NOT ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text)))" }) !== null,
        SP.policyRisk({ roles: '{authenticated}', cmd: 'SELECT', qual: "((bucket_id = 'cursia-artifacts'::text) AND ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text))" })],
        [true, true, null], 'puro: las formas del review');
      // Ignoradas: service_role, restrictiva, otro bucket.
      for (const sql of [
        `create policy ev6_bad on storage.objects for select to service_role using (true)`,
        `create policy ev6_bad on storage.objects as restrictive for select to authenticated using (bucket_id = 'cursia-artifacts')`,
        `create policy ev6_bad on storage.objects for select to authenticated using (bucket_id = 'avatars')`,
      ]) {
        await ds.query(sql);
        try {
          r = await verify();
          eq(r.failures, [], `ignorada: ${sql.slice(0, 80)}`);
        } finally {
          await ds.query(`drop policy if exists ev6_bad on storage.objects`);
        }
      }
      await ds.query(`update storage.buckets set public = true where id = 'cursia-artifacts'`);
      r = await verify();
      assert(r.failures.some((f) => /PÚBLICO/.test(f)), `bucket público: ${JSON.stringify(r.failures)}`);
      await ds.query(`update storage.buckets set public = false where id = 'cursia-artifacts'`);
      await ds.query(`alter table storage.objects disable row level security`);
      r = await verify();
      assert(r.failures.some((f) => /ROW LEVEL SECURITY/.test(f)), 'sin RLS');
      await ds.query(`alter table storage.objects enable row level security`);
      // CLI: guardas antes de conectar; contra la base local (ref ≠ producción) pasa; con un problema sale 1.
      const unreachable = { DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'x', DB_PASS: 'x', DB_NAME: 'x', DB_SSL: 'false' };
      let cli = runScript(VERIFY, unreachable);
      assert(cli.code === 1 && /MIGRATION_ENV no es "staging"/.test(cli.out), `sin MIGRATION_ENV: ${cli.out}`);
      cli = runScript(VERIFY, { ...unreachable, MIGRATION_ENV: 'staging', DB_USER: 'postgres.hriwbakbuypaiovvvkqh' });
      assert(cli.code === 1 && /PRODUCCIÓN/.test(cli.out) && !/ECONNREFUSED/.test(cli.out), `producción: ${cli.out}`);
      cli = runScript(VERIFY, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(cli.code === 0 && /Storage verificado/.test(cli.out), `local limpio: ${cli.out}`);
      await ds.query(`create policy ev6_bad on storage.objects for select to authenticated using (bucket_id = 'cursia-artifacts')`);
      try {
        cli = runScript(VERIFY, localEnv({ MIGRATION_ENV: 'staging' }));
        assert(cli.code === 1 && /ev6_bad/.test(cli.out), `local con problema: ${cli.out}`);
      } finally {
        await ds.query(`drop policy if exists ev6_bad on storage.objects`);
      }
      eq(await fpPol(), before, 'políticas como al principio');
      const stg = fs.readFileSync(path.join(REPO, '.github/workflows/deploy-staging.yml'), 'utf8');
      const prod = fs.readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8');
      assert(/MIGRATION_ENV=staging node scripts\/verify-ev6-storage-policies\.js/.test(stg), 'cableado en deploy-staging.yml');
      assert(!/verify-ev6-storage-policies/.test(prod), 'nunca en el workflow de producción');
      for (const f of fs.readdirSync(path.join(REPO, '.github/workflows'))) {
        if (f !== 'deploy-staging.yml') assert(!fs.readFileSync(path.join(REPO, '.github/workflows', f), 'utf8').includes('verify-ev6-storage-policies'), `no en ${f}`);
      }
    });
  } catch (err) {
    failures++;
    console.error(`❌ setup/fatal: ${err && err.stack ? err.stack : err}`);
  } finally {
    if (app) await app.close().catch(() => {});
    await new Promise((r) => storage.srv.close(() => r()));
    if (ds && ds.isInitialized) await ds.destroy().catch(() => {});
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    console.log('PG16 descartable destruido');
  }
  console.log(`\n${passes} ✅ · ${failures} ❌`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(`❌ fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
