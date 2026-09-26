import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { SuperAdminGuard } from '../../auth/super-admin.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { AuthUser } from '../../auth/auth.types';
import { FinopsLedgerService } from './finops-ledger.service';
import { FinopsBudgetService } from './finops-budget.service';
import { FinopsIngestTokenGuard } from './finops-ingest-token.guard';
import { FinopsError } from './errors';
import { llmIngestToChargeInput, parseLlmUsageIngest } from './llm-usage-ingest';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** FinopsError → HTTP (fail loud: un precio faltante es 422, nunca un 200 con 0). */
export function finopsErrorToHttp(err: unknown): unknown {
  if (err instanceof FinopsError) {
    if (err.code === 'ESTIMATE_NOT_FOUND') return new NotFoundException({ code: err.code, message: err.message });
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
  constructor(
    private readonly ledger: FinopsLedgerService,
    private readonly budget: FinopsBudgetService,
  ) {}

  // POST /api/v1/finops/courses/:courseId/authorizations (RF-b)
  // Aprobación humana (append-only) de un estimado: {estimateId, authorizedBudget, reason?}.
  // El run que lo consuma (startRun / regenerate) queda vinculado a esta aprobación.
  @Post('courses/:courseId/authorizations')
  @HttpCode(HttpStatus.CREATED)
  async authorize(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
  ) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    for (const k of Object.keys(b)) {
      if (!['estimateId', 'authorizedBudget', 'reason'].includes(k)) throw new BadRequestException(`campo no permitido: ${k}`);
    }
    if (typeof b.estimateId !== 'string') throw new BadRequestException('estimateId es obligatorio');
    if (typeof b.authorizedBudget !== 'string' && typeof b.authorizedBudget !== 'number') {
      throw new BadRequestException('authorizedBudget es obligatorio (string decimal o número)');
    }
    if (b.reason !== undefined && b.reason !== null && (typeof b.reason !== 'string' || b.reason.length > 500)) {
      throw new BadRequestException('reason inválido');
    }
    try {
      const row = await this.budget.adminAuthorize({
        courseId,
        estimateId: b.estimateId,
        authorizedBudget: b.authorizedBudget as string | number,
        approvedBy: String(user?.email || user?.id || ''),
        reason: (b.reason as string | undefined) ?? null,
      });
      return {
        id: row.id,
        courseId: row.course_id,
        runId: row.run_id,
        estimateId: row.estimate_id,
        authorizedBudget: String(row.authorized_budget),
        currency: row.currency,
        decision: row.decision,
        approvedBy: row.approved_by,
        createdAt: row.created_at,
      };
    } catch (err) {
      throw finopsErrorToHttp(err);
    }
  }

  // GET /api/v1/finops/owners/:ownerId/costs (RF-b: rollup por owner)
  @Get('owners/:ownerId/costs')
  ownerCosts(@Param('ownerId') ownerId: string) {
    if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 128) throw new BadRequestException('ownerId inválido');
    return this.ledger.costsByOwner(ownerId);
  }

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
