-- ══════════════════════════════════════════════════════════════════════════
-- Cursia V2 Fase 8 — invalidación y regeneración parcial (F8-BE).
-- Spec: campuscloud-gen docs/superpowers/specs/2026-09-25-cursia-v2-fase8-invalidation-design.md §1.
--
-- 100% aditivo: una columna nullable nueva + su FK + un índice parcial. No
-- toca filas existentes (todas quedan con NULL = "no se arrastró de otro
-- run"). Corre exclusivamente contra la base de STAGING — ver
-- scripts/migrate-invalidation.js para el guardarraíl. Idempotente: se
-- re-corre en cada deploy a staging y cada paso chequea el catálogo primero
-- para no pedir locks cuando ya está aplicado.
--
-- generation_item_runs.carried_from_item_run_id:
--   item run de un run B (creado con POST …/runs {fromRun: A}) que REUTILIZA
--   la salida del item run de A (acciones REUSE / REVIEW / STALE_NO_AUTO).
--   FK a generation_item_runs(id) ON DELETE SET NULL (borrar el run A por
--   cascade nunca borra B; solo pierde el puntero de linaje).
--
-- Rollback (sin datos que perder más allá del linaje):
--   drop index if exists public.idx_gir_carried_from;
--   alter table public.generation_item_runs drop constraint if exists gir_carried_from_fk;
--   alter table public.generation_item_runs drop column if exists carried_from_item_run_id;
-- El código F8 que escribe la columna debe revertirse ANTES (si no, el apply
-- fromRun falla fuerte con "column does not exist"; nada más la usa).
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'generation_item_runs'
       and column_name = 'carried_from_item_run_id'
  ) then
    alter table public.generation_item_runs add column carried_from_item_run_id uuid;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'gir_carried_from_fk' and conrelid = 'public.generation_item_runs'::regclass
  ) then
    alter table public.generation_item_runs add constraint gir_carried_from_fk
      foreign key (carried_from_item_run_id) references public.generation_item_runs(id) on delete set null;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'generation_item_runs' and indexname = 'idx_gir_carried_from'
  ) then
    create index idx_gir_carried_from on public.generation_item_runs (carried_from_item_run_id)
      where carried_from_item_run_id is not null;
  end if;
end $$;
