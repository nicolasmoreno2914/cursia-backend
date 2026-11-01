import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { microcurriculumEnabled } from './microcurriculum.service';

/**
 * r81 · Flag MICROCURRICULUM_ENABLED como guard (review P2-7): los guards corren ANTES que los pipes de validación, así
 * con el flag apagado toda ruta responde 404 sin importar el cuerpo (un 400 de validación delataría que existe). Solo
 * GET /microcurricula/quota pasa: responde `{ enabled: false }` y el frontend oculta el menú.
 */
@Injectable()
export class MicrocurriculumFlagGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (microcurriculumEnabled()) return true;
    if (ctx.getHandler()?.name === 'quota') return true;
    throw new NotFoundException('Cannot find this route');
  }
}
