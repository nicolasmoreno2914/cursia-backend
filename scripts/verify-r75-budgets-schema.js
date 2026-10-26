#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Cursia r75 (Agente C) — VERIFICA, después de migrate-r75-budgets.js, el esquema de presupuestos: tablas, RLS sin
// políticas, sin privilegios para anon/authenticated, triggers de inmutabilidad, índices únicos (una reserva 'start'
// por run, una solicitud pendiente por curso) y una sonda en una transacción SIEMPRE revertida. SOLO staging.
//
// (Contexto del esquema:) presupuestos mensuales por usuario, reservas por run y solicitudes de autorización
// (user_budgets / budget_reservations / budget_requests). Tablas NUEVAS con RLS y sin acceso para anon/authenticated;
// la única tabla existente que se toca es generation_cost_events, y solo con un índice parcial nuevo
// (institution_id). Aditiva, idempotente y SOLO staging: la cablea deploy-staging.yml (paso del lead) DESPUÉS de
// migrate-r75-access.js (A). Producción: NUNCA en r75 (EXCLUDED en scripts/prod/migrate-v2-production.js hasta que el
// owner apruebe). Mismos guardarraíles que migrate-prebrief.js: MIGRATION_ENV=staging explícito + lista negra del ref
// de producción (hriwbakbuypaiovvvkqh), aunque se fije MIGRATION_ENV.

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Guardarraíl de intención explícita: esta migración es solo para staging.
// No se infiere nada de DB_HOST/DB_NAME — el operador tiene que
// declararlo. Mismo patrón que migrate-generation-manifests.js.
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — esta migración es para el entorno de\n' +
      '   staging únicamente (r75: validation/r75-roles/03-plan-agentes.md §4).\n' +
      '   deploy-staging.yml lo setea automáticamente; si la ejecutas a mano contra\n' +
      '   staging, usa: MIGRATION_ENV=staging node scripts/verify-r75-budgets-schema.js'
    );
    process.exit(1);
  }
}

// Guardarraíl de identidad de proyecto — ver migrate-dynamic-course-structure.js
// para la explicación completa de por qué es lista negra (ref de producción
// conocido) y no lista blanca (ref de staging sin confirmar para el backend).
const KNOWN_PRODUCTION_SUPABASE_REF = 'hriwbakbuypaiovvvkqh';
const KNOWN_STAGING_SUPABASE_REF_FRONTEND_ONLY = 'ljdtmkwuhkvtmlhugjrv';

function extractSupabaseProjectRef() {
  const host = String(process.env.DB_HOST || '');
  const user = String(process.env.DB_USER || '');
  let m = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (m) return m[1].toLowerCase();
  m = user.match(/^postgres\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  return null;
}

function assertNotProductionProject() {
  const ref = extractSupabaseProjectRef();
  if (ref === KNOWN_PRODUCTION_SUPABASE_REF) {
    console.error(
      '❌ La conexión efectiva (DB_HOST/DB_USER) apunta al proyecto de Supabase\n' +
      '   de PRODUCCIÓN (ref conocido: ' + KNOWN_PRODUCTION_SUPABASE_REF + '). Abortando —\n' +
      '   esto nunca debe correr contra producción, sin importar MIGRATION_ENV.'
    );
    process.exit(1);
  }
  if (ref === null) {
    console.error(
      '❌ No se pudo determinar el ref de proyecto de Supabase desde DB_HOST/\n' +
      '   DB_USER (formato inesperado: ni "db.<ref>.supabase.co" ni pooler\n' +
      '   "postgres.<ref>"). Abortando por seguridad — no se puede confirmar\n' +
      '   que la conexión NO sea producción.'
    );
    process.exit(1);
  }
  if (ref === KNOWN_STAGING_SUPABASE_REF_FRONTEND_ONLY) {
    console.log('✅ Ref de proyecto (' + ref + ') coincide con el de staging conocido (frontend Auth/Storage).');
  } else {
    console.warn(
      '⚠️  El ref de proyecto detectado (' + ref + ') no coincide con el único ref de\n' +
      '   staging conocido en este repo (' + KNOWN_STAGING_SUPABASE_REF_FRONTEND_ONLY + ', confirmado\n' +
      '   solo para Auth/Storage del frontend, no para esta base). Continuando\n' +
      '   porque definitivamente NO es el proyecto de producción — pero esto no\n' +
      '   es una confirmación positiva de que sea staging.'
    );
  }
}


const TABLES = ['user_budgets', 'budget_reservations', 'budget_requests'];
const TRIGGERS = {
  user_budgets: ['user_budgets_append_only', 'user_budgets_no_truncate'],
  budget_reservations: ['budget_reservations_guard', 'budget_reservations_no_truncate'],
  budget_requests: ['budget_requests_guard', 'budget_requests_no_truncate'],
};
const UNIQUE_INDEXES = ['user_budgets_version_uq', 'budget_reservations_start_uq', 'budget_requests_one_pending_uq'];

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  assertExplicitStagingIntent();
  assertNotProductionProject();

  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true'
      ? { rejectUnauthorized: false }
      : false,
  });
  await client.connect();
  const problems = [];
  try {
    for (const t of TABLES) {
      const { rows } = await client.query(
        `select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = $1`, [t]);
      if (!rows.length) { problems.push(`falta la tabla public.${t}`); continue; }
      if (!rows[0].relrowsecurity) problems.push(`public.${t} sin RLS`);
      const pol = await client.query(`select policyname from pg_policies where schemaname = 'public' and tablename = $1`, [t]);
      if (pol.rows.length) problems.push(`public.${t} tiene políticas (${pol.rows.map((r) => r.policyname).join(', ')}): debe quedar sin ninguna`);
      for (const role of ['anon', 'authenticated']) {
        const r = await client.query(`select 1 from pg_roles where rolname = $1`, [role]);
        if (!r.rows.length) continue;
        const g = await client.query(
          `select privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 and grantee = $2`, [t, role]);
        if (g.rows.length) problems.push(`public.${t}: ${role} conserva privilegios (${g.rows.map((x) => x.privilege_type).join(', ')})`);
      }
      for (const tg of TRIGGERS[t]) {
        const r = await client.query(`select 1 from pg_trigger where tgname = $1 and tgrelid = ('public.' || $2)::regclass and not tgisinternal`, [tg, t]);
        if (!r.rows.length) problems.push(`public.${t}: falta el trigger ${tg}`);
      }
    }
    for (const ix of UNIQUE_INDEXES) {
      const r = await client.query(`select indisunique from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = $1`, [ix]);
      if (!r.rows.length || !r.rows[0].indisunique) problems.push(`falta el índice único ${ix}`);
    }

    if (!problems.length) {
      // Sonda: todo en UNA transacción que siempre se revierte (no deja filas).
      await client.query('begin');
      try {
        const expectFail = async (what, sql, params) => {
          await client.query('savepoint sp');
          try {
            await client.query(sql, params);
            problems.push(`la sonda «${what}» debía fallar y pasó`);
          } catch { /* esperado */ }
          await client.query('rollback to savepoint sp');
        };
        const uid = '00000000-0000-4000-8000-000000000c75';
        const run = '00000000-0000-4000-8000-000000000c76';
        const b = await client.query(
          `insert into public.user_budgets (user_id, kind, effective_month, amount_usd, version, reason, created_by)
           values ($1, 'recurring', date_trunc('month', now())::date, 1, 1, '[verify-r75-budgets] sonda (se revierte)', $1) returning id`, [uid]);
        await expectFail('user_budgets UPDATE', `update public.user_budgets set amount_usd = 2 where id = $1`, [b.rows[0].id]);
        await expectFail('user_budgets DELETE', `delete from public.user_budgets where id = $1`, [b.rows[0].id]);
        await expectFail('user_budgets versión duplicada',
          `insert into public.user_budgets (user_id, kind, effective_month, amount_usd, version, reason, created_by)
           values ($1, 'recurring', date_trunc('month', now())::date, 1, 1, 'dup', $1)`, [uid]);
        await expectFail('user_budgets recurring negativo',
          `insert into public.user_budgets (user_id, kind, effective_month, amount_usd, version, reason, created_by)
           values ($1, 'recurring', date_trunc('month', now())::date, -1, 2, 'neg', $1)`, [uid]);
        const r = await client.query(
          `insert into public.budget_reservations (user_id, course_id, run_id, kind, amount_usd, period_month)
           values ($1, 1, $2, 'start', 1, date_trunc('month', now())::date) returning id`, [uid, run]);
        await expectFail('dos reservas start del mismo run',
          `insert into public.budget_reservations (user_id, course_id, run_id, kind, amount_usd, period_month)
           values ($1, 1, $2, 'start', 1, date_trunc('month', now())::date)`, [uid, run]);
        await expectFail('budget_reservations cambia el monto', `update public.budget_reservations set amount_usd = 5 where id = $1`, [r.rows[0].id]);
        await expectFail('budget_reservations DELETE', `delete from public.budget_reservations where id = $1`, [r.rows[0].id]);
        await client.query(`update public.budget_reservations set status = 'released', released_at = now(), release_reason = 'verify' where id = $1`, [r.rows[0].id]);
        const q = await client.query(
          `insert into public.budget_requests (user_id, course_id, amount_usd, reason) values ($1, 1, 1, 'verify') returning id`, [uid]);
        await expectFail('dos solicitudes pendientes del mismo curso',
          `insert into public.budget_requests (user_id, course_id, amount_usd, reason) values ($1, 1, 1, 'verify')`, [uid]);
        await client.query(`update public.budget_requests set status = 'rejected', decided_by = $2, decided_at = now(), decision_note = 'verify' where id = $1`, [q.rows[0].id, uid]);
        await expectFail('decisión cerrada que cambia', `update public.budget_requests set status = 'approved' where id = $1`, [q.rows[0].id]);
        await expectFail('budget_requests DELETE', `delete from public.budget_requests where id = $1`, [q.rows[0].id]);
      } finally {
        await client.query('rollback');
      }
    }
    if (problems.length) {
      console.error('❌ Esquema r75 presupuestos inválido:\n - ' + problems.join('\n - '));
      process.exitCode = 1;
    } else {
      console.log('✅ Esquema r75 presupuestos verificado (RLS sin políticas, sin privilegios cliente, inmutabilidad, índices únicos, sonda revertida).');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
