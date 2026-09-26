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

// Cursia V2.1 — R4: verificador del esquema de
// supabase-migration-v21-manifest-v3.sql. Mismos guardarraíles que la
// migración. La sonda de comportamiento escribe SOLO dentro de una
// transacción que siempre se revierte.
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
      '   staging, usá: MIGRATION_ENV=staging node scripts/verify-v21-manifest-v3-schema.js'
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


const V3_TYPES = ['experience', 'presentation', 'video_interactions', 'activity', 'audiobook_chapter', 'audio_welcome', 'final_exam'];
const V3_COUNT_COLUMNS = ['experience_count', 'presentation_count', 'video_interactions_count', 'activity_count',
  'audiobook_chapter_count', 'audio_welcome_count', 'final_exam_count'];

async function constraintDef(client, table, conname) {
  const r = await client.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1 and conrelid = $2::regclass`,
    [conname, `public.${table}`],
  );
  return r.rows[0] ? r.rows[0].def : null;
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
    ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  const failures = [];
  try {
    // 1. Catálogo.
    const typeDef = await constraintDef(client, 'generation_item_runs', 'gir_type_check');
    for (const t of V3_TYPES) {
      if (!typeDef || !typeDef.includes(`'${t}'`)) failures.push(`gir_type_check no incluye el tipo v3 '${t}'.`);
    }
    const scopeDef = await constraintDef(client, 'generation_item_runs', 'gir_type_scope');
    if (!scopeDef || !scopeDef.includes('audio_welcome') || !scopeDef.includes('final_exam')) {
      failures.push('gir_type_scope no clasifica audio_welcome/final_exam (scope course).');
    }
    const fnSrc = await client.query(`select prosrc from pg_proc where proname = 'generation_item_runs_default_scope'`);
    if (!fnSrc.rows[0] || !/final_exam/.test(fnSrc.rows[0].prosrc)) {
      failures.push('generation_item_runs_default_scope() no deriva scope course para audio_welcome/final_exam.');
    }
    const cols = await client.query(
      `select column_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'course_generation_manifests'`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    for (const c of V3_COUNT_COLUMNS) {
      const col = byName[c];
      if (!col) failures.push(`course_generation_manifests no tiene la columna v3 "${c}".`);
      else if (col.is_nullable !== 'NO' || !/^0$/.test(String(col.column_default))) {
        failures.push(`course_generation_manifests.${c} debería ser NOT NULL DEFAULT 0 (nullable=${col.is_nullable}, default=${col.column_default}).`);
      }
    }
    if (!(await constraintDef(client, 'course_generation_manifests', 'cgm_scorm_count_nonneg'))) {
      failures.push('Falta cgm_scorm_count_nonneg (scorm_count >= 0).');
    }
    const cgm = await constraintDef(client, 'course_generation_manifests', 'cgm_counts_consistent');
    if (!cgm || !cgm.includes('audiobook_chapter_count') || !cgm.includes('module_intro_count')) {
      failures.push('cgm_counts_consistent no incluye los conteos v2 + v3.');
    }
    if (failures.length > 0) {
      console.error('❌ Verificación de esquema V2.1 R4 FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    // 2. Comportamiento, en una transacción SIEMPRE revertida.
    await client.query('begin');
    try {
      const probe = await probeBehaviour(client);
      failures.push(...probe);
    } finally {
      await client.query('rollback');
    }
    if (failures.length > 0) {
      console.error('❌ Sonda de comportamiento V2.1 R4 FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }
    console.log('✅ Esquema V2.1 R4 (Manifest rulesVersion 3) verificado (ref de proyecto:', extractSupabaseProjectRef(), ')');
  } finally {
    await client.end();
  }
}

async function expectCode(client, sp, sql, params, code, label, failures) {
  await client.query(`savepoint ${sp}`);
  try {
    await client.query(sql, params);
    failures.push(`${label}: se esperaba el error ${code} y la sentencia pasó.`);
  } catch (err) {
    if (err.code !== code) failures.push(`${label}: código ${err.code || 'ninguno'} (${err.message}), esperado ${code}.`);
  } finally {
    await client.query(`rollback to savepoint ${sp}`);
  }
}

/**
 * Inserta (dentro de la transacción del caller) un curso, un Blueprint, un
 * Manifest rulesVersion 3 con conteos consistentes y items de cada tipo v3;
 * comprueba el scope derivado y que los CHECKs rechacen conteos v3 inválidos.
 * Exportada para el check local (check-v21-manifest-v3.js).
 */
async function probeBehaviour(client) {
  const failures = [];
  const course = await client.query(
    `insert into public.courses (title, structure_version) values ($1, 'dynamic') returning id`,
    ['[verify-v21-manifest-v3] curso temporal (borrar)'],
  );
  const courseId = course.rows[0].id;
  const moduleId = '00000000-0000-0000-0000-0000000004a1';
  const chapterId = '00000000-0000-0000-0000-0000000004a2';
  const bp = await client.query(
    `insert into public.course_blueprints
       (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
     values ($1, 1, 2, '{}'::jsonb, $2, 0, 1, 1) returning id`,
    [courseId, 'd'.repeat(64)],
  );
  const blueprintId = bp.rows[0].id;
  // 1 módulo (examen ON), 1 capítulo (video ON, actividad ON), final ON:
  // plan+intro+audio_welcome+module_intro+content+experience+presentation+video+
  // video_interactions+activity+audiobook+exam+final_exam = 13.
  const insertManifest = (rv, counts) => client.query(
    `insert into public.course_generation_manifests
       (course_id, blueprint_id, rules_version, manifest_json, manifest_sha256, blueprint_sha256,
        module_count, chapter_count, content_count, scorm_count, video_count, exam_count, total_jobs,
        course_plan_count, course_intro_count, module_intro_count,
        experience_count, presentation_count, video_interactions_count, activity_count,
        audiobook_chapter_count, audio_welcome_count, final_exam_count)
     values ($1, $2, $3, '{}'::jsonb, $4, $5, 1, 1, 1, $6, 1, 1, $7, 1, 1, 1, $8, 1, 1, 1, 1, 1, 1)
     returning id`,
    [courseId, blueprintId, rv, counts.sha, 'd'.repeat(64), counts.scorm, counts.total, counts.experience],
  );
  let manifestId = null;
  try {
    manifestId = (await insertManifest(3, { sha: 'e'.repeat(64), scorm: 0, total: 13, experience: 1 })).rows[0].id;
  } catch (err) {
    failures.push(`Insert de un Manifest rulesVersion 3 consistente falló: ${err.message} (código ${err.code || 'ninguno'}).`);
    return failures;
  }
  await expectCode(client, 'sp_v3_scorm', `insert into public.course_generation_manifests
       (course_id, blueprint_id, rules_version, manifest_json, manifest_sha256, blueprint_sha256,
        module_count, chapter_count, content_count, scorm_count, video_count, exam_count, total_jobs,
        course_plan_count, course_intro_count, module_intro_count, audio_welcome_count)
     values ($1, $2, 1, '{}'::jsonb, $3, $4, 1, 1, 1, 1, 0, 0, 2, 0, 0, 0, 1)`,
  [courseId, blueprintId, 'f'.repeat(64), 'd'.repeat(64)], '23514', 'Manifest v1 con audio_welcome_count=1', failures);
  const job = await client.query(
    `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, input_payload)
     values ($1, $2, 'dynamic_generation', 'queued', 'queued', $3::jsonb) returning id`,
    ['11111111-1111-1111-1111-111111111111', courseId, JSON.stringify({ manifestId: String(manifestId) })],
  );
  const jobId = job.rows[0].id;
  const items = [
    ['audio_welcome', null, null, 'course'],
    ['final_exam', null, null, 'course'],
    ['experience', moduleId, chapterId, 'chapter'],
    ['presentation', moduleId, chapterId, 'chapter'],
    ['video_interactions', moduleId, chapterId, 'chapter'],
    ['activity', moduleId, chapterId, 'chapter'],
    ['audiobook_chapter', moduleId, chapterId, 'chapter'],
  ];
  let n = 0;
  for (const [type, mid, cid, expectedScope] of items) {
    n += 1;
    const key = `${type}:${cid || courseId}`;
    try {
      const r = await client.query(
        `insert into public.generation_item_runs
           (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key)
         values ($1, $2, $3, $4, $5, 1, $6, $7, $8, '{}', $9) returning scope`,
        [jobId, courseId, blueprintId, manifestId, key, type, mid, cid, String(n).padStart(64, '0')],
      );
      if (r.rows[0].scope !== expectedScope) failures.push(`${type}: scope derivado ${r.rows[0].scope}, esperado ${expectedScope}.`);
    } catch (err) {
      failures.push(`Insert de generation_item_runs type=${type} falló: ${err.message} (código ${err.code || 'ninguno'}).`);
    }
  }
  await expectCode(client, 'sp_v3_scope', `insert into public.generation_item_runs
       (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key, scope)
     values ($1, $2, $3, $4, 'final_exam:x', 1, 'final_exam', $5, null, '{}', $6, 'module')`,
  [jobId, courseId, blueprintId, manifestId, moduleId, 'z'.repeat(64)], '23514', 'final_exam con scope module', failures);
  await expectCode(client, 'sp_v3_type', `insert into public.generation_item_runs
       (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key)
     values ($1, $2, $3, $4, 'bogus:x', 1, 'bogus', $5, $6, '{}', $7)`,
  [jobId, courseId, blueprintId, manifestId, moduleId, chapterId, 'y'.repeat(64)], '23514', 'type desconocido', failures);
  return failures;
}

module.exports = { probeBehaviour };

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error inesperado:', err.message);
    process.exitCode = 1;
  });
}
