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

// Cursia — Motor de carga horaria (Loop 4): VERIFICA, después de migrate-practice-chapters.js, que
// course_chapters.chapter_kind existe (text, not null, default 'content') con su CHECK
// ('content' | 'practice'): lectura del catálogo + sonda en una transacción SIEMPRE revertida.
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
      '   staging, usá: MIGRATION_ENV=staging node scripts/verify-practice-chapters-schema.js'
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
    const { rows: cols } = await client.query(
      `select data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'course_chapters' and column_name = 'chapter_kind'`,
    );
    const { rows: chk } = await client.query(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and t.relname = 'course_chapters' and c.conname = 'course_chapters_chapter_kind_check'`,
    );
    const problems = verifyChapterKindSchema(cols[0] || null, chk[0] ? chk[0].def : null);
    if (!problems.length) {
      // Sonda: 'practice' entra, 'taller' no — en una transacción que SIEMPRE se revierte.
      await client.query('begin');
      try {
        const c = await client.query(
          `insert into public.courses (title, structure_version) values ($1, 'dynamic') returning id`,
          ['[verify-practice-chapters] curso temporal (se revierte)'],
        );
        const m = await client.query(
          `insert into public.course_modules (course_id, position, title) values ($1, 0, 'M') returning id`,
          [c.rows[0].id],
        );
        const d = await client.query(
          `insert into public.course_chapters (course_id, module_id, position, title) values ($1, $2, 0, 'C') returning chapter_kind`,
          [c.rows[0].id, m.rows[0].id],
        );
        if (d.rows[0].chapter_kind !== 'content') problems.push(`default ${JSON.stringify(d.rows[0].chapter_kind)} (se esperaba 'content')`);
        await client.query(
          `insert into public.course_chapters (course_id, module_id, position, title, chapter_kind) values ($1, $2, 1, 'P', 'practice')`,
          [c.rows[0].id, m.rows[0].id],
        );
        await client.query('savepoint sp_kind');
        try {
          await client.query(
            `insert into public.course_chapters (course_id, module_id, position, title, chapter_kind) values ($1, $2, 2, 'X', 'taller')`,
            [c.rows[0].id, m.rows[0].id],
          );
          problems.push("chapter_kind 'taller' entró: falta el CHECK");
        } catch (err) {
          if (!/course_chapters_chapter_kind_check/.test(err.message)) problems.push(`chapter_kind 'taller' falló por otra razón: ${err.message}`);
          await client.query('rollback to savepoint sp_kind');
        }
      } finally {
        await client.query('rollback');
      }
    }
    if (problems.length) {
      console.error('❌ course_chapters.chapter_kind: ' + problems.join('; '));
      process.exitCode = 1;
    } else {
      console.log("✅ course_chapters.chapter_kind ('content' por defecto | 'practice') con su CHECK.");
    }
  } catch (err) {
    console.error('❌ Verificación falló:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

/** Puro (testeable): problemas de la columna y del CHECK (null = no existe). */
function verifyChapterKindSchema(col, checkDef) {
  if (!col) return ['la columna no existe (correr scripts/migrate-practice-chapters.js)'];
  const out = [];
  if (col.data_type !== 'text') out.push(`tipo ${col.data_type} (se esperaba text)`);
  if (col.is_nullable !== 'NO') out.push('admite NULL');
  if (!/'content'/.test(String(col.column_default || ''))) out.push(`default ${col.column_default} (se esperaba 'content')`);
  if (!checkDef) out.push('falta course_chapters_chapter_kind_check');
  else for (const k of ['content', 'practice']) if (!checkDef.includes(`'${k}'`)) out.push(`el CHECK no admite '${k}' (${checkDef})`);
  return out;
}

module.exports = { verifyChapterKindSchema };

if (require.main === module) main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
