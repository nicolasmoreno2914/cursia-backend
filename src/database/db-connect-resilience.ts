import { DataSource } from 'typeorm';
import {
  DbAcquireRetryPlan,
  DbBootstrapRetryPlan,
  backoffDelayMs,
  classifyDbConnectError,
} from './db-pool-config';

/**
 * r83 — arranque y adquisición de conexión resistentes al pooler de Supabase lleno (ver db-pool-config.ts).
 * Sin dependencias de Nest para poder probarlo directo (scripts/check-r83-db.js).
 */

export interface ResilienceLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface ResilienceClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  rand(): number;
}

const realClock: ResilienceClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  rand: () => Math.random(),
};

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * Suelta lo que un `initialize()` fallido haya dejado abierto: si el pool llegó a crearse (driver.master) pero una
 * consulta posterior del arranque falló, TypeORM NO lo cierra y su conexión quedaba ocupando cupo del pooler.
 */
export async function disposeDataSourceQuietly(ds: DataSource): Promise<void> {
  try {
    if (ds.isInitialized) {
      await ds.destroy();
      return;
    }
    const master = (ds.driver as any)?.master;
    if (master && typeof master.end === 'function') {
      await master.end();
      (ds.driver as any).master = undefined;
    }
  } catch {
    /* best effort: el proceso sigue reintentando o sale */
  }
}

/**
 * `initialize()` con backoff:
 *   - pooler lleno / red transitoria → backoff exponencial con jitter hasta `plan.maxMs` (luego relanza);
 *   - cualquier otro error → `plan.otherAttempts` intentos cada `plan.otherDelayMs` (lo mismo que hacía TypeORM).
 * Cada intento usa un DataSource NUEVO y el fallido se libera (sin conexiones huérfanas).
 */
export async function initializeWithBackoff(
  make: () => DataSource,
  plan: DbBootstrapRetryPlan,
  logger: ResilienceLogger,
  clock: ResilienceClock = realClock,
): Promise<DataSource> {
  const start = clock.now();
  let transientAttempt = 0;
  let otherFailures = 0;
  for (;;) {
    const ds = make();
    try {
      await ds.initialize();
      if (transientAttempt > 0 || otherFailures > 0) {
        logger.warn(`DB: conectado tras ${transientAttempt + otherFailures} reintento(s) en ${clock.now() - start} ms`);
      }
      return ds;
    } catch (err) {
      await disposeDataSourceQuietly(ds);
      const kind = classifyDbConnectError(err);
      if (kind === 'other') {
        otherFailures++;
        if (otherFailures >= plan.otherAttempts) throw err;
        logger.error(`DB: no se pudo conectar (${errText(err)}) — reintento ${otherFailures}/${plan.otherAttempts - 1} en ${plan.otherDelayMs} ms`);
        await clock.sleep(plan.otherDelayMs);
        continue;
      }
      const elapsed = clock.now() - start;
      if (elapsed >= plan.maxMs) {
        logger.error(`DB: ${kind} durante ${elapsed} ms (tope ${plan.maxMs} ms) — se abandona el arranque: ${errText(err)}`);
        throw err;
      }
      const wait = Math.min(backoffDelayMs(transientAttempt, plan.baseMs, plan.capMs, clock.rand), plan.maxMs - elapsed);
      transientAttempt++;
      logger.warn(`DB: ${kind} al arrancar (${errText(err)}) — reintento ${transientAttempt} en ${wait} ms (llevamos ${elapsed} ms de ${plan.maxMs})`);
      await clock.sleep(Math.max(1, wait));
    }
  }
}

const INSTALLED = Symbol.for('cursia.r83.acquireRetry');

/**
 * Reintento acotado al PEDIR una conexión al pool (driver.obtainMasterConnection). En ese punto ninguna sentencia se
 * envió todavía, así que reintentar no puede duplicar escrituras ni cobros. Solo para pooler lleno / red transitoria;
 * la espera del pool local (`timeout exceeded when trying to connect`) y cualquier otro error se propagan igual que antes.
 * Devuelve false si no aplica (plan apagado o driver sin el método).
 */
export function installAcquireRetry(
  ds: DataSource,
  plan: DbAcquireRetryPlan,
  logger: ResilienceLogger,
  clock: ResilienceClock = realClock,
): boolean {
  if (!(plan.maxMs > 0)) return false;
  const driver = ds.driver as any;
  if (!driver || typeof driver.obtainMasterConnection !== 'function' || driver[INSTALLED]) return false;
  const original = driver.obtainMasterConnection.bind(driver);
  driver.obtainMasterConnection = async function obtainMasterConnectionWithRetry(...args: unknown[]) {
    const start = clock.now();
    let attempt = 0;
    for (;;) {
      try {
        const got = await original(...args);
        if (attempt > 0) logger.warn(`DB: conexión obtenida tras ${attempt} reintento(s) en ${clock.now() - start} ms`);
        return got;
      } catch (err) {
        const kind = classifyDbConnectError(err);
        if (kind !== 'pool_exhausted' && kind !== 'transient_network') throw err;
        const elapsed = clock.now() - start;
        if (elapsed >= plan.maxMs) {
          logger.error(`DB: ${kind} al pedir conexión durante ${elapsed} ms (tope ${plan.maxMs} ms): ${errText(err)}`);
          throw err;
        }
        const wait = Math.min(backoffDelayMs(attempt, plan.baseMs, plan.capMs, clock.rand), plan.maxMs - elapsed);
        attempt++;
        if (attempt === 1) logger.warn(`DB: ${kind} al pedir conexión (${errText(err)}) — se reintenta hasta ${plan.maxMs} ms`);
        await clock.sleep(Math.max(1, wait));
      }
    }
  };
  driver[INSTALLED] = true;
  return true;
}
