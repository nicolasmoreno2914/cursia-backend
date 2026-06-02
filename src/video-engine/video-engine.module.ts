import { Module } from '@nestjs/common';
import { VideoEngineController } from './video-engine.controller';
import { VideogenService } from './videogen.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [VideoEngineController],
  providers: [VideogenService],
  exports: [VideogenService],
})
export class VideoEngineModule {}
