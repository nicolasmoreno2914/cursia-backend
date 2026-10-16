import { Module } from '@nestjs/common';
import { TtsController } from './tts.controller';
import { TtsService } from './tts.service';
import { AuthModule } from '../auth/auth.module';
import { FinopsModule } from '../modules/finops/finops.module';

@Module({
  imports:     [AuthModule, FinopsModule],
  controllers: [TtsController],
  providers:   [TtsService],
  exports:     [TtsService],
})
export class TtsModule {}
