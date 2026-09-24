import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GenerationItemRun } from './entities/generation-item-run.entity';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { GenerationManifestsModule } from '../generation-manifests/generation-manifests.module';
import { AuthModule } from '../../auth/auth.module';

/**
 * Generación dinámica (Fase 5A): runs sobre un Generation Manifest. No
 * importa ProductionJobsModule: la fila run de production_jobs se escribe
 * con SQL propio (execution_mode='dynamic_generation'), sin tocar el
 * servicio legacy.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([GenerationItemRun]),
    GenerationManifestsModule, // expone GenerationManifestsService.get (ownership + dynamic + Manifest verificado)
    AuthModule,                // expone SupabaseJwtGuard para el controlador
  ],
  controllers: [RunsController],
  providers: [RunsService],
  exports: [RunsService],
})
export class DynamicGenerationModule {}
