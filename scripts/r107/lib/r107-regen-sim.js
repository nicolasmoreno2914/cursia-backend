/* eslint-disable */
// r107 B10 · proveedores SIMULADOS de la Fase 3 (Anthropic, OpenAI TTS, Gamma, Videogen, YouTube, pdftoppm, ffmpeg) y una
// compuerta en memoria con la MISMA regla que la del servicio (tope antes de cada llamada, `sent` antes de enviar,
// clasificación sent/charged/not_charged/not_sent/ambiguous). USD 0: nada sale de este proceso. Lo usan
// check-r107-regenerate.js (--ci) y check-r107-patch.js (--moodle M5).
'use strict';
const path = require('path');
const vm = require('vm');

/**
 * Bloquea TODA salida de red y los SDK de los proveedores; cuenta los intentos (el check falla si hay alguno).
 * Fix round 1 (P2-9): + `child_process` (exec/execFile/spawn/fork y sus *Sync con binarios que no sean este node),
 * undici (fetch/request/stream/Agent) y `globalThis.fetch`, y el SDK de OpenAI.
 */
function blockNetwork(tag) {
  const REAL = { anthropic: 0, openai: 0, fetch: 0, undici: 0, http: 0, net: 0, spawn: 0 };
  const sdk = require('@anthropic-ai/sdk');
  const Anthropic = sdk.default || sdk.Anthropic || sdk;
  const proto = (Anthropic.Messages || sdk.Messages) && (Anthropic.Messages || sdk.Messages).prototype;
  if (proto) proto.create = function () { REAL.anthropic++; throw new Error(`${tag}: llamada REAL a Anthropic bloqueada`); };
  // SDK de OpenAI (si está instalado): cualquier request del cliente base queda bloqueada.
  try {
    const oa = require('openai');
    const OpenAI = oa.default || oa.OpenAI || oa;
    const blockOa = function () { REAL.openai++; throw new Error(`${tag}: llamada REAL a OpenAI bloqueada`); };
    for (const P of [OpenAI && OpenAI.prototype, oa.APIClient && oa.APIClient.prototype].filter(Boolean)) {
      for (const k of ['request', 'makeRequest', 'post', 'get', 'fetchWithTimeout']) if (typeof P[k] === 'function') P[k] = blockOa;
    }
  } catch { /* sin el SDK de OpenAI instalado: nada que bloquear */ }
  const blockedFetch = async (u) => { REAL.fetch++; throw new Error(`${tag}: red bloqueada (${String(u && u.url ? u.url : u).slice(0, 80)})`); };
  global.fetch = blockedFetch;
  globalThis.fetch = blockedFetch;
  try {
    const undici = require('undici');
    for (const k of ['fetch', 'request', 'stream', 'pipeline', 'connect']) {
      if (typeof undici[k] === 'function') undici[k] = async function () { REAL.undici++; throw new Error(`${tag}: undici.${k} bloqueado`); };
    }
    if (undici.Agent && undici.Agent.prototype) undici.Agent.prototype.dispatch = function () { REAL.undici++; throw new Error(`${tag}: undici.Agent bloqueado`); };
    if (undici.Dispatcher && undici.Dispatcher.prototype) undici.Dispatcher.prototype.dispatch = function () { REAL.undici++; throw new Error(`${tag}: undici bloqueado`); };
  } catch { /* sin undici instalado */ }
  for (const m of ['http', 'https']) {
    const mod = require(m);
    mod.request = function () { REAL.http++; throw new Error(`${tag}: ${m}.request bloqueado`); };
    mod.get = function () { REAL.http++; throw new Error(`${tag}: ${m}.get bloqueado`); };
  }
  const net = require('net');
  net.connect = net.createConnection = function () { REAL.net++; throw new Error(`${tag}: net.connect bloqueado`); };
  require('tls').connect = function () { REAL.net++; throw new Error(`${tag}: tls.connect bloqueado`); };
  // child_process: solo se permite volver a lanzar ESTE node (p. ej. un harness hijo); ffmpeg, pdftoppm, curl, etc. no.
  const cp = require('child_process');
  const allowed = (cmd) => { const c = String(cmd || '').trim().split(/\s+/)[0]; return c === process.execPath || c === 'node'; };
  for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const orig = cp[k];
    if (typeof orig !== 'function') continue;
    cp[k] = function (cmd, ...rest) {
      if (k === 'fork' || !allowed(cmd)) { REAL.spawn++; throw new Error(`${tag}: child_process.${k}(${String(cmd).slice(0, 40)}) bloqueado con proveedores simulados`); }
      return orig.call(this, cmd, ...rest);
    };
  }
  return REAL;
}

const words = (s) => (String(s).match(/[\p{L}\p{N}]+/gu) || []).length;

/**
 * Proveedores simulados. `opts.fault` inyecta fallas: { gammaCreate: 'ambiguous'|'rejected', gammaPoll: 'timeout',
 * videogenRender: 'failed'|'timeout', ttsStatus: 429|502 (en la llamada N = opts.fault.ttsAt), scormRoom: 'invalid',
 * vintNoQuestions: true, narrationShort: chapter }.
 */
function simProviders(DIST, opts = {}) {
  const { createExecutorSandbox } = require(path.join(DIST, 'workers/llm-executor/executor-runtime.js'));
  const SM = require(path.join(DIST, 'package/v3/synthetic-media.js'));
  const sb = createExecutorSandbox({ api: async () => { throw { fatal: true, msg: 'sandbox del simulador' }; }, artifactText: async () => null, ownerId: 'sim', logger: { log() {}, warn() {}, error() {} } });
  const ctx = sb.ctx;
  const schemaOf = new Map(vm.runInContext('SCORM_V2_TEMPLATES.map(function(t){return t.id})', ctx).map((id) => [JSON.stringify(ctx.scormV2SchemaFor(id)), id]));
  const fixtures = JSON.parse(vm.runInContext('JSON.stringify(SV2_PREVIEW_FIXTURES)', ctx));
  const practiceSys = ctx.dynH5pActivitySys();
  const vintSys = ctx.dynVideoInteractionsSys();
  const fault = opts.fault || {};
  const calls = { anthropic: [], openai: [], gamma: [], videogen: [], youtube: [], raster: 0, transcode: 0 };
  const usage = (u, o) => ({ input_tokens: Math.ceil(u.length / 3.5) + 300, output_tokens: Math.max(50, Math.ceil(o.length / 3.5)) });
  const err = (status, msg) => Object.assign(new Error(msg), { status });
  const VIDEO_SEC = opts.videoSeconds || 468;
  const QBANK = [
    ['¿Qué paso del video ordena la idea principal del capítulo?', ['Revisar los datos del caso', 'Repetir la definición textual', 'Saltar al resultado final', 'Ignorar el contexto del cliente']],
    ['¿Qué conviene hacer antes de responder al cliente?', ['Escuchar y confirmar lo entendido', 'Ofrecer un descuento enseguida', 'Cambiar de tema con cortesía', 'Esperar a que repita la queja']],
    ['¿Cuál es el propósito del ejemplo del video?', ['Aplicar el concepto a un caso concreto', 'Memorizar una lista de términos', 'Comparar dos empresas reales', 'Calcular un promedio sin datos']],
  ];
  const llm = {
    async messages(req) {
      calls.anthropic.push({ system: req.system.slice(0, 80), maxTokens: req.maxTokens, schema: !!req.schema });
      if (fault.anthropic === 'ambiguous') throw err(null, 'sim: timeout de red');
      let text;
      if (req.schema && schemaOf.has(JSON.stringify(req.schema))) {
        const id = schemaOf.get(JSON.stringify(req.schema));
        text = fault.scormRoom === 'invalid' ? '{"scenario":"x"}' : JSON.stringify(fixtures[id]);
      } else if (req.system === practiceSys) {
        text = JSON.stringify(opts.practiceData || { title: 'Práctica del capítulo', questions: [
          { kind: 'multichoice', question: '¿Qué muestra una escucha activa con un cliente molesto?', answers: [{ text: 'Parafrasear lo que dijo el cliente', correct: true }, { text: 'Interrumpir para resolver rápido', correct: false }, { text: 'Mirar la pantalla mientras habla', correct: false }] },
          { kind: 'truefalse', question: 'Confirmar lo entendido reduce los malentendidos con el cliente.', correct: true },
          { kind: 'multichoice', question: '¿Qué conviene decir al cerrar la conversación?', answers: [{ text: 'El próximo paso acordado', correct: true }, { text: 'Una disculpa genérica sin plan', correct: false }, { text: 'Que vuelva a llamar otro día', correct: false }] },
        ] });
      } else if (req.system === vintSys) {
        const v2 = /reflexi/i.test(req.user) && /"reflections"/.test(req.user);
        const plan = ctx.dynPlanVideoCheckpoints(VIDEO_SEC, undefined); // mismo número de pausas con o sin escenas
        const cps = fault.vintNoQuestions ? [] : plan.checkpoints.map((c, i) => {
          if (i % 3 === 1) return { index: c.index, kind: 'truefalse', question: 'Confirmar lo entendido con el cliente evita malentendidos en la atención.', correct: i % 2 === 0, feedbackCorrect: 'Así es: revisa el ejemplo del video.', feedbackIncorrect: 'Revisa esta parte del video.' };
          const [q, a] = QBANK[i % QBANK.length];
          const k = i % 4;
          const answers = a.map((t, j) => ({ text: t, correct: j === 0 }));
          answers.push(answers.splice(0, 1)[0]); // la correcta no siempre primera
          if (k === 0) answers.reverse();
          return { index: c.index, kind: 'multichoice', question: q, answers, feedbackCorrect: 'Bien: es lo que muestra el video.', feedbackIncorrect: 'Revisa esta parte del video.' };
        });
        const out = { checkpoints: cps };
        if (v2) {
          const rp = ctx.dynPlanReflectionPauses(VIDEO_SEC, plan.checkpoints);
          out.reflections = rp.reflections.map((r) => ({ index: r.index, prompt: 'Piensa cómo aplicarías esta idea con un cliente de tu sector.', hint: 'Recuerda el ejemplo del video.' }));
        }
        text = JSON.stringify(out);
      } else if (/Adaptas para escuchar un bloque/.test(req.system)) {
        const m = /Texto del bloque \(\d+ palabras\):\n"""\n([\s\S]*?)\n"""/.exec(req.user);
        const chap = Number(/Capítulo (\d+) —/.exec(req.user)?.[1]);
        text = m ? m[1] : '';
        if (fault.narrationShort && fault.narrationShort === chap) text = text.split(/\s+/).slice(0, 5).join(' ');
      } else if (/CONTINUAR \(no repetir/.test(req.system) || /CONDENSAR/.test(req.system)) {
        text = fault.narrationShort ? 'Sigue.' : 'Continuación de la narración del bloque.';
      } else {
        throw new Error(`simulador: prompt de IA no reconocido (${req.system.slice(0, 60)})`);
      }
      return { text, messageId: `msg_sim_${calls.anthropic.length}`, model: req.model, usage: usage(req.user, text), stopReason: 'end_turn' };
    },
  };
  return {
    simulated: opts.simulated !== false,
    config: { llmModel: 'claude-sonnet-4-6', ttsModel: 'gpt-4o-mini-tts-2025-03-20', ttsVoice: 'marin', gammaThemeId: 'sim-theme', missing: [] },
    poll: { intervalMs: 1, timeoutMs: opts.pollTimeoutMs || 2000 },
    llm,
    tts: {
      async speech(req) {
        calls.openai.push({ chars: req.input.length });
        if (fault.ttsStatus && calls.openai.length === (fault.ttsAt || 1)) throw err(fault.ttsStatus, `sim: TTS HTTP ${fault.ttsStatus}`);
        return { audio: SM.syntheticMp3(Math.max(1, (words(req.input) / 150) * 60)), requestId: `req_sim_${calls.openai.length}` };
      },
    },
    gamma: {
      async createGeneration(body) {
        calls.gamma.push({ op: 'create', language: body.textOptions && body.textOptions.language, themeId: body.themeId });
        if (fault.gammaCreate === 'ambiguous') throw err(502, 'sim: Gamma 502');
        if (fault.gammaCreate === 'rejected') throw err(400, 'sim: Gamma 400');
        return 'gen_sim_1';
      },
      async getGeneration(id) {
        calls.gamma.push({ op: 'poll', id });
        const n = calls.gamma.filter((c) => c.op === 'poll').length;
        if (fault.gammaPoll === 'timeout') return { status: 'pending', gammaId: null, gammaUrl: null, exportUrl: null, creditsDeducted: null, creditsRemaining: null, error: null };
        // Fix round 1: errores TRANSITORIOS de la consulta (las primeras N) y esperas «pending» antes de terminar.
        if (fault.gammaPollErrors && n <= fault.gammaPollErrors) throw err(503, `sim: Gamma consulta 503 (#${n})`);
        if (opts.gammaPendingPolls && n <= opts.gammaPendingPolls) return { status: 'pending', gammaId: null, gammaUrl: null, exportUrl: null, creditsDeducted: null, creditsRemaining: null, error: null };
        const credits = fault.gammaNoCredits ? null : (opts.gammaCredits ?? 55);
        return { status: 'completed', gammaId: 'g1', gammaUrl: null, exportUrl: 'sim://gamma.pdf', creditsDeducted: credits, creditsRemaining: 945, error: null };
      },
      async download() { calls.gamma.push({ op: 'download' }); return SM.syntheticPdf(opts.slides || 10); },
    },
    videogen: {
      async create(payload) {
        calls.videogen.push({ op: 'create', chars: payload.content_txt.length, ref: payload.client_reference_id });
        if (fault.videogenCreate === 'ambiguous') throw err(504, 'sim: Videogen 504');
        return { jobId: opts.videogenJobId || 'vg_sim_1' };
      },
      async status(jobId) {
        calls.videogen.push({ op: 'status', jobId });
        const n = calls.videogen.filter((c) => c.op === 'status').length;
        if (fault.videogenPollErrors && n <= fault.videogenPollErrors) throw err(502, `sim: Videogen consulta 502 (#${n})`);
        if (opts.videogenPendingPolls && n <= opts.videogenPendingPolls) return { job_id: jobId, chapter_number: 1, status: 'processing' };
        if (fault.videogenRender === 'timeout') return { job_id: jobId, chapter_number: 1, status: 'processing' };
        if (fault.videogenRender === 'failed') return { job_id: jobId, chapter_number: 1, status: 'failed', error: 'sim render failed' };
        // Guion por escenas (lo que Videogen informa en el status): 8 escenas iguales con su narración.
        const scenes = opts.noScenes ? null : Array.from({ length: 8 }, (_, i) => ({ scene_order: i + 1, duration_seconds: VIDEO_SEC / 8, narration: `Escena ${i + 1}: el narrador explica una parte del capítulo con un ejemplo del servicio diario.` }));
        return { job_id: jobId, chapter_number: 1, status: 'completed', download_url: 'sim://video.mp4', duration_seconds: VIDEO_SEC, scenes };
      },
      async cost() { if (fault.videogenNoCost) return null; return opts.videogenCost ?? 0.94; },
      async download() { throw new Error('simulador: el video no se descarga (la duración viene en el status)'); },
    },
    youtube: {
      async ready() { return fault.youtube === 'disconnected' ? 'Tu cuenta no tiene YouTube conectado.' : null; },
      async upload(a) { calls.youtube.push({ url: a.videoUrl }); return { videoId: opts.youtubeId || 'SimVideo001' }; },
    },
    media: {
      rasterizer: { available: async () => fault.raster !== 'missing', firstPagePng: async () => { calls.raster++; if (fault.rasterFailOnce && calls.raster === 1) throw new Error('sim: pdftoppm falló'); return SM.syntheticCoverPng(1600, 900, '#0F766E'); } },
      transcoderAvailable: async () => fault.ffmpeg !== 'missing',
      transcode: async (mp3) => { calls.transcode++; return mp3; },
    },
    calls,
  };
}

/** Compuerta en memoria: la MISMA regla que WorkshopPlanService.regenGateFor (tope, sent antes, ambiguo = cota gastada). */
function memGate(DIST, opts = {}) {
  const { RegenError, PROVIDER_OVER_BOUND } = require(path.join(DIST, 'modules/course-workshop/regenerate/types.js'));
  const g = {
    stopReason: null,
    capUsd: Number(opts.capUsd ?? 100), spentUsd: 0, calls: [], charges: [],
    charge: { payer: '00000000-0000-4000-8000-0000000000aa', courseId: null, approvalId: '00000000-0000-4000-8000-00000000a0a0', sessionId: '00000000-0000-4000-8000-00000000c0c0', simulated: true },
    async begin(spec) {
      if (g.stopReason) throw new RegenError('over_bound', g.stopReason, { code: PROVIDER_OVER_BOUND });
      if (g.spentUsd + Number(spec.boundUsd) > g.capUsd + 1e-9) throw new RegenError('cap_reached', `tope alcanzado (gastado ${g.spentUsd.toFixed(4)} + cota ${spec.boundUsd} > ${g.capUsd})`);
      const rec = { id: `call-${g.calls.length + 1}`, provider: spec.provider, kind: `${spec.provider}:${spec.kind}`, boundUsd: spec.boundUsd, status: 'sent', externalId: null };
      g.calls.push(rec);
      return {
        id: rec.id,
        async accepted(ext) { rec.externalId = ext; },
        async charged(m) {
          rec.status = 'charged'; rec.costUsd = m.costUsd; g.spentUsd += Number(m.costUsd); if (m.charge) g.charges.push(m.charge); if (m.externalId) rec.externalId = m.externalId;
          // Misma regla que la compuerta del servicio (P1-2c): medido > cota → incidente, se cortan las llamadas que faltan.
          if (Number(m.costUsd) > Number(spec.boundUsd) + 1e-9) {
            rec.overBound = true;
            g.stopReason = `${PROVIDER_OVER_BOUND}: ${spec.provider} midió ${m.costUsd} > cota ${spec.boundUsd}`;
            throw new RegenError('over_bound', g.stopReason, { code: PROVIDER_OVER_BOUND });
          }
        },
        async failed(e, outcome) {
          rec.error = e && e.message ? e.message : String(e);
          rec.status = outcome;
          if (outcome === 'ambiguous') { g.spentUsd += Number(spec.boundUsd); return new RegenError('call_ambiguous', `${spec.provider}: resultado desconocido (no se reenvía)`); }
          if (outcome === 'not_sent') return new RegenError('not_sent', `${spec.provider}: no enviada`);
          return new RegenError('provider_rejected', `${spec.provider}: rechazada sin cobro`);
        },
      };
    },
    spent: () => g.spentUsd.toFixed(6),
  };
  return g;
}

module.exports = { blockNetwork, simProviders, memGate, words };
