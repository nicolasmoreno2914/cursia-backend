import type { Logger } from '@nestjs/common';
import { LEGACY_PAID_JOBS_ENABLED_ENV, legacyPaidJobsEnabled } from '../modules/finops/spend-controls';

/**
 * r58 (AU3 §H1 #14): segunda barrera del kill switch de los jobs v1 PAGADOS, en el WORKER (gamma, audio, video, job
 * maestro): con LEGACY_PAID_JOBS_ENABLED=false el worker NO reclama jobs nuevos (quedan en cola, sin consumirse ni
 * gastar) — leído en cada vuelta, así que vale para jobs encolados antes de apagarlo. Default (ausente / true) → igual.
 * Loguea solo al cambiar de estado (sin spam en el polling).
 */
export function createLegacyPaidClaimGate(logger: Pick<Logger, 'warn' | 'log'>, worker: string, env: NodeJS.ProcessEnv = process.env): () => boolean {
  let last: boolean | null = null;
  return () => {
    const on = legacyPaidJobsEnabled(env);
    if (on !== last) {
      if (!on) logger.warn(`[${worker}] ${LEGACY_PAID_JOBS_ENABLED_ENV}=false: no se reclaman jobs v1 pagados (quedan en cola, sin gasto).`);
      else if (last === false) logger.log(`[${worker}] ${LEGACY_PAID_JOBS_ENABLED_ENV} reactivado: se vuelven a reclamar jobs.`);
      last = on;
    }
    return on;
  };
}
