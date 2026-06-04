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
}
