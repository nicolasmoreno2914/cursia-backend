import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { verify, JwtPayload } from 'jsonwebtoken';
import { Request } from 'express';
import { AuthUser } from './auth.types';

@Injectable()
export class SupabaseJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const authHeader = req.headers['authorization'];

    // ── 1. Token presente ───────────────────────────────────────────
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token de acceso requerido');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new UnauthorizedException('Token de acceso requerido');
    }

    // ── 2. Secreto configurado ──────────────────────────────────────
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      // Configuración incompleta — no exponer detalles al cliente
      throw new UnauthorizedException('Autenticación no disponible');
    }

    // ── 3. Validar y decodificar ────────────────────────────────────
    let payload: JwtPayload;
    try {
      payload = verify(token, secret) as JwtPayload;
    } catch {
      // Token inválido, expirado o manipulado → 401 limpio sin stack trace
      throw new UnauthorizedException('Token inválido o expirado');
    }

    // ── 4. Extraer claims ───────────────────────────────────────────
    if (!payload.sub) {
      throw new UnauthorizedException('Token sin identificador de usuario');
    }

    const user: AuthUser = {
      id: payload.sub,
      email: (payload['email'] as string) ?? '',
      role: (payload['role'] as string) ?? 'authenticated',
      raw: payload,
    };

    // ── 5. Adjuntar al request ──────────────────────────────────────
    (req as any).user = user;
    return true;
  }
}
