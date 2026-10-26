/* eslint-disable */
// r75 · A — guardarraíles comunes de los scripts r75 de accesos (migración, verificación, backfill).
// Mismo patrón que scripts/migrate-prebrief.js: intención explícita MIGRATION_ENV=staging + lista negra del ref de
// producción (Orbia) — se rechaza SIEMPRE, sin importar MIGRATION_ENV. Producción NUNCA recibe nada en r75.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const KNOWN_PRODUCTION_SUPABASE_REF = 'hriwbakbuypaiovvvkqh';
const KNOWN_STAGING_SUPABASE_REF_FRONTEND_ONLY = 'ljdtmkwuhkvtmlhugjrv';

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function extractSupabaseProjectRef(env = process.env) {
  const host = String(env.DB_HOST || '');
  const user = String(env.DB_USER || '');
  let m = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (m) return m[1].toLowerCase();
  m = user.match(/^postgres\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  return null;
}

/** Sale con código 1 si la conexión apunta a producción o no se puede identificar el proyecto. */
function assertNotProductionProject(env = process.env) {
  const ref = extractSupabaseProjectRef(env);
  const mentionsProd = [env.DB_HOST, env.DB_USER, env.SUPABASE_URL].some((v) => String(v || '').toLowerCase().includes(KNOWN_PRODUCTION_SUPABASE_REF));
  if (ref === KNOWN_PRODUCTION_SUPABASE_REF || mentionsProd) {
    console.error('❌ La conexión apunta al proyecto de Supabase de PRODUCCIÓN (ref ' + KNOWN_PRODUCTION_SUPABASE_REF + '). Abortando:\n' +
      '   r75 nunca corre contra producción, sin importar MIGRATION_ENV.');
    process.exit(1);
  }
  if (ref === null) {
    console.error('❌ No se pudo determinar el ref de proyecto de Supabase desde DB_HOST/DB_USER (ni "db.<ref>.supabase.co" ni\n' +
      '   pooler "postgres.<ref>"). Abortando por seguridad: no se puede confirmar que NO sea producción.');
    process.exit(1);
  }
  if (ref === KNOWN_STAGING_SUPABASE_REF_FRONTEND_ONLY) console.log('✅ Ref de proyecto (' + ref + ') = staging conocido.');
  else console.warn('⚠️  Ref de proyecto ' + ref + ': no es producción (pero tampoco el ref de staging conocido). Continuando.');
}

function assertExplicitStagingIntent(scriptName, env = process.env) {
  if (env.MIGRATION_ENV !== 'staging') {
    console.error('❌ MIGRATION_ENV no es "staging": ' + scriptName + ' es SOLO para staging (r75).\n' +
      '   deploy-staging.yml lo setea; a mano: MIGRATION_ENV=staging node scripts/' + scriptName);
    process.exit(1);
  }
}

function pgClient(env = process.env) {
  return new Client({
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 5432),
    user: env.DB_USER,
    password: env.DB_PASS,
    database: env.DB_NAME,
    ssl: String(env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });
}

module.exports = { KNOWN_PRODUCTION_SUPABASE_REF, loadEnvFile, extractSupabaseProjectRef, assertNotProductionProject, assertExplicitStagingIntent, pgClient };
