import { Module } from '@nestjs/common';
import { CoherenceController } from './coherence.controller';
import { CoherenceService } from './coherence.service';
import { CourseBlueprintsModule } from '../course-blueprints/course-blueprints.module';
import { GenerationManifestsModule } from '../generation-manifests/generation-manifests.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { AuthModule } from '../../auth/auth.module';

/** Fase 7 (F7-BE): Coherence Engine (evalúa, nunca modifica contenido). */
@Module({
  imports: [CourseBlueprintsModule, GenerationManifestsModule, ArtifactsModule, AuthModule],
  controllers: [CoherenceController],
  providers: [CoherenceService],
  exports: [CoherenceService],
})
export class CoherenceModule {}
