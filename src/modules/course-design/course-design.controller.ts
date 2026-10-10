import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { CourseDesignService } from './course-design.service';
import { DesignFixDto, HoursOriginDto, RecommendDesignDto, RequirementDecisionsDto, StructurePreviewDto } from './dto/recommend.dto';

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

  // POST /api/v1/courses/:courseId/design/requirement-decisions  body { audiovisual?, applicationActivities? } (null = quitar)
  // LOOP 8.6C: decisiones del docente que pueden apartarse del documento («Excepción al requisito del documento»).
  @Post('requirement-decisions')
  @HttpCode(200)
  requirementDecisions(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: RequirementDecisionsDto, @CurrentUser() user: AuthUser) {
    return this.service.saveRequirementDecisions(courseId, user.id, dto || {});
  }

  // GET /api/v1/courses/:courseId/design/structure-options → «¿Cómo quieres estructurar tu curso?» (Fase 2)
  @Get('structure-options')
  structureOptions(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser) {
    return this.service.structureOptions(courseId, user.id);
  }

  // POST /api/v1/courses/:courseId/design/structure-preview  body { modules, chaptersPerModule, format? } → vista previa (Fase 2/3)
  @Post('structure-preview')
  @HttpCode(200)
  structurePreview(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: StructurePreviewDto, @CurrentUser() user: AuthUser) {
    return this.service.structurePreview(courseId, user.id, { modules: dto.modules, chaptersPerModule: dto.chaptersPerModule }, dto.format ?? null);
  }

  // POST /api/v1/courses/:courseId/design/fix  body { action: 'link_outcomes', expectedCounter } → «Corregir» automático (LOOP 8.4)
  @Post('fix')
  @HttpCode(200)
  fix(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: DesignFixDto, @CurrentUser() user: AuthUser) {
    return this.service.fix(courseId, user.id, dto.action, dto.expectedCounter);
  }

  // POST /api/v1/courses/:courseId/design/pins/clear → «Liberar»: lo fijado a mano vuelve a decidirlo Cursia
  @Post('pins/clear')
  @HttpCode(200)
  clearPins(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser) {
    return this.service.clearPins(courseId, user.id);
  }
}
