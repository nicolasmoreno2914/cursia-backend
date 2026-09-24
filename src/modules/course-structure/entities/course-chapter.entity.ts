import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { CourseModule } from './course-module.entity';

@Entity('course_chapters')
export class CourseChapter {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'course_id' })
  courseId: number;

  @Index()
  @Column({ name: 'module_id' })
  moduleId: string;

  @ManyToOne(() => CourseModule, (module) => module.chapters, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'module_id' })
  module: CourseModule;

  @Column()
  position: number;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  objective: string;

  @Column({ name: 'video_enabled', default: false })
  videoEnabled: boolean;

  @Column({ default: 'not_generated' })
  status: string; // not_generated | generating | ready | stale | failed

  /**
   * { concepts_introduced: string[], concepts_assumed: string[], key_terms: string[] }
   * Ver spec, sección C (Context Package).
   */
  @Column({ name: 'context_summary', type: 'jsonb', nullable: true })
  contextSummary: Record<string, any>;

  @Column({ name: 'generated_with_version_id', nullable: true })
  generatedWithVersionId: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
