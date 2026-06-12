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

    // ── CREATE TABLE IF NOT EXISTS ──────────────────────────────────────────
    // El script antes solo hacía ALTER — si la tabla no existía, no se creaba
    // y todos los eventos se perdían silenciosamente en producción.
    await client.query(`
      create table if not exists public.usage_events (
        id                  uuid        primary key default gen_random_uuid(),
        user_id             varchar(36) not null,
        user_email          varchar(255),
        organization_id     varchar(120),
        event_type          varchar(60)  not null,
        component           varchar(40),
        failed              boolean     not null default false,
        error_message       text,
        tokens_input        int,
        tokens_output       int,
        ai_model            varchar(100),
        ai_provider         varchar(50),
        provider            varchar(60),
        model               varchar(120),
        mode                varchar(20),
        estimated_cost_usd  numeric(12,8),
        real_cost_usd       numeric(12,8),
        cost_type           varchar(20),
        cost_source         varchar(40),
        units               numeric(14,4),
        unit_type           varchar(40),
        unit_price_usd      numeric(12,8),
        video_job_id        varchar(100),
        video_batch_id      varchar(100),
        video_count         int,
        course_id           varchar(120),
        job_id              varchar(120),
        parent_job_id       varchar(120),
        duration_ms         int,
        metadata            jsonb,
        created_at          timestamptz not null default now()
      );
    `);

    await client.query(`
      create index if not exists idx_usage_events_user_id_created   on public.usage_events (user_id, created_at desc);
      create index if not exists idx_usage_events_event_type_created on public.usage_events (event_type, created_at desc);
    `);

    await client.query(`
      create table if not exists public.cost_rates (
        id              serial      primary key,
        provider        varchar(50) not null,
        service         varchar(80) not null,
        model           varchar(100),
        unit_type       varchar(30) not null,
        rate_usd        numeric(12,8) not null,
        is_active       boolean not null default true,
        effective_from  date,
        notes           text,
        source          varchar(40) default 'configured_rate',
        created_at      timestamptz not null default now(),
        updated_at      timestamptz not null default now()
      );
    `);

    // Remove duplicate active rows before creating unique index.
    // Keeps the row with the lowest id for each (provider, service, model, unit_type) where is_active.
    // This is idempotent: if no duplicates exist, the DELETE is a no-op.
    await client.query(`
      delete from public.cost_rates
      where is_active = true
        and id not in (
          select min(id)
          from public.cost_rates
          where is_active = true
          group by provider, service, coalesce(model,''), unit_type
        );
    `);

    await client.query(`
      create unique index if not exists idx_cost_rates_unique
        on public.cost_rates (provider, service, coalesce(model,''), unit_type)
        where is_active = true;
    `);

    // ── SEED cost_rates si está vacía ───────────────────────────────────────
    const { rows: crRows } = await client.query('select count(*) as n from public.cost_rates');
    if (parseInt(crRows[0].n, 10) === 0) {
      await client.query(`
        insert into public.cost_rates (provider, service, model, unit_type, rate_usd, is_active, effective_from, notes, source) values
          ('anthropic','chat_completion','claude-3-5-sonnet-20241022','per_1k_input_tokens', 0.003,  true,'2024-10-22','Claude 3.5 Sonnet input','configured_rate'),
          ('anthropic','chat_completion','claude-3-5-sonnet-20241022','per_1k_output_tokens',0.015,  true,'2024-10-22','Claude 3.5 Sonnet output','configured_rate'),
          ('anthropic','chat_completion','claude-sonnet-4-5',         'per_1k_input_tokens', 0.003,  true,'2025-01-01','Claude Sonnet 4.5 input','configured_rate'),
          ('anthropic','chat_completion','claude-sonnet-4-5',         'per_1k_output_tokens',0.015,  true,'2025-01-01','Claude Sonnet 4.5 output','configured_rate'),
          ('anthropic','chat_completion','claude-sonnet-4-6',         'per_1k_input_tokens', 0.003,  true,'2025-01-01','Claude Sonnet 4.6 input','configured_rate'),
          ('anthropic','chat_completion','claude-sonnet-4-6',         'per_1k_output_tokens',0.015,  true,'2025-01-01','Claude Sonnet 4.6 output','configured_rate'),
          ('openai',   'chat_completion','gpt-4o-mini',               'per_1k_input_tokens', 0.00015,true,'2025-01-01','GPT-4o-mini input','configured_rate'),
          ('openai',   'chat_completion','gpt-4o-mini',               'per_1k_output_tokens',0.0006, true,'2025-01-01','GPT-4o-mini output','configured_rate'),
          ('openai_tts','audio_generation','gpt-4o-mini-tts',         'per_1k_characters',   0.0006, true,'2025-01-01','OpenAI TTS gpt-4o-mini-tts','configured_rate'),
          ('openai_tts','audio_generation','tts-1',                   'per_1k_characters',   0.015,  true,'2025-01-01','OpenAI TTS tts-1','configured_rate')
        on conflict do nothing;
      `);
      console.log('cost_rates seeded');
    }

    // ── ALTER TABLE — agregar columnas nuevas si la tabla ya existía ─────────
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
