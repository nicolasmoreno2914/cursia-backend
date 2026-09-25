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

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));

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
  try {
    await client.query('begin');
    await client.query(`
      alter table if exists public.production_jobs
        drop constraint if exists production_jobs_execution_mode_check;
    `);
    await client.query(`
      alter table if exists public.production_jobs
        add constraint production_jobs_execution_mode_check
        check (
          execution_mode in (
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
            -- Fase 5A (ejecución dinámica real): el "run" de generación es un
            -- production_job normal con este execution_mode (spec §3.2) —
            -- sin esto, insertar la fila del run se rechaza con 23514 antes
            -- de siquiera llegar al índice único parcial de Task 1
            -- (uq_dynamic_generation_active_run en
            -- supabase-migration-dynamic-generation.sql).
            'dynamic_generation',
            -- Fase 5B.1 (empaquetado Moodle dinámico): el job que produce el
            -- .mbz de un run 5A completado (spec §7/§10, plan B3). Sin esto,
            -- insertar la fila del job en PackagingService.requestPackage se
            -- rechaza con 23514 antes de llegar a production_jobs.
            'dynamic_package',
            -- Brand Kit (extracción de marca desde PDF): BrandProfilesService
            -- inserta un production_job con este execution_mode al recibir
            -- POST /institutions/:id/brand-profiles/upload
            -- (brand-profiles.service.ts) y brand-extraction-worker.ts lo
            -- procesa. Faltaba en este allow-list (bug preexistente, ver
            -- supabase-migration-brand-extraction-execution-mode.sql, un
            -- archivo huérfano que nunca fue referenciado por ningún script
            -- ni workflow) — sin esto, el insert se rechaza con 23514 en
            -- cuanto un usuario sube un PDF de Brand Kit.
            'brand_extraction'
          )
        );
    `);

    await client.query(`
      alter table if exists public.production_jobs
        drop constraint if exists production_jobs_worker_status_check;
    `);
    await client.query(`
      alter table if exists public.production_jobs
        add constraint production_jobs_worker_status_check
        check (
          worker_status is null
          or worker_status in (
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
            'cancelled'
          )
        );
    `);
    await client.query('commit');
    console.log('production_jobs constraints migrated');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate-production-jobs-constraints] failed:', err.message || err);
  process.exit(1);
});
