import { Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';

/**
 * r75 · A — cliente REST mínimo de la Admin API de Supabase Auth (GoTrue), con la service key del .env del SERVIDOR.
 *   - Nunca sale del backend; el FE nunca la ve (01 §4.6).
 *   - NUNCA registra en log el cuerpo de un request ni de una respuesta (pueden tener contraseñas o datos personales):
 *     solo método, ruta sin query y código HTTP.
 *   - Errores → `SupabaseAdminError.kind`, que los servicios mapean a los códigos de 02 §C.
 *   - Sin dependencias nuevas: `fetch` global (Node ≥ 18) con timeout por AbortController.
 */
export type SupabaseAdminErrorKind = 'unavailable' | 'exists' | 'invalid_email' | 'not_found' | 'error';

export class SupabaseAdminError extends Error {
  constructor(readonly kind: SupabaseAdminErrorKind, readonly status: number | null, message: string) {
    super(message);
  }
}

export interface SupabaseAuthUser {
  id: string;
  email: string | null;
  createdAt: string | null;
  lastSignInAt: string | null;
  emailConfirmedAt: string | null;
  bannedUntil: string | null;
  userMetadata: Record<string, unknown>;
}

/** Ban «indefinido» (100 años) — 01 §7. */
export const PERMANENT_BAN_DURATION = '876000h';

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%*-_';

/** Contraseña temporal de 20 caracteres (CSPRNG) con al menos una mayúscula, minúscula, dígito y símbolo. */
export function generateTempPassword(length = 20): string {
  const classes = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#%*-_'];
  const chars: string[] = classes.map((c) => c[randomInt(c.length)]);
  while (chars.length < length) chars.push(PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

function mapUser(u: any): SupabaseAuthUser {
  const x = u && typeof u === 'object' && u.user && typeof u.user === 'object' ? u.user : u;
  return {
    id: String(x?.id ?? ''),
    email: x?.email ?? null,
    createdAt: x?.created_at ?? null,
    lastSignInAt: x?.last_sign_in_at ?? null,
    emailConfirmedAt: x?.email_confirmed_at ?? x?.confirmed_at ?? null,
    bannedUntil: x?.banned_until ?? null,
    userMetadata: x?.user_metadata && typeof x.user_metadata === 'object' ? x.user_metadata : {},
  };
}

/** Clasifica una respuesta de error de GoTrue SIN conservar su cuerpo. Puro (exportado para tests). */
export function classifyAdminError(status: number, body: any): SupabaseAdminErrorKind {
  const code = String(body?.error_code ?? body?.code ?? body?.error ?? '').toLowerCase();
  const msg = String(body?.msg ?? body?.message ?? body?.error_description ?? '').toLowerCase();
  if (status === 401 || status === 403 || status >= 500) return 'unavailable';
  if (status === 404 || code === 'user_not_found') return 'not_found';
  if (code === 'email_exists' || code === 'user_already_exists' || /already (been )?registered|already exists/.test(msg)) return 'exists';
  if (code === 'email_address_invalid' || (code === 'validation_failed' && /email/.test(msg)) || /invalid.*email|email.*invalid/.test(msg)) return 'invalid_email';
  if (status === 422 && /email/.test(msg)) return 'invalid_email';
  return 'error';
}

@Injectable()
export class SupabaseAdminClient {
  private readonly logger = new Logger('SupabaseAdmin');

  /** true si hay SUPABASE_URL (https, o http://127.0.0.1 en pruebas locales) y SUPABASE_SERVICE_ROLE_KEY. */
  isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return this.config(env) !== null;
  }

  private config(env: NodeJS.ProcessEnv = process.env): { base: string; key: string } | null {
    const url = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!url || !key) return null;
    if (!/^https:\/\//i.test(url) && !/^http:\/\/127\.0\.0\.1(:\d+)?$/i.test(url)) return null;
    return { base: url, key };
  }

  private timeoutMs(): number {
    const n = Number(process.env.R75_SUPABASE_ADMIN_TIMEOUT_MS);
    return Number.isFinite(n) && n >= 1000 && n <= 60000 ? n : 10000;
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const cfg = this.config();
    if (!cfg) throw new SupabaseAdminError('unavailable', null, 'Admin API de Supabase no configurada');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs());
    let res: Response;
    try {
      res = await fetch(cfg.base + path, {
        method,
        headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      this.logger.warn(`${method} ${path.split('?')[0]} → ${aborted ? 'timeout' : 'error de red'}`);
      throw new SupabaseAdminError('unavailable', null, aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
    let parsed: any = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    if (!res.ok) {
      const kind = classifyAdminError(res.status, parsed);
      this.logger.warn(`${method} ${path.split('?')[0].replace(/[0-9a-f-]{36}/gi, ':id')} → ${res.status} (${kind})`);
      throw new SupabaseAdminError(kind, res.status, `admin api ${res.status}`);
    }
    return parsed;
  }

  /** mode 'invite': correo de invitación; el usuario fija su contraseña. */
  async inviteUser(email: string, data: Record<string, unknown>): Promise<SupabaseAuthUser> {
    return mapUser(await this.call('POST', '/auth/v1/invite', { email, data }));
  }

  /** mode 'temp_password': usuario confirmado con contraseña temporal (que el llamador devuelve UNA vez y no guarda). */
  async createUserWithPassword(email: string, password: string, userMetadata: Record<string, unknown>): Promise<SupabaseAuthUser> {
    return mapUser(await this.call('POST', '/auth/v1/admin/users', { email, password, email_confirm: true, user_metadata: userMetadata }));
  }

  async getUser(userId: string): Promise<SupabaseAuthUser> {
    return mapUser(await this.call('GET', `/auth/v1/admin/users/${encodeURIComponent(userId)}`));
  }

  /** Ban (suspensión de cuenta) / unban ('none'). */
  async setBan(userId: string, banDuration: string): Promise<void> {
    await this.call('PUT', `/auth/v1/admin/users/${encodeURIComponent(userId)}`, { ban_duration: banDuration });
  }
}
