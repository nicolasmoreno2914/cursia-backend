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
