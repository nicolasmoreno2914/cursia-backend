#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — F2: proveedores REALES (Gamma + OpenAI TTS + guion LLM
// server-side) cableados en el dynamic-provider-worker, preflight v3 de
// startRun y duración medida del video desde el `mvhd` del MP4.
//
// NUNCA hay red externa: los proveedores son servidores FALSOS en 127.0.0.1
// (test/e2e-v2/fakes.js: startProviderFakes + startStorage); corré el script
// con netguard (NODE_OPTIONS=--require test/e2e-v2/netguard.js) para probarlo.
//
// Parte pura (siempre; --pure-only para CI):
//   - preflight de proveedores (qué falta; nombres de themeId = los de R9);
//   - v3 + videos ⇒ solo entrega YouTube;
//   - guiones: bienvenida desde course_intro, capítulo con 1 continuación, corto → fail loud;
//   - cuerpo de Gamma (es-419, themeId, pdf); duración final (mvhd > Videogen > unknown);
//   - YoutubeUploadService entrega los bytes del MP4 a onBeforeUpload (fetch stub local);
//   - worker real sin claves → provider_not_ready sin llamar; marcador sin id → ambiguo sin reenviar.
// Parte DB (default; PG16 desechable, puerto libre ≠ 5570): esquema real,
// RunsService/SchedulerService/Finops* y workers COMPILADOS + ArtifactsService
// real contra un Storage falso.
//
// Usage: node scripts/check-v21-providers.js [--pure-only] [path/to/dist]

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
const { Logger } = require('@nestjs/common');
const PR = loadDist('modules/dynamic-generation/provider-readiness.js');
const AS = loadDist('workers/provider-real/audio-scripts.js');
const RP = loadDist('workers/provider-real/real-providers.js');
const IW = loadDist('workers/dynamic-item-worker.js');
const PW = loadDist('workers/dynamic-provider-worker.js');
const VD = loadDist('workers/video-duration.js');
const PRES = loadDist('package/presentation/index.js');
const AUD = loadDist('package/audio/index.js');
const SM = loadDist('package/v3/synthetic-media.js');
const F = loadDist('modules/finops/index.js');
const H = loadDist('workers/finops-worker-hooks.js');
const AH = loadDist('modules/dynamic-generation/auto-heal.js');
const RC = loadDist('modules/dynamic-generation/run-completion.js');
const T = loadDist('modules/dynamic-generation/item-transitions.js');
const { startStorage, startProviderFakes, syntheticMp4WithMvhd } = require(path.join(REPO, 'test/e2e-v2/fakes.js'));

// Claves FALSAS con marcas únicas: el check verifica que nunca aparezcan en logs/errores/DB.
const SECRETS = {
  GAMMA_API_KEY: 'sk-f2-gamma-SECRET-9d1c7e',
  OPENAI_API_KEY: 'sk-f2-openai-SECRET-4b8a21',
  ANTHROPIC_API_KEY: 'sk-f2-anthropic-SECRET-77e0f3',
  VIDEOGEN_API_KEY: 'sk-f2-videogen-SECRET-a5c3d9',
};
const LOGS = [];
const capLogger = {
  log: (m) => LOGS.push(String(m)),
  warn: (m) => LOGS.push(String(m)),
  error: (m) => LOGS.push(String(m)),
};
// Nest Logger (servicios compilados): también capturado.
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
  assert(re.test(text), `${msg}: mensaje inesperado "${text.slice(0, 600)}"`);
  if (status !== undefined) assert(err.getStatus && err.getStatus() === status, `${msg}: status ${err.getStatus && err.getStatus()} (esperado ${status})`);
  return err;
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const READY_ENV = () => ({
  GAMMA_API_KEY: SECRETS.GAMMA_API_KEY,
  GAMMA_THEME_V21_LIGHT_DEFAULT: 'theme-f2-light',
  GAMMA_THEME_V21_DARK_DEFAULT: 'theme-f2-dark',
  OPENAI_API_KEY: SECRETS.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: SECRETS.ANTHROPIC_API_KEY,
  VIDEOGEN_API_KEY: SECRETS.VIDEOGEN_API_KEY,
});
const ALL_REAL = { presentation: 'real', audio: 'real' };

// ════════════════════════════════════════════════════════════════════════════
// Parte pura
// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  await check('puro: preflight — todo configurado → []; sin claves → lista EXACTA de lo que falta por proveedor (solo nombres)', () => {
    eq(PR.providerReadinessMissing({ providerModes: ALL_REAL, videoMode: 'real', videoCount: 2 }, READY_ENV()), [], 'listo');
    const miss = PR.providerReadinessMissing({ providerModes: ALL_REAL, videoMode: 'real', videoCount: 1 }, {});
    for (const k of ['presentation:GAMMA_API_KEY', 'audio:OPENAI_API_KEY', 'audio:ANTHROPIC_API_KEY', 'video:VIDEOGEN_API_KEY']) assert(miss.includes(k), `falta ${k}: ${miss}`);
    assert(miss.some((m) => m.startsWith('presentation:GAMMA_THEME_V21_')), 'themeIds');
    eq(PR.providerReadinessMissing({ providerModes: { presentation: 'mock', audio: 'mock' }, videoMode: 'mock', videoCount: 3 }, {}), [], 'todo mock no exige nada');
    eq(PR.providerReadinessMissing({ providerModes: { presentation: 'mock', audio: 'mock' }, videoMode: 'real', videoCount: 0 }, {}), [], 'video real sin videos no exige Videogen');
    const onlyAudio = PR.providerReadinessMissing({ providerModes: { presentation: 'mock', audio: 'real' }, videoMode: 'mock', videoCount: 1 }, { OPENAI_API_KEY: 'x' });
    eq(onlyAudio, ['audio:ANTHROPIC_API_KEY'], 'audio real: el guion LLM también');
    const msg = PR.providerNotReadyMessage(miss);
    assert(/^provider_not_ready: /.test(msg) && !Object.values(SECRETS).some((s) => msg.includes(s)), 'mensaje sin valores');
  });

  await check('puro: themeIds de Gamma — nombres de variable = los de R9 gammaThemeFor (específico gana; defaults por modo cubren todas las familias)', () => {
    const saved = { ...process.env };
    try {
      for (const k of Object.keys(process.env)) if (k.startsWith('GAMMA_THEME_V21_')) delete process.env[k];
      process.env[PR.gammaThemeEnvKey('oscuro-premium', 'dark')] = 'th-op-dark';
      process.env[PR.gammaThemeEnvKey('aula-clara', 'light')] = 'th-ac-light';
      eq([PRES.gammaThemeFor('oscuro-premium', 'dark'), PRES.gammaThemeFor('aula-clara', 'light')], ['th-op-dark', 'th-ac-light'], 'mismo nombre que R9');
      const m = PR.missingGammaThemes(process.env);
      assert(!m.some((x) => x.startsWith('GAMMA_THEME_V21_OSCURO_PREMIUM_DARK|')) && m.some((x) => x.startsWith('GAMMA_THEME_V21_TECNICO_DARK|')), `faltantes ${m}`);
      eq(PR.missingGammaThemes({ GAMMA_THEME_V21_LIGHT_DEFAULT: 'l', GAMMA_THEME_V21_DARK_DEFAULT: 'd' }), [], 'defaults cubren todo');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  await check('puro: v3 con videos ⇒ solo entrega YouTube (videogen_direct ⇒ v3_requires_youtube_delivery); sin videos da igual', () => {
    eq([PR.v3VideoDeliveryOk(2, 'youtube'), PR.v3VideoDeliveryOk(2, 'videogen_direct'), PR.v3VideoDeliveryOk(0, 'videogen_direct')], [true, false, true], 'reglas');
    assert(/^v3_requires_youtube_delivery: /.test(PR.v3RequiresYoutubeMessage('videogen_direct')), 'código');
  });

  await check('puro: guion de bienvenida = `welcome` del course_intro (sin LLM); sin texto → AUDIO_WELCOME_TEXT_MISSING', () => {
    eq(AS.welcomeScriptFromCourseIntro({ welcome: '**Bienvenida** al curso.\n\nVamos.' }), 'Bienvenida al curso. Vamos.', 'limpio');
    assert(/AUDIO_WELCOME_TEXT_MISSING/.test((() => { try { AS.welcomeScriptFromCourseIntro({}); } catch (e) { return e.message; } })()), 'falta');
  });

  await check('puro (r19): guion por BLOQUE del capítulo — 1 llamada en la banda 85–110 %; corto → UNA continuación; sigue corto → AUDIOBOOK_SECTION_TOO_SHORT (fail loud); el plan cubre todo el capítulo', async () => {
    const md = '# Bombas\n\nTexto **real** del capítulo con una introducción breve.\n\n## Mantenimiento\n\n' + Array.from({ length: 30 }, (_, i) => `Paso ${i} del mantenimiento preventivo de la bomba.`).join(' ');
    const input = { courseTitle: 'Curso', chapterNumber: 2, chapterTitle: 'Bombas', sector: 'Minería', nivel: 'Intermedio', contentMarkdown: md };
    const plan = AS.planAudiobookSections(md);
    eq(plan.narratableWords, AS.wordCount(AS.cleanAudioText(md)), 'el plan cubre todas las palabras');
    const sec = plan.sections[0];
    const t = AS.sectionTargetWords(sec.words);
    const w = (n) => sec.text.split(/\s+/).slice(0, n).join(' ');
    let calls = [];
    const r1 = await AS.generateSectionScript(input, sec, plan.sections.length, null, async (p, role) => { calls.push(role); return { text: w(t.target), messageId: 'msg_a' }; });
    eq([calls, r1.words, r1.continued, r1.messageIds], [['main'], t.target, false, ['msg_a']], 'una llamada');
    calls = [];
    const r2 = await AS.generateSectionScript(input, sec, plan.sections.length, null, async (p, role) => { calls.push(role); return { text: role === 'main' ? w(Math.round(t.target / 2)) : w(t.target - Math.round(t.target / 2)), messageId: `msg_${role}` }; });
    eq([calls, r2.continued, r2.messageIds], [['main', 'continuation'], true, ['msg_main', 'msg_continuation']], 'continuación');
    const err = await rejectsRe(AS.generateSectionScript(input, sec, 1, null, async () => ({ text: w(10), messageId: 'm' })), /AUDIOBOOK_SECTION_TOO_SHORT/, 'corto');
    eq(err.retryable, true, 'reintentable');
    const p = AS.sectionNarrationPrompt(input, sec, plan.sections.length, null);
    assert(/NO un resumen/.test(p.system) && /Capítulo 2 — Bombas/.test(p.user) && /orientado a Minería, nivel Intermedio/.test(p.user) && p.user.includes(sec.text) && !/\*\*/.test(p.user), 'prompt');
    const chunks = AS.splitForTts(`${'Oración de prueba. '.repeat(400)}`);
    assert(chunks.length >= 2 && chunks.every((c) => c.length <= AS.TTS_MAX_CHARS && c.length > 0), `chunks ${chunks.map((c) => c.length)}`);
  });

  await check('puro: cuerpo de Gamma — textOptions.language es-419, themeId del tema, 10 tarjetas, export PDF, texto limpio', () => {
    const b = RP.gammaGenerationBody({ chapterTitle: 'Cap 1', contentMarkdown: '## Título\n**negrita**', themeId: 'th-1' });
    eq([b.textOptions.language, b.themeId, b.numCards, b.exportAs, b.format], ['es-419', 'th-1', 10, 'pdf', 'presentation'], 'campos');
    assert(b.inputText === 'Cap 1\n\nTítulo negrita', `inputText ${JSON.stringify(b.inputText)}`);
    // R14: Gamma (textMode generate) no debe inventar cifras/fuentes y usa tuteo.
    assert(/No agregues cifras, porcentajes/.test(b.additionalInstructions) && /tuteo/.test(b.additionalInstructions), 'instrucciones de veracidad/tuteo');
  });

  await check('puro: duración final del video — mvhd del MP4 > Videogen (unidad conocida) > unknown; el MP4 sintético del fake tiene un mvhd real', () => {
    eq(VD.parseMp4DurationSec(syntheticMp4WithMvhd(468)), 468, 'mvhd 468');
    eq(IW.finalVideoDuration({ durationSec: 300, durationSource: 'mp4_mvhd' }, { durationSec: 468, durationSource: 'videogen_status' }), { durationSec: 300, durationSource: 'mp4_mvhd' }, 'mvhd primero');
    eq(IW.finalVideoDuration(null, { durationSec: 468, durationSource: 'videogen_status' }), { durationSec: 468, durationSource: 'videogen_status' }, 'Videogen secundaria');
    eq(IW.finalVideoDuration({ durationSec: null, durationSource: 'unknown' }, { durationSec: null, durationSource: 'unknown' }), { durationSec: null, durationSource: 'unknown' }, 'nada');
    eq(IW.finalVideoDuration({ durationSec: 99999, durationSource: 'mp4_mvhd' }, {}), { durationSec: null, durationSource: 'unknown' }, 'fuera de rango');
  });

  await check('puro: YoutubeUploadService entrega los bytes del MP4 descargado a onBeforeUpload ANTES de contactar a YouTube (fetch stub local, sin red)', async () => {
    const { YoutubeUploadService } = loadDist('youtube/youtube-upload.service.js');
    const mp4 = syntheticMp4WithMvhd(321, 'stub');
    const origFetch = global.fetch;
    const seen = [];
    global.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).startsWith('http://127.0.0.1:1/video.mp4')) return new Response(mp4, { status: 200 });
      throw new Error('stop-after-onBeforeUpload');
    };
    try {
      const svc = new YoutubeUploadService({ getAccessToken: async () => 'tok' });
      let got = null;
      await rejectsRe(svc.uploadFromUrl({ userId: 'u', status: 'active', encryptedRefreshToken: 'x', tokenIv: 'y' }, {
        downloadUrl: 'http://127.0.0.1:1/video.mp4', title: 't',
        onBeforeUpload: async (b) => { got = b; },
      }), /stop-after-onBeforeUpload|YouTube/, 'corta en el primer contacto');
      assert(Buffer.isBuffer(got) && got.equals(mp4), 'bytes entregados');
      eq(VD.parseMp4DurationSec(got), 321, 'mvhd legible');
      eq(seen.length, 2, 'descarga + primer contacto');
    } finally {
      global.fetch = origFetch;
    }
  });

  await check('puro: worker real sin claves → provider_not_ready (no reintentable) ANTES de llamar; marcador de envío sin generationId → gamma_submit_ambiguous sin reenviar', async () => {
    const fakes = startProviderFakes({ gammaKey: SECRETS.GAMMA_API_KEY, openaiKey: SECRETS.OPENAI_API_KEY, anthropicKey: SECRETS.ANTHROPIC_API_KEY, makePdf: SM.syntheticPdf, makeMp3: SM.syntheticMp3 });
    const urls = await fakes.listen();
    try {
      const mk = (env, summary = {}) => {
        const calls = { fails: [], completes: [], blocked: [] };
        return {
          calls,
          deps: {
            scheduler: {
              async claimNextItem() { return null; },
              async completeItem(id, e, o) { calls.completes.push(o); return true; },
              async failItem(id, e, err, retry) { calls.fails.push({ err, retry }); return true; },
              async blockItemForBudget(id, e, m) { calls.blocked.push(m); return true; },
              async recordItemExternal() { return true; },
            },
            dataSource: { async query() { return [{ owner_id: 'owner-1', input_payload: { providerModes: ALL_REAL } }]; } },
            artifacts: { async uploadJsonArtifact() { throw new Error('no debería subir'); } },
            logger: capLogger, executorId: 'ex', leaseSeconds: 60, env,
            budget: { async guardPaidSubmission() { return { allow: true, decision: 'ALLOW', committed: '0', remaining: '9', reason: 'test', authorizedBudget: '9' }; } },
          },
          item: (type) => ({ itemRunId: 'ir', runId: 'run', courseId: 1, artifactCourseId: 'c', manifestId: 1, itemKey: `${type}:x`, type, chapterId: 'ch', chapterNumber: 1, idempotencyKey: 'k', attempt: 1, outputSummary: summary, dependencyArtifacts: [] }),
        };
      };
      const base = { GAMMA_API_BASE_URL: urls.gammaUrl, OPENAI_API_BASE_URL: urls.openaiUrl, ANTHROPIC_API_BASE_URL: urls.anthropicUrl };
      for (const [type, need] of [['presentation', /GAMMA_API_KEY/], ['audio_welcome', /OPENAI_API_KEY/], ['audiobook_chapter', /OPENAI_API_KEY, ANTHROPIC_API_KEY/]]) {
        const t = mk({ ...base });
        await rejectsRe(PW.processProviderItem(t.deps, t.item(type)), /^provider_not_ready/, type);
        assert(t.calls.fails.length === 1 && t.calls.fails[0].retry === false && need.test(t.calls.fails[0].err), `${type}: ${JSON.stringify(t.calls.fails)}`);
      }
      const amb = mk({ ...base, GAMMA_API_KEY: SECRETS.GAMMA_API_KEY }, { externalSubmitStartedAt: '2026-09-26T00:00:00Z' });
      await rejectsRe(PW.processProviderItem(amb.deps, amb.item('presentation')), /^gamma_submit_ambiguous/, 'ambiguo');
      eq([amb.calls.fails[0].retry, amb.calls.completes.length], [false, 0], 'no reintentable');
      eq([fakes.st.gammaPosts.length, fakes.st.tts.length, fakes.st.llm.length], [0, 0, 0], '0 llamadas a los proveedores');
    } finally {
      await fakes.close();
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Parte DB
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
const CONTEXT = { nombre: 'Curso F2', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const PROVIDER_ENV_KEYS = ['GAMMA_API_KEY', 'GAMMA_THEME_V21_LIGHT_DEFAULT', 'GAMMA_THEME_V21_DARK_DEFAULT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VIDEOGEN_API_KEY'];
const ENV_KEYS = [
  'DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED',
  'DYNAMIC_ALLOW_PROVIDER_MOCK', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GAMMA_API_BASE_URL', 'OPENAI_API_BASE_URL',
  'ANTHROPIC_API_BASE_URL', 'DYNAMIC_ALLOW_VIDEO_PREVIEW', 'SUPER_ADMIN_EMAILS', ...PROVIDER_ENV_KEYS,
];

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
  const SHELL = loadDist('modules/course-shell/index.js');

  const pgBin = findPgBin();
  const port = await freePort();
  assert(port !== 5570, 'puerto 5570 prohibido');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-f2-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-f2-cwd-'));
  const ROLE = 'postgres.f2localtest01';
  const DB = 'f2db';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let ds = null;
  const storage = startStorage();
  const fakes = startProviderFakes({ gammaKey: SECRETS.GAMMA_API_KEY, openaiKey: SECRETS.OPENAI_API_KEY, anthropicKey: SECRETS.ANTHROPIC_API_KEY, makePdf: SM.syntheticPdf, makeMp3: SM.syntheticMp3 });
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
    // Esquema real de staging (mismo orden que check-v21-finops-wiring).
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
        'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    {
      const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({}));
      assert(res.code === 0, `migrate-production-jobs-constraints: ${res.out}`);
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

    // Fakes locales (Storage + Gamma/OpenAI/Anthropic), todos en 127.0.0.1.
    await new Promise((res) => storage.srv.listen(0, '127.0.0.1', res));
    const storageUrl = `http://127.0.0.1:${storage.srv.address().port}`;
    const urls = await fakes.listen();
    for (const u of [storageUrl, urls.gammaUrl, urls.openaiUrl, urls.anthropicUrl]) assert(/^http:\/\/127\.0\.0\.1:\d+/.test(u), `fake fuera de loopback: ${u}`);

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    delete process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT;
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    delete process.env.DYNAMIC_ALLOW_PROVIDER_MOCK;
    // EV6 DoD (BE-A): los casos con video de vista previa usan el escape de QA (los de proveedores reales no cambian).
    process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW = 'true';
    process.env.SUPER_ADMIN_EMAILS = 'admin@cursia.test';
    process.env.SUPABASE_URL = storageUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-local-only';
    process.env.GAMMA_API_BASE_URL = urls.gammaUrl;
    process.env.OPENAI_API_BASE_URL = urls.openaiUrl;
    process.env.ANTHROPIC_API_BASE_URL = urls.anthropicUrl;
    const setReady = () => Object.assign(process.env, READY_ENV());
    const clearProviders = () => { for (const k of PROVIDER_ENV_KEYS) delete process.env[k]; };

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const ytOk = { async check() { return { ok: true }; } };
    const runs = new RunsService(ds, manifests, {}, ytOk, budget);
    const sched = new SchedulerService(ds, runs);
    const artifacts = new ArtifactsService(ds.getRepository(Artifact), { get: (k) => process.env[k] });

    /** Curso v3 (Blueprint v2): C1 con video + actividad, C2 sin video. */
    async function makeCourse(title, { videos = true } = {}) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: videos, activity_enabled: true },
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
      const res = await manifests.getOrCreate(cid, OWNER, 1);
      eq(res.manifest.rulesVersion, 3, 'Manifest v3');
      return { cid, c1, c2, m1, manifest: res.manifest };
    }
    const jobsOf = async (cid) => (await ds.query(`select count(*)::int n from public.production_jobs where course_id = $1`, [cid]))[0].n;
    const estimatesOf = async (cid) => (await ds.query(`select count(*)::int n from public.cost_estimates where course_id = $1`, [cid]))[0].n;
    const itemRow = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const events = (where, p) => ds.query(`select *, amount::text as amount from public.generation_cost_events where ${where} order by created_at, id`, p);

    /** Completa por SQL un item de dependencia (LLM del navegador) con un artifact real en el Storage falso. */
    async function seedDependency(runId, key, type, body, mime) {
      const row = await itemRow(runId, key);
      const p = `${OWNER}/dynamic/f2/${runId}/${key.replace(/[^A-Za-z0-9._-]/g, '_')}.${type}`;
      storage.blobs.set(`cursia-artifacts/${p}`, Buffer.from(body));
      await ds.query(
        `insert into public.artifacts (owner_id, course_id, job_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, metadata, module_id, chapter_id, manifest_id, manifest_item_key, item_run_id)
         values ($1, $2, $3, $4, 'supabase', 'cursia-artifacts', $5, 'f', $6, '{}'::jsonb, $7, $8, $9, $10, $11)`,
        [OWNER, String(row.course_id), runId, type, p, mime, row.module_id, row.chapter_id, row.manifest_id, key, row.id]);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where id = $1`, [row.id]);
    }
    const CONTENT_MD = (t) => `# ${t}\n\nLa bomba de engranajes mueve el aceite a presión constante. El técnico revisa ruido, temperatura y caudal en cada turno.\n\n## Mantenimiento\n\nSe cambia el filtro y se registra la presión.`;

    const workerDeps = (over = {}) => ({
      scheduler: sched, dataSource: ds, artifacts, logger: capLogger, executorId: 'f2-provider-worker', leaseSeconds: 120,
      finops: ledger, budget, gammaPollMs: 20, gammaTimeoutMs: 3000, ...over,
    });
    const claimProvider = (runId, type) => sched.claimNextItem({ executorId: 'f2-provider-worker', types: [type], leaseSeconds: 120, runId });

    // ═══ Preflight v3 en startRun ═══════════════════════════════════════════
    const P = await makeCourse('Curso preflight');
    await check('DB preflight: Gamma sin clave → 409 provider_not_ready con la lista (solo nombres), ANTES de escribir nada (0 runs, 0 estimados)', async () => {
      setReady(); delete process.env.GAMMA_API_KEY;
      const err = await rejectsRe(runs.startRun(P.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' }), /^provider_not_ready/, 'sin Gamma', 409);
      const body = err.getResponse();
      eq([body.code, body.missing], ['provider_not_ready', ['presentation:GAMMA_API_KEY']], 'faltante exacto');
      assert(!Object.values(SECRETS).some((s) => JSON.stringify(body).includes(s)), 'el 409 no lleva ninguna clave');
      eq([await jobsOf(P.cid), await estimatesOf(P.cid)], [0, 0], 'nada escrito');
    });
    await check('DB preflight: themeIds de Gamma ausentes → provider_not_ready lista GAMMA_THEME_V21_* por familia/modo', async () => {
      setReady(); delete process.env.GAMMA_THEME_V21_DARK_DEFAULT;
      const err = await rejectsRe(runs.startRun(P.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' }), /^provider_not_ready/, 'sin theme dark', 409);
      const miss = err.getResponse().missing;
      assert(miss.length >= 2 && miss.every((m) => /^presentation:GAMMA_THEME_V21_[A-Z_]+_DARK\|GAMMA_THEME_V21_DARK_DEFAULT$/.test(m)), `faltantes ${miss}`);
      eq(await jobsOf(P.cid), 0, 'sin run');
    });
    await check('DB preflight: TTS / guion LLM / Videogen sin clave → provider_not_ready con audio:OPENAI_API_KEY, audio:ANTHROPIC_API_KEY, video:VIDEOGEN_API_KEY', async () => {
      setReady(); delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.VIDEOGEN_API_KEY;
      const err = await rejectsRe(runs.startRun(P.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' }), /^provider_not_ready/, 'sin audio/video', 409);
      eq(err.getResponse().missing, ['audio:OPENAI_API_KEY', 'audio:ANTHROPIC_API_KEY', 'video:VIDEOGEN_API_KEY'], 'faltantes');
      // Video mock: Videogen no se exige.
      const e2 = await rejectsRe(runs.startRun(P.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' }), /^provider_not_ready/, 'video mock', 409);
      eq(e2.getResponse().missing, ['audio:OPENAI_API_KEY', 'audio:ANTHROPIC_API_KEY'], 'sin video');
      eq(await jobsOf(P.cid), 0, 'sin run');
    });
    await check('DB preflight: v3 + videos + entrega videogen_direct (real con el escape de staging, o mock) → 409 v3_requires_youtube_delivery; sin videos no aplica', async () => {
      setReady();
      process.env.DYNAMIC_VIDEO_DELIVERY = 'videogen_direct';
      process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT = 'true';
      try {
        const e1 = await rejectsRe(runs.startRun(P.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' }), /^v3_requires_youtube_delivery/, 'real directo', 409);
        eq([e1.getResponse().code, e1.getResponse().videoDelivery], ['v3_requires_youtube_delivery', 'videogen_direct'], 'cuerpo');
        await rejectsRe(runs.startRun(P.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' }), /^v3_requires_youtube_delivery/, 'mock directo', 409);
        eq([await jobsOf(P.cid), await estimatesOf(P.cid)], [0, 0], 'nada escrito');
        const NV = await makeCourse('Curso sin videos', { videos: false });
        // Sin videos el preflight pasa y sigue el gate de presupuesto (RF) de siempre.
        await rejectsRe(runs.startRun(NV.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' }), /^budget_approval_required/, 'sin videos → presupuesto', 409);
      } finally {
        process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
        delete process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT;
      }
    });

    // ═══ Run real (proveedores FALSOS) ══════════════════════════════════════
    const C = await makeCourse('Curso real F2');
    let runId = null;
    await check('DB preflight OK → el gate de presupuesto (RF) sigue: 409 budget_approval_required; aprobación ADMIN → 201 con providerModes real congelados', async () => {
      setReady();
      const err = await rejectsRe(runs.startRun(C.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' }), /^budget_approval_required/, 'pide aprobación', 409);
      const body = err.getResponse();
      eq(body.paidRealProviders, ['gamma', 'openai', 'videogen'], 'proveedores pagados');
      await budget.adminAuthorize({ courseId: C.cid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test', reason: 'check F2' });
      const res = await runs.startRun(C.cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' });
      eq([res.created, res.run.videoDelivery], [true, 'youtube'], 'creado');
      runId = res.run.id;
      const [job] = await ds.query(`select input_payload from public.production_jobs where id = $1`, [runId]);
      eq([job.input_payload.providerModes.presentation, job.input_payload.providerModes.audio], ['real', 'real'], 'congelados real');
    });

    // Dependencias LLM completadas (contenido + course_intro) con artifacts reales en el Storage falso.
    await seedDependency(runId, `content:${C.c1}`, 'dynamic_content_md', JSON.stringify({ markdown: CONTENT_MD('Bombas') }), 'text/markdown');
    await seedDependency(runId, `content:${C.c2}`, 'dynamic_content_md', CONTENT_MD('Válvulas'), 'text/markdown');
    await seedDependency(runId, `course_intro:${C.cid}`, 'dynamic_course_intro_json',
      JSON.stringify({ schemaVersion: 1, welcome: 'Te damos la bienvenida al curso de hidráulica de planta. Vas a recorrer bombas y válvulas con ejemplos del turno.' }), 'application/json');

    await check('DB budget guard: autorización revocada (BLOCKED) → presentation `blocked` budget_exceeded ANTES de llamar a Gamma (0 envíos); nueva ADMIN_APPROVED + retry → reanudable', async () => {
      const [est] = await ds.query(`select id from public.cost_estimates where run_id = $1 and scope = 'run'`, [runId]);
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, estimate_id, authorized_budget, decision, reason) values ($1, $2, $3, 0, 'BLOCKED', 'check F2: revocado')`, [runId, C.cid, est.id]);
      const item = await claimProvider(runId, 'presentation');
      assert(item, 'claim');
      await PW.processProviderItem(workerDeps(), item);
      const row = await itemRow(runId, item.itemKey);
      eq(row.status, 'blocked', 'bloqueado');
      assert(/^budget_exceeded: no_authorization/.test(row.error), row.error);
      eq(fakes.st.gammaPosts.length, 0, '0 envíos a Gamma');
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, estimate_id, authorized_budget, decision, approved_by, reason) values ($1, $2, $3, 500, 'ADMIN_APPROVED', 'admin@cursia.test', 'check F2: reautorizado')`, [runId, C.cid, est.id]);
      const retried = await runs.retryItem(C.cid, OWNER, 1, runId, item.itemKey);
      eq(retried.status, 'pending', 'reanudado');
    });

    // Calibración #2: cada llamada pagada deja una RESERVA durable (CHARGE pending, metadata.reservation) que se
    // liquida a 0 (ADJUSTMENT) en la misma transacción que el cargo final por el id del proveedor.
    const finalCharges = (where, params) => events(`${where} and event_kind = 'CHARGE' and coalesce(metadata->>'reservation', 'false') <> 'true'`, params);
    const reservationsOf = async (itemRunId, provider) => {
      const rows = await events(`item_run_id = $1 and provider = $2 and event_kind = 'CHARGE' and metadata->>'reservation' = 'true'`, [itemRunId, provider]);
      for (const r of rows) r.settled = (await events(`corrects_event_id = $1`, [r.id])).length > 0;
      return rows;
    };
    let genId1 = null;
    await check('DB Gamma (fake) happy path: es-419 + themeId del tema del curso; PDF + portada medidos (pdfPageCount/pngDimensions) y subidos; artifact R9 válido; completed', async () => {
      const item = await claimProvider(runId, 'presentation');
      assert(item && item.chapterId === C.c1, `claim ${item && item.itemKey}`);
      await PW.processProviderItem(workerDeps(), item);
      const row = await itemRow(runId, item.itemKey);
      eq(row.status, 'completed', `estado (${row.error})`);
      eq(fakes.st.gammaPosts.length, 1, 'un envío');
      const sent = fakes.st.gammaPosts[0];
      eq([sent.textOptions.language, sent.themeId, sent.exportAs, sent.numCards], ['es-419', 'theme-f2-light', 'pdf', 10], 'request (aula-clara/light por defecto)');
      assert(sent.inputText.startsWith('Bombas\n\n') && /bomba de engranajes/.test(sent.inputText), 'contenido del capítulo');
      genId1 = row.output_summary.external.gammaGenerationId;
      assert(/^gen_f2_/.test(genId1), `generationId ${genId1}`);
      const [art] = await ds.query(`select * from public.artifacts where item_run_id = $1 and type = 'dynamic_presentation'`, [row.id]);
      const pres = JSON.parse(storage.blobs.get(`cursia-artifacts/${art.storage_path}`).toString('utf8'));
      eq(PRES.validatePresentationArtifact(pres), [], 'contrato R9');
      const pdf = storage.blobs.get(`cursia-artifacts/${pres.pdf.storagePath}`);
      const cover = storage.blobs.get(`cursia-artifacts/${pres.cover.storagePath}`);
      eq([sha256(pdf), sha256(cover)], [pres.pdf.sha256, pres.cover.sha256], 'sha de los archivos');
      eq([pres.slideCount, PRES.pdfPageCount(pdf)], [10, 10], 'slideCount medido');
      const dims = PRES.pngDimensions(cover);
      eq([pres.cover.width, pres.cover.height], [dims.width, dims.height], 'portada medida');
      eq([pres.gammaGenerationId, pres.gammaThemeId, pres.themeFamilyAtGeneration, pres.themeModeAtGeneration, pres.mock], [genId1, 'theme-f2-light', 'aula-clara', 'light', undefined], 'campos');
      assert(pres.pdf.storagePath.startsWith(`${OWNER}/`), 'en la carpeta del dueño (el empaque lo exige)');
      eq(art.metadata.mock, undefined, 'artifact real (no mock)');
    });

    await check('DB ledger Gamma (calibración #2): reserva durable ANTES del envío (p90 = 100 créditos × 0.01) → al terminar UN cargo medido por generationId (42 créditos) + reserva a 0, atómico ⇒ neto 0.42; atribuido; liquidar de nuevo = no-op', async () => {
      // Calibración #2: reserva durable ANTES del envío (p90 = 100 créditos × 0.01) → al terminar, UN cargo
      // medido por generationId (42 créditos) + la reserva a 0, en la misma transacción. Neto = 0.42.
      const evs = await events(`provider = 'gamma'`, []);
      eq(evs.map((x) => x.event_kind).sort(), ['ADJUSTMENT', 'CHARGE', 'CHARGE'], 'reserva + su liquidación + cargo final');
      const [resv] = await reservationsOf(evs[0].item_run_id, 'gamma');
      eq([resv.measurement_status, resv.metadata.reservedBeforeCall, new RegExp(`^reservation:gamma:${resv.item_run_id}:g1:a\\d+:submit$`).test(resv.idempotency_key), near(resv.amount, 1.0), resv.settled],
        ['pending', true, true, true, true], 'reserva previa al envío, liquidada');
      const [e] = await finalCharges(`provider = 'gamma'`, []);
      eq([e.cost_source, e.operation, e.external_operation_id, e.idempotency_key, e.billing_account, e.measurement_status, e.item_key, e.run_id, e.recorded_by, Number(e.usage.gamma_credit), e.metadata.creditsRemaining],
        ['CALCULATED_FROM_USAGE', 'gamma.generate', genId1, `gamma:gen:${genId1}`, 'cursia', 'final', `presentation:${C.c1}`, runId, 'dynamic-provider-worker', 42, 958], 'cargo final medido');
      const net = evs.reduce((a, x) => a + Number(x.amount), 0);
      assert(near(net, 0.42), `neto ${net}`);
      const again = await H.settleGammaCharge(ledger, { ownerId: OWNER, itemRunId: e.item_run_id, generationId: genId1, creditsDeducted: 42, creditsRemaining: 958 });
      eq((await events(`provider = 'gamma'`, [])).length, 3, 'liquidar otra vez no agrega filas (misma operación = un cargo)');
      assert(again === 'already_final', again);
    });

    await check('DB Gamma reanudación: generación lenta → gamma_timeout reintentable CON el generationId guardado; el re-claim sigue polleando la MISMA generación (0 reenvíos)', async () => {
      fakes.plan.gammaHoldPending = true;
      const item = await claimProvider(runId, 'presentation');
      assert(item && item.chapterId === C.c2, 'claim C2');
      await PW.processProviderItem(workerDeps({ gammaTimeoutMs: 150 }), item);
      let row = await itemRow(runId, item.itemKey);
      eq(row.status, 'retrying', `estado ${row.status} ${row.error}`);
      assert(/^gamma_timeout/.test(row.error), row.error);
      const gid = row.output_summary.external.gammaGenerationId;
      assert(gid && row.output_summary.externalSubmitStartedAt, 'id + marcador persistidos');
      eq(fakes.st.gammaPosts.length, 2, 'un envío más (C2)');
      // El timeout deja la reserva previa al envío PENDIENTE y el presupuesto la cuenta.
      const pend = await reservationsOf(row.id, 'gamma');
      eq(pend.map((x) => [x.measurement_status, x.settled, x.idempotency_key === row.output_summary.externalReservationKey]), [['pending', false, true]], 'reserva pendiente tras el timeout');
      const actual = await budget.runActual(runId);
      const sumRun = (await ds.query(`select coalesce(sum(amount),0)::text t from public.generation_cost_events where run_id = $1`, [runId]))[0].t;
      assert(near(actual, sumRun) && Number(actual) >= 1.0 + 0.42, `runActual ${actual} incluye la reserva`);
      fakes.plan.gammaHoldPending = false;
      await ds.query(`update public.generation_item_runs set next_retry_at = now() where id = $1`, [row.id]);
      const again = await claimProvider(runId, 'presentation');
      assert(again && again.itemRunId === row.id && again.outputSummary.external.gammaGenerationId === gid, 're-claim con el id');
      await PW.processProviderItem(workerDeps(), again);
      row = await itemRow(runId, item.itemKey);
      eq(row.status, 'completed', `completado (${row.error})`);
      eq(fakes.st.gammaPosts.length, 2, 'NINGÚN reenvío');
      eq((await finalCharges(`provider = 'gamma' and external_operation_id = $1`, [gid])).map((x) => x.measurement_status), ['final'], 'UN cargo por la generación');
      eq((await reservationsOf(row.id, 'gamma')).map((x) => x.settled), [true], 'la reserva quedó liquidada');
    });

    await check('DB TTS bienvenida: texto `welcome` del course_intro (sin LLM) → OpenAI TTS falso; MP3 real subido; duración medida (mp3DurationSeconds) en metadata; ledger por x-request-id', async () => {
      const llm0 = fakes.st.llm.length;
      const tts0 = fakes.st.tts.length;
      const item = await claimProvider(runId, 'audio_welcome');
      assert(item, 'claim');
      await PW.processProviderItem(workerDeps(), item);
      const row = await itemRow(runId, item.itemKey);
      eq(row.status, 'completed', `estado (${row.error})`);
      eq([fakes.st.llm.length - llm0, fakes.st.tts.length - tts0], [0, 1], 'sin LLM, 1 TTS');
      const call = fakes.st.tts[tts0];
      eq([call.model, call.voice, call.response_format], ['gpt-4o-mini-tts', 'marin', 'mp3'], 'request');
      const [art] = await ds.query(`select * from public.artifacts where item_run_id = $1 and type = 'dynamic_audio_mp3'`, [row.id]);
      const mp3 = storage.blobs.get(`cursia-artifacts/${art.storage_path}`);
      eq(art.mime_type, 'audio/mpeg', 'mime');
      eq(art.metadata.durationSeconds, AUD.mp3DurationSeconds(mp3), 'duración medida');
      // UX r18 fix 1 (C1): la bienvenida de UNA parte también pasa por concatMp3 → frame Info con el conteo real.
      const pm = AUD.parseMp3(mp3);
      assert(pm.hasXing && pm.xingFrames === pm.frames.length - 1, `frame Info de la bienvenida (${pm.hasXing}, ${pm.xingFrames} vs ${pm.frames.length - 1})`);
      const evs = await finalCharges(`item_run_id = $1`, [row.id]);
      eq(evs.map((e) => [e.provider, e.operation, e.cost_source, e.external_operation_id, e.idempotency_key]),
        [['openai', 'tts.audio_welcome', 'CALCULATED_FROM_USAGE', call.requestId, `openai:req:${call.requestId}`]], 'evento');
      eq((await reservationsOf(row.id, 'openai')).map((x) => [x.idempotency_key, x.settled]), [[`reservation:tts:${row.id}:g1:a1:chunk0`, true]], 'reserva del chunk liquidada');
      assert(near(evs[0].amount, (AUD.mp3DurationSeconds(mp3) / 60) * 0.015), `monto ${evs[0].amount} (segundos medidos × 0.015/min)`);
      eq(evs[0].usage_unit, 'audio_seconds', 'medidor = segundos de audio (nunca caracteres)');
    });

    await check('DB audiolibro: guion LLM server-side (corto → 1 continuación) medido en el ledger (msg_…, CALCULATED_FROM_USAGE, llm.audiobook_script) + TTS; guion persistido; MP3 con duración medida', async () => {
      fakes.plan.llmShortFirst = 1;
      const llm0 = fakes.st.llm.length;
      const item = await claimProvider(runId, 'audiobook_chapter');
      assert(item && item.chapterId === C.c1, `claim ${item && item.itemKey}`);
      await PW.processProviderItem(workerDeps(), item);
      const row = await itemRow(runId, item.itemKey);
      eq(row.status, 'completed', `estado (${row.error})`);
      const calls = fakes.st.llm.slice(llm0);
      eq([calls.length, calls[0].continuation, calls[1].continuation, calls[0].model], [2, false, true, 'claude-sonnet-4-6'], 'main + continuación');
      // r19: guion por bloque, persistido apenas se acepta (aquí el capítulo es un solo bloque).
      const s = row.output_summary.audiobookSections && row.output_summary.audiobookSections['0'];
      assert(s && s.ratio >= 0.85 && s.ratio <= 1.1 && s.continued && s.messageIds.join() === calls.map((c) => c.id).join(), `guion persistido ${JSON.stringify(s && [s.words, s.ratio])}`);
      const llmEv = await finalCharges(`item_run_id = $1 and provider = 'anthropic'`, [row.id]);
      eq((await reservationsOf(row.id, 'anthropic')).map((x) => x.settled), [true, true], 'reservas LLM liquidadas');
      eq(llmEv.map((e) => [e.operation, e.call_role, e.cost_source, e.external_operation_id, e.idempotency_key]),
        calls.map((c, i) => ['llm.audiobook_script', i === 0 ? 'main' : 'continuation', 'CALCULATED_FROM_USAGE', c.id, `anthropic:msg:${c.id}`]), 'eventos LLM');
      assert(near(llmEv[0].amount, 1200 * 3 / 1e6 + 640 * 15 / 1e6), `monto main ${llmEv[0].amount}`);
      const ttsEv = await finalCharges(`item_run_id = $1 and provider = 'openai'`, [row.id]);
      assert(ttsEv.length >= 1 && ttsEv.every((e) => e.operation === 'tts.audiobook_chapter' && e.cost_source === 'CALCULATED_FROM_USAGE' && /^req_f2_/.test(e.external_operation_id)), 'eventos TTS');
      const [art] = await ds.query(`select * from public.artifacts where item_run_id = $1 and type = 'dynamic_audio_mp3'`, [row.id]);
      const mp3 = storage.blobs.get(`cursia-artifacts/${art.storage_path}`);
      eq(art.metadata.durationSeconds, AUD.mp3DurationSeconds(mp3), 'duración medida');
      assert(art.metadata.scriptSha256 === sha256(s.text) && art.metadata.words === s.words, 'guion en el artifact');
      const man = art.metadata.audiobookManifest;
      eq(AUD.validateChapterAudioManifest(man), [], 'manifiesto válido en el artifact');
      eq(row.output_summary.audiobookManifest, man, 'y en el summary del item');
      eq([man.audio.seconds, man.audio.infoFrameSeconds], [art.metadata.durationSeconds, art.metadata.durationSeconds], 'Info = frames');
    });

    await check('DB audiolibro (calibración #2): TTS 500 tras el guion = gasto posible → RECONCILIACIÓN (no reintentable), reserva pendiente; un retry común NO vuelve a llamar; resubmitProvider explícito reutiliza el guion (0 LLM) y completa', async () => {
      fakes.plan.ttsFail = [500];
      const llm0 = fakes.st.llm.length;
      const tts0 = fakes.st.tts.length;
      const item = await claimProvider(runId, 'audiobook_chapter');
      assert(item && item.chapterId === C.c2, 'claim C2');
      await rejectsRe(PW.processProviderItem(workerDeps(), item), /^provider_reconciliation_required/, 'reconciliación');
      let row = await itemRow(runId, item.itemKey);
      eq(row.status, 'failed', `estado ${row.status} ${row.error}`);
      assert(/tts_failed/.test(row.error) && row.output_summary.audiobookSections && row.output_summary.audiobookSections['0'], 'guion guardado + motivo');
      const resv = await reservationsOf(row.id, 'openai');
      eq(resv.map((x) => [x.measurement_status, x.settled]), [['pending', false]], 'reserva TTS pendiente (el presupuesto la cuenta)');
      assert(new RegExp(`^reservation:tts:${row.id}:g1:a1:seg_seg-0-0-[0-9a-f]{12}$`).test(resv[0].idempotency_key), `clave por segmento ${resv[0].idempotency_key}`);
      assert(Number(resv[0].amount) > 0, 'reserva con monto estimado');
      const llmAfterFirst = fakes.st.llm.length;
      eq([llmAfterFirst - llm0, fakes.st.tts.length - tts0], [1, 1], 'una llamada LLM, un TTS');
      // Retry común: el ledger delata la operación ambigua → 0 llamadas nuevas, sigue en reconciliación.
      await runs.retryItem(C.cid, OWNER, 1, runId, item.itemKey);
      const again = await claimProvider(runId, 'audiobook_chapter');
      await rejectsRe(PW.processProviderItem(workerDeps(), again), /^provider_reconciliation_required/, 'retry común');
      eq([fakes.st.llm.length, fakes.st.tts.length - tts0], [llmAfterFirst, 1], '0 llamadas en el retry común');
      // Decisión humana explícita.
      await runs.retryItem(C.cid, OWNER, 1, runId, item.itemKey, false, true);
      const third = await claimProvider(runId, 'audiobook_chapter');
      await PW.processProviderItem(workerDeps(), third);
      row = await itemRow(runId, item.itemKey);
      eq(row.status, 'completed', `completado (${row.error})`);
      eq(fakes.st.llm.length, llmAfterFirst, '0 llamadas LLM en la reanudación (guion reutilizado)');
      eq((await finalCharges(`item_run_id = $1 and provider = 'anthropic'`, [row.id])).length, 1, 'un solo cargo LLM');
      eq((await reservationsOf(row.id, 'openai')).map((x) => x.settled), [false, true], 'reserva ambigua (queda, reconocida) + la del nuevo intento liquidada');
    });

    await check('DB video (I2): el worker mide la duración desde el mvhd del MP4 que sube y la persiste ANTES de terminar la subida; artifact + summary con durationSource mp4_mvhd; video_interactions la usa', async () => {
      const MP4 = syntheticMp4WithMvhd(300, 'check-f2');
      let midUpload = null;
      const publisher = {
        async getConnection() { return { userId: OWNER, status: 'active', scopes: 'youtube.upload,youtube.readonly' }; },
        async getAccessToken() { return 'fake-access'; },
        async uploadFromUrl(_c, options) {
          await options.onBeforeUpload(MP4);
          const [r] = await ds.query(`select output_summary from public.generation_item_runs where item_key = $1 and job_id = $2`, [`video:${C.c1}`, runId]);
          midUpload = r.output_summary;
          return { videoId: 'AbCdEfGhIjK', youtubeUrl: 'https://www.youtube.com/watch?v=AbCdEfGhIjK' };
        },
      };
      const videogen = {
        async batchCreate() { return { batch_id: 'b1', jobs: [{ job_id: 'vg_f2_1' }] }; },
        // Videogen sin campo de duración (el contrato real no la documenta).
        async getVideoStatus(id) { return { job_id: id, status: 'completed_local', download_url: 'https://fake-videogen.invalid/x.mp4', progress: 100, error: null }; },
        async getVideoCost() { return { estimated_total_cost: 0.9 }; },
      };
      const item = await sched.claimNextItem({ executorId: 'f2-item-worker', types: ['video'], leaseSeconds: 120, runId });
      assert(item, 'claim video');
      await IW.processItem({
        scheduler: sched, dataSource: ds, artifacts: { getDownloadUrl: (id, o) => artifacts.getDownloadUrl(id, o), uploadJsonArtifact: (i) => artifacts.uploadJsonArtifact(i) },
        videogen, youtube: publisher, logger: capLogger, executorId: 'f2-item-worker', leaseSeconds: 120, heartbeatMs: 600000,
        videoTimeoutMin: 1, videoPollMs: 5, mockScenario: 'success', mockResolvePolls: 1, finops: ledger, budget,
      }, item);
      const row = await itemRow(runId, `video:${C.c1}`);
      eq(row.status, 'completed', `estado (${row.error})`);
      eq(midUpload && midUpload.mp4Duration, { durationSec: 300, durationSource: 'mp4_mvhd' }, 'persistido antes de terminar la subida');
      eq(row.output_summary.external.durationSource, 'unknown', 'Videogen sin duración');
      eq([row.output_summary.durationSec, row.output_summary.durationSource], [300, 'mp4_mvhd'], 'summary final');
      const [art] = await ds.query(`select metadata from public.artifacts where item_run_id = $1 and type = 'dynamic_video'`, [row.id]);
      eq([art.metadata.durationSec, art.metadata.durationSource], [300, 'mp4_mvhd'], 'metadata del artifact');
      const facts = SHELL.videoClaimFacts({ videoItemKey: row.item_key, outputSummary: row.output_summary, artifactMetadata: art.metadata });
      eq([facts.ok, facts.video && facts.video.durationSec, facts.video && facts.video.youtubeId], [true, 300, 'AbCdEfGhIjK'], 'video_interactions planifica con la duración medida');
    });

    await check('DB sin clave en el worker (config cambió después del startRun) → provider_not_ready no reintentable, 0 llamadas', async () => {
      const K = await makeCourse('Curso worker sin clave', { videos: false });
      setReady();
      const err = await rejectsRe(runs.startRun(K.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' }), /^budget_approval_required/, 'aprobación', 409);
      await budget.adminAuthorize({ courseId: K.cid, estimateId: err.getResponse().estimateId, authorizedBudget: '50', approvedBy: 'admin@cursia.test' });
      const rid = (await runs.startRun(K.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' })).run.id;
      await seedDependency(rid, `course_intro:${K.cid}`, 'dynamic_course_intro_json', JSON.stringify({ welcome: 'Hola.' }), 'application/json');
      const tts0 = fakes.st.tts.length;
      const item = await claimProvider(rid, 'audio_welcome');
      const env = { ...process.env };
      delete env.OPENAI_API_KEY;
      await rejectsRe(PW.processProviderItem(workerDeps({ env }), item), /^provider_not_ready/, 'sin OPENAI_API_KEY');
      const row = await itemRow(rid, item.itemKey);
      eq([row.status, fakes.st.tts.length - tts0], ['failed', 0], 'fallado, 0 llamadas');
      assert(/OPENAI_API_KEY/.test(row.error) && !row.error.includes(SECRETS.OPENAI_API_KEY), row.error);
    });

    // ═══ Fix round 1: envíos ambiguos / rechazos definitivos (curso aparte, sin videos) ═══
    const A2 = await makeCourse('Curso ambigüedad F2', { videos: false });
    let runA2 = null;
    {
      setReady();
      const e = await rejectsRe(runs.startRun(A2.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' }), /^budget_approval_required/, 'aprobación A2', 409);
      await budget.adminAuthorize({ courseId: A2.cid, estimateId: e.getResponse().estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test' });
      runA2 = (await runs.startRun(A2.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' })).run.id;
      await seedDependency(runA2, `content:${A2.c1}`, 'dynamic_content_md', CONTENT_MD('Bombas'), 'text/markdown');
      await seedDependency(runA2, `content:${A2.c2}`, 'dynamic_content_md', CONTENT_MD('Válvulas'), 'text/markdown');
      await seedDependency(runA2, `course_intro:${A2.cid}`, 'dynamic_course_intro_json', JSON.stringify({ welcome: 'Hola y bienvenida al curso.' }), 'application/json');
    }
    const gammaEv = (itemRunId) => events(`item_run_id = $1 and provider = 'gamma'`, [itemRunId]);

    await check('DB Gamma 5xx en el envío → gamma_submit_ambiguous NO reintentable + reserva previa pendiente (el presupuesto la cuenta); un retry común NO reenvía (reconciliación); solo resubmitProvider explícito pide otra generación', async () => {
      fakes.plan.gammaPostFail = [502];
      const posts0 = fakes.st.gammaPosts.length;
      const item = await claimProvider(runA2, 'presentation');
      await rejectsRe(PW.processProviderItem(workerDeps(), item), /^gamma_submit_ambiguous/, '502');
      let row = await itemRow(runA2, item.itemKey);
      eq([row.status, fakes.st.gammaPosts.length - posts0], ['failed', 1], 'failed tras 1 envío');
      assert(/^gamma_submit_ambiguous: .*HTTP 502/.test(row.error) && row.output_summary.externalSubmitStartedAt, `marcador conservado: ${row.error}`);
      let resv = await reservationsOf(row.id, 'gamma');
      eq(resv.map((x) => [x.measurement_status, x.settled, x.external_operation_id, x.idempotency_key === row.output_summary.externalReservationKey]), [['pending', false, null, true]], 'reserva previa pendiente');
      assert(near(resv[0].amount, 1.0), `reserva ${resv[0].amount}`);
      const actual = await budget.runActual(runA2);
      assert(Number(actual) >= 1.0, `runActual ${actual} cuenta la reserva`);
      // Retry común: el ledger delata la operación ambigua → reconciliación, 0 envíos, la reserva no se duplica.
      await runs.retryItem(A2.cid, OWNER, 1, runA2, item.itemKey);
      const again = await claimProvider(runA2, 'presentation');
      await rejectsRe(PW.processProviderItem(workerDeps(), again), /^provider_reconciliation_required/, 'retry común');
      eq(fakes.st.gammaPosts.length - posts0, 1, 'NINGÚN reenvío automático');
      eq((await reservationsOf(row.id, 'gamma')).length, 1, 'reserva idempotente');
      // Decisión humana explícita: reenvío.
      await rejectsRe(runs.retryItem(A2.cid, OWNER, 1, runA2, `audio_welcome:${A2.cid}`, false, true), /resubmitProvider solo aplica|Solo se puede reintentar/, 'audio sin reconciliación');
      await runs.retryItem(A2.cid, OWNER, 1, runA2, item.itemKey, false, true);
      row = await itemRow(runA2, item.itemKey);
      assert(!row.output_summary.externalSubmitStartedAt && row.output_summary.previousExternals.length >= 1 && row.output_summary.reconciliationAcknowledgedThroughAttempt >= 2, 'marcador archivado + reconocido');
      const third = await claimProvider(runA2, 'presentation');
      await PW.processProviderItem(workerDeps(), third);
      row = await itemRow(runA2, item.itemKey);
      eq([row.status, fakes.st.gammaPosts.length - posts0], ['completed', 2], 'nueva generación tras la decisión');
      eq((await finalCharges(`item_run_id = $1 and provider = 'gamma'`, [row.id])).length, 1, 'un cargo final (la nueva generación)');
      eq((await reservationsOf(row.id, 'gamma')).map((x) => x.settled), [false, true], 'reserva ambigua (queda) + la nueva liquidada');
    });

    await check('DB Gamma 4xx definitivo (429) → reserva LIBERADA (neto 0), marcador limpio, reintentable; conexión cortada tras enviar → ambiguo con reserva pendiente', async () => {
      fakes.plan.gammaPostFail = [429];
      const posts0 = fakes.st.gammaPosts.length;
      const item = await claimProvider(runA2, 'presentation');
      assert(item && item.chapterId === A2.c2, 'claim C2');
      await PW.processProviderItem(workerDeps(), item);
      let row = await itemRow(runA2, item.itemKey);
      eq(row.status, 'retrying', `429 reintentable (${row.error})`);
      assert(/^gamma_submit_failed/.test(row.error) && row.output_summary.externalSubmitStartedAt === null, 'marcador limpio');
      eq((await reservationsOf(row.id, 'gamma')).map((x) => x.settled), [true], 'reserva liberada por un rechazo definitivo');
      eq((await gammaEv(row.id)).reduce((a, x) => a + Number(x.amount), 0), 0, 'neto 0');
      fakes.plan.gammaPostFail = ['drop'];
      await ds.query(`update public.generation_item_runs set next_retry_at = now() where id = $1`, [row.id]);
      const again = await claimProvider(runA2, 'presentation');
      await rejectsRe(PW.processProviderItem(workerDeps(), again), /^gamma_submit_ambiguous/, 'drop');
      row = await itemRow(runA2, item.itemKey);
      eq([row.status, fakes.st.gammaPosts.length - posts0], ['failed', 2], 'failed, sin más envíos');
      eq((await reservationsOf(row.id, 'gamma')).map((x) => [x.attempt, x.settled]), [[1, true], [2, false]], 'reserva ambigua del intento 2');
    });

    await check('DB TTS: conexión cortada tras enviar → RECONCILIACIÓN (0 reintentos automáticos) con reserva pendiente; tras la decisión humana, 4xx (400) definitivo → reserva liberada, no reintentable', async () => {
      fakes.plan.ttsFail = ['drop'];
      const tts0 = fakes.st.tts.length;
      const item = await claimProvider(runA2, 'audio_welcome');
      await rejectsRe(PW.processProviderItem(workerDeps(), item), /^provider_reconciliation_required/, 'drop');
      let row = await itemRow(runA2, item.itemKey);
      eq([row.status, fakes.st.tts.length - tts0], ['failed', 1], 'drop → reconciliación, 1 llamada');
      eq((await reservationsOf(row.id, 'openai')).map((x) => [x.settled, x.idempotency_key]), [[false, `reservation:tts:${row.id}:g1:a1:chunk0`]], 'reserva pendiente');
      fakes.plan.ttsFail = [400];
      await runs.retryItem(A2.cid, OWNER, 1, runA2, item.itemKey, false, true);
      const again = await claimProvider(runA2, 'audio_welcome');
      await rejectsRe(PW.processProviderItem(workerDeps(), again), /tts_failed/, '400 definitivo');
      row = await itemRow(runA2, item.itemKey);
      eq(row.status, 'failed', '400 no reintentable');
      eq((await reservationsOf(row.id, 'openai')).map((x) => x.settled), [false, true], 'el 400 libera su reserva; la ambigua queda');
      eq((await finalCharges(`item_run_id = $1 and provider = 'openai'`, [row.id])).length, 0, 'sin cargos finales');
    });

    await check('DB LLM server-side: conexión cortada tras enviar → RECONCILIACIÓN con reserva pendiente (output = max_tokens); 0 TTS; tras la decisión humana el re-claim completa con el cargo medido', async () => {
      fakes.plan.llmFail = ['drop'];
      const llm0 = fakes.st.llm.length;
      const item = await claimProvider(runA2, 'audiobook_chapter');
      await rejectsRe(PW.processProviderItem(workerDeps(), item), /^provider_reconciliation_required/, 'drop');
      let row = await itemRow(runA2, item.itemKey);
      eq(row.status, 'failed', `reconciliación (${row.error})`);
      const resv = await reservationsOf(row.id, 'anthropic');
      eq(resv.map((x) => [x.settled, x.operation, x.idempotency_key, Number(x.usage.output_tokens) > 0]),
        [[false, 'llm.audiobook_script', `reservation:llm:${row.id}:g1:a1:sec0-main`, true]], 'reserva LLM');
      eq((await events(`item_run_id = $1 and provider = 'openai'`, [row.id])).length, 0, 'sin TTS');
      await runs.retryItem(A2.cid, OWNER, 1, runA2, item.itemKey, false, true);
      const again = await claimProvider(runA2, 'audiobook_chapter');
      await PW.processProviderItem(workerDeps(), again);
      row = await itemRow(runA2, item.itemKey);
      eq(row.status, 'completed', `completado (${row.error})`);
      eq((await finalCharges(`item_run_id = $1 and provider = 'anthropic'`, [row.id])).map((x) => x.measurement_status), ['final'], 'cargo medido del intento reconocido');
      eq((await reservationsOf(row.id, 'anthropic')).map((x) => x.settled)[0], false, 'la reserva ambigua queda (reconocida)');
      assert(fakes.st.llm.length - llm0 >= 2, 'la llamada ambigua + la nueva');
    });

    // ═══ Calibración #2 — FAULT INJECTION del protocolo de llamada pagada ═══════════════════════
    // reserva durable → llamada → resultado → liquidación durable. Ningún caso ambiguo puede
    // producir automáticamente una segunda operación pagada.
    const FAULT = () => Object.assign(new Error('EMAXCONNSESSION: max clients reached in session mode (fault injection)'), { code: 'XX000' });
    const faulty = (target, failOn) => new Proxy(target, {
      get(t, k) {
        const v = t[k];
        if (typeof v !== 'function') return v;
        return async (...a) => { if (failOn(String(k), a)) throw FAULT(); return v.apply(t, a); };
      },
    });
    const isReservationWrite = (k, a) => k === 'recordCharge' && String((a[0] && a[0].idempotencyKey) || '').startsWith('reservation:');
    const onlyOnce = (pred) => { let used = false; return (k, a) => { if (!used && pred(k, a)) { used = true; return true; } return false; }; };
    async function freshRun(title, videos = false) {
      setReady();
      const K = await makeCourse(title, { videos });
      const mode = videos ? 'real' : 'mock';
      const e = await rejectsRe(runs.startRun(K.cid, OWNER, 1, { ...CONTEXT, videoMode: mode }), /^budget_approval_required/, `aprobación ${title}`, 409);
      await budget.adminAuthorize({ courseId: K.cid, estimateId: e.getResponse().estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test' });
      const rid = (await runs.startRun(K.cid, OWNER, 1, { ...CONTEXT, videoMode: mode })).run.id;
      await seedDependency(rid, `content:${K.c1}`, 'dynamic_content_md', CONTENT_MD('Bombas'), 'text/markdown');
      await seedDependency(rid, `content:${K.c2}`, 'dynamic_content_md', CONTENT_MD('Válvulas'), 'text/markdown');
      await seedDependency(rid, `course_intro:${K.cid}`, 'dynamic_course_intro_json', JSON.stringify({ welcome: 'Hola y bienvenida al curso de hidráulica de planta.' }), 'application/json');
      return { ...K, rid };
    }
    const counts = () => ({ g: fakes.st.gammaPosts.length, t: fakes.st.tts.length, l: fakes.st.llm.length });
    const delta = (c0) => { const c = counts(); return { gamma: c.g - c0.g, tts: c.t - c0.t, llm: c.l - c0.l }; };
    const retryNow = (id) => ds.query(`update public.generation_item_runs set next_retry_at = now() where id = $1`, [id]);
    const FAST = { ...process.env, PROVIDER_CALL_TIMEOUT_MS: '400' };

    await check('FAULT DB cae ANTES del proveedor (la reserva no se puede escribir) → Gamma / TTS / guion LLM: 0 llamadas, 0 eventos, item reintentable; con la DB de vuelta completa sin duplicar', async () => {
      const R = await freshRun('Fault antes');
      for (const type of ['presentation', 'audio_welcome', 'audiobook_chapter']) {
        const c0 = counts();
        const item = await claimProvider(R.rid, type);
        await PW.processProviderItem(workerDeps({ finops: faulty(ledger, isReservationWrite) }), item);
        let row = await itemRow(R.rid, item.itemKey);
        eq([row.status, delta(c0)], ['retrying', { gamma: 0, tts: 0, llm: 0 }], `${type}: reintentable y 0 llamadas (${row.error})`);
        assert(/EMAXCONNSESSION/.test(row.error), `${type}: motivo ${row.error}`);
        eq((await events(`item_run_id = $1`, [row.id])).length, 0, `${type}: 0 eventos`);
        await retryNow(row.id);
        const again = await claimProvider(R.rid, type);
        await PW.processProviderItem(workerDeps(), again);
        row = await itemRow(R.rid, item.itemKey);
        eq(row.status, 'completed', `${type}: completa tras volver la DB (${row.error})`);
        const d = delta(c0);
        eq(type === 'presentation' ? d.gamma : type === 'audio_welcome' ? d.tts : d.llm, 1, `${type}: exactamente UNA operación pagada`);
      }
    });

    await check('FAULT DB cae DESPUÉS del proveedor (falla la liquidación) → TTS y LLM: RECONCILIACIÓN (0 reintentos, reserva pendiente); Gamma: retoma la MISMA generación (0 reenvíos) y liquida UN cargo', async () => {
      const R = await freshRun('Fault después');
      const settleFails = (k) => k === 'settleReservation';
      // OpenAI TTS
      let c0 = counts();
      let item = await claimProvider(R.rid, 'audio_welcome');
      await rejectsRe(PW.processProviderItem(workerDeps({ finops: faulty(ledger, settleFails) }), item), /^provider_reconciliation_required: openai/, 'TTS');
      let row = await itemRow(R.rid, item.itemKey);
      eq([row.status, delta(c0).tts], ['failed', 1], 'TTS: failed tras 1 llamada');
      eq((await reservationsOf(row.id, 'openai')).map((x) => x.settled), [false], 'TTS: reserva pendiente (cuenta en el presupuesto)');
      await runs.retryItem(R.cid, OWNER, 1, R.rid, item.itemKey);
      await rejectsRe(PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome')), /^provider_reconciliation_required/, 'TTS retry común');
      eq(delta(c0).tts, 1, 'TTS: 0 llamadas nuevas en el retry común');
      // Anthropic (guion del audiolibro)
      c0 = counts();
      item = await claimProvider(R.rid, 'audiobook_chapter');
      await rejectsRe(PW.processProviderItem(workerDeps({ finops: faulty(ledger, settleFails) }), item), /^provider_reconciliation_required: anthropic/, 'LLM');
      row = await itemRow(R.rid, item.itemKey);
      eq([row.status, delta(c0)], ['failed', { gamma: 0, tts: 0, llm: 1 }], 'LLM: failed tras 1 llamada, sin TTS');
      assert(/msg_f2_/.test(row.error), `LLM: el id de la operación queda en el motivo (${row.error})`);
      // Gamma: la liquidación es al terminal; el id ya quedó persistido → retoma sin reenviar.
      c0 = counts();
      item = await claimProvider(R.rid, 'presentation');
      await PW.processProviderItem(workerDeps({ finops: faulty(ledger, settleFails) }), item);
      row = await itemRow(R.rid, item.itemKey);
      eq([row.status, delta(c0).gamma], ['retrying', 1], `Gamma: reintentable (retoma), 1 envío (${row.error})`);
      assert(/finops_ledger_write_failed/.test(row.error) && row.output_summary.external.gammaGenerationId, 'Gamma: motivo + id persistido');
      await retryNow(row.id);
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'presentation'));
      row = await itemRow(R.rid, item.itemKey);
      eq([row.status, delta(c0).gamma], ['completed', 1], 'Gamma: completa con 0 reenvíos');
      eq((await finalCharges(`item_run_id = $1 and provider = 'gamma'`, [row.id])).length, 1, 'Gamma: UN cargo');
      eq((await reservationsOf(row.id, 'gamma')).map((x) => x.settled), [true], 'Gamma: reserva liquidada');
    });

    await check('FAULT DB caída TOTAL después del proveedor (ni liquidación ni failItem): la lease vence y el re-claim lo detecta en el LEDGER → reconciliación, 0 llamadas; si el audiolibro pagado YA quedó guardado por segmento y falló la subida final, el re-claim lo reutiliza (0 llamadas)', async () => {
      const R = await freshRun('Fault total');
      const c0 = counts();
      let item = await claimProvider(R.rid, 'audio_welcome');
      const deadSched = faulty(sched, (k) => k === 'failItem' || k === 'completeItem');
      await rejectsRe(PW.processProviderItem(workerDeps({ finops: faulty(ledger, (k) => k === 'settleReservation'), scheduler: deadSched }), item), /EMAXCONNSESSION/, 'DB caída');
      let row = await itemRow(R.rid, item.itemKey);
      eq([row.status, delta(c0).tts], ['running', 1], 'quedó running tras 1 llamada');
      await ds.query(`update public.generation_item_runs set lease_until = now() - interval '1 second' where id = $1`, [row.id]);
      await sched.sweepExpiredLeases(R.rid);
      await retryNow(row.id);
      await rejectsRe(PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome')), /^provider_reconciliation_required/, 're-claim');
      row = await itemRow(R.rid, item.itemKey);
      eq([row.status, delta(c0).tts], ['failed', 1], 're-claim: reconciliación, 0 llamadas nuevas');
      // Variante: la liquidación SÍ quedó, pero el audio pagado no se pudo subir y la DB tampoco deja fallar el item.
      const c1 = counts();
      item = await claimProvider(R.rid, 'audiobook_chapter');
      const deadArtifacts = faulty(artifacts, (k) => k === 'uploadBufferArtifact');
      await rejectsRe(PW.processProviderItem(workerDeps({ artifacts: deadArtifacts, scheduler: deadSched }), item), /EMAXCONNSESSION/, 'subida caída');
      row = await itemRow(R.rid, item.itemKey);
      const d1 = delta(c1);
      eq([row.status, d1.llm >= 1, d1.tts >= 1], ['running', true, true], 'pagó guion + TTS');
      await ds.query(`update public.generation_item_runs set lease_until = now() - interval '1 second' where id = $1`, [row.id]);
      await sched.sweepExpiredLeases(R.rid);
      await retryNow(row.id);
      // r19: el guion y el segmento pagados SÍ quedaron guardados (Storage + output_summary) antes de la subida
      // final: el re-claim los reutiliza y completa sin volver a pagar (antes: reconciliación).
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audiobook_chapter'));
      row = await itemRow(R.rid, item.itemKey);
      eq([row.status, row.output_summary.reusedSegments], ['completed', d1.tts], `re-claim reutiliza lo pagado (${row.error})`);
      eq(delta(c1), d1, '0 llamadas nuevas (ni LLM ni TTS)');
    });

    await check('REVIEW I4a: el MP3 pagado YA se subió y la DB cae al completar (ni completeItem ni failItem): el re-claim REUTILIZA el artifact subido y completa, 0 llamadas nuevas (nunca reconciliación ni re-pago)', async () => {
      const R = await freshRun('Review I4a');
      const c0 = counts();
      const item = await claimProvider(R.rid, 'audio_welcome');
      const deadSched = faulty(sched, (k) => k === 'completeItem' || k === 'failItem');
      await rejectsRe(PW.processProviderItem(workerDeps({ scheduler: deadSched }), item), /EMAXCONNSESSION/, 'DB caída al completar');
      let row = await itemRow(R.rid, item.itemKey);
      eq([row.status, delta(c0).tts], ['running', 1], 'running tras 1 TTS');
      await ds.query(`update public.generation_item_runs set lease_until = now() - interval '1 second' where id = $1`, [row.id]);
      await sched.sweepExpiredLeases(R.rid);
      await retryNow(row.id);
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome'));
      row = await itemRow(R.rid, item.itemKey);
      eq([row.status, delta(c0).tts, row.output_summary.reusedUploadedArtifact], ['completed', 1, true], `reutilizado (${row.error})`);
      eq((await finalCharges(`item_run_id = $1 and provider = 'openai'`, [row.id])).length, 1, 'UN cargo de TTS');
    });

    await check('REVIEW I4b: resultado CONOCIDO (guion rechazado por validación, AUDIOBOOK_SECTION_TOO_SHORT) → reintento acotado normal (NO reconciliación); el intento queda reconocido y el re-claim completa', async () => {
      const R = await freshRun('Review I4b');
      const c0 = counts();
      fakes.plan.llmTiny = 2; // main + continuación, ambas cortas
      const item = await claimProvider(R.rid, 'audiobook_chapter');
      await PW.processProviderItem(workerDeps(), item);
      let row = await itemRow(R.rid, item.itemKey);
      eq(row.status, 'retrying', `reintentable (${row.error})`);
      assert(/^AUDIOBOOK_SECTION_TOO_SHORT/.test(row.error) && !/reconciliation/.test(row.error), row.error);
      eq([row.output_summary.reconciliationAcknowledgedThroughAttempt, delta(c0).llm, delta(c0).tts], [1, 2, 0], 'intento reconocido; 2 LLM, 0 TTS');
      await retryNow(row.id);
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audiobook_chapter'));
      row = await itemRow(R.rid, item.itemKey);
      eq(row.status, 'completed', `completa (${row.error})`);
    });

    await check('FAULT timeout del proveedor (PROVIDER_CALL_TIMEOUT_MS) → TTS y LLM: reconciliación; Gamma: gamma_submit_ambiguous; reserva pendiente y 0 reintentos automáticos', async () => {
      const R = await freshRun('Fault timeout');
      let c0 = counts();
      fakes.plan.ttsFail = ['hang'];
      await rejectsRe(PW.processProviderItem(workerDeps({ env: FAST }), await claimProvider(R.rid, 'audio_welcome')), /^provider_reconciliation_required: openai/, 'TTS timeout');
      fakes.plan.llmFail = ['hang'];
      await rejectsRe(PW.processProviderItem(workerDeps({ env: FAST }), await claimProvider(R.rid, 'audiobook_chapter')), /^provider_reconciliation_required: anthropic/, 'LLM timeout');
      fakes.plan.gammaPostFail = ['hang'];
      await rejectsRe(PW.processProviderItem(workerDeps({ env: FAST }), await claimProvider(R.rid, 'presentation')), /^gamma_submit_ambiguous/, 'Gamma timeout');
      eq(delta(c0), { gamma: 1, tts: 1, llm: 1 }, 'una llamada por proveedor, ninguna repetida');
      const pend = await ds.query(`select provider from public.generation_cost_events e where e.run_id = $1 and metadata->>'reservation' = 'true'
        and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id) order by provider`, [R.rid]);
      eq(pend.map((x) => x.provider), ['anthropic', 'gamma', 'openai'], 'las tres reservas quedan pendientes (el presupuesto las cuenta)');
    });

    await check('FAULT respuesta ambigua del proveedor: Gamma 200 sin generationId → ambiguo; TTS 502 → reconciliación; nunca un reenvío', async () => {
      const R = await freshRun('Fault ambiguo');
      const c0 = counts();
      fakes.plan.gammaPostFail = ['noid'];
      await rejectsRe(PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'presentation')), /^gamma_submit_ambiguous: .*sin generationId/, 'Gamma sin id');
      fakes.plan.ttsFail = [502];
      await rejectsRe(PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome')), /^provider_reconciliation_required/, 'TTS 502');
      eq(delta(c0), { gamma: 1, tts: 1, llm: 0 }, 'sin reenvíos');
    });

    await check('FAULT misma operación del proveedor dos veces (x-request-id repetido) → UN solo cargo en el ledger; ambas reservas liquidadas', async () => {
      const R1 = await freshRun('Fault dup 1');
      const R2 = await freshRun('Fault dup 2');
      fakes.plan.ttsFixedRequestId = 'req_dup_calib2';
      try {
        await PW.processProviderItem(workerDeps(), await claimProvider(R1.rid, 'audio_welcome'));
        await PW.processProviderItem(workerDeps(), await claimProvider(R2.rid, 'audio_welcome'));
      } finally {
        fakes.plan.ttsFixedRequestId = null;
      }
      eq((await events(`idempotency_key = 'openai:req:req_dup_calib2'`, [])).length, 1, 'un cargo por la operación');
      const r1 = await itemRow(R1.rid, `audio_welcome:${R1.cid}`);
      const r2 = await itemRow(R2.rid, `audio_welcome:${R2.cid}`);
      eq([(await reservationsOf(r1.id, 'openai')).map((x) => x.settled), (await reservationsOf(r2.id, 'openai')).map((x) => x.settled)], [[true], [true]], 'reservas liquidadas (sin doble conteo)');
    });

    // ═══ #583 (decisión del usuario 2026-10-02): UN reenvío automático de un AUDIO con resultado incierto ═══
    const later = (mins) => new Date(Date.now() + mins * 60_000);
    const finopsCounts = async (cid) => (await ds.query(
      `select (select count(*)::int from public.cost_estimates where course_id = $1) as estimates,
              (select count(*)::int from public.cost_budget_authorizations where course_id = $1) as auths`, [cid]))[0];
    /** Audio de bienvenida cortado DESPUÉS de enviarse a OpenAI → reconciliación (como el capítulo de #583). */
    async function ambiguousWelcome(title) {
      const R = await freshRun(title);
      const key = `audio_welcome:${R.cid}`;
      fakes.plan.ttsFail = ['drop'];
      await rejectsRe(PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome')), /^provider_reconciliation_required: openai/, 'TTS cortado');
      const row = await itemRow(R.rid, key);
      eq(row.status, 'failed', 'reconciliación');
      return { ...R, key, row };
    }
    const resubOf = (res, rid) => res.resubmitted.filter((x) => x.runId === rid);

    await check('#583 audio incierto → UN reenvío automático tras la espera (la reserva incierta QUEDA registrada y reconocida, sin estimados ni aprobaciones nuevas); el worker reenvía UNA vez y completa', async () => {
      const A = await ambiguousWelcome('583 audio incierto');
      const [pend] = await reservationsOf(A.row.id, 'openai');
      assert(pend && !pend.settled && Number(pend.amount) > 0 && Number(pend.amount) <= AH.AMBIGUOUS_AUDIO_RESUBMIT_MAX_USD, `reserva pendiente chica (${pend && pend.amount})`);
      // Mientras el servidor lo va a reenviar solo, no hay acción de admin.
      eq(RC.adminActionFor(A.row, 'not_done', new Date()), null, 'sin acción de admin (pendiente del servidor)');
      const f0 = await finopsCounts(A.cid);
      const t0 = fakes.st.tts.length;
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: new Date() }), A.rid).length, 0, 'dentro de la espera: no');
      const res = await runs.autoResubmitAmbiguousAudio({ now: later(3) });
      eq(resubOf(res, A.rid).map((x) => x.itemKey), [A.key], 'reenviado');
      let row = await itemRow(A.rid, A.key);
      const os0 = row.output_summary;
      const last = os0.previousErrors[os0.previousErrors.length - 1];
      eq([row.status, os0.ambiguousAudioResubmit.rounds, os0.reconciliationAcknowledgedThroughAttempt, row.max_attempts - row.attempt_count, last.auto, last.ambiguousAudioResubmit],
        ['pending', 1, row.attempt_count, 1, true, true], 'reapertura: una vez, intento reconocido, UN intento');
      eq(Number(os0.ambiguousAudioResubmit.pendingUsd), Number(pend.amount), 'costo estimado registrado');
      eq(await finopsCounts(A.cid), f0, 'sin estimados ni aprobaciones nuevas');
      fakes.plan.ttsFail = [];
      await PW.processProviderItem(workerDeps(), await claimProvider(A.rid, 'audio_welcome'));
      row = await itemRow(A.rid, A.key);
      eq([row.status, fakes.st.tts.length - t0], ['completed', 1], `reenvío único y completa (${row.error})`);
      eq((await reservationsOf(row.id, 'openai')).map((x) => x.settled), [false, true], 'la reserva incierta queda contada + la del reenvío liquidada');
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(10) }), A.rid).length, 0, 'nada más que reenviar');
    });

    await check('#583 incierto OTRA vez después de su reenvío automático → nunca un segundo reenvío (ni el auto-healer): admin (reconcile_provider) y el run termina needs_attention', async () => {
      const A = await ambiguousWelcome('583 audio doble');
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(3) }), A.rid).length, 1, 'primer reenvío');
      const t0 = fakes.st.tts.length;
      fakes.plan.ttsFail = ['drop'];
      await rejectsRe(PW.processProviderItem(workerDeps(), await claimProvider(A.rid, 'audio_welcome')), /^provider_reconciliation_required: openai/, 'otra vez incierto');
      fakes.plan.ttsFail = [];
      const row = await itemRow(A.rid, A.key);
      eq([row.status, fakes.st.tts.length - t0], ['failed', 1], 'una llamada');
      for (const mins of [3, 60, 600]) {
        eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(mins) }), A.rid).length, 0, `sin segundo reenvío (+${mins} min)`);
        eq((await runs.autoHealFailedItems({ now: later(mins) })).reopened.filter((x) => x.runId === A.rid).length, 0, `auto-healer +${mins} min`);
      }
      eq(AH.ambiguousAudioResubmitDecision(row, later(30)).reason, 'cap_reached', 'tope');
      eq(RC.adminActionFor(row, 'not_done', later(30)), { code: 'reconcile_provider', itemKey: A.key }, 'acción de admin');
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now(), output_summary = coalesce(output_summary, '{}'::jsonb) || '{"mode":"real"}'::jsonb
                       where job_id = $1 and status in ('pending', 'retrying', 'blocked')`, [A.rid]);
      eq(await runs.tx((qr) => T.recomputeRunStatus(qr, A.rid)), 'failed', 'run failed');
      const dto = await runs.getRun(A.cid, OWNER, 1, A.rid);
      eq(dto.completion.state, 'needs_attention', 'needs_attention');
      assert(dto.completion.adminActions.some((a) => a.code === 'reconcile_provider' && a.itemKey === A.key), `acciones ${JSON.stringify(dto.completion.adminActions)}`);
      eq(fakes.st.tts.length - t0, 1, 'cero llamadas automáticas más');
    });

    await check('#583 costo estimado sobre el tope → ningún reenvío automático: queda `declined` (sin re-evaluarlo en cada tick) y la acción es de admin', async () => {
      const A = await ambiguousWelcome('583 audio caro');
      const t0 = fakes.st.tts.length;
      const res = await runs.autoResubmitAmbiguousAudio({ now: later(3), maxUsd: 0.000001 });
      eq(resubOf(res, A.rid).length, 0, 'no se reenvía');
      eq(res.skipped.filter((x) => x.runId === A.rid).map((x) => x.reason), ['over_threshold'], 'motivo');
      const row = await itemRow(A.rid, A.key);
      eq([row.status, row.output_summary.ambiguousAudioResubmit.declined], ['failed', 'over_threshold'], 'declinado → admin');
      eq((await runs.autoResubmitAmbiguousAudio({ now: later(10) })).skipped.filter((x) => x.runId === A.rid).length, 0, 'no vuelve a evaluarse (ni con el tope normal)');
      eq(RC.adminActionFor(row, 'not_done', later(10)), { code: 'reconcile_provider', itemKey: A.key }, 'acción de admin');
      eq(fakes.st.tts.length - t0, 0, 'cero llamadas');
    });

    await check('#583 FinOps manda: sin presupuesto autorizado que cubra el reenvío → no se reabre (sin estimados ni aprobaciones) y queda para un admin; reabierto y revocado antes del envío → el runtime guard del worker lo bloquea (0 llamadas)', async () => {
      const A = await ambiguousWelcome('583 audio sin presupuesto');
      const [est] = await ds.query(`select id from public.cost_estimates where run_id = $1 and scope = 'run'`, [A.rid]);
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, estimate_id, authorized_budget, decision, reason) values ($1, $2, $3, 0, 'BLOCKED', 'check #583: revocado')`, [A.rid, A.cid, est.id]);
      const f0 = await finopsCounts(A.cid);
      const t0 = fakes.st.tts.length;
      const res = await runs.autoResubmitAmbiguousAudio({ now: later(3) });
      eq(resubOf(res, A.rid).length, 0, 'no se reabre');
      eq(res.skipped.filter((x) => x.runId === A.rid).map((x) => x.reason), ['budget_approval_required'], 'motivo FinOps');
      const row = await itemRow(A.rid, A.key);
      eq([row.status, row.output_summary.ambiguousAudioResubmit.declined], ['failed', 'budget_approval_required'], 'declinado → admin');
      eq(await finopsCounts(A.cid), f0, 'sin estimados ni aprobaciones nuevas');
      eq(fakes.st.tts.length - t0, 0, 'cero llamadas');
      // Runtime guard: reabierto con presupuesto y revocado ANTES de que el worker llame.
      const G = await ambiguousWelcome('583 audio runtime guard');
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(3) }), G.rid).length, 1, 'reabierto');
      const [estG] = await ds.query(`select id from public.cost_estimates where run_id = $1 and scope = 'run'`, [G.rid]);
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, estimate_id, authorized_budget, decision, reason) values ($1, $2, $3, 0, 'BLOCKED', 'check #583: revocado')`, [G.rid, G.cid, estG.id]);
      const t1 = fakes.st.tts.length;
      await PW.processProviderItem(workerDeps(), await claimProvider(G.rid, 'audio_welcome')).catch(() => {});
      const rg = await itemRow(G.rid, G.key);
      eq([rg.status === 'completed', /budget_exceeded/.test(String(rg.error)), fakes.st.tts.length - t1], [false, true, 0], `runtime guard (${rg.status}: ${rg.error})`);
    });

    await check('#583 dos barridos a la vez (dos ticks / reinicio) → UN solo reenvío; el guion LLM incierto (anthropic) y el video nunca se reenvían solos', async () => {
      const A = await ambiguousWelcome('583 audio concurrente');
      const both = await Promise.all([runs.autoResubmitAmbiguousAudio({ now: later(3) }), runs.autoResubmitAmbiguousAudio({ now: later(3) })]);
      eq(both.reduce((n, r) => n + resubOf(r, A.rid).length, 0), 1, 'un reenvío en total');
      const row = await itemRow(A.rid, A.key);
      eq([row.status, row.output_summary.ambiguousAudioResubmit.rounds, row.output_summary.previousErrors.length], ['pending', 1, 1], 'una sola reapertura');
      // Guion del audiolibro (LLM) incierto → admin, nunca automático.
      const B = await freshRun('583 guion incierto');
      fakes.plan.llmFail = ['drop'];
      const item = await claimProvider(B.rid, 'audiobook_chapter');
      await rejectsRe(PW.processProviderItem(workerDeps(), item), /^provider_reconciliation_required: anthropic/, 'guion cortado');
      fakes.plan.llmFail = [];
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(3) }), B.rid).length, 0, 'anthropic: no');
      const rb = await itemRow(B.rid, item.itemKey);
      eq(AH.ambiguousAudioResubmitDecision(rb, later(3)).reason, 'not_allow_listed', 'solo TTS');
      const now = new Date();
      const vrow = { status: 'failed', type: 'video', error: 'provider_reconciliation_required: openai — x', output_summary: {}, finished_at: new Date(now.getTime() - 600e3) };
      eq(AH.ambiguousAudioResubmitDecision(vrow, now).reason, 'not_audio', 'video: nunca');
      eq(AH.ambiguousAudioResubmitDecision({ ...vrow, type: 'audio_welcome', error: 'provider_reconciliation_required: openai — x (budget_exceeded)' }, now).reason, 'denied', 'presupuesto en el motivo → nunca');
      eq(AH.ambiguousAudioResubmitDecision({ ...vrow, type: 'audio_welcome' }, now, { pendingUsd: 0.02, providers: ['anthropic', 'openai'] }).reason, 'missing_precondition', 'otro proveedor pendiente');
      eq(AH.ambiguousAudioResubmitDecision({ ...vrow, type: 'audiobook_chapter' }, now, { pendingUsd: 0.02, providers: ['openai'] }).heal, true, 'capítulo del audiolibro: sí');
    });

    await check('#583 fix round 1 (M5): una falla de INFRAESTRUCTURA al reabrir (DB/lock, FinOps no disponible) NO gasta el único reenvío: se re-evalúa en el próximo tick', async () => {
      const A = await ambiguousWelcome('583 audio infra');
      const orig = runs.retryItem;
      let calls = 0;
      runs.retryItem = async function () { calls++; throw new Error('Connection terminated unexpectedly'); };
      let res;
      try { res = await runs.autoResubmitAmbiguousAudio({ now: later(3) }); } finally { runs.retryItem = orig; }
      eq([calls, resubOf(res, A.rid).length], [1, 0], 'intentado, no reabierto');
      let row = await itemRow(A.rid, A.key);
      eq(row.output_summary.ambiguousAudioResubmit, undefined, 'sin `declined`: no queda para un admin por un hipo');
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(4) }), A.rid).length, 1, 'el próximo tick lo reenvía');
      row = await itemRow(A.rid, A.key);
      eq(row.output_summary.ambiguousAudioResubmit.rounds, 1, 'una vez');
    });

    await check('#583 fix round 1 (M6): si el barrido no resuelve un audio incierto dentro de la espera + 3 ticks, la acción de admin aparece igual (techo duro)', async () => {
      const now = new Date();
      const row = (secAgo) => ({ id: 'a', item_key: 'audio_welcome:1', type: 'audio_welcome', status: 'failed', error: 'provider_reconciliation_required: openai — x', output_summary: {}, finished_at: new Date(now.getTime() - secAgo * 1000) });
      eq(RC.adminActionFor(row(60), 'not_done', now), null, 'en la espera: sin acción (lo resuelve el servidor)');
      eq(RC.adminActionFor(row(150), 'not_done', now), null, 'recién pasada la espera: el barrido todavía puede tomarlo');
      eq(RC.adminActionFor(row(120 + 3 * 60 + 5), 'not_done', now), { code: 'reconcile_provider', itemKey: 'audio_welcome:1' }, 'pasado el techo: admin');
    });

    await check('#583 fix round 1 (I1): ingest del proxy — cargo CONSERVADOR (metadata.conservative) y CORRECCIÓN con el usage exacto (ADJUSTMENT, una vez); corrección sin conservador = el cargo; nunca toca un cargo medido', async () => {
      const { FinopsIngestController } = loadDist('modules/finops/finops.controller.js');
      const ctl = new FinopsIngestController(ledger);
      const R = await freshRun('583 ingest corrección');
      const ir = await itemRow(R.rid, `audio_welcome:${R.cid}`);
      const base = { subject: OWNER, itemRunId: ir.id, callRole: 'main', attempt: 1, model: 'claude-sonnet-4-6', billingAccount: 'cursia' };
      const total = async (mid) => {
        const [c] = await events(`idempotency_key = $1`, [`anthropic:msg:${mid}`]);
        const adj = c ? await events(`corrects_event_id = $1`, [c.id]) : [];
        return { charge: c, adj, total: c ? adj.reduce((t, a) => t + Number(a.amount), Number(c.amount)) : null };
      };
      // 1) conservador y después corrección → baja al exacto, con su ADJUSTMENT; repetir = no-op.
      await ctl.llmUsage({ ...base, messageId: 'msg_583_c1', usage: { input_tokens: 1200, output_tokens: 3500, cache_read_input_tokens: 5 }, measurement: 'conservative' });
      let t = await total('msg_583_c1');
      eq(t.charge.metadata.conservative, true, 'marcado conservador');
      const conservative = t.total;
      const r1 = await ctl.llmUsage({ ...base, messageId: 'msg_583_c1', usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5 }, measurement: 'correction' });
      t = await total('msg_583_c1');
      assert(r1.corrected === true && t.adj.length === 1 && t.total < conservative && t.total > 0, `corregido ${JSON.stringify(r1)} ${t.total} < ${conservative}`);
      const again = await ctl.llmUsage({ ...base, messageId: 'msg_583_c1', usage: { input_tokens: 1200, output_tokens: 100, cache_read_input_tokens: 5 }, measurement: 'correction' });
      eq([again.corrected, again.reason, (await total('msg_583_c1')).adj.length], [false, 'already_corrected', 1], 'fix round 2 (N2): una segunda corrección (aun más baja) se rechaza');
      eq(t.adj[0].metadata.conservativeStatus, 'corrected', 'marca «corrected» en el ADJUSTMENT (ledger append-only)');
      // N2: la corrección solo puede quitar el relleno de output — nada más.
      const mk = async (mid) => ctl.llmUsage({ ...base, messageId: mid, usage: { input_tokens: 1200, output_tokens: 3500, cache_read_input_tokens: 5 }, measurement: 'conservative' });
      const corr = (mid, usage, extra) => ctl.llmUsage({ ...base, ...(extra || {}), messageId: mid, usage, measurement: 'correction' });
      for (const [mid, usage, extra, reason] of [
        ['msg_583_n2a', { input_tokens: 1100, output_tokens: 340, cache_read_input_tokens: 5 }, null, 'input_tokens_mismatch'],
        ['msg_583_n2b', { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 0 }, null, 'cache_read_tokens_mismatch'],
        ['msg_583_n2c', { input_tokens: 1200, output_tokens: 3600, cache_read_input_tokens: 5 }, null, 'output_above_conservative'],
        ['msg_583_n2d', { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5 }, { model: 'claude-haiku-4-5' }, 'model_mismatch'],
        ['msg_583_n2e', { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5 }, { subject: '99999999-2222-4333-8444-555555555555', itemRunId: null }, 'owner_mismatch'],
      ]) {
        await mk(mid);
        const before = (await total(mid)).total;
        const rr = await corr(mid, usage, extra);
        eq([rr.corrected, rr.reason, (await total(mid)).total, (await total(mid)).adj.length], [false, reason, before, 0], `rechazada: ${reason}`);
      }
      // Exacto == conservador (output 3500): igual queda la marca (delta 0) y es única.
      await mk('msg_583_n2f');
      const eqr = await corr('msg_583_n2f', { input_tokens: 1200, output_tokens: 3500, cache_read_input_tokens: 5 });
      const tf = await total('msg_583_n2f');
      eq([eqr.corrected, tf.adj.length, Number(tf.adj[0].amount)], [true, 1, 0], 'marca con delta 0');
      eq((await corr('msg_583_n2f', { input_tokens: 1200, output_tokens: 10, cache_read_input_tokens: 5 })).reason, 'already_corrected', 'después ya no baja');
      // 2) corrección sin conservador previo → el exacto es el cargo.
      await ctl.llmUsage({ ...base, messageId: 'msg_583_c2', usage: { input_tokens: 10, output_tokens: 20 }, measurement: 'correction' });
      t = await total('msg_583_c2');
      eq([!!t.charge, t.adj.length, t.charge.usage.output_tokens], [true, 0, 20], 'cargo exacto');
      // 3) cargo medido normal: una «corrección» nunca lo toca.
      await ctl.llmUsage({ ...base, messageId: 'msg_583_c3', usage: { input_tokens: 10, output_tokens: 900 } });
      const before = (await total('msg_583_c3')).total;
      const r3 = await ctl.llmUsage({ ...base, messageId: 'msg_583_c3', usage: { input_tokens: 10, output_tokens: 1 }, measurement: 'correction' });
      eq([r3.corrected, (await total('msg_583_c3')).total], [false, before], 'medido intacto');
      // 4) valor inválido → 400.
      await rejectsRe(ctl.llmUsage({ ...base, messageId: 'msg_583_c4', usage: { input_tokens: 1, output_tokens: 1 }, measurement: 'maybe' }), /measurement/, 'inválido');
    });

    await check('#583 scripts/staging-budget-policy.js contra PG16: nueva versión de la política vigente (owner de prueba > global) con maxCostPerRun 15 y TODO lo demás igual; idempotente (2.ª corrida no inserta)', async () => {
      const OWNER_STG = 'aa2fa9a1-afb1-4b01-8646-94a0cb272b57';
      const pols = () => ds.query(`select scope, scope_id, version, limits, on_exceed, require_human_approval_for_real_spend from public.cost_budget_policies
                                     where scope = 'global' or (scope = 'owner' and scope_id = $1) order by scope, version`, [OWNER_STG]);
      const g0 = (await ds.query(`select coalesce(max(version), 0)::int v from public.cost_budget_policies where scope = 'global'`))[0].v;
      await ds.query(`insert into public.cost_budget_policies (scope, scope_id, version, limits, require_human_approval_for_real_spend, on_exceed, created_by)
                      values ('global', null, $1, $2::jsonb, true, 'ADMIN_APPROVAL', 'check #583')`,
        [g0 + 1, JSON.stringify({ maxCostPerRun: '10', maxCostPerCourse: '15', monthlyCapStaging: '50', maxCostPerProvider: { gamma: '4' } })]);
      const runPolicy = (owner) => spawnSync(process.execPath, [path.join(REPO, 'scripts/staging-budget-policy.js'), ...(owner ? [owner] : [])],
        { cwd: tmpCwd, env: cleanEnv({ MIGRATION_ENV: 'staging', NODE_ENV: 'test', ...localEnv({}) }), encoding: 'utf8', timeout: 60000 });
      let r = runPolicy(OWNER_STG);
      assert(r.status === 0 && /nueva versión con maxCostPerRun 15/.test(r.stdout), `1.ª corrida: ${r.stdout}${r.stderr}`);
      let rows = (await pols()).filter((x) => x.scope === 'global');
      const top = rows[rows.length - 1];
      eq([top.version, top.limits, top.on_exceed, top.require_human_approval_for_real_spend], [g0 + 2, { maxCostPerRun: '15', maxCostPerCourse: '15', monthlyCapStaging: '50', maxCostPerProvider: { gamma: '4' } }, 'ADMIN_APPROVAL', true], 'versión nueva, resto igual');
      eq(rows[rows.length - 2].limits.maxCostPerRun, '10', 'la versión anterior no se toca (inmutable)');
      r = runPolicy(OWNER_STG);
      assert(r.status === 0 && /ya tiene maxCostPerRun 15/.test(r.stdout), `2.ª corrida: ${r.stdout}${r.stderr}`);
      eq((await pols()).filter((x) => x.scope === 'global').length, rows.length, 'idempotente: sin otra versión');
      // Con política del owner de prueba, esa es la vigente para sus generaciones: se versiona ESA.
      await ds.query(`insert into public.cost_budget_policies (scope, scope_id, version, limits, require_human_approval_for_real_spend, on_exceed, created_by)
                      values ('owner', $1, 1, $2::jsonb, true, 'BLOCK', 'check #583')`, [OWNER_STG, JSON.stringify({ maxCostPerRun: 12, maxCostPerCourse: 30 })]);
      r = runPolicy(OWNER_STG);
      assert(r.status === 0, r.stderr);
      const own = (await pols()).filter((x) => x.scope === 'owner');
      eq(own.map((x) => [x.version, x.limits, x.on_exceed]), [[1, { maxCostPerRun: 12, maxCostPerCourse: 30 }, 'BLOCK'], [2, { maxCostPerRun: 15, maxCostPerCourse: 30 }, 'BLOCK']], 'owner versionado (tipo numérico conservado)');
      eq((await pols()).filter((x) => x.scope === 'global').length, rows.length, 'global intacta');
      // El presupuesto se sigue validando: la política nueva es la que ve el gate (sin aprobaciones automáticas).
      const pf = await budget.policyFor(999999, OWNER_STG);
      eq([pf.limits.maxCostPerRun, pf.onExceed], [15, 'BLOCK'], 'policyFor ve la versión nueva');
      // Guardarraíl real: sin MIGRATION_ENV=staging no corre.
      const bad = spawnSync(process.execPath, [path.join(REPO, 'scripts/staging-budget-policy.js')], { cwd: tmpCwd, env: cleanEnv({ NODE_ENV: 'test', ...localEnv({}) }), encoding: 'utf8' });
      eq(bad.status, 1, 'sin MIGRATION_ENV=staging');
    });

    // ── Videogen (dynamic-item-worker) ──
    let ytSeq = 0;
    const ytPublisher = {
      async getConnection() { return { userId: OWNER, status: 'active', scopes: 'youtube.upload,youtube.readonly' }; },
      async getAccessToken() { return 'fake-access'; },
      async uploadFromUrl(_c, options) { await options.onBeforeUpload(syntheticMp4WithMvhd(120, 'fault')); const id = `Yt${String(++ytSeq).padStart(9, '0')}`; return { videoId: id, youtubeUrl: `https://www.youtube.com/watch?v=${id}` }; },
    };
    const vgFake = (behavior) => {
      const st = { submits: 0 };
      return {
        st,
        async batchCreate() {
          st.submits++;
          if (behavior === 'timeout') throw new Error('The operation was aborted due to timeout');
          if (behavior === '422') throw new Error('Videogen batch-create failed (HTTP 422): invalid content');
          if (behavior === 'weird') return { batch_id: 'b', jobs: [] };
          return { batch_id: `b_${st.submits}`, jobs: [{ job_id: `vg_fault_${crypto.randomUUID().slice(0, 8)}` }] };
        },
        async getVideoStatus(id) { return { job_id: id, status: 'completed_local', download_url: 'https://fake-videogen.invalid/x.mp4', progress: 100, error: null }; },
        async getVideoCost() { return { estimated_total_cost: 0.9 }; },
      };
    };
    const videoDeps = (videogen, over = {}) => ({
      scheduler: sched, dataSource: ds, artifacts: { getDownloadUrl: (id, o) => artifacts.getDownloadUrl(id, o), uploadJsonArtifact: (i) => artifacts.uploadJsonArtifact(i) },
      videogen, youtube: ytPublisher, logger: capLogger, executorId: 'f2-item-worker', leaseSeconds: 120, heartbeatMs: 600000,
      videoTimeoutMin: 1, videoPollMs: 5, mockScenario: 'success', mockResolvePolls: 1, finops: ledger, budget, ...over,
    });
    const claimVideo = (rid) => sched.claimNextItem({ executorId: 'f2-item-worker', types: ['video'], leaseSeconds: 120, runId: rid });

    await check('FAULT Videogen: DB cae antes (reserva) → 0 envíos, reintentable; timeout / respuesta rara → ambiguous_video_submission NO reintentable con reserva pendiente (retry común: 0 envíos); 4xx → rechazo definitivo, reserva liberada', async () => {
      const R = await freshRun('Fault video A', true);
      let vg = vgFake('ok');
      let item = await claimVideo(R.rid);
      await IW.processItem(videoDeps(vg, { finops: faulty(ledger, isReservationWrite) }), item);
      let row = await itemRow(R.rid, item.itemKey);
      eq([row.status, vg.st.submits, (await events(`item_run_id = $1`, [row.id])).length], ['retrying', 0, 0], `DB antes: 0 envíos (${row.error})`);
      await retryNow(row.id);
      vg = vgFake('timeout');
      item = await claimVideo(R.rid);
      await IW.processItem(videoDeps(vg), item);
      row = await itemRow(R.rid, item.itemKey);
      eq([row.status, vg.st.submits], ['failed', 1], 'timeout: failed tras 1 envío');
      assert(/^ambiguous_video_submission: .*timeout/.test(row.error), row.error);
      eq((await reservationsOf(row.id, 'videogen')).map((x) => x.settled), [false], 'reserva pendiente');
      // EV6 DoD (BE-A): un video con envío ambiguo es recuperación de admin (reconcile_videogen) → lo reintenta un SUPER_ADMIN.
      await rejectsRe(runs.retryItem(R.cid, OWNER, 1, R.rid, item.itemKey), /admin_recovery_only/, 'dueño', 403);
      await runs.retryItem(R.cid, OWNER, 1, R.rid, item.itemKey, false, false, undefined, { email: 'admin@cursia.test' });
      await IW.processItem(videoDeps(vg), await claimVideo(R.rid));
      eq(vg.st.submits, 1, 'retry común: 0 envíos nuevos');
      const R2 = await freshRun('Fault video B', true);
      const vgw = vgFake('weird');
      await IW.processItem(videoDeps(vgw), await claimVideo(R2.rid));
      row = await itemRow(R2.rid, `video:${R2.c1}`);
      eq([row.status, vgw.st.submits, /^ambiguous_video_submission: .*forma inesperada/.test(row.error)], ['failed', 1, true], `respuesta rara (${row.error})`);
      const R3 = await freshRun('Fault video C', true);
      const vg4 = vgFake('422');
      await IW.processItem(videoDeps(vg4), await claimVideo(R3.rid));
      row = await itemRow(R3.rid, `video:${R3.c1}`);
      eq([row.status, /^videogen_submit_rejected/.test(row.error)], ['failed', true], `422 (${row.error})`);
      eq((await reservationsOf(row.id, 'videogen')).map((x) => x.settled), [true], '422: reserva liberada');
    });

    await check('FAULT Videogen: DB cae DESPUÉS del envío (job sin persistir) → ambiguous_video_submission con el jobId en el motivo; falla la liquidación al terminar → retoma el MISMO job (0 reenvíos) y deja UN cargo', async () => {
      const R = await freshRun('Fault video D', true);
      const vg = vgFake('ok');
      const extFails = faulty(sched, (k, a) => k === 'recordItemExternal' && a[2] && a[2].external && a[2].external.videogenJobId);
      await IW.processItem(videoDeps(vg, { scheduler: extFails }), await claimVideo(R.rid));
      let row = await itemRow(R.rid, `video:${R.c1}`);
      eq([row.status, vg.st.submits], ['failed', 1], `failed tras 1 envío (${row.error})`);
      assert(/^ambiguous_video_submission: .*vg_fault_/.test(row.error), row.error);
      const R2 = await freshRun('Fault video E', true);
      const vg2 = vgFake('ok');
      await IW.processItem(videoDeps(vg2, { finops: faulty(ledger, (k) => k === 'settleReservation') }), await claimVideo(R2.rid));
      row = await itemRow(R2.rid, `video:${R2.c1}`);
      eq([row.status, vg2.st.submits], ['retrying', 1], `liquidación caída: reintentable (${row.error})`);
      await retryNow(row.id);
      await IW.processItem(videoDeps(vg2), await claimVideo(R2.rid));
      row = await itemRow(R2.rid, `video:${R2.c1}`);
      eq([row.status, vg2.st.submits], ['completed', 1], `retoma el mismo job (${row.error})`);
      eq((await finalCharges(`item_run_id = $1 and provider = 'videogen'`, [row.id])).length, 1, 'UN cargo por el job');
      eq((await reservationsOf(row.id, 'videogen')).map((x) => x.settled), [true], 'reserva liquidada');
    });

    await check('REVIEW I5: Videogen con costo pendiente al terminar el render → en la fase YouTube el costo llega pero el LEDGER falla → el item NO completa en silencio (reintentable); el re-claim NO re-sube ni re-renderiza y liquida', async () => {
      const R = await freshRun('Review I5', true);
      let costCalls = 0;
      const vg = { st: { submits: 0 },
        async batchCreate() { this.st.submits++; return { batch_id: 'b_i5', jobs: [{ job_id: `vg_i5_${crypto.randomUUID().slice(0, 8)}` }] }; },
        async getVideoStatus(id) { return { job_id: id, status: 'completed_local', download_url: 'https://fake-videogen.invalid/x.mp4', progress: 100, error: null }; },
        async getVideoCost() { costCalls++; if (costCalls === 1) throw new Error('costs endpoint 503'); return { estimated_total_cost: 0.88 }; },
      };
      const ytBefore = ytSeq;
      await IW.processItem(videoDeps(vg, { finops: faulty(ledger, (k) => k === 'recordAdjustment') }), await claimVideo(R.rid));
      let row = await itemRow(R.rid, `video:${R.c1}`);
      eq(row.status, 'retrying', `no completa en silencio (${row.error})`);
      assert(/finops_ledger_write_failed/.test(row.error), row.error);
      await retryNow(row.id);
      await IW.processItem(videoDeps(vg), await claimVideo(R.rid));
      row = await itemRow(R.rid, `video:${R.c1}`);
      eq([row.status, vg.st.submits, ytSeq - ytBefore], ['completed', 1, 1], `completa: 1 render, 1 subida (${row.error})`);
      const net = (await events(`item_run_id = $1 and provider = 'videogen'`, [row.id])).reduce((a, e) => a + Number(e.amount), 0);
      assert(near(net, 0.88), `neto liquidado ${net}`);
    });

    // ═══ Calibración #2 — Pages proxy REAL (frontend) → JWT ES256 → Anthropic FALSO → ingest HTTP REAL (Nest + guard)
    //     → ledger REAL (PG16) con la cadena curso/Blueprint/Manifest/run/item_run. 1 operación = 1 evento.
    const FE_REPO = process.env.CURSIA_FRONTEND_REPO || path.resolve(REPO, '../campuscloud-gen');
    const PROXY_JS = path.join(FE_REPO, 'functions/api/proxy.js');
    if (!fs.existsSync(PROXY_JS)) {
      console.log(`⚠️  sin ${PROXY_JS} (CURSIA_FRONTEND_REPO): se omite el e2e del proxy de Pages`);
    } else {
      await check('E2E Pages proxy (functions/api/proxy.js real, config de staging server_only) → JWT ES256 validado → Anthropic falso → ingest HTTP real → ledger: owner / curso / Blueprint / Manifest / run / item_run / item_key / módulo / capítulo / proveedor / modelo / usage / snapshot de precio; 1 operación = 1 evento (re-post idempotente)', async () => {
        const { NestFactory } = require('@nestjs/core');
        const { Module, Logger: NestLogger } = require('@nestjs/common');
        NestLogger.overrideLogger(false);
        const FC = loadDist('modules/finops/finops.controller.js');
        const FG = loadDist('modules/finops/finops-ingest-token.guard.js');
        const FL = loadDist('modules/finops/finops-ledger.service.js');
        class IngestE2EModule {}
        Module({ controllers: [FC.FinopsIngestController], providers: [{ provide: FL.FinopsLedgerService, useValue: ledger }, FG.FinopsIngestTokenGuard] })(IngestE2EModule);
        const app = await NestFactory.create(IngestE2EModule, { logger: false });
        app.setGlobalPrefix('api/v1');
        await app.listen(0, '127.0.0.1');
        const backend = `http://127.0.0.1:${app.getHttpServer().address().port}`;
        const savedTok = process.env.FINOPS_INGEST_TOKEN;
        process.env.FINOPS_INGEST_TOKEN = 'finops-e2e-token';
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e', alg: 'ES256', use: 'sig' };
        const b64 = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const SUPA = 'https://e2e-staging.supabase.co';
        const hdr = b64(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'e2e' }));
        const pay = b64(JSON.stringify({ sub: OWNER, exp: Math.floor(Date.now() / 1000) + 600 }));
        const token = `${hdr}.${pay}.${b64(crypto.sign('sha256', Buffer.from(`${hdr}.${pay}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }))}`;
        const realFetch = globalThis.fetch;
        const anth = [];
        let msgSeq = 1; // msg_e2e_1 es la operación que se repite
        let replayNext = false; // el proxy no reenvía headers del cliente a Anthropic: la repetición la decide la prueba
        globalThis.fetch = async (url, opts = {}) => {
          const u = String(url);
          if (u === `${SUPA}/auth/v1/.well-known/jwks.json`) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
          if (u === 'https://api.anthropic.com/v1/messages') {
            anth.push({ key: opts.headers['x-api-key'] });
            const id = replayNext ? 'msg_e2e_1' : `msg_e2e_${++msgSeq}`;
            return new Response(JSON.stringify({ id, type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3000, output_tokens: 3700, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }), { status: 200, headers: { 'request-id': `req_${id}` } });
          }
          if (u.startsWith(backend)) return realFetch(url, opts);
          throw new Error('red inesperada en el e2e del proxy: ' + u);
        };
        try {
          const { onRequest } = await import(require('url').pathToFileURL(PROXY_JS).href);
          const R = await freshRun('E2E proxy Pages');
          const target = await itemRow(R.rid, `content:${R.c1}`);
          const env = { SUPABASE_URL: SUPA, ANTHROPIC_API_KEY: 'sk-cursia-staging-e2e', ANTHROPIC_KEY_POLICY: 'server_only', FINOPS_BACKEND_URL: backend, FINOPS_INGEST_TOKEN: 'finops-e2e-token' };
          const callProxy = async (extra = {}) => {
            replayNext = !!extra['x-e2e-replay'];
            const waits = [];
            const request = new Request('https://staging.orbia.pages.dev/api/proxy', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-user-key': 'sk-personal-NO', 'x-cursia-item-run-id': target.id, 'x-cursia-call-role': 'main', 'x-cursia-attempt': '1', ...extra },
              body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 8000, messages: [{ role: 'user', content: 'capítulo' }] }),
            });
            const res = await onRequest({ request, env, waitUntil: (p) => waits.push(p) });
            await Promise.all(waits);
            return res.status;
          };
          eq(await callProxy({ 'x-e2e-replay': '1' }), 200, 'proxy 200');
          const evs = await events(`idempotency_key = 'anthropic:msg:msg_e2e_1'`, []);
          eq(evs.length, 1, 'exactamente 1 evento por la operación');
          const e = evs[0];
          const [bp] = await ds.query(`select b.id from public.course_blueprints b where b.course_id = $1`, [R.cid]);
          eq([e.owner_id, e.course_id, e.blueprint_id, e.manifest_id, e.run_id, e.item_run_id, e.item_key, e.module_id, e.chapter_id],
            [OWNER, R.cid, bp.id, R.manifest.id, R.rid, target.id, `content:${R.c1}`, R.m1, R.c1], 'atribución completa');
          eq([e.provider, e.model_or_product, e.operation, e.billing_account, e.cost_source, e.measurement_status, e.external_operation_id, e.recorded_by],
            ['anthropic', 'claude-haiku-4-5-20251001', 'llm.content', 'cursia', 'CALCULATED_FROM_USAGE', 'final', 'msg_e2e_1', 'llm-proxy'], 'proveedor / modelo / medición');
          eq([Number(e.usage.input_tokens), Number(e.usage.output_tokens)], [3000, 3700], 'usage');
          assert(e.pricing_snapshot && JSON.stringify(e.pricing_snapshot).includes('claude-haiku-4-5') && Number(e.amount) > 0, `snapshot de precio + monto ${e.amount}`);
          eq(anth.map((a) => a.key), ['sk-cursia-staging-e2e'], 'clave de Cursia (x-user-key ignorada)');
          // La MISMA operación re-posteada (reintento del post / reintento del proxy) → sigue siendo 1 evento.
          eq(await callProxy({ 'x-e2e-replay': '1' }), 200, 'replay 200');
          eq((await events(`idempotency_key = 'anthropic:msg:msg_e2e_1'`, [])).length, 1, 'misma operación = 1 evento');
          // Otra operación distinta → otro evento (1 operación = 1 evento).
          eq(await callProxy(), 200, 'segunda operación');
          const all = await events(`item_run_id = $1 and provider = 'anthropic'`, [target.id]);
          eq(all.length, 2, `2 operaciones = 2 eventos (${JSON.stringify(all.map((x) => [x.event_kind, x.idempotency_key, x.recorded_by]))})`);
        } finally {
          globalThis.fetch = realFetch;
          if (savedTok === undefined) delete process.env.FINOPS_INGEST_TOKEN; else process.env.FINOPS_INGEST_TOKEN = savedTok;
          await app.close();
        }
      });
    }

    await check('DB netguard/fakes: todas las llamadas a proveedores fueron a 127.0.0.1 con SU clave (0 rechazos de auth en los fakes)', async () => {
      eq(fakes.st.badAuth, [], 'claves correctas');
      assert(fakes.st.gammaPosts.length >= 2 && fakes.st.exports.length >= 2 && fakes.st.tts.length >= 3 && fakes.st.llm.filter((x) => !x.failed).length >= 3, JSON.stringify({ g: fakes.st.gammaPosts.length, e: fakes.st.exports.length, t: fakes.st.tts.length, l: fakes.st.llm.length }));
    });

    await check('DB secretos: ninguna clave aparece en logs capturados, errores de items, output_summary, metadata de artifacts ni del ledger', async () => {
      const dump = JSON.stringify([
        LOGS,
        await ds.query(`select error, output_summary from public.generation_item_runs`),
        await ds.query(`select metadata from public.artifacts`),
        await ds.query(`select metadata, usage from public.generation_cost_events`),
        fakes.st,
      ]);
      for (const [k, v] of Object.entries(SECRETS)) assert(!dump.includes(v), `${k} filtrada`);
      assert(LOGS.length > 0, 'hubo logs para revisar');
    });
  } finally {
    await fakes.close().catch(() => {});
    await new Promise((r) => storage.srv.close(() => r()));
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
