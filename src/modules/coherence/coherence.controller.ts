import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CoherenceService } from './coherence.service';
import { LlmFindingsDto, StructureCoherenceDto } from './dto/coherence.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { Access } from '../authz/access.decorator';
import type { AccessContext } from '../authz/access-context';
import { RequirePermission } from '../authz/require-permission.decorator';

/**
 * Fase 7 (F7-BE): Coherence Engine. Controller 100% dynamic (clasificado en
 * features/dynamic-routes.ts: 404 con DYNAMIC_COURSE_STRUCTURE apagado).
 * Ownership + `dynamic` vía CourseBlueprintsService / GenerationManifestsService
 * (404 ajeno/inexistente, 400 legacy), igual que el resto de V2.
 */
@Controller('courses/:courseId')
@UseGuards(SupabaseJwtGuard)
export class CoherenceController {
  constructor(private readonly coherence: CoherenceService) {}

  // POST /api/v1/courses/:courseId/coherence/structure  {blueprintNumber?}
  // Capa estructural (S1–S3) sobre la estructura viva o un Blueprint. No persiste.
  @Post('coherence/structure')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('courses.view', { course: 'param:courseId' })
  structure(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: StructureCoherenceDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.coherence.structure(courseId, access.effectiveOwnerId, dto);
  }

  // POST /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/coherence
  // 201 si se guardó un reporte nuevo; 200 si ya existía uno con el mismo reportSha256.
  @Post('blueprints/:number/manifest/runs/:runId/coherence')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  async compute(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.coherence.computeRunReport(courseId, access.effectiveOwnerId, number, runId);
    res.status(out.created ? 201 : 200);
    return out;
  }

  // GET /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/quality
  // Loop 6 · Bloque 5: batería de calidad del run terminado (solo lectura, no persiste).
  @Get('blueprints/:number/manifest/runs/:runId/quality')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  quality(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.coherence.qualityReport(courseId, access.effectiveOwnerId, number, runId);
  }

  // GET /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/coherence
  @Get('blueprints/:number/manifest/runs/:runId/coherence')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  latest(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.coherence.latest(courseId, access.effectiveOwnerId, number, runId);
  }

  // GET /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/coherence/llm-input
  // F78-BE2: entrada compacta (acotada) para la revisión con IA del navegador.
  // Gate extra: DYNAMIC_COHERENCE_LLM (403 fail closed). Solo lectura.
  @Get('blueprints/:number/manifest/runs/:runId/coherence/llm-input')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  llmInput(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
  ) {
    return this.coherence.llmInput(courseId, access.effectiveOwnerId, number, runId);
  }

  // POST /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/coherence/llm-findings
  @Post('blueprints/:number/manifest/runs/:runId/coherence/llm-findings')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  async llm(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() dto: LlmFindingsDto,
    @CurrentUser() user: AuthUser,
    @Access() access: AccessContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.coherence.mergeLlm(courseId, access.effectiveOwnerId, number, runId, dto);
    res.status(out.created ? 201 : 200);
    return out;
  }
}
