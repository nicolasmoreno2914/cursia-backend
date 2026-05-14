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
   * Full course state snapshot:
   * { D: {...}, F: {...}, MEDIA: {...}, VIDEO_ENGINE: {...}, metadata: {...} }
   */
  @Column({ name: 'snapshot_json', type: 'jsonb', nullable: true })
  snapshotJson: Record<string, any>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => Course, (course) => course.versions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'course_id' })
  course: Course;
}
