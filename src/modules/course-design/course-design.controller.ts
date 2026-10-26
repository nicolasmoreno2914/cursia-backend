import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { CourseDesignService } from './course-design.service';
import { DesignFixDto, HoursOriginDto, RecommendDesignDto, RequirementDecisionsDto, StructurePreviewDto } from './dto/recommend.dto';
import { Access } from '../authz/access.decorator';
import type { AccessContext } from '../authz/access-context';
import { RequirePermission } from '../authz/require-permission.decorator';

/** LOOP 8.3 · «Cursia recomienda» (controller V2: listado en features/dynamic-routes.ts). */
@Controller('courses/:courseId/design')
@UseGuards(SupabaseJwtGuard)
export class CourseDesignController {
  constructor(private readonly service: CourseDesignService) {}

  // POST /api/v1/courses/:courseId/design/recommendation  body { adjust? } → diseño recomendado (sin guardar nada)
  @Post('recommendation')
  @HttpCode(200)
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  recommend(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: RecommendDesignDto, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.recommend(courseId, access.effectiveOwnerId, dto || {});
  }

  // POST /api/v1/courses/:courseId/design/hours-origin  body { proposed: number | null } → horas propuestas por Cursia
  @Post('hours-origin')
  @HttpCode(200)
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  hoursOrigin(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: HoursOriginDto, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.recordHoursOrigin(courseId, access.effectiveOwnerId, dto.proposed ?? null);
  }

  // POST /api/v1/courses/:courseId/design/requirement-decisions  body { audiovisual?, applicationActivities? } (null = quitar)
  // LOOP 8.6C: decisiones del docente que pueden apartarse del documento («Excepción al requisito del documento»).
  @Post('requirement-decisions')
  @HttpCode(200)
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  requirementDecisions(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: RequirementDecisionsDto, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.saveRequirementDecisions(courseId, access.effectiveOwnerId, dto || {});
  }

  // GET /api/v1/courses/:courseId/design/structure-options → «¿Cómo quieres estructurar tu curso?» (Fase 2)
  @Get('structure-options')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  structureOptions(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.structureOptions(courseId, access.effectiveOwnerId);
  }

  // POST /api/v1/courses/:courseId/design/structure-preview  body { modules, chaptersPerModule, format? } → vista previa (Fase 2/3)
  @Post('structure-preview')
  @HttpCode(200)
  @RequirePermission('courses.view', { course: 'param:courseId' })
  structurePreview(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: StructurePreviewDto, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.structurePreview(courseId, access.effectiveOwnerId, { modules: dto.modules, chaptersPerModule: dto.chaptersPerModule }, dto.format ?? null);
  }

  // POST /api/v1/courses/:courseId/design/fix  body { action: 'link_outcomes', expectedCounter } → «Corregir» automático (LOOP 8.4)
  // r71: action 'autofix' («Cursia optimizó tu curso»), 'autofix_undo' { changeIds? }, 'link_outcome' { outcomeId, chapterId },
  // 'context_field' { field, value }.
  @Post('fix')
  @HttpCode(200)
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  fix(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: DesignFixDto, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.fix(courseId, access.effectiveOwnerId, dto.action, dto.expectedCounter, dto);
  }

  // POST /api/v1/courses/:courseId/design/pins/clear → «Liberar»: lo fijado a mano vuelve a decidirlo Cursia
  @Post('pins/clear')
  @HttpCode(200)
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  clearPins(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.clearPins(courseId, access.effectiveOwnerId);
  }
}
