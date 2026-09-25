'use strict';

// ══════════════════════════════════════════════════════════════════════════
// Fuente ÚNICA de los CHECK de public.production_jobs (execution_mode y
// worker_status). La usan:
//   - scripts/migrate-production-jobs-constraints.js (lo corre deploy.yml en
//     cada push a main), y
//   - scripts/prod/migrate-v2-production.js, paso 0 (release-fix C1: el
//     esquema V2 se aplica ANTES de mergear el código, así que el runner ya no
//     puede exigir que deploy.yml haya ensanchado el CHECK primero).
// Mismo SQL en los dos caminos → mismo pg_get_constraintdef (lo verifica
// scripts/prod/test/run-local-pg-tests.js).
// ══════════════════════════════════════════════════════════════════════════

const EXECUTION_MODES = Object.freeze([
  'frontend',
  'backend_content',
  'backend_audio',
  'backend_videos',
  'backend_h5p',
  'backend_gamma',
  'backend_package',
  'backend_package_base',
  'course_full_generation',
  'backend_full_future',
  // Fase 5A (ejecución dinámica real): el "run" de generación es un
  // production_job normal con este execution_mode (spec §3.2) — sin esto,
  // insertar la fila del run se rechaza con 23514 antes de siquiera llegar al
  // índice único parcial uq_dynamic_generation_active_run
  // (supabase-migration-dynamic-generation.sql).
  'dynamic_generation',
  // Fase 5B.1 (empaquetado Moodle dinámico): el job que produce el .mbz de un
  // run 5A completado (spec §7/§10, plan B3).
  'dynamic_package',
]);

const WORKER_STATUSES = Object.freeze([
  'queued',
  'running',
  'waiting_external',
  'retrying',
  'paused',
  'pausing',
  'cancelling',
  'completed',
  'failed',
  'failed_recoverable',
  'failed_retryable',
  'needs_reconnect',
  'blocked_quota',
  'cancelled',
]);

const quoteList = (xs) => xs.map((x) => `'${x}'`).join(', ');

/** Sentencias (en orden) que reconstruyen ambos CHECK. Van dentro de UNA transacción. */
const APPLY_STATEMENTS = Object.freeze([
  `alter table if exists public.production_jobs drop constraint if exists production_jobs_execution_mode_check`,
  `alter table if exists public.production_jobs add constraint production_jobs_execution_mode_check
     check (execution_mode in (${quoteList(EXECUTION_MODES)}))`,
  `alter table if exists public.production_jobs drop constraint if exists production_jobs_worker_status_check`,
  `alter table if exists public.production_jobs add constraint production_jobs_worker_status_check
     check (worker_status is null or worker_status in (${quoteList(WORKER_STATUSES)}))`,
]);

/**
 * DN-6 (solo lectura): filas existentes que violarían los CHECK nuevos. Mismo
 * criterio que el chequeo pre-merge documentado en
 * docs/v2-production-migrations.md. Devuelve histogramas de los valores
 * ofensores (valor → cantidad).
 */
async function findViolations(client) {
  const em = await client.query(
    `select coalesce(execution_mode, '(null)') as v, count(*)::int as n from public.production_jobs
      where execution_mode is null or not (execution_mode = any($1::text[])) group by 1 order by 1`,
    [EXECUTION_MODES],
  );
  const ws = await client.query(
    `select worker_status as v, count(*)::int as n from public.production_jobs
      where worker_status is not null and not (worker_status = any($1::text[])) group by 1 order by 1`,
    [WORKER_STATUSES],
  );
  const total = (rows) => rows.reduce((a, r) => a + r.n, 0);
  return {
    executionMode: em.rows,
    workerStatus: ws.rows,
    wouldViolateExecutionMode: total(em.rows),
    wouldViolateWorkerStatus: total(ws.rows),
  };
}

/** Valores literales de un pg_get_constraintdef (`'x'::text`). */
function literalsOf(def) {
  return new Set([...String(def || '').matchAll(/'([^']*)'/g)].map((m) => m[1]));
}
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/** Estado actual de ambos CHECK: definición, valores aceptados y si ya coinciden con la lista objetivo. */
async function currentState(client) {
  const { rows } = await client.query(
    `select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'public.production_jobs'::regclass
        and conname in ('production_jobs_execution_mode_check', 'production_jobs_worker_status_check')`,
  );
  const byName = Object.fromEntries(rows.map((r) => [r.conname, r.def]));
  const em = byName.production_jobs_execution_mode_check || null;
  const ws = byName.production_jobs_worker_status_check || null;
  const emVals = literalsOf(em);
  const wsVals = literalsOf(ws);
  const target = { em: new Set(EXECUTION_MODES), ws: new Set(WORKER_STATUSES) };
  return {
    executionModeDef: em,
    workerStatusDef: ws,
    upToDate: !!em && !!ws && sameSet(emVals, target.em) && sameSet(wsVals, target.ws) && /is null/i.test(ws),
    removedExecutionModes: [...emVals].filter((v) => !target.em.has(v)),
    removedWorkerStatuses: [...wsVals].filter((v) => !target.ws.has(v)),
  };
}

module.exports = { EXECUTION_MODES, WORKER_STATUSES, APPLY_STATEMENTS, findViolations, currentState };
