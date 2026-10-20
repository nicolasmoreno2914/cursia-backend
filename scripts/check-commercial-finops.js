#!/usr/bin/env node
/* eslint-disable */
// T7 (r57) — FinOps de la SIMULACIÓN COMERCIAL: los cursos S (cliente A), M (cliente B) y L (cliente C) de
// scripts/fixtures/commercial-simulation/courses.json se congelan (Blueprint) y arrancan un run REAL en un PG16
// desechable (migraciones del repo); cada parte del run «llama» a su proveedor FALSO con el protocolo de los workers
// (scripts: src/workers/finops-worker-hooks.ts — reserva durable → llamada → liquidación atómica) y el
// CostReadService (la única fuente de dinero del dashboard) se verifica contra lo que se registró:
//
//   [FA1] atribución: cada evento lleva course_id / run_id / item_key / provider / model del curso, run y parte que
//         lo causó; ningún evento cruza de curso o de run; los modelos registrados son los de cada proveedor
//   [FA2] runCost: Σ byItemKey = Σ byProvider = Σ byItemType = comprometido = real + reservado (sin doble conteo);
//         cada parte pagada aparece UNA vez; el empaque (cero por diseño) sin parte
//   [FA3] reservas ≠ gasto: las liquidadas netean 0; la ABIERTA de L cuenta solo como «reservado» (nunca «real»)
//   [FA4] estimado aparte: el del run (startRun) se informa y no entra en real/comprometido
//   [FA5] reintento: la llamada de validation_retry cuenta como 1 llamada de reintento (reserva + final = 1)
//   [FA6] courseCost = runCost (un run); curso SIN eventos → no_data (montos null) ≠ curso solo MOCK → ok, USD 0
//   [FA7] el orden S < M < L del gasto simulado sigue al del estimado (misma composición, mismo motor)
//   [FA8] desglose por modelo: el ledger lo guarda (model_or_product) pero CostReadService NO tiene byModel → se
//         informa como hallazgo (el check deja constancia, no falla)
//
// USD 0: sin red, sin proveedores reales (montos sintéticos y precios del catálogo semilla del repo).
// Usage: npm run build && node scripts/check-commercial-finops.js
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
const S = require('./lib/commercial-simulation');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/commercial-simulation/courses.json'), 'utf8'));
// r61 (Q-24): este check simula cursos comerciales S/M/L con audio real (alto proyectado hasta ≈ 232 MiB); corre con el
// límite recomendado para producción (300.000.000 B, plan Pro) para medir FinOps, no el bloqueo por tamaño.
if (!process.env.STORAGE_MAX_UPLOAD_BYTES) process.env.STORAGE_MAX_UPLOAD_BYTES = '300000000';
const OUT = process.env.T7_OUT_DIR || path.join(os.homedir(), 'cursia-test-env/work/r57/t7-out');

let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
const n10 = (v) => Math.round(Number(v) * 1e8) / 1e8;
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
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => ([5570, 5580, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port))); });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const CONTEXT = { nombre: 'Curso de ejemplo', sector: 'Servicios', pais: 'Colombia', contexto: 'Empresa', nivel: 'Intermedio', tono: 'cercano' };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION', 'DYNAMIC_VIDEO_DELIVERY',
  'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY', 'SUPER_ADMIN_EMAILS', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const PROVIDER_OF = (type) => (type === 'video' ? 'videogen' : type === 'presentation' ? 'gamma' : /^audio/.test(type) ? 'openai' : 'anthropic');
const MODEL_OF = { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o-mini-tts', gamma: 'gamma-generate', videogen: 'video' };

(async () => {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = L('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = L('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = L('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = L('modules/dynamic-generation/runs.service.js');
  const { Artifact } = L('modules/artifacts/entities/artifact.entity.js');
  const AL = L('modules/reliability/attempt-log.js');
  const EL = L('modules/reliability/execution-lease.js');
  const F = L('modules/finops/index.js');
  const CR = L('modules/finops/cost-read.service.js');
  const WH = L('workers/finops-worker-hooks.js');

  // Cursos de la simulación (mismo motor, solo configuración) — el Blueprint congelado de cada uno.
  const sims = {};
  for (const id of ['A-S', 'B-M', 'C-L']) sims[id] = await S.simulateCourse(distRoot, CONFIG.courses.find((c) => c.id === id));

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-t7finops-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-t7finops-cwd-'));
  const ROLE = 'postgres.t7finopslocal01';
  const DB = 't7finopsdb';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const restoreProviders = applyFakeProviderEnv();
  let ds = null;
  const evidence = {};
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
    await withClient(DB, async (c) => { for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql', 'supabase-migration-pedagogy-profiles.sql',
      'supabase-migration-practice-chapters.sql', 'supabase-migration-application-activities.sql', 'supabase-migration-guided-practice.sql', 'supabase-migration-academic-context.sql', 'supabase-migration-ev6-h5p2.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8')); });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js', 'scripts/migrate-v21-finops.js',
      'scripts/verify-v21-finops-schema.js', 'scripts/migrate-rel-recovery.js', 'scripts/migrate-rel-exec-lease.js', 'scripts/migrate-run-pause.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }
    // Las migraciones que reescriben los CHECK del Manifest v3 corren DESPUÉS de migrate-v21-manifest-v3 (idempotentes).
    await withClient(DB, async (c) => { for (const f of ['supabase-migration-practice-chapters.sql', 'supabase-migration-application-activities.sql', 'supabase-migration-guided-practice.sql', 'supabase-migration-ev6-h5p2.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8')); });
    Object.assign(process.env, { DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_REAL_VIDEO_OWNERS: OWNER, DYNAMIC_MANIFEST_RULES_VERSION: '3', DYNAMIC_VIDEO_DELIVERY: 'youtube',
      DYNAMIC_PROVIDER_WORKER_ENABLED: 'true', VIDEOGEN_API_KEY: 'fake-videogen-key-never-used-no-network', SUPER_ADMIN_EMAILS: 'admin@cursia.test',
      SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-local-only' });
    AL.resetRelSchemaCache(); EL.resetExecLeaseSchemaCache();
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 6 } });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const runs = new RunsService(ds, manifests, {}, { async check() { return { ok: true }; } }, budget);
    const costRead = new CR.CostReadService(ds);

    /** Curso con el Blueprint congelado de la simulación + run arrancado (Manifest v3 + partes + estimado). */
    async function startCourse(sim, copy = 0) {
      // copy > 0: otro curso con el MISMO diseño (ids de módulos/capítulos propios).
      const lk = copy ? JSON.parse(JSON.stringify(sim.locked).replace(/00000000-0000-4000-8000-/g, `0000000${copy}-0000-4000-8000-`)) : sim.locked;
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, lk.course.title]);
      const cid = course.id;
      const s2 = JSON.parse(JSON.stringify(lk));
      s2.course.id = cid;
      for (const m of s2.modules) {
        await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
        for (const c of m.chapters) await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`, [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
      }
      const nCh = s2.modules.reduce((n, m) => n + m.chapters.length, 0);
      await ds.query(`insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count) values ($1, 1, 2, $2::jsonb, $3, 0, $4, $5)`,
        [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2), s2.modules.length, nCh]);
      await manifests.getOrCreate(cid, OWNER, 1);
      let runId;
      try { runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id; } catch (err) {
        const body = err.getResponse ? err.getResponse() : null;
        assert(body && body.code === 'budget_approval_required', `startRun: ${err.message}`);
        await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test', reason: 'check T7 FinOps (proveedores falsos)' });
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      }
      const items = await ds.query(`select id, item_key, type, generation from public.generation_item_runs where job_id = $1 order by item_key`, [runId]);
      return { cid, runId, items };
    }

    /** Ejecuta las partes con proveedores FALSOS por el protocolo de los workers (reserva → llamada → liquidación). */
    async function executeFake(run, o = {}) {
      const ledgerTrace = [];
      let seq = 0;
      for (const it of run.items) {
        const provider = PROVIDER_OF(it.type);
        seq++;
        const base = { ownerId: OWNER, itemRunId: it.id, generation: it.generation || 1 };
        const openThis = o.openReservationKey === it.item_key;
        const call = async (attempt, tag) => {
          const kind = provider === 'anthropic' ? 'llm' : provider === 'openai' ? 'tts' : provider;
          const key = await WH.reservePaidCall(ledger, { ...base, kind, itemAttempt: attempt, tag, estimate: { promptChars: 24000, maxTokens: 6000, characters: 9000 } });
          if (openThis) { ledgerTrace.push({ itemKey: it.item_key, provider, open: true }); return; } // la llamada no terminó: reserva ABIERTA
          let fin;
          if (provider === 'anthropic') {
            fin = WH.serverLlmChargeInput({ ownerId: OWNER, itemRunId: it.id, model: MODEL_OF.anthropic, messageId: `msg_t7_${run.runId.slice(0, 8)}_${seq}_${attempt}`, requestId: null,
              usage: { input_tokens: 4000 + 37 * seq, output_tokens: 1500 + 11 * seq }, callRole: attempt > 1 ? 'validation_retry' : 'main', attempt });
          } else if (provider === 'videogen') {
            fin = WH.videogenChargeInput({ ownerId: OWNER, itemRunId: it.id, jobId: `vg_t7_${run.runId.slice(0, 8)}_${seq}`, mode: 'real', cost: 0.94, outputSummary: null });
          } else if (provider === 'gamma') {
            fin = WH.gammaChargeInput({ ownerId: OWNER, itemRunId: it.id, generationId: `gen_t7_${run.runId.slice(0, 8)}_${seq}`, creditsDeducted: 40, creditsRemaining: 1000, itemAttempt: attempt });
          } else {
            fin = WH.ttsChargeInput({ ownerId: OWNER, itemRunId: it.id, requestId: `req_t7_${run.runId.slice(0, 8)}_${seq}`, audioSeconds: 300 + seq, characters: 4500, model: MODEL_OF.openai, generation: base.generation, chunk: 0, itemAttempt: attempt });
          }
          await WH.settlePaidCall(ledger, key, fin, 'measured');
          ledgerTrace.push({ itemKey: it.item_key, provider, attempt });
        };
        if (o.mockAll) {
          if (it.type === 'presentation' || /^audio/.test(it.type)) await WH.recordProviderMock(ledger, { ownerId: OWNER, itemRunId: it.id, itemType: it.type, externalId: `mock_${run.runId.slice(0, 8)}_${seq}` });
          continue;
        }
        await call(1, 'main');
        if (o.retryKey === it.item_key) await call(2, 'retry');
      }
      if (!o.mockAll) await WH.recordPackageBuild(ledger, { ownerId: OWNER, packageJobId: `pkg_t7_${run.runId.slice(0, 8)}`, runId: run.runId });
      return ledgerTrace;
    }

    const R = {};
    for (const [id, sim] of Object.entries(sims)) {
      const run = await startCourse(sim);
      const firstContent = run.items.find((i) => i.type === 'content');
      const lastVideo = [...run.items].reverse().find((i) => i.type === 'video');
      const trace = await executeFake(run, {
        ...(id === 'B-M' ? { retryKey: firstContent.item_key } : {}),
        ...(id === 'C-L' ? { openReservationKey: lastVideo.item_key } : {}),
      });
      R[id] = { ...run, trace, sim };
    }
    // Curso sin eventos (no_data) y curso solo MOCK (USD 0, ok): mismo Blueprint que S.
    const noData = await startCourse(sims['A-S'], 1);
    const mockOnly = await startCourse(sims['A-S'], 2);
    await executeFake(mockOnly, { mockAll: true });

    const rows = async (where, p) => ds.query(`select course_id, run_id, item_key, item_type, provider, model_or_product, event_kind, amount::text as amount, billing_account, call_role, metadata from public.generation_cost_events where ${where}`, p);

    await check('[FA1] atribución: curso / run / parte / proveedor / modelo de cada evento = los de la parte que lo causó; nada cruza de curso o run', async () => {
      for (const [id, x] of Object.entries(R)) {
        const ev = await rows('run_id = $1', [x.runId]);
        assert(ev.length > 0, `${id}: eventos`);
        const byKey = new Map(x.items.map((i) => [i.item_key, i]));
        for (const e of ev) {
          eq(Number(e.course_id), x.cid, `${id}: course_id`);
          if (e.item_key === null) { eq([e.provider, e.amount], ['cursia', '0.0000000000'], `${id}: evento sin parte = empaque a 0`); continue; }
          const it = byKey.get(e.item_key);
          assert(it, `${id}: item_key ${e.item_key} es una parte del run`);
          eq(e.item_type, it.type, `${id}: item_type de ${e.item_key}`);
          eq(e.provider, PROVIDER_OF(it.type), `${id}: proveedor de ${e.item_key}`);
          eq(e.model_or_product, MODEL_OF[e.provider], `${id}: modelo de ${e.item_key}`);
        }
        const other = await rows('course_id = $1 and run_id <> $2', [x.cid, x.runId]);
        eq(other.length, 0, `${id}: eventos del curso en otro run`);
      }
      const unattributed = await rows('course_id is null', []);
      eq(unattributed.length, 0, 'eventos sin atribuir');
    });

    await check('[FA2] runCost: Σ byItemKey = Σ byProvider = Σ byItemType = comprometido = real + reservado; cada parte pagada UNA vez', async () => {
      for (const [id, x] of Object.entries(R)) {
        const rc = await costRead.runCost(x.runId);
        x.rc = rc;
        eq(rc.status, 'ok', `${id}: status`);
        const sum = (arr) => n10(arr.reduce((n, r) => n + Number(r.committed), 0));
        eq(n10(rc.committed), n10(Number(rc.actual) + Number(rc.reserved)), `${id}: comprometido = real + reservado`);
        eq(sum(rc.byItemKey), n10(rc.committed), `${id}: Σ por parte`);
        eq(sum(rc.byProvider), n10(rc.committed), `${id}: Σ por proveedor`);
        eq(sum(rc.byItemType), n10(rc.committed), `${id}: Σ por tipo de parte`);
        const keys = rc.byItemKey.map((r) => r.key).filter(Boolean);
        eq(keys.length, new Set(keys).size, `${id}: cada parte una vez`);
        eq([...keys].sort(), [...new Set(x.trace.map((t) => t.itemKey))].sort(), `${id}: las partes con gasto = las ejecutadas`);
        eq(rc.byProvider.map((p) => p.key).sort(), [...new Set(x.items.map((i) => PROVIDER_OF(i.type))), 'cursia'].sort(), `${id}: proveedores`);
        // Real = Σ de los cargos finales (lo que el ledger tiene, no lo que el check supone).
        const ev = await rows(`run_id = $1 and billing_account = 'cursia' and not coalesce((metadata->>'reservation')::boolean, false) and event_kind = 'CHARGE'`, [x.runId]);
        if (id !== 'C-L') eq(n10(rc.actual), n10(ev.reduce((n, e) => n + Number(e.amount), 0)), `${id}: real = Σ cargos finales`);
        assert(Number(rc.actual) > 0, `${id}: gasto > 0`);
      }
    });

    await check('[FA3] reservas ≠ gasto: liquidadas netean 0; la reserva ABIERTA de L cuenta solo como reservado (y como reserva abierta)', async () => {
      for (const id of ['A-S', 'B-M']) { eq(R[id].rc.reserved, '0.0000000000', `${id}: sin reservado`); eq(R[id].rc.counts.openReservations, 0, `${id}: sin reservas abiertas`); }
      const l = R['C-L'].rc;
      const open = await rows(`run_id = $1 and coalesce((metadata->>'reservation')::boolean, false) and event_kind = 'CHARGE' and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = generation_cost_events.id)`, [R['C-L'].runId]);
      eq(open.length, 1, 'L: una reserva abierta');
      eq(n10(l.reserved), n10(open[0].amount), 'L: reservado = la reserva abierta');
      eq(l.counts.openReservations, 1, 'L: contador de reservas abiertas');
      const row = l.byItemKey.find((r) => r.key === open[0].item_key);
      eq([row.actual, n10(row.reserved)], ['0.0000000000', n10(open[0].amount)], 'L: la parte de la reserva abierta no tiene gasto real');
    });

    await check('[FA4] estimado aparte: el estimado del run (startRun) se informa y no entra en real ni comprometido', async () => {
      for (const [id, x] of Object.entries(R)) {
        const [est] = await ds.query(`select totals from public.cost_estimates where run_id = $1 order by created_at desc limit 1`, [x.runId]);
        assert(est && x.rc.estimated && x.rc.estimated.expected !== null, `${id}: estimado del run`);
        eq(n10(x.rc.estimated.expected), n10(est.totals.expected), `${id}: estimado = cost_estimates`);
        const ev = await rows(`run_id = $1`, [x.runId]);
        eq(n10(x.rc.committed), n10(ev.filter((e) => e.billing_account === 'cursia').reduce((n, e) => n + Number(e.amount), 0)), `${id}: comprometido = Σ ledger (el estimado no suma)`);
      }
    });

    await check('[FA5] reintento: la llamada validation_retry = 1 llamada de reintento con su costo (reserva + final no cuentan doble)', async () => {
      eq(R['B-M'].rc.retries.calls, 1, 'M: un reintento');
      assert(Number(R['B-M'].rc.retries.committed) > 0, 'M: costo del reintento');
      eq([R['A-S'].rc.retries.calls, R['C-L'].rc.retries.calls], [0, 0], 'S y L sin reintentos');
      const k = R['B-M'].items.find((i) => i.type === 'content').item_key;
      const row = R['B-M'].rc.byItemKey.find((r) => r.key === k);
      eq(row.providerCalls, 2, 'M: la parte reintentada = 2 llamadas (principal + reintento)');
    });

    await check('[FA6] courseCost = runCost (un run); sin eventos → no_data con montos null; solo MOCK → ok y USD 0 exacto', async () => {
      for (const [id, x] of Object.entries(R)) {
        const cc = await costRead.courseCost(x.cid);
        eq([cc.committed, cc.actual, cc.reserved], [x.rc.committed, x.rc.actual, x.rc.reserved], `${id}: curso = run`);
        eq(cc.runs.length, 1, `${id}: un run`);
      }
      const nd = await costRead.courseCost(noData.cid);
      eq([nd.status, nd.actual, nd.committed], ['no_data', null, null], 'curso sin eventos: sin datos (nunca «USD 0»)');
      assert(nd.estimated && nd.estimated.expected !== null, 'curso sin eventos: el estimado igual se informa (aparte)');
      const mo = await costRead.courseCost(mockOnly.cid);
      eq([mo.status, mo.actual, mo.committed], ['ok', '0.0000000000', '0.0000000000'], 'curso solo MOCK: USD 0 real');
      assert(mo.counts.eventsMock > 0, 'curso solo MOCK: eventos mock contados');
    });

    await check('[FA7] gasto simulado S < M < L, como el estimado (la composición manda, mismo motor)', async () => {
      const c = ['A-S', 'B-M', 'C-L'].map((k) => Number(R[k].rc.committed));
      const e = ['A-S', 'B-M', 'C-L'].map((k) => Number(R[k].rc.estimated.expected));
      assert(c[0] < c[1] && c[1] < c[2], `comprometido ${c}`);
      assert(e[0] < e[1] && e[1] < e[2], `estimado ${e}`);
    });

    await check('[FA8] desglose por modelo: el ledger lo guarda por evento y CostReadService lo expone (byModel, F2)', async () => {
      const models = await ds.query(`select provider, model_or_product, count(*)::int n, sum(amount)::text total from public.generation_cost_events where billing_account = 'cursia' group by 1, 2 order by 1, 2`);
      evidence.models = models;
      for (const m of models) if (m.provider !== 'cursia') eq(m.model_or_product, MODEL_OF[m.provider], `modelo de ${m.provider}`);
      const rc = R['A-S'].rc;
      evidence.costReadHasByModel = Object.prototype.hasOwnProperty.call(rc, 'byModel');
      assert(evidence.costReadHasByModel, 'F2: CostReadService expone byModel');
      const sum = (arr) => n10(arr.reduce((n, r) => n + Number(r.committed), 0));
      eq(sum(rc.byModel), n10(rc.committed), 'Σ por modelo = comprometido');
      eq(sum(rc.byModel.filter((g) => g.provider !== 'cursia' && g.provider !== null)), sum(rc.byProvider.filter((g) => g.key !== 'cursia')), 'Σ modelos de proveedor = Σ proveedores externos');
      for (const g of rc.byModel) if (g.provider !== 'cursia' && MODEL_OF[g.provider]) eq(g.model, MODEL_OF[g.provider], `byModel: modelo de ${g.provider}`);
    });

    for (const [id, x] of Object.entries(R)) evidence[id] = { courseId: x.cid, runId: x.runId, items: x.items.length, committed: x.rc && x.rc.committed, actual: x.rc && x.rc.actual, reserved: x.rc && x.rc.reserved, estimated: x.rc && x.rc.estimated && x.rc.estimated.expected, retries: x.rc && x.rc.retries, byProvider: x.rc && x.rc.byProvider.map((p) => [p.key, p.committed, p.providerCalls]) };
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'commercial-finops-evidence.json'), JSON.stringify(evidence, null, 2));
    for (const id of Object.keys(R)) console.log(`   ${id}: ${R[id].items.length} partes · comprometido ${Number(evidence[id].committed).toFixed(4)} = real ${Number(evidence[id].actual).toFixed(4)} + reservado ${Number(evidence[id].reserved).toFixed(4)} · estimado ${Number(evidence[id].estimated).toFixed(2)} (aparte)`);
  } finally {
    if (ds) await ds.destroy().catch(() => {});
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    restoreProviders();
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
  console.log(`\n${passes} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
