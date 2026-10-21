#!/usr/bin/env node
/* eslint-disable */
// r64 (R1 #1567: la actividad H5P del cap. 2 se cortó 5 veces a mitad del stream y agotó su presupuesto de
// recuperación) — una respuesta cortada NO se repite igual: la misma solicitud se reenvía sin streaming, dentro del
// mismo presupuesto; nada parcial se acepta; el motivo del corte queda en el ledger y en el log.
// Ledger y DB falsos en memoria, Anthropic falso en 127.0.0.1 (USD 0).
// Usage: npm run build && node scripts/check-r64-stream-cut-recovery.js [dist]
const http = require('http');
const path = require('path');
const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const { createServerApi, priorStreamCut, LLM_OUTPUT_CUT_REPEATED } = require(path.join(distRoot, 'workers/llm-executor/server-llm.js'));
const { nonStreamMessage, streamMessage, nodeHttpFetch } = require(path.join(distRoot, 'workers/llm-executor/anthropic-stream.js'));
const { classifyFailure } = require(path.join(distRoot, 'modules/reliability/failure-classifier.js'));

let passes = 0; let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); }
  catch (e) { failures++; console.error(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : JSON.stringify(e)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sse = (t, o) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...o })}\n\n`;
const ITEM = { itemRunId: '11111111-2222-4333-8444-666666666666', runId: '99999999-2222-4333-8444-666666666666', itemKey: 'activity:cap2', attempt: 1, generation: 1, ownerId: 'owner-1', artifactCourseId: '7', manifestId: 3 };
const FULL = JSON.stringify({ title: 'Caso', decisions: [{ q: '¿Qué haces primero?', options: ['A', 'B'] }] });

/**
 * Anthropic falso. `plan({ stream, n, prompt })` → acción:
 *  'ok' | 'cut' (stream: message_start + texto parcial y corta el socket) | 'cut_error' (stream: evento error a mitad) |
 *  'no_stop' (stream: termina sin message_stop) | {status} | 'drop' | 'max_tokens' | 'garbage' (200 ilegible).
 */
async function fakeAnthropic(plan) {
  const st = { reqs: [] };
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const c0 = body.messages[0].content;
    const prompt = Array.isArray(c0) ? c0.map((b) => b.text).join('') : c0;
    const stream = body.stream === true;
    st.reqs.push({ stream, prompt, body });
    const n = st.reqs.filter((x) => x.prompt === prompt).length;
    const p = plan({ stream, n, prompt });
    if (p === 'drop') { req.socket.destroy(); return; }
    if (p && p.status) { res.writeHead(p.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'fake ' + p.status } })); return; }
    const id = 'msg_' + st.reqs.length;
    if (!stream) {
      if (p && p.delayMs) await new Promise((r) => setTimeout(r, p.delayMs));
      if (p === 'garbage') { res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_' + st.reqs.length }); res.end('{"type":"mess'); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_' + st.reqs.length });
      if (res.destroyed || req.socket.destroyed) return;
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: p === 'max_tokens' ? FULL.slice(0, 20) : FULL }],
        stop_reason: p === 'max_tokens' ? 'max_tokens' : 'end_turn', usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_' + st.reqs.length });
    res.write(sse('message_start', { message: { id, model: 'm', usage: { input_tokens: 100, output_tokens: 1 } } }));
    res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: FULL.slice(0, 30) } }));
    if (p === 'cut') { await new Promise((r) => setTimeout(r, 40)); res.socket.destroy(); return; }
    if (p === 'cut_error') { res.end(sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })); return; }
    if (p === 'cut_after_delta') { res.write(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } })); await new Promise((r) => setTimeout(r, 40)); res.socket.destroy(); return; }
    if (p === 'no_stop') { res.end(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: FULL.slice(30) } })); return; }
    res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: FULL.slice(30) } }));
    res.write(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }));
    res.end(sse('message_stop', {}));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, st, close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => r()); }) };
}

/** Ledger + DB falsos (la misma forma que check-llm-worker-server-api.js) + la consulta del corte previo (r64). */
function fakeWorld(opts = {}) {
  const res = new Map();
  const cps = {};
  const store = new Map();
  const charges = [];
  const like = (pat) => new RegExp('^' + pat.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  const ds = {
    sql: [],
    async query(sql, params) {
      ds.sql.push(sql);
      if (sql.includes('select now() as db_now')) return [{ db_now: new Date().toISOString() }];
      if (sql.includes('stream_cut_seen')) {
        if (opts.priorCutThrows) throw new Error('db caída');
        const fromLedger = charges.some((c) => c.metadata && c.metadata.streamCut);
        return [{ stream_cut_seen: !!(opts.priorCut || fromLedger) }];
      }
      if (sql.includes('count(*)::int as n')) {
        const [keyLike, tagLike, , exclude] = params;
        const n = [...res.entries()].filter(([k, v]) => like(keyLike).test(k) && like(tagLike).test(v.tag) && (!v.settled || v.possibleDuplicate) && !exclude.includes(k)).length;
        return [{ n }];
      }
      if (sql.includes('e.idempotency_key as key, e.amount::text as amount')) {
        const [keyLike, tagLike, , exclude, includePd] = params;
        return [...res.entries()].filter(([k, v]) => like(keyLike).test(k) && like(tagLike).test(v.tag) && (!v.settled || (includePd && v.possibleDuplicate)) && !exclude.includes(k))
          .map(([k, v]) => ({ key: k, amount: '0.01', settled: !!v.settled, send_marked: !!v.sendMarked, created_at: v.at ? new Date(v.at).toISOString() : null }));
      }
      if (sql.includes('generation_item_runs')) return [{ since: new Date(0).toISOString(), cps: { ...cps } }];
      throw new Error('SQL inesperado: ' + sql.slice(0, 80));
    },
  };
  const finops = {
    async recordCharge(i) { res.set(i.idempotencyKey, { tag: i.metadata.callTag, sendMarked: !!i.metadata.sendMarked, settled: false, at: Date.now() }); return {}; },
    async recordAdjustment() { return {}; }, async recordZero() { return {}; },
    async reconcileReservationAsCharged(key, reason, o) {
      const r = res.get(key);
      if (!r || r.settled) return { reconciled: false, alreadySettled: true, amount: '0', event: null };
      Object.assign(r, { settled: true, possibleDuplicate: !!(o && o.metadata && o.metadata.possibleDuplicate), reason });
      return { reconciled: true, alreadySettled: false, amount: '1', event: null };
    },
    async settleReservation(key, charge, reason) {
      const r = res.get(key); r.settled = true; r.reason = reason; r.charged = !!charge;
      if (charge) charges.push(charge);
      return { finalInserted: !!charge, finalEvent: null };
    },
  };
  return { res, cps, store, ds, finops, charges };
}

function makeApi(w, url, extra = {}) {
  const logs = [];
  const guards = [];
  const api = createServerApi({
    dataSource: w.ds, finops: w.finops,
    budget: { guardServerLlmCall: async (a) => { guards.push(a); return extra.deny ? extra.deny(guards.length) : null; }, ambiguousResendBudget: async () => ({ fits: true, reason: null, worstItem: 0, worstRun: 0 }) },
    checkpoints: { put: async (p, j) => { w.store.set(p, j); }, get: async (p) => (w.store.has(p) ? w.store.get(p) : null) },
    recordCheckpoint: async (_id, e) => { Object.assign(w.cps, e); return true; },
    apiKey: 'k', baseUrl: url, defaultModel: 'm', idleMs: 3000, totalMs: 10000,
    logger: { log() {}, warn(m) { logs.push(m); }, error(m) { logs.push(m); } }, settleRetryDelaysMs: [0, 0],
  }, ITEM, () => ({ callRole: 'main', attempt: 1 }));
  return Object.assign(api, { logs, guards });
}
const pending = (w) => [...w.res.values()].filter((v) => !v.settled).length;
async function err(p) { try { await p; return null; } catch (e) { return e; } }

(async () => {
  await check('R1: el stream se corta a mitad → la MISMA solicitud se reenvía sin streaming en la misma llamada y llega entera', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'cut' : 'ok'));
    const w = fakeWorld(); const api = makeApi(w, a.url);
    const meta = {};
    const text = await api('s', 'prompt-r1', 5000, undefined, undefined, meta);
    assert(text === FULL, 'texto completo: ' + text);
    assert(meta.stopReason === 'end_turn', 'stop_reason del envío sin streaming: ' + meta.stopReason);
    assert(a.st.reqs.length === 2 && a.st.reqs[0].stream === true && a.st.reqs[1].stream === false, 'un envío por stream y uno sin stream: ' + JSON.stringify(a.st.reqs.map((r) => r.stream)));
    const b0 = { ...a.st.reqs[0].body }; const b1 = { ...a.st.reqs[1].body }; delete b0.stream; delete b1.stream;
    assert(JSON.stringify(b0) === JSON.stringify(b1), 'misma solicitud (solo cambia el transporte)');
    assert(pending(w) === 0, 'ninguna reserva abierta');
    const reasons = [...w.res.values()].map((v) => v.reason).sort();
    assert(JSON.stringify(reasons) === JSON.stringify(['llm_worker_measured', 'llm_worker_stream_cut_conservative']), 'liquidaciones: ' + reasons);
    assert(api.guards.length === 2, 'el presupuesto (parte y run) se evaluó otra vez antes del reenvío: ' + api.guards.length);
    await a.close();
  });

  await check('R1: el corte deja su evidencia en el ledger (causa, hash, caracteres recibidos) y en el log', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'cut' : 'ok'));
    const w = fakeWorld(); const api = makeApi(w, a.url);
    await api('s', 'prompt-evidence', 5000);
    const cut = w.charges.find((c) => c.metadata && c.metadata.streamCut);
    assert(cut, 'cargo conservador con metadata.streamCut');
    const sc = cut.metadata.streamCut;
    assert(/^socket:/.test(sc.cause) && sc.transport === 'stream' && sc.partialChars === 30 && sc.callHash && sc.callHash.length === 12 && sc.sawUsageDelta === false, 'evidencia: ' + JSON.stringify(sc));
    assert(api.logs.some((l) => /se cortó a mitad \(stream; causa socket:/.test(l) && /30 caracteres recibidos/.test(l)), 'log con la causa: ' + api.logs.join(' | '));
    await a.close();
  });

  await check('R1: un error del proveedor a mitad del stream (overloaded_error) queda como su causa y también cambia de transporte', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'cut_error' : 'ok'));
    const w = fakeWorld(); const api = makeApi(w, a.url);
    const text = await api('s', 'prompt-overloaded', 5000);
    assert(text === FULL, 'llegó entera');
    const sc = w.charges.find((c) => c.metadata && c.metadata.streamCut).metadata.streamCut;
    assert(sc.cause === 'provider_error:overloaded_error', 'causa: ' + sc.cause);
    await a.close();
  });

  await check('R1: un stream que termina sin message_stop es un corte (nunca se acepta el texto a medias)', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'no_stop' : 'ok'));
    const w = fakeWorld(); const api = makeApi(w, a.url);
    const text = await api('s', 'prompt-nostop', 5000);
    assert(text === FULL && a.st.reqs.length === 2, 'reenviado sin streaming');
    assert(w.charges.find((c) => c.metadata && c.metadata.streamCut).metadata.streamCut.cause === 'no_message_stop', 'causa no_message_stop');
    await a.close();
  });

  await check('R1: un intento NUEVO de la parte (otro proceso) cuya llamada ya se cortó empieza directo sin streaming (ledger)', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'cut' : 'ok'));
    const w = fakeWorld({ priorCut: true }); const api = makeApi(w, a.url);
    const text = await api('s', 'prompt-attempt2', 5000);
    assert(text === FULL, 'llegó entera');
    assert(a.st.reqs.length === 1 && a.st.reqs[0].stream === false, 'ningún envío por stream: ' + JSON.stringify(a.st.reqs.map((r) => r.stream)));
    assert(w.charges.length === 1 && !w.charges[0].metadata.streamCut, 'un solo cobro medido, sin cortes');
    await a.close();
  });

  await check('R1: el patrón exacto de R1 (cada stream de esa parte se corta) cuesta como máximo UN corte por intento, no cinco', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'cut' : 'ok'));
    const w = fakeWorld();
    // Intento 1 de la parte y dos reintentos del ejecutor (_dynLlmCall) con prompts distintos (dirigidos) del mismo item.
    const api = makeApi(w, a.url);
    await api('s', 'r1-main', 5000);
    await api('s', 'r1-validation-retry', 5000);
    // Intento 2 (otro worker): el ledger ya tiene el corte de 'r1-main' → empieza sin streaming.
    const api2 = makeApi(w, a.url);
    await api2('s', 'r1-main', 5000).catch(() => null); // punto de guardado: sin llamada
    const cuts = w.charges.filter((c) => c.metadata && c.metadata.streamCut).length;
    assert(cuts === 1, 'UN solo corte en toda la parte (el reintento dirigido ya va sin streaming): ' + cuts);
    assert(a.st.reqs.filter((r) => r.stream).length === 1, 'streams enviados: ' + a.st.reqs.filter((r) => r.stream).length);
    const api3 = makeApi(w, a.url);
    await api3('s', 'r1-otro-prompt-intento-2', 5000);
    assert(a.st.reqs.filter((r) => r.stream).length === 1, 'un intento nuevo de la parte (ledger con el corte) tampoco usa streaming');
    await a.close();
  });

  await check('R1 real: el reintento MANUAL (presupuesto reiniciado) de una parte con cortes previos empieza sin streaming (mira toda la historia de la fila)', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'cut' : 'ok'));
    const w = fakeWorld({ priorCut: true });
    const seen = [];
    const q0 = w.ds.query.bind(w.ds);
    w.ds.query = async (sql, params) => { if (sql.includes('stream_cut_seen')) seen.push(params[1]); return q0(sql, params); };
    const api = makeApi(w, a.url);
    await api('s', 'r1-retry-manual', 5000);
    assert(seen.length === 1 && new Date(seen[0]).getTime() === 0, 'la consulta mira desde el inicio de la fila, no desde el reinicio del presupuesto: ' + JSON.stringify(seen));
    assert(a.st.reqs.length === 1 && a.st.reqs[0].stream === false, 'directo sin streaming');
    await a.close();
  });

  await check('sin streaming, un 529 del proveedor es CONOCIDO: la reserva se libera sin cobro y no se vuelve al stream', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'cut' : { status: 529 }));
    const w = fakeWorld(); const api = makeApi(w, a.url);
    const e = await err(api('s', 'prompt-529', 5000));
    assert(e && e.fatal === false, 'transitorio (el ejecutor reintenta con backoff): ' + JSON.stringify(e));
    assert(pending(w) === 0 && w.charges.length === 1, 'solo el corte cobrado; el 529 liberado: ' + w.charges.length);
    const e2 = await err(api('s', 'prompt-529', 5000));
    assert(e2 && a.st.reqs.filter((r) => r.stream).length === 1, 'el reintento de esa llamada sigue sin streaming');
    await a.close();
  });

  await check('sin streaming, max_tokens NO se acepta como completa: el texto vuelve con stop_reason=max_tokens para el validador', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'cut' : 'max_tokens'));
    const w = fakeWorld(); const api = makeApi(w, a.url);
    const meta = {};
    const text = await api('s', 'prompt-maxtok', 5000, undefined, undefined, meta);
    assert(meta.stopReason === 'max_tokens', 'stop_reason max_tokens visible: ' + meta.stopReason);
    let parsed = true; try { JSON.parse(text); } catch { parsed = false; }
    assert(!parsed, 'el JSON truncado no es válido (el ejecutor marca TRUNCATED y reintenta más conciso)');
    await a.close();
  });

  await check('sin streaming, una respuesta caída es DESCONOCIDA (reserva pendiente, regla de un reenvío), nunca «sin costo»', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'cut' : 'drop'));
    const w = fakeWorld(); const api = makeApi(w, a.url);
    const e = await err(api('s', 'prompt-drop', 5000));
    assert(e && e.fatal === true && e.pendingReview === true, 'tras el reenvío único → revisión: ' + JSON.stringify(e));
    assert(a.st.reqs.filter((r) => r.stream).length === 1, 'nunca volvió al stream');
    await a.close();
  });

  await check('el reenvío sin streaming respeta el presupuesto: si la parte ya no tiene saldo, no se envía', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'cut' : 'ok'));
    const w = fakeWorld();
    const api = makeApi(w, a.url, { deny: (n) => (n >= 2 ? { code: 'item_recovery_budget_exhausted', message: 'esta parte ya gastó USD 0.42' } : null) });
    const e = await err(api('s', 'prompt-budget', 5000));
    assert(e && e.itemBudget === true && e.code === 'item_recovery_budget_exhausted', 'se detiene por presupuesto: ' + JSON.stringify(e));
    assert(a.st.reqs.length === 1, 'el reenvío no salió: ' + a.st.reqs.length);
    await a.close();
  });

  await check('nonStreamMessage: un 200 ilegible es DESCONOCIDO (pudo cobrarse); un 400 es HTTP conocido', async () => {
    const a = await fakeAnthropic(({ prompt }) => (prompt === 'g' ? 'garbage' : { status: 400 }));
    const call = (p) => nonStreamMessage({ apiKey: 'k', baseUrl: a.url, body: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: p }] }, idleMs: 1000, totalMs: 5000 });
    const e1 = await err(call('g'));
    assert(e1 && e1.kind === 'unknown' && e1.extra.cause === 'unreadable_body', 'ilegible: ' + (e1 && e1.kind));
    const e2 = await err(call('x'));
    assert(e2 && e2.kind === 'http' && e2.extra.status === 400, '400: ' + (e2 && e2.kind));
    await a.close();
  });

  await check('streamMessage: el corte trae causa, caracteres recibidos y si llegó el usage final', async () => {
    const a = await fakeAnthropic(() => 'cut');
    const e = await err(streamMessage({ apiKey: 'k', baseUrl: a.url, body: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'z' }] }, idleMs: 2000, totalMs: 5000 }));
    assert(e && e.kind === 'cut' && /^socket:/.test(e.extra.cause) && e.extra.partialChars === 30 && e.extra.sawUsageDelta === false && e.extra.messageId, JSON.stringify(e && e.extra));
    await a.close();
  });

  await check('review I1: sin streaming (producción, sin fetchImpl) usa http de Node: una respuesta que tarda en mandar encabezados llega igual', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'cut' : { delayMs: 1500 }));
    const r = await nonStreamMessage({ apiKey: 'k', baseUrl: a.url, body: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'lento' }] }, idleMs: 200, totalMs: 5000 });
    assert(r.text === FULL && r.stopReason === 'end_turn' && r.messageId, 'llegó entera pese a idleMs=200 (no aplica sin streaming): ' + JSON.stringify(r).slice(0, 120));
    assert(typeof nodeHttpFetch === 'function', 'transporte de Node exportado');
    await a.close();
  });

  await check('review I1: sin streaming, el tope de pared (totalMs) corta y queda DESCONOCIDO (pudo cobrarse), nunca «sin costo»', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'cut' : { delayMs: 2500 }));
    const e = await err(nonStreamMessage({ apiKey: 'k', baseUrl: a.url, body: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'muy-lento' }] }, idleMs: 200, totalMs: 600 }));
    assert(e && e.kind === 'unknown' && e.extra.cause === 'timeout_total', 'desconocido por tope total: ' + (e && e.kind) + ' ' + (e && e.extra && e.extra.cause));
    await a.close();
  });

  await check('review m5: si el corte llegó DESPUÉS del usage final, se cobra la salida real (no el tope)', async () => {
    const a = await fakeAnthropic(({ stream }) => (stream ? 'cut_after_delta' : 'ok'));
    const w = fakeWorld(); const api = makeApi(w, a.url);
    await api('s', 'prompt-delta', 5000);
    const cut = w.charges.find((c) => c.metadata && c.metadata.streamCut);
    assert(cut && cut.metadata.streamCut.sawUsageDelta === true && cut.metadata.streamCut.receivedOutputTokens === 40, 'evidencia: ' + JSON.stringify(cut && cut.metadata.streamCut));
    const out = JSON.stringify(cut.usage || cut);
    assert(!/5000/.test(out), 'no se cobró el tope (5000) teniendo la salida real: ' + out.slice(0, 200));
    await a.close();
  });

  await check('priorStreamCut: falla abierta (una lectura caída no bloquea: el primer envío vuelve a ser por streaming)', async () => {
    const w = fakeWorld({ priorCutThrows: true });
    assert((await priorStreamCut(w.ds, ITEM.itemRunId, new Date(0))) === false, 'false ante error');
    const w2 = fakeWorld({ priorCut: true });
    assert((await priorStreamCut(w2.ds, ITEM.itemRunId, new Date(0))) === true, 'true con corte previo');
  });

  await check('clasificador: llm_output_cut_repeated es una excepción EXPLÍCITA (D, hold_for_human, causa en el mensaje), no un «unclassified»', async () => {
    const v = classifyFailure({ error: `${LLM_OUTPUT_CUT_REPEATED}: la respuesta de la IA se cortó 2 veces en la misma solicitud (socket:UND_ERR_SOCKET)`, itemType: 'activity' });
    assert(v && v.unclassified === false && v.class === 'D' && v.strategy === 'hold_for_human', JSON.stringify(v));
  });

  console.log(`\n${failures ? 'HAY FALLOS' : 'TODO OK'} (${passes} ✅, ${failures} ❌).`);
  process.exit(failures ? 1 : 0);
})();
