-- ══════════════════════════════════════════════════════════════════════════
-- Cursia V2.1 RF-b (fix C2) — RLS + REVOKE de los roles cliente de Supabase
-- sobre las tablas FinOps y course_profiles (R3).
--
-- Problema: Supabase otorga ALL sobre tablas nuevas de `public` a `anon` y
-- `authenticated`, y PostgREST las expone con la anon key pública. Sin esto,
-- cualquier usuario podía insertar aprobaciones ADMIN_APPROVED, precios o
-- políticas, y leer el costo de todos los cursos.
--
-- Qué hace (100% aditivo, idempotente):
--   - ENABLE ROW LEVEL SECURITY en las 6 tablas FinOps y en course_profiles
--     (esta última solo si existe), SIN policies ⇒ ningún rol sujeto a RLS
--     ve ni escribe filas.
--   - REVOKE ALL de anon y authenticated (solo si esos roles existen).
-- El backend usa su conexión privilegiada (DB_USER: el rol dueño de las
-- tablas, `postgres` vía el pooler `postgres.<ref>`); el dueño de una tabla no
-- está sujeto a RLS salvo FORCE ROW LEVEL SECURITY, que NO se usa acá.
--
-- Corre solo contra STAGING — ver scripts/migrate-v21-finops-rls.js.
-- Rollback: alter table … disable row level security (y re-grant si hiciera falta).
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

do $$
declare
  t text;
  r text;
begin
  foreach t in array array['pricing_catalog','generation_cost_events','cost_estimates',
                           'cost_budget_policies','cost_budget_authorizations','cost_avoidance_events',
                           'course_profiles']
  loop
    if to_regclass('public.' || t) is null then
      raise notice 'tabla public.% no existe: se omite', t;
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    foreach r in array array['anon','authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table public.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;
