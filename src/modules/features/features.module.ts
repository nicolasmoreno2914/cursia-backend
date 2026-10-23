import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { FeaturesController } from './features.controller';
import { DynamicFeatureGuard } from './dynamic-feature.guard';

/**
 * Flags del rollout V2: GET /api/v1/features + el guard global que esconde
 * (404) las rutas dynamic con DYNAMIC_COURSE_STRUCTURE apagado.
 */
@Module({
  imports: [AuthModule],
  controllers: [FeaturesController],
  providers: [{ provide: APP_GUARD, useClass: DynamicFeatureGuard }],
})
export class FeaturesModule {}
