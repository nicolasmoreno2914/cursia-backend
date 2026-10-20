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

/**
 * r62 (integración N1 × N2): UNA sola vía de conciliación por reserva. Si la operación tiene un id CONSULTABLE en el
 * proveedor (Videogen jobId; Gamma generationId), la concilia el barrido de N2 (provider-reconcile.service.ts) con la
 * EVIDENCIA (estado / costo / credits.deducted); esta vía conservadora (`possible_duplicate`) solo toma las reservas SIN
 * id consultable (TTS de OpenAI, Anthropic, Gamma/Videogen sin id). Así nunca hay dos liquidaciones ni un ADJUSTMENT
 * que contradiga la evidencia. Puro.
 */
export function reservationHasConsultableId(key: string, outputSummary: Record<string, any> | null | undefined): boolean {
  const os = outputSummary ?? {};
  const exts: Array<Record<string, any>> = [
    { external: os.external, externalReservationKey: os.externalReservationKey },
    ...(Array.isArray(os.previousExternals) ? os.previousExternals : []),
  ].filter((x) => x && typeof x === 'object');
  if (/^reservation:videogen:/.test(key)) {
    return exts.some((x) => typeof x.external?.videogenJobId === 'string' && x.external.videogenJobId !== ''
      && (!x.externalReservationKey || x.externalReservationKey === key));
  }
  if (/^reservation:gamma:/.test(key)) {
    return exts.some((x) => typeof x.external?.gammaGenerationId === 'string' && x.external.gammaGenerationId !== ''
      && (!x.externalReservationKey || x.externalReservationKey === key));
  }
  return false;
}
