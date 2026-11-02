// ─────────────────────────────────────────────────────────────────────────────
// r83 (incidente curso 91, 2026-11-02): breaker de INFRAESTRUCTURA de Supabase Storage.
//
// Durante 70 min Storage respondió 504 a toda subida. Los workers siguieron reclamando partes, pagando proveedores
// (Claude, TTS) cuyo resultado no se podía guardar y quemando intentos/rondas del auto-heal. Regla nueva:
//  - cada `StorageUnavailableError` (una operación que agotó sus ~100 s de reintentos; artifacts/storage-resilience.ts)
//    se REGISTRA en public.infra_health (estado compartido: los workers son procesos pm2 separados);
//  - N fallos (STORAGE_BREAKER_THRESHOLD, 2) dentro de la ventana (STORAGE_BREAKER_WINDOW_SECONDS, 600 s) → ABIERTO;
//  - abierto: el claim de los workers del servidor (video, proveedores, IA, empaque) no entrega nada — se corta ANTES
//    de cualquier llamada pagada; los items en vuelo que fallan por Storage vuelven a `retrying` SIN consumir intento
//    (scheduler.failItemDetailed + storageOutageGrantDecision) con next_retry_at = la próxima sonda;
//  - sonda barata (PUT upsert de ~40 bytes + DELETE en qa-internal/storage-probe/) con espera 30 → 60 → 120 → 240 →
//    300 s (+0…20 % de jitter); la corre el primer claim que encuentra la sonda vencida (UPDATE atómico: un solo
//    proceso por sonda). Storage responde → CERRADO y los items retenidos se liberan (next_retry_at = now()).
//  - sin la tabla (migración r83 no aplicada, p.ej. producción) todo es no-op: comportamiento anterior.
// Kill-switch: STORAGE_BREAKER_ENABLED=false.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from 'crypto';

export const STORAGE_BREAKER_COMPONENT = 'supabase_storage';
export const STORAGE_HOLD_REASON = 'storage_unavailable';
/** Esperas entre sondas (s); el último valor se repite. */
export const STORAGE_PROBE_WAITS_SECONDS: readonly number[] = Object.freeze([30, 60, 120, 240, 300]);
export const STORAGE_PROBE_JITTER_RATIO = 0.2;

export interface StorageBreakerConfig {
  enabled: boolean;
  threshold: number;
  windowSeconds: number;
  /** Tope de reintentos sin consumir intento por item y racha (después: comportamiento normal). */
  maxFreeRetries: number;
  /** Duración máxima de una racha de esperas sin consumir intento por item (h). */
  maxHours: number;
}

function num(v: unknown, def: number, min: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : def;
}

export function storageBreakerConfigFromEnv(env: Record<string, string | undefined> = process.env): StorageBreakerConfig {
  return {
    enabled: String(env.STORAGE_BREAKER_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    threshold: Math.floor(num(env.STORAGE_BREAKER_THRESHOLD, 2, 1)),
    windowSeconds: num(env.STORAGE_BREAKER_WINDOW_SECONDS, 600, 1),
    maxFreeRetries: Math.floor(num(env.STORAGE_OUTAGE_MAX_FREE_RETRIES, 60, 0)),
    maxHours: num(env.STORAGE_OUTAGE_MAX_HOURS, 24, 0),
  };
}

export interface StorageBreakerRow {
  component: string;
  state: 'closed' | 'open';
  failures: number;
  window_started_at: Date | string | null;
  opened_at: Date | string | null;
  last_failure_at: Date | string | null;
  next_probe_at: Date | string | null;
  probe_round: number;
  last_probe_at: Date | string | null;
  last_probe_ok_at: Date | string | null;
  last_error: string | null;
}

function ms(v: Date | string | null | undefined): number | null {
  if (!v) return null;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Espera (s) antes de la sonda `round` (0 = la primera), jitter +0…20 % (nunca antes). */
export function storageProbeWaitSeconds(round: number, random: () => number = Math.random): number {
  const list = STORAGE_PROBE_WAITS_SECONDS;
  const base = list[Math.min(Math.max(0, Math.floor(round)), list.length - 1)];
  return base * (1 + STORAGE_PROBE_JITTER_RATIO * random());
}

/** Estado tras registrar un fallo (puro). */
export function breakerAfterFailure(
  prev: StorageBreakerRow | null,
  nowMs: number,
  cfg: StorageBreakerConfig,
  error: string,
  random: () => number = Math.random,
): StorageBreakerRow {
  const base: StorageBreakerRow = prev ?? {
    component: STORAGE_BREAKER_COMPONENT, state: 'closed', failures: 0, window_started_at: null, opened_at: null, last_failure_at: null,
    next_probe_at: null, probe_round: 0, last_probe_at: null, last_probe_ok_at: null, last_error: null,
  };
  const now = new Date(nowMs);
  const err = String(error ?? '').slice(0, 300);
  if (base.state === 'open') {
    // Ya abierto: los fallos de items en vuelo no adelantan ni atrasan la sonda.
    return { ...base, failures: base.failures + 1, last_failure_at: now, last_error: err };
  }
  const ws = ms(base.window_started_at);
  const inWindow = ws !== null && nowMs - ws <= cfg.windowSeconds * 1000;
  const failures = inWindow ? base.failures + 1 : 1;
  const next: StorageBreakerRow = {
    ...base, failures, window_started_at: inWindow ? base.window_started_at : now, last_failure_at: now, last_error: err,
  };
  if (failures >= cfg.threshold) {
    return { ...next, state: 'open', opened_at: now, probe_round: 0, next_probe_at: new Date(nowMs + storageProbeWaitSeconds(0, random) * 1000) };
  }
  return next;
}

/**
 * ¿Este fallo de Storage de un item se reintenta SIN consumir intento? (puro). Racha por item en
 * output_summary.storageOutage = { grants, firstAt, lastAt }: una racha nueva empieza si la anterior terminó hace
 * más de 1 h. Tope: maxFreeRetries esperas o maxHours desde el primer fallo de la racha → comportamiento normal
 * (consume intento; nunca un bucle infinito).
 */
export function storageOutageGrantDecision(
  prev: { grants?: number; firstAt?: string; lastAt?: string } | null | undefined,
  nowMs: number,
  cfg: StorageBreakerConfig,
): { grant: boolean; next: { grants: number; firstAt: string; lastAt: string } } {
  const nowIso = new Date(nowMs).toISOString();
  const last = ms(prev?.lastAt ?? null);
  const fresh = !prev || last === null || nowMs - last > 3_600_000;
  const grants = fresh ? 0 : Math.max(0, Math.floor(Number(prev?.grants) || 0));
  const firstAt = fresh ? nowIso : String(prev?.firstAt || nowIso);
  const first = ms(firstAt) ?? nowMs;
  const grant = cfg.enabled && grants < cfg.maxFreeRetries && nowMs - first <= cfg.maxHours * 3_600_000;
  return { grant, next: { grants: grant ? grants + 1 : grants, firstAt, lastAt: nowIso } };
}

// ─── Persistencia (public.infra_health) ──────────────────────────────────────

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<any>;
}
/** Una transacción: `fn` recibe un Queryable dentro de BEGIN…COMMIT. */
export type TxRunner = <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>;

export interface StorageBreakerDb {
  query: Queryable['query'];
  tx: TxRunner;
}

/** DataSource / EntityManager de TypeORM → StorageBreakerDb. */
export function storageBreakerDbOf(ds: { query: Queryable['query']; transaction?: (fn: (m: Queryable) => Promise<any>) => Promise<any> } | null | undefined): StorageBreakerDb | null {
  if (!ds || typeof ds.query !== 'function' || typeof ds.transaction !== 'function') return null;
  return { query: ds.query.bind(ds), tx: (fn) => ds.transaction!((m) => fn(m)) };
}

function rowsOf(r: any): any[] {
  if (Array.isArray(r) && Array.isArray(r[0])) return r[0];
  return Array.isArray(r) ? r : [];
}

/** Tabla ausente (42P01) o columna ausente (42703): breaker inerte por 5 min en este proceso (sin spam). */
let missingUntilMs = 0;
function isMissingSchema(err: unknown): boolean {
  const code = (err as { code?: string; driverError?: { code?: string } } | null)?.code ?? (err as any)?.driverError?.code;
  return code === '42P01' || code === '42703' || /relation "public\.infra_health" does not exist|infra_health.*does not exist/i.test(String((err as Error)?.message ?? ''));
}
function schemaMissing(nowMs: number): boolean {
  return nowMs < missingUntilMs;
}
function noteSchemaError(err: unknown, nowMs: number): boolean {
  if (!isMissingSchema(err)) return false;
  missingUntilMs = nowMs + 300_000;
  return true;
}
/** Tests: olvidar el estado «tabla ausente». */
export function resetStorageBreakerProcessState(): void {
  missingUntilMs = 0;
}

const COLS = `component, state, failures, window_started_at, opened_at, last_failure_at, next_probe_at, probe_round,
              last_probe_at, last_probe_ok_at, last_error`;

export async function readStorageBreaker(q: Queryable): Promise<StorageBreakerRow | null> {
  const [row] = rowsOf(await q.query(`select ${COLS} from public.infra_health where component = $1`, [STORAGE_BREAKER_COMPONENT]));
  return row ? ({ ...row, failures: Number(row.failures) || 0, probe_round: Number(row.probe_round) || 0 } as StorageBreakerRow) : null;
}

export interface BreakerLogger {
  warn(msg: string): void;
  log?(msg: string): void;
  error?(msg: string): void;
}

/**
 * Registra un fallo de Storage (una operación que agotó sus reintentos). Nunca lanza (el error original es el que
 * importa): sin tabla / sin DB → no-op. Devuelve el estado nuevo (null si no se pudo registrar).
 */
export async function recordStorageFailure(
  db: StorageBreakerDb | null,
  error: string,
  opts: { cfg?: StorageBreakerConfig; nowMs?: number; logger?: BreakerLogger; random?: () => number } = {},
): Promise<StorageBreakerRow | null> {
  const cfg = opts.cfg ?? storageBreakerConfigFromEnv();
  const nowMs = opts.nowMs ?? Date.now();
  if (!db || !cfg.enabled || schemaMissing(nowMs)) return null;
  try {
    return await db.tx(async (q) => {
      await q.query(`insert into public.infra_health (component) values ($1) on conflict (component) do nothing`, [STORAGE_BREAKER_COMPONENT]);
      const [cur] = rowsOf(await q.query(`select ${COLS} from public.infra_health where component = $1 for update`, [STORAGE_BREAKER_COMPONENT]));
      const prev = cur ? ({ ...cur, failures: Number(cur.failures) || 0, probe_round: Number(cur.probe_round) || 0 } as StorageBreakerRow) : null;
      const next = breakerAfterFailure(prev, nowMs, cfg, error, opts.random);
      await q.query(
        `update public.infra_health
            set state = $2, failures = $3, window_started_at = $4, opened_at = $5, last_failure_at = $6, next_probe_at = $7,
                probe_round = $8, last_error = $9, updated_at = now()
          where component = $1`,
        [STORAGE_BREAKER_COMPONENT, next.state, next.failures, next.window_started_at, next.opened_at, next.last_failure_at,
          next.next_probe_at, next.probe_round, next.last_error],
      );
      if (prev?.state !== 'open' && next.state === 'open') {
        opts.logger?.error?.(`[storage-breaker] ABIERTO: ${next.failures} fallos de Supabase Storage en ${cfg.windowSeconds} s — los workers dejan de reclamar trabajo; primera sonda ${new Date(ms(next.next_probe_at)!).toISOString()}`);
      }
      return next;
    });
  } catch (err) {
    if (!noteSchemaError(err, nowMs)) opts.logger?.warn(`[storage-breaker] no se pudo registrar el fallo: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    return null;
  }
}

export interface StorageProbeResult {
  /** Storage RESPONDE (2xx, o un 4xx determinista: está arriba aunque rechace). */
  ok: boolean;
  status: number | null;
  error?: string | null;
}
export type StorageProbe = () => Promise<StorageProbeResult>;

/**
 * Sonda real: PUT (upsert) de un JSON mínimo en `qa-internal/storage-probe/<proceso>.json` del bucket de artifacts y
 * DELETE del mismo objeto. Un intento por paso, timeout 10 s. 5xx/429/408/red/timeout → caído; cualquier otra
 * respuesta → Storage responde. Nunca registra artifacts ni toca objetos de usuarios.
 */
export function supabaseStorageProbe(
  env: { supabaseUrl?: string | null; serviceKey?: string | null; bucket?: string },
  fetchImpl: typeof fetch = fetch,
): StorageProbe | null {
  const base = String(env.supabaseUrl ?? '').replace(/\/$/, '');
  const key = String(env.serviceKey ?? '');
  if (!base || !key) return null;
  const bucket = env.bucket ?? 'cursia-artifacts';
  const objectPath = `qa-internal/storage-probe/${randomUUID()}.json`;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const down = (s: number) => s === 408 || s === 429 || s >= 500;
  return async () => {
    const url = `${base}/storage/v1/object/${bucket}/${objectPath}`;
    try {
      const put = await fetchImpl(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'x-upsert': 'true' },
        body: JSON.stringify({ probe: 'storage-breaker', at: new Date().toISOString() }),
        signal: AbortSignal.timeout(10_000),
      });
      try { await put.text(); } catch { /* sin cuerpo */ }
      if (down(put.status)) return { ok: false, status: put.status };
      const del = await fetchImpl(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (del) { try { await del.text(); } catch { /* sin cuerpo */ } }
      if (del && down(del.status)) return { ok: false, status: del.status };
      return { ok: true, status: put.status };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      return { ok: false, status: null, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? err).slice(0, 120) };
    }
  };
}

/** Sonda desde el entorno del proceso (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). */
export function storageProbeFromEnv(env: Record<string, string | undefined> = process.env): StorageProbe | null {
  return supabaseStorageProbe({ supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY });
}

/** SQL: items retenidos por la caída de Storage → elegibles ya (al cerrar el breaker). */
export const RELEASE_STORAGE_HELD_ITEMS_SQL = `update public.generation_item_runs
    set next_retry_at = now(), updated_at = now()
  where status = 'retrying' and next_retry_at > now() and error like '%storage_unavailable: Supabase Storage%'`;

export interface StorageGateResult {
  /** true = no entregar trabajo que suba a Storage. */
  hold: boolean;
  reason?: typeof STORAGE_HOLD_REASON;
  nextProbeAt?: Date | null;
  /** Esta llamada corrió la sonda (resultado). */
  probed?: StorageProbeResult;
  /** Esta llamada cerró el breaker. */
  closed?: boolean;
  /** Items liberados al cerrar. */
  released?: number;
}

/**
 * Compuerta del claim de los workers del servidor. Cerrado (o sin tabla) → { hold:false } con UNA lectura por PK.
 * Abierto → { hold:true } salvo que la sonda esté vencida: el primero que la toma (UPDATE atómico que corre la
 * próxima sonda) la ejecuta; OK → cierra, libera los items retenidos y deja pasar el claim. Nunca lanza (un error
 * de DB se trata como «sin breaker»: el claim sigue como antes).
 */
export async function storageClaimGate(
  db: StorageBreakerDb | null,
  probe: StorageProbe | null,
  opts: { cfg?: StorageBreakerConfig; nowMs?: number; logger?: BreakerLogger; random?: () => number } = {},
): Promise<StorageGateResult> {
  const cfg = opts.cfg ?? storageBreakerConfigFromEnv();
  const nowMs = opts.nowMs ?? Date.now();
  if (!db || !cfg.enabled || schemaMissing(nowMs)) return { hold: false };
  try {
    const row = await readStorageBreaker(db);
    if (!row || row.state !== 'open') return { hold: false };
    const due = ms(row.next_probe_at);
    if (due !== null && due > nowMs) return { hold: true, reason: STORAGE_HOLD_REASON, nextProbeAt: new Date(due) };
    if (!probe) {
      // Sin credenciales para sondear en este proceso: espera a otro proceso que sí pueda (o al cierre manual).
      return { hold: true, reason: STORAGE_HOLD_REASON, nextProbeAt: due !== null ? new Date(due) : null };
    }
    // Toma atómica de la sonda: solo un proceso por vencimiento.
    const nextWait = storageProbeWaitSeconds(row.probe_round + 1, opts.random);
    const taken = rowsOf(await db.query(
      `update public.infra_health
          set next_probe_at = $2::timestamptz + make_interval(secs => $3), probe_round = probe_round + 1, last_probe_at = $2::timestamptz, updated_at = now()
        where component = $1 and state = 'open' and (next_probe_at is null or next_probe_at <= $2::timestamptz)
        returning next_probe_at`,
      [STORAGE_BREAKER_COMPONENT, new Date(nowMs), nextWait],
    ));
    if (!taken.length) {
      const again = await readStorageBreaker(db);
      if (!again || again.state !== 'open') return { hold: false };
      return { hold: true, reason: STORAGE_HOLD_REASON, nextProbeAt: again.next_probe_at ? new Date(ms(again.next_probe_at)!) : null };
    }
    const result = await probe();
    if (!result.ok) {
      opts.logger?.warn(`[storage-breaker] sonda: Storage sigue caído (${result.status ?? result.error ?? 'sin respuesta'}); próxima en ${Math.round(nextWait)} s`);
      return { hold: true, reason: STORAGE_HOLD_REASON, nextProbeAt: new Date(ms(taken[0].next_probe_at) ?? nowMs + nextWait * 1000), probed: result };
    }
    const released = await db.tx(async (q) => {
      const closed = rowsOf(await q.query(
        `update public.infra_health
            set state = 'closed', failures = 0, window_started_at = null, next_probe_at = null, probe_round = 0,
                last_probe_ok_at = now(), updated_at = now()
          where component = $1 and state = 'open' returning component`,
        [STORAGE_BREAKER_COMPONENT],
      ));
      if (!closed.length) return 0;
      return rowsOf(await q.query(`${RELEASE_STORAGE_HELD_ITEMS_SQL} returning id`)).length;
    });
    opts.logger?.log?.(`[storage-breaker] CERRADO: Storage responde (sonda ${result.status}); ${released} parte(s) retenida(s) liberada(s)`);
    return { hold: false, probed: result, closed: true, released };
  } catch (err) {
    if (!noteSchemaError(err, nowMs)) opts.logger?.warn(`[storage-breaker] compuerta sin efecto (error de DB): ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    return { hold: false };
  }
}

/** Próxima sonda si el breaker está abierto (para el retryAfter de un item); null si cerrado / sin tabla. Nunca lanza. */
export async function storageBreakerNextProbe(db: Queryable | null, nowMs: number = Date.now()): Promise<{ open: boolean; nextProbeAt: Date | null }> {
  if (!db || schemaMissing(nowMs)) return { open: false, nextProbeAt: null };
  try {
    const row = await readStorageBreaker(db);
    if (!row || row.state !== 'open') return { open: false, nextProbeAt: null };
    const t = ms(row.next_probe_at);
    return { open: true, nextProbeAt: t !== null ? new Date(t) : null };
  } catch (err) {
    noteSchemaError(err, nowMs);
    return { open: false, nextProbeAt: null };
  }
}

/** Espera (s) del próximo intento de un item retenido por Storage: hasta la sonda (abierto) o 60 s (cerrado). */
export function storageHeldRetryAfterSeconds(b: { open: boolean; nextProbeAt: Date | null }, nowMs: number = Date.now()): number {
  if (b.open && b.nextProbeAt) return Math.max(30, Math.ceil((b.nextProbeAt.getTime() - nowMs) / 1000) + 5);
  return 60;
}
