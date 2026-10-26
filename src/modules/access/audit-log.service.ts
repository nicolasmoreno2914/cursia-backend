import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';

/**
 * r75 · A — AuditLogService: INTERFAZ COMPARTIDA (B y C la consumen, no la editan).
 *
 * Tabla `public.admin_audit_log` (append-only por trigger). Reglas:
 *   - NUNCA secretos: contraseñas temporales, tokens, claves. `scrubSecrets` redacta por nombre de clave antes de
 *     escribir, como defensa adicional; quien llama igual no debe pasarlos.
 *   - `record(entry, tx?)`: con `tx` (QueryRunner / EntityManager / DataSource: cualquier cosa con `.query`) la fila
 *     entra en la MISMA transacción que el cambio auditado (si el cambio hace rollback, la auditoría también).
 *   - Acciones (prefijo por dominio): user.*, membership.*, override.*, institution.*, course.*, suspension.*,
 *     platform.*, budget.*, request.*, rbac.shadow_deny, finops.reconcile_drift, backfill.*.
 */
export interface AuditActor {
  actorId: string;
  actorEmail?: string | null;
  actorIsSuperAdmin: boolean;
}

export interface AuditEntryInput extends AuditActor {
  action: string;
  targetType: string;
  targetId?: string | number | null;
  institutionId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  /** IP en claro: se guarda SOLO su hash (sha256, 16 hex). */
  ip?: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  actorId: string;
  actorEmail: string | null;
  actorIsSuperAdmin: boolean;
  action: string;
  targetType: string;
  targetId: string | null;
  institutionId: string | null;
  before: unknown;
  after: unknown;
}

export interface AuditListFilter {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  institutionId?: string;
  from?: string;
  to?: string;
  cursor?: string | number;
  limit?: number;
}

export type Queryable = { query: (sql: string, params?: any[]) => Promise<any> };

/** Id del actor «sistema» (backfill, reconciliador, jobs) — no es un usuario. */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

const SECRET_KEY_RE = /pass(word)?|secret|token|api[-_]?key|authorization|service[-_]?role|credential|cookie|jwt/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Redacta recursivamente valores cuya CLAVE parece secreta. Puro; no muta la entrada. */
export function scrubSecrets(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 8) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => scrubSecrets(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : scrubSecrets(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 4000) return value.slice(0, 4000) + '…';
  return value;
}

export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(String(process.env.R75_AUDIT_IP_SALT || 'cursia-r75') + '|' + ip).digest('hex').slice(0, 16);
}

function mapRow(r: any): AuditEntry {
  return {
    id: Number(r.id),
    at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
    actorId: r.actor_id,
    actorEmail: r.actor_email ?? null,
    actorIsSuperAdmin: r.actor_is_superadmin === true,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id ?? null,
    institutionId: r.institution_id ?? null,
    before: r.before ?? null,
    after: r.after ?? null,
  };
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger('AuditLog');

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Escribe una entrada. Devuelve su id. Lanza si falla (una acción administrativa sin auditoría no se confirma). */
  async record(entry: AuditEntryInput, tx?: Queryable): Promise<number> {
    if (!entry.actorId || !UUID_RE.test(entry.actorId)) throw new Error('audit: actorId uuid requerido');
    if (!entry.action || !entry.targetType) throw new Error('audit: action y targetType requeridos');
    const q: Queryable = tx ?? this.dataSource;
    const before = entry.before === undefined ? null : JSON.stringify(scrubSecrets(entry.before));
    const after = entry.after === undefined ? null : JSON.stringify(scrubSecrets(entry.after));
    const instId = entry.institutionId && UUID_RE.test(entry.institutionId) ? entry.institutionId : null;
    const rows = await q.query(
      `insert into public.admin_audit_log
         (actor_id, actor_email, actor_is_superadmin, action, target_type, target_id, institution_id, before, after, request_id, ip_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
       returning id`,
      [entry.actorId, entry.actorEmail ?? null, entry.actorIsSuperAdmin === true, String(entry.action).slice(0, 120),
        String(entry.targetType).slice(0, 60), entry.targetId === undefined || entry.targetId === null ? null : String(entry.targetId).slice(0, 200),
        instId, before, after, entry.requestId ? String(entry.requestId).slice(0, 120) : null, hashIp(entry.ip)],
    );
    const list = Array.isArray(rows) ? rows : [];
    return Number(list[0]?.id ?? 0);
  }

  /** Como `record`, pero nunca lanza (para auditoría informativa: `rbac.shadow_deny`). */
  async recordSafe(entry: AuditEntryInput, tx?: Queryable): Promise<number | null> {
    try {
      return await this.record(entry, tx);
    } catch (err) {
      this.logger.warn(`auditoría no registrada (${entry.action}): ${err instanceof Error ? err.message.slice(0, 160) : 'error'}`);
      return null;
    }
  }

  /** Lista paginada por cursor (id descendente). `nextCursor` = id del último ítem si hay más. */
  async list(filter: AuditListFilter = {}): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
    const where: string[] = [];
    const params: any[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (filter.actorId) { if (!UUID_RE.test(filter.actorId)) return { items: [], nextCursor: null }; add('actor_id = ?', filter.actorId); }
    if (filter.action) add('action = ?', String(filter.action));
    if (filter.targetType) add('target_type = ?', String(filter.targetType));
    if (filter.targetId) add('target_id = ?', String(filter.targetId));
    if (filter.institutionId) { if (!UUID_RE.test(filter.institutionId)) return { items: [], nextCursor: null }; add('institution_id = ?', filter.institutionId); }
    if (filter.from) { const d = new Date(filter.from); if (!isNaN(d.getTime())) add('at >= ?', d.toISOString()); }
    if (filter.to) { const d = new Date(filter.to); if (!isNaN(d.getTime())) add('at < ?', d.toISOString()); }
    if (filter.cursor !== undefined && filter.cursor !== null && String(filter.cursor) !== '') {
      const c = Number(filter.cursor);
      if (Number.isFinite(c) && c > 0) add('id < ?', Math.floor(c));
    }
    const limit = Math.max(1, Math.min(200, Math.floor(Number(filter.limit) || 50)));
    params.push(limit + 1);
    const rows: any[] = await this.dataSource.query(
      `select id, at, actor_id, actor_email, actor_is_superadmin, action, target_type, target_id, institution_id, before, after
         from public.admin_audit_log ${where.length ? 'where ' + where.join(' and ') : ''}
        order by id desc limit $${params.length}`,
      params,
    );
    const items = rows.slice(0, limit).map(mapRow);
    return { items, nextCursor: rows.length > limit && items.length ? String(items[items.length - 1].id) : null };
  }
}
