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

const TRANSIENT_MAX_ATTEMPTS = 4; // 1 + 3 reintentos explícitos (review r61 I3/I6)
const INPUT_SLACK = 1.25; // review r61 M1: holgura sobre la estimación chars/4 de la entrada en la cota

/** Clave de reanudación: misma entrada, componente, brazo, réplica y pedido ORIGINAL → misma respuesta pagada. */
function resumeKey(tags, requestHash) { return [tags.input || '-', tags.component || '-', tags.arm || '-', tags.run ?? '-', tags.phase || '-', requestHash].join('|'); }

/**
 * Una llamada LÓGICA del brazo: adapta → lint → (reanudación) → [reserva → llama → precia → liquida] × intentos.
 *   - 4xx (invalid_request/auth) → ArmError ARM_REQUEST_REJECTED: aborta la corrida (nunca «falla del modelo», review I5).
 *   - transitorio (429/529/5xx/red) → reintento explícito acotado, CADA intento con su reserva y su renglón (I3/I6);
 *     agotado → ArmError INFRA_RETRIES_EXHAUSTED (aborta; nunca se guarda como respuesta ni cuenta contra el brazo).
 * ctx: { distRoot, arm, client, guard, calls, sink?, tags?, resume?: Map, onAnswer?, backoffMs? }
 */
async function callThrough(ctx, original, meta) {
  const adapted = M.adaptBody(original, ctx.arm);
  const lint = M.lintBody(adapted);
  if (lint.length) throw new ArmError('ARM_REQUEST_INVALID', `${ctx.arm.id}: ${lint.map((l) => `${l.code} (${l.message})`).join('; ')}`, { lint });
  const tags = ctx.tags || {};
  const rkey = resumeKey(tags, meta.requestHash);
  const base = {
    itemKey: meta.itemKey, componentType: meta.componentType, callRole: meta.callRole, model: adapted.model,
    thinking: M.effectiveThinking(adapted), effort: (adapted.output_config && adapted.output_config.effort) || null, maxTokens: adapted.max_tokens,
    requestHash: meta.requestHash, ...tags,
  };
  const push = (rec) => { rec.seq = ctx.calls.length + 1; ctx.calls.push(rec); if (ctx.sink) ctx.sink.push(rec); };
  if (ctx.resume && ctx.resume.has(rkey)) {
    const r = ctx.resume.get(rkey);
    const rec = { ...base, stopReason: r.stopReason, refusalCategory: r.refusalCategory || null, usage: r.usage || null, usd: 0, usdCold: r.usdCold ?? 0, usdPaidPreviously: r.usd ?? null, upperUsd: 0, latencyMs: null, simulated: !!r.simulated, resumed: true };
    push(rec);
    return { r, rec };
  }
  const inEst = Math.ceil((JSON.stringify(adapted.system || '').length + JSON.stringify(adapted.messages).length) / 4 * M.tokenizerFactor(adapted.model, 1.4) * INPUT_SLACK);
  const upper = CAT.upperBoundCall(ctx.distRoot, adapted.model, inEst, adapted.max_tokens);
  for (let attempt = 1; ; attempt++) {
    const res = ctx.guard.reserve(upper, { arm: ctx.arm.id, component: meta.componentType, callRole: meta.callRole, requestHash: meta.requestHash, attempt });
    let r;
    try { r = await ctx.client.call(adapted, original); }
    catch (e) {
      // Gasto desconocido = peor caso; el intento queda registrado como llamada (la contabilidad cuadra con el ledger).
      ctx.guard.settle(res, upper, { error: 'client_threw' });
      push({ ...base, attempt, stopReason: 'client_threw', errorClass: 'unknown', usage: null, usd: upper, usdCold: upper, upperUsd: upper, latencyMs: null, simulated: false, infra: false, error: String((e && e.message) || e).slice(0, 200) });
      throw e;
    }
    let usd = 0, usdCold = 0;
    if (r.error) usd = r.unknownSpend ? upper : 0;
    else {
      const u = r.usage || {};
      usd = Number(CAT.priceCall(ctx.distRoot, adapted.model, u));
      // Review r61 I9: costo «en frío» (la lectura de caché repreciada como escritura) para comparar brazos sin el ruido
      // del estado de la caché entre réplicas. La guardia usa el costo REAL.
      usdCold = Number(CAT.priceCall(ctx.distRoot, adapted.model, { ...u, cache_creation_input_tokens: (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), cache_read_input_tokens: 0 }));
    }
    ctx.guard.settle(res, usd, { status: r.error ? r.error.status : 200 });
    const rec = {
      ...base, attempt, stopReason: r.error ? `error_${r.error.status}` : r.stopReason, errorClass: r.error ? r.error.cls : null,
      refusalCategory: (r.stopDetails && r.stopDetails.category) || null, usage: r.usage || null, usd, usdCold, upperUsd: upper,
      latencyMs: r.latencyMs ?? null, simulated: !!r.simulated, infra: !!(r.error && r.error.cls === 'transient'),
    };
    push(rec);
    if (!r.error) {
      if (ctx.onAnswer) ctx.onAnswer({ key: rkey, ...tags, requestHash: meta.requestHash, model: adapted.model, text: r.text, stopReason: r.stopReason, refusalCategory: rec.refusalCategory, usage: r.usage, usd, usdCold, id: r.id || null, simulated: !!r.simulated });
      return { r, rec };
    }
    if (r.error.cls !== 'transient') {
      throw new ArmError('ARM_REQUEST_REJECTED', `${ctx.arm.id} ${meta.componentType}/${meta.callRole}: la API rechazó el pedido (${r.error.status}${r.error.type ? ' ' + r.error.type : ''}): ${r.error.message}`, { status: r.error.status });
    }
    if (attempt >= TRANSIENT_MAX_ATTEMPTS) throw new ArmError('INFRA_RETRIES_EXHAUSTED', `${ctx.arm.id} ${meta.componentType}: ${attempt} intentos con error transitorio (${r.error.status}): ${r.error.message}`, { status: r.error.status });
    const wait = (ctx.backoffMs ?? 2000) * 2 ** (attempt - 1);
    if (wait > 0) await new Promise((ok) => setTimeout(ok, Math.min(wait, 30000)));
  }
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
  const ctx = { distRoot: o.distRoot, arm: o.arm, client: o.client, guard: o.guard, calls: [], sink: o.sink || null, tags: o.tags || {}, resume: o.resume || null, onAnswer: o.onAnswer || null, backoffMs: o.backoffMs };
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
        // Solo respuestas del modelo (los errores abortan en callThrough: nunca se guardan como respuesta, review I6).
        state.answers.set(p.meta.requestHash, { text: r.text, stopReason: r.stopReason, usage: r.usage });
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

module.exports = { runArm, callThrough, exportApproved, ArmError, sha256, resumeKey, TRANSIENT_MAX_ATTEMPTS };
