/* eslint-disable */
// r61 (F) — MODELAB · contrato de API por modelo + adaptador de pedidos por brazo del A/B.
//
// Hechos CONFIRMADOS en la documentación oficial (consultada el 2026-10-19/20). Cada regla cita su URL:
//   [MIG55]  https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
//   [MIGH55] https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
//   [EFFORT] https://platform.claude.com/docs/en/build-with-claude/effort
//   [MODELS] https://platform.claude.com/docs/en/about-claude/models/overview
//   [PRICE]  https://platform.claude.com/docs/en/about-claude/pricing
//   [CACHE]  https://platform.claude.com/docs/en/build-with-claude/prompt-caching
//   [COUNT]  https://platform.claude.com/docs/en/build-with-claude/token-counting
//
// Este módulo es PURO: no hay red ni lectura de archivos. `adaptBody` transforma el pedido EXACTO que arma el
// ejecutor (server-llm.ts: serverLlmRequestBody, pensado para Sonnet 4.6) al pedido de un brazo; `lintBody`
// rechaza ANTES de gastar un pedido que la API respondería con 400 según la documentación.
'use strict';

const MODELS = Object.freeze({
  'claude-sonnet-4-6': {
    tokenizer: 'legacy', // [PRICE] «Claude Sonnet 4.6 and earlier models use the previous tokenizer.»
    thinkingDefault: 'off', // [MIG55] tabla «Thinking without a thinking field: Off»
    thinkingTypes: ['adaptive', 'disabled', 'enabled'],
    budgetTokens: 'deprecated',
    effortLevels: ['low', 'medium', 'high', 'max'], // [EFFORT] xhigh no figura para Sonnet 4.6
    effortDefault: 'high',
    sampling: 'allowed',
    maxOutput: 128000, // [MODELS]
    cacheMinTokens: 1024, // [CACHE]
    cacheReadMultiplier: 0.1,
    refusalStopReason: false,
  },
  'claude-sonnet-5-5': {
    tokenizer: 'new', // [MIG55] «the same text produces about 30% more tokens» vs Sonnet 4.6
    thinkingDefault: 'adaptive', // [MIG55] «a request with no thinking field runs with adaptive thinking»
    thinkingTypes: ['adaptive', 'between_tools'], // [MIG55] tabla: solo "adaptive", "between_tools"
    betweenToolsEfforts: ['low', 'medium', 'high'], // [EFFORT] «At xhigh or max, it returns a 400 error»
    budgetTokens: 'rejected', // [MIG55] «Thinking budgets return an error»
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    effortDefault: 'high', // [MODELS]/[EFFORT]
    sampling: 'default_only', // [MIG55] «a non-default value returns a 400 error»
    maxOutput: 128000,
    cacheMinTokens: 512, // [MIG55]/[CACHE]
    cacheReadMultiplier: 0.05, // [PRICE] footnote 2
    refusalStopReason: true, // [MIG55] cyber, bio, frontier_llm, reasoning_extraction, general_harms
    refusalCategories: ['cyber', 'bio', 'frontier_llm', 'reasoning_extraction', 'general_harms'],
    forcedToolChoice: 'rejected',
    prefill: 'rejected',
  },
  'claude-haiku-5-5': {
    tokenizer: 'new', // [MIGH55] «approximately 30% more tokens ... than on Claude Haiku 4.5»
    thinkingDefault: 'adaptive', // [MIGH55] «Adaptive thinking is on by default»
    thinkingTypes: ['adaptive', 'disabled'],
    disabledEfforts: ['low', 'medium', 'high'], // [EFFORT] «send thinking disabled at high effort or below»
    budgetTokens: 'rejected', // [MIGH55]
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    effortDefault: 'medium', // [MODELS]/[EFFORT]
    sampling: 'default_only', // [MIGH55] temperature must be 1, top_p 0.99, no top_k, not both
    maxOutput: 128000,
    cacheMinTokens: 512,
    cacheReadMultiplier: 0.1, // [PRICE]
    longPromptTierTokens: 100000, // [PRICE] «a request whose prompt is over 100,000 tokens pays higher prices»
    refusalStopReason: true, // [MIGH55] «it has no server-side fallback»
    forcedToolChoice: 'accepted_without_thinking', // [MIGH55]
    prefill: 'rejected',
  },
});

/** Factor del tokenizer nuevo frente al de Sonnet 4.6. [PRICE]: «approximately 30% more tokens». Es un SUPUESTO
 *  hasta medirlo con count_tokens (gratis, [COUNT]) sobre los prompts reales en español. */
const TOKENIZER_FACTOR_DEFAULT = 1.30;
const TOKENIZER_FACTOR_RANGE = [1.15, 1.40];

function tokenizerFactor(model, assumed = TOKENIZER_FACTOR_DEFAULT) {
  const m = MODELS[model];
  if (!m) throw new Error(`modelab: modelo desconocido ${model}`);
  return m.tokenizer === 'new' ? assumed : 1;
}

/**
 * Brazo del A/B → pedido. `arm`: { id, model, thinking: 'off'|'adaptive'|'between_tools'|'disabled'|'omit',
 * effort?: 'low'|'medium'|'high'|..., maxTokensFactor?: number, maxTokensCap?: number }.
 * - 'off' en Sonnet 4.6 = no mandar thinking (paridad con producción: el ejecutor no lo manda).
 * - 'omit' = no mandar thinking en un modelo 5.5 (lo que pasaría con un cambio «solo de env»: thinking adaptativo).
 * - Nunca se mandan parámetros de muestreo (Cursia no los manda; en 5.5 los no-default son 400).
 */
function adaptBody(body, arm) {
  if (!body || typeof body !== 'object') throw new Error('modelab: body inválido');
  const m = MODELS[arm.model];
  if (!m) throw new Error(`modelab: modelo desconocido ${arm.model}`);
  const out = JSON.parse(JSON.stringify(body));
  out.model = arm.model;
  delete out.temperature; delete out.top_p; delete out.top_k;
  const factor = typeof arm.maxTokensFactor === 'number' ? arm.maxTokensFactor : 1;
  const cap = Math.min(arm.maxTokensCap || m.maxOutput, m.maxOutput);
  out.max_tokens = Math.max(1, Math.min(cap, Math.ceil(Number(body.max_tokens) * factor)));
  const th = arm.thinking || 'off';
  if (th === 'between_tools') out.thinking = { type: 'between_tools' };
  else if (th === 'disabled') out.thinking = { type: 'disabled' };
  else if (th === 'adaptive') out.thinking = { type: 'adaptive' };
  else if (th === 'off' || th === 'omit') delete out.thinking;
  else throw new Error(`modelab: thinking desconocido ${th}`);
  if (arm.effort) out.output_config = { ...(out.output_config || {}), effort: arm.effort };
  return out;
}

/** Pensamiento efectivo de un pedido (lo que la API haría según la documentación). */
function effectiveThinking(body) {
  const m = MODELS[body.model];
  const t = body.thinking && body.thinking.type;
  if (!t) return m.thinkingDefault === 'off' ? 'off' : 'adaptive';
  if (t === 'between_tools' || t === 'disabled') return 'off';
  return t;
}

/** Lint del pedido contra las reglas documentadas. Devuelve [{code, message, source}] (vacío = OK). */
function lintBody(body) {
  const issues = [];
  const add = (code, message, source) => issues.push({ code, message, source });
  const m = MODELS[body.model];
  if (!m) { add('MODEL_UNKNOWN', `modelo ${body.model} fuera del laboratorio`, 'modelab'); return issues; }
  const t = body.thinking && body.thinking.type;
  const effort = body.output_config && body.output_config.effort;
  if (t && !m.thinkingTypes.includes(t)) add('THINKING_TYPE_400', `${body.model} no acepta thinking.type=${t}`, body.model === 'claude-sonnet-5-5' ? 'MIG55' : 'MIGH55');
  if (body.thinking && body.thinking.budget_tokens !== undefined && m.budgetTokens === 'rejected') add('BUDGET_TOKENS_400', 'budget_tokens rechazado en este modelo', 'MIG55');
  if (t === 'between_tools') {
    const e = effort || m.effortDefault;
    if (!m.betweenToolsEfforts.includes(e)) add('BETWEEN_TOOLS_EFFORT_400', `between_tools no se acepta con effort=${e}`, 'EFFORT');
    const extra = Object.keys(body.thinking).filter((k) => k !== 'type');
    if (extra.length) add('BETWEEN_TOOLS_FIELDS_400', `between_tools no admite ${extra.join(',')}`, 'MIG55');
  }
  if (t === 'disabled' && m.disabledEfforts) {
    const e = effort || m.effortDefault;
    if (!m.disabledEfforts.includes(e)) add('DISABLED_EFFORT_400', `disabled no se acepta con effort=${e}`, 'EFFORT');
  }
  if (effort && !m.effortLevels.includes(effort)) add('EFFORT_LEVEL_400', `effort ${effort} no soportado por ${body.model}`, 'EFFORT');
  if (m.sampling === 'default_only') {
    if (body.temperature !== undefined && body.temperature !== 1) add('SAMPLING_400', 'temperature no-default', 'MIG55');
    if (body.top_p !== undefined && body.top_p !== 0.99) add('SAMPLING_400', 'top_p no-default', 'MIGH55');
    if (body.top_k !== undefined) add('SAMPLING_400', 'top_k', 'MIGH55');
  }
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  if (m.prefill === 'rejected' && msgs.length && msgs[msgs.length - 1].role === 'assistant') add('PREFILL_400', 'el último mensaje es del asistente (prefill)', 'MIG55');
  if (m.forcedToolChoice === 'rejected' && body.tool_choice && ['any', 'tool'].includes(body.tool_choice.type)) add('FORCED_TOOL_400', 'tool_choice any/tool', 'MIG55');
  if (!(Number.isInteger(body.max_tokens) && body.max_tokens >= 1 && body.max_tokens <= m.maxOutput)) add('MAX_TOKENS_RANGE', `max_tokens ${body.max_tokens} fuera de 1..${m.maxOutput}`, 'MODELS');
  return issues;
}

/** Texto de la respuesta: solo bloques `text` (los `thinking` llegan vacíos por defecto en 5.5, [MIG55]). */
function responseText(content) {
  return Array.isArray(content) ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('') : '';
}

module.exports = { MODELS, TOKENIZER_FACTOR_DEFAULT, TOKENIZER_FACTOR_RANGE, tokenizerFactor, adaptBody, lintBody, effectiveThinking, responseText };
