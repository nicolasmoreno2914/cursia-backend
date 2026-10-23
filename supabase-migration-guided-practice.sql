-- ══════════════════════════════════════════════════════════════════════════
-- Cursia — Loop 9 B: Práctica guiada del capítulo (formativa, sin nota; NO es una Actividad de Aplicación).
--
--   course_chapters.guided_practice_minutes ∈ (40, 60, 80, 120) o null (sin práctica guiada)
--   generation_item_runs.gir_type_check: + 'guided_practice'
--   course_generation_manifests.guided_practice_count (default 0) y cgm_counts_consistent con prácticas guiadas
--   (solo capítulos de contenido: ≤ content_count; suman a total_jobs)
--
-- Aditiva e idempotente, SOLO staging. Corre DESPUÉS de supabase-migration-application-activities.sql (reescribe los
-- CHECK que esa migración crea; sin ella no hace nada sobre esos CHECK). Las filas existentes quedan null y sus
-- Blueprints, Manifests y huellas no cambian (el snapshot solo incluye `guidedPracticeMinutes` en los capítulos que la
-- tienen). Los minutos son los niveles del modelo de tiempo (study-time STUDY_TIME_RULES.guidedPracticeTiers).
--
-- Rollback (solo si no hay prácticas guiadas que conservar):
--   begin;
--   alter table public.course_chapters drop constraint if exists course_chapters_guided_practice_minutes_check;
--   alter table public.course_chapters drop column if exists guided_practice_minutes;
--   commit;
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'course_chapters'
       and column_name = 'guided_practice_minutes'
  ) then
    alter table public.course_chapters add column guided_practice_minutes smallint null;
  end if;
  if not exists (
    select 1 from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'course_chapters' and c.conname = 'course_chapters_guided_practice_minutes_check'
  ) then
    alter table public.course_chapters add constraint course_chapters_guided_practice_minutes_check
      check (guided_practice_minutes is null or guided_practice_minutes in (40, 60, 80, 120));
  end if;
end $$;

-- ── generation_item_runs: + guided_practice (scope 'chapter', como el resto de los tipos de capítulo) ──
do $$ begin
  -- Solo sobre el CHECK que ya tiene application_activity (migración de Actividades de Aplicación aplicada).
  if exists (
    select 1 from pg_constraint
     where conname = 'gir_type_check' and conrelid = to_regclass('public.generation_item_runs')
       and pg_get_constraintdef(oid) like '%application_activity%'
       and pg_get_constraintdef(oid) not like '%guided_practice%'
  ) then
    alter table public.generation_item_runs drop constraint if exists gir_type_check;
    alter table public.generation_item_runs add constraint gir_type_check
      check (type in ('content', 'scorm', 'video', 'exam', 'course_plan', 'course_intro', 'module_intro',
                      'experience', 'presentation', 'video_interactions', 'activity', 'audiobook_chapter',
                      'audio_welcome', 'final_exam', 'application_activity', 'guided_practice'));
  end if;
end $$;
-- gir_type_scope y el trigger de scope ya clasifican cualquier tipo nuevo como 'chapter' (rama else).

-- ── course_generation_manifests: conteo de prácticas guiadas + CHECK de conteos ──
do $$ begin
  if to_regclass('public.course_generation_manifests') is not null and not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'course_generation_manifests'
                    and column_name = 'guided_practice_count') then
    alter table public.course_generation_manifests
      add column guided_practice_count integer not null default 0 check (guided_practice_count >= 0);
  end if;
end $$;

-- cgm_counts_consistent (mismo nombre): igual que el de Actividades de Aplicación + guided_practice_count (0 en v1/v2;
-- en v3 ≤ content_count porque solo existe en capítulos de contenido) sumado a total_jobs.
do $$ begin
  if to_regclass('public.course_generation_manifests') is not null
     and exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'course_generation_manifests' and column_name = 'audiobook_chapter_count')
     and exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'course_generation_manifests' and column_name = 'application_activity_count')
     and exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'course_generation_manifests' and column_name = 'guided_practice_count')
     and not exists (
    select 1 from pg_constraint
     where conname = 'cgm_counts_consistent' and conrelid = to_regclass('public.course_generation_manifests')
       and pg_get_constraintdef(oid) like '%guided_practice_count%'
  ) then
    alter table public.course_generation_manifests drop constraint if exists cgm_counts_consistent;
    alter table public.course_generation_manifests add constraint cgm_counts_consistent check (
      video_count <= chapter_count and exam_count <= module_count
      and (
        (rules_version in (1, 2)
          and content_count = chapter_count
          and scorm_count = chapter_count
          and experience_count = 0 and presentation_count = 0 and video_interactions_count = 0
          and activity_count = 0 and audiobook_chapter_count = 0 and audio_welcome_count = 0
          and final_exam_count = 0 and application_activity_count = 0 and guided_practice_count = 0
          and (
            (rules_version = 1 and course_plan_count = 0 and course_intro_count = 0 and module_intro_count = 0)
            or (rules_version = 2 and course_plan_count = 1 and course_intro_count = 1 and module_intro_count = module_count)
          ))
        or (rules_version = 3
          and content_count <= chapter_count and content_count >= module_count
          and scorm_count = 0
          and course_plan_count = 1 and course_intro_count = 1 and module_intro_count = module_count
          and audio_welcome_count = 1
          and experience_count = chapter_count and presentation_count = content_count
          and audiobook_chapter_count = content_count
          and video_interactions_count = video_count and video_count <= content_count
          and activity_count <= chapter_count
          and application_activity_count <= chapter_count
          and guided_practice_count <= content_count
          and final_exam_count between 0 and 1)
      )
      and total_jobs = content_count + scorm_count + video_count + exam_count
                       + course_plan_count + course_intro_count + module_intro_count
                       + experience_count + presentation_count + video_interactions_count
                       + activity_count + audiobook_chapter_count + audio_welcome_count + final_exam_count
                       + application_activity_count + guided_practice_count);
  end if;
end $$;
