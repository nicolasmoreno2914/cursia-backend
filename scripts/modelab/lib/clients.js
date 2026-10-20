/* eslint-disable */
// r61 (F) — MODELAB · clientes de un brazo.
//   - mock (dry-run): sin red. Responde el LLM FALSO determinista del E2E (el mismo del driver offline) y SIMULA el
//     uso con el factor del tokenizer del modelo (chars/4 × factor), la caché (mínimo cacheable por modelo) y el
//     pensamiento adaptativo (+30 % de salida, supuesto) para que el presupuesto y los cortes por max_tokens se ejerciten.
//   - real: SDK oficial (@anthropic-ai/sdk del repo), streaming + finalMessage(). La clave SOLO sale de una variable
//     de entorno que el operador nombra al correr (--api-key-env); este módulo nunca lee .env ni archivos de credenciales.
'use strict';
const M = require('./models');

const CHARS_PER_TOKEN_46 = 4; // misma aproximación que scripts/lib/replay-api.js (modo fake) [H]
const SIM_THINKING_SHARE = 0.3; // [H] solo para ejercitar el camino en dry-run; el real lo mide la API

function promptText(body) {
  const sys = typeof body.system === 'string' ? body.system : JSON.stringify(body.system || '');
  const c = body.messages && body.messages[0] && body.messages[0].content;
  const blocks = Array.isArray(c) ? c : [{ type: 'text', text: String(c || '') }];
  return { sys, blocks };
}

function createMockClient(o = {}) {
  const factorOf = (model) => M.tokenizerFactor(model, o.tokenizerFactor || M.TOKENIZER_FACTOR_DEFAULT);
  const cache = new Set();
  const ref = o.providerRef || { provider: null };
  return {
    kind: 'mock',
    providerRef: ref,
    async call(adapted, original) {
      if (!ref.provider) throw new Error('modelab mock: sin proveedor falso (el driver no lo creó)');
      const r = ref.provider.respond(original);
      if (!r || r.httpStatus || typeof r.text !== 'string') return { error: { status: (r && r.httpStatus) || 500, message: String((r && r.error) || 'fake error') } };
      const f = factorOf(adapted.model);
      const meta = M.MODELS[adapted.model];
      const { sys, blocks } = promptText(adapted);
      const toks = (s) => Math.ceil(s.length / CHARS_PER_TOKEN_46 * f);
      let input = toks(sys), cw = 0, cr = 0;
      for (const b of blocks) {
        const n = toks(b.text || '');
        if (b.cache_control) {
          const key = `${adapted.model}|${sys}|${b.text}`;
          // El prefijo cacheado incluye el system + este bloque; por debajo del mínimo del modelo no se cachea ([CACHE]).
          if (input + n < meta.cacheMinTokens) input += n;
          else if (cache.has(key)) { cr += input + n; input = 0; }
          else { cache.add(key); cw += input + n; input = 0; }
        } else input += n;
      }
      let out = toks(r.text);
      const thinking = M.effectiveThinking(adapted) === 'adaptive' ? Math.ceil(out * SIM_THINKING_SHARE) : 0;
      let text = r.text;
      let stop = 'end_turn';
      if (out + thinking > adapted.max_tokens) {
        stop = 'max_tokens';
        const room = Math.max(0, adapted.max_tokens - thinking);
        text = r.text.slice(0, Math.floor(room * CHARS_PER_TOKEN_46 / f));
        out = room;
      }
      return { text, stopReason: stop, usage: { input_tokens: input, output_tokens: out + thinking, cache_creation_input_tokens: cw, cache_read_input_tokens: cr }, id: `mock_${cache.size}_${out}`, latencyMs: 0, simulated: true };
    },
    async countTokens(body) { const { sys, blocks } = promptText(body); return { input_tokens: Math.ceil((sys.length + blocks.reduce((s, b) => s + (b.text || '').length, 0)) / CHARS_PER_TOKEN_46 * factorOf(body.model)), simulated: true }; },
  };
}

function createRealClient(o) {
  if (!o || !o.apiKeyEnv) throw new Error('modelab real: falta --api-key-env (nombre de la variable de entorno con la clave)');
  if (!/^[A-Z][A-Z0-9_]{2,64}$/.test(o.apiKeyEnv)) throw new Error('modelab real: --api-key-env debe ser un nombre de variable (MAYÚSCULAS)');
  const key = process.env[o.apiKeyEnv];
  if (!key || !key.trim()) throw new Error(`modelab real: la variable ${o.apiKeyEnv} no está definida en el entorno de esta corrida (no se lee .env)`);
  const SDK = require('@anthropic-ai/sdk');
  const Anthropic = SDK.default || SDK.Anthropic || SDK;
  const sdk = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 15 * 60 * 1000 });
  return {
    kind: 'real',
    async call(adapted) {
      const t0 = Date.now();
      try {
        const msg = await sdk.messages.stream(adapted).finalMessage();
        return { text: M.responseText(msg.content), stopReason: msg.stop_reason || null, stopDetails: msg.stop_details || null, usage: msg.usage || {}, id: msg.id, latencyMs: Date.now() - t0 };
      } catch (e) {
        const status = e && typeof e.status === 'number' ? e.status : 0;
        // 4xx definitivo: sin cargo. Otro error: el gasto es DESCONOCIDO → el runner lo reserva a la cota superior.
        return { error: { status, message: String((e && e.message) || e).slice(0, 400) }, unknownSpend: !(status >= 400 && status < 500), latencyMs: Date.now() - t0 };
      }
    },
    /** Gratis según https://platform.claude.com/docs/en/build-with-claude/token-counting («free to use»). */
    async countTokens(body) {
      const { model, system, messages, thinking, tools } = body;
      const r = await sdk.messages.countTokens({ model, system, messages, ...(thinking ? { thinking } : {}), ...(tools ? { tools } : {}) });
      return { input_tokens: r.input_tokens };
    },
  };
}

module.exports = { createMockClient, createRealClient, CHARS_PER_TOKEN_46 };
