import { DYNAMIC_FLAG_ENV, isDynamicCourseStructureEnabled, warnIfNearMissDynamicFlag } from '../modules/features/dynamic-features';

interface GateLogger {
  warn(message: string): void;
}

/** Una hora: solo mantiene vivo el event loop; no hace nada. */
const KEEP_ALIVE_MS = 60 * 60 * 1000;

/**
 * G4 (audit-9): guard de arranque de los workers dynamic. Con
 * DYNAMIC_COURSE_STRUCTURE distinto de 'true':
 * - loguea claro y devuelve `true` → el caller retorna ANTES de crear el
 *   contexto Nest (sin conexión a la DB, sin polling, sin reclamar jobs);
 * - el proceso queda vivo e inactivo (un timer que no hace nada) para que PM2
 *   no entre en un loop de restart; SIGINT/SIGTERM → exit(0).
 * Con el flag en 'true' devuelve `false` y el worker sigue exactamente como
 * antes. Leer el flag después de importar AppModule: ConfigModule.forRoot ya
 * cargó el .env a process.env de forma síncrona al evaluarse el import.
 */
export function holdIdleIfDynamicDisabled(
  logger: GateLogger,
  workerName: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (isDynamicCourseStructureEnabled(env)) return false;
  warnIfNearMissDynamicFlag(logger, env);
  logger.warn(
    `${DYNAMIC_FLAG_ENV} desactivado: el worker no reclama jobs (${workerName} queda inactivo, sin conectarse ` +
      `a la DB). Para activarlo: ${DYNAMIC_FLAG_ENV}=true + pm2 restart --update-env.`,
  );
  const timer = setInterval(() => undefined, KEEP_ALIVE_MS);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// M5 (integral-review): flag ON con el esquema V2 todavía sin migrar (p. ej.
// DYNAMIC_COURSE_STRUCTURE=true en el .env antes del paso A4). El claim falla
// con 42P01 (undefined_table): en vez de propagar → exit(1) → crash-loop de
// PM2, el worker loguea UN error claro, queda inactivo y re-chequea cada
// DYNAMIC_WORKER_SCHEMA_RECHECK_MS (default 5 min). Cualquier otro error
// conserva el comportamiento de cada worker.
// ─────────────────────────────────────────────────────────────────────────────

export const SCHEMA_RECHECK_ENV = 'DYNAMIC_WORKER_SCHEMA_RECHECK_MS';
const DEFAULT_SCHEMA_RECHECK_MS = 5 * 60 * 1000;

interface SchemaLogger {
  error(message: string): void;
  log(message: string): void;
}

/** 42P01 de Postgres, directo o envuelto por TypeORM (QueryFailedError.driverError). */
export function isMissingRelationError(err: unknown): boolean {
  const e = err as { code?: unknown; driverError?: { code?: unknown } } | null;
  return !!e && (e.code === '42P01' || e.driverError?.code === '42P01');
}

export function schemaRecheckMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[SCHEMA_RECHECK_ENV]);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : DEFAULT_SCHEMA_RECHECK_MS;
}

/**
 * Estado "esquema V2 ausente" de un worker. `onClaimError(err)` → ms a esperar
 * si es 42P01 (loguea el error UNA sola vez por episodio), o `null` si no lo
 * es (el caller decide). `onClaimOk()` → si veníamos de 42P01, loguea que el
 * esquema apareció y resetea.
 */
export class MissingSchemaBackoff {
  private missing = false;

  constructor(
    private readonly logger: SchemaLogger,
    private readonly workerName: string,
    private readonly recheckMs: number = schemaRecheckMs(),
  ) {}

  onClaimError(err: unknown): number | null {
    if (!isMissingRelationError(err)) return null;
    if (!this.missing) {
      this.missing = true;
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `${DYNAMIC_FLAG_ENV}=true pero el esquema V2 ausente en la DB (42P01: ${detail}). ${this.workerName} ` +
          `queda inactivo y re-chequea cada ${Math.round(this.recheckMs / 1000)} s. Aplicar las migraciones V2 ` +
          `(docs/v2-production-migrations.md, paso A4) o volver el flag a false.`,
      );
    }
    return this.recheckMs;
  }

  onClaimOk(): void {
    if (this.missing) {
      this.missing = false;
      this.logger.log(`${this.workerName}: esquema V2 disponible; se reanudan los claims.`);
    }
  }

  get isMissing(): boolean {
    return this.missing;
  }
}
