/**
 * r75 · A — tokens de inyección OPCIONALES que A consume sin importar los módulos de B y C (evita ciclos:
 * B y C importan AccessModule por AuditLogService). A los resuelve en tiempo de request con
 * `ModuleRef.get(token, { strict: false })`; si el proveedor no está registrado, esa parte devuelve null.
 *
 * Registro esperado (en el módulo de cada dueño):
 *   B (AuthzModule):   { provide: R75_PERMISSION_SERVICE, useExisting: PermissionService }
 *   C (BudgetsModule): { provide: R75_BUDGET_READ_SERVICE, useExisting: BudgetReadService }
 */
export const R75_PERMISSION_SERVICE = 'R75_PERMISSION_SERVICE';
export const R75_BUDGET_READ_SERVICE = 'R75_BUDGET_READ_SERVICE';

/** Forma mínima que A usa de PermissionService (B). Todos los métodos son opcionales: A comprueba antes de llamar. */
export interface R75PermissionServiceLike {
  /** Invalida la caché (30 s, D-11) de un usuario tras escribir membresías, overrides o suspensiones. */
  invalidateUser?: (userId: string) => void | Promise<void>;
  /** Permisos efectivos de un usuario en una institución (si B los resuelve distinto que la matriz de A). */
  effectivePermissions?: (userId: string, institutionId: string) => Promise<string[]>;
}

/** Forma mínima que A usa de BudgetReadService (C). `month` = 'YYYY-MM' (UTC). */
export interface UserBudgetSummary {
  month: string;
  limitUsd: string;
  spentUsd: string;
  heldUsd: string;
  availableUsd: string;
  pendingRequests: number;
}
export interface R75BudgetReadServiceLike {
  getSummary?: (userId: string, month?: string) => Promise<UserBudgetSummary>;
  getSummaries?: (userIds: string[], month?: string) => Promise<Record<string, UserBudgetSummary>>;
}
