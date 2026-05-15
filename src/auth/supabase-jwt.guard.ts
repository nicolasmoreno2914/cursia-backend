import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { verify, JwtPayload } from 'jsonwebtoken';
import { createRemoteJWKSet, jwtVerify, JWTVerifyResult } from 'jose';
import { Request } from 'express';
import { AuthUser } from './auth.types';

/** Caché del JWKS remoto — una sola instancia por proceso para evitar re-fetch en cada request */
let _jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!_jwksCache) {
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) throw new UnauthorizedException('Autenticación no disponible');
    const jwksUrl = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
    _jwksCache = createRemoteJWKSet(new URL(jwksUrl));
  }
  return _jwksCache;
}

@Injectable()
export class SupabaseJwtGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    // ── 2. Verificar token ──────────────────────────────────────────
    // Modo A: HS256 simétrico (SUPABASE_JWT_SECRET configurado — proyectos legacy)
    // Modo B: ES256 asimétrico via JWKS (SUPABASE_URL configurado — proyectos nuevos)
    let payload: JwtPayload;
    const jwtSecret = process.env.SUPABASE_JWT_SECRET;

    if (jwtSecret) {
      // ── Modo HS256 (simétrico) ──────────────────────────────────
      try {
        payload = verify(token, jwtSecret) as JwtPayload;
      } catch {
        throw new UnauthorizedException('Token inválido o expirado');
      }
    } else {
      // ── Modo ES256 (JWKS) ───────────────────────────────────────
      try {
        const JWKS = getJwks();
        const result: JWTVerifyResult = await jwtVerify(token, JWKS);
        payload = result.payload as JwtPayload;
      } catch {
        throw new UnauthorizedException('Token inválido o expirado');
      }
    }

    // ── 3. Extraer claims ───────────────────────────────────────────
    if (!payload.sub) {
      throw new UnauthorizedException('Token sin identificador de usuario');
    }

    const user: AuthUser = {
      id:    payload.sub,
      email: (payload['email'] as string) ?? '',
      role:  (payload['role'] as string)  ?? 'authenticated',
      raw:   payload as Record<string, any>,
    };

    // ── 4. Adjuntar al request ──────────────────────────────────────
    (req as any).user = user;
    return true;
  }
}
