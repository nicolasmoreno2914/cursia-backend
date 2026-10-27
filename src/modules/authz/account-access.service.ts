import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { emailVerifiedClaim } from '../../auth/super-admin';
import { columnExists, tableExists, QueryFn } from './schema-probe';

/**
 * r75 B1 (H1) · ¿La cuenta del JWT puede usar la API? Server-side, con la allow-list de plataforma `authorized_users`
 * (antes solo la aplicaba el navegador) y la suspensión de cuenta (`user_suspensions`, tabla de A; opcional).
 *
 * Orden (01 §2.3 paso 1):
 *   1. SuperAdmin (env, identidad ya verificada por SupabaseJwtGuard) → activa (no depende de una fila de la base).
 *   2. Fila de `authorized_users`: por `user_id` (si la columna existe) o por email cuando `user_id` es null.
 *      Por email exige el email confirmado (`auth.users.email_confirmed_at`; si `auth.users` no se puede leer, el
 *      claim del JWT no puede ser `false`). Sin fila → `not_authorized`.
 *      `status` (si la columna existe): `suspended` → `suspended`; vacío / `active` → activa; otro → `not_authorized`.
 *   3. `user_suspensions` activa de tipo `account` → `suspended`.
 * Base caída / tabla ausente → `unavailable` (el guard falla CERRADO en enforce: 503, nunca deja pasar).
 * Caché por usuario 30 s (D-11), invalidable (`invalidate`) al escribir por la API.
 */
export type AccountStatus = 'active' | 'suspended' | 'not_authorized' | 'unavailable';

export interface AccountDecision {
  status: AccountStatus;
  via: 'superadmin' | 'user_id' | 'email' | 'none' | 'error';
  reason?: string;
}

export const ACCOUNT_CACHE_TTL_MS = 30_000;

@Injectable()
export class AccountAccessService {
  private readonly logger = new Logger('AccountAccess');
  private readonly cache = new Map<string, { exp: number; d: AccountDecision }>();

  constructor(@Optional() private readonly dataSource?: DataSource) {}

  private get query(): QueryFn | null {
    const ds = this.dataSource;
    return ds && typeof ds.query === 'function' ? (sql, params) => ds.query(sql, params as any[]) : null;
  }

  invalidate(userId?: string): void {
    if (userId) this.cache.delete(String(userId).toLowerCase());
    else this.cache.clear();
  }

  async evaluate(user: { id: string; email?: string | null; raw?: Record<string, any> }, env: NodeJS.ProcessEnv = process.env): Promise<AccountDecision> {
    const key = String(user.id || '').toLowerCase();
    if (!key) return { status: 'not_authorized', via: 'none', reason: 'sin sub' };
    if (isSuperAdminEmail(user.email ?? null, env)) return { status: 'active', via: 'superadmin' };
    const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.d;
    const d = await this.compute(user);
    // `unavailable` no se cachea (la próxima request reintenta).
    if (d.status !== 'unavailable') this.cache.set(key, { exp: Date.now() + ACCOUNT_CACHE_TTL_MS, d });
    return d;
  }

  private async compute(user: { id: string; email?: string | null; raw?: Record<string, any> }): Promise<AccountDecision> {
    const q = this.query;
    if (!q) return { status: 'unavailable', via: 'error', reason: 'sin base de datos' };
    try {
      if (!(await tableExists(q, 'authorized_users'))) return { status: 'unavailable', via: 'error', reason: 'authorized_users no existe' };
      const hasUserId = await columnExists(q, 'authorized_users', 'user_id');
      const hasStatus = await columnExists(q, 'authorized_users', 'status');
      const email = String(user.email ?? '').trim().toLowerCase();
      const rows = await q(
        `select ${hasUserId ? 'user_id::text' : 'null::text'} as user_id, lower(email) as email${hasStatus ? ', status' : ', null::text as status'}
           from public.authorized_users
          where ${hasUserId ? 'user_id::text = $1::text or ' : '$1::text is not null and '}(${hasUserId ? 'user_id is null and ' : ''}$2::text <> '' and lower(email) = $2::text)
          limit 5`,
        [user.id, email],
      );
      const byId = hasUserId ? rows.find((r: any) => r.user_id && String(r.user_id).toLowerCase() === String(user.id).toLowerCase()) : null;
      const byEmail = rows.find((r: any) => !r.user_id && r.email === email);
      const row = byId ?? byEmail ?? null;
      if (!row) return { status: 'not_authorized', via: 'none', reason: 'sin fila en authorized_users' };
      const via: AccountDecision['via'] = byId ? 'user_id' : 'email';
      if (via === 'email') {
        const problem = await this.emailUnconfirmed(q, user);
        if (problem) return { status: 'not_authorized', via, reason: problem };
      }
      const st = String(row.status ?? '').trim().toLowerCase();
      if (st === 'suspended') return { status: 'suspended', via, reason: 'authorized_users.status=suspended' };
      if (st && st !== 'active') return { status: 'not_authorized', via, reason: `authorized_users.status=${st.slice(0, 20)}` };
      if (await tableExists(q, 'user_suspensions')) {
        const [s] = await q(
          `select 1 as x from public.user_suspensions where user_id::text = $1 and kind = 'account' and lifted_at is null limit 1`,
          [user.id],
        );
        if (s) return { status: 'suspended', via, reason: 'suspensión de cuenta activa' };
      }
      return { status: 'active', via };
    } catch (err) {
      this.logger.warn(`no se pudo evaluar la cuenta ${user.id}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
      return { status: 'unavailable', via: 'error', reason: 'error de base' };
    }
  }

  /** Coincidencia por email (fila sin user_id): el email del token tiene que estar confirmado. null = ok. */
  private async emailUnconfirmed(q: QueryFn, user: { id: string; email?: string | null; raw?: Record<string, any> }): Promise<string | null> {
    let row: any = null;
    try {
      [row] = await q(`select email, email_confirmed_at is not null as confirmed from auth.users where id::text = $1`, [user.id]);
    } catch {
      row = null; // auth.users ilegible (base local / permisos): se usa el claim
    }
    if (row) {
      if (row.confirmed !== true) return 'email sin confirmar';
      if (row.email && String(row.email).trim().toLowerCase() !== String(user.email ?? '').trim().toLowerCase()) return 'el email del token no coincide con el de la cuenta';
      return null;
    }
    return emailVerifiedClaim(user.raw) === false ? 'email sin confirmar (claim)' : null;
  }
}
