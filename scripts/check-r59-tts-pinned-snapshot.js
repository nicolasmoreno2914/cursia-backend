#!/usr/bin/env node
/* eslint-disable */
// r59b — snapshot fijo del TTS de OpenAI. El alias `gpt-4o-mini-tts` se colgaba de forma intermitente (staging
// 2026-10-19: 5 de 11 llamadas >60 s, terminadas a los 125–172 s y cobradas); `gpt-4o-mini-tts-2025-03-20`, 0 de 13.
//
// Sin red a proveedores y sin gasto: OpenAI falso local (test/e2e-v2/fakes.js), ledger y scheduler en memoria,
// Videogen falso (batchCreate capturado) y `fetch` global falso para VideogenService.
//   (a) TTS_MODEL_DEFAULT = snapshot; el worker real lo envía a OpenAI; OPENAI_TTS_MODEL lo pisa;
//   (b) pricing-seed.v1 tiene las 3 filas del snapshot, con precio idéntico al alias;
//   (c) reserva y liquidación del worker con el snapshot: MISMO modelo, priceUsage sin PRICING_MISSING y monto igual
//       al del alias; el guard (callCost) cobra igual que el alias;
//   (d) batchCreate del worker dinámico lleva external_metadata.tts_model = snapshot; DYNAMIC_VIDEOGEN_TTS_MODEL lo
//       pisa; VideogenService.batchCreate serializa el campo tal cual.
//
// Usage: node scripts/check-r59-tts-pinned-snapshot.js [path/to/dist]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const RP = loadDist('workers/provider-real/real-providers.js');
const F = loadDist('modules/finops/index.js');
const W = loadDist('workers/dynamic-item-worker.js');
const { VideogenService } = loadDist('video-engine/videogen.service.js');
const { startProviderFakes } = require(path.join(REPO, 'test/e2e-v2/fakes.js'));

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`);
}
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const SNAPSHOT = 'gpt-4o-mini-tts-2025-03-20';
const ALIAS = 'gpt-4o-mini-tts';
const SEED = JSON.parse(fs.readFileSync(path.join(REPO, 'src/modules/finops/pricing-seed.v1.json'), 'utf8'));
const CATALOG = SEED.rows.map((r, i) => ({ id: `seed-${i}`, ...r, unit_size: String(r.unit_size), unit_price: String(r.unit_price), effective_to: r.effective_to ?? null }));
const TTS_AT = (product) => ({ provider: 'openai', service: 'audio.speech', product });

// ─── MP3 falso (MPEG-2 L3, 24 kHz, mono, 64 kbps) para que el worker mida la duración ─────────────
const FRAME_SECONDS = 576 / 24000;
function fakeMp3(secs) {
  const frames = Math.max(1, Math.round(secs / FRAME_SECONDS));
  const len = 3 * 64;
  const buf = Buffer.alloc(frames * len, 0x55);
  for (let f = 0; f < frames; f++) { const o = f * len; buf[o] = 0xff; buf[o + 1] = 0xf3; buf[o + 2] = (8 << 4) | 0x04; buf[o + 3] = 0xc0; }
  return buf;
}

// ─── Mundo en memoria del worker de proveedores (mismo patrón que check-r19-audiobook.js) ──────────
function memoryWorld() {
  const ledgerInputs = [];
  const rows = [];
  const items = new Map();
  const artifacts = [];
  const scheduler = {
    async completeItem(id, e, o) { const it = items.get(id); it.status = 'completed'; it.completion = o; return true; },
    async failItem(id, e, msg, retry) { const it = items.get(id); it.status = retry ? 'retrying' : 'failed'; it.error = msg; return true; },
    async blockItemForBudget(id, e, msg) { const it = items.get(id); it.status = 'blocked'; it.error = msg; return true; },
    async recordItemExternal(id, e, patch) { const it = items.get(id); it.outputSummary = { ...it.outputSummary, ...JSON.parse(JSON.stringify(patch)) }; return true; },
    async heartbeatItem() { return true; },
  };
  const keyOf = (input) => input.idempotencyKey || `${input.idempotency.kind}:${JSON.stringify(input.idempotency.parts)}`;
  const ledger = {
    async recordCharge(input) {
      const key = keyOf(input);
      let row = rows.find((r) => r.key === key);
      if (row) return { inserted: false, event: row };
      ledgerInputs.push(input);
      row = { key, input, settled: false, itemRunId: input.itemRunId };
      rows.push(row);
      return { inserted: true, event: row };
    },
    async recordAdjustment() { return { inserted: true }; },
    async recordZero() { return { inserted: true }; },
    async settleReservation(key, finalCharge) {
      const res = rows.find((r) => r.key === key);
      if (!res) throw new Error(`no existe la reserva ${key}`);
      let fin = null;
      if (finalCharge) fin = await ledger.recordCharge(finalCharge);
      res.settled = true;
      return { finalInserted: !!(fin && fin.inserted), finalEvent: fin ? fin.event : null, released: true, alreadySettled: false };
    },
    async itemPaidCharges(itemRunId) { return rows.filter((r) => r.itemRunId === itemRunId).map((r) => ({ idempotency_key: r.key, settled: r.settled })); },
  };
  const arts = {
    async uploadJsonArtifact(a) { const id = crypto.randomUUID(); artifacts.push({ id, ...a }); return { id }; },
    async uploadBufferArtifact(a) { const id = crypto.randomUUID(); artifacts.push({ id, ...a }); return { id }; },
    async getDownloadUrl(id) { const a = artifacts.find((x) => x.id === id); return { url: `data:text/plain;base64,${Buffer.from(a.text).toString('base64')}` }; },
  };
  return { ledgerInputs, rows, items, artifacts, scheduler, ledger, arts };
}
function welcomeItem(Wd) {
  const depId = crypto.randomUUID();
  Wd.artifacts.push({ id: depId, text: JSON.stringify({ welcome: 'Bienvenidos al curso. En este recorrido vamos a trabajar juntos, paso a paso, sobre los temas centrales.' }) });
  const it = {
    itemRunId: crypto.randomUUID(), runId: crypto.randomUUID(), courseId: 1, artifactCourseId: 'course-r59', manifestId: 7,
    itemKey: 'audio_welcome:course', type: 'audio_welcome', chapterId: null, chapterNumber: null, idempotencyKey: `idem-${crypto.randomUUID().slice(0, 8)}`,
    attempt: 1, generation: 1, outputSummary: {}, dependencyArtifacts: [{ type: 'dynamic_course_intro_json', artifactId: depId }],
    blueprint: { course: { title: 'Curso r59' } }, status: 'running',
  };
  Wd.items.set(it.itemRunId, it);
  return it;
}
async function runWelcome(env) {
  const Wd = memoryWorld();
  const it = welcomeItem(Wd);
  const deps = {
    scheduler: Wd.scheduler, dataSource: { async query() { return []; } }, artifacts: Wd.arts,
    logger: { log() {}, warn() {}, error() {}, debug() {} }, executorId: 'r59-worker', leaseSeconds: 120, finops: Wd.ledger,
    budget: { async guardPaidSubmission() { return { allow: true, decision: 'ALLOW', committed: '0', remaining: '99', reason: 'test', authorizedBudget: '99' }; } },
    env,
  };
  await RP.processRealProviderItem(deps, it, 'owner-r59');
  return { Wd, it };
}

async function main() {
  const fakes = startProviderFakes({ openaiKey: 'sk-r59-fake', anthropicKey: 'sk-ant-r59-fake', gammaKey: 'g', makePdf: () => Buffer.from('%PDF'), makeMp3: (secs) => fakeMp3(secs), ttsWordsPerSecond: 141 / 60 });
  const urls = await fakes.listen();
  const ENV = { OPENAI_API_KEY: 'sk-r59-fake', OPENAI_API_BASE_URL: urls.openaiUrl };
  try {
    // ── (a) ───────────────────────────────────────────────────────────────────────────────────────
    await check('(a) TTS_MODEL_DEFAULT es el snapshot fijo; el worker real (bienvenida) lo envía a OpenAI', async () => {
      eq(RP.TTS_MODEL_DEFAULT, SNAPSHOT, 'TTS_MODEL_DEFAULT');
      const t0 = fakes.st.tts.length;
      const { it } = await runWelcome({ ...ENV });
      eq([it.status, it.error ?? null], ['completed', null], 'bienvenida completa');
      eq(fakes.st.tts.slice(t0).map((c) => c.model), [SNAPSHOT], 'modelo pedido a OpenAI');
      eq(it.completion.summary.model, SNAPSHOT, 'modelo en el summary');
    });
    await check('(a) OPENAI_TTS_MODEL sigue teniendo prioridad sobre el default', async () => {
      const t0 = fakes.st.tts.length;
      const { it } = await runWelcome({ ...ENV, OPENAI_TTS_MODEL: 'tts-1' });
      eq(it.status, 'completed', `completa (${it.error})`);
      eq(fakes.st.tts.slice(t0).map((c) => c.model), ['tts-1'], 'el env pisa el default');
    });
    await check('(a) r60: OPENAI_TTS_MODEL = alias exacto vuelve al snapshot (llamada, reserva y liquidación); OPENAI_TTS_ALLOW_ALIAS=true lo deja pasar', async () => {
      let t0 = fakes.st.tts.length;
      const { Wd, it } = await runWelcome({ ...ENV, OPENAI_TTS_MODEL: ALIAS });
      eq(it.status, 'completed', `completa (${it.error})`);
      eq(fakes.st.tts.slice(t0).map((c) => c.model), [SNAPSHOT], 'alias → snapshot en la llamada');
      eq(Wd.ledgerInputs.map((x) => x.modelOrProduct), [SNAPSHOT, SNAPSHOT], 'reserva y liquidación con el modelo llamado');
      t0 = fakes.st.tts.length;
      const r2 = await runWelcome({ ...ENV, OPENAI_TTS_MODEL: ALIAS, OPENAI_TTS_ALLOW_ALIAS: 'true' });
      eq(r2.it.status, 'completed', `completa (${r2.it.error})`);
      eq(fakes.st.tts.slice(t0).map((c) => c.model), [ALIAS], 'ALLOW_ALIAS=true');
      eq(r2.Wd.ledgerInputs.map((x) => x.modelOrProduct), [ALIAS, ALIAS], 'ledger = modelo llamado (alias)');
    });

    // ── (b) ───────────────────────────────────────────────────────────────────────────────────────
    await check('(b) el seed tiene las 3 filas del snapshot, idénticas al alias salvo el modelo y source_ref', () => {
      const pick = (m) => SEED.rows.filter((r) => r.product_or_model === m).sort((x, y) => x.meter.localeCompare(y.meter));
      const snap = pick(SNAPSHOT);
      const alias = pick(ALIAS);
      eq(snap.map((r) => r.meter), ['audio_output_tokens', 'audio_seconds', 'text_input_tokens'], 'medidores del snapshot');
      const strip = (r) => { const { product_or_model, source_ref, ...rest } = r; return rest; };
      eq(snap.map(strip), alias.map(strip), 'precio/versión/fechas/verified idénticos al alias');
      eq(snap.map((r) => [r.meter, r.unit_size, r.unit_price]), [['audio_output_tokens', '1000000', '12'], ['audio_seconds', '60', '0.015'], ['text_input_tokens', '1000000', '0.6']], 'precios exactos');
      assert(snap.every((r) => r.pricing_version === 'openai-tts-2026-09' && r.verified === false), 'versión y verified:false');
      assert(snap.every((r) => /alias gpt-4o-mini-tts/.test(r.source_ref) && /pinned snapshot/.test(r.source_ref)), 'source_ref explica que es el snapshot del alias');
      const keys = SEED.rows.map((r) => `${r.provider}|${r.service}|${r.product_or_model}|${r.meter}|${r.pricing_version}`);
      eq(new Set(keys).size, keys.length, 'sin filas duplicadas (on conflict do nothing no las pisaría)');
    });

    // ── (c) ───────────────────────────────────────────────────────────────────────────────────────
    await check('(c) priceUsage del snapshot (3 medidores) no lanza PRICING_MISSING y es igual al alias; un modelo sin filas sí lanza', () => {
      const usage = { text_input_tokens: 250, audio_output_tokens: 1250, audio_seconds: '31.250' };
      const s = F.priceUsage(usage, CATALOG, TTS_AT(SNAPSHOT));
      const a = F.priceUsage(usage, CATALOG, TTS_AT(ALIAS));
      eq(s.amount, a.amount, 'monto snapshot = alias');
      assert(Number(s.amount) > 0, `monto > 0 (${s.amount})`);
      let code = null;
      try { F.priceUsage({ audio_seconds: 10 }, CATALOG, TTS_AT('gpt-4o-mini-tts-1999-01-01')); } catch (e) { code = e.code; }
      eq(code, 'PRICING_MISSING', 'control: modelo sin precio');
    });
    await check('(c) reserva y liquidación del worker usan el MISMO modelo llamado (snapshot) y se valoran como el alias', async () => {
      const { Wd, it } = await runWelcome({ ...ENV });
      eq(it.status, 'completed', `completa (${it.error})`);
      const res = Wd.ledgerInputs.filter((x) => x.metadata && x.metadata.reservation);
      const fin = Wd.ledgerInputs.filter((x) => !(x.metadata && x.metadata.reservation));
      eq([res.length, fin.length], [1, 1], 'una reserva + un cargo final');
      eq([res[0].modelOrProduct, fin[0].modelOrProduct], [SNAPSHOT, SNAPSHOT], 'modelo de reserva y liquidación');
      assert(Wd.rows.find((r) => r.input === res[0]).settled, 'reserva liquidada');
      for (const [label, x] of [['reserva', res[0]], ['liquidación', fin[0]]]) {
        assert(Object.keys(x.usage).length > 0, `${label}: usage medido (${JSON.stringify(x.usage)})`);
        const s = F.priceUsage(x.usage, CATALOG, TTS_AT(x.modelOrProduct));
        const a = F.priceUsage(x.usage, CATALOG, TTS_AT(ALIAS));
        eq(s.amount, a.amount, `${label}: monto snapshot = alias`);
        assert(Number(s.amount) > 0, `${label}: monto > 0`);
      }
    });
    await check('(c) el guard de presupuesto (callCost) cobra el snapshot exactamente como el alias', async () => {
      const ds = { async query(sql) { if (/pricing_catalog/.test(sql)) return CATALOG; throw new Error(`query inesperada: ${sql.slice(0, 80)}`); } };
      const svc = new F.FinopsBudgetService(ds, {});
      const call = (product) => ({ provider: 'openai', service: 'audio.speech', product, usage: { audio_seconds: 117 } });
      eq(String(await svc.callCost(call(SNAPSHOT))), String(await svc.callCost(call(ALIAS))), 'callCost snapshot = alias');
    });

    // ── (d) ───────────────────────────────────────────────────────────────────────────────────────
    await check('(d) DYNAMIC_VIDEOGEN_TTS_MODEL_DEFAULT = snapshot; dynamicVideogenTtsModel: env no vacío pisa, vacío/espacios no', () => {
      eq(W.DYNAMIC_VIDEOGEN_TTS_MODEL_DEFAULT, SNAPSHOT, 'constante exportada');
      eq(W.dynamicVideogenTtsModel({}), SNAPSHOT, 'sin env');
      eq(W.dynamicVideogenTtsModel({ DYNAMIC_VIDEOGEN_TTS_MODEL: '' }), SNAPSHOT, 'vacío');
      eq(W.dynamicVideogenTtsModel({ DYNAMIC_VIDEOGEN_TTS_MODEL: '   ' }), SNAPSHOT, 'espacios');
      eq(W.dynamicVideogenTtsModel({ DYNAMIC_VIDEOGEN_TTS_MODEL: 'tts-1' }), 'tts-1', 'env pisa');
      // r60 (review I-2): el alias exacto vuelve al snapshot salvo OPENAI_TTS_ALLOW_ALIAS=true; OPENAI_TTS_MODEL no aplica acá.
      eq(W.dynamicVideogenTtsModel({ DYNAMIC_VIDEOGEN_TTS_MODEL: ALIAS }), SNAPSHOT, 'alias → snapshot');
      eq(W.dynamicVideogenTtsModel({ DYNAMIC_VIDEOGEN_TTS_MODEL: ALIAS, OPENAI_TTS_ALLOW_ALIAS: 'true' }), ALIAS, 'ALLOW_ALIAS=true');
      eq(W.dynamicVideogenTtsModel({ OPENAI_TTS_MODEL: 'tts-1' }), SNAPSHOT, 'OPENAI_TTS_MODEL no pisa el modelo de Videogen');
    });

    const OWNER = 'aa2fa9a1-afb1-4b01-8646-94a0cb272b57';
    const VENV = { DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_V2_ALLOWED_OWNERS: undefined, DYNAMIC_REAL_VIDEO_OWNERS: OWNER, VIDEOGEN_API_KEY: 'k', DYNAMIC_ALLOW_VIDEOGEN_DIRECT: 'true', DYNAMIC_VIDEO_DELIVERY: undefined };
    async function submitOnce() {
      const sent = [];
      const fails = [];
      const n = 5;
      const item = {
        itemRunId: `ir-${n}`, runId: 'run-1', courseId: 1, frontendCourseId: 'fc', artifactCourseId: 'fc',
        manifestId: 7, blueprintId: 3, blueprintNumber: 1, itemKey: `video:ch${n}`, type: 'video', rulesVersion: 2,
        moduleId: 'm1', chapterId: `ch${n}`, moduleNumber: 1, chapterNumber: n, idempotencyKey: `idem-${n}`,
        generation: 1, dependsOn: [`content:ch${n}`], attempt: 1, outputSummary: {},
        dependencyArtifacts: [{ type: 'dynamic_content_md', artifactId: `art-${n}` }],
        blueprint: { course: { title: 'Curso' }, chapter: { title: `Cap ${n}` } },
      };
      const deps = {
        scheduler: {
          heartbeatItem: async () => true,
          failItem: async (id, ex, error, retryable) => { fails.push({ error, retryable }); return true; },
          recordItemExternal: async () => true,
          completeItem: async () => true,
        },
        dataSource: {
          query: async (sql) => {
            if (/from public\.production_jobs/.test(sql)) return [{ owner_id: OWNER, video_mode: 'real', input_payload: { videoMode: 'real', videoDelivery: 'videogen_direct' } }];
            if (/from public\.generation_item_runs/.test(sql)) return [{ output_summary: {} }];
            throw new Error('query no esperada: ' + sql);
          },
        },
        artifacts: {
          getDownloadUrl: async () => ({ url: `data:text/plain;base64,${Buffer.from('# Capítulo\n\nTexto del capítulo.').toString('base64')}` }),
          uploadJsonArtifact: async (p) => ({ id: `a-${p.storagePath}` }),
        },
        videogen: {
          // Captura el payload y corta con un rechazo definitivo (4xx): sin envío "real", sin polling.
          batchCreate: async (jobs) => { sent.push(JSON.parse(JSON.stringify(jobs))); throw new Error('Videogen batch-create failed (HTTP 400): test r59'); },
          getVideoStatus: async () => { throw new Error('no debería pollear'); },
          getVideoCost: async () => ({ estimated_total_cost: 0 }),
        },
        logger: { log() {}, warn() {}, error() {}, debug() {} },
        executorId: 'exec-1', leaseSeconds: 60, heartbeatMs: 60_000, videoTimeoutMin: 1, videoPollMs: 1,
        budget: { guardPaidSubmission: async () => ({ allow: true, decision: 'ALLOW', committed: '0', remaining: null, reason: 'test_permissive', authorizedBudget: '999' }) },
      };
      await W.processItem(deps, item);
      return { sent, fails };
    }
    await check('(d) el batchCreate del worker dinámico envía external_metadata.tts_model = snapshot (sin tts_voice ni tts_provider)', () =>
      withEnv({ ...VENV, DYNAMIC_VIDEOGEN_TTS_MODEL: undefined }, async () => {
        const { sent, fails } = await submitOnce();
        eq(sent.length, 1, `un envío (fallos: ${JSON.stringify(fails)})`);
        eq(sent[0].length, 1, 'un video');
        eq(sent[0][0].external_metadata, { tts_model: SNAPSHOT }, 'external_metadata');
        assert(!('tts_voice' in sent[0][0]) && !('tts_provider' in sent[0][0]), 'sin tts_voice/tts_provider');
        assert(fails[0] && /^videogen_submit_rejected: /.test(fails[0].error), `rechazo definitivo del fake: ${JSON.stringify(fails)}`);
      }));
    await check('(d) DYNAMIC_VIDEOGEN_TTS_MODEL pisa el modelo enviado a Videogen; vacío vuelve al snapshot', () =>
      withEnv({ ...VENV, DYNAMIC_VIDEOGEN_TTS_MODEL: 'tts-1' }, async () => {
        const { sent } = await submitOnce();
        eq(sent[0][0].external_metadata, { tts_model: 'tts-1' }, 'env');
        await withEnv({ DYNAMIC_VIDEOGEN_TTS_MODEL: '' }, async () => {
          const r = await submitOnce();
          eq(r.sent[0][0].external_metadata, { tts_model: SNAPSHOT }, 'env vacío');
        });
      }));
    await check('(d) VideogenService.batchCreate serializa external_metadata tal cual en el body', () =>
      withEnv({ VIDEOGEN_API_KEY: 'k-fake', VIDEOGEN_API_URL: 'https://videogen.invalid' }, async () => {
        const realFetch = global.fetch;
        let body = null;
        global.fetch = async (url, init) => {
          assert(String(url) === 'https://videogen.invalid/api/external/videos/batch-create', `url ${url}`);
          body = JSON.parse(init.body);
          return new Response(JSON.stringify({ batch_id: 'b1', jobs: [{ job_id: 'j1', chapter_number: 1, status: 'queued' }] }), { status: 200 });
        };
        try {
          const v = { title: 'T', content_txt: 'c', chapter_number: 1, client_reference_id: 'idem', external_metadata: { tts_model: SNAPSHOT } };
          const r = await new VideogenService().batchCreate([v]);
          eq(body, { videos: [v] }, 'body');
          eq(r.batch_id, 'b1', 'respuesta');
        } finally {
          global.fetch = realFetch;
        }
      }));
  } finally {
    await fakes.close();
  }

  console.log(`\n${passes} OK, ${failures} fallos`);
  if (failures) {
    console.error('❌ r59b snapshot fijo del TTS roto.');
    process.exit(1);
  }
  console.log('✅ r59b OK (default + env, seed, precio de reserva/liquidación, external_metadata de Videogen).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
