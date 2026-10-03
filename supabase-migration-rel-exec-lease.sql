-- ══════════════════════════════════════════════════════════════════════════
-- Cursia REL — lease de EJECUCIÓN del navegador por run (servidor = autoridad).
-- 100 % ADITIVA e IDEMPOTENTE.
--
-- Un run de generación dinámica (production_jobs, execution_mode = 'dynamic_generation') tiene a lo
-- sumo UN ejecutor del navegador a la vez. Esto NO limita el acceso al curso: cualquier equipo del
-- dueño abre el curso y ve el progreso; el lease solo decide quién reclama partes del run.
--
-- production_jobs (columnas nuevas, nullable):
--   executor_lease_holder      text         executorId del navegador que tiene el lease (estable por equipo)
--   executor_lease_expires_at  timestamptz  vencimiento (TTL = lease del navegador, ~120 s, renovado
--                                           por claim / heartbeat / complete / fail del titular)
-- Trigger trg_pj_release_exec_lease: al pasar el run a un estado no activo (terminado, fallido,
-- cancelado — por CUALQUIER camino de escritura) el lease se suelta en la misma fila.
-- Los workers del servidor (video / Gamma / TTS / empaque) nunca lo usan.
--
-- El código tolera su ausencia (sonda de esquema en src/modules/reliability/execution-lease.ts: sin la
-- migración el claim se comporta como antes).
--
-- Rollback (solo si se quisiera deshacer; tras el rollback, `pm2 reload` de la API: la sonda positiva se
-- cachea hasta 5 min):
--   drop trigger if exists trg_pj_release_exec_lease on public.production_jobs;
--   drop function if exists public.pj_release_exec_lease();
--   alter table public.production_jobs
--     drop column if exists executor_lease_holder, drop column if exists executor_lease_expires_at;
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

-- ADD COLUMN sin default es solo de catálogo (sin reescritura de la tabla).
alter table public.production_jobs add column if not exists executor_lease_holder text;
alter table public.production_jobs add column if not exists executor_lease_expires_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pj_exec_lease_holder_len') then
    alter table public.production_jobs
      add constraint pj_exec_lease_holder_len check (executor_lease_holder is null or char_length(executor_lease_holder) <= 200) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pj_exec_lease_pair') then
    alter table public.production_jobs
      add constraint pj_exec_lease_pair check ((executor_lease_holder is null) = (executor_lease_expires_at is null)) not valid;
  end if;
end $$;
-- Columnas nuevas = todas null: la validación no encuentra filas que violen.
alter table public.production_jobs validate constraint pj_exec_lease_holder_len;
alter table public.production_jobs validate constraint pj_exec_lease_pair;

-- Suelta el lease cuando el run deja de estar activo (mismo criterio que isActiveRun:
-- worker_status en queued/running/retrying y status/worker_status no cancelled/cancelling).
create or replace function public.pj_release_exec_lease() returns trigger
language plpgsql as $$
begin
  new.executor_lease_holder := null;
  new.executor_lease_expires_at := null;
  return new;
end $$;

drop trigger if exists trg_pj_release_exec_lease on public.production_jobs;
create trigger trg_pj_release_exec_lease
  before update on public.production_jobs
  for each row
  when (new.executor_lease_holder is not null and (
          coalesce(new.worker_status, '') not in ('queued', 'running', 'retrying')
          or coalesce(new.status, '') in ('cancelled', 'cancelling')))
  execute function public.pj_release_exec_lease();

-- Lo usa solo el backend (service role); nada nuevo para anon/authenticated.
