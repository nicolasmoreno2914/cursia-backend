#!/usr/bin/env node
/* eslint-disable no-console */
// r75 · B2 (permisos, agente B). PG16 DESCARTABLE con la migración REAL de A (supabase-migration-r75-access.sql) +
// app Nest mínima: AuthzModule (+AccessModule de A) y el CoursesController REAL. Sin red, sin cuentas reales, USD 0.
//
//   [P]  puro: matriz rol × permiso (14 × 4) idéntica a 01 §2.2 y a role-matrix de A; deny > grant; grants globales (D-7)
//        sin efecto; anti-escalada (self, grant que no se tiene, rol con roles.manage, globales no otorgables, SA).
//   [M]  RBAC enforce sobre HTTP: rol × permiso × ruta (GET/PATCH/DELETE /courses/:id, GET /courses/:id/cost,
//        POST /courses, GET /courses) para ADMIN_INSTITUCIONAL / CREADOR / APROBADOR_ACADEMICO / CONSULTA, otra
//        institución (404, aislamiento), SA (todo), usuario sin membresía; created_by / institution_id / updated_by.
//   [O]  overrides: deny gana sobre grant y sobre el rol; grant de un permiso que el rol no tiene; invalidación de caché.
//   [I]  institución activa: CREADOR en A + CONSULTA en B → header A crea, header B 403, sin header 400
//        institution_required; header ≠ institución del curso → 409 institution_mismatch; institución suspendida → 403.
//   [S]  shadow: aplica la regla vieja (dueño único) y registra rbac.shadow_deny en admin_audit_log cuando difieren.
//   [F]  off: comportamiento actual (sin lecturas de membresías, sin auditoría).
//   [X]  anti-escalada con la base (PermissionService.escalationCheck) y runInitiatorSuspended (para C).
//   [C]  cobertura: todo handler de los controllers de B tiene @RequirePermission / @AuthenticatedOnly / @Public /
//        @PublicCapability / @AllowInactiveAccount / @SuperAdminOnly (los de A, C y r74 se listan aparte).
// Corre con tipos de staging y de producción (owner_id uuid / course_id text).
//
// Uso: npm run build && node scripts/check-r75-b2-permissions.js
'use strict';
const path = require('path');
const fs = require('fs');
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

const SECRET = 'r75-b2-local-secret-never-real';
const U = {
  OWN: 'a0000000-0000-4000-8000-000000000001', ADM: 'a0000000-0000-4000-8000-000000000002', CRE: 'a0000000-0000-4000-8000-000000000003',
  APR: 'a0000000-0000-4000-8000-000000000004', CON: 'a0000000-0000-4000-8000-000000000005', ADMB: 'b0000000-0000-4000-8000-000000000006',
  NOM: 'c0000000-0000-4000-8000-000000000007', SA: 'd0000000-0000-4000-8000-000000000008',
};
const EMAIL = (k) => (k === 'SA' ? 'sa@cursia.test' : `${k.toLowerCase()}@x.test`);
const tok = (k) => jwt.sign({ sub: U[k], email: EMAIL(k), role: 'authenticated', aud: 'authenticated' }, SECRET, { algorithm: 'HS256', expiresIn: 600 });
const INST_A = 'e0000000-0000-4000-8000-00000000000a';
const INST_B = 'e0000000-0000-4000-8000-00000000000b';
const ENV_KEYS = ['SUPABASE_JWT_SECRET', 'SUPER_ADMIN_EMAILS', 'SUPER_ADMIN_EMAIL_VERIFICATION', 'CURSIA_ACCOUNT_GUARD', 'CURSIA_RBAC_MODE', 'NODE_ENV', 'SUPER_ADMIN_USER_IDS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const restoreEnv = () => { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

async function pureChecks() {
  const P = L('modules/authz/permissions.js');
  const A = L('modules/access/role-matrix.js');
  const S = L('modules/authz/permission.service.js');
  const EXPECTED = {
    ADMIN_INSTITUCIONAL: ['courses.view', 'courses.create', 'courses.edit', 'courses.delete', 'proposals.review', 'generations.retry', 'exports.download', 'spend.view', 'roles.manage'],
    CREADOR: ['courses.view', 'courses.create', 'courses.edit', 'proposals.review', 'generations.start', 'generations.retry', 'exports.download'],
    APROBADOR_ACADEMICO: ['courses.view', 'proposals.review', 'proposals.approve', 'exports.download'],
    CONSULTA: ['courses.view'],
  };
  await check('[P] matriz 14 × 4 = 01 §2.2, y B usa la MISMA fuente que A (role-matrix.ts)', () => {
    assert(P.ROLE_MATRIX === A.ROLE_MATRIX && P.PERMISSIONS === A.PERMISSIONS, 'una sola fuente');
    for (const role of P.ROLES) for (const perm of P.PERMISSIONS) {
      const d = S.decidePermission({ superAdmin: false, permission: perm, institution: { id: INST_A, status: 'active' }, membership: { institutionId: INST_A, role, status: 'active', grants: [], denies: [] }, concreteResource: true });
      eq(d.allowed, EXPECTED[role].includes(perm), `${role} × ${perm}`);
    }
  });
  await check('[P] deny > grant > rol; grant global (D-7) sin efecto; SA todo; sin membresía: 404 recurso / 403 not_a_member colección', () => {
    const m = (o) => ({ institutionId: INST_A, role: 'CREADOR', status: 'active', grants: [], denies: [], ...o });
    const inst = { id: INST_A, status: 'active' };
    const d = (perm, mm, extra = {}) => S.decidePermission({ superAdmin: false, permission: perm, institution: inst, membership: mm, concreteResource: true, ...extra });
    eq(d('courses.edit', m({ grants: ['courses.edit'], denies: ['courses.edit'] })).allowed, false, 'deny > grant');
    eq(d('courses.view', m({ denies: ['courses.view'] })).code, 'permission_denied', 'deny > rol');
    eq(d('proposals.approve', m({ grants: ['proposals.approve'] })).via, 'grant', 'grant (D-5/D-10)');
    eq(d('budgets.manage', m({ grants: ['budgets.manage'] })).allowed, false, 'D-7');
    eq(d('budgets.manage', null, { superAdmin: true }).allowed, true, 'SA');
    eq(d('courses.view', null).httpStatus, 404, 'sin membresía recurso');
    eq(d('courses.view', null, { concreteResource: false }).code, 'not_a_member', 'colección');
    eq(d('courses.view', m(), { institution: { id: INST_A, status: 'suspended' } }).code, 'institution_inactive', 'inactiva');
    eq(d('courses.view', m({ status: 'suspended' })).httpStatus, 404, 'membresía suspendida');
    eq(S.effectivePermissionsOf(m({ grants: ['budgets.manage', 'spend.view'], denies: ['generations.start'] })).sort(), ['courses.create', 'courses.edit', 'courses.view', 'exports.download', 'generations.retry', 'proposals.review', 'spend.view'], 'efectivos');
  });
  await check('[P] anti-escalada: self → 403; sin roles.manage → 403; grant que no se tiene → role_escalation_forbidden; asignar rol con roles.manage → ok (decisión A, D-8); global / desconocido → 400; SA → ok', () => {
    const admin = { id: U.ADM, superAdmin: false, permissions: EXPECTED.ADMIN_INSTITUCIONAL };
    eq(S.escalationProblem({ actor: admin, targetUserId: U.ADM, grants: ['courses.view'] }).code, 'self_modification_forbidden', 'self');
    eq(S.escalationProblem({ actor: { id: U.CRE, superAdmin: false, permissions: EXPECTED.CREADOR }, targetUserId: U.CON, role: 'CONSULTA' }).code, 'permission_denied', 'sin roles.manage');
    eq(S.escalationProblem({ actor: admin, targetUserId: U.CON, grants: ['generations.start'] }).code, 'role_escalation_forbidden', 'grant no propio');
    eq(S.escalationProblem({ actor: admin, targetUserId: U.CON, role: 'CREADOR' }), null, 'rol con roles.manage');
    eq(S.escalationProblem({ actor: admin, targetUserId: U.CON, grants: ['users.suspend'] }).code, 'permission_not_grantable', 'global');
    eq(S.escalationProblem({ actor: admin, targetUserId: U.CON, grants: ['inventado'] }).code, 'permission_not_grantable', 'desconocido');
    eq(S.escalationProblem({ actor: admin, targetUserId: U.CON, role: 'SUPERADMIN' }).code, 'superadmin_role_reserved', 'SUPERADMIN');
    eq(S.escalationProblem({ actor: { id: U.SA, superAdmin: true, permissions: [] }, targetUserId: U.SA, grants: ['exports.download'] }), null, 'SA');
  });
}

async function makeApp(ds) {
  const { NestFactory } = require('@nestjs/core');
  const { DataSource } = require('typeorm');
  const { AuthzModule } = L('modules/authz/authz.module.js');
  const { CoursesController } = L('modules/courses/courses.controller.js');
  const { CoursesService } = L('modules/courses/courses.service.js');
  const { Course } = L('modules/courses/entities/course.entity.js');
  const stubDashboard = { async getCourseCost(id) { return { courseId: String(id), money: { unpriced: { count: 0, events: [] }, runs: [] } }; } };
  class DbModule {}
  Global()(DbModule);
  Module({ providers: [{ provide: DataSource, useValue: ds }], exports: [DataSource] })(DbModule);
  class TestModule {}
  Module({ imports: [DbModule, AuthzModule], controllers: [CoursesController], providers: [{ provide: CoursesService, useValue: new CoursesService(ds.getRepository(Course), stubDashboard) }] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const api = async (method, p, who, body, headers = {}) => {
    const r = await realFetch(base + p, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: 'Bearer ' + tok(who) } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  return { app, api };
}

async function dbChecks(prodTypes) {
  const tag = prodTypes ? '[prod-types]' : '[staging-types]';
  L('modules/authz/schema-probe.js').resetSchemaProbeCacheForTests();
  const { DataSource } = require('typeorm');
  const pg = await startPg({ prodTypes, aMigration: true, prebrief: true });
  const { Course } = L('modules/courses/entities/course.entity.js');
  const { CourseVersion } = L('modules/course-versions/entities/course-version.entity.js');
  const { Institution } = L('modules/institutions/entities/institution.entity.js');
  const ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port: pg.port, username: 'postgres', database: pg.db, entities: [Course, CourseVersion, Institution], synchronize: false });
  await ds.initialize();
  const q = (sql, p) => ds.query(sql, p);
  let ctx = null;
  try {
    Object.assign(process.env, { SUPABASE_JWT_SECRET: SECRET, SUPER_ADMIN_EMAILS: 'sa@cursia.test', SUPER_ADMIN_EMAIL_VERIFICATION: 'off', NODE_ENV: 'production', CURSIA_ACCOUNT_GUARD: 'enforce', CURSIA_RBAC_MODE: 'enforce' });
    delete process.env.SUPER_ADMIN_USER_IDS;
    for (const k of Object.keys(U)) if (k !== 'SA') await q(`insert into public.authorized_users (email, user_id, status) values ($1, $2, 'active')`, [EMAIL(k), U[k]]);
    await q(`insert into public.institutions (id, owner_id, name, slug, kind, status) values ($1, $2, 'QA r75 A', 'qa-r75-a', 'organization', 'active'), ($3, $4, 'QA r75 B', 'qa-r75-b', 'organization', 'active')`, [INST_A, U.OWN, INST_B, U.ADMB]);
    const mem = [[INST_A, U.OWN, 'CREADOR'], [INST_A, U.ADM, 'ADMIN_INSTITUCIONAL'], [INST_A, U.CRE, 'CREADOR'], [INST_A, U.APR, 'APROBADOR_ACADEMICO'], [INST_A, U.CON, 'CONSULTA'], [INST_B, U.ADMB, 'ADMIN_INSTITUCIONAL'], [INST_B, U.CRE, 'CONSULTA']];
    for (const [i, u, r] of mem) await q(`insert into public.institution_memberships (institution_id, user_id, role, created_by) values ($1, $2, $3, $4)`, [i, u, r, U.SA]);
    const course = async (owner, inst, title) => (await q(`insert into public.courses (owner_id, institution_id, title) values ($1, $2, $3) returning id`, [owner, inst, title]))[0].id;
    const cA = await course(U.OWN, INST_A, 'Curso A');
    const cB = await course(U.ADMB, INST_B, 'Curso B');
    const cDel = await course(U.OWN, INST_A, 'Curso A borrable');
    const cNoInst = await course(U.OWN, null, 'Curso sin institución');
    ctx = await makeApp(ds);
    const { api, app } = ctx;
    const perms = app.get(L('modules/authz/permission.service.js').PermissionService);

    // ── matriz ──
    const MATRIX = [
      // [ruta, método, curso, cuerpo, {rol: status}]
      ['GET /courses/:id', 'GET', () => `/api/v1/courses/${cA}`, null, { OWN: 200, ADM: 200, CRE: 200, APR: 200, CON: 200, ADMB: 404, NOM: 404, SA: 200 }],
      ['PATCH /courses/:id', 'PATCH', () => `/api/v1/courses/${cA}`, { description: 'x' }, { OWN: 200, ADM: 200, CRE: 200, APR: 403, CON: 403, ADMB: 404, NOM: 404, SA: 200 }],
      ['GET /courses/:id/cost (spend.view)', 'GET', () => `/api/v1/courses/${cA}/cost`, null, { OWN: 403, ADM: 200, CRE: 403, APR: 403, CON: 403, ADMB: 404, SA: 200 }],
      ['DELETE /courses/:id (courses.delete)', 'DELETE', () => `/api/v1/courses/${cDel}`, null, { CRE: 403, APR: 403, CON: 403, ADMB: 404, OWN: 403, ADM: 204 }],
    ];
    for (const [route, method, url, body, exp] of MATRIX) {
      await check(`${tag} [M] ${route}: ${Object.entries(exp).map(([k, v]) => `${k}=${v}`).join(' ')}`, async () => {
        const got = {};
        for (const who of Object.keys(exp)) got[who] = (await api(method, url(), who, body)).status;
        eq(got, exp, route);
      });
    }
    await check(`${tag} [M] 403 lleva code permission_denied + permission; 404 de otra institución no revela el curso`, async () => {
      const r = await api('PATCH', `/api/v1/courses/${cA}`, 'APR', { description: 'y' });
      eq([r.body.code, r.body.permission], ['permission_denied', 'courses.edit'], '403');
      const n = await api('GET', `/api/v1/courses/${cA}`, 'ADMB');
      assert(!JSON.stringify(n.body).includes('Curso A'), 'no filtra el título');
    });
    await check(`${tag} [M] curso sin institución → solo SA (404 incluso para su dueño en enforce, hasta el backfill de A)`, async () => {
      eq((await api('GET', `/api/v1/courses/${cNoInst}`, 'OWN')).status, 404, 'dueño');
      eq((await api('GET', `/api/v1/courses/${cNoInst}`, 'SA')).status, 200, 'SA');
    });
    await check(`${tag} [M] updated_by = actor tras un PATCH exitoso de otro miembro (owner_id intacto)`, async () => {
      const [row] = await q(`select owner_id::text as o, updated_by from public.courses where id = $1`, [cA]);
      eq([row.o, row.updated_by], [U.OWN, U.SA], 'último PATCH fue del SA');
      eq((await api('PATCH', `/api/v1/courses/${cA}`, 'ADM', { description: 'z' })).status, 200, 'patch');
      const [r2] = await q(`select updated_by from public.courses where id = $1`, [cA]);
      eq(r2.updated_by, U.ADM, 'updated_by');
    });

    // ── institución activa ──
    await check(`${tag} [I] POST /courses: CREADOR(A)+CONSULTA(B): header A → 201 (institution_id A, created_by, owner = creador); header B → 403; sin header → 400 institution_required`, async () => {
      const a = await api('POST', '/api/v1/courses', 'CRE', { title: 'Nuevo A' }, { 'x-cursia-institution': INST_A });
      eq(a.status, 201, `A ${JSON.stringify(a.body)}`);
      const [row] = await q(`select owner_id::text as o, institution_id::text as i, created_by from public.courses where id = $1`, [a.body.id]);
      eq([row.o, row.i, row.created_by], [U.CRE, INST_A, U.CRE], 'autoría');
      const b = await api('POST', '/api/v1/courses', 'CRE', { title: 'Nuevo B' }, { 'x-cursia-institution': INST_B });
      eq([b.status, b.body.code], [403, 'permission_denied'], 'B');
      const n = await api('POST', '/api/v1/courses', 'CRE', { title: 'Sin header' });
      eq([n.status, n.body.code], [400, 'institution_required'], 'sin header');
      eq((await api('POST', '/api/v1/courses', 'CON', { title: 'x' })).status, 403, 'CONSULTA con 1 membresía');
      eq((await api('POST', '/api/v1/courses', 'NOM', { title: 'x' })).body.code, 'not_a_member', 'sin membresías');
      eq((await api('POST', '/api/v1/courses', 'ADM', { title: 'x' }, { 'x-cursia-institution': INST_B })).body.code, 'not_a_member', 'header de una institución ajena');
    });
    await check(`${tag} [I] GET /courses lista la institución activa (CONSULTA de A ve el de A y no el de B; cambia con el header)`, async () => {
      const a = await api('GET', '/api/v1/courses', 'CON');
      assert(a.body.some((c) => c.id === cA) && !a.body.some((c) => c.id === cB), 'A');
      const b = await api('GET', '/api/v1/courses', 'CRE', null, { 'x-cursia-institution': INST_B });
      assert(b.body.some((c) => c.id === cB) && !b.body.some((c) => c.id === cA), 'B con header');
    });
    await check(`${tag} [I] header ≠ institución del curso → 409 institution_mismatch (D-13); en B el CREADOR solo ve (CONSULTA)`, async () => {
      eq((await api('GET', `/api/v1/courses/${cA}`, 'CRE', null, { 'x-cursia-institution': INST_B })).body.code, 'institution_mismatch', '409');
      eq((await api('GET', `/api/v1/courses/${cB}`, 'CRE')).status, 200, 'view B');
      eq((await api('PATCH', `/api/v1/courses/${cB}`, 'CRE', { description: 'x' })).status, 403, 'edit B');
    });
    await check(`${tag} [I] institución suspendida → 403 institution_inactive (el SA pasa)`, async () => {
      await q(`update public.institutions set status = 'suspended' where id = $1`, [INST_B]);
      perms.invalidate();
      eq((await api('GET', `/api/v1/courses/${cB}`, 'ADMB')).body.code, 'institution_inactive', 'admin B');
      eq((await api('GET', `/api/v1/courses/${cB}`, 'SA')).status, 200, 'SA');
      await q(`update public.institutions set status = 'active' where id = $1`, [INST_B]);
      perms.invalidate();
    });

    // ── overrides ──
    await check(`${tag} [O] grant courses.edit a CONSULTA → PATCH 200 (tras invalidar la caché de 30 s); deny courses.view al CREADOR → 403 (deny > rol); revocado → 200`, async () => {
      eq((await api('PATCH', `/api/v1/courses/${cA}`, 'CON', { description: 'g' })).status, 403, 'antes (calienta la caché)');
      await q(`insert into public.institution_permission_overrides (institution_id, user_id, permission, effect, created_by) values ($1, $2, 'courses.edit', 'grant', $3)`, [INST_A, U.CON, U.SA]);
      eq((await api('PATCH', `/api/v1/courses/${cA}`, 'CON', { description: 'g' })).status, 403, 'caché 30 s antes de invalidar');
      perms.invalidateUser(U.CON);
      eq((await api('PATCH', `/api/v1/courses/${cA}`, 'CON', { description: 'g' })).status, 200, 'grant');
      // una fila por (inst, user, permiso): el deny reemplaza al grant → probamos deny > grant con dos permisos y con el rol
      await q(`insert into public.institution_permission_overrides (institution_id, user_id, permission, effect, created_by) values ($1, $2, 'courses.view', 'deny', $3)`, [INST_A, U.CRE, U.SA]);
      perms.invalidateUser(U.CRE);
      const r = await api('GET', `/api/v1/courses/${cA}`, 'CRE');
      eq([r.status, r.body.code], [403, 'permission_denied'], 'deny > rol');
      await q(`update public.institution_permission_overrides set revoked_at = now(), revoked_by = $2 where user_id = $1 and permission = 'courses.view'`, [U.CRE, U.SA]);
      perms.invalidateUser(U.CRE);
      eq((await api('GET', `/api/v1/courses/${cA}`, 'CRE')).status, 200, 'revocado');
    });

    // ── anti-escalada con la base ──
    await check(`${tag} [X] escalationCheck con membresías reales: admin asigna rol → ok; admin otorga generations.start → 403; CREADOR → 403; SA → ok`, async () => {
      eq(await perms.escalationCheck({ id: U.ADM, email: EMAIL('ADM') }, INST_A, U.CON, { role: 'CREADOR' }), null, 'rol');
      eq((await perms.escalationCheck({ id: U.ADM, email: EMAIL('ADM') }, INST_A, U.CON, { grants: ['generations.start'] })).code, 'role_escalation_forbidden', 'grant');
      eq((await perms.escalationCheck({ id: U.ADM, email: EMAIL('ADM') }, INST_A, U.ADM, { grants: ['proposals.approve'] })).code, 'self_modification_forbidden', 'self');
      eq((await perms.escalationCheck({ id: U.CRE, email: EMAIL('CRE') }, INST_A, U.CON, { role: 'CREADOR' })).code, 'permission_denied', 'creador');
      eq((await perms.escalationCheck({ id: U.ADMB, email: EMAIL('ADMB') }, INST_A, U.CON, { role: 'CREADOR' })).code, 'permission_denied', 'admin de otra institución');
      eq(await perms.escalationCheck({ id: U.SA, email: EMAIL('SA') }, INST_A, U.CON, { grants: ['proposals.approve'] }), null, 'SA');
      eq((await perms.effectivePermissions(U.APR, INST_A)).includes('proposals.approve'), true, 'effectivePermissions (A)');
    });
    await check(`${tag} [X] runInitiatorSuspended (para C): iniciador (startedBy) con suspensión de cuenta activa → true; levantada → false`, async () => {
      const [j] = await q(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, input_payload) values ($1, $2, 'dynamic_generation', 'paused', $3::jsonb) returning id`, [U.OWN, prodTypes ? String(cA) : cA, JSON.stringify({ startedBy: U.CRE })]);
      eq(await perms.runInitiatorSuspended(j.id), false, 'sin suspensión');
      await q(`insert into public.user_suspensions (user_id, kind, reason, created_by) values ($1, 'account', 'qa', $2)`, [U.CRE, U.SA]);
      eq(await perms.runInitiatorSuspended(j.id), true, 'suspendido');
      await q(`update public.user_suspensions set lifted_at = now(), lifted_by = $2, lift_reason = 'qa' where user_id = $1`, [U.CRE, U.SA]);
      eq(await perms.runInitiatorSuspended(j.id), false, 'levantada');
      app.get(L('modules/authz/account-access.service.js').AccountAccessService).invalidate();
    });

    // ── prebrief: aprobación por el actor ──
    await check(`${tag} [A] Prebrief: aprueba el APROBADOR (no dueño) → approval.userId = actor, selfApproved=false, courses.approved_by/at en la misma sentencia; la carrera no escribe nada; el creador que aprueba → selfApproved=true`, async () => {
      const { approveVersionAtomically } = L('modules/prebrief/prebrief.service.js');
      const sha = 'a'.repeat(64);
      const insV = async (cid, n) => (await q(`insert into public.course_prebrief_versions (course_id, version, status, model_version, model_json, model_sha256, document_json, document_sha256, blueprint_id, blueprint_number, blueprint_sha256, prepared_by)
        values ($1, $2, 'ready', 1, '{}', $3, '{}', $3, 1, 1, $3, $4) returning id`, [cid, n, sha, U.OWN]))[0].id;
      const v1 = await insV(cA, 1);
      const base = { name: 'Ana Pérez', role: 'Coordinadora', at: new Date().toISOString(), channel: 'in_app' };
      const r = await approveVersionAtomically(q, { courseId: cA, versionId: v1, expectedModelSha: sha, actor: { id: U.APR, email: EMAIL('APR') }, approvalBase: base });
      eq([r.rows.length, r.approval.userId, r.selfApproved], [1, U.APR, false], 'aprobado');
      const [c] = await q(`select approved_by, approved_at is not null as at from public.courses where id = $1`, [cA]);
      eq([c.approved_by, c.at], [U.APR, true], 'courses.approved_by');
      const again = await approveVersionAtomically(q, { courseId: cA, versionId: v1, expectedModelSha: sha, actor: { id: U.SA, email: EMAIL('SA') }, approvalBase: base });
      eq(again.rows.length, 0, 'carrera: 0 filas');
      eq((await q(`select approved_by from public.courses where id = $1`, [cA]))[0].approved_by, U.APR, 'approved_by intacto');
      const cSelf = await course(U.OWN, INST_A, 'Curso auto-aprobado');
      const v2 = await insV(cSelf, 1);
      eq((await approveVersionAtomically(q, { courseId: cSelf, versionId: v2, expectedModelSha: sha, actor: { id: U.OWN }, approvalBase: base })).selfApproved, true, 'D-10');
    });

    // ── shadow ──
    process.env.CURSIA_RBAC_MODE = 'shadow';
    perms.invalidate();
    await check(`${tag} [S] shadow: se aplica la regla vieja (ADMIN de A no es dueño → 404) y queda rbac.shadow_deny; el dueño sigue con 200 sin auditoría`, async () => {
      const before = Number((await q(`select count(*)::int as n from public.admin_audit_log where action = 'rbac.shadow_deny'`))[0].n);
      eq((await api('GET', `/api/v1/courses/${cA}`, 'ADM')).status, 404, 'legacy');
      eq((await api('GET', `/api/v1/courses/${cA}`, 'OWN')).status, 200, 'dueño');
      const rows = await q(`select actor_id::text as a, after from public.admin_audit_log where action = 'rbac.shadow_deny' order by id desc`);
      eq(rows.length - before, 1, 'una fila');
      eq([rows[0].a, rows[0].after.permission, rows[0].after.legacyAllowed, rows[0].after.rbacAllowed], [U.ADM, 'courses.view', false, true], 'detalle');
      eq((await api('POST', '/api/v1/courses', 'CRE', { title: 'shadow' })).status, 201, 'shadow: crear sin header como hoy');
    });

    // ── off ──
    process.env.CURSIA_RBAC_MODE = 'off';
    await check(`${tag} [F] off: dueño único como hoy (ADMIN de A → 404, dueño 200) y sin auditoría nueva`, async () => {
      const before = Number((await q(`select count(*)::int as n from public.admin_audit_log`))[0].n);
      eq((await api('GET', `/api/v1/courses/${cA}`, 'ADM')).status, 404, 'admin');
      eq((await api('GET', `/api/v1/courses/${cA}`, 'OWN')).status, 200, 'dueño');
      eq((await api('GET', `/api/v1/courses/${cNoInst}`, 'OWN')).status, 200, 'sin institución: como hoy');
      eq(Number((await q(`select count(*)::int as n from public.admin_audit_log`))[0].n), before, 'sin auditoría');
    });
  } finally {
    if (ctx) await ctx.app.close().catch(() => {});
    await ds.destroy().catch(() => {});
    pg.stop();
    restoreEnv();
  }
}

/** [C] cobertura: los controllers de B (03 §1) tienen marca de autorización en TODO handler. */
async function coverageChecks() {
  const { PATH_METADATA, METHOD_METADATA } = require('@nestjs/common/constants');
  const KEYS = ['cursia:authz:require-permission', 'cursia:authz:authenticated-only', 'cursia:authz:public', 'cursia:authz:public-capability',
    'cursia:authz:allow-inactive-account', 'cursia:authz:superadmin-only', 'r75:allowInactiveAccount', 'cursia:authz:token-authenticated'];
  const OWNED_BY_B = ['modules/courses/courses.controller.js', 'modules/course-versions/course-versions.controller.js', 'modules/course-structure/course-structure.controller.js',
    'modules/course-structure/course-structure-settings.controller.js', 'modules/course-blueprints/course-blueprints.controller.js', 'modules/generation-manifests/generation-manifests.controller.js',
    'modules/dynamic-generation/executor.controller.js', 'modules/coherence/coherence.controller.js', 'modules/invalidation/invalidation.controller.js', 'modules/invalidation/change-impact.controller.js',
    'modules/course-profiles/course-profiles.controller.js', 'modules/pedagogy/pedagogy.controller.js', 'modules/academic-context/academic-context.controller.js', 'modules/course-facts/course-facts.controller.js',
    'modules/course-design/course-design.controller.js', 'modules/prebrief/prebrief.controller.js', 'modules/course-setup/course-setup.controller.js', 'modules/artifacts/artifacts.controller.js',
    'modules/production-jobs/production-jobs.controller.js', 'modules/brand-profiles/brand-profiles.controller.js', 'events/events.controller.js', 'tts/tts.controller.js', 'video-engine/video-engine.controller.js',
    'youtube/youtube.controller.js', 'app.controller.js', 'modules/features/features.controller.js', 'auth/auth.controller.js', 'modules/dynamic-generation/dynamic-youtube.controller.js',
    'modules/dynamic-generation/admin-runs.controller.js', 'admin/controllers/admin-dashboard.controller.js', 'modules/authz/permissions-catalog.controller.js'];
  const list = (rel) => {
    const mod = L(rel);
    const out = [];
    for (const cls of Object.values(mod)) {
      if (typeof cls !== 'function' || Reflect.getMetadata(PATH_METADATA, cls) === undefined) continue;
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const h = cls.prototype[name];
        if (name === 'constructor' || typeof h !== 'function' || Reflect.getMetadata(METHOD_METADATA, h) === undefined) continue;
        const covered = KEYS.some((k) => Reflect.getMetadata(k, h) !== undefined || Reflect.getMetadata(k, cls) !== undefined);
        out.push({ ctl: cls.name, name, covered, rp: !!Reflect.getMetadata('cursia:authz:require-permission', h) });
      }
    }
    return out;
  };
  let total = 0; let rp = 0;
  await check('[C] cobertura 100 % en los controllers de B (todo handler con marca de autorización)', () => {
    const missing = [];
    for (const rel of OWNED_BY_B) for (const h of list(rel)) { total++; if (h.rp) rp++; if (!h.covered) missing.push(`${h.ctl}.${h.name}`); }
    eq(missing, [], 'sin marca');
  });
  console.log(`   ${total} handlers de B: ${rp} con @RequirePermission, ${total - rp} con otra marca (@AuthenticatedOnly / @Public / @SuperAdminOnly / …)`);
  const OTHERS = ['modules/dynamic-generation/runs.controller.js', 'modules/finops/finops.controller.js', 'modules/dynamic-packaging/packaging.controller.js', 'modules/institutions/institutions.controller.js'];
  const pend = []; for (const rel of OTHERS) for (const h of list(rel)) if (!h.covered) pend.push(`${h.ctl}.${h.name}`);
  console.log(`   pendientes de otros dueños (C / r74 / A): ${pend.length} handlers sin marca → ${[...new Set(pend.map((x) => x.split('.')[0]))].join(', ')}`);
}

(async () => {
  try {
    await pureChecks();
    await coverageChecks();
    await dbChecks(false);
    await dbChecks(true);
  } catch (err) { failures++; console.error('❌ error inesperado', err); }
  global.fetch = realFetch;
  console.log(`\n${passes} OK, ${failures} fallas`);
  process.exit(failures ? 1 : 0);
})();
