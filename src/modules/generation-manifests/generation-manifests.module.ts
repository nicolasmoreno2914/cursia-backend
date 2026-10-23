import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CourseGenerationManifest } from './entities/course-generation-manifest.entity';
import { GenerationManifestsController } from './generation-manifests.controller';
import { GenerationManifestsService } from './generation-manifests.service';
import { CourseBlueprintsModule } from '../course-blueprints/course-blueprints.module';
import { AuthModule } from '../../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CourseGenerationManifest]),
    CourseBlueprintsModule, // expone CourseBlueprintsService.getByNumber (ownership + dynamic + hash)
    AuthModule,             // expone SupabaseJwtGuard para el controlador
  ],
  controllers: [GenerationManifestsController],
  providers: [GenerationManifestsService],
  exports: [GenerationManifestsService],
})
export class GenerationManifestsModule {}
