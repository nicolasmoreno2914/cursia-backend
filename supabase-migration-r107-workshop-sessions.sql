-- ════════════════════════════════════════════════════════════════════════
-- Cursia — r107 B1 «Taller de cursos»: sesiones de ingesta + identificación de un .mbz subido por el usuario.
--
--   workshop_sessions   una fila por .mbz subido al Taller: dueño, institución, ruta del original en Storage (carpeta del
--                       dueño, nunca se modifica), sha1 / tamaño / contenedor reales (los calcula el servidor al
--                       descargarlo), familia de formato, curso de Cursia identificado (o null: se trabaja solo con el
--                       paquete), cómo se identificó (método, confianza, candidatos) y versión de builder inferida.
--
--   status: uploaded (sesión creada / subida pendiente de cerrar) → identifying → identified | failed (+ error visible).
--
-- Tabla nueva; ninguna existente cambia (la FK a courses es ON DELETE SET NULL: borrar un curso no borra la sesión).
-- Aditiva e idempotente. RLS encendido y sin privilegios para anon/authenticated: solo el backend (service role), que
-- filtra por dueño / institución / SuperAdmin. Mismo patrón que r81 (microcurricula) y r99.
-- SOLO staging (deploy-staging.yml → scripts/migrate-r107-workshop-sessions.js) hasta aprobación del owner (EXCLUDED en
-- scripts/prod/migrate-v2-production.js). Sin la tabla, la API responde 503 COURSE_WORKSHOP_NOT_MIGRATED, y con
-- COURSE_WORKSHOP ≠ 'true' todas las rutas del Taller responden 404.
--
-- Rollback (aditiva; con el flag apagado nada la usa):
--   drop table if exists public.workshop_sessions;
-- ════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

create table if not exists public.workshop_sessions (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null,
  institution_id        uuid null,
  status                text not null default 'uploaded'
                          check (status in ('uploaded', 'identifying', 'identified', 'failed')),
  original_artifact_id  uuid null,
  storage_path          text not null,
  original_sha1         text null check (original_sha1 is null or original_sha1 ~ '^[0-9a-f]{40}$'),
  original_size         bigint null check (original_size is null or (original_size >= 0 and original_size <= 314572800)),
  container             text null check (container is null or container in ('zip', 'tar.gz')),
  family                text null check (family is null or family in ('v1-legacy', 'v1-legacy-hvp', 'v2-dynamic', 'moodle-reexport', 'prototype')),
  identified_course_id  integer null references public.courses(id) on delete set null,
  identification        jsonb not null default '{}'::jsonb,
  builder_version       text null,
  error                 jsonb null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists workshop_sessions_storage_path_uidx on public.workshop_sessions (storage_path);
create index if not exists workshop_sessions_owner_created_idx on public.workshop_sessions (owner_id, created_at desc);
create index if not exists workshop_sessions_institution_idx on public.workshop_sessions (institution_id) where institution_id is not null;

alter table public.workshop_sessions enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table public.workshop_sessions from %I', r);
    end if;
  end loop;
end $$;
