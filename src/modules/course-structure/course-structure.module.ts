import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CourseModule as CourseModuleEntity } from './entities/course-module.entity';
import { CourseChapter } from './entities/course-chapter.entity';
import { CourseStructureController } from './course-structure.controller';
import { CourseStructureService } from './course-structure.service';
import { CoursesModule } from '../courses/courses.module';
import { AuthModule } from '../../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CourseModuleEntity, CourseChapter]),
    CoursesModule,   // expone CoursesService para ownership checks
    AuthModule,      // expone SupabaseJwtGuard para el controlador
  ],
  controllers: [CourseStructureController],
  providers: [CourseStructureService],
  exports: [TypeOrmModule],
})
export class CourseStructureModule {}
