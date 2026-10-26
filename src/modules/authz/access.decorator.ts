import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { AccessContext, assertAccessContext, legacyAccessContext } from './access-context';

/** Clave del request donde PermissionGuard deja el contexto. */
export const REQUEST_ACCESS_KEY = 'cursiaAccess';

/**
 * `@Access()` → AccessContext del request. Si la ruta no pasó por PermissionGuard (sin @RequirePermission, o RBAC
 * apagado sin guard), se arma el contexto legacy desde `req.user` (effectiveOwnerId = actor), que es exactamente el
 * comportamiento actual. Siempre hace assert de `effectiveOwnerId` (500 `access_context_missing` si falta).
 */
export function accessFromRequest(req: any): AccessContext {
  const existing = req?.[REQUEST_ACCESS_KEY] as AccessContext | undefined;
  if (existing) return assertAccessContext(existing);
  const user = req?.user;
  return assertAccessContext(legacyAccessContext(user, isSuperAdminEmail(user?.email)));
}

export const Access = createParamDecorator((_data: unknown, ctx: ExecutionContext): AccessContext => {
  return accessFromRequest(ctx.switchToHttp().getRequest());
});
