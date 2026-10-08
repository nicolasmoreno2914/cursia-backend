-- ══════════════════════════════════════════════════════════════════════════
-- Cursia — Prebrief pedagógico: versiones aprobables de la propuesta, su historial y sus PDF.
--
--   course_prebrief_versions  una fila por versión PREPARADA (el borrador no se persiste): modelo + documento + huellas
--                             + Blueprint congelado + estado + aprobación. Contenido INMUTABLE (trigger).
--   course_prebrief_events    historial de solo inserción (preparada, aprobada, cambios solicitados, invalidada, run…).
--   course_prebrief_pdfs      PDF de cada versión por variante ('ready' | 'approved'); nunca se sobrescribe.
--
-- Aditiva e idempotente: no cambia ninguna tabla existente (el flujo de aprobación del curso vive en
-- courses.metadata.approvalFlow, el formato S/M/L en courses.metadata.courseFormat, los motivos de excepción en
-- courses.metadata.requirementExceptionReasons y las confirmaciones en courses.metadata.prebriefConfirmations).
-- RLS activado y sin acceso para anon/authenticated (la API del backend usa el rol de servicio).
-- SOLO staging (deploy-staging.yml); fuera del plan de producción.
--
-- Rollback (sin datos que conservar en staging):
--   drop table if exists public.course_prebrief_pdfs;
--   drop table if exists public.course_prebrief_events;
--   drop table if exists public.course_prebrief_versions;
--   drop function if exists public.course_prebrief_versions_guard();
--   drop function if exists public.course_prebrief_append_only();
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

create table if not exists public.course_prebrief_versions (
  id uuid primary key default gen_random_uuid(),
  course_id integer not null references public.courses(id) on delete cascade,
  version integer not null check (version >= 1),
  status text not null check (status in ('ready', 'changes_requested', 'approved', 'invalidated')),
  model_version integer not null,
  model_json jsonb not null,
  model_sha256 char(64) not null,
  document_json jsonb not null,
  document_sha256 char(64) not null,
  blueprint_id integer not null,
  blueprint_number integer not null,
  blueprint_sha256 char(64) not null,
  verification_summary jsonb not null default '{}'::jsonb,
  prepared_by varchar(36) not null,
  prepared_by_email text null,
  prepared_at timestamptz not null default now(),
  approval jsonb null,
  changes_request jsonb null,
  invalidated_at timestamptz null,
  invalidation_reason text null check (invalidation_reason is null or invalidation_reason in ('design_changed', 'superseded', 'withdrawn')),
  invalidation_diff jsonb null,
  unique (course_id, version)
);
create index if not exists course_prebrief_versions_course_idx on public.course_prebrief_versions (course_id, version desc);

create table if not exists public.course_prebrief_events (
  id bigserial primary key,
  course_id integer not null references public.courses(id) on delete cascade,
  version_id uuid null references public.course_prebrief_versions(id) on delete cascade,
  type text not null,
  actor varchar(36) null,
  payload jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists course_prebrief_events_course_idx on public.course_prebrief_events (course_id, id);

create table if not exists public.course_prebrief_pdfs (
  id bigserial primary key,
  version_id uuid not null references public.course_prebrief_versions(id) on delete cascade,
  variant text not null check (variant in ('ready', 'approved')),
  sha256 char(64) not null,
  pages integer not null,
  bytes bytea not null,
  created_at timestamptz not null default now(),
  unique (version_id, variant)
);

-- Contenido de una versión inmutable; transiciones de estado válidas; la aprobación se escribe una sola vez.
create or replace function public.course_prebrief_versions_guard() returns trigger language plpgsql as $$
begin
  if new.course_id <> old.course_id or new.version <> old.version or new.model_json <> old.model_json
     or new.model_sha256 <> old.model_sha256 or new.document_json <> old.document_json or new.document_sha256 <> old.document_sha256
     or new.blueprint_id <> old.blueprint_id or new.blueprint_number <> old.blueprint_number or new.blueprint_sha256 <> old.blueprint_sha256
     or new.prepared_by <> old.prepared_by or new.prepared_at <> old.prepared_at or new.model_version <> old.model_version
     or new.verification_summary <> old.verification_summary or new.prepared_by_email is distinct from old.prepared_by_email then
    raise exception 'PREBRIEF_VERSION_IMMUTABLE: el contenido de una versión preparada no se modifica';
  end if;
  if old.approval is not null and (new.approval is null or new.approval <> old.approval) then
    raise exception 'PREBRIEF_APPROVAL_IMMUTABLE: la aprobación registrada no se modifica';
  end if;
  if old.status <> new.status and not (
       (old.status = 'ready' and new.status in ('approved', 'changes_requested', 'invalidated'))
    or (old.status = 'changes_requested' and new.status = 'invalidated')
    or (old.status = 'approved' and new.status = 'invalidated')) then
    raise exception 'PREBRIEF_INVALID_TRANSITION: % → %', old.status, new.status;
  end if;
  if new.status = 'approved' and new.approval is null then
    raise exception 'PREBRIEF_APPROVAL_REQUIRED: una versión aprobada necesita su registro de aprobación';
  end if;
  return new;
end $$;

drop trigger if exists course_prebrief_versions_guard on public.course_prebrief_versions;
create trigger course_prebrief_versions_guard before update on public.course_prebrief_versions
  for each row execute function public.course_prebrief_versions_guard();

create or replace function public.course_prebrief_append_only() returns trigger language plpgsql as $$
begin
  -- Borrar el CURSO borra su historial (cascada: la fila del curso ya no existe); nada más puede borrarlo ni editarlo.
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.courses where id = old.course_id) then
      return old;
    end if;
  end if;
  raise exception 'PREBRIEF_APPEND_ONLY: % es de solo inserción', tg_table_name;
end $$;

drop trigger if exists course_prebrief_events_append_only on public.course_prebrief_events;
create trigger course_prebrief_events_append_only before update or delete on public.course_prebrief_events
  for each row execute function public.course_prebrief_append_only();
drop trigger if exists course_prebrief_pdfs_append_only on public.course_prebrief_pdfs;
create trigger course_prebrief_pdfs_append_only before update on public.course_prebrief_pdfs
  for each row execute function public.course_prebrief_append_only();

alter table public.course_prebrief_versions enable row level security;
alter table public.course_prebrief_events enable row level security;
alter table public.course_prebrief_pdfs enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.course_prebrief_versions, public.course_prebrief_events, public.course_prebrief_pdfs from anon;
    revoke all on sequence public.course_prebrief_events_id_seq, public.course_prebrief_pdfs_id_seq from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.course_prebrief_versions, public.course_prebrief_events, public.course_prebrief_pdfs from authenticated;
    revoke all on sequence public.course_prebrief_events_id_seq, public.course_prebrief_pdfs_id_seq from authenticated;
  end if;
end $$;
