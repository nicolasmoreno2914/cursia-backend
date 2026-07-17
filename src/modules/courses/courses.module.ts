import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Course } from './entities/course.entity';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { AuthModule } from '../../auth/auth.module';
import { AdminModule } from '../../admin/admin.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Course]),
    AuthModule,   // expone SupabaseJwtGuard para el controlador
    AdminModule,  // expone AdminDashboardService para GET /courses/:id/cost
  ],
  controllers: [CoursesController],
  providers: [CoursesService],
  exports: [CoursesService],
})
export class CoursesModule {}
