import { Module } from '@nestjs/common';
import { PackagingController } from './packaging.controller';
import { PackagingService } from './packaging.service';
import { GenerationManifestsModule } from '../generation-manifests/generation-manifests.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { AuthModule } from '../../auth/auth.module';

/**
 * Empaquetado Moodle dinámico (Fase 5B.1). No importa ProductionJobsModule:
 * el job `dynamic_package` se escribe/lee con SQL propio en
 * PackagingService, igual que DynamicGenerationModule hace con
 * `dynamic_generation`. La ejecución real corre en
 * `src/workers/dynamic-package-worker.ts` (proceso PM2 aparte).
 */
@Module({
  imports: [
    GenerationManifestsModule, // expone GenerationManifestsService.get (ownership + dynamic + Manifest verificado)
    ArtifactsModule,           // expone ArtifactsService.getDownloadUrl (signed URL de descarga)
    AuthModule,                // expone SupabaseJwtGuard para el controlador
  ],
  controllers: [PackagingController],
  providers: [PackagingService],
  exports: [PackagingService],
})
export class DynamicPackagingModule {}
