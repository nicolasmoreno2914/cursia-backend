import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { R75_PERMISSION_SERVICE } from '../access/access.tokens';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { BudgetActor, BudgetPermission, BudgetPermissionPort, UUID_RE, permissionDenied, rbacMode } from './budget-common';

/**
 * r75 (Agente C) — autorización de las rutas de presupuesto/gasto que NO son solo de SuperAdmin.
 *
 * Con el PermissionService de B registrado (token compartido R75_PERMISSION_SERVICE de access.tokens.ts, resuelto con
 * ModuleRef sin importar el módulo de B; se usa si expone `can(actor, permission, institutionId)`) decide él (roles, overrides, membresía, 01 §2.3).
 * Sin él:
 *   - CURSIA_RBAC_MODE=off → comportamiento de hoy, dueño único: el dueño del curso (courses.owner_id) inicia/reintenta
 *     y pide autorización sobre su curso; el gasto de una institución solo lo ve el SuperAdmin.
 *   - shadow/enforce sin PermissionService → falla cerrado (403), nunca abre por falta de cableado.
 * El SuperAdmin pasa siempre (los controles FINANCIEROS igual aplican: D-18).
 */
@Injectable()
export class BudgetAccessService {
  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  private get port(): BudgetPermissionPort | null {
    try {
      const p = this.moduleRef?.get(R75_PERMISSION_SERVICE, { strict: false }) as BudgetPermissionPort | undefined;
      return p && typeof p.can === 'function' ? p : null;
    } catch {
      return null;
    }
  }

  actorOf(user: { id: string; email?: string | null } | null | undefined): BudgetActor {
    const id = String(user?.id ?? '');
    if (!UUID_RE.test(id)) throw permissionDenied('auth');
    const email = user?.email ? String(user.email) : null;
    return { id: id.toLowerCase(), email, superAdmin: isSuperAdminEmail(email) };
  }

  /** Curso → {institutionId, ownerId} si el actor tiene `permission` sobre él. Curso inexistente o ajeno → 404. */
  async courseAccess(actor: BudgetActor, courseId: number, permission: BudgetPermission): Promise<{ institutionId: string | null; ownerId: string | null; title: string | null }> {
    if (!Number.isInteger(courseId) || courseId < 1) throw new NotFoundException({ code: 'course_not_found', message: 'Curso no encontrado' });
    const [c] = await this.dataSource.query(
      `select owner_id::text as owner_id, institution_id::text as institution_id, title from public.courses where id = $1`, [courseId]);
    if (!c) throw new NotFoundException({ code: 'course_not_found', message: 'Curso no encontrado' });
    const out = { institutionId: c.institution_id ?? null, ownerId: c.owner_id ?? null, title: c.title ?? null };
    if (actor.superAdmin) return out;
    const port = this.port;
    if (port) {
      if (!out.institutionId) throw new NotFoundException({ code: 'course_not_found', message: 'Curso no encontrado' }); // huérfano: solo SA
      if (await port.can({ id: actor.id, email: actor.email }, permission, out.institutionId)) return out;
      throw permissionDenied(permission);
    }
    if (rbacMode() === 'off' && out.ownerId && out.ownerId.toLowerCase() === actor.id) return out;
    // Sin permiso: 404 (no revela que el curso existe), como el filtro de dueño de hoy.
    throw new NotFoundException({ code: 'course_not_found', message: 'Curso no encontrado' });
  }

  /** ¿Puede ver el gasto de la institución? (P(spend.view) o SA). */
  async canViewInstitutionSpend(actor: BudgetActor, institutionId: string): Promise<boolean> {
    if (actor.superAdmin) return true;
    const port = this.port;
    if (!port) return false;
    return port.can({ id: actor.id, email: actor.email }, 'spend.view', institutionId);
  }
}
