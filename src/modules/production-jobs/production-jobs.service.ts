import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

@Injectable()
export class ProductionJobsService {
  constructor(
    @InjectRepository(ProductionJob)
    private readonly jobRepo: Repository<ProductionJob>,
    @InjectRepository(ProductionStep)
    private readonly stepRepo: Repository<ProductionStep>,
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
