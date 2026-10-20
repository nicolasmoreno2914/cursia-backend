#!/usr/bin/env node
/* eslint-disable */
// r62 (agente P) — autonomía del empaquetado y de la entrega: un caso por punto.
//
//   [d7]  fallos TRANSITORIOS del empaque (Storage, DB, red) → el worker los registra (`output_summary.failure`), no
//         consumen el tope de 3 intentos, se reintentan con espera CRECIENTE hasta la ventana larga (72 h, alerta a las
//         24 h) y al agotarla queda la excepción explícita (`package_transient_exhausted`). Un BLOCKER determinista
//         (MBZ_V3_VALIDATION_FAILED, c11) sigue siendo D / product_bug. Estado (TS) ≡ barrido (SQL) en un PG16 desechable.
//   [K4]  Storage falla al descargar el paquete existente para re-verificarlo → el job NO falla: reconstruye en una
//         ruta NUEVA (`<clave>.<sha16>.mbz`), sin POST a la ruta referenciada.
//   [d6]  cuota de YouTube: espera larga (7 días) con alerta a las 24 h; agotada → `youtube_quota_exhausted` (D config,
//         resolve_youtube, nunca reabierto en silencio). Review M1: gate GLOBAL (medianoche PT) + turno FIFO, con el SQL
//         real en PG16. El paquete final v3 exige hoy cada video en YouTube.
//   [d14] DYNAMIC_DEFAULT_HOLD_PACKAGING_OWNERS: default vacío en el código y ausente de ambos deploys (staging solo avisa);
//         la herramienta de modo fábrica sigue funcionando si se define.
//   [K5]  hold persistente de workers (DYNAMIC_WORKERS_HOLD) visible en el run (`RunDto.workersHold`: estado y motivo);
//         review M2: al dueño solo estado + motivo genérico (sin variables ni procesos).
//   Review I1: Storage 4xx / config, CONTENT_MISSING y ERR_BUFFER_TOO_LARGE nunca transitorios; `ensure` sin clasificar
//         conserva el tope de 5 (c10). Review M3: el row del rebuild K4 es reutilizable (checksum = validatedSha256).
//
// Sin red (fetch prohibido salvo 127.0.0.1), USD 0. PG16 desechable en un puerto libre ≠ 5570 / 8099 para [d7] SQL
// (si no hay PG16 → ese sub-caso falla: setear PG_BIN). Usage: npm run build && node scripts/check-r62-package-autonomy.js

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
  if (/^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o);
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
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const AP = L('modules/dynamic-packaging/auto-package-state.js');
const RC = L('modules/dynamic-generation/run-completion.js');
const FC = L('modules/reliability/failure-classifier.js');
const W = L('workers/dynamic-package-worker.js');
const RV = L('modules/dynamic-packaging/package-reuse-verify.js');
const reuse = L('modules/dynamic-packaging/packaging-reuse-key.js');
const { DYNAMIC_MBZ_BUILDER_VERSION } = L('package/dynamic-mbz-builder.js');
const IW = L('workers/dynamic-item-worker.js');
const D = L('modules/dynamic-generation/dynamic-video-delivery.js');
const AH = L('modules/dynamic-generation/auto-heal.js');
const SA = L('modules/dynamic-generation/stop-after.js');
const WH = L('modules/dynamic-generation/workers-hold.js');
const PV3 = L('modules/dynamic-packaging/packaging-v3.js');

// ── fakes del worker de empaque (mismo patrón que check-dynamic-package-worker-hardening) ────────────────
function fakeDataSource() {
  const state = { completed: [], failed: [] };
  return {
    state,
    async query(sql, params) {
      if (/set lease_until/.test(sql)) return [{ id: params[0] }];
      if (/select input_payload from public\.production_jobs/.test(sql)) return [{ input_payload: {} }];
      if (/set status = 'completed'/.test(sql)) { state.completed.push({ id: params[0], summary: JSON.parse(params[2]) }); return [{ id: params[0] }]; }
      if (/set status = 'failed'/.test(sql)) { state.failed.push({ id: params[0], message: params[2], failure: params[3] ? JSON.parse(params[3]) : null, sql }); return []; }
      return [];
    },
    createQueryRunner() { return { async connect() {}, async release() {}, async startTransaction() {}, async commitTransaction() {}, async rollbackTransaction() {}, async query() { return [{}]; } }; },
  };
}
const logger = () => { const c = { log: [], warn: [], error: [] }; return { calls: c, log: (m) => c.log.push(String(m)), warn: (m) => c.warn.push(String(m)), error: (m) => c.error.push(String(m)) }; };
const STUB_PLAN = { planVersion: 1, manifestId: 1, course: { id: 1, title: 'x', summary: null }, sections: [], modules: [], totals: { modules: 0, chapters: 0, scorms: 0, videos: 0, exams: 0 } };
const RESOLVED = new Map([['content_cap1', [{ artifactId: 'bbbb', type: 'dynamic_content_md' }]], ['scorm_cap1', [{ artifactId: 'aaaa', type: 'dynamic_scorm_html' }]]]);
function workerDeps(ds, over = {}) {
  const uploads = [];
  const built = [];
  const deps = {
    dataSource: ds,
    artifacts: {
      async findAll() { return over.existing || []; },
      async uploadBufferArtifact(input) { if (over.uploadThrows) throw over.uploadThrows; uploads.push(input); return { id: `artifact-${uploads.length}` }; },
      async downloadStorageObject(bucket, p) {
        if (over.downloadThrows) throw over.downloadThrows;
        const b = (over.storage || {})[`${bucket}/${p}`];
        if (!b) throw new Error(`Supabase Storage download failed: 404 ${bucket}/${p}`);
        return b;
      },
      async isStoragePathReferenced(bucket, p) { return (over.referenced || []).includes(`${bucket}/${p}`); },
    },
    manifests: {
      async get() { return { id: 1, blueprintNumber: 1, rulesVersion: 1, manifest: { items: [] } }; },
      async getById() { return { id: 1, blueprintNumber: 1, rulesVersion: 1, manifest: { items: [] } }; },
    },
    blueprints: { async getByNumber() { return { snapshot: {} }; } },
    buildPlan: () => STUB_PLAN,
    resolveArtifacts: async () => RESOLVED,
    loadText: async () => '',
    parseVideo: () => ({ url: '', videogenJobId: '' }),
    buildMbz: async (input) => { built.push(input); if (over.buildThrows) throw over.buildThrows; return over.bytes || Buffer.from('mbz-bytes-new-build'); },
    logger: over.logger || logger(),
    workerId: 'w-r62',
    leaseSeconds: 60,
    heartbeatMs: 999999,
  };
  return { deps, uploads, built };
}
const JOB = (id = 'job-1') => ({
  id, owner_id: 'owner-1', course_id: 1, frontend_course_id: 'fc-1', worker_status: 'running', status: 'running',
  input_payload: { runId: 'run-1', manifestId: 1, blueprintNumber: 1 }, output_summary: {}, attempt_count: 1, max_attempts: 3,
});

// ── PG16 desechable (solo las columnas que leen loadAutoPackageState / findAutoPackageCandidates) ─────────
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

const ON = { DYNAMIC_COURSE_STRUCTURE: 'true' }; // tick del auto-healer encendido (default con la estructura dinámica)

(async () => {
  const NOW = new Date();
  const hAgo = (h) => new Date(NOW.getTime() - h * 3_600_000);
  const sAgo = (s) => new Date(NOW.getTime() - s * 1000);

  console.log('\n=== [d7] empaque: transitorios sin tope de rondas, espera creciente, excepción explícita ===');

  await check('[d7] el worker registra el fallo: Storage/DB/red → transitorio (A); MBZ_V3_VALIDATION_FAILED → D product_bug, NO transitorio; texto libre → no transitorio (tope de siempre)', async () => {
    const T = (m) => W.packageJobFailureRecord(m);
    for (const m of ['Supabase Storage upload failed: 503 Service Unavailable', 'Connection terminated unexpectedly', 'EMAXCONNSESSION max clients reached',
      'connect ECONNREFUSED 10.0.0.1:5432', 'PACKAGE_OBJECT_CONFLICT: x', 'PACKAGE_REUSE_VERIFY_UNAVAILABLE: x', 'deadlock detected', 'fetch failed']) {
      const r = T(m);
      eq([r.class, r.transient], ['A', true], m);
    }
    const v = T('MBZ_V3_VALIDATION_FAILED: 2 hallazgo(s): FILES_INTEGRITY');
    eq([v.class, v.code, v.transient], ['D', 'MBZ_V3_VALIDATION_FAILED', false], 'BLOCKER determinista');
    eq(FC.classifyFailure({ source: 'package_worker', error: 'MBZ_V3_VALIDATION_FAILED: x' }).humanReason, 'product_bug', 'c11 sigue product_bug');
    eq(T('build falló (simulado)').transient, false, 'sin clasificar');
    // r62 review I1: deterministas que antes eran A (y con r62 se habrían reintentado 72 h) → NO transitorios.
    const det = [
      ['PACKAGING_V3_CONTENT_MISSING: faltan 1 contenido(s): content:c1', 'B', 'PACKAGING_V3_CONTENT_MISSING', null],
      ['ERR_BUFFER_TOO_LARGE: Cannot create a Buffer larger than 4294967296 bytes', 'D', 'ERR_BUFFER_TOO_LARGE', 'product_bug'],
      ['Supabase Storage download failed: 404 {"error":"not_found","message":"Object not found"}', 'D', 'PACKAGE_STORAGE_NOT_FOUND', 'product_bug'],
      ['Supabase Storage upload failed: 413 Payload too large', 'D', 'PACKAGE_STORAGE_TOO_LARGE', 'config'],
      ['Supabase Storage upload failed: 403 new row violates row-level security policy', 'D', 'PACKAGE_STORAGE_FORBIDDEN', 'config'],
      ['SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to upload artifacts', 'D', 'PACKAGE_STORAGE_CONFIG', 'config'],
    ];
    for (const [m, cls, code, why] of det) {
      const r = T(m);
      const v = FC.classifyFailure({ source: 'package_worker', error: m });
      eq([r.transient, r.class, r.code, v.humanReason, v.unclassified], [false, cls, code, why, false], `determinista: ${m}`);
    }
    // 5xx / 429 de Storage siguen transitorios; el restore no cambia (respaldo pre-r62).
    for (const m of ['Supabase Storage download failed: 503 Service Unavailable', 'Supabase Storage upload failed: 429 Too Many Requests', 'HTTP 502 Bad Gateway']) eq(T(m).transient, true, m);
    eq(FC.classifyFailure({ source: 'restore_worker', error: 'Supabase Storage download failed: 404' }).code, 'RESTORE_INFRA_UNKNOWN', 'restore sin cambios');
    // `ensure`: solo lo clasificado A queda sin tope.
    const APS = L('modules/dynamic-packaging/auto-package.service.js');
    eq([APS.ensureErrorIsTransient(new Error('Connection terminated unexpectedly')), APS.ensureErrorIsTransient(new TypeError("Cannot read properties of undefined (reading 'x')")),
      APS.ensureErrorIsTransient(new Error('Supabase Storage download failed: 404'))], [true, false, false], 'ensure: A vs sin clasificar / determinista');
    // Integración: el worker real (processItem) deja `output_summary.failure` en el UPDATE del fallo.
    const ds = fakeDataSource();
    const { deps } = workerDeps(ds, { uploadThrows: new Error('Supabase Storage upload failed: 503 Service Unavailable') });
    await W.processItem(deps, JOB('job-st'));
    eq([ds.state.failed.length, ds.state.failed[0].failure.transient, /'failure'/.test(ds.state.failed[0].sql)], [1, true, true], 'fallo de Storage registrado transitorio');
    const ds2 = fakeDataSource();
    const { deps: d2 } = workerDeps(ds2, { buildThrows: new Error('MBZ_V3_VALIDATION_FAILED: 1 hallazgo(s): TOKEN_INVALID') });
    await W.processItem(d2, JOB('job-v3'));
    eq([ds2.state.failed[0].failure.class, ds2.state.failed[0].failure.transient], ['D', false], 'BLOCKER registrado no transitorio');
  });

  // Estado puro con un q falso: jobs finales fallidos desde la marca.
  const runOf = (eligibleAt, transient) => ({ id: 'run-x', worker_status: 'completed', output_summary: { autoPackage: { eligibleAt: eligibleAt.toISOString(), ...(transient ? { transient } : {}) } } });
  const jobRow = (finished, transient, i) => ({
    id: `p${i}`, worker_status: 'failed', input_payload: { runId: 'run-x' }, created_at: new Date(finished.getTime() - 60_000), finished_at: finished, updated_at: finished,
    output_summary: transient === null ? {} : { failure: { class: transient ? 'A' : 'D', code: transient ? 'package_transient' : 'MBZ_V3_VALIDATION_FAILED', transient } },
  });
  const qOf = (jobs) => ({ query: async () => [...jobs].sort((a, b) => b.created_at - a.created_at) });
  const COMPLETE_ROWS = [{ id: 'i1', item_key: 'content:c1', type: 'content', status: 'completed', output_summary: { v3Validation: { artifactType: 'x', artifactId: 'y', contentSha256: 'z'.repeat(64) } }, finished_at: NOW }];
  const MANIFEST = { rulesVersion: 3, items: [{ key: 'content:c1', type: 'content' }] };
  const completionWith = (pk) => RC.evaluateRunCompletion({ status: 'completed', worker_status: 'completed', input_payload: {} }, COMPLETE_ROWS, MANIFEST,
    { ready: false, status: pk.status, autoRetryPending: pk.autoRetryPending, auto: true, blocked: null, attentionReason: pk.attentionReason, alert: pk.alert,
      nextRetryAt: pk.nextRetryAt ? pk.nextRetryAt.toISOString() : null }, { now: NOW });

  await check('[d7] estado: 6 jobs fallidos TRANSITORIOS (antes: agotado en 3) → sigue pendiente solo, espera creciente (60·2^5 s), alerta pasadas 24 h; completion = packaging sin acción', async () => {
    const jobs = [1, 2, 3, 4, 5, 6].map((i) => jobRow(hAgo(30 - i), true, i));
    const st = await AP.loadAutoPackageState(qOf(jobs), runOf(hAgo(30)), NOW, ON, 3);
    eq([st.status, st.autoRetryPending, st.hardFailedSinceMark, st.transientFailedSinceMark, st.attentionReason, st.alert],
      ['failed', true, 0, 6, null, AP.PACKAGE_TRANSIENT_RETRYING_ALERT], 'pendiente con alerta');
    eq(AP.autoPackageBackoffSeconds(60, 6), 1920, 'espera creciente');
    eq(AP.autoPackageBackoffSeconds(60, 20), AP.AUTO_PACKAGE_RETRY_BACKOFF_MAX_SECONDS, 'techo de 1 h');
    eq(st.nextRetryAt.getTime(), hAgo(24).getTime() + 1920 * 1000, 'próximo reintento = último fallo + espera');
    const c = completionWith(st);
    eq([c.state, c.adminActions, c.packageJob.alert, typeof c.packageJob.nextRetryAt], ['packaging', [], 'package_transient_retrying', 'string'], 'completion');
  });

  await check('[d7] estado: ventana larga (72 h) agotada con transitorios → excepción explícita package_transient_exhausted + retry_package con motivo; 3 BLOCKER deterministas → package_attempts_exhausted (tope de siempre)', async () => {
    const st = await AP.loadAutoPackageState(qOf([jobRow(hAgo(2), true, 1)]), runOf(hAgo(73)), NOW, ON, 3);
    eq([st.autoRetryPending, st.attentionReason], [false, AP.PACKAGE_TRANSIENT_EXHAUSTED], 'agotado');
    const c = completionWith(st);
    eq([c.state, c.adminActions, c.packageJob.attentionReason], ['needs_attention', [{ code: 'retry_package', reason: 'package_transient_exhausted' }], 'package_transient_exhausted'], 'completion');
    const hard = await AP.loadAutoPackageState(qOf([1, 2, 3].map((i) => jobRow(hAgo(5 - i), false, i))), runOf(hAgo(6)), NOW, ON, 3);
    eq([hard.autoRetryPending, hard.hardFailedSinceMark, hard.attentionReason], [false, 3, AP.PACKAGE_ATTEMPTS_EXHAUSTED], 'deterministas');
    // Jobs anteriores a r62 (sin output_summary.failure) cuentan como antes (no transitorios).
    const old = await AP.loadAutoPackageState(qOf([1, 2, 3].map((i) => jobRow(hAgo(5 - i), null, i))), runOf(hAgo(6)), NOW, ON, 3);
    eq([old.autoRetryPending, old.hardFailedSinceMark], [false, 3], 'jobs viejos sin registro: tope de siempre');
    // Transitorio de ensure (sin job): sin tope de rondas, espera creciente.
    const tr = await AP.loadAutoPackageState(qOf([]), runOf(hAgo(10), { count: 9, at: sAgo(4000).toISOString() }), NOW, ON, 3);
    eq([tr.status, tr.autoRetryPending, tr.alert], ['none', false, null], 'marca vieja sin `unclassified`: cuenta como NO clasificado → agotado en 5 (c10)');
    const trA = await AP.loadAutoPackageState(qOf([]), runOf(hAgo(10), { count: 9, unclassified: 0, at: sAgo(4000).toISOString() }), NOW, ON, 3);
    eq([trA.status, trA.autoRetryPending, trA.alert], ['none', true, AP.PACKAGE_TRANSIENT_RETRYING_ALERT], 'ensure: 9 transitorios A siguen pendientes (antes: agotado en 5)');
    const trU = await AP.loadAutoPackageState(qOf([]), runOf(hAgo(10), { count: 9, unclassified: 5, at: sAgo(4000).toISOString() }), NOW, ON, 3);
    eq([trU.autoRetryPending, trU.attentionReason], [false, AP.PACKAGE_ATTEMPTS_EXHAUSTED], 'ensure: 5 sin clasificar → tope de siempre');
  });

  await check('[d7 + d6/M1] SQL real (PG16 desechable, LC_ALL=C): barrido ≡ estado (espera creciente; 6 transitorios siguen; 3 deterministas o > 72 h no) y gate global de cuota de YouTube + turno FIFO', async () => {
    const pgBin = findPgBin();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r62P-pg-'));
    const port = await freePort();
    // r62 review M4: PG16 en macOS aborta («postmaster became multithreaded») sin un locale C.
    const pgEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' };
    const pg = (bin, args) => spawnSync(path.join(pgBin, bin), args, { encoding: 'utf8', env: pgEnv });
    let started = false;
    const { Client } = require('pg');
    let c = null;
    try {
      const init = pg('initdb', ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
      assert(init.status === 0, `initdb: ${init.stderr}`);
      const st = pg('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, '-w', 'start', '-l', path.join(dataDir, 'log')]);
      assert(st.status === 0, `pg_ctl start: ${st.stderr}`);
      started = true;
      c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
      await c.connect();
      await c.query(`create table public.course_generation_manifests (id bigserial primary key, rules_version int)`);
      await c.query(`create table public.production_jobs (id uuid primary key default gen_random_uuid(), execution_mode text, status text, worker_status text,
        input_payload jsonb default '{}'::jsonb, output_summary jsonb default '{}'::jsonb, created_at timestamptz default now(), finished_at timestamptz, updated_at timestamptz default now())`);
      const q = { query: async (sql, params) => (await c.query(sql, params)).rows };
      const [m] = await q.query(`insert into public.course_generation_manifests (rules_version) values (3) returning id`);
      const mkRun = async (eligibleH) => (await q.query(`insert into public.production_jobs (execution_mode, status, worker_status, input_payload, output_summary)
        values ('dynamic_generation', 'completed', 'completed', $1::jsonb, $2::jsonb) returning id`,
        [JSON.stringify({ manifestId: m.id }), JSON.stringify({ autoPackage: { eligibleAt: hAgo(eligibleH).toISOString() } })]))[0].id;
      const mkFail = (runId, finishedSecAgo, transient) => q.query(`insert into public.production_jobs (execution_mode, status, worker_status, input_payload, output_summary, created_at, finished_at, updated_at)
        values ('dynamic_package', 'failed', 'failed', $1::jsonb, $2::jsonb, now() - make_interval(secs => $3::int + 30), now() - make_interval(secs => $3::int), now() - make_interval(secs => $3::int))`,
        [JSON.stringify({ runId }), JSON.stringify(transient === null ? {} : { failure: { class: transient ? 'A' : 'D', transient } }), finishedSecAgo]);
      const sel = async () => new Set(await AP.findAutoPackageCandidates(q, new Date(), 50, ON));
      // A: 6 transitorios, el último hace 1000 s (espera 1920 s) → todavía no; hace 2000 s → sí.
      const A = await mkRun(20);
      for (let i = 0; i < 5; i++) await mkFail(A, 60_000 - i * 1000, true);
      await mkFail(A, 1000, true);
      // B: 3 deterministas → nunca. Bv: 3 viejos sin registro → nunca. C: transitorio con marca de hace 73 h → nunca.
      const B = await mkRun(5);
      for (let i = 0; i < 3; i++) await mkFail(B, 10_000 - i * 1000, false);
      const Bv = await mkRun(5);
      for (let i = 0; i < 3; i++) await mkFail(Bv, 10_000 - i * 1000, null);
      const C = await mkRun(73);
      await mkFail(C, 7200, true);
      let s = await sel();
      eq([s.has(A), s.has(B), s.has(Bv), s.has(C)], [false, false, false, false], 'dentro de la espera / agotados');
      const stA = await AP.loadAutoPackageState(q, (await q.query(`select * from public.production_jobs where id = $1`, [A]))[0], new Date(), ON, 3);
      eq([stA.autoRetryPending, stA.transientFailedSinceMark], [true, 6], 'estado de A: pendiente');
      await q.query(`update public.production_jobs set finished_at = now() - interval '2000 seconds', updated_at = now() - interval '2000 seconds'
        where input_payload->>'runId' = $1 and finished_at > now() - interval '1500 seconds'`, [A]);
      s = await sel();
      eq([s.has(A), s.has(B), s.has(Bv), s.has(C)], [true, false, false, false], 'pasada la espera creciente: A sí');
      for (const id of [B, Bv, C]) {
        const st = await AP.loadAutoPackageState(q, (await q.query(`select * from public.production_jobs where id = $1`, [id]))[0], new Date(), ON, 3);
        eq(st.autoRetryPending, false, `estado ≡ SQL (${id === C ? 'C' : 'B'})`);
      }
      // ── r62 review M1: gate GLOBAL de cuota de YouTube y turno FIFO, con el SQL real del worker ──
      await c.query(`create table public.generation_item_runs (id uuid primary key default gen_random_uuid(), type text, status text, output_summary jsonb default '{}'::jsonb)`);
      const ds = { query: async (sql, params) => (await c.query(sql, params)).rows };
      eq(await IW.youtubeQuotaGateUntil(ds, new Date()), null, 'sin marcas: gate abierto');
      const future = new Date(Date.now() + 5 * 3600 * 1000);
      const ins = async (status, os) => (await c.query(`insert into public.generation_item_runs (type, status, output_summary) values ('video', $1, $2::jsonb) returning id`, [status, JSON.stringify(os)])).rows[0].id;
      const v1 = await ins('retrying', { delivery: 'blocked_quota', youtubeQuotaSince: hAgo(5).toISOString(), youtubeQuotaBlockedUntil: future.toISOString() });
      const v2 = await ins('retrying', { delivery: 'blocked_quota', youtubeQuotaSince: hAgo(3).toISOString(), youtubeQuotaBlockedUntil: future.toISOString() });
      await ins('completed', { delivery: 'completed', youtubeQuotaBlockedUntil: new Date(Date.now() + 99 * 3600 * 1000).toISOString() }); // cerrado: no cuenta
      await ins('retrying', { delivery: 'blocked_quota', youtubeQuotaBlockedUntil: 'basura' }); // marca inválida: ignorada
      eq((await IW.youtubeQuotaGateUntil(ds, new Date())).toISOString(), future.toISOString(), 'gate = marca más lejana de un video abierto (de cualquier curso)');
      eq(await IW.youtubeQuotaGateUntil(ds, new Date(future.getTime() + 1000)), null, 'vencido → abierto');
      eq([await IW.youtubeQuotaQueueRank(ds, v1, hAgo(5).toISOString()), await IW.youtubeQuotaQueueRank(ds, v2, hAgo(3).toISOString()),
        await IW.youtubeQuotaQueueRank(ds, '00000000-0000-4000-8000-000000000000', NOW.toISOString())], [0, 1, 2], 'turno FIFO por llegada (el nuevo, al final)');
    } finally {
      try { if (c) await c.end(); } catch {}
      if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  console.log('\n=== [K4] re-verificación del paquete existente con Storage caído ===');

  await check('[K4] Storage 503 al descargar el candidato → el job reconstruye en una ruta NUEVA (<clave>.<sha16>.mbz) y completa; ningún upload a la ruta referenciada', async () => {
    const h = reuse.sourceIdsHash(DYNAMIC_MBZ_BUILDER_VERSION, ['aaaa', 'bbbb']);
    const canonical = `owner-1/dynamic/fc-1/1/dynamic_mbz/run-1/${h}.mbz`;
    const row = { id: 'old', storageBucket: 'cursia-artifacts', storagePath: canonical, checksumSha256: sha(Buffer.from('delivered')),
      metadata: { runId: 'run-1', manifestId: 1, sourceIdsHash: h, builderVersion: DYNAMIC_MBZ_BUILDER_VERSION } };
    const ds = fakeDataSource();
    const lg = logger();
    const bytes = Buffer.from('mbz-bytes-rebuild-k4');
    const { deps, uploads, built } = workerDeps(ds, { existing: [row], downloadThrows: new Error('Supabase Storage download failed: 503 unavailable'),
      referenced: [`cursia-artifacts/${canonical}`], logger: lg, bytes });
    await W.processItem(deps, JOB('job-k4'));
    eq([ds.state.failed.length, ds.state.completed.length, built.length, uploads.length], [0, 1, 1, 1], 'completa con un rebuild');
    eq(uploads[0].storagePath, RV.rebuildDynamicMbzPath(canonical, sha(bytes)), 'ruta nueva');
    assert(uploads[0].storagePath !== canonical && uploads[0].upsert === false, 'nunca la ruta referenciada, upsert:false');
    eq(ds.state.completed[0].summary.reused, false, 'no reutilizado');
    assert(lg.calls.warn.some((m) => /^PACKAGE_REUSE_VERIFY_UNAVAILABLE:/.test(m)), 'aviso en el log');
    // r62 review M3: el row nuevo es reutilizable en el próximo job: checksum = validatedSha256 = sha(bytes subidos), ruta variante.
    eq(sha(uploads[0].buffer), sha(bytes), 'bytes subidos = build');
    const newRow = { id: 'artifact-1', storageBucket: 'cursia-artifacts', storagePath: uploads[0].storagePath, checksumSha256: sha(uploads[0].buffer),
      metadata: { ...uploads[0].metadata, validatedSha256: sha(uploads[0].buffer) } };
    const EXP = { ownerId: 'owner-1', courseId: 'fc-1', manifestId: 1, runId: 'run-1', sourceIdsHash: h, qa: false };
    eq(await RV.verifyReusableDynamicMbz({ downloadStorageObject: async () => uploads[0].buffer }, newRow, EXP, { requireValidated: true }), { ok: true }, 'row nuevo verificable (v3: validatedSha256 = checksum)');
    eq(await RV.verifyReusableDynamicMbz({ downloadStorageObject: async () => uploads[0].buffer }, { ...newRow, metadata: { ...newRow.metadata, validatedSha256: 'f'.repeat(64) } }, EXP, { requireValidated: true }),
      { ok: false, reason: 'not_validated' }, 'sin validatedSha256 igual al checksum no se reutiliza');
    // v3: el upload del rebuild escribe validatedSha256 = sha256Hex(built.mbz), los mismos bytes que sube (código compilado).
    const wsrc = fs.readFileSync(path.join(distRoot, 'workers/dynamic-package-worker.js'), 'utf8');
    assert(/buffer: built\.mbz,[\s\S]{0,6000}validatedSha256: \(0, artifacts_service_[0-9]+\.sha256Hex\)\(built\.mbz\)/.test(wsrc), 'v3: validatedSha256 de los bytes subidos');
  });

  console.log('\n=== [d6] cuota de YouTube: espera larga con alerta, sin retry manual a las 24 h ===');

  await check('[d6] defaults: espera 7 días, alerta 24 h; vista blocked_quota con alerta y sin acción; agotada → youtube_quota_exhausted D/config/resolve_youtube, no reabierto por el auto-healer; el paquete v3 exige el video en YouTube', async () => {
    eq([IW.YOUTUBE_QUOTA_MAX_WAIT_DEFAULT_SECONDS, IW.YOUTUBE_QUOTA_ALERT_DEFAULT_SECONDS, IW.YOUTUBE_QUOTA_EXHAUSTED], [604800, 86400, 'youtube_quota_exhausted'], 'defaults');
    const src = fs.readFileSync(path.join(REPO, 'src/workers/dynamic-item-worker.ts'), 'utf8');
    assert(/DYNAMIC_YOUTUBE_QUOTA_MAX_WAIT_SECONDS', YOUTUBE_QUOTA_MAX_WAIT_DEFAULT_SECONDS/.test(src) && /DYNAMIC_YOUTUBE_QUOTA_ALERT_SECONDS', YOUTUBE_QUOTA_ALERT_DEFAULT_SECONDS/.test(src), 'bootstrap usa los defaults');
    for (const f of ['.github/workflows/deploy-staging.yml', '.github/workflows/deploy.yml']) {
      assert(!/DYNAMIC_YOUTUBE_QUOTA_MAX_WAIT_SECONDS/.test(fs.readFileSync(path.join(REPO, f), 'utf8')), `${f} no pisa la espera`);
    }
    const os1 = { delivery: 'blocked_quota', youtubeQuotaSince: hAgo(30).toISOString(), youtubeQuotaAlertAt: hAgo(6).toISOString(), external: { videogenJobId: 'vg' } };
    const v = D.deliveryViewOf({ strategy: 'youtube', itemStatus: 'retrying', error: 'youtube_blocked_quota: x', outputSummary: os1, nextRetryAt: NOW });
    eq([v.state, v.actions, v.alert.code, v.costKind], ['blocked_quota', [], 'youtube_quota_long_wait', null], 'espera con alerta');
    const err = 'youtube_quota_exhausted: YouTube siguió sin permitir subidas durante 7 días (cuota agotada).';
    const fv = FC.classifyFailure({ error: err, itemType: 'video', source: 'video_worker' });
    eq([fv.class, fv.humanReason, fv.adminAction, fv.unclassified], ['D', 'config', 'resolve_youtube', false], 'excepción clasificada');
    const osx = { delivery: 'upload_failed', external: { videogenJobId: 'vg' }, youtubeQuotaExhaustedAt: NOW.toISOString() };
    const d = AH.autoHealDecision({ id: 'v1', status: 'failed', type: 'video', error: err, output_summary: osx, finished_at: hAgo(1), failure_class: 'D' }, NOW, AH.autoHealPolicyFromEnv({}));
    eq(d.heal, false, 'el auto-healer no la reabre en silencio');
    eq(D.deliveryViewOf({ strategy: 'youtube', itemStatus: 'failed', error: err, outputSummary: osx }).actions, ['retry_upload'], 'acción: solo re-subir (costo 0)');
    eq(PV3.V3_VIDEO_REQUIRES_YOUTUBE, 'v3_video_requires_youtube', 'el paquete final v3 sigue exigiendo cada video en YouTube (sin YouTube solo un QA/degradado de admin)');
  });

  console.log('\n=== [d14] retención de empaque por defecto (modo fábrica) ===');

  await check('[d14] DYNAMIC_DEFAULT_HOLD_PACKAGING_OWNERS: default vacío → ningún run retenido; ningún deploy la escribe (staging solo avisa); definida → la herramienta sigue funcionando', async () => {
    const owner = '11111111-2222-4333-8444-555555555555';
    eq([SA.defaultHoldPackagingFor(owner, {}), JSON.stringify(SA.initialRunOutputSummary(owner, {}, {}))], [false, '{}'], 'default: sin retención');
    for (const f of ['.github/workflows/deploy-staging.yml', '.github/workflows/deploy.yml']) {
      const y = fs.readFileSync(path.join(REPO, f), 'utf8');
      assert(!/ensure_env_[a-z_]+\s+DYNAMIC_DEFAULT_HOLD_PACKAGING_OWNERS/.test(y) && !/DYNAMIC_DEFAULT_HOLD_PACKAGING_OWNERS=\S/.test(y.replace(/\^DYNAMIC_DEFAULT_HOLD_PACKAGING_OWNERS=\.\+/g, '')), `${f}: no la define`);
    }
    assert(/⚠ DYNAMIC_DEFAULT_HOLD_PACKAGING_OWNERS definido en el \.env de staging/.test(fs.readFileSync(path.join(REPO, '.github/workflows/deploy-staging.yml'), 'utf8')), 'staging avisa si está definida a mano');
    const out = SA.initialRunOutputSummary(owner, {}, { DYNAMIC_DEFAULT_HOLD_PACKAGING_OWNERS: owner });
    eq([out.stopAfter.holdPackaging, out.stopAfter.setBy], [true, SA.DEFAULT_HOLD_PACKAGING_SET_BY], 'modo fábrica intacto');
  });

  console.log('\n=== [K5] hold persistente de workers visible en el run ===');

  await check('[K5] DYNAMIC_WORKERS_HOLD=true → RunDto.workersHold con estado y motivo (y las partes que esperan); sin hold → null; worker de proveedores apagado solo si afecta al run', async () => {
    const rows = [
      { item_key: 'presentation:c1', type: 'presentation', status: 'queued' },
      { item_key: 'audio_welcome', type: 'audio_welcome', status: 'completed' },
      { item_key: 'content:c1', type: 'content', status: 'pending' },
    ];
    const v = WH.workersHoldViewOf(rows, { DYNAMIC_WORKERS_HOLD: 'true', DYNAMIC_PROVIDER_WORKER_ENABLED: 'false' });
    eq([v.state, v.reason, v.env, v.affectedItemKeys, v.resolution], ['held', 'worker_off_persistent', 'DYNAMIC_WORKERS_HOLD=true', ['presentation:c1'], 'worker_on'], 'hold visible');
    eq(WH.workersHoldViewOf(rows, { DYNAMIC_PROVIDER_WORKER_ENABLED: 'true' }), null, 'sin hold');
    eq(WH.workersHoldViewOf(rows, {}).reason, 'provider_worker_disabled', 'worker apagado con partes abiertas');
    eq(WH.workersHoldViewOf([{ item_key: 'content:c1', type: 'content', status: 'pending' }], {}), null, 'apagado sin partes de proveedor: no afecta');
    const dist = fs.readFileSync(path.join(distRoot, 'modules/dynamic-generation/runs.service.js'), 'utf8');
    assert(/workersHold: \(0, workers_hold_1\.workersHoldViewOf\)\(rows, process\.env, \{ runOpen:/.test(dist), 'RunDto.workersHold cableado en buildRunDto');
    eq(WH.workersHoldViewOf([], { DYNAMIC_WORKERS_HOLD: 'true' }, { runOpen: false }), null, 'run terminado sin partes esperando: sin ruido');
    // r62 review M2: al dueño (no SUPER_ADMIN) solo estado + motivo genérico: ni variables ni procesos.
    const OSR = L('modules/dynamic-generation/owner-safe-run.interceptor.js');
    const red = OSR.redactRunPayloadForOwner({ run: { id: 'r', workersHold: v } });
    eq(Object.keys(red.run.workersHold).sort(), ['affectedItemKeys', 'message', 'reason', 'state'], 'campos del dueño');
    eq([red.run.workersHold.state, red.run.workersHold.reason, red.run.workersHold.affectedItemKeys], ['held', 'server_workers_paused', ['presentation:c1']], 'estado y motivo genérico');
    const txt = JSON.stringify(red);
    assert(!/DYNAMIC_|worker_on|dynamic-provider-worker|dynamic-llm-worker|pm2/.test(txt), 'sin nombres de variables ni de procesos: ' + txt);
    eq(OSR.redactRunPayloadForOwner({ workersHold: null }).workersHold, null, 'null intacto');
  });

  console.log(`\n${passes} ✅ · ${failures} ❌`);
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('❌ fatal', err); process.exit(1); });
