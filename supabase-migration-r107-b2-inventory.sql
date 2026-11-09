-- ════════════════════════════════════════════════════════════════════════
-- Cursia — r107 B2 «Taller de cursos»: inventario del paquete en la sesión.
--
--   workshop_sessions.inventory   jsonb nullable: el inventario (modelo único WorkshopCourse, forma persistida sin el
--                                 texto HTML — ver src/modules/course-workshop/inventory.ts) que se arma al pasar la
--                                 sesión a `identified`. null = todavía no se armó (sesiones de B1, o falló: el motivo
--                                 queda en identification->'inventory'->'error').
--
-- Solo agrega una columna nullable a la tabla NUEVA de r107 (workshop_sessions, B1); ninguna tabla existente cambia.
-- Aditiva e idempotente. El índice de la huella sobre artifacts (N3) va aparte en
-- supabase-migration-r107-artifacts-checksum-index.sql (CREATE INDEX CONCURRENTLY no corre dentro de una transacción).
-- SOLO staging (deploy-staging.yml → scripts/migrate-r107-b2-inventory.js) hasta aprobación del owner (EXCLUDED en
-- scripts/prod/migrate-v2-production.js). Sin la columna, la API del Taller responde 503 COURSE_WORKSHOP_NOT_MIGRATED.
--
-- Rollback (aditiva; con el flag apagado nada la usa):
--   alter table public.workshop_sessions drop column if exists inventory;
-- ════════════════════════════════════════════════════════════════════════

set lock_timeout = '5s';

alter table public.workshop_sessions add column if not exists inventory jsonb null;
