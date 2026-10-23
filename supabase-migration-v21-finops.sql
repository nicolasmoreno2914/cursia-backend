-- ══════════════════════════════════════════════════════════════════════════
-- Cursia V2.1 RF-a — Cost Ledger / FinOps (audit §W.3).
--
-- 100% aditivo: solo CREATE TABLE IF NOT EXISTS + índices + triggers nuevos.
-- No toca ninguna tabla existente (usage_events / cost_rates quedan como
-- legacy, intactas). Idempotente: cada objeto se crea solo si falta.
-- Corre exclusivamente contra STAGING — ver scripts/migrate-v21-finops.js
-- (MIGRATION_ENV=staging + lista negra del ref de producción). El seed de
-- precios (src/modules/finops/pricing-seed.v1.json) lo inserta ese script
-- con ON CONFLICT DO NOTHING, no este SQL.
--
-- Las referencias a courses / production_jobs / generation_item_runs son
-- FKs LÓGICAS (sin constraint): el ledger es append-only y un ON DELETE
-- CASCADE desde un curso borrado chocaría con el trigger que prohíbe DELETE.
--
-- Rollback (solo si no hay datos que conservar):
--   drop table if exists public.cost_avoidance_events, public.cost_budget_authorizations,
--     public.cost_budget_policies, public.cost_estimates, public.generation_cost_events,
--     public.pricing_catalog;
--   drop function if exists public.finops_forbid_mutation();
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

-- Función compartida: rechaza UPDATE / DELETE / TRUNCATE en tablas inmutables
-- o append-only. `create or replace function` no toma locks sobre tablas.
create or replace function public.finops_forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% es append-only/inmutable: % no permitido', tg_table_name, tg_op using errcode = 'P0001';
end $$;

-- ── pricing_catalog (inmutable: un precio nuevo es una fila nueva) ─────────
create table if not exists public.pricing_catalog (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null,
  service           text not null,
  product_or_model  text not null,
  meter             text not null,
  unit_size         numeric(20,6) not null check (unit_size > 0),
  unit_price        numeric(20,10) not null check (unit_price >= 0),
  currency          char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  pricing_version   text not null,
  effective_from    timestamptz not null,
  effective_to      timestamptz,
  source            text not null
                    check (source in ('public_pricing_page','contract','observed_invoice','observed','placeholder','by_design')),
  source_ref        text,
  verified          boolean not null default false,
  created_by        text,
  created_at        timestamptz not null default now(),
  constraint pricing_catalog_version_key unique (provider, service, product_or_model, meter, pricing_version),
  constraint pricing_catalog_effective_range check (effective_to is null or effective_to > effective_from)
);
create index if not exists idx_pricing_catalog_lookup
  on public.pricing_catalog (provider, service, product_or_model, meter, effective_from);

-- ── generation_cost_events (ledger append-only) ─────────────────────────────
create table if not exists public.generation_cost_events (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  event_kind            text not null check (event_kind in ('CHARGE','ADJUSTMENT','REFUND')),
  corrects_event_id     uuid references public.generation_cost_events(id),
  -- atribución (derivada server-side; nulas si no aplica o si fue rechazada)
  owner_id              text,
  institution_id        text,
  course_id             integer,
  blueprint_id          integer,
  manifest_id           integer,
  run_id                uuid,
  item_run_id           uuid,
  item_key              text,
  item_type             text,
  item_generation       integer,
  scope                 text check (scope is null or scope in ('course','module','chapter','run','org')),
  module_id             uuid,
  chapter_id            uuid,
  -- operación
  operation             text not null,
  call_role             text not null default 'main'
                        check (call_role in ('main','validation_retry','continuation','context_summary_retry','fallback_template','provider_retry')),
  attempt               integer not null default 1 check (attempt >= 1),
  provider              text not null,
  service               text,
  model_or_product      text,
  external_operation_id text,
  idempotency_key       text not null,
  -- medición y precio
  usage                 jsonb not null default '{}',
  usage_quantity        numeric(20,6),
  usage_unit            text,
  pricing_snapshot      jsonb,
  amount                numeric(20,10) not null,
  currency              char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  cost_source           text not null
                        check (cost_source in ('ACTUAL_PROVIDER','CALCULATED_FROM_USAGE','ESTIMATED','ZERO_BY_DESIGN','MOCK')),
  measurement_status    text not null default 'final' check (measurement_status in ('final','pending')),
  -- facturación
  billing_account       text not null check (billing_account in ('cursia','user_key','mock')),
  billable              boolean not null,
  outcome               text not null default 'succeeded'
                        check (outcome in ('succeeded','failed_charged','failed_uncharged')),
  quota_units           numeric(20,6),
  recorded_by           text not null,
  metadata              jsonb not null default '{}',
  constraint gce_idempotency_key unique (idempotency_key),
  -- CHARGE nunca corrige; ADJUSTMENT/REFUND siempre corrigen un evento.
  constraint gce_corrects_kind check ((event_kind = 'CHARGE') = (corrects_event_id is null)),
  constraint gce_charge_non_negative check (event_kind <> 'CHARGE' or amount >= 0),
  constraint gce_refund_non_positive check (event_kind <> 'REFUND' or amount <= 0),
  -- ESTIMATED solo existe en cost_estimates (audit §W.2): nunca en el ledger de cargos.
  constraint gce_no_estimated check (cost_source <> 'ESTIMATED'),
  constraint gce_mock_consistent check ((cost_source = 'MOCK') = (billing_account = 'mock')),
  constraint gce_non_billable_accounts check (billing_account = 'cursia' or billable = false),
  constraint gce_zero_by_design check (cost_source <> 'ZERO_BY_DESIGN' or amount = 0)
);
create index if not exists idx_gce_course_id  on public.generation_cost_events (course_id);
create index if not exists idx_gce_run_id     on public.generation_cost_events (run_id);
create index if not exists idx_gce_item_run   on public.generation_cost_events (item_run_id);
create index if not exists idx_gce_owner_id   on public.generation_cost_events (owner_id);
create index if not exists idx_gce_created_at on public.generation_cost_events (created_at);
create index if not exists idx_gce_corrects   on public.generation_cost_events (corrects_event_id) where corrects_event_id is not null;

-- ── cost_estimates (inmutable; una fila por cálculo) ────────────────────────
create table if not exists public.cost_estimates (
  id                     uuid primary key default gen_random_uuid(),
  created_at             timestamptz not null default now(),
  scope                  text not null check (scope in ('run','regeneration','course_preview')),
  owner_id               text,
  course_id              integer,
  manifest_id            integer,
  run_id                 uuid,
  invalidation_plan_sha  text,
  estimator_version      text not null,
  pricing_versions       jsonb not null default '[]',
  usage_model_version    text,
  lines                  jsonb not null default '[]',
  totals                 jsonb not null default '{}',
  currency               char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  created_by             text
);
create index if not exists idx_cost_estimates_course on public.cost_estimates (course_id);
create index if not exists idx_cost_estimates_run    on public.cost_estimates (run_id);

-- ── cost_budget_policies (versionadas; cada versión es una fila inmutable) ─
create table if not exists public.cost_budget_policies (
  id                                        uuid primary key default gen_random_uuid(),
  scope                                     text not null check (scope in ('global','institution','owner','course')),
  scope_id                                  text,
  version                                   integer not null check (version >= 1),
  -- { maxCostPerRun, maxCostPerCourse, maxCostPerProvider:{…}, maxCostPerItemType:{…} } — null = sin límite.
  limits                                    jsonb not null default '{}',
  require_human_approval_for_real_spend     boolean not null default true,
  on_exceed                                 text not null default 'BLOCK' check (on_exceed in ('BLOCK','ADMIN_APPROVAL')),
  created_by                                text,
  created_at                                timestamptz not null default now(),
  constraint cbp_scope_id check ((scope = 'global') = (scope_id is null))
);
create unique index if not exists uq_cost_budget_policies_version
  on public.cost_budget_policies (scope, coalesce(scope_id, ''), version);

-- ── cost_budget_authorizations (append-only) ────────────────────────────────
create table if not exists public.cost_budget_authorizations (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  run_id             uuid,
  course_id          integer not null,
  estimate_id        uuid references public.cost_estimates(id),
  authorized_budget  numeric(20,10) not null check (authorized_budget >= 0),
  currency           char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  policy_id          uuid references public.cost_budget_policies(id),
  decision           text not null check (decision in ('AUTO_WITHIN_POLICY','ADMIN_APPROVED','BLOCKED')),
  approved_by        text,
  reason             text,
  constraint cba_admin_approved_by check (decision <> 'ADMIN_APPROVED' or approved_by is not null)
);
create index if not exists idx_cba_run    on public.cost_budget_authorizations (run_id);
create index if not exists idx_cba_course on public.cost_budget_authorizations (course_id);

-- ── cost_avoidance_events (append-only, idempotente por run+item) ─────────
create table if not exists public.cost_avoidance_events (
  id                        uuid primary key default gen_random_uuid(),
  created_at                timestamptz not null default now(),
  run_id                    uuid not null,
  course_id                 integer,
  manifest_id               integer,
  item_key                  text not null,
  action                    text not null check (action in ('REUSE','REVIEW','STALE_NO_AUTO','SOFT_DISABLE_reenabled')),
  source_item_run_id        uuid,
  basis                     text not null check (basis in ('historical_actual','current_estimate')),
  avoided_amount            numeric(20,10) not null check (avoided_amount >= 0),
  currency                  char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  source_charge_event_ids   uuid[] not null default '{}',
  pricing_snapshot          jsonb,
  constraint cae_run_item_key unique (run_id, item_key),
  constraint cae_historical_has_events check (basis <> 'historical_actual' or cardinality(source_charge_event_ids) > 0)
);
create index if not exists idx_cae_course on public.cost_avoidance_events (course_id);

-- ── Triggers de inmutabilidad (solo si faltan) ──────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['pricing_catalog','generation_cost_events','cost_estimates',
                           'cost_budget_policies','cost_budget_authorizations','cost_avoidance_events']
  loop
    if not exists (
      select 1 from pg_trigger tg
        join pg_class c on c.oid = tg.tgrelid
        join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
       where c.relname = t and tg.tgname = t || '_append_only' and not tg.tgisinternal
    ) then
      execute format(
        'create trigger %I before update or delete on public.%I for each row execute function public.finops_forbid_mutation()',
        t || '_append_only', t);
    end if;
    if not exists (
      select 1 from pg_trigger tg
        join pg_class c on c.oid = tg.tgrelid
        join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
       where c.relname = t and tg.tgname = t || '_no_truncate' and not tg.tgisinternal
    ) then
      execute format(
        'create trigger %I before truncate on public.%I for each statement execute function public.finops_forbid_mutation()',
        t || '_no_truncate', t);
    end if;
  end loop;
end $$;

-- Roles de cliente de Supabase (si existen): sin UPDATE/DELETE/TRUNCATE sobre
-- el ledger (defensa adicional al trigger). El backend escribe con su propio rol.
do $$
declare
  r text;
begin
  foreach r in array array['anon','authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke update, delete, truncate on public.generation_cost_events from %I', r);
      execute format('revoke update, delete, truncate on public.cost_avoidance_events from %I', r);
      execute format('revoke update, delete, truncate on public.cost_budget_authorizations from %I', r);
    end if;
  end loop;
end $$;
