#!/usr/bin/env node
/* eslint-disable */
// r58 (I1) — RECORD / REPLAY de la IA del ejecutor (scripts/lib/replay-api.js) con la receta de hash del worker
// (server-llm.ts). Check puro contra dist/ (correr `npm run build` antes). Sin red (barrera del driver), sin IA real,
// sin DB, USD 0. Todas las fixtures y muestras son SINTÉTICAS (LLM falso del E2E; curso de scripts/fixtures/offline-driver).
//
//   RP1 fixtures sintéticas del repo (scripts/fixtures/replay/*.json): formato v1 completo, synthetic:true, sin secretos
//   RP2 la receta del replay ES la del worker: createServerApi responde desde su punto de guardado con el hash que
//       calcula el replay (mismo body ⇒ mismo hash) sin llamar a nada; el modelo por defecto = el del worker
//   RP3 replay hit: el driver en modo replay con las fixtures del repo reproduce la corrida falsa byte a byte, 0 fallos,
//       todas las llamadas desde fixtures
//   RP4 replay miss: sin la fixture → REPLAY_FIXTURE_MISSING (el item falla, nunca cae al falso ni responde vacío);
//       api() directo con fixtures vacías lanza {code: REPLAY_FIXTURE_MISSING, fatal: true}
//   RP5 saneador: claves (sk-ant/sk-/AKIA/AIza/gh*), Bearer, JWT, correos, apiKey=…, dueño de rutas → redactados; claves
//       secretas de objetos borradas; texto normal intacto
//   RP6 conversor (llm-diagnostics → fixtures v1) con una muestra SINTÉTICA: checkpoints válidos convertidos y saneados,
//       ilegibles omitidos, el replay con lo convertido acierta; una salida no sintética dentro del repo se rechaza
//   RP7 guarda del modo record con proveedor real: sin CURSIA_ALLOW_REAL_PROVIDER_RECORD=1 → rechazo; con =1 pero en
//       prueba (NODE_ENV=test / E2E_NET_LOG / barrera activa) → rechazo; el driver nunca acepta un proveedor real; el
//       modo fake rechaza un proveedor real
//
// Uso: node scripts/check-replay.js
'use strict';
require('reflect-metadata');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const R = require('./lib/replay-api');
const D = require('./lib/offline-driver');
const NG = require('./lib/netguard');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const FIX_DIR = path.join(__dirname, 'fixtures/replay');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/offline-driver/course.json'), 'utf8'));
const SEL = [{ type: 'activity', chapter: { m: 0, c: 0 } }];
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.error(`❌ ${name}\n   ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 5).join('\n   ')}`); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SECRETISH = /sk-ant-|\bsk-[A-Za-z0-9]{16}|AKIA[A-Z0-9]{16}|Bearer [A-Za-z0-9]{12}|eyJ[A-Za-z0-9_-]{8,}\.|@[A-Za-z0-9-]+\.[a-z]{2,}/;
const artifactShas = (r) => Object.fromEntries(Object.values(r.items).map((it) => [it.key, it.artifacts.map((a) => `${a.type}:${a.sha256}`)]));

(async () => {
  const files = fs.readdirSync(FIX_DIR).filter((f) => f.endsWith('.json')).sort();
  const repoFixtures = new Map();

  await check('RP1 fixtures sintéticas del repo: formato v1 completo, synthetic:true, sin secretos', async () => {
    assert(files.length >= 1, 'no hay fixtures en scripts/fixtures/replay/');
    for (const f of files) {
      const raw = fs.readFileSync(path.join(FIX_DIR, f), 'utf8');
      const doc = JSON.parse(raw);
      assert(doc.synthetic === true, `${f}: el archivo no es sintético`);
      const map = R.fixturesFromDoc(doc, f);
      for (const fx of map.values()) {
        for (const k of R.FIXTURE_FIELDS) assert(k in fx, `${f}: falta ${k}`);
        repoFixtures.set(fx.requestHash, fx);
        assert(fx.synthetic === true && fx.provenance.source === 'fake', `${f}: fixture no sintética ${fx.requestHash}`);
        assert(fx.componentType && fx.model && /^[0-9a-f]{64}$/.test(fx.promptHash) && /^[0-9a-f]{64}$/.test(fx.inputHash) && fx.validatorVersion, `${f}: metadatos incompletos en ${fx.requestHash}`);
        assert(fx.contractVersion === null || typeof fx.contractVersion === 'string', `${f}: contractVersion inválido en ${fx.requestHash}`);
      }
      assert(!SECRETISH.test(raw), `${f}: parece contener un secreto o correo`);
    }
  });

  await check('RP2 la receta del replay es la del worker (createServerApi responde desde el checkpoint con ese hash); modelo por defecto = worker', async () => {
    const S = require(path.join(DIST, 'workers/llm-executor/server-llm.js'));
    const calls = [];
    const replay = R.createReplayApi({ distRoot: DIST, mode: 'replay', fixtures: new Map() });
    const cases = [
      ['Sistema A', 'Usuario A', 4000, null, undefined, undefined],
      ['Sistema B', 'PREFIJO común. Resto del mensaje', 12000, { type: 'object', properties: { a: { type: 'string' } } }, 'claude-opus-4-8', { cachePrefix: 'PREFIJO común.' }],
      [[{ type: 'text', text: 'sistema en bloques' }], 'u', 99999, null, undefined, undefined],
    ];
    for (const [sys, user, maxTok, schema, model, cacheOpts] of cases) {
      // Hash del replay (lo captura el miss).
      let missHash = null;
      try { await replay.api(sys, user, maxTok, schema, model, {}, {}, cacheOpts); } catch (e) { missHash = (/REPLAY_FIXTURE_MISSING:([0-9a-f]{64})/.exec(e.msg || '') || [])[1]; }
      assert(missHash, 'el replay no informó el hash del pedido');
      // El worker con un checkpoint guardado bajo ESE hash responde sin red ni ledger.
      const ds = { query: async (sql) => { calls.push(sql); if (/output_summary->'llmCheckpoints'/.test(sql)) return [{ since: new Date(0), cps: { [missHash]: { path: 'p', at: new Date().toISOString() } } }]; throw new Error('consulta inesperada: ' + sql.slice(0, 60)); } };
      const api = S.createServerApi({
        dataSource: ds, finops: null, budget: { guardServerLlmCall: async () => { throw new Error('no debía llegar al guard'); } },
        checkpoints: { put: async () => { throw new Error('no debía guardar'); }, get: async () => JSON.stringify({ text: 'DESDE-CHECKPOINT', usage: { input_tokens: 1, output_tokens: 1 }, stopReason: 'end_turn' }) },
        recordCheckpoint: async () => true, apiKey: 'x', baseUrl: 'http://127.0.0.1:9', defaultModel: R.SERVER_DEFAULT_MODEL, idleMs: 1000, totalMs: 1000,
        fetchImpl: async () => { throw new Error('no debía llamar'); }, logger: { log() {}, warn() {}, error() {} },
      }, { itemRunId: 'ir', runId: 'run', itemKey: 'k', attempt: 1, generation: 1, ownerId: 'o', artifactCourseId: 'c', manifestId: 1 }, () => ({ callRole: 'main', attempt: 1 }));
      const meta = {};
      const text = await api(sys, user, maxTok, schema, model, meta, {}, cacheOpts);
      assert(text === 'DESDE-CHECKPOINT' && meta.fromCheckpoint === true, `el worker no reconoció el hash del replay (${missHash.slice(0, 12)})`);
      const { body } = S.serverLlmRequestBody({ system: sys, user, maxTok, schema, model, defaultModel: R.SERVER_DEFAULT_MODEL, cacheOpts });
      assert(S.serverLlmRequestHash(body) === missHash && sha(JSON.stringify(body)) === missHash, 'serverLlmRequestHash ≠ sha256(JSON(body))');
    }
    const src = fs.readFileSync(path.join(ROOT, 'src/workers/dynamic-llm-worker.ts'), 'utf8');
    const m = /DYNAMIC_LLM_WORKER_MODEL \|\| '([^']+)'/.exec(src);
    assert(m && m[1] === R.SERVER_DEFAULT_MODEL, `modelo por defecto del worker (${m && m[1]}) ≠ replay (${R.SERVER_DEFAULT_MODEL})`);
  });

  let fakeRun = null;
  await check('RP3 replay hit: las fixtures del repo reproducen la corrida falsa byte a byte, todas las llamadas desde fixtures', async () => {
    fakeRun = await D.runComponents(DIST, CFG, { select: SEL, llm: { mode: 'fake' } });
    assert(fakeRun.ok, `corrida falsa: ${JSON.stringify(fakeRun.errors.slice(0, 2))}`);
    const r = await D.runComponents(DIST, CFG, { select: SEL, llm: { mode: 'replay', fixtures: repoFixtures } });
    if (!r.ok && r.errors.some((e) => e.code === R.REPLAY_FIXTURE_MISSING)) throw new Error(`fixtures del repo desactualizadas (cambiaron los prompts): re-grabar con node scripts/record-replay-fixtures.js — ${r.errors[0].message}`);
    assert(r.ok, `replay: ${JSON.stringify(r.errors.slice(0, 2))}`);
    assert(r.llm.mode === 'replay' && r.llm.provider === 'replay' && r.llm.misses === 0 && r.llm.calls === fakeRun.llm.calls && r.llm.calls === repoFixtures.size, `llamadas replay ${r.llm.calls} / falsas ${fakeRun.llm.calls} / fixtures ${repoFixtures.size}`);
    assert(JSON.stringify(artifactShas(r)) === JSON.stringify(artifactShas(fakeRun)), 'el replay no reproduce los artifacts de la corrida falsa');
    assert(Object.values(r.items).filter((i) => i.type !== 'presentation').every((i) => i.source === 'replay' || i.source === 'provider_mock'), 'algún item no salió del replay');
  });

  await check('RP4 replay miss → REPLAY_FIXTURE_MISSING (falla visible, sin caer al falso); api() directo lanza el código', async () => {
    const partial = new Map([...repoFixtures].filter(([, fx]) => fx.componentType !== 'activity' || fx.callRole !== 'main'));
    assert(partial.size === repoFixtures.size - 1, 'la muestra debía quitar exactamente una fixture');
    const r = await D.runComponents(DIST, CFG, { select: SEL, llm: { mode: 'replay', fixtures: partial } });
    assert(!r.ok, 'la corrida debía fallar');
    const e = r.errors.find((x) => x.code === R.REPLAY_FIXTURE_MISSING);
    assert(e && /activity:/.test(e.itemKey), `sin REPLAY_FIXTURE_MISSING del activity: ${JSON.stringify(r.errors)}`);
    const act = Object.values(r.items).find((i) => i.type === 'activity');
    assert(act.status === 'failed' && act.artifacts.length === 0, 'el activity no debía completarse');
    const api = R.createReplayApi({ distRoot: DIST, mode: 'replay', fixtures: new Map() }).api;
    let err = null;
    try { await api('s', 'u'); } catch (x) { err = x; }
    assert(err && err.code === R.REPLAY_FIXTURE_MISSING && err.fatal === true && /^REPLAY_FIXTURE_MISSING:[0-9a-f]{64} /.test(err.msg), `api() directo: ${JSON.stringify(err)}`);
    let noProv = null;
    try { R.createReplayApi({ distRoot: DIST, mode: 'fake' }); } catch (x) { noProv = x; }
    assert(noProv, 'el modo fake sin proveedor debía rechazarse');
  });

  await check('RP5 saneador: claves, tokens, JWT, correos, apiKey=…, dueño de rutas → redactados; texto normal intacto', async () => {
    const owner = '3f2a1b4c-1111-4222-8333-444455556666';
    const dirty = [
      'clave sk-ant-api03-AbCdEfGhIjKlMnOp y otra sk-proj-ABCDEFGHIJKLMNOPQRST',
      'aws AKIAABCDEFGHIJKLMNOP google AIzaSyA1234567890abcdefghijklmnopqrstu gh ghp_abcdefghijklmnopqrstuvwx',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'contacto docente.ejemplo@institucion-ficticia.edu',
      '{"apiKey": "abcdef123456", "token":"zzzzzzzzzz"}',
      `ruta ${owner}/dynamic/9781/1/llm-checkpoints/x.json`,
    ].join('\n');
    const r = R.sanitizeText(dirty);
    assert(!SECRETISH.test(r.text) && !r.text.includes('abcdef123456') && !r.text.includes('zzzzzzzzzz') && !r.text.includes(owner), `quedó algo sin sanear:\n${r.text}`);
    assert(r.redactions >= 10, `pocas redacciones: ${r.redactions}`);
    assert(r.text.includes('[OWNER]/dynamic/9781/'), 'la ruta debía conservar su forma con el dueño redactado');
    const clean = 'El punto de equilibrio se calcula con costos fijos y margen de contribución (3 pasos).';
    assert(R.sanitizeText(clean).text === clean && R.sanitizeText(clean).redactions === 0, 'el texto normal cambió');
    const acc = { redactions: 0 };
    const o = R.sanitizeValue({ apiKey: 'x', Authorization: 'y', ownerId: owner, nested: { email: 'a@b.cl', text: 'ok' } }, acc);
    assert(JSON.stringify(o) === JSON.stringify({ nested: { text: 'ok' } }) && acc.redactions === 4, `objeto mal saneado: ${JSON.stringify(o)}`);
    const fx = R.makeFixture({ componentType: 'content', provider: 'fake', requestHash: 'a'.repeat(64), text: 'escribe a soporte@ejemplo-ficticio.com', provenance: { source: 'fake', ownerId: owner }, synthetic: true });
    assert(!/@/.test(fx.sanitizedResponse.text) && fx.sanitizedResponse.redactions === 1 && !('ownerId' in fx.provenance), 'makeFixture no sanea respuesta + procedencia');
  });

  await check('RP6 conversor llm-diagnostics → fixtures v1 (muestra SINTÉTICA): convertidos y saneados, ilegibles omitidos, el replay acierta; real en el repo → rechazo', async () => {
    const { convertFile } = require('./convert-llm-checkpoints-to-fixtures');
    assert(fakeRun, 'falta la corrida falsa de RP3');
    // Muestra sintética con la forma de LlmItemDiagnostics: el claim del activity + sus «checkpoints» (respuestas del falso).
    const rec = await D.runComponents(DIST, CFG, { select: SEL, llm: { mode: 'record' }, keepClaims: true });
    assert(rec.ok, 'grabación');
    const actKey = Object.keys(rec.items).find((k) => k.startsWith('activity:'));
    const actFx = rec.llm.recorded.filter((f) => f.itemKey === actKey);
    const diag = {
      runId: rec.runId, itemKey: actKey, itemRunId: rec.items[actKey].itemRunId, status: 'completed', attemptCount: 1, maxAttempts: 3,
      claim: rec.items[actKey].claim,
      checkpoints: [
        ...actFx.map((f, i) => ({ hash: f.requestHash, at: `2026-01-01T00:00:0${i}.000Z`, text: i === 0 ? `${f.sanitizedResponse.text}` : f.sanitizedResponse.text, usage: f.sanitizedResponse.usage, stopReason: 'end_turn' })),
        { hash: 'b'.repeat(64), at: null, text: null, usage: null, stopReason: null, error: 'ilegible: muestra' },
      ],
      truncated: false,
    };
    // Un correo inyectado en una respuesta extra (no usada por el replay) prueba el saneador del conversor.
    diag.checkpoints.push({ hash: 'c'.repeat(64), at: null, text: 'respuesta con correo profe@ejemplo-ficticio.org', usage: null, stopReason: 'end_turn' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-replay-'));
    try {
      const inF = path.join(tmp, 'diag.json');
      fs.writeFileSync(inF, JSON.stringify(diag));
      const out = path.join(tmp, 'fixtures.json');
      const res = convertFile(inF, out, { synthetic: true, model: R.SERVER_DEFAULT_MODEL, contract: 'muestra' });
      assert(res.fixtures === actFx.length + 1 && res.skipped.length === 1 && res.synthetic === true, `conversión: ${JSON.stringify(res)}`);
      const map = R.loadFixtureFile(out);
      const extra = map.get('c'.repeat(64));
      assert(extra && !/@/.test(extra.sanitizedResponse.text) && extra.provenance.source === 'llm_checkpoint' && /^[0-9a-f]{16}$/.test(extra.provenance.runIdHash), 'fixture convertida sin sanear o sin procedencia');
      assert([...map.values()].every((f) => f.inputHash === R.inputHashOf(diag.claim) && f.componentType === 'activity'), 'inputHash/componentType del conversor');
      // Replay: deps de la grabación + lo convertido (en vez de las fixtures del activity).
      const fixtures = new Map([...rec.llm.recorded.filter((f) => f.itemKey !== actKey).map((f) => [f.requestHash, f]), ...map]);
      const r = await D.runComponents(DIST, CFG, { select: SEL, llm: { mode: 'replay', fixtures } });
      assert(r.ok && r.llm.misses === 0, `replay con lo convertido: ${JSON.stringify(r.errors.slice(0, 2))}`);
      assert(JSON.stringify(artifactShas(r)) === JSON.stringify(artifactShas(fakeRun)), 'el replay con lo convertido no reproduce la corrida');
      // Respuestas reales (synthetic:false) dentro de scripts/fixtures/replay/ → rechazo (nunca se versionan).
      let err = null;
      try { convertFile(inF, path.join(FIX_DIR, 'nunca-real.json'), { synthetic: false }); } catch (e) { err = e; }
      assert(err && /REAL_FIXTURE_IN_REPO/.test(err.message) && !fs.existsSync(path.join(FIX_DIR, 'nunca-real.json')), 'el conversor debía rechazar respuestas reales en el repo');
      // Entrada que no es llm-diagnostics → error claro.
      fs.writeFileSync(inF, JSON.stringify({ hola: 1 }));
      let e2 = null;
      try { convertFile(inF, out, { synthetic: true }); } catch (e) { e2 = e; }
      assert(e2 && /llm-diagnostics/.test(e2.message), 'entrada inválida sin error claro');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  await check('RP7 guarda del record con proveedor real: sin permiso o en prueba → REAL_PROVIDER_RECORD_REFUSED; el driver nunca lo acepta', async () => {
    const refused = (fn) => { try { fn(); return false; } catch (e) { return e.code === R.REAL_RECORD_REFUSED; } };
    assert(refused(() => R.assertRealRecordAllowed({})), 'sin la variable debía rechazar');
    assert(refused(() => R.assertRealRecordAllowed({ CURSIA_ALLOW_REAL_PROVIDER_RECORD: 'true' })), 'solo =1 habilita');
    assert(refused(() => R.assertRealRecordAllowed({ CURSIA_ALLOW_REAL_PROVIDER_RECORD: '1', NODE_ENV: 'test' })), 'NODE_ENV=test debía rechazar');
    assert(refused(() => R.assertRealRecordAllowed({ CURSIA_ALLOW_REAL_PROVIDER_RECORD: '1', E2E_NET_LOG: '/tmp/x' })), 'E2E_NET_LOG debía rechazar');
    assert(refused(() => R.assertRealRecordAllowed({ CURSIA_ALLOW_REAL_PROVIDER_RECORD: '1', CURSIA_OFFLINE_DRIVER: '1' })), 'CURSIA_OFFLINE_DRIVER debía rechazar');
    const b = NG.installNetworkBarrier();
    try { assert(refused(() => R.assertRealRecordAllowed({ CURSIA_ALLOW_REAL_PROVIDER_RECORD: '1' })), 'con la barrera activa debía rechazar'); } finally { b.uninstall(); }
    let ok = true;
    try { R.assertRealRecordAllowed({ CURSIA_ALLOW_REAL_PROVIDER_RECORD: '1' }); } catch (e) { ok = false; }
    assert(ok, 'con =1 y fuera de prueba la guarda debía permitir (la llamada real igual necesitaría un proveedor inyectado)');
    const real = { name: 'real-provider', real: true, respond: () => { throw new Error('nunca debía llamarse'); } };
    assert(refused(() => R.createReplayApi({ distRoot: DIST, mode: 'record', provider: real })), 'record con proveedor real (sin permiso) debía rechazar');
    let fakeErr = null;
    try { R.createReplayApi({ distRoot: DIST, mode: 'fake', provider: real }); } catch (e) { fakeErr = e; }
    assert(fakeErr, 'el modo fake debía rechazar un proveedor real');
    const prev = process.env.CURSIA_ALLOW_REAL_PROVIDER_RECORD;
    process.env.CURSIA_ALLOW_REAL_PROVIDER_RECORD = '1';
    try {
      let dErr = null;
      try { await D.runComponents(DIST, CFG, { select: SEL, llm: { mode: 'record', provider: real } }); } catch (e) { dErr = e; }
      assert(dErr && dErr.code === R.REAL_RECORD_REFUSED, `el driver debía rechazar un proveedor real aun con =1 (vino ${dErr && dErr.message})`);
    } finally { if (prev === undefined) delete process.env.CURSIA_ALLOW_REAL_PROVIDER_RECORD; else process.env.CURSIA_ALLOW_REAL_PROVIDER_RECORD = prev; }
  });

  console.log(`\n${passed} ok, ${failed} fallos`);
  process.exit(failed ? 1 : 0);
})();
