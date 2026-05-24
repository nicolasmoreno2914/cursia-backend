import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsageEvent } from './entities/usage-event.entity';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { CostRate } from '../admin/entities/cost-rate.entity';
import { CostRatesService } from '../admin/services/cost-rates.service';

@Module({
  imports: [TypeOrmModule.forFeature([UsageEvent, CostRate])],
  controllers: [EventsController],
  providers: [EventsService, CostRatesService],
  exports: [EventsService, CostRatesService],
})
export class EventsModule {}
