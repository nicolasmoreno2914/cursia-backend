import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { verify, JwtPayload } from 'jsonwebtoken';
import { createRemoteJWKSet, jwtVerify, JWTVerifyResult } from 'jose';
import { Request } from 'express';
import { AuthUser } from './auth.types';
import { ADMIN_EMAIL_UNVERIFIED, adminIdentityProblem, EmailConfirmedLookup, isSuperAdminEmail } from './super-admin';

/** r58: confirmaciones de email de admins ya verificadas (solo positivas; 5 min) — sin una query por request. */
const ADMIN_VERIFIED_TTL_MS = 5 * 60_000;
const adminVerifiedCache = new Map<string, number>();
export function resetAdminVerifiedCacheForTests(): void { adminVerifiedCache.clear(); }

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
  private readonly logger = new Logger('SupabaseJwtGuard');

  /** r58: @Optional — los scripts instancian el guard sin DI (sin base → se usa el claim del JWT). */
  constructor(@Optional() private readonly dataSource?: DataSource) {}

  private emailConfirmedLookup(): EmailConfirmedLookup | null {
    const ds = this.dataSource;
    if (!ds || typeof ds.query !== 'function') return null;
    return async (userId: string) => {
      const rows = await ds.query(`select email, email_confirmed_at is not null as confirmed from auth.users where id = $1`, [userId]);
      const r = Array.isArray(rows) ? rows[0] : null;
      return r ? { confirmed: r.confirmed === true, email: r.email ?? null } : { confirmed: false, email: null };
    };
  }

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

    // ── 3b. r58: un email de SuperAdmin exige identidad verificada ──
    const cached = adminVerifiedCache.get(user.id);
    if (!(cached && cached > Date.now())) {
      const problem = await adminIdentityProblem(user, this.emailConfirmedLookup());
      if (problem) {
        this.logger.warn(`${ADMIN_EMAIL_UNVERIFIED}: token con email de administrador rechazado (${problem})`);
        throw new ForbiddenException({ code: ADMIN_EMAIL_UNVERIFIED, message: 'La cuenta de administrador no está verificada.' });
      }
      if (isSuperAdminEmail(user.email)) adminVerifiedCache.set(user.id, Date.now() + ADMIN_VERIFIED_TTL_MS);
    }

    // ── 4. Adjuntar al request ──────────────────────────────────────
    (req as any).user = user;
    return true;
  }
}
