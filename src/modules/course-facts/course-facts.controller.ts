import { Body, Controller, Get, Param, ParseIntPipe, Put, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { CourseFactsService } from './course-facts.service';
import { PutBriefDto } from './dto/put-brief.dto';
import { Access } from '../authz/access.decorator';
import type { AccessContext } from '../authz/access-context';
import { RequirePermission } from '../authz/require-permission.decorator';

/** LOOP 8.1 · Fuente única del curso (controller V2: listado en features/dynamic-routes.ts). */
@Controller('courses/:courseId')
@UseGuards(SupabaseJwtGuard)
export class CourseFactsController {
  constructor(private readonly service: CourseFactsService) {}

  // GET /api/v1/courses/:courseId/brief → lo que el usuario dijo del curso (o null)
  @Get('brief')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  getBrief(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.getBrief(courseId, access.effectiveOwnerId);
  }

  // PUT /api/v1/courses/:courseId/brief → reemplaza el pedido (campos de la pantalla Datos)
  @Put('brief')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  putBrief(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: PutBriefDto, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.putBrief(courseId, access.effectiveOwnerId, dto);
  }

  // GET /api/v1/courses/:courseId/facts → «Lo que sabemos del curso»: cada dato con su valor, su origen y los conflictos
  @Get('facts')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  getFacts(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.getFacts(courseId, access.effectiveOwnerId);
  }
}
