#!/usr/bin/env node
/* eslint-disable */
// Cursia r75 · A — verificación (SOLO LECTURA) del esquema de accesos después de migrate-r75-access.js.
// Falla (exit 1) si falta una tabla, columna, constraint, índice o trigger; si alguna tabla nueva no tiene RLS o
// conserva privilegios para anon/authenticated; o si authorized_users tiene alguna política distinta de
// «users check own authorization» (SELECT) o privilegios de escritura para clientes. Uso:
//   MIGRATION_ENV=staging node scripts/verify-r75-access-schema.js
const path = require('path');
const G = require('./lib/r75-migration-guard');

const NEW_TABLES = ['institution_memberships', 'institution_permission_overrides', 'user_suspensions', 'platform_controls', 'admin_audit_log'];
const COLUMNS = {
  institutions: ['kind', 'status', 'created_by'],
  courses: ['created_by', 'updated_by', 'approved_by', 'approved_at', 'generated_by', 'generated_at'],
  authorized_users: ['user_id', 'status'],
  institution_memberships: ['id', 'institution_id', 'user_id', 'role', 'status', 'created_by', 'created_at', 'updated_by', 'updated_at'],
  institution_permission_overrides: ['id', 'institution_id', 'user_id', 'permission', 'effect', 'reason', 'created_by', 'created_at', 'revoked_by', 'revoked_at'],
  user_suspensions: ['id', 'user_id', 'kind', 'reason', 'created_by', 'created_at', 'lifted_by', 'lifted_at', 'lift_reason'],
  platform_controls: ['key', 'enabled', 'reason', 'updated_by', 'updated_at'],
  admin_audit_log: ['id', 'at', 'actor_id', 'actor_email', 'actor_is_superadmin', 'action', 'target_type', 'target_id', 'institution_id', 'before', 'after', 'request_id', 'ip_hash'],
};
const CONSTRAINTS = ['institutions_kind_r75_check', 'institutions_status_r75_check', 'institution_memberships_role_check',
  'institution_memberships_status_check', 'institution_memberships_inst_user_key', 'institution_permission_overrides_effect_check',
  'institution_permission_overrides_permission_check', 'institution_permission_overrides_key', 'user_suspensions_kind_check',
  'platform_controls_key_check'];
const INDEXES = ['institution_memberships_user_active_idx', 'user_suspensions_one_active_idx', 'authorized_users_user_id_r75_key', 'admin_audit_log_at_idx'];
const TRIGGERS = [['admin_audit_log', 'admin_audit_log_append_only'], ['admin_audit_log', 'admin_audit_log_no_truncate'],
  ['institution_memberships', 'institution_memberships_no_delete'], ['institution_permission_overrides', 'institution_permission_overrides_no_delete'],
  ['user_suspensions', 'user_suspensions_guard'], ['user_suspensions', 'user_suspensions_no_truncate']];

async function main() {
  G.loadEnvFile(path.resolve(process.cwd(), '.env'));
  G.assertExplicitStagingIntent('verify-r75-access-schema.js');
  G.assertNotProductionProject();
  const c = G.pgClient();
  await c.connect();
  const problems = [];
  try {
    await c.query('begin read only');
    for (const [t, cols] of Object.entries(COLUMNS)) {
      const { rows } = await c.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [t]);
      const have = new Set(rows.map((r) => r.column_name));
      if (!have.size) { problems.push(`falta la tabla public.${t}`); continue; }
      for (const col of cols) if (!have.has(col)) problems.push(`falta la columna public.${t}.${col}`);
    }
    for (const name of CONSTRAINTS) {
      const { rows } = await c.query(`select 1 from pg_constraint where conname = $1`, [name]);
      if (!rows.length) problems.push(`falta el constraint ${name}`);
    }
    for (const name of INDEXES) {
      const { rows } = await c.query(`select 1 from pg_indexes where schemaname = 'public' and indexname = $1`, [name]);
      if (!rows.length) problems.push(`falta el índice ${name}`);
    }
    for (const [t, trg] of TRIGGERS) {
      const { rows } = await c.query(
        `select 1 from pg_trigger tg join pg_class cl on cl.oid = tg.tgrelid join pg_namespace n on n.oid = cl.relnamespace
          where n.nspname = 'public' and cl.relname = $1 and tg.tgname = $2 and not tg.tgisinternal and tg.tgenabled <> 'D'`, [t, trg]);
      if (!rows.length) problems.push(`falta (o está deshabilitado) el trigger ${trg} en ${t}`);
    }
    for (const t of [...NEW_TABLES, 'authorized_users']) {
      const { rows } = await c.query(`select relrowsecurity from pg_class where oid = to_regclass($1)`, ['public.' + t]);
      if (!rows[0] || rows[0].relrowsecurity !== true) problems.push(`RLS no activado en public.${t}`);
    }
    const roles = (await c.query(`select rolname from pg_roles where rolname in ('anon','authenticated')`)).rows.map((r) => r.rolname);
    for (const t of NEW_TABLES) {
      for (const r of roles) {
        const { rows } = await c.query(`select privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 and grantee = $2`, [t, r]);
        if (rows.length) problems.push(`${r} conserva privilegios en public.${t}: ${rows.map((x) => x.privilege_type).join(',')}`);
      }
    }
    for (const r of roles) {
      const { rows } = await c.query(`select privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'authorized_users' and grantee = $1`, [r]);
      const bad = rows.map((x) => x.privilege_type).filter((p) => r === 'anon' || p !== 'SELECT');
      if (bad.length) problems.push(`${r} conserva privilegios de escritura/lectura indebidos en authorized_users: ${bad.join(',')}`);
    }
    const pol = (await c.query(`select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'authorized_users'`)).rows;
    for (const p of pol) if (p.policyname !== 'users check own authorization' || p.cmd !== 'SELECT') problems.push(`política no permitida en authorized_users: ${p.policyname} (${p.cmd})`);
    for (const t of NEW_TABLES) {
      const { rows } = await c.query(`select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = $1`, [t]);
      if (rows[0].n > 0) problems.push(`public.${t} tiene políticas RLS (debe no tener ninguna)`);
    }
    await c.query('rollback');
  } finally {
    await c.end();
  }
  if (problems.length) {
    console.error('❌ Esquema r75-access incompleto:\n - ' + problems.join('\n - '));
    process.exitCode = 1;
  } else {
    console.log('✅ Esquema r75-access verificado (tablas, columnas, constraints, índices, triggers, RLS, REVOKE, políticas de authorized_users).');
  }
}

main().catch((err) => { console.error('❌ Error inesperado:', err.message); process.exitCode = 1; });
