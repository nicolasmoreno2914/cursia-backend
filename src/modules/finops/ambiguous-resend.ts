// ─────────────────────────────────────────────────────────────────────────────
// r62 — REGLA DE AMBIGÜEDAD ACOTADA (punto 3), parte del ledger.
//
// Cuando una llamada pagada queda realmente ambigua y el proveedor no tiene idempotencia ni consulta de estado
// (OpenAI TTS, Anthropic), la reserva perdida se liquida de forma CONSERVADORA como `charged` (ADJUSTMENT de delta 0:
// el monto reservado sigue contado como gasto) con la marca `possibleDuplicate` y el motivo, antes de UN reenvío
// automático. El actor es `system` (nunca un humano): queda en el ledger quién y por qué.
// Repetir es un no-op (`alreadySettled`). Una reserva que ya no está pendiente se ignora (nunca cambia una decisión).
// ─────────────────────────────────────────────────────────────────────────────
import type { FinopsLedgerService } from './finops-ledger.service';

export const POSSIBLE_DUPLICATE_ACTOR = 'system';
export const POSSIBLE_DUPLICATE_RECORDED_BY = 'auto-recovery';

/** Motivo de la ambigüedad (texto estable para el ledger y el log de intentos). */
export type AmbiguityCause = 'timeout_presumed_charged' | 'connection_cut' | 'unknown_result' | 'manual_resubmit';

export interface PossibleDuplicateSettlement {
  settled: string[];
  alreadySettled: string[];
  /** Reservas que no se pudieron liquidar (siguen pendientes: igual cuentan como gasto). */
  failed: Array<{ key: string; error: string }>;
}

export async function settleAmbiguousAsPossibleDuplicate(
  ledger: Pick<FinopsLedgerService, 'reconcileReservationAsCharged'>,
  keys: readonly string[],
  a: { provider: string; cause: AmbiguityCause; itemRunId: string; itemKey?: string | null; runId?: string | null },
  /** Quién decide: `system` (automático) o el admin/dueño del reenvío explícito. */
  decidedBy: string = POSSIBLE_DUPLICATE_ACTOR,
): Promise<PossibleDuplicateSettlement> {
  const out: PossibleDuplicateSettlement = { settled: [], alreadySettled: [], failed: [] };
  for (const key of [...new Set(keys)]) {
    try {
      const r = await ledger.reconcileReservationAsCharged(
        key,
        `${decidedBy === POSSIBLE_DUPLICATE_ACTOR ? 'auto' : 'reenvío explícito'}: ${a.cause === 'timeout_presumed_charged' ? 'timeout presumido cobrado' : a.cause === 'connection_cut' ? 'conexión cortada después del envío' : a.cause === 'manual_resubmit' ? 'reenvío explícito de una operación incierta' : 'resultado desconocido'} ` +
          `(${a.provider}); se cuenta como cobrada (posible duplicado) para el reenvío único`,
        {
          decidedBy,
          recordedBy: POSSIBLE_DUPLICATE_RECORDED_BY,
          metadata: { possibleDuplicate: true, auto: true, cause: a.cause, provider: a.provider, itemRunId: a.itemRunId,
            ...(a.itemKey ? { itemKey: a.itemKey } : {}), ...(a.runId ? { runId: a.runId } : {}), rule: 'r62_bounded_ambiguity' },
        },
      );
      (r.alreadySettled ? out.alreadySettled : out.settled).push(key);
    } catch (err) {
      out.failed.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
