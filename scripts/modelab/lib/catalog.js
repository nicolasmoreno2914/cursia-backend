/* eslint-disable */
// r61 (F) — MODELAB · precios. Usa el MISMO código de FinOps del producto (dist/modules/finops/pricing.js: priceUsage)
// con un catálogo local del laboratorio: las filas del brazo baseline salen del seed del repo; las de 5.5 son las
// verificadas por el controlador en STAGING el 2026-10-20 (mismos valores que la página oficial [PRICE]).
//
// Haiku 5.5 tiene TRAMOS por largo del prompt (> 100.000 tokens contando entrada + lectura + escritura de caché,
// [PRICE] «Long context pricing»). El catálogo del producto no soporta tramos todavía; acá cada tramo es un
// «producto» propio (`claude-haiku-5-5#le100k` / `#gt100k`) y `priceCall` elige el tramo por pedido.
'use strict';
const path = require('path');

const PRICE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const row = (model, meter, price, verifiedNote) => ({
  provider: 'anthropic', service: 'messages', product_or_model: model, meter, unit_size: '1000000', unit_price: String(price), currency: 'USD',
  pricing_version: 'modelab-2026-10-20', effective_from: '2026-01-01T00:00:00Z', effective_to: null, source: 'public_pricing_page', source_ref: `${PRICE_URL} (${verifiedNote})`, verified: true,
});
const four = (model, inp, cw, cr, out, note) => [row(model, 'input_tokens', inp, note), row(model, 'cache_write_tokens', cw, note), row(model, 'cache_read_tokens', cr, note), row(model, 'output_tokens', out, note)];

/** Catálogo del laboratorio (USD por MTok). cw = escritura 5 min (la única que usa Cursia). */
const LAB_CATALOG = Object.freeze([
  ...four('claude-sonnet-4-6', '3', '3.75', '0.30', '15', 'verified 2026-10-20'),
  ...four('claude-sonnet-5-5', '2', '2.50', '0.10', '10', 'verified 2026-10-20; cache read 0.05x'),
  ...four('claude-haiku-5-5#le100k', '0.10', '0.125', '0.01', '0.50', 'prompt <= 100k tokens'),
  ...four('claude-haiku-5-5#gt100k', '0.50', '0.625', '0.05', '2.50', 'prompt > 100k tokens'),
  // Juez opcional (rúbrica). Solo se usa si el operador lo activa.
  ...four('claude-opus-5-5', '4', '5', '0.20', '20', 'verified pricing page 2026-10-19; cache read 0.05x'),
]);

let pricingMod = null;
function pricing(distRoot) {
  if (!pricingMod) pricingMod = require(path.join(distRoot, 'modules/finops/pricing.js'));
  return pricingMod;
}

function productFor(model, usage) {
  if (model !== 'claude-haiku-5-5') return model;
  const prompt = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return prompt > 100000 ? 'claude-haiku-5-5#gt100k' : 'claude-haiku-5-5#le100k';
}

/** USD (string decimal exacto) de una llamada con `usage` en la forma de la API de Anthropic. */
function priceCall(distRoot, model, usage, catalog = LAB_CATALOG) {
  const P = pricing(distRoot);
  const meters = {
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_write_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_tokens: usage.cache_read_input_tokens || 0,
  };
  return P.priceUsage(meters, catalog, { provider: 'anthropic', service: 'messages', product: productFor(model, usage) }).amount;
}

/** Cota superior de una llamada antes de hacerla: toda la entrada a precio de escritura de caché (la más cara) y la
 *  salida completa hasta max_tokens (el pensamiento también cuenta como salida, [MIG55]). */
function upperBoundCall(distRoot, model, inputTokensEst, maxTokens, catalog = LAB_CATALOG) {
  const a = Number(priceCall(distRoot, model, { cache_creation_input_tokens: inputTokensEst, output_tokens: maxTokens }, catalog));
  const b = Number(priceCall(distRoot, model, { input_tokens: inputTokensEst, output_tokens: maxTokens }, catalog));
  return Math.max(a, b);
}

/** Precio por MTok (número) para la proyección analítica. */
function ratesOf(model, promptTokens = 0) {
  const product = model === 'claude-haiku-5-5' ? (promptTokens > 100000 ? 'claude-haiku-5-5#gt100k' : 'claude-haiku-5-5#le100k') : model;
  const r = {};
  for (const x of LAB_CATALOG) if (x.product_or_model === product) r[x.meter] = Number(x.unit_price);
  if (!('input_tokens' in r)) throw new Error(`modelab: sin precio para ${model}`);
  return { in: r.input_tokens, cw: r.cache_write_tokens, cr: r.cache_read_tokens, out: r.output_tokens };
}

module.exports = { LAB_CATALOG, PRICE_URL, priceCall, upperBoundCall, ratesOf, productFor };
