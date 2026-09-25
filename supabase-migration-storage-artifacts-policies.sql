-- Políticas RLS mínimas de Storage para el bucket `cursia-artifacts` (STAGING).
--
-- Motivo: el preflight de Fase 5A encontró 0 políticas en storage.objects y
-- una prueba real desde una sesión autenticada de staging devolvió
-- 403 "new row violates row-level security policy" en el INSERT (upload). El
-- ejecutor de Fase 5A (y el artifactUpload legacy) suben desde el navegador
-- con el JWT del usuario, así que sin estas políticas ningún item de
-- content/scorm/exam puede guardar su artifact.
--
-- Alcance mínimo:
--   - solo rol `authenticated` (nunca anon/public);
--   - solo bucket `cursia-artifacts`;
--   - solo objetos bajo la carpeta del propio usuario: primer segmento del
--     path = auth.uid() (rutas del flujo dynamic: <userId>/dynamic/...;
--     rutas legacy: <userId>/<courseId>/...);
--   - INSERT (subir), SELECT (leer / firmar URL de descarga), DELETE (borrar
--     lo propio), UPDATE (sobrescribir lo propio — ver abajo).
-- El worker del backend usa service_role (ignora RLS) y no depende de esto.
--
-- UPDATE (agregado después, additive): el flujo dynamic sube con
-- upsert:false, pero dos rutas legacy del frontend (artifactUpload() en
-- 24-backend-client.js, usada por 39-brandkit.js y 41-course-setup.js) suben
-- con upsert:true y un nombre de archivo estable (el nombre literal del PDF),
-- así que una re-subida al mismo path necesita permiso UPDATE bajo RLS, no
-- solo INSERT — sin esto, Supabase Storage devuelve 403 en el overwrite. Ver
-- docs/autonomous-audits/audit-track0.md item 2.
--
-- Idempotente: cada política se crea solo si no existe una con ese nombre;
-- re-ejecutar no toma locks sobre storage.objects.

set local lock_timeout = '5s';

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'cursia_artifacts_insert_own_folder'
  ) then
    create policy cursia_artifacts_insert_own_folder
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'cursia-artifacts'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'cursia_artifacts_select_own_folder'
  ) then
    create policy cursia_artifacts_select_own_folder
      on storage.objects for select to authenticated
      using (
        bucket_id = 'cursia-artifacts'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'cursia_artifacts_delete_own_folder'
  ) then
    create policy cursia_artifacts_delete_own_folder
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'cursia-artifacts'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'cursia_artifacts_update_own_folder'
  ) then
    create policy cursia_artifacts_update_own_folder
      on storage.objects for update to authenticated
      using (
        bucket_id = 'cursia-artifacts'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      )
      with check (
        bucket_id = 'cursia-artifacts'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;
end
$$;
