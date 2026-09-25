#!/usr/bin/env node
/* eslint-disable */
// Release-fix V2 (release review I1 + Minor 1) — sin DB y sin red externa,
// sobre los módulos COMPILADOS de dist/.
//
//  I1  dynamic-item-worker re-chequea DYNAMIC_REAL_VIDEO_OWNERS (fail closed,
//      env ACTUAL, no el del boot) inmediatamente antes de CUALQUIER submit
//      nuevo a Videogen de un run 'real'. No permitido → no se somete (0
//      gasto), no se marca externalSubmitStartedAt, el item falla
//      no-reintentable con `real_video_not_allowed: <motivo en español>`.
//      Re-pollear un job ya sometido (sin gasto nuevo) sigue permitido.
//      Videogen falso que cuenta batchCreate.
//  M1  ArtifactsService.remove(): artifacts NO dynamic → semántica legacy
//      (404 si no es del owner; se borra el objeto de Storage ANTES de la fila,
//      aunque otra fila legacy comparta el path); artifacts dynamic → fila
//      primero (transacción + FOR UPDATE) y el objeto solo si nadie más lo usa.
//
// Usage: node scripts/check-v2-release-fix.js [path/to/dist]

const path = require('path');

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

require('reflect-metadata');
const { Logger, NotFoundException } = require('@nestjs/common');
Logger.overrideLogger(false);

const worker = loadDist('workers/dynamic-item-worker.js');
const { ArtifactsService } = loadDist('modules/artifacts/artifacts.service.js');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const FLAG = 'DYNAMIC_COURSE_STRUCTURE';
const ALLOW = 'DYNAMIC_V2_ALLOWED_OWNERS';
const REAL = 'DYNAMIC_REAL_VIDEO_OWNERS';
const OWNER = 'aa2fa9a1-afb1-4b01-8646-94a0cb272b57';
const OTHER = '11111111-2222-4333-8444-555555555555';

// ─────────────────────────────────────────────────────────────────────────────
// I1 — fakes del worker
// ─────────────────────────────────────────────────────────────────────────────

const realFetch = global.fetch;
function stubFetch() {
  global.fetch = async (url) => {
    if (String(url).startsWith('https://fake-storage.local/')) {
      return { ok: true, status: 200, text: async () => '# Capítulo\n\nTexto del capítulo.' };
    }
    throw new Error('red no esperada: ' + url);
  };
}

function makeItem(n, outputSummary = {}) {
  return {
    itemRunId: `ir-${n}`, runId: 'run-1', courseId: 1, frontendCourseId: 'fc', artifactCourseId: 'fc',
    manifestId: 7, blueprintId: 3, blueprintNumber: 1, itemKey: `video:ch${n}`, type: 'video', rulesVersion: 2,
    moduleId: 'm1', chapterId: `ch${n}`, moduleNumber: 1, chapterNumber: n, idempotencyKey: `idem-${n}`,
    generation: 1, dependsOn: [`content:ch${n}`], attempt: 1, outputSummary,
    dependencyArtifacts: [{ type: 'dynamic_content_md', artifactId: `art-${n}` }],
    blueprint: { course: { title: 'Curso' }, chapter: { title: `Cap ${n}` } },
  };
}

function makeDeps({ videoMode = 'real' } = {}) {
  const calls = { batchCreate: 0, getVideoStatus: 0, failItem: [], recordItemExternal: [], completeItem: [] };
  const deps = {
    scheduler: {
      heartbeatItem: async () => true,
      failItem: async (id, ex, error, retryable) => { calls.failItem.push({ id, error, retryable }); return true; },
      recordItemExternal: async (id, ex, patch) => { calls.recordItemExternal.push({ id, patch }); return true; },
      completeItem: async (id, ex, out) => { calls.completeItem.push({ id, out }); return true; },
    },
    dataSource: {
      query: async (sql) => {
        if (/from public\.production_jobs/.test(sql)) {
          return [{ owner_id: OWNER, video_mode: videoMode, input_payload: { videoMode } }];
        }
        if (/from public\.generation_item_runs/.test(sql)) return [{ output_summary: {} }];
        throw new Error('query no esperada: ' + sql);
      },
    },
    artifacts: {
      getDownloadUrl: async (id) => ({ url: `https://fake-storage.local/${id}` }),
      uploadJsonArtifact: async () => ({ id: 'video-artifact' }),
    },
    videogen: {
      batchCreate: async (jobs) => {
        calls.batchCreate++;
        return { batch_id: 'b1', jobs: [{ job_id: `vg-${jobs[0].client_reference_id}` }] };
      },
      getVideoStatus: async (jobId) => {
        calls.getVideoStatus++;
        return { job_id: jobId, status: 'completed_local', download_url: `https://vg.local/${jobId}.mp4`, error: null };
      },
      getVideoCost: async () => ({ estimated_total_cost: 1.5 }),
    },
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    executorId: 'exec-1', leaseSeconds: 60, heartbeatMs: 60_000,
    videoTimeoutMin: 1, videoPollMs: 1, mockScenario: 'success', mockResolvePolls: 1, youtube: null,
  };
  return { deps, calls };
}

// DN-1: estos items son de runs `videogen_direct` (sin input_payload.videoDelivery) con video real:
// desde DN-1 solo se envían con el permiso de staging DYNAMIC_ALLOW_VIDEOGEN_DIRECT=true (el camino
// youtube y el bloqueo sin el permiso se prueban en check-dynamic-youtube-delivery.js).
const ENV_ON = { [FLAG]: 'true', [ALLOW]: undefined, [REAL]: OWNER, VIDEOGEN_API_KEY: 'k', DYNAMIC_ALLOW_VIDEOGEN_DIRECT: 'true' };

async function main() {
  stubFetch();
  try {
    await check('I1 control: owner en DYNAMIC_REAL_VIDEO_OWNERS → se somete 1 video real y el item completa', () =>
      withEnv(ENV_ON, async () => {
        const { deps, calls } = makeDeps();
        await worker.processItem(deps, makeItem(1));
        eq(calls.batchCreate, 1, 'batchCreate');
        eq(calls.failItem.length, 0, 'failItem');
        eq(calls.completeItem.length, 1, 'completeItem');
      }));

    const blocked = [
      { label: 'owner QUITADO de DYNAMIC_REAL_VIDEO_OWNERS (lista con otro owner)', env: { ...ENV_ON, [REAL]: OTHER } },
      { label: 'DYNAMIC_REAL_VIDEO_OWNERS vaciada (fail closed)', env: { ...ENV_ON, [REAL]: undefined } },
      { label: 'owner fuera de DYNAMIC_V2_ALLOWED_OWNERS', env: { ...ENV_ON, [ALLOW]: OTHER } },
      { label: 'flag DYNAMIC_COURSE_STRUCTURE OFF con el worker todavía vivo', env: { ...ENV_ON, [FLAG]: undefined } },
      { label: 'lista inválida (error de config → fail closed)', env: { ...ENV_ON, [REAL]: 'no-es-uuid' } },
    ];
    for (const b of blocked) {
      await check(`I1 ${b.label} → 0 submits, sin externalSubmitStartedAt, item failed no-reintentable con motivo en español`, () =>
        withEnv(b.env, async () => {
          const { deps, calls } = makeDeps();
          await worker.processItem(deps, makeItem(2));
          eq(calls.batchCreate, 0, 'batchCreate (gasto)');
          assert(!calls.recordItemExternal.some((r) => r.patch && r.patch.externalSubmitStartedAt), 'marcó externalSubmitStartedAt');
          eq(calls.failItem.length, 1, 'failItem');
          const f = calls.failItem[0];
          assert(f.retryable === false, 'debe ser no-reintentable');
          assert(/^real_video_not_allowed: /.test(f.error), 'código: ' + f.error);
          assert(/video real/i.test(f.error) && /no está habilitado/.test(f.error) && /no se envió/i.test(f.error), 'motivo legible: ' + f.error);
          assert(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(f.error), 'no debe filtrar UUIDs: ' + f.error);
        }));
    }

    await check('I1 mid-run: item 1 se somete, se quita al owner de la lista, items 2 y 3 → 0 submits nuevos (total 1)', async () => {
      const { deps, calls } = makeDeps();
      await withEnv(ENV_ON, () => worker.processItem(deps, makeItem(1)));
      await withEnv({ ...ENV_ON, [REAL]: OTHER }, async () => {
        await worker.processItem(deps, makeItem(2));
        await worker.processItem(deps, makeItem(3));
      });
      eq(calls.batchCreate, 1, 'batchCreate total');
      eq(calls.completeItem.length, 1, 'completeItem');
      eq(calls.failItem.map((f) => f.id), ['ir-2', 'ir-3'], 'items bloqueados');
    });

    await check('I1 re-poll de un job YA sometido (external.videogenJobId) con el owner quitado: sigue polleando y completa, 0 submits', () =>
      withEnv({ ...ENV_ON, [REAL]: undefined }, async () => {
        const { deps, calls } = makeDeps();
        await worker.processItem(deps, makeItem(4, { externalSubmitStartedAt: '2026-09-25T00:00:00Z', external: { videogenBatchId: 'b0', videogenJobId: 'vg-prev', mode: 'real' } }));
        eq(calls.batchCreate, 0, 'batchCreate');
        assert(calls.getVideoStatus >= 1, 'no polleó');
        eq(calls.failItem.length, 0, 'failItem');
        eq(calls.completeItem.length, 1, 'completeItem');
      }));

    await check('I1 run mock con el owner fuera de DYNAMIC_REAL_VIDEO_OWNERS: no afecta (mock nunca llama a Videogen)', () =>
      withEnv({ ...ENV_ON, [REAL]: undefined }, async () => {
        const { deps, calls } = makeDeps({ videoMode: 'mock' });
        await worker.processItem(deps, makeItem(5));
        eq(calls.batchCreate, 0, 'batchCreate');
        eq(calls.failItem.length, 0, 'failItem: ' + JSON.stringify(calls.failItem));
        eq(calls.completeItem.length, 1, 'completeItem');
      }));
  } finally {
    global.fetch = realFetch;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // M1 — ArtifactsService.remove()
  // ───────────────────────────────────────────────────────────────────────────
  const CONFIG = { get: (k) => ({ SUPABASE_URL: 'https://sb.local', SUPABASE_SERVICE_ROLE_KEY: 'svc' })[k] };

  /** Fake de TypeORM: filas en memoria; registra el orden de eventos (sql/storage). */
  function fakeArtifactsDb(rows) {
    const events = [];
    const table = rows.map((r) => ({ ...r }));
    const runQuery = async (sql, params) => {
      events.push('sql:' + sql.trim().split(/\s+/).slice(0, 2).join(' ').toLowerCase());
      if (/^select \* from public\.artifacts where id = \$1 and owner_id = \$2/i.test(sql.trim())) {
        return table.filter((r) => r.id === params[0] && r.owner_id === params[1]);
      }
      if (/^select \* from public\.artifacts where storage_bucket/i.test(sql.trim())) {
        return table.filter((r) => r.storage_bucket === params[0] && r.storage_path === params[1] && r.id !== params[2]);
      }
      if (/^delete from public\.artifacts where id = \$1/i.test(sql.trim())) {
        const i = table.findIndex((r) => r.id === params[0]);
        if (i >= 0) table.splice(i, 1);
        return [];
      }
      throw new Error('sql no esperado: ' + sql);
    };
    const qr = {
      isTransactionActive: false,
      connect: async () => {},
      startTransaction: async () => { qr.isTransactionActive = true; events.push('begin'); },
      commitTransaction: async () => { qr.isTransactionActive = false; events.push('commit'); },
      rollbackTransaction: async () => { qr.isTransactionActive = false; events.push('rollback'); },
      release: async () => {},
      query: runQuery,
    };
    const repo = { manager: { connection: { createQueryRunner: () => qr } } };
    return { repo, events, table };
  }
  function stubStorage(events, { ok = true } = {}) {
    global.fetch = async (url, init) => {
      events.push(`storage:${init && init.method}:${String(url).replace('https://sb.local/storage/v1/object/', '')}`);
      return { ok, status: ok ? 200 : 500, text: async () => '' };
    };
  }
  const legacyRow = (id, p = 'u1/course-9/final.mbz', extra = {}) => ({
    id, owner_id: 'u1', type: 'mbz_final', storage_provider: 'supabase', storage_bucket: 'cursia-artifacts', storage_path: p,
    item_run_id: null, manifest_id: null, ...extra,
  });
  const dynRow = (id, p, extra = {}) => ({
    id, owner_id: 'u1', type: 'dynamic_video', storage_provider: 'supabase', storage_bucket: 'cursia-artifacts', storage_path: p,
    item_run_id: 'ir-1', manifest_id: 7, ...extra,
  });

  try {
    await check('M1/N3 legacy: fila borrada y COMMIT primero; el DELETE de Storage corre FUERA de la transacción (mismo resultado que main)', async () => {
      const db = fakeArtifactsDb([legacyRow('a1')]);
      stubStorage(db.events);
      await new ArtifactsService(db.repo, CONFIG).remove('a1', 'u1');
      const iStorage = db.events.indexOf('storage:DELETE:cursia-artifacts/u1/course-9/final.mbz');
      const iCommit = db.events.indexOf('commit');
      assert(iStorage >= 0 && iCommit >= 0 && iStorage > iCommit, 'orden: ' + db.events.join(' → '));
      eq(db.table.length, 0, 'filas restantes');
    });
    await check('N3 legacy/dynamic: el DELETE de Storage lleva un timeout acotado (AbortSignal); Storage colgado → remove() termina y la fila queda borrada', () =>
      withEnv({ ARTIFACT_STORAGE_DELETE_TIMEOUT_MS: '50' }, async () => {
        for (const row of [legacyRow('a1'), dynRow('d1', 'u1/dynamic/fc/7/dynamic_video/k/a1.json')]) {
          const db = fakeArtifactsDb([row]);
          let sawSignal = false;
          global.fetch = (url, init) => new Promise((resolve, reject) => {
            sawSignal = !!(init && init.signal);
            if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          });
          const t0 = Date.now();
          let watchdog;
          await Promise.race([
            new ArtifactsService(db.repo, CONFIG).remove(row.id, 'u1'),
            new Promise((_, rej) => { watchdog = setTimeout(() => rej(new Error(`${row.id}: remove() colgado con Storage sin responder (sin timeout)`)), 3000); }),
          ]).finally(() => clearTimeout(watchdog));
          assert(sawSignal, `${row.id}: fetch sin signal`);
          assert(Date.now() - t0 < 2000, `${row.id}: no respetó el timeout (${Date.now() - t0} ms)`);
          eq(db.table.length, 0, `${row.id}: filas restantes`);
        }
      }));
    await check('M1 legacy: dos filas legacy con el MISMO path (x-upsert) → el objeto se borra igual (semántica de main, sin fuga)', async () => {
      const db = fakeArtifactsDb([legacyRow('a1'), legacyRow('a2')]);
      stubStorage(db.events);
      await new ArtifactsService(db.repo, CONFIG).remove('a1', 'u1');
      assert(db.events.some((e) => e.startsWith('storage:DELETE:')), 'no borró el objeto: ' + db.events.join(' → '));
      eq(db.table.map((r) => r.id), ['a2'], 'filas restantes');
    });
    await check('M1 legacy: Storage falla → se loguea y la fila se borra igual (como en main)', async () => {
      const db = fakeArtifactsDb([legacyRow('a1')]);
      stubStorage(db.events, { ok: false });
      await new ArtifactsService(db.repo, CONFIG).remove('a1', 'u1');
      eq(db.table.length, 0, 'filas restantes');
    });
    await check('M1 legacy/dynamic: artifact de otro owner → 404 sin tocar Storage ni borrar', async () => {
      const db = fakeArtifactsDb([legacyRow('a1'), dynRow('d1', 'u1/dynamic/fc/7/dynamic_video/k/a1.json')]);
      stubStorage(db.events);
      for (const id of ['a1', 'd1']) {
        let err = null;
        try { await new ArtifactsService(db.repo, CONFIG).remove(id, 'otro'); } catch (e) { err = e; }
        assert(err instanceof NotFoundException, `${id}: esperaba 404, fue ${err}`);
      }
      assert(!db.events.some((e) => e.startsWith('storage:')), 'tocó Storage');
      eq(db.table.length, 2, 'filas');
    });
    await check('M1 legacy cuyo path usa también una fila DYNAMIC → se conserva el objeto (protección dynamic)', async () => {
      const p = 'u1/dynamic/fc/7/dynamic_mbz/r/h.mbz';
      const db = fakeArtifactsDb([legacyRow('a1', p), dynRow('d1', p, { type: 'dynamic_mbz', item_run_id: null, manifest_id: null })]);
      stubStorage(db.events);
      await new ArtifactsService(db.repo, CONFIG).remove('a1', 'u1');
      assert(!db.events.some((e) => e.startsWith('storage:')), 'borró un objeto que usa una fila dynamic: ' + db.events.join(' → '));
      eq(db.table.map((r) => r.id), ['d1'], 'filas');
    });
    await check('M1 dynamic compartido (REUSE carried) → fila borrada en transacción, objeto CONSERVADO', async () => {
      const p = 'u1/dynamic/fc/7/dynamic_video/k/a1.json';
      const db = fakeArtifactsDb([dynRow('d1', p), dynRow('d2', p)]);
      stubStorage(db.events);
      await new ArtifactsService(db.repo, CONFIG).remove('d1', 'u1');
      assert(!db.events.some((e) => e.startsWith('storage:')), 'borró el objeto compartido');
      assert(db.events.includes('begin') && db.events.includes('commit'), 'sin transacción: ' + db.events.join(' → '));
      eq(db.table.map((r) => r.id), ['d2'], 'filas');
    });
    await check('M1 dynamic no compartido → fila primero (commit) y DESPUÉS el objeto de Storage', async () => {
      const db = fakeArtifactsDb([dynRow('d1', 'u1/dynamic/fc/7/dynamic_video/k/a1.json')]);
      stubStorage(db.events);
      await new ArtifactsService(db.repo, CONFIG).remove('d1', 'u1');
      const iCommit = db.events.indexOf('commit');
      const iStorage = db.events.findIndex((e) => e.startsWith('storage:DELETE:'));
      assert(iCommit >= 0 && iStorage > iCommit, 'orden: ' + db.events.join(' → '));
      eq(db.table.length, 0, 'filas');
    });
    await check('M1 un tipo dynamic_* sin item_run_id/manifest_id (p. ej. dynamic_mbz, reporte de coherencia) también es dynamic', async () => {
      const p = 'u1/dynamic/fc/7/coherence/j/r.json';
      const db = fakeArtifactsDb([dynRow('d1', p, { type: 'dynamic_coherence_report_json', item_run_id: null, manifest_id: null }), dynRow('d2', p)]);
      stubStorage(db.events);
      await new ArtifactsService(db.repo, CONFIG).remove('d1', 'u1');
      assert(!db.events.some((e) => e.startsWith('storage:')), 'borró el objeto compartido');
    });
  } finally {
    global.fetch = realFetch;
  }

  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
