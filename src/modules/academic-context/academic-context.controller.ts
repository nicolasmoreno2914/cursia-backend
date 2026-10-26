import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { AcademicContextService } from './academic-context.service';
import { ExtractAcademicContextDto, ExtractAdvancedDto, OutcomesDto, ProposalDto, RequirementSelectionDto } from './dto/extract.dto';
import { Access } from '../authz/access.decorator';
import type { AccessContext } from '../authz/access-context';
import { RequirePermission } from '../authz/require-permission.decorator';

/**
 * Fase 3 — Contexto académico (controller V2: listado en features/dynamic-routes.ts, 404 con la estructura dinámica
 * apagada). Guardar el contexto: POST /courses/:courseId/profiles/academic (perfiles versionados).
 */
@Controller('courses/:courseId/academic-context')
@UseGuards(SupabaseJwtGuard)
export class AcademicContextController {
  constructor(private readonly service: AcademicContextService) {}

  // POST /api/v1/courses/:courseId/academic-context/extract  body { files: [{ name, dataBase64 }] }
  // → { draft, validation, notes, stats, requirements } — determinista, sin proveedores. No guarda el contexto; los
  // requisitos explícitos leídos quedan en courses.metadata atados a la huella de los documentos (LOOP 8.6B).
  @Post('extract')
  @HttpCode(200)
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  extract(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: ExtractAcademicContextDto, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.extract(courseId, access.effectiveOwnerId, dto);
  }

  // POST /api/v1/courses/:courseId/academic-context/extract-advanced  body { files: [PDF], mode, acceptedMaxUsd? }
  // LOOP 8.1: lectura avanzada (estimar sin costo → leer con IA tras aceptar el costo). NO guarda nada.
  @Post('extract-advanced')
  @HttpCode(200)
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  extractAdvanced(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: ExtractAdvancedDto, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.extractAdvanced(courseId, access.effectiveOwnerId, dto);
  }

  // POST /api/v1/courses/:courseId/academic-context/proposal  body { expectedVersion, outcomes[], subjectName?, … }
  // LOOP 8.2: sin documento, lo que Cursia entendió del pedido (inferred). 409 si el contexto viene de un documento.
  @Post('proposal')
  @HttpCode(200)
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  proposal(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: ProposalDto, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.saveProposal(courseId, access.effectiveOwnerId, dto);
  }

  // PUT /api/v1/courses/:courseId/academic-context/outcomes  body { expectedVersion, outcomes: [{ id?, text }], accept? }
  // LOOP 8.2: corregir o confirmar los resultados de aprendizaje («Lo que entendimos»).
  @Put('outcomes')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  outcomes(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: OutcomesDto, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.saveOutcomes(courseId, access.effectiveOwnerId, dto);
  }

  // GET /api/v1/courses/:courseId/academic-context/requirements → requisitos explícitos del documento (LOOP 8.6B, solo lectura)
  @Get('requirements')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  requirements(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.requirements(courseId, access.effectiveOwnerId);
  }

  // PUT /api/v1/courses/:courseId/academic-context/requirements/selection  body { groupId, optionId | null }
  // LOOP 8.6B: la alternativa (S/M/L…) que elige el docente. Solo cambia qué requisitos se leen como activos.
  @Put('requirements/selection')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  requirementSelection(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: RequirementSelectionDto, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.setRequirementSelection(courseId, access.effectiveOwnerId, dto.groupId, dto.optionId ?? null);
  }

  // GET /api/v1/courses/:courseId/academic-context/design → sugerencias al perfil, estructura propuesta y vínculos.
  @Get('design')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  design(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.service.design(courseId, access.effectiveOwnerId);
  }
}
