-- ══════════════════════════════════════════════════════════════════════════
-- Cursia — r79.1: tipos de Actividad de Aplicación (estudio de caso, proyecto integrador, retroalimentación formativa).
--
--   course_chapters.application_kind ∈ ('case_study', 'integrative_project', 'formative_feedback') o null (la Actividad de
--   siempre). Solo con application_minutes (CHECK): un tipo sin Actividad no existe.
--
-- Los tipos viven DENTRO del item application_activity (mismo tipo de item, mismo CHECK de generation_item_runs, mismos
-- conteos del Manifest): no se toca ningún otro CHECK. Los niveles de cada tipo y dónde va (contenido / práctica) los
-- valida el Blueprint (study-time/application-kind-tiers.ts), igual que los de application_minutes.
--
-- Aditiva e idempotente, SOLO staging. Corre DESPUÉS de supabase-migration-application-activities.sql. Las filas
-- existentes quedan null: sus Blueprints, Manifests y huellas no cambian (el snapshot incluye `applicationKind` solo en
-- los capítulos que lo tienen).
--
-- Rollback (solo si no hay tipos que conservar):
--   begin;
--   alter table public.course_chapters drop constraint if exists course_chapters_application_kind_check;
--   alter table public.course_chapters drop column if exists application_kind;
--   commit;
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

do $$ begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'course_chapters' and column_name = 'application_minutes')
     and not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'course_chapters' and column_name = 'application_kind') then
    alter table public.course_chapters add column application_kind text null;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'course_chapters' and column_name = 'application_kind')
     and not exists (
    select 1 from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'course_chapters' and c.conname = 'course_chapters_application_kind_check'
  ) then
    alter table public.course_chapters add constraint course_chapters_application_kind_check
      check (application_kind is null
             or (application_kind in ('case_study', 'integrative_project', 'formative_feedback') and application_minutes is not null));
  end if;
end $$;

-- Verificación (falla fuerte si algo no quedó).
do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'course_chapters' and column_name = 'application_kind') then
    raise exception 'r79.1: falta course_chapters.application_kind';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'course_chapters_application_kind_check') then
    raise exception 'r79.1: falta course_chapters_application_kind_check';
  end if;
end $$;
