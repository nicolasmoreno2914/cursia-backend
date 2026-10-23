-- ══════════════════════════════════════════════════════════════════════════
-- Cursia — Fase 3: Contexto académico (Context Package del roadmap).
--
--   course_profiles.kind ∈ ('presentation', 'assessment', 'pedagogy', 'academic')
--   course_chapters.outcome_ids jsonb null — vínculos del capítulo a resultados de aprendizaje / competencias
--     del contexto académico: array de 1 a 8 ids "RA<n>" / "CO<n>" (null = sin vínculos)
--
-- Aditiva e idempotente: ninguna fila existente cambia (outcome_ids queda null) y los Blueprints, Manifests y
-- huellas de los cursos sin contexto son byte a byte los de antes (el snapshot solo incluye `outcomeIds` en los
-- capítulos que los tienen y `course.academicContext` solo con un contexto guardado).
-- SOLO staging (deploy-staging.yml, pasos 4h5c/4h5d); fuera del plan de producción.
--
-- Rollback (course_profiles es append-only: el trigger course_profiles_no_direct_delete impide borrar filas
-- sueltas, así que hay que desactivarlo SOLO para esta limpieza):
--   begin;
--   alter table public.course_chapters drop constraint if exists course_chapters_outcome_ids_check;
--   alter table public.course_chapters drop column if exists outcome_ids;
--   alter table public.course_profiles disable trigger course_profiles_no_direct_delete;
--   delete from public.course_profiles where kind = 'academic';
--   alter table public.course_profiles enable trigger course_profiles_no_direct_delete;
--   alter table public.course_profiles drop constraint course_profiles_kind_check;
--   alter table public.course_profiles add constraint course_profiles_kind_check
--     check (kind in ('presentation', 'assessment', 'pedagogy'));
--   commit;
-- (Los Blueprints congelados con course.academicContext dejan de recanonicalizarse con el backend anterior: no
--  revertir el backend sin antes reconfirmar esos cursos sin contexto.)
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

do $$
declare
  def text;
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public' and t.relname = 'course_profiles' and c.conname = 'course_profiles_kind_check';
  if def is null then
    raise exception 'course_profiles_kind_check no existe: correr antes supabase-migration-v21-blueprint-profiles.sql';
  end if;
  if position('''pedagogy''' in def) = 0 then
    raise exception 'course_profiles_kind_check no admite pedagogy: correr antes supabase-migration-pedagogy-profiles.sql';
  end if;
  if position('''academic''' in def) = 0 then
    alter table public.course_profiles drop constraint course_profiles_kind_check;
    alter table public.course_profiles add constraint course_profiles_kind_check
      check (kind in ('presentation', 'assessment', 'pedagogy', 'academic'));
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'course_chapters' and column_name = 'outcome_ids'
  ) then
    alter table public.course_chapters add column outcome_ids jsonb null;
  end if;
  if not exists (
    select 1 from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'course_chapters' and c.conname = 'course_chapters_outcome_ids_check'
  ) then
    -- jsonb::text es canónico (["RA1", "CO2"]): la forma completa se valida con una sola expresión inmutable.
    alter table public.course_chapters add constraint course_chapters_outcome_ids_check
      check (outcome_ids is null or (
        jsonb_typeof(outcome_ids) = 'array'
        and jsonb_array_length(outcome_ids) between 1 and 8
        and outcome_ids::text ~ '^\["(RA|CO)[0-9]{1,3}"(, "(RA|CO)[0-9]{1,3}")*\]$'
      ));
  end if;
end $$;
