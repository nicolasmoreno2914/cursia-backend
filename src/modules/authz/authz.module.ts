import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { AccountAccessGuard } from './account-access.guard';
import { AccountAccessService } from './account-access.service';
import { assertUnownedCoursesSafe } from './unowned-courses';

/** Token del assert de arranque D-26 (H4): con ALLOW_UNOWNED_COURSES=true fuera de development, la API no arranca. */
export const UNOWNED_COURSES_BOOT_GUARD = 'R75_UNOWNED_COURSES_BOOT_GUARD';

/**
 * r75 · Autorización (agente B). Lo registra el lead en `app.module.ts`, DESPUÉS de `FeaturesModule` (así
 * AccountAccessGuard corre después de DynamicFeatureGuard: una ruta V2 apagada sigue dando su 404 nativo).
 *
 * B1: AccountAccessGuard (APP_GUARD, `CURSIA_ACCOUNT_GUARD`, default off) + assert de arranque D-26.
 * Global: AccountAccessService se exporta para que la ingesta de FinOps (`llm-reservation`, agente C) y
 * `/me/context` (agente A) usen la MISMA decisión de cuenta.
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [
    AccountAccessService,
    { provide: APP_GUARD, useClass: AccountAccessGuard },
    { provide: UNOWNED_COURSES_BOOT_GUARD, useFactory: () => (assertUnownedCoursesSafe(process.env), true) },
  ],
  exports: [AccountAccessService],
})
export class AuthzModule {}
