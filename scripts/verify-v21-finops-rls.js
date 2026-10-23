#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

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

// V2.1 RF-b (fix C2) — verificación (solo lectura) de RLS en las tablas FinOps
// y course_profiles: relrowsecurity=true, sin privilegios de anon/authenticated,
// y la conexión del backend (DB_USER) no es uno de esos roles y puede leerlas.
//
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — esta migración es para el entorno de\n' +
      '   staging únicamente (spec: 2026-09-26-cursia-v21-experience-audit §W).\n' +
      '   deploy-staging.yml lo setea automáticamente; si la corrés a mano contra\n' +
      '   staging, usá: MIGRATION_ENV=staging node scripts/verify-v21-finops-rls.js'
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

const TABLES = ['pricing_catalog', 'generation_cost_events', 'cost_estimates', 'cost_budget_policies',
  'cost_budget_authorizations', 'cost_avoidance_events', 'course_profiles'];
const CLIENT_ROLES = ['anon', 'authenticated'];

async function verifyV21FinopsRls(client) {
  const failures = [];
  const [{ current_user: me }] = (await client.query('select current_user')).rows;
  if (CLIENT_ROLES.includes(me)) failures.push(`La conexión del backend usa el rol cliente "${me}".`);
  const roles = (await client.query(`select rolname from pg_roles where rolname = any($1::text[])`, [CLIENT_ROLES])).rows.map((r) => r.rolname);
  for (const t of TABLES) {
    const rel = (await client.query(
      `select c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = $1`, [t])).rows[0];
    if (!rel) {
      if (t === 'course_profiles') continue; // R3 opcional en esta base
      failures.push(`Falta la tabla public.${t}.`);
      continue;
    }
    if (!rel.relrowsecurity) failures.push(`public.${t} sin ROW LEVEL SECURITY.`);
    for (const r of roles) {
      const priv = (await client.query(
        `select has_table_privilege($1, $2, 'SELECT') s, has_table_privilege($1, $2, 'INSERT') i,
                has_table_privilege($1, $2, 'UPDATE') u, has_table_privilege($1, $2, 'DELETE') d`, [r, 'public.' + t])).rows[0];
      if (priv.s || priv.i || priv.u || priv.d) failures.push(`El rol ${r} conserva privilegios sobre public.${t}.`);
    }
    try {
      await client.query(`select 1 from public.${t} limit 1`);
    } catch (e) {
      failures.push(`El backend (${me}) no puede leer public.${t}: ${e.message}`);
    }
  }
  return { failures, currentUser: me, clientRoles: roles };
}

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
    ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    const r = await verifyV21FinopsRls(client);
    if (r.failures.length) {
      for (const f of r.failures) console.error('❌ ' + f);
      process.exitCode = 1;
    } else {
      console.log(`✅ RLS V2.1 FinOps verificado (backend=${r.currentUser}; roles cliente presentes: ${r.clientRoles.join(', ') || 'ninguno'}).`);
    }
  } finally {
    await client.end();
  }
}

module.exports = { verifyV21FinopsRls, TABLES };

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error inesperado:', err.message);
    process.exitCode = 1;
  });
}
