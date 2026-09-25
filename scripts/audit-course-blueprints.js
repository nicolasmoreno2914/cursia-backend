#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const v2Target = require('./lib/v2-production-target');

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

// Mismos guardarraíles que verify-course-blueprints-schema.js / migrate-course-blueprints.js
// — este script también se conecta a una base real (deploy-staging.yml lo corre
// justo después de la verificación de esquema de Fase 3), así que necesita la
// misma protección. Ver migrate-dynamic-course-structure.js para la explicación
// completa de por qué es lista negra (ref de producción conocido) y no lista
// blanca (ref de staging sin confirmar para el backend).
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — este auditor es de solo lectura pero\n' +
      '   está pensado exclusivamente para el entorno de staging (spec:\n' +
      '   2026-09-24-dynamic-course-structure-fase3-blueprint). deploy-staging.yml\n' +
      '   lo setea automáticamente; si lo corrés a mano contra staging, usá:\n' +
      '   MIGRATION_ENV=staging node scripts/audit-course-blueprints.js'
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

function shortSha(sha) {
  if (!sha) return '(vacío)';
  return String(sha).slice(0, 12);
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  // Fase 9 (G6): modo opt-in V2_VERIFY_MODE=production-readonly (lo usa
  // scripts/prod/migrate-v2-production.js). Sin esa env var, los guards de
  // staging de siempre, sin ningún cambio de comportamiento.
  const PROD_RO = v2Target.isProductionReadonlyRequested()
    ? v2Target.assertProductionReadonlyTargetOrExit()
    : null;
  if (!PROD_RO) {
    assertExplicitStagingIntent();
    assertNotProductionProject();
  }

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
  if (PROD_RO) {
    try {
      await v2Target.enterProductionReadonlySession(client, PROD_RO);
    } catch (err) {
      await client.end();
      throw err;
    }
  }
  const failures = [];

  try {
    console.log('=== 1. Conteos ===');

    const byVersion = await client.query(
      `select structure_version, count(*)::int as n from public.courses group by structure_version order by structure_version`,
    );
    if (byVersion.rows.length === 0) {
      console.log('courses: 0 filas totales.');
    } else {
      for (const row of byVersion.rows) {
        console.log(`courses[structure_version=${row.structure_version}]: ${row.n}`);
      }
    }

    const blueprintCount = await client.query(`select count(*)::int as n from public.course_blueprints`);
    console.log(`course_blueprints: ${blueprintCount.rows[0].n} filas totales.`);

    const versionsCount = await client.query(`select count(*)::int as n from public.course_versions`);
    console.log(`course_versions: ${versionsCount.rows[0].n} filas totales.`);

    console.log('');
    console.log('=== 2. Cursos dinámicos recientes con Blueprints (hasta 5, por locked_at más reciente) ===');

    const recentCourses = await client.query(
      `select c.id as course_id, c.structure_version_counter, c.current_blueprint_id, max(cb.locked_at) as max_locked_at
         from public.courses c
         join public.course_blueprints cb on cb.course_id = c.id
        where c.structure_version = 'dynamic'
        group by c.id, c.structure_version_counter, c.current_blueprint_id
        order by max(cb.locked_at) desc
        limit 5`,
    );

    if (recentCourses.rows.length === 0) {
      console.log('(sin cursos dinámicos con al menos un Blueprint)');
    }

    for (const course of recentCourses.rows) {
      console.log(
        `\ncourse_id=${course.course_id} structure_version_counter=${course.structure_version_counter} ` +
        `current_blueprint_id=${course.current_blueprint_id === null ? 'null' : course.current_blueprint_id}`,
      );

      const blueprints = await client.query(
        `select
            id, course_id, blueprint_number, schema_version, locked_at,
            module_count, chapter_count, structure_counter_at_lock,
            snapshot_sha256,
            jsonb_typeof(snapshot_json) as snapshot_type,
            case when jsonb_typeof(snapshot_json) = 'object'
                 then array(select jsonb_object_keys(snapshot_json))
                 else null
            end as snapshot_keys,
            case when jsonb_typeof(snapshot_json->'modules') = 'array'
                 then jsonb_array_length(snapshot_json->'modules')
                 else null
            end as modules_len,
            (snapshot_json->'course'->>'id') = course_id::text as course_id_matches
          from public.course_blueprints
         where course_id = $1
         order by blueprint_number`,
        [course.course_id],
      );

      for (const bp of blueprints.rows) {
        const marker = course.current_blueprint_id !== null && bp.id === course.current_blueprint_id ? ' *' : '';
        console.log(
          `  blueprint_id=${bp.id} course_id=${bp.course_id} blueprint_number=${bp.blueprint_number} ` +
          `schema_version=${bp.schema_version} locked_at=${new Date(bp.locked_at).toISOString()} ` +
          `module_count=${bp.module_count} chapter_count=${bp.chapter_count} ` +
          `structure_counter_at_lock=${bp.structure_counter_at_lock} sha256[:12]=${shortSha(bp.snapshot_sha256)} ` +
          `jsonb_typeof=${bp.snapshot_type} keys=[${(bp.snapshot_keys || []).join(', ')}] modules_len=${bp.modules_len} ` +
          `course_id_matches=${bp.course_id_matches}${marker}`,
        );
      }
    }

    console.log('');
    console.log('=== 3. Invariantes ===');

    // 3a. No hay (course_id, blueprint_number) duplicados.
    const dupes = await client.query(
      `select course_id, blueprint_number, count(*)::int as n
         from public.course_blueprints
        group by course_id, blueprint_number
       having count(*) > 1`,
    );
    if (dupes.rows.length === 0) {
      console.log('✅ (a) sin (course_id, blueprint_number) duplicados.');
    } else {
      console.log(`❌ (a) ${dupes.rows.length} pares (course_id, blueprint_number) duplicados.`);
      failures.push('Duplicados en (course_id, blueprint_number).');
    }

    // 3b. Todo courses.current_blueprint_id (no nulo) apunta a un Blueprint del mismo curso.
    const badPointers = await client.query(
      `select c.id as course_id, c.current_blueprint_id
         from public.courses c
         left join public.course_blueprints cb
           on cb.id = c.current_blueprint_id and cb.course_id = c.id
        where c.current_blueprint_id is not null
          and cb.id is null`,
    );
    if (badPointers.rows.length === 0) {
      console.log('✅ (b) todo current_blueprint_id apunta a un Blueprint del mismo curso.');
    } else {
      console.log(`❌ (b) ${badPointers.rows.length} cursos con current_blueprint_id inválido/cruzado.`);
      failures.push('current_blueprint_id apunta a un Blueprint inexistente o de otro curso.');
    }

    // 3c. snapshot_json->course->id == course_id::text, y jsonb_array_length(modules) == module_count.
    const badSnapshots = await client.query(
      `select id, course_id
         from public.course_blueprints
        where (snapshot_json->'course'->>'id') is distinct from course_id::text
           or (
             case when jsonb_typeof(snapshot_json->'modules') = 'array'
                  then jsonb_array_length(snapshot_json->'modules')
                  else null
             end
           ) is distinct from module_count`,
    );
    if (badSnapshots.rows.length === 0) {
      console.log('✅ (c) todos los snapshots consistentes con course_id y module_count.');
    } else {
      console.log(`❌ (c) ${badSnapshots.rows.length} Blueprints con snapshot inconsistente.`);
      failures.push('snapshot_json inconsistente con course_id/module_count en al menos un Blueprint.');
    }

    // 3d. Ningún curso legacy tiene Blueprints ni current_blueprint_id.
    const legacyPointer = await client.query(
      `select id from public.courses where structure_version = 'legacy' and current_blueprint_id is not null`,
    );
    const legacyBlueprints = await client.query(
      `select cb.id from public.course_blueprints cb
         join public.courses c on c.id = cb.course_id
        where c.structure_version = 'legacy'`,
    );
    if (legacyPointer.rows.length === 0 && legacyBlueprints.rows.length === 0) {
      console.log('✅ (d) ningún curso legacy tiene Blueprints ni current_blueprint_id.');
    } else {
      console.log(
        `❌ (d) ${legacyPointer.rows.length} cursos legacy con current_blueprint_id, ` +
        `${legacyBlueprints.rows.length} Blueprints de cursos legacy.`,
      );
      failures.push('Curso(s) legacy con Blueprints o current_blueprint_id seteado.');
    }

    // 3e. Ningún curso dinámico "debería" tener filas en course_versions (Fase 3
    // nunca escribe ahí) — pero esto es solo INFORMATIVO, nunca bloquea el
    // deploy: CourseVersionsService.create (código legacy compartido, fuera de
    // alcance de esta ronda por decisión del controller, ver ruling R12) no
    // valida structure_version antes de insertar, así que un solo guardado
    // legacy en la nube sobre un curso dinámico dejaría el audit en rojo para
    // siempre si esto fuera un ❌. Se reporta como ⚠️ con los course_id
    // afectados para que alguien lo investigue, sin tumbar el pipeline.
    const dynamicVersions = await client.query(
      `select cv.course_id, count(*)::int as n
         from public.course_versions cv
         join public.courses c on c.id = cv.course_id
        where c.structure_version = 'dynamic'
        group by cv.course_id
        order by cv.course_id`,
    );
    const dynamicVersionsTotal = dynamicVersions.rows.reduce((acc, r) => acc + r.n, 0);
    if (dynamicVersionsTotal === 0) {
      console.log('✅ (e) ningún curso dinámico tiene filas en course_versions (count=0).');
    } else {
      const courseIds = dynamicVersions.rows.map((r) => r.course_id).join(', ');
      console.log(
        `⚠️  (e) WARNING (no bloquea el deploy): ${dynamicVersionsTotal} filas de course_versions ` +
        `pertenecen a curso(s) dinámico(s) — course_id afectados: [${courseIds}]. Fase 3 nunca debería ` +
        `escribir ahí, pero CourseVersionsService.create (legacy) no lo impide; investigar manualmente.`,
      );
    }

    // 3f. Inmutabilidad sobre datos reales.
    // Fase 9 (G6): en production-readonly esta sonda NO corre (escribe dentro
    // de una transacción revertida y la sesión es READ ONLY). Cuerpo sin
    // reindentar a propósito para mantener el diff mínimo.
    if (PROD_RO) {
      v2Target.logSkippedProbe('3f. inmutabilidad sobre datos reales (UPDATE no-op revertido)');
    } else {
    await client.query('begin');
    try {
      const latest = await client.query(
        `select id from public.course_blueprints order by locked_at desc, id desc limit 1`,
      );

      if (latest.rows.length === 0) {
        console.log('✅ (f) no hay Blueprints reales — nada que probar, se considera pasado.');
      } else {
        const latestId = latest.rows[0].id;

        await client.query('savepoint s1');
        let immutableRejected = false;
        let immutableCode = null;
        let immutableRowCount = null;
        try {
          const res = await client.query(
            `update public.course_blueprints set module_count = module_count where id = $1`,
            [latestId],
          );
          immutableRowCount = res.rowCount;
        } catch (e) {
          immutableCode = e.code;
          immutableRejected = e.code === 'P0001';
        } finally {
          await client.query('rollback to savepoint s1');
        }
        if (immutableRejected) {
          console.log(`✅ (f) UPDATE sobre course_blueprints (id=${latestId}) rechazado con P0001.`);
        } else if (immutableRowCount === 0) {
          console.log(
            `⚠️  (f) omitido (fila ya no existe) — el UPDATE sobre course_blueprints (id=${latestId}) ` +
            `no afectó ninguna fila (borrada entre el SELECT y el UPDATE).`,
          );
        } else {
          console.log(
            `❌ (f) UPDATE sobre course_blueprints (id=${latestId}) NO fue rechazado con P0001 ` +
            `(código real: ${immutableCode || 'ninguno — se permitió el UPDATE'}).`,
          );
          failures.push('El trigger de inmutabilidad no rechazó un UPDATE real sobre course_blueprints.');
        }

        const distinctCourses = await client.query(
          `select course_id, min(id) as some_blueprint_id
             from public.course_blueprints
            group by course_id
            order by course_id
            limit 2`,
        );

        if (distinctCourses.rows.length < 2) {
          console.log('⚠️  omitido (solo un curso tiene Blueprints; cubierto por las filas temporales del verificador)');
        } else {
          const [courseX, courseY] = distinctCourses.rows;
          await client.query('savepoint s2');
          let fkRejected = false;
          let fkCode = null;
          let fkRowCount = null;
          try {
            const res = await client.query(
              `update public.courses set current_blueprint_id = $1 where id = $2`,
              [courseX.some_blueprint_id, courseY.course_id],
            );
            fkRowCount = res.rowCount;
          } catch (e) {
            fkCode = e.code;
            fkRejected = e.code === '23503';
          } finally {
            await client.query('rollback to savepoint s2');
          }
          if (fkRejected) {
            console.log(
              `✅ (f) apuntar current_blueprint_id de course_id=${courseY.course_id} a un Blueprint de ` +
              `course_id=${courseX.course_id} rechazado con 23503.`,
            );
          } else if (fkRowCount === 0) {
            console.log(
              `⚠️  (f) omitido (fila ya no existe) — el UPDATE sobre courses (id=${courseY.course_id}) ` +
              `no afectó ninguna fila (borrada entre el SELECT y el UPDATE).`,
            );
          } else {
            console.log(
              `❌ (f) apuntar current_blueprint_id de course_id=${courseY.course_id} a un Blueprint de ` +
              `course_id=${courseX.course_id} NO fue rechazado con 23503 (código real: ${fkCode || 'ninguno — se permitió'}).`,
            );
            failures.push('La FK compuesta no rechazó un current_blueprint_id cruzado entre cursos reales.');
          }
        }
      }
    } finally {
      await client.query('rollback'); // nunca deja basura, sea cual sea el resultado
    }
    } // fin if (PROD_RO) — sonda con escritura revertida

    console.log('');
    if (failures.length > 0) {
      console.error('❌ Auditoría de datos de course_blueprints FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    console.log('✅ Auditoría de datos de course_blueprints: todos los invariantes se cumplen.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
