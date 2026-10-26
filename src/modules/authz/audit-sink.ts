import { Logger } from '@nestjs/common';
import { tableExists, QueryFn } from './schema-probe';

/**
 * r75 · Auditoría que B escribe (`rbac.shadow_deny`, `account_guard.shadow_deny`, …).
 *
 * La interfaz real es `AuditLogService` de A (`src/modules/access/audit-log.service.ts`, contrato 03 §1). B NO importa
 * el archivo de A: se inyecta por el token `R75_AUDIT_LOG` (lo provee A/el lead al integrar). Sin proveedor, se escribe
 * directo en `public.admin_audit_log` (01 §1.6) si la tabla existe; si no, solo log. Nunca lanza: la auditoría de
 * shadow no puede cortar un request.
 */
export const R75_AUDIT_LOG = 'R75_AUDIT_LOG';

export interface AuditEntryInput {
  actorId: string;
  actorEmail?: string | null;
  actorIsSuperadmin: boolean;
  action: string;
  targetType: string;
  targetId?: string | null;
  institutionId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

/** Forma mínima que B consume de AuditLogService (A). */
export interface AuditLogLike {
  record(entry: AuditEntryInput): Promise<unknown>;
}

const logger = new Logger('R75Audit');

export async function writeAudit(sink: AuditLogLike | null | undefined, query: QueryFn | null, entry: AuditEntryInput): Promise<void> {
  try {
    if (sink && typeof sink.record === 'function') {
      await sink.record(entry);
      return;
    }
    if (query && (await tableExists(query, 'admin_audit_log'))) {
      await query(
        `insert into public.admin_audit_log (actor_id, actor_email, actor_is_superadmin, action, target_type, target_id, institution_id, before, after, request_id)
         values ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::jsonb, $9::jsonb, $10)`,
        [
          entry.actorId,
          entry.actorEmail ?? null,
          entry.actorIsSuperadmin,
          entry.action,
          entry.targetType,
          entry.targetId ?? null,
          entry.institutionId ?? null,
          entry.before === undefined ? null : JSON.stringify(entry.before),
          entry.after === undefined ? null : JSON.stringify(entry.after),
          entry.requestId ?? null,
        ],
      );
      return;
    }
    logger.warn(`${entry.action} actor=${entry.actorId} target=${entry.targetType}:${entry.targetId ?? '-'} (sin admin_audit_log)`);
  } catch (err) {
    logger.warn(`no se pudo registrar ${entry.action}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
  }
}
