/**
 * r75 · Flags de despliegue (D-1). Default `off` = comportamiento actual (dueño único, sin allow-list en el servidor).
 *   CURSIA_ACCOUNT_GUARD = off | shadow | enforce  (allow-list `authorized_users` + suspensión de cuenta)
 *   CURSIA_RBAC_MODE     = off | shadow | enforce  (@RequirePermission / PermissionGuard)
 * Un valor desconocido se trata como `off` y se avisa (nunca enforce por un typo; nunca rompe el arranque).
 */
export type AuthzMode = 'off' | 'shadow' | 'enforce';

function parseMode(raw: unknown): AuthzMode | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'shadow') return 'shadow';
  if (v === 'enforce' || v === 'on' || v === 'true') return 'enforce';
  return null;
}

const warned = new Set<string>();
function readMode(key: string, env: NodeJS.ProcessEnv, warn?: (m: string) => void): AuthzMode {
  const m = parseMode(env[key]);
  if (m) return m;
  const msg = `${key}=${JSON.stringify(String(env[key]).slice(0, 40))} no es off|shadow|enforce: se usa off`;
  if (warn && !warned.has(msg)) { warned.add(msg); warn(msg); }
  return 'off';
}

export function accountGuardMode(env: NodeJS.ProcessEnv = process.env, warn?: (m: string) => void): AuthzMode {
  return readMode('CURSIA_ACCOUNT_GUARD', env, warn);
}

export function rbacMode(env: NodeJS.ProcessEnv = process.env, warn?: (m: string) => void): AuthzMode {
  return readMode('CURSIA_RBAC_MODE', env, warn);
}
