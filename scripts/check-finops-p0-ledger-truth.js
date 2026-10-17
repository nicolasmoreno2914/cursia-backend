#!/usr/bin/env node
/* eslint-disable */
// FinOps P0 (2026-10-16) — el ledger V2 (generation_cost_events) → CostReadService → API → Dashboard es la ÚNICA cadena
// de verdad del dinero. USD 0: PG16 desechable armado con las migraciones del repo, sin red, sin proveedores.
//
//   [ST] estático: ningún camino de dinero lee usage_events (lectores sin columnas de costo de la tabla antigua)
//   [EV] POST /events: los montos que manda el navegador nunca se guardan como costo (quedan como dato no confiable)
//   [PU] puro: «sin datos» (null) ≠ USD 0 ("0.0000000000")
//   [L1] fixture tipo #1353: comprometido EXACTO "51.9236310500" (= neto del ledger), real "51.8713810500",
//        reservado "0.0522500000"; real + reservado = comprometido; desglose por run; BYOK fuera; estimado aparte
//   [L2] el resumen del dashboard y /courses/:id/cost coinciden para el mismo curso
//   [L3] período UTC por FECHA EFECTIVA: una reserva del día 13 y su liquidación del 14 no dejan un neto negativo
//   [L4] filas antiguas de usage_events con costos inventados no cambian NINGUNA cifra de dinero
//   [AT] un ejecutor que no es el dueño del run no puede saltarse el tope ni el guard (proxy + ledger); un worker
//        del servidor conserva course_id/run_id y el tope aplica
//   [UP] cargo final SIN precio (review r1 I1): la reserva se liquida a 0 como siempre (nunca queda abierta), el cargo
//        a 0 pendiente se lista como «sin precio», `completeness: 'partial'`, real NO inflado, ningún lector cuenta doble;
//        al re-preciar entra el precio real y vuelve a 'complete'. TTS sin medir (m1) también es «sin precio»
//   [PC] promedio/mín./máx. por curso solo con gasto de Cursia > 0 (review r1 m3): cursos solo BYOK / mock / 0 fuera
//   [DC] llamadas directas (extracción, /tts/speech): al curso del dueño o sin atribuir con motivo explícito
//
// Usage: npm run build && node scripts/check-finops-p0-ledger-truth.js [--pure-only]
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PURE_ONLY = process.argv.includes('--pure-only');
const REPO = path.resolve(__dirname, '..');
const distRoot = path.join(REPO, 'dist');
const L = (rel) => { try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar dist/${rel} (¿npm run build?): ${err.message}`); process.exit(1); } };
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (s.startsWith('data:') || /^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const { applyFakeProviderEnv } = require('./lib/provider-test-env');

let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
async function rejectsCode(p, code, m) { let e = null; try { await p; } catch (x) { e = x; } assert(e, `${m}: no lanzó`); const c = e.code || (e.getResponse && e.getResponse() && e.getResponse().code); assert(c === code, `${m}: código ${c} (esperado ${code}) — ${e.message}`); return e; }

// ─── [ST] estático ──────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out); else if (f.name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const LEGACY_COST_TOKENS = /\b(estimated_cost_usd|real_cost_usd|cost_type|estimatedCostUsd|realCostUsd|costType|unit_price_usd|unitPriceUsd)\b/;
// Escritores / infraestructura de la tabla antigua (telemetría): pueden nombrarla. Ninguno es un lector de dinero.
const USAGE_EVENTS_ALLOWED = new Set([
  'src/events/events.service.ts', 'src/events/events.controller.ts', 'src/events/events.module.ts', 'src/events/dto/create-event.dto.ts',
  'src/events/entities/usage-event.entity.ts', 'src/database/database.module.ts', 'src/admin/admin.module.ts',
  'src/workers/h5p-worker.ts', 'src/workers/full-course-worker.ts', 'src/workers/gamma-worker.ts', 'src/workers/package-worker.ts',
  'src/workers/video-worker.ts', 'src/workers/content-worker.ts', 'src/workers/audio-worker.ts',
  // Solo conteos de ACTIVIDAD (event_type / failed / created_at); el test de abajo prueba que no nombra columnas de costo.
  'src/admin/services/admin-dashboard.service.ts',
]);
const MONEY_READERS = ['src/admin/services/admin-dashboard.service.ts', 'src/admin/controllers/admin-dashboard.controller.ts',
  'src/modules/courses/courses.service.ts', 'src/modules/courses/courses.controller.ts', 'src/modules/finops/cost-read.service.ts',
  'src/modules/finops/finops-ledger.service.ts', 'src/modules/dynamic-generation/item-recovery-view.ts'];

async function pureChecks() {
  await check('[ST] estático: ningún archivo fuera de los escritores/infra nombra usage_events / UsageEvent; los lectores de dinero no nombran columnas de costo de la tabla antigua ni la tabla', () => {
    const files = walk(path.join(REPO, 'src')).map((p) => path.relative(REPO, p).split(path.sep).join('/'));
    const code = (f) => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const offenders = files.filter((f) => /usage_events|\bUsageEvent\b/.test(code(f)) && !USAGE_EVENTS_ALLOWED.has(f));
    eq(offenders, [], 'archivos que leen usage_events sin estar permitidos');
    for (const f of MONEY_READERS) {
      const src = code(f);
      assert(!LEGACY_COST_TOKENS.test(src), `${f} nombra una columna de costo de usage_events: ${(src.match(LEGACY_COST_TOKENS) || [])[0]}`);
      if (f !== 'src/admin/services/admin-dashboard.service.ts') assert(!/usage_events|\bUsageEvent\b/.test(src), `${f} lee usage_events`);
    }
    const dash = fs.readFileSync(path.join(REPO, 'src/admin/services/admin-dashboard.service.ts'), 'utf8');
    assert(/CostReadService/.test(dash) && !/TraditionalCostBenchmark|savings|traditional/i.test(dash.replace(/\/\*[\s\S]*?\*\//g, '')), 'el dashboard usa CostReadService y no calcula «ahorro»');
    const courses = fs.readFileSync(path.join(REPO, 'src/modules/courses/courses.service.ts'), 'utf8');
    assert(/adminDashboardService\.getCourseCost\(id\)/.test(courses), '/courses/:id/cost delega en el costo del ledger (id entero)');
  });

  await check('[EV] POST /events: real_cost_usd / cost_type=real del navegador NO se guardan como costo (null; dato declarado no confiable en metadata)', async () => {
    const { EventsService } = L('events/events.service.js');
    const saved = [];
    const repo = { create: (x) => x, save: async (x) => { saved.push(x); return { id: 'e1' }; } };
    const rates = { resolveCostEstimate: async () => ({ costUsd: null, unitPriceUsd: null, unitType: null, source: null }) };
    const svc = new EventsService(repo, rates);
    const r = await svc.create({ event_type: 'course_production_completed', course_id: '1353', cost_type: 'real', real_cost_usd: 999.99, cost_source: 'provider_reported' }, { id: 'u1', email: 'x@y' });
    eq(r.ok, true, 'el evento se registra (telemetría)');
    const e = saved[0];
    eq([e.realCostUsd, e.costType === 'real', e.costSource === 'provider_reported'], [null, false, false], 'sin costo del cliente');
    eq([e.metadata.costUntrusted, e.metadata.clientDeclaredCost.real_cost_usd, e.metadata.clientDeclaredCost.cost_type], [true, 999.99, 'real'], 'dato declarado, marcado no confiable');
  });

  await check('[PU] puro: sin eventos → status no_data y montos null; eventos que suman 0 → "0.0000000000" con status ok', () => {
    const CR = L('modules/finops/cost-read.service.js');
    const none = CR.summaryFromAggregates({ events: 0 });
    eq([none.status, none.actual, none.reserved, none.committed, none.byok.actual], ['no_data', null, null, null, null], 'sin datos');
    const zero = CR.summaryFromAggregates({ events: 2, actual: '0', reserved: '0', committed: '0.0000000000' });
    eq([zero.status, zero.actual, zero.reserved, zero.committed], ['ok', '0.0000000000', '0.0000000000', '0.0000000000'], 'cero real');
    eq(CR.emptySummary('unavailable').status, 'unavailable', 'sin ledger en la base');
    // Review r1: completeness — 'partial' si hay llamadas sin precio; null sin ledger.
    eq([none.completeness, zero.completeness, CR.summaryFromAggregates({ events: 3, unpriced: 2 }).completeness, CR.emptySummary('unavailable').completeness],
      ['complete', 'complete', 'partial', null], 'completeness');
  });

  await check('[DC] puro: llamada directa a Anthropic / TTS → input del ledger con atribución al curso o motivo explícito; TTS con segundos medidos = final, sin medir = pendiente', () => {
    const DC = L('modules/finops/direct-call-ledger.js');
    const a = DC.directAnthropicChargeInput({ ownerId: 'o', model: 'claude-opus-4-8', messageId: 'msg_1', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null }, operation: 'llm.brand_extraction', recordedBy: 'b', unattributedReason: 'brand_extraction' });
    eq([a.provider, a.operation, a.attributionCourseId, a.unattributedReason, a.usage.cache_write_tokens, a.billingAccount, a.pricingFallback], ['anthropic', 'llm.brand_extraction', null, 'brand_extraction', 0, 'cursia', 'pending_zero'], 'anthropic');
    eq(DC.directAnthropicChargeInput({ ownerId: null, model: 'm', messageId: 'x', usage: {}, operation: 'o', recordedBy: 'r', unattributedReason: 'u' }), null, 'sin owner no se inventa');
    const t = DC.directTtsChargeInput({ ownerId: 'o', model: 'gpt-4o-mini-tts', requestId: 'req_1', audioSeconds: 12.3456, characters: 200, courseId: 7, unattributedReason: 'legacy_tts_no_course', recordedBy: 'tts', localCallId: 'l1' });
    eq([t.idempotencyKey, t.measurementStatus, t.usage.audio_seconds, t.attributionCourseId], ['openai:req:req_1', 'final', '12.346', 7], 'tts medido');
    const t2 = DC.directTtsChargeInput({ ownerId: 'o', model: 'gpt-4o-mini-tts', requestId: null, audioSeconds: null, characters: 200, unattributedReason: 'legacy_tts_no_course', recordedBy: 'tts', localCallId: 'l2' });
    eq([t2.idempotencyKey, t2.measurementStatus, JSON.stringify(t2.usage), t2.metadata.pendingReason], ['openai:tts-speech:l2', 'pending', '{}', 'tts_audio_not_measurable'], 'tts sin medir');
    eq([t.unmeasuredUsage, t2.unmeasuredUsage], [false, true], 'tts sin medir → marcado como sin precio (review r1 m1)');
  });
}

// ─── DB ─────────────────────────────────────────────────────────────────────
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
const CONTEXT = { nombre: 'Curso FinOps P0', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION', 'DYNAMIC_VIDEO_DELIVERY',
  'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY', 'SUPER_ADMIN_EMAILS', 'DYNAMIC_AUTO_HEAL_POLICY'];

async function dbChecks() {
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
  const DC = L('modules/finops/direct-call-ledger.js');
  const { AdminDashboardService } = L('admin/services/admin-dashboard.service.js');
  const { CoursesService } = L('modules/courses/courses.service.js');
  const { FinopsLlmReservationController } = L('modules/finops/finops.controller.js');
  const LUI = L('modules/finops/llm-usage-ingest.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-finopsp0-db16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-finopsp0-cwd-'));
  const ROLE = 'postgres.finopsp0local01';
  const DB = 'finopsp0db';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const restoreProviders = applyFakeProviderEnv();
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1 -c timezone=America/Bogota`, 'start']);
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
      DYNAMIC_PROVIDER_WORKER_ENABLED: 'true', VIDEOGEN_API_KEY: 'fake-videogen-key-never-used-no-network', SUPER_ADMIN_EMAILS: 'admin@cursia.test' });
    for (const k of ['DYNAMIC_V2_ALLOWED_OWNERS', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_AUTO_HEAL_POLICY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT']) delete process.env[k];
    AL.resetRelSchemaCache(); EL.resetExecLeaseSchemaCache();
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 6 } });
    await ds.initialize();
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const costRead = new CR.CostReadService(ds);
    const dash = new AdminDashboardService(ds, costRead);

    // ── Fixture #1353 (eventos directos con la forma real del ledger) ─────────────────────────────────────────
    const CID = 1353;
    await ds.query(`insert into public.courses (id, owner_id, title, status, structure_version, metadata) values ($1, $2, 'Curso piloto #1353', 'published', 'dynamic', '{"courseId":"fe-1353"}'::jsonb)`, [CID, OWNER]);
    const job = async (createdAt) => (await ds.query(
      `insert into public.production_jobs (owner_id, course_id, status, worker_status, execution_mode, input_payload, created_at) values ($1, $2, 'completed', 'completed', 'dynamic_generation', '{}'::jsonb, $3) returning id`,
      [OWNER, CID, createdAt]))[0].id;
    const RUN_B = await job('2026-10-11T09:00:00Z'); // run anterior (cancelado), más viejo
    const RUN_A = await job('2026-10-13T20:00:00Z'); // run vigente (d7155541 en staging)
    const T = (s) => `2026-10-14T${s}Z`;
    let seq = 0;
    const ev = async (o) => {
      seq++;
      const kind = o.kind || 'CHARGE';
      const account = o.account || 'cursia';
      const source = o.source || (account === 'mock' ? 'MOCK' : 'CALCULATED_FROM_USAGE');
      const [row] = await ds.query(
        `insert into public.generation_cost_events (event_kind, corrects_event_id, owner_id, course_id, run_id, item_key, item_type, operation, call_role, attempt, provider,
            idempotency_key, amount, cost_source, measurement_status, billing_account, billable, outcome, recorded_by, metadata, usage, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'check-finops-p0',$19::jsonb,$20::jsonb,$21) returning id, idempotency_key`,
        [kind, o.corrects || null, o.owner || OWNER, o.course === undefined ? CID : o.course, o.run === undefined ? RUN_A : o.run, o.itemKey || null, o.itemType || null,
          o.operation || 'llm.content', o.role || 'main', o.attempt || 1, o.provider || 'anthropic', o.key || `p0:${seq}:${crypto.randomUUID()}`, o.amount, source,
          o.status || 'final', account, account === 'cursia' && source !== 'MOCK', o.outcome || 'succeeded', JSON.stringify(o.meta || {}), JSON.stringify(o.usage || {}), o.at || T('10:00:00')]);
      return row;
    };
    const adj = (parent, amount, at, meta, extra = {}) => ev({ kind: 'ADJUSTMENT', corrects: parent.id, amount, at, meta: { reason: 'check', ...(meta || {}) }, ...extra });
    // 1. reserva liquidada (13/10 23:59) + cargo final (14/10 00:01) — cruza el borde del día
    const r1 = await ev({ amount: '0.2250000000', status: 'pending', meta: { reservation: true }, at: '2026-10-13T23:59:00Z', itemKey: 'content:c1', itemType: 'content' });
    await ev({ amount: '0.0330000000', at: T('00:01:00'), itemKey: 'content:c1', itemType: 'content', usage: { input_tokens: 9000, output_tokens: 1200 } });
    await adj(r1, '-0.2250000000', T('00:01:00'), { reservationSettled: true, supersededBy: 'anthropic:msg:x', settlement: 'measured_differs' }, { itemKey: 'content:c1', itemType: 'content', status: 'final' });
    // 2. reintento (validation_retry, attempt 2): reserva + final — UNA llamada de reintento
    const r2 = await ev({ amount: '0.2250000000', status: 'pending', meta: { reservation: true }, role: 'validation_retry', attempt: 2, itemKey: 'content:c1', itemType: 'content' });
    await ev({ amount: '0.0410000000', role: 'validation_retry', attempt: 2, itemKey: 'content:c1', itemType: 'content', usage: { input_tokens: 9100, output_tokens: 1500 } });
    await adj(r2, '-0.2250000000', T('10:00:01'), { reservationSettled: true, supersededBy: 'anthropic:msg:y' }, { role: 'validation_retry', attempt: 2, itemKey: 'content:c1', itemType: 'content' });
    // 3. render de Videogen (monto del proveedor)
    await ev({ amount: '0.9400000000', provider: 'videogen', operation: 'videogen.render', itemKey: 'video:c1', itemType: 'video' });
    // 4. reserva ABIERTA de TTS (un capítulo sin liquidar desde el 14/10) = el reservado de #1353
    await ev({ amount: '0.0522500000', status: 'pending', provider: 'openai', operation: 'tts.audiobook', meta: { reservation: true }, itemKey: 'audiobook:c3', itemType: 'audiobook_chapter' });
    // 5. reserva liberada (Anthropic 429, sin cobro)
    const r5 = await ev({ amount: '0.1500000000', status: 'pending', meta: { reservation: true }, itemKey: 'content:c2', itemType: 'content' });
    await adj(r5, '-0.1500000000', T('10:00:02'), { reservationSettled: true, supersededBy: null }, { itemKey: 'content:c2', itemType: 'content' });
    // 6. reserva conciliada «cobrada» (ADJUSTMENT delta 0) = gasto real y una llamada
    const r6 = await ev({ amount: '0.0800000000', status: 'pending', meta: { reservation: true }, itemKey: 'content:c2', itemType: 'content' });
    await adj(r6, '0.0000000000', T('10:00:03'), { reservationReconciledAsCharged: true, settlement: 'reconciled_as_charged' }, { itemKey: 'content:c2', itemType: 'content' });
    // 7. cargo provisional de Gamma (p90) liquidado con la medición
    const g7 = await ev({ amount: '0.3000000000', status: 'pending', provider: 'gamma', operation: 'gamma.generate', meta: { estimatedPending: true }, itemKey: 'presentation:c1', itemType: 'presentation' });
    await adj(g7, '-0.0500000000', T('10:00:04'), { settlement: 'measured_differs' }, { provider: 'gamma', operation: 'gamma.generate', itemKey: 'presentation:c1', itemType: 'presentation' });
    // 8. empaque (cero por diseño, no es una llamada a proveedor)
    await ev({ amount: '0.0000000000', provider: 'cursia', operation: 'package.build', source: 'ZERO_BY_DESIGN' });
    // 9. llamada fallida cobrada
    await ev({ amount: '0.0120000000', outcome: 'failed_charged', itemKey: 'exam:m1', itemType: 'exam' });
    // 10. cargo final re-preciado (+0.01)
    const f10 = await ev({ amount: '1.0000000000', itemKey: 'exam:m1', itemType: 'exam' });
    await adj(f10, '0.0100000000', T('10:00:05'), { settlement: 'repriced' }, { itemKey: 'exam:m1', itemType: 'exam' });
    // 11. BYOK (clave del usuario) y 12. mock: nunca son costo de Cursia
    await ev({ amount: '9.0000000000', account: 'user_key', source: 'ACTUAL_PROVIDER', itemKey: 'content:c3', itemType: 'content' });
    await ev({ amount: '0.0000000000', account: 'mock', itemKey: 'content:c3', itemType: 'content' });
    // 13. el grueso del run vigente (llamadas reales liquidadas), 14. el run anterior, 15. lectura avanzada del documento (curso, sin run)
    await ev({ amount: '39.4930810500', itemKey: 'final_exam', itemType: 'final_exam' });
    await ev({ amount: '10.0000000000', run: RUN_B, at: '2026-10-12T10:00:00Z', itemKey: 'content:c1', itemType: 'content' });
    await ev({ amount: '0.0123000000', run: null, operation: 'llm.academic_extraction', at: T('10:00:06') });
    // Sin atribuir (prueba de conexión del navegador) — nunca entra al curso
    await ev({ amount: '0.0010000000', course: null, run: null, operation: 'llm.unattributed', meta: { attribution: 'unattributed', unattributedReason: 'no_attribution_declared' } });
    // Estimados (planeación) y topes
    await ds.query(`insert into public.cost_estimates (scope, owner_id, course_id, run_id, estimator_version, totals, created_at) values
      ('run', $1, $2, $3, 'est-v1', '{"min":"30.0000000000","expected":"45.0000000000","max":"60.0000000000"}'::jsonb, '2026-10-13T20:00:00Z'),
      ('run', $1, $2, $4, 'est-v1', '{"min":"5","expected":"12.5","max":"20"}'::jsonb, '2026-10-11T09:00:00Z')`, [OWNER, CID, RUN_A, RUN_B]);
    await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, authorized_budget, decision, approved_by, reason, created_at) values
      ($1, $2, 47.50, 'ADMIN_APPROVED', 'admin@cursia.test', 'tope inicial', '2026-10-13T20:00:01Z'),
      ($1, $2, 60.00, 'ADMIN_APPROVED', 'admin@cursia.test', 'ampliación', '2026-10-14T09:00:00Z'),
      ($3, $2, 20.00, 'ADMIN_APPROVED', 'admin@cursia.test', 'run anterior', '2026-10-11T09:00:01Z'),
      ($3, $2, 20.00, 'BLOCKED', null, 'cancelado', '2026-10-11T12:00:00Z')`, [RUN_A, CID, RUN_B]);

    const course = await costRead.courseCost(CID);
    const [netRow] = await ds.query(`select sum(amount)::text as net from public.generation_cost_events where course_id = $1 and billing_account = 'cursia'`, [CID]);
    await check('[L1] #1353: comprometido EXACTO "51.9236310500" (= neto del ledger, el costo del curso); real "51.8713810500"; reservado "0.0522500000"; real + reservado = comprometido', () => {
      eq([course.status, course.currency, course.committed, course.actual, course.reserved], ['ok', 'USD', '51.9236310500', '51.8713810500', '0.0522500000'], 'montos');
      eq(course.committed, netRow.net, 'comprometido = Σ amount del ledger del curso (Cursia)');
      eq(F.addDec(course.actual, course.reserved), course.committed, 'real + reservado = comprometido (exacto)');
      assert(['actual', 'reserved', 'committed'].every((k) => typeof course[k] === 'string' && /^\d+\.\d{10}$/.test(course[k])), 'strings decimales de 10 decimales');
    });
    await check('[L1] desglose por run (Σ runs = curso): run vigente, run anterior y eventos del curso sin run; estimado y tope del run más reciente (nunca mezclados con el gasto)', () => {
      const byRun = Object.fromEntries(course.runs.map((r) => [r.runId === null ? 'none' : r.runId, r]));
      eq([byRun[RUN_A].committed, byRun[RUN_A].actual, byRun[RUN_A].reserved], ['41.9113310500', '41.8590810500', '0.0522500000'], 'run vigente');
      eq([byRun[RUN_B].committed, byRun[RUN_B].authorized.amount, byRun[RUN_B].authorized.decision], ['10.0000000000', '0.0000000000', 'BLOCKED'], 'run anterior (BLOCKED → tope 0)');
      eq(byRun.none.committed, '0.0123000000', 'lectura avanzada (curso, sin run)');
      eq(F.addDec(...course.runs.map((r) => r.committed)), course.committed, 'Σ runs = curso');
      eq(course.runs[0].runId, RUN_A, 'el run más reciente primero');
      eq([course.estimated.expected, course.estimated.runId, course.authorized.amount, course.authorized.decision], ['45.0000000000', RUN_A, '60.0000000000', 'ADMIN_APPROVED'], 'estimado y tope del run vigente');
      assert(course.committed !== course.estimated.expected && course.actual !== course.estimated.expected, 'el estimado no es el gasto');
      const items = Object.fromEntries(byRun[RUN_A].byItemKey.map((g) => [g.key === null ? 'run' : g.key, g.committed]));
      eq(F.addDec(...Object.values(items)), byRun[RUN_A].committed, 'Σ partes (incl. a nivel run) = run');
      eq(items['content:c1'], '0.0740000000', 'reservas liquidadas no duplican el costo de la parte');
    });
    await check('[L1] BYOK aparte y fuera del costo de Cursia; mock nunca es dinero; contadores: llamadas (reserva+final = 1), reintentos, fallidas, reservas abiertas', () => {
      eq([course.byok.actual, course.byok.committed, course.byok.providerCalls], ['9.0000000000', '9.0000000000', 1], 'BYOK');
      // Llamadas Cursia: f1, f2, videogen, reserva TTS abierta, reserva conciliada cobrada, gamma, fallida, re-preciada,
      // grueso, run anterior, lectura avanzada = 11 (no cuentan: 3 reservas reemplazadas, empaque, mock, BYOK).
      eq([course.counts.providerCalls, course.counts.retries, course.retries.actual, course.counts.failedCalls, course.counts.openReservations, course.counts.openPending],
        [11, 1, '0.0410000000', 1, 1, 1], 'contadores');
      eq([course.counts.events, course.counts.eventsCursia, course.counts.eventsByok, course.counts.eventsMock], [23, 21, 1, 1], 'eventos');
      const prov = Object.fromEntries(course.byProvider.map((g) => [g.key, g]));
      eq([prov.anthropic.committed, prov.openai.reserved, prov.openai.actual, prov.videogen.providerCalls, prov.cursia.providerCalls], ['50.6813810500', '0.0522500000', '0.0000000000', 1, 0], 'por proveedor');
      eq(F.addDec(...course.byProvider.map((g) => g.committed)), course.committed, 'Σ proveedores = curso');
      eq(course.tokens.input, 18100, 'tokens del ledger (cargos finales de Anthropic)');
    });
    await check('[L1] lector admin /finops/courses/:id/costs: total = comprometido Cursia (sin BYOK); charges sin doble conteo (total = charges + adjustments + refunds); retriesPaid = 1 llamada neta', async () => {
      const c = await ledger.costsByCourse(CID);
      eq([c.totals.total, c.totals.byok, c.money.committed], ['51.9236310500', '9.0000000000', '51.9236310500'], 'total');
      eq(F.addDec(c.totals.charges, c.totals.adjustments, c.totals.refunds), c.totals.total, 'charges + adjustments + refunds = total');
      eq(c.totals.charges, '51.9636310500', 'charges = cargos que cuentan (sin reservas reemplazadas)');
      eq([c.retriesPaid.events, c.retriesPaid.total], [1, '0.0410000000'], 'reintentos pagados (antes: reserva + final = 2 y 0.266)');
      eq([c.totals.pending, c.totals.pending_events], ['0.0522500000', 1], 'pendiente');
    });

    const B0 = new Date('2026-10-01T00:00:00Z'); const B1 = new Date('2026-10-20T00:00:00Z');
    const full = await dash.getSummary(B0, B1);
    await check('[L2] el resumen del dashboard y /courses/:id/cost coinciden para #1353 (mismas definiciones, misma fuente)', async () => {
      const row = full.courseCosts.find((c) => c.courseId === String(CID));
      assert(row, 'fila de #1353');
      const viaApi = await dash.getCourseCost(CID);
      for (const k of ['actual', 'reserved', 'committed']) eq(row.money[k], viaApi.money[k], `dashboard = curso (${k})`);
      eq(row.money.counts, viaApi.money.counts, 'contadores');
      eq([row.courseName, row.frontendCourseId, viaApi.costSource, viaApi.money.committed], ['Curso piloto #1353', 'fe-1353', 'ledger_v2', '51.9236310500'], 'fila');
      // CoursesService (GET /courses/:id/cost) verifica dueño y delega con el id entero.
      const calls = [];
      const cs = new CoursesService(null, dash);
      cs.findOne = async (id, owner) => { calls.push([id, owner]); if (owner !== OWNER) throw Object.assign(new Error('Course not found'), { status: 404 }); return { id }; };
      const api = await cs.getCourseCost(CID, OWNER);
      eq([api.money.committed, api.money.actual, api.money.reserved, calls[0]], ['51.9236310500', '51.8713810500', '0.0522500000', [CID, OWNER]], 'GET /courses/1353/cost');
      let denied = null; try { await cs.getCourseCost(CID, OTHER); } catch (e) { denied = e; }
      assert(denied && denied.status === 404, 'otro usuario: 404');
      eq([full.money.committed, full.money.unattributed.committed, full.money.unattributed.byReason[0].reason], ['51.9246310500', '0.0010000000', 'no_attribution_declared'], 'período = cursos + sin atribuir (con motivo)');
      eq([full.money.perCourse.courses, full.money.perCourse.average, full.money.estimated.expected, full.money.authorized.amount], [1, '51.9236310500', '57.5000000000', '60.0000000000'], 'estadísticas en SQL; estimado/tope aparte');
      assert(!('total_estimated_cost_usd' in full) && !('savings_usd' in full) && !('traditional_equivalent_usd' in full) && !('costByProvider' in full), 'sin «costo = estimado» ni «ahorro»');
    });

    await check('[L3] período UTC por FECHA EFECTIVA: la reserva del 13/10 23:59 y su liquidación del 14/10 00:01 no dejan un neto negativo; «USD 0» (ok) ≠ «sin datos» (no_data)', async () => {
      const day14 = await costRead.periodSummary(new Date('2026-10-14T00:00:00Z'), new Date('2026-10-15T00:00:00Z'));
      // run anterior (12/10) y la familia de la reserva 1 (13/10) quedan fuera; el cargo final del 14/10 entra.
      eq([day14.committed, day14.actual, day14.reserved], ['41.9246310500', '41.8723810500', '0.0522500000'], 'día 14');
      const [naive] = await ds.query(`select sum(amount)::text as t from public.generation_cost_events where billing_account = 'cursia' and created_at >= '2026-10-14T00:00:00Z' and created_at < '2026-10-15T00:00:00Z'`);
      eq(naive.t, '41.6996310500', 'por created_at a secas el −0.225 del ajuste caería solo (lo que se evita)');
      const day13 = await costRead.periodSummary(new Date('2026-10-13T00:00:00Z'), new Date('2026-10-14T00:00:00Z'));
      eq([day13.status, day13.committed, day13.actual, day13.counts.events, day13.counts.providerCalls], ['ok', '0.0000000000', '0.0000000000', 2, 0], 'día 13: reserva + su ajuste = USD 0 con datos');
      const empty = await costRead.periodSummary(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z'));
      eq([empty.status, empty.committed, empty.actual, empty.perCourse.average, empty.courses.length], ['no_data', null, null, null, 0], 'sin datos');
      eq(F.addDec(day14.committed, day13.committed, (await costRead.periodSummary(new Date('2026-10-12T00:00:00Z'), new Date('2026-10-13T00:00:00Z'))).committed), full.money.committed, 'Σ días = período');
    });

    await check('[PC] promedio/mín./máx. por curso: solo cursos con gasto de Cursia > 0; cursos solo BYOK / solo mock / solo 0 quedan fuera de las estadísticas (no de la lista)', async () => {
      const day = (h) => `2026-09-10T${h}:00:00Z`;
      const mk = async (id, title) => ds.query(`insert into public.courses (id, owner_id, title, status, structure_version) values ($1, $2, $3, 'draft', 'dynamic')`, [id, OWNER, title]);
      await mk(91354, 'Solo BYOK'); await mk(91355, 'Solo mock'); await mk(91356, 'Cursia 2.5'); await mk(91357, 'Cursia 1.5'); await mk(91358, 'Solo empaque 0');
      await ev({ course: 91354, run: null, amount: '4.0000000000', account: 'user_key', source: 'ACTUAL_PROVIDER', at: day('10') });
      await ev({ course: 91355, run: null, amount: '0.0000000000', account: 'mock', at: day('10') });
      await ev({ course: 91356, run: null, amount: '2.5000000000', at: day('11') });
      await ev({ course: 91357, run: null, amount: '1.5000000000', at: day('12') });
      await ev({ course: 91358, run: null, amount: '0.0000000000', provider: 'cursia', operation: 'package.build', source: 'ZERO_BY_DESIGN', at: day('13') });
      const p = await costRead.periodSummary(new Date('2026-09-10T00:00:00Z'), new Date('2026-09-11T00:00:00Z'));
      eq([p.perCourse.courses, p.perCourse.excluded, p.perCourse.average, p.perCourse.min, p.perCourse.max], [2, 3, '2.0000000000', '1.5000000000', '2.5000000000'], 'estadísticas solo con gasto Cursia');
      eq(p.courses.length, 5, 'los 5 cursos siguen en la lista del período');
      eq([p.committed, p.byok.committed, p.completeness], ['4.0000000000', '4.0000000000', 'complete'], 'BYOK aparte; completo');
    });

    await check('[L4] filas antiguas de usage_events con costos inventados (y POST /events) no cambian NINGUNA cifra de dinero; la actividad sí se cuenta', async () => {
      const before = JSON.stringify({ c: await dash.getCourseCost(CID), s: (await dash.getSummary(B0, B1)).money });
      await ds.query(`insert into public.usage_events (user_id, event_type, failed, estimated_cost_usd, real_cost_usd, cost_type, course_id, created_at) values
        ($1, 'course_production_completed', false, 500, 999.99, 'real', '1353', '2026-10-14T12:00:00Z'),
        ($1, 'ia_content', false, 7.09, null, 'estimated', '1353', '2026-10-14T12:00:00Z'),
        ($1, 'ia_content', true, 3, 3, 'real', 'fe-1353', '2026-10-14T12:00:00Z')`, [OWNER]);
      const afterC = await dash.getCourseCost(CID);
      const afterS = await dash.getSummary(B0, B1);
      eq(JSON.stringify({ c: afterC, s: afterS.money }), before, 'dinero idéntico antes y después');
      eq([afterS.production.completed, afterS.events.total, afterS.events.failed, afterS.productionTrend], [1, 3, 1, [{ date: '2026-10-14', count: 1 }]], 'actividad (no dinero) desde usage_events');
    });

    // ── Run real (servicios) para el guard / la atribución / el precio faltante ───────────────────────────────
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const runs = new RunsService(ds, manifests, {}, { async check() { return { ok: true }; } }, budget);
    const [c2] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, 'FinOps P0 guard', 'dynamic') returning id`, [OWNER]);
    const gcid = c2.id;
    const m1 = crypto.randomUUID(); const ch1 = crypto.randomUUID(); const ch2 = crypto.randomUUID();
    const s2 = snap.buildBlueprintSnapshotV2({ id: gcid, title: 'FinOps P0 guard', finalExam: true, activityEngine: 'h5p' },
      [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
      [{ id: ch1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: false, activity_enabled: true },
        { id: ch2, module_id: m1, position: 1, title: 'Válvulas', objective: null, video_enabled: false, activity_enabled: true }]);
    for (const m of s2.modules) {
      await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, gcid, m.position, m.title]);
      for (const c of m.chapters) await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`, [c.id, gcid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
    }
    await ds.query(`insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count) values ($1, 1, 2, $2::jsonb, $3, 0, 1, 2)`,
      [gcid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
    await manifests.getOrCreate(gcid, OWNER, 1);
    let grun;
    try { grun = (await runs.startRun(gcid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id; } catch (err) {
      const body = err.getResponse ? err.getResponse() : null;
      assert(body && body.code === 'budget_approval_required', `startRun: ${err.message}`);
      await budget.adminAuthorize({ courseId: gcid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test', reason: 'check finops p0' });
      grun = (await runs.startRun(gcid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
    }
    await ds.query(`update public.production_jobs set worker_status = 'running', status = 'running' where id = $1`, [grun]);
    const [gitem] = await ds.query(`select id, item_key from public.generation_item_runs where job_id = $1 and type = 'content' order by item_key limit 1`, [grun]);
    const authorize = (amount) => ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, authorized_budget, decision, approved_by, reason) values ($1, $2, $3, 'ADMIN_APPROVED', 'admin@cursia.test', 'check p0')`, [grun, gcid, amount]);
    const ctrl = new FinopsLlmReservationController(ledger, budget);
    const resBody = (subject, extra = {}) => ({ subject, itemRunId: gitem.id, callRole: 'main', attempt: 1, model: 'claude-sonnet-4-6', callId: crypto.randomUUID(), promptChars: 3000, maxTokens: 2000, billingAccount: 'cursia', ...extra });
    const eventsOf = async (where, p) => ds.query(`select *, amount::text as amount from public.generation_cost_events where ${where}`, p);
    const resInput = (owner, tag, extra = {}) => ({
      itemRunId: gitem.id, ownerIdFromAuth: owner, provider: 'anthropic', service: 'messages', modelOrProduct: 'claude-sonnet-4-6',
      usage: LUI.llmCallUpperBoundUsage(30000, 12000), usageUnit: 'output_tokens', externalOperationId: null,
      idempotencyKey: `reservation:test:${gitem.id}:${tag}`, callRole: 'main', attempt: 1, billingAccount: 'cursia', mode: 'real',
      costSource: 'CALCULATED_FROM_USAGE', measurementStatus: 'pending', pricingFallback: 'pending_zero', recordedBy: 'check',
      metadata: { reservation: true, llmUpperBound: true, callTag: tag }, ...extra,
    });

    await check('[AT] proxy: un NO dueño que declara la parte de otro run → 409 attribution_rejected ANTES de reservar (0 eventos, el proxy no llama); el dueño sí reserva (atribuida)', async () => {
      await authorize('500');
      const bad = resBody(OTHER);
      const e = await rejectsCode(ctrl.llmReservation(bad), 'attribution_rejected', 'no dueño');
      assert(e.getStatus && e.getStatus() === 409, '409');
      eq((await eventsOf(`idempotency_key = $1`, [LUI.llmProxyReservationKey(bad.callId)])).length, 0, 'sin reserva del no dueño');
      const ok = await ctrl.llmReservation(resBody(OWNER));
      eq([ok.reserved, ok.inserted, ok.attributed], [true, true, true], 'dueño');
      // BYOK de un no dueño: su propia clave, no consume el run → se registra SIN atribuir (nunca carga al run ajeno).
      const byok = await ctrl.llmReservation(resBody(OTHER, { billingAccount: 'user_key' }));
      const [bev] = await eventsOf(`idempotency_key = $1`, [byok.reservationKey]);
      eq([bev.run_id, bev.course_id, bev.owner_id, bev.metadata.unattributedReason], [null, null, OTHER, 'owner_mismatch'], 'BYOK ajeno sin atribuir, con motivo');
    });

    await check('[AT] ledger directo (sin pasar por el guard): reserva Cursia de un no dueño por HTTP → ATTRIBUTION_REJECTED; con el run AL TOPE ni el dueño ni el no dueño pasan (el tope no se salta)', async () => {
      await rejectsCode(ledger.recordCharge(resInput(OTHER, 'http-other')), 'ATTRIBUTION_REJECTED', 'no dueño');
      const [t] = await ds.query(`select coalesce(sum(amount),0)::text as t from public.generation_cost_events where run_id = $1 and billing_account <> 'user_key'`, [grun]);
      await authorize(t.t); // tope = lo ya comprometido
      await rejectsCode(ledger.recordCharge(resInput(OWNER, 'owner-at-cap')), 'RUN_BUDGET_CAP', 'dueño al tope');
      await rejectsCode(ledger.recordCharge(resInput(OTHER, 'other-at-cap')), 'ATTRIBUTION_REJECTED', 'no dueño al tope');
      const deny = await rejectsCode(ctrl.llmReservation(resBody(OTHER)), 'attribution_rejected', 'proxy no dueño al tope');
      assert(deny, 'rechazo');
      eq((await eventsOf(`idempotency_key like $1`, [`reservation:test:${gitem.id}:%at-cap`])).length, 0, 'nada se insertó');
      const [t2] = await ds.query(`select coalesce(sum(amount),0)::text as t from public.generation_cost_events where run_id = $1 and billing_account <> 'user_key'`, [grun]);
      eq(t2.t, t.t, 'el comprometido del run no cambió');
      // Un no dueño tampoco se cuela «sin atribuir» por el guard del proxy (antes devolvía null = permitido).
      const g = await budget.guardLlmProxyCall({ subject: OTHER, itemRunId: gitem.id, model: 'claude-sonnet-4-6', promptChars: 10, maxTokens: 10, billingAccount: 'cursia' });
      eq(g && g.code, 'attribution_rejected', 'guard del proxy');
    });

    await check('[AT] worker del SERVIDOR con un owner distinto del run: el evento CONSERVA course_id/run_id (owner = dueño del run, ejecutor en metadata) y el tope del run APLICA', async () => {
      await rejectsCode(ledger.recordCharge(resInput(OTHER, 'srv-at-cap', { executorAuthorization: 'server_worker' })), 'RUN_BUDGET_CAP', 'el tope aplica al ejecutor de servidor');
      await authorize('500');
      const r = await ledger.recordCharge(resInput(OTHER, 'srv-ok', { executorAuthorization: 'server_worker' }));
      eq([r.inserted, r.event.course_id, r.event.run_id, r.event.item_run_id, r.event.owner_id, r.event.metadata.executorOwnerId], [true, gcid, grun, gitem.id, OWNER, OTHER], 'atribución conservada');
      const run = await costRead.runCost(grun);
      assert(run.counts.openReservations >= 2 && F.cmpDec(run.reserved, r.event.amount) >= 0, 'cuenta en el reservado del run');
    });

    await check('[UP] cargo final SIN precio (review r1 I1): la reserva se liquida a 0 (nunca abierta), el cargo a 0 pendiente se lista «sin precio», completeness partial, real NO inflado y ningún lector cuenta doble; al re-preciar entra el precio real', async () => {
      const MODEL = 'claude-modelo-p0-sin-precio';
      const before = await costRead.runCost(grun);
      const beforeCourse = await costRead.courseCost(gcid);
      const beforeAdmin = await ledger.costsByRun(grun);
      eq([before.completeness, beforeCourse.completeness], ['complete', 'complete'], 'antes: completo');
      const resKey = `reservation:test:${gitem.id}:unpriced`;
      const res = await ledger.recordCharge(resInput(OWNER, 'unpriced', { modelOrProduct: MODEL, idempotencyKey: resKey }));
      assert(res.inserted && F.cmpDec(res.event.amount, 0) > 0, 'reserva conservadora > 0');
      const finalInput = {
        itemRunId: gitem.id, ownerIdFromAuth: OWNER, provider: 'anthropic', service: 'messages', modelOrProduct: MODEL,
        usage: { input_tokens: 1000, output_tokens: 500 }, usageUnit: 'output_tokens', externalOperationId: 'msg_p0_unpriced',
        idempotency: { kind: 'anthropic', parts: { messageId: 'msg_p0_unpriced' } }, callRole: 'main', attempt: 1, billingAccount: 'cursia', mode: 'real',
        costSource: 'CALCULATED_FROM_USAGE', recordedBy: 'check', pricingFallback: 'pending_zero',
      };
      const s = await ledger.settleReservation(resKey, finalInput, 'test_settled');
      eq([s.finalInserted, s.released, s.finalEvent.amount, s.finalEvent.measurement_status, s.finalEvent.metadata.pricingMissing, s.finalEvent.metadata.unpricedReason, s.finalEvent.pricing_snapshot ?? null, 'reservationKeptOpen' in s.finalEvent.metadata],
        [true, true, '0.0000000000', 'pending', true, 'pricing_missing', null, false], 'final a 0 pendiente con la marca; la reserva se liquida (comportamiento original)');
      eq(await ledger.reservationSettled(resKey), true, 'la reserva NO queda abierta');
      const mid = await costRead.runCost(grun);
      eq([mid.unpriced.count, mid.unpriced.events[0].idempotencyKey, mid.unpriced.events[0].reason, mid.completeness], [1, 'anthropic:msg:msg_p0_unpriced', 'pricing_missing', 'partial'], 'listado «sin precio», alcance parcial');
      eq([mid.actual, mid.reserved, mid.committed], [before.actual, before.reserved, before.committed], 'real NO inflado (ni con la cota); reservado sin la reserva ya liquidada');
      eq([mid.counts.providerCalls - before.counts.providerCalls, mid.counts.openReservations - before.counts.openReservations], [1, 0], 'UNA llamada (el cargo sin precio), ninguna reserva abierta nueva');
      const midCourse = await costRead.courseCost(gcid);
      eq([midCourse.completeness, midCourse.unpriced.count - beforeCourse.unpriced.count, midCourse.committed], ['partial', 1, beforeCourse.committed], 'curso: parcial, sin doble conteo');
      const midPeriod = await costRead.periodSummary(new Date('2026-01-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'));
      const prow = midPeriod.courses.find((c) => c.courseId === Number(gcid));
      eq([midPeriod.completeness, prow.money.completeness, prow.money.committed], ['partial', 'partial', beforeCourse.committed], 'período y fila del curso: parcial');
      // Lectores de «resultado desconocido» / conciliación: la reserva cerrada no aparece y no se puede contar como cobrada.
      const pend = await ledger.pendingLlmWorkerReservations({ runId: grun });
      assert(!pend.some((r) => r.reservationKey === resKey), 'no aparece en la lista de reservas a conciliar');
      const rc = await ledger.reconcileReservationAsCharged(resKey, 'check', { decidedBy: 'admin@cursia.test' });
      eq([rc.reconciled, rc.alreadySettled], [false, true], 'conciliar «cobrada» es no-op (no suma R)');
      const midAdmin = await ledger.costsByRun(grun);
      eq([midAdmin.totals.total, midAdmin.totals.pending, midAdmin.retriesPaid.events], [beforeAdmin.totals.total, beforeAdmin.totals.pending, beforeAdmin.retriesPaid.events], 'lector admin /finops/runs: sin doble conteo');
      eq(midAdmin.money.completeness, 'partial', 'lector admin: money parcial');
      // Reintento de la misma liquidación: idempotente.
      const s2 = await ledger.settleReservation(resKey, finalInput, 'test_settled');
      eq([s2.finalInserted, s2.alreadySettled], [false, true], 'reintento: no-op');
      await ds.query(`insert into public.pricing_catalog (provider, service, product_or_model, meter, unit_size, unit_price, currency, pricing_version, effective_from, source, verified)
        values ('anthropic','messages',$1,'input_tokens',1000000,3,'USD','p0-test','2026-01-01T00:00:00Z','contract',false),
               ('anthropic','messages',$1,'output_tokens',1000000,15,'USD','p0-test','2026-01-01T00:00:00Z','contract',false)`, [MODEL]);
      const adjR = await ledger.repricePendingCharge('anthropic:msg:msg_p0_unpriced');
      eq([adjR.inserted, adjR.delta], [true, '0.0105000000'], 're-preciado');
      const after = await costRead.runCost(grun);
      eq([after.unpriced.count, after.completeness, after.reserved, F.subDec(after.actual, before.actual), after.counts.providerCalls - before.counts.providerCalls],
        [0, 'complete', before.reserved, '0.0105000000', 1], 'real = precio real; completo; la llamada sigue contando una vez');
    });

    await check('[DC] llamada directa: al curso del dueño (course_id, scope course); curso ajeno → sin atribuir con motivo; sin curso → motivo explícito (nunca NULL silencioso); /tts/speech medido', async () => {
      const lg = { error: () => {} };
      const base = { model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100 }, operation: 'llm.brand_extraction', recordedBy: 'check' };
      assert(await DC.recordDirectAnthropicCall(ledger, lg, { ...base, ownerId: OWNER, messageId: 'msg_dc_1', courseId: gcid, unattributedReason: 'x' }), 'registrado');
      assert(await DC.recordDirectAnthropicCall(ledger, lg, { ...base, ownerId: OTHER, messageId: 'msg_dc_2', courseId: gcid, unattributedReason: 'x' }), 'registrado 2');
      assert(await DC.recordDirectAnthropicCall(ledger, lg, { ...base, ownerId: OWNER, messageId: 'msg_dc_3', unattributedReason: 'brand_extraction' }), 'registrado 3');
      const rows = await eventsOf(`idempotency_key = any($1::text[]) order by idempotency_key`, [['anthropic:msg:msg_dc_1', 'anthropic:msg:msg_dc_2', 'anthropic:msg:msg_dc_3']]);
      eq(rows.map((r) => [r.course_id, r.scope, r.run_id, r.metadata.unattributedReason ?? null, r.operation]), [
        [gcid, 'course', null, null, 'llm.brand_extraction'],
        [null, null, null, 'course_owner_mismatch', 'llm.brand_extraction.unattributed'],
        [null, null, null, 'brand_extraction', 'llm.brand_extraction.unattributed'],
      ], 'atribución');
      assert(await DC.recordDirectTtsCall(ledger, lg, { ownerId: OWNER, model: 'gpt-4o-mini-tts', requestId: 'req_p0_1', audioSeconds: 120, characters: 1800, courseId: gcid, unattributedReason: 'legacy_tts_no_course', recordedBy: 'tts-speech', localCallId: 'l' }), 'tts');
      const [tts] = await eventsOf(`idempotency_key = 'openai:req:req_p0_1'`, []);
      eq([tts.amount, tts.measurement_status, tts.course_id, tts.operation], ['0.0300000000', 'final', gcid, 'tts.speech'], 'TTS 120 s × 0,015/min');
      const gc = await costRead.courseCost(gcid);
      assert(gc.runs.some((r) => r.runId === null && F.cmpDec(r.committed, '0.0300000000') >= 0), 'aparece en el costo del curso (fila sin run)');
      eq(gc.completeness, 'complete', 'TTS medido: completo');
      // Review r1 (m1): TTS cuya respuesta no se pudo medir → pendiente 0 marcado «sin precio» (lista + parcial).
      assert(await DC.recordDirectTtsCall(ledger, lg, { ownerId: OWNER, model: 'gpt-4o-mini-tts', requestId: 'req_p0_unmeasured', audioSeconds: null, characters: 900, courseId: gcid, unattributedReason: 'legacy_tts_no_course', recordedBy: 'tts-speech', localCallId: 'l2' }), 'tts sin medir');
      const [tu] = await eventsOf(`idempotency_key = 'openai:req:req_p0_unmeasured'`, []);
      eq([tu.amount, tu.measurement_status, tu.metadata.unpricedReason, tu.metadata.pricingMissing ?? null], ['0.0000000000', 'pending', 'usage_not_measured', null], 'TTS sin medir: pendiente 0 con la marca');
      const gc2 = await costRead.courseCost(gcid);
      eq([gc2.completeness, gc2.unpriced.count - gc.unpriced.count, gc2.committed, gc2.unpriced.events.find((x) => x.idempotencyKey === 'openai:req:req_p0_unmeasured').reason],
        ['partial', 1, gc.committed, 'usage_not_measured'], 'curso parcial, listado con su motivo, sin inventar monto');
      // Un cliente no puede marcar «sin precio» (la marca es server-side).
      const forged = await ledger.recordCharge({ ownerIdFromAuth: OWNER, provider: 'anthropic', service: 'messages', modelOrProduct: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 10 },
        idempotency: { kind: 'anthropic', parts: { messageId: 'msg_forged_unpriced' } }, billingAccount: 'cursia', mode: 'real', recordedBy: 'llm-proxy', metadata: { unpricedReason: 'pricing_missing' } });
      eq(forged.event.metadata.unpricedReason ?? null, null, 'metadata del cliente sin la marca');
      // Sin atribución declarada: el ledger marca el motivo explícito.
      const plain = await ledger.recordCharge({ ownerIdFromAuth: OWNER, provider: 'anthropic', service: 'messages', modelOrProduct: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 },
        idempotency: { kind: 'anthropic', parts: { messageId: 'msg_conn_test' } }, billingAccount: 'cursia', mode: 'real', recordedBy: 'llm-proxy' });
      eq([plain.event.metadata.attribution, plain.event.metadata.unattributedReason, plain.event.scope], ['unattributed', 'no_attribution_declared', null], 'prueba de conexión');
    });

    await check('[L4] el ledger NO lee usage_events: con la tabla antigua renombrada el costo del curso sale igual (el dashboard solo pierde la actividad)', async () => {
      const before = await dash.getCourseCost(CID);
      await ds.query(`alter table public.usage_events rename to usage_events_hidden`);
      try {
        const after = await dash.getCourseCost(CID);
        eq(JSON.stringify(after), JSON.stringify(before), 'costo idéntico sin usage_events');
        const s = await dash.getSummary(B0, B1);
        eq([s.events.total, s.money.committed !== null], [0, true], 'sin actividad, con dinero');
      } finally {
        await ds.query(`alter table public.usage_events_hidden rename to usage_events`);
      }
    });

    await check('[L1] sin ledger migrado (producción hoy): status unavailable y montos null — nunca un 500 ni un «USD 0» inventado', async () => {
      const fake = { transaction: async () => { const e = new Error('relation "public.generation_cost_events" does not exist'); e.code = '42P01'; throw e; } };
      const cr = new CR.CostReadService(fake);
      const c = await cr.courseCost(CID);
      eq([c.status, c.committed, c.actual, c.reserved], ['unavailable', null, null, null], 'curso');
      const p = await cr.periodSummary(B0, B1);
      eq([p.status, p.committed, p.courses.length], ['unavailable', null, 0], 'período');
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
