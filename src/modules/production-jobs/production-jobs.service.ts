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

export interface ContentWorkerProgressSummary {
  phase: string;
  done: number;
  total: number;
  file?: string | null;
  message?: string | null;
  filesGenerated?: number;
  progressMap?: Record<string, { done: number; total: number }>;
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
}
