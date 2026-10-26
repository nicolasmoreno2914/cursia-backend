import { Controller, Get, Header, Logger, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { isSuperAdminEmail, superAdminUserIds } from '../../auth/super-admin';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { budgetsMode, R75Mode, rbacMode } from './access-mode';
import { r75AccessSchemaPresent } from './access-schema';
import {
  R75_BUDGET_READ_SERVICE, R75_PERMISSION_SERVICE, R75BudgetReadServiceLike, R75PermissionServiceLike, UserBudgetSummary,
} from './access.tokens';
import { AllowInactiveAccount } from './allow-inactive-account.decorator';
import { MembershipsService } from './memberships.service';
import { PlatformControlsService } from './platform-controls.service';
import { Permission, Role } from './role-matrix';
import { SuspensionsService } from './suspensions.service';

export interface MeContext {
  user: { id: string; email: string };
  superAdmin: boolean;
  account: { authorized: boolean; status: 'active' | 'suspended' | 'not_authorized'; mustChangePassword: boolean };
  generation: { suspended: boolean; platformFrozen: boolean };
  rbacMode: R75Mode;
  budgetsMode: R75Mode;
  memberships: Array<{ institutionId: string; name: string; kind: 'organization' | 'personal'; role: Role; status: 'active' | 'suspended'; permissions: Permission[] }>;
  defaultInstitutionId: string | null;
  budget: UserBudgetSummary | null;
}

/**
 * r75 · 02 §A — `GET /me/context`: lo ÚNICO que el FE usa para decidir qué mostrar (el servidor decide todo).
 * Responde aunque la cuenta esté suspendida o no autorizada (para que el FE muestre la pantalla correcta) y no expone
 * datos de terceros. Partes opcionales: permisos efectivos vía PermissionService de B (si está registrado; si no, la
 * matriz de A, que es la misma regla) y presupuesto vía BudgetReadService de C (null si falta o budgetsMode='off').
 * Sin migración r75 (producción hoy) → sin membresías ni suspensiones, solo la allow-list.
 */
@Controller('me')
@UseGuards(SupabaseJwtGuard)
export class MeContextController {
  private readonly logger = new Logger('MeContext');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly memberships: MembershipsService,
    private readonly suspensions: SuspensionsService,
    private readonly platform: PlatformControlsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private optional<T>(token: string): T | null {
    try { return this.moduleRef.get<T>(token, { strict: false }) ?? null; } catch { return null; }
  }

  private isSuperAdmin(user: AuthUser): boolean {
    if (!isSuperAdminEmail(user.email)) return false;
    const pinned = superAdminUserIds();
    return !pinned || pinned.includes(String(user.id).toLowerCase());
  }

  private async allowListed(user: AuthUser, schema: boolean): Promise<boolean> {
    try {
      const rows: any[] = schema
        ? await this.dataSource.query(
          `select 1 from public.authorized_users
            where (user_id = $1::uuid or (user_id is null and lower(email) = lower($2))) and coalesce(status, 'active') = 'active' limit 1`,
          [user.id, user.email || ''])
        : await this.dataSource.query(`select 1 from public.authorized_users where lower(email) = lower($1) limit 1`, [user.email || '']);
      return rows.length > 0;
    } catch {
      return false; // sin tabla de allow-list (base local) → no autorizado (falla cerrado)
    }
  }

  @Get('context')
  @AllowInactiveAccount()
  @Header('Cache-Control', 'no-store')
  async context(@CurrentUser() user: AuthUser) {
    const schema = await r75AccessSchemaPresent(this.dataSource);
    const superAdmin = this.isSuperAdmin(user);
    const authorized = superAdmin || (await this.allowListed(user, schema));
    const active = schema ? await this.suspensions.getActive(user.id) : { account: null, generation: null };
    const platformFrozen = schema ? await this.platform.isGenerationFrozen() : false;
    const meta = user.raw?.user_metadata && typeof user.raw.user_metadata === 'object' ? user.raw.user_metadata : {};

    let memberships: MeContext['memberships'] = [];
    let defaultInstitutionId: string | null = null;
    if (schema && authorized && !active.account) {
      const list = await this.memberships.listForUser(user.id);
      const perms = this.optional<R75PermissionServiceLike>(R75_PERMISSION_SERVICE);
      memberships = [];
      for (const m of list) {
        let permissions = m.permissions;
        if (perms && typeof perms.effectivePermissions === 'function' && m.status === 'active') {
          try { permissions = (await perms.effectivePermissions(user.id, m.institutionId)) as Permission[]; } catch { /* matriz de A */ }
        }
        memberships.push({ institutionId: m.institutionId, name: m.name, kind: m.kind, role: m.role, status: m.status === 'suspended' ? 'suspended' : 'active', permissions });
      }
      const usable = list.filter((m) => m.status === 'active' && m.institutionStatus === 'active');
      defaultInstitutionId = (usable.find((m) => m.kind === 'personal') ?? usable[0])?.institutionId ?? null;
    }

    let budget: UserBudgetSummary | null = null;
    const bMode = budgetsMode();
    if (bMode !== 'off' && authorized) {
      const reader = this.optional<R75BudgetReadServiceLike>(R75_BUDGET_READ_SERVICE);
      if (reader && typeof reader.getSummary === 'function') {
        try { budget = await reader.getSummary(user.id); } catch { budget = null; this.logger.warn('presupuesto no disponible para /me/context'); }
      }
    }

    const data: MeContext = {
      user: { id: user.id, email: user.email },
      superAdmin,
      account: {
        authorized,
        status: !authorized ? 'not_authorized' : active.account ? 'suspended' : 'active',
        mustChangePassword: (meta as any).must_change_password === true,
      },
      generation: { suspended: !!active.generation, platformFrozen },
      rbacMode: rbacMode(),
      budgetsMode: bMode,
      memberships,
      defaultInstitutionId,
      budget,
    };
    return { ok: true, data };
  }
}
