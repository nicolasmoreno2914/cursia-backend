// Genera test/r75/fixtures/contracts/*.json a partir de 02-contratos-api.md (§A–§F).
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = process.argv[2] || path.join(__dirname, "contracts");
fs.mkdirSync(OUT, { recursive: true });

const TS = '2026-10-26T12:00:00.000Z';
const U = {
  sa: '0a000000-0000-4000-8000-000000000001',
  adminA: '0a000000-0000-4000-8000-000000000002',
  creadorA: '0a000000-0000-4000-8000-000000000003',
  aprobadorA: '0a000000-0000-4000-8000-000000000004',
  consultaA: '0a000000-0000-4000-8000-000000000005',
  adminB: '0a000000-0000-4000-8000-000000000006',
  suspendido: '0a000000-0000-4000-8000-000000000007',
};
const E = {
  sa: 'qa-r75-superadmin@example.com', adminA: 'qa-r75-admin-inst-a@example.com', creadorA: 'qa-r75-creador-a@example.com',
  aprobadorA: 'qa-r75-aprobador-a@example.com', consultaA: 'qa-r75-consulta-a@example.com', adminB: 'qa-r75-admin-inst-b@example.com',
  suspendido: 'qa-r75-suspendido@example.com',
};
const I = { A: '1b000000-0000-4000-8000-00000000000a', B: '1b000000-0000-4000-8000-00000000000b', P: '1b000000-0000-4000-8000-0000000000ff' };
const RUN = '2c000000-0000-4000-8000-000000000001';
const EST = '3d000000-0000-4000-8000-000000000001';
const REQ = '4e000000-0000-4000-8000-000000000001';
const RES = '5f000000-0000-4000-8000-000000000001';

const ROLES = ['ADMIN_INSTITUCIONAL', 'CREADOR', 'APROBADOR_ACADEMICO', 'CONSULTA'];
const MATRIX = {
  ADMIN_INSTITUCIONAL: ['courses.view', 'courses.create', 'courses.edit', 'courses.delete', 'proposals.review', 'generations.retry', 'exports.download', 'spend.view', 'roles.manage'],
  CREADOR: ['courses.view', 'courses.create', 'courses.edit', 'proposals.review', 'generations.start', 'generations.retry', 'exports.download'],
  APROBADOR_ACADEMICO: ['courses.view', 'proposals.review', 'proposals.approve', 'exports.download'],
  CONSULTA: ['courses.view'],
};
const CATALOG = [
  ['courses.view', 'Ver cursos', false, true], ['courses.create', 'Crear cursos', false, true], ['courses.edit', 'Editar cursos', false, true],
  ['courses.delete', 'Eliminar cursos', true, true], ['proposals.review', 'Revisar propuestas (preparar, pedir ajustes, retirar)', false, true],
  ['proposals.approve', 'Aprobar propuestas', true, true], ['generations.start', 'Iniciar generaciones (gasta presupuesto)', true, true],
  ['generations.retry', 'Reintentar / reanudar generaciones', true, true], ['exports.download', 'Descargar / exportar (.mbz, PDF, artifacts)', true, true],
  ['spend.view', 'Consultar gastos de la institución', true, true], ['roles.manage', 'Administrar roles y miembros de la institución', true, true],
  ['budgets.manage', 'Administrar presupuestos', true, false], ['users.suspend', 'Suspender usuarios', true, false],
  ['generations.suspend', 'Suspender generaciones', true, false],
].map(([key, label, sensitive, grantable]) => ({ key, label, sensitive, grantable }));
const ALL_PERMS = CATALOG.map((p) => p.key);

const budget = (o = {}) => ({ month: '2026-10', limitUsd: '0.0000000000', spentUsd: '0.0000000000', heldUsd: '0.0000000000', availableUsd: '0.0000000000', pendingRequests: 0, ...o });
const budgetCreador = budget({ limitUsd: '25.0000000000', spentUsd: '4.1250000000', heldUsd: '6.0000000000', availableUsd: '14.8750000000', pendingRequests: 1 });
const inst = (id, name, slug, kind = 'organization', extra = {}) => ({ id, name, slug, kind, status: 'active', createdAt: '2026-10-20T15:00:00.000Z', ...extra });
const instA = inst(I.A, 'QA r75 Institución A', 'qa-r75-institucion-a', 'organization', { memberCount: 4 });
const instB = inst(I.B, 'QA r75 Institución B', 'qa-r75-institucion-b', 'organization', { memberCount: 2 });
const membership = (institutionId, name, role, kind = 'organization', extraGrants = []) => ({
  institutionId, name, kind, role, status: 'active', permissions: [...new Set([...MATRIX[role], ...extraGrants])],
});
const member = (userId, email, role, o = {}) => ({
  userId, email, fullName: o.fullName === undefined ? null : o.fullName, role, status: o.status || 'active',
  overrides: o.overrides || { grants: [], denies: [] },
  effectivePermissions: o.effective || MATRIX[role], accountStatus: o.accountStatus || 'active', createdAt: '2026-10-21T10:00:00.000Z',
});
const adminUser = (id, email, o = {}) => ({
  id, email, fullName: o.fullName || null, authorized: o.authorized !== false, accountStatus: o.accountStatus || 'active',
  generationSuspended: !!o.generationSuspended, superAdmin: !!o.superAdmin, lastSignInAt: o.lastSignInAt === undefined ? '2026-10-25T22:10:00.000Z' : o.lastSignInAt,
  createdAt: '2026-10-21T10:00:00.000Z', memberships: o.memberships || [], budget: o.budget || budget(),
});
const suspension = (o = {}) => ({ id: '6a000000-0000-4000-8000-000000000001', kind: 'account', reason: 'QA r75: prueba de suspensión', createdBy: U.sa, createdAt: '2026-10-26T11:00:00.000Z', liftedBy: null, liftedAt: null, ...o });
const reservation = (o = {}) => ({ id: RES, userId: U.creadorA, institutionId: I.A, courseId: 4242, runId: RUN, kind: 'start', amountUsd: '10.0000000000', liveHeldUsd: '6.0000000000', status: 'active', periodMonth: '2026-10', createdAt: '2026-10-26T09:00:00.000Z', ...o });
const breq = (o = {}) => ({ id: REQ, userId: U.creadorA, email: E.creadorA, institutionId: I.A, courseId: 4242, courseTitle: 'QA r75 · Curso de prueba', runId: null, estimateId: EST, amountUsd: '18.5000000000', reason: 'El estimado supera mi disponible.', status: 'pending', decidedBy: null, decidedAt: null, decisionNote: null, approvedAmountUsd: null, createdAt: '2026-10-26T10:00:00.000Z', expiresAt: '2026-11-02T10:00:00.000Z', ...o });
const budgetDetail = (o = {}) => ({ ...budgetCreador, userId: U.creadorA, versions: [
  { id: '7b000000-0000-4000-8000-000000000001', kind: 'recurring', effectiveMonth: '2026-10', amountUsd: '20.0000000000', version: 1, reason: 'Asignación inicial QA', createdBy: U.sa, createdAt: '2026-10-21T10:05:00.000Z', sourceRequestId: null },
  { id: '7b000000-0000-4000-8000-000000000002', kind: 'month_adjustment', effectiveMonth: '2026-10', amountUsd: '5.0000000000', version: 1, reason: 'Solicitud aprobada', createdBy: U.sa, createdAt: '2026-10-24T10:05:00.000Z', sourceRequestId: '4e000000-0000-4000-8000-000000000000' },
], ...o });

// Cuerpo real del backend: éxito → ResponseInterceptor {data, timestamp}; error → AllExceptionsFilter.
const ok = (data, status = 200, headers) => ({ status, ...(headers ? { headers } : {}), body: { data, timestamp: TS } });
const err = (status, code, message, extra = {}, p = '/api/v1/…') => ({ status, body: { statusCode: status, timestamp: TS, path: p, error: message, code, ...extra } });

const files = {};
files['me-context.json'] = {
  'GET /me/context#superadmin': ok({ user: { id: U.sa, email: E.sa }, superAdmin: true, account: { authorized: true, status: 'active', mustChangePassword: false }, generation: { suspended: false, platformFrozen: false }, rbacMode: 'enforce', budgetsMode: 'enforce', memberships: [], defaultInstitutionId: null, budget: budget(), institutionHeader: true }),
  'GET /me/context#creador_multi_institucion': ok({ user: { id: U.creadorA, email: E.creadorA }, superAdmin: false, account: { authorized: true, status: 'active', mustChangePassword: true }, generation: { suspended: false, platformFrozen: false }, rbacMode: 'enforce', budgetsMode: 'enforce', memberships: [membership(I.A, instA.name, 'CREADOR'), membership(I.B, instB.name, 'CONSULTA')], defaultInstitutionId: I.A, budget: budgetCreador, institutionHeader: true }),
  'GET /me/context#admin_institucional': ok({ user: { id: U.adminA, email: E.adminA }, superAdmin: false, account: { authorized: true, status: 'active', mustChangePassword: false }, generation: { suspended: false, platformFrozen: false }, rbacMode: 'enforce', budgetsMode: 'enforce', memberships: [membership(I.A, instA.name, 'ADMIN_INSTITUCIONAL')], defaultInstitutionId: I.A, budget: budget(), institutionHeader: true }),
  'GET /me/context#aprobador': ok({ user: { id: U.aprobadorA, email: E.aprobadorA }, superAdmin: false, account: { authorized: true, status: 'active', mustChangePassword: false }, generation: { suspended: false, platformFrozen: false }, rbacMode: 'enforce', budgetsMode: 'enforce', memberships: [membership(I.A, instA.name, 'APROBADOR_ACADEMICO')], defaultInstitutionId: I.A, budget: budget(), institutionHeader: true }),
  'GET /me/context#consulta': ok({ user: { id: U.consultaA, email: E.consultaA }, superAdmin: false, account: { authorized: true, status: 'active', mustChangePassword: false }, generation: { suspended: false, platformFrozen: false }, rbacMode: 'enforce', budgetsMode: 'enforce', memberships: [membership(I.A, instA.name, 'CONSULTA')], defaultInstitutionId: I.A, budget: budget(), institutionHeader: true }),
  'GET /me/context#suspendido': ok({ user: { id: U.suspendido, email: E.suspendido }, superAdmin: false, account: { authorized: true, status: 'suspended', mustChangePassword: false }, generation: { suspended: false, platformFrozen: false }, rbacMode: 'enforce', budgetsMode: 'enforce', memberships: [membership(I.A, instA.name, 'CREADOR')], defaultInstitutionId: I.A, budget: budget(), institutionHeader: true }),
  'GET /me/context#no_autorizado': ok({ user: { id: '0a000000-0000-4000-8000-0000000000ee', email: 'qa-r75-sin-acceso@example.com' }, superAdmin: false, account: { authorized: false, status: 'not_authorized', mustChangePassword: false }, generation: { suspended: false, platformFrozen: false }, rbacMode: 'enforce', budgetsMode: 'enforce', memberships: [], defaultInstitutionId: null, budget: null, institutionHeader: true }),
  'GET /me/context#generacion_suspendida_y_congelada': ok({ user: { id: U.creadorA, email: E.creadorA }, superAdmin: false, account: { authorized: true, status: 'active', mustChangePassword: false }, generation: { suspended: true, platformFrozen: true }, rbacMode: 'enforce', budgetsMode: 'enforce', memberships: [membership(I.A, instA.name, 'CREADOR')], defaultInstitutionId: I.A, budget: budgetCreador, institutionHeader: true }),
  'GET /me/context#modos_off': ok({ user: { id: U.creadorA, email: E.creadorA }, superAdmin: false, account: { authorized: true, status: 'active', mustChangePassword: false }, generation: { suspended: false, platformFrozen: false }, rbacMode: 'off', budgetsMode: 'off', memberships: [membership(I.P, 'Espacio de qa-r75-creador-a@example.com', 'ADMIN_INSTITUCIONAL', 'personal', ['proposals.approve', 'generations.start'])], defaultInstitutionId: I.P, budget: null, institutionHeader: true }),
};
files['permissions-catalog.json'] = {
  'GET /permissions/catalog': ok({ roles: ROLES, permissions: CATALOG, matrix: MATRIX }),
};
files['institutions.json'] = {
  'GET /institutions': ok([instA, instB]),
  'GET /institutions?all=1#superadmin': ok([instA, instB, inst(I.P, 'Espacio de qa-r75-creador-a@example.com', 'personal-0a000000', 'personal', { memberCount: 1 })]),
  'GET /institutions/:id': ok(instA),
  'POST /institutions#rbac_off': ok(inst('1b000000-0000-4000-8000-0000000000c1', 'Mi institución', 'mi-institucion-1b00'), 201),
  'POST /admin/institutions': ok(inst('1b000000-0000-4000-8000-0000000000c2', 'QA r75 Institución C', 'qa-r75-institucion-c', 'organization', { memberCount: 0 }), 201),
  'PATCH /admin/institutions/:id': ok({ ...instB, status: 'suspended' }),
  'PATCH /admin/courses/:courseId/institution': ok({ courseId: 4242, institutionId: I.B }),
};
files['members.json'] = {
  'GET /institutions/:id/members': ok([
    member(U.adminA, E.adminA, 'ADMIN_INSTITUCIONAL', { fullName: 'Admin A (QA)' }),
    member(U.creadorA, E.creadorA, 'CREADOR', { overrides: { grants: ['proposals.approve'], denies: ['exports.download'] }, effective: ['courses.view', 'courses.create', 'courses.edit', 'proposals.review', 'proposals.approve', 'generations.start', 'generations.retry'] }),
    member(U.aprobadorA, E.aprobadorA, 'APROBADOR_ACADEMICO'),
    member(U.consultaA, E.consultaA, 'CONSULTA'),
    member(U.suspendido, E.suspendido, 'CREADOR', { status: 'suspended', accountStatus: 'suspended' }),
  ]),
  'POST /institutions/:id/members': ok(member(U.consultaA, E.consultaA, 'CONSULTA'), 201),
  'PATCH /institutions/:id/members/:userId': ok(member(U.consultaA, E.consultaA, 'APROBADOR_ACADEMICO')),
  'DELETE /institutions/:id/members/:userId': ok({ status: 'removed' }),
  'PUT /institutions/:id/members/:userId/overrides': ok(member(U.creadorA, E.creadorA, 'CREADOR', { overrides: { grants: ['proposals.approve'], denies: ['exports.download'] }, effective: ['courses.view', 'courses.create', 'courses.edit', 'proposals.review', 'proposals.approve', 'generations.start', 'generations.retry'] })),
};
const auCreador = adminUser(U.creadorA, E.creadorA, { fullName: 'Creador A (QA)', memberships: [{ institutionId: I.A, name: instA.name, role: 'CREADOR', status: 'active' }, { institutionId: I.B, name: instB.name, role: 'CONSULTA', status: 'active' }], budget: budgetCreador });
files['admin-users.json'] = {
  'GET /admin/users': ok({ items: [adminUser(U.sa, E.sa, { superAdmin: true }), auCreador, adminUser(U.suspendido, E.suspendido, { accountStatus: 'suspended', memberships: [{ institutionId: I.A, name: instA.name, role: 'CREADOR', status: 'active' }] })], total: 3 }),
  'POST /admin/users#invite': ok({ user: adminUser('0a000000-0000-4000-8000-0000000000a1', 'qa-r75-nuevo@example.com', { lastSignInAt: null, memberships: [{ institutionId: I.A, name: instA.name, role: 'CONSULTA', status: 'active' }] }), invited: true }, 201),
  'POST /admin/users#temp_password': ok({ user: adminUser('0a000000-0000-4000-8000-0000000000a2', 'qa-r75-temporal@example.com', { lastSignInAt: null }), tempPassword: 'EJEMPLO-no-es-real-1234', invited: false }, 201, { 'Cache-Control': 'no-store' }),
  'GET /admin/users/:userId': ok({ ...auCreador, suspensions: [suspension({ kind: 'generation', liftedBy: U.sa, liftedAt: '2026-10-26T11:30:00.000Z' })], recentRuns: [{ runId: RUN, courseId: 4242, status: 'running', startedAt: '2026-10-26T09:00:00.000Z' }] }),
  'POST /admin/users/:userId/authorize': ok(adminUser('0a000000-0000-4000-8000-0000000000a3', 'qa-r75-registrado@example.com', { lastSignInAt: null })),
  'POST /admin/users/:userId/repair': ok(adminUser('0a000000-0000-4000-8000-0000000000a2', 'qa-r75-temporal@example.com', { lastSignInAt: null })),
  'POST /admin/users/:userId/suspensions': ok(suspension(), 201),
  'DELETE /admin/users/:userId/suspensions/:kind': ok(suspension({ liftedBy: U.sa, liftedAt: '2026-10-26T12:00:00.000Z' })),
};
const freeze = (enabled) => ({ generationFreeze: { enabled, reason: enabled ? 'QA r75: congelación de prueba' : null, updatedAt: '2026-10-26T11:45:00.000Z', updatedBy: U.sa } });
files['platform-controls.json'] = {
  'GET /admin/platform/controls': ok(freeze(false)),
  'PUT /admin/platform/generation-freeze': ok(freeze(true)),
};
files['audit-log.json'] = {
  'GET /admin/audit-log': ok({ items: [
    { id: 103, at: '2026-10-26T11:00:00.000Z', actorId: U.sa, actorEmail: E.sa, action: 'suspension.create', targetType: 'user', targetId: U.suspendido, institutionId: null, before: null, after: { kind: 'account', reason: 'QA r75: prueba de suspensión' } },
    { id: 102, at: '2026-10-26T10:30:00.000Z', actorId: U.adminA, actorEmail: E.adminA, action: 'membership.update', targetType: 'membership', targetId: `${I.A}:${U.consultaA}`, institutionId: I.A, before: { role: 'CONSULTA' }, after: { role: 'APROBADOR_ACADEMICO' } },
    { id: 101, at: '2026-10-26T10:00:00.000Z', actorId: U.sa, actorEmail: E.sa, action: 'user.create', targetType: 'user', targetId: '0a000000-0000-4000-8000-0000000000a2', institutionId: null, before: null, after: { email: 'qa-r75-temporal@example.com', mode: 'temp_password' } },
  ], nextCursor: '100' }),
};
files['budgets.json'] = {
  'GET /me/budget': ok({ ...budgetCreador, reservations: [reservation()] }),
  'GET /me/budget#usd_0': ok({ ...budget(), reservations: [] }),
  'GET /admin/budgets': ok({ items: [{ ...budgetCreador, userId: U.creadorA, email: E.creadorA }, { ...budget(), userId: U.consultaA, email: E.consultaA }], total: 2 }),
  'GET /admin/users/:userId/budget': ok(budgetDetail()),
  'PUT /admin/users/:userId/budget': ok(budgetDetail()),
  'POST /admin/users/:userId/budget-adjustments': ok(budgetDetail()),
  'GET /admin/budget-reservations': ok([reservation(), reservation({ id: '5f000000-0000-4000-8000-000000000002', runId: '2c000000-0000-4000-8000-000000000002', status: 'settled', liveHeldUsd: '0.0000000000', amountUsd: '4.5000000000' })]),
};
files['budget-requests.json'] = {
  'POST /budget-requests': ok(breq(), 201),
  'GET /me/budget-requests': ok([breq(), breq({ id: '4e000000-0000-4000-8000-000000000000', status: 'approved', decidedBy: U.sa, decidedAt: '2026-10-24T10:05:00.000Z', decisionNote: 'Aprobado para QA', approvedAmountUsd: '5.0000000000', amountUsd: '5.0000000000' })]),
  'POST /budget-requests/:id/cancel': ok(breq({ status: 'cancelled' })),
  'GET /admin/budget-requests': ok([breq()]),
  'POST /admin/budget-requests/:id/approve': ok(breq({ status: 'approved', decidedBy: U.sa, decidedAt: TS, decisionNote: 'Aprobado', approvedAmountUsd: '18.5000000000' })),
  'POST /admin/budget-requests/:id/reject': ok(breq({ status: 'rejected', decidedBy: U.sa, decidedAt: TS, decisionNote: 'Fuera del plan del mes' })),
};
files['spend.json'] = {
  'GET /institutions/:id/spend?groupBy=user': ok({ institutionId: I.A, from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z', actualUsd: '4.1250000000', reservedUsd: '0.7500000000', committedUsd: '4.8750000000', byUser: [{ userId: U.creadorA, email: E.creadorA, actualUsd: '4.1250000000', committedUsd: '4.8750000000' }] }),
  'GET /institutions/:id/spend?groupBy=course': ok({ institutionId: I.A, from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z', actualUsd: '4.1250000000', reservedUsd: '0.7500000000', committedUsd: '4.8750000000', byCourse: [{ courseId: 4242, title: 'QA r75 · Curso de prueba', actualUsd: '4.1250000000', committedUsd: '4.8750000000' }] }),
  'GET /institutions/:id/spend?groupBy=provider': ok({ institutionId: I.A, from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z', actualUsd: '4.1250000000', reservedUsd: '0.7500000000', committedUsd: '4.8750000000', byProvider: [{ provider: 'anthropic', actualUsd: '3.0000000000' }, { provider: 'openai_tts', actualUsd: '1.1250000000' }] }),
  'GET /admin/spend': ok({ rows: [{ key: I.A, label: instA.name, actualUsd: '4.1250000000', reservedUsd: '0.7500000000', committedUsd: '4.8750000000' }, { key: I.B, label: instB.name, actualUsd: '0.0000000000', reservedUsd: '0.0000000000', committedUsd: '0.0000000000' }], unattributedUsd: '0.3100000000' }),
  'POST /admin/budgets/reconcile': ok({ users: [{ userId: U.creadorA, ledgerSpentUsd: '4.1250000000', settledReservationsUsd: '4.1250000000', driftUsd: '0.0000000000' }] }),
};
const ub = (o) => ({ mode: 'enforce', month: '2026-10', availableUsd: '14.8750000000', requiredUsd: '9.2000000000', sufficient: true, canRequest: true, payerUserId: U.creadorA, ...o });
files['estimate-preview.json'] = {
  '_nota': 'Solo los campos que r75 agrega (02 §E.1); el resto de la respuesta de estimate-preview no cambia. policy.monthSpent es null para quien no es SA (D-25).',
  'POST …/runs/estimate-preview#suficiente_no_sa': ok({ userBudget: ub(), policy: { monthSpent: null } }),
  'POST …/runs/estimate-preview#insuficiente_no_sa': ok({ userBudget: ub({ availableUsd: '0.0000000000', requiredUsd: '9.2000000000', sufficient: false }), policy: { monthSpent: null } }),
  'POST …/runs/estimate-preview#superadmin': ok({ userBudget: ub({ payerUserId: U.sa, availableUsd: '50.0000000000' }), policy: { monthSpent: '312.4400000000' } }),
  'POST …/runs/estimate-preview#budgets_off': ok({ userBudget: ub({ mode: 'off', sufficient: true, canRequest: false }), policy: { monthSpent: null } }),
};
// Catálogo §F + §B/C/D/E: un cuerpo de error por código.
const E_ = [
  [403, 'account_not_authorized', 'Tu cuenta no tiene acceso a Cursia.'],
  [403, 'account_suspended', 'Tu cuenta está suspendida.'],
  [500, 'access_context_missing', 'Error interno de permisos.'],
  [403, 'not_a_member', 'No perteneces a esta institución.'],
  [400, 'institution_required', 'Elige una institución.'],
  [409, 'institution_mismatch', 'Este curso pertenece a otra institución.'],
  [403, 'institution_inactive', 'La institución está suspendida o archivada.'],
  [403, 'institution_create_forbidden', 'Solo el SuperAdmin crea instituciones.'],
  [403, 'permission_denied', 'No tienes permiso para esta acción.', { permission: 'proposals.approve' }],
  [400, 'permission_not_grantable', 'Ese permiso no se puede otorgar desde una institución.'],
  [403, 'self_modification_forbidden', 'No puedes cambiar tus propios permisos.'],
  [403, 'role_escalation_forbidden', 'No puedes otorgar permisos que no tienes.'],
  [409, 'last_admin_protected', 'La institución debe conservar al menos un administrador.'],
  [400, 'superadmin_role_reserved', 'El rol SuperAdmin no se asigna desde aquí.'],
  [404, 'user_not_found', 'No existe un usuario con ese correo.'],
  [409, 'membership_exists', 'Ya es miembro.'],
  [409, 'user_exists', 'El usuario ya existe.'],
  [409, 'user_exists_unauthorized', 'El usuario ya existe pero no está autorizado.'],
  [502, 'user_create_partial', 'El usuario se creó a medias.', { userId: '0a000000-0000-4000-8000-0000000000a2' }],
  [503, 'admin_api_unavailable', 'La administración de usuarios no está configurada en el servidor.'],
  [400, 'invalid_email', 'Email inválido.'],
  [409, 'suspension_active', 'Ya hay una suspensión activa.'],
  [404, 'suspension_not_found', 'No hay una suspensión activa de ese tipo.'],
  [403, 'generation_suspended', 'Tus generaciones están suspendidas.'],
  [403, 'platform_generation_frozen', 'Las generaciones nuevas están pausadas temporalmente.'],
  [409, 'user_budget_insufficient', 'Presupuesto insuficiente.', { requiredUsd: '9.2000000000', availableUsd: '0.0000000000', payerUserId: U.creadorA, canRequest: true, estimateId: EST }],
  [409, 'user_budget_not_assigned', 'Todavía no tienes presupuesto asignado.', { canRequest: true }],
  [409, 'budget_request_duplicate', 'Ya tienes una solicitud pendiente para este curso.'],
  [409, 'budget_request_not_pending', 'La solicitud ya no está pendiente.'],
  [409, 'budget_request_expired', 'La solicitud venció.'],
  [400, 'invalid_amount', 'Monto inválido.'],
  [400, 'month_invalid', 'Mes inválido.'],
  [409, 'server_execution_required', 'Esta generación necesita ejecución en el servidor.'],
  [404, 'video_engine_not_found', 'No encontrado.'],
  // r75 (integración): códigos reales de A, B y C que faltaban en 02 §F (el FE los traduce por code).
  [404, 'institution_not_found', 'Institución no encontrada.'],
  [409, 'institution_slug_exists', 'Ya existe una institución con ese identificador.'],
  [409, 'institution_has_members', 'La institución tiene miembros o cursos; archívala en vez de borrarla.'],
  [400, 'invalid_role', 'Rol inválido.'],
  [400, 'invalid_status', 'Estado inválido.'],
  [400, 'invalid_input', 'Dato inválido.'],
  [502, 'admin_api_error', 'La administración de usuarios respondió con un error.'],
  [404, 'course_not_found', 'Curso no encontrado.'],
  [400, 'reason_required', 'Indica el motivo.'],
  [503, 'r75_schema_missing', 'La migración r75 de accesos no está aplicada en este entorno.'],
  [503, 'account_check_unavailable', 'No se pudo verificar el acceso de la cuenta. Intenta de nuevo.'],
  [404, 'resource_not_found', 'No encontrado.'],
  [404, 'job_not_found', 'Job no encontrado.'],
  [404, 'budget_request_not_found', 'Solicitud no encontrada.'],
  [404, 'estimate_not_found', 'Estimado no encontrado.'],
  [404, 'run_not_found', 'Ejecución no encontrada.'],
  [404, 'budgets_disabled', 'Los presupuestos por usuario no están activos.'],
];
files['errors.json'] = {
  '_nota': 'Cuerpo REAL de AllExceptionsFilter (src/common/filters/http-exception.filter.ts): {statusCode,timestamp,path,error,code,...}. Además de code/reason/criticals/pendingChanges/blockers/diff/modelSha256, el filtro reenvía (r75, solo primitivos) permission, userId, requiredUsd, availableUsd, payerUserId, canRequest y estimateId.',
  ...Object.fromEntries(E_.map(([s, c, m, x]) => [c, err(s, c, m, x || {})])),
};
// Índice para el modo mock de D: "MÉTODO ruta[#variante]" → archivo.
const index = {};
for (const [f, obj] of Object.entries(files)) for (const k of Object.keys(obj)) if (!k.startsWith('_') && f !== 'errors.json') index[k] = f;
files['index.json'] = {
  _nota: 'Ejemplos válidos por respuesta de 02-contratos-api.md (r75). Éxito: cuerpo {data,timestamp} de ResponseInterceptor (02 §Convenciones, corregido en la integración). Montos: strings decimales de 10 decimales. Variante tras «#». Errores en errors.json por code.',
  version: 1, generatedFrom: 'validation/r75-roles/02-contratos-api.md', routes: index,
};
for (const [f, obj] of Object.entries(files)) fs.writeFileSync(path.join(OUT, f), JSON.stringify(obj, null, 2) + '\n');
console.log('fixtures:', Object.keys(files).length, 'archivos,', Object.keys(index).length, 'rutas,', E_.length, 'errores');
