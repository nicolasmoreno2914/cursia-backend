import { Entity, PrimaryGeneratedColumn, Column, Index, Unique } from 'typeorm';

/**
 * Generation Manifest congelado de un Blueprint (Fase 4).
 *
 * Tabla creada por `supabase-migration-generation-manifests.sql` (NO por
 * synchronize). Filas inmutables: un trigger BEFORE UPDATE rechaza cualquier
 * update. `GenerationManifestsService` escribe/lee con SQL crudo vía
 * dataSource; esta entidad existe para el registro en TypeORM, no para
 * `save()`.
 */
@Entity('course_generation_manifests')
@Unique('cgm_blueprint_rules_key', ['blueprintId', 'rulesVersion'])
export class CourseGenerationManifest {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('idx_cgm_course')
  @Column({ name: 'course_id', type: 'int' })
  courseId: number;

  @Column({ name: 'blueprint_id', type: 'int' })
  blueprintId: number;

  @Column({ name: 'rules_version', type: 'int' })
  rulesVersion: number;

  @Column({ name: 'manifest_schema_version', type: 'int', default: 1 })
  manifestSchemaVersion: number;

  @Column({ name: 'manifest_json', type: 'jsonb' })
  manifestJson: Record<string, any>;

  @Column({ name: 'manifest_sha256', type: 'char', length: 64 })
  manifestSha256: string;

  @Column({ name: 'blueprint_sha256', type: 'char', length: 64 })
  blueprintSha256: string;

  @Column({ name: 'module_count', type: 'int' })
  moduleCount: number;

  @Column({ name: 'chapter_count', type: 'int' })
  chapterCount: number;

  @Column({ name: 'content_count', type: 'int' })
  contentCount: number;

  @Column({ name: 'scorm_count', type: 'int' })
  scormCount: number;

  @Column({ name: 'video_count', type: 'int' })
  videoCount: number;

  @Column({ name: 'exam_count', type: 'int' })
  examCount: number;

  @Column({ name: 'total_jobs', type: 'int' })
  totalJobs: number;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ name: 'created_by', type: 'varchar', length: 36, nullable: true })
  createdBy: string | null;
}
