import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('artifacts')
export class Artifact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'owner_id', length: 36 })
  ownerId: string;

  @Index()
  @Column({ name: 'course_id', type: 'text', nullable: true })
  courseId: string;

  @Column({ name: 'job_id', type: 'uuid', nullable: true })
  jobId: string;

  @Column({ type: 'text' })
  type: string;
  // content_snapshot | audio_welcome | audiobook | h5p_snapshot
  // mbz_final | diagnostic | video_manifest

  @Column({ name: 'storage_provider', length: 50, default: 'supabase' })
  storageProvider: string;

  @Column({ name: 'storage_bucket', type: 'text', default: 'cursia-artifacts' })
  storageBucket: string;

  @Column({ name: 'storage_path', type: 'text' })
  storagePath: string;

  @Column({ type: 'text', nullable: true })
  filename: string;

  @Column({ name: 'mime_type', type: 'text', default: 'application/octet-stream' })
  mimeType: string;

  @Column({ name: 'size_bytes', type: 'bigint', nullable: true })
  sizeBytes: number;

  @Column({ name: 'checksum_sha256', type: 'text', nullable: true })
  checksumSha256: string;

  @Column({ type: 'jsonb', nullable: true, default: '{}' })
  metadata: Record<string, any>;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
