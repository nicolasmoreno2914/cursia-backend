/** r75 (D-1): modos de despliegue. Default `off` (comportamiento actual). Lectura en cada llamada (sin caché: barato). */
export type R75Mode = 'off' | 'shadow' | 'enforce';

function parseMode(v: string | undefined): R75Mode {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'shadow' || s === 'enforce' ? s : 'off';
}

export function rbacMode(env: NodeJS.ProcessEnv = process.env): R75Mode {
  return parseMode(env.CURSIA_RBAC_MODE);
}

export function budgetsMode(env: NodeJS.ProcessEnv = process.env): R75Mode {
  return parseMode(env.CURSIA_USER_BUDGETS);
}
