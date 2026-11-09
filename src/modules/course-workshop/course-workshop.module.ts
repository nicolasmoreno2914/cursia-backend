import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { CourseWorkshopController } from './course-workshop.controller';
import { CourseWorkshopService } from './course-workshop.service';

/**
 * r107 · «Taller de cursos» (B1: ingesta + identificación). PermissionService llega del AuthzModule global.
 * Flag COURSE_WORKSHOP (apagado por defecto); tabla workshop_sessions solo en staging (migración r107).
 */
@Module({
  imports: [AuthModule, ArtifactsModule],
  controllers: [CourseWorkshopController],
  providers: [CourseWorkshopService],
})
export class CourseWorkshopModule {}
