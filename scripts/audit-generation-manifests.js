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
          -- rulesVersion 2: columnas de conteo v2 vía to_jsonb (pueden no existir
          -- todavía si esta auditoría corre antes de la migración v2 → 0).
          coalesce((to_jsonb(cgm)->>'course_plan_count')::int, 0)  as course_plan_count,
          coalesce((to_jsonb(cgm)->>'course_intro_count')::int, 0) as course_intro_count,
          coalesce((to_jsonb(cgm)->>'module_intro_count')::int, 0) as module_intro_count,
          cb.snapshot_sha256 as blueprint_snapshot_sha256,
          cb.snapshot_json   as blueprint_snapshot_json,
          cb.module_count    as blueprint_module_count,
          cb.chapter_count   as blueprint_chapter_count
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
    let checkedChapterCoverage = 0;
    let checkedModuleExamCoverage = 0;
    let checkedBlueprintCounts = 0;
    let checkedV2 = 0;

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
      // rulesVersion 2 (spec v2 §3): además course_plan, course_intro y
      // module_intro; en v1 esos tipos siguen siendo "desconocidos".
      const isV2 = row.rules_version === 2;
      if (row.rules_version !== 1 && !isV2) {
        failures.push(`${label}: rules_version=${row.rules_version} no soportado (esperado 1 o 2).`);
      }
      if (manifest.rulesVersion !== row.rules_version) {
        failures.push(`${label}: manifest_json.rulesVersion=${manifest.rulesVersion} no coincide con la columna rules_version=${row.rules_version}.`);
      }
      const byType = isV2
        ? { content: 0, scorm: 0, video: 0, exam: 0, course_plan: 0, course_intro: 0, module_intro: 0 }
        : { content: 0, scorm: 0, video: 0, exam: 0 };
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
      const v2Counts = [
        ['course_plan', 'course_plan_count'], ['course_intro', 'course_intro_count'], ['module_intro', 'module_intro_count'],
      ];
      for (const [t, col] of v2Counts) {
        const n = byType[t] || 0;
        if (n !== row[col]) failures.push(`${label}: items de type=${t} (${n}) no coincide con ${col}=${row[col]}.`);
      }

      // 3d-v2. Invariantes de rulesVersion 2 (plan R1 ítem 5): un solo
      // course_plan y un solo course_intro (scope course, sin módulo ni
      // capítulo, keys por courseId); module_intro sii el módulo existe en el
      // snapshot (exactamente uno por módulo); content.dependsOn incluye
      // course_plan (y course_intro/module_intro dependen solo del plan).
      if (isV2) {
        checkedV2 += 1;
        const planKey = `course_plan:${row.course_id}`;
        const introKey = `course_intro:${row.course_id}`;
        const plans = items.filter((i) => i && i.type === 'course_plan');
        const intros = items.filter((i) => i && i.type === 'course_intro');
        if (plans.length !== 1 || plans[0].key !== planKey) {
          failures.push(`${label}: v2 exige exactamente un course_plan con key ${planKey} (encontrados: ${JSON.stringify(plans.map((i) => i.key))}).`);
        }
        if (intros.length !== 1 || intros[0].key !== introKey) {
          failures.push(`${label}: v2 exige exactamente un course_intro con key ${introKey} (encontrados: ${JSON.stringify(intros.map((i) => i.key))}).`);
        }
        for (const i of [...plans, ...intros]) {
          if (i.scope !== 'course' || i.moduleId !== null || i.chapterId !== null) {
            failures.push(`${label}: item ${i.key} debe ser scope=course sin moduleId/chapterId.`);
          }
        }
        for (const i of intros) {
          if (JSON.stringify(i.dependsOn) !== JSON.stringify([planKey])) failures.push(`${label}: ${i.key}.dependsOn debe ser [${planKey}].`);
        }
        const introByModule = new Map();
        for (const i of items) {
          if (!i || i.type !== 'module_intro') continue;
          if (!findModuleInSnapshot(row.blueprint_snapshot_json, i.moduleId)) {
            failures.push(`${label}: module_intro ${i.key} referencia un módulo inexistente en el snapshot (moduleId=${i.moduleId}).`);
          }
          if (i.key !== `module_intro:${i.moduleId}` || i.scope !== 'module' || i.chapterId !== null) {
            failures.push(`${label}: module_intro ${i.key} con key/scope/chapterId inconsistentes.`);
          }
          if (JSON.stringify(i.dependsOn) !== JSON.stringify([planKey])) failures.push(`${label}: ${i.key}.dependsOn debe ser [${planKey}].`);
          introByModule.set(i.moduleId, (introByModule.get(i.moduleId) || 0) + 1);
        }
        const smods = Array.isArray(row.blueprint_snapshot_json && row.blueprint_snapshot_json.modules) ? row.blueprint_snapshot_json.modules : [];
        for (const smod of smods) {
          const n = introByModule.get(smod.id) || 0;
          if (n !== 1) failures.push(`${label}: módulo ${smod.id} del snapshot tiene ${n} items module_intro (esperado exactamente 1).`);
        }
        for (const i of items) {
          if (i && i.type === 'content' && !(Array.isArray(i.dependsOn) && i.dependsOn.includes(planKey))) {
            failures.push(`${label}: ${i.key}.dependsOn no incluye ${planKey} (v2).`);
          }
        }
      }

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

      // 3g. FIX M2 — cobertura en AMBAS direcciones contra el snapshot del
      // Blueprint (3e/3f de arriba solo miran "¿todo item que existe está
      // permitido?"; esto agrega "¿todo lo que el snapshot exige está
      // presente?"): cada capítulo del snapshot debe tener EXACTAMENTE un
      // item content y un item scorm, y un item video si y solo si
      // videoEnabled=true (nunca menos, nunca de más).
      checkedChapterCoverage += 1;
      const contentByChapter = new Map();
      const scormByChapter = new Map();
      const videoByChapter = new Map();
      for (const item of items) {
        if (!item || !item.chapterId) continue;
        const bucket =
          item.type === 'content' ? contentByChapter :
          item.type === 'scorm' ? scormByChapter :
          item.type === 'video' ? videoByChapter :
          null;
        if (!bucket) continue;
        bucket.set(item.chapterId, (bucket.get(item.chapterId) || 0) + 1);
      }
      const snapshotModules = Array.isArray(row.blueprint_snapshot_json && row.blueprint_snapshot_json.modules)
        ? row.blueprint_snapshot_json.modules
        : [];
      for (const smod of snapshotModules) {
        const schapters = Array.isArray(smod && smod.chapters) ? smod.chapters : [];
        for (const schap of schapters) {
          const cCount = contentByChapter.get(schap.id) || 0;
          const sCount = scormByChapter.get(schap.id) || 0;
          const vCount = videoByChapter.get(schap.id) || 0;
          if (cCount !== 1) {
            failures.push(`${label}: capítulo ${schap.id} del snapshot tiene ${cCount} items content (esperado exactamente 1).`);
          }
          if (sCount !== 1) {
            failures.push(`${label}: capítulo ${schap.id} del snapshot tiene ${sCount} items scorm (esperado exactamente 1).`);
          }
          const expectedVideo = schap.videoEnabled === true ? 1 : 0;
          if (vCount !== expectedVideo) {
            failures.push(`${label}: capítulo ${schap.id} del snapshot (videoEnabled=${schap.videoEnabled === true}) tiene ${vCount} items video (esperado ${expectedVideo}).`);
          }
        }
      }

      // 3h. FIX M2 — misma cobertura en ambas direcciones para exam, por
      // módulo: exactamente un item exam si examEnabled=true, ninguno si
      // examEnabled=false.
      checkedModuleExamCoverage += 1;
      const examByModule = new Map();
      for (const item of items) {
        if (!item || item.type !== 'exam' || !item.moduleId) continue;
        examByModule.set(item.moduleId, (examByModule.get(item.moduleId) || 0) + 1);
      }
      for (const smod of snapshotModules) {
        const eCount = examByModule.get(smod.id) || 0;
        const expectedExam = smod.examEnabled === true ? 1 : 0;
        if (eCount !== expectedExam) {
          failures.push(`${label}: módulo ${smod.id} del snapshot (examEnabled=${smod.examEnabled === true}) tiene ${eCount} items exam (esperado ${expectedExam}).`);
        }
      }

      // 3i. FIX M2 — module_count/chapter_count de course_generation_manifests
      // deben coincidir con los del course_blueprints referenciado (no solo
      // con lo recontado desde items — ambas columnas describen el MISMO
      // snapshot, así que deben ser idénticas entre las dos tablas).
      checkedBlueprintCounts += 1;
      if (row.blueprint_module_count !== undefined && row.module_count !== row.blueprint_module_count) {
        failures.push(`${label}: module_count=${row.module_count} no coincide con course_blueprints.module_count=${row.blueprint_module_count}.`);
      }
      if (row.blueprint_chapter_count !== undefined && row.chapter_count !== row.blueprint_chapter_count) {
        failures.push(`${label}: chapter_count=${row.chapter_count} no coincide con course_blueprints.chapter_count=${row.blueprint_chapter_count}.`);
      }
    }

    if (failures.length === 0) {
      console.log(`✅ (a) source.blueprintId/courseId consistentes con las columnas (${checkedSourceIdentity} Manifests revisados).`);
      console.log(`✅ (b) source.blueprintSha256 = course_blueprints.snapshot_sha256 (${checkedBlueprintSha} Manifests revisados).`);
      console.log(`✅ (c) jsonb_array_length(items) = total_jobs (${checkedItemCount} Manifests revisados).`);
      console.log(`✅ (d) conteos por type en items = columnas (${checkedTypeCounts} Manifests revisados).`);
      console.log(`✅ (e) ningún item video para capítulo con videoEnabled=false (${checkedVideoInvariant} Manifests revisados).`);
      console.log(`✅ (f) ningún item exam para módulo con examEnabled=false (${checkedExamInvariant} Manifests revisados).`);
      console.log(`✅ (g) cada capítulo del snapshot tiene exactamente 1 content + 1 scorm, y video sii videoEnabled (${checkedChapterCoverage} Manifests revisados).`);
      console.log(`✅ (h) cada módulo del snapshot tiene exam sii examEnabled (${checkedModuleExamCoverage} Manifests revisados).`);
      console.log(`✅ (i) module_count/chapter_count = course_blueprints.module_count/chapter_count (${checkedBlueprintCounts} Manifests revisados).`);
      console.log(`✅ (j) rulesVersion 2: 1 course_plan + 1 course_intro, module_intro sii el módulo existe, content depende de course_plan (${checkedV2} Manifests v2 revisados).`);
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
    // Fase 9 (G6): en production-readonly esta sonda NO corre (escribe dentro
    // de una transacción revertida y la sesión es READ ONLY). Cuerpo sin
    // reindentar a propósito para mantener el diff mínimo.
    if (PROD_RO) {
      v2Target.logSkippedProbe('3g. inmutabilidad sobre datos reales (UPDATE no-op revertido)');
    } else {
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
    } // fin if (PROD_RO) — sonda con escritura revertida

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
