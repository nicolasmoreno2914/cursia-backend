-- ══════════════════════════════════════════════════════════════════════════
-- Cursia r75 (Agente C) — presupuestos mensuales por usuario, reservas por run y solicitudes de autorización.
-- Contrato: validation/r75-roles/01-arquitectura-y-decisiones.md §1.5 y §5.
--
-- Principios:
--   * UN solo ledger: estas tablas NO guardan dinero gastado. El gasto sale de generation_cost_events (CostReadService);
--     una reserva apunta a un run y su «reservado vivo» se calcula desde cost_budget_authorizations − ledger del run.
--   * user_budgets es VERSIONADA y append-only (nunca UPDATE/DELETE): un cambio es una fila nueva.
--   * budget_reservations / budget_requests: sin DELETE ni TRUNCATE; las columnas de identidad y monto son inmutables
--     (solo cambian estado y los campos de liquidación / decisión).
--   * RLS activado SIN políticas + REVOKE ALL a anon/authenticated: solo el backend las lee y escribe.
--   * Aditiva e idempotente (create … if not exists). Nunca DROP de tablas ni columnas.
--   * SOLO staging (scripts/migrate-r75-budgets.js); producción NO (EXCLUDED en migrate-v2-production.js hasta que el
--     owner apruebe).
-- Requiere: public.institutions (legacy) y public.finops_forbid_mutation() (supabase-migration-v21-finops.sql); si esa
-- función no existe se crea una equivalente propia (r75_budgets_forbid_mutation).
-- Rollback: CURSIA_USER_BUDGETS=off (las tablas quedan sin uso). No hay «down» destructivo.
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

create or replace function public.r75_budgets_forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% es append-only/inmutable: % no permitido', tg_table_name, tg_op using errcode = 'P0001';
end $$;

-- ── user_budgets: presupuesto mensual por usuario (versionado, append-only) ──────────────────────────────────────
create table if not exists public.user_budgets (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  kind              text not null check (kind in ('recurring', 'month_adjustment')),
  effective_month   date not null check (effective_month = date_trunc('month', effective_month)::date),
  amount_usd        numeric(20,10) not null check (amount_usd >= 0 or kind = 'month_adjustment'),
  version           int not null check (version >= 1),
  institution_id    uuid references public.institutions(id),   -- NULL = global (hoy); reservado para presupuestos por institución
  source_request_id uuid,                                      -- solicitud aprobada que la originó
  reason            text not null check (length(btrim(reason)) between 1 and 1000),
  created_by        uuid not null,
  created_at        timestamptz not null default now()
);
create unique index if not exists user_budgets_version_uq
  on public.user_budgets (user_id, (coalesce(institution_id::text, '')), kind, effective_month, version);
create index if not exists user_budgets_user_month_idx on public.user_budgets (user_id, effective_month);

-- ── budget_reservations: qué run se cargó a qué presupuesto (sin dinero gastado) ─────────────────────────────────
create table if not exists public.budget_reservations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,                               -- quien paga con su presupuesto (iniciador del run)
  institution_id   uuid references public.institutions(id),     -- institución activa → atribución del gasto
  course_id        int not null,
  run_id           uuid not null,                               -- production_jobs.id (lógica; sin FK por la deriva de tipos)
  kind             text not null check (kind in ('start', 'extension', 'upgrade', 'reopen')),
  amount_usd       numeric(20,10) not null check (amount_usd >= 0),
  authorization_id uuid,                                        -- cost_budget_authorizations.id
  status           text not null default 'active' check (status in ('active', 'released', 'settled')),
  period_month     date not null check (period_month = date_trunc('month', period_month)::date),
  created_at       timestamptz not null default now(),
  released_at      timestamptz,
  release_reason   text,
  settled_usd      numeric(20,10)                               -- gasto del run en el ledger al liquidar (foto informativa)
);
create index if not exists budget_reservations_active_idx on public.budget_reservations (user_id, period_month) where status = 'active';
create index if not exists budget_reservations_run_idx on public.budget_reservations (run_id);
-- Una sola reserva 'start' por run (reintentos idempotentes, nunca doble reserva).
create unique index if not exists budget_reservations_start_uq on public.budget_reservations (run_id) where kind = 'start';

-- ── budget_requests: «Solicitar autorización» ────────────────────────────────────────────────────────────────────
create table if not exists public.budget_requests (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  institution_id      uuid references public.institutions(id),
  course_id           int,
  run_id              uuid,
  estimate_id         uuid,
  amount_usd          numeric(20,10) not null check (amount_usd > 0),
  reason              text not null check (length(btrim(reason)) between 1 and 1000),
  status              text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  decided_by          uuid,
  decided_at          timestamptz,
  decision_note       text,
  approved_amount_usd numeric(20,10) check (approved_amount_usd is null or approved_amount_usd > 0),
  resulting_budget_id uuid,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null default now() + interval '7 days'
);
-- Una pendiente por (usuario, curso). Sin curso: una pendiente por usuario (coalesce a -1).
create unique index if not exists budget_requests_one_pending_uq
  on public.budget_requests (user_id, (coalesce(course_id, -1))) where status = 'pending';
create index if not exists budget_requests_status_idx on public.budget_requests (status, created_at);

-- ── atribución por institución en el ledger (solo índice; la columna ya existe, text) ────────────────────────────
do $$
begin
  if to_regclass('public.generation_cost_events') is not null then
    execute 'create index if not exists gce_institution_id_idx on public.generation_cost_events (institution_id) where institution_id is not null';
  end if;
end $$;

-- ── inmutabilidad ────────────────────────────────────────────────────────────────────────────────────────────────
-- user_budgets: append-only total.
-- budget_reservations: sin DELETE/TRUNCATE; user_id/institution_id/course_id/run_id/kind/amount_usd/authorization_id/
--   period_month/created_at inmutables; status solo active → released|settled (o vuelta a active si el run se reabre).
-- budget_requests: sin DELETE/TRUNCATE; identidad, monto y motivo inmutables; una decisión tomada no se cambia.
create or replace function public.r75_budget_reservations_guard() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'budget_reservations: % no permitido', tg_op using errcode = 'P0001';
  end if;
  if new.user_id is distinct from old.user_id or new.institution_id is distinct from old.institution_id
     or new.course_id is distinct from old.course_id or new.run_id is distinct from old.run_id
     or new.kind is distinct from old.kind or new.amount_usd is distinct from old.amount_usd
     or new.authorization_id is distinct from old.authorization_id or new.period_month is distinct from old.period_month
     or new.created_at is distinct from old.created_at then
    raise exception 'budget_reservations: solo cambian el estado y la liquidación' using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function public.r75_budget_requests_guard() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'budget_requests: % no permitido', tg_op using errcode = 'P0001';
  end if;
  if new.user_id is distinct from old.user_id or new.institution_id is distinct from old.institution_id
     or new.course_id is distinct from old.course_id or new.run_id is distinct from old.run_id
     or new.estimate_id is distinct from old.estimate_id or new.amount_usd is distinct from old.amount_usd
     or new.reason is distinct from old.reason or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'budget_requests: la solicitud es inmutable salvo su decisión' using errcode = 'P0001';
  end if;
  if old.status <> 'pending' then
    raise exception 'budget_requests: la solicitud ya está cerrada (%)', old.status using errcode = 'P0001';
  end if;
  return new;
end $$;

do $$
declare
  forbid text := case when to_regprocedure('public.finops_forbid_mutation()') is not null
                      then 'public.finops_forbid_mutation()' else 'public.r75_budgets_forbid_mutation()' end;
begin
  if not exists (select 1 from pg_trigger where tgname = 'user_budgets_append_only' and tgrelid = 'public.user_budgets'::regclass) then
    execute 'create trigger user_budgets_append_only before update or delete on public.user_budgets for each row execute function ' || forbid;
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'user_budgets_no_truncate' and tgrelid = 'public.user_budgets'::regclass) then
    execute 'create trigger user_budgets_no_truncate before truncate on public.user_budgets for each statement execute function ' || forbid;
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'budget_reservations_guard' and tgrelid = 'public.budget_reservations'::regclass) then
    execute 'create trigger budget_reservations_guard before update or delete on public.budget_reservations for each row execute function public.r75_budget_reservations_guard()';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'budget_reservations_no_truncate' and tgrelid = 'public.budget_reservations'::regclass) then
    execute 'create trigger budget_reservations_no_truncate before truncate on public.budget_reservations for each statement execute function ' || forbid;
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'budget_requests_guard' and tgrelid = 'public.budget_requests'::regclass) then
    execute 'create trigger budget_requests_guard before update or delete on public.budget_requests for each row execute function public.r75_budget_requests_guard()';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'budget_requests_no_truncate' and tgrelid = 'public.budget_requests'::regclass) then
    execute 'create trigger budget_requests_no_truncate before truncate on public.budget_requests for each statement execute function ' || forbid;
  end if;
end $$;

-- ── RLS sin políticas + REVOKE a los roles cliente de Supabase ───────────────────────────────────────────────────
do $$
declare
  t text;
  r text;
begin
  foreach t in array array['user_budgets', 'budget_reservations', 'budget_requests']
  loop
    execute format('alter table public.%I enable row level security', t);
    foreach r in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table public.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;
