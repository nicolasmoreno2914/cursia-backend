import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CourseBlueprint } from './entities/course-blueprint.entity';
import { CourseBlueprintsController } from './course-blueprints.controller';
import { CourseBlueprintsService } from './course-blueprints.service';
import { AuthModule } from '../../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CourseBlueprint]),
    AuthModule, // expone SupabaseJwtGuard para el controlador
  ],
  controllers: [CourseBlueprintsController],
  providers: [CourseBlueprintsService],
  exports: [CourseBlueprintsService],
})
export class CourseBlueprintsModule {}
