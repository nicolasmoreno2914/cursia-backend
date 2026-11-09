import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { toHttpConfigError } from '../features/dynamic-features';
import { isCourseWorkshopAllowedForOwner } from '../features/course-workshop-flag';

/**
 * r107 · Flag COURSE_WORKSHOP como guard (mismo criterio que r81): corre DESPUÉS de SupabaseJwtGuard (necesita al
 * usuario) y ANTES de los pipes de validación, así con el flag apagado — o el usuario fuera de la lista — toda ruta
 * responde el 404 nativo de Nest con cualquier cuerpo (un 400 de validación delataría que la ruta existe). Una lista de
 * dueños mal escrita → 500 ruidoso (solo en estas rutas).
 */
@Injectable()
export class CourseWorkshopFlagGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { user?: { id?: string } }>();
    let allowed = false;
    try {
      allowed = isCourseWorkshopAllowedForOwner(String(req.user?.id ?? ''));
    } catch (err) {
      toHttpConfigError(err);
    }
    if (!allowed) throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl ?? req.url}`);
    return true;
  }
}
