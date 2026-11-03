#!/usr/bin/env node
/* eslint-disable */
// r83 (incidente curso 91, 2026-11-02: cortes de red intermitentes del VPS dejaron una Actividad y el Examen final en
// `llm_pending_review`) — worker de IA:
//  1. reenvíos ambiguos acotados por DINERO (presupuesto de la parte + holgura de ambigüedad, saldo del run) con tope
//     duro de 3 eventos por parte;
//  2. reapertura automática ÚNICA de una parte en revisión (12 min, sonda de salud sin costo, reservas consistentes);
//  3. los puntos de guardado sobreviven a un reintento manual (solo el descarte los invalida);
//  4. un corte NO pasa la parte entera a sin streaming (solo esa llamada); keepalive TCP en el stream;
//  5. pausa corta del run ante una ráfaga de cortes (sin consumir intentos);
//  6. prior de costo de `activity` recalibrado (p90);
//  7. lastBrowserActivityAt solo cuenta partes del navegador; `executor` por parte;
//  8. telemetría del corte (causa, bytes, duración, request-id).
// Ledger/DB falsos en memoria, Anthropic falso en 127.0.0.1 (USD 0). Postgres 16 descartable para el SQL nuevo (si está).
// Usage: npm run build && node scripts/check-r83-llm.js [dist]
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const load = (p) => require(path.join(distRoot, p));
const SL = load('workers/llm-executor/server-llm.js');
const AS = load('workers/llm-executor/anthropic-stream.js');
const G = load('modules/finops/run-spend-guard.js');
const RO = load('modules/dynamic-generation/llm-pending-review-reopen.js');
const LW = load('workers/dynamic-llm-worker.js');
const FC = load('modules/reliability/failure-classifier.js');

let passes = 0; let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); }
  catch (e) { failures++; console.error(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n   ') : JSON.stringify(e)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
const near = (a, b, m) => { if (Math.abs(a - b) > 1e-6) throw new Error(`${m}: esperado ${b}, encontrado ${a}`); };
const sse = (t, o) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...o })}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function err(p) { try { return { v: await p, e: null }; } catch (e) { return { v: null, e }; } }
const ITEM = { itemRunId: '11111111-2222-4333-8444-838383838383', runId: '99999999-2222-4333-8444-838383838383', itemKey: 'activity:cap2', attempt: 2, generation: 1, ownerId: 'owner-1', artifactCourseId: '91', manifestId: 3 };
const FULL = JSON.stringify({ title: 'Caso', decisions: [{ q: '¿Qué haces primero?', options: ['A', 'B'] }] });

/** Anthropic falso. `plan({ stream, n, prompt })` → 'ok' | 'cut' | 'drop' | {status}. */
async function fakeAnthropic(plan) {
  const st = { reqs: [] };
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    if (req.method === 'GET') { st.reqs.push({ get: req.url }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
    const body = JSON.parse(raw);
    const c0 = body.messages[0].content;
    const prompt = Array.isArray(c0) ? c0.map((b) => b.text).join('') : c0;
    const stream = body.stream === true;
    st.reqs.push({ stream, prompt });
    const n = st.reqs.filter((x) => x.prompt === prompt).length;
    const p = plan({ stream, n, prompt });
    if (p === 'drop') { req.socket.destroy(); return; }
    if (p && p.status) { res.writeHead(p.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'x', message: 'fake' } })); return; }
    const id = 'msg_' + st.reqs.length;
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_' + st.reqs.length });
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: FULL }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 40 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_' + st.reqs.length });
    res.write(sse('message_start', { message: { id, model: 'm', usage: { input_tokens: 100, output_tokens: 1 } } }));
    res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: FULL.slice(0, 30) } }));
    if (p === 'cut') { await sleep(30); res.socket.destroy(); return; }
    res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: FULL.slice(30) } }));
    res.write(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }));
    res.end(sse('message_stop', {}));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, st, close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => r()); }) };
}

/**
 * Ledger + DB falsos que respetan las ventanas (`since` de las consultas) y el dinero: cada reserva vale `amount` (cota de
 * una llamada); una respuesta medida cuesta `measured`. itemSpent = reservas abiertas + posibles duplicados + medidas.
 */
function fakeWorld(o = {}) {
  const res = new Map(); // key → { tag, at, amount, settled, possibleDuplicate, charged, released }
  const cps = { ...(o.cps || {}) };
  const store = new Map(Object.entries(o.store || {}));
  const charges = [];
  const events = [];
  const like = (pat) => new RegExp('^' + pat.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  const w = {
    res, cps, store, charges, events, health: o.health || null, priorSpent: o.priorSpent || 0,
    win: { since: o.since || new Date(0), cp_since: o.cpSince || o.since || new Date(0), unknown_since: o.unknownSince || o.since || new Date(0) },
    spent() {
      let t = w.priorSpent;
      for (const v of res.values()) { if (v.released) continue; t += v.charged ? (o.measured ?? 0.05) : v.amount; }
      return t;
    },
  };
  w.ds = {
    sql: [],
    async query(sql, params) {
      w.ds.sql.push(sql);
      if (sql.includes('select now() as db_now')) return [{ db_now: new Date().toISOString() }];
      if (sql.includes('stream_cut_seen')) {
        const cuts = charges.filter((c) => c.metadata && c.metadata.streamCut);
        return [{ stream_cut_seen: cuts.length > 0, stream_cut_count: cuts.length, stream_cut_hashes: [...new Set(cuts.map((c) => c.metadata.streamCut.callHash))] }];
      }
      if (sql.includes('llm_transport_events')) {
        const h = w.health;
        return [{ llm_transport_events: h ? h.events : 0, llm_transport_items: h ? h.items : 0, llm_transport_since_last_ms: h ? h.sinceLastMs : null }];
      }
      if (sql === SL.LLM_TRANSPORT_EVENT_SQL) { events.push(JSON.parse(params[1])); return [{ id: params[0] }]; }
      const inWin = (k, v, keyLike, tagLike, since) => like(keyLike).test(k) && like(tagLike).test(v.tag) && v.at >= new Date(since).getTime();
      if (sql.includes('count(*)::int as n')) {
        const [keyLike, tagLike, since, exclude] = params;
        return [{ n: [...res.entries()].filter(([k, v]) => inWin(k, v, keyLike, tagLike, since) && ((!v.settled) || v.possibleDuplicate) && !exclude.includes(k)).length }];
      }
      if (sql.includes('e.idempotency_key as key, e.amount::text as amount')) {
        const [keyLike, tagLike, since, exclude, includePd] = params;
        return [...res.entries()].filter(([k, v]) => inWin(k, v, keyLike, tagLike, since) && (!v.settled || (includePd && v.possibleDuplicate)) && !exclude.includes(k))
          .map(([k, v]) => ({ key: k, amount: String(v.amount), settled: !!v.settled, send_marked: false, created_at: new Date(v.at).toISOString() }));
      }
      if (sql.includes('generation_item_runs')) return [{ since: w.win.since.toISOString(), cp_since: w.win.cp_since.toISOString(), unknown_since: w.win.unknown_since.toISOString(), cps: { ...cps }, sent: {} }];
      throw new Error('SQL inesperado: ' + sql.slice(0, 80));
    },
  };
  w.finops = {
    async recordCharge(i) { res.set(i.idempotencyKey, { tag: i.metadata.callTag, at: Date.now(), amount: o.amount ?? 0.126, settled: false }); return {}; },
    async recordAdjustment() { return {}; }, async recordZero() { return {}; },
    async reconcileReservationAsCharged(key, reason, opt) {
      const r = res.get(key);
      if (!r || r.settled) return { reconciled: false, alreadySettled: true, amount: '0', event: null };
      Object.assign(r, { settled: true, possibleDuplicate: !!(opt && opt.metadata && opt.metadata.possibleDuplicate), reason });
      return { reconciled: true, alreadySettled: false, amount: String(r.amount), event: null };
    },
    async settleReservation(key, charge, reason) {
      const r = res.get(key); r.settled = true; r.reason = reason;
      if (charge) { r.charged = true; charges.push(charge); } else r.released = true;
      return { finalInserted: !!charge, finalEvent: null };
    },
  };
  // Presupuesto con las funciones PURAS reales (mismo cálculo que FinopsBudgetService).
  const expected = o.expected ?? 0.049; const estMax = o.estMax ?? 0.10; const authorized = o.authorized ?? 19.65;
  const largest = () => Math.max(0, ...[...res.values()].map((v) => v.amount));
  w.budgetCalls = []; w.guardCalls = [];
  w.budget = {
    async ambiguousResendBudget(a) {
      w.budgetCalls.push(a);
      const hard = G.itemHardLimit(expected, estMax, Math.max(a.nextCost, largest()));
      const calls = Math.max(0, Math.floor(a.allowanceCalls || 0));
      const allowance = calls * (largest() || a.nextCost);
      return G.ambiguousResendBudget({ itemSpent: w.spent(), nextCost: a.nextCost, itemHardLimit: hard, runSpent: w.spent() + (o.otherRunSpent || 0), authorizedBudget: authorized, allowance });
    },
    async guardServerLlmCall(a) {
      w.guardCalls.push(a);
      const d = G.decideRunSpend({ authorizedBudget: authorized, runSpent: w.spent() + (o.otherRunSpent || 0), nextCost: o.amount ?? 0.126, itemSpent: w.spent(), itemExpected: expected,
        itemEstimatedMax: estMax, runExpected: null, progressExpected: null, itemLargestCall: largest(), itemExtraAllowance: a.itemExtraAllowanceUsd });
      if (d.allow) return null;
      if (d.reason === 'item_recovery_budget_exhausted') return { code: 'item_recovery_budget_exhausted', message: d.detail, runId: a.runId, paused: false };
      return { code: 'run_paused', message: d.detail, runId: a.runId, paused: true };
    },
  };
  return w;
}

function makeApi(w, url, extra = {}) {
  const logs = [];
  const api = SL.createServerApi({
    dataSource: w.ds, finops: w.finops, budget: w.budget,
    checkpoints: { put: async (p, j) => { w.store.set(p, j); }, get: async (p) => (w.store.has(p) ? w.store.get(p) : null) },
    recordCheckpoint: async (_id, e) => { Object.assign(w.cps, e); return true; },
    apiKey: 'k', baseUrl: url, defaultModel: 'm', idleMs: 3000, totalMs: 10000,
    logger: { log() {}, warn(m) { logs.push(m); }, error(m) { logs.push(m); } }, settleRetryDelaysMs: [0, 0], ...extra,
  }, { ...ITEM, ...(extra.item || {}) }, () => ({ callRole: 'main', attempt: 1 }));
  return Object.assign(api, { logs });
}

// ── Postgres 16 descartable (SQL nuevo) ─────────────────────────────────────────────────────────────────────────────
function findPgBin() {
  for (const d of [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean)) {
    const pg = path.join(d, 'postgres');
    if (fs.existsSync(pg) && /\b16\./.test(spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '')) return d;
  }
  return null;
}
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
  // ═══ 1. dinero, no conteo ═══════════════════════════════════════════════════════════════════════════════════════
  await check('1a puro: el caso real de la Actividad (gastado 0,219 + pendiente 0,126 + reenvío 0,126 = 0,47 > límite 0,43) NO entraba; con la holgura de ambigüedad (2 × 0,126) entra; el saldo del run sigue siendo techo duro', () => {
    const hard = G.itemHardLimit(0.049, 0.10, 0.126);
    near(hard, 0.049 + 3 * 0.126, 'límite de la parte ≈ 0,427');
    const base = { itemSpent: 0.219 + 0.126, nextCost: 0.126, itemHardLimit: hard, runSpent: 10, authorizedBudget: 19.65 };
    const r62 = G.ambiguousResendBudget(base);
    assert(!r62.fits && r62.reason === 'item_recovery_budget' && Math.abs(r62.worstItem - 0.471) < 1e-9, 'r62: no entraba ' + JSON.stringify(r62));
    eq(G.AMBIGUOUS_RESEND_ALLOWANCE_CALLS, 2, 'holgura = 2 llamadas');
    const r83 = G.ambiguousResendBudget({ ...base, allowance: 2 * 0.126 });
    assert(r83.fits && r83.allowance > 0.25, 'r83: entra con la holgura ' + JSON.stringify(r83));
    const capped = G.ambiguousResendBudget({ ...base, allowance: 2 * 0.126, runSpent: 19.6 });
    assert(!capped.fits && capped.reason === 'run_budget', 'el saldo autorizado del run nunca se excede: ' + JSON.stringify(capped));
    // El guard de la llamada del reenvío usa la MISMA holgura (solo esa llamada).
    const g0 = G.decideRunSpend({ authorizedBudget: 19.65, runSpent: 10, nextCost: 0.126, itemSpent: 0.45, itemExpected: 0.049, itemEstimatedMax: 0.10, runExpected: null, progressExpected: null, itemLargestCall: 0.126 });
    const g1 = G.decideRunSpend({ authorizedBudget: 19.65, runSpent: 10, nextCost: 0.126, itemSpent: 0.45, itemExpected: 0.049, itemEstimatedMax: 0.10, runExpected: null, progressExpected: null, itemLargestCall: 0.126, itemExtraAllowance: 0.252 });
    assert(!g0.allow && g1.allow, 'guard: sin holgura niega, con la holgura del reenvío permite');
  });

  await check('1b worker: la Actividad del incidente (a1 gastó 0,219 por validación) + un desconocido → el reenvío entra (holgura) y la parte completa; el guard de ESA llamada recibe la holgura', async () => {
    const a = await fakeAnthropic(({ n }) => (n === 1 ? 'drop' : 'ok'));
    const w = fakeWorld({ priorSpent: 0.219 });
    const api = makeApi(w, a.url);
    const r = await err(api('s', 'act-main', 4000));
    assert(!r.e && r.v === FULL, 'completa: ' + JSON.stringify(r.e));
    eq(a.st.reqs.length, 2, 'original + reenvío');
    assert(w.budgetCalls.length === 1 && w.budgetCalls[0].allowanceCalls === 2, 'pide la holgura de 2 llamadas');
    assert(w.guardCalls.length === 2 && !w.guardCalls[0].itemExtraAllowanceUsd && Math.abs(w.guardCalls[1].itemExtraAllowanceUsd - 0.252) < 1e-9, 'solo el reenvío lleva la holgura: ' + JSON.stringify(w.guardCalls.map((g) => g.itemExtraAllowanceUsd)));
    assert([...w.res.values()].filter((v) => v.possibleDuplicate).length === 1, 'la perdida quedó cobrada como posible duplicado (no liberada)');
    await a.close();
  });

  await check('1c worker: reenvíos mientras el peor caso entra; el que ya no entra → revisión por presupuesto (antes del tope de eventos)', async () => {
    const a = await fakeAnthropic(() => 'drop');
    const w = fakeWorld({ priorSpent: 0.40 });
    const api = makeApi(w, a.url);
    const r = await err(api('s', 'money', 4000));
    assert(r.e && r.e.pendingReview && /no entra en el presupuesto autorizado/.test(r.e.msg), 'revisión por dinero: ' + JSON.stringify(r.e));
    // u1: 0,40 + 0,126 + 0,126 = 0,652 ≤ 0,679 → reenvío; u2: 0,40 + 0,252 + 0,126 = 0,778 > 0,679 → no.
    eq(a.st.reqs.length, 2, 'un reenvío (el segundo ya no entraba)');
    eq(FC.classifyFailure({ error: r.e.msg, source: 'server_executor' }).humanReason, 'budget', 'excepción de presupuesto');
    await a.close();
  });

  await check('1d worker: saldo del run casi agotado → ningún reenvío (techo duro), aunque la parte tenga holgura', async () => {
    const a = await fakeAnthropic(() => 'drop');
    const w = fakeWorld({ authorized: 1.0, otherRunSpent: 0.80 });
    const r = await err(makeApi(w, a.url)('s', 'runcap', 4000));
    assert(r.e && r.e.pendingReview && /run_budget/.test(r.e.msg), 'revisión por el saldo del run: ' + JSON.stringify(r.e));
    eq(a.st.reqs.length, 1, 'sin reenvío');
    await a.close();
  });

  await check('1e worker: con dinero de sobra, tope duro de 3 eventos ambiguos por parte — A, B y C (eventos 1–3) se reenvían y completan; D (4.º evento) → revisión sin reenviar', async () => {
    const a = await fakeAnthropic(({ n }) => (n === 1 ? 'drop' : 'ok'));
    const w = fakeWorld({ expected: 10, estMax: 10 });
    const api = makeApi(w, a.url);
    eq([SL.LLM_UNKNOWN_EVENT_MAX, SL.llmAmbiguousEventMax({}), SL.llmUnknownPerCallMax({})], [3, 3, 3], 'tope de eventos 3 / por llamada 3');
    for (const p of ['A', 'B', 'C']) { const r = await err(api('s', p, 4000)); assert(!r.e, `${p} completa: ${JSON.stringify(r.e)}`); await sleep(5); }
    const d = await err(api('s', 'D', 4000));
    assert(d.e && d.e.pendingReview && /4 eventos ambiguos/.test(d.e.msg) && /tope 3/.test(d.e.msg), 'D → revisión: ' + JSON.stringify(d.e));
    eq(a.st.reqs.length, 7, 'A2 + B2 + C2 + D1');
    // Legacy explícito: DYNAMIC_LLM_AMBIGUOUS_EVENT_MAX=1 vuelve a la regla r62.
    eq([SL.llmAmbiguousEventMax({ DYNAMIC_LLM_AMBIGUOUS_EVENT_MAX: '1' }), SL.llmUnknownPerCallMax({ DYNAMIC_LLM_AMBIGUOUS_EVENT_MAX: '1' }), SL.llmAmbiguousEventMax({ DYNAMIC_LLM_AMBIGUOUS_EVENT_MAX: '9' })], [1, 2, 3], 'env acotado 1–5');
    await a.close();
  });

  await check('1f eventos: varias detecciones en el mismo intento se agrupan por solapamiento (antes solo había 2 grupos posibles)', () => {
    const t = (ms) => new Date(Date.UTC(2026, 10, 2, 20, 0, 0) + ms);
    eq(SL.countUnknownEvents([{ attempt: 1, createdAt: t(0) }, { attempt: 1, createdAt: t(1) }, { attempt: 1, createdAt: t(2) }], 1, [t(10)]), 1, '3 en paralelo = 1 evento');
    eq(SL.countUnknownEvents([{ attempt: 1, createdAt: t(0) }, { attempt: 1, createdAt: t(20) }, { attempt: 1, createdAt: t(40) }], 1, [t(10), t(30), t(50)]), 3, '3 en momentos distintos = 3 eventos');
    eq(SL.countUnknownEvents([{ attempt: 1, createdAt: t(0) }, { attempt: 1, createdAt: t(20) }], 1, t(10)), 2, 'compat: una sola fecha');
  });

  // ═══ 2. reapertura automática única ══════════════════════════════════════════════════════════════════════════════
  await check('2a decisión pura: solo llm_pending_review por desconocidos, una vez, tras 12 min, con sonda sana; la variante de presupuesto queda para un humano', () => {
    const now = new Date('2026-11-02T21:20:00Z');
    const row = (o = {}) => ({ status: 'failed', type: 'final_exam', error: 'llm_pending_review: resultado ambiguo repetido de la IA (2 eventos ambiguos …)', output_summary: { llmPendingReview: { reason: 'unknown_limit' } }, finished_at: '2026-11-02T21:02:04Z', ...o });
    const ok = { ok: true, reason: 'recent_success', recentFailures: 0, recentSuccesses: 4 };
    eq(RO.LLM_REVIEW_REOPEN_DELAY_SECONDS, 720, 'espera 12 min');
    eq(RO.llmReviewReopenDecision(row(), now, { maxAgeHours: 24, health: ok }), { heal: true, round: 1 }, 'reabre');
    eq(RO.llmReviewReopenDecision(row({ finished_at: '2026-11-02T21:15:00Z' }), now, { maxAgeHours: 24, health: ok }).reason, 'backoff', 'antes de 12 min espera');
    eq(RO.llmReviewReopenDecision(row({ output_summary: { llmPendingReviewReopen: { rounds: 1 } } }), now, { maxAgeHours: 24, health: ok }).reason, 'cap_reached', 'UNA vez');
    eq(RO.llmReviewReopenDecision(row({ error: 'llm_pending_review: … (el reenvío no entra en el presupuesto autorizado (item_recovery_budget …))' }), now, { maxAgeHours: 24, health: ok }).reason, 'over_budget', 'presupuesto → humano');
    eq(RO.llmReviewReopenDecision(row(), now, { maxAgeHours: 24, health: { ok: false, reason: 'recent_failures', recentFailures: 2, recentSuccesses: 0 } }).reason, 'provider_unhealthy', 'sonda mala → espera');
    eq(RO.llmReviewReopenDecision(row({ error: 'validation_invalid: …' }), now, { maxAgeHours: 24, health: ok }).reason, 'not_pending_review', 'otro error no');
  });

  await check('2b sonda sin costo: cortes recientes → no; llamada medida reciente → sí; sin tráfico → GET /v1/models (nunca una llamada de generación)', async () => {
    const q = (f, s) => ({ async query(sql) { assert(/llm_health_failures/.test(sql) && /llm_health_successes/.test(sql), 'una sola consulta'); return [{ llm_health_failures: f, llm_health_successes: s }]; } });
    eq((await RO.llmProviderHealthProbe(q(2, 9), { reachable: async () => true })).reason, 'recent_failures', 'cortes recientes ganan');
    eq((await RO.llmProviderHealthProbe(q(0, 3))).ok, true, 'llamadas medidas recientes = sano');
    eq((await RO.llmProviderHealthProbe(q(0, 0))).reason, 'no_evidence', 'sin tráfico ni sonda de red → no');
    eq((await RO.llmProviderHealthProbe({ async query() { throw new Error('db'); } })).reason, 'probe_error', 'lectura caída → no');
    const a = await fakeAnthropic(() => 'ok');
    const reach = await RO.anthropicReachable({ apiKey: 'k', baseUrl: a.url });
    assert(reach && a.st.reqs.length === 1 && a.st.reqs[0].get === '/v1/models?limit=1', 'GET de listado, sin generar: ' + JSON.stringify(a.st.reqs));
    eq(await RO.anthropicReachable({ apiKey: '', baseUrl: a.url }), false, 'sin API key → sin evidencia');
    const p = await RO.llmProviderHealthProbe(q(0, 0), { reachable: () => RO.anthropicReachable({ apiKey: 'k', baseUrl: a.url }) });
    eq([p.ok, p.reason], [true, 'reachable'], 'sin tráfico + alcanzable = sano');
    await a.close();
  });

  await check('2c barrido: reabre UNA vez (reservas desconocidas → posible duplicado, peor caso con holgura dentro del saldo, sin reiniciar el presupuesto); un 2.º barrido no la vuelve a abrir; sonda mala o sin presupuesto → nada se liquida', async () => {
    const RS = load('modules/dynamic-generation/runs.service.js');
    const now = new Date('2026-11-02T21:20:00Z');
    const mk = () => ({ id: 'ir-fe', job_id: 'run-91', item_key: 'final_exam', type: 'final_exam', status: 'failed', error: 'llm_pending_review: resultado ambiguo repetido de la IA (2 eventos ambiguos …)',
      output_summary: { llmPendingReview: { reason: 'unknown_limit' } }, finished_at: new Date('2026-11-02T21:02:04Z'), updated_at: null, created_at: new Date('2026-11-02T20:40:00Z'), course_id: 91, owner_id: 'o', blueprint_number: 1 });
    const fake = (opts) => {
      const st = { rows: [mk()], reservations: [{ key: 'reservation:llm:ir-fe:g1:a1:llmw-continuation-abc-17-x', amount: 0.245, settled: false }], retry: [], declined: [], attention: [], settledKeys: [] };
      const self = {
        logger: { log() {}, warn() {} },
        dataSource: { async query(sql, params) {
          if (/g\.error like 'llm_pending_review%'/.test(sql)) return st.rows.filter((r) => r.status === 'failed' && !(r.output_summary && r.output_summary.llmPendingReviewReopen));
          if (sql.includes('e.idempotency_key as key, e.amount::text as amount')) return st.reservations.filter((r) => !r.settled).map((r) => ({ key: r.key, amount: String(r.amount), settled: false, send_marked: false, created_at: now.toISOString() }));
          if (/'llmPendingReviewReopen'/.test(sql) && /declined/.test(sql)) { st.declined.push(params[1]); st.rows[0].output_summary.llmPendingReviewReopen = { declined: params[1] }; return []; }
          throw new Error('SQL inesperado ' + sql.slice(0, 60));
        } },
        finopsBudget: { async ambiguousResendBudget(a) { st.budgetArgs = a; return opts.budget; } },
        recoveryLedger() { return { async reconcileReservationAsCharged(key) { const r = st.reservations.find((x) => x.key === key); r.settled = true; st.settledKeys.push(key); return { reconciled: true, alreadySettled: false }; } }; },
        async retryItem(...args) { st.retry.push(args); st.rows[0].status = 'pending'; st.rows[0].output_summary.llmPendingReviewReopen = { rounds: 1 }; return {}; },
        async recordAttention(id, reason) { st.attention.push(reason); },
      };
      return { self, st };
    };
    const policy = { maxAgeHours: 24 };
    const good = { ok: true, reason: 'recent_success', recentFailures: 0, recentSuccesses: 3 };
    // OK
    const f1 = fake({ budget: { fits: true, reason: null, worstItem: 2.5, worstRun: 12, allowance: 0.49 } });
    const r1 = await RS.RunsService.prototype.autoReopenLlmPendingReview.call(f1.self, { policy, now, probe: async () => good });
    eq(r1.reopened.length, 1, 'reabierta');
    eq(f1.st.settledKeys, ['reservation:llm:ir-fe:g1:a1:llmw-continuation-abc-17-x'], 'la reserva desconocida quedó cobrada (posible duplicado) ANTES de reabrir');
    assert(f1.st.budgetArgs.nextCost === 0.245 && f1.st.budgetArgs.allowanceCalls === 2 && f1.st.budgetArgs.authorization === 'any', 'peor caso = reenviar lo pendiente, con holgura');
    const auto = f1.st.retry[0][7];
    assert(auto && auto.llmPendingReview && auto.llmPendingReview.health === good && f1.st.retry[0][5] === false && f1.st.retry[0][6] === false, 'retryItem auto.llmPendingReview, sin reenvío a proveedor');
    const r1b = await RS.RunsService.prototype.autoReopenLlmPendingReview.call(f1.self, { policy, now, probe: async () => good });
    eq([r1b.candidates, r1b.reopened.length, f1.st.retry.length], [0, 0, 1], 'una sola vez');
    // Sonda mala
    const f2 = fake({ budget: { fits: true, reason: null } });
    const r2 = await RS.RunsService.prototype.autoReopenLlmPendingReview.call(f2.self, { policy, now, probe: async () => ({ ok: false, reason: 'recent_failures', recentFailures: 3, recentSuccesses: 0 }) });
    eq([r2.reopened.length, f2.st.settledKeys.length, f2.st.declined.length], [0, 0, 0], 'sonda mala: espera, sin liquidar ni rechazar');
    // Sin presupuesto
    const f3 = fake({ budget: { fits: false, reason: 'run_budget', worstItem: 3, worstRun: 20 } });
    const r3 = await RS.RunsService.prototype.autoReopenLlmPendingReview.call(f3.self, { policy, now, probe: async () => good });
    eq([r3.reopened.length, f3.st.settledKeys.length, f3.st.declined[0], f3.st.attention[0]], [0, 0, 'over_budget:run_budget', 'budget'], 'sin saldo: excepción de presupuesto, nada liquidado');
    // Antes de 12 min: ni sonda
    let probed = 0;
    const f4 = fake({ budget: { fits: true, reason: null } });
    f4.st.rows[0].finished_at = new Date('2026-11-02T21:15:00Z');
    const r4 = await RS.RunsService.prototype.autoReopenLlmPendingReview.call(f4.self, { policy, now, probe: async () => { probed++; return good; } });
    eq([r4.reopened.length, probed], [0, 0], 'espera de 12 min');
  });

  await check('2d worker tras la reapertura: los eventos anteriores ya no cuentan (llmUnknownResetAt) pero su dinero SÍ (posible duplicado en el gasto); sin doble cobro', async () => {
    const a = await fakeAnthropic(() => 'ok');
    const reset = new Date(Date.now() - 1000);
    const w = fakeWorld({ unknownSince: reset, expected: 10, estMax: 10 });
    // Dos eventos viejos (intentos 1 y 2) ya liquidados como posible duplicado por el barrido.
    for (const [i, at] of [[1, reset.getTime() - 60_000], [2, reset.getTime() - 30_000]]) w.res.set(`reservation:llm:${ITEM.itemRunId}:g1:a${i}:llmw-main-old${i}`, { tag: `llmw-main-old${i}xxxxxxx-1-x`, at, amount: 0.245, settled: true, possibleDuplicate: true });
    const before = w.spent();
    const r = await err(makeApi(w, a.url, { item: { attempt: 3 } })('s', 'after-reopen', 4000));
    assert(!r.e && r.v === FULL, 'llama y completa: ' + JSON.stringify(r.e));
    assert(Math.abs(before - 0.49) < 1e-9 && w.spent() > before, 'el gasto conservador de las perdidas sigue contado');
    assert([...w.res.values()].filter((v) => v.possibleDuplicate).length === 2 && w.budgetCalls.length === 0, 'nada se volvió a liquidar ni a reenviar como ambiguo');
    await a.close();
  });

  // ═══ 3. guardados vs reintento manual ═════════════════════════════════════════════════════════════════════════════
  await check('3 guardados: un reintento manual (recoveryBudgetResetAt = ahora) NO los invalida (sin llamada, sin costo); un descarte (llmCheckpointsResetAt) sí', async () => {
    const a = await fakeAnthropic(() => 'ok');
    const { body } = SL.serverLlmRequestBody({ system: 's', user: 'bank-1', maxTok: 8000, defaultModel: 'm' });
    const hash = SL.serverLlmRequestHash(body);
    const cpAt = new Date(Date.now() - 3600_000).toISOString();
    const stored = { 'cp/1.json': JSON.stringify({ text: 'BANK-1', usage: { input_tokens: 1 }, stopReason: 'end_turn' }) };
    const w = fakeWorld({ since: new Date(), cpSince: new Date(Date.now() - 7200_000), cps: { [hash]: { path: 'cp/1.json', at: cpAt } }, store: stored });
    const r = await err(makeApi(w, a.url)('s', 'bank-1', 8000));
    assert(r.v === 'BANK-1' && a.st.reqs.length === 0 && w.res.size === 0, 'respondida desde el guardado tras el retry manual: ' + JSON.stringify([r.e, a.st.reqs.length]));
    const w2 = fakeWorld({ since: new Date(), cpSince: new Date(), cps: { [hash]: { path: 'cp/1.json', at: cpAt } }, store: stored });
    const r2 = await err(makeApi(w2, a.url)('s', 'bank-1', 8000));
    assert(r2.v === FULL && a.st.reqs.length === 1, 'descartado → se genera de nuevo');
    // El guardado tardío tampoco depende del reinicio del presupuesto.
    assert(!/recoveryBudgetResetAt/.test(LW.LATE_CHECKPOINT_SQL) && /llmCheckpointsResetAt/.test(LW.LATE_CHECKPOINT_SQL), 'LATE_CHECKPOINT_SQL solo mira el descarte');
    await a.close();
  });

  // ═══ 4. transporte ════════════════════════════════════════════════════════════════════════════════════════════════
  await check('4a un corte NO pasa la parte entera a sin streaming: la llamada cortada se reenvía sin streaming; la siguiente llamada de la parte sigue por stream', async () => {
    const a = await fakeAnthropic(({ stream, prompt, n }) => (stream && prompt === 'bank-A' && n === 1 ? 'cut' : 'ok'));
    const w = fakeWorld({ expected: 10, estMax: 10 });
    const api = makeApi(w, a.url);
    eq(await api('s', 'bank-A', 8000), FULL, 'A llega entera');
    eq(await api('s', 'bank-B', 8000), FULL, 'B llega entera');
    eq(a.st.reqs.map((r) => `${r.prompt}:${r.stream ? 'S' : 'N'}`), ['bank-A:S', 'bank-A:N', 'bank-B:S'], 'solo el reenvío de A va sin streaming');
    eq(SL.LLM_ITEM_NONSTREAM_AFTER_CUTS, 2, 'la parte entera recién con 2 cortes');
    await a.close();
  });

  await check('4b keepalive TCP: el stream de producción (sin fetchImpl) va por http de Node con setKeepAlive(15 s) y clasifica un corte con su telemetría', async () => {
    const calls = [];
    const orig = net.Socket.prototype.setKeepAlive;
    net.Socket.prototype.setKeepAlive = function (on, ms) { calls.push([on, ms]); return orig.call(this, on, ms); };
    try {
      const a = await fakeAnthropic(({ n }) => (n === 1 ? 'cut' : 'ok'));
      const body = { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'ka' }] };
      const e = await err(AS.streamMessage({ apiKey: 'k', baseUrl: a.url, body, idleMs: 3000, totalMs: 10000 }));
      assert(e.e && e.e.kind === 'cut' && e.e.extra.bytes > 0 && e.e.extra.durationMs >= 0 && e.e.extra.requestId === 'req_1' && /^socket:/.test(e.e.extra.cause) && e.e.extra.errorName, 'corte con bytes/duración/causa/request-id: ' + JSON.stringify(e.e && e.e.extra));
      const ok = await AS.streamMessage({ apiKey: 'k', baseUrl: a.url, body, idleMs: 3000, totalMs: 10000 });
      eq(ok.text, FULL, 'stream completo por http de Node');
      // (el servidor HTTP falso de Node también llama setKeepAlive en SUS sockets con su propio retardo: se cuentan los del cliente)
      assert(calls.filter(([on, ms]) => on === true && ms === 15000).length >= 2, 'keepalive 15 s en cada socket del cliente: ' + JSON.stringify(calls));
      eq([AS.llmTcpKeepAliveMs({}), AS.llmTcpKeepAliveMs({ DYNAMIC_LLM_WORKER_TCP_KEEPALIVE_MS: '30000' }), AS.llmTcpKeepAliveMs({ DYNAMIC_LLM_WORKER_TCP_KEEPALIVE_MS: '10' })], [15000, 30000, 15000], 'env acotado');
      const ne = await err(AS.streamMessage({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1', body, idleMs: 3000, totalMs: 10000 }));
      eq(ne.e && ne.e.kind, 'never_sent', 'conexión rechazada = nunca salió');
      await a.close();
    } finally { net.Socket.prototype.setKeepAlive = orig; }
  });

  // ═══ 5. pausa por ráfaga ═════════════════════════════════════════════════════════════════════════════════════════
  await check('5a ráfaga de cortes en el run (3 en 5 min) → la llamada NUEVA no sale (sin reserva) y la parte se devuelve con retryAfter; el reenvío de una llamada ya desconocida no se frena', async () => {
    const a = await fakeAnthropic(({ n }) => (n === 1 ? 'drop' : 'ok'));
    const w = fakeWorld({ expected: 10, estMax: 10, health: { events: 3, items: 1, sinceLastMs: 20_000 } });
    const r = await err(makeApi(w, a.url)('s', 'new-call', 4000));
    assert(r.e && r.e.handBack === SL.LLM_PROVIDER_UNHEALTHY && r.e.retryAfterSeconds === 160 && !r.e.pendingReview, 'devolución con pausa: ' + JSON.stringify(r.e));
    eq([a.st.reqs.length, w.res.size], [0, 0], 'ningún pedido ni reserva');
    const pol = SL.llmUnhealthyPolicy({});
    eq([pol.windowMs, pol.pauseMs, pol.minEvents, pol.minItems], [300000, 180000, 3, 2], 'política por defecto');
    eq(SL.llmUnhealthyPauseMs({ events: 1, items: 2, sinceLastMs: 1000 }, pol), 179000, '2 partes distintas también');
    eq(SL.llmUnhealthyPauseMs({ events: 2, items: 1, sinceLastMs: 1000 }, pol), 0, 'un solo evento aislado no pausa');
    eq(SL.llmUnhealthyPauseMs({ events: 5, items: 3, sinceLastMs: 1000 }, SL.llmUnhealthyPolicy({ DYNAMIC_LLM_UNHEALTHY_MIN_EVENTS: '0' })), 0, 'MIN_EVENTS=0 lo apaga');
    // El reenvío de una llamada ya desconocida sigue (su reserva está pendiente; lo acota el dinero).
    const w2 = fakeWorld({ expected: 10, estMax: 10 });
    const api2 = makeApi(w2, a.url);
    const q0 = w2.ds.query; let flips = 0;
    w2.ds.query = async (sql, p) => { if (sql.includes('llm_transport_events') && w2.res.size > 0) { flips++; return [{ llm_transport_events: 9, llm_transport_items: 3, llm_transport_since_last_ms: 1000 }]; } return q0(sql, p); };
    const r2 = await err(api2('s', 'resend-under-burst', 4000));
    assert(!r2.e && r2.v === FULL && flips === 0, 'el reenvío no consulta la pausa: ' + JSON.stringify(r2.e));
    eq(FC.classifyFailure({ error: 'llm_provider_unhealthy: varios cortes…', source: 'server_executor' }).class, 'A', 'clase A (transitorio)');
    await a.close();
  });

  await check('5b processLlmItem: la devolución por red inestable no consume intento (grantAttempt) ni pasa a revisión', async () => {
    const w = fakeWorld({ health: { events: 4, items: 2, sinceLastMs: 1000 } });
    const q0 = w.ds.query;
    w.ds.query = async (sql, p) => (/select owner_id from public\.production_jobs/.test(sql) ? [{ owner_id: 'owner-1' }] : q0(sql, p));
    const st = { failed: [] };
    const deps = {
      scheduler: { async heartbeatItem() { return true; }, async completeItem() { return true; }, async completeItemDetailed() { return { ok: true }; },
        async failItemDetailed(_id, _e, msg, retryable, _o, opts) { st.failed.push({ msg, retryable, opts }); return { ok: true }; }, async recordItemExternal() { return true; } },
      dataSource: w.ds, artifacts: { async uploadBufferArtifact() { return { id: 'a' }; }, async putStorageObject() {}, async downloadStorageObject() { return Buffer.from(''); } },
      finops: w.finops, budget: w.budget, logger: { log() {}, warn() {}, error() {} }, executorId: 'dynamic-llm-worker-1', leaseSeconds: 300, heartbeatMs: 1e9,
      apiKey: 'k', baseUrl: 'http://127.0.0.1:1', defaultModel: 'm', idleMs: 3000, totalMs: 10000, llmMode: 'mock',
      createRuntime: ({ api }) => ({ run: async () => ({ ok: true, artifacts: [], summary: { t: await api('s', 'P') } }), mapError: (e) => ({ msg: e.msg || String(e), retryable: true }), draftFailField: () => null }),
    };
    const out = await LW.processLlmItem(deps, { itemRunId: ITEM.itemRunId, runId: ITEM.runId, itemKey: 'final_exam', type: 'final_exam', attempt: 1, generation: 1, artifactCourseId: '91', manifestId: 3, idempotencyKey: 'i' });
    eq(out, 'handed_back', 'devuelta');
    assert(st.failed.length === 1 && st.failed[0].retryable === true && st.failed[0].opts.grantAttempt === true && st.failed[0].opts.retryAfterSeconds >= 15 && /^llm_provider_unhealthy/.test(st.failed[0].msg), JSON.stringify(st.failed));
  });

  // ═══ 6. estimado de activity ═════════════════════════════════════════════════════════════════════════════════════
  await check('6 prior de activity: el p50 sigue en lo medido (#1209) y el p90 cubre lo real (0,22); el límite de la parte ya admite el reenvío del incidente', () => {
    const pri = JSON.parse(fs.readFileSync(path.join(distRoot, '..', 'src/modules/finops/usage-model.priors.v1.json'), 'utf8'));
    const m = pri.operations['llm.activity'].meters;
    eq([m.input_tokens.p50, m.output_tokens.p50, m.input_tokens.p90, m.output_tokens.p90], [7000, 1450, 24000, 9000], 'tokens');
    const p90usd = m.input_tokens.p90 * 3e-6 + m.output_tokens.p90 * 15e-6;
    assert(p90usd >= 0.2, 'p90 ≈ ' + p90usd.toFixed(3));
    assert(pri.calibrationR83 && /curso 91/.test(pri.calibrationR83.source), 'fuente documentada');
  });

  // ═══ 7. lastBrowserActivity ══════════════════════════════════════════════════════════════════════════════════════
  await check('7 lastBrowserActivityAt cuenta solo partes del navegador (el worker de IA ya no la mueve); executor por parte', () => {
    const RS = load('modules/dynamic-generation/runs.service.js');
    const rows = [
      { type: 'video_interactions', status: 'completed', worker_id: 'dynamic-llm-worker-4242', claimed_at: '2026-11-02T20:50:00Z', finished_at: '2026-11-02T20:52:25Z', output_summary: { generatedBy: 'llm-worker' }, attempt_count: 1 },
      { type: 'final_exam', status: 'running', worker_id: 'llmw-custom', claimed_at: '2026-11-02T20:51:00Z', output_summary: { llmSent: { 'reservation:llm:x:g1:a1:llmw-main-1': 't' } }, attempt_count: 1 },
      { type: 'content', status: 'completed', worker_id: 'browser-tab-7', claimed_at: '2026-11-02T20:10:00Z', finished_at: '2026-11-02T20:12:00Z', output_summary: {}, attempt_count: 1 },
      { type: 'video', status: 'running', worker_id: 'dynamic-provider-worker-1', claimed_at: '2026-11-02T22:00:00Z' },
      { type: 'activity', status: 'pending', worker_id: null, claimed_at: null },
    ];
    eq(RS.lastBrowserActivityOf(rows), '2026-11-02T20:12:00.000Z', 'solo la del navegador');
    eq(rows.map((r) => RS.itemExecutorOf(r, {})), ['server', 'server', 'browser', 'server', null], 'executor');
    eq(RS.itemExecutorOf({ type: 'exam', worker_id: 'my-llm', output_summary: {} }, { DYNAMIC_LLM_WORKER_ID: 'my-llm' }), 'server', 'id fijado por env');
    // Compat: filas sin worker_id (consultas viejas) siguen la regla por tipo.
    eq(RS.lastBrowserActivityOf([{ type: 'content', status: 'running', claimed_at: '2026-11-02T20:00:00Z' }]), '2026-11-02T20:00:00.000Z', 'compat');
  });

  // ═══ 8. telemetría ═══════════════════════════════════════════════════════════════════════════════════════════════
  await check('8 telemetría: corte y desconocido quedan en llmTransportEvents (causa, transporte, bytes, duración, error, request-id, reserva) y en el log', async () => {
    const a = await fakeAnthropic(({ stream, n, prompt }) => (prompt === 'tel-cut' ? (stream ? 'cut' : 'ok') : n === 1 ? 'drop' : 'ok'));
    const w = fakeWorld({ expected: 10, estMax: 10 });
    const api = makeApi(w, a.url);
    await api('s', 'tel-cut', 4000);
    await api('s', 'tel-unknown', 4000);
    const [cut, unk] = w.events;
    assert(cut && cut.kind === 'cut' && cut.transport === 'stream' && /^socket:/.test(cut.cause) && cut.bytes > 0 && cut.durationMs >= 0 && cut.requestId === 'req_1' && cut.messageId && cut.callHash.length === 12, 'corte: ' + JSON.stringify(cut));
    assert(unk && unk.kind === 'unknown' && /^socket:/.test(unk.cause) && unk.reservationKey && unk.errorName && 'durationMs' in unk, 'desconocido: ' + JSON.stringify(unk));
    assert(api.logs.some((l) => /resultado DESCONOCIDO \(stream; causa socket:/.test(l) && /bytes en \d+ ms/.test(l)), 'log del desconocido con causa: ' + api.logs.join(' | '));
    await a.close();
  });

  // ═══ SQL real (PG16) ═════════════════════════════════════════════════════════════════════════════════════════════
  await check('SQL real (PG16): ventanas de itemWindowStart, telemetría (tope 20), ráfaga del run, sonda de salud y cortes por llamada', async () => {
    const pgBin = findPgBin();
    if (!pgBin) { console.log('   (sin Postgres 16: se omite; setear PG_BIN)'); return; }
    let Client;
    try { ({ Client } = require('pg')); } catch { console.log('   (sin el paquete pg: se omite)'); return; }
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r83-pg16-'));
    const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8' });
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl: ' + r.stderr + r.stdout);
    const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
    try {
      await c.connect();
      const ds = { query: (sql, p) => c.query(sql, p).then((x) => x.rows) };
      await c.query(`create table public.generation_item_runs (id uuid primary key, job_id uuid, status text not null default 'running', created_at timestamptz not null default now(), updated_at timestamptz default now(), output_summary jsonb);
        create table public.generation_cost_events (id uuid primary key default gen_random_uuid(), item_run_id uuid, idempotency_key text, event_kind text not null default 'CHARGE', provider text,
          billing_account text default 'cursia', metadata jsonb, created_at timestamptz not null default now(), corrects_event_id uuid)`);
      const id = '22222222-2222-4333-8444-838383838383'; const id2 = '33333333-2222-4333-8444-838383838383'; const run = '44444444-2222-4333-8444-838383838383';
      await c.query(`insert into public.generation_item_runs (id, job_id, created_at, output_summary) values ($1, $2, now() - interval '2 hours', jsonb_build_object(
          'recoveryBudgetResetAt', (now() - interval '5 minutes')::text, 'llmCheckpointsResetAt', (now() - interval '1 hour')::text, 'llmUnknownResetAt', (now() - interval '1 minute')::text,
          'llmCheckpoints', '{}'::jsonb)), ($3, $2, now(), '{}'::jsonb)`, [id, run, id2]);
      const win = await SL.itemWindowStart(ds, id);
      const ago = (d) => Math.round((Date.now() - d.getTime()) / 60000);
      eq([ago(win.since), ago(win.checkpointSince), ago(win.unknownSince)], [5, 60, 1], 'presupuesto 5 min / guardados 60 min / eventos 1 min');
      for (let i = 0; i < 23; i++) eq((await ds.query(SL.LLM_TRANSPORT_EVENT_SQL, [id, JSON.stringify({ kind: 'unknown', n: i, cause: 'socket:ECONNRESET' })])).length, 1, 'telemetría');
      const [ev] = await ds.query(`select output_summary->'llmTransportEvents' as e from public.generation_item_runs where id = $1`, [id]);
      eq([ev.e.length, ev.e[0].n, ev.e[19].n, typeof ev.e[19].at], [20, 3, 22, 'string'], 'últimos 20 en orden, con `at` del reloj de la DB');
      await ds.query(SL.LLM_TRANSPORT_EVENT_SQL, [id2, JSON.stringify({ kind: 'cut' })]);
      const h = await SL.runLlmTransportHealth(ds, run, 300000);
      assert(h.events === 21 && h.items === 2 && h.sinceLastMs !== null && h.sinceLastMs < 60000, 'ráfaga del run: ' + JSON.stringify(h));
      assert(SL.llmUnhealthyPauseMs(h, SL.llmUnhealthyPolicy({})) > 100000, 'pausa');
      eq((await SL.runLlmTransportHealth(ds, '55555555-2222-4333-8444-838383838383', 300000)).events, 0, 'otro run: sano');
      const p1 = await RO.llmProviderHealthProbe(ds);
      eq([p1.ok, p1.reason, p1.recentFailures], [false, 'recent_failures', 21], 'sonda: cortes recientes');
      await c.query(`update public.generation_item_runs set output_summary = output_summary - 'llmTransportEvents'`);
      await c.query(`insert into public.generation_cost_events (item_run_id, idempotency_key, provider, metadata) values ($1, 'charge:x', 'anthropic', '{"callRole":"main"}'),
        ($1, 'reservation:llm:x', 'anthropic', '{"reservation":"true"}'), ($1, 'charge:cut1', 'anthropic', '{"streamCut":{"callHash":"aaaaaaaaaaaa"}}'), ($1, 'charge:cut2', 'anthropic', '{"streamCut":{"callHash":"bbbbbbbbbbbb"}}')`, [id]);
      const p2 = await RO.llmProviderHealthProbe(ds);
      eq([p2.ok, p2.reason, p2.recentSuccesses], [true, 'recent_success', 1], 'sonda: una medida OK (no cuentan reservas ni cortes)');
      const cs = await SL.priorStreamCutStats(ds, id, new Date(0));
      eq([cs.count, [...cs.hashes].sort()], [2, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']], 'cortes por llamada');
      eq(await SL.priorStreamCut(ds, id, new Date(0)), true, 'compat priorStreamCut');
    } finally {
      await c.end().catch(() => undefined);
      pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  console.log(failures ? `\n${failures} ❌, ${passes} ✅` : `\nTODO OK (${passes} ✅, 0 ❌).`);
  process.exit(failures ? 1 : 0);
})();
