#!/usr/bin/env node
/* eslint-disable */
// r83 (incidente curso 91, 2026-11-02) — Supabase Storage caído: reintentos de subida, error tipado, clasificación,
// breaker de infraestructura y punto de guardado del worker de IA. Contra el código COMPILADO en dist/.
// USD 0: Storage FALSO (global.fetch interceptado), Anthropic falso en 127.0.0.1, Postgres 16 local DESCARTABLE.
// Nunca hay red externa (cualquier fetch fuera de 127.0.0.1 / el Storage falso → error).
//
// Parte pura (--pure-only):
//   S1  reintento: 504 (HTML) ×3 → 200 → ok en el 4.º intento, backoff exponencial con jitter, ambiguousBefore
//   S2  agotado: StorageUnavailableError (code storage_unavailable, status 504), mensaje corto SIN HTML, presupuesto respetado
//   S3  4xx determinista (403/404/413) → nunca se reintenta; timeout / error de red → se reintenta (mensaje «timeout»)
//   S4  ArtifactsService: putStorageObject/uploadJsonArtifact sobreviven a 504 ×N y luego suben; agotados → error tipado sin
//       HTML y SIN fila en artifacts; un 4xx sigue siendo el error de siempre (cuerpo saneado)
//   S5  adopt-on-exists: 504 ambiguo (el objeto SÍ quedó escrito) → «already exists» → se adopta solo con el MISMO sha256;
//       bytes distintos → error de siempre (nunca se adopta)
//   S6  clasificador: unexpected_error/no se pudo subir el artifact + storage_unavailable → A `storage_unavailable`
//       wait_provider (nunca reconciliación ni humano); en el empaque → package_transient; reconciliación no se toca
//   S7  breaker puro: umbral/ventana, sonda 30→300 s con jitter; racha de esperas gratis por item con tope
//   S8  punto de guardado del worker de IA: Storage caído al guardar → guardado EN LA BASE (inline); el reintento
//       responde desde ahí: 1 pedido a Anthropic en total (antes: re-pagaba)
// Parte DB (PG16 descartable):
//   D1  migración r83 aditiva e idempotente (dos veces), RLS sin acceso para anon/authenticated; el script se niega sin
//       MIGRATION_ENV=staging
//   D2  failItem de un worker del SERVIDOR con storage_unavailable en el ÚLTIMO intento → retrying sin consumir intento
//       (attempt_count igual, max_attempts + 1), storageOutage.grants=1; el mismo mensaje sin storage → failed (consume)
//   D3  ArtifactsService real: 504 permanente → StorageUnavailableError registrado en infra_health; 2 fallos → ABIERTO
//   D4  abierto: el claim de los workers devuelve {item:null, reason:'storage_unavailable'} sin tocar intentos; un fallo
//       en vuelo espera hasta la sonda (next_retry_at ≈ next_probe_at); claimNext del empaque no reclama
//   D5  sonda vencida + Storage sigue caído → hold, probe_round+1, próxima sonda ~60 s; una sola sonda por vencimiento
//   D6  sonda OK → CERRADO, items retenidos liberados (next_retry_at ≤ now), los claims vuelven a repartir
//   D7  sin la tabla → todo no-op (gate deja pasar, registrar no lanza); storageBreakerNextProbe → null (F1)
//   D8  (review F1) sin la tabla → failItem con storage_unavailable consume el intento como antes de r83
//   S9  (review P1-1) guardado existente + Storage caído al leerlo → espera de Storage sin re-pagar
//
// Uso: npm run build && node scripts/check-r83-storage.js [--pure-only] [path/to/dist]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
const REPO = path.resolve(__dirname, '..');
const DIST = path.resolve(process.cwd(), args.find((a) => !a.startsWith('--')) || 'dist');
const D = (rel) => {
  try { return require(path.join(DIST, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿corriste "npm run build"?): ${e.message}`); process.exit(1); }
};
require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const LOGS = [];
Logger.overrideLogger({ log: (m) => LOGS.push(String(m)), warn: (m) => LOGS.push(String(m)), error: (m) => LOGS.push(String(m)), debug: () => {}, verbose: () => {} });

let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n   ')}`); }
}
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
async function caught(p) { try { await p; } catch (e) { return e; } throw new Error('se esperaba un error'); }

const SR = D('modules/artifacts/storage-resilience.js');
const SB = D('modules/reliability/storage-breaker.js');
const FC = D('modules/reliability/failure-classifier.js');
const { ArtifactsService } = D('modules/artifacts/artifacts.service.js');
const SL = D('workers/llm-executor/server-llm.js');

// ─── Storage FALSO (global.fetch) ───────────────────────────────────────────────────────────────────────────────
const SUPA = 'https://fake-supabase.invalid';
const GATEWAY_HTML = '<!DOCTYPE html><html><head><title>504 Gateway Time-out</title><style>body{x}</style></head><body><h1>504 Gateway Time-out</h1><hr><center>cloudflare</center>' + 'x'.repeat(3000) + '</body></html>';
const storage = {
  objects: new Map(), // path → Buffer
  calls: [],
  /** (req) → Response | 'write+504' | null (null = comportamiento normal). */
  script: null,
  reset() { this.objects.clear(); this.calls = []; this.script = null; },
};
const realFetch = global.fetch;
function resp(status, body, headers = {}) { return new Response(body, { status, headers }); }
global.fetch = async (u, o = {}) => {
  const url = String(u);
  if (/^http:\/\/127\.0\.0\.1:\d+/.test(url)) return realFetch(u, o);
  if (!url.startsWith(SUPA)) throw new Error(`NETWORK FORBIDDEN in check: ${url}`);
  const method = (o.method || 'GET').toUpperCase();
  const m = /\/storage\/v1\/object\/(?:authenticated\/)?([^/]+)\/(.+)$/.exec(url);
  const key = m ? `${m[1]}/${decodeURIComponent(m[2])}` : url;
  const req = { method, key, url, upsert: o.headers && o.headers['x-upsert'], body: o.body };
  storage.calls.push(req);
  if (o.signal && o.signal.aborted) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const scripted = storage.script ? await storage.script(req, storage.calls.length) : null;
  if (scripted === 'write+504') { storage.objects.set(key, Buffer.from(o.body)); return resp(504, GATEWAY_HTML, { 'content-type': 'text/html' }); }
  if (scripted instanceof Error) throw scripted;
  if (scripted) return scripted;
  if (method === 'POST') {
    if (req.upsert === 'false' && storage.objects.has(key)) return resp(400, JSON.stringify({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }));
    storage.objects.set(key, Buffer.from(o.body));
    return resp(200, JSON.stringify({ Key: key }));
  }
  if (method === 'GET') return storage.objects.has(key) ? resp(200, storage.objects.get(key)) : resp(400, JSON.stringify({ statusCode: '404', error: 'not_found' }));
  if (method === 'HEAD') return storage.objects.has(key) ? resp(200, null, { 'content-length': String(storage.objects.get(key).length) }) : resp(404, null);
  if (method === 'DELETE') { storage.objects.delete(key); return resp(200, '{}'); }
  return resp(405, 'no');
};

const FAST = { STORAGE_RETRY_BASE_MS: '2', STORAGE_RETRY_MAX_DELAY_MS: '10', STORAGE_RETRY_BUDGET_MS: '1500', STORAGE_ATTEMPT_TIMEOUT_MS: '1000', STORAGE_RETRY_MAX_ATTEMPTS: '8' };
const ENV = { SUPABASE_URL: SUPA, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key-never-sent', ...FAST };
for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
const OWNER = '11111111-2222-4333-8444-555555555555';
const fakeRepo = () => {
  const rows = [];
  return { rows, create: (x) => ({ ...x }), save: async (x) => { const r = { id: `art-${rows.length + 1}`, ...x }; rows.push(r); return r; }, count: async () => 0 };
};
const svcOf = (repo = fakeRepo()) => ({ repo, svc: new ArtifactsService(repo, { get: (k) => ENV[k] }) });
const noHtml = (s) => !/[<>]/.test(String(s)) && !/DOCTYPE|Gateway Time-out|cloudflare/i.test(String(s));

// ─── Anthropic FALSO (S8) ───────────────────────────────────────────────────────────────────────────────────────
const sse = (t, o) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...o })}\n\n`;
async function fakeAnthropic() {
  const st = { requests: 0 };
  const srv = http.createServer(async (req, res) => {
    for await (const _ of req) { /* body */ }
    const n = ++st.requests;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { message: { id: `msg_${n}`, model: 'm', usage: { input_tokens: 10, output_tokens: 1 } } }));
    res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `RESPUESTA-${n}` } }));
    res.write(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }));
    res.end(sse('message_stop', {}));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, st, close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => r()); }) };
}
const like = (pat) => new RegExp('^' + pat.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.')).join('.*') + '$');
/** Mismo contrato SQL que el worker de IA (copia mínima del mundo de check-r61-lease-takeover-no-repay). */
function llmWorld(putImpl) {
  const w = { cps: {}, sent: {}, store: new Map(), res: new Map(), finals: [] };
  w.ds = {
    async query(sql, params) {
      if (sql.includes('as remaining_ms')) return [{ remaining_ms: 0 }];
      if (sql.includes('select now() as db_now')) return [{ db_now: new Date().toISOString() }];
      if (sql.includes('count(*)::int as n')) return [{ n: 0 }];
      if (sql.includes('e.idempotency_key as key, e.amount::text as amount')) return [];
      if (sql.includes("'{llmSent}'")) { w.sent[params[2]] = params[3]; return [{ id: params[0] }]; }
      if (sql.includes('generation_item_runs')) return [{ since: new Date(0).toISOString(), cps: JSON.parse(JSON.stringify(w.cps)), sent: { ...w.sent } }];
      throw new Error('SQL inesperado: ' + sql.slice(0, 80));
    },
  };
  w.finops = {
    async recordCharge(i) { w.res.set(i.idempotencyKey, { tag: i.metadata.callTag, settled: false, at: Date.now() }); return {}; },
    async recordAdjustment() { return {}; }, async recordZero() { return {}; },
    async reconcileReservationAsCharged() { return { reconciled: false, alreadySettled: true, amount: '0', event: null }; },
    async settleReservation(key, charge, reason) { const r = w.res.get(key); r.settled = true; r.reason = reason; if (charge) w.finals.push(key); return { finalInserted: !!charge, finalEvent: null }; },
  };
  w.budget = { guardServerLlmCall: async () => null, ambiguousResendBudget: async () => ({ fits: true, reason: null, worstItem: 0, worstRun: 0 }), pauseRunBySystem: async () => true };
  w.warns = [];
  w.api = (url, attempt) => SL.createServerApi({
    dataSource: w.ds, finops: w.finops, budget: w.budget,
    checkpoints: { put: async (p, j) => putImpl(w, p, j), get: async (p) => { if (w.getImpl) return w.getImpl(p); if (!w.store.has(p)) throw new Error('Supabase Storage download failed: 400 not found'); return w.store.get(p); } },
    recordCheckpoint: async (_id, e) => { Object.assign(w.cps, JSON.parse(JSON.stringify(e))); return true; },
    priorInFlightWindowMs: 0,
    apiKey: 'k', baseUrl: url, defaultModel: 'm', idleMs: 3000, totalMs: 10000,
    logger: { log() {}, warn(m) { w.warns.push(String(m)); }, error() {} }, settleRetryDelaysMs: [0, 0],
  }, { itemRunId: '11111111-2222-4333-8444-555555555555', runId: '99999999-2222-4333-8444-555555555555', itemKey: 'video_interactions:x', generation: 1, ownerId: OWNER, artifactCourseId: '7', manifestId: 3, attempt },
  () => ({ callRole: 'main', attempt }));
  return w;
}

async function pureChecks() {
  const policy = SR.storageRetryPolicyFromEnv((k) => ENV[k]);

  await check('S1 reintento: 504 (HTML) ×3 → 200 → ok en el 4.º intento, backoff exponencial con jitter, ambiguousBefore=true', async () => {
    let n = 0;
    const sleeps = [];
    const r = await SR.storageRequestWithRetry(async () => (++n <= 3 ? resp(504, GATEWAY_HTML) : resp(200, 'ok')), {
      op: 'upload', policy: { ...SR.DEFAULT_STORAGE_RETRY_POLICY }, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5,
    });
    eq([r.response.status, r.attempts, r.ambiguousBefore], [200, 4, true], 'resultado');
    eq(sleeps, [1000, 2000, 4000], 'backoff 1 s, 2 s, 4 s (jitter centrado)');
    const j = [0, 1].map((x) => SR.storageRetryDelayMs(1, SR.DEFAULT_STORAGE_RETRY_POLICY, () => x));
    eq(j, [800, 1200], 'jitter ±20 %');
    eq(SR.storageRetryDelayMs(10, SR.DEFAULT_STORAGE_RETRY_POLICY, () => 0.5), 30000, 'tope 30 s');
  });

  await check('S2 agotado: StorageUnavailableError (code, status 504, intentos), mensaje corto SIN HTML, presupuesto ~100 s respetado', async () => {
    let clock = 0;
    let n = 0;
    const e = await caught(SR.storageRequestWithRetry(async () => { n++; clock += 3000; return resp(504, GATEWAY_HTML); }, {
      op: 'upload', policy: { ...SR.DEFAULT_STORAGE_RETRY_POLICY }, sleep: async (ms) => { clock += ms; }, now: () => clock, random: () => 0.5,
    }));
    assert(e instanceof SR.StorageUnavailableError && SR.isStorageUnavailableError(e), 'tipo');
    eq([e.code, e.status, e.attempts, e.op], ['storage_unavailable', 504, n, 'upload'], 'campos');
    assert(clock <= 100_000 + 3000, `presupuesto: ${clock} ms`);
    assert(n >= 5, `varios intentos (${n})`);
    assert(noHtml(e.message) && e.message.length < 120, `sin HTML: ${e.message}`);
    assert(/^storage_unavailable: Supabase Storage upload failed: 504 \(\d+ intentos, \d+ s\)$/.test(e.message), e.message);
    assert(SR.isStorageUnavailableMessage(`unexpected_error: ${e.message}`), 'reconocible detrás del envoltorio');
    eq(SR.sanitizeStorageErrorText(GATEWAY_HTML).length <= 201 && noHtml(SR.sanitizeStorageErrorText(GATEWAY_HTML).replace(/Gateway Time-out|cloudflare/g, '')), true, 'saneador');
  });

  await check('S3 4xx determinista → nunca se reintenta; timeout / red → se reintenta (mensaje «timeout» / «fetch failed»)', async () => {
    for (const st of [400, 403, 404, 413]) {
      let n = 0;
      const r = await SR.storageRequestWithRetry(async () => { n++; return resp(st, '{}'); }, { op: 'upload', policy, sleep: async () => {} });
      eq([r.response.status, n, r.ambiguousBefore], [st, 1, false], `status ${st}`);
    }
    for (const s of [429, 500, 502, 503, 504, 524, 408]) assert(SR.isRetryableStorageStatus(s), `${s} reintentable`);
    let n = 0;
    const e = await caught(SR.storageRequestWithRetry(async () => { n++; throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }, { op: 'download', policy, sleep: async () => {} }));
    assert(n > 1 && e.status === null && /download failed: timeout/.test(e.message), `timeout: ${n} ${e.message}`);
    const e2 = await caught(SR.storageRequestWithRetry(async () => { throw new TypeError('fetch failed'); }, { op: 'upload', policy, sleep: async () => {} }));
    assert(/upload failed: fetch failed/.test(e2.message), e2.message);
    let n3 = 0;
    const r3 = await SR.storageRequestWithRetry(async () => (++n3 === 1 ? Promise.reject(new TypeError('fetch failed')) : resp(200, 'ok')), { op: 'upload', policy, sleep: async () => {} });
    eq([r3.response.status, r3.attempts, r3.ambiguousBefore], [200, 2, true], 'red → ok');
  });

  await check('S4 ArtifactsService: 504 ×N y luego sube (put + JSON); agotado → error tipado sin HTML y SIN fila; 4xx = error de siempre con cuerpo saneado', async () => {
    storage.reset();
    let fails = 3;
    storage.script = (req) => (req.method === 'POST' && fails-- > 0 ? resp(504, GATEWAY_HTML) : null);
    const { svc, repo } = svcOf();
    const p = `${OWNER}/dynamic/1/2/dynamic_audio_mp3/k/seg1.a1.mp3`;
    const r = await svc.putStorageObject({ ownerId: OWNER, storagePath: p, buffer: Buffer.from('MP3DATA'), mimeType: 'audio/mpeg', upsert: false });
    eq([r.adopted, storage.objects.get(`cursia-artifacts/${p}`).toString(), storage.calls.length], [false, 'MP3DATA', 4], 'subido al 4.º intento');
    storage.reset();
    fails = 2;
    storage.script = (req) => (req.method === 'POST' && fails-- > 0 ? resp(503, GATEWAY_HTML) : null);
    const a = await svc.uploadJsonArtifact({ ownerId: OWNER, type: 'dynamic_video', filename: 'v.json', storagePath: `${OWNER}/dynamic/1/2/dynamic_video/k/a1.json`, payload: { ok: 1 } });
    eq([a.id, repo.rows.length], ['art-1', 1], 'JSON subido y registrado');
    storage.reset();
    storage.script = (req) => (req.method === 'POST' ? resp(504, GATEWAY_HTML) : null);
    const e = await caught(svc.uploadBufferArtifact({ ownerId: OWNER, type: 'dynamic_video', filename: 'x.bin', storagePath: `${OWNER}/dynamic/1/2/t/k/a2.bin`, buffer: Buffer.from('x'), mimeType: 'application/octet-stream' }));
    assert(SR.isStorageUnavailableError(e) && noHtml(e.message), `error tipado sin HTML: ${e.message}`);
    eq(repo.rows.length, 1, 'sin fila nueva en artifacts');
    assert(storage.calls.length > 2, 'reintentó');
    const e2 = await caught(svc.uploadJsonArtifact({ ownerId: OWNER, type: 'dynamic_video', filename: 'v.json', storagePath: `${OWNER}/dynamic/1/2/dynamic_video/k/a3.json`, payload: {} }));
    assert(SR.isStorageUnavailableError(e2) && noHtml(e2.message), 'JSON: error tipado');
    storage.reset();
    storage.script = (req) => (req.method === 'POST' ? resp(403, '<html><body>new row violates row-level security policy</body></html>') : null);
    const e3 = await caught(svc.putStorageObject({ ownerId: OWNER, storagePath: `${OWNER}/x/y.bin`, buffer: Buffer.from('y'), mimeType: 'application/octet-stream' }));
    eq([SR.isStorageUnavailableError(e3), storage.calls.length], [false, 1], '403 sin reintento ni error tipado');
    assert(/^Supabase Storage upload failed: 403 new row violates row-level security policy$/.test(e3.message), e3.message);
    // Descarga: 503 ×2 → ok; 404 → error de siempre sin reintento.
    storage.reset();
    storage.objects.set('cursia-artifacts/a/b.json', Buffer.from('{"x":1}'));
    let dl = 2;
    storage.script = (req) => (req.method === 'GET' && dl-- > 0 ? resp(503, GATEWAY_HTML) : null);
    eq((await svc.downloadStorageObject('cursia-artifacts', 'a/b.json')).toString(), '{"x":1}', 'descarga tras 503 ×2');
    storage.script = null;
    const n0 = storage.calls.length;
    const e4 = await caught(svc.downloadStorageObject('cursia-artifacts', 'a/missing.json'));
    eq([/download failed: 400/.test(e4.message), storage.calls.length - n0], [true, 1], '4xx de descarga sin reintento');
  });

  await check('S5 adopt-on-exists: 504 ambiguo que SÍ escribió → «already exists» → se adopta con el MISMO sha256; bytes distintos → error de siempre', async () => {
    storage.reset();
    const p = `${OWNER}/dynamic/1/2/dynamic_audio_mp3/k/seg2.a1.mp3`;
    let first = true;
    storage.script = (req) => (req.method === 'POST' && first ? (first = false, 'write+504') : null);
    const { svc } = svcOf();
    const buf = Buffer.from('AUDIO-SEGMENT-BYTES');
    const r = await svc.putStorageObject({ ownerId: OWNER, storagePath: p, buffer: buf, mimeType: 'audio/mpeg', upsert: false });
    eq([r.adopted, r.sha256, r.sizeBytes], [true, D('modules/artifacts/artifacts.service.js').sha256Hex(buf), buf.length], 'adoptado con sha');
    // Bytes DISTINTOS en la ruta (otro intento / otro contenido) → nunca se adopta.
    storage.reset();
    storage.objects.set(`cursia-artifacts/${p}`, Buffer.from('OTROS-BYTES'));
    first = true;
    storage.script = (req) => (req.method === 'POST' && first ? (first = false, resp(504, GATEWAY_HTML)) : null);
    const e = await caught(svc.putStorageObject({ ownerId: OWNER, storagePath: p, buffer: buf, mimeType: 'audio/mpeg', upsert: false }));
    assert(/^Supabase Storage upload failed: 400 /.test(e.message) && noHtml(e.message), e.message);
    eq(storage.objects.get(`cursia-artifacts/${p}`).toString(), 'OTROS-BYTES', 'no se pisa');
    // Sin 5xx previo, «already exists» sigue siendo el error de siempre (sin adopción nueva).
    storage.reset();
    storage.objects.set(`cursia-artifacts/${p}`, buf);
    const e2 = await caught(svc.putStorageObject({ ownerId: OWNER, storagePath: p, buffer: buf, mimeType: 'audio/mpeg', upsert: false }));
    assert(/upload failed: 400/.test(e2.message), 'sin ambigüedad: no se adopta');
    // JSON con upsert:false: mismo patrón.
    storage.reset();
    first = true;
    storage.script = (req) => (req.method === 'POST' && first ? (first = false, 'write+504') : null);
    const a = await svc.uploadJsonArtifact({ ownerId: OWNER, type: 'dynamic_video', filename: 'v.json', storagePath: `${OWNER}/dynamic/1/2/dynamic_video/k/a9.json`, payload: { a: 1 }, upsert: false });
    assert(a && a.id, 'JSON adoptado y registrado');
  });

  await check('S6 clasificador: storage_unavailable detrás de los envoltorios → A wait_provider (storage), nunca C/D; empaque → package_transient; reconciliación intacta', async () => {
    const msg = 'storage_unavailable: Supabase Storage upload failed: 504 (6 intentos, 98 s)';
    for (const [error, source, itemType] of [
      [`unexpected_error: ${msg}`, 'video_worker', 'video'],
      [`unexpected_error: ${msg}`, 'provider_worker', 'presentation'],
      [`no se pudo subir el artifact dynamic_video_interactions_json: ${msg}`, 'server_executor', 'video_interactions'],
      [msg, 'provider_worker', 'audiobook_chapter'],
    ]) {
      const v = FC.classifyFailure({ error, source, itemType });
      eq([v.code, v.class, v.strategy, v.scope, v.provider, v.unclassified], ['storage_unavailable', 'A', 'wait_provider', 'provider', 'storage', false], error.slice(0, 40));
      assert(SR.isStorageUnavailableMessage(error), 'reconocido por el scheduler');
    }
    const pk = FC.classifyFailure({ error: msg, source: 'package_worker' });
    eq([pk.code, pk.class, pk.strategy], ['storage_unavailable', 'A', 'repackage'], 'empaque (código)');
    const pk2 = FC.classifyFailure({ error: 'storage_unavailable: Supabase Storage upload failed: timeout (5 intentos, 99 s)', source: 'package_worker' });
    eq(pk2.class, 'A', 'empaque timeout');
    const rec = 'provider_reconciliation_required: openai — llamada pagada enviada sin resultado liquidado (storage_unavailable: Supabase Storage upload failed: 504 (5 intentos, 90 s))';
    assert(!SR.isStorageUnavailableMessage(rec), 'reconciliación nunca es espera de Storage');
    assert(FC.classifyFailure({ error: rec, source: 'provider_worker', itemType: 'audiobook_chapter' }).code !== 'storage_unavailable', 'la reconciliación sigue con su regla');
    assert(FC.isFailureCodeClassified('storage_unavailable'), 'código con regla explícita');
    // Mensaje legacy con HTML (antes de r83) sigue clasificándose como antes.
    eq(FC.classifyFailure({ error: 'no se pudo subir el artifact x: Supabase Storage upload failed: 504 <html>', source: 'server_executor', itemType: 'content' }).code, 'artifact_upload_failed', 'legacy');
  });

  await check('S7 breaker puro: umbral 2 en la ventana → abierto + sonda a 30 s (+0…20 %); fuera de ventana reinicia; racha gratis por item con tope', async () => {
    const cfg = SB.storageBreakerConfigFromEnv({});
    eq([cfg.enabled, cfg.threshold, cfg.windowSeconds, cfg.maxFreeRetries, cfg.maxHours], [true, 2, 600, 60, 24], 'defaults');
    const t0 = Date.parse('2026-11-02T21:13:00Z');
    const a = SB.breakerAfterFailure(null, t0, cfg, 'x', () => 0);
    eq([a.state, a.failures], ['closed', 1], '1 fallo');
    const b = SB.breakerAfterFailure(a, t0 + 60_000, cfg, 'y', () => 1);
    eq([b.state, b.failures, new Date(b.next_probe_at).getTime() - (t0 + 60_000)], ['open', 2, 36_000], 'abierto, sonda a 30 s × 1,2');
    const c = SB.breakerAfterFailure(a, t0 + 700_000, cfg, 'z', () => 0);
    eq([c.state, c.failures], ['closed', 1], 'fuera de ventana: reinicia');
    const d = SB.breakerAfterFailure(b, t0 + 61_000, cfg, 'w', () => 0);
    eq([d.state, d.next_probe_at], ['open', b.next_probe_at], 'abierto: un fallo más no mueve la sonda');
    eq([0, 1, 2, 3, 4, 9].map((r) => SB.storageProbeWaitSeconds(r, () => 0)), [30, 60, 120, 240, 300, 300], 'esperas de sonda');
    let st = null;
    let grants = 0;
    for (let i = 0; i < 70; i++) { const g = SB.storageOutageGrantDecision(st, t0 + i * 60_000, cfg); if (g.grant) grants++; st = g.next; }
    eq(grants, 60, 'tope de 60 esperas gratis por racha');
    const later = SB.storageOutageGrantDecision(st, t0 + 70 * 60_000 + 2 * 3_600_000, cfg);
    eq([later.grant, later.next.grants], [true, 1], 'una racha nueva (> 1 h después) vuelve a empezar');
    const long = SB.storageOutageGrantDecision({ grants: 3, firstAt: new Date(t0).toISOString(), lastAt: new Date(t0 + 25 * 3_600_000 - 60_000).toISOString() }, t0 + 25 * 3_600_000, cfg);
    eq(long.grant, false, 'tope de 24 h por racha');
    eq(SB.storageOutageGrantDecision(null, t0, { ...cfg, enabled: false }).grant, false, 'kill-switch');
    eq(SB.storageHeldRetryAfterSeconds({ open: true, nextProbeAt: new Date(t0 + 120_000) }, t0), 125, 'espera hasta la sonda');
    eq(SB.storageHeldRetryAfterSeconds({ open: false, nextProbeAt: null }, t0), 60, 'cerrado: 60 s');
  });

  await check('S8 worker de IA: Storage caído al guardar el punto de guardado → guardado EN LA BASE; el reintento responde desde ahí (1 pedido pagado en total)', async () => {
    const a = await fakeAnthropic();
    try {
      const w = llmWorld(async () => { throw new SR.StorageUnavailableError('upload', 504, 6, 98_000); });
      const r1 = await w.api(a.url, 1)('sistema', 'pedido');
      eq([r1, a.st.requests], ['RESPUESTA-1', 1], 'intento 1 paga');
      const entries = Object.values(w.cps);
      eq(entries.length, 1, 'un guardado registrado');
      assert(typeof entries[0].inline === 'string' && JSON.parse(entries[0].inline).text === 'RESPUESTA-1', 'guardado inline');
      assert(w.warns.some((m) => /se guarda en la base/.test(m)), 'aviso');
      const r2 = await w.api(a.url, 2)('sistema', 'pedido');
      eq([r2, a.st.requests, w.finals.length], ['RESPUESTA-1', 1, 1], 'intento 2: desde el guardado, sin volver a pagar');
      // Storage sano: el guardado va a Storage como siempre (sin inline).
      const w2 = llmWorld(async (ww, p, j) => { ww.store.set(p, j); });
      await w2.api(a.url, 1)('sistema', 'otro');
      const e2 = Object.values(w2.cps)[0];
      eq([typeof e2.inline, w2.store.size], ['undefined', 1], 'sin inline con Storage sano');
      // Demasiado grande para la base: se pierde como antes (y se avisa), nunca rompe la llamada.
      process.env.LLM_CHECKPOINT_INLINE_MAX_BYTES = '10';
      const w3 = llmWorld(async () => { throw new SR.StorageUnavailableError('upload', 504, 6, 98_000); });
      eq(await w3.api(a.url, 1)('s', 'grande'), `RESPUESTA-${a.st.requests}`, 'la respuesta se usa igual');
      eq(Object.keys(w3.cps).length, 0, 'sin guardado (tope)');
      delete process.env.LLM_CHECKPOINT_INLINE_MAX_BYTES;
    } finally { await a.close(); }
  });
  await check('S10 (review F3/F6) progressOutputSummary nunca devuelve guardados inline (solo su tamaño); las claves r83 son del servidor', async () => {
    const RS = D('modules/dynamic-generation/runs.service.js');
    const SCH = D('modules/dynamic-generation/scheduler.service.js');
    const big = JSON.stringify({ text: 'x'.repeat(5000), usage: {}, stopReason: 'end_turn' });
    const os0 = { llmCheckpoints: { h1: { path: 'p/h1.json', at: '2026-11-02T20:00:00Z', inline: big }, h2: { path: 'p/h2.json', at: '2026-11-02T20:01:00Z' } }, other: 1 };
    const v = RS.progressOutputSummary(os0);
    eq(Object.keys(v.llmCheckpoints).sort(), ['h1', 'h2'], 'las entradas siguen');
    eq([('inline' in v.llmCheckpoints.h1), v.llmCheckpoints.h1.inlineBytes, v.llmCheckpoints.h2], [false, Buffer.byteLength(big), os0.llmCheckpoints.h2], 'inline fuera, tamaño dentro');
    assert(!JSON.stringify(v).includes('xxxxxxxxxx'), 'sin el texto de la respuesta en el DTO');
    assert(typeof os0.llmCheckpoints.h1.inline === 'string', 'no muta la fila');
    eq(RS.progressOutputSummary({ a: 1 }), { a: 1 }, 'sin guardados: igual');
    for (const k of ['llmUnknownResetAt', 'llmPendingReviewReopen', 'llmTransportEvents', 'ttsUnhealthyHandbacks', 'ttsCuts', 'audioSegmentChars', 'storageOutage', 'llmCheckpoints', 'llmCheckpointsResetAt']) {
      assert(SCH.SERVER_OWNED_SUMMARY_KEYS.includes(k), `${k} es del servidor`);
    }
    const st = SCH.stripServerOwnedSummaryKeys({ ok: 1, llmUnknownResetAt: '2099-01-01T00:00:00Z', ttsUnhealthyHandbacks: -100 });
    eq([st.summary, st.dropped.sort()], [{ ok: 1 }, ['llmUnknownResetAt', 'ttsUnhealthyHandbacks']], 'el navegador no las puede fijar');
  });

  await check('S9 (review P1-1) guardado EN Storage + Storage caído al LEERLO → la parte vuelve como espera de Storage: 0 reservas nuevas, 0 pedidos pagados; 403 → falla sin pagar; 400/404 → sin guardado (paga)', async () => {
    const a = await fakeAnthropic();
    try {
      const w = llmWorld(async (ww, p, j) => { ww.store.set(p, j); });
      eq(await w.api(a.url, 1)('sistema', 'pedido-p11'), `RESPUESTA-${a.st.requests}`, 'intento 1 paga y guarda en Storage');
      const paid = a.st.requests;
      const res0 = w.res.size;
      assert(typeof Object.values(w.cps)[0].inline === 'undefined', 'guardado en Storage (sin inline)');
      w.getImpl = async () => { throw new SR.StorageUnavailableError('download', 504, 6, 98_000); };
      const e = await caught(w.api(a.url, 2)('sistema', 'pedido-p11'));
      eq([e && e.handBack, e && e.code, e && e.fatal], ['storage_unavailable', 'storage_unavailable', true], 'devolución como espera de Storage');
      assert(e.retryAfterSeconds >= 30, 'retryAfter');
      assert(SR.isStorageUnavailableMessage(e.msg), `mensaje reconocible por failItem: ${e.msg}`);
      eq([a.st.requests, w.res.size], [paid, res0], 'sin pedido pagado ni reserva nueva');
      // Error determinista que NO es «no existe» (403): tampoco re-paga.
      w.getImpl = async () => { throw new Error('Supabase Storage download failed: 403 cursia-artifacts/x'); };
      const e2 = await caught(w.api(a.url, 3)('sistema', 'pedido-p11'));
      eq([e2 && e2.code, a.st.requests, w.res.size], ['llm_checkpoint_unreadable', paid, res0], '403: falla sin pagar');
      assert(!SR.isStorageUnavailableMessage(e2.msg), '403 no es espera de Storage');
      // 400/404 «not found» o cuerpo ilegible = no hay guardado → la llamada se paga (comportamiento de siempre).
      w.getImpl = async () => { throw new Error('Supabase Storage download failed: 400 cursia-artifacts/x'); };
      eq(await w.api(a.url, 4)('sistema', 'pedido-p11'), `RESPUESTA-${paid + 1}`, '400 = sin guardado → paga');
      w.getImpl = async () => '{no-json';
      w.cps = Object.fromEntries(Object.entries(w.cps).map(([k, v]) => [k, { path: v.path, at: v.at }]));
      eq(await w.api(a.url, 5)('sistema', 'pedido-p11'), `RESPUESTA-${paid + 2}`, 'cuerpo ilegible = sin guardado → paga');
      eq([SL.checkpointNotFoundError({ status: 404 }), SL.checkpointNotFoundError(new Error('download failed: 403 x'))], [true, false], 'helper');
    } finally { await a.close(); }
  });
}

// ─── Parte DB ───────────────────────────────────────────────────────────────────────────────────────────────────
function findPgBin() {
  for (const d of [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean)) {
    const pg = path.join(d, 'postgres');
    if (fs.existsSync(pg) && /\b16\./.test(spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '')) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ([5570, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port))); }); });
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = D('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = D('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = D('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = D('modules/dynamic-generation/runs.service.js');
  const { SchedulerService } = D('modules/dynamic-generation/scheduler.service.js');
  const { Artifact } = D('modules/artifacts/entities/artifact.entity.js');
  const PKG = D('workers/dynamic-package-worker.js');
  const F = D('modules/finops/index.js');
  const { applyFakeProviderEnv } = require('./lib/provider-test-env');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r83-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r83-cwd-'));
  const ROLE = 'postgres.r83localtest01';
  const DB = 'r83db';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_GENERAL_AVAILABILITY', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
    'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'SUPER_ADMIN_EMAILS'];
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const restoreProviders = applyFakeProviderEnv();
  let started = false;
  let ds = null;
  let ds2 = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`  Postgres ${pgBin} en 127.0.0.1:${port}`);
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create database r83nodb`); await c.query(`create role "${ROLE}" superuser login`); });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    await withClient(DB, async (c) => {
      await c.query(`create role anon nologin; create role authenticated nologin`);
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
        'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    { const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({})); assert(res.code === 0, `constraints: ${res.out}`); }
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js',
      'scripts/migrate-v21-finops.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }
    const SQL = fs.readFileSync(path.join(REPO, 'supabase-migration-r83-infra-health.sql'), 'utf8');

    await check('D1 migración r83 aditiva e idempotente (dos veces), RLS sin acceso para anon/authenticated; el script se niega sin MIGRATION_ENV=staging', async () => {
      await withClient(DB, async (c) => {
        await c.query(SQL);
        await c.query(SQL);
        const t = await c.query(`select relrowsecurity from pg_class where relname = 'infra_health'`);
        eq(t.rows.map((x) => x.relrowsecurity), [true], 'RLS');
        const g = await c.query(`select has_table_privilege('authenticated', 'public.infra_health', 'select') a, has_table_privilege('anon', 'public.infra_health', 'update') b`);
        eq([g.rows[0].a, g.rows[0].b], [false, false], 'sin acceso de clientes');
        const bad = await c.query(`select 1`).then(() => c.query(`insert into public.infra_health (component, state) values ('x', 'raro')`)).then(() => 'ok', (e) => e.code);
        eq(bad, '23514', 'estado inválido rechazado');
      });
      const res = runScript('scripts/migrate-r83-infra-health.js', localEnv({}));
      assert(res.code !== 0 && /MIGRATION_ENV/.test(res.out), `debió negarse: ${res.code} ${res.out.slice(0, 200)}`);
    });

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    process.env.DYNAMIC_V2_GENERAL_AVAILABILITY = 'true';
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    process.env.SUPER_ADMIN_EMAILS = 'admin@cursia.test';

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const runs = new RunsService(ds, manifests, {}, { async check() { return { ok: true }; } }, budget);
    const sched = new SchedulerService(ds, runs);
    const CONTEXT = { nombre: 'Curso r83', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
    async function makeCourse(title) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: false, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'Válvulas', objective: null, video_enabled: false, activity_enabled: false }],
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
      await manifests.getOrCreate(cid, OWNER, 1);
      let runId;
      try {
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT })).run.id;
      } catch (err) {
        const body = err.getResponse ? err.getResponse() : null;
        assert(body && body.code === 'budget_approval_required', `startRun: ${err.message}`);
        await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test', reason: 'check r83' });
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT })).run.id;
      }
      return { cid, c1, c2, runId };
    }
    const itemRow = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const setRow = (id, sets, params = []) => ds.query(`update public.generation_item_runs set ${sets} where id = $1`, [id, ...params]);
    const breaker = async () => (await ds.query(`select * from public.infra_health where component = 'supabase_storage'`))[0] || null;
    const C = await makeCourse('Curso Storage caído');
    const presKey = `presentation:${C.c1}`;
    const STORAGE_MSG = 'unexpected_error: storage_unavailable: Supabase Storage upload failed: 504 (6 intentos, 98 s)';

    await check('D2 failItem del SERVIDOR con storage_unavailable en el ÚLTIMO intento → retrying sin consumir intento (+1 max), storageOutage.grants=1; sin storage → failed', async () => {
      const it = await itemRow(C.runId, presKey);
      await setRow(it.id, `status = 'running', worker_id = 'prov-1', attempt_count = 3, max_attempts = 3, lease_until = now() + interval '5 minutes'`);
      const t0 = Date.now();
      const res = await sched.failItemDetailed(it.id, 'prov-1', STORAGE_MSG, true);
      eq(res.ok, true, 'ok');
      const row = await itemRow(C.runId, presKey);
      eq([row.status, row.attempt_count, row.max_attempts, row.output_summary.storageOutage.grants], ['retrying', 3, 4, 1], 'sin consumir');
      const wait = (new Date(row.next_retry_at).getTime() - t0) / 1000;
      assert(wait > 50 && wait < 70, `espera ~60 s con el breaker cerrado (${wait})`);
      assert(noHtml(row.error), 'error sin HTML');
      // Mismo item, fallo NO de Storage en el último intento → consume (failed).
      await setRow(it.id, `status = 'running', worker_id = 'prov-1', attempt_count = 4, max_attempts = 4, lease_until = now() + interval '5 minutes'`);
      await sched.failItemDetailed(it.id, 'prov-1', 'unexpected_error: Connection terminated', true);
      eq((await itemRow(C.runId, presKey)).status, 'failed', 'otro error consume como siempre');
      // Un errorCode reportado no basta: el mensaje manda (y el navegador nunca obtiene la espera gratis).
      eq(SR.isStorageUnavailableMessage('storage_unavailable'), false, 'sin el formato del servidor no aplica');
    });

    await check('D3 ArtifactsService real: 504 permanente → StorageUnavailableError registrado en infra_health; 2 fallos en la ventana → ABIERTO', async () => {
      SB.resetStorageBreakerProcessState();
      const svc = new ArtifactsService(ds.getRepository(Artifact), { get: (k) => ENV[k] });
      storage.reset();
      storage.script = (req) => (req.method === 'POST' ? resp(504, GATEWAY_HTML) : null);
      const arts0 = (await ds.query(`select count(*)::int n from public.artifacts`))[0].n;
      const up = () => svc.uploadJsonArtifact({ ownerId: OWNER, type: 'dynamic_video', filename: 'v.json', storagePath: `${OWNER}/dynamic/1/2/dynamic_video/k/${crypto.randomUUID()}.json`, payload: { a: 1 } });
      const e1 = await caught(up());
      assert(SR.isStorageUnavailableError(e1) && noHtml(e1.message), e1.message);
      let b = await breaker();
      eq([b.state, b.failures], ['closed', 1], '1 fallo');
      assert(noHtml(b.last_error), 'sin HTML en el estado');
      await caught(up());
      b = await breaker();
      eq([b.state, b.failures], ['open', 2], 'abierto');
      const toProbe = (new Date(b.next_probe_at).getTime() - Date.now()) / 1000;
      assert(toProbe > 20 && toProbe <= 37, `primera sonda ~30 s (${toProbe})`);
      eq((await ds.query(`select count(*)::int n from public.artifacts`))[0].n, arts0, 'sin filas nuevas de artifacts');
    });

    await check('D4 abierto: el claim de los workers → {item:null, reason:storage_unavailable} sin tocar intentos; un fallo en vuelo espera hasta la sonda; el empaque no reclama', async () => {
      storage.reset();
      storage.script = () => { throw new Error('la compuerta no debe sondear antes de tiempo'); };
      const content = await itemRow(C.runId, `content:${C.c1}`);
      const before = [content.status, content.attempt_count];
      const r = await sched.claimNextItemDetailed({ executorId: 'llm-1', types: ['content', 'presentation'], leaseSeconds: 300 });
      eq([r.item, r.reason], [null, 'storage_unavailable'], 'retenido');
      const after = await itemRow(C.runId, `content:${C.c1}`);
      eq([after.status, after.attempt_count], before, 'el item ni se tocó');
      eq(storage.calls.length, 0, 'ni una llamada a Storage');
      // Un item en vuelo que falla ahora espera hasta la sonda.
      const pres = await itemRow(C.runId, presKey);
      await setRow(pres.id, `status = 'running', worker_id = 'prov-1', attempt_count = 2, max_attempts = 3, lease_until = now() + interval '5 minutes',
                             output_summary = output_summary - 'storageOutage'`);
      await sched.failItemDetailed(pres.id, 'prov-1', STORAGE_MSG, true);
      const row = await itemRow(C.runId, presKey);
      const b = await breaker();
      const diff = (new Date(row.next_retry_at).getTime() - new Date(b.next_probe_at).getTime()) / 1000;
      eq([row.status, row.attempt_count, row.max_attempts], ['retrying', 2, 4], 'sin consumir');
      assert(diff >= 0 && diff < 10, `next_retry_at ≈ next_probe_at (+${diff} s)`);
      // Empaque: la compuerta corta ANTES de abrir una transacción de claim.
      const trap = { query: ds.query.bind(ds), transaction: ds.transaction.bind(ds), createQueryRunner() { throw new Error('no debió intentar reclamar'); } };
      eq(await PKG.claimNext(trap, 'pkg-1', 300, { warn() {} }), null, 'claimNext del empaque retenido');
    });

    await check('D5 sonda vencida + Storage sigue caído → hold, probe_round+1, próxima sonda ~60 s; una sola sonda por vencimiento', async () => {
      await ds.query(`update public.infra_health set next_probe_at = now() - interval '1 second' where component = 'supabase_storage'`);
      storage.reset();
      storage.script = (req) => (req.key.includes('qa-internal/storage-probe/') ? resp(503, GATEWAY_HTML) : null);
      const [r1, r2] = await Promise.all([
        sched.claimNextItemDetailed({ executorId: 'w-a', types: ['content'], leaseSeconds: 300 }),
        sched.claimNextItemDetailed({ executorId: 'w-b', types: ['content'], leaseSeconds: 300 }),
      ]);
      eq([r1.reason, r2.reason], ['storage_unavailable', 'storage_unavailable'], 'ambos retenidos');
      eq(storage.calls.filter((c) => c.method === 'POST').length, 1, 'UNA sonda');
      const b = await breaker();
      const wait = (new Date(b.next_probe_at).getTime() - Date.now()) / 1000;
      eq([b.state, b.probe_round], ['open', 1], 'sigue abierto');
      assert(wait > 50 && wait <= 73, `próxima sonda ~60 s (${wait})`);
    });

    await check('D6 sonda OK → CERRADO, items retenidos liberados (next_retry_at ≤ now), los claims vuelven a repartir', async () => {
      await ds.query(`update public.infra_health set next_probe_at = now() - interval '1 second' where component = 'supabase_storage'`);
      storage.reset();
      const r = await SB.storageClaimGate(SB.storageBreakerDbOf(ds), SB.storageProbeFromEnv(), {});
      eq([r.hold, r.closed, r.released >= 1], [false, true, true], `cerrado y liberados (${r.released})`);
      eq(storage.calls.map((c) => c.method), ['POST', 'DELETE'], 'sonda PUT + DELETE');
      eq(storage.objects.size, 0, 'el objeto de la sonda se borró');
      const b = await breaker();
      eq([b.state, b.failures, b.probe_round, !!b.last_probe_ok_at], ['closed', 0, 0, true], 'estado');
      const pres = await itemRow(C.runId, presKey);
      assert(new Date(pres.next_retry_at).getTime() <= Date.now() + 1000, 'item liberado');
      const job = (await ds.query(`select worker_status, status from public.production_jobs where id = $1`, [C.runId]))[0];
      const open = await ds.query(`select item_key, status, next_retry_at <= now() as due from public.generation_item_runs where job_id = $1 and status in ('pending','retrying')`, [C.runId]);
      const c = await sched.claimNextItemDetailed({ executorId: 'llm-2', types: ['course_plan'], leaseSeconds: 300 });
      assert(c.item && c.reason === undefined, `vuelve a repartir: ${JSON.stringify(c.reason)} job=${JSON.stringify(job)} open=${JSON.stringify(open)}`);
    });

    await check('D7 sin la tabla (migración no aplicada) → no-op: la compuerta deja pasar y registrar no lanza', async () => {
      SB.resetStorageBreakerProcessState();
      ds2 = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: 'r83nodb', entities: [], synchronize: false });
      await ds2.initialize();
      const db = SB.storageBreakerDbOf(ds2);
      eq(await SB.recordStorageFailure(db, 'x'), null, 'registrar: no-op');
      eq((await SB.storageClaimGate(db, async () => { throw new Error('no'); })).hold, false, 'compuerta abierta');
      SB.resetStorageBreakerProcessState();
      eq(await SB.storageBreakerNextProbe(ds2), null, 'review F1: sin tabla = breaker NO disponible (null), no {open:false}');
      eq(await SB.storageBreakerNextProbe(null), null, 'sin DB = null');
      SB.resetStorageBreakerProcessState();
      eq(await SB.storageBreakerNextProbe(ds), { open: false, nextProbeAt: null }, 'con tabla y cerrado = {open:false}');
    });

    await check('D8 (review F1) sin la tabla infra_health → failItem con storage_unavailable en el ÚLTIMO intento consume el intento (failed), sin storageOutage: igual que antes de r83', async () => {
      SB.resetStorageBreakerProcessState();
      await ds.query(`alter table public.infra_health rename to infra_health_hidden`);
      try {
        const it = await itemRow(C.runId, presKey);
        await setRow(it.id, `status = 'running', worker_id = 'prov-1', attempt_count = 3, max_attempts = 3, lease_until = now() + interval '5 minutes',
                             output_summary = coalesce(output_summary, '{}'::jsonb) - 'storageOutage'`);
        await sched.failItemDetailed(it.id, 'prov-1', STORAGE_MSG, true);
        const row = await itemRow(C.runId, presKey);
        eq([row.status, row.attempt_count, row.max_attempts, row.output_summary && row.output_summary.storageOutage], ['failed', 3, 3, undefined], 'consume como antes');
        // Intento intermedio: retrying normal (consume), sin espera gratis.
        await setRow(it.id, `status = 'running', worker_id = 'prov-1', attempt_count = 1, max_attempts = 3, lease_until = now() + interval '5 minutes'`);
        await sched.failItemDetailed(it.id, 'prov-1', STORAGE_MSG, true);
        const r2 = await itemRow(C.runId, presKey);
        eq([r2.status, r2.attempt_count, r2.max_attempts, r2.output_summary && r2.output_summary.storageOutage], ['retrying', 1, 3, undefined], 'reintento normal sin grant');
      } finally {
        await ds.query(`alter table public.infra_health_hidden rename to infra_health`);
        SB.resetStorageBreakerProcessState();
      }
    });
  } finally {
    if (ds && ds.isInitialized) await ds.destroy();
    if (ds2 && ds2.isInitialized) await ds2.destroy();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    restoreProviders();
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
}

(async () => {
  await pureChecks();
  if (!PURE_ONLY) {
    try { await dbChecks(); } catch (e) { fail++; console.log(`❌ parte DB: ${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n   ') : e}`); }
  }
  console.log(`\n${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
