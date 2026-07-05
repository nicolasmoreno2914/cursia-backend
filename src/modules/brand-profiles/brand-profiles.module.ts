import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BrandProfile } from './entities/brand-profile.entity';
import { BrandProfilesController } from './brand-profiles.controller';
import { BrandProfilesService } from './brand-profiles.service';
import { BrandExtractionService } from './brand-extraction.service';
import { InstitutionsModule } from '../institutions/institutions.module';

@Module({
  imports: [TypeOrmModule.forFeature([BrandProfile]), InstitutionsModule],
  controllers: [BrandProfilesController],
  providers: [BrandProfilesService, BrandExtractionService],
  exports: [BrandProfilesService, BrandExtractionService],
})
export class BrandProfilesModule {}
