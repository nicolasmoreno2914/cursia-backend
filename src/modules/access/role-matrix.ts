/**
 * r75 · A — catálogo y matriz rol × permiso (01 §2.1–2.2), lo que A necesita para la API de membresías
 * (effectivePermissions de `Member`, anti-escalada de overrides, último admin) y para `GET /me/context`.
 *
 * Fuente canónica para B: `src/modules/authz/permissions.ts` (B) DEBE reexportar o coincidir con esto; el lead
 * unifica en la integración (un solo import). Puro, sin dependencias.
 */
export const ROLES = ['ADMIN_INSTITUCIONAL', 'CREADOR', 'APROBADOR_ACADEMICO', 'CONSULTA'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'courses.view', 'courses.create', 'courses.edit', 'courses.delete', 'proposals.review', 'proposals.approve',
  'generations.start', 'generations.retry', 'exports.download', 'spend.view', 'roles.manage', 'budgets.manage',
  'users.suspend', 'generations.suspend',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** D-7: actúan sobre objetos globales; en v1 solo el SuperAdmin. Un `grant` institucional se rechaza. */
export const GLOBAL_ONLY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(['budgets.manage', 'users.suspend', 'generations.suspend']);

export const ROLE_MATRIX: Readonly<Record<Role, readonly Permission[]>> = {
  ADMIN_INSTITUCIONAL: ['courses.view', 'courses.create', 'courses.edit', 'courses.delete', 'proposals.review',
    'generations.retry', 'exports.download', 'spend.view', 'roles.manage'], // D-8: sin proposals.approve ni generations.start
  CREADOR: ['courses.view', 'courses.create', 'courses.edit', 'proposals.review', 'generations.start', 'generations.retry',
    'exports.download'],
  APROBADOR_ACADEMICO: ['courses.view', 'proposals.review', 'proposals.approve', 'exports.download'],
  CONSULTA: ['courses.view'], // D-9: sin exports.download
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export function isPermission(v: unknown): v is Permission {
  return typeof v === 'string' && (PERMISSIONS as readonly string[]).includes(v);
}

/**
 * Permisos efectivos de una membresía (01 §2.3 pasos 5–7): rol + grants − denies (deny gana siempre).
 * Los permisos globales (D-7) nunca salen de una membresía aunque haya un grant histórico.
 * Membresía no activa o institución no activa → [].
 */
export function effectivePermissions(input: {
  role: Role | string;
  membershipStatus?: string | null;
  institutionStatus?: string | null;
  grants?: Iterable<string>;
  denies?: Iterable<string>;
}): Permission[] {
  if ((input.membershipStatus ?? 'active') !== 'active') return [];
  if ((input.institutionStatus ?? 'active') !== 'active') return [];
  const base = isRole(input.role) ? ROLE_MATRIX[input.role] : [];
  const set = new Set<Permission>(base);
  for (const g of input.grants ?? []) if (isPermission(g) && !GLOBAL_ONLY_PERMISSIONS.has(g)) set.add(g);
  for (const d of input.denies ?? []) if (isPermission(d)) set.delete(d);
  return PERMISSIONS.filter((p) => set.has(p));
}
