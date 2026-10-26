import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional } from 'class-validator';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { Access } from '../authz/access.decorator';
import type { AccessContext } from '../authz/access-context';
import { RequirePermission } from '../authz/require-permission.decorator';
import { VisualDesignService } from './visual-design.service';

export class VisualDesignPreviewDto {
  /** Perfil de presentación COMPLETO a previsualizar (mismo esquema que POST /profiles/presentation). */
  @IsObject()
  data: Record<string, unknown>;

  /** true = también devuelve el .mbz del curso de muestra (base64) para restaurarlo en Moodle. */
  @IsBoolean()
  @IsOptional()
  includePackage?: boolean;
}

/**
 * r76 «Diseño visual» (V2; listado en features/dynamic-routes.ts: 404 con DYNAMIC_COURSE_STRUCTURE apagado).
 * Solo lectura: guardar el diseño es POST /courses/:id/profiles/presentation (courses.edit).
 */
@Controller('courses/:courseId/visual-design')
@UseGuards(SupabaseJwtGuard)
export class VisualDesignController {
  constructor(private readonly visual: VisualDesignService) {}

  // GET /api/v1/courses/:courseId/visual-design[?paletteId=…] → perfil vigente, familias, marca de la cuenta, autoría.
  @Get()
  @RequirePermission('courses.view', { course: 'param:courseId' })
  context(@Param('courseId', ParseIntPipe) courseId: number, @Access() access: AccessContext, @Query('paletteId') paletteId?: string) {
    return this.visual.context(courseId, access.effectiveOwnerId, access.actorId, typeof paletteId === 'string' ? paletteId.slice(0, 64) : null);
  }

  // POST /api/v1/courses/:courseId/visual-design/preview  body { data, includePackage? }
  // Arma con el builder real un curso de muestra con ese diseño (sin IA, sin escribir nada) y devuelve sus materiales.
  @Post('preview')
  @HttpCode(200)
  @RequirePermission('courses.view', { course: 'param:courseId' })
  preview(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: VisualDesignPreviewDto, @Access() access: AccessContext) {
    return this.visual.preview(courseId, access.effectiveOwnerId, dto.data, { includePackage: dto.includePackage === true });
  }
}
