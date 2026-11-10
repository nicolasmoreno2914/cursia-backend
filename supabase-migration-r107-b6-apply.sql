-- ════════════════════════════════════════════════════════════════════════
-- Cursia — r107 B6 «Taller de cursos»: aplicar el plan, versiones (D10) y conciliación de las aprobaciones de IA.
--
--   workshop_versions    UNA versión por plan aplicado: sesión, número en la cadena (original → arreglo 1 → arreglo 2…),
--                        padre (null = el original de la sesión; si la sesión es hija, su parent_version_id), el plan y
--                        los ítems CONGELADOS al aprobar (operaciones del motor), los ítems de riesgo alto confirmados uno
--                        por uno, el trabajo (queued → building → verifying → ready | failed + motivo visible; reclamo
--                        `<arranque>.<uuid>` + latido como el diagnóstico de B3), el paquete nuevo (artifact
--                        `workshop_version`, ruta, sha1/sha256, tamaño, contenedor), el informe de cambios por ítem, el
--                        diagnóstico del resultado, la validación, `restore_check` ('passed' | 'failed' | 'not_available')
--                        y el costo total del arreglo.
--   workshop_sessions    + parent_version_id: una sesión HIJA cuyo original es una versión (encadenar arreglos).
--   workshop_plans       el estado deja de ser solo `draft`: draft → applying → applied | failed (reintentable o no);
--                        + applied_version_id.
--   workshop_ai_approvals + claim_id (latido entre procesos, como B3) + reconciliation (decisión del SuperAdmin sobre una
--                        aprobación `ambiguous`) + estado `reconciled`.
--
-- Solo tablas del Taller (r107, staging-only): ninguna tabla anterior al Taller cambia. Aditiva e idempotente (los CHECK
-- de estado se reemplazan por uno que acepta los mismos valores y los nuevos). RLS encendido y sin privilegios para
-- anon/authenticated en la tabla nueva. SOLO staging (deploy-staging.yml → scripts/migrate-r107-b6-apply.js) hasta
-- aprobación del owner (EXCLUDED en scripts/prod/migrate-v2-production.js). Requiere B1 + B5.
--
-- Rollback (con el flag apagado nada la usa):
--   alter table public.workshop_sessions drop column if exists parent_version_id;
--   drop table if exists public.workshop_versions;
--   alter table public.workshop_plans drop column if exists applied_version_id;
--   alter table public.workshop_ai_approvals drop column if exists claim_id, drop column if exists reconciliation;
--   (y los CHECK de estado vuelven a los de B5)
-- ════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';

create table if not exists public.workshop_versions (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null references public.workshop_sessions(id) on delete cascade,
  plan_id             uuid not null references public.workshop_plans(id) on delete cascade,
  number              integer not null check (number >= 1),
  parent_version_id   uuid null references public.workshop_versions(id) on delete restrict,
  base_sha1           text not null check (base_sha1 ~ '^[0-9a-f]{40}$'),
  status              text not null default 'queued' check (status in ('queued', 'building', 'verifying', 'ready', 'failed')),
  claim_id            text null,
  attempts            integer not null default 0,
  item_ids            jsonb not null default '[]'::jsonb,
  operations          jsonb not null default '[]'::jsonb,
  confirmed_item_ids  jsonb not null default '[]'::jsonb,
  artifact_id         uuid null,
  storage_path        text null,
  sha1                text null check (sha1 is null or sha1 ~ '^[0-9a-f]{40}$'),
  sha256              text null check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes          bigint null,
  container           text null check (container is null or container in ('zip', 'tar.gz')),
  report              jsonb null,
  diagnosis           jsonb null,
  validation          jsonb null,
  restore_check       text null check (restore_check is null or restore_check in ('passed', 'failed', 'not_available')),
  restore_check_message text null,
  cost                jsonb null,
  error               jsonb null,
  created_by          uuid not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  finished_at         timestamptz null,
  -- Listo = con su paquete verificado; nunca «listo» a medias.
  constraint workshop_versions_ready_complete check (status <> 'ready' or (artifact_id is not null and sha1 is not null and sha256 is not null and size_bytes is not null and restore_check is not null))
);
create unique index if not exists workshop_versions_plan_uidx on public.workshop_versions (plan_id);
create index if not exists workshop_versions_session_idx on public.workshop_versions (session_id, created_at);
create index if not exists workshop_versions_work_idx on public.workshop_versions (status, updated_at) where status in ('queued', 'building', 'verifying');

alter table public.workshop_sessions add column if not exists parent_version_id uuid null references public.workshop_versions(id) on delete restrict;
-- Una sesión hija por versión (abrirla de nuevo devuelve la misma): la cadena es lineal en cada rama.
create unique index if not exists workshop_sessions_parent_version_uidx on public.workshop_sessions (parent_version_id) where parent_version_id is not null;

alter table public.workshop_plans add column if not exists applied_version_id uuid null;
alter table public.workshop_plans drop constraint if exists workshop_plans_status_check;
alter table public.workshop_plans add constraint workshop_plans_status_check check (status in ('draft', 'applying', 'applied', 'failed'));

alter table public.workshop_ai_approvals add column if not exists claim_id text null;
alter table public.workshop_ai_approvals add column if not exists reconciliation jsonb null;
alter table public.workshop_ai_approvals drop constraint if exists workshop_ai_approvals_status_check;
alter table public.workshop_ai_approvals add constraint workshop_ai_approvals_status_check check (status in ('reserved', 'running', 'done', 'stopped', 'failed', 'ambiguous', 'reconciled'));

alter table public.workshop_versions enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table public.workshop_versions from %I', r);
    end if;
  end loop;
end $$;
