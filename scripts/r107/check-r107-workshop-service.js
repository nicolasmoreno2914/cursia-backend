#!/usr/bin/env node
/* eslint-disable */
// r107 B1 · Taller de cursos — migración + servicio de sesiones contra el código COMPILADO (dist/). USD 0: Postgres 16
// local DESCARTABLE (PG_BIN) + Storage FALSO en memoria (sin red) + catálogo sembrado. Local (como check-r81-*-service):
// CI corre la parte pura (check-r107-identify.js --ci).
//
//   W1  migración aditiva e idempotente (dos veces, con roles de Supabase): RLS, sin acceso para anon/authenticated;
//       el script se niega sin MIGRATION_ENV=staging
//   W2  crear sesión: ruta en la carpeta del dueño, URL firmada; nombre inválido / > 300 MB → 400
//   W3  cerrar la subida: sin objeto → 409; con objeto → 202 `identifying` → `identified` (sha1, tamaño, contenedor,
//       familia, builder, huella → curso del dueño) + artifact `workshop_original` con sha256; re-POST idempotente (no
//       duplica el artifact)
//   W4  permisos: otro usuario → 404 (GET y POST); SuperAdmin → ve; miembro de la institución SOLO con RBAC enforce
//   W5  nunca cruza cuentas: un curso de otra cuenta con la MISMA huella no se identifica
//   W6  paquete hostil (`../evil`) → failed con motivo, no reintentable; paquete que no es .mbz → failed
//   W7  identificación interrumpida (proceso reiniciado) → GET la marca fallida reintentable; el POST la reintenta
//   W8  Storage caído al descargar → failed reintentable (nunca identified); sin la tabla → 503 COURSE_WORKSHOP_NOT_MIGRATED
//   W9  guard del flag: apagado / fuera de la lista → 404; lista inválida → 500
//
// Uso: node scripts/r107/check-r107-workshop-service.js [--dist dist]
'use strict';
require('reflect-metadata');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ai = process.argv.indexOf('--dist');
const DIST = path.resolve(ai > 0 ? process.argv[ai + 1] : path.join(REPO, 'dist'));
const D = (rel) => { try { return require(path.join(DIST, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿npm run build?): ${e.message}`); process.exit(1); } };
let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n   ')}`); }
}
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
async function rejects(p, status, code, m) {
  try { await p; } catch (err) {
    const st = err && err.getStatus ? err.getStatus() : null;
    const body = err && err.getResponse ? err.getResponse() : null;
    assert(st === status, `${m || ''}: status ${st} (esperado ${status}) — ${err && err.message}`);
    if (code) assert(body && body.code === code, `${m || ''}: code ${body && body.code} (esperado ${code})`);
    return body;
  }
  throw new Error(`${m || ''}: se esperaba un error ${status}${code ? ` ${code}` : ''}`);
}
function findPgBin() {
  for (const d of [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean)) {
    const pg = path.join(d, 'postgres');
    if (!fs.existsSync(pg)) continue;
    if (/\b16\./.test(spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '')) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const cleanEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' });
const sha = (a, b) => crypto.createHash(a).update(b).digest('hex');

function rawZip(entries) {
  const locals = []; const centrals = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name); const data = e.data;
    const crc = zlib.crc32 ? zlib.crc32(data) >>> 0 : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, data); centrals.push(ch, name); off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

(async () => {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const SVC = D('modules/course-workshop/course-workshop.service.js');
  const GUARD = D('modules/course-workshop/course-workshop-flag.guard.js');
  const ART = D('modules/artifacts/artifacts.service.js');

  // Fixture real y determinista: el sintético v3 «1x1-sin-examenes» (motor de la simulación comercial, sin red).
  const S = require(path.join(REPO, 'scripts/lib/commercial-simulation'));
  const COURSES = require(path.join(REPO, 'scripts/fixtures/commercial-simulation/courses.json')).courses;
  const sim = await S.simulateCourse(DIST, COURSES.find((c) => c.id === '1x1-sin-examenes'));
  const MBZ = sim.built.mbz;
  const MBZ_SHA256 = sha('sha256', MBZ);

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r107-pg16-'));
  const DB = 'r107db';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const ENV_KEYS = ['SUPER_ADMIN_EMAILS', 'CURSIA_RBAC_MODE', 'COURSE_WORKSHOP', 'COURSE_WORKSHOP_ALLOWED_OWNERS', 'COURSE_WORKSHOP_ALL_OWNERS'];
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  let started = false;
  let ds = null;
  let ds2 = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`  Postgres ${pgBin} en 127.0.0.1:${port}`);
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create database r107empty`); });
    const SQL = fs.readFileSync(path.join(REPO, 'supabase-migration-r107-workshop-sessions.sql'), 'utf8');
    // Tablas existentes mínimas (forma de staging: courses.id serial, artifacts.owner_id uuid, course_id text).
    const BASE = `
      create role anon nologin; create role authenticated nologin;
      create table public.courses (id serial primary key, owner_id varchar(36), institution_id uuid, title varchar(255) not null, metadata jsonb);
      create table public.artifacts (id uuid primary key default gen_random_uuid(), owner_id uuid not null, course_id text, job_id uuid, type text not null,
        storage_provider varchar(50) default 'supabase', storage_bucket text default 'cursia-artifacts', storage_path text not null, filename text,
        mime_type text, size_bytes bigint, checksum_sha256 text, metadata jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now());`;

    await check('W1 migración aditiva e idempotente (dos veces, con roles de Supabase); RLS; el script se niega sin MIGRATION_ENV=staging', async () => {
      await withClient(DB, async (c) => {
        await c.query(BASE);
        const colsOf = async () => (await c.query(`select table_name, column_name, data_type from information_schema.columns where table_name in ('courses','artifacts') order by 1, 2`)).rows;
        const before = await colsOf();
        await c.query(SQL);
        await c.query(SQL);
        const t = await c.query(`select relrowsecurity from pg_class where relname = 'workshop_sessions'`);
        eq(t.rows.map((x) => x.relrowsecurity), [true], 'RLS');
        const g = await c.query(`select has_table_privilege('authenticated', 'public.workshop_sessions', 'select') a, has_table_privilege('anon', 'public.workshop_sessions', 'insert') b`);
        eq([g.rows[0].a, g.rows[0].b], [false, false], 'sin acceso para anon/authenticated');
        const cols = await c.query(`select column_name from information_schema.columns where table_name = 'workshop_sessions' order by ordinal_position`);
        eq(cols.rows.map((x) => x.column_name), ['id', 'owner_id', 'institution_id', 'status', 'original_artifact_id', 'storage_path', 'original_sha1', 'original_size', 'container', 'family', 'identified_course_id', 'identification', 'builder_version', 'error', 'created_at', 'updated_at'], 'columnas');
        eq(await colsOf(), before, 'courses / artifacts intactas');
        let bad = null;
        try { await c.query(`insert into public.workshop_sessions (owner_id, storage_path, status) values (gen_random_uuid(), 'x', 'ready')`); } catch (e) { bad = e.code; }
        eq(bad, '23514', 'CHECK de status');
      });
      const res = spawnSync(process.execPath, [path.join(REPO, 'scripts/migrate-r107-workshop-sessions.js')], { env: { ...cleanEnv(), DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'postgres', DB_NAME: DB }, encoding: 'utf8', cwd: os.tmpdir() });
      assert(res.status !== 0 && /MIGRATION_ENV/.test(res.stderr), `debió negarse: ${res.status} ${res.stderr}`);
    });

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [], synchronize: false });
    await ds.initialize();
    const OWNER = { id: '11111111-2222-4333-8444-555555555555', email: 'docente@ejemplo.edu' };
    const OTHER = { id: '99999999-8888-4777-8666-555555555555', email: 'otra@ejemplo.edu' };
    const MEMBER = { id: '77777777-8888-4777-8666-555555555555', email: 'miembro@ejemplo.edu' };
    const ADMIN = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'owner@cursia.test' };
    const INST = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const INST2 = 'cccccccc-dddd-4eee-8fff-000000000000';
    process.env.SUPER_ADMIN_EMAILS = ADMIN.email;

    // Storage falso en memoria + create() de artifacts con el MISMO control de carpeta del servicio real.
    const objects = new Map();
    const storage = {
      down: false,
      signed: [],
      async createSignedUploadUrl(ownerId, bucket, p) { ART.assertWritableStoragePath(ownerId, bucket, p); this.signed.push(p); return { method: 'backend', url: `http://storage.local/upload/${p}?token=t`, token: 't', storagePath: p, bucket }; },
      async headStorageObjectBytes(bucket, p) { return objects.has(p) ? objects.get(p).length : null; },
      async downloadStorageObject(bucket, p) {
        if (this.down) { const { StorageUnavailableError } = D('modules/artifacts/storage-resilience.js'); throw new StorageUnavailableError('download', 'simulado'); }
        if (!objects.has(p)) throw new Error('404');
        return objects.get(p);
      },
      // Mismo lector con tope que el servicio real (ART.readBodyCapped) sobre una respuesta HTTP en memoria.
      downloads: 0,
      async downloadStorageObjectCapped(bucket, p, opts) {
        this.downloads++;
        if (this.down) { const { StorageUnavailableError } = D('modules/artifacts/storage-resilience.js'); throw new StorageUnavailableError('download', 'simulado'); }
        if (!objects.has(p)) throw new Error('404');
        const b = objects.get(p);
        const body = new ReadableStream({ start(c) { for (let i = 0; i < b.length; i += 1 << 20) c.enqueue(new Uint8Array(b.buffer, b.byteOffset + i, Math.min(1 << 20, b.length - i))); c.close(); } });
        return ART.readBodyCapped(new Response(body), opts.maxBytes, () => { this.aborted = (this.aborted || 0) + 1; }, opts.onChunk);
      },
      async create(dto, ownerId) {
        ART.assertWritableStoragePath(ownerId, dto.storage_bucket ?? 'cursia-artifacts', dto.storage_path);
        const [row] = await ds.query(`insert into public.artifacts (owner_id, course_id, type, storage_path, storage_bucket, filename, mime_type, size_bytes, checksum_sha256, metadata)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) returning id::text as id`, [ownerId, dto.course_id ?? null, dto.type, dto.storage_path, dto.storage_bucket, dto.filename, dto.mime_type, dto.size_bytes, dto.checksum_sha256, JSON.stringify(dto.metadata ?? {})]);
        return { id: row.id };
      },
    };
    // Permisos falsos (forma de PermissionService): OWNER y MEMBER son miembros activos de INST con courses.view/edit.
    const permissions = {
      async can(actor, perm, inst) { return (actor.id === MEMBER.id && inst === INST) || (actor.id === OWNER.id && (inst === INST || inst === INST2)) ? { allowed: true, via: 'role', permission: perm, institutionId: inst, role: 'CREADOR' } : { allowed: false, code: 'resource_not_found', httpStatus: 404, permission: perm, institutionId: inst, reason: 'x' }; },
      async membershipsOf(id) { return id === OWNER.id ? [{ institutionId: INST, status: 'active' }, { institutionId: INST2, status: 'active' }] : id === MEMBER.id ? [{ institutionId: INST, status: 'active' }] : []; },
    };
    const svc = new SVC.CourseWorkshopService(ds, storage, permissions);
    const settle = async (id) => { const p = svc.inFlight.get(id); if (p) await p; };

    // Catálogo: el curso del dueño con un mbz_final de la MISMA huella; y uno de OTRA cuenta también con la misma huella.
    const [own] = await ds.query(`insert into public.courses (owner_id, title, metadata) values ($1, 'Curso propio', '{"courseId":"fe-uuid-1"}') returning id`, [OWNER.id]);
    const [foreign] = await ds.query(`insert into public.courses (owner_id, title) values ($1, $2) returning id`, [OTHER.id, sim.built.expectations?.courseTitle || 'otro']);
    await ds.query(`insert into public.artifacts (owner_id, course_id, type, storage_path, checksum_sha256, size_bytes, metadata) values ($1, 'fe-uuid-1', 'mbz_final', $2, $3, $4, '{"builderVersion":"3.19.0"}')`, [OWNER.id, `${OWNER.id}/fe-uuid-1/package/a.mbz`, MBZ_SHA256, MBZ.length]);
    await ds.query(`insert into public.artifacts (owner_id, course_id, type, storage_path, checksum_sha256, size_bytes) values ($1, $2, 'dynamic_mbz', $3, $4, $5)`, [OTHER.id, String(foreign.id), `${OTHER.id}/dynamic/x.mbz`, MBZ_SHA256, MBZ.length]);

    let s1;
    await check('W2 crear sesión: ruta en la carpeta del dueño + URL firmada; nombre inválido / > 300 MB → 400', async () => {
      const res = await svc.createSession(OWNER, { filename: 'C:\\x\\Mi curso.mbz', sizeBytes: MBZ.length });
      s1 = res.session;
      eq([s1.status, s1.phase, s1.filename, s1.institutionId], ['uploaded', 'awaiting_upload', 'Mi curso.mbz', null], 'sesión (RBAC off: sin institución)');
      eq(res.upload.storagePath, SVC.workshopStoragePath(OWNER.id, s1.id), 'ruta');
      eq([res.upload.method, res.upload.maxBytes], ['backend', 300 * 1024 * 1024], 'upload');
      await rejects(svc.createSession(OWNER, { filename: 'curso.zip', sizeBytes: 10 }), 400, 'WORKSHOP_FILENAME_INVALID', 'extensión');
      await rejects(svc.createSession(OWNER, { filename: 'c.mbz', sizeBytes: 300 * 1024 * 1024 + 1 }), 400, 'WORKSHOP_FILE_TOO_LARGE', 'tope');
    });

    await check('W3 cerrar la subida: sin objeto → 409; con objeto → identifying → identified (huella → curso propio) + workshop_original; idempotente', async () => {
      await rejects(svc.markUploaded(OWNER, s1.id), 409, 'WORKSHOP_UPLOAD_NOT_FOUND', 'sin objeto');
      objects.set(SVC.workshopStoragePath(OWNER.id, s1.id), MBZ);
      const a = await svc.markUploaded(OWNER, s1.id);
      eq([a.status, a.phase], ['identifying', 'identifying'], '202');
      await settle(s1.id);
      const g = await svc.get(OWNER, s1.id);
      eq([g.status, g.originalSha1, g.originalSize, g.container, g.family, g.identifiedCourseId, g.builderVersion, g.error],
        ['identified', sha('sha1', MBZ), MBZ.length, 'zip', 'v2-dynamic', Number(own.id), '3.19.0', null], 'identificada');
      eq([g.identification.method, g.identification.confidence, g.identification.builder.line], ['package_hash', 'exact', 'v3'], 'método');
      const arts = await ds.query(`select type, checksum_sha256, size_bytes::int s, metadata->>'workshopSessionId' sid, course_id from public.artifacts where type = 'workshop_original'`);
      eq(arts, [{ type: 'workshop_original', checksum_sha256: MBZ_SHA256, s: MBZ.length, sid: s1.id, course_id: null }], 'artifact original');
      eq(g.originalArtifactId !== null, true, 'enlazado');
      const again = await svc.markUploaded(OWNER, s1.id);
      eq(again.status, 'identified', 'idempotente');
      eq((await ds.query(`select count(*)::int n from public.artifacts where type = 'workshop_original'`))[0].n, 1, 'sin duplicar');
    });

    await check('W4 permisos: otro usuario → 404; SuperAdmin → ve; miembro de la institución solo con RBAC enforce', async () => {
      await rejects(svc.get(OTHER, s1.id), 404, null, 'ajeno GET');
      await rejects(svc.markUploaded(OTHER, s1.id), 404, null, 'ajeno POST');
      await rejects(svc.get(OWNER, 'no-uuid'), 404, null, 'id inválido');
      eq((await svc.get(ADMIN, s1.id)).status, 'identified', 'SA');
      // Sesión de institución: solo existe con RBAC enforce (en off no se asigna institución).
      process.env.CURSIA_RBAC_MODE = 'enforce';
      let res;
      try {
        eq((await svc.createSession(OWNER, { filename: 'p.mbz', sizeBytes: 100 })).session.institutionId, null, 'dos membresías sin header → sesión personal');
        res = await svc.createSession(OWNER, { filename: 'inst.mbz', sizeBytes: 100 }, INST);
        eq(res.session.institutionId, INST, 'institución del header (verificada)');
        eq((await svc.createSession(MEMBER, { filename: 'm.mbz', sizeBytes: 100 })).session.institutionId, INST, 'única membresía');
        eq((await svc.get(MEMBER, res.session.id)).id, res.session.id, 'miembro con permiso');
        await rejects(svc.get(OTHER, res.session.id), 404, null, 'no miembro');
        await rejects(svc.createSession(OTHER, { filename: 'x.mbz', sizeBytes: 10 }, INST), 403, null, 'header de una institución ajena');
        eq((await svc.createSession(OTHER, { filename: 'x.mbz', sizeBytes: 10 })).session.institutionId, null, 'sin membresía → sesión solo del dueño');
      } finally {
        process.env.CURSIA_RBAC_MODE = 'off';
      }
      await rejects(svc.get(MEMBER, res.session.id), 404, null, 'RBAC off: solo el dueño');
    });

    await check('W5 nunca cruza cuentas: la misma huella en un curso de OTRA cuenta no identifica nada', async () => {
      const res = await svc.createSession(ADMIN, { filename: 'a.mbz', sizeBytes: MBZ.length });
      objects.set(res.upload.storagePath, MBZ);
      await svc.markUploaded(ADMIN, res.session.id);
      await settle(res.session.id);
      const g = await svc.get(ADMIN, res.session.id);
      eq(g.status, 'identified', 'estado');
      assert(g.identifiedCourseId !== Number(own.id) && g.identifiedCourseId !== Number(foreign.id), `identificó un curso ajeno: ${g.identifiedCourseId}`);
      assert(!g.identification.candidates.some((c) => c.courseId === Number(own.id) || c.courseId === Number(foreign.id)), 'candidato ajeno');
      eq([g.identification.method, g.identifiedCourseId], ['none', null], 'solo el paquete');
    });

    await check('W6 hostil (../evil) y no-.mbz → failed con motivo, no reintentable (el POST no lo reintenta)', async () => {
      for (const [buf, code] of [[rawZip([{ name: 'moodle_backup.xml', data: Buffer.from('<moodle_backup><information></information></moodle_backup>') }, { name: '../evil', data: Buffer.from('x') }]), 'WORKSHOP_UNSAFE_PATH'],
        [Buffer.from('%PDF-1.7 hola'), 'WORKSHOP_NOT_MBZ'],
        [rawZip([{ name: 'otra.txt', data: Buffer.from('x') }]), 'WORKSHOP_MISSING_MOODLE_BACKUP']]) {
        const res = await svc.createSession(OWNER, { filename: 'h.mbz', sizeBytes: buf.length });
        objects.set(res.upload.storagePath, buf);
        await svc.markUploaded(OWNER, res.session.id);
        await settle(res.session.id);
        const g = await svc.get(OWNER, res.session.id);
        eq([g.status, g.error && g.error.code, g.error && g.error.retryable, g.identifiedCourseId, g.originalArtifactId], ['failed', code, false, null, null], code);
        assert(g.error.message.length > 10 && !/\bat \w/.test(g.error.message), 'mensaje claro');
        eq((await svc.markUploaded(OWNER, res.session.id)).status, 'failed', 'no se reintenta');
      }
    });

    await check('W7 identificación interrumpida → GET la marca fallida reintentable; el POST la reintenta hasta identified', async () => {
      const res = await svc.createSession(OWNER, { filename: 'r.mbz', sizeBytes: MBZ.length });
      objects.set(res.upload.storagePath, MBZ);
      await ds.query(`update public.workshop_sessions set status = 'identifying', updated_at = now() - interval '20 minutes' where id = $1`, [res.session.id]);
      const g = await svc.get(OWNER, res.session.id);
      eq([g.status, g.error.code, g.error.retryable], ['failed', 'WORKSHOP_IDENTIFICATION_INTERRUPTED', true], 'interrumpida');
      await svc.markUploaded(OWNER, res.session.id);
      await settle(res.session.id);
      eq((await svc.get(OWNER, res.session.id)).status, 'identified', 'reintento');
    });

    await check('W8 Storage caído → failed reintentable (nunca identified); sin la tabla → 503 COURSE_WORKSHOP_NOT_MIGRATED', async () => {
      const res = await svc.createSession(OWNER, { filename: 's.mbz', sizeBytes: MBZ.length });
      objects.set(res.upload.storagePath, MBZ);
      storage.down = true;
      await svc.markUploaded(OWNER, res.session.id);
      await settle(res.session.id);
      storage.down = false;
      const g = await svc.get(OWNER, res.session.id);
      eq([g.status, g.error.code, g.error.retryable], ['failed', 'WORKSHOP_STORAGE_UNAVAILABLE', true], 'Storage caído');
      await svc.markUploaded(OWNER, res.session.id);
      await settle(res.session.id);
      eq((await svc.get(OWNER, res.session.id)).status, 'identified', 'reintento tras volver Storage');
      ds2 = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: 'r107empty', entities: [], synchronize: false });
      await ds2.initialize();
      const svc2 = new SVC.CourseWorkshopService(ds2, storage, permissions);
      await rejects(svc2.createSession(OWNER, { filename: 'x.mbz', sizeBytes: 10 }), 503, 'COURSE_WORKSHOP_NOT_MIGRATED', 'sin migrar');
    });

    await check('W10 fix P1-1: el objeto se reemplaza entre el HEAD y la descarga — más grande que 300 MB → abort + failed (no reintentable); distinto tamaño → reintentable', async () => {
      const res = await svc.createSession(OWNER, { filename: 't.mbz', sizeBytes: MBZ.length });
      objects.set(res.upload.storagePath, MBZ);
      await svc.markUploaded(OWNER, res.session.id); // HEAD ve el chico
      objects.set(res.upload.storagePath, Buffer.alloc(SVC.WORKSHOP_MAX_UPLOAD_BYTES + 2 * 1024 * 1024)); // TOCTOU
      const ab0 = storage.aborted || 0;
      await settle(res.session.id);
      let g = await svc.get(OWNER, res.session.id);
      eq([g.status, g.error.code, g.error.retryable, g.originalArtifactId], ['failed', 'WORKSHOP_FILE_TOO_LARGE', false, null], 'grande');
      eq((storage.aborted || 0) - ab0, 1, 'la descarga se abortó en el tope');
      const r2 = await svc.createSession(OWNER, { filename: 't2.mbz', sizeBytes: MBZ.length });
      objects.set(r2.upload.storagePath, MBZ);
      await svc.markUploaded(OWNER, r2.session.id);
      objects.set(r2.upload.storagePath, MBZ.subarray(0, MBZ.length - 100));
      await settle(r2.session.id);
      g = await svc.get(OWNER, r2.session.id);
      eq([g.status, g.error.code, g.error.retryable], ['failed', 'WORKSHOP_UPLOAD_CHANGED', true], 'cambió de tamaño');
      objects.set(r2.upload.storagePath, MBZ);
      await svc.markUploaded(OWNER, r2.session.id);
      await settle(r2.session.id);
      eq((await svc.get(OWNER, r2.session.id)).status, 'identified', 'reintento con el archivo estable');
    });

    await check('W11 fix P1-2: dueño en las instituciones X e Y; sesión de X → solo cursos de X (ni Y ni personales); el miembro de X no ve nada de fuera', async () => {
      process.env.CURSIA_RBAC_MODE = 'enforce';
      try {
        // El dueño tiene el MISMO paquete registrado en un curso de Y y en uno personal; un miembro de X, en un curso de X.
        const [cy] = await ds.query(`insert into public.courses (owner_id, institution_id, title) values ($1, $2, 'Curso de Y') returning id`, [OWNER.id, INST2]);
        await ds.query(`insert into public.artifacts (owner_id, course_id, type, storage_path, checksum_sha256, size_bytes) values ($1, $2, 'dynamic_mbz', $3, $4, $5)`, [OWNER.id, String(cy.id), `${OWNER.id}/dynamic/y.mbz`, MBZ_SHA256, MBZ.length]);
        let res = await svc.createSession(OWNER, { filename: 'x.mbz', sizeBytes: MBZ.length }, INST);
        objects.set(res.upload.storagePath, MBZ);
        await svc.markUploaded(OWNER, res.session.id);
        await settle(res.session.id);
        let g = await svc.get(MEMBER, res.session.id);
        const leak = (r) => [Number(cy.id), Number(own.id)].filter((id) => r.identifiedCourseId === id || r.identification.candidates.some((c) => c.courseId === id) || JSON.stringify(r).includes('Curso de Y') || JSON.stringify(r).includes('Curso propio'));
        eq(leak(g), [], 'el miembro de X no ve cursos de Y ni personales');
        eq([g.status, g.identification.method, g.identifiedCourseId], ['identified', 'none', null], 'sin cursos de X: solo el paquete');
        // Ahora un curso de X (de otro miembro) con la misma huella → ese.
        const [cx] = await ds.query(`insert into public.courses (owner_id, institution_id, title) values ($1, $2, 'Curso de X') returning id`, [MEMBER.id, INST]);
        await ds.query(`insert into public.artifacts (owner_id, course_id, type, storage_path, checksum_sha256, size_bytes) values ($1, $2, 'mbz_final', $3, $4, $5)`, [MEMBER.id, String(cx.id), `${MEMBER.id}/x/a.mbz`, MBZ_SHA256, MBZ.length]);
        res = await svc.createSession(OWNER, { filename: 'x2.mbz', sizeBytes: MBZ.length }, INST);
        objects.set(res.upload.storagePath, MBZ);
        await svc.markUploaded(OWNER, res.session.id);
        await settle(res.session.id);
        g = await svc.get(MEMBER, res.session.id);
        eq([g.identification.method, g.identifiedCourseId], ['package_hash', Number(cx.id)], 'curso de X');
        eq(leak(g), [], 'sin fugas');
      } finally {
        process.env.CURSIA_RBAC_MODE = 'off';
      }
    });

    await check('W12 fix P2-6: dos procesos con el mismo reclamo → UN solo workshop_original; un reclamo vencido no escribe nada', async () => {
      const res = await svc.createSession(OWNER, { filename: 'c.mbz', sizeBytes: MBZ.length });
      objects.set(res.upload.storagePath, MBZ);
      const claim = (c) => ds.query(`update public.workshop_sessions set status = 'identifying', error = null,
        identification = jsonb_set(identification, '{claim}', jsonb_build_object('id', $2::text, 'headBytes', $3::bigint)) where id = $1`, [res.session.id, c, MBZ.length]);
      await claim('c1');
      const svcB = new SVC.CourseWorkshopService(ds, storage, permissions); // «otro proceso»
      await Promise.all([svc.runIdentification(res.session.id, 'c1'), svcB.runIdentification(res.session.id, 'c1'), svcB.runIdentification(res.session.id, 'c1')]);
      eq((await ds.query(`select count(*)::int n from public.artifacts where type = 'workshop_original' and storage_path = $1`, [res.upload.storagePath]))[0].n, 1, 'un solo original');
      eq((await svc.get(OWNER, res.session.id)).status, 'identified', 'identificada');
      // Reclamo nuevo (c2) en curso; la ejecución vieja (c1) llega tarde → no toca nada.
      await claim('c2');
      await svcB.runIdentification(res.session.id, 'c1');
      const [row] = await ds.query(`select status, identification->'claim'->>'id' as c from public.workshop_sessions where id = $1`, [res.session.id]);
      eq([row.status, row.c], ['identifying', 'c2'], 'el reclamo vencido no escribió');
      await svc.runIdentification(res.session.id, 'c2');
      eq((await svc.get(OWNER, res.session.id)).status, 'identified', 'el vigente sí');
      eq((await ds.query(`select count(*)::int n from public.artifacts where type = 'workshop_original' and storage_path = $1`, [res.upload.storagePath]))[0].n, 1, 'sigue habiendo uno (idempotente)');
      // Original ya registrado con OTROS bytes → no se reemplaza nunca.
      objects.set(res.upload.storagePath, Buffer.concat([MBZ.subarray(0, 100), Buffer.alloc(MBZ.length - 100)]));
      await claim('c3');
      await svc.runIdentification(res.session.id, 'c3');
      const g = await svc.get(OWNER, res.session.id);
      assert(g.status === 'failed' && g.error && !g.error.retryable, `bytes distintos: ${g.status} ${g.error && g.error.code}`);
    });

    await check('W13 fix P2-7: más cursos que el límite de la heurística → la huella exacta del curso MÁS VIEJO se encuentra igual, y queda dicho que se recortó', async () => {
      const U = 'dddddddd-eeee-4fff-8000-111111111111';
      const [old] = await ds.query(`insert into public.courses (owner_id, title) values ($1, 'El más viejo') returning id`, [U]);
      await ds.query(`insert into public.artifacts (owner_id, course_id, type, storage_path, checksum_sha256, size_bytes) values ($1, $2, 'mbz_final', $3, $4, $5)`, [U, String(old.id), `${U}/old/a.mbz`, MBZ_SHA256, MBZ.length]);
      await ds.query(`insert into public.courses (owner_id, title) select $1, 'Relleno ' || g from generate_series(1, $2::int) g`, [U, SVC.WORKSHOP_CATALOG_LIMITS.courses + 5]);
      const actor = { id: U, email: 'muchos@ejemplo.edu' };
      const res = await svc.createSession(actor, { filename: 'v.mbz', sizeBytes: MBZ.length });
      objects.set(res.upload.storagePath, MBZ);
      await svc.markUploaded(actor, res.session.id);
      await settle(res.session.id);
      const g = await svc.get(actor, res.session.id);
      eq([g.identification.method, g.identifiedCourseId], ['package_hash', Number(old.id)], 'huella exacta fuera de la lista recortada');
      const [row] = await ds.query(`select identification->'catalog' as c from public.workshop_sessions where id = $1`, [res.session.id]);
      eq(row.c.truncated, true, 'recorte registrado');
      assert(g.identification.notes.some((n) => /muchos cursos/.test(n)), 'nota visible del recorte');
    });

    await check('W9 guard del flag: apagado / fuera de la lista → 404; listado → pasa; lista inválida → 500', async () => {
      const g = new GUARD.CourseWorkshopFlagGuard();
      const ctx = (uid) => ({ switchToHttp: () => ({ getRequest: () => ({ method: 'POST', originalUrl: '/api/v1/course-workshop/sessions', user: { id: uid } }) }) });
      const st = (fn) => { try { fn(); return 200; } catch (e) { return e.getStatus ? e.getStatus() : 0; } };
      eq(st(() => g.canActivate(ctx(OWNER.id))), 404, 'apagado');
      process.env.COURSE_WORKSHOP = 'true';
      eq(st(() => g.canActivate(ctx(OWNER.id))), 404, 'lista vacía → nadie');
      process.env.COURSE_WORKSHOP_ALLOWED_OWNERS = OWNER.id;
      eq(st(() => g.canActivate(ctx(OWNER.id))), 200, 'listado');
      eq(st(() => g.canActivate(ctx(OTHER.id))), 404, 'no listado');
      process.env.COURSE_WORKSHOP_ALLOWED_OWNERS = 'basura';
      eq(st(() => g.canActivate(ctx(OWNER.id))), 500, 'lista inválida');
      delete process.env.COURSE_WORKSHOP; delete process.env.COURSE_WORKSHOP_ALLOWED_OWNERS;
    });
  } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (ds) await ds.destroy().catch(() => {});
    if (ds2) await ds2.destroy().catch(() => {});
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(`\n${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
