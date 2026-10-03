#!/usr/bin/env node
/* eslint-disable */
// REL MVP (2026-10-02) — recuperación automática por clase + reparación del empaque.
//
// Parte pura (siempre; --pure-only para CI):
//   - clase A: hasta 5 rondas, espera 30 s / 1 / 2 / 4 / 8 min con jitter ±20 % determinista, tope;
//   - clase B (IA del navegador): regenera solo el componente, hasta 2 rondas; un item de proveedor
//     pagado (Gamma/TTS/video) nunca; C/D/sin clasificar/detenido por el usuario nunca; la clase
//     registrada (errorCode) solo sube la severidad; kill-switch DYNAMIC_AUTO_HEAL_POLICY=legacy;
//   - packageBlockItemKey: el item nombrado en un rechazo del empaque (límite de clave).
// Parte DB (default; PG16 desechable, puerto libre ≠ 5570 / 8099; proveedores solo como variables
// de entorno falsas, nunca se llaman):
//   - A: espera → no; pasada → reabre (ronda 1), dependientes desbloqueados, intento `reopened` con la
//     estrategia en el log (R2); 5 rondas y tope → nunca más (marca «no elegible», fuera del SQL);
//   - B: regenera solo ese item (las otras partes intactas), 2 rondas y luego humano (retry_item);
//   - un item esperando su espera no frena a los demás (el run sigue activo y se reclama otra parte);
//   - run cancelado → nunca;
//   - empaque: rechazo del validador que nombra un item → ese item se regenera (generación nueva, una
//     vez, run reabierto); segunda vez → needs_attention con el código; transitorio → el reintento de
//     siempre; D sin item → needs_attention; un 409 del precheck que nombra un item → reparación.
//
// Usage: npm run build && node scripts/check-rel-mvp-recovery.js [--pure-only] [path/to/dist]

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
const { Logger, ConflictException } = require('@nestjs/common');
const AH = loadDist('modules/dynamic-generation/auto-heal.js');
const APS = loadDist('modules/dynamic-packaging/auto-package.service.js');
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

const NOW = new Date('2026-10-02T12:00:00Z');
const ago = (sec) => new Date(NOW.getTime() - sec * 1000).toISOString();
const row = (error, o = {}) => ({ id: o.id || 'item-1', status: 'failed', type: o.type || 'content', error, output_summary: o.os || {}, finished_at: ago(o.secAgo ?? 3600), failure_class: o.cls ?? null });
const A_ERR = '❌ Falló después de 3 intentos: Error del servidor (503)';
const B_ERR = 'v3_payload_invalid: [H5P_DIALOG_CARDS_INVALID] la actividad no cumple el esquema';

// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  const P = AH.DEFAULT_AUTO_HEAL_POLICY;

  await check('puro: política por defecto = por clase (A 5 rondas 30s→8min ±20 %, B 2 rondas); kill-switch legacy = R16 tal cual', () => {
    eq([P.classAware, P.maxRounds, P.browserMaxRounds, [...P.backoffSeconds], P.regenMaxRounds, [...P.regenBackoffSeconds], P.jitterRatio],
      [true, 5, 5, [30, 60, 120, 240, 480], 2, [30, 120], 0.2], 'default');
    eq(AH.autoHealPolicyFromEnv({}).classAware, true, 'env vacío → por clase');
    const L = AH.autoHealPolicyFromEnv({ DYNAMIC_AUTO_HEAL_POLICY: 'legacy' });
    eq([L.classAware, L.maxRounds, L.browserMaxRounds, [...L.backoffSeconds]], [false, 3, 1, [120, 600, 1800]], 'legacy');
    eq(AH.autoHealDecision(row(B_ERR, { type: 'activity' }), NOW, L).reason, 'not_allow_listed', 'legacy: B no se toca');
  });

  await check('puro A: rondas 1..5 con espera exponencial y jitter ±20 % determinista; ronda 6 → tope', () => {
    const base = [30, 60, 120, 240, 480];
    for (let r = 0; r < 5; r++) {
      const os = r ? { autoHeal: { rounds: r } } : {};
      const w = AH.autoHealWaitSeconds(P.backoffSeconds, r, P.jitterRatio, 'item-1');
      assert(w >= base[r] * 0.8 - 1e-9 && w <= base[r] * 1.2 + 1e-9, `ronda ${r + 1}: espera ${w} fuera de ±20 % de ${base[r]}`);
      eq(AH.autoHealWaitSeconds(P.backoffSeconds, r, P.jitterRatio, 'item-1'), w, 'determinista');
      const before = AH.autoHealDecision(row(A_ERR, { os, secAgo: Math.floor(w) - 1 }), NOW, P);
      eq([before.heal, before.reason], [false, 'backoff'], `ronda ${r + 1} antes de la espera`);
      const after = AH.autoHealDecision(row(A_ERR, { os, secAgo: Math.ceil(w) + 1 }), NOW, P);
      eq([after.heal, after.round, after.kind, after.strategy], [true, r + 1, 'A', 'retry_backoff'], `ronda ${r + 1}`);
    }
    eq(AH.autoHealDecision(row(A_ERR, { os: { autoHeal: { rounds: 5 } } }), NOW, P).reason, 'cap_reached', 'tope 5');
    // El jitter cambia entre items (no todos reintentan a la vez).
    const ws = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((s) => AH.autoHealWaitSeconds(P.backoffSeconds, 0, P.jitterRatio, s).toFixed(3)));
    assert(ws.size > 1, 'jitter por item');
  });

  await check('puro A: timeouts / 502-504 / 524 / red / lease / subida / Cloudflare → A (navegador y worker); precondición de re-poll intacta', () => {
    const cases = [
      ['❌ Falló después de 3 intentos: Servidor ocupado (529)', 'content'], ['Falló después de 5 intentos: fetch failed', 'final_exam'],
      ['❌ Falló después de 3 intentos: Error del servidor (524)', 'activity'], ['❌ Falló después de 3 intentos: Error de red (502)', 'experience'],
      ['lease_expired', 'content'], ['worker_draining: x', 'presentation'], ['no se pudo subir el artifact dynamic_content_md: HTTP 500', 'content'],
      ['content_download_failed: HTTP 503', 'activity'], ['unexpected_error: Connection terminated', 'audiobook_chapter'],
      ['gamma_timeout: no terminó', 'presentation', { external: { gammaGenerationId: 'g1' } }],
    ];
    for (const [err, type, os] of cases) {
      const d = AH.autoHealDecision(row(err, { type, os }), NOW, P);
      eq([d.heal, d.kind], [true, 'A'], `${type}: ${err}`);
    }
    eq(AH.autoHealDecision(row('gamma_timeout: x', { type: 'presentation' }), NOW, P).reason, 'missing_precondition', 'sin generationId nunca un envío nuevo');
    eq(AH.autoHealDecision(row('video_timeout', { type: 'video' }), NOW, P).reason, 'missing_precondition', 'sin job');
  });

  await check('puro B: validación de un componente de la IA → regenerar solo ese item (≤ 2 rondas); proveedor pagado / dependencia → no', () => {
    for (const [err, type] of [[B_ERR, 'activity'], ['EXAM_BANK_COVERAGE: falta el capítulo 2', 'final_exam'],
      ['CONTENT_TRUNCATED_MAX_TOKENS: la respuesta se cortó', 'content'], ['v3_payload_invalid: [EXAM_BANK_SCHEMA] x', 'exam']]) {
      const d = AH.autoHealDecision(row(err, { type }), NOW, P);
      eq([d.heal, d.kind, d.round], [true, 'B', 1], `${type}: ${err}`);
    }
    const r2 = AH.autoHealDecision(row(B_ERR, { type: 'activity', os: { autoHeal: { regenRounds: 1, rounds: 4 } } }), NOW, P);
    eq([r2.heal, r2.kind, r2.round], [true, 'B', 2], 'ronda B 2 (las rondas A no cuentan)');
    eq(AH.autoHealDecision(row(B_ERR, { type: 'activity', os: { autoHeal: { regenRounds: 2 } } }), NOW, P).reason, 'cap_reached', 'tope B → humano');
    const w = AH.autoHealWaitSeconds(P.regenBackoffSeconds, 0, P.jitterRatio, 'item-1:B');
    eq(AH.autoHealDecision(row(B_ERR, { type: 'activity', secAgo: Math.floor(w) - 1 }), NOW, P).reason, 'backoff', 'espera B');
    eq(AH.autoHealDecision(row('PRESENTATION_CARD_SLIDE_COUNT: 9 ≠ 10', { type: 'presentation' }), NOW, P).reason, 'not_allow_listed', 'Gamma (pago) → humano');
    eq(AH.autoHealDecision(row('TTS_AUDIO_INVALID: x', { type: 'audiobook_chapter' }), NOW, P).reason, 'not_allow_listed', 'TTS → humano');
    eq(AH.autoHealDecision(row('context_package_invalid_json: x', { type: 'content' }), NOW, P).reason, 'not_allow_listed', 'regenerate_dependency → humano');
  });

  await check('puro C/D: pagos inciertos, presupuesto, cuota, contrato, sin clasificar, detenido por el usuario → nunca; la clase registrada solo sube', () => {
    for (const [err, type, reason] of [
      ['ambiguous_video_submission: timeout', 'video', 'denied'], ['provider_reconciliation_required: openai — x', 'audiobook_chapter', 'denied'],
      ['budget_exceeded: x', 'content', 'denied'], ['❌ Falló después de 3 intentos: insufficient_quota', 'content', 'denied'],
      ['missing_dependency_artifact: x', 'content', 'not_allow_listed'], ['kaboom sin código', 'content', 'not_allow_listed'],
      ['Generación detenida por el usuario', 'content', 'not_allow_listed'], ['videogen_failed: render', 'video', 'not_allow_listed'],
      ['videogen_submit_rejected: (HTTP 400)', 'video', 'not_allow_listed'], ['gamma_submit_failed: 400', 'presentation', 'not_allow_listed'],
    ]) {
      const d = AH.autoHealDecision(row(err, { type }), NOW, P);
      eq([d.heal, d.reason], [false, reason], err);
    }
    eq(AH.autoHealDecision(row(A_ERR, { cls: 'D' }), NOW, P).reason, 'not_allow_listed', 'registrada D (errorCode) gana');
    eq(AH.autoHealDecision(row(A_ERR, { cls: 'B', type: 'activity' }), NOW, P).kind, 'B', 'registrada B sube A → B');
    eq(AH.autoHealDecision(row(B_ERR, { cls: 'A', type: 'activity' }), NOW, P).kind, 'B', 'registrada A nunca baja B');
  });

  await check('puro fix M1: un A con riesgo de pago INCIERTO solo se reabre si su re-claim pasa por el ledger (lease_expired / worker_draining)', () => {
    eq([...AH.AUTO_HEAL_LEDGER_GUARDED_CODES], ['lease_expired', 'worker_draining'], 'allow-list');
    const FC = loadDist('modules/reliability/failure-classifier.js');
    const samples = ['lease_expired', 'worker_draining: x', 'unexpected_error: x', 'gamma_timeout: x', 'video_timeout', 'tts_failed: chunk 1/3: HTTP 503',
      'audiobook_script_failed: x', 'youtube_upload_failed: x', 'content_download_failed: x'];
    for (const type of ['video', 'presentation', 'audiobook_chapter', 'audio_welcome', 'content']) {
      for (const err of samples) {
        const os = { external: { gammaGenerationId: 'g', videogenJobId: 'v' } };
        const d = AH.autoHealDecision(row(err, { type, os }), NOW, P);
        const v = FC.classifyFailure({ error: err, itemType: type, outputSummary: os, source: type === 'video' ? 'video_worker' : ['presentation', 'audiobook_chapter', 'audio_welcome'].includes(type) ? 'provider_worker' : 'browser_executor' });
        if (d.heal && v.paidRisk === 'uncertain') assert(AH.AUTO_HEAL_LEDGER_GUARDED_CODES.includes(v.code), `${type}: ${err} (incierto) se reabriría`);
      }
    }
    eq(AH.autoHealDecision(row('lease_expired', { type: 'video' }), NOW, P).heal, true, 'lease_expired en video: sí (ledger al re-reclamar)');
  });

  await check('puro empaque: packageBlockItemKey encuentra el item nombrado (mensaje o missing), nunca un prefijo de otra clave', () => {
    const keys = ['exam:m1', 'exam:m10', 'activity:c1', 'content:c1', 'final_exam'];
    eq(APS.packageBlockItemKey('EXAM_BANK_INVALID: exam:m10 [EXAM_BANK_COVERAGE] x', [], keys), 'exam:m10', 'exam:m10');
    eq(APS.packageBlockItemKey('EXAM_BANK_INVALID: exam:m1 [X]', [], keys), 'exam:m1', 'exam:m1');
    eq(APS.packageBlockItemKey('H5P_ACTIVITY_PAYLOAD_INVALID: activity:c1: H5P_X', [], keys), 'activity:c1', 'h5p');
    eq(APS.packageBlockItemKey('no se puede empaquetar', ['final_exam: banco inválido'], keys), 'final_exam', 'missing');
    eq(APS.packageBlockItemKey('SHELL_RENDER: el shell no renderiza', [], keys), null, 'sin item');
    eq(APS.packageBlockItemKey('falla en content:c10', [], keys), null, 'content:c10 no es content:c1');
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
const CONTEXT = { nombre: 'Curso REL MVP', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY',
  'SUPER_ADMIN_EMAILS', 'DYNAMIC_AUTO_HEAL_POLICY'];

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-relmvp-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-relmvp-cwd-'));
  const ROLE = 'postgres.relmvplocal01';
  const DB = 'relmvpdb';
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
    const pkgCalls = [];
    let pkgImpl = null;
    const fakePackaging = {
      async requestPackage(courseId, ownerId, bp, runId, actor, opts) {
        pkgCalls.push({ runId, opts });
        if (pkgImpl) return pkgImpl(runId);
        return { created: true, jobId: crypto.randomUUID(), status: 'queued' };
      },
    };
    const autoPkg = new APS.AutoPackageService(ds, fakePackaging, runs);

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
        await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test', reason: 'check REL MVP' });
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT, videoMode: 'real' })).run.id;
      }
      return { cid, m1, c1, c2, runId };
    }
    const itemRow = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const setRow = (id, sets, params = []) => ds.query(`update public.generation_item_runs set ${sets} where id = $1`, [id, ...params]);
    const failAt = (id, error, secAgo, osSql = null) => setRow(id,
      `status = 'failed', error = $2, worker_id = null, lease_until = null, finished_at = now() - make_interval(secs => $3::int)${osSql ? `, output_summary = ${osSql}` : ''}`, [error, secAgo]);
    const heal = (secLater = 0) => runs.autoHealFailedItems({ now: new Date(Date.now() + secLater * 1000) });
    const attempts = (itemRunId) => ds.query(`select * from public.generation_item_attempts where item_run_id = $1 order by created_at, id`, [itemRunId]);
    const runRow = async (runId) => (await ds.query(`select * from public.production_jobs where id = $1`, [runId]))[0];
    const P = AH.DEFAULT_AUTO_HEAL_POLICY;

    const C = await makeCourse('REL MVP recuperación');
    const contentKey = `content:${C.c1}`;

    // ═══ A ════════════════════════════════════════════════════════════════════
    await check('DB A: dentro de la espera no; pasada (≥ 30 s ± 20 %) reabre ronda 1 con +2 intentos, dependientes desbloqueados, intento `reopened` con estrategia y recovery_round', async () => {
      const it = await itemRow(C.runId, contentKey);
      await setRow(it.id, `attempt_count = 3, max_attempts = 3`);
      await failAt(it.id, A_ERR, 5);
      // Los dependientes quedan bloqueados como al fallar de verdad.
      await ds.query(`update public.generation_item_runs set status = 'blocked' where job_id = $1 and $2 = any(depends_on) and status in ('pending', 'retrying')`, [C.runId, contentKey]);
      const blocked0 = await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and status = 'blocked' and $2 = any(depends_on)`, [C.runId, contentKey]);
      assert(blocked0.length > 0, 'hay dependientes bloqueados');
      let r = await heal(0);
      eq(r.reopened.map((x) => x.itemKey).includes(contentKey), false, 'en espera (5 s)');
      r = await heal(40);
      eq(r.reopened.filter((x) => x.itemKey === contentKey).map((x) => [x.kind, x.round, x.strategy]), [['A', 1, 'retry_backoff']], 'reabierto');
      const row1 = await itemRow(C.runId, contentKey);
      eq([row1.status, row1.max_attempts, row1.output_summary.autoHeal.rounds, row1.output_summary.autoHeal.regenRounds, row1.recovery_round],
        ['pending', 5, 1, 0, 1], 'fila');
      const still = await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and status = 'blocked' and $2 = any(depends_on)`, [C.runId, contentKey]);
      eq(still.length, 0, 'dependientes reabiertos con él');
      const last = (await attempts(it.id)).pop();
      eq([last.outcome, last.actor, last.strategy_applied, last.recovery_round], ['reopened', 'auto_heal', 'auto_heal_retry:retry_backoff', 1], 'log de intentos');
    });

    await check('DB A: rondas 2..5 cada una tras su espera (1, 2, 4, 8 min ± 20 %); la 6.ª no (tope) → marca «no elegible», fuera del SQL, y la acción humana aparece', async () => {
      const it = await itemRow(C.runId, contentKey);
      const waits = [60, 120, 240, 480];
      for (let i = 0; i < 4; i++) {
        await failAt(it.id, A_ERR, Math.floor(waits[i] * 0.8) - 2);
        eq((await heal(0)).reopened.map((x) => x.itemKey).includes(contentKey), false, `ronda ${i + 2}: antes de la espera mínima`);
        await failAt(it.id, A_ERR, Math.ceil(waits[i] * 1.2) + 2);
        eq((await heal(0)).reopened.filter((x) => x.itemKey === contentKey).map((x) => x.round), [i + 2], `ronda ${i + 2}`);
      }
      await failAt(it.id, A_ERR, 3600);
      let r = await heal(0);
      eq(r.reopened.map((x) => x.itemKey).includes(contentKey), false, 'tope de 5');
      eq(r.skipped.filter((x) => x.itemKey === contentKey).length, 0, 'ni siquiera candidato (tope A en el SQL)');
      eq(AH.autoHealDecision({ ...(await itemRow(C.runId, contentKey)), finished_at: new Date(Date.now() - 3600e3) }, new Date(), P).reason, 'cap_reached', 'JS: tope');
      eq((await itemRow(C.runId, contentKey)).status, 'failed', 'queda failed');
      const run = await runs.getRun(C.cid, OWNER, 1, C.runId);
      assert((run.completion.adminActions || []).some((a) => a.itemKey === contentKey), 'acción humana visible: ' + JSON.stringify(run.completion.adminActions));
      eq((await attempts(it.id)).filter((a) => a.outcome === 'reopened' && a.actor === 'auto_heal').length, 5, '5 rondas en el log');
    });

    // ═══ B ════════════════════════════════════════════════════════════════════
    const actKey = `activity:${C.c2}`;
    await check('DB B: validación de un componente de la IA → se regenera SOLO ese item (las demás partes intactas), 2 rondas y después humano (retry_item)', async () => {
      const it = await itemRow(C.runId, actKey);
      assert(it, 'activity:c2 existe');
      await failAt(it.id, B_ERR, 600, `'{}'::jsonb`);
      const before = await ds.query(`select item_key, status, max_attempts, generation from public.generation_item_runs where job_id = $1 and item_key <> $2 order by item_key`, [C.runId, actKey]);
      let r = await heal(0);
      eq(r.reopened.filter((x) => x.itemKey === actKey).map((x) => [x.kind, x.round, x.strategy]), [['B', 1, 'regenerate_targeted']], 'ronda B 1');
      const after = await ds.query(`select item_key, status, max_attempts, generation from public.generation_item_runs where job_id = $1 and item_key <> $2 order by item_key`, [C.runId, actKey]);
      eq(after, before, 'solo ese componente');
      let row = await itemRow(C.runId, actKey);
      eq([row.status, row.output_summary.autoHeal.regenRounds, row.output_summary.autoHeal.rounds, row.output_summary.autoHeal.lastClass], ['pending', 1, 0, 'B'], 'fila');
      eq((await attempts(it.id)).pop().strategy_applied, 'auto_heal_regenerate:regenerate_targeted', 'estrategia B en el log');
      await failAt(it.id, B_ERR, 600);
      r = await heal(0);
      eq(r.reopened.filter((x) => x.itemKey === actKey).map((x) => x.round), [2], 'ronda B 2');
      await failAt(it.id, B_ERR, 600);
      r = await heal(0);
      eq(r.reopened.filter((x) => x.itemKey === actKey).length, 0, 'tope B');
      eq(r.skipped.filter((x) => x.itemKey === actKey).map((x) => x.reason), ['cap_reached'], 'motivo');
      row = await itemRow(C.runId, actKey);
      eq([row.status, row.output_summary.autoHeal.ineligibleReason], ['failed', 'cap_reached'], 'queda para un humano (D) con la marca «no elegible»');
      r = await heal(0);
      eq(r.skipped.filter((x) => x.itemKey === actKey).length, 0, 'ya no es candidato (marca md5 del error en el SQL)');
      // Un error DISTINTO vuelve a evaluarse (la marca es por texto de error).
      await failAt(it.id, B_ERR + ' (otro)', 600);
      eq((await heal(0)).skipped.filter((x) => x.itemKey === actKey).map((x) => x.reason), ['cap_reached'], 'error nuevo → re-evaluado (sigue en el tope)');
      const run = await runs.getRun(C.cid, OWNER, 1, C.runId);
      eq((run.completion.adminActions || []).filter((a) => a.itemKey === actKey).map((a) => a.code), ['retry_item'], 'acción humana');
    });

    await check('DB B: un item de proveedor pagado (presentación) con un fallo de validación NO se regenera solo', async () => {
      const pres = await itemRow(C.runId, `presentation:${C.c1}`);
      await failAt(pres.id, 'PRESENTATION_CARD_SLIDE_COUNT: 9 ≠ 10', 600, `'{}'::jsonb`);
      const r = await heal(0);
      eq(r.reopened.filter((x) => x.itemKey === pres.item_key).length, 0, 'no');
      eq((await itemRow(C.runId, pres.item_key)).status, 'failed', 'failed');
    });

    await check('DB fix I2 (sonda del revisor): fallo A del navegador subido a D por el errorCode del ejecutor (llm_credit_exhausted) → el barrido no lo toma Y la vista muestra la acción humana al instante (nunca «auto-heal»)', async () => {
      const I = await makeCourse('REL MVP I2');
      const it = await itemRow(I.runId, `content:${I.c1}`);
      await setRow(it.id, `status = 'running', worker_id = 'exec-I2', attempt_count = 3, max_attempts = 3, lease_until = now() + interval '5 minutes'`);
      await sched.failItem(it.id, 'exec-I2', '❌ Falló después de 3 intentos: 502 Bad Gateway', false, OWNER, { errorCode: 'llm_credit_exhausted' });
      await setRow(it.id, `finished_at = now() - interval '10 minutes'`);
      const row = await itemRow(I.runId, it.item_key);
      eq([row.status, row.failure_class], ['failed', 'D'], 'D registrada por el errorCode');
      const r = await heal(0);
      eq(r.reopened.filter((x) => x.runId === I.runId).length, 0, 'no se reabre');
      const run = await runs.getRun(I.cid, OWNER, 1, I.runId);
      const acts = (run.completion.adminActions || []).filter((a) => a.itemKey === it.item_key).map((a) => a.code);
      assert(acts.length === 1 && acts[0] !== null, 'acción humana visible: ' + JSON.stringify(run.completion.adminActions));
      const view = run.items.find((x) => x.itemKey === it.item_key).recovery;
      eq([view.class, view.currentRecovery], ['D', 'manual'], 'la vista nunca dice auto-heal');
    });

    // ═══ los demás siguen ═════════════════════════════════════════════════════
    await check('DB: un item esperando su espera no frena a los demás — el run sigue activo y el ejecutor reclama otra parte', async () => {
      const D = await makeCourse('REL MVP independientes');
      const all = await ds.query(`select id, item_key, type, depends_on from public.generation_item_runs where job_id = $1`, [D.runId]);
      const failedKey = `content:${D.c1}`;
      const okKey = `content:${D.c2}`;
      // Todo completado salvo: content:c1 recién fallado (en espera) y content:c2 pendiente.
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and item_key not in ($2, $3)`, [D.runId, failedKey, okKey]);
      const f = all.find((x) => x.item_key === failedKey);
      await failAt(f.id, A_ERR, 1);
      await ds.query(`update public.generation_item_runs set status = 'pending' where job_id = $1 and item_key = $2`, [D.runId, okKey]);
      const r = await heal(0);
      eq(r.reopened.filter((x) => x.runId === D.runId).length, 0, 'el fallado espera');
      const claimed = await sched.claimNextItem({ runId: D.runId, executorId: 'exec-mvp', types: ['content', 'experience'], leaseSeconds: 120, ownerId: OWNER }).catch((e) => ({ err: e.message }));
      assert(claimed && !claimed.err, 'claim: ' + JSON.stringify(claimed));
      const claimedKey = claimed.itemKey || claimed.item_key || (claimed.item && claimed.item.itemKey);
      eq(claimedKey, okKey, 'se reclama la otra parte');
      const run = await runRow(D.runId);
      assert(['queued', 'running'].includes(run.worker_status), 'run activo: ' + run.worker_status);
      // Pasada la espera, el fallado vuelve sin tocar la parte en curso.
      const r2 = await heal(60);
      eq(r2.reopened.filter((x) => x.runId === D.runId).map((x) => x.itemKey), [failedKey], 'reabierto después');
      eq((await itemRow(D.runId, okKey)).status, 'running', 'la otra sigue en curso');
      // Fix round 1 (I3): el run expone la actividad del navegador (otro equipo no arranca un segundo ejecutor).
      const dto = await runs.getRun(D.cid, OWNER, 1, D.runId);
      assert(dto.lastBrowserActivityAt && Date.now() - Date.parse(dto.lastBrowserActivityAt) < 60000, 'lastBrowserActivityAt reciente: ' + dto.lastBrowserActivityAt);
    });

    await check('DB: run cancelado → nunca se reabre nada', async () => {
      const E = await makeCourse('REL MVP cancelado');
      const it = await itemRow(E.runId, `content:${E.c1}`);
      await failAt(it.id, A_ERR, 600);
      await runs.cancelRun(E.cid, OWNER, 1, E.runId);
      const r = await heal(0);
      eq(r.reopened.filter((x) => x.runId === E.runId).length, 0, 'cancelado');
    });

    // ═══ empaque ══════════════════════════════════════════════════════════════
    async function completedRun(title) {
      const G = await makeCourse(title);
      await ds.query(`update public.generation_item_runs set status = 'completed', error = null, finished_at = now() where job_id = $1`, [G.runId]);
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now(),
                        output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('autoPackage', jsonb_build_object('eligibleAt', (now() - interval '10 minutes')::text))
                      where id = $1`, [G.runId]);
      return G;
    }
    const failedPkgJob = async (G, error) => ds.query(
      `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, current_step, input_payload, output_summary, options, result, error_message, created_at, finished_at)
       values ($1, $2, 'dynamic_package', 'failed', 'failed', 'dynamic_package', $3::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, now() - interval '5 minutes', now() - interval '4 minutes')`,
      [OWNER, G.cid, JSON.stringify({ runId: G.runId, blueprintNumber: 1, packageKind: 'final' }), error]);
    const examKeyOf = (G) => `exam:${G.m1}`;

    await check('DB empaque: el validador rechaza el banco de UN examen (EXAM_BANK_INVALID: exam:…) → se regenera solo ese item (generación nueva, una vez) y el run se reabre; sin re-empaquetar todavía', async () => {
      const G = await completedRun('REL MVP empaque');
      const ek = examKeyOf(G);
      const ex1 = await itemRow(G.runId, ek);
      assert(ex1, 'exam existe');
      await failedPkgJob(G, `EXAM_BANK_INVALID: ${ek} [EXAM_BANK_COVERAGE] questions[3] EXAM_BANK_COVERAGE: falta el capítulo`);
      const n0 = pkgCalls.length;
      const out = await autoPkg.ensure(G.runId, 'sweep');
      eq([out.action, out.itemKey, out.code], ['repairing', ek, 'EXAM_BANK_INVALID'], 'reparando');
      eq(pkgCalls.length, n0, 'no re-empaqueta (el run no está completo)');
      const ex2 = await itemRow(G.runId, ek);
      eq([ex2.generation, ex2.status, ex2.output_summary.regeneration.reason, ex2.output_summary.regeneration.packageRepairCode],
        [Number(ex1.generation) + 1, 'pending', 'package_repair', 'EXAM_BANK_INVALID'], 'generación nueva');
      const others = await ds.query(`select count(*)::int n from public.generation_item_runs where job_id = $1 and generation > 1 and item_key <> $2`, [G.runId, ek]);
      eq(others[0].n, 0, 'solo ese componente');
      eq((await runRow(G.runId)).worker_status, 'queued', 'run reabierto');
      const last = (await attempts(ex2.id)).pop();
      eq([last.outcome, last.actor, last.strategy_applied], ['reopened', 'recovery', 'package_repair:regenerate_targeted'], 'log');
      G.ek = ek;
      globalThis.__G = G;
    });

    await check('DB empaque: el MISMO item vuelve a romper el paquete → no se repara otra vez: needs_attention con el código (nunca «Curso listo»)', async () => {
      const G = globalThis.__G;
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and item_key = $2 and status = 'pending'`, [G.runId, G.ek]);
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now(),
                        output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('autoPackage', jsonb_build_object('eligibleAt', (now() - interval '9 minutes')::text))
                      where id = $1`, [G.runId]);
      await failedPkgJob(G, `EXAM_BANK_INVALID: ${G.ek} [EXAM_BANK_COVERAGE] otra vez`);
      const out = await autoPkg.ensure(G.runId, 'sweep');
      eq([out.action, out.code], ['blocked', 'EXAM_BANK_INVALID'], 'bloqueado');
      eq((await ds.query(`select count(*)::int n from public.generation_item_runs where job_id = $1 and item_key = $2`, [G.runId, G.ek]))[0].n, 2, 'sin otra generación');
      const run = await runs.getRun(G.cid, OWNER, 1, G.runId);
      eq([run.completion.state, run.completion.complete], ['needs_attention', false], 'needs_attention');
      const ap = (await runRow(G.runId)).output_summary.autoPackage;
      eq(ap.blocked.code, 'EXAM_BANK_INVALID', 'código');
      eq((await autoPkg.sweep()).filter((o) => o.runId === G.runId).length, 0, 'el barrido no lo vuelve a tomar');
    });

    await check('DB empaque: fallo transitorio / de build sin item → el reintento acotado de siempre (re-empaqueta)', async () => {
      const G = await completedRun('REL MVP transitorio');
      await failedPkgJob(G, 'PACKAGING_V3_CONTENT_MISSING: el Storage no respondió (ETIMEDOUT)');
      const n0 = pkgCalls.length;
      const out = await autoPkg.ensure(G.runId, 'sweep');
      eq(out.action, 'enqueued', 'reintento');
      eq(pkgCalls.length, n0 + 1, 'requestPackage');
      eq(pkgCalls[pkgCalls.length - 1].opts, { auto: true }, 'automático');
    });

    // ═══ fix round 1 — I1: solo la allow-list de contenido + item; todo lo demás needs_attention ═══
    await check('DB fix I1: rechazos que NOMBRAN un item pero no son de su contenido → NINGÚN item reabierto: FILES_INTEGRITY / presupuesto → needs_attention con el código; DB caída / crash sin clasificar → el reintento acotado de siempre', async () => {
      const cases = [
        ['connect ECONNREFUSED 127.0.0.1:5432 while loading artifacts of %EXAM%', null],
        ['TypeError: Cannot read properties of undefined (reading x) at buildQuiz %EXAM%', null],
        ['FILES_INTEGRITY: sha mismatch for %EXAM%', 'FILES_INTEGRITY'],
        ['EXAM_BANK_INVALID: %EXAM% [X] presupuesto agotado durante la validación', 'EXAM_BANK_INVALID'],
      ];
      for (const [tpl, code] of cases) {
        const G = await completedRun('REL MVP I1 ' + code);
        const ek = examKeyOf(G);
        await failedPkgJob(G, tpl.replace('%EXAM%', ek));
        const n0 = pkgCalls.length;
        const out = await autoPkg.ensure(G.runId, 'sweep');
        if (code) {
          eq([out.action, out.code], ['blocked', code], tpl);
          eq(pkgCalls.length, n0, `${code}: sin re-empaquetar a ciegas`);
        } else {
          // Sin clasificar (DB caída / crash del builder): el reintento acotado de siempre (3 intentos → needs_attention).
          eq(out.action, 'enqueued', tpl);
          eq(pkgCalls.length, n0 + 1, 'reintento acotado');
        }
        eq((await ds.query(`select count(*)::int n from public.generation_item_runs where job_id = $1 and generation > 1`, [G.runId]))[0].n, 0, `${code}: ningún item regenerado`);
        eq((await runRow(G.runId)).worker_status, 'completed', `${code}: run no reabierto`);
        if (code) eq((await runs.getRun(G.cid, OWNER, 1, G.runId)).completion.state, 'needs_attention', `${code}: needs_attention`);
      }
    });

    await check('DB fix M2: la reparación falla por algo transitorio → se reintenta en el próximo barrido (2 veces), a la 3.ª needs_attention; nunca un bloqueo directo', async () => {
      const G = await completedRun('REL MVP M2');
      const ek = examKeyOf(G);
      await failedPkgJob(G, `EXAM_BANK_INVALID: ${ek} [EXAM_BANK_COVERAGE] x`);
      const orig = runs.autoRepairItemForPackage.bind(runs);
      let calls = 0;
      runs.autoRepairItemForPackage = async (...a) => { if (a[0] === G.runId) { calls++; throw new Error('canceling statement due to lock timeout'); } return orig(...a); };
      try {
        eq((await autoPkg.ensure(G.runId, 'sweep')).reason, 'repair_retry', 'intento 1');
        eq((await runRow(G.runId)).output_summary.autoPackage.blocked, undefined, 'sin bloqueo');
        eq((await autoPkg.ensure(G.runId, 'sweep')).reason, 'repair_retry', 'intento 2');
        const out = await autoPkg.ensure(G.runId, 'sweep');
        eq([out.action, out.code, calls], ['blocked', 'EXAM_BANK_INVALID', 3], 'tope → needs_attention');
      } finally {
        runs.autoRepairItemForPackage = orig;
      }
    });

    await check('DB fix M3: kill-switch legacy → sin reparación del empaque (reintento de siempre), RunDto.autoRecovery=false y el barrido R16 vuelve a ver filas marcadas «no elegible»', async () => {
      process.env.DYNAMIC_AUTO_HEAL_POLICY = 'legacy';
      try {
        const G = await completedRun('REL MVP legacy');
        await failedPkgJob(G, `EXAM_BANK_INVALID: ${examKeyOf(G)} [X] y`);
        eq((await autoPkg.ensure(G.runId, 'sweep')).action, 'enqueued', 'legacy: reintento, sin reparación');
        eq((await ds.query(`select count(*)::int n from public.generation_item_runs where job_id = $1 and generation > 1`, [G.runId]))[0].n, 0, 'sin regeneración');
        eq((await runs.getRun(G.cid, OWNER, 1, G.runId)).autoRecovery, false, 'el frontend no arranca solo');
        const H = await makeCourse('REL MVP legacy sweep');
        const it = await itemRow(H.runId, `content:${H.c1}`);
        await failAt(it.id, 'lease_expired', 600, `jsonb_build_object('autoHeal', jsonb_build_object('ineligibleMd5', md5('lease_expired')))`);
        const r = await runs.autoHealFailedItems({ now: new Date(), policy: AH.LEGACY_AUTO_HEAL_POLICY });
        eq(r.reopened.filter((x) => x.runId === H.runId).map((x) => x.itemKey), [it.item_key], 'la marca de la política por clase no tapa a R16');
      } finally {
        delete process.env.DYNAMIC_AUTO_HEAL_POLICY;
      }
      const G2 = await completedRun('REL MVP autoRecovery on');
      eq((await runs.getRun(G2.cid, OWNER, 1, G2.runId)).autoRecovery, true, 'por defecto true');
    });

    await check('DB empaque: D sin item (SHELL_RENDER) → needs_attention con el código, sin reintentos', async () => {
      const G = await completedRun('REL MVP shell');
      await failedPkgJob(G, 'SHELL_RENDER: el shell del curso no se pudo renderizar');
      const n0 = pkgCalls.length;
      const out = await autoPkg.ensure(G.runId, 'sweep');
      eq([out.action, out.code], ['blocked', 'SHELL_RENDER'], 'bloqueado');
      eq(pkgCalls.length, n0, 'sin re-empaquetar');
      eq((await runs.getRun(G.cid, OWNER, 1, G.runId)).completion.state, 'needs_attention', 'needs_attention');
    });

    await check('DB empaque: el precheck (409) nombra un item (H5P inválido en activity:…) → reparación de ese item', async () => {
      const G = await completedRun('REL MVP precheck');
      const ak = `activity:${G.c1}`;
      pkgImpl = (runId) => {
        if (runId !== G.runId) return { created: true, jobId: crypto.randomUUID(), status: 'queued' };
        throw new ConflictException({ message: `H5P_ACTIVITY_PAYLOAD_INVALID: ${ak}: H5P_DIALOG_CARDS_INVALID cards[0]: vacío`, missing: [] });
      };
      try {
        const out = await autoPkg.ensure(G.runId, 'transition');
        eq([out.action, out.itemKey, out.code], ['repairing', ak, 'H5P_ACTIVITY_PAYLOAD_INVALID'], 'reparando');
        eq((await itemRow(G.runId, ak)).output_summary.regeneration.reason, 'package_repair', 'generación nueva');
      } finally {
        pkgImpl = null;
      }
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
