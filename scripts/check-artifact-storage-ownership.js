#!/usr/bin/env node
/* eslint-disable no-console */
// LOOP 7 (A4 C1): la API de artifacts nunca registra, firma ni borra un objeto de Storage ajeno.
// Pura: ArtifactsService con repo y fetch falsos (sin red, sin DB, sin Supabase).
//
//   AS1 create(): ruta de OTRO usuario, otro bucket, ruta insegura → 403; la propia → OK
//   AS2 getDownloadUrl(): una fila ajena registrada ANTES del control no se firma (403, ninguna llamada a Storage)
//   AS3 remove(): la fila ajena se borra pero el objeto NO; la propia borra el objeto
//   AS4 rutas válidas de los writers: <owner>/…, qa-internal/<owner>/…, mock/… (solo lectura); expires con tope
//
// Uso: node scripts/check-artifact-storage-ownership.js [path/to/dist]
'use strict';
const path = require('path');

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const { ArtifactsService, storagePathOwnedBy, clampSignedUrlSeconds } = require(path.join(distRoot, 'modules/artifacts/artifacts.service.js'));

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function env() {
  const rows = new Map();
  let n = 0;
  const calls = [];
  const repo = {
    create: (x) => ({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, '0')}`, ...x }),
    save: async (x) => { rows.set(x.id, x); return x; },
    findOne: async ({ where }) => { const r = rows.get(where.id); return r && r.ownerId === where.ownerId ? r : null; },
    manager: {
      connection: {
        createQueryRunner: () => ({
          connect: async () => {}, startTransaction: async () => {}, commitTransaction: async () => {}, rollbackTransaction: async () => {}, release: async () => {}, isTransactionActive: false,
          query: async (sql, params) => {
            if (/^select \* from public\.artifacts where id = \$1 and owner_id = \$2/.test(sql.trim())) {
              const r = rows.get(params[0]);
              return r && r.ownerId === params[1] ? [{ id: r.id, owner_id: r.ownerId, type: r.type, metadata: r.metadata, storage_provider: r.storageProvider, storage_bucket: r.storageBucket, storage_path: r.storagePath }] : [];
            }
            if (/where storage_bucket = \$1 and storage_path = \$2/.test(sql)) return [];
            if (/^delete from public\.artifacts/.test(sql.trim())) { rows.delete(params[0]); return []; }
            return [];
          },
        }),
      },
    },
  };
  const config = { get: (k) => ({ SUPABASE_URL: 'https://fake.supabase.local', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role' }[k]) };
  global.fetch = async (url, init) => { calls.push({ url, method: (init && init.method) || 'GET' }); return { ok: true, json: async () => ({ signedURL: '/object/sign/x?token=t' }), text: async () => '' }; };
  return { svc: new ArtifactsService(repo, config), rows, calls };
}
const dto = (p, bucket) => ({ type: 'test', storage_path: p, ...(bucket ? { storage_bucket: bucket } : {}) });
const code = async (fn) => { try { await fn(); return 'OK'; } catch (e) { return (e.response && e.response.code) || e.constructor.name; } };

(async () => {
  await check('AS1 create(): ruta ajena / otro bucket / ruta insegura → 403; la propia → OK', async () => {
    const { svc } = env();
    eq(await code(() => svc.createFromApi(dto(`${OTHER}/dynamic/1/2/dynamic_application_json/x/a1.json`), ME)), 'storage_path_not_owned', 'ruta de otro usuario');
    eq(await code(() => svc.createFromApi(dto(`${ME}/x.json`, 'otro-bucket'), ME)), 'storage_path_not_owned', 'otro bucket');
    eq(await code(() => svc.createFromApi(dto(`${ME}/../${OTHER}/x.json`), ME)), 'storage_path_not_owned', 'dot-segments');
    eq(await code(() => svc.createFromApi(dto(`qa-internal/${OTHER}/x.mbz`), ME)), 'storage_path_not_owned', 'QA de otro');
    eq(await code(() => svc.createFromApi(dto(`qa-internal/${ME}/dynamic/1/2/dynamic_mbz/r/c.mbz`), ME)), 'storage_path_not_owned', 'QA propio tampoco (solo lo registra el backend)');
    eq(await code(() => svc.createFromApi(dto('mock/presentation/x.pdf'), ME)), 'storage_path_not_owned', 'fixture mock no se registra por la API');
    eq(await code(() => svc.createFromApi(dto(`${ME}/123/content/libro.md`), ME)), 'OK', 'ruta propia (convención legacy y dynamic)');
    // El backend (uploadBufferArtifact → create) sí registra la copia QA interna del dueño; nunca la de otro.
    eq(await code(() => svc.create(dto(`qa-internal/${ME}/dynamic/1/2/dynamic_mbz/r/c.mbz`), ME)), 'OK', 'backend: QA propia');
    eq(await code(() => svc.create(dto(`qa-internal/${OTHER}/dynamic/1/2/dynamic_mbz/r/c.mbz`), ME)), 'storage_path_not_owned', 'backend: QA ajena');
    eq(await code(() => svc.create(dto(`${OTHER}/x.json`), ME)), 'storage_path_not_owned', 'backend: ruta ajena');
  });

  await check('AS2 getDownloadUrl(): una fila ajena registrada antes del control no se firma', async () => {
    const { svc, rows, calls } = env();
    rows.set('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ownerId: ME, storageProvider: 'supabase', storageBucket: 'cursia-artifacts', storagePath: `${OTHER}/dynamic/x/solucionario.json`, metadata: {} });
    eq(await code(() => svc.getDownloadUrl('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ME, 3600)), 'storage_path_not_owned', 'no se firma');
    eq(calls.length, 0, 'ninguna llamada a Storage');
    const own = await svc.createFromApi(dto(`${ME}/1/content/x.md`), ME);
    const r = await svc.getDownloadUrl(own.id, ME, 10 * 365 * 24 * 3600);
    assert(r.url && calls.length === 1, 'la propia se firma');
  });

  await check('AS3 remove(): la fila ajena se borra pero su objeto NO; la propia borra el objeto', async () => {
    const { svc, rows, calls } = env();
    rows.set('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ownerId: ME, type: 'test', storageProvider: 'supabase', storageBucket: 'cursia-artifacts', storagePath: `${OTHER}/1/package/curso.mbz`, metadata: {} });
    await svc.remove('cccccccc-cccc-4ccc-8ccc-cccccccccccc', ME);
    assert(!rows.has('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), 'fila borrada');
    eq(calls.filter((c) => c.method === 'DELETE').length, 0, 'objeto ajeno intacto');
    const own = await svc.createFromApi(dto(`${ME}/1/package/curso.mbz`), ME);
    await svc.remove(own.id, ME);
    eq(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.endsWith(`${ME}/1/package/curso.mbz`)), [true], 'objeto propio borrado');
  });

  await check('AS5 (r58 R1) POST /artifacts: tipos SOLO del servidor → 403 artifact_type_server_only (incl. un dynamic_mbz forjado); los del ejecutor del navegador y legacy → OK', async () => {
    const { svc, rows } = env();
    const own = (t, ext = 'json') => ({ type: t, storage_path: `${ME}/dynamic/9/8/${t}/k/a1.${ext}`, metadata: { runId: 'r', manifestId: 8 } });
    const forged = { type: 'dynamic_mbz', storage_path: `${ME}/dynamic/9/8/dynamic_mbz/run-1/abc.mbz`, checksum_sha256: 'a'.repeat(64),
      metadata: { runId: 'run-1', sourceIdsHash: 'abc', builderVersion: 'x', validatedSha256: 'a'.repeat(64) } };
    eq(await code(() => svc.createFromApi(forged, ME)), 'artifact_type_server_only', 'dynamic_mbz forjado');
    for (const t of ['dynamic_presentation', 'dynamic_audio_mp3', 'dynamic_audio_segment', 'dynamic_video', 'dynamic_coherence_report_json', ' dynamic_mbz']) {
      eq(await code(() => svc.createFromApi(own(t), ME)), 'artifact_type_server_only', t);
    }
    eq(rows.size, 0, 'nada registrado');
    // Tipos que sube el ejecutor del navegador (45-dynamic-generation-executor.js) y el flujo legacy: intactos.
    for (const t of ['dynamic_content_md', 'dynamic_context_package_json', 'dynamic_context_summary_json', 'dynamic_course_plan_json', 'dynamic_exam_bank_json',
      'dynamic_exam_gift', 'dynamic_scorm_html', 'dynamic_scorm_manifest', 'dynamic_application_json', 'dynamic_application_draft_json', 'dynamic_course_intro_json',
      'dynamic_module_intro_json', 'dynamic_experience_json', 'dynamic_guided_practice_json', 'dynamic_h5p_params_json', 'dynamic_video_interactions_json',
      'dynamic_exam_bank_draft_json', 'mbz_final', 'content_snapshot', 'h5p_snapshot']) {
      eq(await code(() => svc.createFromApi(own(t), ME)), 'OK', t);
    }
    // r58 (I4-2): un archivo de trabajo se valida al adjuntarlo (declaración + bytes; casos en check-quality-report P1).
    eq(await code(() => svc.createFromApi(own('practice_file', 'pdf'), ME)), 'practice_file_invalid', 'practice_file sin declaración');
    // El backend (uploadBufferArtifact → create) sí registra los suyos.
    eq(await code(() => svc.create(forged, ME)), 'OK', 'backend: dynamic_mbz');
  });

  await check('AS6 (r58 R2) POST /artifacts: metadata.llmMode solo real | mock | replay (otro valor → 400 llm_mode_invalid)', async () => {
    const { svc, rows } = env();
    const d = (m) => ({ type: 'dynamic_content_md', storage_path: `${ME}/dynamic/9/8/dynamic_content_md/k/a1.md`, metadata: { llmMode: m } });
    for (const m of ['real', 'mock', 'replay']) eq(await code(() => svc.createFromApi(d(m), ME)), 'OK', m);
    for (const m of ['REAL', 'fake', 1, true, '']) eq(await code(() => svc.createFromApi(d(m), ME)), 'llm_mode_invalid', JSON.stringify(m));
    eq(await code(() => svc.createFromApi({ type: 'dynamic_content_md', storage_path: `${ME}/x.md` }, ME)), 'OK', 'sin metadata');
    eq([...rows.values()].map((r) => r.metadata && r.metadata.llmMode), ['real', 'mock', 'replay', undefined], 'se guarda tal cual');
  });

  await check('AS4 rutas de los writers y tope de expires', () => {
    eq([
      storagePathOwnedBy(ME, 'cursia-artifacts', `${ME}/dynamic/9/8/dynamic_mbz/r/c.mbz`),
      storagePathOwnedBy(ME, 'cursia-artifacts', `qa-internal/${ME}/dynamic/9/8/dynamic_mbz/r/c.mbz`),
      storagePathOwnedBy(ME, 'cursia-artifacts', 'mock/presentation/c/cap1.pdf', { allowMockFixtures: true }),
      storagePathOwnedBy(ME, 'cursia-artifacts', 'mock/presentation/c/cap1.pdf'),
      storagePathOwnedBy(ME, 'cursia-artifacts', ME),
      storagePathOwnedBy('', 'cursia-artifacts', `${ME}/x`),
    ], [true, true, true, false, false, false], 'convenciones');
    eq([clampSignedUrlSeconds(10 * 365 * 24 * 3600), clampSignedUrlSeconds(5), clampSignedUrlSeconds(NaN), clampSignedUrlSeconds(3600)], [604800, 60, 3600, 3600], 'tope 1 min – 7 días');
  });

  console.log(`\n${passes} OK, ${failures} fallidas`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
