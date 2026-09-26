-- ══════════════════════════════════════════════════════════════════════════
-- Cursia V2.1 — R4: Generation Manifest rulesVersion 3.
-- Spec: docs/v21/2026-09-26-cursia-v21-experience-audit.md §N.1/§N.2.
-- Requiere: supabase-migration-dynamic-generation-v2.sql (columna scope,
-- gir_type_check, gir_type_scope, conteos v2 de course_generation_manifests).
--
-- Aditiva e idempotente (mismo patrón que la migración v2: cada paso mira el
-- catálogo primero). Solo AGREGA columnas y REEMPLAZA CHECKs por superconjuntos
-- que TODAS las filas v1/v2 existentes ya cumplen (mismos nombres, así los
-- verificadores existentes siguen encontrándolos). Corre SOLO contra staging
-- (scripts/migrate-v21-manifest-v3.js tiene el guardarraíl).
--
-- generation_item_runs:
--   - gir_type_check: + experience, presentation, video_interactions, activity,
--     audiobook_chapter, audio_welcome, final_exam;
--   - scope por type (trigger de default + gir_type_scope): audio_welcome y
--     final_exam son de scope 'course'; el resto de los tipos v3, 'chapter'.
--     gir_chapter_scope (por scope) no cambia.
-- course_generation_manifests:
--   - columnas experience_count, presentation_count, video_interactions_count,
--     activity_count, audiobook_chapter_count, audio_welcome_count,
--     final_exam_count (default 0 = lo que declara un Manifest v1/v2);
--   - scorm_count pasa de ">= 1" a ">= 0" (v3 no tiene items scorm);
--   - cgm_counts_consistent (mismo nombre): v1/v2 idénticos a antes; + rama
--     rules_version = 3.
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

-- ── generation_item_runs: CHECK de type con los tipos v3 ──────────────────
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'gir_type_check' and conrelid = 'public.generation_item_runs'::regclass
       and pg_get_constraintdef(oid) like '%audiobook_chapter%'
  ) then
    alter table public.generation_item_runs drop constraint if exists gir_type_check;
    alter table public.generation_item_runs add constraint gir_type_check
      check (type in ('content', 'scorm', 'video', 'exam', 'course_plan', 'course_intro', 'module_intro',
                      'experience', 'presentation', 'video_interactions', 'activity', 'audiobook_chapter',
                      'audio_welcome', 'final_exam'));
  end if;
end $$;

-- ── scope derivado del type (writers que no mandan scope) ────────────────
create or replace function public.generation_item_runs_default_scope() returns trigger
language plpgsql as $$
begin
  if new.scope is null then
    new.scope := case
                   when new.type in ('course_plan', 'course_intro', 'audio_welcome', 'final_exam') then 'course'
                   when new.type in ('exam', 'module_intro') then 'module'
                   else 'chapter'
                 end;
  end if;
  return new;
end $$;

-- ── scope ⇔ type (mismo nombre) ──────────────────────────────────────────
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'gir_type_scope' and conrelid = 'public.generation_item_runs'::regclass
       and pg_get_constraintdef(oid) like '%final_exam%'
  ) then
    alter table public.generation_item_runs drop constraint if exists gir_type_scope;
    alter table public.generation_item_runs add constraint gir_type_scope check (
      scope = case
                when type in ('course_plan', 'course_intro', 'audio_welcome', 'final_exam') then 'course'
                when type in ('exam', 'module_intro') then 'module'
                else 'chapter'
              end);
  end if;
end $$;

-- ── course_generation_manifests: conteos v3 ──────────────────────────────
do $$
declare
  col text;
begin
  foreach col in array array['experience_count', 'presentation_count', 'video_interactions_count',
                             'activity_count', 'audiobook_chapter_count', 'audio_welcome_count',
                             'final_exam_count']
  loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'course_generation_manifests'
                      and column_name = col) then
      execute format(
        'alter table public.course_generation_manifests add column %I integer not null default 0 check (%I >= 0)',
        col, col);
    end if;
  end loop;
end $$;

-- scorm_count: el CHECK inline original (sin nombre propio) exige >= 1; v3 lo
-- deja en 0. Se reemplaza por cgm_scorm_count_nonneg (>= 0); la relación real
-- (= chapter_count en v1/v2, = 0 en v3) la impone cgm_counts_consistent.
do $$
declare
  c record;
begin
  if not exists (select 1 from pg_constraint where conname = 'cgm_scorm_count_nonneg'
                   and conrelid = 'public.course_generation_manifests'::regclass) then
    for c in
      select conname from pg_constraint
       where conrelid = 'public.course_generation_manifests'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) ~ '^CHECK \(\(scorm_count >= 1\)\)$'
    loop
      execute format('alter table public.course_generation_manifests drop constraint %I', c.conname);
    end loop;
    alter table public.course_generation_manifests add constraint cgm_scorm_count_nonneg check (scorm_count >= 0);
  end if;
end $$;

-- cgm_counts_consistent (mismo nombre): v1 y v2 exactamente como antes
-- (incluido scorm_count = chapter_count) + todos los conteos v3 en 0; v3:
-- sin scorm, 1 plan + 1 intro + 1 audio de bienvenida, 1 intro por módulo,
-- experience/presentation/audiobook por capítulo, video_interactions = video,
-- activity <= capítulos, final_exam 0..1.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'cgm_counts_consistent' and conrelid = 'public.course_generation_manifests'::regclass
       and pg_get_constraintdef(oid) like '%audiobook_chapter_count%'
  ) then
    alter table public.course_generation_manifests drop constraint if exists cgm_counts_consistent;
    alter table public.course_generation_manifests add constraint cgm_counts_consistent check (
      content_count = chapter_count
      and video_count <= chapter_count and exam_count <= module_count
      and (
        (rules_version in (1, 2)
          and scorm_count = chapter_count
          and experience_count = 0 and presentation_count = 0 and video_interactions_count = 0
          and activity_count = 0 and audiobook_chapter_count = 0 and audio_welcome_count = 0
          and final_exam_count = 0
          and (
            (rules_version = 1 and course_plan_count = 0 and course_intro_count = 0 and module_intro_count = 0)
            or (rules_version = 2 and course_plan_count = 1 and course_intro_count = 1 and module_intro_count = module_count)
          ))
        or (rules_version = 3
          and scorm_count = 0
          and course_plan_count = 1 and course_intro_count = 1 and module_intro_count = module_count
          and audio_welcome_count = 1
          and experience_count = chapter_count and presentation_count = chapter_count
          and audiobook_chapter_count = chapter_count
          and video_interactions_count = video_count
          and activity_count <= chapter_count
          and final_exam_count between 0 and 1)
      )
      and total_jobs = content_count + scorm_count + video_count + exam_count
                       + course_plan_count + course_intro_count + module_intro_count
                       + experience_count + presentation_count + video_interactions_count
                       + activity_count + audiobook_chapter_count + audio_welcome_count + final_exam_count);
  end if;
end $$;
