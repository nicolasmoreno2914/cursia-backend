import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CourseModule as CourseModuleEntity } from './entities/course-module.entity';
import { CourseChapter } from './entities/course-chapter.entity';

@Module({
  imports: [TypeOrmModule.forFeature([CourseModuleEntity, CourseChapter])],
  exports: [TypeOrmModule],
})
export class CourseStructureModule {}
