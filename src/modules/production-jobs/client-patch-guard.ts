import { ForbiddenException } from '@nestjs/common';

/**
 * r58 (AU3 §H1.2 / §J8): `PATCH /jobs/:id` y `/jobs/:id/steps/:stepKey` existen para que el pipeline v1 del NAVEGADOR
 * informe su propio progreso. Un run V2 (dynamic_generation / dynamic_package) lo gobierna el servidor: su `status`
 * entra en el tope mensual (`monthCommitted` excluye cancelled/cancelling), en el guard de deploy y en el dashboard, así
 * que el dueño ya no puede reescribirlo por esta vía (403 `server_owned_job`, sin tocar nada). Pausa / reanudar /
 * cancelar de V2 siguen por sus endpoints propios. Jobs v1 (frontend, backend_*) → sin cambio.
 */
export const SERVER_OWNED_JOB_CODE = 'server_owned_job';

export function isServerOwnedExecutionMode(executionMode: string | null | undefined): boolean {
  return /^dynamic_/.test(String(executionMode ?? ''));
}

export function assertClientMayPatchJob(executionMode: string | null | undefined): void {
  if (!isServerOwnedExecutionMode(executionMode)) return;
  throw new ForbiddenException({
    code: SERVER_OWNED_JOB_CODE,
    message: `${SERVER_OWNED_JOB_CODE}: el estado de una generación V2 lo gobierna el servidor; usa pausar / reanudar / cancelar.`,
  });
}
