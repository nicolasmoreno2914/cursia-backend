/**
 * r75 · Catálogo de permisos y matriz por defecto (rol × permiso). Fuente: validation/r75-roles/01 §2.1–2.2.
 *
 * Claves estables en inglés (código / API); etiquetas en español (UI). Puro: sin Nest, sin base.
 * SUPERADMIN NO es un rol de membresía (D-3): se decide solo por env (src/auth/super-admin.ts).
 */

export const ROLES = ['ADMIN_INSTITUCIONAL', 'CREADOR', 'APROBADOR_ACADEMICO', 'CONSULTA'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'courses.view',
  'courses.create',
  'courses.edit',
  'courses.delete',
  'proposals.review',
  'proposals.approve',
  'generations.start',
  'generations.retry',
  'exports.download',
  'spend.view',
  'roles.manage',
  'budgets.manage',
  'users.suspend',
  'generations.suspend',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface PermissionInfo {
  key: Permission;
  label: string;
  sensitive: boolean;
  /** false = no se puede otorgar desde una institución (D-7: solo SA en v1). */
  grantable: boolean;
}

export const PERMISSION_CATALOG: readonly PermissionInfo[] = Object.freeze([
  { key: 'courses.view', label: 'Ver cursos', sensitive: false, grantable: true },
  { key: 'courses.create', label: 'Crear cursos', sensitive: false, grantable: true },
  { key: 'courses.edit', label: 'Editar cursos', sensitive: false, grantable: true },
  { key: 'courses.delete', label: 'Eliminar cursos', sensitive: true, grantable: true },
  { key: 'proposals.review', label: 'Revisar propuestas (preparar, pedir ajustes, retirar)', sensitive: false, grantable: true },
  { key: 'proposals.approve', label: 'Aprobar propuestas', sensitive: true, grantable: true },
  { key: 'generations.start', label: 'Iniciar generaciones (gasta presupuesto)', sensitive: true, grantable: true },
  { key: 'generations.retry', label: 'Reintentar / reanudar generaciones', sensitive: true, grantable: true },
  { key: 'exports.download', label: 'Descargar / exportar (.mbz, PDF, artifacts)', sensitive: true, grantable: true },
  { key: 'spend.view', label: 'Consultar gastos de la institución', sensitive: true, grantable: true },
  { key: 'roles.manage', label: 'Administrar roles y miembros de la institución', sensitive: true, grantable: true },
  { key: 'budgets.manage', label: 'Administrar presupuestos', sensitive: true, grantable: false },
  { key: 'users.suspend', label: 'Suspender usuarios', sensitive: true, grantable: false },
  { key: 'generations.suspend', label: 'Suspender generaciones', sensitive: true, grantable: false },
] as PermissionInfo[]);

/** D-7: permisos sobre objetos globales; en v1 solo los ejerce el SuperAdmin. Un override `grant` no tiene efecto. */
export const GLOBAL_ONLY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(['budgets.manage', 'users.suspend', 'generations.suspend']);

/** Matriz por defecto (01 §2.2). D-8: ADMIN_INSTITUCIONAL sin approve/start. D-9: CONSULTA sin exports.download. */
export const ROLE_MATRIX: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  ADMIN_INSTITUCIONAL: [
    'courses.view', 'courses.create', 'courses.edit', 'courses.delete', 'proposals.review',
    'generations.retry', 'exports.download', 'spend.view', 'roles.manage',
  ],
  CREADOR: ['courses.view', 'courses.create', 'courses.edit', 'proposals.review', 'generations.start', 'generations.retry', 'exports.download'],
  APROBADOR_ACADEMICO: ['courses.view', 'proposals.review', 'proposals.approve', 'exports.download'],
  CONSULTA: ['courses.view'],
});

export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x);
}

export function isPermission(x: unknown): x is Permission {
  return typeof x === 'string' && (PERMISSIONS as readonly string[]).includes(x);
}

export function isGrantablePermission(p: unknown): boolean {
  return isPermission(p) && !GLOBAL_ONLY_PERMISSIONS.has(p);
}

export function roleHasPermission(role: Role, perm: Permission): boolean {
  return (ROLE_MATRIX[role] ?? []).includes(perm);
}

/** Respuesta de `GET /permissions/catalog` (02 §A). */
export function permissionCatalogView(): {
  roles: Role[];
  permissions: PermissionInfo[];
  matrix: Record<Role, Permission[]>;
} {
  return {
    roles: [...ROLES],
    permissions: PERMISSION_CATALOG.map((p) => ({ ...p })),
    matrix: Object.fromEntries(ROLES.map((r) => [r, [...ROLE_MATRIX[r]]])) as Record<Role, Permission[]>,
  };
}

// ── Códigos de error estables (02 §F) ────────────────────────────────────────
export const AUTHZ_ERRORS = {
  ACCOUNT_NOT_AUTHORIZED: 'account_not_authorized',
  ACCOUNT_SUSPENDED: 'account_suspended',
  ACCOUNT_CHECK_UNAVAILABLE: 'account_check_unavailable',
  ACCESS_CONTEXT_MISSING: 'access_context_missing',
  NOT_A_MEMBER: 'not_a_member',
  INSTITUTION_REQUIRED: 'institution_required',
  INSTITUTION_MISMATCH: 'institution_mismatch',
  INSTITUTION_INACTIVE: 'institution_inactive',
  PERMISSION_DENIED: 'permission_denied',
  PERMISSION_NOT_GRANTABLE: 'permission_not_grantable',
  SELF_MODIFICATION_FORBIDDEN: 'self_modification_forbidden',
  ROLE_ESCALATION_FORBIDDEN: 'role_escalation_forbidden',
  VIDEO_ENGINE_NOT_FOUND: 'video_engine_not_found',
  COURSE_NOT_FOUND: 'course_not_found',
  JOB_NOT_FOUND: 'job_not_found',
} as const;
