-- ══════════════════════════════════════════════════════════════════════════
-- SOLO TESTS LOCALES — nunca se aplica a un Supabase real.
-- Esquema "legacy" de producción ANTES de V2 (tal como lo describen
-- docs/SCHEMA_SUPABASE.sql y las entities TypeORM pre-V2), más stubs mínimos
-- de lo que Supabase provee (schema storage/auth, rol authenticated) para que
-- supabase-migration-storage-artifacts-policies.sql pueda correr en un
-- Postgres 16 desechable. Las restricciones de production_jobs son las de
-- `main` ANTES de V2 (execution_mode sin dynamic_generation/dynamic_package):
-- es lo que producción tiene hoy. Desde el release-fix C1 el runner
-- (paso 0) las ensancha él mismo; el harness también puede correr el script
-- REAL scripts/migrate-production-jobs-constraints.js (lo que haría deploy.yml).
--
-- Fidelidad (release review Minor 6): las 4 tablas compartidas (courses,
-- course_versions, artifacts, production_jobs) tienen EXACTAMENTE las columnas
-- que mapean las entities de `origin/main` (incluida courses.institution_id →
-- institutions). scripts/prod/test/run-legacy-app-compat-test.js lo exige.
-- ══════════════════════════════════════════════════════════════════════════

create table public.institutions (
  id         uuid primary key default gen_random_uuid(),
  owner_id   varchar(36) not null,
  name       varchar(255) not null,
  slug       varchar(120) not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.courses (
  id                 serial primary key,
  owner_id           varchar(36),
  owner_email        varchar(255),
  institution_id     uuid references public.institutions(id) on delete set null,
  title              varchar(255) not null,
  description        text,
  sector             varchar(100),
  level              varchar(100),
  status             varchar(50) not null default 'draft',
  metadata           jsonb,
  storage_provider   varchar(50),
  storage_folder_id  text,
  storage_folder_url text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.course_versions (
  id                  serial primary key,
  course_id           int not null references public.courses(id) on delete cascade,
  version_number      int not null default 1,
  status              varchar(50) not null default 'draft',
  notes               text,
  snapshot_json       jsonb,
  storage_provider    varchar(50),
  storage_file_id     text,
  storage_file_url    text,
  storage_folder_id   text,
  storage_path        text,
  snapshot_strategy   varchar(50),
  snapshot_size_bytes bigint,
  snapshot_size_human varchar(30),
  manifest_json       jsonb,
  created_at          timestamptz not null default now()
);

create table public.artifacts (
  id               uuid primary key default gen_random_uuid(),
  owner_id         varchar(36) not null,
  course_id        text,
  job_id           uuid,
  type             text not null,
  storage_provider varchar(50) not null default 'supabase',
  storage_bucket   text not null default 'cursia-artifacts',
  storage_path     text not null,
  filename         text,
  mime_type        text not null default 'application/octet-stream',
  size_bytes       bigint,
  checksum_sha256  text,
  metadata         jsonb default '{}',
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.production_jobs (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           varchar(36) not null,
  course_id          int,
  frontend_course_id text,
  frontend_job_id    text,
  status             varchar not null default 'queued',
  current_step       text,
  progress           int not null default 0,
  started_at         timestamptz,
  finished_at        timestamptz,
  error_message      text,
  error_step         text,
  retry_count        int not null default 0,
  options            jsonb default '{}',
  result             jsonb default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- P2.1 (legacy, ya aplicada en producción).
alter table public.production_jobs
  add column execution_mode text default 'frontend',
  add column worker_status text,
  add column worker_id text,
  add column lease_until timestamptz,
  add column claimed_at timestamptz,
  add column attempt_count integer not null default 0,
  add column max_attempts integer not null default 3,
  add column next_retry_at timestamptz,
  add column input_payload jsonb not null default '{}'::jsonb,
  add column output_summary jsonb not null default '{}'::jsonb,
  add column content_snapshot_artifact_id uuid null references public.artifacts(id) on delete set null;

-- CHECKs de `main` pre-V2 (scripts/migrate-production-jobs-constraints.js de
-- origin/main): SIN 'dynamic_generation' / 'dynamic_package'.
alter table public.production_jobs
  add constraint production_jobs_execution_mode_check
  check (execution_mode in ('frontend','backend_content','backend_audio','backend_videos','backend_h5p',
    'backend_gamma','backend_package','backend_package_base','course_full_generation','backend_full_future'));
alter table public.production_jobs
  add constraint production_jobs_worker_status_check
  check (worker_status is null or worker_status in ('queued','running','waiting_external','retrying','paused',
    'pausing','cancelling','completed','failed','failed_recoverable','failed_retryable','needs_reconnect',
    'blocked_quota','cancelled'));

create table public.usage_events (
  id                 uuid primary key default gen_random_uuid(),
  user_id            varchar(36) not null,
  event_type         varchar(60) not null,
  component          varchar(40),
  failed             boolean not null default false,
  estimated_cost_usd numeric(12,8),
  real_cost_usd      numeric(12,8),
  cost_type          varchar(20),
  course_id          varchar(120),
  metadata           jsonb,
  created_at         timestamptz not null default now()
);

create table public.cost_rates (
  id             serial primary key,
  provider       varchar(50) not null,
  service        varchar(80) not null,
  model          varchar(100),
  unit_type      varchar(30) not null,
  rate_usd       numeric(12,8) not null,
  is_active      boolean not null default true,
  effective_from date,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── Stubs de Supabase (solo para el Postgres local) ────────────────────────
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create schema if not exists storage;
create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text,
  name       text,
  owner      uuid,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$ select string_to_array(name, '/') $$;

-- ── Datos legacy (lo que producción ya tiene) ──────────────────────────────
insert into public.courses (owner_id, title, status)
  values ('00000000-0000-0000-0000-00000000aaaa', 'Curso legacy 1', 'draft'),
         ('00000000-0000-0000-0000-00000000aaaa', 'Curso legacy 2', 'published');
insert into public.course_versions (course_id, version_number) values (1, 1), (2, 1);
insert into public.artifacts (owner_id, course_id, type, storage_path, size_bytes)
  values ('00000000-0000-0000-0000-00000000aaaa', 'c-legacy-1', 'mbz_final', 'u/c/final.mbz', 1048576);
insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status)
  values ('00000000-0000-0000-0000-00000000aaaa', 1, 'frontend', 'completed', null),
         ('00000000-0000-0000-0000-00000000aaaa', 2, 'backend_content', 'completed', 'completed');
