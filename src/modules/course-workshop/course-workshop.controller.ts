import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { AuthenticatedOnly } from '../authz/require-permission.decorator';
import { CourseWorkshopFlagGuard } from './course-workshop-flag.guard';
import { CourseWorkshopService, WorkshopActor } from './course-workshop.service';
import { CreateWorkshopSessionDto } from './dto/create-workshop-session.dto';
import { AnswerRequestDto, ApplyPlanDto, ConfirmSpendDto, CreateDocumentRequestDto, CreateTextRequestDto, GenerateItemsDto } from './dto/plan.dto';
import { WorkshopPlanService } from './plan/workshop-plan.service';
import { WorkshopApplyService } from './apply/workshop-apply.service';

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
  constructor(private readonly workshop: CourseWorkshopService, private readonly plan: WorkshopPlanService, private readonly versions: WorkshopApplyService) {}

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

  // r107 B3 · POST /api/v1/course-workshop/sessions/:id/diagnosis → 202 { status: running | ready | failed, report… }:
  // corre el diagnóstico técnico (T01–T12, USD 0). Idempotente: uno por versión del original; re-POST = el mismo.
  // 409 WORKSHOP_NOT_IDENTIFIED / WORKSHOP_ORIGINAL_CHANGED / WORKSHOP_ORIGINAL_MISSING. Mismas compuertas que B1.
  @Post('sessions/:id/diagnosis')
  @HttpCode(HttpStatus.ACCEPTED)
  diagnose(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.workshop.startDiagnosis(actorOf(user), id);
  }

  // r107 B3 · GET /api/v1/course-workshop/sessions/:id/diagnosis → { status: not_started | running | ready | failed, report }
  // (informe con semáforo por curso / capítulo / actividad + hallazgos con su arreglo sugerido). Sondeo del navegador.
  @Get('sessions/:id/diagnosis')
  diagnosis(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.workshop.getDiagnosis(actorOf(user), id);
  }

  // ── r107 B5 · pedidos, preguntas y plan (IA con compuerta de saldo; el plan queda `draft`: aprobar y aplicar es B6) ──

  // POST /api/v1/course-workshop/sessions/:id/requests { text } → 201 entrada `awaiting_confirmation` con el COSTO ESTIMADO de
  // interpretarla y el tope propuesto. No llama a la IA (se aprueba con POST …/intakes/:intakeId/interpret).
  @Post('sessions/:id/requests')
  @HttpCode(HttpStatus.CREATED)
  createRequest(@Param('id') id: string, @Body() body: CreateTextRequestDto, @CurrentUser() user: AuthUser) {
    return this.plan.createTextIntake(actorOf(user), id, body.text);
  }

  // POST /api/v1/course-workshop/sessions/:id/requests/document { filename, sizeBytes } → { intake, upload } (URL firmada, ≤ 10 MB)
  @Post('sessions/:id/requests/document')
  @HttpCode(HttpStatus.CREATED)
  createDocumentRequest(@Param('id') id: string, @Body() body: CreateDocumentRequestDto, @CurrentUser() user: AuthUser) {
    return this.plan.createDocumentIntake(actorOf(user), id, { filename: body.filename, sizeBytes: body.sizeBytes });
  }

  // POST /api/v1/course-workshop/sessions/:id/intakes/:intakeId/interpret { confirmEstimateUsd, capUsd } → 202: aprueba el gasto,
  // RESERVA el tope en FinOps y recién entonces corre la IA (409 tope menor que el estimado / estimado distinto / sin saldo).
  @Post('sessions/:id/intakes/:intakeId/interpret')
  @HttpCode(HttpStatus.ACCEPTED)
  confirmInterpretation(@Param('id') id: string, @Param('intakeId') intakeId: string, @Body() body: ConfirmSpendDto, @CurrentUser() user: AuthUser) {
    return this.plan.confirmInterpretation(actorOf(user), id, intakeId, body);
  }

  // POST /api/v1/course-workshop/sessions/:id/requests/:requestId/interpret { confirmEstimateUsd, capUsd } → 202: re-interpretar con las respuestas
  @Post('sessions/:id/requests/:requestId/interpret')
  @HttpCode(HttpStatus.ACCEPTED)
  confirmReinterpretation(@Param('id') id: string, @Param('requestId') requestId: string, @Body() body: ConfirmSpendDto, @CurrentUser() user: AuthUser) {
    return this.plan.confirmReinterpretation(actorOf(user), id, requestId, body);
  }

  // POST /api/v1/course-workshop/sessions/:id/plans/:planId/generate { itemIds, confirmEstimateUsd, capUsd } → 202: genera el antes/después
  // de esos ítems dentro del tope aprobado (reservado en FinOps); si no alcanza, se corta limpio con el motivo
  @Post('sessions/:id/plans/:planId/generate')
  @HttpCode(HttpStatus.ACCEPTED)
  generate(@Param('id') id: string, @Param('planId') planId: string, @Body() body: GenerateItemsDto, @CurrentUser() user: AuthUser) {
    return this.plan.approveGeneration(actorOf(user), id, planId, body);
  }

  // POST /api/v1/course-workshop/sessions/:id/intakes/:intakeId/uploaded → 202 (409 WORKSHOP_DOCUMENT_NOT_UPLOADED)
  @Post('sessions/:id/intakes/:intakeId/uploaded')
  @HttpCode(HttpStatus.ACCEPTED)
  documentUploaded(@Param('id') id: string, @Param('intakeId') intakeId: string, @CurrentUser() user: AuthUser) {
    return this.plan.markDocumentUploaded(actorOf(user), id, intakeId);
  }

  // GET /api/v1/course-workshop/sessions/:id/requests → { intakes, requests } (estado, preguntas, motivos)
  @Get('sessions/:id/requests')
  requests(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.plan.listRequests(actorOf(user), id);
  }

  // POST /api/v1/course-workshop/sessions/:id/requests/:requestId/answers { answers: [{ questionId, optionId?, text? }] } → 202
  @Post('sessions/:id/requests/:requestId/answers')
  @HttpCode(HttpStatus.ACCEPTED)
  answer(@Param('id') id: string, @Param('requestId') requestId: string, @Body() body: AnswerRequestDto, @CurrentUser() user: AuthUser) {
    return this.plan.answer(actorOf(user), id, requestId, body.answers);
  }

  // DELETE /api/v1/course-workshop/sessions/:id/requests/:requestId → retirar el pedido (su ítem sale del plan)
  @Delete('sessions/:id/requests/:requestId')
  withdraw(@Param('id') id: string, @Param('requestId') requestId: string, @CurrentUser() user: AuthUser) {
    return this.plan.withdraw(actorOf(user), id, requestId);
  }

  // GET /api/v1/course-workshop/sessions/:id/plan → plan `draft` (ítems, pendientes, excluidos, totales, tope propuesto)
  @Get('sessions/:id/plan')
  getPlan(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.plan.getPlan(actorOf(user), id);
  }

  // POST /api/v1/course-workshop/sessions/:id/plan/items/:itemId/remove | restore → quitar / volver a agregar un ítem
  @Post('sessions/:id/plan/items/:itemId/remove')
  @HttpCode(HttpStatus.OK)
  removeItem(@Param('id') id: string, @Param('itemId') itemId: string, @CurrentUser() user: AuthUser) {
    return this.plan.setItemStatus(actorOf(user), id, itemId, 'removed');
  }

  @Post('sessions/:id/plan/items/:itemId/restore')
  @HttpCode(HttpStatus.OK)
  restoreItem(@Param('id') id: string, @Param('itemId') itemId: string, @CurrentUser() user: AuthUser) {
    return this.plan.setItemStatus(actorOf(user), id, itemId, 'proposed');
  }

  // POST /api/v1/course-workshop/sessions/:id/plan/items/:itemId/warnings/:warningId → el aviso de desalineación como pedido APARTE (202)
  @Post('sessions/:id/plan/items/:itemId/warnings/:warningId')
  @HttpCode(HttpStatus.ACCEPTED)
  addWarning(@Param('id') id: string, @Param('itemId') itemId: string, @Param('warningId') warningId: string, @CurrentUser() user: AuthUser) {
    return this.plan.addWarning(actorOf(user), id, itemId, warningId);
  }

  // POST /api/v1/course-workshop/sessions/:id/findings/:findingId/fix → «Arreglar esto» (202; idempotente por hallazgo)
  @Post('sessions/:id/findings/:findingId/fix')
  @HttpCode(HttpStatus.ACCEPTED)
  fixFinding(@Param('id') id: string, @Param('findingId') findingId: string, @CurrentUser() user: AuthUser) {
    return this.plan.fixFinding(actorOf(user), id, findingId);
  }

  // ── r107 B6 · aplicar el plan + versiones (D10) ──

  // POST /api/v1/course-workshop/sessions/:id/plans/:planId/apply { itemIds, confirmItemIds? } → 202 versión `queued` (sondear
  // GET …/versions/:versionId). 409: ítems sin generar / plan cambiado / falta confirmar uno por uno los de riesgo alto
  // (con los ids y los avisos) / prueba en seco vencida o que no pasa / plan ya aplicado. Aplicar la Fase 2 no usa IA.
  @Post('sessions/:id/plans/:planId/apply')
  @HttpCode(HttpStatus.ACCEPTED)
  apply(@Param('id') id: string, @Param('planId') planId: string, @Body() body: ApplyPlanDto, @CurrentUser() user: AuthUser) {
    return this.versions.apply(actorOf(user), id, planId, body);
  }

  // GET /api/v1/course-workshop/sessions/:id/versions → { chain: original → arreglo 1 → …, versions }
  @Get('sessions/:id/versions')
  listVersions(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.versions.listVersions(actorOf(user), id);
  }

  // GET /api/v1/course-workshop/sessions/:id/versions/:versionId → versión con su informe (antes/después por ítem), diagnóstico,
  // validación y restoreCheck (`not_available` en este entorno: «Verificado en su estructura; …»)
  @Get('sessions/:id/versions/:versionId')
  getVersion(@Param('id') id: string, @Param('versionId') versionId: string, @CurrentUser() user: AuthUser) {
    return this.versions.getVersion(actorOf(user), id, versionId);
  }

  // GET /api/v1/course-workshop/sessions/:id/versions/:versionId/download → URL firmada de 5 min (solo quien ve la sesión)
  @Get('sessions/:id/versions/:versionId/download')
  downloadVersion(@Param('id') id: string, @Param('versionId') versionId: string, @CurrentUser() user: AuthUser) {
    return this.versions.downloadVersion(actorOf(user), id, versionId);
  }

  // POST /api/v1/course-workshop/sessions/:id/versions/:versionId/session → 202 sesión HIJA cuyo original es esta versión
  // (encadenar arreglos: hereda el curso identificado y el alcance; no se sube nada). Idempotente: una por versión.
  @Post('sessions/:id/versions/:versionId/session')
  @HttpCode(HttpStatus.ACCEPTED)
  openChildSession(@Param('id') id: string, @Param('versionId') versionId: string, @CurrentUser() user: AuthUser) {
    return this.versions.openChildSession(actorOf(user), id, versionId);
  }
}
