import { Entity, PrimaryGeneratedColumn, Column, Index, Unique } from 'typeorm';

/**
 * Blueprint congelado de la estructura de un curso `dynamic` (Fase 3).
 *
 * Tabla creada por `supabase-migration-course-blueprints.sql` (NO por
 * synchronize). Filas inmutables: un trigger BEFORE UPDATE rechaza cualquier
 * update. `CourseBlueprintsService` escribe/lee con SQL crudo vía
 * queryRunner/dataSource; esta entidad existe para el registro en TypeORM y
 * para lecturas tipadas, no para `save()`.
 */
@Entity('course_blueprints')
@Unique('course_blueprints_course_number_key', ['courseId', 'blueprintNumber'])
@Unique('course_blueprints_id_course_key', ['id', 'courseId'])
export class CourseBlueprint {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('idx_course_blueprints_course')
  @Column({ name: 'course_id', type: 'int' })
  courseId: number;

  @Column({ name: 'blueprint_number', type: 'int' })
  blueprintNumber: number;

  @Column({ name: 'schema_version', type: 'int', default: 1 })
  schemaVersion: number;

  @Column({ name: 'snapshot_json', type: 'jsonb' })
  snapshotJson: Record<string, any>;

  @Column({ name: 'snapshot_sha256', type: 'char', length: 64 })
  snapshotSha256: string;

  @Column({ name: 'structure_counter_at_lock', type: 'int' })
  structureCounterAtLock: number;

  @Column({ name: 'module_count', type: 'int' })
  moduleCount: number;

  @Column({ name: 'chapter_count', type: 'int' })
  chapterCount: number;

  @Column({ name: 'locked_at', type: 'timestamptz', default: () => 'now()' })
  lockedAt: Date;

  @Column({ name: 'locked_by', type: 'varchar', length: 36, nullable: true })
  lockedBy: string | null;
}
