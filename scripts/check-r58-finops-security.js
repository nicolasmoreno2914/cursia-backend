#!/usr/bin/env node
/* eslint-disable */
// r58 (AU3 FinOps/seguridad, fase A, USD 0) — huecos de gasto y de seguridad cerrados de forma genérica. Sin red (fetch
// prohibido salvo los fakes de este archivo), sin proveedores, PG16 desechable con las migraciones del repo.
//
//   [VE] POST /video-engine: rol (SuperAdmin / VIDEO_ENGINE_ALLOWED_OWNERS) + VIDEO_ENGINE_ENABLED para renders reales +
//        kill switch; dry-run abierto; 0 llamadas a Videogen cuando se niega
//   [LJ] LEGACY_PAID_JOBS_ENABLED=false: /jobs/{gamma,audio,videos,full} + requeue/retry → 503 sin crear nada; los 4
//        workers v1 pagados no reclaman; default = sin cambio
//   [SC] kill switch / allow-list de proveedores (puro) y en las llamadas DIRECTAS (/tts/speech, extracción de marca,
//        «Datos del curso», lectura avanzada): 0 llamadas al proveedor
//   [PJ] PATCH /jobs/:id y /steps: un run V2 → 403 server_owned_job (no cambia nada); v1 sin cambio
//   [YT] /youtube/upload-from-url: solo hosts propios (Storage / Videogen / lista), https, IPs públicas, redirecciones
//        validadas, errores genéricos
//   [AD] SuperAdmin por email exige email confirmado (auth.users / claim), anclaje opcional por id
//   [OM] ownerMonthlyCap: límite mensual POR DUEÑO en la aprobación (puro + SQL)
//   [PX] (PG) proxy: parte inexistente → 409 item_run_not_found sin reservar; techo de gasto sin atribuir por dueño
//        (24 h) y global, también bajo concurrencia; sin techo configurado → igual que antes
//   [KS] (PG) kill switch / allow-list en el punto de RESERVA del ledger (proxy, worker, lote); los cargos posteriores
//        se siguen registrando
//
// Usage: npm run build && node scripts/check-r58-finops-security.js [--pure-only]
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PURE_ONLY = process.argv.includes('--pure-only');
const REPO = path.resolve(__dirname, '..');
const distRoot = path.join(REPO, 'dist');
const L = (rel) => { try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar dist/${rel} (¿npm run build?): ${err.message}`); process.exit(1); } };
require('reflect-metadata');
const realFetch = global.fetch;
let fetchHook = null; // fake por check
global.fetch = async (u, o) => {
  const s = String(u);
  if (fetchHook) { const r = await fetchHook(s, o); if (r !== undefined) return r; }
  if (s.startsWith('data:') || /^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o);
  throw new Error(`NETWORK FORBIDDEN in check: ${s}`);
};
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const { applyFakeProviderEnv } = require('./lib/provider-test-env');

let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
function codeOf(e) { if (!e) return null; if (e.code) return e.code; const r = e.getResponse && e.getResponse(); return r && typeof r === 'object' ? r.code : null; }
async function rejectsCode(p, code, m) { let e = null; try { await p; } catch (x) { e = x; } assert(e, `${m}: no lanzó`); const c = codeOf(e); assert(c === code, `${m}: código ${c} (esperado ${code}) — ${e.message}`); return e; }
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}
function fakeRes() {
  const r = { statusCode: null, body: null, headers: {} };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.set = (h) => { Object.assign(r.headers, h); return r; };
  r.headersSent = false;
  return r;
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const ADMIN = 'admin@cursia.test';
const SPEND_ENV = ['FINOPS_KILL_SWITCH', 'FINOPS_PROVIDER_ALLOWLIST', 'FINOPS_UNATTRIBUTED_DAILY_USD_PER_OWNER', 'FINOPS_UNATTRIBUTED_DAILY_USD_GLOBAL', 'LEGACY_PAID_JOBS_ENABLED',
  'VIDEO_ENGINE_ENABLED', 'VIDEO_ENGINE_ALLOWED_OWNERS', 'SUPER_ADMIN_USER_IDS', 'SUPER_ADMIN_EMAIL_VERIFICATION', 'YOUTUBE_UPLOAD_ALLOWED_HOSTS'];
for (const k of SPEND_ENV) delete process.env[k];

async function pureChecks() {
  const SC = L('modules/finops/spend-controls.js');
  const VA = L('video-engine/video-engine-access.js');
  const { VideoEngineController } = L('video-engine/video-engine.controller.js');

  await check('[SC] puro: kill switch / allow-list / techos / legacy — defaults = sin cambio; solo proveedores pagados', () => {
    eq([SC.spendBlockReason('anthropic', {}), SC.spendBlockReason('videogen', {}), SC.finopsProviderAllowlist({}), SC.legacyPaidJobsEnabled({})], [null, null, null, true], 'defaults');
    eq(SC.unattributedCeilings({}), { perOwner: null, global: null }, 'sin techo por defecto');
    for (const p of ['anthropic', 'openai', 'gamma', 'videogen']) eq(SC.spendBlockReason(p, { FINOPS_KILL_SWITCH: 'true' }).code, 'finops_kill_switch', `kill ${p}`);
    eq([SC.spendBlockReason('cursia', { FINOPS_KILL_SWITCH: 'true' }), SC.spendBlockReason('youtube', { FINOPS_KILL_SWITCH: '1' })], [null, null], 'no pagados nunca se frenan');
    const al = { FINOPS_PROVIDER_ALLOWLIST: ' Anthropic , ' };
    eq([SC.spendBlockReason('anthropic', al), SC.spendBlockReason('gamma', al).code, SC.spendBlockReason('openai', al).code], [null, 'provider_not_allowed', 'provider_not_allowed'], 'allow-list');
    eq(SC.spendBlockReason('anthropic', { FINOPS_KILL_SWITCH: 'false' }), null, 'false = apagado');
    for (const v of ['false', 'FALSE', '0', 'off', 'no']) eq(SC.legacyPaidJobsEnabled({ LEGACY_PAID_JOBS_ENABLED: v }), false, `legacy ${v}`);
    eq(SC.legacyPaidJobsEnabled({ LEGACY_PAID_JOBS_ENABLED: 'true' }), true, 'legacy true');
    eq(SC.unattributedCeilings({ FINOPS_UNATTRIBUTED_DAILY_USD_PER_OWNER: '0.25', FINOPS_UNATTRIBUTED_DAILY_USD_GLOBAL: '0.5' }), { perOwner: '0.25', global: '0.5' }, 'techos');
    let bad = null; try { SC.unattributedCeilings({ FINOPS_UNATTRIBUTED_DAILY_USD_PER_OWNER: '-1' }); } catch (e) { bad = e; }
    eq(bad && bad.code, 'INVALID_POLICY', 'techo inválido → falla cerrado (no "sin techo")');
    let thrown = null; try { SC.assertProviderSpendAllowed('gamma', { FINOPS_KILL_SWITCH: 'on' }); } catch (e) { thrown = e; }
    eq(thrown && thrown.code, 'FINOPS_KILL_SWITCH', 'FinopsError tipado');
  });

  await check('[VE] puro: matriz de acceso — dry-run abierto; rol para todo lo demás; renders reales solo con VIDEO_ENGINE_ENABLED; kill switch / allow-list', () => {
    const U = { id: OWNER, email: 'user@cursia.test' };
    const A = { id: OTHER, email: ADMIN };
    const env0 = { SUPER_ADMIN_EMAILS: ADMIN };
    const d = (action, user, env, payload = {}) => VA.decideVideoEngineAccess({ action, payload, user }, env);
    eq(d('create', U, env0, { dryRun: true }), { allow: true, dryRun: true }, 'dry-run usuario');
    eq(d('batch-create', U, env0, { dry_run: true }).allow, true, 'dry_run usuario');
    for (const a of ['create', 'batch-create', 'auth-test']) eq([d(a, U, env0).allow, d(a, U, env0).status, d(a, U, env0).code], [false, 403, 'video_engine_forbidden'], `${a} sin rol`);
    // Review r1 (I-2): status / batch-status (solo lectura) → todo usuario autenticado, sin VIDEO_ENGINE_* (v1 en prod).
    eq([d('status', U, {}, { job_id: 'vg-123' }), d('batch-status', U, {}, { batch_id: 'b_9' })], [{ allow: true, dryRun: false }, { allow: true, dryRun: false }], 'lectura sin rol');
    eq([d('status', null, {}).status, d('status', U, {}, { job_id: '../x' }).status, d('batch-status', U, {}, { batch_id: { $ne: 1 } }).status], [403, 400, 400], 'lectura: sin usuario / id inválido');
    eq([d('create', A, env0).status, d('create', A, env0).code], [503, 'video_engine_disabled'], 'admin sin VIDEO_ENGINE_ENABLED');
    eq(d('status', A, env0).allow, true, 'status admin (no gasta)');
    const on = { ...env0, VIDEO_ENGINE_ENABLED: 'true' };
    eq(d('create', A, on), { allow: true, dryRun: false }, 'admin + enabled');
    eq(d('create', U, { ...on, VIDEO_ENGINE_ALLOWED_OWNERS: OWNER }).allow, true, 'owner en la lista');
    eq(d('create', U, { ...on, VIDEO_ENGINE_ALLOWED_OWNERS: '*' }).allow, true, '* = opt-in explícito');
    eq(d('create', U, { ...on, VIDEO_ENGINE_ALLOWED_OWNERS: OTHER }).allow, false, 'otro owner');
    eq(d('create', A, { ...on, FINOPS_KILL_SWITCH: 'true' }).code, 'finops_kill_switch', 'kill switch');
    eq(d('batch-create', A, { ...on, FINOPS_PROVIDER_ALLOWLIST: 'anthropic' }).code, 'provider_not_allowed', 'allow-list');
    eq([d('', A, on).status, d('rm -rf', A, on).status, d('create', null, on).status], [400, 400, 403], 'acción vacía / desconocida / sin usuario');
  });

  await check('[VE] controlador: usuario sin rol → 403 y 0 llamadas a Videogen; admin sin VIDEO_ENGINE_ENABLED → 503 y 0; habilitado → 1 llamada; dry-run sin proveedor', async () => {
    const calls = [];
    fetchHook = async (u) => { if (u.startsWith('https://videogen.fake.test/')) { calls.push(u); return new Response(JSON.stringify({ job_id: 'j1' }), { status: 200 }); } return undefined; };
    try {
      await withEnv({ VIDEOGEN_API_KEY: 'fake-vg-key', VIDEOGEN_API_URL: 'https://videogen.fake.test', SUPER_ADMIN_EMAILS: ADMIN, VIDEO_ENGINE_ENABLED: undefined }, async () => {
        const c = new VideoEngineController();
        const r1 = fakeRes(); await c.proxyRequest({ action: 'batch-create', payload: { videos: [{}, {}] } }, r1, { id: OWNER, email: 'u@x.test' });
        eq([r1.statusCode, r1.body.code, calls.length], [403, 'video_engine_forbidden', 0], 'sin rol');
        const r2 = fakeRes(); await c.proxyRequest({ action: 'create', payload: {} }, r2, { id: OTHER, email: ADMIN });
        eq([r2.statusCode, r2.body.code, calls.length], [503, 'video_engine_disabled', 0], 'admin sin switch');
        const r3 = fakeRes(); await c.proxyRequest({ action: 'create', payload: { dryRun: true, chapter_number: 2 } }, r3, { id: OWNER, email: 'u@x.test' });
        eq([r3.statusCode, r3.body.dry_run, calls.length], [200, true, 0], 'dry-run usuario');
        process.env.VIDEO_ENGINE_ENABLED = 'true';
        const r4 = fakeRes(); await c.proxyRequest({ action: 'create', payload: {} }, r4, { id: OTHER, email: ADMIN });
        eq([r4.statusCode, calls.length, calls[0]], [200, 1, 'https://videogen.fake.test/api/external/videos/create'], 'admin habilitado');
        process.env.FINOPS_KILL_SWITCH = 'true';
        const r5 = fakeRes(); await c.proxyRequest({ action: 'create', payload: {} }, r5, { id: OTHER, email: ADMIN });
        eq([r5.statusCode, r5.body.code, calls.length], [503, 'finops_kill_switch', 1], 'kill switch');
        delete process.env.FINOPS_KILL_SWITCH;
      });
    } finally { fetchHook = null; }
  });

  await check('[LJ] LEGACY_PAID_JOBS_ENABLED=false: gamma/audio/videos/full + requeue/retry → 503 legacy_paid_jobs_disabled, 0 jobs creados; default y true → el service se llama igual que antes', async () => {
    const { ProductionJobsController } = L('modules/production-jobs/production-jobs.controller.js');
    const called = [];
    const svc = new Proxy({}, { get: (_t, k) => async (...a) => { called.push(String(k)); return { ok: true }; } });
    const c = new ProductionJobsController(svc);
    const u = { id: OWNER, email: 'u@x.test' };
    const calls = [() => c.createGammaJob({}, u), () => c.createAudioJob({}, u), () => c.createVideoJob({}, u), () => c.createFullCourseJob({}, u), () => c.requeue('j', u), () => c.retryFullCourseJob('j', u)];
    await withEnv({ LEGACY_PAID_JOBS_ENABLED: 'false' }, async () => {
      for (const f of calls) { const e = await rejectsCode(Promise.resolve().then(f), 'legacy_paid_jobs_disabled', 'apagado'); eq(e.getStatus(), 503, '503'); }
    });
    eq(called, [], 'ningún job creado / reactivado');
    for (const v of [undefined, 'true']) await withEnv({ LEGACY_PAID_JOBS_ENABLED: v }, async () => { for (const f of calls) await f(); });
    eq(called.length, 12, 'default/true: sin cambio');
    // content / h5p / package (sin proveedor pagado) nunca se cortan.
    await withEnv({ LEGACY_PAID_JOBS_ENABLED: 'false' }, async () => { await c.createContentJob({}, u); await c.createH5PJob({}, u); await c.createPackageJob({}, u); });
    eq(called.slice(12), ['createContentJob', 'createH5PJob', 'createPackageJob'], 'no pagados siguen');
  });

  await check('[LJ] workers v1 pagados: el gate se lee en CADA vuelta (vale para jobs encolados antes) y los 4 workers lo consultan ANTES de reclamar', () => {
    const { createLegacyPaidClaimGate } = L('workers/legacy-paid-job-gate.js');
    const logs = [];
    const env = {};
    const gate = createLegacyPaidClaimGate({ warn: (m) => logs.push('W:' + m), log: (m) => logs.push('L:' + m) }, 'gamma-worker', env);
    eq(gate(), true, 'default');
    env.LEGACY_PAID_JOBS_ENABLED = 'false';
    eq([gate(), gate()], [false, false], 'apagado');
    env.LEGACY_PAID_JOBS_ENABLED = 'true';
    eq(gate(), true, 'reactivado');
    eq(logs.length, 2, 'un log por cambio de estado (sin spam)');
    for (const [f, claim] of [['gamma-worker.ts', 'claimNextBackendGammaJob'], ['audio-worker.ts', 'claimNextBackendAudioJob'], ['video-worker.ts', 'claimNextBackendVideoJob'], ['full-course-worker.ts', 'claimNextFullCourseJob']]) {
      const src = fs.readFileSync(path.join(REPO, 'src/workers', f), 'utf8');
      assert(new RegExp(`legacyPaidGate\\(\\) \\? await jobsService\\.${claim}\\(`).test(src), `${f}: gate antes de ${claim}`);
      eq((src.match(new RegExp(`jobsService\\.${claim}\\(`, 'g')) || []).length, 1, `${f}: un solo claim`);
    }
  });

  await check('[SC] llamadas DIRECTAS: kill switch / allow-list ANTES de llamar — /tts/speech, extracción de marca y de «Datos del curso», lectura avanzada → 503 con código y 0 llamadas', async () => {
    const restore = applyFakeProviderEnv();
    try {
      const { TtsController } = L('tts/tts.controller.js');
      let synth = 0;
      const tts = new TtsController({ synthesize: async () => { synth++; return { audioBuffer: Buffer.alloc(10), model: 'm', voice: 'v', chars: 1 }; } }, { query: async () => [] }, undefined);
      await withEnv({ FINOPS_KILL_SWITCH: 'true' }, () => rejectsCode(tts.speech({ text: 'hola' }, fakeRes(), { id: OWNER }), 'finops_kill_switch', 'tts kill'));
      await withEnv({ FINOPS_PROVIDER_ALLOWLIST: 'anthropic' }, () => rejectsCode(tts.speech({ text: 'hola' }, fakeRes(), { id: OWNER }), 'provider_not_allowed', 'tts allow-list'));
      eq(synth, 0, 'OpenAI nunca llamado');
      const r = fakeRes(); await tts.speech({ text: 'hola', format: 'wav' }, r, { id: OWNER });
      eq([synth, r.statusCode], [1, 200], 'default: sin cambio');
      const fakeClient = () => { const f = { n: 0, messages: { create: async () => { f.n++; throw new Error('no debería llamarse'); } } }; return f; };
      const { BrandExtractionService } = L('modules/brand-profiles/brand-extraction.service.js');
      const { CourseSetupExtractionService } = L('modules/course-setup/course-setup-extraction.service.js');
      const { AnthropicTranscriber } = L('modules/academic-context/advanced-extraction.js');
      const b = new BrandExtractionService(); const bc = fakeClient(); Object.defineProperty(b, 'client', { value: bc });
      const s = new CourseSetupExtractionService(); const sc = fakeClient(); Object.defineProperty(s, 'client', { value: sc });
      const t = new AnthropicTranscriber(); const tc = fakeClient(); t.client = tc;
      await withEnv({ FINOPS_KILL_SWITCH: 'true' }, async () => {
        await rejectsCode(b.extractFromPdf(Buffer.from('%PDF'), { ownerId: OWNER }), 'finops_kill_switch', 'marca');
        await rejectsCode(s.extractFromPdf(Buffer.from('%PDF'), { ownerId: OWNER }), 'finops_kill_switch', 'datos del curso');
        await rejectsCode(t.transcribe({ name: 'a.pdf', pdf: Buffer.from('%PDF'), model: 'claude-sonnet-4-6' }), 'finops_kill_switch', 'lectura avanzada');
      });
      await withEnv({ FINOPS_PROVIDER_ALLOWLIST: 'openai' }, () => rejectsCode(b.extractFromPdf(Buffer.from('%PDF'), { ownerId: OWNER }), 'provider_not_allowed', 'marca allow-list'));
      eq([bc.n, sc.n, tc.n], [0, 0, 0], 'Anthropic nunca llamado');
    } finally { restore(); }
  });

  await check('[PJ] PATCH /jobs/:id y /steps/:k: run V2 (dynamic_generation / dynamic_package) → 403 server_owned_job sin guardar; jobs v1 → igual que antes', async () => {
    const { ProductionJobsService } = L('modules/production-jobs/production-jobs.service.js');
    const svc = Object.create(ProductionJobsService.prototype);
    const saved = [];
    let mode = 'dynamic_generation';
    svc.findOne = async (id) => ({ id, executionMode: mode, status: 'running', result: {} });
    svc.isCancelledLike = () => false;
    svc.jobRepo = { save: async (j) => { saved.push(['job', j.status]); return j; } };
    svc.stepRepo = { findOne: async () => null, create: (x) => x, save: async (x) => { saved.push(['step', x.status]); return x; } };
    for (const m of ['dynamic_generation', 'dynamic_package']) {
      mode = m;
      await rejectsCode(svc.update('j', { status: 'cancelled' }, OWNER), 'server_owned_job', `${m} status`);
      await rejectsCode(svc.update('j', { result: { x: 1 } }, OWNER), 'server_owned_job', `${m} result`);
      await rejectsCode(svc.updateStep('j', 'content', { status: 'completed' }, OWNER), 'server_owned_job', `${m} step`);
    }
    eq(saved, [], 'nada guardado');
    for (const m of ['frontend', 'backend_content', 'course_full_generation']) { mode = m; await svc.update('j', { status: 'running' }, OWNER); await svc.updateStep('j', 'content', { status: 'running' }, OWNER); }
    eq(saved.length, 6, 'v1 sin cambio');
  });

  await check('[YT] upload-from-url: solo https + host propio (Storage / Videogen / lista) + IPs públicas; redirecciones re-validadas; errores sin estado HTTP; el controlador corta ANTES de buscar la conexión', async () => {
    const P = L('youtube/upload-url-policy.js');
    const env = { SUPABASE_URL: 'https://proj.supabase.co', VIDEOGEN_API_URL: 'https://videosb.example.test', YOUTUBE_UPLOAD_ALLOWED_HOSTS: 'cdn.example.test' };
    const pub = async () => ['203.0.113.10'.replace('203.0.113', '93.184.216')];
    const ok = (u, r = pub) => P.assertUploadUrlAllowed(u, { env, resolve: r });
    for (const u of ['https://videosb.example.test/v/1.mp4', 'https://proj.supabase.co/storage/v1/object/sign/artifacts/x.mp4?token=t', 'https://cdn.example.test/a.mp4']) await ok(u);
    for (const [u, why] of [['http://videosb.example.test/v.mp4', 'http'], ['https://evil.test/v.mp4', 'otro host'], ['https://127.0.0.1/v.mp4', 'IP'], ['https://[::1]/v.mp4', 'IPv6'],
      ['https://u:p@videosb.example.test/v.mp4', 'credenciales'], ['https://videosb.example.test:8080/v.mp4', 'puerto'], ['https://localhost/x', 'localhost'], ['file:///etc/passwd', 'file'], ['nada', 'inválida']]) {
      await rejectsCode(ok(u), 'download_url_not_allowed', why);
    }
    for (const ip of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '172.20.1.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      await rejectsCode(ok('https://videosb.example.test/v.mp4', async () => ['93.184.216.34', ip]), 'download_url_not_allowed', `resuelve a ${ip}`);
    }
    eq(['8.8.8.8', '2606:4700::1111'].map(P.isNonPublicAddress), [false, false], 'públicas');
    // Redirección a un host ajeno → rechazo; a un host permitido → se sigue; estado HTTP nunca en el error.
    const fetchImpl = async (u) => {
      if (u === 'https://videosb.example.test/r-evil') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
      if (u === 'https://videosb.example.test/r-ok') return new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/final.mp4' } });
      if (u === 'https://cdn.example.test/final.mp4') return new Response('x'.repeat(2048), { status: 200 });
      return new Response('nope', { status: 418 });
    };
    await rejectsCode(P.fetchAllowedDownload('https://videosb.example.test/r-evil', { env, resolve: pub, fetchImpl }), 'download_url_not_allowed', 'redirección a metadata');
    eq((await P.fetchAllowedDownload('https://videosb.example.test/r-ok', { env, resolve: pub, fetchImpl })).status, 200, 'redirección a host permitido');
    let e418 = null; try { await P.fetchAllowedDownload('https://videosb.example.test/x', { env, resolve: pub, fetchImpl }); } catch (e) { e418 = e; }
    assert(e418 && !/418/.test(e418.message), 'sin estado HTTP en el error (sin oráculo)');
    const { YoutubeController } = L('youtube/youtube.controller.js');
    let lookups = 0;
    const yc = new YoutubeController({ getConnection: async () => { lookups++; return null; } }, {}, { uploadFromUrl: async () => { throw new Error('no'); } });
    await withEnv({ SUPABASE_URL: 'https://proj.supabase.co', VIDEOGEN_API_URL: 'https://videosb.example.test' }, () =>
      rejectsCode(yc.uploadFromUrl({ id: OWNER }, { download_url: 'http://127.0.0.1:3000/admin', dryRun: true }), 'download_url_not_allowed', 'controlador'));
    eq(lookups, 0, 'rechazo antes de cualquier otra cosa');
  });

  await check('[AD] SuperAdmin por email: email confirmado (auth.users) o, sin base, claim email_verified=true; SUPER_ADMIN_USER_IDS ancla; escape explícito; no-admins sin consultas', async () => {
    const SA = L('auth/super-admin.js');
    const env = { SUPER_ADMIN_EMAILS: ADMIN };
    const u = (raw = {}, id = OTHER, email = ADMIN) => ({ id, email, raw });
    const lk = (row) => async () => row;
    eq(await SA.adminIdentityProblem(u(), lk({ confirmed: true, email: ADMIN }), env), null, 'confirmado');
    assert(await SA.adminIdentityProblem(u(), lk({ confirmed: false, email: ADMIN }), env), 'sin confirmar → problema');
    assert(await SA.adminIdentityProblem(u(), lk({ confirmed: true, email: 'otro@x.test' }), env), 'email distinto → problema');
    eq(await SA.adminIdentityProblem(u({ user_metadata: { email_verified: true } }), null, env), null, 'sin base: claim true');
    assert(await SA.adminIdentityProblem(u({}), null, env), 'sin base y sin claim → falla cerrado');
    assert(await SA.adminIdentityProblem(u({ user_metadata: { email_verified: false } }), async () => { throw new Error('perm'); }, env), 'base caída + claim false');
    let q = 0;
    eq(await SA.adminIdentityProblem(u({}, OWNER, 'user@x.test'), async () => { q++; return null; }, env), null, 'no admin');
    eq(q, 0, 'no admin: 0 consultas');
    assert(await SA.adminIdentityProblem(u(), lk({ confirmed: true, email: ADMIN }), { ...env, SUPER_ADMIN_USER_IDS: OWNER }), 'anclaje por id');
    eq(await SA.adminIdentityProblem(u(), lk({ confirmed: true, email: ADMIN }), { ...env, SUPER_ADMIN_USER_IDS: OTHER.toUpperCase() }), null, 'id anclado');
    eq(await SA.adminIdentityProblem(u({}), null, { ...env, SUPER_ADMIN_EMAIL_VERIFICATION: 'off' }), null, 'escape explícito');
    // Guard real (HS256 de prueba): 403 admin_email_unverified antes de adjuntar el usuario; confirmado → pasa (y se cachea).
    const { SupabaseJwtGuard, resetAdminVerifiedCacheForTests } = L('auth/supabase-jwt.guard.js');
    const jwt = require('jsonwebtoken');
    const SECRET = 'test-hs256-secret-r58';
    const ctx = (token) => { const req = { headers: { authorization: 'Bearer ' + token } }; return { req, c: { switchToHttp: () => ({ getRequest: () => req }) } }; };
    await withEnv({ SUPABASE_JWT_SECRET: SECRET, SUPER_ADMIN_EMAILS: ADMIN, SUPER_ADMIN_USER_IDS: undefined, SUPER_ADMIN_EMAIL_VERIFICATION: undefined }, async () => {
      resetAdminVerifiedCacheForTests();
      let confirmed = false; let queries = 0;
      const ds = { query: async (sql, p) => { queries++; assert(/from auth\.users where id = \$1/.test(sql) && p[0] === OTHER, 'consulta'); return [{ email: ADMIN, confirmed }]; } };
      const g = new SupabaseJwtGuard(ds);
      const tok = jwt.sign({ sub: OTHER, email: ADMIN, role: 'authenticated' }, SECRET, { expiresIn: 600 });
      const a = ctx(tok);
      await rejectsCode(g.canActivate(a.c), 'admin_email_unverified', 'admin sin confirmar');
      assert(!a.req.user, 'sin usuario adjunto');
      confirmed = true;
      const b = ctx(tok); eq(await g.canActivate(b.c), true, 'confirmado'); eq(b.req.user.email, ADMIN, 'adjunto');
      const n = queries; await g.canActivate(ctx(tok).c); eq(queries, n, 'cacheado (sin query por request)');
      const user = ctx(jwt.sign({ sub: OWNER, email: 'user@x.test' }, SECRET, { expiresIn: 600 }));
      const before = queries; eq(await new SupabaseJwtGuard(ds).canActivate(user.c), true, 'usuario normal'); eq(queries, before, 'usuario normal sin consulta');
      resetAdminVerifiedCacheForTests();
      await rejectsCode(new SupabaseJwtGuard().canActivate(ctx(tok).c), 'admin_email_unverified', 'sin base ni claim');
      eq(await new SupabaseJwtGuard().canActivate(ctx(jwt.sign({ sub: OTHER, email: ADMIN, user_metadata: { email_verified: true } }, SECRET, { expiresIn: 600 })).c), true, 'sin base, claim true');
      resetAdminVerifiedCacheForTests();
    });
  });

  await check('[OM] puro: ownerMonthlyCap acota/bloquea por DUEÑO (monthlyCap sigue global); sin el dato con el límite → falla cerrado; sin el límite → igual que antes', () => {
    const NA = L('modules/finops/normal-approval.js');
    const estimate = { totals: { min: '1', expected: '2', max: '4' } };
    const pol = (limits) => ({ version: 1, limits, requireHumanApprovalForRealSpend: true, onExceed: 'BLOCK' });
    const base = NA.planNormalApproval({ estimate, policy: pol({ maxCostPerRun: 10 }), courseSpent: 0, monthSpent: 999 });
    eq([base.withinPolicy, base.amount], [true, '4.0000000000'], 'sin límite por dueño: igual');
    const capped = NA.planNormalApproval({ estimate, policy: pol({ maxCostPerRun: 10, ownerMonthlyCap: 5 }), courseSpent: 0, monthSpent: 999, ownerMonthSpent: 2 });
    eq([capped.withinPolicy, capped.amount, capped.cappedByLimit], [true, '3.0000000000', 'ownerMonthlyCap'], 'acotado al remanente del dueño');
    const blocked = NA.planNormalApproval({ estimate, policy: pol({ ownerMonthlyCap: 5 }), courseSpent: 0, monthSpent: 0, ownerMonthSpent: 3.5 });
    eq([blocked.withinPolicy, blocked.blockedBy[0].limit], [false, 'ownerMonthlyCap'], 'bloqueado nombrando el límite');
    const unknown = NA.planNormalApproval({ estimate, policy: pol({ ownerMonthlyCap: 5 }), courseSpent: 0, monthSpent: 0 });
    eq([unknown.withinPolicy, unknown.blockedBy[0].limit], [false, 'ownerMonthlyCap'], 'sin dato → falla cerrado');
  });

  await check('[RC] clasificador: los códigos nuevos de control de gasto son D retenidos (sin reintento solo, 0 gasto)', () => {
    const FC = L('modules/reliability/failure-classifier.js');
    const fn = FC.classifyItemFailure || FC.classifyFailure;
    assert(typeof fn === 'function', 'clasificador exportado');
    for (const c of ['finops_kill_switch', 'provider_not_allowed', 'unattributed_ceiling_reached', 'item_run_not_found']) {
      const r = fn({ error: `${c}: detalle`, itemType: 'content' });
      eq([r.class, r.strategy, r.ruleId || r.rule], ['D', 'hold_for_human', 'spend_control_denied'], c);
    }
  });
}

// ─── DB ─────────────────────────────────────────────────────────────────────
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
      srv.close(() => ([5570, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const CONTEXT = { nombre: 'Curso r58', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION', 'DYNAMIC_VIDEO_DELIVERY',
  'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY', 'SUPER_ADMIN_EMAILS', 'DYNAMIC_AUTO_HEAL_POLICY', ...SPEND_ENV];

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = L('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = L('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = L('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = L('modules/dynamic-generation/runs.service.js');
  const { Artifact } = L('modules/artifacts/entities/artifact.entity.js');
  const AL = L('modules/reliability/attempt-log.js');
  const EL = L('modules/reliability/execution-lease.js');
  const F = L('modules/finops/index.js');
  const { FinopsLlmReservationController } = L('modules/finops/finops.controller.js');
  const LUI = L('modules/finops/llm-usage-ingest.js');
  const WH = L('workers/finops-worker-hooks.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r58-db16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r58-cwd-'));
  const ROLE = 'postgres.r58local01';
  const DB = 'r58db';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const restoreProviders = applyFakeProviderEnv();
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create role "${ROLE}" superuser login`); });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => { const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 }); return { code: res.status, out: (res.stdout || '') + (res.stderr || '') }; };
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    { const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({})); assert(res.code === 0, `migrate-production-jobs-constraints: ${res.out}`); }
    await withClient(DB, async (c) => { for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8')); });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js', 'scripts/migrate-v21-finops.js',
      'scripts/migrate-rel-recovery.js', 'scripts/migrate-rel-exec-lease.js', 'scripts/migrate-run-pause.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }
    Object.assign(process.env, { DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_REAL_VIDEO_OWNERS: OWNER, DYNAMIC_MANIFEST_RULES_VERSION: '3', DYNAMIC_VIDEO_DELIVERY: 'youtube',
      DYNAMIC_PROVIDER_WORKER_ENABLED: 'true', VIDEOGEN_API_KEY: 'fake-videogen-key-never-used-no-network', SUPER_ADMIN_EMAILS: ADMIN });
    for (const k of ['DYNAMIC_V2_ALLOWED_OWNERS', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_AUTO_HEAL_POLICY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', ...SPEND_ENV]) delete process.env[k];
    AL.resetRelSchemaCache(); EL.resetExecLeaseSchemaCache();
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 12 } });
    await ds.initialize();
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);

    // Run real (servicios) con una parte de contenido
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const runs = new RunsService(ds, manifests, {}, { async check() { return { ok: true }; } }, budget);
    const [c2] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, 'r58 guard', 'dynamic') returning id`, [OWNER]);
    const gcid = c2.id;
    const m1 = crypto.randomUUID(); const ch1 = crypto.randomUUID(); const ch2 = crypto.randomUUID();
    const s2 = snap.buildBlueprintSnapshotV2({ id: gcid, title: 'r58 guard', finalExam: true, activityEngine: 'h5p' },
      [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
      [{ id: ch1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: false, activity_enabled: true },
        { id: ch2, module_id: m1, position: 1, title: 'Válvulas', objective: null, video_enabled: false, activity_enabled: true }]);
    for (const m of s2.modules) {
      await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, gcid, m.position, m.title]);
      for (const c of m.chapters) await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`, [c.id, gcid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
    }
    await ds.query(`insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count) values ($1, 1, 2, $2::jsonb, $3, 0, 1, 2)`,
      [gcid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
    await manifests.getOrCreate(gcid, OWNER, 1);
    let grun;
    try { grun = (await runs.startRun(gcid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id; } catch (err) {
      const body = err.getResponse ? err.getResponse() : null;
      assert(body && body.code === 'budget_approval_required', `startRun: ${err.message}`);
      await budget.adminAuthorize({ courseId: gcid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: ADMIN, reason: 'check r58' });
      grun = (await runs.startRun(gcid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
    }
    await ds.query(`update public.production_jobs set worker_status = 'running', status = 'running' where id = $1`, [grun]);
    const [gitem] = await ds.query(`select id, item_key from public.generation_item_runs where job_id = $1 and type = 'content' order by item_key limit 1`, [grun]);
    const ctrl = new FinopsLlmReservationController(ledger, budget);
    const resBody = (subject, extra = {}) => ({ subject, callRole: 'main', attempt: 1, model: 'claude-haiku-4-5', callId: crypto.randomUUID(), promptChars: 1000, maxTokens: 500, billingAccount: 'cursia', ...extra });
    const count = async (where, p = []) => Number((await ds.query(`select count(*)::int as n from public.generation_cost_events where ${where}`, p))[0].n);
    const unattributedSum = async (owner) => (await ds.query(`select coalesce(sum(amount),0)::text as t from public.generation_cost_events where run_id is null and course_id is null and billing_account = 'cursia'${owner ? ' and owner_id = $1' : ''}`, owner ? [owner] : []))[0].t;

    await check('[PX] proxy: x-cursia-item-run-id inexistente → 409 item_run_not_found ANTES de reservar (0 eventos); parte propia válida → reserva atribuida (sin cambio); sin header → sin atribuir (sin techo = igual)', async () => {
      const before = await count('true');
      const fake = resBody(OWNER, { itemRunId: crypto.randomUUID() });
      const e = await rejectsCode(ctrl.llmReservation(fake), 'item_run_not_found', 'uuid inventado');
      eq(e.getStatus(), 409, '409');
      eq(await count('true'), before, 'nada reservado');
      // Ledger directo (sin guard): misma regla en el punto de reserva.
      await rejectsCode(ledger.recordCharge(LUI.llmReservationToChargeInput(LUI.parseLlmReservationIngest(resBody(OWNER, { itemRunId: crypto.randomUUID() })))), 'ITEM_RUN_NOT_FOUND', 'ledger directo');
      const ok = await ctrl.llmReservation(resBody(OWNER, { itemRunId: gitem.id }));
      eq([ok.reserved, ok.attributed], [true, true], 'parte propia');
      const un = await ctrl.llmReservation(resBody(OWNER));
      eq([un.reserved, un.attributed], [true, false], 'sin parte: sin atribuir, permitido');
      // Un cargo POSTERIOR (no reserva) con parte inexistente se sigue registrando sin atribuir (el dinero ya se gastó).
      const post = await ledger.recordCharge(LUI.llmIngestToChargeInput(LUI.parseLlmUsageIngest({ subject: OWNER, itemRunId: crypto.randomUUID(), callRole: 'main', attempt: 1, model: 'claude-haiku-4-5', messageId: 'msg_post_' + crypto.randomUUID().slice(0, 8), usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, billingAccount: 'cursia' })));
      eq([post.inserted, post.event.metadata.attributionRejectReason], [true, 'item_run_not_found'], 'cargo posterior registrado');
    });

    await check('[PX] techo SIN atribuir por dueño (24 h móviles): con FINOPS_UNATTRIBUTED_DAILY_USD_PER_OWNER se aceptan reservas hasta el techo y la siguiente → 409 unattributed_ceiling_reached (0 eventos); otro dueño no se ve afectado; las atribuidas no cuentan', async () => {
      const spent = await unattributedSum(OWNER);
      const one = (await ctrl.llmReservation(resBody(OWNER))).amount;
      const ceiling = F.addDec(spent, one, one, one, '0.0000000001'); // caben 3 más (la de arriba ya cuenta)
      await withEnv({ FINOPS_UNATTRIBUTED_DAILY_USD_PER_OWNER: ceiling }, async () => {
        for (let i = 0; i < 2; i++) await ctrl.llmReservation(resBody(OWNER));
        const before = await count('true');
        const e = await rejectsCode(ctrl.llmReservation(resBody(OWNER)), 'unattributed_ceiling_reached', 'techo');
        eq(e.getStatus(), 409, '409');
        eq(await count('true'), before, 'nada reservado');
        assert(F.cmpDec(await unattributedSum(OWNER), ceiling) <= 0, 'nunca sobre el techo');
        eq((await ctrl.llmReservation(resBody(OTHER))).reserved, true, 'otro dueño');
        eq((await ctrl.llmReservation(resBody(OWNER, { itemRunId: gitem.id }))).attributed, true, 'atribuida: el techo no aplica');
        // BYOK sin atribuir: no es dinero de Cursia → no cuenta ni se frena.
        eq((await ctrl.llmReservation(resBody(OWNER, { billingAccount: 'user_key' }))).reserved, true, 'BYOK');
      });
      eq((await ctrl.llmReservation(resBody(OWNER))).reserved, true, 'sin techo configurado: igual que antes');
    });

    await check('[PX] techo SIN atribuir bajo CONCURRENCIA (20 reservas en paralelo, por dueño y global): el total nunca supera el techo', async () => {
      const NEW = '22222222-2222-4333-8444-555555555555';
      const one = (await ctrl.llmReservation(resBody(NEW))).amount;
      const base = await unattributedSum(NEW);
      const ceiling = F.addDec(base, one, one, one, one, one); // caben 5
      await withEnv({ FINOPS_UNATTRIBUTED_DAILY_USD_PER_OWNER: ceiling }, async () => {
        const res = await Promise.allSettled(Array.from({ length: 20 }, () => ctrl.llmReservation(resBody(NEW))));
        const okN = res.filter((x) => x.status === 'fulfilled').length;
        const denied = res.filter((x) => x.status === 'rejected' && codeOf(x.reason) === 'unattributed_ceiling_reached').length;
        eq([okN, denied], [5, 15], 'exactamente lo que cabe');
        assert(F.cmpDec(await unattributedSum(NEW), ceiling) <= 0, 'por dueño ≤ techo');
      });
      const g0 = await unattributedSum(null);
      const gCeil = F.addDec(g0, one, one, one);
      await withEnv({ FINOPS_UNATTRIBUTED_DAILY_USD_GLOBAL: gCeil }, async () => {
        const res = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => ctrl.llmReservation(resBody(i % 2 ? OWNER : OTHER))));
        eq(res.filter((x) => x.status === 'fulfilled').length, 3, 'global: 3 entre dos dueños');
        assert(F.cmpDec(await unattributedSum(null), gCeil) <= 0, 'global ≤ techo');
      });
    });

    await check('[KS] FINOPS_KILL_SWITCH: proxy → 409 finops_kill_switch (0 eventos); reserva de worker / lote → refuse (finops_ledger_write_failed, no llama); cargo posterior SÍ se registra; OFF → reanuda', async () => {
      await withEnv({ FINOPS_KILL_SWITCH: 'true' }, async () => {
        const before = await count('true');
        await rejectsCode(ctrl.llmReservation(resBody(OWNER, { itemRunId: gitem.id })), 'finops_kill_switch', 'proxy atribuido');
        await rejectsCode(ctrl.llmReservation(resBody(OWNER)), 'finops_kill_switch', 'proxy sin atribuir');
        const wr = { kind: 'llm', tag: 'main', itemRunId: gitem.id, ownerId: OWNER, runId: grun, itemKey: gitem.item_key, generation: 1, attempt: 1, estimate: { model: 'claude-sonnet-4-6', promptChars: 1000, maxTokens: 100 } };
        let we = null; try { await WH.reservePaidCall(ledger, wr); } catch (e) { we = e; }
        assert(we && /^finops_ledger_write_failed: .*FINOPS_KILL_SWITCH/.test(we.message), `worker: ${we && we.message}`);
        let be = null; try { await WH.reservePaidCalls(ledger, [wr, { ...wr, tag: 'continuation' }]); } catch (e) { be = e; }
        assert(be && /FINOPS_KILL_SWITCH/.test(be.message), 'lote');
        eq(await count('true'), before, 'ninguna reserva');
        const post = await ledger.recordCharge(LUI.llmIngestToChargeInput(LUI.parseLlmUsageIngest({ subject: OWNER, itemRunId: gitem.id, callRole: 'main', attempt: 1, model: 'claude-haiku-4-5', messageId: 'msg_ks_' + crypto.randomUUID().slice(0, 8), usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, billingAccount: 'cursia' })));
        eq(post.inserted, true, 'cargo posterior registrado (nunca se pierde)');
        eq((await ctrl.llmReservation(resBody(OWNER, { billingAccount: 'user_key' }))).reserved, true, 'BYOK no es dinero de Cursia');
      });
      eq((await ctrl.llmReservation(resBody(OWNER, { itemRunId: gitem.id }))).reserved, true, 'OFF → reanuda');
    });

    await check('[KS] FINOPS_PROVIDER_ALLOWLIST=anthropic: reservas de Gamma / TTS / Videogen rechazadas aunque el run diga real; Anthropic sigue', async () => {
      await withEnv({ FINOPS_PROVIDER_ALLOWLIST: 'anthropic' }, async () => {
        const mk = (kind, tag) => ({ kind, tag, itemRunId: gitem.id, ownerId: OWNER, runId: grun, itemKey: gitem.item_key, generation: 1, attempt: 1, estimate: { model: 'gpt-4o-mini-tts', characters: 300, promptChars: 100, maxTokens: 10 } });
        for (const k of ['tts', 'gamma', 'videogen']) {
          let e = null; try { await WH.reservePaidCall(ledger, mk(k, 'al-' + k)); } catch (x) { e = x; }
          assert(e && /PROVIDER_NOT_ALLOWED/.test(e.message), `${k}: ${e && e.message}`);
        }
        eq(await count(`metadata->>'callTag' like 'al-%'`), 0, 'nada reservado');
        const key = await WH.reservePaidCall(ledger, { ...mk('llm', 'al-llm'), estimate: { model: 'claude-sonnet-4-6', promptChars: 100, maxTokens: 10 } });
        assert(typeof key === 'string' && key.length > 0, 'anthropic reserva');
      });
    });

    await check('[OM] ownerMonthCommitted: solo el gasto del mes del dueño + el presupuesto pendiente de SUS runs vivos (monthCommitted sigue global)', async () => {
      const own = await budget.ownerMonthCommitted(OWNER);
      const oth = await budget.ownerMonthCommitted(OTHER);
      const all = await budget.monthCommitted();
      const [s1] = await ds.query(`select coalesce(sum(amount),0)::text as t from public.generation_cost_events where owner_id = $1 and billing_account <> 'user_key' and created_at >= date_trunc('month', now())`, [OWNER]);
      eq(own.spent, F.normalizeDecimal(s1.t), 'gasto del dueño');
      assert(F.cmpDec(own.outstanding, 0) > 0, 'el run vivo del dueño cuenta su pendiente');
      eq(oth.outstanding, F.normalizeDecimal(0), 'el otro dueño no tiene runs');
      assert(F.cmpDec(all.total, F.addDec(own.total, oth.total)) >= 0, 'global ≥ suma de dueños');
    });
  } finally {
    try { if (ds) await ds.destroy(); } catch {}
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    restoreProviders();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
}

(async () => {
  await pureChecks();
  if (!PURE_ONLY) await dbChecks();
  console.log(`\n${passes} OK, ${failures} fallidos`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(`❌ fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
