import { Module } from '@nestjs/common';
import { CourseProfilesController } from './course-profiles.controller';
import { CourseProfilesService } from './course-profiles.service';
import { CoursesModule } from '../courses/courses.module';
import { AuthModule } from '../../auth/auth.module';

@Module({
  imports: [
    CoursesModule, // CoursesService.findOne para ownership
    AuthModule,    // SupabaseJwtGuard
  ],
  controllers: [CourseProfilesController],
  providers: [CourseProfilesService],
  exports: [CourseProfilesService],
})
export class CourseProfilesModule {}
