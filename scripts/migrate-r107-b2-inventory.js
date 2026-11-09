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

// Cursia — r107 B2 «Taller de cursos»: (1) workshop_sessions.inventory (columna nullable en la tabla NUEVA de r107, en
// una transacción) y (2) pendiente N3 de B1: índices parciales de la huella sobre artifacts, con CREATE INDEX
// CONCURRENTLY (no bloquea escrituras; cada sentencia SUELTA, fuera de transacción; un índice inválido de un intento
// cortado se descarta y se rehace). Ninguna tabla existente cambia de forma. Aditiva, idempotente y SOLO staging: la
// cablea deploy-staging.yml (nunca deploy.yml). Producción: r107 staging-only hasta aprobación del owner (EXCLUDED en
// scripts/prod/migrate-v2-production.js). Requiere la de B1 (migrate-r107-workshop-sessions.js) antes.
//
// Guardarraíl de intención explícita: esta migración es solo para staging.
// No se infiere nada de DB_HOST/DB_NAME — el operador tiene que
// declararlo. Mismo patrón que migrate-generation-manifests.js.
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — esta migración es para el entorno de\n' +
      '   staging únicamente (spec: docs/v21 cursia-v21-experience-audit §S).\n' +
      '   deploy-staging.yml lo setea automáticamente; si la ejecutas a mano contra\n' +
      '   staging, usa: MIGRATION_ENV=staging node scripts/migrate-r107-b2-inventory.js'
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

const INDEX_SQL = 'supabase-migration-r107-artifacts-checksum-index.sql';

/** Sentencias del .sql de índices (una por `;` de fin de línea, sin comentarios). */
function indexStatements(sql) {
  return sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}

/** CREATE INDEX CONCURRENTLY idempotente: si el índice existe pero quedó inválido (intento cortado), se rehace. */
async function applyIndexes(client) {
  const sql = fs.readFileSync(path.resolve(__dirname, '..', INDEX_SQL), 'utf8');
  for (const stmt of indexStatements(sql)) {
    const name = (/create index concurrently if not exists (\w+)/i.exec(stmt) || [])[1];
    if (!name) throw new Error('sentencia de índice sin nombre: ' + stmt.slice(0, 80));
    const r = await client.query(
      `select i.indisvalid from pg_class c join pg_index i on i.indexrelid = c.oid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1`, [name]);
    if (r.rows.length && r.rows[0].indisvalid === false) {
      console.log(`⚠️  ${name} existía INVÁLIDO (intento cortado): se descarta y se rehace.`);
      await client.query(`drop index concurrently if exists public.${name}`);
    }
    await client.query(stmt);
  }
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
    ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true'
      ? { rejectUnauthorized: false }
      : false,
  });

  await client.connect();
  try {
    const sql = fs.readFileSync(path.resolve(__dirname, '../supabase-migration-r107-b2-inventory.sql'), 'utf8');
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
    console.log('✅ r107 B2: workshop_sessions.inventory aplicada (o ya estaba — es idempotente).');
    await applyIndexes(client);
    console.log('✅ r107 B2 (N3): índices de la huella en artifacts aplicados (o ya estaban — es idempotente).');
  } catch (err) {
    console.error('❌ Migración r107 B2 falló:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error inesperado:', err.message);
    process.exitCode = 1;
  });
}
module.exports = { indexStatements, applyIndexes };
