#!/usr/bin/env node
/* eslint-disable */
// r61 (Q-21) — toma de la lease con una llamada pagada EN VUELO: el reclamante nuevo NUNCA vuelve a pagar la misma
// llamada. Proveedores falsos en 127.0.0.1 (test/e2e-v2/fakes.js + un Anthropic SSE propio), ledger/scheduler falsos y
// un Postgres 16 descartable para las sentencias SQL nuevas. USD 0, sin red externa.
//
//   LT1 LLM: A en vuelo + B toma la parte → B NO reenvía (prior_call_in_flight, 0 pedidos, 0 reservas); A termina,
//       su guardado normal se rechaza (ya no es dueño) y queda como guardado TARDÍO; B retoma desde ahí → 1 pedido en
//       total, 1 cargo real liquidado, 0 pendientes (antes: 2 pedidos, 2 cargos — r58 LM1)
//   LT2 LLM: A terminó pero perdió la lease antes de guardar → guardado tardío → B 0 pedidos (antes: 1 extra — r58 LM2)
//   LT3 LLM: A cayó (respuesta perdida, reserva pendiente para siempre) → B espera solo la ventana; pasada, la regla de
//       desconocido de siempre (UN reintento medido); nunca un bucle
//   LT4 LLM: sin toma (el intento anterior falló solo) no se espera; la ventana solo se abre con lease_expired /
//       prior_call_in_flight (priorAttemptMayBeInFlight)
//   LT5 cerco en proceso: una tarea vieja de la misma parte (mismo executorId) no escribe más (latido/estado/complete/
//       fail = no-op) tras el re-claim del mismo proceso
//   LT6 TTS bienvenida: chunk enviado y sin liquidar de un intento tomado → devuelto (retryAfter ≥ ventana, sin consumir
//       intento, 0 TTS); pasada la ventana → reconciliación (0 TTS); sin toma → reconciliación inmediata (como antes)
//   LT7 segmento TTS del audiolibro (reserva sin marcador): la ventana se fecha con el alta de la reserva
//   LT8 Gamma: A recibe el generationId tras perder la lease → lo registra cercado por SU marcador; B lo retoma por
//       poll (0 POST nuevos); sin id: B devuelve dentro de la ventana y, pasada, ambiguo (0 POST); un marcador distinto
//       (reenvío humano) no deja registrar nada
//   LT9 Videogen: igual que Gamma con el jobId (0 envíos nuevos; ambiguo solo pasada la ventana)
//   LT10 SQL real (PG16 descartable): guardado tardío (no pisa, respeta los reinicios, no en partes terminadas),
//       adoptLateExternalId (cercado por marcador, nunca pisa un id ni una parte completada) y priorAttemptInFlightMs
//       (solo OTROS intentos, mismo hash, sin liquidar, dentro de la ventana; reloj de la DB)
//   LT11 processLlmItem de punta a punta (review M8/I1): A en vuelo; B reclama tras una devolución por drenaje
//       (previousError=worker_draining) y C tras una reapertura del auto-heal (previousError=null) → ninguno reenvía
//       (handed_back con grantAttempt/retryAfter, sin descartar guardados); A deja su guardado tardío; D completa
//       desde él → 1 pedido, 1 cargo, 0 pendientes
//
// Usage: npm run build && node scripts/check-r61-lease-takeover-no-repay.js [dist]
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const REPO = path.resolve(__dirname, '..');
const L = (rel) => require(path.join(distRoot, rel));
require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const LOGS = [];
const capLogger = { log: (m) => LOGS.push(String(m)), warn: (m) => LOGS.push(String(m)), error: (m) => LOGS.push(String(m)) };
Logger.overrideLogger({ log: capLogger.log, warn: capLogger.warn, error: capLogger.error, debug: () => {}, verbose: () => {} });

const SL = L('workers/llm-executor/server-llm.js');
const LT = L('workers/lease-takeover.js');
const LW = L('workers/dynamic-llm-worker.js');
const IW = L('workers/dynamic-item-worker.js');
const PW = L('workers/dynamic-provider-worker.js');
const SM = L('package/v3/synthetic-media.js');
const { startProviderFakes } = require(path.join(REPO, 'test/e2e-v2/fakes.js'));

const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (/^(http:\/\/127\.0\.0\.1:\d+|data:)/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };

let passes = 0; let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.error(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n   ') : JSON.stringify(e)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (t, o) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...o })}\n\n`;
const like = (pat) => new RegExp('^' + pat.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.')).join('.*') + '$');
async function err(p) { try { return { v: await p }; } catch (e) { return { e }; } }

const OWNER = '11111111-2222-4333-8444-555555555555';
const IRID = '11111111-2222-4333-8444-555555555555';
const RUN = '99999999-2222-4333-8444-555555555555';
const UB = 1.0; const ACTUAL = 0.3;

// ═══ LLM: Anthropic falso + mundo compartido por A y B (mismo contrato SQL que el worker) ═══════════════════════
async function fakeAnthropic(opts = {}) {
  const st = { requests: 0 };
  const srv = http.createServer(async (req, res) => {
    for await (const _ of req) { /* body */ }
    const n = ++st.requests;
    if (opts.drop && opts.drop(n)) { setTimeout(() => req.socket.destroy(), opts.holdMs || 0); return; }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse('message_start', { message: { id: `msg_${n}`, model: 'm', usage: { input_tokens: 10, output_tokens: 1 } } }));
      res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `R${n}` } }));
      res.write(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }));
      res.end(sse('message_stop', {}));
    }, opts.holdMs || 0);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, st, close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => r()); }) };
}

function world() {
  const w = { owner: 'A', cps: {}, store: new Map(), res: new Map(), finals: [], late: [] };
  w.ds = {
    async query(sql, params) {
      if (sql.includes('as remaining_ms')) {
        // priorAttemptInFlightMs: OTRO intento, mismo hash, sin liquidar, alta dentro de la ventana.
        const [keyLike, tagLike, , ownLike, windowSec] = params;
        let rem = 0;
        for (const [k, v] of w.res) {
          if (!like(keyLike).test(k) || !like(tagLike).test(v.tag) || v.settled || like(ownLike).test(k)) continue;
          const left = v.at + windowSec * 1000 - Date.now();
          if (left > rem) rem = left;
        }
        return [{ remaining_ms: rem }];
      }
      if (sql.includes('count(*)::int as n')) {
        const [keyLike, tagLike, , exclude] = params;
        return [{ n: [...w.res.entries()].filter(([k, v]) => like(keyLike).test(k) && like(tagLike).test(v.tag) && !v.settled && !exclude.includes(k)).length }];
      }
      if (sql.includes('generation_item_runs')) return [{ since: new Date(0).toISOString(), cps: { ...w.cps } }];
      throw new Error('SQL inesperado: ' + sql.slice(0, 80));
    },
  };
  w.finops = {
    async recordCharge(i) { w.res.set(i.idempotencyKey, { tag: i.metadata.callTag, settled: false, at: Date.now() }); return {}; },
    async recordAdjustment() { return {}; }, async recordZero() { return {}; },
    async settleReservation(key, charge, reason) {
      const r = w.res.get(key); r.settled = true; r.reason = reason;
      if (charge) w.finals.push({ key, idem: charge.externalOperationId });
      return { finalInserted: !!charge, finalEvent: null };
    },
  };
  w.budget = { guardServerLlmCall: async () => null, pauseRunBySystem: async () => true };
  w.api = (who, url, extra = {}) => {
    const attempt = who === 'A' ? 1 : 2;
    return SL.createServerApi({
      dataSource: w.ds, finops: w.finops, budget: w.budget,
      checkpoints: { put: async (p, j) => { w.store.set(p, j); }, get: async (p) => (w.store.has(p) ? w.store.get(p) : null) },
      recordCheckpoint: async (_id, e) => { if (w.owner !== who) return false; Object.assign(w.cps, e); return true; },
      // Mismo contrato que LATE_CHECKPOINT_SQL: solo agrega una clave que no existe.
      recordLateCheckpoint: async (_id, hash, entry, sentAt) => { if (w.cps[hash]) return false; w.cps[hash] = entry; w.late.push({ hash, sentAt, from: entry.lateFromAttempt }); return true; },
      // Solo el reclamante tras la toma mira la ventana (como processLlmItem con previousError=lease_expired).
      priorInFlightWindowMs: who === 'B' ? (extra.windowMs ?? 60_000) : 0,
      apiKey: 'k', baseUrl: url, defaultModel: 'm', idleMs: 3000, totalMs: 10000,
      logger: { log() {}, warn() {}, error() {} }, settleRetryDelaysMs: [0, 0],
    }, { itemRunId: IRID, runId: RUN, itemKey: 'content:x', generation: 1, ownerId: 'owner-1', artifactCourseId: '7', manifestId: 3, attempt }, () => ({ callRole: 'main', attempt }));
  };
  w.pending = () => [...w.res.values()].filter((v) => !v.settled).length;
  return w;
}

// ═══ Proveedores: scheduler / ledger / DB falsos (output_summary en memoria) ════════════════════════════════════
function fakeScheduler(summary = {}, opts = {}) {
  const st = { summary: JSON.parse(JSON.stringify(summary)), failed: [], completed: [], recorded: [] };
  return {
    st,
    async claimNextItem() { return null; },
    async heartbeatItem() { return !opts.leaseLost; },
    async recordItemExternal(_id, _ex, patch) {
      if (opts.rejectRecord && opts.rejectRecord(patch)) return false;
      st.recorded.push(patch);
      for (const [k, v] of Object.entries(patch)) { if (k === 'external') st.summary.external = { ...(st.summary.external || {}), ...v }; else st.summary[k] = v; }
      return true;
    },
    async failItem(_id, _ex, msg, retryable, _o, o) { st.failed.push({ msg, retryable, opts: o || null }); return true; },
    async completeItem(_id, _ex, p) { st.completed.push(p); return true; },
    async blockItemForBudget() { return true; },
  };
}
function fakeLedger(prior = []) {
  const st = { charges: [], settled: [] };
  return {
    st,
    async recordCharge(i) { st.charges.push(i); return { inserted: true, event: { id: `ev-${st.charges.length}` } }; },
    async recordReservationBatch(is) { for (const i of is) st.charges.push(i); return []; },
    async recordAdjustment() { return { inserted: true }; },
    async recordZero() { return { inserted: true }; },
    async settleReservation(key, final, reason) { st.settled.push({ key, reason, final: !!final }); return { finalInserted: !!final, finalEvent: null }; },
    async itemPaidCharges() { return prior; },
  };
}
/** DB falsa: el UPDATE de adoptLateExternalId aplicado sobre el summary en memoria con su mismo cerco. */
function adoptDs(sched, base) {
  return {
    adopted: 0,
    async query(sql, params) {
      if (/externalSubmitStartedAt' = \$2/.test(sql)) {
        const [, marker, ext, field] = params;
        const s = sched.st.summary;
        if (s.externalSubmitStartedAt !== marker || (s.external && s.external[field])) return [];
        s.external = { ...(s.external || {}), ...JSON.parse(ext), adoptedLate: true };
        this.adopted++;
        return [{ id: 'x' }];
      }
      return base ? base(sql, params) : [];
    },
  };
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// ═══ PG16 descartable (LT10) ══════════════════════════════════════════════════════════════════════════════════════
function findPgBin() {
  for (const d of [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean)) {
    const pg = path.join(d, 'postgres');
    if (fs.existsSync(pg) && /\b16\./.test(spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '')) return d;
  }
  return null;
}
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ([5570, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port))); }); });

(async () => {
  // ─── LLM ────────────────────────────────────────────────────────────────────────────────────────────────────────
  await check('LT1 LLM: A en vuelo + toma → B NO reenvía (prior_call_in_flight, 0 pedidos/reservas); A deja guardado tardío; B retoma de ahí → 1 pedido, 1 cargo real, 0 pendientes', async () => {
    const a = await fakeAnthropic({ holdMs: 250 });
    const w = world();
    const pA = err(w.api('A', a.url)('s', 'P'));
    await tick(60);
    w.owner = 'B';
    const b1 = await err(w.api('B', a.url)('s', 'P'));
    assert(b1.e && b1.e.handBack === LT.PRIOR_CALL_IN_FLIGHT && b1.e.retryAfterSeconds >= 50 && /^prior_call_in_flight:/.test(b1.e.msg), `B devuelve: ${JSON.stringify(b1.e)}`);
    eq([a.st.requests, w.res.size], [1, 1], 'B: 0 pedidos y 0 reservas');
    const rA = await pA;
    assert(!rA.e && rA.v === 'R1', `A obtiene su respuesta: ${JSON.stringify(rA.e)}`);
    eq(w.late.map((x) => x.from), [1], 'guardado tardío de A (intento 1)');
    const b2 = await err(w.api('B', a.url)('s', 'P'));
    eq([b2.v, a.st.requests, w.finals.length, w.pending()], ['R1', 1, 1, 0], 'B desde el guardado: 1 pedido, 1 cargo real, 0 pendientes');
    await a.close();
  });

  await check('LT2 LLM: A terminó (pagada) y perdió la lease antes de guardar → guardado tardío → B 0 pedidos (r58 LM2 cerrado)', async () => {
    const a = await fakeAnthropic({ holdMs: 0 });
    const w = world();
    w.owner = 'B'; // la toma ocurrió con la llamada de A en vuelo
    const rA = await err(w.api('A', a.url)('s', 'P'));
    const rB = await err(w.api('B', a.url)('s', 'P'));
    eq([rA.v, rB.v, a.st.requests, w.finals.length, w.pending()], ['R1', 'R1', 1, 1, 0], 'B responde la misma respuesta pagada sin volver a pagar');
    await a.close();
  });

  await check('LT3 LLM: A cayó (reserva pendiente para siempre) → B espera solo la ventana; pasada, la regla de desconocido (UN reintento medido), sin bucle', async () => {
    const w3 = world();
    const pendKey = (hash) => `reservation:llm:${IRID}:g1:a1:llmw-main-${hash.slice(0, 12)}-1-deadbeef`;
    const body = SL.serverLlmRequestBody({ system: 's', user: 'P', defaultModel: 'm' }).body;
    const hash = SL.serverLlmRequestHash(body);
    w3.res.set(pendKey(hash), { tag: `llmw-main-${hash.slice(0, 12)}-1-deadbeef`, settled: false, at: Date.now() });
    w3.owner = 'B';
    const a2 = await fakeAnthropic({ holdMs: 0 });
    const b1 = await err(w3.api('B', a2.url, { windowMs: 200 })('s', 'P'));
    assert(b1.e && b1.e.handBack === LT.PRIOR_CALL_IN_FLIGHT, `dentro de la ventana: devuelve (${JSON.stringify(b1.e)})`);
    eq(a2.st.requests, 0, 'dentro de la ventana: 0 pedidos');
    await tick(230);
    const b2 = await err(w3.api('B', a2.url, { windowMs: 200 })('s', 'P'));
    eq([b2.v, a2.st.requests, w3.pending()], ['R1', 1, 1], 'pasada la ventana: UN pedido (regla de desconocido); la reserva perdida sigue pendiente para conciliar');
    await a2.close();
  });

  await check('LT4 sin toma no se espera: la ventana solo se abre tras lease_expired / prior_call_in_flight', async () => {
    eq([null, '', 'lease_expired', 'lease_expired: x', 'prior_call_in_flight: x', 'provider_reconciliation_required: y', 'worker_draining: z', 'ambiguous_video_submission'].map((e) => LT.priorAttemptMayBeInFlight({ previousError: e })),
      [false, false, true, true, true, false, false, false], 'priorAttemptMayBeInFlight');
    eq([LT.inFlightRemainingMs(ago(10_000), 60_000) > 49_000, LT.inFlightRemainingMs(ago(70_000), 60_000), LT.inFlightRemainingMs(null, 60_000), LT.inFlightRemainingMs(new Date(Date.now() + 3600_000).toISOString(), 60_000)],
      [true, 0, 0, 60_000], 'ventana (un reloj adelantado nunca la alarga)');
    eq([LT.retryAfterSecondsFor(0), LT.retryAfterSecondsFor(1500), LT.IN_FLIGHT_WINDOW_MS.openai, LT.IN_FLIGHT_WINDOW_MS.gamma], [1, 3, 150_000, 90_000], 'retryAfter ≥ ventana');
  });

  await check('LT5 cerco en proceso: tras el re-claim del MISMO proceso, la tarea vieja no escribe (latido/estado/complete/fail = no-op)', async () => {
    const calls = [];
    const sched = {
      async heartbeatItem() { calls.push('hb'); return true; }, async recordItemExternal() { calls.push('rec'); return true; },
      async completeItemDetailed() { calls.push('cd'); return { ok: true }; }, async failItemDetailed() { calls.push('fd'); return { ok: true }; },
      async failItem() { calls.push('f'); return true; }, async completeItem() { calls.push('c'); return true; },
    };
    const fence = new LT.ItemTaskFence();
    const t1 = fence.enter('ir'); const old = LT.fencedScheduler(sched, 'ir', t1, fence);
    eq(await old.heartbeatItem('ir', 'w', 60), true, 'vigente: escribe');
    const t2 = fence.enter('ir'); const cur = LT.fencedScheduler(sched, 'ir', t2, fence);
    const r = [await old.heartbeatItem(), await old.recordItemExternal(), await old.completeItemDetailed(), await old.failItemDetailed(), await old.failItem(), await old.completeItem()];
    eq(r, [false, false, { ok: false, reason: 'lease_lost' }, { ok: false, reason: 'lease_lost' }, false, false], 'tarea vieja: no-op');
    eq(await cur.failItem(), true, 'la vigente sí');
    fence.leave('ir', t1); // salir con un token viejo no libera a la vigente
    assert(fence.isCurrent('ir', t2), 'la vigente sigue');
    eq(calls, ['hb', 'f'], 'solo llegaron las escrituras de la tarea vigente');
  });

  // ─── Proveedores (fakes en 127.0.0.1) ──────────────────────────────────────────────────────────────────────────
  const SECRETS = { GAMMA_API_KEY: 'sk-r61-gamma', OPENAI_API_KEY: 'sk-r61-openai', ANTHROPIC_API_KEY: 'sk-r61-anthropic' };
  const fakes = startProviderFakes({ gammaKey: SECRETS.GAMMA_API_KEY, openaiKey: SECRETS.OPENAI_API_KEY, anthropicKey: SECRETS.ANTHROPIC_API_KEY, makePdf: SM.syntheticPdf, makeMp3: SM.syntheticMp3 });
  const urls = await fakes.listen();
  const env = { ...SECRETS, GAMMA_API_BASE_URL: urls.gammaUrl, OPENAI_API_BASE_URL: urls.openaiUrl, ANTHROPIC_API_BASE_URL: urls.anthropicUrl, GAMMA_THEME_V21_LIGHT_DEFAULT: 'theme-light', GAMMA_THEME_V21_DARK_DEFAULT: 'theme-dark' };
  process.env.GAMMA_THEME_V21_LIGHT_DEFAULT = 'theme-light'; process.env.GAMMA_THEME_V21_DARK_DEFAULT = 'theme-dark'; // gammaThemeFor lee process.env
  const jobsDs = async (sql) => (/from public\.production_jobs/.test(sql) ? [{ owner_id: OWNER, input_payload: { providerModes: { presentation: 'real', audio: 'real' } } }] : []);
  const provDeps = (s, over = {}) => ({
    scheduler: s, dataSource: adoptDs(s, jobsDs),
    artifacts: {
      async uploadJsonArtifact() { return { id: 'art-json' }; }, async uploadBufferArtifact() { return { id: 'art-mp3' }; }, async putStorageObject() { return {}; },
      async getDownloadUrl(id) {
        if (id === 'intro-art') return { url: 'data:application/json,' + encodeURIComponent(JSON.stringify({ schemaVersion: 1, welcome: 'Te damos la bienvenida al curso de hidráulica de planta.' })) };
        return { url: 'data:text/plain,' + encodeURIComponent('# Bombas\n\nLa bomba mueve el aceite.') };
      },
    },
    logger: capLogger, executorId: 'prov-r61', leaseSeconds: 300, env, gammaPollMs: 5, gammaTimeoutMs: 60, finops: fakeLedger(),
    budget: { async guardPaidSubmission() { return { allow: true, decision: 'ALLOW', committed: '0', remaining: '9', reason: 'test', authorizedBudget: '9' }; } },
    rasterizer: { async available() { return true; }, async firstPagePng() { throw new Error('no debería rasterizar'); } },
    ...over,
  });
  const provItem = (type, summary = {}, over = {}) => ({
    itemRunId: 'ir-p', runId: 'run-p', courseId: 1, artifactCourseId: 'c1', manifestId: 1, itemKey: `${type}:ch1`, type, chapterId: 'ch1', chapterNumber: 1,
    idempotencyKey: 'idem-p', attempt: 2, generation: 1, outputSummary: summary, dependencyArtifacts: [{ type: 'dynamic_content_md', artifactId: 'content' }, { type: 'dynamic_course_intro_json', artifactId: 'intro-art' }],
    blueprint: { course: { id: 1, title: 'Curso' }, chapter: { title: 'Bombas', description: null } }, context: { courseContext: {} }, ...over,
  });
  const runProv = async (deps, item) => { try { await PW.processProviderItem(deps, item); return null; } catch (e) { return e; } };
  try {
    await check('LT6 TTS bienvenida: chunk enviado sin liquidar tras una toma → devuelto (retryAfter ≥ ventana, grantAttempt, 0 TTS); pasada la ventana → reconciliación; sin toma → reconciliación inmediata', async () => {
      const key = 'reservation:tts:ir-p:g1:a1:chunk0';
      const prior = [{ idempotency_key: key, attempt: 1, provider: 'openai', external_operation_id: null, measurement_status: 'pending', reservation: true, settled: false, created_at: ago(5_000) }];
      const tts0 = fakes.st.tts.length;
      let s = fakeScheduler({ paidCallsSent: { [key]: ago(5_000) } });
      let e = await runProv(provDeps(s, { finops: fakeLedger(prior) }), provItem('audio_welcome', s.st.summary, { previousError: 'lease_expired' }));
      const f = s.st.failed[0];
      assert(!e && f && f.retryable && /^prior_call_in_flight:/.test(f.msg) && f.opts.grantAttempt && f.opts.retryAfterSeconds >= 140, `devuelto: ${JSON.stringify(s.st.failed)} ${e && e.message}`);
      s = fakeScheduler({ paidCallsSent: { [key]: ago(10 * 60_000) } });
      e = await runProv(provDeps(s, { finops: fakeLedger(prior) }), provItem('audio_welcome', s.st.summary, { previousError: 'prior_call_in_flight: x' }));
      assert(e && /^provider_reconciliation_required/.test(s.st.failed[0].msg) && !s.st.failed[0].retryable, `pasada la ventana: ${JSON.stringify(s.st.failed)}`);
      s = fakeScheduler({ paidCallsSent: { [key]: ago(5_000) } });
      e = await runProv(provDeps(s, { finops: fakeLedger(prior) }), provItem('audio_welcome', s.st.summary, { previousError: 'tts_failed: chunk 1/1: HTTP 500' }));
      assert(e && /^provider_reconciliation_required/.test(s.st.failed[0].msg), `sin toma: ${JSON.stringify(s.st.failed)}`);
      eq(fakes.st.tts.length - tts0, 0, '0 llamadas TTS en los tres casos');
    });

    await check('LT7 segmento TTS del audiolibro (sin marcador): ventana fechada por el alta de la reserva', async () => {
      const key = 'reservation:tts:ir-p:g1:a1:seg_s0p0';
      const mk = (at) => [{ idempotency_key: key, attempt: 1, provider: 'openai', external_operation_id: null, measurement_status: 'pending', reservation: true, settled: false, created_at: at }];
      let s = fakeScheduler({});
      await runProv(provDeps(s, { finops: fakeLedger(mk(new Date(Date.now() - 20_000))) }), provItem('audiobook_chapter', {}, { previousError: 'lease_expired' }));
      assert(/^prior_call_in_flight:/.test(s.st.failed[0].msg), `reciente: ${JSON.stringify(s.st.failed)}`);
      s = fakeScheduler({});
      await runProv(provDeps(s, { finops: fakeLedger(mk(new Date(Date.now() - 20 * 60_000))) }), provItem('audiobook_chapter', {}, { previousError: 'lease_expired' }));
      assert(/^provider_reconciliation_required/.test(s.st.failed[0].msg), `vieja: ${JSON.stringify(s.st.failed)}`);
      // Reserva YA liquidada (A terminó y liquidó; su salida no quedó): nada en vuelo → reconciliación sin esperar.
      s = fakeScheduler({});
      await runProv(provDeps(s, { finops: fakeLedger([{ ...mk(new Date())[0], settled: true }, { idempotency_key: 'tts:req_1', attempt: 1, provider: 'openai', external_operation_id: 'req_1', measurement_status: 'measured', reservation: false, settled: false }]) }), provItem('audiobook_chapter', {}, { previousError: 'lease_expired' }));
      assert(/^provider_reconciliation_required/.test(s.st.failed[0].msg), `liquidada: ${JSON.stringify(s.st.failed)}`);
    });

    await check('LT8 Gamma: A recibe el id tras perder la lease → lo registra con SU marcador; B retoma por poll (0 POST nuevos); sin id: devuelto en la ventana, ambiguo pasada; marcador distinto → no registra', async () => {
      // A: Gamma acepta, pero el registro del id se rechaza (la parte ya es de B).
      const sA = fakeScheduler({}, { rejectRecord: (p) => 'external' in p });
      const ledgerA = fakeLedger();
      const posts0 = fakes.st.gammaPosts.length;
      const dA = provDeps(sA, { finops: ledgerA });
      await runProv(dA, provItem('presentation', {}, { attempt: 1 }));
      eq(fakes.st.gammaPosts.length - posts0, 1, `A: 1 envío ${JSON.stringify(sA.st.failed)}`);
      const gid = sA.st.summary.external && sA.st.summary.external.gammaGenerationId;
      assert(gid && sA.st.summary.external.adoptedLate === true && dA.dataSource.adopted === 1, `id registrado tarde: ${JSON.stringify(sA.st.summary)}`);
      eq(ledgerA.st.settled.length, 0, 'A no liquida (la generación sigue; se liquida en el terminal)');
      // B: retoma la MISMA generación por poll — nunca reenvía.
      fakes.plan.gammaHoldPending = true;
      const gets0 = fakes.st.gammaGets.length;
      const sB = fakeScheduler(sA.st.summary);
      await runProv(provDeps(sB, { finops: fakeLedger([]) }), provItem('presentation', sB.st.summary, { previousError: 'lease_expired' }));
      fakes.plan.gammaHoldPending = false;
      assert(fakes.st.gammaGets.slice(gets0).every((g) => g === gid) && fakes.st.gammaGets.length > gets0, 'B pollea la generación adoptada');
      eq(fakes.st.gammaPosts.length - posts0, 1, 'B: 0 POST nuevos');
      assert(/^gamma_timeout:/.test(sB.st.failed[0].msg) && sB.st.failed[0].retryable, `B espera la misma generación: ${JSON.stringify(sB.st.failed)}`);
      // Sin id todavía: B dentro de la ventana devuelve; pasada, ambiguo; nunca un POST.
      const marked = { externalSubmitStartedAt: ago(10_000), externalReservationKey: 'reservation:gamma:ir-p:g1:a1:submit' };
      let s = fakeScheduler(marked);
      await runProv(provDeps(s, { finops: null }), provItem('presentation', s.st.summary, { previousError: 'lease_expired' }));
      assert(/^prior_call_in_flight:/.test(s.st.failed[0].msg) && s.st.failed[0].opts.grantAttempt, `ventana: ${JSON.stringify(s.st.failed)}`);
      s = fakeScheduler({ ...marked, externalSubmitStartedAt: ago(5 * 60_000) });
      await runProv(provDeps(s, { finops: null }), provItem('presentation', s.st.summary, { previousError: 'lease_expired' }));
      assert(/^gamma_submit_ambiguous/.test(s.st.failed[0].msg) && !s.st.failed[0].retryable, `pasada: ${JSON.stringify(s.st.failed)}`);
      eq(fakes.st.gammaPosts.length - posts0, 1, '0 POST nuevos');
      // Un marcador distinto (reenvío humano archivó el de A) → el id de A no se registra.
      const sX = fakeScheduler({ externalSubmitStartedAt: 'otro' });
      const dsX = adoptDs(sX);
      eq(await LT.adoptLateExternalId(dsX, 'ir-p', ago(1), 'gammaGenerationId', { gammaGenerationId: 'g' }), false, 'cercado por el marcador');
    });

    await check('LT9 Videogen: A recibe el job tras perder la lease → lo registra con su marcador; B retoma (0 envíos); sin job: devuelto en la ventana, ambiguo pasada', async () => {
      const vItem = (over = {}) => ({
        itemRunId: 'ir-video', runId: 'run-1', courseId: 1, artifactCourseId: 'c1', manifestId: 1, itemKey: 'video:ch1', type: 'video', chapterId: 'ch1', chapterNumber: 1,
        idempotencyKey: 'idem-v1', attempt: 1, generation: 1, rulesVersion: 2, blueprint: { course: { id: 1, title: 'Curso' }, chapter: { title: 'Bombas' } },
        dependencyArtifacts: [{ type: 'dynamic_content_md', artifactId: 'content-art' }], outputSummary: {}, ...over,
      });
      const vDeps = (s) => ({
        scheduler: s, logger: capLogger, executorId: 'w-r61', leaseSeconds: 60, heartbeatMs: 600000, videoTimeoutMin: 1, videoPollMs: 5, mockScenario: 'success', mockResolvePolls: 2,
        dataSource: adoptDs(s, async (sql) => {
          if (/from public\.production_jobs/.test(sql)) return [{ owner_id: OWNER, video_mode: 'mock', input_payload: { videoMode: 'mock' } }];
          if (/select output_summary from public\.generation_item_runs/.test(sql)) return [{ output_summary: s.st.summary }];
          return [];
        }),
        artifacts: { async getDownloadUrl() { return { url: 'data:text/plain,Contenido%20del%20capitulo' }; }, async uploadJsonArtifact() { return { id: 'art-video' }; } },
        videogen: { async batchCreate() { s.st.submits = (s.st.submits || 0) + 1; return { batch_id: 'b', jobs: [{ job_id: 'vg-new' }] }; },
          async getVideoStatus(id) { return { job_id: id, status: 'completed_local', download_url: 'https://videogen.invalid/x.mp4', progress: 100, error: null }; }, async getVideoCost() { return { estimated_total_cost: 1 }; } },
      });
      const sA = fakeScheduler({}, { rejectRecord: (p) => 'external' in p });
      const dA = vDeps(sA);
      await IW.processItem(dA, vItem());
      const jid = sA.st.summary.external && sA.st.summary.external.videogenJobId;
      assert(jid && sA.st.summary.external.adoptedLate && dA.dataSource.adopted === 1 && sA.st.completed.length === 0, `A registra el job tarde y no completa: ${JSON.stringify(sA.st)}`);
      const sB = fakeScheduler(sA.st.summary);
      await IW.processItem(vDeps(sB), vItem({ attempt: 2, previousError: 'lease_expired', outputSummary: sB.st.summary }));
      eq([sB.st.completed.length, sB.st.submits || 0, sB.st.failed.length], [1, 0, 0], 'B retoma el job y completa, 0 envíos');
      let s = fakeScheduler({ externalSubmitStartedAt: ago(30_000) });
      await IW.processItem(vDeps(s), vItem({ attempt: 2, previousError: 'lease_expired', outputSummary: s.st.summary }));
      assert(/^prior_call_in_flight:/.test(s.st.failed[0].msg) && s.st.failed[0].retryable && s.st.failed[0].opts.grantAttempt, `ventana: ${JSON.stringify(s.st.failed)}`);
      s = fakeScheduler({ externalSubmitStartedAt: ago(30 * 60_000) });
      await IW.processItem(vDeps(s), vItem({ attempt: 2, previousError: 'lease_expired', outputSummary: s.st.summary }));
      eq([s.st.failed[0].msg, s.st.failed[0].retryable], ['ambiguous_video_submission', false], 'pasada la ventana: ambiguo (manual), como antes');
      s = fakeScheduler({ externalSubmitStartedAt: ago(30_000) });
      await IW.processItem(vDeps(s), vItem({ attempt: 2, previousError: 'videogen_submit_rejected: x', outputSummary: s.st.summary }));
      eq(s.st.failed[0].msg, 'ambiguous_video_submission', 'sin toma: ambiguo inmediato');
    });
  } finally {
    await fakes.close();
  }

  await check('LT11 processLlmItem de punta a punta: B (tras drenaje) y C (tras reapertura del auto-heal) NO reenvían la llamada en vuelo de A; A deja guardado tardío; D completa desde él', async () => {
    const a = await fakeAnthropic({ holdMs: 300 });
    const w = world();
    w.owner = 'w-A';
    const base = w.ds.query;
    w.ds = {
      async query(sql, params) {
        if (/select owner_id from public\.production_jobs/.test(sql)) return [{ owner_id: OWNER }];
        if (sql === LW.LATE_CHECKPOINT_SQL) {
          const [, hash, entry, sentAt] = params;
          if (w.cps[hash]) return [];
          w.cps[hash] = JSON.parse(entry); w.late.push({ hash, sentAt, from: w.cps[hash].lateFromAttempt });
          return [{ id: IRID }];
        }
        if (/'\{llmCheckpoints\}'/.test(sql) && /worker_id = \$2/.test(sql)) {
          if (params[1] !== w.owner) return [];
          Object.assign(w.cps, JSON.parse(params[2]));
          return [{ id: IRID }];
        }
        return base(sql, params);
      },
    };
    const st = { failed: [], completed: [], recorded: [] };
    const deps = (ex) => ({
      scheduler: {
        async heartbeatItem(_id, e) { return e === w.owner; },
        async completeItem() { return true; },
        async completeItemDetailed(_id, e, p) { if (e !== w.owner) return { ok: false, reason: 'lease_lost' }; st.completed.push({ ex: e, p }); return { ok: true }; },
        async failItemDetailed(_id, e, msg, retryable, _o, opts) { st.failed.push({ ex: e, msg, retryable, opts: opts || null }); return { ok: true }; },
        async recordItemExternal(_id, e, patch) { st.recorded.push({ ex: e, patch }); return true; },
      },
      dataSource: w.ds,
      artifacts: { async uploadBufferArtifact() { return { id: 'art' }; }, async putStorageObject(i) { w.store.set(i.storagePath, i.buffer.toString('utf8')); }, async downloadStorageObject(_b, p) { return Buffer.from(w.store.get(p) || '', 'utf8'); } },
      finops: w.finops, budget: w.budget, logger: { log() {}, warn() {}, error() {} },
      executorId: ex, leaseSeconds: 300, heartbeatMs: 1e9, apiKey: 'k', baseUrl: a.url, defaultModel: 'm', idleMs: 3000, totalMs: 10000, llmMode: 'mock',
      // Ejecutor falso: una llamada a la IA con el MISMO pedido en cada intento.
      createRuntime: ({ api }) => ({
        run: async () => ({ ok: true, artifacts: [], summary: { text: await api('s', 'P') } }),
        mapError: (e) => ({ msg: (e && (e.msg || e.message)) || String(e), retryable: true }),
        draftFailField: () => null,
      }),
    });
    const item = (attempt, previousError) => ({ itemRunId: IRID, runId: RUN, itemKey: 'content:x', type: 'content', attempt, generation: 1, artifactCourseId: '7', manifestId: 3, idempotencyKey: 'idem', previousError });
    const pA = LW.processLlmItem(deps('w-A'), item(1, null));
    await tick(80);
    // La lease de A vence; un reclamante B (no ejecutado aquí) la devolvió por drenaje → C ve previousError=worker_draining.
    w.owner = 'w-C';
    const rC = await LW.processLlmItem(deps('w-C'), item(3, 'worker_draining: el worker se reinicia'));
    w.owner = 'w-D';
    const rD = await LW.processLlmItem(deps('w-D'), item(4, null)); // reapertura del auto-heal: error = null
    eq([rC, rD, a.st.requests], ['handed_back', 'handed_back', 1], 'tras drenaje y tras reapertura: devuelta, 0 pedidos nuevos');
    assert(st.failed.every((f) => f.retryable && /^prior_call_in_flight:/.test(f.msg) && f.opts && f.opts.grantAttempt && f.opts.retryAfterSeconds >= 30), JSON.stringify(st.failed));
    assert(!st.recorded.some((r) => r.patch && 'llmCheckpoints' in r.patch), `sin descartar guardados: ${JSON.stringify(st.recorded)}`);
    const rA = await pA;
    eq([rA, w.late.length, w.late[0] && w.late[0].from], ['abandoned', 1, 1], 'A: abandona y deja su guardado tardío');
    w.owner = 'w-E';
    const rE = await LW.processLlmItem(deps('w-E'), item(5, 'prior_call_in_flight: x'));
    eq([rE, a.st.requests, w.finals.length, w.pending(), st.completed.length, st.completed[0] && st.completed[0].p.summary.text], ['completed', 1, 1, 0, 1, 'R1'], 'E completa desde el guardado: 1 pedido, 1 cargo, 0 pendientes');
    await a.close();
  });

  // ─── LT10 SQL real ─────────────────────────────────────────────────────────────────────────────────────────────
  await check('LT10 SQL real (PG16): guardado tardío, adoptLateExternalId y priorAttemptInFlightMs', async () => {
    const pgBin = findPgBin();
    if (!pgBin) throw new Error('No encontré Postgres 16 (setear PG_BIN)');
    const { Client } = require('pg');
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r61-q21-pg16-'));
    const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8' });
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl: ' + r.stderr + r.stdout);
    const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
    try {
      await c.connect();
      const ds = { query: (sql, p) => c.query(sql, p).then((x) => x.rows) };
      await c.query(`create table public.generation_item_runs (id uuid primary key, status text not null, created_at timestamptz not null default now(), updated_at timestamptz, output_summary jsonb);
        create table public.generation_cost_events (id uuid primary key default gen_random_uuid(), idempotency_key text not null, event_kind text not null default 'CHARGE',
          metadata jsonb, created_at timestamptz not null default now(), corrects_event_id uuid)`);
      const id = '22222222-2222-4333-8444-555555555555';
      await c.query(`insert into public.generation_item_runs (id, status, created_at, output_summary) values ($1, 'running', now() - interval '1 hour', '{"llmCheckpoints":{"h0":{"path":"p0","at":"x"}}}')`, [id]);
      const late = async (hash, sentAt) => (await ds.query(LW.LATE_CHECKPOINT_SQL, [id, hash, JSON.stringify({ path: 'p-' + hash, at: new Date().toISOString(), lateFromAttempt: 1 }), sentAt])).length;
      const cps = async () => (await ds.query(`select output_summary->'llmCheckpoints' as c from public.generation_item_runs where id = $1`, [id]))[0].c;
      eq(await late('h1', ago(1000)), 1, 'agrega una clave nueva');
      eq(await late('h0', ago(1000)), 1, 'una existente con fecha ilegible (la lectura la ignora) se reemplaza');
      eq((await cps()).h0.path, 'p-h0', 'h0 reemplazada');
      eq(await late('h1', ago(900)), 0, 'nunca pisa una existente de la ventana vigente');
      await c.query(`update public.generation_item_runs set output_summary = jsonb_set(output_summary, '{llmCheckpoints,hS}', jsonb_build_object('path', 'old', 'at', (now() - interval '2 hours')::text)) where id = $1`, [id]);
      eq(await late('hS', ago(1000)), 1, 'review I2: pisa una clave de una ventana ANTERIOR (ya ignorada por la lectura)');
      eq((await cps()).hS.path, 'p-hS', 'hS reemplazada');
      await c.query(`update public.generation_item_runs set output_summary = output_summary || jsonb_build_object('llmCheckpointsResetAt', $2::text) where id = $1`, [id, ago(500)]);
      eq(await late('h2', ago(1000)), 0, 'pedido anterior al último descarte → rechazado');
      eq(await late('h3', ago(100)), 1, 'pedido posterior al descarte → aceptado');
      await c.query(`update public.generation_item_runs set output_summary = output_summary || jsonb_build_object('recoveryBudgetResetAt', $2::text) where id = $1`, [id, ago(50)]);
      eq(await late('h4', ago(80)), 0, 'pedido anterior al reinicio de la ventana → rechazado');
      await c.query(`update public.generation_item_runs set status = 'completed' where id = $1`, [id]);
      eq(await late('h5', ago(1)), 0, 'parte completada → rechazado');
      eq(Object.keys(await cps()).sort(), ['h0', 'h1', 'h3', 'hS'], 'índice final');

      const vid = '33333333-2222-4333-8444-555555555555';
      const mk = ago(2000);
      await c.query(`insert into public.generation_item_runs (id, status, output_summary) values ($1, 'retrying', $2::jsonb)`, [vid, JSON.stringify({ externalSubmitStartedAt: mk })]);
      eq(await LT.adoptLateExternalId(ds, vid, 'otro-marcador', 'videogenJobId', { videogenJobId: 'vg-x' }), false, 'marcador distinto → nada');
      eq(await LT.adoptLateExternalId(ds, vid, mk, 'videogenJobId', { videogenBatchId: 'b', videogenJobId: 'vg-1', mode: 'real' }), true, 'marcador de A → registra');
      eq(await LT.adoptLateExternalId(ds, vid, mk, 'videogenJobId', { videogenJobId: 'vg-2' }), false, 'nunca pisa un id existente');
      const [ext] = await ds.query(`select output_summary->'external' as e from public.generation_item_runs where id = $1`, [vid]);
      eq([ext.e.videogenJobId, ext.e.adoptedLate], ['vg-1', true], 'id adoptado');
      const gid = '44444444-2222-4333-8444-555555555555';
      await c.query(`insert into public.generation_item_runs (id, status, output_summary) values ($1, 'completed', $2::jsonb)`, [gid, JSON.stringify({ externalSubmitStartedAt: mk })]);
      eq(await LT.adoptLateExternalId(ds, gid, mk, 'gammaGenerationId', { gammaGenerationId: 'g' }), false, 'parte completada → nada');
      await c.query(`update public.generation_item_runs set status = 'failed' where id = $1`, [gid]);
      eq(await LT.adoptLateExternalId(ds, gid, mk, 'gammaGenerationId', { gammaGenerationId: 'g' }), false, 'review M4: parte fallida (ya ambigua/reconciliación) → nada');

      const body = SL.serverLlmRequestBody({ system: 's', user: 'P', defaultModel: 'm' }).body;
      const hash = SL.serverLlmRequestHash(body);
      const tag = (n) => `llmw-main-${hash.slice(0, 12)}-${n}-abcd1234`;
      const ins = (key, t, secsAgo, settled = false) => c.query(
        `with e as (insert into public.generation_cost_events (idempotency_key, metadata, created_at) values ($1, jsonb_build_object('reservation', 'true', 'callTag', $2::text), now() - make_interval(secs => $3::int)) returning id)
         insert into public.generation_cost_events (idempotency_key, event_kind, metadata, corrects_event_id) select 'adj:' || $1, 'ADJUSTMENT', '{}'::jsonb, id from e where $4::boolean`,
        [key, t, secsAgo, settled]);
      await ins(`reservation:llm:${id}:g1:a2:${tag(1)}`, tag(1), 5); // propia (intento 2): nunca cuenta
      eq(await SL.priorAttemptInFlightMs(ds, id, new Date(0), hash, 2, 60_000), 0, 'solo la propia → 0');
      await ins(`reservation:llm:${id}:g1:a1:${tag(2)}`, tag(2), 120); // de A, fuera de la ventana
      await ins(`reservation:llm:${id}:g1:a1:${tag(3)}`, tag(3), 10, true); // de A, liquidada
      await ins(`reservation:llm:${id}:g1:a1:llmw-main-ffffffffffff-4-x`, 'llmw-main-ffffffffffff-4-x', 10); // otro hash
      eq(await SL.priorAttemptInFlightMs(ds, id, new Date(0), hash, 2, 60_000), 0, 'fuera de ventana / liquidada / otro hash → 0');
      await ins(`reservation:llm:${id}:g1:a1:${tag(5)}`, tag(5), 20); // de A, en vuelo
      const left = await SL.priorAttemptInFlightMs(ds, id, new Date(0), hash, 2, 60_000);
      assert(left > 38_000 && left <= 40_500, `en vuelo: ~40 s (${left})`);
      eq(await SL.priorAttemptInFlightMs(ds, id, new Date(Date.now() + 1000), hash, 2, 60_000), 0, 'anterior a la ventana de la parte → 0');
    } finally {
      await c.end().catch(() => {});
      pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})();
