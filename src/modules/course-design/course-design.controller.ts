import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { CourseDesignService } from './course-design.service';
import { HoursOriginDto, RecommendDesignDto } from './dto/recommend.dto';

/** LOOP 8.3 · «Cursia recomienda» (controller V2: listado en features/dynamic-routes.ts). */
@Controller('courses/:courseId/design')
@UseGuards(SupabaseJwtGuard)
export class CourseDesignController {
  constructor(private readonly service: CourseDesignService) {}

  // POST /api/v1/courses/:courseId/design/recommendation  body { adjust? } → diseño recomendado (sin guardar nada)
  @Post('recommendation')
  @HttpCode(200)
  recommend(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: RecommendDesignDto, @CurrentUser() user: AuthUser) {
    return this.service.recommend(courseId, user.id, dto || {});
  }

  // POST /api/v1/courses/:courseId/design/hours-origin  body { proposed: number | null } → horas propuestas por Cursia
  @Post('hours-origin')
  @HttpCode(200)
  hoursOrigin(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: HoursOriginDto, @CurrentUser() user: AuthUser) {
    return this.service.recordHoursOrigin(courseId, user.id, dto.proposed ?? null);
  }

  // POST /api/v1/courses/:courseId/design/pins/clear → «Liberar»: lo fijado a mano vuelve a decidirlo Cursia
  @Post('pins/clear')
  @HttpCode(200)
  clearPins(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser) {
    return this.service.clearPins(courseId, user.id);
  }
}
