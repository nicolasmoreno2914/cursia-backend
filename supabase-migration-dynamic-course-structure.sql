-- ══════════════════════════════════════════════════════════════════════════
-- Dynamic course structure — Fase 1 (modelo de datos, 100% aditivo)
-- Ver docs/superpowers/specs/2026-09-23-dynamic-course-structure-design.md
--
-- Esta migración SOLO agrega tablas/columnas nuevas. No modifica ni borra
-- ninguna fila existente. Corre exclusivamente contra la base de datos de
-- Supabase de STAGING — ver scripts/migrate-dynamic-course-structure.js
-- para el guardarraíl que lo exige.
-- ══════════════════════════════════════════════════════════════════════════

-- Falla rápido si otra transacción tiene tomada alguna tabla (los ALTER TABLE
-- de abajo piden ACCESS EXCLUSIVE sobre courses/artifacts/production_jobs).
set lock_timeout = '5s';

create table if not exists public.course_modules (
  id            uuid primary key default gen_random_uuid(),
  course_id     integer not null references public.courses(id) on delete cascade,
  position      integer not null,
  title         text not null,
  objective     text,
  exam_enabled  boolean not null default true,
  status        text not null default 'draft',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (course_id, position) deferrable initially deferred
);

create table if not exists public.course_chapters (
  id                          uuid primary key default gen_random_uuid(),
  course_id                   integer not null references public.courses(id) on delete cascade,
  module_id                   uuid not null references public.course_modules(id) on delete cascade,
  position                    integer not null,
  title                       text not null,
  objective                   text,
  video_enabled               boolean not null default false,
  status                      text not null default 'not_generated',
  context_summary             jsonb,
  generated_with_version_id   integer references public.course_versions(id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (module_id, position) deferrable initially deferred
);

alter table if exists public.courses
  add column if not exists structure_version text not null default 'legacy',
  add column if not exists structure_version_counter integer not null default 0;

alter table if exists public.course_versions
  add column if not exists locked_at timestamptz;

alter table if exists public.artifacts
  add column if not exists module_id uuid references public.course_modules(id) on delete set null,
  add column if not exists chapter_id uuid references public.course_chapters(id) on delete set null,
  add column if not exists status text,
  add column if not exists generated_with_version_id integer references public.course_versions(id) on delete set null;

alter table if exists public.production_jobs
  add column if not exists blueprint_version_id integer references public.course_versions(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'courses_structure_version_check') then
    alter table public.courses
      add constraint courses_structure_version_check
      check (structure_version in ('legacy', 'dynamic'));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'course_modules_status_check') then
    alter table public.course_modules
      add constraint course_modules_status_check
      check (status in ('draft', 'locked'));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'course_chapters_status_check') then
    alter table public.course_chapters
      add constraint course_chapters_status_check
      check (status in ('not_generated', 'generating', 'ready', 'stale', 'failed'));
  end if;
end $$;

create index if not exists idx_course_modules_course on public.course_modules(course_id);
create index if not exists idx_course_chapters_course on public.course_chapters(course_id);
create index if not exists idx_course_chapters_module on public.course_chapters(module_id);
create index if not exists idx_artifacts_module on public.artifacts(module_id);
create index if not exists idx_artifacts_chapter on public.artifacts(chapter_id);
create index if not exists idx_production_jobs_blueprint_version on public.production_jobs(blueprint_version_id);
