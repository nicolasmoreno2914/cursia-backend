#!/usr/bin/env node
/* eslint-disable no-console */
// Hotfix de seguridad — autorización de artifacts (POST /artifacts → download-url / DELETE).
//
// Antes: POST /artifacts aceptaba cualquier storage_path/storage_bucket; luego download-url lo firmaba y DELETE lo
// borraba con la service role (que ignora RLS) → un usuario que conociera la ruta de otro podía leer o borrar sus
// archivos. Esta suite usa el CONTROLADOR y el SERVICIO reales (dist/) con un repositorio y un Storage falsos:
// sin red, sin base de datos, sin Supabase.
//
//   Z1 A registra, descarga y borra SUS artifacts (el objeto propio se borra)
//   Z2 A no puede registrar la ruta de B (403) ni hay llamada a Storage
//   Z3 A no puede descargar ni borrar artifacts de B por id (404, como siempre) y Storage no se toca
//   Z4 una fila de A que apunte a la ruta de B (registrada antes del fix) no se firma (403) y su DELETE no borra el
//      objeto de B
//   Z5 simétrico: B tampoco accede a lo de A
//   Z6 administrador (SUPER_ADMIN): mismo comportamiento autorizado que antes — lo suyo sí, lo ajeno no (la API de
//      artifacts nunca dio acceso entre cuentas a un admin)
//   Z7 rutas inválidas / no autorizadas → 403 storage_path_not_owned; bucket ajeno → 403
//   Z8 ninguna variante de ruta salta el control (.., %2e, \, //, ./, ?, #, mayúsculas, espacios, control, absoluta…)
//   Z9 las rutas legítimas de producción siguen funcionando (frontend y workers, con espacios y tildes en el nombre)
//   Z10 vida de la URL firmada acotada (1 min – 7 días)
//
// Uso: npm run build && node scripts/check-artifacts-authz.js [path/to/dist]
'use strict';
const path = require('path');

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const { ArtifactsService, storagePathOwnedBy, clampSignedUrlSeconds } = require(path.join(distRoot, 'modules/artifacts/artifacts.service.js'));
const { ArtifactsController } = require(path.join(distRoot, 'modules/artifacts/artifacts.controller.js'));
require('@nestjs/common').Logger.overrideLogger(false);

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };

const A = { id: '11111111-1111-4111-8111-111111111111', email: 'docente-a@example.com' };
const B = { id: '22222222-2222-4222-8222-222222222222', email: 'docente-b@example.com' };
const ADMIN = { id: '33333333-3333-4333-8333-333333333333', email: 'admin@example.com' };

function env() {
  const rows = new Map();
  let n = 0;
  const storage = [];
  const repo = {
    create: (x) => ({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, '0')}`, ...x }),
    save: async (x) => { rows.set(x.id, { ...x }); return x; },
    findOne: async ({ where }) => { const r = rows.get(where.id); return r && r.ownerId === where.ownerId ? { ...r } : null; },
    remove: async (x) => { rows.delete(x.id); return x; },
  };
  const config = { get: (k) => ({ SUPABASE_URL: 'https://fake.supabase.local', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role' }[k]) };
  global.fetch = async (url, init) => {
    storage.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
    return { ok: true, json: async () => ({ signedURL: '/object/sign/x?token=t' }), text: async () => '' };
  };
  const svc = new ArtifactsService(repo, config);
  return { svc, ctl: new ArtifactsController(svc), rows, storage };
}
const dto = (p, extra = {}) => ({ type: 'content_snapshot', storage_path: p, ...extra });
/** Resultado HTTP de una llamada al controlador: código + code de negocio (o 'OK'). */
async function http(fn) {
  try {
    const r = await fn();
    return { status: 200, data: r };
  } catch (e) {
    const status = typeof e.getStatus === 'function' ? e.getStatus() : 500;
    const body = typeof e.getResponse === 'function' ? e.getResponse() : null;
    return { status, code: body && body.code };
  }
}
const own = (u, file = 'content/content_snapshot_1.json') => `${u.id}/c0ffee00-0000-4000-8000-000000000001/${file}`;

(async () => {
  await check('Z1 A registra, descarga y borra SUS artifacts (el objeto propio se borra)', async () => {
    const { ctl, storage } = env();
    const c = await http(() => ctl.create(dto(own(A)), A));
    eq(c.status, 200, 'registrar lo propio');
    const id = c.data.data.id;
    const d = await http(() => ctl.getDownloadUrl(id, A, '3600'));
    assert(d.status === 200 && d.data.data.method === 'backend' && /\/storage\/v1\/object\/sign\/x/.test(d.data.data.url), 'descarga firmada');
    assert(storage[0].url.endsWith(`/object/sign/cursia-artifacts/${own(A)}`), 'firma SU ruta');
    eq((await http(() => ctl.remove(id, A))).status, 200, 'borrar lo propio');
    eq(storage.filter((x) => x.method === 'DELETE').map((x) => x.url.endsWith(`/object/cursia-artifacts/${own(A)}`)), [true], 'se borra su objeto');
  });

  await check('Z2 A NO puede registrar la ruta de B (403) y Storage no se toca', async () => {
    const { ctl, rows, storage } = env();
    const r = await http(() => ctl.create(dto(own(B, 'package/curso_final.mbz')), A));
    eq([r.status, r.code, rows.size, storage.length], [403, 'storage_path_not_owned', 0, 0], 'ruta de B rechazada');
  });

  await check('Z3 A NO puede descargar ni borrar artifacts de B por id (404) y Storage no se toca', async () => {
    const { ctl, rows, storage } = env();
    const idB = (await ctl.create(dto(own(B)), B)).data.id;
    eq((await http(() => ctl.getDownloadUrl(idB, A, '3600'))).status, 404, 'download-url ajeno');
    eq((await http(() => ctl.remove(idB, A))).status, 404, 'DELETE ajeno');
    eq((await http(() => ctl.findOne(idB, A))).status, 404, 'metadata ajena');
    eq([rows.has(idB), storage.length], [true, 0], 'la fila y el objeto de B intactos');
  });

  await check('Z4 una fila de A que apunte a la ruta de B (anterior al fix) no se firma y su DELETE no borra el objeto de B', async () => {
    const { ctl, rows, storage } = env();
    rows.set('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ownerId: A.id, storageProvider: 'supabase', storageBucket: 'cursia-artifacts', storagePath: own(B, 'package/curso_final.mbz') });
    const d = await http(() => ctl.getDownloadUrl('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', A, '3600'));
    eq([d.status, d.code, storage.length], [403, 'storage_path_not_owned', 0], 'no se firma');
    eq((await http(() => ctl.remove('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', A))).status, 200, 'la fila de A se borra');
    eq([rows.has('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), storage.filter((x) => x.method === 'DELETE').length], [false, 0], 'el objeto de B NO se borra');
  });

  await check('Z5 simétrico: B tampoco accede a lo de A', async () => {
    const { ctl, rows, storage } = env();
    const idA = (await ctl.create(dto(own(A)), A)).data.id;
    eq((await http(() => ctl.create(dto(own(A, 'package/x.mbz')), B))).status, 403, 'B no registra la ruta de A');
    eq((await http(() => ctl.getDownloadUrl(idA, B, '3600'))).status, 404, 'B no descarga lo de A');
    eq((await http(() => ctl.remove(idA, B))).status, 404, 'B no borra lo de A');
    eq([rows.has(idA), storage.length], [true, 0], 'lo de A intacto');
  });

  await check('Z6 administrador: lo suyo sí, lo ajeno no (mismo comportamiento autorizado de siempre)', async () => {
    const { ctl, storage } = env();
    const idAdmin = (await ctl.create(dto(own(ADMIN)), ADMIN)).data.id;
    eq((await http(() => ctl.getDownloadUrl(idAdmin, ADMIN, '3600'))).status, 200, 'admin descarga lo suyo');
    const idA = (await ctl.create(dto(own(A)), A)).data.id;
    eq((await http(() => ctl.getDownloadUrl(idA, ADMIN, '3600'))).status, 404, 'admin no descarga lo de A por esta API (como siempre)');
    eq((await http(() => ctl.create(dto(own(A)), ADMIN))).status, 403, 'admin tampoco registra la ruta de A');
    eq((await http(() => ctl.remove(idAdmin, ADMIN))).status, 200, 'admin borra lo suyo');
    eq(storage.filter((x) => x.method === 'DELETE').length, 1, 'solo su objeto');
  });

  await check('Z7 rutas inválidas / no autorizadas → 403 storage_path_not_owned; bucket ajeno → 403', async () => {
    const { ctl, rows } = env();
    const bad = ['', 'x', A.id, `${A.id}/`, `${B.id}/x.json`, 'otro/x.json'];
    for (const p of bad) {
      const r = await http(() => ctl.create(dto(p), A));
      eq([r.status, r.code], [403, 'storage_path_not_owned'], `ruta ${JSON.stringify(p)}`);
    }
    for (const bucket of ['otro-bucket', 'cursia-artifacts-public', '']) {
      eq((await http(() => ctl.create(dto(own(A), { storage_bucket: bucket }), A))).status, 403, `bucket ${JSON.stringify(bucket)}`);
    }
    for (const notString of [null, 42, ['x'], { a: 1 }]) eq(storagePathOwnedBy(A.id, 'cursia-artifacts', notString), false, `no string ${JSON.stringify(notString)}`);
    eq(rows.size, 0, 'nada registrado');
  });

  await check('Z8 ninguna variante de ruta salta el control', async () => {
    const { ctl, rows } = env();
    const variants = [
      `/${A.id}/x`, `${A.id}/../${B.id}/x`, `${A.id}/./../${B.id}/x`, `./${A.id}/x`, `${A.id}/./x`, `${A.id}//x`,
      `${A.id}/%2e%2e/${B.id}/x`, `${A.id}/..%2f${B.id}%2fx`, `${A.id}%2f..%2f${B.id}/x`, `${A.id}\\..\\${B.id}\\x`,
      `${A.id}/x/..`, `${A.id}?/../${B.id}/x`, `${A.id}/x#/../../${B.id}/y`, `${A.id}\u0000/x`, `${A.id}/x\n`,
      ` ${A.id}/x`, `${A.id} /x`, `${A.id.replace('1', 'l')}/x`, `${B.id}/${A.id}/x`,
      `${A.id}`.padEnd(1100, 'x') + '/y', `${A.id}/${'a'.repeat(1100)}`,
    ];
    for (const p of variants) {
      const r = await http(() => ctl.create(dto(p), A));
      eq(r.status, 403, `variante ${JSON.stringify(p.slice(0, 80))}`);
    }
    eq(rows.size, 0, 'ninguna variante registrada');
    // Mayúsculas: el uid del JWT es el UUID en minúsculas; otra capitalización es OTRA carpeta.
    const lower = 'abcdef12-3456-4abc-8def-0123456789ab';
    eq([storagePathOwnedBy(lower, 'cursia-artifacts', `${lower.toUpperCase()}/x`), storagePathOwnedBy(lower, 'cursia-artifacts', `${lower}/x`)], [false, true], 'mayúsculas no equivalen');
  });

  await check('Z9 las rutas legítimas de producción siguen funcionando (frontend y workers)', async () => {
    const { svc, ctl } = env();
    const legit = [
      `${A.id}/c0ffee00-0000-4000-8000-000000000001/content/content_snapshot_1759700000000.json`, // frontend artifactUpload
      `${A.id}/unknown/brandkit/logo_marca.png`,                                                 // curso aún sin id
      `${A.id}/c0ffee00-0000-4000-8000-000000000001/media/audiobook_1759700000000.mp3`,          // 35-tts-audio
      `${A.id}/1234/package/Seguridad y Salud en el Trabajo — Módulo 1_final_1759700000000.mbz`, // package-worker
      `${A.id}/1234/gamma/cap3_portada.png`, `${A.id}/1234/videos/video_state_snapshot_backend_x_1.json`,
    ];
    for (const p of legit) eq((await http(() => ctl.create(dto(p), A))).status, 200, `legítima ${p.slice(37)}`);
    const r = await svc.uploadJsonArtifact({ ownerId: A.id, type: 'gamma_snapshot', filename: 'gamma_snapshot_1234.json', storagePath: `${A.id}/1234/gamma/gamma_snapshot_1234.json`, payload: { ok: true } });
    assert(r && r.ownerId === A.id, 'el worker registra su upload');
    let err = null;
    try { await svc.uploadBufferArtifact({ ownerId: A.id, type: 'x', filename: 'x.mbz', storagePath: `${B.id}/1/package/x.mbz`, buffer: Buffer.from('x'), mimeType: 'application/zip' }); } catch (e) { err = e; }
    assert(err && err.getStatus && err.getStatus() === 403, 'un worker con una ruta ajena también se frena');
  });

  await check('Z10 vida de la URL firmada acotada (1 min – 7 días)', async () => {
    const { ctl, storage } = env();
    const id = (await ctl.create(dto(own(A)), A)).data.id;
    await ctl.getDownloadUrl(id, A, String(10 * 365 * 24 * 3600));
    eq(JSON.parse(storage[0].body).expiresIn, 7 * 24 * 3600, 'tope 7 días');
    eq([clampSignedUrlSeconds(5), clampSignedUrlSeconds(NaN), clampSignedUrlSeconds(3600)], [60, 3600, 3600], 'mínimo 1 min; inválido → 1 h');
  });

  console.log(`\n${passes} OK, ${failures} fallidas`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
