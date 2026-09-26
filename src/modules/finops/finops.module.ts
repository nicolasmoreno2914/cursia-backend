import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { FinopsAdminController, FinopsIngestController } from './finops.controller';
import { FinopsLedgerService } from './finops-ledger.service';
import { FinopsIngestTokenGuard } from './finops-ingest-token.guard';

/**
 * V2.1 RF-a — Cost Ledger / FinOps (audit §W). Ledger append-only, ingest del
 * proxy LLM y lecturas admin. El cableado a workers y proxy es RF-b: consumen
 * `FinopsLedgerService` (exportado) y las libs puras de este directorio.
 */
@Module({
  imports: [AuthModule],
  controllers: [FinopsIngestController, FinopsAdminController],
  providers: [FinopsLedgerService, FinopsIngestTokenGuard],
  exports: [FinopsLedgerService],
})
export class FinopsModule {}
