import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { CourseAuthorshipInterceptor } from './course-authorship.interceptor';
import { AuthModule } from '../../auth/auth.module';
import { AccountAccessGuard } from './account-access.guard';
import { AccountAccessService } from './account-access.service';
import { assertUnownedCoursesSafe } from './unowned-courses';
import { PermissionGuard } from './permission.guard';
import { PermissionService, R75_PERMISSION_SERVICE } from './permission.service';
import { PermissionsCatalogController } from './permissions-catalog.controller';
import { ArtifactAccessService } from './artifact-access.service';
import { AccessModule } from '../access/access.module';
import { AuditLogService } from '../access/audit-log.service';
import { R75_AUDIT_LOG } from './audit-sink';

/** Token del assert de arranque D-26 (H4): con ALLOW_UNOWNED_COURSES=true fuera de development, la API no arranca. */
export const UNOWNED_COURSES_BOOT_GUARD = 'R75_UNOWNED_COURSES_BOOT_GUARD';

/**
 * r75 · Autorización (agente B). Lo registra el lead en `app.module.ts`, DESPUÉS de `FeaturesModule` (así
 * AccountAccessGuard corre después de DynamicFeatureGuard: una ruta V2 apagada sigue dando su 404 nativo).
 *
 * B1: AccountAccessGuard (APP_GUARD, `CURSIA_ACCOUNT_GUARD`, default off) + assert de arranque D-26.
 * B2: PermissionService + PermissionGuard (APP_GUARD, `CURSIA_RBAC_MODE`, default off) + `GET /permissions/catalog`.
 * Global: AccountAccessService se exporta para que la ingesta de FinOps (`llm-reservation`, agente C) y
 * `/me/context` (agente A) usen la MISMA decisión de cuenta.
 */
@Global()
@Module({
  imports: [AuthModule, AccessModule],
  controllers: [PermissionsCatalogController],
  providers: [
    AccountAccessService,
    PermissionService,
    ArtifactAccessService,
    // Orden de los APP_GUARD = orden de registro: cuenta (B1) → permiso (B2).
    { provide: APP_GUARD, useClass: AccountAccessGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: CourseAuthorshipInterceptor },
    // A (/me/context, memberships) resuelve PermissionService por este token con ModuleRef (access/access.tokens.ts).
    { provide: R75_PERMISSION_SERVICE, useExisting: PermissionService },
    // Auditoría: AuditLogService de A (interfaz compartida); `rbac.shadow_deny` usa recordSafe (nunca corta el request).
    { provide: R75_AUDIT_LOG, useExisting: AuditLogService },
    { provide: UNOWNED_COURSES_BOOT_GUARD, useFactory: () => (assertUnownedCoursesSafe(process.env), true) },
  ],
  exports: [AccountAccessService, PermissionService, ArtifactAccessService, R75_PERMISSION_SERVICE],
})
export class AuthzModule {}
