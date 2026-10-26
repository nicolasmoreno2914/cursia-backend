#!/usr/bin/env node
/* eslint-disable */
// Cursia r75 · A — backfill de instituciones y membresías (01 §1.8). Idempotente.
//   node scripts/migrate-r75-backfill.js                 → DRY-RUN (default): solo lectura (transacción read only).
//   MIGRATION_ENV=staging node scripts/migrate-r75-backfill.js --apply
//                                                         → aplica el plan en UNA transacción (re-planificado dentro).
// Siempre escribe un reporte JSON (sin emails en claro) en --report-dir=<dir> | R75_REPORT_DIR | ./validation/r75-roles,
// como backfill-<entorno>-<fecha>-<modo>.json, y por stdout imprime SOLO el resumen (conteos).
// Nunca cambia owner_id; nunca pisa un institution_id ya puesto (UPDATE … where institution_id is null). El ref de
// producción se rechaza siempre. Requiere la migración r75-access aplicada.
const fs = require('fs');
const path = require('path');
const G = require('./lib/r75-migration-guard');
const { planBackfill, reportOf } = require('./lib/r75-backfill-plan');

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}

async function snapshot(c) {
  const present = (await c.query(`select to_regclass('public.institution_memberships') is not null as ok`)).rows[0].ok;
  if (!present) throw new Error('la migración r75-access no está aplicada (falta public.institution_memberships)');
  const q = async (sql) => (await c.query(sql)).rows;
  const authReadable = (await c.query(`select to_regclass('auth.users') is not null as ok`)).rows[0].ok;
  let authUsers = null;
  if (authReadable) {
    try { authUsers = await q(`select id::text as id, email from auth.users`); } catch { authUsers = null; }
  }
  return {
    institutions: await q(`select id::text as id, owner_id, name, slug, kind, status, created_at from public.institutions`),
    memberships: await q(`select institution_id::text as institution_id, user_id::text as user_id, role, status from public.institution_memberships`),
    overrides: await q(`select institution_id::text as institution_id, user_id::text as user_id, permission from public.institution_permission_overrides`),
    courses: await q(`select id, owner_id, owner_email, institution_id::text as institution_id, created_by from public.courses`),
    jobOwners: (await q(`select distinct owner_id::text as o from public.production_jobs where owner_id is not null`)).map((r) => r.o),
    authorizedUsers: await q(`select email, user_id::text as user_id from public.authorized_users`),
    authUsers,
  };
}

async function apply(c, plan) {
  const n = { institutionsCreated: 0, markedPersonal: 0, membershipsCreated: 0, overridesCreated: 0, coursesAttached: 0, createdByFilled: 0, authorizedUsersLinked: 0 };
  for (const i of plan.createInstitutions) {
    const r = await c.query(
      `insert into public.institutions (id, owner_id, name, slug, kind, status, created_by)
       values ($1, $2, $3, $4, 'personal', 'active', 'r75-backfill') on conflict do nothing`, [i.id, i.ownerId, i.name.slice(0, 255), i.slug]);
    n.institutionsCreated += r.rowCount;
  }
  for (const id of plan.markPersonal) {
    n.markedPersonal += (await c.query(`update public.institutions set kind = 'personal' where id = $1 and kind <> 'personal'`, [id])).rowCount;
  }
  for (const m of plan.memberships) {
    n.membershipsCreated += (await c.query(
      `insert into public.institution_memberships (institution_id, user_id, role, status, created_by, updated_by)
       values ($1, $2, $3, 'active', $4, $4) on conflict (institution_id, user_id) do nothing`, [m.institutionId, m.userId, m.role, SYSTEM_ACTOR_ID])).rowCount;
  }
  for (const o of plan.overrides) {
    n.overridesCreated += (await c.query(
      `insert into public.institution_permission_overrides (institution_id, user_id, permission, effect, reason, created_by)
       values ($1, $2, $3, 'grant', $4, $5) on conflict (institution_id, user_id, permission) do nothing`,
      [o.institutionId, o.userId, o.permission, o.reason, SYSTEM_ACTOR_ID])).rowCount;
  }
  for (const a of plan.attachCourses) {
    // Nunca reasigna: solo cursos SIN institución y con el MISMO dueño que se planificó.
    n.coursesAttached += (await c.query(
      `update public.courses set institution_id = $2 where id = $1 and institution_id is null and lower(owner_id::text) = $3::text`,
      [a.courseId, a.institutionId, a.ownerId])).rowCount;
  }
  for (const f of plan.createdByFill) {
    n.createdByFilled += (await c.query(
      `update public.courses set created_by = $2 where id = $1 and created_by is null and lower(owner_id::text) = $2::text`, [f.courseId, f.createdBy])).rowCount;
  }
  for (const l of plan.linkAuthorizedUsers) {
    n.authorizedUsersLinked += (await c.query(
      `update public.authorized_users set user_id = $2 where lower(email) = lower($1) and user_id is null
         and not exists (select 1 from public.authorized_users o where o.user_id = $2)`, [l.email, l.userId])).rowCount;
  }
  await c.query(
    `insert into public.admin_audit_log (actor_id, actor_email, actor_is_superadmin, action, target_type, target_id, after)
     values ($1, null, false, 'backfill.apply', 'platform', 'r75-backfill', $2::jsonb)`, [SYSTEM_ACTOR_ID, JSON.stringify({ planned: plan.summary, applied: n })]);
  return n;
}

async function main() {
  G.loadEnvFile(path.resolve(process.cwd(), '.env'));
  const doApply = arg('--apply') === true;
  if (doApply) G.assertExplicitStagingIntent('migrate-r75-backfill.js --apply');
  G.assertNotProductionProject();
  const env = process.env.MIGRATION_ENV || 'unknown';
  const reportDir = path.resolve(String(arg('--report-dir') || process.env.R75_REPORT_DIR || path.join(process.cwd(), 'validation/r75-roles')));
  const c = G.pgClient();
  await c.connect();
  let plan;
  let applied = null;
  try {
    if (doApply) {
      await c.query('begin');
      await c.query(`set local lock_timeout = '5s'`);
      // Serializa contra otro backfill concurrente (mismo lock por nombre).
      await c.query(`select pg_advisory_xact_lock(hashtext('r75-backfill'))`);
      plan = planBackfill(await snapshot(c));
      applied = await apply(c, plan);
      if (plan.summary.reassignments !== 0) throw new Error('el plan reasignaría cursos: abortado');
      await c.query('commit');
    } else {
      await c.query('begin read only');
      plan = planBackfill(await snapshot(c));
      await c.query('rollback');
    }
  } catch (err) {
    try { await c.query('rollback'); } catch { /* cerrada */ }
    console.error('❌ Backfill r75 falló' + (doApply ? ' (rollback aplicado)' : '') + ':', err.message);
    process.exitCode = 1;
    await c.end();
    return;
  }
  await c.end();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const report = { kind: 'r75-backfill', mode: doApply ? 'apply' : 'dry-run', env, generatedAt: new Date().toISOString(), summary: plan.summary, applied, plan: reportOf(plan) };
  fs.mkdirSync(reportDir, { recursive: true });
  const file = path.join(reportDir, `backfill-${env}-${stamp}-${doApply ? 'apply' : 'dry-run'}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o644 });
  console.log(`✅ Backfill r75 ${doApply ? 'APLICADO' : 'DRY-RUN (sin escrituras)'} — reporte: ${file}`);
  console.log(JSON.stringify({ summary: plan.summary, applied }));
}

main().catch((err) => { console.error('❌ Error inesperado:', err.message); process.exitCode = 1; });
