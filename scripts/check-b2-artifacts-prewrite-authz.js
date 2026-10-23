#!/usr/bin/env node
/* eslint-disable no-console */
// B2 (hotfix de producción #93 portado a V2): ninguna escritura en Storage con la service role ocurre antes de validar
// la ruta. Pura: ArtifactsService con repo y fetch falsos (sin red, sin DB, sin Supabase).
//
//   PW1 uploadJsonArtifact / uploadBufferArtifact / putStorageObject / create: cada ruta maliciosa → 403
//       storage_path_not_owned y CERO llamadas a Storage (antes: el objeto se escribía y recién create() fallaba)
//   PW2 rutas legítimas de V1 (frontend `<uid>/<curso>/<carpeta>/<safeName>`, workers gamma/contenido) y de V2
//       (`<uid>/dynamic/…`, checkpoints LLM, segmentos de audio, coherencia, `qa-internal/<uid>/…`) → se escriben
//       exactamente una vez, en la URL esperada
//   PW3 putStorageObject sin ownerId (llamador viejo) → 403 sin escribir (falla cerrada)
//   PW4 lectura sin cambios: getDownloadUrl sigue firmando fixtures `mock/…` (solo lectura) y la ruta propia
//
// Uso: node scripts/check-b2-artifacts-prewrite-authz.js [path/to/dist]
'use strict';
const path = require('path');

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const { ArtifactsService, assertWritableStoragePath } = require(path.join(distRoot, 'modules/artifacts/artifacts.service.js'));

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BUCKET = 'cursia-artifacts';
const HEX = 'a'.repeat(64);

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
          query: async () => [],
        }),
      },
    },
  };
  const config = { get: (k) => ({ SUPABASE_URL: 'https://fake.supabase.local', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role' }[k]) };
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET' });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ signedURL: '/object/sign/x?token=t' }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { svc: new ArtifactsService(repo, config), rows, calls };
}
const code = async (fn) => { try { await fn(); return 'OK'; } catch (e) { return (e.response && e.response.code) || e.constructor.name; } };
const writes = (calls) => calls.filter((c) => c.method === 'POST' || c.method === 'PUT');

// Las 4 vías de escritura, con la misma ruta y el mismo dueño.
const WRITERS = {
  uploadJsonArtifact: (svc, ownerId, storagePath, bucket) =>
    svc.uploadJsonArtifact({ ownerId, type: 'test', filename: 'x.json', storagePath, payload: { a: 1 }, ...(bucket ? { storageBucket: bucket } : {}) }),
  uploadBufferArtifact: (svc, ownerId, storagePath, bucket) =>
    svc.uploadBufferArtifact({ ownerId, type: 'test', filename: 'x.bin', storagePath, buffer: Buffer.from('x'), mimeType: 'application/octet-stream', ...(bucket ? { storageBucket: bucket } : {}) }),
  putStorageObject: (svc, ownerId, storagePath, bucket) =>
    svc.putStorageObject({ ownerId, storagePath, buffer: Buffer.from('x'), mimeType: 'application/octet-stream', ...(bucket ? { storageBucket: bucket } : {}) }),
  create: (svc, ownerId, storagePath, bucket) =>
    svc.create({ type: 'test', storage_path: storagePath, ...(bucket ? { storage_bucket: bucket } : {}) }, ownerId),
};

const MALICIOUS = [
  ['carpeta de otro usuario', `${OTHER}/c1/content/x.json`],
  ['traversal ..', `${ME}/../${OTHER}/c1/x.json`],
  ['traversal al final', `${ME}/c1/..`],
  ['segmento .', `${ME}/./x.json`],
  ['%2e%2e codificado', `${ME}/%2e%2e/${OTHER}/x.json`],
  ['%2f codificado', `${ME}/c1%2f..%2f..%2fx.json`],
  ['backslash', `${ME}\\..\\${OTHER}\\x.json`],
  ['absoluta', `/${ME}/c1/x.json`],
  ['segmento vacío', `${ME}//x.json`],
  ['carácter de control', `${ME}/c1/x\u0000.json`],
  ['salto de línea', `${ME}/c1/x\n.json`],
  ['? corta la URL', `${ME}/c1/x.json?x=1`],
  ['# corta la URL', `${ME}/c1/x.json#frag`],
  ['solo el dueño (1 segmento)', `${ME}`],
  ['prefijo parecido al dueño', `${ME}x/c1/x.json`],
  ['qa-internal de otro', `qa-internal/${OTHER}/x.mbz`],
  ['fixtures mock (solo lectura)', 'mock/presentation/c1/cap1_presentacion.pdf'],
  ['espacio (más estricto que #93)', `${ME}/c1/Libro Guía.html`],
  ['demasiado larga', `${ME}/${'a'.repeat(1100)}`],
  ['vacía', ''],
];

const VALID = [
  ['V1 frontend <uid>/<curso>/<carpeta>/<safeName>', `${ME}/course_1730000000000/content/libro_guia_completo.html`],
  ['V1 frontend uuid de curso', `${ME}/3f6c1d2e-9a7b-4c1d-8e2f-0a1b2c3d4e5f/media/audiobook_1730000000000.mp3`],
  ['V1 gamma worker', `${ME}/3f6c1d2e-9a7b-4c1d-8e2f-0a1b2c3d4e5f/gamma/cap1_presentacion.pdf`],
  ['V2 storageBase (dynamic_*)', `${ME}/dynamic/3f6c1d2e-9a7b-4c1d-8e2f-0a1b2c3d4e5f/1392/dynamic_presentation/${HEX}/a1.pdf`],
  ['V2 segmento de audio', `${ME}/dynamic/3f6c1d2e-9a7b-4c1d-8e2f-0a1b2c3d4e5f/1392/dynamic_audio_segment/${HEX}/seg-2-0-efcc6108ef1e.a3.mp3`],
  ['V2 checkpoint LLM', `${ME}/dynamic/3f6c1d2e-9a7b-4c1d-8e2f-0a1b2c3d4e5f/1392/llm-checkpoints/7831fa67-0743-4779-a594-783c60c37bf8/${HEX}.json`],
  ['V2 coherencia', `${ME}/dynamic/1610/1392/coherence/7831fa67-0743-4779-a594-783c60c37bf8/llm-${HEX}.json`],
  ['V2 .mbz de QA interno', `qa-internal/${ME}/dynamic/1610/1392/qa.mbz`],
];

(async () => {
  for (const [writer, call] of Object.entries(WRITERS)) {
    await check(`PW1 ${writer}: ${MALICIOUS.length} rutas maliciosas → 403 storage_path_not_owned y 0 escrituras en Storage`, async () => {
      for (const [label, p] of MALICIOUS) {
        const { svc, calls, rows } = env();
        eq(await code(() => call(svc, ME, p)), 'storage_path_not_owned', `${writer} / ${label}`);
        eq(writes(calls).length, 0, `${writer} / ${label}: escrituras en Storage`);
        eq(rows.size, 0, `${writer} / ${label}: filas registradas`);
      }
    });
    await check(`PW1 ${writer}: otro bucket (ruta propia válida) → 403 y 0 escrituras`, async () => {
      const { svc, calls } = env();
      eq(await code(() => call(svc, ME, `${ME}/c1/content/x.json`, 'public-bucket')), 'storage_path_not_owned', writer);
      eq(writes(calls).length, 0, `${writer}: escrituras`);
    });
  }

  for (const [writer, call] of Object.entries(WRITERS)) {
    if (writer === 'create') continue; // create() no escribe en Storage (lo hace el frontend con RLS)
    await check(`PW2 ${writer}: ${VALID.length} rutas legítimas de V1 y V2 → 1 escritura en la URL esperada`, async () => {
      for (const [label, p] of VALID) {
        const { svc, calls } = env();
        eq(await code(() => call(svc, ME, p)), 'OK', `${writer} / ${label}`);
        const w = writes(calls);
        eq(w.length, 1, `${writer} / ${label}: escrituras`);
        const expected = `https://fake.supabase.local/storage/v1/object/${BUCKET}/${p.split('/').map(encodeURIComponent).join('/')}`;
        eq(w[0].url, expected, `${writer} / ${label}: URL`);
      }
    });
  }
  await check(`PW2 create: ${VALID.length} rutas legítimas → fila registrada con la ruta tal cual`, async () => {
    for (const [label, p] of VALID) {
      const { svc, rows } = env();
      eq(await code(() => WRITERS.create(svc, ME, p)), 'OK', label);
      eq([...rows.values()][0].storagePath, p, `${label}: storagePath`);
    }
  });

  await check('PW3 putStorageObject sin ownerId (llamador sin actualizar) → 403 sin escribir', async () => {
    const { svc, calls } = env();
    eq(await code(() => svc.putStorageObject({ storagePath: `${ME}/c1/x.json`, buffer: Buffer.from('x'), mimeType: 'application/json' })), 'storage_path_not_owned', 'sin ownerId');
    eq(writes(calls).length, 0, 'escrituras');
  });
  await check('PW3 assertWritableStoragePath exportada: misma decisión que las 4 vías', async () => {
    eq(await code(() => assertWritableStoragePath(ME, BUCKET, `${ME}/c1/x.json`)), 'OK', 'propia');
    eq(await code(() => assertWritableStoragePath(ME, BUCKET, `${OTHER}/c1/x.json`)), 'storage_path_not_owned', 'ajena');
    eq(await code(() => assertWritableStoragePath(ME, BUCKET, 'mock/presentation/c1/x.pdf')), 'storage_path_not_owned', 'mock no se escribe');
  });

  await check('PW4 lectura sin cambios: getDownloadUrl firma la ruta propia y los fixtures mock/… (solo lectura)', async () => {
    const { svc, rows } = env();
    for (const p of [`${ME}/c1/content/x.json`, 'mock/presentation/c1/cap1_presentacion.pdf']) {
      const id = `bbbbbbbb-bbbb-4bbb-8bbb-${String(rows.size + 1).padStart(12, '0')}`;
      rows.set(id, { id, ownerId: ME, type: 'test', storageProvider: 'supabase', storageBucket: BUCKET, storagePath: p, metadata: {} });
      const r = await svc.getDownloadUrl(id, ME);
      eq(r.storagePath, p, `firma ${p}`);
    }
  });

  console.log(`\n${passes} ✅  /  ${failures} ❌`);
  process.exit(failures ? 1 : 0);
})();
