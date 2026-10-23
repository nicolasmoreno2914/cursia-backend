import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional, IsUUID } from 'class-validator';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { ChangeImpactService } from './change-impact.service';

export class ChangeImpactDto {
  @IsUUID()
  @IsOptional()
  fromRunId?: string;

  @IsObject()
  @IsOptional()
  profile?: Record<string, unknown>;

  @IsBoolean()
  @IsOptional()
  applyDistribution?: boolean;
}

/**
 * Fase 5 — vista previa del impacto de los cambios (controller V2: features/dynamic-routes.ts). Solo lectura, sin
 * proveedores: qué se regeneraría, qué queda intacto y cuánto costaría, antes de confirmar nada.
 */
@Controller('courses/:courseId/change-impact')
@UseGuards(SupabaseJwtGuard)
export class ChangeImpactController {
  constructor(private readonly service: ChangeImpactService) {}

  // POST /api/v1/courses/:courseId/change-impact  body { fromRunId?, profile?, applyDistribution? }
  @Post()
  @HttpCode(200)
  preview(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: ChangeImpactDto, @CurrentUser() user: AuthUser) {
    return this.service.preview(courseId, user.id, dto);
  }
}
