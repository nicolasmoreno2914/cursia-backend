import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinopsLedgerService } from '../finops/finops-ledger.service';
import { normalizeDecimal } from '../finops/decimal';
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
 * Append-only (el CHARGE original queda), con motivo, actor y run en la metadata. Solo reservas que
 * `loadPendingVideogenReservations` devuelve (nunca la del intento en curso de un item vivo).
 */
export type VideogenReconcileOutcome = 'not_charged' | 'charged';
export const VIDEOGEN_RECONCILE_OUTCOMES: readonly VideogenReconcileOutcome[] = ['not_charged', 'charged'];
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

  async reconcile(
    runId: string,
    body: { reservationKey?: unknown; outcome?: unknown; reason?: unknown },
    actor: { id: string; email?: string | null },
  ): Promise<VideogenReconcileResult> {
    // Defensa en profundidad (el controlador ya exige SuperAdminGuard).
    if (!isSuperAdminEmail(actor?.email)) {
      throw new ForbiddenException({ code: 'admin_recovery_only', message: 'admin_recovery_only: conciliar una reserva de Videogen es una herramienta de un administrador de Cursia. No se hizo nada.' });
    }
    const reservationKey = typeof body?.reservationKey === 'string' ? body.reservationKey.trim() : '';
    const outcome = body?.outcome as VideogenReconcileOutcome;
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!reservationKey) throw new BadRequestException('reservationKey es obligatorio');
    if (!VIDEOGEN_RECONCILE_OUTCOMES.includes(outcome)) throw new BadRequestException(`outcome debe ser ${VIDEOGEN_RECONCILE_OUTCOMES.join(' | ')}`);
    if (reason.length < VIDEOGEN_RECONCILE_REASON_MIN || reason.length > 500) {
      throw new BadRequestException(`reason es obligatorio (${VIDEOGEN_RECONCILE_REASON_MIN}–500 caracteres): qué se verificó en la cuenta de Videogen`);
    }
    await this.runOrThrow(runId);
    const pending = await loadPendingVideogenReservations(this.dataSource, runId);
    const target = pending.find((p) => p.reservationKey === reservationKey);
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
        const same = (outcome === 'not_charged' && label === 'reconciled_as_not_charged') || (outcome === 'charged' && label === 'reconciled_as_charged');
        if (!same) {
          throw new ConflictException({ code: 'reservation_already_settled', message: `reservation_already_settled: La reserva ya está liquidada (${String(label ?? 'liquidada')}); no se cambia una decisión registrada.` });
        }
        return {
          runId, reservationKey, outcome, reconciled: false, alreadySettled: true, amount: ev.amount,
          countedAmount: outcome === 'charged' ? ev.amount : normalizeDecimal(0), adjustmentEventId: null, remaining: pending,
        };
      }
      throw new ConflictException({ code: 'reservation_not_reconcilable', message: 'reservation_not_reconcilable: La reserva no es una reserva de Videogen pendiente de esta ejecución que ningún worker vaya a liquidar.' });
    }
    const meta = { runId, itemKey: target.itemKey, outcome, decidedById: actor.id, decidedByRole: 'SUPER_ADMIN', failureCode: target.failureCode };
    const recordedBy = 'admin_reconcile_videogen';
    const r = outcome === 'not_charged'
      ? await this.ledger.reconcileReservationAsNotCharged(reservationKey, reason, { decidedBy: actor.id, recordedBy, metadata: meta })
      : await this.ledger.reconcileReservationAsCharged(reservationKey, reason, { decidedBy: actor.id, recordedBy, metadata: meta });
    this.logger.warn(`reconcile_videogen: run ${runId} ${target.itemKey} reserva ${reservationKey} → ${outcome} (${target.amount}) por ${actor.id}`);
    return {
      runId, reservationKey, outcome, reconciled: r.reconciled, alreadySettled: r.alreadySettled, amount: r.amount,
      countedAmount: outcome === 'charged' ? r.amount : normalizeDecimal(0),
      adjustmentEventId: r.event ? String((r.event as { id?: unknown }).id ?? '') || null : null,
      remaining: await loadPendingVideogenReservations(this.dataSource, runId),
    };
  }
}
