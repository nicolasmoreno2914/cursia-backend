#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const v2Target = require('./lib/v2-production-target');
const { auditItemRolesV3, auditMockArtifactsV3 } = require('./lib/audit-v3');

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
// misma forma al escribir generation_run_contexts.context_hash — fix ronda
// 1, M5) ──
//
//   context_hash = sha256(JSON.stringify(sortKeysDeep(JSON.parse(JSON.stringify(context))))) en hex
//
// Paso 1 — `JSON.parse(JSON.stringify(context))`: `context` DEBE ser JSON
// plano (nada de Date, Map, Set, undefined, funciones, símbolos, claves no
// enumerables ni referencias circulares). Este roundtrip lo fuerza: cualquier
// valor que no sobreviva un roundtrip JSON tal cual (p.ej. una Date se
// convierte en string ISO, un `undefined` desaparece de un objeto o se
// convierte en `null` dentro de un array) queda normalizado ANTES de
// calcular el hash, así que el hash nunca depende de cómo Node serializa
// tipos no-JSON — depende únicamente del JSON resultante. Task 2 debe hacer
// este mismo roundtrip antes de hashear lo que va a `context`.
//
// Paso 2 — `sortKeysDeep`: ordena las claves de cualquier objeto plano de
// forma recursiva llamando `Object.keys(value).sort()` — el `.sort()` es
// obligatorio (nunca confiar en el orden de inserción/orden de motor de
// Object.keys): el default de `.sort()` compara los elementos como strings
// por unidad de código UTF-16, así que una clave como "10" queda ANTES que
// "9" (orden lexicográfico, no numérico) — es la única fuente de orden que
// importa acá. Los arrays preservan su propio orden tal cual vienen (el
// orden de un array es significativo — p.ej. dependsOn — y nunca se
// reordena).
//
// El resultado: el hash es estable sin importar en qué orden se construyó
// el objeto `context` en JS, y sin importar qué tipos no-JSON pudieran
// haberse colado antes del roundtrip.
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
  const plainJson = JSON.parse(JSON.stringify(context));
  return crypto.createHash('sha256').update(JSON.stringify(sortKeysDeep(plainJson))).digest('hex');
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

    const runCount = await client.query(`select count(*)::int as n from public.generation_item_runs`);
    const totalRuns = runCount.rows[0].n;
    console.log(`generation_item_runs: ${totalRuns} filas totales.`);

    const ctxCount = await client.query(`select count(*)::int as n from public.generation_run_contexts`);
    console.log(`generation_run_contexts: ${ctxCount.rows[0].n} filas totales.`);

    const artifactCount = await client.query(
      `select count(*)::int as n from public.artifacts where manifest_item_key is not null`,
    );
    console.log(`artifacts con manifest_item_key: ${artifactCount.rows[0].n} filas totales.`);

    const hasRuns = totalRuns > 0;
    if (!hasRuns) {
      console.log('');
      console.log('(sin generation_item_runs todavía — se saltan los checks 3a-3d; el check de artifacts (3e) y la sonda de inmutabilidad (3f) SÍ corren igual, más abajo — fix ronda 1)');
    }

    let checkedItemMatch = 0;
    let checkedIdempotency = 0;
    let checkedJobLink = 0;

    if (hasRuns) {
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

      // 3a/3c: cada item run contra su item de Manifest + idempotency_key.
      const runsWithManifest = await client.query(
        `select gir.id, gir.job_id, gir.manifest_id, gir.item_key, gir.generation, gir.type,
                gir.module_id, gir.chapter_id, gir.depends_on, gir.idempotency_key,
                to_jsonb(gir)->>'scope' as scope,
                cgm.manifest_json
           from public.generation_item_runs gir
           left join public.course_generation_manifests cgm on cgm.id = gir.manifest_id
          order by gir.id`,
      );

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
          // rulesVersion 2: la columna scope (si la migración v2 ya corrió)
          // coincide con el scope del item del Manifest.
          if (row.scope !== null && row.scope !== undefined && item.scope !== row.scope) {
            failures.push(`${label}: scope="${row.scope}" no coincide con scope="${item.scope}" del item del Manifest.`);
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
    }

    // 3e. Todo artifact con manifest_id no nulo: si tiene manifest_item_key,
    // esa key debe existir entre los items del Manifest referenciado (contra
    // manifest_json.items — NUNCA contra generation_item_runs: un artifact
    // dynamic puede legítimamente no tener ningún item run vivo todavía, o
    // el run pudo borrarse, y eso no lo invalida); si además tiene
    // item_run_id, ese run debe pertenecer al MISMO manifest_id/item_key que
    // el artifact (fix ronda 1, Important #3). Corre siempre, incluso con 0
    // generation_item_runs. Un artifact con manifest_id NULL (p.ej. porque
    // su Manifest se borró y el FK hizo ON DELETE SET NULL) queda
    // deliberadamente FUERA de este check — dejó de ser "un artifact
    // dynamic vinculado", así que no hay nada estructural que auditar sobre
    // él.
    const artifactsWithManifest = await client.query(
      `select a.id, a.manifest_id, a.manifest_item_key, a.item_run_id,
              cgm.manifest_json,
              gir.manifest_id as run_manifest_id, gir.item_key as run_item_key
         from public.artifacts a
         left join public.course_generation_manifests cgm on cgm.id = a.manifest_id
         left join public.generation_item_runs gir on gir.id = a.item_run_id
        where a.manifest_id is not null`,
    );
    let checkedArtifacts = 0;
    for (const row of artifactsWithManifest.rows) {
      checkedArtifacts += 1;
      const label = `Artifact id=${row.id} (manifest_id=${row.manifest_id}, manifest_item_key=${row.manifest_item_key === null ? '(null)' : row.manifest_item_key})`;

      if (row.manifest_json === null) {
        failures.push(`${label}: no se encontró el Manifest referenciado (manifest_id=${row.manifest_id}) — la FK debería impedir esto.`);
        continue;
      }

      if (row.manifest_item_key !== null) {
        const items = Array.isArray(row.manifest_json.items) ? row.manifest_json.items : [];
        const item = items.find((it) => it && it.key === row.manifest_item_key);
        if (!item) {
          failures.push(`${label}: manifest_item_key="${row.manifest_item_key}" no existe entre manifest_json.items del Manifest ${row.manifest_id}.`);
        }
      }

      if (row.item_run_id !== null) {
        if (row.run_manifest_id === null) {
          failures.push(`${label}: item_run_id="${row.item_run_id}" no referencia ningún generation_item_runs existente — la FK debería impedir esto.`);
        } else {
          if (String(row.run_manifest_id) !== String(row.manifest_id)) {
            failures.push(`${label}: item_run_id="${row.item_run_id}" pertenece a manifest_id=${row.run_manifest_id}, distinto del manifest_id=${row.manifest_id} del artifact.`);
          }
          if (row.run_item_key !== row.manifest_item_key) {
            failures.push(`${label}: item_run_id="${row.item_run_id}" tiene item_key="${row.run_item_key}", distinto del manifest_item_key="${row.manifest_item_key}" del artifact.`);
          }
        }
      }
    }

    // 3f. R17 (Fase 5A Task 4): todo job dynamic_generation con
    // input_payload.videoMode presente debe tener 'mock' o 'real' — un run
    // creado ANTES de esta feature no tiene la clave (ausente = 'mock' por
    // convención del código, no es una violación estructural).
    const videoModeRows = await client.query(
      `select id, input_payload->>'videoMode' as video_mode
         from public.production_jobs
        where execution_mode = 'dynamic_generation' and input_payload ? 'videoMode'`,
    );
    let checkedVideoMode = 0;
    for (const row of videoModeRows.rows) {
      checkedVideoMode += 1;
      if (row.video_mode !== 'mock' && row.video_mode !== 'real') {
        failures.push(`Run job_id=${row.id}: input_payload.videoMode="${row.video_mode}" inválido (esperado 'mock' o 'real').`);
      }
    }

    // 3h. rulesVersion 2 (spec v2 §3/§4, contrato R2): items COMPLETADOS de
    // Manifests v2 con sus roles de artifact (enlazados por item_run_id):
    //  - course_plan → exactamente 1 dynamic_course_plan_json;
    //  - course_intro / module_intro → 1 dynamic_course_intro_md / dynamic_module_intro_md;
    //  - content → dynamic_content_md + dynamic_context_package_json, y
    //    output_summary.contextPackageSha256 (64 hex) + contextPackageVersion=1;
    //    el resumen real (dynamic_context_summary_json) es opcional, pero si
    //    falta debe estar la marca output_summary.contextSummary='missing'
    //    (nunca una ausencia silenciosa).
    const v2Items = await client.query(
      `select gir.id, gir.item_key, gir.type, gir.output_summary,
              coalesce(array_agg(a.type order by a.type) filter (where a.id is not null), '{}') as artifact_types
         from public.generation_item_runs gir
         join public.course_generation_manifests cgm on cgm.id = gir.manifest_id and cgm.rules_version = 2
         left join public.artifacts a on a.item_run_id = gir.id
        where gir.status = 'completed'
        group by gir.id, gir.item_key, gir.type, gir.output_summary`,
    );
    const V2_ROLES = {
      course_plan: ['dynamic_course_plan_json'],
      course_intro: ['dynamic_course_intro_md'],
      module_intro: ['dynamic_module_intro_md'],
      content: ['dynamic_content_md', 'dynamic_context_package_json'],
    };
    let checkedV2Items = 0;
    for (const row of v2Items.rows) {
      const roles = V2_ROLES[row.type];
      if (!roles) continue;
      checkedV2Items += 1;
      const label = `Item run v2 id=${row.id} (item_key=${row.item_key})`;
      const types = row.artifact_types || [];
      for (const r of roles) {
        const n = types.filter((t) => t === r).length;
        if (n !== 1) failures.push(`${label}: esperado exactamente 1 artifact ${r}, encontrados ${n}.`);
      }
      if (row.type === 'content') {
        const os = row.output_summary || {};
        if (!/^[0-9a-f]{64}$/.test(String(os.contextPackageSha256 || ''))) {
          failures.push(`${label}: output_summary.contextPackageSha256 ausente o inválido.`);
        }
        if (os.contextPackageVersion !== 1) {
          failures.push(`${label}: output_summary.contextPackageVersion=${JSON.stringify(os.contextPackageVersion)} (esperado 1).`);
        }
        const hasSummary = types.includes('dynamic_context_summary_json');
        if (!hasSummary && os.contextSummary !== 'missing') {
          failures.push(`${label}: sin dynamic_context_summary_json y sin la marca output_summary.contextSummary='missing'.`);
        }
      }
    }

    // 3h-v3. V2.1 (R5): items COMPLETADOS de Manifests rulesVersion 3 con sus
    // roles de artifact (contrato de R4, completeItem): activity según el
    // variant congelado en el item del Manifest. Ver scripts/lib/audit-v3.js.
    const v3Items = await client.query(
      `select gir.id, gir.item_key, gir.type,
              (select i->>'variant' from jsonb_array_elements(cgm.manifest_json->'items') i
                where i->>'key' = gir.item_key limit 1) as variant,
              coalesce(array_agg(a.type order by a.type) filter (where a.id is not null), '{}') as artifact_types,
              coalesce(array_agg(a.type order by a.type)
                         filter (where a.id is not null and (a.metadata->>'mock' = 'true' or a.metadata->>'fixture' = 'true')), '{}') as mock_artifact_types,
              pj.input_payload->'providerModes' as provider_modes
         from public.generation_item_runs gir
         join public.course_generation_manifests cgm on cgm.id = gir.manifest_id and cgm.rules_version = 3
         join public.production_jobs pj on pj.id = gir.job_id
         left join public.artifacts a on a.item_run_id = gir.id
        where gir.status = 'completed'
        group by gir.id, gir.item_key, gir.type, cgm.manifest_json, pj.input_payload`,
    );
    let checkedV3Items = 0;
    for (const row of v3Items.rows) {
      checkedV3Items += 1;
      failures.push(...auditItemRolesV3(row));
      failures.push(...auditMockArtifactsV3(row));
    }

    if (failures.length === 0) {
      if (hasRuns) {
        console.log(`✅ (a) cada item run matchea type/module_id/chapter_id/depends_on de su item en el Manifest (${checkedItemMatch} item runs revisados).`);
        console.log(`✅ (b) ningún item del Manifest aparece duplicado por (manifest_id, item_key, generation).`);
        console.log(`✅ (c) idempotency_key = sha256(manifestId:itemKey:generation) (${checkedIdempotency} item runs revisados).`);
        console.log(`✅ (d) cada item run tiene un job dynamic_generation con manifestId consistente y un context_hash canónico correcto (${checkedJobLink} item runs revisados).`);
      } else {
        console.log('⚠️  (a)-(d) omitido — 0 generation_item_runs.');
      }
      console.log(`✅ (e) todo artifact con manifest_id no nulo tiene manifest_item_key/item_run_id consistentes con su Manifest (${checkedArtifacts} artifacts revisados).`);
      console.log(`✅ (h) rulesVersion 2: roles de artifact + Context Package (hash/versión) + marca de resumen en items completados (${checkedV2Items} revisados).`);
      console.log(`✅ (h3) rulesVersion 3: roles de artifact por tipo (activity según variant) y ningún artifact simulado fuera de un run mock, en items completados (${checkedV3Items} revisados).`);
      console.log(`✅ (f2) input_payload.videoMode ∈ {'mock','real'} en runs que lo declaran (${checkedVideoMode} revisados; ausente = 'mock' por convención, no falla).`);
    } else {
      console.log(`❌ ${failures.length} violaciones de invariantes encontradas (detalle abajo).`);
    }

    // 3g. Inmutabilidad sobre datos reales — UPDATE real sobre el contexto más
    // reciente, en savepoint dentro de una transacción siempre revertida. Un
    // UPDATE que no afecta ninguna fila (borrada entre el SELECT y el UPDATE)
    // cuenta como "⚠️ omitido", nunca como ❌.
    console.log('');
    // Fase 9 (G6): en production-readonly esta sonda NO corre (escribe dentro
    // de una transacción revertida y la sesión es READ ONLY). Cuerpo sin
    // reindentar a propósito para mantener el diff mínimo.
    if (PROD_RO) {
      v2Target.logSkippedProbe('3g. inmutabilidad sobre datos reales (UPDATE no-op revertido)');
    } else {
    await client.query('begin');
    try {
      const latest = await client.query(
        `select job_id from public.generation_run_contexts order by created_at desc, job_id desc limit 1`,
      );

      if (latest.rows.length === 0) {
        console.log('⚠️  (g) omitido — no hay filas reales en generation_run_contexts.');
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
          console.log(`✅ (g) UPDATE sobre generation_run_contexts (job_id=${latestJobId}) rechazado con P0001.`);
        } else if (immutableRowCount === 0) {
          console.log(
            `⚠️  (g) omitido (fila ya no existe) — el UPDATE sobre generation_run_contexts (job_id=${latestJobId}) ` +
            `no afectó ninguna fila (borrada entre el SELECT y el UPDATE).`,
          );
        } else {
          console.log(
            `❌ (g) UPDATE sobre generation_run_contexts (job_id=${latestJobId}) NO fue rechazado con P0001 ` +
            `(código real: ${immutableCode || 'ninguno — se permitió el UPDATE'}).`,
          );
          failures.push('El trigger de inmutabilidad no rechazó un UPDATE real sobre generation_run_contexts.');
        }
      }
    } finally {
      await client.query('rollback'); // nunca deja basura, sea cual sea el resultado
    }
    } // fin if (PROD_RO) — sonda con escritura revertida

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
