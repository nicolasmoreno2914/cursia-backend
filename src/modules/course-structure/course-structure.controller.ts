import { ApplyDistributionDto } from './dto/apply-distribution.dto';
import { ApplyAcademicStructureDto, RecordStructureOriginDto } from './dto/apply-academic-structure.dto';
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ParseIntPipe,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { CourseStructureService } from './course-structure.service';
import { CreateModuleDto } from './dto/create-module.dto';
import { UpdateModuleDto } from './dto/update-module.dto';
import { CreateChapterDto } from './dto/create-chapter.dto';
import { UpdateChapterDto } from './dto/update-chapter.dto';
import { ReorderDto } from './dto/reorder.dto';
import { MoveChapterDto } from './dto/move-chapter.dto';
import { ExpectedCounterDto } from './dto/expected-counter.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { Access } from '../authz/access.decorator';
import type { AccessContext } from '../authz/access-context';
import { RequirePermission } from '../authz/require-permission.decorator';

@Controller('courses/:courseId/modules')
@UseGuards(SupabaseJwtGuard)
export class CourseStructureController {
  constructor(private readonly structureService: CourseStructureService) {}

  // GET /api/v1/courses/:courseId/modules
  @Get()
  @RequirePermission('courses.view', { course: 'param:courseId' })
  getStructure(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.structureService.getStructure(courseId, access.effectiveOwnerId);
  }

  // POST /api/v1/courses/:courseId/modules
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  createModule(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: CreateModuleDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.structureService.createModule(courseId, access.effectiveOwnerId, dto);
  }

  // POST /api/v1/courses/:courseId/modules/apply-distribution — Fase 2 · «Aplicar diseño» (propuesta del distribuidor
  // con sus capítulos y Actividades de Aplicación → estructura real; luego se confirma el Blueprint como siempre).
  @Post('apply-distribution')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  applyDistribution(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: ApplyDistributionDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.structureService.applyDistribution(courseId, access.effectiveOwnerId, dto);
  }

  // POST /api/v1/courses/:courseId/modules/apply-academic-structure — LOOP 8.0: la estructura del microcurrículo
  // (contexto académico guardado) reemplaza la del curso. Sin pisar trabajo del docente sin confirmación explícita.
  @Post('apply-academic-structure')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  applyAcademicStructure(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: ApplyAcademicStructureDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.structureService.applyAcademicStructure(courseId, access.effectiveOwnerId, dto);
  }

  // POST /api/v1/courses/:courseId/modules/structure-origin — LOOP 8.0: el editor registra que la estructura vigente
  // es la propuesta de la IA (así el microcurrículo puede reemplazarla sin pedir confirmación mientras nadie la toque).
  @Post('structure-origin')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  recordStructureOrigin(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: RecordStructureOriginDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.structureService.recordStructureOrigin(courseId, access.effectiveOwnerId, dto);
  }

  // PATCH /api/v1/courses/:courseId/modules/reorder
  // (declarado ANTES de :moduleId para que Nest no interprete "reorder" como un id)
  @Patch('reorder')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  reorderModules(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: ReorderDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.structureService.reorderModules(courseId, access.effectiveOwnerId, dto);
  }

  // PATCH /api/v1/courses/:courseId/modules/:moduleId
  @Patch(':moduleId')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  updateModule(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Body() dto: UpdateModuleDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.structureService.updateModule(courseId, moduleId, access.effectiveOwnerId, dto);
  }

  // DELETE /api/v1/courses/:courseId/modules/:moduleId
  @Delete(':moduleId')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  deleteModule(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Body() dto: ExpectedCounterDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.structureService.deleteModule(courseId, moduleId, access.effectiveOwnerId, dto.expectedCounter);
  }

  // POST /api/v1/courses/:courseId/modules/:moduleId/chapters
  @Post(':moduleId/chapters')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  createChapter(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Body() dto: CreateChapterDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.structureService.createChapter(courseId, moduleId, access.effectiveOwnerId, dto);
  }

  // PATCH /api/v1/courses/:courseId/modules/:moduleId/chapters/reorder
  @Patch(':moduleId/chapters/reorder')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  reorderChapters(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Body() dto: ReorderDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.structureService.reorderChapters(courseId, moduleId, access.effectiveOwnerId, dto);
  }

  // PATCH /api/v1/courses/:courseId/modules/:moduleId/chapters/:chapterId
  @Patch(':moduleId/chapters/:chapterId')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  updateChapter(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @Body() dto: UpdateChapterDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.structureService.updateChapter(courseId, moduleId, chapterId, access.effectiveOwnerId, dto);
  }

  // DELETE /api/v1/courses/:courseId/modules/:moduleId/chapters/:chapterId
  @Delete(':moduleId/chapters/:chapterId')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  deleteChapter(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @Body() dto: ExpectedCounterDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.structureService.deleteChapter(courseId, moduleId, chapterId, access.effectiveOwnerId, dto.expectedCounter);
  }

  // PATCH /api/v1/courses/:courseId/modules/:moduleId/chapters/:chapterId/move
  @Patch(':moduleId/chapters/:chapterId/move')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  moveChapter(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @Body() dto: MoveChapterDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.structureService.moveChapter(courseId, moduleId, chapterId, access.effectiveOwnerId, dto);
  }
}
