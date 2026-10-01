-- ══════════════════════════════════════════════════════════════════════════
-- Cursia EV6 — H5P pack v2 (H2): ajuste de Blueprint «Repaso» (Dialog Cards).
--
--   courses.review_cards_enabled  boolean NULL, default true SOLO para filas nuevas
--
-- 100% aditivo e idempotente. La columna se agrega SIN default (las filas
-- existentes quedan NULL = apagado, y sus Blueprints/huellas no cambian: el
-- snapshot v2 solo incluye `reviewCards` cuando es true); recién después se
-- fija el default true, que aplica únicamente a los cursos creados desde
-- ahora. Así el curso de validación (nuevo) lo trae encendido y ningún curso
-- anterior lo hereda.
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
    alter table public.courses alter column review_cards_enabled set default true;
  end if;
end $$;
