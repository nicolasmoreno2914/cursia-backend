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

  await check('puro: guion de capítulo — 1 llamada si alcanza; corto → UNA continuación; sigue corto → AUDIOBOOK_SCRIPT_TOO_SHORT (fail loud); prompts del legacy', async () => {
    const input = { courseTitle: 'Curso', chapterNumber: 2, chapterTitle: 'Bombas', sector: 'Minería', nivel: 'Intermedio', contentMarkdown: '# Bombas\n\nTexto **real** del capítulo.' };
    const w = (n) => Array.from({ length: n }, () => 'palabra').join(' ');
    let calls = [];
    const r1 = await AS.generateChapterScript(input, async (p, role) => { calls.push(role); return { text: w(430), messageId: 'msg_a' }; });
    eq([calls, r1.words, r1.continued, r1.messageIds], [['main'], 430, false, ['msg_a']], 'una llamada');
    calls = [];
    const r2 = await AS.generateChapterScript(input, async (p, role) => { calls.push(role); return { text: w(role === 'main' ? 200 : 200), messageId: `msg_${role}` }; });
    eq([calls, r2.words, r2.continued, r2.messageIds], [['main', 'continuation'], 400, true, ['msg_main', 'msg_continuation']], 'continuación');
    const err = await rejectsRe(AS.generateChapterScript(input, async () => ({ text: w(100), messageId: 'm' })), /AUDIOBOOK_SCRIPT_TOO_SHORT/, 'corto');
    eq(err.retryable, true, 'reintentable');
    const p = AS.chapterNarrationPrompt(input);
    assert(/Entre 350 y 600 palabras/.test(p.system) && /Capítulo 2 — Bombas del curso "Curso" orientado a Minería, nivel Intermedio/.test(p.user) && !/\*\*/.test(p.user), 'prompt');
    const chunks = AS.splitForTts(`${'Oración de prueba. '.repeat(400)}`);
    assert(chunks.length >= 2 && chunks.every((c) => c.length <= AS.TTS_MAX_CHARS && c.length > 0), `chunks ${chunks.map((c) => c.length)}`);
  });

  await check('puro: cuerpo de Gamma — textOptions.language es-419, themeId del tema, 10 tarjetas, export PDF, texto limpio', () => {
    const b = RP.gammaGenerationBody({ chapterTitle: 'Cap 1', contentMarkdown: '## Título\n**negrita**', themeId: 'th-1' });
    eq([b.textOptions.language, b.themeId, b.numCards, b.exportAs, b.format], ['es-419', 'th-1', 10, 'pdf', 'presentation'], 'campos');
    assert(b.inputText === 'Cap 1\n\nTítulo negrita', `inputText ${JSON.stringify(b.inputText)}`);
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

  await check('puro: worker real sin claves → provider_not_ready (no reintentable) ANTES de llamar; marcador de envío sin generationId → ambiguous_gamma_submission sin reenviar', async () => {
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
      await rejectsRe(PW.processProviderItem(amb.deps, amb.item('presentation')), /^ambiguous_gamma_submission/, 'ambiguo');
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
  'ANTHROPIC_API_BASE_URL', ...PROVIDER_ENV_KEYS,
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

    await check('DB ledger Gamma: 1 CHARGE CALCULATED_FROM_USAGE = credits.deducted (42) × precio por crédito del catálogo; external_operation_id = generationId; atribuido al item; idempotente', async () => {
      const evs = await events(`provider = 'gamma'`, []);
      eq(evs.length, 1, 'un cargo');
      const e = evs[0];
      eq([e.cost_source, e.operation, e.external_operation_id, e.idempotency_key, e.billing_account, e.measurement_status, e.item_key, e.run_id, e.recorded_by],
        ['CALCULATED_FROM_USAGE', 'gamma.generate', genId1, `gamma:gen:${genId1}`, 'cursia', 'final', `presentation:${C.c1}`, runId, 'dynamic-provider-worker'], 'evento');
      assert(near(e.amount, 0.42) && Number(e.usage.gamma_credit) === 42, `monto ${e.amount}`);
      eq(e.metadata.creditsRemaining, 958, 'saldo');
      const again = await H.recordGammaCharge(ledger, { ownerId: OWNER, itemRunId: e.item_run_id, generationId: genId1, creditsDeducted: 42, creditsRemaining: 958 });
      eq(again.inserted, false, 're-registro = no-op');
      eq((await events(`provider = 'gamma'`, [])).length, 1, 'sigue uno');
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
      fakes.plan.gammaHoldPending = false;
      await ds.query(`update public.generation_item_runs set next_retry_at = now() where id = $1`, [row.id]);
      const again = await claimProvider(runId, 'presentation');
      assert(again && again.itemRunId === row.id && again.outputSummary.external.gammaGenerationId === gid, 're-claim con el id');
      await PW.processProviderItem(workerDeps(), again);
      row = await itemRow(runId, item.itemKey);
      eq(row.status, 'completed', `completado (${row.error})`);
      eq(fakes.st.gammaPosts.length, 2, 'NINGÚN reenvío');
      eq((await events(`provider = 'gamma' and external_operation_id = $1`, [gid])).length, 1, 'un cargo por la generación');
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
      const evs = await events(`item_run_id = $1`, [row.id]);
      eq(evs.map((e) => [e.provider, e.operation, e.cost_source, e.external_operation_id, e.idempotency_key]),
        [['openai', 'tts.audio_welcome', 'CALCULATED_FROM_USAGE', call.requestId, `openai:req:${call.requestId}`]], 'evento');
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
      const s = row.output_summary.audiobookScript;
      assert(s && s.words >= 350 && s.messageIds.join() === calls.map((c) => c.id).join(), `guion persistido ${JSON.stringify(s && s.words)}`);
      const llmEv = await events(`item_run_id = $1 and provider = 'anthropic'`, [row.id]);
      eq(llmEv.map((e) => [e.operation, e.call_role, e.cost_source, e.external_operation_id, e.idempotency_key]),
        calls.map((c, i) => ['llm.audiobook_script', i === 0 ? 'main' : 'continuation', 'CALCULATED_FROM_USAGE', c.id, `anthropic:msg:${c.id}`]), 'eventos LLM');
      assert(near(llmEv[0].amount, 1200 * 3 / 1e6 + 640 * 15 / 1e6), `monto main ${llmEv[0].amount}`);
      const ttsEv = await events(`item_run_id = $1 and provider = 'openai'`, [row.id]);
      assert(ttsEv.length >= 1 && ttsEv.every((e) => e.operation === 'tts.audiobook_chapter' && e.cost_source === 'CALCULATED_FROM_USAGE' && /^req_f2_/.test(e.external_operation_id)), 'eventos TTS');
      const [art] = await ds.query(`select * from public.artifacts where item_run_id = $1 and type = 'dynamic_audio_mp3'`, [row.id]);
      const mp3 = storage.blobs.get(`cursia-artifacts/${art.storage_path}`);
      eq(art.metadata.durationSeconds, AUD.mp3DurationSeconds(mp3), 'duración medida');
      assert(art.metadata.script === s.text && art.metadata.words === s.words, 'guion en el artifact');
    });

    await check('DB audiolibro reanudación: TTS falla (500) tras el guion → reintentable; el re-claim reutiliza el guion guardado (0 llamadas LLM nuevas) y completa', async () => {
      fakes.plan.ttsFail = [500];
      const llm0 = fakes.st.llm.length;
      const item = await claimProvider(runId, 'audiobook_chapter');
      assert(item && item.chapterId === C.c2, 'claim C2');
      await PW.processProviderItem(workerDeps(), item);
      let row = await itemRow(runId, item.itemKey);
      eq(row.status, 'retrying', `estado ${row.status} ${row.error}`);
      assert(/^tts_failed/.test(row.error) && row.output_summary.audiobookScript, 'guion guardado');
      const llmAfterFirst = fakes.st.llm.length;
      eq(llmAfterFirst - llm0, 1, 'una llamada LLM');
      await ds.query(`update public.generation_item_runs set next_retry_at = now() where id = $1`, [row.id]);
      const again = await claimProvider(runId, 'audiobook_chapter');
      await PW.processProviderItem(workerDeps(), again);
      row = await itemRow(runId, item.itemKey);
      eq(row.status, 'completed', `completado (${row.error})`);
      eq(fakes.st.llm.length, llmAfterFirst, '0 llamadas LLM en la reanudación');
      eq((await events(`item_run_id = $1 and provider = 'anthropic'`, [row.id])).length, 1, 'un solo cargo LLM');
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

    await check('DB netguard/fakes: todas las llamadas a proveedores fueron a 127.0.0.1 con SU clave (0 rechazos de auth en los fakes)', async () => {
      eq(fakes.st.badAuth, [], 'claves correctas');
      assert(fakes.st.gammaPosts.length === 2 && fakes.st.exports.length === 2 && fakes.st.tts.length >= 4 && fakes.st.llm.length === 3, JSON.stringify({ g: fakes.st.gammaPosts.length, e: fakes.st.exports.length, t: fakes.st.tts.length, l: fakes.st.llm.length }));
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
