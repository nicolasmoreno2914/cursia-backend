/**
 * V2.1 calibración #2 — tamaño del pool de Postgres POR PROCESO.
 *
 * El pooler de Supabase en modo sesión admite un número fijo de clientes (staging: 15).
 * Cada proceso (API + workers) abre su propio pool; con `max: 5` fijo, 11 procesos
 * suman 55 clientes teóricos → EMAXCONNSESSION bajo carga o durante un deploy.
 *
 * Rol del proceso: `dist/workers/*.js` (o `src/workers/*.ts`) = worker; lo demás = api.
 * Variables (enteros; ausentes → los defaults de siempre, así producción no cambia):
 *   DB_POOL_MAX              api: clientes máximos (default 5)
 *   DB_POOL_MAX_WORKER       worker: clientes máximos (default = DB_POOL_MAX o 5)
 *   DB_POOL_IDLE_MS          api: ms para soltar un cliente inactivo (default 20000)
 *   DB_POOL_IDLE_MS_WORKER   worker: idem (default = DB_POOL_IDLE_MS o 20000)
 */
export type DbProcessRole = 'api' | 'worker';

const MAX_LIMIT = 20;

export function processRoleOf(entry: string | undefined = process.argv[1]): DbProcessRole {
  return /[\\/]workers[\\/][^\\/]+\.(js|ts)$/.test(String(entry || '')) ? 'worker' : 'api';
}

function intIn(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`configuración de pool inválida: ${String(raw)} (entero ${min}..${max})`);
  return n;
}

export function dbPoolConfig(
  env: Record<string, string | undefined> = process.env,
  entry: string | undefined = process.argv[1],
): { role: DbProcessRole; max: number; idleTimeoutMillis: number } {
  const role = processRoleOf(entry);
  const apiMax = intIn(env.DB_POOL_MAX, 1, MAX_LIMIT) ?? 5;
  const apiIdle = intIn(env.DB_POOL_IDLE_MS, 100, 600_000) ?? 20_000;
  if (role === 'api') return { role, max: apiMax, idleTimeoutMillis: apiIdle };
  return {
    role,
    max: intIn(env.DB_POOL_MAX_WORKER, 1, MAX_LIMIT) ?? apiMax,
    idleTimeoutMillis: intIn(env.DB_POOL_IDLE_MS_WORKER, 100, 600_000) ?? apiIdle,
  };
}
