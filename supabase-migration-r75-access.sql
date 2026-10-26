-- ══════════════════════════════════════════════════════════════════════════
-- Cursia r75 · Agente A — instituciones multi-miembro, roles por institución,
-- overrides de permisos, suspensiones, control de plataforma y auditoría.
-- Spec vinculante: validation/r75-roles/01-arquitectura-y-decisiones.md §1.1–1.4, 1.6, 1.7.
--
-- Propiedades:
--   - ADITIVA e IDEMPOTENTE: create … if not exists, add column if not exists,
--     constraints / triggers / políticas por nombre. Nunca DROP de tablas ni columnas.
--     Única excepción: DROP POLICY sobre authorized_users de toda política que no sea
--     «SELECT de la propia fila» (H2: el navegador no puede escribir la allow-list).
--   - Tablas nuevas: uuid; RLS activado SIN políticas + REVOKE ALL a anon/authenticated
--     (solo el backend, dueño de las tablas, accede).
--   - Historia/auditoría: admin_audit_log append-only (trigger propio, no depende de
--     finops_forbid_mutation). Membresías y overrides: sin DELETE físico. Suspensiones:
--     solo se puede «levantar» una vez (lifted_*), nunca borrar ni reescribir.
--   - Columnas nuevas en tablas legacy (courses, institutions.created_by): varchar(36),
--     igual que owner_id (D-2).
--   - SOLO STAGING (scripts/migrate-r75-access.js). Producción: NUNCA en r75 (EXCLUDED en
--     scripts/prod/migrate-v2-production.js hasta aprobación del owner).
-- Rollback: los flags CURSIA_RBAC_MODE / CURSIA_ACCOUNT_GUARD vuelven a off; las tablas
--   quedan sin uso. No hay down destructivo.
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

create extension if not exists pgcrypto;

-- ── Funciones de inmutabilidad (propias de r75) ────────────────────────────
create or replace function public.r75_forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% es append-only: % no permitido', tg_table_name, tg_op using errcode = 'P0001';
end $$;

-- Suspensiones: solo se puede levantar UNA vez (lifted_by/lifted_at/lift_reason); el resto es inmutable.
create or replace function public.r75_suspension_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'user_suspensions es historia: DELETE no permitido' using errcode = 'P0001';
  end if;
  if old.lifted_at is not null then
    raise exception 'user_suspensions: una suspensión levantada es inmutable' using errcode = 'P0001';
  end if;
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id or new.kind is distinct from old.kind
     or new.reason is distinct from old.reason or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'user_suspensions: solo se pueden escribir lifted_by/lifted_at/lift_reason' using errcode = 'P0001';
  end if;
  if new.lifted_at is null or new.lifted_by is null then
    raise exception 'user_suspensions: levantar exige lifted_by y lifted_at' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ── 1.1 institutions (se extiende) ─────────────────────────────────────────
alter table public.institutions
  add column if not exists kind       text not null default 'organization',
  add column if not exists status     text not null default 'active',
  add column if not exists created_by varchar(36);

-- Si las columnas ya existían sin default / nullable (p. ej. creadas por synchronize de TypeORM en una base local de
-- pruebas), se normalizan: default, relleno de NULL y NOT NULL. Idempotente.
alter table public.institutions alter column kind set default 'organization', alter column status set default 'active';
update public.institutions set kind = 'organization' where kind is null;
update public.institutions set status = 'active' where status is null;
alter table public.institutions alter column kind set not null, alter column status set not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'institutions_kind_r75_check') then
    alter table public.institutions add constraint institutions_kind_r75_check check (kind in ('organization','personal'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'institutions_status_r75_check') then
    alter table public.institutions add constraint institutions_status_r75_check check (status in ('active','suspended','archived'));
  end if;
end $$;

-- ── 1.2 institution_memberships ────────────────────────────────────────────
create table if not exists public.institution_memberships (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete restrict,
  user_id        uuid not null,
  role           text not null,
  status         text not null default 'active',
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_by     uuid,
  updated_at     timestamptz not null default now(),
  constraint institution_memberships_role_check   check (role in ('ADMIN_INSTITUCIONAL','CREADOR','APROBADOR_ACADEMICO','CONSULTA')),
  constraint institution_memberships_status_check check (status in ('active','suspended','removed')),
  constraint institution_memberships_inst_user_key unique (institution_id, user_id)
);
create index if not exists institution_memberships_user_active_idx
  on public.institution_memberships (user_id) where status = 'active';
create index if not exists institution_memberships_inst_idx
  on public.institution_memberships (institution_id, status);

-- ── 1.3 institution_permission_overrides ───────────────────────────────────
create table if not exists public.institution_permission_overrides (
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete restrict,
  user_id        uuid not null,
  permission     text not null,
  effect         text not null,
  reason         text,
  created_by     uuid not null,
  created_at     timestamptz not null default now(),
  revoked_by     uuid,
  revoked_at     timestamptz,
  constraint institution_permission_overrides_effect_check check (effect in ('grant','deny')),
  constraint institution_permission_overrides_permission_check check (permission in (
    'courses.view','courses.create','courses.edit','courses.delete','proposals.review','proposals.approve',
    'generations.start','generations.retry','exports.download','spend.view','roles.manage','budgets.manage',
    'users.suspend','generations.suspend')),
  constraint institution_permission_overrides_key unique (institution_id, user_id, permission)
);
create index if not exists institution_permission_overrides_user_idx
  on public.institution_permission_overrides (user_id) where revoked_at is null;

-- ── 1.4 courses: autoría (A agrega; B y C escriben) ───────────────────────
alter table public.courses
  add column if not exists created_by   varchar(36),
  add column if not exists updated_by   varchar(36),
  add column if not exists approved_by  varchar(36),
  add column if not exists approved_at  timestamptz,
  add column if not exists generated_by varchar(36),
  add column if not exists generated_at timestamptz;

-- Índice por institución solo si no hay ya uno de una sola columna (la entity TypeORM puede haberlo creado).
do $$ begin
  if not exists (
    select 1 from pg_index i
      join pg_class t on t.oid = i.indrelid and t.relname = 'courses'
      join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
      join pg_attribute a on a.attrelid = t.oid and a.attnum = i.indkey[0] and a.attname = 'institution_id'
     where i.indnatts = 1
  ) then
    create index courses_institution_id_idx on public.courses (institution_id);
  end if;
end $$;

-- ── 1.6 suspensiones, control de plataforma, auditoría ─────────────────────
create table if not exists public.user_suspensions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  kind        text not null,
  reason      text not null,
  created_by  uuid not null,
  created_at  timestamptz not null default now(),
  lifted_by   uuid,
  lifted_at   timestamptz,
  lift_reason text,
  constraint user_suspensions_kind_check check (kind in ('account','generation'))
);
create unique index if not exists user_suspensions_one_active_idx
  on public.user_suspensions (user_id, kind) where lifted_at is null;

create table if not exists public.platform_controls (
  key        text primary key,
  enabled    boolean not null,
  reason     text,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  constraint platform_controls_key_check check (key in ('generation_freeze'))
);

create table if not exists public.admin_audit_log (
  id                  bigserial primary key,
  at                  timestamptz not null default now(),
  actor_id            uuid not null,
  actor_email         text,
  actor_is_superadmin boolean not null,
  action              text not null,
  target_type         text not null,
  target_id           text,
  institution_id      uuid,
  before              jsonb,
  after               jsonb,
  request_id          text,
  ip_hash             text
);
create index if not exists admin_audit_log_at_idx          on public.admin_audit_log (at desc, id desc);
create index if not exists admin_audit_log_actor_idx       on public.admin_audit_log (actor_id, id desc);
create index if not exists admin_audit_log_target_idx      on public.admin_audit_log (target_type, target_id, id desc);
create index if not exists admin_audit_log_institution_idx on public.admin_audit_log (institution_id, id desc) where institution_id is not null;

-- Triggers (idempotentes por nombre).
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('admin_audit_log',                  'admin_audit_log_append_only',  'before update or delete', 'row',       'r75_forbid_mutation'),
      ('admin_audit_log',                  'admin_audit_log_no_truncate',  'before truncate',         'statement', 'r75_forbid_mutation'),
      ('institution_memberships',          'institution_memberships_no_delete', 'before delete',      'row',       'r75_forbid_mutation'),
      ('institution_memberships',          'institution_memberships_no_truncate', 'before truncate',  'statement', 'r75_forbid_mutation'),
      ('institution_permission_overrides', 'institution_permission_overrides_no_delete', 'before delete', 'row',   'r75_forbid_mutation'),
      ('institution_permission_overrides', 'institution_permission_overrides_no_truncate', 'before truncate', 'statement', 'r75_forbid_mutation'),
      ('user_suspensions',                 'user_suspensions_guard',       'before update or delete', 'row',       'r75_suspension_guard'),
      ('user_suspensions',                 'user_suspensions_no_truncate', 'before truncate',         'statement', 'r75_forbid_mutation')
    ) as s(tbl, trg, timing, lvl, fn)
  loop
    if not exists (
      select 1 from pg_trigger tg
        join pg_class c on c.oid = tg.tgrelid
        join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
       where c.relname = spec.tbl and tg.tgname = spec.trg and not tg.tgisinternal
    ) then
      execute format('create trigger %I %s on public.%I for each %s execute function public.%I()',
                     spec.trg, spec.timing, spec.tbl, spec.lvl, spec.fn);
    end if;
  end loop;
end $$;

-- ── 1.7 authorized_users (allow-list de plataforma) ────────────────────────
-- Staging ya la tiene (la creó el FE: id, email unique, is_admin, created_at). En una base local
-- descartable puede no existir: se crea con la misma forma.
create table if not exists public.authorized_users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique not null,
  is_admin   boolean default false,
  created_at timestamptz default now()
);
alter table public.authorized_users
  add column if not exists user_id uuid,
  add column if not exists status  text default 'active';
create unique index if not exists authorized_users_user_id_r75_key
  on public.authorized_users (user_id) where user_id is not null;
create index if not exists authorized_users_lower_email_r75_idx
  on public.authorized_users (lower(email));

-- user_id desde auth.users por email (solo filas sin user_id; nunca pisa uno ya puesto; solo si el
-- email resuelve a UN usuario y ese usuario no está ya enlazado a otra fila).
do $$ begin
  if to_regclass('auth.users') is not null then
    execute $q$
      update public.authorized_users au
         set user_id = u.id
        from (select lower(email) as em, min(id::text)::uuid as id, count(*) as n
                from auth.users where email is not null group by lower(email)) u
       where au.user_id is null and lower(au.email) = u.em and u.n = 1
         and not exists (select 1 from public.authorized_users o where o.user_id = u.id)
    $q$;
  end if;
end $$;

-- RLS de authorized_users: SOLO «SELECT de la propia fila» (H2, confirmada en staging 2026-10-26: había políticas que
-- dejaban a `authenticated` insertar/actualizar/borrar). Se eliminan TODAS las políticas de la tabla (también una
-- «users check own authorization» cuya condición haya sido modificada en vivo) y se (re)crea la única permitida con la
-- condición EXACTA: la fila propia por user_id (auth.uid()) o por email del JWT (auth.email(), sin distinguir mayúsculas).
-- Idempotente: cada corrida deja exactamente esta política.
alter table public.authorized_users enable row level security;
do $$
declare
  p record;
  has_auth_fns boolean;
begin
  for p in
    select policyname, cmd from pg_policies
     where schemaname = 'public' and tablename = 'authorized_users'
  loop
    execute format('drop policy %I on public.authorized_users', p.policyname);
    if p.policyname <> 'users check own authorization' then
      raise notice 'r75: política % (%) eliminada de authorized_users', p.policyname, p.cmd;
    end if;
  end loop;
  select (select count(distinct pr.proname) from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
           where n.nspname = 'auth' and pr.proname in ('uid', 'email')) = 2
    into has_auth_fns;
  if has_auth_fns then
    execute 'create policy "users check own authorization" on public.authorized_users for select to authenticated '
         || 'using ((user_id is not null and user_id = auth.uid()) or lower(email) = lower(auth.email()))';
  else
    raise notice 'r75: sin auth.uid()/auth.email() (base no Supabase): authorized_users queda sin políticas (nadie lee por cliente)';
  end if;
end $$;

-- ── RLS + REVOKE de las tablas nuevas (y escrituras de cliente sobre authorized_users) ──
do $$
declare
  t text;
  r text;
begin
  foreach t in array array['institution_memberships','institution_permission_overrides','user_suspensions',
                           'platform_controls','admin_audit_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    foreach r in array array['anon','authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table public.%I from %I', t, r);
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.authorized_users from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete, truncate, references, trigger on table public.authorized_users from authenticated';
  end if;
  foreach r in array array['anon','authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on sequence public.admin_audit_log_id_seq from %I', r);
    end if;
  end loop;
end $$;
