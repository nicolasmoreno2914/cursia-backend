import { Module } from '@nestjs/common';
import { TtsController } from './tts.controller';
import { TtsService } from './tts.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports:     [AuthModule],
  controllers: [TtsController],
  providers:   [TtsService],
  exports:     [TtsService],
})
export class TtsModule {}
