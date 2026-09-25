-- ══════════════════════════════════════════════════════════════════════════
-- Dynamic course structure — rulesVersion 2 (5B.2.B + Fase 6).
-- Spec: campuscloud-gen docs/superpowers/specs/2026-09-25-cursia-v2-rules-v2-and-context-package-design.md §3 (DB).
--
-- 100% aditivo: solo relaja un NOT NULL, agrega columnas (con backfill de
-- las filas v1 existentes) y reemplaza CHECKs por otros que TODAS las filas
-- v1 ya cumplen. Reversible sin tocar datos SOLO mientras no existan filas
-- v2 — ver supabase-migration-dynamic-generation-v2.rollback.md (orden,
-- qué restaurar, y por qué con filas v2 el rollback de schema borra datos). Corre exclusivamente contra la base
-- de STAGING — ver scripts/migrate-dynamic-generation-v2.js para el
-- guardarraíl. Idempotente: se re-corre en cada deploy a staging, y cada paso
-- chequea el catálogo primero para no pedir locks cuando ya está aplicado.
--
-- generation_item_runs:
--   - module_id pasa a nullable (items de scope 'course' no tienen módulo);
--   - columna `scope` ('chapter'|'module'|'course'), backfill por type para las
--     filas v1, NOT NULL, y un trigger BEFORE INSERT que la deriva del type si
--     el writer no la manda (el código v1 nunca la manda: sigue funcionando
--     igual, incluso durante la ventana del deploy);
--   - CHECK de type extendido con course_plan, course_intro, module_intro;
--   - gir_chapter_scope ((type='exam') = (chapter_id is null)) se reemplaza por
--     el CHECK por scope (mismo nombre): chapter ⇒ module_id y chapter_id no
--     nulos; module ⇒ module_id no nulo y chapter_id nulo; course ⇒ ambos nulos;
--     + gir_type_scope (type ⇒ scope).
-- course_generation_manifests:
--   - columnas course_plan_count / course_intro_count / module_intro_count
--     (default 0 = lo que declara un Manifest v1) y cgm_counts_consistent
--     reemplazado (mismo nombre) para que total_jobs sume también los items v2.
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

-- ── generation_item_runs.module_id nullable ──────────────────────────────
do $$ begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'generation_item_runs'
       and column_name = 'module_id' and is_nullable = 'NO'
  ) then
    alter table public.generation_item_runs alter column module_id drop not null;
  end if;
end $$;

-- ── generation_item_runs.scope + backfill v1 + NOT NULL ──────────────────
do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'generation_item_runs' and column_name = 'scope'
  ) then
    alter table public.generation_item_runs add column scope text;
  end if;
end $$;

-- Backfill (solo filas sin scope; en un re-deploy no toca nada).
update public.generation_item_runs
   set scope = case
                 when type in ('course_plan', 'course_intro') then 'course'
                 when type in ('exam', 'module_intro') then 'module'
                 else 'chapter'
               end
 where scope is null;

-- Deriva scope del type en cada INSERT que no lo mande (writers v1).
create or replace function public.generation_item_runs_default_scope() returns trigger
language plpgsql as $$
begin
  if new.scope is null then
    new.scope := case
                   when new.type in ('course_plan', 'course_intro') then 'course'
                   when new.type in ('exam', 'module_intro') then 'module'
                   else 'chapter'
                 end;
  end if;
  return new;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
     where c.relname = 'generation_item_runs' and t.tgname = 'generation_item_runs_default_scope'
       and not t.tgisinternal
  ) then
    create trigger generation_item_runs_default_scope before insert on public.generation_item_runs
      for each row execute function public.generation_item_runs_default_scope();
  end if;
end $$;

do $$ begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'generation_item_runs'
       and column_name = 'scope' and is_nullable = 'YES'
  ) then
    alter table public.generation_item_runs alter column scope set not null;
  end if;
end $$;

-- ── CHECK de type extendido ──────────────────────────────────────────────
-- El CHECK inline original no tiene nombre propio: se busca por definición
-- (la que menciona type in ('content','scorm','video','exam') sin los tipos
-- v2) y se reemplaza por gir_type_check con los 7 tipos.
do $$
declare
  c record;
begin
  if not exists (select 1 from pg_constraint where conname = 'gir_type_check'
                   and conrelid = 'public.generation_item_runs'::regclass) then
    for c in
      select conname from pg_constraint
       where conrelid = 'public.generation_item_runs'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) like '%type%'
         and pg_get_constraintdef(oid) like '%''exam''%'
         and pg_get_constraintdef(oid) like '%''video''%'
         and pg_get_constraintdef(oid) not like '%course_plan%'
         and pg_get_constraintdef(oid) not like '%chapter_id%'
    loop
      execute format('alter table public.generation_item_runs drop constraint %I', c.conname);
    end loop;
    alter table public.generation_item_runs add constraint gir_type_check
      check (type in ('content', 'scorm', 'video', 'exam', 'course_plan', 'course_intro', 'module_intro'));
  end if;
end $$;

-- ── scope ⇔ type ─────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'gir_type_scope'
                   and conrelid = 'public.generation_item_runs'::regclass) then
    alter table public.generation_item_runs add constraint gir_type_scope check (
      scope = case
                when type in ('course_plan', 'course_intro') then 'course'
                when type in ('exam', 'module_intro') then 'module'
                else 'chapter'
              end);
  end if;
end $$;

-- ── gir_chapter_scope: CHECK por scope (reemplaza (type='exam') = (chapter_id is null)) ──
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'gir_chapter_scope' and conrelid = 'public.generation_item_runs'::regclass
       and pg_get_constraintdef(oid) like '%scope%'
  ) then
    alter table public.generation_item_runs drop constraint if exists gir_chapter_scope;
    alter table public.generation_item_runs add constraint gir_chapter_scope check (
      (scope = 'chapter' and module_id is not null and chapter_id is not null)
      or (scope = 'module' and module_id is not null and chapter_id is null)
      or (scope = 'course' and module_id is null and chapter_id is null));
  end if;
end $$;

-- ── course_generation_manifests: conteos v2 ──────────────────────────────
do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'course_generation_manifests'
                    and column_name = 'course_plan_count') then
    alter table public.course_generation_manifests
      add column course_plan_count integer not null default 0 check (course_plan_count between 0 and 1);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'course_generation_manifests'
                    and column_name = 'course_intro_count') then
    alter table public.course_generation_manifests
      add column course_intro_count integer not null default 0 check (course_intro_count between 0 and 1);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'course_generation_manifests'
                    and column_name = 'module_intro_count') then
    alter table public.course_generation_manifests
      add column module_intro_count integer not null default 0 check (module_intro_count >= 0);
  end if;
end $$;

-- cgm_counts_consistent (mismo nombre): v1 (conteos v2 = 0) queda idéntico;
-- v2 exige además 1 plan + 1 intro de curso + 1 intro por módulo.
-- course_generation_manifests tiene un trigger que prohíbe UPDATE, pero
-- ALTER TABLE no dispara triggers de fila.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'cgm_counts_consistent' and conrelid = 'public.course_generation_manifests'::regclass
       and pg_get_constraintdef(oid) like '%module_intro_count%'
  ) then
    alter table public.course_generation_manifests drop constraint if exists cgm_counts_consistent;
    alter table public.course_generation_manifests add constraint cgm_counts_consistent check (
      content_count = chapter_count and scorm_count = chapter_count
      and video_count <= chapter_count and exam_count <= module_count
      and (
        (rules_version = 1 and course_plan_count = 0 and course_intro_count = 0 and module_intro_count = 0)
        or (rules_version = 2 and course_plan_count = 1 and course_intro_count = 1 and module_intro_count = module_count)
      )
      and total_jobs = content_count + scorm_count + video_count + exam_count
                       + course_plan_count + course_intro_count + module_intro_count);
  end if;
end $$;
