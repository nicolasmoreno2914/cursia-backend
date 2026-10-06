import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { AcademicContextService } from './academic-context.service';
import { ExtractAcademicContextDto } from './dto/extract.dto';

/**
 * Fase 3 — Contexto académico (controller V2: listado en features/dynamic-routes.ts, 404 con la estructura dinámica
 * apagada). Guardar el contexto: POST /courses/:courseId/profiles/academic (perfiles versionados).
 */
@Controller('courses/:courseId/academic-context')
@UseGuards(SupabaseJwtGuard)
export class AcademicContextController {
  constructor(private readonly service: AcademicContextService) {}

  // POST /api/v1/courses/:courseId/academic-context/extract  body { files: [{ name, dataBase64 }] }
  // → { draft, validation, notes, stats } — determinista, sin proveedores, NO guarda nada.
  @Post('extract')
  @HttpCode(200)
  extract(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: ExtractAcademicContextDto, @CurrentUser() user: AuthUser) {
    return this.service.extract(courseId, user.id, dto);
  }

  // GET /api/v1/courses/:courseId/academic-context/design → sugerencias al perfil, estructura propuesta y vínculos.
  @Get('design')
  design(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser) {
    return this.service.design(courseId, user.id);
  }
}
