#!/usr/bin/env node
/* eslint-disable */
// r83 (incidente #91, 2026-11-02) — resiliencia del TTS del audiolibro.
//
// Ese día OpenAI cortó conexiones a mitad del cuerpo (`TypeError: terminated` en `res.arrayBuffer()`) y 7 de 9 capítulos
// terminaron en provider_reconciliation_required / hold_for_human. Este check prueba el arreglo SIN red externa y SIN
// gasto: un OpenAI FALSO en 127.0.0.1 que corta cuerpos, los deja colgados, resetea o responde 5xx; Anthropic falso
// (test/e2e-v2/fakes.js); scheduler / ledger / Storage EN MEMORIA; ffmpeg falso en el PATH.
//
//   cliente: corte / reset / stall / timeout / red → TtsStreamError con x-request-id, causa, bytes y duración;
//   reintento por segmento dentro del intento (la reserva perdida = cobrada, posible duplicado, en el ledger);
//   agotado → tts_chunk_cut_exhausted (clase A, nunca reconciliación); breaker → devolución sin consumir intento;
//   spool local: Storage caído → el próximo intento re-sube sin repagar; kill entre spool y liquidación → se liquida
//   desde el spool; segmentos de ~2000 caracteres fijados por item; kill switch (OPENAI_TTS_SEGMENT_RETRIES=0) = r62.
//
// Usage: node scripts/check-r83-tts.js [path/to/dist]
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const AS = loadDist('workers/provider-real/audio-scripts.js');
const RP = loadDist('workers/provider-real/real-providers.js');
const PC = loadDist('workers/provider-real/provider-clients.js');
const TR = loadDist('workers/provider-real/tts-resilience.js');
const AUD = loadDist('package/audio/index.js');
const FC = loadDist('modules/reliability/failure-classifier.js');
const SRES = loadDist('modules/artifacts/storage-resilience.js');
const { startProviderFakes } = require(path.join(REPO, 'test/e2e-v2/fakes.js'));

const LOGS = [];
const capLogger = { log: (m) => LOGS.push(String(m)), warn: (m) => LOGS.push(String(m)), error: (m) => LOGS.push(String(m)) };
Logger.overrideLogger({ log: capLogger.log, warn: capLogger.warn, error: capLogger.error, debug: () => {}, verbose: () => {} });

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.stack ? err.stack.split('\n').slice(0, 8).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ─── MP3 falso NO silencioso (MPEG-2 L3, 24 kHz, mono, 64 kbps) — mismo generador que check-r19 ─────────
const FRAME_SECONDS = 576 / 24000;
const BR_INDEX = { 8: 1, 16: 2, 24: 3, 32: 4, 40: 5, 48: 6, 56: 7, 64: 8 };
function fakeMp3Frames(frames, kbps, seedText) {
  const len = 3 * kbps;
  const buf = Buffer.alloc(frames * len);
  let x = parseInt(sha256(`${seedText}|${frames}`).slice(0, 8), 16) || 1;
  for (let f = 0; f < frames; f++) {
    const o = f * len;
    buf[o] = 0xff; buf[o + 1] = 0xf3; buf[o + 2] = (BR_INDEX[kbps] << 4) | 0x04; buf[o + 3] = 0xc0;
    for (let i = 4; i < len; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; buf[o + i] = ((x >>> 16) & 0xff) | 0x01; }
  }
  return buf;
}
const makeMp3 = (secs, text) => fakeMp3Frames(Math.max(1, Math.round(secs / FRAME_SECONDS)), 64, text || '');

// ─── ffmpeg FALSO en el PATH (re-emite los mismos frames al bitrate pedido) ──────────────────────────
const FAKE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r83-ffmpeg-'));
fs.writeFileSync(path.join(FAKE_BIN, 'ffmpeg'), `#!${process.execPath}
const crypto = require('crypto');
const args = process.argv.slice(2);
const br = parseInt(String(args[args.indexOf('-b:a') + 1] || '64'), 10);
const IDX = ${JSON.stringify(BR_INDEX)};
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const inp = Buffer.concat(chunks);
  const TBL = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  let o = 0; let frames = 0;
  while (o + 4 <= inp.length && inp[o] === 0xff) { const kb = TBL[(inp[o + 2] >> 4) & 15]; o += 3 * kb + ((inp[o + 2] >> 1) & 1); frames++; }
  const len = 3 * br; const out = Buffer.alloc(frames * len);
  let x = parseInt(crypto.createHash('sha256').update(inp).digest('hex').slice(0, 8), 16) || 1;
  for (let f = 0; f < frames; f++) { const p = f * len; out[p] = 0xff; out[p + 1] = 0xf3; out[p + 2] = (IDX[br] << 4) | 0x04; out[p + 3] = 0xc0;
    for (let i = 4; i < len; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out[p + i] = ((x >>> 16) & 0xff) | 1; } }
  process.stdout.write(out);
});
`, { mode: 0o755 });
process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH}`;

// ─── OpenAI TTS FALSO con fallas programables por llamada ───────────────────────────────────────────
// plan: cola de acciones por llamada: undefined/'ok' | 'cut' (200 + medio cuerpo + destroy) | 'reset' (200 + medio + RST)
//       | 'stall' (200 + medio cuerpo y después nada) | 'drop' (destroy antes de los headers) | número = status HTTP.
function startFakeOpenAi() {
  const st = { calls: [], seq: 0 };
  const plan = [];
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      if (rq.method !== 'POST' || new URL(rq.url, 'http://x').pathname !== '/v1/audio/speech') { rs.writeHead(404); return rs.end(); }
      const req = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const act = plan.length ? plan.shift() : 'ok';
      const rid = `req_r83_${++st.seq}`;
      st.calls.push({ act: act || 'ok', requestId: rid, chars: String(req.input || '').length, input: String(req.input || '') });
      if (act === 'drop') return rq.socket.destroy();
      if (typeof act === 'number') { rs.writeHead(act, { 'content-type': 'application/json', 'x-request-id': rid }); return rs.end(JSON.stringify({ error: { message: `fake ${act}` } })); }
      const words = String(req.input || '').split(/\s+/).filter(Boolean).length;
      const secs = Math.max(1, Math.round(words / (AUD.AUDIOBOOK_WPM_REF / 60)));
      const mp3 = makeMp3(secs, String(req.input || ''));
      rs.writeHead(200, { 'content-type': 'audio/mpeg', 'x-request-id': rid });
      if (act === 'cut' || act === 'reset' || act === 'stall') {
        rs.write(mp3.subarray(0, Math.floor(mp3.length / 2)));
        if (act === 'cut') setTimeout(() => rq.socket.destroy(), 30);
        if (act === 'reset') setTimeout(() => rq.socket.resetAndDestroy(), 30);
        if (act === 'stall') setTimeout(() => rq.socket.destroy(), 20_000).unref();
        return;
      }
      rs.end(mp3);
    });
  });
  return {
    st, plan,
    async listen() { await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${srv.address().port}/v1`; },
    async close() { srv.closeAllConnections && srv.closeAllConnections(); await new Promise((r) => srv.close(r)); },
  };
}

// ─── Capítulo de prueba (≈ palabras pedidas, oraciones de 12 palabras) ───────────────────────────────
let tokenSeq = 0;
function sentence(n, tag) { const w = []; for (let i = 0; i < n; i++) w.push(`${tag}${(tokenSeq++).toString(36)}`); return `${w.join(' ')}.`; }
function para(words, tag) { const out = []; let left = words; while (left > 0) { const n = Math.min(12, left); out.push(sentence(n, tag)); left -= n; } return out.join(' '); }
function chapterMd(ch, words) {
  const t = `c${ch}`;
  const sec = Math.round(words / 4);
  return [`# Capítulo ${ch}`, '', para(Math.round(sec * 0.4), t),
    ...[1, 2, 3].flatMap((k) => ['', `## ${ch}.${k} Tema ${k}`, '', para(Math.round(sec * 0.55), t), '', para(Math.round(sec * 0.45), t)]),
    '', '## Bibliografía', '', `- Autor ${t}, (2020). Obra. Editorial.`].join('\n');
}

// ─── Mundo en memoria: scheduler, ledger (con conciliación «cobrada»), Storage, artifacts ─────────────
function memoryWorld() {
  const blobs = new Map();
  const ledgerRows = [];
  const adjustments = [];
  const items = new Map();
  const artifacts = [];
  const inject = { uploadFail: null, settleFail: null, reconcileFail: false };
  const scheduler = {
    async completeItem(id, e, o) { const it = items.get(id); it.status = 'completed'; it.completion = o; it.outputSummary = { ...it.outputSummary, ...o.summary, artifactIds: o.artifactIds }; return true; },
    async failItem(id, e, msg, retry, _x, opts) { const it = items.get(id); it.status = retry ? 'retrying' : 'failed'; it.error = msg; it.fails.push({ msg, retry, opts: opts || null }); return true; },
    async blockItemForBudget(id, e, msg) { const it = items.get(id); it.status = 'blocked'; it.error = msg; return true; },
    async recordItemExternal(id, e, patch) { const it = items.get(id); it.outputSummary = { ...it.outputSummary, ...JSON.parse(JSON.stringify(patch)) }; return true; },
    async heartbeatItem() { return true; },
  };
  const keyOf = (input) => input.idempotencyKey || `${input.idempotency.kind}:${JSON.stringify(input.idempotency.parts)}`;
  const ledger = {
    async recordCharge(input) {
      const key = keyOf(input);
      let row = ledgerRows.find((r) => r.idempotency_key === key);
      if (row) return { inserted: false, event: row };
      row = { idempotency_key: key, attempt: input.attempt, provider: input.provider, external_operation_id: input.externalOperationId ?? null,
        measurement_status: input.measurementStatus, reservation: !!(input.metadata && input.metadata.reservation), settled: false,
        send_marked: !!(input.metadata && input.metadata.sendMarked), itemRunId: input.itemRunId, usage: input.usage, metadata: input.metadata || {} };
      ledgerRows.push(row);
      return { inserted: true, event: row };
    },
    async recordAdjustment() { return { inserted: true }; },
    async recordZero() { return { inserted: true }; },
    async settleReservation(key, finalCharge, reason) {
      if (inject.settleFail && inject.settleFail(key)) throw new Error('EMAXCONNSESSION: db caída (simulada)');
      const res = ledgerRows.find((r) => r.idempotency_key === key);
      if (!res) throw new Error(`no existe la reserva ${key}`);
      if (res.settled) return { finalInserted: false, finalEvent: null, released: false, alreadySettled: true };
      let fin = null;
      if (finalCharge) fin = await ledger.recordCharge(finalCharge);
      res.settled = true;
      adjustments.push({ key, reason, settlement: 'settled', finalKey: fin ? fin.event.idempotency_key : null });
      return { finalInserted: !!(fin && fin.inserted), finalEvent: fin ? fin.event : null, released: true, alreadySettled: false };
    },
    async reconcileReservationAsCharged(key, reason, opts) {
      if (inject.reconcileFail) throw new Error('EMAXCONNSESSION: db caída (simulada)');
      const res = ledgerRows.find((r) => r.idempotency_key === key);
      if (!res) throw new Error(`no existe la reserva ${key}`);
      if (res.settled) return { reconciled: false, alreadySettled: true, amount: '0', event: null };
      res.settled = true;
      adjustments.push({ key, reason, settlement: 'reconciled_as_charged', metadata: { ...(opts.metadata || {}), decidedBy: opts.decidedBy } });
      return { reconciled: true, alreadySettled: false, amount: '0.07', event: {} };
    },
    async itemPaidCharges(itemRunId) { return ledgerRows.filter((r) => r.itemRunId === itemRunId).map((r) => ({ ...r })); },
  };
  const arts = {
    async uploadJsonArtifact(a) { const id = crypto.randomUUID(); artifacts.push({ id, ...a }); return { id }; },
    async uploadBufferArtifact(a) { const id = crypto.randomUUID(); blobs.set(`cursia-artifacts/${a.storagePath}`, a.buffer); artifacts.push({ id, ...a }); return { id }; },
    async putStorageObject(a) {
      const uf = inject.uploadFail && inject.uploadFail(a.storagePath);
      // Real: un 5xx agotado sale como StorageUnavailableError tipado; un 4xx determinista, como Error simple (review F2).
      if (uf && typeof uf === 'number') throw new Error(`Supabase Storage upload failed: ${uf} Payload too large`);
      if (uf) throw new SRES.StorageUnavailableError('upload', 504, 6, 98_000);
      const k = `cursia-artifacts/${a.storagePath}`;
      if (blobs.has(k) && a.upsert === false) throw new Error(`Supabase Storage upload failed: 409 Duplicate ${a.storagePath}`);
      blobs.set(k, a.buffer);
      return { sizeBytes: a.buffer.length, adopted: false };
    },
    async downloadStorageObject(bucket, p) { const b = blobs.get(`${bucket}/${p}`); if (!b) throw new Error(`404 ${p}`); return b; },
    async getDownloadUrl(id) { const a = artifacts.find((x) => x.id === id); return { url: `data:text/plain;base64,${Buffer.from(a.text).toString('base64')}` }; },
  };
  return { blobs, ledgerRows, adjustments, items, artifacts, scheduler, ledger, arts, inject };
}

const KEYS = { OPENAI_API_KEY: 'sk-r83-openai-fake', ANTHROPIC_API_KEY: 'sk-r83-anthropic-fake' };
let OAI = null;
let LLM = null;
let BASE_ENV = null;
const SPOOL = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r83-spool-'));

function newItem(W, { ch, md, attempt = 1, outputSummary = {} }) {
  const depId = crypto.randomUUID();
  W.artifacts.push({ id: depId, text: JSON.stringify({ markdown: md }) });
  const it = {
    itemRunId: crypto.randomUUID(), runId: crypto.randomUUID(), courseId: 1, artifactCourseId: 'course-r83', manifestId: 7,
    itemKey: `audiobook_chapter:ch${ch}`, type: 'audiobook_chapter', chapterId: `ch${ch}`, chapterNumber: ch, idempotencyKey: `idem-${ch}-${crypto.randomUUID().slice(0, 6)}`,
    attempt, generation: 1, outputSummary, dependencyArtifacts: [{ type: 'dynamic_content_md', artifactId: depId }],
    blueprint: { course: { title: 'Curso r83' }, chapter: { title: `Capítulo ${ch}`, description: null } },
    context: { courseContext: { pais: 'Colombia' } }, status: 'running', fails: [],
  };
  W.items.set(it.itemRunId, it);
  return it;
}
function envWith(over = {}) { return { ...BASE_ENV, ...over }; }
function workerDeps(W, env) {
  return {
    scheduler: W.scheduler, dataSource: { async query() { return []; } }, artifacts: W.arts, logger: capLogger, executorId: 'r83-worker', leaseSeconds: 120,
    finops: W.ledger, budget: { async guardPaidSubmission() { return { allow: true, decision: 'ALLOW', committed: '0', remaining: '99', reason: 'test', authorizedBudget: '99' }; } },
    env,
  };
}
async function claim(W, it, env = envWith()) {
  it.status = 'running';
  try { await RP.processRealProviderItem(workerDeps(W, env), it, 'owner-r83'); } catch (err) { it.thrown = err.message; }
  return it;
}
function nextAttempt(it) { it.attempt += 1; return it; }
const openReservations = (W, it) => W.ledgerRows.filter((r) => r.itemRunId === it.itemRunId && r.reservation && !r.settled);
const possibleDup = (W) => W.adjustments.filter((a) => a.settlement === 'reconciled_as_charged' && a.metadata && a.metadata.possibleDuplicate === true);
const spoolFiles = (it) => { try { return fs.readdirSync(path.join(SPOOL, it.itemRunId)); } catch { return []; } };
const classify = (it) => FC.classifyFailure({ scope: 'item', error: it.error, itemType: 'audiobook_chapter', source: 'provider_worker', outputSummary: it.outputSummary });
const segCount = (it) => it.outputSummary.audiobookManifest.tts.segmentsExpected;

async function main() {
  OAI = startFakeOpenAi();
  const openaiUrl = await OAI.listen();
  LLM = startProviderFakes({ openaiKey: KEYS.OPENAI_API_KEY, anthropicKey: KEYS.ANTHROPIC_API_KEY, gammaKey: 'g', makePdf: () => Buffer.from('%PDF'), makeMp3, ttsWordsPerSecond: AUD.AUDIOBOOK_WPM_REF / 60 });
  const urls = await LLM.listen();
  BASE_ENV = { ...KEYS, OPENAI_API_BASE_URL: openaiUrl, ANTHROPIC_API_BASE_URL: urls.anthropicUrl, TTS_SPOOL_DIR: SPOOL,
    OPENAI_TTS_SEGMENT_BACKOFF_MS: '5', OPENAI_TTS_STALL_MS: '300', OPENAI_TTS_TIMEOUT_MS: '5000', OPENAI_TTS_BREAKER_CUTS: '0' };
  try {
    await clientChecks(openaiUrl);
    await pureChecks();
    await workerChecks();
  } finally {
    await OAI.close();
    await LLM.close();
  }
  console.log(`\n${passes} OK, ${failures} con fallas`);
  process.exit(failures ? 1 : 0);
}

// ════════════════════════════════════════════════════════════════════════════
async function clientChecks(openaiUrl) {
  const client = (over = {}) => new PC.OpenAiTtsClient(KEYS.OPENAI_API_KEY, { OPENAI_API_BASE_URL: openaiUrl, OPENAI_TTS_STALL_MS: '300', OPENAI_TTS_TIMEOUT_MS: '5000', ...over });
  const call = async (act, over) => { OAI.plan.push(act); try { return { ok: await client(over).speech({ model: 'm', voice: 'v', input: 'uno dos tres cuatro cinco seis siete ocho nueve diez '.repeat(20) }) }; } catch (err) { return { err }; } };

  await check('cliente: respuesta completa → audio entero + x-request-id (lectura por stream = arrayBuffer)', async () => {
    const r = await call('ok');
    assert(r.ok && r.ok.audio.length > 1000 && /^req_r83_/.test(r.ok.requestId), `ok ${r.err && r.err.message}`);
    AUD.parseMp3(r.ok.audio);
  });
  await check('cliente: corte a mitad del cuerpo («terminated») → TtsStreamError kind=cut, fase body, x-request-id, causa del socket, bytes > 0, sin la clave', async () => {
    const r = await call('cut');
    const e = r.err;
    assert(e instanceof PC.TtsStreamError && e instanceof PC.ProviderCallError, `tipo ${e && e.name}: ${e && e.message}`);
    eq([e.kind, e.phase, e.status, e.retryable, e.responseStatus], ['cut', 'body', null, true, 200], 'clasificación');
    assert(/^req_r83_/.test(e.requestId) && e.bytesReceived > 0 && e.elapsedMs >= 0, JSON.stringify(e.evidence()));
    assert(/UND_ERR_SOCKET|other side closed|ECONNRESET|terminated/.test(`${e.causeCode} ${e.message}`), `causa: ${e.causeCode} / ${e.message}`);
    assert(e.message.includes(e.requestId) && !e.message.includes(KEYS.OPENAI_API_KEY), 'mensaje con request-id y sin secreto');
    assert(!RP.isDefinitiveRejection(e) && !RP.isKnownTransientHttpError(e), 'nunca definitivo ni «no cobrado»');
  });
  await check('cliente: reset (RST) a mitad del cuerpo → kind=cut con causa ECONNRESET', async () => {
    const e = (await call('reset')).err;
    assert(e instanceof PC.TtsStreamError && e.kind === 'cut', e && e.message);
    assert(/ECONNRESET|other side closed|UND_ERR_SOCKET/.test(String(e.causeCode)), `causa ${e.causeCode}`);
  });
  await check('cliente: stall (headers 200 y después nada) → watchdog OPENAI_TTS_STALL_MS aborta mucho antes del total (kind=stall)', async () => {
    const t0 = Date.now();
    const e = (await call('stall')).err;
    const ms = Date.now() - t0;
    assert(e instanceof PC.TtsStreamError && e.kind === 'stall' && e.phase === 'body', e && e.message);
    assert(ms < 2500 && e.bytesReceived > 0, `abortó a los ${ms} ms (total 5000), bytes ${e.bytesReceived}`);
    eq(PC.ttsStallMs({}, 210000), PC.OPENAI_TTS_STALL_MS, 'default 40 s');
    eq(PC.ttsStallMs({ OPENAI_TTS_STALL_MS: '999999' }, 210000), 210000, 'nunca mayor que el total');
  });
  await check('cliente: timeout total con el cuerpo fluyendo lento → kind=timeout; red antes de headers → «error de red (TypeError)» kind=network', async () => {
    const e = (await call('stall', { OPENAI_TTS_STALL_MS: '5000', OPENAI_TTS_TIMEOUT_MS: '400' })).err;
    assert(e instanceof PC.TtsStreamError && e.kind === 'timeout', e && e.message);
    const d = (await call('drop')).err;
    assert(d instanceof PC.TtsStreamError && d.kind === 'network' && d.phase === 'headers' && /error de red \(TypeError\)/.test(d.message), d && d.message);
  });
  await check('cliente: HTTP 500 / 429 → ProviderCallError con status (camino de siempre)', async () => {
    const e = (await call(500)).err;
    assert(e instanceof PC.ProviderCallError && !(e instanceof PC.TtsStreamError) && e.status === 500, e && e.message);
    const r = (await call(429)).err;
    assert(RP.isKnownTransientHttpError(r), 'el 429 sigue siendo «no cobrado»');
  });
}

async function pureChecks() {
  await check('política: incierto reintentable = corte/stall/timeout/red y 5xx/408/409; nunca 4xx definitivo ni 429/503/529', () => {
    const P = PC.ProviderCallError;
    const s = (st) => new P('openai', st >= 500 || st === 408 || st === 409 || st === 429, `HTTP ${st}`, st);
    eq([500, 502, 504, 408, 409, 400, 401, 429, 503, 529].map((x) => TR.isRetryableTtsUncertain(s(x))), [true, true, true, true, true, false, false, false, false, false], 'statuses');
    assert(TR.isRetryableTtsUncertain(new PC.TtsStreamError('x', 'cut', 'body', null, 200, 1, 1, null)), 'corte');
    assert(TR.isRetryableTtsUncertain(new P('openai', true, 'red', null)) && !TR.isRetryableTtsUncertain(new Error('x')), 'red sí; error genérico no');
    eq([TR.ttsSegmentRetries({}), TR.ttsSegmentRetries({ OPENAI_TTS_SEGMENT_RETRIES: '0' }), TR.ttsSegmentRetries({ OPENAI_TTS_SEGMENT_RETRIES: '99' })], [2, 0, 5], 'reintentos (default 2, kill switch 0, tope 5)');
    const b = [1, 2, 3].map((n) => TR.ttsSegmentBackoffMs({}, n, () => 0.5));
    eq(b, [3000, 9000, 27000], 'backoff 3 s × 3^(n-1)');
  });

  await check('segmentos: ~2000 caracteres por oraciones (env AUDIOBOOK_TTS_SEGMENT_CHARS); fijado por item; un item con segmentos pagados de antes sigue con 3900', () => {
    const p = AS.planAudiobookSections(chapterMd(1, 2400));
    const sections = p.sections.map((x) => ({ idx: x.idx, text: x.text }));
    const segs = AS.audiobookSegments(sections, TR.audiobookSegmentChars({}));
    const old = AS.audiobookSegments(sections);
    assert(segs.every((x) => x.chars <= 2000) && segs.length > old.length, `${segs.length} segs (≤2000) vs ${old.length} (3900)`);
    assert(segs.every((x) => /[.!?]$/.test(x.text)), 'cortes en límites de oración');
    eq(segs.map((x) => x.text).join(' ').split(/\s+/).length, old.map((x) => x.text).join(' ').split(/\s+/).length, 'mismas palabras');
    eq([TR.effectiveSegmentChars({}, {}), TR.effectiveSegmentChars({ audioSegments: { a: {} } }, {}), TR.effectiveSegmentChars({ audioSegmentChars: 2000, audioSegments: { a: {} } }, {}),
      TR.effectiveSegmentChars({}, { AUDIOBOOK_TTS_SEGMENT_CHARS: '1500' }), TR.effectiveSegmentChars({}, { AUDIOBOOK_TTS_SEGMENT_CHARS: '99999' })], [2000, 3900, 2000, 1500, 3900], 'efectivo');
  });

  await check('spool: escribe/lee con sha, lo corrupto se descarta, TTL barre lo viejo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r83-sp-'));
    const s = new TR.TtsSpool(dir);
    const k = { itemRunId: 'it-1', segKey: 'seg-0-0-abc', textSha: 'f'.repeat(64), strategy: 'base' };
    const audio = Buffer.from('audio-pagado');
    const m = s.write({ ...k, requestId: 'req_1', reservationKey: 'reservation:tts:x', rawSeconds: 3, chars: 10, model: 'm', segIndex: 0, attempt: 1, settled: false }, audio);
    eq([s.read(k).audio.toString(), s.read(k).meta.settled, s.list('it-1').length], ['audio-pagado', false, 1], 'lectura');
    s.markSettled(m);
    eq(s.read(k).meta.settled, true, 'liquidado');
    assert(s.read({ ...k, strategy: 'instructions' }) === null && s.read({ ...k, textSha: 'e'.repeat(64) }) === null, 'otra estrategia / otro texto → nada');
    fs.writeFileSync(path.join(dir, 'it-1', fs.readdirSync(path.join(dir, 'it-1')).find((f) => f.endsWith('.mp3'))), 'corrupto');
    eq([s.read(k), s.list('it-1').length], [null, 0], 'corrupto → descartado');
    s.write({ ...k, requestId: null, reservationKey: 'r', rawSeconds: null, chars: 1, model: 'm', segIndex: 0, attempt: 1, settled: true }, audio);
    eq(s.sweep(3600_000, Date.now() + 2 * 3600_000) >= 2 && !fs.existsSync(path.join(dir, 'it-1')), true, 'TTL');
  });

  await check('clasificador: tts_chunk_cut_exhausted / tts_provider_unhealthy / audio_segment_upload_failed = A sin humano; la reconciliación real sigue C', () => {
    const v = (error) => FC.classifyFailure({ scope: 'item', error, itemType: 'audiobook_chapter', source: 'provider_worker', outputSummary: {} });
    const a = v('tts_chunk_cut_exhausted: chunk 3/9 (persisted 2): 3 envíos sin audio completo, cada uno contado como cobrado (posible duplicado) en el ledger; se reintenta el item. Último: openai POST /audio/speech: corte del cuerpo (terminated) [UND_ERR_SOCKET other side closed]; 1000 bytes en 95.0 s; HTTP 200; x-request-id req_1');
    eq([a.class, a.strategy, a.humanReason, a.paidRisk, a.rule], ['A', 'retry_backoff', null, 'measured', 'tts_chunk_cut_exhausted'], 'agotado');
    const b = v('tts_provider_unhealthy: 3 envíos de OpenAI TTS sin audio completo en 10 min (último en chunk 2/9 (persisted 1)); el item vuelve a la cola en 300 s sin consumir intento');
    eq([b.class, b.humanReason], ['A', null], 'proveedor enfermo');
    const c = v('audio_segment_upload_failed: seg-0-1-abc (segmento 2/9, guardados 1) — el audio ya pagado quedó en el spool local del worker y el próximo intento lo re-sube sin volver a llamar a OpenAI. Storage: Supabase Storage upload failed: 504');
    eq([c.class, c.humanReason, c.paidRisk], ['A', null, 'none'], 'upload');
    const d = v('provider_reconciliation_required: openai — llamada pagada enviada sin resultado liquidado. tts_failed: chunk 2/9 (persisted 1): terminated');
    eq(d.class, 'C', 'reconciliación real');
  });
}

async function workerChecks() {
  const md = chapterMd(1, 1400);

  await check('W1 corte del cuerpo en el segmento 2 → reintento EN EL MISMO intento, completa; la reserva cortada = cobrada (posible duplicado, system), la del reenvío `:t2` medida; 0 reservas abiertas; evidencia en ttsCuts', async () => {
    TR.TTS_CUT_BREAKER.reset();
    const W = memoryWorld();
    const it = newItem(W, { ch: 1, md });
    const c0 = OAI.st.calls.length;
    OAI.plan.push('ok', 'cut');
    await claim(W, it);
    eq(it.status, 'completed', `completa (${it.error}; ${it.thrown})`);
    eq(it.fails.length, 0, 'ningún fallo del item');
    eq(OAI.st.calls.length - c0, segCount(it) + 1, 'una llamada TTS de más (el reenvío)');
    eq(openReservations(W, it).length, 0, 'sin reservas abiertas');
    const dup = possibleDup(W);
    eq(dup.length, 1, 'una liquidación posible duplicado');
    assert(/:a1:seg_seg-/.test(dup[0].key) && !/_t2$/.test(dup[0].key), dup[0].key);
    eq([dup[0].metadata.cause, dup[0].metadata.decidedBy, dup[0].metadata.provider], ['connection_cut', 'system', 'openai'], 'motivo y actor');
    assert(W.ledgerRows.some((r) => r.reservation && /_t2$/.test(r.idempotency_key) && r.settled), 'reserva del reenvío `:t2` liquidada');
    const cut = it.outputSummary.ttsCuts[0];
    eq([cut.kind, cut.phase, cut.chunk, cut.try, cut.settledAs], ['cut', 'body', 2, 1, 'charged_possible_duplicate'], 'evidencia');
    assert(/^req_r83_/.test(cut.requestId) && cut.bytesReceived > 0 && typeof cut.elapsedMs === 'number' && cut.cause, JSON.stringify(cut));
    eq(it.outputSummary.audioSegmentChars, 2000, 'tamaño de segmento fijado en el item');
    eq(AUD.validateChapterAudioManifest(it.outputSummary.audiobookManifest), [], 'manifiesto válido');
    eq(spoolFiles(it).length, 0, 'spool limpio al completar');
  });

  await check('W2 stall (sin bytes) → el watchdog aborta en ~0,3 s, se reintenta y completa (causa timeout_presumed_charged)', async () => {
    TR.TTS_CUT_BREAKER.reset();
    const W = memoryWorld();
    const it = newItem(W, { ch: 2, md });
    OAI.plan.push('stall');
    const t0 = Date.now();
    await claim(W, it);
    eq(it.status, 'completed', `completa (${it.error})`);
    assert(Date.now() - t0 < 15_000, 'sin esperar el total');
    eq([it.outputSummary.ttsCuts[0].kind, possibleDup(W)[0].metadata.cause], ['stall', 'timeout_presumed_charged'], 'stall');
  });

  await check('W3 cortes repetidos en el mismo segmento (3 = 1 + OPENAI_TTS_SEGMENT_RETRIES) → tts_chunk_cut_exhausted reintentable, clase A (no reconciliación ni humano), 3 posibles duplicados, intento reconocido; el próximo intento REANUDA desde los segmentos guardados', async () => {
    TR.TTS_CUT_BREAKER.reset();
    const W = memoryWorld();
    const it = newItem(W, { ch: 3, md });
    OAI.plan.push('ok', 'cut', 'reset', 500);
    await claim(W, it);
    eq(it.status, 'retrying', `reintentable (${it.error})`);
    assert(/^tts_chunk_cut_exhausted: chunk 2\/\d+ \(persisted 1\): 3 envíos/.test(it.error), it.error);
    const v = classify(it);
    eq([v.class, v.strategy, v.humanReason, v.paidRisk], ['A', 'retry_backoff', null, 'measured'], 'veredicto');
    eq([possibleDup(W).length, openReservations(W, it).length], [3, 0], '3 envíos perdidos liquidados como cobrados; nada abierto');
    eq(it.outputSummary.reconciliationAcknowledgedThroughAttempt, 1, 'intento reconocido');
    eq(Object.keys(it.outputSummary.audioSegments).length, 1, 'segmento 1 guardado');
    const c0 = OAI.st.calls.length;
    await claim(W, nextAttempt(it));
    eq(it.status, 'completed', `el reintento completa (${it.error})`);
    eq([OAI.st.calls.length - c0, it.outputSummary.reusedSegments], [segCount(it) - 1, 1], 'solo lo que faltaba (el guardado no se repaga)');
  });

  await check('W4 breaker: cortes repetidos en pocos minutos (OPENAI_TTS_BREAKER_CUTS=2) → el item vuelve a la cola SIN consumir intento (grantAttempt + retryAfter), acotado por item; al volver reanuda y completa', async () => {
    TR.TTS_CUT_BREAKER.reset();
    const W = memoryWorld();
    const it = newItem(W, { ch: 4, md });
    const env = envWith({ OPENAI_TTS_BREAKER_CUTS: '2', OPENAI_TTS_BREAKER_RETRY_AFTER_S: '120', OPENAI_TTS_BREAKER_MAX_HANDBACKS: '1' });
    OAI.plan.push('cut', 'ok', 'cut');
    await claim(W, it, env);
    eq(it.status, 'retrying', `devuelto (${it.error})`);
    assert(/^tts_provider_unhealthy: 2 envíos/.test(it.error), it.error);
    const f = it.fails[it.fails.length - 1];
    eq([f.retry, f.opts && f.opts.grantAttempt, f.opts && f.opts.retryAfterSeconds], [true, true, 120], 'sin consumir intento');
    eq([classify(it).class, it.outputSummary.ttsUnhealthyHandbacks, openReservations(W, it).length], ['A', 1, 0], 'A, contador, nada abierto');
    // Tope de devoluciones por item agotado → el siguiente brote sigue el camino normal (reintento/agotado), nunca un bucle.
    OAI.plan.push('cut', 'cut');
    await claim(W, nextAttempt(it), env);
    eq(it.status, 'completed', `completa tras la espera (${it.error})`);
    assert(it.fails.length === 1, 'sin otra devolución (tope 1)');
  });

  await check('W5 Storage 504 al subir un segmento YA pagado → audio_segment_upload_failed (A), el cargo quedó medido ANTES de subir y el MP3 en el spool; el próximo intento lo re-sube desde el spool SIN llamar a OpenAI', async () => {
    TR.TTS_CUT_BREAKER.reset();
    const W = memoryWorld();
    const it = newItem(W, { ch: 5, md });
    let n = 0;
    W.inject.uploadFail = (p) => /dynamic_audio_segment\/idem-.*\/seg-/.test(p) && ++n === 2;
    const c0 = OAI.st.calls.length;
    await claim(W, it);
    W.inject.uploadFail = null;
    eq(it.status, 'retrying', `reintentable (${it.error})`);
    // Contrato con r83-storage: `unexpected_error: storage_unavailable: …` (espera gratuita del Storage una vez fusionado).
    assert(/^unexpected_error: storage_unavailable: /.test(it.error) && /audio_segment_upload_failed seg-/.test(it.error) && /504/.test(it.error), it.error);
    eq([classify(it).class, classify(it).humanReason], ['A', null], 'A');
    eq(OAI.st.calls.length - c0, 2, '2 llamadas pagadas');
    const charges = W.ledgerRows.filter((r) => !r.reservation && r.provider === 'openai');
    eq([charges.length, openReservations(W, it).length], [2, 0], 'dos cargos medidos, ninguna reserva abierta');
    eq(spoolFiles(it).filter((f) => f.endsWith('.mp3')).length, 1, 'el MP3 pagado está en el spool');
    const c1 = OAI.st.calls.length;
    await claim(W, nextAttempt(it));
    eq(it.status, 'completed', `completa (${it.error})`);
    eq([OAI.st.calls.length - c1, it.outputSummary.spoolReusedSegments, it.outputSummary.reusedSegments], [segCount(it) - 2, 1, 2], 'el segmento del spool NO se repaga');
    eq(W.ledgerRows.filter((r) => !r.reservation && r.provider === 'openai').length, segCount(it), 'un cargo por segmento (sin duplicados)');
    eq(spoolFiles(it).length, 0, 'spool limpio');
  });

  await check('W5b (review F2) 4xx DETERMINISTA (413) al subir un segmento ya pagado → audio_segment_upload_failed (consume intento), NUNCA storage_unavailable; MP3 en el spool, sin repagar', async () => {
    TR.TTS_CUT_BREAKER.reset();
    const W = memoryWorld();
    const it = newItem(W, { ch: 15, md });
    let n = 0;
    W.inject.uploadFail = (p) => (/dynamic_audio_segment\/idem-.*\/seg-/.test(p) && ++n === 2 ? 413 : false);
    await claim(W, it);
    W.inject.uploadFail = null;
    eq(it.status, 'retrying', `reintentable (${it.error})`);
    assert(/^audio_segment_upload_failed: /.test(it.error) && /413/.test(it.error) && !/storage_unavailable/.test(it.error), it.error);
    eq(SRES.isStorageUnavailableMessage(it.error), false, 'no es espera de Storage');
    const cl = classify(it);
    eq([cl.class, cl.rule, cl.humanReason], ['A', 'audio_segment_upload_failed', null], 'su propia regla');
    eq(spoolFiles(it).filter((f) => f.endsWith('.mp3')).length, 1, 'el MP3 pagado está en el spool');
  });

  await check('W6 liquidación caída con el MP3 ya en el spool (pooler lleno, #91) → TRANSITORIO reintentable (nunca reconciliación); al reanudar, priorPaidBlock liquida desde el spool y el intento lo reutiliza (0 llamadas para ese segmento)', async () => {
    TR.TTS_CUT_BREAKER.reset();
    const W = memoryWorld();
    const it = newItem(W, { ch: 6, md });
    let n = 0;
    W.inject.settleFail = (k) => /reservation:tts:.*seg_seg-/.test(k) && ++n === 1;
    await claim(W, it);
    W.inject.settleFail = null;
    eq(it.status, 'retrying', `transitorio (${it.error})`);
    assert(/^unexpected_error: finops_ledger_write_failed/.test(it.error) && !/reconciliation/.test(it.error), it.error);
    eq(classify(it).class, 'A', 'clase A');
    eq([openReservations(W, it).length, spoolFiles(it).filter((f) => f.endsWith('.mp3')).length], [1, 1], 'reserva abierta + MP3 en el spool');
    const c0 = OAI.st.calls.length;
    await claim(W, nextAttempt(it));
    eq(it.status, 'completed', `reanuda y completa (${it.error})`);
    eq([OAI.st.calls.length - c0, it.outputSummary.spoolReusedSegments, openReservations(W, it).length], [segCount(it) - 1, 1, 0], 'liquidado desde el spool, sin repagar');
    assert(W.adjustments.some((a) => a.reason === 'openai_tts_measured_from_spool'), 'liquidación medida desde el spool');
  });

  await check('W7 kill switch OPENAI_TTS_SEGMENT_RETRIES=0 → política r62 (corte = reconciliación, reserva pendiente); liquidación «posible duplicado» caída → también reconciliación (nunca un reenvío a ciegas)', async () => {
    TR.TTS_CUT_BREAKER.reset();
    const W = memoryWorld();
    const it = newItem(W, { ch: 7, md });
    OAI.plan.push('cut');
    await claim(W, it, envWith({ OPENAI_TTS_SEGMENT_RETRIES: '0' }));
    assert(it.status === 'failed' && /^provider_reconciliation_required: openai/.test(it.error) && /terminated|corte del cuerpo/.test(it.error), it.error);
    eq(openReservations(W, it).length, 1, 'reserva pendiente');
    const W2 = memoryWorld();
    const it2 = newItem(W2, { ch: 8, md });
    W2.inject.reconcileFail = true;
    const c0 = OAI.st.calls.length;
    OAI.plan.push('cut');
    await claim(W2, it2);
    assert(it2.status === 'failed' && /^provider_reconciliation_required: openai/.test(it2.error), it2.error);
    eq(OAI.st.calls.length - c0, 1, 'sin reenvío');
  });

  await check('W8 429 (resultado conocido, sin cobro) sigue el camino de siempre: tts_failed clase A, reserva liberada, sin reenvío en el intento', async () => {
    TR.TTS_CUT_BREAKER.reset();
    const W = memoryWorld();
    const it = newItem(W, { ch: 9, md });
    OAI.plan.push('ok', 429);
    await claim(W, it);
    eq(it.status, 'retrying', it.error);
    assert(/^tts_failed: chunk 2\/\d+ \(persisted 1\): openai POST \/audio\/speech HTTP 429/.test(it.error), it.error);
    eq([classify(it).class, possibleDup(W).length, openReservations(W, it).length], ['A', 0, 0], 'A, sin posible duplicado');
  });

  await check('W9 item con segmentos pagados de antes de r83 (sin audioSegmentChars) → sigue con 3900: reutiliza lo guardado y no repaga', async () => {
    TR.TTS_CUT_BREAKER.reset();
    const W = memoryWorld();
    const it = newItem(W, { ch: 10, md });
    await claim(W, it, envWith({ AUDIOBOOK_TTS_SEGMENT_CHARS: '3900' }));
    eq(it.status, 'completed', it.error);
    // Simula un item legado: segmentos guardados con 3900 y sin el campo fijado → re-síntesis completa (p. ej. otra validación).
    const legacy = { ...it.outputSummary };
    delete legacy.audioSegmentChars;
    const it2 = newItem(W, { ch: 10, md, outputSummary: { audiobookPlan: legacy.audiobookPlan, audiobookSections: legacy.audiobookSections, audioSegments: legacy.audioSegments } });
    it2.idempotencyKey = it.idempotencyKey;
    const c0 = OAI.st.calls.length;
    await claim(W, it2);
    eq(it2.status, 'completed', it2.error);
    eq([OAI.st.calls.length - c0, it2.outputSummary.audioSegmentChars, it2.outputSummary.reusedSegments], [0, 3900, segCount(it2)], 'legado: 0 llamadas TTS');
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
