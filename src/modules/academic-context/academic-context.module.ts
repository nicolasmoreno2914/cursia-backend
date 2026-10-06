import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CoursesModule } from '../courses/courses.module';
import { AcademicContextController } from './academic-context.controller';
import { AcademicContextService } from './academic-context.service';

@Module({
  imports: [
    CoursesModule, // CoursesService.findOne para ownership
    AuthModule,    // SupabaseJwtGuard
  ],
  controllers: [AcademicContextController],
  providers: [AcademicContextService],
})
export class AcademicContextModule {}
