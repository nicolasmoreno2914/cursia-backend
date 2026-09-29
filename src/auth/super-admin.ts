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
