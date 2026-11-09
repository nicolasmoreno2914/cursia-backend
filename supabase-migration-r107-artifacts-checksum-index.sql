-- ════════════════════════════════════════════════════════════════════════
-- Cursia — r107 B2 (pendiente N3 de B1): índices de la HUELLA de los paquetes en artifacts.
--
-- La identificación del Taller busca, por cada .mbz subido, los artifacts `mbz_final` / `dynamic_mbz` con el mismo
-- sha256 (`checksum_sha256` o `metadata->>'validatedSha256'`). Sin índice es un recorrido completo de artifacts por subida.
-- Dos índices PARCIALES (solo los tipos de paquete), uno por cada rama del OR: el planner los combina (BitmapOr).
--
-- CONCURRENTLY: no bloquea escrituras en artifacts mientras se arma (no puede ir en una transacción: el script corre cada
-- sentencia suelta). Un índice que quedó INVÁLIDO por un intento cortado se descarta y se vuelve a crear (lo hace el
-- script: `IF NOT EXISTS` lo daría por hecho). Solo agrega índices: la forma de la tabla no cambia.
-- SOLO staging (scripts/migrate-r107-b2-inventory.js) hasta aprobación del owner (EXCLUDED en el plan de producción).
--
-- Rollback:
--   drop index concurrently if exists public.artifacts_mbz_checksum_sha256_idx;
--   drop index concurrently if exists public.artifacts_mbz_validated_sha256_idx;
-- ════════════════════════════════════════════════════════════════════════

create index concurrently if not exists artifacts_mbz_checksum_sha256_idx
  on public.artifacts (checksum_sha256)
  where type in ('mbz_final', 'dynamic_mbz');

create index concurrently if not exists artifacts_mbz_validated_sha256_idx
  on public.artifacts ((metadata->>'validatedSha256'))
  where type in ('mbz_final', 'dynamic_mbz');
