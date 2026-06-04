import { Module } from '@nestjs/common';
import { MbzBuilderService } from './mbz-builder.service';

@Module({
  providers: [MbzBuilderService],
  exports:   [MbzBuilderService],
})
export class PackageModule {}
