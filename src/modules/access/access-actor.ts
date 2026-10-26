import { AuthUser } from '../../auth/auth.types';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { AuditActor } from './audit-log.service';

/** Actor de una acción de A. `superAdmin` sale SOLO del env (D-3); SupabaseJwtGuard ya verificó la identidad del admin. */
export interface AccessActor {
  userId: string;
  email: string | null;
  superAdmin: boolean;
  ip?: string | null;
  requestId?: string | null;
}

export function actorFromUser(user: AuthUser, req?: { ip?: string; headers?: Record<string, any> }): AccessActor {
  const rid = req?.headers?.['x-request-id'];
  return {
    userId: user.id,
    email: user.email || null,
    superAdmin: isSuperAdminEmail(user.email),
    ip: req?.ip ?? null,
    requestId: typeof rid === 'string' ? rid : null,
  };
}

export function auditActor(a: AccessActor): AuditActor & { ip?: string | null; requestId?: string | null } {
  return { actorId: a.userId, actorEmail: a.email, actorIsSuperAdmin: a.superAdmin, ip: a.ip ?? null, requestId: a.requestId ?? null };
}
