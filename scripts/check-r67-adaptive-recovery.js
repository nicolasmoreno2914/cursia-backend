#!/usr/bin/env node
/* eslint-disable */
// r67 (Tarea A + escenarios de la Tarea C que le corresponden) — recuperación ADAPTATIVA, persistente, segura e
// idempotente del audiolibro y del scheduler. USD 0: proveedores FALSOS en 127.0.0.1 (test/e2e-v2/fakes.js), un
// `ffmpeg` FALSO en el PATH (transcode / atempo / silencedetect+astats deterministas, controlables por escenario) y PG16
// descartable. Correr con netguard: NODE_OPTIONS=--require test/e2e-v2/netguard.js. Contra dist/ (npm run build).
//
// Escenarios (SPEC r67 §C, los de A): 1 audio demasiado rápido (176 / 181,06 / 186,5 / 200 ppm); 2 corregible localmente
// (USD 0, sin OpenAI); 3 necesita nueva síntesis (factor fuera de límites o integridad fallida → instructions → split);
// 9 reinicio del worker (lease vencida → otro worker retoma, sin repagar); 10 run `failed` con recuperación elegible
// (auto-heal reabre, run → queued); 11 dependencia bloqueada que se desbloquea; 12 presupuesto agotado (sin llamada);
// 13 reserva ambigua (sin ronda ni llamada; waiting_financial_reconciliation); 14 dos workers / dos barridos (uno actúa);
// 15 límite de intentos / de tiempo → failed_no_strategies + attention unrecoverable. Además: archivos inválidos /
// truncados / duración incorrecta, sin ffmpeg (PATH e inyección), silencio interno, clipping, determinismo del retime,
// original nunca destruido, reanudación desde segmentos guardados (R1-bis: seg-0/seg-1 nunca se re-sintetizan) e
// invariante «sin huérfanos» (todo failed tiene next_retry_at o attention_reason) después de cada camino terminal.
//
// Usage: node scripts/check-r67-adaptive-recovery.js [--pure-only] [path/to/dist]
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
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const AUD = loadDist('package/audio/index.js');
const AH = loadDist('modules/dynamic-generation/auto-heal.js');
const FC = loadDist('modules/reliability/failure-classifier.js');
const RS = loadDist('modules/reliability/recovery-state.js');
const RT = loadDist('tts/audio-retime.js');
const IT = loadDist('modules/dynamic-generation/item-transitions.js');
const IRV = loadDist('modules/dynamic-generation/item-recovery-view.js');
const PW = loadDist('workers/dynamic-provider-worker.js');
const LR = loadDist('modules/dynamic-generation/lost-result.js');
const F = loadDist('modules/finops/index.js');
const SM = loadDist('package/v3/synthetic-media.js');
const { startStorage, startProviderFakes } = require(path.join(REPO, 'test/e2e-v2/fakes.js'));

const SECRETS = {
  GAMMA_API_KEY: 'sk-r67-gamma-SECRET-1a2b3c', OPENAI_API_KEY: 'sk-r67-openai-SECRET-4d5e6f',
  ANTHROPIC_API_KEY: 'sk-r67-anthropic-SECRET-7a8b9c', VIDEOGEN_API_KEY: 'sk-r67-videogen-SECRET-0d1e2f',
};
const LOGS = [];
const capLogger = { log: (m) => LOGS.push(String(m)), warn: (m) => LOGS.push(String(m)), error: (m) => LOGS.push(String(m)) };
Logger.overrideLogger({ log: capLogger.log, warn: capLogger.warn, error: capLogger.error, debug: () => {}, verbose: () => {} });

let passes = 0;
let failures = 0;
const RESULTS = [];
async function check(name, fn) {
  try {
    await fn();
    passes++;
    RESULTS.push(['ok', name]);
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    RESULTS.push(['fail', name]);
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.stack ? err.stack.split('\n').slice(0, 7).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`);
}
async function rejectsRe(p, re, msg) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${msg}: no lanzó`);
  const text = err.message + ' ' + JSON.stringify(err.getResponse ? err.getResponse() : '');
  assert(re.test(text), `${msg}: mensaje inesperado "${text.slice(0, 600)}"`);
  return err;
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const norm = (t) => String(t || '').trim().replace(/\s+/g, ' ');

// ─── MP3 falso NO silencioso (MPEG-2 L3, 24 kHz, mono; 3·kbps bytes / 576 muestras), sembrado por el texto ───────
const FRAME_SECONDS = 576 / 24000;
const BR_INDEX = { 8: 1, 16: 2, 24: 3, 32: 4, 40: 5, 48: 6, 56: 7, 64: 8 };
function fakeMp3Frames(frames, kbps, seedText) {
  const len = 3 * kbps;
  const buf = Buffer.alloc(frames * len);
  let x = parseInt(sha256(`${seedText}|${frames}`).slice(0, 8), 16) || 1;
  for (let f = 0; f < frames; f++) {
    const o = f * len;
    buf[o] = 0xff; buf[o + 1] = 0xf3; buf[o + 2] = (BR_INDEX[kbps] << 4) | 0x04; buf[o + 3] = 0xc0;
    for (let i = 4; i < len; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; buf[o + i] = ((x >>> 16) & 0xff) | 0x01; }
  }
  return buf;
}
const makeMp3 = (secs, text) => fakeMp3Frames(Math.max(1, Math.round(secs / FRAME_SECONDS)), 64, text || '');

// ─── ffmpeg FALSO en el PATH (determinista): transcode (-b:a), atempo (-af atempo=F) y análisis (silencedetect+astats) ──
// Control por escenario en $STATE/ctl.json {mode: ok|silence|clip|truncate|garbage}. Registra args y salidas en $STATE.
const FAKE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r67-ffmpeg-'));
const FF_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r67-ffstate-'));
fs.writeFileSync(path.join(FAKE_BIN, 'ffmpeg'), `#!${process.execPath}
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ST = ${JSON.stringify(FF_STATE)};
const args = process.argv.slice(2);
const ctl = (() => { try { return JSON.parse(fs.readFileSync(path.join(ST, 'ctl.json'), 'utf8')); } catch { return { mode: 'ok' }; } })();
const IDX = ${JSON.stringify(BR_INDEX)};
const TBL = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const inp = Buffer.concat(chunks);
  const h = crypto.createHash('sha256').update(inp).digest('hex');
  let o = 0; let frames = 0;
  while (o + 4 <= inp.length && inp[o] === 0xff) { const kb = TBL[(inp[o + 2] >> 4) & 15]; if (!kb) break; o += 3 * kb + ((inp[o + 2] >> 1) & 1); frames++; }
  const listFile = path.join(ST, 'retimed.json');
  const retimed = (() => { try { return JSON.parse(fs.readFileSync(listFile, 'utf8')); } catch { return []; } })();
  if (args.some((a) => /silencedetect/.test(a))) {
    const isRet = retimed.includes(h);
    let err = '';
    if (isRet && ctl.mode === 'silence') err += '[silencedetect @ 0x1] silence_start: 10.5\\n[silencedetect @ 0x1] silence_end: 14 | silence_duration: 3.5\\n';
    err += '[Parsed_astats_1 @ 0x2] Overall\\n[Parsed_astats_1 @ 0x2] Peak level dB: ' + (isRet && ctl.mode === 'clip' ? '0.000000' : '-3.250000') + '\\n';
    process.stderr.write(err);
    return;
  }
  const brArg = args[args.indexOf('-b:a') + 1] || '64k';
  const br = parseInt(String(brArg), 10);
  const afIdx = args.indexOf('-af');
  let outFrames = frames;
  let factor = 1;
  if (afIdx >= 0) {
    for (const m of String(args[afIdx + 1]).matchAll(/atempo=([0-9.]+)/g)) factor *= Number(m[1]);
    outFrames = Math.max(1, Math.round(frames / factor));
    if (ctl.mode === 'truncate') outFrames = Math.max(1, Math.round(outFrames * 0.5));
    fs.appendFileSync(path.join(ST, 'args.log'), JSON.stringify(args) + '\\n');
  }
  let out;
  if (afIdx >= 0 && ctl.mode === 'garbage') {
    out = Buffer.from('esto no es un mp3 ' + h);
  } else {
    const len = 3 * br; out = Buffer.alloc(outFrames * len);
    let x = parseInt(crypto.createHash('sha256').update(h + '|' + factor).digest('hex').slice(0, 8), 16) || 1;
    for (let f = 0; f < outFrames; f++) { const p = f * len; out[p] = 0xff; out[p + 1] = 0xf3; out[p + 2] = (IDX[br] << 4) | 0x04; out[p + 3] = 0xc0;
      for (let i = 4; i < len; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out[p + i] = ((x >>> 16) & 0xff) | 1; } }
  }
  if (afIdx >= 0) { retimed.push(crypto.createHash('sha256').update(out).digest('hex')); fs.writeFileSync(listFile, JSON.stringify(retimed)); }
  process.stdout.write(out);
});
`, { mode: 0o755 });
const BASE_PATH = process.env.PATH;
const withFakeFfmpeg = () => { process.env.PATH = `${FAKE_BIN}${path.delimiter}${BASE_PATH}`; };
const withoutFfmpeg = () => { process.env.PATH = BASE_PATH; };
const ffCtl = (mode) => fs.writeFileSync(path.join(FF_STATE, 'ctl.json'), JSON.stringify({ mode }));
const ffArgsLog = () => { try { return fs.readFileSync(path.join(FF_STATE, 'args.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const NO_FFMPEG_TOOLS = { async retimeMp3() { return null; }, async analyzeAudio() { return null; } };

// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  await check('A1 puro: constantes (objetivo 165, atempo 0,85–1,15) y banda aceptada 115–175 SIN cambios', () => {
    eq([AUD.AUDIOBOOK_WPM_TARGET, AUD.AUDIOBOOK_ATEMPO_MIN, AUD.AUDIOBOOK_ATEMPO_MAX, AUD.AUDIOBOOK_WPM_MIN, AUD.AUDIOBOOK_WPM_MAX], [165, 0.85, 1.15, 115, 175], 'constantes');
  });

  await check('1 puro: ppm 176 / 181,06 / 186,5 → factor dentro de los límites (frena); 200 → 0,825 fuera; < 115 (lento) NUNCA se corrige localmente; dentro de banda → sin plan', () => {
    const f = (w) => AUD.atempoPlanFor(w);
    eq([f(176).factor, f(176).withinLimits], [Math.round((165 / 176) * 1e6) / 1e6, true], '176');
    eq([f(181.06).factor.toFixed(3), f(181.06).withinLimits], ['0.911', true], '181,06 (R1-bis) → 0,911');
    eq([f(186.5).withinLimits, f(186.5).factor < 1], [true, true], '186,5');
    eq([f(200).factor, f(200).withinLimits], [0.825, false], '200');
    // r67 (PO): un segmento LENTO nunca se acelera localmente (puede ser relleno/silencio) → escalera de re-síntesis.
    eq([f(110).slow, f(110).withinLimits], [true, false], '110 → lento: sin corrección local');
    eq([f(100).slow, f(100).withinLimits], [true, false], '100 → lento: sin corrección local');
    eq(f(176).slow, false, 'rápido');
    eq([f(141), f(175), f(115)], [null, null, null], 'en banda');
    eq(AUD.atempoFilterChain(0.911), 'atempo=0.911', 'un filtro');
    eq(AUD.atempoFilterChain(0.3), 'atempo=0.5,atempo=0.6', 'encadenado < 0,5');
  });

  await check('A2 puro: escalera instructions → split (speed se SALTA: no verificado para gpt-4o-mini-tts); nunca repite con el mismo texto; texto nuevo → base', () => {
    const M = 'gpt-4o-mini-tts-2025-03-20';
    eq(AUD.currentAudioStrategy(undefined, 't1', M), 'base', 'primera vez');
    const tried = [{ strategy: 'base', textSha: 't1' }];
    eq(AUD.nextAudioStrategy(tried, 't1', M), 'instructions', 'después de base');
    eq(AUD.nextAudioStrategy([...tried, { strategy: 'instructions', textSha: 't1' }], 't1', M), 'split', 'después de instructions');
    eq(AUD.nextAudioStrategy([...tried, { strategy: 'instructions', textSha: 't1' }, { strategy: 'split', textSha: 't1' }], 't1', M), null, 'agotada (speed no soportado)');
    eq(AUD.ttsModelSupportsSpeed(M), false, 'speed no verificado');
    eq(AUD.nextAudioStrategy(tried, 't1', 'tts-1'), 'split', 'tts-1: instructions no aplica');
    eq(AUD.currentAudioStrategy({ tried: [{ strategy: 'base', textSha: 'viejo' }] }, 'nuevo', M), 'base', 'otro texto = otra entrada');
    eq(AUD.remainingAudioStrategies({ tried }, null, M), 2, 'quedan 2');
    const [a, b] = AUD.splitSegmentTextInTwo('Uno dos tres. Cuatro cinco seis siete. Ocho nueve. Diez once doce.');
    assert(a && b && norm(`${a} ${b}`) === 'Uno dos tres. Cuatro cinco seis siete. Ocho nueve. Diez once doce.', `split ${a} | ${b}`);
    const [c, d] = AUD.splitSegmentTextInTwo('sin puntuacion alguna en todo el texto');
    assert(c.split(' ').length === 4 && d.split(' ').length === 3, 'por palabras');
  });

  await check('A1.5 puro: verificación de integridad — duración ±3 %, ritmo, bitrate, archivo inválido/truncado, silencio interno NUEVO, clipping, sin análisis → rechazo', () => {
    const orig = { frames: 5882, seconds: 141.17, bitrateKbps: 48 };
    const factor = 165 / 181.06;
    const okRet = { frames: Math.round(5882 / factor), seconds: (5882 / factor) * FRAME_SECONDS, bitrateKbps: 48 };
    const A = (o = {}) => ({ durationSeconds: null, silences: [], peakDbfs: -3.2, ...o });
    const base = { factor, original: orig, retimed: okRet, analysisOriginal: A(), analysisRetimed: A(), kbps: 48, words: 426 };
    const ok = AUD.evaluateRetimeIntegrity(base);
    assert(ok.ok && ok.wpm >= 115 && ok.wpm <= 175, `ok ${JSON.stringify(ok)}`);
    eq(AUD.evaluateRetimeIntegrity({ ...base, retimed: null }).problems, ['RETIME_UNPARSEABLE'], 'inválido');
    assert(AUD.evaluateRetimeIntegrity({ ...base, retimed: { ...okRet, seconds: okRet.seconds * 0.5, frames: Math.round(okRet.frames / 2) } }).problems.some((p) => /^RETIME_DURATION/.test(p)), 'truncado');
    assert(AUD.evaluateRetimeIntegrity({ ...base, retimed: { ...okRet, bitrateKbps: 64 } }).problems.some((p) => /^RETIME_BITRATE/.test(p)), 'bitrate');
    assert(AUD.evaluateRetimeIntegrity({ ...base, analysisRetimed: A({ silences: [{ start: 10, end: 13.5 }] }) }).problems.some((p) => /NEW_INTERNAL_SILENCE/.test(p)), 'silencio interno nuevo');
    eq(AUD.evaluateRetimeIntegrity({ ...base, analysisOriginal: A({ silences: [{ start: 10, end: 13 }] }), analysisRetimed: A({ silences: [{ start: 11, end: 14.2 }] }) }).ok, true, 'el silencio ya estaba en el original');
    eq(AUD.evaluateRetimeIntegrity({ ...base, analysisRetimed: A({ silences: [{ start: 0, end: 2.6 }, { start: okRet.seconds - 2.5, end: Infinity }] }) }).ok, true, 'silencios de borde no cuentan');
    assert(AUD.evaluateRetimeIntegrity({ ...base, analysisRetimed: A({ peakDbfs: 0 }) }).problems.some((p) => /CLIPPING/.test(p)), 'clipping');
    assert(AUD.evaluateRetimeIntegrity({ ...base, analysisRetimed: null }).problems.includes('RETIME_ANALYSIS_UNAVAILABLE'), 'sin análisis → nunca se acepta');
    assert(AUD.evaluateRetimeIntegrity({ ...base, factor: 0.5 }).problems.some((p) => /DURATION/.test(p)), 'duración ≠ esperada');
  });

  await check('A1.3 sin ffmpeg (PATH real, sin binario): retimeMp3 / analyzeAudio → null (nunca el original ni un éxito silencioso)', async () => {
    withoutFfmpeg();
    const raw = makeMp3(30, 'sin ffmpeg');
    const h = sha256(raw);
    eq(await RT.retimeMp3(raw, 0.911, 48), null, 'retime');
    eq(await RT.ffmpegAudioTools.analyzeAudio(raw), null, 'análisis');
    eq(sha256(raw), h, 'el original no se tocó');
  });

  await check('A1 determinismo: mismos bytes con la misma entrada y factor; args fijos (bitexact, sin metadatos/ID3, 1 hilo, un solo encode mono 48k); el original nunca se modifica', async () => {
    withFakeFfmpeg(); ffCtl('ok');
    const args0 = RT.retimeFfmpegArgs(0.911, 48);
    for (const a of [['-map_metadata', '-1'], ['-fflags', '+bitexact'], ['-flags:a', '+bitexact'], ['-threads', '1'], ['-ac', '1'], ['-b:a', '48k'], ['-id3v2_version', '0'], ['-af', 'atempo=0.911']]) {
      const i = args0.indexOf(a[0]);
      assert(i >= 0 && args0[i + 1] === a[1], `arg ${a.join(' ')} en ${JSON.stringify(args0)}`);
    }
    eq(args0.filter((x) => x === '-i').length, 1, 'un solo input (un encode)');
    const raw = makeMp3(140, 'determinismo');
    const h = sha256(raw);
    const a = await RT.retimeMp3(raw, 0.911, 48);
    const b = await RT.retimeMp3(raw, 0.911, 48);
    assert(a && b && sha256(a) === sha256(b), 'mismo sha');
    eq(sha256(raw), h, 'original intacto');
    eq(ffArgsLog().slice(-1)[0], args0, 'el binario recibió exactamente esos args');
    const an = RT.parseAnalysis('[silencedetect] silence_start: 1.5\n[silencedetect] silence_end: 4 | silence_duration: 2.5\n[silencedetect] silence_start: 9\nOverall\nPeak level dB: -2.5\n');
    eq([an.silences.length, an.silences[0], an.silences[1].end, an.peakDbfs], [2, { start: 1.5, end: 4 }, Infinity, -2.5], 'parser');
  });

  await check('A3 puro: clasificador — AUDIO_STRATEGIES_EXHAUSTED = D unrecoverable (retry_item); AUDIO_WPM_OUT_OF_RANGE sigue B', () => {
    const v = FC.classifyFailure({ source: 'provider_worker', itemType: 'audiobook_chapter', error: 'AUDIO_STRATEGIES_EXHAUSTED: el segmento seg-2-0-efcc6108ef1e …' });
    eq([v.class, v.humanReason, v.adminAction], ['D', 'unrecoverable', 'retry_item'], 'agotada → reintentar (F2: reinicia solo el segmento)');
    eq(FC.classifyFailure({ source: 'provider_worker', itemType: 'audiobook_chapter', error: 'AUDIO_WPM_OUT_OF_RANGE: x' }).class, 'B', 'wpm');
  });

  const NOW = new Date('2026-10-22T16:30:00Z');
  const ERR = 'AUDIO_WPM_OUT_OF_RANGE: el segmento seg-2-0-efcc6108ef1e narra 426 palabras en 141.17 s (181.1 ppm; aceptado 115–175; estrategia base; sin corrección local: RETIME_UNAVAILABLE); próxima estrategia: instructions';
  const row = (o = {}) => ({ id: 'r67', status: 'failed', type: 'audiobook_chapter', error: ERR, finished_at: new Date(NOW.getTime() - 600_000).toISOString(),
    output_summary: { knownPaidFailure: ERR.slice(0, 300), audioSegments: { a: { model: 'gpt-4o-mini-tts-2025-03-20' } }, ...(o.os || {}) }, ...o.row });

  await check('A3 R1-bis puro: antes `not_allow_listed`; ahora AUDIO_WPM_OUT_OF_RANGE (conocido y liquidado) se reabre (B) con tope 3 y mientras queden estrategias; sin knownPaidFailure → no', () => {
    const d = AH.autoHealDecision(row(), NOW);
    eq([d.heal, d.kind], [true, 'B'], 'reabre');
    eq(AH.autoHealDecision(row({ os: { knownPaidFailure: null } }), NOW).reason, 'not_allow_listed', 'resultado no conocido → no');
    eq(AH.autoHealDecision(row({ os: { autoHeal: { regenRounds: 3 } } }), NOW).reason, 'cap_reached', 'tope 3 rondas');
    eq(AH.autoHealDecision(row({ os: { audioRetryStrategy: { 'seg-2-0-efcc6108ef1e': { tried: [{ strategy: 'base', textSha: 't' }, { strategy: 'instructions', textSha: 't' }, { strategy: 'split', textSha: 't' }], next: null, exhausted: true } } } }), NOW).reason,
      'cap_reached', 'escalera agotada → no');
    for (const c of ['AUDIOBOOK_SEGMENT_DUPLICATE', 'TTS_AUDIO_INVALID']) {
      const e = `${c}: el segmento seg-1-0-aaaaaaaaaaaa x`;
      eq(AH.autoHealDecision(row({ row: { error: e }, os: { knownPaidFailure: e } }), NOW).heal, true, c);
      // r67 fix round 1 (F5): sin estrategia distinta que aplicarles → a lo sumo UNA ronda automática.
      eq(AH.autoHealDecision(row({ row: { error: e }, os: { knownPaidFailure: e, autoHeal: { regenRounds: 1 } } }), NOW).reason, 'cap_reached', `${c}: 1 ronda`);
      eq(IT.maxAutomaticRoundsToday(e, 'audiobook_chapter', { knownPaidFailure: e }, 'B'), 1, `${c}: recovery_max_rounds 1`);
    }
    eq(IT.maxAutomaticRoundsToday(ERR, 'audiobook_chapter', row().output_summary, 'B'), 3, 'recovery_max_rounds = 3 (antes 0)');
    eq(AH.autoHealDecision(row({ os: { autoHeal: { regenRounds: 1 } } }), NOW).round, 2, 'ronda 2');
  });

  await check('A3 puro: máquina de estados — recoveryStateOf / scheduledRetryAtOf / run definitivo (7 estados, sin huérfanos)', () => {
    const S = (r) => RS.recoveryStateOf(r, NOW);
    eq(S({ status: 'completed' }).state, 'completed', 'completed');
    eq(S({ status: 'retrying', error: 'tts_failed: x', next_retry_at: NOW }).state, 'transient_failed', 'retrying');
    eq(S({ status: 'retrying', output_summary: { delivery: 'blocked_quota', youtubeQuotaBlockedUntil: new Date(NOW.getTime() + 3600e3).toISOString() } }).state, 'waiting_external_quota', 'cuota YouTube');
    const p = S(row());
    eq([p.state, p.automatic], ['pending_retry', true], 'elegible');
    assert(p.nextRetryAt, 'con próxima ronda visible');
    eq(S(row({ row: { error: 'AUDIO_STRATEGIES_EXHAUSTED: x', attention_reason: 'unrecoverable' } })).state, 'failed_no_strategies', 'agotada');
    eq(S(row({ row: { error: 'item_recovery_budget_exhausted: x', attention_reason: 'budget' } })).state, 'blocked_permanent', 'presupuesto');
    eq(S(row({ row: { error: 'provider_reconciliation_required: openai — llamada pagada enviada sin resultado liquidado: tts_failed: error de red (TimeoutError)' } })).state, 'waiting_financial_reconciliation', 'pago incierto');
    eq(S(row({ row: { finished_at: new Date(NOW.getTime() - 30 * 3600e3).toISOString() } })).state, 'failed_no_strategies', 'espera expirada (24 h)');
    eq(S({ status: 'blocked', error: 'budget_exceeded: x' }).state, 'blocked_permanent', 'bloqueado por presupuesto');
    const run = RS.runRecoveryStateOf([row(), { status: 'completed' }], NOW);
    eq([run.definitive, run.automatic], [false, 1], 'run con recuperación pendiente: no definitivo');
    eq(RS.runRecoveryStateOf([row({ row: { error: 'AUDIO_STRATEGIES_EXHAUSTED: x', attention_reason: 'unrecoverable' } }), { status: 'blocked' }], NOW).definitive, true, 'definitivo');
    const view = IRV.recoveryViewOf({ ...row(), failure_class: 'B', recovery_round: 0 }, NOW);
    eq(view.state.state, 'pending_retry', 'DTO');
  });

  await check('F3 puro: lo que OTRO barrido del tick va a tomar nunca queda failed_no_strategies (claim incompleto r62 d8, control de gasto, reintento seguro, reenvío ambiguo)', () => {
    // Recuperación automática encendida (como en staging/producción: flag dinámico + política por clase).
    const savedFlag = process.env.DYNAMIC_COURSE_STRUCTURE;
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    try {
    const old = new Date(NOW.getTime() - 40 * 60_000).toISOString();
    const S = (r) => RS.recoveryStateOf({ status: 'failed', finished_at: old, output_summary: {}, ...r }, NOW);
    const d8 = S({ type: 'video_interactions', error: 'claim_payload_unavailable: VIDEO_NOT_COMPLETED: el video del capítulo no está completado', failure_class: 'B' });
    assert(d8.state !== 'failed_no_strategies', `d8 → ${d8.state}`);
    const d8Old = S({ type: 'video_interactions', error: 'claim_payload_unavailable: VIDEO_YOUTUBE_ID_MISSING: x', failure_class: 'B', finished_at: new Date(NOW.getTime() - 30 * 3600e3).toISOString() });
    assert(d8Old.state !== 'failed_no_strategies', `d8 viejo: su barrido registra la excepción al rendirse (${d8Old.state})`);
    eq(S({ type: 'presentation', error: 'gamma_submit_failed: HTTP 400 bad request', failure_class: 'C' }).state, 'pending_retry', 'reintento seguro');
    eq(S({ type: 'audiobook_chapter', error: 'provider_reconciliation_required: openai — llamada pagada enviada sin resultado liquidado: x' }).state, 'waiting_financial_reconciliation', 'reenvío ambiguo');
    } finally {
      if (savedFlag === undefined) delete process.env.DYNAMIC_COURSE_STRUCTURE; else process.env.DYNAMIC_COURSE_STRUCTURE = savedFlag;
    }
  });

  await check('F6 puro: corte ÚNICO R67_AUTO_RECOVERY_SINCE — un run anterior (R1-bis 7831fa67, 2026-10-22T15:48:20Z) se comporta como antes de r67 (no_allow_listed, 0 rondas); sin la variable el corte es el arranque del proceso', () => {
    const saved = process.env.R67_AUTO_RECOVERY_SINCE;
    try {
      delete process.env.R67_AUTO_RECOVERY_SINCE;
      assert(AH.r67AutoRecoverySince().getTime() > Date.parse('2026-10-22T15:48:20Z'), 'sin variable: arranque del proceso (posterior a R1-bis)');
      eq(AH.r67AutoRecoveryApplies('2026-10-22T15:48:20Z'), false, 'R1-bis fuera');
      eq(AH.r67AutoRecoveryApplies(new Date(Date.now() + 1000)), true, 'run nuevo dentro');
      process.env.R67_AUTO_RECOVERY_SINCE = '2026-10-23T00:00:00Z';
      const pre = row({ row: { run_created_at: '2026-10-22T15:48:20Z' } });
      eq(AH.autoHealDecision(pre, NOW).reason, 'not_allow_listed', 'reapertura: como antes de r67');
      eq(IT.maxAutomaticRoundsToday(ERR, 'audiobook_chapter', pre.output_summary, 'B', '2026-10-22T15:48:20Z'), 0, 'recovery_max_rounds 0 (como R1-bis)');
      eq(AH.autoHealDecision(row({ row: { run_created_at: '2026-10-23T01:00:00Z' } }), NOW).heal, true, 'después del corte sí');
    } finally {
      if (saved === undefined) delete process.env.R67_AUTO_RECOVERY_SINCE; else process.env.R67_AUTO_RECOVERY_SINCE = saved;
    }
  });

  await check('15 puro (sin bucles): todo camino automático acotado — B audio ≤ 3 rondas, ventana 24 h; la escalera nunca repite; lost-result reconoce partes y cuarentena como resultado guardado', () => {
    for (let r = 0; r < 10; r++) {
      const d = AH.autoHealDecision(row({ os: { autoHeal: { regenRounds: r } } }), NOW);
      eq(d.heal, r < 3, `ronda ${r}`);
    }
    eq(AH.autoHealDecision(row({ row: { finished_at: new Date(NOW.getTime() - 25 * 3600e3).toISOString() } }), NOW).reason, 'too_old', 'ventana');
    const ids = LR.persistedPaidOpIds({ audioSplitParts: { k: { 0: { requestId: 'req_p0' } } }, audioQuarantine: { k: [{ requestIds: ['req_q'] }] } });
    assert(ids.has('req_p0') && ids.has('req_q'), 'partes y cuarentena');
  });
}

// ════════════════════════════════════════════════════════════════════════════
function findPgBin() {
  for (const d of [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean)) {
    const pg = path.join(d, 'postgres');
    if (fs.existsSync(pg) && /\b16\./.test(spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '')) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => ([5570, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port))); });
  });
}
function cleanEnv(extra) {
  const env = { PATH: BASE_PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}
const OWNER = '11111111-2222-4333-8444-555555555555';
const CONTEXT = { nombre: 'Curso r67', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const SEC = (t, n) => `## ${t}\n\n` + Array.from({ length: n }, (_, i) => `El técnico revisa la bomba número ${i} y registra presión, caudal y temperatura en la planilla del turno.`).join(' ');
/** Capítulo de 3 bloques (≥ 3 segmentos de TTS): seg-2 reproduce el segmento rápido de R1-bis. */
const LONG_MD = `# Bombas\n\n${SEC('Inspección', 34)}\n\n${SEC('Mantenimiento', 41)}\n\n${SEC('Registro', 49)}`;
const CONTENT_MD = (t) => `# ${t}\n\nLa bomba de engranajes mueve el aceite a presión constante. El técnico revisa ruido, temperatura y caudal en cada turno.\n\n## Mantenimiento\n\nSe cambia el filtro y se registra la presión.`;

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
  const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
  const { ArtifactsService } = loadDist('modules/artifacts/artifacts.service.js');
  const { Artifact } = loadDist('modules/artifacts/entities/artifact.entity.js');
  const ATT = loadDist('modules/reliability/attempt-log.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r67-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r67-cwd-'));
  const ROLE = 'postgres.r67localtest01';
  const DB = 'r67db';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  let ds = null;
  const storage = startStorage();
  const fakes = startProviderFakes({ gammaKey: SECRETS.GAMMA_API_KEY, openaiKey: SECRETS.OPENAI_API_KEY, anthropicKey: SECRETS.ANTHROPIC_API_KEY, makePdf: SM.syntheticPdf, makeMp3 });
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`\nPostgres ${pgBin} en 127.0.0.1:${port}`);
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create role "${ROLE}" superuser login`); });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
        'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    { const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({})); assert(res.code === 0, `constraints: ${res.out}`); }
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js',
      'scripts/migrate-v21-finops.js', 'scripts/verify-v21-finops-schema.js', 'scripts/migrate-rel-recovery.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }
    await new Promise((res) => storage.srv.listen(0, '127.0.0.1', res));
    const storageUrl = `http://127.0.0.1:${storage.srv.address().port}`;
    const urls = await fakes.listen();
    for (const u of [storageUrl, urls.gammaUrl, urls.openaiUrl, urls.anthropicUrl]) assert(/^http:\/\/127\.0\.0\.1:\d+/.test(u), `fake fuera de loopback: ${u}`);

    Object.assign(process.env, {
      DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_REAL_VIDEO_OWNERS: OWNER, DYNAMIC_MANIFEST_RULES_VERSION: '3', DYNAMIC_VIDEO_DELIVERY: 'youtube',
      DYNAMIC_PROVIDER_WORKER_ENABLED: 'true', DYNAMIC_ALLOW_VIDEO_PREVIEW: 'true', SUPER_ADMIN_EMAILS: 'admin@cursia.test',
      SUPABASE_URL: storageUrl, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-local-only',
      GAMMA_API_BASE_URL: urls.gammaUrl, OPENAI_API_BASE_URL: urls.openaiUrl, ANTHROPIC_API_BASE_URL: urls.anthropicUrl,
      GAMMA_API_KEY: SECRETS.GAMMA_API_KEY, GAMMA_THEME_V21_LIGHT_DEFAULT: 'theme-r67-light', GAMMA_THEME_V21_DARK_DEFAULT: 'theme-r67-dark',
      OPENAI_API_KEY: SECRETS.OPENAI_API_KEY, ANTHROPIC_API_KEY: SECRETS.ANTHROPIC_API_KEY, VIDEOGEN_API_KEY: SECRETS.VIDEOGEN_API_KEY,
    });
    // r67 (F6): corte de activación de los automatismos de r67 = inicio de esta corrida (los runs de prueba son posteriores; el
    // «histórico» se fecha 30 días antes).
    process.env.R67_AUTO_RECOVERY_SINCE = new Date(Date.now() - 60_000).toISOString();
    for (const k of ['DYNAMIC_V2_ALLOWED_OWNERS', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'DYNAMIC_ALLOW_PROVIDER_MOCK', 'FINOPS_KILL_SWITCH', 'FINOPS_PROVIDER_ALLOWLIST', 'DYNAMIC_AUTO_HEAL_POLICY']) delete process.env[k];

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false });
    await ds.initialize();
    ATT.resetRelSchemaCache();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const runs = new RunsService(ds, manifests, {}, { async check() { return { ok: true }; } }, budget);
    const runs2 = new RunsService(ds, manifests, {}, { async check() { return { ok: true }; } }, budget);
    const sched = new SchedulerService(ds, runs);
    const sched2 = new SchedulerService(ds, runs2);
    const artifacts = new ArtifactsService(ds.getRepository(Artifact), { get: (k) => process.env[k] });

    async function makeCourse(title) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: false, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'Válvulas', objective: null, video_enabled: false, activity_enabled: false }],
      );
      for (const m of s2.modules) {
        await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
        for (const c of m.chapters) {
          await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`,
            [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
        }
      }
      await ds.query(
        `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, 2, $2::jsonb, $3, 0, 1, 2)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      await manifests.getOrCreate(cid, OWNER, 1);
      return { cid, c1, c2, m1 };
    }
    const itemRow = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const jobRow = async (runId) => (await ds.query(`select * from public.production_jobs where id = $1`, [runId]))[0];
    async function seedDependency(runId, key, type, body, mime) {
      const row = await itemRow(runId, key);
      const p = `${OWNER}/dynamic/r67/${runId}/${key.replace(/[^A-Za-z0-9._-]/g, '_')}.${type}`;
      storage.blobs.set(`cursia-artifacts/${p}`, Buffer.from(body));
      await ds.query(
        `insert into public.artifacts (owner_id, course_id, job_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, metadata, module_id, chapter_id, manifest_id, manifest_item_key, item_run_id)
         values ($1, $2, $3, $4, 'supabase', 'cursia-artifacts', $5, 'f', $6, '{}'::jsonb, $7, $8, $9, $10, $11)`,
        [OWNER, String(row.course_id), runId, type, p, mime, row.module_id, row.chapter_id, row.manifest_id, key, row.id]);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where id = $1`, [row.id]);
    }
    /**
     * Run nuevo con el audiolibro del cap. 1 (LONG_MD) listo para reclamar. `isolate` = todas las demás partes completadas
     * (salvo `keep`), así el run llega a `failed` cuando falla el audiolibro (escenarios del run).
     */
    async function freshRun(title, { isolate = false, keep = [], maxAttempts = null } = {}) {
      const K = await makeCourse(title);
      const e = await rejectsRe(runs.startRun(K.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' }), /^budget_approval_required/, `aprobación ${title}`);
      await budget.adminAuthorize({ courseId: K.cid, estimateId: e.getResponse().estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test' });
      const rid = (await runs.startRun(K.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' })).run.id;
      await seedDependency(rid, `content:${K.c1}`, 'dynamic_content_md', LONG_MD, 'text/markdown');
      await seedDependency(rid, `content:${K.c2}`, 'dynamic_content_md', CONTENT_MD('Válvulas'), 'text/markdown');
      const key = `audiobook_chapter:${K.c1}`;
      if (isolate) {
        await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and item_key <> all($2::text[]) and status <> 'completed'`, [rid, [key, ...keep]]);
      }
      if (maxAttempts) await ds.query(`update public.generation_item_runs set max_attempts = $3 where job_id = $1 and item_key = $2`, [rid, key, maxAttempts]);
      return { ...K, rid, key };
    }
    const workerDeps = (over = {}) => ({
      scheduler: sched, dataSource: ds, artifacts, logger: capLogger, executorId: 'r67-provider-worker', leaseSeconds: 120,
      finops: ledger, budget, gammaPollMs: 20, gammaTimeoutMs: 3000,
      rasterizer: { async available() { return true; }, async firstPagePng() { return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'); } },
      ...over,
    });
    const claimAb = (R, s = sched, executorId = 'r67-provider-worker') => s.claimNextItem({ executorId, types: ['audiobook_chapter'], leaseSeconds: 120, runId: R.rid });
    /** Un claim + worker real; devuelve la fila resultante. */
    async function runAudio(R, over = {}, s = sched, executorId = 'r67-provider-worker') {
      await ds.query(`update public.generation_item_runs set next_retry_at = now() - interval '1 second' where job_id = $1 and item_key = $2 and status = 'retrying'`, [R.rid, R.key]);
      const item = await claimAb(R, s, executorId);
      assert(item && item.itemKey === R.key, `claim ${item && item.itemKey}`);
      await PW.processProviderItem(workerDeps({ scheduler: s, executorId, ...over }), item).catch((e) => { R.thrown = e.message; });
      return itemRow(R.rid, R.key);
    }
    const later = (mins) => new Date(Date.now() + mins * 60_000);
    /** TTS del fake de ESTE run (por texto): base = la del segmento objetivo, etc. */
    const ttsOf = (t0) => fakes.st.tts.slice(t0).filter((x) => !x.failed || x.failed);
    /** Ritmo por estrategia del segmento objetivo (k = índice del segmento distinto que se vuelve rápido). */
    function paceFor(cfg) {
      const seen = [];
      const st = { tgt: null, cfg };
      fakes.plan.ttsPace = (req) => {
        const inp = norm(req.input);
        if (st.tgt === null && !req.instructions && !seen.includes(inp) && !(seen.length && seen.some((s) => s.includes(inp)))) {
          seen.push(inp);
          if (seen.length - 1 === cfg.k) st.tgt = inp;
        }
        if (st.tgt === null) return null;
        if (inp === st.tgt) return req.instructions ? st.cfg.instructions : st.cfg.base;
        if (st.tgt.includes(inp)) return st.cfg.split;
        return null;
      };
      return st;
    }
    const chargesOf = async (itemRunId) => ds.query(
      `select metadata->>'chunk' as chunk, idempotency_key, amount::text as amount, external_operation_id from public.generation_cost_events
        where item_run_id = $1 and provider = 'openai' and event_kind = 'CHARGE' and coalesce(metadata->>'reservation', 'false') <> 'true' order by created_at, id`, [itemRunId]);
    const reservationsOf = async (itemRunId) => ds.query(
      `select idempotency_key from public.generation_cost_events where item_run_id = $1 and provider = 'openai' and metadata->>'reservation' = 'true' order by created_at, id`, [itemRunId]);
    const callsBy = (calls, st) => {
      const by = { tgtBase: 0, tgtInstr: 0, tgtSplit: 0, other: new Map() };
      for (const c of calls) {
        const inp = norm(c.input);
        if (st.tgt && inp === st.tgt) { if (c.instructions) by.tgtInstr++; else by.tgtBase++; }
        else if (st.tgt && st.tgt.includes(inp)) by.tgtSplit++;
        else by.other.set(inp, (by.other.get(inp) ?? 0) + 1);
      }
      return by;
    };
    /** Invariante r67: toda parte failed (generación vigente) tiene next_retry_at o attention_reason. */
    async function assertNoOrphans(rid, label) {
      const orph = await ds.query(
        `select item_key, error from public.generation_item_runs g where g.job_id = $1 and g.status = 'failed'
           and g.next_retry_at is null and g.attention_reason is null
           and g.generation = (select max(generation) from public.generation_item_runs x where x.job_id = g.job_id and x.item_key = g.item_key)`, [rid]);
      eq(orph.map((o) => o.item_key), [], `sin huérfanos (${label})`);
    }

    withFakeFfmpeg();
    ffCtl('ok');

    // ═══ 1/2 — ppm 176 / 181,06 / 186,5: corrección local, USD 0, sin llamar a OpenAI ═══════════════════════
    for (const pace of [176, 181.06, 186.5]) {
      await check(`1/2 ${pace} ppm: corrección LOCAL atempo (USD 0, 0 llamadas extra a OpenAI), original en cuarentena intacto, re-verificado (ppm/integridad) y auditable`, async () => {
        ffCtl('ok');
        const R = await freshRun(`r67 local ${pace}`);
        const st = paceFor({ k: 2, base: pace, instructions: 150, split: 150 });
        const t0 = fakes.st.tts.length;
        const row = await runAudio(R);
        eq([row.status, row.error], ['completed', null], 'completa en el intento 1');
        const os = row.output_summary;
        const segs = Object.keys(os.audioSegments);
        const calls = fakes.st.tts.slice(t0);
        eq(calls.length, segs.length, 'una llamada TTS por segmento (ninguna re-síntesis)');
        assert(calls.every((c) => !c.instructions && c.speed === null), 'sin instructions/speed');
        const corrKeys = Object.keys(os.audioCorrections || {});
        eq(corrKeys.length, 1, 'un segmento corregido');
        const c = os.audioCorrections[corrKeys[0]];
        assert(st.tgt && norm(calls.find((x) => norm(x.input) === st.tgt).input) === st.tgt, 'el segmento objetivo');
        eq(c.method, 'atempo', 'método');
        assert(c.originalWpm > 175 && c.finalWpm >= 115 && c.finalWpm <= 175, `ppm ${c.originalWpm} → ${c.finalWpm}`);
        assert(Math.abs(c.factor - 165 / c.originalWpm) < 1e-5 && c.factor >= 0.85 && c.factor <= 1.15, `factor ${c.factor}`);
        const q = os.audioQuarantine[corrKeys[0]][0];
        const blob = storage.blobs.get(`cursia-artifacts/${q.storagePath}`);
        assert(blob && sha256(blob) === c.originalSha && q.rawSha === c.originalSha, 'original en cuarentena con su sha (nunca destruido)');
        const segBlob = storage.blobs.get(`cursia-artifacts/${os.audioSegments[corrKeys[0]].storagePath}`);
        eq(sha256(segBlob), c.finalSha, 'el segmento guardado es el corregido');
        const again = await RT.retimeMp3(blob, c.factor, 48);
        eq(sha256(again), c.finalSha, 'determinista: re-correr el retime da el mismo sha');
        eq((await chargesOf(row.id)).length, segs.length, 'ledger: un cargo TTS por segmento (USD 0 de la corrección)');
        eq(AUD.validateChapterAudioManifest(os.audiobookManifest), [], 'manifiesto validado');
        await assertNoOrphans(R.rid, `local ${pace}`);
      });
    }

    // ═══ 1/3 — 200 ppm: factor 0,825 fuera de límites → instructions (solo el segmento afectado) ════════════
    await check('1/3 200 ppm: factor fuera de límites → re-síntesis con `instructions` SOLO del segmento afectado (estado transient_failed + next_retry_at visible); el resto se reutiliza; claves de reserva por estrategia', async () => {
      ffCtl('ok');
      const R = await freshRun('r67 200');
      const st = paceFor({ k: 2, base: 200, instructions: 150, split: 150 });
      const t0 = fakes.st.tts.length;
      let row = await runAudio(R);
      eq(row.status, 'retrying', `retrying (${row.error})`);
      assert(/^AUDIO_WPM_OUT_OF_RANGE: .*ATEMPO_FACTOR_OUT_OF_LIMITS 0\.82\d*.*próxima estrategia: instructions/.test(row.error), row.error);
      eq(row.output_summary.recovery.state, 'transient_failed', 'estado');
      assert(row.next_retry_at, 'next_retry_at visible');
      const firstCalls = fakes.st.tts.length - t0;
      row = await runAudio(R);
      eq([row.status, row.error], ['completed', null], 'completa con instructions');
      const by = callsBy(fakes.st.tts.slice(t0), st);
      eq([by.tgtBase, by.tgtInstr, by.tgtSplit], [1, 1, 0], 'objetivo: base + instructions');
      assert([...by.other.values()].every((n) => n === 1), `segmentos ya guardados nunca se re-sintetizan ${JSON.stringify([...by.other.values()])}`);
      eq(fakes.st.tts.length - t0, firstCalls + 1 + (Object.keys(row.output_summary.audioSegments).length - 3), 'intento 2: solo el objetivo y los que faltaban');
      assert(fakes.st.tts.slice(t0).find((c) => c.instructions).instructions === AUD.AUDIO_PACE_INSTRUCTIONS, 'instructions enviadas');
      const keys = (await reservationsOf(row.id)).map((x) => x.idempotency_key);
      assert(keys.some((k) => /[_:]instructions$/.test(k)) && new Set(keys).size === keys.length, `reservas distintas por estrategia ${keys.join(' ')}`);
      const ch = await chargesOf(row.id);
      const perChunk = ch.reduce((m, x) => ((m[x.chunk] = (m[x.chunk] ?? 0) + 1), m), {});
      eq([perChunk['0'], perChunk['1'], perChunk['2']], [1, 1, 2], 'cargos: seg-0 y seg-1 una vez, seg-2 dos');
      eq(row.output_summary.recovery.state, 'completed', 'estado final');
      await assertNoOrphans(R.rid, '200');
    });

    // ═══ 3 — integridad fallida (silencio interno nuevo) → instructions → split ═══════════════════════════════
    await check('3 integridad fallida (silencio interno nuevo tras atempo) → instructions (también falla) → split por oración (2 partes guardadas) → completa; ninguna estrategia se repite', async () => {
      ffCtl('silence');
      const R = await freshRun('r67 silencio');
      const st = paceFor({ k: 2, base: 181, instructions: 181, split: 150 });
      const t0 = fakes.st.tts.length;
      let row = await runAudio(R);
      assert(row.status === 'retrying' && /RETIME_NEW_INTERNAL_SILENCE/.test(row.error) && /próxima estrategia: instructions/.test(row.error), row.error);
      row = await runAudio(R);
      assert(row.status === 'retrying' && /estrategia instructions/.test(row.error) && /próxima estrategia: split/.test(row.error), row.error);
      row = await runAudio(R);
      eq([row.status, row.error], ['completed', null], 'completa con split');
      const by = callsBy(fakes.st.tts.slice(t0), st);
      eq([by.tgtBase, by.tgtInstr, by.tgtSplit], [1, 1, 2], 'base, instructions, 2 partes');
      const segKey = Object.keys(row.output_summary.audioRetryStrategy)[0];
      eq(row.output_summary.audioRetryStrategy[segKey].tried.map((t) => [t.strategy, t.outcome]), [['base', 'integrity_failed'], ['instructions', 'integrity_failed']], 'historial');
      eq(Object.keys(row.output_summary.audioSplitParts[segKey]).sort(), ['0', '1'], 'partes guardadas');
      eq(row.output_summary.audioQuarantine[segKey].length, 2, 'dos originales en cuarentena');
      eq(row.output_summary.audioSegments[segKey].strategy, 'split', 'segmento aceptado por split');
      const keys = (await reservationsOf(row.id)).map((x) => x.idempotency_key);
      assert(keys.some((k) => /split.p0/.test(k)) && keys.some((k) => /split.p1/.test(k)), `reservas por parte ${keys.join(' ')}`);
      await assertNoOrphans(R.rid, 'silencio');
    });

    for (const [mode, re] of [['clip', /RETIME_CLIPPING/], ['truncate', /RETIME_DURATION/], ['garbage', /RETIME_UNPARSEABLE/]]) {
      await check(`3 retime ${mode === 'clip' ? 'con clipping' : mode === 'truncate' ? 'truncado (duración incorrecta)' : 'inválido (no MP3)'} → rechazado (${re.source}) → instructions; nunca se acepta un corregido sin verificar`, async () => {
        ffCtl(mode);
        const R = await freshRun(`r67 ${mode}`);
        paceFor({ k: 2, base: 181, instructions: 150, split: 150 });
        let row = await runAudio(R);
        assert(row.status === 'retrying' && re.test(row.error) && /próxima estrategia: instructions/.test(row.error), row.error);
        eq(row.output_summary.audioCorrections ?? {}, {}, 'sin corrección aceptada');
        row = await runAudio(R);
        eq([row.status, row.error], ['completed', null], 'completa con instructions');
        await assertNoOrphans(R.rid, mode);
      });
    }

    await check('1/3 100 ppm (LENTO): sin corrección local (ni siquiera se invoca el retime: un relleno no se tapa) → directo a la escalera (instructions) → completa', async () => {
      ffCtl('ok');
      const R = await freshRun('r67 lento');
      const st = paceFor({ k: 2, base: 100, instructions: 150, split: 150 });
      const a0 = ffArgsLog().length;
      const t0 = fakes.st.tts.length;
      let row = await runAudio(R);
      assert(row.status === 'retrying' && /SLOW_SEGMENT_NO_LOCAL_CORRECTION/.test(row.error) && /próxima estrategia: instructions/.test(row.error), row.error);
      eq(ffArgsLog().length - a0, 0, 'el retime no se ejecutó');
      eq(row.output_summary.audioCorrections ?? {}, {}, 'sin corrección');
      const segKey = Object.keys(row.output_summary.audioQuarantine)[0];
      assert(row.output_summary.audioQuarantine[segKey][0].wpm < 115, 'original lento en cuarentena');
      row = await runAudio(R);
      eq([row.status, row.error], ['completed', null], 'completa con instructions');
      const by = callsBy(fakes.st.tts.slice(t0), st);
      eq([by.tgtBase, by.tgtInstr], [1, 1], 'base + instructions');
      await assertNoOrphans(R.rid, 'lento');
    });

    await check('sin ffmpeg (inyección: retime/análisis → null) → sin corrección local, pasa a instructions (RETIME_UNAVAILABLE); nunca un éxito silencioso', async () => {
      const R = await freshRun('r67 sin ffmpeg');
      paceFor({ k: 2, base: 181, instructions: 150, split: 150 });
      let row = await runAudio(R, { audioTools: NO_FFMPEG_TOOLS });
      assert(row.status === 'retrying' && /RETIME_UNAVAILABLE/.test(row.error) && /próxima estrategia: instructions/.test(row.error), row.error);
      eq(row.output_summary.audioCorrections ?? {}, {}, 'sin corrección');
      row = await runAudio(R, { audioTools: NO_FFMPEG_TOOLS });
      eq(row.status, 'completed', 'completa con instructions');
      await assertNoOrphans(R.rid, 'sin ffmpeg');
    });

    // ═══ 15 / R1-bis — escalera agotada → failed_no_strategies, attention unrecoverable, sin bucles ══════════
    await check('15 R1-bis (seg-0/seg-1 guardados, falla seg-2): base → instructions → split fuera de banda → AUDIO_STRATEGIES_EXHAUSTED (D, attention unrecoverable, failed_no_strategies); seg-0/seg-1 nunca se re-sintetizan ni se re-cobran; el auto-heal no la reabre', async () => {
      ffCtl('ok');
      const R = await freshRun('r67 agotada');
      const st = paceFor({ k: 2, base: 230, instructions: 230, split: 230 });
      const t0 = fakes.st.tts.length;
      let row = await runAudio(R);
      assert(/^AUDIO_WPM_OUT_OF_RANGE/.test(row.error), row.error);
      row = await runAudio(R);
      assert(/^AUDIO_WPM_OUT_OF_RANGE.*próxima estrategia: split/.test(row.error), row.error);
      row = await runAudio(R);
      eq(row.status, 'failed', `failed (${row.error})`);
      assert(/^AUDIO_STRATEGIES_EXHAUSTED/.test(row.error), row.error);
      eq([row.failure_class, row.attention_reason, row.output_summary.recovery.state], ['D', 'unrecoverable', 'failed_no_strategies'], 'visible a admin/dueño');
      const by = callsBy(fakes.st.tts.slice(t0), st);
      eq([by.tgtBase, by.tgtInstr, by.tgtSplit], [1, 1, 2], 'cada estrategia una sola vez');
      eq([...by.other.values()], [1, 1], 'seg-0 y seg-1: una sola síntesis en los 3 intentos');
      const ch = await chargesOf(row.id);
      const perChunk = ch.reduce((m, x) => ((m[x.chunk] = (m[x.chunk] ?? 0) + 1), m), {});
      eq([perChunk['0'], perChunk['1'], perChunk['2']], [1, 1, 4], 'cargos por segmento');
      const dto = await runs.getRun(R.cid, OWNER, 1, R.rid);
      const it = dto.items.find((x) => x.itemKey === R.key);
      eq([it.recovery.state.state, it.recovery.attentionReason], ['failed_no_strategies', 'unrecoverable'], 'DTO');
      const t1 = fakes.st.tts.length;
      for (const m of [5, 60, 600]) eq((await runs.autoHealFailedItems({ now: later(m) })).reopened.filter((x) => x.runId === R.rid).length, 0, `sin reapertura (+${m} min)`);
      eq(fakes.st.tts.length - t1, 0, 'sin llamadas');
      await assertNoOrphans(R.rid, 'agotada');
      // r67 fix round 1 (F2): un reintento HUMANO reinicia la escalera SOLO del segmento agotado (con auditoría) y
      // conserva los aceptados y la cuarentena → corrección local del segmento (aquí el TTS vuelve a 181 ppm) a costo 0
      // para seg-0/seg-1.
      const segsBefore = JSON.stringify(row.output_summary.audioSegments);
      const quarBefore = JSON.stringify(row.output_summary.audioQuarantine);
      await runs.retryItem(R.cid, OWNER, 1, R.rid, R.key);
      row = await itemRow(R.rid, R.key);
      const segKey = Object.keys(row.output_summary.audioLadderResets ? { [row.output_summary.audioLadderResets[0].segKey]: 1 } : {})[0];
      assert(segKey, 'auditoría del reinicio');
      const reset = row.output_summary.audioLadderResets[0];
      eq([reset.by, reset.actor, reset.previous.exhausted, reset.previous.tried.length], [OWNER, 'owner', true, 3], 'quién / escalera anterior');
      eq(row.output_summary.audioRetryStrategy[segKey], undefined, 'escalera del segmento reiniciada');
      eq(JSON.stringify(row.output_summary.audioSegments), segsBefore, 'segmentos aceptados intactos');
      eq(JSON.stringify(row.output_summary.audioQuarantine), quarBefore, 'cuarentena intacta');
      st.cfg.base = 181;
      const t2 = fakes.st.tts.length;
      const ch0 = (await chargesOf(row.id)).length;
      row = await runAudio(R);
      eq([row.status, row.error], ['completed', null], 'completa tras el reintento humano');
      const by2 = callsBy(fakes.st.tts.slice(t2), st);
      eq([by2.tgtBase, by2.tgtInstr, by2.tgtSplit], [1, 0, 0], 'el segmento que falló: una síntesis base, corregida localmente');
      assert(![...by2.other.keys()].some((k) => [...by.other.keys()].slice(0, 2).includes(k)), 'seg-0/seg-1: 0 llamadas TTS');
      const chB = await chargesOf(row.id);
      const perChunk2 = chB.reduce((m, x) => ((m[x.chunk] = (m[x.chunk] ?? 0) + 1), m), {});
      eq([perChunk2['0'], perChunk2['1']], [1, 1], 'seg-0/seg-1: 0 cargos nuevos');
      eq(chB.length - ch0, 1 + by2.other.size, 'un cargo nuevo por llamada nueva (el segmento corregido localmente + los que faltaban)');
      assert(row.output_summary.audioCorrections[segKey], 'corrección local registrada');
    });

    // ═══ 10/11/2 — run failed → auto-heal reabre (B) → queued; dependiente desbloqueado; reanuda desde segmentos ═══
    await check('10/11 run `failed` por el audio (intentos agotados antes de la escalera) → pending_retry con next_retry_at → el auto-heal reabre (B, estrategia siguiente) → run `queued` con registro explícito; el dependiente se desbloquea; reanuda desde seg-0/seg-1 sin repagar; nunca un paquete parcial', async () => {
      ffCtl('ok');
      const K0 = await freshRun('r67 run failed', { isolate: true, keep: [] });
      // Dependiente artificial del audiolibro: una parte pendiente que espera al audio.
      const dep = (await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and item_key <> $2 and status = 'completed' and type not in ('content') order by item_key limit 1`, [K0.rid, K0.key]))[0].item_key;
      await ds.query(`update public.generation_item_runs set status = 'pending', finished_at = null, depends_on = array_append(depends_on, $3) where job_id = $1 and item_key = $2`, [K0.rid, dep, K0.key]);
      const R = K0;
      const st = paceFor({ k: 2, base: 230, instructions: 230, split: 150 });
      const t0 = fakes.st.tts.length;
      let row = await runAudio(R); // base → fuera de banda
      fakes.plan.ttsFail = [503]; // intento 2: la llamada instructions recibe un 503 (sin cobro, no gasta la estrategia)
      row = await runAudio(R);
      fakes.plan.ttsFail = [];
      assert(/^tts_failed/.test(row.error), `503 ${row.error}`);
      row = await runAudio(R); // intento 3: instructions fuera de banda → próxima split, intentos agotados
      eq(row.status, 'failed', `failed (${row.error})`);
      assert(/próxima estrategia: split/.test(row.error), row.error);
      eq([row.attention_reason, row.output_summary.recovery.state], [null, 'pending_retry'], 'recuperable, esperando');
      assert(row.next_retry_at, 'next_retry_at visible');
      eq(row.recovery_max_rounds, 3, 'recovery_max_rounds 3');
      let dto = await runs.getRun(R.cid, OWNER, 1, R.rid);
      eq(dto.workerStatus, 'failed', 'run failed');
      eq(dto.recoveryState.definitive, false, 'el run NO es definitivamente fallido');
      eq((await itemRow(R.rid, dep)).status, 'blocked', 'dependiente bloqueado');
      await assertNoOrphans(R.rid, 'run failed');
      const sw = await runs.autoHealFailedItems({ now: later(5) });
      eq(sw.reopened.filter((x) => x.runId === R.rid).map((x) => [x.itemKey, x.kind]), [[R.key, 'B']], 'auto-heal reabre (B)');
      const job = await jobRow(R.rid);
      eq(job.worker_status, 'queued', 'run → queued');
      const h = job.output_summary.recoveryHistory.slice(-1)[0];
      eq([h.event, h.from, h.itemKey, h.actor, h.automatic], ['run_reopened', 'failed', R.key, 'system', true], 'registro explícito de la reapertura');
      eq((await itemRow(R.rid, dep)).status, 'pending', 'dependiente desbloqueado');
      row = await itemRow(R.rid, R.key);
      eq([row.status, row.output_summary.recovery.state, row.output_summary.recovery.history.slice(-1)[0].event], ['pending', 'pending_retry', 'reopened'], 'estado de la reapertura');
      row = await runAudio(R); // split a 150 → completa
      eq([row.status, row.error], ['completed', null], 'completa con split');
      const by = callsBy(fakes.st.tts.slice(t0), st);
      eq([...by.other.values()].slice(0, 2), [1, 1], 'seg-0/seg-1 sintetizados una sola vez en todo el ciclo');
      const ch = await chargesOf(row.id);
      const perChunk = ch.reduce((m, x) => ((m[x.chunk] = (m[x.chunk] ?? 0) + 1), m), {});
      eq([perChunk['0'], perChunk['1']], [1, 1], 'seg-0/seg-1 cobrados una sola vez');
      dto = await runs.getRun(R.cid, OWNER, 1, R.rid);
      assert(dto.workerStatus !== 'completed', `con el dependiente pendiente el run no se completa (${dto.workerStatus})`);
      assert(!(await jobRow(R.rid)).output_summary.autoPackage, 'sin marca de empaque: nunca un paquete parcial');
    });

    // ═══ 12 — presupuesto agotado: sin llamada ═══════════════════════════════════════════════════════════════
    await check('12 presupuesto de la parte agotado: la ronda automática no llama a OpenAI (guard antes de la llamada) → item_recovery_budget_exhausted (blocked_permanent, attention budget); no hay más rondas', async () => {
      ffCtl('ok');
      const R = await freshRun('r67 presupuesto', { maxAttempts: 1 });
      paceFor({ k: 2, base: 230, instructions: 150, split: 150 });
      let row = await runAudio(R);
      eq(row.status, 'failed', `failed elegible (${row.error})`);
      eq(row.output_summary.recovery.state, 'pending_retry', 'pendiente');
      eq((await runs.autoHealFailedItems({ now: later(5) })).reopened.filter((x) => x.runId === R.rid).length, 1, 'reabre');
      const t0 = fakes.st.tts.length;
      const deny = { async guardPaidSubmission() { return { allow: false, decision: 'BLOCK', reason: 'item_recovery_budget_exhausted', detail: 'prueba r67: esta parte agotó su presupuesto de recuperación' }; } };
      row = await runAudio(R, { budget: deny });
      eq(fakes.st.tts.length - t0, 0, '0 llamadas TTS');
      eq([row.status, row.attention_reason], ['failed', 'budget'], `bloqueada por presupuesto (${row.error})`);
      eq(IRV.recoveryViewOf(row).state.state, 'blocked_permanent', 'estado');
      for (const m of [10, 120]) eq((await runs.autoHealFailedItems({ now: later(m) })).reopened.filter((x) => x.runId === R.rid).length, 0, `sin rondas (+${m})`);
      await assertNoOrphans(R.rid, 'presupuesto');
    });

    // ═══ 13 — reserva ambigua ═══════════════════════════════════════════════════════════════════════════════
    await check('13 reserva financiera ambigua (timeout del TTS del segmento) → waiting_financial_reconciliation con next_retry_at; el auto-heal (B) NO hace ronda ni llamada', async () => {
      ffCtl('ok');
      const R = await freshRun('r67 ambigua', { maxAttempts: 1 });
      paceFor({ k: 2, base: 150, instructions: 150, split: 150 });
      fakes.plan.ttsFail = [undefined, undefined, 'hang'];
      const FAST = { ...process.env, PROVIDER_CALL_TIMEOUT_MS: '400', OPENAI_TTS_TIMEOUT_MS: '400' };
      let row = await runAudio(R, { env: FAST });
      fakes.plan.ttsFail = [];
      assert(row.status === 'failed' && /^provider_reconciliation_required: openai/.test(row.error), row.error);
      eq(row.output_summary.recovery.state, 'waiting_financial_reconciliation', 'estado');
      assert(row.next_retry_at || row.attention_reason, 'visible');
      const t0 = fakes.st.tts.length;
      for (const m of [5, 60]) eq((await runs.autoHealFailedItems({ now: later(m) })).reopened.filter((x) => x.runId === R.rid).length, 0, `sin ronda B (+${m})`);
      eq(fakes.st.tts.length - t0, 0, 'sin llamadas');
      eq(AH.autoRegenRoundsOf((await itemRow(R.rid, R.key)).output_summary), 0, '0 rondas de regeneración');
      await assertNoOrphans(R.rid, 'ambigua');
    });

    // ═══ 14 — dos barridos / dos workers sobre la misma tarea ════════════════════════════════════════════════
    await check('14 dos barridos concurrentes del auto-heal → UNA sola reapertura; dos workers reclaman a la vez → uno solo la toma (skip locked + lease); una sola síntesis', async () => {
      ffCtl('ok');
      const R = await freshRun('r67 concurrencia', { maxAttempts: 1 });
      // Solo la parte objetivo es reclamable (el audiolibro del cap. 2 queda hecho): los dos workers compiten por LA MISMA.
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and type = 'audiobook_chapter' and item_key <> $2`, [R.rid, R.key]);
      const st = paceFor({ k: 2, base: 230, instructions: 150, split: 150 });
      let row = await runAudio(R);
      eq(row.status, 'failed', 'failed elegible');
      const t = later(5);
      const [a, b] = await Promise.all([runs.autoHealFailedItems({ now: t }), runs2.autoHealFailedItems({ now: t })]);
      eq([...a.reopened, ...b.reopened].filter((x) => x.runId === R.rid).length, 1, 'una reapertura');
      const [c1, c2] = await Promise.all([claimAb(R, sched, 'r67-worker-A'), claimAb(R, sched2, 'r67-worker-B')]);
      eq([!!c1, !!c2].filter(Boolean).length, 1, 'un solo claim');
      const winner = c1 ? { item: c1, s: sched, id: 'r67-worker-A' } : { item: c2, s: sched2, id: 'r67-worker-B' };
      const t0 = fakes.st.tts.length;
      await PW.processProviderItem(workerDeps({ scheduler: winner.s, executorId: winner.id }), winner.item);
      row = await itemRow(R.rid, R.key);
      eq(row.status, 'completed', `completa (${row.error})`);
      const by = callsBy(fakes.st.tts.slice(t0), st);
      eq([by.tgtInstr, by.tgtBase], [1, 0], 'una sola llamada (instructions) del objetivo');
      await assertNoOrphans(R.rid, 'concurrencia');
    });

    // ═══ 9 — reinicio del worker ═══════════════════════════════════════════════════════════════════════════
    await check('9 reinicio del worker a mitad del capítulo (lease perdida tras guardar 2 segmentos) → lease vencida → otro worker retoma: reutiliza lo guardado, 0 síntesis duplicadas, 0 cargos duplicados', async () => {
      ffCtl('ok');
      const R = await freshRun('r67 reinicio');
      fakes.plan.ttsPace = null;
      const t0 = fakes.st.tts.length;
      const item = await claimAb(R, sched, 'r67-worker-A');
      const dying = Object.create(sched);
      dying.heartbeatItem = async (...a) => (fakes.st.tts.length - t0 >= 2 ? false : sched.heartbeatItem(...a));
      await PW.processProviderItem(workerDeps({ scheduler: dying, executorId: 'r67-worker-A' }), item);
      let row = await itemRow(R.rid, R.key);
      eq(row.status, 'running', 'el worker A murió con la parte tomada');
      eq(Object.keys(row.output_summary.audioSegments || {}).length, 2, 'dos segmentos guardados');
      await ds.query(`update public.generation_item_runs set lease_until = now() - interval '1 second' where id = $1`, [row.id]);
      await sched2.sweepExpiredLeases(R.rid);
      row = await runAudio(R, {}, sched2, 'r67-worker-B');
      eq([row.status, row.error], ['completed', null], 'el worker B completa');
      const inputs = fakes.st.tts.slice(t0).map((c) => norm(c.input));
      eq(new Set(inputs).size, inputs.length, '0 síntesis duplicadas');
      const ch = await chargesOf(row.id);
      eq(new Set(ch.map((x) => x.external_operation_id)).size, ch.length, '0 cargos duplicados');
      eq(ch.length, Object.keys(row.output_summary.audioSegments).length, 'un cargo por segmento');
      await assertNoOrphans(R.rid, 'reinicio');
    });

    // ═══ 15 — límite de TIEMPO ════════════════════════════════════════════════════════════════════════════
    await check('15 recuperación que supera el límite de tiempo (ventana 24 h sin que nadie la tome) → failed_no_strategies + attention unrecoverable (pasada de huérfanos acotada e idempotente)', async () => {
      ffCtl('ok');
      const R = await freshRun('r67 tiempo', { maxAttempts: 1 });
      paceFor({ k: 2, base: 230, instructions: 150, split: 150 });
      let row = await runAudio(R);
      eq([row.status, row.output_summary.recovery.state], ['failed', 'pending_retry'], 'elegible');
      const marked = await runs.markOrphanFailedItems(later(25 * 60));
      assert(marked.includes(row.id), 'marcada');
      row = await itemRow(R.rid, R.key);
      eq([row.attention_reason, row.output_summary.recovery.state, row.next_retry_at], ['unrecoverable', 'failed_no_strategies', null], 'excepción visible');
      eq((await runs.markOrphanFailedItems(later(26 * 60))).includes(row.id), false, 'idempotente');
      eq((await runs.autoHealFailedItems({ now: later(25 * 60) })).reopened.filter((x) => x.runId === R.rid).length, 0, 'sin reapertura');
      await assertNoOrphans(R.rid, 'tiempo');
    });

    // ═══ F6 — R1-bis preservado: run ANTERIOR al corte ═══════════════════════════════════════════════════════════
    for (const pace of [181, 186.5]) {
      await check(`F6 R1-bis (${pace} ppm): run anterior al corte con seg-0/seg-1 aceptados y seg-2 AUDIO_WPM_OUT_OF_RANGE (ineligibleMd5): ningún barrido del tick la toca (fila byte-idéntica, 0 TTS); un reintento HUMANO la corrige localmente (seg-0/seg-1 0 llamadas y 0 cargos)`, async () => {
        const R = await freshRun(`r67 R1-bis ${pace}`, { maxAttempts: 1 });
        const st = paceFor({ k: 2, base: pace, instructions: pace, split: pace });
        let row = await runAudio(R, { audioTools: NO_FFMPEG_TOOLS }); // «antes de r67»: sin corrección local
        assert(row.status === 'failed' && /^AUDIO_WPM_OUT_OF_RANGE/.test(row.error), row.error);
        eq(Object.keys(row.output_summary.audioSegments).length, 2, 'seg-0 y seg-1 aceptados');
        // Forma de R1-bis en staging (datos de antes de r67): sin estado r67, ineligibleMd5 marcado, sin próxima acción.
        await ds.query(
          `update public.generation_item_runs
              set output_summary = (output_summary - 'recovery' - 'audioRetryStrategy' - 'audioQuarantine')
                    || jsonb_build_object('autoHeal', jsonb_build_object('ineligibleMd5', md5(error), 'ineligibleReason', 'not_allowed_listed_pre_r67')),
                  next_retry_at = null, attention_reason = null, recovery_max_rounds = 0
            where id = $1`, [row.id]);
        await ds.query(`update public.production_jobs set created_at = '2026-10-22T15:48:20Z' where id = $1`, [R.rid]);
        const snap = async () => JSON.stringify((await ds.query(`select to_jsonb(g) as j from public.generation_item_runs g where id = $1`, [row.id]))[0].j);
        const before = await snap();
        const t0 = fakes.st.tts.length;
        for (const m of [5, 60, 25 * 60]) {
          await runs.autoHealFailedItems({ now: later(m) });
          await runs.markOrphanFailedItems(later(m));
          await runs.autoRetrySafeRejections({ now: later(m) }).catch(() => null);
          await runs.autoResubmitAmbiguousAudio({ now: later(m) }).catch(() => null);
          await runs.autoResumeSpendControlHolds({ now: later(m) }).catch(() => null);
          await runs.autoExtendItemRecoveryBudget({ now: later(m) }).catch(() => null);
          await runs.autoRecoverClaimPayloadUnavailable({ now: later(m) }).catch(() => null);
          await runs.autoProbeProviderCredit({ now: later(m) }).catch(() => null);
        }
        eq(await snap(), before, 'fila byte-idéntica (sin reapertura, sin attention, sin updated_at)');
        eq(fakes.st.tts.length - t0, 0, '0 llamadas TTS');
        // Reintento humano explícito: sí funciona, con el camino nuevo (corrección local del seg-2 a costo 0).
        ffCtl('ok');
        const ch0 = await chargesOf(row.id);
        await runs.retryItem(R.cid, OWNER, 1, R.rid, R.key);
        row = await runAudio(R);
        eq([row.status, row.error], ['completed', null], 'completa');
        const by = callsBy(fakes.st.tts.slice(t0), st);
        eq([by.tgtBase, by.tgtInstr, by.tgtSplit], [1, 0, 0], 'seg-2: una síntesis, corregida localmente');
        assert(row.output_summary.audioCorrections && Object.keys(row.output_summary.audioCorrections).length === 1, 'corrección local');
        const ch = await chargesOf(row.id);
        const old01 = ch0.filter((x) => x.chunk === '0' || x.chunk === '1').length;
        eq(ch.filter((x) => x.chunk === '0' || x.chunk === '1').length, old01, 'seg-0/seg-1: 0 cargos nuevos');
        assert(![...by.other.keys()].length || [...by.other.values()].every((n) => n === 1), 'segmentos restantes una vez');
        await assertNoOrphans(R.rid, `R1-bis ${pace}`);
      });
    }

    // ═══ F10 — liquidar ANTES de registrar la cuarentena ═══════════════════════════════════════════════════════
    await check('F10 fuera de banda sin corrección: la reserva del segmento se LIQUIDA antes de registrar su cuarentena (un corte entre ambos nunca deja una reserva abierta tratada como resultado guardado)', async () => {
      ffCtl('ok');
      const R = await freshRun('r67 orden F10');
      paceFor({ k: 2, base: 230, instructions: 150, split: 150 });
      const seen = [];
      const watch = Object.create(sched);
      watch.recordItemExternal = async (id, ex, patch, ...rest) => {
        if (patch && patch.audioQuarantine && patch.audioRetryStrategy) {
          const [{ n }] = await ds.query(
            `select count(*)::int as n from public.generation_cost_events e where e.item_run_id = $1 and e.metadata->>'reservation' = 'true'
               and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)`, [id]);
          seen.push(n);
        }
        return sched.recordItemExternal(id, ex, patch, ...rest);
      };
      const row = await runAudio(R, { scheduler: watch });
      assert(row.status === 'retrying' && /^AUDIO_WPM_OUT_OF_RANGE/.test(row.error), row.error);
      eq(seen, [0], 'al registrar la cuarentena no queda ninguna reserva abierta');
      const persisted = LR.persistedPaidOpIds(row.output_summary);
      const open = await ds.query(`select e.idempotency_key from public.generation_cost_events e where e.item_run_id = $1 and e.metadata->>'reservation' = 'true'
         and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)`, [row.id]);
      eq(open.length, 0, 'sin reservas abiertas');
      assert(persisted.size > 0, 'requestIds de la cuarentena reconocidos');
    });

    // ═══ PO: datos históricos intactos ═══════════════════════════════════════════════════════════════════════
    await check('PO histórico: la pasada de huérfanos NO toca runs creados antes del corte (R67_AUTO_RECOVERY_SINCE) ni runs completed/cancelled/preview: la fila queda idéntica (sin updated_at)', async () => {
      ffCtl('ok');
      const snapRow = async (id) => JSON.stringify((await ds.query(`select to_jsonb(g) as j from public.generation_item_runs g where id = $1`, [id]))[0].j);
      const orphanize = async (R) => {
        paceFor({ k: 2, base: 230, instructions: 150, split: 150 });
        const row = await runAudio(R);
        eq(row.status, 'failed', 'failed');
        // Huérfano «de antes de r67»: failed B sin próxima acción ni motivo (como el cap. 2 de R1-bis).
        await ds.query(`update public.generation_item_runs set next_retry_at = null, attention_reason = null where id = $1`, [row.id]);
        return row.id;
      };
      const old = await freshRun('r67 histórico', { maxAttempts: 1 });
      const oldId = await orphanize(old);
      await ds.query(`update public.production_jobs set created_at = now() - interval '30 days' where id = $1`, [old.rid]);
      const done = await freshRun('r67 completado', { maxAttempts: 1 });
      const doneId = await orphanize(done);
      await ds.query(`update public.production_jobs set worker_status = 'completed', status = 'completed' where id = $1`, [done.rid]);
      const fresh = await freshRun('r67 vigente', { maxAttempts: 1 });
      const freshId = await orphanize(fresh);
      const b0 = [await snapRow(oldId), await snapRow(doneId)];
      const j0 = JSON.stringify((await ds.query(`select to_jsonb(p) as j from public.production_jobs p where id = $1`, [old.rid]))[0].j);
      const marked = await runs.markOrphanFailedItems(later(25 * 60));
      assert(!marked.includes(oldId) && !marked.includes(doneId), 'históricos / completados no se marcan');
      eq([await snapRow(oldId), await snapRow(doneId)], b0, 'filas byte-idénticas (incluido updated_at)');
      eq(JSON.stringify((await ds.query(`select to_jsonb(p) as j from public.production_jobs p where id = $1`, [old.rid]))[0].j), j0, 'run histórico intacto');
      assert(marked.includes(freshId), 'el run vigente (después del corte) sí se marca');
      eq((await itemRow(fresh.rid, fresh.key)).attention_reason, 'unrecoverable', 'vigente → unrecoverable');
    });
  } finally {
    fakes.plan.ttsPace = null;
    if (ds) await ds.destroy().catch(() => {});
    await fakes.close().catch(() => {});
    await new Promise((res) => storage.srv.close(() => res())).catch(() => {});
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  try {
    await pureChecks();
    if (!PURE_ONLY) await dbChecks();
  } finally {
    withoutFfmpeg();
    fs.rmSync(FAKE_BIN, { recursive: true, force: true });
    fs.rmSync(FF_STATE, { recursive: true, force: true });
  }
  console.log(`\n${passes} OK, ${failures} con fallas`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
