#!/usr/bin/env node
/* eslint-disable */
// r60 Q-22 — las rutas TTS legacy (tts.service / audio-worker, las que usa el frontend V1 tras promover V2) ya no
// llaman al alias `gpt-4o-mini-tts`, que se colgaba (pruebas reales 2026-10-19: 5 de 11 llamadas 2–3 min, cobradas;
// el snapshot `gpt-4o-mini-tts-2025-03-20`, 0 de 13).
//
// Sin red y sin gasto: `fetch` global falso que captura el cuerpo enviado a OpenAI.
//   (a) resolveTtsModel: default = snapshot; alias exacto → snapshot (salvo OPENAI_TTS_ALLOW_ALIAS=true);
//       OPENAI_TTS_MODEL aplica sin modelo explícito; cualquier otro modelo se respeta;
//   (b) TtsService.synthesize envía a OpenAI el modelo resuelto y lo devuelve en result.model;
//   (c) el cargo del ledger (directTtsChargeInput con result.model) registra el modelo llamado de verdad, y
//       pricing-seed.v1 tiene filas audio.speech para el snapshot;
//   (d) guardas de fuente: sin default literal al alias en tts.service / audio-worker; una sola constante.
//
//   (V2 / Videogen: check-r59-tts-pinned-snapshot.js cubre el alias en real-providers y dynamicVideogenTtsModel.)
// Usage: node scripts/check-r60-tts-legacy-snapshot.js [path/to/dist]
const fs = require('fs');
const path = require('path');

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
const M = loadDist('tts/tts-models.js');
const { TtsService } = loadDist('tts/tts.service.js');
const DCL = loadDist('modules/finops/direct-call-ledger.js');
const RP = loadDist('workers/provider-real/real-providers.js');

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
const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_TTS_MODEL', 'OPENAI_TTS_ALLOW_ALIAS', 'OPENAI_TTS_VOICE'];
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.OPENAI_API_KEY = 'sk-r60-fake';
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

const SNAPSHOT = 'gpt-4o-mini-tts-2025-03-20';
const ALIAS = 'gpt-4o-mini-tts';

const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (!/api\.openai\.com\/v1\/audio\/speech/.test(String(url))) throw new Error(`r60 check: red inesperada a ${url}`);
  sent.push(JSON.parse(init.body));
  const buf = Buffer.from('fake-audio');
  return {
    ok: true, status: 200,
    headers: { get: (h) => (h.toLowerCase() === 'x-request-id' ? `req_r60_${sent.length}` : null) },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length); },
    async text() { return ''; },
  };
};

async function synth(opts) {
  const svc = new TtsService();
  const before = sent.length;
  const r = await svc.synthesize({ text: 'Hola, bienvenidos al curso.', format: 'opus', ...opts });
  assert(sent.length === before + 1, 'una sola llamada a OpenAI');
  return { r, body: sent[sent.length - 1] };
}

async function main() {
  await check('(a) resolveTtsModel: default snapshot; alias exacto → snapshot; ALLOW_ALIAS; env; otros modelos tal cual', () => {
    eq(M.TTS_SNAPSHOT_MODEL, SNAPSHOT, 'constante snapshot');
    eq(M.TTS_ALIAS_MODEL, ALIAS, 'constante alias');
    eq(M.resolveTtsModel(undefined, {}), { model: SNAPSHOT, requested: SNAPSHOT, normalized: false }, 'sin modelo ni env');
    eq(M.resolveTtsModel('  ', {}).model, SNAPSHOT, 'modelo vacío');
    eq(M.resolveTtsModel(ALIAS, {}), { model: SNAPSHOT, requested: ALIAS, normalized: true }, 'alias explícito (frontend V1)');
    eq(M.resolveTtsModel(` ${ALIAS} `, {}).model, SNAPSHOT, 'alias con espacios');
    eq(M.resolveTtsModel(ALIAS, { OPENAI_TTS_ALLOW_ALIAS: 'true' }), { model: ALIAS, requested: ALIAS, normalized: false }, 'ALLOW_ALIAS=true');
    eq(M.resolveTtsModel(ALIAS, { OPENAI_TTS_ALLOW_ALIAS: '1' }).model, SNAPSHOT, 'ALLOW_ALIAS solo con «true» exacto');
    eq(M.resolveTtsModel(undefined, { OPENAI_TTS_MODEL: 'tts-1' }).model, 'tts-1', 'OPENAI_TTS_MODEL sin modelo explícito');
    eq(M.resolveTtsModel('tts-1-hd', { OPENAI_TTS_MODEL: 'tts-1' }).model, 'tts-1-hd', 'modelo explícito gana a env');
    eq(M.resolveTtsModel(undefined, { OPENAI_TTS_MODEL: ALIAS }).model, SNAPSHOT, 'OPENAI_TTS_MODEL=alias también se normaliza');
    eq(M.resolveTtsModel('gpt-4o-mini-tts-2025-12-15', {}).model, 'gpt-4o-mini-tts-2025-12-15', 'otro snapshot fechado se respeta');
    eq(M.resolveTtsModel('GPT-4o-mini-tts', {}).model, 'GPT-4o-mini-tts', 'solo el alias EXACTO se normaliza');
  });

  await check('(b) TtsService.synthesize: el modelo enviado a OpenAI = result.model (snapshot por defecto y para el alias V1)', async () => {
    await withEnv({}, async () => {
      let { r, body } = await synth({});
      eq([body.model, r.model], [SNAPSHOT, SNAPSHOT], 'sin modelo');
      ({ r, body } = await synth({ model: ALIAS }));
      eq([body.model, r.model], [SNAPSHOT, SNAPSHOT], 'model: gpt-4o-mini-tts (frontend V1)');
      ({ r, body } = await synth({ model: 'tts-1' }));
      eq([body.model, r.model], ['tts-1', 'tts-1'], 'otro modelo explícito');
    });
    await withEnv({ OPENAI_TTS_MODEL: 'tts-1-hd' }, async () => {
      const { r, body } = await synth({});
      eq([body.model, r.model], ['tts-1-hd', 'tts-1-hd'], 'OPENAI_TTS_MODEL sin modelo explícito');
    });
    await withEnv({ OPENAI_TTS_MODEL: ALIAS }, async () => {
      const { r, body } = await synth({});
      eq([body.model, r.model], [SNAPSHOT, SNAPSHOT], 'OPENAI_TTS_MODEL=alias');
    });
    await withEnv({ OPENAI_TTS_ALLOW_ALIAS: 'true' }, async () => {
      const { r, body } = await synth({ model: ALIAS });
      eq([body.model, r.model], [ALIAS, ALIAS], 'ALLOW_ALIAS=true deja pasar el alias');
    });
  });

  await check('(c) el ledger registra el modelo llamado de verdad y el snapshot tiene precio en pricing-seed.v1', async () => {
    const { r } = await withEnv({}, () => synth({ model: ALIAS }));
    const input = DCL.directTtsChargeInput({
      ownerId: 'owner-r60', model: r.model, requestId: r.requestId, audioSeconds: 3.2, characters: r.chars,
      courseId: null, unattributedReason: 'legacy_tts_no_course', recordedBy: 'tts-speech', localCallId: 'local-r60',
    });
    eq([input.provider, input.service, input.modelOrProduct], ['openai', 'audio.speech', SNAPSHOT], 'cargo del ledger');
    // El controlador pasa result.model (no dto.model): guardia de fuente.
    const ctl = fs.readFileSync(path.join(REPO, 'src/tts/tts.controller.ts'), 'utf8');
    assert(/recordDirectTtsCall\([\s\S]{0,200}model:\s*result\.model/.test(ctl), 'tts.controller registra result.model');
    const seed = JSON.parse(fs.readFileSync(path.join(REPO, 'src/modules/finops/pricing-seed.v1.json'), 'utf8'));
    const rows = seed.rows.filter((x) => x.provider === 'openai' && x.service === 'audio.speech' && x.product_or_model === SNAPSHOT);
    assert(rows.length >= 1, `pricing-seed sin filas audio.speech para ${SNAPSHOT}`);
  });

  await check('(d) guardas de fuente: sin default literal al alias en las rutas legacy; una sola constante del snapshot', () => {
    const svc = fs.readFileSync(path.join(REPO, 'src/tts/tts.service.ts'), 'utf8');
    const aw = fs.readFileSync(path.join(REPO, 'src/workers/audio-worker.ts'), 'utf8');
    for (const [name, src] of [['tts.service.ts', svc], ['audio-worker.ts', aw]]) {
      assert(!/['"]gpt-4o-mini-tts['"]/.test(src), `${name} todavía nombra el alias literal`);
      assert(/resolveTtsModel\(/.test(src), `${name} no usa resolveTtsModel`);
    }
    eq(RP.TTS_MODEL_DEFAULT, M.TTS_SNAPSHOT_MODEL, 'real-providers TTS_MODEL_DEFAULT = TTS_SNAPSHOT_MODEL');
    // Review I-2: el camino V2 (bienvenida y audiolibro) usa la misma regla, sin leer OPENAI_TTS_MODEL a mano.
    const rp = fs.readFileSync(path.join(REPO, 'src/workers/provider-real/real-providers.ts'), 'utf8');
    assert(!/trimmed\(env,\s*'OPENAI_TTS_MODEL'\)/.test(rp), 'real-providers todavía lee OPENAI_TTS_MODEL sin resolveTtsModel');
    eq((rp.match(/resolveTtsModel\(undefined, env\)/g) || []).length, 2, 'bienvenida + audiolibro con resolveTtsModel');
  });

  global.fetch = realFetch;
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
