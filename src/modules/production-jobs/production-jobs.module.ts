import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductionJob } from './entities/production-job.entity';
import { ProductionStep } from './entities/production-step.entity';
import { ProductionJobsController } from './production-jobs.controller';
import { ProductionJobsService } from './production-jobs.service';

@Module({
  imports: [TypeOrmModule.forFeature([ProductionJob, ProductionStep])],
  controllers: [ProductionJobsController],
  providers: [ProductionJobsService],
  exports: [ProductionJobsService],
})
export class ProductionJobsModule {}
