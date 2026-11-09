import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { AuthenticatedOnly } from '../authz/require-permission.decorator';
import { CourseWorkshopFlagGuard } from './course-workshop-flag.guard';
import { CourseWorkshopService, WorkshopActor } from './course-workshop.service';
import { CreateWorkshopSessionDto } from './dto/create-workshop-session.dto';

const actorOf = (user: AuthUser): WorkshopActor => ({ id: user.id, email: user.email });

/**
 * r107 B1 · Taller de cursos — ingesta + identificación (validation/r107-taller/00-diseno-loop.md §4). Detrás del flag
 * COURSE_WORKSHOP (+ lista de dueños): apagado → 404 en todo. Permisos en el servicio: el dueño, SuperAdmin, y con
 * CURSIA_RBAC_MODE=enforce un miembro de la institución de la sesión con el permiso; lo ajeno responde 404.
 */
@AuthenticatedOnly('sesiones del Taller: dueño / SuperAdmin / miembro de la institución con permiso (lo verifica CourseWorkshopService; lo ajeno → 404)')
@Controller('course-workshop')
@UseGuards(SupabaseJwtGuard, CourseWorkshopFlagGuard) // flag antes que los pipes: apagado → 404 con cualquier cuerpo
export class CourseWorkshopController {
  constructor(private readonly workshop: CourseWorkshopService) {}

  // POST /api/v1/course-workshop/sessions { filename, sizeBytes } → { session, upload: { method, url?, token?, bucket, storagePath, maxBytes } }
  @Post('sessions')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: CreateWorkshopSessionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.workshop.createSession(actorOf(user), { filename: body.filename, sizeBytes: body.sizeBytes }, CourseWorkshopService.institutionHeaderOf(req.headers as Record<string, unknown>));
  }

  // POST /api/v1/course-workshop/sessions/:id/uploaded → 202 + sesión (`identifying`; sondear GET /:id); 409 WORKSHOP_UPLOAD_NOT_FOUND
  @Post('sessions/:id/uploaded')
  @HttpCode(HttpStatus.ACCEPTED)
  uploaded(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.workshop.markUploaded(actorOf(user), id);
  }

  // GET /api/v1/course-workshop/sessions/:id → sesión (estado, familia, curso identificado, método y confianza)
  @Get('sessions/:id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.workshop.get(actorOf(user), id);
  }

  // r107 B2 · GET /api/v1/course-workshop/sessions/:id/inventory → { status: ready | building | failed, inventory, error }
  // (409 WORKSHOP_NOT_IDENTIFIED si la sesión todavía no se identificó). Mismas compuertas que GET /:id.
  @Get('sessions/:id/inventory')
  inventory(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.workshop.getInventory(actorOf(user), id);
  }
}
