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

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));

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
      try {
        await client.query(
          `insert into public.course_chapters (course_id, module_id, position, title) values ($1, gen_random_uuid(), 1, 'test')`,
          [courseId],
        );
      } catch (e) {
        fkRejected = /foreign key/i.test(e.message);
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

    console.log('✅ Esquema de estructura dinámica verificado correctamente contra', process.env.DB_NAME);
  } finally {
    await client.end();
  }
}

main();
