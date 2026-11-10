-- ════════════════════════════════════════════════════════════════════════
-- Cursia — r107 B5 «Taller de cursos»: pedidos, preguntas y plan.
--
--   workshop_intakes     UNA entrada del docente: texto escrito, documento (DOCX / PDF / TXT / MD, ≤ 10 MB, subido por URL
--                        firmada a su carpeta), «Arreglar esto» de un hallazgo o un aviso de desalineación agregado. Guarda
--                        el texto TAL CUAL (es dato no confiable: va a la IA delimitado), su estado (awaiting_upload →
--                        queued → interpreting → ready | failed + error visible) y la IA gastada en interpretarlo.
--   workshop_requests    un PEDIDO estructurado por fila: cita literal, instrucción, operación del catálogo (o null),
--                        destino resuelto contra el inventario, estado (needs_answer / preparing / resolved / phase_later /
--                        out_of_scope / unavailable / failed / withdrawn), preguntas y respuestas (D6), motivo visible.
--   workshop_plans       UN plan borrador por (sesión, sha1 del original): estado `draft` (aprobar y aplicar es B6) y la
--                        prueba en seco del plan combinado.
--   workshop_plan_items  un ítem por pedido resuelto o de fase posterior: operación + parámetros resueltos (lo que B6 le
--                        pasa al motor), antes/después, riesgo, costo (gastado + lo que falta al aplicar), avisos de
--                        desalineación (D7, nunca agregados solos) y la prueba en seco del motor; `proposed` / `removed`.
--                        Etapa `estimate` = todavía SIN contenido generado (solo su costo estimado); `ready` = con
--                        antes/después reales.
--   workshop_ai_approvals  APROBACIÓN de gasto de IA (D8/D9: ninguna llamada a la IA sin ella): qué se aprueba
--                        (interpretar una entrada / re-interpretar un pedido / generar el contenido de ítems), el
--                        estimado mostrado, el TOPE aprobado (reservado de una vez en el ledger de FinOps: reservation_key),
--                        lo gastado, cada llamada con su estado, y el estado (reserved → running → done | stopped (tope
--                        alcanzado) | failed | ambiguous (una llamada con resultado desconocido: la reserva queda pendiente)).
--
-- Tablas NUEVAS; ninguna existente cambia (FK a workshop_sessions ON DELETE CASCADE). Aditiva e idempotente. RLS
-- encendido y sin privilegios para anon/authenticated: solo el backend (service role). Mismo patrón que B1–B3.
-- SOLO staging (deploy-staging.yml → scripts/migrate-r107-b5-plan.js) hasta aprobación del owner (EXCLUDED en
-- scripts/prod/migrate-v2-production.js). Sin las tablas, la API del Taller responde 503 COURSE_WORKSHOP_NOT_MIGRATED.
--
-- Rollback (aditiva; con el flag apagado nada la usa):
--   drop table if exists public.workshop_ai_approvals;
--   drop table if exists public.workshop_plan_items; drop table if exists public.workshop_plans;
--   drop table if exists public.workshop_requests; drop table if exists public.workshop_intakes;
-- ════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';

create table if not exists public.workshop_intakes (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.workshop_sessions(id) on delete cascade,
  original_sha1  text not null check (original_sha1 ~ '^[0-9a-f]{40}$'),
  created_by     uuid not null,
  source         text not null check (source in ('text', 'document', 'finding', 'misalignment')),
  status         text not null default 'awaiting_confirmation' check (status in ('awaiting_upload', 'extracting', 'awaiting_confirmation', 'queued', 'interpreting', 'ready', 'failed')),
  filename       text null,
  media_type     text null,
  storage_path   text null,
  declared_bytes bigint null,
  text           text null check (text is null or length(text) <= 200000),
  text_sha1      text null,
  claim_id       text null,
  error          jsonb null,
  notes          jsonb not null default '[]'::jsonb,
  estimate       jsonb null,
  approval_id    uuid null,
  spent_usd      numeric(14, 6) not null default 0,
  ai_calls       integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists workshop_intakes_session_idx on public.workshop_intakes (session_id, created_at);

create table if not exists public.workshop_requests (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.workshop_sessions(id) on delete cascade,
  intake_id      uuid not null references public.workshop_intakes(id) on delete cascade,
  ordinal        integer not null check (ordinal >= 0),
  finding_id     text null,
  quote          text not null,
  instruction    text not null default '',
  operation      text null check (operation is null or operation in ('edit_html', 'edit_libro_section', 'exam_question_replace', 'exam_question_add', 'exam_question_remove', 'brand_replace', 'remove_activity', 'regenerate_scorm', 'regenerate_video', 'regenerate_gamma', 'regenerate_audio', 'add_chapter', 'add_module')),
  status         text not null check (status in ('needs_answer', 'awaiting_confirmation', 'awaiting_generation', 'preparing', 'resolved', 'phase_later', 'out_of_scope', 'unavailable', 'failed', 'withdrawn')),
  target         jsonb null,
  raw_target     jsonb null,
  details        jsonb not null default '{}'::jsonb,
  questions      jsonb not null default '[]'::jsonb,
  answers        jsonb not null default '[]'::jsonb,
  rounds         integer not null default 0,
  reason         text null,
  estimate       jsonb null,
  spent_usd      numeric(14, 6) not null default 0,
  ai_calls       integer not null default 0,
  claim_id       text null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists workshop_requests_session_idx on public.workshop_requests (session_id, created_at, ordinal);
-- «Arreglar esto» idempotente: un pedido activo por hallazgo.
create unique index if not exists workshop_requests_finding_uidx on public.workshop_requests (session_id, finding_id) where finding_id is not null and status <> 'withdrawn';

create table if not exists public.workshop_plans (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.workshop_sessions(id) on delete cascade,
  original_sha1  text not null check (original_sha1 ~ '^[0-9a-f]{40}$'),
  status         text not null default 'draft' check (status in ('draft')),
  combined       jsonb null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists workshop_plans_version_uidx on public.workshop_plans (session_id, original_sha1);

create table if not exists public.workshop_plan_items (
  id             uuid primary key default gen_random_uuid(),
  plan_id        uuid not null references public.workshop_plans(id) on delete cascade,
  request_id     uuid not null references public.workshop_requests(id) on delete cascade,
  status         text not null default 'proposed' check (status in ('proposed', 'removed')),
  stage          text not null default 'ready' check (stage in ('estimate', 'ready')),
  operation      text not null,
  available      boolean not null,
  params         jsonb null,
  view           jsonb not null,
  risk_level     text not null check (risk_level in ('bajo', 'medio', 'alto')),
  -- Fix round 1 (P2-4): riesgo alto → B6 exige confirmar este ítem por separado al aplicar.
  requires_item_confirm boolean not null default false,
  spent_usd      numeric(14, 6) not null default 0,
  apply_expected_usd numeric(14, 6) not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists workshop_plan_items_request_uidx on public.workshop_plan_items (request_id);
create index if not exists workshop_plan_items_plan_idx on public.workshop_plan_items (plan_id, created_at);

create table if not exists public.workshop_ai_approvals (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null references public.workshop_sessions(id) on delete cascade,
  created_by       uuid not null,
  kind             text not null check (kind in ('interpret', 'reinterpret', 'generate')),
  intake_id        uuid null references public.workshop_intakes(id) on delete cascade,
  request_id       uuid null references public.workshop_requests(id) on delete cascade,
  item_ids         jsonb not null default '[]'::jsonb,
  estimate         jsonb not null,
  cap_usd          numeric(14, 6) not null check (cap_usd > 0),
  spent_usd        numeric(14, 6) not null default 0,
  ai_calls         integer not null default 0,
  reservation_key  text null,
  -- Fix round 1 (P1-1): cada llamada con su estado (sent → charged | not_charged | ambiguous | charge_unrecorded). La
  -- reserva se libera SOLO si ninguna quedó con resultado desconocido o sin su cargo en el ledger; si no, la aprobación
  -- queda `ambiguous` y la reserva PENDIENTE para conciliar (nunca gasto real sin registrar).
  calls            jsonb not null default '{}'::jsonb,
  status           text not null default 'reserved' check (status in ('reserved', 'running', 'done', 'stopped', 'failed', 'ambiguous')),
  stop_reason      text null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists workshop_ai_approvals_session_idx on public.workshop_ai_approvals (session_id, created_at);

alter table public.workshop_ai_approvals enable row level security;
alter table public.workshop_intakes enable row level security;
alter table public.workshop_requests enable row level security;
alter table public.workshop_plans enable row level security;
alter table public.workshop_plan_items enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['workshop_intakes', 'workshop_requests', 'workshop_plans', 'workshop_plan_items', 'workshop_ai_approvals']
  loop
    foreach r in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table public.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;
