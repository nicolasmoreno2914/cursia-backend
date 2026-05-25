import { Module } from '@nestjs/common';
import { VideoEngineController } from './video-engine.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [VideoEngineController],
})
export class VideoEngineModule {}
