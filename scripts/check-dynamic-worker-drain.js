#!/usr/bin/env node
/* eslint-disable */
// R16 — robustez de los workers dinámicos (auditoría R16: #1, #15, #16, #7).
// Todo en proceso, sin DB ni red externa (proveedores FALSOS en 127.0.0.1 de
// test/e2e-v2/fakes.js; corré con netguard si querés verificarlo):
//
//  #1 drenado:
//   - runClaimLoop deja de reclamar en cuanto se pide el drenado; el item en
//     vuelo TERMINA (awaitDrain → 'drained'); tope de tiempo → 'timeout';
//   - worker de video: drenando → devuelve el item ANTES de enviar a Videogen
//     (0 envíos) y DURANTE el poll de un job ya persistido (worker_draining,
//     retryable, grantAttempt, sin completar); sin drenado completa;
//   - worker de proveedores: devuelve antes de enviar a Gamma (0 POST), durante
//     el poll de una generación persistida, antes del guion LLM (0 llamadas);
//     una llamada TTS ya empezada NO se corta: el item termina y se completa.
//  #15 un error de DB en el claim no mata el loop: se loguea, backoff, sigue
//      (y 42P01 usa el backoff lento de "esquema ausente").
//  #16 video_timeout / gamma_timeout dentro del tope de reloj → grantAttempt;
//      pasado el tope → consumen intento (sin opts).
//  #7 un video v3 no se completa sin duración medida: video_duration_unmeasured
//      reintentable; re-medición gratis desde el MP4 cuando nunca se midió;
//      runs v1/v2 sin cambios.
//
// Usage: node scripts/check-dynamic-worker-drain.js [path/to/dist]

const path = require('path');

const distArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const distRoot = path.resolve(process.cwd(), distArg || 'dist');
const REPO = path.resolve(__dirname, '..');
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
const { Logger } = require('@nestjs/common');
const WD = loadDist('workers/worker-drain.js');
const GATE = loadDist('workers/dynamic-worker-gate.js');
const IW = loadDist('workers/dynamic-item-worker.js');
const PW = loadDist('workers/dynamic-provider-worker.js');
const RP = loadDist('workers/provider-real/real-providers.js');
const SM = loadDist('package/v3/synthetic-media.js');
const { startProviderFakes, syntheticMp4WithMvhd } = require(path.join(REPO, 'test/e2e-v2/fakes.js'));

const LOGS = [];
const capLogger = { log: (m) => LOGS.push(String(m)), warn: (m) => LOGS.push(String(m)), error: (m) => LOGS.push(String(m)) };
Logger.overrideLogger({ log: capLogger.log, warn: capLogger.warn, error: capLogger.error, debug: () => {}, verbose: () => {} });

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OWNER = '11111111-2222-4333-8444-555555555555';
const SECRETS = { GAMMA_API_KEY: 'sk-r16-gamma', OPENAI_API_KEY: 'sk-r16-openai', ANTHROPIC_API_KEY: 'sk-r16-anthropic' };

// ─── fakes ────────────────────────────────────────────────────────────────
/** Scheduler falso: output_summary en memoria (merge como mergeOutputSummary), registra fail/complete con sus opts. */
function fakeScheduler(summary = {}, hooks = {}) {
  const st = { summary: JSON.parse(JSON.stringify(summary)), failed: [], completed: [], recorded: [], heartbeats: 0, blocked: [] };
  return {
    st,
    async claimNextItem() { return null; },
    async heartbeatItem() { st.heartbeats++; if (hooks.onHeartbeat) hooks.onHeartbeat(st.heartbeats); return true; },
    async recordItemExternal(_id, _ex, patch) {
      st.recorded.push(patch);
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'external') st.summary.external = { ...(st.summary.external || {}), ...v };
        else st.summary[k] = v;
      }
      if (hooks.onRecord) hooks.onRecord(patch);
      return true;
    },
    async failItem(_id, _ex, msg, retryable, _owner, opts) { st.failed.push({ msg, retryable, opts: opts || null }); return true; },
    async completeItem(_id, _ex, payload) { st.completed.push(payload); return true; },
    async blockItemForBudget(_id, _ex, m) { st.blocked.push(m); return true; },
  };
}
/** Ledger FinOps en memoria (reservas/liquidaciones; sin cargos previos del item). */
function fakeLedger() {
  const st = { charges: [], settled: [] };
  return {
    st,
    async recordCharge(i) { st.charges.push(i); return { inserted: true, event: { id: `ev-${st.charges.length}` } }; },
    async recordAdjustment() { return { inserted: true }; },
    async recordZero() { return { inserted: true }; },
    async settleReservation(key, final, reason) { st.settled.push({ key, reason }); return { finalInserted: !!final, finalEvent: null }; },
    async itemPaidCharges() { return []; },
  };
}
function videoDs(sched, run) {
  return {
    async query(sql) {
      if (/from public\.production_jobs/.test(sql)) return [{ owner_id: OWNER, video_mode: run.videoMode, input_payload: run.inputPayload }];
      if (/select output_summary from public\.generation_item_runs/.test(sql)) return [{ output_summary: sched.st.summary }];
      return [];
    },
  };
}
function videoItem(over = {}) {
  return {
    itemRunId: 'ir-video', runId: 'run-1', courseId: 1, artifactCourseId: 'c1', manifestId: 1, itemKey: 'video:ch1', type: 'video',
    chapterId: 'ch1', chapterNumber: 1, idempotencyKey: 'idem-v1', attempt: 1, generation: 1, rulesVersion: 2,
    blueprint: { course: { id: 1, title: 'Curso' }, chapter: { title: 'Bombas' } },
    dependencyArtifacts: [{ type: 'dynamic_content_md', artifactId: 'content-art' }], outputSummary: {}, ...over,
  };
}
function videoDeps(sched, run, over = {}) {
  return {
    scheduler: sched, dataSource: videoDs(sched, run), logger: capLogger, executorId: 'w-r16', leaseSeconds: 60, heartbeatMs: 600000,
    videoTimeoutMin: 1, videoPollMs: 5, mockScenario: 'success', mockResolvePolls: 2,
    artifacts: {
      async getDownloadUrl() { return { url: 'data:text/plain,Contenido%20del%20capitulo' }; },
      async uploadJsonArtifact(i) { sched.st.uploaded = (sched.st.uploaded || []).concat([i]); return { id: 'art-video' }; },
    },
    videogen: {
      async batchCreate() { sched.st.submits = (sched.st.submits || 0) + 1; return { batch_id: 'b', jobs: [{ job_id: 'vg-new' }] }; },
      async getVideoStatus(id) { return { job_id: id, status: 'completed_local', download_url: 'https://videogen.invalid/x.mp4', progress: 100, error: null }; },
      async getVideoCost() { return { estimated_total_cost: 1 }; },
    },
    ...over,
  };
}
const MOCK_RUN = { videoMode: 'mock', inputPayload: { videoMode: 'mock' } };
const YT_RUN = { videoMode: 'real', inputPayload: { videoMode: 'real', videoDelivery: 'youtube' } };
const DIRECT_REAL_RUN = { videoMode: 'real', inputPayload: { videoMode: 'real' } };

function ytPublisher(mp4, st) {
  return {
    async getConnection(ownerId) { return { userId: ownerId, status: 'active', scopes: 'youtube.upload,youtube.readonly' }; },
    async getAccessToken() { return 'tok'; },
    async uploadFromUrl(_c, options) {
      st.uploads = (st.uploads || 0) + 1;
      if (options.onBeforeUpload) await options.onBeforeUpload(mp4);
      return { videoId: 'AbCdEfGhIjK', youtubeUrl: 'https://www.youtube.com/watch?v=AbCdEfGhIjK' };
    },
  };
}

(async () => {
  // ═══ #1 / #15: loop de claim y drenado (puro) ══════════════════════════════
  await check('#1 runClaimLoop: al pedir el drenado deja de reclamar; el item en vuelo TERMINA (awaitDrain → drained), 1 solo claim', async () => {
    const drain = new WD.DrainSignal();
    const active = new Set();
    let claims = 0;
    let finished = 0;
    const loop = WD.runClaimLoop({
      name: 't', logger: capLogger, concurrency: 1, pollMs: 5, drain, active,
      claim: async () => { claims++; return claims === 1 ? { id: 'a' } : null; },
      process: async () => { await sleep(80); finished++; },
    });
    await sleep(20);
    eq([active.size, finished], [1, 0], 'en vuelo');
    drain.request('SIGTERM');
    await loop;
    const claimsAtStop = claims;
    eq(await WD.awaitDrain(active, 2000), 'drained', 'drenado');
    eq(finished, 1, 'el item en vuelo terminó');
    await sleep(40);
    eq(claims, claimsAtStop, 'ningún claim después de la señal');
  });

  await check('#1 awaitDrain con tope: item que no termina → timeout (el proceso sale igual); set vacío → drained', async () => {
    const active = new Set([new Promise(() => {})]);
    const t0 = Date.now();
    eq(await WD.awaitDrain(active, 60), 'timeout', 'timeout');
    assert(Date.now() - t0 < 1000, 'respetó el tope');
    eq(await WD.awaitDrain(new Set(), 10), 'drained', 'vacío');
    eq(WD.drainTimeoutMs({}), WD.DEFAULT_DRAIN_TIMEOUT_MS, 'default');
    eq(WD.drainTimeoutMs({ DYNAMIC_WORKER_DRAIN_TIMEOUT_MS: '5000' }), 5000, 'env');
    eq(WD.drainTimeoutMs({ DYNAMIC_WORKER_DRAIN_TIMEOUT_MS: 'x' }), WD.DEFAULT_DRAIN_TIMEOUT_MS, 'basura → default');
    assert(WD.DEFAULT_DRAIN_TIMEOUT_MS < WD.PM2_KILL_TIMEOUT_MS, 'drenado < kill_timeout de PM2');
  });

  await check('#1 installDrainHandlers: la señal pide el drenado, espera los items, cierra el contexto y sale con 0 (una sola vez)', async () => {
    const drain = new WD.DrainSignal();
    const active = new Set();
    let done = false;
    const p = sleep(40).then(() => { done = true; });
    active.add(p);
    p.then(() => active.delete(p));
    const exits = [];
    let closed = 0;
    const before = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
    const onSignal = WD.installDrainHandlers({ name: 't', logger: capLogger, drain, active, timeoutMs: 2000, close: async () => { closed++; }, exit: (c) => exits.push(c) });
    await onSignal('SIGTERM');
    await onSignal('SIGTERM');
    eq([drain.isDraining, done, closed, exits], [true, true, 1, [0]], 'drenado + cierre + exit(0) una vez');
    // limpiar los listeners que registró (no queremos que una señal real del gate salga del proceso de test).
    for (const sig of ['SIGINT', 'SIGTERM']) for (const l of process.listeners(sig)) if (!before[sig].includes(l)) process.removeListener(sig, l);
  });

  await check('#15 error de DB en el claim: se loguea, backoff exponencial acotado y el loop SIGUE (procesa el item siguiente); nunca lanza', async () => {
    const drain = new WD.DrainSignal();
    const active = new Set();
    const errs = [];
    const logger = { log() {}, warn() {}, error: (m) => errs.push(m) };
    let n = 0;
    const processed = [];
    const loop = WD.runClaimLoop({
      name: 'w', logger, concurrency: 1, pollMs: 5, drain, active, claimBackoff: new WD.ClaimErrorBackoff(5, 20),
      claim: async () => {
        n++;
        if (n <= 2) throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
        return n === 3 ? { id: 'it-3' } : null;
      },
      process: async (it) => { processed.push(it.id); },
    });
    const t0 = Date.now();
    while (processed.length === 0 && Date.now() - t0 < 3000) await sleep(5);
    drain.request('test');
    await loop;
    eq(processed, ['it-3'], 'procesó tras los errores');
    eq(errs.length, 2, 'un log por error');
    assert(/se reintenta en 5 ms/.test(errs[0]) && /se reintenta en 10 ms/.test(errs[1]), `backoff creciente: ${errs.join(' | ')}`);
    const b = new WD.ClaimErrorBackoff(1000, 60000);
    eq([b.onError(), b.onError(), b.onError()], [1000, 2000, 4000], 'exponencial');
    for (let i = 0; i < 20; i++) b.onError();
    eq(b.onError(), 60000, 'acotado');
    b.onOk();
    eq(b.onError(), 1000, 'reset');
  });

  await check('#15 esquema ausente (42P01) en el claim → backoff lento de MissingSchemaBackoff, un solo error, el loop sigue vivo', async () => {
    const drain = new WD.DrainSignal();
    const errs = [];
    const logger = { log() {}, warn() {}, error: (m) => errs.push(m) };
    let n = 0;
    const loop = WD.runClaimLoop({
      name: 'w', logger, concurrency: 1, pollMs: 5, drain, schema: new GATE.MissingSchemaBackoff(logger, 'w', 10),
      claim: async () => { n++; throw Object.assign(new Error('relation "generation_item_runs" does not exist'), { code: '42P01' }); },
      process: async () => {},
    });
    await sleep(80);
    drain.request('test');
    await loop;
    assert(n >= 3, `siguió reintentando (${n})`);
    eq(errs.filter((e) => /42P01/.test(e)).length, 1, 'un solo error por episodio');
  });

  // ═══ #1: worker de video ═══════════════════════════════════════════════════
  await check('#1 video: drenando ANTES de un envío nuevo → worker_draining (retryable, grantAttempt), 0 envíos, sin marcador de envío', async () => {
    const s = fakeScheduler();
    const drain = new WD.DrainSignal();
    drain.request('SIGTERM');
    await IW.processItem(videoDeps(s, MOCK_RUN, { drain }), videoItem());
    eq(s.st.failed.length, 1, 'un fail');
    const f = s.st.failed[0];
    assert(f.msg.startsWith('worker_draining:') && f.retryable === true, f.msg);
    eq([f.opts.grantAttempt, f.opts.retryAfterSeconds], [true, WD.DRAIN_HANDBACK_RETRY_SECONDS], 'intento concedido');
    eq([s.st.submits || 0, s.st.completed.length, 'externalSubmitStartedAt' in s.st.summary], [0, 0, false], 'nada enviado ni marcado');
  });

  await check('#1 video: drenado DURANTE el poll de un job persistido → devuelto sin completar ni reenviar (el próximo claim re-pollea el MISMO job)', async () => {
    const drain = new WD.DrainSignal();
    const s = fakeScheduler({ external: { videogenBatchId: 'mb', videogenJobId: 'mock_idem-v1', mode: 'mock' } }, {
      onRecord: (p) => { if (p.mockPollCount === 1) drain.request('SIGTERM'); },
    });
    await IW.processItem(videoDeps(s, MOCK_RUN, { drain, mockResolvePolls: 5 }), videoItem({ outputSummary: s.st.summary }));
    eq([s.st.completed.length, s.st.submits || 0, s.st.failed.length], [0, 0, 1], 'devuelto, 0 envíos');
    assert(s.st.failed[0].msg.startsWith('worker_draining:') && s.st.failed[0].opts.grantAttempt === true, s.st.failed[0].msg);
    eq(s.st.summary.external.videogenJobId, 'mock_idem-v1', 'job intacto');
  });

  await check('#1 video: sin drenado el mismo item mock completa (control)', async () => {
    const s = fakeScheduler();
    await IW.processItem(videoDeps(s, MOCK_RUN), videoItem());
    eq([s.st.completed.length, s.st.failed.length], [1, 0], `completó (${JSON.stringify(s.st.failed)})`);
  });

  // ═══ #16: timeouts gratuitos ══════════════════════════════════════════════
  await check('#16 video_timeout dentro del tope de reloj → grantAttempt; con videoPollSince viejo (> 3 h) → consume intento (sin opts)', async () => {
    const ext = { external: { videogenBatchId: 'mb', videogenJobId: 'mock_idem-v1', mode: 'mock' } };
    const s1 = fakeScheduler(ext);
    await IW.processItem(videoDeps(s1, MOCK_RUN, { mockScenario: 'timeout', videoTimeoutMin: 0.0005 }), videoItem({ outputSummary: s1.st.summary }));
    eq([s1.st.failed[0].msg, s1.st.failed[0].retryable, s1.st.failed[0].opts && s1.st.failed[0].opts.grantAttempt], ['video_timeout', true, true], 'gratis');
    assert(typeof s1.st.summary.videoPollSince === 'string', 'videoPollSince persistido');
    const old = new Date(Date.now() - IW.VIDEO_TIMEOUT_FREE_WALL_MS - 60000).toISOString();
    const s2 = fakeScheduler({ ...ext, videoPollSince: old });
    await IW.processItem(videoDeps(s2, MOCK_RUN, { mockScenario: 'timeout', videoTimeoutMin: 0.0005 }), videoItem({ outputSummary: s2.st.summary }));
    eq([s2.st.failed[0].msg, s2.st.failed[0].opts], ['video_timeout', null], 'pasado el tope consume');
  });

  // ═══ #7: duración medida ══════════════════════════════════════════════════
  const ytResume = (extra = {}) => ({
    delivery: 'uploading_youtube', videogenStatus: 'completed_local', videogenDownloadUrl: 'https://videogen.invalid/x.mp4', costUsd: 1,
    external: { videogenBatchId: 'b', videogenJobId: 'vg-1', mode: 'real', durationSec: null, durationSource: 'unknown' }, ...extra,
  });

  await check('#7 v3 + YouTube: MP4 sin mvhd y Videogen sin duración → video_duration_unmeasurable (NO reintentable, fix M2: determinístico), NO completa ni sube el artifact', async () => {
    const s = fakeScheduler({ external: { videogenBatchId: 'b', videogenJobId: 'vg-1', mode: 'real' } });
    const st = {};
    const deps = videoDeps(s, YT_RUN, { youtube: ytPublisher(Buffer.from('no-es-un-mp4'), st) });
    await IW.processItem(deps, videoItem({ rulesVersion: 3, outputSummary: s.st.summary }));
    eq([s.st.completed.length, (s.st.uploaded || []).length, st.uploads], [0, 0, 1], 'no completó (el video sí se subió una vez)');
    const f = s.st.failed[0];
    assert(f && f.retryable === false && f.msg.startsWith(`${IW.VIDEO_DURATION_UNMEASURABLE}:`), JSON.stringify(s.st.failed));
    eq(s.st.summary.external.youtubeVideoId, 'AbCdEfGhIjK', 'el id quedó persistido (el reintento no re-sube)');
  });

  await check('#7 reintento del mismo video (ya en YouTube, sin medición previa) → re-descarga el MP4 (gratis), mide mvhd y completa con durationSec; 0 subidas', async () => {
    const s = fakeScheduler(ytResume({ external: { videogenBatchId: 'b', videogenJobId: 'vg-1', mode: 'real', durationSec: null, durationSource: 'unknown', youtubeVideoId: 'AbCdEfGhIjK', youtubeUrl: 'https://www.youtube.com/watch?v=AbCdEfGhIjK' } }));
    const st = {};
    const fetched = [];
    const deps = videoDeps(s, YT_RUN, { youtube: ytPublisher(null, st), fetchMp4: async (u) => { fetched.push(u); return syntheticMp4WithMvhd(300); } });
    await IW.processItem(deps, videoItem({ rulesVersion: 3, outputSummary: s.st.summary }));
    eq([s.st.failed.length, s.st.completed.length, st.uploads || 0, fetched], [0, 1, 0, ['https://videogen.invalid/x.mp4']], JSON.stringify(s.st.failed));
    const sum = s.st.completed[0].summary;
    eq([sum.durationSec, sum.durationSource], [300, 'mp4_mvhd'], 'duración medida en el summary (la que lee video_interactions)');
    eq(s.st.summary.mp4Duration, { durationSec: 300, durationSource: 'mp4_mvhd' }, 'medición persistida');
  });

  await check('#7 reintento con el MP4 ya medido como ilegible → no re-descarga; falla NO reintentable (video_duration_unmeasurable, sin completar)', async () => {
    const s = fakeScheduler(ytResume({ mp4Duration: { durationSec: null, durationSource: 'unknown' }, external: { videogenBatchId: 'b', videogenJobId: 'vg-1', mode: 'real', durationSec: null, durationSource: 'unknown', youtubeVideoId: 'AbCdEfGhIjK', youtubeUrl: 'https://www.youtube.com/watch?v=AbCdEfGhIjK' } }));
    let fetched = 0;
    await IW.processItem(videoDeps(s, YT_RUN, { youtube: ytPublisher(null, {}), fetchMp4: async () => { fetched++; return Buffer.alloc(0); } }), videoItem({ rulesVersion: 3, outputSummary: s.st.summary }));
    eq([fetched, s.st.completed.length, s.st.failed[0] && s.st.failed[0].retryable, s.st.failed[0] && s.st.failed[0].msg.startsWith(IW.VIDEO_DURATION_UNMEASURABLE)], [0, 0, false, true], 'sin completar');
  });

  await check('#7 YouTube sin medición previa y la re-descarga del MP4 falla (red) → video_duration_unmeasured REINTENTABLE (transitorio)', async () => {
    const s = fakeScheduler(ytResume({ external: { videogenBatchId: 'b', videogenJobId: 'vg-1', mode: 'real', durationSec: null, durationSource: 'unknown', youtubeVideoId: 'AbCdEfGhIjK', youtubeUrl: 'https://www.youtube.com/watch?v=AbCdEfGhIjK' } }));
    await IW.processItem(videoDeps(s, YT_RUN, { youtube: ytPublisher(null, {}), fetchMp4: async () => { throw new Error('ECONNRESET'); } }), videoItem({ rulesVersion: 3, outputSummary: s.st.summary }));
    const f = s.st.failed[0];
    eq([s.st.completed.length, f && f.retryable, f && f.msg.startsWith(`${IW.VIDEO_DURATION_UNMEASURED}:`)], [0, true, true], JSON.stringify(s.st.failed));
  });

  await check('#7 fix M2: v3 videogen_direct sin duración → se mide GRATIS el MP4 de status.download_url: mvhd → completa; ilegible → no reintentable; red → reintentable; v2 sin cambios', async () => {
    const ext = { external: { videogenBatchId: 'b', videogenJobId: 'vg-1', mode: 'real' } };
    const run = async (fetchMp4, rulesVersion = 3) => {
      const s = fakeScheduler(ext);
      const fetched = [];
      await IW.processItem(videoDeps(s, DIRECT_REAL_RUN, { fetchMp4: async (u) => { fetched.push(u); return fetchMp4(u); } }), videoItem({ rulesVersion, outputSummary: s.st.summary }));
      return { s, fetched };
    };
    let r = await run(async () => syntheticMp4WithMvhd(240));
    eq([r.s.st.failed.length, r.s.st.completed.length, r.fetched], [0, 1, ['https://videogen.invalid/x.mp4']], 'mide y completa');
    eq([r.s.st.uploaded[0].payload.durationSec, r.s.st.uploaded[0].payload.durationSource], [240, 'mp4_mvhd'], 'duración medida en el artifact');
    eq(r.s.st.completed[0].summary.external, { durationSec: 240, durationSource: 'mp4_mvhd' }, 'summary');
    r = await run(async () => Buffer.from('sin-mvhd'));
    eq([r.s.st.completed.length, r.s.st.failed[0].retryable, r.s.st.failed[0].msg.startsWith(IW.VIDEO_DURATION_UNMEASURABLE)], [0, false, true], 'ilegible → admin');
    r = await run(async () => { throw new Error('HTTP 502'); });
    eq([r.s.st.completed.length, r.s.st.failed[0].retryable, r.s.st.failed[0].msg.startsWith(`${IW.VIDEO_DURATION_UNMEASURED}:`)], [0, true, true], 'red → reintentable');
    r = await run(async () => { throw new Error('no debería medir'); }, 2);
    eq([r.s.st.completed.length, r.s.st.failed.length, r.fetched.length], [1, 0, 0], 'v2 completa sin medir');
    eq(r.s.st.completed[0].summary.external, { durationSec: null, durationSource: 'unknown' }, 'v2: null + unknown como antes');
  });

  await check('#7 fix m4: re-descarga del MP4 acotada — Content-Length mayor al tope o stream que lo supera → error (unavailable, reintentable); dentro del tope → bytes', async () => {
    const http = require('http');
    const mp4 = syntheticMp4WithMvhd(200);
    const srv = http.createServer((rq, rs) => {
      if (rq.url === '/big') { rs.writeHead(200, { 'content-length': String(10 * 1024 * 1024) }); return rs.end(); }
      if (rq.url === '/stream') {
        rs.writeHead(200, { 'content-type': 'video/mp4' });
        let n = 0;
        const t = setInterval(() => { rs.write(Buffer.alloc(4096, 1)); if (++n >= 20) { clearInterval(t); rs.end(); } }, 1);
        rs.on('close', () => clearInterval(t));
        return;
      }
      rs.writeHead(200, { 'content-length': String(mp4.length) });
      rs.end(mp4);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      eq(IW.MP4_REMEASURE_MAX_BYTES, 600 * 1024 * 1024, 'tope 600 MB');
      let e = null;
      try { await IW.fetchMp4Capped(`${base}/big`, 1024 * 1024); } catch (x) { e = x; }
      assert(e && /Content-Length/.test(e.message), `Content-Length: ${e && e.message}`);
      e = null;
      try { await IW.fetchMp4Capped(`${base}/stream`, 16 * 1024); } catch (x) { e = x; }
      assert(e && /bytes leídos/.test(e.message), `stream: ${e && e.message}`);
      const ok = await IW.fetchMp4Capped(`${base}/ok`, 1024 * 1024);
      eq(ok.length, mp4.length, 'dentro del tope');
      // En el worker: el tope superado es `unavailable` → video_duration_unmeasured REINTENTABLE, sin completar.
      const s = fakeScheduler(ytResume({ videogenDownloadUrl: `${base}/big`, external: { videogenBatchId: 'b', videogenJobId: 'vg-1', mode: 'real', durationSec: null, durationSource: 'unknown', youtubeVideoId: 'AbCdEfGhIjK', youtubeUrl: 'https://www.youtube.com/watch?v=AbCdEfGhIjK' } }));
      await IW.processItem(videoDeps(s, YT_RUN, { youtube: ytPublisher(null, {}), fetchMp4: (u) => IW.fetchMp4Capped(u, 1024 * 1024) }), videoItem({ rulesVersion: 3, outputSummary: s.st.summary }));
      const f = s.st.failed[0];
      eq([s.st.completed.length, f && f.retryable, f && f.msg.startsWith(`${IW.VIDEO_DURATION_UNMEASURED}:`)], [0, true, true], JSON.stringify(s.st.failed));
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  // ═══ #1 / #16: worker de proveedores (proveedores FALSOS en 127.0.0.1) ═════
  const fakes = startProviderFakes({ gammaKey: SECRETS.GAMMA_API_KEY, openaiKey: SECRETS.OPENAI_API_KEY, anthropicKey: SECRETS.ANTHROPIC_API_KEY, makePdf: SM.syntheticPdf, makeMp3: SM.syntheticMp3 });
  const urls = await fakes.listen();
  const env = {
    ...SECRETS, GAMMA_API_BASE_URL: urls.gammaUrl, OPENAI_API_BASE_URL: urls.openaiUrl, ANTHROPIC_API_BASE_URL: urls.anthropicUrl,
    GAMMA_THEME_V21_LIGHT_DEFAULT: 'theme-light', GAMMA_THEME_V21_DARK_DEFAULT: 'theme-dark',
  };
  const provDeps = (s, over = {}) => ({
    scheduler: s,
    dataSource: { async query(sql) { if (/from public\.production_jobs/.test(sql)) return [{ owner_id: OWNER, input_payload: { providerModes: { presentation: 'real', audio: 'real' } } }]; return []; } },
    artifacts: {
      async uploadJsonArtifact() { return { id: 'art-json' }; },
      async uploadBufferArtifact() { return { id: 'art-mp3' }; },
      async putStorageObject() { return {}; },
      async getDownloadUrl(id) {
        if (id === 'intro-art') return { url: 'data:application/json,' + encodeURIComponent(JSON.stringify({ schemaVersion: 1, welcome: 'Te damos la bienvenida al curso de hidráulica de planta.' })) };
        return { url: 'data:text/plain,' + encodeURIComponent('# Bombas\n\nLa bomba mueve el aceite.') };
      },
    },
    logger: capLogger, executorId: 'prov-r16', leaseSeconds: 120, env, gammaPollMs: 5, gammaTimeoutMs: 3000, finops: fakeLedger(),
    budget: { async guardPaidSubmission() { return { allow: true, decision: 'ALLOW', committed: '0', remaining: '9', reason: 'test', authorizedBudget: '9' }; } },
    rasterizer: { async available() { return true; }, async firstPagePng() { throw new Error('no debería rasterizar'); } },
    ...over,
  });
  const provItem = (type, summary = {}, deps = []) => ({
    itemRunId: 'ir-p', runId: 'run-p', courseId: 1, artifactCourseId: 'c1', manifestId: 1, itemKey: `${type}:ch1`, type, chapterId: 'ch1', chapterNumber: 1,
    idempotencyKey: 'idem-p', attempt: 1, generation: 1, outputSummary: summary, dependencyArtifacts: deps,
    blueprint: { course: { id: 1, title: 'Curso' }, chapter: { title: 'Bombas', description: null } }, context: { courseContext: {} },
  });
  const mkGeneration = async () => {
    const r = await fetch(`${urls.gammaUrl}/generations`, { method: 'POST', headers: { 'X-API-KEY': SECRETS.GAMMA_API_KEY, 'content-type': 'application/json' }, body: '{}' });
    return (await r.json()).generationId;
  };
  try {
    await check('#1 Gamma: drenando antes de un envío nuevo → worker_draining (grantAttempt), 0 POST a Gamma, sin marcador', async () => {
      const posts0 = fakes.st.gammaPosts.length;
      const s = fakeScheduler();
      const drain = new WD.DrainSignal();
      drain.request('SIGTERM');
      await PW.processProviderItem(provDeps(s, { drain }), provItem('presentation', {}, [{ type: 'dynamic_content_md', artifactId: 'content' }]));
      eq(fakes.st.gammaPosts.length - posts0, 0, '0 envíos');
      assert(s.st.failed.length === 1 && s.st.failed[0].msg.startsWith('worker_draining:') && s.st.failed[0].opts.grantAttempt, JSON.stringify(s.st.failed));
      assert(!('externalSubmitStartedAt' in s.st.summary), 'sin marcador');
    });

    await check('#1 Gamma: drenado DURANTE el poll de una generación persistida → devuelta (sin completar, sin reenviar)', async () => {
      fakes.plan.gammaHoldPending = true;
      const gid = await mkGeneration();
      const posts0 = fakes.st.gammaPosts.length;
      const drain = new WD.DrainSignal();
      const s = fakeScheduler({ externalReservationKey: 'res-1', external: { gammaGenerationId: gid, gammaThemeId: 'theme-light', themeFamily: 'aula-clara', themeMode: 'light', acceptedAtAttempt: 1 } }, {
        onHeartbeat: () => drain.request('SIGTERM'),
      });
      await PW.processProviderItem(provDeps(s, { drain }), provItem('presentation', s.st.summary));
      fakes.plan.gammaHoldPending = false;
      eq([fakes.st.gammaPosts.length - posts0, s.st.completed.length], [0, 0], '0 reenvíos, sin completar');
      assert(s.st.failed.length === 1 && s.st.failed[0].msg.startsWith('worker_draining:') && s.st.failed[0].opts.grantAttempt, JSON.stringify(s.st.failed));
    });

    await check('#16 gamma_timeout dentro del tope de reloj → grantAttempt; con gammaPollSince > 60 min → consume intento (sin opts)', async () => {
      fakes.plan.gammaHoldPending = true;
      const gid = await mkGeneration();
      const base = { externalReservationKey: 'res-1', external: { gammaGenerationId: gid, gammaThemeId: 'theme-light', themeFamily: 'aula-clara', themeMode: 'light', acceptedAtAttempt: 1 } };
      const s1 = fakeScheduler(base);
      await PW.processProviderItem(provDeps(s1, { gammaTimeoutMs: 30 }), provItem('presentation', s1.st.summary));
      assert(s1.st.failed[0].msg.startsWith('gamma_timeout:') && s1.st.failed[0].retryable && s1.st.failed[0].opts && s1.st.failed[0].opts.grantAttempt === true, JSON.stringify(s1.st.failed));
      assert(typeof s1.st.summary.gammaPollSince === 'string', 'gammaPollSince persistido');
      const s2 = fakeScheduler({ ...base, gammaPollSince: new Date(Date.now() - RP.GAMMA_TIMEOUT_FREE_WALL_MS - 60000).toISOString() });
      await PW.processProviderItem(provDeps(s2, { gammaTimeoutMs: 30 }), provItem('presentation', s2.st.summary));
      fakes.plan.gammaHoldPending = false;
      assert(s2.st.failed[0].msg.startsWith('gamma_timeout:') && s2.st.failed[0].retryable && s2.st.failed[0].opts === null, JSON.stringify(s2.st.failed));
    });

    await check('#1 audiolibro: drenando antes del guion LLM → devuelto, 0 llamadas al LLM ni al TTS', async () => {
      const llm0 = fakes.st.llm.length;
      const tts0 = fakes.st.tts.length;
      const s = fakeScheduler();
      const drain = new WD.DrainSignal();
      drain.request('SIGTERM');
      await PW.processProviderItem(provDeps(s, { drain }), provItem('audiobook_chapter', {}, [{ type: 'dynamic_content_md', artifactId: 'content' }]));
      eq([fakes.st.llm.length - llm0, fakes.st.tts.length - tts0], [0, 0], '0 llamadas');
      assert(s.st.failed[0] && s.st.failed[0].msg.startsWith('worker_draining:') && s.st.failed[0].opts.grantAttempt, JSON.stringify(s.st.failed));
    });

    await check('#1 audio: una llamada TTS ya empezada NO se corta — drenado pedido en medio del audio → el item termina y se completa (nunca reconciliación)', async () => {
      const tts0 = fakes.st.tts.length;
      const drain = new WD.DrainSignal();
      const s = fakeScheduler({}, { onHeartbeat: () => drain.request('SIGTERM') });
      await PW.processProviderItem(provDeps(s, { drain }), provItem('audio_welcome', {}, [{ type: 'dynamic_course_intro_json', artifactId: 'intro-art' }]));
      assert(drain.isDraining, 'el drenado se pidió en vuelo');
      eq([s.st.failed.length, s.st.completed.length, fakes.st.tts.length - tts0], [0, 1, 1], JSON.stringify(s.st.failed));
    });
  } finally {
    await fakes.close();
  }

  console.log(`\n${passes} OK, ${failures} fallidos`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(`❌ fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
