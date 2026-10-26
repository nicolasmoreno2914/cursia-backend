import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { SuperAdminGuard } from '../../auth/super-admin.guard';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { actorFromUser } from './access-actor';
import { E } from './access-errors';
import { r75AccessSchemaPresent } from './access-schema';
import { AdminUsersService } from './admin-users.service';
import { AuditLogService } from './audit-log.service';
import { PlatformControlsService } from './platform-controls.service';
import { SuspensionsService } from './suspensions.service';
import { SuperAdminOnly } from '../authz/require-permission.decorator';

/** r75 · 02 §C — usuarios, suspensiones, plataforma y auditoría (solo SuperAdmin). */
@SuperAdminOnly() // r75: rutas solo SuperAdmin (SuperAdminGuard); marca para la cobertura de autorización
@Controller('admin')
@UseGuards(SupabaseJwtGuard, SuperAdminGuard)
export class AdminUsersController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly suspensions: SuspensionsService,
    private readonly platform: PlatformControlsService,
    private readonly audit: AuditLogService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Get('users')
  async list(@Query() q: { q?: string; status?: string; institutionId?: string; page?: string; pageSize?: string }) {
    return await this.users.list(q ?? {});
  }

  /** La respuesta puede llevar `tempPassword` (UNA vez): nunca se cachea ni se registra. */
  @Post('users')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  async create(@Body() body: { email?: string; fullName?: string; mode?: string; memberships?: unknown }, @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.users.create(actorFromUser(user, req), body ?? {});
  }

  @Get('users/:userId')
  async getOne(@Param('userId') userId: string) {
    return await this.users.getOne(userId);
  }

  @Post('users/:userId/authorize')
  @HttpCode(HttpStatus.OK)
  async authorize(@Param('userId') userId: string, @Body() body: { reason?: string }, @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.users.authorize(actorFromUser(user, req), userId, body?.reason);
  }

  @Post('users/:userId/repair')
  @HttpCode(HttpStatus.OK)
  async repair(@Param('userId') userId: string, @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.users.repair(actorFromUser(user, req), userId);
  }

  @Post('users/:userId/suspensions')
  @HttpCode(HttpStatus.CREATED)
  async suspend(@Param('userId') userId: string, @Body() body: { kind?: string; reason?: string }, @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.suspensions.suspend(actorFromUser(user, req), userId, body?.kind, body?.reason);
  }

  @Delete('users/:userId/suspensions/:kind')
  async lift(@Param('userId') userId: string, @Param('kind') kind: string, @Body() body: { reason?: string } | undefined,
    @Query('reason') reasonQ: string | undefined, @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.suspensions.lift(actorFromUser(user, req), userId, kind, body?.reason ?? reasonQ);
  }

  @Get('platform/controls')
  async controls() {
    return await this.platform.getControls();
  }

  @Put('platform/generation-freeze')
  async freeze(@Body() body: { enabled?: boolean; reason?: string }, @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.platform.setGenerationFreeze(actorFromUser(user, req), body ?? {});
  }

  @Get('audit-log')
  async auditLog(@Query() q: { actorId?: string; action?: string; targetType?: string; targetId?: string; institutionId?: string; from?: string; to?: string; cursor?: string; limit?: string }) {
    if (!(await r75AccessSchemaPresent(this.dataSource))) throw E.schemaMissing();
    const page = await this.audit.list({ ...(q ?? {}), limit: q?.limit ? Number(q.limit) : undefined });
    return page;
  }
}
