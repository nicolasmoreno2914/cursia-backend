import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CourseBlueprint } from './entities/course-blueprint.entity';
import { CourseBlueprintsService } from './course-blueprints.service';

@Module({
  imports: [TypeOrmModule.forFeature([CourseBlueprint])],
  providers: [CourseBlueprintsService],
  exports: [CourseBlueprintsService],
})
export class CourseBlueprintsModule {}
