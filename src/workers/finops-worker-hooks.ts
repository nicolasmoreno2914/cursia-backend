// ─────────────────────────────────────────────────────────────────────────────
// Cursia V2.1 — RF-b: ganchos de los workers hacia el ledger de costos
// (audit §W.2/§W.4, HD-V21-20). Todos idempotentes por el ID externo:
//   videogen:job:<jobId> · youtube:video:<videoId> · package:<jobId> ·
//   gamma:gen:<id> · openai:req:<id>
// La atribución (owner/course/run/item) la deriva el ledger del item run o
// del run — nunca de datos del cliente.
// ─────────────────────────────────────────────────────────────────────────────
import type { FinopsLedgerService, RecordResult, CallRole } from '../modules/finops/finops-ledger.service';
import type { FinopsBudgetService } from '../modules/finops/finops-budget.service';
import { BUDGET_EXCEEDED } from '../modules/finops/run-budget';
import { costIdempotencyKey } from '../modules/finops/idempotency';
import { llmIngestToChargeInput } from '../modules/finops/llm-usage-ingest';
import { usageModelPriorsV1 } from '../modules/finops/usage-model';

export type WorkerLedger = Pick<FinopsLedgerService, 'recordCharge' | 'recordAdjustment' | 'recordZero'> &
  Partial<Pick<FinopsLedgerService, 'settleMeasuredUsage'>>;
export type WorkerBudget = Pick<FinopsBudgetService, 'guardPaidSubmission'>;

/**
 * YouTube Data API `videos.insert` = 1600 unidades de cuota por subida.
 * NO VERIFICADO contra la documentación vigente de cuotas de YouTube Data
 * API v3 (audit §W.2 [I]): configurable con YOUTUBE_QUOTA_VIDEOS_INSERT_UNITS.
 */
export const YOUTUBE_VIDEOS_INSERT_QUOTA_DEFAULT = 1600;
export const YOUTUBE_QUOTA_ENV = 'YOUTUBE_QUOTA_VIDEOS_INSERT_UNITS';

export function youtubeInsertQuotaUnits(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[YOUTUBE_QUOTA_ENV];
  if (raw === undefined || raw === '') return YOUTUBE_VIDEOS_INSERT_QUOTA_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${YOUTUBE_QUOTA_ENV} inválido (${raw}): entero >= 0`);
  return n;
}

/**
 * Un reenvío de un video con job NUEVO (retryItem resubmitVideo archiva el
 * job anterior en output_summary.previousExternals) es un retry pagado:
 * attempt = reenvíos + 1, call_role provider_retry.
 */
export function videogenCallRoleOf(outputSummary: Record<string, any> | null | undefined): { callRole: CallRole; attempt: number } {
  const prev = Array.isArray(outputSummary?.previousExternals) ? outputSummary!.previousExternals.length : 0;
  return prev > 0 ? { callRole: 'provider_retry', attempt: prev + 1 } : { callRole: 'main', attempt: 1 };
}

export interface VideogenChargeInput {
  ownerId: string;
  itemRunId: string;
  jobId: string;
  mode: 'mock' | 'real';
  /** `estimated_total_cost` de getVideoCost (null si la consulta falló). */
  cost: number | null;
  costError?: string | null;
  outputSummary?: Record<string, any> | null;
}

/**
 * Cargo de un render de Videogen (una fila por job):
 * - mock → MOCK, monto 0;
 * - real con costo → CALCULATED_FROM_USAGE con el monto calculado por Videogen (HD-V21-20);
 * - real sin costo → CALCULATED_FROM_USAGE provisional (1 render × pricing_catalog),
 *   measurement_status='pending'; se corrige con settleVideogenPending (ADJUSTMENT).
 */
export async function recordVideogenCharge(ledger: WorkerLedger, a: VideogenChargeInput): Promise<RecordResult> {
  const role = videogenCallRoleOf(a.outputSummary);
  const base = {
    itemRunId: a.itemRunId,
    ownerIdFromAuth: a.ownerId,
    provider: 'videogen',
    service: 'render',
    modelOrProduct: 'video',
    operation: 'videogen.render',
    usage: { video_render: 1 },
    usageUnit: 'video_render',
    externalOperationId: a.jobId,
    idempotency: { kind: 'videogen' as const, parts: { jobId: a.jobId } },
    callRole: role.callRole,
    attempt: role.attempt,
    recordedBy: 'dynamic-item-worker',
  };
  if (a.mode === 'mock') {
    return ledger.recordCharge({ ...base, billingAccount: 'mock', mode: 'mock', costSource: 'MOCK', metadata: { fixture: true } });
  }
  if (typeof a.cost === 'number' && Number.isFinite(a.cost) && a.cost >= 0) {
    return ledger.recordCharge({
      ...base,
      billingAccount: 'cursia',
      mode: 'real',
      costSource: 'CALCULATED_FROM_USAGE',
      providerCalculatedAmount: String(a.cost),
      measurementStatus: 'final',
      metadata: { costBasis: 'videogen.getVideoCost.estimated_total_cost' },
    });
  }
  return ledger.recordCharge({
    ...base,
    billingAccount: 'cursia',
    mode: 'real',
    costSource: 'CALCULATED_FROM_USAGE',
    measurementStatus: 'pending',
    metadata: { costBasis: 'pricing_catalog_provisional', pendingReason: (a.costError || 'cost_lookup_failed').slice(0, 300) },
  });
}

/** Medición llegada para un cargo pendiente de Videogen → ADJUSTMENT (append; delta 0 = no-op). */
export async function settleVideogenPending(ledger: WorkerLedger, jobId: string, cost: number) {
  if (!(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)) throw new Error(`costo de Videogen inválido: ${String(cost)}`);
  return ledger.recordAdjustment(costIdempotencyKey('videogen', { jobId }), String(cost), 'videogen_cost_measured', {
    recordedBy: 'dynamic-item-worker',
    metadata: { costBasis: 'videogen.getVideoCost.estimated_total_cost' },
  });
}

/** Subida a YouTube: ZERO_BY_DESIGN + unidades de cuota (MOCK en runs mock). */
export async function recordYoutubeUpload(
  ledger: WorkerLedger,
  a: { ownerId: string; itemRunId: string; videoId: string; mode: 'mock' | 'real'; quotaUnits?: number },
): Promise<RecordResult> {
  return ledger.recordZero({
    kind: 'youtube',
    externalId: a.videoId,
    ownerIdFromAuth: a.ownerId,
    itemRunId: a.itemRunId,
    quotaUnits: a.quotaUnits ?? youtubeInsertQuotaUnits(),
    mode: a.mode,
    recordedBy: 'dynamic-item-worker',
    metadata: { quotaUnitsVerified: false },
  });
}

/** Build de un paquete: ZERO_BY_DESIGN, idempotente por el id del job de paquete, atribuido al run. */
export async function recordPackageBuild(
  ledger: WorkerLedger,
  a: { ownerId: string; packageJobId: string; runId: string | null },
): Promise<RecordResult> {
  return ledger.recordZero({
    kind: 'package',
    externalId: a.packageJobId,
    ownerIdFromAuth: a.ownerId,
    attributionRunId: a.runId,
    mode: 'real',
    recordedBy: 'package-worker',
  });
}

/** Item de proveedor (presentation / audio_*) en modo mock → evento MOCK a 0. */
export async function recordProviderMock(
  ledger: WorkerLedger,
  a: { ownerId: string; itemRunId: string; itemType: string; externalId: string },
): Promise<RecordResult> {
  const isGamma = a.itemType === 'presentation';
  return ledger.recordCharge({
    itemRunId: a.itemRunId,
    ownerIdFromAuth: a.ownerId,
    provider: isGamma ? 'gamma' : 'openai',
    service: isGamma ? 'generations' : 'audio.speech',
    modelOrProduct: isGamma ? 'gamma-generate' : 'gpt-4o-mini-tts',
    usage: {},
    externalOperationId: a.externalId,
    idempotency: isGamma
      ? { kind: 'gamma', parts: { generationId: a.externalId } }
      : { kind: 'openai_tts', parts: { requestId: a.externalId } },
    billingAccount: 'mock',
    mode: 'mock',
    costSource: 'MOCK',
    recordedBy: 'dynamic-provider-worker',
    metadata: { fixture: true },
  });
}

// ─── V2.1 F2: cargos REALES de Gamma, OpenAI TTS y el LLM server-side ─────────

/** Rol/intento de una llamada de proveedor según el intento del item (reintento del item = provider_retry). */
export function providerCallRoleOf(itemAttempt: number | null | undefined): { callRole: CallRole; attempt: number } {
  const n = Number.isInteger(itemAttempt) && (itemAttempt as number) >= 1 ? (itemAttempt as number) : 1;
  return n > 1 ? { callRole: 'provider_retry', attempt: n } : { callRole: 'main', attempt: 1 };
}

/**
 * Generación de Gamma (una fila por generationId, idempotente):
 * `credits.deducted` × precio por crédito del catálogo → CALCULATED_FROM_USAGE
 * (audit §W.2). Sin créditos informados → CHARGE a 0 `pending` (se concilia con
 * `credits.remaining`); precio faltante → pending_zero (nunca se pierde el cargo).
 */
export async function recordGammaCharge(
  ledger: WorkerLedger,
  a: {
    ownerId: string;
    itemRunId: string;
    generationId: string;
    creditsDeducted: number | null;
    creditsRemaining: number | null;
    failed?: boolean;
    itemAttempt?: number;
  },
): Promise<RecordResult> {
  const role = providerCallRoleOf(a.itemAttempt);
  const measured = typeof a.creditsDeducted === 'number' && Number.isFinite(a.creditsDeducted) && a.creditsDeducted >= 0;
  return ledger.recordCharge({
    itemRunId: a.itemRunId,
    ownerIdFromAuth: a.ownerId,
    provider: 'gamma',
    service: 'generations',
    modelOrProduct: 'gamma-generate',
    operation: 'gamma.generate',
    usage: measured ? { gamma_credit: a.creditsDeducted as number } : {},
    usageUnit: 'gamma_credit',
    externalOperationId: a.generationId,
    idempotency: { kind: 'gamma', parts: { generationId: a.generationId } },
    callRole: role.callRole,
    attempt: role.attempt,
    billingAccount: 'cursia',
    mode: 'real',
    costSource: 'CALCULATED_FROM_USAGE',
    measurementStatus: measured ? 'final' : 'pending',
    pricingFallback: 'pending_zero',
    outcome: a.failed ? (measured && (a.creditsDeducted as number) > 0 ? 'failed_charged' : 'failed_uncharged') : 'succeeded',
    recordedBy: 'dynamic-provider-worker',
    metadata: {
      costBasis: 'gamma.credits.deducted x pricing_catalog',
      creditsRemaining: a.creditsRemaining,
      ...(measured ? {} : { pendingReason: 'gamma_credits_not_reported' }),
    },
  });
}

/**
 * Un chunk de OpenAI TTS: la API devuelve audio sin `usage` → se mide la
 * DURACIÓN del audio devuelto (segundos, del MP3 real) × snapshot de precios
 * (CALCULATED_FROM_USAGE; nunca "real" desde caracteres). Idempotente por
 * `x-request-id`; sin él, fallback determinístico por item/generación/chunk/intento.
 */
export async function recordTtsCharge(
  ledger: WorkerLedger,
  a: {
    ownerId: string;
    itemRunId: string;
    requestId: string | null;
    /** Segundos medidos del MP3 devuelto; null si el audio no se pudo medir → cargo `pending` (nunca se pierde). */
    audioSeconds: number | null;
    characters: number;
    model: string;
    generation: number;
    chunk: number;
    itemAttempt?: number;
  },
): Promise<RecordResult> {
  const measured = typeof a.audioSeconds === 'number' && Number.isFinite(a.audioSeconds) && a.audioSeconds > 0;
  const role = providerCallRoleOf(a.itemAttempt);
  return ledger.recordCharge({
    itemRunId: a.itemRunId,
    ownerIdFromAuth: a.ownerId,
    provider: 'openai',
    service: 'audio.speech',
    modelOrProduct: a.model,
    usage: measured ? { audio_seconds: (Math.round((a.audioSeconds as number) * 1000) / 1000).toFixed(3) } : {},
    usageUnit: 'audio_seconds',
    externalOperationId: a.requestId,
    idempotency: a.requestId
      ? { kind: 'openai_tts', parts: { requestId: a.requestId } }
      : { kind: 'openai_tts', parts: { itemRunId: a.itemRunId, generation: a.generation, chunk: a.chunk, attempt: role.attempt } },
    callRole: role.callRole,
    attempt: role.attempt,
    billingAccount: 'cursia',
    mode: 'real',
    costSource: 'CALCULATED_FROM_USAGE',
    measurementStatus: measured ? 'final' : 'pending',
    pricingFallback: 'pending_zero',
    recordedBy: 'dynamic-provider-worker',
    // `characters` va solo como dato (el monto sale de los segundos medidos).
    metadata: {
      costBasis: 'measured_audio_seconds x pricing_catalog',
      characters: a.characters,
      chunk: a.chunk,
      ...(measured ? {} : { pendingReason: 'tts_audio_not_measurable' }),
    },
  });
}

/**
 * Llamada LLM server-side (guion del audiolibro): usage de la respuesta de
 * Anthropic × snapshot → CALCULATED_FROM_USAGE, idempotente por `msg_…`
 * (misma traducción que el ingest del proxy, HD-V21-17).
 */
export async function recordServerLlmCharge(
  ledger: WorkerLedger,
  a: {
    ownerId: string;
    itemRunId: string;
    model: string;
    messageId: string;
    requestId: string | null;
    usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    callRole: CallRole;
    attempt: number;
  },
): Promise<RecordResult> {
  const input = llmIngestToChargeInput({
    subject: a.ownerId,
    itemRunId: a.itemRunId,
    callRole: a.callRole,
    attempt: a.attempt,
    model: a.model,
    messageId: a.messageId,
    requestId: a.requestId,
    usage: {
      input_tokens: a.usage.input_tokens,
      output_tokens: a.usage.output_tokens,
      cache_creation_input_tokens: a.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: a.usage.cache_read_input_tokens ?? 0,
    },
    billingAccount: 'cursia',
    mode: 'real',
  });
  return ledger.recordCharge({ ...input, recordedBy: 'dynamic-provider-worker', metadata: { ...(input.metadata || {}), serverSide: true } });
}

// ─── V2.1 F2 fix round 1: reservas PENDIENTES (gasto posible no medido todavía) ──
// Regla: toda llamada pagada que PUDO cobrarse deja una fila CHARGE en el ledger
// en el mismo momento en que se sabe (aceptación, o envío ambiguo), con
// `measurement_status='pending'` y un monto ESTIMADO (usage model p90 × catálogo;
// `metadata.estimatedPending=true`). `ESTIMATED` no existe en el ledger (§W.2):
// el costo es CALCULATED_FROM_USAGE provisional y se liquida con un ADJUSTMENT
// cuando llega la medición. Así `runActual` (y el runtime guard) la cuentan
// aunque el item quede en timeout, reintento o bloqueado.

function priorP90(operation: string, meter: string): number {
  const op = usageModelPriorsV1().operations[operation];
  const v = Number(op?.meters?.[meter]?.p90);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`usage model sin p90 para ${operation}.${meter}`);
  return v;
}

/** Créditos estimados de una generación de Gamma para la reserva (p90 del usage model). */
export function gammaEstimatedCredits(): number {
  return priorP90('gamma.generate', 'gamma_credit');
}

/**
 * Reserva PENDIENTE de una generación de Gamma, apenas Gamma la acepta (id =
 * generationId) o cuando el envío fue ambiguo (id sintético por intento).
 * Idempotente por la clave `gamma:gen:<id>`.
 */
export async function recordGammaPending(
  ledger: WorkerLedger,
  a: { ownerId: string; itemRunId: string; generationId: string; itemAttempt?: number; ambiguous?: boolean; reason?: string },
): Promise<RecordResult> {
  const role = providerCallRoleOf(a.itemAttempt);
  const credits = gammaEstimatedCredits();
  return ledger.recordCharge({
    itemRunId: a.itemRunId,
    ownerIdFromAuth: a.ownerId,
    provider: 'gamma',
    service: 'generations',
    modelOrProduct: 'gamma-generate',
    operation: 'gamma.generate',
    usage: { gamma_credit: credits },
    usageUnit: 'gamma_credit',
    externalOperationId: a.ambiguous ? null : a.generationId,
    idempotency: { kind: 'gamma', parts: { generationId: a.generationId } },
    callRole: role.callRole,
    attempt: role.attempt,
    billingAccount: 'cursia',
    mode: 'real',
    costSource: 'CALCULATED_FROM_USAGE',
    measurementStatus: 'pending',
    pricingFallback: 'pending_zero',
    recordedBy: 'dynamic-provider-worker',
    metadata: {
      estimatedPending: true,
      costBasis: 'usage_model_p90 x pricing_catalog (provisional)',
      ...(a.ambiguous ? { ambiguous: true } : {}),
      ...(a.reason ? { pendingReason: a.reason.slice(0, 300) } : {}),
    },
  });
}

/**
 * Terminal de una generación de Gamma: si ya existe la reserva pendiente, se
 * liquida con los créditos medidos (ADJUSTMENT); si no existe (p.ej. generación
 * anterior a este cambio), se registra el CHARGE medido directamente. Sin
 * créditos informados, la reserva queda pendiente (nunca se borra).
 */
export async function settleGammaCharge(
  ledger: WorkerLedger,
  a: { ownerId: string; itemRunId: string; generationId: string; creditsDeducted: number | null; creditsRemaining: number | null; failed?: boolean; itemAttempt?: number },
): Promise<'final_recorded' | 'settled' | 'still_pending' | 'already_final'> {
  const r = await recordGammaCharge(ledger, a);
  if (r.inserted) return 'final_recorded';
  const pending = r.event?.measurement_status === 'pending' && r.event?.metadata?.estimatedPending === true;
  if (!pending) return 'already_final';
  const measured = typeof a.creditsDeducted === 'number' && Number.isFinite(a.creditsDeducted) && a.creditsDeducted >= 0;
  if (!measured) return 'still_pending';
  if (!ledger.settleMeasuredUsage) throw new Error('ledger sin settleMeasuredUsage');
  await ledger.settleMeasuredUsage(costIdempotencyKey('gamma', { generationId: a.generationId }), { gamma_credit: a.creditsDeducted as number }, 'gamma_credits_measured', {
    recordedBy: 'dynamic-provider-worker',
    metadata: { creditsRemaining: a.creditsRemaining, failed: !!a.failed },
  });
  return 'settled';
}

/** ~15 caracteres de texto por segundo de voz (≈150 palabras/min): estimado de la reserva de TTS. */
export const TTS_CHARS_PER_SECOND_ESTIMATE = 15;

/**
 * Reserva PENDIENTE de un chunk de TTS cuyo resultado se desconoce (timeout /
 * red / 5xx DESPUÉS de enviar): la clave es la determinística por item /
 * generación / chunk / intento (sin x-request-id), así que cada intento acotado
 * del item suma su propia reserva.
 */
export async function recordTtsReservation(
  ledger: WorkerLedger,
  a: { ownerId: string; itemRunId: string; characters: number; model: string; generation: number; chunk: number; itemAttempt?: number; reason: string },
): Promise<RecordResult> {
  const role = providerCallRoleOf(a.itemAttempt);
  const secs = Math.max(1, Math.ceil(a.characters / TTS_CHARS_PER_SECOND_ESTIMATE));
  return ledger.recordCharge({
    itemRunId: a.itemRunId,
    ownerIdFromAuth: a.ownerId,
    provider: 'openai',
    service: 'audio.speech',
    modelOrProduct: a.model,
    usage: { audio_seconds: secs },
    usageUnit: 'audio_seconds',
    externalOperationId: null,
    idempotency: { kind: 'openai_tts', parts: { itemRunId: a.itemRunId, generation: a.generation, chunk: a.chunk, attempt: role.attempt } },
    callRole: role.callRole,
    attempt: role.attempt,
    billingAccount: 'cursia',
    mode: 'real',
    costSource: 'CALCULATED_FROM_USAGE',
    measurementStatus: 'pending',
    pricingFallback: 'pending_zero',
    outcome: 'failed_charged',
    recordedBy: 'dynamic-provider-worker',
    metadata: { estimatedPending: true, ambiguous: true, characters: a.characters, chunk: a.chunk, pendingReason: a.reason.slice(0, 300) },
  });
}

/**
 * Reserva PENDIENTE de una llamada LLM server-side sin respuesta medible
 * (timeout / red / 5xx después de enviar, o respuesta sin id/usage): input
 * estimado del prompt (≈3 caracteres/token) y output = max_tokens (cota).
 */
export async function recordLlmReservation(
  ledger: WorkerLedger,
  a: { ownerId: string; itemRunId: string; model: string; promptChars: number; maxTokens: number; role: 'main' | 'continuation'; generation: number; itemAttempt?: number; reason: string },
): Promise<RecordResult> {
  const role = providerCallRoleOf(a.itemAttempt);
  const synthetic = `unmeasured-${a.itemRunId}-g${a.generation}-a${role.attempt}-${a.role}`;
  return ledger.recordCharge({
    itemRunId: a.itemRunId,
    ownerIdFromAuth: a.ownerId,
    provider: 'anthropic',
    service: 'messages',
    modelOrProduct: a.model,
    usage: { input_tokens: Math.max(1, Math.ceil(a.promptChars / 3)), output_tokens: a.maxTokens },
    usageUnit: 'output_tokens',
    externalOperationId: null,
    idempotency: { kind: 'anthropic', parts: { messageId: synthetic } },
    callRole: a.role === 'continuation' ? 'continuation' : 'main',
    attempt: role.attempt,
    billingAccount: 'cursia',
    mode: 'real',
    costSource: 'CALCULATED_FROM_USAGE',
    measurementStatus: 'pending',
    pricingFallback: 'pending_zero',
    outcome: 'failed_charged',
    recordedBy: 'dynamic-provider-worker',
    metadata: { estimatedPending: true, ambiguous: true, serverSide: true, pendingReason: a.reason.slice(0, 300) },
  });
}

/** Mensaje del item bloqueado por presupuesto (prefijo estable `budget_exceeded:`). */
export function budgetExceededMessage(r: { reason: string; committed: string; authorizedBudget: string | null }): string {
  return (
    `${BUDGET_EXCEEDED}: ${r.reason} (comprometido ${r.committed} USD, autorizado ${r.authorizedBudget ?? 'ninguno'}). ` +
    'No se envió nada al proveedor (sin gasto). Un administrador puede ampliar la autorización del run ' +
    '(POST /api/v1/finops/courses/:courseId/authorizations) y reintentar esta parte.'
  );
}

/** Mensaje estable del item bloqueado por falta del guard de presupuesto (prefijo `finops_unavailable:`). */
export const FINOPS_GUARD_MISSING_ITEM_ERROR =
  'finops_unavailable: el control de presupuesto (runtime guard) no está configurado en este worker, así que no se envió ' +
  'nada al proveedor pagado (sin gasto). Corregí la configuración del worker y reintentá esta parte.';

/**
 * RF-b fix round 2 (M3): bloquea (visible, reanudable con retry) un item de gasto
 * real cuando falta el guard. Con un scheduler sin blockItemForBudget (fakes) →
 * failItem no reintentable. Nunca envía nada.
 */
export async function blockWithoutGuard(
  scheduler: { blockItemForBudget?: (id: string, e: string, d: string) => Promise<boolean>; failItem: (id: string, e: string, m: string, r: boolean) => Promise<boolean> },
  itemRunId: string,
  executorId: string,
  provider: string,
): Promise<void> {
  const msg = `${FINOPS_GUARD_MISSING_ITEM_ERROR} (proveedor: ${provider})`;
  if (typeof scheduler.blockItemForBudget === 'function') {
    await scheduler.blockItemForBudget(itemRunId, executorId, `budget_exceeded: ${msg}`);
  } else {
    await scheduler.failItem(itemRunId, executorId, msg, false);
  }
}
