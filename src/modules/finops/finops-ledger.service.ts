import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinopsError } from './errors';
import { addDec, cmpDec, isZeroDec, normalizeDecimal, subDec, DecimalLike } from './decimal';
import { conservativePrice, llmUpperBoundVariants, priceUsage, PricingCatalogRow, PricingSnapshot, UsageMeters } from './pricing';
import { adjustmentIdempotencyKey, costIdempotencyKey, CostIdempotencyKind, CostIdempotencyParts } from './idempotency';
import { familyOfProvider, operationForItem } from './operations';
import type { EstimateResult } from './estimator';
import { CostReadService, costEventsCte } from './cost-read.service';
import { UserBudgetGate, userBudgetsMode } from './user-budget-gate';
import { assertProviderSpendAllowed, unattributedCeilings } from './spend-controls';
import { assertEvidenceMatchesAmount, parsePartialAmount, parseReconcileEvidence, ReconcileEvidence } from './reconcile-decision';
import { usd2 } from './usd-display';

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
   * FinOps P0 (2026-10-16): atribución a un CURSO (sin run ni item: p.ej. la lectura avanzada del documento, el TTS
   * legacy con curso). Se verifica contra courses.owner_id = ownerIdFromAuth; nunca viene del cliente sin verificar.
   */
  attributionCourseId?: number | null;
  /**
   * FinOps P0: quién ejecuta la llamada. 'owner_only' (default; todo lo que llega por HTTP, p.ej. el proxy LLM del
   * navegador): solo el dueño del run es un ejecutor autorizado — es la única identidad que el claim/heartbeat/complete
   * aceptan (scheduler.lockRun(ownerId)). 'server_worker': un worker del servidor que reclamó la parte (proceso de
   * confianza, nunca el cliente): aunque el owner que pasa no coincida con production_jobs.owner_id, el evento conserva
   * course_id/run_id (y el tope del run aplica); owner_id = dueño del run y metadata.executorOwnerId = el ejecutor.
   */
  executorAuthorization?: 'owner_only' | 'server_worker';
  /**
   * FinOps P0 review r1 (m1): la respuesta del proveedor llegó pero su uso NO se pudo medir (p.ej. un TTS no-mp3): el
   * cargo queda `pending` a 0 y se marca `metadata.unpricedReason='usage_not_measured'` (server-side) para que el lector
   * lo liste como «sin precio» y el alcance quede `completeness: 'partial'` (nunca un 0 invisible).
   */
  unmeasuredUsage?: boolean;
  /** FinOps P0: motivo explícito de una llamada SIN atribución (p.ej. 'connection_test', 'brand_extraction'). */
  unattributedReason?: string | null;
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

export interface ItemPaidCharge {
  idempotency_key: string;
  attempt: number;
  provider: string;
  external_operation_id: string | null;
  measurement_status: string;
  reservation: boolean;
  settled: boolean;
  /** r61 (Q-21): alta de la fila (para la ventana en vuelo de una reserva enviada y sin liquidar). */
  created_at?: string | Date | null;
  /** r62: la reserva usa la marca durable de envío (sin marca + intento caído = nunca salió → liberable). */
  send_marked?: boolean;
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
  /** FinOps P0: ejecutor de servidor distinto del dueño del run (atribución delegada). */
  executorOwnerId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** r59: clave de una reserva de TTS de OpenAI (`reservationKey` de finops-worker-hooks: `reservation:tts:<itemRunId>:g…:a…:<tag>`). */
export const TTS_RESERVATION_KEY_RE = /^reservation:tts:[0-9a-f-]{36}:[A-Za-z0-9_.:-]{1,200}$/;
/** r59: decisión pura sobre la fila de la reserva (null = no existe como reserva CHARGE). */
export function ttsReservationCheckOf(row: { item_status?: unknown } | null): 'ok' | 'not_tts' | 'item_running' {
  if (!row) return 'not_tts';
  return row.item_status === 'running' || row.item_status === 'claimed' ? 'item_running' : 'ok';
}

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

  /**
   * Review r1 (m5): CostReadService llega por DI de Nest (FinopsModule lo provee). @Optional solo para los scripts que
   * construyen el ledger a mano (`new FinopsLedgerService(ds)`): ahí se crea uno sobre el mismo DataSource.
   */
  private readonly costRead: CostReadService;

  constructor(private readonly dataSource: DataSource, @Optional() costRead?: CostReadService) {
    this.costRead = costRead ?? new CostReadService(dataSource);
  }

  // ─── r75 (Agente C): presupuesto por usuario. Sin gate o con CURSIA_USER_BUDGETS=off → igual que antes. ─────────
  private userBudgetGate: UserBudgetGate | null = null;

  /** Lo llama BudgetsModule al iniciar (evita la dependencia circular finops ↔ budgets). */
  setUserBudgetGate(gate: UserBudgetGate | null): void {
    this.userBudgetGate = gate;
  }

  private activeUserBudgetGate(): UserBudgetGate | null {
    const g = this.userBudgetGate;
    return g && g.mode() !== 'off' ? g : null;
  }

  /**
   * r75 (01 §3.2, D-14): el iniciador de un run (input_payload.startedBy, lo escribe la reserva del arranque) es un
   * ejecutor autorizado como el dueño — el evento conserva owner_id = dueño del run y metadata.executorOwnerId = el
   * iniciador (mismo patrón que server_worker). Solo con presupuestos por usuario activos.
   */
  private startedByAccepted(startedBy: unknown, ownerIdFromAuth: string): boolean {
    return userBudgetsMode() !== 'off' && typeof startedBy === 'string' && startedBy !== '' && startedBy === ownerIdFromAuth;
  }

  // ─── atribución ────────────────────────────────────────────────────────────

  /** Deriva la atribución desde generation_item_runs + production_jobs. Nunca desde el cliente. */
  async resolveAttribution(itemRunId: string | null | undefined, ownerIdFromAuth: string, executor: 'owner_only' | 'server_worker' = 'owner_only'): Promise<Attribution> {
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
              gir.generation, gir.type, gir.scope, gir.module_id, gir.chapter_id, pj.owner_id${userBudgetsMode() !== 'off' ? `,
              pj.input_payload->>'startedBy' as started_by` : ''}
         from public.generation_item_runs gir
         join public.production_jobs pj on pj.id = gir.job_id
        where gir.id = $1`,
      [itemRunId],
    );
    const r = rows[0];
    if (!r) return unattributed('item_run_not_found');
    // FinOps P0: un ejecutor que no es el dueño solo conserva la atribución si es un worker del servidor (de confianza).
    // Por HTTP (proxy del navegador) un no dueño queda sin atribuir — y si es una reserva pagada por Cursia, se RECHAZA
    // en buildChargeRow (nunca un gasto sin tope del run).
    const delegated = String(r.owner_id) !== ownerIdFromAuth;
    if (delegated && executor !== 'server_worker' && !this.startedByAccepted(r.started_by, ownerIdFromAuth)) return unattributed('owner_mismatch');
    return {
      attributed: true,
      rejectReason: null,
      owner_id: delegated ? String(r.owner_id) : ownerIdFromAuth,
      executorOwnerId: delegated ? ownerIdFromAuth : null,
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
  async resolveRunAttribution(runId: string, ownerIdFromAuth: string, executor: 'owner_only' | 'server_worker' = 'owner_only'): Promise<Attribution> {
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
      `select id, owner_id, course_id, input_payload->>'manifestId' as manifest_id, blueprint_version_id${userBudgetsMode() !== 'off' ? `,
              input_payload->>'startedBy' as started_by` : ''}
         from public.production_jobs where id = $1`,
      [runId],
    );
    if (!r) return { ...base, rejectReason: 'run_not_found' };
    const delegated = String(r.owner_id) !== ownerIdFromAuth;
    if (delegated && executor !== 'server_worker' && !this.startedByAccepted(r.started_by, ownerIdFromAuth)) return { ...base, rejectReason: 'owner_mismatch' };
    const manifestId = Number(r.manifest_id);
    return {
      ...base,
      owner_id: delegated ? String(r.owner_id) : ownerIdFromAuth,
      executorOwnerId: delegated ? ownerIdFromAuth : null,
      attributed: true,
      course_id: r.course_id === null ? null : Number(r.course_id),
      manifest_id: Number.isInteger(manifestId) ? manifestId : null,
      run_id: r.id,
      scope: 'run',
    };
  }

  /**
   * FinOps P0: atribución a nivel CURSO (sin run ni item). Exige courses.owner_id = ownerIdFromAuth (mismo criterio que
   * el run: nunca se carga a un curso ajeno). → course_id + scope 'course'.
   */
  async resolveCourseAttribution(courseId: number, ownerIdFromAuth: string): Promise<Attribution> {
    const base: Attribution = {
      attributed: false, rejectReason: null, owner_id: ownerIdFromAuth, course_id: null, blueprint_id: null, manifest_id: null,
      run_id: null, item_run_id: null, item_key: null, item_type: null, item_generation: null, scope: null, module_id: null, chapter_id: null,
    };
    if (!Number.isInteger(courseId) || courseId < 1) return { ...base, rejectReason: 'invalid_course_id' };
    const [c] = await this.dataSource.query(`select id, owner_id from public.courses where id = $1`, [courseId]);
    if (!c) return { ...base, rejectReason: 'course_not_found' };
    if (String(c.owner_id ?? '') !== ownerIdFromAuth) return { ...base, rejectReason: 'course_owner_mismatch' };
    return { ...base, attributed: true, course_id: Number(c.id), scope: 'course' };
  }

  // ─── cargos ────────────────────────────────────────────────────────────────

  async recordCharge(input: RecordChargeInput): Promise<RecordResult> {
    assertReservationSpendAllowed(input);
    const { row, pricingError, idempotencyKey } = await this.buildChargeRow(input);
    // FinOps atómico (2026-10-14, #1353: con 4 llamadas en paralelo las reservas llegaron a USD 47,62 con tope 47,50):
    // una RESERVA pagada por Cursia de un run se inserta solo si, con ella, el run sigue dentro de su presupuesto
    // autorizado — verificado e insertado en UNA transacción serializada por run (lock consultivo). Ninguna llamada
    // nueva compromete dinero por encima del tope, aunque varios workers reserven a la vez.
    if (isRunCapReservation(row)) {
      if (pricingError) {
        // Falla cerrado: una reserva sin precio exacto nunca vale 0 para el tope (tarifa más cara del catálogo).
        const catalogAll = await this.loadOpenCatalog();
        const variants = (input.metadata as Record<string, unknown> | undefined)?.llmUpperBound === true ? llmUpperBoundVariants(input.usage || {}) : [input.usage || {}];
        row.amount = variants.map((v) => conservativePrice(v, catalogAll)).reduce((a, b) => (cmpDec(a, b) >= 0 ? a : b));
        (row.metadata as Record<string, unknown>).amountBasis = 'conservative_catalog_max';
      }
      const res = await this.dataSource.transaction((m) => this.insertReservationWithinRunCap(row, m));
      if (pricingError) this.logPricingMissing(idempotencyKey, input, pricingError);
      return pricingError ? { ...res, pricingMissing: true } : res;
    }
    // r58 (AU3 §H4.6, I2): una reserva pagada por Cursia SIN run ni curso (proxy del navegador sin parte declarada) se
    // inserta solo si cabe en el techo de gasto sin atribuir (por dueño, 24 h móviles, y global) — verificado e
    // insertado bajo UN lock consultivo (dos reservas concurrentes nunca pasan el techo). Sin techo configurado → igual
    // que antes.
    const ceilings = isUnattributedPaidReservation(row) ? unattributedCeilings() : null;
    const hasCeiling = !!ceilings && (ceilings.perOwner !== null || ceilings.global !== null);
    // r75 (01 §5.4): una RESERVA pagada por Cursia SIN run (proxy sin parte, llamadas con reserva previa) exige además
    // disponible del usuario ≥ monto, verificado e insertado bajo el lock del usuario (orden: usuario → techo sin
    // atribuir). Sin gate activo → exactamente el camino de antes.
    const gate = isNoRunPaidReservation(row) ? this.activeUserBudgetGate() : null;
    const res = gate
      ? await this.dataSource.transaction(async (m) => {
          await m.query(`set local lock_timeout = '20s'`);
          await gate.guardUnattributedSpend(m, { userId: String(row.owner_id), amount: row.amount as string, idempotencyKey: String(row.idempotency_key) });
          return hasCeiling ? this.insertReservationWithinUnattributedCeiling(row, ceilings!, m) : this.insertEvent(row, m);
        })
      : hasCeiling
        ? await this.dataSource.transaction((m) => this.insertReservationWithinUnattributedCeiling(row, ceilings!, m))
        : await this.insertEvent(row, this.dataSource);
    if (pricingError) {
      this.logPricingMissing(idempotencyKey, input, pricingError);
      return { ...res, pricingMissing: true };
    }
    return res;
  }

  /**
   * r58: techo del gasto SIN atribuir (run_id y course_id nulos, Cursia). Suma el neto (cargos + reservas + ajustes) de
   * las últimas 24 h del dueño y global; si con esta reserva alguno pasaría su techo → FinopsError UNATTRIBUTED_CEILING
   * (el proxy responde 409 `unattributed_ceiling_reached` y no llama). Reintento idempotente → la existente, sin evaluar.
   */
  private async insertReservationWithinUnattributedCeiling(
    row: Record<string, unknown>,
    ceilings: { perOwner: string | null; global: string | null },
    m: { query: (sql: string, params?: any[]) => Promise<any> },
  ): Promise<RecordResult> {
    await m.query(`set local lock_timeout = '20s'`);
    await m.query(`select pg_advisory_xact_lock(hashtext($1))`, [UNATTRIBUTED_CEILING_LOCK]);
    const [existing] = await m.query(`select *, amount::text as amount from public.generation_cost_events where idempotency_key = $1`, [row.idempotency_key]);
    if (existing) return { inserted: false, event: existing };
    const [t] = await m.query(
      `select coalesce(sum(amount) filter (where owner_id = $1), 0)::text as owner_total, coalesce(sum(amount), 0)::text as global_total
         from public.generation_cost_events
        where run_id is null and course_id is null and billing_account = 'cursia' and created_at > now() - interval '24 hours'`,
      [row.owner_id],
    );
    const checks: Array<[string, string | null, string]> = [['por dueño', ceilings.perOwner, t.owner_total], ['global', ceilings.global, t.global_total]];
    for (const [scope, cap, spent] of checks) {
      if (cap === null) continue;
      const after = addDec(spent, row.amount as string);
      if (cmpDec(after, cap) > 0) {
        throw new FinopsError('UNATTRIBUTED_CEILING',
          `el gasto sin atribuir de las últimas 24 h (${scope}) llegaría a USD ${usd2(after)} y el techo es USD ${usd2(cap)}: no se hace la llamada`,
          { scope: scope === 'global' ? 'global' : 'owner', spent, amount: row.amount, ceiling: cap });
      }
    }
    return this.insertEvent(row, m);
  }

  /**
   * Reserva de una UNIDAD pagada completa (review I4: chunks de TTS de un mismo audio, guion principal + continuación +
   * condensación de un bloque): TODAS las reservas o NINGUNA, en una transacción con el lock del run — así una unidad
   * nunca queda a medias porque el tope se agotó entre sus llamadas (lo pagado sin terminar iría a conciliación).
   * Reintento: las que ya existen se devuelven sin volver a contarlas. → resultados en el mismo orden.
   */
  async recordReservationBatch(inputs: RecordChargeInput[]): Promise<RecordResult[]> {
    if (!inputs.length) return [];
    for (const input of inputs) assertReservationSpendAllowed(input);
    const built = [];
    for (const input of inputs) {
      const b = await this.buildChargeRow(input);
      if (!isRunCapReservation(b.row)) throw new FinopsError('INVALID_INPUT', `recordReservationBatch solo admite reservas de un run (${b.idempotencyKey})`);
      if (b.pricingError) {
        const catalogAll = await this.loadOpenCatalog();
        const variants = (input.metadata as Record<string, unknown> | undefined)?.llmUpperBound === true ? llmUpperBoundVariants(input.usage || {}) : [input.usage || {}];
        b.row.amount = variants.map((v) => conservativePrice(v, catalogAll)).reduce((a, c) => (cmpDec(a, c) >= 0 ? a : c));
        (b.row.metadata as Record<string, unknown>).amountBasis = 'conservative_catalog_max';
      }
      built.push(b);
    }
    const runIds = new Set(built.map((b) => String(b.row.run_id)));
    if (runIds.size !== 1) throw new FinopsError('INVALID_INPUT', 'recordReservationBatch: todas las reservas deben ser del mismo run');
    const runId = [...runIds][0];
    return this.dataSource.transaction(async (m) => {
      await m.query(`set local lock_timeout = '20s'`);
      await m.query(`select pg_advisory_xact_lock(hashtext($1))`, [RUN_CAP_LOCK_PREFIX + runId]);
      const existing = new Map<string, any>();
      for (const b of built) {
        const [e] = await m.query(`select *, amount::text as amount from public.generation_cost_events where idempotency_key = $1`, [b.row.idempotency_key]);
        if (e) existing.set(String(b.row.idempotency_key), e);
      }
      const fresh = built.filter((b) => !existing.has(String(b.row.idempotency_key)));
      const [auth] = await m.query(
        `select decision, authorized_budget::text as b from public.cost_budget_authorizations where run_id = $1 order by created_at desc, id desc limit 1`,
        [runId],
      );
      // r58 H4: sin ninguna autorización → falla cerrado (antes = sin tope). Una unidad de monto 0 no compromete dinero.
      if (!auth && fresh.length) {
        const amount = addDec(...fresh.map((b) => b.row.amount as string));
        if (cmpDec(amount, 0) > 0) throw runBudgetNotAuthorizedError(runId, amount);
      }
      if (auth && fresh.length) {
        const cap = auth.decision === 'BLOCKED' ? '0' : String(auth.b);
        const [t] = await m.query(`select coalesce(sum(amount), 0)::text as t from public.generation_cost_events where run_id = $1 and billing_account <> 'user_key'`, [runId]);
        const after = addDec(t.t, ...fresh.map((b) => b.row.amount as string));
        if (cmpDec(after, cap) > 0) {
          throw new FinopsError('RUN_BUDGET_CAP',
            `el run llegaría a USD ${Number(after).toFixed(2)} con esta unidad (${fresh.length} reservas) y el presupuesto autorizado es USD ${Number(cap).toFixed(2)}`,
            { runId, spent: t.t, amount: addDec(...fresh.map((b) => b.row.amount as string)), authorizedBudget: cap, requiredUsd: after });
        }
      }
      const out: RecordResult[] = [];
      for (const b of built) {
        const e = existing.get(String(b.row.idempotency_key));
        out.push(e ? { inserted: false, event: e } : await this.insertEvent(b.row, m));
      }
      return out;
    });
  }

  /**
   * Inserta una reserva de un run SOLO si el total del run (cargos + ajustes + reservas pendientes, sin BYOK) más la
   * reserva no supera la ÚLTIMA autorización del run (BLOCKED = tope 0; r58 H4: sin ninguna autorización → FinopsError
   * RUN_BUDGET_NOT_AUTHORIZED, falla cerrado). Lock consultivo por run (`finops:run-cap:<runId>`): dos reservas del mismo run nunca se evalúan a la vez,
   * en ningún proceso. Reintento idempotente de la misma reserva → devuelve la existente sin volver a evaluar.
   * Excedería el tope → FinopsError RUN_BUDGET_CAP (details: runId, spent, amount, authorizedBudget, requiredUsd).
   */
  private async insertReservationWithinRunCap(row: Record<string, unknown>, m: { query: (sql: string, params?: any[]) => Promise<any> }): Promise<RecordResult> {
    const runId = String(row.run_id);
    // Review M4: nunca una espera indefinida por el lock (pool de conexiones): 20 s y falla (la llamada no se hace).
    await m.query(`set local lock_timeout = '20s'`);
    await m.query(`select pg_advisory_xact_lock(hashtext($1))`, [RUN_CAP_LOCK_PREFIX + runId]);
    const [existing] = await m.query(`select *, amount::text as amount from public.generation_cost_events where idempotency_key = $1`, [row.idempotency_key]);
    if (existing) return { inserted: false, event: existing };
    const [auth] = await m.query(
      `select decision, authorized_budget::text as b from public.cost_budget_authorizations where run_id = $1 order by created_at desc, id desc limit 1`,
      [runId],
    );
    // r58 H4: sin ninguna autorización → falla cerrado (antes = sin tope). Una reserva de monto 0 no compromete dinero.
    if (!auth && cmpDec(row.amount as string, 0) > 0) throw runBudgetNotAuthorizedError(runId, row.amount as string);
    if (auth) {
      const cap = auth.decision === 'BLOCKED' ? '0' : String(auth.b);
      const [t] = await m.query(
        `select coalesce(sum(amount), 0)::text as t from public.generation_cost_events where run_id = $1 and billing_account <> 'user_key'`,
        [runId],
      );
      const after = addDec(t.t, row.amount as string);
      if (cmpDec(after, cap) > 0) {
        throw new FinopsError(
          'RUN_BUDGET_CAP',
          `el run llegaría a USD ${Number(after).toFixed(2)} con esta reserva y el presupuesto autorizado es USD ${Number(cap).toFixed(2)}`,
          { runId, spent: t.t, amount: row.amount, authorizedBudget: cap, requiredUsd: after },
        );
      }
    }
    return this.insertEvent(row, m);
  }

  /**
   * Review M3 — red de seguridad posterior: con el run por encima de su última autorización (un cargo real mayor que
   * su reserva), el run se PAUSA (`run_budget_cap`, misma pausa que el guard) si todavía despachaba partes. → pausó.
   */
  private async pauseRunIfOverCap(m: { query: (sql: string, params?: any[]) => Promise<any> }, runId: string, cause: string): Promise<boolean> {
    const [auth] = await m.query(
      `select decision, authorized_budget::text as b from public.cost_budget_authorizations where run_id = $1 order by created_at desc, id desc limit 1`,
      [runId],
    );
    if (!auth) return false;
    const cap = auth.decision === 'BLOCKED' ? '0' : String(auth.b);
    const [t] = await m.query(`select coalesce(sum(amount), 0)::text as t from public.generation_cost_events where run_id = $1 and billing_account <> 'user_key'`, [runId]);
    if (cmpDec(t.t, cap) <= 0) return false;
    const detail = `el gasto real del run (USD ${Number(t.t).toFixed(2)}) superó el presupuesto autorizado (USD ${Number(cap).toFixed(2)}) al liquidar ${cause}`;
    const rows = await m.query(
      `update public.production_jobs
          set status = 'paused', worker_status = 'paused', next_retry_at = null,
              output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object(
                'pause', jsonb_build_object('pausedAt', now(), 'pausedBy', 'system:run_budget_cap', 'reason', 'run_budget_cap', 'detail', $2::text,
                                            'requiredUsd', $3::numeric, 'previousWorkerStatus', worker_status, 'overshoot', true)),
              updated_at = now()
        where id = $1 and execution_mode = 'dynamic_generation' and worker_status in ('queued', 'running', 'retrying')
          and coalesce(status, '') not in ('cancelled', 'cancelling')
        returning id`,
      [runId, detail.slice(0, 500), t.t],
    );
    const list = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows;
    const paused = Array.isArray(list) && list.length > 0;
    this.logger.error(`FINOPS_OVERSHOOT: ${detail}${paused ? ' — run pausado' : ''}`);
    return paused;
  }

  /** Catálogo completo vigente (para la tarifa conservadora de una reserva sin precio exacto). */
  private async loadOpenCatalog(): Promise<PricingCatalogRow[]> {
    return this.dataSource.query(`select * from public.pricing_catalog where effective_to is null or effective_to > now()`);
  }

  private logPricingMissing(idempotencyKey: string, input: RecordChargeInput, pricingError: { code: string; message: string }): void {
    this.logger.error(
      `PRICING_MISSING: CHARGE ${idempotencyKey} (${input.provider}/${input.service}/${input.modelOrProduct}) registrado a 0 ` +
        `y PENDIENTE (${pricingError.code}: ${pricingError.message}). Cargar el precio en pricing_catalog y re-preciar ` +
        '(FinopsLedgerService.repricePendingCharge) — el costo real NO está en los totales hasta entonces.',
    );
  }

  /** Arma (validación + atribución server-side + precio) la fila de un CHARGE sin insertarla. */
  private async buildChargeRow(
    input: RecordChargeInput,
  ): Promise<{ row: Record<string, unknown>; pricingError: { code: string; message: string } | null; idempotencyKey: string }> {
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

    const executor = input.executorAuthorization === 'server_worker' ? 'server_worker' : 'owner_only';
    const noItem = input.itemRunId === null || input.itemRunId === undefined || input.itemRunId === '';
    const attribution =
      noItem && input.attributionRunId
        ? await this.resolveRunAttribution(input.attributionRunId, owner, executor)
        : noItem && input.attributionCourseId !== null && input.attributionCourseId !== undefined
          ? await this.resolveCourseAttribution(Number(input.attributionCourseId), owner)
          : await this.resolveAttribution(input.itemRunId ?? null, owner, executor);
    // FinOps P0 (owner mismatch, review del audit §4 #7): una RESERVA real pagada por Cursia de una parte de un run
    // AJENO se rechaza — sin esto quedaba sin atribuir y sin tope del run ni guard de gasto (bypass). BYOK / mock y los
    // cargos posteriores al gasto (el dinero ya se gastó: nunca se pierde) se registran sin atribuir con el motivo.
    const paidReservation = input.billingAccount === 'cursia' && input.mode === 'real' && (input.metadata as Record<string, unknown> | undefined)?.reservation === true;
    if (!attribution.attributed && attribution.rejectReason === 'owner_mismatch' && paidReservation) {
      throw new FinopsError('ATTRIBUTION_REJECTED',
        'la parte declarada es de un run de otro dueño: este ejecutor no está autorizado para ese run (no se reserva ni se llama al proveedor)',
        { itemRunId: typeof input.itemRunId === 'string' ? input.itemRunId.slice(0, 64) : null });
    }
    // r58 (AU3 §H4.6): una reserva pagada que DECLARA una parte inexistente (UUID inventado / inválido) ya no se acepta
    // como «sin atribuir» (era la forma de saltarse el tope del run): se rechaza antes de reservar (no se llama).
    if (!attribution.attributed && (attribution.rejectReason === 'item_run_not_found' || attribution.rejectReason === 'invalid_item_run_id') && paidReservation) {
      throw new FinopsError('ITEM_RUN_NOT_FOUND',
        'la parte declarada no existe: no se reserva ni se llama al proveedor (una llamada sin parte no declara x-cursia-item-run-id)',
        { itemRunId: typeof input.itemRunId === 'string' ? input.itemRunId.slice(0, 64) : null });
    }

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
        const target = {
          provider: input.provider,
          service: input.service,
          product: input.modelOrProduct,
          // Default: ahora (una fila con effective_from futuro nunca se aplica antes de tiempo).
          asOf: input.pricingAsOf ?? new Date(),
        };
        let priced = priceUsage(input.usage || {}, catalog, target);
        // Cota de una llamada LLM (reserva): el máximo entre sus variantes de precio (nunca menor al cargo real).
        if ((input.metadata as Record<string, unknown> | undefined)?.llmUpperBound === true) {
          for (const v of llmUpperBoundVariants(input.usage || {})) {
            const alt = priceUsage(v, catalog, target);
            if (cmpDec(alt.amount, priced.amount) > 0) priced = alt;
          }
        }
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
    delete metadata.attribution;
    delete metadata.unattributedReason;
    delete metadata.executorOwnerId;
    delete metadata.unpricedReason;
    if (!attribution.attributed) {
      // FinOps P0: nunca un NULL silencioso — sin atribución, con un motivo explícito (scope queda NULL: el CHECK del
      // ledger solo admite course/module/chapter/run/org; la marca vive en metadata, sin migración).
      metadata.attribution = 'unattributed';
      metadata.unattributedReason = attribution.rejectReason
        ?? (typeof input.unattributedReason === 'string' && input.unattributedReason.trim() ? input.unattributedReason.trim().slice(0, 64) : 'no_attribution_declared');
    }
    if (attribution.executorOwnerId) metadata.executorOwnerId = attribution.executorOwnerId;
    if (pricingError) {
      metadata.pricingMissing = true;
      metadata.pricingError = pricingError;
    }
    // FinOps P0 review r1: marca única de «sin precio» que lee CostReadService (is_unpriced).
    if (pricingError) metadata.unpricedReason = 'pricing_missing';
    else if (input.unmeasuredUsage === true && isZeroDec(amount)) metadata.unpricedReason = 'usage_not_measured';
    if (!attribution.attributed && attribution.rejectReason) {
      metadata.attributionRejected = true;
      metadata.attributionRejectReason = attribution.rejectReason;
      metadata.requestedItemRunId = typeof input.itemRunId === 'string' ? input.itemRunId.slice(0, 64) : null;
    }
    if (costSource === 'CALCULATED_FROM_USAGE' && input.providerCalculatedAmount !== null && input.providerCalculatedAmount !== undefined) {
      metadata.amountBasis = 'provider_calculated';
    }

    const billable = input.billingAccount === 'cursia' && costSource !== 'MOCK';
    // r75 (01 §6): institución del evento NUEVO = la del curso (o, sin curso, la única membresía activa del dueño).
    // Los eventos viejos no se reescriben (append-only): la lectura los resuelve por course_id. Con el flag en off → null.
    const gate = this.activeUserBudgetGate();
    const institutionId = gate
      ? await gate.institutionForCharge(this.dataSource, { ownerId: attribution.owner_id, courseId: attribution.course_id, runId: attribution.run_id })
      : null;

    const row: Record<string, unknown> = {
      event_kind: 'CHARGE',
      corrects_event_id: null,
      owner_id: attribution.owner_id,
      institution_id: institutionId,
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
      measurement_status: pricingError || metadata.unpricedReason === 'usage_not_measured' ? 'pending' : input.measurementStatus ?? 'final',
      billing_account: input.billingAccount,
      billable,
      outcome: input.outcome ?? 'succeeded',
      quota_units: num(input.quotaUnits ?? null),
      recorded_by: input.recordedBy,
      metadata,
    };
    return { row, pricingError, idempotencyKey };
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

  /**
   * #583 fix round 1 (I1) + fix round 2 (N2): corrige UNA VEZ un cargo LLM CONSERVADOR (metadata.conservative,
   * registrado por el proxy cuando el navegador cortó el stream) con el usage EXACTO medido al terminar de
   * leer el stream. Bajo el mismo lock de los ajustes de ese cargo:
   *  - el cargo tiene que ser conservador y SIN una corrección previa (una sola; el ledger es append-only:
   *    la marca «corrected» es el propio ADJUSTMENT con metadata.correctsConservative/conservativeStatus);
   *  - dueño y modelo iguales a los del cargo;
   *  - input y caché (escritura y lectura) IGUALES a los del cargo y output ≤ el del cargo: la corrección
   *    solo puede quitar el relleno de max_tokens, nunca bajar otra cosa.
   * ADJUSTMENT por la diferencia (precio del catálogo AL MOMENTO DEL CARGO). Si el conservador no existe →
   * null (el llamador registra el exacto como cargo). Un cargo medido nunca se toca.
   */
  async correctConservativeLlmCharge(
    originalKey: string,
    measuredUsage: UsageMeters,
    expect: { ownerId?: string | null; model?: string | null } = {},
  ): Promise<{ corrected: boolean; delta: string | null; reason?: string } | null> {
    nonEmpty(originalKey, 'originalKey');
    assertCompleteMeasurement(originalKey, measuredUsage);
    const [peek] = await this.dataSource.query(`select provider, service, model_or_product from public.generation_cost_events where idempotency_key = $1`, [originalKey]);
    if (!peek) return null;
    const catalog = await this.loadCatalog(peek.provider, peek.service, peek.model_or_product);
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`select pg_advisory_xact_lock(hashtext($1))`, ['finops:adj:' + originalKey]);
      const [orig] = await manager.query(`select *, amount::text as amount from public.generation_cost_events where idempotency_key = $1`, [originalKey]);
      if (!orig) return null;
      const refuse = (reason: string) => ({ corrected: false, delta: null, reason });
      if (orig.event_kind !== 'CHARGE' || orig.metadata?.conservative !== true) return refuse('not_conservative');
      const [prev] = await manager.query(
        `select count(*)::int as n from public.generation_cost_events
          where corrects_event_id = $1 and event_kind = 'ADJUSTMENT' and coalesce(metadata->>'correctsConservative', '') = 'true'`,
        [orig.id],
      );
      if (Number(prev.n) > 0) return refuse('already_corrected');
      if (expect.ownerId != null && String(orig.owner_id ?? '') !== String(expect.ownerId)) return refuse('owner_mismatch');
      if (expect.model != null && String(orig.model_or_product ?? '') !== String(expect.model)) return refuse('model_mismatch');
      const o = (orig.usage || {}) as Record<string, unknown>;
      const m = (measuredUsage || {}) as Record<string, unknown>;
      const n = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));
      for (const k of ['input_tokens', 'cache_write_tokens', 'cache_read_tokens']) {
        if (n(o[k]) !== n(m[k])) return refuse(`${k}_mismatch`);
      }
      if (!(n(m.output_tokens) <= n(o.output_tokens))) return refuse('output_above_conservative');
      const priced = priceUsage(measuredUsage || {}, catalog, {
        provider: orig.provider,
        service: orig.service,
        product: orig.model_or_product,
        asOf: orig.created_at,
      });
      // forceInsert: aunque el exacto coincida con el conservador (delta 0) queda el ADJUSTMENT de marca: única vez.
      const r = await this.adjustWith(manager, originalKey, normalizeDecimal(priced.amount), 'llm_stream_measured_after_client_gone', {
        recordedBy: 'llm-proxy',
        forceInsert: true,
        metadata: { measuredUsage, pricingSnapshot: priced.pricingSnapshot, correctsConservative: true, conservativeStatus: 'corrected' },
      });
      return { corrected: r.inserted, delta: r.delta };
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
    executorAuthorization?: 'owner_only' | 'server_worker';
  }): Promise<RecordResult> {
    const isYoutube = input.kind === 'youtube';
    if (!isYoutube && input.kind !== 'package') throw new FinopsError('INVALID_INPUT', `recordZero kind inválido: ${String(input.kind)}`);
    const mode = input.mode ?? 'real';
    return this.recordCharge({
      itemRunId: input.itemRunId ?? null,
      attributionRunId: input.attributionRunId ?? null,
      ownerIdFromAuth: input.ownerIdFromAuth,
      executorAuthorization: input.executorAuthorization,
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
    // r62 (N2): `settlementLabel` = etiqueta explícita de la liquidación (p.ej. la conciliación conservadora del sistema).
    opts: { recordedBy?: string; metadata?: Record<string, unknown>; settlement?: boolean; settlementLabel?: string } = {},
  ): Promise<{ inserted: boolean; event: CostEventRow | null; delta: string; previousTotal: string; newTotal: string }> {
    nonEmpty(originalKey, 'originalKey');
    nonEmpty(reason, 'reason');
    const newTotal = normalizeDecimal(newAmount, 'newAmount');
    if (cmpDec(newTotal, 0) < 0) throw new FinopsError('INVALID_INPUT', 'el nuevo total no puede ser negativo (usar REFUND)');
    return this.dataSource.transaction((manager) => this.adjustWith(manager, originalKey, newTotal, reason, opts));
  }

  /** Cuerpo de recordAdjustment dentro de una transacción ya abierta (lock por clave original). */
  private async adjustWith(
    manager: { query: (sql: string, params?: any[]) => Promise<any> },
    originalKey: string,
    newTotal: string,
    reason: string,
    opts: { recordedBy?: string; metadata?: Record<string, unknown>; settlement?: boolean; settlementLabel?: string; forceInsert?: boolean },
  ): Promise<{ inserted: boolean; event: CostEventRow | null; delta: string; previousTotal: string; newTotal: string }> {
    {
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
      if (isZeroDec(delta) && !settlesPending && !opts.forceInsert) return { inserted: false, event: null, delta, previousTotal, newTotal };
      const settlementMeta = opts.settlement
        ? { settlement: opts.settlementLabel ?? (isZeroDec(delta) ? 'measured_equals_provisional' : 'measured_differs') }
        : {};
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
    }
  }

  // ─── V2.1 calibración: reservas DURABLES antes de cada llamada pagada ───────
  //
  // Protocolo (workers): reserva durable (CHARGE `pending`, metadata.reservation)
  // → llamada al proveedor → liquidación ATÓMICA: CHARGE final idempotente por el
  // id de operación del proveedor + ADJUSTMENT de la reserva a 0 en la MISMA
  // transacción. Nunca queda la reserva y el cargo real sumados, ni ninguno.

  /**
   * Liquida una reserva: inserta `finalCharge` (idempotente por su clave: el
   * mismo id de operación del proveedor = un solo cargo) y lleva la reserva a 0
   * (settlement) en una transacción. `finalCharge=null` = liberar (el proveedor
   * rechazó el pedido de forma definitiva, sin gasto). Repetir = no-op.
   */
  async settleReservation(
    reservationKey: string,
    finalCharge: RecordChargeInput | null,
    reason: string,
    opts: { recordedBy?: string } = {},
  ): Promise<{ finalInserted: boolean; finalEvent: CostEventRow | null; released: boolean; alreadySettled: boolean }> {
    nonEmpty(reservationKey, 'reservationKey');
    nonEmpty(reason, 'reason');
    // Lecturas (atribución / catálogo) fuera de la transacción; las escrituras, juntas.
    const built = finalCharge ? await this.buildChargeRow(finalCharge) : null;
    const out = await this.dataSource.transaction(async (manager) => {
      await manager.query(`select pg_advisory_xact_lock(hashtext($1))`, ['finops:adj:' + reservationKey]);
      const [res] = await manager.query(
        `select id, event_kind, metadata, measurement_status from public.generation_cost_events where idempotency_key = $1`,
        [reservationKey],
      );
      if (!res) throw new FinopsError('ORIGINAL_NOT_FOUND', `no existe la reserva ${reservationKey}`);
      if (res.event_kind !== 'CHARGE' || res.metadata?.reservation !== true) {
        throw new FinopsError('INVALID_INPUT', `${reservationKey} no es una reserva de llamada pagada`);
      }
      const [adj] = await manager.query(
        `select count(*)::int as n from public.generation_cost_events where corrects_event_id = $1 and event_kind = 'ADJUSTMENT'`,
        [res.id],
      );
      let fin: RecordResult | null = null;
      if (Number(adj.n) > 0) {
        // Review (I2): si un admin ya la concilió «cobrada», el monto de la reserva YA cuenta como el gasto de esa
        // llamada: un usage tardío no agrega un segundo cargo (sería doble conteo). En cualquier otro cierre
        // (liquidada / liberada / «no cobrada») el cargo real sí se registra (nunca de menos).
        // r60: una conciliación PARCIAL (`reservationReconciledAsPartial`) también cuenta como «cobrada», pero su monto
        // es una lectura de evidencia: si después llega la medición real del proveedor, gana la medición (mayor o menor).
        const [asCharged] = await manager.query(
          `select bool_or(coalesce(metadata->>'reservationReconciledAsPartial', '') = 'true') as partial
             from public.generation_cost_events where corrects_event_id = $1 and event_kind = 'ADJUSTMENT'
              and (metadata->>'reservationReconciledAsCharged') = 'true' having count(*) > 0`,
          [res.id],
        );
        if (built && !asCharged) {
          fin = await this.insertEvent(built.row, manager);
          if (fin.inserted && typeof built.row.run_id === 'string') await this.pauseRunIfOverCap(manager, built.row.run_id as string, reservationKey);
        }
        if (built && asCharged) {
          // Re-review (minor a): la cota de la reserva puede quedarse corta. Si el usage real tardío SUPERA lo que
          // quedó contado, gana el real (nunca de menos): se inserta el cargo real y la reserva se lleva a 0.
          const [net] = await manager.query(
            `select coalesce(sum(amount),0)::text as t from public.generation_cost_events where id = $1 or corrects_event_id = $1`,
            [res.id],
          );
          const partialSupersede = asCharged.partial === true && !isZeroDec(net.t);
          if (partialSupersede || Number(built.row.amount ?? 0) > Number(net.t)) {
            fin = await this.insertEvent(built.row, manager);
            if (fin.inserted) {
              await this.adjustWith(manager, reservationKey, normalizeDecimal(0), partialSupersede ? 'late_usage_supersedes_partial_reconciliation' : 'late_usage_exceeds_reconciled_reservation', {
                recordedBy: opts.recordedBy || 'dynamic-worker',
                settlement: true,
                metadata: { reservationSettled: true, supersededBy: built.idempotencyKey },
              });
              // Review r2 (M3): también en el usage tardío mayor que lo contado.
              if (typeof built.row.run_id === 'string') await this.pauseRunIfOverCap(manager, built.row.run_id as string, reservationKey);
            }
          }
        }
        return { finalInserted: !!fin?.inserted, finalEvent: fin?.event ?? null, released: false, alreadySettled: true };
      }
      // FinOps P0 review r1 (I1): un cargo final SIN precio queda a 0 `pending` (metadata.pricingMissing) y la reserva se
      // lleva a 0 como siempre (nunca una reserva abierta para una llamada ya respondida: los lectores de «resultado
      // desconocido» la tomarían por ambigua). El lector (CostReadService) la lista como «sin precio» y marca el
      // alcance `completeness: 'partial'`; repricePendingCharge la precia después.
      if (built) fin = await this.insertEvent(built.row, manager);
      await this.adjustWith(manager, reservationKey, normalizeDecimal(0), reason, {
        recordedBy: opts.recordedBy || 'dynamic-worker',
        settlement: true,
        metadata: { reservationSettled: true, supersededBy: built ? built.idempotencyKey : null },
      });
      // Review M3: si el cargo REAL superó su reserva y el run quedó por encima del tope, se pausa en la misma
      // transacción (red de seguridad: la próxima llamada no se hace; el gasto ya ocurrido queda registrado).
      if (fin?.inserted && typeof built?.row.run_id === 'string') await this.pauseRunIfOverCap(manager, built.row.run_id as string, reservationKey);
      return { finalInserted: !!fin?.inserted, finalEvent: fin?.event ?? null, released: true, alreadySettled: false };
    });
    if (built?.pricingError && out.finalInserted) this.logPricingMissing(built.idempotencyKey, finalCharge as RecordChargeInput, built.pricingError);
    return out;
  }

  /**
   * R14: conciliación ADMINISTRATIVA de una reserva cuya llamada quedó ambigua (el proveedor
   * pudo haber cobrado sin que llegara el id de la operación) y que el dueño decidió contar
   * COMO COBRADA. Inserta un ADJUSTMENT `final` con delta 0: el pendiente se resuelve y el
   * monto reservado sigue contado como gasto (nunca se libera a 0 ni se llama al proveedor).
   * Exige `decidedBy` y `reason` explícitos. Repetir, o una reserva ya liquidada = no-op.
   */
  async reconcileReservationAsCharged(
    reservationKey: string,
    reason: string,
    opts: { decidedBy?: string; recordedBy?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<{ reconciled: boolean; alreadySettled: boolean; amount: string; event: CostEventRow | null }> {
    nonEmpty(reservationKey, 'reservationKey');
    nonEmpty(reason, 'reason');
    const decidedBy = nonEmpty(opts.decidedBy, 'decidedBy');
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`select pg_advisory_xact_lock(hashtext($1))`, ['finops:adj:' + reservationKey]);
      const [res] = await manager.query(
        `select id, event_kind, metadata, measurement_status, amount::text as amount from public.generation_cost_events where idempotency_key = $1`,
        [reservationKey],
      );
      if (!res) throw new FinopsError('ORIGINAL_NOT_FOUND', `no existe la reserva ${reservationKey}`);
      if (res.event_kind !== 'CHARGE' || res.metadata?.reservation !== true) {
        throw new FinopsError('INVALID_INPUT', `${reservationKey} no es una reserva de llamada pagada`);
      }
      const [adj] = await manager.query(
        `select count(*)::int as n from public.generation_cost_events where corrects_event_id = $1 and event_kind = 'ADJUSTMENT'`,
        [res.id],
      );
      if (Number(adj.n) > 0) return { reconciled: false, alreadySettled: true, amount: res.amount, event: null };
      if (res.measurement_status !== 'pending') {
        throw new FinopsError('INVALID_INPUT', `${reservationKey} no está pendiente (${String(res.measurement_status)}): no hay nada que conciliar`);
      }
      const r = await this.adjustWith(manager, reservationKey, normalizeDecimal(res.amount), reason, {
        recordedBy: opts.recordedBy || 'reconciler',
        settlement: true,
        settlementLabel: 'reconciled_as_charged',
        metadata: { ...(opts.metadata || {}), reservationReconciledAsCharged: true, decidedBy },
      });
      return { reconciled: r.inserted, alreadySettled: false, amount: res.amount, event: r.event };
    });
  }

  /**
   * V542 (G6) — conciliación ADMINISTRATIVA de una reserva cuyo resultado es INCIERTO y que un
   * SUPER_ADMIN decidió contar como NO COBRADA (p.ej. Videogen falló en `generate_script` antes del
   * render y la cuenta del proveedor no muestra cobro). Inserta un ADJUSTMENT `final` que lleva la
   * reserva a 0 (append-only: el CHARGE original queda, con su corrección al lado) con el motivo y el
   * actor. Nunca es automático (regla del usuario: un resultado incierto no se libera solo). Exige
   * `decidedBy` y `reason`. Repetir, o una reserva ya liquidada/conciliada = no-op (`alreadySettled`).
   */
  async reconcileReservationAsNotCharged(
    reservationKey: string,
    reason: string,
    opts: { decidedBy?: string; recordedBy?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<{ reconciled: boolean; alreadySettled: boolean; amount: string; event: CostEventRow | null }> {
    nonEmpty(reservationKey, 'reservationKey');
    nonEmpty(reason, 'reason');
    const decidedBy = nonEmpty(opts.decidedBy, 'decidedBy');
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`select pg_advisory_xact_lock(hashtext($1))`, ['finops:adj:' + reservationKey]);
      const [res] = await manager.query(
        `select id, event_kind, metadata, measurement_status, amount::text as amount from public.generation_cost_events where idempotency_key = $1`,
        [reservationKey],
      );
      if (!res) throw new FinopsError('ORIGINAL_NOT_FOUND', `no existe la reserva ${reservationKey}`);
      if (res.event_kind !== 'CHARGE' || res.metadata?.reservation !== true) {
        throw new FinopsError('INVALID_INPUT', `${reservationKey} no es una reserva de llamada pagada`);
      }
      const [adj] = await manager.query(
        `select count(*)::int as n from public.generation_cost_events where corrects_event_id = $1 and event_kind = 'ADJUSTMENT'`,
        [res.id],
      );
      if (Number(adj.n) > 0) return { reconciled: false, alreadySettled: true, amount: res.amount, event: null };
      if (res.measurement_status !== 'pending') {
        throw new FinopsError('INVALID_INPUT', `${reservationKey} no está pendiente (${String(res.measurement_status)}): no hay nada que conciliar`);
      }
      const r = await this.adjustWith(manager, reservationKey, normalizeDecimal(0), reason, {
        recordedBy: opts.recordedBy || 'reconciler',
        settlement: true,
        settlementLabel: 'reconciled_as_not_charged',
        metadata: { ...(opts.metadata || {}), reservationReconciledAsNotCharged: true, decidedBy },
      });
      return { reconciled: r.inserted, alreadySettled: false, amount: res.amount, event: r.event };
    });
  }

  /**
   * r60 — conciliación ADMINISTRATIVA PARCIAL: el proveedor cobró MENOS que la cota reservada y hay evidencia del
   * monto (p.ej. Videogen falló antes del render pero su base muestra el consumo interno del job). Inserta UN
   * ADJUSTMENT `final` (append-only, `corrects_event_id` = la reserva) que lleva la reserva a `amount`
   * (0 < amount ≤ reservado), con `settlement='reconciled_as_charged_partial'`, el actor, el motivo y la evidencia
   * estructurada en la metadata. Cuenta como «cobrada» para los lectores (`reservationReconciledAsCharged`: la reserva
   * ES la llamada) y para el uso tardío (settleReservation: si llega la medición real del proveedor, gana el real).
   * Mismo lock por clave que las otras conciliaciones. Una reserva ya cerrada (por esta u otra decisión) =
   * `alreadySettled` con `recordedSettlement` y `countedAmount` (nunca se cambia una decisión registrada).
   */
  async reconcileReservationAsChargedPartial(
    reservationKey: string,
    amount: DecimalLike,
    reason: string,
    evidence: ReconcileEvidence,
    opts: { decidedBy?: string; recordedBy?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<{
    reconciled: boolean; alreadySettled: boolean; amount: string; countedAmount: string;
    recordedSettlement: string | null; event: CostEventRow | null;
  }> {
    nonEmpty(reservationKey, 'reservationKey');
    nonEmpty(reason, 'reason');
    const decidedBy = nonEmpty(opts.decidedBy, 'decidedBy');
    const partial = parsePartialAmount(typeof amount === 'string' ? amount : normalizeDecimal(amount));
    const ev = parseReconcileEvidence(evidence);
    assertEvidenceMatchesAmount(partial, ev);
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`select pg_advisory_xact_lock(hashtext($1))`, ['finops:adj:' + reservationKey]);
      const [res] = await manager.query(
        `select id, event_kind, metadata, measurement_status, amount::text as amount from public.generation_cost_events where idempotency_key = $1`,
        [reservationKey],
      );
      if (!res) throw new FinopsError('ORIGINAL_NOT_FOUND', `no existe la reserva ${reservationKey}`);
      if (res.event_kind !== 'CHARGE' || res.metadata?.reservation !== true) {
        throw new FinopsError('INVALID_INPUT', `${reservationKey} no es una reserva de llamada pagada`);
      }
      const reserved = normalizeDecimal(res.amount);
      const adjs = await manager.query(
        `select metadata from public.generation_cost_events
          where corrects_event_id = $1 and event_kind = 'ADJUSTMENT' order by created_at desc, id desc`,
        [res.id],
      );
      if (adjs.length > 0) {
        const [net] = await manager.query(
          `select coalesce(sum(amount),0)::text as t from public.generation_cost_events where id = $1 or corrects_event_id = $1`,
          [res.id],
        );
        const label = (adjs.find((a: any) => typeof a.metadata?.settlement === 'string')?.metadata?.settlement as string | undefined) ?? null;
        return { reconciled: false, alreadySettled: true, amount: reserved, countedAmount: normalizeDecimal(net.t), recordedSettlement: label, event: null };
      }
      if (res.measurement_status !== 'pending') {
        throw new FinopsError('INVALID_INPUT', `${reservationKey} no está pendiente (${String(res.measurement_status)}): no hay nada que conciliar`);
      }
      if (cmpDec(partial, reserved) > 0) {
        throw new FinopsError('INVALID_INPUT', `amount ${partial} supera lo reservado (${reserved}): una conciliación parcial nunca cuenta más que la reserva`);
      }
      const r = await this.adjustWith(manager, reservationKey, partial, reason, {
        recordedBy: opts.recordedBy || 'reconciler',
        settlement: true,
        settlementLabel: 'reconciled_as_charged_partial',
        forceInsert: true,
        metadata: {
          ...(opts.metadata || {}),
          reservationReconciledAsCharged: true,
          reservationReconciledAsPartial: true,
          reservedAmount: reserved,
          countedAmount: partial,
          evidence: ev,
          decidedBy,
        },
      });
      return { reconciled: r.inserted, alreadySettled: false, amount: reserved, countedAmount: partial, recordedSettlement: 'reconciled_as_charged_partial', event: r.event };
    });
  }

  /**
   * r60 fix round (I1): decisión registrada sobre una reserva cerrada — `settlement` del último ADJUSTMENT que la lleva
   * (reconciled_as_charged / _not_charged / _charged_partial, o la liquidación del worker) y el monto que quedó contado
   * (neto de la familia). null si la reserva no existe o sigue abierta.
   */
  async reservationDecisionOf(reservationKey: string): Promise<{ settlement: string | null; countedAmount: string } | null> {
    const [r] = await this.dataSource.query(
      `select (select a.metadata->>'settlement' from public.generation_cost_events a
                where a.corrects_event_id = e.id and a.event_kind = 'ADJUSTMENT' and a.metadata ? 'settlement'
                order by a.created_at desc, a.id desc limit 1) as settlement,
              (select count(*)::int from public.generation_cost_events a where a.corrects_event_id = e.id) as n,
              (select coalesce(sum(x.amount),0)::text from public.generation_cost_events x where x.id = e.id or x.corrects_event_id = e.id) as counted
         from public.generation_cost_events e where e.idempotency_key = $1 and e.event_kind = 'CHARGE'`,
      [reservationKey],
    );
    if (!r || Number(r.n) === 0) return null;
    return { settlement: r.settlement ?? null, countedAmount: normalizeDecimal(r.counted) };
  }

  /** ¿La reserva ya se cerró (liquidada, liberada o conciliada)? null si no existe. */
  async reservationSettled(reservationKey: string): Promise<boolean | null> {
    const [r] = await this.dataSource.query(
      `select exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id) as settled
         from public.generation_cost_events e where e.idempotency_key = $1`,
      [reservationKey],
    );
    return r ? r.settled === true : null;
  }

  /**
   * Piloto #1209 (review I2): reservas del proxy LLM (`reservation:llm-proxy:*`) que siguen PENDIENTES (sin
   * liquidar, liberar ni conciliar): la respuesta se perdió (524 / Worker terminado / stream cortado / 5xx).
   * Cuentan como gasto hasta que un SUPER_ADMIN las concilia contra la consola del proveedor.
   */
  async pendingLlmProxyReservations(filter: { courseId?: number; runId?: string; limit?: number } = {}): Promise<Array<{
    reservationKey: string; callId: string; createdAt: string; ownerId: string | null; courseId: number | null; runId: string | null;
    itemKey: string | null; model: string | null; amount: string; promptChars: number | null; maxTokens: number | null;
  }>> {
    const where: string[] = [`e.idempotency_key like 'reservation:llm-proxy:%'`, `e.event_kind = 'CHARGE'`,
      `not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)`];
    const params: unknown[] = [];
    if (filter.courseId !== undefined) { params.push(filter.courseId); where.push(`e.course_id = $${params.length}`); }
    if (filter.runId !== undefined) {
      if (!UUID_RE.test(filter.runId)) throw new FinopsError('INVALID_INPUT', 'runId debe ser UUID');
      params.push(filter.runId); where.push(`e.run_id = $${params.length}`);
    }
    params.push(Math.min(Math.max(Math.trunc(filter.limit ?? 200), 1), 1000));
    const rows = await this.dataSource.query(
      `select e.idempotency_key, e.created_at, e.owner_id, e.course_id, e.run_id, i.item_key, e.model_or_product, e.amount::text as amount, e.metadata
         from public.generation_cost_events e left join public.generation_item_runs i on i.id = e.item_run_id
        where ${where.join(' and ')} order by e.created_at limit $${params.length}`,
      params,
    );
    return rows.map((r: any) => ({
      reservationKey: r.idempotency_key, callId: String(r.idempotency_key).slice('reservation:llm-proxy:'.length),
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      ownerId: r.owner_id ?? null, courseId: r.course_id ?? null, runId: r.run_id ?? null, itemKey: r.item_key ?? null,
      model: r.model_or_product ?? null, amount: r.amount,
      promptChars: Number.isInteger(r.metadata?.promptChars) ? r.metadata.promptChars : null,
      maxTokens: Number.isInteger(r.metadata?.maxTokens) ? r.metadata.maxTokens : null,
    }));
  }

  /**
   * Loop 4 (review I4): reservas del worker de IA del backend (`reservation:llm:<itemRunId>:…`, callTag `llmw-*`) que
   * siguen PENDIENTES: resultado desconocido (el pedido salió y no volvió nada), worker caído en vuelo o respuesta
   * cuya liquidación falló. Cuentan como gasto hasta que un SUPER_ADMIN las concilia contra la consola del proveedor.
   */
  async pendingLlmWorkerReservations(filter: { courseId?: number; runId?: string; limit?: number } = {}): Promise<Array<{
    reservationKey: string; createdAt: string; ownerId: string | null; courseId: number | null; runId: string | null;
    itemKey: string | null; model: string | null; amount: string; promptChars: number | null; maxTokens: number | null; callTag: string | null;
  }>> {
    // Re-review m2: solo con la parte FUERA de ejecución (sin llamada en vuelo que todavía pueda liquidarse sola).
    const where: string[] = [`e.idempotency_key like 'reservation:llm:%'`, `(e.metadata->>'callTag') like 'llmw-%'`, `e.event_kind = 'CHARGE'`,
      `(e.metadata->>'reservation') = 'true'`, `not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)`,
      `coalesce(i.status, '') <> 'running'`];
    const params: unknown[] = [];
    if (filter.courseId !== undefined) { params.push(filter.courseId); where.push(`e.course_id = $${params.length}`); }
    if (filter.runId !== undefined) {
      if (!UUID_RE.test(filter.runId)) throw new FinopsError('INVALID_INPUT', 'runId debe ser UUID');
      params.push(filter.runId); where.push(`e.run_id = $${params.length}`);
    }
    params.push(Math.min(Math.max(Math.trunc(filter.limit ?? 200), 1), 1000));
    const rows = await this.dataSource.query(
      `select e.idempotency_key, e.created_at, e.owner_id, e.course_id, e.run_id, i.item_key, e.model_or_product, e.amount::text as amount, e.metadata
         from public.generation_cost_events e left join public.generation_item_runs i on i.id = e.item_run_id
        where ${where.join(' and ')} order by e.created_at limit $${params.length}`,
      params,
    );
    return rows.map((r: any) => ({
      reservationKey: r.idempotency_key,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      ownerId: r.owner_id ?? null, courseId: r.course_id ?? null, runId: r.run_id ?? null, itemKey: r.item_key ?? null,
      model: r.model_or_product ?? null, amount: r.amount,
      promptChars: Number.isInteger(r.metadata?.promptChars) ? r.metadata.promptChars : null,
      maxTokens: Number.isInteger(r.metadata?.maxTokens) ? r.metadata.maxTokens : null,
      callTag: typeof r.metadata?.callTag === 'string' ? r.metadata.callTag : null,
    }));
  }

  /** ¿Es una reserva del worker de IA, y su parte ya no está en ejecución? Solo esas se concilian por el endpoint del worker. */
  async isLlmWorkerReservation(reservationKey: string): Promise<'ok' | 'not_worker' | 'item_running'> {
    const [r] = await this.dataSource.query(
      `select coalesce(i.status, '') as item_status from public.generation_cost_events e
         left join public.generation_item_runs i on i.id = e.item_run_id
        where e.idempotency_key = $1 and e.event_kind = 'CHARGE'
          and (e.metadata->>'reservation') = 'true' and (e.metadata->>'callTag') like 'llmw-%'`,
      [reservationKey],
    );
    if (!r) return 'not_worker';
    return r.item_status === 'running' ? 'item_running' : 'ok';
  }

  /**
   * r59: reservas de TTS de OpenAI (`reservation:tts:<itemRunId>:…`) que siguen PENDIENTES (timeout del cliente, worker
   * caído en vuelo o liquidación fallida). Cuentan como gasto hasta que un SUPER_ADMIN las concilia contra la consola.
   */
  async pendingTtsReservations(filter: { courseId?: number; runId?: string; limit?: number } = {}): Promise<Array<{
    reservationKey: string; createdAt: string; ownerId: string | null; courseId: number | null; runId: string | null;
    itemKey: string | null; model: string | null; amount: string; characters: number | null;
  }>> {
    const where: string[] = [`e.idempotency_key like 'reservation:tts:%'`, `e.event_kind = 'CHARGE'`, `(e.metadata->>'reservation') = 'true'`,
      `not exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id)`,
      `coalesce(i.status, '') not in ('running', 'claimed')`];
    const params: unknown[] = [];
    if (filter.courseId !== undefined) { params.push(filter.courseId); where.push(`e.course_id = $${params.length}`); }
    if (filter.runId !== undefined) {
      if (!UUID_RE.test(filter.runId)) throw new FinopsError('INVALID_INPUT', 'runId debe ser UUID');
      params.push(filter.runId); where.push(`e.run_id = $${params.length}`);
    }
    params.push(Math.min(Math.max(Math.trunc(filter.limit ?? 200), 1), 1000));
    const rows = await this.dataSource.query(
      `select e.idempotency_key, e.created_at, e.owner_id, e.course_id, e.run_id, i.item_key, e.model_or_product, e.amount::text as amount, e.metadata
         from public.generation_cost_events e left join public.generation_item_runs i on i.id = e.item_run_id
        where ${where.join(' and ')} order by e.created_at limit $${params.length}`,
      params,
    );
    return rows.map((r: any) => ({
      reservationKey: r.idempotency_key,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      ownerId: r.owner_id ?? null, courseId: r.course_id ?? null, runId: r.run_id ?? null, itemKey: r.item_key ?? null,
      model: r.model_or_product ?? null, amount: r.amount,
      characters: Number.isInteger(r.metadata?.characters) ? r.metadata.characters : null,
    }));
  }

  /**
   * r59: ¿es una reserva de TTS (CHARGE con `reservation: true`), y su parte ya no está en ejecución? Solo esas se
   * concilian por el endpoint de TTS. Una ya liquidada pasa ('ok'): la conciliación responde no-op (`alreadySettled`).
   */
  async isTtsReservation(reservationKey: string): Promise<'ok' | 'not_tts' | 'item_running'> {
    if (!TTS_RESERVATION_KEY_RE.test(reservationKey)) return 'not_tts';
    const [r] = await this.dataSource.query(
      `select coalesce(i.status, '') as item_status from public.generation_cost_events e
         left join public.generation_item_runs i on i.id = e.item_run_id
        where e.idempotency_key = $1 and e.event_kind = 'CHARGE' and (e.metadata->>'reservation') = 'true'`,
      [reservationKey],
    );
    return ttsReservationCheckOf(r ?? null);
  }

  /**
   * Cargos REALES (no mock) de un item run, con su intento: reservas (liquidadas o no)
   * y cargos finales. Un re-claim los usa para no volver a pagar una operación cuyo
   * resultado no quedó persistido (detección durable, no depende de la memoria del worker).
   */
  async itemPaidCharges(itemRunId: string): Promise<ItemPaidCharge[]> {
    if (typeof itemRunId !== 'string' || !UUID_RE.test(itemRunId)) throw new FinopsError('INVALID_INPUT', 'itemRunId debe ser UUID');
    const rows = await this.dataSource.query(
      `select e.idempotency_key, e.attempt, e.provider, e.external_operation_id, e.measurement_status, e.created_at,
              coalesce((e.metadata->>'reservation') = 'true', false) as reservation,
              coalesce((e.metadata->>'sendMarked') = 'true', false) as send_marked,
              exists (select 1 from public.generation_cost_events a where a.corrects_event_id = e.id) as settled
         from public.generation_cost_events e
        where e.item_run_id = $1 and e.event_kind = 'CHARGE' and e.billing_account <> 'mock'
        order by e.created_at, e.idempotency_key`,
      [itemRunId],
    );
    return rows.map((r: any) => ({ ...r, attempt: Number(r.attempt), reservation: !!r.reservation, settled: !!r.settled, send_marked: !!r.send_marked }));
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
    // FinOps atómico (review M2): una autorización de un run se serializa con sus reservas (mismo lock del run): una
    // reserva concurrente ve la autorización anterior o la nueva, nunca una mezcla (p.ej. un BLOCKED a mitad).
    if (input.runId) {
      if (runner === this.dataSource) return this.dataSource.transaction((m) => this.authorize(input, m));
      await runner.query(`select pg_advisory_xact_lock(hashtext($1))`, [RUN_CAP_LOCK_PREFIX + input.runId]);
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
    const where = `e.course_id = $1`;
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
    // FinOps P0: dinero oficial (definiciones fijas de CostReadService); el resto queda por compatibilidad.
    const money = await this.costRead.courseCost(courseId);
    return { courseId, ...totals, byChapter, byItemType, byProvider, retriesPaid: retries, avoided: avoided[0], estimatedVsActual: runs, money };
  }

  async costsByRun(runId: string) {
    if (!UUID_RE.test(runId)) throw new FinopsError('INVALID_INPUT', 'runId debe ser UUID');
    const where = `e.run_id = $1`;
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
    const money = await this.costRead.runCost(runId);
    return { runId, ...totals, byItemKey, byItemType, byProvider, retriesPaid: retries, avoided: avoided[0], estimatedVsActual: evsa[0] ?? null, authorizations: auths, money };
  }

  async costsByOwner(ownerId: string) {
    const where = `e.owner_id = $1`;
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

  /**
   * FinOps P0: totales de las lecturas admin `/finops/{courses,runs,owners}/:id/costs` con las MISMAS banderas que
   * CostReadService (costEventsCte). Cambios (audit §4 #10): `total`/`pending` excluyen BYOK (`user_key`, igual que el
   * tope del run; BYOK va en `byok`); `charges`/`adjustments` excluyen las familias de reserva reemplazadas (una
   * reserva liquidada y su ajuste a 0 netean 0: contarlas inflaba `charges` con reserva + cargo final). Sigue
   * valiendo total = charges + adjustments + refunds. El dinero oficial de la respuesta está en `money`.
   */
  private async totalsQuery(where: string, params: unknown[]) {
    const [t] = await this.dataSource.query(
      `with ${costEventsCte(where)}
       select coalesce(sum(amount) filter (where billing_account <> 'user_key'),0)::text as total,
              coalesce(sum(amount) filter (where billing_account = 'cursia'),0)::text as billable,
              coalesce(sum(amount) filter (where event_kind='CHARGE' and billing_account <> 'user_key' and not in_dropped_family),0)::text as charges,
              coalesce(sum(amount) filter (where event_kind='ADJUSTMENT' and billing_account <> 'user_key' and not in_dropped_family),0)::text as adjustments,
              coalesce(sum(amount) filter (where event_kind='REFUND' and billing_account <> 'user_key'),0)::text as refunds,
              -- RF-b fix M5: pendiente = CHARGE pendiente SIN un ADJUSTMENT que lo corrija.
              coalesce(sum(amount) filter (where is_open and billing_account <> 'user_key'),0)::text as pending,
              count(*) filter (where is_open and billing_account <> 'user_key')::int as pending_events,
              coalesce(sum(amount) filter (where billing_account = 'user_key'),0)::text as byok,
              count(*)::int as events
         from ev`,
      params,
    );
    return { totals: t };
  }

  private async groupQuery(column: 'chapter_id' | 'item_type' | 'provider' | 'item_key' | 'course_id', where: string, params: unknown[]) {
    const rows = await this.dataSource.query(
      `select e.${column}::text as key, coalesce(sum(e.amount) filter (where e.billing_account <> 'user_key'),0)::text as total, count(*)::int as events
         from public.generation_cost_events e where ${where}
        group by e.${column} order by e.${column} nulls last`,
      params,
    );
    return rows;
  }

  /** FinOps P0: reintentos PAGADOS = llamadas (reserva + cargo final cuentan una vez) con call_role<>'main' o attempt>1; monto neto. */
  private async retriesQuery(where: string, params: unknown[]) {
    const [r] = await this.dataSource.query(
      `with ${costEventsCte(where)}
       select coalesce(sum(amount) filter (where is_retry and billing_account <> 'user_key'),0)::text as total,
              count(*) filter (where is_retry and is_call and billing_account <> 'user_key')::int as events
         from ev`,
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
         select run_id, coalesce(sum(amount) filter (where billing_account <> 'user_key'),0)::text as actual
           from public.generation_cost_events where run_id in (select run_id from runs) group by run_id
       )
       select runs.run_id, est.estimate_id, est.est_min, est.est_expected, est.est_max, coalesce(act.actual,'0') as actual
         from runs left join est using (run_id) left join act using (run_id)
        order by runs.run_id`,
      params,
    );
  }
}


/** Lock consultivo por run de las reservas (FinOps atómico). */
export const RUN_CAP_LOCK_PREFIX = 'finops:run-cap:';
/** r58: lock consultivo (global) del techo de gasto sin atribuir. */
export const UNATTRIBUTED_CEILING_LOCK = 'finops:unattributed-ceiling';

/**
 * r58 (AU3 §H4.4–5): kill switch + allow-list de proveedores en el punto de RESERVA (toda llamada pagada por Cursia del
 * pipeline reserva antes de llamar). Solo reservas reales de Cursia: un cargo posterior (dinero ya gastado), BYOK o mock
 * nunca se rechazan acá.
 */
function assertReservationSpendAllowed(input: RecordChargeInput): void {
  if (!input || input.billingAccount !== 'cursia' || input.mode !== 'real') return;
  if ((input.metadata as Record<string, unknown> | undefined)?.reservation !== true) return;
  assertProviderSpendAllowed(input.provider);
}

/** ¿Reserva pagada por Cursia sin run ni curso (sujeta al techo de gasto sin atribuir)? */
export function isUnattributedPaidReservation(row: Record<string, unknown>): boolean {
  const md = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>;
  return md.reservation === true && row.event_kind === 'CHARGE' && !row.run_id && (row.course_id === null || row.course_id === undefined)
    && row.billing_account === 'cursia' && row.cost_source !== 'MOCK';
}

/**
 * r58 H4: reserva pagada (Cursia, no mock, no BYOK) de un run que NO tiene ninguna fila en cost_budget_authorizations.
 * Antes pasaba sin tope («runs previos a FinOps»); ahora se rechaza ANTES de reservar (el llamador no llama al proveedor).
 */
export function runBudgetNotAuthorizedError(runId: string, amount: string): FinopsError {
  return new FinopsError('RUN_BUDGET_NOT_AUTHORIZED',
    `el run ${runId} no tiene un presupuesto autorizado (ninguna autorización registrada): no se reserva ni se llama al proveedor (USD ${usd2(amount)}). Un administrador tiene que autorizar el presupuesto del run (POST /finops/courses/:courseId/authorizations con runId) antes de reanudar`,
    { runId, amount, authorizedBudget: null });
}

/** r75: ¿reserva pagada por Cursia (real, no BYOK ni mock) SIN run? (sujeta al disponible del usuario). */
export function isNoRunPaidReservation(row: Record<string, unknown>): boolean {
  const md = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>;
  return md.reservation === true && row.event_kind === 'CHARGE' && !row.run_id && row.billing_account === 'cursia' && row.cost_source !== 'MOCK';
}

/** ¿Esta fila es una reserva pagada por Cursia de un run (sujeta al tope atómico del run)? */
export function isRunCapReservation(row: Record<string, unknown>): boolean {
  const md = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>;
  return md.reservation === true && row.event_kind === 'CHARGE' && typeof row.run_id === 'string' && !!row.run_id &&
    row.billing_account !== 'user_key' && row.billing_account !== 'mock';
}
