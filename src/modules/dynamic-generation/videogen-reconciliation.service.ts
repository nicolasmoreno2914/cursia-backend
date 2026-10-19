import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinopsLedgerService } from '../finops/finops-ledger.service';
import { normalizeDecimal } from '../finops/decimal';
import { FinopsError } from '../finops/errors';
import { parseReconcileDecision } from '../finops/reconcile-decision';
import { isSuperAdminEmail } from '../../auth/super-admin';
import { loadPendingVideogenReservations, PendingVideogenReservation } from './run-completion';

/**
 * V542 (G6) — conciliación EXPLÍCITA de reservas de Videogen (SUPER_ADMIN).
 *
 * Caso del curso #542: tres videos fallaron con `videogen_failed: generate_script … 429` ANTES del render;
 * un admin los reenvió (resubmitVideo) y salieron bien, pero la reserva de cada intento fallido quedó
 * PENDIENTE (USD 2.82). Videogen no informa en el estado del job si cobró un job fallido (el payload trae
 * `status` y `error`; `estimated_total_cost` es un ESTIMADO, no un cobro), así que el resultado es incierto
 * y, por regla del usuario, nunca se libera solo ni se da por «sin costo». Un SUPER_ADMIN lo decide después
 * de mirar la cuenta de Videogen:
 *  - `not_charged` → ADJUSTMENT `final` que lleva la reserva a 0 (`reconciled_as_not_charged`);
 *  - `charged`     → ADJUSTMENT `final` con delta 0 (`reconciled_as_charged`, el monto sigue contado).
 *  - `charged_partial` (r60) → ADJUSTMENT `final` que lleva la reserva a `amount` (0 < amount ≤ reservado) con
 *    evidencia estructurada (p.ej. el consumo interno del job en la base de Videogen, sin render).
 * Append-only (el CHARGE original queda), con motivo, actor y run en la metadata. Solo reservas que
 * `loadPendingVideogenReservations` devuelve (nunca la del intento en curso de un item vivo).
 */
export type VideogenReconcileOutcome = 'not_charged' | 'charged' | 'charged_partial';
export const VIDEOGEN_RECONCILE_OUTCOMES: readonly VideogenReconcileOutcome[] = ['not_charged', 'charged', 'charged_partial'];
/** Motivo mínimo (auditoría: qué se verificó en Videogen). */
export const VIDEOGEN_RECONCILE_REASON_MIN = 10;

export interface VideogenReconcileResult {
  runId: string;
  reservationKey: string;
  outcome: VideogenReconcileOutcome;
  reconciled: boolean;
  alreadySettled: boolean;
  amount: string;
  /** Monto que queda contado como gasto de esta reserva tras la decisión. */
  countedAmount: string;
  adjustmentEventId: string | null;
  remaining: PendingVideogenReservation[];
}

@Injectable()
export class VideogenReconciliationService {
  private readonly logger = new Logger(VideogenReconciliationService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: FinopsLedgerService,
  ) {}

  private async runOrThrow(runId: string): Promise<{ id: string; course_id: number }> {
    const [run] = await this.dataSource.query(
      `select id, course_id from public.production_jobs where id = $1 and execution_mode = 'dynamic_generation'`,
      [runId],
    );
    if (!run) throw new NotFoundException(`No existe la ejecución ${runId}`);
    return run;
  }

  async listPending(runId: string): Promise<{ runId: string; courseId: number; pending: PendingVideogenReservation[] }> {
    const run = await this.runOrThrow(runId);
    return { runId, courseId: Number(run.course_id), pending: await loadPendingVideogenReservations(this.dataSource, runId) };
  }

  /** Decisión registrada en el ledger para la reserva (null = liquidada por otra vía o sin ajuste). */
  private async recordedOutcome(reservationKey: string): Promise<VideogenReconcileOutcome | null> {
    const [a] = await this.dataSource.query(
      `select a.metadata->>'settlement' as label from public.generation_cost_events a
        where a.corrects_event_id = (select id from public.generation_cost_events where idempotency_key = $1 and event_kind = 'CHARGE')
          and a.event_kind = 'ADJUSTMENT' order by a.created_at desc, a.id desc limit 1`,
      [reservationKey],
    );
    return a?.label === 'reconciled_as_not_charged' ? 'not_charged' : a?.label === 'reconciled_as_charged' ? 'charged'
      : a?.label === 'reconciled_as_charged_partial' ? 'charged_partial' : null;
  }

  /** Neto de la familia de la reserva (CHARGE + sus ajustes) = lo que queda contado. */
  private async countedOf(eventId: string): Promise<string> {
    const [n] = await this.dataSource.query(
      `select coalesce(sum(amount),0)::text as t from public.generation_cost_events where id = $1 or corrects_event_id = $1`,
      [eventId],
    );
    return normalizeDecimal(n?.t ?? '0');
  }

  async reconcile(
    runId: string,
    body: { reservationKey?: unknown; outcome?: unknown; reason?: unknown; acknowledgeMayHaveRendered?: unknown; amount?: unknown; evidence?: unknown },
    actor: { id: string; email?: string | null },
  ): Promise<VideogenReconcileResult> {
    // Defensa en profundidad (el controlador ya exige SuperAdminGuard).
    if (!isSuperAdminEmail(actor?.email)) {
      throw new ForbiddenException({ code: 'admin_recovery_only', message: 'admin_recovery_only: conciliar una reserva de Videogen es una herramienta de un administrador de Cursia. No se hizo nada.' });
    }
    const reservationKey = typeof body?.reservationKey === 'string' ? body.reservationKey.trim() : '';
    const outcome = body?.outcome as VideogenReconcileOutcome;
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    const extra = Object.keys(body ?? {}).filter((k) => !['reservationKey', 'outcome', 'reason', 'acknowledgeMayHaveRendered', 'amount', 'evidence'].includes(k));
    if (extra.length) throw new BadRequestException(`campos no permitidos: ${extra.join(', ')}`);
    if (body?.acknowledgeMayHaveRendered !== undefined && typeof body.acknowledgeMayHaveRendered !== 'boolean') {
      throw new BadRequestException('acknowledgeMayHaveRendered debe ser booleano');
    }
    const ack = body?.acknowledgeMayHaveRendered === true;
    if (!reservationKey) throw new BadRequestException('reservationKey es obligatorio');
    if (!VIDEOGEN_RECONCILE_OUTCOMES.includes(outcome)) throw new BadRequestException(`outcome debe ser ${VIDEOGEN_RECONCILE_OUTCOMES.join(' | ')}`);
    if (reason.length < VIDEOGEN_RECONCILE_REASON_MIN || reason.length > 500) {
      throw new BadRequestException(`reason es obligatorio (${VIDEOGEN_RECONCILE_REASON_MIN}–500 caracteres): qué se verificó en la cuenta de Videogen`);
    }
    // r60: `charged_partial` exige amount (> 0) y evidence estructurada; los otros dos outcomes no las aceptan.
    let partial: { amount: string; evidence: NonNullable<ReturnType<typeof parseReconcileDecision>['evidence']> } | null = null;
    try {
      const d = parseReconcileDecision({ outcome, reason, ...(body?.amount !== undefined ? { amount: body.amount } : {}), ...(body?.evidence !== undefined ? { evidence: body.evidence } : {}) },
        { reasonMin: VIDEOGEN_RECONCILE_REASON_MIN });
      if (d.outcome === 'charged_partial') partial = { amount: d.amount as string, evidence: d.evidence as NonNullable<typeof d.evidence> };
    } catch (err) {
      if (err instanceof FinopsError) throw new BadRequestException(err.message.replace(/^INVALID_INPUT:\s*/, ''));
      throw err;
    }
    await this.runOrThrow(runId);
    const pending = await loadPendingVideogenReservations(this.dataSource, runId);
    const target = pending.find((p) => p.reservationKey === reservationKey);
    // V542 fix round 1 (I4): «no cobrado» de un intento que pudo renderizarse/cobrarse exige el reconocimiento explícito.
    // r60: también para `charged_partial` (contar menos que la reserva de un intento que pudo renderizarse).
    if (target && outcome !== 'charged' && target.mayHaveRendered && !ack) {
      throw new ConflictException({
        code: 'may_have_rendered_ack_required',
        message: `may_have_rendered_ack_required: la reserva es de un intento que pudo renderizarse o cobrarse (${target.attemptState}${target.videogenJobId ? ', con job de Videogen registrado' : ''}). ` +
          'Para registrarla como NO cobrada (o cobrada en parte), confirma en la cuenta de Videogen que ese job no se cobró y reenvía con acknowledgeMayHaveRendered: true (y el motivo). No se hizo nada.',
        attemptState: target.attemptState,
      });
    }
    if (!target) {
      // ¿Ya conciliada (idempotente) o no conciliable (otro run, en curso, mock, otro proveedor)?
      const [ev] = await this.dataSource.query(
        `select e.id, e.run_id, e.provider, e.amount::text as amount,
                (select a.metadata from public.generation_cost_events a where a.corrects_event_id = e.id and a.event_kind = 'ADJUSTMENT'
                  order by a.created_at desc, a.id desc limit 1) as adj
           from public.generation_cost_events e where e.idempotency_key = $1 and e.event_kind = 'CHARGE'`,
        [reservationKey],
      );
      if (ev && String(ev.run_id) === runId && ev.provider === 'videogen' && ev.adj) {
        const label = ev.adj.settlement;
        const counted = await this.countedOf(ev.id);
        const same = (outcome === 'not_charged' && label === 'reconciled_as_not_charged') || (outcome === 'charged' && label === 'reconciled_as_charged')
          || (outcome === 'charged_partial' && label === 'reconciled_as_charged_partial' && !!partial && counted === partial.amount);
        if (!same) {
          throw new ConflictException({ code: 'reservation_already_settled', message: `reservation_already_settled: La reserva ya está liquidada (${String(label ?? 'liquidada')}); no se cambia una decisión registrada.` });
        }
        return {
          runId, reservationKey, outcome, reconciled: false, alreadySettled: true, amount: ev.amount,
          countedAmount: counted, adjustmentEventId: null, remaining: pending,
        };
      }
      throw new ConflictException({ code: 'reservation_not_reconcilable', message: 'reservation_not_reconcilable: La reserva no es una reserva de Videogen pendiente de esta ejecución que ningún worker vaya a liquidar.' });
    }
    const meta = {
      runId, itemKey: target.itemKey, outcome, decidedById: actor.id, decidedByRole: 'SUPER_ADMIN', failureCode: target.failureCode,
      attemptState: target.attemptState, videogenJobId: target.videogenJobId,
      ...(outcome !== 'charged' && target.mayHaveRendered ? { acknowledgedMayHaveRendered: true } : {}),
    };
    const recordedBy = 'admin_reconcile_videogen';
    const r = outcome === 'not_charged'
      ? await this.ledger.reconcileReservationAsNotCharged(reservationKey, reason, { decidedBy: actor.id, recordedBy, metadata: meta })
      : outcome === 'charged_partial' && partial
        ? await this.ledger.reconcileReservationAsChargedPartial(reservationKey, partial.amount, reason, partial.evidence, { decidedBy: actor.id, recordedBy, metadata: meta })
        : await this.ledger.reconcileReservationAsCharged(reservationKey, reason, { decidedBy: actor.id, recordedBy, metadata: meta });
    const countedAfter = async () => {
      const [e] = await this.dataSource.query(`select id from public.generation_cost_events where idempotency_key = $1 and event_kind = 'CHARGE'`, [reservationKey]);
      return e ? this.countedOf(e.id) : normalizeDecimal(0);
    };
    if (r.alreadySettled) {
      // Fix round 1 (M1): otra decisión ganó la carrera (lock del ledger): se informa la registrada, nunca la pedida.
      const recorded = await this.recordedOutcome(reservationKey);
      const counted = await countedAfter();
      if (recorded !== outcome || (outcome === 'charged_partial' && partial && counted !== partial.amount)) {
        throw new ConflictException({ code: 'reservation_already_settled', message: `reservation_already_settled: La reserva ya se concilió como ${recorded ?? 'liquidada'}; no se cambia una decisión registrada.` });
      }
      return {
        runId, reservationKey, outcome, reconciled: false, alreadySettled: true, amount: r.amount,
        countedAmount: counted, adjustmentEventId: null,
        remaining: await loadPendingVideogenReservations(this.dataSource, runId),
      };
    }
    this.logger.warn(`reconcile_videogen: run ${runId} ${target.itemKey} reserva ${reservationKey} → ${outcome} (${target.amount}${partial ? ` → ${partial.amount}` : ''}) por ${actor.id}`);
    return {
      runId, reservationKey, outcome, reconciled: r.reconciled, alreadySettled: r.alreadySettled, amount: r.amount,
      countedAmount: outcome === 'charged' ? r.amount : outcome === 'charged_partial' && partial ? partial.amount : normalizeDecimal(0),
      adjustmentEventId: r.event ? String((r.event as { id?: unknown }).id ?? '') || null : null,
      remaining: await loadPendingVideogenReservations(this.dataSource, runId),
    };
  }
}
