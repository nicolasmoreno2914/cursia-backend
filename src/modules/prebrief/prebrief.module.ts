import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CoursesModule } from '../courses/courses.module';
import { CourseDesignModule } from '../course-design/course-design.module';
import { CourseBlueprintsModule } from '../course-blueprints/course-blueprints.module';
import { CourseProfilesModule } from '../course-profiles/course-profiles.module';
import { PrebriefController } from './prebrief.controller';
import { PrebriefService } from './prebrief.service';

/** Prebrief pedagógico: propuesta versionada + aprobación + PDF; la generación (R68) exige la versión aprobada. */
@Module({
  imports: [AuthModule, CoursesModule, CourseDesignModule, CourseBlueprintsModule, CourseProfilesModule],
  controllers: [PrebriefController],
  providers: [PrebriefService],
  exports: [PrebriefService],
})
export class PrebriefModule {}
