// ─────────────────────────────────────────────────────────────────────────────
// r65 — reintento seguro del DUEÑO (no admin) y recuperación automática adicional de una parte que agotó su tope.
//
// En R1 (#1567) una actividad H5P agotó el tope INTERNO de la parte (`item_recovery_budget_exhausted`, clase D,
// attention_reason `budget`) con la autorización del run en 7,46 de 24,20: solo un SUPER_ADMIN veía «Reintentar (admin)»
// y el dueño leía «hace falta ampliar la autorización», que era falso. Este módulo (puro) decide:
//  - `budgetScopeOf`: si el motivo de presupuesto es de la PARTE ('item') o del RUN ('run'), sin migración (el CHECK de
//    attention_reason no cambia: es un campo derivado del DTO).
//  - `ownerRetryVerdict`: si el dueño puede reintentar la parte él mismo, dentro de lo ya autorizado (servidor = fuente de
//    verdad; RunsService.retryItem lo recalcula bajo lock).
//  - `autoBudgetExtensionOf`: la marca de la ÚNICA ronda automática extra (R4) de una parte que agotó su tope.
// La consulta (reservas abiertas, saldo del run, topes de la política) vive en RunsService / FinopsBudgetService.
// ─────────────────────────────────────────────────────────────────────────────
import { FailureVerdict, classifyFailure, extractFailureCode } from '../reliability/failure-classifier';

/** r65: reintentos del dueño por parte en la ventana. */
export const OWNER_RETRY_MAX = 2;
export const OWNER_RETRY_WINDOW_HOURS = 24;
/** r65: clave de output_summary con los reintentos del dueño ([{at, by}]). */
export const OWNER_RETRIES_KEY = 'ownerRetries';
/** r65 (R4): clave de output_summary de la ronda automática extra ({at, round: 1, previousError}). */
export const AUTO_BUDGET_EXTENSION_KEY = 'autoBudgetExtension';
/** r65 (R4): estrategia registrada en el log de intentos (generation_item_attempts.strategy_applied). */
export const AUTO_BUDGET_EXTENSION_STRATEGY = 'auto_budget_extension';
/** r65 (R4): factor de max_tokens de la ronda extra (las salidas de R1 rondaban el tope de 5000). */
export const AUTO_BUDGET_EXTENSION_MAX_TOKENS_FACTOR = 1.5;

const ITEM_BUDGET_CODE = 'item_recovery_budget_exhausted';
/** r65 (R1): códigos de presupuesto del RUN (ampliar la autorización sí lo resuelve). */
const RUN_BUDGET_CODES: ReadonlySet<string> = new Set(['run_budget_cap', 'budget_exceeded', 'budget_approval_required', 'budget_blocked', 'run_budget_not_authorized']);
/** r65: motivos de pausa del run por su tope (un ítem devuelto a la cola por esa pausa es de alcance 'run'). */
const RUN_CAP_PAUSE_REASONS: ReadonlySet<string> = new Set(['run_budget_cap', 'run_budget_not_authorized']);

/**
 * r65 (R2.1): resultados pagados ambiguos o sin conciliar — NUNCA los reintenta el dueño (podría pagarlos dos veces).
 * Además de estos códigos, cualquier veredicto con `paidRisk: 'uncertain'` o motivo humano `duplicate_charge`.
 */
const OWNER_RETRY_NEVER_CODES: ReadonlySet<string> = new Set([
  'llm_pending_review', 'llm_response_lost', 'provider_reconciliation_required', 'possible_duplicate', 'ambiguous_video_submission',
  'video_upgrade_ambiguous_submission', 'reserved_without_submit_marker', 'confirm_paid_required', 'may_have_rendered_ack_required',
]);
/** r65 (R2.1): códigos D/C que el dueño SÍ puede reintentar (además de las clases A/B del clasificador). */
const OWNER_RETRY_EXTRA_CODES: ReadonlySet<string> = new Set([ITEM_BUDGET_CODE, 'llm_output_cut_repeated']);

export type BudgetScope = 'item' | 'run' | null;

export type OwnerRetryReason =
  | 'not_failed'
  | 'ambiguous_paid_result'
  | 'open_reservations'
  | 'paid_external_unreconciled'
  | 'failure_not_owner_retryable'
  | 'no_item_estimate'
  | 'run_budget_insufficient'
  | 'policy_cap_reached'
  | 'owner_retry_limit';

export interface OwnerRetryView {
  allowed: boolean;
  reason: OwnerRetryReason | null;
  /** Peor caso de la parte en una ventana nueva (itemHardLimit + una llamada), USD con 2 decimales (redondeo hacia arriba). */
  maxCostUsd: string | null;
  retriesLeft: number;
  windowHours: number;
}

/**
 * r65: motivos por los que el SERVIDOR rechaza (409) el reintento del dueño. Quedan fuera, con el comportamiento previo
 * del endpoint:
 *  - `failure_not_owner_retryable`: un fallo fuera de la lista (p. ej. un D sin clasificar) — el dueño no ve el botón
 *    nuevo; los guards de FinOps de cada llamada siguen igual;
 *  - `paid_external_unreconciled`: un video / presentación / audio con trabajo externo ya enviado lo siguen gobernando las
 *    reglas de siempre (re-poll y re-subida a YouTube gratis = dueño; volver a renderizar o pagar = solo admin:
 *    admin_recovery_only, resubmitVideo / resubmitProvider, gate de FinOps). Ver IMPL-REPORT r65.
 */
// r65 fix round 1: `no_item_estimate` tampoco da 409 (las partes A/B sin línea de estimado — runs viejos — conservan su
// reintento de siempre; el dueño no ve el botón nuevo). `paid_external_unreconciled` da 409 solo si el pedido trae
// resubmitVideo / resubmitProvider (eso ya es solo de admin: admin_recovery_only antes de llegar acá).
export const OWNER_RETRY_ENFORCED_REASONS: ReadonlySet<OwnerRetryReason> = new Set<OwnerRetryReason>([
  'ambiguous_paid_result', 'open_reservations', 'run_budget_insufficient', 'policy_cap_reached', 'owner_retry_limit',
]);

function sourceOfType(type: string | null | undefined): 'video_worker' | 'provider_worker' | 'browser_executor' {
  return type === 'video' ? 'video_worker'
    : type === 'presentation' || type === 'audio_welcome' || type === 'audiobook_chapter' ? 'provider_worker' : 'browser_executor';
}

/** r65: veredicto del clasificador para la fila (la clase REGISTRADA gana: solo puede ser más severa). */
export function itemFailureVerdict(r: { error?: string | null; type?: string | null; output_summary?: Record<string, any> | null; failure_class?: string | null; failure_code?: string | null }): FailureVerdict & { recordedClass: string | null } {
  const v = classifyFailure({ error: String(r.error ?? ''), itemType: r.type ?? null, outputSummary: r.output_summary ?? {}, source: sourceOfType(r.type) });
  return { ...v, recordedClass: r.failure_class ? String(r.failure_class) : null };
}

/** r65 (R1): alcance del motivo de presupuesto del ítem. `runPauseReason` = output_summary.pause.reason del run pausado. */
export function budgetScopeOf(r: { status?: string | null; error?: string | null }, runPauseReason?: string | null): BudgetScope {
  const err = String(r.error ?? '').trim();
  if (!err || r.status === 'completed') return null;
  const code = extractFailureCode(err);
  if (code === ITEM_BUDGET_CODE) return 'item';
  if (RUN_BUDGET_CODES.has(code)) return 'run';
  // Ítem devuelto a la cola por la pausa del run por su tope (run_paused: Pausa automática… presupuesto autorizado).
  if (code === 'run_paused' && runPauseReason && RUN_CAP_PAUSE_REASONS.has(runPauseReason)) return 'run';
  return null;
}

/** r65 (R2.1): ¿el código de fallo permite el reintento del dueño? */
export function ownerRetryCodeEligibility(v: FailureVerdict & { recordedClass?: string | null }): 'ok' | 'ambiguous_paid_result' | 'failure_not_owner_retryable' {
  const cls = v.recordedClass && ['A', 'B', 'C', 'D'].includes(v.recordedClass) && v.recordedClass > v.class ? v.recordedClass : v.class;
  if (OWNER_RETRY_NEVER_CODES.has(v.code) || v.paidRisk === 'uncertain' || v.humanReason === 'duplicate_charge') return 'ambiguous_paid_result';
  if (OWNER_RETRY_EXTRA_CODES.has(v.code)) return 'ok';
  if (cls === 'A' || cls === 'B') return 'ok';
  return 'failure_not_owner_retryable';
}

/** r65 (R2.5): reintentos del dueño en la ventana (output_summary.ownerRetries). */
export function ownerRetriesUsed(os: Record<string, any> | null | undefined, now: Date, windowHours = OWNER_RETRY_WINDOW_HOURS): number {
  const list = os && Array.isArray(os[OWNER_RETRIES_KEY]) ? os[OWNER_RETRIES_KEY] : [];
  const from = now.getTime() - windowHours * 3600_000;
  return list.filter((x: any) => {
    const t = x && x.at ? new Date(String(x.at)).getTime() : NaN;
    return Number.isFinite(t) && t > from && t <= now.getTime() + 60_000;
  }).length;
}

/** r65: lista nueva de ownerRetries (las de la ventana + la nueva; acotada a 10 entradas). */
export function nextOwnerRetries(os: Record<string, any> | null | undefined, now: Date, by: string): Array<{ at: string; by: string }> {
  const list = os && Array.isArray(os[OWNER_RETRIES_KEY]) ? os[OWNER_RETRIES_KEY] : [];
  const kept = list.filter((x: any) => x && typeof x.at === 'string').map((x: any) => ({ at: String(x.at), by: String(x.by ?? '') }));
  return [...kept, { at: now.toISOString(), by }].slice(-10);
}

export interface OwnerRetryInput {
  status: string;
  verdict: FailureVerdict & { recordedClass?: string | null };
  /** Reservas abiertas (CHARGE pendiente sin ajuste) de la parte desde itemWindowStart. */
  openReservations: number;
  /** El tipo es de un proveedor pagado (paidProviderOfItemType: video, presentation, audio). */
  paidType: boolean;
  /** Tipo de proveedor pagado con trabajo externo ya enviado o sin conciliar (o duda). */
  paidExternalUnreconciled: boolean;
  /** Peor caso de la parte en una ventana nueva: itemHardLimit + una llamada (null = sin estimado). */
  maxCostUsd: number | null;
  /** Saldo del run: autorizado − gastado (null = sin autorización vigente). */
  runRemainingUsd: number | null;
  /** Lo que queda del primer tope de la política que no alcanza (null = todos caben). */
  policyBlockedBy: string | null;
  ownerRetriesUsed24h: number;
}

/** r65 (R2): veredicto PURO del reintento del dueño. El orden de los motivos va de la seguridad del dinero al límite. */
export function ownerRetryVerdict(i: OwnerRetryInput): OwnerRetryView {
  const retriesLeft = Math.max(0, OWNER_RETRY_MAX - Math.max(0, Math.floor(i.ownerRetriesUsed24h) || 0));
  const max = i.maxCostUsd === null || !Number.isFinite(i.maxCostUsd) ? null : i.maxCostUsd;
  const base = { maxCostUsd: max === null ? null : (Math.ceil(max * 100 - 1e-9) / 100).toFixed(2), retriesLeft, windowHours: OWNER_RETRY_WINDOW_HOURS };
  const no = (reason: OwnerRetryReason): OwnerRetryView => ({ ...base, allowed: false, reason });
  if (i.status !== 'failed') return no('not_failed');
  // r65 fix round 1: el límite de 2 reintentos en 24 h va ANTES de la lista de códigos (vale para todo reintento del
  // dueño que reinicia el tope de la parte, también los de códigos fuera de la lista).
  if (retriesLeft <= 0) return no('owner_retry_limit');
  const code = ownerRetryCodeEligibility(i.verdict);
  // r65 fix round 1: la ambigüedad va ANTES que el trabajo externo pagado (gamma_submit_ambiguous,
  // provider_reconciliation_required, videogen_failed… → ambiguous_paid_result, que el servidor rechaza al dueño).
  if (code === 'ambiguous_paid_result') return no(code);
  // Proveedor pagado con trabajo externo ya enviado o una reserva abierta (p. ej. el render de un video_timeout que se
  // re-pollea gratis) → sin botón del dueño; lo siguen gobernando las reglas de siempre de esos tipos (re-poll /
  // re-subida = dueño; volver a pagar = solo admin).
  if (i.paidType && (i.paidExternalUnreconciled || i.openReservations > 0)) return no('paid_external_unreconciled');
  // IA: una reserva abierta es un resultado desconocido → el dueño no reintenta (podría pagarla dos veces).
  if (i.openReservations > 0) return no('open_reservations');
  if (code !== 'ok') return no(code);
  if (max === null) return no('no_item_estimate');
  if (i.runRemainingUsd === null || i.runRemainingUsd + 1e-9 < max) return no('run_budget_insufficient');
  if (i.policyBlockedBy) return no('policy_cap_reached');
  return { ...base, allowed: true, reason: null };
}

/** r65 (R4): marca de la ronda automática extra (null = la parte todavía no la usó). */
export function autoBudgetExtensionOf(os: Record<string, any> | null | undefined): { at: string; round: number; previousError: string | null } | null {
  const x = os && typeof os === 'object' ? (os as any)[AUTO_BUDGET_EXTENSION_KEY] : null;
  return x && typeof x === 'object' ? x : null;
}

/** r65 (R4): ¿el error de la parte es el tope INTERNO agotado? */
export function isItemBudgetExhausted(error: string | null | undefined): boolean {
  return extractFailureCode(String(error ?? '')) === ITEM_BUDGET_CODE;
}
