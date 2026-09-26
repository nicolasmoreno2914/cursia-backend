import { Body, Controller, Get, Param, ParseIntPipe, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CourseProfilesService } from './course-profiles.service';
import { CreateProfileDto } from './dto/create-profile.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

/**
 * V2.1 (R3): perfiles de curso (presentation / assessment). Controller V2
 * (listado en features/dynamic-routes.ts: 404 con DYNAMIC_COURSE_STRUCTURE
 * apagado).
 */
@Controller('courses/:courseId/profiles')
@UseGuards(SupabaseJwtGuard)
export class CourseProfilesController {
  constructor(private readonly profilesService: CourseProfilesService) {}

  // GET /api/v1/courses/:courseId/profiles/:kind → vigente, o el default con isDefault:true
  @Get(':kind')
  getCurrent(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('kind') kind: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.profilesService.getCurrent(courseId, user.id, kind);
  }

  // POST /api/v1/courses/:courseId/profiles/:kind  body { data, expectedVersion? }
  // 201 versión nueva; 200 si era idéntico a la vigente (idempotente).
  @Post(':kind')
  async append(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('kind') kind: string,
    @Body() dto: CreateProfileDto,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.profilesService.append(courseId, user.id, kind, dto.data, dto.expectedVersion);
    res.status(result.created ? 201 : 200);
    return result;
  }
}
