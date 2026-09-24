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

// Mismos guardarraíles que verify-course-blueprints-schema.js — este script
// también se conecta a una base real (deploy-staging.yml lo corre justo
// después de la migración de Fase 4), así que necesita la misma protección.
// Ver migrate-dynamic-course-structure.js para la explicación completa de por
// qué es lista negra (ref de producción conocido) y no lista blanca (ref de
// staging sin confirmar para el backend).
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — este verificador es para el entorno de\n' +
      '   staging únicamente (spec: 2026-09-24-dynamic-course-structure-fase4-manifest).\n' +
      '   deploy-staging.yml lo setea automáticamente; si lo corrés a mano contra\n' +
      '   staging, usá: MIGRATION_ENV=staging node scripts/verify-generation-manifests-schema.js'
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
  course_generation_manifests: [
    'id', 'course_id', 'blueprint_id', 'rules_version', 'manifest_schema_version',
    'manifest_json', 'manifest_sha256', 'blueprint_sha256', 'module_count',
    'chapter_count', 'content_count', 'scorm_count', 'video_count', 'exam_count',
    'total_jobs', 'created_at', 'created_by',
  ],
};

const EXPECTED_CONSTRAINTS = [
  { conname: 'cgm_blueprint_fk', contype: 'f' },
  { conname: 'cgm_blueprint_rules_key', contype: 'u' },
  { conname: 'cgm_counts_consistent', contype: 'c' },
];

async function tableColumns(client, table) {
  const res = await client.query(
    `select column_name from information_schema.columns where table_schema='public' and table_name=$1`,
    [table],
  );
  return res.rows.map((r) => r.column_name);
}

function validSnapshotJson({ courseId, moduleId, chapterId, examEnabled, videoEnabled }) {
  return {
    schemaVersion: 1,
    course: { id: courseId, title: 'curso temporal', structureVersion: 'dynamic' },
    modules: [
      {
        id: moduleId,
        position: 0,
        title: 'Módulo 1',
        objective: 'objetivo',
        examEnabled,
        chapters: [
          { id: chapterId, position: 0, title: 'Capítulo 1', objective: 'objetivo', videoEnabled },
        ],
      },
    ],
  };
}

function validManifestJson({ courseId, blueprintId, blueprintNumber, blueprintSha256, moduleId, chapterId }) {
  return {
    manifestSchemaVersion: 1,
    rulesVersion: 1,
    source: { courseId, blueprintId, blueprintNumber, blueprintSha256 },
    modules: [
      {
        moduleId, position: 0, moduleNumber: 1, examEnabled: false,
        chapters: [{ chapterId, position: 0, chapterNumber: 1, videoEnabled: false }],
      },
    ],
    items: [
      { key: `content:${chapterId}`, type: 'content', scope: 'chapter', moduleId, chapterId, moduleNumber: 1, chapterNumber: 1, dependsOn: [] },
      { key: `scorm:${chapterId}`, type: 'scorm', scope: 'chapter', moduleId, chapterId, moduleNumber: 1, chapterNumber: 1, dependsOn: [`content:${chapterId}`] },
    ],
    totals: { moduleCount: 1, chapterCount: 1, contentCount: 1, scormCount: 1, videoCount: 0, examCount: 0, totalJobs: 2 },
  };
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

    // 2. Constraints con nombre (FK compuesta / unique / check)
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

    // 3. Trigger de inmutabilidad presente
    const trig = await client.query(
      `select t.tgname from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
        where c.relname = 'course_generation_manifests' and t.tgname = 'course_generation_manifests_immutable' and not t.tgisinternal`,
    );
    if (trig.rows.length === 0) failures.push('Falta el trigger "course_generation_manifests_immutable" en course_generation_manifests.');

    if (failures.length > 0) {
      console.error('❌ Verificación de esquema FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    // 4. Comportamiento real de inmutabilidad/unicidad/FK compuesta/CHECK, en
    // una transacción SIEMPRE revertida (finally → rollback). Se usan
    // SAVEPOINTs para que un error esperado dentro de la transacción no la
    // aborte y no impida correr los checks siguientes. Nunca se asume que
    // haya datos preexistentes: se crean 2 cursos dynamic temporales y un
    // Blueprint válido en cada uno.
    await client.query('begin');
    try {
      const courseA = await client.query(
        `insert into public.courses (title, structure_version) values ($1, 'dynamic') returning id`,
        ['[verify-generation-manifests] curso temporal A (borrar)'],
      );
      const courseAId = courseA.rows[0].id;

      const courseB = await client.query(
        `insert into public.courses (title, structure_version) values ($1, 'dynamic') returning id`,
        ['[verify-generation-manifests] curso temporal B (borrar)'],
      );
      const courseBId = courseB.rows[0].id;

      const moduleIdA = '00000000-0000-0000-0000-0000000000a1';
      const chapterIdA = '00000000-0000-0000-0000-0000000000a2';
      const moduleIdB = '00000000-0000-0000-0000-0000000000b1';
      const chapterIdB = '00000000-0000-0000-0000-0000000000b2';

      const blueprintSha256A = '3'.repeat(64);
      const blueprintSha256B = '4'.repeat(64);

      const blueprintA = await client.query(
        `insert into public.course_blueprints
           (course_id, blueprint_number, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, $2::jsonb, $3, 0, 1, 1)
         returning id`,
        [courseAId, JSON.stringify(validSnapshotJson({ courseId: courseAId, moduleId: moduleIdA, chapterId: chapterIdA, examEnabled: false, videoEnabled: false })), blueprintSha256A],
      );
      const blueprintAId = blueprintA.rows[0].id;

      const blueprintB = await client.query(
        `insert into public.course_blueprints
           (course_id, blueprint_number, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, $2::jsonb, $3, 0, 1, 1)
         returning id`,
        [courseBId, JSON.stringify(validSnapshotJson({ courseId: courseBId, moduleId: moduleIdB, chapterId: chapterIdB, examEnabled: false, videoEnabled: false })), blueprintSha256B],
      );
      const blueprintBId = blueprintB.rows[0].id;

      const manifestJsonA = validManifestJson({
        courseId: courseAId, blueprintId: blueprintAId, blueprintNumber: 1,
        blueprintSha256: blueprintSha256A, moduleId: moduleIdA, chapterId: chapterIdA,
      });
      const manifestShaA = '5'.repeat(64);

      // 4a. Insert válido debe funcionar.
      let manifestAId = null;
      try {
        const res = await client.query(
          `insert into public.course_generation_manifests
             (course_id, blueprint_id, rules_version, manifest_json, manifest_sha256, blueprint_sha256,
              module_count, chapter_count, content_count, scorm_count, video_count, exam_count, total_jobs)
           values ($1, $2, 1, $3::jsonb, $4, $5, 1, 1, 1, 1, 0, 0, 2)
           returning id`,
          [courseAId, blueprintAId, JSON.stringify(manifestJsonA), manifestShaA, blueprintSha256A],
        );
        manifestAId = res.rows[0].id;
      } catch (e) {
        failures.push(`Insert válido de course_generation_manifests falló inesperadamente: ${e.message} (código: ${e.code || 'ninguno'}).`);
      }

      if (manifestAId !== null) {
        // 4b. UPDATE debe fallar con P0001 (trigger de inmutabilidad).
        await client.query('savepoint sp_immutable');
        let immutableRejected = false;
        let immutableCode = null;
        try {
          await client.query(
            `update public.course_generation_manifests set total_jobs = total_jobs + 1 where id = $1`,
            [manifestAId],
          );
        } catch (e) {
          immutableCode = e.code;
          immutableRejected = e.code === 'P0001';
        } finally {
          await client.query('rollback to savepoint sp_immutable');
        }
        if (!immutableRejected) {
          failures.push(`UPDATE sobre course_generation_manifests NO fue rechazado con P0001 (código real: ${immutableCode || 'ninguno — se permitió el UPDATE'}).`);
        }

        // 4c. Duplicado (blueprint_id, rules_version) debe fallar con 23505.
        await client.query('savepoint sp_unique');
        let uniqueRejected = false;
        let uniqueCode = null;
        try {
          await client.query(
            `insert into public.course_generation_manifests
               (course_id, blueprint_id, rules_version, manifest_json, manifest_sha256, blueprint_sha256,
                module_count, chapter_count, content_count, scorm_count, video_count, exam_count, total_jobs)
             values ($1, $2, 1, $3::jsonb, $4, $5, 1, 1, 1, 1, 0, 0, 2)`,
            [courseAId, blueprintAId, JSON.stringify(manifestJsonA), '6'.repeat(64), blueprintSha256A],
          );
        } catch (e) {
          uniqueCode = e.code;
          uniqueRejected = e.code === '23505';
        } finally {
          await client.query('rollback to savepoint sp_unique');
        }
        if (!uniqueRejected) {
          failures.push(`Insertar un segundo Manifest con (blueprint_id, rules_version) duplicado NO fue rechazado con 23505 (código real: ${uniqueCode || 'ninguno — se insertó'}).`);
        }

        // 4d. Manifest del curso A referenciando el blueprint del curso B debe
        // fallar con 23503 (la FK compuesta (blueprint_id, course_id) exige
        // que el Blueprint pertenezca al mismo curso).
        await client.query('savepoint sp_fk_cross_course');
        let crossCourseFkRejected = false;
        let crossCourseFkCode = null;
        try {
          await client.query(
            `insert into public.course_generation_manifests
               (course_id, blueprint_id, rules_version, manifest_json, manifest_sha256, blueprint_sha256,
                module_count, chapter_count, content_count, scorm_count, video_count, exam_count, total_jobs)
             values ($1, $2, 1, $3::jsonb, $4, $5, 1, 1, 1, 1, 0, 0, 2)`,
            [courseAId, blueprintBId, JSON.stringify(manifestJsonA), '7'.repeat(64), blueprintSha256B],
          );
        } catch (e) {
          crossCourseFkCode = e.code;
          crossCourseFkRejected = e.code === '23503';
        } finally {
          await client.query('rollback to savepoint sp_fk_cross_course');
        }
        if (!crossCourseFkRejected) {
          failures.push(`Insertar un Manifest del curso A con blueprint_id del curso B NO fue rechazado con 23503 (código real: ${crossCourseFkCode || 'ninguno — se permitió'}).`);
        }

        // 4e. Conteos inconsistentes deben fallar con 23514 (check_violation).
        await client.query('savepoint sp_check');
        let checkRejected = false;
        let checkCode = null;
        try {
          await client.query(
            `insert into public.course_generation_manifests
               (course_id, blueprint_id, rules_version, manifest_json, manifest_sha256, blueprint_sha256,
                module_count, chapter_count, content_count, scorm_count, video_count, exam_count, total_jobs)
             values ($1, $2, 2, $3::jsonb, $4, $5, 1, 1, 1, 1, 0, 0, 999)`,
            [courseAId, blueprintAId, JSON.stringify(manifestJsonA), '8'.repeat(64), blueprintSha256A],
          );
        } catch (e) {
          checkCode = e.code;
          checkRejected = e.code === '23514';
        } finally {
          await client.query('rollback to savepoint sp_check');
        }
        if (!checkRejected) {
          failures.push(`Insertar un Manifest con conteos inconsistentes (total_jobs erróneo) NO fue rechazado con 23514 (código real: ${checkCode || 'ninguno — se insertó'}).`);
        }
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

    console.log('✅ Esquema de course_generation_manifests verificado correctamente (ref de proyecto:', extractSupabaseProjectRef(), ')');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
