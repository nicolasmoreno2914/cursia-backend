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

// Mismos guardarraíles que migrate-course-blueprints.js — este script también
// se conecta a una base real (deploy-staging.yml lo corre justo después de la
// migración), así que necesita la misma protección. Ver
// migrate-dynamic-course-structure.js para la explicación completa de por qué
// es lista negra (ref de producción conocido) y no lista blanca (ref de
// staging sin confirmar para el backend).
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — este verificador es para el entorno de\n' +
      '   staging únicamente (spec: 2026-09-24-dynamic-course-structure-fase3-blueprint).\n' +
      '   deploy-staging.yml lo setea automáticamente; si lo corrés a mano contra\n' +
      '   staging, usá: MIGRATION_ENV=staging node scripts/verify-course-blueprints-schema.js'
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
  course_blueprints: [
    'id', 'course_id', 'blueprint_number', 'schema_version', 'snapshot_json',
    'snapshot_sha256', 'structure_counter_at_lock', 'module_count', 'chapter_count',
    'locked_at', 'locked_by',
  ],
};

const EXPECTED_ADDED_COLUMNS = {
  courses: ['current_blueprint_id'],
};

const EXPECTED_CONSTRAINTS = [
  { conname: 'course_blueprints_course_number_key', contype: 'u' },
  { conname: 'course_blueprints_id_course_key', contype: 'u' },
  { conname: 'courses_current_blueprint_fk', contype: 'f' },
];

// Las 3 FKs de Fase 1 que Fase 3 reapunta de course_versions a
// course_blueprints (ver supabase-migration-course-blueprints.sql).
const REPOINTED_FKS = [
  { table: 'course_chapters', column: 'generated_with_version_id' },
  { table: 'artifacts', column: 'generated_with_version_id' },
  { table: 'production_jobs', column: 'blueprint_version_id' },
];

async function tableColumns(client, table) {
  const res = await client.query(
    `select column_name from information_schema.columns where table_schema='public' and table_name=$1`,
    [table],
  );
  return res.rows.map((r) => r.column_name);
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
    // 1. Tabla nueva y sus columnas
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

    // 2. Columna agregada a courses
    for (const [table, expectedCols] of Object.entries(EXPECTED_ADDED_COLUMNS)) {
      const cols = await tableColumns(client, table);
      for (const col of expectedCols) {
        if (!cols.includes(col)) failures.push(`Tabla "${table}" no tiene la columna nueva "${col}".`);
      }
    }

    // 3. Constraints con nombre (unique / FK)
    for (const exp of EXPECTED_CONSTRAINTS) {
      const res = await client.query(
        `select contype from pg_constraint where conname = $1`,
        [exp.conname],
      );
      if (res.rows.length === 0) {
        failures.push(`Falta el constraint "${exp.conname}".`);
      } else if (res.rows[0].contype !== exp.contype) {
        failures.push(`Constraint "${exp.conname}" tiene contype="${res.rows[0].contype}", esperado "${exp.contype}".`);
      }
    }

    // 4. Trigger de inmutabilidad presente
    const trig = await client.query(
      `select t.tgname from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
        where c.relname = 'course_blueprints' and t.tgname = 'course_blueprints_immutable' and not t.tgisinternal`,
    );
    if (trig.rows.length === 0) failures.push('Falta el trigger "course_blueprints_immutable" en course_blueprints.');

    // 5. Las 3 FKs de Fase 1 apuntan a course_blueprints y ninguna a course_versions
    for (const { table, column } of REPOINTED_FKS) {
      const res = await client.query(
        `select con.conname, con.confrelid::regclass::text as target
           from pg_constraint con
           join pg_class t on t.oid = con.conrelid
           join pg_attribute a on a.attrelid = t.oid and a.attnum = any (con.conkey)
          where t.relname = $1 and a.attname = $2 and con.contype = 'f'`,
        [table, column],
      );
      const targets = res.rows.map((r) => r.target);
      if (!targets.includes('course_blueprints')) {
        failures.push(`Columna "${table}.${column}" no tiene FK hacia "course_blueprints" (targets encontrados: ${targets.join(', ') || 'ninguno'}).`);
      }
      if (targets.includes('course_versions')) {
        failures.push(`Columna "${table}.${column}" todavía tiene una FK hacia "course_versions" — no se reapuntó.`);
      }
    }

    if (failures.length > 0) {
      console.error('❌ Verificación de esquema FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    // 6. Invariante: ningún curso legacy tiene filas en course_blueprints ni
    // current_blueprint_id seteado. No se asume nada sobre cursos existentes
    // más allá de esto — Fase 2/3 permiten cursos 'dynamic' legítimos.
    const legacyWithBlueprintPointer = await client.query(
      `select id from public.courses where structure_version = 'legacy' and current_blueprint_id is not null order by id limit 5`,
    );
    for (const row of legacyWithBlueprintPointer.rows) {
      failures.push(`Curso legacy id=${row.id} tiene current_blueprint_id seteado — no debería tener Blueprints.`);
    }
    const legacyWithBlueprintRows = await client.query(
      `select cb.id as blueprint_id, cb.course_id from public.course_blueprints cb
         join public.courses c on c.id = cb.course_id
        where c.structure_version = 'legacy' order by cb.id limit 5`,
    );
    for (const row of legacyWithBlueprintRows.rows) {
      failures.push(`Curso legacy id=${row.course_id} tiene un Blueprint (id=${row.blueprint_id}) — la estructura dinámica nunca debe tocar cursos legacy.`);
    }

    if (failures.length > 0) {
      console.error('❌ Verificación de esquema FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    // 7. Comportamiento real de inmutabilidad/unicidad/FK compuesta, en una
    // transacción SIEMPRE revertida (finally → rollback). Se usan SAVEPOINTs
    // para que un error esperado dentro de la transacción no la aborte y no
    // impida correr los checks siguientes.
    await client.query('begin');
    try {
      const courseA = await client.query(
        `insert into public.courses (title, structure_version) values ($1, 'dynamic') returning id`,
        ['[verify-course-blueprints] curso temporal A (borrar)'],
      );
      const courseAId = courseA.rows[0].id;

      const courseB = await client.query(
        `insert into public.courses (title, structure_version) values ($1, 'dynamic') returning id`,
        ['[verify-course-blueprints] curso temporal B (borrar)'],
      );
      const courseBId = courseB.rows[0].id;

      const blueprintA = await client.query(
        `insert into public.course_blueprints
           (course_id, blueprint_number, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, $2::jsonb, $3, 0, 1, 1)
         returning id`,
        [courseAId, JSON.stringify({ modules: [] }), '0'.repeat(64)],
      );
      const blueprintAId = blueprintA.rows[0].id;

      const blueprintB = await client.query(
        `insert into public.course_blueprints
           (course_id, blueprint_number, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, $2::jsonb, $3, 0, 1, 1)
         returning id`,
        [courseBId, JSON.stringify({ modules: [] }), '1'.repeat(64)],
      );
      const blueprintBId = blueprintB.rows[0].id;

      // 7a. UPDATE de un Blueprint existente debe fallar con P0001 (trigger de inmutabilidad).
      await client.query('savepoint sp_immutable');
      let immutableRejected = false;
      let immutableCode = null;
      try {
        await client.query(
          `update public.course_blueprints set module_count = module_count + 1 where id = $1`,
          [blueprintAId],
        );
      } catch (e) {
        immutableCode = e.code;
        immutableRejected = e.code === 'P0001';
      } finally {
        await client.query('rollback to savepoint sp_immutable');
      }
      if (!immutableRejected) {
        failures.push(`UPDATE sobre course_blueprints NO fue rechazado con P0001 (código real: ${immutableCode || 'ninguno — se permitió el UPDATE'}).`);
      }

      // 7b. Segundo insert con el mismo (course_id, blueprint_number) debe
      // fallar con 23505 (unique_violation).
      await client.query('savepoint sp_unique');
      let uniqueRejected = false;
      let uniqueCode = null;
      try {
        await client.query(
          `insert into public.course_blueprints
             (course_id, blueprint_number, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
           values ($1, 1, $2::jsonb, $3, 0, 1, 1)`,
          [courseAId, JSON.stringify({ modules: [] }), '2'.repeat(64)],
        );
      } catch (e) {
        uniqueCode = e.code;
        uniqueRejected = e.code === '23505';
      } finally {
        await client.query('rollback to savepoint sp_unique');
      }
      if (!uniqueRejected) {
        failures.push(`Insertar un segundo Blueprint con (course_id, blueprint_number) duplicado NO fue rechazado con 23505 (código real: ${uniqueCode || 'ninguno — se insertó'}).`);
      }

      // 7c. UPDATE courses.current_blueprint_id apuntando a un Blueprint de
      // OTRO curso debe fallar con 23503 (foreign_key_violation) — la FK
      // compuesta (current_blueprint_id, id) → course_blueprints(id, course_id)
      // exige que el Blueprint pertenezca al mismo curso.
      await client.query('savepoint sp_fk_cross_course');
      let crossCourseFkRejected = false;
      let crossCourseFkCode = null;
      try {
        await client.query(
          `update public.courses set current_blueprint_id = $1 where id = $2`,
          [blueprintBId, courseAId],
        );
      } catch (e) {
        crossCourseFkCode = e.code;
        crossCourseFkRejected = e.code === '23503';
      } finally {
        await client.query('rollback to savepoint sp_fk_cross_course');
      }
      if (!crossCourseFkRejected) {
        failures.push(`Apuntar current_blueprint_id a un Blueprint de OTRO curso NO fue rechazado con 23503 (código real: ${crossCourseFkCode || 'ninguno — se permitió'}).`);
      }
    } finally {
      await client.query('rollback'); // nunca deja basura, sea cual sea el resultado
    }

    if (failures.length > 0) {
      console.error('❌ Verificación de esquema FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    console.log('✅ Esquema de course_blueprints verificado correctamente (ref de proyecto:', extractSupabaseProjectRef(), ')');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
