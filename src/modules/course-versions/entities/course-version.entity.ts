import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Course } from '../../courses/entities/course.entity';

@Entity('course_versions')
export class CourseVersion {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'course_id' })
  courseId: number;

  @Column({ name: 'version_number' })
  versionNumber: number; // auto-incremented per course

  @Column({ length: 50, default: 'draft' })
  status: string; // draft | ready | exported

  @Column({ type: 'text', nullable: true })
  notes: string;

  /**
   * Full course state snapshot (small courses / MVP).
   * { D: {...}, F: {...}, MEDIA: {...}, VIDEO_ENGINE: {...}, metadata: {...} }
   * Set to null when snapshot_strategy = 'external_file' (stored in Drive).
   */
  @Column({ name: 'snapshot_json', type: 'jsonb', nullable: true })
  snapshotJson: Record<string, any>;

  // ── Storage (Fase 5 — Drive unificado) ──────────────────────────
  /** 'postgres_json' | 'google_drive' | 'external_url' */
  @Column({ name: 'storage_provider', length: 50, nullable: true })
  storageProvider: string;

  /** ID del archivo en Google Drive (para restauración futura) */
  @Column({ name: 'storage_file_id', type: 'text', nullable: true })
  storageFileId: string;

  /** URL pública del archivo (webViewLink de Drive) */
  @Column({ name: 'storage_file_url', type: 'text', nullable: true })
  storageFileUrl: string;

  /** ID de la carpeta del curso en Drive */
  @Column({ name: 'storage_folder_id', type: 'text', nullable: true })
  storageFolderId: string;

  /** Ruta lógica dentro del storage (e.g. "cursos/42/v3.json") */
  @Column({ name: 'storage_path', type: 'text', nullable: true })
  storagePath: string;

  /** 'full_json' | 'external_file' | 'hybrid' */
  @Column({ name: 'snapshot_strategy', length: 50, nullable: true })
  snapshotStrategy: string;

  /** Tamaño del snapshot en bytes */
  @Column({ name: 'snapshot_size_bytes', type: 'bigint', nullable: true })
  snapshotSizeBytes: number;

  /** Tamaño legible ("2.4 MB") */
  @Column({ name: 'snapshot_size_human', length: 30, nullable: true })
  snapshotSizeHuman: string;

  /**
   * Resumen del snapshot: qué contiene, cuántos archivos, dónde está el binario.
   * { contains: {D,F,MEDIA,VIDEO_ENGINE}, counts: {...}, storage: {...} }
   */
  @Column({ name: 'manifest_json', type: 'jsonb', nullable: true })
  manifestJson: Record<string, any>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => Course, (course) => course.versions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'course_id' })
  course: Course;
}
