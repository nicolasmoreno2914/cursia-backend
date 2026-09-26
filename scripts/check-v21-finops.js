#!/usr/bin/env node
/* eslint-disable */
// V2.1 RF-a — check del Cost Ledger / FinOps (audit §W.9).
//
// Dos partes:
//  1) PURA (dist/): pricing con snapshot, claves de idempotencia, estimador,
//     costo incremental/evitado, budget gates, runtime guard, parse del ingest
//     y guard del token. Sin DB, sin red.
//  2) DB: Postgres 16 DESECHABLE (initdb en un dir temporal, puerto libre,
//     se destruye al final). Aplica la migración real (scripts/migrate-v21-finops.js)
//     y ejercita FinopsLedgerService contra ella. production_jobs y
//     generation_item_runs se crean como STUBS con las columnas exactas que lee
//     el servicio (tipos copiados de las migraciones reales).
//     Sin Postgres local (PG_BIN sin initdb) ⇒ la parte DB FALLA (no se saltea).
//
// Usage: npm run build && node scripts/check-v21-finops.js [path/to/dist]
// Env: PG_BIN (default /opt/homebrew/bin).

const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawnSync } = require('child_process');

const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar ${abs}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

require('reflect-metadata');
const finops = loadDist('modules/finops/index.js');
const { FinopsIngestController } = loadDist('modules/finops/finops.controller.js');
const {
  FinopsError, priceUsage, costIdempotencyKey, estimateCost, usageModelPriorsV1, evaluateBudget, runtimeGuard,
  incrementalCostForPlan, FINOPS_ITEM_TYPES, parseLlmUsageIngest, llmIngestToChargeInput, finopsTokenMatches,
  FinopsIngestTokenGuard, FinopsLedgerService, addDec, cmpDec, priceLine,
} = finops;
const { applyV21Finops, loadPricingSeed } = require('./migrate-v21-finops');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function throwsCode(fn, code, msg) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert(err, `${msg}: no lanzó`);
  assert(err instanceof FinopsError && err.code === code, `${msg}: esperaba ${code}, fue ${err && (err.code || err.message)}`);
}
async function rejects(p, re, msg) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${msg}: no lanzó`);
  if (re) assert(re.test(err.message), `${msg}: mensaje inesperado "${err.message}"`);
  return err;
}
const leq = (a, b) => cmpDec(a, b) <= 0;

const SEED = loadPricingSeed();
const CATALOG = SEED.rows.map((r, i) => ({ id: `seed-${i}`, ...r }));
const SONNET = { provider: 'anthropic', service: 'messages', product: 'claude-sonnet-4-6' };

// ══════════════════════════════════════════════════════════════════════════
// 1) PURO
// ══════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  await check('decimal: qty × precio / unidad exacto (sin floats)', () => {
    eq(priceLine('1234', '3', '1000000'), '0.0037020000', '1234 tok × $3/1M');
    eq(priceLine('1', '0.1', '3'), '0.0333333333', 'redondeo half-up a 10 decimales');
    eq(addDec('0.1', '0.2'), '0.3000000000', '0.1+0.2');
  });

  await check('pricing: Sonnet input/output/cache write/cache read suma exacta', () => {
    const r = priceUsage({ input_tokens: 1000, output_tokens: 2000, cache_write_tokens: 100, cache_read_tokens: 500 }, CATALOG, SONNET);
    // 1000×3/1M + 2000×15/1M + 100×3.75/1M + 500×0.3/1M
    eq(r.amount, '0.0335250000', 'amount');
    eq(r.currency, 'USD', 'currency');
    eq(r.lines.map((l) => l.meter), ['cache_read_tokens', 'cache_write_tokens', 'input_tokens', 'output_tokens'], 'orden de medidores');
    eq(r.pricingSnapshot.pricing_versions, ['anthropic-2026-06'], 'versión en snapshot');
    assert(r.pricingSnapshot.pricing_catalog_ids.length === 4, 'ids de catálogo en snapshot');
  });

  await check('pricing: medidor con cantidad y sin precio ⇒ PRICING_MISSING (cantidad 0 sin precio no falla)', () => {
    throwsCode(() => priceUsage({ input_tokens: 10, characters: 5 }, CATALOG, SONNET), 'PRICING_MISSING', 'characters sin precio');
    throwsCode(() => priceUsage({ input_tokens: 10 }, CATALOG, { ...SONNET, product: 'claude-desconocido' }), 'PRICING_MISSING', 'modelo sin precio');
    const r = priceUsage({ input_tokens: 10, characters: 0 }, CATALOG, SONNET);
    eq(r.lines.length, 1, 'characters=0 no genera línea');
    throwsCode(() => priceUsage({ input_tokens: -1 }, CATALOG, SONNET), 'INVALID_USAGE', 'negativo');
  });

  await check('pricing: snapshot copiado — cambiar el catálogo después no cambia un resultado guardado', () => {
    const cat = CATALOG.map((r) => ({ ...r }));
    const r1 = priceUsage({ input_tokens: 1000000 }, cat, SONNET);
    const stored = JSON.parse(JSON.stringify(r1));
    const row = cat.find((r) => r.product_or_model === 'claude-sonnet-4-6' && r.meter === 'input_tokens');
    row.unit_price = '99';
    row.pricing_version = 'mutada';
    eq(r1.pricingSnapshot, stored.pricingSnapshot, 'snapshot intacto tras mutar la fila');
    eq(r1.amount, '3.0000000000', 'monto intacto');
    eq(priceUsage({ input_tokens: 1000000 }, cat, SONNET).amount, '99.0000000000', 'un cálculo nuevo sí ve el catálogo nuevo');
  });

  await check('pricing: asOf elige la fila vigente; misma vigencia duplicada ⇒ PRICING_AMBIGUOUS', () => {
    const base = { provider: 'p', service: 's', product_or_model: 'm', meter: 'request', unit_size: '1', currency: 'USD', source: 'contract', verified: true };
    const cat = [
      { ...base, unit_price: '1', pricing_version: 'v1', effective_from: '2026-01-01T00:00:00Z', effective_to: '2026-06-01T00:00:00Z' },
      { ...base, unit_price: '2', pricing_version: 'v2', effective_from: '2026-06-01T00:00:00Z', effective_to: null },
    ];
    const at = { provider: 'p', service: 's', product: 'm' };
    eq(priceUsage({ request: 1 }, cat, { ...at, asOf: '2026-03-01T00:00:00Z' }).amount, '1.0000000000', 'v1 en marzo');
    eq(priceUsage({ request: 1 }, cat, { ...at, asOf: '2026-07-01T00:00:00Z' }).amount, '2.0000000000', 'v2 en julio');
    eq(priceUsage({ request: 1 }, cat, at).amount, '2.0000000000', 'sin asOf: fila abierta');
    throwsCode(() => priceUsage({ request: 1 }, cat, { ...at, asOf: '2025-01-01T00:00:00Z' }), 'PRICING_MISSING', 'antes de toda vigencia');
    const dup = [...cat, { ...base, unit_price: '3', pricing_version: 'v3', effective_from: '2026-06-01T00:00:00Z', effective_to: null }];
    throwsCode(() => priceUsage({ request: 1 }, dup, at), 'PRICING_AMBIGUOUS', 'duplicada');
  });

  await check('idempotencia: claves exactas por proveedor + fallback TTS', () => {
    eq(costIdempotencyKey('anthropic', { messageId: 'msg_01ABC' }), 'anthropic:msg:msg_01ABC', 'anthropic');
    eq(costIdempotencyKey('videogen', { jobId: 'vg-9' }), 'videogen:job:vg-9', 'videogen');
    eq(costIdempotencyKey('gamma', { generationId: 'g1' }), 'gamma:gen:g1', 'gamma');
    eq(costIdempotencyKey('openai_tts', { requestId: 'req_7' }), 'openai:req:req_7', 'openai');
    eq(costIdempotencyKey('openai_tts', { itemRunId: 'ir1', generation: 2, chunk: 0, attempt: 1 }), 'tts:ir1:2:0:1', 'tts fallback');
    eq(costIdempotencyKey('youtube', { videoId: 'yt1' }), 'youtube:video:yt1', 'youtube');
    eq(costIdempotencyKey('package', { jobId: 'job1' }), 'package:job1', 'package');
  });

  await check('idempotencia: ids vacíos / con espacios / tipo desconocido fallan', () => {
    throwsCode(() => costIdempotencyKey('anthropic', { messageId: '' }), 'INVALID_IDEMPOTENCY_PART', 'vacío');
    throwsCode(() => costIdempotencyKey('anthropic', { messageId: '   ' }), 'INVALID_IDEMPOTENCY_PART', 'espacios');
    throwsCode(() => costIdempotencyKey('anthropic', {}), 'INVALID_IDEMPOTENCY_PART', 'ausente');
    throwsCode(() => costIdempotencyKey('videogen', { jobId: 'a b' }), 'INVALID_IDEMPOTENCY_PART', 'espacio interno');
    throwsCode(() => costIdempotencyKey('openai_tts', { itemRunId: 'ir1', generation: 0, chunk: 0, attempt: 1 }), 'INVALID_IDEMPOTENCY_PART', 'generation 0');
    throwsCode(() => costIdempotencyKey('openai_tts', { itemRunId: 'ir1', generation: 1, chunk: -1, attempt: 1 }), 'INVALID_IDEMPOTENCY_PART', 'chunk -1');
    throwsCode(() => costIdempotencyKey('stripe', { jobId: 'x' }), 'UNKNOWN_IDEMPOTENCY_KIND', 'kind');
  });

  const allItems = FINOPS_ITEM_TYPES.map((t, i) => ({
    itemKey: `${t}:k${i}`, itemType: t, moduleId: 'm1', chapterId: ['course_plan', 'course_intro', 'audio_welcome', 'final_exam', 'module_intro', 'exam'].includes(t) ? null : `ch${i % 3}`,
  }));
  const estInput = (items) => ({ items, catalog: CATALOG, usageModel: usageModelPriorsV1(), retryPolicy: { maxRetries: 2 } });

  await check('estimador: todos los item types v3 (+scorm) con min <= expected <= max por línea y en totales', () => {
    const e = estimateCost(estInput(allItems));
    assert(e.lines.length >= FINOPS_ITEM_TYPES.length, 'una línea por operación');
    for (const l of e.lines) {
      assert(leq(l.min, l.expected) && leq(l.expected, l.max), `línea ${l.itemKey}/${l.operation}: ${l.min} ${l.expected} ${l.max}`);
    }
    assert(leq(e.totals.min, e.totals.expected) && leq(e.totals.expected, e.totals.max), 'totales monótonos');
    for (const g of ['byProvider', 'byItemType', 'byChapter']) {
      for (const [k, v] of Object.entries(e.totals[g])) assert(leq(v.min, v.expected) && leq(v.expected, v.max), `${g}.${k}`);
    }
    eq(Object.keys(e.totals.byProvider), ['anthropic', 'gamma', 'openai', 'videogen', 'youtube'], 'proveedores');
    const ops = (t) => e.lines.filter((l) => l.itemType === t).map((l) => l.operation);
    eq(ops('presentation'), ['gamma.generate'], 'presentation → gamma');
    eq(ops('video'), ['videogen.render', 'youtube.upload'], 'video → videogen + youtube');
    eq(ops('audiobook_chapter'), ['llm.audiobook_script', 'tts.audiobook_chapter'], 'audiobook → llm + tts');
    eq(ops('audio_welcome'), ['tts.audio_welcome'], 'audio_welcome → tts');
    eq(e.totals.byProvider.youtube.max, '0.0000000000', 'youtube $0');
    assert(e.totals.byChapter._none, 'items sin capítulo agrupados en _none');
    eq(e.estimatorVersion, 'finops-estimator-v1', 'versión');
    eq(e.usageModelVersion, 'usage-priors-v1', 'usage model');
  });

  await check('estimador: determinístico (mismo input ⇒ mismo output)', () => {
    eq(estimateCost(estInput(allItems)), estimateCost(estInput(allItems)), 'dos corridas');
  });

  await check('estimador: REUSE / REVIEW / STALE_NO_AUTO / SOFT_DISABLE ⇒ 0 incremental; evitado solo de los que conservan artifact', () => {
    const items = [
      { itemKey: 'content:a', itemType: 'content', chapterId: 'a', action: 'REUSE' },
      { itemKey: 'presentation:a', itemType: 'presentation', chapterId: 'a', action: 'REVIEW' },
      { itemKey: 'video:a', itemType: 'video', chapterId: 'a', action: 'STALE_NO_AUTO' },
      { itemKey: 'activity:a', itemType: 'activity', chapterId: 'a', action: 'SOFT_DISABLE' },
      { itemKey: 'exam:m', itemType: 'exam', action: 'GENERATE' },
    ];
    const e = estimateCost(estInput(items));
    for (const l of e.lines.filter((x) => x.itemKey !== 'exam:m')) {
      eq([l.min, l.expected, l.max], ['0.0000000000', '0.0000000000', '0.0000000000'], `0 incremental en ${l.itemKey}`);
      assert(cmpDec(l.wouldCost.expected, 0) >= 0, 'wouldCost presente');
    }
    const exam = e.lines.find((l) => l.itemKey === 'exam:m');
    eq(e.totals.expected, exam.expected, 'el total solo suma el GENERATE');
    eq(e.avoided.byItem.map((a) => a.itemKey), ['content:a', 'presentation:a', 'video:a'], 'evitado sin SOFT_DISABLE');
    assert(e.avoided.byItem.every((a) => a.basis === 'current_estimate'), 'basis current_estimate');
    throwsCode(() => estimateCost(estInput([{ itemKey: 'x', itemType: 'podcast' }])), 'UNKNOWN_ITEM_TYPE', 'tipo desconocido');
    throwsCode(() => estimateCost(estInput([{ itemKey: 'x', itemType: 'content', action: 'DELETE' }])), 'UNKNOWN_ACTION', 'acción desconocida');
  });

  await check('incremental: evitado historical actual first (CHARGE+ADJUSTMENT) y fallback a estimación vigente', () => {
    const items = [
      { itemKey: 'video:a', itemType: 'video', chapterId: 'a', action: 'REUSE' },
      { itemKey: 'content:a', itemType: 'content', chapterId: 'a', action: 'REUSE' },
      { itemKey: 'activity:a', itemType: 'activity', chapterId: 'a', action: 'GENERATE' },
    ];
    const e = estimateCost(estInput(items));
    const hist = {
      'ir-video': [
        { id: 'e1', event_kind: 'CHARGE', amount: '0.94' },
        { id: 'e2', event_kind: 'CHARGE', amount: '0.94' }, // retry pagado
        { id: 'e3', event_kind: 'ADJUSTMENT', amount: '0.12' },
        { id: 'e4', event_kind: 'REFUND', amount: '-0.50' }, // no cuenta
      ],
      'ir-content': [],
    };
    const r = incrementalCostForPlan(
      [
        { itemKey: 'video:a', action: 'REUSE', fromItemRunId: 'ir-video' },
        { itemKey: 'content:a', action: 'REUSE', fromItemRunId: 'ir-content' },
        { itemKey: 'activity:a', action: 'GENERATE' },
      ],
      e.lines,
      hist,
    );
    const [v, c, a] = r.actions;
    eq([v.basis, v.avoided, v.sourceChargeEventIds], ['historical_actual', '2.0000000000', ['e1', 'e2', 'e3']], 'video histórico');
    eq(v.incremental.expected, '0.0000000000', 'REUSE 0 incremental');
    const contentWould = e.lines.find((l) => l.itemKey === 'content:a').wouldCost.expected;
    eq([c.basis, c.avoided], ['current_estimate', contentWould], 'content sin historia ⇒ estimación');
    eq([a.basis, a.avoided], [null, '0.0000000000'], 'GENERATE no evita');
    eq(a.incremental.expected, e.lines.find((l) => l.itemKey === 'activity:a').expected, 'GENERATE incremental');
    eq(r.totals.avoided, addDec(v.avoided, c.avoided), 'total evitado');
  });

  const est = (min, expected, max, byProvider = {}, byItemType = {}) => ({ totals: { min, expected, max, byProvider, byItemType } });
  await check('budget: expected sobre el límite ⇒ BLOCK (on_exceed BLOCK)', () => {
    const r = evaluateBudget({ estimate: est('5', '12', '20'), policy: { limits: { maxCostPerRun: '10' }, requireHumanApprovalForRealSpend: false, onExceed: 'BLOCK' }, realSpend: true });
    eq(r.decision, 'BLOCK', 'decision');
    assert(r.reasons.some((x) => x.startsWith('maxCostPerRun:expected_over_limit')), 'razón');
    const r2 = evaluateBudget({ estimate: est('5', '12', '20'), policy: { limits: { maxCostPerRun: '10' }, requireHumanApprovalForRealSpend: false, onExceed: 'ADMIN_APPROVAL' }, realSpend: true });
    eq(r2.decision, 'ADMIN_APPROVAL', 'on_exceed ADMIN_APPROVAL');
  });

  await check('budget: dentro de todos los límites y sin aprobación humana requerida ⇒ AUTO_WITHIN_POLICY', () => {
    const r = evaluateBudget({
      estimate: est('1', '2', '3', { videogen: { min: '1', expected: '1', max: '2' } }),
      policy: { limits: { maxCostPerRun: '10', maxCostPerCourse: '50', maxCostPerProvider: { videogen: '5' }, maxCostPerItemType: { video: null } }, requireHumanApprovalForRealSpend: false },
      spentSoFar: { course: '10', byProvider: { videogen: '2' } },
      realSpend: true,
    });
    eq(r.decision, 'AUTO_WITHIN_POLICY', 'decision');
  });

  await check('budget: gasto real con requireHumanApprovalForRealSpend (staging) ⇒ ADMIN_APPROVAL aunque esté dentro', () => {
    const r = evaluateBudget({ estimate: est('0.1', '0.2', '0.3'), policy: { limits: { maxCostPerRun: '100' }, requireHumanApprovalForRealSpend: true }, realSpend: true });
    eq(r.decision, 'ADMIN_APPROVAL', 'decision');
    assert(r.reasons.includes('real_spend_requires_human_approval'), 'razón');
    const r2 = evaluateBudget({ estimate: est('0.1', '0.2', '0.3'), policy: { limits: {} }, realSpend: true });
    eq(r2.decision, 'ADMIN_APPROVAL', 'default (flag ausente) = requiere aprobación');
    const r3 = evaluateBudget({ estimate: est('0.1', '0.2', '0.3'), policy: null, realSpend: true });
    eq(r3.decision, 'ADMIN_APPROVAL', 'sin política ⇒ aprobación');
  });

  await check('budget: expected <= límite < max ⇒ ADMIN_APPROVAL; límites de curso/proveedor suman lo gastado; mock siempre permitido', () => {
    eq(evaluateBudget({ estimate: est('5', '8', '15'), policy: { limits: { maxCostPerRun: '10' }, requireHumanApprovalForRealSpend: false }, realSpend: true }).decision, 'ADMIN_APPROVAL', 'banda');
    eq(evaluateBudget({ estimate: est('1', '2', '3'), policy: { limits: { maxCostPerCourse: '10' }, requireHumanApprovalForRealSpend: false }, spentSoFar: { course: '9' }, realSpend: true }).decision, 'BLOCK', 'curso con gasto previo');
    eq(evaluateBudget({
      estimate: est('1', '2', '3', { videogen: { min: '1', expected: '2', max: '3' } }),
      policy: { limits: { maxCostPerProvider: { videogen: '3' } }, requireHumanApprovalForRealSpend: false },
      spentSoFar: { byProvider: { videogen: '2' } }, realSpend: true,
    }).decision, 'BLOCK', 'proveedor con gasto previo');
    eq(evaluateBudget({
      estimate: est('1', '2', '3', {}, { video: { min: '1', expected: '2', max: '3' } }),
      policy: { limits: { maxCostPerItemType: { video: '1' } }, requireHumanApprovalForRealSpend: false }, realSpend: true,
    }).decision, 'BLOCK', 'por item type');
    eq(evaluateBudget({ estimate: est('500', '900', '999'), policy: { limits: { maxCostPerRun: '1' } }, realSpend: false }).decision, 'AUTO_WITHIN_POLICY', 'mock');
    throwsCode(() => evaluateBudget({ estimate: est('1', '1', '1'), policy: { limits: { maxCostPerRun: '-1' } }, realSpend: true }), 'INVALID_POLICY', 'límite negativo');
    throwsCode(() => evaluateBudget({ estimate: est('1', '1', '1'), policy: { limits: {} } }), 'INVALID_INPUT', 'realSpend implícito');
  });

  await check('runtime guard: actual + reservas + next <= autorizado ⇒ allow; si no ⇒ block; sin autorización ⇒ block', () => {
    const ok = runtimeGuard({ authorizedBudget: '10', actualSoFar: '6', reservedInFlight: '2', next: '2' });
    eq([ok.allow, ok.committed, ok.remaining], [true, '10.0000000000', '0.0000000000'], 'justo en el límite');
    const no = runtimeGuard({ authorizedBudget: '10', actualSoFar: '6', reservedInFlight: '2', next: '2.0000000001' });
    eq([no.allow, no.reason], [false, 'budget_exceeded'], 'excede por 1e-10');
    eq(runtimeGuard({ authorizedBudget: null, actualSoFar: '0', reservedInFlight: '0', next: '0.01' }).reason, 'no_authorization', 'sin autorización');
  });

  await check('ingest: body validado; campos extra, montos del cliente y tokens negativos se rechazan', () => {
    const good = { subject: 'u1', itemRunId: null, callRole: 'main', attempt: 1, model: 'claude-sonnet-4-6', messageId: 'msg_1', requestId: 'req_1', usage: { input_tokens: 10, output_tokens: 5 }, billingAccount: 'cursia' };
    const p = parseLlmUsageIngest(good);
    const ci = llmIngestToChargeInput(p);
    eq(ci.idempotency, { kind: 'anthropic', parts: { messageId: 'msg_1' } }, 'clave anthropic');
    eq(ci.usage, { input_tokens: 10, output_tokens: 5, cache_write_tokens: 0, cache_read_tokens: 0 }, 'medidores');
    eq([ci.recordedBy, ci.mode, ci.billingAccount], ['llm-proxy', 'real', 'cursia'], 'defaults');
    throwsCode(() => parseLlmUsageIngest({ ...good, amount: 0.01 }), 'INVALID_INPUT', 'amount del cliente');
    throwsCode(() => parseLlmUsageIngest({ ...good, courseId: 5 }), 'INVALID_INPUT', 'courseId del cliente');
    throwsCode(() => parseLlmUsageIngest({ ...good, usage: { input_tokens: -1, output_tokens: 1 } }), 'INVALID_INPUT', 'negativo');
    throwsCode(() => parseLlmUsageIngest({ ...good, messageId: '' }), 'INVALID_INPUT', 'sin messageId');
    throwsCode(() => parseLlmUsageIngest({ ...good, callRole: 'whatever' }), 'INVALID_INPUT', 'callRole');
    throwsCode(() => parseLlmUsageIngest({ ...good, billingAccount: 'mock' }), 'INVALID_INPUT', 'billing mock por HTTP');
  });

  await check('ingest guard: env sin setear ⇒ 503; header ausente/incorrecto ⇒ 401; correcto ⇒ pasa (tiempo constante)', () => {
    const ctx = (headers) => ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) });
    const g = new FinopsIngestTokenGuard();
    const saved = process.env.FINOPS_INGEST_TOKEN;
    try {
      delete process.env.FINOPS_INGEST_TOKEN;
      let e = null;
      try { g.canActivate(ctx({ 'x-cursia-finops-token': 'x' })); } catch (err) { e = err; }
      assert(e && e.getStatus && e.getStatus() === 503, `esperaba 503, fue ${e && e.getStatus && e.getStatus()}`);
      process.env.FINOPS_INGEST_TOKEN = 's3cret-token';
      for (const h of [{}, { 'x-cursia-finops-token': 's3cret-toke' }, { 'x-cursia-finops-token': 's3cret-token-extra' }]) {
        e = null;
        try { g.canActivate(ctx(h)); } catch (err) { e = err; }
        assert(e && e.getStatus() === 401, `esperaba 401 para ${JSON.stringify(h)}`);
      }
      assert(g.canActivate(ctx({ 'x-cursia-finops-token': 's3cret-token' })) === true, 'token correcto');
      assert(finopsTokenMatches('a', 'a') && !finopsTokenMatches('a', 'b') && !finopsTokenMatches(undefined, 'a'), 'finopsTokenMatches');
    } finally {
      if (saved === undefined) delete process.env.FINOPS_INGEST_TOKEN; else process.env.FINOPS_INGEST_TOKEN = saved;
    }
  });

  await check('seed de precios: verified explícito; Videogen observado 0.94 no verificado; Gamma placeholder; YouTube $0', () => {
    for (const r of SEED.rows) assert(typeof r.verified === 'boolean', `verified en ${r.product_or_model}/${r.meter}`);
    const vg = SEED.rows.find((r) => r.provider === 'videogen');
    eq([vg.meter, vg.unit_price, vg.source, vg.verified], ['video_render', '0.94', 'observed', false], 'videogen');
    const gm = SEED.rows.find((r) => r.provider === 'gamma');
    eq([gm.meter, gm.source, gm.verified], ['gamma_credit', 'placeholder', false], 'gamma');
    const yt = SEED.rows.find((r) => r.provider === 'youtube');
    eq([yt.meter, yt.unit_price], ['quota_unit', '0'], 'youtube');
    const tts = SEED.rows.filter((r) => r.product_or_model === 'gpt-4o-mini-tts').map((r) => r.meter).sort();
    eq(tts, ['audio_output_tokens', 'audio_seconds', 'text_input_tokens'], 'tts meters');
    for (const m of ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-8']) {
      const meters = SEED.rows.filter((r) => r.product_or_model === m).map((r) => r.meter).sort();
      eq(meters, ['cache_read_tokens', 'cache_write_tokens', 'input_tokens', 'output_tokens'], `medidores ${m}`);
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// 2) DB — Postgres 16 desechable
// ══════════════════════════════════════════════════════════════════════════
const PG_BIN = process.env.PG_BIN || '/opt/homebrew/bin';
const FORBIDDEN_PORTS = new Set([5570]); // DB de Moodle de pruebas: nunca tocar.

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function run(bin, args, env) {
  const r = spawnSync(path.join(PG_BIN, bin), args, { env: { ...process.env, LC_ALL: 'C', ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')} falló: ${r.stderr || r.stdout || r.error}`);
  return r.stdout;
}

const STUB_SQL = `
  -- STUBS: solo las columnas que lee FinopsLedgerService, con los tipos de
  -- ProductionJob (owner_id varchar(36)) y de supabase-migration-dynamic-generation(.v2).sql.
  create table public.production_jobs (
    id uuid primary key default gen_random_uuid(),
    owner_id varchar(36) not null,
    course_id integer
  );
  create table public.generation_item_runs (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.production_jobs(id) on delete cascade,
    course_id integer not null,
    blueprint_id integer not null,
    manifest_id integer not null,
    item_key text not null,
    generation integer not null default 1,
    type text not null,
    scope text,
    module_id uuid,
    chapter_id uuid
  );
`;

async function dbChecks() {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    await check('DB: Postgres local disponible', () => { throw new Error(`no hay initdb en ${PG_BIN} (setear PG_BIN)`); });
    return;
  }
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finops-pg-'));
  const dataDir = path.join(dir, 'data');
  let port = await freePort();
  while (FORBIDDEN_PORTS.has(port)) port = await freePort();
  let started = false;
  let ds = null;
  let client = null;
  try {
    run('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '--locale=C', '-E', 'UTF8'], {});
    run('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, '-l', path.join(dir, 'log'), '-w', 'start'], {});
    started = true;
    run('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', 'finops'], {});

    client = new Client({ host: '127.0.0.1', port, user: 'postgres', database: 'finops' });
    await client.connect();
    await client.query(STUB_SQL);

    await check('DB: la migración aplica y es idempotente (2 corridas; seed ON CONFLICT DO NOTHING)', async () => {
      await client.query('begin');
      const r1 = await applyV21Finops(client);
      await client.query('commit');
      await client.query('begin');
      const r2 = await applyV21Finops(client);
      await client.query('commit');
      eq([r1.inserted, r2.inserted], [SEED.rows.length, 0], 'filas de seed insertadas');
      const { rows } = await client.query(`select count(*)::int n from public.pricing_catalog`);
      eq(rows[0].n, SEED.rows.length, 'catálogo');
      const trg = await client.query(`select count(*)::int n from pg_trigger where tgname like '%_append_only' or tgname like '%_no_truncate'`);
      eq(trg.rows[0].n, 12, '6 tablas × 2 triggers');
    });

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: 'finops', entities: [], synchronize: false, extra: { max: 10 } });
    await ds.initialize();
    const ledger = new FinopsLedgerService(ds);

    // Fixtures: owner A (víctima) con un item run content; owner B (atacante) con el suyo.
    const OWNER_A = 'aa2fa9a1-afb1-4b01-8646-94a0cb272b57';
    const OWNER_B = '11111111-2222-4333-8444-555555555555';
    const CH = '0f9a2c1e-1111-4222-8333-444455556666';
    const MOD = '0f9a2c1e-1111-4222-8333-777788889999';
    const { rows: [jobA] } = await client.query(`insert into public.production_jobs (owner_id, course_id) values ($1, 101) returning id`, [OWNER_A]);
    const { rows: [jobB] } = await client.query(`insert into public.production_jobs (owner_id, course_id) values ($1, 202) returning id`, [OWNER_B]);
    const { rows: [irA] } = await client.query(
      `insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, scope, module_id, chapter_id)
       values ($1, 101, 11, 21, $2, 2, 'content', 'chapter', $3, $4) returning id`,
      [jobA.id, `content:${CH}`, MOD, CH],
    );
    const { rows: [irAv] } = await client.query(
      `insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, scope, module_id, chapter_id)
       values ($1, 101, 11, 21, $2, 1, 'video', 'chapter', $3, $4) returning id`,
      [jobA.id, `video:${CH}`, MOD, CH],
    );

    const llmCharge = (over = {}) => ({
      itemRunId: irA.id,
      ownerIdFromAuth: OWNER_A,
      provider: 'anthropic', service: 'messages', modelOrProduct: 'claude-sonnet-4-6',
      usage: { input_tokens: 1000, output_tokens: 2000 },
      externalOperationId: 'msg_same',
      idempotency: { kind: 'anthropic', parts: { messageId: 'msg_same' } },
      billingAccount: 'cursia', mode: 'real', recordedBy: 'llm-proxy',
      ...over,
    });

    await check('DB: misma idempotency_key 5 veces en paralelo (Promise.all) ⇒ 1 fila, 1 inserted', async () => {
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => ledger.recordCharge(llmCharge())));
      eq(rs.filter((r) => r.inserted).length, 1, 'un solo inserted');
      assert(new Set(rs.map((r) => r.event.id)).size === 1, 'todos devuelven la misma fila');
      const { rows } = await client.query(`select count(*)::int n from public.generation_cost_events where idempotency_key = 'anthropic:msg:msg_same'`);
      eq(rows[0].n, 1, 'filas');
      const ev = rs[0].event;
      eq([ev.amount, ev.course_id, ev.run_id, ev.item_key, ev.item_type, ev.item_generation, ev.chapter_id, ev.module_id, ev.operation, ev.owner_id],
        ['0.0330000000', 101, jobA.id, `content:${CH}`, 'content', 2, CH, MOD, 'llm.content', OWNER_A], 'atribución derivada server-side');
      eq([ev.cost_source, ev.billable, ev.billing_account], ['CALCULATED_FROM_USAGE', true, 'cursia'], 'fuente');
    });

    await check('DB: retry con otro message id ⇒ 2 filas (retry pagado visible en costsByRun)', async () => {
      const r = await ledger.recordCharge(llmCharge({ externalOperationId: 'msg_retry', idempotency: { kind: 'anthropic', parts: { messageId: 'msg_retry' } }, callRole: 'validation_retry', attempt: 2 }));
      assert(r.inserted, 'insertó');
      const { rows } = await client.query(`select count(*)::int n from public.generation_cost_events where item_run_id = $1`, [irA.id]);
      eq(rows[0].n, 2, 'filas del item run');
      const byRun = await ledger.costsByRun(jobA.id);
      eq([byRun.retriesPaid.events, byRun.retriesPaid.total], [1, '0.0330000000'], 'retries pagados');
      eq(byRun.totals.total, '0.0660000000', 'total del run');
    });

    await check('DB: UPDATE, DELETE y TRUNCATE sobre el ledger fallan (trigger); también sobre pricing_catalog', async () => {
      await rejects(client.query(`update public.generation_cost_events set amount = 0`), /append-only/, 'update');
      await rejects(client.query(`delete from public.generation_cost_events`), /append-only/, 'delete');
      await rejects(client.query(`truncate public.generation_cost_events`), /append-only/, 'truncate');
      await rejects(client.query(`update public.pricing_catalog set unit_price = 0`), /append-only/, 'update catálogo');
      await rejects(client.query(`delete from public.pricing_catalog`), /append-only/, 'delete catálogo');
      await rejects(client.query(`truncate public.cost_avoidance_events`), /append-only/, 'truncate evitado (vacía: trigger de statement)');
      const { rows } = await client.query(`select count(*)::int n from public.generation_cost_events`);
      eq(rows[0].n, 2, 'nada cambió');
    });

    await check('DB: nuevo precio (fila nueva de catálogo) ⇒ el monto histórico no cambia; cargos nuevos usan el precio nuevo', async () => {
      await client.query(
        `insert into public.pricing_catalog (provider, service, product_or_model, meter, unit_size, unit_price, currency, pricing_version, effective_from, source, verified)
         values ('anthropic','messages','claude-sonnet-4-6','output_tokens',1000000,30,'USD','anthropic-test-2026-09', now() - interval '1 second','contract',true)`,
      );
      const { rows: [old] } = await client.query(`select amount::text a, pricing_snapshot from public.generation_cost_events where idempotency_key = 'anthropic:msg:msg_same'`);
      eq(old.a, '0.0330000000', 'monto histórico intacto');
      eq(old.pricing_snapshot.lines.find((l) => l.meter === 'output_tokens').unit_price, '15.0000000000', 'snapshot histórico intacto');
      const r = await ledger.recordCharge(llmCharge({ externalOperationId: 'msg_new_price', idempotency: { kind: 'anthropic', parts: { messageId: 'msg_new_price' } } }));
      eq(r.event.amount, '0.0630000000', 'nuevo cargo con output a $30/1M');
      eq(r.event.pricing_snapshot.pricing_versions, ['anthropic-2026-06', 'anthropic-test-2026-09'], 'versiones en el snapshot nuevo');
    });

    await check('DB: itemRunId de otro owner ⇒ NO atribuido (no toca el curso de la víctima; metadata del cliente no pisa)', async () => {
      const r = await ledger.recordCharge(llmCharge({
        ownerIdFromAuth: OWNER_B,
        externalOperationId: 'msg_attacker',
        idempotency: { kind: 'anthropic', parts: { messageId: 'msg_attacker' } },
        metadata: { attributionRejected: false, course_id: 101, itemKey: 'x' },
      }));
      const ev = r.event;
      eq([ev.item_run_id, ev.item_key, ev.course_id, ev.run_id, ev.chapter_id, ev.owner_id, ev.operation],
        [null, null, null, null, null, OWNER_B, 'llm.unattributed'], 'sin atribución, pagado por el atacante');
      eq([ev.metadata.attributionRejected, ev.metadata.attributionRejectReason], [true, 'owner_mismatch'], 'metadata server-side');
      const course = await ledger.costsByCourse(101);
      eq(course.totals.events, 3, 'el curso de la víctima solo tiene sus 3 eventos');
      const own = await ledger.costsByOwner(OWNER_B);
      eq(own.unattributed.events, 1, 'no atribuido del atacante');
      const nf = await ledger.recordCharge(llmCharge({ ownerIdFromAuth: OWNER_B, itemRunId: '00000000-0000-4000-8000-000000000000', idempotency: { kind: 'anthropic', parts: { messageId: 'msg_nf' } } }));
      eq([nf.event.item_run_id, nf.event.metadata.attributionRejectReason], [null, 'item_run_not_found'], 'item run inexistente');
      const bad = await ledger.recordCharge(llmCharge({ ownerIdFromAuth: OWNER_B, itemRunId: "x'; drop table x;--", idempotency: { kind: 'anthropic', parts: { messageId: 'msg_bad' } } }));
      eq(bad.event.metadata.attributionRejectReason, 'invalid_item_run_id', 'id inválido');
      const none = await ledger.recordCharge(llmCharge({ ownerIdFromAuth: OWNER_B, itemRunId: null, idempotency: { kind: 'anthropic', parts: { messageId: 'msg_none' } } }));
      eq([none.event.operation, none.event.metadata.attributionRejected], ['llm.unattributed', undefined], 'sin itemRunId: no atribuido, no rechazado');
    });

    await check('DB: ADJUSTMENT agrega el delta (nunca edita); mismo ajuste repetido no duplica; A→B→A→B correcto', async () => {
      const vg = await ledger.recordCharge({
        itemRunId: irAv.id, ownerIdFromAuth: OWNER_A, provider: 'videogen', service: 'render', modelOrProduct: 'video',
        usage: { video_render: 1 }, externalOperationId: 'vg-1', idempotency: { kind: 'videogen', parts: { jobId: 'vg-1' } },
        billingAccount: 'cursia', mode: 'real', recordedBy: 'dynamic-item-worker', measurementStatus: 'pending',
      });
      eq([vg.event.amount, vg.event.operation, vg.event.cost_source], ['0.9400000000', 'videogen.render', 'CALCULATED_FROM_USAGE'], 'cargo videogen (HD-V21-20)');
      const a1 = await ledger.recordAdjustment('videogen:job:vg-1', '1.10', 'getVideoCost final');
      eq([a1.inserted, a1.delta, a1.event.event_kind, a1.event.corrects_event_id, a1.event.course_id], [true, '0.1600000000', 'ADJUSTMENT', vg.event.id, 101], 'primer ajuste');
      const again = await Promise.all([ledger.recordAdjustment('videogen:job:vg-1', '1.10', 'poll'), ledger.recordAdjustment('videogen:job:vg-1', '1.10', 'poll')]);
      eq(again.map((x) => x.inserted), [false, false], 'repetido ⇒ delta 0, nada');
      await ledger.recordAdjustment('videogen:job:vg-1', '0.94', 'vuelve');
      await ledger.recordAdjustment('videogen:job:vg-1', '1.10', 'otra vez');
      const { rows } = await client.query(
        `select sum(amount)::text total, count(*)::int n, bool_and(event_kind in ('CHARGE','ADJUSTMENT')) ok
           from public.generation_cost_events where item_run_id = $1`, [irAv.id]);
      eq([rows[0].total, rows[0].n, rows[0].ok], ['1.1000000000', 4, true], 'CHARGE + 3 ajustes = 1.10');
      const { rows: [orig] } = await client.query(`select amount::text a from public.generation_cost_events where id = $1`, [vg.event.id]);
      eq(orig.a, '0.9400000000', 'el CHARGE original no se editó');
      const hist = await ledger.historicalByItemRun([irAv.id]);
      eq(addDec('0', ...hist[irAv.id].map((e) => e.amount)), '1.1000000000', 'historicalByItemRun');
      await rejects(ledger.recordAdjustment('videogen:job:nope', '1', 'x'), /ORIGINAL_NOT_FOUND/, 'original inexistente');
    });

    await check('DB: cero por diseño (YouTube cuota), user_key no facturable, mock, y ESTIMATED rechazado por constraint', async () => {
      const yt = await ledger.recordZero({ kind: 'youtube', externalId: 'yt-1', ownerIdFromAuth: OWNER_A, itemRunId: irAv.id, quotaUnits: 1600, recordedBy: 'dynamic-item-worker' });
      eq([yt.event.amount, yt.event.cost_source, yt.event.quota_units, yt.event.operation, yt.event.idempotency_key], ['0.0000000000', 'ZERO_BY_DESIGN', '1600.000000', 'youtube.upload', 'youtube:video:yt-1'], 'youtube');
      const uk = await ledger.recordCharge(llmCharge({ billingAccount: 'user_key', idempotency: { kind: 'anthropic', parts: { messageId: 'msg_uk' } } }));
      eq([uk.event.billable, uk.event.billing_account], [false, 'user_key'], 'user_key');
      const mk = await ledger.recordCharge(llmCharge({ billingAccount: 'mock', mode: 'mock', idempotency: { kind: 'anthropic', parts: { messageId: 'msg_mock' } } }));
      eq([mk.event.cost_source, mk.event.billable], ['MOCK', false], 'mock');
      await rejects(client.query(
        `insert into public.generation_cost_events (event_kind, operation, provider, idempotency_key, amount, cost_source, billing_account, billable, recorded_by)
         values ('CHARGE','llm.x','anthropic','k-est',1,'ESTIMATED','cursia',true,'t')`), /gce_no_estimated/, 'ESTIMATED');
      await rejects(ledger.recordCharge(llmCharge({ idempotency: { kind: 'anthropic', parts: { messageId: 'msg_nopr' } }, modelOrProduct: 'claude-sin-precio' })), /PRICING_MISSING/, 'sin precio ⇒ falla fuerte, no inserta');
      const { rows } = await client.query(`select count(*)::int n from public.generation_cost_events where idempotency_key = 'anthropic:msg:msg_nopr'`);
      eq(rows[0].n, 0, 'nada insertado');
    });

    await check('DB: evitado idempotente por (run, item_key); estimate + authorize; estimated vs actual por run', async () => {
      const runB = '9b0c7a3e-0000-4000-8000-00000000000b';
      const av = { runId: runB, courseId: 101, manifestId: 22, itemKey: `video:${CH}`, action: 'REUSE', sourceItemRunId: irAv.id, basis: 'historical_actual', avoidedAmount: '1.10', sourceChargeEventIds: [] };
      await rejects(ledger.recordAvoidance(av), /cae_historical_has_events/, 'historical sin eventos');
      const hist = await ledger.historicalByItemRun([irAv.id]);
      const ids = hist[irAv.id].map((e) => e.id);
      const r = await Promise.all([ledger.recordAvoidance({ ...av, sourceChargeEventIds: ids }), ledger.recordAvoidance({ ...av, sourceChargeEventIds: ids })]);
      eq(r.map((x) => x.inserted).sort(), [false, true], 'una sola fila');
      await rejects(client.query(`delete from public.cost_avoidance_events`), /append-only/, 'delete evitado');
      const e = estimateCost({ items: [{ itemKey: `content:${CH}`, itemType: 'content', chapterId: CH }], catalog: CATALOG, usageModel: usageModelPriorsV1(), retryPolicy: { maxRetries: 2 } });
      const estRow = await ledger.createEstimate({ scope: 'run', ownerId: OWNER_A, courseId: 101, manifestId: 21, runId: jobA.id, estimate: e });
      await rejects(client.query(`update public.cost_estimates set scope = 'run'`), /append-only/, 'estimate inmutable');
      const auth = await ledger.authorize({ runId: jobA.id, courseId: 101, estimateId: estRow.id, authorizedBudget: e.totals.max, decision: 'ADMIN_APPROVED', approvedBy: 'admin@cursia' });
      assert(auth.id, 'autorización');
      await rejects(ledger.authorize({ courseId: 101, authorizedBudget: '1', decision: 'ADMIN_APPROVED' }), /approvedBy/, 'ADMIN_APPROVED sin approvedBy');
      const run = await ledger.costsByRun(jobA.id);
      eq([run.estimatedVsActual.estimate_id, run.estimatedVsActual.est_expected], [estRow.id, e.totals.expected], 'estimado del run');
      eq(run.authorizations.length, 1, 'autorizaciones');
      const course = await ledger.costsByCourse(101);
      eq(course.avoided.total, '1.1000000000', 'evitado del curso');
      assert(course.byChapter.some((g) => g.key === CH), 'byChapter');
      assert(course.byItemType.some((g) => g.key === 'video'), 'byItemType');
      assert(course.estimatedVsActual.some((x) => x.run_id === jobA.id), 'estimated vs actual por run');
    });

    await check('DB: controller de ingest (sin HTTP) registra con atribución verificada y responde idempotente', async () => {
      const ctrl = new FinopsIngestController(ledger);
      const body = { subject: OWNER_A, itemRunId: irA.id, callRole: 'continuation', attempt: 1, model: 'claude-sonnet-4-6', messageId: 'msg_ingest', requestId: 'req_x', usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 1000 }, billingAccount: 'cursia' };
      const r1 = await ctrl.llmUsage(body);
      const r2 = await ctrl.llmUsage(body);
      eq([r1.inserted, r2.inserted, r1.eventId === r2.eventId, r1.attributed], [true, false, true, true], 'idempotente y atribuido');
      let err = null;
      try { await ctrl.llmUsage({ ...body, messageId: 'msg_z', amount: 5 }); } catch (e) { err = e; }
      assert(err && err.getStatus && err.getStatus() === 400, 'campo extra ⇒ 400');
      // RF-b fix C1/I2 (ruling del controller): sin precio ⇒ el cargo NO se pierde:
      // CHARGE a 0, pending, metadata.pricingMissing y 202 (antes: 422).
      const fakeRes = { code: 200, status(c) { this.code = c; return this; } };
      const rp = await ctrl.llmUsage({ ...body, messageId: 'msg_y', model: 'claude-sin-precio' }, fakeRes);
      eq([fakeRes.code, rp.inserted, rp.pricingMissing, rp.measurementStatus, rp.amount], [202, true, true, 'pending', '0.0000000000'], 'sin precio ⇒ 202 pendiente');
    });
  } catch (err) {
    failures++;
    console.error(`❌ DB: setup/teardown\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`);
  } finally {
    if (ds && ds.isInitialized) await ds.destroy().catch(() => {});
    if (client) await client.end().catch(() => {});
    if (started) {
      try { run('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], {}); } catch (e) { console.error('⚠️  no se pudo detener el Postgres temporal:', e.message); }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await pureChecks();
  await dbChecks();
  console.log(`\n${passes} ok, ${failures} fallidos`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
