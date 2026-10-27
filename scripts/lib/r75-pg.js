/* eslint-disable */
// r75 (agente B): Postgres 16 DESCARTABLE para las pruebas de autorización (initdb en un dir temporal, 127.0.0.1,
// puerto libre, sin red). Esquema: línea base legacy + estructura dinámica + blueprints + manifests + constraints de
// production_jobs + generation_item_runs. `prodTypes: true` aplica la deriva de tipos de producción (Orbia) igual que
// E2E_PROD_COLUMN_TYPES=1 (production_jobs.course_id text / owner_id uuid; artifacts.owner_id uuid).
// Más las tablas del contrato r75 que B LEE (las crea A; acá solo para la prueba local): authorized_users (+user_id,
// status), user_suspensions, admin_audit_log, institution_memberships, institution_permission_overrides,
// platform_controls, columnas nuevas de institutions/courses, y un stub de auth.users.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');

function findPgBin() {
  const cands = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean);
  for (const d of cands) {
    const pg = path.join(d, 'postgres');
    if (!fs.existsSync(pg)) continue;
    const v = spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '';
    if (/\b1[6-9]\./.test(v)) return d;
  }
  throw new Error('No encontré Postgres ≥16 (setear PG_BIN)');
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

/** SQL de las tablas r75 del contrato (01 §1.1–1.7), la parte que B lee. Idempotente. */
const R75_CONTRACT_SQL = `
create table if not exists public.authorized_users (
  id uuid primary key default gen_random_uuid(), email text unique not null, is_admin boolean default false,
  created_at timestamptz default now());
create table if not exists auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
create table if not exists public.admin_audit_log (
  id bigserial primary key, at timestamptz not null default now(), actor_id uuid not null, actor_email text,
  actor_is_superadmin boolean not null, action text not null, target_type text not null, target_id text,
  institution_id uuid, before jsonb, after jsonb, request_id text, ip_hash text);
`;

const R75_A_TABLES_SQL = `
alter table public.authorized_users add column if not exists user_id uuid, add column if not exists status text default 'active';
alter table public.institutions
  add column if not exists kind text not null default 'organization',
  add column if not exists status text not null default 'active',
  add column if not exists created_by varchar(36);
alter table public.courses
  add column if not exists created_by varchar(36), add column if not exists updated_by varchar(36),
  add column if not exists approved_by varchar(36), add column if not exists approved_at timestamptz,
  add column if not exists generated_by varchar(36), add column if not exists generated_at timestamptz;
create table if not exists public.institution_memberships (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete restrict,
  user_id uuid not null,
  role text not null check (role in ('ADMIN_INSTITUCIONAL','CREADOR','APROBADOR_ACADEMICO','CONSULTA')),
  status text not null default 'active' check (status in ('active','suspended','removed')),
  created_by uuid, created_at timestamptz not null default now(), updated_by uuid, updated_at timestamptz not null default now(),
  unique (institution_id, user_id));
create table if not exists public.institution_permission_overrides (
  id uuid primary key default gen_random_uuid(), institution_id uuid not null references public.institutions(id),
  user_id uuid not null, permission text not null, effect text not null check (effect in ('grant','deny')), reason text,
  created_by uuid not null, created_at timestamptz not null default now(), revoked_by uuid, revoked_at timestamptz,
  unique (institution_id, user_id, permission));
create table if not exists public.user_suspensions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, kind text not null check (kind in ('account','generation')),
  reason text not null, created_by uuid not null, created_at timestamptz not null default now(),
  lifted_by uuid, lifted_at timestamptz, lift_reason text);
create table if not exists public.platform_controls (
  key text primary key check (key in ('generation_freeze')), enabled boolean not null, reason text,
  updated_by uuid not null, updated_at timestamptz not null default now());
`;

async function startPg({ prodTypes = false, withATables = false, aMigration = false, prebrief = false } = {}) {
  const { Client } = require('pg');
  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r75b-pg-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r75b-cwd-'));
  const ROLE = 'postgres.r75blocal01';
  const DB = 'r75bdb';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
  if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
  r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
  if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
  const stop = () => { pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']); try { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch {} };
  try {
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create role "${ROLE}" superuser login`); });
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
      if (prodTypes) {
        await c.query('alter table public.production_jobs alter column course_id type text using course_id::text, alter column owner_id type uuid using owner_id::uuid; alter table public.artifacts alter column owner_id type uuid using owner_id::uuid');
      }
    });
    const res = spawnSync(process.execPath, [path.join(REPO, 'scripts/migrate-production-jobs-constraints.js')], {
      cwd: tmpCwd, env: cleanEnv({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false' }), encoding: 'utf8', timeout: 120000,
    });
    if (res.status !== 0) throw new Error('migrate-production-jobs-constraints: ' + (res.stdout || '') + (res.stderr || ''));
    await withClient(DB, async (c) => {
      await c.query(fs.readFileSync(path.join(REPO, 'supabase-migration-dynamic-generation.sql'), 'utf8'));
      // aMigration: la migración REAL de A (supabase-migration-r75-access.sql) antes del contrato (que es idempotente).
      if (aMigration) {
        await c.query('create table if not exists auth.users (id uuid primary key, email text, email_confirmed_at timestamptz)');
        await c.query(fs.readFileSync(path.join(REPO, 'supabase-migration-r75-access.sql'), 'utf8'));
      }
      await c.query(R75_CONTRACT_SQL);
      if (withATables) await c.query(R75_A_TABLES_SQL);
    });
    if (prebrief) {
      const r2 = spawnSync(process.execPath, [path.join(REPO, 'scripts/migrate-prebrief.js')], {
        cwd: tmpCwd, env: cleanEnv({ MIGRATION_ENV: 'staging', DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false' }), encoding: 'utf8', timeout: 120000,
      });
      if (r2.status !== 0) throw new Error('migrate-prebrief: ' + (r2.stdout || '') + (r2.stderr || ''));
    }
    return { port, db: DB, stop, connect: () => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: DB }); return c.connect().then(() => c); } };
  } catch (err) {
    stop();
    throw err;
  }
}

module.exports = { startPg, R75_A_TABLES_SQL, R75_CONTRACT_SQL, findPgBin, freePort, cleanEnv, REPO };
