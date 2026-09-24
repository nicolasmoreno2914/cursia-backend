#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// Mismos guardarraíles que verify-generation-manifests-schema.js — este
// script también se conecta a una base real (deploy-staging.yml lo corre
// justo después de la migración de Fase 5A). Ver migrate-dynamic-course-structure.js
// para la explicación completa de por qué es lista negra.
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — este verificador es para el entorno de\n' +
      '   staging únicamente (spec: 2026-09-24-dynamic-course-structure-fase5-generation-design).\n' +
      '   deploy-staging.yml lo setea automáticamente; si lo corrés a mano contra\n' +
      '   staging, usá: MIGRATION_ENV=staging node scripts/verify-dynamic-generation-schema.js'
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
  generation_item_runs: [
    'id', 'job_id', 'course_id', 'blueprint_id', 'manifest_id', 'item_key',
    'generation', 'type', 'module_id', 'chapter_id', 'depends_on', 'status',
    'worker_id', 'lease_until', 'claimed_at', 'attempt_count', 'max_attempts',
    'next_retry_at', 'error', 'idempotency_key', 'output_summary',
    'created_at', 'updated_at', 'finished_at',
  ],
  generation_run_contexts: ['job_id', 'manifest_id', 'context', 'context_hash', 'created_at'],
};

const EXPECTED_CONSTRAINTS = [
  { conname: 'gir_blueprint_fk', contype: 'f' },
  { conname: 'gir_item_generation_key', contype: 'u' },
  { conname: 'gir_idempotency_key', contype: 'u' },
  { conname: 'gir_chapter_scope', contype: 'c' },
  { conname: 'artifacts_manifest_id_fk', contype: 'f' },
  { conname: 'artifacts_item_run_id_fk', contype: 'f' },
];

async function tableColumns(client, table) {
  const res = await client.query(
    `select column_name from information_schema.columns where table_schema='public' and table_name=$1`,
    [table],
  );
  return res.rows.map((r) => r.column_name);
}

function idempotencyKey(manifestId, itemKey, generation) {
  return crypto.createHash('sha256').update(`${manifestId}:${itemKey}:${generation}`).digest('hex');
}

function validSnapshotJson({ courseId, moduleId, chapterId }) {
  return {
    schemaVersion: 1,
    course: { id: courseId, title: 'curso temporal', structureVersion: 'dynamic' },
    modules: [
      {
        id: moduleId, position: 0, title: 'Módulo 1', objective: 'objetivo', examEnabled: false,
        chapters: [{ id: chapterId, position: 0, title: 'Capítulo 1', objective: 'objetivo', videoEnabled: false }],
      },
    ],
  };
}

function validManifestJson({ courseId, blueprintId, blueprintSha256, moduleId, chapterId }) {
  return {
    manifestSchemaVersion: 1,
    rulesVersion: 1,
    source: { courseId, blueprintId, blueprintNumber: 1, blueprintSha256 },
    modules: [
      { moduleId, position: 0, moduleNumber: 1, examEnabled: false,
        chapters: [{ chapterId, position: 0, chapterNumber: 1, videoEnabled: false }] },
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
    // 1. Tablas nuevas y sus columnas.
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

    // 1b. Columnas nuevas de artifacts.
    const artifactCols = await tableColumns(client, 'artifacts');
    for (const col of ['manifest_id', 'manifest_item_key', 'item_run_id']) {
      if (!artifactCols.includes(col)) failures.push(`Tabla "artifacts" no tiene la columna "${col}".`);
    }

    // 2. Constraints con nombre.
    for (const exp of EXPECTED_CONSTRAINTS) {
      const res = await client.query(`select contype from pg_constraint where conname = $1`, [exp.conname]);
      if (res.rows.length === 0) {
        failures.push(`Falta el constraint "${exp.conname}".`);
      } else if (res.rows[0].contype !== exp.contype) {
        failures.push(`Constraint "${exp.conname}" tiene contype="${res.rows[0].contype}", esperado "${exp.contype}".`);
      }
    }

    // 3. Trigger de inmutabilidad presente.
    const trig = await client.query(
      `select t.tgname from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
        where c.relname = 'generation_run_contexts' and t.tgname = 'generation_run_contexts_immutable' and not t.tgisinternal`,
    );
    if (trig.rows.length === 0) failures.push('Falta el trigger "generation_run_contexts_immutable" en generation_run_contexts.');

    // 3b. Índice parcial único presente.
    const idx = await client.query(
      `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'production_jobs' and indexname = 'uq_dynamic_generation_active_run'`,
    );
    if (idx.rows.length === 0) {
      failures.push('Falta el índice "uq_dynamic_generation_active_run" en production_jobs.');
    } else if (!/unique/i.test(idx.rows[0].indexdef)) {
      failures.push(`Índice "uq_dynamic_generation_active_run" no es UNIQUE (indexdef: ${idx.rows[0].indexdef}).`);
    }

    if (failures.length > 0) {
      console.error('❌ Verificación de esquema FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    // 4. Comportamiento real, en una transacción SIEMPRE revertida (finally →
    // rollback). Se usan SAVEPOINTs para que un error esperado no aborte el
    // resto de los checks. Nunca se asume que haya datos preexistentes.
    await client.query('begin');
    try {
      const course = await client.query(
        `insert into public.courses (title, structure_version) values ($1, 'dynamic') returning id`,
        ['[verify-dynamic-generation] curso temporal (borrar)'],
      );
      const courseId = course.rows[0].id;

      const courseOther = await client.query(
        `insert into public.courses (title, structure_version) values ($1, 'dynamic') returning id`,
        ['[verify-dynamic-generation] curso temporal B (borrar)'],
      );
      const courseOtherId = courseOther.rows[0].id;

      const moduleId = '00000000-0000-0000-0000-0000000000a1';
      const chapterId = '00000000-0000-0000-0000-0000000000a2';
      const blueprintSha256 = 'a'.repeat(64);
      const blueprintShaOther = 'b'.repeat(64);

      const blueprint = await client.query(
        `insert into public.course_blueprints
           (course_id, blueprint_number, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, $2::jsonb, $3, 0, 1, 1)
         returning id`,
        [courseId, JSON.stringify(validSnapshotJson({ courseId, moduleId, chapterId })), blueprintSha256],
      );
      const blueprintId = blueprint.rows[0].id;

      // Blueprint de OTRO curso — usado para probar la FK compuesta cruzada.
      const blueprintOther = await client.query(
        `insert into public.course_blueprints
           (course_id, blueprint_number, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, $2::jsonb, $3, 0, 1, 1)
         returning id`,
        [courseOtherId, JSON.stringify(validSnapshotJson({ courseId: courseOtherId, moduleId, chapterId })), blueprintShaOther],
      );
      const blueprintOtherId = blueprintOther.rows[0].id;

      const manifestJson = validManifestJson({ courseId, blueprintId, blueprintSha256, moduleId, chapterId });
      const manifest = await client.query(
        `insert into public.course_generation_manifests
           (course_id, blueprint_id, rules_version, manifest_json, manifest_sha256, blueprint_sha256,
            module_count, chapter_count, content_count, scorm_count, video_count, exam_count, total_jobs)
         values ($1, $2, 1, $3::jsonb, $4, $5, 1, 1, 1, 1, 0, 0, 2)
         returning id`,
        [courseId, blueprintId, JSON.stringify(manifestJson), 'c'.repeat(64), blueprintSha256],
      );
      const manifestId = manifest.rows[0].id;

      // production_job "run" válido (execution_mode='dynamic_generation'),
      // nunca usa lease_until/worker_id (quedan NULL — lección Fase 5A: el
      // reaper legacy solo mira lease_until IS NOT NULL).
      const ownerId = '11111111-1111-1111-1111-111111111111';
      async function insertRunJob(inputManifestId, workerStatus, executionMode = 'dynamic_generation') {
        const res = await client.query(
          `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, input_payload)
           values ($1, $2, $3, 'queued', $4, $5::jsonb)
           returning id`,
          [ownerId, courseId, executionMode, workerStatus, JSON.stringify({ manifestId: String(inputManifestId) })],
        );
        return res.rows[0].id;
      }

      const jobId = await insertRunJob(manifestId, 'queued');

      // 4a. Insert válido de generation_item_runs debe funcionar.
      const itemKey = `content:${chapterId}`;
      let itemRunId = null;
      try {
        const res = await client.query(
          `insert into public.generation_item_runs
             (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key)
           values ($1, $2, $3, $4, $5, 1, 'content', $6, $7, '{}', $8)
           returning id`,
          [jobId, courseId, blueprintId, manifestId, itemKey, moduleId, chapterId, idempotencyKey(manifestId, itemKey, 1)],
        );
        itemRunId = res.rows[0].id;
      } catch (e) {
        failures.push(`Insert válido de generation_item_runs falló inesperadamente: ${e.message} (código: ${e.code || 'ninguno'}).`);
      }

      // 4b. generation_run_contexts válido + UPDATE → P0001.
      let contextInserted = false;
      try {
        await client.query(
          `insert into public.generation_run_contexts (job_id, manifest_id, context, context_hash)
           values ($1, $2, $3::jsonb, $4)`,
          [jobId, manifestId, JSON.stringify({ nombre: 'curso temporal', pais: 'AR' }), 'd'.repeat(64)],
        );
        contextInserted = true;
      } catch (e) {
        failures.push(`Insert válido de generation_run_contexts falló inesperadamente: ${e.message} (código: ${e.code || 'ninguno'}).`);
      }

      if (contextInserted) {
        await client.query('savepoint sp_context_immutable');
        let rejected = false;
        let code = null;
        try {
          await client.query(`update public.generation_run_contexts set context_hash = $1 where job_id = $2`, ['e'.repeat(64), jobId]);
        } catch (e) {
          code = e.code;
          rejected = e.code === 'P0001';
        } finally {
          await client.query('rollback to savepoint sp_context_immutable');
        }
        if (!rejected) {
          failures.push(`UPDATE sobre generation_run_contexts NO fue rechazado con P0001 (código real: ${code || 'ninguno — se permitió el UPDATE'}).`);
        }
      }

      if (itemRunId !== null) {
        // 4c. FK: job_id inexistente → 23503.
        await client.query('savepoint sp_fk_job');
        let fkJobRejected = false, fkJobCode = null;
        try {
          await client.query(
            `insert into public.generation_item_runs
               (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key)
             values ($1, $2, $3, $4, $5, 1, 'content', $6, $7, '{}', $8)`,
            ['99999999-9999-9999-9999-999999999999', courseId, blueprintId, manifestId, `content-fk-test:${chapterId}`, moduleId, chapterId, idempotencyKey(manifestId, 'content-fk-test', 1)],
          );
        } catch (e) {
          fkJobCode = e.code;
          fkJobRejected = e.code === '23503';
        } finally {
          await client.query('rollback to savepoint sp_fk_job');
        }
        if (!fkJobRejected) {
          failures.push(`Insertar generation_item_runs con job_id inexistente NO fue rechazado con 23503 (código real: ${fkJobCode || 'ninguno — se insertó'}).`);
        }

        // 4d. gir_blueprint_fk cruzado: blueprint de otro curso con course_id
        // de este curso → 23503.
        await client.query('savepoint sp_fk_blueprint_cross');
        let fkBpRejected = false, fkBpCode = null;
        try {
          await client.query(
            `insert into public.generation_item_runs
               (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key)
             values ($1, $2, $3, $4, $5, 1, 'content', $6, $7, '{}', $8)`,
            [jobId, courseId, blueprintOtherId, manifestId, `content-fk-bp-test:${chapterId}`, moduleId, chapterId, idempotencyKey(manifestId, 'content-fk-bp-test', 1)],
          );
        } catch (e) {
          fkBpCode = e.code;
          fkBpRejected = e.code === '23503';
        } finally {
          await client.query('rollback to savepoint sp_fk_blueprint_cross');
        }
        if (!fkBpRejected) {
          failures.push(`Insertar generation_item_runs con blueprint de OTRO curso NO fue rechazado con 23503 (código real: ${fkBpCode || 'ninguno — se insertó'}).`);
        }

        // 4e. UNIQUE(manifest_id, item_key, generation) → 23505.
        await client.query('savepoint sp_unique_item');
        let dupItemRejected = false, dupItemCode = null;
        try {
          await client.query(
            `insert into public.generation_item_runs
               (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key)
             values ($1, $2, $3, $4, $5, 1, 'content', $6, $7, '{}', $8)`,
            [jobId, courseId, blueprintId, manifestId, itemKey, moduleId, chapterId, idempotencyKey(manifestId, itemKey, 999)],
          );
        } catch (e) {
          dupItemCode = e.code;
          dupItemRejected = e.code === '23505';
        } finally {
          await client.query('rollback to savepoint sp_unique_item');
        }
        if (!dupItemRejected) {
          failures.push(`Insertar un item run duplicado (manifest_id, item_key, generation) NO fue rechazado con 23505 (código real: ${dupItemCode || 'ninguno — se insertó'}).`);
        }

        // 4f. UNIQUE(idempotency_key) → 23505.
        await client.query('savepoint sp_unique_idem');
        let dupIdemRejected = false, dupIdemCode = null;
        try {
          await client.query(
            `insert into public.generation_item_runs
               (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key)
             values ($1, $2, $3, $4, $5, 1, 'scorm', $6, $7, '{}', $8)`,
            [jobId, courseId, blueprintId, manifestId, `scorm:${chapterId}`, moduleId, chapterId, idempotencyKey(manifestId, itemKey, 1)],
          );
        } catch (e) {
          dupIdemCode = e.code;
          dupIdemRejected = e.code === '23505';
        } finally {
          await client.query('rollback to savepoint sp_unique_idem');
        }
        if (!dupIdemRejected) {
          failures.push(`Insertar un item run con idempotency_key duplicado NO fue rechazado con 23505 (código real: ${dupIdemCode || 'ninguno — se insertó'}).`);
        }

        // 4g. gir_chapter_scope CHECK: type='exam' con chapter_id no nulo → 23514.
        await client.query('savepoint sp_check_scope_exam');
        let scopeExamRejected = false, scopeExamCode = null;
        try {
          await client.query(
            `insert into public.generation_item_runs
               (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key)
             values ($1, $2, $3, $4, $5, 1, 'exam', $6, $7, '{}', $8)`,
            [jobId, courseId, blueprintId, manifestId, `exam-bad:${chapterId}`, moduleId, chapterId, idempotencyKey(manifestId, 'exam-bad', 1)],
          );
        } catch (e) {
          scopeExamCode = e.code;
          scopeExamRejected = e.code === '23514';
        } finally {
          await client.query('rollback to savepoint sp_check_scope_exam');
        }
        if (!scopeExamRejected) {
          failures.push(`Insertar item exam con chapter_id no nulo NO fue rechazado con 23514 (código real: ${scopeExamCode || 'ninguno — se insertó'}).`);
        }

        // 4h. gir_chapter_scope CHECK: type='content' con chapter_id nulo → 23514.
        await client.query('savepoint sp_check_scope_content');
        let scopeContentRejected = false, scopeContentCode = null;
        try {
          await client.query(
            `insert into public.generation_item_runs
               (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key)
             values ($1, $2, $3, $4, $5, 1, 'content', $6, null, '{}', $7)`,
            [jobId, courseId, blueprintId, manifestId, 'content-bad', moduleId, idempotencyKey(manifestId, 'content-bad', 1)],
          );
        } catch (e) {
          scopeContentCode = e.code;
          scopeContentRejected = e.code === '23514';
        } finally {
          await client.query('rollback to savepoint sp_check_scope_content');
        }
        if (!scopeContentRejected) {
          failures.push(`Insertar item content con chapter_id nulo NO fue rechazado con 23514 (código real: ${scopeContentCode || 'ninguno — se insertó'}).`);
        }

        // 4i. status CHECK: valor fuera del set permitido → 23514.
        await client.query('savepoint sp_check_status');
        let statusRejected = false, statusCode = null;
        try {
          await client.query(
            `insert into public.generation_item_runs
               (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key, status)
             values ($1, $2, $3, $4, $5, 1, 'content', $6, $7, '{}', $8, 'succeeded')`,
            [jobId, courseId, blueprintId, manifestId, 'content-status-bad', moduleId, chapterId, idempotencyKey(manifestId, 'content-status-bad', 1)],
          );
        } catch (e) {
          statusCode = e.code;
          statusRejected = e.code === '23514';
        } finally {
          await client.query('rollback to savepoint sp_check_status');
        }
        if (!statusRejected) {
          failures.push(`Insertar item run con status='succeeded' (fuera del set válido) NO fue rechazado con 23514 (código real: ${statusCode || 'ninguno — se insertó'}).`);
        }
      }

      // 4j. Índice parcial: dos runs activos del mismo Manifest → 23505.
      await client.query('savepoint sp_active_run_conflict');
      let secondRunRejected = false, secondRunCode = null;
      try {
        await insertRunJob(manifestId, 'running');
      } catch (e) {
        secondRunCode = e.code;
        secondRunRejected = e.code === '23505';
      } finally {
        await client.query('rollback to savepoint sp_active_run_conflict');
      }
      if (!secondRunRejected) {
        failures.push(`Insertar un segundo run dynamic_generation activo para el mismo Manifest NO fue rechazado con 23505 (código real: ${secondRunCode || 'ninguno — se insertó'}).`);
      }

      // 4k. Un run nuevo SÍ debe permitirse una vez que el primero es
      // terminal (worker_status='completed' no está en el set del índice).
      await client.query('savepoint sp_active_run_after_terminal');
      let terminalThenNewOk = false;
      let terminalThenNewError = null;
      try {
        await client.query(`update public.production_jobs set worker_status = 'completed' where id = $1`, [jobId]);
        await insertRunJob(manifestId, 'queued');
        terminalThenNewOk = true;
      } catch (e) {
        terminalThenNewError = e.message + ' (código: ' + (e.code || 'ninguno') + ')';
      } finally {
        await client.query('rollback to savepoint sp_active_run_after_terminal');
      }
      if (!terminalThenNewOk) {
        failures.push(`Un nuevo run dynamic_generation para el mismo Manifest, tras marcar el anterior worker_status='completed', debería permitirse y NO lo hizo: ${terminalThenNewError}`);
      }

      // 4l. Un production_job de OTRO execution_mode con el mismo manifestId
      // en input_payload NO debe verse afectado por el índice parcial.
      await client.query('savepoint sp_other_execution_mode');
      let otherModeOk = false;
      let otherModeError = null;
      try {
        await insertRunJob(manifestId, 'running', 'backend_content');
        otherModeOk = true;
      } catch (e) {
        otherModeError = e.message + ' (código: ' + (e.code || 'ninguno') + ')';
      } finally {
        await client.query('rollback to savepoint sp_other_execution_mode');
      }
      if (!otherModeOk) {
        failures.push(`Un production_job de execution_mode='backend_content' con el mismo manifestId NO debería verse afectado por el índice parcial y falló: ${otherModeError}`);
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

    console.log('✅ Esquema de generation_item_runs/generation_run_contexts verificado correctamente (ref de proyecto:', extractSupabaseProjectRef(), ')');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
