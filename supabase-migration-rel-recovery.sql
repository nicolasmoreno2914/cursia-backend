-- ══════════════════════════════════════════════════════════════════════════
-- Cursia REL R2 — registro de intentos + columnas de recuperación por item
-- (diseño REL §4.1). 100 % ADITIVA e IDEMPOTENTE.
--
-- generation_item_runs (columnas nuevas, todas nullable o con default):
--   failure_class        char(1)  A|B|C|D del último fallo (null = sin fallo)
--   failure_code         text     código estable (≤ 64) del último fallo
--   recovery_strategy    text     estrategia del clasificador central
--   recovery_round       int      rondas automáticas de recuperación (default 0)
--   recovery_max_rounds  int      rondas automáticas que el sistema hará con este fallo
--   cooldown_until       timestamptz  (R3: breakers / esperas C; hoy siempre null)
--   attention_reason     text     budget|config|duplicate_charge|unrecoverable|product_bug (solo C/D terminal)
--
-- generation_item_attempts (nueva): log de intentos. Una fila se ABRE en el claim y se CIERRA
-- en complete/fail/barrido/drain/cancelación, en la MISMA transacción que la transición del item;
-- las reaperturas (retry, auto-heal, regeneración) agregan una fila `reopened`. Una fila cerrada
-- es inmutable (trigger). El costo por intento NO se guarda acá: la vista
-- generation_item_attempt_costs lo lee del ledger (generation_cost_events), única fuente de dinero.
--
-- Nada del código lee estas columnas para DECIDIR (R1/R2 solo registran y exponen); el código
-- tolera su ausencia (sonda de esquema en src/modules/reliability/attempt-log.ts).
--
-- Rollback (solo si se quisiera deshacer; el código tolera la ausencia — tras el rollback, `pm2 reload`
-- de la API y los workers: la sonda de esquema positiva se cachea hasta 5 min):
--   drop view if exists public.generation_item_attempt_costs;
--   drop table if exists public.generation_item_attempts;
--   alter table public.generation_item_runs
--     drop column if exists failure_class, drop column if exists failure_code,
--     drop column if exists recovery_strategy, drop column if exists recovery_round,
--     drop column if exists recovery_max_rounds, drop column if exists cooldown_until,
--     drop column if exists attention_reason;
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

-- ── generation_item_runs: columnas de recuperación ─────────────────────────
-- ADD COLUMN con default constante es solo de catálogo en PG ≥ 11 (sin reescritura).
alter table public.generation_item_runs add column if not exists failure_class char(1);
alter table public.generation_item_runs add column if not exists failure_code text;
alter table public.generation_item_runs add column if not exists recovery_strategy text;
alter table public.generation_item_runs add column if not exists recovery_round integer not null default 0;
alter table public.generation_item_runs add column if not exists recovery_max_rounds integer;
alter table public.generation_item_runs add column if not exists cooldown_until timestamptz;
alter table public.generation_item_runs add column if not exists attention_reason text;

-- CHECKs como NOT VALID + VALIDATE: el ADD no recorre la tabla con lock exclusivo y las columnas
-- nuevas son todas null/0, así que VALIDATE es inmediato.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'gir_failure_class_check') then
    alter table public.generation_item_runs
      add constraint gir_failure_class_check check (failure_class is null or failure_class in ('A','B','C','D')) not valid;
    alter table public.generation_item_runs validate constraint gir_failure_class_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gir_failure_code_len') then
    alter table public.generation_item_runs
      add constraint gir_failure_code_len check (failure_code is null or char_length(failure_code) between 1 and 64) not valid;
    alter table public.generation_item_runs validate constraint gir_failure_code_len;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gir_attention_reason_check') then
    alter table public.generation_item_runs
      add constraint gir_attention_reason_check check (attention_reason is null
        or attention_reason in ('budget','config','duplicate_charge','unrecoverable','product_bug')) not valid;
    alter table public.generation_item_runs validate constraint gir_attention_reason_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gir_recovery_rounds_check') then
    alter table public.generation_item_runs
      add constraint gir_recovery_rounds_check check (recovery_round >= 0
        and (recovery_max_rounds is null or recovery_max_rounds >= 0)) not valid;
    alter table public.generation_item_runs validate constraint gir_recovery_rounds_check;
  end if;
end $$;

-- ── generation_item_attempts ────────────────────────────────────────────────
create table if not exists public.generation_item_attempts (
  id               uuid primary key default gen_random_uuid(),
  item_run_id      uuid not null references public.generation_item_runs(id) on delete cascade,
  job_id           uuid not null,
  course_id        integer,
  item_key         text not null,
  generation       integer not null,
  attempt_no       integer not null default 0 check (attempt_no >= 0),
  executor_kind    text check (executor_kind is null or executor_kind in
                     ('browser','server_llm','video_worker','provider_worker','package_worker','restore_worker')),
  executor_id      text,
  bundle_sha       text,
  worker_version   text,
  started_at       timestamptz not null default now(),
  heartbeat_at     timestamptz,
  finished_at      timestamptz,
  outcome          text check (outcome is null or outcome in
                     ('completed','failed','lease_expired','drained','abandoned','reopened')),
  failure_class    char(1) check (failure_class is null or failure_class in ('A','B','C','D')),
  failure_code     text check (failure_code is null or char_length(failure_code) between 1 and 64),
  error_excerpt    text check (error_excerpt is null or char_length(error_excerpt) <= 500),
  http_status      integer,
  provider         text,
  provider_request_id text,
  -- C1: errorCode que reportó el ejecutor (NO de confianza; la clase efectiva es failure_class).
  reported_error_code text check (reported_error_code is null or char_length(reported_error_code) between 1 and 64),
  strategy_applied text,
  next_retry_at    timestamptz,
  recovery_round   integer not null default 0,
  actor            text not null default 'system',
  created_at       timestamptz not null default now(),
  -- abierto ⇔ sin desenlace; cerrado ⇔ con desenlace y fin.
  constraint gia_open_closed check ((finished_at is null) = (outcome is null))
);

-- Fix round 1 (C1): idempotente también sobre una tabla creada por la versión anterior de esta migración.
alter table public.generation_item_attempts add column if not exists reported_error_code text;

create index if not exists idx_gia_job_item_attempt
  on public.generation_item_attempts (job_id, item_key, generation, attempt_no);
create index if not exists idx_gia_failure_code
  on public.generation_item_attempts (failure_code, created_at);
create index if not exists idx_gia_item_run
  on public.generation_item_attempts (item_run_id, created_at);
-- A lo sumo UN intento abierto por item (doble ejecución imposible de registrar en silencio).
create unique index if not exists uq_gia_open_attempt
  on public.generation_item_attempts (item_run_id) where finished_at is null;

-- Una fila cerrada es inmutable (el log no se reescribe). DELETE solo por la cascada del item.
create or replace function public.gia_closed_row_immutable() returns trigger
language plpgsql as $$
begin
  if old.finished_at is not null then
    raise exception 'generation_item_attempts: la fila % ya está cerrada (inmutable)', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_gia_closed_row_immutable') then
    create trigger trg_gia_closed_row_immutable
      before update on public.generation_item_attempts
      for each row execute function public.gia_closed_row_immutable();
  end if;
end $$;

-- ── Vista de costo por intento (del ledger; sin dinero duplicado) ──────────
-- Solo si el ledger FinOps existe (staging lo migra antes, paso 4h6).
do $$ begin
  if to_regclass('public.generation_cost_events') is not null then
    execute $v$
      create or replace view public.generation_item_attempt_costs with (security_invoker = true) as
      -- M3: un intento devuelto (refundAttempt, cuota de YouTube) reutiliza su attempt_no; solo la PRIMERA
      -- fila de cada (item_run_id, attempt_no) suma los eventos del ledger (nunca se cuenta dos veces).
      with firsts as (
        select distinct on (a.item_run_id, a.attempt_no) a.*
          from public.generation_item_attempts a
         where a.outcome is distinct from 'reopened'
         order by a.item_run_id, a.attempt_no, a.started_at, a.id
      )
      select a.id as attempt_id, a.item_run_id, a.job_id, a.item_key, a.generation, a.attempt_no,
             coalesce(sum(e.amount), 0) as amount,
             coalesce(sum(e.amount) filter (where e.measurement_status = 'pending' and e.event_kind = 'CHARGE'), 0) as pending_amount,
             count(e.id)::int as events
        from firsts a
        left join public.generation_cost_events e
          on e.item_run_id = a.item_run_id and e.attempt = a.attempt_no
       group by a.id, a.item_run_id, a.job_id, a.item_key, a.generation, a.attempt_no
    $v$;
  else
    raise notice 'generation_cost_events no existe: se omite la vista generation_item_attempt_costs';
  end if;
end $$;

-- ── Supabase: nada expuesto a los roles cliente (mismo criterio que FinOps RF-b) ──
do $$
declare
  t text;
  r text;
begin
  execute 'alter table public.generation_item_attempts enable row level security';
  foreach t in array array['generation_item_attempts', 'generation_item_attempt_costs']
  loop
    if to_regclass('public.' || t) is null then continue; end if;
    foreach r in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table public.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;
