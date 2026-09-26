-- ══════════════════════════════════════════════════════════════════════════
-- Cursia V2.1 — R3: Blueprint v2 (toggles de producto) + perfiles de curso.
-- Spec: campuscloud-gen docs/v21/2026-09-26-cursia-v21-experience-audit.md
--       ("DECISIONES VIGENTES", §M.1, §M.2, §K.2, §S).
--
-- 100% aditivo e idempotente. Corre exclusivamente contra la base de STAGING
-- (ver scripts/migrate-v21-blueprint-profiles.js para el guardarraíl). Cada
-- paso chequea el catálogo primero para no pedir locks fuertes cuando ya
-- está aplicado (mismo criterio que supabase-migration-course-blueprints.sql).
--
--   course_chapters.activity_enabled  boolean not null default true
--   courses.final_exam_enabled        boolean not null default true
--   courses.activity_engine           text    not null default 'h5p'
--                                     check (activity_engine in ('h5p','scorm'))
--   course_profiles                   perfiles versionados append-only
--                                     (presentation / assessment), FUERA del
--                                     Blueprint, del Manifest y de toda huella
--                                     de invalidación.
--
-- Los defaults hacen que las filas existentes queden como "todo ON" (igual
-- que un Blueprint v1: activityEnabled=true), SALVO los cursos dinámicos que
-- ya existían al agregar las columnas: finalExam=false y activityEngine=
-- 'scorm' (lectura de legado de §S; fix round 1, M2). Cursos nuevos: default
-- h5p + examen final ON (DECISIONES VIGENTES). Los snapshots v1 ya congelados
-- no se tocan (el sha de un v1 no cambia).
--
-- Rollback (solo si ningún código V2.1 lee las columnas/tabla):
--   drop table if exists public.course_profiles;
--   drop function if exists public.course_profiles_forbid_update();
--   drop function if exists public.course_profiles_forbid_direct_delete();
--   alter table public.courses drop constraint if exists courses_activity_engine_check;
--   alter table public.courses drop column if exists activity_engine;
--   alter table public.courses drop column if exists final_exam_enabled;
--   alter table public.course_chapters drop column if exists activity_enabled;
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

-- ── course_chapters.activity_enabled ────────────────────────────────────────
do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'course_chapters'
       and column_name = 'activity_enabled'
  ) then
    alter table public.course_chapters add column activity_enabled boolean not null default true;
  end if;
end $$;

-- ── courses.final_exam_enabled ──────────────────────────────────────────────
do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'courses'
       and column_name = 'final_exam_enabled'
  ) then
    alter table public.courses add column final_exam_enabled boolean not null default true;
    -- Fix round 1 (review G2 M2, audit §S): los cursos dinámicos que YA existían
    -- no tenían examen final; se leen como finalExam=false (solo al agregar la
    -- columna: re-correr la migración nunca pisa lo que el usuario eligió).
    update public.courses set final_exam_enabled = false where structure_version = 'dynamic';
  end if;
end $$;

-- ── courses.activity_engine ─────────────────────────────────────────────────
do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'courses'
       and column_name = 'activity_engine'
  ) then
    alter table public.courses add column activity_engine text not null default 'h5p';
    -- Fix round 1 (M2, §S): sus actividades existentes son SCORM → motor 'scorm'
    -- (así re-confirmarlos en v3 reutiliza la variante, sin cambiar de motor).
    update public.courses set activity_engine = 'scorm' where structure_version = 'dynamic';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'courses_activity_engine_check' and conrelid = 'public.courses'::regclass
  ) then
    alter table public.courses add constraint courses_activity_engine_check
      check (activity_engine in ('h5p', 'scorm'));
  end if;
end $$;

-- ── course_profiles ─────────────────────────────────────────────────────────
create table if not exists public.course_profiles (
  id          serial primary key,
  course_id   integer not null references public.courses(id) on delete cascade,
  kind        text not null,
  version     integer not null,
  data        jsonb not null,
  sha256      char(64) not null,
  created_by  varchar(36),
  created_at  timestamptz not null default now(),
  constraint course_profiles_kind_check check (kind in ('presentation', 'assessment')),
  constraint course_profiles_version_check check (version >= 1),
  constraint course_profiles_course_kind_version_key unique (course_id, kind, version)
);
create index if not exists idx_course_profiles_course_kind on public.course_profiles (course_id, kind);

-- Append-only: ninguna fila se modifica.
create or replace function public.course_profiles_forbid_update() returns trigger
language plpgsql as $$
begin
  raise exception 'course_profiles es append-only (id=%)', old.id using errcode = 'P0001';
end $$;

drop trigger if exists course_profiles_immutable on public.course_profiles;
create trigger course_profiles_immutable before update on public.course_profiles
  for each row execute function public.course_profiles_forbid_update();

-- DELETE solo por la cascada del curso: cuando la acción referencial corre,
-- la fila del curso ya no es visible; un DELETE directo (curso vivo) se
-- rechaza.
create or replace function public.course_profiles_forbid_direct_delete() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from public.courses where id = old.course_id) then
    raise exception 'course_profiles es append-only: solo se borra por cascada del curso (id=%)', old.id
      using errcode = 'P0001';
  end if;
  return old;
end $$;

drop trigger if exists course_profiles_no_direct_delete on public.course_profiles;
create trigger course_profiles_no_direct_delete before delete on public.course_profiles
  for each row execute function public.course_profiles_forbid_direct_delete();
