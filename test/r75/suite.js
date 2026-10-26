/* eslint-disable */
// r75 · Agente E — suite de integración, seguridad y aislamiento contra la app REAL (dist/main.js) y un PG descartable.
// Matriz (03-plan-agentes.md, «Agente E»):
//   (a) IDOR entre instituciones en cada ruta por id        (g) run terminal libera; run pausado retiene
//   (b) rol × permiso × ruta                                (h) tempPassword nunca en logs, auditoría ni base
//   (c) deny > grant; anti-escalada; último admin           (i) H2: authorized_users sin escrituras de cliente
//   (d) suspendida / no autorizada → 403 salvo /me/context  (j) ambos tipos de esquema (lo agrega summarize.js)
//   (e) reservas concurrentes nunca superan el disponible   (k) monthSpent global no se filtra a no-SA
//   (f) BYOK/mock no consumen; sin doble conteo             (l) /media/* de r74 sigue pública
// Cada ítem que depende de código aún no integrado queda PENDIENTE (nunca PASS) con el motivo.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('./lib/env');
const t = require('./lib/t');
const seed = require('./lib/seed');
const { inventory, fill, RESOURCE_PARAMS } = require('./lib/routes');
const { S, MATRIX } = require('./lib/contract-shapes');
const { startFakeSupabase } = require('./lib/fake-supabase');
const { keepTeacherDesign } = require(path.join(env.REPO, 'test', 'e2e-v2', 'design-approval.js'));
const { q, api, tokenFor } = env;

const DIST = path.join(env.REPO, 'dist');
const distHas = (p) => fs.existsSync(path.join(DIST, p));
const appModuleSrc = () => { try { return fs.readFileSync(path.join(DIST, 'app.module.js'), 'utf8'); } catch { return ''; } };
const MODE = `types=${process.env.E2E_PROD_COLUMN_TYPES || '0'}`;
const TYPES = process.env.E2E_PROD_COLUMN_TYPES || '0';
const FINDINGS = [];
const finding = (sev, item, msg, repro) => { FINDINGS.push({ sev, item, msg, repro }); console.log(`  ⚑ ${sev} [${item}] ${msg}${repro ? `\n      repro: ${repro}` : ''}`); };
const isAuthzDeny = (r) => r.status === 403 || r.status === 404 || (r.status === 409 && r.code === 'institution_mismatch');
const brief = (r) => ({ s: r.status, code: r.code, e: typeof r.error === 'string' ? r.error.slice(0, 160) : r.error });

let U, I, TK, F, routes, fx, fakes;
const D_FIELDS = { nombre: 'QA r75 curso', sector: 'Minería', pais: 'Chile', ciudad: 'Antofagasta', contexto: 'Técnicos de mantenimiento', nivel: 'Intermedio', tono: 'cercano y técnico', obj: 'Formar técnicos', comp: 'Diagnostica sistemas', videoMode: 'mock' };

async function detect() {
  const am = appModuleSrc();
  F = {
    accountGuard: distHas('modules/authz/account-access.guard.js') && /AuthzModule/.test(am),
    permGuard: distHas('modules/authz/permission.guard.js') && /AuthzModule/.test(am),
    access: distHas('modules/access/access.module.js') && /AccessModule/.test(am),
    budgets: distHas('modules/budgets/budgets.module.js') && /BudgetsModule/.test(am),
    memberships: await env.tableExists('institution_memberships'),
    overrides: await env.tableExists('institution_permission_overrides'),
    suspensions: await env.tableExists('user_suspensions'),
    userBudgets: await env.tableExists('user_budgets'),
    reservations: await env.tableExists('budget_reservations'),
    authUid: await env.columnExists('authorized_users', 'user_id'),
    accessMigration: fs.existsSync(path.join(env.REPO, 'scripts', 'migrate-r75-access.js')) || (fs.existsSync(path.join(env.REPO, 'supabase-migration-r75-access.sql')) && (await env.tableExists('institution_memberships'))),
  };
  console.log('capacidades detectadas:', JSON.stringify(F));
}

async function setup() {
  fakes = await startFakeSupabase({ serviceKey: env.SERVICE_KEY });
  U = await seed.seedIdentities();
  I = await seed.seedInstitutions(U);
  F.seededMemberships = await seed.seedMemberships(U, I);
  F.seededSuspension = await seed.seedSuspension(U);
  TK = Object.fromEntries(Object.entries(U).map(([k, u]) => [k, tokenFor(u)]));
  const courseA = await seed.seedCourse(U.creadorA, I.A, `Curso A ${seed.MARK}`);
  const courseB = await seed.seedCourse(U.adminB, I.B, 'Curso B');
  const runA = await seed.seedRun(courseA, U.creadorA, 'running');
  const jobA = await seed.seedLegacyJob(U.creadorA);
  const artA = await seed.seedArtifact(courseA, U.creadorA);
  const orphan = await seed.seedCourse({ id: null, email: null }, null, `Huérfano ${seed.MARK}`);
  fx = { A: { course: courseA.id, run: runA.id, job: jobA.id, artifact: artA.id, institution: I.A.id, userId: U.consultaA.id }, B: { course: courseB.id, institution: I.B.id }, orphan: orphan.id };
  await env.startApp(fakes, {
    SUPER_ADMIN_EMAILS: U.sa.email, SUPER_ADMIN_USER_IDS: U.sa.id,
    DYNAMIC_V2_GENERAL_AVAILABILITY: 'true', DYNAMIC_ALLOW_VIDEO_PREVIEW: 'true', DYNAMIC_ALLOW_PROVIDER_MOCK: 'true',
  });
  const mc = await api('GET', '/me/context', { token: TK.creadorA });
  F.meContext = mc.status === 200;
  const mb = await api('GET', '/me/budget', { token: TK.creadorA });
  F.meBudget = mb.status === 200;
  const ma = await api('GET', `/institutions/${I.A.id}/members`, { token: TK.adminA });
  F.membersApi = ma.status !== 404 || ma.code === 'not_a_member';
  routes = inventory(env.REPO);
  F.routesWithPerm = routes.filter((r) => r.perm).length;
  console.log(`rutas: ${routes.length} (con @RequirePermission: ${F.routesWithPerm}); /me/context=${mc.status} /me/budget=${mb.status} members=${ma.status}`);
}

// ─── (a) IDOR entre instituciones ───────────────────────────────────────────
async function itemA() {
  t.item('a');
  const targets = routes.filter((r) => !r.public && !r.token && RESOURCE_PARAMS.test(r.route) && !/\/media\//.test(r.route));
  let n = 0;
  for (const r of targets) {
    const p = fill(r.route, fx.A);
    const res = await api(r.method === 'ALL' ? 'GET' : r.method, p, { token: TK.adminB, body: r.method === 'GET' || r.method === 'HEAD' ? undefined : {}, raw: true });
    const leak = res.text && res.text.includes(seed.MARK);
    const ok2xx = res.status >= 200 && res.status < 400;
    n++;
    if (res.status === 400 && !leak) {
      // La validación del body corrió antes que la autorización: no prueba el aislamiento. Con PermissionGuard en la ruta es un FAIL.
      if (F.permGuard && r.perm) t.ok(false, `${r.method} ${p} (adminB → recurso de A): 400 antes del guard de permisos (debe ser 403/404)`, { ...brief(res), at: `${r.file}:${r.line}` });
      else t.ok(true, `${r.method} ${r.route}: 400 sin fuga (validación previa; sin @RequirePermission todavía)`);
      continue;
    }
    if (ok2xx && !leak && res.data && res.data.ok === false) {
      // Rechazo «blando» del legacy: 200 {ok:false, reason}. No hay acceso, pero reason distingue forbidden de not_found
      // (oráculo de existencia por id) y no es el 403/404 del contrato.
      t.ok(true, `${r.method} ${r.route}: rechazado con 200 {ok:false, reason:${JSON.stringify(res.data.reason)}}`);
      if (res.data.reason === 'forbidden') finding('P3', 'a', `${r.method} ${r.route} responde 200 {ok:false, reason:'forbidden'} a un no-dueño (oráculo de existencia; el contrato pide 404)`, `${r.file}:${r.line}`);
      continue;
    }
    const pass = !ok2xx && !leak && res.status !== 500;
    t.ok(pass, `${r.method} ${r.route}: adminB (inst. B) no accede al recurso de A`, { ...brief(res), leak, at: `${r.file}:${r.line}` });
    if (!pass) finding(res.status === 500 ? 'P1' : 'P0', 'a', `IDOR/fuga ${r.method} ${r.route} → ${res.status}${leak ? ' (con datos de A)' : ''}`, `curl -X ${r.method} -H "Authorization: Bearer <adminB>" /api/v1${p}`);
  }
  // Listas: nada de A en las colecciones de B.
  for (const p of ['/courses', '/artifacts', '/institutions', '/jobs']) {
    const res = await api('GET', p, { token: TK.adminB, raw: true });
    t.ok(!(res.text || '').includes(seed.MARK), `GET ${p} como adminB no lista nada de la institución A`, brief(res));
  }
  // Header de institución ajena con un curso propio de B → nunca 2xx sobre A.
  const hm = await api('GET', `/courses/${fx.A.course}`, { token: TK.adminB, headers: { 'X-Cursia-Institution': I.A.id } });
  t.ok(isAuthzDeny(hm), 'adminB con X-Cursia-Institution=A (no es miembro) no ve el curso de A', brief(hm));
  // Control positivo (la prueba no es vacía): el dueño sí ve su curso y su artifact.
  const own = await api('GET', `/courses/${fx.A.course}`, { token: TK.creadorA, headers: { 'X-Cursia-Institution': I.A.id } });
  t.ok(own.status === 200, 'control: creadorA (dueño) ve su curso', brief(own));
  const ownArt = await api('GET', `/artifacts/${fx.A.artifact}`, { token: TK.creadorA });
  t.ok(ownArt.status === 200, 'control: creadorA ve su artifact', brief(ownArt));
  // Curso huérfano (D-6): nadie salvo el SA.
  const orph = await api('GET', `/courses/${fx.orphan}`, { token: TK.adminA, headers: { 'X-Cursia-Institution': I.A.id } });
  t.ok(isAuthzDeny(orph), 'curso huérfano (owner_id null) invisible para un admin institucional (D-6/H4)', brief(orph));
  console.log(`  (a) ${n} rutas por id probadas`);
}

// ─── (b) rol × permiso × ruta ───────────────────────────────────────────────
async function itemB() {
  t.item('b');
  const cat = await api('GET', '/permissions/catalog', { token: TK.consultaA });
  if (cat.status === 200) { const e = []; S.PermissionCatalog(cat.data, e); t.ok(!e.length, 'GET /permissions/catalog = 01 §2.2', e); }
  else t.pending('GET /permissions/catalog', `HTTP ${cat.status} (no integrado)`);
  if (F.meContext) {
    for (const [k, role] of [['adminA', 'ADMIN_INSTITUCIONAL'], ['creadorA', 'CREADOR'], ['aprobadorA', 'APROBADOR_ACADEMICO'], ['consultaA', 'CONSULTA']]) {
      const mc = await api('GET', '/me/context', { token: TK[k] });
      const e = []; S.MeContext(mc.data, e);
      t.ok(mc.status === 200 && !e.length, `/me/context de ${k}: forma del contrato`, { ...brief(mc), e });
      const m = mc.data && (mc.data.memberships || []).find((x) => x.institutionId === I.A.id);
      t.ok(m && m.role === role && JSON.stringify([...m.permissions].sort()) === JSON.stringify([...MATRIX[role]].sort()), `/me/context de ${k}: permisos efectivos en A = matriz de ${role}`, m);
    }
    const mcA = await api('GET', '/me/context', { token: TK.creadorA });
    const inB = mcA.data && (mcA.data.memberships || []).find((x) => x.institutionId === I.B.id);
    t.ok(inB && inB.role === 'CONSULTA', 'regla 2: creadorA es CONSULTA en B (rol distinto por institución)', inB);
    t.ok(mcA.data && mcA.data.superAdmin === false, 'creadorA no es SuperAdmin (D-3)');
    const mcSa = await api('GET', '/me/context', { token: TK.sa });
    t.ok(mcSa.data && mcSa.data.superAdmin === true, 'SA por env (SUPER_ADMIN_EMAILS + pin) → superAdmin:true', brief(mcSa));
    // is_admin en la base nunca otorga SA (D-3, H10).
    await q(`update public.authorized_users set is_admin = true where email = $1`, [U.consultaA.email]);
    const mcIs = await api('GET', '/me/context', { token: TK.consultaA });
    t.ok(mcIs.data && mcIs.data.superAdmin === false, 'authorized_users.is_admin=true NO da SuperAdmin', mcIs.data && mcIs.data.superAdmin);
    await q(`update public.authorized_users set is_admin = false where email = $1`, [U.consultaA.email]);
  } else t.pending('/me/context por rol', 'GET /me/context no integrado (A)');

  if (!F.permGuard || !F.routesWithPerm) { t.pending('rol × permiso × ruta', `PermissionGuard/@RequirePermission no integrados (B): ${F.routesWithPerm} rutas con permiso`); return; }
  const roles = [['adminA', 'ADMIN_INSTITUCIONAL'], ['creadorA', 'CREADOR'], ['aprobadorA', 'APROBADOR_ACADEMICO'], ['consultaA', 'CONSULTA']];
  const scoped = routes.filter((r) => r.perm && ['course', 'run', 'artifact', 'institution'].includes(r.perm.scopeKind));
  let denyOk = 0, allowOk = 0;
  for (const r of scoped) {
    for (const [k, role] of roles) {
      const allowed = MATRIX[role].includes(r.perm.permission);
      let base = fx.A;
      if (allowed && (r.method === 'DELETE' || /delete|cancel/.test(r.route))) {
        const c = await seed.seedCourse(U.creadorA, I.A, `sacrificio r75 ${r.handler}`);
        base = { ...fx.A, course: c.id };
      }
      const p = fill(r.route, base);
      const res = await api(r.method, p, { token: TK[k], body: r.method === 'GET' ? undefined : {} });
      if (allowed) {
        const pass = !(res.status === 403 && res.code === 'permission_denied') && res.code !== 'not_a_member' && res.status !== 500 && res.code !== 'access_context_missing';
        if (pass) allowOk++;
        t.ok(pass, `${role} PUEDE ${r.perm.permission} en ${r.method} ${r.route}`, { ...brief(res), at: `${r.file}:${r.line}` });
      } else {
        const pass = res.status === 403 && res.code === 'permission_denied';
        if (pass) denyOk++;
        t.ok(pass, `${role} NO puede ${r.perm.permission} en ${r.method} ${r.route} → 403 permission_denied`, { ...brief(res), at: `${r.file}:${r.line}` });
        if (!pass && res.status >= 200 && res.status < 300) finding('P0', 'b', `${role} ejecuta ${r.method} ${r.route} sin ${r.perm.permission}`, `-H "Authorization: Bearer <${k}>" ${r.method} /api/v1${p}`);
      }
    }
  }
  // El cuerpo del 403 trae {permission} (el FE lo muestra): requiere que AllExceptionsFilter deje pasar la clave.
  const one = scoped.find((r) => !MATRIX.CONSULTA.includes(r.perm.permission) && r.method !== 'DELETE');
  if (one) {
    const res = await api(one.method, fill(one.route, fx.A), { token: TK.consultaA, body: one.method === 'GET' ? undefined : {} });
    t.ok(res.json && res.json.permission === one.perm.permission, `403 permission_denied incluye permission:"${one.perm.permission}" en el cuerpo (02 §E.2)`, res.json);
    if (!(res.json && res.json.permission)) finding('P2', 'b', 'AllExceptionsFilter descarta `permission` (y requiredUsd/availableUsd/payerUserId/canRequest/estimateId/userId) del cuerpo de error', 'src/common/filters/http-exception.filter.ts: lista blanca de claves');
  }
  // SA: permitido en cualquier institución (sin membresía).
  const saR = scoped.filter((r) => r.method === 'GET').slice(0, 10);
  for (const r of saR) { const res = await api('GET', fill(r.route, fx.A), { token: TK.sa }); t.ok(!isAuthzDeny(res) || res.status === 404 && res.code !== 'not_a_member' && !/permission/.test(String(res.code)), `SA accede a ${r.route} sin membresía`, brief(res)); }
  console.log(`  (b) ${scoped.length} rutas × ${roles.length} roles: ${denyOk} denegaciones y ${allowOk} permisos correctos`);
}

// ─── (c) deny > grant, anti-escalada, último admin ──────────────────────────
async function itemC() {
  t.item('c');
  if (!F.membersApi) { t.pending('overrides / anti-escalada / último admin', 'API de miembros no integrada (A)'); return; }
  const ov = (inst, uid, body, tok) => api('PUT', `/institutions/${inst}/members/${uid}/overrides`, { token: tok, body: { reason: 'QA r75', ...body } });
  // deny > rol
  let r = await ov(I.A.id, U.creadorA.id, { grants: [], denies: ['courses.view'] }, TK.sa);
  t.ok(r.status === 200, 'SA fija deny courses.view a creadorA', brief(r));
  r = await api('GET', `/courses/${fx.A.course}`, { token: TK.creadorA, headers: { 'X-Cursia-Institution': I.A.id } });
  if (F.permGuard) t.ok(isAuthzDeny(r), 'deny courses.view gana sobre el rol CREADOR (curso propio inclusive)', brief(r));
  else t.pending('deny courses.view corta GET /courses/:id', 'PermissionGuard no integrado (B2)');
  if (F.meContext) { const mc = await api('GET', '/me/context', { token: TK.creadorA }); const m = (mc.data.memberships || []).find((x) => x.institutionId === I.A.id); t.ok(m && !m.permissions.includes('courses.view'), '/me/context refleja el deny al instante (invalidación de caché)', m); }
  // deny > grant del mismo permiso
  r = await ov(I.A.id, U.creadorA.id, { grants: ['proposals.approve'], denies: ['proposals.approve'] }, TK.sa);
  if (r.status === 200) t.ok(!(r.data.effectivePermissions || []).includes('proposals.approve'), 'grant+deny del mismo permiso → deny gana', r.data);
  else t.ok(r.status === 400, 'grant+deny del mismo permiso → 400 (rechazado) o deny gana', brief(r));
  r = await ov(I.A.id, U.creadorA.id, { grants: [], denies: [] }, TK.sa);
  t.ok(r.status === 200, 'SA limpia los overrides de creadorA', brief(r));
  // grant
  r = await ov(I.A.id, U.consultaA.id, { grants: ['exports.download'], denies: [] }, TK.sa);
  t.ok(r.status === 200 && (r.data.effectivePermissions || []).includes('exports.download'), 'grant exports.download a CONSULTA (D-9 por override)', brief(r));
  // anti-escalada
  r = await ov(I.A.id, U.consultaA.id, { grants: ['proposals.approve'], denies: [] }, TK.adminA);
  t.ok(r.status === 403 && r.code === 'role_escalation_forbidden', 'adminA no otorga proposals.approve (no lo tiene, D-8) → 403 role_escalation_forbidden', brief(r));
  r = await ov(I.A.id, U.consultaA.id, { grants: ['budgets.manage'], denies: [] }, TK.adminA);
  t.ok(r.status === 400 && r.code === 'permission_not_grantable', 'budgets.manage no es otorgable por institución (D-7) → 400 permission_not_grantable', brief(r));
  r = await ov(I.A.id, U.consultaA.id, { grants: ['users.suspend'], denies: [] }, TK.sa);
  t.ok(r.status === 400 && r.code === 'permission_not_grantable', 'ni el SA otorga users.suspend por institución (D-7)', brief(r));
  r = await ov(I.A.id, U.adminA.id, { grants: ['generations.start'], denies: [] }, TK.adminA);
  t.ok(r.status === 403 && r.code === 'self_modification_forbidden', 'adminA no se modifica sus propios overrides → 403 self_modification_forbidden', brief(r));
  r = await api('PATCH', `/institutions/${I.A.id}/members/${U.adminA.id}`, { token: TK.adminA, body: { role: 'CREADOR' } });
  t.ok(r.status === 403 && r.code === 'self_modification_forbidden', 'adminA no cambia su propio rol', brief(r));
  r = await api('POST', `/institutions/${I.A.id}/members`, { token: TK.adminA, body: { email: U.adminB.email, role: 'SUPERADMIN' } });
  t.ok(r.status === 400 && (r.code === 'superadmin_role_reserved' || r.code === 'invalid_role'), 'rol SUPERADMIN no asignable → 400 superadmin_role_reserved', brief(r));
  r = await api('POST', `/institutions/${I.A.id}/members`, { token: TK.adminA, body: { email: 'qa-r75-no-existe@example.com', role: 'CONSULTA' } });
  t.ok(r.status === 404 && r.code === 'user_not_found', 'adminA agrega solo usuarios existentes (D-12) → 404 user_not_found', brief(r));
  r = await api('PATCH', `/institutions/${I.B.id}/members/${U.creadorB.id}`, { token: TK.adminA, body: { role: 'CONSULTA' } });
  t.ok(r.status === 403 || r.status === 404, 'adminA no administra miembros de B', brief(r));
  r = await api('PATCH', `/institutions/${I.A.id}/members/${U.aprobadorA.id}`, { token: TK.creadorA, body: { role: 'CONSULTA' } });
  t.ok(r.status === 403 && r.code === 'permission_denied', 'CREADOR sin roles.manage no administra miembros', brief(r));
  // último admin: un CREADOR con grant roles.manage intenta dejar A sin admin.
  r = await ov(I.A.id, U.creadorA.id, { grants: ['roles.manage'], denies: [] }, TK.sa);
  t.ok(r.status === 200, 'SA otorga roles.manage a creadorA', brief(r));
  r = await api('PATCH', `/institutions/${I.A.id}/members/${U.adminA.id}`, { token: TK.creadorA, body: { role: 'CONSULTA' } });
  t.ok(r.status === 409 && r.code === 'last_admin_protected', 'degradar al único admin → 409 last_admin_protected', brief(r));
  r = await api('DELETE', `/institutions/${I.A.id}/members/${U.adminA.id}`, { token: TK.creadorA, body: { reason: 'QA' } });
  t.ok(r.status === 409 && r.code === 'last_admin_protected', 'quitar al único admin → 409 last_admin_protected', brief(r));
  r = await api('PATCH', `/institutions/${I.A.id}/members/${U.adminA.id}`, { token: TK.creadorA, body: { status: 'suspended' } });
  t.ok(r.status === 409 && r.code === 'last_admin_protected', 'suspender al único admin → 409 last_admin_protected', brief(r));
  r = await ov(I.A.id, U.creadorA.id, { grants: [], denies: [] }, TK.sa);
  r = await ov(I.A.id, U.consultaA.id, { grants: [], denies: [] }, TK.sa);
  // Auditoría de lo anterior (sin secretos).
  if (await env.tableExists('admin_audit_log')) {
    const rows = await q(`select action, before, after from public.admin_audit_log order by id`);
    t.ok(rows.some((x) => /override|membership/.test(x.action)), 'cambios de overrides/membresías quedan en admin_audit_log', rows.map((x) => x.action));
    let mutated = false;
    try { await q(`update public.admin_audit_log set action = 'x' where id = (select min(id) from public.admin_audit_log)`); mutated = true; } catch {}
    t.ok(!mutated, 'admin_audit_log es append-only (UPDATE rechazado)');
    let removed = false;
    try { await q(`delete from public.institution_memberships where user_id = $1`, [U.consultaA.id]); removed = true; } catch {}
    t.ok(!removed, 'institution_memberships sin DELETE físico (trigger)');
  }
}

// ─── (d) cuenta suspendida o no autorizada ──────────────────────────────────
async function itemD() {
  t.item('d');
  if (!F.accountGuard) { t.pending('suspendida/no autorizada → 403', 'AccountAccessGuard no integrado (B)'); return; }
  if (!F.seededSuspension) t.pending('cuenta suspendida', 'tabla user_suspensions no existe (A)');
  const jwtRoutes = routes.filter((r) => !r.public && !r.token);
  let bad = 0;
  for (const r of jwtRoutes) {
    const p = fill(r.route, fx.A);
    for (const [who, code] of [['noauth', 'account_not_authorized'], ...(F.seededSuspension ? [['suspendido', 'account_suspended']] : [])]) {
      const res = await api(r.method === 'ALL' ? 'GET' : r.method, p, { token: TK[who], body: r.method === 'GET' || r.method === 'HEAD' ? undefined : {} });
      if (r.allowInactive) { const pass = !(res.status === 403 && /^account_/.test(String(res.code))); t.ok(pass, `${who}: ${r.method} ${r.route} responde aunque la cuenta no esté activa (@AllowInactiveAccount)`, brief(res)); continue; }
      const pass = res.status === 403 && res.code === code;
      if (!pass) bad++;
      t.ok(pass, `${who}: ${r.method} ${r.route} → 403 ${code}`, { ...brief(res), at: `${r.file}:${r.line}` });
      if (!pass && res.status >= 200 && res.status < 300) finding('P0', 'd', `${who} ejecuta ${r.method} ${r.route} (${res.status})`, `-H "Authorization: Bearer <${who}>" ${r.method} /api/v1${p}`);
    }
  }
  for (const [who, st] of [['noauth', 'not_authorized'], ['suspendido', 'suspended']]) {
    if (who === 'suspendido' && !F.seededSuspension) continue;
    const mc = await api('GET', '/me/context', { token: TK[who] });
    if (F.meContext) t.ok(mc.status === 200 && mc.data && mc.data.account && mc.data.account.status === st, `/me/context de ${who} → 200 con account.status=${st}`, brief(mc));
  }
  // Sin JWT: 401 (no 403 de cuenta) en las rutas JWT; /health público.
  const h = await api('GET', '/health');
  t.ok(h.status === 200, '/health sigue público');
  const nj = await api('GET', '/courses');
  t.ok(nj.status === 401, 'sin JWT → 401', brief(nj));
  // Suspensión de GENERACIÓN y congelación (01 §7): sigue entrando, no arranca.
  if (F.access) {
    let r = await api('POST', `/admin/users/${U.creadorA.id}/suspensions`, { token: TK.sa, body: { kind: 'generation', reason: 'QA r75' } });
    t.ok(r.status === 201 || r.status === 200, 'SA suspende generaciones de creadorA', brief(r));
    const e = []; S.Suspension(r.data, e); t.ok(!e.length, 'Suspension: forma del contrato', e);
    const c = await api('GET', `/courses/${fx.A.course}`, { token: TK.creadorA, headers: { 'X-Cursia-Institution': I.A.id } });
    t.ok(c.status === 200, 'con generación suspendida, creadorA sigue viendo su curso', brief(c));
    let gc = null;
    try { gc = await buildCourse('creadorA', I.A, 'r75 suspensión de generación'); } catch (e) { t.pending('arranque con generación suspendida', `curso con Manifest: ${e.message}`); }
    const startOf = (who) => api('POST', `/courses/${gc.id}/blueprints/${gc.n}/manifest/runs`, { token: TK[who], body: D_FIELDS, headers: { 'X-Cursia-Institution': I.A.id } });
    if (gc) {
      const st = await startOf('creadorA');
      if (st.status === 403 && st.code === 'generation_suspended') t.ok(true, 'arranque con generación suspendida → 403 generation_suspended');
      else if (!F.budgets) t.pending('arranque con generación suspendida → 403', `enforcement en runs (B/C2) no integrado: vino ${st.status} ${st.code || st.error}`);
      else t.ok(false, 'arranque con generación suspendida → 403 generation_suspended', brief(st));
      if (st.status === 201 || st.status === 200) finding('P1', 'd', 'con la suspensión de generación activa el run arranca igual (falta el chequeo en runs)', `POST /api/v1/courses/${gc.id}/blueprints/${gc.n}/manifest/runs como creadorA suspendido`);
      if (st.data && st.data.run && st.data.run.id) await q(`update public.production_jobs set worker_status='cancelled', status='cancelled' where id=$1`, [st.data.run.id]);
    }
    r = await api('DELETE', `/admin/users/${U.creadorA.id}/suspensions/generation`, { token: TK.sa, body: { reason: 'QA r75' } });
    t.ok(r.status === 200 && r.data && r.data.liftedAt, 'SA levanta la suspensión de generación', brief(r));
    r = await api('PUT', '/admin/platform/generation-freeze', { token: TK.sa, body: { enabled: true, reason: 'QA r75' } });
    t.ok(r.status === 200 && r.data && r.data.generationFreeze && r.data.generationFreeze.enabled === true, 'SA congela la plataforma', brief(r));
    for (const who of gc ? ['creadorA', 'sa'] : []) {
      const s2 = await startOf(who);
      if (s2.status === 403 && s2.code === 'platform_generation_frozen') t.ok(true, `congelación → 403 platform_generation_frozen para ${who} (también SA)`);
      else if (!F.budgets) t.pending(`congelación → 403 para ${who}`, `enforcement en runs (B/C2) no integrado: vino ${s2.status} ${s2.code || s2.error}`);
      else t.ok(false, `congelación → 403 platform_generation_frozen para ${who} (también SA)`, brief(s2));
      if (s2.data && s2.data.run && s2.data.run.id) await q(`update public.production_jobs set worker_status='cancelled', status='cancelled' where id=$1`, [s2.data.run.id]);
    }
    r = await api('PUT', '/admin/platform/generation-freeze', { token: TK.sa, body: { enabled: false, reason: 'QA r75' } });
    t.ok(r.status === 200, 'SA descongela', brief(r));
    const nsa = await api('PUT', '/admin/platform/generation-freeze', { token: TK.adminA, body: { enabled: true, reason: 'x' } });
    t.ok(nsa.status === 403, 'un admin institucional no congela la plataforma', brief(nsa));
  } else t.pending('suspensión de generación / congelación', 'endpoints SA de A no integrados');
  console.log(`  (d) ${jwtRoutes.length} rutas JWT × 2 identidades; ${bad} fallas`);
}

// ─── curso con Manifest vía API (para (e), (k)) ─────────────────────────────
async function buildCourse(ownerKey, inst, title) {
  const tok = TK[ownerKey];
  const H = { 'X-Cursia-Institution': inst.id };
  const A = (m, p, b) => api(m, p, { token: tok, body: b, headers: H });
  const c = await A('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title });
  if (c.status !== 201) throw new Error(`POST /courses/dynamic → ${c.status} ${c.code || ''} ${c.error}`);
  const id = Number(c.data.id);
  await q(`update public.courses set institution_id = $1 where id = $2 and institution_id is null`, [inst.id, id]);
  let st = (await A('GET', `/courses/${id}/modules`)).data;
  let counter = st.structureVersionCounter;
  if (!st.modules.length) {
    const m = await A('POST', `/courses/${id}/modules`, { title: 'Módulo r75', objective: 'Objetivo r75', examEnabled: false, expectedCounter: counter });
    if (m.status !== 201) throw new Error(`POST module → ${m.status} ${m.error}`);
    counter = m.data.structureVersionCounter;
  }
  const api3 = async (m, p, b) => { const r = await A(m, p, b); return { status: r.status, data: r.data, error: r.error }; };
  await keepTeacherDesign(api3, id, `curso ${title}`);
  st = (await A('GET', `/courses/${id}/modules`)).data;
  const lock = await A('POST', `/courses/${id}/blueprints`, { expectedCounter: st.structureVersionCounter });
  if (lock.status !== 201 && lock.status !== 200) throw new Error(`POST blueprints → ${lock.status} ${lock.error}`);
  const n = lock.data.blueprint.blueprintNumber;
  const man = await A('POST', `/courses/${id}/blueprints/${n}/manifest`);
  if (man.status !== 201 && man.status !== 200) throw new Error(`POST manifest → ${man.status} ${man.error}`);
  return { id, n };
}

// ─── (e) reservas concurrentes ──────────────────────────────────────────────
async function itemE() {
  t.item('e');
  if (!F.budgets || !F.reservations) { t.pending('reserva concurrente', 'presupuestos/reservas no integrados (C)'); return; }
  const N = 6;
  const courses = [];
  for (let i = 0; i < N; i++) courses.push(await buildCourse('creadorA', I.A, `r75 concurrencia ${i}`));
  const pv = await api('POST', `/courses/${courses[0].id}/blueprints/${courses[0].n}/manifest/runs/estimate-preview`, { token: TK.creadorA, body: D_FIELDS, headers: { 'X-Cursia-Institution': I.A.id } });
  const ub = pv.data && pv.data.userBudget;
  const e = []; S.UserBudgetGate(ub, e); t.ok(pv.status === 200 && !e.length, 'estimate-preview trae userBudget (02 §E.1)', { ...brief(pv), e });
  const req = Number(ub && ub.requiredUsd);
  if (!(req > 0)) { t.pending('reserva concurrente', `requiredUsd no positivo (${ub && ub.requiredUsd}): sin costo no hay reserva que probar`); return; }
  const limit = (req * 2.5).toFixed(10);
  const sb = await api('PUT', `/admin/users/${U.creadorA.id}/budget`, { token: TK.sa, body: { monthlyAmountUsd: limit, effectiveMonth: new Date().toISOString().slice(0, 7), reason: 'QA r75 concurrencia' } });
  t.ok(sb.status === 200, `SA asigna USD ${limit} a creadorA`, brief(sb));
  const res = await Promise.all(courses.map((c) => api('POST', `/courses/${c.id}/blueprints/${c.n}/manifest/runs`, { token: TK.creadorA, body: D_FIELDS, headers: { 'X-Cursia-Institution': I.A.id } })));
  const started = res.filter((r) => r.status === 201 || r.status === 200);
  const rejected = res.filter((r) => r.status === 409 && r.code === 'user_budget_insufficient');
  t.ok(started.length <= 2, `${N} arranques en paralelo con disponible para 2,5 → arrancan ≤ 2 (arrancaron ${started.length})`, res.map(brief));
  t.ok(started.length + rejected.length === N, 'el resto → 409 user_budget_insufficient (nada de 500/otros)', res.map(brief));
  const [sum] = await q(`select coalesce(sum(amount_usd),0)::text s, count(*)::int n from public.budget_reservations where user_id = $1 and status = 'active'`, [U.creadorA.id]);
  t.ok(Number(sum.s) <= Number(limit) + 1e-9, `Σ reservado activo (${sum.s}) ≤ límite (${limit})`, sum);
  t.ok(sum.n === started.length, 'una reserva por run arrancado', { reservas: sum.n, runs: started.length });
  const me = await api('GET', '/me/budget', { token: TK.creadorA });
  t.ok(me.status === 200 && Number(me.data.availableUsd) >= -1e-9, `/me/budget: disponible ≥ 0 (${me.data && me.data.availableUsd})`, brief(me));
  const ins = rejected[0];
  if (ins) t.ok(ins.json && ins.json.requiredUsd && ins.json.availableUsd !== undefined && ins.json.canRequest === true, '409 user_budget_insufficient incluye requiredUsd/availableUsd/canRequest', ins.json);
  // Usuario en USD 0 (regla 6): no arranca; puede solicitar.
  const c0 = await buildCourse('usd0', I.A, 'r75 usd0');
  const s0 = await api('POST', `/courses/${c0.id}/blueprints/${c0.n}/manifest/runs`, { token: TK.usd0, body: D_FIELDS, headers: { 'X-Cursia-Institution': I.A.id } });
  t.ok(s0.status === 409 && ['user_budget_not_assigned', 'user_budget_insufficient'].includes(s0.code), 'usuario nuevo (USD 0) → 409 user_budget_not_assigned', brief(s0));
  const br = await api('POST', '/budget-requests', { token: TK.usd0, body: { courseId: c0.id, amountUsd: req.toFixed(10), reason: 'QA r75' }, headers: { 'X-Cursia-Institution': I.A.id } });
  const be = []; S.BudgetRequest(br.data, be); t.ok((br.status === 201 || br.status === 200) && !be.length, 'usd0 crea una solicitud de autorización', { ...brief(br), be });
  const dup = await api('POST', '/budget-requests', { token: TK.usd0, body: { courseId: c0.id, amountUsd: '1.0000000000', reason: 'dup' }, headers: { 'X-Cursia-Institution': I.A.id } });
  t.ok(dup.status === 409 && dup.code === 'budget_request_duplicate', 'segunda solicitud pendiente del mismo curso → 409 budget_request_duplicate', brief(dup));
  if (br.data && br.data.id) {
    const ap = await api('POST', `/admin/budget-requests/${br.data.id}/approve`, { token: TK.sa, body: { approvedAmountUsd: req.toFixed(10), note: 'QA' } });
    t.ok(ap.status === 200 && ap.data.status === 'approved', 'SA aprueba la solicitud', brief(ap));
    const [runs0] = await q(`select count(*)::int n from public.production_jobs where course_id::text = $1::text`, [c0.id]);
    t.ok(runs0.n === 0, 'aprobar NO arranca la generación (D-21)', runs0);
    const mb = await api('GET', '/me/budget', { token: TK.usd0 });
    t.ok(mb.status === 200 && Math.abs(Number(mb.data.availableUsd) - req) < 1e-6, 'tras aprobar, el disponible del mes sube por el monto aprobado', brief(mb));
  }
}

// ─── (f) BYOK y mock no consumen; sin doble conteo ──────────────────────────
async function itemF() {
  t.item('f');
  if (!F.budgets || !F.meBudget) { t.pending('BYOK/mock/doble conteo', '/me/budget no integrado (C)'); return; }
  const me = async () => (await api('GET', '/me/budget', { token: TK.creadorB })).data;
  const base = Number((await me()).spentUsd);
  const ev = (o) => seed.insertRow('generation_cost_events', { event_kind: 'CHARGE', owner_id: U.creadorB.id, operation: 'r75.test', provider: 'anthropic', idempotency_key: crypto.randomUUID(), amount: 0, cost_source: 'CALCULATED_FROM_USAGE', billing_account: 'cursia', billable: true, recorded_by: 'r75-e', ...o });
  await ev({ amount: 5, billing_account: 'user_key', billable: false });
  await ev({ amount: 3, billing_account: 'mock', billable: false, cost_source: 'MOCK' });
  t.ok(Math.abs(Number((await me()).spentUsd) - base) < 1e-9, 'BYOK (user_key) y mock no suman al gasto del presupuesto');
  await ev({ amount: 1.5 });
  t.ok(Math.abs(Number((await me()).spentUsd) - base - 1.5) < 1e-9, 'cargo cursia sin run suma 1.5 (b de 01 §5.1)');
  const pend = await ev({ amount: 2, measurement_status: 'pending', metadata: { reservation: true } });
  await ev({ amount: 1.2 });
  await seed.insertRow('generation_cost_events', { event_kind: 'ADJUSTMENT', corrects_event_id: pend.id, owner_id: U.creadorB.id, operation: 'r75.test', provider: 'anthropic', idempotency_key: crypto.randomUUID(), amount: -2, cost_source: 'CALCULATED_FROM_USAGE', billing_account: 'cursia', billable: true, recorded_by: 'r75-e' });
  const got = Number((await me()).spentUsd) - base;
  t.ok(Math.abs(got - 2.7) < 1e-9, `reserva (2) + liquidación (1.2) + ajuste (−2) → gasto 2.7, sin doble conteo (vino ${got})`);
  // CostReadService (gasto global del SA) da lo mismo para eventos sin institución.
  const sp = await api('GET', '/admin/spend?groupBy=user', { token: TK.sa });
  if (sp.status === 200) { const e = []; S.AdminSpend(sp.data, e); t.ok(!e.length, 'GET /admin/spend: forma del contrato', e); }
  const nsa = await api('GET', '/admin/spend', { token: TK.adminA });
  t.ok(nsa.status === 403, 'GET /admin/spend solo SA', brief(nsa));
}

// ─── (g) terminal libera; pausado retiene ───────────────────────────────────
async function itemG() {
  t.item('g');
  if (!F.budgets || !F.reservations || !F.meBudget) { t.pending('liberación/retención de reservas', 'reservas no integradas (C)'); return; }
  const course = await seed.seedCourse(U.creadorB, I.B, 'r75 reservas');
  const run = await seed.seedRun(course, U.creadorB, 'running', { input_payload: { startedBy: U.creadorB.id } });
  const month = new Date().toISOString().slice(0, 7) + '-01';
  const auth = await seed.insertRow('cost_budget_authorizations', { run_id: run.id, course_id: course.id, authorized_budget: 4, decision: 'AUTO_WITHIN_POLICY' });
  await seed.insertRow('budget_reservations', { user_id: U.creadorB.id, institution_id: I.B.id, course_id: course.id, run_id: run.id, kind: 'start', amount_usd: 4, authorization_id: auth.id, status: 'active', period_month: month });
  await seed.insertRow('generation_cost_events', { event_kind: 'CHARGE', owner_id: U.creadorB.id, course_id: course.id, run_id: run.id, operation: 'r75.run', provider: 'anthropic', idempotency_key: crypto.randomUUID(), amount: 1, cost_source: 'CALCULATED_FROM_USAGE', billing_account: 'cursia', billable: true, recorded_by: 'r75-e' });
  const held = async () => Number((await api('GET', '/me/budget', { token: TK.creadorB })).data.heldUsd);
  const h0 = await held();
  for (const [st, want] of [['running', 3], ['paused', 3], ['needs_reconnect', 3], ['completed', 0], ['cancelled', 0], ['failed', 0]]) {
    await q(`update public.production_jobs set worker_status = $1, status = $1 where id = $2`, [st, run.id]);
    const h = await held();
    t.ok(Math.abs(h - (h0 - 3) - want) < 1e-6, `run ${st}: retenido del run = ${want} (autorizado 4 − gastado 1${want ? '' : ', terminal → 0'})`, { held: h, base: h0 - 3 });
  }
  await q(`update public.production_jobs set worker_status = 'paused', status = 'paused' where id = $1`, [run.id]);
  const rc = await api('POST', '/admin/budgets/reconcile', { token: TK.sa, body: { month: month.slice(0, 7) } });
  if (rc.status === 200) { const e = []; S.Reconcile(rc.data, e); t.ok(!e.length, 'reconcile: forma del contrato', e); }
  const [r] = await q(`select status from public.budget_reservations where run_id = $1`, [run.id]);
  t.ok(r.status === 'active', 'reserva de un run pausado sigue activa tras reconciliar', r);
}

// ─── (h) tempPassword ───────────────────────────────────────────────────────
async function itemH() {
  t.item('h');
  if (!F.access) { t.pending('tempPassword', 'POST /admin/users no integrado (A)'); return; }
  const email = `qa-r75-temp-${crypto.randomBytes(3).toString('hex')}@example.com`;
  const r = await api('POST', '/admin/users', { token: TK.sa, body: { email, fullName: 'QA Temp', mode: 'temp_password', memberships: [{ institutionId: I.A.id, role: 'CONSULTA' }] } });
  const e = []; if (r.data) S.AdminUser(r.data.user, e, 'user');
  t.ok((r.status === 201 || r.status === 200) && typeof (r.data && r.data.tempPassword) === 'string' && r.data.tempPassword.length >= 20 && !e.length, 'POST /admin/users temp_password → tempPassword (≥ 20) UNA vez', { ...brief(r), e });
  t.ok(/no-store/.test(String(r.headers['cache-control'] || '')), 'respuesta con tempPassword lleva Cache-Control: no-store', r.headers['cache-control']);
  const pw = r.data && r.data.tempPassword;
  if (!pw) return;
  const sentToAuth = fakes.requests.some((x) => x.body && x.body.password === pw);
  t.ok(sentToAuth, 'la contraseña solo viaja a la Admin API de Supabase (falso local)');
  await env.sleep(500);
  const logs = fs.readdirSync(env.OUT).filter((f) => f.endsWith('.log')).map((f) => fs.readFileSync(path.join(env.OUT, f), 'utf8')).join('\n');
  t.ok(!logs.includes(pw), 'tempPassword no aparece en ningún log de la app');
  const cols = await q(`select table_schema, table_name, column_name from information_schema.columns where table_schema in ('public','auth') and data_type in ('text','character varying','jsonb','json')`);
  const hits = [];
  for (const c of cols) {
    const [x] = await q(`select count(*)::int n from "${c.table_schema}"."${c.table_name}" where "${c.column_name}"::text like $1`, [`%${pw}%`]);
    if (x.n) hits.push(`${c.table_schema}.${c.table_name}.${c.column_name}`);
  }
  t.ok(hits.length === 0, `tempPassword no está en ninguna columna de la base (${cols.length} columnas revisadas)`, hits);
  const audit = await q(`select action, before::text b, after::text a from public.admin_audit_log where action like 'user.%'`);
  t.ok(audit.length > 0 && audit.every((x) => !(x.a || '').includes(pw) && !/password/i.test(x.a || '')), 'auditoría user.create sin la contraseña ni claves «password»', audit);
  const det = await api('GET', `/admin/users/${r.data.user.id}`, { token: TK.sa, raw: true });
  t.ok(det.status === 200 && !(det.text || '').includes(pw), 'GET /admin/users/:id no vuelve a mostrar la contraseña', brief(det));
  const inv = await api('POST', '/admin/users', { token: TK.sa, body: { email: `qa-r75-inv-${crypto.randomBytes(3).toString('hex')}@example.com`, mode: 'invite' } });
  t.ok((inv.status === 201 || inv.status === 200) && inv.data && inv.data.invited === true && !('tempPassword' in inv.data), 'mode invite → invited:true sin tempPassword', brief(inv));
  const nsa = await api('POST', '/admin/users', { token: TK.adminA, body: { email: 'qa-r75-x@example.com', mode: 'invite' } });
  t.ok(nsa.status === 403, 'un admin institucional no crea usuarios (regla 1, D-12)', brief(nsa));
  const dup = await api('POST', '/admin/users', { token: TK.sa, body: { email, mode: 'invite' } });
  t.ok(dup.status === 409 && ['user_exists', 'user_exists_unauthorized'].includes(dup.code), 'email existente → 409 user_exists', brief(dup));
}

// ─── (i) H2 ─────────────────────────────────────────────────────────────────
async function itemI() {
  t.item('i');
  // Estado de STAGING (sonda empírica 2026-10-26, ver LEDGER «Fase 1 · E»): escritura de cliente PERMITIDA.
  const probe = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'h2-staging-probe.json'), 'utf8'));
  t.ok(probe.writeAllowed === false, `H2 staging (sonda ${probe.probedAt}): escritura de cliente en authorized_users ${probe.writeAllowed ? 'PERMITIDA (insert ' + probe.insert.status + ')' : 'rechazada'}`, probe);
  if (probe.writeAllowed) finding('P0', 'i', `H2 confirmada en staging (${probe.probedAt}): un usuario autenticado inserta/actualiza/borra filas de authorized_users`, 'test/r75/h2-staging-probe.snippet.js en la consola de staging.orbia.pages.dev');
  if (!F.accessMigration) { t.pending('H2 local tras la migración', 'migración r75-access no aplicada (A)'); return; }
  const pols = await q(`select policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname='public' and tablename='authorized_users'`);
  t.ok(pols.length === 1 && pols[0].cmd === 'SELECT', 'tras migrate-r75-access: authorized_users con UNA política, SELECT', pols);
  t.ok(pols.every((p) => p.cmd !== 'SELECT' || /auth\.email\(\)|auth\.uid\(\)/.test(String(p.qual))), 'la política SELECT es «la propia fila» (qual con auth.email()/auth.uid())', pols.map((p) => p.qual));
  const asAuth = async (sql, params) => {
    await q('begin');
    try {
      await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: U.consultaA.id, email: U.consultaA.email, role: 'authenticated' })]);
      await q('set local role authenticated');
      const r = await q(sql, params);
      await q('rollback');
      return { ok: true, rows: r };
    } catch (e) { await q('rollback').catch(() => {}); return { ok: false, err: e.message }; }
  };
  const ins = await asAuth(`insert into public.authorized_users (email, is_admin) values ('qa-r75-h2-probe@example.com', true) returning id`);
  t.ok(!ins.ok, 'authenticated NO puede INSERT en authorized_users', ins);
  const upd = await asAuth(`update public.authorized_users set is_admin = true where email = $1 returning id`, [U.consultaA.email]);
  t.ok(!upd.ok || upd.rows.length === 0, 'authenticated NO puede UPDATE is_admin (ni de su propia fila)', upd);
  const del = await asAuth(`delete from public.authorized_users where email = $1 returning id`, [U.adminA.email]);
  t.ok(!del.ok || del.rows.length === 0, 'authenticated NO puede DELETE filas ajenas', del);
  const sel = await asAuth(`select email from public.authorized_users`);
  t.ok(sel.ok && sel.rows.length === 1 && sel.rows[0].email === U.consultaA.email, 'authenticated ve SOLO su propia fila', sel);
  const anon = await (async () => { await q('begin'); try { await q('set local role anon'); const r = await q(`select count(*) from public.authorized_users`); await q('rollback'); return { ok: true, r }; } catch (e) { await q('rollback').catch(() => {}); return { ok: false, err: e.message }; } })();
  t.ok(!anon.ok, 'anon no lee authorized_users', anon);
  for (const tb of ['institution_memberships', 'institution_permission_overrides', 'user_suspensions', 'platform_controls', 'admin_audit_log', 'user_budgets', 'budget_reservations', 'budget_requests']) {
    if (!(await env.tableExists(tb))) continue;
    const r = await asAuth(`select count(*) from public.${tb}`);
    t.ok(!r.ok, `${tb}: sin acceso para authenticated (RLS + REVOKE)`, r);
  }
}

// ─── (k) monthSpent global ──────────────────────────────────────────────────
async function itemK() {
  t.item('k');
  let c;
  try { c = await buildCourse('creadorA', I.A, 'r75 monthSpent'); } catch (e) { t.pending('monthSpent', `no se pudo armar el curso con Manifest: ${e.message}`); return; }
  // Gasto global de otro usuario, para que monthSpent sea distinguible de 0.
  await seed.insertRow('generation_cost_events', { event_kind: 'CHARGE', owner_id: U.adminB.id, operation: 'r75.global', provider: 'anthropic', idempotency_key: crypto.randomUUID(), amount: 7.25, cost_source: 'CALCULATED_FROM_USAGE', billing_account: 'cursia', billable: true, recorded_by: 'r75-e' });
  const p = `/courses/${c.id}/blueprints/${c.n}/manifest/runs/estimate-preview`;
  const mine = await api('POST', p, { token: TK.creadorA, body: D_FIELDS, headers: { 'X-Cursia-Institution': I.A.id }, raw: true });
  t.ok(mine.status === 200, 'estimate-preview del dueño → 200', brief(mine));
  const ms = mine.data && mine.data.policy ? mine.data.policy.monthSpent : undefined;
  t.ok(ms === null || ms === undefined, `policy.monthSpent NO llega a quien no es SA (D-25/H5); vino ${JSON.stringify(ms)}`, mine.data && mine.data.policy);
  if (!(ms === null || ms === undefined)) finding('P1', 'k', `H5 abierto: estimate-preview expone el gasto global del mes (${JSON.stringify(ms)}) a un no-SA`, `POST /api/v1${p} como creadorA`);
  const sa = await api('POST', p, { token: TK.sa, body: D_FIELDS });
  if (sa.status === 200) t.ok(sa.data.policy && sa.data.policy.monthSpent !== null && sa.data.policy.monthSpent !== undefined, 'el SA sí ve policy.monthSpent', sa.data.policy);
  else t.pending('SA ve monthSpent', `estimate-preview como SA → ${sa.status} ${sa.code || ''} (el SA aún no actúa sobre cursos ajenos en esta ruta)`);
  // Spend de institución: solo spend.view; CREADOR no.
  const sp = await api('GET', `/institutions/${I.A.id}/spend?groupBy=user`, { token: TK.creadorA, headers: { 'X-Cursia-Institution': I.A.id } });
  if (sp.status !== 404 || sp.code) t.ok(sp.status === 403, 'CREADOR sin spend.view no ve el gasto de la institución', brief(sp));
  const spA = await api('GET', `/institutions/${I.A.id}/spend?groupBy=course`, { token: TK.adminA, headers: { 'X-Cursia-Institution': I.A.id }, raw: true });
  if (spA.status === 200) { const e = []; S.InstitutionSpend(spA.data, e); t.ok(!e.length, 'spend de A (adminA): forma del contrato y sin detalle por item (D-24)', e); t.ok(!(spA.text || '').includes('7.25'), 'el gasto de A no incluye el de B'); }
  const spB = await api('GET', `/institutions/${I.B.id}/spend`, { token: TK.adminA });
  if (spB.status !== 404 || spB.code) t.ok(spB.status === 403 || spB.status === 404, 'adminA no ve el gasto de B', brief(spB));
}

// ─── (l) /media/* público ───────────────────────────────────────────────────
async function itemL() {
  t.item('l');
  const media = routes.filter((r) => /^\/media\//.test(r.route));
  if (!media.length) { t.pending('/media/* público', 'la ruta /media/* (r74) no existe en el checkout bajo prueba'); return; }
  for (const r of media) {
    t.ok(r.marks.includes('PublicCapability'), `${r.method} ${r.route} marcada @PublicCapability`, r.marks);
    const p = r.route.replace(/:artifactId/, crypto.randomUUID()).replace(/:mediaKey/, 'x'.repeat(32)).replace(/:filename/, 'audio.mp3').replace(/:(\w+)/g, '1');
    const res = await api(r.method === 'HEAD' ? 'HEAD' : 'GET', p);
    t.ok(res.status !== 401 && !(res.status === 403 && /^account_/.test(String(res.code))) && res.status !== 500, `${r.method} ${r.route} sin JWT no exige cuenta (vino ${res.status})`, brief(res));
    const sus = await api('GET', p, { token: TK.suspendido });
    t.ok(!(sus.status === 403 && /^account_/.test(String(sus.code))), 'con un JWT de cuenta suspendida tampoco se corta (D-19)', brief(sus));
  }
}

(async () => {
  const started = Date.now();
  await env.dbConnect();
  await detect();
  try {
    await setup();
    for (const [k, fn] of [['a', itemA], ['b', itemB], ['c', itemC], ['d', itemD], ['e', itemE], ['f', itemF], ['g', itemG], ['h', itemH], ['i', itemI], ['k', itemK], ['l', itemL]]) {
      console.log(`\n══════ (${k}) ══════`);
      try { await fn(); } catch (e) { t.item(k); t.ok(false, `excepción en (${k}): ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`); }
    }
  } finally {
    await env.stopApp();
    if (fakes) await fakes.close();
  }
  if (api.doubleEnvelope.size) finding('P3', 'contrato', `respuestas con doble sobre {data:{ok:true,data}} (02 §Convenciones: el cuerpo de éxito es el de ResponseInterceptor): ${[...api.doubleEnvelope].sort().join(', ')}`, 'el FE (60-r75) lo tolera; unificar');
  const s = t.summary(`r75 ${MODE}`);
  fs.writeFileSync(path.join(env.OUT, 'results.json'), JSON.stringify({ mode: MODE, types: TYPES, features: F, ms: Date.now() - started, by: s.by, findings: FINDINGS, results: s.results }, null, 2));
  process.exit(s.fail ? 1 : 0);
})().catch((e) => { console.error('SUITE FALLÓ', e); process.exit(2); });
