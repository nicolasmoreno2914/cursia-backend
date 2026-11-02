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

/* ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * r83 (incidente 2026-11-02, curso 91) — conexión a Postgres resistente al pooler de Supabase lleno.
 *
 * En modo sesión el pooler admite `pool_size` (15) clientes; con 12 procesos en producción (api 3 + 11 workers × 1)
 * el margen es 1. Cuando se llena, la conexión NUEVA falla al instante con `(EMAXCONNSESSION) max clients reached in
 * session mode`. Antes: el arranque reintentaba 10 × 3 s y moría (PM2 lo reiniciaba al instante → bucle de reinicios
 * sincronizados), y en caliente cada consulta que necesitaba abrir conexión (idle 1 s en workers) fallaba de una.
 *
 * Todo lo de abajo es PURO (sin red) y, sin variables nuevas, conserva el comportamiento de siempre salvo:
 *   - arranque: errores de pooler lleno / red transitoria → backoff exponencial con jitter hasta un tope de tiempo
 *     (DB_BOOTSTRAP_RETRY_MAX_MS[_WORKER]; default api 180 s, worker 600 s) en vez de 10 × 3 s y salir;
 *     cualquier otro error (credenciales, base inexistente…) → los mismos 10 × 3 s de antes;
 *   - en caliente: SOLO al pedir conexión (la sentencia todavía no se envió → reintentar no duplica nada) y SOLO para
 *     pooler lleno / red transitoria → reintento acotado (DB_CONNECT_RETRY_MAX_MS, default 15 s; 0 = apagado).
 * Variables opcionales para pasar los workers al pooler en modo TRANSACCIÓN (puerto 6543), sin secretos nuevos:
 *   DB_HOST_WORKER / DB_PORT_WORKER (y DB_HOST_API / DB_PORT_API) — ausentes → DB_HOST / DB_PORT de siempre.
 * DB_APPLICATION_NAME (opcional) — por defecto `cursia:<entrada>:<pid>` (identifica el proceso en pg_stat_activity
 * cuando la conexión es directa o el pooler lo propaga).
 * ───────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export type DbConnectErrorKind = 'pool_exhausted' | 'transient_network' | 'local_pool_timeout' | 'other';

/** Pooler/servidor sin cupo: Supavisor sesión (EMAXCONNSESSION), transacción (EMAXCLIENTS), Postgres 53300. */
const POOL_EXHAUSTED_RE =
  /EMAXCONN|EMAXCLIENTS|max clients reached|max client connections|too many clients|remaining connection slots|too_many_connections/i;
const TRANSIENT_NET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']);
const TRANSIENT_NET_RE = /Connection terminated unexpectedly|Connection terminated due to connection timeout|server closed the connection unexpectedly|read ECONNRESET/i;
/** pg-pool: esperar un cliente del pool LOCAL (o un connect lento) superó connectionTimeoutMillis. */
const LOCAL_POOL_TIMEOUT_RE = /timeout exceeded when trying to connect/i;

export function classifyDbConnectError(err: unknown): DbConnectErrorKind {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const msg = typeof e.message === 'string' ? e.message : String(err ?? '');
  if (code === '53300' || POOL_EXHAUSTED_RE.test(msg)) return 'pool_exhausted';
  if (LOCAL_POOL_TIMEOUT_RE.test(msg)) return 'local_pool_timeout';
  if (TRANSIENT_NET_CODES.has(code) || TRANSIENT_NET_RE.test(msg)) return 'transient_network';
  return 'other';
}

/** Backoff exponencial con "equal jitter": entre la mitad y el total de min(cap, base·2^intento). */
export function backoffDelayMs(attempt: number, baseMs: number, capMs: number, rand: () => number = Math.random): number {
  const exp = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, Math.min(30, attempt))));
  const r = Math.min(1, Math.max(0, rand()));
  return Math.max(1, Math.round(exp / 2 + (r * exp) / 2));
}

export interface DbBootstrapRetryPlan {
  role: DbProcessRole;
  /** Tope total (ms) de reintentos por pooler lleno / red transitoria. */
  maxMs: number;
  baseMs: number;
  capMs: number;
  /** Otros errores: el comportamiento de siempre (TypeORM retryAttempts 10 × retryDelay 3000). */
  otherAttempts: number;
  otherDelayMs: number;
}

export function dbBootstrapRetryPlan(
  env: Record<string, string | undefined> = process.env,
  entry: string | undefined = process.argv[1],
): DbBootstrapRetryPlan {
  const role = processRoleOf(entry);
  const apiMax = intIn(env.DB_BOOTSTRAP_RETRY_MAX_MS, 0, 3_600_000) ?? 180_000;
  const maxMs = role === 'worker' ? intIn(env.DB_BOOTSTRAP_RETRY_MAX_MS_WORKER, 0, 3_600_000) ?? 600_000 : apiMax;
  return { role, maxMs, baseMs: 2_000, capMs: 30_000, otherAttempts: 10, otherDelayMs: 3_000 };
}

export interface DbAcquireRetryPlan {
  /** 0 = apagado (comportamiento previo). */
  maxMs: number;
  baseMs: number;
  capMs: number;
}

export function dbAcquireRetryPlan(env: Record<string, string | undefined> = process.env): DbAcquireRetryPlan {
  return { maxMs: intIn(env.DB_CONNECT_RETRY_MAX_MS, 0, 120_000) ?? 15_000, baseMs: 250, capMs: 4_000 };
}

/** Host/puerto por rol (para mandar los workers al pooler en modo transacción). Ausentes → null (usar DB_HOST/DB_PORT). */
export function dbConnectionOverrides(
  env: Record<string, string | undefined> = process.env,
  entry: string | undefined = process.argv[1],
): { role: DbProcessRole; host: string | null; port: number | null } {
  const role = processRoleOf(entry);
  const sfx = role === 'worker' ? 'WORKER' : 'API';
  const hostRaw = env[`DB_HOST_${sfx}`];
  const host = hostRaw !== undefined && String(hostRaw).trim() !== '' ? String(hostRaw).trim() : null;
  const port = intIn(env[`DB_PORT_${sfx}`], 1, 65_535);
  return { role, host, port };
}

/** application_name del proceso (≤ 63 bytes, sin secretos): `cursia:<entrada>:<pid>`. */
export function dbApplicationName(
  env: Record<string, string | undefined> = process.env,
  entry: string | undefined = process.argv[1],
  pid: number = process.pid,
): string {
  const explicit = env.DB_APPLICATION_NAME;
  const base = explicit !== undefined && String(explicit).trim() !== ''
    ? String(explicit).trim()
    : `cursia:${String(entry || 'node').split(/[\\/]/).pop()!.replace(/\.(js|ts)$/, '') || 'node'}:${pid}`;
  return base.replace(/[^\x20-\x7e]/g, '?').slice(0, 63);
}
