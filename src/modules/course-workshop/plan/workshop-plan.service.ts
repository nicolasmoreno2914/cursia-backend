import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional, ServiceUnavailableException } from '@nestjs/common';
import { isCourseWorkshopEnabled } from '../../features/course-workshop-flag';
import { createHash, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { returningRows } from '../../../common/db/returning-rows';
import { ArtifactsService, assertWritableStoragePath } from '../../artifacts/artifacts.service';
import { FinopsLedgerService, RecordChargeInput } from '../../finops/finops-ledger.service';
import { FinopsBudgetService } from '../../finops/finops-budget.service';
import { assertDirectCallAllowed, directAnthropicChargeInput } from '../../finops/direct-call-ledger';
import { cmpDec } from '../../finops/decimal';
import { loadDryRunPricing } from '../../finops/dry-run-pricing';
import type { DryRunPricing } from '../../pedagogy/dry-run';
import { readDocument, DocumentReadError } from '../../academic-context';
import { isUuid } from '../../authz/schema-probe';
import { isMbzReaderError } from '../mbz-reader';
import { CourseWorkshopService, MemoryWaitTimeoutError, WORKSHOP_BUCKET, WORKSHOP_ERRORS, WorkshopActor, WorkshopPlanSession, diagnosisMemoryFactor } from '../course-workshop.service';
import { DIAGNOSIS_CODE_VERSION, DiagnosisReport } from '../diagnosis/diagnose';
import { QUALITY_CODE_VERSION } from '../quality/types';
import type { Finding } from '../diagnosis/finding';
import type { WorkshopCourse } from '../course-model';
import { AnthropicWorkshopAiClient, WORKSHOP_AI_CLIENT, WORKSHOP_AI_TIMEOUT_MS, WorkshopAiClient, WorkshopAiResult, workshopModel } from './ai';
import {
  AiCall, AiInvoke, AiUnavailableError, BuildCtx, PlannedCall, PreparedItem, answerAndResolve, callBoundUsd, capDecision, combinedDryRun, estimateContent, estimateInterpretation,
  estimateItemView, estimateReinterpretation, interpretText, openBuildCtx, prepareItem, proposedCapOf,
} from './builder';
import { ModelUnpricedError, WorkshopPricing, assertModelPriced, modelOf, planTotals, priceMeasured } from './cost';
import { ApprovalCall, callErrorOutcome, closeReservation, committedUsd } from './approval-ledger';
import { requestFromFinding } from './from-finding';
import { AnswerError, checkAnswers, isDeterministicAnswer, resolveRequest } from './interpret';
import { planWarnings } from './risk';
import { itemContentHash, planContentHash, selectApplyItems } from '../apply/apply-core';
import { ModuleRef } from '@nestjs/core';
import { decideRunSpend } from '../../finops/run-spend-guard';
import { effectiveOutputRowsSql } from '../../dynamic-generation/item-generations';
import { PaidCallGate, PaidCallTicket, RegenProviders } from '../regenerate/ports';
import { STRUCTURAL_COMBINATION, STRUCTURAL_COMBINATION_MESSAGE, isStructuralOperation, removesTemplate, structuralLast, templateRemovalMessage } from '../apply/apply-core';
import { PROVIDER_OVER_BOUND, RegenDeferred, RegenError, RegenExternal, RegenPrior, RegenerateOp, isPaidOperation, isRegenOperation } from '../regenerate/types';
import { WaitTimeout, gammaFinal, pollUntilFinal, settleGammaGeneration, settleVideogenJob, videogenFinal } from '../regenerate/async-wait';
import { RegenDbSources } from '../regenerate/sources';
import { decodeProduced, encodeProduced, sha256Hex } from '../regenerate/bundle';
import { realRegenProviders } from '../regenerate/real-providers';
import { prepareRegenItem } from './builder';
import { resolveTtsModel } from '../../../tts/tts-models';
import { REGEN_RESULT_TYPE, RegenResultRef, loadRegenResult, resolveRegenParams, storeRegenResult } from '../regenerate/store';
import { libroV3ResolverOf } from '../apply/libro-v3';
import { YoutubeService } from '../../../youtube/youtube.service';
import { YoutubeUploadService } from '../../../youtube/youtube-upload.service';
import { loadPackagingProfilesV3 } from '../../dynamic-packaging/packaging-v3';
import { gammaThemeFor } from '../../../package/presentation';
import {
  ClarifyAnswer, DOCUMENT_EXTENSIONS, InterpretedRequest, IntakeSource, LATER_OPERATIONS, MisalignmentWarning, PLAN_CODE_VERSION, PLAN_LIMITS, PlanItemView, RequestStatus,
} from './types';

/**
 * r107 B5 · Taller de cursos — pedidos, preguntas y plan (diseño §4 «requests» / «clarify» / «plan», D5–D9).
 *
 * RONDA DE DECISIONES (controlador): el gasto de IA se APRUEBA ANTES de que ocurra (D8 costo siempre visible, D9 tope
 * aprobado antes de gastar). Ninguna llamada a la IA sin una aprobación con su tope:
 *   (a) crear una entrada (texto o documento) NO llama a la IA: queda `awaiting_confirmation` con el costo ESTIMADO de
 *       interpretarla y el tope propuesto (estimado + margen); `POST …/intakes/:id/interpret {confirmEstimateUsd, capUsd}`
 *       la aprueba y recién entonces corre. Igual una respuesta que vuelve a la IA (`POST …/requests/:id/interpret`).
 *   (b) el plan lista primero los ítems con su costo estimado de generación y SIN contenido (etapa `estimate`);
 *       `POST …/plans/:planId/generate {itemIds, capUsd, confirmEstimateUsd}` aprueba generar el antes/después de esos.
 *       Lo que no necesita IA (quitar, colores, enlaces rotos, «Arreglar esto» determinista) se prepara sin aprobación.
 *   (c) aplicar (B6) los ítems de la Fase 2 ya no usa IA.
 * Cada aprobación RESERVA su tope de una vez en el ledger de FinOps (CHARGE `pending` con `metadata.reservation`, el
 * mismo mecanismo de las llamadas pagadas sin run: con presupuestos por usuario, el ledger lo inserta solo si entra en el
 * disponible, bajo el lock del usuario). Si la reserva falla, no se llama a nada. Antes de CADA llamada: gastado + cota
 * de esa llamada ≤ tope aprobado (regla 1 de run-spend-guard); si no entra, se corta limpio ANTES de llamar, lo hecho
 * queda hecho y lo que faltó queda visible con el motivo. Al terminar (bien, cortado o con error) la reserva se
 * libera (`settleReservation`) y quedan los cargos reales de cada llamada (con `approvalId`).
 *
 * Compuertas: las de B1 (flag + `loadForActor`: ajeno → 404; SuperAdmin; miembro con permiso en enforce). Pedir /
 * aprobar / responder / editar el plan = `courses.edit`; ver = `courses.view`. Nada sale de las actividades de ESTA sesión.
 */

export const PLAN_ERRORS = Object.freeze({
  TEXT_EMPTY: 'WORKSHOP_REQUEST_TEXT_EMPTY',
  TEXT_TOO_LONG: 'WORKSHOP_REQUEST_TEXT_TOO_LONG',
  DOCUMENT_INVALID: 'WORKSHOP_DOCUMENT_INVALID',
  DOCUMENT_TOO_LARGE: 'WORKSHOP_DOCUMENT_TOO_LARGE',
  DOCUMENT_NOT_UPLOADED: 'WORKSHOP_DOCUMENT_NOT_UPLOADED',
  DOCUMENT_UNREADABLE: 'WORKSHOP_DOCUMENT_UNREADABLE',
  INVENTORY_NOT_READY: 'WORKSHOP_INVENTORY_NOT_READY',
  INTERPRETATION_FAILED: 'WORKSHOP_INTERPRETATION_FAILED',
  INTERRUPTED: 'WORKSHOP_REQUEST_INTERRUPTED',
  NOT_WAITING: 'WORKSHOP_REQUEST_NOT_WAITING',
  NOT_AWAITING_CONFIRMATION: 'WORKSHOP_NOT_AWAITING_CONFIRMATION',
  ESTIMATE_MISMATCH: 'WORKSHOP_ESTIMATE_MISMATCH',
  CAP_INVALID: 'WORKSHOP_CAP_INVALID',
  CAP_BELOW_ESTIMATE: 'WORKSHOP_CAP_BELOW_ESTIMATE',
  CAP_BELOW_CALL_BOUND: 'WORKSHOP_CAP_BELOW_CALL_BOUND',
  CAP_REACHED: 'WORKSHOP_CAP_REACHED',
  RESERVATION_FAILED: 'WORKSHOP_RESERVATION_FAILED',
  FINOPS_UNAVAILABLE: 'WORKSHOP_FINOPS_UNAVAILABLE',
  ITEMS_INVALID: 'WORKSHOP_GENERATE_ITEMS_INVALID',
  MODEL_UNPRICED: 'WORKSHOP_MODEL_UNPRICED',
  CALL_AMBIGUOUS: 'WORKSHOP_AI_CALL_AMBIGUOUS',
  ROUNDS_EXHAUSTED: 'WORKSHOP_REQUEST_ROUNDS_EXHAUSTED',
  DIAGNOSIS_NOT_READY: 'WORKSHOP_DIAGNOSIS_NOT_READY',
  FINDING_NOT_FOUND: 'WORKSHOP_FINDING_NOT_FOUND',
  WARNING_NOT_ADDABLE: 'WORKSHOP_WARNING_NOT_ADDABLE',
  PREPARE_FAILED: 'WORKSHOP_PLAN_ITEM_FAILED',
  AI_UNAVAILABLE: 'WORKSHOP_AI_UNAVAILABLE',
  USER_BUDGET_INSUFFICIENT: 'USER_BUDGET_INSUFFICIENT',
  PLAN_APPLYING: 'WORKSHOP_PLAN_APPLYING',
  PLAN_APPLIED: 'WORKSHOP_PLAN_APPLIED',
  /** r107 B10: un proveedor de la regeneración está apagado (kill switch / allow-list): no se reserva ni se llama. */
  PROVIDER_UNAVAILABLE: 'WORKSHOP_PROVIDER_UNAVAILABLE',
  /** r107 B10: el resultado producido de una regeneración no está (o no coincide con su huella). */
  REGEN_RESULT_MISSING: 'WORKSHOP_REGEN_RESULT_MISSING',
  /** r107 B10 fix round 1 (P1-2c): lo medido de una llamada superó su cota (incidente; se cortan las que faltan). */
  PROVIDER_OVER_BOUND: 'WORKSHOP_PROVIDER_OVER_BOUND',
  /** r107 B10 fix round 1 (P1-5): el ítem espera a un proveedor o tiene una llamada ambigua sin conciliar: no se re-aprueba. */
  REGEN_PENDING_PROVIDER: 'WORKSHOP_REGEN_PENDING_PROVIDER',
});

/**
 * Una entrada / pedido / aprobación en curso SIN reclamo (filas anteriores a B6) más vieja que esto se da por interrumpida.
 * r107 B6 (requisito de B5): con reclamo `<arranque>.<uuid>` + latido, una fila de OTRO arranque se da por interrumpida
 * recién cuando deja de latir PLAN_HEARTBEAT_STALE_MS (3 latidos); la de ESTE arranque, cuando ya no la tiene ningún
 * trabajo vivo. Así un trabajo largo de otro proceso nunca se corta a los 15 min, y uno muerto se ve en ~30 s.
 */
export const PLAN_STALE_MS = 15 * 60_000;
export const PLAN_HEARTBEAT_MS = 10_000;
export const PLAN_HEARTBEAT_STALE_MS = 3 * PLAN_HEARTBEAT_MS;
/** Fix round 1 (P2-1): barrido de B5 en cada proceso de la API con el flag encendido. */
export const PLAN_SWEEP_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000;

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> };
const iso = (d: Date | string | null) => (d === null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const usd = (v: unknown) => (v === null || v === undefined ? '0' : String(v));
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

interface IntakeRow { id: string; session_id: string; original_sha1: string; created_by: string; source: IntakeSource; status: string; filename: string | null; media_type: string | null; storage_path: string | null; declared_bytes: string | null; text: string | null; error: any; notes: any; estimate: any; approval_id: string | null; spent_usd: string; ai_calls: number; claim_id: string | null; created_at: Date; updated_at: Date }
interface RequestRow { id: string; session_id: string; intake_id: string; ordinal: number; finding_id: string | null; quote: string; instruction: string; operation: string | null; status: RequestStatus; target: any; raw_target: any; details: any; questions: any; answers: any; rounds: number; reason: string | null; estimate: any; spent_usd: string; ai_calls: number; claim_id: string | null; created_at: Date; updated_at: Date }
interface ItemRow { id: string; plan_id: string; request_id: string; status: 'proposed' | 'removed'; stage: 'estimate' | 'ready'; operation: string; available: boolean; params: any; view: PlanItemView; risk_level: string; spent_usd: string; apply_expected_usd: string; created_at: Date; updated_at: Date }
export interface ApprovalRow { id: string; session_id: string; created_by: string; kind: 'interpret' | 'reinterpret' | 'generate' | 'quality' | 'question'; intake_id: string | null; request_id: string | null; item_ids: string[]; estimate: any; cap_usd: string; spent_usd: string; ai_calls: number; reservation_key: string | null; calls: Record<string, ApprovalCall>; status: string; stop_reason: string | null; created_at: Date; updated_at: Date }

/**
 * Centavos de un monto USD redondeado half-up a 0,01, EXACTO sobre el decimal (sin aritmética binaria): «0.0578772000» → 6,
 * «0.125» → 13. null si no es un monto ≥ 0.
 */
export function centsHalfUp(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  const str = typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v.trim()) ? v.trim() : n.toFixed(10);
  const [i, f = ''] = str.split('.');
  const frac = (f + '000').slice(0, 3);
  return Number(i) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
}

/** Estimado de una aprobación (lo que el docente ve y confirma). */
export interface ApprovalEstimate { calls: PlannedCall[]; expectedUsd: string; boundUsd: string; proposedCapUsd: string; note: string }

type Job =
  | { kind: 'extract'; sessionId: string; intakeId: string }
  | { kind: 'interpret'; sessionId: string; intakeId: string; approvalId: string }
  | { kind: 'reinterpret'; sessionId: string; requestId: string; approvalId: string }
  | { kind: 'stage'; sessionId: string; requestId: string }
  | { kind: 'generate'; sessionId: string; approvalId: string }
  /** r107 B10 fix round 1 (P1-3): el proveedor asíncrono terminó (y se liquidó): seguir la regeneración en el carril. */
  | { kind: 'regen_resume'; sessionId: string; approvalId: string; requestId: string }
  | { kind: 'combined'; sessionId: string };

/** Operación del ledger de FinOps por propósito de la llamada (r107 B8: + calidad y preguntas puntuales). */
export const WORKSHOP_CHARGE_OPERATIONS = Object.freeze({
  interpret: 'llm.workshop_interpret', content: 'llm.workshop_content', quality: 'llm.workshop_quality', question: 'llm.workshop_question',
} as const);

/** Entrada del ledger de FinOps de una llamada del Taller (pura: la prueba la verifica real y simulada). */
export function workshopChargeInput(a: { payer: string; courseId: number | null; result: WorkshopAiResult; purpose: 'interpret' | 'content' | 'quality' | 'question'; metadata: Record<string, unknown> }): RecordChargeInput | null {
  const base = directAnthropicChargeInput({
    ownerId: a.payer, model: a.result.model, messageId: a.result.messageId, usage: a.result.usage,
    operation: WORKSHOP_CHARGE_OPERATIONS[a.purpose], recordedBy: 'course-workshop',
    courseId: a.courseId, unattributedReason: 'course_workshop', metadata: { kind: 'course_workshop', ...a.metadata },
  });
  if (!base) return null;
  // Las respuestas SIMULADAS (pruebas) nunca se registran como gasto real.
  return a.result.simulated ? { ...base, mode: 'mock', billingAccount: 'mock', metadata: { ...(base.metadata ?? {}), simulated: true } } : base;
}

/** Reserva del TOPE aprobado (CHARGE `pending` + `metadata.reservation`): el mismo protocolo de las llamadas pagadas sin run. */
export function approvalReservationInput(a: { approvalId: string; payer: string; courseId: number | null; capUsd: string; kind: string; simulated: boolean }): RecordChargeInput {
  return {
    ownerIdFromAuth: a.payer, attributionCourseId: a.courseId, unattributedReason: 'course_workshop',
    provider: 'anthropic', service: 'messages', modelOrProduct: workshopModel(), operation: 'llm.workshop_approval',
    usage: {}, usageUnit: 'output_tokens', externalOperationId: null, idempotencyKey: `workshop:approval:${a.approvalId}`,
    callRole: 'main', attempt: 1, billingAccount: a.simulated ? 'mock' : 'cursia', mode: a.simulated ? 'mock' : 'real',
    costSource: 'CALCULATED_FROM_USAGE', providerCalculatedAmount: a.capUsd, measurementStatus: 'pending', recordedBy: 'course-workshop',
    metadata: { reservation: true, reservedBeforeCall: true, approvalId: a.approvalId, approvalKind: a.kind, kind: 'course_workshop', serverSide: true },
  };
}

/**
 * r107 B10: proveedores de la regeneración (Fase 3). Inyectable (las pruebas cablean SIMULADOS); por defecto, los reales
 * con los clientes existentes (`realRegenProviders`).
 */
export const WORKSHOP_REGEN_PROVIDERS = 'WORKSHOP_REGEN_PROVIDERS';
/**
 * P1-2a (B10) / B11: un ítem pagado (rehacer una actividad, agregar capítulo / módulo) se aprueba solo con tope ≥ Σ cotas
 * de TODAS sus llamadas (no ≥ el esperado). Puro: lo usan `approveGeneration` y los checks.
 */
export function paidBoundSum(calls: Array<unknown>): number {
  return calls.reduce<number>((acc, c) => acc + Number((c as any)?.regen?.totalBoundUsd ?? 0), 0);
}
export function capBelowPaidBound(cap: string | number, bound: number): boolean {
  return Number(cap) + 1e-9 < bound;
}

/** r107 B11: clave del destino de lo pagado (moduleid de la actividad que se rehace, o el módulo / curso al agregar). */
export function regenTargetKey(req: { operation: string | null; target: unknown; details?: unknown }): string {
  const t = (req.target ?? {}) as Record<string, unknown>;
  // P2-5: lo pagado se reusa solo para el MISMO pedido (módulo, posición, títulos y piezas omitidas).
  const d = (req.details ?? {}) as { position?: number | null; moduleTitle?: string | null; newChapters?: Array<{ title: string }> | null; omit?: string[] | null };
  const tail = `titles:${JSON.stringify((d.newChapters ?? []).map((c) => c.title))}:omit:${[...(d.omit ?? [])].sort().join(',')}`;
  if (req.operation === 'add_chapter') return `module:${t.moduleNumber ?? ''}:pos:${d.position ?? ''}:${tail}`;
  if (req.operation === 'add_module') return `course:module:${d.moduleTitle ?? ''}:${tail}`;
  return String(t.moduleId ?? '');
}

export type RegenProvidersFactory = (s: WorkshopPlanSession, payer: string) => Promise<RegenProviders> | RegenProviders;
/** Memoria extra de un trabajo que produce regeneraciones (audiolibro completo, video, PDF de Gamma en memoria). */
export const REGEN_MEMORY_EXTRA_BYTES = 256 * 1024 * 1024;
/** Compuerta de una regeneración en el servicio: + lo gastado acá y la reanudación de una llamada aceptada (espera). */
export type RegenGate = PaidCallGate & { spent(): string; resume(callId: string): Promise<PaidCallTicket> };
/** P1-3: espera de un proveedor asíncrono guardada en el pedido (`details.regenPending`): reanudable entre procesos. */
export interface RegenWait { approvalId: string; reservationKey?: string | null; itemId: string; provider: 'videogen' | 'gamma'; externalId: string; callId: string; startedAt: string; deadlineAt: string }
class WaitLost extends Error {}

/**
 * r107 B12 (G1): conjunto con CONTEO de referencias — `add` suma, `delete` resta y la clave sale recién en 0. Misma forma
 * que un Set para quien lo lee (`has`, `size`, iterable, `clear`).
 */
export class RefSet implements Iterable<string> {
  private readonly m = new Map<string, number>();
  add(k: string): this { this.m.set(k, (this.m.get(k) ?? 0) + 1); return this; }
  delete(k: string): boolean { const n = this.m.get(k); if (!n) return false; if (n <= 1) this.m.delete(k); else this.m.set(k, n - 1); return true; }
  has(k: string): boolean { return this.m.has(k); }
  count(k: string): number { return this.m.get(k) ?? 0; }
  clear(): void { this.m.clear(); }
  get size(): number { return this.m.size; }
  [Symbol.iterator](): Iterator<string> { return this.m.keys(); }
}

@Injectable()
export class WorkshopPlanService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkshopPlanService.name);
  private readonly client: WorkshopAiClient & { simulated?: boolean };
  /** Precios del estimator (catálogo de la base o el seed). Reemplazable en pruebas. */
  pricingLoader: () => Promise<DryRunPricing> = () => loadDryRunPricing(this.dataSource);

  /**
   * Fix round 1 (P2-1): precios + el modelo REAL del Taller (`WORKSHOP_AI_MODEL`, fijado por Cursia). Si el catálogo no
   * tiene precio para ese modelo, falla cerrado: 503 WORKSHOP_MODEL_UNPRICED y no se estima, reserva ni llama.
   */
  async pricing(): Promise<WorkshopPricing> {
    const p: WorkshopPricing = { ...(await this.pricingLoader()), model: workshopModel() };
    try {
      assertModelPriced(p);
    } catch (e) {
      if (e instanceof ModelUnpricedError) throw new ServiceUnavailableException({ code: PLAN_ERRORS.MODEL_UNPRICED, message: e.message, model: e.model });
      throw e;
    }
    return p;
  }
  /** Trabajos de este proceso (las pruebas los esperan). */
  readonly inFlight = new Map<string, Promise<void>>();
  /** Llamadas efectivas al cliente de IA de este proceso (las pruebas lo leen). */
  aiCalls = 0;
  private readonly queue: Array<{ job: Job; done: () => void; stamped: Promise<void>; claimId: string }> = [];
  private laneBusy = false;
  /**
   * Entradas / pedidos / aprobaciones con trabajo en cola o corriendo en ESTE proceso. r107 B12 (G1): con CONTEO de
   * referencias — una espera que encola su reanudación, o un `generate` que termina con la reanudación ya en cola, ya no
   * borran la marca que el otro sigue necesitando.
   */
  private readonly activeIds = new RefSet();
  /** r107 B6: reclamos de este proceso que se laten (trabajos en cola o corriendo). B12 (G1): con conteo de referencias. */
  private readonly beating = new RefSet();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly artifacts: ArtifactsService,
    private readonly workshop: CourseWorkshopService,
    @Optional() private readonly ledger?: FinopsLedgerService,
    @Optional() private readonly finopsBudget?: FinopsBudgetService,
    @Optional() @Inject(WORKSHOP_AI_CLIENT) client?: WorkshopAiClient,
    @Optional() @Inject(WORKSHOP_REGEN_PROVIDERS) regenProviders?: RegenProvidersFactory,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    this.client = client || new AnthropicWorkshopAiClient();
    this.regenProviders = regenProviders || ((s, payer) => this.defaultRegenProviders(s, payer));
  }

  /** r107 B10: fábrica de proveedores de la regeneración (reemplazable en pruebas). */
  regenProviders: RegenProvidersFactory;
  /** r107 B10: llamadas a proveedores hechas por regeneraciones en este proceso (las pruebas lo leen). */
  readonly providerCalls: Record<string, number> = {};

  // ── utilidades ──

  private async q<T = any>(m: Q, sql: string, params: unknown[] = []): Promise<T> {
    try {
      return await m.query(sql, params);
    } catch (err) {
      if ((err as { code?: string })?.code === '42P01' || (err as { code?: string })?.code === '42703') {
        throw new ServiceUnavailableException({ code: WORKSHOP_ERRORS.NOT_MIGRATED, message: 'El Taller de cursos todavía no está disponible en este entorno (falta la migración r107).' });
      }
      throw err;
    }
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight.values()]);
  }

  private enqueue(job: Job, givenClaim: string | null = null): void {
    const id = 'intakeId' in job ? job.intakeId : 'requestId' in job ? job.requestId : 'approvalId' in job ? job.approvalId : null;
    const key = `${job.kind}:${id ?? job.sessionId}:${randomUUID()}`;
    if (id) this.activeIds.add(id);
    if ('approvalId' in job) this.activeIds.add(job.approvalId);
    // r107 B6: reclamo entre procesos (como el diagnóstico de B3): las filas del trabajo llevan `<arranque>.<uuid>` y este
    // proceso las late mientras el trabajo está en cola o corriendo.
    // r107 B10 fix 2 (N2): una reanudación llega con el reclamo que la espera le pasó atómicamente (uno solo por llamada).
    const claimId = givenClaim ?? `${this.workshop.bootId}.${randomUUID()}`;
    this.beat(claimId, true);
    const stamped = this.stamp(job, claimId).catch((err) => this.logger.warn(`taller plan: no se pudo marcar el reclamo (${err instanceof Error ? err.message : String(err)})`));
    let done!: () => void;
    const p = new Promise<void>((r) => { done = r; }).finally(() => { this.inFlight.delete(key); if (id) this.activeIds.delete(id); if ('approvalId' in job) this.activeIds.delete(job.approvalId); this.beat(claimId, false); });
    this.inFlight.set(key, p);
    this.queue.push({ job, done, stamped, claimId });
    this.pump();
  }

  /** Marca con el reclamo las filas EN CURSO del trabajo (entrada, pedido, aprobación y los pedidos de una generación). */
  private async stamp(job: Job, claimId: string): Promise<void> {
    if ('intakeId' in job) await this.q(this.dataSource, `update public.workshop_intakes set claim_id = $2, updated_at = now() where id = $1 and status in ('queued', 'interpreting', 'extracting')`, [job.intakeId, claimId]);
    // (regen_resume: el pedido ya lleva su reclamo, pasado por la espera; no se pisa)
    if ('requestId' in job && job.kind !== 'regen_resume') await this.q(this.dataSource, `update public.workshop_requests set claim_id = $2, updated_at = now() where id = $1 and status = 'preparing'`, [job.requestId, claimId]);
    if ('approvalId' in job) {
      await this.q(this.dataSource, `update public.workshop_ai_approvals set claim_id = $2, updated_at = now() where id = $1 and status in ('reserved', 'running')`, [job.approvalId, claimId]);
      if (job.kind === 'generate') {
        await this.q(this.dataSource, `update public.workshop_requests r set claim_id = $2, updated_at = now() from public.workshop_ai_approvals a, public.workshop_plan_items i
            where a.id = $1 and i.id::text in (select jsonb_array_elements_text(a.item_ids)) and r.id = i.request_id and r.status = 'preparing'`, [job.approvalId, claimId]);
      }
    }
  }

  private beat(claimId: string, on: boolean): void {
    if (on) this.beating.add(claimId); else this.beating.delete(claimId);
    if (this.beating.size && !this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, PLAN_HEARTBEAT_MS);
      this.heartbeatTimer.unref?.();
    } else if (!this.beating.size && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Latido (r107 B6): refresca `updated_at` de las filas en curso que este proceso tiene reclamadas. */
  async heartbeat(): Promise<void> {
    if (!this.beating.size) return;
    const claims = [...this.beating];
    try {
      await this.q(this.dataSource, `update public.workshop_intakes set updated_at = now() where claim_id = any($1::text[]) and status in ('queued', 'interpreting', 'extracting')`, [claims]);
      await this.q(this.dataSource, `update public.workshop_requests set updated_at = now() where claim_id = any($1::text[]) and status = 'preparing'`, [claims]);
      await this.q(this.dataSource, `update public.workshop_ai_approvals set updated_at = now() where claim_id = any($1::text[]) and status in ('reserved', 'running')`, [claims]);
      // P1-3: la aprobación de un pedido que espera a un proveedor sigue viva mientras esa espera late.
      await this.q(this.dataSource, `update public.workshop_ai_approvals a set updated_at = now() from public.workshop_requests r
          where r.claim_id = any($1::text[]) and r.status = 'preparing' and r.details ? 'regenPending' and a.id::text = r.details->'regenPending'->>'approvalId' and a.status in ('reserved', 'running')`, [claims]);
    } catch (err) {
      this.logger.warn(`taller plan: latido falló: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** SOLO pruebas: simula que este proceso murió (deja de latir y de tomar trabajo). */
  simulateDeathForTests(): void {
    this.beating.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.queue.length = 0;
    this.dead = true;
  }
  private dead = false;

  /** Carril de 1 por proceso (cada trabajo tiene el original en memoria y corre pruebas en seco del motor). */
  private pump(): void {
    if (this.laneBusy || this.dead) return;
    const next = this.queue.shift();
    if (!next) return;
    this.laneBusy = true;
    next.stamped.then(() => this.runJob(next.job, next.claimId))
      .catch((err) => this.logger.error(`taller plan: trabajo ${next.job.kind} terminó con error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`))
      .finally(() => { this.laneBusy = false; next.done(); this.pump(); });
  }

  // ── aprobación de gasto + reserva (D8 / D9) ──

  /** Valida lo que el docente confirma: el estimado que vio y un tope que alcanza (al menos el estimado y una llamada). */
  validateConfirmation(estimate: ApprovalEstimate, input: { confirmEstimateUsd: unknown; capUsd: unknown }): string {
    const cap = Number(input.capUsd);
    if (!Number.isFinite(cap) || cap <= 0 || cap > 1000) throw new BadRequestException({ code: PLAN_ERRORS.CAP_INVALID, message: 'El tope tiene que ser un monto en USD mayor que 0.' });
    // r107 B8 (decisión del controlador, B8fe P1-1): el estimado se confirma al CENTAVO (half-up a 0,01 a los dos lados):
    // el docente ve centavos y el navegador puede sumar estimados por capítulo / ítem; el tope sigue siendo exacto abajo.
    const confirmedCents = centsHalfUp(input.confirmEstimateUsd);
    if (confirmedCents === null || confirmedCents !== centsHalfUp(estimate.expectedUsd)) {
      throw new ConflictException({ code: PLAN_ERRORS.ESTIMATE_MISMATCH, message: 'El estimado cambió desde que lo viste: revísalo y vuelve a confirmarlo.', estimate });
    }
    if (cap + 1e-9 < Number(estimate.expectedUsd)) {
      throw new ConflictException({ code: PLAN_ERRORS.CAP_BELOW_ESTIMATE, message: `El tope (USD ${cap.toFixed(2)}) es menor que el costo estimado (USD ${Number(estimate.expectedUsd).toFixed(2)}): no se puede aprobar. Tope propuesto: USD ${estimate.proposedCapUsd}.`, estimate });
    }
    const first = estimate.calls[0];
    if (first && cap + 1e-9 < Number(first.boundUsd)) {
      throw new ConflictException({ code: PLAN_ERRORS.CAP_BELOW_CALL_BOUND, message: `El tope (USD ${cap.toFixed(2)}) no alcanza ni para una llamada (su costo máximo es USD ${Number(first.boundUsd).toFixed(2)}). Tope propuesto: USD ${estimate.proposedCapUsd}.`, estimate });
    }
    return cap.toFixed(6);
  }

  /** Controles de la cuenta ANTES de reservar: kill switch / proveedores, congelación / suspensión, disponible ≥ tope. */
  private async preflight(payer: string, capUsd: string): Promise<void> {
    try {
      assertDirectCallAllowed('anthropic');
    } catch {
      throw new ServiceUnavailableException({ code: PLAN_ERRORS.AI_UNAVAILABLE, message: 'El servicio de IA no está disponible en este momento: no se reservó saldo ni se llamó a la IA. Intenta de nuevo más tarde.' });
    }
    const g = this.finopsBudget?.registeredUserBudgetGate?.() ?? null;
    if (!g) return;
    try {
      await g.assertMayStart(this.dataSource, payer);
    } catch (err) {
      const body = (err as { getResponse?: () => any })?.getResponse?.();
      throw new ConflictException({ code: String(body?.code ?? PLAN_ERRORS.AI_UNAVAILABLE), message: String(body?.message ?? 'Tu cuenta no puede usar la IA en este momento.') });
    }
    if (g.mode() !== 'enforce') return;
    const av = await g.availability(this.dataSource, payer);
    if (cmpDec(capUsd, av.available) > 0) {
      throw new ConflictException({ code: PLAN_ERRORS.USER_BUDGET_INSUFFICIENT, message: `Tu saldo disponible del mes (USD ${Number(av.available).toFixed(2)}) no alcanza para el tope que aprobaste (USD ${Number(capUsd).toFixed(2)}). No se reservó nada ni se llamó a la IA.`, requiredUsd: capUsd, availableUsd: av.available });
    }
  }

  /**
   * Crea la aprobación y RESERVA su tope en el ledger. Si la reserva no entra (presupuesto del usuario, techo sin
   * atribuir, kill switch) la aprobación queda `failed` con el motivo y se lanza el error: nada se encola ni se llama.
   */
  async openApproval(s: WorkshopPlanSession, actor: WorkshopActor, a: { kind: ApprovalRow['kind']; intakeId?: string | null; requestId?: string | null; itemIds?: string[]; estimate: ApprovalEstimate; capUsd: string }): Promise<ApprovalRow> {
    await this.pricing(); // fix round 1 (P2-1): modelo sin precio → 503, no se reserva
    await this.preflight(actor.id, a.capUsd);
    if (!this.ledger) throw new ServiceUnavailableException({ code: PLAN_ERRORS.FINOPS_UNAVAILABLE, message: 'No se puede reservar el tope (FinOps no está disponible en este proceso): no se llamó a la IA.' });
    const [row] = await this.q<ApprovalRow[]>(this.dataSource,
      `insert into public.workshop_ai_approvals (session_id, created_by, kind, intake_id, request_id, item_ids, estimate, cap_usd, status)
            values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, 'reserved') returning *`,
      [s.id, actor.id, a.kind, a.intakeId ?? null, a.requestId ?? null, JSON.stringify(a.itemIds ?? []), JSON.stringify(a.estimate), a.capUsd]);
    // Fix round 1 (P2-2): con el cliente SIMULADO (pruebas) no se reserva en el ledger: una reserva MOCK no se puede
    // liquidar (no es un costo medible) y quedaría pendiente para siempre. El tope se sigue haciendo cumplir acá.
    if (this.client.simulated === true) return row;
    const courseId = actor.id.toLowerCase() === s.ownerId.toLowerCase() ? s.identifiedCourseId : null;
    const input = approvalReservationInput({ approvalId: row.id, payer: actor.id, courseId, capUsd: a.capUsd, kind: a.kind, simulated: false });
    try {
      await this.ledger.recordCharge(input);
    } catch (err) {
      const code = String((err as { code?: string })?.code ?? 'error');
      const message = code === 'USER_BUDGET_EXHAUSTED' || code === 'USER_BUDGET_INSUFFICIENT'
        ? `Tu saldo disponible no alcanza para reservar el tope (USD ${Number(a.capUsd).toFixed(2)}). No se llamó a la IA.`
        : `No se pudo reservar el tope en FinOps (${code}). No se llamó a la IA.`;
      await this.q(this.dataSource, `update public.workshop_ai_approvals set status = 'failed', stop_reason = $2, updated_at = now() where id = $1`, [row.id, message]);
      this.logger.warn(`taller plan: reserva de la aprobación ${row.id} rechazada (${code})`);
      throw new ConflictException({ code: PLAN_ERRORS.RESERVATION_FAILED, ledgerCode: code, message, approvalId: row.id });
    }
    const [r] = returningRows(await this.q(this.dataSource, `update public.workshop_ai_approvals set reservation_key = $2, updated_at = now() where id = $1 returning *`, [row.id, input.idempotencyKey]));
    return r as ApprovalRow;
  }

  /**
   * Cierra la aprobación. Fix round 1 (P1-1): la reserva se libera SOLO si todas las llamadas enviadas tienen su cargo
   * registrado o un rechazo documentado sin cobro; si alguna quedó en vuelo / ambigua / sin su cargo, la reserva queda
   * PENDIENTE para conciliar y la aprobación pasa a `ambiguous` con el motivo visible (closeReservation).
   */
  async closeApproval(id: string, status: 'done' | 'stopped' | 'failed', reason: string | null): Promise<void> {
    const [a] = returningRows(await this.q(this.dataSource, `update public.workshop_ai_approvals set status = $2, stop_reason = coalesce($3, stop_reason), updated_at = now() where id = $1 and status in ('reserved', 'running') returning *`, [id, status, reason])) as ApprovalRow[];
    if (!a) return;
    let out;
    try {
      out = await closeReservation(this.ledger, { reservationKey: a.reservation_key, calls: a.calls ?? {} }, `workshop_approval_${status}`);
    } catch (err) {
      this.logger.error(`FINOPS_RESERVATION_NOT_SETTLED: aprobación ${id} (${a.reservation_key}): ${err instanceof Error ? err.message : String(err)}`);
      await this.q(this.dataSource, `update public.workshop_ai_approvals set status = 'ambiguous', stop_reason = $2, updated_at = now() where id = $1`, [id, 'No se pudo liberar la reserva del tope: queda pendiente para conciliar.']);
      return;
    }
    if (out.unresolved.length) {
      this.logger.warn(`FINOPS_RESERVATION_AMBIGUOUS: aprobación ${id} (${a.reservation_key ?? 'sin reserva'}): ${out.unresolved.map((c) => `${c.id}:${c.status}`).join(', ')}`);
      await this.q(this.dataSource, `update public.workshop_ai_approvals set status = 'ambiguous', calls = $2::jsonb, stop_reason = $3, updated_at = now() where id = $1`, [id, JSON.stringify(out.calls), [reason, out.reason].filter(Boolean).join(' · ')]);
    } else {
      await this.q(this.dataSource, `update public.workshop_ai_approvals set calls = $2::jsonb, updated_at = now() where id = $1`, [id, JSON.stringify(out.calls)]);
    }
  }

  private async setCall(approvalId: string, c: ApprovalCall): Promise<void> {
    await this.q(this.dataSource, `update public.workshop_ai_approvals set calls = calls || jsonb_build_object($2::text, $3::jsonb), updated_at = now() where id = $1`, [approvalId, c.id, JSON.stringify(c)]);
  }

  /**
   * r107 B10 fix 2 (N2): liquida UNA llamada en vuelo de forma atómica: solo si sigue `sent` / `settling`, la deja en su
   * estado final y suma `addSpent` a lo gastado (y la cuenta en `ai_calls` si se cobró). false = ya estaba liquidada.
   */
  private async settleCall(approvalId: string, c: ApprovalCall, addSpent: string, countCall: boolean): Promise<boolean> {
    const r = returningRows(await this.q(this.dataSource, `update public.workshop_ai_approvals set spent_usd = spent_usd + $4, ai_calls = ai_calls + $5,
          calls = calls || jsonb_build_object($2::text, $3::jsonb), updated_at = now()
        where id = $1 and calls->$2->>'status' in ('sent', 'settling') returning id`, [approvalId, c.id, JSON.stringify(c), addSpent, countCall ? 1 : 0]));
    return r.length > 0;
  }

  /**
   * r107 B10 fix 2 (N2): transición condicional `sent → settling` ANTES de cobrar una espera: solo quien la gana liquida.
   * Una llamada que quedó `settling` de un liquidador muerto (`settleClaim` = el reclamo que se retomó) se puede retomar.
   */
  async claimSettle(approvalId: string, callId: string, claim: string, priorClaim: string | null): Promise<boolean> {
    const r = returningRows(await this.q(this.dataSource, `update public.workshop_ai_approvals
          set calls = jsonb_set(jsonb_set(calls, array[$2::text, 'status'], '"settling"'::jsonb), array[$2::text, 'settleClaim'], to_jsonb($3::text)), updated_at = now()
        where id = $1 and (calls->$2->>'status' = 'sent' or (calls->$2->>'status' = 'settling' and $4::text is not null and calls->$2->>'settleClaim' = $4::text))
        returning id`, [approvalId, callId, claim, priorClaim]));
    return r.length > 0;
  }

  async approvalOf(id: string): Promise<ApprovalRow | null> {
    const [a] = await this.q<ApprovalRow[]>(this.dataSource, `select * from public.workshop_ai_approvals where id = $1`, [id]);
    return a ?? null;
  }

  /**
   * r107 B8: un trabajo de OTRO servicio del Taller (diagnóstico de calidad, preguntas puntuales) que corre dentro de una
   * aprobación de este servicio la «toma»: queda viva para el barrido de B5 (no se da por interrumpida) y este proceso
   * late su fila con el mismo reclamo `<arranque>.<uuid>`. Si el proceso muere, deja de latir y el barrido la cierra
   * por el camino de siempre (`closeApproval`: ambigua si una llamada pudo cobrarse).
   */
  async holdApproval(approvalId: string, claimId: string): Promise<void> {
    this.activeIds.add(approvalId);
    this.beat(claimId, true);
    await this.q(this.dataSource, `update public.workshop_ai_approvals set claim_id = $2, updated_at = now() where id = $1 and status in ('reserved', 'running')`, [approvalId, claimId]);
  }
  releaseApproval(approvalId: string, claimId: string): void {
    this.activeIds.delete(approvalId);
    this.beat(claimId, false);
  }
  async startApproval(approvalId: string): Promise<void> {
    await this.q(this.dataSource, `update public.workshop_ai_approvals set status = 'running', updated_at = now() where id = $1 and status = 'reserved'`, [approvalId]);
  }

  /**
   * IA DENTRO de una aprobación: antes de cada llamada, gastado + cota ≤ tope aprobado (si no, corta limpio SIN
   * llamar); después, el cargo real al ledger con el `approvalId` y lo gastado a la aprobación.
   */
  invokerFor(s: WorkshopPlanSession, approval: ApprovalRow, pricing: DryRunPricing, meta: Record<string, unknown>): AiInvoke {
    const payer = approval.created_by;
    const courseId = payer.toLowerCase() === s.ownerId.toLowerCase() ? s.identifiedCourseId : null;
    return async (call: AiCall) => {
      const cur = await this.approvalOf(approval.id);
      if (!cur || (cur.status !== 'running' && cur.status !== 'reserved')) throw new AiUnavailableError(PLAN_ERRORS.CAP_REACHED, 'La aprobación ya no está vigente: no se hizo la llamada.');
      // Fix 2 (N1): gastado + cotas de las llamadas EN VUELO de la aprobación (p. ej. un render que espera al proveedor).
      const committed = committedUsd(cur.spent_usd, cur.calls);
      const d = capDecision(committed, call, usd(cur.cap_usd), pricing);
      if (!d.allow) {
        throw new AiUnavailableError(PLAN_ERRORS.CAP_REACHED, `Se alcanzó el tope aprobado (USD ${Number(cur.cap_usd).toFixed(2)}; comprometido USD ${Number(committed).toFixed(2)}): la siguiente llamada podría costar hasta USD ${Number(callBoundUsd(call.size.promptChars, call.maxTokens, pricing)).toFixed(2)}, así que NO se hizo. Aprueba un tope mayor para seguir.`, { capUsd: usd(cur.cap_usd), spentUsd: usd(cur.spent_usd) });
      }
      try {
        assertDirectCallAllowed('anthropic');
      } catch {
        throw new AiUnavailableError(PLAN_ERRORS.AI_UNAVAILABLE, 'El servicio de IA no está disponible en este momento: no se llamó a la IA.');
      }
      let bound: string;
      try {
        bound = callBoundUsd(call.size.promptChars, call.maxTokens, pricing);
      } catch (e) {
        if (e instanceof ModelUnpricedError) throw new AiUnavailableError(PLAN_ERRORS.MODEL_UNPRICED, e.message);
        throw e;
      }
      // Fix round 1 (P1-1): la llamada queda registrada como ENVIADA antes de enviarla (si el proceso se cae, queda así
      // y la reserva no se libera).
      const rec: ApprovalCall = { id: randomUUID(), kind: call.kind, attempt: call.attempt, boundUsd: bound, status: 'sent', at: new Date().toISOString() };
      await this.setCall(approval.id, rec);
      let result: WorkshopAiResult;
      try {
        result = await this.client.call({ purpose: call.purpose, model: modelOf(pricing), system: call.system, user: call.user, tool: call.tool, maxTokens: call.maxTokens, timeoutMs: WORKSHOP_AI_TIMEOUT_MS });
      } catch (err) {
        const o = callErrorOutcome(err);
        this.logger.error(`taller plan: la IA falló (${o.status}, estado ${o.providerStatus ?? '—'}: ${err instanceof Error ? err.message : String(err)})`);
        await this.setCall(approval.id, { ...rec, status: o.status, providerStatus: o.providerStatus, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
        if (o.status === 'ambiguous') {
          // Pudo cobrarse: cuenta la cota entera como gastada (la guarda del tope no deja seguir a ciegas).
          await this.q(this.dataSource, `update public.workshop_ai_approvals set spent_usd = spent_usd + $2, updated_at = now() where id = $1`, [approval.id, bound]);
          throw new AiUnavailableError(PLAN_ERRORS.CALL_AMBIGUOUS, 'La IA no respondió y no se sabe si la llamada se cobró: la reserva del tope queda pendiente hasta conciliarla. Vuelve a intentarlo más tarde.');
        }
        if (o.status === 'not_sent') throw new AiUnavailableError(PLAN_ERRORS.AI_UNAVAILABLE, 'No se llegó a llamar a la IA (el servicio no está disponible o falta su configuración): no se cobró nada y la reserva se libera.');
        throw new AiUnavailableError(PLAN_ERRORS.AI_UNAVAILABLE, 'El servicio de IA rechazó la llamada sin cobrarla; vuelve a intentarlo en unos minutos.');
      }
      this.aiCalls++;
      let costUsd: string;
      try {
        costUsd = priceMeasured(result.usage, result.model, pricing);
      } catch {
        // Respondió un modelo sin precio: se cuenta la cota (lado seguro); el ledger lo registra `pending_zero`.
        costUsd = bound;
      }
      await this.q(this.dataSource, `update public.workshop_ai_approvals set spent_usd = spent_usd + $2, ai_calls = ai_calls + 1, updated_at = now() where id = $1`, [approval.id, costUsd]);
      const input = workshopChargeInput({ payer, courseId, result, purpose: call.purpose, metadata: { ...meta, approvalId: approval.id, callId: rec.id, sessionId: s.id, callKind: call.kind, attempt: call.attempt, planCodeVersion: PLAN_CODE_VERSION } });
      let recorded = false;
      let recErr: string | null = null;
      if (this.ledger && input) {
        try { await this.ledger.recordCharge(input); recorded = true; } catch (err) { recErr = err instanceof Error ? err.message.slice(0, 300) : String(err); }
      } else recErr = !this.ledger ? 'sin FinOps en este proceso' : 'faltan owner/id/usage';
      if (!recorded) this.logger.error(`FINOPS_NOT_RECORDED: taller ${call.kind} (${result.messageId ?? 'sin id'}): ${recErr}`);
      await this.setCall(approval.id, { ...rec, status: recorded ? 'charged' : 'charge_unrecorded', messageId: result.messageId, costUsd, error: recErr, charge: recorded ? null : input });
      return { result, costUsd };
    };
  }

  /** Preparación SIN IA (estructural): si algo intentara llamarla, falla visible (nunca se gasta sin aprobación). */
  private readonly noAi: AiInvoke = async () => { throw new AiUnavailableError(PLAN_ERRORS.NOT_AWAITING_CONFIRMATION, 'Este paso no tiene una aprobación de gasto: no se llama a la IA.'); };

  estimateOf(calls: PlannedCall[], note: string): ApprovalEstimate {
    const c = proposedCapOf(calls);
    return { calls, expectedUsd: c.expectedUsd, boundUsd: c.boundUsd, proposedCapUsd: c.proposedCapUsd, note };
  }

  private async courseForEstimate(sessionId: string): Promise<WorkshopCourse> {
    const inv = await this.workshop.persistedInventory(sessionId);
    if (!inv) throw new ConflictException({ code: PLAN_ERRORS.INVENTORY_NOT_READY, message: 'El inventario del paquete todavía se está armando: vuelve a intentarlo en unos segundos.' });
    return inv;
  }

  // ── API: entradas ──

  async createTextIntake(actor: WorkshopActor, sessionId: string, rawText: unknown) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    await this.assertPlanEditable(s);
    const text = typeof rawText === 'string' ? rawText.replace(/\r\n/g, '\n').trim() : '';
    if (!text) throw new BadRequestException({ code: PLAN_ERRORS.TEXT_EMPTY, message: 'Escribe qué quieres cambiar del curso.' });
    if (text.length > PLAN_LIMITS.textMaxChars) throw new BadRequestException({ code: PLAN_ERRORS.TEXT_TOO_LONG, message: `El pedido es demasiado largo (máximo ${PLAN_LIMITS.textMaxChars} caracteres): envía solo los cambios.` });
    const estimate = this.estimateOf([estimateInterpretation({ course: await this.courseForEstimate(s.id), pricing: await this.pricing() }, text)], 'Interpretar el pedido (1 llamada; un reintento por validación entra en el margen). La IA no corre hasta que lo apruebes.');
    const [row] = await this.q<IntakeRow[]>(this.dataSource,
      `insert into public.workshop_intakes (session_id, original_sha1, created_by, source, status, text, text_sha1, estimate) values ($1, $2, $3, 'text', 'awaiting_confirmation', $4, $5, $6::jsonb) returning *`,
      [s.id, s.originalSha1, actor.id, text, sha1(text), JSON.stringify(estimate)]);
    return this.intakeView(row);
  }

  /** (a) Aprobar el costo de interpretar una entrada → reserva del tope → recién ahí corre la IA. */
  async confirmInterpretation(actor: WorkshopActor, sessionId: string, intakeId: string, input: { confirmEstimateUsd: unknown; capUsd: unknown }) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    await this.assertPlanEditable(s);
    const row = await this.intakeOf(s.id, intakeId);
    if (row.status !== 'awaiting_confirmation' || !row.estimate) throw new ConflictException({ code: PLAN_ERRORS.NOT_AWAITING_CONFIRMATION, message: 'Esta entrada no está esperando que apruebes su costo.', status: row.status });
    const cap = this.validateConfirmation(row.estimate, input);
    const approval = await this.openApproval(s, actor, { kind: 'interpret', intakeId: row.id, estimate: row.estimate, capUsd: cap });
    const [r] = returningRows(await this.q(this.dataSource, `update public.workshop_intakes set status = 'queued', approval_id = $2, updated_at = now() where id = $1 and status = 'awaiting_confirmation' returning *`, [row.id, approval.id]));
    if (!r) { await this.closeApproval(approval.id, 'failed', 'La entrada cambió mientras se aprobaba.'); throw new ConflictException({ code: PLAN_ERRORS.NOT_AWAITING_CONFIRMATION, message: 'Esta entrada ya no espera aprobación.' }); }
    this.enqueue({ kind: 'interpret', sessionId: s.id, intakeId: row.id, approvalId: approval.id });
    return { intake: this.intakeView(r), approval: this.approvalView(approval) };
  }

  async createDocumentIntake(actor: WorkshopActor, sessionId: string, input: { filename: unknown; sizeBytes: unknown }) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    await this.assertPlanEditable(s);
    const base = typeof input.filename === 'string' ? (input.filename.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255) : '';
    const ext = (/\.[a-z0-9]+$/i.exec(base)?.[0] ?? '').toLowerCase();
    if (!base || !(DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)) throw new BadRequestException({ code: PLAN_ERRORS.DOCUMENT_INVALID, message: 'Sube un documento .docx, .pdf, .txt o .md con los cambios.' });
    const size = Number(input.sizeBytes);
    if (!Number.isSafeInteger(size) || size <= 0) throw new BadRequestException({ code: PLAN_ERRORS.DOCUMENT_INVALID, message: 'El documento está vacío.' });
    if (size > PLAN_LIMITS.documentMaxBytes) throw new BadRequestException({ code: PLAN_ERRORS.DOCUMENT_TOO_LARGE, message: `El documento pesa ${(size / 1048576).toFixed(1)} MB; el máximo es ${PLAN_LIMITS.documentMaxBytes / 1048576} MB.` });
    const [idRow] = await this.q<any[]>(this.dataSource, `select gen_random_uuid()::text as id`);
    const intakeId = String(idRow.id);
    const storagePath = `${actor.id.toLowerCase()}/workshop/${s.id.toLowerCase()}/requests/${intakeId}${ext}`;
    assertWritableStoragePath(actor.id, WORKSHOP_BUCKET, storagePath);
    const [row] = await this.q<IntakeRow[]>(this.dataSource,
      `insert into public.workshop_intakes (id, session_id, original_sha1, created_by, source, status, filename, storage_path, declared_bytes) values ($1, $2, $3, $4, 'document', 'awaiting_upload', $5, $6, $7) returning *`,
      [intakeId, s.id, s.originalSha1, actor.id, base, storagePath, size]);
    const signed = await this.artifacts.createSignedUploadUrl(actor.id, WORKSHOP_BUCKET, storagePath);
    return {
      intake: this.intakeView(row),
      upload: signed.method === 'backend'
        ? { method: 'backend' as const, url: signed.url, token: signed.token, bucket: WORKSHOP_BUCKET, storagePath, maxBytes: PLAN_LIMITS.documentMaxBytes }
        : { method: 'frontend' as const, bucket: WORKSHOP_BUCKET, storagePath, maxBytes: PLAN_LIMITS.documentMaxBytes },
    };
  }

  /** Cierra la subida: se extrae el texto (sin IA) y la entrada queda esperando que se apruebe su interpretación. */
  async markDocumentUploaded(actor: WorkshopActor, sessionId: string, intakeId: string) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    await this.assertPlanEditable(s);
    const row = await this.intakeOf(s.id, intakeId);
    if (row.source !== 'document') throw new BadRequestException({ code: PLAN_ERRORS.DOCUMENT_INVALID, message: 'Esta entrada no es un documento.' });
    if (row.status !== 'awaiting_upload') return this.intakeView(row);
    const bytes = await this.artifacts.headStorageObjectBytes(WORKSHOP_BUCKET, row.storage_path as string);
    if (bytes === null) throw new ConflictException({ code: PLAN_ERRORS.DOCUMENT_NOT_UPLOADED, message: 'Todavía no llegó el documento: termina de subirlo y vuelve a intentar.' });
    if (bytes > PLAN_LIMITS.documentMaxBytes) {
      const [r] = returningRows(await this.q(this.dataSource, `update public.workshop_intakes set status = 'failed', error = $2::jsonb, updated_at = now() where id = $1 returning *`,
        [row.id, JSON.stringify({ code: PLAN_ERRORS.DOCUMENT_TOO_LARGE, message: `El documento subido pesa ${(bytes / 1048576).toFixed(1)} MB; el máximo es ${PLAN_LIMITS.documentMaxBytes / 1048576} MB.`, retryable: false })]));
      return this.intakeView(r);
    }
    const [r] = returningRows(await this.q(this.dataSource, `update public.workshop_intakes set status = 'extracting', updated_at = now() where id = $1 and status = 'awaiting_upload' returning *`, [row.id]));
    if (r) this.enqueue({ kind: 'extract', sessionId: s.id, intakeId: row.id });
    return this.intakeView(r ?? (await this.intakeOf(s.id, intakeId)));
  }

  async listRequests(actor: WorkshopActor, sessionId: string) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.view');
    await this.expireStale(s.id);
    const intakes = await this.q<IntakeRow[]>(this.dataSource, `select * from public.workshop_intakes where session_id = $1 and original_sha1 = $2 order by created_at, id`, [s.id, s.originalSha1]);
    const requests = await this.q<RequestRow[]>(this.dataSource, `select * from public.workshop_requests where session_id = $1 and intake_id = any($2::uuid[]) order by created_at, ordinal`, [s.id, intakes.map((i) => i.id)]);
    const approvals = await this.q<ApprovalRow[]>(this.dataSource, `select * from public.workshop_ai_approvals where session_id = $1 order by created_at`, [s.id]);
    return { sessionId: s.id, originalSha1: s.originalSha1, intakes: intakes.map((i) => this.intakeView(i)), requests: requests.map((r) => this.requestView(r)), approvals: approvals.map((a) => this.approvalView(a)) };
  }

  /**
   * Respuestas (D6). Preguntas del servidor con opción → se resuelve SIN IA. Si la respuesta vuelve a la IA, el pedido
   * queda `awaiting_confirmation` con el costo estimado de re-interpretarlo (se aprueba con `…/requests/:id/interpret`).
   */
  async answer(actor: WorkshopActor, sessionId: string, requestId: string, answers: ClarifyAnswer[]) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    await this.assertPlanEditable(s);
    const row = await this.requestOf(s.id, requestId);
    if (row.status !== 'needs_answer') throw new ConflictException({ code: PLAN_ERRORS.NOT_WAITING, message: 'Este pedido no está esperando respuestas.' });
    if (row.rounds >= PLAN_LIMITS.roundsMax) throw new ConflictException({ code: PLAN_ERRORS.ROUNDS_EXHAUSTED, message: 'Este pedido ya tuvo demasiadas rondas de preguntas: retíralo y escríbelo de nuevo con más detalle.' });
    let qa;
    try {
      qa = checkAnswers({ status: row.status as 'needs_answer', questions: row.questions }, answers);
    } catch (e) {
      if (e instanceof AnswerError) throw new BadRequestException({ code: e.code, message: e.message });
      throw e;
    }
    // Ronda 4 (D2): el MISMO predicado que answerRequest (si difieren, un pedido «sin IA» termina pidiendo IA y falla).
    const deterministic = isDeterministicAnswer(row.operation, qa);
    const log = JSON.stringify([{ at: new Date().toISOString(), by: actor.id, answers }]);
    if (deterministic) {
      const [r] = returningRows(await this.q(this.dataSource,
        `update public.workshop_requests set status = 'preparing', answers = answers || $2::jsonb, details = details || jsonb_build_object('pendingAnswers', $3::jsonb), updated_at = now() where id = $1 and status = 'needs_answer' returning *`,
        [row.id, log, JSON.stringify(answers)]));
      if (!r) throw new ConflictException({ code: PLAN_ERRORS.NOT_WAITING, message: 'Este pedido no está esperando respuestas.' });
      this.enqueue({ kind: 'stage', sessionId: s.id, requestId: row.id });
      return this.requestView(r);
    }
    const course = await this.courseForEstimate(s.id);
    const estimate = this.estimateOf([estimateReinterpretation({ course, pricing: await this.pricing() }, this.interpretedOf(row), qa.reduce((n, x) => n + x.question.length + x.answer.length, 0))], 'Re-interpretar este pedido con tus respuestas (1 llamada). La IA no corre hasta que lo apruebes.');
    const [r] = returningRows(await this.q(this.dataSource,
      `update public.workshop_requests set status = 'awaiting_confirmation', estimate = $4::jsonb, answers = answers || $2::jsonb, details = details || jsonb_build_object('pendingAnswers', $3::jsonb), updated_at = now() where id = $1 and status = 'needs_answer' returning *`,
      [row.id, log, JSON.stringify(answers), JSON.stringify(estimate)]));
    if (!r) throw new ConflictException({ code: PLAN_ERRORS.NOT_WAITING, message: 'Este pedido no está esperando respuestas.' });
    return this.requestView(r);
  }

  /** Aprobar el costo de re-interpretar un pedido con sus respuestas. */
  async confirmReinterpretation(actor: WorkshopActor, sessionId: string, requestId: string, input: { confirmEstimateUsd: unknown; capUsd: unknown }) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    await this.assertPlanEditable(s);
    const row = await this.requestOf(s.id, requestId);
    if (row.status !== 'awaiting_confirmation' || !row.estimate) throw new ConflictException({ code: PLAN_ERRORS.NOT_AWAITING_CONFIRMATION, message: 'Este pedido no está esperando que apruebes su costo.', status: row.status });
    const cap = this.validateConfirmation(row.estimate, input);
    const approval = await this.openApproval(s, actor, { kind: 'reinterpret', requestId: row.id, estimate: row.estimate, capUsd: cap });
    const [r] = returningRows(await this.q(this.dataSource, `update public.workshop_requests set status = 'preparing', updated_at = now() where id = $1 and status = 'awaiting_confirmation' returning *`, [row.id]));
    if (!r) { await this.closeApproval(approval.id, 'failed', 'El pedido cambió mientras se aprobaba.'); throw new ConflictException({ code: PLAN_ERRORS.NOT_AWAITING_CONFIRMATION, message: 'Este pedido ya no espera aprobación.' }); }
    this.enqueue({ kind: 'reinterpret', sessionId: s.id, requestId: row.id, approvalId: approval.id });
    return { request: this.requestView(r), approval: this.approvalView(approval) };
  }

  async withdraw(actor: WorkshopActor, sessionId: string, requestId: string) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    await this.assertPlanEditable(s);
    const row = await this.requestOf(s.id, requestId);
    const [r] = returningRows(await this.q(this.dataSource, `update public.workshop_requests set status = 'withdrawn', updated_at = now() where id = $1 returning *`, [row.id]));
    await this.q(this.dataSource, `update public.workshop_plan_items set status = 'removed', updated_at = now() where request_id = $1`, [row.id]);
    this.enqueue({ kind: 'combined', sessionId: s.id });
    return this.requestView(r);
  }

  // ── API: plan ──

  async getPlan(actor: WorkshopActor, sessionId: string) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.view');
    await this.expireStale(s.id);
    return this.planView(s);
  }

  /**
   * (b) Aprobar la GENERACIÓN del contenido (antes/después) de ítems en etapa de estimado, con tope. Los pedidos se
   * reclaman (`preparing`) para que dos aprobaciones nunca generen lo mismo.
   */
  async approveGeneration(actor: WorkshopActor, sessionId: string, planId: string, input: { itemIds: unknown; capUsd: unknown; confirmEstimateUsd: unknown }) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    await this.assertPlanEditable(s);
    if (!isUuid(planId)) throw new NotFoundException('Plan no encontrado');
    const [plan] = await this.q<any[]>(this.dataSource, `select id from public.workshop_plans where id = $1 and session_id = $2 and original_sha1 = $3`, [planId.toLowerCase(), s.id, s.originalSha1]);
    if (!plan) throw new NotFoundException('Plan no encontrado');
    const raw = Array.isArray(input.itemIds) ? input.itemIds : [];
    const ids = [...new Set(raw.filter((x): x is string => typeof x === 'string' && isUuid(x)).map((x) => x.toLowerCase()))];
    if (!ids.length || ids.length !== raw.length) throw new BadRequestException({ code: PLAN_ERRORS.ITEMS_INVALID, message: 'Elige los ítems a generar (ids válidos, sin repetir).' });
    // P1-5 (regla de B8): un ítem que espera a un proveedor, o con una llamada ambigua sin conciliar, no se re-aprueba.
    const blocked = await this.q<any[]>(this.dataSource, `select i.id, r.details->'regenPending' as pending, r.details->'regenAmbiguous' as amb from public.workshop_plan_items i join public.workshop_requests r on r.id = i.request_id
        left join public.workshop_ai_approvals a on a.id::text = r.details->'regenAmbiguous'->>'approvalId'
        where i.plan_id = $1 and i.id = any($2::uuid[]) and ((r.status = 'preparing' and r.details ? 'regenPending') or (r.details ? 'regenAmbiguous' and coalesce(a.status, '') <> 'reconciled'))`, [plan.id, ids]);
    if (blocked.length) {
      const b = blocked[0];
      throw new ConflictException({ code: PLAN_ERRORS.REGEN_PENDING_PROVIDER, itemIds: blocked.map((x) => x.id),
        message: b.pending ? `Este ítem está esperando al proveedor (${b.pending.provider}, ${b.pending.externalId}): no se puede aprobar de nuevo hasta que termine.`
          : `Este ítem tiene una llamada pendiente de conciliación (${b.amb?.provider ?? 'proveedor'}${b.amb?.externalId ? `, ${b.amb.externalId}` : ''}): no se reenvía ni se re-aprueba hasta que el admin la concilie.` });
    }
    const items = await this.q<ItemRow[]>(this.dataSource, `select i.* from public.workshop_plan_items i join public.workshop_requests r on r.id = i.request_id
        where i.plan_id = $1 and i.id = any($2::uuid[]) and i.stage = 'estimate' and i.status = 'proposed' and r.status = 'awaiting_generation' order by i.created_at, i.id`, [plan.id, ids]);
    // r107 B11 (P1-2 c): un solo ítem estructural por plan; si hay más, 409 ANTES de reservar ni llamar a nadie.
    if (items.some((i) => isStructuralOperation(i.operation))) {
      const [st] = await this.q<any[]>(this.dataSource, `select count(*)::int as n from public.workshop_plan_items i join public.workshop_requests r on r.id = i.request_id
          where i.plan_id = $1 and i.status = 'proposed' and i.available and r.status not in ('withdrawn', 'failed', 'unavailable', 'out_of_scope')
            and i.operation in ('add_chapter', 'add_module')`, [plan.id]);
      // Ronda 2 (P2-D): un estructural no disponible o fallido no bloquea al otro (no se va a aplicar).
      if (Number(st?.n ?? 0) > 1) throw new ConflictException({ code: STRUCTURAL_COMBINATION, message: STRUCTURAL_COMBINATION_MESSAGE });
      // Ronda 2 (P2-A): el plan quita una actividad del capítulo molde → 409 antes de gastar (dos rondas).
      const tpl = items.filter((i) => isStructuralOperation(i.operation)).flatMap((i) => ((i.view?.plannedCall as any)?.regen?.templateModuleIds ?? (i.params as any)?.expect?.templateModuleIds ?? []) as number[]);
      const rms = await this.q<any[]>(this.dataSource, `select coalesce(i.params->>'moduleId', r.target->>'moduleId') as mid, r.target->>'title' as title from public.workshop_plan_items i join public.workshop_requests r on r.id = i.request_id
          where i.plan_id = $1 and i.status = 'proposed' and i.operation = 'remove_activity' and r.status not in ('withdrawn', 'failed', 'unavailable', 'out_of_scope')`, [plan.id]);
      const hit = removesTemplate(tpl, rms.map((x) => Number(x.mid)).filter((n) => Number.isFinite(n)));
      if (hit.length) throw new ConflictException({ code: STRUCTURAL_COMBINATION, message: templateRemovalMessage(rms.filter((x) => hit.includes(Number(x.mid))).map((x) => String(x.title || `actividad ${x.mid}`))) });
    }
    if (items.length !== ids.length) throw new ConflictException({ code: PLAN_ERRORS.ITEMS_INVALID, message: 'Algún ítem elegido no está esperando generación (ya se generó, se quitó o es de otro plan).' });
    // r107 B10: una regeneración usa otros proveedores (OpenAI TTS, Gamma, Videogen, YouTube): todos tienen que estar
    // permitidos (kill switch / allow-list) ANTES de reservar nada.
    const regen = items.filter((i) => isPaidOperation(i.operation));
    for (const prov of [...new Set(regen.flatMap((i) => ((i.view.plannedCall as any)?.regen?.providers ?? []).map((l: any) => String(l.provider))))]) {
      try { assertDirectCallAllowed(prov); } catch {
        throw new ServiceUnavailableException({ code: PLAN_ERRORS.PROVIDER_UNAVAILABLE, message: `El proveedor «${prov}» no está disponible en este momento: no se reservó saldo ni se llamó a nada. Intenta de nuevo más tarde.` });
      }
    }
    const estimate = this.estimateOf(items.map((i) => i.view.plannedCall as PlannedCall), regen.length
      ? `Generar ${items.length} ítem(s); ${regen.length} rehace(n) una actividad con los proveedores (IA, voz, video, presentación): el costo es por proveedor y nada corre hasta que lo apruebes. Un resultado incompleto no se aplica.`
      : `Generar el contenido de ${items.length} ítem(s) (1 llamada cada uno; un reintento por validación entra en el margen). La IA no corre hasta que lo apruebes.`);
    const cap = this.validateConfirmation(estimate, input);
    // P1-2a: una regeneración exige que el tope cubra la SUMA de las cotas de todas sus llamadas (no solo la primera).
    const regenBound = paidBoundSum(regen.map((i) => i.view.plannedCall));
    if (regen.length && capBelowPaidBound(cap, regenBound)) {
      throw new ConflictException({ code: PLAN_ERRORS.CAP_BELOW_CALL_BOUND, message: `El tope (USD ${Number(cap).toFixed(2)}) no cubre el costo máximo de todas las llamadas de la regeneración (USD ${regenBound.toFixed(2)}). Tope propuesto: USD ${estimate.proposedCapUsd}.`, estimate, requiredUsd: regenBound.toFixed(6) });
    }
    const approval = await this.openApproval(s, actor, { kind: 'generate', itemIds: items.map((i) => i.id), estimate, capUsd: cap });
    const claimed = returningRows(await this.q(this.dataSource, `update public.workshop_requests set status = 'preparing', reason = null, updated_at = now() where id = any($1::uuid[]) and status = 'awaiting_generation' returning id`, [items.map((i) => i.request_id)]));
    if (claimed.length !== items.length) {
      await this.q(this.dataSource, `update public.workshop_requests set status = 'awaiting_generation', updated_at = now() where id = any($1::uuid[]) and status = 'preparing'`, [claimed.map((x: any) => x.id)]);
      await this.closeApproval(approval.id, 'failed', 'Los ítems cambiaron mientras se aprobaba.');
      throw new ConflictException({ code: PLAN_ERRORS.ITEMS_INVALID, message: 'Algún ítem ya se está generando: vuelve a intentarlo.' });
    }
    this.enqueue({ kind: 'generate', sessionId: s.id, approvalId: approval.id });
    return { approval: this.approvalView(approval), plan: await this.planView(s) };
  }

  async setItemStatus(actor: WorkshopActor, sessionId: string, itemId: string, status: 'proposed' | 'removed') {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    await this.assertPlanEditable(s);
    const item = await this.itemOf(s, itemId);
    if (status === 'proposed') {
      const [req] = await this.q<RequestRow[]>(this.dataSource, `select status from public.workshop_requests where id = $1`, [item.request_id]);
      if (req?.status === 'withdrawn') throw new ConflictException({ code: PLAN_ERRORS.NOT_WAITING, message: 'El pedido de este ítem se retiró: vuelve a pedirlo.' });
    }
    await this.q(this.dataSource, `update public.workshop_plan_items set status = $2, updated_at = now() where id = $1`, [item.id, status]);
    this.enqueue({ kind: 'combined', sessionId: s.id });
    return this.planView(s);
  }

  /** Aviso de desalineación → pedido APARTE (D7). Idempotente por (ítem, aviso). Queda en etapa de estimado si necesita IA. */
  async addWarning(actor: WorkshopActor, sessionId: string, itemId: string, warningId: string) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    await this.assertPlanEditable(s);
    const item = await this.itemOf(s, itemId);
    const w = (item.view.misalignment ?? []).find((x: MisalignmentWarning) => x.id === warningId);
    if (!w || !w.suggestedOperation || !w.activity) throw new BadRequestException({ code: PLAN_ERRORS.WARNING_NOT_ADDABLE, message: 'Este aviso no se puede agregar como pedido (no hay una operación del Taller que lo arregle).' });
    const [dup] = await this.q<RequestRow[]>(this.dataSource,
      `select * from public.workshop_requests where session_id = $1 and status <> 'withdrawn' and details->>'fromItemId' = $2 and details->>'fromWarningId' = $3`, [s.id, item.id, w.id]);
    if (dup) return this.requestView(dup);
    const [parent] = await this.q<RequestRow[]>(this.dataSource, `select * from public.workshop_requests where id = $1`, [item.request_id]);
    const raw = {
      quote: w.message,
      instruction: `Alinear esta actividad con el cambio pedido («${parent?.instruction ?? ''}»): ${w.message}`.slice(0, 1000),
      operation: w.suggestedOperation,
      target: { moduleId: w.activity.moduleId, ...(w.questionId !== null ? { quizModuleId: w.activity.moduleId, questionId: w.questionId } : {}), ...(w.activity.chapterNumber !== null ? { chapterNumber: w.activity.chapterNumber } : {}), ...(w.suggestedOperation === 'edit_libro_section' && parent?.target?.chapterNumber ? { chapters: [parent.target.chapterNumber] } : {}) },
    };
    const r = await this.insertSingleRequest(s, actor, 'misalignment', w.message, { ...raw, details: { fromItemId: item.id, fromWarningId: w.id } }, null);
    this.enqueue({ kind: 'stage', sessionId: s.id, requestId: r.id });
    return this.requestView(r);
  }

  /** «Arreglar esto» desde un hallazgo del diagnóstico listo de ESTE original. Idempotente por hallazgo; sin IA de interpretación. */
  async fixFinding(actor: WorkshopActor, sessionId: string, findingId: string) {
    const s = await this.workshop.planSessionFor(actor, sessionId, 'courses.edit');
    await this.assertPlanEditable(s);
    if (typeof findingId !== 'string' || !/^[TQ]\d{2}\.[a-z0-9_]+\.[0-9a-f]{12}$/.test(findingId)) throw new NotFoundException({ code: PLAN_ERRORS.FINDING_NOT_FOUND, message: 'Hallazgo no encontrado.' });
    let f: { finding: unknown } | undefined;
    if (findingId.startsWith('Q')) {
      // r107 B8: un hallazgo de CALIDAD (Q01–Q05) del diagnóstico de calidad listo de ESTE original: mismo camino que uno técnico.
      const [r] = await this.q<any[]>(this.dataSource, `select id, status from public.workshop_quality_runs where session_id = $1 and original_sha1 = $2 and code_version = $3`, [s.id, s.originalSha1, QUALITY_CODE_VERSION]);
      if (!r || r.status !== 'ready') throw new ConflictException({ code: PLAN_ERRORS.DIAGNOSIS_NOT_READY, message: 'Primero hay que correr el diagnóstico de calidad (o esperar a que termine).' });
      [f] = await this.q<any[]>(this.dataSource, `select finding from public.workshop_quality_findings where run_id = $1 and finding_id = $2`, [r.id, findingId]);
    } else {
      const [d] = await this.q<any[]>(this.dataSource, `select id, status from public.workshop_diagnoses where session_id = $1 and original_sha1 = $2 and code_version = $3`, [s.id, s.originalSha1, DIAGNOSIS_CODE_VERSION]);
      if (!d || d.status !== 'ready') throw new ConflictException({ code: PLAN_ERRORS.DIAGNOSIS_NOT_READY, message: 'Primero hay que diagnosticar el paquete (o esperar a que termine el diagnóstico).' });
      [f] = await this.q<any[]>(this.dataSource, `select finding from public.workshop_findings where diagnosis_id = $1 and finding_id = $2`, [d.id, findingId]);
    }
    if (!f) throw new NotFoundException({ code: PLAN_ERRORS.FINDING_NOT_FOUND, message: 'Hallazgo no encontrado en el diagnóstico de este paquete.' });
    const [dup] = await this.q<RequestRow[]>(this.dataSource, `select * from public.workshop_requests where session_id = $1 and finding_id = $2 and status <> 'withdrawn'`, [s.id, findingId]);
    if (dup) return this.requestView(dup);
    let r: RequestRow;
    try {
      r = await this.insertSingleRequest(s, actor, 'finding', (f.finding as Finding).title, null, findingId);
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        const [again] = await this.q<RequestRow[]>(this.dataSource, `select * from public.workshop_requests where session_id = $1 and finding_id = $2 and status <> 'withdrawn'`, [s.id, findingId]);
        if (again) return this.requestView(again);
      }
      throw err;
    }
    this.enqueue({ kind: 'stage', sessionId: s.id, requestId: r.id });
    return this.requestView(r);
  }

  // ── trabajo en segundo plano ──

  private async runJob(job: Job, claimId: string = `${this.workshop.bootId}.${randomUUID()}`): Promise<void> {
    const s = await this.workshop.planSessionById(job.sessionId);
    if (!s || s.status !== 'identified' || !s.originalSha1) {
      await this.failJob(job, WORKSHOP_ERRORS.ORIGINAL_CHANGED, 'El original de la sesión ya no está disponible.', false);
      return;
    }
    if (job.kind === 'extract') { await this.runExtract(s, job.intakeId); return; }
    if (job.kind === 'interpret') {
      const [claimed] = returningRows(await this.q(this.dataSource, `update public.workshop_intakes set status = 'interpreting', claim_id = $2, updated_at = now() where id = $1 and status = 'queued' returning *`, [job.intakeId, claimId]));
      if (!claimed) { await this.closeApproval(job.approvalId, 'failed', 'La entrada ya no estaba en cola.'); return; }
    }
    if ('approvalId' in job) await this.q(this.dataSource, `update public.workshop_ai_approvals set status = 'running', updated_at = now() where id = $1 and status = 'reserved'`, [job.approvalId]);
    // r107 B10: producir una regeneración (audiolibro, video, PDF) suma lo producido en memoria.
    // Fix round 1 (P2-8): la prueba en seco combinada (corre después de CUALQUIER trabajo) carga los resultados producidos
    // del plan: su tamaño entra al presupuesto de memoria, lo corra quien lo corra.
    const regenWork = job.kind === 'regen_resume' || (job.kind === 'generate' && (await this.approvalHasRegen(job.approvalId)));
    const bytes = Number(s.originalSize ?? 0) * diagnosisMemoryFactor(s.container) + (regenWork ? REGEN_MEMORY_EXTRA_BYTES : 0) + (await this.planRegenResultBytes(s));
    try {
      await this.workshop.withMemory(`plan:${job.sessionId}`, bytes, async () => {
        let ctx: BuildCtx;
        try {
          const original = await this.workshop.loadVerifiedOriginal(s.id);
          // B12 (H2): la reserva pasa a lo que el paquete ABIERTO puede ocupar (+ lo producido que el trabajo carga).
          await this.workshop.reserveForPackage(`plan:${job.sessionId}`, original.buffer, diagnosisMemoryFactor(s.container), Math.max(0, bytes - Number(s.originalSize ?? 0) * diagnosisMemoryFactor(s.container)));
          ctx = await openBuildCtx(original.buffer, { filename: s.filename, originalSha1: s.originalSha1 as string, pricing: await this.pricing(), baseline: await this.baselineOf(s) });
          ctx.regenDbLoader = () => this.regenDbSources(s, ctx.course);
          // r107 B10 · Libro v3 (PDF): la entrada del builder del curso, solo si hace falta (perezosa).
          ctx.libroV3Loader = () => libroV3ResolverOf(this.dataSource, this.artifacts, this.moduleRef).resolve(s);
          ctx.ttsModel = resolveTtsModel(undefined, process.env).model;
        } catch (err) {
          if (err instanceof MemoryWaitTimeoutError) throw err;
          // B12 (H2): paquete que se expande más de lo procesable → terminal (con los mismos bytes falla igual).
          if (isMbzReaderError(err)) { await this.failJob(job, `WORKSHOP_${err.code.toUpperCase()}`, err.message, false); return; }
          const body = (err as { getResponse?: () => any })?.getResponse?.();
          const code = String(body?.code ?? PLAN_ERRORS.PREPARE_FAILED);
          await this.failJob(job, code, String(body?.message ?? 'No se pudo abrir el original de la sesión; vuelve a intentarlo.'), code !== WORKSHOP_ERRORS.ORIGINAL_CHANGED && code !== WORKSHOP_ERRORS.ORIGINAL_MISSING);
          return;
        }
        try {
          if (job.kind === 'interpret') await this.runInterpret(s, ctx, job.intakeId, job.approvalId);
          else if (job.kind === 'reinterpret') await this.runReinterpret(s, ctx, job.requestId, job.approvalId);
          else if (job.kind === 'stage') await this.runStage(s, ctx, job.requestId);
          else if (job.kind === 'generate') await this.runGenerate(s, ctx, job.approvalId);
          else if (job.kind === 'regen_resume') await this.runRegenResume(s, ctx, job.approvalId, job.requestId, claimId);
        } catch (err) {
          if (err instanceof AiUnavailableError) await this.failJob(job, err.code, err.message, true, err.extra);
          else {
            this.logger.error(`taller plan ${s.id}: ${job.kind} falló: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
            await this.failJob(job, PLAN_ERRORS.PREPARE_FAILED, 'No se pudo procesar el pedido; vuelve a intentarlo. Si se repite, avísanos.', true);
          }
        }
        await this.refreshCombined(s, ctx).catch((err) => this.logger.error(`taller plan ${s.id}: prueba en seco combinada: ${err instanceof Error ? err.message : String(err)}`));
      });
    } catch (err) {
      // r107 B6 fix round 2 (N1): la espera por memoria venció → falla visible y reintentable (nunca espera para siempre).
      if (err instanceof MemoryWaitTimeoutError) { await this.failJob(job, err.code, err.message, true); return; }
      throw err;
    }
  }

  private async failJob(job: Job, code: string, message: string, retryable: boolean, extra: Record<string, unknown> = {}): Promise<void> {
    const error = JSON.stringify({ code, message, retryable, ...extra });
    if (job.kind === 'interpret' || job.kind === 'extract') await this.q(this.dataSource, `update public.workshop_intakes set status = 'failed', error = $2::jsonb, updated_at = now() where id = $1 and status in ('queued', 'interpreting', 'extracting')`, [job.intakeId, error]);
    else if (job.kind === 'reinterpret') await this.q(this.dataSource, `update public.workshop_requests set status = 'needs_answer', reason = $2, details = details || jsonb_build_object('lastError', $3::jsonb), updated_at = now() where id = $1 and status = 'preparing'`, [job.requestId, message, error]);
    else if (job.kind === 'stage') await this.q(this.dataSource, `update public.workshop_requests set status = 'failed', reason = $2, details = details || jsonb_build_object('lastError', $3::jsonb), updated_at = now() where id = $1 and status = 'preparing'`, [job.requestId, message, error]);
    else if (job.kind === 'generate') {
      const a = await this.approvalOf(job.approvalId);
      // Un pedido que espera a un proveedor (P1-3) NO se suelta: su espera sigue y cierra la aprobación al terminar.
      if (a) await this.q(this.dataSource, `update public.workshop_requests r set status = 'awaiting_generation', reason = $2, updated_at = now() from public.workshop_plan_items i where i.request_id = r.id and i.id = any($1::uuid[]) and r.status = 'preparing' and not (coalesce(r.details, '{}'::jsonb) ? 'regenPending')`, [a.item_ids, `No se generó: ${message}`]);
    } else if (job.kind === 'regen_resume') {
      await this.q(this.dataSource, `update public.workshop_requests set status = 'awaiting_generation', reason = $2, updated_at = now() where id = $1 and status = 'preparing' and not (coalesce(details, '{}'::jsonb) ? 'regenPending')`, [job.requestId, `No se generó: ${message} (lo ya pagado se reusa al reintentar).`]);
      await this.maybeCloseApproval(job.approvalId, code === PLAN_ERRORS.CAP_REACHED ? 'stopped' : 'failed', message);
      return;
    }
    if ('approvalId' in job) {
      if (job.kind === 'generate') await this.maybeCloseApproval(job.approvalId, code === PLAN_ERRORS.CAP_REACHED ? 'stopped' : 'failed', message);
      else await this.closeApproval(job.approvalId, code === PLAN_ERRORS.CAP_REACHED ? 'stopped' : 'failed', message);
    }
  }

  /** Documento → texto (lector EXISTENTE de academic-context, sin IA) → `awaiting_confirmation` con su estimado. */
  private async runExtract(s: WorkshopPlanSession, intakeId: string): Promise<void> {
    const row = await this.intakeOf(s.id, intakeId);
    if (row.status !== 'extracting') return;
    let buf: Buffer;
    try {
      buf = await this.artifacts.downloadStorageObjectCapped(WORKSHOP_BUCKET, row.storage_path as string, { maxBytes: PLAN_LIMITS.documentMaxBytes, timeoutMs: DOWNLOAD_TIMEOUT_MS, sizeHint: row.declared_bytes === null ? null : Number(row.declared_bytes) });
    } catch {
      await this.failIntake(row.id, PLAN_ERRORS.DOCUMENT_NOT_UPLOADED, 'No se pudo leer el documento subido; vuelve a intentarlo en unos minutos.', true);
      return;
    }
    let text: string;
    let mediaType: string | null = null;
    let notes: unknown[] = [];
    try {
      const doc = await readDocument(buf, row.filename ?? 'documento');
      text = doc.lines.map((l) => l.text).join('\n').trim();
      mediaType = doc.mediaType;
      notes = doc.notes ?? [];
    } catch (err) {
      const msg = err instanceof DocumentReadError ? err.message : 'el documento no se pudo leer';
      await this.failIntake(row.id, PLAN_ERRORS.DOCUMENT_UNREADABLE, `No se pudo leer el documento: ${msg}. Prueba con otro formato o pega el texto.`, false);
      return;
    }
    if (!text) { await this.failIntake(row.id, PLAN_ERRORS.DOCUMENT_UNREADABLE, 'El documento no tiene texto (¿es un PDF escaneado?). Pega el texto de los cambios.', false); return; }
    if (text.length > PLAN_LIMITS.documentTextMaxChars) { await this.failIntake(row.id, PLAN_ERRORS.TEXT_TOO_LONG, `El documento tiene ${text.length.toLocaleString('es')} caracteres de texto; el máximo es ${PLAN_LIMITS.documentTextMaxChars.toLocaleString('es')}. Envía solo los cambios.`, false); return; }
    const inv = await this.workshop.persistedInventory(s.id);
    if (!inv) { await this.failIntake(row.id, PLAN_ERRORS.INVENTORY_NOT_READY, 'El inventario del paquete todavía no está listo: vuelve a subir el documento en unos segundos.', true); return; }
    const estimate = this.estimateOf([estimateInterpretation({ course: inv, pricing: await this.pricing() }, text)], 'Interpretar el documento (1 llamada; un reintento por validación entra en el margen). La IA no corre hasta que lo apruebes.');
    await this.q(this.dataSource, `update public.workshop_intakes set status = 'awaiting_confirmation', text = $2, text_sha1 = $3, media_type = $4, notes = $5::jsonb, estimate = $6::jsonb, updated_at = now() where id = $1 and status = 'extracting'`,
      [row.id, text, sha1(text), mediaType, JSON.stringify(notes), JSON.stringify(estimate)]);
  }

  private async runInterpret(s: WorkshopPlanSession, ctx: BuildCtx, intakeId: string, approvalId: string): Promise<void> {
    const row = await this.intakeOf(s.id, intakeId);
    const approval = (await this.approvalOf(approvalId)) as ApprovalRow;
    const ai = this.invokerFor(s, approval, ctx.pricing, { intakeId: row.id, purpose: 'interpret' });
    const out = await interpretText(ctx, row.text as string, ai);
    if (!out.ok) {
      await this.q(this.dataSource, `update public.workshop_intakes set status = 'failed', error = $2::jsonb, spent_usd = spent_usd + $3, ai_calls = ai_calls + $4, updated_at = now() where id = $1`,
        [row.id, JSON.stringify({ code: PLAN_ERRORS.INTERPRETATION_FAILED, message: out.reason, retryable: true, problems: out.problems.slice(0, 10) }), out.spentUsd, out.calls]);
      await this.closeApproval(approvalId, 'done', null);
      return;
    }
    const ids: string[] = await this.dataSource.transaction(async (m) => {
      const created: string[] = [];
      for (let i = 0; i < out.requests.length; i++) {
        const r = out.requests[i];
        const status = r.status === 'resolved' || r.status === 'phase_later' ? 'preparing' : r.status;
        const [x] = await this.q<RequestRow[]>(m, `insert into public.workshop_requests (session_id, intake_id, ordinal, quote, instruction, operation, status, target, raw_target, details, questions, reason)
            values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12) returning id`,
          [s.id, row.id, i, r.quote, r.instruction, r.operation, status, JSON.stringify(r.target), JSON.stringify(r.rawTarget), JSON.stringify(r.details ?? {}), JSON.stringify(r.questions ?? []), r.reason]);
        if (status === 'preparing') created.push(x.id);
      }
      await this.q(m, `update public.workshop_intakes set status = 'ready', error = null, spent_usd = spent_usd + $2, ai_calls = ai_calls + $3, notes = notes || $4::jsonb, updated_at = now() where id = $1`,
        [row.id, out.spentUsd, out.calls, JSON.stringify(out.requests.length ? [] : [{ code: 'NO_REQUESTS', message: 'No encontramos ningún cambio concreto en el pedido.' }])]);
      return created;
    });
    // La interpretación terminó: la reserva se libera ANTES de armar los ítems (que no usan IA: quedan estimados).
    await this.closeApproval(approvalId, 'done', null);
    for (const id of ids) await this.runStage(s, ctx, id);
  }

  private interpretedOf(row: RequestRow): InterpretedRequest {
    return { quote: row.quote, instruction: row.instruction, operation: row.operation as InterpretedRequest['operation'], status: row.status as InterpretedRequest['status'], target: row.target, rawTarget: row.raw_target, details: row.details ?? {}, questions: row.questions ?? [], reason: row.reason };
  }

  /** Respuestas que vuelven a la IA, con su aprobación. */
  private async runReinterpret(s: WorkshopPlanSession, ctx: BuildCtx, requestId: string, approvalId: string): Promise<void> {
    const row = await this.requestOf(s.id, requestId);
    if (row.status !== 'preparing') { await this.closeApproval(approvalId, 'failed', 'El pedido ya no estaba esperando.'); return; }
    const approval = (await this.approvalOf(approvalId)) as ApprovalRow;
    const prev = { ...this.interpretedOf(row), status: 'needs_answer' as const };
    const ai = this.invokerFor(s, approval, ctx.pricing, { requestId: row.id, purpose: 'reinterpret' });
    const out = await answerAndResolve(ctx, prev, row.details?.pendingAnswers ?? [], ai);
    await this.closeApproval(approvalId, 'done', null);
    await this.applyReinterpretation(s, ctx, row, out);
  }

  private async applyReinterpretation(s: WorkshopPlanSession, ctx: BuildCtx, row: RequestRow, out: Awaited<ReturnType<typeof answerAndResolve>>): Promise<void> {
    if (!out.ok) {
      await this.q(this.dataSource, `update public.workshop_requests set status = 'needs_answer', reason = $2, spent_usd = spent_usd + $3, ai_calls = ai_calls + $4, rounds = rounds + 1, updated_at = now() where id = $1`, [row.id, out.reason, out.spentUsd, out.calls]);
      return;
    }
    const r = out.requests[0];
    const status = r.status === 'resolved' || r.status === 'phase_later' ? 'preparing' : r.status;
    const details = { ...(r.details ?? {}) } as Record<string, unknown>;
    delete details.pendingAnswers;
    await this.q(this.dataSource, `update public.workshop_requests set status = $2, operation = $3, instruction = $4, target = $5::jsonb, raw_target = $6::jsonb, details = $7::jsonb, questions = $8::jsonb, reason = $9,
        spent_usd = spent_usd + $10, ai_calls = ai_calls + $11, rounds = rounds + 1, updated_at = now() where id = $1`,
      [row.id, status, r.operation, r.instruction, JSON.stringify(r.target), JSON.stringify(r.rawTarget), JSON.stringify(details), JSON.stringify(r.questions ?? []), r.reason, out.spentUsd, out.calls]);
    if (status === 'preparing') await this.runStage(s, ctx, row.id, true);
  }

  /**
   * Pedido `preparing` SIN aprobación de gasto: resuelve («Arreglar esto», aviso agregado, respuestas del servidor) y
   * arma su ítem — estructural (prueba en seco, sin IA), de fase posterior, o en ETAPA DE ESTIMADO si su contenido
   * necesita IA (`awaiting_generation`: se genera solo con `…/plans/:id/generate`).
   */
  private async runStage(s: WorkshopPlanSession, ctx: BuildCtx, requestId: string, alreadyResolved = false): Promise<void> {
    const row = await this.requestOf(s.id, requestId);
    if (row.status !== 'preparing') return;
    const [intake] = await this.q<IntakeRow[]>(this.dataSource, `select created_by, source from public.workshop_intakes where id = $1`, [row.intake_id]);
    const fromFinding = intake?.source === 'finding';
    let req: InterpretedRequest;
    if (!alreadyResolved && fromFinding && row.operation === null && row.target === null) {
      const f = await this.findingOf(s, row.finding_id as string);
      if (!f) { await this.setRequest(row.id, { status: 'failed', reason: 'El hallazgo ya no está en el diagnóstico de este paquete.' }); return; }
      req = requestFromFinding(f, ctx.course);
    } else if (!alreadyResolved && intake?.source === 'misalignment' && row.target === null) {
      const r = resolveRequest({ quote: row.quote, operation: row.operation as any, instruction: row.instruction, target: row.raw_target ?? {}, colors: [], chapters: null, reason: null, questions: [] }, ctx.course, { trustedTarget: true, trustedChange: true });
      req = { ...r, details: { ...(row.details ?? {}), ...r.details } };
    } else if (!alreadyResolved && Array.isArray(row.details?.pendingAnswers) && row.questions?.length) {
      // Respuestas a preguntas del SERVIDOR: se resuelve sin IA.
      const out = await answerAndResolve(ctx, { ...this.interpretedOf(row), status: 'needs_answer' }, row.details.pendingAnswers, this.noAi);
      await this.applyReinterpretation(s, ctx, row, out);
      return;
    } else req = { ...this.interpretedOf(row), status: (row.operation && (LATER_OPERATIONS as readonly string[]).includes(row.operation)) ? 'phase_later' : 'resolved' };
    if (req.status !== 'resolved' && req.status !== 'phase_later') {
      await this.setRequest(row.id, { status: req.status, operation: req.operation, target: req.target, raw_target: req.rawTarget, details: req.details, questions: req.questions, reason: req.reason, instruction: req.instruction });
      return;
    }
    if (req.status === 'resolved') {
      const est = await estimateContent(ctx, req);
      if (est && 'unavailable' in est) {
        await this.setRequest(row.id, { status: 'unavailable', operation: req.operation, target: req.target, raw_target: req.rawTarget, details: req.details, questions: [], reason: est.unavailable, instruction: req.instruction });
        return;
      }
      if (est) {
        const view = estimateItemView(ctx, req, est as PlannedCall, { fromFinding });
        await this.setRequest(row.id, { status: 'awaiting_generation', operation: req.operation, target: req.target, raw_target: req.rawTarget, details: req.details, questions: [], reason: null, instruction: req.instruction, estimate: est });
        await this.upsertItem(s, row.id, view, 'estimate');
        return;
      }
    }
    const prep = await prepareItem(ctx, req, this.noAi, { fromFinding });
    await this.saveItem(s, row.id, req, prep);
  }

  private async saveItem(s: WorkshopPlanSession, requestId: string, req: InterpretedRequest, prep: PreparedItem): Promise<void> {
    const status: RequestStatus = prep.status;
    await this.setRequest(requestId, { status, operation: req.operation, target: req.target, raw_target: req.rawTarget, details: req.details, questions: [], reason: prep.reason, instruction: req.instruction, addSpent: prep.spentUsd, addCalls: prep.calls });
    if (prep.view && (status === 'resolved' || status === 'phase_later')) await this.upsertItem(s, requestId, prep.view, 'ready');
    else await this.q(this.dataSource, `delete from public.workshop_plan_items where request_id = $1`, [requestId]);
  }

  /**
   * Generación APROBADA: ítem por ítem, en orden. Antes de cada llamada, la guarda del tope; si no entra, se corta
   * limpio: lo generado queda listo y lo que faltó vuelve a `awaiting_generation` con el motivo (nunca a medias en silencio).
   */
  private async runGenerate(s: WorkshopPlanSession, ctx: BuildCtx, approvalId: string): Promise<void> {
    const approval = (await this.approvalOf(approvalId)) as ApprovalRow;
    const items = await this.q<ItemRow[]>(this.dataSource, `select * from public.workshop_plan_items where id = any($1::uuid[]) order by created_at, id`, [approval.item_ids]);
    const ai = this.invokerFor(s, approval, ctx.pricing, { purpose: 'content' });
    let stop: AiUnavailableError | null = null;
    for (const item of items) {
      const row = await this.requestOf(s.id, item.request_id);
      if (row.status !== 'preparing') continue;
      if (stop) {
        await this.setRequest(row.id, { status: 'awaiting_generation', reason: `No se generó: ${stop.message}` });
        continue;
      }
      const [intake] = await this.q<IntakeRow[]>(this.dataSource, `select source from public.workshop_intakes where id = $1`, [row.intake_id]);
      const req: InterpretedRequest = { ...this.interpretedOf(row), status: 'resolved' };
      if (isPaidOperation(req.operation)) {
        const r = await this.runRegenItem(s, ctx, approval, item, row, req, intake?.source === 'finding');
        if (r instanceof AiUnavailableError) stop = r;
        continue;
      }
      let prep: PreparedItem;
      try {
        prep = await prepareItem(ctx, req, ai, { fromFinding: intake?.source === 'finding' });
      } catch (err) {
        if (!(err instanceof AiUnavailableError)) throw err;
        stop = err;
        await this.setRequest(row.id, { status: 'awaiting_generation', reason: `No se generó: ${err.message}` });
        continue;
      }
      // r107 B10 · Libro v3: el PDF que armó el builder se guarda como resultado del Taller (el plan no lleva los bytes).
      const lp = prep.view?.params as any;
      if (prep.status === 'resolved' && lp && lp.op === 'edit_libro_section' && lp.pdf && lp.libroV3) {
        try {
          const ref = await storeRegenResult(this.dataSource, this.artifacts, { ownerId: s.ownerId, sessionId: s.id, approvalId: approval.id, itemId: item.id, requestId: row.id, operation: 'edit_libro_section',
            produced: { kind: 'libro_pdf', moduleId: lp.moduleId, pdf: Buffer.from(String(lp.pdf.base64), 'base64'), previousSha1: lp.pdf.previousSha1, chapters: (lp.libroV3.chapters ?? []).map((c: any) => c.number) } });
          prep.view!.params = { ...lp, pdf: undefined, libroV3: { ...lp.libroV3, result: ref } };
        } catch (err) {
          this.logger.error(`taller libro v3 ${s.id}: no se pudo guardar el PDF de ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
          await this.setRequest(row.id, { status: 'awaiting_generation', reason: 'No se pudo guardar el Libro regenerado (lo gastado quedó registrado): vuelve a generarlo en unos minutos.', addSpent: prep.spentUsd, addCalls: prep.calls });
          continue;
        }
      }
      await this.saveItem(s, row.id, req, prep);
    }
    // P1-3: un ítem que espera a un proveedor asíncrono sigue `preparing`: la aprobación (y su reserva) siguen vivas hasta
    // que termine la última espera / reanudación (maybeCloseApproval). Fix 2: el corte (tope) queda guardado para el cierre.
    if (stop) await this.q(this.dataSource, `update public.workshop_ai_approvals set stop_reason = coalesce(stop_reason, $2), updated_at = now() where id = $1`, [approvalId, stop.message]);
    await this.maybeCloseApproval(approvalId, stop ? (stop.code === PLAN_ERRORS.CAP_REACHED ? 'stopped' : 'failed') : 'done', stop ? stop.message : null);
  }

  /** Cierra la aprobación solo si ningún pedido suyo sigue `preparing` (esperando al proveedor o por reanudar). */
  private async maybeCloseApproval(approvalId: string, status: 'done' | 'stopped' | 'failed', reason: string | null): Promise<void> {
    const a = await this.approvalOf(approvalId);
    if (!a) return;
    const [r] = await this.q<any[]>(this.dataSource, `select count(*)::int as n from public.workshop_requests r join public.workshop_plan_items i on i.request_id = r.id
        where i.id = any($1::uuid[]) and r.status = 'preparing'`, [a.item_ids ?? []]);
    if (Number(r?.n ?? 0) > 0) return;
    const over = String(a.stop_reason ?? '').startsWith(PROVIDER_OVER_BOUND);
    // Un corte anterior (p. ej. el tope de otro ítem) no se pierde aunque la última espera termine bien.
    await this.closeApproval(approvalId, over ? 'failed' : status === 'done' && a.stop_reason ? 'stopped' : status, over ? null : reason);
  }

  /** Mezcla claves en `details` del pedido y quita otras (atómico). */
  private async patchDetails(requestId: string, set: Record<string, unknown>, drop: string[] = [], claim: string | null = null): Promise<void> {
    // (con `claim`: solo si el pedido sigue con ESE reclamo — un proceso que perdió la espera no toca nada)
    await this.q(this.dataSource, `update public.workshop_requests set details = (coalesce(details, '{}'::jsonb) || $2::jsonb) - $3::text[], updated_at = now() where id = $1 and ($4::text is null or claim_id = $4::text)`, [requestId, JSON.stringify(set), drop, claim]);
  }

  /**
   * P2-3: lo YA pagado de este pedido (mismo original, misma operación y actividad): se reusa, nunca se vuelve a pagar.
   * Fix 2 (N3): un job ACEPTADO y sin liquidar sin su espera (`regenPending`) nunca se da por «esperando»: si la
   * conciliación del admin dijo `not_charged` se puede volver a enviar; si dijo que se cobró, se reusa (consulta
   * gratuita); si no está conciliado, falla cerrado con un error visible (RegenError call_ambiguous).
   */
  private async priorOf(s: WorkshopPlanSession, row: RequestRow, req: InterpretedRequest): Promise<RegenPrior> {
    const p = row.details?.regenPaid;
    if (!p || p.originalSha1 !== s.originalSha1 || p.operation !== req.operation || String(p.moduleId) !== String(regenTargetKey(req))) return {};
    const out: RegenPrior = { videogen: p.videogen ?? null, youtube: p.youtube ?? null, gamma: p.gamma ?? null };
    // r107 B11: piezas ya producidas de cada capítulo nuevo (se reusan) y el examen de la unidad nueva.
    if (p.chapterPieces && typeof p.chapterPieces === 'object') out.chapterPieces = p.chapterPieces;
    if (p.chapterCurrent !== undefined) out.chapterCurrent = p.chapterCurrent;
    if (p.unitExam && typeof p.unitExam === 'object') out.unitExam = p.unitExam;
    // Lo externo de un capítulo YA terminado que quedó sin liquidar: misma regla que las ranuras de arriba.
    for (const [k, rec] of Object.entries(out.chapterPieces ?? {})) {
      for (const prov of ['videogen', 'gamma'] as const) {
        const e = (rec as any)?.[prov];
        if (!e || e.charged || k === out.chapterCurrent) continue;
        throw new RegenError('call_ambiguous', `${prov} aceptó el pedido del capítulo ${k} y no quedó liquidado: queda pendiente de conciliación (no se reenvía).`, { provider: prov, externalId: e.jobId ?? e.generationId ?? null, approvalId: e.approvalId ?? null });
      }
    }
    for (const prov of ['videogen', 'gamma'] as const) {
      const e = out[prov] as any;
      if (!e || e.charged) continue;
      const a = e.approvalId ? await this.approvalOf(String(e.approvalId)) : null;
      const outcome = a?.status === 'reconciled' ? String((a as any).reconciliation?.outcome ?? '') : '';
      if (outcome === 'not_charged') out[prov] = null;
      else if (outcome === 'charged' || outcome === 'charged_partial') out[prov] = { ...e, charged: true };
      else throw new RegenError('call_ambiguous', `${prov} aceptó el pedido ${prov === 'videogen' ? e.jobId : e.generationId} y no quedó liquidado ni en espera: queda pendiente de conciliación (no se reenvía).`, { provider: prov, externalId: prov === 'videogen' ? e.jobId : e.generationId, approvalId: e.approvalId ?? null });
    }
    return out;
  }

  // ── r107 B10: rehacer actividades (Fase 3) ──

  private async approvalHasRegen(approvalId: string): Promise<boolean> {
    const a = await this.approvalOf(approvalId);
    if (!a || !Array.isArray(a.item_ids) || !a.item_ids.length) return false;
    const [r] = await this.q<any[]>(this.dataSource, `select count(*)::int as n from public.workshop_plan_items where id = any($1::uuid[]) and (operation like 'regenerate\_%' or operation in ('add_chapter', 'add_module'))`, [a.item_ids]);
    return Number(r?.n ?? 0) > 0;
  }

  /** P2-8: bytes de los resultados producidos que la prueba en seco combinada carga (zip + decodificado ≈ ×2). */
  private async planRegenResultBytes(s: WorkshopPlanSession): Promise<number> {
    try {
      const [r] = await this.q<any[]>(this.dataSource, `select coalesce(sum(coalesce((i.params->'result'->>'bytes')::bigint, 0)), 0)::bigint as b from public.workshop_plan_items i join public.workshop_plans p on p.id = i.plan_id
          where p.session_id = $1 and p.original_sha1 = $2 and i.status = 'proposed' and i.params ? 'result'`, [s.id, s.originalSha1]);
      return 2 * Number(r?.b ?? 0);
    } catch {
      return 0;
    }
  }

  /** Proveedores reales con los clientes existentes; YouTube = la conexión del que paga; tema de Gamma = el del curso. */
  private async defaultRegenProviders(s: WorkshopPlanSession, payer: string): Promise<RegenProviders> {
    let youtube = null;
    try {
      const yt = this.moduleRef?.get(YoutubeService, { strict: false });
      const up = this.moduleRef?.get(YoutubeUploadService, { strict: false });
      if (yt && up) youtube = { connection: () => yt.getConnection(payer) as Promise<any>, upload: (c: unknown, a: { downloadUrl: string; title: string }) => up.uploadFromUrl(c as any, { downloadUrl: a.downloadUrl, title: a.title }) };
    } catch { youtube = null; }
    let gammaThemeId: string | null = null;
    if (s.identifiedCourseId) {
      try {
        const p = await loadPackagingProfilesV3(this.dataSource as any, s.identifiedCourseId, false);
        gammaThemeId = gammaThemeFor(p.theme.input.themeFamily as any, p.theme.input.mode as any);
      } catch { gammaThemeId = null; }
    }
    return realRegenProviders(process.env, { youtube, gammaThemeId });
  }

  /**
   * Fuente de la BASE para rehacer (curso identificado, mismo alcance que B2): el markdown de cada capítulo
   * (`dynamic_content_md`) y su Context Package (`dynamic_context_package_json`).
   * Fix round 1 (P2-4): SOLO del run que armó el `.mbz` identificado (huella exacta → `dynamic_mbz` no deshabilitado →
   * su job de empaquetado del MISMO curso → `runId` → las salidas efectivas de ese run), nunca «lo más reciente del curso».
   * Si no se puede atar, no hay fuente de la base: se usa la del paquete y lo que la exige queda no disponible con el motivo.
   */
  async regenDbSources(s: WorkshopPlanSession, course: WorkshopCourse): Promise<RegenDbSources | null> {
    if (!s.identifiedCourseId) return null;
    const none = (why: string): RegenDbSources => ({ chapterMd: new Map(), contextPackage: new Map(), courseContext: null, tiedTo: null, unavailable: why });
    try {
      const [c] = await this.q<any[]>(this.dataSource, `select id, owner_id::text as owner_id, institution_id::text as institution_id from public.courses where id = $1`, [s.identifiedCourseId]);
      if (!c) return none('el curso identificado ya no existe.');
      const inScope = s.institutionId ? String(c.institution_id ?? '').toLowerCase() === s.institutionId.toLowerCase() : String(c.owner_id ?? '').toLowerCase() === s.ownerId.toLowerCase();
      if (!inScope) return none('el curso identificado no está en el alcance de esta sesión.');
      const [ses] = await this.q<any[]>(this.dataSource, `select identification from public.workshop_sessions where id = $1`, [s.id]);
      const artId = ses?.identification?.result?.matchedArtifactId;
      if (typeof artId !== 'string' || !artId) return none('el paquete no se identificó por su huella exacta con un paquete de Cursia: no se sabe con qué run se armó.');
      const [art] = await this.q<any[]>(this.dataSource, `select id::text as id, owner_id::text as owner_id, job_id::text as job_id, type, status from public.artifacts where id::text = $1`, [artId]);
      if (!art || art.type !== 'dynamic_mbz') return none('el paquete identificado no es un paquete v3 del generador.');
      if (art.status === 'disabled') return none('el paquete identificado está deshabilitado.');
      if (String(art.owner_id).toLowerCase() !== String(c.owner_id).toLowerCase()) return none('el paquete identificado es de otra cuenta.');
      const [job] = art.job_id ? await this.q<any[]>(this.dataSource, `select id::text as id, owner_id::text as owner_id, course_id, input_payload from public.production_jobs where id::text = $1`, [art.job_id]) : [];
      const payload = job ? (typeof job.input_payload === 'string' ? JSON.parse(job.input_payload) : job.input_payload ?? {}) : null;
      if (!job || typeof payload?.runId !== 'string' || !payload.runId) return none('no se encontró el empaquetado que armó este paquete.');
      if (Number(job.course_id) !== Number(s.identifiedCourseId)) return none('el empaquetado que armó este paquete es de otro curso.');
      if (String(job.owner_id).toLowerCase() !== String(c.owner_id).toLowerCase()) return none('el empaquetado es de otra cuenta.');
      const rows = await this.q<any[]>(this.dataSource,
        `select a.id::text as id, a.type, a.chapter_id::text as chapter_id, a.storage_bucket, a.storage_path, a.size_bytes
           from ${effectiveOutputRowsSql('$1')} gir
           join public.artifacts a on a.item_run_id = gir.id and a.status is distinct from 'disabled'
          where gir.job_id = $1 and a.owner_id::text = $2 and a.type in ('dynamic_content_md', 'dynamic_context_package_json') and a.chapter_id is not null
          order by a.created_at desc, a.id desc limit 2000`, [payload.runId, String(c.owner_id)]);
      const numberOf = new Map(course.chapters.filter((x) => x.builderUuid).map((x) => [String(x.builderUuid).toLowerCase(), x.number]));
      const out: RegenDbSources = { chapterMd: new Map(), contextPackage: new Map(), courseContext: null, tiedTo: { artifactId: art.id, jobId: job.id, runId: payload.runId }, unavailable: null };
      const seen = new Set<string>();
      for (const r of rows) {
        const n = numberOf.get(String(r.chapter_id).toLowerCase());
        const k = `${r.type}:${n}`;
        if (n === undefined || seen.has(k)) continue;
        seen.add(k);
        try {
          const buf = await this.artifacts.downloadStorageObjectCapped(r.storage_bucket ?? 'cursia-artifacts', r.storage_path, { maxBytes: 4 * 1024 * 1024, timeoutMs: 60_000, sizeHint: r.size_bytes === null ? null : Number(r.size_bytes) });
          const text = buf.toString('utf8');
          if (r.type === 'dynamic_content_md') out.chapterMd.set(n, text);
          else out.contextPackage.set(n, JSON.parse(text));
        } catch (err) {
          this.logger.warn(`taller regen ${s.id}: no se pudo leer la fuente ${r.id} (${err instanceof Error ? err.message.slice(0, 120) : String(err)}): se usa la del paquete`);
        }
      }
      return out.chapterMd.size || out.contextPackage.size ? out : none('el run que armó el paquete no tiene la fuente de los capítulos.');
    } catch (err) {
      if ((err as { code?: string })?.code === '42703' || (err as { code?: string })?.code === '42P01') return none('la base no tiene la fuente por capítulo (anterior a r58).');
      throw err;
    }
  }

  /**
   * Compuerta de CADA llamada pagada de una regeneración (D9, B5): tope (gastado + cota ≤ autorizado), kill switch del
   * proveedor, registro `sent` ANTES de enviar; después, el cargo real al ledger con el `approvalId` (o `ambiguous`:
   * la cota cuenta como gastada, la reserva queda pendiente y nunca se reenvía sola).
   */
  regenGateFor(s: WorkshopPlanSession, approval: ApprovalRow, simulated: boolean): RegenGate {
    const payer = approval.created_by;
    const courseId = payer.toLowerCase() === s.ownerId.toLowerCase() ? s.identifiedCourseId : null;
    let spentHere = 0;
    const charge = { payer, courseId, approvalId: approval.id, sessionId: s.id, simulated };
    const ticketFor = (rec: ApprovalCall & { provider?: string }, spec: { provider: string; kind: string; boundUsd: string }): PaidCallTicket => ({
      id: rec.id,
      accepted: async (ext: string) => { rec.messageId = ext; await this.setCall(approval.id, rec); },
      charged: async (m) => {
        // Fix 2 (N2): primero el ledger (idempotente por el id externo), después UN update condicionado: la llamada sigue
        // en vuelo (`sent` / `settling`) → pasa a liquidada y su costo entra en lo gastado. Si otro proceso ya la liquidó,
        // no se suma nada.
        let recorded = !m.charge;
        let err: string | null = null;
        if (m.charge) {
          if (!this.ledger) err = 'sin FinOps en este proceso';
          else {
            try { await this.ledger.recordCharge(m.charge); recorded = true; } catch (e) { err = e instanceof Error ? e.message.slice(0, 300) : String(e); }
          }
        }
        // P1-2c: lo medido por encima de la cota es un INCIDENTE: queda registrado lo real (aprobación + ledger), se cortan
        // las llamadas que quedan de esta aprobación y el ítem falla visible.
        const over = Number(m.costUsd) > Number(spec.boundUsd) + 1e-9;
        const done = { ...rec, status: recorded ? 'charged' : 'charge_unrecorded', messageId: m.externalId ?? rec.messageId ?? null, costUsd: m.costUsd, error: err, charge: recorded ? null : m.charge, ...(over ? { overBound: true } : {}) } as ApprovalCall;
        if (!(await this.settleCall(approval.id, done, m.costUsd, true))) throw new RegenError('internal', `La llamada ${rec.id} ya estaba liquidada: no se cobra dos veces.`, { alreadySettled: true });
        spentHere += Number(m.costUsd);
        if (over) {
          const msg = `${PROVIDER_OVER_BOUND}: ${spec.provider} cobró USD ${Number(m.costUsd).toFixed(2)}, más que la cota de la llamada (USD ${Number(spec.boundUsd).toFixed(2)}). Quedó registrado lo real y se cortaron las llamadas que faltaban de esta aprobación.`;
          await this.q(this.dataSource, `update public.workshop_ai_approvals set stop_reason = $2, updated_at = now() where id = $1`, [approval.id, msg]);
          this.logger.error(`WORKSHOP_PROVIDER_OVER_BOUND: aprobación ${approval.id} ${spec.provider}:${spec.kind} medido ${m.costUsd} > cota ${spec.boundUsd}`);
          throw new RegenError('over_bound', msg, { code: PROVIDER_OVER_BOUND, provider: spec.provider, costUsd: m.costUsd, boundUsd: spec.boundUsd });
        }
      },
      failed: async (e: unknown, outcome) => {
        const st = (e as { status?: unknown })?.status;
        const msg = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
        // Fix 2 (N2): mismo update condicionado (ambigua: la cota entra en lo gastado una sola vez).
        const settled = await this.settleCall(approval.id, { ...rec, status: outcome, providerStatus: typeof st === 'number' ? st : null, error: msg }, outcome === 'ambiguous' ? spec.boundUsd : '0', false);
        this.logger.error(`taller regen: ${spec.provider} ${spec.kind} falló (${outcome}): ${msg}`);
        if (!settled) return new RegenError('internal', `La llamada ${rec.id} ya estaba liquidada por otro proceso.`, { alreadySettled: true });
        if (outcome === 'ambiguous') {
          spentHere += Number(spec.boundUsd);
          return new RegenError('call_ambiguous', `${spec.provider} no confirmó el resultado y no se sabe si la llamada se cobró${rec.messageId ? ` (operación ${rec.messageId})` : ''}: no se reenvía sola y la reserva del tope queda pendiente hasta conciliarla.`, { provider: spec.provider, externalId: rec.messageId ?? null });
        }
        if (outcome === 'not_sent') return new RegenError('not_sent', `No se llegó a llamar a ${spec.provider} (no está disponible o falta su configuración): no se cobró nada.`);
        return new RegenError('provider_rejected', `${spec.provider} rechazó la llamada sin cobrarla${typeof st === 'number' ? ` (HTTP ${st})` : ''}: vuelve a intentarlo más tarde.`);
      },
    });
    return {
      charge,
      spent: () => spentHere.toFixed(6),
      begin: async (spec): Promise<PaidCallTicket> => {
        const cur = await this.approvalOf(approval.id);
        if (!cur || (cur.status !== 'running' && cur.status !== 'reserved')) throw new RegenError('cap_reached', 'La aprobación ya no está vigente: no se hizo la llamada.');
        if (String(cur.stop_reason ?? '').startsWith(PROVIDER_OVER_BOUND)) throw new RegenError('over_bound', String(cur.stop_reason), { code: PROVIDER_OVER_BOUND });
        // Fix 2 (N1): la misma fuente de verdad que la IA de B5 (gastado + cotas en vuelo).
        const committed = committedUsd(cur.spent_usd, cur.calls);
        const d = decideRunSpend({ authorizedBudget: Number(cur.cap_usd), runSpent: Number(committed), nextCost: Number(spec.boundUsd), itemSpent: null, itemExpected: null, itemEstimatedMax: null, runExpected: null, progressExpected: null });
        if (!d.allow) {
          throw new RegenError('cap_reached', `Se alcanzó el tope aprobado (USD ${Number(cur.cap_usd).toFixed(2)}; comprometido USD ${Number(committed).toFixed(2)}): la siguiente llamada (${spec.provider}) podría costar hasta USD ${Number(spec.boundUsd).toFixed(2)}, así que NO se hizo. Aprueba un tope mayor para seguir.`, { capUsd: usd(cur.cap_usd), spentUsd: usd(cur.spent_usd) });
        }
        try { assertDirectCallAllowed(spec.provider); } catch {
          throw new RegenError('not_sent', `El proveedor «${spec.provider}» no está disponible en este momento: no se hizo la llamada (sin cobro).`);
        }
        const rec: ApprovalCall & { provider?: string } = { id: randomUUID(), kind: `${spec.provider}:${spec.kind}`, attempt: spec.attempt, boundUsd: spec.boundUsd, status: 'sent', at: new Date().toISOString(), provider: spec.provider };
        await this.setCall(approval.id, rec);
        this.providerCalls[spec.provider] = (this.providerCalls[spec.provider] ?? 0) + 1;
        return ticketFor(rec, spec);
      },
      /** P1-3: retoma la llamada YA enviada (y aceptada) de un proveedor asíncrono para liquidarla (sin reenviar). */
      resume: async (callId: string): Promise<PaidCallTicket> => {
        const cur = await this.approvalOf(approval.id);
        const rec = cur?.calls?.[callId] as (ApprovalCall & { provider?: string }) | undefined;
        if (!rec || (rec.status !== 'sent' && rec.status !== 'settling')) throw new RegenError('internal', `La llamada ${callId} no está esperando al proveedor.`);
        const [provider, kind] = String(rec.kind).split(':');
        return ticketFor(rec, { provider: rec.provider ?? provider, kind: kind ?? '', boundUsd: String(rec.boundUsd) });
      },
    };
  }

  /**
   * Una regeneración aprobada: producir → guardar el resultado (artifact) → ítem listo con su prueba en seco.
   * Fix round 1: lo pagado (id externo, video de YouTube) se guarda en el pedido apenas existe (P2-3); un proveedor
   * asíncrono que ACEPTÓ el pedido deja la espera como trabajo aparte y suelta el carril y la memoria (P1-3) → 'deferred'.
   */
  private async runRegenItem(s: WorkshopPlanSession, ctx: BuildCtx, approval: ApprovalRow, item: ItemRow, row: RequestRow, req: InterpretedRequest, fromFinding: boolean): Promise<AiUnavailableError | 'deferred' | null> {
    let providers: RegenProviders;
    try {
      providers = await this.regenProviders(s, approval.created_by);
    } catch (err) {
      const m = `Los proveedores no están disponibles: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}. No se llamó a nada.`;
      await this.setRequest(row.id, { status: 'awaiting_generation', reason: `No se generó: ${m}` });
      return new AiUnavailableError(PLAN_ERRORS.AI_UNAVAILABLE, m);
    }
    const gate = this.regenGateFor(s, approval, providers.simulated === true);
    const tag = { originalSha1: s.originalSha1, operation: req.operation, moduleId: regenTargetKey(req) };
    let prior: RegenPrior;
    try {
      prior = await this.priorOf(s, row, req);
    } catch (err) {
      if (!(err instanceof RegenError)) throw err;
      // Fail-closed visible (N3): el pedido queda esperando conciliación (bloquea re-aprobar hasta que el admin decida).
      await this.patchDetails(row.id, { regenAmbiguous: { approvalId: err.extra.approvalId ?? null, provider: err.extra.provider ?? null, externalId: err.extra.externalId ?? null, at: new Date().toISOString() } });
      await this.setRequest(row.id, { status: 'awaiting_generation', reason: `No se generó: ${err.message}` });
      return new AiUnavailableError(PLAN_ERRORS.CALL_AMBIGUOUS, err.message, err.extra);
    }
    const ext: RegenExternal = {
      mode: 'defer',
      prior,
      onPaid: async (p: RegenPrior) => {
        const waiting = p.videogen && !p.videogen.charged ? { provider: 'videogen' as const, externalId: p.videogen.jobId, callId: p.videogen.callId ?? '' }
          : p.gamma && !p.gamma.charged ? { provider: 'gamma' as const, externalId: p.gamma.generationId, callId: p.gamma.callId ?? '' } : null;
        const now = Date.now();
        const wait: RegenWait | null = waiting ? { approvalId: approval.id, reservationKey: approval.reservation_key ?? null, itemId: item.id, ...waiting, startedAt: new Date(now).toISOString(), deadlineAt: new Date(now + providers.poll.timeoutMs).toISOString() } : null;
        // El id externo queda en el pedido EN EL MISMO update que la espera: un proceso que muere después la retoma.
        await this.patchDetails(row.id, { regenPaid: { ...tag, ...p }, ...(wait ? { regenPending: wait } : {}) });
      },
    };
    let prep;
    try {
      prep = await prepareRegenItem(ctx, req, { providers, gate, spent: () => gate.spent(), ext }, { fromFinding });
    } catch (err) {
      if (err instanceof RegenDeferred) {
        const [cur] = await this.q<any[]>(this.dataSource, `select claim_id, details->'regenPending' as pending from public.workshop_requests where id = $1`, [row.id]);
        if (!cur?.pending || cur.pending.externalId !== err.wait.externalId) {
          // N3: nunca «esperando» sin la espera escrita: falla cerrado, visible y pendiente de conciliación.
          const m = `${err.wait.provider} (${err.wait.externalId}) no tiene una espera registrada: queda pendiente de conciliación (no se reenvía).`;
          await this.patchDetails(row.id, { regenAmbiguous: { approvalId: approval.id, provider: err.wait.provider, externalId: err.wait.externalId, at: new Date().toISOString() } });
          await this.setRequest(row.id, { status: 'awaiting_generation', reason: `No se generó: ${m}`, addSpent: gate.spent() });
          return new AiUnavailableError(PLAN_ERRORS.CALL_AMBIGUOUS, m);
        }
        // Espera aparte (reclamo + latido propios): este trabajo sigue con los demás ítems y suelta el carril al terminar.
        await this.setRequest(row.id, { status: 'preparing', reason: `Esperando a ${err.wait.provider} (${err.wait.externalId}).`, addSpent: gate.spent() });
        this.startRegenWait(s.id, row.id, cur.claim_id ?? null);
        return 'deferred';
      }
      if (!(err instanceof RegenError)) throw err;
      if (err.code === 'over_bound') {
        await this.setRequest(row.id, { status: 'failed', reason: err.message, addSpent: gate.spent(), details: { ...(await this.requestOf(s.id, row.id)).details, lastError: { code: PLAN_ERRORS.PROVIDER_OVER_BOUND, message: err.message, retryable: false } } });
        return new AiUnavailableError(PLAN_ERRORS.PROVIDER_OVER_BOUND, err.message, err.extra);
      }
      const code = err.code === 'cap_reached' ? PLAN_ERRORS.CAP_REACHED : err.code === 'call_ambiguous' ? PLAN_ERRORS.CALL_AMBIGUOUS : PLAN_ERRORS.AI_UNAVAILABLE;
      await this.setRequest(row.id, { status: 'awaiting_generation', reason: `No se generó: ${err.message}`, addSpent: gate.spent() });
      // P1-5 (regla de B8): una llamada ambigua sin conciliar bloquea re-aprobar este ítem.
      if (err.code === 'call_ambiguous') await this.patchDetails(row.id, { regenAmbiguous: { approvalId: approval.id, provider: err.extra.provider ?? null, externalId: err.extra.externalId ?? null, at: new Date().toISOString() } });
      return new AiUnavailableError(code, err.message, err.extra);
    }
    if (prep.status === 'resolved' && prep.produced && prep.view) {
      let ref: RegenResultRef;
      try {
        ref = await storeRegenResult(this.dataSource, this.artifacts, { ownerId: s.ownerId, sessionId: s.id, approvalId: approval.id, itemId: item.id, requestId: row.id, operation: String(req.operation), produced: prep.produced });
      } catch (err) {
        this.logger.error(`taller regen ${s.id}: no se pudo guardar el resultado de ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
        await this.setRequest(row.id, { status: 'awaiting_generation', reason: 'No se pudo guardar el resultado producido (lo gastado quedó registrado; lo ya pagado se reusa): vuelve a generarlo en unos minutos.', addSpent: gate.spent() });
        return null;
      }
      prep.view.params = { ...(prep.view.params as RegenerateOp), result: ref } as any;
      const fresh = await this.requestOf(s.id, row.id);
      await this.saveItem(s, row.id, { ...req, details: { ...(fresh.details ?? {}), regenResult: ref } }, { ...prep, produced: null } as PreparedItem);
      return null;
    }
    if (prep.failure?.retryable) {
      // P2-3: lo pagado (render, video publicado, PDF) quedó en `details.regenPaid`: el reintento solo paga lo que falló.
      await this.setRequest(row.id, { status: 'awaiting_generation', reason: prep.reason, addSpent: prep.spentUsd });
      return null;
    }
    await this.saveItem(s, row.id, req, prep);
    return null;
  }

  /** Arranca (o retoma) la ESPERA de un proveedor asíncrono fuera del carril: reclamo + latido propios, sin memoria. */
  private startRegenWait(sessionId: string, requestId: string, staleClaim: string | null): void {
    if (this.dead) return;
    const claim = `${this.workshop.bootId}.${randomUUID()}`;
    this.beat(claim, true);
    this.activeIds.add(requestId);
    const key = `wait:${requestId}:${randomUUID()}`;
    const p = this.runRegenWait(sessionId, requestId, claim, staleClaim)
      .catch((err) => this.logger.error(`taller regen: espera de ${requestId} falló: ${err instanceof Error ? err.stack ?? err.message : String(err)}`))
      .finally(() => { this.inFlight.delete(key); this.activeIds.delete(requestId); this.beat(claim, false); });
    this.inFlight.set(key, p);
  }

  private async runRegenWait(sessionId: string, requestId: string, claim: string, expectedClaim: string | null): Promise<void> {
    // Reclamo atómico (B6): la toma este proceso solo si sigue esperando y el reclamo es el que conoce (el del trabajo que la
    // difirió, o el viejo de un proceso muerto). Fix 2 (N2): sin excepción (antes, sin reclamo esperado la tomaba siempre).
    const [row] = returningRows(await this.q(this.dataSource, `update public.workshop_requests set claim_id = $2, updated_at = now()
        where id = $1 and status = 'preparing' and details ? 'regenPending' and claim_id is not distinct from $3::text returning *`, [requestId, claim, expectedClaim])) as RequestRow[];
    if (!row) return;
    const w = row.details.regenPending as RegenWait;
    await this.q(this.dataSource, `update public.workshop_ai_approvals set claim_id = $2, updated_at = now() where id = $1 and status in ('reserved', 'running')`, [w.approvalId, claim]);
    const s = await this.workshop.planSessionById(sessionId);
    const approval = await this.approvalOf(w.approvalId);
    const paid = (row.details.regenPaid ?? {}) as RegenPrior & Record<string, unknown>;
    const ambiguous = () => ({ regenAmbiguous: { approvalId: w.approvalId, provider: w.provider, externalId: w.externalId, at: new Date().toISOString() } });
    if (!s || !approval) {
      // Menor: sin sesión o sin aprobación no hay a quién retomar: la espera se cierra como interrumpida (no en cada barrido).
      await this.patchDetails(requestId, { ...(approval ? ambiguous() : {}), regenPaid: { ...paid, [w.provider]: null } }, ['regenPending']);
      await this.setRequest(requestId, { status: 'failed', reason: `La espera de ${w.provider} (${w.externalId}) se interrumpió: ${!s ? 'la sesión ya no está disponible' : 'la aprobación ya no existe'}.` });
      if (approval) await this.maybeCloseApproval(w.approvalId, 'failed', null);
      return;
    }
    const providers = await this.regenProviders(s, approval.created_by);
    const gate = this.regenGateFor(s, approval, providers.simulated === true);
    const own = async () => {
      if (this.dead) throw new WaitLost('proceso detenido');
      const [r] = await this.q<any[]>(this.dataSource, `select claim_id from public.workshop_requests where id = $1`, [requestId]);
      if (r?.claim_id !== claim) throw new WaitLost('otro proceso tomó la espera');
    };
    // N2: la espera termina pasando el pedido, EN UN SOLO update condicionado a este reclamo, a la reanudación (con su
    // propio reclamo): un solo `regen_resume` por llamada.
    const handOff = async (): Promise<void> => {
      const rc = `${this.workshop.bootId}.${randomUUID()}`;
      this.beat(rc, true);
      // B12 ronda 1: si el update falla, `rc` no queda latiendo para siempre (finally).
      try {
        const done = returningRows(await this.q(this.dataSource, `update public.workshop_requests set claim_id = $3, details = (coalesce(details, '{}'::jsonb) || $4::jsonb) - 'regenPending', updated_at = now()
            where id = $1 and claim_id = $2 and status = 'preparing' returning id`, [requestId, claim, rc, JSON.stringify({ regenPaid: { ...paid, [w.provider]: { ...(paid as any)[w.provider], charged: true } } })]));
        // B12 (G1): el latido de `rc` lo sostiene la reanudación encolada (enqueue lo toma y lo suelta al terminar); este
        // par solo cubre la ventana del update. Con el conteo de referencias, soltarlo acá ya no deja la reanudación sin latir.
        if (done.length) this.enqueue({ kind: 'regen_resume', sessionId, approvalId: w.approvalId, requestId }, rc);
      } finally {
        this.beat(rc, false);
      }
    };
    let ticket: PaidCallTicket;
    try {
      ticket = await gate.resume(w.callId);
    } catch {
      // La llamada ya no está en vuelo (p. ej. se liquidó y el proceso murió antes de soltar la espera): no se cobra de nuevo.
      const cur = (await this.approvalOf(w.approvalId))?.calls?.[w.callId];
      if (cur?.status === 'charged' || cur?.status === 'charge_unrecorded') { await handOff(); return; }
      // N3: sin cobro conocido → el pago intermedio se descarta (como en las demás ramas) y queda para conciliar.
      await this.patchDetails(requestId, { ...ambiguous(), regenPaid: { ...paid, [w.provider]: null } }, ['regenPending']);
      await this.setRequest(requestId, { status: 'awaiting_generation', reason: `No se pudo retomar la espera de ${w.provider} (${w.externalId}): queda pendiente de conciliación.` });
      await this.maybeCloseApproval(w.approvalId, 'failed', null);
      return;
    }
    const deadlineAt = Date.parse(w.deadlineAt);
    const boundUsd = String(approval.calls?.[w.callId]?.boundUsd ?? '0');
    let polled: { job?: any; st?: any; timeout?: WaitTimeout };
    try {
      if (w.provider === 'videogen') polled = { job: await pollUntilFinal({ fetch: () => providers.videogen.status(w.externalId), isFinal: videogenFinal, intervalMs: providers.poll.intervalMs, deadlineAt, what: `el render ${w.externalId}`, onTick: own }) };
      else polled = { st: await pollUntilFinal({ fetch: () => providers.gamma.getGeneration(w.externalId), isFinal: gammaFinal, intervalMs: providers.poll.intervalMs, deadlineAt, what: `la generación ${w.externalId} de Gamma`, onTick: own }) };
    } catch (err) {
      if (err instanceof WaitLost) return; // otro proceso la sigue (o este murió): nada que hacer acá
      if (!(err instanceof WaitTimeout)) throw err; // error propio (base): la espera sigue registrada y el barrido la retoma
      polled = { timeout: err };
    }
    // N2: transición condicional `sent → settling` ANTES de cobrar: solo quien la gana liquida; el otro sale sin efectos.
    if (!(await this.claimSettle(w.approvalId, w.callId, claim, expectedClaim))) return;
    try {
      if (polled.timeout) throw polled.timeout;
      if (w.provider === 'videogen') await settleVideogenJob({ ticket, job: polled.job, jobId: w.externalId, boundUsd, providers, charge: gate.charge });
      else await settleGammaGeneration({ ticket, st: polled.st, generationId: w.externalId, boundUsd, pricing: await this.pricing(), charge: gate.charge });
    } catch (err) {
      // Fix 3: perdió la liquidación (otro proceso ya la liquidó, p. ej. tomó la espera después de nuestro `settling`):
      // sale SIN ningún efecto — el ganador sigue con su handOff.
      if (err instanceof RegenError && err.extra?.alreadySettled) return;
      let reason: string;
      let failed = false;
      if (err instanceof WaitTimeout) {
        // Ambiguo SOLO al vencer el plazo total sin estado final: no se reenvía; queda para conciliar.
        const e = await ticket.failed(err, 'ambiguous');
        if (e.extra?.alreadySettled) return;
        reason = `No se generó: ${e.message}`;
        await this.patchDetails(requestId, { ...ambiguous(), regenPaid: { ...paid, [w.provider]: null } }, ['regenPending'], claim);
      } else if (err instanceof RegenError && err.code === 'over_bound') {
        reason = err.message;
        failed = true;
        await this.patchDetails(requestId, { regenPaid: { ...paid, [w.provider]: { ...(paid as any)[w.provider], charged: true } }, lastError: { code: PLAN_ERRORS.PROVIDER_OVER_BOUND, message: err.message, retryable: false } }, ['regenPending'], claim);
      } else if (err instanceof RegenError) {
        // Terminó mal (render fallido = ambiguo; Gamma fallida = cobrada y sin resultado): nunca se reenvía solo.
        reason = `No se generó: ${err.message}`;
        await this.patchDetails(requestId, { ...(err.code === 'call_ambiguous' ? ambiguous() : {}), regenPaid: { ...paid, [w.provider]: null } }, ['regenPending'], claim);
      } else {
        throw err;
      }
      // Defensa extra: solo con el reclamo propio (si otro proceso tomó la espera, esto no toca nada).
      const mine = await this.setRequest(requestId, { status: failed ? 'failed' : 'awaiting_generation', reason, claim });
      if (mine) await this.maybeCloseApproval(w.approvalId, 'failed', reason);
      return;
    }
    await handOff();
  }

  /** SOLO pruebas (N2): liquida la espera de este pedido con un estado final ya consultado, como lo haría la espera. */
  async settleWaitForTests(sessionId: string, requestId: string): Promise<void> {
    const [r] = await this.q<any[]>(this.dataSource, `select claim_id from public.workshop_requests where id = $1`, [requestId]);
    const claim = `${this.workshop.bootId}.${randomUUID()}`;
    this.beat(claim, true);
    try { await this.runRegenWait(sessionId, requestId, claim, r?.claim_id ?? null); } finally { this.beat(claim, false); }
  }

  /** Sigue la regeneración de UN pedido cuyo proveedor asíncrono ya terminó (reusa lo pagado; nunca reenvía). */
  private async runRegenResume(s: WorkshopPlanSession, ctx: BuildCtx, approvalId: string, requestId: string, claimId: string): Promise<void> {
    const approval = await this.approvalOf(approvalId);
    if (!approval) return;
    const row = await this.requestOf(s.id, requestId);
    // B12 (G1): lo pagado por la espera (render, PDF) quedó en `regenPaid`; si el pedido ya no está preparándose (otro
    // camino lo cerró: un barrido, un fallo), la reanudación NO sale callada: cierra la aprobación con el motivo visible y
    // deja lo pagado en el pedido para que el reintento lo reuse (nunca se repaga).
    const paidSome = Object.values((row.details?.regenPaid ?? {}) as Record<string, any>).some((v) => v && typeof v === 'object' && v.charged === true);
    const closeVisible = async () => {
      const reason = 'La regeneración terminó con el proveedor, pero el pedido ya no estaba preparándose: lo pagado quedó guardado y se reusa al volver a pedirlo.';
      this.logger.warn(`taller regen: reanudación de ${requestId} con el pedido en ${row.status}: ${reason}`);
      if (row.status === 'failed' || row.status === 'preparing') await this.setRequest(requestId, { status: 'awaiting_generation', reason });
      await this.maybeCloseApproval(approvalId, 'failed', reason);
    };
    // N2: solo la reanudación a la que la espera le pasó el reclamo sigue (una por llamada).
    if (row.claim_id !== claimId) {
      if (row.claim_id === null && row.status !== 'preparing' && row.status !== 'resolved' && paidSome) await closeVisible();
      return;
    }
    const [item] = await this.q<ItemRow[]>(this.dataSource, `select * from public.workshop_plan_items where request_id = $1 and id = any($2::uuid[])`, [requestId, approval.item_ids]);
    if (row.status !== 'preparing' && row.status !== 'resolved' && paidSome) { await closeVisible(); return; }
    if (row.status !== 'preparing' || !item || row.details?.regenPending) return;
    const [intake] = await this.q<IntakeRow[]>(this.dataSource, `select source from public.workshop_intakes where id = $1`, [row.intake_id]);
    const r = await this.runRegenItem(s, ctx, approval, item, row, { ...this.interpretedOf(row), status: 'resolved' }, intake?.source === 'finding');
    if (r === 'deferred') return;
    await this.maybeCloseApproval(approvalId, r ? (r.code === PLAN_ERRORS.CAP_REACHED ? 'stopped' : 'failed') : 'done', r ? r.message : null);
  }

  /** Parámetros del motor con el resultado de una regeneración cargado y verificado (los demás, tal cual). */
  async resolveRegenParams<T>(s: { id: string; ownerId: string }, params: T): Promise<T> {
    return resolveRegenParams(this.dataSource, this.artifacts, s, params);
  }

  private async failIntake(id: string, code: string, message: string, retryable: boolean, extra: Record<string, unknown> = {}): Promise<void> {
    await this.q(this.dataSource, `update public.workshop_intakes set status = 'failed', error = $2::jsonb, updated_at = now() where id = $1`, [id, JSON.stringify({ code, message, retryable, ...extra })]);
  }

  private async setRequest(id: string, v: { status: RequestStatus; operation?: string | null; target?: unknown; raw_target?: unknown; details?: unknown; questions?: unknown; reason?: string | null; instruction?: string; estimate?: unknown; addSpent?: string; addCalls?: number; claim?: string | null }): Promise<RequestRow> {
    const [r] = returningRows(await this.q(this.dataSource,
      `update public.workshop_requests set status = $2, operation = coalesce($3, operation), target = coalesce($4::jsonb, target), raw_target = coalesce($5::jsonb, raw_target),
              details = coalesce($6::jsonb, details), questions = coalesce($7::jsonb, questions), reason = $8, instruction = coalesce($9, instruction),
              estimate = coalesce($12::jsonb, estimate), spent_usd = spent_usd + $10, ai_calls = ai_calls + $11, updated_at = now()
        where id = $1 and ($13::text is null or claim_id = $13::text) returning *`,
      [id, v.status, v.operation ?? null, v.target === undefined || v.target === null ? null : JSON.stringify(v.target), v.raw_target === undefined || v.raw_target === null ? null : JSON.stringify(v.raw_target),
        v.details === undefined ? null : JSON.stringify(v.details), v.questions === undefined ? null : JSON.stringify(v.questions), v.reason ?? null, v.instruction ?? null, v.addSpent ?? '0', v.addCalls ?? 0,
        v.estimate === undefined ? null : JSON.stringify(v.estimate), v.claim ?? null]));
    return r as RequestRow;
  }

  private async planIdOf(s: WorkshopPlanSession): Promise<string> {
    const [p] = returningRows(await this.q(this.dataSource,
      `insert into public.workshop_plans (session_id, original_sha1) values ($1, $2) on conflict (session_id, original_sha1) do update set updated_at = now() returning id`, [s.id, s.originalSha1]));
    return p.id;
  }

  private async upsertItem(s: WorkshopPlanSession, requestId: string, view: PlanItemView, stage: 'estimate' | 'ready'): Promise<void> {
    // r107 B6: un plan que ya se está aplicando (o se aplicó) no cambia: lo que se aplica quedó congelado en la versión.
    if (!(await this.planEditableNow(s))) {
      await this.setRequest(requestId, { status: 'failed', reason: 'El plan ya se estaba aplicando (o ya se aplicó) cuando este pedido terminó de prepararse: no entra. Para seguir arreglando, abre una sesión desde la versión.' });
      return;
    }
    const planId = await this.planIdOf(s);
    // Un ítem que el docente QUITÓ sigue quitado cuando se genera su contenido.
    await this.q(this.dataSource,
      `insert into public.workshop_plan_items (plan_id, request_id, status, stage, operation, available, params, view, risk_level, spent_usd, apply_expected_usd, requires_item_confirm)
            values ($1, $2, 'proposed', $10, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $11)
       on conflict (request_id) do update set plan_id = excluded.plan_id, stage = excluded.stage, operation = excluded.operation, available = excluded.available, params = excluded.params,
            view = excluded.view, risk_level = excluded.risk_level, spent_usd = excluded.spent_usd, apply_expected_usd = excluded.apply_expected_usd,
            requires_item_confirm = excluded.requires_item_confirm, updated_at = now()`,
      [planId, requestId, view.operation, view.available, JSON.stringify(view.params), JSON.stringify(view), view.risk.level, view.cost.spentUsd, view.cost.apply.expected, stage, view.requiresItemConfirm === true]);
  }

  /** Prueba en seco del plan COMBINADO (ítems propuestos, generados y disponibles, en orden de creación). */
  private async refreshCombined(s: WorkshopPlanSession, ctx: BuildCtx): Promise<void> {
    if (!(await this.planEditableNow(s))) return; // r107 B6: la prueba en seco de un plan aplicado / aplicándose queda como estaba
    const planId = await this.planIdOf(s);
    const items = await this.q<ItemRow[]>(this.dataSource, `select i.* from public.workshop_plan_items i join public.workshop_requests r on r.id = i.request_id
        where i.plan_id = $1 and i.status = 'proposed' and i.stage = 'ready' and i.available and r.status = 'resolved' order by i.created_at, i.id`, [planId]).then((xs) => structuralLast(xs));
    let ops;
    try {
      ops = await Promise.all(items.map((i) => this.resolveRegenParams(s, i.params)));
    } catch (err) {
      // r107 B10: un resultado de regeneración que falta o no coincide → la prueba en seco combinada falla con motivo.
      await this.q(this.dataSource, `update public.workshop_plans set combined = $2::jsonb, updated_at = now() where id = $1`,
        [planId, JSON.stringify({ ok: false, failure: { opIndex: null, code: PLAN_ERRORS.REGEN_RESULT_MISSING, message: err instanceof Error ? err.message : String(err) }, resolved: 0, operations: items.length, itemIds: items.map((i) => i.id), itemHashes: items.map((i) => itemContentHash({ operation: i.operation, stage: i.stage, params: i.params ?? null, view: i.view ?? null })), failedItemId: null, at: new Date().toISOString() })]);
      return;
    }
    const c = await combinedDryRun(ctx, ops);
    await this.q(this.dataSource, `update public.workshop_plans set combined = $2::jsonb, updated_at = now() where id = $1`,
      [planId, JSON.stringify({ ...c, itemIds: items.map((i) => i.id),
        // r107 B6 fix round 2 (nota): huella del contenido de cada ítem probado (aplicar compara contra la del ítem actual).
        itemHashes: items.map((i) => itemContentHash({ operation: i.operation, stage: i.stage, params: i.params ?? null, view: i.view ?? null })), failedItemId: c.failure && c.failure.opIndex !== null ? items[c.failure.opIndex]?.id ?? null : null, at: new Date().toISOString() })]);
  }

  private async baselineOf(s: WorkshopPlanSession): Promise<{ originalSha1: string; report: DiagnosisReport } | null> {
    const [d] = await this.q<any[]>(this.dataSource, `select id, report from public.workshop_diagnoses where session_id = $1 and original_sha1 = $2 and code_version = $3 and status = 'ready'`, [s.id, s.originalSha1, DIAGNOSIS_CODE_VERSION]);
    if (!d?.report) return null;
    const fs = await this.q<any[]>(this.dataSource, `select finding from public.workshop_findings where diagnosis_id = $1 order by ordinal`, [d.id]);
    return { originalSha1: s.originalSha1 as string, report: { ...(d.report as DiagnosisReport), findings: fs.map((r) => r.finding as Finding) } };
  }

  private async findingOf(s: WorkshopPlanSession, findingId: string): Promise<Finding | null> {
    if (findingId.startsWith('Q')) {
      const [q] = await this.q<any[]>(this.dataSource, `select f.finding from public.workshop_quality_findings f join public.workshop_quality_runs r on r.id = f.run_id
          where r.session_id = $1 and r.original_sha1 = $2 and r.code_version = $3 and r.status = 'ready' and f.finding_id = $4`, [s.id, s.originalSha1, QUALITY_CODE_VERSION, findingId]);
      return q ? (q.finding as Finding) : null;
    }
    const [f] = await this.q<any[]>(this.dataSource, `select f.finding from public.workshop_findings f join public.workshop_diagnoses d on d.id = f.diagnosis_id
        where d.session_id = $1 and d.original_sha1 = $2 and d.code_version = $3 and d.status = 'ready' and f.finding_id = $4`, [s.id, s.originalSha1, DIAGNOSIS_CODE_VERSION, findingId]);
    return f ? (f.finding as Finding) : null;
  }

  private async insertSingleRequest(s: WorkshopPlanSession, actor: WorkshopActor, source: IntakeSource, text: string, raw: { quote: string; instruction: string; operation: string; target: Record<string, unknown>; details: Record<string, unknown> } | null, findingId: string | null): Promise<RequestRow> {
    return this.dataSource.transaction(async (m) => {
      const [intake] = await this.q<IntakeRow[]>(m, `insert into public.workshop_intakes (session_id, original_sha1, created_by, source, status, text, text_sha1) values ($1, $2, $3, $4, 'ready', $5, $6) returning id`,
        [s.id, s.originalSha1, actor.id, source, text.slice(0, PLAN_LIMITS.textMaxChars), sha1(text)]);
      const [r] = await this.q<RequestRow[]>(m, `insert into public.workshop_requests (session_id, intake_id, ordinal, finding_id, quote, instruction, operation, status, raw_target, details)
          values ($1, $2, 0, $3, $4, $5, $6, 'preparing', $7::jsonb, $8::jsonb) returning *`,
        [s.id, intake.id, findingId, raw?.quote ?? text, raw?.instruction ?? '', raw?.operation ?? null, raw ? JSON.stringify(raw.target) : null, JSON.stringify({ ...(raw?.details ?? {}), ...(findingId ? { findingId } : {}) })]);
      return r;
    });
  }

  /**
   * Trabajo colgado sin nada vivo (reinicio, OOM, otro proceso caído) → fallido reintentable, visible; la aprobación se
   * cierra y su reserva se libera SOLO si ninguna llamada pudo cobrarse (closeApproval). r107 B6: con reclamo + latido
   * entre procesos (ver PLAN_HEARTBEAT_STALE_MS); las filas sin reclamo (anteriores a B6) siguen el plazo de 15 min.
   */
  private async expireStale(sessionId: string | null): Promise<void> {
    const active = [...this.activeIds];
    const beating = [...this.beating];
    const ABANDONED = `not (id = any($4::uuid[])) and case
        when claim_id is null then updated_at < now() - ($3::int * interval '1 millisecond')
        when split_part(claim_id, '.', 1) = $5::text then not (claim_id = any($6::text[]))
        else updated_at < now() - ($7::int * interval '1 millisecond') end`;
    const P = (extra: unknown[]) => [...extra, PLAN_STALE_MS, active, this.workshop.bootId, beating, PLAN_HEARTBEAT_STALE_MS];
    await this.q(this.dataSource, `update public.workshop_intakes set status = 'failed', error = $2::jsonb, claim_id = null, updated_at = now()
        where ($1::uuid is null or session_id = $1::uuid) and status in ('queued', 'interpreting', 'extracting') and ${ABANDONED}`,
      P([sessionId, JSON.stringify({ code: PLAN_ERRORS.INTERRUPTED, message: 'La interpretación se interrumpió; vuelve a enviar el pedido.', retryable: true })]));
    // P1-3: una ESPERA de proveedor cuyo reclamo murió (p. ej. `pm2 reload`) se RETOMA con el mismo id externo (nunca un
    // segundo envío); no se da por interrumpida.
    const waits = await this.q<any[]>(this.dataSource, `select id, session_id::text as session_id, claim_id from public.workshop_requests
        where ($1::uuid is null or session_id = $1::uuid) and $2::text is null and status = 'preparing' and details ? 'regenPending' and ${ABANDONED}`,
      [sessionId, null, PLAN_STALE_MS, active, this.workshop.bootId, beating, PLAN_HEARTBEAT_STALE_MS]);
    for (const w of waits) this.startRegenWait(w.session_id, w.id, w.claim_id ?? null);
    await this.q(this.dataSource, `update public.workshop_requests set status = 'failed', reason = $2, claim_id = null, updated_at = now()
        where ($1::uuid is null or session_id = $1::uuid) and status = 'preparing' and not (coalesce(details, '{}'::jsonb) ? 'regenPending') and ${ABANDONED}`,
      P([sessionId, 'La preparación se interrumpió; vuelve a pedir el cambio.']));
    const stale = await this.q<ApprovalRow[]>(this.dataSource, `select id from public.workshop_ai_approvals where ($1::uuid is null or session_id = $1::uuid) and $2::text is null and status in ('reserved', 'running') and ${ABANDONED}
          and not exists (select 1 from public.workshop_requests r where r.status = 'preparing' and r.details ? 'regenPending' and r.details->'regenPending'->>'approvalId' = workshop_ai_approvals.id::text)`,
      [sessionId, null, PLAN_STALE_MS, active, this.workshop.bootId, beating, PLAN_HEARTBEAT_STALE_MS]);
    for (const a of stale) await this.closeApproval(a.id, 'failed', 'Se interrumpió (reinicio del servidor).');
  }

  /**
   * r107 B6 fix round 1 (P2-1): BARRIDO periódico (como el de las versiones): sin que nadie abra la sesión, lo que quedó
   * de un proceso muerto (reclamo sin latido) se cierra — una aprobación con una llamada en vuelo pasa a `ambiguous` (su
   * reserva sigue PENDIENTE) y aparece en el listado de conciliación del admin.
   */
  async sweep(): Promise<void> {
    if (this.dead) return;
    await this.expireStale(null);
  }

  onModuleInit(): void {
    let on = false;
    try { on = isCourseWorkshopEnabled(); } catch { on = false; }
    if (!on) return;
    this.sweepTimer = setInterval(() => { void this.sweep().catch((e) => this.logger.warn(`taller plan: barrido falló: ${e instanceof Error ? e.message : String(e)}`)); }, PLAN_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.sweepTimer = null;
    this.heartbeatTimer = null;
  }
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * r107 B6: el plan se edita solo mientras es borrador (o después de una aplicación fallida, que lo vuelve a borrador).
   * Aplicándose → 409; aplicado → 409 (para seguir arreglando se abre una sesión desde su versión).
   */
  private async assertPlanEditable(s: WorkshopPlanSession): Promise<void> {
    let st: string | null = null;
    try {
      const [p] = await this.dataSource.query(`select status from public.workshop_plans where session_id = $1 and original_sha1 = $2`, [s.id, s.originalSha1]);
      st = p?.status ?? null;
    } catch (err) {
      if ((err as { code?: string })?.code === '42P01') return; // sin la tabla: lo dirá la consulta siguiente (503)
      throw err;
    }
    if (st === 'applying') throw new ConflictException({ code: PLAN_ERRORS.PLAN_APPLYING, message: 'El plan se está aplicando: espera a que termine para cambiarlo.' });
    if (st === 'applied') throw new ConflictException({ code: PLAN_ERRORS.PLAN_APPLIED, message: 'Este plan ya se aplicó y su versión está guardada. Para seguir arreglando, abre una sesión desde esa versión.' });
    if (st === 'failed') await this.dataSource.query(`update public.workshop_plans set status = 'draft', updated_at = now() where session_id = $1 and original_sha1 = $2 and status = 'failed'`, [s.id, s.originalSha1]);
  }

  /** Para el trabajo en segundo plano: ¿todavía se le pueden agregar / cambiar ítems al plan? */
  private async planEditableNow(s: WorkshopPlanSession): Promise<boolean> {
    const [p] = await this.q<any[]>(this.dataSource, `select status from public.workshop_plans where session_id = $1 and original_sha1 = $2`, [s.id, s.originalSha1]);
    return !p || p.status === 'draft' || p.status === 'failed';
  }

  // ── lecturas ──

  private async intakeOf(sessionId: string, intakeId: string): Promise<IntakeRow> {
    if (!isUuid(intakeId)) throw new NotFoundException('Entrada no encontrada');
    const [row] = await this.q<IntakeRow[]>(this.dataSource, `select * from public.workshop_intakes where id = $1 and session_id = $2`, [intakeId.toLowerCase(), sessionId]);
    if (!row) throw new NotFoundException('Entrada no encontrada');
    return row;
  }
  private async requestOf(sessionId: string, requestId: string): Promise<RequestRow> {
    if (!isUuid(requestId)) throw new NotFoundException('Pedido no encontrado');
    const [row] = await this.q<RequestRow[]>(this.dataSource, `select * from public.workshop_requests where id = $1 and session_id = $2`, [requestId.toLowerCase(), sessionId]);
    if (!row) throw new NotFoundException('Pedido no encontrado');
    return row;
  }
  private async itemOf(s: WorkshopPlanSession, itemId: string): Promise<ItemRow> {
    if (!isUuid(itemId)) throw new NotFoundException('Ítem no encontrado');
    const [row] = await this.q<ItemRow[]>(this.dataSource, `select i.* from public.workshop_plan_items i join public.workshop_plans p on p.id = i.plan_id where i.id = $1 and p.session_id = $2 and p.original_sha1 = $3`, [itemId.toLowerCase(), s.id, s.originalSha1]);
    if (!row) throw new NotFoundException('Ítem no encontrado');
    return row;
  }

  intakeView(r: IntakeRow) {
    return {
      id: r.id, source: r.source, status: r.status, filename: r.filename, mediaType: r.media_type,
      textPreview: r.text ? (r.text.length > 500 ? `${r.text.slice(0, 499)}…` : r.text) : null, textLength: r.text ? r.text.length : null,
      notes: Array.isArray(r.notes) ? r.notes : [], estimate: r.estimate ?? null, approvalId: r.approval_id ?? null, spentUsd: usd(r.spent_usd), aiCalls: Number(r.ai_calls ?? 0),
      error: r.error && typeof r.error === 'object' ? { code: String(r.error.code), message: String(r.error.message), retryable: r.error.retryable === true } : null,
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    };
  }

  requestView(r: RequestRow) {
    return {
      id: r.id, intakeId: r.intake_id, ordinal: r.ordinal, findingId: r.finding_id, quote: r.quote, instruction: r.instruction, operation: r.operation, status: r.status,
      target: r.target ?? null, questions: Array.isArray(r.questions) ? r.questions : [], rounds: Number(r.rounds ?? 0), reason: r.reason,
      estimate: r.estimate ?? null, spentUsd: usd(r.spent_usd), aiCalls: Number(r.ai_calls ?? 0), lastError: r.details?.lastError ?? null,
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    };
  }

  approvalView(a: ApprovalRow) {
    return {
      id: a.id, kind: a.kind, intakeId: a.intake_id, requestId: a.request_id, itemIds: a.item_ids ?? [], estimate: a.estimate, capUsd: usd(a.cap_usd), spentUsd: usd(a.spent_usd),
      aiCalls: Number(a.ai_calls ?? 0), status: a.status, stopReason: a.stop_reason, reserved: !!a.reservation_key,
      calls: Object.values(a.calls ?? {}).map((c) => ({ id: c.id, kind: c.kind, status: c.status, boundUsd: c.boundUsd, costUsd: c.costUsd ?? null, providerStatus: c.providerStatus ?? null })), createdAt: iso(a.created_at), updatedAt: iso(a.updated_at),
    };
  }

  private async planView(s: WorkshopPlanSession) {
    const [plan] = await this.q<any[]>(this.dataSource, `select * from public.workshop_plans where session_id = $1 and original_sha1 = $2`, [s.id, s.originalSha1]);
    const intakes = await this.q<IntakeRow[]>(this.dataSource, `select id, spent_usd from public.workshop_intakes where session_id = $1 and original_sha1 = $2`, [s.id, s.originalSha1]);
    const requests = await this.q<RequestRow[]>(this.dataSource, `select * from public.workshop_requests where session_id = $1 and intake_id = any($2::uuid[]) order by created_at, ordinal`, [s.id, intakes.map((i) => i.id)]);
    const items = plan ? await this.q<ItemRow[]>(this.dataSource, `select * from public.workshop_plan_items where plan_id = $1 order by created_at, id`, [plan.id]) : [];
    const byReq = new Map(requests.map((r) => [r.id, r]));
    const live = (i: ItemRow) => i.status === 'proposed' && byReq.get(i.request_id)?.status !== 'withdrawn';
    // P1-5: el plan dice cuándo un ítem espera al proveedor o tiene una llamada pendiente de conciliación.
    const ambIds = [...new Set(requests.map((r) => r.details?.regenAmbiguous?.approvalId).filter((x): x is string => typeof x === 'string' && isUuid(x)))];
    const ambStatus = new Map<string, string>(ambIds.length ? (await this.q<any[]>(this.dataSource, `select id::text as id, status from public.workshop_ai_approvals where id = any($1::uuid[])`, [ambIds])).map((a) => [a.id, a.status]) : []);
    const providerWaitOf = (r: RequestRow) => {
      const w = r.details?.regenPending;
      if (r.status === 'preparing' && w) return { state: 'waiting_provider', label: 'esperando al proveedor', provider: w.provider, externalId: w.externalId, since: w.startedAt, deadlineAt: w.deadlineAt };
      const amb = r.details?.regenAmbiguous;
      if (amb && ambStatus.get(String(amb.approvalId)) !== 'reconciled') return { state: 'pending_reconciliation', label: 'pendiente de conciliación', provider: amb.provider ?? null, externalId: amb.externalId ?? null, since: amb.at ?? null };
      return null;
    };
    const itemViews = items.filter((i) => byReq.has(i.request_id)).map((i) => {
      const r = byReq.get(i.request_id)!;
      return { id: i.id, requestId: i.request_id, findingId: r.finding_id, quote: r.quote, instruction: r.instruction, status: live(i) ? 'proposed' : 'removed', stage: i.stage, requiresItemConfirm: (i as any).requires_item_confirm === true, requestStatus: r.status, reason: r.reason, ...i.view,
        // r107 B6 fix round 1 (P2-2): huella del contenido que el docente revisa (aplicar la exige).
        contentHash: itemContentHash({ operation: i.operation, stage: i.stage, params: i.params ?? null, view: i.view ?? null }),
        providerWait: providerWaitOf(r) };
    });
    // Lo que el docente aprueba al aplicar (B6): los ítems que entran con su huella, la huella del plan y los que piden
    // confirmación uno por uno. El POST …/apply manda exactamente esto de vuelta.
    const sel = selectApplyItems(items.filter((i) => byReq.has(i.request_id)).map((i) => {
      const r = byReq.get(i.request_id)!;
      return { id: i.id, requestId: i.request_id, operation: i.operation, status: live(i) ? 'proposed' as const : 'removed' as const, requestStatus: r.status, stage: i.stage, available: i.available, params: i.params ?? null,
        requiresItemConfirm: (i as any).requires_item_confirm === true, summary: i.view?.summary ?? i.operation, quote: r.quote, riskLevel: i.risk_level,
        contentHash: itemContentHash({ operation: i.operation, stage: i.stage, params: i.params ?? null, view: i.view ?? null }) };
    }));
    const applyItems = sel.apply.map((i) => ({ id: i.id, contentHash: i.contentHash as string }));
    const applyBlock = {
      planHash: applyItems.length ? planContentHash(applyItems) : null,
      items: applyItems,
      confirmRequired: sel.apply.filter((i) => i.requiresItemConfirm).map((i) => ({ id: i.id, contentHash: i.contentHash as string, summary: i.summary })),
      blocking: sel.blocking,
      later: sel.later.map((i) => i.id),
    };
    const ready = items.filter((i) => live(i) && i.stage === 'ready');
    const totals = planTotals({
      spent: [...intakes.map((x) => usd(x.spent_usd)), ...requests.map((x) => usd(x.spent_usd))],
      available: ready.filter((i) => i.available).map((i) => i.view.cost.apply),
      later: ready.filter((i) => !i.available).map((i) => i.view.cost.apply),
    });
    const toGenerate = items.filter((i) => live(i) && i.stage === 'estimate' && byReq.get(i.request_id)?.status === 'awaiting_generation');
    const generation = toGenerate.length ? { itemIds: toGenerate.map((i) => i.id), ...this.estimateOf(toGenerate.map((i) => i.view.plannedCall as PlannedCall), `Generar el contenido (antes/después) de ${toGenerate.length} ítem(s): la IA corre solo cuando apruebes el tope.`) } : null;
    const withItem = new Set(items.map((i) => i.request_id));
    const warnings = planWarnings(items.filter((i) => byReq.has(i.request_id)).map((i) => ({ id: i.id, operation: i.operation, risk: i.view.risk, intakeId: byReq.get(i.request_id)!.intake_id, live: live(i) })));
    return {
      sessionId: s.id, planId: plan?.id ?? null, status: (plan?.status ?? 'draft') as 'draft' | 'applying' | 'applied' | 'failed', appliedVersionId: plan?.applied_version_id ?? null,
      originalSha1: s.originalSha1, planCodeVersion: PLAN_CODE_VERSION,
      items: itemViews,
      /** r107 B6 (fix round 1, P2-2): lo que se envía a POST …/plans/:planId/apply (huellas del contenido revisado). */
      apply: applyBlock,
      /** Fix round 1 (P2-4): avisos del plan (quitar actividades, cambios masivos, muchos de riesgo alto). */
      warnings,
      /** Lo que falta aprobar para generar el contenido de los ítems en etapa de estimado (estimado + tope propuesto). */
      generation,
      pending: requests.filter((r) => ['needs_answer', 'awaiting_confirmation', 'preparing'].includes(r.status)).map((r) => this.requestView(r)),
      excluded: requests.filter((r) => !withItem.has(r.id) && ['out_of_scope', 'unavailable', 'failed'].includes(r.status)).map((r) => ({ requestId: r.id, quote: r.quote, status: r.status, operation: r.operation, reason: r.reason })),
      totals,
      combined: plan?.combined ?? null,
      updatedAt: plan ? iso(plan.updated_at) : null,
    };
  }
}
