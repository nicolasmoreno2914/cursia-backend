/* ══════════════════════════════════════════════════════════════
   super-admin.guard.ts — Guarda de SuperAdmin
   ══════════════════════════════════════════════════════════════

   Requiere que SupabaseJwtGuard haya corrido PRIMERO (que
   req.user esté presente con email verificado).

   Lee SUPER_ADMIN_EMAILS del entorno (lista separada por comas).
   Devuelve 403 si el email del usuario no está en la lista.

   NUNCA hace queries a la base de datos — cero overhead.
   ══════════════════════════════════════════════════════════════ */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthUser } from './auth.types';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = (req as any).user as AuthUser | undefined;

    if (!user || !user.email) {
      throw new ForbiddenException('Acceso denegado');
    }

    const rawEnv = process.env.SUPER_ADMIN_EMAILS || '';
    const allowedEmails = rawEnv
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    if (allowedEmails.length === 0) {
      // Sin emails configurados → nadie entra (fail-secure)
      throw new ForbiddenException('Panel de administración no configurado');
    }

    if (!allowedEmails.includes(user.email.toLowerCase())) {
      throw new ForbiddenException('No tienes permisos de administrador');
    }

    return true;
  }
}
