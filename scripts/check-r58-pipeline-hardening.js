#!/usr/bin/env node
/* eslint-disable */
// r58 (AU1 R1/R2/R3) — endurecimiento del pipeline (USD 0, sin red, sin proveedores).
//
// Parte pura (siempre; --pure-only para CI):
//   [R1] política de tipos del servidor (dynamic_mbz y demás tipos que solo crean los workers) y verificación del
//        reuse del .mbz: ruta canónica, checksum, validatedSha256 (v3) y bytes actuales en Storage;
//   [R2] procedencia del texto de IA: combineLlmModes (la peor gana; desconocido → rechazo), classifyRunItems
//        (llmMode mock/replay → `preview`, nunca un final), nonRealLlmItemKeys del worker de empaque;
//   [R3] guarda de URLs base de proveedores: producción (ref Supabase de producción) + override no oficial → no
//        arranca (provider PROVIDER_BASE_URL_GUARD de AppModule), salvo ALLOW_…=true; fuera de producción → igual que
//        antes; el log no filtra credenciales / ruta / query.
// Parte DB (default; PG16 desechable, puerto libre ≠ 5570 / 8099; proveedores solo como variables falsas):
//   [R2] SchedulerService.completeItemDetailed REAL: el servidor escribe output_summary.llmMode con la metadata de
//        los artifacts + lo declarado (solo degrada); un llmMode desconocido → `llm_mode_invalid` sin completar;
//        un item real queda sin la clave (output_summary de siempre); evaluateRunCompletion → componente de vista previa.
//
// Usage: npm run build && node scripts/check-r58-pipeline-hardening.js [--pure-only] [path/to/dist]

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

// Sin red: cualquier fetch fuera de 127.0.0.1 es un fallo del check.
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  const s = String(u);
  if (/^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o);
  throw new Error(`NETWORK FORBIDDEN in check: ${s}`);
};

require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const { applyFakeProviderEnv } = require('./lib/provider-test-env');
Logger.overrideLogger({ log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {} });

const POL = loadDist('modules/artifacts/artifact-type-policy.js');
const RV = loadDist('modules/dynamic-packaging/package-reuse-verify.js');
const RC = loadDist('modules/dynamic-generation/run-completion.js');
const W = loadDist('workers/dynamic-package-worker.js');
const G = loadDist('config/provider-base-url-guard.js');

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
const PROD_REF = loadDist('modules/dynamic-generation/dynamic-video-delivery.js').PRODUCTION_SUPABASE_REF;

// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  console.log('\n=== R1: tipos del servidor + reuse verificado ===');
  await check('R1 política: tipos solo del servidor (dynamic_mbz, Gamma, TTS, segmentos, video, coherencia); los del ejecutor y legacy no', () => {
    eq([...POL.SERVER_ONLY_ARTIFACT_TYPES].sort(), ['dynamic_audio_mp3', 'dynamic_audio_segment', 'dynamic_coherence_report_json', 'dynamic_mbz', 'dynamic_mbz_part', 'dynamic_media_audio', 'dynamic_presentation', 'dynamic_video'], 'lista (r74: partes del paquete y audio en línea)');
    for (const t of ['dynamic_content_md', 'dynamic_exam_bank_json', 'dynamic_scorm_html', 'dynamic_video_interactions_json', 'mbz_final', 'content_snapshot', '', null, 3]) {
      eq(POL.isServerOnlyArtifactType(t), false, String(t));
    }
    eq(POL.isServerOnlyArtifactType(' dynamic_mbz '), true, 'con espacios');
  });

  await check('R1 los tipos del servidor no aparecen como subidas del ejecutor del navegador (frontend, si está al lado)', () => {
    const fe = path.resolve(REPO, '..', 'fe', 'src', 'js', '45-dynamic-generation-executor.js');
    if (!fs.existsSync(fe)) { console.log('   (frontend no disponible: se omite)'); return; }
    const src = fs.readFileSync(fe, 'utf8');
    const uploaded = [...new Set([...src.matchAll(/type:\s*'(dynamic_[a-z0-9_]+)'/g)].map((m) => m[1]))];
    assert(uploaded.length > 3, 'tipos del ejecutor encontrados: ' + uploaded.join(','));
    eq(uploaded.filter((t) => POL.isServerOnlyArtifactType(t)), [], 'ninguno es solo del servidor');
  });

  const BYTES = Buffer.from('mbz validado por el servidor');
  const SHA = crypto.createHash('sha256').update(BYTES).digest('hex');
  const EXP = { ownerId: 'o1', courseId: 'fc', manifestId: 7, runId: 'r1', sourceIdsHash: 'h1', qa: false };
  const PATH = 'o1/dynamic/fc/7/dynamic_mbz/r1/h1.mbz';
  const dl = (map) => ({ async downloadStorageObject(b, p) { const x = map[`${b}/${p}`]; if (!x) throw new Error('404'); return x; } });
  const good = { id: 'a', storageBucket: 'cursia-artifacts', storagePath: PATH, checksumSha256: SHA, metadata: { validatedSha256: SHA } };

  await check('R1 ruta canónica = la que escribe el worker (final y QA)', () => {
    eq(RV.canonicalDynamicMbzPath(EXP), PATH, 'final');
    eq(RV.canonicalDynamicMbzPath({ ...EXP, qa: true }), 'qa-internal/o1/dynamic/fc/7/dynamic_mbz/r1/QA-VISTA-PREVIA-h1.mbz', 'QA');
  });

  await check('R1 verifyReusableDynamicMbz: el del servidor → ok; cada forma de forjado → motivo explícito', async () => {
    const st = { [`cursia-artifacts/${PATH}`]: BYTES };
    eq(await RV.verifyReusableDynamicMbz(dl(st), good, EXP, { requireValidated: true }), { ok: true }, 'verificado');
    const cases = [
      [{ ...good, storageBucket: 'x' }, st, true, 'wrong_bucket'],
      [{ ...good, storagePath: 'o1/fc/mbz_final/x.mbz' }, st, true, 'non_canonical_path'],
      [{ ...good, storagePath: `${PATH}x` }, st, true, 'non_canonical_path'],
      [{ ...good, checksumSha256: null }, st, true, 'missing_checksum'],
      [{ ...good, checksumSha256: 'abc' }, st, true, 'missing_checksum'],
      [{ ...good, metadata: {} }, st, true, 'not_validated'],
      [{ ...good, metadata: { validatedSha256: 'b'.repeat(64) } }, st, true, 'not_validated'],
      [good, {}, true, 'download_failed'],
      [good, { [`cursia-artifacts/${PATH}`]: Buffer.from('FORGED') }, true, 'checksum_mismatch'],
    ];
    for (const [row, s, req, reason] of cases) eq(await RV.verifyReusableDynamicMbz(dl(s), row, EXP, { requireValidated: req }), { ok: false, reason }, reason);
    // v1/v2 (sin validador v3): no exige validatedSha256, sí ruta + checksum + bytes.
    eq(await RV.verifyReusableDynamicMbz(dl(st), { ...good, metadata: {} }, EXP, { requireValidated: false }), { ok: true }, 'v1 sin validatedSha256');
    eq(await RV.verifyReusableDynamicMbz({}, good, EXP, { requireValidated: false }), { ok: false, reason: 'download_failed' }, 'sin descargador');
  });

  console.log('\n=== R2: procedencia del texto de IA ===');
  await check('R2 combineLlmModes: la peor gana (mock > replay > real); ausente = real; desconocido → rechazo', () => {
    eq(POL.combineLlmModes([]), { ok: true, mode: 'real' }, 'vacío');
    eq(POL.combineLlmModes([undefined, null, 'real']), { ok: true, mode: 'real' }, 'real');
    eq(POL.combineLlmModes(['real', 'replay']), { ok: true, mode: 'replay' }, 'replay');
    eq(POL.combineLlmModes(['replay', 'mock', 'real']), { ok: true, mode: 'mock' }, 'mock gana');
    eq(POL.combineLlmModes(['mock', 'replay']), { ok: true, mode: 'mock' }, 'mock sobre replay');
    eq(POL.combineLlmModes(['real', 'MOCK']).ok, false, 'mayúsculas');
    eq(POL.combineLlmModes(['', 'real']).ok, false, 'vacío string');
    eq(POL.combineLlmModes([true]).ok, false, 'booleano');
    eq([POL.isNonRealLlmMode('mock'), POL.isNonRealLlmMode('replay'), POL.isNonRealLlmMode('real'), POL.isNonRealLlmMode(undefined)], [true, true, false, false], 'isNonReal');
  });

  await check('R2 classifyRunItems: un item completado con llmMode mock/replay → preview (nunca done); sin la clave → como antes', () => {
    const manifest = { rulesVersion: 2, items: [{ key: 'content:a', type: 'content' }, { key: 'content:b', type: 'content' }, { key: 'content:c', type: 'content' }, { key: 'exam:m', type: 'exam' }] };
    const row = (key, os) => [key, { item_key: key, status: 'completed', output_summary: os, finished_at: new Date().toISOString() }];
    const rows = new Map([row('content:a', { llmMode: 'mock' }), row('content:b', { llmMode: 'replay' }), row('content:c', {}), row('exam:m', { llmMode: 'real' })]);
    const job = { input_payload: {}, worker_status: 'completed', status: 'completed' };
    const cls = RC.classifyRunItems(job, rows, manifest);
    eq([...cls.entries()], [['content:a', 'preview'], ['content:b', 'preview'], ['content:c', 'done'], ['exam:m', 'done']], 'clases');
    const c = RC.evaluateRunCompletion(job, [...rows.values()], manifest, null, {});
    eq([c.generationComplete, c.previewComponents], [false, ['content:a', 'content:b']], 'completion');
    const real = new Map([row('content:a', {}), row('content:b', {}), row('content:c', {}), row('exam:m', {})]);
    eq(RC.evaluateRunCompletion(job, [...real.values()], manifest, null, {}).generationComplete, true, 'todo real → completo (regresión)');
  });

  await check('R2 worker de empaque: nonRealLlmItemKeys (output_summary del servidor o metadata del artifact)', () => {
    const by = new Map([
      ['a', { itemKey: 'a', outputSummary: { llmMode: 'replay' }, artifacts: [{ metadata: {} }] }],
      ['b', { itemKey: 'b', outputSummary: {}, artifacts: [{ metadata: {} }, { metadata: { llmMode: 'mock' } }] }],
      ['c', { itemKey: 'c', outputSummary: {}, artifacts: [{ metadata: { llmMode: 'real' } }] }],
      ['d', { itemKey: 'd', outputSummary: null, artifacts: [{ metadata: null }] }],
    ]);
    eq(W.nonRealLlmItemKeys(by), ['a', 'b'], 'claves');
  });

  console.log('\n=== R3: URLs base de proveedores en producción ===');
  const PROD = { SUPABASE_URL: `https://${PROD_REF}.supabase.co` };
  const quiet = () => { const calls = { error: [], warn: [] }; return { calls, error: (m) => calls.error.push(String(m)), warn: (m) => calls.warn.push(String(m)) }; };
  await check('R3 fuera de producción: overrides a 127.0.0.1 (e2e) → sin cambios, sin logs', () => {
    const log = quiet();
    const env = { NODE_ENV: 'production', SUPABASE_URL: 'https://stagingref.supabase.co', ANTHROPIC_API_BASE_URL: 'http://127.0.0.1:9999', GAMMA_API_BASE_URL: 'http://127.0.0.1:1', OPENAI_API_BASE_URL: 'http://localhost:2/v1', VIDEOGEN_API_URL: 'https://127.0.0.1:3' };
    assert(G.assertProviderBaseUrlsSafe(env, log) === env, 'devuelve el env');
    eq([log.calls.error.length, log.calls.warn.length], [0, 0], 'sin logs');
  });
  await check('R3 producción: sin overrides o con los hosts oficiales → arranca', () => {
    const log = quiet();
    G.assertProviderBaseUrlsSafe({ ...PROD }, log);
    G.assertProviderBaseUrlsSafe({ ...PROD, ANTHROPIC_API_BASE_URL: 'https://api.anthropic.com', OPENAI_API_BASE_URL: 'https://api.openai.com/v1/', GAMMA_API_BASE_URL: 'https://public-api.gamma.app/v1.0', VIDEOGEN_API_URL: 'https://videosb.nomaddi.com' }, log);
    G.assertProviderBaseUrlsSafe({ DB_HOST: `db.${PROD_REF}.supabase.co`, ANTHROPIC_API_BASE_URL: '  ' }, log);
    eq([log.calls.error.length, log.calls.warn.length], [0, 0], 'sin logs');
  });
  await check('R3 producción + override no oficial / http / credenciales / puerto → NO arranca (PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION), log redactado', () => {
    for (const [k, v, why] of [
      ['ANTHROPIC_API_BASE_URL', 'http://127.0.0.1:8787/v1?key=SECRET', 'not_https'],
      ['ANTHROPIC_API_BASE_URL', 'https://api.anthropic.com.evil.test/v1', 'non_official_host'],
      ['OPENAI_API_BASE_URL', 'https://user:SECRET@api.openai.com/v1', 'non_official_host'],
      ['GAMMA_API_BASE_URL', 'https://public-api.gamma.app:8443/v1.0', 'non_official_host'],
      ['VIDEOGEN_API_URL', 'https://videogen.fake.local/path/SECRET', 'non_official_host'],
      ['GAMMA_API_BASE_URL', 'nota-una-url', 'unparseable'],
    ]) {
      const log = quiet();
      let err = null;
      try { G.assertProviderBaseUrlsSafe({ ...PROD, [k]: v }, log); } catch (e) { err = e; }
      assert(err && /^PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION:/.test(err.message), `${k}=${v}: lanza (${err && err.message})`);
      assert(err.message.includes(`${k}→`) && err.message.includes(`(${why})`), `motivo ${why}: ${err.message}`);
      assert(!/SECRET/.test(err.message) && !log.calls.error.some((m) => /SECRET/.test(m)), 'sin credenciales / ruta / query en el mensaje ni el log');
      eq(log.calls.error.length, 1, 'un error logueado');
    }
  });
  await check('R3 escape explícito ALLOW_PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION=true → arranca con aviso (redactado); otro valor no', () => {
    const log = quiet();
    G.assertProviderBaseUrlsSafe({ ...PROD, ALLOW_PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION: 'true', ANTHROPIC_API_BASE_URL: 'https://proxy.example.test/a?k=SECRET' }, log);
    assert(log.calls.warn.length === 1 && /proxy\.example\.test/.test(log.calls.warn[0]) && !/SECRET/.test(log.calls.warn[0]), 'aviso: ' + log.calls.warn[0]);
    let threw = false;
    try { G.assertProviderBaseUrlsSafe({ ...PROD, ALLOW_PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION: '1', ANTHROPIC_API_BASE_URL: 'https://proxy.example.test' }, quiet()); } catch { threw = true; }
    assert(threw, 'solo "true" habilita el escape');
  });
  await check('R3 AppModule cablea la guarda (API y todos los workers): su factory lanza con env de producción + override', () => {
    const saved = { ...process.env };
    const origErr = console.error;
    console.error = () => {};
    try {
      const { AppModule } = loadDist('app.module.js');
      const providers = Reflect.getMetadata('providers', AppModule) || [];
      const guard = providers.find((p) => p && p.provide === G.PROVIDER_BASE_URL_GUARD);
      assert(guard && typeof guard.useFactory === 'function', 'provider PROVIDER_BASE_URL_GUARD en AppModule');
      for (const k of Object.keys(G.PROVIDER_BASE_URL_OFFICIAL_HOSTS)) delete process.env[k];
      process.env.SUPABASE_URL = 'https://stagingref.supabase.co';
      process.env.ANTHROPIC_API_BASE_URL = 'http://127.0.0.1:1';
      eq(guard.useFactory(), true, 'staging + override → ok');
      process.env.SUPABASE_URL = PROD.SUPABASE_URL;
      let err = null;
      try { guard.useFactory(); } catch (e) { err = e; }
      assert(err && /PROVIDER_BASE_URL_OVERRIDE_IN_PRODUCTION/.test(err.message), 'producción + override → lanza');
    } finally {
      console.error = origErr;
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
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
const CONTEXT = { nombre: 'Curso r58 procedencia', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const ENV_KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_GENERAL_AVAILABILITY', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'VIDEOGEN_API_KEY',
  'SUPER_ADMIN_EMAILS', 'DYNAMIC_AUTO_HEAL_POLICY'];
const EXEC = 'browser-dev-R58AAAAA';

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
  const EL = loadDist('modules/reliability/execution-lease.js');
  const F = loadDist('modules/finops/index.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r58-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r58-cwd-'));
  const ROLE = 'postgres.r58local01';
  const DB = 'r58db';
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
      'scripts/migrate-v21-finops.js', 'scripts/migrate-rel-recovery.js', 'scripts/migrate-rel-exec-lease.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    process.env.DYNAMIC_V2_GENERAL_AVAILABILITY = 'true'; // fail closed: sin lista, V2 solo con habilitación pública explícita
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
    EL.resetExecLeaseSchemaCache();

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false, extra: { max: 6 } });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const ytOk = { async check() { return { ok: true }; } };
    const runs = new RunsService(ds, manifests, {}, ytOk, budget);
    const sched = new SchedulerService(ds, runs);

    let n = 0;
    /** Curso v3 sin videos; todo completado salvo el examen del módulo (pendiente, reclamable por el navegador). */
    async function makeCourse() {
      const title = `r58 procedencia ${++n}`;
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: false, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: false, activity_enabled: true },
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
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT })).run.id;
      } catch (err) {
        const body = err.getResponse ? err.getResponse() : null;
        assert(body && body.code === 'budget_approval_required', `startRun: ${err.message}`);
        await budget.adminAuthorize({ courseId: cid, estimateId: body.estimateId, authorizedBudget: '500', approvedBy: 'admin@cursia.test', reason: 'check r58' });
        runId = (await runs.startRun(cid, OWNER, 1, { ...CONTEXT })).run.id;
      }
      const [ex] = await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and type = 'exam'`, [runId]);
      assert(ex, 'el run tiene un examen de módulo');
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = $1 and item_key <> $2`, [runId, ex.item_key]);
      await ds.query(`update public.generation_item_runs set status = 'pending' where job_id = $1 and item_key = $2`, [runId, ex.item_key]);
      const [job] = await ds.query(`select course_id, frontend_course_id from public.production_jobs where id = $1`, [runId]);
      return { cid, runId, examKey: ex.item_key, artifactCourseId: job.frontend_course_id ?? String(job.course_id) };
    }
    async function claimExam(C) {
      const res = await sched.claimNextItemDetailed({ runId: C.runId, executorId: EXEC, types: ['exam', 'experience'], leaseSeconds: 120, ownerId: OWNER });
      assert(res.item && res.item.itemKey === C.examKey, 'claim del examen: ' + JSON.stringify(res).slice(0, 300));
      return res.item;
    }
    async function insertGift(C, item, metadata) {
      const p = `${OWNER}/dynamic/${C.artifactCourseId}/${item.manifestId}/dynamic_exam_gift/${item.idempotencyKey}/a${item.attempt}.gift`;
      const [a] = await ds.query(
        `insert into public.artifacts (owner_id, course_id, type, storage_path, mime_type, metadata) values ($1, $2, 'dynamic_exam_gift', $3, 'text/plain', $4::jsonb) returning id`,
        [OWNER, C.artifactCourseId, p, JSON.stringify(metadata)],
      );
      return a.id;
    }
    const itemRow = async (id) => (await ds.query(`select status, output_summary from public.generation_item_runs where id = $1`, [id]))[0];
    async function examClass(C) {
      const inputs = await RC.loadCompletionInputs({ query: ds.query.bind(ds) }, C.runId);
      return RC.classifyRunItems(inputs.job, new Map(inputs.rows.map((r) => [r.item_key, r])), inputs.manifest, inputs.validationCutoffs).get(C.examKey);
    }

    await check('DB R2: artifact con metadata.llmMode=mock → el servidor escribe output_summary.llmMode=mock; el examen es componente de VISTA PREVIA', async () => {
      const C = await makeCourse();
      const item = await claimExam(C);
      const id = await insertGift(C, item, { llmMode: 'mock', itemKey: item.itemKey });
      const res = await sched.completeItemDetailed(item.itemRunId, EXEC, { artifactIds: [id], summary: {} }, OWNER);
      eq(res.ok, true, 'complete: ' + JSON.stringify(res));
      const row = await itemRow(item.itemRunId);
      eq([row.status, row.output_summary.llmMode], ['completed', 'mock'], 'item');
      eq(await examClass(C), 'preview', 'clase');
      const inputs = await RC.loadCompletionInputs({ query: ds.query.bind(ds) }, C.runId);
      const c = RC.evaluateRunCompletion(inputs.job, inputs.rows, inputs.manifest, null, { validationCutoffs: inputs.validationCutoffs });
      assert(c.previewComponents.includes(C.examKey) && c.generationComplete === false, 'completion: ' + JSON.stringify({ p: c.previewComponents, g: c.generationComplete }));
    });

    await check('DB R2: el ejecutor declara llmMode=replay en su resumen (artifact sin marca) → replay; NO puede declarar real sobre un artifact mock', async () => {
      const C = await makeCourse();
      const item = await claimExam(C);
      const id = await insertGift(C, item, {});
      eq((await sched.completeItemDetailed(item.itemRunId, EXEC, { artifactIds: [id], summary: { llmMode: 'replay' } }, OWNER)).ok, true, 'complete');
      eq((await itemRow(item.itemRunId)).output_summary.llmMode, 'replay', 'replay');
      eq(await examClass(C), 'preview', 'clase');
      const D = await makeCourse();
      const it2 = await claimExam(D);
      const id2 = await insertGift(D, it2, { llmMode: 'mock' });
      eq((await sched.completeItemDetailed(it2.itemRunId, EXEC, { artifactIds: [id2], summary: { llmMode: 'real' } }, OWNER)).ok, true, 'complete');
      eq((await itemRow(it2.itemRunId)).output_summary.llmMode, 'mock', 'la peor gana');
    });

    await check('DB R2: llmMode desconocido (artifact registrado por fuera de la API) → `llm_mode_invalid`, el item sigue running y nada se vincula', async () => {
      const C = await makeCourse();
      const item = await claimExam(C);
      const id = await insertGift(C, item, { llmMode: 'fake' });
      const res = await sched.completeItemDetailed(item.itemRunId, EXEC, { artifactIds: [id], summary: {} }, OWNER);
      eq([res.ok, res.reason], [false, 'llm_mode_invalid'], 'rechazo');
      eq((await itemRow(item.itemRunId)).status, 'running', 'sigue running');
      eq((await ds.query(`select item_run_id from public.artifacts where id = $1`, [id]))[0].item_run_id, null, 'rollback: sin vincular');
    });

    await check('DB R2 regresión: artifact real (sin marca o llmMode=real) → output_summary SIN llmMode, el examen queda `done`', async () => {
      for (const meta of [{}, { llmMode: 'real' }]) {
        const C = await makeCourse();
        const item = await claimExam(C);
        const id = await insertGift(C, item, meta);
        eq((await sched.completeItemDetailed(item.itemRunId, EXEC, { artifactIds: [id], summary: { questions: 10 } }, OWNER)).ok, true, 'complete');
        const row = await itemRow(item.itemRunId);
        eq(['llmMode' in row.output_summary, row.output_summary.questions], [false, 10], 'resumen de siempre');
        eq(await examClass(C), 'done', 'done');
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
  global.fetch = realFetch;
  console.log(`\n${passes} OK, ${failures} fallidos`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(`❌ fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
