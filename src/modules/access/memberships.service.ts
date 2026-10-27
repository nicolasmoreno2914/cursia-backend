import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AccessActor, auditActor } from './access-actor';
import { E } from './access-errors';
import { authUsersReadable, iso, normEmail, r75AccessSchemaPresent, rowsOf, UUID_RE } from './access-schema';
import { R75_PERMISSION_SERVICE, R75PermissionServiceLike } from './access.tokens';
import { AuditLogService, Queryable } from './audit-log.service';
import {
  effectivePermissions, GLOBAL_ONLY_PERMISSIONS, isPermission, isRole, Permission, PERMISSIONS, Role,
} from './role-matrix';

export type MembershipStatus = 'active' | 'suspended' | 'removed';

export interface Member {
  userId: string;
  email: string;
  fullName: string | null;
  role: Role;
  status: MembershipStatus;
  overrides: { grants: Permission[]; denies: Permission[] };
  effectivePermissions: Permission[];
  accountStatus: 'active' | 'suspended';
  createdAt: string;
}

export interface UserMembership {
  institutionId: string;
  name: string;
  slug: string;
  kind: 'organization' | 'personal';
  institutionStatus: 'active' | 'suspended' | 'archived';
  role: Role;
  status: MembershipStatus;
  overrides: { grants: Permission[]; denies: Permission[] };
  permissions: Permission[];
  createdAt: string;
}

interface InstitutionRow { id: string; name: string; slug: string; kind: string; status: string }

const SUPERADMIN_ROLE_RE = /^super[_\s-]?admin$/i;

@Injectable()
export class MembershipsService {
  private readonly logger = new Logger('Memberships');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ── lecturas ──────────────────────────────────────────────────────────────

  async assertSchema(): Promise<void> {
    if (!(await r75AccessSchemaPresent(this.dataSource))) throw E.schemaMissing();
  }

  private async loadInstitution(q: Queryable, id: string, lock = false): Promise<InstitutionRow | null> {
    if (!UUID_RE.test(String(id || ''))) return null;
    const rows: any[] = await q.query(
      `select id, name, slug, kind, status from public.institutions where id = $1 ${lock ? 'for update' : ''}`, [id]);
    return rows[0] ?? null;
  }

  private async accountSuspended(q: Queryable, userId: string): Promise<boolean> {
    const rows: any[] = await q.query(
      `select 1 from public.user_suspensions where user_id = $1 and kind = 'account' and lifted_at is null limit 1`, [userId]);
    return rows.length > 0;
  }

  private async activeOverrides(q: Queryable, instId: string, userIds?: string[]): Promise<Map<string, { grants: Permission[]; denies: Permission[] }>> {
    const params: any[] = [instId];
    let extra = '';
    if (userIds) { params.push(userIds); extra = ' and user_id = any($2::uuid[])'; }
    const rows: any[] = await q.query(
      `select user_id, permission, effect from public.institution_permission_overrides
        where institution_id = $1 and revoked_at is null${extra} order by permission`, params);
    const out = new Map<string, { grants: Permission[]; denies: Permission[] }>();
    for (const r of rows) {
      const cur = out.get(r.user_id) ?? { grants: [], denies: [] };
      if (isPermission(r.permission)) (r.effect === 'deny' ? cur.denies : cur.grants).push(r.permission);
      out.set(r.user_id, cur);
    }
    return out;
  }

  /** Permisos efectivos del actor en la institución (SA → todos). Lanza los códigos de 02 §B. */
  private async assertCanManage(q: Queryable, actor: AccessActor, instId: string, lock: boolean): Promise<{ inst: InstitutionRow; actorPerms: Set<Permission> }> {
    const inst = await this.loadInstitution(q, instId, lock);
    if (actor.superAdmin) {
      if (!inst) throw E.institutionNotFound();
      return { inst, actorPerms: new Set(PERMISSIONS) };
    }
    if (await this.accountSuspended(q, actor.userId)) throw E.accountSuspended();
    if (!inst) throw E.notAMember(); // no revela si existe
    const rows: any[] = await q.query(
      `select role, status from public.institution_memberships where institution_id = $1 and user_id = $2`, [instId, actor.userId]);
    const mem = rows[0];
    if (!mem || mem.status === 'removed') throw E.notAMember();
    if (inst.status !== 'active') throw E.institutionInactive();
    if (mem.status !== 'active') throw E.notAMember();
    const ov = (await this.activeOverrides(q, instId, [actor.userId])).get(actor.userId) ?? { grants: [], denies: [] };
    const perms = new Set(effectivePermissions({ role: mem.role, membershipStatus: mem.status, institutionStatus: inst.status, ...ov }));
    if (!perms.has('roles.manage')) throw E.permissionDenied('roles.manage');
    return { inst, actorPerms: perms };
  }

  /** ADMIN_INSTITUCIONAL activos y sin deny de roles.manage (opcionalmente excluyendo a uno). */
  private async countEffectiveAdmins(q: Queryable, instId: string, excludeUserId: string | null): Promise<number> {
    const rows: any[] = await q.query(
      `select count(*)::int as n from public.institution_memberships m
        where m.institution_id = $1 and m.status = 'active' and m.role = 'ADMIN_INSTITUCIONAL'
          and ($2::uuid is null or m.user_id <> $2::uuid)
          and not exists (select 1 from public.institution_permission_overrides o
                           where o.institution_id = m.institution_id and o.user_id = m.user_id
                             and o.permission = 'roles.manage' and o.effect = 'deny' and o.revoked_at is null)`,
      [instId, excludeUserId]);
    return Number(rows[0]?.n ?? 0);
  }

  private isEffectiveAdmin(role: string, status: string, denies: Iterable<string>): boolean {
    return role === 'ADMIN_INSTITUCIONAL' && status === 'active' && ![...denies].includes('roles.manage');
  }

  /** 01 §2.5: una `organization` no puede quedar sin ADMIN_INSTITUCIONAL efectivo (el SA sí puede). */
  private async assertNotLastAdmin(q: Queryable, actor: AccessActor, inst: InstitutionRow, targetUserId: string, before: boolean, after: boolean): Promise<void> {
    if (actor.superAdmin || inst.kind !== 'organization' || !before || after) return;
    if ((await this.countEffectiveAdmins(q, inst.id, targetUserId)) === 0) throw E.lastAdmin();
  }

  private async fullNames(userIds: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!userIds.length || !(await authUsersReadable(this.dataSource))) return out;
    try {
      const rows: any[] = await this.dataSource.query(
        `select id::text as id, nullif(trim(coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', '')), '') as full_name
           from auth.users where id = any($1::uuid[])`, [userIds]);
      for (const r of rows) out.set(r.id, r.full_name ?? null);
    } catch { /* auth.users ilegible: sin nombres */ }
    return out;
  }

  async listMembers(actor: AccessActor, instId: string, status?: string): Promise<Member[]> {
    await this.assertSchema();
    if (status !== undefined && status !== '' && !['active', 'suspended', 'removed'].includes(status)) throw E.invalidStatus();
    const { inst } = await this.assertCanManage(this.dataSource, actor, instId, false);
    return this.membersOf(inst, status || null, null);
  }

  private async membersOf(inst: InstitutionRow, status: string | null, onlyUserId: string | null): Promise<Member[]> {
    const rows: any[] = await this.dataSource.query(
      `select m.user_id::text as user_id, m.role, m.status, m.created_at,
              (select au.email from public.authorized_users au where au.user_id = m.user_id order by au.created_at nulls last limit 1) as email,
              exists (select 1 from public.user_suspensions s where s.user_id = m.user_id and s.kind = 'account' and s.lifted_at is null) as suspended
         from public.institution_memberships m
        where m.institution_id = $1 and ($2::text is null or m.status = $2) and ($3::uuid is null or m.user_id = $3::uuid)
        order by m.created_at, m.user_id`,
      [inst.id, status, onlyUserId]);
    const ids = rows.map((r) => r.user_id);
    const ovs = await this.activeOverrides(this.dataSource, inst.id, ids);
    const names = await this.fullNames(ids);
    return rows.map((r) => {
      const ov = ovs.get(r.user_id) ?? { grants: [], denies: [] };
      return {
        userId: r.user_id,
        email: r.email ?? '',
        fullName: names.get(r.user_id) ?? null,
        role: r.role,
        status: r.status,
        overrides: ov,
        effectivePermissions: effectivePermissions({ role: r.role, membershipStatus: r.status, institutionStatus: inst.status, ...ov }),
        accountStatus: r.suspended ? 'suspended' : 'active',
        createdAt: iso(r.created_at) ?? '',
      };
    });
  }

  private async memberOrThrow(instId: string, userId: string): Promise<Member> {
    const inst = await this.loadInstitution(this.dataSource, instId);
    if (!inst) throw E.institutionNotFound();
    const [m] = await this.membersOf(inst, null, userId);
    if (!m) throw E.userNotFound();
    return m;
  }

  /** Membresías (no removidas) de un usuario, con permisos efectivos. Para /me/context y /admin/users. */
  async listForUser(userId: string, q: Queryable = this.dataSource): Promise<UserMembership[]> {
    if (!UUID_RE.test(userId) || !(await r75AccessSchemaPresent(this.dataSource))) return [];
    const rows: any[] = await q.query(
      `select m.institution_id::text as institution_id, i.name, i.slug, i.kind, i.status as institution_status,
              m.role, m.status, m.created_at
         from public.institution_memberships m join public.institutions i on i.id = m.institution_id
        where m.user_id = $1 and m.status <> 'removed'
        order by m.created_at, i.name`, [userId]);
    const ovRows: any[] = await q.query(
      `select institution_id::text as institution_id, permission, effect from public.institution_permission_overrides
        where user_id = $1 and revoked_at is null order by permission`, [userId]);
    return rows.map((r) => {
      const ov = { grants: [] as Permission[], denies: [] as Permission[] };
      for (const o of ovRows) if (o.institution_id === r.institution_id && isPermission(o.permission)) (o.effect === 'deny' ? ov.denies : ov.grants).push(o.permission);
      return {
        institutionId: r.institution_id, name: r.name, slug: r.slug, kind: r.kind, institutionStatus: r.institution_status,
        role: r.role, status: r.status, overrides: ov,
        permissions: effectivePermissions({ role: r.role, membershipStatus: r.status, institutionStatus: r.institution_status, ...ov }),
        createdAt: iso(r.created_at) ?? '',
      };
    });
  }

  // ── resolución de usuarios ───────────────────────────────────────────────

  /** Usuario de la allow-list por email exacto (D-12: el admin institucional NO crea usuarios). */
  async resolveAuthorizedUserByEmail(q: Queryable, email: string): Promise<{ userId: string; email: string } | null> {
    const rows: any[] = await q.query(
      `select id, email, user_id::text as user_id from public.authorized_users where lower(email) = $1 order by created_at nulls last limit 1`, [email]);
    const au = rows[0];
    if (!au) return null;
    if (au.user_id) return { userId: au.user_id, email: au.email };
    if (!(await authUsersReadable(this.dataSource))) return null;
    const us: any[] = await q.query(`select id::text as id from auth.users where lower(email) = $1`, [email]);
    if (us.length !== 1) return null;
    const taken: any[] = await q.query(`select 1 from public.authorized_users where user_id = $1`, [us[0].id]);
    if (taken.length) return null;
    await q.query(`update public.authorized_users set user_id = $1 where id = $2 and user_id is null`, [us[0].id, au.id]);
    return { userId: us[0].id, email: au.email };
  }

  // ── escrituras ───────────────────────────────────────────────────────────

  private parseRole(role: unknown): Role {
    if (typeof role === 'string' && SUPERADMIN_ROLE_RE.test(role.trim())) throw E.superadminReserved();
    if (!isRole(role)) throw E.invalidRole();
    return role;
  }

  /**
   * Inserta o reactiva una membresía DENTRO de una transacción ya abierta (lo usa también la creación de usuarios
   * del SA). No valida permisos del actor: el llamador ya lo hizo.
   */
  async upsertMembershipTx(m: Queryable, actor: AccessActor, instId: string, userId: string, role: Role, email: string | null): Promise<'created' | 'reactivated'> {
    const existing: any[] = await m.query(
      `select status, role from public.institution_memberships where institution_id = $1 and user_id = $2 for update`, [instId, userId]);
    let result: 'created' | 'reactivated';
    if (existing[0]) {
      if (existing[0].status !== 'removed') throw E.membershipExists();
      await m.query(
        `update public.institution_memberships set role = $3, status = 'active', updated_by = $4, updated_at = now()
          where institution_id = $1 and user_id = $2`, [instId, userId, role, actor.userId]);
      result = 'reactivated';
    } else {
      await m.query(
        `insert into public.institution_memberships (institution_id, user_id, role, status, created_by, updated_by)
         values ($1, $2, $3, 'active', $4, $4)`, [instId, userId, role, actor.userId]);
      result = 'created';
    }
    await this.audit.record({
      ...auditActor(actor), action: result === 'created' ? 'membership.add' : 'membership.reactivate',
      targetType: 'membership', targetId: userId, institutionId: instId,
      before: existing[0] ? { role: existing[0].role, status: existing[0].status } : null,
      after: { userId, email, role, status: 'active' },
    }, m);
    return result;
  }

  async addMember(actor: AccessActor, instId: string, body: { email?: unknown; role?: unknown }): Promise<Member> {
    await this.assertSchema();
    const role = this.parseRole(body?.role);
    const email = normEmail(body?.email);
    if (!email) throw E.invalidEmail();
    let targetId = '';
    await this.dataSource.transaction(async (m) => {
      await this.assertCanManage(m, actor, instId, true);
      const user = await this.resolveAuthorizedUserByEmail(m, email);
      if (!user) throw E.userNotFound();
      if (!actor.superAdmin && user.userId === actor.userId) throw E.selfModification();
      targetId = user.userId;
      await this.upsertMembershipTx(m, actor, instId, user.userId, role, user.email);
    });
    await this.invalidate(targetId);
    return this.memberOrThrow(instId, targetId);
  }

  async updateMember(actor: AccessActor, instId: string, userId: string, body: { role?: unknown; status?: unknown }): Promise<Member> {
    await this.assertSchema();
    if (!UUID_RE.test(String(userId || ''))) throw E.userNotFound();
    const hasRole = body?.role !== undefined && body?.role !== null;
    const hasStatus = body?.status !== undefined && body?.status !== null;
    if (!hasRole && !hasStatus) throw E.invalidInput('Indica role o status.');
    const role = hasRole ? this.parseRole(body.role) : null;
    if (hasStatus && !['active', 'suspended'].includes(String(body.status))) throw E.invalidStatus();
    const status = hasStatus ? (String(body.status) as 'active' | 'suspended') : null;
    await this.dataSource.transaction(async (m) => {
      const { inst } = await this.assertCanManage(m, actor, instId, true);
      if (!actor.superAdmin && userId === actor.userId) throw E.selfModification();
      const rows: any[] = await m.query(
        `select role, status from public.institution_memberships where institution_id = $1 and user_id = $2 for update`, [instId, userId]);
      const cur = rows[0];
      if (!cur || cur.status === 'removed') throw E.userNotFound();
      const next = { role: role ?? cur.role, status: status ?? cur.status };
      if (next.role === cur.role && next.status === cur.status) return;
      const denies = (await this.activeOverrides(m, instId, [userId])).get(userId)?.denies ?? [];
      await this.assertNotLastAdmin(m, actor, inst, userId, this.isEffectiveAdmin(cur.role, cur.status, denies), this.isEffectiveAdmin(next.role, next.status, denies));
      await m.query(
        `update public.institution_memberships set role = $3, status = $4, updated_by = $5, updated_at = now()
          where institution_id = $1 and user_id = $2`, [instId, userId, next.role, next.status, actor.userId]);
      await this.audit.record({
        ...auditActor(actor), action: 'membership.update', targetType: 'membership', targetId: userId, institutionId: instId,
        before: { role: cur.role, status: cur.status }, after: next,
      }, m);
    });
    await this.invalidate(userId);
    return this.memberOrThrow(instId, userId);
  }

  async removeMember(actor: AccessActor, instId: string, userId: string, reason: unknown): Promise<{ status: 'removed' }> {
    await this.assertSchema();
    if (!UUID_RE.test(String(userId || ''))) throw E.userNotFound();
    const why = typeof reason === 'string' ? reason.trim().slice(0, 1000) : null;
    await this.dataSource.transaction(async (m) => {
      const { inst } = await this.assertCanManage(m, actor, instId, true);
      if (!actor.superAdmin && userId === actor.userId) throw E.selfModification();
      const rows: any[] = await m.query(
        `select role, status from public.institution_memberships where institution_id = $1 and user_id = $2 for update`, [instId, userId]);
      const cur = rows[0];
      if (!cur || cur.status === 'removed') throw E.userNotFound();
      const denies = (await this.activeOverrides(m, instId, [userId])).get(userId)?.denies ?? [];
      await this.assertNotLastAdmin(m, actor, inst, userId, this.isEffectiveAdmin(cur.role, cur.status, denies), false);
      await m.query(
        `update public.institution_memberships set status = 'removed', updated_by = $3, updated_at = now()
          where institution_id = $1 and user_id = $2`, [instId, userId, actor.userId]);
      const revoked = rowsOf(await m.query(
        `update public.institution_permission_overrides set revoked_by = $3, revoked_at = now()
          where institution_id = $1 and user_id = $2 and revoked_at is null returning permission, effect`, [instId, userId, actor.userId]));
      await this.audit.record({
        ...auditActor(actor), action: 'membership.remove', targetType: 'membership', targetId: userId, institutionId: instId,
        before: { role: cur.role, status: cur.status }, after: { status: 'removed', reason: why, revokedOverrides: revoked.length },
      }, m);
    });
    await this.invalidate(userId);
    return { status: 'removed' };
  }

  async setOverrides(actor: AccessActor, instId: string, userId: string, body: { grants?: unknown; denies?: unknown; reason?: unknown }): Promise<Member> {
    await this.assertSchema();
    if (!UUID_RE.test(String(userId || ''))) throw E.userNotFound();
    const parseList = (v: unknown): Permission[] => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v)) throw E.invalidInput('grants y denies deben ser listas.');
      const out: Permission[] = [];
      for (const p of v) {
        if (!isPermission(p)) throw E.permissionNotGrantable(String(p).slice(0, 60));
        if (!out.includes(p)) out.push(p);
      }
      return out;
    };
    const grants = parseList(body?.grants);
    const denies = parseList(body?.denies);
    for (const g of grants) if (GLOBAL_ONLY_PERMISSIONS.has(g)) throw E.permissionNotGrantable(g); // D-7 (también para el SA)
    if (grants.some((g) => denies.includes(g))) throw E.invalidInput('Un permiso no puede estar a la vez en grants y denies.');
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';
    if (!reason) throw E.reasonRequired();
    await this.dataSource.transaction(async (m) => {
      const { inst, actorPerms } = await this.assertCanManage(m, actor, instId, true);
      if (!actor.superAdmin && userId === actor.userId) throw E.selfModification();
      const rows: any[] = await m.query(
        `select role, status from public.institution_memberships where institution_id = $1 and user_id = $2 for update`, [instId, userId]);
      const cur = rows[0];
      if (!cur || cur.status === 'removed') throw E.userNotFound();
      if (!actor.superAdmin) for (const g of grants) if (!actorPerms.has(g)) throw E.roleEscalation(g);
      const before = (await this.activeOverrides(m, instId, [userId])).get(userId) ?? { grants: [], denies: [] };
      await this.assertNotLastAdmin(m, actor, inst, userId, this.isEffectiveAdmin(cur.role, cur.status, before.denies), this.isEffectiveAdmin(cur.role, cur.status, denies));
      const desired = new Map<Permission, 'grant' | 'deny'>();
      for (const g of grants) desired.set(g, 'grant');
      for (const d of denies) desired.set(d, 'deny');
      const current = new Map<string, 'grant' | 'deny'>();
      for (const g of before.grants) current.set(g, 'grant');
      for (const d of before.denies) current.set(d, 'deny');
      for (const [perm] of current) {
        if (!desired.has(perm as Permission)) {
          await m.query(
            `update public.institution_permission_overrides set revoked_by = $4, revoked_at = now()
              where institution_id = $1 and user_id = $2 and permission = $3 and revoked_at is null`, [instId, userId, perm, actor.userId]);
        }
      }
      for (const [perm, effect] of desired) {
        if (current.get(perm) === effect) continue;
        await m.query(
          `insert into public.institution_permission_overrides (institution_id, user_id, permission, effect, reason, created_by)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (institution_id, user_id, permission) do update
             set effect = excluded.effect, reason = excluded.reason, created_by = excluded.created_by, created_at = now(),
                 revoked_by = null, revoked_at = null`, [instId, userId, perm, effect, reason, actor.userId]);
      }
      await this.audit.record({
        ...auditActor(actor), action: 'override.set', targetType: 'membership', targetId: userId, institutionId: instId,
        before, after: { grants, denies, reason },
      }, m);
    });
    await this.invalidate(userId);
    return this.memberOrThrow(instId, userId);
  }

  /** Invalida la caché de permisos de B (si está registrado). Nunca lanza. */
  async invalidate(userId: string): Promise<void> {
    if (!userId) return;
    try {
      const svc = this.moduleRef.get<R75PermissionServiceLike>(R75_PERMISSION_SERVICE, { strict: false });
      if (svc && typeof svc.invalidateUser === 'function') await svc.invalidateUser(userId);
    } catch { /* B no registrado: sin caché que invalidar */ }
  }
}
