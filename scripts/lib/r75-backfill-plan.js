/* eslint-disable */
// r75 · A — planificador PURO del backfill de instituciones (01 §1.8). Sin base, sin red: recibe una foto de la base
// y devuelve qué haría. Lo usan scripts/migrate-r75-backfill.js (dry-run y --apply) y las pruebas.
//
// Reglas (D-4, D-5, D-6):
//   1. Usuarios = owner_id distintos de courses, production_jobs e institutions + cada fila de authorized_users.
//      - dueño de exactamente 1 institución → esa es su default; se marca kind='personal' solo si no tiene otros miembros;
//      - 0 → se crea «Espacio de <email>» (kind personal, slug personal-<8 hex del uid>);
//      - >1 → la más antigua es la default y el caso va a revisión manual.
//   2. El dueño queda ADMIN_INSTITUCIONAL en TODA institución de la que es owner_id (si no tiene ya una fila).
//   3. Overrides grant proposals.approve + generations.start en su institución default (si no hay fila para ese permiso).
//   4. Curso con institution_id: se respeta; se asegura la membresía del dueño ahí (CREADOR si no es su institución).
//   5. Curso sin institution_id con dueño: va a la default de su dueño. created_by = owner_id si es nulo.
//   6. Curso sin dueño: NO se adjunta (huérfano, solo SA).
//   7. NUNCA se reasigna: ni owner_id, ni un institution_id ya puesto. (reassignments siempre 0.)
const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const D5_GRANTS = ['proposals.approve', 'generations.start'];

function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  return (local.slice(0, 1) || '*') + '***@' + domain;
}

function ts(v) {
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * @param snap {{
 *   institutions: {id, owner_id, name, slug, kind, status, created_at}[],
 *   memberships: {institution_id, user_id, role, status}[],
 *   overrides: {institution_id, user_id, permission}[],
 *   courses: {id, owner_id, owner_email, institution_id, created_by}[],
 *   jobOwners: string[],
 *   authorizedUsers: {email, user_id}[],
 *   authUsers: {id, email}[] | null,
 * }}
 * @param opts {{ newId?: () => string }}
 */
function planBackfill(snap, opts = {}) {
  const newId = opts.newId || (() => crypto.randomUUID());
  const lc = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : null);
  const institutions = [...(snap.institutions || [])].sort((a, b) => ts(a.created_at) - ts(b.created_at) || String(a.id).localeCompare(String(b.id)));
  const memberships = snap.memberships || [];
  const overrides = snap.overrides || [];
  const courses = [...(snap.courses || [])].sort((a, b) => Number(a.id) - Number(b.id));
  const authUsers = snap.authUsers || null;

  const plan = {
    users: [], createInstitutions: [], markPersonal: [], memberships: [], overrides: [], attachCourses: [],
    createdByFill: [], linkAuthorizedUsers: [], orphanCourses: [], manualReview: [], invalidOwnerIds: [],
    unresolvedAuthorizedUsers: [], coursesKeptInstitution: 0, reassignments: 0,
  };

  // Emails conocidos por usuario (para el nombre del espacio personal).
  const emailOf = new Map();
  const authByEmail = new Map();
  if (authUsers) {
    const count = new Map();
    for (const u of authUsers) { const e = lc(u.email); if (e) count.set(e, (count.get(e) || 0) + 1); }
    for (const u of authUsers) {
      const e = lc(u.email);
      if (UUID_RE.test(String(u.id))) { emailOf.set(String(u.id).toLowerCase(), e); if (e && count.get(e) === 1) authByEmail.set(e, String(u.id).toLowerCase()); }
    }
  }
  for (const c of courses) if (c.owner_id && c.owner_email && !emailOf.get(String(c.owner_id).toLowerCase())) emailOf.set(String(c.owner_id).toLowerCase(), lc(c.owner_email));

  // 1. Universo de usuarios.
  const users = new Map(); // uid → Set(source)
  const addUser = (raw, source) => {
    if (raw === null || raw === undefined || raw === '') return;
    const s = String(raw).trim().toLowerCase();
    if (!UUID_RE.test(s)) { if (!plan.invalidOwnerIds.some((x) => x.value === s)) plan.invalidOwnerIds.push({ value: s.slice(0, 64), source }); return; }
    if (!users.has(s)) users.set(s, new Set());
    users.get(s).add(source);
  };
  for (const c of courses) addUser(c.owner_id, 'courses');
  for (const o of snap.jobOwners || []) addUser(o, 'production_jobs');
  for (const i of institutions) addUser(i.owner_id, 'institutions');
  const linkedIds = new Set((snap.authorizedUsers || []).filter((a) => a.user_id).map((a) => String(a.user_id).toLowerCase()));
  for (const a of snap.authorizedUsers || []) {
    if (a.user_id) { addUser(a.user_id, 'authorized_users'); if (!emailOf.get(String(a.user_id).toLowerCase())) emailOf.set(String(a.user_id).toLowerCase(), lc(a.email)); continue; }
    const uid = authByEmail.get(lc(a.email));
    if (uid && !linkedIds.has(uid)) {
      addUser(uid, 'authorized_users');
      plan.linkAuthorizedUsers.push({ email: a.email, emailMasked: maskEmail(a.email), userId: uid });
      linkedIds.add(uid);
    } else {
      plan.unresolvedAuthorizedUsers.push({ emailMasked: maskEmail(a.email), reason: uid ? 'user_id ya enlazado a otra fila' : 'sin usuario único en auth.users' });
    }
  }

  const membershipKey = (inst, uid) => `${inst}|${uid}`;
  const existingMembership = new Set(memberships.map((m) => membershipKey(String(m.institution_id), String(m.user_id).toLowerCase())));
  const plannedMembership = new Set();
  const existingOverride = new Set(overrides.map((o) => `${o.institution_id}|${String(o.user_id).toLowerCase()}|${o.permission}`));
  const usedSlugs = new Set(institutions.map((i) => i.slug));
  const ensureMembership = (instId, uid, role, reason) => {
    const k = membershipKey(instId, uid);
    if (existingMembership.has(k) || plannedMembership.has(k)) return;
    plannedMembership.add(k);
    plan.memberships.push({ institutionId: instId, userId: uid, role, reason });
  };

  const defaultOf = new Map();
  for (const [uid, sources] of [...users.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const owned = institutions.filter((i) => String(i.owner_id || '').toLowerCase() === uid);
    let def;
    let action;
    if (owned.length === 1) {
      def = owned[0].id;
      action = 'reuse';
      const others = memberships.some((m) => String(m.institution_id) === String(def) && String(m.user_id).toLowerCase() !== uid && m.status !== 'removed');
      if (!others && owned[0].kind !== 'personal') plan.markPersonal.push(def);
    } else if (owned.length === 0) {
      const id = newId();
      let slug = 'personal-' + uid.replace(/-/g, '').slice(0, 8);
      let n = 0;
      while (usedSlugs.has(slug)) slug = 'personal-' + uid.replace(/-/g, '').slice(0, 8) + '-' + (++n);
      usedSlugs.add(slug);
      const email = emailOf.get(uid) || null;
      plan.createInstitutions.push({ id, ownerId: uid, name: email ? `Espacio de ${email}` : `Espacio de usuario ${uid.slice(0, 8)}`, slug, kind: 'personal', emailMasked: maskEmail(email) });
      def = id;
      action = 'create';
    } else {
      def = owned[0].id; // la más antigua (orden por created_at)
      action = 'oldest_of_many';
      plan.manualReview.push({ userId: uid, reason: 'dueño de más de una institución', institutionIds: owned.map((i) => i.id), chosenDefault: def });
    }
    defaultOf.set(uid, def);
    plan.users.push({ userId: uid, emailMasked: maskEmail(emailOf.get(uid)), sources: [...sources].sort(), defaultInstitutionId: def, defaultAction: action, ownedInstitutions: owned.map((i) => i.id) });
    // 2. ADMIN en todas las propias (incluida la nueva).
    for (const i of owned) ensureMembership(String(i.id), uid, 'ADMIN_INSTITUCIONAL', 'owner');
    if (action === 'create') ensureMembership(def, uid, 'ADMIN_INSTITUCIONAL', 'personal_space');
    // 3. D-5.
    for (const p of D5_GRANTS) {
      if (!existingOverride.has(`${def}|${uid}|${p}`)) plan.overrides.push({ institutionId: def, userId: uid, permission: p, effect: 'grant', reason: 'r75 backfill D-5: conserva lo que el dueño ya podía hacer' });
    }
  }

  // 4–6. Cursos.
  const instById = new Map(institutions.map((i) => [String(i.id), i]));
  for (const c of courses) {
    const owner = c.owner_id ? String(c.owner_id).trim().toLowerCase() : null;
    if (!owner) { plan.orphanCourses.push(Number(c.id)); continue; }
    if (!UUID_RE.test(owner)) continue; // ya listado en invalidOwnerIds; no se adjunta
    if (!c.created_by) plan.createdByFill.push({ courseId: Number(c.id), createdBy: owner });
    if (c.institution_id) {
      plan.coursesKeptInstitution++;
      const inst = instById.get(String(c.institution_id));
      const ownsIt = inst && String(inst.owner_id || '').toLowerCase() === owner;
      ensureMembership(String(c.institution_id), owner, ownsIt ? 'ADMIN_INSTITUCIONAL' : 'CREADOR', ownsIt ? 'owner' : 'course_in_foreign_institution');
      if (!ownsIt) plan.manualReview.push({ userId: owner, reason: 'curso en una institución de la que no es dueño (se agrega como CREADOR)', courseId: Number(c.id), institutionId: String(c.institution_id) });
      continue;
    }
    const def = defaultOf.get(owner);
    if (def) plan.attachCourses.push({ courseId: Number(c.id), institutionId: def, ownerId: owner });
  }

  plan.summary = {
    users: plan.users.length,
    institutionsToCreate: plan.createInstitutions.length,
    institutionsMarkedPersonal: plan.markPersonal.length,
    membershipsToCreate: plan.memberships.length,
    overridesToCreate: plan.overrides.length,
    coursesToAttach: plan.attachCourses.length,
    coursesKeptInstitution: plan.coursesKeptInstitution,
    createdByToFill: plan.createdByFill.length,
    authorizedUsersToLink: plan.linkAuthorizedUsers.length,
    orphanCourses: plan.orphanCourses.length,
    manualReview: plan.manualReview.length,
    invalidOwnerIds: plan.invalidOwnerIds.length,
    unresolvedAuthorizedUsers: plan.unresolvedAuthorizedUsers.length,
    reassignments: 0,
  };
  return plan;
}

/** Versión del plan apta para el reporte (sin emails en claro). */
function reportOf(plan) {
  const { linkAuthorizedUsers, createInstitutions, ...rest } = plan;
  return {
    ...rest,
    linkAuthorizedUsers: linkAuthorizedUsers.map((l) => ({ emailMasked: l.emailMasked, userId: l.userId })),
    createInstitutions: createInstitutions.map((c) => ({ id: c.id, ownerId: c.ownerId, slug: c.slug, kind: c.kind, nameMasked: c.emailMasked ? `Espacio de ${c.emailMasked}` : c.name })),
  };
}

module.exports = { planBackfill, reportOf, maskEmail, UUID_RE, D5_GRANTS };
