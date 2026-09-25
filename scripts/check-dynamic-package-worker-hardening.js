#!/usr/bin/env node
/* eslint-disable */
// Fix wave de la revisión integral v2 (review-it2) — dynamic-package-worker,
// ArtifactsService y config del flujo dynamic. Sin DB y sin red: usa los
// módulos COMPILADOS de dist/ con un DataSource falso y fetch en memoria.
//
//  I1  concurrencia: DYNAMIC_PACKAGE_WORKER_CONCURRENCY validado; un fallo
//      del heartbeat (timeout del pool) nunca es una unhandled rejection y,
//      tras N fallos seguidos, se trata como lease perdida.
//  I2  upload inmutable (upsert:false) que responde "already exists" tras un
//      crash entre Storage y el insert del row → se verifica el objeto y se
//      adopta (exactamente un row), nunca se falla para siempre.
//  I3  DYNAMIC_MBZ_MOODLE_VERSION: valor desconocido → el job falla ruidoso;
//      la versión resuelta entra en la clave de reuse, pero la clave del caso
//      default (sin env) es BYTE-IDÉNTICA a la de antes.
//  M6  DYNAMIC_VIDEO_DELIVERY inválido no tumba procesos no-dynamic
//      (RunsService se construye igual); los workers dynamic lo loguean.
//  M7  la limpieza (rollback/release) del claim no enmascara el error original.
//
// Usage: node scripts/check-dynamic-package-worker-hardening.js [path/to/dist]

const path = require('path');
const crypto = require('crypto');

const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
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

// Red prohibida por defecto: cada check instala su propio fetch en memoria.
const realFetch = global.fetch;
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

require('reflect-metadata');
const worker = loadDist('workers/dynamic-package-worker.js');
const reuse = loadDist('modules/dynamic-packaging/packaging-reuse-key.js');
const { ArtifactsService } = loadDist('modules/artifacts/artifacts.service.js');
const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
const videoDelivery = loadDist('modules/dynamic-generation/dynamic-video-delivery.js');
const { DYNAMIC_MBZ_BUILDER_VERSION } = loadDist('package/dynamic-mbz-builder.js');

// Toda unhandled rejection del proceso cuenta como fallo (Node ≥15 la
// convertiría en crash del worker real).
const UNHANDLED = [];
process.on('unhandledRejection', (r) => UNHANDLED.push(r));

let passes = 0;
let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n   ') : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
async function rejects(p, re, msg) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${msg}: no lanzó`);
  if (re) assert(re.test(err.message), `${msg}: mensaje inesperado "${err.message}"`);
  return err;
}
function throwsSync(fn, re, msg) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert(err, `${msg}: no lanzó`);
  if (re) assert(re.test(err.message), `${msg}: mensaje inesperado "${err.message}"`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function silentLogger() {
  const calls = { log: [], warn: [], error: [] };
  return {
    calls,
    log: (m) => calls.log.push(String(m)),
    warn: (m) => calls.warn.push(String(m)),
    error: (m) => calls.error.push(String(m)),
  };
}

// ── DataSource falso: enruta por SQL. Registra complete/fail/heartbeat. ────
function fakeDataSource(opts = {}) {
  const state = { completed: [], failed: [], heartbeats: 0, heartbeatErrors: 0 };
  const ds = {
    state,
    async query(sql, params) {
      if (/lease_until = now\(\) \+/.test(sql) && /set lease_until/.test(sql)) {
        state.heartbeats++;
        if (opts.heartbeatThrows) { state.heartbeatErrors++; throw new Error('timeout exceeded when trying to connect'); }
        return [{ id: params[0] }];
      }
      if (/select input_payload from public\.production_jobs/.test(sql)) return [{ input_payload: {} }];
      if (/set status = 'completed'/.test(sql)) { state.completed.push({ id: params[0], summary: JSON.parse(params[2]) }); return [{ id: params[0] }]; }
      if (/set status = 'failed'/.test(sql)) { state.failed.push({ id: params[0], message: params[2] }); return []; }
      return [];
    },
    // Solo lo usa el código previo al fix (lock de sesión) o claimNext.
    createQueryRunner() {
      return opts.queryRunner ? opts.queryRunner() : {
        async connect() {}, async release() {}, async startTransaction() {}, async commitTransaction() {}, async rollbackTransaction() {},
        async query() { return [{}]; },
      };
    },
  };
  return ds;
}

const STUB_PLAN = { planVersion: 1, manifestId: 1, course: { id: 1, title: 'x', summary: null }, sections: [], modules: [], totals: { modules: 0, chapters: 0, scorms: 0, videos: 0, exams: 0 } };
const RESOLVED = new Map([['content_cap1', [{ artifactId: 'bbbb', type: 'dynamic_content_md' }]], ['scorm_cap1', [{ artifactId: 'aaaa', type: 'dynamic_scorm_html' }]]]);

function workerDeps(ds, over = {}) {
  const uploads = [];
  const built = [];
  const deps = {
    dataSource: ds,
    artifacts: {
      async findAll() { return over.existing || []; },
      async uploadBufferArtifact(input) { uploads.push(input); return { id: `artifact-${uploads.length}` }; },
    },
    // El worker lee el Manifest CONGELADO del run (getById, R1/R3); `get`
    // queda por compatibilidad con código previo. Stub desactualizado hasta
    // la fix wave review-rv2 (7 checks fallaban por TypeError en getById).
    manifests: {
      async get() { return { id: 1, blueprintNumber: 1, rulesVersion: 1, manifest: { items: [] } }; },
      async getById() { return { id: 1, blueprintNumber: 1, rulesVersion: 1, manifest: { items: [] } }; },
    },
    blueprints: { async getByNumber() { return { snapshot: {} }; } },
    buildPlan: () => STUB_PLAN,
    resolveArtifacts: async () => RESOLVED,
    loadText: async () => '',
    parseVideo: () => ({ url: '', videogenJobId: '' }),
    buildMbz: async (input) => { built.push(input); if (over.buildMs) await sleep(over.buildMs); return Buffer.from('mbz-bytes'); },
    logger: over.logger || silentLogger(),
    workerId: 'w-check',
    leaseSeconds: 60,
    heartbeatMs: over.heartbeatMs || 999999,
    ...over.deps,
  };
  return { deps, uploads, built };
}
const JOB = (id = 'job-1', runId = 'run-1') => ({
  id, owner_id: 'owner-1', course_id: 1, frontend_course_id: 'fc-1', worker_status: 'running', status: 'running',
  input_payload: { runId, manifestId: 1, blueprintNumber: 1 }, output_summary: {}, attempt_count: 1, max_attempts: 3,
});

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  const restore = () => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

(async () => {
  console.log('\n=== I1: concurrencia acotada + heartbeat resistente ===');

  await check('I1 resolveDynamicPackageWorkerConcurrency: default 1, válidos, inválidos lanzan', () => {
    const f = worker.resolveDynamicPackageWorkerConcurrency;
    assert(typeof f === 'function', 'resolveDynamicPackageWorkerConcurrency no exportado');
    eq(f({}), 1, 'sin env');
    eq(f({ DYNAMIC_PACKAGE_WORKER_CONCURRENCY: '' }), 1, 'vacío');
    eq(f({ DYNAMIC_PACKAGE_WORKER_CONCURRENCY: '2' }), 2, '"2"');
    eq(f({ DYNAMIC_PACKAGE_WORKER_CONCURRENCY: ' 3 ' }), 3, '" 3 "');
    for (const bad of ['0', '-1', 'abc', '1.5', '4', '99']) {
      throwsSync(() => f({ DYNAMIC_PACKAGE_WORKER_CONCURRENCY: bad }), /DYNAMIC_PACKAGE_WORKER_CONCURRENCY/, `valor ${bad}`);
    }
  });

  await check('I1 heartbeat: un timeout del pool NO es unhandled rejection; tras N fallos seguidos → lease perdida (sin upload/complete/fail)', async () => {
    const before = UNHANDLED.length;
    {
      const ds = fakeDataSource({ heartbeatThrows: true });
      const logger = silentLogger();
      const { deps, uploads } = workerDeps(ds, { heartbeatMs: 10, buildMs: 250, logger });
      await worker.processItem(deps, JOB());
      await sleep(30);
      eq(UNHANDLED.length - before, 0, 'unhandled rejections');
      assert(ds.state.heartbeatErrors >= 3, `se esperaban ≥3 heartbeats fallidos, hubo ${ds.state.heartbeatErrors}`);
      eq(uploads.length, 0, 'uploads tras lease perdida');
      eq(ds.state.completed.length, 0, 'completeJob tras lease perdida');
      eq(ds.state.failed.length, 0, 'failJob tras lease perdida (otro worker la re-reclama)');
      assert(logger.calls.error.some((m) => /heartbeat/i.test(m)), 'no se logueó error de heartbeat');
    }
  });

  await check('I1 heartbeat: un fallo aislado seguido de éxito NO aborta el job', async () => {
    let n = 0;
    const ds = fakeDataSource();
    const orig = ds.query.bind(ds);
    ds.query = async (sql, params) => {
      if (/set lease_until/.test(sql) && n++ === 0) throw new Error('timeout exceeded when trying to connect');
      return orig(sql, params);
    };
    const { deps, uploads } = workerDeps(ds, { heartbeatMs: 10, buildMs: 80 });
    await worker.processItem(deps, JOB());
    eq(uploads.length, 1, 'uploads');
    eq(ds.state.completed.length, 1, 'completed');
  });

  await check('I1 processItem no fija una conexión dedicada del pool durante el build', async () => {
    let runnersCreated = 0;
    const ds = fakeDataSource({ queryRunner: () => { runnersCreated++; return { async connect() {}, async release() {}, async query() { return [{}]; } }; } });
    const { deps } = workerDeps(ds);
    await worker.processItem(deps, JOB());
    eq(runnersCreated, 0, 'queryRunners creados por processItem');
    eq(ds.state.completed.length, 1, 'completed');
  });

  console.log('\n=== M7: la limpieza del claim no enmascara el error original ===');

  await check('M7 claimNext: si la query falla y el rollback TAMBIÉN falla, se propaga el error ORIGINAL', async () => {
    const logger = silentLogger();
    const ds = fakeDataSource({
      queryRunner: () => ({
        async connect() {}, async startTransaction() {}, async commitTransaction() {},
        async query() { throw new Error('ORIGINAL: claim query failed'); },
        async rollbackTransaction() { throw new Error('rollback failed: connection terminated'); },
        async release() { throw new Error('release failed'); },
      }),
    });
    await rejects(worker.claimNext(ds, 'w', 60, logger), /ORIGINAL: claim query failed/, 'claimNext');
  });

  console.log('\n=== I3: DYNAMIC_MBZ_MOODLE_VERSION ===');

  await check('I3 resolveDynamicMoodleVersion: sin env → 4.1 (requested undefined); conocido → tal cual; desconocido → lanza', () => {
    const f = reuse.resolveDynamicMoodleVersion;
    assert(typeof f === 'function', 'resolveDynamicMoodleVersion no exportado');
    eq(f({}), { requested: undefined, resolved: '4.1' }, 'sin env');
    eq(f({ DYNAMIC_MBZ_MOODLE_VERSION: '  ' }), { requested: undefined, resolved: '4.1' }, 'vacío');
    eq(f({ DYNAMIC_MBZ_MOODLE_VERSION: '4.5' }), { requested: '4.5', resolved: '4.5' }, '4.5');
    eq(f({ DYNAMIC_MBZ_MOODLE_VERSION: ' 4.4 ' }), { requested: '4.4', resolved: '4.4' }, '" 4.4 "');
    for (const bad of ['4.3', '5', 'latest', '4.1.0']) {
      throwsSync(() => f({ DYNAMIC_MBZ_MOODLE_VERSION: bad }), /DYNAMIC_MBZ_MOODLE_VERSION/, `valor ${bad}`);
    }
  });

  await check('I3 clave de reuse: default (4.1) BYTE-IDÉNTICA a sha256(`${builderVersion}:${ids}`); otra versión → clave distinta', () => {
    const ids = ['aaaa', 'bbbb'];
    const legacy = crypto.createHash('sha256').update(`${DYNAMIC_MBZ_BUILDER_VERSION}:${ids.join(',')}`).digest('hex');
    eq(reuse.sourceIdsHash(DYNAMIC_MBZ_BUILDER_VERSION, ids), legacy, 'sourceIdsHash sin cambios');
    assert(typeof reuse.packageReuseHash === 'function', 'packageReuseHash no exportado');
    eq(reuse.packageReuseHash(DYNAMIC_MBZ_BUILDER_VERSION, ids, '4.1'), legacy, 'packageReuseHash(4.1)');
    const v45 = reuse.packageReuseHash(DYNAMIC_MBZ_BUILDER_VERSION, ids, '4.5');
    const v44 = reuse.packageReuseHash(DYNAMIC_MBZ_BUILDER_VERSION, ids, '4.4');
    assert(v45 !== legacy && v44 !== legacy && v45 !== v44, 'versiones distintas deben dar claves distintas');
  });

  await check('I3 processItem con DYNAMIC_MBZ_MOODLE_VERSION desconocido → job failed ruidoso, sin build ni upload', () =>
    withEnv('DYNAMIC_MBZ_MOODLE_VERSION', '4.3', async () => {
      const ds = fakeDataSource();
      const { deps, uploads, built } = workerDeps(ds);
      await worker.processItem(deps, JOB());
      eq(built.length, 0, 'builds');
      eq(uploads.length, 0, 'uploads');
      eq(ds.state.completed.length, 0, 'completed');
      eq(ds.state.failed.length, 1, 'failed');
      assert(/DYNAMIC_MBZ_MOODLE_VERSION/.test(ds.state.failed[0].message) && /4\.3/.test(ds.state.failed[0].message), `mensaje: ${ds.state.failed[0].message}`);
    }));

  await check('I3 processItem sin env: buildMbz recibe undefined, metadata 4.1, sourceIdsHash = clave legacy', () =>
    withEnv('DYNAMIC_MBZ_MOODLE_VERSION', undefined, async () => {
      const ds = fakeDataSource();
      const { deps, uploads, built } = workerDeps(ds);
      await worker.processItem(deps, JOB());
      eq(built.length, 1, 'builds');
      eq(built[0].moodleVersion, undefined, 'moodleVersion al builder');
      eq(uploads[0].metadata.moodleVersion, '4.1', 'metadata.moodleVersion');
      eq(uploads[0].metadata.sourceIdsHash, reuse.sourceIdsHash(DYNAMIC_MBZ_BUILDER_VERSION, ['aaaa', 'bbbb']), 'sourceIdsHash');
    }));

  await check('I3 processItem con 4.5: builder recibe 4.5, metadata 4.5, clave distinta; un dynamic_mbz default NO se reusa', () =>
    withEnv('DYNAMIC_MBZ_MOODLE_VERSION', '4.5', async () => {
      const legacyHash = reuse.sourceIdsHash(DYNAMIC_MBZ_BUILDER_VERSION, ['aaaa', 'bbbb']);
      const existing = [{ id: 'old-41', metadata: { runId: 'run-1', sourceIdsHash: legacyHash, builderVersion: DYNAMIC_MBZ_BUILDER_VERSION, moodleVersion: '4.1' } }];
      const ds = fakeDataSource();
      const { deps, uploads, built } = workerDeps(ds, { existing });
      await worker.processItem(deps, JOB());
      eq(built.length, 1, 'builds (no reuse del 4.1)');
      eq(built[0].moodleVersion, '4.5', 'moodleVersion al builder');
      eq(uploads[0].metadata.moodleVersion, '4.5', 'metadata.moodleVersion');
      assert(uploads[0].metadata.sourceIdsHash !== legacyHash, 'la clave 4.5 no debe ser la legacy');
      assert(uploads[0].storagePath.includes(uploads[0].metadata.sourceIdsHash), 'el path usa la clave con versión');
    }));

  await check('I3 reuse default: un dynamic_mbz existente sin moodleVersion en metadata (pre-fix) se sigue reusando sin env', () =>
    withEnv('DYNAMIC_MBZ_MOODLE_VERSION', undefined, async () => {
      const legacyHash = reuse.sourceIdsHash(DYNAMIC_MBZ_BUILDER_VERSION, ['aaaa', 'bbbb']);
      const existing = [{ id: 'old', metadata: { runId: 'run-1', sourceIdsHash: legacyHash, builderVersion: DYNAMIC_MBZ_BUILDER_VERSION } }];
      const ds = fakeDataSource();
      const { deps, built } = workerDeps(ds, { existing });
      await worker.processItem(deps, JOB());
      eq(built.length, 0, 'builds');
      eq(ds.state.completed[0]?.summary?.artifactId, 'old', 'reusa el existente');
    }));

  console.log('\n=== I2: adopción idempotente del objeto inmutable ya subido ===');

  function inMemoryStorage({ headStatus } = {}) {
    const objects = new Map();
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || 'GET').toUpperCase();
      calls.push({ method, url: u });
      const m = u.match(/\/storage\/v1\/object\/(?:authenticated\/)?(?:info\/)?([^/]+)\/(.+)$/);
      if (!m) return new Response('not found', { status: 404 });
      const key = `${m[1]}/${decodeURIComponent(m[2])}`;
      if (method === 'POST') {
        const upsert = (init.headers || {})['x-upsert'] !== 'false';
        if (objects.has(key) && !upsert) {
          // Forma real de Supabase Storage: HTTP 400 con statusCode "409" en el body.
          return new Response(JSON.stringify({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }), { status: 400 });
        }
        objects.set(key, Buffer.from(init.body));
        return new Response(JSON.stringify({ Key: key }), { status: 200 });
      }
      if (method === 'HEAD') {
        if (headStatus) return new Response(null, { status: headStatus });
        const obj = objects.get(key);
        if (!obj) return new Response(null, { status: 404 });
        return new Response(null, { status: 200, headers: { 'content-length': String(obj.length) } });
      }
      return new Response('unsupported', { status: 405 });
    };
    return { objects, calls, fetchImpl };
  }
  function fakeRepo({ failSaves = 0 } = {}) {
    const rows = [];
    let toFail = failSaves;
    return {
      rows,
      create: (x) => ({ ...x }),
      async save(x) {
        if (toFail > 0) { toFail--; throw new Error('simulated DB blip / crash after Storage write'); }
        const row = { ...x, id: `row-${rows.length + 1}` };
        rows.push(row);
        return row;
      },
    };
  }
  const CONFIG = { get: (k) => ({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' })[k] };
  const UPLOAD = (over = {}) => ({
    ownerId: 'owner-1', courseId: 'fc-1', jobId: 'job-1', type: 'dynamic_mbz', filename: 'h.mbz',
    storagePath: 'owner-1/dynamic/fc-1/1/dynamic_mbz/run-1/h.mbz', buffer: Buffer.from('mbz-bytes-v1'),
    mimeType: 'application/vnd.moodle.backup', upsert: false, metadata: { runId: 'run-1' }, ...over,
  });

  await check('I2 crash entre Storage y el row → el reintento ADOPTA el objeto y deja exactamente un row', async () => {
    const storage = inMemoryStorage();
    global.fetch = storage.fetchImpl;
    try {
      const repo = fakeRepo({ failSaves: 1 });
      const svc = new ArtifactsService(repo, CONFIG);
      await rejects(svc.uploadBufferArtifact(UPLOAD({ adoptExistingOnConflict: true })), /simulated DB blip/, 'primer intento');
      eq(storage.objects.size, 1, 'objeto quedó en Storage');
      eq(repo.rows.length, 0, 'sin row tras el crash');
      // Reintento: el build no es byte-idéntico (otro tamaño) — igual se adopta el objeto existente.
      const row = await svc.uploadBufferArtifact(UPLOAD({ adoptExistingOnConflict: true, buffer: Buffer.from('mbz-bytes-v1-rebuilt') }));
      eq(repo.rows.length, 1, 'exactamente un row');
      eq(row.storage_path ?? row.storagePath, UPLOAD().storagePath, 'row apunta al objeto existente');
      eq(row.size_bytes ?? row.sizeBytes, Buffer.from('mbz-bytes-v1').length, 'size_bytes = tamaño REAL del objeto adoptado');
      eq((row.metadata || {}).adoptedExistingObject, true, 'metadata.adoptedExistingObject');
      eq((row.metadata || {}).runId, 'run-1', 'metadata original conservada');
      assert(storage.calls.some((c) => c.method === 'HEAD'), 'se verificó el objeto (HEAD)');
    } finally {
      global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };
    }
  });

  await check('I2 sin adoptExistingOnConflict el duplicado sigue fallando (legacy/otros callers intactos)', async () => {
    const storage = inMemoryStorage();
    global.fetch = storage.fetchImpl;
    try {
      const svc = new ArtifactsService(fakeRepo(), CONFIG);
      await svc.uploadBufferArtifact(UPLOAD());
      await rejects(svc.uploadBufferArtifact(UPLOAD()), /Supabase Storage upload failed: 400/, 'duplicado sin adopción');
    } finally {
      global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };
    }
  });

  await check('I2 duplicado pero el objeto NO se puede verificar (HEAD 404) → falla ruidoso, sin row', async () => {
    const storage = inMemoryStorage({ headStatus: 404 });
    global.fetch = storage.fetchImpl;
    try {
      const repo = fakeRepo();
      const svc = new ArtifactsService(repo, CONFIG);
      await svc.uploadBufferArtifact(UPLOAD());
      await rejects(svc.uploadBufferArtifact(UPLOAD({ adoptExistingOnConflict: true })), /already exists|409|Duplicate/i, 'duplicado no verificable');
      eq(repo.rows.length, 1, 'solo el row del primer upload');
    } finally {
      global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };
    }
  });

  await check('I2 el worker pide adopción para el dynamic_mbz inmutable (upsert:false + adoptExistingOnConflict:true)', () =>
    withEnv('DYNAMIC_MBZ_MOODLE_VERSION', undefined, async () => {
      const ds = fakeDataSource();
      const { deps, uploads } = workerDeps(ds);
      await worker.processItem(deps, JOB());
      eq(uploads[0].upsert, false, 'upsert');
      eq(uploads[0].adoptExistingOnConflict, true, 'adoptExistingOnConflict');
    }));

  console.log('\n=== M6: DYNAMIC_VIDEO_DELIVERY inválido no tumba procesos no-dynamic ===');

  await check('M6 RunsService se construye con DYNAMIC_VIDEO_DELIVERY inválido (AppModule/legacy no cae)', () =>
    withEnv('DYNAMIC_VIDEO_DELIVERY', 'YouTube', () => {
      new RunsService({}, {}, {});
    }));

  await check('M6 startRun sigue fallando ruidoso con el valor inválido (validación lazy en la creación del run)', () =>
    // Fase 9 (flag-gating): startRun exige DYNAMIC_COURSE_STRUCTURE=true (G1/G3).
    withEnv('DYNAMIC_COURSE_STRUCTURE', 'true', () => withEnv('DYNAMIC_VIDEO_DELIVERY', 'own_storage', async () => {
      const svc = new RunsService({}, { async get() { return { id: 1, manifest: { items: [] } }; } }, {});
      // Aislar la validación de la estrategia del resto de startRun.
      svc.assertRequiredContext = () => {};
      svc.resolveOrCreateRun = async () => { throw new Error('no debería llegar a crear el run'); };
      await rejects(svc.startRun(1, 'owner-1', 1, {}), /DYNAMIC_VIDEO_DELIVERY/, 'startRun');
    })));

  await check('M6 reportVideoDeliveryConfigAtStartup: inválido → logger.error claro y NO lanza; válido → devuelve la estrategia', () => {
    const f = videoDelivery.reportVideoDeliveryConfigAtStartup;
    assert(typeof f === 'function', 'reportVideoDeliveryConfigAtStartup no exportado');
    const logger = silentLogger();
    eq(f(logger, { DYNAMIC_VIDEO_DELIVERY: 'yotube' }), null, 'inválido');
    assert(logger.calls.error.some((m) => /DYNAMIC_VIDEO_DELIVERY/.test(m) && /yotube/.test(m)), 'error logueado');
    eq(f(silentLogger(), {}), 'videogen_direct', 'sin env');
    eq(f(silentLogger(), { DYNAMIC_VIDEO_DELIVERY: 'youtube' }), 'youtube', 'youtube');
  });

  await sleep(50);
  if (UNHANDLED.length) {
    failures++;
    console.error(`❌ ${UNHANDLED.length} unhandled rejection(s) durante el check: ${UNHANDLED.map((r) => r && r.message).join(' | ')}`);
  }
  global.fetch = realFetch;
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
