import { Module } from '@nestjs/common';
import { ContentGenerationService } from './content-generation.service';

@Module({
  providers: [ContentGenerationService],
  exports: [ContentGenerationService],
})
export class ContentGenerationModule {}
