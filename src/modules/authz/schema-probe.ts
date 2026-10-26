/**
 * r75 · Detección (con caché) de tablas / columnas opcionales: las tablas de A (`institution_memberships`,
 * `user_suspensions`, …) y las columnas nuevas (`authorized_users.user_id`, `institutions.status`) pueden no existir
 * todavía (B1 se mergea antes que A1). Sin la tabla → la parte que depende de ella no aplica (nunca un 500).
 */
export type QueryFn = (sql: string, params?: unknown[]) => Promise<any[]>;

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: boolean }>();

export function resetSchemaProbeCacheForTests(): void {
  cache.clear();
}

async function probe(query: QueryFn, key: string, sql: string, params: unknown[]): Promise<boolean> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = false;
  try {
    const rows = await query(sql, params);
    value = Array.isArray(rows) && rows.length > 0;
  } catch {
    value = false;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function tableExists(query: QueryFn, table: string): Promise<boolean> {
  return probe(query, `t:${table}`, `select 1 from information_schema.tables where table_schema = 'public' and table_name = $1`, [table]);
}

export function columnExists(query: QueryFn, table: string, column: string): Promise<boolean> {
  return probe(
    query,
    `c:${table}.${column}`,
    `select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column],
  );
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (x: unknown): x is string => typeof x === 'string' && UUID_RE.test(x.trim());
/** Id numérico de `courses` (solo dígitos; un UUID que empieza con dígitos NO lo es). */
export function numericCourseId(raw: unknown): number | null {
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
