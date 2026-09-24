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

// Mismos guardarraíles que audit-course-blueprints.js — este script también
// se conecta a una base real (deploy-staging.yml lo corre justo después de la
// verificación de esquema de Fase 4), así que necesita la misma protección.
// Ver migrate-dynamic-course-structure.js para la explicación completa de por
// qué es lista negra (ref de producción conocido) y no lista blanca (ref de
// staging sin confirmar para el backend).
//
// Ruling R1 (controller): este es un archivo NUEVO — no se toca
// audit-course-blueprints.js, ya revisado.
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — este auditor es de solo lectura pero\n' +
      '   está pensado exclusivamente para el entorno de staging (spec:\n' +
      '   2026-09-24-dynamic-course-structure-fase4-manifest). deploy-staging.yml\n' +
      '   lo setea automáticamente; si lo corrés a mano contra staging, usá:\n' +
      '   MIGRATION_ENV=staging node scripts/audit-generation-manifests.js'
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

// Busca un capítulo/módulo dentro del snapshot del Blueprint (nunca la
// estructura viva — el Manifest solo se compara contra lo que el Blueprint
// congeló).
function findChapterInSnapshot(snapshotJson, moduleId, chapterId) {
  const modules = Array.isArray(snapshotJson && snapshotJson.modules) ? snapshotJson.modules : [];
  const mod = modules.find((m) => m && m.id === moduleId);
  if (!mod) return null;
  const chapters = Array.isArray(mod.chapters) ? mod.chapters : [];
  return chapters.find((c) => c && c.id === chapterId) || null;
}

function findModuleInSnapshot(snapshotJson, moduleId) {
  const modules = Array.isArray(snapshotJson && snapshotJson.modules) ? snapshotJson.modules : [];
  return modules.find((m) => m && m.id === moduleId) || null;
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
    console.log('=== 1. Conteos ===');

    const manifestCount = await client.query(`select count(*)::int as n from public.course_generation_manifests`);
    const totalManifests = manifestCount.rows[0].n;
    console.log(`course_generation_manifests: ${totalManifests} filas totales.`);

    if (totalManifests === 0) {
      console.log('');
      console.log('(sin Manifests todavía — nada más que auditar; se considera pasado)');
      console.log('');
      console.log('✅ Auditoría de datos de course_generation_manifests: todos los invariantes se cumplen (tabla vacía).');
      return;
    }

    console.log('');
    console.log('=== 2. Manifests (hasta 10 más recientes, por created_at desc) ===');

    const recent = await client.query(
      `select id, course_id, blueprint_id, rules_version, manifest_schema_version, created_at, total_jobs, manifest_sha256
         from public.course_generation_manifests
        order by created_at desc, id desc
        limit 10`,
    );
    for (const row of recent.rows) {
      console.log(
        `id=${row.id} course_id=${row.course_id} blueprint_id=${row.blueprint_id} ` +
        `rules_version=${row.rules_version} manifest_schema_version=${row.manifest_schema_version} ` +
        `created_at=${new Date(row.created_at).toISOString()} total_jobs=${row.total_jobs} ` +
        `sha256[:12]=${shortSha(row.manifest_sha256)}`,
      );
    }

    console.log('');
    console.log('=== 3. Invariantes (sobre TODOS los Manifests, no solo los recientes) ===');

    // Se trae manifest_json completo + el snapshot_json del Blueprint referenciado
    // (mismo curso, por la FK compuesta) para poder validar video/exam contra
    // videoEnabled/examEnabled — nunca contra la estructura viva.
    const all = await client.query(
      `select
          cgm.id, cgm.course_id, cgm.blueprint_id, cgm.rules_version, cgm.manifest_json,
          cgm.manifest_sha256, cgm.blueprint_sha256,
          cgm.module_count, cgm.chapter_count, cgm.content_count, cgm.scorm_count,
          cgm.video_count, cgm.exam_count, cgm.total_jobs,
          cb.snapshot_sha256 as blueprint_snapshot_sha256,
          cb.snapshot_json   as blueprint_snapshot_json
        from public.course_generation_manifests cgm
        left join public.course_blueprints cb
          on cb.id = cgm.blueprint_id and cb.course_id = cgm.course_id
       order by cgm.id`,
    );

    let checkedSourceIdentity = 0;
    let checkedBlueprintSha = 0;
    let checkedItemCount = 0;
    let checkedTypeCounts = 0;
    let checkedVideoInvariant = 0;
    let checkedExamInvariant = 0;

    for (const row of all.rows) {
      const label = `Manifest id=${row.id} (course_id=${row.course_id}, blueprint_id=${row.blueprint_id})`;

      if (row.blueprint_snapshot_json === null) {
        failures.push(`${label}: no se encontró el Blueprint referenciado (blueprint_id=${row.blueprint_id}, course_id=${row.course_id}) — la FK compuesta debería impedir esto.`);
        continue;
      }

      const manifest = row.manifest_json;
      const source = manifest && manifest.source;
      const items = Array.isArray(manifest && manifest.items) ? manifest.items : null;

      if (!source || typeof source !== 'object') {
        failures.push(`${label}: manifest_json.source ausente o inválido.`);
        continue;
      }
      if (!items) {
        failures.push(`${label}: manifest_json.items ausente o no es un array.`);
        continue;
      }

      // 3a. source.blueprintId/courseId = columnas.
      checkedSourceIdentity += 1;
      if (source.blueprintId !== row.blueprint_id) {
        failures.push(`${label}: manifest_json.source.blueprintId=${source.blueprintId} no coincide con la columna blueprint_id=${row.blueprint_id}.`);
      }
      if (source.courseId !== row.course_id) {
        failures.push(`${label}: manifest_json.source.courseId=${source.courseId} no coincide con la columna course_id=${row.course_id}.`);
      }

      // 3b. source.blueprintSha256 = course_blueprints.snapshot_sha256 (columna
      // blueprint_sha256 también debe coincidir con el Blueprint real).
      checkedBlueprintSha += 1;
      if (source.blueprintSha256 !== row.blueprint_snapshot_sha256) {
        failures.push(`${label}: manifest_json.source.blueprintSha256[:12]=${shortSha(source.blueprintSha256)} no coincide con course_blueprints.snapshot_sha256[:12]=${shortSha(row.blueprint_snapshot_sha256)}.`);
      }
      if (row.blueprint_sha256 !== row.blueprint_snapshot_sha256) {
        failures.push(`${label}: columna blueprint_sha256[:12]=${shortSha(row.blueprint_sha256)} no coincide con course_blueprints.snapshot_sha256[:12]=${shortSha(row.blueprint_snapshot_sha256)}.`);
      }

      // 3c. jsonb_array_length(items) = total_jobs.
      checkedItemCount += 1;
      if (items.length !== row.total_jobs) {
        failures.push(`${label}: items.length=${items.length} no coincide con la columna total_jobs=${row.total_jobs}.`);
      }

      // 3d. Conteos por type en items = columnas.
      checkedTypeCounts += 1;
      const byType = { content: 0, scorm: 0, video: 0, exam: 0 };
      for (const item of items) {
        if (item && Object.prototype.hasOwnProperty.call(byType, item.type)) {
          byType[item.type] += 1;
        } else {
          failures.push(`${label}: item con type desconocido/ausente: ${JSON.stringify(item && item.key)}.`);
        }
      }
      if (byType.content !== row.content_count) failures.push(`${label}: items de type=content (${byType.content}) no coincide con content_count=${row.content_count}.`);
      if (byType.scorm !== row.scorm_count) failures.push(`${label}: items de type=scorm (${byType.scorm}) no coincide con scorm_count=${row.scorm_count}.`);
      if (byType.video !== row.video_count) failures.push(`${label}: items de type=video (${byType.video}) no coincide con video_count=${row.video_count}.`);
      if (byType.exam !== row.exam_count) failures.push(`${label}: items de type=exam (${byType.exam}) no coincide con exam_count=${row.exam_count}.`);

      // 3e. Ningún item video cuyo chapterId tenga videoEnabled=false en el
      // snapshot del Blueprint (y el capítulo debe existir en el snapshot).
      checkedVideoInvariant += 1;
      for (const item of items) {
        if (!item || item.type !== 'video') continue;
        const chapter = findChapterInSnapshot(row.blueprint_snapshot_json, item.moduleId, item.chapterId);
        if (!chapter) {
          failures.push(`${label}: item video key=${item.key} referencia un capítulo inexistente en el snapshot del Blueprint (moduleId=${item.moduleId}, chapterId=${item.chapterId}).`);
        } else if (chapter.videoEnabled !== true) {
          failures.push(`${label}: item video key=${item.key} existe pero el capítulo tiene videoEnabled=false en el snapshot del Blueprint.`);
        }
      }

      // 3f. Ningún item exam de un módulo con examEnabled=false en el
      // snapshot del Blueprint.
      checkedExamInvariant += 1;
      for (const item of items) {
        if (!item || item.type !== 'exam') continue;
        const mod = findModuleInSnapshot(row.blueprint_snapshot_json, item.moduleId);
        if (!mod) {
          failures.push(`${label}: item exam key=${item.key} referencia un módulo inexistente en el snapshot del Blueprint (moduleId=${item.moduleId}).`);
        } else if (mod.examEnabled !== true) {
          failures.push(`${label}: item exam key=${item.key} existe pero el módulo tiene examEnabled=false en el snapshot del Blueprint.`);
        }
      }
    }

    if (failures.length === 0) {
      console.log(`✅ (a) source.blueprintId/courseId consistentes con las columnas (${checkedSourceIdentity} Manifests revisados).`);
      console.log(`✅ (b) source.blueprintSha256 = course_blueprints.snapshot_sha256 (${checkedBlueprintSha} Manifests revisados).`);
      console.log(`✅ (c) jsonb_array_length(items) = total_jobs (${checkedItemCount} Manifests revisados).`);
      console.log(`✅ (d) conteos por type en items = columnas (${checkedTypeCounts} Manifests revisados).`);
      console.log(`✅ (e) ningún item video para capítulo con videoEnabled=false (${checkedVideoInvariant} Manifests revisados).`);
      console.log(`✅ (f) ningún item exam para módulo con examEnabled=false (${checkedExamInvariant} Manifests revisados).`);
    } else {
      console.log(`❌ ${failures.length} violaciones de invariantes encontradas (detalle abajo).`);
    }

    // 3g. Inmutabilidad sobre datos reales — UPDATE real sobre el Manifest más
    // reciente, en savepoint dentro de una transacción siempre revertida. Un
    // UPDATE que no afecta ninguna fila (borrada entre el SELECT y el UPDATE)
    // cuenta como "⚠️ omitido", nunca como ❌ — lección de la ronda de
    // revisión de Fase 3: un 0-row UPDATE no es evidencia de que el trigger
    // falle.
    console.log('');
    await client.query('begin');
    try {
      const latest = await client.query(
        `select id from public.course_generation_manifests order by created_at desc, id desc limit 1`,
      );

      if (latest.rows.length === 0) {
        console.log('⚠️  (g) omitido — no hay Manifests reales (se borraron entre el conteo inicial y este punto).');
      } else {
        const latestId = latest.rows[0].id;

        await client.query('savepoint s1');
        let immutableRejected = false;
        let immutableCode = null;
        let immutableRowCount = null;
        try {
          const res = await client.query(
            `update public.course_generation_manifests set total_jobs = total_jobs where id = $1`,
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
          console.log(`✅ (g) UPDATE sobre course_generation_manifests (id=${latestId}) rechazado con P0001.`);
        } else if (immutableRowCount === 0) {
          console.log(
            `⚠️  (g) omitido (fila ya no existe) — el UPDATE sobre course_generation_manifests (id=${latestId}) ` +
            `no afectó ninguna fila (borrada entre el SELECT y el UPDATE).`,
          );
        } else {
          console.log(
            `❌ (g) UPDATE sobre course_generation_manifests (id=${latestId}) NO fue rechazado con P0001 ` +
            `(código real: ${immutableCode || 'ninguno — se permitió el UPDATE'}).`,
          );
          failures.push('El trigger de inmutabilidad no rechazó un UPDATE real sobre course_generation_manifests.');
        }
      }
    } finally {
      await client.query('rollback'); // nunca deja basura, sea cual sea el resultado
    }

    console.log('');
    if (failures.length > 0) {
      console.error('❌ Auditoría de datos de course_generation_manifests FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    console.log('✅ Auditoría de datos de course_generation_manifests: todos los invariantes se cumplen.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
