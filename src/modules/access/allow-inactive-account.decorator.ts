import { SetMetadata } from '@nestjs/common';

/**
 * r75 · A — marca una ruta JWT que DEBE responder aunque la cuenta esté suspendida o no autorizada (01 §2.3.1):
 * `GET /me/context` (y `GET /auth/me`, que es de B). El AccountAccessGuard de B la respeta leyendo esta metadata
 * (`reflector.getAllAndOverride(R75_ALLOW_INACTIVE_ACCOUNT, [handler, class])`). No otorga nada: solo deja pasar
 * hasta el handler, que no expone datos de terceros.
 */
export const R75_ALLOW_INACTIVE_ACCOUNT = 'r75:allowInactiveAccount';
export const AllowInactiveAccount = () => SetMetadata(R75_ALLOW_INACTIVE_ACCOUNT, true);
