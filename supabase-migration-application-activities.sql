-- ══════════════════════════════════════════════════════════════════════════
-- Cursia — Fase 2: Actividades de Aplicación.
--
--   course_chapters.application_minutes ∈ (30, 60, 90, 120) o null (sin actividad)
--   generation_item_runs.gir_type_check: + 'application_activity'
--   course_generation_manifests.application_activity_count (default 0) y cgm_counts_consistent con
--   capítulos de práctica (corrige el CHECK de v21-manifest-v3) y Actividades de Aplicación
--
-- Aditiva e idempotente: las filas existentes quedan null y sus Blueprints, Manifests y huellas no
-- cambian (el snapshot solo incluye `applicationMinutes` en los capítulos que la tienen). Los minutos
-- son los niveles del modelo de tiempo (study-time STUDY_TIME_RULES.applicationActivityTiers).
--
-- Rollback (solo si no hay actividades que conservar):
--   begin;
--   alter table public.course_chapters drop constraint if exists course_chapters_application_minutes_check;
--   alter table public.course_chapters drop column if exists application_minutes;
--   commit;
-- (Los Blueprints congelados con Actividades de Aplicación dejan de poder recanonicalizarse con el backend
--  anterior: no revertir el backend sin antes reconfirmar esos cursos sin actividades.)
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'course_chapters'
       and column_name = 'application_minutes'
  ) then
    alter table public.course_chapters add column application_minutes smallint null;
  end if;
  if not exists (
    select 1 from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'course_chapters' and c.conname = 'course_chapters_application_minutes_check'
  ) then
    alter table public.course_chapters add constraint course_chapters_application_minutes_check
      check (application_minutes is null or application_minutes in (30, 60, 90, 120));
  end if;
end $$;

-- ── generation_item_runs: + application_activity (scope 'chapter', como el resto de los tipos de capítulo) ──
-- (Cada bloque exige su tabla: una base sin la generación dinámica — p. ej. la de un test — solo recibe la columna.)
do $$ begin
  -- Solo sobre el CHECK v3 (v21-manifest-v3 aplicada): no adelanta esa migración.
  if exists (
    select 1 from pg_constraint
     where conname = 'gir_type_check' and conrelid = to_regclass('public.generation_item_runs')
       and pg_get_constraintdef(oid) like '%audiobook_chapter%'
       and pg_get_constraintdef(oid) not like '%application_activity%'
  ) then
    alter table public.generation_item_runs drop constraint if exists gir_type_check;
    alter table public.generation_item_runs add constraint gir_type_check
      check (type in ('content', 'scorm', 'video', 'exam', 'course_plan', 'course_intro', 'module_intro',
                      'experience', 'presentation', 'video_interactions', 'activity', 'audiobook_chapter',
                      'audio_welcome', 'final_exam', 'application_activity'));
  end if;
end $$;
-- gir_type_scope y el trigger de scope ya clasifican cualquier tipo nuevo como 'chapter' (rama else).

-- ── course_generation_manifests: conteo de actividades + CHECK de conteos con práctica y actividades ──
do $$ begin
  if to_regclass('public.course_generation_manifests') is not null and not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'course_generation_manifests'
                    and column_name = 'application_activity_count') then
    alter table public.course_generation_manifests
      add column application_activity_count integer not null default 0 check (application_activity_count >= 0);
  end if;
end $$;

-- cgm_counts_consistent (mismo nombre): v1/v2 EXACTAMENTE como antes (content_count = chapter_count y sin
-- actividades). v3: además del capítulo de contenido de siempre admite capítulos de PRÁCTICA (motor de carga
-- horaria: sin content/presentation/audiobook propios → esos conteos = content_count ≤ chapter_count; corrige
-- el CHECK de la migración v21-manifest-v3, que exigía content = presentation = audiobook = chapter_count) y
-- Actividades de Aplicación (≤ chapter_count), que suman a total_jobs.
do $$ begin
  if to_regclass('public.course_generation_manifests') is not null
     and exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'course_generation_manifests' and column_name = 'audiobook_chapter_count')
     and exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'course_generation_manifests' and column_name = 'application_activity_count')
     and not exists (
    select 1 from pg_constraint
     where conname = 'cgm_counts_consistent' and conrelid = to_regclass('public.course_generation_manifests')
       and pg_get_constraintdef(oid) like '%application_activity_count%'
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
          and final_exam_count = 0 and application_activity_count = 0
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
          and final_exam_count between 0 and 1)
      )
      and total_jobs = content_count + scorm_count + video_count + exam_count
                       + course_plan_count + course_intro_count + module_intro_count
                       + experience_count + presentation_count + video_interactions_count
                       + activity_count + audiobook_chapter_count + audio_welcome_count + final_exam_count
                       + application_activity_count);
  end if;
end $$;
