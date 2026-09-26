import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
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

  // GET /api/v1/courses/:courseId/profiles/:kind[?paletteId=…] → vigente, o el default con isDefault:true
  // (F1/I4: el default de presentación se deriva de la paleta; nunca persiste).
  @Get(':kind')
  getCurrent(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('kind') kind: string,
    @CurrentUser() user: AuthUser,
    @Query('paletteId') paletteId?: string,
  ) {
    return this.profilesService.getCurrent(courseId, user.id, kind, typeof paletteId === 'string' ? paletteId.slice(0, 64) : null);
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
