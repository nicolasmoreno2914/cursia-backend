set lock_timeout = '5s';

create table if not exists public.course_blueprints (
  id                         serial primary key,
  course_id                  integer not null references public.courses(id) on delete cascade,
  blueprint_number           integer not null check (blueprint_number >= 1),
  schema_version             integer not null default 1,
  snapshot_json              jsonb   not null,
  snapshot_sha256            char(64) not null,
  structure_counter_at_lock  integer not null,
  module_count               integer not null check (module_count >= 1),
  chapter_count              integer not null check (chapter_count >= 1),
  locked_at                  timestamptz not null default now(),
  locked_by                  varchar(36),
  constraint course_blueprints_course_number_key unique (course_id, blueprint_number),
  constraint course_blueprints_id_course_key unique (id, course_id)
);
create index if not exists idx_course_blueprints_course on public.course_blueprints(course_id);

alter table if exists public.courses add column if not exists current_blueprint_id integer;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'courses_current_blueprint_fk') then
    alter table public.courses add constraint courses_current_blueprint_fk
      foreign key (current_blueprint_id, id) references public.course_blueprints (id, course_id);
  end if;
end $$;

create or replace function public.course_blueprints_forbid_update() returns trigger
language plpgsql as $$
begin
  raise exception 'course_blueprints es inmutable (id=%)', old.id using errcode = 'P0001';
end $$;

drop trigger if exists course_blueprints_immutable on public.course_blueprints;
create trigger course_blueprints_immutable before update on public.course_blueprints
  for each row execute function public.course_blueprints_forbid_update();

-- Reapuntar las 3 FKs de Fase 1 (vacías) de course_versions a course_blueprints.
do $$
declare
  r record;
  c record;
  n bigint;
begin
  for r in select * from (values
      ('course_chapters', 'generated_with_version_id'),
      ('artifacts',       'generated_with_version_id'),
      ('production_jobs', 'blueprint_version_id')) as t(tbl, col)
  loop
    -- Solo reapuntar columnas vacías: si hay datos, abortar toda la migración.
    execute format('select count(*) from public.%I where %I is not null', r.tbl, r.col) into n;
    if n > 0 then
      raise exception '%.% tiene % filas no nulas — no se reapunta la FK', r.tbl, r.col, n;
    end if;

    -- Quitar toda FK de esa columna que apunte a course_versions (0 o 1).
    for c in
      select con.conname
        from pg_constraint con
        join pg_class t on t.oid = con.conrelid
        join pg_namespace ns on ns.oid = t.relnamespace and ns.nspname = 'public'
        join pg_attribute a on a.attrelid = t.oid and a.attnum = any (con.conkey)
       where t.relname = r.tbl and a.attname = r.col and con.contype = 'f'
         and con.confrelid = 'public.course_versions'::regclass
    loop
      execute format('alter table public.%I drop constraint %I', r.tbl, c.conname);
    end loop;

    -- Agregar la FK a course_blueprints si todavía no existe.
    if not exists (
      select 1 from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_attribute a on a.attrelid = t.oid and a.attnum = any (c.conkey)
       where t.relname = r.tbl and a.attname = r.col and c.contype = 'f'
         and c.confrelid = 'public.course_blueprints'::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references public.course_blueprints(id) on delete set null',
        r.tbl, r.tbl || '_' || r.col || '_blueprint_fk', r.col);
    end if;
  end loop;
end $$;
