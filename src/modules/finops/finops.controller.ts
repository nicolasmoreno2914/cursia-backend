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
  Query,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { SuperAdminGuard } from '../../auth/super-admin.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { AuthUser } from '../../auth/auth.types';
import { FinopsLedgerService } from './finops-ledger.service';
import { FinopsBudgetService } from './finops-budget.service';
import { FinopsIngestTokenGuard } from './finops-ingest-token.guard';
import { FinopsError } from './errors';
import { llmIngestToChargeInput, llmProxyReservationKey, llmReservationToChargeInput, parseLlmReservationIngest, parseLlmReservationRelease, parseLlmUsageIngest } from './llm-usage-ingest';
import { costIdempotencyKey } from './idempotency';

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
  async llmUsage(@Body() body: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    try {
      const parsed = parseLlmUsageIngest(body);
      // Piloto #1209: la llamada se RESERVÓ antes (callId) → este usage la liquida (cargo exacto + reserva a 0,
      // atómico e idempotente). Sin la reserva (proxy viejo o reserva fallida) sigue el camino de siempre.
      if (parsed.callId) {
        try {
          const s = await this.ledger.settleReservation(llmProxyReservationKey(parsed.callId), llmIngestToChargeInput(parsed), 'llm_proxy_measured', { recordedBy: 'llm-proxy' });
          return {
            settled: true, alreadySettled: s.alreadySettled, finalInserted: s.finalInserted,
            eventId: s.finalEvent ? s.finalEvent.id : null, idempotencyKey: s.finalEvent ? s.finalEvent.idempotency_key : null,
            amount: s.finalEvent ? s.finalEvent.amount : null, attributed: s.finalEvent ? s.finalEvent.item_run_id !== null : null,
          };
        } catch (err) {
          if (!(err instanceof FinopsError && err.code === 'ORIGINAL_NOT_FOUND')) throw err;
        }
      }
      // #583 fix round 1 (I1): corrección del cargo conservador de un stream cortado (mismo messageId).
      if (parsed.measurement === 'correction') {
        const input = llmIngestToChargeInput(parsed);
        const key = costIdempotencyKey('anthropic', { messageId: parsed.messageId });
        const usage = input.usage as Record<string, number>;
        const c = await this.ledger.correctConservativeLlmCharge(key, usage, { ownerId: parsed.subject, model: parsed.model });
        if (c) return { corrected: c.corrected, delta: c.delta, reason: c.reason ?? null, idempotencyKey: key };
        // El conservador no llegó: el exacto ES el cargo.
      }
      const r = await this.ledger.recordCharge(llmIngestToChargeInput(parsed));
      // RF-b fix C1/I2: precio faltante → registrado a 0 pendiente → 202 (nunca 4xx: el proxy no pierde el cargo).
      if (r.pricingMissing && res) res.status(HttpStatus.ACCEPTED);
      return {
        pricingMissing: !!r.pricingMissing,
        measurementStatus: r.event.measurement_status,
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

/**
 * Piloto #1209 (2026-10-11): reserva del proxy LLM ANTES de llamar a Anthropic (server-to-server, mismo token).
 * Si no se puede registrar, el proxy no llama (nunca hay gasto sin registro).
 */
@Controller('finops/ingest')
@UseGuards(FinopsIngestTokenGuard)
export class FinopsLlmReservationController {
  constructor(private readonly ledger: FinopsLedgerService) {}

  // POST /api/v1/finops/ingest/llm-reservation
  @Post('llm-reservation')
  @HttpCode(HttpStatus.OK)
  async llmReservation(@Body() body: Record<string, unknown>) {
    try {
      const parsed = parseLlmReservationIngest(body);
      const r = await this.ledger.recordCharge(llmReservationToChargeInput(parsed));
      // Review (minor 6): un callId repetido cuya reserva ya se cerró no cubre una llamada NUEVA → 409 (el proxy no llama).
      if (!r.inserted && (await this.ledger.reservationSettled(llmProxyReservationKey(parsed.callId)))) {
        throw new FinopsError('INVALID_INPUT', `la reserva del callId ${parsed.callId} ya está cerrada: usa un callId nuevo`);
      }
      return { reserved: true, inserted: r.inserted, reservationKey: llmProxyReservationKey(parsed.callId), amount: r.event.amount, attributed: r.event.item_run_id !== null };
    } catch (err) {
      throw finopsErrorToHttp(err);
    }
  }

  // POST /api/v1/finops/ingest/llm-reservation/release — Anthropic rechazó el pedido sin cobro (lista cerrada
  // de estados); cualquier otro resultado deja la reserva pendiente. Idempotente.
  @Post('llm-reservation/release')
  @HttpCode(HttpStatus.OK)
  async llmReservationRelease(@Body() body: Record<string, unknown>) {
    try {
      const parsed = parseLlmReservationRelease(body);
      const reason = `llm_proxy_provider_rejected_${parsed.providerStatus}` + (parsed.requestId ? `:${parsed.requestId}` : '');
      const r = await this.ledger.settleReservation(llmProxyReservationKey(parsed.callId), null, reason, { recordedBy: 'llm-proxy' });
      return { released: r.released, alreadySettled: r.alreadySettled };
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
      if (!['estimateId', 'runId', 'authorizedBudget', 'reason'].includes(k)) throw new BadRequestException(`campo no permitido: ${k}`);
    }
    // RF-b fix M9: {runId} (sin estimateId) = presupuesto TOTAL de un run existente.
    if ((typeof b.estimateId === 'string') === (typeof b.runId === 'string')) {
      throw new BadRequestException('exactamente uno de estimateId | runId es obligatorio');
    }
    if (typeof b.authorizedBudget !== 'string' && typeof b.authorizedBudget !== 'number') {
      throw new BadRequestException('authorizedBudget es obligatorio (string decimal o número)');
    }
    if (b.reason !== undefined && b.reason !== null && (typeof b.reason !== 'string' || b.reason.length > 500)) {
      throw new BadRequestException('reason inválido');
    }
    try {
      const common = {
        courseId,
        authorizedBudget: b.authorizedBudget as string | number,
        approvedBy: String(user?.email || user?.id || ''),
        reason: (b.reason as string | undefined) ?? null,
      };
      const row = typeof b.runId === 'string'
        ? await this.budget.adminAuthorizeRun({ ...common, runId: b.runId })
        : await this.budget.adminAuthorize({ ...common, estimateId: b.estimateId as string });
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

  // GET /api/v1/finops/llm-proxy-reservations?courseId=&runId= — piloto #1209: llamadas LLM cuya respuesta se
  // perdió (pendientes de conciliar contra la consola de Anthropic). Cuentan como gasto mientras tanto.
  @Get('llm-proxy-reservations')
  async llmProxyReservations(@Query('courseId') courseId?: string, @Query('runId') runId?: string) {
    const f: { courseId?: number; runId?: string } = {};
    if (courseId !== undefined) {
      if (!/^\d{1,12}$/.test(courseId)) throw new BadRequestException('courseId inválido');
      f.courseId = Number(courseId);
    }
    if (runId !== undefined) {
      if (!UUID_RE.test(runId)) throw new BadRequestException('runId debe ser UUID');
      f.runId = runId;
    }
    try {
      return { reservations: await this.ledger.pendingLlmProxyReservations(f) };
    } catch (err) {
      throw finopsErrorToHttp(err);
    }
  }

  // POST /api/v1/finops/llm-proxy-reservations/:callId/reconcile {outcome: 'charged'|'not_charged', reason}
  // Decisión HUMANA (SUPER_ADMIN), con motivo; nunca automática. Repetir = no-op.
  @Post('llm-proxy-reservations/:callId/reconcile')
  @HttpCode(HttpStatus.OK)
  async reconcileLlmProxyReservation(@Param('callId') callId: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    if (!UUID_RE.test(callId)) throw new BadRequestException('callId debe ser UUID');
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    for (const k of Object.keys(b)) if (!['outcome', 'reason'].includes(k)) throw new BadRequestException(`campo no permitido: ${k}`);
    if (b.outcome !== 'charged' && b.outcome !== 'not_charged') throw new BadRequestException('outcome debe ser charged | not_charged');
    if (typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 500) throw new BadRequestException('reason es obligatorio (≤ 500)');
    const decidedBy = String(user?.id || ''); // re-review (minor b): id, nunca el email, en el ledger
    if (!decidedBy) throw new BadRequestException('usuario sin id');
    try {
      const key = llmProxyReservationKey(callId);
      const r = b.outcome === 'charged'
        ? await this.ledger.reconcileReservationAsCharged(key, b.reason, { decidedBy, metadata: { llmProxy: true } })
        : await this.ledger.reconcileReservationAsNotCharged(key, b.reason, { decidedBy, metadata: { llmProxy: true } });
      return { outcome: b.outcome, reconciled: r.reconciled, alreadySettled: r.alreadySettled, amount: r.amount };
    } catch (err) {
      throw finopsErrorToHttp(err);
    }
  }
}
