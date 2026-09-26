import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { SuperAdminGuard } from '../../auth/super-admin.guard';
import { FinopsLedgerService } from './finops-ledger.service';
import { FinopsIngestTokenGuard } from './finops-ingest-token.guard';
import { FinopsError } from './errors';
import { llmIngestToChargeInput, parseLlmUsageIngest } from './llm-usage-ingest';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** FinopsError → HTTP (fail loud: un precio faltante es 422, nunca un 200 con 0). */
export function finopsErrorToHttp(err: unknown): unknown {
  if (err instanceof FinopsError) {
    if (err.code === 'PRICING_MISSING' || err.code === 'PRICING_AMBIGUOUS' || err.code === 'CURRENCY_MISMATCH') {
      return new UnprocessableEntityException({ code: err.code, message: err.message });
    }
    return new BadRequestException({ code: err.code, message: err.message });
  }
  return err;
}

/**
 * V2.1 RF-a — ingest server-to-server del proxy LLM (RF-b lo cablea).
 * Sin JWT de usuario: autenticado por secreto compartido (FinopsIngestTokenGuard).
 */
@Controller('finops/ingest')
@UseGuards(FinopsIngestTokenGuard)
export class FinopsIngestController {
  constructor(private readonly ledger: FinopsLedgerService) {}

  // POST /api/v1/finops/ingest/llm-usage
  @Post('llm-usage')
  @HttpCode(HttpStatus.OK)
  async llmUsage(@Body() body: Record<string, unknown>) {
    try {
      const parsed = parseLlmUsageIngest(body);
      const r = await this.ledger.recordCharge(llmIngestToChargeInput(parsed));
      return {
        inserted: r.inserted,
        eventId: r.event.id,
        idempotencyKey: r.event.idempotency_key,
        attributed: r.event.item_run_id !== null,
        amount: r.event.amount,
        currency: r.event.currency,
      };
    } catch (err) {
      throw finopsErrorToHttp(err);
    }
  }
}

/** V2.1 RF-a — lecturas administrativas (mismo guard que /admin/dashboard). */
@Controller('finops')
@UseGuards(SupabaseJwtGuard, SuperAdminGuard)
export class FinopsAdminController {
  constructor(private readonly ledger: FinopsLedgerService) {}

  // GET /api/v1/finops/courses/:id/costs
  @Get('courses/:id/costs')
  courseCosts(@Param('id', ParseIntPipe) id: number) {
    return this.ledger.costsByCourse(id);
  }

  // GET /api/v1/finops/runs/:id/costs
  @Get('runs/:id/costs')
  runCosts(@Param('id') id: string) {
    if (!UUID_RE.test(id)) throw new BadRequestException('id de run debe ser UUID');
    return this.ledger.costsByRun(id);
  }
}
