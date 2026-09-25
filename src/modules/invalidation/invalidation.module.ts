import { Module } from '@nestjs/common';
import { InvalidationController } from './invalidation.controller';
import { InvalidationService } from './invalidation.service';
import { GenerationManifestsModule } from '../generation-manifests/generation-manifests.module';
import { AuthModule } from '../../auth/auth.module';

/**
 * Fase 8 (F8-BE): invalidación y regeneración parcial. El dry-run vive acá;
 * el apply transaccional va por `POST …/manifest/runs {fromRun}`
 * (RunsService.startRun → startRunFromPrevious) para heredar sus gates.
 */
@Module({
  imports: [GenerationManifestsModule, AuthModule],
  controllers: [InvalidationController],
  providers: [InvalidationService],
  exports: [InvalidationService],
})
export class InvalidationModule {}
