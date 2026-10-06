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

// Cursia — Fase 3 (Contexto académico): VERIFICA, después de migrate-academic-context.js, que
// course_profiles_kind_check admite 'academic' y que course_chapters.outcome_ids existe (jsonb, null) con su
// CHECK (array de 1 a 8 ids RA<n>/CO<n>): lectura del catálogo + sonda en una transacción SIEMPRE revertida.
// SOLO staging (deploy-staging.yml).
//
// Guardarraíl de intención explícita: esta migración es solo para staging.
// No se infiere nada de DB_HOST/DB_NAME — el operador tiene que
// declararlo. Mismo patrón que migrate-generation-manifests.js.
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — esta migración es para el entorno de\n' +
      '   staging únicamente (spec: docs/v21 cursia-v21-experience-audit §S).\n' +
      '   deploy-staging.yml lo setea automáticamente; si la corrés a mano contra\n' +
      '   staging, usá: MIGRATION_ENV=staging node scripts/verify-academic-context-schema.js'
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
    const def = async (table, name) => (await client.query(
      `select pg_get_constraintdef(c.oid) as d from pg_constraint c join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace where n.nspname = 'public' and t.relname = $1 and c.conname = $2`, [table, name],
    )).rows[0]?.d || null;
    const { rows: cols } = await client.query(
      `select data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'course_chapters' and column_name = 'outcome_ids'`,
    );
    const problems = verifyAcademicContextSchema(await def('course_profiles', 'course_profiles_kind_check'), cols[0] || null, await def('course_chapters', 'course_chapters_outcome_ids_check'));
    if (!problems.length) {
      // Sonda: null (por defecto) y ["RA1","CO2"] entran; [] / ["X1"] / 9 ids no — en una transacción que SIEMPRE se revierte.
      await client.query('begin');
      try {
        const c = await client.query(
          `insert into public.courses (title, structure_version) values ($1, 'dynamic') returning id`,
          ['[verify-academic-context] curso temporal (se revierte)'],
        );
        const m = await client.query(`insert into public.course_modules (course_id, position, title) values ($1, 0, 'M') returning id`, [c.rows[0].id]);
        const d = await client.query(
          `insert into public.course_chapters (course_id, module_id, position, title) values ($1, $2, 0, 'C') returning outcome_ids`,
          [c.rows[0].id, m.rows[0].id],
        );
        if (d.rows[0].outcome_ids !== null) problems.push(`default ${JSON.stringify(d.rows[0].outcome_ids)} (se esperaba null)`);
        await client.query(
          `insert into public.course_chapters (course_id, module_id, position, title, outcome_ids) values ($1, $2, 1, 'A', $3::jsonb)`,
          [c.rows[0].id, m.rows[0].id, JSON.stringify(['RA1', 'CO2'])],
        );
        let pos = 2;
        for (const bad of [[], ['X1'], ['RA1', 'RA2', 'RA3', 'RA4', 'RA5', 'RA6', 'RA7', 'RA8', 'RA9'], { RA1: true }]) {
          await client.query('savepoint sp_oid');
          try {
            await client.query(
              `insert into public.course_chapters (course_id, module_id, position, title, outcome_ids) values ($1, $2, $3, 'X', $4::jsonb)`,
              [c.rows[0].id, m.rows[0].id, pos++, JSON.stringify(bad)],
            );
            problems.push(`outcome_ids ${JSON.stringify(bad)} entró: falta el CHECK`);
          } catch (err) {
            if (!/course_chapters_outcome_ids_check/.test(err.message)) problems.push(`outcome_ids ${JSON.stringify(bad)} falló por otra razón: ${err.message}`);
            await client.query('rollback to savepoint sp_oid');
          }
        }
        // kind 'academic' admitido por el CHECK de course_profiles (la fila se revierte con la transacción).
        await client.query('savepoint sp_kind');
        try {
          await client.query(
            `insert into public.course_profiles (course_id, kind, version, data, sha256) values ($1, 'academic', 1, '{}'::jsonb, $2)`,
            [c.rows[0].id, '0'.repeat(64)],
          );
        } catch (err) {
          problems.push(/course_profiles_kind_check/.test(err.message) ? "course_profiles no admite kind 'academic'" : `la sonda de course_profiles falló: ${err.message}`);
          await client.query('rollback to savepoint sp_kind');
        }
      } finally {
        await client.query('rollback');
      }
    }
    if (problems.length) {
      console.error('❌ Contexto académico (esquema): ' + problems.join('; '));
      process.exitCode = 1;
    } else {
      console.log("✅ course_profiles.kind admite 'academic'; course_chapters.outcome_ids (jsonb null | 1–8 ids RA/CO) con su CHECK.");
    }
  } catch (err) {
    console.error('❌ Verificación falló:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

/** Puro (testeable): problemas del CHECK de kind, de la columna y de su CHECK (null = no existe). */
function verifyAcademicContextSchema(kindDef, col, checkDef) {
  const out = [];
  if (!kindDef) out.push('falta course_profiles_kind_check');
  else if (!kindDef.includes("'academic'")) out.push("course_profiles_kind_check no admite 'academic' (correr scripts/migrate-academic-context.js)");
  if (!col) return out.concat(['course_chapters.outcome_ids no existe (correr scripts/migrate-academic-context.js)']);
  if (col.data_type !== 'jsonb') out.push(`outcome_ids es ${col.data_type} (se esperaba jsonb)`);
  if (col.is_nullable !== 'YES') out.push('outcome_ids no admite NULL (null = sin vínculos)');
  if (col.column_default !== null && col.column_default !== undefined) out.push(`default ${col.column_default} (se esperaba ninguno)`);
  if (!checkDef) out.push('falta course_chapters_outcome_ids_check');
  else if (!/jsonb_array_length/.test(checkDef) || !/RA\|CO/.test(checkDef)) out.push(`el CHECK de outcome_ids no valida longitud y formato (${checkDef})`);
  return out;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error inesperado:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { verifyAcademicContextSchema };
