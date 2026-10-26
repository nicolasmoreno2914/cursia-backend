import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { AuditLogLike, R75_AUDIT_LOG, writeAudit } from './audit-sink';
import {
  AUTHZ_ERRORS,
  GLOBAL_ONLY_PERMISSIONS,
  isGrantablePermission,
  isPermission,
  isRole,
  Permission,
  PERMISSIONS,
  Role,
  ROLE_MATRIX,
} from './permissions';
import { columnExists, isUuid, QueryFn, tableExists } from './schema-probe';
import { AccountAccessService } from './account-access.service';

/**
 * r75 B2 · PermissionService (01 §2.3): resolución de permisos efectivos de un usuario en una institución.
 *
 *   1. (cuenta: AccountAccessGuard, antes)
 *   2. SuperAdmin (env) → permitido para cualquier permiso / institución. SOLO permisos: los controles financieros,
 *      la congelación y el presupuesto se aplican igual (D-18; los aplica C).
 *   3. Institución `active` (si no → 403 `institution_inactive`).
 *   4. Membresía `active` → si no: 404 en recursos concretos (no revela que existen), 403 `not_a_member` en rutas de
 *      institución / colección.
 *   5. Override `deny` vigente → denegado (deny gana SIEMPRE, también sobre el rol y sobre un grant).
 *   6. Override `grant` vigente → permitido (salvo los globales de D-7: un grant de budgets.manage / users.suspend /
 *      generations.suspend NO tiene efecto en v1).
 *   7. Rol por defecto (matriz 01 §2.2).
 *   8. Si no → 403 `permission_denied {permission}`.
 *
 * Datos: tablas de A (`institution_memberships`, `institution_permission_overrides`, `institutions.status/kind`). Sin
 * las tablas (A todavía no mergeado) → nadie es miembro de nada (solo el SA pasa): por eso `CURSIA_RBAC_MODE` arranca
 * en `off` y se prueba en `shadow` antes de `enforce`.
 * Caché por usuario 30 s (D-11) con `invalidate(userId)` (A lo llama al escribir membresías / overrides).
 */
export const PERMISSION_CACHE_TTL_MS = 30_000;

/** Token opcional para que `/me/context` (A) componga este servicio sin importar la clase. */
export const R75_PERMISSION_SERVICE = 'R75_PERMISSION_SERVICE';

export interface MembershipView {
  institutionId: string;
  name: string;
  kind: 'organization' | 'personal';
  institutionStatus: string;
  role: Role;
  status: string;
  grants: Permission[];
  denies: Permission[];
}

export interface EffectiveMembership extends MembershipView {
  /** rol + grants (otorgables) − denies. */
  permissions: Permission[];
}

export type PermissionDenyCode =
  | typeof AUTHZ_ERRORS.PERMISSION_DENIED
  | typeof AUTHZ_ERRORS.NOT_A_MEMBER
  | typeof AUTHZ_ERRORS.INSTITUTION_INACTIVE
  | typeof AUTHZ_ERRORS.INSTITUTION_REQUIRED
  | 'resource_not_found';

export type PermissionDecision =
  | { allowed: true; via: 'superadmin' | 'grant' | 'role'; permission: Permission; institutionId: string | null; role: Role | null }
  | { allowed: false; code: PermissionDenyCode; httpStatus: 400 | 403 | 404; permission: Permission; institutionId: string | null; reason: string };

export interface Actor {
  id: string;
  email?: string | null;
}

export function effectivePermissionsOf(m: Pick<MembershipView, 'role' | 'grants' | 'denies'>): Permission[] {
  const set = new Set<Permission>(ROLE_MATRIX[m.role] ?? []);
  for (const g of m.grants) if (isGrantablePermission(g)) set.add(g);
  for (const d of m.denies) set.delete(d);
  return PERMISSIONS.filter((p) => set.has(p));
}

/** Decisión pura (sin base): `membership` = la del actor en `institution`, o null. */
export function decidePermission(input: {
  superAdmin: boolean;
  permission: Permission;
  institution: { id: string; status: string } | null;
  membership: MembershipView | null;
  /** true = recurso concreto (curso / run / artifact): sin membresía → 404. */
  concreteResource: boolean;
}): PermissionDecision {
  const { permission } = input;
  const instId = input.institution?.id ?? null;
  if (input.superAdmin) return { allowed: true, via: 'superadmin', permission, institutionId: instId, role: input.membership?.role ?? null };
  if (GLOBAL_ONLY_PERMISSIONS.has(permission)) {
    return { allowed: false, code: AUTHZ_ERRORS.PERMISSION_DENIED, httpStatus: 403, permission, institutionId: instId, reason: 'permiso global: solo SuperAdmin (D-7)' };
  }
  if (!input.institution) {
    return input.concreteResource
      ? { allowed: false, code: 'resource_not_found', httpStatus: 404, permission, institutionId: null, reason: 'recurso sin institución (solo SuperAdmin)' }
      : { allowed: false, code: AUTHZ_ERRORS.INSTITUTION_REQUIRED, httpStatus: 400, permission, institutionId: null, reason: 'sin institución activa' };
  }
  const m = input.membership;
  if (!m || m.status !== 'active') {
    return input.concreteResource
      ? { allowed: false, code: 'resource_not_found', httpStatus: 404, permission, institutionId: instId, reason: 'sin membresía activa' }
      : { allowed: false, code: AUTHZ_ERRORS.NOT_A_MEMBER, httpStatus: 403, permission, institutionId: instId, reason: 'sin membresía activa' };
  }
  if (input.institution.status !== 'active') {
    return { allowed: false, code: AUTHZ_ERRORS.INSTITUTION_INACTIVE, httpStatus: 403, permission, institutionId: instId, reason: `institución ${input.institution.status}` };
  }
  if (m.denies.includes(permission)) {
    return { allowed: false, code: AUTHZ_ERRORS.PERMISSION_DENIED, httpStatus: 403, permission, institutionId: instId, reason: 'override deny' };
  }
  if (m.grants.includes(permission) && isGrantablePermission(permission)) {
    return { allowed: true, via: 'grant', permission, institutionId: instId, role: m.role };
  }
  if ((ROLE_MATRIX[m.role] ?? []).includes(permission)) return { allowed: true, via: 'role', permission, institutionId: instId, role: m.role };
  return { allowed: false, code: AUTHZ_ERRORS.PERMISSION_DENIED, httpStatus: 403, permission, institutionId: instId, reason: `rol ${m.role}` };
}

/** Anti-escalada (01 §2.5) para la API de membresías de A. null = permitido; si no, el código. Pura. */
export function escalationProblem(input: {
  actor: { id: string; superAdmin: boolean; permissions: readonly Permission[] };
  targetUserId: string;
  /** Rol nuevo (si cambia) y overrides grant nuevos. */
  role?: Role | null;
  grants?: readonly string[];
  denies?: readonly string[];
}): { code: string; httpStatus: 400 | 403; detail: string } | null {
  for (const p of [...(input.grants ?? []), ...(input.denies ?? [])]) {
    if (!isPermission(p)) return { code: AUTHZ_ERRORS.PERMISSION_NOT_GRANTABLE, httpStatus: 400, detail: `permiso desconocido ${String(p).slice(0, 40)}` };
  }
  for (const p of input.grants ?? []) {
    if (!isGrantablePermission(p)) return { code: AUTHZ_ERRORS.PERMISSION_NOT_GRANTABLE, httpStatus: 400, detail: `${p} no se otorga desde una institución (D-7)` };
  }
  if (input.role !== undefined && input.role !== null && !isRole(input.role)) {
    return { code: 'superadmin_role_reserved', httpStatus: 400, detail: `rol inválido ${String(input.role).slice(0, 40)}` };
  }
  if (input.actor.superAdmin) return null;
  if (String(input.actor.id).toLowerCase() === String(input.targetUserId).toLowerCase()) {
    return { code: AUTHZ_ERRORS.SELF_MODIFICATION_FORBIDDEN, httpStatus: 403, detail: 'nadie modifica sus propios permisos' };
  }
  if (!input.actor.permissions.includes('roles.manage')) {
    return { code: AUTHZ_ERRORS.PERMISSION_DENIED, httpStatus: 403, detail: 'roles.manage' };
  }
  // Decisión de A (D-8): asignar uno de los 4 roles institucionales solo exige roles.manage (un admin puede asignar
  // CREADOR aunque él no tenga generations.start). Los GRANTS sueltos sí exigen tener el permiso (anti-escalada).
  const have = new Set(input.actor.permissions);
  const wanted = new Set<string>(input.grants ?? []);
  for (const p of wanted) {
    if (!have.has(p as Permission)) return { code: AUTHZ_ERRORS.ROLE_ESCALATION_FORBIDDEN, httpStatus: 403, detail: `no tienes ${p}` };
  }
  return null;
}

@Injectable()
export class PermissionService {
  private readonly logger = new Logger('PermissionService');
  private readonly cache = new Map<string, { exp: number; memberships: MembershipView[] }>();

  constructor(
    @Optional() private readonly dataSource?: DataSource,
    @Optional() @Inject(R75_AUDIT_LOG) private readonly audit?: AuditLogLike,
    @Optional() private readonly accounts?: AccountAccessService,
  ) {}

  // ── Interfaz R75PermissionServiceLike que consume A (access/access.tokens.ts) ──────────────────────────────────
  /** A la llama tras escribir membresías, overrides o suspensiones: invalida permisos Y la decisión de cuenta. */
  invalidateUser(userId: string): void {
    this.invalidate(userId);
    this.accounts?.invalidate(userId);
  }

  /** Permisos efectivos por membresía (sin la expansión de SA: A no pasa el email). */
  async effectivePermissions(userId: string, institutionId: string): Promise<Permission[]> {
    const m = (await this.membershipsOf(userId)).find((x) => x.institutionId === String(institutionId).toLowerCase());
    if (!m || m.status !== 'active' || m.institutionStatus !== 'active') return [];
    return effectivePermissionsOf(m);
  }

  get query(): QueryFn | null {
    const ds = this.dataSource;
    return ds && typeof ds.query === 'function' ? (sql, params) => ds.query(sql, params as any[]) : null;
  }

  invalidate(userId?: string): void {
    if (userId) this.cache.delete(String(userId).toLowerCase());
    else this.cache.clear();
  }

  isSuperAdmin(actor: Actor | null | undefined): boolean {
    return isSuperAdminEmail(actor?.email ?? null);
  }

  /** Membresías (todas sus filas no `removed`) con overrides vigentes; caché 30 s. */
  async membershipsOf(userId: string): Promise<MembershipView[]> {
    const key = String(userId || '').toLowerCase();
    if (!key || !isUuid(key)) return [];
    const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.memberships;
    const memberships = await this.loadMemberships(key);
    this.cache.set(key, { exp: Date.now() + PERMISSION_CACHE_TTL_MS, memberships });
    return memberships;
  }

  private async loadMemberships(userId: string): Promise<MembershipView[]> {
    const q = this.query;
    if (!q || !(await tableExists(q, 'institution_memberships'))) return [];
    const hasStatus = await columnExists(q, 'institutions', 'status');
    const hasKind = await columnExists(q, 'institutions', 'kind');
    const rows = await q(
      `select m.institution_id::text as institution_id, m.role, m.status, i.name,
              ${hasStatus ? 'i.status' : `'active'`} as institution_status, ${hasKind ? 'i.kind' : `'organization'`} as kind
         from public.institution_memberships m
         join public.institutions i on i.id::text = m.institution_id::text
        where m.user_id::text = $1 and m.status <> 'removed'
        order by m.created_at asc`,
      [userId],
    );
    const overrides = (await tableExists(q, 'institution_permission_overrides'))
      ? await q(
          `select institution_id::text as institution_id, permission, effect from public.institution_permission_overrides
            where user_id::text = $1 and revoked_at is null`,
          [userId],
        )
      : [];
    return rows
      .filter((r: any) => isRole(r.role))
      .map((r: any) => {
        const mine = overrides.filter((o: any) => o.institution_id === r.institution_id && isPermission(o.permission));
        return {
          institutionId: r.institution_id,
          name: String(r.name ?? ''),
          kind: r.kind === 'personal' ? 'personal' : 'organization',
          institutionStatus: String(r.institution_status ?? 'active'),
          role: r.role as Role,
          status: String(r.status ?? 'active'),
          grants: mine.filter((o: any) => o.effect === 'grant').map((o: any) => o.permission as Permission),
          denies: mine.filter((o: any) => o.effect === 'deny').map((o: any) => o.permission as Permission),
        } as MembershipView;
      });
  }

  /** Vista para `/me/context` (A): membresías con permisos efectivos. */
  async describe(actor: Actor): Promise<EffectiveMembership[]> {
    const list = await this.membershipsOf(actor.id);
    return list.map((m) => ({ ...m, permissions: effectivePermissionsOf(m) }));
  }

  async membershipIn(actor: Actor, institutionId: string | null): Promise<MembershipView | null> {
    if (!institutionId) return null;
    return (await this.membershipsOf(actor.id)).find((m) => m.institutionId === String(institutionId).toLowerCase()) ?? null;
  }

  async institutionStatus(institutionId: string): Promise<{ id: string; status: string } | null> {
    const q = this.query;
    if (!q || !isUuid(institutionId)) return null;
    const hasStatus = await columnExists(q, 'institutions', 'status');
    const [row] = await q(`select id::text as id${hasStatus ? ', status' : ''} from public.institutions where id::text = $1`, [institutionId.toLowerCase()]);
    return row ? { id: row.id, status: hasStatus ? String(row.status ?? 'active') : 'active' } : null;
  }

  /** `can(user, perm, institutionId)` con la resolución completa (base + caché). */
  async can(actor: Actor, permission: Permission, institutionId: string | null, opts: { concreteResource?: boolean } = {}): Promise<PermissionDecision> {
    const superAdmin = this.isSuperAdmin(actor);
    const institution = institutionId ? await this.institutionStatus(institutionId) : null;
    const membership = institution ? await this.membershipIn(actor, institution.id) : null;
    return decidePermission({ superAdmin, permission, institution, membership, concreteResource: opts.concreteResource === true });
  }

  /** Permisos efectivos del actor en una institución (SA = todos). */
  async permissionsIn(actor: Actor, institutionId: string | null): Promise<Set<Permission>> {
    if (this.isSuperAdmin(actor)) return new Set(PERMISSIONS);
    const m = await this.membershipIn(actor, institutionId);
    if (!m || m.status !== 'active' || m.institutionStatus !== 'active') return new Set();
    return new Set(effectivePermissionsOf(m));
  }

  /**
   * Anti-escalada para la API de membresías (A): ¿`actor` puede asignar `role` / `grants` / `denies` a `targetUserId`
   * en `institutionId`? Devuelve el problema (código 02 §B) o null.
   */
  async escalationCheck(actor: Actor, institutionId: string, targetUserId: string, change: { role?: Role | null; grants?: string[]; denies?: string[] }) {
    const permissions = [...(await this.permissionsIn(actor, institutionId))];
    return escalationProblem({ actor: { id: actor.id, superAdmin: this.isSuperAdmin(actor), permissions }, targetUserId, ...change });
  }

  /**
   * Pendiente de A (5b), para C (`runs.controller` resume / retry): ¿la cuenta del INICIADOR del run
   * (`input_payload.startedBy`, o el dueño del run si es anterior a r75) tiene una suspensión de cuenta activa? Otro
   * miembro con generations.retry no puede reanudar ni reintentar ese run (01 §7: los runs del suspendido quedan
   * pausados por el sistema). Sin la tabla de A → false.
   */
  async runInitiatorSuspended(runId: string): Promise<boolean> {
    const q = this.query;
    if (!q || !isUuid(runId) || !(await tableExists(q, 'user_suspensions'))) return false;
    const [row] = await q(
      `select 1 as x from public.production_jobs pj
         join public.user_suspensions s on s.user_id::text = coalesce(pj.input_payload->>'startedBy', pj.owner_id::text)
        where pj.id::text = $1 and s.kind = 'account' and s.lifted_at is null limit 1`,
      [runId.toLowerCase()],
    );
    return !!row;
  }

  async recordShadowDeny(actor: Actor, detail: { route: string; permission: Permission; institutionId: string | null; legacyAllowed: boolean; rbac: PermissionDecision }): Promise<void> {
    this.logger.warn(`rbac.shadow_deny user=${actor.id} ${detail.route} perm=${detail.permission} legacy=${detail.legacyAllowed} rbac=${detail.rbac.allowed ? 'allow' : (detail.rbac as any).code}`);
    await writeAudit(this.audit, this.query, {
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      actorIsSuperadmin: this.isSuperAdmin(actor),
      action: 'rbac.shadow_deny',
      targetType: 'route',
      targetId: detail.route.slice(0, 200),
      institutionId: detail.institutionId && isUuid(detail.institutionId) ? detail.institutionId : null,
      after: {
        permission: detail.permission,
        legacyAllowed: detail.legacyAllowed,
        rbacAllowed: detail.rbac.allowed,
        rbacCode: detail.rbac.allowed ? null : (detail.rbac as any).code,
        reason: detail.rbac.allowed ? null : (detail.rbac as any).reason,
      },
    });
  }
}
