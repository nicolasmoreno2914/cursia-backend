import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { actorFromUser } from './access-actor';
import { MembershipsService } from './memberships.service';

/**
 * r75 · 02 §B — miembros de una institución. Permiso: P(roles.manage) en ESA institución, o SuperAdmin.
 * Lo verifica MembershipsService en cada operación (independiente de CURSIA_RBAC_MODE: son rutas nuevas).
 */
@Controller('institutions/:id/members')
@UseGuards(SupabaseJwtGuard)
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get()
  async list(@Param('id') id: string, @Query('status') status: string | undefined, @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.memberships.listMembers(actorFromUser(user, req), id, status);
  }

  @Post()
  async add(@Param('id') id: string, @Body() body: { email?: string; role?: string }, @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.memberships.addMember(actorFromUser(user, req), id, body ?? {});
  }

  @Patch(':userId')
  async update(@Param('id') id: string, @Param('userId') userId: string, @Body() body: { role?: string; status?: string },
    @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.memberships.updateMember(actorFromUser(user, req), id, userId, body ?? {});
  }

  @Delete(':userId')
  async remove(@Param('id') id: string, @Param('userId') userId: string, @Body() body: { reason?: string } | undefined,
    @Query('reason') reasonQ: string | undefined, @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.memberships.removeMember(actorFromUser(user, req), id, userId, body?.reason ?? reasonQ);
  }

  @Put(':userId/overrides')
  async overrides(@Param('id') id: string, @Param('userId') userId: string,
    @Body() body: { grants?: string[]; denies?: string[]; reason?: string }, @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.memberships.setOverrides(actorFromUser(user, req), id, userId, body ?? {});
  }
}
