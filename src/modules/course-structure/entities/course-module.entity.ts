import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { CourseChapter } from './course-chapter.entity';

@Entity('course_modules')
export class CourseModule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'course_id' })
  courseId: number;

  @Column()
  position: number;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  objective: string;

  @Column({ name: 'exam_enabled', default: true })
  examEnabled: boolean;

  @Column({ default: 'draft' })
  status: string; // draft | locked

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => CourseChapter, (chapter) => chapter.module)
  chapters: CourseChapter[];
}
