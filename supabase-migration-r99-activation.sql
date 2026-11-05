-- ════════════════════════════════════════════════════════════════════════
-- r99 («todo error tiene una solución»): momento de ACTIVACIÓN de r99, persistido y con latido.
--
-- Lo lee el backend (src/modules/reliability/r99-activation.ts) para que nada de r99 sea retroactivo:
--  - la reanudación por decisión del dueño (presupuesto aprobado, suspensión levantada…) solo cuenta decisiones
--    POSTERIORES a la activación;
--  - el backfill de la pausa por bug (fallos de los últimos 30 días) se limita por hora para pausas cuyo fallo ORIGINAL
--    es anterior a la activación.
-- `last_seen_at` es un latido del barrido (cada pocos minutos): si pasa más de 1 h sin latido (rollback a un build sin
-- r99 y vuelta), la activación se renueva a «ahora» (nunca se reutiliza una activación vieja).
--
-- Tabla nueva; ninguna existente cambia. Idempotente. Solo el backend (service role) lee/escribe: RLS encendido y sin
-- privilegios para anon/authenticated (PostgREST no la expone). Mismo patrón que infra_health (r83).
-- Staging: deploy-staging.yml (scripts/migrate-r99-activation.js). Producción: requiere aprobación explícita del owner
-- (EXCLUDED en scripts/prod/migrate-v2-production.js); sin la tabla el backend usa R99_OWNER_RESUME_SINCE o el arranque
-- del proceso (nunca una fecha anterior).
-- Rollback: drop table if exists public.cursia_feature_activations;
-- ════════════════════════════════════════════════════════════════════════
create table if not exists public.cursia_feature_activations (
  key           text primary key,
  activated_at  timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  build_id      text
);
alter table public.cursia_feature_activations add column if not exists last_seen_at timestamptz not null default now();
alter table public.cursia_feature_activations add column if not exists build_id text;

alter table public.cursia_feature_activations enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table public.cursia_feature_activations from %I', r);
    end if;
  end loop;
end $$;
