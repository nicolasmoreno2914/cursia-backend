#!/usr/bin/env node
/* eslint-disable */
// FinOps ATÓMICO (2026-10-14, examen final de #1353): con 4 llamadas en paralelo del worker de IA las reservas del run
// llegaron a USD 47,62 con un tope de 47,50 (el guard leía el total y la reserva se insertaba después: TOCTOU).
// Ahora la RESERVA se inserta solo si el run sigue dentro de su presupuesto autorizado, en UNA transacción serializada
// por run (pg_advisory_xact_lock), y la reserva de una llamada LLM es una cota superior del cargo real.
//   [UB] cota: llmCallUpperBoundUsage (entrada a precio de escritura de caché + salida al tope) ≥ cualquier cargo real
//        posible (mezcla entrada/caché escrita/leída, salida ≤ max_tokens) con tokens ≤ caracteres/3;
//   [AT] 60 reservas en paralelo desde 3 «procesos» (3 DataSource) contra un tope → la suma NUNCA supera el tope y se
//        aceptan exactamente las que entran; reintento idempotente; BLOCKED = 0; sin autorización = RECHAZO (r58 H4,
//        falla cerrado); BYOK y mock fuera; precio faltante → monto conservador (nunca 0); liquidar libera lugar;
//   [WK] worker de IA real (createServerApi) con 8 llamadas en paralelo y el guard real: solo llegan a Anthropic las
//        que caben; el resto → run_paused sin llamar, run pausado (run_budget_cap); con el guard «engañado» (permite
//        todo) el ledger sigue impidiendo el exceso; proxy del navegador: 409 run_paused + run pausado.
//   [H4] r58: run SIN ninguna fila de cost_budget_authorizations → toda reserva pagada (Cursia, real) se rechaza
//        (RUN_BUDGET_NOT_AUTHORIZED) ANTES de reservar: ledger, lote, guard del worker y del proxy, worker de IA real
//        (0 pedidos a Anthropic), reanudar sin autorización → 409; mock / BYOK / monto 0 no cambian; con autorización → OK.
// PG16 desechable + Anthropic falso en 127.0.0.1; USD 0.
//
// Usage: npm run build && node scripts/check-finops-atomic-cap.js
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
const http = require('http');
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
const CONTEXT = { nombre: 'Curso FinOps atómico', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };

const ENV_KEYS2 = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION', 'DYNAMIC_VIDEO_DELIVERY',
  'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY', 'SUPER_ADMIN_EMAILS', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

const sse = (t, o) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...o })}\n\n`;
/** Anthropic falso (SSE): cuenta pedidos; cada respuesta tarda `holdMs` (llamadas realmente en paralelo). */
async function fakeAnthropic(holdMs = 150) {
  const st = { requests: 0 };
  const srv = http.createServer(async (req, res) => {
    for await (const _ of req) { /* body */ }
    st.requests++;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse('message_start', { message: { id: 'msg_' + st.requests + '_' + Math.random().toString(36).slice(2), model: 'claude-sonnet-4-6', usage: { input_tokens: 900, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }));
      res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }));
      res.write(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 700 } }));
      res.end(sse('message_stop', {}));
    }, holdMs);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, st, close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => r()); }) };
}

async function pureChecks() {
  const LUI = L('modules/finops/llm-usage-ingest.js');
  const P = L('modules/finops/pricing.js');
  const seed = require(path.join(REPO, 'src/modules/finops/pricing-seed.v1.json')).rows.map((r) => ({ ...r, effective_from: '2020-01-01', effective_to: null }));
  await check('[UB] puro: la cota de la reserva (entrada a precio de escritura de caché + salida al tope) ≥ todo cargo real posible (1000 mezclas aleatorias con tokens ≤ caracteres/3 y salida ≤ max_tokens), para cada modelo Anthropic del catálogo', () => {
    const models = [...new Set(seed.filter((r) => r.provider === 'anthropic').map((r) => r.product_or_model))];
    let worst = Infinity;
    for (const model of models) {
      const target = { provider: 'anthropic', service: 'messages', product: model };
      for (let i = 0; i < 1000; i++) {
        const promptChars = 500 + Math.floor(Math.random() * 120000);
        const maxTokens = 500 + Math.floor(Math.random() * 12000);
        const inTok = Math.floor((promptChars / LUI.LLM_RESERVATION_CHARS_PER_TOKEN) * Math.random());
        const w = Math.random(); const rd = Math.random() * (1 - w);
        const real = { input_tokens: Math.floor(inTok * (1 - w - rd)), cache_write_tokens: Math.floor(inTok * w), cache_read_tokens: Math.floor(inTok * rd), output_tokens: Math.floor(maxTokens * Math.random()) };
        const bound = Math.max(...P.llmUpperBoundVariants(LUI.llmCallUpperBoundUsage(promptChars, maxTokens)).map((v) => Number(P.priceUsage(v, seed, target).amount)));
        const actual = Number(P.priceUsage(real, seed, target).amount);
        assert(actual <= bound + 1e-9, `${model}: real ${actual} > cota ${bound}`);
        worst = Math.min(worst, bound - actual);
      }
    }
    assert(worst >= 0, 'margen');
  });
  await check('[UB] puro: catálogo INCONSISTENTE (entrada más cara que la escritura de caché): la cota usa el máximo de sus variantes → sigue ≥ el cargo real', () => {
    const odd = seed.map((r) => (r.product_or_model === 'claude-sonnet-4-6' && r.meter === 'input_tokens' ? { ...r, unit_price: '30' } : r));
    const target = { provider: 'anthropic', service: 'messages', product: 'claude-sonnet-4-6' };
    const usage = LUI.llmCallUpperBoundUsage(3000, 2000);
    const bound = Math.max(...P.llmUpperBoundVariants(usage).map((v) => Number(P.priceUsage(v, odd, target).amount)));
    const real = Number(P.priceUsage({ input_tokens: 1000, output_tokens: 2000 }, odd, target).amount);
    assert(bound >= real, `cota ${bound} ≥ real ${real}`);
  });
  await check('[UB] puro: precio conservador (tarifa más cara por medidor) > 0; medidor sin tarifa → CALL_UNPRICED', () => {
    const c = Number(P.conservativePrice({ cache_write_tokens: 1000, output_tokens: 1000 }, seed));
    const opus = Number(P.priceUsage({ cache_write_tokens: 1000, output_tokens: 1000 }, seed, { provider: 'anthropic', service: 'messages', product: 'claude-opus-4-8' }).amount);
    assert(c >= opus && c > 0, `conservador ${c} ≥ el más caro ${opus}`);
    let e = null; try { P.conservativePrice({ medidor_inventado: 1 }, seed); } catch (x) { e = x; }
    assert(e && e.code === 'CALL_UNPRICED', 'sin tarifa');
  });
}

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
  const AL = L('modules/reliability/attempt-log.js');
  const EL = L('modules/reliability/execution-lease.js');
  const F = L('modules/finops/index.js');
  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-atomcap-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-atomcap-cwd-'));
  const ROLE = 'postgres.atomcaplocal01';
  const DB = 'atomcapdb';
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
    Object.assign(process.env, { DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_REAL_VIDEO_OWNERS: OWNER, DYNAMIC_MANIFEST_RULES_VERSION: '3', DYNAMIC_VIDEO_DELIVERY: 'youtube',
      DYNAMIC_PROVIDER_WORKER_ENABLED: 'true', VIDEOGEN_API_KEY: 'fake-videogen-key-never-used-no-network', SUPER_ADMIN_EMAILS: 'admin@cursia.test',
      SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-local-only' });
    AL.resetRelSchemaCache(); EL.resetExecLeaseSchemaCache();
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 6 } });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const budget = new F.FinopsBudgetService(ds, new F.FinopsLedgerService(ds));
    const runs = new RunsService(ds, manifests, {}, { async check() { return { ok: true }; } }, budget);
    const sched = new SchedulerService(ds, runs);

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
        await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test', reason: 'check finops atomic' });
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
    const { FinopsLlmReservationController } = L('modules/finops/finops.controller.js');
    const { createServerApi } = L('workers/llm-executor/server-llm.js');
    const WH = L('workers/finops-worker-hooks.js');
    const LUI = L('modules/finops/llm-usage-ingest.js');
    const ledger = new F.FinopsLedgerService(ds);
    // Tres «procesos» (pools independientes) que reservan contra el mismo run.
    const extraDs = [];
    for (let i = 0; i < 2; i++) {
      const d = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 8 } });
      await d.initialize(); extraDs.push(d);
    }
    const ledgers = [ledger, ...extraDs.map((d) => new F.FinopsLedgerService(d))];
    const itemOf = async (runId) => (await ds.query(`select id from public.generation_item_runs where job_id = $1 and type = 'content' order by item_key limit 1`, [runId]))[0];
    const runTotal = async (runId) => Number((await ds.query(`select coalesce(sum(amount),0)::text t from public.generation_cost_events where run_id = $1 and billing_account <> 'user_key'`, [runId]))[0].t);
    const authorize = async (runId, cid, amount, decision = 'ADMIN_APPROVED') => ds.query(
      `insert into public.cost_budget_authorizations (run_id, course_id, authorized_budget, currency, decision, approved_by, reason) values ($1, $2, $3, 'USD', $4, 'admin@cursia.test', 'check atomic')`,
      [runId, cid, amount, decision]);
    const resInput = (itemRunId, tag, extra = {}) => ({
      itemRunId, ownerIdFromAuth: OWNER, provider: 'anthropic', service: 'messages', modelOrProduct: 'claude-sonnet-4-6',
      usage: LUI.llmCallUpperBoundUsage(30000, 12000), usageUnit: 'output_tokens', externalOperationId: null,
      idempotencyKey: `reservation:test:${itemRunId}:${tag}`, callRole: 'main', attempt: 1, billingAccount: 'cursia', mode: 'real',
      costSource: 'CALCULATED_FROM_USAGE', measurementStatus: 'pending', pricingFallback: 'pending_zero', recordedBy: 'check',
      metadata: { reservation: true, callTag: tag }, ...extra,
    });
    // Cota de UNA reserva (30.000 caracteres → 12.000 tokens con chars/2,5; 12.000 de salida; Sonnet 4.6): 12.000 × 3,75/M + 12.000 × 15/M = 0,225.
    const ONE = 0.225;

    await check('[AT] 60 reservas EN PARALELO desde 3 procesos contra un tope de USD 1,00 → se aceptan exactamente 4 (4 × 0,225 = 0,90 ≤ 1,00 < 1,125); el total del run nunca supera el tope; las rechazadas → RUN_BUDGET_CAP con lo que hacía falta', async () => {
      const C = await makeCourse('AT paralelo');
      const it = await itemOf(C.runId);
      await authorize(C.runId, C.cid, '1.00');
      const base = await runTotal(C.runId);
      assert(base === 0, 'run sin gasto previo: ' + base);
      const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => ledgers[i % 3].recordCharge(resInput(it.id, `p${i}`))));
      const ok = results.filter((r) => r.status === 'fulfilled' && r.value.inserted);
      const capped = results.filter((r) => r.status === 'rejected' && r.reason && r.reason.code === 'RUN_BUDGET_CAP');
      eq([ok.length, capped.length, results.length - ok.length - capped.length], [4, 56, 0], 'aceptadas / tope / otros errores');
      const total = await runTotal(C.runId);
      assert(Math.abs(total - 4 * ONE) < 1e-6 && total <= 1.0, `total ${total}`);
      const d = capped[0].reason.details;
      assert(Number(d.requiredUsd) > 1.0 && d.runId === C.runId, 'detalle: ' + JSON.stringify(d));
    });

    await check('[AT] reintento idempotente de una reserva YA aceptada con el run al tope → devuelve la existente (sin error, sin doble conteo); liquidar con el cargo real libera lugar para una reserva nueva', async () => {
      const C = await makeCourse('AT idempotente');
      const it = await itemOf(C.runId);
      // Tope: 2 reservas + 0,04 (la tercera no cabe; tras liquidar «a» con su cargo real de 0,0165 sí).
      await authorize(C.runId, C.cid, String(2 * ONE + 0.04));
      const a = await ledger.recordCharge(resInput(it.id, 'a'));
      const b = await ledger.recordCharge(resInput(it.id, 'b'));
      assert(a.inserted && b.inserted, 'dos caben');
      let e = null; try { await ledger.recordCharge(resInput(it.id, 'c')); } catch (x) { e = x; }
      assert(e && e.code === 'RUN_BUDGET_CAP', 'la tercera no');
      const again = await ledger.recordCharge(resInput(it.id, 'a'));
      eq([again.inserted, Math.abs((await runTotal(C.runId)) - 2 * ONE) < 1e-6], [false, true], 'reintento idempotente');
      await ledger.settleReservation(`reservation:test:${it.id}:a`, {
        itemRunId: it.id, ownerIdFromAuth: OWNER, provider: 'anthropic', service: 'messages', modelOrProduct: 'claude-sonnet-4-6',
        usage: { input_tokens: 500, output_tokens: 1000 }, usageUnit: 'output_tokens', externalOperationId: 'msg_real_a', idempotency: { kind: 'anthropic', parts: { messageId: 'msg_real_a' } },
        callRole: 'main', attempt: 1, billingAccount: 'cursia', mode: 'real', costSource: 'CALCULATED_FROM_USAGE', recordedBy: 'check',
      }, 'test_settled');
      const c = await ledger.recordCharge(resInput(it.id, 'c'));
      assert(c.inserted, 'tras liquidar, la tercera entra');
      assert((await runTotal(C.runId)) <= 2 * ONE + 0.04 + 1e-9, 'sigue dentro del tope');
    });

    await check('[AT] BLOCKED = tope 0 (ninguna reserva); sin ninguna autorización (runs previos a FinOps) = RECHAZO (r58 H4); BYOK (user_key) y mock nunca entran al tope', async () => {
      const C = await makeCourse('AT bloqueado');
      const it = await itemOf(C.runId);
      await authorize(C.runId, C.cid, '100', 'BLOCKED');
      let e = null; try { await ledger.recordCharge(resInput(it.id, 'x')); } catch (x) { e = x; }
      assert(e && e.code === 'RUN_BUDGET_CAP', 'BLOCKED → rechazo');
      const byok = await ledger.recordCharge(resInput(it.id, 'byok', { billingAccount: 'user_key' }));
      assert(byok.inserted, 'BYOK se registra (no consume el presupuesto del run)');
      // Run SIN ninguna autorización (como los previos a FinOps): copia del run anterior con otro id (las
      // autorizaciones son append-only: no se pueden borrar).
      const [j2] = await ds.query(
        `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, progress, input_payload, output_summary, options, result)
         select owner_id, course_id, execution_mode, 'cancelled', 'cancelled', current_step, 0, input_payload, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
           from public.production_jobs where id = $1 returning id`, [C.runId]);
      const [it2] = await ds.query(
        `insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key, status)
         select $2, course_id, blueprint_id, manifest_id, item_key, generation + 100, type, module_id, chapter_id, depends_on, md5(idempotency_key || ':legacy') || md5(idempotency_key), 'pending'
           from public.generation_item_runs where id = $1 returning id`, [it.id, j2.id]);
      eq((await ds.query(`select count(*)::int n from public.cost_budget_authorizations where run_id = $1`, [j2.id]))[0].n, 0, 'sin autorización');
      const many = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => ledger.recordCharge(resInput(it2.id, `n${i}`))));
      assert(many.every((r) => r.status === 'rejected' && r.reason.code === 'RUN_BUDGET_NOT_AUTHORIZED'), 'sin autorización: falla cerrado (r58 H4)');
      eq((await ds.query(`select count(*)::int n from public.generation_cost_events where run_id = $1`, [j2.id]))[0].n, 0, 'ninguna reserva');
    });

    // ── r58 H4: falla cerrado sin autorización ──────────────────────────────────────────────────────────────────────
    /** Run ACTIVO sin ninguna autorización (como uno previo a FinOps): cancela el run de C y crea una copia sin filas. */
    async function noAuthRun(C, workerStatus = 'running') {
      await ds.query(`update public.production_jobs set status = 'cancelled', worker_status = 'cancelled' where id = $1`, [C.runId]);
      const [j] = await ds.query(
        `insert into public.production_jobs (owner_id, course_id, frontend_course_id, execution_mode, status, worker_status, current_step, progress, blueprint_version_id, input_payload, output_summary, options, result)
         select owner_id, course_id, frontend_course_id, execution_mode, $2::text, $2::text, current_step, 0, blueprint_version_id, input_payload, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
           from public.production_jobs where id = $1 returning id`, [C.runId, workerStatus]);
      await ds.query(`insert into public.generation_run_contexts (job_id, manifest_id, context, context_hash) select $2, manifest_id, context, context_hash from public.generation_run_contexts where job_id = $1`, [C.runId, j.id]);
      // Todos los items (el DTO del run exige los del Manifest); la parte de prueba = el primer content.
      await ds.query(
        `insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key, status)
         select $2, course_id, blueprint_id, manifest_id, item_key, generation + 200, type, module_id, chapter_id, depends_on, md5(idempotency_key || ':h4') || md5(idempotency_key), status
           from public.generation_item_runs where job_id = $1`, [C.runId, j.id]);
      const it2 = await itemOf(j.id);
      eq((await ds.query(`select count(*)::int n from public.cost_budget_authorizations where run_id = $1`, [j.id]))[0].n, 0, 'sin autorización');
      return { runId: j.id, itemRunId: it2.id };
    }
    const eventsOf = async (runId) => (await ds.query(`select count(*)::int n from public.generation_cost_events where run_id = $1`, [runId]))[0].n;
    const runRow = async (runId) => (await ds.query(`select worker_status, output_summary->'pause' p from public.production_jobs where id = $1`, [runId]))[0];

    await check('[H4] ledger: run sin autorización → reserva pagada (Cursia, real) y lote RECHAZADOS con RUN_BUDGET_NOT_AUTHORIZED (0 filas); mock, BYOK y monto 0 siguen entrando', async () => {
      const C = await makeCourse('H4 ledger');
      const R = await noAuthRun(C);
      let e = null; try { await ledger.recordCharge(resInput(R.itemRunId, 'one')); } catch (x) { e = x; }
      assert(e && e.code === 'RUN_BUDGET_NOT_AUTHORIZED' && e.details.runId === R.runId && /presupuesto autorizado/.test(e.message), 'una: ' + (e && e.message));
      e = null; try { await ledger.recordReservationBatch([resInput(R.itemRunId, 'b1'), resInput(R.itemRunId, 'b2')]); } catch (x) { e = x; }
      assert(e && e.code === 'RUN_BUDGET_NOT_AUTHORIZED', 'lote: ' + (e && e.message));
      eq(await eventsOf(R.runId), 0, 'ninguna reserva pagada');
      const mock = await ledger.recordCharge(resInput(R.itemRunId, 'mock', { billingAccount: 'mock', mode: 'mock', costSource: 'MOCK' }));
      const byok = await ledger.recordCharge(resInput(R.itemRunId, 'byok', { billingAccount: 'user_key' }));
      const zero = await ledger.recordCharge(resInput(R.itemRunId, 'zero', { usage: { input_tokens: 0, output_tokens: 0 } }));
      assert(mock.inserted && byok.inserted && zero.inserted && Number(zero.event.amount) === 0, 'mock / BYOK / 0 entran');
      const h = WH.reservePaidCall(ledger, { kind: 'llm', ownerId: OWNER, itemRunId: R.itemRunId, generation: 201, itemAttempt: 1, tag: 'h', estimate: { promptChars: 30000, maxTokens: 12000, model: 'claude-sonnet-4-6' } });
      e = null; try { await h; } catch (x) { e = x; }
      assert(e instanceof WH.RunBudgetCapReached && !(e instanceof WH.LedgerWriteFailed) && e.reason === 'run_budget_not_authorized' && e.runId === R.runId
        && /^run_budget_not_authorized:/.test(e.message), 'reservePaidCall → RunBudgetCapReached(run_budget_not_authorized): ' + (e && e.message));
      assert(await WH.pauseRunForCap(budget, e), 'pauseRunForCap pausa');
      eq([(await runRow(R.runId)).p.reason], ['run_budget_not_authorized'], 'motivo de la pausa');
    });

    await check('[H4] con autorización válida → reservas dentro del tope entran; BLOCKED posterior → rechazo (RUN_BUDGET_CAP, tope 0)', async () => {
      const C = await makeCourse('H4 válida');
      const R = await noAuthRun(C);
      await authorize(R.runId, C.cid, String(2 * ONE + 0.01));
      assert((await ledger.recordCharge(resInput(R.itemRunId, 'v1'))).inserted && (await ledger.recordCharge(resInput(R.itemRunId, 'v2'))).inserted, 'dos entran');
      let e = null; try { await ledger.recordCharge(resInput(R.itemRunId, 'v3')); } catch (x) { e = x; }
      assert(e && e.code === 'RUN_BUDGET_CAP', 'la tercera excede el tope');
      await authorize(R.runId, C.cid, '100', 'BLOCKED');
      e = null; try { await ledger.recordCharge(resInput(R.itemRunId, 'v4', { usage: LUI.llmCallUpperBoundUsage(100, 10) })); } catch (x) { e = x; }
      assert(e && e.code === 'RUN_BUDGET_CAP' && e.details.authorizedBudget === '0', 'BLOCKED = tope 0');
      const g = await budget.guardServerLlmCall({ runId: R.runId, itemRunId: R.itemRunId, model: 'claude-sonnet-4-6', promptChars: 100, maxTokens: 10 });
      assert(g && g.code === 'run_paused' && g.paused === true, 'guard con BLOCKED → run_paused + pausa: ' + JSON.stringify(g));
    });

    await check('[H4] worker de IA REAL (createServerApi) en run sin autorización → 0 pedidos a Anthropic, 0 reservas, run pausado (run_budget_not_authorized); con el guard «engañado» el ledger igual lo impide', async () => {
      const C = await makeCourse('H4 worker');
      const R = await noAuthRun(C);
      const fake = await fakeAnthropic(50);
      try {
        const item = { itemRunId: R.itemRunId, runId: R.runId, itemKey: 'content:x', attempt: 1, generation: 201, ownerId: OWNER, artifactCourseId: String(C.cid), manifestId: 1 };
        const mk = (b) => createServerApi({
          dataSource: ds, finops: ledger, budget: b,
          checkpoints: { put: async () => {}, get: async () => null }, recordCheckpoint: async () => true,
          apiKey: 'fake-anthropic-never-real', baseUrl: fake.url, defaultModel: 'claude-sonnet-4-6', idleMs: 5000, totalMs: 20000,
          logger: { log() {}, warn() {}, error() {} }, settleRetryDelaysMs: [0, 0],
        }, item, () => ({ callRole: 'main', attempt: 1 }));
        let e = null; try { await mk(budget)('s', 'hola', 1000); } catch (x) { e = x; }
        assert(e && e.runPaused && e.code === 'run_budget_not_authorized' && /^run_budget_not_authorized:/.test(e.msg), 'guard real: ' + JSON.stringify(e));
        const row = await runRow(R.runId);
        eq([row.worker_status, row.p && row.p.reason], ['paused', 'run_budget_not_authorized'], 'run pausado');
        await ds.query(`update public.production_jobs set status = 'running', worker_status = 'running' where id = $1`, [R.runId]);
        e = null; try { await mk({ guardServerLlmCall: async () => null, pauseRunBySystem: (...a) => budget.pauseRunBySystem(...a) })('s', 'hola', 1000); } catch (x) { e = x; }
        assert(e && e.runPaused && e.code === 'run_budget_not_authorized', 'guard engañado → el ledger rechaza: ' + JSON.stringify(e));
        eq([fake.st.requests, await eventsOf(R.runId), (await runRow(R.runId)).worker_status], [0, 0, 'paused'], 'pedidos a Anthropic / reservas / estado');
      } finally { await fake.close(); }
    });

    await check('[H4] proxy LLM del navegador (guard + controller reales) en run sin autorización → 409 run_budget_not_authorized sin reservar; mock y BYOK sin cambio', async () => {
      const C = await makeCourse('H4 proxy');
      const R = await noAuthRun(C);
      const ctrl = new FinopsLlmReservationController(ledger, budget);
      const body = (extra) => ({ callId: crypto.randomUUID(), subject: OWNER, itemRunId: R.itemRunId, model: 'claude-sonnet-4-6', promptChars: 3000, maxTokens: 1000,
        billingAccount: 'cursia', callRole: 'main', attempt: 1, mode: 'real', ...extra });
      let e = null; try { await ctrl.llmReservation(body()); } catch (x) { e = x; }
      const b = e && e.getResponse ? e.getResponse() : null;
      assert(e && e.getStatus() === 409 && b.code === 'run_budget_not_authorized' && b.runId === R.runId && b.paused === true, 'proxy: ' + JSON.stringify(b || (e && e.message)));
      eq(await eventsOf(R.runId), 0, 'ninguna reserva');
      // Un run pausado ya no admite llamadas pagadas; mock / BYOK no pasan por el guard del run.
      const mock = await ctrl.llmReservation(body({ mode: 'mock' }));
      const byok = await ctrl.llmReservation(body({ billingAccount: 'user_key' }));
      assert(mock.reserved && byok.reserved, 'mock y BYOK reservan');
      // Carrera (guard que deja pasar): el ledger rechaza igual → 409 run_budget_not_authorized.
      await ds.query(`update public.production_jobs set status = 'running', worker_status = 'running' where id = $1`, [R.runId]);
      const ctrl2 = new FinopsLlmReservationController(ledger, { guardLlmProxyCall: async () => null, pauseRunBySystem: (...a) => budget.pauseRunBySystem(...a) });
      e = null; try { await ctrl2.llmReservation(body()); } catch (x) { e = x; }
      const b2 = e && e.getResponse ? e.getResponse() : null;
      assert(e && e.getStatus() === 409 && b2.code === 'run_budget_not_authorized' && b2.paused === true, 'carrera: ' + JSON.stringify(b2 || (e && e.message)));
      eq((await ds.query(`select count(*)::int n from public.generation_cost_events where run_id = $1 and billing_account = 'cursia'`, [R.runId]))[0].n, 0, 'ninguna reserva de Cursia');
    });

    await check('[H4] reanudar un run pausado sin autorización → 409 run_budget_not_authorized (no se reabre); tras la autorización del admin → se reanuda y la llamada entra', async () => {
      const C = await makeCourse('H4 reanudar');
      const R = await noAuthRun(C, 'paused');
      // Review r1 (M-3): el bloqueo aplica porque al run le queda un proveedor pagado real (el video, modo real).
      const vRows = await ds.query(`update public.generation_item_runs set status = 'pending', finished_at = null where job_id = $1 and type = 'video' returning id`, [R.runId]);
      assert(vRows.length > 0, 'el run tiene un video real pendiente');
      await ds.query(`update public.production_jobs set output_summary = jsonb_build_object('pause', jsonb_build_object('pausedAt', now(), 'reason', 'run_budget_not_authorized')) where id = $1`, [R.runId]);
      let e = null; try { await runs.resumeRun(C.cid, OWNER, 1, R.runId); } catch (x) { e = x; }
      const b = e && e.getResponse ? e.getResponse() : null;
      assert(b && b.code === 'run_budget_not_authorized' && /autoriz/.test(b.message), 'resume: ' + JSON.stringify(b || (e && e.message)));
      eq((await runRow(R.runId)).worker_status, 'paused', 'sigue pausado');
      await budget.adminAuthorizeRun({ courseId: C.cid, runId: R.runId, authorizedBudget: '5', approvedBy: 'admin@cursia.test', reason: 'check H4' });
      await runs.resumeRun(C.cid, OWNER, 1, R.runId);
      assert((await runRow(R.runId)).worker_status !== 'paused', 'reanudado');
      eq(await budget.guardServerLlmCall({ runId: R.runId, itemRunId: R.itemRunId, model: 'claude-sonnet-4-6', promptChars: 3000, maxTokens: 1000 }), null, 'guard permite');
      assert((await ledger.recordCharge(resInput(R.itemRunId, 'after'))).inserted, 'reserva entra');
    });

    await check('[H4] review r1 (M-3): run pausado sin autorización al que solo le quedan partes de IA / ya generadas (ningún proveedor pagado real pendiente) → se reanuda; el ledger igual rechaza la reserva LLM pagada por Cursia', async () => {
      const C = await makeCourse('H4 reanudar sin pagados');
      const R = await noAuthRun(C, 'paused');
      await ds.query(`update public.production_jobs set output_summary = jsonb_build_object('pause', jsonb_build_object('pausedAt', now(), 'reason', 'user')) where id = $1`, [R.runId]);
      // Los items de proveedores pagados (video / presentación / audio) ya están generados; quedan partes de IA.
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and type = any($2::text[])`,
        [R.runId, ['video', 'presentation', 'audio_welcome', 'audiobook_chapter']]);
      await runs.resumeRun(C.cid, OWNER, 1, R.runId);
      assert((await runRow(R.runId)).worker_status !== 'paused', 'reanudado sin autorización (nada pagado real pendiente)');
      let e = null; try { await ledger.recordCharge(resInput(R.itemRunId, 'llm-after-resume')); } catch (x) { e = x; }
      assert(e && e.code === 'RUN_BUDGET_NOT_AUTHORIZED', 'la reserva LLM pagada por Cursia sigue fallando cerrado: ' + (e && e.message));
    });

    await check('[H4] clasificación: run_budget_not_authorized → clase D, hold_for_human, presupuesto (approve_budget); también como código explícito', async () => {
      const FC = L('modules/reliability/failure-classifier.js');
      const v = FC.classifyFailure({ error: 'run_budget_not_authorized: el run x no tiene un presupuesto autorizado' });
      const v2 = FC.classifyFailure({ error: 'algo', errorCode: 'run_budget_not_authorized' });
      for (const x of [v, v2]) assert(x.class === 'D' && x.code === 'run_budget_not_authorized' && x.strategy === 'hold_for_human', 'veredicto: ' + JSON.stringify(x));
      assert(FC.isFailureCodeClassified('run_budget_not_authorized'), 'código clasificado');
    });

    await check('[AT] precio faltante (modelo sin fila en el catálogo): la reserva NUNCA vale 0 — monto conservador (tarifa más cara) y cuenta para el tope', async () => {
      const C = await makeCourse('AT sin precio');
      const it = await itemOf(C.runId);
      await authorize(C.runId, C.cid, '10');
      const r = await ledger.recordCharge(resInput(it.id, 'u', { modelOrProduct: 'claude-modelo-inexistente' }));
      assert(r.inserted && Number(r.event.amount) > 0 && r.event.metadata.amountBasis === 'conservative_catalog_max' && r.pricingMissing, 'conservador: ' + JSON.stringify({ a: r.event.amount, m: r.event.metadata }));
    });

    await check('[AT] unidad (lote): TODAS o NINGUNA — con lugar para 2, un lote de 3 no inserta nada (RUN_BUDGET_CAP) y uno de 2 entra; 12 lotes de 2 en paralelo desde 3 procesos → nunca se supera el tope y ningún lote queda a medias', async () => {
      const C = await makeCourse('AT lote');
      const it = await itemOf(C.runId);
      await authorize(C.runId, C.cid, String(2 * ONE + 0.01));
      let e = null;
      try { await ledger.recordReservationBatch(['a', 'b', 'c'].map((t) => resInput(it.id, 'u3-' + t))); } catch (x) { e = x; }
      assert(e && e.code === 'RUN_BUDGET_CAP', 'lote de 3 rechazado');
      eq(await runTotal(C.runId), 0, 'nada insertado');
      const ok2 = await ledger.recordReservationBatch(['a', 'b'].map((t) => resInput(it.id, 'u2-' + t)));
      eq(ok2.map((r) => r.inserted), [true, true], 'lote de 2');
      const again = await ledger.recordReservationBatch(['a', 'b'].map((t) => resInput(it.id, 'u2-' + t)));
      eq(again.map((r) => r.inserted), [false, false], 'reintento del lote: idempotente sin volver a contar');
      const D = await makeCourse('AT lotes paralelos');
      const it2 = await itemOf(D.runId);
      await authorize(D.runId, D.cid, String(5 * ONE + 0.01));
      const res = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => ledgers[i % 3].recordReservationBatch(['x', 'y'].map((t) => resInput(it2.id, `p${i}-${t}`)))));
      const okB = res.filter((r) => r.status === 'fulfilled').length;
      eq([okB, res.filter((r) => r.status === 'rejected' && r.reason.code === 'RUN_BUDGET_CAP').length], [2, 10], '2 lotes entran (4 reservas ≤ 5 lugares), el resto RUN_BUDGET_CAP');
      const n = (await ds.query(`select count(*)::int n from public.generation_cost_events where run_id = $1`, [D.runId]))[0].n;
      eq(n, 4, 'ningún lote a medias (4 filas = 2 lotes completos)');
      assert((await runTotal(D.runId)) <= 5 * ONE + 0.01 + 1e-9, 'total ≤ tope');
    });

    await check('[AT] red de seguridad (review M3): un cargo REAL mayor que su reserva que deja el run sobre el tope → el run se PAUSA al liquidar (run_budget_cap, overshoot); bajo el tope no pausa', async () => {
      const C = await makeCourse('AT overshoot');
      const it = await itemOf(C.runId);
      // Tope: una reserva + 0,03 (tras liquidar la 1.ª con su cargo real de 0,018, la 2.ª reserva cabe).
      await authorize(C.runId, C.cid, String(ONE + 0.03));
      const settle = (tag, out) => ledger.settleReservation(`reservation:test:${it.id}:${tag}`, {
        itemRunId: it.id, ownerIdFromAuth: OWNER, provider: 'anthropic', service: 'messages', modelOrProduct: 'claude-sonnet-4-6',
        usage: { input_tokens: 1000, output_tokens: out }, usageUnit: 'output_tokens', externalOperationId: 'msg_' + tag, idempotency: { kind: 'anthropic', parts: { messageId: 'msg_' + tag } },
        callRole: 'main', attempt: 1, billingAccount: 'cursia', mode: 'real', costSource: 'CALCULATED_FROM_USAGE', recordedBy: 'check',
      }, 'test_settled');
      await ledger.recordCharge(resInput(it.id, 'o1'));
      await settle('o1', 1000);
      eq((await ds.query(`select worker_status from public.production_jobs where id = $1`, [C.runId]))[0].worker_status !== 'paused', true, 'bajo el tope: sin pausa');
      await ledger.recordCharge(resInput(it.id, 'o2'));
      await settle('o2', 20000); // salida real mayor que el tope de la reserva (12.000): solo posible con un proveedor que no respeta max_tokens
      const run = (await ds.query(`select worker_status, output_summary->'pause' p from public.production_jobs where id = $1`, [C.runId]))[0];
      eq([run.worker_status, run.p.reason, run.p.overshoot], ['paused', 'run_budget_cap', true], 'pausado por overshoot');
      assert(Number(run.p.requiredUsd) > ONE + 0.03, 'requiredUsd = gastado real: ' + run.p.requiredUsd);
    });

    await check('[WK] worker de IA REAL (createServerApi) — 8 llamadas EN PARALELO con el guard real y un tope para 3 → exactamente 3 llegan a Anthropic; las otras 5 → run_paused SIN llamar; run pausado (run_budget_cap); el total nunca supera el tope', async () => {
      const C = await makeCourse('WK paralelo');
      const it = await itemOf(C.runId);
      const promptChars = 30000;
      const cap = 3 * ONE + 0.05;
      await authorize(C.runId, C.cid, String(cap));
      const fake = await fakeAnthropic(300);
      try {
        const item = { itemRunId: it.id, runId: C.runId, itemKey: 'content:x', attempt: 1, generation: 1, ownerId: OWNER, artifactCourseId: String(C.cid), manifestId: 1 };
        const api = createServerApi({
          dataSource: ds, finops: ledger, budget,
          checkpoints: { put: async () => {}, get: async () => null }, recordCheckpoint: async () => true,
          apiKey: 'fake-anthropic-never-real', baseUrl: fake.url, defaultModel: 'claude-sonnet-4-6', idleMs: 5000, totalMs: 20000,
          logger: { log() {}, warn() {}, error() {} }, settleRetryDelaysMs: [0, 0],
        }, item, () => ({ callRole: 'main', attempt: 1 }));
        const prompt = 'x'.repeat(promptChars - 200);
        const out = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => api('s', prompt + ' #' + i, 12000)));
        const ok = out.filter((r) => r.status === 'fulfilled');
        const paused = out.filter((r) => r.status === 'rejected' && r.reason && r.reason.runPaused);
        eq([ok.length, paused.length, fake.st.requests], [3, 5, 3], 'llamadas hechas / devueltas / pedidos a Anthropic');
        const row = (await ds.query(`select worker_status, output_summary->'pause' p from public.production_jobs where id = $1`, [C.runId]))[0];
        eq([row.worker_status, row.p && row.p.reason], ['paused', 'run_budget_cap'], 'run pausado por el tope');
        const peak = Number((await ds.query(`select coalesce(sum(amount) filter (where (metadata->>'reservation') = 'true' and event_kind = 'CHARGE'),0)::text t from public.generation_cost_events where run_id = $1`, [C.runId]))[0].t);
        assert(peak <= cap + 1e-9, `las reservas nunca superaron el tope (${peak} ≤ ${cap})`);
        assert((await runTotal(C.runId)) <= cap + 1e-9, 'total ≤ tope');
      } finally { await fake.close(); }
    });

    await check('[WK] guard «engañado» (permite TODO, como dos chequeos que leen el mismo total antes de reservar): el ledger igual impide el exceso — las llamadas de más se devuelven sin llamar y el run se pausa', async () => {
      const C = await makeCourse('WK guard engañado');
      const it = await itemOf(C.runId);
      const cap = 2 * ONE + 0.01;
      await authorize(C.runId, C.cid, String(cap));
      const fake = await fakeAnthropic(200);
      try {
        const item = { itemRunId: it.id, runId: C.runId, itemKey: 'content:x', attempt: 1, generation: 1, ownerId: OWNER, artifactCourseId: String(C.cid), manifestId: 1 };
        const api = createServerApi({
          dataSource: ds, finops: ledger, budget: { guardServerLlmCall: async () => null, pauseRunBySystem: (...a) => budget.pauseRunBySystem(...a) },
          checkpoints: { put: async () => {}, get: async () => null }, recordCheckpoint: async () => true,
          apiKey: 'fake-anthropic-never-real', baseUrl: fake.url, defaultModel: 'claude-sonnet-4-6', idleMs: 5000, totalMs: 20000,
          logger: { log() {}, warn() {}, error() {} }, settleRetryDelaysMs: [0, 0],
        }, item, () => ({ callRole: 'main', attempt: 1 }));
        const out = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => api('s', 'y'.repeat(29800) + ' #' + i, 12000)));
        eq([out.filter((r) => r.status === 'fulfilled').length, fake.st.requests], [2, 2], 'solo 2 llegan a Anthropic');
        assert(out.filter((r) => r.status === 'rejected').every((r) => r.reason.runPaused && /presupuesto autorizado/.test(r.reason.msg)), 'el resto: run_paused');
        eq((await ds.query(`select worker_status from public.production_jobs where id = $1`, [C.runId]))[0].worker_status, 'paused', 'run pausado');
      } finally { await fake.close(); }
    });

    await check('[WK] reservePaidCall: el rechazo por el tope es RunBudgetCapReached (no un fallo de ledger) y pauseRunForCap pausa el run con lo que hacía falta', async () => {
      const C = await makeCourse('WK hooks');
      const it = await itemOf(C.runId);
      await authorize(C.runId, C.cid, '0.10');
      let e = null;
      try { await WH.reservePaidCall(ledger, { kind: 'llm', ownerId: OWNER, itemRunId: it.id, generation: 1, itemAttempt: 1, tag: 't', estimate: { promptChars: 30000, maxTokens: 12000, model: 'claude-sonnet-4-6' } }); } catch (x) { e = x; }
      assert(e instanceof WH.RunBudgetCapReached && !(e instanceof WH.LedgerWriteFailed) && e.runId === C.runId && e.requiredUsd > 0.1, 'tipo: ' + (e && e.name));
      assert(await WH.pauseRunForCap(budget, e), 'pausó');
      const p = (await ds.query(`select output_summary->'pause' p from public.production_jobs where id = $1`, [C.runId]))[0].p;
      assert(p.reason === 'run_budget_cap' && Number(p.requiredUsd) > 0.1, 'pausa: ' + JSON.stringify(p));
    });

    await check('[WK] proxy LLM del navegador: guard que deja pasar + reserva rechazada por el tope → 409 run_paused (el proxy no llama) y el run queda pausado', async () => {
      const C = await makeCourse('WK proxy');
      const it = await itemOf(C.runId);
      await authorize(C.runId, C.cid, '0.10');
      const ctrl = new FinopsLlmReservationController(ledger, { guardLlmProxyCall: async () => null, pauseRunBySystem: (...a) => budget.pauseRunBySystem(...a) });
      let e = null;
      try {
        await ctrl.llmReservation({ callId: crypto.randomUUID(), subject: OWNER, itemRunId: it.id, model: 'claude-sonnet-4-6', promptChars: 30000, maxTokens: 12000,
          billingAccount: 'cursia', callRole: 'main', attempt: 1, mode: 'real' });
      } catch (x) { e = x; }
      const body = e && e.getResponse ? e.getResponse() : null;
      assert(e && e.getStatus() === 409 && body.code === 'run_paused' && body.paused === true, 'proxy: ' + JSON.stringify(body || (e && e.message)));
      eq((await ds.query(`select worker_status from public.production_jobs where id = $1`, [C.runId]))[0].worker_status, 'paused', 'run pausado');
    });

    for (const d of extraDs) await d.destroy().catch(() => {});
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
  await dbChecks();
  console.log(`\n${passes} OK, ${failures} fallidos`);
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(`❌ fatal: ${err && err.stack ? err.stack : err}`); process.exit(1); });
