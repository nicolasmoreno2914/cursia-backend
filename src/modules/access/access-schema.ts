import { Queryable } from './audit-log.service';

/**
 * r75 · A — ¿está aplicada la migración r75-access en esta base? (producción NO la tiene en r75).
 * Caché por proceso de 60 s para los positivos y 10 s para los negativos (barato y tolera aplicar la migración en caliente).
 */
let cache: { at: number; ok: boolean } | null = null;

export async function r75AccessSchemaPresent(q: Queryable): Promise<boolean> {
  const now = Date.now();
  if (cache && now - cache.at < (cache.ok ? 60_000 : 10_000)) return cache.ok;
  let ok = false;
  try {
    const rows: any[] = await q.query(
      `select to_regclass('public.institution_memberships') is not null
          and to_regclass('public.user_suspensions') is not null
          and to_regclass('public.admin_audit_log') is not null
          and to_regclass('public.platform_controls') is not null
          and to_regclass('public.institution_permission_overrides') is not null as ok`,
    );
    ok = rows?.[0]?.ok === true;
  } catch {
    ok = false;
  }
  cache = { at: now, ok };
  return ok;
}

export function resetR75AccessSchemaCacheForTests(): void { cache = null; }

/** ¿Se puede leer auth.users? (staging: sí, con el rol del backend; base local: solo si hay stub). Caché 5 min. */
let authCache: { at: number; ok: boolean } | null = null;
export async function authUsersReadable(q: Queryable): Promise<boolean> {
  const now = Date.now();
  if (authCache && now - authCache.at < 300_000) return authCache.ok;
  let ok = false;
  try {
    const rows: any[] = await q.query(`select to_regclass('auth.users') is not null as ok`);
    if (rows?.[0]?.ok === true) { await q.query(`select 1 from auth.users limit 1`); ok = true; }
  } catch {
    ok = false;
  }
  authCache = { at: now, ok };
  return ok;
}
export function resetAuthUsersReadableCacheForTests(): void { authCache = null; }

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function normEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}

export function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** UPDATE/DELETE … RETURNING vía DataSource/EntityManager.query → [rows, count]; SELECT/INSERT → rows. */
export function rowsOf(result: any): any[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0];
  return Array.isArray(result) ? result : [];
}
