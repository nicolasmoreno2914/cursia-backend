/**
 * Rol SuperAdmin: email del JWT dentro de SUPER_ADMIN_EMAILS (lista separada
 * por comas). Sin lista configurada → nadie (fail-secure). Lo usan
 * SuperAdminGuard y los flujos que deciden "¿puede aprobar?" server-side.
 */
export function superAdminEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isSuperAdminEmail(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!email || typeof email !== 'string') return false;
  return superAdminEmails(env).includes(email.trim().toLowerCase());
}

/**
 * r58 (AU3 §J9): el rol SuperAdmin se decide por el EMAIL del JWT. Si los registros de staging están abiertos y la
 * confirmación de email apagada, cualquiera podía registrar un email de admin todavía no registrado en ese proyecto y
 * ser SuperAdmin. Ahora un JWT con un email de SUPER_ADMIN_EMAILS solo pasa si:
 *   1. (opcional) su `sub` está en SUPER_ADMIN_USER_IDS (coma) cuando esa lista está configurada (anclaje por usuario:
 *      lo único que también cierra el caso «confirmación de email apagada», que auto-confirma el email);
 *   2. el email está VERIFICADO: `auth.users.email_confirmed_at` no nulo (autoritativo, leído de la base); si la base no
 *      se puede leer, el claim `user_metadata.email_verified` / `email_verified` explícitamente true.
 * Si no → 403 `admin_email_unverified` (la cuenta no entra, ni como dueña: un email de admin sin verificar es sospechoso).
 * Escape explícito: SUPER_ADMIN_EMAIL_VERIFICATION=off (solo el anclaje por id, si está configurado). Default: requerido.
 */
export const ADMIN_EMAIL_UNVERIFIED = 'admin_email_unverified';

export function superAdminUserIds(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const ids = String(env.SUPER_ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return ids.length ? ids : null;
}

export function superAdminEmailVerificationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|false|0|no)$/i.test(String(env.SUPER_ADMIN_EMAIL_VERIFICATION ?? '').trim());
}

/** Claim de verificación del JWT: true / false explícitos, o null si no viene. Puro. */
export function emailVerifiedClaim(payload: Record<string, any> | null | undefined): boolean | null {
  const p = payload || {};
  const um = p.user_metadata && typeof p.user_metadata === 'object' ? p.user_metadata : {};
  const vals = [p.email_verified, um.email_verified].filter((v) => typeof v === 'boolean') as boolean[];
  if (vals.includes(false)) return false;
  if (vals.includes(true)) return true;
  return null;
}

export type EmailConfirmedLookup = (userId: string) => Promise<{ confirmed: boolean; email: string | null } | null>;

/**
 * Decide si un JWT con email de admin puede ejercer el rol. → null = ok (o no es email de admin); si no, el motivo.
 * `lookup` = lectura de auth.users (null si la base no está disponible / sin permisos → se usa el claim).
 */
export async function adminIdentityProblem(
  user: { id: string; email: string; raw?: Record<string, any> },
  lookup: EmailConfirmedLookup | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (!isSuperAdminEmail(user.email, env)) return null;
  const pinned = superAdminUserIds(env);
  if (pinned && !pinned.includes(String(user.id || '').toLowerCase())) return 'el usuario no está en SUPER_ADMIN_USER_IDS';
  if (!superAdminEmailVerificationRequired(env)) return null;
  let row: { confirmed: boolean; email: string | null } | null = null;
  if (lookup) {
    try { row = await lookup(user.id); } catch { row = null; }
  }
  if (row) {
    if (!row.confirmed) return 'email sin confirmar (auth.users.email_confirmed_at)';
    if (row.email && row.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) return 'el email del token no coincide con el de la cuenta';
    return null;
  }
  return emailVerifiedClaim(user.raw) === true ? null : 'no se pudo verificar que el email esté confirmado';
}
