import {
  BadRequestException,
  Body,
  ConflictException,
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
import { FinopsLedgerService, TTS_RESERVATION_KEY_RE } from './finops-ledger.service';
import { FinopsBudgetService } from './finops-budget.service';
import { FinopsIngestTokenGuard } from './finops-ingest-token.guard';
import { FinopsError } from './errors';
import { llmIngestToChargeInput, llmProxyReservationKey, llmReservationToChargeInput, parseLlmReservationIngest, parseLlmReservationRelease, parseLlmUsageIngest } from './llm-usage-ingest';
import { costIdempotencyKey } from './idempotency';
import { SPEND_CONTROL_CODES } from './spend-controls';
import { RUN_BUDGET_NOT_AUTHORIZED } from './run-budget';
import { parseReconcileDecision, ReconcileDecision, ReconcileEvidence } from './reconcile-decision';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** r58: FinopsError.code de los controles de gasto → `code` HTTP (409) que entienden el proxy y el navegador. */
export const SPEND_CONTROL_HTTP_CODES: Readonly<Record<string, string>> = Object.freeze({
  FINOPS_KILL_SWITCH: SPEND_CONTROL_CODES.killSwitch,
  PROVIDER_NOT_ALLOWED: SPEND_CONTROL_CODES.providerNotAllowed,
  UNATTRIBUTED_CEILING: SPEND_CONTROL_CODES.unattributedCeiling,
  ITEM_RUN_NOT_FOUND: SPEND_CONTROL_CODES.itemRunNotFound,
});

/**
 * r59/r60: validación del cuerpo de POST tts-reservations/reconcile:
 * {reservationKey, outcome: 'charged'|'not_charged'|'charged_partial', reason, amount?, evidence?}.
 */
export function parseTtsReservationReconcileBody(body: unknown): { reservationKey: string } & ReconcileDecision {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['reservationKey', 'outcome', 'reason', 'amount', 'evidence'].includes(k)) throw new BadRequestException(`campo no permitido: ${k}`);
  if (typeof b.reservationKey !== 'string' || !TTS_RESERVATION_KEY_RE.test(b.reservationKey)) throw new BadRequestException('reservationKey inválida');
  const d = parseDecisionOrBadRequest(b, ['reservationKey']);
  return { reservationKey: b.reservationKey, ...d };
}

/** r60: parseReconcileDecision → 400 (mismo estilo que el resto de los endpoints de conciliación). */
export function parseDecisionOrBadRequest(body: unknown, extraKeys: readonly string[] = []): ReconcileDecision {
  try {
    return parseReconcileDecision(body, { extraKeys });
  } catch (err) {
    if (err instanceof FinopsError) throw new BadRequestException(err.message.replace(/^INVALID_INPUT:\s*/, ''));
    throw err;
  }
}

/**
 * r60: aplica la decisión sobre una reserva (los tres endpoints de este controlador). → respuesta común:
 * {outcome, reconciled, alreadySettled, amount (reservado), countedAmount?, recordedSettlement?}. Un `charged_partial`
 * sobre una reserva ya cerrada de OTRA forma (o con otro monto) → 409 `reservation_already_settled`.
 */
export async function applyReconcileDecision(
  ledger: Pick<FinopsLedgerService, 'reconcileReservationAsCharged' | 'reconcileReservationAsNotCharged' | 'reconcileReservationAsChargedPartial'>,
  key: string,
  d: ReconcileDecision,
  decidedBy: string,
  metadata: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (d.outcome === 'charged_partial') {
    const r = await ledger.reconcileReservationAsChargedPartial(key, d.amount as string, d.reason, d.evidence as ReconcileEvidence, { decidedBy, metadata });
    if (r.alreadySettled && (r.recordedSettlement !== 'reconciled_as_charged_partial' || r.countedAmount !== d.amount)) {
      throw new ConflictException({
        code: 'reservation_already_settled',
        message: `reservation_already_settled: la reserva ya está cerrada (${r.recordedSettlement ?? 'liquidada'}, cuenta USD ${r.countedAmount}); no se cambia una decisión registrada.`,
      });
    }
    return { outcome: d.outcome, reconciled: r.reconciled, alreadySettled: r.alreadySettled, amount: r.amount, countedAmount: r.countedAmount, recordedSettlement: r.recordedSettlement };
  }
  const r = d.outcome === 'charged'
    ? await ledger.reconcileReservationAsCharged(key, d.reason, { decidedBy, metadata })
    : await ledger.reconcileReservationAsNotCharged(key, d.reason, { decidedBy, metadata });
  return { outcome: d.outcome, reconciled: r.reconciled, alreadySettled: r.alreadySettled, amount: r.amount };
}

/** FinopsError → HTTP (fail loud: un precio faltante es 422, nunca un 200 con 0). */
export function finopsErrorToHttp(err: unknown): unknown {
  if (err instanceof FinopsError) {
    if (err.code === 'ESTIMATE_NOT_FOUND') return new NotFoundException({ code: err.code, message: err.message });
    // FinOps P0: reserva de una parte de un run ajeno → 409 con código estable (el proxy no llama al proveedor).
    if (err.code === 'ATTRIBUTION_REJECTED') return new ConflictException({ code: 'attribution_rejected', message: err.message });
    // r58 H4: reserva pagada de un run sin ninguna autorización → 409 con código estable (el proxy no llama).
    if (err.code === 'RUN_BUDGET_NOT_AUTHORIZED') return new ConflictException({ code: RUN_BUDGET_NOT_AUTHORIZED, message: err.message });
    // r58: controles de gasto del servidor → 409 con código estable (el proxy no llama y el navegador no reintenta).
    const spendCode = SPEND_CONTROL_HTTP_CODES[err.code];
    if (spendCode) return new ConflictException({ code: spendCode, message: err.message });
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
  constructor(
    private readonly ledger: FinopsLedgerService,
    private readonly budget: FinopsBudgetService,
  ) {}

  // POST /api/v1/finops/ingest/llm-reservation
  @Post('llm-reservation')
  @HttpCode(HttpStatus.OK)
  async llmReservation(@Body() body: Record<string, unknown>) {
    try {
      const parsed = parseLlmReservationIngest(body);
      // Loop Cost Efficiency: pausa / tope del run / presupuesto de recuperación de la parte / disyuntor, ANTES de
      // reservar (sin reserva, el proxy no llama). 409 con un código estable que el navegador entiende.
      // Review M5: el reintento del MISMO POST (timeout del proxy) no vuelve a pasar por el guard (ya está reservada).
      const already = await this.ledger.reservationSettled(llmProxyReservationKey(parsed.callId));
      if ((parsed.mode ?? 'real') === 'real' && already === null) {
        const deny = await this.budget.guardLlmProxyCall({
          subject: parsed.subject, itemRunId: parsed.itemRunId ?? null, model: parsed.model,
          promptChars: parsed.promptChars, maxTokens: parsed.maxTokens, billingAccount: parsed.billingAccount,
        });
        if (deny) throw new ConflictException({ code: deny.code, message: deny.message, runId: deny.runId, paused: deny.paused });
      }
      let r;
      try {
        r = await this.ledger.recordCharge(llmReservationToChargeInput(parsed));
      } catch (err) {
        // FinOps atómico: otra reserva concurrente del run llegó antes al tope → el proxy no llama y el run se pausa.
        if (err instanceof FinopsError && err.code === 'RUN_BUDGET_CAP') {
          const d = (err.details ?? {}) as Record<string, unknown>;
          const runId = String(d.runId ?? '');
          const detail = err.message.replace(/^RUN_BUDGET_CAP:\s*/, '');
          const paused = runId ? await this.budget.pauseRunBySystem(runId, 'run_budget_cap', detail, Number(d.requiredUsd ?? NaN) || null).catch(() => false) : false;
          throw new ConflictException({ code: 'run_paused', message: 'Pausa automática: se alcanzó el presupuesto autorizado del run: ' + detail, runId, paused });
        }
        // r58 H4: el run no tiene ninguna autorización (el guard ya lo negó salvo carrera) → falla cerrado, run pausado.
        if (err instanceof FinopsError && err.code === 'RUN_BUDGET_NOT_AUTHORIZED') {
          const runId = String(((err.details ?? {}) as Record<string, unknown>).runId ?? '');
          const detail = err.message.replace(/^RUN_BUDGET_NOT_AUTHORIZED:\s*/, '');
          const paused = runId ? await this.budget.pauseRunBySystem(runId, RUN_BUDGET_NOT_AUTHORIZED, detail).catch(() => false) : false;
          throw new ConflictException({ code: RUN_BUDGET_NOT_AUTHORIZED, message: detail, runId, paused });
        }
        throw err;
      }
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

  // GET /api/v1/finops/llm-worker-reservations?courseId=&runId= — Loop 4: llamadas del worker de IA del backend cuyo
  // resultado es desconocido (o quedó sin liquidar). Cuentan como gasto mientras tanto.
  @Get('llm-worker-reservations')
  async llmWorkerReservations(@Query('courseId') courseId?: string, @Query('runId') runId?: string) {
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
      return { reservations: await this.ledger.pendingLlmWorkerReservations(f) };
    } catch (err) {
      throw finopsErrorToHttp(err);
    }
  }

  // POST /api/v1/finops/llm-worker-reservations/reconcile {reservationKey, outcome: 'charged'|'not_charged'|'charged_partial', reason, amount?, evidence?}
  // Decisión HUMANA (SUPER_ADMIN), con motivo; nunca automática. Repetir = no-op.
  @Post('llm-worker-reservations/reconcile')
  @HttpCode(HttpStatus.OK)
  async reconcileLlmWorkerReservation(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    for (const k of Object.keys(b)) if (!['reservationKey', 'outcome', 'reason', 'amount', 'evidence'].includes(k)) throw new BadRequestException(`campo no permitido: ${k}`);
    if (typeof b.reservationKey !== 'string' || !/^reservation:llm:[0-9a-f-]{36}:[A-Za-z0-9_.:-]{1,200}$/.test(b.reservationKey)) {
      throw new BadRequestException('reservationKey inválida');
    }
    const d = parseDecisionOrBadRequest(b, ['reservationKey']);
    const decidedBy = String(user?.id || '');
    if (!decidedBy) throw new BadRequestException('usuario sin id');
    try {
      const kind = await this.ledger.isLlmWorkerReservation(b.reservationKey);
      if (kind === 'not_worker') throw new BadRequestException('no es una reserva del worker de IA');
      if (kind === 'item_running') throw new ConflictException('la parte sigue en ejecución: la llamada puede liquidarse sola; conciliar cuando termine');
      return await applyReconcileDecision(this.ledger, b.reservationKey, d, decidedBy, { llmWorker: true });
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof ConflictException) throw err;
      throw finopsErrorToHttp(err);
    }
  }

  // GET /api/v1/finops/tts-reservations?courseId=&runId= — r59: segmentos de TTS de OpenAI cuyo resultado es desconocido
  // (timeout del cliente: OpenAI suele generar y cobrar igual). Cuentan como gasto mientras tanto.
  @Get('tts-reservations')
  async ttsReservations(@Query('courseId') courseId?: string, @Query('runId') runId?: string) {
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
      return { reservations: await this.ledger.pendingTtsReservations(f) };
    } catch (err) {
      throw finopsErrorToHttp(err);
    }
  }

  // POST /api/v1/finops/tts-reservations/reconcile {reservationKey, outcome: 'charged'|'not_charged'|'charged_partial', reason, amount?, evidence?}
  // r59: decisión HUMANA (SUPER_ADMIN), con motivo; nunca automática. Repetir = no-op.
  @Post('tts-reservations/reconcile')
  @HttpCode(HttpStatus.OK)
  async reconcileTtsReservation(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    const b = parseTtsReservationReconcileBody(body);
    const decidedBy = String(user?.id || '');
    if (!decidedBy) throw new BadRequestException('usuario sin id');
    try {
      const kind = await this.ledger.isTtsReservation(b.reservationKey);
      if (kind === 'not_tts') throw new BadRequestException('no es una reserva de TTS');
      if (kind === 'item_running') throw new ConflictException('la parte sigue en ejecución: la llamada puede liquidarse sola; conciliar cuando termine');
      return await applyReconcileDecision(this.ledger, b.reservationKey, b, decidedBy, { ttsReservation: true });
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof ConflictException) throw err;
      throw finopsErrorToHttp(err);
    }
  }

  // POST /api/v1/finops/llm-proxy-reservations/:callId/reconcile {outcome: 'charged'|'not_charged'|'charged_partial', reason, amount?, evidence?}
  // Decisión HUMANA (SUPER_ADMIN), con motivo; nunca automática. Repetir = no-op.
  @Post('llm-proxy-reservations/:callId/reconcile')
  @HttpCode(HttpStatus.OK)
  async reconcileLlmProxyReservation(@Param('callId') callId: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    if (!UUID_RE.test(callId)) throw new BadRequestException('callId debe ser UUID');
    const d = parseDecisionOrBadRequest(body);
    const decidedBy = String(user?.id || ''); // re-review (minor b): id, nunca el email, en el ledger
    if (!decidedBy) throw new BadRequestException('usuario sin id');
    try {
      return await applyReconcileDecision(this.ledger, llmProxyReservationKey(callId), d, decidedBy, { llmProxy: true });
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      throw finopsErrorToHttp(err);
    }
  }
}
