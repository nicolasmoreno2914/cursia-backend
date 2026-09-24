import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { RunsService } from './runs.service';
import { CourseContextDto } from './dto/course-context.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

/**
 * Runs de generación dinámica de un Manifest (Fase 5A). Ownership + `dynamic`
 * + existencia del Manifest vía GenerationManifestsService.get: curso ajeno o
 * inexistente / Manifest no creado → 404, curso legacy → 400.
 */
@Controller('courses/:courseId/blueprints/:number/manifest/runs')
@UseGuards(SupabaseJwtGuard)
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  // POST /api/v1/courses/:courseId/blueprints/:number/manifest/runs
  // Get-or-create: 201 si se creó el run; 200 si ya había uno activo con el
  // mismo contexto o si se reabrió uno cancelled/failed con el mismo contexto
  // (reopened:true, R10); 409 si el contexto difiere del run activo/anterior
  // (cambiarlo es regeneración, Fase 8) o si el run anterior está completed.
  // Body = CourseContext (se normaliza y se congela).
  @Post()
  async start(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Body() dto: CourseContextDto,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.runs.startRun(courseId, user.id, number, dto);
    res.status(result.created ? 201 : 200);
    return result;
  }

  // GET /api/v1/courses/:courseId/blueprints/:number/manifest/runs
  // R11: run activo si hay, si no el más reciente, si no null (200). Mismo
  // shape que GET …/runs/:runId (con progreso). La UI reanuda con esto tras
  // recargar, sin reenviar contexto.
  @Get()
  current(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runs.getCurrentRun(courseId, user.id, number);
  }

  // GET /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId
  @Get(':runId')
  get(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runs.getRun(courseId, user.id, number, runId);
  }

  // POST /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/cancel
  @Post(':runId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runs.cancelRun(courseId, user.id, number, runId);
  }

  // POST /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/items/:itemKey/retry
  // itemKey va URL-encoded (p.ej. content%3A<uuid>); Express lo decodifica.
  @Post(':runId/items/:itemKey/retry')
  @HttpCode(HttpStatus.OK)
  retry(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('itemKey') itemKey: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runs.retryItem(courseId, user.id, number, runId, itemKey);
  }
}
