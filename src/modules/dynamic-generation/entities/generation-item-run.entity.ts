import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/**
 * Item de un run de generación dinámica (Fase 5A).
 *
 * Tabla creada por `supabase-migration-dynamic-generation.sql` (NO por
 * synchronize). Esta entidad existe solo para el registro/lectura en TypeORM:
 * TODAS las escrituras (siembra, transiciones de estado, claim/lease) se
 * hacen con SQL explícito en `RunsService` (y en Task 3), nunca con `save()`.
 */
@Entity('generation_item_runs')
export class GenerationItemRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'job_id', type: 'uuid' })
  jobId: string;

  @Column({ name: 'course_id', type: 'int' })
  courseId: number;

  @Column({ name: 'blueprint_id', type: 'int' })
  blueprintId: number;

  @Column({ name: 'manifest_id', type: 'int' })
  manifestId: number;

  @Column({ name: 'item_key', type: 'text' })
  itemKey: string;

  @Column({ type: 'int', default: 1 })
  generation: number;

  @Column({ type: 'text' })
  type: string;

  @Column({ name: 'module_id', type: 'uuid' })
  moduleId: string;

  @Column({ name: 'chapter_id', type: 'uuid', nullable: true })
  chapterId: string | null;

  @Column({ name: 'depends_on', type: 'text', array: true, default: () => "'{}'" })
  dependsOn: string[];

  @Column({ type: 'text', default: 'pending' })
  status: string;

  @Column({ name: 'worker_id', type: 'text', nullable: true })
  workerId: string | null;

  @Column({ name: 'lease_until', type: 'timestamptz', nullable: true })
  leaseUntil: Date | null;

  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true })
  claimedAt: Date | null;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount: number;

  @Column({ name: 'max_attempts', type: 'int', default: 3 })
  maxAttempts: number;

  @Column({ name: 'next_retry_at', type: 'timestamptz', nullable: true })
  nextRetryAt: Date | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'idempotency_key', type: 'char', length: 64 })
  idempotencyKey: string;

  @Column({ name: 'output_summary', type: 'jsonb', default: () => "'{}'" })
  outputSummary: Record<string, any>;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
