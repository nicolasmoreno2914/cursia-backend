import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ProductionJob } from './entities/production-job.entity';
import { ProductionStep } from './entities/production-step.entity';
import { CreateJobDto } from './dto/create-job.dto';
import { CreateContentJobDto } from './dto/create-content-job.dto';
import { CreateVideoJobDto } from './dto/create-video-job.dto';
import { CreateAudioJobDto } from './dto/create-audio-job.dto';
import { CreateH5PJobDto } from './dto/create-h5p-job.dto';
import { CreatePackageJobDto } from './dto/create-package-job.dto';
import { CreateFullCourseJobDto } from './dto/create-full-course-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { UpdateStepDto } from './dto/update-step.dto';

/** Pasos estándar del pipeline (matching CP_STEP_DEFS en 31-course-production.js) */
const STANDARD_STEPS = [
  'prepare', 'content', 'activities', 'exams',
  'audio', 'preflight', 'videos', 'multimedia', 'package', 'save',
];

const SENSITIVE_KEY_RE = /(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|password)/i;

export interface ContentJobCreatedResponse {
  ok: true;
  jobId: string;
  status: string;
  workerStatus: string;
  executionMode: string;
  currentStep: string;
}

export interface ContentWorkerDryRunSummary {
  phase: 'dry_run';
  done: number;
  total: number;
  filesGenerated: number;
  message: string;
}

export interface VideoJobCreatedResponse {
  ok: true;
  jobId: string;
  status: string;
  workerStatus: string;
  executionMode: string;
  currentStep: string;
}

export interface VideoWorkerDryRunSummary {
  phase: 'dry_run';
  done: number;
  total: number;
  message: string;
}

export interface VideogenJobEntry {
  cap: number;
  title: string;
  jobId: string;
  status: string;
  clientReferenceId?: string | null;
  downloadUrl?: string | null;
  error?: string | null;
  progress?: number | null;
}

export interface VideoWorkerSubmitSummary {
  phase: 'submitted';
  submittedAt: string;
  total: number;
  batchId?: string | null;
  videogenJobs: VideogenJobEntry[];
}

export interface VideoWorkerPollingSummary {
  phase: 'polling';
  batchId: string;
  total: number;
  completed: number;
  failed: number;
  pending: number;
  videogenJobs: VideogenJobEntry[];
  lastPolledAt: string;
}

export interface VideoWorkerVideogenCompletedSummary {
  phase: 'videogen_completed';
  batchId: string;
  total: number;
  completed: number;
  failed: number;
  videogenJobs: VideogenJobEntry[];
  completedAt: string;
}

export interface YoutubeUploadEntry {
  cap: number;
  title: string;
  downloadUrl: string | null;
  youtubeVideoId: string | null;
  youtubeUrl: string | null;
  status: 'uploaded' | 'failed' | 'skipped' | 'quota_exceeded' | 'auth_required';
  error?: string | null;
}

export interface VideoWorkerYoutubeCompletedSummary {
  phase: 'youtube_completed';
  uploadedCount: number;
  failedUploadCount: number;
  youtubeUploads: YoutubeUploadEntry[];
  completedAt: string;
}

export interface VideoWorkerYoutubeBlockedSummary {
  phase: 'blocked_quota' | 'blocked_auth';
  reason: string;
  detail: string;
  youtubeUploads: YoutubeUploadEntry[];
  blockedAt: string;
}

export interface ContentWorkerProgressSummary {
  phase: string;
  done: number;
  total: number;
  file?: string | null;
  message?: string | null;
  filesGenerated?: number;
  progressMap?: Record<string, { done: number; total: number }>;
}

export interface AudioJobCreatedResponse {
  ok: true;
  jobId: string;
  status: string;
  workerStatus: string;
  executionMode: string;
  currentStep: string;
}

export interface AudioWorkerProgressSummary {
  phase: 'generating_welcome' | 'generating_audiobook' | string;
  message?: string | null;
  welcomeAudio?: Record<string, any>;
  audiobook?: Record<string, any>;
}

export interface H5PJobCreatedResponse {
  ok: true;
  jobId: string;
  status: string;
  workerStatus: string;
  executionMode: string;
  currentStep: string;
}

export interface H5PWorkerProgressSummary {
  phase:
    | 'checking_existing_h5p'
    | 'reading_course_content'
    | 'reading_video_urls'
    | 'creating_activities'
    | 'uploading_h5p_snapshot'
    | string;
  message?: string | null;
  activityCount?: number;
  chaptersWithActivities?: number[];
  chaptersSkipped?: number[];
  activities?: Array<Record<string, any>>;
}

export interface PackageJobCreatedResponse {
  ok: true;
  jobId: string;
  status: string;
  workerStatus: string;
  executionMode: string;
  currentStep: string;
}

@Injectable()
export class ProductionJobsService {
  private readonly logger = new Logger(ProductionJobsService.name);

  constructor(
    @InjectRepository(ProductionJob)
    private readonly jobRepo: Repository<ProductionJob>,
    @InjectRepository(ProductionStep)
    private readonly stepRepo: Repository<ProductionStep>,
    private readonly dataSource: DataSource,
  ) {}

  private sanitizePayload<T>(value: T): T {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizePayload(item)) as T;
    }

    if (value && typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [key, nestedValue] of Object.entries(value as Record<string, any>)) {
        if (SENSITIVE_KEY_RE.test(key)) continue;
        out[key] = this.sanitizePayload(nestedValue);
      }
      return out as T;
    }

    return value;
  }

  private getRetryBaseMs(): number {
    const raw = Number(process.env.CONTENT_WORKER_RETRY_BASE_MS ?? 30000);
    return Number.isFinite(raw) && raw > 0 ? raw : 30000;
  }

  private buildRetryDate(attemptCount: number): Date {
    const baseMs = this.getRetryBaseMs();
    const exponent = Math.max(0, attemptCount - 1);
    const delayMs = baseMs * Math.pow(2, exponent);
    return new Date(Date.now() + delayMs);
  }

  private appendOutputError(
    outputSummary: Record<string, any> | null | undefined,
    errorEntry: Record<string, any>,
  ): Record<string, any> {
    const summary = outputSummary && typeof outputSummary === 'object' ? { ...outputSummary } : {};
    const errors = Array.isArray(summary.errors) ? [...summary.errors] : [];
    errors.push(errorEntry);
    summary.errors = errors;
    return summary;
  }

  private async findJobForWorker(jobId: string, workerId: string): Promise<ProductionJob | null> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) return null;
    if (job.workerId !== workerId) return null;
    return job;
  }

  private async upsertWorkerStep(
    jobId: string,
    dto: Partial<ProductionStep>,
  ): Promise<ProductionStep> {
    let step = await this.stepRepo.findOne({ where: { jobId, stepKey: 'content' } });
    if (!step) {
      step = this.stepRepo.create({ jobId, stepKey: 'content' });
    }

    if (dto.status !== undefined) step.status = dto.status;
    if (dto.progress !== undefined) step.progress = dto.progress;
    if (dto.startedAt !== undefined) step.startedAt = dto.startedAt;
    if (dto.finishedAt !== undefined) step.finishedAt = dto.finishedAt;
    if (dto.error !== undefined) step.error = dto.error;
    if (dto.detail !== undefined) step.detail = dto.detail;
    if (dto.retries !== undefined) step.retries = dto.retries;

    return this.stepRepo.save(step);
  }

  // ── CREATE ──────────────────────────────────────────────────────────────────

  async create(dto: CreateJobDto, ownerId: string): Promise<ProductionJob> {
    // course_id from frontend can be numeric (backend ID) or UUID string (frontend ID)
    const rawCourseId = dto.course_id ?? null;
    const numericCourseId = rawCourseId ? parseInt(rawCourseId, 10) : NaN;

    const job = this.jobRepo.create({
      ownerId,
      courseId:          !isNaN(numericCourseId) ? numericCourseId : null,
      frontendCourseId: rawCourseId,
      frontendJobId:    dto.frontend_job_id ?? null,
      options:          dto.options ?? {},
      status:           'running',
      startedAt:        new Date(),
    });

    const saved = await this.jobRepo.save(job);

    // Pre-create all standard steps as 'pending'
    const steps = STANDARD_STEPS.map((key) =>
      this.stepRepo.create({
        jobId:   saved.id,
        stepKey: key,
        status:  'pending',
      }),
    );
    await this.stepRepo.save(steps);

    // Return with steps included
    return this.findOne(saved.id, ownerId);
  }

  async createContentJob(
    ownerId: string,
    dto: CreateContentJobDto,
  ): Promise<ContentJobCreatedResponse> {
    if (!dto.courseId) {
      throw new BadRequestException('courseId is required');
    }

    const sanitizedPayload = this.sanitizePayload({
      courseId: dto.courseId,
      frontendJobId: dto.frontendJobId ?? null,
      executionMode: 'backend_content',
      contentConfig: dto.contentConfig ?? {},
      courseData: dto.courseData,
      options: dto.options ?? {},
      metadata: dto.metadata ?? {},
    });

    const rawCourseId = dto.courseId;
    const numericCourseId = rawCourseId ? parseInt(rawCourseId, 10) : NaN;

    const existing = await this.jobRepo.findOne({
      where: {
        ownerId,
        frontendCourseId: rawCourseId,
        executionMode: 'backend_content',
        workerStatus: 'queued',
      },
      order: { createdAt: 'DESC' },
    });

    if (existing) {
      throw new ConflictException('A backend content job is already queued for this course');
    }

    const activeStatuses = ['queued', 'running', 'retrying'];
    const qb = this.jobRepo
      .createQueryBuilder('job')
      .where('job.owner_id = :ownerId', { ownerId })
      .andWhere('job.execution_mode = :executionMode', { executionMode: 'backend_content' })
      .andWhere('job.worker_status IN (:...activeStatuses)', { activeStatuses });

    if (!isNaN(numericCourseId)) {
      qb.andWhere('(job.course_id = :courseId OR job.frontend_course_id = :frontendCourseId)', {
        courseId: numericCourseId,
        frontendCourseId: rawCourseId,
      });
    } else {
      qb.andWhere('job.frontend_course_id = :frontendCourseId', {
        frontendCourseId: rawCourseId,
      });
    }

    const activeExisting = await qb.getOne();
    if (activeExisting) {
      throw new ConflictException('A backend content job is already active for this course');
    }

    const job = this.jobRepo.create({
      ownerId,
      courseId: !isNaN(numericCourseId) ? numericCourseId : null,
      frontendCourseId: rawCourseId,
      frontendJobId: dto.frontendJobId ?? null,
      options: dto.options ?? {},
      status: 'queued',
      currentStep: 'content',
      progress: 0,
      executionMode: 'backend_content',
      workerStatus: 'queued',
      inputPayload: sanitizedPayload,
      outputSummary: {},
      maxAttempts: dto.contentConfig?.maxRetriesPerFile ?? 3,
    });

    const saved = await this.jobRepo.save(job);

    let step = await this.stepRepo.findOne({
      where: { jobId: saved.id, stepKey: 'content' },
    });
    if (!step) {
      step = this.stepRepo.create({
        jobId: saved.id,
        stepKey: 'content',
      });
    }
    step.status = 'queued';
    step.progress = 0;
    step.detail = 'Esperando worker';
    await this.stepRepo.save(step);

    return {
      ok: true,
      jobId: saved.id,
      status: saved.status,
      workerStatus: saved.workerStatus,
      executionMode: saved.executionMode,
      currentStep: saved.currentStep,
    };
  }

  async createVideoJob(
    ownerId: string,
    dto: CreateVideoJobDto,
  ): Promise<VideoJobCreatedResponse> {
    if (!dto.courseId) {
      throw new BadRequestException('courseId is required');
    }

    const sanitizedPayload = this.sanitizePayload({
      courseId: dto.courseId,
      frontendJobId: dto.frontendJobId ?? null,
      executionMode: 'backend_videos',
      videoConfig: dto.videoConfig ?? {},
      courseData: dto.courseData,
      options: dto.options ?? {},
      metadata: dto.metadata ?? {},
    });

    const rawCourseId = dto.courseId;
    const numericCourseId = rawCourseId ? parseInt(rawCourseId, 10) : NaN;

    const activeStatuses = ['queued', 'running', 'retrying'];
    const qb = this.jobRepo
      .createQueryBuilder('job')
      .where('job.owner_id = :ownerId', { ownerId })
      .andWhere('job.execution_mode = :executionMode', { executionMode: 'backend_videos' })
      .andWhere('job.worker_status IN (:...activeStatuses)', { activeStatuses });

    if (!isNaN(numericCourseId)) {
      qb.andWhere('(job.course_id = :courseId OR job.frontend_course_id = :frontendCourseId)', {
        courseId: numericCourseId,
        frontendCourseId: rawCourseId,
      });
    } else {
      qb.andWhere('job.frontend_course_id = :frontendCourseId', {
        frontendCourseId: rawCourseId,
      });
    }

    const activeExisting = await qb.getOne();
    if (activeExisting) {
      throw new ConflictException('A backend video job is already active for this course');
    }

    const job = this.jobRepo.create({
      ownerId,
      courseId: !isNaN(numericCourseId) ? numericCourseId : null,
      frontendCourseId: rawCourseId,
      frontendJobId: dto.frontendJobId ?? null,
      options: dto.options ?? {},
      status: 'queued',
      currentStep: 'videos',
      progress: 0,
      executionMode: 'backend_videos',
      workerStatus: 'queued',
      inputPayload: sanitizedPayload,
      outputSummary: {},
    });

    const saved = await this.jobRepo.save(job);

    let step = await this.stepRepo.findOne({
      where: { jobId: saved.id, stepKey: 'videos' },
    });
    if (!step) {
      step = this.stepRepo.create({
        jobId: saved.id,
        stepKey: 'videos',
      });
    }
    step.status = 'queued';
    step.progress = 0;
    step.detail = 'Esperando worker';
    await this.stepRepo.save(step);

    return {
      ok: true,
      jobId: saved.id,
      status: saved.status,
      workerStatus: saved.workerStatus,
      executionMode: saved.executionMode,
      currentStep: saved.currentStep,
    };
  }

  async claimNextBackendVideoJob(
    workerId: string,
    leaseSeconds: number,
  ): Promise<ProductionJob | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const candidates = await queryRunner.query(
        `
          SELECT id
          FROM production_jobs
          WHERE execution_mode = 'backend_videos'
            AND worker_status IN ('queued', 'retrying')
            AND (next_retry_at IS NULL OR next_retry_at <= NOW())
            AND (lease_until IS NULL OR lease_until < NOW())
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
      );

      if (!Array.isArray(candidates) || candidates.length === 0) {
        await queryRunner.commitTransaction();
        return null;
      }

      const jobId = candidates[0].id;

      await queryRunner.query(
        `
          UPDATE production_jobs
          SET worker_status = 'running',
              status = 'running',
              current_step = 'videos',
              worker_id = $1,
              claimed_at = NOW(),
              lease_until = NOW() + ($2 * INTERVAL '1 second'),
              attempt_count = COALESCE(attempt_count, 0) + 1,
              started_at = COALESCE(started_at, NOW()),
              updated_at = NOW()
          WHERE id = $3
        `,
        [workerId, leaseSeconds, jobId],
      );

      await queryRunner.commitTransaction();

      this.logger.log(`Worker ${workerId} claimed backend_videos job ${jobId}`);
      return this.jobRepo.findOne({ where: { id: jobId }, relations: ['steps'] });
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async markVideoWorkerRunning(jobId: string, workerId: string): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    job.status = 'running';
    job.workerStatus = 'running';
    job.currentStep = 'videos';
    job.startedAt = job.startedAt ?? new Date();
    await this.jobRepo.save(job);

    await this.upsertVideoWorkerStep(jobId, {
      status: 'running',
      progress: 10,
      startedAt: new Date(),
      detail: 'Video worker running',
    });

    return true;
  }

  async completeVideoWorkerDryRun(
    jobId: string,
    workerId: string,
    summary: VideoWorkerDryRunSummary,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const now = new Date();
    job.status = 'completed';
    job.workerStatus = 'completed';
    job.currentStep = 'videos';
    job.progress = 100;
    job.finishedAt = now;
    job.leaseUntil = null;
    job.nextRetryAt = null;
    job.errorMessage = null;
    job.errorStep = null;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      ...summary,
      completedAt: now.toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertVideoWorkerStep(jobId, {
      status: 'completed',
      progress: 100,
      finishedAt: now,
      detail: summary.message,
      error: null,
    });

    return true;
  }

  async markVideoWorkerSubmitted(
    jobId: string,
    workerId: string,
    summary: VideoWorkerSubmitSummary,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    job.status = 'running';
    job.workerStatus = 'running';
    job.currentStep = 'videos';
    job.progress = 20;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      ...summary,
      updatedAt: new Date().toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertVideoWorkerStep(jobId, {
      status: 'running',
      progress: 20,
      detail: `Videos enviados a Videogen (${summary.total} jobs)`,
    });

    return true;
  }

  async claimNextBackendVideoPollingJob(
    workerId: string,
    leaseSeconds: number,
  ): Promise<ProductionJob | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const candidates = await queryRunner.query(
        `
          SELECT id
          FROM production_jobs
          WHERE execution_mode = 'backend_videos'
            AND worker_status = 'running'
            AND (lease_until IS NULL OR lease_until < NOW())
            AND output_summary->>'phase' IN ('submitted', 'polling', 'videogen_completed')
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
      );

      if (!Array.isArray(candidates) || candidates.length === 0) {
        await queryRunner.commitTransaction();
        return null;
      }

      const jobId = candidates[0].id;

      await queryRunner.query(
        `
          UPDATE production_jobs
          SET worker_id = $1,
              claimed_at = NOW(),
              lease_until = NOW() + ($2 * INTERVAL '1 second'),
              attempt_count = COALESCE(attempt_count, 0) + 1,
              updated_at = NOW()
          WHERE id = $3
        `,
        [workerId, leaseSeconds, jobId],
      );

      await queryRunner.commitTransaction();

      this.logger.log(`Worker ${workerId} re-claimed backend_videos polling job ${jobId}`);
      return this.jobRepo.findOne({ where: { id: jobId }, relations: ['steps'] });
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async markVideoWorkerPolling(
    jobId: string,
    workerId: string,
    summary: VideoWorkerPollingSummary,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const total = summary.total > 0 ? summary.total : 1;
    const completedRatio = Math.min(summary.completed, total) / total;
    const progress = Math.max(20, Math.min(95, Math.round(20 + completedRatio * 75)));

    job.status = 'running';
    job.workerStatus = 'running';
    job.currentStep = 'videos';
    job.progress = progress;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      ...summary,
      updatedAt: new Date().toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertVideoWorkerStep(jobId, {
      status: 'running',
      progress,
      detail: `Generando videos en Videogen: ${summary.completed}/${summary.total} listos`,
    });

    return true;
  }

  async completeVideoWorkerVideogen(
    jobId: string,
    workerId: string,
    summary: VideoWorkerVideogenCompletedSummary,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const now = new Date();
    job.status = 'completed';
    job.workerStatus = 'completed';
    job.currentStep = 'videos';
    job.progress = 100;
    job.finishedAt = now;
    job.leaseUntil = null;
    job.nextRetryAt = null;
    job.errorMessage = null;
    job.errorStep = null;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      ...summary,
      completedAt: now.toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertVideoWorkerStep(jobId, {
      status: 'completed',
      progress: 100,
      finishedAt: now,
      detail: `Videos completados en Videogen: ${summary.completed}/${summary.total}`,
      error: null,
    });

    return true;
  }

  async failVideoWorkerJob(
    jobId: string,
    workerId: string,
    error: Error | string,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const message =
      typeof error === 'string' ? error : error?.message || 'Unknown video worker error';
    const now = new Date();

    const errorEntry = {
      phase: 'worker',
      message,
      attempt: job.attemptCount ?? 0,
      workerId,
      at: now.toISOString(),
    };

    job.currentStep = 'videos';
    job.progress = Math.max(0, job.progress ?? 0);
    job.errorMessage = message;
    job.errorStep = 'videos';
    job.workerStatus = 'failed';
    job.status = 'failed';
    job.finishedAt = now;
    job.nextRetryAt = null;
    job.leaseUntil = null;
    job.outputSummary = this.appendOutputError(job.outputSummary, errorEntry);
    await this.jobRepo.save(job);

    await this.upsertVideoWorkerStep(jobId, {
      status: 'failed',
      finishedAt: now,
      detail: `Video worker failed: ${message}`,
      error: message,
    });

    return true;
  }

  async markVideogenDoneForYoutube(
    jobId: string,
    workerId: string,
    summary: VideoWorkerVideogenCompletedSummary,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    job.status = 'running';
    job.workerStatus = 'running';
    job.currentStep = 'videos';
    job.progress = 95;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      ...summary,
      updatedAt: new Date().toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertVideoWorkerStep(jobId, {
      status: 'running',
      progress: 95,
      detail: `Videogen completado (${summary.completed}/${summary.total}). Iniciando YouTube upload...`,
    });

    return true;
  }

  async markVideoWorkerYoutubeUploading(
    jobId: string,
    workerId: string,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    job.status = 'running';
    job.workerStatus = 'running';
    job.currentStep = 'videos';
    job.progress = 96;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      youtubePhase: 'uploading',
      updatedAt: new Date().toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertVideoWorkerStep(jobId, {
      status: 'running',
      progress: 96,
      detail: 'Subiendo videos a YouTube...',
    });

    return true;
  }

  async completeVideoWorkerYoutube(
    jobId: string,
    workerId: string,
    summary: VideoWorkerYoutubeCompletedSummary,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const now = new Date();
    job.status = 'completed';
    job.workerStatus = 'completed';
    job.currentStep = 'videos';
    job.progress = 100;
    job.finishedAt = now;
    job.leaseUntil = null;
    job.nextRetryAt = null;
    job.errorMessage = null;
    job.errorStep = null;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      ...summary,
      completedAt: now.toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertVideoWorkerStep(jobId, {
      status: 'completed',
      progress: 100,
      finishedAt: now,
      detail: `YouTube upload completado: ${summary.uploadedCount} videos subidos`,
      error: null,
    });

    return true;
  }

  async blockVideoWorkerYoutube(
    jobId: string,
    workerId: string,
    summary: VideoWorkerYoutubeBlockedSummary,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const now = new Date();
    const newStatus = summary.phase === 'blocked_quota' ? 'failed_recoverable' : 'failed_recoverable';
    job.status = newStatus;
    job.workerStatus = newStatus;
    job.currentStep = 'videos';
    job.errorMessage = summary.detail;
    job.errorStep = 'videos';
    job.leaseUntil = null;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      ...summary,
      updatedAt: now.toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertVideoWorkerStep(jobId, {
      status: 'failed',
      finishedAt: now,
      detail: summary.detail,
      error: summary.reason,
    });

    return true;
  }

  /**
   * Resets a blocked/failed_recoverable video job back to 'queued' so the worker
   * can pick it up again. Preserves outputSummary (and youtubeUploads) so the worker
   * skips videos already uploaded.
   *
   * Called after the user reconnects YouTube (blocked_auth) or when the user
   * manually retries after a quota reset (blocked_quota).
   */
  async requeueVideoJob(
    jobId:  string,
    userId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });

    if (!job) return { ok: false, reason: 'not_found' };
    if (job.ownerId !== userId) return { ok: false, reason: 'forbidden' };
    if (job.executionMode !== 'backend_videos') return { ok: false, reason: 'not_a_video_job' };

    const allowedStatuses = ['failed_recoverable', 'failed'];
    if (!allowedStatuses.includes(job.status)) {
      return { ok: false, reason: `status_not_retryable (current: ${job.status})` };
    }

    job.status       = 'queued';
    job.workerStatus = 'queued';
    job.workerId     = null as any;
    job.leaseUntil   = null as any;
    job.currentStep  = 'videos';
    job.progress     = Math.min(job.progress ?? 90, 92); // keep progress near YouTube phase
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      youtubePhase:   'pending_retry',
      requeuedAt:     new Date().toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertVideoWorkerStep(jobId, {
      status: 'pending',
      detail: 'En espera de continuar subida a YouTube…',
    });

    this.logger.log(`Video job ${jobId} requeued by user ${userId}`);
    return { ok: true };
  }

  async saveVideoSnapshotArtifactId(
    jobId: string,
    artifactId: string,
  ): Promise<boolean> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) return false;

    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      videoStateSnapshotArtifactId: artifactId,
      artifactIds: {
        ...((job.outputSummary?.artifactIds ?? {}) as Record<string, any>),
        videoStateSnapshot: artifactId,
      },
    };
    await this.jobRepo.save(job);
    this.logger.log(`Saved videoStateSnapshotArtifactId=${artifactId} for job ${jobId}`);
    return true;
  }

  private async upsertVideoWorkerStep(
    jobId: string,
    dto: Partial<ProductionStep>,
  ): Promise<ProductionStep> {
    let step = await this.stepRepo.findOne({ where: { jobId, stepKey: 'videos' } });
    if (!step) {
      step = this.stepRepo.create({ jobId, stepKey: 'videos' });
    }

    if (dto.status !== undefined) step.status = dto.status;
    if (dto.progress !== undefined) step.progress = dto.progress;
    if (dto.startedAt !== undefined) step.startedAt = dto.startedAt;
    if (dto.finishedAt !== undefined) step.finishedAt = dto.finishedAt;
    if (dto.error !== undefined) step.error = dto.error;
    if (dto.detail !== undefined) step.detail = dto.detail;

    return this.stepRepo.save(step);
  }

  async createAudioJob(
    ownerId: string,
    dto: CreateAudioJobDto,
  ): Promise<AudioJobCreatedResponse> {
    if (!dto.courseId) {
      throw new BadRequestException('courseId is required');
    }

    const sanitizedPayload = this.sanitizePayload({
      courseId: dto.courseId,
      frontendJobId: dto.frontendJobId ?? null,
      executionMode: 'backend_audio',
      courseData: dto.courseData,
      bookExcerpts: dto.bookExcerpts ?? {},
      contentSnapshotArtifactId: dto.contentSnapshotArtifactId ?? null,
      options: dto.options ?? {},
      metadata: dto.metadata ?? {},
    });

    const rawCourseId = dto.courseId;
    const numericCourseId = rawCourseId ? parseInt(rawCourseId, 10) : NaN;

    const activeStatuses = ['queued', 'running', 'retrying'];
    const qb = this.jobRepo
      .createQueryBuilder('job')
      .where('job.owner_id = :ownerId', { ownerId })
      .andWhere('job.execution_mode = :executionMode', { executionMode: 'backend_audio' })
      .andWhere('job.worker_status IN (:...activeStatuses)', { activeStatuses });

    if (!isNaN(numericCourseId)) {
      qb.andWhere('(job.course_id = :courseId OR job.frontend_course_id = :frontendCourseId)', {
        courseId: numericCourseId,
        frontendCourseId: rawCourseId,
      });
    } else {
      qb.andWhere('job.frontend_course_id = :frontendCourseId', {
        frontendCourseId: rawCourseId,
      });
    }

    const activeExisting = await qb.getOne();
    if (activeExisting) {
      // Return the existing job so the frontend can poll it
      return {
        ok: true,
        jobId: activeExisting.id,
        status: activeExisting.status,
        workerStatus: activeExisting.workerStatus,
        executionMode: activeExisting.executionMode,
        currentStep: activeExisting.currentStep,
      };
    }

    const job = this.jobRepo.create({
      ownerId,
      courseId: !isNaN(numericCourseId) ? numericCourseId : null,
      frontendCourseId: rawCourseId,
      frontendJobId: dto.frontendJobId ?? null,
      options: dto.options ?? {},
      status: 'queued',
      currentStep: 'audio',
      progress: 0,
      executionMode: 'backend_audio',
      workerStatus: 'queued',
      inputPayload: sanitizedPayload,
      outputSummary: {},
    });

    const saved = await this.jobRepo.save(job);

    let step = await this.stepRepo.findOne({
      where: { jobId: saved.id, stepKey: 'audio' },
    });
    if (!step) {
      step = this.stepRepo.create({ jobId: saved.id, stepKey: 'audio' });
    }
    step.status = 'queued';
    step.progress = 0;
    step.detail = 'Esperando worker de audio';
    await this.stepRepo.save(step);

    return {
      ok: true,
      jobId: saved.id,
      status: saved.status,
      workerStatus: saved.workerStatus,
      executionMode: saved.executionMode,
      currentStep: saved.currentStep,
    };
  }

  async claimNextBackendAudioJob(
    workerId: string,
    leaseSeconds: number,
  ): Promise<ProductionJob | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const candidates = await queryRunner.query(
        `
          SELECT id
          FROM production_jobs
          WHERE execution_mode = 'backend_audio'
            AND worker_status IN ('queued', 'retrying')
            AND (next_retry_at IS NULL OR next_retry_at <= NOW())
            AND (lease_until IS NULL OR lease_until < NOW())
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
      );

      if (!Array.isArray(candidates) || candidates.length === 0) {
        await queryRunner.commitTransaction();
        return null;
      }

      const jobId = candidates[0].id;

      await queryRunner.query(
        `
          UPDATE production_jobs
          SET worker_status = 'running',
              status = 'running',
              current_step = 'audio',
              worker_id = $1,
              claimed_at = NOW(),
              lease_until = NOW() + ($2 * INTERVAL '1 second'),
              attempt_count = COALESCE(attempt_count, 0) + 1,
              started_at = COALESCE(started_at, NOW()),
              updated_at = NOW()
          WHERE id = $3
        `,
        [workerId, leaseSeconds, jobId],
      );

      await queryRunner.commitTransaction();

      this.logger.log(`Worker ${workerId} claimed backend_audio job ${jobId}`);
      return this.jobRepo.findOne({ where: { id: jobId }, relations: ['steps'] });
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async markAudioWorkerRunning(jobId: string, workerId: string): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    job.status = 'running';
    job.workerStatus = 'running';
    job.currentStep = 'audio';
    job.startedAt = job.startedAt ?? new Date();
    await this.jobRepo.save(job);

    await this.upsertAudioWorkerStep(jobId, {
      status: 'running',
      progress: 5,
      startedAt: new Date(),
      detail: 'Audio worker iniciado',
    });

    return true;
  }

  async updateAudioWorkerProgress(
    jobId: string,
    workerId: string,
    summary: AudioWorkerProgressSummary,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const phaseProgress: Record<string, number> = {
      generating_welcome: 20,
      generating_audiobook: 60,
    };
    const approxProgress = phaseProgress[summary.phase] ?? Math.max(job.progress ?? 10, 10);

    job.status = 'running';
    job.workerStatus = 'running';
    job.currentStep = 'audio';
    job.progress = Math.min(95, approxProgress);
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      phase: summary.phase,
      message: summary.message ?? null,
      welcomeAudio: summary.welcomeAudio ?? (job.outputSummary?.welcomeAudio ?? {}),
      audiobook: summary.audiobook ?? (job.outputSummary?.audiobook ?? {}),
      updatedAt: new Date().toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertAudioWorkerStep(jobId, {
      status: 'running',
      progress: job.progress,
      detail: summary.message ?? `Audio: ${summary.phase}`,
    });

    return true;
  }

  async completeAudioWorkerJob(
    jobId: string,
    workerId: string,
    summary: Record<string, any>,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const now = new Date();
    const isPartial = summary.audiobook?.status === 'failed_retryable' || summary.audiobook?.status === 'skipped_optional';
    job.status = 'completed';
    job.workerStatus = 'completed';
    job.currentStep = 'audio';
    job.progress = 100;
    job.finishedAt = now;
    job.leaseUntil = null;
    job.nextRetryAt = null;
    job.errorMessage = null;
    job.errorStep = null;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      ...summary,
      phase: isPartial ? 'partial' : 'completed',
      completedAt: now.toISOString(),
    };
    await this.jobRepo.save(job);

    const detail = isPartial
      ? 'Audio de bienvenida listo. Audiolibro no disponible.'
      : 'Audio de bienvenida y audiolibro listos.';

    await this.upsertAudioWorkerStep(jobId, {
      status: 'completed',
      progress: 100,
      finishedAt: now,
      detail,
      error: null,
    });

    return true;
  }

  async failAudioWorkerJob(
    jobId: string,
    workerId: string,
    error: Error | string,
    retryable: boolean,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const message =
      typeof error === 'string' ? error : error?.message || 'Unknown audio worker error';
    const now = new Date();
    const attemptsRemaining = (job.attemptCount ?? 0) < (job.maxAttempts ?? 3);

    const errorEntry = {
      phase: 'worker',
      message,
      retryable,
      attempt: job.attemptCount ?? 0,
      workerId,
      at: now.toISOString(),
    };

    job.currentStep = 'audio';
    job.progress = Math.max(0, job.progress ?? 0);
    job.errorMessage = message;
    job.errorStep = 'audio';
    job.outputSummary = this.appendOutputError(job.outputSummary, errorEntry);

    if (retryable && attemptsRemaining) {
      job.workerStatus = 'retrying';
      job.status = 'retrying';
      job.nextRetryAt = this.buildRetryDate(job.attemptCount ?? 0);
      job.leaseUntil = null;
      job.workerId = null;
      job.retryCount = (job.retryCount ?? 0) + 1;
      await this.jobRepo.save(job);

      const existingStep = await this.stepRepo.findOne({ where: { jobId, stepKey: 'audio' } });
      await this.upsertAudioWorkerStep(jobId, {
        status: 'retrying',
        progress: existingStep?.progress ?? 5,
        detail: `Audio worker reintentando: ${message}`,
        error: message,
        retries: (existingStep?.retries ?? 0) + 1,
      });
      return true;
    }

    job.workerStatus = retryable ? 'failed_recoverable' : 'failed';
    job.status = retryable ? 'failed_recoverable' : 'failed';
    job.finishedAt = now;
    job.nextRetryAt = null;
    job.leaseUntil = null;
    await this.jobRepo.save(job);

    await this.upsertAudioWorkerStep(jobId, {
      status: 'failed',
      finishedAt: now,
      detail: `Audio worker falló: ${message}`,
      error: message,
    });

    return true;
  }

  // ── H5P job methods ───────────────────────────────────────────────────────

  async createH5PJob(
    ownerId: string,
    dto: CreateH5PJobDto,
  ): Promise<H5PJobCreatedResponse> {
    if (!dto.courseId) throw new BadRequestException('courseId is required');
    if (!dto.contentSnapshotArtifactId) {
      throw new BadRequestException('contentSnapshotArtifactId is required');
    }

    const rawCourseId = dto.courseId;
    const numericCourseId = rawCourseId ? parseInt(rawCourseId, 10) : NaN;
    const activeStatuses = ['queued', 'running', 'retrying'];

    const qb = this.jobRepo.createQueryBuilder('job')
      .where('job.owner_id = :ownerId', { ownerId })
      .andWhere('job.execution_mode = :executionMode', { executionMode: 'backend_h5p' })
      .andWhere('job.worker_status IN (:...activeStatuses)', { activeStatuses });

    if (!isNaN(numericCourseId)) {
      qb.andWhere('(job.course_id = :courseId OR job.frontend_course_id = :frontendCourseId)', {
        courseId: numericCourseId,
        frontendCourseId: rawCourseId,
      });
    } else {
      qb.andWhere('job.frontend_course_id = :frontendCourseId', { frontendCourseId: rawCourseId });
    }

    const activeExisting = await qb.getOne();
    if (activeExisting) {
      return {
        ok: true,
        jobId: activeExisting.id,
        status: activeExisting.status,
        workerStatus: activeExisting.workerStatus,
        executionMode: activeExisting.executionMode,
        currentStep: activeExisting.currentStep,
      };
    }

    const sanitized = this.sanitizePayload({
      courseId: rawCourseId,
      courseTitle: dto.courseTitle ?? null,
      executionMode: 'backend_h5p',
      contentSnapshotArtifactId: dto.contentSnapshotArtifactId,
      videoStateSnapshotArtifactId: dto.videoStateSnapshotArtifactId ?? null,
      youtubeUploads: dto.youtubeUploads ?? [],
      courseData: dto.courseData ?? {},
      options: {
        restoreFirst: dto.options?.restoreFirst !== false,
        requireYoutubeUrls: dto.options?.requireYoutubeUrls !== false,
      },
      metadata: dto.metadata ?? {},
    });

    const job = this.jobRepo.create({
      ownerId,
      courseId: !isNaN(numericCourseId) ? numericCourseId : null,
      frontendCourseId: rawCourseId,
      frontendJobId: dto.frontendJobId ?? null,
      options: dto.options ?? {},
      status: 'queued',
      currentStep: 'h5p',
      progress: 0,
      executionMode: 'backend_h5p',
      workerStatus: 'queued',
      inputPayload: sanitized,
      outputSummary: {},
    });
    const saved = await this.jobRepo.save(job);

    let step = await this.stepRepo.findOne({ where: { jobId: saved.id, stepKey: 'h5p' } });
    if (!step) step = this.stepRepo.create({ jobId: saved.id, stepKey: 'h5p' });
    step.status = 'queued';
    step.progress = 0;
    step.detail = 'Esperando preparación de actividades';
    await this.stepRepo.save(step);

    return {
      ok: true,
      jobId: saved.id,
      status: saved.status,
      workerStatus: saved.workerStatus,
      executionMode: saved.executionMode,
      currentStep: saved.currentStep,
    };
  }

  async claimNextBackendH5PJob(workerId: string, leaseSeconds: number): Promise<ProductionJob | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const candidates = await queryRunner.query(
        `SELECT id FROM production_jobs WHERE execution_mode = 'backend_h5p'
         AND worker_status IN ('queued','retrying')
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
         AND (lease_until IS NULL OR lease_until < NOW())
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!Array.isArray(candidates) || candidates.length === 0) {
        await queryRunner.commitTransaction();
        return null;
      }

      const jobId = candidates[0].id;
      await queryRunner.query(
        `UPDATE production_jobs SET worker_status='running', status='running', current_step='h5p',
         worker_id=$1, claimed_at=NOW(), lease_until=NOW()+($2*INTERVAL '1 second'),
         attempt_count=COALESCE(attempt_count,0)+1, started_at=COALESCE(started_at,NOW()), updated_at=NOW()
         WHERE id=$3`,
        [workerId, leaseSeconds, jobId],
      );

      await queryRunner.commitTransaction();
      this.logger.log(`Worker ${workerId} claimed backend_h5p job ${jobId}`);
      return this.jobRepo.findOne({ where: { id: jobId }, relations: ['steps'] });
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async markH5PWorkerRunning(jobId: string, workerId: string): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    job.status = 'running';
    job.workerStatus = 'running';
    job.currentStep = 'h5p';
    job.startedAt = job.startedAt ?? new Date();
    await this.jobRepo.save(job);

    await this.upsertH5PWorkerStep(jobId, {
      status: 'running',
      progress: 5,
      startedAt: new Date(),
      detail: 'Preparando actividades interactivas',
    });
    return true;
  }

  async updateH5PWorkerProgress(
    jobId: string,
    workerId: string,
    summary: H5PWorkerProgressSummary,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const phaseProgress: Record<string, number> = {
      checking_existing_h5p: 10,
      reading_course_content: 25,
      reading_video_urls: 45,
      creating_activities: 70,
      uploading_h5p_snapshot: 90,
    };

    job.status = 'running';
    job.workerStatus = 'running';
    job.currentStep = 'h5p';
    job.progress = Math.min(95, phaseProgress[summary.phase] ?? Math.max(job.progress ?? 10, 10));
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      phase: summary.phase,
      message: summary.message ?? null,
      activityCount: summary.activityCount ?? (job.outputSummary?.activityCount ?? 0),
      chaptersWithActivities: summary.chaptersWithActivities ?? (job.outputSummary?.chaptersWithActivities ?? []),
      chaptersSkipped: summary.chaptersSkipped ?? (job.outputSummary?.chaptersSkipped ?? []),
      activities: summary.activities ?? (job.outputSummary?.activities ?? []),
      updatedAt: new Date().toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertH5PWorkerStep(jobId, {
      status: 'running',
      progress: job.progress,
      detail: summary.message ?? 'Creando actividades',
    });
    return true;
  }

  async completeH5PWorkerJob(
    jobId: string,
    workerId: string,
    summary: Record<string, any>,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const now = new Date();
    const phase = summary.h5pSnapshot?.status === 'partial' ? 'partial' : 'completed';
    const detail = summary.h5pSnapshot?.humanMessage
      ?? (phase === 'partial' ? 'Actividades listas con algunas omisiones.' : 'Actividades listas.');

    job.status = 'completed';
    job.workerStatus = 'completed';
    job.currentStep = 'h5p';
    job.progress = 100;
    job.finishedAt = now;
    job.leaseUntil = null;
    job.nextRetryAt = null;
    job.errorMessage = null;
    job.errorStep = null;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      ...summary,
      phase,
      completedAt: now.toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertH5PWorkerStep(jobId, {
      status: 'completed',
      progress: 100,
      finishedAt: now,
      detail,
      error: null,
    });
    return true;
  }

  async failH5PWorkerJob(
    jobId: string,
    workerId: string,
    error: Error | string,
    retryable: boolean,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const message = typeof error === 'string' ? error : error?.message || 'Unknown h5p worker error';
    const now = new Date();
    const attemptsRemaining = (job.attemptCount ?? 0) < (job.maxAttempts ?? 3);

    const errorEntry = {
      phase: 'worker',
      message,
      retryable,
      attempt: job.attemptCount ?? 0,
      workerId,
      at: now.toISOString(),
    };

    job.currentStep = 'h5p';
    job.progress = Math.max(0, job.progress ?? 0);
    job.errorMessage = message;
    job.errorStep = 'h5p';
    job.outputSummary = this.appendOutputError(job.outputSummary, errorEntry);

    if (retryable && attemptsRemaining) {
      job.workerStatus = 'retrying';
      job.status = 'retrying';
      job.nextRetryAt = this.buildRetryDate(job.attemptCount ?? 0);
      job.leaseUntil = null;
      job.workerId = null;
      job.retryCount = (job.retryCount ?? 0) + 1;
      await this.jobRepo.save(job);

      const existingStep = await this.stepRepo.findOne({ where: { jobId, stepKey: 'h5p' } });
      await this.upsertH5PWorkerStep(jobId, {
        status: 'retrying',
        progress: existingStep?.progress ?? 5,
        detail: `Reintentando actividades: ${message}`,
        error: message,
        retries: (existingStep?.retries ?? 0) + 1,
      });
      return true;
    }

    job.workerStatus = retryable ? 'failed_recoverable' : 'failed';
    job.status = retryable ? 'failed_retryable' : 'failed';
    job.finishedAt = now;
    job.nextRetryAt = null;
    job.leaseUntil = null;
    await this.jobRepo.save(job);

    await this.upsertH5PWorkerStep(jobId, {
      status: 'failed',
      finishedAt: now,
      detail: `Actividades no disponibles: ${message}`,
      error: message,
    });
    return true;
  }

  private async upsertH5PWorkerStep(jobId: string, dto: Partial<ProductionStep>): Promise<ProductionStep> {
    let step = await this.stepRepo.findOne({ where: { jobId, stepKey: 'h5p' } });
    if (!step) step = this.stepRepo.create({ jobId, stepKey: 'h5p' });
    if (dto.status !== undefined) step.status = dto.status;
    if (dto.progress !== undefined) step.progress = dto.progress;
    if (dto.startedAt !== undefined) step.startedAt = dto.startedAt;
    if (dto.finishedAt !== undefined) step.finishedAt = dto.finishedAt;
    if (dto.error !== undefined) step.error = dto.error;
    if (dto.detail !== undefined) step.detail = dto.detail;
    if (dto.retries !== undefined) step.retries = dto.retries;
    return this.stepRepo.save(step);
  }

  // ── Package job methods ────────────────────────────────────────────────────

  async createPackageJob(
    ownerId: string,
    dto: CreatePackageJobDto,
  ): Promise<PackageJobCreatedResponse> {
    if (!dto.courseId) throw new BadRequestException('courseId is required');
    if (!dto.contentSnapshotArtifactId) throw new BadRequestException('contentSnapshotArtifactId is required');

    const rawCourseId    = dto.courseId;
    const numericCourseId = rawCourseId ? parseInt(rawCourseId, 10) : NaN;
    const activeStatuses = ['queued', 'running', 'retrying'];

    const qb = this.jobRepo.createQueryBuilder('job')
      .where('job.owner_id = :ownerId', { ownerId })
      .andWhere('job.execution_mode = :executionMode', { executionMode: 'backend_package' })
      .andWhere('job.worker_status IN (:...activeStatuses)', { activeStatuses });
    if (!isNaN(numericCourseId)) {
      qb.andWhere('(job.course_id = :courseId OR job.frontend_course_id = :frontendCourseId)', { courseId: numericCourseId, frontendCourseId: rawCourseId });
    } else {
      qb.andWhere('job.frontend_course_id = :frontendCourseId', { frontendCourseId: rawCourseId });
    }
    const activeExisting = await qb.getOne();
    if (activeExisting) {
      return { ok:true, jobId:activeExisting.id, status:activeExisting.status, workerStatus:activeExisting.workerStatus, executionMode:activeExisting.executionMode, currentStep:activeExisting.currentStep };
    }

    const sanitized = this.sanitizePayload({
      courseId: rawCourseId,
      executionMode: 'backend_package',
      contentSnapshotArtifactId: dto.contentSnapshotArtifactId,
      h5pSnapshotArtifactId:    dto.h5pSnapshotArtifactId ?? null,
      audioWelcomeArtifactId:   dto.audioWelcomeArtifactId ?? null,
      audiobookArtifactId:      dto.audiobookArtifactId ?? null,
      options: dto.options ?? {},
      metadata: dto.metadata ?? {},
    });

    const job = this.jobRepo.create({
      ownerId,
      courseId: !isNaN(numericCourseId) ? numericCourseId : null,
      frontendCourseId: rawCourseId,
      frontendJobId: dto.frontendJobId ?? null,
      options: dto.options ?? {},
      status: 'queued',
      currentStep: 'package',
      progress: 0,
      executionMode: 'backend_package',
      workerStatus: 'queued',
      inputPayload: sanitized,
      outputSummary: {},
    });
    const saved = await this.jobRepo.save(job);

    let step = await this.stepRepo.findOne({ where: { jobId: saved.id, stepKey: 'package' } });
    if (!step) step = this.stepRepo.create({ jobId: saved.id, stepKey: 'package' });
    step.status = 'queued'; step.progress = 0; step.detail = 'Esperando worker de empaquetado';
    await this.stepRepo.save(step);

    return { ok:true, jobId:saved.id, status:saved.status, workerStatus:saved.workerStatus, executionMode:saved.executionMode, currentStep:saved.currentStep };
  }

  async claimNextBackendPackageJob(workerId: string, leaseSeconds: number): Promise<ProductionJob | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const candidates = await queryRunner.query(
        `SELECT id FROM production_jobs WHERE execution_mode = 'backend_package'
         AND worker_status IN ('queued','retrying')
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
         AND (lease_until IS NULL OR lease_until < NOW())
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!Array.isArray(candidates) || candidates.length === 0) { await queryRunner.commitTransaction(); return null; }
      const jobId = candidates[0].id;
      await queryRunner.query(
        `UPDATE production_jobs SET worker_status='running', status='running', current_step='package',
         worker_id=$1, claimed_at=NOW(), lease_until=NOW()+($2*INTERVAL '1 second'),
         attempt_count=COALESCE(attempt_count,0)+1, started_at=COALESCE(started_at,NOW()), updated_at=NOW()
         WHERE id=$3`,
        [workerId, leaseSeconds, jobId],
      );
      await queryRunner.commitTransaction();
      this.logger.log(`Worker ${workerId} claimed backend_package job ${jobId}`);
      return this.jobRepo.findOne({ where: { id: jobId }, relations: ['steps'] });
    } catch (error) {
      await queryRunner.rollbackTransaction(); throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async markPackageWorkerRunning(jobId: string, workerId: string): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;
    job.status = 'running'; job.workerStatus = 'running'; job.currentStep = 'package';
    job.startedAt = job.startedAt ?? new Date();
    await this.jobRepo.save(job);
    await this.upsertPackageWorkerStep(jobId, { status:'running', progress:5, startedAt:new Date(), detail:'Iniciando empaquetado' });
    return true;
  }

  async updatePackageWorkerProgress(jobId: string, workerId: string, phase: string, message: string): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;
    const phaseProgress: Record<string, number> = { checking_existing_package:10, preparing_package:40, validating_package:80, uploading_package:90 };
    job.status = 'running'; job.workerStatus = 'running'; job.currentStep = 'package';
    job.progress = Math.min(95, phaseProgress[phase] ?? Math.max(job.progress ?? 10, 10));
    job.outputSummary = { ...(job.outputSummary ?? {}), phase, message, updatedAt: new Date().toISOString() };
    await this.jobRepo.save(job);
    await this.upsertPackageWorkerStep(jobId, { status:'running', progress:job.progress, detail:message });
    return true;
  }

  async completePackageWorkerJob(jobId: string, workerId: string, summary: Record<string, any>): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;
    const now = new Date();
    job.status = 'completed'; job.workerStatus = 'completed'; job.currentStep = 'package';
    job.progress = 100; job.finishedAt = now; job.leaseUntil = null; job.nextRetryAt = null;
    job.errorMessage = null; job.errorStep = null;
    job.outputSummary = { ...(job.outputSummary ?? {}), ...summary, phase:'completed', completedAt:now.toISOString() };
    await this.jobRepo.save(job);
    await this.upsertPackageWorkerStep(jobId, { status:'completed', progress:100, finishedAt:now, detail:'Paquete Moodle listo.', error:null });
    return true;
  }

  async failPackageWorkerJob(jobId: string, workerId: string, error: Error | string, retryable: boolean): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;
    const message = typeof error === 'string' ? error : error?.message || 'Unknown package worker error';
    const now     = new Date();
    const attemptsRemaining = (job.attemptCount ?? 0) < (job.maxAttempts ?? 3);
    job.currentStep = 'package'; job.errorMessage = message; job.errorStep = 'package';
    job.outputSummary = this.appendOutputError(job.outputSummary, { phase:'worker', message, retryable, attempt:job.attemptCount??0, workerId, at:now.toISOString() });
    if (retryable && attemptsRemaining) {
      job.workerStatus = 'retrying'; job.status = 'retrying';
      job.nextRetryAt = this.buildRetryDate(job.attemptCount ?? 0); job.leaseUntil = null; job.workerId = null;
      job.retryCount = (job.retryCount ?? 0) + 1;
      await this.jobRepo.save(job);
      const existingStep = await this.stepRepo.findOne({ where: { jobId, stepKey: 'package' } });
      await this.upsertPackageWorkerStep(jobId, { status:'retrying', progress: existingStep?.progress ?? 5, detail:`Reintentando: ${message}`, error:message, retries:(existingStep?.retries??0)+1 });
      return true;
    }
    job.workerStatus = retryable ? 'failed_recoverable' : 'failed';
    job.status = retryable ? 'failed_recoverable' : 'failed';
    job.finishedAt = now; job.nextRetryAt = null; job.leaseUntil = null;
    await this.jobRepo.save(job);
    await this.upsertPackageWorkerStep(jobId, { status:'failed', finishedAt:now, detail:`Empaquetado falló: ${message}`, error:message });
    return true;
  }

  private async upsertPackageWorkerStep(jobId: string, dto: Partial<ProductionStep>): Promise<ProductionStep> {
    let step = await this.stepRepo.findOne({ where: { jobId, stepKey: 'package' } });
    if (!step) step = this.stepRepo.create({ jobId, stepKey: 'package' });
    if (dto.status !== undefined)    step.status    = dto.status;
    if (dto.progress !== undefined)  step.progress  = dto.progress;
    if (dto.startedAt !== undefined) step.startedAt = dto.startedAt;
    if (dto.finishedAt !== undefined)step.finishedAt= dto.finishedAt;
    if (dto.error !== undefined)     step.error     = dto.error;
    if (dto.detail !== undefined)    step.detail    = dto.detail;
    if (dto.retries !== undefined)   step.retries   = dto.retries;
    return this.stepRepo.save(step);
  }

  private async upsertAudioWorkerStep(
    jobId: string,
    dto: Partial<ProductionStep>,
  ): Promise<ProductionStep> {
    let step = await this.stepRepo.findOne({ where: { jobId, stepKey: 'audio' } });
    if (!step) {
      step = this.stepRepo.create({ jobId, stepKey: 'audio' });
    }

    if (dto.status !== undefined) step.status = dto.status;
    if (dto.progress !== undefined) step.progress = dto.progress;
    if (dto.startedAt !== undefined) step.startedAt = dto.startedAt;
    if (dto.finishedAt !== undefined) step.finishedAt = dto.finishedAt;
    if (dto.error !== undefined) step.error = dto.error;
    if (dto.detail !== undefined) step.detail = dto.detail;
    if (dto.retries !== undefined) step.retries = dto.retries;

    return this.stepRepo.save(step);
  }

  async claimNextBackendContentJob(
    workerId: string,
    leaseSeconds: number,
  ): Promise<ProductionJob | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const candidates = await queryRunner.query(
        `
          SELECT id
          FROM production_jobs
          WHERE execution_mode = 'backend_content'
            AND worker_status IN ('queued', 'retrying')
            AND (next_retry_at IS NULL OR next_retry_at <= NOW())
            AND (lease_until IS NULL OR lease_until < NOW())
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
      );

      if (!Array.isArray(candidates) || candidates.length === 0) {
        await queryRunner.commitTransaction();
        return null;
      }

      const jobId = candidates[0].id;

      await queryRunner.query(
        `
          UPDATE production_jobs
          SET worker_status = 'running',
              status = 'running',
              current_step = 'content',
              worker_id = $1,
              claimed_at = NOW(),
              lease_until = NOW() + ($2 * INTERVAL '1 second'),
              attempt_count = COALESCE(attempt_count, 0) + 1,
              started_at = COALESCE(started_at, NOW()),
              updated_at = NOW()
          WHERE id = $3
        `,
        [workerId, leaseSeconds, jobId],
      );

      await queryRunner.commitTransaction();

      this.logger.log(`Worker ${workerId} claimed backend_content job ${jobId}`);
      return this.jobRepo.findOne({ where: { id: jobId }, relations: ['steps'] });
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async heartbeatWorkerJob(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const result = await this.jobRepo
      .createQueryBuilder()
      .update(ProductionJob)
      .set({
        leaseUntil: () => `NOW() + (${Math.max(1, leaseSeconds)} * INTERVAL '1 second')`,
      })
      .where('id = :jobId', { jobId })
      .andWhere('worker_id = :workerId', { workerId })
      .andWhere('worker_status = :workerStatus', { workerStatus: 'running' })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  async markContentWorkerRunning(jobId: string, workerId: string): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    job.status = 'running';
    job.workerStatus = 'running';
    job.currentStep = 'content';
    job.startedAt = job.startedAt ?? new Date();
    await this.jobRepo.save(job);

    await this.upsertWorkerStep(jobId, {
      status: 'running',
      progress: 10,
      startedAt: new Date(),
      detail: 'Content worker running',
    });

    return true;
  }

  async completeContentWorkerDryRun(
    jobId: string,
    workerId: string,
    summary: ContentWorkerDryRunSummary,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const now = new Date();
    job.status = 'completed';
    job.workerStatus = 'completed';
    job.currentStep = 'content';
    job.progress = 100;
    job.finishedAt = now;
    job.leaseUntil = null;
    job.nextRetryAt = null;
    job.errorMessage = null;
    job.errorStep = null;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      ...summary,
      completedAt: now.toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertWorkerStep(jobId, {
      status: 'completed',
      progress: 100,
      finishedAt: now,
      detail: summary.message,
      error: null,
    });

    return true;
  }

  async updateContentWorkerProgress(
    jobId: string,
    workerId: string,
    summary: ContentWorkerProgressSummary,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const progressTotals = summary.progressMap
      ? Object.values(summary.progressMap).reduce(
          (acc, item) => {
            acc.done += Number(item?.done ?? 0);
            acc.total += Number(item?.total ?? 0);
            return acc;
          },
          { done: 0, total: 0 },
        )
      : { done: Number(summary.filesGenerated ?? summary.done ?? 0), total: Number(summary.total ?? 1) };
    const total = progressTotals.total > 0 ? progressTotals.total : 1;
    const done = Math.min(progressTotals.done, total);
    const ratio = Math.max(0, Math.min(1, done / total));
    const approxProgress = Math.max(
      Math.min(job.progress ?? 10, 95),
      Math.min(95, Math.max(10, Math.round(ratio * 95))),
    );

    job.status = 'running';
    job.workerStatus = 'running';
    job.currentStep = 'content';
    job.progress = approxProgress;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      phase: summary.phase,
      done: summary.done,
      total: summary.total,
      file: summary.file ?? null,
      message: summary.message ?? null,
      filesGenerated: summary.filesGenerated ?? summary.done,
      progressMap: summary.progressMap ?? (job.outputSummary?.progressMap ?? {}),
      updatedAt: new Date().toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertWorkerStep(jobId, {
      status: 'running',
      progress: approxProgress,
      detail: summary.message ?? `Generating ${summary.phase}`,
      error: null,
    });

    return true;
  }

  async completeContentWorkerJob(
    jobId: string,
    workerId: string,
    summary: Record<string, any>,
    artifactId: string,
    completionMessage: string,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const now = new Date();
    job.status = 'completed';
    job.workerStatus = 'completed';
    job.currentStep = 'content';
    job.progress = 100;
    job.finishedAt = now;
    job.leaseUntil = null;
    job.nextRetryAt = null;
    job.errorMessage = null;
    job.errorStep = null;
    job.contentSnapshotArtifactId = artifactId;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      ...summary,
      contentSnapshotArtifactId: artifactId,
      artifactIds: {
        ...((job.outputSummary?.artifactIds ?? {}) as Record<string, any>),
        contentSnapshot: artifactId,
      },
      completedAt: now.toISOString(),
    };
    await this.jobRepo.save(job);

    await this.upsertWorkerStep(jobId, {
      status: 'completed',
      progress: 100,
      finishedAt: now,
      detail: completionMessage,
      error: null,
    });

    return true;
  }

  async failContentWorkerJob(
    jobId: string,
    workerId: string,
    error: Error | string,
    retryable: boolean,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const message =
      typeof error === 'string'
        ? error
        : error?.message || 'Unknown content worker error';
    const now = new Date();
    const attemptsRemaining = (job.attemptCount ?? 0) < (job.maxAttempts ?? 3);

    const errorEntry = {
      phase: 'worker',
      message,
      retryable,
      attempt: job.attemptCount ?? 0,
      workerId,
      at: now.toISOString(),
    };

    job.currentStep = 'content';
    job.progress = Math.max(0, job.progress ?? 0);
    job.errorMessage = message;
    job.errorStep = 'content';
    job.outputSummary = this.appendOutputError(job.outputSummary, errorEntry);

    if (retryable && attemptsRemaining) {
      job.workerStatus = 'retrying';
      job.status = 'retrying';
      job.nextRetryAt = this.buildRetryDate(job.attemptCount ?? 0);
      job.leaseUntil = null;
      job.workerId = null;
      job.retryCount = (job.retryCount ?? 0) + 1;
      await this.jobRepo.save(job);

      const existingStep = await this.stepRepo.findOne({ where: { jobId, stepKey: 'content' } });
      await this.upsertWorkerStep(jobId, {
        status: 'retrying',
        progress: existingStep?.progress ?? 10,
        detail: `Content worker retry scheduled: ${message}`,
        error: message,
        retries: (existingStep?.retries ?? 0) + 1,
      });
      return true;
    }

    job.workerStatus = retryable ? 'failed_recoverable' : 'failed';
    job.status = retryable ? 'failed_recoverable' : 'failed';
    job.finishedAt = now;
    job.nextRetryAt = null;
    job.leaseUntil = null;
    await this.jobRepo.save(job);

    await this.upsertWorkerStep(jobId, {
      status: 'failed',
      finishedAt: now,
      detail: `Content worker failed: ${message}`,
      error: message,
    });

    return true;
  }

  // ── FIND ALL ────────────────────────────────────────────────────────────────

  async findAll(ownerId: string, courseId?: string): Promise<ProductionJob[]> {
    const qb = this.jobRepo
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.steps', 'steps')
      .where('job.owner_id = :ownerId', { ownerId })
      .orderBy('job.created_at', 'DESC')
      .addOrderBy('steps.created_at', 'ASC');

    if (courseId) {
      // courseId puede ser numérico (backend) o textual (frontend)
      const numericId = parseInt(courseId, 10);
      if (!isNaN(numericId)) {
        qb.andWhere('job.course_id = :courseId', { courseId: numericId });
      } else {
        qb.andWhere('job.frontend_course_id = :fCourseId', { fCourseId: courseId });
      }
    }

    return qb.getMany();
  }

  // ── FIND ONE ────────────────────────────────────────────────────────────────

  async findOne(id: string, ownerId: string): Promise<ProductionJob> {
    const job = await this.jobRepo
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.steps', 'steps')
      .where('job.id = :id', { id })
      .andWhere('job.owner_id = :ownerId', { ownerId })
      .addOrderBy('steps.created_at', 'ASC')
      .getOne();

    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return job;
  }

  // ── UPDATE JOB ──────────────────────────────────────────────────────────────

  async update(id: string, dto: UpdateJobDto, ownerId: string): Promise<ProductionJob> {
    const job = await this.findOne(id, ownerId);

    if (dto.status)        job.status       = dto.status;
    if (dto.current_step)  job.currentStep  = dto.current_step;
    if (dto.progress !== undefined) job.progress = dto.progress;
    if (dto.started_at)    job.startedAt    = new Date(dto.started_at);
    if (dto.finished_at)   job.finishedAt   = new Date(dto.finished_at);
    if (dto.error_message) job.errorMessage = dto.error_message;
    if (dto.error_step)    job.errorStep    = dto.error_step;
    if (dto.result)        job.result       = { ...job.result, ...dto.result };

    await this.jobRepo.save(job);
    return job;
  }

  // ── UPDATE STEP (upsert) ────────────────────────────────────────────────────

  async updateStep(
    jobId: string,
    stepKey: string,
    dto: UpdateStepDto,
    ownerId: string,
  ): Promise<ProductionStep> {
    // Verify ownership
    await this.findOne(jobId, ownerId);

    // Find existing step or create
    let step = await this.stepRepo.findOne({
      where: { jobId, stepKey },
    });

    if (!step) {
      step = this.stepRepo.create({ jobId, stepKey });
    }

    if (dto.status)      step.status     = dto.status;
    if (dto.progress !== undefined) step.progress = dto.progress;
    if (dto.started_at)  step.startedAt  = new Date(dto.started_at);
    if (dto.finished_at) step.finishedAt = new Date(dto.finished_at);
    if (dto.error)       step.error      = dto.error;
    if (dto.detail)      step.detail     = dto.detail;

    return this.stepRepo.save(step);
  }

  // ── Full course orchestrator job methods ──────────────────────────────────

  async createFullCourseJob(
    ownerId: string,
    dto: CreateFullCourseJobDto,
  ): Promise<{ ok: true; jobId: string; status: string; workerStatus: string; executionMode: string; currentStep: string; resumed?: boolean }> {
    if (!dto.courseId) throw new BadRequestException('courseId is required');

    const rawCourseId    = dto.courseId;
    const numericCourseId = rawCourseId ? parseInt(rawCourseId, 10) : NaN;
    const activeStatuses = ['queued', 'running', 'retrying', 'needs_reconnect', 'blocked_quota'];

    const qb = this.jobRepo.createQueryBuilder('job')
      .where('job.owner_id = :ownerId', { ownerId })
      .andWhere('job.execution_mode = :executionMode', { executionMode: 'course_full_generation' })
      .andWhere('job.worker_status IN (:...activeStatuses)', { activeStatuses });

    if (!isNaN(numericCourseId)) {
      qb.andWhere('(job.course_id = :courseId OR job.frontend_course_id = :frontendCourseId)', {
        courseId: numericCourseId, frontendCourseId: rawCourseId,
      });
    } else {
      qb.andWhere('job.frontend_course_id = :frontendCourseId', { frontendCourseId: rawCourseId });
    }

    const existing = await qb.getOne();
    if (existing) {
      this.logger.log(`Full course job already active for course ${rawCourseId}: ${existing.id} (${existing.workerStatus})`);
      return {
        ok: true, jobId: existing.id, status: existing.status,
        workerStatus: existing.workerStatus, executionMode: existing.executionMode,
        currentStep: existing.currentStep, resumed: true,
      };
    }

    const sanitized = this.sanitizePayload({
      courseId: rawCourseId,
      executionMode: 'course_full_generation',
      courseData: dto.courseData ?? {},
      options: dto.options ?? {},
      metadata: dto.metadata ?? {},
    });

    const job = this.jobRepo.create({
      ownerId,
      courseId: !isNaN(numericCourseId) ? numericCourseId : null,
      frontendCourseId: rawCourseId,
      frontendJobId: dto.frontendJobId ?? null,
      options: dto.options ?? {},
      status: 'queued',
      currentStep: 'checking_existing',
      progress: 0,
      executionMode: 'course_full_generation',
      workerStatus: 'queued',
      inputPayload: sanitized,
      outputSummary: {},
    });

    const saved = await this.jobRepo.save(job);

    const steps = ['content', 'audio', 'video', 'h5p', 'package'].map(key =>
      this.stepRepo.create({ jobId: saved.id, stepKey: key, status: 'pending' }),
    );
    await this.stepRepo.save(steps);

    return {
      ok: true, jobId: saved.id, status: saved.status,
      workerStatus: saved.workerStatus, executionMode: saved.executionMode,
      currentStep: saved.currentStep,
    };
  }

  async claimNextFullCourseJob(workerId: string, leaseSeconds: number): Promise<ProductionJob | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const candidates = await queryRunner.query(
        `SELECT id FROM production_jobs
         WHERE execution_mode = 'course_full_generation'
           AND worker_status IN ('queued', 'retrying')
           AND (next_retry_at IS NULL OR next_retry_at <= NOW())
           AND (lease_until IS NULL OR lease_until < NOW())
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!Array.isArray(candidates) || candidates.length === 0) {
        await queryRunner.commitTransaction();
        return null;
      }
      const jobId = candidates[0].id;
      await queryRunner.query(
        `UPDATE production_jobs
         SET worker_status='running', status='running', current_step='checking_existing',
             worker_id=$1, claimed_at=NOW(), lease_until=NOW()+($2*INTERVAL '1 second'),
             attempt_count=COALESCE(attempt_count,0)+1, started_at=COALESCE(started_at,NOW()),
             updated_at=NOW()
         WHERE id=$3`,
        [workerId, leaseSeconds, jobId],
      );
      await queryRunner.commitTransaction();
      this.logger.log(`Worker ${workerId} claimed course_full_generation job ${jobId}`);
      return this.jobRepo.findOne({ where: { id: jobId }, relations: ['steps'] });
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async updateFullCourseStep(
    jobId: string,
    workerId: string,
    step: string,
    message: string,
    partialSummary?: Record<string, any>,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    job.status = 'running';
    job.workerStatus = 'running';
    job.currentStep = step;
    if (partialSummary) {
      job.outputSummary = { ...(job.outputSummary ?? {}), ...partialSummary, updatedAt: new Date().toISOString() };
    }
    await this.jobRepo.save(job);

    await this.upsertStepByKey(jobId, step, { status: 'running', detail: message });
    return true;
  }

  async completeFullCourseJob(
    jobId: string,
    workerId: string,
    summary: Record<string, any>,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const now = new Date();
    job.status        = 'completed';
    job.workerStatus  = 'completed';
    job.currentStep   = 'completed';
    job.progress      = 100;
    job.finishedAt    = now;
    job.leaseUntil    = null as any;
    job.nextRetryAt   = null as any;
    job.errorMessage  = null as any;
    job.errorStep     = null as any;
    job.outputSummary = { ...(job.outputSummary ?? {}), ...summary, phase: 'completed', completedAt: now.toISOString() };
    await this.jobRepo.save(job);

    await this.upsertStepByKey(jobId, 'package', { status: 'completed', progress: 100, finishedAt: now, detail: 'Curso listo.', error: null });
    return true;
  }

  async failFullCourseJob(
    jobId: string,
    workerId: string,
    error: Error | string,
    retryable: boolean,
  ): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;

    const message = typeof error === 'string' ? error : error?.message || 'Unknown full-course error';
    const now     = new Date();
    const attemptsRemaining = (job.attemptCount ?? 0) < (job.maxAttempts ?? 3);
    const errorEntry = { phase: 'full_course_worker', message, retryable, attempt: job.attemptCount ?? 0, workerId, at: now.toISOString() };

    job.errorMessage  = message;
    job.errorStep     = job.currentStep;
    job.outputSummary = this.appendOutputError(job.outputSummary, errorEntry);

    if (retryable && attemptsRemaining) {
      job.workerStatus = 'retrying';
      job.status       = 'retrying';
      job.nextRetryAt  = this.buildRetryDate(job.attemptCount ?? 0);
      job.leaseUntil   = null as any;
      job.workerId     = null as any;
      job.retryCount   = (job.retryCount ?? 0) + 1;
      await this.jobRepo.save(job);
      return true;
    }

    job.workerStatus = retryable ? 'failed_retryable' : 'failed';
    job.status       = retryable ? 'failed_retryable' : 'failed';
    job.finishedAt   = now;
    job.nextRetryAt  = null as any;
    job.leaseUntil   = null as any;
    await this.jobRepo.save(job);
    return true;
  }

  async blockFullCourseJobAuth(jobId: string, workerId: string, videoJobId: string): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;
    const now = new Date();
    job.status       = 'needs_reconnect';
    job.workerStatus = 'needs_reconnect';
    job.leaseUntil   = null as any;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      blockReason: 'blocked_auth',
      blockedVideoJobId: videoJobId,
      blockedAt: now.toISOString(),
      userMessage: 'Necesita reconectar YouTube para continuar con los videos.',
    };
    await this.jobRepo.save(job);
    this.logger.warn(`Full course job ${jobId} blocked (auth) by video job ${videoJobId}`);
    return true;
  }

  async blockFullCourseJobQuota(jobId: string, workerId: string, videoJobId: string): Promise<boolean> {
    const job = await this.findJobForWorker(jobId, workerId);
    if (!job) return false;
    const now = new Date();
    job.status       = 'blocked_quota';
    job.workerStatus = 'blocked_quota';
    job.leaseUntil   = null as any;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      blockReason: 'blocked_quota',
      blockedVideoJobId: videoJobId,
      blockedAt: now.toISOString(),
      userMessage: 'YouTube no permitió subir más videos por ahora. Puedes intentarlo más tarde.',
    };
    await this.jobRepo.save(job);
    this.logger.warn(`Full course job ${jobId} blocked (quota) by video job ${videoJobId}`);
    return true;
  }

  async requeueFullCourseJob(jobId: string, userId: string): Promise<{ ok: boolean; reason?: string }> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) return { ok: false, reason: 'not_found' };
    if (job.ownerId !== userId) return { ok: false, reason: 'forbidden' };
    if (job.executionMode !== 'course_full_generation') return { ok: false, reason: 'not_a_full_course_job' };

    const retryableStatuses = ['failed_retryable', 'failed', 'needs_reconnect', 'blocked_quota', 'failed_recoverable'];
    if (!retryableStatuses.includes(job.status)) {
      return { ok: false, reason: `status_not_retryable (current: ${job.status})` };
    }

    const prevStatus = job.status;
    job.status       = 'queued';
    job.workerStatus = 'queued';
    job.workerId     = null as any;
    job.leaseUntil   = null as any;
    job.currentStep  = 'checking_existing';
    job.nextRetryAt  = null as any;
    job.outputSummary = {
      ...(job.outputSummary ?? {}),
      requeuedAt: new Date().toISOString(),
      previousStatus: prevStatus,
    };
    await this.jobRepo.save(job);
    this.logger.log(`Full course job ${jobId} requeued by user ${userId} (was: ${prevStatus})`);
    return { ok: true };
  }

  async findLatestChildJobForCourse(
    ownerId: string,
    courseId: string,
    executionMode: string,
  ): Promise<ProductionJob | null> {
    const numericId = parseInt(courseId, 10);
    const qb = this.jobRepo.createQueryBuilder('job')
      .where('job.owner_id = :ownerId', { ownerId })
      .andWhere('job.execution_mode = :executionMode', { executionMode })
      .orderBy('job.created_at', 'DESC');

    if (!isNaN(numericId)) {
      qb.andWhere('(job.course_id = :courseId OR job.frontend_course_id = :frontendCourseId)', {
        courseId: numericId, frontendCourseId: courseId,
      });
    } else {
      qb.andWhere('job.frontend_course_id = :frontendCourseId', { frontendCourseId: courseId });
    }

    return qb.getOne();
  }

  async findJobByIdInternal(id: string): Promise<ProductionJob | null> {
    return this.jobRepo.findOne({ where: { id } });
  }

  private async upsertStepByKey(
    jobId: string,
    stepContext: string,
    dto: Partial<ProductionStep>,
  ): Promise<void> {
    // Map orchestrator step names to the DB step keys created for full-course jobs
    const keyMap: Record<string, string> = {
      checking_existing: 'content',
      content: 'content',
      audio: 'audio',
      video: 'video',
      h5p: 'h5p',
      package: 'package',
      completing: 'package',
      completed: 'package',
    };
    const stepKey = keyMap[stepContext] ?? stepContext;

    let step = await this.stepRepo.findOne({ where: { jobId, stepKey } });
    if (!step) step = this.stepRepo.create({ jobId, stepKey });

    if (dto.status !== undefined)     step.status     = dto.status;
    if (dto.progress !== undefined)   step.progress   = dto.progress;
    if (dto.startedAt !== undefined)  step.startedAt  = dto.startedAt;
    if (dto.finishedAt !== undefined) step.finishedAt = dto.finishedAt;
    if (dto.error !== undefined)      step.error      = dto.error;
    if (dto.detail !== undefined)     step.detail     = dto.detail;

    await this.stepRepo.save(step);
  }
}
