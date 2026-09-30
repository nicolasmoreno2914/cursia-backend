// ─────────────────────────────────────────────────────────────────────────────
// R16 (#1 + #15) — drenado ordenado y loop de claim de los workers dinámicos.
//
// #1: un deploy reinicia los workers. Antes, PM2 (vía `npm run`, kill_timeout
// de 1,6 s) mataba el proceso a mitad de una llamada pagada y el próximo claim
// la encontraba "en el aire" → reconciliación humana. Ahora, con SIGINT/SIGTERM:
//   1. el loop deja de reclamar (DrainSignal);
//   2. los items en vuelo terminan, o se DEVUELVEN en un punto seguro (sin gasto
//      en el aire: poll de un id ya persistido, antes de un envío pagado nuevo)
//      con `worker_draining` + un intento concedido (nunca consume max_attempts);
//   3. se espera a lo sumo DYNAMIC_WORKER_DRAIN_TIMEOUT_MS (default 270 s, por
//      debajo del kill_timeout de 300 s con el que PM2 arranca estos workers) y
//      el proceso sale.
// Nunca se corta una llamada pagada ya enviada: se espera su resultado.
//
// #15: un error de la DB al reclamar (pool agotado, conexión caída) ya no tumba
// el proceso (antes `throw err` → exit(1) → PM2 lo reiniciaba matando el item en
// vuelo): se loguea y se reintenta con backoff exponencial acotado (base = el poll
// del worker, mín. 1 s — 5 s con el default de 5000 ms —, duplicándose hasta 60 s).
// ─────────────────────────────────────────────────────────────────────────────
import { MissingSchemaBackoff } from './dynamic-worker-gate';

export const DRAIN_TIMEOUT_ENV = 'DYNAMIC_WORKER_DRAIN_TIMEOUT_MS';
/** Por debajo del kill_timeout de PM2 (DYNAMIC_WORKER_PM2_KILL_TIMEOUT_MS en deploy-staging.yml). */
export const DEFAULT_DRAIN_TIMEOUT_MS = 270_000;
/** kill_timeout con el que el deploy arranca los workers dinámicos en PM2 (ms). */
export const PM2_KILL_TIMEOUT_MS = 300_000;

/** Prefijo estable del error con el que un worker que drena devuelve un item (reanudable, sin gasto nuevo). */
export const WORKER_DRAINING = 'worker_draining';
/** Espera antes de que otro worker lo re-reclame (el reemplazo arranca en segundos). */
export const DRAIN_HANDBACK_RETRY_SECONDS = 5;

interface LoopLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function drainTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[DRAIN_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : DEFAULT_DRAIN_TIMEOUT_MS;
}

/** Señal de drenado compartida entre el loop, el handler de señales y los items en vuelo. */
export class DrainSignal {
  private requested = false;
  private resolveStopped!: () => void;
  /** Se resuelve al pedir el drenado (despierta al loop que duerme). */
  readonly stopped: Promise<void>;
  reason: string | null = null;

  constructor() {
    this.stopped = new Promise<void>((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  get isDraining(): boolean {
    return this.requested;
  }

  request(reason: string): boolean {
    if (this.requested) return false;
    this.requested = true;
    this.reason = reason;
    this.resolveStopped();
    return true;
  }
}

/** Mensaje de devolución de un item (legible en logs/admin; el prefijo es el código). */
export function drainHandbackMessage(where: string): string {
  return (
    `${WORKER_DRAINING}: el worker se reinicia (deploy/parada ordenada) y devolvió el item ${where}. ` +
    'No hay gasto en el aire: otro worker lo retoma sin reenviar lo ya pagado.'
  );
}

/**
 * Backoff exponencial acotado para errores de claim que NO son "esquema
 * ausente" (#15): base, 2·base, 4·base… hasta `maxMs`. `onOk()` lo resetea.
 */
export class ClaimErrorBackoff {
  private failures = 0;

  constructor(
    private readonly baseMs = 2_000,
    private readonly maxMs = 60_000,
  ) {}

  onError(): number {
    const ms = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(this.failures, 20));
    this.failures++;
    return ms;
  }

  onOk(): void {
    this.failures = 0;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}

export interface ClaimLoopOptions<T> {
  /** Nombre del worker (logs). */
  name: string;
  logger: LoopLogger;
  concurrency: number;
  pollMs: number;
  drain: DrainSignal;
  claim: () => Promise<T | null>;
  process: (item: T) => Promise<void>;
  describe?: (item: T) => string;
  schema?: MissingSchemaBackoff;
  claimBackoff?: ClaimErrorBackoff;
  /** Set de items en vuelo (compartido con el drenado). */
  active?: Set<Promise<void>>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Loop de claim con tope de concurrencia. Sale (sin esperar a los items en
 * vuelo: eso lo hace `awaitDrain`, con tope de tiempo) en cuanto se pide el
 * drenado; nunca reclama después de la señal. Un error de claim se loguea y
 * se reintenta con backoff (esquema ausente: backoff lento de
 * MissingSchemaBackoff; cualquier otro: ClaimErrorBackoff) — nunca lanza.
 */
export async function runClaimLoop<T>(opts: ClaimLoopOptions<T>): Promise<void> {
  const { logger, drain } = opts;
  const active = opts.active ?? new Set<Promise<void>>();
  const schema = opts.schema ?? new MissingSchemaBackoff(logger, opts.name);
  // Base = poll del worker (mín. 1 s; 5 s con DYNAMIC_*_POLL_MS por defecto) → 5, 10, 20, 40, 60, 60… s.
  const backoff = opts.claimBackoff ?? new ClaimErrorBackoff(Math.max(opts.pollMs, 1000));
  const concurrency = Math.max(1, Math.floor(opts.concurrency));
  while (!drain.isDraining) {
    let waitMs = opts.pollMs;
    while (!drain.isDraining && active.size < concurrency) {
      let item: T | null;
      try {
        item = await opts.claim();
      } catch (err) {
        const schemaWait = schema.onClaimError(err);
        if (schemaWait !== null) {
          waitMs = schemaWait;
          break;
        }
        waitMs = backoff.onError();
        logger.error(`${opts.name}: el claim falló (${errText(err)}); se reintenta en ${waitMs} ms (el worker sigue vivo)`);
        break;
      }
      schema.onClaimOk();
      backoff.onOk();
      if (!item) break;
      if (drain.isDraining) {
        // Carrera: la señal llegó mientras el claim estaba en vuelo. El item ya es de este worker:
        // se procesa (sus puntos de devolución lo entregan de vuelta sin gasto).
        logger.warn(`${opts.name}: item reclamado durante el drenado (${opts.describe ? opts.describe(item) : 'item'}) — se procesa/devuelve`);
      }
      const claimed = item;
      const promise: Promise<void> = opts
        .process(claimed)
        .catch((err) => logger.error(`${opts.name}: error no manejado en ${opts.describe ? opts.describe(claimed) : 'item'}: ${errText(err)}`))
        .finally(() => {
          active.delete(promise);
        });
      active.add(promise);
      if (active.size >= concurrency) waitMs = 500;
    }
    if (drain.isDraining) break;
    // Despierta antes si termina un item (cupo libre) o si llega la señal de drenado.
    await Promise.race([sleep(waitMs), drain.stopped, ...Array.from(active)]);
  }
}

/**
 * Espera a los items en vuelo como máximo `timeoutMs`. 'drained' si todos
 * terminaron; 'timeout' si no (el caller sale igual: PM2 lo mataría al
 * vencer su kill_timeout; el lease vencido NO consume un intento, ver
 * sweepRunExpiredLeases, y una llamada pagada que haya quedado en el aire la
 * detecta el ledger en el próximo claim).
 */
export async function awaitDrain(active: Set<Promise<void>>, timeoutMs: number): Promise<'drained' | 'timeout'> {
  if (active.size === 0) return 'drained';
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const all = (async () => {
    // Un item puede agregarse durante la espera (carrera del claim): se vuelve a mirar el set.
    while (active.size > 0) await Promise.allSettled(Array.from(active));
    return 'drained' as const;
  })();
  try {
    return await Promise.race([all, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * SIGINT/SIGTERM → drenado ordenado y salida. Un segundo aviso no hace nada
 * distinto (PM2 manda uno solo y mata al vencer kill_timeout).
 */
export function installDrainHandlers(opts: {
  name: string;
  logger: LoopLogger;
  drain: DrainSignal;
  active: Set<Promise<void>>;
  timeoutMs?: number;
  close: () => Promise<void>;
  exit?: (code: number) => void;
}): (signal: string) => Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = opts.timeoutMs ?? drainTimeoutMs();
  const onSignal = async (signal: string) => {
    if (!opts.drain.request(signal)) return;
    opts.logger.warn(
      `${opts.name}: recibido ${signal} — deja de reclamar; ${opts.active.size} item(s) en vuelo terminan o se devuelven ` +
        `(tope ${Math.round(timeoutMs / 1000)} s)`,
    );
    const r = await awaitDrain(opts.active, timeoutMs);
    if (r === 'timeout') {
      opts.logger.error(
        `${opts.name}: ${opts.active.size} item(s) siguen en vuelo tras ${Math.round(timeoutMs / 1000)} s de drenado; se sale igual ` +
          '(su lease vence sin consumir intento; un gasto en el aire lo detecta el ledger en el próximo claim)',
      );
    }
    try {
      await opts.close();
    } catch (err) {
      opts.logger.warn(`${opts.name}: cierre del contexto falló: ${errText(err)}`);
    }
    opts.logger.log(`${opts.name}: detenido (${r})`);
    exit(0);
  };
  process.on('SIGINT', () => void onSignal('SIGINT'));
  process.on('SIGTERM', () => void onSignal('SIGTERM'));
  return onSignal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
