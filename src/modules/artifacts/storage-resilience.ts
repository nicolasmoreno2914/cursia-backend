// ─────────────────────────────────────────────────────────────────────────────
// r83 (incidente curso 91, 2026-11-02): resiliencia de las llamadas a Supabase Storage.
//
// Antes cada subida era UN `fetch` sin timeout: un 504 de gateway (con su página HTML entera) terminaba en el
// mensaje del item y consumía un intento. Ahora:
//  - timeout por intento (AbortSignal, 30 s + 1 s/MB) y reintentos con backoff exponencial + jitter ante 5xx/429/
//    408, errores de red y timeouts, con un presupuesto total (~100 s por defecto) menor que la lease del worker;
//  - un 4xx determinista (permisos, 404, 413, «already exists»…) NUNCA se reintenta: se devuelve tal cual;
//  - agotado el presupuesto → `StorageUnavailableError` (code `storage_unavailable`): mensaje CORTO con el status y
//    los intentos, sin el cuerpo HTML. El scheduler lo trata como espera de infraestructura (no consume intentos) y
//    el breaker de Storage (reliability/storage-breaker.ts) deja de repartir trabajo hasta que la sonda responda.
// Puro salvo el `fetch` que recibe (los tests lo inyectan).
// ─────────────────────────────────────────────────────────────────────────────

export const STORAGE_UNAVAILABLE_CODE = 'storage_unavailable';

export type StorageOp = 'upload' | 'download' | 'head' | 'delete' | 'probe';

/**
 * Supabase Storage no respondió (5xx/429/408, red o timeout) durante todo el presupuesto de reintentos.
 * `message` = `storage_unavailable: Supabase Storage <op> failed: <status|timeout|fetch failed> (<n> intentos, <s> s)`
 * — sin HTML ni cuerpo del proveedor. Lo exportan los workers como la señal tipada de «infraestructura caída».
 */
export class StorageUnavailableError extends Error {
  readonly code = STORAGE_UNAVAILABLE_CODE;
  constructor(
    readonly op: StorageOp,
    /** Último status HTTP visto (null = red/timeout sin respuesta). */
    readonly status: number | null,
    readonly attempts: number,
    readonly elapsedMs: number,
    /** Último error de red/timeout (corto, sin secretos), si lo hubo. */
    readonly detail: string | null = null,
    /** Espera sugerida antes del próximo intento del item (s). */
    readonly retryAfterSeconds: number = 60,
  ) {
    super(storageUnavailableMessage(op, status, attempts, elapsedMs, detail));
    this.name = 'StorageUnavailableError';
  }
}

export function storageUnavailableMessage(op: StorageOp, status: number | null, attempts: number, elapsedMs: number, cause: string | null = null): string {
  // `timeout` / `fetch failed` mantienen el mensaje dentro del transitorio del empaque (PACKAGE_TRANSIENT_RE).
  const what = status !== null ? String(status) : cause && /timeout|abort/i.test(cause) ? 'timeout' : 'fetch failed';
  return `${STORAGE_UNAVAILABLE_CODE}: Supabase Storage ${op} failed: ${what} (${attempts} intentos, ${Math.round(elapsedMs / 1000)} s)`;
}

/** ¿Es (o lleva) el error tipado? Duck-typing por `code` (sobrevive a copias entre módulos/realms). */
export function isStorageUnavailableError(err: unknown): err is StorageUnavailableError {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === STORAGE_UNAVAILABLE_CODE;
}

/**
 * ¿El mensaje de fallo de un item es una caída de Storage? Acepta el código al frente o detrás de los envoltorios
 * estables de los workers (`unexpected_error: …`, `no se pudo subir el artifact <tipo>: …`, `<code>: …`). Nunca
 * acepta un mensaje de reconciliación / presupuesto / ambigüedad (esos los decide su propia regla).
 */
const STORAGE_UNAVAILABLE_MSG_RE = /(?:^|:\s)storage_unavailable:\s*Supabase Storage [a-z]+ failed:/;
const NEVER_STORAGE_WAIT_RE = /reconciliation|reconciliaci[oó]n|budget|presupuesto|ambiguous|ambiguo|pending_review|duplicate_charge/i;
export function isStorageUnavailableMessage(msg: unknown): boolean {
  const s = String(msg ?? '');
  return STORAGE_UNAVAILABLE_MSG_RE.test(s) && !NEVER_STORAGE_WAIT_RE.test(s);
}

/** Texto de error de Storage apto para un mensaje: sin etiquetas HTML, una línea, ≤ max caracteres. */
export function sanitizeStorageErrorText(text: unknown, max = 200): string {
  let s = String(text ?? '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Status que se reintentan (transitorios de gateway / sobrecarga). Cloudflare 520–524 incluidos. */
export function isRetryableStorageStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export interface StorageRetryPolicy {
  /** Presupuesto total (ms) de la operación, esperas incluidas. */
  budgetMs: number;
  /** Tope de intentos. */
  maxAttempts: number;
  /** Primera espera (ms); luego ×2 con jitter ±20 %, hasta maxDelayMs. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Timeout por intento (ms) para un cuerpo vacío; se suma 1 s por MB. */
  attemptTimeoutMs: number;
}

export const DEFAULT_STORAGE_RETRY_POLICY: StorageRetryPolicy = Object.freeze({
  budgetMs: 100_000,
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  attemptTimeoutMs: 30_000,
});

function posInt(v: unknown, def: number, min = 0): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
}

/**
 * Política desde el entorno (todas opcionales): STORAGE_RETRY_BUDGET_MS (100000), STORAGE_RETRY_MAX_ATTEMPTS (8),
 * STORAGE_RETRY_BASE_MS (1000), STORAGE_RETRY_MAX_DELAY_MS (30000), STORAGE_ATTEMPT_TIMEOUT_MS (30000).
 * STORAGE_RETRY_MAX_ATTEMPTS=1 apaga los reintentos (comportamiento anterior, salvo el timeout y el error tipado).
 */
export function storageRetryPolicyFromEnv(get: (k: string) => string | undefined = (k) => process.env[k]): StorageRetryPolicy {
  const d = DEFAULT_STORAGE_RETRY_POLICY;
  return {
    budgetMs: posInt(get('STORAGE_RETRY_BUDGET_MS'), d.budgetMs, 1),
    maxAttempts: Math.max(1, posInt(get('STORAGE_RETRY_MAX_ATTEMPTS'), d.maxAttempts, 1)),
    baseDelayMs: posInt(get('STORAGE_RETRY_BASE_MS'), d.baseDelayMs),
    maxDelayMs: posInt(get('STORAGE_RETRY_MAX_DELAY_MS'), d.maxDelayMs),
    attemptTimeoutMs: posInt(get('STORAGE_ATTEMPT_TIMEOUT_MS'), d.attemptTimeoutMs, 1),
  };
}

/** Espera antes del reintento n (1 = el primero): base·2^(n-1), tope maxDelay, jitter ±20 %. */
export function storageRetryDelayMs(n: number, policy: StorageRetryPolicy, random: () => number = Math.random): number {
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, Math.max(0, n - 1)));
  return Math.max(0, Math.round(base * (0.8 + 0.4 * random())));
}

export interface StorageRequestResult {
  response: Response;
  attempts: number;
  /** Algún intento anterior terminó AMBIGUO (5xx/timeout/red): el objeto pudo quedar escrito. */
  ambiguousBefore: boolean;
  elapsedMs: number;
}

export interface StorageRequestOptions {
  op: StorageOp;
  /** Tamaño del cuerpo (para el timeout proporcional). */
  bytes?: number;
  policy?: StorageRetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Aviso por intento fallido (logs). Nunca recibe el cuerpo de la respuesta. */
  onRetry?: (info: { attempt: number; status: number | null; error: string | null; delayMs: number }) => void;
}

function retryAfterHeaderMs(res: Response): number | null {
  const v = res.headers?.get?.('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function shortErr(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  const name = e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'timeout' : '';
  const code = e?.cause?.code ? ` ${e.cause.code}` : '';
  return sanitizeStorageErrorText(`${name || e?.message || String(err)}${code}`, 120);
}

/**
 * Ejecuta `doRequest(signal)` con timeout por intento y reintentos. Devuelve la PRIMERA respuesta no reintentable
 * (2xx o un 4xx determinista; el que llama decide qué hacer con ella). Agotado el presupuesto o los intentos →
 * StorageUnavailableError. El cuerpo de las respuestas reintentadas se descarta (nunca llega a un mensaje).
 */
export async function storageRequestWithRetry(
  doRequest: (signal: AbortSignal) => Promise<Response>,
  opts: StorageRequestOptions,
): Promise<StorageRequestResult> {
  const policy = opts.policy ?? storageRetryPolicyFromEnv();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const start = now();
  const perAttempt = policy.attemptTimeoutMs + Math.ceil((opts.bytes ?? 0) / (1024 * 1024)) * 1000;
  let attempts = 0;
  let ambiguous = false;
  let lastStatus: number | null = null;
  let lastErr: string | null = null;
  for (;;) {
    attempts++;
    const left = policy.budgetMs - (now() - start);
    const timeoutMs = Math.max(1_000, Math.min(perAttempt, left > 0 ? left : 1_000));
    let res: Response | null = null;
    try {
      res = await doRequest(AbortSignal.timeout(timeoutMs));
    } catch (err) {
      lastErr = shortErr(err);
      lastStatus = null;
    }
    let hinted: number | null = null;
    if (res) {
      if (!isRetryableStorageStatus(res.status)) return { response: res, attempts, ambiguousBefore: ambiguous, elapsedMs: now() - start };
      lastStatus = res.status;
      lastErr = null;
      hinted = retryAfterHeaderMs(res);
      // Se descarta el cuerpo (HTML del gateway): libera el socket y nunca llega a un mensaje.
      try { await res.text(); } catch { /* sin cuerpo */ }
    }
    ambiguous = true;
    const elapsed = now() - start;
    let delay = storageRetryDelayMs(attempts, policy, random);
    if (hinted !== null) delay = Math.max(delay, Math.min(hinted, policy.maxDelayMs));
    // Sin margen para otro intento útil (≥ 1 s) dentro del presupuesto → se rinde.
    if (attempts >= policy.maxAttempts || elapsed + delay + 1_000 > policy.budgetMs) {
      throw new StorageUnavailableError(opts.op, lastStatus, attempts, elapsed, lastErr);
    }
    opts.onRetry?.({ attempt: attempts, status: lastStatus, error: lastErr, delayMs: delay });
    await sleep(delay);
  }
}
