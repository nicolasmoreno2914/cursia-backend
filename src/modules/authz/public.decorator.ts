import { SetMetadata } from '@nestjs/common';

/**
 * r75 · Marcas de rutas para AccountAccessGuard y el chequeo de cobertura (scripts/check-r75-authz-coverage.js, E).
 *
 *  - `@Public()`: ruta pública a propósito (sin JWT): `/health`, `/api/v1`, el callback OAuth de YouTube (protegido por
 *    `state`). El guard de cuenta no interviene.
 *  - `@PublicCapability()`: URL de capacidad sin JWT (p. ej. `/api/v1/media/*` de r74: la `mediaKey` es la capacidad).
 *    Nunca se corta por suspensión de cuenta (D-19: los medios ya entregados siguen funcionando).
 *  - `@AllowInactiveAccount()`: ruta con JWT que responde aunque la cuenta NO esté autorizada o esté suspendida
 *    (`GET /auth/me`, `GET /me/context`, `GET /features`), para que el FE muestre la pantalla correcta.
 *  - `@TokenAuthenticated()`: ruta sin JWT de usuario protegida por un token de servicio (p. ej. la ingesta de FinOps
 *    con `x-cursia-finops-token`). Solo documenta: el guard de cuenta no la toca.
 */
export const AUTHZ_PUBLIC_KEY = 'cursia:authz:public';
export const AUTHZ_PUBLIC_CAPABILITY_KEY = 'cursia:authz:public-capability';
export const AUTHZ_ALLOW_INACTIVE_KEY = 'cursia:authz:allow-inactive-account';
export const AUTHZ_TOKEN_AUTH_KEY = 'cursia:authz:token-authenticated';

export const Public = () => SetMetadata(AUTHZ_PUBLIC_KEY, true);
export const PublicCapability = () => SetMetadata(AUTHZ_PUBLIC_CAPABILITY_KEY, true);
export const AllowInactiveAccount = () => SetMetadata(AUTHZ_ALLOW_INACTIVE_KEY, true);
export const TokenAuthenticated = () => SetMetadata(AUTHZ_TOKEN_AUTH_KEY, true);
