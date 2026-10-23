-- ══════════════════════════════════════════════════════════════════════════
-- Cursia EV6 — H5P pack v2 (H2): ajuste de Blueprint «Repaso» (Dialog Cards).
--
--   courses.review_cards_enabled  boolean NULL, default false
--
-- 100% aditivo e idempotente. Las filas existentes quedan NULL (= apagado) y
-- sus Blueprints/huellas no cambian: el snapshot v2 solo incluye
-- `reviewCards` cuando es true. Default FALSE (ruling H2 fix round 1, I-1):
-- la migración nunca enciende «Repaso» por sí sola. Lo enciende el código, y
-- SOLO para cursos NUEVOS creados con DYNAMIC_ACTIVITY_TYPE_RULES=2 (H5P v2;
-- CoursesService), y el empaque además exige el marcador activityTypeRules=2
-- del Manifest y motor h5p. Con el flag sin definir ningún curso lleva «Repaso».
--
-- Rollback (solo si ningún código EV6 la lee; el código tolera su ausencia):
--   alter table public.courses drop column if exists review_cards_enabled;
-- ══════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'courses'
       and column_name = 'review_cards_enabled'
  ) then
    alter table public.courses add column review_cards_enabled boolean;
  end if;
end $$;

-- Fix round 1 (M-3): el default es su propia sentencia idempotente (también corrige una
-- columna agregada a mano sin default).
alter table public.courses alter column review_cards_enabled set default false;
