/* eslint-disable */
// r61 (F) — MODELAB · corrida de UN brazo sobre el MISMO motor del producto (driver offline: claim del scheduler,
// ejecutor del worker en un vm, validación de completeItem), sin tocar el código de la app.
//
// Cómo entra el modelo del brazo sin dar red al ejecutor («punto fijo» de replay):
//   ronda k: el driver corre con la barrera de red ACTIVA; cada llamada de IA del ejecutor se resuelve contra el mapa de
//   respuestas (clave = hash del pedido ORIGINAL, la receta del servidor). Una llamada sin respuesta queda PENDIENTE
//   (su ítem falla en esa ronda). Fuera del driver (sin barrera), cada pendiente se ADAPTA al brazo (modelo, thinking,
//   effort, max_tokens), se valida con lintBody, se reserva en la guardia de presupuesto y se manda al cliente (mock o
//   real); la respuesta se guarda. ronda k+1 repite: el ejecutor es determinista dado el mismo mapa (OD5), así que
//   avanza hasta la siguiente llamada. Termina cuando una ronda no deja pendientes.
// El stop_reason REAL (max_tokens / refusal) llega al ejecutor igual que en producción (metaOut.stopReason).
'use strict';
const path = require('path');
const crypto = require('crypto');
const M = require('./models');
const CAT = require('./catalog');

const LIB = path.resolve(__dirname, '..', '..', 'lib');
const D = require(path.join(LIB, 'offline-driver'));
const R = require(path.join(LIB, 'replay-api'));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

class ArmError extends Error { constructor(code, msg, extra) { super(`${code}: ${msg}`); this.code = code; Object.assign(this, extra || {}); } }

/** Una llamada del brazo: adapta → lint → reserva → llama → precia → liquida. */
async function callThrough(ctx, original, meta) {
  const adapted = M.adaptBody(original, ctx.arm);
  const lint = M.lintBody(adapted);
  if (lint.length) throw new ArmError('ARM_REQUEST_INVALID', `${ctx.arm.id}: ${lint.map((l) => `${l.code} (${l.message})`).join('; ')}`, { lint });
  const inEst = Math.ceil(JSON.stringify(adapted.system || '').length / 4 * M.tokenizerFactor(adapted.model, 1.4) + JSON.stringify(adapted.messages).length / 4 * M.tokenizerFactor(adapted.model, 1.4));
  const upper = CAT.upperBoundCall(ctx.distRoot, adapted.model, inEst, adapted.max_tokens);
  const res = ctx.guard.reserve(upper);
  const r = await ctx.client.call(adapted, original);
  let usd = 0;
  if (r.error) usd = r.unknownSpend ? upper : 0;
  else usd = Number(CAT.priceCall(ctx.distRoot, adapted.model, r.usage || {}));
  ctx.guard.settle(res, usd);
  const rec = {
    seq: ctx.calls.length + 1, itemKey: meta.itemKey, componentType: meta.componentType, callRole: meta.callRole, model: adapted.model,
    thinking: M.effectiveThinking(adapted), effort: (adapted.output_config && adapted.output_config.effort) || null, maxTokens: adapted.max_tokens,
    stopReason: r.error ? `error_${r.error.status}` : r.stopReason, refusalCategory: (r.stopDetails && r.stopDetails.category) || null,
    usage: r.usage || null, usd, upperUsd: upper, latencyMs: r.latencyMs ?? null, simulated: !!r.simulated, requestHash: meta.requestHash,
  };
  ctx.calls.push(rec);
  return { r, rec };
}

/** api() con el contrato de replay-api (lo que el driver le pasa al ejecutor), resuelto contra `answers`. */
function makeArmReplay(o, state) {
  const S = require(path.join(o.distRoot, 'workers/llm-executor/server-llm.js'));
  const calls = [];
  state.lastCalls = calls;
  const cur = { itemKey: null, componentType: null };
  state.providerRef.provider = o.provider || null; // el LLM falso del driver (lo usa el cliente mock)
  const api = async function api(system, user, maxTok, schema, model, metaOut, extraHeaders, cacheOpts) {
    const { body, model: useModel } = S.serverLlmRequestBody({ system, user, maxTok, schema, model, defaultModel: o.defaultModel || 'claude-sonnet-4-6', cacheOpts });
    const requestHash = S.serverLlmRequestHash(body);
    const callRole = (extraHeaders && extraHeaders['x-cursia-call-role']) || 'main';
    calls.push({ requestHash, callRole, model: useModel, itemKey: cur.itemKey, mode: 'modelab' });
    const a = state.answers.get(requestHash);
    if (!a) {
      if (!state.pending.has(requestHash)) state.pending.set(requestHash, { body, meta: { requestHash, callRole, itemKey: cur.itemKey, componentType: cur.componentType } });
      throw { fatal: true, code: 'MODELAB_PENDING', status: 0, msg: `MODELAB_PENDING:${requestHash.slice(0, 12)}` };
    }
    if (a.error) throw { fatal: a.error.status >= 400 && a.error.status < 500, status: a.error.status, msg: `❌ Error al procesar la solicitud: ${a.error.message}` };
    if (metaOut) { metaOut.stopReason = a.stopReason; metaOut.usage = { ...(a.usage || {}) }; }
    return a.text;
  };
  return { api, calls, misses: [], recorded: [], setItem(r) { cur.itemKey = r.itemKey; cur.componentType = r.componentType; } };
}

/**
 * Corre `select` (con `approved` congelados) bajo un brazo. Devuelve el resultado FINAL del driver + llamadas.
 * o: { distRoot, feRoot, cfg, select, approved, arm, client, guard, maxRounds, onRound, package }
 */
async function runArm(o) {
  const state = { answers: o.answers || new Map(), pending: new Map(), providerRef: o.client.providerRef || { provider: null } };
  const ctx = { distRoot: o.distRoot, arm: o.arm, client: o.client, guard: o.guard, calls: [] };
  const orig = R.createReplayApi;
  R.createReplayApi = (ro) => makeArmReplay({ ...ro, distRoot: o.distRoot }, state);
  let res = null;
  let rounds = 0;
  try {
    for (;;) {
      rounds++;
      if (rounds > (o.maxRounds || 400)) throw new ArmError('ARM_NO_FIXPOINT', `${o.arm.id}: ${rounds - 1} rondas sin terminar`);
      state.pending.clear();
      res = await D.runComponents(o.distRoot, o.cfg, { select: o.select, approved: o.approved || {}, llm: { mode: 'fake' }, feRoot: o.feRoot, package: !!o.package });
      if (!state.pending.size) break;
      // Fuera del driver (barrera desinstalada): llamadas del brazo, en orden determinista.
      const pend = [...state.pending.values()].sort((a, b) => (a.meta.itemKey || '').localeCompare(b.meta.itemKey || '') || a.meta.requestHash.localeCompare(b.meta.requestHash));
      for (const p of pend) {
        const { r } = await callThrough(ctx, p.body, p.meta);
        state.answers.set(p.meta.requestHash, r.error ? { error: r.error } : { text: r.text, stopReason: r.stopReason, usage: r.usage });
      }
      if (o.onRound) o.onRound({ round: rounds, pending: pend.length, spent: o.guard.snapshot() });
    }
  } finally {
    R.createReplayApi = orig;
  }
  // Llamadas «huérfanas»: pagadas en una ronda pero no consumidas por la corrida final (un camino de respaldo del
  // ejecutor tras un pendiente). Se informan y su costo cuenta igual.
  const used = new Set((state.lastCalls || []).map((c) => c.requestHash));
  for (const c of ctx.calls) c.orphan = !used.has(c.requestHash);
  return { res, calls: ctx.calls, rounds, answers: state.answers, orphanCalls: ctx.calls.filter((c) => c.orphan).length };
}

/** Exporta los ítems completados de una corrida (para congelarlos como `approved` de los brazos). */
function exportApproved(res, keys) {
  const out = {};
  for (const k of keys) { if (res.items[k] && res.items[k].status === 'completed') out[k] = res.exportItem(k); }
  return out;
}

module.exports = { runArm, callThrough, exportApproved, ArmError, sha256 };
