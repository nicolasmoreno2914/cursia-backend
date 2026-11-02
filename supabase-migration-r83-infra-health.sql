-- ════════════════════════════════════════════════════════════════════════
-- r83 (incidente curso 91, 2026-11-02): estado COMPARTIDO del breaker de infraestructura de Supabase Storage.
--
-- Los workers (pm2, procesos separados) registran aquí cada operación de Storage que agotó sus reintentos
-- (StorageUnavailableError). Con N fallos en la ventana el breaker se ABRE: los claims de los workers del servidor
-- no entregan trabajo (antes de cualquier llamada pagada) y una sonda barata (PUT+DELETE en qa-internal/storage-probe/)
-- lo CIERRA cuando Storage vuelve a responder (src/modules/reliability/storage-breaker.ts).
--
-- Sin esta tabla el código es no-op (comportamiento anterior). Tabla nueva; ninguna existente cambia.
-- Idempotente. Solo staging (deploy-staging.yml). Producción: requiere aprobación explícita del usuario
-- (EXCLUDED en scripts/prod/migrate-v2-production.js).
-- Rollback: drop table if exists public.infra_health;
-- ════════════════════════════════════════════════════════════════════════
create table if not exists public.infra_health (
  component          text primary key,
  state              text not null default 'closed',
  failures           integer not null default 0,
  window_started_at  timestamptz,
  opened_at          timestamptz,
  last_failure_at    timestamptz,
  next_probe_at      timestamptz,
  probe_round        integer not null default 0,
  last_probe_at      timestamptz,
  last_probe_ok_at   timestamptz,
  last_error         text,
  updated_at         timestamptz not null default now()
);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'infra_health_state_check') then
    alter table public.infra_health add constraint infra_health_state_check check (state in ('closed', 'open'));
  end if;
end $$;

-- Solo el backend (service role) lee/escribe: un cliente (anon/authenticated vía PostgREST) nunca puede abrir ni
-- cerrar el breaker (decide si los workers reparten trabajo). Mismo patrón que llm_worker_presence.
alter table public.infra_health enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table public.infra_health from %I', r);
    end if;
  end loop;
end $$;
