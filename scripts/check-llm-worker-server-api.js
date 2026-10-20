#!/usr/bin/env node
/* eslint-disable */
// Loop 4 (review I1/I2/I3/I6/M2): api() del worker de IA — reservas, desconocidos por llamada, HTTP conocido vs
// ambiguo, liquidación que falla, devolución por drenaje y guardados ilegibles. Ledger y DB falsos en memoria,
// Anthropic falso en 127.0.0.1 (USD 0). Usage: npm run build && node scripts/check-llm-worker-server-api.js [dist]
const http = require('http');
const path = require('path');
const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const { createServerApi, LLM_UNKNOWN_MAX, cachedUserContent } = require(path.join(distRoot, 'workers/llm-executor/server-llm.js'));

let passes = 0; let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); }
  catch (e) { failures++; console.error(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : JSON.stringify(e)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sse = (t, o) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...o })}\n\n`;
const ITEM = { itemRunId: '11111111-2222-4333-8444-555555555555', runId: '99999999-2222-4333-8444-555555555555', itemKey: 'content:x', attempt: 1, generation: 1, ownerId: 'owner-1', artifactCourseId: '7', manifestId: 3 };

/** Anthropic falso: `plan(prompt)` → 'ok' | 'drop' | {status} | 'hold'. */
async function fakeAnthropic(plan) {
  const st = { requests: [] };
  const held = [];
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    st.bodies = st.bodies || []; st.bodies.push(body);
    const c0 = body.messages[0].content;
    const prompt = Array.isArray(c0) ? c0.map((b) => b.text).join('') : c0;
    st.requests.push(prompt);
    const p = plan(prompt, st.requests.filter((x) => x === prompt).length);
    if (p === 'drop') { req.socket.destroy(); return; }
    if (p && p.status) { res.writeHead(p.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'x', message: 'fake ' + p.status } })); return; }
    const send = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse('message_start', { message: { id: 'msg_' + st.requests.length, model: 'm', usage: { input_tokens: 10, output_tokens: 1 } } }));
      res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'R:' + prompt } }));
      res.write(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }));
      res.end(sse('message_stop', {}));
    };
    if (p && p.holdMs) setTimeout(send, p.holdMs); else send();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, st, close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => r()); }) };
}

/** Ledger + DB falsos: reservas en memoria; el SQL del conteo de desconocidos se interpreta. */
function fakeWorld(opts = {}) {
  const res = new Map(); // key → { tag, settled, reason }
  const cps = {};
  const store = new Map();
  let settleFailures = opts.settleFailures || 0;
  const like = (pat) => new RegExp('^' + pat.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  const ds = {
    async query(sql, params) {
      if (sql.includes('count(*)::int as n')) {
        const [keyLike, tagLike, , exclude] = params;
        const n = [...res.entries()].filter(([k, v]) => like(keyLike).test(k) && like(tagLike).test(v.tag) && !v.settled && !exclude.includes(k)).length;
        return [{ n }];
      }
      // r62: reservas desconocidas (sin liquidar) de UNA llamada → el próximo envío es el reenvío ambiguo de la parte.
      if (sql.includes('e.idempotency_key as key, e.amount::text as amount')) {
        const [keyLike, tagLike, , exclude] = params;
        return [...res.entries()].filter(([k, v]) => like(keyLike).test(k) && like(tagLike).test(v.tag) && !v.settled && !exclude.includes(k))
          .map(([k]) => ({ key: k, amount: '0.01' }));
      }
      if (sql.includes('generation_item_runs')) return [{ since: new Date(0).toISOString(), cps: { ...cps } }];
      throw new Error('SQL inesperado: ' + sql.slice(0, 80));
    },
  };
  const finops = {
    async recordCharge(i) { res.set(i.idempotencyKey, { tag: i.metadata.callTag, settled: false }); return {}; },
    async recordAdjustment() { return {}; }, async recordZero() { return {}; },
    async settleReservation(key, charge, reason) {
      if (settleFailures > 0) { settleFailures--; throw new Error('db blip'); }
      const r = res.get(key); r.settled = true; r.reason = reason; r.charged = !!charge;
      return { finalInserted: !!charge, finalEvent: null };
    },
  };
  return { res, cps, store, ds, finops };
}

function makeApi(w, url, extra = {}) {
  return createServerApi({
    dataSource: w.ds, finops: w.finops, budget: { guardServerLlmCall: async () => null },
    checkpoints: { put: async (p, j) => { w.store.set(p, j); }, get: async (p) => (w.store.has(p) ? w.store.get(p) : null) },
    recordCheckpoint: async (_id, e) => { Object.assign(w.cps, e); return true; },
    apiKey: 'k', baseUrl: url, defaultModel: 'm', idleMs: 3000, totalMs: 10000,
    logger: { log() {}, warn() {}, error() {} }, settleRetryDelaysMs: [0, 0], ...extra,
  }, ITEM, () => ({ callRole: 'main', attempt: 1 }));
}
const pending = (w) => [...w.res.values()].filter((v) => !v.settled).length;
async function err(p) { try { await p; return null; } catch (e) { return e; } }

(async () => {
  await check('I2: un 503 de Anthropic es un resultado CONOCIDO → la reserva se libera y nunca cuenta como desconocido', async () => {
    const a = await fakeAnthropic(() => ({ status: 503 }));
    const w = fakeWorld(); const api = makeApi(w, a.url);
    for (let i = 0; i < 3; i++) { const e = await err(api('s', 'p503')); assert(e && e.fatal === false && !e.pendingReview, 'transitorio, no revisión: ' + JSON.stringify(e)); }
    assert(pending(w) === 0, 'reservas pendientes: ' + pending(w));
    assert([...w.res.values()].every((v) => v.reason === 'llm_worker_rejected_503' && !v.charged), 'liberadas sin cobro');
    await a.close();
  });
  await check('I2: un 400 también libera su reserva (no queda gasto fantasma en el presupuesto de la parte)', async () => {
    const a = await fakeAnthropic(() => ({ status: 400 }));
    const w = fakeWorld(); const api = makeApi(w, a.url);
    const e = await err(api('s', 'p400'));
    assert(e && e.fatal === true, 'fatal');
    assert(pending(w) === 0, 'liberada');
    await a.close();
  });
  await check('I2: 504 (timeout de gateway) = DESCONOCIDO → un reintento automático; el 2.º de la misma llamada → revisión', async () => {
    const a = await fakeAnthropic(() => ({ status: 504 }));
    const w = fakeWorld(); const api = makeApi(w, a.url);
    const e = await err(api('s', 'p504'));
    assert(e && e.pendingReview === true, 'revisión: ' + JSON.stringify(e));
    assert(a.st.requests.length === LLM_UNKNOWN_MAX, 'exactamente 2 pedidos: ' + a.st.requests.length);
    assert(pending(w) === 2, 'dos reservas pendientes para conciliar');
    await a.close();
  });
  // r62 (regla de ambigüedad acotada, punto 3 — cambio DELIBERADO de la regla Loop-4 «una vez por llamada»): nunca más de
  // UN reenvío ambiguo por PARTE. El desconocido de A se reenvía una vez; un desconocido más (B) en la misma ventana deja
  // la parte en revisión (excepción registrada) sin volver a pedir.
  await check('r62 regla por parte: un desconocido en la llamada A → UN reenvío; otro desconocido en la B → revisión (nunca un 2.º reenvío ambiguo en la parte)', async () => {
    const a = await fakeAnthropic((p, n) => (n === 1 ? 'drop' : 'ok'));
    const w = fakeWorld(); const api = makeApi(w, a.url);
    assert((await api('s', 'A')) === 'R:A', 'A completa con su reenvío único');
    const e = await err(api('s', 'B'));
    assert(e && e.pendingReview === true, 'B → revisión: ' + JSON.stringify(e));
    assert(a.st.requests.length === 3 && pending(w) === 2, `3 pedidos / 2 pendientes (${a.st.requests.length}/${pending(w)})`);
    await a.close();
  });
  await check('I1: llamadas EN VUELO en paralelo no cuentan como desconocidas (huérfanas de un crash + 3 carriles nuevos)', async () => {
    const a = await fakeAnthropic(() => ({ holdMs: 300 }));
    const w = fakeWorld();
    // r62: con el tope de UN desconocido por parte, una sola huérfana (no tres): la exclusión de los carriles en vuelo es lo que se prueba.
    for (let i = 0; i < 1; i++) w.res.set(`reservation:llm:${ITEM.itemRunId}:g1:a1:llmw-main-orphan${i}-1-x`, { tag: `llmw-main-orphan${i}xxxxx-1-x`, settled: false });
    const api = makeApi(w, a.url);
    const out = await Promise.all(['L1', 'L2', 'L3'].map((p) => err(api('s', p))));
    assert(out.every((x) => x === null), 'ningún carril fue a revisión: ' + JSON.stringify(out));
    assert(pending(w) === 1, 'solo queda la huérfana');
    await a.close();
  });
  await check('tope por parte (r62: LLM_UNKNOWN_ITEM_MAX = 2): 2 desconocidos en total en la parte (llamadas distintas) → revisión', async () => {
    const a = await fakeAnthropic(() => 'ok');
    const w = fakeWorld();
    for (let i = 0; i < 2; i++) w.res.set(`reservation:llm:${ITEM.itemRunId}:g1:a1:o${i}`, { tag: `llmw-main-zzzz${i}-1-x`, settled: false });
    const e = await err(makeApi(w, a.url)('s', 'nueva'));
    assert(e && e.pendingReview === true && a.st.requests.length === 0, 'revisión sin llamar');
    await a.close();
  });
  await check('I6: la liquidación falla tras una respuesta OK → la respuesta se usa, NO se vuelve a pedir; la misma llamada sale del guardado', async () => {
    const a = await fakeAnthropic(() => 'ok');
    const w = fakeWorld({ settleFailures: 10 }); const api = makeApi(w, a.url);
    assert((await api('s', 'P')) === 'R:P', 'texto devuelto');
    assert(a.st.requests.length === 1 && pending(w) === 1, 'un solo pedido; reserva pendiente para conciliar');
    assert((await api('s', 'P')) === 'R:P' && a.st.requests.length === 1, 'segunda vez desde el guardado, sin pedido');
    await a.close();
  });
  await check('I6: la liquidación se reintenta y, si se recupera, la reserva queda liquidada', async () => {
    const a = await fakeAnthropic(() => 'ok');
    const w = fakeWorld({ settleFailures: 2 }); const api = makeApi(w, a.url);
    assert((await api('s', 'Q')) === 'R:Q' && pending(w) === 0, 'liquidada al 3.er intento');
    await a.close();
  });
  await check('I3: drenaje / lease perdida → ninguna llamada nueva (devolución), sin reserva', async () => {
    const a = await fakeAnthropic(() => 'ok');
    for (const stop of ['worker_draining', 'lease_lost']) {
      const w = fakeWorld(); const api = makeApi(w, a.url, { shouldStop: () => stop });
      const e = await err(api('s', 'D'));
      assert(e && e.handBack === stop && e.fatal === true, 'devolución ' + stop);
      assert(w.res.size === 0, 'sin reserva');
    }
    assert(a.st.requests.length === 0, 'sin pedidos');
    await a.close();
  });
  await check('M2: un guardado ilegible se trata como inexistente (se genera de nuevo, una vez)', async () => {
    const a = await fakeAnthropic(() => 'ok');
    const w = fakeWorld(); const api = makeApi(w, a.url);
    await api('s', 'C');
    for (const k of w.store.keys()) w.store.set(k, '{roto');
    assert((await api('s', 'C')) === 'R:C' && a.st.requests.length === 2, 'regenerada');
    await a.close();
  });
  await check('O5 (Loop 6): cachePrefix → bloques byte-idénticos con cache_control solo en el prefijo; el reintento (original + errores) usa el mismo prefijo; el punto de guardado distingue las llamadas', async () => {
    const orig = 'PROMPT ORIGINAL ' + 'x'.repeat(50);
    const retry = orig + ' + ERRORES';
    const b = cachedUserContent(retry, { cachePrefix: orig });
    assert(Array.isArray(b) && b.length === 2 && b.map((x) => x.text).join('') === retry && b[0].cache_control && !b[1].cache_control, 'bloques');
    assert(cachedUserContent('otro', { cachePrefix: orig }) === 'otro' && cachedUserContent(orig) === orig, 'sin cambios si no coincide / sin opciones');
    const a = await fakeAnthropic(() => 'ok');
    const w = fakeWorld(); const api = createServerApi({
      dataSource: w.ds, finops: w.finops, budget: { guardServerLlmCall: async () => null },
      checkpoints: { put: async (p, j) => { w.store.set(p, j); }, get: async (p) => (w.store.has(p) ? w.store.get(p) : null) },
      recordCheckpoint: async (_id, e) => { Object.assign(w.cps, e); return true; },
      apiKey: 'k', baseUrl: a.url, defaultModel: 'm', idleMs: 3000, totalMs: 10000, logger: { log() {}, warn() {}, error() {} }, settleRetryDelaysMs: [0],
    }, ITEM, () => ({ callRole: 'main', attempt: 1 }));
    assert((await api('s', orig, 100, undefined, 'm', undefined, undefined, { cachePrefix: orig })) === 'R:' + orig, 'principal');
    assert((await api('s', retry, 100, undefined, 'm', undefined, undefined, { cachePrefix: orig })) === 'R:' + retry, 'reintento');
    const [b1, b2] = a.st.bodies.map((x) => x.messages[0].content);
    assert(Array.isArray(b1) && b1.length === 1 && b1[0].cache_control && b1[0].text === orig, 'principal = un bloque cacheable');
    assert(Array.isArray(b2) && b2[0].text === orig && b2[0].cache_control && b2[1].text === ' + ERRORES', 'reintento = mismo prefijo + resto');
    assert(a.st.requests.length === 2, 'dos llamadas distintas (el punto de guardado no confunde el reintento con la principal)');
    await a.close();
  });
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})();
