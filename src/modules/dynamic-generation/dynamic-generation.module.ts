import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GenerationItemRun } from './entities/generation-item-run.entity';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { SchedulerService } from './scheduler.service';
import { ExecutorController } from './executor.controller';
import { GenerationManifestsModule } from '../generation-manifests/generation-manifests.module';
import { AuthModule } from '../../auth/auth.module';
import { AdminModule } from '../../admin/admin.module';
import { YoutubeModule } from '../../youtube/youtube.module';
import { DynamicYoutubeController } from './dynamic-youtube.controller';
import { DynamicYoutubePreflightService } from './dynamic-youtube';
import { FinopsModule } from '../finops/finops.module';

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
    AdminModule,               // expone CostRatesService (estimate de costo de video, R17)
    YoutubeModule,             // DN-1: YoutubeService/YoutubeTokenService (preflight, sin modificarlos)
    FinopsModule,              // V2.1 RF-b: estimado + gates de presupuesto (FinopsBudgetService)
  ],
  controllers: [RunsController, ExecutorController, DynamicYoutubeController],
  providers: [RunsService, SchedulerService, DynamicYoutubePreflightService],
  exports: [RunsService, SchedulerService, DynamicYoutubePreflightService],
})
export class DynamicGenerationModule {}
