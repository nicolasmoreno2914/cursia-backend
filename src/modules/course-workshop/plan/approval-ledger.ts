/**
 * r107 B5 fix round 1 (P1-1) · Cierre de la RESERVA de una aprobación con el mismo criterio que el proxy LLM
 * (`LLM_RESERVATION_RELEASABLE_STATUSES`): nunca se libera a 0 si Anthropic pudo haber cobrado sin que el ledger tenga
 * el cargo.
 *
 * Estado por llamada (se guarda ANTES de enviar):
 *   sent              enviada, sin respuesta todavía (si el proceso se cae acá, queda así → ambigua);
 *   charged           respondió y su cargo quedó en el ledger;
 *   not_charged       Anthropic la rechazó con un estado documentado SIN cobro (401/403/404/413/429/500/529);
 *   not_sent          (fix round 2, N1) falló ANTES de que el pedido saliera (kill switch, sin clave, construcción del
 *                     cliente): no pudo cobrarse;
 *   ambiguous         se envió y falló sin un rechazo seguro (timeout, red, 400, 5xx…): pudo cobrarse;
 *   charge_unrecorded respondió, pero `recordCharge` falló: se reintenta al cerrar con el MISMO cargo (idempotente).
 *
 * Al cerrar: se reintentan los cargos no registrados; si después de eso TODAS las llamadas son `charged`, `not_charged`
 * o `not_sent`, la reserva se libera (`settleReservation(key, null)`). Si queda alguna `sent` / `ambiguous` /
 * `charge_unrecorded`, la reserva queda PENDIENTE (cuenta el tope entero contra el saldo) para la conciliación
 * administrativa, y la aprobación pasa a `ambiguous` con el motivo visible.
 *
 * Modo simulado (pruebas): no se reserva en el ledger (fix round 1, P2-2): nada queda pendiente.
 */
import type { FinopsLedgerService, RecordChargeInput } from '../../finops/finops-ledger.service';
import { LLM_RESERVATION_RELEASABLE_STATUSES } from '../../finops/llm-usage-ingest';

export type CallStatus = 'sent' | 'charged' | 'not_charged' | 'not_sent' | 'ambiguous' | 'charge_unrecorded';

export interface ApprovalCall {
  id: string;
  kind: string;
  attempt: number;
  boundUsd: string;
  status: CallStatus;
  at: string;
  messageId?: string | null;
  costUsd?: string | null;
  providerStatus?: number | null;
  error?: string | null;
  /** Solo `charge_unrecorded`: el cargo a reintentar (idempotente por el id del mensaje). */
  charge?: RecordChargeInput | null;
}

/** ¿El error del proveedor prueba que NO hubo cobro? Solo los estados documentados (los mismos del proxy). */
export function callErrorOutcome(err: unknown): { status: 'not_charged' | 'not_sent' | 'ambiguous'; providerStatus: number | null } {
  // Fix round 2 (N1): el cliente marca los errores previos al envío (frontera explícita en AnthropicWorkshopAiClient).
  if ((err as { notSent?: unknown })?.notSent === true) return { status: 'not_sent', providerStatus: null };
  const st = (err as { status?: unknown })?.status;
  const n = typeof st === 'number' ? st : null;
  return { status: n !== null && (LLM_RESERVATION_RELEASABLE_STATUSES as readonly number[]).includes(n) ? 'not_charged' : 'ambiguous', providerStatus: n };
}

const UNRESOLVED: ReadonlySet<CallStatus> = new Set(['sent', 'ambiguous', 'charge_unrecorded']);

export interface CloseOutcome {
  /** released = reserva liberada; pending = queda pendiente (ambigua); none = no había reserva (modo simulado). */
  reservation: 'released' | 'pending' | 'none';
  calls: Record<string, ApprovalCall>;
  unresolved: ApprovalCall[];
  reason: string | null;
}

/** Reintenta los cargos no registrados y decide si la reserva se libera o queda pendiente. */
export async function closeReservation(ledger: Pick<FinopsLedgerService, 'recordCharge' | 'settleReservation'> | null | undefined, a: { reservationKey: string | null; calls: Record<string, ApprovalCall> }, reasonTag: string): Promise<CloseOutcome> {
  const calls: Record<string, ApprovalCall> = JSON.parse(JSON.stringify(a.calls ?? {}));
  for (const c of Object.values(calls)) {
    if (c.status !== 'charge_unrecorded' || !c.charge || !ledger) continue;
    try {
      await ledger.recordCharge(c.charge);
      c.status = 'charged';
      c.charge = null;
      c.error = null;
    } catch (err) {
      c.error = `el cargo sigue sin registrarse: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
    }
  }
  const unresolved = Object.values(calls).filter((c) => UNRESOLVED.has(c.status));
  if (unresolved.length) {
    return {
      reservation: a.reservationKey ? 'pending' : 'none', calls, unresolved,
      reason: `${unresolved.length} llamada(s) a la IA quedaron con resultado desconocido o sin su cargo registrado: la reserva del tope queda PENDIENTE hasta conciliarla (no se libera el saldo para no perder un gasto real).`,
    };
  }
  if (!a.reservationKey || !ledger) return { reservation: 'none', calls, unresolved, reason: null };
  await ledger.settleReservation(a.reservationKey, null, reasonTag, { recordedBy: 'course-workshop' });
  return { reservation: 'released', calls, unresolved, reason: null };
}
