import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CoursesModule } from '../courses/courses.module';
import { FinopsModule } from '../finops/finops.module';
import { AcademicContextController } from './academic-context.controller';
import { AcademicContextService } from './academic-context.service';

@Module({
  imports: [
    CoursesModule, // CoursesService.findOne para ownership
    AuthModule,    // SupabaseJwtGuard
    FinopsModule,  // LOOP 8.1: la lectura avanzada registra su gasto
  ],
  controllers: [AcademicContextController],
  providers: [AcademicContextService],
})
export class AcademicContextModule {}
