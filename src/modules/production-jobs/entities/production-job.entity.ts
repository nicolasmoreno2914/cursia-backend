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
