/* eslint-disable */
// r58 (I1) — RECORD / REPLAY de las llamadas de IA del ejecutor, en el repo y con la MISMA receta de hash que los puntos
// de guardado del worker (src/workers/llm-executor/server-llm.ts: serverLlmRequestBody + serverLlmRequestHash). Un
// checkpoint pagado del servidor y una fixture de este archivo se identifican por el mismo hash del pedido.
//
// `createReplayApi(...)` devuelve un `api()` con el contrato de 04-api.js (texto; metaOut {stopReason, usage}; lanza
// {fatal, msg, status, code}). Modos:
//   - replay: la respuesta sale SOLO de las fixtures; un hash sin fixture → REPLAY_FIXTURE_MISSING (nunca cae a una
//     llamada real, nunca responde vacío).
//   - fake:   responde el LLM falso determinista del E2E (test/e2e-v2/llm-v3.js); nada se graba.
//   - record: igual que fake, y graba cada respuesta como fixture v1. En Fase A solo graba desde proveedores falsos o
//     simulados: un proveedor REAL exige CURSIA_ALLOW_REAL_PROVIDER_RECORD=1 y que NO sea un entorno de prueba (ver
//     assertRealRecordAllowed); este archivo además nunca construye un cliente de red (el proveedor real tendría que
//     inyectarse y corre igual bajo la barrera de red del driver).
// Formato de fixture v1: ver FIXTURE_FIELDS / makeFixture. Saneador: sanitizeText / sanitizeValue.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { networkBarrierActive } = require('./netguard');

const FIXTURE_VERSION = 1;
const FIXTURE_FILE_VERSION = 1;
const REPLAY_FIXTURE_MISSING = 'REPLAY_FIXTURE_MISSING';
const REAL_RECORD_REFUSED = 'REAL_PROVIDER_RECORD_REFUSED';
/** Mismo default que el worker (src/workers/dynamic-llm-worker.ts: DYNAMIC_LLM_WORKER_MODEL || …); el check lo compara. */
const SERVER_DEFAULT_MODEL = 'claude-sonnet-4-6';
const FIXED_CREATED_AT = '2026-01-01T00:00:00.000Z';
const FIXTURE_FIELDS = ['fixtureVersion', 'componentType', 'itemKey', 'callRole', 'contractVersion', 'provider', 'model', 'promptHash', 'requestHash', 'inputHash', 'sanitizedResponse', 'validatorVersion', 'provenance', 'synthetic', 'createdAt'];
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── saneador ───────────────────────────────────────────────────────────────
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED_TOKEN]'],
  [/((?:api[_-]?key|apikey|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, '$1[REDACTED]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]'],
  // Rutas de Storage del dueño (<owner uuid>/dynamic/…): el dueño no viaja en una fixture compartida.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/dynamic\/)/gi, '[OWNER]'],
];
const SECRET_KEYS = /^(api[_-]?key|apikey|x-api-key|token|access[_-]?token|refresh[_-]?token|secret|password|authorization|cookie|owner[_-]?id|ownerid|email)$/i;

/** Texto saneado + cuántos reemplazos hizo (la fixture lo declara). */
function sanitizeText(text) {
  let out = String(text);
  let n = 0;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, (...m) => { n++; return typeof rep === 'string' ? rep.replace('$1', m[1] || '') : rep; });
  return { text: out, redactions: n };
}

/** Objeto saneado (claves secretas → borradas; strings → sanitizeText). */
function sanitizeValue(v, acc = { redactions: 0 }) {
  if (typeof v === 'string') { const r = sanitizeText(v); acc.redactions += r.redactions; return r.text; }
  if (Array.isArray(v)) return v.map((x) => sanitizeValue(x, acc));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEYS.test(k)) { acc.redactions++; continue; }
      o[k] = sanitizeValue(x, acc);
    }
    return o;
  }
  return v;
}

// ── receta del pedido (la del servidor, compilada) ──────────────────────────
function serverLlm(distRoot) {
  return require(path.join(distRoot, 'workers/llm-executor/server-llm.js'));
}

/** Texto plano del mensaje del usuario (string o bloques de caché). */
function userText(body) {
  const c = body.messages && body.messages[0] && body.messages[0].content;
  return Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('') : String(c || '');
}

/** Hash del prompt (sistema + usuario en texto plano, sin modelo ni tope): identifica el prompt aunque cambie el modelo. */
function promptHashOf(body) {
  const sys = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? null);
  return sha256(`${sys}\u0000${userText(body)}`);
}

/** Huella canónica de la entrada de un item (claim sin lo que no entra a los prompts: intento, lease, ids del run). */
function inputHashOf(claim) {
  if (!claim) return null;
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) {
        if (['attempt', 'itemRunId', 'runId', 'idempotencyKey', 'outputSummary', 'leaseUntil', 'artifactId', 'storagePath'].includes(k)) continue;
        o[k] = strip(v[k]);
      }
      return o;
    }
    return v;
  };
  return sha256(JSON.stringify(strip(claim)));
}

/** Fixture v1 (todos los campos de FIXTURE_FIELDS, saneada). */
function makeFixture(f) {
  const acc = { redactions: 0 };
  const resp = sanitizeValue({ text: f.text, stopReason: f.stopReason ?? 'end_turn', usage: f.usage ?? null }, acc);
  const fx = {
    fixtureVersion: FIXTURE_VERSION,
    componentType: f.componentType ?? null,
    itemKey: f.itemKey ?? null,
    callRole: f.callRole ?? 'main',
    contractVersion: f.contractVersion ?? null,
    provider: f.provider,
    model: f.model ?? null,
    promptHash: f.promptHash ?? null,
    requestHash: f.requestHash,
    inputHash: f.inputHash ?? null,
    sanitizedResponse: { ...resp, redactions: acc.redactions },
    validatorVersion: f.validatorVersion ?? null,
    provenance: sanitizeValue(f.provenance ?? { source: 'unknown' }),
    synthetic: f.synthetic === true,
    createdAt: f.createdAt ?? FIXED_CREATED_AT,
  };
  const errs = validateFixture(fx);
  if (errs.length) throw new Error(`fixture v1 inválida: ${errs.join('; ')}`);
  return fx;
}

function validateFixture(fx) {
  const errs = [];
  if (!fx || typeof fx !== 'object') return ['no es un objeto'];
  for (const k of FIXTURE_FIELDS) if (!(k in fx)) errs.push(`falta ${k}`);
  if (fx.fixtureVersion !== FIXTURE_VERSION) errs.push(`fixtureVersion ${fx.fixtureVersion} ≠ ${FIXTURE_VERSION}`);
  if (!/^[0-9a-f]{64}$/.test(String(fx.requestHash))) errs.push('requestHash no es sha256');
  if (typeof fx.synthetic !== 'boolean') errs.push('synthetic no es booleano');
  if (!fx.sanitizedResponse || typeof fx.sanitizedResponse.text !== 'string' || !fx.sanitizedResponse.text) errs.push('sanitizedResponse.text vacío');
  if (!fx.provenance || typeof fx.provenance.source !== 'string') errs.push('provenance.source ausente');
  return errs;
}

/** Archivo de fixtures {fixtureFileVersion, synthetic, fixtures[]} → Map(requestHash → fixture). */
function loadFixtureFile(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return fixturesFromDoc(doc, file);
}
function fixturesFromDoc(doc, where = 'doc') {
  if (!doc || doc.fixtureFileVersion !== FIXTURE_FILE_VERSION || !Array.isArray(doc.fixtures)) throw new Error(`${where}: no es un archivo de fixtures v${FIXTURE_FILE_VERSION}`);
  const map = new Map();
  for (const fx of doc.fixtures) {
    const errs = validateFixture(fx);
    if (errs.length) throw new Error(`${where}: fixture ${fx && fx.requestHash}: ${errs.join('; ')}`);
    if (map.has(fx.requestHash)) throw new Error(`${where}: requestHash duplicado ${fx.requestHash}`);
    map.set(fx.requestHash, fx);
  }
  return map;
}
function fixtureDoc(fixtures, o = {}) {
  const list = [...fixtures].sort((a, b) => (a.itemKey || '').localeCompare(b.itemKey || '') || a.requestHash.localeCompare(b.requestHash));
  return { fixtureFileVersion: FIXTURE_FILE_VERSION, synthetic: list.every((f) => f.synthetic === true), ...(o.comment ? { _comment: o.comment } : {}), fixtures: list };
}

// ── guarda del modo record con proveedor real ───────────────────────────────
function isTestEnv(env = process.env) {
  return env.NODE_ENV === 'test' || !!env.E2E_NET_LOG || env.CURSIA_TEST === '1' || env.CURSIA_OFFLINE_DRIVER === '1' || networkBarrierActive();
}

/** Lanza salvo CURSIA_ALLOW_REAL_PROVIDER_RECORD=1 Y fuera de un entorno de prueba (Fase A: siempre rechaza en tests). */
function assertRealRecordAllowed(env = process.env) {
  if (env.CURSIA_ALLOW_REAL_PROVIDER_RECORD !== '1') {
    const e = new Error(`${REAL_RECORD_REFUSED}: grabar desde un proveedor REAL exige CURSIA_ALLOW_REAL_PROVIDER_RECORD=1 (Fase A: solo proveedores falsos/simulados)`);
    e.code = REAL_RECORD_REFUSED;
    throw e;
  }
  if (isTestEnv(env)) {
    const e = new Error(`${REAL_RECORD_REFUSED}: grabar desde un proveedor REAL nunca corre en un entorno de prueba ni bajo la barrera de red`);
    e.code = REAL_RECORD_REFUSED;
    throw e;
  }
}

// ── LLM falso del E2E como proveedor ───────────────────────────────────────
/**
 * Proveedor falso determinista (test/e2e-v2/llm.js + llm-v3.js + banco), con el estado de títulos → ids que el fake
 * necesita. `outline` = [{ id, title, chapters: [{ id, title }] }].
 */
function createFakeProvider(distRoot, outline, o = {}) {
  const E2E = path.resolve(__dirname, '..', '..', 'test', 'e2e-v2');
  const { createLlm } = require(path.join(E2E, 'llm.js'));
  const { createLlmV3 } = require(path.join(E2E, 'llm-v3.js'));
  const contract = require(path.join(distRoot, 'modules/course-shell/exam-bank.js'));
  const base = createLlm({ getFixtures: () => ({}), getSplit: () => ({ multichoice: 1, truefalse: 1, match: 1 }) });
  const llm = createLlmV3({ base, examBankContract: contract, ...(o.h5p2 ? { h5p2: o.h5p2 } : {}) });
  llm.st.courseId = o.courseId ?? 0;
  for (const m of outline) {
    llm.st.moduleByTitle.set(m.title, m.id);
    for (const c of m.chapters) { llm.st.chapterByTitle.set(c.title, c.id); llm.st.moduleOfChapter.set(c.id, m.id); }
  }
  return { name: 'fake-e2e-llm', real: false, respond: (body) => llm.respond(body), st: llm.st };
}

/**
 * api() de replay / fake / record.
 * @param {{ distRoot: string, mode: 'replay'|'fake'|'record', fixtures?: Map<string, any>, provider?: {name:string, real:boolean, respond(body):any},
 *           defaultModel?: string, onCall?: (c:any)=>void, record?: { componentType, itemKey, inputHash, validatorVersion, provenance, synthetic }, now?: string }} o
 */
function createReplayApi(o) {
  const mode = o.mode;
  if (!['replay', 'fake', 'record'].includes(mode)) throw new Error(`replayApi: modo desconocido ${mode}`);
  const S = serverLlm(o.distRoot);
  const fixtures = o.fixtures || new Map();
  const provider = o.provider || null;
  if (mode !== 'replay' && !provider) throw new Error(`replayApi: el modo ${mode} necesita un proveedor (falso/simulado)`);
  if (mode === 'record' && provider && provider.real) assertRealRecordAllowed();
  if (mode === 'fake' && provider && provider.real) throw new Error('replayApi: el modo fake no acepta un proveedor real');
  const recorded = [];
  const calls = [];
  const misses = [];
  const ctx = { record: o.record || {} };
  const api = async function api(system, user, maxTok, schema, model, metaOut, extraHeaders, cacheOpts) {
    const { body, model: useModel } = S.serverLlmRequestBody({ system, user, maxTok, schema, model, defaultModel: o.defaultModel || SERVER_DEFAULT_MODEL, cacheOpts });
    const requestHash = S.serverLlmRequestHash(body);
    const callRole = (extraHeaders && extraHeaders['x-cursia-call-role']) || 'main';
    const call = { requestHash, callRole, model: useModel, itemKey: ctx.record.itemKey || null, mode };
    calls.push(call);
    if (o.onCall) o.onCall(call);
    if (mode === 'replay') {
      const fx = fixtures.get(requestHash);
      if (!fx) {
        misses.push(call);
        const msg = `${REPLAY_FIXTURE_MISSING}:${requestHash} ${ctx.record.itemKey || '?'} ${callRole}`;
        throw { fatal: true, code: REPLAY_FIXTURE_MISSING, status: 0, msg };
      }
      call.hit = true;
      if (metaOut) { metaOut.stopReason = fx.sanitizedResponse.stopReason; metaOut.usage = { ...(fx.sanitizedResponse.usage || {}) }; metaOut.fromReplay = true; }
      return fx.sanitizedResponse.text;
    }
    const r = provider.respond(body);
    if (!r || r.httpStatus || typeof r.text !== 'string') {
      const st = (r && r.httpStatus) || 500;
      const msg = st === 400 ? '❌ Error al procesar la solicitud: ' + String(r && r.error).slice(0, 300) : `Error del servidor (${st}). Reintentando…`;
      throw { fatal: st === 400, status: st, msg };
    }
    const usage = { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: Math.ceil(r.text.length / 4) };
    if (metaOut) { metaOut.stopReason = 'end_turn'; metaOut.usage = { ...usage }; }
    if (mode === 'record') {
      recorded.push(makeFixture({
        componentType: ctx.record.componentType, itemKey: ctx.record.itemKey, callRole, contractVersion: null, provider: provider.name,
        model: useModel, promptHash: promptHashOf(body), requestHash, inputHash: ctx.record.inputHash ?? null, text: r.text, stopReason: 'end_turn', usage,
        validatorVersion: ctx.record.validatorVersion ?? null,
        provenance: { source: provider.real ? 'real_provider' : 'fake', provider: provider.name, ...(ctx.record.provenance || {}) },
        synthetic: !provider.real, createdAt: o.now || FIXED_CREATED_AT,
      }));
    }
    return r.text;
  };
  return {
    api,
    calls,
    misses,
    recorded,
    /** Contexto de grabación del item en curso (el driver lo cambia por item). */
    setItem(rec) { ctx.record = { ...(o.record || {}), ...rec }; },
  };
}

// ── conversor: checkpoints de llm-diagnostics → fixtures v1 ─────────────────
/**
 * Salida de GET admin/dynamic-runs/:runId/items/:itemKey/llm-diagnostics (LlmItemDiagnostics) → fixtures v1. Offline:
 * no lee la base ni Storage; los textos vienen en el JSON. `synthetic` = lo que declara el llamador (una muestra real
 * es synthetic:false y NUNCA se guarda en el repo).
 */
function fixturesFromDiagnostics(diag, o = {}) {
  if (!diag || !diag.claim || !Array.isArray(diag.checkpoints)) throw new Error('no es una salida de llm-diagnostics (claim + checkpoints)');
  const out = [];
  const skipped = [];
  for (const cp of diag.checkpoints) {
    if (!cp || !/^[0-9a-f]{64}$/.test(String(cp.hash)) || typeof cp.text !== 'string' || !cp.text || cp.error) { skipped.push({ hash: cp && cp.hash, reason: (cp && cp.error) || 'sin texto' }); continue; }
    out.push(makeFixture({
      componentType: diag.claim.type, itemKey: diag.itemKey, callRole: 'main', contractVersion: o.contractVersion ?? null,
      provider: o.provider || 'anthropic', model: o.model ?? null, promptHash: null, requestHash: cp.hash, inputHash: inputHashOf(diag.claim),
      text: cp.text, stopReason: cp.stopReason, usage: cp.usage,
      validatorVersion: o.validatorVersion ?? null,
      provenance: { source: 'llm_checkpoint', runIdHash: diag.runId ? sha256(String(diag.runId)).slice(0, 16) : null, checkpointAt: cp.at ?? null },
      synthetic: o.synthetic === true, createdAt: o.now || FIXED_CREATED_AT,
    }));
  }
  return { fixtures: out, skipped };
}

module.exports = {
  FIXTURE_VERSION, FIXTURE_FILE_VERSION, FIXTURE_FIELDS, REPLAY_FIXTURE_MISSING, REAL_RECORD_REFUSED, SERVER_DEFAULT_MODEL, FIXED_CREATED_AT,
  sanitizeText, sanitizeValue, makeFixture, validateFixture, loadFixtureFile, fixturesFromDoc, fixtureDoc, promptHashOf, inputHashOf,
  isTestEnv, assertRealRecordAllowed, createFakeProvider, createReplayApi, fixturesFromDiagnostics, sha256,
};
