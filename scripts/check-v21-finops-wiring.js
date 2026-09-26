#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — RF-b: cableado FinOps (proxy LLM → ingest, workers → ledger,
// estimador + gates de presupuesto en runs.service, runtime guard).
//
// Parte pura (siempre; CI la corre con --pure-only):
//   - items del estimador desde el Manifest (mock excluye items de worker),
//     proveedores pagados reales, decisión de presupuesto (mock AUTO, pagado
//     real → ADMIN_APPROVAL, BLOCK por política, LLM nunca BLOCK);
//   - REUSE → incremental 0 (incrementalCostForPlan sobre el estimado);
//   - rol/intento de un reenvío de Videogen, mensaje budget_exceeded, cuota YouTube;
//   - ingest HTTP real (Nest + guard): env ausente → 503, token malo → 401,
//     body con la forma del proxy → 200; campos del cliente como `amount` → 400.
// Parte DB (default; PG16 desechable, puerto libre ≠ 5570, dir temporal que se
// destruye): esquema real (legacy + Fases + v2 + invalidación + R3 + R4 +
// FinOps por sus scripts de migración), RunsService / SchedulerService /
// FinopsLedgerService / FinopsBudgetService / workers COMPILADOS con fakes de
// Videogen, YouTube y proveedores (0 llamadas reales, 0 red).
//
// Usage: node scripts/check-v21-finops-wiring.js [--pure-only] [path/to/dist]

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
const distArg = args.find((a) => !a.startsWith('--'));
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), distArg || 'dist');

function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

require('reflect-metadata');
const F = loadDist('modules/finops/index.js');
const H = loadDist('workers/finops-worker-hooks.js');
const VD = loadDist('workers/video-duration.js');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg}: esperado ${y}, encontrado ${x}`);
}
async function rejectsRe(p, re, msg, status) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${msg}: no lanzó`);
  const text = err.message + ' ' + JSON.stringify(err.getResponse ? err.getResponse() : '');
  assert(re.test(text), `${msg}: mensaje inesperado "${text}"`);
  if (status !== undefined) assert(err.getStatus && err.getStatus() === status, `${msg}: status ${err.getStatus && err.getStatus()} (esperado ${status})`);
  return err;
}
const dec = (x) => Number(x);
const near = (a, b) => Math.abs(dec(a) - dec(b)) < 1e-9;

// ════════════════════════════════════════════════════════════════════════════
// Parte pura
// ════════════════════════════════════════════════════════════════════════════
const V3_ITEMS = [
  { key: 'course_plan:c', type: 'course_plan', moduleId: null, chapterId: null },
  { key: 'audio_welcome:c', type: 'audio_welcome', moduleId: null, chapterId: null },
  { key: 'content:ch1', type: 'content', moduleId: 'm1', chapterId: 'ch1' },
  { key: 'presentation:ch1', type: 'presentation', moduleId: 'm1', chapterId: 'ch1' },
  { key: 'video:ch1', type: 'video', moduleId: 'm1', chapterId: 'ch1' },
  { key: 'video_interactions:ch1', type: 'video_interactions', moduleId: 'm1', chapterId: 'ch1' },
  { key: 'audiobook_chapter:ch1', type: 'audiobook_chapter', moduleId: 'm1', chapterId: 'ch1' },
  { key: 'exam:m1', type: 'exam', moduleId: 'm1', chapterId: null },
];

function seedCatalog() {
  const seed = JSON.parse(fs.readFileSync(path.join(REPO, 'src/modules/finops/pricing-seed.v1.json'), 'utf8'));
  return seed.rows.map((r, i) => ({ id: `seed-${i}`, ...r }));
}

async function pureChecks() {
  const catalog = seedCatalog();
  const estimate = (items, rp) => F.estimateCost({ items, catalog, usageModel: F.usageModelPriorsV1(), retryPolicy: rp || { maxRetries: 1 } });

  await check('puro: items del estimador — mock excluye items de worker pagado; real los incluye; acciones del plan respetadas', () => {
    const mock = F.estimateItemsForRun(V3_ITEMS, 'mock');
    eq(mock.map((x) => x.itemKey), ['course_plan:c', 'content:ch1', 'video_interactions:ch1', 'exam:m1'], 'mock');
    const real = F.estimateItemsForRun(V3_ITEMS, 'real', { 'video:ch1': 'REUSE' });
    eq(real.length, V3_ITEMS.length, 'real');
    eq(real.find((x) => x.itemKey === 'video:ch1').action, 'REUSE', 'acción');
    eq(real.find((x) => x.itemKey === 'content:ch1').action, 'GENERATE', 'default');
    eq(F.paidRealProviders(real, 'real'), ['gamma', 'openai'], 'video REUSE no es gasto');
    eq(F.paidRealProviders(F.estimateItemsForRun(V3_ITEMS, 'real'), 'real'), ['gamma', 'openai', 'videogen'], 'todos');
    eq(F.paidRealProviders(F.estimateItemsForRun(V3_ITEMS, 'real'), 'mock'), [], 'mock nunca paga');
  });

  await check('puro (merge R5): modos de gasto POR proveedor — video mock + providerModes real ⇒ Gamma/TTS se estiman y exigen aprobación; providerModes ausentes ⇒ real (fail safe)', () => {
    const modes = F.runSpendModes('mock', { presentation: 'real', audio: 'real' });
    eq(modes, { video: 'mock', presentation: 'real', audio: 'real' }, 'modos');
    const items = F.estimateItemsForRun(V3_ITEMS, modes);
    assert(!items.some((x) => x.itemType === 'video') && items.some((x) => x.itemType === 'presentation'), 'video excluido, Gamma incluido');
    eq(F.paidRealProviders(items, modes), ['gamma', 'openai'], 'proveedores reales');
    eq(F.runSpendModes('real', null), { video: 'real', presentation: 'real', audio: 'real' }, 'sin providerModes → real');
    eq(F.paidRealProviders(F.estimateItemsForRun(V3_ITEMS, F.runSpendModes('mock', { presentation: 'mock', audio: 'mock' })), F.runSpendModes('mock', { presentation: 'mock', audio: 'mock' })), [], 'todo mock');
  });

  await check('puro: decisión — mock/solo-LLM sin política → AUTO; pagado real → ADMIN_APPROVAL aunque la política lo permita; BLOCK por política; LLM sobre maxCostPerRun → ADMIN_APPROVAL (nunca BLOCK)', () => {
    const estMock = estimate(F.estimateItemsForRun(V3_ITEMS, 'mock'));
    const estReal = estimate(F.estimateItemsForRun(V3_ITEMS, 'real'));
    eq(F.decideRunBudget({ estimate: estMock, policy: null, paidRealProviders: [] }).decision, 'AUTO_WITHIN_POLICY', 'mock sin política');
    const lax = { limits: { maxCostPerRun: '1000' }, requireHumanApprovalForRealSpend: false, onExceed: 'BLOCK' };
    const r1 = F.decideRunBudget({ estimate: estReal, policy: lax, paidRealProviders: ['videogen'] });
    eq(r1.decision, 'ADMIN_APPROVAL', 'pagado real con política laxa');
    assert(r1.reasons.some((r) => r.startsWith('paid_real_provider_requires_admin_approval')), 'razón');
    eq(F.decideRunBudget({ estimate: estReal, policy: null, paidRealProviders: ['videogen'] }).decision, 'ADMIN_APPROVAL', 'sin política');
    const tight = { limits: { maxCostPerRun: '0.000001' }, onExceed: 'BLOCK' };
    eq(F.decideRunBudget({ estimate: estReal, policy: tight, paidRealProviders: ['videogen'] }).decision, 'BLOCK', 'pagado real sobre el límite → BLOCK');
    const llm = F.decideRunBudget({ estimate: estMock, policy: tight, paidRealProviders: [] });
    eq(llm.decision, 'ADMIN_APPROVAL', 'solo LLM sobre maxCostPerRun');
    assert(llm.reasons.includes('llm_only_block_downgraded_to_admin_approval'), 'razón LLM');
    eq(F.decideRunBudget({ estimate: estMock, policy: lax, paidRealProviders: [] }).decision, 'AUTO_WITHIN_POLICY', 'LLM dentro de la política');
    assert(F.approvalCovers('1000', estReal) && !F.approvalCovers('0.0001', estReal), 'approvalCovers');
  });

  await check('puro: REUSE → incremental 0 (evitado = estimado vigente sin historia; historical actual con historia); GENERATE → incremental = wouldCost', () => {
    const est = estimate(F.estimateItemsForRun(V3_ITEMS, 'real', { 'content:ch1': 'REUSE', 'video:ch1': 'REUSE', 'exam:m1': 'REGENERATE' }));
    eq([est.totals.byItemType.content, est.totals.byItemType.video].map((x) => x.expected), [F.normalizeDecimal(0), F.normalizeDecimal(0)], 'estimado: REUSE suma 0');
    const hist = { 'ir-video': [{ id: 'e1', event_kind: 'CHARGE', amount: '0.9700000000' }, { id: 'e2', event_kind: 'ADJUSTMENT', amount: '0.0300000000' }] };
    const r = F.incrementalCostForPlan([
      { itemKey: 'content:ch1', action: 'REUSE', fromItemRunId: 'ir-content' },
      { itemKey: 'video:ch1', action: 'REUSE', fromItemRunId: 'ir-video' },
      { itemKey: 'exam:m1', action: 'REGENERATE' },
    ], est.lines, hist);
    const by = Object.fromEntries(r.actions.map((a) => [a.itemKey, a]));
    eq(by['content:ch1'].incremental.expected, F.normalizeDecimal(0), 'REUSE content incremental');
    eq(by['video:ch1'].incremental.expected, F.normalizeDecimal(0), 'REUSE video incremental');
    eq([by['video:ch1'].basis, by['video:ch1'].avoided], ['historical_actual', F.normalizeDecimal('1')], 'evitado histórico (CHARGE + ADJUSTMENT)');
    eq(by['content:ch1'].basis, 'current_estimate', 'sin historia → estimado vigente');
    assert(dec(by['exam:m1'].incremental.expected) > 0, 'REGENERATE cuesta');
    eq(r.totals.incremental.expected, by['exam:m1'].incremental.expected, 'total incremental = solo el REGENERATE');
  });

  await check('puro: reenvío de Videogen = retry pagado (provider_retry, attempt = reenvíos + 1); mensaje budget_exceeded; cuota de YouTube configurable (default 1600, sin verificar)', () => {
    eq(H.videogenCallRoleOf({}), { callRole: 'main', attempt: 1 }, 'primer job');
    eq(H.videogenCallRoleOf({ previousExternals: [{}, {}] }), { callRole: 'provider_retry', attempt: 3 }, 'dos reenvíos');
    const m = H.budgetExceededMessage({ reason: 'budget_exceeded', committed: '2', authorizedBudget: '1' });
    assert(m.startsWith('budget_exceeded:') && /sin gasto/.test(m), 'prefijo estable');
    eq(H.youtubeInsertQuotaUnits({}), 1600, 'default');
    eq(H.youtubeInsertQuotaUnits({ YOUTUBE_QUOTA_VIDEOS_INSERT_UNITS: '100' }), 100, 'override');
    let threw = false;
    try { H.youtubeInsertQuotaUnits({ YOUTUBE_QUOTA_VIDEOS_INSERT_UNITS: 'x' }); } catch { threw = true; }
    assert(threw, 'valor inválido → error');
  });

  await check('puro: ingest HTTP real (Nest + FinopsIngestTokenGuard): env ausente → 503; token malo → 401; body del proxy → 200 (subject del JWT, nunca montos); campo de cliente → 400', async () => {
    const { NestFactory } = require('@nestjs/core');
    const { Module, Logger } = require('@nestjs/common');
    Logger.overrideLogger(false);
    const { FinopsIngestController } = loadDist('modules/finops/finops.controller.js');
    const calls = [];
    const fakeLedger = {
      async recordCharge(input) {
        calls.push(input);
        return { inserted: true, event: { id: 'ev-1', idempotency_key: 'anthropic:msg:' + input.externalOperationId, item_run_id: null, amount: '0.0100000000', currency: 'USD' } };
      },
    };
    class IngestTestModule {}
    Module({ controllers: [FinopsIngestController], providers: [{ provide: F.FinopsLedgerService, useValue: fakeLedger }, F.FinopsIngestTokenGuard] })(IngestTestModule);
    const app = await NestFactory.create(IngestTestModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1/finops/ingest/llm-usage`;
    const saved = process.env.FINOPS_INGEST_TOKEN;
    const post = (token, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-cursia-finops-token': token } : {}) }, body: JSON.stringify(body) });
    // Forma EXACTA que postea functions/api/proxy.js (frontend).
    const proxyBody = {
      subject: '11111111-2222-4333-8444-555555555555', itemRunId: '00000000-0000-4000-8000-00000000abcd', callRole: 'main', attempt: 1,
      model: 'claude-sonnet-4-6', messageId: 'msg_http_1', requestId: 'req_1',
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, billingAccount: 'user_key',
    };
    try {
      delete process.env.FINOPS_INGEST_TOKEN;
      eq((await post('x', proxyBody)).status, 503, 'env ausente');
      process.env.FINOPS_INGEST_TOKEN = 'secreto-correcto';
      eq((await post('secreto-malo', proxyBody)).status, 401, 'token malo');
      eq((await post(null, proxyBody)).status, 401, 'sin token');
      const ok = await post('secreto-correcto', proxyBody);
      eq(ok.status, 200, 'token correcto');
      eq(calls.length, 1, 'un recordCharge');
      eq([calls[0].ownerIdFromAuth, calls[0].itemRunId, calls[0].billingAccount, calls[0].recordedBy], [proxyBody.subject, proxyBody.itemRunId, 'user_key', 'llm-proxy'], 'traducción');
      eq((await post('secreto-correcto', { ...proxyBody, amount: 999 })).status, 400, 'monto del cliente');
      eq((await post('secreto-correcto', { ...proxyBody, courseId: 7 })).status, 400, 'atribución del cliente');
      eq(calls.length, 1, 'rechazos sin cargo');
    } finally {
      if (saved === undefined) delete process.env.FINOPS_INGEST_TOKEN; else process.env.FINOPS_INGEST_TOKEN = saved;
      await app.close();
    }
  });

  await check('puro: duración de video (R11a) — mvhd v0/v1 (caja largesize, free antes de moov), truncado/sin mvhd → null; ISO 8601; prioridad Videogen > mvhd > YouTube > unknown; VideogenService pasa duration_seconds', () => {
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
    const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
    const box = (type, payload) => Buffer.concat([u32(8 + payload.length), Buffer.from(type, 'latin1'), payload]);
    const bigBox = (type, payload) => Buffer.concat([u32(1), Buffer.from(type, 'latin1'), u64(16 + payload.length), payload]);
    const mvhd0 = (ts, dur) => box('mvhd', Buffer.concat([Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(ts), u32(dur), Buffer.alloc(80)]));
    const mvhd1 = (ts, dur) => box('mvhd', Buffer.concat([Buffer.from([1, 0, 0, 0]), u64(0), u64(0), u32(ts), u64(dur), Buffer.alloc(80)]));
    const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isommp41', 'latin1'));
    const mp4v0 = Buffer.concat([ftyp, box('moov', Buffer.concat([mvhd0(1000, 468000), box('trak', Buffer.alloc(16))])), box('mdat', Buffer.alloc(32))]);
    eq(VD.parseMp4DurationSec(new Uint8Array(mp4v0)), 468, 'v0');
    const mp4v1 = Buffer.concat([ftyp, box('free', Buffer.alloc(10)), bigBox('moov', mvhd1(90000, 468 * 90000 + 30000))]);
    eq(VD.parseMp4DurationSec(new Uint8Array(mp4v1)), 468, 'v1 + largesize + free (redondeo)');
    eq(VD.parseMp4DurationSec(new Uint8Array(Buffer.concat([ftyp, box('mdat', Buffer.alloc(8))]))), null, 'sin moov');
    eq(VD.parseMp4DurationSec(new Uint8Array(Buffer.concat([ftyp, box('moov', box('trak', Buffer.alloc(4)))]))), null, 'sin mvhd');
    eq(VD.parseMp4DurationSec(new Uint8Array(mp4v0.subarray(0, mp4v0.length - 60))), null, 'truncado');
    eq(VD.parseMp4DurationSec(new Uint8Array(Buffer.concat([ftyp, box('moov', mvhd0(0, 5))]))), null, 'timescale 0');
    eq([VD.parseIso8601DurationSec('PT7M48S'), VD.parseIso8601DurationSec('PT1H'), VD.parseIso8601DurationSec('P0DT0H0M5S'), VD.parseIso8601DurationSec('PT'), VD.parseIso8601DurationSec('7:48')],
      [468, 3600, 5, null, null], 'ISO 8601');
    eq(VD.resolveVideoDuration({ videogenStatus: { duration_seconds: 468.4 }, mp4Bytes: new Uint8Array(mp4v1), youtubeContentDetailsDuration: 'PT1M' }), { durationSec: 468, durationSource: 'videogen_status' }, 'prioridad 1');
    eq(VD.resolveVideoDuration({ videogenStatus: { status: 'completed' }, mp4Bytes: new Uint8Array(mp4v0), youtubeContentDetailsDuration: 'PT1M' }), { durationSec: 468, durationSource: 'mp4_mvhd' }, 'prioridad 2');
    eq(VD.resolveVideoDuration({ videogenStatus: {}, youtubeContentDetailsDuration: 'PT7M48S' }), { durationSec: 468, durationSource: 'youtube_content_details' }, 'prioridad 3');
    eq(VD.resolveVideoDuration({ videogenStatus: { duration: 0 } }), { durationSec: null, durationSource: 'unknown' }, 'ninguna');
    eq(VD.MOCK_VIDEO_DURATION_SEC, 468, 'fixture IdwOipZAeqY');
    const { VideogenService } = loadDist('video-engine/videogen.service.js');
    const svc = new VideogenService();
    eq(svc.parseJobs([{ job_id: 'j', status: 'completed', duration_seconds: 468 }, { job_id: 'k', status: 'completed' }]).map((j) => j.duration_seconds), [468, null], 'parseJobs');
  });

  // Copia EXACTA de PRICED_MODELS de functions/api/proxy.js (frontend). Si cambia allá, cambia acá.
  const PROXY_PRICED_MODELS = [
    'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8', 'claude-opus-5',
    'claude-sonnet-4-20250514', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5',
  ];
  await check('puro (fix C1): el seed precia EXACTAMENTE la allowlist del proxy (incl. Haiku 4.5 y Sonnet 4 fechados del selector); un id desconocido → PRICING_MISSING', () => {
    const seedModels = [...new Set(catalog.filter((r) => r.provider === 'anthropic').map((r) => r.product_or_model))].sort();
    eq(seedModels, [...PROXY_PRICED_MODELS].sort(), 'seed anthropic == allowlist del proxy');
    const usage = { input_tokens: 1000, output_tokens: 1000, cache_write_tokens: 100, cache_read_tokens: 100 };
    for (const model of PROXY_PRICED_MODELS) {
      const r = F.priceUsage(usage, catalog, { provider: 'anthropic', service: 'messages', product: model });
      assert(dec(r.amount) > 0, `${model} sin precio`);
    }
    const haiku = F.priceUsage({ input_tokens: 1e6, output_tokens: 1e6 }, catalog, { provider: 'anthropic', service: 'messages', product: 'claude-haiku-4-5-20251001' });
    const sonnet4 = F.priceUsage({ input_tokens: 1e6, output_tokens: 1e6 }, catalog, { provider: 'anthropic', service: 'messages', product: 'claude-sonnet-4-20250514' });
    eq([dec(haiku.amount), dec(sonnet4.amount)], [6, 18], 'precios públicos (1/5 y 3/15 por 1M)');
    assert(catalog.filter((r) => ['claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514'].includes(r.product_or_model)).every((r) => r.verified === false), 'marcados verified:false');
    let code = null;
    try { F.priceUsage(usage, catalog, { provider: 'anthropic', service: 'messages', product: 'claude-unknown-9' }); } catch (e) { code = e.code; }
    eq(code, 'PRICING_MISSING', 'id desconocido');
  });

  await check('puro (fix I3): duración de Videogen solo con unidad explícita y en 5..7200 s — segundos OK, ms convertidos, `duration` sin unidad / fuera de rango / basura → null', () => {
    eq(VD.durationFromVideogenStatus({ duration_seconds: 468 }), 468, 'segundos');
    eq(VD.durationFromVideogenStatus({ duration_sec: '468.4' }), 468, 'segundos (string)');
    eq(VD.durationFromVideogenStatus({ duration_ms: 468000 }), 468, 'ms → s');
    eq(VD.durationFromVideogenStatus({ durationMs: 468000 }), 468, 'ms camelCase');
    eq(VD.durationFromVideogenStatus({ duration: 468000 }), null, '`duration` sin unidad');
    eq(VD.durationFromVideogenStatus({ duration: 468 }), null, '`duration` sin unidad (aunque parezca s)');
    eq(VD.durationFromVideogenStatus({ duration_seconds: 468000 }), null, 'segundos fuera de rango (eran ms)');
    eq(VD.durationFromVideogenStatus({ duration_seconds: 3 }), null, '< 5 s');
    eq(VD.durationFromVideogenStatus({ duration_seconds: 'abc' }), null, 'basura');
    eq(VD.durationFromVideogenStatus({ duration_ms: 468 }), null, 'ms fuera de rango (0.5 s)');
    eq(VD.resolveVideoDuration({ videogenStatus: { duration: 468000 } }), { durationSec: null, durationSource: 'unknown' }, 'resolve → unknown');
    eq(VD.parseIso8601DurationSec('PT10H'), null, 'ISO fuera de rango');
    const { VideogenService } = loadDist('video-engine/videogen.service.js');
    const svc = new VideogenService();
    eq(svc.parseJobs([{ job_id: 'a', duration: 468 }, { job_id: 'b', duration_ms: 468000 }, { job_id: 'c', duration_seconds: 468 }]).map((j) => j.duration_seconds), [null, 468, 468], 'parseJobs');
  });

  await check('puro: cableado — deploy/PM2 del worker de proveedores, migración FinOps en deploy-staging y run-e2e.sh, CI corre este check', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    eq(pkg.scripts['start:dynamic-provider-worker'], 'node dist/workers/dynamic-provider-worker.js', 'npm script');
    const yml = fs.readFileSync(path.join(REPO, '.github/workflows/deploy-staging.yml'), 'utf8');
    assert(yml.includes('ensure_pm2_process cursia-dynamic-provider-worker-staging start:dynamic-provider-worker'), 'staging PM2');
    assert(fs.readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8').includes('ensure_pm2_process cursia-dynamic-provider-worker start:dynamic-provider-worker'), 'prod PM2');
    const iMig = yml.indexOf('MIGRATION_ENV=staging node scripts/migrate-v21-finops.js');
    const iVer = yml.indexOf('MIGRATION_ENV=staging node scripts/verify-v21-finops-schema.js');
    assert(iMig > 0 && iVer > iMig, 'deploy-staging: migrate + verify FinOps');
    assert(iMig < yml.indexOf('ensure_pm2_process cursia-dynamic-item-worker-staging'), 'la migración corre antes de recargar los workers');
    assert(yml.includes('node scripts/check-v21-finops-wiring.js --pure-only'), 'CI');
    const iRls = yml.indexOf('MIGRATION_ENV=staging node scripts/migrate-v21-finops-rls.js');
    const iRlsV = yml.indexOf('MIGRATION_ENV=staging node scripts/verify-v21-finops-rls.js');
    assert(iRls > iVer && iRlsV > iRls, 'deploy-staging: RLS después del ledger (fix C2)');
    const setup = fs.readFileSync(path.join(REPO, 'test/e2e-v2/setup-schema.js'), 'utf8');
    assert(setup.indexOf('supabase-migration-v21-finops-rls.sql') > setup.indexOf("'supabase-migration-v21-finops.sql'"), 'E2E setup-schema aplica la RLS');
    const sh = fs.readFileSync(path.join(REPO, 'test/e2e-v2/run-e2e.sh'), 'utf8');
    assert(sh.indexOf('migrate-v21-finops.js') > sh.indexOf('migrate-v21-manifest-v3.js'), 'run-e2e.sh siembra precios');
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Parte DB: Postgres 16 desechable
// ════════════════════════════════════════════════════════════════════════════
function findPgBin() {
  const cands = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean);
  for (const d of cands) {
    const pg = path.join(d, 'postgres');
    if (!fs.existsSync(pg)) continue;
    const v = spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '';
    if (/\b16\./.test(v)) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => (port === 5570 ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const ATTACKER = '99999999-8888-4777-8666-555555555555';
const CONTEXT = { nombre: 'Curso RF-b', sector: 'Salud', pais: 'Chile', contexto: 'x', nivel: 'Básico', tono: 'Formal' };
// Run MOCK completo: video mock + providerModes mock (R5: el default de Gamma/TTS es real).
const MOCK_CTX = { ...CONTEXT, videoMode: 'mock', providerModes: { presentation: 'mock', audio: 'mock' } };
const ENV_KEYS = [
  'DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'VIDEOGEN_API_KEY', 'ALLOW_UNOWNED_COURSES', 'FINOPS_INGEST_TOKEN',
  'DYNAMIC_PROVIDER_WORKER_ENABLED', 'DYNAMIC_ALLOW_PROVIDER_MOCK',
];

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { NestFactory } = require('@nestjs/core');
  const { Module, Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
  const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
  const { FinopsIngestController, FinopsAdminController } = loadDist('modules/finops/finops.controller.js');
  const itemWorker = loadDist('workers/dynamic-item-worker.js');
  const providerWorker = loadDist('workers/dynamic-provider-worker.js');

  const pgBin = findPgBin();
  const port = await freePort();
  assert(port !== 5570, 'puerto 5570 prohibido');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-rfb-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-rfb-cwd-'));
  const ROLE = 'postgres.rfblocaltest01';
  const DB = 'rfbdb';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let ds = null;
  let app = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`\nPostgres ${pgBin} en 127.0.0.1:${port} (data ${dataDir})`);

    const withClient = async (db, fn) => {
      const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db });
      await c.connect();
      try { return await fn(c); } finally { await c.end(); }
    };
    await withClient('postgres', async (c) => {
      await c.query(`create database ${DB}`);
      await c.query(`create role "${ROLE}" superuser login`);
    });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    // Esquema real de staging: baseline legacy + Fases 1..5 + v2 + invalidación + R3 + R4 + FinOps.
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
        'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    for (const s of ['scripts/migrate-production-jobs-constraints.js']) {
      const res = runScript(s, localEnv({}));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out}`);
    }
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js',
      'scripts/migrate-v21-finops.js', 'scripts/verify-v21-finops-schema.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }

    await check('DB RLS (fix C2): con roles anon/authenticated y el GRANT ALL por defecto de Supabase, la migración (2×, idempotente) habilita RLS y revoca todo; `SET ROLE authenticated`/`anon` no puede SELECT/INSERT en las 6 tablas FinOps ni course_profiles; el backend (dueño) sí; verify verde', async () => {
      const TABLES = ['pricing_catalog', 'generation_cost_events', 'cost_estimates', 'cost_budget_policies', 'cost_budget_authorizations', 'cost_avoidance_events', 'course_profiles'];
      await withClient(DB, async (c) => {
        // Roles de cliente de Supabase (el baseline legacy puede haberlos creado ya: el cluster es compartido por la DB).
        for (const r of ['anon', 'authenticated']) {
          await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
        }
        // Default de Supabase: ALL sobre las tablas de public para los roles cliente.
        await c.query(`grant usage on schema public to anon, authenticated; grant all on all tables in schema public to anon, authenticated`);
      });
      const pre = runScript('scripts/verify-v21-finops-rls.js', localEnv({ MIGRATION_ENV: 'staging' }));
      assert(pre.code !== 0 && /sin ROW LEVEL SECURITY/.test(pre.out), `verify antes de migrar debería fallar:\n${pre.out}`);
      const g = runScript('scripts/migrate-v21-finops-rls.js', localEnv({}));
      assert(g.code !== 0 && /MIGRATION_ENV no es "staging"/.test(g.out), 'guard MIGRATION_ENV');
      const gp = runScript('scripts/migrate-v21-finops-rls.js', localEnv({ MIGRATION_ENV: 'staging', DB_USER: 'postgres.hriwbakbuypaiovvvkqh' }));
      assert(gp.code !== 0 && /PRODUCCIÓN/.test(gp.out), 'guard producción');
      for (let i = 0; i < 2; i++) {
        const res = runScript('scripts/migrate-v21-finops-rls.js', localEnv({ MIGRATION_ENV: 'staging' }));
        assert(res.code === 0, `rls corrida ${i + 1}: ${res.out}`);
      }
      const v = runScript('scripts/verify-v21-finops-rls.js', localEnv({ MIGRATION_ENV: 'staging' }));
      assert(v.code === 0 && /RLS V2.1 FinOps verificado/.test(v.out), `verify: ${v.out}`);
      await withClient(DB, async (c) => {
        for (const t of TABLES) {
          const rel = (await c.query(`select relrowsecurity from pg_class where relname = $1 and relnamespace = 'public'::regnamespace`, [t])).rows[0];
          assert(rel && rel.relrowsecurity === true, `${t} sin RLS`);
          for (const role of ['authenticated', 'anon']) {
            for (const sql of [`select * from public.${t} limit 1`, `insert into public.${t} default values`]) {
              await c.query('begin');
              let code = null;
              try { await c.query(`set local role ${role}`); await c.query(sql); } catch (e) { code = e.code; }
              await c.query('rollback');
              eq(code, '42501', `${role}: ${sql}`);
            }
          }
          await c.query(`select * from public.${t} limit 1`); // backend (dueño): OK
        }
        // Aun con un GRANT accidental, RLS sin policies no deja ver filas.
        await c.query('begin');
        await c.query(`grant select on public.pricing_catalog to authenticated`);
        await c.query(`set local role authenticated`);
        const n = (await c.query(`select count(*)::int n from public.pricing_catalog`)).rows[0].n;
        await c.query('rollback');
        eq(n, 0, 'RLS sin policies → 0 filas visibles');
      });
    });

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    // V2.1 F2: un run v3 con videos exige entrega YouTube al crearse (409 v3_requires_youtube_delivery);
    // los checks de ledger del worker de Videogen de este archivo prueban la rama videogen_direct, así que
    // startRunT reescribe la entrega congelada DESPUÉS de crear el run (fixture; ver startRunT).
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    // V2.1 F2: preflight de proveedores reales (Gamma/TTS/LLM) — claves y themeIds FALSOS, 0 red.
    require('./lib/provider-test-env').applyFakeProviderEnv();
    process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT = 'true';
    process.env.VIDEOGEN_API_KEY = 'fake-key-never-used-no-network';
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true'; // R5: sin él, runs v3 con Gamma/TTS → 501
    process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = 'true';     // R5: providerModes mock (escape de no-producción)

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [], synchronize: false });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const ytOk = { async check() { return { ok: true }; } };
    const runs = new RunsService(ds, manifests, {}, ytOk, budget);
    /** startRun + (fixture F2) entrega congelada → videogen_direct para los checks de ledger del worker de Videogen. */
    const startRunT = async (...a) => {
      const res = await runs.startRun(...a);
      if (res && res.run && res.run.id) {
        await ds.query(`update public.production_jobs set input_payload = input_payload || '{"videoDelivery":"videogen_direct"}'::jsonb where id = $1`, [res.run.id]);
      }
      return res;
    };
    const sched = new SchedulerService(ds, runs);
    const admin = new FinopsAdminController(ledger, budget);
    const ADMIN_USER = { id: 'admin-1', email: 'admin@cursia.test' };

    /** Curso dinámico con Blueprint v2 (2 capítulos: el 1º con video y actividad) y Manifest v3. */
    async function makeCourse(title) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID();
      const c1 = crypto.randomUUID();
      const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'C1', objective: null, video_enabled: true, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'C2', objective: null, video_enabled: true, activity_enabled: false }],
      );
      for (const m of s2.modules) {
        await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
        for (const c of m.chapters) {
          await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled)
                          values ($1, $2, $3, $4, $5, $6, $7)`, [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
        }
      }
      await ds.query(
        `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, 2, $2::jsonb, $3, 0, 1, 2)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      const res = await manifests.getOrCreate(cid, OWNER, 1);
      eq(res.manifest.rulesVersion, 3, 'Manifest v3');
      return { cid, c1, c2, m1, manifest: res.manifest };
    }
    const itemRow = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const events = (where, p) => ds.query(`select *, amount::text as amount from public.generation_cost_events where ${where} order by created_at, id`, p);
    const { mergeOutputSummary } = loadDist('modules/dynamic-generation/scheduler.service.js');
    /** recordItemExternal de un scheduler falso que SÍ persiste (mismo merge que el real). */
    const patchSummary = async (id, patch) => {
      const [r] = await ds.query(`select output_summary from public.generation_item_runs where id = $1`, [id]);
      const m = mergeOutputSummary(r.output_summary || {}, patch);
      if (!m.ok) return false;
      await ds.query(`update public.generation_item_runs set output_summary = $2::jsonb where id = $1`, [id, JSON.stringify(m.merged)]);
      return true;
    };

    // ── Ingest HTTP con el ledger real ──────────────────────────────────
    class IngestDbModule {}
    Module({ controllers: [FinopsIngestController], providers: [{ provide: F.FinopsLedgerService, useValue: ledger }, F.FinopsIngestTokenGuard] })(IngestDbModule);
    app = await NestFactory.create(IngestDbModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    const ingestUrl = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1/finops/ingest/llm-usage`;
    process.env.FINOPS_INGEST_TOKEN = 'tok-rfb';
    const ingest = async (body) => {
      const res = await fetch(ingestUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cursia-finops-token': 'tok-rfb' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const llmBody = (over) => ({
      subject: OWNER, callRole: 'main', attempt: 1, model: 'claude-sonnet-4-6', messageId: 'msg_x', requestId: 'req_x',
      usage: { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, billingAccount: 'cursia', ...over,
    });

    // ════ A: run MOCK → AUTO, sin aprobación ════════════════════════════
    const A = await makeCourse('Curso mock');
    let runA = null;
    await check('DB gate: run MOCK → AUTO_WITHIN_POLICY sin aprobación; estimado (sin items de worker) guardado con run_id + autorización AUTO vinculada', async () => {
      const res = await startRunT(A.cid, OWNER, 1, MOCK_CTX);
      eq(res.created, true, 'creado');
      runA = res.run.id;
      const auths = await ds.query(`select decision, authorized_budget::text as b, estimate_id from public.cost_budget_authorizations where run_id = $1`, [runA]);
      eq(auths.map((x) => x.decision), ['AUTO_WITHIN_POLICY'], 'autorización AUTO');
      const [est] = await ds.query(`select * from public.cost_estimates where run_id = $1 and scope = 'run'`, [runA]);
      assert(est && est.id === auths[0].estimate_id, 'estimado del run vinculado');
      const types = new Set(est.lines.map((l) => l.itemType));
      for (const t of ['video', 'presentation', 'audio_welcome', 'audiobook_chapter']) assert(!types.has(t), `mock no estima ${t}`);
      assert(types.has('content') && dec(est.totals.expected) > 0, 'LLM estimado');
      eq(dec(auths[0].b), dec(est.totals.max), 'authorized = max del estimado');
    });

    await check('DB gate (merge R5): video MOCK pero Gamma/TTS en su default REAL → 409 budget_approval_required (el modo de video no decide el gasto de proveedores)', async () => {
      const P = await makeCourse('Curso providers reales');
      const err = await rejectsRe(startRunT(P.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' }), /budget_approval_required/, 'providers reales', 409);
      eq(err.getResponse().paidRealProviders, ['gamma', 'openai'], 'proveedores');
    });

    // ════ B: run REAL → 409 hasta aprobación ═════════════════════════════
    const Bc = await makeCourse('Curso real');
    let runB = null;
    let rejectedEstimateId = null;
    await check('DB gate: run REAL sin aprobación → 409 budget_approval_required con estimateId + totales; nada creado; estimado guardado sin run', async () => {
      const err = await rejectsRe(startRunT(Bc.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' }), /budget_approval_required/, 'real sin aprobación', 409);
      const body = err.getResponse();
      rejectedEstimateId = body.estimateId;
      assert(/estimateId=[0-9a-f-]{36}/.test(body.message) && /totalsJson=/.test(body.message), 'el mensaje (aplanado por el filtro global) lleva estimateId y totales');
      eq(body.paidRealProviders, ['gamma', 'openai', 'videogen'], 'proveedores');
      assert(dec(body.estimate.expected) > 0 && dec(body.estimate.max) >= dec(body.estimate.expected), 'totales');
      eq((await ds.query(`select count(*)::int n from public.production_jobs where course_id = $1`, [Bc.cid]))[0].n, 0, 'sin run');
      const [est] = await ds.query(`select run_id, scope, manifest_id from public.cost_estimates where id = $1`, [rejectedEstimateId]);
      eq([est.run_id, est.scope, est.manifest_id], [null, 'run', Bc.manifest.id], 'estimado guardado');
    });

    await check('DB gate: aprobación de admin (POST /finops/courses/:id/authorizations) → startRun continúa; la aprobación queda vinculada al run y consumida', async () => {
      await rejectsRe(admin.authorize(A.cid, { estimateId: rejectedEstimateId, authorizedBudget: '100' }, ADMIN_USER), /no es del curso/, 'estimado de otro curso', 400);
      await rejectsRe(admin.authorize(Bc.cid, { estimateId: rejectedEstimateId, authorizedBudget: '100', amount: 1 }, ADMIN_USER), /campo no permitido/, 'campo extra', 400);
      const a = await admin.authorize(Bc.cid, { estimateId: rejectedEstimateId, authorizedBudget: '100', reason: 'test' }, ADMIN_USER);
      eq([a.decision, a.approvedBy, a.runId, dec(a.authorizedBudget)], ['ADMIN_APPROVED', 'admin@cursia.test', null, 100], 'fila de aprobación');
      const res = await startRunT(Bc.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' });
      eq(res.created, true, 'run real creado');
      runB = res.run.id;
      const bound = await ds.query(`select decision, estimate_id, approved_by, reason, authorized_budget::text as b from public.cost_budget_authorizations where run_id = $1`, [runB]);
      eq(bound.map((x) => [x.decision, x.estimate_id, x.approved_by, dec(x.b)]), [['ADMIN_APPROVED', rejectedEstimateId, 'admin@cursia.test', 100]], 'vinculada');
      eq(await budget.findUnconsumedApproval(Bc.cid, Bc.manifest.id, '0'), null, 'consumida');
    });

    // ════ Workers: Videogen (fake) ════════════════════════════════════════
    const workerLog = { log() {}, warn() {}, error(m) { workerLog.errors.push(m); }, errors: [] };
    function fakeScheduler() {
      const st = { failed: [], completed: [], blocked: [], externals: [] };
      return {
        st,
        async heartbeatItem() { return true; },
        async recordItemExternal(_id, _e, patch) { st.externals.push(patch); return true; },
        async failItem(id, _e, msg, retryable) { st.failed.push({ id, msg, retryable }); return true; },
        async completeItem(id, _e, payload) { st.completed.push({ id, payload }); return true; },
        async blockItemForBudget(id, _e, msg) { st.blocked.push({ id, msg }); return true; },
      };
    }
    function fakeVideogen(cost) {
      const st = { submits: 0 };
      return {
        st,
        async batchCreate() { st.submits++; return { batch_id: 'b_' + st.submits, jobs: [{ job_id: `vg_job_${st.submits}_${crypto.randomUUID().slice(0, 8)}` }] }; },
        async getVideoStatus(id) { return { job_id: id, status: 'completed', download_url: 'https://fake-videogen.invalid/x.mp4', progress: 100, error: null }; },
        async getVideoCost() { if (cost instanceof Error) throw cost; return { estimated_total_cost: cost }; },
      };
    }
    const claimedVideo = async (runId, chapterId, over) => {
      const row = await itemRow(runId, `video:${chapterId}`);
      return {
        itemRunId: row.id, runId, itemKey: row.item_key, type: 'video', idempotencyKey: row.idempotency_key, attempt: 1,
        chapterId, chapterNumber: 1, manifestId: row.manifest_id, artifactCourseId: String(row.course_id), generation: 1,
        blueprint: { course: { id: row.course_id, title: 'Curso' }, chapter: { title: 'C1' } },
        dependencyArtifacts: [{ type: 'dynamic_content_md', artifactId: 'content-art' }], outputSummary: {}, ...over,
      };
    };
    const workerDeps = (scheduler, videogen) => ({
      scheduler, dataSource: ds, videogen, logger: workerLog, executorId: 'w-rfb', leaseSeconds: 60, heartbeatMs: 600000,
      videoTimeoutMin: 1, videoPollMs: 5, mockScenario: 'success', mockResolvePolls: 1,
      artifacts: { async getDownloadUrl() { return { url: 'data:text/plain,Contenido%20del%20capitulo' }; }, async uploadJsonArtifact() { return { id: 'art-video' }; } },
      finops: ledger, budget,
    });

    let videoEvent = null;
    await check('DB worker Videogen (fake, presupuesto autorizado) → continúa: 1 envío y CHARGE CALCULATED_FROM_USAGE con el costo de Videogen, atribuido server-side (curso/run/item/capítulo)', async () => {
      const s = fakeScheduler();
      const vg = fakeVideogen(0.97);
      await itemWorker.processItem(workerDeps(s, vg), await claimedVideo(runB, Bc.c1));
      eq([vg.st.submits, s.st.completed.length, s.st.blocked.length, s.st.failed.length], [1, 1, 0, 0], `envío/complete (${JSON.stringify(s.st.failed)})`);
      const row = await itemRow(runB, `video:${Bc.c1}`);
      const evs = await events(`item_run_id = $1`, [row.id]);
      eq(evs.length, 1, 'un evento');
      videoEvent = evs[0];
      eq([videoEvent.cost_source, videoEvent.operation, videoEvent.provider, videoEvent.billing_account, videoEvent.billable, videoEvent.measurement_status],
        ['CALCULATED_FROM_USAGE', 'videogen.render', 'videogen', 'cursia', true, 'final'], 'evento');
      assert(near(videoEvent.amount, 0.97), `monto ${videoEvent.amount}`);
      eq([videoEvent.course_id, videoEvent.run_id, videoEvent.item_key, videoEvent.chapter_id, videoEvent.owner_id], [Bc.cid, runB, `video:${Bc.c1}`, Bc.c1, OWNER], 'atribución');
      eq(videoEvent.metadata.amountBasis, 'provider_calculated', 'base del monto');
      eq(s.st.completed[0].payload.summary.external, { durationSec: null, durationSource: 'unknown' }, 'Videogen real sin duración → null + unknown');
      assert(videoEvent.idempotency_key.startsWith('videogen:job:vg_job_1_'), 'clave por job');
    });

    await check('DB idempotencia: el mismo job de Videogen registrado dos veces (poll repetido / re-claim) → 1 solo CHARGE', async () => {
      const again = await H.recordVideogenCharge(ledger, { ownerId: OWNER, itemRunId: videoEvent.item_run_id, jobId: videoEvent.external_operation_id, mode: 'real', cost: 0.97 });
      eq(again.inserted, false, 'no insertó');
      eq((await events(`external_operation_id = $1`, [videoEvent.external_operation_id])).length, 1, 'una fila');
    });

    await check('DB retry: reenvío con job NUEVO → 2 CHARGE (el 2º provider_retry/attempt 2) y aparece en retriesPaid', async () => {
      const r2 = await H.recordVideogenCharge(ledger, {
        ownerId: OWNER, itemRunId: videoEvent.item_run_id, jobId: 'vg_job_resubmit_1', mode: 'real', cost: 0.95,
        outputSummary: { previousExternals: [{ external: { videogenJobId: videoEvent.external_operation_id } }] },
      });
      eq([r2.inserted, r2.event.call_role, r2.event.attempt], [true, 'provider_retry', 2], 'retry');
      eq((await events(`item_run_id = $1 and event_kind = 'CHARGE'`, [videoEvent.item_run_id])).length, 2, 'dos cargos');
      const byRun = await ledger.costsByRun(runB);
      eq(byRun.retriesPaid.events, 1, 'retriesPaid');
      assert(near(byRun.retriesPaid.total, 0.95), 'monto del retry');
    });

    await check('DB pendiente: costo de Videogen no disponible → CHARGE pendiente con precio de catálogo; la medición llega → ADJUSTMENT (append); repetir = no-op', async () => {
      const r = await H.recordVideogenCharge(ledger, { ownerId: OWNER, itemRunId: videoEvent.item_run_id, jobId: 'vg_job_pending_1', mode: 'real', cost: null, costError: 'HTTP 503' });
      eq([r.event.measurement_status, r.event.cost_source, r.event.metadata.costBasis], ['pending', 'CALCULATED_FROM_USAGE', 'pricing_catalog_provisional'], 'pendiente');
      assert(near(r.event.amount, 0.94), `provisional = catálogo (${r.event.amount})`);
      const adj = await H.settleVideogenPending(ledger, 'vg_job_pending_1', 1.1);
      eq(adj.inserted, true, 'ajuste');
      assert(near(adj.delta, 0.16), `delta ${adj.delta}`);
      eq((await H.settleVideogenPending(ledger, 'vg_job_pending_1', 1.1)).inserted, false, 'no-op');
      const [orig] = await events(`idempotency_key = 'videogen:job:vg_job_pending_1'`, []);
      assert(near(orig.amount, 0.94) && orig.measurement_status === 'pending', 'el original no se editó');
    });

    await check('DB worker Videogen: costo no disponible al terminar → CHARGE pendiente desde el worker (el item completa igual)', async () => {
      const s = fakeScheduler();
      const vg = fakeVideogen(new Error('costs endpoint 503'));
      await itemWorker.processItem(workerDeps(s, vg), await claimedVideo(runB, Bc.c2));
      eq([vg.st.submits, s.st.completed.length], [1, 1], 'completó');
      const row = await itemRow(runB, `video:${Bc.c2}`);
      const [ev] = await events(`item_run_id = $1`, [row.id]);
      eq([ev.measurement_status, ev.metadata.pendingReason], ['pending', 'costs endpoint 503'], 'pendiente');
    });

    await check('DB mock: render de Videogen en run mock → MOCK a 0, no facturable', async () => {
      const row = await itemRow(runA, `video:${A.c1}`);
      const r = await H.recordVideogenCharge(ledger, { ownerId: OWNER, itemRunId: row.id, jobId: `mock_${row.idempotency_key}`, mode: 'mock', cost: null });
      eq([r.event.cost_source, r.event.amount, r.event.billing_account, r.event.billable], ['MOCK', F.normalizeDecimal(0), 'mock', false], 'mock');
    });

    await check('DB YouTube: subida → ZERO_BY_DESIGN + 1600 unidades de cuota, idempotente por videoId; package → ZERO_BY_DESIGN atribuido al run, idempotente por job', async () => {
      const row = await itemRow(runB, `video:${Bc.c1}`);
      const y1 = await H.recordYoutubeUpload(ledger, { ownerId: OWNER, itemRunId: row.id, videoId: 'yt_abc123XYZ', mode: 'real' });
      const y2 = await H.recordYoutubeUpload(ledger, { ownerId: OWNER, itemRunId: row.id, videoId: 'yt_abc123XYZ', mode: 'real' });
      eq([y1.inserted, y2.inserted, y1.event.cost_source, y1.event.amount, dec(y1.event.quota_units), y1.event.operation],
        [true, false, 'ZERO_BY_DESIGN', F.normalizeDecimal(0), 1600, 'youtube.upload'], 'youtube');
      const pkgJob = crypto.randomUUID();
      const p1 = await H.recordPackageBuild(ledger, { ownerId: OWNER, packageJobId: pkgJob, runId: runB });
      const p2 = await H.recordPackageBuild(ledger, { ownerId: OWNER, packageJobId: pkgJob, runId: runB });
      eq([p1.inserted, p2.inserted, p1.event.cost_source, p1.event.operation, p1.event.course_id, p1.event.run_id, p1.event.item_run_id],
        [true, false, 'ZERO_BY_DESIGN', 'package.build', Bc.cid, runB, null], 'package');
      const px = await H.recordPackageBuild(ledger, { ownerId: ATTACKER, packageJobId: crypto.randomUUID(), runId: runB });
      eq([px.event.course_id, px.event.run_id, px.event.metadata.attributionRejectReason], [null, null, 'owner_mismatch'], 'run ajeno no se atribuye');
    });

    await check('DB presupuesto excedido → item `blocked` con budget_exceeded ANTES del envío (0 envíos, 0 cargos nuevos)', async () => {
      // Nuevo presupuesto TOTAL del run (append) por debajo de lo ya gastado.
      const [runEst] = await ds.query(`select id from public.cost_estimates where run_id = $1 and scope = 'run'`, [runB]);
      const a = await admin.authorize(Bc.cid, { estimateId: runEst.id, authorizedBudget: '0.5' }, ADMIN_USER);
      eq(a.runId, runB, 'autorización del run');
      const before = (await events(`run_id = $1`, [runB])).length;
      const s = fakeScheduler();
      const vg = fakeVideogen(0.97);
      const item = await claimedVideo(runB, Bc.c1, { itemKey: `video:${Bc.c1}`, outputSummary: {} });
      await itemWorker.processItem(workerDeps(s, vg), item);
      eq([vg.st.submits, s.st.blocked.length, s.st.completed.length], [0, 1, 0], 'bloqueado sin enviar');
      assert(s.st.blocked[0].msg.startsWith('budget_exceeded:'), s.st.blocked[0].msg);
      assert(!s.st.externals.some((p) => p.externalSubmitStartedAt), 'sin marcador de envío');
      eq((await events(`run_id = $1`, [runB])).length, before, 'sin cargos nuevos');
    });

    await check('DB scheduler real: blockItemForBudget → item blocked + dependientes blocked; retryItem lo reanuda tras ampliar la autorización', async () => {
      await ds.query(`update public.generation_item_runs set status = 'completed' where job_id = $1 and type in ('course_plan','course_intro','content')`, [runB]);
      const claimed = await sched.claimNextItem({ executorId: 'w-real', types: ['video'], leaseSeconds: 60 });
      assert(claimed && claimed.runId === runB, 'reclamó un video del run real');
      eq(await sched.blockItemForBudget(claimed.itemRunId, 'w-real', 'budget_exceeded: prueba'), true, 'bloqueó');
      const row = await itemRow(runB, claimed.itemKey);
      assert(row.status === 'blocked' && row.error.startsWith('budget_exceeded') && row.worker_id === null, `fila ${row.status} ${row.error}`);
      const dependents = await ds.query(`select item_key, status from public.generation_item_runs where job_id = $1 and $2 = any(depends_on)`, [runB, claimed.itemKey]);
      assert(dependents.length > 0 && dependents.every((d) => d.status === 'blocked'), `dependientes ${JSON.stringify(dependents)}`);
      const [runEst] = await ds.query(`select id from public.cost_estimates where run_id = $1 and scope = 'run'`, [runB]);
      await admin.authorize(Bc.cid, { estimateId: runEst.id, authorizedBudget: '200' }, ADMIN_USER);
      const retried = await runs.retryItem(Bc.cid, OWNER, 1, runB, claimed.itemKey);
      eq(retried.status, 'pending', 'reanudado');
      const after = await ds.query(`select status from public.generation_item_runs where job_id = $1 and $2 = any(depends_on)`, [runB, claimed.itemKey]);
      assert(after.every((d) => d.status === 'pending'), 'dependientes desbloqueados');
      const g = await budget.guardPaidSubmission({ runId: runB, itemRunId: row.id, itemType: 'video' });
      eq([g.allow, g.decision], [true, 'ALLOW'], 'guard con el presupuesto ampliado');
    });

    await check('DB worker de proveedores: mock → evento MOCK a 0; real sin presupuesto → blocked budget_exceeded antes de la llamada (nunca PROVIDER_NOT_WIRED sin guard)', async () => {
      const pA = await itemRow(runA, `presentation:${A.c1}`);
      const s = fakeScheduler();
      const deps = { scheduler: s, dataSource: ds, logger: workerLog, executorId: 'p-rfb', leaseSeconds: 60, finops: ledger, budget,
        artifacts: { async uploadJsonArtifact() { return { id: 'art-pres' }; } } };
      const item = { itemRunId: pA.id, runId: runA, itemKey: pA.item_key, type: 'presentation', idempotencyKey: pA.idempotency_key, chapterId: A.c1, chapterNumber: 1, manifestId: pA.manifest_id, artifactCourseId: String(A.cid), attempt: 1 };
      await providerWorker.processProviderItem(deps, item);
      await providerWorker.processProviderItem(deps, item);
      const evs = await events(`item_run_id = $1`, [pA.id]);
      eq(evs.map((e) => [e.cost_source, e.amount, e.provider]), [['MOCK', F.normalizeDecimal(0), 'gamma']], 'un evento MOCK (idempotente)');
      // Real: el run B tiene 200 autorizado; un run real SIN autorización (curso C, fila de run inyectada) bloquea.
      const pB = await itemRow(runB, `presentation:${Bc.c1}`);
      const [runEst] = await ds.query(`select id from public.cost_estimates where run_id = $1 and scope = 'run'`, [runB]);
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, estimate_id, authorized_budget, decision, reason)
                      values ($1, $2, $3, 0, 'BLOCKED', 'test: presupuesto revocado')`, [runB, Bc.cid, runEst.id]);
      const s2 = fakeScheduler();
      await providerWorker.processProviderItem({ ...deps, scheduler: s2 }, { ...item, itemRunId: pB.id, runId: runB, itemKey: pB.item_key, chapterId: Bc.c1 });
      eq([s2.st.blocked.length, s2.st.failed.length], [1, 0], 'bloqueado, no fallado');
      assert(/budget_exceeded: no_authorization/.test(s2.st.blocked[0].msg), s2.st.blocked[0].msg);
    });

    // ════ LLM ingest: atribución, idempotencia, precios ═══════════════════
    await check('DB ingest: itemRunId de OTRO owner en la metadata del cliente → NO se atribuye a la víctima (queda llm.unattributed del autenticado)', async () => {
      const victimItem = await itemRow(runB, `content:${Bc.c1}`);
      const r = await ingest(llmBody({ subject: ATTACKER, itemRunId: victimItem.id, messageId: 'msg_attack_1' }));
      eq([r.status, r.body.attributed], [200, false], 'ingest');
      const [ev] = await events(`idempotency_key = 'anthropic:msg:msg_attack_1'`, []);
      eq([ev.owner_id, ev.course_id, ev.run_id, ev.item_run_id, ev.operation, ev.metadata.attributionRejectReason],
        [ATTACKER, null, null, null, 'llm.unattributed', 'owner_mismatch'], 'no atribuido');
      const victim = await ledger.costsByCourse(Bc.cid);
      assert(!victim.byItemType.some((g) => g.key === 'content'), 'no aparece en el curso de la víctima');
      const own = await ingest(llmBody({ itemRunId: victimItem.id, messageId: 'msg_own_1' }));
      eq([own.status, own.body.attributed], [200, true], 'el dueño sí se atribuye');
      const dup = await ingest(llmBody({ itemRunId: victimItem.id, messageId: 'msg_own_1' }));
      eq([dup.status, dup.body.inserted], [200, false], 'misma respuesta dos veces → 1 fila');
      const noItem = await ingest(llmBody({ messageId: 'msg_noitem_1' }));
      eq([noItem.status, noItem.body.attributed], [200, false], 'sin itemRunId se acepta');
    });

    await check('DB precios: un precio nuevo NO cambia el monto histórico; el cargo nuevo usa el precio nuevo', async () => {
      const [before] = await events(`idempotency_key = 'anthropic:msg:msg_own_1'`, []);
      for (const [meter, price] of [['input_tokens', '30'], ['output_tokens', '150']]) {
        await ds.query(
          `insert into public.pricing_catalog (provider, service, product_or_model, meter, unit_size, unit_price, currency, pricing_version, effective_from, source, verified)
           values ('anthropic', 'messages', 'claude-sonnet-4-6', $1, 1000000, $2, 'USD', 'anthropic-rfb-test', now() - interval '1 second', 'contract', false)`,
          [meter, price]);
      }
      const r = await ingest(llmBody({ messageId: 'msg_after_price' }));
      eq(r.status, 200, 'ingest');
      const [after] = await events(`idempotency_key = 'anthropic:msg:msg_own_1'`, []);
      eq(after.amount, before.amount, 'histórico intacto');
      eq(after.pricing_snapshot, before.pricing_snapshot, 'snapshot intacto');
      const [nw] = await events(`idempotency_key = 'anthropic:msg:msg_after_price'`, []);
      eq(dec(nw.amount), (1000 * 30 + 2000 * 150) / 1e6, 'nuevo precio');
      assert(nw.pricing_snapshot.pricing_versions.includes('anthropic-rfb-test'), 'snapshot con la versión nueva');
    });

    await check('DB ingest (fix C1/I2): ids fechados del selector (Haiku 4.5 / Sonnet 4) → 200 con precio; id sin precio → 202, CHARGE a 0 pendiente (pricingMissing), nunca perdido; al cargar el precio → ADJUSTMENT y el pendiente se limpia', async () => {
      const h = await ingest(llmBody({ model: 'claude-haiku-4-5-20251001', messageId: 'msg_haiku_dated', usage: { input_tokens: 1000000, output_tokens: 1000000 } }));
      const s4 = await ingest(llmBody({ model: 'claude-sonnet-4-20250514', messageId: 'msg_sonnet4_dated', usage: { input_tokens: 1000000, output_tokens: 1000000 } }));
      eq([h.status, dec(h.body.amount), s4.status, dec(s4.body.amount)], [200, 6, 200, 18], 'fechados con precio');
      const victimItem = await itemRow(runB, `content:${Bc.c1}`);
      const u = await ingest(llmBody({ model: 'claude-new-model-x', itemRunId: victimItem.id, messageId: 'msg_unpriced_1', usage: { input_tokens: 1000000, output_tokens: 2000000 } }));
      eq([u.status, u.body.inserted, u.body.pricingMissing, u.body.measurementStatus, u.body.amount, u.body.attributed], [202, true, true, 'pending', F.normalizeDecimal(0), true], 'registrado pendiente');
      const [ev] = await events(`idempotency_key = 'anthropic:msg:msg_unpriced_1'`, []);
      eq([ev.metadata.pricingMissing, ev.metadata.pricingError.code, ev.pricing_snapshot], [true, 'PRICING_MISSING', null], 'metadata');
      const dup = await ingest(llmBody({ model: 'claude-new-model-x', itemRunId: victimItem.id, messageId: 'msg_unpriced_1', usage: { input_tokens: 1000000, output_tokens: 2000000 } }));
      eq([dup.status, dup.body.inserted, dup.body.pricingMissing], [202, false, true], 'reenvío idempotente (sigue pendiente)');
      const before = await ledger.costsByRun(runB);
      assert(before.totals.pending_events >= 1, 'aparece en pendientes');
      await ds.query(
        `insert into public.pricing_catalog (provider, service, product_or_model, meter, unit_size, unit_price, currency, pricing_version, effective_from, source, verified)
         values ('anthropic','messages','claude-new-model-x','input_tokens',1000000,2,'USD','anthropic-newx','2026-01-01T00:00:00Z','contract',false),
                ('anthropic','messages','claude-new-model-x','output_tokens',1000000,10,'USD','anthropic-newx','2026-01-01T00:00:00Z','contract',false)`);
      const adj = await ledger.repricePendingCharge('anthropic:msg:msg_unpriced_1');
      eq([adj.inserted, dec(adj.delta)], [true, 22], 'ADJUSTMENT = precio real');
      eq((await ledger.repricePendingCharge('anthropic:msg:msg_unpriced_1')).inserted, false, 'repetir = no-op');
      const after = await ledger.costsByRun(runB);
      eq(after.totals.pending_events, before.totals.pending_events - 1, 'el pendiente corregido ya no cuenta (fix M5)');
    });

    // ════ Consultas ══════════════════════════════════════════════════════
    await check('DB consultas: estimado vs actual por run; costsByCourse con byChapter/byItemType/byProvider/retriesPaid/avoided/estimatedVsActual; rollup por owner', async () => {
      const byRun = await ledger.costsByRun(runB);
      const eva = byRun.estimatedVsActual;
      assert(eva && eva.estimate_id && dec(eva.est_expected) > 0, `estimado del run: ${JSON.stringify(eva)}`);
      const actual = dec(eva.actual);
      assert(actual > 0 && Math.abs(actual - dec(byRun.totals.total)) < 1e-9, 'actual = ledger del run');
      assert(actual !== dec(eva.est_expected), 'diferencia estimado vs actual visible');
      const c = await ledger.costsByCourse(Bc.cid);
      for (const k of ['byChapter', 'byItemType', 'byProvider', 'retriesPaid', 'avoided', 'estimatedVsActual']) assert(k in c, `falta ${k}`);
      assert(c.byChapter.some((g) => g.key === Bc.c1), 'byChapter');
      assert(c.byProvider.some((g) => g.key === 'videogen'), 'byProvider');
      const o = await admin.ownerCosts(OWNER);
      assert(o.ownerId === OWNER && o.byCourse.length >= 1, 'rollup por owner');
    });

    await check('DB regeneración dryRun: incremental {min,esperado,max} y evitado por item afectado (video STALE_NO_AUTO = costo real histórico); sin escribir estimados', async () => {
      await ds.query(`update public.generation_item_runs set status = 'completed' where job_id = $1 and item_key in ($2, $3)`, [runA, `content:${A.c1}`, `video:${A.c1}`]);
      const nEst = (await ds.query(`select count(*)::int n from public.cost_estimates`))[0].n;
      const dry = await runs.regenerateItem(A.cid, OWNER, 1, runA, `content:${A.c1}`, { dryRun: true });
      assert(dry.dryRun && dry.cost, 'dryRun con costo');
      const by = Object.fromEntries(dry.cost.byItem.map((x) => [x.itemKey, x]));
      const content = by[`content:${A.c1}`];
      assert(content && content.action === 'REGENERATE' && dec(content.incrementalCost.min) > 0 &&
        dec(content.incrementalCost.min) <= dec(content.incrementalCost.expected) && dec(content.incrementalCost.expected) <= dec(content.incrementalCost.max), `content ${JSON.stringify(content)}`);
      const video = by[`video:${A.c1}`];
      eq([video.action, video.avoidedBasis, video.avoided, video.incrementalCost.expected], ['STALE_NO_AUTO', 'historical_actual', F.normalizeDecimal(0), F.normalizeDecimal(0)], 'video (mock: histórico 0)');
      assert(near(dry.cost.incrementalCost.expected, dry.cost.byItem.reduce((s, x) => s + dec(x.incrementalCost.expected), 0)), 'total = suma por item');
      eq((await ds.query(`select count(*)::int n from public.cost_estimates`))[0].n, nEst, 'dryRun no escribe');
    });

    await check('DB regeneración real (apply): video real sin presupuesto del run → 409 budget_approval_required con estimado (scope regeneration, run_id); tras autorizarlo → se regenera', async () => {
      const key = `video:${Bc.c2}`;
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and item_key = $2`, [runB, key]);
      // La última autorización del run es BLOCKED (test anterior) → presupuesto null.
      const err = await rejectsRe(runs.regenerateItem(Bc.cid, OWNER, 1, runB, key, { confirmPaid: true }), /budget_approval_required/, 'sin presupuesto', 409);
      const estimateId = err.getResponse().estimateId;
      const [est] = await ds.query(`select scope, run_id from public.cost_estimates where id = $1`, [estimateId]);
      eq([est.scope, est.run_id], ['regeneration', runB], 'estimado de la regeneración');
      eq((await itemRow(runB, key)).generation, 1, 'no se creó la generación 2');
      await admin.authorize(Bc.cid, { estimateId, authorizedBudget: '300' }, ADMIN_USER);
      const res = await runs.regenerateItem(Bc.cid, OWNER, 1, runB, key, { confirmPaid: true });
      eq([res.created, res.costKind, res.item.generation], [true, 'videogen', 2], 'regenerado');
    });

    await check('DB duración (R11a): run MOCK videogen_direct → Videogen mock devuelve 468 y se persiste en output_summary.external + payload/metadata del artifact dynamic_video', async () => {
      const s = fakeScheduler();
      const uploads = [];
      const deps = workerDeps(s, fakeVideogen(0));
      deps.artifacts = { ...deps.artifacts, async uploadJsonArtifact(i) { uploads.push(i); return { id: 'art-video-mock' }; } };
      // En mock el worker usa su Videogen interno (mockPollVideoStatus lee/escribe output_summary por el scheduler).
      const row = await itemRow(runA, `video:${A.c2}`);
      s.recordItemExternal = async (id, _e, patch) => { await patchSummary(id, patch); return true; };
      await itemWorker.processItem(deps, await claimedVideo(runA, A.c2));
      eq([s.st.completed.length, s.st.failed.length], [1, 0], `completó (${JSON.stringify(s.st.failed)})`);
      eq(s.st.completed[0].payload.summary.external, { durationSec: 468, durationSource: 'videogen_status' }, 'external');
      eq([uploads[0].payload.durationSec, uploads[0].metadata.durationSec, uploads[0].metadata.durationSource], [468, 468, 'videogen_status'], 'artifact');
      const [ev] = await events(`item_run_id = $1`, [row.id]);
      eq([ev.cost_source, ev.amount], ['MOCK', F.normalizeDecimal(0)], 'ledger MOCK');
    });

    await check('DB duración (R11a): run MOCK con entrega YouTube → la duración queda en external al terminar el render y viaja al artifact final (publicador mock, sin red)', async () => {
      await ds.query(`update public.production_jobs set input_payload = input_payload || '{"videoDelivery":"youtube"}'::jsonb where id = $1`, [runA]);
      try {
        const s = fakeScheduler();
        const uploads = [];
        s.recordItemExternal = async (id, _e, patch) => patchSummary(id, patch);
        const deps = workerDeps(s, fakeVideogen(0));
        deps.artifacts = { ...deps.artifacts, async uploadJsonArtifact(i) { uploads.push(i); return { id: 'art-video-yt' }; } };
        const row = await itemRow(runA, `video:${A.c1}`);
        await itemWorker.processItem(deps, await claimedVideo(runA, A.c1));
        eq([s.st.completed.length, s.st.failed.length], [1, 0], `completó (${JSON.stringify(s.st.failed)})`);
        const [db] = await ds.query(`select output_summary from public.generation_item_runs where id = $1`, [row.id]);
        eq([db.output_summary.external.durationSec, db.output_summary.external.durationSource, !!db.output_summary.external.youtubeVideoId], [468, 'videogen_status', true], 'external en la DB');
        eq([uploads[0].payload.durationSec, uploads[0].metadata.durationSec, uploads[0].payload.delivery], [468, 468, 'youtube'], 'artifact final');
        const yt = await events(`item_run_id = $1 and provider = 'youtube'`, [row.id]);
        eq(yt.map((e) => [e.cost_source, dec(e.quota_units)]), [['MOCK', 1600]], 'cuota de YouTube (mock)');
      } finally {
        await ds.query(`update public.production_jobs set input_payload = input_payload || '{"videoDelivery":"videogen_direct"}'::jsonb where id = $1`, [runA]);
      }
    });

    // ════ I1: AUTO_WITHIN_POLICY nunca cubre proveedores pagados reales ═════
    const E = await makeCourse('Curso I1');
    let runE = null;
    await check('DB I1 setup: run real E con aprobación ADMIN justa, gasto que la agota y una autorización AUTO_WITHIN_POLICY enorme posterior', async () => {
      const err = await rejectsRe(startRunT(E.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' }), /budget_approval_required/, 'pide aprobación', 409);
      const b = err.getResponse();
      await admin.authorize(E.cid, { estimateId: b.estimateId, authorizedBudget: b.estimate.expected }, ADMIN_USER);
      runE = (await startRunT(E.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      const it = await itemRow(runE, `content:${E.c1}`);
      const r = await ingest(llmBody({ itemRunId: it.id, messageId: 'msg_e_big', usage: { input_tokens: 1000000, output_tokens: 5000000 } }));
      eq(r.status, 200, 'gasto LLM');
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, authorized_budget, decision, reason)
                      values ($1, $2, 99999, 'AUTO_WITHIN_POLICY', 'test I1: AUTO enorme')`, [runE, E.cid]);
      eq(await budget.runAuthorizedBudget(runE), F.normalizeDecimal(99999), 'la AUTO es la última autorización');
      eq(dec(await budget.runPaidAuthorizedBudget(runE)), dec(b.estimate.expected), 'para proveedores pagados solo cuenta la ADMIN');
    });

    await check('DB I1 workers: el guard de Videogen y el de proveedores bloquean (budget_exceeded) aunque haya AUTO de sobra', async () => {
      const s = fakeScheduler();
      const vg = fakeVideogen(0.97);
      await itemWorker.processItem(workerDeps(s, vg), await claimedVideo(runE, E.c1));
      eq([vg.st.submits, s.st.blocked.length], [0, 1], 'Videogen bloqueado');
      const p = await itemRow(runE, `presentation:${E.c1}`);
      const s2 = fakeScheduler();
      await providerWorker.processProviderItem({ scheduler: s2, dataSource: ds, logger: workerLog, executorId: 'p-e', leaseSeconds: 60, finops: ledger, budget,
        artifacts: { async uploadJsonArtifact() { return { id: 'x' }; } } },
      { itemRunId: p.id, runId: runE, itemKey: p.item_key, type: 'presentation', idempotencyKey: p.idempotency_key, chapterId: E.c1, chapterNumber: 1, manifestId: p.manifest_id, artifactCourseId: String(E.cid), attempt: 1 });
      eq(s2.st.blocked.length, 1, 'proveedor bloqueado');
      assert(/budget_exceeded/.test(s2.st.blocked[0].msg), s2.st.blocked[0].msg);
    });

    await check('DB M3 (fix round 2): worker de Videogen / proveedores en run REAL SIN guard de presupuesto → item bloqueado (budget_exceeded: finops_unavailable), 0 envíos (fail closed)', async () => {
      const s = fakeScheduler();
      const vg = fakeVideogen(0.97);
      const deps = { ...workerDeps(s, vg) };
      delete deps.budget;
      await itemWorker.processItem(deps, await claimedVideo(runE, E.c2));
      eq([vg.st.submits, s.st.blocked.length, s.st.completed.length], [0, 1, 0], 'Videogen sin guard');
      assert(/^budget_exceeded: finops_unavailable: /.test(s.st.blocked[0].msg), s.st.blocked[0].msg);
      const p = await itemRow(runE, `presentation:${E.c2}`);
      const s2 = fakeScheduler();
      await providerWorker.processProviderItem({ scheduler: s2, dataSource: ds, logger: workerLog, executorId: 'p-m3', leaseSeconds: 60, finops: ledger,
        artifacts: { async uploadJsonArtifact() { throw new Error('no debería subir'); } } },
      { itemRunId: p.id, runId: runE, itemKey: p.item_key, type: 'presentation', idempotencyKey: p.idempotency_key, chapterId: E.c2, chapterNumber: 2, manifestId: p.manifest_id, artifactCourseId: String(E.cid), attempt: 1 });
      eq([s2.st.blocked.length, s2.st.failed.length], [1, 0], 'proveedor sin guard');
      assert(/finops_unavailable/.test(s2.st.blocked[0].msg), s2.st.blocked[0].msg);
    });

    await check('DB I1 regenerate: video real con solo AUTO de sobra → 409 budget_approval_required (sin generación nueva)', async () => {
      const key = `video:${E.c1}`;
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and item_key = $2`, [runE, key]);
      await rejectsRe(runs.regenerateItem(E.cid, OWNER, 1, runE, key, { confirmPaid: true }), /budget_approval_required/, 'regenerate', 409);
      eq((await itemRow(runE, key)).generation, 1, 'sin generación 2');
    });

    await check('DB I1 retry: video fallido sin job y resubmitVideo → 409 budget_approval_required con estimado (scope regeneration) y el item sigue failed', async () => {
      const key = `video:${E.c2}`;
      await ds.query(`update public.generation_item_runs set status = 'failed', error = 'video_timeout' where job_id = $1 and item_key = $2`, [runE, key]);
      const err = await rejectsRe(runs.retryItem(E.cid, OWNER, 1, runE, key), /budget_approval_required/, 'retry', 409);
      const [est] = await ds.query(`select scope, run_id from public.cost_estimates where id = $1`, [err.getResponse().estimateId]);
      eq([est.scope, est.run_id], ['regeneration', runE], 'estimado');
      await ds.query(`update public.generation_item_runs set error = 'videogen_failed: x',
                        output_summary = output_summary || '{"external":{"videogenJobId":"vg_old","mode":"real"}}'::jsonb
                      where job_id = $1 and item_key = $2`, [runE, key]);
      await rejectsRe(runs.retryItem(E.cid, OWNER, 1, runE, key, true), /budget_approval_required/, 'resubmitVideo', 409);
      eq((await itemRow(runE, key)).status, 'failed', 'sigue failed');
    });

    await check('DB I1 reopen: run real cancelado con videos/proveedores por enviar → 409; con aprobación ADMIN del run (POST authorizations {runId}) → se reabre', async () => {
      await runs.cancelRun(E.cid, OWNER, 1, runE);
      await rejectsRe(startRunT(E.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' }), /budget_approval_required/, 'reopen', 409);
      await rejectsRe(admin.authorize(E.cid, { runId: runE, estimateId: crypto.randomUUID(), authorizedBudget: '1' }, ADMIN_USER), /exactamente uno/, 'runId y estimateId', 400);
      const a = await admin.authorize(E.cid, { runId: runE, authorizedBudget: '100000' }, ADMIN_USER);
      eq([a.runId, a.decision, a.estimateId], [runE, 'ADMIN_APPROVED', null], 'aprobación del run');
      const res = await startRunT(E.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' });
      eq([res.reopened, res.run.id], [true, runE], 'reabierto');
    });

    await check('DB gate BLOCK: política del curso con maxCostPerRun mínimo y on_exceed BLOCK → 409 budget_blocked para un run real (sin salida por aprobación)', async () => {
      const Cc = await makeCourse('Curso bloqueado');
      await ds.query(`insert into public.cost_budget_policies (scope, scope_id, version, limits, on_exceed) values ('course', $1, 1, $2::jsonb, 'BLOCK')`,
        [String(Cc.cid), JSON.stringify({ maxCostPerRun: '0.0001' })]);
      await rejectsRe(startRunT(Cc.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' }), /budget_blocked/, 'bloqueado', 409);
      // Mock con la misma política: el LLM sobre el límite pide aprobación (nunca BLOCK).
      await rejectsRe(startRunT(Cc.cid, OWNER, 1, MOCK_CTX), /budget_approval_required/, 'LLM sobre el límite', 409);
    });
  } finally {
    if (app) await app.close().catch(() => {});
    if (ds && ds.isInitialized) await ds.destroy().catch(() => {});
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    console.log('PG16 descartable destruido');
  }
}

(async () => {
  await pureChecks();
  if (PURE_ONLY) {
    console.log('ℹ️  --pure-only: parte DB (PG16 desechable) NO ejecutada');
  } else {
    try {
      await dbChecks();
    } catch (err) {
      failures++;
      console.error(`❌ setup de la parte DB falló: ${err && err.stack ? err.stack : err}`);
    }
  }
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures > 0 ? 1 : 0);
})();
