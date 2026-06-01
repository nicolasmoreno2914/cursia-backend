import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { ProductionJob } from './production-job.entity';

/**
 * Representa un paso del pipeline de producción.
 * Cada markStepRunning/Done/Failed/Skipped del frontend hace un PATCH aquí.
 */
@Entity('production_steps')
@Unique(['job', 'stepKey'])  // un step_key por job
export class ProductionStep {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @ManyToOne(() => ProductionJob, (job) => job.steps, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job: ProductionJob;

  @Column({ name: 'job_id' })
  jobId: string;

  /** Clave del paso: prepare, content, audio, videos, multimedia, package, save, etc. */
  @Column({ name: 'step_key', length: 50 })
  stepKey: string;

  @Column({ default: 'pending' })
  status: string;
  // pending | running | retrying | completed | skipped | failed_recoverable | failed

  @Column({ default: 0 })
  progress: number;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date;

  @Column({ type: 'text', nullable: true })
  error: string;

  @Column({ default: 0 })
  retries: number;

  /** Mensaje human-readable del estado actual */
  @Column({ type: 'text', nullable: true })
  detail: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
