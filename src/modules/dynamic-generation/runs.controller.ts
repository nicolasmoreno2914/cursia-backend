import {
  BadRequestException,
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
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { RunsService, YoutubeResolutionAction, publicPreview, publicVideoUpgradePreview } from './runs.service';
import { CourseContextDto } from './dto/course-context.dto';
import { RetryItemDto } from './dto/executor.dto';
import { parseRegenerateItemBody } from './dto/regenerate-item.dto';
import { FromRunDto, isFromRunRequest } from '../invalidation/dto/from-run.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

/**
 * Runs de generación dinámica de un Manifest (Fase 5A). Ownership + `dynamic`
 * + existencia del Manifest vía GenerationManifestsService.get: curso ajeno o
 * inexistente / Manifest no creado → 404, curso legacy → 400.
 */
const START_BODY_PIPE = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

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
  // Fase 8 (F8-BE): body = {fromRun: <runA>} → crea el run B aplicando el
  // plan de invalidación (contexto/videoMode heredados de A); idempotente por
  // (A, Manifest): 201 al crearlo, 200 si ya existía.
  @Post()
  async start(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    // El body es uno de dos DTOs: se valida acá con las MISMAS opciones que el
    // ValidationPipe global de main.ts (con un tipo unión, el pipe global no
    // valida nada).
    const dto: CourseContextDto | FromRunDto = await START_BODY_PIPE.transform(body, {
      type: 'body',
      metatype: isFromRunRequest(body) ? FromRunDto : CourseContextDto,
    });
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

  // GET /api/v1/courses/:courseId/blueprints/:number/manifest/runs/estimate
  // R17: videoCount/ids del Manifest + costo estimado de video (best-effort,
  // desde cost_rates; null + nota si no hay tarifa configurada). Declarado
  // ANTES de ':runId' — si no, Nest intentaría parsear "estimate" como UUID.
  @Get('estimate')
  estimate(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runs.estimateRun(courseId, user.id, number);
  }

  // POST /api/v1/courses/:courseId/blueprints/:number/manifest/runs/estimate-preview
  // Flujo normal: estimado COMPLETO (totales, por familia/proveedor/tipo),
  // conteos, decisión de presupuesto y si ESTE usuario puede aprobar. Body =
  // CourseContext (el mismo que POST …/runs). Solo lectura: no crea nada.
  @Post('estimate-preview')
  @HttpCode(HttpStatus.OK)
  async estimatePreview(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
  ) {
    const dto: CourseContextDto = await START_BODY_PIPE.transform(body, { type: 'body', metatype: CourseContextDto });
    return publicPreview(await this.runs.previewStart(courseId, { id: user.id, email: user.email }, number, dto));
  }

  // POST /api/v1/courses/:courseId/blueprints/:number/manifest/runs/approve-and-start
  // «Autorizar y generar»: body = CourseContext + estimateHash (la huella del
  // estimado que vio el usuario). Rol, monto y vigencia se deciden en el
  // servidor; 201 si se creó el run, 200 si ya existía.
  @Post('approve-and-start')
  async approveAndStart(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { estimateHash, ...rest } = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    if (typeof estimateHash !== 'string' || !/^[0-9a-f]{64}$/.test(estimateHash)) {
      throw new BadRequestException('estimateHash es obligatorio (la huella del estimado que se mostró)');
    }
    const dto: CourseContextDto = await START_BODY_PIPE.transform(rest, { type: 'body', metatype: CourseContextDto });
    const result = await this.runs.approveAndStart(courseId, { id: user.id, email: user.email }, number, dto, estimateHash);
    res.status(result.created ? 201 : 200);
    return result;
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
    return this.runs.cancelRun(courseId, user.id, number, runId, { id: user.id, email: user.email });
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
    @Body() dto: RetryItemDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runs.retryItem(courseId, user.id, number, runId, itemKey, dto?.resubmitVideo === true, dto?.resubmitProvider === true, undefined, { id: user.id, email: user.email });
  }

  // POST /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/items/:itemKey/youtube-resolution
  // DN-1: resolución explícita de una subida a YouTube ambigua (nunca automática).
  // Body: {"action":"confirm_existing","youtubeVideoId":"<11 chars>"} | {"action":"authorize_reupload"}.
  // 200 con el item (vuelve a pending; el worker solo finaliza o re-sube UNA vez, sin Videogen).
  @Post(':runId/items/:itemKey/youtube-resolution')
  @HttpCode(HttpStatus.OK)
  resolveYoutube(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('itemKey') itemKey: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
  ) {
    const b = body && typeof body === 'object' ? body : {};
    const extra = Object.keys(b).filter((k) => k !== 'action' && k !== 'youtubeVideoId');
    if (extra.length > 0) throw new BadRequestException(`campos no permitidos: ${extra.join(', ')}`);
    const action = b.action as YoutubeResolutionAction;
    const videoId = b.youtubeVideoId === undefined ? undefined : String(b.youtubeVideoId);
    return this.runs.resolveYoutubeUpload(courseId, user.id, number, runId, itemKey, action, videoId);
  }

  // POST /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/video-upgrade/preview
  // EV6 T5 B2: «Generar videos reales» — vista previa SOLO lectura (videos pendientes del run,
  // estimado USD de exactamente eso, aprobación y trabas). Sin body.
  @Post(':runId/video-upgrade/preview')
  @HttpCode(HttpStatus.OK)
  async videoUpgradePreview(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return publicVideoUpgradePreview(await this.runs.previewVideoUpgrade(courseId, { id: user.id, email: user.email }, number, runId));
  }

  // POST /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/video-upgrade
  // Body {estimateHash} (la huella de la vista previa que vio el usuario). 201 si se creó el
  // upgrade; 200 si ya existía (idempotente: nunca un segundo juego de videos pagos).
  @Post(':runId/video-upgrade')
  async videoUpgrade(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const extra = Object.keys(b).filter((k) => k !== 'estimateHash');
    if (extra.length > 0) throw new BadRequestException(`campos no permitidos: ${extra.join(', ')}`);
    const estimateHash = b.estimateHash;
    if (typeof estimateHash !== 'string' || !/^[0-9a-f]{64}$/.test(estimateHash)) {
      throw new BadRequestException('estimateHash es obligatorio (la huella del estimado que se mostró)');
    }
    const result = await this.runs.confirmVideoUpgrade(courseId, { id: user.id, email: user.email }, number, runId, estimateHash);
    res.status(result.created ? 201 : 200);
    return result;
  }

  // POST /api/v1/courses/:courseId/blueprints/:number/manifest/runs/:runId/items/:itemKey/regenerate
  // F78-BE2: body {confirmPaid: true, expectedGeneration?: n} (confirmPaid
  // obligatorio si la regeneración cuesta: video real o items LLM). Crea una
  // generación NUEVA del item en el mismo run (nunca reescribe la anterior).
  // 201 si se creó; 200 si ya había una regeneración de ese item en vuelo.
  // {dryRun: true} → 200 con el plan (affected + blockers), sin escribir nada.
  @Post(':runId/items/:itemKey/regenerate')
  async regenerate(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Param('number', ParseIntPipe) number: number,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('itemKey') itemKey: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const opts = parseRegenerateItemBody(body);
    const result = await this.runs.regenerateItem(courseId, user.id, number, runId, itemKey, opts);
    // dryRun → 200 (no escribe); real → 201 si creó, 200 si ya estaba en vuelo.
    res.status('dryRun' in result ? 200 : result.created ? 201 : 200);
    return result;
  }
}
