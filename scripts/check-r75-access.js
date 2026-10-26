#!/usr/bin/env node
/* eslint-disable */
// r75 · Agente A — pruebas del módulo access (instituciones, membresías, usuarios SA, suspensiones, auditoría).
//   [U] unidad (sin base): matriz rol×permiso (deny > grant, globales no otorgables), redacción de secretos, contraseña
//       temporal, clasificación de errores de la Admin API, planificador del backfill.
//   [M] migración contra PG16 DESECHABLE: idempotente (2 corridas + reparación tras borrar un trigger), verify, RLS/REVOKE,
//       authorized_users queda solo con «SELECT propio» (se siembra una política de escritura «maliciosa» antes),
//       append-only de la auditoría, inmutabilidad de suspensiones, guardas de MIGRATION_ENV y del ref de producción.
//   [B] backfill: dry-run sin escrituras + reporte; --apply exige staging; 0 reasignaciones; segundo plan vacío.
//   [H] HTTP real (Nest + filtro + interceptor) con JWT HS256 local y una Admin API de Supabase FALSA en 127.0.0.1:
//       membresías CRUD con rol por institución y multi-institución, anti-escalada, último admin, solo el SA crea
//       usuarios/instituciones, tempPassword una vez + no-store + nunca en logs ni base, suspensiones independientes
//       (cuenta pausa runs y banea; generación no), congelación, /me/context, instituciones según CURSIA_RBAC_MODE.
// Sin red externa (fetch bloqueado salvo 127.0.0.1), USD 0.
// Uso: npm run build && node scripts/check-r75-access.js   (y con E2E_PROD_COLUMN_TYPES=1: tipos legacy de producción)
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
const L = (rel) => { try { return require(path.join(DIST, rel)); } catch (err) { console.error(`❌ No se pudo cargar dist/${rel} (¿npm run build?): ${err.message}`); process.exit(1); } };
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (/^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };

let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }

// ── captura de logs (nada de secretos en ningún log) ─────────────────────────
const captured = [];
const origConsole = { log: console.log, warn: console.warn, error: console.error };
const capLogger = {
  log: (...a) => captured.push(a.map(String).join(' ')), error: (...a) => captured.push(a.map(String).join(' ')),
  warn: (...a) => captured.push(a.map(String).join(' ')), debug: (...a) => captured.push(a.map(String).join(' ')),
  verbose: (...a) => captured.push(a.map(String).join(' ')), fatal: (...a) => captured.push(a.map(String).join(' ')),
};

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
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => ([5570, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port))); });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

// ════════════════════════════════════════════════════════════════════════════
// [U] unidad
// ════════════════════════════════════════════════════════════════════════════
async function unitChecks() {
  const RM = L('modules/access/role-matrix.js');
  const AL = L('modules/access/audit-log.service.js');
  const SA = L('modules/access/supabase-admin.client.js');
  const AS = L('modules/access/access-schema.js');
  const { planBackfill, reportOf } = require('./lib/r75-backfill-plan');

  await check('[U1] matriz por defecto = 01 §2.2 (D-8 admin sin aprobar/generar; D-9 consulta sin descargar)', () => {
    eq(RM.effectivePermissions({ role: 'ADMIN_INSTITUCIONAL' }).includes('proposals.approve'), false, 'admin aprueba');
    eq(RM.effectivePermissions({ role: 'ADMIN_INSTITUCIONAL' }).includes('generations.start'), false, 'admin genera');
    eq(RM.effectivePermissions({ role: 'ADMIN_INSTITUCIONAL' }).includes('roles.manage'), true, 'admin roles');
    eq(RM.effectivePermissions({ role: 'CONSULTA' }), ['courses.view'], 'consulta');
    eq(RM.effectivePermissions({ role: 'APROBADOR_ACADEMICO' }), ['courses.view', 'proposals.review', 'proposals.approve', 'exports.download'], 'aprobador');
    eq(RM.effectivePermissions({ role: 'CREADOR' }).includes('generations.start'), true, 'creador genera');
    for (const r of RM.ROLES) for (const g of ['budgets.manage', 'users.suspend', 'generations.suspend']) assert(!RM.ROLE_MATRIX[r].includes(g), `${r} tiene ${g}`);
  });
  await check('[U2] deny gana a grant y al rol; grants globales (D-7) no tienen efecto; membresía/institución inactiva → []', () => {
    const p = RM.effectivePermissions({ role: 'CREADOR', grants: ['spend.view', 'budgets.manage', 'courses.view'], denies: ['courses.view', 'spend.view'] });
    assert(!p.includes('courses.view') && !p.includes('spend.view') && !p.includes('budgets.manage'), JSON.stringify(p));
    eq(RM.effectivePermissions({ role: 'ADMIN_INSTITUCIONAL', membershipStatus: 'suspended' }), [], 'membresía suspendida');
    eq(RM.effectivePermissions({ role: 'ADMIN_INSTITUCIONAL', institutionStatus: 'archived' }), [], 'institución archivada');
    eq(RM.effectivePermissions({ role: 'SUPERADMIN' }), [], 'rol inexistente');
  });
  await check('[U3] scrubSecrets redacta contraseñas/tokens a cualquier profundidad y no muta la entrada', () => {
    const input = { email: 'a@b.c', tempPassword: 'x', nested: { access_token: 't', list: [{ password: 'p', ok: 1 }] }, apiKey: 'k' };
    const out = AL.scrubSecrets(input);
    const s = JSON.stringify(out);
    assert(!/"x"|"t"|"p"|"k"/.test(s), s);
    eq(out.email, 'a@b.c', 'email');
    eq(input.tempPassword, 'x', 'mutó la entrada');
  });
  await check('[U4] contraseña temporal: 20 caracteres, 4 clases, CSPRNG (sin repetidas en 500)', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      const pw = SA.generateTempPassword(20);
      assert(pw.length === 20 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw) && /[!@#%*\-_]/.test(pw), pw.length + '');
      seen.add(pw);
    }
    eq(seen.size, 500, 'únicas');
  });
  await check('[U5] errores de la Admin API → tipos estables (sin conservar el cuerpo)', () => {
    eq(SA.classifyAdminError(422, { error_code: 'email_exists' }), 'exists', 'exists');
    eq(SA.classifyAdminError(422, { msg: 'A user with this email address has already been registered' }), 'exists', 'exists msg');
    eq(SA.classifyAdminError(400, { error_code: 'email_address_invalid' }), 'invalid_email', 'invalid');
    eq(SA.classifyAdminError(500, {}), 'unavailable', '500');
    eq(SA.classifyAdminError(401, {}), 'unavailable', '401 (service key mala)');
    eq(SA.classifyAdminError(404, {}), 'not_found', '404');
    eq(SA.classifyAdminError(400, { msg: 'otra cosa' }), 'error', 'otro');
  });
  await check('[U6] normEmail', () => {
    eq(AS.normEmail(' Ana@Example.COM '), 'ana@example.com', 'normaliza');
    for (const bad of ['', 'x', 'a@b', 'a b@c.de', null, 3, '<a@b.cd>']) eq(AS.normEmail(bad), null, String(bad));
  });

  const U = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const snap = () => ({
    institutions: [
      { id: 'i1', owner_id: U(1), name: 'Uno', slug: 'uno', kind: 'organization', status: 'active', created_at: '2026-01-01' },
      { id: 'i2a', owner_id: U(2), name: 'Dos A', slug: 'dos-a', kind: 'organization', status: 'active', created_at: '2026-02-01' },
      { id: 'i2b', owner_id: U(2), name: 'Dos B', slug: 'dos-b', kind: 'organization', status: 'active', created_at: '2026-01-15' },
    ],
    memberships: [], overrides: [],
    courses: [
      { id: 1, owner_id: U(1), owner_email: 'uno@x.test', institution_id: null, created_by: null },
      { id: 2, owner_id: U(1), owner_email: 'uno@x.test', institution_id: 'i1', created_by: U(1) },
      { id: 3, owner_id: U(3), owner_email: 'tres@x.test', institution_id: null, created_by: null },
      { id: 4, owner_id: null, owner_email: null, institution_id: null, created_by: null },
      { id: 5, owner_id: 'no-es-uuid', owner_email: null, institution_id: null, created_by: null },
      { id: 6, owner_id: U(3), owner_email: 'tres@x.test', institution_id: 'i1', created_by: null },
      { id: 7, owner_id: U(2), owner_email: 'dos@x.test', institution_id: null, created_by: null },
    ],
    jobOwners: [U(4)],
    authorizedUsers: [{ email: 'cinco@x.test', user_id: null }, { email: 'seis@x.test', user_id: null }],
    authUsers: [{ id: U(5), email: 'cinco@x.test' }, { id: U(1), email: 'uno@x.test' }],
  });
  await check('[U7] backfill: 1 propia → se reutiliza y se marca personal; 0 → espacio personal; >1 → la más antigua + revisión', () => {
    let k = 0;
    const p = planBackfill(snap(), { newId: () => `new-${++k}` });
    const u1 = p.users.find((u) => u.userId === U(1));
    eq([u1.defaultAction, u1.defaultInstitutionId], ['reuse', 'i1'], 'u1');
    assert(p.markPersonal.includes('i1'), 'i1 personal');
    const u2 = p.users.find((u) => u.userId === U(2));
    eq([u2.defaultAction, u2.defaultInstitutionId], ['oldest_of_many', 'i2b'], 'u2 la más antigua');
    assert(p.manualReview.some((m) => m.userId === U(2) && m.reason.includes('más de una')), 'revisión u2');
    const u3 = p.users.find((u) => u.userId === U(3));
    eq(u3.defaultAction, 'create', 'u3');
    const created = p.createInstitutions.find((c) => c.ownerId === U(3));
    eq([created.slug, created.kind, created.name], ['personal-00000003', 'personal', 'Espacio de tres@x.test'], 'espacio');
    assert(p.users.some((u) => u.userId === U(4) && u.sources.includes('production_jobs')), 'u4 por production_jobs');
    assert(p.users.some((u) => u.userId === U(5) && u.sources.includes('authorized_users')), 'u5 por allow-list');
    eq(p.linkAuthorizedUsers.map((l) => l.userId), [U(5)], 'enlace allow-list');
    eq(p.unresolvedAuthorizedUsers.length, 1, 'seis sin usuario de Auth');
  });
  await check('[U8] backfill: membresías ADMIN en toda propia, D-5 en la default, cursos sin reasignar, huérfanos y ids inválidos', () => {
    const p = planBackfill(snap(), { newId: () => crypto.randomUUID() });
    for (const i of ['i1', 'i2a', 'i2b']) assert(p.memberships.some((m) => m.institutionId === i && m.role === 'ADMIN_INSTITUCIONAL'), 'admin ' + i);
    assert(p.memberships.some((m) => m.institutionId === 'i1' && m.userId === U(3) && m.role === 'CREADOR'), 'u3 CREADOR en i1 por su curso 6');
    eq(p.overrides.filter((o) => o.userId === U(1)).map((o) => [o.institutionId, o.permission]), [['i1', 'proposals.approve'], ['i1', 'generations.start']], 'D-5 u1');
    eq(p.attachCourses.map((a) => a.courseId).sort(), [1, 3, 7], 'adjunta solo cursos sin institución con dueño');
    eq(p.attachCourses.find((a) => a.courseId === 7).institutionId, 'i2b', 'curso de u2 → su default');
    assert(!p.attachCourses.some((a) => [2, 6].includes(a.courseId)), 'nunca toca un institution_id puesto');
    eq(p.orphanCourses, [4], 'huérfano');
    assert(p.invalidOwnerIds.some((x) => x.value === 'no-es-uuid'), 'inválido');
    eq(p.summary.reassignments, 0, 'reasignaciones');
    const rep = JSON.stringify(reportOf(p));
    assert(!/uno@x\.test|tres@x\.test|cinco@x\.test/.test(rep), 'el reporte no lleva emails en claro');
  });
  await check('[U9] backfill idempotente: el plan sobre la foto «después» no hace nada', () => {
    const s = snap();
    const p = planBackfill(s, { newId: () => crypto.randomUUID() });
    for (const c of p.createInstitutions) s.institutions.push({ id: c.id, owner_id: c.ownerId, name: c.name, slug: c.slug, kind: 'personal', status: 'active', created_at: '2026-10-26' });
    for (const id of p.markPersonal) s.institutions.find((i) => i.id === id).kind = 'personal';
    for (const m of p.memberships) s.memberships.push({ institution_id: m.institutionId, user_id: m.userId, role: m.role, status: 'active' });
    for (const o of p.overrides) s.overrides.push({ institution_id: o.institutionId, user_id: o.userId, permission: o.permission });
    for (const a of p.attachCourses) s.courses.find((c) => c.id === a.courseId).institution_id = a.institutionId;
    for (const f of p.createdByFill) s.courses.find((c) => c.id === f.courseId).created_by = f.createdBy;
    for (const l of p.linkAuthorizedUsers) s.authorizedUsers.find((a) => a.email === l.email).user_id = l.userId;
    const p2 = planBackfill(s, { newId: () => crypto.randomUUID() });
    const sm = p2.summary;
    eq([sm.institutionsToCreate, sm.institutionsMarkedPersonal, sm.membershipsToCreate, sm.overridesToCreate, sm.coursesToAttach, sm.createdByToFill, sm.authorizedUsersToLink],
      [0, 0, 0, 0, 0, 0, 0], 'segundo plan');
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Admin API de Supabase FALSA (127.0.0.1) — registra pedidos y emula auth.users.
// ════════════════════════════════════════════════════════════════════════════
function fakeSupabase(pgQuery) {
  const st = { requests: [], fail: null, bodies: [] };
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const ch of req) raw += ch;
    const body = raw ? JSON.parse(raw) : null;
    st.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization === 'Bearer fake-service-role-local-only' });
    st.bodies.push(body);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (st.fail === '500') return send(500, { msg: 'boom' });
    try {
      if (req.method === 'POST' && (req.url === '/auth/v1/invite' || req.url === '/auth/v1/admin/users')) {
        const email = String(body.email).toLowerCase();
        const ex = await pgQuery(`select 1 from auth.users where lower(email) = $1`, [email]);
        if (ex.length) return send(422, { error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
        const id = crypto.randomUUID();
        const meta = req.url === '/auth/v1/invite' ? (body.data || {}) : (body.user_metadata || {});
        await pgQuery(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, $3, $4::jsonb)`,
          [id, email, req.url === '/auth/v1/invite' ? null : new Date().toISOString(), JSON.stringify(meta)]);
        return send(200, { id, email, created_at: new Date().toISOString(), user_metadata: meta });
      }
      const m = req.url.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/);
      if (m && req.method === 'GET') {
        const rows = await pgQuery(`select id::text as id, email, created_at from auth.users where id = $1`, [m[1]]);
        return rows[0] ? send(200, rows[0]) : send(404, { error_code: 'user_not_found' });
      }
      if (m && req.method === 'PUT') {
        await pgQuery(`update auth.users set banned_until = case when $2 = 'none' then null else now() + interval '100 years' end where id = $1`, [m[1], body.ban_duration]);
        return send(200, { id: m[1] });
      }
      return send(404, { msg: 'not found' });
    } catch (err) { return send(500, { msg: String(err.message) }); }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ st, srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

// ════════════════════════════════════════════════════════════════════════════
// [M][B][H] con PG16 desechable
// ════════════════════════════════════════════════════════════════════════════
async function dbChecks() {
  const { Client } = require('pg');
  const jwt = require('jsonwebtoken');
  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r75a-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r75a-cwd-'));
  const reportDir = path.join(tmpCwd, 'reports');
  const ROLE = 'postgres.r75accesslocal';
  const DB = 'r75adb';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  let started = false;
  let app = null; let fake = null; let admin = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create role "${ROLE}" superuser login`); });
    admin = new Client({ host: '127.0.0.1', port, user: 'postgres', database: DB });
    await admin.connect();
    const Q = async (sql, params) => (await admin.query(sql, params)).rows;
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env, args = []) => { const res = spawnSync(process.execPath, [path.join(REPO, script), ...args], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 }); return { code: res.status, out: (res.stdout || '') + (res.stderr || ''), stdout: res.stdout || '' }; };

    // Línea base legacy + stubs de Supabase (auth.users, auth.email(), anon) + allow-list del FE con una política MALA.
    await admin.query(fs.readFileSync(path.join(REPO, 'scripts/prod/test/fixtures/legacy-baseline.sql'), 'utf8'));
    { const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({})); assert(res.code === 0, 'constraints: ' + res.out); }
    // H13 / D-2: E2E_PROD_COLUMN_TYPES=1 → tipos legacy de PRODUCCIÓN (production_jobs.course_id text, owner_id uuid).
    if (process.env.E2E_PROD_COLUMN_TYPES === '1') {
      await admin.query(`alter table public.production_jobs alter column course_id type text using course_id::text, alter column owner_id type uuid using owner_id::uuid;
                         alter table public.artifacts alter column owner_id type uuid using owner_id::uuid`);
      console.log('ℹ️  tipos de columnas de producción aplicados (E2E_PROD_COLUMN_TYPES=1)');
    }
    await admin.query(`
      do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; end $$;
      create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, last_sign_in_at timestamptz,
        created_at timestamptz default now(), banned_until timestamptz, raw_user_meta_data jsonb default '{}'::jsonb);
      create or replace function auth.email() returns text language sql stable as $f$ select null::text $f$;
      create or replace function auth.uid() returns uuid language sql stable as $f$ select null::uuid $f$;
      create table public.authorized_users (id uuid primary key default gen_random_uuid(), email text unique not null,
        is_admin boolean default false, created_at timestamptz default now());
      alter table public.authorized_users enable row level security;
      -- H2: la política «propia» MODIFICADA en vivo (mismo nombre, condición abierta): la migración debe recrearla.
      create policy "users check own authorization" on public.authorized_users for select using (true);
      create policy "admins manage everything" on public.authorized_users for all using (true) with check (true);
      grant all on public.authorized_users to anon, authenticated;
      grant all on all tables in schema public to authenticated;
    `);

    await check('[M0] compatibilidad con producción (sin migración r75): la entity Institution no nombra kind/status/created_by', async () => {
      const { DataSource } = require('typeorm');
      const { Institution } = L('modules/institutions/entities/institution.entity.js');
      await withClient('postgres', (c) => c.query('create database legacydb'));
      await withClient('legacydb', (c) => c.query(`create extension if not exists pgcrypto; create table public.institutions (id uuid primary key default gen_random_uuid(),
        owner_id varchar(36) not null, name varchar(255) not null, slug varchar(120) not null unique, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`));
      const ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: 'legacydb', entities: [Institution], synchronize: false });
      await ds.initialize();
      try {
        const repo = ds.getRepository(Institution);
        const saved = await repo.save(repo.create({ name: 'Legacy', slug: 'legacy', ownerId: crypto.randomUUID() }));
        const found = await repo.find({ where: { ownerId: saved.ownerId } });
        eq(found.length, 1, 'find');
        found[0].name = 'Legacy 2';
        await repo.save(found[0]);
        await repo.remove(found[0]);
      } finally { await ds.destroy(); }
    });
    // ── [M] migración ──────────────────────────────────────────────────────
    await check('[M1] guardas: sin MIGRATION_ENV=staging → exit 1; ref de producción → exit 1 aunque diga staging', () => {
      const a = runScript('scripts/migrate-r75-access.js', localEnv({}));
      assert(a.code === 1 && /MIGRATION_ENV/.test(a.out), a.out);
      const b = runScript('scripts/migrate-r75-access.js', localEnv({ MIGRATION_ENV: 'staging', DB_USER: 'postgres.hriwbakbuypaiovvvkqh' }));
      assert(b.code === 1 && /PRODUCCIÓN/.test(b.out), b.out);
      const c = runScript('scripts/migrate-r75-backfill.js', localEnv({ DB_HOST: 'db.hriwbakbuypaiovvvkqh.supabase.co' }));
      assert(c.code === 1 && /PRODUCCIÓN/.test(c.out), 'backfill dry-run contra prod: ' + c.out);
      const d = runScript('scripts/migrate-r75-backfill.js', localEnv({}), ['--apply']);
      assert(d.code === 1 && /MIGRATION_ENV/.test(d.out), 'apply sin staging: ' + d.out);
    });
    await check('[M2] verify falla ANTES de migrar; la migración aplica 2 veces (idempotente) y verify pasa', () => {
      const pre = runScript('scripts/verify-r75-access-schema.js', localEnv({ MIGRATION_ENV: 'staging' }));
      assert(pre.code === 1, 'verify debió fallar sin migración: ' + pre.out);
      for (let i = 0; i < 2; i++) {
        const m = runScript('scripts/migrate-r75-access.js', localEnv({ MIGRATION_ENV: 'staging' }));
        assert(m.code === 0, `corrida ${i + 1}: ${m.out}`);
      }
      const v = runScript('scripts/verify-r75-access-schema.js', localEnv({ MIGRATION_ENV: 'staging' }));
      assert(v.code === 0, v.out);
    });
    await check('[M3] H2: la política de escritura de authorized_users se eliminó; anon sin nada; authenticated solo SELECT', async () => {
      const pol = await Q(`select policyname, cmd, roles::text as roles from pg_policies where tablename = 'authorized_users'`);
      eq(pol, [{ policyname: 'users check own authorization', cmd: 'SELECT', roles: '{authenticated}' }], 'políticas');
      // La versión modificada en vivo (using true) NO sobrevive: la condición es la exacta de la fila propia.
      const [{ qual }] = await Q(`select qual from pg_policies where tablename = 'authorized_users'`);
      assert(/user_id = auth\.uid\(\)/.test(qual) && /lower\(email\) = lower\(auth\.email\(\)\)/.test(qual) && !/^\s*true\s*$/.test(qual), 'qual: ' + qual);
      const g = await Q(`select grantee, privilege_type from information_schema.role_table_grants where table_name = 'authorized_users' and grantee in ('anon','authenticated') order by 1, 2`);
      eq(g, [{ grantee: 'authenticated', privilege_type: 'SELECT' }], 'grants');
      for (const t of ['institution_memberships', 'admin_audit_log', 'user_suspensions', 'platform_controls', 'institution_permission_overrides']) {
        const gg = await Q(`select 1 from information_schema.role_table_grants where table_name = $1 and grantee in ('anon','authenticated')`, [t]);
        eq(gg.length, 0, 'grants en ' + t);
      }
    });
    await check('[M4] reparación idempotente: se borra un trigger → verify falla → la migración lo repone → verify pasa', () => {
      spawnSync(path.join(pgBin, 'psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', DB, '-qc', 'drop trigger admin_audit_log_append_only on public.admin_audit_log'], { env: cleanEnv() });
      const v1 = runScript('scripts/verify-r75-access-schema.js', localEnv({ MIGRATION_ENV: 'staging' }));
      assert(v1.code === 1 && /admin_audit_log_append_only/.test(v1.out), v1.out);
      assert(runScript('scripts/migrate-r75-access.js', localEnv({ MIGRATION_ENV: 'staging' })).code === 0, 'migración');
      assert(runScript('scripts/verify-r75-access-schema.js', localEnv({ MIGRATION_ENV: 'staging' })).code === 0, 'verify');
    });
    await check('[M5] admin_audit_log es append-only (UPDATE/DELETE/TRUNCATE rechazados)', async () => {
      await Q(`insert into public.admin_audit_log (actor_id, actor_is_superadmin, action, target_type) values ('00000000-0000-0000-0000-000000000000', false, 'test.x', 'test')`);
      for (const sql of [`update public.admin_audit_log set action = 'y'`, `delete from public.admin_audit_log`, `truncate public.admin_audit_log`]) {
        let err = null; try { await Q(sql); } catch (e) { err = e; }
        assert(err && /append-only/.test(err.message), sql + ' → ' + (err && err.message));
      }
    });
    await check('[M6] suspensiones: sin DELETE; levantar una sola vez; motivo inmutable; membresías/overrides sin DELETE', async () => {
      const uid = crypto.randomUUID();
      const [s] = await Q(`insert into public.user_suspensions (user_id, kind, reason, created_by) values ($1, 'generation', 'r', $1) returning id`, [uid]);
      const expectFail = async (sql, params, re) => { let err = null; try { await Q(sql, params); } catch (e) { err = e; } assert(err && re.test(err.message), sql + ' → ' + (err && err.message)); };
      await expectFail(`delete from public.user_suspensions where id = $1`, [s.id], /DELETE no permitido/);
      await expectFail(`update public.user_suspensions set reason = 'otro' where id = $1`, [s.id], /solo se pueden escribir/);
      await Q(`update public.user_suspensions set lifted_by = $2, lifted_at = now(), lift_reason = 'ok' where id = $1`, [s.id, uid]);
      await expectFail(`update public.user_suspensions set lift_reason = 'de nuevo' where id = $1`, [s.id], /inmutable/);
      await expectFail(`insert into public.institution_memberships (institution_id, user_id, role) values (gen_random_uuid(), $1, 'SUPERADMIN')`, [uid], /violates (foreign key|check)/);
      await expectFail(`truncate public.institution_memberships`, [], /append-only/);
      await expectFail(`truncate public.institution_permission_overrides`, [], /append-only/);
    });

    // ── [B] backfill ───────────────────────────────────────────────────────
    const U = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-0000000000aa`;
    await Q(`insert into auth.users (id, email, email_confirmed_at) values ($1, 'bf-uno@r75.test', now()), ($2, 'bf-allow@r75.test', now())`, [U(1), U(5)]);
    await Q(`insert into public.institutions (id, owner_id, name, slug, created_at) values
      ('10000000-0000-4000-8000-000000000001', $1, 'BF Uno', 'bf-uno', '2026-01-01'),
      ('10000000-0000-4000-8000-000000000002', $2, 'BF Dos A', 'bf-dos-a', '2026-03-01'),
      ('10000000-0000-4000-8000-000000000003', $2, 'BF Dos B', 'bf-dos-b', '2026-02-01')`, [U(1), U(2)]);
    await Q(`insert into public.courses (owner_id, owner_email, title, institution_id) values
      ($1, 'bf-uno@r75.test', 'BF c1', null), ($1, 'bf-uno@r75.test', 'BF c2', '10000000-0000-4000-8000-000000000001'),
      (null, null, 'BF huérfano', null), ('no-es-uuid', null, 'BF raro', null), ($2, null, 'BF dos', null)`, [U(1), U(2)]);
    await Q(`insert into public.authorized_users (email) values ('bf-allow@r75.test')`);
    const countRows = async () => (await Q(`select (select count(*) from public.institutions)::int i, (select count(*) from public.institution_memberships)::int m,
      (select count(*) from public.institution_permission_overrides)::int o, (select count(*) from public.courses where institution_id is not null)::int c,
      (select count(*) from public.authorized_users where user_id is not null)::int a,
      (select string_agg(id || ':' || coalesce(owner_id,'∅') || ':' || coalesce(institution_id::text,'∅'), ',' order by id) from public.courses) snap`))[0];
    let before; let dryReport;
    await check('[B1] dry-run: no escribe nada y deja un reporte JSON sin emails en claro', async () => {
      before = await countRows();
      const res = runScript('scripts/migrate-r75-backfill.js', localEnv({ MIGRATION_ENV: 'staging' }), [`--report-dir=${reportDir}`]);
      assert(res.code === 0, res.out);
      eq(await countRows(), before, 'la base cambió en dry-run');
      const files = fs.readdirSync(reportDir).filter((f) => /dry-run\.json$/.test(f));
      eq(files.length, 1, 'reporte');
      dryReport = JSON.parse(fs.readFileSync(path.join(reportDir, files[0]), 'utf8'));
      assert(!/bf-uno@r75\.test|bf-allow@r75\.test/.test(JSON.stringify(dryReport)), 'emails en claro en el reporte');
      assert(!/bf-uno@r75\.test/.test(res.out), 'emails en stdout');
      eq(dryReport.mode, 'dry-run', 'modo');
      eq(dryReport.summary.reassignments, 0, 'reasignaciones');
      assert(dryReport.summary.orphanCourses >= 1 && dryReport.summary.invalidOwnerIds >= 1 && dryReport.summary.manualReview >= 1, JSON.stringify(dryReport.summary));
    });
    await check('[B2] --apply (staging): aplica lo planificado, 0 reasignaciones, owner_id intacto; 2.º dry-run vacío', async () => {
      const res = runScript('scripts/migrate-r75-backfill.js', localEnv({ MIGRATION_ENV: 'staging' }), ['--apply', `--report-dir=${reportDir}`]);
      assert(res.code === 0, res.out);
      const after = await countRows();
      assert(after.m > before.m && after.o > before.o && after.c > before.c && after.a > before.a, JSON.stringify({ before, after }));
      // ningún curso con institución previa cambió; owner_id de todos intacto
      const prev = new Map(before.snap.split(',').map((x) => { const [id, o, i] = x.split(':'); return [id, { o, i }]; }));
      for (const x of after.snap.split(',')) {
        const [id, o, i] = x.split(':');
        eq(o, prev.get(id).o, `owner_id del curso ${id}`);
        if (prev.get(id).i !== '∅') eq(i, prev.get(id).i, `institution_id del curso ${id}`);
      }
      const orphan = await Q(`select institution_id from public.courses where title = 'BF huérfano'`);
      eq(orphan[0].institution_id, null, 'huérfano adjuntado');
      const mine = await Q(`select institution_id::text i from public.courses where title = 'BF dos'`);
      eq(mine[0].i, '10000000-0000-4000-8000-000000000003', 'u2 → la más antigua');
      const d5 = await Q(`select permission from public.institution_permission_overrides where user_id = $1 and institution_id = '10000000-0000-4000-8000-000000000001' order by 1`, [U(1)]);
      eq(d5.map((x) => x.permission), ['generations.start', 'proposals.approve'], 'D-5');
      const kinds = await Q(`select kind from public.institutions where id = '10000000-0000-4000-8000-000000000001'`);
      eq(kinds[0].kind, 'personal', 'personal');
      const audit = await Q(`select count(*)::int n from public.admin_audit_log where action = 'backfill.apply'`);
      eq(audit[0].n, 1, 'auditoría del backfill');
      const res2 = runScript('scripts/migrate-r75-backfill.js', localEnv({ MIGRATION_ENV: 'staging' }), [`--report-dir=${reportDir}`]);
      const sum = JSON.parse(res2.stdout.trim().split('\n').pop()).summary;
      eq([sum.institutionsToCreate, sum.membershipsToCreate, sum.overridesToCreate, sum.coursesToAttach, sum.createdByToFill, sum.authorizedUsersToLink, sum.institutionsMarkedPersonal], [0, 0, 0, 0, 0, 0, 0], '2.º plan');
      const res3 = runScript('scripts/migrate-r75-backfill.js', localEnv({ MIGRATION_ENV: 'staging' }), ['--apply', `--report-dir=${reportDir}`]);
      assert(res3.code === 0, res3.out);
      eq((await countRows()).m, after.m, 'segunda aplicación cambió membresías');
    });

    // ── [H] HTTP real ──────────────────────────────────────────────────────
    const { Test } = require('@nestjs/testing');
    const { TypeOrmModule } = require('@nestjs/typeorm');
    const { Logger, ValidationPipe } = require('@nestjs/common');
    const { AccessModule } = L('modules/access/access.module.js');
    const { InstitutionsModule } = L('modules/institutions/institutions.module.js');
    const { Institution } = L('modules/institutions/entities/institution.entity.js');
    const { AllExceptionsFilter } = L('common/filters/http-exception.filter.js');
    const { ResponseInterceptor } = L('common/interceptors/response.interceptor.js');
    const SCH = L('modules/access/access-schema.js');
    SCH.resetR75AccessSchemaCacheForTests(); SCH.resetAuthUsersReadableCacheForTests();
    fake = await fakeSupabase(Q);
    const SECRET = 'r75-local-jwt-secret-only-for-this-check';
    Object.assign(process.env, {
      SUPABASE_JWT_SECRET: SECRET, SUPER_ADMIN_EMAILS: 'sa@r75.test', SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-local-only',
      CURSIA_RBAC_MODE: 'off', CURSIA_USER_BUDGETS: 'off',
    });
    delete process.env.SUPER_ADMIN_USER_IDS;
    Logger.overrideLogger(capLogger);
    const SA_ID = crypto.randomUUID();
    await Q(`insert into auth.users (id, email, email_confirmed_at) values ($1, 'sa@r75.test', now())`, [SA_ID]);
    await Q(`insert into public.authorized_users (email, user_id) values ('sa@r75.test', $1)`, [SA_ID]);
    const mod = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Institution], synchronize: false }), AccessModule, InstitutionsModule],
    }).compile();
    app = mod.createNestApplication({ logger: capLogger });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    const tok = (id, email, meta) => jwt.sign({ sub: id, email, role: 'authenticated', user_metadata: meta || {}, email_verified: true }, SECRET, { expiresIn: 600 });
    const call = async (t, method, p, body) => {
      const res = await realFetch(base + p, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      let json = null; try { json = await res.json(); } catch { json = null; }
      return { status: res.status, body: json, data: json && json.data && json.data.data !== undefined ? json.data.data : json && json.data, headers: res.headers };
    };
    const SA = tok(SA_ID, 'sa@r75.test');
    const expectCode = (r, status, code, m) => { assert(r.status === status && (!code || (r.body && r.body.code === code)), `${m}: esperado ${status} ${code || ''}, encontrado ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); };

    let instA; let instB; const users = {}; const passwords = [];
    await check('[H1] solo el SA crea instituciones; slug duplicado → 409', async () => {
      const a = await call(SA, 'POST', '/admin/institutions', { name: 'QA r75 Institución A' });
      expectCode(a, 201, null, 'crear A');
      instA = a.data;
      eq([instA.kind, instA.status, instA.slug], ['organization', 'active', 'qa-r75-institucion-a'], 'A');
      const b = await call(SA, 'POST', '/admin/institutions', { name: 'QA r75 Institución B' });
      instB = b.data;
      expectCode(await call(SA, 'POST', '/admin/institutions', { name: 'QA r75 Institución A' }), 409, 'institution_slug_exists', 'dup');
      expectCode(await call(SA, 'POST', '/admin/institutions', { name: 'X', kind: 'personal' }), 400, 'invalid_input', 'kind personal');
    });
    await check('[H2] alta de usuarios por el SA: temp_password UNA vez + no-store; invite sin contraseña; membresías por institución', async () => {
      const r = await call(SA, 'POST', '/admin/users', { email: 'qa-r75-admin-inst-a@example.com', fullName: 'Admin A', mode: 'temp_password', memberships: [{ institutionId: instA.id, role: 'ADMIN_INSTITUCIONAL' }] });
      expectCode(r, 201, null, 'crear admin A');
      assert(/no-store/.test(r.headers.get('cache-control') || ''), 'Cache-Control no-store');
      assert(typeof r.data.tempPassword === 'string' && r.data.tempPassword.length === 20, 'tempPassword');
      passwords.push(r.data.tempPassword);
      eq([r.data.invited, r.data.user.authorized, r.data.user.budget], [false, true, null], 'flags (budget null: A no asigna presupuesto)');
      eq(r.data.user.memberships.map((m) => [m.institutionId, m.role]), [[instA.id, 'ADMIN_INSTITUCIONAL']], 'membresía');
      users.adminA = r.data.user;
      const sent = fake.st.bodies[fake.st.requests.findIndex((q) => q.url === '/auth/v1/admin/users' && q.method === 'POST')];
      eq([sent.email_confirm, sent.user_metadata.must_change_password, sent.password === r.data.tempPassword], [true, true, true], 'pedido a Auth');
      assert(fake.st.requests.every((q) => q.auth), 'service key en el header');
      const c = await call(SA, 'POST', '/admin/users', { email: 'qa-r75-creador-a@example.com', mode: 'invite', memberships: [{ institutionId: instA.id, role: 'CREADOR' }, { institutionId: instB.id, role: 'CONSULTA' }] });
      expectCode(c, 201, null, 'crear creador');
      eq([c.data.invited, 'tempPassword' in c.data], [true, false], 'invite');
      users.creador = c.data.user;
      for (const [k, email, role] of [['consulta', 'qa-r75-consulta-a@example.com', null], ['adminA2', 'qa-r75-admin2-a@example.com', null], ['adminB', 'qa-r75-admin-inst-b@example.com', 'B']]) {
        const x = await call(SA, 'POST', '/admin/users', { email, mode: 'temp_password', memberships: role === 'B' ? [{ institutionId: instB.id, role: 'ADMIN_INSTITUCIONAL' }] : [] });
        expectCode(x, 201, null, 'crear ' + k);
        passwords.push(x.data.tempPassword);
        users[k] = x.data.user;
      }
      const bud = await Q(`select to_regclass('public.user_budgets') t`);
      eq(bud[0].t, null, 'A no crea tablas ni filas de presupuesto (regla 6: sin fila = USD 0)');
    });
    const T = () => ({ adminA: tok(users.adminA.id, users.adminA.email), creador: tok(users.creador.id, users.creador.email), consulta: tok(users.consulta.id, users.consulta.email),
      adminA2: tok(users.adminA2.id, users.adminA2.email), adminB: tok(users.adminB.id, users.adminB.email) });
    await check('[H3] errores de alta: existente 409 user_exists; solo-Auth 409 user_exists_unauthorized; email inválido 400; Admin API caída 503; sin configurar 503', async () => {
      expectCode(await call(SA, 'POST', '/admin/users', { email: 'QA-R75-ADMIN-INST-A@example.com' }), 409, 'user_exists', 'existente');
      const ghost = crypto.randomUUID();
      await Q(`insert into auth.users (id, email) values ($1, 'qa-r75-signup-abierto@example.com')`, [ghost]);
      const u = await call(SA, 'POST', '/admin/users', { email: 'qa-r75-signup-abierto@example.com' });
      expectCode(u, 409, 'user_exists_unauthorized', 'solo Auth');
      expectCode(await call(SA, 'POST', '/admin/users', { email: 'no-es-email' }), 400, 'invalid_email', 'inválido');
      expectCode(await call(SA, 'POST', '/admin/users', { email: 'x@example.com', memberships: [{ institutionId: instA.id, role: 'SUPERADMIN' }] }), 400, 'superadmin_role_reserved', 'SA reservado');
      fake.st.fail = '500';
      expectCode(await call(SA, 'POST', '/admin/users', { email: 'qa-r75-caida@example.com' }), 503, 'admin_api_unavailable', 'caída');
      fake.st.fail = null;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      expectCode(await call(SA, 'POST', '/admin/users', { email: 'qa-r75-sinclave@example.com' }), 503, 'admin_api_unavailable', 'sin clave');
      process.env.SUPABASE_SERVICE_ROLE_KEY = key;
      const auth = await call(SA, 'POST', `/admin/users/${ghost}/authorize`, { reason: 'QA: autorizar registro abierto' });
      expectCode(auth, 200, null, 'authorize');
      eq(auth.data.authorized, true, 'autorizado');
      expectCode(await call(SA, 'POST', `/admin/users/${ghost}/authorize`, { reason: 'otra vez' }), 409, 'user_exists', 're-authorize');
    });
    await check('[H4] anti-escalada: nadie salvo el SA crea usuarios ni instituciones (ni un ADMIN_INSTITUCIONAL)', async () => {
      const t = T();
      for (const who of ['adminA', 'creador', 'consulta']) {
        expectCode(await call(t[who], 'POST', '/admin/users', { email: `nuevo-${who}@example.com`, mode: 'temp_password' }), 403, null, who + ' crea usuario');
        expectCode(await call(t[who], 'POST', '/admin/institutions', { name: 'Hack ' + who }), 403, null, who + ' crea institución');
        expectCode(await call(t[who], 'POST', `/admin/users/${t.adminA ? users.consulta.id : ''}/suspensions`, { kind: 'account', reason: 'x' }), 403, null, who + ' suspende');
      }
      process.env.CURSIA_RBAC_MODE = 'enforce';
      expectCode(await call(t.adminA, 'POST', '/institutions', { name: 'Brandkit en enforce' }), 403, 'institution_create_forbidden', 'D-23');
      process.env.CURSIA_RBAC_MODE = 'off';
    });
    await check('[H5] membresías: el admin agrega usuarios EXISTENTES con rol; 404 si no existe; 409 duplicada; rol SA reservado; ajenos 403', async () => {
      const t = T();
      const add = await call(t.adminA, 'POST', `/institutions/${instA.id}/members`, { email: users.consulta.email, role: 'CONSULTA' });
      expectCode(add, 201, null, 'agregar consulta');
      eq([add.data.role, add.data.effectivePermissions], ['CONSULTA', ['courses.view']], 'consulta');
      expectCode(await call(t.adminA, 'POST', `/institutions/${instA.id}/members`, { email: users.adminA2.email, role: 'ADMIN_INSTITUCIONAL' }), 201, null, 'agregar admin2');
      expectCode(await call(t.adminA, 'POST', `/institutions/${instA.id}/members`, { email: 'nadie@example.com', role: 'CREADOR' }), 404, 'user_not_found', 'inexistente (D-12)');
      expectCode(await call(t.adminA, 'POST', `/institutions/${instA.id}/members`, { email: users.consulta.email, role: 'CREADOR' }), 409, 'membership_exists', 'duplicada');
      expectCode(await call(t.adminA, 'POST', `/institutions/${instA.id}/members`, { email: users.adminB.email, role: 'SUPERADMIN' }), 400, 'superadmin_role_reserved', 'SA');
      expectCode(await call(t.adminA, 'POST', `/institutions/${instA.id}/members`, { email: users.adminB.email, role: 'JEFE' }), 400, 'invalid_role', 'rol inválido');
      expectCode(await call(t.adminA, 'GET', `/institutions/${instB.id}/members`), 403, 'not_a_member', 'ajeno');
      expectCode(await call(t.creador, 'GET', `/institutions/${instA.id}/members`), 403, 'permission_denied', 'creador sin roles.manage');
      expectCode(await call(t.creador, 'GET', `/institutions/${instB.id}/members`), 403, 'permission_denied', 'consulta en B');
      expectCode(await call(t.adminA, 'GET', `/institutions/${crypto.randomUUID()}/members`), 403, 'not_a_member', 'inexistente no se revela');
      const list = await call(t.adminA, 'GET', `/institutions/${instA.id}/members`);
      eq(list.data.map((m) => m.email).sort(), [users.adminA.email, users.adminA2.email, users.consulta.email, users.creador.email].sort(), 'lista');
      expectCode(await call(t.adminA, 'PATCH', `/institutions/${instA.id}/members/${users.adminA.id}`, { role: 'CONSULTA' }), 403, 'self_modification_forbidden', 'self');
      const upd = await call(t.adminA, 'PATCH', `/institutions/${instA.id}/members/${users.consulta.id}`, { role: 'APROBADOR_ACADEMICO' });
      expectCode(upd, 200, null, 'cambiar rol');
      assert(upd.data.effectivePermissions.includes('proposals.approve'), 'aprobador aprueba');
      const sus = await call(t.adminA, 'PATCH', `/institutions/${instA.id}/members/${users.consulta.id}`, { status: 'suspended' });
      eq([sus.data.status, sus.data.effectivePermissions], ['suspended', []], 'membresía suspendida');
      await call(t.adminA, 'PATCH', `/institutions/${instA.id}/members/${users.consulta.id}`, { status: 'active', role: 'CONSULTA' });
    });
    await check('[H6] overrides: el admin no otorga lo que no tiene (generations.start); globales no otorgables ni por el SA; deny > grant', async () => {
      const t = T();
      expectCode(await call(t.adminA, 'PUT', `/institutions/${instA.id}/members/${users.consulta.id}/overrides`, { grants: ['generations.start'], denies: [], reason: 'x' }), 403, 'role_escalation_forbidden', 'escalada');
      expectCode(await call(t.adminA, 'PUT', `/institutions/${instA.id}/members/${users.consulta.id}/overrides`, { grants: ['budgets.manage'], reason: 'x' }), 400, 'permission_not_grantable', 'global');
      expectCode(await call(SA, 'PUT', `/institutions/${instA.id}/members/${users.consulta.id}/overrides`, { grants: ['users.suspend'], reason: 'x' }), 400, 'permission_not_grantable', 'global SA');
      expectCode(await call(t.adminA, 'PUT', `/institutions/${instA.id}/members/${users.consulta.id}/overrides`, { grants: ['spend.view'], denies: ['spend.view'], reason: 'x' }), 400, 'invalid_input', 'solapado');
      expectCode(await call(t.adminA, 'PUT', `/institutions/${instA.id}/members/${users.consulta.id}/overrides`, { grants: ['spend.view'] }), 400, 'reason_required', 'motivo');
      expectCode(await call(t.adminA, 'PUT', `/institutions/${instA.id}/members/${users.adminA.id}/overrides`, { grants: ['spend.view'], reason: 'x' }), 403, 'self_modification_forbidden', 'self');
      const ok = await call(t.adminA, 'PUT', `/institutions/${instA.id}/members/${users.consulta.id}/overrides`, { grants: ['exports.download'], denies: ['courses.view'], reason: 'QA' });
      expectCode(ok, 200, null, 'set');
      eq(ok.data.overrides, { grants: ['exports.download'], denies: ['courses.view'] }, 'overrides');
      eq(ok.data.effectivePermissions, ['exports.download'], 'efectivos');
      const rep = await call(t.adminA, 'PUT', `/institutions/${instA.id}/members/${users.consulta.id}/overrides`, { grants: [], denies: [], reason: 'QA limpiar' });
      eq([rep.data.overrides, rep.data.effectivePermissions], [{ grants: [], denies: [] }, ['courses.view']], 'reemplazo (revoca)');
      const rows = await Q(`select count(*)::int n from public.institution_permission_overrides where user_id = $1 and revoked_at is not null`, [users.consulta.id]);
      eq(rows[0].n, 2, 'revocados quedan como historia');
      const sa = await call(SA, 'PUT', `/institutions/${instA.id}/members/${users.creador.id}/overrides`, { grants: ['roles.manage'], reason: 'QA: creador administra miembros' });
      expectCode(sa, 200, null, 'SA otorga roles.manage');
    });
    await check('[H7] último admin: una organización no se queda sin ADMIN_INSTITUCIONAL efectivo (el SA sí puede)', async () => {
      const t = T();
      expectCode(await call(t.adminA2, 'PATCH', `/institutions/${instA.id}/members/${users.adminA.id}`, { role: 'CREADOR' }), 200, null, 'quedan 2 → 1');
      expectCode(await call(t.creador, 'PATCH', `/institutions/${instA.id}/members/${users.adminA2.id}`, { role: 'CONSULTA' }), 409, 'last_admin_protected', 'degradar al último');
      expectCode(await call(t.creador, 'DELETE', `/institutions/${instA.id}/members/${users.adminA2.id}`, { reason: 'x' }), 409, 'last_admin_protected', 'quitar al último');
      expectCode(await call(t.creador, 'PATCH', `/institutions/${instA.id}/members/${users.adminA2.id}`, { status: 'suspended' }), 409, 'last_admin_protected', 'suspender al último');
      expectCode(await call(t.creador, 'PUT', `/institutions/${instA.id}/members/${users.adminA2.id}/overrides`, { denies: ['roles.manage'], reason: 'x' }), 409, 'last_admin_protected', 'deny roles.manage al último');
      expectCode(await call(t.adminA2, 'PATCH', `/institutions/${instA.id}/members/${users.adminA.id}`, { role: 'ADMIN_INSTITUCIONAL' }), 200, null, 'restaurar');
      expectCode(await call(t.creador, 'DELETE', `/institutions/${instA.id}/members/${users.adminA2.id}`, { reason: 'QA' }), 200, null, 'con otro admin sí');
      const re = await call(t.adminA, 'POST', `/institutions/${instA.id}/members`, { email: users.adminA2.email, role: 'ADMIN_INSTITUCIONAL' });
      expectCode(re, 201, null, 'reactivar removido');
      expectCode(await call(SA, 'PATCH', `/institutions/${instB.id}/members/${users.adminB.id}`, { role: 'CONSULTA' }), 200, null, 'el SA puede');
      await call(SA, 'PATCH', `/institutions/${instB.id}/members/${users.adminB.id}`, { role: 'ADMIN_INSTITUCIONAL' });
    });
    await check('[H8] /me/context: multi-institución con rol por institución; superAdmin solo por env; no autorizado responde 200', async () => {
      const t = T();
      const me = await call(t.creador, 'GET', '/me/context');
      expectCode(me, 200, null, 'me');
      const byInst = Object.fromEntries(me.data.memberships.map((m) => [m.institutionId, m]));
      eq([byInst[instA.id].role, byInst[instB.id].role], ['CREADOR', 'CONSULTA'], 'roles por institución (regla 2)');
      assert(byInst[instA.id].permissions.includes('generations.start') && !byInst[instB.id].permissions.includes('generations.start'), 'permisos por institución');
      eq([me.data.superAdmin, me.data.account.status, me.data.rbacMode, me.data.budget], [false, 'active', 'off', null], 'flags');
      const sa = await call(SA, 'GET', '/me/context');
      eq(sa.data.superAdmin, true, 'SA');
      await Q(`update public.authorized_users set is_admin = true where user_id = $1`, [users.adminA.id]);
      eq((await call(t.adminA, 'GET', '/me/context')).data.superAdmin, false, 'is_admin NO hace SuperAdmin (D-3)');
      const strangerId = crypto.randomUUID();
      const st = await call(tok(strangerId, 'extrano@example.com'), 'GET', '/me/context');
      eq([st.status, st.data.account.authorized, st.data.account.status, st.data.memberships], [200, false, 'not_authorized', []], 'no autorizado');
      const mc = await call(tok(users.adminA.id, users.adminA.email, { must_change_password: true }), 'GET', '/me/context');
      eq(mc.data.account.mustChangePassword, true, 'must change');
    });
    await check('[H9] suspensiones independientes: generación ≠ cuenta; cuenta pausa runs vivos y banea; 409/404; el SA no se suspende a sí mismo', async () => {
      const t = T();
      const g = await call(SA, 'POST', `/admin/users/${users.creador.id}/suspensions`, { kind: 'generation', reason: 'QA generación' });
      expectCode(g, 201, null, 'suspender generación');
      expectCode(await call(SA, 'POST', `/admin/users/${users.creador.id}/suspensions`, { kind: 'generation', reason: 'otra' }), 409, 'suspension_active', 'doble');
      let me = (await call(t.creador, 'GET', '/me/context')).data;
      eq([me.account.status, me.generation.suspended, me.memberships.length], ['active', true, 2], 'generación no toca la cuenta');
      expectCode(await call(t.creador, 'GET', `/institutions/${instA.id}/members`), 200, null, 'sigue administrando (tiene roles.manage)');
      const run = crypto.randomUUID(); const run2 = crypto.randomUUID();
      await Q(`insert into public.production_jobs (id, owner_id, course_id, execution_mode, status, worker_status, input_payload) values
        ($1, $2, 1, 'dynamic_generation', 'running', 'running', '{}'::jsonb), ($3, $4, 2, 'dynamic_generation', 'running', 'running', jsonb_build_object('startedBy', $2::text))`,
        [run, users.adminA2.id, run2, users.adminA.id]);
      const a = await call(SA, 'POST', `/admin/users/${users.adminA2.id}/suspensions`, { kind: 'account', reason: 'QA cuenta' });
      expectCode(a, 201, null, 'suspender cuenta');
      const paused = await Q(`select id::text, worker_status, output_summary->'pause'->>'reason' r from public.production_jobs where id = any($1::uuid[]) order by id`, [[run, run2]]);
      assert(paused.every((p) => p.worker_status === 'paused' && p.r === 'account_suspended'), JSON.stringify(paused));
      const banned = await Q(`select banned_until is not null b from auth.users where id = $1`, [users.adminA2.id]);
      eq(banned[0].b, true, 'ban en Auth');
      assert(fake.st.bodies.some((b) => b && b.ban_duration === '876000h'), 'ban_duration');
      me = (await call(t.adminA2, 'GET', '/me/context')).data;
      eq([me.account.status, me.memberships], ['suspended', []], '/me/context responde suspendida');
      expectCode(await call(t.adminA2, 'GET', `/institutions/${instA.id}/members`), 403, 'account_suspended', 'cuenta suspendida no administra');
      expectCode(await call(SA, 'POST', `/admin/users/${SA_ID}/suspensions`, { kind: 'account', reason: 'x' }), 403, 'self_modification_forbidden', 'self SA');
      expectCode(await call(SA, 'POST', `/admin/users/${crypto.randomUUID()}/suspensions`, { kind: 'account', reason: 'x' }), 404, 'user_not_found', 'desconocido');
      expectCode(await call(SA, 'POST', `/admin/users/${users.creador.id}/suspensions`, { kind: 'todo', reason: 'x' }), 400, 'invalid_input', 'kind');
      expectCode(await call(SA, 'POST', `/admin/users/${users.creador.id}/suspensions`, { kind: 'account' }), 400, 'reason_required', 'motivo');
      const lift = await call(SA, 'DELETE', `/admin/users/${users.adminA2.id}/suspensions/account`, { reason: 'QA levantar' });
      expectCode(lift, 200, null, 'levantar cuenta');
      assert(lift.data.liftedAt, 'liftedAt');
      eq((await Q(`select banned_until from auth.users where id = $1`, [users.adminA2.id]))[0].banned_until, null, 'unban');
      eq((await Q(`select worker_status from public.production_jobs where id = $1`, [run]))[0].worker_status, 'paused', 'los runs NO se reanudan solos');
      expectCode(await call(SA, 'DELETE', `/admin/users/${users.adminA2.id}/suspensions/account`, { reason: 'x' }), 404, 'suspension_not_found', 'levantar 2 veces');
      expectCode(await call(SA, 'DELETE', `/admin/users/${users.creador.id}/suspensions/generation`, { reason: 'QA' }), 200, null, 'levantar generación');
      const det = await call(SA, 'GET', `/admin/users/${users.adminA2.id}`);
      eq([det.data.suspensions.length, det.data.recentRuns.length, det.data.accountStatus], [1, 2, 'active'], 'detalle (dueño + iniciador)');
      const list = await call(SA, 'GET', `/admin/users?q=qa-r75&pageSize=2&page=1`);
      eq([list.data.items.length, list.data.total >= 5], [2, true], 'paginado');
      const unauth = await call(SA, 'GET', `/admin/users?status=unauthorized`);
      assert(Array.isArray(unauth.data.items), 'lista no autorizados');
      const inB = await call(SA, 'GET', `/admin/users?institutionId=${instB.id}`);
      eq(inB.data.items.map((u) => u.email).sort(), [users.adminB.email, users.creador.email].sort(), 'por institución');
    });
    await check('[H10] congelación de plataforma: solo SA, con motivo; /me/context la muestra', async () => {
      const t = T();
      expectCode(await call(t.adminA, 'PUT', '/admin/platform/generation-freeze', { enabled: true, reason: 'x' }), 403, null, 'no SA');
      expectCode(await call(SA, 'PUT', '/admin/platform/generation-freeze', { enabled: true }), 400, 'reason_required', 'motivo');
      const f = await call(SA, 'PUT', '/admin/platform/generation-freeze', { enabled: true, reason: 'QA freeze' });
      eq([f.data.generationFreeze.enabled, f.data.generationFreeze.updatedBy], [true, SA_ID], 'freeze');
      eq((await call(t.creador, 'GET', '/me/context')).data.generation.platformFrozen, true, 'me');
      await call(SA, 'PUT', '/admin/platform/generation-freeze', { enabled: false, reason: 'QA unfreeze' });
      eq((await call(SA, 'GET', '/admin/platform/controls')).data.generationFreeze.enabled, false, 'unfreeze');
    });
    await check('[H11] instituciones según CURSIA_RBAC_MODE: off = por dueño (como hoy); enforce = por membresía; ?all=1 solo SA', async () => {
      const t = T();
      process.env.CURSIA_RBAC_MODE = 'off';
      const legacy = await call(t.adminA, 'POST', '/institutions', { name: 'Brandkit legacy adminA' });
      expectCode(legacy, 201, null, 'crear legacy en off');
      const off = await call(t.adminA, 'GET', '/institutions');
      eq(off.data.map((i) => i.name), ['Brandkit legacy adminA'], 'off: por owner_id');
      eq('kind' in off.data[0], false, 'off: forma legacy (sin columnas r75)');
      const noRows = await Q(`select count(*)::int n from public.institution_memberships where institution_id = $1`, [legacy.data.id]);
      eq(noRows[0].n, 0, 'off: no escribe membresías');
      process.env.CURSIA_RBAC_MODE = 'shadow';
      const sh = await call(t.adminA, 'POST', '/institutions', { name: 'Brandkit shadow adminA' });
      const shRows = await Q(`select role from public.institution_memberships where institution_id = $1 and user_id = $2`, [sh.data.id, users.adminA.id]);
      eq(shRows.map((x) => x.role), ['ADMIN_INSTITUCIONAL'], 'shadow: creador queda admin');
      process.env.CURSIA_RBAC_MODE = 'enforce';
      const en = await call(t.creador, 'GET', '/institutions');
      eq(en.data.map((i) => i.id).sort(), [instA.id, instB.id].sort(), 'enforce: por membresía');
      expectCode(await call(t.creador, 'GET', `/institutions/${instA.id}`), 200, null, 'miembro ve');
      expectCode(await call(t.adminB, 'GET', `/institutions/${instA.id}`), 404, null, 'no miembro: 404');
      expectCode(await call(t.creador, 'PATCH', `/institutions/${instB.id}`, { name: 'x' }), 403, 'permission_denied', 'consulta no renombra');
      expectCode(await call(t.adminA, 'DELETE', `/institutions/${instA.id}`), 403, 'permission_denied', 'admin no borra');
      expectCode(await call(SA, 'DELETE', `/institutions/${instA.id}`), 409, 'institution_has_members', 'SA no borra con miembros');
      const all = await call(SA, 'GET', '/institutions?all=1');
      assert(all.data.length >= 5 && all.data.every((i) => typeof i.memberCount === 'number'), 'all');
      const notAll = await call(t.creador, 'GET', '/institutions?all=1');
      eq(notAll.data.length, 2, '?all=1 ignorado para no-SA');
      await call(SA, 'PATCH', `/admin/institutions/${instB.id}`, { status: 'suspended' });
      expectCode(await call(t.adminB, 'GET', `/institutions/${instB.id}/members`), 403, 'institution_inactive', 'institución suspendida');
      await call(SA, 'PATCH', `/admin/institutions/${instB.id}`, { status: 'active' });
      process.env.CURSIA_RBAC_MODE = 'off';
    });
    await check('[H12] mover curso: solo SA, con motivo, auditado; nunca toca owner_id', async () => {
      const [c] = await Q(`select id, owner_id from public.courses where title = 'BF c1'`);
      expectCode(await call(SA, 'PATCH', `/admin/courses/${c.id}/institution`, { institutionId: instA.id }), 400, 'reason_required', 'motivo');
      expectCode(await call(T().adminA, 'PATCH', `/admin/courses/${c.id}/institution`, { institutionId: instA.id, reason: 'x' }), 403, null, 'no SA');
      const mv = await call(SA, 'PATCH', `/admin/courses/${c.id}/institution`, { institutionId: instA.id, reason: 'QA mover' });
      eq(mv.data, { courseId: c.id, institutionId: instA.id }, 'movido');
      const [after] = await Q(`select owner_id, institution_id::text i, updated_by from public.courses where id = $1`, [c.id]);
      eq([after.owner_id, after.i, after.updated_by], [c.owner_id, instA.id, SA_ID], 'owner intacto');
      expectCode(await call(SA, 'PATCH', `/admin/courses/999999/institution`, { institutionId: instA.id, reason: 'x' }), 404, 'course_not_found', '404');
    });
    await check('[H13] alta a medias → 502 user_create_partial {userId} → «Reparar» completa allow-list y membresías', async () => {
      await Q(`create or replace function public.r75_test_fail() returns trigger language plpgsql as $f$ begin if new.email = 'qa-r75-parcial@example.com' then raise exception 'falla inyectada'; end if; return new; end $f$;
               create trigger r75_test_fail before insert or update on public.authorized_users for each row execute function public.r75_test_fail();`);
      const r = await call(SA, 'POST', '/admin/users', { email: 'qa-r75-parcial@example.com', mode: 'temp_password', memberships: [{ institutionId: instA.id, role: 'CONSULTA' }] });
      expectCode(r, 502, 'user_create_partial', 'parcial');
      const uid = r.body.reason;
      assert(SCH.UUID_RE.test(uid), 'userId en el error');
      const inAuth = await Q(`select 1 from auth.users where id = $1`, [uid]);
      eq(inAuth.length, 1, 'el usuario de Auth NO se borra');
      await Q(`drop trigger r75_test_fail on public.authorized_users`);
      const rep = await call(SA, 'POST', `/admin/users/${uid}/repair`);
      expectCode(rep, 200, null, 'repair');
      eq([rep.data.authorized, rep.data.memberships.map((m) => [m.institutionId, m.role])], [true, [[instA.id, 'CONSULTA']]], 'reparado');
      const rep2 = await call(SA, 'POST', `/admin/users/${uid}/repair`);
      eq(rep2.data.memberships.length, 1, 'repair idempotente');
    });
    await check('[H14] auditoría: cada acción quedó registrada, paginada por cursor, y NINGUNA contraseña temporal en logs, auditoría ni base', async () => {
      const page1 = await call(SA, 'GET', '/admin/audit-log?limit=5');
      eq(page1.data.items.length, 5, 'página');
      assert(page1.data.nextCursor, 'cursor');
      const page2 = await call(SA, 'GET', `/admin/audit-log?limit=5&cursor=${page1.data.nextCursor}`);
      assert(page2.data.items[0].id < page1.data.items[4].id, 'orden');
      const actions = new Set((await Q(`select distinct action from public.admin_audit_log`)).map((x) => x.action));
      for (const a of ['user.create', 'user.authorize', 'user.create_partial', 'user.repair', 'membership.add', 'membership.update', 'membership.remove', 'membership.reactivate',
        'override.set', 'institution.create', 'institution.update', 'course.move_institution', 'suspension.create', 'suspension.lift', 'suspension.account_effects', 'platform.generation_freeze']) {
        assert(actions.has(a), 'falta la acción ' + a);
      }
      const byActor = await call(SA, 'GET', `/admin/audit-log?actorId=${users.adminA.id}`);
      assert(byActor.data.items.length > 0 && byActor.data.items.every((i) => i.actorId === users.adminA.id), 'filtro actor');
      expectCode(await call(T().adminA, 'GET', '/admin/audit-log'), 403, null, 'no SA');
      const dump = (await Q(`select string_agg(t::text, ' ') d from (
        select a::text t from public.admin_audit_log a union all select u::text from public.authorized_users u
        union all select m::text from public.institution_memberships m union all select s::text from public.user_suspensions s
        union all select x::text from auth.users x) z`))[0].d;
      const logs = captured.join('\n');
      for (const pw of passwords) {
        assert(!dump.includes(pw), 'contraseña temporal en la base');
        assert(!logs.includes(pw), 'contraseña temporal en logs');
      }
      assert(!logs.includes('fake-service-role-local-only'), 'service key en logs');
    });
  } finally {
    try { if (app) await app.close(); } catch { /* */ }
    try { if (fake) fake.srv.close(); } catch { /* */ }
    try { if (admin) await admin.end(); } catch { /* */ }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
}

(async () => {
  await unitChecks();
  await dbChecks();
  console.log(`\n${failures ? '❌' : '✅'} r75 access: ${passes} OK, ${failures} fallas`);
  process.exit(failures ? 1 : 0);
})().catch((err) => { origConsole.error('❌ Error inesperado:', err && err.stack ? err.stack : err); process.exit(1); });
