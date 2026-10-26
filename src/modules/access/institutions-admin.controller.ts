import { Body, Controller, HttpCode, HttpStatus, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { SuperAdminGuard } from '../../auth/super-admin.guard';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { actorFromUser } from './access-actor';
import { InstitutionsAdminService } from './institutions-admin.service';

/** r75 · 02 §B — `/admin/institutions*` y `/admin/courses/:courseId/institution` (solo SuperAdmin). */
@Controller('admin')
@UseGuards(SupabaseJwtGuard, SuperAdminGuard)
export class InstitutionsAdminController {
  constructor(private readonly institutions: InstitutionsAdminService) {}

  @Post('institutions')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: { name?: string; slug?: string; kind?: string }, @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.institutions.create(actorFromUser(user, req), body ?? {});
  }

  @Patch('institutions/:id')
  async update(@Param('id') id: string, @Body() body: { name?: string; status?: string }, @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.institutions.update(actorFromUser(user, req), id, body ?? {});
  }

  @Patch('courses/:courseId/institution')
  async moveCourse(@Param('courseId') courseId: string, @Body() body: { institutionId?: string; reason?: string },
    @CurrentUser() user: AuthUser, @Req() req: any) {
    return await this.institutions.moveCourse(actorFromUser(user, req), courseId, body ?? {});
  }
}
