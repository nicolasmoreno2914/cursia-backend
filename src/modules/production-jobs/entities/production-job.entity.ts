import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { ProductionStep } from './production-step.entity';

/**
 * Representa un job de producción de curso.
 * Cada vez que el frontend ejecuta startCompleteCourseProduction(),
 * se crea un registro aquí. Los pasos se registran en ProductionStep.
 */
@Entity('production_jobs')
export class ProductionJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** UUID del usuario (auth.users.id de Supabase) */
  @Index()
  @Column({ name: 'owner_id', length: 36 })
  ownerId: string;

  /** ID del curso en la tabla courses del backend */
  @Index()
  @Column({ name: 'course_id', nullable: true })
  courseId: number;

  /** ID textual del curso en el frontend (ACTIVE_COURSE_ID) */
  @Column({ name: 'frontend_course_id', type: 'text', nullable: true })
  frontendCourseId: string;

  /** ID del job en el frontend (CP.jobId = 'prod_1717000000') */
  @Index()
  @Column({ name: 'frontend_job_id', type: 'text', nullable: true })
  frontendJobId: string;

  @Column({ default: 'queued' })
  status: string;
  // queued | running | waiting_external | retrying | paused
  // blocked | failed_recoverable | failed | completed | cancelled

  @Column({ name: 'current_step', type: 'text', nullable: true })
  currentStep: string;

  @Column({ default: 0 })
  progress: number;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string;

  @Column({ name: 'error_step', type: 'text', nullable: true })
  errorStep: string;

  @Column({ name: 'retry_count', default: 0 })
  retryCount: number;

  @Index()
  @Column({ name: 'execution_mode', type: 'text', default: 'frontend' })
  executionMode: string;

  @Index()
  @Column({ name: 'worker_status', type: 'text', nullable: true })
  workerStatus: string;

  @Column({ name: 'worker_id', type: 'text', nullable: true })
  workerId: string;

  @Column({ name: 'lease_until', type: 'timestamptz', nullable: true })
  leaseUntil: Date;

  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true })
  claimedAt: Date;

  @Column({ name: 'attempt_count', default: 0 })
  attemptCount: number;

  @Column({ name: 'max_attempts', default: 3 })
  maxAttempts: number;

  @Column({ name: 'next_retry_at', type: 'timestamptz', nullable: true })
  nextRetryAt: Date;

  @Column({ name: 'input_payload', type: 'jsonb', nullable: false, default: '{}' })
  inputPayload: Record<string, any>;

  @Column({ name: 'output_summary', type: 'jsonb', nullable: false, default: '{}' })
  outputSummary: Record<string, any>;

  @Index()
  @Column({ name: 'content_snapshot_artifact_id', type: 'uuid', nullable: true })
  contentSnapshotArtifactId: string;

  /** Opciones del pipeline: generateVideos, maxVideoChapters, etc. */
  @Column({ type: 'jsonb', nullable: true, default: '{}' })
  options: Record<string, any>;

  /** Resultado final: mbzReady, mbzCompletionLevel, durationMinutes, etc. */
  @Column({ type: 'jsonb', nullable: true, default: '{}' })
  result: Record<string, any>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => ProductionStep, (step) => step.job, { cascade: true })
  steps: ProductionStep[];
}
