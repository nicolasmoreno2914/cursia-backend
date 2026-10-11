-- ════════════════════════════════════════════════════════════════════════
-- Pausa REAL de un run dinámico (2026-10-11, piloto #1209).
--
-- Un run pausado por el usuario queda con worker_status = 'paused' (valor que el
-- CHECK de production_jobs ya admite). 'paused' NO es despachable: ningún claim
-- (navegador ni workers) le entrega partes nuevas. Pero sigue ABIERTO: no puede
-- coexistir otro run del mismo Manifest mientras está pausado, así que el índice
-- único de run activo pasa a contarlo.
--
-- PRERREQUISITO DE PRODUCCIÓN: deploy-staging.yml la aplica solo en staging; antes de llevar la pausa a
-- producción hay que correr esta migración allí (sin ella, un run pausado no cuenta en el índice único y
-- podría arrancar un segundo run del mismo Manifest).
--
-- Idempotente: solo recrea el índice si su predicado todavía no incluye 'paused'.
-- Rollback (si hiciera falta):
--   drop index if exists public.uq_dynamic_generation_active_run;
--   create unique index uq_dynamic_generation_active_run
--     on public.production_jobs ((input_payload->>'manifestId'))
--     where execution_mode = 'dynamic_generation' and worker_status in ('queued','running','retrying');
-- ════════════════════════════════════════════════════════════════════════
do $$
declare
  def text;
begin
  select indexdef into def from pg_indexes
   where schemaname = 'public' and tablename = 'production_jobs' and indexname = 'uq_dynamic_generation_active_run';

  if def is null or position('''paused''' in def) = 0 then
    drop index if exists public.uq_dynamic_generation_active_run;
    create unique index uq_dynamic_generation_active_run
      on public.production_jobs ((input_payload->>'manifestId'))
      where execution_mode = 'dynamic_generation'
        and worker_status in ('queued', 'running', 'retrying', 'paused');
  end if;
end $$;
