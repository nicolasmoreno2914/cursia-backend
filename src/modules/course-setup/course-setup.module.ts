import { Module } from '@nestjs/common';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { CourseSetupController } from './course-setup.controller';
import { CourseSetupExtractionService } from './course-setup-extraction.service';

@Module({
  imports: [ArtifactsModule],
  controllers: [CourseSetupController],
  providers: [CourseSetupExtractionService],
})
export class CourseSetupModule {}
