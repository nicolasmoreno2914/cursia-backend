import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { FinopsAdminController, FinopsIngestController, FinopsLlmReservationController } from './finops.controller';
import { FinopsLedgerService } from './finops-ledger.service';
import { FinopsIngestTokenGuard } from './finops-ingest-token.guard';
import { FinopsBudgetService } from './finops-budget.service';
import { CostReadService } from './cost-read.service';

/**
 * V2.1 RF-a — Cost Ledger / FinOps (audit §W). Ledger append-only, ingest del
 * proxy LLM y lecturas admin. El cableado a workers y proxy es RF-b: consumen
 * `FinopsLedgerService` (exportado) y las libs puras de este directorio.
 */
@Module({
  imports: [AuthModule],
  controllers: [FinopsIngestController, FinopsLlmReservationController, FinopsAdminController],
  providers: [FinopsLedgerService, FinopsBudgetService, FinopsIngestTokenGuard, CostReadService],
  exports: [FinopsLedgerService, FinopsBudgetService, CostReadService],
})
export class FinopsModule {}
