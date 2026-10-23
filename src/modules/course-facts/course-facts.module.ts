import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CourseFactsController } from './course-facts.controller';
import { CourseFactsService } from './course-facts.service';

@Module({
  imports: [AuthModule], // SupabaseJwtGuard
  controllers: [CourseFactsController],
  providers: [CourseFactsService],
  exports: [CourseFactsService],
})
export class CourseFactsModule {}
