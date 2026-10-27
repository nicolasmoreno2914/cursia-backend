import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions';

/**
 * r75 · `@RequirePermission(perm, scope)` (01 §3.3). Lo evalúa PermissionGuard según `CURSIA_RBAC_MODE`.
 *
 * `scope` dice de dónde sale la institución:
 *  - `{ course: 'param:courseId' }` (o `param:id`, `body:courseId`, `query:course_id`): la del curso (D-13).
 *  - `{ run: 'param:runId' }`: run → `production_jobs.course_id::text` → curso.
 *  - `{ artifact: 'param:id' }`: artifact → `artifacts.course_id` (id numérico o `frontend_course_id`).
 *  - `{ institution: 'param:institutionId' | 'header' }`.
 *  - `{ collection: true }`: rutas de colección / creación → institución activa (header o membresía única).
 *  - `{ global: true }`: permisos globales (D-7: en v1 solo SuperAdmin).
 */
export type ResourceRef = `param:${string}` | `body:${string}` | `query:${string}`;
export type PermissionScope =
  | { course: ResourceRef }
  | { run: ResourceRef }
  | { artifact: ResourceRef }
  | { institution: ResourceRef | 'header' }
  /** brand profile → su institución (brand_profiles.institution_id). */
  | { brandProfile: ResourceRef }
  | { collection: true }
  | { global: true };

export interface PermissionRequirement {
  permission: Permission;
  scope: PermissionScope;
}

export const AUTHZ_REQUIRE_PERMISSION_KEY = 'cursia:authz:require-permission';
export const AUTHZ_AUTHENTICATED_ONLY_KEY = 'cursia:authz:authenticated-only';
export const AUTHZ_SUPERADMIN_ONLY_KEY = 'cursia:authz:superadmin-only';

export const RequirePermission = (permission: Permission, scope: PermissionScope) =>
  SetMetadata(AUTHZ_REQUIRE_PERMISSION_KEY, { permission, scope } as PermissionRequirement);

/**
 * Ruta con JWT + cuenta autorizada que actúa SOLO sobre recursos del propio usuario (sin institución): p. ej. `POST
 * /events`, `POST /tts/speech`, `GET /features`, la lista propia de jobs legacy. El motivo queda en la metadata para
 * el chequeo de cobertura.
 */
export const AuthenticatedOnly = (reason: string) => SetMetadata(AUTHZ_AUTHENTICATED_ONLY_KEY, reason);

/** Ruta protegida por SuperAdminGuard (marca para el chequeo de cobertura; no reemplaza al guard). */
export const SuperAdminOnly = () => SetMetadata(AUTHZ_SUPERADMIN_ONLY_KEY, true);
