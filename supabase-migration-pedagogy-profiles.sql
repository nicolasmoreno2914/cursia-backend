-- ══════════════════════════════════════════════════════════════════════════
-- Cursia — Motor pedagógico V1: perfil pedagógico del curso.
--
--   course_profiles.kind ∈ ('presentation', 'assessment', 'pedagogy')
--
-- Solo AMPLÍA el CHECK de `kind` (mismo nombre de constraint): ninguna fila
-- existente cambia ni deja de cumplirlo. Aditiva e idempotente (si el CHECK
-- ya admite 'pedagogy' no hace nada). Sin perfil pedagógico guardado el
-- Blueprint y el Manifest de un curso son byte a byte los de antes.
--
-- Rollback (course_profiles es append-only: el trigger course_profiles_no_direct_delete
-- impide borrar filas sueltas, así que hay que desactivarlo SOLO para esta limpieza):
--   begin;
--   alter table public.course_profiles disable trigger course_profiles_no_direct_delete;
--   delete from public.course_profiles where kind = 'pedagogy';
--   alter table public.course_profiles enable trigger course_profiles_no_direct_delete;
--   alter table public.course_profiles drop constraint course_profiles_kind_check;
--   alter table public.course_profiles add constraint course_profiles_kind_check
--     check (kind in ('presentation', 'assessment'));
--   commit;
-- (Los Blueprints ya congelados con course.pedagogy siguen siendo legibles: el diseño vive en el snapshot.)
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
    alter table public.course_profiles drop constraint course_profiles_kind_check;
    alter table public.course_profiles add constraint course_profiles_kind_check
      check (kind in ('presentation', 'assessment', 'pedagogy'));
  end if;
end $$;
