import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CourseVersion } from './entities/course-version.entity';
import { CourseVersionsController } from './course-versions.controller';
import { CourseVersionsService } from './course-versions.service';
import { CoursesModule } from '../courses/courses.module';
import { AuthModule } from '../../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CourseVersion]),
    CoursesModule,   // expone CoursesService para ownership checks
    AuthModule,      // expone SupabaseJwtGuard para el controlador
  ],
  controllers: [CourseVersionsController],
  providers: [CourseVersionsService],
})
export class CourseVersionsModule {}
