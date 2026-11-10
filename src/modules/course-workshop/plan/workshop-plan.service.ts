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
import { ApprovalCall, callErrorOutcome, closeReservation } from './approval-ledger';
import { requestFromFinding } from './from-finding';
import { AnswerError, checkAnswers, resolveRequest } from './interpret';
import { planWarnings } from './risk';
import { itemContentHash, planContentHash, selectApplyItems } from '../apply/apply-core';
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

/** Estimado de una aprobación (lo que el docente ve y confirma). */
export interface ApprovalEstimate { calls: PlannedCall[]; expectedUsd: string; boundUsd: string; proposedCapUsd: string; note: string }

type Job =
  | { kind: 'extract'; sessionId: string; intakeId: string }
  | { kind: 'interpret'; sessionId: string; intakeId: string; approvalId: string }
  | { kind: 'reinterpret'; sessionId: string; requestId: string; approvalId: string }
  | { kind: 'stage'; sessionId: string; requestId: string }
  | { kind: 'generate'; sessionId: string; approvalId: string }
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
  /** Entradas / pedidos / aprobaciones con trabajo en cola o corriendo en ESTE proceso. */
  private readonly activeIds = new Set<string>();
  /** r107 B6: reclamos de este proceso que se laten (trabajos en cola o corriendo). */
  private readonly beating = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly artifacts: ArtifactsService,
    private readonly workshop: CourseWorkshopService,
    @Optional() private readonly ledger?: FinopsLedgerService,
    @Optional() private readonly finopsBudget?: FinopsBudgetService,
    @Optional() @Inject(WORKSHOP_AI_CLIENT) client?: WorkshopAiClient,
  ) {
    this.client = client || new AnthropicWorkshopAiClient();
  }

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

  private enqueue(job: Job): void {
    const id = 'intakeId' in job ? job.intakeId : 'requestId' in job ? job.requestId : 'approvalId' in job ? job.approvalId : null;
    const key = `${job.kind}:${id ?? job.sessionId}:${randomUUID()}`;
    if (id) this.activeIds.add(id);
    if ('approvalId' in job) this.activeIds.add(job.approvalId);
    // r107 B6: reclamo entre procesos (como el diagnóstico de B3): las filas del trabajo llevan `<arranque>.<uuid>` y este
    // proceso las late mientras el trabajo está en cola o corriendo.
    const claimId = `${this.workshop.bootId}.${randomUUID()}`;
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
    if ('requestId' in job) await this.q(this.dataSource, `update public.workshop_requests set claim_id = $2, updated_at = now() where id = $1 and status = 'preparing'`, [job.requestId, claimId]);
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
    const confirmed = Number(input.confirmEstimateUsd);
    if (!Number.isFinite(confirmed) || Math.abs(confirmed - Number(estimate.expectedUsd)) > 1e-6) {
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
      const d = capDecision(usd(cur.spent_usd), call, usd(cur.cap_usd), pricing);
      if (!d.allow) {
        throw new AiUnavailableError(PLAN_ERRORS.CAP_REACHED, `Se alcanzó el tope aprobado (USD ${Number(cur.cap_usd).toFixed(2)}; gastado USD ${Number(cur.spent_usd).toFixed(2)}): la siguiente llamada podría costar hasta USD ${Number(callBoundUsd(call.size.promptChars, call.maxTokens, pricing)).toFixed(2)}, así que NO se hizo. Aprueba un tope mayor para seguir.`, { capUsd: usd(cur.cap_usd), spentUsd: usd(cur.spent_usd) });
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
    const deterministic = row.operation !== null && qa.every((x) => x.q.origin === 'server' && ((x.q.purpose === 'target' && x.option?.resolves && !x.text) || (x.q.purpose === 'instruction' && x.text)));
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
    const items = await this.q<ItemRow[]>(this.dataSource, `select i.* from public.workshop_plan_items i join public.workshop_requests r on r.id = i.request_id
        where i.plan_id = $1 and i.id = any($2::uuid[]) and i.stage = 'estimate' and i.status = 'proposed' and r.status = 'awaiting_generation' order by i.created_at, i.id`, [plan.id, ids]);
    if (items.length !== ids.length) throw new ConflictException({ code: PLAN_ERRORS.ITEMS_INVALID, message: 'Algún ítem elegido no está esperando generación (ya se generó, se quitó o es de otro plan).' });
    const estimate = this.estimateOf(items.map((i) => i.view.plannedCall as PlannedCall), `Generar el contenido de ${items.length} ítem(s) (1 llamada cada uno; un reintento por validación entra en el margen). La IA no corre hasta que lo apruebes.`);
    const cap = this.validateConfirmation(estimate, input);
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
    const bytes = Number(s.originalSize ?? 0) * diagnosisMemoryFactor(s.container);
    try {
      await this.workshop.withMemory(`plan:${job.sessionId}`, bytes, async () => {
        let ctx: BuildCtx;
        try {
          const original = await this.workshop.loadVerifiedOriginal(s.id);
          ctx = await openBuildCtx(original.buffer, { filename: s.filename, originalSha1: s.originalSha1 as string, pricing: await this.pricing(), baseline: await this.baselineOf(s) });
        } catch (err) {
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
      if (a) await this.q(this.dataSource, `update public.workshop_requests r set status = 'awaiting_generation', reason = $2, updated_at = now() from public.workshop_plan_items i where i.request_id = r.id and i.id = any($1::uuid[]) and r.status = 'preparing'`, [a.item_ids, `No se generó: ${message}`]);
    }
    if ('approvalId' in job) await this.closeApproval(job.approvalId, code === PLAN_ERRORS.CAP_REACHED ? 'stopped' : 'failed', message);
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
      let prep: PreparedItem;
      try {
        prep = await prepareItem(ctx, req, ai, { fromFinding: intake?.source === 'finding' });
      } catch (err) {
        if (!(err instanceof AiUnavailableError)) throw err;
        stop = err;
        await this.setRequest(row.id, { status: 'awaiting_generation', reason: `No se generó: ${err.message}` });
        continue;
      }
      await this.saveItem(s, row.id, req, prep);
    }
    await this.closeApproval(approvalId, stop ? (stop.code === PLAN_ERRORS.CAP_REACHED ? 'stopped' : 'failed') : 'done', stop ? stop.message : null);
  }

  private async failIntake(id: string, code: string, message: string, retryable: boolean, extra: Record<string, unknown> = {}): Promise<void> {
    await this.q(this.dataSource, `update public.workshop_intakes set status = 'failed', error = $2::jsonb, updated_at = now() where id = $1`, [id, JSON.stringify({ code, message, retryable, ...extra })]);
  }

  private async setRequest(id: string, v: { status: RequestStatus; operation?: string | null; target?: unknown; raw_target?: unknown; details?: unknown; questions?: unknown; reason?: string | null; instruction?: string; estimate?: unknown; addSpent?: string; addCalls?: number }): Promise<RequestRow> {
    const [r] = returningRows(await this.q(this.dataSource,
      `update public.workshop_requests set status = $2, operation = coalesce($3, operation), target = coalesce($4::jsonb, target), raw_target = coalesce($5::jsonb, raw_target),
              details = coalesce($6::jsonb, details), questions = coalesce($7::jsonb, questions), reason = $8, instruction = coalesce($9, instruction),
              estimate = coalesce($12::jsonb, estimate), spent_usd = spent_usd + $10, ai_calls = ai_calls + $11, updated_at = now()
        where id = $1 returning *`,
      [id, v.status, v.operation ?? null, v.target === undefined || v.target === null ? null : JSON.stringify(v.target), v.raw_target === undefined || v.raw_target === null ? null : JSON.stringify(v.raw_target),
        v.details === undefined ? null : JSON.stringify(v.details), v.questions === undefined ? null : JSON.stringify(v.questions), v.reason ?? null, v.instruction ?? null, v.addSpent ?? '0', v.addCalls ?? 0,
        v.estimate === undefined ? null : JSON.stringify(v.estimate)]));
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
        where i.plan_id = $1 and i.status = 'proposed' and i.stage = 'ready' and i.available and r.status = 'resolved' order by i.created_at, i.id`, [planId]);
    const c = await combinedDryRun(ctx, items.map((i) => i.params));
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
    await this.q(this.dataSource, `update public.workshop_requests set status = 'failed', reason = $2, claim_id = null, updated_at = now()
        where ($1::uuid is null or session_id = $1::uuid) and status = 'preparing' and ${ABANDONED}`,
      P([sessionId, 'La preparación se interrumpió; vuelve a pedir el cambio.']));
    const stale = await this.q<ApprovalRow[]>(this.dataSource, `select id from public.workshop_ai_approvals where ($1::uuid is null or session_id = $1::uuid) and $2::text is null and status in ('reserved', 'running') and ${ABANDONED}`,
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
    const itemViews = items.filter((i) => byReq.has(i.request_id)).map((i) => {
      const r = byReq.get(i.request_id)!;
      return { id: i.id, requestId: i.request_id, findingId: r.finding_id, quote: r.quote, instruction: r.instruction, status: live(i) ? 'proposed' : 'removed', stage: i.stage, requiresItemConfirm: (i as any).requires_item_confirm === true, requestStatus: r.status, reason: r.reason, ...i.view,
        // r107 B6 fix round 1 (P2-2): huella del contenido que el docente revisa (aplicar la exige).
        contentHash: itemContentHash({ operation: i.operation, stage: i.stage, params: i.params ?? null, view: i.view ?? null }) };
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
