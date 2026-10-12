-- ════════════════════════════════════════════════════════════════════════
-- Loop 4 (worker de IA del backend): latido de presencia de los workers de IA.
--
-- El API solo le quita al navegador las partes largas (Libro Guía, Actividad, SCORM, examen final) que cubre un
-- worker de IA VIVO (latido reciente). Si no hay ninguno (proceso caído, en espera sin flag o sin API key, o esta
-- tabla todavía no existe) el navegador las sigue reclamando como siempre: el curso nunca queda colgado esperando
-- a un worker que no está.
--
-- Idempotente. Solo staging (deploy-staging.yml). Producción: requiere aprobación explícita del usuario.
-- Rollback: drop table if exists public.llm_worker_presence;
-- ════════════════════════════════════════════════════════════════════════
create table if not exists public.llm_worker_presence (
  worker_id   text primary key,
  item_types  text[] not null,
  started_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  draining    boolean not null default false
);
create index if not exists llm_worker_presence_last_seen_idx on public.llm_worker_presence (last_seen);
-- Loop 6: instante de activación con el que reclama ESE worker (el API rutea un run solo si un worker vivo lo cubre).
alter table public.llm_worker_presence add column if not exists since timestamptz;

-- Solo el backend (service role) lee/escribe: un cliente (anon/authenticated vía PostgREST) nunca puede fingir ni
-- borrar la presencia de un worker (decide qué partes reclama el navegador). Mismo patrón que v21-finops-rls.
alter table public.llm_worker_presence enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table public.llm_worker_presence from %I', r);
    end if;
  end loop;
end $$;
