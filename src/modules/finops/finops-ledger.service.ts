import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinopsError } from './errors';
import { addDec, cmpDec, isZeroDec, normalizeDecimal, subDec, DecimalLike } from './decimal';
import { priceUsage, PricingCatalogRow, PricingSnapshot, UsageMeters } from './pricing';
import { adjustmentIdempotencyKey, costIdempotencyKey, CostIdempotencyKind, CostIdempotencyParts } from './idempotency';
import { familyOfProvider, operationForItem } from './operations';
import type { EstimateResult } from './estimator';

/**
 * V2.1 RF-a — ledger de costos (audit §W.3/§W.4). Todas las escrituras son
 * INSERT (append-only; la base rechaza UPDATE/DELETE por trigger).
 *
 * Regla de atribución: el caller pasa SOLO hechos server-side (itemRunId +
 * owner autenticado + hechos del proveedor). course/blueprint/manifest/run/
 * item_key/item_type/módulo/capítulo/generación se DERIVAN de
 * generation_item_runs + production_jobs. Si el item run no es del owner
 * autenticado (o no existe), el cargo se registra NO atribuido; la metadata
 * del cliente nunca pisa la atribución.
 *
 * Solo depende de `DataSource.query` / `DataSource.transaction`, así que los
 * checks lo instancian directo contra un Postgres desechable.
 */

export type CallRole = 'main' | 'validation_retry' | 'continuation' | 'context_summary_retry' | 'fallback_template' | 'provider_retry';
export const CALL_ROLES: readonly CallRole[] = ['main', 'validation_retry', 'continuation', 'context_summary_retry', 'fallback_template', 'provider_retry'];
export type BillingAccount = 'cursia' | 'user_key' | 'mock';
export type LedgerCostSource = 'ACTUAL_PROVIDER' | 'CALCULATED_FROM_USAGE' | 'ZERO_BY_DESIGN' | 'MOCK';
export type ChargeMode = 'real' | 'mock';
export type ChargeOutcome = 'succeeded' | 'failed_charged' | 'failed_uncharged';

export interface RecordChargeInput {
  /** Item run declarado (nullable). Se verifica contra ownerIdFromAuth. */
  itemRunId?: string | null;
  /** Owner autenticado (sub del JWT verificado por el proxy, o owner del job en un worker). */
  ownerIdFromAuth: string;
  provider: string;
  service: string;
  modelOrProduct: string;
  /** Operación base (p.ej. 'llm.content'). Si falta, se deriva del item type atribuido. */
  operation?: string | null;
  usage: UsageMeters;
  externalOperationId?: string | null;
  /** Clave ya armada con costIdempotencyKey, o {kind, parts} para armarla acá. */
  idempotencyKey?: string | null;
  idempotency?: { kind: CostIdempotencyKind; parts: CostIdempotencyParts } | null;
  callRole?: CallRole;
  attempt?: number;
  billingAccount: BillingAccount;
  mode: ChargeMode;
  /** Default CALCULATED_FROM_USAGE (MOCK si mode='mock'). */
  costSource?: LedgerCostSource | null;
  /** Obligatorio si costSource='ACTUAL_PROVIDER'. */
  actualAmount?: DecimalLike | null;
  /**
   * V2.1 RF-b: monto CALCULADO POR EL PROVEEDOR desde su propio uso (p.ej.
   * Videogen `estimated_total_cost`, HD-V21-20). Solo con
   * costSource='CALCULATED_FROM_USAGE' y solo desde workers server-side (el
   * ingest HTTP nunca lo setea). Sin él, el monto sale de usage × pricing_catalog.
   */
  providerCalculatedAmount?: DecimalLike | null;
  /**
   * V2.1 RF-b: atribución a un RUN (no a un item) para cargos de workers sin
   * item run (p.ej. package.build). Se verifica contra production_jobs (mismo
   * owner); nunca viene del cliente.
   */
  attributionRunId?: string | null;
  /**
   * RF-b fix C1/I2: si el precio falta (o es ambiguo), 'pending_zero' registra
   * IGUAL el CHARGE con monto 0, measurement_status='pending' y
   * metadata.pricingMissing=true (log fuerte); un ADJUSTMENT lo precia después
   * (repricePendingCharge). Sin él, el error de precio se propaga (fail loud).
   */
  pricingFallback?: 'pending_zero' | null;
  currency?: string | null;
  measurementStatus?: 'final' | 'pending';
  outcome?: ChargeOutcome;
  quotaUnits?: DecimalLike | null;
  /** Medidor principal para reportes simples (default: primer medidor con cantidad). */
  usageUnit?: string | null;
  recordedBy: string;
  metadata?: Record<string, unknown> | null;
  /** Catálogo explícito (tests / precargado). Si falta, se lee pricing_catalog. */
  pricingCatalog?: readonly PricingCatalogRow[] | null;
  /** Instante de precios. Default: ahora (fila vigente al momento del registro). */
  pricingAsOf?: string | Date | null;
}

export interface CostEventRow {
  id: string;
  created_at: string;
  event_kind: 'CHARGE' | 'ADJUSTMENT' | 'REFUND';
  corrects_event_id: string | null;
  owner_id: string | null;
  course_id: number | null;
  run_id: string | null;
  item_run_id: string | null;
  item_key: string | null;
  item_type: string | null;
  operation: string;
  provider: string;
  idempotency_key: string;
  amount: string;
  currency: string;
  cost_source: string;
  billable: boolean;
  metadata: Record<string, any>;
  pricing_snapshot: PricingSnapshot | null;
  [k: string]: any;
}

export interface RecordResult {
  inserted: boolean;
  event: CostEventRow;
  /** RF-b fix C1: el precio faltaba → CHARGE a 0 pendiente (se re-precia con repricePendingCharge). */
  pricingMissing?: boolean;
}

/** Errores de precio que NUNCA deben perder un cargo real (fallback 'pending_zero'). */
const PRICING_FALLBACK_CODES = new Set(['PRICING_MISSING', 'PRICING_AMBIGUOUS', 'CURRENCY_MISMATCH']);

/** Costos que una medición del proveedor puede liquidar (MOCK / ZERO_BY_DESIGN nunca quedan pendientes). */
const SETTLEABLE_COST_SOURCES = new Set(['CALCULATED_FROM_USAGE', 'ACTUAL_PROVIDER']);

/**
 * Medición completa = al menos un medidor, y todos finitos y ≥ 0. Una medición
 * incompleta NUNCA liquida un pendiente: falla ruidoso y el cargo sigue pending.
 */
function assertCompleteMeasurement(originalKey: string, measured: UsageMeters | null | undefined): void {
  const entries = Object.entries(measured || {}).filter(([, v]) => v !== null && v !== undefined);
  const bad = entries.filter(([, v]) => {
    // Solo números o strings decimales: Number('') === 0 no puede pasar por "medido" (review M1).
    if (typeof v === 'string' && !/^\s*\d+(\.\d+)?\s*$/.test(v)) return true;
    if (typeof v !== 'string' && typeof v !== 'number') return true;
    const n = Number(v);
    return !Number.isFinite(n) || n < 0;
  });
  if (!entries.length || bad.length) {
    throw new FinopsError('MEASUREMENT_INCOMPLETE', `medición incompleta para ${originalKey}: ${JSON.stringify(measured ?? null)}`);
  }
}

interface Attribution {
  attributed: boolean;
  rejectReason: string | null;
  owner_id: string;
  course_id: number | null;
  blueprint_id: number | null;
  manifest_id: number | null;
  run_id: string | null;
  item_run_id: string | null;
  item_key: string | null;
  item_type: string | null;
  item_generation: number | null;
  scope: string | null;
  module_id: string | null;
  chapter_id: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EVENT_COLUMNS = [
  'event_kind', 'corrects_event_id', 'owner_id', 'institution_id', 'course_id', 'blueprint_id', 'manifest_id', 'run_id',
  'item_run_id', 'item_key', 'item_type', 'item_generation', 'scope', 'module_id', 'chapter_id', 'operation', 'call_role',
  'attempt', 'provider', 'service', 'model_or_product', 'external_operation_id', 'idempotency_key', 'usage',
  'usage_quantity', 'usage_unit', 'pricing_snapshot', 'amount', 'currency', 'cost_source', 'measurement_status',
  'billing_account', 'billable', 'outcome', 'quota_units', 'recorded_by', 'metadata',
] as const;

const JSON_COLUMNS = new Set(['usage', 'pricing_snapshot', 'metadata']);

function nonEmpty(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new FinopsError('INVALID_INPUT', `${what} es obligatorio`);
  return v;
}

function num(v: DecimalLike | null | undefined): string | null {
  return v === null || v === undefined ? null : normalizeDecimal(v);
}

@Injectable()
export class FinopsLedgerService {
  private readonly logger = new Logger('FinopsLedger');

  constructor(private readonly dataSource: DataSource) {}

  // ─── atribución ────────────────────────────────────────────────────────────

  /** Deriva la atribución desde generation_item_runs + production_jobs. Nunca desde el cliente. */
  async resolveAttribution(itemRunId: string | null | undefined, ownerIdFromAuth: string): Promise<Attribution> {
    const unattributed = (reason: string | null): Attribution => ({
      attributed: false,
      rejectReason: reason,
      owner_id: ownerIdFromAuth,
      course_id: null,
      blueprint_id: null,
      manifest_id: null,
      run_id: null,
      item_run_id: null,
      item_key: null,
      item_type: null,
      item_generation: null,
      scope: null,
      module_id: null,
      chapter_id: null,
    });
    if (itemRunId === null || itemRunId === undefined || itemRunId === '') return unattributed(null);
    if (typeof itemRunId !== 'string' || !UUID_RE.test(itemRunId)) return unattributed('invalid_item_run_id');
    const rows = await this.dataSource.query(
      `select gir.id, gir.job_id, gir.course_id, gir.blueprint_id, gir.manifest_id, gir.item_key,
              gir.generation, gir.type, gir.scope, gir.module_id, gir.chapter_id, pj.owner_id
         from public.generation_item_runs gir
         join public.production_jobs pj on pj.id = gir.job_id
        where gir.id = $1`,
      [itemRunId],
    );
    const r = rows[0];
    if (!r) return unattributed('item_run_not_found');
    if (String(r.owner_id) !== ownerIdFromAuth) return unattributed('owner_mismatch');
    return {
      attributed: true,
      rejectReason: null,
      owner_id: ownerIdFromAuth,
      course_id: r.course_id === null ? null : Number(r.course_id),
      blueprint_id: r.blueprint_id === null ? null : Number(r.blueprint_id),
      manifest_id: r.manifest_id === null ? null : Number(r.manifest_id),
      run_id: r.job_id,
      item_run_id: r.id,
      item_key: r.item_key,
      item_type: r.type,
      item_generation: r.generation === null ? null : Number(r.generation),
      scope: r.scope ?? null,
      module_id: r.module_id ?? null,
      chapter_id: r.chapter_id ?? null,
    };
  }

  /**
   * V2.1 RF-b: atribución a nivel RUN (cargos de workers sin item run, p.ej.
   * package.build). Deriva course_id de production_jobs y exige el mismo owner.
   */
  async resolveRunAttribution(runId: string, ownerIdFromAuth: string): Promise<Attribution> {
    const base: Attribution = {
      attributed: false,
      rejectReason: null,
      owner_id: ownerIdFromAuth,
      course_id: null,
      blueprint_id: null,
      manifest_id: null,
      run_id: null,
      item_run_id: null,
      item_key: null,
      item_type: null,
      item_generation: null,
      scope: null,
      module_id: null,
      chapter_id: null,
    };
    if (typeof runId !== 'string' || !UUID_RE.test(runId)) return { ...base, rejectReason: 'invalid_run_id' };
    const [r] = await this.dataSource.query(
      `select id, owner_id, course_id, input_payload->>'manifestId' as manifest_id, blueprint_version_id
         from public.production_jobs where id = $1`,
      [runId],
    );
    if (!r) return { ...base, rejectReason: 'run_not_found' };
    if (String(r.owner_id) !== ownerIdFromAuth) return { ...base, rejectReason: 'owner_mismatch' };
    const manifestId = Number(r.manifest_id);
    return {
      ...base,
      attributed: true,
      course_id: r.course_id === null ? null : Number(r.course_id),
      manifest_id: Number.isInteger(manifestId) ? manifestId : null,
      run_id: r.id,
      scope: 'run',
    };
  }

  // ─── cargos ────────────────────────────────────────────────────────────────

  async recordCharge(input: RecordChargeInput): Promise<RecordResult> {
    if (!input) throw new FinopsError('INVALID_INPUT', 'recordCharge sin input');
    const owner = nonEmpty(input.ownerIdFromAuth, 'ownerIdFromAuth');
    nonEmpty(input.provider, 'provider');
    nonEmpty(input.service, 'service');
    nonEmpty(input.modelOrProduct, 'modelOrProduct');
    nonEmpty(input.recordedBy, 'recordedBy');
    if (input.mode !== 'real' && input.mode !== 'mock') throw new FinopsError('INVALID_INPUT', `mode inválido: ${String(input.mode)}`);
    if (!['cursia', 'user_key', 'mock'].includes(input.billingAccount)) {
      throw new FinopsError('INVALID_INPUT', `billingAccount inválido: ${String(input.billingAccount)}`);
    }
    if (input.mode === 'mock' && input.billingAccount !== 'mock') {
      throw new FinopsError('INVALID_INPUT', 'mode=mock exige billingAccount=mock');
    }
    if (input.mode === 'real' && input.billingAccount === 'mock') {
      throw new FinopsError('INVALID_INPUT', 'billingAccount=mock solo con mode=mock');
    }
    const callRole: CallRole = input.callRole ?? 'main';
    if (!CALL_ROLES.includes(callRole)) throw new FinopsError('INVALID_INPUT', `callRole inválido: ${String(callRole)}`);
    const attempt = input.attempt ?? 1;
    if (!Number.isInteger(attempt) || attempt < 1) throw new FinopsError('INVALID_INPUT', `attempt inválido: ${String(attempt)}`);

    const idempotencyKey = input.idempotencyKey
      ? nonEmpty(input.idempotencyKey, 'idempotencyKey')
      : input.idempotency
        ? costIdempotencyKey(input.idempotency.kind, input.idempotency.parts)
        : null;
    if (!idempotencyKey) throw new FinopsError('INVALID_INPUT', 'idempotencyKey (o idempotency {kind, parts}) es obligatorio');

    let costSource: LedgerCostSource = input.costSource ?? 'CALCULATED_FROM_USAGE';
    if (input.mode === 'mock') costSource = 'MOCK';
    if (!['ACTUAL_PROVIDER', 'CALCULATED_FROM_USAGE', 'ZERO_BY_DESIGN', 'MOCK'].includes(costSource)) {
      throw new FinopsError('INVALID_INPUT', `costSource inválido en el ledger: ${String(costSource)} (ESTIMATED solo vive en cost_estimates)`);
    }

    const attribution =
      (input.itemRunId === null || input.itemRunId === undefined || input.itemRunId === '') && input.attributionRunId
        ? await this.resolveRunAttribution(input.attributionRunId, owner)
        : await this.resolveAttribution(input.itemRunId ?? null, owner);

    // Operación: derivada del item atribuido; si no hay atribución, `<base>.unattributed`.
    const family = familyOfProvider(input.provider);
    let operation: string;
    if (attribution.attributed && !attribution.item_run_id) {
      // RF-b: atribución de run (worker server-side) — la operación la declara el worker.
      operation = input.operation || `${family}.unattributed`;
    } else if (attribution.attributed) {
      operation = input.operation || operationForItem(attribution.item_type as string, input.provider) || `${family}.unattributed`;
    } else {
      operation = `${input.operation || family}.unattributed`;
    }

    // Monto
    let amount: string;
    let pricingError: { code: string; message: string } | null = null;
    let currency = (input.currency || 'USD').toUpperCase();
    let pricingSnapshot: PricingSnapshot | null = null;
    if (costSource === 'ZERO_BY_DESIGN' || costSource === 'MOCK') {
      // RF-b: MOCK nunca cuesta (audit §W.2: "Mock / fake → 0").
      amount = normalizeDecimal(0);
    } else if (input.providerCalculatedAmount !== null && input.providerCalculatedAmount !== undefined) {
      if (costSource !== 'CALCULATED_FROM_USAGE') {
        throw new FinopsError('INVALID_INPUT', 'providerCalculatedAmount solo con costSource=CALCULATED_FROM_USAGE');
      }
      amount = normalizeDecimal(input.providerCalculatedAmount, 'providerCalculatedAmount');
    } else if (costSource === 'ACTUAL_PROVIDER') {
      if (input.actualAmount === null || input.actualAmount === undefined) {
        throw new FinopsError('INVALID_INPUT', 'ACTUAL_PROVIDER exige actualAmount');
      }
      amount = normalizeDecimal(input.actualAmount, 'actualAmount');
    } else {
      const catalog = input.pricingCatalog ?? (await this.loadCatalog(input.provider, input.service, input.modelOrProduct));
      try {
        const priced = priceUsage(input.usage || {}, catalog, {
          provider: input.provider,
          service: input.service,
          product: input.modelOrProduct,
          // Default: ahora (una fila con effective_from futuro nunca se aplica antes de tiempo).
          asOf: input.pricingAsOf ?? new Date(),
        });
        amount = priced.amount;
        currency = priced.currency;
        pricingSnapshot = priced.pricingSnapshot;
      } catch (err) {
        if (!(input.pricingFallback === 'pending_zero' && err instanceof FinopsError && PRICING_FALLBACK_CODES.has(err.code))) throw err;
        pricingError = { code: err.code, message: err.message };
        amount = normalizeDecimal(0);
        pricingSnapshot = null;
      }
    }
    if (cmpDec(amount, 0) < 0) throw new FinopsError('INVALID_INPUT', `un CHARGE no puede ser negativo (${amount})`);

    const usage = input.usage || {};
    const usageUnit = input.usageUnit ?? Object.keys(usage).sort().find((k) => usage[k] !== null && usage[k] !== undefined && !isZeroDec(usage[k] as DecimalLike)) ?? null;
    const usageQuantity = usageUnit && usage[usageUnit] !== undefined && usage[usageUnit] !== null ? num(usage[usageUnit] as DecimalLike) : null;

    // Metadata: la del cliente se conserva, pero las claves server-side mandan.
    const metadata: Record<string, unknown> = { ...(input.metadata || {}) };
    delete metadata.attributionRejected;
    delete metadata.attributionRejectReason;
    delete metadata.requestedItemRunId;
    delete metadata.amountBasis;
    delete metadata.pricingMissing;
    delete metadata.pricingError;
    if (pricingError) {
      metadata.pricingMissing = true;
      metadata.pricingError = pricingError;
    }
    if (!attribution.attributed && attribution.rejectReason) {
      metadata.attributionRejected = true;
      metadata.attributionRejectReason = attribution.rejectReason;
      metadata.requestedItemRunId = typeof input.itemRunId === 'string' ? input.itemRunId.slice(0, 64) : null;
    }
    if (costSource === 'CALCULATED_FROM_USAGE' && input.providerCalculatedAmount !== null && input.providerCalculatedAmount !== undefined) {
      metadata.amountBasis = 'provider_calculated';
    }

    const billable = input.billingAccount === 'cursia' && costSource !== 'MOCK';

    const row: Record<string, unknown> = {
      event_kind: 'CHARGE',
      corrects_event_id: null,
      owner_id: attribution.owner_id,
      institution_id: null,
      course_id: attribution.course_id,
      blueprint_id: attribution.blueprint_id,
      manifest_id: attribution.manifest_id,
      run_id: attribution.run_id,
      item_run_id: attribution.item_run_id,
      item_key: attribution.item_key,
      item_type: attribution.item_type,
      item_generation: attribution.item_generation,
      scope: attribution.scope,
      module_id: attribution.module_id,
      chapter_id: attribution.chapter_id,
      operation,
      call_role: callRole,
      attempt,
      provider: input.provider,
      service: input.service,
      model_or_product: input.modelOrProduct,
      external_operation_id: input.externalOperationId ?? null,
      idempotency_key: idempotencyKey,
      usage,
      usage_quantity: usageQuantity,
      usage_unit: usageUnit,
      pricing_snapshot: pricingSnapshot,
      amount,
      currency,
      cost_source: costSource,
      measurement_status: pricingError ? 'pending' : input.measurementStatus ?? 'final',
      billing_account: input.billingAccount,
      billable,
      outcome: input.outcome ?? 'succeeded',
      quota_units: num(input.quotaUnits ?? null),
      recorded_by: input.recordedBy,
      metadata,
    };
    const res = await this.insertEvent(row, this.dataSource);
    if (pricingError) {
      this.logger.error(
        `PRICING_MISSING: CHARGE ${idempotencyKey} (${input.provider}/${input.service}/${input.modelOrProduct}) registrado a 0 ` +
          `y PENDIENTE (${pricingError.code}: ${pricingError.message}). Cargar el precio en pricing_catalog y re-preciar ` +
          '(FinopsLedgerService.repricePendingCharge) — el costo real NO está en los totales hasta entonces.',
      );
      return { ...res, pricingMissing: true };
    }
    return res;
  }

  /**
   * RF-b fix C1: re-precia un CHARGE registrado sin precio (metadata.pricingMissing)
   * con el catálogo vigente AL MOMENTO DEL CARGO → ADJUSTMENT por la diferencia
   * (append; repetir es no-op). Lanza PRICING_MISSING si el precio sigue sin existir.
   */
  async repricePendingCharge(idempotencyKey: string) {
    nonEmpty(idempotencyKey, 'idempotencyKey');
    const [orig] = await this.dataSource.query(
      `select *, amount::text as amount from public.generation_cost_events where idempotency_key = $1`,
      [idempotencyKey],
    );
    if (!orig) throw new FinopsError('ORIGINAL_NOT_FOUND', `no existe el evento ${idempotencyKey}`);
    if (orig.event_kind !== 'CHARGE' || !orig.metadata?.pricingMissing) {
      throw new FinopsError('INVALID_INPUT', `${idempotencyKey} no es un CHARGE pendiente de precio`);
    }
    // Aceptación staging (review C1): re-preciar liquida el pendiente, así que solo
    // vale para un uso MEDIDO y completo. Una reserva estimada se liquida con la
    // medición real (settleMeasuredUsage), nunca re-preciando el estimado.
    if (orig.metadata?.estimatedPending) {
      throw new FinopsError('INVALID_INPUT', `${idempotencyKey} es una reserva estimada: se liquida con la medición (settleMeasuredUsage), no re-preciando`);
    }
    assertCompleteMeasurement(idempotencyKey, orig.usage);
    const catalog = await this.loadCatalog(orig.provider, orig.service, orig.model_or_product);
    const priced = priceUsage(orig.usage || {}, catalog, {
      provider: orig.provider,
      service: orig.service,
      product: orig.model_or_product,
      asOf: orig.created_at,
    });
    return this.recordAdjustment(idempotencyKey, priced.amount, 'repriced_after_pricing_missing', {
      recordedBy: 'reconciler',
      metadata: { pricingSnapshot: priced.pricingSnapshot },
      settlement: true,
    });
  }

  /**
   * V2.1 F2 fix round 1: un CHARGE provisional (`pending`, monto estimado del
   * usage model) se liquida cuando llega la medición real del proveedor: se
   * precia `measuredUsage` con el catálogo vigente AL MOMENTO DEL CARGO y se
   * agrega un ADJUSTMENT por la diferencia (append; repetir = no-op).
   */
  async settleMeasuredUsage(
    originalKey: string,
    measuredUsage: UsageMeters,
    reason: string,
    opts: { recordedBy?: string; metadata?: Record<string, unknown> } = {},
  ) {
    nonEmpty(originalKey, 'originalKey');
    const [orig] = await this.dataSource.query(
      `select *, amount::text as amount from public.generation_cost_events where idempotency_key = $1`,
      [originalKey],
    );
    if (!orig) throw new FinopsError('ORIGINAL_NOT_FOUND', `no existe el evento ${originalKey}`);
    if (orig.event_kind !== 'CHARGE') throw new FinopsError('INVALID_INPUT', `${originalKey} no es un CHARGE`);
    assertCompleteMeasurement(originalKey, measuredUsage);
    const catalog = await this.loadCatalog(orig.provider, orig.service, orig.model_or_product);
    const priced = priceUsage(measuredUsage || {}, catalog, {
      provider: orig.provider,
      service: orig.service,
      product: orig.model_or_product,
      asOf: orig.created_at,
    });
    return this.recordAdjustment(originalKey, priced.amount, reason, {
      recordedBy: opts.recordedBy,
      metadata: { ...(opts.metadata || {}), measuredUsage, pricingSnapshot: priced.pricingSnapshot },
      settlement: true,
    });
  }

  /** Cargo de costo cero por diseño (YouTube: cuota; packaging/render local). */
  async recordZero(input: {
    kind: 'youtube' | 'package';
    externalId: string;
    ownerIdFromAuth: string;
    itemRunId?: string | null;
    /** RF-b: atribución a nivel run (package.build), verificada contra production_jobs. */
    attributionRunId?: string | null;
    quotaUnits?: DecimalLike | null;
    mode?: ChargeMode;
    recordedBy: string;
    outcome?: ChargeOutcome;
    metadata?: Record<string, unknown> | null;
  }): Promise<RecordResult> {
    const isYoutube = input.kind === 'youtube';
    if (!isYoutube && input.kind !== 'package') throw new FinopsError('INVALID_INPUT', `recordZero kind inválido: ${String(input.kind)}`);
    const mode = input.mode ?? 'real';
    return this.recordCharge({
      itemRunId: input.itemRunId ?? null,
      attributionRunId: input.attributionRunId ?? null,
      ownerIdFromAuth: input.ownerIdFromAuth,
      provider: isYoutube ? 'youtube' : 'cursia',
      service: isYoutube ? 'data_api_v3' : 'packaging',
      modelOrProduct: isYoutube ? 'videos.insert' : 'mbz',
      operation: isYoutube ? 'youtube.upload' : 'package.build',
      usage: isYoutube && input.quotaUnits !== null && input.quotaUnits !== undefined ? { quota_unit: input.quotaUnits } : {},
      externalOperationId: input.externalId,
      idempotency: isYoutube ? { kind: 'youtube', parts: { videoId: input.externalId } } : { kind: 'package', parts: { jobId: input.externalId } },
      billingAccount: mode === 'mock' ? 'mock' : 'cursia',
      mode,
      costSource: 'ZERO_BY_DESIGN',
      quotaUnits: input.quotaUnits ?? null,
      recordedBy: input.recordedBy,
      outcome: input.outcome,
      metadata: input.metadata ?? null,
    });
  }

  /**
   * Ajuste de un CHARGE: agrega una fila ADJUSTMENT con el delta entre el
   * nuevo total y el total actual (original + ajustes previos). Nunca edita.
   * Serializado por clave original (advisory lock) para que dos ajustes
   * concurrentes no calculen el delta contra el mismo total.
   * Delta 0 ⇒ no inserta ({inserted:false, event:null}), SALVO una liquidación.
   *
   * Liquidación (`opts.settlement`, aceptación staging V2.1): llegó una
   * medición COMPLETA del proveedor para el CHARGE. Si el CHARGE está
   * `pending` y todavía no tiene ningún ADJUSTMENT, se inserta SIEMPRE un
   * ADJUSTMENT `final` — con delta 0 si la medición coincide con el monto
   * provisional (`metadata.settlement='measured_equals_provisional'`). Lo que
   * resuelve el pendiente es el evento de liquidación, nunca "delta != 0".
   * Solo aplica a costos medibles (CALCULATED_FROM_USAGE / ACTUAL_PROVIDER).
   */
  async recordAdjustment(
    originalKey: string,
    newAmount: DecimalLike,
    reason: string,
    opts: { recordedBy?: string; metadata?: Record<string, unknown>; settlement?: boolean } = {},
  ): Promise<{ inserted: boolean; event: CostEventRow | null; delta: string; previousTotal: string; newTotal: string }> {
    nonEmpty(originalKey, 'originalKey');
    nonEmpty(reason, 'reason');
    const newTotal = normalizeDecimal(newAmount, 'newAmount');
    if (cmpDec(newTotal, 0) < 0) throw new FinopsError('INVALID_INPUT', 'el nuevo total no puede ser negativo (usar REFUND)');
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`select pg_advisory_xact_lock(hashtext($1))`, ['finops:adj:' + originalKey]);
      const [orig] = await manager.query(`select * from public.generation_cost_events where idempotency_key = $1`, [originalKey]);
      if (!orig) throw new FinopsError('ORIGINAL_NOT_FOUND', `no existe el evento ${originalKey}`);
      if (orig.event_kind !== 'CHARGE') throw new FinopsError('INVALID_INPUT', `solo se ajusta un CHARGE (${originalKey} es ${orig.event_kind})`);
      const [agg] = await manager.query(
        `select coalesce(sum(amount), 0)::text as total, count(*)::int as n
           from public.generation_cost_events where corrects_event_id = $1 and event_kind = 'ADJUSTMENT'`,
        [orig.id],
      );
      const previousTotal = addDec(orig.amount, agg.total);
      const delta = subDec(newTotal, previousTotal);
      if (opts.settlement && !SETTLEABLE_COST_SOURCES.has(orig.cost_source)) {
        throw new FinopsError('INVALID_INPUT', `${originalKey} (${orig.cost_source}) no es un costo medible: no se liquida`);
      }
      const settlesPending = !!opts.settlement && orig.measurement_status === 'pending' && Number(agg.n) === 0;
      if (isZeroDec(delta) && !settlesPending) return { inserted: false, event: null, delta, previousTotal, newTotal };
      const settlementMeta = opts.settlement ? { settlement: isZeroDec(delta) ? 'measured_equals_provisional' : 'measured_differs' } : {};
      const row: Record<string, unknown> = {};
      for (const c of EVENT_COLUMNS) row[c] = orig[c];
      Object.assign(row, {
        event_kind: 'ADJUSTMENT',
        corrects_event_id: orig.id,
        idempotency_key: adjustmentIdempotencyKey(originalKey, Number(agg.n) + 1, newTotal),
        amount: delta,
        measurement_status: 'final',
        recorded_by: opts.recordedBy || 'reconciler',
        usage: orig.usage ?? {},
        metadata: { ...(opts.metadata || {}), ...settlementMeta, reason, previousTotal, newTotal, adjusts: originalKey },
      });
      const r = await this.insertEvent(row, manager);
      return { inserted: r.inserted, event: r.event, delta, previousTotal, newTotal };
    });
  }

  // ─── evitado / estimaciones / autorizaciones ──────────────────────────────

  async recordAvoidance(input: {
    runId: string;
    courseId?: number | null;
    manifestId?: number | null;
    itemKey: string;
    action: 'REUSE' | 'REVIEW' | 'STALE_NO_AUTO' | 'SOFT_DISABLE_reenabled';
    sourceItemRunId?: string | null;
    basis: 'historical_actual' | 'current_estimate';
    avoidedAmount: DecimalLike;
    currency?: string;
    sourceChargeEventIds?: string[];
    pricingSnapshot?: unknown;
  }): Promise<{ inserted: boolean; event: any }> {
    nonEmpty(input.runId, 'runId');
    nonEmpty(input.itemKey, 'itemKey');
    const res = await this.dataSource.query(
      `insert into public.cost_avoidance_events
         (run_id, course_id, manifest_id, item_key, action, source_item_run_id, basis, avoided_amount, currency,
          source_charge_event_ids, pricing_snapshot)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid[],$11::jsonb)
       on conflict (run_id, item_key) do nothing
       returning *`,
      [
        input.runId, input.courseId ?? null, input.manifestId ?? null, input.itemKey, input.action,
        input.sourceItemRunId ?? null, input.basis, normalizeDecimal(input.avoidedAmount, 'avoidedAmount'),
        (input.currency || 'USD').toUpperCase(), input.sourceChargeEventIds ?? [],
        input.pricingSnapshot === undefined ? null : JSON.stringify(input.pricingSnapshot),
      ],
    );
    if (res[0]) return { inserted: true, event: res[0] };
    const [existing] = await this.dataSource.query(
      `select * from public.cost_avoidance_events where run_id = $1 and item_key = $2`,
      [input.runId, input.itemKey],
    );
    return { inserted: false, event: existing };
  }

  async createEstimate(input: {
    scope: 'run' | 'regeneration' | 'course_preview';
    ownerId?: string | null;
    courseId?: number | null;
    manifestId?: number | null;
    runId?: string | null;
    invalidationPlanSha?: string | null;
    estimate: EstimateResult;
    createdBy?: string | null;
  }, runner: { query: (sql: string, params?: any[]) => Promise<any> } = this.dataSource): Promise<any> {
    if (!input || !input.estimate) throw new FinopsError('INVALID_INPUT', 'createEstimate necesita estimate');
    const e = input.estimate;
    const [row] = await runner.query(
      `insert into public.cost_estimates
         (scope, owner_id, course_id, manifest_id, run_id, invalidation_plan_sha, estimator_version,
          pricing_versions, usage_model_version, lines, totals, currency, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11::jsonb,$12,$13)
       returning *`,
      [
        input.scope, input.ownerId ?? null, input.courseId ?? null, input.manifestId ?? null, input.runId ?? null,
        input.invalidationPlanSha ?? null, e.estimatorVersion, JSON.stringify(e.pricingVersions), e.usageModelVersion,
        JSON.stringify(e.lines), JSON.stringify({ ...e.totals, avoided: e.avoided }), e.currency, input.createdBy ?? null,
      ],
    );
    return row;
  }

  async authorize(input: {
    runId?: string | null;
    courseId: number;
    estimateId?: string | null;
    authorizedBudget: DecimalLike;
    policyId?: string | null;
    decision: 'AUTO_WITHIN_POLICY' | 'ADMIN_APPROVED' | 'BLOCKED';
    approvedBy?: string | null;
    reason?: string | null;
    currency?: string;
  }, runner: { query: (sql: string, params?: any[]) => Promise<any> } = this.dataSource): Promise<any> {
    if (input.decision === 'ADMIN_APPROVED' && !input.approvedBy) {
      throw new FinopsError('INVALID_INPUT', 'ADMIN_APPROVED exige approvedBy');
    }
    const [row] = await runner.query(
      `insert into public.cost_budget_authorizations
         (run_id, course_id, estimate_id, authorized_budget, currency, policy_id, decision, approved_by, reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [
        input.runId ?? null, input.courseId, input.estimateId ?? null, normalizeDecimal(input.authorizedBudget, 'authorizedBudget'),
        (input.currency || 'USD').toUpperCase(), input.policyId ?? null, input.decision, input.approvedBy ?? null, input.reason ?? null,
      ],
    );
    return row;
  }

  // ─── consultas ─────────────────────────────────────────────────────────────

  /** Suma de CHARGE + ADJUSTMENT por item run (base del evitado histórico). */
  async historicalByItemRun(itemRunIds: string[]): Promise<Record<string, { id: string; event_kind: string; amount: string }[]>> {
    const ids = itemRunIds.filter((x) => typeof x === 'string' && UUID_RE.test(x));
    const out: Record<string, { id: string; event_kind: string; amount: string }[]> = {};
    if (!ids.length) return out;
    const rows = await this.dataSource.query(
      `select id, item_run_id, event_kind, amount::text as amount from public.generation_cost_events
        where item_run_id = any($1::uuid[]) and event_kind in ('CHARGE','ADJUSTMENT') order by created_at, id`,
      [ids],
    );
    for (const r of rows) (out[r.item_run_id] = out[r.item_run_id] || []).push({ id: r.id, event_kind: r.event_kind, amount: r.amount });
    return out;
  }

  async costsByCourse(courseId: number) {
    const where = `course_id = $1`;
    const p = [courseId];
    const [totals, byChapter, byItemType, byProvider, retries, avoided, runs] = await Promise.all([
      this.totalsQuery(where, p),
      this.groupQuery('chapter_id', where, p),
      this.groupQuery('item_type', where, p),
      this.groupQuery('provider', where, p),
      this.retriesQuery(where, p),
      this.dataSource.query(
        `select coalesce(sum(avoided_amount),0)::text as total, count(*)::int as events,
                coalesce(sum(avoided_amount) filter (where basis='historical_actual'),0)::text as historical_actual,
                coalesce(sum(avoided_amount) filter (where basis='current_estimate'),0)::text as current_estimate
           from public.cost_avoidance_events where course_id = $1`,
        p,
      ),
      this.estimatedVsActual(`course_id = $1`, p),
    ]);
    return { courseId, ...totals, byChapter, byItemType, byProvider, retriesPaid: retries, avoided: avoided[0], estimatedVsActual: runs };
  }

  async costsByRun(runId: string) {
    if (!UUID_RE.test(runId)) throw new FinopsError('INVALID_INPUT', 'runId debe ser UUID');
    const where = `run_id = $1`;
    const p = [runId];
    const [totals, byItemKey, byItemType, byProvider, retries, avoided, evsa, auths] = await Promise.all([
      this.totalsQuery(where, p),
      this.groupQuery('item_key', where, p),
      this.groupQuery('item_type', where, p),
      this.groupQuery('provider', where, p),
      this.retriesQuery(where, p),
      this.dataSource.query(
        `select coalesce(sum(avoided_amount),0)::text as total, count(*)::int as events from public.cost_avoidance_events where run_id = $1`,
        p,
      ),
      this.estimatedVsActual(`run_id = $1`, p),
      this.dataSource.query(
        `select id, created_at, decision, authorized_budget::text as authorized_budget, approved_by, reason, estimate_id, policy_id
           from public.cost_budget_authorizations where run_id = $1 order by created_at, id`,
        p,
      ),
    ]);
    return { runId, ...totals, byItemKey, byItemType, byProvider, retriesPaid: retries, avoided: avoided[0], estimatedVsActual: evsa[0] ?? null, authorizations: auths };
  }

  async costsByOwner(ownerId: string) {
    const where = `owner_id = $1`;
    const p = [ownerId];
    const [totals, byCourse, byProvider, unattributed] = await Promise.all([
      this.totalsQuery(where, p),
      this.groupQuery('course_id', where, p),
      this.groupQuery('provider', where, p),
      this.dataSource.query(
        `select coalesce(sum(amount),0)::text as total, count(*)::int as events
           from public.generation_cost_events where owner_id = $1 and item_run_id is null`,
        p,
      ),
    ]);
    return { ownerId, ...totals, byCourse, byProvider, unattributed: unattributed[0] };
  }

  // ─── internos ──────────────────────────────────────────────────────────────

  private async loadCatalog(provider: string, service: string, product: string): Promise<PricingCatalogRow[]> {
    return this.dataSource.query(
      `select id, provider, service, product_or_model, meter, unit_size::text as unit_size, unit_price::text as unit_price,
              currency, pricing_version, effective_from, effective_to, source, source_ref, verified
         from public.pricing_catalog where provider = $1 and service = $2 and product_or_model = $3`,
      [provider, service, product],
    );
  }

  private async insertEvent(row: Record<string, unknown>, runner: { query: (sql: string, params?: any[]) => Promise<any> }): Promise<RecordResult> {
    const cols = EVENT_COLUMNS as readonly string[];
    const values = cols.map((c) => {
      const v = row[c];
      if (JSON_COLUMNS.has(c)) return v === null || v === undefined ? (c === 'pricing_snapshot' ? null : '{}') : JSON.stringify(v);
      return v === undefined ? null : v;
    });
    const placeholders = cols.map((c, i) => (JSON_COLUMNS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`));
    const inserted = await runner.query(
      `insert into public.generation_cost_events (${cols.join(', ')})
       values (${placeholders.join(', ')})
       on conflict (idempotency_key) do nothing
       returning *, amount::text as amount`,
      values,
    );
    if (inserted[0]) return { inserted: true, event: inserted[0] };
    const [existing] = await runner.query(
      `select *, amount::text as amount from public.generation_cost_events where idempotency_key = $1`,
      [row.idempotency_key],
    );
    if (!existing) throw new FinopsError('INVALID_INPUT', `conflicto de idempotencia sin fila existente (${String(row.idempotency_key)})`);
    return { inserted: false, event: existing };
  }

  private async totalsQuery(where: string, params: unknown[]) {
    const [t] = await this.dataSource.query(
      `select coalesce(sum(amount),0)::text as total,
              coalesce(sum(amount) filter (where billable),0)::text as billable,
              coalesce(sum(amount) filter (where event_kind='CHARGE'),0)::text as charges,
              coalesce(sum(amount) filter (where event_kind='ADJUSTMENT'),0)::text as adjustments,
              coalesce(sum(amount) filter (where event_kind='REFUND'),0)::text as refunds,
              -- RF-b fix M5: pendiente = CHARGE pendiente SIN un ADJUSTMENT que lo corrija.
              coalesce(sum(amount) filter (where measurement_status='pending' and event_kind='CHARGE'
                and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)),0)::text as pending,
              count(*) filter (where measurement_status='pending' and event_kind='CHARGE'
                and not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id))::int as pending_events,
              count(*)::int as events
         from public.generation_cost_events e where ${where}`,
      params,
    );
    return { totals: t };
  }

  private async groupQuery(column: 'chapter_id' | 'item_type' | 'provider' | 'item_key' | 'course_id', where: string, params: unknown[]) {
    const rows = await this.dataSource.query(
      `select ${column}::text as key, coalesce(sum(amount),0)::text as total, count(*)::int as events
         from public.generation_cost_events where ${where}
        group by ${column} order by ${column} nulls last`,
      params,
    );
    return rows;
  }

  private async retriesQuery(where: string, params: unknown[]) {
    const [r] = await this.dataSource.query(
      `select coalesce(sum(amount),0)::text as total, count(*)::int as events
         from public.generation_cost_events
        where ${where} and event_kind = 'CHARGE' and (call_role <> 'main' or attempt > 1)`,
      params,
    );
    return r;
  }

  /** Por run: último estimado (totals.expected/min/max) vs costo real del ledger. */
  private async estimatedVsActual(where: string, params: unknown[]) {
    return this.dataSource.query(
      `with runs as (
         select distinct run_id from public.generation_cost_events where ${where} and run_id is not null
         union
         select distinct run_id from public.cost_estimates where ${where} and run_id is not null
       ),
       est as (
         select distinct on (run_id) run_id, id as estimate_id, totals->>'min' as est_min,
                totals->>'expected' as est_expected, totals->>'max' as est_max
           from public.cost_estimates where run_id in (select run_id from runs)
          order by run_id, created_at desc, id desc
       ),
       act as (
         select run_id, coalesce(sum(amount),0)::text as actual
           from public.generation_cost_events where run_id in (select run_id from runs) group by run_id
       )
       select runs.run_id, est.estimate_id, est.est_min, est.est_expected, est.est_max, coalesce(act.actual,'0') as actual
         from runs left join est using (run_id) left join act using (run_id)
        order by runs.run_id`,
      params,
    );
  }
}
