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

export type WorkerLedger = Pick<FinopsLedgerService, 'recordCharge' | 'recordAdjustment' | 'recordZero'>;
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
