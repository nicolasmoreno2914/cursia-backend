/* eslint-disable */
// r75 · Agente E — validadores de forma de 02-contratos-api.md. Sin dependencias.
// Se usan contra los fixtures (contracts.test.js) y contra las respuestas reales (integración).
'use strict';

const ROLES = ['ADMIN_INSTITUCIONAL', 'CREADOR', 'APROBADOR_ACADEMICO', 'CONSULTA'];
const PERMISSIONS = ['courses.view', 'courses.create', 'courses.edit', 'courses.delete', 'proposals.review', 'proposals.approve',
  'generations.start', 'generations.retry', 'exports.download', 'spend.view', 'roles.manage', 'budgets.manage', 'users.suspend', 'generations.suspend'];
const GLOBAL_ONLY = ['budgets.manage', 'users.suspend', 'generations.suspend']; // D-7
// 01 §2.2 (vinculante)
const MATRIX = {
  ADMIN_INSTITUCIONAL: ['courses.view', 'courses.create', 'courses.edit', 'courses.delete', 'proposals.review', 'generations.retry', 'exports.download', 'spend.view', 'roles.manage'],
  CREADOR: ['courses.view', 'courses.create', 'courses.edit', 'proposals.review', 'generations.start', 'generations.retry', 'exports.download'],
  APROBADOR_ACADEMICO: ['courses.view', 'proposals.review', 'proposals.approve', 'exports.download'],
  CONSULTA: ['courses.view'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USD = /^-?\d+(\.\d{1,10})?$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function V(errs, p) {
  const f = (cond, m) => { if (!cond) errs.push(`${p}: ${m}`); return !!cond; };
  return {
    obj: (v) => f(v && typeof v === 'object' && !Array.isArray(v), 'debe ser objeto'),
    arr: (v) => f(Array.isArray(v), 'debe ser arreglo'),
    str: (v) => f(typeof v === 'string', `string esperado, vino ${JSON.stringify(v)}`),
    strN: (v) => f(v === null || typeof v === 'string', 'string|null'),
    bool: (v) => f(typeof v === 'boolean', `boolean esperado, vino ${JSON.stringify(v)}`),
    int: (v) => f(Number.isInteger(v), `entero esperado, vino ${JSON.stringify(v)}`),
    intN: (v) => f(v === null || Number.isInteger(v), 'entero|null'),
    uuid: (v) => f(typeof v === 'string' && UUID.test(v), `uuid esperado, vino ${JSON.stringify(v)}`),
    uuidN: (v) => f(v === null || (typeof v === 'string' && UUID.test(v)), `uuid|null, vino ${JSON.stringify(v)}`),
    usd: (v) => f(typeof v === 'string' && USD.test(v), `monto string decimal esperado (nunca number), vino ${JSON.stringify(v)}`),
    usdN: (v) => f(v === null || (typeof v === 'string' && USD.test(v)), 'monto|null'),
    month: (v) => f(typeof v === 'string' && MONTH.test(v), `mes YYYY-MM, vino ${JSON.stringify(v)}`),
    iso: (v) => f(typeof v === 'string' && ISO.test(v), `ISO-8601 UTC, vino ${JSON.stringify(v)}`),
    isoN: (v) => f(v === null || (typeof v === 'string' && ISO.test(v)), 'ISO|null'),
    oneOf: (v, xs) => f(xs.includes(v), `uno de ${xs.join('|')}, vino ${JSON.stringify(v)}`),
    perms: (v) => f(Array.isArray(v) && v.every((x) => PERMISSIONS.includes(x)), `permisos del catálogo, vino ${JSON.stringify(v)}`),
  };
}
const at = (errs, p, fn) => fn(V(errs, p));

const S = {};
S.UserBudgetSummary = (b, e, p = 'budget') => at(e, p, (v) => {
  if (!v.obj(b)) return;
  v.month(b.month); v.usd(b.limitUsd); v.usd(b.spentUsd); v.usd(b.heldUsd); v.usd(b.availableUsd); v.int(b.pendingRequests);
  // available = limit − spent − held (01 §5.1)
  const n = (x) => Number(x);
  if ([b.limitUsd, b.spentUsd, b.heldUsd, b.availableUsd].every((x) => typeof x === 'string'))
    if (Math.abs(n(b.limitUsd) - n(b.spentUsd) - n(b.heldUsd) - n(b.availableUsd)) > 1e-9) e.push(`${p}: available ≠ limit − spent − held`);
});
S.Membership = (m, e, p) => at(e, p, (v) => {
  if (!v.obj(m)) return;
  v.uuid(m.institutionId); v.str(m.name); v.oneOf(m.kind, ['organization', 'personal']); v.oneOf(m.role, ROLES);
  v.oneOf(m.status, ['active', 'suspended']); v.perms(m.permissions);
  if (Array.isArray(m.permissions) && m.permissions.some((x) => GLOBAL_ONLY.includes(x))) e.push(`${p}: permiso global (D-7) en una membresía`);
});
S.MeContext = (c, e, p = 'MeContext') => at(e, p, (v) => {
  if (!v.obj(c)) return;
  if (v.obj(c.user)) { V(e, p + '.user').uuid(c.user.id); V(e, p + '.user').str(c.user.email); }
  v.bool(c.superAdmin);
  if (v.obj(c.account)) { const w = V(e, p + '.account'); w.bool(c.account.authorized); w.oneOf(c.account.status, ['active', 'suspended', 'not_authorized']); w.bool(c.account.mustChangePassword); }
  if (v.obj(c.generation)) { const w = V(e, p + '.generation'); w.bool(c.generation.suspended); w.bool(c.generation.platformFrozen); }
  v.oneOf(c.rbacMode, ['off', 'shadow', 'enforce']); v.oneOf(c.budgetsMode, ['off', 'shadow', 'enforce']);
  if (v.arr(c.memberships)) c.memberships.forEach((m, i) => S.Membership(m, e, `${p}.memberships[${i}]`));
  v.uuidN(c.defaultInstitutionId);
  if (c.budgetsMode === 'off' && c.budget !== null) e.push(`${p}: budget debe ser null con budgetsMode=off`);
  if (c.budget !== null) S.UserBudgetSummary(c.budget, e, p + '.budget');
});
S.PermissionCatalog = (c, e, p = 'catalog') => at(e, p, (v) => {
  if (!v.obj(c)) return;
  if (v.arr(c.roles)) v.oneOf(JSON.stringify([...c.roles].sort()), [JSON.stringify([...ROLES].sort())]);
  if (v.arr(c.permissions)) c.permissions.forEach((x, i) => { const w = V(e, `${p}.permissions[${i}]`); w.oneOf(x.key, PERMISSIONS); w.str(x.label); w.bool(x.sensitive); w.bool(x.grantable); if (GLOBAL_ONLY.includes(x.key) && x.grantable !== false) e.push(`${p}: ${x.key} no es otorgable (D-7)`); });
  if (v.obj(c.matrix)) for (const r of ROLES) if (JSON.stringify([...(c.matrix[r] || [])].sort()) !== JSON.stringify([...MATRIX[r]].sort())) e.push(`${p}.matrix.${r}: difiere de 01 §2.2`);
});
S.Institution = (i, e, p = 'Institution') => at(e, p, (v) => {
  if (!v.obj(i)) return;
  v.uuid(i.id); v.str(i.name); v.str(i.slug); v.oneOf(i.kind, ['organization', 'personal']); v.oneOf(i.status, ['active', 'suspended', 'archived']); v.iso(i.createdAt);
  if (i.memberCount !== undefined) v.int(i.memberCount);
});
S.Member = (m, e, p = 'Member') => at(e, p, (v) => {
  if (!v.obj(m)) return;
  v.uuid(m.userId); v.str(m.email); v.strN(m.fullName); v.oneOf(m.role, ROLES); v.oneOf(m.status, ['active', 'suspended', 'removed']);
  if (v.obj(m.overrides)) { V(e, p + '.overrides.grants').perms(m.overrides.grants); V(e, p + '.overrides.denies').perms(m.overrides.denies); }
  v.perms(m.effectivePermissions); v.oneOf(m.accountStatus, ['active', 'suspended']); v.iso(m.createdAt);
  // efectivos = rol + grants − denies (deny gana)
  if (m.overrides && Array.isArray(m.effectivePermissions) && ROLES.includes(m.role)) {
    const exp = new Set([...MATRIX[m.role], ...(m.overrides.grants || []).filter((x) => !GLOBAL_ONLY.includes(x))]);
    for (const d of m.overrides.denies || []) exp.delete(d);
    if (JSON.stringify([...exp].sort()) !== JSON.stringify([...m.effectivePermissions].sort())) e.push(`${p}: effectivePermissions ≠ rol + grants − denies`);
  }
});
S.AdminUser = (u, e, p = 'AdminUser') => at(e, p, (v) => {
  if (!v.obj(u)) return;
  v.uuid(u.id); v.str(u.email); v.strN(u.fullName); v.bool(u.authorized); v.oneOf(u.accountStatus, ['active', 'suspended']);
  v.bool(u.generationSuspended); v.bool(u.superAdmin); v.isoN(u.lastSignInAt); v.iso(u.createdAt);
  if (v.arr(u.memberships)) u.memberships.forEach((m, i) => { const w = V(e, `${p}.memberships[${i}]`); w.uuid(m.institutionId); w.str(m.name); w.oneOf(m.role, ROLES); w.str(m.status); });
  S.UserBudgetSummary(u.budget, e, p + '.budget');
  if ('tempPassword' in u || 'password' in u) e.push(`${p}: no debe contener contraseñas`);
});
S.Suspension = (s, e, p = 'Suspension') => at(e, p, (v) => {
  if (!v.obj(s)) return;
  v.uuid(s.id); v.oneOf(s.kind, ['account', 'generation']); v.str(s.reason); v.uuid(s.createdBy); v.iso(s.createdAt); v.uuidN(s.liftedBy); v.isoN(s.liftedAt);
});
S.AdminUserDetail = (u, e, p = 'AdminUserDetail') => {
  S.AdminUser(u, e, p);
  at(e, p, (v) => {
    if (v.arr(u && u.suspensions)) u.suspensions.forEach((s, i) => S.Suspension(s, e, `${p}.suspensions[${i}]`));
    if (v.arr(u && u.recentRuns)) u.recentRuns.forEach((r, i) => { const w = V(e, `${p}.recentRuns[${i}]`); w.uuid(r.runId); w.int(r.courseId); w.str(r.status); w.iso(r.startedAt); });
  });
};
S.PlatformControls = (c, e, p = 'controls') => at(e, p, (v) => {
  if (!v.obj(c) || !v.obj(c.generationFreeze)) return;
  const g = c.generationFreeze; v.bool(g.enabled); v.strN(g.reason); v.isoN(g.updatedAt); v.uuidN(g.updatedBy);
});
const SECRET_KEYS = /pass(word)?|tempPassword|token|secret|service_?role|api_?key/i;
S.AuditEntry = (a, e, p = 'AuditEntry') => at(e, p, (v) => {
  if (!v.obj(a)) return;
  v.int(a.id); v.iso(a.at); v.uuid(a.actorId); v.strN(a.actorEmail); v.str(a.action); v.str(a.targetType); v.strN(a.targetId); v.uuidN(a.institutionId);
  const walk = (o, q) => { if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) { if (SECRET_KEYS.test(k)) e.push(`${q}.${k}: clave sensible en auditoría`); walk(x, `${q}.${k}`); } };
  walk(a.before, p + '.before'); walk(a.after, p + '.after');
});
S.Reservation = (r, e, p = 'Reservation') => at(e, p, (v) => {
  if (!v.obj(r)) return;
  v.uuid(r.id); v.uuid(r.userId); v.uuidN(r.institutionId); v.int(r.courseId); v.uuid(r.runId); v.oneOf(r.kind, ['start', 'extension', 'upgrade', 'reopen']);
  v.usd(r.amountUsd); v.usd(r.liveHeldUsd); v.oneOf(r.status, ['active', 'released', 'settled']); v.month(r.periodMonth); v.iso(r.createdAt);
});
S.UserBudgetDetail = (b, e, p = 'UserBudgetDetail') => {
  S.UserBudgetSummary(b, e, p);
  at(e, p, (v) => {
    v.uuid(b && b.userId);
    if (v.arr(b && b.versions)) b.versions.forEach((x, i) => { const w = V(e, `${p}.versions[${i}]`); w.uuid(x.id); w.oneOf(x.kind, ['recurring', 'month_adjustment']); w.month(x.effectiveMonth); w.usd(x.amountUsd); w.int(x.version); w.str(x.reason); w.uuid(x.createdBy); w.iso(x.createdAt); w.uuidN(x.sourceRequestId); });
  });
};
S.BudgetRequest = (r, e, p = 'BudgetRequest') => at(e, p, (v) => {
  if (!v.obj(r)) return;
  v.uuid(r.id); v.uuid(r.userId); v.str(r.email); v.uuidN(r.institutionId); v.intN(r.courseId); v.strN(r.courseTitle); v.uuidN(r.runId); v.uuidN(r.estimateId);
  v.usd(r.amountUsd); v.str(r.reason); v.oneOf(r.status, ['pending', 'approved', 'rejected', 'cancelled', 'expired']); v.uuidN(r.decidedBy); v.isoN(r.decidedAt);
  v.strN(r.decisionNote); v.usdN(r.approvedAmountUsd); v.iso(r.createdAt); v.iso(r.expiresAt);
});
S.InstitutionSpend = (s, e, p = 'InstitutionSpend') => at(e, p, (v) => {
  if (!v.obj(s)) return;
  v.uuid(s.institutionId); v.iso(s.from); v.iso(s.to); v.usd(s.actualUsd); v.usd(s.reservedUsd); v.usd(s.committedUsd);
  if (s.byUser) s.byUser.forEach((x, i) => { const w = V(e, `${p}.byUser[${i}]`); w.uuid(x.userId); w.str(x.email); w.usd(x.actualUsd); w.usd(x.committedUsd); });
  if (s.byCourse) s.byCourse.forEach((x, i) => { const w = V(e, `${p}.byCourse[${i}]`); w.int(x.courseId); w.str(x.title); w.usd(x.actualUsd); w.usd(x.committedUsd); });
  if (s.byProvider) s.byProvider.forEach((x, i) => { const w = V(e, `${p}.byProvider[${i}]`); w.str(x.provider); w.usd(x.actualUsd); });
  if ('items' in s || 'byItem' in s) e.push(`${p}: no expone detalle por item (D-24)`);
});
S.AdminSpend = (s, e, p = 'AdminSpend') => at(e, p, (v) => {
  if (!v.obj(s)) return;
  if (v.arr(s.rows)) s.rows.forEach((x, i) => { const w = V(e, `${p}.rows[${i}]`); w.str(x.key); w.str(x.label); w.usd(x.actualUsd); w.usd(x.reservedUsd); w.usd(x.committedUsd); });
  v.usd(s.unattributedUsd);
});
S.Reconcile = (s, e, p = 'Reconcile') => at(e, p, (v) => {
  if (v.obj(s) && v.arr(s.users)) s.users.forEach((x, i) => { const w = V(e, `${p}.users[${i}]`); w.uuid(x.userId); w.usd(x.ledgerSpentUsd); w.usd(x.settledReservationsUsd); w.usd(x.driftUsd); });
});
S.UserBudgetGate = (u, e, p = 'userBudget') => at(e, p, (v) => {
  if (!v.obj(u)) return;
  v.oneOf(u.mode, ['off', 'shadow', 'enforce']); v.month(u.month); v.usd(u.availableUsd); v.usd(u.requiredUsd); v.bool(u.sufficient); v.bool(u.canRequest); v.uuid(u.payerUserId);
});
S.ErrorBody = (b, e, p = 'error', { status, code } = {}) => at(e, p, (v) => {
  if (!v.obj(b)) return;
  v.int(b.statusCode); v.str(b.code);
  if (status !== undefined && b.statusCode !== status) e.push(`${p}: statusCode ${b.statusCode} ≠ ${status}`);
  if (code !== undefined && b.code !== code) e.push(`${p}: code ${JSON.stringify(b.code)} ≠ ${code}`);
});

// Ruta (clave de index.json, sin variante) → validador de `data`.
const ROUTE_SHAPES = {
  'GET /me/context': S.MeContext,
  'GET /permissions/catalog': S.PermissionCatalog,
  'GET /institutions': (d, e) => V(e, 'Institution[]').arr(d) && d.forEach((x, i) => S.Institution(x, e, `Institution[${i}]`)),
  'GET /institutions?all=1': (d, e) => V(e, 'Institution[]').arr(d) && d.forEach((x, i) => S.Institution(x, e, `Institution[${i}]`)),
  'GET /institutions/:id': S.Institution,
  'POST /institutions': S.Institution,
  'POST /admin/institutions': S.Institution,
  'PATCH /admin/institutions/:id': S.Institution,
  'PATCH /admin/courses/:courseId/institution': (d, e) => at(e, 'move', (v) => { v.obj(d) && (v.int(d.courseId), v.uuid(d.institutionId)); }),
  'GET /institutions/:id/members': (d, e) => V(e, 'Member[]').arr(d) && d.forEach((x, i) => S.Member(x, e, `Member[${i}]`)),
  'POST /institutions/:id/members': S.Member,
  'PATCH /institutions/:id/members/:userId': S.Member,
  'DELETE /institutions/:id/members/:userId': (d, e) => at(e, 'remove', (v) => v.obj(d) && v.oneOf(d.status, ['removed'])),
  'PUT /institutions/:id/members/:userId/overrides': S.Member,
  'GET /admin/users': (d, e) => at(e, 'AdminUserList', (v) => { if (v.obj(d) && v.arr(d.items)) { d.items.forEach((x, i) => S.AdminUser(x, e, `items[${i}]`)); v.int(d.total); } }),
  'POST /admin/users': (d, e) => at(e, 'createUser', (v) => { if (!v.obj(d)) return; S.AdminUser(d.user, e, 'createUser.user'); v.bool(d.invited); if (d.tempPassword !== undefined) v.str(d.tempPassword); if (d.invited && d.tempPassword !== undefined) e.push('createUser: invite no devuelve tempPassword'); }),
  'GET /admin/users/:userId': S.AdminUserDetail,
  'POST /admin/users/:userId/authorize': S.AdminUser,
  'POST /admin/users/:userId/repair': S.AdminUser,
  'POST /admin/users/:userId/suspensions': S.Suspension,
  'DELETE /admin/users/:userId/suspensions/:kind': (d, e) => { S.Suspension(d, e); if (d && !d.liftedAt) e.push('lift: liftedAt requerido'); },
  'GET /admin/platform/controls': S.PlatformControls,
  'PUT /admin/platform/generation-freeze': S.PlatformControls,
  'GET /admin/audit-log': (d, e) => at(e, 'audit', (v) => { if (v.obj(d) && v.arr(d.items)) { d.items.forEach((x, i) => S.AuditEntry(x, e, `items[${i}]`)); v.strN(d.nextCursor); } }),
  'GET /me/budget': (d, e) => { S.UserBudgetSummary(d, e, 'meBudget'); at(e, 'meBudget', (v) => v.arr(d && d.reservations) && d.reservations.forEach((r, i) => S.Reservation(r, e, `reservations[${i}]`))); },
  'GET /admin/budgets': (d, e) => at(e, 'adminBudgets', (v) => { if (v.obj(d) && v.arr(d.items)) { d.items.forEach((x, i) => { S.UserBudgetSummary(x, e, `items[${i}]`); V(e, `items[${i}]`).uuid(x.userId); V(e, `items[${i}]`).str(x.email); }); v.int(d.total); } }),
  'GET /admin/users/:userId/budget': S.UserBudgetDetail,
  'PUT /admin/users/:userId/budget': S.UserBudgetDetail,
  'POST /admin/users/:userId/budget-adjustments': S.UserBudgetDetail,
  'GET /admin/budget-reservations': (d, e) => V(e, 'Reservation[]').arr(d) && d.forEach((x, i) => S.Reservation(x, e, `Reservation[${i}]`)),
  'POST /budget-requests': S.BudgetRequest,
  'GET /me/budget-requests': (d, e) => V(e, 'BudgetRequest[]').arr(d) && d.forEach((x, i) => S.BudgetRequest(x, e, `BudgetRequest[${i}]`)),
  'POST /budget-requests/:id/cancel': S.BudgetRequest,
  'GET /admin/budget-requests': (d, e) => V(e, 'BudgetRequest[]').arr(d) && d.forEach((x, i) => S.BudgetRequest(x, e, `BudgetRequest[${i}]`)),
  'POST /admin/budget-requests/:id/approve': S.BudgetRequest,
  'POST /admin/budget-requests/:id/reject': S.BudgetRequest,
  'GET /institutions/:id/spend?groupBy=user': S.InstitutionSpend,
  'GET /institutions/:id/spend?groupBy=course': S.InstitutionSpend,
  'GET /institutions/:id/spend?groupBy=provider': S.InstitutionSpend,
  'GET /admin/spend': S.AdminSpend,
  'POST /admin/budgets/reconcile': S.Reconcile,
  'POST …/runs/estimate-preview': (d, e) => { S.UserBudgetGate(d && d.userBudget, e); },
};

module.exports = { ROLES, PERMISSIONS, GLOBAL_ONLY, MATRIX, S, ROUTE_SHAPES, SECRET_KEYS };
