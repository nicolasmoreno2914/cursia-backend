-- ══════════════════════════════════════════════════════════════════════════
-- Cursia EV6 DoD «curso completo» (BE-A): worker_status `preview`.
--
-- Un run dinámico cuyos items están TODOS completados pero alguno es de vista
-- previa (video o Gamma/TTS mock) termina en `preview` (terminal), nunca en
-- `completed` (src/modules/dynamic-generation/run-completion.ts).
--
-- Fuente ÚNICA de la lista: scripts/lib/production-jobs-constraints.js
-- (WORKER_STATUSES). Este archivo es su equivalente SQL para aplicarlo a mano
-- o revisarlo; deploy.yml / deploy-staging.yml ya lo aplican con
-- scripts/migrate-production-jobs-constraints.js y el runner de producción
-- (scripts/prod/migrate-v2-production.js) en su paso 0. La lista de abajo es
-- IDÉNTICA a la del lib (scripts/check-ev6-dod.js lo verifica).
--
-- Aditiva e idempotente: el CHECK nuevo es un SUPERCONJUNTO del anterior (toda
-- fila existente ya lo cumple) y solo se reemplaza si todavía no acepta
-- 'preview'. NO reescribe filas: los runs viejos `completed` con componentes de
-- vista previa se LEEN como vista previa (RunDto.completion, computado) sin
-- tocar sus datos ni sus paquetes.
--
-- Rollback (solo si ninguna fila usa 'preview'):
--   select count(*) from public.production_jobs where worker_status = 'preview';  -- debe ser 0
--   y re-aplicar la lista sin 'preview' (scripts/lib/production-jobs-constraints.js anterior).
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'production_jobs_worker_status_check' and conrelid = 'public.production_jobs'::regclass
       and pg_get_constraintdef(oid) like '%''preview''%'
  ) then
    alter table public.production_jobs drop constraint if exists production_jobs_worker_status_check;
    alter table public.production_jobs add constraint production_jobs_worker_status_check
      check (worker_status is null or worker_status in ('queued', 'running', 'waiting_external', 'retrying', 'paused', 'pausing', 'cancelling', 'completed', 'failed', 'failed_recoverable', 'failed_retryable', 'needs_reconnect', 'blocked_quota', 'cancelled', 'preview'));
  end if;
end $$;
