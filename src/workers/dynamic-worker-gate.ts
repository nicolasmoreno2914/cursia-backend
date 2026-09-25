import { DYNAMIC_FLAG_ENV, isDynamicCourseStructureEnabled } from '../modules/features/dynamic-features';

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
