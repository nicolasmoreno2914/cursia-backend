import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AuditLogService } from './audit-log.service';
import { InstitutionsAdminController } from './institutions-admin.controller';
import { InstitutionsAdminService } from './institutions-admin.service';
import { MeContextController } from './me-context.controller';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';
import { PlatformControlsService } from './platform-controls.service';
import { SupabaseAdminClient } from './supabase-admin.client';
import { SuspensionsService } from './suspensions.service';

/**
 * r75 · Agente A — instituciones multi-miembro, membresías con rol por institución, usuarios (solo el SA los crea),
 * suspensiones (cuenta ≠ generación), congelación de plataforma y auditoría append-only.
 *
 * Exporta para B y C: AuditLogService (interfaz compartida), SuspensionsService.getActive,
 * PlatformControlsService.isGenerationFrozen y MembershipsService.listForUser. No importa los módulos de B ni C
 * (ellos importan este): sus servicios se resuelven con ModuleRef por los tokens de access.tokens.ts.
 * La conexión a la base es la global de DatabaseModule (DataSource); sin entidades TypeORM registradas (SQL directo).
 */
@Module({
  imports: [AuthModule],
  controllers: [MeContextController, MembershipsController, InstitutionsAdminController, AdminUsersController],
  providers: [
    AuditLogService, SupabaseAdminClient, MembershipsService, SuspensionsService, PlatformControlsService,
    InstitutionsAdminService, AdminUsersService,
  ],
  exports: [AuditLogService, MembershipsService, SuspensionsService, PlatformControlsService, InstitutionsAdminService],
})
export class AccessModule {}
