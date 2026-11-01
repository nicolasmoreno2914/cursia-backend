import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { AuthenticatedOnly } from '../authz/require-permission.decorator';
import { CreateMicrocurriculumDto, RegenerateSectionDto, UpdateMicrocurriculumDto } from './dto/microcurriculum.dto';
import { McActor, MicrocurriculumService } from './microcurriculum.service';

function sendPdf(res: Response, r: { pdf: Buffer; filename: string }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(r.pdf);
}
const actorOf = (user: AuthUser): McActor => ({ id: user.id, email: user.email });

/**
 * r81 · «Crear microcurrículo» (spec §4.3; contrato fijo en validation/r81-microcurriculo/plan.md). Rutas del propio
 * usuario (owner = sub del JWT; lo ajeno responde 404). Con MICROCURRICULUM_ENABLED ≠ 'true' todo responde 404 salvo
 * GET /microcurricula/quota → `{ enabled: false }` (el frontend oculta el menú).
 */
@AuthenticatedOnly('microcurrículos del propio usuario (owner = sub del JWT)')
@Controller('microcurricula')
@UseGuards(SupabaseJwtGuard)
export class MicrocurriculumController {
  constructor(private readonly mc: MicrocurriculumService) {}

  // GET /api/v1/microcurricula/quota → { enabled, unlimited, limit, used, remaining, resetsAt, regenLimit }
  @Get('quota')
  quota(@CurrentUser() user: AuthUser) {
    return this.mc.quota(actorOf(user));
  }

  // GET /api/v1/microcurricula → { items } (sin documento: título, estado y fechas)
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.mc.list(actorOf(user));
  }

  // POST /api/v1/microcurricula { answers? } → borrador de respuestas
  @Post()
  create(@Body() body: CreateMicrocurriculumDto, @CurrentUser() user: AuthUser) {
    return this.mc.create(actorOf(user), body?.answers ?? {});
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.mc.get(actorOf(user), id);
  }

  // PATCH /api/v1/microcurricula/:id { answers? (completas: reemplazan), document? } → record con `issues` y procedencia recalculados (USD 0)
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateMicrocurriculumDto, @CurrentUser() user: AuthUser) {
    return this.mc.update(actorOf(user), id, { answers: body?.answers, document: body?.document });
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.mc.remove(actorOf(user), id);
  }

  // POST /api/v1/microcurricula/:id/generate → record (síncrono ≤ 150 s; 400 ANSWERS_INCOMPLETE, 429 QUOTA_EXHAUSTED, 409)
  @Post(':id/generate')
  @HttpCode(HttpStatus.OK)
  generate(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.mc.generate(actorOf(user), id);
  }

  // POST /api/v1/microcurricula/:id/regenerate { section } → record (429 REGEN_EXHAUSTED; requiere status generated)
  @Post(':id/regenerate')
  @HttpCode(HttpStatus.OK)
  regenerate(@Param('id') id: string, @Body() body: RegenerateSectionDto, @CurrentUser() user: AuthUser) {
    return this.mc.regenerate(actorOf(user), id, body.section);
  }

  // GET /api/v1/microcurricula/:id/pdf → application/pdf (microcurriculo-<slug>.pdf)
  @Get(':id/pdf')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    sendPdf(res, await this.mc.pdf(actorOf(user), id));
  }

  // GET /api/v1/microcurricula/:id/academic-context → { context: AcademicContextV1 } (puente al flujo V2)
  @Get(':id/academic-context')
  academicContext(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.mc.academicContext(actorOf(user), id);
  }
}
