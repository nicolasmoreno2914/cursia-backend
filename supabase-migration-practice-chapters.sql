-- ══════════════════════════════════════════════════════════════════════════
-- Cursia — Motor de carga horaria (Fase 1, Loop 4): capítulo de práctica.
--
--   course_chapters.chapter_kind ∈ ('content', 'practice'), not null, default 'content'
--
-- Aditiva e idempotente: las filas existentes quedan 'content' y sus Blueprints, Manifests y huellas
-- no cambian (el snapshot solo incluye `kind` en los capítulos de práctica). Un capítulo de práctica no
-- tiene video, presentación, audiolibro ni Libro propio: lo valida la API y el builder del Blueprint.
--
-- Rollback (solo si no hay capítulos de práctica que conservar):
--   begin;
--   delete from public.course_chapters where chapter_kind = 'practice';  -- revisar antes: borra capítulos
--   alter table public.course_chapters drop constraint if exists course_chapters_chapter_kind_check;
--   alter table public.course_chapters drop column if exists chapter_kind;
--   commit;
-- (Los Blueprints congelados con capítulos de práctica dejan de poder recanonicalizarse con el backend
--  anterior: no revertir el backend sin antes reconfirmar esos cursos sin capítulos de práctica.)
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'course_chapters'
       and column_name = 'chapter_kind'
  ) then
    alter table public.course_chapters add column chapter_kind text not null default 'content';
  end if;
  if not exists (
    select 1 from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'course_chapters' and c.conname = 'course_chapters_chapter_kind_check'
  ) then
    alter table public.course_chapters add constraint course_chapters_chapter_kind_check
      check (chapter_kind in ('content', 'practice'));
  end if;
end $$;
