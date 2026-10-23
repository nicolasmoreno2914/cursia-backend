import { Body, Controller, Param, ParseIntPipe, Patch, UseGuards } from '@nestjs/common';
import { CourseStructureService } from './course-structure.service';
import { UpdateStructureSettingsDto } from './dto/update-structure-settings.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

/**
 * V2.1 (R3): toggles de producto a nivel curso (`finalExam`,
 * `activityEngine`). Controller V2 (listado en features/dynamic-routes.ts:
 * 404 con DYNAMIC_COURSE_STRUCTURE apagado).
 */
@Controller('courses/:courseId/structure-settings')
@UseGuards(SupabaseJwtGuard)
export class CourseStructureSettingsController {
  constructor(private readonly structureService: CourseStructureService) {}

  // PATCH /api/v1/courses/:courseId/structure-settings
  // body { finalExam?, activityEngine?, expectedCounter } → { structureVersionCounter, finalExam, activityEngine }
  @Patch()
  updateSettings(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: UpdateStructureSettingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.structureService.updateSettings(courseId, user.id, dto);
  }
}
