import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FinopsBudgetService } from '../finops/finops-budget.service';
import { AccessActor, auditActor } from './access-actor';
import { E } from './access-errors';
import { authUsersReadable, iso, r75AccessSchemaPresent, rowsOf, UUID_RE } from './access-schema';
import { R75_PERMISSION_SERVICE, R75PermissionServiceLike } from './access.tokens';
import { AuditLogService, Queryable } from './audit-log.service';
import { PERMANENT_BAN_DURATION, SupabaseAdminClient } from './supabase-admin.client';

export type SuspensionKind = 'account' | 'generation';

export interface Suspension {
  id: string;
  kind: SuspensionKind;
  reason: string;
  createdBy: string;
  createdAt: string;
  liftedBy: string | null;
  liftedAt: string | null;
}

export interface ActiveSuspensions {
  account: Suspension | null;
  generation: Suspension | null;
}

function mapSuspension(r: any): Suspension {
  return {
    id: r.id, kind: r.kind, reason: r.reason, createdBy: r.created_by, createdAt: iso(r.created_at) ?? '',
    liftedBy: r.lifted_by ?? null, liftedAt: iso(r.lifted_at),
  };
}

export function isSuspensionKind(v: unknown): v is SuspensionKind {
  return v === 'account' || v === 'generation';
}

/**
 * r75 · A — suspensiones (01 §7). Son INDEPENDIENTES:
 *   - `account`: sin acceso a la API (403 account_suspended, lo aplica el AccountAccessGuard de B) + ban en Supabase Auth
 *     (best effort: la fila de la base es lo autoritativo) + pausa del sistema de sus runs en curso (sin cancelar ni borrar).
 *   - `generation`: sigue entrando y editando según su rol, pero sin generaciones nuevas (403 generation_suspended, lo
 *     aplican B/C). Los runs en curso SIGUEN (D-22).
 * Levantar una cuenta hace unban; los runs pausados se reanudan a mano.
 */
@Injectable()
export class SuspensionsService {
  private readonly logger = new Logger('Suspensions');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
    private readonly admin: SupabaseAdminClient,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Para B (guard) y C (arranques): suspensiones activas. Sin migración r75 → ninguna. */
  async getActive(userId: string, q: Queryable = this.dataSource): Promise<ActiveSuspensions> {
    const none: ActiveSuspensions = { account: null, generation: null };
    if (!UUID_RE.test(String(userId || '')) || !(await r75AccessSchemaPresent(this.dataSource))) return none;
    const rows: any[] = await q.query(
      `select * from public.user_suspensions where user_id = $1 and lifted_at is null`, [userId]);
    for (const r of rows) if (isSuspensionKind(r.kind)) none[r.kind] = mapSuspension(r);
    return none;
  }

  async history(userId: string): Promise<Suspension[]> {
    if (!UUID_RE.test(String(userId || '')) || !(await r75AccessSchemaPresent(this.dataSource))) return [];
    const rows: any[] = await this.dataSource.query(
      `select * from public.user_suspensions where user_id = $1 order by created_at desc, id`, [userId]);
    return rows.map(mapSuspension);
  }

  /** Usuario conocido: en la allow-list (por user_id) o en auth.users. */
  private async assertKnownUser(userId: string): Promise<void> {
    const rows: any[] = await this.dataSource.query(`select 1 from public.authorized_users where user_id = $1 limit 1`, [userId]);
    if (rows.length) return;
    if (await authUsersReadable(this.dataSource)) {
      const us: any[] = await this.dataSource.query(`select 1 from auth.users where id = $1`, [userId]);
      if (us.length) return;
    }
    throw E.userNotFound();
  }

  async suspend(actor: AccessActor, userId: string, kind: unknown, reason: unknown): Promise<Suspension> {
    if (!(await r75AccessSchemaPresent(this.dataSource))) throw E.schemaMissing();
    if (!UUID_RE.test(String(userId || ''))) throw E.userNotFound();
    if (!isSuspensionKind(kind)) throw E.invalidInput('kind debe ser account o generation.');
    const why = typeof reason === 'string' ? reason.trim().slice(0, 1000) : '';
    if (!why) throw E.reasonRequired();
    if (kind === 'account' && userId === actor.userId) throw E.selfModification(); // el SA no se deja fuera a sí mismo
    await this.assertKnownUser(userId);
    let row: any;
    await this.dataSource.transaction(async (m) => {
      const active: any[] = await m.query(
        `select id from public.user_suspensions where user_id = $1 and kind = $2 and lifted_at is null for update`, [userId, kind]);
      if (active.length) throw E.suspensionActive();
      try {
        [row] = await m.query(
          `insert into public.user_suspensions (user_id, kind, reason, created_by) values ($1, $2, $3, $4) returning *`,
          [userId, kind, why, actor.userId]);
      } catch (err: any) {
        if (err?.code === '23505') throw E.suspensionActive(); // carrera con otra suspensión
        throw err;
      }
      await this.audit.record({
        ...auditActor(actor), action: 'suspension.create', targetType: 'user', targetId: userId,
        before: null, after: { kind, reason: why, suspensionId: row.id },
      }, m);
    });
    await this.invalidate(userId);
    if (kind === 'account') {
      const pausedRuns = await this.pauseRunsOf(userId);
      const authBan = await this.applyBan(userId, PERMANENT_BAN_DURATION);
      await this.audit.recordSafe({
        ...auditActor(actor), action: 'suspension.account_effects', targetType: 'user', targetId: userId,
        after: { suspensionId: row.id, pausedRuns, authBan },
      });
    }
    return mapSuspension(row);
  }

  async lift(actor: AccessActor, userId: string, kind: unknown, reason: unknown): Promise<Suspension> {
    if (!(await r75AccessSchemaPresent(this.dataSource))) throw E.schemaMissing();
    if (!UUID_RE.test(String(userId || ''))) throw E.suspensionNotFound();
    if (!isSuspensionKind(kind)) throw E.invalidInput('kind debe ser account o generation.');
    const why = typeof reason === 'string' ? reason.trim().slice(0, 1000) : '';
    if (!why) throw E.reasonRequired();
    let row: any;
    await this.dataSource.transaction(async (m) => {
      const rows = rowsOf(await m.query(
        `update public.user_suspensions set lifted_by = $3, lifted_at = now(), lift_reason = $4
          where user_id = $1 and kind = $2 and lifted_at is null returning *`, [userId, kind, actor.userId, why]));
      if (!rows.length) throw E.suspensionNotFound();
      row = rows[0];
      await this.audit.record({
        ...auditActor(actor), action: 'suspension.lift', targetType: 'user', targetId: userId,
        before: { kind, suspensionId: row.id }, after: { liftedAt: iso(row.lifted_at), reason: why },
      }, m);
    });
    await this.invalidate(userId);
    if (kind === 'account') {
      const authBan = await this.applyBan(userId, 'none');
      await this.audit.recordSafe({
        ...auditActor(actor), action: 'suspension.account_lift_effects', targetType: 'user', targetId: userId,
        after: { suspensionId: row.id, authUnban: authBan },
      });
    }
    return mapSuspension(row);
  }

  /** Ban/unban en Supabase Auth. Best effort: devuelve el resultado para la auditoría; nunca lanza. */
  private async applyBan(userId: string, duration: string): Promise<'applied' | 'unavailable' | 'failed'> {
    if (!this.admin.isConfigured()) return 'unavailable';
    try {
      await this.admin.setBan(userId, duration);
      return 'applied';
    } catch {
      this.logger.warn(`ban/unban en Supabase Auth no aplicado (la suspensión de la base sigue vigente)`);
      return 'failed';
    }
  }

  /**
   * Cuenta suspendida → los runs dinámicos vivos del usuario (dueño o iniciador) se pausan por el sistema
   * (`pause.reason='account_suspended'`): sin gasto nuevo, sin cancelar ni borrar. Usa la pausa del servidor existente.
   */
  private async pauseRunsOf(userId: string): Promise<number> {
    const runs: any[] = await this.dataSource.query(
      `select id::text as id from public.production_jobs
        where execution_mode = 'dynamic_generation' and worker_status in ('queued', 'running', 'retrying')
          and (owner_id::text = $1::text or input_payload->>'startedBy' = $1::text)`, [userId]);
    let budget: FinopsBudgetService | null = null;
    try { budget = this.moduleRef.get(FinopsBudgetService, { strict: false }); } catch { budget = null; }
    let paused = 0;
    for (const r of runs) {
      try {
        const ok = budget
          ? await budget.pauseRunBySystem(r.id, 'account_suspended', 'cuenta suspendida por el SuperAdmin')
          : await this.pauseRunFallback(r.id);
        if (ok) paused++;
      } catch {
        this.logger.warn(`no se pudo pausar el run ${r.id} de un usuario suspendido`);
      }
    }
    return paused;
  }

  /** Misma SQL que FinopsBudgetService.pauseRunBySystem (por si FinOps no está en el contenedor, p. ej. en pruebas). */
  private async pauseRunFallback(runId: string): Promise<boolean> {
    const rows = rowsOf(await this.dataSource.query(
      `update public.production_jobs
          set status = 'paused', worker_status = 'paused', next_retry_at = null,
              output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object(
                'pause', jsonb_build_object('pausedAt', now(), 'pausedBy', 'system:account_suspended', 'reason', 'account_suspended',
                                            'detail', 'cuenta suspendida por el SuperAdmin', 'requiredUsd', null, 'previousWorkerStatus', worker_status)),
              updated_at = now()
        where id = $1 and execution_mode = 'dynamic_generation' and worker_status in ('queued', 'running', 'retrying')
          and coalesce(status, '') not in ('cancelled', 'cancelling')
        returning id`, [runId]));
    return rows.length > 0;
  }

  private async invalidate(userId: string): Promise<void> {
    try {
      const svc = this.moduleRef.get<R75PermissionServiceLike>(R75_PERMISSION_SERVICE, { strict: false });
      if (svc && typeof svc.invalidateUser === 'function') await svc.invalidateUser(userId);
    } catch { /* B no registrado */ }
  }
}
