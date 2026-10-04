import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { CourseDryRunDto, InlineDryRunDto, RecommendPedagogyDto } from './dto/pedagogy.dto';
import { PedagogyService } from './pedagogy.service';

/**
 * Motor pedagógico V1. Controller V2 (listado en features/dynamic-routes.ts:
 * 404 con DYNAMIC_COURSE_STRUCTURE apagado). Ningún endpoint escribe ni llama
 * a proveedores: el perfil se guarda con POST /courses/:id/profiles/pedagogy.
 */
@Controller()
@UseGuards(SupabaseJwtGuard)
export class PedagogyController {
  constructor(private readonly pedagogyService: PedagogyService) {}

  // GET /api/v1/pedagogy/catalog → enfoques + etiquetas del vocabulario
  @Get('pedagogy/catalog')
  catalog() {
    return this.pedagogyService.catalog();
  }

  // GET /api/v1/pedagogy/wizard → las 6 preguntas de «No estoy seguro»
  @Get('pedagogy/wizard')
  wizard() {
    return this.pedagogyService.wizard();
  }

  // POST /api/v1/pedagogy/recommend { answers } → ranking con % y razones + perfil sugerido (no crea nada)
  @Post('pedagogy/recommend')
  @HttpCode(200)
  recommend(@Body() dto: RecommendPedagogyDto) {
    return this.pedagogyService.recommend(dto.answers);
  }

  // POST /api/v1/pedagogy/dry-run { structure, profile } → perfil → reglas → Blueprint → Manifest (sin proveedores)
  @Post('pedagogy/dry-run')
  @HttpCode(200)
  dryRunInline(@Body() dto: InlineDryRunDto) {
    return this.pedagogyService.dryRunInline(dto);
  }

  // POST /api/v1/courses/:courseId/pedagogy/dry-run { profile? } → dry-run de la estructura VIVA del curso
  @Post('courses/:courseId/pedagogy/dry-run')
  @HttpCode(200)
  dryRunCourse(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: CourseDryRunDto, @CurrentUser() user: AuthUser) {
    return this.pedagogyService.dryRunCourse(courseId, user.id, dto);
  }
}
