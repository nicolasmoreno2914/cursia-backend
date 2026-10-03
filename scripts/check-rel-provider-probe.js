#!/usr/bin/env node
/* eslint-disable */
// REL CREDIT (2026-10-03) — sonda del proveedor tras crédito/cuota agotados (reanudación sin clic).
//
// Parte pura (siempre; --pure-only para CI):
//   - elegibilidad: crédito de Anthropic (navegador «Sin disponibilidad…», guion del audiolibro «credit balance
//     is too low») y cuota de OpenAI (insufficient_quota en el 1.er trozo) → sí; auth / key inválida / proxy mal
//     configurado / trozos de TTS ya pagados (C) / video / Gamma / YouTube → nunca;
//   - espera 5, 10, 20, 40, 60 min (tope) con jitter +0…20 % determinista; ~24 h de tope;
//   - plan: un único canario por (run, proveedor) (primero un item del servidor), en vuelo → ninguno más,
//     canario pendiente sin reclamar > 30 min → no cuenta; éxito → reanudar el resto; detenido por el usuario
//     → nunca; kill-switch legacy.
// Parte DB (default; PG16 desechable, puerto libre ≠ 5570 / 8099; proveedores solo como variables de entorno
// falsas, nunca se llaman):
//   - fallo por crédito: sin reapertura inmediata (la vista dice provider_probe + nextRetryAt + config, la
//     acción de admin sigue); pasada la espera, UN canario (log de intentos `provider_probe`), ninguno más
//     mientras vuela; un canario por proveedor;
//   - el canario vuelve a fallar por crédito: la espera crece (5 → 10 → 20 min), un intento por sonda, las
//     rondas del auto-healer intactas;
//   - el canario termina bien: el resto se reabre (y sus dependientes), `provider_probe_resume`;
//   - auth / video / Gamma / YouTube / trozos de TTS pagados → nunca; kill-switch; run cancelado; detenido por
//     el usuario; más de 24 h → needs_attention como hoy.
//
// Usage: npm run build && node scripts/check-rel-provider-probe.js [--pure-only] [path/to/dist]

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
    console.error(`❌ No se pudo cargar ${abs} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}

require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const AH = loadDist('modules/dynamic-generation/auto-heal.js');
const PP = loadDist('modules/reliability/provider-probe.js');
const { applyFakeProviderEnv } = require('./lib/provider-test-env');

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

const NOW = new Date('2026-10-03T12:00:00Z');
const ago = (sec) => new Date(NOW.getTime() - sec * 1000).toISOString();
const ANTH_BROWSER = '❌ Sin disponibilidad de generación. Contacta a soporte de Cursia.';
const ANTH_SCRIPT = 'audiobook_script_failed: anthropic HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
const OPENAI_TTS = 'tts_failed: chunk 1/4: openai HTTP 429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}';
const AUTH_ERRS = [
  ['audiobook_script_failed: anthropic HTTP 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'audiobook_chapter'],
  ['tts_failed: chunk 1/4: openai HTTP 401: Incorrect API key provided (invalid_api_key)', 'audio_welcome'],
  ['❌ No tienes acceso. Inicia sesión o verifica tu cuenta en Cursia.', 'content'],
  ['❌ El servicio de IA de este entorno no está configurado. Contacta a soporte de Cursia.', 'experience'],
  ['API key no configurada', 'activity'],
];
const NEVER_ERRS = [
  ['gamma_submit_failed: gamma POST /generations HTTP 400: saldo insuficiente (credits)', 'presentation'],
  ['unexpected_error: videogen HTTP 402 payment required: credit balance', 'video'],
  ['youtube_blocked_quota: cuota diaria agotada', 'video'],
  // Trozos de TTS ya pagados antes del que falló → C (reconciliación), nunca una sonda.
  ['tts_failed: chunk 3/4: openai HTTP 429: insufficient_quota', 'audiobook_chapter'],
];
const prow = (error, o = {}) => ({ id: o.id || 'i1', item_key: o.key || o.id || 'i1', type: o.type || 'audiobook_chapter', status: o.status || 'failed', error,
  output_summary: o.os || {}, finished_at: o.finished_at || ago(o.secAgo ?? 30), claimed_at: o.claimed_at || null, failure_class: o.cls ?? null });

// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  await check('puro: elegibles = crédito de Anthropic (navegador y guion del audiolibro) y cuota de OpenAI (1.er trozo / insufficient_quota)', () => {
    eq(PP.providerCreditWaitOf(prow(ANTH_BROWSER, { type: 'experience' })), 'anthropic', 'navegador experience');
    eq(PP.providerCreditWaitOf(prow(ANTH_BROWSER, { type: 'activity' })), 'anthropic', 'navegador activity');
    eq(PP.providerCreditWaitOf(prow(ANTH_SCRIPT)), 'anthropic', 'guion del audiolibro');
    eq(PP.providerCreditWaitOf(prow('audiobook_script_failed: HTTP 400: Your credit balance is too low')), 'anthropic', 'guion (corto)');
    eq(PP.providerCreditWaitOf(prow(OPENAI_TTS)), 'openai', 'TTS 1.er trozo');
    eq(PP.providerCreditWaitOf(prow('tts_failed: chunk 1/2: HTTP 429: insufficient_quota', { type: 'audio_welcome' })), 'openai', 'bienvenida');
    eq(PP.providerCreditWaitOf(prow('insufficient_quota: openai', { type: 'audio_welcome' })), 'openai', 'código insufficient_quota');
    eq(PP.providerCreditWaitOf(prow(ANTH_SCRIPT, { status: 'retrying' })), null, 'solo failed');
  });

  await check('puro: auth / key inválida / proxy mal configurado → nunca (humano)', () => {
    for (const [err, type] of AUTH_ERRS) eq(PP.providerCreditWaitOf(prow(err, { type })), null, `${type}: ${err}`);
  });

  await check('puro: video, Gamma, YouTube y trozos de TTS ya pagados (C) → nunca; clase C registrada → nunca; errorCode del navegador sin mensaje de crédito → nunca', () => {
    for (const [err, type] of NEVER_ERRS) eq(PP.providerCreditWaitOf(prow(err, { type })), null, `${type}: ${err}`);
    eq(PP.providerCreditWaitOf(prow(ANTH_SCRIPT, { cls: 'C' })), null, 'C registrada');
    eq(PP.providerCreditWaitOf(prow('❌ Falló después de 3 intentos: 502 Bad Gateway', { type: 'content', cls: 'D' })), null, 'D por errorCode, mensaje transitorio');
  });

  await check('puro: espera 5 → 10 → 20 → 40 → 60 min (tope) con jitter +0…20 % determinista (nunca antes)', () => {
    const base = [300, 600, 1200, 2400, 3600, 3600, 3600];
    for (let r = 0; r < base.length; r++) {
      const w = PP.providerProbeWaitSeconds(r, 'run-1:anthropic');
      assert(w >= base[r] && w <= base[r] * 1.2 + 1e-9, `sonda ${r + 1}: ${w} fuera de [${base[r]}, ${base[r] * 1.2}]`);
      eq(PP.providerProbeWaitSeconds(r, 'run-1:anthropic'), w, 'determinista');
    }
    eq(PP.PROVIDER_PROBE_MAX_HOURS, 24, 'tope 24 h');
    const ws = new Set(['a', 'b', 'c', 'd', 'e'].map((s) => PP.providerProbeWaitSeconds(0, s).toFixed(3)));
    assert(ws.size > 1, 'jitter por run');
  });

  await check('puro plan: espera → un ÚNICO canario por proveedor (primero un item del servidor) → en vuelo → ninguno más', () => {
    const w0 = PP.providerProbeWaitSeconds(0, 'run:anthropic');
    const rows = (secAgo) => [
      prow(ANTH_BROWSER, { id: 'b1', type: 'experience', secAgo }), prow(ANTH_BROWSER, { id: 'b2', type: 'activity', secAgo: secAgo - 1 }),
      prow(ANTH_SCRIPT, { id: 'w1', secAgo }), prow(ANTH_SCRIPT, { id: 'w2', secAgo }),
    ];
    let [p] = PP.planProviderProbes(rows(Math.floor(w0) - 1), NOW, 'run');
    eq([p.provider, p.action, p.waitingIds.length, p.round], ['anthropic', 'wait', 4, 0], 'en espera');
    [p] = PP.planProviderProbes(rows(Math.ceil(w0) + 1), NOW, 'run');
    eq([p.action, ['w1', 'w2'].includes(p.canaryId)], ['probe', true], 'canario del servidor');
    // Solo items del navegador: el que falló último (el que pausó al ejecutor).
    [p] = PP.planProviderProbes(rows(Math.ceil(w0) + 5).filter((r) => r.type !== 'audiobook_chapter'), NOW, 'run');
    eq([p.action, p.canaryId], ['probe', 'b2'], 'navegador: el último');
    // Canario en vuelo → ninguno más (ni pendiente, ni corriendo).
    const inflight = (status, claimed) => [...rows(4000).filter((r) => r.id !== 'w1'),
      prow(null, { id: 'w1', status, claimed_at: claimed, os: { providerProbe: { provider: 'anthropic', canaryAt: ago(60), runRound: 1 } } })];
    for (const st of ['pending', 'running', 'retrying']) {
      [p] = PP.planProviderProbes(inflight(st, st === 'pending' ? null : ago(30)), NOW, 'run');
      eq([p.action, p.inFlightId, p.canaryId], ['in_flight', 'w1', null], `en vuelo (${st})`);
    }
    // Pendiente sin reclamar por más de 30 min → no cuenta (otro canario; un pendiente no llama a nadie).
    const stalled = [...rows(4000).filter((r) => r.id !== 'w1'),
      prow(null, { id: 'w1', status: 'pending', os: { providerProbe: { provider: 'anthropic', canaryAt: ago(1900), runRound: 1 } } })];
    [p] = PP.planProviderProbes(stalled, NOW, 'run');
    eq([p.action, p.canaryId], ['probe', 'w2'], 'canario estancado → otro');
  });

  await check('puro plan: un canario por PROVEEDOR (Anthropic y OpenAI independientes)', () => {
    const plans = PP.planProviderProbes([prow(ANTH_SCRIPT, { id: 'a', secAgo: 4000 }), prow(OPENAI_TTS, { id: 'o', type: 'audio_welcome', secAgo: 4000 })], NOW, 'run');
    eq(plans.map((p) => [p.provider, p.action, p.canaryId]), [['anthropic', 'probe', 'a'], ['openai', 'probe', 'o']], 'dos proveedores');
  });

  await check('puro plan: el canario terminó bien → reanudar el resto; falló otra vez → espera más larga; 24 h → exhausted; detenido por el usuario → paused', () => {
    const st = (o) => ({ providerProbe: { provider: 'anthropic', firstFailedAt: ago(3600), ...o } });
    let [p] = PP.planProviderProbes([prow(null, { id: 'w1', status: 'completed', os: st({ canaryAt: ago(100), runRound: 1 }) }),
      prow(ANTH_SCRIPT, { id: 'w2', secAgo: 3600 }), prow(ANTH_BROWSER, { id: 'b1', type: 'activity', secAgo: 3600 })], NOW, 'run');
    eq([p.action, p.successIds, p.waitingIds], ['resume', ['w1'], ['w2', 'b1']], 'reanudar');
    // Re-falla del canario (ronda 1 hecha): la próxima espera es la de la sonda 2 (10 min) desde la re-falla.
    const w1 = PP.providerProbeWaitSeconds(1, 'run:anthropic');
    [p] = PP.planProviderProbes([prow(ANTH_SCRIPT, { id: 'w1', secAgo: 400, os: st({ canaryAt: ago(500), runRound: 1, rounds: 1 }) }),
      prow(ANTH_SCRIPT, { id: 'w2', secAgo: 3600 })], NOW, 'run');
    eq([p.action, p.round], ['wait', 1], 'espera de la sonda 2');
    eq(Math.round((p.nextProbeAt.getTime() - (NOW.getTime() - 400e3)) / 1000), Math.round(w1), 'nextProbeAt = re-falla + 10 min (+jitter)');
    eq(p.streakStartAt.toISOString(), ago(3600), 'la racha empieza en el primer fallo');
    [p] = PP.planProviderProbes([prow(ANTH_SCRIPT, { id: 'w1', secAgo: 30, os: st({ firstFailedAt: ago(25 * 3600), runRound: 7 }) })], NOW, 'run');
    eq(p.action, 'exhausted', '> 24 h');
    [p] = PP.planProviderProbes([prow(ANTH_SCRIPT, { id: 'w1', secAgo: 4000 }), prow('Generación detenida por el usuario', { id: 'c1', type: 'content' })], NOW, 'run');
    eq(p.action, 'paused', 'detenido por el usuario');
  });

  await check('puro: kill-switch DYNAMIC_AUTO_HEAL_POLICY=legacy apaga la sonda; vista: provider_probe con nextRetryAt solo si aplica', () => {
    eq(PP.providerProbeEnabled(AH.autoHealPolicyFromEnv({})), true, 'por defecto encendida');
    eq(PP.providerProbeEnabled(AH.autoHealPolicyFromEnv({ DYNAMIC_AUTO_HEAL_POLICY: 'legacy' })), false, 'legacy');
    const v = PP.providerProbeViewOf(prow(ANTH_SCRIPT, { secAgo: 30 }), NOW, true);
    eq([v.provider, v.nextProbeAt.toISOString()], ['anthropic', new Date(NOW.getTime() - 30e3 + 300e3).toISOString()], 'primera sonda estimada');
    eq(PP.providerProbeViewOf(prow(ANTH_SCRIPT), NOW, false), null, 'apagada');
    eq(PP.providerProbeViewOf(prow(AUTH_ERRS[0][0]), NOW, true), null, 'auth');
    eq(PP.providerProbeViewOf(prow(ANTH_SCRIPT, { secAgo: 25 * 3600 }), NOW, true), null, '> 24 h');
  });
}

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
      srv.close(() => ([5570, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const CONTEXT = { nombre: 'Curso REL CREDIT', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY',
  'SUPER_ADMIN_EMAILS', 'DYNAMIC_AUTO_HEAL_POLICY', 'DYNAMIC_AUTO_HEAL_ENABLED'];

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
  const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
  const { Artifact } = loadDist('modules/artifacts/entities/artifact.entity.js');
  const AL = loadDist('modules/reliability/attempt-log.js');
  const F = loadDist('modules/finops/index.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-relprobe-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-relprobe-cwd-'));
  const ROLE = 'postgres.relprobelocal01';
  const DB = 'relprobedb';
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
      'scripts/migrate-v21-finops.js', 'scripts/verify-v21-finops-schema.js', 'scripts/migrate-rel-recovery.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    delete process.env.DYNAMIC_AUTO_HEAL_POLICY;
    process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    delete process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT;
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    process.env.VIDEOGEN_API_KEY = 'fake-videogen-key-never-used-no-network';
    process.env.SUPER_ADMIN_EMAILS = 'admin@cursia.test';
    AL.resetRelSchemaCache();

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const ytOk = { async check() { return { ok: true }; } };
    const runs = new RunsService(ds, manifests, {}, ytOk, budget);
    const sched = new SchedulerService(ds, runs);

    async function makeCourse(title) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: true, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'Válvulas', objective: null, video_enabled: false, activity_enabled: true }],
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
      let runId;
      try {
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      } catch (err) {
        const body = err.getResponse ? err.getResponse() : null;
        assert(body && body.code === 'budget_approval_required', `startRun: ${err.message}`);
        await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test', reason: 'check REL CREDIT' });
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      }
      return { cid, m1, c1, c2, runId };
    }
    const itemRow = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const itemsOfType = async (runId, type) => ds.query(`select * from public.generation_item_runs where job_id = $1 and type = $2 order by item_key`, [runId, type]);
    const setRow = (id, sets, params = []) => ds.query(`update public.generation_item_runs set ${sets} where id = $1`, [id, ...params]);
    // Fallo terminal como lo deja applyItemFailure (failed, sin lease) + dependientes bloqueados.
    const failAt = async (runId, id, error, secAgo) => {
      await setRow(id, `status = 'failed', error = $2, worker_id = null, lease_until = null, next_retry_at = null,
                        finished_at = now() - make_interval(secs => $3::int)`, [error, secAgo]);
      const [r] = await ds.query(`select item_key from public.generation_item_runs where id = $1`, [id]);
      await ds.query(
        `with recursive dep(key) as (select $2::text union select g.item_key from public.generation_item_runs g join dep on dep.key = any(g.depends_on) where g.job_id = $1)
         update public.generation_item_runs set status = 'blocked' where job_id = $1 and item_key in (select key from dep) and item_key <> $2 and status in ('pending', 'retrying')`,
        [runId, r.item_key]);
    };
    const at = (sec) => new Date(Date.now() + sec * 1000);
    const probe = (secLater = 0, policy) => runs.autoProbeProviderCredit({ now: at(secLater), ...(policy ? { policy } : {}) });
    const attempts = (itemRunId) => ds.query(`select * from public.generation_item_attempts where item_run_id = $1 order by created_at, id`, [itemRunId]);
    const ofRun = (res, runId) => ({
      probed: res.probed.filter((x) => x.runId === runId), resumed: res.resumed.filter((x) => x.runId === runId),
      waiting: res.waiting.filter((x) => x.runId === runId), skipped: res.skipped.filter((x) => x.runId === runId),
    });
    // Run con todo completado salvo los items a fallar (y sus dependientes, que quedan bloqueados).
    async function creditRun(title, fails) {
      const K = await makeCourse(title);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now(), error = null where job_id = $1`, [K.runId]);
      // Los dependientes de los fallados vuelven a pending (failAt los bloquea como al fallar de verdad).
      const all = await ds.query(`select id, item_key, type, depends_on from public.generation_item_runs where job_id = $1`, [K.runId]);
      const failKeys = new Set();
      for (const f of fails) {
        const it = all.filter((x) => x.type === f.type)[f.idx || 0];
        assert(it, `${title}: no hay item ${f.type}`);
        f.key = it.item_key;
        f.id = it.id;
        failKeys.add(it.item_key);
      }
      const deps = new Set();
      let grew = true;
      while (grew) {
        grew = false;
        for (const x of all) if (!deps.has(x.item_key) && !failKeys.has(x.item_key) && (x.depends_on || []).some((d) => failKeys.has(d) || deps.has(d))) { deps.add(x.item_key); grew = true; }
      }
      if (deps.size) await ds.query(`update public.generation_item_runs set status = 'pending', finished_at = null where job_id = $1 and item_key = any($2::text[])`, [K.runId, [...deps]]);
      for (const f of fails) {
        await setRow(f.id, `attempt_count = 3, max_attempts = 3`);
        await failAt(K.runId, f.id, f.error, f.secAgo ?? 10);
      }
      await ds.query(`update public.production_jobs set status = 'failed', worker_status = 'failed', finished_at = now() where id = $1`, [K.runId]);
      return { ...K, fails, deps: [...deps] };
    }

    // ═══ fallo por crédito → espera → un canario ══════════════════════════════
    const K = await creditRun('CREDIT #616', [
      { type: 'experience', error: ANTH_BROWSER, secAgo: 12 },
      { type: 'activity', error: ANTH_BROWSER, secAgo: 11 },
      { type: 'audiobook_chapter', idx: 0, error: ANTH_SCRIPT, secAgo: 10 },
      // content del capítulo 2 (navegador): sus dependientes (experiencia, Gamma, actividad, audiolibro, exámenes) quedan bloqueados.
      { type: 'content', idx: 1, error: ANTH_BROWSER, secAgo: 10 },
    ]);
    const kFailed = K.fails.map((f) => f.key);
    let canaryKey = null;

    await check('DB crédito (#616): sin reapertura inmediata; la vista dice provider_probe + nextRetryAt (~5 min) + config; la acción de admin sigue; el auto-healer tampoco lo toca', async () => {
      assert(K.deps.length > 0, 'hay dependientes bloqueados: ' + JSON.stringify(K.deps));
      const r = ofRun(await probe(0), K.runId);
      eq([r.probed.length, r.resumed.length], [0, 0], 'nada reabierto');
      eq(r.waiting.map((w) => [w.provider, w.action]), [['anthropic', 'wait']], 'esperando');
      const next = Date.parse(r.waiting[0].nextProbeAt);
      const firstFail = Date.parse((await itemRow(K.runId, kFailed[0])).finished_at);
      assert(next - firstFail >= 300e3 - 2000 && next - firstFail <= 360e3 + 15e3, `primera sonda ~5 min (+jitter) después del fallo: ${(next - firstFail) / 1000}s`);
      for (const k of kFailed) {
        const row = await itemRow(K.runId, k);
        eq([row.status, row.output_summary.providerProbe.provider, row.output_summary.providerProbe.nextProbeAt], ['failed', 'anthropic', r.waiting[0].nextProbeAt], `estado persistido ${k}`);
      }
      const heal = await runs.autoHealFailedItems({ now: at(3600) });
      eq(heal.reopened.filter((x) => x.runId === K.runId).length, 0, 'auto-healer: no (D)');
      const dto = await runs.getRun(K.cid, OWNER, 1, K.runId);
      for (const k of kFailed) {
        const v = dto.items.find((x) => x.itemKey === k).recovery;
        eq([v.currentRecovery, v.strategy, v.nextRetryAt, v.attentionReason], ['provider_probe', 'wait_provider', r.waiting[0].nextProbeAt, 'config'], `vista ${k}`);
      }
      const acts = (dto.completion.adminActions || []).filter((a) => kFailed.includes(a.itemKey)).map((a) => a.code);
      eq(acts, kFailed.map(() => 'retry_item'), 'la acción de admin sigue disponible');
    });

    let idemBefore = null;
    await check('DB crédito: pasada la espera, UN canario (item del servidor), +1 intento, sin rondas del auto-healer, `provider_probe` en el log; ninguno más mientras vuela', async () => {
      const ab = await itemsOfType(K.runId, 'audiobook_chapter');
      idemBefore = Object.fromEntries(ab.map((x) => [x.id, x.idempotency_key]));
      let r = ofRun(await probe(200), K.runId);
      eq(r.probed.length, 0, 'antes de la espera');
      r = ofRun(await probe(400), K.runId);
      eq(r.probed.map((x) => [x.provider, x.round]), [['anthropic', 1]], 'un canario');
      canaryKey = r.probed[0].itemKey;
      assert(canaryKey.startsWith('audiobook_chapter:'), 'canario del servidor: ' + canaryKey);
      const row = await itemRow(K.runId, canaryKey);
      eq([row.status, row.max_attempts - row.attempt_count, row.output_summary.providerProbe.runRound, row.output_summary.providerProbe.rounds,
        !!row.output_summary.providerProbe.canaryAt, row.output_summary.autoHeal ? row.output_summary.autoHeal.rounds || 0 : 0],
      ['pending', 1, 1, 1, true, 0], 'canario');
      eq(row.idempotency_key, idemBefore[row.id], 'misma idempotency_key (el ledger del worker la reconoce)');
      const last = (await attempts(row.id)).pop();
      eq([last.outcome, last.actor, last.strategy_applied], ['reopened', 'auto_heal', 'provider_probe'], 'log de intentos');
      for (const k of kFailed.filter((x) => x !== canaryKey)) eq((await itemRow(K.runId, k)).status, 'failed', `${k} sigue esperando`);
      const run = (await ds.query(`select worker_status from public.production_jobs where id = $1`, [K.runId]))[0];
      eq(run.worker_status, 'queued', 'run reabierto para que el worker reclame el canario');
      for (const s of [500, 1500]) eq(ofRun(await probe(s), K.runId).probed.length, 0, `en vuelo (+${s}s): ninguno más`);
    });

    await check('DB crédito: el canario vuelve a fallar por crédito → un intento consumido (no más), rondas del auto-healer intactas; la espera crece 10 → 20 min', async () => {
      const deltas = [];
      for (let round = 1; round <= 2; round++) {
        // El worker reclama el canario (simulado: el payload real del worker no es parte de esta prueba).
        const c0 = await itemRow(K.runId, canaryKey);
        eq(c0.status, 'pending', 'canario reclamable');
        await setRow(c0.id, `status = 'running', worker_id = 'worker-probe', attempt_count = attempt_count + 1, claimed_at = now(),
                             lease_until = now() + interval '2 minutes'`);
        const ok = await sched.failItem(c0.id, 'worker-probe', ANTH_SCRIPT, false);
        assert(ok, 'failItem');
        const row = await itemRow(K.runId, canaryKey);
        eq([row.status, row.attempt_count === row.max_attempts, row.output_summary.autoHeal ? row.output_summary.autoHeal.rounds || 0 : 0, row.output_summary.providerProbe.rounds],
          ['failed', true, 0, round], `re-falla ${round}`);
        const r = ofRun(await probe(1), K.runId);
        eq([r.probed.length, r.waiting.map((w) => w.action)], [0, ['wait']], `espera tras la re-falla ${round}`);
        const delta = (Date.parse(r.waiting[0].nextProbeAt) - Date.parse(row.finished_at)) / 1000;
        const base = [600, 1200][round - 1];
        assert(delta >= base - 1 && delta <= base * 1.2 + 1, `sonda ${round + 1}: ${delta}s ∉ [${base}, ${base * 1.2}]`);
        deltas.push(delta);
        const r2 = ofRun(await probe(Math.ceil(base * 1.2) + 5), K.runId);
        eq(r2.probed.map((x) => [x.itemKey, x.round]), [[canaryKey, round + 1]], `sonda ${round + 1}: el mismo canario`);
      }
      assert(deltas[1] > deltas[0], 'la espera crece');
      const row = await itemRow(K.runId, canaryKey);
      eq(row.idempotency_key, idemBefore[row.id], 'idempotency_key intacta');
      eq((await attempts(row.id)).filter((a) => a.strategy_applied === 'provider_probe').length, 3, '3 sondas en el log');
    });

    await check('DB crédito: el canario termina bien → se reabren TODOS los demás que esperaban (y sus dependientes), `provider_probe_resume`, la marca del canario se consume', async () => {
      const row = await itemRow(K.runId, canaryKey);
      // El worker completa el canario (completeItem conserva output_summary: la prueba de éxito queda en providerProbe).
      await setRow(row.id, `status = 'completed', error = null, finished_at = now()`);
      const r = ofRun(await probe(1), K.runId);
      eq(r.resumed.map((x) => x.itemKey).sort(), kFailed.filter((k) => k !== canaryKey).sort(), 'todos los demás reabiertos');
      eq(r.probed.length, 0, 'sin otra sonda');
      for (const k of kFailed.filter((x) => x !== canaryKey)) {
        const it = await itemRow(K.runId, k);
        eq([it.status, it.error, it.output_summary.providerProbe === undefined], ['pending', null, true], `${k} pendiente, sin estado de sonda`);
        eq((await attempts(it.id)).pop().strategy_applied, 'provider_probe_resume', `${k}: log`);
      }
      const stillBlocked = await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and status = 'blocked'`, [K.runId]);
      eq(stillBlocked.map((x) => x.item_key), [], 'dependientes desbloqueados');
      eq((await itemRow(K.runId, canaryKey)).output_summary.providerProbe, undefined, 'marca del canario consumida');
      const again = ofRun(await probe(5), K.runId);
      eq([again.resumed.length, again.probed.length], [0, 0], 'idempotente');
    });

    // ═══ nunca ════════════════════════════════════════════════════════════════
    await check('DB auth / key inválida / proxy mal configurado → nunca se sondea (ni en 2 h); la vista no promete nada', async () => {
      const A = await creditRun('CREDIT auth', [
        { type: 'audiobook_chapter', error: AUTH_ERRS[0][0], secAgo: 3600 },
        { type: 'content', error: AUTH_ERRS[2][0], secAgo: 3600 },
        { type: 'experience', error: AUTH_ERRS[3][0], secAgo: 3600 },
      ]);
      for (const s of [0, 600, 7200]) {
        const r = ofRun(await probe(s), A.runId);
        eq([r.probed.length, r.resumed.length, r.waiting.length], [0, 0, 0], `+${s}s`);
      }
      const dto = await runs.getRun(A.cid, OWNER, 1, A.runId);
      for (const f of A.fails) assert(dto.items.find((x) => x.itemKey === f.key).recovery.currentRecovery !== 'provider_probe', `vista ${f.key}`);
    });

    await check('DB video / Gamma / YouTube / trozos de TTS ya pagados → nunca se sondean', async () => {
      const V = await creditRun('CREDIT never', [
        { type: 'presentation', error: NEVER_ERRS[0][0], secAgo: 3600 },
        { type: 'video', error: NEVER_ERRS[1][0], secAgo: 3600 },
        { type: 'audiobook_chapter', error: NEVER_ERRS[3][0], secAgo: 3600 },
      ]);
      for (const s of [0, 7200]) {
        const r = ofRun(await probe(s), V.runId);
        eq([r.probed.length, r.resumed.length, r.waiting.length], [0, 0, 0], `+${s}s`);
      }
      for (const f of V.fails) eq((await itemRow(V.runId, f.key)).status, 'failed', f.key);
    });

    await check('DB un canario por PROVEEDOR: Anthropic y OpenAI en el mismo run → uno de cada uno, nunca dos del mismo', async () => {
      const M = await creditRun('CREDIT two providers', [
        { type: 'audiobook_chapter', idx: 0, error: ANTH_SCRIPT, secAgo: 3600 },
        { type: 'experience', error: ANTH_BROWSER, secAgo: 3600 },
        { type: 'audiobook_chapter', idx: 1, error: OPENAI_TTS, secAgo: 3600 },
        { type: 'audio_welcome', error: 'tts_failed: chunk 1/2: openai HTTP 429: insufficient_quota', secAgo: 3600 },
      ]);
      const r = ofRun(await probe(0), M.runId);
      eq(r.probed.map((x) => x.provider).sort(), ['anthropic', 'openai'], 'uno por proveedor');
      eq(ofRun(await probe(60), M.runId).probed.length, 0, 'ninguno más');
    });

    await check('DB kill-switch: DYNAMIC_AUTO_HEAL_POLICY=legacy → sin sondas (barrido y lock) y la vista como hoy', async () => {
      const L = await creditRun('CREDIT legacy', [{ type: 'audiobook_chapter', error: ANTH_SCRIPT, secAgo: 3600 }]);
      const legacy = AH.autoHealPolicyFromEnv({ DYNAMIC_AUTO_HEAL_POLICY: 'legacy' });
      const res = await probe(0, legacy);
      eq([res.enabled, ofRun(res, L.runId).probed.length], [false, 0], 'barrido apagado');
      let err = null;
      try {
        await runs.retryItem(L.cid, OWNER, 1, L.runId, L.fails[0].key, false, false, { policy: legacy, providerProbe: { mode: 'canary', provider: 'anthropic' } });
      } catch (e) { err = e; }
      assert(err && /auto_heal_not_eligible/.test(err.message), 'retryItem bajo lock rechaza con legacy: ' + (err && err.message));
      process.env.DYNAMIC_AUTO_HEAL_POLICY = 'legacy';
      try {
        const dto = await runs.getRun(L.cid, OWNER, 1, L.runId);
        assert(dto.items.find((x) => x.itemKey === L.fails[0].key).recovery.currentRecovery !== 'provider_probe', 'vista como hoy');
      } finally {
        delete process.env.DYNAMIC_AUTO_HEAL_POLICY;
      }
      eq((await itemRow(L.runId, L.fails[0].key)).status, 'failed', 'sigue failed');
    });

    await check('DB run cancelado → nunca; detenido por el usuario → nunca', async () => {
      const C1 = await creditRun('CREDIT cancelado', [{ type: 'audiobook_chapter', error: ANTH_SCRIPT, secAgo: 3600 }]);
      await ds.query(`update public.production_jobs set status = 'running', worker_status = 'running', finished_at = null where id = $1`, [C1.runId]);
      await runs.cancelRun(C1.cid, OWNER, 1, C1.runId);
      eq(ofRun(await probe(0), C1.runId).probed.length, 0, 'cancelado');
      const U = await creditRun('CREDIT pausado', [
        { type: 'audiobook_chapter', error: ANTH_SCRIPT, secAgo: 3600 },
        { type: 'content', error: 'Generación detenida por el usuario', secAgo: 3500 },
      ]);
      const r = ofRun(await probe(0), U.runId);
      eq([r.probed.length, r.waiting.map((w) => w.action)], [0, ['paused']], 'pausado por el usuario');
    });

    await check('DB > 24 h desde el primer fallo → sin sonda, needs_attention como hoy (vista sin provider_probe, acción de admin)', async () => {
      const O = await creditRun('CREDIT 24h', [{ type: 'audiobook_chapter', error: ANTH_SCRIPT, secAgo: 25 * 3600 }]);
      eq(ofRun(await probe(0), O.runId).probed.length, 0, 'sin sonda');
      const dto = await runs.getRun(O.cid, OWNER, 1, O.runId);
      assert(dto.items.find((x) => x.itemKey === O.fails[0].key).recovery.currentRecovery !== 'provider_probe', 'vista');
      eq(dto.completion.state, 'needs_attention', 'needs_attention');
      eq((dto.completion.adminActions || []).filter((a) => a.itemKey === O.fails[0].key).map((a) => a.code), ['retry_item'], 'acción de admin');
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
