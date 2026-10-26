import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DataSource } from 'typeorm';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { accountGuardMode } from './authz-flags';
import { AccountAccessService, AccountDecision } from './account-access.service';
import { AuditLogLike, R75_AUDIT_LOG, writeAudit } from './audit-sink';
import { AUTHZ_ERRORS } from './permissions';
import {
  AUTHZ_ALLOW_INACTIVE_KEY,
  AUTHZ_PUBLIC_CAPABILITY_KEY,
  AUTHZ_PUBLIC_KEY,
  AUTHZ_TOKEN_AUTH_KEY,
} from './public.decorator';

/**
 * Rutas con JWT que responden aunque la cuenta no esté autorizada / esté suspendida (01 §2.3 paso 1). Además del
 * decorador `@AllowInactiveAccount()`, se listan por ruta para no depender de que el controller de A lo aplique.
 */
export const ALLOW_INACTIVE_PATHS: ReadonlySet<string> = new Set(['/api/v1/me/context', '/api/v1/auth/me', '/api/v1/features']);

/** Clave del request donde queda la decisión de cuenta (la lee `/me/context`). */
export const REQUEST_ACCOUNT_KEY = 'cursiaAccount';

export function normalizePath(url: string | undefined): string {
  const p = String(url ?? '').split('?')[0].split('#')[0];
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** ¿La ruta usa SupabaseJwtGuard (en el handler o en el controller)? */
export function routeUsesJwtGuard(handler: Function | undefined, cls: Function | undefined): boolean {
  const has = (t: Function | undefined) => {
    if (!t) return false;
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, t) || [];
    return guards.some((g) => g === SupabaseJwtGuard || (typeof g === 'function' && (g as Function).prototype instanceof SupabaseJwtGuard));
  };
  return has(handler) || has(cls);
}

export function accountDenial(d: AccountDecision): ForbiddenException | ServiceUnavailableException {
  if (d.status === 'suspended') {
    return new ForbiddenException({ code: AUTHZ_ERRORS.ACCOUNT_SUSPENDED, message: 'Tu cuenta está suspendida. Contacta al administrador.' });
  }
  if (d.status === 'unavailable') {
    return new ServiceUnavailableException({ code: AUTHZ_ERRORS.ACCOUNT_CHECK_UNAVAILABLE, message: 'No se pudo verificar el acceso de la cuenta. Intenta de nuevo.' });
  }
  return new ForbiddenException({ code: AUTHZ_ERRORS.ACCOUNT_NOT_AUTHORIZED, message: 'Tu cuenta no tiene acceso a Cursia. Pide acceso al administrador.' });
}

/**
 * r75 B1 (H1) · `AccountAccessGuard` (APP_GUARD, registrado DESPUÉS de DynamicFeatureGuard).
 *
 * - `CURSIA_ACCOUNT_GUARD=off` (default): no hace nada (ni verifica el JWT): comportamiento actual.
 * - Rutas `@Public()` / `@PublicCapability()` / `@TokenAuthenticated()` o sin SupabaseJwtGuard: no interviene (no hay
 *   identidad de usuario: `/health`, callback OAuth, ingesta FinOps por token, `/media/*` de r74).
 * - Rutas con SupabaseJwtGuard: como los APP_GUARD corren ANTES que los guards del controller, verifica el JWT acá
 *   mismo (misma clase; el guard de la ruta reconoce el token ya verificado y no lo repite) y evalúa la cuenta.
 *   `shadow` registra `account_guard.shadow_deny` y deja pasar; `enforce` corta con 403 `account_not_authorized` /
 *   `account_suspended` o 503 `account_check_unavailable` (falla cerrada).
 * - `/me/context`, `/auth/me`, `/features` (y `@AllowInactiveAccount()`) responden igual, con la decisión en el request.
 */
@Injectable()
export class AccountAccessGuard implements CanActivate {
  private readonly logger = new Logger('AccountAccessGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly jwtGuard: SupabaseJwtGuard,
    private readonly accounts: AccountAccessService,
    @Optional() private readonly dataSource?: DataSource,
    @Optional() @Inject(R75_AUDIT_LOG) private readonly audit?: AuditLogLike,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const mode = accountGuardMode(process.env, (m) => this.logger.warn(m));
    if (mode === 'off') return true;
    const handler = context.getHandler();
    const cls = context.getClass();
    const flag = (key: string) => this.reflector.getAllAndOverride<boolean>(key, [handler, cls]) === true;
    if (flag(AUTHZ_PUBLIC_KEY) || flag(AUTHZ_PUBLIC_CAPABILITY_KEY) || flag(AUTHZ_TOKEN_AUTH_KEY)) return true;
    if (!routeUsesJwtGuard(handler, cls)) return true;

    const req = context.switchToHttp().getRequest();
    if (!req.user) await this.jwtGuard.canActivate(context); // 401 idéntico al del guard de la ruta
    const user = req.user;
    const decision = await this.accounts.evaluate(user);
    req[REQUEST_ACCOUNT_KEY] = decision;
    if (decision.status === 'active') return true;
    if (flag(AUTHZ_ALLOW_INACTIVE_KEY) || ALLOW_INACTIVE_PATHS.has(normalizePath(req.originalUrl ?? req.url))) return true;

    if (mode === 'shadow') {
      const q = this.dataSource ? (sql: string, p?: unknown[]) => this.dataSource!.query(sql, p as any[]) : null;
      void writeAudit(this.audit, q, {
        actorId: user.id,
        actorEmail: user.email ?? null,
        actorIsSuperadmin: isSuperAdminEmail(user.email),
        action: 'account_guard.shadow_deny',
        targetType: 'route',
        targetId: `${req.method} ${normalizePath(req.route?.path ?? req.originalUrl ?? req.url)}`.slice(0, 200),
        after: { status: decision.status, via: decision.via, reason: decision.reason ?? null },
      });
      this.logger.warn(`account_guard.shadow_deny user=${user.id} status=${decision.status} ${req.method} ${normalizePath(req.originalUrl ?? req.url)}`);
      return true;
    }
    throw accountDenial(decision);
  }
}
