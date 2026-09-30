#!/usr/bin/env node
/* eslint-disable */
// R16 (#2 + #16) — auto-healer de items `failed` por errores transitorios y
// leases vencidos que no consumen intentos.
//
// Parte pura (siempre; --pure-only para CI):
//   - allow-list explícita: cada código se emite de verdad en el código compilado;
//   - deny-list que gana siempre (ambiguos / reconciliación / presupuesto / cuota / config);
//   - precondiciones (id del proveedor persistido), tope de rondas, espera creciente;
//   - kill-switch y timer (apagado con el flag dinámico o DYNAMIC_AUTO_HEAL_ENABLED=false).
// Parte DB (default; PG16 desechable, puerto libre ≠ 5570): esquema real,
// RunsService/SchedulerService compilados sobre un run v3 real (proveedores
// solo como variables de entorno, nunca se llaman):
//   - lease vencido → retrying SIN consumir intento (attempt_count intacto,
//     max_attempts + 1) hasta LEASE_EXPIRY_FREE_GRANTS; después consume → failed;
//   - failItem(grantAttempt) en el último intento → retrying;
//   - healer: espera → no; pasada la espera → reabre (pending, +2 intentos,
//     previousErrors auto:true, autoHeal.rounds), desbloquea dependientes;
//     2ª ronda con espera mayor; tope de rondas → nunca más;
//   - nunca reabre ambiguos / reconciliación / budget_exceeded; precondición
//     faltante → no; presupuesto insuficiente → no (y sin registrar estimados);
//   - retryItem(auto) re-evalúa bajo lock (409 auto_heal_not_eligible).
//
// Usage: node scripts/check-dynamic-auto-heal.js [--pure-only] [path/to/dist]

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
const AH = loadDist('modules/dynamic-generation/auto-heal.js');
const IT = loadDist('modules/dynamic-generation/item-transitions.js');
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
async function rejectsRe(p, re, msg, status) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${msg}: no lanzó`);
  const text = err.message + ' ' + JSON.stringify(err.getResponse ? err.getResponse() : '');
  assert(re.test(text), `${msg}: mensaje inesperado "${text.slice(0, 600)}"`);
  if (status !== undefined) assert(err.getStatus && err.getStatus() === status, `${msg}: status ${err.getStatus && err.getStatus()} (esperado ${status})`);
  return err;
}

const NOW = new Date('2026-09-30T12:00:00Z');
const ago = (sec) => new Date(NOW.getTime() - sec * 1000).toISOString();
const failedRow = (error, os = {}, failedSecAgo = 3600) => ({ status: 'failed', error, output_summary: os, finished_at: ago(failedSecAgo) });

// ════════════════════════════════════════════════════════════════════════════
// Parte pura
// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  const P = AH.DEFAULT_AUTO_HEAL_POLICY;

  await check('puro: allow-list explícita — cada código (salvo los del navegador) lo emite de verdad el backend compilado', () => {
    const codes = AH.AUTO_HEAL_ALLOW_LIST.map((r) => r.code);
    eq(codes, ['lease_expired', 'worker_draining', 'unexpected_error', 'download_failed', 'gamma_timeout', 'gamma_poll_failed', 'gamma_export_missing',
      'video_timeout', 'video_duration_unmeasured', 'youtube_upload_failed', 'browser_llm_transient', 'artifact_upload_failed'], 'allow-list');
    const grepDist = (needle) => {
      const out = [];
      const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js') && fs.readFileSync(p, 'utf8').includes(needle)) out.push(p); } };
      walk(distRoot);
      return out;
    };
    for (const lit of ['lease_expired', 'worker_draining', 'unexpected_error:', 'content_download_failed:', 'dependency_download_failed:', 'gamma_timeout:',
      'gamma_poll_failed:', 'gamma_export_missing:', "'video_timeout'", 'video_duration_unmeasured', 'youtube_upload_failed:']) {
      assert(grepDist(lit).some((p) => !p.endsWith(`${path.sep}auto-heal.js`)), `nadie emite ${lit}`);
    }
    for (const r of AH.AUTO_HEAL_ALLOW_LIST) assert(typeof r.why === 'string' && r.why.length > 10, `${r.code}: falta el porqué`);
  });

  await check('puro: transitorios con su precondición → se reabren (ronda 1); errores del navegador (reintentos agotados de red, subida al Storage)', () => {
    const gamma = { external: { gammaGenerationId: 'gen_1' } };
    const vg = { external: { videogenJobId: 'vg_1' } };
    const cases = [
      ['lease_expired', {}], ['worker_draining: el worker se reinicia', {}], ['unexpected_error: Connection terminated', {}],
      ['content_download_failed: HTTP 503', {}], ['dependency_download_failed: dynamic_content_md de x (HTTP 502)', {}],
      ['dynamic_content_md_download_failed: timeout', {}], ['course_plan_download_failed: desconocido', {}],
      ['gamma_timeout: la generación gen_1 no terminó', gamma], ['gamma_poll_failed: gamma: GET 503', gamma], ['gamma_export_missing: sin exportUrl', gamma],
      ['gamma_pdf_download_failed: HTTP 500 (se reintenta sin reenviar)', gamma],
      ['video_timeout', vg], ['video_duration_unmeasured: el video video:c1 terminó sin duración', vg],
      ['youtube_upload_failed: YouTube respondió con un error temporal (HTTP 503)', { ...vg, delivery: 'upload_failed', youtubeUploadStartedAt: null }],
      ['❌ Falló después de 3 intentos: HTTP 529 overloaded', {}], ['Falló después de 5 intentos: fetch failed', {}],
      ['no se pudo subir el artifact dynamic_content_md: HTTP 500', {}],
    ];
    for (const [err, os] of cases) {
      const d = AH.autoHealDecision(failedRow(err, os), NOW, P);
      assert(d.heal === true && d.round === 1, `${err}: ${JSON.stringify({ heal: d.heal, reason: d.reason })}`);
    }
  });

  await check('puro: NUNCA se reabren pagos ambiguos / reconciliación / presupuesto / cuota / configuración (la deny-list gana aunque empiece con un código permitido)', () => {
    const denied = [
      'gamma_submit_ambiguous: el envío a Gamma quedó sin confirmar',
      'ambiguous_video_submission: Videogen timeout',
      'ambiguous_youtube_upload: la subida falló sin confirmar',
      'provider_reconciliation_required: openai — audio TTS pagado sin persistir',
      'budget_exceeded: no_authorization',
      'budget_approval_required: …',
      'youtube_upload_failed: YouTube siguió sin permitir subidas durante 24 h (cuota agotada)',
      'youtube_blocked_quota: …',
      'unexpected_error: provider_reconciliation_required: anthropic — …',
      'unexpected_error: algo ambiguous en el detalle',
      'provider_not_ready: falta GAMMA_API_KEY',
      'videogen_not_configured',
      'real_video_not_allowed: …',
      'youtube_preflight_failed:no_connection: …',
    ];
    for (const err of denied) {
      const d = AH.autoHealDecision(failedRow(err, { external: { gammaGenerationId: 'g', videogenJobId: 'v' } }), NOW, P);
      eq([d.heal, d.reason], [false, 'denied'], err);
    }
    // No transitorios (contenido, rechazos definitivos, render fallado): fuera de la allow-list.
    for (const err of ['videogen_failed: render', 'gamma_generation_failed: …', 'CONTENT_TRUTH: persisten 3 oraciones', 'v3_payload_invalid: …',
      'CONTENT_TRUNCATED_MAX_TOKENS: …', 'gamma_submit_failed: 400', 'tts_failed: chunk 1/2: 429', 'claim_payload_unavailable: VIDEO_DURATION_MISSING']) {
      eq(AH.autoHealDecision(failedRow(err), NOW, P).reason, 'not_allow_listed', err);
    }
  });

  await check('puro: precondición — un poll "gratis" sin el id del proveedor persistido NO se reabre (sería un envío nuevo)', () => {
    for (const err of ['gamma_timeout: x', 'gamma_poll_failed: x', 'video_timeout', 'video_duration_unmeasured: x', 'youtube_upload_failed: x']) {
      eq(AH.autoHealDecision(failedRow(err, {}), NOW, P).reason, 'missing_precondition', err);
    }
    const yt = { external: { videogenJobId: 'v' }, youtubeUploadStartedAt: '2026-09-30T00:00:00Z' };
    eq(AH.autoHealDecision(failedRow('youtube_upload_failed: x', yt), NOW, P).reason, 'missing_precondition', 'subida con marcador vigente');
  });

  await check('puro: tope de rondas y espera creciente (2 min / 10 min / 30 min desde el fallo); estado ≠ failed → nunca', () => {
    const r = (rounds, secAgo) => AH.autoHealDecision(failedRow('lease_expired', rounds ? { autoHeal: { rounds } } : {}, secAgo), NOW, P);
    eq([r(0, 60).heal, r(0, 60).reason], [false, 'backoff'], 'ronda 1 antes de 2 min');
    eq([r(0, 121).heal, r(0, 121).round], [true, 1], 'ronda 1 pasados 2 min');
    eq([r(1, 300).reason, r(1, 601).round], ['backoff', 2], 'ronda 2: 10 min');
    eq([r(2, 1000).reason, r(2, 1801).round], ['backoff', 3], 'ronda 3: 30 min');
    eq([r(3, 99999).heal, r(3, 99999).reason], [false, 'cap_reached'], 'tope');
    eq(AH.autoHealDecision({ status: 'blocked', error: 'budget_exceeded: x', output_summary: {} }, NOW, P).reason, 'not_failed', 'blocked');
    eq(AH.autoHealDecision({ status: 'retrying', error: 'lease_expired', output_summary: {} }, NOW, P).reason, 'not_failed', 'retrying');
    eq([P.maxRounds, P.attemptsPerRound, [...P.backoffSeconds]], [3, 2, [120, 600, 1800]], 'política por defecto');
  });

  await check('puro: kill-switch — apagado sin el flag dinámico o con DYNAMIC_AUTO_HEAL_ENABLED=false; timer sin solapamiento y null si está apagado', async () => {
    eq(AH.autoHealEnabled({}), false, 'sin flag dinámico');
    eq(AH.autoHealEnabled({ DYNAMIC_COURSE_STRUCTURE: 'true' }), true, 'default encendido');
    eq(AH.autoHealEnabled({ DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_AUTO_HEAL_ENABLED: 'false' }), false, 'kill-switch');
    eq(AH.autoHealIntervalMs({}), 60000, 'intervalo default');
    eq(AH.autoHealIntervalMs({ DYNAMIC_AUTO_HEAL_INTERVAL_MS: '1000' }), 60000, 'intervalo < 5 s → default');
    let calls = 0;
    eq(AH.startAutoHealTimer({ async autoHealFailedItems() { calls++; return { reopened: [], skipped: [] }; } }, capLogger, {}), null, 'apagado → null');
    const t = AH.startAutoHealTimer({ async autoHealFailedItems() { calls++; return { reopened: [], skipped: [] }; } }, capLogger, { DYNAMIC_COURSE_STRUCTURE: 'true' });
    assert(t, 'encendido → timer');
    clearInterval(t);
    eq(calls, 0, 'no barre al arrancar');
  });

  await check('puro: lease vencido gratis — tope LEASE_EXPIRY_FREE_GRANTS (evita un bucle infinito si el item mata a su ejecutor)', () => {
    eq([IT.LEASE_EXPIRY_FREE_GRANTS, IT.LEASE_EXPIRED_ERROR], [6, 'lease_expired'], 'constantes');
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
const CONTEXT = { nombre: 'Curso R16', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY'];

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
  const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
  const { Artifact } = loadDist('modules/artifacts/entities/artifact.entity.js');
  const F = loadDist('modules/finops/index.js');

  const pgBin = findPgBin();
  const port = await freePort();
  assert(port !== 5570, 'puerto 5570 prohibido');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r16-heal-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r16-heal-cwd-'));
  const ROLE = 'postgres.r16localtest01';
  const DB = 'r16db';
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
    // Esquema real de staging (mismo orden que check-v21-providers).
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

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    delete process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT;
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    process.env.VIDEOGEN_API_KEY = 'fake-videogen-key-never-used-no-network';

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
      let runId;
      try {
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      } catch (err) {
        const body = err.getResponse ? err.getResponse() : null;
        assert(body && body.code === 'budget_approval_required', `startRun: ${err.message}`);
        await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test', reason: 'check R16' });
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      }
      return { cid, c1, c2, runId };
    }
    const itemRow = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const setRow = (id, sets, params = []) => ds.query(`update public.generation_item_runs set ${sets} where id = $1`, [id, ...params]);
    const estimatesOf = async (cid) => (await ds.query(`select count(*)::int n from public.cost_estimates where course_id = $1`, [cid]))[0].n;
    const heal = (secLater) => runs.autoHealFailedItems({ now: new Date(Date.now() + secLater * 1000) });

    const C = await makeCourse('Curso auto-heal');
    const contentKey = `content:${C.c1}`;

    // ═══ #16 lease vencido ═══════════════════════════════════════════════════
    await check('DB #16 lease vencido → retrying SIN consumir intento: attempt_count intacto, max_attempts + 1, leaseExpiryGrants=1, error lease_expired', async () => {
      const it = await itemRow(C.runId, contentKey);
      await setRow(it.id, `status = 'running', worker_id = 'exec-A', attempt_count = 3, max_attempts = 3, lease_until = now() - interval '1 second'`);
      eq(await sched.sweepExpiredLeases(C.runId), 1, 'barrió uno');
      const row = await itemRow(C.runId, contentKey);
      eq([row.status, row.attempt_count, row.max_attempts, row.error, row.output_summary.leaseExpiryGrants], ['retrying', 3, 4, 'lease_expired', 1], 'gratis en el último intento');
    });

    await check('DB #16 agotados los LEASE_EXPIRY_FREE_GRANTS, el lease vencido vuelve a consumir → failed + dependientes blocked (nunca un bucle infinito)', async () => {
      const it = await itemRow(C.runId, contentKey);
      await setRow(it.id, `status = 'running', worker_id = 'exec-A', attempt_count = 4, max_attempts = 4, lease_until = now() - interval '1 second',
                           output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('leaseExpiryGrants', $2::int)`, [IT.LEASE_EXPIRY_FREE_GRANTS]);
      await sched.sweepExpiredLeases(C.runId);
      const row = await itemRow(C.runId, contentKey);
      eq([row.status, row.attempt_count, row.max_attempts, row.error], ['failed', 4, 4, 'lease_expired'], 'consume');
      const blocked = await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and status = 'blocked' and $2 = any(depends_on)`, [C.runId, contentKey]);
      assert(blocked.length > 0, 'dependientes directos blocked');
    });

    // ═══ #2 healer ═══════════════════════════════════════════════════════════
    await check('DB #2 healer: dentro de la espera (recién fallado) NO reabre; pasada la espera reabre: pending, +2 intentos, previousErrors auto:true, autoHeal.rounds=1, dependientes desbloqueados', async () => {
      let r = await heal(0);
      eq(r.reopened.length, 0, 'espera');
      eq((await itemRow(C.runId, contentKey)).status, 'failed', 'sigue failed');
      r = await heal(AH.DEFAULT_AUTO_HEAL_POLICY.backoffSeconds[0] + 5);
      eq(r.reopened.map((x) => [x.itemKey, x.code, x.round]), [[contentKey, 'lease_expired', 1]], 'reabierto');
      const row = await itemRow(C.runId, contentKey);
      eq([row.status, row.error, row.max_attempts, row.output_summary.autoHeal.rounds, row.output_summary.autoHeal.lastCode], ['pending', null, 4 + 2, 1, 'lease_expired'], 'fila');
      const last = row.output_summary.previousErrors[row.output_summary.previousErrors.length - 1];
      eq([last.error, last.auto, last.autoHealRound, last.autoHealCode, last.attemptCount], ['lease_expired', true, 1, 'lease_expired', 4], 'auditoría en previousErrors');
      const stillBlocked = await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and status = 'blocked' and $2 = any(depends_on)`, [C.runId, contentKey]);
      eq(stillBlocked.length, 0, 'dependientes directos desbloqueados');
      assert(LOGS.some((l) => /auto-heal: reabierto/.test(l) && l.includes(contentKey)), 'log de la reapertura');
    });

    await check('DB #2 healer: 2ª ronda solo pasada la espera mayor (10 min); con el tope de rondas nunca más', async () => {
      const it = await itemRow(C.runId, contentKey);
      await setRow(it.id, `status = 'failed', error = 'unexpected_error: Connection terminated', finished_at = now()`);
      eq((await heal(AH.DEFAULT_AUTO_HEAL_POLICY.backoffSeconds[0] + 5)).reopened.length, 0, 'la espera de la ronda 1 ya no alcanza');
      const r2 = await heal(AH.DEFAULT_AUTO_HEAL_POLICY.backoffSeconds[1] + 5);
      eq(r2.reopened.map((x) => [x.code, x.round]), [['unexpected_error', 2]], 'ronda 2');
      await setRow(it.id, `status = 'failed', error = 'lease_expired', finished_at = now() - interval '10 hours',
                           output_summary = output_summary || jsonb_build_object('autoHeal', jsonb_build_object('rounds', $2::int))`, [AH.DEFAULT_AUTO_HEAL_POLICY.maxRounds]);
      eq((await heal(0)).reopened.length, 0, 'tope de rondas');
      eq((await itemRow(C.runId, contentKey)).status, 'failed', 'queda para un humano');
      await rejectsRe(runs.retryItem(C.cid, OWNER, 1, C.runId, contentKey, false, false, { policy: AH.DEFAULT_AUTO_HEAL_POLICY }), /auto_heal_not_eligible/, 'bajo lock', 409);
    });

    await check('DB #2 healer: NUNCA reabre pagos ambiguos, reconciliación ni bloqueos de presupuesto', async () => {
      const pres = await itemRow(C.runId, `presentation:${C.c1}`);
      const vid = await itemRow(C.runId, `video:${C.c1}`);
      const audio = await itemRow(C.runId, `audiobook_chapter:${C.c1}`);
      const exam = await ds.query(`select id, item_key from public.generation_item_runs where job_id = $1 and type = 'module_intro' limit 1`, [C.runId]);
      await setRow(pres.id, `status = 'failed', error = 'gamma_submit_ambiguous: el envío a Gamma quedó sin confirmar', finished_at = now() - interval '5 hours',
                             output_summary = jsonb_build_object('externalSubmitStartedAt', '2026-09-30T00:00:00Z')`);
      await setRow(vid.id, `status = 'failed', error = 'ambiguous_video_submission: timeout', finished_at = now() - interval '5 hours'`);
      await setRow(audio.id, `status = 'failed', error = 'provider_reconciliation_required: openai — audio TTS pagado sin persistir', finished_at = now() - interval '5 hours'`);
      if (exam[0]) await setRow(exam[0].id, `status = 'blocked', error = 'budget_exceeded: no_authorization', finished_at = null, updated_at = now() - interval '5 hours'`);
      const r = await heal(3600);
      eq(r.reopened.length, 0, `nada reabierto: ${JSON.stringify(r.reopened)}`);
      for (const [row, st] of [[pres, 'failed'], [vid, 'failed'], [audio, 'failed']]) eq((await itemRow(C.runId, row.item_key)).status, st, row.item_key);
      if (exam[0]) eq((await itemRow(C.runId, exam[0].item_key)).status, 'blocked', 'budget_exceeded intacto');
      const reasons = Object.fromEntries(r.skipped.map((s) => [s.itemKey, s.reason]));
      eq([reasons[pres.item_key], reasons[vid.item_key], reasons[audio.item_key]], ['denied', 'denied', 'denied'], 'motivo');
    });

    await check('DB #2 healer: gamma_timeout sin el generationId persistido → no (sería un envío nuevo); con el id → reabre sin registrar estimados', async () => {
      const pres = await itemRow(C.runId, `presentation:${C.c1}`);
      const est0 = await estimatesOf(C.cid);
      await setRow(pres.id, `status = 'failed', error = 'gamma_timeout: no terminó', finished_at = now() - interval '5 hours', output_summary = '{}'::jsonb`);
      let r = await heal(0);
      eq(r.reopened.length, 0, 'sin id');
      eq(r.skipped.find((s) => s.itemKey === pres.item_key).reason, 'missing_precondition', 'motivo');
      await setRow(pres.id, `output_summary = jsonb_build_object('external', jsonb_build_object('gammaGenerationId', 'gen_r16_1'))`);
      r = await heal(0);
      eq(r.reopened.map((x) => x.itemKey), [pres.item_key], 'reabierto con el id');
      eq((await itemRow(C.runId, pres.item_key)).status, 'pending', 'pending');
      eq(await estimatesOf(C.cid), est0, 'sin estimados nuevos');
    });

    await check('DB #2 healer: presupuesto insuficiente (autorización revocada) → no reabre un item pagado, 0 estimados registrados, queda failed', async () => {
      const pres = await itemRow(C.runId, `presentation:${C.c1}`);
      await setRow(pres.id, `status = 'failed', error = 'unexpected_error: DB caída antes del envío', finished_at = now() - interval '5 hours', output_summary = '{}'::jsonb`);
      const [est] = await ds.query(`select id from public.cost_estimates where run_id = $1 and scope = 'run'`, [C.runId]);
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, estimate_id, authorized_budget, decision, reason) values ($1, $2, $3, 0, 'BLOCKED', 'check R16: revocado')`, [C.runId, C.cid, est.id]);
      const est0 = await estimatesOf(C.cid);
      const r = await heal(0);
      eq(r.reopened.length, 0, 'no reabre');
      eq(r.skipped.find((s) => s.itemKey === pres.item_key).reason, 'budget_approval_required', 'motivo');
      eq([(await itemRow(C.runId, pres.item_key)).status, await estimatesOf(C.cid)], ['failed', est0], 'failed y sin estimados');
      const n = LOGS.filter((l) => /no se reabre automáticamente/.test(l) && l.includes(pres.item_key)).length;
      await heal(0);
      eq(LOGS.filter((l) => /no se reabre automáticamente/.test(l) && l.includes(pres.item_key)).length, n, 'el mismo motivo no se loguea en cada barrido');
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, estimate_id, authorized_budget, decision, approved_by, reason) values ($1, $2, $3, 500, 'ADMIN_APPROVED', 'admin@cursia.test', 'check R16: reautorizado')`, [C.runId, C.cid, est.id]);
    });

    await check('DB #1/#16 failItem(grantAttempt) en el último intento → retrying (attempt_count intacto, max_attempts + 1); sin grant → failed', async () => {
      const it = await itemRow(C.runId, `content:${C.c2}`);
      await setRow(it.id, `status = 'running', worker_id = 'exec-G', attempt_count = 3, max_attempts = 3, lease_until = now() + interval '5 minutes'`);
      eq(await sched.failItem(it.id, 'exec-G', 'worker_draining: devuelto', true, undefined, { grantAttempt: true, retryAfterSeconds: 5 }), true, 'ok');
      let row = await itemRow(C.runId, it.item_key);
      eq([row.status, row.attempt_count, row.max_attempts], ['retrying', 3, 4], 'gratis');
      assert(new Date(row.next_retry_at).getTime() - Date.now() < 30_000, 'retryAfterSeconds respetado');
      await setRow(it.id, `status = 'running', worker_id = 'exec-G', attempt_count = 4, lease_until = now() + interval '5 minutes'`);
      await sched.failItem(it.id, 'exec-G', 'unexpected_error: x', true);
      row = await itemRow(C.runId, it.item_key);
      eq([row.status, row.attempt_count, row.max_attempts], ['failed', 4, 4], 'consume');
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
