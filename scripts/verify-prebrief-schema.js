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

// Cursia — Prebrief pedagógico: VERIFICA, después de migrate-prebrief.js, las tablas course_prebrief_* (RLS, contenido
// inmutable, transiciones válidas, historial y PDF de solo inserción): lectura del catálogo + sonda en una transacción
// SIEMPRE revertida. SOLO staging (deploy-staging.yml).
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
      '   staging, usa: MIGRATION_ENV=staging node scripts/verify-prebrief-schema.js'
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
    const problems = await verifyPrebriefSchema(client);
    if (problems.length) {
      console.error('❌ Prebrief pedagógico (esquema): ' + problems.join('; '));
      process.exitCode = 1;
    } else {
      console.log('✅ course_prebrief_versions/events/pdfs con RLS, contenido inmutable, transiciones válidas e historial de solo inserción.');
    }
  } catch (err) {
    console.error('❌ Verificación falló:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

/**
 * Tablas, RLS y triggers; sonda en una transacción que SIEMPRE se revierte: una versión no cambia su modelo, no salta a
 * un estado inválido, no queda «aprobada» sin aprobación y el historial no se edita.
 */
async function verifyPrebriefSchema(client) {
  const problems = [];
  for (const t of ['course_prebrief_versions', 'course_prebrief_events', 'course_prebrief_pdfs']) {
    const { rows } = await client.query(`select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = $1`, [t]);
    if (!rows.length) { problems.push(`${t} no existe (correr scripts/migrate-prebrief.js)`); continue; }
    if (!rows[0].relrowsecurity) problems.push(`${t} sin RLS`);
  }
  if (problems.length) return problems;
  await client.query('begin');
  try {
    const c = await client.query(`insert into public.courses (title, structure_version) values ($1, 'dynamic') returning id`, ['[verify-prebrief] curso temporal (se revierte)']);
    const cid = c.rows[0].id;
    const v = await client.query(
      `insert into public.course_prebrief_versions (course_id, version, status, model_version, model_json, model_sha256, document_json, document_sha256,
         blueprint_id, blueprint_number, blueprint_sha256, prepared_by)
       values ($1, 1, 'ready', 1, '{}'::jsonb, $2, '{}'::jsonb, $2, 1, 1, $2, 'verify') returning id`, [cid, '0'.repeat(64)]);
    const vid = v.rows[0].id;
    const expectFail = async (label, sql, params, re) => {
      await client.query('savepoint sp');
      try {
        await client.query(sql, params);
        problems.push(`${label}: se permitió`);
      } catch (err) {
        if (!re.test(err.message)) problems.push(`${label}: falló por otra razón (${err.message})`);
        await client.query('rollback to savepoint sp');
      }
    };
    await expectFail('cambiar el modelo de una versión', `update public.course_prebrief_versions set model_json = '{"x":1}'::jsonb where id = $1`, [vid], /PREBRIEF_VERSION_IMMUTABLE/);
    await expectFail('aprobar sin registro de aprobación', `update public.course_prebrief_versions set status = 'approved' where id = $1`, [vid], /PREBRIEF_APPROVAL_REQUIRED/);
    await client.query(`update public.course_prebrief_versions set status = 'invalidated', invalidation_reason = 'withdrawn' where id = $1`, [vid]);
    await expectFail('volver de invalidada a lista', `update public.course_prebrief_versions set status = 'ready' where id = $1`, [vid], /PREBRIEF_INVALID_TRANSITION/);
    const e = await client.query(`insert into public.course_prebrief_events (course_id, version_id, type) values ($1, $2, 'verify') returning id`, [cid, vid]);
    await expectFail('editar el historial', `update public.course_prebrief_events set type = 'x' where id = $1`, [e.rows[0].id], /PREBRIEF_APPEND_ONLY/);
    await expectFail('borrar el historial', `delete from public.course_prebrief_events where id = $1`, [e.rows[0].id], /PREBRIEF_APPEND_ONLY/);
    // Borrar el curso sí borra su historial (cascada).
    await client.query('savepoint sp_del');
    try {
      await client.query(`delete from public.courses where id = $1`, [cid]);
      const left = await client.query(`select count(*)::int n from public.course_prebrief_events where course_id = $1`, [cid]);
      if (left.rows[0].n !== 0) problems.push('borrar el curso no borró su historial');
    } catch (err) { problems.push(`borrar el curso falló: ${err.message}`); }
    await client.query('rollback to savepoint sp_del');
    await client.query(`insert into public.course_prebrief_pdfs (version_id, variant, sha256, pages, bytes) values ($1, 'ready', $2, 1, '\\x25504446'::bytea)`, [vid, '0'.repeat(64)]);
    await expectFail('sobrescribir un PDF', `update public.course_prebrief_pdfs set sha256 = $2 where version_id = $1`, [vid, '1'.repeat(64)], /PREBRIEF_APPEND_ONLY/);
  } finally {
    await client.query('rollback');
  }
  return problems;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error inesperado:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { verifyPrebriefSchema };
