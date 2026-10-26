-- r75 · Agente E — Supabase mínimo para el PG descartable (NUNCA se aplica fuera de la base local de la suite).
-- auth.users + auth.uid()/auth.email() leyendo request.jwt.claims (como PostgREST), roles anon/authenticated, y
-- authorized_users con la forma del FE (supabase-schema.sql) más el estado de RLS OBSERVADO EN STAGING el 2026-10-26
-- (H2: un usuario autenticado pudo INSERT/UPDATE/DELETE). La migración r75-access debe corregirlo.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key, email text, email_confirmed_at timestamptz, banned_until timestamptz, last_sign_in_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')::uuid $$;
create or replace function auth.email() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claims', true)::jsonb->>'email', '') $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public, auth to anon, authenticated;
grant execute on function auth.uid(), auth.email() to anon, authenticated;

create table if not exists public.authorized_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  is_admin boolean default false,
  created_at timestamptz default now()
);
alter table public.authorized_users enable row level security;
drop policy if exists "users check own authorization" on public.authorized_users;
create policy "users check own authorization" on public.authorized_users for select using (email = auth.email());
-- Estado peligroso simulado (H2): escrituras de cliente permitidas.
drop policy if exists "r75 h2 simulated write" on public.authorized_users;
create policy "r75 h2 simulated write" on public.authorized_users for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.authorized_users to authenticated;
