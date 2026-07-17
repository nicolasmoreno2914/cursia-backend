import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CostRate } from './entities/cost-rate.entity';
import { TraditionalCostBenchmark } from './entities/traditional-cost-benchmark.entity';
import { UsageEvent } from '../events/entities/usage-event.entity';
import { CostRatesService } from './services/cost-rates.service';
import { AdminDashboardService } from './services/admin-dashboard.service';
import { AdminDashboardController } from './controllers/admin-dashboard.controller';
import { AdminSeedService } from './seed/admin-seed.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([CostRate, TraditionalCostBenchmark, UsageEvent]),
  ],
  controllers: [AdminDashboardController],
  providers: [CostRatesService, AdminDashboardService, AdminSeedService],
  exports: [CostRatesService, AdminDashboardService],
})
export class AdminModule {}
