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

// Mismos guardarraíles que migrate-dynamic-course-structure.js — este script
// también se conecta a una base real (deploy-staging.yml lo corre justo
// después de la migración), así que necesita la misma protección. Ver ese
// archivo para la explicación completa de por qué es lista negra (ref de
// producción conocido) y no lista blanca (ref de staging sin confirmar para
// el backend).
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — este verificador es para el entorno de\n' +
      '   staging únicamente (spec: 2026-09-23-dynamic-course-structure-design.md).\n' +
      '   deploy-staging.yml lo setea automáticamente; si lo corrés a mano contra\n' +
      '   staging, usá: MIGRATION_ENV=staging node scripts/verify-dynamic-course-structure-schema.js'
    );
    process.exit(1);
  }
}

const KNOWN_PRODUCTION_SUPABASE_REF = 'hriwbakbuypaiovvvkqh';
const KNOWN_STAGING_SUPABASE_REF_FRONTEND_ONLY = 'ljdtmkwuhkvtmlhugjrv';

function extractSupabaseProjectRef() {
  const host = String(process.env.DB_HOST || '');
  const user = String(process.env.DB_USER || '');
  let m = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (m) return m[1];
  m = user.match(/^postgres\.([a-z0-9]+)$/i);
  if (m) return m[1];
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
      '   DB_USER (formato inesperado). Abortando por seguridad — no se puede\n' +
      '   confirmar que la conexión NO sea producción.'
    );
    process.exit(1);
  }
  if (ref === KNOWN_STAGING_SUPABASE_REF_FRONTEND_ONLY) {
    console.log('✅ Ref de proyecto (' + ref + ') coincide con el de staging conocido (frontend Auth/Storage).');
  } else {
    console.warn(
      '⚠️  El ref de proyecto detectado (' + ref + ') no coincide con el único ref de\n' +
      '   staging conocido en este repo. Continuando porque definitivamente NO\n' +
      '   es el proyecto de producción — pero no es confirmación positiva de staging.'
    );
  }
}

const EXPECTED_COLUMNS = {
  course_modules: ['id', 'course_id', 'position', 'title', 'objective', 'exam_enabled', 'status', 'created_at', 'updated_at'],
  course_chapters: ['id', 'course_id', 'module_id', 'position', 'title', 'objective', 'video_enabled', 'status', 'context_summary', 'generated_with_version_id', 'created_at', 'updated_at'],
};

const EXPECTED_ADDED_COLUMNS = {
  courses: ['structure_version', 'structure_version_counter'],
  course_versions: ['locked_at'],
  artifacts: ['module_id', 'chapter_id', 'status', 'generated_with_version_id'],
  production_jobs: ['blueprint_version_id'],
};

async function tableColumns(client, table) {
  const res = await client.query(
    `select column_name from information_schema.columns where table_schema='public' and table_name=$1`,
    [table],
  );
  return res.rows.map((r) => r.column_name);
}

// Columnas donde tipo/nullable/default importan de verdad (no solo que existan).
const EXPECTED_COLUMN_DETAILS = [
  { table: 'course_chapters', column: 'status', defaultIncludes: "'not_generated'", isNullable: 'NO' },
  { table: 'courses', column: 'structure_version', defaultIncludes: "'legacy'", isNullable: 'NO' },
  { table: 'course_modules', column: 'id', dataType: 'uuid' },
  { table: 'course_chapters', column: 'id', dataType: 'uuid' },
];

const EXPECTED_CHECK_CONSTRAINTS = [
  'courses_structure_version_check',
  'course_modules_status_check',
  'course_chapters_status_check',
];

async function columnDetails(client, table, column) {
  const res = await client.query(
    `select data_type, is_nullable, column_default from information_schema.columns
      where table_schema='public' and table_name=$1 and column_name=$2`,
    [table, column],
  );
  return res.rows[0] || null;
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
    // 1. Tablas nuevas y sus columnas
    for (const [table, expectedCols] of Object.entries(EXPECTED_COLUMNS)) {
      const cols = await tableColumns(client, table);
      if (cols.length === 0) {
        failures.push(`Tabla "${table}" no existe.`);
        continue;
      }
      for (const col of expectedCols) {
        if (!cols.includes(col)) failures.push(`Tabla "${table}" no tiene la columna "${col}".`);
      }
    }

    // 2. Columnas agregadas a tablas existentes
    for (const [table, expectedCols] of Object.entries(EXPECTED_ADDED_COLUMNS)) {
      const cols = await tableColumns(client, table);
      for (const col of expectedCols) {
        if (!cols.includes(col)) failures.push(`Tabla "${table}" no tiene la columna nueva "${col}".`);
      }
    }

    // 2b. Tipo / nullable / default de las columnas críticas
    for (const exp of EXPECTED_COLUMN_DETAILS) {
      const det = await columnDetails(client, exp.table, exp.column);
      if (!det) continue; // la ausencia ya quedó reportada arriba
      const label = `${exp.table}.${exp.column}`;
      if (exp.dataType && det.data_type !== exp.dataType) {
        failures.push(`Columna "${label}" tiene data_type="${det.data_type}", esperado "${exp.dataType}".`);
      }
      if (exp.isNullable && det.is_nullable !== exp.isNullable) {
        failures.push(`Columna "${label}" tiene is_nullable="${det.is_nullable}", esperado "${exp.isNullable}".`);
      }
      if (exp.defaultIncludes && !String(det.column_default || '').includes(exp.defaultIncludes)) {
        failures.push(`Columna "${label}" tiene column_default=${JSON.stringify(det.column_default)}, esperado que contenga ${exp.defaultIncludes}.`);
      }
    }

    // 2c. CHECK constraints con nombre
    for (const conname of EXPECTED_CHECK_CONSTRAINTS) {
      const res = await client.query(`select conname from pg_constraint where conname = $1`, [conname]);
      if (res.rows.length === 0) failures.push(`Falta el CHECK constraint "${conname}".`);
    }

    if (failures.length > 0) {
      console.error('❌ Verificación de esquema FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    // 3. Cursos existentes no fueron tocados: structure_version debe ser 'legacy' por default
    const existing = await client.query(
      `select id, structure_version from public.courses order by id limit 5`,
    );
    for (const row of existing.rows) {
      if (row.structure_version !== 'legacy') {
        failures.push(`Curso id=${row.id} tiene structure_version="${row.structure_version}", esperado "legacy" (no debería haber sido tocado por esta migración).`);
      }
    }

    // 4. FK real: insertar course_chapter con module_id inexistente debe fallar
    if (existing.rows.length === 0) {
      console.warn('⚠️  No hay cursos existentes en esta base — se omiten los checks 3 y 5 (requieren un curso real).');
    } else {
      const courseId = existing.rows[0].id;
      let fkRejected = false;
      // Transacción local solo para este check: si la FK faltara, el huérfano
      // igual se descarta con el rollback en vez de quedar commiteado.
      await client.query('begin');
      try {
        await client.query(
          `insert into public.course_chapters (course_id, module_id, position, title) values ($1, gen_random_uuid(), 1, 'test')`,
          [courseId],
        );
      } catch (e) {
        fkRejected = e.code === '23503'; // SQLSTATE foreign_key_violation (independiente del idioma del servidor)
      } finally {
        await client.query('rollback');
      }
      if (!fkRejected) failures.push('Insertar un course_chapter con module_id inexistente NO fue rechazado por la FK — se insertó un huérfano.');

      // 5. Insert real válido + lectura de vuelta + limpieza
      await client.query('begin');
      try {
        const mod = await client.query(
          `insert into public.course_modules (course_id, position, title) values ($1, 999, 'Módulo de verificación (borrar)') returning id`,
          [courseId],
        );
        const moduleId = mod.rows[0].id;
        const chap = await client.query(
          `insert into public.course_chapters (course_id, module_id, position, title) values ($1, $2, 1, 'Capítulo de verificación (borrar)') returning id, status`,
          [courseId, moduleId],
        );
        if (chap.rows[0].status !== 'not_generated') {
          failures.push(`Default de status en course_chapters vino "${chap.rows[0].status}", esperado "not_generated".`);
        }
      } finally {
        await client.query('rollback'); // nunca deja basura en la tabla, sea cual sea el resultado
      }
    }

    if (failures.length > 0) {
      console.error('❌ Verificación de esquema FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    console.log('✅ Esquema de estructura dinámica verificado correctamente (ref de proyecto:', extractSupabaseProjectRef(), ')');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
