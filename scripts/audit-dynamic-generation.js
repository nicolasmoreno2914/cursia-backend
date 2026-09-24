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

// Mismos guardarraíles que audit-generation-manifests.js — este script
// también se conecta a una base real (deploy-staging.yml lo corre justo
// después de la verificación de esquema de Fase 5A). Ver
// migrate-dynamic-course-structure.js para la explicación completa de por
// qué es lista negra.
//
// Este auditor es de SOLO LECTURA y audita únicamente invariantes
// ESTRUCTURALES (Manifest ↔ item run ↔ job ↔ contexto ↔ artifact) — nunca
// estado de ejecución (status/attempt_count/lease_until/etc no se validan
// acá, solo con Task 2).
function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — este auditor es de solo lectura pero\n' +
      '   está pensado exclusivamente para el entorno de staging (spec:\n' +
      '   2026-09-24-dynamic-course-structure-fase5-generation-design). deploy-staging.yml\n' +
      '   lo setea automáticamente; si lo corrés a mano contra staging, usá:\n' +
      '   MIGRATION_ENV=staging node scripts/audit-dynamic-generation.js'
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

// ── Forma canónica del contexto congelado (Task 2 DEBE usar exactamente esta
// misma forma al escribir generation_run_contexts.context_hash) ──
//
//   context_hash = sha256(JSON.stringify(sortKeysDeep(context))) en hex
//
// sortKeysDeep ordena las claves de cualquier objeto de forma recursiva
// (alfabético, vía Object.keys(...).sort()) y preserva el orden de los
// arrays tal cual vienen (el orden de un array es significativo — p.ej.
// dependsOn — y no se reordena). Esto hace que el hash sea estable sin
// importar en qué orden se construyó el objeto `context` en JS.
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalContextHash(context) {
  return crypto.createHash('sha256').update(JSON.stringify(sortKeysDeep(context))).digest('hex');
}

function idempotencyKey(manifestId, itemKey, generation) {
  return crypto.createHash('sha256').update(`${manifestId}:${itemKey}:${generation}`).digest('hex');
}

function arraysEqual(a, b) {
  const arrA = Array.isArray(a) ? a : [];
  const arrB = Array.isArray(b) ? b : [];
  if (arrA.length !== arrB.length) return false;
  return arrA.every((v, i) => v === arrB[i]);
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

    const runCount = await client.query(`select count(*)::int as n from public.generation_item_runs`);
    const totalRuns = runCount.rows[0].n;
    console.log(`generation_item_runs: ${totalRuns} filas totales.`);

    const ctxCount = await client.query(`select count(*)::int as n from public.generation_run_contexts`);
    console.log(`generation_run_contexts: ${ctxCount.rows[0].n} filas totales.`);

    const artifactCount = await client.query(
      `select count(*)::int as n from public.artifacts where manifest_item_key is not null`,
    );
    console.log(`artifacts con manifest_item_key: ${artifactCount.rows[0].n} filas totales.`);

    if (totalRuns === 0) {
      console.log('');
      console.log('(sin generation_item_runs todavía — nada más que auditar; se considera pasado)');
      console.log('');
      console.log('✅ Auditoría de dynamic-generation: todos los invariantes se cumplen (tabla vacía).');
      return;
    }

    console.log('');
    console.log('=== 2. Item runs (hasta 10 más recientes, por created_at desc) ===');
    const recent = await client.query(
      `select id, job_id, manifest_id, item_key, generation, type, status
         from public.generation_item_runs
        order by created_at desc, id desc
        limit 10`,
    );
    for (const row of recent.rows) {
      console.log(
        `id=${row.id} job_id=${row.job_id} manifest_id=${row.manifest_id} ` +
        `item_key=${row.item_key} generation=${row.generation} type=${row.type} status=${row.status}`,
      );
    }

    console.log('');
    console.log('=== 3. Invariantes estructurales (sobre TODAS las filas, no solo las recientes) ===');

    // 3a/3b/3c: cada item run contra su item de Manifest + idempotency_key.
    const runsWithManifest = await client.query(
      `select gir.id, gir.job_id, gir.manifest_id, gir.item_key, gir.generation, gir.type,
              gir.module_id, gir.chapter_id, gir.depends_on, gir.idempotency_key,
              cgm.manifest_json
         from public.generation_item_runs gir
         left join public.course_generation_manifests cgm on cgm.id = gir.manifest_id
        order by gir.id`,
    );

    let checkedItemMatch = 0;
    let checkedIdempotency = 0;

    for (const row of runsWithManifest.rows) {
      const label = `Item run id=${row.id} (manifest_id=${row.manifest_id}, item_key=${row.item_key}, generation=${row.generation})`;

      if (row.manifest_json === null) {
        failures.push(`${label}: no se encontró el Manifest referenciado (manifest_id=${row.manifest_id}) — la FK debería impedir esto.`);
        continue;
      }

      const items = Array.isArray(row.manifest_json.items) ? row.manifest_json.items : [];
      const item = items.find((it) => it && it.key === row.item_key);

      checkedItemMatch += 1;
      if (!item) {
        failures.push(`${label}: no existe ningún item con key="${row.item_key}" en manifest_json.items del Manifest ${row.manifest_id}.`);
      } else {
        if (item.type !== row.type) {
          failures.push(`${label}: type="${row.type}" no coincide con el type="${item.type}" del item del Manifest.`);
        }
        if (item.moduleId !== row.module_id) {
          failures.push(`${label}: module_id="${row.module_id}" no coincide con moduleId="${item.moduleId}" del item del Manifest.`);
        }
        const itemChapterId = item.chapterId === undefined ? null : item.chapterId;
        const rowChapterId = row.chapter_id === undefined ? null : row.chapter_id;
        if (itemChapterId !== rowChapterId) {
          failures.push(`${label}: chapter_id="${rowChapterId}" no coincide con chapterId="${itemChapterId}" del item del Manifest.`);
        }
        if (!arraysEqual(item.dependsOn, row.depends_on)) {
          failures.push(`${label}: depends_on=${JSON.stringify(row.depends_on)} no coincide con dependsOn=${JSON.stringify(item.dependsOn)} del item del Manifest (el orden importa).`);
        }
      }

      // 3c. idempotency_key = sha256(manifestId:itemKey:generation) — ver
      // canonicalContextHash/idempotencyKey arriba para la forma exacta.
      checkedIdempotency += 1;
      const expectedIdemKey = idempotencyKey(row.manifest_id, row.item_key, row.generation);
      if (row.idempotency_key !== expectedIdemKey) {
        failures.push(`${label}: idempotency_key[:12]=${shortSha(row.idempotency_key)} no coincide con sha256(manifestId:itemKey:generation)[:12]=${shortSha(expectedIdemKey)}.`);
      }
    }

    // 3b. Ningún item del Manifest duplicado por (manifest_id, item_key,
    // generation) — sanity check de solo lectura (ya lo garantiza
    // gir_item_generation_key, pero se re-verifica sin asumir el constraint).
    const dupes = await client.query(
      `select manifest_id, item_key, generation, count(*)::int as n
         from public.generation_item_runs
        group by manifest_id, item_key, generation
       having count(*) > 1`,
    );
    for (const d of dupes.rows) {
      failures.push(`Item duplicado: manifest_id=${d.manifest_id} item_key=${d.item_key} generation=${d.generation} aparece ${d.n} veces.`);
    }

    // 3d. Cada item run pertenece a un production_job dynamic_generation cuyo
    // input_payload->>'manifestId' = su manifest_id, y ese job tiene una fila
    // en generation_run_contexts con el mismo manifest_id y un context_hash
    // igual al sha256 canónico del context guardado.
    const runsWithJob = await client.query(
      `select gir.id, gir.job_id, gir.manifest_id,
              pj.execution_mode, pj.input_payload,
              grc.manifest_id as ctx_manifest_id, grc.context, grc.context_hash
         from public.generation_item_runs gir
         left join public.production_jobs pj on pj.id = gir.job_id
         left join public.generation_run_contexts grc on grc.job_id = gir.job_id
        order by gir.id`,
    );

    let checkedJobLink = 0;
    for (const row of runsWithJob.rows) {
      const label = `Item run id=${row.id} (job_id=${row.job_id})`;
      checkedJobLink += 1;

      if (row.execution_mode === null) {
        failures.push(`${label}: no se encontró el production_job referenciado — la FK debería impedir esto.`);
        continue;
      }
      if (row.execution_mode !== 'dynamic_generation') {
        failures.push(`${label}: el job tiene execution_mode="${row.execution_mode}", esperado "dynamic_generation".`);
      }
      const jobManifestId = row.input_payload && row.input_payload.manifestId;
      if (String(jobManifestId) !== String(row.manifest_id)) {
        failures.push(`${label}: input_payload.manifestId="${jobManifestId}" no coincide con manifest_id="${row.manifest_id}" del item run.`);
      }

      if (row.context === null) {
        failures.push(`${label}: no existe generation_run_contexts para job_id="${row.job_id}".`);
        continue;
      }
      if (String(row.ctx_manifest_id) !== String(row.manifest_id)) {
        failures.push(`${label}: generation_run_contexts.manifest_id="${row.ctx_manifest_id}" no coincide con manifest_id="${row.manifest_id}" del item run.`);
      }
      const expectedHash = canonicalContextHash(row.context);
      if (row.context_hash !== expectedHash) {
        failures.push(`${label}: generation_run_contexts.context_hash[:12]=${shortSha(row.context_hash)} no coincide con sha256(canónico(context))[:12]=${shortSha(expectedHash)}.`);
      }
    }

    // 3e. Todo artifact con manifest_item_key referencia un item run real con
    // el mismo manifest_id/item_key.
    const artifactsWithKey = await client.query(
      `select a.id, a.manifest_id, a.manifest_item_key, gir.id as item_run_id
         from public.artifacts a
         left join public.generation_item_runs gir
           on gir.manifest_id = a.manifest_id and gir.item_key = a.manifest_item_key
        where a.manifest_item_key is not null`,
    );
    let checkedArtifacts = 0;
    for (const row of artifactsWithKey.rows) {
      checkedArtifacts += 1;
      if (row.item_run_id === null) {
        failures.push(`Artifact id=${row.id}: manifest_item_key="${row.manifest_item_key}" (manifest_id=${row.manifest_id}) no referencia ningún generation_item_runs existente.`);
      }
    }

    if (failures.length === 0) {
      console.log(`✅ (a) cada item run matchea type/module_id/chapter_id/depends_on de su item en el Manifest (${checkedItemMatch} item runs revisados).`);
      console.log(`✅ (b) ningún item del Manifest aparece duplicado por (manifest_id, item_key, generation).`);
      console.log(`✅ (c) idempotency_key = sha256(manifestId:itemKey:generation) (${checkedIdempotency} item runs revisados).`);
      console.log(`✅ (d) cada item run tiene un job dynamic_generation con manifestId consistente y un context_hash canónico correcto (${checkedJobLink} item runs revisados).`);
      console.log(`✅ (e) todo artifact con manifest_item_key referencia un item run existente (${checkedArtifacts} artifacts revisados).`);
    } else {
      console.log(`❌ ${failures.length} violaciones de invariantes encontradas (detalle abajo).`);
    }

    // 3f. Inmutabilidad sobre datos reales — UPDATE real sobre el contexto más
    // reciente, en savepoint dentro de una transacción siempre revertida. Un
    // UPDATE que no afecta ninguna fila (borrada entre el SELECT y el UPDATE)
    // cuenta como "⚠️ omitido", nunca como ❌.
    console.log('');
    await client.query('begin');
    try {
      const latest = await client.query(
        `select job_id from public.generation_run_contexts order by created_at desc, job_id desc limit 1`,
      );

      if (latest.rows.length === 0) {
        console.log('⚠️  (f) omitido — no hay filas reales en generation_run_contexts.');
      } else {
        const latestJobId = latest.rows[0].job_id;

        await client.query('savepoint s1');
        let immutableRejected = false;
        let immutableCode = null;
        let immutableRowCount = null;
        try {
          const res = await client.query(
            `update public.generation_run_contexts set context_hash = context_hash where job_id = $1`,
            [latestJobId],
          );
          immutableRowCount = res.rowCount;
        } catch (e) {
          immutableCode = e.code;
          immutableRejected = e.code === 'P0001';
        } finally {
          await client.query('rollback to savepoint s1');
        }
        if (immutableRejected) {
          console.log(`✅ (f) UPDATE sobre generation_run_contexts (job_id=${latestJobId}) rechazado con P0001.`);
        } else if (immutableRowCount === 0) {
          console.log(
            `⚠️  (f) omitido (fila ya no existe) — el UPDATE sobre generation_run_contexts (job_id=${latestJobId}) ` +
            `no afectó ninguna fila (borrada entre el SELECT y el UPDATE).`,
          );
        } else {
          console.log(
            `❌ (f) UPDATE sobre generation_run_contexts (job_id=${latestJobId}) NO fue rechazado con P0001 ` +
            `(código real: ${immutableCode || 'ninguno — se permitió el UPDATE'}).`,
          );
          failures.push('El trigger de inmutabilidad no rechazó un UPDATE real sobre generation_run_contexts.');
        }
      }
    } finally {
      await client.query('rollback'); // nunca deja basura, sea cual sea el resultado
    }

    console.log('');
    if (failures.length > 0) {
      console.error('❌ Auditoría de dynamic-generation FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    console.log('✅ Auditoría de dynamic-generation: todos los invariantes se cumplen.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exitCode = 1;
});
