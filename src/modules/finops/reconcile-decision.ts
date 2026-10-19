import { FinopsError } from './errors';
import { cmpDec, normalizeDecimal } from './decimal';

/**
 * r60 (Agent C) — decisión administrativa sobre una reserva pagada cuyo resultado quedó INCIERTO.
 *
 *  - `charged`         → la reserva completa cuenta como gasto (ADJUSTMENT delta 0, `reconciled_as_charged`).
 *  - `not_charged`     → la reserva se libera a 0 (`reconciled_as_not_charged`).
 *  - `charged_partial` → el proveedor cobró MENOS que la cota reservada y hay EVIDENCIA del monto (p.ej. la base de
 *                        Videogen muestra el consumo interno de un job sin render): la reserva se lleva a `amount`
 *                        (0 < amount ≤ reservado) con un ADJUSTMENT `reconciled_as_charged_partial`. Exige `evidence`
 *                        estructurada (fuente, ids de referencia, monto observado). Nunca automático.
 *
 * Solo validación pura (sin DB): la usan los cuatro endpoints de conciliación (worker de IA, TTS, proxy LLM, Videogen)
 * y el ledger (defensa en profundidad).
 */
export type ReconcileOutcome = 'charged' | 'not_charged' | 'charged_partial';
export const RECONCILE_OUTCOMES: readonly ReconcileOutcome[] = ['charged', 'not_charged', 'charged_partial'];

/** De dónde sale el monto observado (lista cerrada: auditoría). */
export const RECONCILE_EVIDENCE_SOURCES = [
  'provider_console',          // consola / dashboard de uso del proveedor (OpenAI usage, Anthropic console)
  'provider_invoice',          // factura del proveedor
  'provider_usage_log',        // log de uso del proveedor por request/job (p.ej. Videogen api_usage_logs)
  'provider_api_response',     // respuesta tardía de la API del proveedor con el uso
  'equivalent_request_ledger', // misma unidad de trabajo medida en otra llamada del ledger (estimación con base real)
] as const;
export type ReconcileEvidenceSource = (typeof RECONCILE_EVIDENCE_SOURCES)[number];

export interface ReconcileEvidence {
  source: ReconcileEvidenceSource;
  /** Ids que permiten rehacer la verificación (job id, request id, idempotency_key de la llamada equivalente…). */
  referenceIds: string[];
  /** Monto observado en la fuente (USD, decimal normalizado a 10 decimales). Debe ser igual a `amount` (M1). */
  observedAmount: string;
  /** Opcional en el cuerpo (default USD); solo se acepta 'USD'. Siempre presente tras el parseo. */
  currency: 'USD';
  /** Qué se observó exactamente (opcional, ≤ 1000). */
  notes?: string;
  /** Cuándo se observó (ISO, opcional). */
  observedAt?: string;
}

export interface ReconcileDecision {
  outcome: ReconcileOutcome;
  reason: string;
  /** Solo `charged_partial`: monto que queda contado (decimal normalizado). */
  amount?: string;
  /** Solo `charged_partial` (obligatoria). */
  evidence?: ReconcileEvidence;
}

const EVIDENCE_KEYS = new Set(['source', 'referenceIds', 'observedAmount', 'currency', 'notes', 'observedAt']);
const REF_RE = /^[A-Za-z0-9_.:\-/#]{1,200}$/;
const AMOUNT_RE = /^\d{1,9}(\.\d{1,10})?$/;

function bad(msg: string): never {
  throw new FinopsError('INVALID_INPUT', msg);
}

/** Evidencia estructurada de un `charged_partial`. Lanza FinopsError INVALID_INPUT. */
export function parseReconcileEvidence(raw: unknown): ReconcileEvidence {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('evidence es obligatoria en charged_partial ({source, referenceIds, observedAmount})');
  const e = raw as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!EVIDENCE_KEYS.has(k)) bad(`evidence: campo no permitido: ${k}`);
  if (typeof e.source !== 'string' || !(RECONCILE_EVIDENCE_SOURCES as readonly string[]).includes(e.source)) {
    bad(`evidence.source debe ser ${RECONCILE_EVIDENCE_SOURCES.join(' | ')}`);
  }
  if (!Array.isArray(e.referenceIds) || e.referenceIds.length < 1 || e.referenceIds.length > 20) bad('evidence.referenceIds: 1–20 ids');
  const refs = (e.referenceIds as unknown[]).map((r) => {
    if (typeof r !== 'string' || !REF_RE.test(r)) bad('evidence.referenceIds: cada id es texto [A-Za-z0-9_.:-/#] de 1–200');
    return r as string;
  });
  if (typeof e.observedAmount !== 'string' || !AMOUNT_RE.test(e.observedAmount)) bad('evidence.observedAmount: decimal en texto (p.ej. "0.5351")');
  if (e.currency !== undefined && e.currency !== 'USD') bad('evidence.currency: solo USD');
  if (e.notes !== undefined && (typeof e.notes !== 'string' || e.notes.length > 1000)) bad('evidence.notes: texto ≤ 1000');
  if (e.observedAt !== undefined && (typeof e.observedAt !== 'string' || !Number.isFinite(Date.parse(e.observedAt)))) bad('evidence.observedAt: fecha ISO');
  return {
    source: e.source as ReconcileEvidenceSource,
    referenceIds: refs,
    observedAmount: normalizeDecimal(e.observedAmount as string),
    currency: 'USD',
    ...(typeof e.notes === 'string' && e.notes.trim() ? { notes: e.notes.trim() } : {}),
    ...(typeof e.observedAt === 'string' ? { observedAt: new Date(e.observedAt).toISOString() } : {}),
  };
}

/** Monto de un `charged_partial`: decimal en texto, > 0 (para 0 se usa `not_charged`). El tope (≤ reservado) lo valida el ledger. */
export function parsePartialAmount(raw: unknown): string {
  if (typeof raw !== 'string' || !AMOUNT_RE.test(raw)) bad('amount: decimal en texto (p.ej. "0.5351")');
  const amount = normalizeDecimal(raw as string);
  if (cmpDec(amount, 0) <= 0) bad('amount debe ser > 0 (para 0 usar outcome not_charged)');
  return amount;
}

/**
 * Cuerpo de una conciliación: {outcome, reason, amount?, evidence?} (+ las claves propias del endpoint en
 * `extraKeys`). `amount`/`evidence` solo con `charged_partial` (y ahí obligatorias). Lanza FinopsError INVALID_INPUT.
 */
export function parseReconcileDecision(
  body: unknown,
  opts: { extraKeys?: readonly string[]; reasonMin?: number } = {},
): ReconcileDecision {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const allowed = new Set(['outcome', 'reason', 'amount', 'evidence', ...(opts.extraKeys ?? [])]);
  for (const k of Object.keys(b)) if (!allowed.has(k)) bad(`campo no permitido: ${k}`);
  if (!(RECONCILE_OUTCOMES as readonly unknown[]).includes(b.outcome)) bad(`outcome debe ser ${RECONCILE_OUTCOMES.join(' | ')}`);
  const outcome = b.outcome as ReconcileOutcome;
  const min = Math.max(1, opts.reasonMin ?? 1);
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < min || reason.length > 500) bad(`reason es obligatorio (${min}–500 caracteres)`);
  if (outcome !== 'charged_partial') {
    if (b.amount !== undefined || b.evidence !== undefined) bad('amount/evidence solo con outcome charged_partial');
    return { outcome, reason };
  }
  const amount = parsePartialAmount(b.amount);
  const evidence = parseReconcileEvidence(b.evidence);
  assertEvidenceMatchesAmount(amount, evidence);
  return { outcome, reason, amount, evidence };
}

/**
 * r60 fix round (M1): el monto contado es EXACTAMENTE el observado en la evidencia (igualdad decimal a 10 decimales).
 * Contar otra cifra (p.ej. 0.10 con evidencia de 0.90) no se acepta: si la evidencia no respalda el monto, se corrige
 * la evidencia (u otra fuente) antes de conciliar. Lanza FinopsError INVALID_INPUT.
 */
export function assertEvidenceMatchesAmount(amount: string, evidence: ReconcileEvidence): void {
  if (cmpDec(normalizeDecimal(amount), normalizeDecimal(evidence.observedAmount)) !== 0) {
    bad(`amount (${normalizeDecimal(amount)}) debe ser igual a evidence.observedAmount (${normalizeDecimal(evidence.observedAmount)})`);
  }
}
