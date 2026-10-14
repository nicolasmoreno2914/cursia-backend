#!/usr/bin/env node
/* eslint-disable */
// Loop 10 C2 — métricas del piloto (GET /admin/dynamic-runs/:runId/pilot-metrics y scripts/pilot-metrics.js). USD 0:
// PG16 desechable, proveedores solo como variables falsas (nunca se llaman).
//
//   PM1 puro: p50/máximo, ejecutor del navegador, ejercicios guiados desde las huellas del servidor (repetidos entre
//       capítulos), ruta SuperAdmin del controlador
//   PM2 DB: run sintético (intentos, reaperturas con actor, ledger con pending / reserva / conciliación, autorización
//       admin, pausa + reanudar, empaque) → cada sección: timing, cost, retries, recoveries, interventions, browser,
//       quality (batería inyectada por el servicio)
//   PM3 SOLO LECTURA: ninguna tabla cambia; la transacción es READ ONLY (una escritura dentro falla); run inexistente →
//       404; el CLI devuelve las mismas secciones desde la base (batería null con motivo)
//
// Usage: npm run build && node scripts/check-pilot-metrics.js [--pure-only] [path/to/dist]
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
  try { return require(abs); } catch (err) { console.error(`❌ No se pudo cargar ${abs} (¿npm run build?): ${err.message}`); process.exit(1); }
}
require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const EL = loadDist('modules/reliability/execution-lease.js');
const PM = loadDist('modules/dynamic-generation/pilot-metrics.js');
const { applyFakeProviderEnv } = require('./lib/provider-test-env');
Logger.overrideLogger({ log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {} });

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }

async function pureChecks() {
  const GPF = require('./lib/guided-practice-fixtures');
  const GP = loadDist('modules/course-shell/guided-practice.js');
  await check('PM1 puro: ejecutor del navegador, ejercicios guiados desde huellas (repetidos entre capítulos), ruta SuperAdmin', async () => {
    eq([PM.isBrowserExecutor('browser', 'x'), PM.isBrowserExecutor(null, 'browser-dev-AAAA'), PM.isBrowserExecutor('server_llm', 'llm-worker-1')], [true, true, false], 'navegador');
    const sum = (ch, ord, label) => ({ chapter_id: ch, item_key: `guided_practice:${ch}`, output_summary: { v3Validation: GP.guidedPracticeSummary(GPF.guidedPracticeDocDistinct(ch, 120, ord, label)) } });
    const ok = PM.guidedPracticeFromSummaries([sum('a', 0, 'a'), sum('b', 1, 'b')]);
    eq([ok.chapters, ok.chaptersWithFingerprints, ok.exercises, ok.minutes, ok.hours, ok.crossChapterDuplicates], [2, 2, 6, 240, 4, 0], 'distintos');
    const dup = PM.guidedPracticeFromSummaries([sum('a', 0, 'x'), sum('b', 0, 'x')]);
    assert(dup.crossChapterDuplicates >= 3, `repetidos: ${dup.crossChapterDuplicates}`);
    eq(PM.guidedPracticeFromSummaries([]), null, 'sin ejercicios guiados');
    const old = PM.guidedPracticeFromSummaries([{ chapter_id: 'a', output_summary: { v3Validation: { minutes: 80, exerciseCount: 2, kinds: [] } } }]);
    eq([old.chaptersWithFingerprints, old.crossChapterDuplicates, old.minutes], [0, 0, 80], 'run anterior al Loop 10: sin huellas, sin inventar');
    const { AdminDynamicRunsController } = loadDist('modules/dynamic-generation/admin-runs.controller.js');
    const { SuperAdminGuard } = loadDist('auth/super-admin.guard.js');
    const guards = Reflect.getMetadata('__guards__', AdminDynamicRunsController) || [];
    assert(guards.includes(SuperAdminGuard), 'SuperAdminGuard en el controlador');
    eq(Reflect.getMetadata('path', AdminDynamicRunsController), 'admin/dynamic-runs', 'prefijo');
    eq(Reflect.getMetadata('path', AdminDynamicRunsController.prototype.pilotMetricsOf), ':runId/pilot-metrics', 'ruta');
    eq(Reflect.getMetadata('method', AdminDynamicRunsController.prototype.pilotMetricsOf), 0, 'GET');
  });
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
const CONTEXT = { nombre: 'Curso métricas del piloto', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY',
  'SUPER_ADMIN_EMAILS', 'DYNAMIC_AUTO_HEAL_POLICY'];

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
  const { PilotMetricsService } = loadDist('modules/dynamic-generation/pilot-metrics.service.js');
  const { Artifact } = loadDist('modules/artifacts/entities/artifact.entity.js');
  const AL = loadDist('modules/reliability/attempt-log.js');
  const F = loadDist('modules/finops/index.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-pilotmetrics-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-pilotmetrics-cwd-'));
  const ROLE = 'postgres.pilotmetrics01';
  const DB = 'pilotmetricsdb';
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

    // ── Curso + run real (servicios), luego historia sintética de ejecución ──
    const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, 'Métricas del piloto']);
    const cid = course.id;
    const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID();
    const s2 = snap.buildBlueprintSnapshotV2(
      { id: cid, title: 'Métricas del piloto', finalExam: true, activityEngine: 'h5p' },
      [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
      [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: false, activity_enabled: true },
        { id: c2, module_id: m1, position: 1, title: 'Válvulas', objective: null, video_enabled: false, activity_enabled: true }],
    );
    for (const m of s2.modules) {
      await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
      for (const c of m.chapters) await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`, [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
    }
    await ds.query(`insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
                    values ($1, 1, 2, $2::jsonb, $3, 0, 1, 2)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
    await manifests.getOrCreate(cid, OWNER, 1);
    let runId;
    try {
      runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
    } catch (err) {
      const body = err.getResponse ? err.getResponse() : null;
      assert(body && body.code === 'budget_approval_required', `startRun: ${err.message}`);
      await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: '50', approvedBy: 'admin@cursia.test', reason: 'check pilot metrics' });
      runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
    }
    const items = await ds.query(`select id, item_key, type, generation, attempt_count from public.generation_item_runs where job_id = $1 order by item_key`, [runId]);
    const byKey = new Map(items.map((i) => [i.item_key, i]));
    const content1 = byKey.get(`content:${c1}`);
    const content2 = byKey.get(`content:${c2}`);
    assert(content1 && content2, 'items de content');
    // T0 = la autorización del run (append-only: no se toca); la historia sintética se escribe relativa a ella.
    const [firstAuth] = await ds.query(`select created_at from public.cost_budget_authorizations where run_id = $1 and decision <> 'BLOCKED' order by created_at, id limit 1`, [runId]);
    assert(firstAuth, 'el run tiene autorización');
    const T0 = new Date(firstAuth.created_at).getTime();
    const at = (min) => new Date(T0 + min * 60000).toISOString();
    // Fix I2: el run se creó consumiendo una aprobación HUMANA (fila ADMIN_APPROVED sin run, adminAuthorize) → la fila
    // del run dice «bound_from:<id>». La hora real de la aprobación es la de la fila original (antes del vínculo).
    const [boundRow] = await ds.query(`select id, reason, created_at from public.cost_budget_authorizations where run_id = $1 and reason like 'bound_from:%' order by created_at, id limit 1`, [runId]);
    assert(boundRow, 'el run consumió la aprobación del admin (bound_from)');
    const [humanRow] = await ds.query(`select id, created_at, approved_by, run_id from public.cost_budget_authorizations where id = $1`, [boundRow.reason.slice('bound_from:'.length)]);
    assert(humanRow && humanRow.run_id === null && new Date(humanRow.created_at).getTime() <= new Date(boundRow.created_at).getTime(), 'aprobación original sin run y anterior al vínculo');
    const HUMAN = new Date(humanRow.created_at).toISOString();
    const BOUND = new Date(boundRow.created_at).toISOString();
    const secsFrom = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 1000);
    await ds.query(`update public.production_jobs set created_at = $2 where id = $1`, [runId, at(-1)]);
    const attempt = (it, no, kind, exec, s, f, outcome, extra = {}) => ds.query(
      `insert into public.generation_item_attempts (item_run_id, job_id, course_id, item_key, generation, attempt_no, executor_kind, executor_id, started_at, finished_at, outcome, failure_class, failure_code, strategy_applied, actor)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [it.id, runId, cid, it.item_key, Number(it.generation), no, kind, exec, at(s), at(f), outcome, extra.cls ?? null, extra.code ?? null, extra.strategy ?? null, extra.actor ?? 'system']);
    // content:c1 → worker de IA: falla B (validación), reapertura automática, completa (2 intentos).
    await attempt(content1, 1, 'server_llm', 'llm-worker-1', 2, 6, 'failed', { cls: 'B', code: 'V3_VALIDATION_FAILED' });
    await attempt(content1, 1, null, null, 6, 6, 'reopened', { cls: 'B', code: 'V3_VALIDATION_FAILED', strategy: 'auto_heal_regenerate:regenerate_targeted', actor: 'auto_heal' });
    await attempt(content1, 2, 'server_llm', 'llm-worker-1', 7, 13, 'completed');
    // content:c2 → navegador: lease vencido, otro worker lo toma (takeover), drenado (hand-back) y completa.
    await attempt(content2, 1, 'browser', 'browser-dev-AAAA', 3, 8, 'lease_expired', { cls: 'A', code: 'lease_expired' });
    await attempt(content2, 2, 'server_llm', 'llm-worker-2', 9, 10, 'drained', { cls: 'A', code: 'worker_draining' });
    await attempt(content2, 3, 'server_llm', 'llm-worker-1', 11, 15, 'completed');
    // Intervenciones manuales: reintento del dueño y regeneración de un admin.
    await attempt(content2, 3, null, null, 20, 20, 'reopened', { strategy: 'manual_retry', actor: 'owner' });
    await attempt(content1, 2, null, null, 21, 21, 'reopened', { strategy: 'regenerate', actor: 'admin:admin@cursia.test' });
    await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = $2, claimed_at = $3, worker_id = 'llm-worker-1' where job_id = $1`, [runId, at(30), at(2)]);
    await ds.query(`update public.generation_item_runs set worker_id = 'browser-dev-AAAA', output_summary = output_summary || '{"autoHeal":{"rounds":1}}'::jsonb where id = $1`, [content2.id]);
    // Ledger: 2 eventos finales (anthropic), 1 pending (openai), 1 reserva abierta, 1 de la clave del usuario, 1 conciliación.
    const ev = (key, provider, type, amount, extra = {}) => ds.query(
      `insert into public.generation_cost_events (event_kind, corrects_event_id, owner_id, course_id, run_id, item_run_id, item_key, item_type, operation, provider, idempotency_key, amount, cost_source, measurement_status, billing_account, billable, recorded_by, metadata, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'llm.call', $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18) returning id`,
      [extra.kind || 'CHARGE', extra.corrects || null, OWNER, cid, runId, extra.itemRunId || null, extra.itemKey || null, type, provider, key, amount,
        extra.source || 'CALCULATED_FROM_USAGE', extra.status || 'final', extra.account || 'cursia', (extra.account || 'cursia') === 'cursia', extra.by || 'check', JSON.stringify(extra.meta || {}), at(extra.min ?? 5)]);
    await ev('pm:1', 'anthropic', 'content', '1.250000', { itemRunId: content1.id });
    await ev('pm:2', 'anthropic', 'content', '0.750000', { itemRunId: content2.id });
    await ev('pm:3', 'openai', 'audio_welcome', '0.500000', { status: 'pending' });
    await ev('pm:4', 'anthropic', 'content', '0.100000', { meta: { reservation: 'true' } });
    await ev('pm:5', 'anthropic', 'content', '9.000000', { account: 'user_key', source: 'ACTUAL_PROVIDER' });
    const [vg] = await ev('pm:6', 'videogen', 'video', '2.000000', { status: 'pending', meta: { reservation: 'true' } });
    await ev('pm:7', 'videogen', 'video', '-2.000000', { kind: 'ADJUSTMENT', corrects: vg.id, by: 'admin@cursia.test', meta: { settlement: 'reconciled_as_not_charged', actor: 'admin@cursia.test' }, min: 25 });
    // Autorización admin adicional (ampliación) + pausa del usuario y reanudar + run terminado + empaque listo.
    await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, authorized_budget, decision, approved_by, reason, created_at) values ($1, $2, 80, 'ADMIN_APPROVED', 'admin@cursia.test', 'ampliación', $3)`, [runId, cid, at(16)]);
    await ds.query(
      `update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = $2,
              output_summary = output_summary || jsonb_build_object('pause', jsonb_build_object('pausedAt', $3::text, 'pausedBy', $4::text, 'previousWorkerStatus', 'running', 'resumedAt', $5::text, 'resumedBy', $4::text))
        where id = $1`, [runId, at(31), at(17), OWNER, at(18)]);
    await ds.query(`insert into public.production_jobs (owner_id, course_id, status, worker_status, execution_mode, input_payload, created_at, finished_at) values ($1, $2, 'completed', 'completed', 'dynamic_package', $3::jsonb, $4, $5)`,
      [OWNER, cid, JSON.stringify({ runId }), at(32), at(40)]);

    const tables = ['production_jobs', 'generation_item_runs', 'generation_item_attempts', 'generation_cost_events', 'cost_budget_authorizations', 'cost_estimates', 'artifacts'];
    const fingerprint = async () => {
      const out = {};
      for (const t of tables) out[t] = (await ds.query(`select count(*)::int as n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from public.${t} x`))[0];
      return out;
    };
    const before = await fingerprint();
    const fakeBattery = { version: 'quality-battery-v1', pass: true, summary: { Q1: 1, Q9: 1 }, guidedPractice: { hours: 4, supported: true }, checks: [{ id: 'Q1', metric: 1, pass: true, findings: [] }, { id: 'Q9', metric: 1, pass: true, blocking: false, findings: [] }], unreadableArtifacts: [] };
    const qualityCalls = [];
    const svc = new PilotMetricsService(ds, { qualityReport: async (...a) => { qualityCalls.push(a); return fakeBattery; } });
    const M = await svc.forRun(runId);

    await check('PM2 timing: autorización, primer claim, completado, paquete listo, tiempo total y p50/máximo por tipo', async () => {
      const t = M.timing;
      eq([t.authorizedAt, t.boundAt, t.humanApprovedAt, t.humanApprovedBy, t.firstClaimAt, t.completedAt, t.packageReadyAt, t.packageJobs], [at(0), BOUND, HUMAN, 'admin@cursia.test', at(2), at(31), at(40), 1], 'momentos (aprobación humana y vínculo por separado)');
      eq([t.authorizationToFirstClaimSeconds, t.firstClaimToCompletionSeconds, t.completionToPackageSeconds, t.totalWallSeconds, t.totalWallFrom, t.totalWallTo], [secsFrom(HUMAN, at(2)), 1740, 540, secsFrom(HUMAN, at(40)), 'human_approval', 'package_ready'], 'duraciones desde la aprobación humana');
      eq([t.durationSource, t.byItemType.content], ['attempts', { count: 2, p50Seconds: 240, maxSeconds: 360 }], 'content: intentos completados de 6 y 4 min');
    });
    await check('PM2 cost: por proveedor y tipo, final vs pendiente, reservas abiertas, clave del usuario aparte, vs autorizado y estimado', async () => {
      const c = M.cost;
      eq([c.available, c.totalUsd, c.settledUsd, c.pendingUsd, c.userKeyUsd, c.openReservations], [true, 2.6, 2.1, 0.5, 9, 1], 'totales (la reserva conciliada no queda abierta)');
      eq(c.byProvider.anthropic, { totalUsd: 2.1, settledUsd: 2.1, pendingUsd: 0, events: 3 }, 'anthropic');
      eq(c.byProvider.videogen, { totalUsd: 0, settledUsd: 0, pendingUsd: 0, events: 2 }, 'videogen: reserva conciliada (ajuste final) = ni gasto ni pendiente');
      eq([c.byItemType.content.totalUsd, c.byItemType.audio_welcome.pendingUsd], [2.1, 0.5], 'por tipo');
      eq([c.authorizedBudgetUsd, c.totalVsAuthorized], [80, 0.0325], 'último presupuesto autorizado');
      eq(M.interventions.list.filter((x) => x.action === 'authorize_budget').length, 2, 'sin duplicar la aprobación (fila sin run + vínculo = 1)');
      assert(c.firstAuthorizedBudgetUsd > 0 && c.estimate && c.estimate.expectedUsd > 0 && typeof c.totalVsEstimateExpected === 'number', JSON.stringify(c.estimate));
    });
    await check('PM2 retries: intentos por item, items con > 1 intento por tipo, desenlaces y clases de falla', async () => {
      const r = M.retries;
      eq([r.available, r.attempts, r.itemsWithMultipleAttemptsByType], [true, 5, { content: 2 }], 'intentos (sin reaperturas)');
      eq(r.outcomeCounts, { completed: 2, drained: 1, failed: 1, lease_expired: 1, reopened: 3 }, 'desenlaces');
      eq(r.failureClassCounts, { A: 2, B: 1 }, 'clases');
      eq(r.attemptsPerItemHistogram['2'] + r.attemptsPerItemHistogram['3'], 2, 'histograma');
      assert(r.itemStatusCounts.completed === items.length, 'estados');
    });
    await check('PM2 recoveries: auto-heal, lease vencido + toma por otro ejecutor, devoluciones del worker, pausa/reanudar', async () => {
      const r = M.recoveries;
      eq([r.autoReopens, r.autoReopensByActorStrategy, r.autoHealItems, r.leaseExpired, r.leaseTakeovers, r.workerHandBacks], [1, { 'auto_heal:auto_heal_regenerate:regenerate_targeted': 1 }, 1, 1, 1, 1], 'recuperaciones');
      eq(r.pauses.map((p) => [p.pausedAt, p.pausedBy, p.reason, p.system, p.resumedAt]), [[at(17), OWNER, 'user', false, at(18)]], 'pausa del usuario y reanudar');
      eq(r.pauseHistory, 'latest_only', 'historia: solo la última pausa (lo que guarda el run)');
    });
    await check('PM2 interventions: autorización admin, reintento del dueño, regeneración del admin, pausa, reanudar y conciliación con quién/cuándo', async () => {
      const L = M.interventions.list.map((x) => [x.action, x.who, x.at]);
      const ha = M.interventions.list.find((x) => x.detail && x.detail.boundAt);
      eq([ha.action, ha.who, ha.at, ha.detail.boundAt, ha.detail.approvalId], ['authorize_budget', 'admin@cursia.test', HUMAN, BOUND, humanRow.id], 'aprobación humana con su hora real (y la del vínculo)');
      for (const want of [['authorize_budget', 'admin@cursia.test', at(16)], ['retry', 'owner', at(20)], ['regenerate', 'admin:admin@cursia.test', at(21)], ['pause', OWNER, at(17)], ['resume', OWNER, at(18)], ['reconcile', 'admin@cursia.test', at(25)]]) {
        assert(L.some((x) => JSON.stringify(x) === JSON.stringify(want)), `falta ${JSON.stringify(want)} en ${JSON.stringify(L)}`);
      }
      assert(!L.some((x) => x[1] === 'auto_heal'), 'el auto-heal no es manual');
      const sorted = [...M.interventions.list].map((x) => x.at); assert(JSON.stringify(sorted) === JSON.stringify([...sorted].sort()), 'en orden');
    });
    await check('PM2 browser: el intento del navegador se lista (executor_kind / executorId) vs los del worker de IA', async () => {
      const b = M.browser;
      eq([b.used, b.attempts, b.byExecutorKind], [true, 1, { browser: 1, server_llm: 4 }], 'uso');
      eq(b.list.map((x) => [x.itemKey, x.executorId, x.outcome]), [[`content:${c2}`, 'browser-dev-AAAA', 'lease_expired']], 'lista');
    });
    await check('PM2 quality: batería inyectada (con Q9) + run/curso/blueprint correctos', async () => {
      eq([M.quality.battery.pass, M.quality.battery.summary.Q9, M.quality.battery.guidedPractice.hours, M.quality.batteryUnavailableReason], [true, 1, 4, null], 'batería');
      eq(M.quality.battery.checks.find((x) => x.id === 'Q9').blocking, false, 'Q9 informativo');
      eq(qualityCalls[0], [cid, OWNER, 1, runId], 'qualityReport(curso, dueño, blueprint, run)');
      eq(M.quality.guidedPracticeFromSummaries, null, 'sin ejercicios guiados en este run');
      eq([M.version, M.readOnly, M.run.id, M.run.blueprintNumber], ['pilot-metrics-v1', true, runId, 1], 'cabecera');
    });
    await check('PM2 fix M5: pausa y reanudar del sistema («system:…») van a recuperaciones, no a intervenciones', async () => {
      const [r2] = await ds.query(`insert into public.production_jobs (owner_id, course_id, status, worker_status, execution_mode, input_payload, output_summary) values ($1, $2, 'completed', 'completed', 'dynamic_generation', $3::jsonb, $4::jsonb) returning id`,
        [OWNER, cid, JSON.stringify({ blueprintNumber: 1, manifestId: 999 }), JSON.stringify({ pause: { pausedAt: at(3), pausedBy: 'system:circuit_breaker', reason: 'circuit_breaker', resumedAt: at(4), resumedBy: 'system:auto' } })]);
      const M3 = await new PilotMetricsService(ds).forRun(r2.id);
      eq(M3.interventions.list.filter((x) => x.action === 'pause' || x.action === 'resume'), [], 'sin intervenciones');
      eq(M3.recoveries.pauses.map((p) => [p.reason, p.system, p.resumedBySystem]), [['circuit_breaker', true, true]], 'en recuperaciones');
      await ds.query(`delete from public.production_jobs where id = $1`, [r2.id]);
    });
    await check('PM3 SOLO LECTURA: ninguna tabla cambia; READ ONLY rechaza escrituras; 404; batería que falla → motivo; CLI = mismas secciones', async () => {
      eq(await fingerprint(), before, 'ninguna tabla cambió');
      // La transacción del servicio es READ ONLY: una escritura dentro de computePilotMetrics fallaría.
      const qr = ds.createQueryRunner();
      await qr.connect();
      let err = null;
      try { await qr.query('start transaction read only'); await qr.query(`update public.production_jobs set progress = progress where id = $1`, [runId]); } catch (e) { err = e; } finally { try { await qr.query('rollback'); } catch {} await qr.release(); }
      assert(err && /read-only transaction/.test(err.message), `READ ONLY: ${err && err.message}`);
      let nf = null;
      try { await svc.forRun(crypto.randomUUID()); } catch (e) { nf = e; }
      assert(nf && nf.getStatus && nf.getStatus() === 404, `404: ${nf && nf.message}`);
      const svc2 = new PilotMetricsService(ds, { qualityReport: async () => { throw new Error('La ejecución no terminó'); } });
      const M2 = await svc2.forRun(runId);
      eq([M2.quality.battery, M2.quality.batteryUnavailableReason], [null, 'La ejecución no terminó'], 'motivo');
      const res = spawnSync(process.execPath, [path.join(REPO, 'scripts/pilot-metrics.js'), runId, '--dist', distRoot, '--compact'],
        { cwd: tmpCwd, env: cleanEnv(localEnv({})), encoding: 'utf8', timeout: 60000 });
      assert(res.status === 0, `CLI: ${res.stderr}`);
      const C = JSON.parse(res.stdout);
      for (const k of ['timing', 'cost', 'retries', 'recoveries', 'interventions', 'browser']) eq(C[k], M[k], `CLI = endpoint: ${k}`);
      assert(C.quality.battery === null && /CLI solo base/.test(C.quality.batteryUnavailableReason), 'CLI: batería null con motivo');
      eq(await fingerprint(), before, 'el CLI tampoco cambió nada');
      const bad = spawnSync(process.execPath, [path.join(REPO, 'scripts/pilot-metrics.js'), 'no-es-uuid', '--dist', distRoot], { cwd: tmpCwd, env: cleanEnv(localEnv({})), encoding: 'utf8' });
      eq(bad.status, 2, 'CLI sin runId válido → 2');
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
