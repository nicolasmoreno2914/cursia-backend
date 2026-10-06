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
    eq(await code(() => svc.create(dto(`${OTHER}/dynamic/1/2/dynamic_application_json/x/a1.json`), ME)), 'storage_path_not_owned', 'ruta de otro usuario');
    eq(await code(() => svc.create(dto(`${ME}/x.json`, 'otro-bucket'), ME)), 'storage_path_not_owned', 'otro bucket');
    eq(await code(() => svc.create(dto(`${ME}/../${OTHER}/x.json`), ME)), 'storage_path_not_owned', 'dot-segments');
    eq(await code(() => svc.create(dto(`qa-internal/${OTHER}/x.mbz`), ME)), 'storage_path_not_owned', 'QA de otro');
    eq(await code(() => svc.create(dto('mock/presentation/x.pdf'), ME)), 'storage_path_not_owned', 'fixture mock no se registra por la API');
    eq(await code(() => svc.create(dto(`${ME}/123/content/libro.md`), ME)), 'OK', 'ruta propia (convención legacy y dynamic)');
  });

  await check('AS2 getDownloadUrl(): una fila ajena registrada antes del control no se firma', async () => {
    const { svc, rows, calls } = env();
    rows.set('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ownerId: ME, storageProvider: 'supabase', storageBucket: 'cursia-artifacts', storagePath: `${OTHER}/dynamic/x/solucionario.json`, metadata: {} });
    eq(await code(() => svc.getDownloadUrl('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ME, 3600)), 'storage_path_not_owned', 'no se firma');
    eq(calls.length, 0, 'ninguna llamada a Storage');
    const own = await svc.create(dto(`${ME}/1/content/x.md`), ME);
    const r = await svc.getDownloadUrl(own.id, ME, 10 * 365 * 24 * 3600);
    assert(r.url && calls.length === 1, 'la propia se firma');
  });

  await check('AS3 remove(): la fila ajena se borra pero su objeto NO; la propia borra el objeto', async () => {
    const { svc, rows, calls } = env();
    rows.set('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ownerId: ME, type: 'test', storageProvider: 'supabase', storageBucket: 'cursia-artifacts', storagePath: `${OTHER}/1/package/curso.mbz`, metadata: {} });
    await svc.remove('cccccccc-cccc-4ccc-8ccc-cccccccccccc', ME);
    assert(!rows.has('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), 'fila borrada');
    eq(calls.filter((c) => c.method === 'DELETE').length, 0, 'objeto ajeno intacto');
    const own = await svc.create(dto(`${ME}/1/package/curso.mbz`), ME);
    await svc.remove(own.id, ME);
    eq(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.endsWith(`${ME}/1/package/curso.mbz`)), [true], 'objeto propio borrado');
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
