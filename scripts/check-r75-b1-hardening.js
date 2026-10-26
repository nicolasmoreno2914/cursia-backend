#!/usr/bin/env node
/* eslint-disable no-console */
// r75 · B1 (endurecimiento, agente B). PG16 DESCARTABLE + app Nest mínima con los controllers REALES (auth/me,
// features, health, video-engine) + Videogen falso en 127.0.0.1. Sin red externa, sin cuentas reales, USD 0.
//
//   [J]  H9: aud / iss / role del JWT (jwtClaimProblem + SupabaseJwtGuard): aud ajeno, role anon/service_role → 401;
//        sin aud (harness viejos) → ok; iss solo con SUPABASE_JWT_ISSUER.
//   [F]  flags CURSIA_ACCOUNT_GUARD / CURSIA_RBAC_MODE: default off; typo → off.
//   [U]  H4 / D-26: ALLOW_UNOWNED_COURSES solo en development y sin RBAC enforce; fuera de development la app NO arranca;
//        CoursesService ya no expone cursos sin dueño en producción aunque el flag esté en true.
//   [G]  H1: AccountAccessGuard sobre HTTP: off (sin cambios) · shadow (deja pasar + admin_audit_log) · enforce
//        (403 account_not_authorized / account_suspended, 503 si no se puede verificar); por email / user_id / status;
//        suspensión de A (user_suspensions); email sin confirmar; SuperAdmin; /auth/me y /features siempre; rutas
//        públicas / sin JWT intactas; 401 igual que antes; caché 30 s + invalidate.
//   [H3] video-engine status / batch-status: ids de OTRO usuario → 404 video_engine_not_found (0 llamadas a Videogen);
//        propios (registro del proxy, V2 generation_item_runs, legacy production_jobs) → 200; SA → cualquiera;
//        POST /events no puede forjar el registro (server.* reservado).
//   [H8] a: job legacy con el id numérico de un curso ajeno → 404 course_not_found (antes saltaba el 409 R68);
//        b: POST /artifacts con course_id ajeno / job_id ajeno / no-UUID / metadata enorme → rechazo antes de registrar;
//        c: POST /events con course_id ajeno → se guarda null + courseIdRejected.
//   [H9] ParseUUIDPipe en jobs/:id y brand-profiles/:id (400, no 500); YouTube: el redirect no refleja texto arbitrario.
// Todo corre dos veces: tipos de staging y tipos de PRODUCCIÓN (E2E_PROD_COLUMN_TYPES=1: owner_id uuid / course_id text).
//
// Uso: npm run build && node scripts/check-r75-b1-hardening.js
'use strict';
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const REPO = path.resolve(__dirname, '..');
const distRoot = path.join(REPO, 'dist');
const L = (rel) => { try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar dist/${rel} (¿npm run build?): ${err.message}`); process.exit(1); } };
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (/^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };
const { Logger, Module, Global } = require('@nestjs/common');
Logger.overrideLogger(false);
const jwt = require('jsonwebtoken');
const { startPg } = require('./lib/r75-pg');

let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
async function rejects(fn, code, m) {
  try { await fn(); } catch (e) { const got = (e && e.response && e.response.code) || (e && e.code) || e.constructor.name; if (code && got !== code) throw new Error(`${m}: código esperado ${code}, encontrado ${got}`); return e; }
  throw new Error(`${m}: no lanzó`);
}

const SECRET = 'r75-b1-local-secret-never-real';
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const SUSP = '44444444-4444-4444-8444-444444444444';
const UNCONF = '55555555-5555-4555-8555-555555555555';
const ADMIN = '66666666-6666-4666-8666-666666666666';
const tok = (sub, email, extra = {}) => jwt.sign({ sub, email, role: 'authenticated', aud: 'authenticated', ...extra }, SECRET, { algorithm: 'HS256', expiresIn: 600 });

const ENV_KEYS = ['SUPABASE_JWT_SECRET', 'SUPABASE_URL', 'SUPER_ADMIN_EMAILS', 'SUPER_ADMIN_EMAIL_VERIFICATION', 'CURSIA_ACCOUNT_GUARD', 'CURSIA_RBAC_MODE', 'ALLOW_UNOWNED_COURSES', 'NODE_ENV',
  'VIDEOGEN_API_URL', 'VIDEOGEN_API_KEY', 'VIDEO_ENGINE_ENABLED', 'VIDEO_ENGINE_ALLOWED_OWNERS', 'SUPABASE_JWT_AUDIENCE', 'SUPABASE_JWT_ISSUER', 'SUPABASE_JWT_REQUIRE_AUD', 'FINOPS_KILL_SWITCH', 'FINOPS_PROVIDER_ALLOWLIST'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function restoreEnv() { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }

// ─── puros ───────────────────────────────────────────────────────────────────
async function pureChecks() {
  const { jwtClaimProblem } = L('auth/supabase-jwt.guard.js');
  const F = L('modules/authz/authz-flags.js');
  const U = L('modules/authz/unowned-courses.js');
  const P = L('modules/authz/permissions.js');
  const Y = L('youtube/youtube.controller.js');
  const VE = L('video-engine/video-engine-access.js');
  const AC = L('modules/authz/access-context.js');

  await check('[J] aud: authenticated ok; aud ajeno → rechazo; array con authenticated ok; sin aud ok salvo SUPABASE_JWT_REQUIRE_AUD', () => {
    eq(jwtClaimProblem({ aud: 'authenticated' }, {}), null, 'aud ok');
    assert(jwtClaimProblem({ aud: 'otro' }, {}), 'aud ajeno');
    eq(jwtClaimProblem({ aud: ['x', 'authenticated'] }, {}), null, 'array');
    eq(jwtClaimProblem({}, {}), null, 'sin aud (compat)');
    assert(jwtClaimProblem({}, { SUPABASE_JWT_REQUIRE_AUD: 'true' }), 'sin aud estricto');
  });
  await check('[J] iss: solo se valida con SUPABASE_JWT_ISSUER (sin él, no corta aunque difiera de SUPABASE_URL); role anon / service_role → rechazo', () => {
    eq(jwtClaimProblem({ aud: 'authenticated', iss: 'https://evil/auth/v1' }, { SUPABASE_URL: 'https://p.supabase.co' }), null, 'sin issuer explícito');
    assert(jwtClaimProblem({ aud: 'authenticated', iss: 'https://evil/auth/v1' }, { SUPABASE_JWT_ISSUER: 'https://p.supabase.co/auth/v1' }), 'iss ajeno');
    eq(jwtClaimProblem({ aud: 'authenticated', iss: 'https://p.supabase.co/auth/v1/' }, { SUPABASE_JWT_ISSUER: 'https://p.supabase.co/auth/v1' }), null, 'iss ok');
    assert(jwtClaimProblem({ aud: 'authenticated' , iss: undefined }, { SUPABASE_JWT_ISSUER: 'https://p.supabase.co/auth/v1' }), 'iss faltante con issuer explícito');
    assert(jwtClaimProblem({ aud: 'authenticated', role: 'anon' }, {}), 'anon');
    assert(jwtClaimProblem({ aud: 'authenticated', role: 'service_role' }, {}), 'service_role');
  });
  await check('[F] flags: default off; shadow / enforce; typo → off (nunca enforce por error)', () => {
    eq(F.accountGuardMode({}), 'off', 'default');
    eq(F.accountGuardMode({ CURSIA_ACCOUNT_GUARD: 'shadow' }), 'shadow', 'shadow');
    eq(F.accountGuardMode({ CURSIA_ACCOUNT_GUARD: 'ENFORCE' }), 'enforce', 'enforce');
    eq(F.accountGuardMode({ CURSIA_ACCOUNT_GUARD: 'enforec' }), 'off', 'typo');
    eq(F.rbacMode({ CURSIA_RBAC_MODE: 'shadow' }), 'shadow', 'rbac');
  });
  await check('[U] D-26: ALLOW_UNOWNED_COURSES=true solo cuenta en development y sin RBAC enforce; fuera de development el assert impide arrancar', () => {
    eq(U.allowUnownedCourses({ ALLOW_UNOWNED_COURSES: 'true', NODE_ENV: 'production' }), false, 'prod');
    eq(U.allowUnownedCourses({ ALLOW_UNOWNED_COURSES: 'true' }), false, 'sin NODE_ENV');
    eq(U.allowUnownedCourses({ ALLOW_UNOWNED_COURSES: 'true', NODE_ENV: 'development' }), true, 'dev');
    eq(U.allowUnownedCourses({ ALLOW_UNOWNED_COURSES: 'true', NODE_ENV: 'development', CURSIA_RBAC_MODE: 'enforce' }), false, 'dev + enforce');
    let e = null; try { U.assertUnownedCoursesSafe({ ALLOW_UNOWNED_COURSES: 'true', NODE_ENV: 'production' }); } catch (x) { e = x; }
    assert(e && /allow_unowned_courses_unsafe/.test(e.message), 'assert prod');
    U.assertUnownedCoursesSafe({ ALLOW_UNOWNED_COURSES: 'true', NODE_ENV: 'development' });
    U.assertUnownedCoursesSafe({ NODE_ENV: 'production' });
  });
  await check('[U] D-26: ningún lector del flag quedó leyendo process.env.ALLOW_UNOWNED_COURSES directo', () => {
    const { execSync } = require('child_process');
    const out = execSync(`grep -rn "process.env.ALLOW_UNOWNED_COURSES" ${path.join(REPO, 'src')} || true`, { encoding: 'utf8' }).trim();
    eq(out, '', 'lecturas directas');
  });
  await check('[P] catálogo: 14 permisos, 4 roles, matriz 01 §2.2 (D-8: admin sin approve/start; D-9: consulta sin download; D-7: globales no otorgables)', () => {
    eq(P.PERMISSIONS.length, 14, 'permisos'); eq(P.ROLES.length, 4, 'roles');
    assert(!P.roleHasPermission('ADMIN_INSTITUCIONAL', 'proposals.approve') && !P.roleHasPermission('ADMIN_INSTITUCIONAL', 'generations.start'), 'D-8');
    assert(!P.roleHasPermission('CONSULTA', 'exports.download') && P.roleHasPermission('CONSULTA', 'courses.view'), 'D-9');
    assert(P.roleHasPermission('APROBADOR_ACADEMICO', 'proposals.approve') && P.roleHasPermission('CREADOR', 'generations.start'), 'roles');
    for (const g of ['budgets.manage', 'users.suspend', 'generations.suspend']) assert(!P.isGrantablePermission(g) && P.ROLES.every((r) => !P.roleHasPermission(r, g)), `D-7 ${g}`);
    const view = P.permissionCatalogView(); eq(view.permissions.length, 14, 'vista');
  });
  await check('[AC] access_context_missing: effectiveOwnerId vacío / sin usuario → 500 (cierra findOne(id, undefined))', async () => {
    await rejects(async () => AC.assertAccessContext({ actorId: ME, effectiveOwnerId: '' }), 'access_context_missing', 'vacío');
    await rejects(async () => AC.legacyAccessContext(null, false), 'access_context_missing', 'sin user');
    eq(AC.legacyAccessContext({ id: ME, email: 'a@b' }, false).effectiveOwnerId, ME, 'legacy = actor');
  });
  await check('[H9] YouTube: el redirect solo lleva códigos fijos (el error de Google / el mensaje interno no se reflejan)', () => {
    eq(Y.youtubeOauthErrorCode('access_denied'), 'access_denied', 'conocido');
    eq(Y.youtubeOauthErrorCode('<script>alert(1)</script>'), 'oauth_error', 'arbitrario');
    eq(Y.youtubeCallbackFailureCode(new Error('db password=xyz')), 'callback_failed', 'interno');
  });
  await check('[H3] ids de la respuesta de Videogen (create / batch-create) se extraen sin aceptar basura', () => {
    eq(VE.videoEngineIdsFromResponse({ batch_id: 'b1', jobs: [{ job_id: 'j1' }, { job_id: 'j 2' }], videos: [{ job_id: 'j3' }] }), { jobIds: ['j1', 'j3'], batchId: 'b1' }, 'ids');
    eq(VE.videoEngineIdsFromResponse(null), { jobIds: [], batchId: null }, 'null');
  });
  await check('[H9] ParseUUIDPipe en jobs/:id y brand-profiles/:id (antes un id no-UUID daba 500 en la columna uuid)', () => {
    const fs = require('fs');
    for (const f of ['src/modules/production-jobs/production-jobs.controller.ts', 'src/modules/brand-profiles/brand-profiles.controller.ts']) {
      const s = fs.readFileSync(path.join(REPO, f), 'utf8');
      assert(!/@Param\('(id|institutionId)'\)/.test(s), `${f}: @Param sin pipe`);
    }
  });
}

// ─── app Nest mínima ─────────────────────────────────────────────────────────
async function makeApp(ds, opts = {}) {
  const { NestFactory } = require('@nestjs/core');
  const { DataSource } = require('typeorm');
  const { AuthzModule } = L('modules/authz/authz.module.js');
  const { AuthController } = L('auth/auth.controller.js');
  const { FeaturesController } = L('modules/features/features.controller.js');
  const { AppController } = L('app.controller.js');
  const { AppService } = L('app.service.js');
  const { VideoEngineController } = L('video-engine/video-engine.controller.js');
  class DbModule {}
  Global()(DbModule);
  Module({ providers: [{ provide: DataSource, useValue: ds }], exports: [DataSource] })(DbModule);
  class TestModule {}
  Module({ imports: [DbModule, AuthzModule], controllers: [AuthController, FeaturesController, AppController, VideoEngineController], providers: [AppService, ...(opts.providers || [])] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  const base = url.replace('[::1]', '127.0.0.1');
  const api = async (method, p, token, body) => {
    const r = await realFetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  return { app, api, close: () => app.close() };
}

async function fakeVideogen() {
  const st = { calls: [] };
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    st.calls.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.includes('/batch-create')) return res.end(JSON.stringify({ batch_id: 'batch-new-1', jobs: [{ job_id: 'job-new-1' }, { job_id: 'job-new-2' }] }));
    if (req.url.includes('/create')) return res.end(JSON.stringify({ job_id: 'job-new-3', status: 'queued' }));
    return res.end(JSON.stringify({ status: 'completed', download_url: 'https://render/' + req.url }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, st, close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => r()); }) };
}

async function dbChecks(prodTypes) {
  const tag = prodTypes ? '[prod-types]' : '[staging-types]';
  const { DataSource } = require('typeorm');
  const pg = await startPg({ prodTypes, withATables: false });
  L('modules/authz/schema-probe.js').resetSchemaProbeCacheForTests();
  const { Course } = L('modules/courses/entities/course.entity.js');
  const { CourseVersion } = L('modules/course-versions/entities/course-version.entity.js');
  const { Institution } = L('modules/institutions/entities/institution.entity.js');
  const ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port: pg.port, username: 'postgres', database: pg.db, entities: [Course, CourseVersion, Institution], synchronize: false });
  await ds.initialize();
  const q = (sql, p) => ds.query(sql, p);
  const vg = await fakeVideogen();
  let appCtx = null;
  try {
    Object.assign(process.env, { SUPABASE_JWT_SECRET: SECRET, SUPER_ADMIN_EMAILS: 'admin@cursia.test', SUPER_ADMIN_EMAIL_VERIFICATION: 'off', NODE_ENV: 'production',
      VIDEOGEN_API_URL: vg.url, VIDEOGEN_API_KEY: 'fake-videogen-key-local', VIDEO_ENGINE_ENABLED: 'true', VIDEO_ENGINE_ALLOWED_OWNERS: `${ME},${OTHER}` });
    delete process.env.CURSIA_ACCOUNT_GUARD; delete process.env.CURSIA_RBAC_MODE; delete process.env.ALLOW_UNOWNED_COURSES; delete process.env.SUPABASE_URL;
    // Allow-list: ME y OTHER por email; SUSP suspendido (status); UNCONF por email sin confirmar; STRANGER no está.
    await q(`insert into public.authorized_users (email) values ('me@x.test'), ('other@x.test'), ('susp@x.test'), ('unconf@x.test')`);
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1,'me@x.test',now()), ($2,'other@x.test',now()), ($3,'susp@x.test',now()), ($4,'unconf@x.test',null)`, [ME, OTHER, SUSP, UNCONF]);
    appCtx = await makeApp(ds);
    const { api } = appCtx;
    const T = { me: tok(ME, 'me@x.test'), other: tok(OTHER, 'other@x.test'), stranger: tok(STRANGER, 'stranger@x.test'), susp: tok(SUSP, 'susp@x.test'), unconf: tok(UNCONF, 'unconf@x.test'), admin: tok(ADMIN, 'admin@cursia.test') };
    const accounts = appCtx.app.get(L('modules/authz/account-access.service.js').AccountAccessService);
    const VE_STATUS = (id) => ({ action: 'status', payload: { job_id: id } });

    await check(`${tag} [G] off (default): un usuario FUERA de la allow-list sigue entrando (sin cambios); 401 sin token / token inválido como siempre`, async () => {
      eq((await api('GET', '/api/v1/auth/me', T.stranger)).status, 200, 'auth/me');
      eq((await api('POST', '/api/v1/video-engine', T.stranger, { action: 'create', payload: { dryRun: true } })).status, 200, 'video-engine dry-run');
      eq((await api('POST', '/api/v1/video-engine', null, { action: 'auth-test' })).status, 401, 'sin token');
      eq((await api('POST', '/api/v1/video-engine', jwt.sign({ sub: ME }, 'otro'), { action: 'auth-test' })).status, 401, 'firma ajena');
    });
    await check(`${tag} [J] H9: aud ajeno / role anon → 401; sin aud → ok`, async () => {
      eq((await api('GET', '/api/v1/auth/me', tok(ME, 'me@x.test', { aud: 'otro' }))).status, 401, 'aud');
      eq((await api('GET', '/api/v1/auth/me', tok(ME, 'me@x.test', { role: 'anon' }))).status, 401, 'anon');
      eq((await api('GET', '/api/v1/auth/me', jwt.sign({ sub: ME, email: 'me@x.test' }, SECRET))).status, 200, 'sin aud');
    });

    process.env.CURSIA_ACCOUNT_GUARD = 'shadow';
    accounts.invalidate();
    await check(`${tag} [G] shadow: deja pasar al no autorizado y registra account_guard.shadow_deny en admin_audit_log (sin cortar nada)`, async () => {
      const r = await api('POST', '/api/v1/video-engine', T.stranger, { action: 'create', payload: { dryRun: true } });
      eq(r.status, 200, 'pasa');
      await new Promise((res) => setTimeout(res, 100));
      const rows = await q(`select action, actor_id::text as actor, after from public.admin_audit_log where action = 'account_guard.shadow_deny'`);
      assert(rows.some((x) => x.actor === STRANGER && x.after.status === 'not_authorized'), `audit ${JSON.stringify(rows)}`);
    });

    process.env.CURSIA_ACCOUNT_GUARD = 'enforce';
    accounts.invalidate();
    await check(`${tag} [G] enforce: fuera de la allow-list → 403 account_not_authorized en TODA ruta JWT; /auth/me y /features responden igual`, async () => {
      const r = await api('POST', '/api/v1/video-engine', T.stranger, { action: 'create', payload: { dryRun: true } });
      eq([r.status, r.body && r.body.code], [403, 'account_not_authorized'], 'video-engine');
      eq((await api('GET', '/api/v1/auth/me', T.stranger)).status, 200, 'auth/me');
      eq((await api('GET', '/api/v1/features', T.stranger)).status, 200, 'features');
    });
    await check(`${tag} [G] enforce: en la allow-list por email (confirmado) → 200; suspendido (status) → 403 account_suspended; email sin confirmar → 403`, async () => {
      eq((await api('POST', '/api/v1/video-engine', T.me, { action: 'create', payload: { dryRun: true } })).status, 200, 'me');
      const s = await api('POST', '/api/v1/video-engine', T.susp, { action: 'create', payload: { dryRun: true } });
      eq(s.status, 200, 'status sin columna todavía: activo');
      const u = await api('POST', '/api/v1/video-engine', T.unconf, { action: 'create', payload: { dryRun: true } });
      eq([u.status, u.body && u.body.code], [403, 'account_not_authorized'], 'sin confirmar');
    });
    await check(`${tag} [G] enforce: rutas públicas (/health, /api/v1) sin token siguen 200; 401 sin token en rutas JWT (no 403)`, async () => {
      eq((await api('GET', '/health')).status, 200, 'health');
      eq((await api('GET', '/api/v1')).status, 200, 'root');
      eq((await api('POST', '/api/v1/video-engine', null, { action: 'auth-test' })).status, 401, 'sin token');
    });
    await check(`${tag} [G] enforce: SuperAdmin (env) entra aunque no tenga fila en authorized_users`, async () => {
      eq((await api('POST', '/api/v1/video-engine', T.admin, { action: 'create', payload: { dryRun: true } })).status, 200, 'admin');
    });
    await check(`${tag} [G] enforce + columnas de A (user_id, status) + user_suspensions: por user_id; status=suspended y suspensión activa → account_suspended; levantar + invalidate → 200`, async () => {
      const { resetSchemaProbeCacheForTests } = L('modules/authz/schema-probe.js');
      await q(`alter table public.authorized_users add column if not exists user_id uuid, add column if not exists status text default 'active'`);
      await q(`create table if not exists public.user_suspensions (id uuid primary key default gen_random_uuid(), user_id uuid not null, kind text not null, reason text not null, created_by uuid not null, created_at timestamptz not null default now(), lifted_by uuid, lifted_at timestamptz, lift_reason text)`);
      resetSchemaProbeCacheForTests(); accounts.invalidate();
      await q(`update public.authorized_users set status = 'suspended' where email = 'susp@x.test'`);
      const s = await api('POST', '/api/v1/video-engine', T.susp, { action: 'create', payload: { dryRun: true } });
      eq([s.status, s.body && s.body.code], [403, 'account_suspended'], 'status suspended');
      // por user_id: STRANGER con fila ligada por user_id aunque el email sea otro
      await q(`insert into public.authorized_users (email, user_id) values ('alias@x.test', $1)`, [STRANGER]);
      accounts.invalidate();
      eq((await api('POST', '/api/v1/video-engine', T.stranger, { action: 'create', payload: { dryRun: true } })).status, 200, 'por user_id');
      // una fila por email ligada a OTRO user_id no autoriza (email reciclado)
      await q(`update public.authorized_users set user_id = $1 where email = 'other@x.test'`, [STRANGER]);
      accounts.invalidate();
      const o = await api('POST', '/api/v1/video-engine', T.other, { action: 'create', payload: { dryRun: true } });
      eq([o.status, o.body && o.body.code], [403, 'account_not_authorized'], 'email ligado a otro usuario');
      await q(`update public.authorized_users set user_id = $1 where email = 'other@x.test'`, [OTHER]);
      await q(`insert into public.user_suspensions (user_id, kind, reason, created_by) values ($1, 'account', 'qa', $2)`, [ME, ADMIN]);
      accounts.invalidate();
      const m = await api('POST', '/api/v1/video-engine', T.me, { action: 'create', payload: { dryRun: true } });
      eq([m.status, m.body && m.body.code], [403, 'account_suspended'], 'user_suspensions');
      eq((await api('GET', '/api/v1/auth/me', T.me)).status, 200, 'auth/me suspendido');
      await q(`update public.user_suspensions set lifted_at = now(), lifted_by = $2 where user_id = $1`, [ME, ADMIN]);
      eq((await api('POST', '/api/v1/video-engine', T.me, { action: 'create', payload: { dryRun: true } })).status, 403, 'caché 30 s: sigue suspendido hasta invalidar');
      accounts.invalidate(ME);
      eq((await api('POST', '/api/v1/video-engine', T.me, { action: 'create', payload: { dryRun: true } })).status, 200, 'levantada');
      eq((await api('POST', '/api/v1/video-engine', T.other, { action: 'create', payload: { dryRun: true } })).status, 200, 'other');
    });
    await check(`${tag} [G] enforce: sin authorized_users (base local / caída) → 503 account_check_unavailable (falla cerrada, nunca deja pasar)`, async () => {
      const { resetSchemaProbeCacheForTests } = L('modules/authz/schema-probe.js');
      await q(`alter table public.authorized_users rename to authorized_users_off`);
      resetSchemaProbeCacheForTests(); accounts.invalidate();
      const r = await api('POST', '/api/v1/video-engine', T.me, { action: 'create', payload: { dryRun: true } });
      eq([r.status, r.body && r.body.code], [503, 'account_check_unavailable'], '503');
      await q(`alter table public.authorized_users_off rename to authorized_users`);
      resetSchemaProbeCacheForTests(); accounts.invalidate();
      eq((await api('POST', '/api/v1/video-engine', T.me, { action: 'create', payload: { dryRun: true } })).status, 200, 'vuelve');
    });

    // ── H3 ──
    await check(`${tag} [H3] create / batch-create reales registran los ids del render a nombre de quien los pidió`, async () => {
      eq((await api('POST', '/api/v1/video-engine', T.me, { action: 'batch-create', payload: { videos: [{}] } })).status, 200, 'batch');
      eq((await api('POST', '/api/v1/video-engine', T.other, { action: 'create', payload: {} })).status, 200, 'create');
      const rows = await q(`select user_id::text as u, metadata from public.usage_events where event_type = 'server.video_engine_render' order by created_at`);
      eq(rows.map((r) => [r.u, r.metadata.jobIds, r.metadata.batchId]), [[ME, ['job-new-1', 'job-new-2'], 'batch-new-1'], [OTHER, ['job-new-3'], null]], 'registro');
    });
    await check(`${tag} [H3] status / batch-status de un render AJENO → 404 video_engine_not_found y 0 llamadas a Videogen; propio → 200`, async () => {
      const before = vg.st.calls.length;
      const a = await api('POST', '/api/v1/video-engine', T.other, VE_STATUS('job-new-1'));
      eq([a.status, a.body && a.body.code], [404, 'video_engine_not_found'], 'job ajeno');
      const b = await api('POST', '/api/v1/video-engine', T.other, { action: 'batch-status', payload: { batch_id: 'batch-new-1' } });
      eq([b.status, b.body && b.body.code], [404, 'video_engine_not_found'], 'batch ajeno');
      const c = await api('POST', '/api/v1/video-engine', T.other, VE_STATUS('no-existe-123'));
      eq(c.status, 404, 'inexistente');
      eq(vg.st.calls.length, before, 'sin llamadas');
      eq((await api('POST', '/api/v1/video-engine', T.me, VE_STATUS('job-new-2'))).status, 200, 'propio job');
      eq((await api('POST', '/api/v1/video-engine', T.me, { action: 'batch-status', payload: { batch_id: 'batch-new-1' } })).status, 200, 'propio batch');
      eq((await api('POST', '/api/v1/video-engine', T.other, VE_STATUS('job-new-3'))).status, 200, 'other propio');
      eq((await api('POST', '/api/v1/video-engine', T.other, { action: 'status', payload: {} })).status, 400, 'sin id → 400');
    });
    await check(`${tag} [H3] V2 (generation_item_runs.external.videogenJobId) y legacy (production_jobs.output_summary.videogenJobs) del usuario → 200; de otro → 404; SA → cualquiera`, async () => {
      const [c] = await q(`insert into public.courses (owner_id, title, structure_version) values ($1, 'V2', 'dynamic') returning id`, [ME]);
      const [j] = await q(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, output_summary) values ($1, $2, 'dynamic_generation', 'running', '{}') returning id`, [ME, prodTypes ? String(c.id) : c.id]);
      // fila mínima de generation_item_runs (las FKs a blueprint/manifest se desactivan solo para esta prueba)
      await q(`alter table public.generation_item_runs disable trigger all`);
      await q(`insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, type, module_id, chapter_id, idempotency_key, output_summary)
               values ($1, $2, 1, 1, 'video:1', 'video', gen_random_uuid(), gen_random_uuid(), repeat('a', 64), $3::jsonb)`, [j.id, c.id, JSON.stringify({ external: { videogenJobId: 'v2-job-1', videogenBatchId: 'v2-batch-1' } })]);
      await q(`alter table public.generation_item_runs enable trigger all`);
      await q(`insert into public.production_jobs (owner_id, execution_mode, status, output_summary) values ($1, 'backend_videos', 'running', $2::jsonb)`, [OTHER, JSON.stringify({ phase: 'polling', batchId: 'legacy-batch-9', videogenJobs: [{ jobId: 'legacy-job-9', cap: 1 }] })]);
      eq((await api('POST', '/api/v1/video-engine', T.me, VE_STATUS('v2-job-1'))).status, 200, 'v2 propio');
      eq((await api('POST', '/api/v1/video-engine', T.me, { action: 'batch-status', payload: { batch_id: 'v2-batch-1' } })).status, 200, 'v2 batch propio');
      eq((await api('POST', '/api/v1/video-engine', T.other, VE_STATUS('v2-job-1'))).status, 404, 'v2 ajeno');
      eq((await api('POST', '/api/v1/video-engine', T.other, VE_STATUS('legacy-job-9'))).status, 200, 'legacy propio');
      eq((await api('POST', '/api/v1/video-engine', T.other, { action: 'batch-status', payload: { batch_id: 'legacy-batch-9' } })).status, 200, 'legacy batch propio');
      eq((await api('POST', '/api/v1/video-engine', T.me, VE_STATUS('legacy-job-9'))).status, 404, 'legacy ajeno');
      eq((await api('POST', '/api/v1/video-engine', T.admin, VE_STATUS('legacy-job-9'))).status, 200, 'SA');
    });
    await check(`${tag} [H3] POST /events no puede forjar el registro: event_type server.* → 400 event_type_reserved`, async () => {
      const { EventsService } = L('events/events.service.js');
      const svc = new EventsService({ query: q, create: (x) => x, save: async (x) => ({ id: 'e1', ...x }) }, { async resolveCostEstimate() { return null; } });
      await rejects(() => svc.create({ event_type: 'server.video_engine_render', video_job_id: 'job-new-1' }, { id: OTHER, email: 'other@x.test' }), 'event_type_reserved', 'reservado');
    });

    // ── H8 ──
    await check(`${tag} [H8a] job legacy con el id numérico de un curso AJENO (dinámico) → 404 course_not_found (antes: sin 409 R68 y job apuntando al curso de otro); propio dinámico → 409 R68; id inexistente / UUID → como antes`, async () => {
      const G = L('modules/production-jobs/legacy-audio-guard.js');
      const [vc] = await q(`insert into public.courses (owner_id, title, structure_version) values ($1, 'víctima', 'dynamic') returning id`, [OTHER]);
      await rejects(() => G.assertLegacyGenerationAllowed(q, ME, String(vc.id)), 'course_not_found', 'gen ajeno');
      await rejects(() => G.assertLegacyAudioAllowed(q, ME, vc.id), 'course_not_found', 'audio ajeno');
      await rejects(() => G.assertLegacyGenerationAllowed(q, OTHER, String(vc.id)), 'ConflictException', 'propio dinámico → 409');
      await G.assertLegacyGenerationAllowed(q, ME, '999999');
      await G.assertLegacyGenerationAllowed(q, ME, crypto.randomUUID());
      const blocked = await G.isLegacyAudioBlockedForJob({ ownerId: ME, frontendCourseId: String(vc.id) }, { assertLegacyAudioAllowedForCourse: (o, r) => G.assertLegacyAudioAllowed(q, o, r) });
      assert(blocked && blocked.startsWith('course_not_found'), `worker: ${blocked}`);
    });
    await check(`${tag} [H8b] POST /artifacts: course_id ajeno → 404; job_id ajeno → 404 job_not_found; job_id no-UUID → 400 (antes 500); metadata > 256 KB → 413; propios → ok`, async () => {
      const A = L('modules/authz/artifact-access.service.js');
      const [oc] = await q(`insert into public.courses (owner_id, title) values ($1, 'ajeno') returning id`, [OTHER]);
      const [mc] = await q(`insert into public.courses (owner_id, title) values ($1, 'mío') returning id`, [ME]);
      const [oj] = await q(`insert into public.production_jobs (owner_id, execution_mode, status) values ($1, 'frontend', 'running') returning id`, [OTHER]);
      const [mj] = await q(`insert into public.production_jobs (owner_id, execution_mode, status) values ($1, 'frontend', 'running') returning id`, [ME]);
      await rejects(() => A.validateClientArtifactRefs(q, ME, { course_id: String(oc.id) }), 'course_not_found', 'curso ajeno');
      await rejects(() => A.validateClientArtifactRefs(q, ME, { job_id: oj.id }), 'job_not_found', 'job ajeno');
      await rejects(() => A.validateClientArtifactRefs(q, ME, { job_id: 'no-es-uuid' }), 'job_id_invalid', 'no uuid');
      await rejects(() => A.validateClientArtifactRefs(q, ME, { metadata: { x: 'a'.repeat(300 * 1024) } }), 'artifact_metadata_too_large', 'metadata');
      await A.validateClientArtifactRefs(q, ME, { course_id: String(mc.id), job_id: mj.id, metadata: { a: 1 } });
      await A.validateClientArtifactRefs(q, ME, { course_id: crypto.randomUUID() });
    });
    await check(`${tag} [H8b] resolveArtifact solo liga un artifact a un curso del MISMO dueño (un UUID de curso ajeno es inerte)`, async () => {
      const R = L('modules/authz/resource-resolver.js');
      const fid = crypto.randomUUID();
      await q(`insert into public.courses (owner_id, title, metadata) values ($1, 'víctima uuid', $2::jsonb)`, [OTHER, JSON.stringify({ courseId: fid })]);
      const [a] = await q(`insert into public.artifacts (owner_id, course_id, type, storage_path) values ($1, $2, 'x', $3) returning id`, [ME, fid, `${ME}/c/x.json`]);
      const r = await R.resolveArtifact(q, a.id);
      eq(r.course, null, 'sin curso ajeno');
    });
    await check(`${tag} [H8c] POST /events con course_id de un curso ajeno → se guarda null + metadata.courseIdRejected; propio / inexistente → igual que antes`, async () => {
      const { EventsService } = L('events/events.service.js');
      const saved = [];
      const svc = new EventsService({ query: q, create: (x) => x, save: async (x) => { saved.push(x); return { id: 'e' + saved.length, ...x }; } }, { async resolveCostEstimate() { return null; } });
      const [oc] = await q(`insert into public.courses (owner_id, title) values ($1, 'ajeno ev') returning id`, [OTHER]);
      const [mc] = await q(`insert into public.courses (owner_id, title) values ($1, 'mío ev') returning id`, [ME]);
      await svc.create({ event_type: 'ia_x', course_id: String(oc.id) }, { id: ME, email: 'me@x.test' });
      await svc.create({ event_type: 'ia_x', course_id: String(mc.id) }, { id: ME, email: 'me@x.test' });
      await svc.create({ event_type: 'ia_x', course_id: 'local-v1-123' }, { id: ME, email: 'me@x.test' });
      eq(saved.map((s) => [s.courseId ?? null, s.metadata && s.metadata.courseIdRejected || null]), [[null, String(oc.id)], [String(mc.id), null], ['local-v1-123', null]], 'eventos');
    });

    // ── H4 ──
    await check(`${tag} [U] H4: CoursesService con ALLOW_UNOWNED_COURSES=true en producción NO expone cursos sin dueño (antes: legibles y escribibles por cualquiera)`, async () => {
      const { CoursesService } = L('modules/courses/courses.service.js');
      const svc = new CoursesService(ds.getRepository(Course), {});
      const [orphan] = await q(`insert into public.courses (owner_id, title) values (null, 'huérfano') returning id`);
      process.env.ALLOW_UNOWNED_COURSES = 'true';
      process.env.NODE_ENV = 'production';
      await rejects(() => svc.findOne(orphan.id, STRANGER), 'NotFoundException', 'prod');
      assert(!(await svc.findAll(STRANGER)).some((c) => c.id === orphan.id), 'findAll prod');
      process.env.NODE_ENV = 'development';
      eq((await svc.findOne(orphan.id, STRANGER)).id, orphan.id, 'dev (comportamiento de desarrollo conservado)');
      process.env.CURSIA_RBAC_MODE = 'enforce';
      await rejects(() => svc.findOne(orphan.id, STRANGER), 'NotFoundException', 'dev + enforce');
      delete process.env.CURSIA_RBAC_MODE; delete process.env.ALLOW_UNOWNED_COURSES; process.env.NODE_ENV = 'production';
    });
  } finally {
    if (appCtx) await appCtx.close().catch(() => {});
    await vg.close();
    await ds.destroy().catch(() => {});
    pg.stop();
    restoreEnv();
  }
}

async function bootChecks() {
  await check('[U] D-26: con ALLOW_UNOWNED_COURSES=true y NODE_ENV=production, un módulo con AuthzModule NO arranca', async () => {
    const { NestFactory } = require('@nestjs/core');
    const { AuthzModule } = L('modules/authz/authz.module.js');
    const { DataSource } = require('typeorm');
    class DbModule {} Global()(DbModule); Module({ providers: [{ provide: DataSource, useValue: { query: async () => [] } }], exports: [DataSource] })(DbModule);
    class M {} Module({ imports: [DbModule, AuthzModule] })(M);
    process.env.ALLOW_UNOWNED_COURSES = 'true'; process.env.NODE_ENV = 'production';
    let err = null;
    try { const app = await NestFactory.createApplicationContext(M, { logger: false, abortOnError: false }); await app.close(); } catch (e) { err = e; }
    restoreEnv();
    assert(err && /allow_unowned_courses_unsafe/.test(String(err.message || err)), `debía fallar: ${err}`);
  });
}

(async () => {
  try {
    await pureChecks();
    await bootChecks();
    await dbChecks(false);
    await dbChecks(true);
  } catch (err) {
    failures++;
    console.error('❌ error inesperado', err);
  }
  global.fetch = realFetch;
  console.log(`\n${passes} OK, ${failures} fallas`);
  process.exit(failures ? 1 : 0);
})();
