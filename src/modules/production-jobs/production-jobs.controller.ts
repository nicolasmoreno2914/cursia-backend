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
}
