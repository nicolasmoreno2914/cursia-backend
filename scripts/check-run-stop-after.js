#!/usr/bin/env node
/* eslint-disable */
// «Detener después de» POR RUN (stop_after_item + holdPackaging, 2026-10-14, validación real #1353): el observador del
// navegador (una pestaña que sondeaba cada 2 s y pausaba a mano) dejó que el worker reclamara el examen final ~10 s
// después de completarse el examen del módulo 2; y completar la última parte encola el empaque automático aunque el
// run esté pausado. Ahora lo decide el SERVIDOR (src/modules/dynamic-generation/stop-after.ts).
//
// Parte pura: body del PUT (validado a mano), lectura saneada de la config y de la retención.
// Parte DB (PG16 desechable, esquema real, servicios COMPILADOS, proveedores solo como variables falsas, 0 red):
//   [SA] completar la parte elegida pausa el run en la MISMA transacción (reason stop_after_item); ningún claim
//        posterior (otro worker, el worker global) le entrega partes; un claim que espera el lock del run durante la
//        transacción de la completitud ve la pausa; lo que ya estaba en vuelo puede terminar y el run sigue pausado;
//        disparo único (reanudar → despacha y no vuelve a pausar); reinicio del worker (lease vencido) → la config
//        sobrevive y dispara al completarse en el reintento; pausa del usuario / tope de presupuesto / disyuntor vigente →
//        se respeta y la config sigue ARMADA: la 1.ª reanudación vuelve a pausar con stop_after_item (reanudar tras el
//        tope sigue exigiendo presupuesto); cancelar desde la pausa; 404/409/400.
//   [IN] idempotencia / checkpoints / intentos de las partes intactos; las partes COMPLETAS nunca se reclaman, se
//        regeneran ni cambian (huella de estado/generación/intentos/salida/updated_at), ni siquiera al configurar,
//        disparar, reanudar o quitar la config; stop-after sobre una parte completa → 409.
//   [PK] holdPackaging: el run pasa a `completed` SIN la marca eligibleAt (autoPackage.held) → 0 jobs de paquete (aviso
//        post-commit, ensure y barrido); un run SIN config en el mismo proceso sigue empaquetándose solo (regresión,
//        sin tocar DYNAMIC_AUTO_PACKAGE_ENABLED); liberar la retención (acción explícita) → UN job, idempotente; el
//        botón manual sigue siendo una acción explícita válida; solo-retención (itemKeys vacío) también; la completion
//        trae packageJob.held y la cola de admin lo lista en heldPackage (nunca como paquete manual con retry_package).
// La completitud se hace con la cola EXACTA de SchedulerService.completeItemDetailed (lock del run → item
// `completed` → recordItemCompleted → recomputeRunStatus, en una transacción): los validadores de artifacts de cada
// tipo quedan fuera; el camino completo (worker de IA real + IA falsa, HTTP) lo cubre E24s en test/e2e-v2/e2e-v3.js.
//
// Usage: npm run build && node scripts/check-run-stop-after.js [--pure-only]

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PURE_ONLY = process.argv.includes('--pure-only');
const REPO = path.resolve(__dirname, '..');
const distRoot = path.join(REPO, 'dist');
const L = (rel) => {
  try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar dist/${rel} (¿npm run build?): ${err.message}`); process.exit(1); }
};
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  const s = String(u);
  if (s.startsWith('data:') || /^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o);
  throw new Error(`NETWORK FORBIDDEN in check: ${s}`);
};
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const { applyFakeProviderEnv } = require('./lib/provider-test-env');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
async function rejects(p, status, code, m) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${m}: NO lanzó`);
  const body = err.getResponse ? err.getResponse() : null;
  assert(err.getStatus && err.getStatus() === status, `${m}: status ${err.getStatus && err.getStatus()} (esperado ${status}) ${err.message}`);
  if (code) assert(body && body.code === code, `${m}: code ${body && body.code} (esperado ${code})`);
  return err;
}

const SA = L('modules/dynamic-generation/stop-after.js');

// ════ Puros ═════════════════════════════════════════════════════════════════
async function pureChecks() {
  await check('puro: body del PUT — válido (dedup), holdPackaging por defecto false; solo-retención con itemKeys vacío', () => {
    eq(SA.parseStopAfterBody({ itemKeys: ['final_exam:1353', 'final_exam:1353'], holdPackaging: true }), { itemKeys: ['final_exam:1353'], holdPackaging: true }, 'dedup');
    eq(SA.parseStopAfterBody({ itemKeys: ['exam:4d3841ea-4ca6-4bbd-9f44-34d1653e7cba'] }), { itemKeys: ['exam:4d3841ea-4ca6-4bbd-9f44-34d1653e7cba'], holdPackaging: false }, 'sin hold');
    eq(SA.parseStopAfterBody({ itemKeys: [], holdPackaging: true }), { itemKeys: [], holdPackaging: true }, 'solo retención');
  });
  await check('puro: body del PUT — 400 con propiedad extra, holdPackaging no booleano ("true"/1), clave inválida, >20 claves, vacío sin hold, no-objeto', () => {
    const bad = [
      [{ itemKeys: ['final_exam:1'], extra: 1 }, /should not exist/],
      [{ itemKeys: ['final_exam:1'], holdPackaging: 'true' }, /booleano/],
      [{ itemKeys: ['final_exam:1'], holdPackaging: 1 }, /booleano/],
      [{ itemKeys: ['final exam'] }, /inválida/],
      [{ itemKeys: ['x:1; drop table'] }, /inválida/],
      [{ itemKeys: [42] }, /inválida/],
      [{ itemKeys: Array.from({ length: 21 }, (_, i) => `content:${i}`) }, /hasta 20/],
      [{ itemKeys: [] }, /holdPackaging: true/],
      [{ itemKeys: 'final_exam:1' }, /lista/],
      [null, /objeto JSON/],
      [[1], /objeto JSON/],
    ];
    for (const [b, re] of bad) {
      let err = null;
      try { SA.parseStopAfterBody(b); } catch (e) { err = e; }
      assert(err && err.getStatus() === 400 && re.test(err.message), `body ${JSON.stringify(b).slice(0, 80)}: ${err && err.message}`);
    }
  });
  await check('puro: lectura saneada — config ausente/rota → null; claves inválidas se descartan; retención solo sin eligibleAt', () => {
    eq(SA.stopAfterOf({}), null, 'sin config');
    eq(SA.stopAfterOf({ output_summary: { stopAfter: 'roto' } }), null, 'string roto');
    eq(SA.stopAfterOf({ output_summary: { stopAfter: { itemKeys: ['bad key', 7] } } }), null, 'sin claves válidas ni hold');
    const c = SA.stopAfterOf({ output_summary: JSON.stringify({ stopAfter: { itemKeys: ['exam:a', 'bad key'], holdPackaging: true, setBy: 'u', firedAt: null } }) });
    eq([c.itemKeys, c.holdPackaging, c.firedAt], [['exam:a'], true, null], 'saneada desde texto');
    eq(Object.keys(SA.stopAfterView({ output_summary: { stopAfter: { itemKeys: ['exam:a'], setBy: 'secreto' } } })).includes('setBy'), false, 'la vista no expone setBy');
    eq(SA.packageHoldOf({ output_summary: { autoPackage: { held: { at: '2026-10-14T00:00:00Z', reason: 'stop_after_item' } } } }), { heldAt: '2026-10-14T00:00:00Z', reason: 'stop_after_item' }, 'retenido');
    eq(SA.packageHoldOf({ output_summary: { autoPackage: { eligibleAt: '2026-10-14T00:00:00Z', held: { at: 'x' } } } }), null, 'con marca no está retenido');
    eq(SA.holdsPackaging({ output_summary: { stopAfter: { itemKeys: [], holdPackaging: true } } }), true, 'solo retención');
  });
}

// ════ DB ════════════════════════════════════════════════════════════════════
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

    const runRow = async (runId) => (await ds.query(`select * from public.production_jobs where id = $1`, [runId]))[0];
    const itemOf = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const pkgJobs = (runId) => ds.query(`select * from public.production_jobs where execution_mode = 'dynamic_package' and input_payload->>'runId' = $1 order by created_at, id`, [runId]);
    const claimW = (runId, executorId, itemId) => sched.claimNextItemDetailed({ runId, executorId, types: TYPES, leaseSeconds: 120, ...(itemId ? { itemId } : {}) });
    /** Cola EXACTA de completeItemDetailed (ver cabecera): lock del run → item completed → recordItemCompleted → recomputeRunStatus. */
    async function completeTail(runId, key, executorId, opts = {}) {
      const go = async (qr) => {
        await qr.query(`select id from public.production_jobs where id = $1 for update`, [runId]);
        const done = RR.returningRows(await qr.query(
          `update public.generation_item_runs
              set status = 'completed', finished_at = now(), lease_until = null, next_retry_at = null, error = null, updated_at = now()
            where job_id = $1 and item_key = $2 and status = 'running' and worker_id = $3 returning id`, [runId, key, executorId]));
        assert(done.length === 1, `completeTail ${key}: no estaba running de ${executorId}`);
        await AL.recordItemCompleted(qr, done[0].id);
        if (opts.beforeRecompute) await opts.beforeRecompute(qr);
        await T.recomputeRunStatus(qr, runId);
        if (opts.beforeCommit) await opts.beforeCommit(qr);
      };
      await runs.tx(go);
      await runs.settleRunCompletedHooks();
    }
    const fingerprint = async (runId, exceptKeys = []) => ds.query(
      `select item_key, status, generation, attempt_count, max_attempts, idempotency_key, md5(coalesce(output_summary::text, '')) os, updated_at::text u, worker_id
         from public.generation_item_runs where job_id = $1 and status = 'completed' and not (item_key = any($2::text[])) order by item_key, generation`, [runId, exceptKeys]);

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
    const setSA = (C, body, actor) => runs.setStopAfter(C.cid, OWNER, 1, C.runId, SA.parseStopAfterBody(body), actor);

    // ── [SA] ────────────────────────────────────────────────────────────────
    await check('[SA] PUT: parte inexistente → 404; parte YA completa → 409 (nunca la regenera); curso de otro dueño → 404; body inválido por el controlador → 400', async () => {
      const C = await makeCourse('SA validaciones');
      const before = await fingerprint(C.runId);
      await rejects(setSA(C, { itemKeys: ['content:00000000-0000-4000-8000-000000000000'] }), 404, 'stop_after_item_not_found', 'inexistente');
      const [done] = await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and status = 'completed' and type = 'course_plan'`, [C.runId]);
      await rejects(setSA(C, { itemKeys: [done.item_key], holdPackaging: true }), 409, 'stop_after_item_already_completed', 'completa');
      await rejects(runs.setStopAfter(C.cid, OTHER, 1, C.runId, { itemKeys: [C.keys[0]], holdPackaging: false }), 404, null, 'otro dueño');
      let err = null;
      try { await ctrl.setStopAfter(C.cid, 1, C.runId, { itemKeys: [C.keys[0]], holdPackaging: 'true' }, { id: OWNER, email: 'o@x' }); } catch (e) { err = e; }
      assert(err && err.getStatus() === 400, 'controlador → 400: ' + (err && err.message));
      eq((await runRow(C.runId)).output_summary.stopAfter, undefined, 'nada se escribió');
      eq(await fingerprint(C.runId), before, 'las partes completas no cambiaron');
    });

    let K = null;
    await check('[SA] completar la parte elegida → el run se pausa en la MISMA transacción (stop_after_item, automático); otro worker y el worker global no reciben nada; el resto queda intacto', async () => {
      K = await makeCourse('SA normal');
      const dto = await setSA(K, { itemKeys: [K.keys[0]] });
      eq([dto.stopAfter.itemKeys, dto.stopAfter.holdPackaging, dto.stopAfter.firedAt], [[K.keys[0]], false, null], 'config');
      const a = await claimW(K.runId, 'w-1', (await itemOf(K.runId, K.keys[0])).id);
      assert(a.item && a.item.itemKey === K.keys[0], 'w-1 toma la parte elegida: ' + JSON.stringify(a).slice(0, 200));
      // La parte elegida se completa; en la misma transacción, ANTES del commit, el run ya está pausado.
      let inTx = null;
      await completeTail(K.runId, K.keys[0], 'w-1', { beforeCommit: async (qr) => { inTx = (await qr.query(`select worker_status from public.production_jobs where id = $1`, [K.runId]))[0].worker_status; } });
      eq(inTx, 'paused', 'pausado dentro de la transacción de la completitud');
      const row = await runRow(K.runId);
      eq([row.status, row.worker_status, row.output_summary.pause.reason, row.output_summary.pause.pausedBy, row.output_summary.stopAfter.firedItemKey], ['paused', 'paused', 'stop_after_item', 'system:stop_after_item', K.keys[0]], 'fila');
      assert(row.output_summary.stopAfter.firedAt, 'firedAt');
      for (let i = 0; i < 5; i++) eq(await claimW(K.runId, `w-${i + 2}`), { item: null, reason: 'run_paused' }, `claim ${i + 2}`);
      const g = await sched.claimNextItemDetailed({ executorId: 'worker-global', types: TYPES, leaseSeconds: 60 });
      assert(!g.item || g.item.runId !== K.runId, 'worker global: ' + JSON.stringify(g).slice(0, 200));
      const rest = await Promise.all(K.keys.slice(1).map((k) => itemOf(K.runId, k)));
      eq(rest.map((x) => [x.status, x.attempt_count]), [['pending', 0], ['pending', 0]], 'las otras partes no se reclamaron');
      const view = await runs.getRun(K.cid, OWNER, 1, K.runId);
      eq([view.paused, view.pauseInfo.automatic, view.pauseInfo.reason, !!view.stopAfter.firedAt, view.packageHold], [true, true, 'stop_after_item', true, null], 'GET');
    });

    await check('[SA] disparo ÚNICO: reanudar (acción explícita) despacha de nuevo; completar otra parte NO vuelve a pausar; DELETE quita la config sin reanudar nada', async () => {
      const dto = await runs.resumeRun(K.cid, OWNER, 1, K.runId);
      assert(!dto.paused && T.DISPATCHABLE_RUN_WORKER_STATUSES.includes(dto.workerStatus), 'reanudado: ' + dto.workerStatus);
      const b = await claimW(K.runId, 'w-7');
      assert(b.item, 'vuelve a entregar partes');
      await completeTail(K.runId, b.item.itemKey, 'w-7');
      assert((await runRow(K.runId)).worker_status !== 'paused', 'no vuelve a pausar');
      await runs.pauseRun(K.cid, OWNER, 1, K.runId);
      const cleared = await runs.clearStopAfter(K.cid, OWNER, 1, K.runId);
      eq([cleared.stopAfter, cleared.paused], [null, true], 'config quitada; sigue pausado (DELETE no reanuda)');
      eq((await runs.clearStopAfter(K.cid, OWNER, 1, K.runId)).stopAfter, null, 'DELETE idempotente');
    });

    await check('[SA] concurrencia: un claim que espera el lock del run DURANTE la transacción de la completitud ve la pausa (run_paused); lo que ya estaba en vuelo termina y el run sigue pausado', async () => {
      const C = await makeCourse('SA concurrencia');
      await setSA(C, { itemKeys: [C.keys[0]] });
      const a = await claimW(C.runId, 'w-a', (await itemOf(C.runId, C.keys[0])).id);
      const b = await claimW(C.runId, 'w-b', (await itemOf(C.runId, C.keys[1])).id);
      assert(a.item && b.item, 'dos partes en vuelo');
      let racing = null;
      await completeTail(C.runId, C.keys[0], 'w-a', {
        beforeCommit: async () => {
          // Con la fila del run bloqueada por esta transacción, varios claims compiten (bloquean en el lock del run).
          racing = Promise.all([claimW(C.runId, 'w-c'), claimW(C.runId, 'w-d'), sched.claimNextItemDetailed({ executorId: 'worker-global', types: TYPES, leaseSeconds: 60 })]);
          await new Promise((r) => setTimeout(r, 400));
        },
      });
      const res = await racing;
      eq([res[0], res[1]], [{ item: null, reason: 'run_paused' }, { item: null, reason: 'run_paused' }], 'los claims que esperaban ven la pausa');
      assert(!res[2].item || res[2].item.runId !== C.runId, 'worker global: nada de este run');
      eq((await itemOf(C.runId, C.keys[2])).attempt_count, 0, 'la tercera parte nunca se reclamó');
      await completeTail(C.runId, C.keys[1], 'w-b');
      eq((await runRow(C.runId)).worker_status, 'paused', 'la parte en vuelo terminó y el run sigue pausado');
      eq((await itemOf(C.runId, C.keys[1])).status, 'completed', 'en vuelo completada');
    });

    await check('[SA] reinicio del worker: lease vencido de la parte elegida → vuelve a la cola sin disparar; la config sobrevive; otro worker la completa en el reintento → pausa (una vez)', async () => {
      const C = await makeCourse('SA reinicio');
      await setSA(C, { itemKeys: [C.keys[0]] });
      const id0 = (await itemOf(C.runId, C.keys[0])).id;
      const a = await claimW(C.runId, 'w-dead', id0);
      assert(a.item, 'w-dead toma la parte');
      await ds.query(`update public.generation_item_runs set lease_until = now() - interval '1 second' where id = $1`, [id0]);
      await sched.sweepExpiredLeases(C.runId);
      const it = await itemOf(C.runId, C.keys[0]);
      assert(['retrying', 'pending'].includes(it.status), 'vuelve a la cola: ' + it.status);
      const row = await runRow(C.runId);
      assert(row.worker_status !== 'paused' && row.output_summary.stopAfter && !row.output_summary.stopAfter.firedAt, 'sin disparo; config intacta');
      await ds.query(`update public.generation_item_runs set next_retry_at = now() - interval '1 second' where id = $1`, [id0]);
      const b = await claimW(C.runId, 'w-new', id0);
      assert(b.item && b.item.itemKey === C.keys[0], 'el worker nuevo la reclama: ' + JSON.stringify(b).slice(0, 200));
      await completeTail(C.runId, C.keys[0], 'w-new');
      const r2 = await runRow(C.runId);
      eq([r2.worker_status, r2.output_summary.pause.reason, r2.output_summary.stopAfter.firedItemKey], ['paused', 'stop_after_item', C.keys[0]], 'pausa al completarse en el reintento');
    });

    await check('[SA] pausa del USUARIO vigente (review I1): completar la parte elegida (en vuelo) respeta esa pausa SIN gastar el disparo; la 1.ª reanudación vuelve a pausar con stop_after_item; la 2.ª sigue', async () => {
      const C = await makeCourse('SA pausa usuario');
      await setSA(C, { itemKeys: [C.keys[0]] });
      const a = await claimW(C.runId, 'w-u', (await itemOf(C.runId, C.keys[0])).id);
      assert(a.item, 'en vuelo');
      await runs.pauseRun(C.cid, OWNER, 1, C.runId);
      const pausedAt = (await runRow(C.runId)).output_summary.pause.pausedAt;
      await completeTail(C.runId, C.keys[0], 'w-u');
      const row = await runRow(C.runId);
      eq([row.worker_status, row.output_summary.pause.reason, row.output_summary.pause.pausedBy, row.output_summary.pause.pausedAt], ['paused', undefined, OWNER, pausedAt], 'la pausa del usuario intacta');
      eq(row.output_summary.stopAfter.firedAt, null, 'la config sigue ARMADA (sin disparo)');
      const r1 = await runs.resumeRun(C.cid, OWNER, 1, C.runId);
      eq([r1.paused, r1.pauseInfo && r1.pauseInfo.reason, r1.stopAfter.firedItemKey], [true, 'stop_after_item', C.keys[0]], '1.ª reanudación → pausa stop_after_item (nunca pasa de largo)');
      eq(await claimW(C.runId, 'w-u2'), { item: null, reason: 'run_paused' }, 'nadie recibe partes');
      const r2 = await runs.resumeRun(C.cid, OWNER, 1, C.runId);
      assert(!r2.paused, '2.ª reanudación sigue');
      assert((await claimW(C.runId, 'w-u3')).item, 'vuelve a despachar');
    });

    await check('[SA] DISYUNTOR vigente (circuit_breaker): la config sigue armada; reanudar (acepta el sobreconsumo) → pausa stop_after_item; cancelar desde ahí → cancelled y nadie reclama', async () => {
      const C = await makeCourse('SA disyuntor');
      await setSA(C, { itemKeys: [C.keys[0]] });
      const a = await claimW(C.runId, 'w-cb', (await itemOf(C.runId, C.keys[0])).id);
      assert(a.item, 'en vuelo');
      assert(await budget.pauseRunBySystem(C.runId, 'circuit_breaker', 'consumo anómalo simulado'), 'pausa del disyuntor');
      await completeTail(C.runId, C.keys[0], 'w-cb');
      const row = await runRow(C.runId);
      eq([row.output_summary.pause.reason, row.output_summary.stopAfter.firedAt], ['circuit_breaker', null], 'disyuntor manda, config armada');
      const r1 = await runs.resumeRun(C.cid, OWNER, 1, C.runId);
      eq([r1.paused, r1.pauseInfo && r1.pauseInfo.reason], [true, 'stop_after_item'], 'reanudar → pausa stop_after_item');
      await runs.cancelRun(C.cid, OWNER, 1, C.runId);
      eq((await runRow(C.runId)).worker_status, 'cancelled', 'cancelado');
      eq((await claimW(C.runId, 'w-cb2')).item, null, 'nadie reclama');
    });

    await check('[SA] tope de PRESUPUESTO vigente (run_budget_cap): no reemplaza esa pausa y la config sigue armada; reanudar sin ampliar → 409 run_budget_cap; el guard niega llamadas pagadas; con el presupuesto ampliado, reanudar → pausa stop_after_item (nunca pasa de largo)', async () => {
      const C = await makeCourse('SA tope');
      await setSA(C, { itemKeys: [C.keys[0]], holdPackaging: true });
      const a = await claimW(C.runId, 'w-b1', (await itemOf(C.runId, C.keys[0])).id);
      assert(a.item, 'en vuelo');
      assert(await budget.pauseRunBySystem(C.runId, 'run_budget_cap', 'tope simulado', 999999), 'pausa del tope');
      await completeTail(C.runId, C.keys[0], 'w-b1');
      const row = await runRow(C.runId);
      eq([row.worker_status, row.output_summary.pause.reason, row.output_summary.stopAfter.firedAt], ['paused', 'run_budget_cap', null], 'la pausa del tope manda; config armada');
      await rejects(runs.resumeRun(C.cid, OWNER, 1, C.runId), 409, 'run_budget_cap', 'reanudar sin presupuesto');
      const [vid] = await ds.query(`select id from public.generation_item_runs where job_id = $1 and type = 'video' limit 1`, [C.runId]);
      const g = await budget.guardPaidSubmission({ runId: C.runId, itemRunId: vid.id, itemType: 'video' });
      eq(g.allow, false, 'guard: pausado → sin llamadas pagadas');
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, estimate_id, authorized_budget, currency, policy_id, decision, approved_by, reason)
                      select run_id, course_id, estimate_id, 1000000, currency, policy_id, 'ADMIN_APPROVED', 'admin@cursia.test', 'check stop-after: ampliación'
                        from public.cost_budget_authorizations where run_id = $1 order by created_at desc, id desc limit 1`, [C.runId]);
      const r1 = await runs.resumeRun(C.cid, OWNER, 1, C.runId);
      eq([r1.paused, r1.pauseInfo && r1.pauseInfo.reason, r1.stopAfter.firedItemKey], [true, 'stop_after_item', C.keys[0]], 'con presupuesto: reanudar → pausa stop_after_item');
    });

    await check('[IN] idempotencia, checkpoints e intentos: configurar / disparar / reanudar / quitar NO tocan idempotency_key, attempt_count, max_attempts ni output_summary (llmCheckpoints) de las partes; las completas quedan idénticas', async () => {
      const C = await makeCourse('IN intactos');
      const id2 = (await itemOf(C.runId, C.keys[1])).id;
      await ds.query(`update public.generation_item_runs set output_summary = jsonb_build_object('llmCheckpoints', jsonb_build_object('h1', jsonb_build_object('text', 'respuesta pagada'))), attempt_count = 2, max_attempts = 5 where id = $1`, [id2]);
      const snapOf = async () => ds.query(`select item_key, status, idempotency_key, attempt_count, max_attempts, output_summary from public.generation_item_runs where id = $1`, [id2]);
      const s0 = await snapOf();
      const fp0 = await fingerprint(C.runId);
      await setSA(C, { itemKeys: [C.keys[0]], holdPackaging: true });
      const a = await claimW(C.runId, 'w-i', (await itemOf(C.runId, C.keys[0])).id);
      await completeTail(C.runId, a.item.itemKey, 'w-i');
      const fpDone = await fingerprint(C.runId);
      await runs.resumeRun(C.cid, OWNER, 1, C.runId);
      await runs.pauseRun(C.cid, OWNER, 1, C.runId);
      await runs.clearStopAfter(C.cid, OWNER, 1, C.runId);
      eq(await snapOf(), s0, 'parte pendiente con checkpoint intacta');
      eq(await fingerprint(C.runId, [C.keys[0]]), fp0, 'las partes que ya estaban completas quedaron idénticas');
      eq(await fingerprint(C.runId), fpDone, 'también la parte elegida, ya completa, quedó idéntica tras reanudar/pausar/quitar');
      const gens = await ds.query(`select count(*)::int n from public.generation_item_runs where job_id = $1 and generation > 1`, [C.runId]);
      eq(gens[0].n, 0, 'ninguna generación nueva (nada se regeneró)');
      await runs.resumeRun(C.cid, OWNER, 1, C.runId);
      const claimed = [];
      for (let i = 0; i < 4; i++) { const r = await claimW(C.runId, `w-scan-${i}`); if (r.item) claimed.push(r.item.itemKey); }
      const completedKeys = new Set((await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and status = 'completed'`, [C.runId])).map((x) => x.item_key));
      assert(claimed.length > 0 && claimed.every((k) => C.keys.includes(k) && k !== C.keys[0]), 'solo se reclaman partes pendientes (nunca la elegida ya completa): ' + claimed.join());
      assert(!claimed.some((k) => completedKeys.has(k)), 'nunca una completa');
      eq(await fingerprint(C.runId, claimed), fpDone.filter((r) => !claimed.includes(r.item_key)), 'las completas siguen idénticas tras el barrido de claims');
    });

    // ── [PK] empaque ──────────────────────────────────────────────────────────
    const V3VAL = { v3Validation: { artifactType: 'fixture', artifactId: crypto.randomUUID(), contentSha256: 'x'.repeat(64) } };
    async function confirmedCourse(title) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: true, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'C2', objective: null, video_enabled: true, activity_enabled: false }],
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
      return { cid, manifest: mf.manifest };
    }
    /** Run v3 100 % real sembrado (como check-ev6-dod-autopkg): todo completado y validado, salvo `pendingKey` (running de `w-final`). */
    async function seededRealRun(C, pendingType) {
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
      let pendingKey = null;
      for (const it of items) {
        let summary = {};
        if (it.type === 'video') {
          const yt = 'Yt' + it.chapterId.replace(/-/g, '').slice(0, 9);
          summary = { mode: 'real', delivery: 'completed', youtubeVideoId: yt, youtubeUrl: `https://youtu.be/${yt}`, external: { durationSec: 468, videogenJobId: 'vg-' + it.chapterId } };
        }
        if (['presentation', 'audio_welcome', 'audiobook_chapter'].includes(it.type)) summary = { mode: 'real' };
        if (RC.requiresV3Validation(it.type, it.variant)) summary = { ...summary, ...V3VAL };
        if (it.type === 'video_interactions') {
          const v = videoOf.get(it.chapterId);
          summary = { ...summary, sourceVideoItemRunId: v.itemRunId, videoIdentity: v };
        }
        const isPending = it.type === pendingType && !pendingKey;
        if (isPending) pendingKey = it.key;
        const [ir] = await ds.query(
          `insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key, status, finished_at, output_summary, worker_id, lease_until, attempt_count)
           values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9::text[], $10, $11, $12, $13::jsonb, $14, $15, $16) returning id`,
          [job.id, C.cid, m.blueprintId, m.id, it.key, it.type, it.moduleId, it.chapterId, it.dependsOn, RH.itemIdempotencyKey(m.id, it.key, 1),
            isPending ? 'running' : 'completed', isPending ? null : new Date(), JSON.stringify(summary), isPending ? 'w-final' : null,
            isPending ? new Date(Date.now() + 600000) : null, isPending ? 1 : 0]);
        for (const role of AR.requiredArtifactTypesV3(it.type, it.variant)) {
          const p1 = `sa/${job.id}/${it.key}/${role}`;
          await ds.query(
            `insert into public.artifacts (owner_id, course_id, job_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, metadata, module_id, chapter_id, manifest_id, manifest_item_key, item_run_id)
             values ($1, $2, $3, $4, 'supabase', 'cursia-artifacts', $5, 'f', 'application/json', $6::jsonb, $7, $8, $9, $10, $11)`,
            [OWNER, String(C.cid), job.id, role, p1, JSON.stringify(['dynamic_presentation', 'dynamic_audio_mp3'].includes(role) ? { mode: 'real' } : {}), it.moduleId, it.chapterId, m.id, it.key, ir.id]);
        }
        if (it.type === 'video') {
          const arts = (await ds.query(`select id, type, storage_bucket as bucket, storage_path as path from public.artifacts where item_run_id = $1`, [ir.id]));
          videoOf.set(it.chapterId, { identity: IA.artifactOutputIdentity(arts), itemRunId: ir.id, generation: 1, artifactIds: arts.map((x) => x.id) });
        }
      }
      return { runId: job.id, pendingKey };
    }

    await check('[PK] regresión: run SIN config → al completarse, marca eligibleAt + UN paquete automático (empaque automático global sin cambios)', async () => {
      const C = await confirmedCourse('PK sin config');
      const { runId, pendingKey } = await seededRealRun(C, 'final_exam');
      await completeTail(runId, pendingKey, 'w-final');
      const row = await runRow(runId);
      eq(row.worker_status, 'completed', 'completed');
      assert(row.output_summary.autoPackage && row.output_summary.autoPackage.eligibleAt && !row.output_summary.autoPackage.held, 'marca: ' + JSON.stringify(row.output_summary.autoPackage));
      const jobs = await pkgJobs(runId);
      eq([jobs.length, jobs[0] && jobs[0].input_payload.auto], [1, true], 'un job automático');
      eq(process.env.DYNAMIC_AUTO_PACKAGE_ENABLED, undefined, 'la variable global no se tocó');
    });

    let H = null;
    await check('[PK] holdPackaging + detener después del examen FINAL (última parte): el run pasa a `completed` con autoPackage.held y SIN eligibleAt → 0 jobs (aviso post-commit, ensure y barrido); GET: packageHold, completion no automática', async () => {
      const C = await confirmedCourse('PK retenido');
      const { runId, pendingKey } = await seededRealRun(C, 'final_exam');
      await runs.setStopAfter(C.cid, OWNER, 1, runId, { itemKeys: [pendingKey], holdPackaging: true });
      await completeTail(runId, pendingKey, 'w-final');
      const row = await runRow(runId);
      eq(row.worker_status, 'completed', 'la última parte cierra el run (pausado o no)');
      eq(row.output_summary.stopAfter.firedItemKey, pendingKey, 'disparó');
      assert(row.output_summary.autoPackage.held && !row.output_summary.autoPackage.eligibleAt, 'retenido: ' + JSON.stringify(row.output_summary.autoPackage));
      eq((await pkgJobs(runId)).length, 0, 'sin job por el aviso post-commit');
      const o = await autoPkg.ensure(runId);
      eq([o.action, o.reason], ['skipped', 'held'], 'ensure');
      const sw = await autoPkg.sweep();
      assert(!sw.some((x) => x.runId === runId), 'el barrido no lo toma');
      eq((await pkgJobs(runId)).length, 0, 'sigue sin job');
      const dto = await runs.getRun(C.cid, OWNER, 1, runId);
      eq([!!dto.packageHold, dto.packageHold.reason, dto.completion.generationComplete, dto.completion.packageJob && dto.completion.packageJob.auto, dto.completion.packageJob && dto.completion.packageJob.held], [true, 'stop_after_item', true, false, true], 'GET');
      const list = await admin.listNeedsAttention({ limit: 100 });
      assert(list.heldPackage.some((e) => e.runId === runId && e.packageHold && e.adminActions.length === 0), 'cola de admin: en heldPackage, sin acción de un clic: ' + JSON.stringify(list.heldPackage).slice(0, 300));
      assert(!list.manualPackage.some((e) => e.runId === runId), 'cola de admin: NO es «paquete manual pendiente» (sin retry_package)');
      H = { C, runId };
    });

    await check('[PK] (review r2 N1 + M5) TODO se completa mientras el run está pausado por el USUARIO: el run cierra `completed` con el empaque RETENIDO y la config queda VENCIDA (firedAt + expiredAt) → una reapertura posterior no dispara una pausa tardía', async () => {
      const C = await confirmedCourse('PK pausado al cerrar');
      const { runId, pendingKey } = await seededRealRun(C, 'final_exam');
      await runs.setStopAfter(C.cid, OWNER, 1, runId, { itemKeys: [pendingKey], holdPackaging: true });
      await runs.pauseRun(C.cid, OWNER, 1, runId);
      await completeTail(runId, pendingKey, 'w-final');
      const row = await runRow(runId);
      eq([row.worker_status, !!(row.output_summary.autoPackage && row.output_summary.autoPackage.held)], ['completed', true], 'cerrado con el empaque retenido');
      assert(row.output_summary.stopAfter.firedAt && row.output_summary.stopAfter.expiredAt && !row.output_summary.stopAfter.firedItemKey, 'config vencida: ' + JSON.stringify(row.output_summary.stopAfter));
      eq((await pkgJobs(runId)).length, 0, 'sin paquete');
      // Reapertura simulada (como una regeneración): el run vuelve a `running` → el recálculo nunca pausa por la config vencida.
      await ds.query(`update public.production_jobs set status = 'running', worker_status = 'running' where id = $1`, [runId]);
      const fired = await runs.tx(async (qr) => { await qr.query(`select id from public.production_jobs where id = $1 for update`, [runId]); return SA.applyStopAfterInTx(qr, await runRow(runId)); });
      eq(fired, false, 'la config vencida no pausa');
    });

    await check('[PK] liberar la retención (acción explícita) → marca eligibleAt + UN job (aviso post-commit); liberar de nuevo → 409; el botón manual devuelve el MISMO job', async () => {
      const dto = await runs.releasePackageHold(H.C.cid, OWNER, 1, H.runId);
      await runs.settleRunCompletedHooks();
      eq([dto.packageHold, dto.stopAfter.holdPackaging], [null, false], 'liberado');
      const jobs = await pkgJobs(H.runId);
      eq([jobs.length, jobs[0] && jobs[0].input_payload.auto], [1, true], 'un job automático');
      await rejects(runs.releasePackageHold(H.C.cid, OWNER, 1, H.runId), 409, 'package_not_held', 'segunda vez');
      const man = await packaging.requestPackage(H.C.cid, OWNER, 1, H.runId, { id: OWNER, email: 'owner@cursia.test' });
      eq([man.created, man.jobId], [false, jobs[0].id], 'botón manual = mismo job');
      eq((await pkgJobs(H.runId)).length, 1, 'sigue habiendo UN job');
    });

    await check('[PK] solo-retención (itemKeys vacío): el run no se pausa y al completarse queda retenido; el botón MANUAL (acción explícita) sí arma el paquete', async () => {
      const C = await confirmedCourse('PK solo retención');
      const { runId, pendingKey } = await seededRealRun(C, 'final_exam');
      await runs.setStopAfter(C.cid, OWNER, 1, runId, { itemKeys: [], holdPackaging: true });
      await completeTail(runId, pendingKey, 'w-final');
      const row = await runRow(runId);
      eq([row.worker_status, row.output_summary.autoPackage.held && row.output_summary.autoPackage.held.reason, row.output_summary.pause], ['completed', 'package_hold', undefined], 'completo, retenido (package_hold), nunca pausado');
      eq((await pkgJobs(runId)).length, 0, 'sin job automático');
      const man = await packaging.requestPackage(C.cid, OWNER, 1, runId, { id: OWNER, email: 'owner@cursia.test' });
      assert(man.created && man.jobId, 'el manual crea el job (acción explícita)');
      await rejects(runs.setStopAfter(C.cid, OWNER, 1, runId, { itemKeys: [], holdPackaging: true }), 409, 'run_not_active', 'config sobre un run terminado');
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
