import { Module } from '@nestjs/common';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { CourseMediaAdminController, CourseMediaController } from './course-media.controller';
import { CourseMediaService } from './course-media.service';

@Module({
  imports: [ArtifactsModule],
  controllers: [CourseMediaController, CourseMediaAdminController],
  providers: [CourseMediaService],
  exports: [CourseMediaService],
})
export class CourseMediaModule {}
