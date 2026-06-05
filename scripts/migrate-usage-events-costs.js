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
      alter table if exists public.usage_events
        add column if not exists organization_id varchar(120),
        add column if not exists component varchar(40),
        add column if not exists provider varchar(60),
        add column if not exists model varchar(120),
        add column if not exists mode varchar(20),
        add column if not exists real_cost_usd numeric(12,8),
        add column if not exists cost_type varchar(20),
        add column if not exists cost_source varchar(40),
        add column if not exists units numeric(14,4),
        add column if not exists unit_type varchar(40),
        add column if not exists unit_price_usd numeric(12,8),
        add column if not exists job_id varchar(120),
        add column if not exists parent_job_id varchar(120);
    `);

    await client.query(`
      alter table if exists public.cost_rates
        add column if not exists source varchar(40) default 'configured_rate';
    `);

    await client.query(`
      update public.cost_rates
      set source = coalesce(source, 'configured_rate')
      where source is null;
    `);

    await client.query(`
      update public.usage_events
      set
        provider = coalesce(provider, ai_provider),
        model = coalesce(model, ai_model),
        component = coalesce(
          component,
          case
            when event_type like 'ia_%' then 'content'
            when event_type like 'video_%' then 'video'
            when event_type like 'youtube_%' then 'youtube'
            when event_type in ('welcome_audio_generated', 'audiobook_generated') then 'audio'
            when event_type in ('export_mbz', 'mbz_exported') then 'package'
            when event_type = 'cloud_save' then 'storage'
            else 'orchestration'
          end
        ),
        mode = coalesce(mode, 'unknown'),
        cost_type = coalesce(
          cost_type,
          case
            when coalesce(estimated_cost_usd, 0) > 0 then 'estimated'
            else 'unknown'
          end
        ),
        cost_source = coalesce(
          cost_source,
          case
            when coalesce(estimated_cost_usd, 0) > 0 then 'configured_rate'
            else 'not_tracked'
          end
        )
      where true;
    `);

    await client.query(`create index if not exists idx_usage_events_course_component_created on public.usage_events (course_id, component, created_at desc);`);
    await client.query(`create index if not exists idx_usage_events_job_id on public.usage_events (job_id);`);
    await client.query(`create index if not exists idx_usage_events_parent_job_id on public.usage_events (parent_job_id);`);
    await client.query(`create index if not exists idx_usage_events_cost_type on public.usage_events (cost_type);`);
    await client.query(`create index if not exists idx_usage_events_mode on public.usage_events (mode);`);

    await client.query('commit');
    console.log('usage_events cost tracking migrated');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate-usage-events-costs] failed:', err.message || err);
  process.exit(1);
});
