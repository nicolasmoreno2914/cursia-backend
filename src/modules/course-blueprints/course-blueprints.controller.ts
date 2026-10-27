import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseIntPipe,
  UseGuards,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CourseBlueprintsService } from './course-blueprints.service';
import { CreateBlueprintDto } from './dto/create-blueprint.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { Access } from '../authz/access.decorator';
import type { AccessContext } from '../authz/access-context';
import { RequirePermission } from '../authz/require-permission.decorator';

@Controller('courses/:courseId/blueprints')
@UseGuards(SupabaseJwtGuard)
export class CourseBlueprintsController {
  constructor(private readonly blueprintsService: CourseBlueprintsService) {}

  // POST /api/v1/courses/:courseId/blueprints
  // 201 si se creó un Blueprint nuevo, 200 si era idempotente (mismo hash
  // que el vigente) — el body es {created, blueprint} en ambos casos.
  @Post()
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  async lock(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: CreateBlueprintDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.blueprintsService.lock(courseId, access.effectiveOwnerId, dto.expectedCounter);
    res.status(result.created ? 201 : 200);
    return result;
  }

  // GET /api/v1/courses/:courseId/blueprints
  @Get()
  @RequirePermission('courses.view', { course: 'param:courseId' })
  list(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.blueprintsService.list(courseId, access.effectiveOwnerId);
  }

  // GET /api/v1/courses/:courseId/blueprints/current
  // (declarado ANTES de :number para que Nest no interprete "current" como un número)
  @Get('current')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  getCurrent(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.blueprintsService.getCurrent(courseId, access.effectiveOwnerId);
  }

  // GET /api/v1/courses/:courseId/blueprints/:number
  @Get(':number')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  getByNumber(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.blueprintsService.getByNumberAnySchema(courseId, access.effectiveOwnerId, number);
  }
}
