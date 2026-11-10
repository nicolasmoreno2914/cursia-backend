-- ════════════════════════════════════════════════════════════════════════
-- Cursia — r107 B8 «Taller de cursos»: diagnóstico de CALIDAD (Q01–Q05) y preguntas puntuales con evidencia citada.
--
--   workshop_quality_runs      UN diagnóstico de calidad por (sesión, sha1 del original, versión del armado): estado de la
--                              parte determinista (queued → running → ready | failed + error visible), reclamo + latido
--                              (claim_id `<arranque>.<uuid>`, como B3/B6), el informe sin la lista de hallazgos, la evidencia
--                              de CADA capítulo que se le daría a la IA (packets: solo eso va al modelo, nunca el paquete) y,
--                              por capítulo, la llamada exacta con su estimado (calls) y el estado de su revisión con IA
--                              (chapters: not_reviewed | queued | reviewing | reviewed | failed | stopped, con su aprobación).
--   workshop_quality_findings  un hallazgo de calidad por fila — misma forma que workshop_findings (B3) + `source`
--                              (deterministic | ai): «Arreglar esto» de B5 lo usa igual.
--   workshop_questions         preguntas puntuales: texto (dato no confiable), evidencia recuperada SIN IA (fragmentos de la
--                              sesión), estimado, aprobación, respuesta con citas verificadas, historial por sesión.
--   workshop_ai_approvals      (tabla del Taller, B5) acepta los tipos nuevos `quality` y `question` (mismas aprobaciones,
--                              misma reserva en FinOps: no hay otro camino de gasto).
--
-- Solo tablas del Taller (r107, staging-only): ninguna tabla anterior al Taller cambia. Aditiva e idempotente (el CHECK de
-- `kind` se reemplaza con drop + add, como B6 con los estados). RLS encendido y sin privilegios para anon/authenticated.
-- SOLO staging (deploy-staging.yml → scripts/migrate-r107-b8-quality.js) hasta aprobación del owner (EXCLUDED en
-- scripts/prod/migrate-v2-production.js). Requiere B1, B3 y B5 antes ([5i], [5k], [5l]).
--
-- Rollback (aditiva; con el flag apagado nada la usa):
--   drop table if exists public.workshop_questions; drop table if exists public.workshop_quality_findings;
--   drop table if exists public.workshop_quality_runs;
--   (y el CHECK de workshop_ai_approvals.kind vuelve a ('interpret', 'reinterpret', 'generate'))
-- ════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';

create table if not exists public.workshop_quality_runs (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.workshop_sessions(id) on delete cascade,
  original_sha1  text not null check (original_sha1 ~ '^[0-9a-f]{40}$'),
  code_version   text not null check (length(code_version) between 1 and 40),
  created_by     uuid not null,
  diagnosis_id   uuid null references public.workshop_diagnoses(id) on delete set null,
  status         text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed')),
  claim_id       text null,
  report         jsonb null,
  packets        jsonb null,
  calls          jsonb null,
  chapters       jsonb not null default '{}'::jsonb,
  ai_claim_id    text null,
  error          jsonb null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists workshop_quality_runs_version_uidx on public.workshop_quality_runs (session_id, original_sha1, code_version);

create table if not exists public.workshop_quality_findings (
  run_id              uuid not null references public.workshop_quality_runs(id) on delete cascade,
  finding_id          text not null check (length(finding_id) between 1 and 80),
  check_id            text not null check (check_id ~ '^Q0[1-5]$'),
  code                text not null,
  severity            text not null check (severity in ('error', 'warning', 'info')),
  source              text not null check (source in ('deterministic', 'ai')),
  scope_level         text not null check (scope_level in ('course', 'chapter', 'activity')),
  chapter_number      integer null,
  activity_module_id  integer null,
  activity_dir        text null,
  ordinal             integer not null check (ordinal >= 0),
  finding             jsonb not null,
  primary key (run_id, finding_id)
);
create index if not exists workshop_quality_findings_activity_idx on public.workshop_quality_findings (run_id, activity_module_id);
create index if not exists workshop_quality_findings_order_idx on public.workshop_quality_findings (run_id, ordinal);

create table if not exists public.workshop_questions (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.workshop_sessions(id) on delete cascade,
  original_sha1  text not null check (original_sha1 ~ '^[0-9a-f]{40}$'),
  code_version   text not null check (length(code_version) between 1 and 40),
  created_by     uuid not null,
  question       text not null check (length(question) between 1 and 1000),
  status         text not null default 'retrieving' check (status in ('retrieving', 'awaiting_confirmation', 'answering', 'answered', 'failed')),
  evidence       jsonb null,
  estimate       jsonb null,
  approval_id    uuid null references public.workshop_ai_approvals(id) on delete set null,
  answer         jsonb null,
  error          jsonb null,
  spent_usd      numeric(14, 6) not null default 0,
  ai_calls       integer not null default 0,
  claim_id       text null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists workshop_questions_session_idx on public.workshop_questions (session_id, created_at);
-- B8fe P2-3: `ambiguous` = la llamada de IA pudo cobrarse; queda así hasta que el admin concilie su aprobación.
-- (drop + add: idempotente también sobre una tabla creada antes sin ese estado; todavía no aplicada en staging.)
alter table public.workshop_questions drop constraint if exists workshop_questions_status_check;
alter table public.workshop_questions add constraint workshop_questions_status_check check (status in ('retrieving', 'awaiting_confirmation', 'answering', 'answered', 'failed', 'ambiguous'));

-- Aprobaciones de gasto de IA (B5): los tipos nuevos de B8, con el mismo protocolo (estimado → tope → reserva → liquidación).
alter table public.workshop_ai_approvals drop constraint if exists workshop_ai_approvals_kind_check;
alter table public.workshop_ai_approvals add constraint workshop_ai_approvals_kind_check check (kind in ('interpret', 'reinterpret', 'generate', 'quality', 'question'));

alter table public.workshop_quality_runs enable row level security;
alter table public.workshop_quality_findings enable row level security;
alter table public.workshop_questions enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['workshop_quality_runs', 'workshop_quality_findings', 'workshop_questions']
  loop
    foreach r in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table public.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;
