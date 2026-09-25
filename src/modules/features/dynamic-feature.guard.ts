import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { isDynamicRoute } from './dynamic-routes';
import { isDynamicCourseStructureEnabled, toHttpConfigError, validateDynamicFeatureConfig } from './dynamic-features';

/**
 * Guard global (APP_GUARD, corre ANTES de los guards de controller como
 * SupabaseJwtGuard). Solo mira rutas V2 (ver dynamic-routes.ts):
 * - DYNAMIC_COURSE_STRUCTURE apagado → 404 idéntico al 404 nativo de Nest
 *   ("Cannot METHOD url"), con o sin token: la API V2 no existe.
 * - encendido con una allow-list inválida → 500 ruidoso (solo rutas V2).
 * - encendido y válido → no interviene (la allow-list por owner se aplica en
 *   los servicios, donde el ownerId ya es conocido).
 * Rutas legacy: nunca se tocan.
 */
@Injectable()
export class DynamicFeatureGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    if (!isDynamicRoute(context.getClass(), context.getHandler())) return true;

    if (!isDynamicCourseStructureEnabled()) {
      const req = context.switchToHttp().getRequest<Request>();
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl ?? req.url}`);
    }
    try {
      validateDynamicFeatureConfig();
    } catch (err) {
      toHttpConfigError(err);
    }
    return true;
  }
}
