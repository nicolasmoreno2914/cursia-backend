-- ════════════════════════════════════════════════════════════════════════
-- Cursia — r107 B3 «Taller de cursos»: diagnóstico técnico (T01–T12) de la sesión.
--
--   workshop_diagnoses  UN diagnóstico por (sesión, sha1 del original, versión del armado del diagnóstico): estado
--                       (queued → running → ready | failed + error visible), reclamo (claim_id: solo quien lo tiene escribe) y el
--                       INFORME con semáforo por curso / capítulo / actividad y conteos por check — sin la lista de
--                       hallazgos, que va en workshop_findings. Re-pedir el diagnóstico del mismo original no duplica
--                       nada (índice único); un original nuevo o una versión nueva del armado = otra fila.
--   workshop_findings   un hallazgo por fila (id estable del hallazgo, check, código, severidad, alcance, actividad) +
--                       el hallazgo completo en jsonb (título para el docente, detalle técnico, evidencia, arreglo
--                       sugerido del catálogo del motor de parches). Tabla y no jsonb en la sesión: B5/B7 enganchan
--                       «Arreglar esto» y los ítems del plan a UN hallazgo por su id, y consultan por actividad / check.
--
-- Tablas NUEVAS; ninguna existente cambia (FK a workshop_sessions ON DELETE CASCADE). Aditiva e idempotente. RLS
-- encendido y sin privilegios para anon/authenticated: solo el backend (service role). Mismo patrón que B1.
-- SOLO staging (deploy-staging.yml → scripts/migrate-r107-b3-diagnosis.js) hasta aprobación del owner (EXCLUDED en
-- scripts/prod/migrate-v2-production.js). Sin las tablas, la API del Taller responde 503 COURSE_WORKSHOP_NOT_MIGRATED.
--
-- Rollback (aditiva; con el flag apagado nada la usa):
--   drop table if exists public.workshop_findings; drop table if exists public.workshop_diagnoses;
-- ════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';

create table if not exists public.workshop_diagnoses (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.workshop_sessions(id) on delete cascade,
  original_sha1  text not null check (original_sha1 ~ '^[0-9a-f]{40}$'),
  code_version   text not null check (length(code_version) between 1 and 40),
  status         text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed')),
  claim_id       text null,
  report         jsonb null,
  error          jsonb null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- Fix round 1 (P2-7): estado `queued` (esperando el carril del proceso). Idempotente también sobre una tabla creada antes
-- con el CHECK sin `queued` (solo pruebas locales: la tabla todavía no existe en staging).
alter table public.workshop_diagnoses drop constraint if exists workshop_diagnoses_status_check;
alter table public.workshop_diagnoses add constraint workshop_diagnoses_status_check check (status in ('queued', 'running', 'ready', 'failed'));
create unique index if not exists workshop_diagnoses_version_uidx on public.workshop_diagnoses (session_id, original_sha1, code_version);

create table if not exists public.workshop_findings (
  diagnosis_id        uuid not null references public.workshop_diagnoses(id) on delete cascade,
  finding_id          text not null check (length(finding_id) between 1 and 80),
  check_id            text not null check (check_id ~ '^T(0[1-9]|1[0-2])$'),
  code                text not null,
  severity            text not null check (severity in ('error', 'warning', 'info')),
  scope_level         text not null check (scope_level in ('course', 'chapter', 'activity')),
  chapter_number      integer null,
  activity_module_id  integer null,
  activity_dir        text null,
  ordinal             integer not null check (ordinal >= 0),
  finding             jsonb not null,
  primary key (diagnosis_id, finding_id)
);
create index if not exists workshop_findings_activity_idx on public.workshop_findings (diagnosis_id, activity_module_id);
create index if not exists workshop_findings_order_idx on public.workshop_findings (diagnosis_id, ordinal);

alter table public.workshop_diagnoses enable row level security;
alter table public.workshop_findings enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['workshop_diagnoses', 'workshop_findings']
  loop
    foreach r in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table public.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;
