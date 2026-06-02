-- P2.1 — Content worker groundwork
-- Extiende production_jobs para soportar ejecución backend_content.

alter table if exists public.production_jobs
  add column if not exists execution_mode text default 'frontend',
  add column if not exists worker_status text,
  add column if not exists worker_id text,
  add column if not exists lease_until timestamptz,
  add column if not exists claimed_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists max_attempts integer not null default 3,
  add column if not exists next_retry_at timestamptz,
  add column if not exists input_payload jsonb not null default '{}'::jsonb,
  add column if not exists output_summary jsonb not null default '{}'::jsonb,
  add column if not exists content_snapshot_artifact_id uuid null references public.artifacts(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'production_jobs_execution_mode_check'
  ) then
    alter table public.production_jobs
      add constraint production_jobs_execution_mode_check
      check (execution_mode in ('frontend', 'backend_content', 'backend_full_future'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'production_jobs_worker_status_check'
  ) then
    alter table public.production_jobs
      add constraint production_jobs_worker_status_check
      check (
        worker_status is null or worker_status in (
          'queued',
          'running',
          'retrying',
          'blocked',
          'failed_recoverable',
          'completed',
          'failed',
          'cancelled'
        )
      );
  end if;
end $$;

create index if not exists idx_production_jobs_execution_mode
  on public.production_jobs(execution_mode);

create index if not exists idx_production_jobs_worker_status
  on public.production_jobs(worker_status);

create index if not exists idx_production_jobs_worker_claim
  on public.production_jobs(execution_mode, worker_status, lease_until, next_retry_at, created_at);

create index if not exists idx_production_jobs_next_retry_at
  on public.production_jobs(next_retry_at);

create index if not exists idx_production_jobs_content_snapshot_artifact_id
  on public.production_jobs(content_snapshot_artifact_id);
