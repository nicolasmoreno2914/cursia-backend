#!/usr/bin/env node
/* eslint-disable */
// r58 (I6) — FinOps: la lease del worker de IA VENCE CON UNA LLAMADA EN VUELO (AU3 §H5 «interrupted run»: el escenario que
// faltaba). createServerApi REAL (reservas/liquidación de finops-worker-hooks reales) contra un ledger falso con tope de
// run y un Anthropic falso en 127.0.0.1; dos «workers» (A pierde la lease a mitad de la llamada, B toma la parte). USD 0.
//
//   LM1 A en vuelo + B toma la parte y emite la MISMA llamada antes de que A termine → 2 pedidos al proveedor, 2 reservas
//       con claves distintas (a1/a2), las DOS liquidadas con su cargo real (ledger = lo que cobra el proveedor), 0
//       pendientes; el punto de guardado de A se rechaza (ya no es el dueño) y el de B queda; la ventana de doble cobro
//       está acotada a esa llamada (B no repite nada más)
//   LM2 A terminó (respuesta pagada) pero perdió la lease antes de guardar: el guardado de A se rechaza → B paga la
//       llamada otra vez (ventana conocida, AU3 §H2) — se fija el comportamiento: exactamente 1 pedido extra, ambos
//       cargos registrados, nada pendiente
//   LM3 A completó y guardó ANTES de perder la lease → B responde desde el guardado: 0 pedidos, 0 reservas nuevas
//   LM4 tope del run con la reserva de A en vuelo: la de B no cabe → B NO llama (run_paused), el run se pausa
//       (run_budget_cap); A liquida su cargo real y el comprometido final = solo ese cargo
//   LM5 A pierde la respuesta (desconocido) mientras vence la lease: su reserva queda PENDIENTE (cuenta en el tope y en
//       el contador de desconocidos de la misma llamada); B hace un único intento más y la parte no entra en bucle
//   LM6 A detecta la lease perdida ANTES de llamar → devuelve la parte sin reservar ni llamar (shouldStop)
//
// r61 (Q-21): LM1/LM2 fijan el comportamiento de createServerApi SIN los deps nuevos (priorInFlightWindowMs,
// recordLateCheckpoint). El worker real (processLlmItem) los pasa tras una toma: B no reenvía y reutiliza el guardado
// tardío de A → ver scripts/check-r61-lease-takeover-no-repay.js (LT1/LT2).
//
// Usage: npm run build && node scripts/check-r58-lease-midcall.js [dist]
'use strict';
const http = require('http');
const path = require('path');
const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const { createServerApi, LLM_UNKNOWN_MAX } = require(path.join(distRoot, 'workers/llm-executor/server-llm.js'));
const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (/^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };

let passes = 0; let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.error(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : JSON.stringify(e)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sse = (t, o) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...o })}\n\n`;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = '99999999-2222-4333-8444-555555555555';
const base = { itemRunId: '11111111-2222-4333-8444-555555555555', runId: RUN, itemKey: 'content:x', generation: 1, ownerId: 'owner-1', artifactCourseId: '7', manifestId: 3 };
const UB = 1.0; // cota de la reserva (USD) en el ledger falso
const ACTUAL = 0.3; // cargo real por llamada

/** Anthropic falso: cada pedido tarda holdMs; `drop` corta la conexión sin respuesta (resultado desconocido). */
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

/**
 * Ledger + DB + Storage falsos compartidos por los dos workers. La fila de la parte tiene UN dueño (worker_id): el
 * guardado solo se registra si quien escribe es el dueño (mismo SQL que dynamic-llm-worker.ts: `worker_id = $2`).
 * Tope del run: Σ reservas abiertas (UB) + cargos finales + la nueva ≤ cap, o RUN_BUDGET_CAP (mismo contrato que
 * insertReservationWithinRunCap).
 */
function world(cap = Infinity) {
  const w = { owner: 'A', cps: {}, store: new Map(), res: new Map(), finals: [], paused: [], cap };
  const like = (pat) => new RegExp('^' + pat.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  // r62: una reserva liquidada como cobrada (posible duplicado) SIGUE contando su cota (ADJUSTMENT de delta 0), salvo que
  // llegue su cargo real (entonces cuenta el real, como en settleReservation del ledger).
  w.committed = () => [...w.res.values()].filter((r) => !r.settled || (r.possibleDuplicate && !r.charged)).length * UB + w.finals.length * ACTUAL;
  w.ds = {
    async query(sql, params) {
      if (sql.includes('count(*)::int as n')) {
        const [keyLike, tagLike, , exclude] = params;
        return [{ n: [...w.res.entries()].filter(([k, v]) => like(keyLike).test(k) && like(tagLike).test(v.tag) && (!v.settled || v.possibleDuplicate) && !exclude.includes(k)).length }];
      }
      // r62: reservas desconocidas de UNA llamada (el próximo envío es el reenvío ambiguo único de la parte).
      if (sql.includes('e.idempotency_key as key, e.amount::text as amount')) {
        const [keyLike, tagLike, , exclude, includePd] = params;
        return [...w.res.entries()].filter(([k, v]) => like(keyLike).test(k) && like(tagLike).test(v.tag) && (!v.settled || (includePd && v.possibleDuplicate)) && !exclude.includes(k))
          .map(([k, v]) => ({ key: k, amount: String(UB), settled: !!v.settled, send_marked: !!v.sendMarked }));
      }
      if (sql.includes('generation_item_runs')) return [{ since: new Date(0).toISOString(), cps: { ...w.cps } }];
      throw new Error('SQL inesperado: ' + sql.slice(0, 80));
    },
  };
  w.finops = {
    async recordCharge(i) {
      if (w.committed() + UB > w.cap + 1e-9) {
        const e = new Error(`RUN_BUDGET_CAP: el run ${RUN} excedería su presupuesto autorizado`); e.code = 'RUN_BUDGET_CAP'; e.details = { runId: RUN, requiredUsd: UB }; throw e;
      }
      w.res.set(i.idempotencyKey, { tag: i.metadata.callTag, sendMarked: !!i.metadata.sendMarked, settled: false });
      return {};
    },
    async recordAdjustment() { return {}; }, async recordZero() { return {}; },
    // r62 (I3): conciliación conservadora del reenvío ambiguo (obligatoria: sin ella el worker falla cerrado).
    async reconcileReservationAsCharged(key, reason, o) {
      const r = w.res.get(key);
      if (!r || r.settled) return { reconciled: false, alreadySettled: true, amount: '0', event: null };
      Object.assign(r, { settled: true, possibleDuplicate: !!(o && o.metadata && o.metadata.possibleDuplicate), reason });
      return { reconciled: true, alreadySettled: false, amount: '1', event: null };
    },
    async settleReservation(key, charge, reason) {
      const r = w.res.get(key);
      r.settled = true; r.reason = reason; r.charged = !!charge;
      if (charge) w.finals.push({ key, idem: charge.externalOperationId });
      return { finalInserted: !!charge, finalEvent: null };
    },
  };
  w.budget = { guardServerLlmCall: async () => null, ambiguousResendBudget: async () => ({ fits: true, reason: null, worstItem: 0, worstRun: 0 }), pauseRunBySystem: async (runId, reason) => { w.paused.push({ runId, reason }); return true; } };
  w.api = (who, url, extra = {}) => createServerApi({
    dataSource: w.ds, finops: w.finops, budget: w.budget,
    checkpoints: { put: async (p, j) => { w.store.set(p, j); }, get: async (p) => (w.store.has(p) ? w.store.get(p) : null) },
    recordCheckpoint: async (_id, e) => { if (w.owner !== who) return false; Object.assign(w.cps, e); return true; },
    apiKey: 'k', baseUrl: url, defaultModel: 'm', idleMs: 3000, totalMs: 10000,
    logger: { log() {}, warn() {}, error() {} }, settleRetryDelaysMs: [0, 0], ...extra,
  }, { ...base, attempt: who === 'A' ? 1 : 2 }, () => ({ callRole: 'main', attempt: who === 'A' ? 1 : 2 }));
  w.pending = () => [...w.res.values()].filter((v) => !v.settled).length;
  return w;
}
async function err(p) { try { return { v: await p }; } catch (e) { return { e }; } }

(async () => {
  await check('LM1 A en vuelo + B emite la misma llamada: 2 pedidos, 2 reservas (a1/a2) liquidadas con su cargo real, 0 pendientes; guardado de A rechazado, el de B queda', async () => {
    const a = await fakeAnthropic({ holdMs: 250 });
    const w = world();
    const pA = err(w.api('A', a.url)('s', 'P'));
    await tick(60);
    w.owner = 'B'; // la lease de A vence y B reclama la parte (A sigue con su llamada en vuelo)
    const rB = await err(w.api('B', a.url)('s', 'P'));
    const rA = await pA;
    assert(!rA.e && !rB.e && rA.v && rB.v, `ambas respuestas: ${JSON.stringify([rA.e, rB.e])}`);
    assert(a.st.requests === 2, `pedidos ${a.st.requests}`);
    const keys = [...w.res.keys()];
    assert(keys.length === 2 && keys.some((k) => /:a1:/.test(k)) && keys.some((k) => /:a2:/.test(k)), `claves ${JSON.stringify(keys)}`);
    assert([...w.res.values()].every((r) => r.settled && r.charged && r.reason === 'llm_worker_measured'), 'las dos liquidadas con cargo real');
    assert(w.pending() === 0 && w.finals.length === 2 && new Set(w.finals.map((f) => f.idem)).size === 2, `cargos finales ${JSON.stringify(w.finals)}`);
    assert(Math.abs(w.committed() - 2 * ACTUAL) < 1e-9, `comprometido ${w.committed()} = 2 cargos reales`);
    assert(Object.keys(w.cps).length === 1, 'un guardado registrado (el de B; el de A se rechazó por no ser el dueño)');
    // Acotado: B vuelve a pedir lo mismo → sale del guardado, sin pedido ni reserva.
    const again = await err(w.api('B', a.url)('s', 'P'));
    assert(!again.e && a.st.requests === 2 && w.res.size === 2, 'sin un tercer pedido');
    await a.close();
  });

  await check('LM2 A terminó pero perdió la lease antes de guardar → B paga 1 vez más (ventana conocida, fijada): 2 cargos registrados, nada pendiente', async () => {
    const a = await fakeAnthropic({ holdMs: 120 });
    const w = world();
    const pA = err(w.api('A', a.url)('s', 'Q'));
    await tick(30);
    w.owner = 'B'; // vence durante la llamada; A recibe la respuesta después
    const rA = await pA;
    assert(!rA.e, 'A recibe y liquida su respuesta');
    assert(Object.keys(w.cps).length === 0, 'el guardado de A no se registró (A ya no es el dueño)');
    const rB = await err(w.api('B', a.url)('s', 'Q'));
    assert(!rB.e && a.st.requests === 2, `B paga la llamada otra vez (pedidos ${a.st.requests})`);
    assert(w.pending() === 0 && w.finals.length === 2, 'los dos cargos registrados, sin reservas abiertas');
    await a.close();
  });

  await check('LM3 A guardó ANTES de perder la lease → B responde desde el guardado (0 pedidos, 0 reservas nuevas)', async () => {
    const a = await fakeAnthropic({ holdMs: 10 });
    const w = world();
    const rA = await err(w.api('A', a.url)('s', 'G'));
    assert(!rA.e && a.st.requests === 1, 'A completó');
    w.owner = 'B';
    const rB = await err(w.api('B', a.url)('s', 'G'));
    assert(!rB.e && rB.v === rA.v && a.st.requests === 1 && w.res.size === 1, 'B usa el guardado sin costo');
    await a.close();
  });

  await check('LM4 tope del run con la reserva de A EN VUELO: la de B no cabe → B no llama (run_paused) y el run se pausa; A liquida y queda solo su cargo real', async () => {
    const a = await fakeAnthropic({ holdMs: 200 });
    const w = world(1.5); // cabe UNA cota (1.0), no dos
    const pA = err(w.api('A', a.url)('s', 'C'));
    await tick(50);
    w.owner = 'B';
    const rB = await err(w.api('B', a.url)('s', 'C'));
    assert(rB.e && rB.e.runPaused === true && rB.e.code === 'run_paused', `B pausado sin llamar: ${JSON.stringify(rB.e)}`);
    assert(w.paused.length === 1 && w.paused[0].reason === 'run_budget_cap', `pausa ${JSON.stringify(w.paused)}`);
    const rA = await pA;
    assert(!rA.e && a.st.requests === 1, `solo A llamó (pedidos ${a.st.requests})`);
    assert(w.pending() === 0 && Math.abs(w.committed() - ACTUAL) < 1e-9, `comprometido final ${w.committed()} = cargo real de A`);
    await a.close();
  });

  await check(`LM5 A pierde la respuesta (desconocido) al vencer la lease: su reserva queda PENDIENTE (tope + contador); B intenta como máximo hasta ${LLM_UNKNOWN_MAX} desconocidos de la misma llamada y no hay bucle`, async () => {
    const a = await fakeAnthropic({ holdMs: 80, drop: (n) => n === 1 });
    const w = world();
    const pA = err(w.api('A', a.url)('s', 'U'));
    await tick(20);
    w.owner = 'B';
    await tick(150); // la conexión de A se cortó: A reintenta una vez por su cuenta (es lo que hace con un desconocido)
    const rA = await pA;
    // r62: la reserva sin respuesta queda CONTADA (pendiente, o liquidada como cobrada con possible_duplicate antes del reenvío).
    const unknownAfterA = () => [...w.res.values()].filter((v) => !v.settled || v.possibleDuplicate).length;
    const pendingAfterA = unknownAfterA();
    assert(pendingAfterA === 1, `la reserva sin respuesta queda contada (${pendingAfterA})`);
    assert(Math.abs(w.committed() - (UB + (rA.e ? 0 : ACTUAL))) < 1e-9, `la pendiente cuenta su cota en el tope (${w.committed()})`);
    const rB = await err(w.api('B', a.url)('s', 'U'));
    assert(!rB.e || rB.e.pendingReview === true, `B: respuesta o revisión, nunca un bucle (${JSON.stringify(rB.e)})`);
    assert(a.st.requests <= 1 + LLM_UNKNOWN_MAX, `pedidos acotados: ${a.st.requests}`);
    assert(unknownAfterA() === 1, 'solo la reserva desconocida queda contada');
    await a.close();
  });

  await check('LM6 lease perdida detectada ANTES de llamar → devolución sin reserva ni pedido', async () => {
    const a = await fakeAnthropic();
    const w = world();
    const r = await err(w.api('A', a.url, { shouldStop: () => 'lease_lost' })('s', 'L'));
    assert(r.e && r.e.handBack === 'lease_lost' && w.res.size === 0 && a.st.requests === 0, JSON.stringify(r.e));
    await a.close();
  });

  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})();
