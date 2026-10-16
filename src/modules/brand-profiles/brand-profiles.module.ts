import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BrandProfile } from './entities/brand-profile.entity';
import { BrandProfilesController } from './brand-profiles.controller';
import { BrandProfilesService } from './brand-profiles.service';
import { BrandExtractionService } from './brand-extraction.service';
import { InstitutionsModule } from '../institutions/institutions.module';
import { FinopsModule } from '../finops/finops.module';

@Module({
  imports: [TypeOrmModule.forFeature([BrandProfile]), InstitutionsModule, FinopsModule],
  controllers: [BrandProfilesController],
  providers: [BrandProfilesService, BrandExtractionService],
  exports: [BrandProfilesService, BrandExtractionService],
})
export class BrandProfilesModule {}
