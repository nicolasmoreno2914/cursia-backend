import { HttpException } from '@nestjs/common';

/**
 * r75 · A — errores con `code` estable (02 §F). El FE mapea por `code`.
 * AllExceptionsFilter reenvía `code` y `reason`; las claves extra (`userId`, `permission`) necesitan que el lead
 * las agregue a su lista blanca (ver reporte de A). Mientras tanto se duplican en `reason` cuando aportan.
 */
export function accessError(status: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpException {
  return new HttpException({ code, message, ...extra }, status);
}

export const E = {
  notAMember: () => accessError(403, 'not_a_member', 'No perteneces a esta institución.'),
  institutionNotFound: () => accessError(404, 'institution_not_found', 'Institución no encontrada.'),
  institutionInactive: () => accessError(403, 'institution_inactive', 'La institución está suspendida o archivada.'),
  institutionCreateForbidden: () => accessError(403, 'institution_create_forbidden', 'Solo el SuperAdmin crea instituciones.'),
  institutionSlugExists: () => accessError(409, 'institution_slug_exists', 'Ya existe una institución con ese identificador.'),
  institutionHasMembers: () => accessError(409, 'institution_has_members', 'La institución tiene miembros o cursos; archívala en vez de borrarla.'),
  permissionDenied: (permission: string) => accessError(403, 'permission_denied', `No tienes permiso para esta acción (${permission}).`, { permission, reason: permission }),
  permissionNotGrantable: (permission: string) => accessError(400, 'permission_not_grantable', `Ese permiso no se puede otorgar desde una institución (${permission}).`, { permission, reason: permission }),
  selfModification: () => accessError(403, 'self_modification_forbidden', 'No puedes cambiar tus propios permisos.'),
  roleEscalation: (permission: string) => accessError(403, 'role_escalation_forbidden', 'No puedes otorgar permisos que no tienes.', { permission, reason: permission }),
  lastAdmin: () => accessError(409, 'last_admin_protected', 'La institución debe conservar al menos un administrador.'),
  superadminReserved: () => accessError(400, 'superadmin_role_reserved', 'El rol SuperAdmin no se asigna desde aquí.'),
  invalidRole: () => accessError(400, 'invalid_role', 'Rol inválido.'),
  invalidStatus: () => accessError(400, 'invalid_status', 'Estado inválido.'),
  invalidInput: (message: string) => accessError(400, 'invalid_input', message),
  userNotFound: () => accessError(404, 'user_not_found', 'No existe un usuario con ese correo. Pídele al SuperAdmin que lo cree.'),
  membershipExists: () => accessError(409, 'membership_exists', 'Ya es miembro.'),
  userExists: () => accessError(409, 'user_exists', 'El usuario ya existe y tiene acceso.'),
  userExistsUnauthorized: (userId?: string | null) => accessError(409, 'user_exists_unauthorized', 'El usuario ya existe en Auth pero no tiene acceso; autorízalo.', userId ? { userId, reason: userId } : {}),
  userCreatePartial: (userId: string) => accessError(502, 'user_create_partial', 'El usuario se creó a medias; usa «Reparar».', { userId, reason: userId }),
  adminApiUnavailable: () => accessError(503, 'admin_api_unavailable', 'La administración de usuarios no está configurada en el servidor.'),
  adminApiError: () => accessError(502, 'admin_api_error', 'La administración de usuarios respondió con un error.'),
  invalidEmail: () => accessError(400, 'invalid_email', 'Correo inválido.'),
  suspensionActive: () => accessError(409, 'suspension_active', 'Ya hay una suspensión activa de ese tipo.'),
  suspensionNotFound: () => accessError(404, 'suspension_not_found', 'No hay una suspensión activa de ese tipo.'),
  accountSuspended: () => accessError(403, 'account_suspended', 'Tu cuenta está suspendida. Contacta al administrador.'),
  courseNotFound: () => accessError(404, 'course_not_found', 'Curso no encontrado.'),
  reasonRequired: () => accessError(400, 'reason_required', 'Indica el motivo.'),
  schemaMissing: () => accessError(503, 'r75_schema_missing', 'La migración r75 de accesos no está aplicada en este entorno.'),
};
