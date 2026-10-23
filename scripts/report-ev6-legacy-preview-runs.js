#!/usr/bin/env node
/* eslint-disable */
// Cursia EV6 DoD (BE-B) — reporte de cursos VIEJOS de vista previa. SOLO LECTURA.
//
// Lista las ejecuciones dinámicas que quedaron `completed` ANTES de la DoD pero que hoy, con el
// evaluador de completitud (run-completion.ts, el mismo de RunDto.completion), se leen como `preview`
// (algún componente de vista previa: video mock, Gamma/TTS simulados). Para cada una indica si se armó
// un paquete (.mbz) y si ese paquete tiene un archivo descargable. El servidor NO registra descargas:
// «descargable» = el job de paquete completó con artifact (lo pudo bajar el dueño), no «descargado».
//
// DoD follow-up (R5): además lista los .mbz QA / degradados DECLARADOS (metadata.packageKind) que quedaron
// en la carpeta del dueño (`<owner>/…`, armados antes de que los paquetes QA fueran a `qa-internal/`):
// las políticas own-folder de Storage se los dejan leer al dueño por URL directa. Solo existen en
// staging (los paquetes QA son posteriores a EV6 DoD); el reporte no los mueve ni los borra.
//
// Garantías:
//   - nunca escribe: todas las consultas corren dentro de una transacción `READ ONLY` (Postgres rechaza
//     cualquier escritura) y el script solo emite SELECT; cualquier flag de escritura (--apply, --write,
//     --fix, --update, --delete, --commit, --execute, --migrate, --repair) → sale con error SIN conectarse;
//   - imprime solo conteos e ids (run, curso, dueño, Manifest, items); nada de títulos, emails, contexto
//     ni texto de errores;
//   - exige elegir el destino explícitamente: REPORT_TARGET=local|staging|production (sin default).
//
// Conexión: DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME, DB_SSL (mismas variables que el backend).
// Requiere `npm run build` (usa el evaluador compilado de dist/).
//
// Usage: REPORT_TARGET=staging node scripts/report-ev6-legacy-preview-runs.js [--json] [--limit=N]

const path = require('path');

const WRITE_FLAGS = ['--apply', '--write', '--fix', '--update', '--delete', '--commit', '--execute', '--migrate', '--repair', '--mutate'];
const argv = process.argv.slice(2);
const bad = argv.filter((a) => WRITE_FLAGS.includes(a.split('=')[0].toLowerCase()));
if (bad.length) {
  console.error(`❌ report-ev6-legacy-preview-runs es de SOLO LECTURA: rechaza ${bad.join(', ')}. No se conectó a nada.`);
  process.exit(2);
}
const unknown = argv.filter((a) => a !== '--json' && !/^--limit=\d+$/.test(a));
if (unknown.length) {
  console.error(`❌ argumentos desconocidos: ${unknown.join(', ')} (solo --json y --limit=N). No se conectó a nada.`);
  process.exit(2);
}
const JSON_OUT = argv.includes('--json');
const LIMIT = (() => {
  const a = argv.find((x) => x.startsWith('--limit='));
  const n = a ? Number(a.split('=')[1]) : 5000;
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100000) : 5000;
})();
const TARGET = String(process.env.REPORT_TARGET || '').trim();
if (!['local', 'staging', 'production'].includes(TARGET)) {
  console.error('❌ REPORT_TARGET es obligatorio (local | staging | production). El reporte es de solo lectura, pero el destino se elige explícitamente. No se conectó a nada.');
  process.exit(2);
}

/** Solo SELECT / WITH (más el control de la transacción read-only). */
const READ_SQL = /^\s*(select|with)\b/i;

(async () => {
  let RC;
  try {
    RC = require(path.join(__dirname, '..', 'dist', 'modules', 'dynamic-generation', 'run-completion.js'));
  } catch (err) {
    console.error(`❌ No se pudo cargar dist/modules/dynamic-generation/run-completion.js (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
  const { Client } = require('pg');
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: String(process.env.DB_SSL || '').toLowerCase() === 'false' ? false : { rejectUnauthorized: false },
    application_name: 'cursia-report-ev6-legacy-preview-runs (read-only)',
  });
  // Toda consulta del reporte (y del evaluador compilado) pasa por acá: solo SELECT/WITH.
  const q = {
    async query(sql, params) {
      if (!READ_SQL.test(String(sql))) throw new Error(`consulta no permitida en un reporte de solo lectura: ${String(sql).trim().split(/\s+/)[0]}`);
      const r = await client.query(sql, params);
      return r.rows;
    },
  };
  let code = 0;
  await client.connect();
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    const runs = await q.query(
      `select r.id, r.course_id, r.owner_id, r.worker_status, (r.input_payload->>'manifestId') as manifest_id, r.finished_at
         from public.production_jobs r
        where r.execution_mode = 'dynamic_generation' and r.worker_status = 'completed'
        order by r.finished_at desc nulls last, r.id desc
        limit $1`,
      [LIMIT],
    );
    const legacy = [];
    let unevaluable = 0;
    for (const run of runs) {
      let inputs = null;
      try {
        inputs = await RC.loadCompletionInputs(q, run.id);
      } catch {
        inputs = null;
      }
      if (!inputs) {
        unevaluable++;
        continue;
      }
      const c = RC.evaluateRunCompletion(inputs.job, inputs.rows, inputs.manifest, null, { validationCutoffs: inputs.validationCutoffs });
      if (c.state !== 'preview') continue;
      const [pkg] = await q.query(
        `select count(*)::int as built,
                count(*) filter (where (output_summary->>'artifactId') is not null)::int as downloadable
           from public.production_jobs
          where execution_mode = 'dynamic_package' and input_payload->>'runId' = $1 and worker_status = 'completed'`,
        [run.id],
      );
      legacy.push({
        runId: run.id,
        courseId: Number(run.course_id),
        ownerId: run.owner_id,
        manifestId: Number(run.manifest_id),
        previewComponents: c.previewComponents,
        packageBuilt: (pkg && pkg.built) > 0,
        packageDownloadable: (pkg && pkg.downloadable) > 0,
      });
    }
    // DoD follow-up (R5): paquetes QA / degradados declarados fuera de `qa-internal/` (legibles por el dueño).
    const ownerFolderQa = (await q.query(
      `select a.id, a.owner_id, a.course_id, a.job_id, a.metadata->>'runId' as run_id, a.metadata->>'packageKind' as package_kind,
              a.storage_bucket
         from public.artifacts a
        where a.type = 'dynamic_mbz' and (a.metadata->>'packageKind') in ('qa_preview', 'degraded')
          and a.storage_path not like 'qa-internal/%'
        order by a.created_at desc nulls last, a.id desc
        limit $1`,
      [LIMIT],
    )).map((a) => ({
      artifactId: a.id,
      ownerId: a.owner_id,
      courseId: a.course_id,
      packageJobId: a.job_id,
      runId: a.run_id,
      packageKind: a.package_kind,
      bucket: a.storage_bucket,
      storageFolder: 'owner',
    }));
    await client.query('rollback');
    const summary = {
      target: TARGET,
      readOnly: true,
      completedRunsScanned: runs.length,
      unevaluable,
      legacyPreviewRuns: legacy.length,
      withPackageBuilt: legacy.filter((x) => x.packageBuilt).length,
      withDownloadablePackage: legacy.filter((x) => x.packageDownloadable).length,
      downloadsTracked: false,
      qaPackagesInOwnerFolder: ownerFolderQa.length,
    };
    if (JSON_OUT) {
      console.log(JSON.stringify({ summary, runs: legacy, qaPackagesInOwnerFolder: ownerFolderQa }, null, 2));
    } else {
      console.log(`EV6 DoD — cursos viejos de vista previa (solo lectura, destino ${TARGET})`);
      console.log(`  runs completed revisados: ${summary.completedRunsScanned} (sin evaluar: ${unevaluable})`);
      console.log(`  se leen como preview:     ${summary.legacyPreviewRuns}`);
      console.log(`  con paquete armado:       ${summary.withPackageBuilt}`);
      console.log(`  con paquete descargable:  ${summary.withDownloadablePackage} (el servidor no registra descargas)`);
      for (const x of legacy) {
        console.log(`  - run ${x.runId} curso ${x.courseId} dueño ${x.ownerId} manifest ${x.manifestId} ` +
          `preview=${x.previewComponents.length} paquete=${x.packageBuilt ? 'sí' : 'no'} descargable=${x.packageDownloadable ? 'sí' : 'no'}`);
      }
      console.log(`  paquetes QA/degradados en la carpeta del dueño (legibles por el dueño vía Storage; solo staging): ${ownerFolderQa.length}`);
      for (const a of ownerFolderQa) {
        console.log(`  - artifact ${a.artifactId} (${a.packageKind}) run ${a.runId} job ${a.packageJobId} curso ${a.courseId} dueño ${a.ownerId}`);
      }
    }
  } catch (err) {
    code = 1;
    try { await client.query('rollback'); } catch { /* nada */ }
    console.error(`❌ el reporte falló (no se escribió nada): ${err && err.message ? err.message : err}`);
  } finally {
    await client.end();
  }
  process.exit(code);
})().catch((err) => {
  console.error(`❌ fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
