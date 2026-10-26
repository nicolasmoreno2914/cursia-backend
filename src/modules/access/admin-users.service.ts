import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { isSuperAdminEmail, superAdminUserIds } from '../../auth/super-admin';
import { AccessActor, auditActor } from './access-actor';
import { E } from './access-errors';
import { authUsersReadable, iso, normEmail, r75AccessSchemaPresent, UUID_RE } from './access-schema';
import { R75_BUDGET_READ_SERVICE, R75BudgetReadServiceLike, UserBudgetSummary } from './access.tokens';
import { AuditLogService, Queryable } from './audit-log.service';
import { MembershipsService } from './memberships.service';
import { isRole, Role } from './role-matrix';
import { Suspension, SuspensionsService } from './suspensions.service';
import { generateTempPassword, SupabaseAdminClient, SupabaseAdminError, SupabaseAuthUser } from './supabase-admin.client';

export interface AdminUser {
  id: string;
  email: string;
  fullName: string | null;
  authorized: boolean;
  accountStatus: 'active' | 'suspended';
  generationSuspended: boolean;
  superAdmin: boolean;
  lastSignInAt: string | null;
  createdAt: string;
  memberships: { institutionId: string; name: string; role: Role; status: string }[];
  /** null si el módulo de presupuestos (C) no está registrado. */
  budget: UserBudgetSummary | null;
}

export interface AdminUserDetail extends AdminUser {
  suspensions: Suspension[];
  recentRuns: { runId: string; courseId: number | null; status: string; startedAt: string | null }[];
}

export interface CreateUserResult {
  user: AdminUser;
  tempPassword?: string;
  invited: boolean;
}

interface BaseRow { userId: string; email: string; authorized: boolean; createdAt: string | null }

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

function adminErrorToHttp(err: unknown): never {
  if (err instanceof SupabaseAdminError) {
    if (err.kind === 'unavailable') throw E.adminApiUnavailable();
    if (err.kind === 'exists') throw E.userExistsUnauthorized(null);
    if (err.kind === 'invalid_email') throw E.invalidEmail();
    if (err.kind === 'not_found') throw E.userNotFound();
    throw E.adminApiError();
  }
  throw err;
}

/**
 * r75 · A — usuarios de la plataforma (solo SuperAdmin; regla 1 del owner: SOLO el SA crea usuarios).
 * La contraseña temporal (mode temp_password) se genera aquí, viaja UNA vez en la respuesta y nunca se escribe en
 * logs, auditoría ni base. Usuario nuevo = presupuesto USD 0 (regla 6): A no crea filas de presupuesto.
 */
@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger('AdminUsers');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
    private readonly memberships: MembershipsService,
    private readonly suspensions: SuspensionsService,
    private readonly admin: SupabaseAdminClient,
    private readonly moduleRef: ModuleRef,
  ) {}

  private async assertSchema(): Promise<void> {
    if (!(await r75AccessSchemaPresent(this.dataSource))) throw E.schemaMissing();
  }

  private budgetReader(): R75BudgetReadServiceLike | null {
    try { return this.moduleRef.get<R75BudgetReadServiceLike>(R75_BUDGET_READ_SERVICE, { strict: false }) ?? null; } catch { return null; }
  }

  private isSuperAdmin(userId: string, email: string): boolean {
    if (!isSuperAdminEmail(email)) return false;
    const pinned = superAdminUserIds();
    return !pinned || pinned.includes(userId.toLowerCase());
  }

  // ── lectura ─────────────────────────────────────────────────────────────

  private async authInfo(ids: string[]): Promise<Map<string, { email: string | null; fullName: string | null; lastSignInAt: string | null; createdAt: string | null }>> {
    const out = new Map<string, { email: string | null; fullName: string | null; lastSignInAt: string | null; createdAt: string | null }>();
    if (!ids.length || !(await authUsersReadable(this.dataSource))) return out;
    try {
      const rows: any[] = await this.dataSource.query(
        `select id::text as id, email, last_sign_in_at, created_at,
                nullif(trim(coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', '')), '') as full_name
           from auth.users where id = any($1::uuid[])`, [ids]);
      for (const r of rows) out.set(r.id, { email: r.email ?? null, fullName: r.full_name ?? null, lastSignInAt: iso(r.last_sign_in_at), createdAt: iso(r.created_at) });
    } catch { /* ilegible */ }
    return out;
  }

  private async decorate(base: BaseRow[]): Promise<AdminUser[]> {
    const ids = base.map((b) => b.userId).filter((id) => UUID_RE.test(id));
    const auth = await this.authInfo(ids);
    const susp: any[] = ids.length ? await this.dataSource.query(
      `select user_id::text as user_id, kind from public.user_suspensions where user_id = any($1::uuid[]) and lifted_at is null`, [ids]) : [];
    const mems: any[] = ids.length ? await this.dataSource.query(
      `select m.user_id::text as user_id, m.institution_id::text as institution_id, i.name, m.role, m.status
         from public.institution_memberships m join public.institutions i on i.id = m.institution_id
        where m.user_id = any($1::uuid[]) and m.status <> 'removed' order by m.created_at`, [ids]) : [];
    let budgets: Record<string, UserBudgetSummary> = {};
    const br = this.budgetReader();
    if (br && ids.length) {
      try {
        if (typeof br.getSummaries === 'function') budgets = await br.getSummaries(ids);
        else if (typeof br.getSummary === 'function') for (const id of ids) budgets[id] = await br.getSummary(id);
      } catch { budgets = {}; this.logger.warn('presupuestos no disponibles para la lista de usuarios'); }
    }
    return base.map((b) => {
      const a = auth.get(b.userId);
      return {
        id: b.userId,
        email: b.email,
        fullName: a?.fullName ?? null,
        authorized: b.authorized,
        accountStatus: susp.some((s) => s.user_id === b.userId && s.kind === 'account') ? 'suspended' : 'active',
        generationSuspended: susp.some((s) => s.user_id === b.userId && s.kind === 'generation'),
        superAdmin: this.isSuperAdmin(b.userId, b.email),
        lastSignInAt: a?.lastSignInAt ?? null,
        createdAt: a?.createdAt ?? b.createdAt ?? '',
        memberships: mems.filter((m) => m.user_id === b.userId).map((m) => ({ institutionId: m.institution_id, name: m.name, role: m.role, status: m.status })),
        budget: budgets[b.userId] ?? null,
      };
    });
  }

  async list(query: { q?: string; status?: string; institutionId?: string; page?: unknown; pageSize?: unknown }): Promise<{ items: AdminUser[]; total: number }> {
    await this.assertSchema();
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(query.pageSize) || 25)));
    const q = typeof query.q === 'string' && query.q.trim() ? query.q.trim().toLowerCase().slice(0, 200) : null;
    const status = query.status || null;
    if (status && !['active', 'suspended', 'generation_suspended', 'unauthorized'].includes(status)) throw E.invalidStatus();
    const inst = query.institutionId || null;
    if (inst && !UUID_RE.test(inst)) return { items: [], total: 0 };

    if (status === 'unauthorized') {
      // Usuarios de Auth sin fila en la allow-list (registros abiertos de staging, H1). Requiere leer auth.users.
      if (!(await authUsersReadable(this.dataSource))) return { items: [], total: 0 };
      const rows: any[] = await this.dataSource.query(
        `select u.id::text as user_id, u.email, u.created_at, count(*) over() as total
           from auth.users u
          where u.email is not null
            and not exists (select 1 from public.authorized_users au where au.user_id = u.id or lower(au.email) = lower(u.email))
            and ($1::text is null or lower(u.email) like '%' || $1 || '%' escape '\\')
          order by lower(u.email) limit $2 offset $3`, [q ? escapeLike(q) : null, pageSize, (page - 1) * pageSize]);
      const items = await this.decorate(rows.map((r) => ({ userId: r.user_id, email: r.email, authorized: false, createdAt: iso(r.created_at) })));
      return { items, total: Number(rows[0]?.total ?? 0) };
    }

    const readable = await authUsersReadable(this.dataSource);
    const uidExpr = readable
      ? `coalesce(au.user_id, (select u.id from auth.users u where lower(u.email) = lower(au.email) limit 1))`
      : `au.user_id`;
    const rows: any[] = await this.dataSource.query(
      `select * from (
         select au.email, au.created_at, (${uidExpr})::text as user_id from public.authorized_users au
          where ($1::text is null or lower(au.email) like '%' || $1 || '%' escape '\\')
       ) b
       where ($2::text is null
              or ($2 = 'suspended' and exists (select 1 from public.user_suspensions s where s.user_id::text = b.user_id and s.kind = 'account' and s.lifted_at is null))
              or ($2 = 'generation_suspended' and exists (select 1 from public.user_suspensions s where s.user_id::text = b.user_id and s.kind = 'generation' and s.lifted_at is null))
              or ($2 = 'active' and not exists (select 1 from public.user_suspensions s where s.user_id::text = b.user_id and s.kind = 'account' and s.lifted_at is null)))
         and ($3::uuid is null or exists (select 1 from public.institution_memberships m
                                           where m.user_id::text = b.user_id and m.institution_id = $3::uuid and m.status <> 'removed'))
       order by lower(b.email)`, [q ? escapeLike(q) : null, status, inst]);
    const total = rows.length;
    const slice = rows.slice((page - 1) * pageSize, page * pageSize);
    const items = await this.decorate(slice.map((r) => ({ userId: r.user_id ?? '', email: r.email, authorized: true, createdAt: iso(r.created_at) })));
    return { items, total };
  }

  /** Base de un usuario por id: allow-list (por user_id o por email de Auth) o solo Auth (authorized=false). */
  private async baseOf(userId: string): Promise<BaseRow | null> {
    if (!UUID_RE.test(String(userId || ''))) return null;
    const au: any[] = await this.dataSource.query(
      `select email, created_at from public.authorized_users where user_id = $1 limit 1`, [userId]);
    if (au[0]) return { userId, email: au[0].email, authorized: true, createdAt: iso(au[0].created_at) };
    const authUser = await this.lookupAuthUser(userId);
    if (!authUser || !authUser.email) return null;
    const byEmail: any[] = await this.dataSource.query(
      `select email, created_at, user_id from public.authorized_users where lower(email) = lower($1) limit 1`, [authUser.email]);
    if (byEmail[0] && !byEmail[0].user_id) return { userId, email: byEmail[0].email, authorized: true, createdAt: iso(byEmail[0].created_at) };
    return { userId, email: authUser.email, authorized: false, createdAt: authUser.createdAt };
  }

  /** auth.users por pg (staging) o, si no se puede leer, por la Admin API. null si no existe. */
  private async lookupAuthUser(userId: string): Promise<SupabaseAuthUser | null> {
    if (await authUsersReadable(this.dataSource)) {
      const rows: any[] = await this.dataSource.query(
        `select id::text as id, email, created_at, last_sign_in_at, email_confirmed_at, banned_until, raw_user_meta_data
           from auth.users where id = $1`, [userId]);
      const r = rows[0];
      return r ? { id: r.id, email: r.email, createdAt: iso(r.created_at), lastSignInAt: iso(r.last_sign_in_at), emailConfirmedAt: iso(r.email_confirmed_at),
        bannedUntil: iso(r.banned_until), userMetadata: r.raw_user_meta_data ?? {} } : null;
    }
    if (!this.admin.isConfigured()) return null;
    try { return await this.admin.getUser(userId); } catch (err) {
      if (err instanceof SupabaseAdminError && err.kind === 'not_found') return null;
      return adminErrorToHttp(err);
    }
  }

  async getOne(userId: string): Promise<AdminUserDetail> {
    await this.assertSchema();
    const base = await this.baseOf(userId);
    if (!base) throw E.userNotFound();
    const [user] = await this.decorate([base]);
    const suspensions = await this.suspensions.history(userId);
    const runs: any[] = await this.dataSource.query(
      `select id::text as id, course_id::text as course_id, coalesce(worker_status, status) as status, coalesce(started_at, created_at) as started_at
         from public.production_jobs
        where execution_mode = 'dynamic_generation' and (owner_id::text = $1::text or input_payload->>'startedBy' = $1::text)
        order by created_at desc limit 10`, [userId]);
    return {
      ...user,
      suspensions,
      recentRuns: runs.map((r) => ({ runId: r.id, courseId: /^\d+$/.test(String(r.course_id ?? '')) ? Number(r.course_id) : null, status: r.status, startedAt: iso(r.started_at) })),
    };
  }

  // ── creación (solo SA) ──────────────────────────────────────────────────

  private parseMemberships(v: unknown): { institutionId: string; role: Role }[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > 50) throw E.invalidInput('memberships debe ser una lista (máx. 50).');
    const out: { institutionId: string; role: Role }[] = [];
    for (const m of v) {
      const instId = m && typeof m === 'object' ? (m as any).institutionId : null;
      const role = m && typeof m === 'object' ? (m as any).role : null;
      if (typeof instId !== 'string' || !UUID_RE.test(instId)) throw E.invalidInput('institutionId inválido.');
      if (typeof role === 'string' && /^super[_\s-]?admin$/i.test(role.trim())) throw E.superadminReserved();
      if (!isRole(role)) throw E.invalidRole();
      if (!out.some((o) => o.institutionId === instId)) out.push({ institutionId: instId, role });
    }
    return out;
  }

  private async applyDbPart(q: Queryable, actor: AccessActor, user: { id: string; email: string }, memberships: { institutionId: string; role: Role }[], meta: Record<string, unknown>): Promise<string[]> {
    await q.query(
      `update public.authorized_users set user_id = $2 where lower(email) = lower($1) and user_id is null`, [user.email, user.id]);
    const linked: any[] = await q.query(
      `select user_id::text as user_id from public.authorized_users where lower(email) = lower($1)`, [user.email]);
    if (!linked.length) {
      await q.query(
        `insert into public.authorized_users (email, user_id, is_admin, status) values ($1, $2, false, 'active')`, [user.email, user.id]);
    } else if (linked.some((l) => l.user_id && l.user_id !== user.id)) {
      throw new Error('allow-list enlazada a otro usuario');
    }
    const added: string[] = [];
    for (const m of memberships) {
      const exists: any[] = await q.query(
        `select status from public.institution_memberships where institution_id = $1 and user_id = $2`, [m.institutionId, user.id]);
      if (exists[0] && exists[0].status !== 'removed') continue;
      await this.memberships.upsertMembershipTx(q, actor, m.institutionId, user.id, m.role, user.email);
      added.push(m.institutionId);
    }
    await this.audit.record({
      ...auditActor(actor), action: String(meta.action ?? 'user.create'), targetType: 'user', targetId: user.id,
      after: { email: user.email, memberships, membershipsAdded: added, ...meta, action: undefined },
    }, q);
    return added;
  }

  async create(actor: AccessActor, body: { email?: unknown; fullName?: unknown; mode?: unknown; memberships?: unknown }): Promise<CreateUserResult> {
    await this.assertSchema();
    const email = normEmail(body?.email);
    if (!email) throw E.invalidEmail();
    const mode = body?.mode === undefined || body?.mode === null ? 'invite' : body.mode;
    if (mode !== 'invite' && mode !== 'temp_password') throw E.invalidInput("mode debe ser 'invite' o 'temp_password'.");
    const fullName = typeof body?.fullName === 'string' && body.fullName.trim() ? body.fullName.trim().slice(0, 200) : null;
    const memberships = this.parseMemberships(body?.memberships);
    // Todo lo validable se valida ANTES de crear el usuario en Auth (evita usuarios a medias).
    for (const m of memberships) {
      const rows: any[] = await this.dataSource.query(`select 1 from public.institutions where id = $1`, [m.institutionId]);
      if (!rows.length) throw E.institutionNotFound();
    }
    if (!this.admin.isConfigured()) throw E.adminApiUnavailable();
    const already: any[] = await this.dataSource.query(`select 1 from public.authorized_users where lower(email) = $1 limit 1`, [email]);
    if (already.length) throw E.userExists();
    if (await authUsersReadable(this.dataSource)) {
      const au: any[] = await this.dataSource.query(`select id::text as id from auth.users where lower(email) = $1 limit 1`, [email]);
      if (au.length) throw E.userExistsUnauthorized(au[0].id);
    }

    let created: SupabaseAuthUser;
    let tempPassword: string | undefined;
    try {
      if (mode === 'temp_password') {
        tempPassword = generateTempPassword(20);
        created = await this.admin.createUserWithPassword(email, tempPassword, { full_name: fullName, must_change_password: true });
      } else {
        created = await this.admin.inviteUser(email, { full_name: fullName });
      }
    } catch (err) {
      tempPassword = undefined;
      return adminErrorToHttp(err);
    }
    if (!created.id || !UUID_RE.test(created.id)) throw E.adminApiError();
    const user = { id: created.id, email: (created.email || email).toLowerCase() };

    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      try {
        await this.dataSource.transaction((m) => this.applyDbPart(m, actor, user, memberships, { action: 'user.create', mode, fullName, invited: mode === 'invite' }));
        ok = true;
      } catch (err) {
        this.logger.warn(`alta de usuario: la parte de base falló (intento ${attempt}/2): ${err instanceof Error ? err.message.slice(0, 120) : 'error'}`);
      }
    }
    if (!ok) {
      // Nunca se borra el usuario de Auth automáticamente: queda para «Reparar».
      await this.audit.recordSafe({
        ...auditActor(actor), action: 'user.create_partial', targetType: 'user', targetId: user.id,
        after: { email: user.email, mode, memberships },
      });
      throw E.userCreatePartial(user.id);
    }
    await this.memberships.invalidate(user.id);
    const [adminUser] = await this.decorate([{ userId: user.id, email: user.email, authorized: true, createdAt: created.createdAt }]);
    return { user: adminUser, ...(tempPassword ? { tempPassword } : {}), invited: mode === 'invite' };
  }

  /** Usuario de Auth SIN fila en la allow-list → se autoriza (decisión explícita del SA, con motivo). */
  async authorize(actor: AccessActor, userId: string, reason: unknown): Promise<AdminUser> {
    await this.assertSchema();
    const why = typeof reason === 'string' ? reason.trim().slice(0, 1000) : '';
    if (!why) throw E.reasonRequired();
    if (!UUID_RE.test(String(userId || ''))) throw E.userNotFound();
    const linked: any[] = await this.dataSource.query(`select 1 from public.authorized_users where user_id = $1`, [userId]);
    if (linked.length) throw E.userExists();
    const authUser = await this.lookupAuthUser(userId);
    if (!authUser || !authUser.email) throw E.userNotFound();
    const email = authUser.email.toLowerCase();
    await this.dataSource.transaction((m) => this.applyDbPart(m, actor, { id: userId, email }, [], { action: 'user.authorize', reason: why }));
    await this.memberships.invalidate(userId);
    const [u] = await this.decorate([{ userId, email, authorized: true, createdAt: authUser.createdAt }]);
    return u;
  }

  /** Completa un alta a medias (user_create_partial): allow-list + membresías pedidas. Idempotente. */
  async repair(actor: AccessActor, userId: string): Promise<AdminUser> {
    await this.assertSchema();
    if (!UUID_RE.test(String(userId || ''))) throw E.userNotFound();
    const authUser = await this.lookupAuthUser(userId);
    if (!authUser || !authUser.email) throw E.userNotFound();
    const email = authUser.email.toLowerCase();
    const partial: any[] = await this.dataSource.query(
      `select after from public.admin_audit_log where action = 'user.create_partial' and target_type = 'user' and target_id = $1
        order by id desc limit 1`, [userId]);
    let memberships: { institutionId: string; role: Role }[] = [];
    try { memberships = this.parseMemberships(partial[0]?.after?.memberships ?? []); } catch { memberships = []; }
    const existing: any[] = [];
    for (const m of memberships) {
      const r: any[] = await this.dataSource.query(`select 1 from public.institutions where id = $1`, [m.institutionId]);
      if (r.length) existing.push(m);
    }
    await this.dataSource.transaction((m) => this.applyDbPart(m, actor, { id: userId, email }, existing, { action: 'user.repair' }));
    await this.memberships.invalidate(userId);
    const [u] = await this.decorate([{ userId, email, authorized: true, createdAt: authUser.createdAt }]);
    return u;
  }
}
