import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ProductionJobsService } from './production-jobs.service';
import { CreateJobDto } from './dto/create-job.dto';
import { CreateContentJobDto } from './dto/create-content-job.dto';
import { CreateVideoJobDto } from './dto/create-video-job.dto';
import { CreateAudioJobDto } from './dto/create-audio-job.dto';
import { CreateH5PJobDto } from './dto/create-h5p-job.dto';
import { CreatePackageJobDto } from './dto/create-package-job.dto';
import { CreateFullCourseJobDto } from './dto/create-full-course-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { UpdateStepDto } from './dto/update-step.dto';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';

@Controller('jobs')
@UseGuards(SupabaseJwtGuard)
export class ProductionJobsController {
  constructor(private readonly jobsService: ProductionJobsService) {}

  /**
   * POST /api/v1/jobs
   * Crea un production job. Llamado al inicio de startCompleteCourseProduction().
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateJobDto,
    @CurrentUser() user: AuthUser,
  ) {
    const job = await this.jobsService.create(dto, user.id);
    return { ok: true, data: job };
  }

  /**
   * POST /api/v1/jobs/content
   * Crea un production_job preparado para generación backend del paso content.
   */
  @Post('content')
  @HttpCode(HttpStatus.CREATED)
  async createContentJob(
    @Body() dto: CreateContentJobDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.jobsService.createContentJob(user.id, dto);
  }

  /**
   * POST /api/v1/jobs/videos
   * Crea un production_job preparado para generación backend del paso videos.
   */
  @Post('videos')
  @HttpCode(HttpStatus.CREATED)
  async createVideoJob(
    @Body() dto: CreateVideoJobDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.jobsService.createVideoJob(user.id, dto);
  }

  /**
   * POST /api/v1/jobs/audio
   * Crea un production_job preparado para generación backend del paso audio.
   * Si ya existe un job activo para el curso, devuelve ese job (idempotente).
   */
  @Post('audio')
  @HttpCode(HttpStatus.CREATED)
  async createAudioJob(
    @Body() dto: CreateAudioJobDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.jobsService.createAudioJob(user.id, dto);
  }

  /**
   * POST /api/v1/jobs/h5p
   * Crea un production_job para generar actividades interactivas y guardarlas.
   * Idempotente — si ya hay un job activo para el curso, lo devuelve.
   */
  @Post('h5p')
  @HttpCode(HttpStatus.CREATED)
  async createH5PJob(
    @Body() dto: CreateH5PJobDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.jobsService.createH5PJob(user.id, dto);
  }

  /**
   * POST /api/v1/jobs/package
   * Crea un production_job para generación backend del paquete Moodle.
   * Idempotente — si ya hay un job activo para el curso, lo devuelve.
   */
  @Post('package')
  @HttpCode(HttpStatus.CREATED)
  async createPackageJob(
    @Body() dto: CreatePackageJobDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.jobsService.createPackageJob(user.id, dto);
  }

  /**
   * GET /api/v1/jobs
   * Lista todos los jobs del usuario. Opcionalmente filtrado por course_id.
   */
  @Get()
  async findAll(
    @CurrentUser() user: AuthUser,
    @Query('course_id') courseId?: string,
  ) {
    const jobs = await this.jobsService.findAll(user.id, courseId);
    return { ok: true, data: { jobs } };
  }

  /**
   * GET /api/v1/jobs/:id
   * Lee un job con sus steps.
   */
  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const job = await this.jobsService.findOne(id, user.id);
    return { ok: true, data: job };
  }

  /**
   * PATCH /api/v1/jobs/:id
   * Actualiza el estado global del job.
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateJobDto,
    @CurrentUser() user: AuthUser,
  ) {
    const job = await this.jobsService.update(id, dto, user.id);
    return { ok: true, data: job };
  }

  /**
   * PATCH /api/v1/jobs/:id/steps/:stepKey
   * Actualiza (o crea) un step del pipeline.
   */
  @Patch(':id/steps/:stepKey')
  async updateStep(
    @Param('id') id: string,
    @Param('stepKey') stepKey: string,
    @Body() dto: UpdateStepDto,
    @CurrentUser() user: AuthUser,
  ) {
    const step = await this.jobsService.updateStep(id, stepKey, dto, user.id);
    return { ok: true, data: step };
  }

  /**
   * POST /api/v1/jobs/full
   * Crea (o reanuda) un job maestro course_full_generation para el curso.
   * El full-course-worker coordina todos los pasos: content → audio → videos → h5p → package.
   * Idempotente: si ya hay un job activo para el curso, lo devuelve.
   */
  @Post('full')
  @HttpCode(HttpStatus.CREATED)
  async createFullCourseJob(
    @Body() dto: CreateFullCourseJobDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.jobsService.createFullCourseJob(user.id, dto);
  }

  /**
   * POST /api/v1/jobs/:id/requeue
   *
   * Reactiva un job de video bloqueado (failed_recoverable) para que el worker
   * lo retome. Conserva youtubeUploads para evitar duplicados.
   *
   * Casos de uso:
   *  - Usuario reconectó YouTube (blocked_auth → requeue → worker sube pendientes)
   *  - Cuota restablecida (blocked_quota → requeue → worker reintenta al día siguiente)
   */
  @Post(':id/requeue')
  @HttpCode(HttpStatus.OK)
  async requeue(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.jobsService.requeueVideoJob(id, user.id);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true };
  }

  /**
   * POST /api/v1/jobs/:id/retry
   * Reactiva un job maestro course_full_generation que quedó en estado recuperable.
   * Conserva el outputSummary para que el worker aplique restore-first y no repita pasos.
   *
   * Casos de uso:
   *  - Job falló en un paso retryable (failed_retryable)
   *  - YouTube se reconectó (needs_reconnect → retry + requeue video job)
   *  - Cuota restablecida al día siguiente (blocked_quota)
   */
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  async retryFullCourseJob(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.jobsService.requeueFullCourseJob(id, user.id);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true };
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelJob(
    @Param('id') id: string,
    @Body('reason') reason: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.jobsService.cancelJob(id, user.id, reason);
    return {
      ok: true,
      data: {
        job: result.job,
        cancelledJobIds: result.cancelledJobIds,
        cascadedChildJobIds: result.cascadedChildJobIds,
      },
    };
  }
}
