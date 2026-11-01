-- ══════════════════════════════════════════════════════════════════════════
-- Cursia — r81 «Crear microcurrículo»: borradores de microcurrículo por usuario y su registro de generaciones (cuota).
--
--   microcurricula                   un borrador por microcurrículo: respuestas del cuestionario, documento generado
--                                    (MicrocurriculumV1), comprobaciones V1–V8, regeneraciones de sección, costo y el
--                                    estado de la generación en segundo plano (pending_section, last_error).
--   microcurriculum_generations      una fila por generación completa o regeneración de sección: la cuota mensual cuenta
--                                    las `reserved` + `succeeded` del mes UTC; una llamada fallida queda `released`
--                                    (no descuenta). Borrar un microcurrículo NO devuelve cupo (microcurriculum_id → NULL).
--
-- Aditiva e idempotente: no cambia ninguna tabla existente. RLS activado y sin acceso para anon/authenticated (la API
-- del backend usa el rol de servicio y filtra por owner_id = usuario del JWT). Sin FK a auth (como el resto del backend).
-- SOLO staging (deploy-staging.yml) hasta aprobación del owner; el código responde 503 MICROCURRICULUM_NOT_MIGRATED sin
-- estas tablas y la sección queda apagada con MICROCURRICULUM_ENABLED ≠ 'true'.
--
-- Rollback (aditiva; con el flag apagado nada la usa):
--   drop table if exists public.microcurriculum_generations;
--   drop table if exists public.microcurricula;
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

create table if not exists public.microcurricula (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  institution_id uuid null,
  title text not null default '',
  status text not null default 'draft_answers' check (status in ('draft_answers', 'generating', 'generated', 'failed')),
  answers jsonb not null default '{}'::jsonb,
  document jsonb null,
  issues jsonb not null default '[]'::jsonb,
  regen_count integer not null default 0 check (regen_count >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  course_id integer null,
  generating_since timestamptz null,
  pending_section text null check (pending_section is null or pending_section in ('outcomes', 'units', 'evaluation')),
  last_error jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Generación asíncrona (columnas también por ALTER: idempotente si la tabla se creó antes de ellas).
alter table public.microcurricula add column if not exists pending_section text null;
alter table public.microcurricula add column if not exists last_error jsonb null;
create index if not exists microcurricula_owner_created_idx on public.microcurricula (owner_id, created_at desc);

create table if not exists public.microcurriculum_generations (
  id bigserial primary key,
  owner_id uuid not null,
  microcurriculum_id uuid null references public.microcurricula(id) on delete set null,
  kind text not null check (kind in ('generate', 'regenerate')),
  section text null check (section is null or section in ('outcomes', 'units', 'evaluation')),
  status text not null default 'reserved' check (status in ('reserved', 'succeeded', 'released')),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  created_at timestamptz not null default now(),
  finished_at timestamptz null
);
create index if not exists microcurriculum_generations_owner_created_idx on public.microcurriculum_generations (owner_id, created_at);
create index if not exists microcurriculum_generations_mc_idx on public.microcurriculum_generations (microcurriculum_id);

alter table public.microcurricula enable row level security;
alter table public.microcurriculum_generations enable row level security;
-- Solo el backend (service role) lee/escribe. Mismo patrón que v21-finops-rls / llm-worker-presence (roles opcionales:
-- una base local sin los roles de Supabase también migra).
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table public.microcurricula from %I', r);
      execute format('revoke all on table public.microcurriculum_generations from %I', r);
      execute format('revoke all on sequence public.microcurriculum_generations_id_seq from %I', r);
    end if;
  end loop;
end $$;
