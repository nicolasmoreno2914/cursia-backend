-- SUPERSEDED / NO EJECUTAR: este archivo nunca fue referenciado por ningún
-- script ni workflow (ver docs/autonomous-audits/audit-track0.md, item 1).
-- El fix real vive en scripts/migrate-production-jobs-constraints.js, que es
-- el script que deploy.yml/deploy-staging.yml realmente ejecutan — 'brand_extraction'
-- ya fue agregado ahí. Se conserva este archivo solo como documentación
-- histórica de la intención original; no aplicar contra la base de datos.
--
-- Agrega 'brand_extraction' a los valores permitidos de production_jobs.execution_mode.
-- Migración puramente aditiva: no toca datos existentes ni otras tablas.
-- Necesaria porque src/modules/brand-profiles/brand-profiles.service.ts inserta
-- executionMode: 'brand_extraction' al crear el ProductionJob del flujo de subida
-- de Brand Kit (POST /institutions/:id/brand-profiles/upload), y ese valor no
-- estaba contemplado en el constraint original.

ALTER TABLE production_jobs
  DROP CONSTRAINT production_jobs_execution_mode_check;

ALTER TABLE production_jobs
  ADD CONSTRAINT production_jobs_execution_mode_check
  CHECK (execution_mode = ANY (ARRAY[
    'frontend'::text,
    'backend_content'::text,
    'backend_audio'::text,
    'backend_videos'::text,
    'backend_h5p'::text,
    'backend_package'::text,
    'backend_package_base'::text,
    'course_full_generation'::text,
    'backend_full_future'::text,
    'brand_extraction'::text
  ]));
