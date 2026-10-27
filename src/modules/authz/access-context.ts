import { InternalServerErrorException } from '@nestjs/common';
import type { AuthzMode } from './authz-flags';
import type { Permission } from './permissions';
import { AUTHZ_ERRORS } from './permissions';

/**
 * r75 · Contexto de acceso de un request (01 §3.2, patrón «owner efectivo»).
 *
 *  - `actorId` / `actorEmail`: quién hace la acción (JWT). Se usa para registrar autoría (`created_by`, `updated_by`,
 *    `approved_by`, `generated_by`, eventos, `budget_reservations.user_id`).
 *  - `effectiveOwnerId`: el `owner_id` con el que los servicios existentes filtran (dueño técnico del curso). En
 *    `CURSIA_RBAC_MODE=off|shadow` es SIEMPRE el actor (comportamiento actual). En `enforce`, para rutas sobre un curso
 *    es `courses.owner_id` del curso, una vez autorizado el permiso.
 *  - Regla dura: `effectiveOwnerId` nunca es vacío → 500 `access_context_missing` (cierra la trampa
 *    `CoursesService.findOne(id, undefined)` que no filtra nada).
 */
export interface AccessContext {
  actorId: string;
  actorEmail: string;
  superAdmin: boolean;
  /** Modo RBAC con el que se armó este contexto. */
  mode: AuthzMode;
  /** true = contexto legacy (dueño único: effectiveOwnerId = actorId). */
  legacy: boolean;
  institutionId: string | null;
  courseId: number | null;
  runId: string | null;
  effectiveOwnerId: string;
  /** Permisos efectivos en `institutionId` (vacío en legacy: el servicio aplica el filtro de dueño de siempre). */
  permissions: ReadonlySet<Permission>;
}

export function accessContextMissing(detail: string): InternalServerErrorException {
  return new InternalServerErrorException({ code: AUTHZ_ERRORS.ACCESS_CONTEXT_MISSING, message: `${AUTHZ_ERRORS.ACCESS_CONTEXT_MISSING}: ${detail}` });
}

/** Contexto legacy a partir del usuario del JWT (modo off / rutas sin @RequirePermission). */
export function legacyAccessContext(user: { id?: string | null; email?: string | null } | null | undefined, superAdmin: boolean, mode: AuthzMode = 'off'): AccessContext {
  const id = typeof user?.id === 'string' ? user.id.trim() : '';
  if (!id) throw accessContextMissing('sin usuario autenticado');
  return {
    actorId: id,
    actorEmail: String(user?.email ?? ''),
    superAdmin,
    mode,
    legacy: true,
    institutionId: null,
    courseId: null,
    runId: null,
    effectiveOwnerId: id,
    permissions: new Set<Permission>(),
  };
}

/** Assert de la regla dura: devuelve el contexto si `effectiveOwnerId` y `actorId` son strings no vacíos. */
export function assertAccessContext(ctx: AccessContext | null | undefined): AccessContext {
  if (!ctx) throw accessContextMissing('el request no tiene contexto de acceso');
  if (typeof ctx.actorId !== 'string' || !ctx.actorId.trim()) throw accessContextMissing('actorId vacío');
  if (typeof ctx.effectiveOwnerId !== 'string' || !ctx.effectiveOwnerId.trim()) throw accessContextMissing('effectiveOwnerId vacío');
  return ctx;
}
