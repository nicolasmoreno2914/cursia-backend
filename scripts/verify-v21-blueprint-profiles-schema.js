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

// Cursia V2.1 — R3: verificador del esquema de
// supabase-migration-v21-blueprint-profiles.sql. Mismos guardarraíles que la
// migración (se conecta a una base real; deploy-staging.yml lo corre justo
// después). La sonda de comportamiento escribe SOLO dentro de una transacción
// que siempre se revierte.
//
// Guardarraíl de intención explícita: esta migración es solo para staging.
// No se infiere nada de DB_HOST/DB_NAME — el operador tiene que
// declararlo. Mismo patrón que migrate-generation-manifests.js.
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — este verificador es para el entorno de\n' +
      '   staging únicamente (spec: docs/v21 cursia-v21-experience-audit §S).\n' +
      '   deploy-staging.yml lo setea automáticamente; si la corrés a mano contra\n' +
      '   staging, usá: MIGRATION_ENV=staging node scripts/verify-v21-blueprint-profiles-schema.js'
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

const EXPECTED_ADDED_COLUMNS = [
  { table: 'course_chapters', column: 'activity_enabled', type: 'boolean', nullable: 'NO', defaultRe: /^true$/ },
  { table: 'courses', column: 'final_exam_enabled', type: 'boolean', nullable: 'NO', defaultRe: /^true$/ },
  { table: 'courses', column: 'activity_engine', type: 'text', nullable: 'NO', defaultRe: /^'h5p'::text$/ },
];

const PROFILE_COLUMNS = ['id', 'course_id', 'kind', 'version', 'data', 'sha256', 'created_by', 'created_at'];

const EXPECTED_CONSTRAINTS = [
  { conname: 'courses_activity_engine_check', contype: 'c' },
  { conname: 'course_profiles_kind_check', contype: 'c' },
  { conname: 'course_profiles_version_check', contype: 'c' },
  { conname: 'course_profiles_course_kind_version_key', contype: 'u' },
];

const EXPECTED_TRIGGERS = ['course_profiles_immutable', 'course_profiles_no_direct_delete'];

async function expectError(client, sp, sql, params, re, label, failures) {
  await client.query(`savepoint ${sp}`);
  try {
    await client.query(sql, params);
    failures.push(`${label}: se esperaba un error y la sentencia pasó.`);
  } catch (err) {
    if (!re.test(err.message)) failures.push(`${label}: error inesperado "${err.message}".`);
  } finally {
    await client.query(`rollback to savepoint ${sp}`);
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
  const failures = [];
  try {
    // 1. Columnas nuevas (tipo, NOT NULL, default).
    for (const exp of EXPECTED_ADDED_COLUMNS) {
      const res = await client.query(
        `select data_type, is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = $1 and column_name = $2`,
        [exp.table, exp.column],
      );
      const col = res.rows[0];
      if (!col) { failures.push(`Falta la columna "${exp.table}.${exp.column}".`); continue; }
      if (col.data_type !== exp.type) failures.push(`"${exp.table}.${exp.column}" es ${col.data_type}, esperado ${exp.type}.`);
      if (col.is_nullable !== exp.nullable) failures.push(`"${exp.table}.${exp.column}" admite NULL.`);
      if (!exp.defaultRe.test(String(col.column_default))) failures.push(`"${exp.table}.${exp.column}" default=${col.column_default}.`);
    }

    // 2. Tabla course_profiles.
    const cols = await client.query(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'course_profiles'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    if (names.length === 0) failures.push('Tabla "course_profiles" no existe.');
    else for (const c of PROFILE_COLUMNS) if (!names.includes(c)) failures.push(`"course_profiles" no tiene la columna "${c}".`);

    // 3. Constraints con nombre.
    for (const exp of EXPECTED_CONSTRAINTS) {
      const res = await client.query(`select contype from pg_constraint where conname = $1`, [exp.conname]);
      if (res.rows.length === 0) failures.push(`Falta el constraint "${exp.conname}".`);
      else if (res.rows[0].contype !== exp.contype) failures.push(`Constraint "${exp.conname}" contype=${res.rows[0].contype}, esperado ${exp.contype}.`);
    }

    // 4. Triggers append-only.
    for (const tg of EXPECTED_TRIGGERS) {
      const res = await client.query(
        `select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where c.relname = 'course_profiles' and t.tgname = $1 and not t.tgisinternal`,
        [tg],
      );
      if (res.rows.length === 0) failures.push(`Falta el trigger "${tg}" en course_profiles.`);
    }

    if (failures.length > 0) {
      console.error('❌ Verificación de esquema FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    // 5. Sonda de comportamiento en una transacción SIEMPRE revertida.
    await client.query('begin');
    try {
      const course = await client.query(
        `insert into public.courses (title, structure_version) values ($1, 'dynamic')
         returning id, final_exam_enabled, activity_engine`,
        ['[verify-v21-blueprint-profiles] curso temporal (borrar)'],
      );
      const c = course.rows[0];
      if (c.final_exam_enabled !== true || c.activity_engine !== 'h5p') {
        failures.push(`Defaults del curso inesperados: final_exam_enabled=${c.final_exam_enabled}, activity_engine=${c.activity_engine}.`);
      }
      await expectError(client, 'sp_engine', `update public.courses set activity_engine = 'hvp' where id = $1`, [c.id],
        /courses_activity_engine_check/, 'activity_engine fuera de la lista', failures);

      const ins = `insert into public.course_profiles (course_id, kind, version, data, sha256) values ($1, $2, $3, $4::jsonb, $5) returning id`;
      const p1 = await client.query(ins, [c.id, 'assessment', 1, '{}', '0'.repeat(64)]);
      await expectError(client, 'sp_dup', ins, [c.id, 'assessment', 1, '{}', '1'.repeat(64)],
        /course_profiles_course_kind_version_key/, 'versión duplicada', failures);
      await expectError(client, 'sp_kind', ins, [c.id, 'theme', 1, '{}', '0'.repeat(64)],
        /course_profiles_kind_check/, 'kind fuera de la lista', failures);
      await expectError(client, 'sp_upd', `update public.course_profiles set data = '{"x":1}'::jsonb where id = $1`, [p1.rows[0].id],
        /append-only/, 'UPDATE de un perfil', failures);
      await expectError(client, 'sp_del', `delete from public.course_profiles where id = $1`, [p1.rows[0].id],
        /append-only/, 'DELETE directo de un perfil', failures);

      await client.query('savepoint sp_cascade');
      try {
        await client.query(`delete from public.courses where id = $1`, [c.id]);
        const left = await client.query(`select count(*)::int as n from public.course_profiles where course_id = $1`, [c.id]);
        if (left.rows[0].n !== 0) failures.push('El borrado del curso no arrastró sus perfiles (cascada).');
      } catch (err) {
        failures.push(`El borrado del curso con perfiles falló: ${err.message}`);
      } finally {
        await client.query('rollback to savepoint sp_cascade');
      }
    } finally {
      await client.query('rollback');
    }

    if (failures.length > 0) {
      console.error('❌ Verificación de esquema FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }
    console.log('✅ Esquema V2.1 R3 verificado (columnas, constraints, course_profiles append-only, cascada).');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
