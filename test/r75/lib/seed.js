/* eslint-disable */
// r75 · Agente E — siembra en el PG descartable: identidades (auth.users + authorized_users), instituciones A/B,
// membresías, cursos, runs, artifacts. Las tablas r75 se usan SOLO si existen (si no, el ítem que las necesita queda
// PENDIENTE). Nada de esto toca staging ni producción.
'use strict';
const crypto = require('crypto');
const { q, tableExists, columnExists } = require('./env');

const MARK = `R75-SECRETO-${crypto.randomBytes(4).toString('hex')}`; // aparece en títulos de A: nunca debe verlo B

// Inserta completando columnas NOT NULL sin default con valores neutros según su tipo.
async function insertRow(table, values) {
  const cols = await q(`select column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns
                         where table_schema='public' and table_name=$1`, [table]);
  if (!cols.length) throw new Error(`tabla ${table} no existe`);
  const v = { ...values };
  for (const c of cols) {
    if (c.column_name in v || c.is_nullable === 'YES' || c.column_default !== null) continue;
    const t = c.udt_name;
    v[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|float/.test(t) ? 0 : t === 'bool' ? false : /json/.test(t) ? {} : /timestamp|date/.test(t) ? new Date() : 'r75';
  }
  const known = new Set(cols.map((c) => c.column_name));
  const keys = Object.keys(v).filter((k) => known.has(k));
  const params = keys.map((k) => (v[k] !== null && typeof v[k] === 'object' && !(v[k] instanceof Date) ? JSON.stringify(v[k]) : v[k]));
  const [row] = await q(`insert into public.${table} (${keys.map((k) => `"${k}"`).join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`, params);
  return row;
}

const U = (name, email, extra = {}) => ({ name, id: crypto.randomUUID(), email, ...extra });

async function seedIdentities() {
  const users = {
    sa: U('sa', 'qa-r75-superadmin@example.com'),
    adminA: U('adminA', 'qa-r75-admin-inst-a@example.com'),
    creadorA: U('creadorA', 'qa-r75-creador-a@example.com'),
    aprobadorA: U('aprobadorA', 'qa-r75-aprobador-a@example.com'),
    consultaA: U('consultaA', 'qa-r75-consulta-a@example.com'),
    adminB: U('adminB', 'qa-r75-admin-inst-b@example.com'),
    creadorB: U('creadorB', 'qa-r75-creador-b@example.com'),
    suspendido: U('suspendido', 'qa-r75-suspendido@example.com'),
    usd0: U('usd0', 'qa-r75-usd0@example.com'),
    noauth: U('noauth', 'qa-r75-sin-acceso@example.com', { unauthorized: true }),
  };
  for (const u of Object.values(users)) {
    await q(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), '{}')`, [u.id, u.email]);
    if (u.unauthorized) continue;
    const hasUid = await columnExists('authorized_users', 'user_id');
    if (hasUid) await q(`insert into public.authorized_users (email, is_admin, user_id) values ($1, false, $2)`, [u.email, u.id]);
    else await q(`insert into public.authorized_users (email, is_admin) values ($1, false)`, [u.email]);
  }
  return users;
}

async function seedInstitutions(users) {
  const r75 = await columnExists('institutions', 'kind');
  const mk = async (name, slug, owner) => insertRow('institutions', { owner_id: owner, name, slug, ...(r75 ? { kind: 'organization', status: 'active', created_by: owner } : {}) });
  const A = await mk(`QA r75 Institución A ${MARK}`, `qa-r75-a-${MARK.toLowerCase()}`, users.adminA.id);
  const B = await mk('QA r75 Institución B', `qa-r75-b-${crypto.randomBytes(3).toString('hex')}`, users.adminB.id);
  return { A, B };
}

async function seedMemberships(users, inst) {
  if (!(await tableExists('institution_memberships'))) return false;
  const m = async (i, u, role, status = 'active') => insertRow('institution_memberships', { institution_id: i.id, user_id: u.id, role, status, created_by: users.sa.id });
  await m(inst.A, users.adminA, 'ADMIN_INSTITUCIONAL');
  await m(inst.A, users.creadorA, 'CREADOR');
  await m(inst.A, users.aprobadorA, 'APROBADOR_ACADEMICO');
  await m(inst.A, users.consultaA, 'CONSULTA');
  await m(inst.A, users.suspendido, 'CREADOR');
  await m(inst.A, users.usd0, 'CREADOR');
  await m(inst.B, users.adminB, 'ADMIN_INSTITUCIONAL');
  await m(inst.B, users.creadorB, 'CREADOR');
  await m(inst.B, users.creadorA, 'CONSULTA'); // regla 2: multi-institución
  return true;
}

async function seedSuspension(users) {
  if (!(await tableExists('user_suspensions'))) return false;
  await insertRow('user_suspensions', { user_id: users.suspendido.id, kind: 'account', reason: 'QA r75 local', created_by: users.sa.id });
  return true;
}

async function seedCourse(owner, inst, title, extra = {}) {
  return insertRow('courses', { owner_id: owner.id, owner_email: owner.email, institution_id: inst ? inst.id : null, title, structure_version: 'dynamic', status: 'draft', metadata: { courseId: crypto.randomUUID() }, ...extra });
}
async function seedRun(course, owner, status = 'running', extra = {}) {
  const ct = (await q(`select udt_name from information_schema.columns where table_name='production_jobs' and column_name='course_id'`))[0].udt_name;
  return insertRow('production_jobs', {
    owner_id: owner.id, course_id: ct === 'text' ? String(course.id) : course.id, execution_mode: 'dynamic_generation', worker_status: status,
    status, input_payload: { r75: true }, ...extra,
  });
}
async function seedLegacyJob(owner) {
  return insertRow('production_jobs', { owner_id: owner.id, execution_mode: 'backend_content', worker_status: 'queued', status: 'queued', input_payload: { r75: true } });
}
async function seedArtifact(course, owner, extra = {}) {
  return insertRow('artifacts', { owner_id: owner.id, course_id: String(course.id), type: 'mbz_final', storage_path: `${owner.id}/r75/${crypto.randomUUID()}.mbz`, filename: `r75-${MARK}.mbz`, mime_type: 'application/zip', size_bytes: 10, ...extra });
}

/** Miembro DESCARTABLE (CONSULTA) de `inst`: para las rutas de la matriz que modifican o quitan a un miembro (no tocar consultaA). */
async function seedSacrificialMember(inst, createdBy) {
  const u = U('sacrificio', `qa-r75-sacrificio-${crypto.randomUUID().slice(0, 8)}@example.com`);
  await q(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), '{}')`, [u.id, u.email]);
  if (await columnExists('authorized_users', 'user_id')) await q(`insert into public.authorized_users (email, is_admin, user_id) values ($1, false, $2)`, [u.email, u.id]);
  else await q(`insert into public.authorized_users (email, is_admin) values ($1, false)`, [u.email]);
  await insertRow('institution_memberships', { institution_id: inst.id, user_id: u.id, role: 'CONSULTA', status: 'active', created_by: createdBy.id });
  return u;
}

module.exports = { MARK, insertRow, seedSacrificialMember, seedIdentities, seedInstitutions, seedMemberships, seedSuspension, seedCourse, seedRun, seedLegacyJob, seedArtifact };
