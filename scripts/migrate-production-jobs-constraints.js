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
            'backend_package',
            'backend_package_base',
            'course_full_generation',
            'backend_full_future'
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
