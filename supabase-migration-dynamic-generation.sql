-- ══════════════════════════════════════════════════════════════════════════
-- Dynamic course structure — Fase 5A (ejecución): generation_item_runs +
-- generation_run_contexts + índice de run único + columnas de artifacts.
-- Ver docs/superpowers/specs/2026-09-24-dynamic-course-structure-fase5-generation-design.md
-- (§3.2–§3.7) y el brief de Task 1.
--
-- 100% aditivo. Corre exclusivamente contra la base de datos de Supabase de
-- STAGING — ver scripts/migrate-dynamic-generation.js para el guardarraíl que
-- lo exige. Idempotente: se re-corre en cada deploy a staging.
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

-- Items de un run de generación dinámica (1 run = 1 production_job con
-- execution_mode='dynamic_generation'). Misma máquina de estados y campos de
-- claim/lease/retry que production_jobs, para reutilizar los mismos patrones
-- SQL (claim FOR UPDATE SKIP LOCKED, heartbeat, retry con backoff).
create table if not exists public.generation_item_runs (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.production_jobs(id) on delete cascade,
  course_id       integer not null references public.courses(id) on delete cascade,
  blueprint_id    integer not null,
  manifest_id     integer not null references public.course_generation_manifests(id) on delete cascade,
  item_key        text not null,
  generation      integer not null default 1 check (generation >= 1),
  type            text not null check (type in ('content','scorm','video','exam')),
  module_id       uuid not null,
  chapter_id      uuid,
  depends_on      text[] not null default '{}',
  status          text not null default 'pending'
                  check (status in ('pending','running','retrying','completed','failed','blocked','cancelled')),
  worker_id       text,
  lease_until     timestamptz,
  claimed_at      timestamptz,
  attempt_count   integer not null default 0,
  max_attempts    integer not null default 3,
  next_retry_at   timestamptz,
  error           text,
  idempotency_key char(64) not null,
  output_summary  jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz,
  -- El Blueprint referenciado debe pertenecer al mismo curso (misma técnica
  -- de FK compuesta que cgm_blueprint_fk en course_generation_manifests).
  constraint gir_blueprint_fk foreign key (blueprint_id, course_id)
    references public.course_blueprints (id, course_id) on delete cascade,
  constraint gir_item_generation_key unique (manifest_id, item_key, generation),
  constraint gir_idempotency_key unique (idempotency_key),
  -- Un item exam es de alcance módulo (sin chapter_id); cualquier otro tipo
  -- es de alcance capítulo (chapter_id obligatorio).
  constraint gir_chapter_scope check ((type = 'exam') = (chapter_id is null))
);
create index if not exists idx_gir_claim on public.generation_item_runs (job_id, status, type);
create index if not exists idx_gir_manifest on public.generation_item_runs (manifest_id);

-- Contexto congelado del run: 1:1 con el production_job, inmutable (spec
-- §3.5 y condición vinculante §7 — el ejecutor nunca lee `D`, siempre lee
-- este snapshot vía backend). context_hash = sha256(canonical(context)),
-- ver scripts/audit-dynamic-generation.js para la forma canónica exacta
-- (debe ser la MISMA que use Task 2 al escribir esta tabla).
create table if not exists public.generation_run_contexts (
  job_id        uuid primary key references public.production_jobs(id) on delete cascade,
  manifest_id   integer not null references public.course_generation_manifests(id) on delete cascade,
  context       jsonb not null,
  context_hash  char(64) not null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_grc_manifest on public.generation_run_contexts (manifest_id);

create or replace function public.generation_run_contexts_forbid_update() returns trigger
language plpgsql as $$
begin
  raise exception 'generation_run_contexts es inmutable (job_id=%)', old.job_id using errcode = 'P0001';
end $$;

drop trigger if exists generation_run_contexts_immutable on public.generation_run_contexts;
create trigger generation_run_contexts_immutable before update on public.generation_run_contexts
  for each row execute function public.generation_run_contexts_forbid_update();

-- A lo sumo un run activo por Manifest (spec §3.3). Envuelto en un DO block
-- que chequea pg_indexes primero — lección de Fase 3: un re-run del deploy
-- no debe tomar ningún lock fuerte sobre production_jobs (tabla caliente)
-- cuando el índice ya existe.
do $$
declare
  idx_exists boolean;
begin
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename = 'production_jobs'
       and indexname = 'uq_dynamic_generation_active_run'
  ) into idx_exists;

  if not idx_exists then
    create unique index uq_dynamic_generation_active_run
      on public.production_jobs ((input_payload->>'manifestId'))
      where execution_mode = 'dynamic_generation'
        and worker_status in ('queued','running','retrying','waiting_child');
  end if;
end $$;

-- Columnas nuevas de artifacts (spec §3.7): vinculan un artifact dynamic con
-- su Manifest/item/run. Cada columna se agrega en su propio DO block que
-- chequea information_schema.columns primero — mismo patrón que
-- supabase-migration-course-blueprints.sql (courses.current_blueprint_id):
-- `alter table ... add column if not exists` igual toma un lock ACCESS
-- EXCLUSIVE sobre `artifacts` ANTES de evaluar el "if not exists", así que en
-- cada re-deploy, con tráfico concurrente sobre `artifacts` (tabla caliente),
-- eso puede tirar el deploy abajo con lock_timeout=5s. El chequeo previo por
-- catálogo evita tomar ese lock cuando la columna ya está.
do $$
declare
  col_exists boolean;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'artifacts' and column_name = 'manifest_id'
  ) into col_exists;
  if not col_exists then
    alter table public.artifacts add column manifest_id integer;
  end if;
end $$;

do $$
declare
  col_exists boolean;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'artifacts' and column_name = 'manifest_item_key'
  ) into col_exists;
  if not col_exists then
    alter table public.artifacts add column manifest_item_key text;
  end if;
end $$;

do $$
declare
  col_exists boolean;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'artifacts' and column_name = 'item_run_id'
  ) into col_exists;
  if not col_exists then
    alter table public.artifacts add column item_run_id uuid;
  end if;
end $$;

-- FKs de las columnas nuevas, agregadas por separado del ADD COLUMN para
-- poder chequear pg_constraint sin volver a tocar la columna cuando ya
-- existe (misma técnica que courses_current_blueprint_fk en
-- supabase-migration-course-blueprints.sql).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'artifacts_manifest_id_fk') then
    alter table public.artifacts add constraint artifacts_manifest_id_fk
      foreign key (manifest_id) references public.course_generation_manifests(id) on delete set null;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'artifacts_item_run_id_fk') then
    alter table public.artifacts add constraint artifacts_item_run_id_fk
      foreign key (item_run_id) references public.generation_item_runs(id) on delete set null;
  end if;
end $$;
